// headless-translate.ts
// ─────────────────────────────────────────────────────────────────────────
// Background (no open viewer) PDF → .translations.md translation.
//
// This works ONLY via the python layout engine: layout_engine.py (PyMuPDF)
// extracts text + coordinates straight from the file on disk, so nothing needs
// to be rendered in a tab. The internal/OCR engines can't do this because they
// read the live PDF.js DOM.
//
// Pipeline (entirely headless):
//   generateLayout(pdf)  →  per-page items {text, rect, font}
//   translate each item's text (batched, index-aligned)
//   build OverlayPositionData[] per page  (rect → relativeRect, with guards)
//   storage.writeSavedOverlayForFile(...)  →  <pdf>.translations.md
// ─────────────────────────────────────────────────────────────────────────

import { Notice, TFile } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';
// P0-1 (Phase 1): static import replaces runtime `require('./paragraph-filter')`,
// which throws `ReferenceError: require is not defined` on mobile (Obsidian's
// mobile runtime has no CommonJS shim). The background watcher path runs on
// mobile too, so this was crashing every auto-enqueued watcher job there.
import { compileRules, filterParagraphs } from './paragraph-filter';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Stamped on
// every headless-translated overlay so the saved result has an id matching
// what the DOM-extraction and queue paths produce for the same source
// paragraph — enables merge-by-id-first in updatePageOverlaysAndWrite and
// exact lookup in the edit modal.
import { generateOverlayId, getCurrentEngine } from './overlay-id';

export interface HeadlessResult {
    ok: boolean;
    pages: number;
    segments: number;
    error?: string;
}

export class HeadlessTranslator {
    private plugin: OpenRouterTranslatorPlugin;
    private cancelled = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    cancel() {
        this.cancelled = true;
        // P1-1 (Phase 9): propagate to the shared layout queue so that
        // performChunkedTranslation / performSequentialTranslation /
        // translateTextsWithChunking — all of which gate on
        // `pdfLayoutQueue.isCancelled()` between chunks — break out within
        // ~one chunk of LLM latency instead of draining every remaining
        // chunk for the in-flight page. Without this, headless Cancel had
        // to wait for the entire current page (often 25-30s) before taking
        // effect, since the per-page `this.cancelled` flag is only checked
        // between page-level concurrency chunks, not between LLM chunks.
        this.plugin.pdfLayoutQueue?.cancel?.();
    }

    /** Preconditions for headless mode (python engine + script + interpreter). */
    canRun(): { ok: boolean; reason?: string } {
        const s = this.plugin.settings;
        if (s.layoutEngine !== 'python') {
            return { ok: false, reason: 'Background translation requires the Python layout engine.' };
        }
        if (!s.pythonPath || !s.ocrScriptPath) {
            return { ok: false, reason: 'Set the Python interpreter and layout script path in settings.' };
        }
        return { ok: true };
    }

    private validRect(r: { l: number; t: number; w: number; h: number }): boolean {
        const { l, t, w, h } = r || ({} as any);
        return [l, t, w, h].every(Number.isFinite) &&
            w > 0.001 && h > 0.001 && l >= -0.01 && t >= -0.01 && l <= 1.01 && t <= 1.01;
    }

