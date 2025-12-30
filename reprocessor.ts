// reprocessor.ts
import { App, Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { OverlayPositionData, SavedOverlay } from './types';
import { LayoutResult } from './layout-detector';

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
    private readonly debug: boolean;
    private cleanup = new Set<() => void>();
    private isActive = false;
    private frameId: number | null = null;
    private debugGuides = new Set<HTMLElement>();

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.debug = plugin.settings.debugMode;
    }

    /**
     * Starts a new reprocessing session.
     */
    public start(): void {
        if (this.isActive) {
            new Notice('Another reprocessing session is active. Canceling previous one.');
            this.cleanupAll();
        }
        this.isActive = true;
        void this.run();
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
            e.preventDefault();
            if (this.frameId !== null) return;
            this.frameId = window.requestAnimationFrame(() => {
                this.frameId = null;
                const { clientX, clientY } = e;
                const { x: startX, y: startY } = this.dragStart!;
                const left = Math.min(startX, clientX);
                const top = Math.min(startY, clientY);
                const width = Math.abs(clientX - startX);
                const height = Math.abs(clientY - startY);
                this.box!.style.transform = `translate(${left}px, ${top}px)`;
                this.box!.style.width = `${width}px`;
                this.box!.style.height = `${height}px`;
            });
        };

        const onMouseUp = (e: MouseEvent) => {
            if (!this.isDragging) return;
            e.preventDefault();
            e.stopPropagation();
            this.isDragging = false;
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
                void this.handleRegionReprocessing(rect, pageNumber, file);
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

        const timeoutId = window.setTimeout(() => {
            if (this.isActive) {
                new Notice('Region selection timed out.', 2000);
                this.cleanupAll();
                this.finish();
            }
        }, 15000);
        this.cleanup.add(() => clearTimeout(timeoutId));
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
        const translationUnits = this.plugin.processor.prepareTranslationUnits(selectedSpans, pageEl);
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
        const currentScaleFromViewer = parseFloat(pdfViewer?.style.getPropertyValue('--scale-factor') || '1');
        if (isNaN(currentScaleFromViewer) || currentScaleFromViewer <= 0) {
             console.warn('[RegionReprocessor] Invalid scale factor found, defaulting to 1.0');
             // Fallback might be to getComputedStyle transform, but --scale-factor is usually reliable
             // For now, just warn and proceed, potentially leading to incorrect size if it's truly wrong.
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
                id: `reproc-${Date.now()}-${i}`, // Unique ID for the item
            });
        }

        if (newItems.length === 0) {
            new Notice('⚠️ No valid layout regions could be generated from the selection.');
            this.finish();
            return;
        }

        // Step 4: Merge new items, save, and refresh the view (Reprocessor's unique job)
        const savedOverlay = await this.loadSavedOverlay(file);
        const pageKey = String(pageNumber);
        const existingItems = savedOverlay.pageOverlays[pageKey] || [];
        const nonOverlappingOldItems = existingItems.filter(oldItem =>
            !newItems.some(newItem => this.isOverlapping(oldItem.relativeRect, newItem.relativeRect))
        );

        savedOverlay.pageOverlays[pageKey] = [...nonOverlappingOldItems, ...newItems];
        savedOverlay.timestamp = Date.now();

        await this.saveOverlay(savedOverlay, file);

        this.plugin.clearAllOverlays();
        await this.plugin.storage.loadSavedOverlayForCurrentPage(file, true); // Force reload

        new Notice(`✅ Reprocessed and saved ${newItems.length} segment(s)`);
        this.finish();
    }

    private async loadSavedOverlay(file: TFile): Promise<SavedOverlay> {
        const { storage } = this.plugin;
        const result = await storage.readSavedOverlayForFile(file);
        return result?.overlay || {
            fileName: file.basename.replace(/\.pdf$/i, ''),
            filePath: file.path,
            timestamp: Date.now(),
            pageOverlays: {},
        };
    }

    private async saveOverlay(savedOverlay: SavedOverlay, file: TFile): Promise<void> {
        await this.plugin.storage.writeSavedOverlayForFile(file, savedOverlay);
        if (this.debug) {
            console.log(`[RegionReprocessor] Saved updates for ${file.path}`);
        }
    }

    private isOverlapping(
        a: { left: number; top: number; width: number; height: number },
        b: { left: number; top: number; width: number; height: number }
    ): boolean {
        const eps = 1e-5;
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