// reprocessor.ts
import { App, Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { OverlayPositionData, SavedOverlay } from './types';
import { LayoutResult } from './layout-detector';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Stamped on
// every reprocessed overlay so the saved result has an id that matches what
// the DOM-extraction and queue paths produce for the same source paragraph —
// enables merge-by-id-first in updatePageOverlaysAndWrite.
import { generateOverlayId, getCurrentEngine } from './overlay-id';

/**
 * RegionReprocessor
 *
 * Enables Shift + drag to select a region on a PDF.
 * REFACTORED: Now uses the main TextProcessor for all layout analysis and
 * translation, ensuring consistency and reducing code duplication. Its sole
 * responsibilities are to capture the user's selection, delegate processing,
 * and then merge the results back into the saved overlay data.
 */
export class RegionReprocessor {
    private isDragging = false;
    private dragStart: { x: number; y: number } | null = null;
    private box: HTMLDivElement | null = null;
    private readonly plugin: OpenRouterTranslatorPlugin;
    // P0-3c (R-5): `debug` was captured at construction time, so toggling
    // `debugMode` later had no effect. It is now a getter that reads from
    // settings on every access.
    private cleanup = new Set<() => void>();
    private isActive = false;
    private frameId: number | null = null;
    private debugGuides = new Set<HTMLElement>();

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    /** P0-3c: dynamic debug flag — reflects current settings. */
    private get debug(): boolean {
        return this.plugin.settings.debugMode;
    }

    /**
     * Starts a new reprocessing session.
     */
    public start(): void {
        if (this.isActive) {
            // P0-3a (R-2): previously called `cleanupAll()` which removes
            // listeners and clears the cleanup set but does NOT reset
            // `isActive`. The previous session's `run()` was still awaiting
            // events from listeners that were just removed — a zombie Promise
            // hung forever. Calling `finish()` properly cancels the previous
            // session before starting a new one.
            new Notice('Canceling previous reprocessing session.');
            this.finish();
        }
        this.isActive = true;
        // P0-3c: catch any rejection so it doesn't surface as an unhandled
        // promise rejection in the console (was `void this.run()`).
        void this.run().catch(err => {
            console.error('[RegionReprocessor] run() failed:', err);
            this.finish();
        });
    }

    /**
     * Sets up drag-to-select event listeners on the current PDF page.
     */
    private async run(): Promise<void> {
        const { app, settings } = this.plugin;
        if (this.debug) {
            console.log('[RegionReprocessor] Starting – waiting for Shift+drag...');
        }
        if (!settings.enableTranslation) {
            new Notice('PDF translation is disabled in settings.');
            this.finish();
            return;
        }
        const file = app.workspace.getActiveFile();
        if (!file || file.extension !== 'pdf') {
            new Notice('Please open a PDF file first.');
            this.finish();
            return;
        }
        const pageNumber = this.plugin.getCurrentPageNumber();
        if (!pageNumber) {
            new Notice('No page currently visible.');
            this.finish();
            return;
        }
        const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
        if (!pageEl) {
            new Notice('Page is not rendered. Please scroll into view.');
            this.finish();
            return;
        }
        const textLayer = pageEl.querySelector<HTMLElement>('.textLayer');
        if (!textLayer) {
            new Notice('Text layer not ready. Please wait for PDF to render.');
            this.finish();
            return;
        }
        new Notice('🔤 Hold Shift + drag to reprocess a region', 3000);

        const registerListener = (target: EventTarget, type: string, handler: EventListener) => {
            const cleanup = () => target.removeEventListener(type, handler);
            this.cleanup.add(cleanup);
            target.addEventListener(type, handler);
        };

        const onMouseDown = (e: MouseEvent) => {
            if (!e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            if (this.isDragging) return;
            this.isDragging = true;
            // P2-69 (Phase 12): restart the 15s timer when the user actually
            // starts dragging. Previously the timer set in `run()` would fire
            // mid-drag (15s after the user entered shift+drag mode, even if
            // they were still actively selecting), aborting the selection
            // mid-flight. The timer is extended on every mousemove below.
            resetSelectionTimeout();
            this.dragStart = { x: e.clientX, y: e.clientY };
            this.box?.remove();
            this.box = createEl('div', { cls: 'pdf-translation-selection-box' });
            Object.assign(this.box.style, {
                position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
                border: '2px dashed rgba(0, 120, 255, 0.8)', background: 'rgba(0, 120, 255, 0.1)',
                pointerEvents: 'none', zIndex: '99999', boxSizing: 'border-box', borderRadius: '2px',
                boxShadow: '0 0 6px rgba(0, 0, 0, 0.2)', transform: 'translateZ(0)', willChange: 'transform',
            });
            document.body.appendChild(this.box);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!this.isDragging || !this.dragStart || !this.box) return;
            // P2-69 (Phase 12): extend the timer while the user is actively
            // dragging so a slow selection (>15s) is never aborted mid-drag.
            resetSelectionTimeout();
            // Phase 15.2 (C16): value-capture pattern. `cleanupAll()` can run
            // between the rAF schedule and the frame firing (e.g. on Escape),
            // nulling `this.dragStart` and removing `this.box`. Capturing
            // both into locals and re-checking `isDragging` inside the
            // callback prevents dereferencing a stale `null` and also stops
            // us from mutating a detached DOM node.
            const start = this.dragStart;  // capture value
            const box = this.box;          // capture value
            e.preventDefault();
            if (this.frameId !== null) return;
            this.frameId = window.requestAnimationFrame(() => {
                this.frameId = null;
                if (!this.isDragging) return;  // re-check after rAF
                const { clientX, clientY } = e;
                const { x: startX, y: startY } = start;  // use captured value
                const left = Math.min(startX, clientX);
                const top = Math.min(startY, clientY);
                const width = Math.abs(clientX - startX);
                const height = Math.abs(clientY - startY);
                box.style.transform = `translate(${left}px, ${top}px)`;
                box.style.width = `${width}px`;
                box.style.height = `${height}px`;
            });
        };

        const onMouseUp = (e: MouseEvent) => {
            if (!this.isDragging) return;
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = false;
            // P2-69 (Phase 12): clear the timer explicitly so a slow mouseup
            // (or a no-op tiny-drag cancel) doesn't fire the timeout notice
            // moments after the drag already ended. `cleanupAll()` below also
            // runs the cleanup-set clear, but being explicit avoids ordering
            // surprises if a future caller invokes onMouseUp without going
            // through cleanupAll (e.g. escape-cancellation path).
            clearSelectionTimeout();
            if (this.frameId !== null) {
                cancelAnimationFrame(this.frameId);
                this.frameId = null;
            }
            const rect = new DOMRect(
                Math.min(this.dragStart!.x, e.clientX),
                Math.min(this.dragStart!.y, e.clientY),
                Math.abs(e.clientX - this.dragStart!.x),
                Math.abs(e.clientY - this.dragStart!.y)
            );
            this.cleanupAll();
            if (rect.width > 5 && rect.height > 5) {
                // P0-3c: catch rejections so they don't surface as unhandled
                // promise rejections (was `void this.handleRegionReprocessing(...)`).
                void this.handleRegionReprocessing(rect, pageNumber, file).catch(err => {
                    console.error('[RegionReprocessor] handleRegionReprocessing failed:', err);
                    new Notice(`❌ Region reprocessing failed: ${err?.message ?? err}`);
                    this.finish();
                });
            } else {
                this.finish();
            }
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                new Notice('Region selection canceled.');
                this.cleanupAll();
                this.finish();
            }
        };

        registerListener(pageEl, 'mousedown', onMouseDown);
        registerListener(document, 'mousemove', onMouseMove);
        registerListener(document, 'mouseup', onMouseUp);
        registerListener(document, 'keydown', onKeyDown);

        // P2-69 (Phase 12): the 15s idle-timeout is now mutable so it can be
        // cleared/extended by onMouseDown / onMouseMove / onMouseUp. Originally
        // it was a single `const` set once at session start, which fired
        // mid-drag if the user spent >15s selecting.
        const SELECTION_TIMEOUT_MS = 15000;
        let selectionTimeoutId: number | null = window.setTimeout(() => {
            if (this.isActive) {
                new Notice('Region selection timed out.', 2000);
                this.cleanupAll();
                this.finish();
            }
        }, SELECTION_TIMEOUT_MS);
        const clearSelectionTimeout = () => {
            if (selectionTimeoutId !== null) {
                clearTimeout(selectionTimeoutId);
                selectionTimeoutId = null;
            }
        };
        const resetSelectionTimeout = () => {
            if (selectionTimeoutId !== null) {
                clearTimeout(selectionTimeoutId);
            }
            selectionTimeoutId = window.setTimeout(() => {
                if (this.isActive) {
                    new Notice('Region selection timed out.', 2000);
                    this.cleanupAll();
                    this.finish();
                }
            }, SELECTION_TIMEOUT_MS);
        };
        this.cleanup.add(clearSelectionTimeout);
    }

    /**
     * REFACTORED: Processes the selected region by delegating paragraph detection
     * and translation to the main TextProcessor, then handles saving the results.
     * Calculates original font sizes correctly based on the current viewer scale.
     */
    private async handleRegionReprocessing(
        screenRect: DOMRect,
        pageNumber: number,
        file: TFile
    ): Promise<void> {
        // P1-21 (Phase 12): warn if a background translation worker is
        // currently active on the same vault. We don't abort — the user may
        // intentionally want to override the worker's pending output for
        // this page — but we surface the conflict so they can decide
        // whether to wait for the worker to drain first.
        if (this.plugin.pdfLayoutQueue?.isRunning?.()) {
            new Notice('Background translation in progress. Wait or cancel first.', 5000);
            // Don't abort — let user decide. Just warn.
        }

        const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
        const textLayer = pageEl?.querySelector<HTMLElement>('.textLayer');
        if (!pageEl || !textLayer) {
            new Notice('⚠️ Page or text layer not available.');
            this.finish();
            return;
        }

        // Step 1: Filter spans based on selection (Reprocessor's unique job)
        const selectedSpans = Array.from(textLayer.querySelectorAll<HTMLSpanElement>('span'))
            .filter(span => {
                const r = span.getBoundingClientRect();
                const overlaps = !(r.right < screenRect.left || r.left > screenRect.right || r.bottom < screenRect.top || r.top > screenRect.bottom);
                return overlaps;
            })
            .filter(span => this.plugin.processor.isValidSpan(span));

        if (selectedSpans.length === 0) {
            new Notice('⚠️ No valid text found in selected region.');
            this.finish();
            return;
        }

        // Step 2: Delegate processing and translation to the main TextProcessor
        // P0-3 (R-1): CRITICAL — `prepareTranslationUnits` is async and returns
        // Promise<TranslationUnit[]>. The missing `await` meant `translationUnits`
        // was a Promise, `translationUnits.length` was `undefined`, the guard
        // `=== 0` never fired, the Notice printed "Translating undefined segment(s)",
        // and `executeTranslation(translationUnits)` crashed inside `units.map(...)`
        // with `TypeError: units.map is not a function`. Region Reprocessing
        // was completely broken.
        // Phase 15.1: pass `forceFresh: true` so reprocessing never serves a
        // stale cached layout for the selected spans — the user explicitly
        // asked to re-detect & re-translate this region.
        const translationUnits = await this.plugin.processor.prepareTranslationUnits(selectedSpans, pageEl, true);
        if (!translationUnits || translationUnits.length === 0) {
            new Notice('No translatable segments found in the selected region.');
            this.finish();
            return;
        }
        new Notice(`🔁 Translating ${translationUnits.length} segment(s)...`, 3000);

        let translatedTexts: string[];
        try {
            translatedTexts = await this.plugin.processor.executeTranslation(translationUnits);
        } catch (err: any) {
            console.error('[RegionReprocessor] Translation failed:', err);
            new Notice(`❌ Translation failed: ${err.message}. Using original text.`);
            translatedTexts = translationUnits.map(u => u.text); // Fallback to original text
        }

        // Step 3: Generate overlay data for saving (Reprocessor's unique job)
        const newItems: OverlayPositionData[] = [];

        // --- CORRECTED FONT SIZE CALCULATION ---
        // Get the current scale factor from the PDF viewer container *at the time of selection*.
        const pdfViewer = pageEl.closest('.pdfViewer, #viewer') as HTMLElement | null;
        // P0-3b (R-3): previously the NaN/<=0 branch only warned and continued
        // — every subsequent font-size computation became NaN (since
        // `observed / NaN = NaN`) and was persisted to `.translations.md`.
        // Now we actually fall back to 1.0 so downstream math stays finite.
        let currentScaleFromViewer = parseFloat(pdfViewer?.style.getPropertyValue('--scale-factor') || '1');
        if (isNaN(currentScaleFromViewer) || currentScaleFromViewer <= 0) {
            console.warn('[RegionReprocessor] Invalid scale factor, falling back to 1.0');
            currentScaleFromViewer = 1.0;
        }
        // --- END CORRECTED FONT SIZE CALCULATION ---

        for (let i = 0; i < translationUnits.length; i++) {
            const { originalSpans, text } = translationUnits[i];
            if (originalSpans.length === 0) continue;

            // Use processor.getSpansBbox which returns scaled values relative to the page element
            const bboxResult = this.plugin.processor.getSpansBbox(originalSpans, pageEl);
            if (!bboxResult || !bboxResult.rect) continue;

            const rawBbox = bboxResult.rect; // This is already scaled relative to pageEl's current transform

            // Calculate relative rect based on the *current* page dimensions (affected by scale)
            const pageRect = pageEl.getBoundingClientRect(); // This is the *scaled* page rect
            const relativeRect = {
                left: rawBbox.left / pageRect.width, // rawBbox.left is relative to pageEl's content (scaled)
                top: rawBbox.top / pageRect.height,  // rawBbox.top is relative to pageEl's content (scaled)
                width: rawBbox.width / pageRect.width,
                height: rawBbox.height / pageRect.height,
            };

            if (Object.values(relativeRect).some(v => !isFinite(v)) || relativeRect.width <= 0 || relativeRect.height <= 0) {
                console.debug('[RegionReprocessor] Skipping item with invalid relative rect:', relativeRect);
                continue;
            }

            // --- CORRECTED FONT SIZE CALCULATION ---
            // bboxResult.fontSizes and avgFontSize are scaled (they come from getSpansBbox on scaled spans).
            // To store the 'original' size for later rendering, we need to divide by the current scale.
            // However, the OverlayUIRenderer expects 'originalFontSizes' to be the base size *before* applying scale and outputFontSizeScale.
            // Therefore, storing the sizes as they were *observed* (scaled) and letting OverlayUIRenderer handle the scaling correctly is key.
            // Let's store the sizes as they were *observed* (scaled) and let the renderer derive the base size correctly.

            // The average font size observed *at the current scale*.
            const observedAvgFontSize = bboxResult.avgFontSize; // This is the scaled size
            // The original font sizes observed *at the current scale*.
            const observedOriginalFontSizes = bboxResult.fontSizes; // These are the scaled sizes

            // Calculate the *base* font size that corresponds to the original PDF text size.
            // This is what the OverlayUIRenderer will use before applying scale and outputFontSizeScale.
            const baseAvgFontSize = observedAvgFontSize / currentScaleFromViewer;
            const baseOriginalFontSizes = observedOriginalFontSizes.map(fs => fs / currentScaleFromViewer);
            // --- END CORRECTED FONT SIZE CALCULATION ---

            newItems.push({
                selector: '', // Not used for saved overlays typically
                textContent: text, // Original HTML text content
                translatedText: translatedTexts[i] || text, // Translated text
                relativeRect, // Relative position
                page: pageNumber, // Page number
                // Store the *base* (unscaled) font sizes, as expected by OverlayUIRenderer
                originalFontSizes: baseOriginalFontSizes,
                fontFamily: bboxResult.fontFamily,
                // fontSize is often derived from originalFontSizes or not strictly needed if originalFontSizes is present
                // If you still want to store it, store the base size:
                fontSize: baseAvgFontSize,
                // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
                // Matches the id produced by overlay.ts extractPositionDataFrom
                // and pdf-layout-queue.ts buildOverlayData for the same source
                // paragraph — enables merge-by-id-first in updatePageOverlaysAndWrite.
                id: generateOverlayId(pageNumber, relativeRect, text || ''),
                // Phase 8 (V4 Schema): engine stamp from current provider/model.
                // Reprocessor re-translates via the live TranslationEngine, so
                // the current settings reflect the engine that produced the
                // retranslated text.
                engine: getCurrentEngine(this.plugin),
            });
        }

        if (newItems.length === 0) {
            new Notice('⚠️ No valid layout regions could be generated from the selection.');
            this.finish();
            return;
        }

        // Step 4: Save the reprocessed page and refresh the view (Reprocessor's unique job).
        //
        // Phase 3 (P0-7): previously this block did a full-file read-modify-write
        // via `loadSavedOverlay(file)` + manual rect-overlap merge + `saveOverlay`
        // (which delegated to `writeSavedOverlayForFile` — a full-file overwrite).
        // That clobbered any concurrent worker writes on OTHER pages — the worker
        // writes via `updatePageOverlaysAndWrite` (which only touches the pages it
        // was given), but the reprocessor's stale full-file read could overwrite
        // those worker pages with their pre-worker state, silently losing data.
        //
        // Now we write ONLY the modified page through `updatePageOverlaysAndWrite`
        // (via `saveOverlay`). Storage's per-page merge-by-rect-overlap preserves
        // any existing non-overlapping items on this page; other pages on disk are
        // NOT touched. Phase 7 will swap rect-overlap for merge-by-id-first, but
        // rect-overlap is sufficient to fix P0-7 (no longer clobbering OTHER pages).
        //
        // We construct a minimal SavedOverlay containing only the new items for
        // the modified page — `saveOverlay` extracts that page and forwards it
        // to `updatePageOverlaysAndWrite` as `{ [modifiedPage]: items }`.
        const savedOverlay: SavedOverlay = {
            fileName: file.basename.replace(/\.pdf$/i, ''),
            filePath: file.path,
            timestamp: Date.now(),
            pageOverlays: { [pageNumber]: newItems },
        };
        await this.saveOverlay(savedOverlay, file, pageNumber);

        this.plugin.clearAllOverlays();
        // Phase 3 (P0-11): use the overlay-side `loadSavedOverlayForCurrentPage`
        // (leaf-scoped, uses the renderer's in-memory cache as the single source
        // of truth) instead of the deleted storage-side version.
        await this.plugin.overlay.loadSavedOverlayForCurrentPage(true);

        new Notice(`✅ Reprocessed and saved ${newItems.length} segment(s)`);
        this.finish();
    }

    /**
     * Phase 3 (P0-7): writes ONLY the modified page through
     * `updatePageOverlaysAndWrite`. Storage's per-page merge-by-rect-overlap
     * preserves non-overlapping existing items on this page; other pages on
     * disk are NOT touched (fixing the reprocessor-clobbers-worker-on-other-
     * pages bug).
     *
     * `savedOverlay` is expected to contain at least an entry for
     * `modifiedPage`; any other pages it may carry are ignored — we forward
     * only `{ [modifiedPage]: items }` to the storage writer.
     */
    private async saveOverlay(savedOverlay: SavedOverlay, file: TFile, modifiedPage: number): Promise<void> {
        const pageKey = String(modifiedPage);
        const items = savedOverlay.pageOverlays[pageKey] || [];
        // Bug 2 fix: use REPLACE semantics. Reprocessor builds a fresh set of items
        // for the modified page (existing non-overlapping + new). MERGE would re-merge
        // against disk state and could keep stale duplicates when rects drift slightly.
        await this.plugin.storage.updatePageOverlaysAndWrite(file, { [modifiedPage]: items }, { replace: true });
        if (this.debug) {
            console.log(`[RegionReprocessor] Saved page ${modifiedPage} for ${file.path}`);
        }
    }

    private isOverlapping(
        a: { left: number; top: number; width: number; height: number },
        b: { left: number; top: number; width: number; height: number }
    ): boolean {
        // P2-70 (Phase 12): eps matches the `toFixed(4)` serialization precision
        // used by storage.ts when persisting `relativeRect` to .translations.md
        // (4 decimal places → 0.0001 resolution). Two rects that differ only in
        // the 5th decimal place round to identical serialized values, so the
        // overlap test must treat them as equal — otherwise the reprocessor
        // would emit "non-overlapping" duplicates for what is effectively the
        // same on-disk rect, breaking the merge-by-rect-overlap in
        // updatePageOverlaysAndWrite.
        const eps = 0.0001;
        return !(
            a.left + a.width < b.left - eps ||
            b.left + b.width < a.left - eps ||
            a.top + a.height < b.top - eps ||
            b.top + b.height < a.top - eps
        );
    }

    private cleanupAll(): void {
        this.cleanup.forEach(fn => fn());
        this.cleanup.clear();
        this.box?.remove();
        this.box = null;
        this.dragStart = null;
        this.isDragging = false;
        if (this.frameId !== null) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this.debugGuides.forEach(el => el.remove());
        this.debugGuides.clear();
    }

    private finish(): void {
        this.cleanupAll();
        this.isActive = false;
    }
}