    /**
     * Translate one PDF headlessly and write its .translations.md.
     * Skips files that already have a translation unless force=true.
     *
     * FIX E1 (incremental save): previously this method accumulated ALL
     * pages in a single `pageOverlays` object and wrote the file ONCE at
     * the end via `writeSavedOverlayForFile`. If the process crashed mid-way
     * (or the user cancelled), ALL translated pages were lost.
     *
     * Now: each successfully-translated page is persisted immediately via
     * `updatePageOverlaysAndWrite` (read-modify-write merge). A crash only
     * loses the in-flight page; all previously-saved pages are on disk.
     *
     * FIX H-1: Previously this method processed pages strictly sequentially.
     * The `backgroundTranslationConcurrency` setting was being ignored in the
     * headless path — it was only honoured by the internal-engine PdfLayoutQueue.
     * Now we run N page-translation tasks in parallel (default 3), where N is
     * `plugin.settings.backgroundTranslationConcurrency` clamped to 1–8.
     *
     * Layout extraction itself stays sequential (PyMuPDF can't be safely called
     * in parallel from the same script instance), but the LLM calls — which
     * dominate wall-clock time — run concurrently.
     */
    async translateFile(pdf: TFile, opts: { force?: boolean; silent?: boolean } = {}): Promise<HeadlessResult> {
        this.cancelled = false;
        // Phase 11 (fix Phase 9 regression): the previous `cancel()` call (from
        // Pause/Cancel UI or watcher.stop()) also flipped
        // `pdfLayoutQueue.cancelled = true` via `cancelRunning()` →
        // `HeadlessTranslator.cancel()` → `pdfLayoutQueue.cancel()`. Without
        // an explicit `resume()` here, the very next `translateFile` call would
        // hit `pdfLayoutQueue.isCancelled()` checks inside the shared
        // `performChunkedTranslation` / `performSequentialTranslation` /
        // `translateTextsWithChunking` utilities and fail-fast with a misleading
        // "cancelled" error — even though the user had just started a fresh
        // translation. `resume()` is a guarded no-op if the queue wasn't
        // cancelled, so this is always safe to call.
        this.plugin.pdfLayoutQueue?.resume?.();
        const pre = this.canRun();
        if (!pre.ok) return { ok: false, pages: 0, segments: 0, error: pre.reason };

        // Don't redo existing work unless asked.
        if (!opts.force) {
            const existing = await this.plugin.storage.findTranslationFileForPdf(pdf).catch(() => null);
            if (existing) return { ok: true, pages: 0, segments: 0, error: 'already translated' };
        }

        // FIX H4: use PdfLayoutQueue.withFileLock to serialize with interactive translation.
        // Without this, headless (watcher) and interactive translation on the same PDF
        // would race on .translations.md writes, potentially losing data.
        return this.plugin.pdfLayoutQueue.withFileLock(pdf.path, async () => {
            return this._translateFileLocked(pdf, opts);
        });
    }

