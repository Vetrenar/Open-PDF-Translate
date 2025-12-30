// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main'; // Adjust path if needed
import type { OverlayPositionData, SavedOverlay } from './types'; // Adjust path if needed
import { RetranslateUsingOverlaysModal } from './modal-retranslate'; // Adjust path if needed

// Constants relevant to UI
const LINE_HEIGHT_MIN = 0.8;
const LINE_HEIGHT_MAX = 2.0;
const LINE_HEIGHT_STEP = 0.1;

// Types for internal state (if not already defined elsewhere)
type OverlayHandlers = {
    contextHandler: EventListener;
    hoverHandlers?: { show: EventListener; hide: EventListener };
    bringToTopHandler?: EventListener;
    resetZIndexHandler?: EventListener;
};

/**
 * Handles the visual rendering, styling, and user interaction aspects of PDF translation overlays.
 * This class focuses on the UI elements themselves.
 */
export class OverlayUIRenderer {
    private plugin: OpenRouterTranslatorPlugin;

    // State and caches for UI elements
    private createdOverlays: WeakMap<HTMLElement, OverlayHandlers> = new WeakMap();
    private trackedOverlayElements: Set<HTMLElement> = new Set();
    private tempDiv: HTMLDivElement | null = null; // For efficient HTML to text conversion

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    // ============================================================
    // Public API for OverlayRenderer (or other managers)
    // ============================================================

    /**
     * Creates the DOM element for an overlay but does NOT
     * do expensive measuring/adjustments (that's handled separately or by manager).
     */
    public createReflowOverlay(
        rect: DOMRect,
        htmlText: string,
        referenceSpan: HTMLSpanElement,
        originalFontSizes: number[],
        pageNumber: number,
        originalTextContent: string,
        overlayOpacity: number,
        outputFontSizeScale: number,
        outputLineHeight: number,
        lastKnownScale: number,
        fontFamily?: string
    ): HTMLElement {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            console.debug('[OverlayUIRenderer] createReflowOverlay: Invalid rect');
            return document.createElement('div');
        }

        const el = document.createElement('div');
        el.className = 'pdf-text-overlay-reflow';

        const avgOriginalFontSize = originalFontSizes.length > 0
            ? originalFontSizes.reduce((a, b) => a + b, 0) / originalFontSizes.length
            : parseFloat(window.getComputedStyle(referenceSpan).fontSize) || 12;
        const baseFontSize = avgOriginalFontSize * outputFontSizeScale;
        const currentFontSize = baseFontSize * lastKnownScale;

        Object.assign(el.style, {
            position: 'absolute',
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            fontSize: `${currentFontSize}px`,
            overflow: 'auto',
            boxSizing: 'border-box',
            zIndex: '101',
        });

        el.style.setProperty('--overlay-opacity', `${overlayOpacity}`);
        this.setOverlayElementVisibility(el, true); // Assuming visible by default here, manager handles toggling

        if (fontFamily) {
             el.style.fontFamily = fontFamily;
        }

        // Inner text container
        const inner = document.createElement('div');
        Object.assign(inner.style, {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            width: '100%',
            height: '100%',
        });
        inner.innerHTML = (htmlText || '').trim() || '…';
        el.appendChild(inner);

        // Apply initial line-height (adjustment might happen later by manager)
        this.applyLineHeight(inner, outputLineHeight);

        // Metadata for later adjustment and saving (if needed by manager)
        el.setAttribute('data-original-text', originalTextContent);
        if (originalFontSizes.length > 0) {
            el.setAttribute('data-original-font-sizes', JSON.stringify(originalFontSizes));
        }

        // Interaction events (context menu, z-index bump) - attached here
        const contextHandler = (event: Event) => {
            try {
                this.showContextMenu(event, inner.textContent || '', el);
            } catch (error) {
                console.debug('[OverlayUIRenderer] contextHandler error:', error);
            }
        };
        const bringToTopHandler = () => this.bringToTop(el);
        const resetZIndexHandler = () => { el.style.zIndex = '101'; };

        el.addEventListener('contextmenu', contextHandler);
        el.addEventListener('mouseover', bringToTopHandler);
        el.addEventListener('mouseleave', resetZIndexHandler);

        this.createdOverlays.set(el, {
            contextHandler,
            bringToTopHandler,
            resetZIndexHandler,
        });
        this.trackedOverlayElements.add(el);

