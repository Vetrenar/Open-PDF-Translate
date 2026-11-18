import { resolvePageLayout } from './region-layout';
import { fallbackIndices, withFallbacks } from './translation-result';
// processing.ts — CACHE-FIRST + PIPELINE-ONLY VERSION
//
// Layout detection strategy:
//   1. CACHE-FIRST: check .translations.md for cached paragraph layout
//      (produced by background pdf-layout-worker via watcher/commands).
//      If cached → use cached rects (no DOM detection needed).
//   2. DOM FALLBACK: if no cache, run contour pipeline on PDF.js textLayer
//      spans (layout-detector.ts → OccupancyMap → IslandBuilder).
//   3. BACKGROUND ENRICHMENT: on cache miss, enqueue the page for background
//      processing so next time it's cached.
//
// No post-processing: no semantic merging, no sentence re-flow.
// One paragraph = one TranslationUnit; request splitting is reassembled before rendering.

// P0-2: removed `@ts-nocheck`. It previously masked real type errors
// including the missing `externalLayoutService` / `ocrLayoutService`
// declarations (P0-1) and the dead `_fromCache` field on TranslationUnit.
// All `_externalRect` / `_externalFont` accesses are now type-safe because
// those fields are declared optional on `TranslationUnit` in types.ts.

import { Notice, TFile } from 'obsidian';
import { assessNativeText } from './native-text-quality';
import OpenRouterTranslatorPlugin from './main';
import { TranslationUnit, OverlayPositionData } from './types';
import { LayoutDetector, LayoutSettings } from './layout-detector';
// LAYOUT-FIX-13 (A2-fallback, DOM path): open/close the cross-page column
// memory around the synchronous detectLayout call (see the call site).
import { setColumnMemoryFile } from './column-memory';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Used at
// the cache→OverlayPositionData construction site below so the merged
// result has the same id as the on-disk version (which the DOM-extraction
// and queue paths also produce for the same source paragraph).
import { generateOverlayId, getCurrentEngine } from './overlay-id';
import type { VerticalStrip } from './layout-detector';
// Phase 5.1 (W-2b): owner-scoped abort plumbing. The queue passes its
// task's job signal down here; interactive paths pass nothing and are
// never aborted. Replaces every read of the queue's global cancel flag.
import { makeAbortError, isAbortError, raceSignal, abortableDelay } from './job-token';
// Phase 13.3: import the provider registry so we can read `contextWindow`
// for the auto-chunk check. (We do NOT call buildRequest from here —
// TranslationEngine owns that.)
// FIX: getProvider import removed — token estimation was inaccurate and
// caused problems with reasoning models. Chunking is now purely
// character-based via maxBatchChars.
// P0-1: instantiate both layout services so the Python (PyMuPDF) pipeline
// (headless-translate.ts) and the OCR pipelines (ocr-text.ts / ocr-layout.ts)
// can be reached from the TextProcessor without throwing at runtime.
import { ExternalLayoutService } from './external-layout';
import { OcrLayoutService } from './ocr-layout';
// P0-1 (Phase 1): static import replaces runtime `require('./paragraph-filter')`,
// which throws `ReferenceError: require is not defined` on mobile (Obsidian's
// mobile runtime has no CommonJS shim). Mobile crashes occurred in
// executeTranslation whenever paragraphFilterRules were enabled (the defaults).
import { compileRules, filterParagraphs } from './paragraph-filter';
// TABLE-KEEP (2026-09-15): общие правила «подозрения таблицы» — построчное
// сохранение <br> для коротких item-строк и контекстный спан-фильтр.
import {
    TABLE_KEEP_MAX_WORDS_PER_ROW,
    isTableLikeRowTexts,
    hasBrTag,
    rowsToUnitText,
    cleanTextKeepingBr,
    buildSpanFilterCtx,
    shouldDropNumericSpan,
    isDetectionPollutingRect,
    fuseSpanTexts,
    isIntraWordHyphen,
    HyphenNeighbors,
} from './table-keep';

// ── LAYOUT-FIX-22 (2026-09-25): DOM-зеркало продюсерских сплитов ────────
// См. table-keep.ts (F26-a/b) и pdf-text-extractor.ts (queue-путь). DOM-
// спаны — те же pdf.js-итемы, отрендеренные textLayer-ом: суб-словесные
// сплиты и приклеенные дефисы воспроизводятся один в один. Геометрия
// спанов — CSS-px ТЕКУЩЕГО зума, поэтому пороги (pt) применяются к
// зазорам, делённым на --scale-factor (та же проба, что
// LayoutDetector.resolveViewerScale).

/** Прочитать зум вьювера из --scale-factor первых спанов (1 при отсутствии). */
function domScaleFactor(spans: HTMLSpanElement[]): number {
    try {
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 1;
        for (let i = 0; i < Math.min(3, spans.length); i++) {
            const v = window.getComputedStyle(spans[i]).getPropertyValue('--scale-factor');
            const s = parseFloat(v);
            if (Number.isFinite(s) && s > 0.05) return s;
        }
    } catch { /* fall through */ }
    return 1;
}

/** Дефисно-соседский контекст юнита DOM-спанов (зазоры в pt, реплика
 * buildHyphenNeighborCtx очереди: строки по Math.round(bottom),
 * соседи по left внутри строки). */
function buildDomHyphenNeighbors(
    unit: HTMLSpanElement[],
    self: { getBoundingClientRectCached(el: HTMLElement): DOMRect },
    scale: number,
): Map<HTMLSpanElement, HyphenNeighbors> {
    const out = new Map<HTMLSpanElement, HyphenNeighbors>();
    let hasHyphen = false;
    for (const s of unit) {
        if ((s.textContent || '').trim() === '-') { hasHyphen = true; break; }
    }
    if (!hasHyphen) return out;
    const rows = new Map<number, Array<{ el: HTMLSpanElement; r: DOMRect }>>();
    for (const el of unit) {
        const r = self.getBoundingClientRectCached(el);
        const b = Math.round(r.bottom);
        let g = rows.get(b);
        if (!g) { g = []; rows.set(b, g); }
        g.push({ el, r });
    }
    for (const g of rows.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => a.r.left - b.r.left);
        for (let i = 0; i < g.length; i++) {
            if ((g[i].el.textContent || '').trim() !== '-') continue;
            const L = i > 0 ? (g[i].r.left - g[i - 1].r.right) / scale : null;
            const R = i + 1 < g.length ? (g[i + 1].r.left - g[i].r.right) / scale : null;
            out.set(g[i].el, { leftGap: L, rightGap: R });
        }
    }
    return out;
}

export class TextProcessor {
  private plugin: OpenRouterTranslatorPlugin;
  public layoutDetector: LayoutDetector;
  // P0-1: public so externalLayoutService / ocrLayoutService are reachable
  // from headless-translate.ts:91 and ocr-text.ts:74. Both were previously
  // accessed but never declared or instantiated — every Python-layout watcher
  // run and every OCR command crashed with `TypeError: Cannot read properties
  // of undefined (reading 'clearCache' | 'ocrPageText')`.
  public externalLayoutService: ExternalLayoutService;
  public ocrLayoutService: OcrLayoutService;

  // Caches
  private measurementCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();
  private styleCache = new Map<HTMLElement, CSSStyleDeclaration>();