    private async _translateFileLocked(pdf: TFile, opts: { force?: boolean; silent?: boolean } = {}): Promise<HeadlessResult> {
        // 1) Headless layout extraction (PyMuPDF, no DOM) — sequential.
        this.plugin.processor.externalLayoutService.clearCache(pdf.path);
        const layout = await this.plugin.processor.externalLayoutService.generateLayout(pdf);
        if (!layout) return { ok: false, pages: 0, segments: 0, error: 'layout extraction failed' };
        if (this.cancelled) return { ok: false, pages: 0, segments: 0, error: 'cancelled' };

        // 2) Translate pages in parallel (LLM calls dominate wall-clock time).
        const concurrency = Math.max(1, Math.min(8, this.plugin.settings.backgroundTranslationConcurrency || 3));

        // Build a list of (pageNum, usable items) pairs to translate.
        const pageNumbers = Object.keys(layout).map(Number).sort((a, b) => a - b);
        const work: Array<{ pageNum: number; usable: any[] }> = [];
        for (const pageNum of pageNumbers) {
            const items = layout[String(pageNum)] || [];
            const usable = items.filter((it: any) => it.text?.trim() && this.validRect(it.rect));
            if (usable.length > 0) work.push({ pageNum, usable });
        }

        if (work.length === 0) {
            return { ok: false, pages: 0, segments: 0, error: 'no translatable text (is this a scan? use OCR)' };
        }

        let pageCount = 0;
        let segCount = 0;
        let lastNoticeAt = 0;

        // Process work items in parallel chunks of size `concurrency`.
        // Each chunk awaits all its tasks before starting the next chunk.
        const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
        for (let i = 0; i < work.length; i += concurrency) {
            if (this.cancelled) break;

            const chunk = work.slice(i, i + concurrency);
            const results = await Promise.allSettled(chunk.map(async ({ pageNum, usable }) => {
                // Stage 2.4: apply paragraph filter rules. Paragraphs matching
                // a filter rule are NOT sent to the LLM — they use their
                // original text as the "translation". This saves API costs on
                // page numbers, single letters, etc.
                let translatableUsable = usable;
                const skippedByFilter = new Set<number>();  // indices into `usable`
                const filterRules = this.plugin.settings.paragraphFilterRules;
                if (filterRules && filterRules.length > 0) {
                    const compiled = compileRules(filterRules);
                    if (compiled.length > 0) {
                        const texts = usable.map((u: any) => u.text);
                        const { translatable, skipped } = filterParagraphs(texts, compiled);
                        if (skipped.size > 0) {
                            translatableUsable = translatable.map(i => usable[i]);
                            for (const [localIdx] of skipped) {
                                skippedByFilter.add(localIdx);
                            }
                        }
                    }
                }

                // If all paragraphs were filtered, skip LLM call entirely.
                if (translatableUsable.length === 0) {
                    const overlays: OverlayPositionData[] = usable.map((it: any) => ({
                        selector: '',
                        textContent: it.text,
                        relativeRect: { left: it.rect.l, top: it.rect.t, width: it.rect.w, height: it.rect.h },
                        page: pageNum,
                        translatedText: it.text,
                        fontSize: it.fontSize,
                        fontFamily: it.fontFamily,
                        originalFontSizes: it.originalFontSizes || [],
                        // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
                        id: generateOverlayId(pageNum,
                            { left: it.rect.l, top: it.rect.t, width: it.rect.w, height: it.rect.h },
                            it.text || ''),
                        // Phase 8 (V4 Schema): engine stamp. Filter-skipped
                        // paragraphs fall back to their original text (no LLM
                        // call), but the file-level engine still reflects
                        // "this file was processed by the current engine" —
                        // and a per-overlay stamp lets future
                        // stale-engine-detection distinguish "skipped by
                        // filter" from "actually translated".
                        engine: getCurrentEngine(this.plugin),
                    }));
                    if (overlays.length > 0) {
                        await this.plugin.storage.updatePageOverlaysAndWrite(pdf, { [pageNum]: overlays });
                    }
                    return { pageNum, count: overlays.length };
                }

                // Batch-translate this page's segments, index-aligned.
                // FIX H2: use the shared chunking utility instead of a direct
                // `translateBatch(fullText, count)` call. Previously this path
                // sent an entire page (potentially 10K+ chars) in a single API
                // call — on small-context providers (e.g. Ollama at 4K) that
                // exceeded the context window and silently fell back to
                // originals. The utility splits by `maxBatchChars` + provider
                // `contextWindow`, translates chunks sequentially while
                // preserving order, and absorbs per-chunk failures internally
                // (failed chunks revert to originals; other chunks still
                // return their translations). The outer try/catch below now
                // only triggers on catastrophic failure (all chunks failed,
                // network down, or `cancelled` thrown between chunks).
                let translated: string[];
                let translationFailed = false;
                let failureReason = '';
                try {
                    const translatableTexts = translatableUsable.map((u: any) => u.text);
                    translated = await this.plugin.processor.translateTextsWithChunking(translatableTexts);
                } catch (e: any) {
                    // Fall back to originals for this page rather than aborting the file.
                    translationFailed = true;
                    failureReason = e?.message ?? String(e);
                    console.warn(`[HeadlessTranslator] page ${pageNum} translation failed, using original text:`, failureReason);
                    translated = translatableUsable.map((u: any) => u.text);
                }

                // FIX E3: filter out overlays with neither original text nor translation.
                // This prevents creating empty-ot overlays that trigger parser bugs.
                //
                // Phase 15.5: the previous `[⚠ untranslated] ` marker prefix has been
                // REMOVED — it leaked into the rendered overlay and into the
                // persisted .translations.md, where the leading `[` made the
                // first line look like a Markdown task-list item and broke some
                // downstream parsers. The fallback to original text is still
                // preserved below; only the visible marker is gone. A Notice
                // (Phase 15.6) tells the user the page fell back.
                if (translationFailed) {
                    new Notice(
                        `[p${pageNum}] Translation failed: ${failureReason.length > 80 ? failureReason.substring(0, 77) + '...' : failureReason}\n` +
                        `Translation completed. Some pages fell back to original text.`,
                        8000,
                    );
                }

                // Stage 2.4: build overlays for ALL usable items (translatable +
                // filter-skipped). Translatable items get the LLM translation;
                // filter-skipped items get their original text.
                const overlays: OverlayPositionData[] = [];
                for (let idx = 0; idx < usable.length; idx++) {
                    const it = usable[idx];
                    const orig = (it.text || '').trim();
                    if (!orig) continue;  // skip empty

                    let tr: string;
                    if (skippedByFilter.has(idx)) {
                        // Filter-skipped paragraph — use original text
                        tr = orig;
                    } else {
                        // Translated paragraph — find its position in the
                        // translatableUsable array to get the right translation.
                        const transIdx = translatableUsable.indexOf(it);
                        tr = (translated[transIdx] || '').trim();
                    }

                    overlays.push({
                        selector: '',
                        textContent: it.text,
                        relativeRect: { left: it.rect.l, top: it.rect.t, width: it.rect.w, height: it.rect.h },
                        page: pageNum,
                        // Phase 15.5: no failure marker — store the translation
                        // (or fall back to original text) as-is.
                        translatedText: tr || it.text,
                        fontSize: it.fontSize,
                        fontFamily: it.fontFamily,
                        originalFontSizes: it.originalFontSizes || [],
                        // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
                        // Matches the id produced by overlay.ts extractPositionDataFrom
                        // and pdf-layout-queue.ts buildOverlayData for the same source
                        // paragraph — enables merge-by-id-first in updatePageOverlaysAndWrite.
                        id: generateOverlayId(pageNum,
                            { left: it.rect.l, top: it.rect.t, width: it.rect.w, height: it.rect.h },
                            it.text || ''),
                        // Phase 8 (V4 Schema): engine stamp from current provider/model.
                        // Headless path runs through the same TranslationEngine
                        // as interactive translation, so current settings match.
                        engine: getCurrentEngine(this.plugin),
                    });
                }

                // FIX E1: incremental save via updatePageOverlaysAndWrite (read-modify-write).
                // Previously: accumulated all pages and wrote once at end → crash = total loss.
                // Now: each page is persisted immediately; crash only loses the in-flight page.
                if (overlays.length > 0) {
                    await this.plugin.storage.updatePageOverlaysAndWrite(pdf, { [pageNum]: overlays });
                }

                return { pageNum, count: overlays.length };
            }));

            // Collect results (in chunk order, which preserves overall page order
            // since chunks are processed left-to-right).
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    pageCount++;
                    segCount += r.value.count;
                } else {
                    // Should not happen — extractNumberedLines / fallback above
                    // catches its own errors. But if something escaped, log it.
                    console.error('[HeadlessTranslator] chunk task rejected:', r.reason);
                }
            }

            // Throttle notices to one per 1.5s so big PDFs don't spam the UI.
            const now = Date.now();
            if (!opts.silent && now - lastNoticeAt > 1500) {
                lastNoticeAt = now;
                new Notice(`[bg] ${pdf.basename}: ${pageCount}/${work.length} pages`, 1500);
            }

            // FIX: respect sequentialDelayMs between page chunks (rate-limit friendly).
            // When concurrency > 1, pages within a chunk run in parallel — the delay
            // applies BETWEEN chunks (sequential), not within. When concurrency = 1,
            // this effectively adds delay between every page.
            if (i + concurrency < work.length && delayMs > 0) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }

        if (pageCount === 0) {
            return { ok: false, pages: 0, segments: 0, error: 'no translatable text (is this a scan? use OCR)' };
        }

        // FIX E1: file was already saved incrementally — no final write needed.
        return { ok: true, pages: pageCount, segments: segCount };
    }
}