        return el;
    }

    /**
     * Adjusts overlay's line height first to fit, then font size only as last resort.
     * Ensures minimum font size doesn't go below what would naturally fit the bounding box.
     */
    public adjustOverlayForOverflow(el: HTMLElement, outputLineHeight: number): void {
        const inner = el.querySelector('div');
        if (!inner) return;

        const isOverflowing = inner.scrollHeight > el.clientHeight || inner.scrollWidth > el.clientWidth;
        if (!isOverflowing) {
            el.style.overflow = 'auto';
            return;
        }

        const intendedFontSize = parseFloat(el.style.fontSize);
        const intendedLineHeight = outputLineHeight;
        
        const minReasonableFontSize = Math.max(8, Math.min(
            el.clientHeight * 0.3,
            el.clientWidth * 0.05
        ));
        
        const minFontSizeFromIntention = intendedFontSize * 0.5;
        const absoluteMinimumFontSize = Math.max(minReasonableFontSize, minFontSizeFromIntention);

        let currentLineHeight = intendedLineHeight;
        let attempts = 0;
        
        while (currentLineHeight > 0.8 && attempts < 20) {
            currentLineHeight -= 0.03;
            this.applyLineHeight(inner as HTMLDivElement, currentLineHeight);
            
            if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
                return;
            }
            attempts++;
        }

        let testFontSize = intendedFontSize;
        attempts = 0;
        
        while (testFontSize > absoluteMinimumFontSize && attempts < 15) {
            el.style.fontSize = `${testFontSize}px`;
            
            if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
                return;
            }
            
            testFontSize *= 0.96;
            attempts++;
        }

        if (absoluteMinimumFontSize <= intendedFontSize) {
            el.style.fontSize = `${absoluteMinimumFontSize}px`;
            if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
                return;
            }
        }

        el.style.overflow = 'auto';
        console.debug("[OverlayUIRenderer] Could not fit content with minimum font size, enabled scrollbar");
    }

    /**
     * Adjusts the line height for a single, specific overlay element.
     */
    public adjustSingleOverlayLineHeight(overlayEl: HTMLElement, delta: number): void {
        const inner = overlayEl.querySelector('div');
        if (!inner) return;
        try {
            const currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;
            let newValue = currentLineHeight + delta;
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            newValue = Math.round(newValue * 10) / 10;
            this.applyLineHeight(inner, newValue);
            console.debug(`[OverlayUIRenderer] Line height for a single overlay adjusted to ${newValue}`);
        } catch (error) {
            console.debug('[OverlayUIRenderer] adjustSingleOverlayLineHeight failed:', error);
        }
    }

    /**
     * Adjusts the font size for a single, specific overlay element.
     */
    public adjustSingleOverlayFontSize(overlayEl: HTMLElement, scaleFactor: number): void {
        if (!overlayEl) return;
        try {
            const currentSize = parseFloat(overlayEl.style.fontSize);
            if (isNaN(currentSize)) {
                console.debug('[OverlayUIRenderer] Could not parse current font size for adjustment.');
                return;
            }
            const FONT_SIZE_MIN_PX = 6;
            const FONT_SIZE_MAX_PX = 72;
            let newSize = currentSize * scaleFactor;
            newSize = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, newSize));
            overlayEl.style.fontSize = `${newSize}px`;
            console.debug(`[OverlayUIRenderer] Font size for a single overlay adjusted to ${newSize}px`);
        } catch (error) {
            console.debug('[OverlayUIRenderer] adjustSingleOverlayFontSize failed:', error);
        }
    }

    public applyLineHeight(inner: HTMLDivElement, value: number): void {
        const lineHeightStr = `${value}`;
        inner.style.lineHeight = lineHeightStr;
        inner.parentElement?.style.setProperty('--overlay-line-height', lineHeightStr);
    }

    public setOverlayElementVisibility(el: HTMLElement, isVisible: boolean): void {
        if (isVisible) {
            el.style.opacity = el.style.getPropertyValue('--overlay-opacity') || `${this.plugin.settings.overlayOpacity}`;
            el.style.pointerEvents = 'auto';
            el.style.visibility = 'visible';
        } else {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            el.style.visibility = 'hidden';
        }
    }

    public bringToTop(el: HTMLElement): void {
        const overlays = document.querySelectorAll('.pdf-text-overlay-reflow');
        let maxZIndex = 100;
        overlays.forEach(overlay => {
            const zIndex = parseInt(window.getComputedStyle(overlay).zIndex, 10);
            if (!isNaN(zIndex) && zIndex > maxZIndex) {
                maxZIndex = zIndex;
            }
        });
        el.style.zIndex = `${maxZIndex + 1}`;
    }

    // ============================================================
    // Context Menu
    // ============================================================

    private showContextMenu(event: Event, textToCopy: string, targetOverlay: HTMLElement): void {
        const me = event as MouseEvent;
        me.preventDefault();
        me.stopPropagation();
        if (!targetOverlay) return;

        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        const activeFile = activeLeaf?.view?.file;
        const pageNumber = this.plugin.getCurrentPageNumber();

        const menu = new Menu();
        const addItem = (title: string, icon: string, onClick: () => void) =>
            menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(onClick));

        addItem('Copy Translation', 'copy', async () => {
            try {
                await navigator.clipboard.writeText(textToCopy);
                new Notice('Translation copied.');
            } catch {
                new Notice('Failed to copy translation.');
            }
        });

        // --- NEW: DYNAMIC FORMATTED COPY ---
        const copyFormattedText = async (format: string, title: string) => {
            if (!activeFile || pageNumber === null) {
                new Notice(`Cannot copy as ${title}: PDF file or page number is not available.`);
                return;
            }

            try {
                // Prepare all placeholder values
                const pageLink = `[[${activeFile.path}#page=${pageNumber}]]`;
                const blockquoteText = textToCopy.split('\n').map(line => `> ${line}`).join('\n');
                
                // Replace placeholders in the format string
                const formattedText = format
                    .replace(/{blockquote_text}/g, blockquoteText)
                    .replace(/{text}/g, textToCopy)
                    .replace(/{filename}/g, activeFile.name)
                    .replace(/{pagelink}/g, pageLink)
                    .replace(/{pagenumber}/g, String(pageNumber));

                await navigator.clipboard.writeText(formattedText);
                new Notice(`Copied as ${title}.`);
            } catch (error) {
                console.error(`Failed to copy translation as ${title}:`, error);
                new Notice(`Failed to copy as ${title}.`);
            }
        };

        addItem('Copy as Callout', '', () => 
            copyFormattedText(this.plugin.settings.calloutFormat, 'callout')
        );
        
        addItem('Copy as Citation', '', () => 
            copyFormattedText(this.plugin.settings.citationFormat, 'citation')
        );

        addItem('Copy as Footnote', '', () => 
            copyFormattedText(this.plugin.settings.footnoteFormat, 'footnote')
        );

        menu.addSeparator();

        addItem('Retranslate Page...', 'refresh-cw', () => {
            if (!activeFile) return;
            new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, activeFile).open();
        });
        addItem('Force Refresh Overlays', 'refresh-ccw', () => {
            if (typeof (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays === 'function') {
                 (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays();
            } else {
                new Notice("Refresh function not available");
            }
        });
        menu.addSeparator();

        // Font size controls
        addItem('Increase Text Size', 'zoom-in', () => this.adjustSingleOverlayFontSize(targetOverlay, 1.1));
        addItem('Decrease Text Size', 'zoom-out', () => this.adjustSingleOverlayFontSize(targetOverlay, 1 / 1.1));
        // Line height controls
        addItem('Increase Line Height', 'plus', () => this.adjustSingleOverlayLineHeight(targetOverlay, LINE_HEIGHT_STEP));
        addItem('Decrease Line Height', 'minus', () => this.adjustSingleOverlayLineHeight(targetOverlay, -LINE_HEIGHT_STEP));

        menu.addSeparator();

        addItem('Go to Translation File', 'file-text', () => {
            try {
                if (!activeFile || activeFile.extension !== 'pdf' || pageNumber === null) {
                    new Notice('No PDF or page available.');
                    return;
                }
                const translationFileName = `${activeFile.basename}.translations`;
                const wikiLink = `${translationFileName}#Page ${pageNumber}`;
                this.plugin.app.workspace.openLinkText(wikiLink, '', false);
                new Notice(`Opened translation for page ${pageNumber}`);
                console.debug(`[OverlayUIRenderer] Opened translation link: ${wikiLink}`);
            } catch (error) {
                console.debug('[OverlayUIRenderer] Go to translation file error:', error);
                new Notice('Error opening translation file.');
            }
        });

        menu.showAtPosition({ x: me.clientX, y: me.clientY });
    }

    // ============================================================
    // Cleanup
    // ============================================================

    private cleanupHoverHandlers(el: HTMLElement): void {
        const handlers = this.createdOverlays.get(el)?.hoverHandlers;
        if (handlers) {
            el.removeEventListener('mouseenter', handlers.show);
            el.removeEventListener('mouseleave', handlers.hide);
            const allHandlers = this.createdOverlays.get(el)!;
            delete allHandlers.hoverHandlers;
            this.createdOverlays.set(el, allHandlers);
        }
    }

    public cleanupOverlayElement(el: HTMLElement): void {
        this.cleanupHoverHandlers(el);
        const handlers = this.createdOverlays.get(el);
        if (handlers) {
            el.removeEventListener('contextmenu', handlers.contextHandler);
            if (handlers.bringToTopHandler) {
                el.removeEventListener('mouseover', handlers.bringToTopHandler);
            }
            if (handlers.resetZIndexHandler) {
                el.removeEventListener('mouseleave', handlers.resetZIndexHandler);
            }
            this.createdOverlays.delete(el);
        }
        this.trackedOverlayElements.delete(el);
        el.remove();
    }

    public cleanup(): void {
        this.trackedOverlayElements.forEach(el => this.cleanupOverlayElement(el));
        this.trackedOverlayElements.clear();
        this.createdOverlays = new WeakMap(); // Clear the map
        this.tempDiv = null; // Clear temp div reference
    }

    // Helper for text extraction (if needed here)
    public extractPlainTextFromHtml(html: string): string {
        if (!this.tempDiv) this.tempDiv = document.createElement('div');
        this.tempDiv.innerHTML = html;
        return this.tempDiv.textContent || this.tempDiv.innerText || '';
    }
}