  // FIX D4 (REMOVED): `lastPreparedUnits` was global mutable state shared between
  // `translatePageContent()` and `createOverlayWithText()`. If the user switched
  // pages between the two calls (or if a third party called
  // createOverlayWithText), the overlay would be created on the wrong page with
  // the wrong units. Now createOverlayWithText accepts TranslationUnit[] +
  // translatedLines directly as parameters, eliminating the implicit coupling.

  private overlayContainers: HTMLElement[] = [];
  private translationFailures: { segmentIndex: number; error: string }[] = [];

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
    this.layoutDetector = new LayoutDetector(this.plugin.layoutSettings);
    // P0-1: instantiate both services now. They hold a back-reference to the
    // plugin for settings/storage access; no I/O is performed at construction.
    this.externalLayoutService = new ExternalLayoutService(this.plugin);
    this.ocrLayoutService = new OcrLayoutService(this.plugin);
  }

  // ==================== PUBLIC API ====================

  public updateLayoutDetectorSettings(newSettings: LayoutSettings, silent = false): void {
    this.layoutDetector = new LayoutDetector(newSettings);
    if (!silent) {
      new Notice('Layout detection settings have been updated.');
    }
  }

  public async addTextOverlay() {
    const currentPage = this.plugin.overlay.getCurrentPageElement();
    if (currentPage) {
      await this.addOverlayToPage(currentPage);
    } else {
      new Notice('No active PDF page found.');
    }
  }

  public async addOverlayToPage(pageElement: HTMLElement) {
    try {
      // FIX D4: combine translate + render into a single atomic call so that
      // TranslationUnit[] + translatedLines flow directly between the two
      // steps without going through mutable global state.
      const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
      if (!textLayer) {
        new Notice('Text layer not found. Wait for PDF to fully render.');
        return;
      }

      const translationUnits = await this.prepareTranslationUnits(textLayer, pageElement, /* forceFresh */ true);
      if (!translationUnits || translationUnits.length === 0) {
        new Notice('No valid text to translate (or layout analysis failed).', 2000);
        return;
      }

      const translatedLines = await this.executeTranslation(translationUnits);
      const successfulTranslations = translatedLines.filter(line => line !== 'Translation missing').length;

      await this.createOverlayWithText(pageElement, translationUnits, translatedLines);
      const fallbackCount = fallbackIndices(translatedLines).size;
      new Notice(fallbackCount ? `Rendered ${successfulTranslations} segments; ${fallbackCount} kept as original text. Retry available.` : `✓ Translation complete. Rendered ${successfulTranslations} segment(s).`, 3000);
    } catch (error: any) {
      console.error("addOverlayToPage process failed:", error);
      new Notice(`⚠ Translation failed: ${error.message}`, 4000);
    }
  }

  // ==================== TRANSLATION PIPELINE ====================

  /**
   * Translate the current page and return the joined translated text.
   *
   * FIX D4: previously this method stashed the TranslationUnit[] + translatedLines
   * into a `lastPreparedUnits` field so that `createOverlayWithText()` could
   * read them back. That implicit coupling was fragile (page switches,
   * re-entrancy, third-party callers). Callers who need both the units and
   * the translation should call `prepareTranslationUnits` + `executeTranslation`
   * + `createOverlayWithText` directly (see `addOverlayToPage`).
   *
   * This method is kept for backward compatibility with modal.ts callers,
   * but it NO LONGER stashes state — it's a pure translate-and-return.
   */
  public async translatePageContent(pageElement: HTMLElement): Promise<string | null> {
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    if (!textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      return null;
    }

    const translationUnits = await this.prepareTranslationUnits(textLayer, pageElement, /* forceFresh */ true);
    if (!translationUnits || translationUnits.length === 0) {
      new Notice('No valid text to translate (or layout analysis failed).', 2000);
      return null;
    }

    const translatedLines = await this.executeTranslation(translationUnits);
    return translatedLines.join('\n');
  }

  /**
   * FIX D4: createOverlayWithText now accepts TranslationUnit[] + translatedLines
   * as explicit parameters. The old signature `(pageElement, translatedText)`
   * relied on `lastPreparedUnits` global state, which was unreliable when the
   * user switched pages between translate and render.
   *
   * The old single-string signature is kept as an overload for backward
   * compatibility — but it now does a fresh layout detection instead of
   * reading stale state. Callers should migrate to the new signature.
   */
  public async createOverlayWithText(
    pageElement: HTMLElement,
    unitsOrText: TranslationUnit[] | string,
    translatedLines?: string[],
  ): Promise<void> {
    const prepResult = this.validateAndPreparePrerequisites(pageElement, true);
    if (!prepResult) throw new Error('PDF page is no longer available for rendering');
    const { overlayContainer } = prepResult;
    this.overlayContainers.push(overlayContainer);

    let translationUnits: TranslationUnit[];
    let lines: string[];

    if (Array.isArray(unitsOrText)) {
      // New signature: caller passes units + lines directly (preferred).
      translationUnits = unitsOrText;
      lines = translatedLines ?? [];
    } else {
      // Legacy signature: caller passes a joined string. We have to re-detect
      // layout because we no longer have `lastPreparedUnits` to recover the
      // original spans. This is slower but keeps backward compat.
      const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
      if (!textLayer) {
        new Notice('Text layer not found for legacy createOverlayWithText.', 3000);
        overlayContainer.remove();
        return;
      }
      const units = await this.prepareTranslationUnits(textLayer, pageElement, /* forceFresh */ true);
      if (!units || units.length === 0) {
        overlayContainer.remove();
        return;
      }
      translationUnits = units;
      lines = (unitsOrText as string).split('\n');
    }

    if (!translationUnits || translationUnits.length === 0) {
      overlayContainer.remove();
      return;
    }

    // === Safety net: enforce equal length ===
    let finalTranslatedLines = lines;
    if (finalTranslatedLines.length !== translationUnits.length) {
      console.error(`CRITICAL: Units (${translationUnits.length}) vs TranslatedLines (${finalTranslatedLines.length}) mismatch. Fixing.`);
      if (finalTranslatedLines.length < translationUnits.length) {
        finalTranslatedLines = [
          ...finalTranslatedLines,
          ...translationUnits.slice(finalTranslatedLines.length).map(u => u.text)
        ];
      } else {
        finalTranslatedLines = finalTranslatedLines.slice(0, translationUnits.length);
      }
    }

    translationUnits = translationUnits.map((unit, i) => ({...unit,
      translationStatus: fallbackIndices(lines).has(i) ? 'fallback' as const : undefined}));
    this.renderOverlay(translationUnits, finalTranslatedLines, overlayContainer, pageElement);

    // Phase 1 (F1.2): notify the overlay renderer that this page now has
    // overlays, so it can subscribe the page to the IntersectionObserver
    // and apply the current visibility state. Without this, freshly
    // translated overlays would not be tracked for scroll/zoom refresh
    // and could appear visible even when the user had toggled overlays off.
    const pageNumberForRefresh = parseInt(pageElement.getAttribute('data-page-number') || '0', 10);
    if (pageNumberForRefresh > 0) {
      this.plugin.overlay.markPageAsHavingOverlays(pageNumberForRefresh, pageElement);
    }

    if (this.plugin.settings.autoSaveOverlay) {
      const saved = await this.plugin.overlay.saveCurrentPageOverlayForPage(pageElement);
      if (!saved) throw new Error('Translation rendered, but overlay could not be saved');
    }
  }

  // ==================== LAYOUT PREPARATION ====================

  private validateAndPreparePrerequisites(
    pageElement: HTMLElement,
    requireTextLayer: boolean
  ): { textLayer: HTMLElement | null; overlayContainer: HTMLElement } | null {
    if (!this.validatePageElement(pageElement)) {
      new Notice('Invalid page element');
      return null;
    }
    const overlayContainer = this.plugin.overlay.preparePageForOverlay(pageElement);
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    if (requireTextLayer && !textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      overlayContainer.remove();
      return null;
    }
    return { textLayer, overlayContainer };
  }

  /**
   * Prepare TranslationUnits from PDF textLayer.
   *
   * Phase 12 (P2-17): the cache-first branch + `tryGetCachedUnits` were
   * removed. All five callers pass `forceFresh: true` — the cache-first
   * branch was unreachable dead code. The background `pdf-layout-queue`
   * owns the on-disk cache; interactive translation paths always extract
   * fresh from the DOM so the overlay renderer has real span references
   * for positioning. The `forceFresh` parameter is kept (optional,
   * defaulted to true) to preserve the public signature — callers that
   * still pass it explicitly are not broken.
   *
   * One pipeline paragraph = one translation unit.
   * Request chunking happens later and never changes overlay boundaries.
   */
  public async prepareTranslationUnits(
    textLayerOrSpans: HTMLElement | HTMLSpanElement[],
    pageElement: HTMLElement,
    forceFresh: boolean = true,
    // P1-9 (Phase 13): per-call layout settings, no global mutation.
    // When `layoutSettings` is passed, `prepareTranslationUnits` builds a
    // throwaway `LayoutDetector` instance for this call only — the caller
    // (e.g. `retranslateSelectionWithLayoutMode` in overlay-ui.ts) no
    // longer has to mutate `this.layoutDetector` via
    // `updateLayoutDetectorSettings(tuned, true)` and restore it in a
    // `finally` block. Eliminates the rapid-double-click race where two
    // concurrent retranslates would each `try`/`finally` the global
    // detector and one could end up restoring the other's tuned settings.
    layoutSettings?: LayoutSettings
  ): Promise<TranslationUnit[] | null> {
    // `forceFresh` is kept for API stability; the cache-first branch is
    // gone, so the parameter has no effect. Callers should still pass
    // `true` (the default) for clarity.
    void forceFresh;

    // ── DOM extraction: run pipeline on textLayer spans ───────────
    const rawSpans = Array.isArray(textLayerOrSpans)
      ? textLayerOrSpans
      : Array.from(textLayerOrSpans.querySelectorAll<HTMLSpanElement>('span'));

    // TABLE-KEEP: контекст спан-фильтра (медианный кегль + рамка страницы) —
    // числовые ячейки таблиц выживают, номера страниц/суперскрипты гибнут.
    const spanFilterCtx = buildSpanFilterCtx(rawSpans, pageElement);

    // LAYOUT-FIX-9 (P2, 2026-09-17): унификация входа DOM/queue. Контентные
    // правила (числа+ctx, одиночные маркеры, http) ПЕРЕНЕСЕНЫ из пре-детекции
    // фида в ПОСТ-детекцию юнитов — тот же проход, что очередь делает в
    // pdf-text-extractor.ts после buildParagraphs. Детектор видит все
    // материальные спаны, КРОМЕ числовых суперскриптов
    // (isDetectionPollutingRect — калибровка try:p1: 6 суперскриптов
    // авторской строки рвут записи TOC на фрагменты, F1=4, если оставить
    // их в фиде; очередь эту болезнь несла всегда — теперь симметрично
    // чиста). На фиде остаётся вырожденный фильтр (нулевые/подпиксельные
    // боксы marked-content) — мусор, который никогда не был контентом и
    // портит occupancy-карту. Текстовый итог тот же: снятые с юнитов спаны
    // — ровно те, что прежде не попадали в фид; числовые ячейки таблиц
    // выживают (контракт TABLE-KEEP). Kill-switch
    // disableSpanFilterUnification возвращает пре-детекционный фильтр (v22).
    const unifyFilter = (layoutSettings
      ? layoutSettings.disableSpanFilterUnification
      : this.plugin.layoutSettings?.disableSpanFilterUnification) !== true;

    const textSpans = this.validateSpans(rawSpans).filter(span =>
      unifyFilter
        ? this.hasMaterialBox(span) && !this.isDetectionPolluting(span, spanFilterCtx)
        : this.isValidSpan(span, spanFilterCtx));

    if (textSpans.length === 0) {
      return null;
    }

    // P1-9 (Phase 13): use a per-call detector when the caller supplied
    // tuned settings; otherwise fall back to the shared instance that
    // `updateLayoutDetectorSettings` keeps in sync with the plugin's
    // global layout settings.
    const owner = (this.plugin as any).pdfDom?.getFileFromPageElement?.(pageElement);
    const pageNum = Number(pageElement.getAttribute('data-page-number'));
    const effective = resolvePageLayout(layoutSettings ?? this.plugin.layoutSettings, owner?.path || '', pageNum);
    const rotationAttr=pageElement.querySelector?.('.textLayer')?.getAttribute('data-main-rotation');
    if(rotationAttr!=null && effective.activeRegions?.some(r=>r.rotation!==undefined && ((Number(rotationAttr)-r.rotation)%360+360)%360!==0))
      throw new Error('Reset the additional viewer rotation before applying saved regional layout.');
    const detector = layoutSettings || effective.activeRegions?.length ? new LayoutDetector(effective) : this.layoutDetector;
    // LAYOUT-FIX-13 (A2-fallback, DOM path): open the cross-page column
    // memory for the OWNING document — detectLayout is synchronous, so the
    // set/reset pair around it is race-free. Pages viewed/translated in
    // document order accumulate the boundary consensus exactly like the
    // queue path does; a page whose own validation fails (book p61: the
    // furniture class) then borrows the remembered boundary through the
    // slicer's memory fallback instead of fusing its columns. Detached /
    // foreign pageElements resolve no owner (getFileFromPageElement returns
    // null — the O-1 rule) and simply keep the memory closed: the DOM path
    // degrades to today's behavior.
    const memOwner = (this.plugin as any).pdfDom?.getFileFromPageElement?.(pageElement) ?? null;
    setColumnMemoryFile(memOwner ? (memOwner as any).path ?? null : null);
    let result: any;
    try {
      result = detector.detectLayout(textSpans, pageElement);
    } finally {
      setColumnMemoryFile(null);
    }

    // LAYOUT-FIX-9 (P2): пост-детекционный контентный фильтр юнитов.
    // LAYOUT-FIX-22 (F26-a): одиночные дефисы получают контекст соседей
    // по базовой линии внутри юнита (зазоры пересчитываются из CSS-px в
    // pt через --scale-factor — как resolveViewerScale детектора), чтобы
    // приклеенные дефисы («cyclo-»+«oxygenase») не гибли как маркеры.
    if (unifyFilter) {
      const flatUnits: HTMLSpanElement[] = [];
      for (const unit of result.paragraphs as HTMLSpanElement[][]) for (const sp of unit) flatUnits.push(sp);
      const domScale = domScaleFactor(flatUnits.length > 0 ? flatUnits : rawSpans);
      result.paragraphs = result.paragraphs
        .map((unit: HTMLSpanElement[]) => {
          const nb = buildDomHyphenNeighbors(unit, this, domScale);
          return unit.filter(sp => this.isValidSpan(sp, spanFilterCtx, nb));
        })
        .filter((unit: HTMLSpanElement[]) => unit.length > 0);
    }

    // Bug 1 fix: visual rendering gated on layoutDebugMode (matches its description),
    // console logging gated on debugMode (matches its description).
    if (this.plugin.settings.layoutDebugMode) {
      this.renderLayoutDebugOverlay(
        pageElement,
        result.columnAnalysis,
        result.debugStrips || [],
        result.layoutRegions || []
      );
    } else {
      this.clearLayoutDebugOverlay(pageElement);
    }
    if (this.plugin.settings.debugMode) {
      console.debug(`PDF Translator: DOM pipeline → ${result.paragraphs.length} paragraph(s).`);
    }
    this.clearCaches();

    // Request-size splitting belongs to translation, not layout. Preserve
    // one overlay per paragraph, including short table cells and headings.
    return result.paragraphs.flatMap((spans, index) => {
      if (!spans?.length) return [];
      const {html: text, ordered} = this.spansToHtml(spans);
      if (!text.trim()) return [];
      return [{originalSpans:ordered, text, id:`para-${index}`, paragraphId:`para-${index}`}];
    });
  }

  // ==================== TRANSLATION EXECUTION ====================

  /**
   * Phase 5.1: `opts.signal` is the OWNING job's AbortSignal (queue path).
   * Between chunks / segments, `signal.aborted` stops further requests;
   * the queue additionally wraps the call in raceSignal() so the conveyor
   * detaches immediately. Interactive paths pass nothing and are never
   * aborted — the old global-flag reads (and the stale-cancel pre-flight
   * that fought them) are gone together with the flag.
   */
  public async executeTranslation(
    units: TranslationUnit[],
    opts?: { signal?: AbortSignal },
  ): Promise<string[]> {
    if (opts?.signal?.aborted) throw makeAbortError();
    this.translationFailures = [];

    if (units.length === 0) return [];
    const quality = assessNativeText(units.map(u => ({str:u.text})));
    if (!quality.usable) console.warn("Suspect PDF Unicode: attempting model recovery.", quality);

    // Stage 2.4 (NEW): Apply paragraph filter rules. Paragraphs matching
    // enabled filter rules (page numbers, single letters, etc.) are NOT
    // sent to the LLM — their original text is used as the "translation".
    // This saves API costs on non-translatable content and prevents
    // garbage translations of numeric/short patterns.
    //
    // Per Q-F1: filter is applied here (at executeTranslation), NOT at
    // extraction. Overlays are still created for filtered paragraphs —
    // they just show the original text instead of a translation.
    let translatableUnits = units;
    let skippedIndices = new Set<number>();
    const rules = this.plugin.settings.paragraphFilterRules;
    if (rules && rules.length > 0) {
      const compiled = compileRules(rules);
      if (compiled.length > 0) {
        const texts = units.map(u => u.text);
        const { translatable, skipped } = filterParagraphs(texts, compiled);
        if (skipped.size > 0) {
          skippedIndices = new Set(skipped.keys());
          translatableUnits = translatable.map(i => units[i]);
          if (this.plugin.settings.debugMode) {
            console.debug(`[ParagraphFilter] ${skipped.size}/${units.length} paragraphs filtered (not sent to LLM):`,
              [...skipped.entries()].map(([i, name]) => `#${i + 1} (${name}): "${units[i].text.substring(0, 30)}"`));
          }
        }
      }
    }

    // If all paragraphs were filtered, return originals immediately.
    if (translatableUnits.length === 0) {
      return units.map(u => u.text);
    }

    try {
      let translatedLines = await this.translateTextsWithChunking(
        translatableUnits.map(u => u.text), opts,
      );

      const failed = fallbackIndices(translatedLines);
      translatedLines = this.restoreStructure(translatableUnits, translatedLines);

      // Final cleanup: TABLE-KEEP — strip <br> only for PROSE units.
      // Table-like originals (short item rows) keep their <br> structure —
      // restoreStructure already normalized per-row whitespace; this pass
      // previously re-stripped what survived (the second kill-point found
      // by emul3: brKilledByPipeline = ALL).
      translatedLines = translatedLines.map((line, i) => {
        const origIsTable = hasBrTag(translatableUnits[i]?.text || '');
        if (origIsTable) return line.trim();
        return line.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
      });

      translatedLines = translatedLines.map((line, i) => {
        if (line === 'Translation missing' || !line.trim()) {
            console.warn(`Segment ${i + 1} missing. Reverting to original.`);
            return translatableUnits[i].text;
        }
        return line;
      });

      // Stage 2.4: merge translated lines back with skipped paragraphs.
      // Skipped paragraphs use their original text (not translated).
      if (skippedIndices.size > 0) {
        const result: string[] = new Array(units.length);
        let transIdx = 0;
        for (let i = 0; i < units.length; i++) {
          if (skippedIndices.has(i)) {
            // Filtered paragraph — use original text
            result[i] = units[i].text;
          } else {
            // Translated paragraph
            result[i] = translatedLines[transIdx] || units[i].text;
            transIdx++;
          }
        }
        const mapped: number[] = [];
        let ti = 0;
        for (let i = 0; i < units.length; i++) if (!skippedIndices.has(i)) {
          if (failed.has(ti)) mapped.push(i);
          ti++;
        }
        return withFallbacks(result, mapped);
      }

      return withFallbacks(translatedLines, failed);

    } catch (err: any) {
      // 5.1: an abort is not a failure — no fallback-to-originals (an
      // aborted page must never be written with originals-as-translations),
      // no Notice spam; rethrow so the owner (queue worker / headless)
      // returns the task to 'pending'.
      if (isAbortError(err)) throw err;
      // FIX H14: was logDebug (silent, debugMode-gated). Fatal translation errors
      // must be surfaced to the user — otherwise they see false "✓ Translation complete"
      // while all segments silently fell back to originals.
      console.error('[PDF Translator] Translation failed:', err);
      new Notice(`Translation failed: ${err?.message || err}`, 8000);
      return withFallbacks(units.map(u => u.text), units.map((_, i) => i).filter(i => !skippedIndices.has(i)));
    }
  }

  /** Shared request pipeline, aligned 1:1 with input texts.
   * Failed/incomplete segments retain source text and explicit fallback metadata.
   * Filtering is performed by the owning page pipeline before this method.
   */
  public async translateTextsWithChunking(
    texts: string[], opts?: { signal?: AbortSignal },
  ): Promise<string[]> {
    const signal = opts?.signal;
    const check = () => { if (signal?.aborted) throw makeAbortError(); };
    check();
    if (!texts.length) return [];
    const configured = Number(this.plugin.settings.maxBatchChars);
    const maxChars = Number.isFinite(configured) && configured > 20
      ? Math.floor(configured) : 4000;
    const batch = this.plugin.settings.useBatchTranslation && texts.length > 1;
    const delay = Math.max(0, Number(this.plugin.settings.sequentialDelayMs) || 0);
    const pieces: Array<{ index: number; text: string }> = [];
    texts.forEach((text, index) => {
      for (const part of this.splitLongTextBySentences(text, maxChars - 20)) {
        pieces.push({ index, text: part });
      }
    });
    const chunks: typeof pieces[] = [];
    let current: typeof pieces = [], size = 0;
    for (const piece of pieces) {
      if (current.length && (!batch || size + piece.text.length + 20 > maxChars)) {
        chunks.push(current); current = []; size = 0;
      }
      current.push(piece); size += piece.text.length + 20;
    }
    if (current.length) chunks.push(current);
    const translated = texts.map(() => [] as string[]);
    const failed = new Set<number>();
    for (let i = 0; i < chunks.length; i++) {
      check();
      const chunk = chunks[i];
      let lines: string[];
      try {
      if (batch) {
        const input = chunk.map((p, j) => `[#${j + 1}] ${p.text}`).join('\n');
        const raw = await raceSignal(this.plugin.translation.translateBatch(input, chunk.length, { signal }), signal);
        check();
        lines = await this.extractNumberedLinesRobust(raw, chunk.length, chunk.map(p => p.text));
      } else {
        const raw = await raceSignal(this.plugin.translation.translateWithOpenRouter(chunk[0].text, { signal }), signal);
        check();
        if (typeof raw !== 'string' || !raw.trim() || raw.trim() === 'Translation missing') {
          throw new Error('Empty translation response');
        }
        lines = [raw.trim()];
      }
      for (const j of fallbackIndices(lines)) failed.add(chunk[j].index);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw makeAbortError();
        console.warn('Translation failed; keeping source text and bbox.', error);
        chunk.forEach(p => failed.add(p.index));
        lines = chunk.map(p => p.text);
      }
      chunk.forEach((p, j) => translated[p.index].push(lines[j]));
      if (i + 1 < chunks.length && delay > 0) await abortableDelay(delay, signal);
    }
    check();
    return withFallbacks(translated.map((parts, i) => failed.has(i) ? texts[i] : parts.join(' ').trim()), failed);
  }

  /** Bounded pieces without discarding punctuation or a final unfinished sentence. */
  private splitLongTextBySentences(text: string, maxLen: number): string[] {
    const parts: string[] = [];
    let rest = text;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      const boundaries = [...window.matchAll(/[.!?。！？]\s+|\s+/g)];
      const last = boundaries[boundaries.length - 1];
      const cut = last && last.index! > maxLen / 2
        ? last.index! + last[0].length : maxLen;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest || !parts.length) parts.push(rest);
    return parts;
  }

  /** Parse [#N] markers without interpreting ordinary numbered lists.
   * Missing slots retain their originals and are marked for retry; successful
   * siblings are preserved. Ordinary numbered lists are not treated as markers.
   */
  public async extractNumberedLines(raw: string, expectedCount: number, originals: string[]): Promise<string[]> {
    return this.extractNumberedLinesRobust(raw, expectedCount, originals);
  }

  private async extractNumberedLinesRobust(raw: string, expectedCount: number, originals: string[]): Promise<string[]> {
    // ── FIX #1: Strip markdown code block wrapper ──────────────────────
    // LLMs often wrap responses in ``` or ```json blocks. Without stripping,
    // the last segment captures trailing ``` as part of its content.
    let cleanedRaw = raw.replace(/\r\n/g, '\n').trim();
    if (cleanedRaw.startsWith('```')) {
      // Remove opening ``` (optionally followed by language tag like "json")
      cleanedRaw = cleanedRaw.replace(/^```[a-zA-Z]*\n?/, '');
      // Remove closing ```
      cleanedRaw = cleanedRaw.replace(/\n?```$/, '');
      cleanedRaw = cleanedRaw.trim();
    }

    // ── FIX #2: Line-by-line parsing instead of one big regex ──────────
    // The previous single-regex approach had a bug: when [#1] had empty content
    // immediately followed by [#2], the regex's lazy [\s\S]*? with lookahead
    // could swallow [#2] as content of #1. Line-by-line is more predictable.
    //
    // FIX C3: Only match [#N] format (our preferred, unambiguous).
    // Previous regex also matched [N], N., N), N: — but these are common in
    // numbered lists INSIDE translations (e.g., "Steps: 1. Open 2. Edit 3. Save").
    // When a translation contains a numbered list, each list item was parsed as
    // a new marker, truncating the translation and mixing content with subsequent segments.
    // [#N] is unambiguous because it's never used in natural text.
    const markerLineRegex = /^\s*\[#(\d+)\]\s*(.*)$/;

    const found: Map<number, string> = new Map();
    let currentIdx = -1;
    let currentText = '';

    const flushCurrent = () => {
      if (currentIdx >= 0 && currentIdx < expectedCount) {
        // TABLE-KEEP: сегменты с табличным ОРИГИНАЛом (короткие item-строки,
        // <br> в originals[currentIdx]) сохраняют <br> — эхо-LLM, уважающий
        // инструкцию «Preserve the original formatting», больше не обрезается
        // конвейером. Проза — прежнее поведение (сплошной текст).
        const origIsTable = hasBrTag(originals[currentIdx] || '');
        const trimmed = origIsTable
          ? cleanTextKeepingBr(currentText)
          : currentText
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (trimmed.length > 0 && !found.has(currentIdx)) {
          found.set(currentIdx, trimmed);
        }
      }
      currentIdx = -1;
      currentText = '';
    };

    const lines = cleanedRaw.split('\n');
    for (const line of lines) {
      const m = line.match(markerLineRegex);
      if (m) {
        // New marker — flush previous segment
        flushCurrent();
        // FIX C3: strict regex only has one capture group (the number)
        const numStr = m[1];
        currentIdx = parseInt(numStr, 10) - 1;  // 0-based
        currentText = m[2] || '';
      } else {
        // Continuation line — append to current segment.
        // TABLE-KEEP: для табличного сегмента LLM может вернуть перевод
        // МНОГОСТРОЧНО (реальные переводы строк вместо <br>) — склеиваем
        // строки через <br>, сохраняя построчную структуру таблицы
        // (прежде — намертво сплющивалось в одну строку пробелом).
        if (currentIdx >= 0) {
          const origIsTable = hasBrTag(originals[currentIdx] || '');
          currentText += (origIsTable ? '<br>' : ' ') + line.trim();
        }
        // If currentIdx < 0, this is preamble before any marker — ignore.
      }
    }
    // Flush last segment
    flushCurrent();

    const missing = Array.from({ length: expectedCount }, (_, i) => i)
      .filter(i => !found.get(i) || found.get(i) === 'Translation missing');
    const result = Array.from({ length: expectedCount }, (_, i) => missing.includes(i) ? originals[i] : found.get(i)!);
    return withFallbacks(result, missing);
  }

  private restoreStructure(units: TranslationUnit[], lines: string[]): string[] {
    return lines.map((line, i) => {
      const orig = units[i]?.text || '';
      // TABLE-KEEP: табличный оригинал (короткие item-строки через <br>) —
      // переводу РАЗРЕШАЕТСЯ держать построчную структуру: чистим пробелы
      // внутри строк, но <br> сохраняем. Проза — прежнее поведение
      // (сплошной текст).
      if (hasBrTag(orig)) {
        return cleanTextKeepingBr(line);
      }
      // Strip <br> tags — prose translation should be continuous text
      const cleaned = line
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Preserve leading numbering/bullets that may have been stripped
      const origLead = orig.match(/^\s*(\d+[.)]\s*|[-•*]\s*|#\s*)/);
      if (origLead && !cleaned.match(/^\s*(\d+[.)]\s*|[-•*]\s*|#\s*)/)) {
        return origLead[1] + cleaned;
      }
      return cleaned;
    });
  }

  // ==================== OVERLAY RENDERING ====================

  // FIX H10: derive the PDF file from a page element instead of calling
  // getActiveFile(). This prevents stale-file bugs when the user switches
  // tabs during an async translation operation.
  //
  // O-1 fix (2026-09-12): the implementation moved to
  // pdfDom.getFileFromPageElement (canonical DOM access point) so the
  // overlay SAVE path can use the same owner resolution. This private
  // delegate keeps the call sites unchanged. NOTE the semantic change that
  // comes with the move: an unresolvable leaf now returns null instead of
  // falling back to the ACTIVE file — the fallback was silently writing
  // data into whatever PDF happened to be focused. Render-path callers
  // already null-check the result.
  private getFileFromPageElement(pageElement: HTMLElement): TFile | null {
    return this.plugin.pdfDom.getFileFromPageElement(pageElement);
  }

  private renderOverlay(
    units: TranslationUnit[],
    translatedLines: string[],
    overlayContainer: HTMLElement,
    pageElement: HTMLElement
  ) {
    // ── CACHED LAYOUT PATH ──────────────────────────────────────────
    // If units came from cache (have _externalRect), use renderSavedOverlay
    // which positions overlays by relativeRect (no DOM spans needed).
    // P0-2: removed `(u: any)` cast — `_externalRect` is now declared on
    // TranslationUnit in types.ts so TypeScript narrows correctly.
    const hasCachedUnits = units.some(u => !!u._externalRect);
    if (hasCachedUnits) {
      const pageNumber = parseInt(pageElement.getAttribute('data-page-number') || '0', 10);
      // FIX H10: don't use getActiveFile() — if user switched tabs between
      // createOverlayWithText() start and this point, wrong file would be saved.
      // Instead, derive the file from the page element's closest PDF viewer leaf.
      const activeFile = this.getFileFromPageElement(pageElement);

      const overlayData: OverlayPositionData[] = units
        .map((unit, index) => {
          const extRect = unit._externalRect;
          const extFont = unit._externalFont;
          if (!extRect) return null;

          return {
            selector: '',
            textContent: unit.text,
            translationStatus: unit.translationStatus,
            page: pageNumber,
            translatedText: translatedLines[index] || unit.text,
            relativeRect: {
              left: extRect.l,
              top: extRect.t,
              width: extRect.w,
              height: extRect.h,
            },
            fontSize: extFont?.size,
            fontFamily: extFont?.family,
            originalFontSizes: extFont?.sizes || [],
            // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
            // Replaces the unstable `cached-${pageNum}-${index}` that was on
            // the TranslationUnit (regenerated each load → couldn't be used
            // for disk lookup or merge-by-id). This id matches what
            // overlay.ts extractPositionDataFrom and pdf-layout-queue.ts
            // buildOverlayData produce for the same source paragraph, so
            // merge-by-id-first in updatePageOverlaysAndWrite can supersede
            // the existing entry instead of leaving an orphan that
            // rect-overlap-merge would resurrect.
            id: generateOverlayId(pageNumber, {
              left: extRect.l, top: extRect.t, width: extRect.w, height: extRect.h,
            }, unit.text || ''),
            // Phase 8 (V4 Schema): engine stamp from current provider/model.
            // This path runs after an interactive translation via the
            // TranslationEngine (translation.ts makeApiCall uses the same
            // apiProvider + providerSettings[apiProvider].model), so the
            // current settings ARE the engine that produced this overlay.
            engine: getCurrentEngine(this.plugin),
          } as OverlayPositionData;
        })
        .filter((x): x is OverlayPositionData => x !== null);

      this.plugin.overlay.renderSavedOverlay(overlayData, pageNumber);

      if (this.plugin.settings.autoSaveOverlay && activeFile) {
        this.plugin.storage
          .updatePageOverlaysAndWrite(activeFile, { [pageNumber]: overlayData })
          // Phase 2 (P1-19): the manual `cachedOverlayData.pageOverlays[pageNumber]
          // = overlayData` patch that lived in this `.then()` was redundant —
          // `updatePageOverlaysAndWrite` already calls `updateCacheFromWrite`
          // after the write resolves, which is the single source of truth for
          // the renderer's in-memory cache. The manual patch was a double-write
          // that could diverge from disk on overlap-merge with stale items.
          .catch((err: any) => console.error('Failed to auto-save translation:', err));
      }
      return;
    }

    // ── DOM LAYOUT PATH ─────────────────────────────────────────────
    // Reassemble sentence-split units by paragraphId, then render via
    // renderOverlays (which needs originalSpans for positioning).
    const reassembledParagraphs = new Map<string, { originalSpans: HTMLSpanElement[]; translatedText: string; originalText: string; translationStatus?: 'fallback'; }>();
    units.forEach((unit, index) => {
      const { paragraphId, originalSpans } = unit;
      const translatedLine = translatedLines[index];
      if (!reassembledParagraphs.has(paragraphId)) {
        reassembledParagraphs.set(paragraphId, { originalSpans: [], translatedText: '', originalText: '' });
      }
      const group = reassembledParagraphs.get(paragraphId)!;
      if (unit.translationStatus === 'fallback') group.translationStatus = 'fallback';
      group.originalSpans.push(...originalSpans);
      group.translatedText += (group.translatedText ? ' ' : '') + translatedLine;
      group.originalText += (group.originalText ? ' ' : '') + (unit.text || '');
    });

    const mergedUnits: TranslationUnit[] = [];
    const mergedTranslatedLines: string[] = [];
    reassembledParagraphs.forEach((group, paragraphId) => {
      mergedUnits.push({
        id: paragraphId,
        paragraphId: paragraphId,
        originalSpans: group.originalSpans,
        text: group.originalText,
        translationStatus: group.translationStatus
      });
      mergedTranslatedLines.push(group.translatedText);
    });

    this.plugin.overlay.renderOverlays(mergedUnits, mergedTranslatedLines, overlayContainer, pageElement);
  }

  // ==================== HELPERS ====================

  /** LAYOUT-FIX-13: returns { html, ordered } — `ordered` is the spans array
   * in the exact VISUAL order the html was built from (rows by top, spans by
   * left). Callers pass it on as the unit's originalSpans so that
   * getSpansBbox(fontSizes → ofs) and the text (ot) describe the same spans
   * in the same order. */
  private spansToHtml(spans: HTMLSpanElement[]): { html: string; ordered: HTMLSpanElement[] } {
    if (!spans?.length) return { html: '', ordered: [] };
    // TABLE-KEEP: строки — кластеры по y-ПЕРЕКРЫТИЮ (>= 35% меньшей высоты),
    // не по точному Math.round(top). Ячейки одной строки таблицы с разными
    // метриками шрифта (bold-заголовок vs обычный) имеют разные top → точный
    // ключ ДРОБИЛ строку на две «линии» и ставил <br> ПОСЕРЕДИНЫ строки
    // (или ломал подсчёт слов). Эмуляция emul3: keys=32 при rows=31.
    const withRects = spans.map(span => ({ span, rect: this.getBoundingClientRectCached(span) }))
      .filter(it => it.rect.width > 0 || it.rect.height > 0);
    withRects.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const rowGroups: { spans: { span: HTMLSpanElement; rect: DOMRect }[]; y0: number; y1: number }[] = [];
    for (const it of withRects) {
      let best: (typeof rowGroups)[0] | null = null;
      let bestFrac = 0;
      for (const row of rowGroups) {
        const ov = Math.min(row.y1, it.rect.bottom) - Math.max(row.y0, it.rect.top);
        if (ov <= 0) continue;
        const frac = ov / Math.min(row.y1 - row.y0, it.rect.height);
        if (frac > bestFrac) { bestFrac = frac; best = row; }
      }
      if (best && bestFrac >= 0.35) {
        best.spans.push(it);
        best.y0 = Math.min(best.y0, it.rect.top);
        best.y1 = Math.max(best.y1, it.rect.bottom);
      } else {
        rowGroups.push({ spans: [it], y0: it.rect.top, y1: it.rect.bottom });
      }
    }

    const sortedLines = rowGroups
      .sort((a, b) => a.y0 - b.y0)
      .map(row => {
        // LAYOUT-FIX-22 (F26-b): gap-aware склейка внутри строки —
        // суб-словесные стыки продюсера без пробела (зазоры в pt через
        // --scale-factor), остальные — через пробел (прежнее поведение).
        // In-place sort сохранён (упорядоченный список ниже читает row.spans).
        row.spans.sort((a, b) => a.rect.left - b.rect.left);
        const scale = domScaleFactor(row.spans.map(it => it.span));
        let line = '';
        for (let i = 0; i < row.spans.length; i++) {
          const { span } = row.spans[i];
          const style = this.getComputedStyleCached(span);
          let content = this.escapeHtml(span.textContent || '');
          const isBold = parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold';
          if (isBold) content = `<b>${content}</b>`;
          if (style.fontStyle === 'italic') content = `<i>${content}</i>`;
          if (i === 0) { line = content; continue; }
          const prev = row.spans[i - 1];
          const fuse = fuseSpanTexts(
            { left: prev.rect.left / scale, right: prev.rect.right / scale, text: prev.span.textContent || '' },
            { left: row.spans[i].rect.left / scale, text: span.textContent || '' },
          );
          line += (fuse ? '' : ' ') + content;
        }
        return line;
      })
      .filter(line => line.trim());

    // TABLE-KEEP + FIX (v5): умное сохранение переносов.
    // Даже при preserveSourceLineBreaks=false (по умолчанию, лучше для прозы)
    // сохраняем <br> для табличных абзацев: каждая строка — короткий item
    // (<= TABLE_KEEP_MAX_WORDS_PER_ROW слов, >= 2 строк). Калибровка eml3
    // (try.pdf p2/p4/p5 + Feline URT p7): табличные строки 1-5 слов,
    // прозаические 7+; прежний порог «< 5» пропускал статистические таблицы
    // со строками ровно из 5 токенов.
    //   "item1<br>item2<br>item3" вместо "item1 item2 item3"
    const shouldUseBreaks = this.shouldPreserveLineBreaks(sortedLines);

    const ordered = sortedLines.length > 0 || rowGroups.length > 0
      ? rowGroups.flatMap(row => row.spans.map(({ span }) => span))
      : [];
    return {
      html: shouldUseBreaks ? sortedLines.join('<br>') : sortedLines.join(' '),
      ordered,
    };
  }

  /**
   * FIX (v5) + TABLE-KEEP:Detect table-like paragraphs that need <br>
   * preservation.
   *
   * Rule (per user spec): if a paragraph has 2+ non-empty lines and EACH
   * non-empty line has <= TABLE_KEEP_MAX_WORDS_PER_ROW words → preserve
   * <br>. This catches:
   *   - 2-row tables: "DSH 10<br>FS 14"
   *   - 3+ row tables: "item1<br>item2<br>item3"
   *   - Stat tables (emul3 calibration): "Male 0.7214 0.3285–1.584 –0.813
   *     .416" — 5 tokens; the old "< 5" threshold missed whole tables.
   *   - Reference lists: "22,25<br>10-12<br>3,18,22,25"
   *   - Short labels: "a<br>b<br>c<br>d"
   *
   * Without this, these collapse into one line when
   * preserveSourceLineBreaks=false, making tables unreadable.
   */
  private shouldPreserveLineBreaks(lines: string[]): boolean {
    // If user explicitly enabled preserveSourceLineBreaks, always use <br>
    if (this.plugin.settings.preserveSourceLineBreaks) return true;

    // TABLE-KEEP: общий калиброванный критерий (см. table-keep.ts)
    return isTableLikeRowTexts(lines);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&#039;');
  }

  /**
   * LAYOUT-FIX-9 (P2): вырожденный ДО-детекционный фильтр фида — только
   * «материальность» бокса (нулевые/подпиксельные размеры marked-content,
   * пустой текст). Контентные правила (числа, маркеры, http) ушли в
   * пост-детекцию (см. prepareTranslationUnits) — фид DOM-пути теперь
   * симметричен фиду очереди (buildInputRects тоже пропускает только
   * вырожденные item'ы).
   */
  private hasMaterialBox(span: HTMLSpanElement): boolean {
    const rect = this.getBoundingClientRectCached(span);
    const text = (span.textContent || '').trim();
    return rect.width > 1 && rect.height > 1 && !!text;
  }

  /**
   * LAYOUT-FIX-9 (P2): числовой суперскрипт (кегль < 0.85×медианы) —
   * загрязнитель детекции: приподнятые базлайны ломают строчную
   * статистику и рвут записи TOC (try:p1, F1=4). Обёртка над общим
   * isDetectionPollutingRect (table-keep.ts) для DOM-спанов.
   */
  private isDetectionPolluting(span: HTMLSpanElement, ctx?: { medianSpanHeight?: number }): boolean {
    const rect = this.getBoundingClientRectCached(span);
    return isDetectionPollutingRect({ top: rect.top, bottom: rect.bottom, height: rect.height, text: span.textContent || '' }, ctx);
  }

  public isValidSpan(span: HTMLSpanElement, ctx?: { medianSpanHeight?: number; pageTop?: number; pageBottom?: number; marginBandPx?: number }, hyphenNeighbors?: Map<HTMLSpanElement, HyphenNeighbors> | null): boolean {
    const rect = this.getBoundingClientRectCached(span);
    const text = (span.textContent || '').trim();
    if (rect.width <= 1 || rect.height <= 1 || !text) return false;
    if (/^\d{1,3}$/.test(text)) {
      // TABLE-KEEP: числовые спаны гибнут только в двух легитимных случаях:
      // (а) полоса колонтитула — номер страницы; (б) суперскрипт — ссылочный
      // индекс (кегль ~0.75× страничного). Числовая ЯЧЕЙКА таблицы (обычный
      // кегль, в контенте) выживает — прежде она исчезала из текста бокса,
      // оставляя белое пятно поверх числа. Без ctx — прежнее поведение.
      if (!shouldDropNumericSpan({ left:rect.left,right:rect.right,top: rect.top, bottom: rect.bottom, height: rect.height }, ctx)) {
        return true;
      }
      return false;
    }
    if (text.length === 1 && /[•\-»«]/.test(text)) {
      // LAYOUT-FIX-22 (F26-a): приклеенный дефис — часть слова, а не маркер
      // списка; контекст соседей даёт только ПОСТ-детекционный проход
      // (юнитные соседи, как в очереди); легаси-путь без контекста —
      // прежнее поведение (дроп).
      if (text === '-' && hyphenNeighbors) {
        const nb = hyphenNeighbors.get(span);
        if (nb && isIntraWordHyphen(nb)) return true;
      }
      return false;
    }
    if (text.startsWith('http')) return false;
    return true;
  }

  private validateSpans(spans: HTMLSpanElement[]): HTMLSpanElement[] {
    return spans.filter(span => span instanceof HTMLSpanElement && span.isConnected);
  }

  private validatePageElement(pageElement: HTMLElement): boolean {
    return pageElement instanceof HTMLElement && pageElement.isConnected;
  }

  getBoundingClientRectCached(element: HTMLElement): DOMRect {
    const now = Date.now();
    const cached = this.measurementCache.get(element);
    if (cached && now - cached.timestamp < 100) return cached.rect;
    const rect = element.getBoundingClientRect();
    this.measurementCache.set(element, { rect, timestamp: now });
    return rect;
  }

  private getComputedStyleCached(element: HTMLElement): CSSStyleDeclaration {
    if (!this.styleCache.has(element)) {
      this.styleCache.set(element, window.getComputedStyle(element));
    }
    return this.styleCache.get(element)!;
  }

  private clearCaches(): void {
    this.measurementCache.clear();
    this.styleCache.clear();
  }

  public getSpansBbox(spans: HTMLSpanElement[], pageElement: HTMLElement) {
    if (!spans?.length) return { rect: null, fontSizes: [], avgFontSize: 12, fontFamily: 'sans-serif' };
    const pageRect = pageElement.getBoundingClientRect();
    // BBOX-FIT-3 (2026-09-14): за начало координат берём PADDING-box страницы.
    // Overlay-контейнер (position:absolute; top:0;left:0) и textLayer pdf.js
    // привязаны именно к padding-box, а getBoundingClientRect() возвращает
    // BORDER-box. В pdf.js 4.x .pdfViewer .page имеет прозрачную рамку
    // var(--page-border) = 9px solid transparent (так рисуются «зазоры»
    // между страницами; подтверждено real-browser эмуляцией на pdfjs 4.10:
    // textLayer/canvas/контейнер стоят на +9,+9 от border-box). Вычитание
    // border-box сдвигало каждый живой оверлей на +9px вправо-вниз — видны
    // непокрытые кусочки оригинального текста слева/сверху каждого бокса.
    // Прибавляем толщину рамки, чтобы попасть в фактическую рамку рендера.
    const pageStyle = this.getComputedStyleCached(pageElement);
    const originLeft = pageRect.left + (parseFloat(pageStyle.borderLeftWidth) || 0);
    const originTop = pageRect.top + (parseFloat(pageStyle.borderTopWidth) || 0);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const fontSizes: number[] = [];
    let fontFamily = 'sans-serif';
    for (const span of spans) {
      const rect = this.getBoundingClientRectCached(span);
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      const style = this.getComputedStyleCached(span);
      fontSizes.push(parseFloat(style.fontSize) || 12);
      if (fontFamily === 'sans-serif' && style.fontFamily) {
        fontFamily = style.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      }
    }
    if (!isFinite(left)) return { rect: null, fontSizes: [], avgFontSize: 12, fontFamily };
    const rect = new DOMRect(left - originLeft, top - originTop, right - left, bottom - top);
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length || 12;
    return { rect, fontSizes, avgFontSize, fontFamily };
  }

  public cleanup(): void {
    this.overlayContainers.forEach(container => container.remove());
    this.overlayContainers = [];
    this.clearLayoutDebugOverlay();
    this.clearCaches();
    this.translationFailures = [];
    // FIX D4: lastPreparedUnits removed — no global state to clear.
  }

  // FIX H9: remove a single overlay container from both DOM and the tracking array.
  // Without this, overlayContainers grows unbounded — detached DOM subtrees retained
  // forever until cleanup() is called (plugin reload). Call this instead of
  // container.remove() when removing an overlay.
  public removeOverlayContainer(container: HTMLElement): void {
    const idx = this.overlayContainers.indexOf(container);
    if (idx >= 0) {
      this.overlayContainers.splice(idx, 1);
    }
    container.remove();
  }

  private clearLayoutDebugOverlay(pageElement?: HTMLElement): void {
    if (pageElement) {
      pageElement.querySelectorAll('.pdf-layout-debug-overlay').forEach(el => el.remove());
      return;
    }
    document.querySelectorAll('.pdf-layout-debug-overlay').forEach(el => el.remove());
  }

  private renderLayoutDebugOverlay(
    pageElement: HTMLElement,
    columnAnalysis: {
      columns: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
      verticalGaps: number[];
    },
    strips: VerticalStrip[],
    layoutRegions: Array<{ top: number; bottom: number; left: number; right: number }>
  ): void {
    this.clearLayoutDebugOverlay(pageElement);

    const pageRectRaw = pageElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const normLeft = pageRectRaw.left / dpr;
    const normTop = pageRectRaw.top / dpr;
    const normWidth = pageRectRaw.width / dpr;
    const normHeight = pageRectRaw.height / dpr;

    if (normWidth <= 0 || normHeight <= 0) return;

    const toLocalX = (xNorm: number): number => ((xNorm - normLeft) / normWidth) * 100;
    const toLocalY = (yNorm: number): number => ((yNorm - normTop) / normHeight) * 100;
    const toLocalW = (wNorm: number): number => (wNorm / normWidth) * 100;
    const toLocalH = (hNorm: number): number => (hNorm / normHeight) * 100;

    const layer = document.createElement('div');
    layer.className = 'pdf-layout-debug-overlay';
    layer.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'z-index:140'
    ].join(';');

    for (const region of layoutRegions) {
      const regionEl = document.createElement('div');
      regionEl.style.cssText = [
        'position:absolute',
        `left:${toLocalX(region.left).toFixed(3)}%`,
        `top:${toLocalY(region.top).toFixed(3)}%`,
        `width:${toLocalW(Math.max(0, region.right - region.left)).toFixed(3)}%`,
        `height:${toLocalH(Math.max(0, region.bottom - region.top)).toFixed(3)}%`,
        'border:1px solid rgba(80,205,120,0.75)',
        'background:rgba(80,205,120,0.04)',
        'box-sizing:border-box'
      ].join(';');
      layer.appendChild(regionEl);
    }

    for (const col of columnAnalysis.columns || []) {
      const colEl = document.createElement('div');
      colEl.style.cssText = [
        'position:absolute',
        `left:${toLocalX(col.left).toFixed(3)}%`,
        `top:${toLocalY(col.top).toFixed(3)}%`,
        `width:${toLocalW(Math.max(0, col.width)).toFixed(3)}%`,
        `height:${toLocalH(Math.max(0, col.height)).toFixed(3)}%`,
        'border:1px solid rgba(0,150,255,0.75)',
        'background:rgba(0,150,255,0.05)',
        'box-sizing:border-box'
      ].join(';');
      layer.appendChild(colEl);
    }

    for (const gx of columnAnalysis.verticalGaps || []) {
      const line = document.createElement('div');
      line.style.cssText = [
        'position:absolute',
        `left:${toLocalX(gx).toFixed(3)}%`,
        'top:0', 'width:0', 'height:100%',
        'border-left:2px solid rgba(255,170,0,0.9)'
      ].join(';');
      layer.appendChild(line);
    }

    pageElement.appendChild(layer);
  }
}
