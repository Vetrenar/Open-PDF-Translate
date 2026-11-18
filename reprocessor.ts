import { screenToPageRegion } from './region-layout';
import { RegionLayoutEditor } from './region-layout-editor';
import { fallbackIndices } from './translation-result';
// reprocessor.ts
import { App, Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { buildSpanFilterCtx } from './table-keep';
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
            console.debug('[RegionReprocessor] Starting – waiting for Shift+drag...');
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
        const pageEl = this.plugin.app.workspace.activeLeaf?.view.containerEl.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
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
    private async handleRegionReprocessing(screenRect: DOMRect, pageNumber: number, file: TFile): Promise<void> {
        if(this.plugin.app.workspace.getActiveFile()?.path !== file.path) throw new Error('Active PDF changed. Select the region again.');
        const leaf = this.plugin.app.workspace.activeLeaf;
        const frame = leaf?.view.containerEl.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"] .textLayer`);
        if (!frame) throw new Error('PDF text layer unavailable');
        const bounds=frame.getBoundingClientRect();
        const region=screenToPageRegion(screenRect,bounds);
        const rotation=frame.getAttribute('data-main-rotation');
        this.finish();
        if(!region) return;
        new RegionLayoutEditor(this.plugin,file,pageNumber,region,rotation===null?undefined:Number(rotation)).open();
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
