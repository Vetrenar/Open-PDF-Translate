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
// One paragraph = one TranslationUnit (split only if > maxBatchChars).

// P0-2: removed `@ts-nocheck`. It previously masked real type errors
// including the missing `externalLayoutService` / `ocrLayoutService`
// declarations (P0-1) and the dead `_fromCache` field on TranslationUnit.
// All `_externalRect` / `_externalFont` accesses are now type-safe because
// those fields are declared optional on `TranslationUnit` in types.ts.

import { Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { TranslationUnit, OverlayPositionData } from './types';
import { LayoutDetector, LayoutSettings } from './layout-detector';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Used at
// the cache→OverlayPositionData construction site below so the merged
// result has the same id as the on-disk version (which the DOM-extraction
// and queue paths also produce for the same source paragraph).
import { generateOverlayId, getCurrentEngine } from './overlay-id';
import type { VerticalStrip } from './layout-detector';
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
      new Notice(`✓ Translation complete. Rendered ${successfulTranslations} segment(s).`, 3000);
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
    if (!prepResult) return;
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
      // FIX H11: capture the page element in the rAF closure. Previously the rAF
      // callback called saveCurrentPageOverlay() which re-queries the current page
      // — if the user scrolled/flipped pages before the rAF fired, the wrong page
      // would be saved. Now we pass the page element so saveCurrentPageOverlay
      // can extract overlay data from the CORRECT page.
      const pageElForSave = pageElement;
      requestAnimationFrame(() => {
        this.plugin.overlay.saveCurrentPageOverlayForPage(pageElForSave);
      });
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
   * If paragraph text > maxBatchChars, split into sentence groups
   * (chunking only — does NOT merge or alter paragraph boundaries).
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

    const textSpans = this.validateSpans(rawSpans).filter(span => this.isValidSpan(span));

    if (textSpans.length === 0) {
      return null;
    }

    // P1-9 (Phase 13): use a per-call detector when the caller supplied
    // tuned settings; otherwise fall back to the shared instance that
    // `updateLayoutDetectorSettings` keeps in sync with the plugin's
    // global layout settings.
    const detector = layoutSettings
      ? new LayoutDetector(layoutSettings)
      : this.layoutDetector;
    const result = detector.detectLayout(textSpans, pageElement);

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
      console.log(`PDF Translator: DOM pipeline → ${result.paragraphs.length} paragraph(s).`);
    }
    this.clearCaches();

    const { maxBatchChars } = this.plugin.settings;

    // ── Emit one TranslationUnit per pipeline paragraph ─────────────
    return result.paragraphs.flatMap((paragraphSpans, paraIndex) => {
      if (!paragraphSpans || paragraphSpans.length === 0) return [];
      const paragraphId = `para-${paraIndex}`;
      const paragraphAsHtml = this.spansToHtml(paragraphSpans);

      if (paragraphAsHtml.length <= maxBatchChars) {
        if (paragraphAsHtml.length <= 5) return [];
        return [{
          originalSpans: paragraphSpans,
          text: paragraphAsHtml,
          id: paragraphId,
          paragraphId: paragraphId,
        }];
      }

      // Chunk by sentence groups (large paragraphs only)
      const sortedSpans = [...paragraphSpans].sort((a, b) => {
        const rectA = this.getBoundingClientRectCached(a);
        const rectB = this.getBoundingClientRectCached(b);
        if (Math.abs(rectA.top - rectB.top) > 5) return rectA.top - rectB.top;
        return rectA.left - rectB.left;
      });

      const sentenceSpanGroups: HTMLSpanElement[][] = [];
      let currentSentenceSpans: HTMLSpanElement[] = [];
      const sentenceEndRegex = /[.?!]\s*$/;

      for (const span of sortedSpans) {
        currentSentenceSpans.push(span);
        if (sentenceEndRegex.test((span.textContent || '').trim())) {
          sentenceSpanGroups.push(currentSentenceSpans);
          currentSentenceSpans = [];
        }
      }
      if (currentSentenceSpans.length > 0) {
        sentenceSpanGroups.push(currentSentenceSpans);
      }

      return sentenceSpanGroups
        .map((spans, sentenceIndex) => {
          const text = this.spansToHtml(spans);
          if (!text || text.length <= 5) return null;
          return {
            originalSpans: spans,
            text,
            id: `${paragraphId}-sent-${sentenceIndex}`,
            paragraphId: paragraphId,
          };
        })
        .filter((unit): unit is TranslationUnit => !!unit);
    });
  }

  // ==================== TRANSLATION EXECUTION ====================

  public async executeTranslation(units: TranslationUnit[]): Promise<string[]> {
    this.translationFailures = [];

    if (units.length === 0) return [];

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
          skippedIndices = skipped;
          translatableUnits = translatable.map(i => units[i]);
          if (this.plugin.settings.debugMode) {
            console.log(`[ParagraphFilter] ${skipped.size}/${units.length} paragraphs filtered (not sent to LLM):`,
              [...skipped.entries()].map(([i, name]) => `#${i + 1} (${name}): "${units[i].text.substring(0, 30)}"`));
          }
        }
      }
    }

    // If all paragraphs were filtered, return originals immediately.
    if (translatableUnits.length === 0) {
      return units.map(u => u.text);
    }

    // Build batch text from translatable units only.
    const fullText = translatableUnits.map((u, i) => `[#${i + 1}] ${u.text}`).join('\n');
    const { useBatchTranslation: useBatch, maxBatchChars } = this.plugin.settings;

    // FIX: simplified to purely character-based chunking. Token estimation was
    // inaccurate (especially for reasoning models) and caused more problems
    // than it solved. The user controls chunk size via maxBatchChars — if a
    // provider has a small context window, set maxBatchChars accordingly.
    const shouldUseChunking = useBatch && translatableUnits.length > 1 &&
      fullText.length > maxBatchChars;

    try {
      let translatedLines: string[];

      // Stage 2.4: use translatableUnits (filtered) for LLM calls, not
      // the full units array. The LLM only sees non-filtered paragraphs.
      if (shouldUseChunking) {
        new Notice(`Long page detected. Translating in multiple batches...`, 4000);
        translatedLines = await this.performChunkedTranslation(translatableUnits, maxBatchChars);
      } else if (useBatch && translatableUnits.length > 1) {
        const raw = await this.plugin.translation.translateBatch(fullText, translatableUnits.length);
        if (this.plugin.settings.debugMode) {
          console.log(`[Batch Input]:\n${fullText}`);
          console.log(`[Batch Raw Output]:\n${raw}`);
        }
        translatedLines = await this.extractNumberedLinesRobust(raw, translatableUnits.length, translatableUnits.map(u => u.text));
      } else {
        translatedLines = await this.performSequentialTranslation(translatableUnits);
      }

      translatedLines = this.restoreStructure(translatableUnits, translatedLines);

      // Final cleanup: strip any <br> that survived earlier stages
      translatedLines = translatedLines.map(line =>
        line.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()
      );

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
        return result;
      }

      return translatedLines;

    } catch (err: any) {
      // FIX H14: was logDebug (silent, debugMode-gated). Fatal translation errors
      // must be surfaced to the user — otherwise they see false "✓ Translation complete"
      // while all segments silently fell back to originals.
      console.error('[PDF Translator] Translation failed:', err);
      new Notice(`Translation failed: ${err?.message || err}`, 8000);
      return units.map(u => u.text);
    }
  }

  // The chunked / sequential / extraction methods below are unchanged
  // from the previous version — they only consume the TranslationUnit[]
  // list produced by prepareTranslationUnits. They are kept here so the
  // plugin can still handle large pages, but they do NOT alter paragraph
  // boundaries from the pipeline.

  private async performChunkedTranslation(units: TranslationUnit[], maxChars: number): Promise<string[]> {
    const chunks: TranslationUnit[][] = [];
    let currentChunk: TranslationUnit[] = [];
    let currentSize = 0;

    for (const unit of units) {
      const unitSize = unit.text.length + 20;
      if (currentSize + unitSize > maxChars && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }
      currentChunk.push(unit);
      currentSize += unitSize;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    // FIX: removed token-based context-window splitting. Chunking is now
    // purely character-based via maxBatchChars (handled above). If a provider
    // has a small context window, the user should set maxBatchChars accordingly.
    const finalChunks = chunks;

    const allTranslated: string[] = [];
    const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
    for (let i = 0; i < finalChunks.length; i++) {
      // P1-2 (Phase 9): per-chunk cancel check — break out of the chunk
      // loop within ~one chunk of LLM latency when the queue is cancelled,
      // instead of draining every remaining chunk for the in-flight page.
      // The thrown error propagates to executeTranslation's catch, which
      // falls back to originals for the page (same as a network failure).
      // For the interactive path (queue NOT cancelled), `?.` short-circuits
      // to undefined → no-op, so existing behaviour is preserved.
      if (this.plugin.pdfLayoutQueue?.isCancelled?.()) {
        throw new Error('cancelled');
      }
      const chunk = finalChunks[i];
      const chunkText = chunk.map((u, j) => `[#${j + 1}] ${u.text}`).join('\n');
      try {
        const raw = await this.plugin.translation.translateBatch(chunkText, chunk.length);
        const lines = await this.extractNumberedLinesRobust(raw, chunk.length, chunk.map(u => u.text));
        allTranslated.push(...lines);
        if (finalChunks.length > 1) {
          new Notice(`Batch ${i + 1}/${finalChunks.length} complete.`, 2000);
        }
      } catch (err) {
        console.error(`Chunk ${i + 1} failed:`, err);
        allTranslated.push(...chunk.map(u => u.text));
      }
      // FIX: respect sequentialDelayMs between chunks (rate-limit friendly).
      // Without this, chunked translation fires API calls back-to-back,
      // causing 429 rate limit errors on providers with strict limits.
      if (i < finalChunks.length - 1 && delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return allTranslated;
  }

  /**
   * FIX H2: shared chunking utility for all translation paths (interactive,
   * queue, headless). Splits texts by `maxBatchChars`, then further by
   * `contextWindow` if needed. Translates chunks sequentially, preserves
   * order. Returns translated strings aligned 1:1 with input texts.
   *
   * Why this exists: `performChunkedTranslation` operates on
   * `TranslationUnit[]` (interactive path), but the two background paths
   * (`pdf-layout-queue.translateParagraphs` and
   * `HeadlessTranslator.translateFile`) only have `string[]`. Previously
   * they called `translateBatch(fullText, count)` directly — a single
   * API call for an entire page. With a small-context provider (e.g.
   * Ollama at 4K) and a large page (20 paragraphs × 500 chars = 10K),
   * the whole page exceeded the context window and the LLM either
   * truncated, errored, or silently fell back to originals.
   *
   * Order preservation: chunk 1 receives texts[0..n], chunk 2 receives
   * texts[n+1..m], etc. Results are concatenated in the same order.
   *
   * Partial failure: each chunk is wrapped in its own try/catch. If a
   * chunk fails (network error, parse error, etc.) its texts fall back
   * to their originals — other chunks still return their translations.
   * The whole batch only throws if the queue is cancelled mid-flight.
   *
   * Cancellation: between chunks, checks
   * `this.plugin.pdfLayoutQueue?.isCancelled?.()`. If cancelled, throws
   * `new Error('cancelled')` so callers can surface it (queue path) or
   * fall back to originals (headless path).
   *
   * Edge cases:
   *   - Empty input  → returns [].
   *   - Single text  → no chunking (one chunk of size 1, but still goes
   *                    through translateBatch for consistency with the
   *                    rest of the pipeline).
   *   - All filtered → caller is expected to short-circuit before
   *                    calling this method (as both queue and headless
   *                    already do).
   */
  public async translateTextsWithChunking(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];

    // FIX: chunking is PURELY character-based via maxBatchChars.
    // No token estimation — it was inaccurate and caused problems with
    // reasoning models. If a provider has a small context window, the user
    // should set maxBatchChars appropriately (e.g., 2000 chars for 4K context).
    const maxBatchChars = this.plugin.settings.maxBatchChars ?? 4000;

    // ── Step 0: pre-split texts that individually exceed maxBatchChars ──
    // FIX: previously a single paragraph longer than maxBatchChars was sent
    // as-is in one chunk → context overflow → "Empty response" → fallback to
    // original (text effectively "lost" because translation failed). Now we
    // split long paragraphs by sentences BEFORE chunking. The split markers
    // [#N] are regenerated per-chunk, so the LLM sees coherent segments.
    const UNIT_OVERHEAD = 20;
    const preSplitTexts: string[] = [];
    for (const text of texts) {
      if (text.length + UNIT_OVERHEAD > maxBatchChars) {
        const sentences = this.splitLongTextBySentences(text, maxBatchChars - UNIT_OVERHEAD);
        preSplitTexts.push(...sentences);
      } else {
        preSplitTexts.push(text);
      }
    }

    // ── Step 1: split by maxBatchChars ──────────────────────────────
    // Accumulate texts until adding the next one would exceed the
    // character budget. Use the same +20-char overhead per text as
    // `performChunkedTranslation` (for the `[#N] ` prefix + `\n`).
    const charChunks: string[][] = [];
    let current: string[] = [];
    let currentSize = 0;
    for (const text of preSplitTexts) {
      const textSize = text.length + UNIT_OVERHEAD;
      if (currentSize + textSize > maxBatchChars && current.length > 0) {
        charChunks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(text);
      currentSize += textSize;
    }
    if (current.length > 0) charChunks.push(current);

    // ── Step 2: (removed token-based context window check) ──────────
    // FIX: token estimation was inaccurate and caused problems with reasoning
    // models. Chunking is now PURELY character-based via maxBatchChars (Step 1).
    // If a provider has a small context window, the user should set maxBatchChars
    // appropriately (e.g., 2000 chars for 4K context models).
    const finalChunks = charChunks;

    // FIX: show batch progress notices (matching the standard pipeline's UX).
    // Without these notices, the user has no feedback during multi-chunk
    // background translation — it looks like nothing is happening.
    if (finalChunks.length > 1) {
      new Notice(`Translating in ${finalChunks.length} batches...`, 3000);
    }

    // ── Step 3: translate each chunk sequentially, preserve order ───
    // Per-chunk try/catch — a failed chunk falls back to its originals
    // so a single bad chunk doesn't lose the rest of the page. The
    // cancel-check between chunks lets `Pause`/`Cancel` in the watcher
    // modal take effect within ~one chunk's worth of LLM latency.
    const allTranslated: string[] = [];
    for (let i = 0; i < finalChunks.length; i++) {
      const chunk = finalChunks[i];
      if (this.plugin.pdfLayoutQueue?.isCancelled?.()) {
        throw new Error('cancelled');
      }
      try {
        const chunkText = chunk.map((t, j) => `[#${j + 1}] ${t}`).join('\n');
        if (this.plugin.settings.debugMode) {
          console.log(`[Chunk ${i + 1}/${finalChunks.length} Input]:\n${chunkText.substring(0, 200)}...`);
        }
        const raw = await this.plugin.translation.translateBatch(chunkText, chunk.length);
        if (this.plugin.settings.debugMode) {
          console.log(`[Chunk ${i + 1}/${finalChunks.length} Raw Output]:\n${raw?.substring(0, 200) || '(empty)'}`);
        }
        const lines = await this.extractNumberedLinesRobust(raw, chunk.length, chunk);
        allTranslated.push(...lines);
        // FIX: show per-chunk progress notice (matching standard pipeline)
        if (finalChunks.length > 1) {
          new Notice(`Batch ${i + 1}/${finalChunks.length} complete.`, 2000);
        }
      } catch (err) {
        // Partial-failure fallback: this chunk's texts revert to
        // originals. Other chunks still get their translations.
        console.error(
          `[translateTextsWithChunking] chunk ${i + 1}/${finalChunks.length} failed, falling back to originals:`,
          err,
        );
        new Notice(
          `Batch ${i + 1}/${finalChunks.length} failed — using original text. ` +
          `Error: ${err?.message?.substring(0, 60) || err}`,
          5000,
        );
        allTranslated.push(...chunk);
      }
    }
    return allTranslated;
  }

  /**
   * FIX: split a single long text into segments that fit within `maxLen`.
   * Tries sentence boundaries first (., !, ?, 。, ！, ？), then falls back
   * to word boundaries, then to hard character split. Each segment is ≤ maxLen.
   * This prevents "Empty response" errors when a single paragraph exceeds
   * maxBatchChars — previously the whole paragraph was sent in one API call
   * and failed on context overflow.
   */
  private splitLongTextBySentences(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const segments: string[] = [];
    // Sentence-end markers: Latin (.!?) + CJK (。！？)
    const sentenceRegex = /[^.!?。！？\n]+[.!?。！？\n]+|\S[^.!?。！？\n]*$/g;
    const sentences = text.match(sentenceRegex) || [text];

    let current = '';
    for (const sentence of sentences) {
      if (sentence.length > maxLen) {
        // Single sentence longer than maxLen — split by words/spaces
        if (current) { segments.push(current); current = ''; }
        const words = sentence.split(/(\s+)/);
        for (const word of words) {
          if ((current + word).length > maxLen && current) {
            segments.push(current);
            current = '';
          }
          current += word;
        }
      } else if ((current + sentence).length > maxLen && current) {
        segments.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) segments.push(current);

    // Last resort: if any segment still > maxLen, hard-split by characters
    const result: string[] = [];
    for (const seg of segments) {
      if (seg.length <= maxLen) {
        result.push(seg);
      } else {
        for (let i = 0; i < seg.length; i += maxLen) {
          result.push(seg.slice(i, i + maxLen));
        }
      }
    }
    return result.length > 0 ? result : [text];
  }

  private async performSequentialTranslation(units: TranslationUnit[]): Promise<string[]> {
    const results: string[] = [];
    const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
    const maxChars = this.plugin.settings.maxBatchChars;

    for (let i = 0; i < units.length; i++) {
      // P1-2 (Phase 9): per-segment cancel check (see performChunkedTranslation
      // for rationale). Place BEFORE the try so the throw escapes the loop
      // instead of being swallowed by the per-segment fallback catch below.
      if (this.plugin.pdfLayoutQueue?.isCancelled?.()) {
        throw new Error('cancelled');
      }
      try {
        // FIX #4: Oversized single unit handling.
        // If a unit exceeds maxBatchChars, sending it as a single LLM request
        // may exceed max_tokens and produce a truncated translation.
        // Split by sentences and translate in sub-batches (each ≤ maxBatchChars),
        // then concatenate the sub-translations.
        if (units[i].text.length > maxChars) {
          const translated = await this.translateOversizedUnit(units[i].text, maxChars);
          results.push(translated);
        } else {
          // FIX: TranslationEngine has only translateBatch() and translateWithOpenRouter().
          // The previous call to .translate() always threw TypeError, was caught
          // silently, and returned the original text — masking the failure.
          // This is the root cause of "bulk didn't work on native": when units.length === 1
          // (common on native layout), batch mode was bypassed and this broken sequential
          // path was used, returning untranslated text.
          const text = await this.plugin.translation.translateWithOpenRouter(units[i].text);
          results.push(text);
        }
      } catch (err) {
        console.error(`Segment ${i + 1} failed:`, err);
        results.push(units[i].text);
      }
      // Respect sequentialDelayMs between requests (rate-limit friendly).
      if (i < units.length - 1 && delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return results;
  }

  /**
   * Translate an oversized unit by splitting it into sentence-based sub-batches.
   *
   * Algorithm:
   *   1. Split text into sentences (regex: /[^.!?]+[.!?]+\s*|\S+$/).
   *   2. Group sentences into sub-batches, each ≤ maxChars.
   *   3. Use translateBatch() for each sub-batch (with [#N] numbering).
   *   4. Concatenate all sub-translations into a single string.
   *
   * Fallback: if sentence split fails or produces 0 sentences, fall back to
   * a single translateWithOpenRouter call (may truncate, but better than nothing).
   */
  private async translateOversizedUnit(text: string, maxChars: number): Promise<string> {
    // Split into sentences. Keep the trailing punctuation with each sentence.
    const sentences = text.match(/[^.!?]+[.!?]+\s*|\S+$/g) || [text];
    if (sentences.length <= 1) {
      // Can't split further — send as single request (may truncate)
      return await this.plugin.translation.translateWithOpenRouter(text);
    }

    // Group sentences into sub-batches, each ≤ maxChars
    const subBatches: string[][] = [];
    let currentBatch: string[] = [];
    let currentSize = 0;
    const UNIT_OVERHEAD = 20;  // [#N] prefix + \n separator per unit

    for (const sentence of sentences) {
      const sentenceSize = sentence.length + UNIT_OVERHEAD;
      if (currentSize + sentenceSize > maxChars && currentBatch.length > 0) {
        subBatches.push(currentBatch);
        currentBatch = [];
        currentSize = 0;
      }
      currentBatch.push(sentence);
      currentSize += sentenceSize;
    }
    if (currentBatch.length > 0) subBatches.push(currentBatch);

    // Translate each sub-batch using batch mode (numbering helps LLM keep order)
    const subTranslations: string[] = [];
    for (const subBatch of subBatches) {
      const batchText = subBatch.map((s, j) => `[#${j + 1}] ${s}`).join('\n');
      try {
        const raw = await this.plugin.translation.translateBatch(batchText, subBatch.length);
        const lines = await this.extractNumberedLinesRobust(raw, subBatch.length, subBatch);
        subTranslations.push(...lines);
      } catch (err) {
        console.error('Sub-batch translation failed, falling back to originals:', err);
        subTranslations.push(...subBatch);
      }
    }

    // Join all sub-translations into a single string
    return subTranslations.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Robust extraction of numbered lines from LLM batch response.
   *
   * CRITICAL: MUST return exactly `expectedCount` lines, one per input unit.
   * Paragraph boundaries (from pipeline) MUST be preserved — never merge
   * adjacent units even if LLM returns merged text.
   *
   * Supports multiple LLM response formats:
   *   - `[#1] text` (our preferred format, sent in chunkText)
   *   - `1. text` / `1) text` / `[1] text` (LLM may use these alternatives)
   *   - `1: text`
   *
   * Algorithm:
   *   1. Find all numbered markers in the response (any of the formats above).
   *   2. Sort by their index N.
   *   3. If a marker N is missing → fall back to original text for that slot.
   *   4. If a marker N has multi-line content → join with single space
   *      (so LLM's internal newlines don't create false paragraph breaks).
   *   5. If multiple markers reference the same N → use the first one.
   *   6. Truncate / pad to exactly expectedCount.
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
        // Strip any <br> tags the LLM may have copied from source —
        // translation should be continuous text, not mirror PDF line wrapping.
        const trimmed = currentText
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
        // Continuation line — append to current segment
        if (currentIdx >= 0) {
          currentText += ' ' + line.trim();
        }
        // If currentIdx < 0, this is preamble before any marker — ignore.
      }
    }
    // Flush last segment
    flushCurrent();

    // FIX C3: mandatory warning if no [#N] markers found — indicates LLM ignored
    // prompt format instructions or prompt template is broken. Without this warning,
    // all segments silently fall back to originals and user sees "✓ Translation complete".
    if (found.size === 0 && expectedCount > 0) {
      console.warn('[extractNumberedLinesRobust] No [#N] markers found in LLM response. ' +
        'All segments will fall back to original text. Check prompt template format. ' +
        `Response preview: ${cleanedRaw.substring(0, 200)}...`);
    }

    // Build result array — fill missing slots with originals (fallback)
    const result: string[] = [];
    for (let i = 0; i < expectedCount; i++) {
      const translated = found.get(i);
      if (translated && translated.length > 0) {
        result.push(translated);
      } else {
        // LLM didn't return this segment — fall back to original text
        // (better than "Translation missing" because it preserves content).
        if (this.plugin.settings.debugMode) {
          console.warn(`[extractNumberedLinesRobust] Segment #${i + 1} missing in LLM response, falling back to original.`);
        }
        result.push(originals[i] || 'Translation missing');
      }
    }

    return result;
  }

  private restoreStructure(units: TranslationUnit[], lines: string[]): string[] {
    return lines.map((line, i) => {
      // Strip <br> tags — translation should be continuous text
      const cleaned = line
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const orig = units[i]?.text || '';
      // Preserve leading numbering/bullets that may have been stripped
      const origLead = orig.match(/^\s*(\d+[\.\)]\s*|[-•*]\s*|#\s*)/);
      if (origLead && !cleaned.match(/^\s*(\d+[\.\)]\s*|[-•*]\s*|#\s*)/)) {
        return origLead[1] + cleaned;
      }
      return cleaned;
    });
  }

  // ==================== OVERLAY RENDERING ====================

  // FIX H10: derive the PDF file from a page element instead of calling
  // getActiveFile(). This prevents stale-file bugs when the user switches
  // tabs during an async translation operation.
  private getFileFromPageElement(pageElement: HTMLElement): TFile | null {
    // Walk up the DOM to find the workspace leaf container
    const leafContent = pageElement.closest('.workspace-leaf-content[data-type="pdf"]') as HTMLElement | null;
    if (!leafContent) {
      // Fallback to getActiveFile if we can't find the leaf
      const fallback = this.plugin.app.workspace.getActiveFile();
      return (fallback && fallback.extension === 'pdf') ? fallback : null;
    }

    // Find the leaf by matching the container element
    let resultFile: TFile | null = null;
    this.plugin.app.workspace.iterateAllLeaves((leaf: any) => {
      if (resultFile) return;
      if (leaf.view?.getViewType?.() === 'pdf' && leaf.view.containerEl === leafContent) {
        resultFile = leaf.view.file || null;
      }
    });
    return resultFile;
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
    const reassembledParagraphs = new Map<string, { originalSpans: HTMLSpanElement[]; translatedText: string; originalText: string; }>();
    units.forEach((unit, index) => {
      const { paragraphId, originalSpans } = unit;
      const translatedLine = translatedLines[index];
      if (!reassembledParagraphs.has(paragraphId)) {
        reassembledParagraphs.set(paragraphId, { originalSpans: [], translatedText: '', originalText: '' });
      }
      const group = reassembledParagraphs.get(paragraphId)!;
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
        text: group.originalText
      });
      mergedTranslatedLines.push(group.translatedText);
    });

    this.plugin.overlay.renderOverlays(mergedUnits, mergedTranslatedLines, overlayContainer, pageElement);
  }

  // ==================== HELPERS ====================

  private spansToHtml(spans: HTMLSpanElement[]): string {
    if (!spans?.length) return '';
    const lines = new Map<number, HTMLSpanElement[]>();
    spans.forEach(span => {
      const lineKey = Math.round(this.getBoundingClientRectCached(span).top);
      if (!lines.has(lineKey)) lines.set(lineKey, []);
      lines.get(lineKey)!.push(span);
    });

    const sortedLines = Array.from(lines.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, lineSpans]) =>
        lineSpans
          .sort((a, b) => this.getBoundingClientRectCached(a).left - this.getBoundingClientRectCached(b).left)
          .map(span => {
            const style = this.getComputedStyleCached(span);
            let content = this.escapeHtml(span.textContent || '');
            const isBold = parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold';
            if (isBold) content = `<b>${content}</b>`;
            if (style.fontStyle === 'italic') content = `<i>${content}</i>`;
            return content;
          })
          .join(' ')
      );

    // FIX (v5): smart line break preservation.
    // Even when preserveSourceLineBreaks=false (default, better for prose),
    // we preserve <br> for table-like paragraphs where each line has < 5 words
    // and there are >= 3 such short lines. This prevents table rows / list
    // items from collapsing into one continuous line:
    //   "item1<br>item2<br>item3" instead of "item1 item2 item3"
    //
    // Detection:
    //   - Split each line by whitespace, count words
    //   - If >= 3 lines with 1-4 words each → table-like → use <br>
    //   - Otherwise → prose → use space (unless preserveSourceLineBreaks=true)
    const shouldUseBreaks = this.shouldPreserveLineBreaks(sortedLines);

    return sortedLines.join(shouldUseBreaks ? '<br>' : ' ');
  }

  /**
   * FIX (v5): Detect table-like paragraphs that need <br> preservation.
   *
   * Rule (per user spec): if a paragraph has 2+ non-empty lines and EACH
   * non-empty line has < 5 words → preserve <br>. This catches:
   *   - 2-row tables: "DSH 10<br>FS 14"
   *   - 3+ row tables: "item1<br>item2<br>item3"
   *   - Reference lists: "22,25<br>10-12<br>3,18,22,25"
   *   - Short labels: "a<br>b<br>c<br>d"
   *
   * Without this, these collapse into one line when preserveSourceLineBreaks=false,
   * making tables unreadable.
   *
   * "Each line < 5 words" is the only criterion — no minimum line count
   * beyond 2 (a 1-line paragraph has nothing to join, so the question is moot).
   */
  private shouldPreserveLineBreaks(lines: string[]): boolean {
    // If user explicitly enabled preserveSourceLineBreaks, always use <br>
    if (this.plugin.settings.preserveSourceLineBreaks) return true;

    // Collect non-empty lines
    const nonEmptyLines = lines.filter(l => l.trim());
    if (nonEmptyLines.length < 2) return false;  // need at least 2 lines

    // Check that EVERY non-empty line has < 5 words
    for (const line of nonEmptyLines) {
      const wordCount = line.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount >= 5) return false;  // found a long line → not table-like
    }

    // All lines have < 5 words → table-like → preserve <br>
    return true;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&#039;');
  }

  public isValidSpan(span: HTMLSpanElement): boolean {
    const rect = this.getBoundingClientRectCached(span);
    const text = (span.textContent || '').trim();
    if (rect.width <= 1 || rect.height <= 1 || !text) return false;
    if (/^\d{1,3}$/.test(text)) return false;
    if (text.length === 1 && /[•\-»«]/.test(text)) return false;
    if (text.startsWith('http')) return false;
    return true;
  }

  private validateSpans(spans: HTMLSpanElement[]): HTMLSpanElement[] {
    return spans.filter(span => span instanceof HTMLSpanElement && span.isConnected);
  }

  private validatePageElement(pageElement: HTMLElement): boolean {
    return pageElement instanceof HTMLElement && pageElement.isConnected;
  }

  private getBoundingClientRectCached(element: HTMLElement): DOMRect {
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
    const rect = new DOMRect(left - pageRect.left, top - pageRect.top, right - left, bottom - top);
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
