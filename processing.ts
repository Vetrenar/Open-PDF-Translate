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
import { getCurrentEngine } from './overlay-id';
// T2.4: shared constants/utilities (was duplicated across 5 modules).
import { isTableLikeText, normalizeWithLineBreaks, collapseToSingleLine, CancelToken, isCancelled as tokenCancelled } from './shared';
// T2.5: THE single construction site for saved overlay records.
import { makeOverlay } from './overlay-factory';
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

  // FIX D4 (REMOVED, T6.1): `lastPreparedUnits` was global mutable state shared
  // between the (now deleted) translatePageContent() and createOverlayWithText(). If the user switched
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
      // T1.8: a cancelled/failed run must not render fallback originals over
      // this page's existing overlays — stop here. executeTranslation already
      // surfaced the error Notice.
      const degradedPageNum = parseInt(pageElement.getAttribute('data-page-number') || '0', 10);
      if (this.lastRunDegraded && this.plugin.overlay?.pagesWithOverlays?.has?.(degradedPageNum)) {
        new Notice('Translation incomplete — existing saved overlays left untouched.', 5000);
        return;
      }
      const successfulTranslations = translatedLines.filter(line => line !== 'Translation missing').length;

      await this.createOverlayWithText(pageElement, translationUnits, translatedLines);
      new Notice(`✓ Translation complete. Rendered ${successfulTranslations} segment(s).`, 3000);
    } catch (error: any) {
      if (error?.message === 'cancelled') {
        // T1.2/T1.8: cancellation is a user action, not a failure — render
        // nothing, save nothing.
        new Notice('Translation cancelled.', 3000);
        return;
      }
      console.error("addOverlayToPage process failed:", error);
      new Notice(`⚠ Translation failed: ${error.message}`, 4000);
    }
  }

  // ==================== TRANSLATION PIPELINE ====================

  // T6.1: `translatePageContent` (kept-for-back-compat wrapper over
  // prepare+execute) was removed — it had zero live callers after the
  // multi-page modal migrated to the background queue.

  /**
   * FIX D4 + T6.1: createOverlayWithText accepts TranslationUnit[] +
   * translatedLines as explicit parameters. The legacy `(pageElement,
   * joinedString)` overload relied on the removed `lastPreparedUnits`
   * global state and had no live callers — deleted in this overhaul.
   */
  public async createOverlayWithText(
    pageElement: HTMLElement,
    units: TranslationUnit[],
    translatedLines: string[],
  ): Promise<void> {
    const prepResult = this.validateAndPreparePrerequisites(pageElement, true);
    if (!prepResult) return;
    const { overlayContainer } = prepResult;
    this.overlayContainers.push(overlayContainer);

    const translationUnits = units;
    if (!translationUnits || translationUnits.length === 0) {
      overlayContainer.remove();
      return;
    }

    // === Safety net: enforce equal length ===
    let finalTranslatedLines = translatedLines ?? [];
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

    if (this.plugin.settings.autoSaveOverlay && !this.lastRunDegraded) {
      // FIX H11: capture the page element in the rAF closure. Previously the rAF
      // callback called saveCurrentPageOverlay() which re-queries the current page
      // — if the user scrolled/flipped pages before the rAF fired, the wrong page
      // would be saved. Now we pass the page element so saveCurrentPageOverlay
      // can extract overlay data from the CORRECT page.
      //
      // T1.8 (Q2=2): a degraded run (fallback originals) is NEVER auto-saved —
      // it would silently overwrite good existing translations with
      // untranslated text (exactly the near-miss observed with the
      // "Error: cancelled" boot bug).
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

  /**
   * T1.8: set whenever the most recent executeTranslation/translateSegments
   * run degraded to fallbacks (any segment reverted to its original text,
   * or a page-level failure). Consumers (createOverlayWithText) use this to
   * avoid RENDERING original text over already-saved translations and to
   * skip the auto-save — a failed run must never overwrite good data.
   */
  public lastRunDegraded = false;

  public async executeTranslation(
    units: TranslationUnit[],
    opts?: { isCancelled?: CancelToken },
  ): Promise<string[]> {
    this.translationFailures = [];
    this.lastRunDegraded = false;

    if (units.length === 0) return [];

    // Stage 2.4: Apply paragraph filter rules. Paragraphs matching
    // enabled filter rules (page numbers, single letters, etc.) are NOT
    // sent to the LLM — their original text is used as the "translation".
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

    const { useBatchTranslation: useBatch, maxBatchChars } = this.plugin.settings;
    const translatableTexts = translatableUnits.map(u => u.text);

    let translatedLines: string[];
    try {
      if (useBatch && translatableUnits.length > 1) {
        translatedLines = await this.translateSegments(translatableTexts, {
          isCancelled: opts?.isCancelled,
        });
      } else {
        translatedLines = await this.performSequentialTranslation(translatableUnits, opts?.isCancelled);
      }

      // Restore leading numbering/bullets that LLMs sometimes strip.
      translatedLines = this.restoreStructure(translatableUnits, translatedLines);

      // ── Line-break policy (Q9 + user-requested table handling) ─────────
      // A segment keeps its line structure when EITHER the user explicitly
      // asked for it (preserveSourceLineBreaks) OR the SOURCE segment was
      // table-like (every line short → table rows / list items — the
      // structure IS the meaning). Everything else collapses to one line.
      translatedLines = translatedLines.map((line, i) => {
        const origText = translatableUnits[i]?.text || '';
        const keepBreaks = this.plugin.settings.preserveSourceLineBreaks
          || isTableLikeText(origText);
        return keepBreaks ? normalizeWithLineBreaks(line) : collapseToSingleLine(line);
      });

      // Detect degradation: any segment that fell back to its original
      // text (missing marker / chunk failure). Drives T1.8 protection.
      let degradedCount = 0;
      translatedLines = translatedLines.map((line, i) => {
        if (!line || !line.trim()) {
          degradedCount++;
          console.warn(`Segment ${i + 1} empty. Reverting to original.`);
          return translatableUnits[i].text;
        }
        return line;
      });
      if (degradedCount > 0) this.lastRunDegraded = true;

      // Stage 2.4: merge translated lines back with skipped paragraphs.
      if (skippedIndices.size > 0) {
        const result: string[] = new Array(units.length);
        let transIdx = 0;
        for (let i = 0; i < units.length; i++) {
          if (skippedIndices.has(i)) {
            result[i] = units[i].text;
          } else {
            result[i] = translatedLines[transIdx] || units[i].text;
            transIdx++;
          }
        }
        return result;
      }

      return translatedLines;

    } catch (err: any) {
      // T1.8: a CANCELLED run must not be treated as "translate failed →
      // fall back to originals" — rendering and (worse) auto-SAVING
      // original text over good saved translations is data corruption.
      // Re-throw so addOverlayToPage stops before rendering anything.
      if (err?.message === 'cancelled') {
        this.lastRunDegraded = true;
        throw err;
      }
      // FIX H14: fatal translation errors must be surfaced — otherwise the
      // user sees a false "✓ Translation complete" while all segments
      // silently fell back to originals. Mark degraded so the caller can
      // refuse to overwrite existing saved overlays (Q2 decision, variant 2).
      console.error('[PDF Translator] Translation failed:', err);
      new Notice(`Translation failed: ${err?.message || err}`, 8000);
      this.lastRunDegraded = true;
      return units.map(u => u.text);
    }
  }

  // The chunked / sequential / extraction methods below are unchanged
  // from the previous version — they only consume the TranslationUnit[]
  // list produced by prepareTranslationUnits. They are kept here so the
  // plugin can still handle large pages, but they do NOT alter paragraph
  // boundaries from the pipeline.

  /**
   * T2.1: THE unified translation orchestrator (all callers share this core).
   *
   * Contract: returns EXACTLY `texts.length` strings, aligned 1:1 with the
   * input — one translation per input text, regardless of internal
   * pre-splitting/chunking. This contract is what the old
   * `translateTextsWithChunking` documented but VIOLATED (P0-1: pre-split
   * long texts into N segments and returned one translation per SEGMENT,
   * shifting every subsequent translation of the page onto the wrong
   * paragraph in the headless/python path).
   *
   * Pipeline:
   *   1. Pre-split texts longer than `maxBatchChars − 20` into sentence
   *      groups, remembering each segment's ORIGIN index.
   *   2. Pack segments into ≤ maxBatchChars chunks ([#N]-numbered).
   *   3. translateBatch + extractNumberedLinesRobust per chunk; per-chunk
   *      failure falls back to that chunk's ORIGINAL SEGMENT TEXTS (not
   *      silently shifted translations).
   *   4. Re-join each origin's segment translations back into one string.
   *   5. restoreStructure-style marker restoration happens in the caller.
   *
   * Cancellation (T1.2): checks ONLY the caller-supplied token — never the
   * global background-queue flag (the old shared checks cancelled manual
   * translations whenever the queue had been paused — see T1.1/T1.2).
   */
  public async translateSegments(
    texts: string[],
    opts?: { isCancelled?: CancelToken; onProgress?: (done: number, total: number) => void },
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    this.lastRunDegraded = false;

    const maxBatchChars = this.plugin.settings.maxBatchChars ?? 4000;
    const UNIT_OVERHEAD = 20;

    // ── Step 1: pre-split oversized texts, tracking origin indices ──
    const segments: string[] = [];
    const originOf: number[] = [];   // segments[i] belongs to texts[ originOf[i] ]
    for (let t = 0; t < texts.length; t++) {
      const text = texts[t];
      if (text.length + UNIT_OVERHEAD > maxBatchChars) {
        const parts = this.splitLongTextBySentences(text, maxBatchChars - UNIT_OVERHEAD);
        for (const p of parts) {
          segments.push(p);
          originOf.push(t);
        }
      } else {
        segments.push(text);
        originOf.push(t);
      }
    }

    // ── Step 2: pack segments into ≤ maxBatchChars chunks ──
    const charChunks: string[][] = [];
    let current: string[] = [];
    let currentSize = 0;
    for (const seg of segments) {
      const size = seg.length + UNIT_OVERHEAD;
      if (currentSize + size > maxBatchChars && current.length > 0) {
        charChunks.push(current);
        current = [];
        currentSize = 0;
      }
      current.push(seg);
      currentSize += size;
    }
    if (current.length > 0) charChunks.push(current);

    if (charChunks.length > 1) {
      new Notice(`Translating in ${charChunks.length} batches...`, 3000);
    }

    // ── Step 3: translate chunks sequentially (order preserved) ──
    const segmentTranslations: string[] = new Array(segments.length);
    const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
    let segCursor = 0;
    for (let i = 0; i < charChunks.length; i++) {
      if (tokenCancelled(opts?.isCancelled)) {
        throw new Error('cancelled');
      }
      const chunk = charChunks[i];
      const originTextsOfChunk = chunk; // chunk[k] IS the origin segment text (pre-split piece)
      try {
        const chunkText = chunk.map((t, j) => `[#${j + 1}] ${t}`).join('\n');
        if (this.plugin.settings.debugMode) {
          console.log(`[Chunk ${i + 1}/${charChunks.length} Input]:\n${chunkText.substring(0, 200)}...`);
        }
        const raw = await this.plugin.translation.translateBatch(chunkText, chunk.length);
        const lines = await this.extractNumberedLinesRobust(raw, chunk.length, originTextsOfChunk);
        for (let k = 0; k < chunk.length; k++) {
          segmentTranslations[segCursor + k] = lines[k];
        }
        if (charChunks.length > 1) {
          new Notice(`Batch ${i + 1}/${charChunks.length} complete.`, 2000);
        }
      } catch (err) {
        if (err?.message === 'cancelled') throw err;
        // Per-chunk failure: fall back to THIS chunk's original segments.
        // (The old code pushed the raw chunk texts too, but the pre-split
        // misalignment above made even that wrong — P0-1.)
        console.error(
          `[translateSegments] chunk ${i + 1}/${charChunks.length} failed, falling back to originals:`,
          err,
        );
        new Notice(
          `Batch ${i + 1}/${charChunks.length} failed — using original text. ` +
          `Error: ${err?.message?.substring(0, 60) || err}`,
          5000,
        );
        this.lastRunDegraded = true;
        for (let k = 0; k < chunk.length; k++) {
          segmentTranslations[segCursor + k] = chunk[k];
        }
      }
      segCursor += chunk.length;
      opts?.onProgress?.(Math.min(segCursor, segments.length), segments.length);
      if (i < charChunks.length - 1 && delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // ── Step 4: re-join each origin's segments (1:1 with input texts) ──
    const byOrigin: string[][] = Array.from({ length: texts.length }, () => []);
    for (let s = 0; s < segments.length; s++) {
      byOrigin[originOf[s]].push(segmentTranslations[s] ?? segments[s]);
    }
    return byOrigin.map(parts => parts.join(' ').replace(/[ \t]+/g, ' ').trim());
  }

  /**
   * Back-compat wrapper (headless/python path). Now a pure delegate to the
   * unified orchestrator — the historical 1:1-alignment bug (P0-1) is fixed
   * INSIDE translateSegments, so this signature keeps working for callers
   * that hold plain string arrays.
   */
  public async translateTextsWithChunking(
    texts: string[],
    opts?: { isCancelled?: CancelToken },
  ): Promise<string[]> {
    return this.translateSegments(texts, { isCancelled: opts?.isCancelled });
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

  private async performSequentialTranslation(units: TranslationUnit[], cancelToken?: CancelToken): Promise<string[]> {
    const results: string[] = [];
    const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
    const maxChars = this.plugin.settings.maxBatchChars;

    for (let i = 0; i < units.length; i++) {
      // T1.2: cancellation is checked via the CALLER-OWNED token only. The
      // old global `plugin.pdfLayoutQueue?.isCancelled?.()` probe here is
      // what made every manual translation die with "Error: cancelled"
      // after the queue flag got poisoned at plugin startup (see T1.1).
      if (tokenCancelled(cancelToken)) {
        throw new Error('cancelled');
      }
      try {
        // Oversized single unit: route through the unified orchestrator
        // (T2.1) — it pre-splits by sentences, chunks, and re-joins with a
        // guaranteed 1:1 mapping, replacing the parallel implementation
        // translateOversizedUnit that was removed in this overhaul.
        if (units[i].text.length > maxChars) {
          const translated = await this.translateSegments([units[i].text], { isCancelled: cancelToken });
          results.push(translated[0] ?? units[i].text);
        } else {
          // FIX: TranslationEngine has only translateBatch() and translateWithOpenRouter().
          // The previous call to .translate() always threw TypeError, was caught
          // silently, and returned the original text — masking the failure.
          const text = await this.plugin.translation.translateWithOpenRouter(units[i].text);
          results.push(text);
        }
      } catch (err) {
        if (err?.message === 'cancelled') throw err;
        console.error(`Segment ${i + 1} failed:`, err);
        this.lastRunDegraded = true;
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
        // T5.3 (table support): line structure of a translation is now
        // PRESERVED through this parser. Multi-line content is joined
        // with '\n' (not ' '), and `<br>` tags from the model's echo are
        // KEPT — the caller (executeTranslation) applies the per-segment
        // policy (isTableLikeText / preserveSourceLineBreaks) and either
        // keeps the structure or collapses it. Previously this stripped
        // <br> and space-joined everything, flattening table rows.
        const trimmed = currentText
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
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
        // Continuation line — append to current segment, PRESERVING the
        // model's line break as '\n' (see flushCurrent note above).
        if (currentIdx >= 0) {
          currentText += '\n' + line.trim();
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
      const orig = units[i]?.text || '';
      // Preserve leading numbering/bullets that may have been stripped.
      // T5.3: whitespace cleanup is intentionally NOT done here anymore —
      // the per-segment line-break policy in executeTranslation (collapse
      // vs preserve) owns it, and table-like segments must keep <br>/\n.
      const firstLine = line.split(/\r?\n/)[0] ?? line;
      const origLead = orig.match(/^\s*(\d+[\.\)]\s*|[-•*]\s*|#\s*)/);
      if (origLead && !firstLine.match(/^\s*(\d+[\.\)]\s*|[-•*]\s*|#\s*)/)) {
        return origLead[1] + line;
      }
      return line;
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
          try {
            // T2.5: single construction site (id + engine stamped inside).
            return makeOverlay({
              page: pageNumber,
              rect: { left: extRect.l, top: extRect.t, width: extRect.w, height: extRect.h },
              text: unit.text,
              translated: translatedLines[index] || unit.text,
              fontFamily: extFont?.family,
              fontSize: extFont?.size,
              originalFontSizes: extFont?.sizes || [],
              engine: getCurrentEngine(this.plugin),
            });
          } catch {
            return null; // invalid rect — skip this unit (factory invariant)
          }
        })
        .filter((x): x is OverlayPositionData => x !== null);

      this.plugin.overlay.renderSavedOverlay(overlayData, pageNumber);

      if (this.plugin.settings.autoSaveOverlay && activeFile && !this.lastRunDegraded) {
        this.plugin.storage
          .updatePageOverlaysAndWrite(activeFile, { [pageNumber]: overlayData }, { replace: true })
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
    // VERIFICATION FIX (user-requested audit): the old `/^\d{1,3}$/` test
    // dropped EVERY standalone 1-3 digit span — including numbers that
    // pdf.js emits as separate spans MID-SENTENCE ("Figure [123] shows…").
    // Those digits were silently deleted from the translated text. Page
    // numbers are now handled the same way on every path: the layout
    // pipeline gives them their own spatially-isolated paragraph and the
    // paragraph-filter rule `^\d{1,4}$` (whole-text anchored, see
    // paragraph-filter.ts) keeps them out of the LLM call.
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
