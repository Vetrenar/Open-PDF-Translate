// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { EditSpecificTranslationModal } from './modal-edit-translation';

// ============================================================
// Constants & Configuration
// ============================================================

// Sizing Constants (From Version 2 - simpler, wider range)
const LINE_HEIGHT_MIN = 0.8;
const LINE_HEIGHT_MAX = 2.0;
const LINE_HEIGHT_STEP = 0.1;

// Visual Tweaks (From Version 1 - "Nice Design")
const BLEED_PX = 3; // Expands the box slightly to cover original text artifacts
const DEFAULT_BG = '#ffffff'; 

// Types for internal state
type OverlayHandlers = {
    contextHandler: EventListener;
    hoverHandlers?: { show: EventListener; hide: EventListener };
    bringToTopHandler?: EventListener;
    resetZIndexHandler?: EventListener;
};

/**
 * Handles the visual rendering, styling, and user interaction aspects of PDF translation overlays.
 */
export class OverlayUIRenderer {
    private plugin: OpenRouterTranslatorPlugin;

    // State and caches for UI elements
    private createdOverlays: WeakMap<HTMLElement, OverlayHandlers> = new WeakMap();
    private trackedOverlayElements: Set<HTMLElement> = new Set();
    private tempDiv: HTMLDivElement | null = null; 
    private stylesInjected = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureGlobalStyles();
    }

    /**
     * Injects CSS once to handle the "Borderless" look (V1 Design).
     */
    private ensureGlobalStyles() {
        if (this.stylesInjected) return;
        const styleId = 'pdf-overlay-ui-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .pdf-text-overlay-reflow {
                    transition: box-shadow 0.2s ease, transform 0.1s ease;
                    /* Hide scrollbar for Chrome, Safari and Opera */
                    -webkit-overflow-scrolling: touch;
                    
                    /* V1 Design: Flexbox to center text vertically if translation is short */
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                }

                /* When scrolling is enabled (V2 Logic), align to TOP so text isn't cut off */
                .pdf-text-overlay-reflow.is-scrollable {
                    justify-content: flex-start !important;
                }

                /* Hide scrollbar for IE, Edge and Firefox */
                .pdf-text-overlay-reflow::-webkit-scrollbar {
                    display: none;
                }
                .pdf-text-overlay-reflow {
                    -ms-overflow-style: none;  /* IE and Edge */
                    scrollbar-width: none;  /* Firefox */
                }
                
                /* V1 Design: Hover effects */
                .pdf-text-overlay-reflow:hover {
                    /* Subtle lift effect on hover */
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
                    z-index: 1000 !important;
                    /* Allow expansion on hover */
                    max-height: none !important;
                }
            `;
            document.head.appendChild(style);
        }
        this.stylesInjected = true;
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Creates the DOM element for an overlay.
     * Merges V1 Styling (Bleed/Padding) with V2 Sizing Logic.
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
            return document.createElement('div');
        }

        const el = document.createElement('div');
        el.className = 'pdf-text-overlay-reflow';

        // --- Font Calculation (V2 Logic) ---
        const avgOriginalFontSize = originalFontSizes.length > 0
            ? originalFontSizes.reduce((a, b) => a + b, 0) / originalFontSizes.length
            : parseFloat(window.getComputedStyle(referenceSpan).fontSize) || 12;
        
        const baseFontSize = avgOriginalFontSize * outputFontSizeScale;
        const currentFontSize = baseFontSize * lastKnownScale;

        // --- Positioning & Visuals (V1 Logic - Bleed & Design) ---
        const adjustedLeft = rect.left - BLEED_PX;
        const adjustedTop = rect.top - BLEED_PX;
        const adjustedWidth = rect.width + (BLEED_PX * 2);
        const adjustedHeight = rect.height + (BLEED_PX * 2);

        Object.assign(el.style, {
            position: 'absolute',
            left: `${adjustedLeft}px`,
            top: `${adjustedTop}px`,
            width: `${adjustedWidth}px`,
            height: `${adjustedHeight}px`,
            padding: `${BLEED_PX}px`, // V1 Bleed Padding
            
            fontSize: `${currentFontSize}px`,
            fontFamily: fontFamily || '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            
            overflow: 'hidden', // Start hidden, V2 logic will set to auto if needed
            boxSizing: 'border-box',
            zIndex: '101',
            
            // Visual Styles (V1)
            backgroundColor: 'var(--pdf-overlay-bg, #ffffff)', 
            color: '#000000', // Force black for readability
            boxShadow: `0 0 0 1px var(--pdf-overlay-bg, ${DEFAULT_BG})`, 
            borderRadius: '2px',
            textRendering: 'optimizeLegibility',
        });

        el.style.setProperty('--overlay-opacity', `${overlayOpacity}`);
        this.setOverlayElementVisibility(el, true);

        // Inner text container
        const inner = document.createElement('div');
        Object.assign(inner.style, {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            width: '100%',
            // height: '100%', // Removed 100% height to allow V1 Flexbox centering to work
            textAlign: 'left',
        });
        inner.innerHTML = (htmlText || '').trim() || '…';
        el.appendChild(inner);

        // Apply initial line-height
        this.applyLineHeight(inner, outputLineHeight);

        // Metadata
        el.setAttribute('data-original-text', originalTextContent);
        if (originalFontSizes.length > 0) {
            el.setAttribute('data-original-font-sizes', JSON.stringify(originalFontSizes));
        }

        // Interaction events
        const contextHandler = (event: Event) => this.showContextMenu(event, inner.textContent || '', el);
        const bringToTopHandler = () => this.bringToTop(el);
        const resetZIndexHandler = () => { el.style.zIndex = '101'; };

        el.addEventListener('contextmenu', contextHandler);
        el.addEventListener('mouseover', bringToTopHandler);
        el.addEventListener('mouseleave', resetZIndexHandler);

        this.createdOverlays.set(el, { contextHandler, bringToTopHandler, resetZIndexHandler });
        this.trackedOverlayElements.add(el);

        // --- Apply Sizing Logic (V2 Logic) ---
        // We use the iterative approach from V2 as requested.
        // Since V1 design adds padding, the iterative logic must account for that (it does via clientHeight).
        this.adjustOverlayForOverflow(el, outputLineHeight);

        return el;
    }

    /**
     * Version 2 Logic: Iterative adjustment.
     * Shrinks line height first, then font size, then enables scroll.
     * This is more stable than the binary search for some PDFs.
     */
    public adjustOverlayForOverflow(el: HTMLElement, outputLineHeight: number): void {
        const inner = el.querySelector('div');
        if (!inner) return;

        // Reset scroll state
        el.classList.remove('is-scrollable');
        el.style.overflow = 'hidden';

        const isOverflowing = inner.scrollHeight > el.clientHeight || inner.scrollWidth > el.clientWidth;
        
        // If it fits immediately, great.
        if (!isOverflowing) {
            return;
        }

        const intendedFontSize = parseFloat(el.style.fontSize);
        
        // Calculate strict minimums
        const minReasonableFontSize = Math.max(8, Math.min(
            el.clientHeight * 0.3,
            el.clientWidth * 0.05
        ));
        const minFontSizeFromIntention = intendedFontSize * 0.5;
        const absoluteMinimumFontSize = Math.max(minReasonableFontSize, minFontSizeFromIntention);

        let currentLineHeight = outputLineHeight;
        let attempts = 0;
        
        // 1. Try reducing line height (V2 Logic)
        while (currentLineHeight > 0.8 && attempts < 20) {
            currentLineHeight -= 0.03;
            this.applyLineHeight(inner as HTMLDivElement, currentLineHeight);
            
            if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
                return;
            }
            attempts++;
        }

        // 2. Try reducing font size (V2 Logic)
        let testFontSize = intendedFontSize;
        attempts = 0;
        
        while (testFontSize > absoluteMinimumFontSize && attempts < 15) {
            el.style.fontSize = `${testFontSize}px`;
            
            if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
                return;
            }
            
            testFontSize *= 0.96; // Reduce by 4% each step
            attempts++;
        }

        // 3. Fallback: Set to min font size and allow scroll (V2 Logic + V1 Styling fix)
        // If we must scroll, we must ensure the Flexbox alignment doesn't hide the top text
        el.style.fontSize = `${absoluteMinimumFontSize}px`;
        el.style.overflow = 'auto'; // Native overflow from V2
        el.classList.add('is-scrollable'); // Triggers V1 CSS fix to align text to top
        
        console.debug("[OverlayUIRenderer] Could not fit content, enabled scrollbar");
    }

    // ============================================================
    // Manual Adjustments (V2 Implementation - simpler)
    // ============================================================

    public adjustSingleOverlayLineHeight(overlayEl: HTMLElement, delta: number): void {
        const inner = overlayEl.querySelector('div');
        if (!inner) return;
        try {
            const currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;
            let newValue = currentLineHeight + delta;
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            newValue = Math.round(newValue * 10) / 10;
            this.applyLineHeight(inner as HTMLDivElement, newValue);
        } catch (error) {
            console.debug('[OverlayUIRenderer] adjustSingleOverlayLineHeight failed:', error);
        }
    }

    public adjustSingleOverlayFontSize(overlayEl: HTMLElement, scaleFactor: number): void {
        if (!overlayEl) return;
        try {
            const currentSize = parseFloat(overlayEl.style.fontSize);
            if (isNaN(currentSize)) return;
            
            const FONT_SIZE_MIN_PX = 6;
            const FONT_SIZE_MAX_PX = 72;
            let newSize = currentSize * scaleFactor;
            newSize = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, newSize));
            overlayEl.style.fontSize = `${newSize}px`;
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
            const op = el.style.getPropertyValue('--overlay-opacity') || `${this.plugin.settings.overlayOpacity}`;
            
            // V1 Design: Solid white background if opacity is high
            if (parseFloat(op) >= 0.95) {
                el.style.opacity = '1';
                el.style.backgroundColor = 'var(--pdf-overlay-bg, #ffffff)';
            } else {
                el.style.opacity = op;
            }

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
    // Context Menu (V2 Implementation - More Robust)
    // ============================================================

    private showContextMenu(event: Event, textToCopy: string, targetOverlay: HTMLElement): void {
        const me = event as MouseEvent;
        me.preventDefault();
        me.stopPropagation();
        if (!targetOverlay) return;

        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        const activeFile = activeLeaf?.view?.file;
        const pageNumber = this.plugin.getCurrentPageNumber();
        const originalText = targetOverlay.getAttribute('data-original-text') || '';

        // Calculate Index for Stable Editing (V2 feature)
        const container = targetOverlay.parentElement;
        let itemIndex = -1;
        if (container) {
            const siblings = Array.from(container.children).filter(el => 
                el.classList.contains('pdf-text-overlay-reflow')
            );
            itemIndex = siblings.indexOf(targetOverlay);
        }

        const menu = new Menu();
        const addItem = (title: string, icon: string, onClick: () => void) =>
            menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(onClick));

        // 1. Edit Actions (V2 Robust Checks)
        addItem('Edit Translation', 'pencil', () => {
             if (!activeFile || pageNumber === null) {
                 new Notice('Cannot edit: PDF context missing.');
                 return;
             }
             if (!originalText && !textToCopy) {
                 new Notice('Cannot edit: Reference text missing.');
                 return;
             }
             if (itemIndex === -1) {
                 new Notice('Cannot edit: Could not determine overlay position.');
                 return;
             }
             
             new EditSpecificTranslationModal(
                 this.plugin.app,
                 this.plugin,
                 activeFile,
                 pageNumber,
                 itemIndex,
                 originalText,
                 textToCopy
             ).open();
        });

        menu.addSeparator();

        // 2. Copy Actions
        addItem('Copy Translation', 'copy', async () => {
            try { await navigator.clipboard.writeText(textToCopy); new Notice('Translation copied.'); } catch {}
        });

        const copyFormattedText = async (format: string, title: string) => {
            if (!activeFile || pageNumber === null) {
                new Notice(`Cannot copy as ${title}: PDF file or page number is not available.`);
                return;
            }
            try {
                const pageLink = `[[${activeFile.path}#page=${pageNumber}]]`;
                const blockquoteText = textToCopy.split('\n').map(line => `> ${line}`).join('\n');
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

        addItem('Copy as Callout', 'quote-glyph', () => copyFormattedText(this.plugin.settings.calloutFormat, 'callout'));
        addItem('Copy as Citation', 'book-open', () => copyFormattedText(this.plugin.settings.citationFormat, 'citation'));
        addItem('Copy as Footnote', 'superscript', () => copyFormattedText(this.plugin.settings.footnoteFormat, 'footnote'));

        menu.addSeparator();

        // 3. Page & Overlay Management
        addItem('Retranslate Page...', 'refresh-cw', () => {
            if (activeFile) new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, activeFile).open();
        });

        addItem('Force Refresh Overlays', 'refresh-ccw', () => {
            if (typeof (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays === 'function') {
                 (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays();
            } else {
                new Notice("Refresh function not available");
            }
        });

        menu.addSeparator();

        // 4. Visual Adjustments (V2 Logic)
        addItem('Increase Text Size', 'zoom-in', () => this.adjustSingleOverlayFontSize(targetOverlay, 1.1));
        addItem('Decrease Text Size', 'zoom-out', () => this.adjustSingleOverlayFontSize(targetOverlay, 1 / 1.1));
        addItem('Increase Line Height', 'plus', () => this.adjustSingleOverlayLineHeight(targetOverlay, LINE_HEIGHT_STEP));
        addItem('Decrease Line Height', 'minus', () => this.adjustSingleOverlayLineHeight(targetOverlay, -LINE_HEIGHT_STEP));

        menu.addSeparator();

        // 5. Navigation
        addItem('Go to Translation File', 'file-text', () => {
            try {
                if (!activeFile || activeFile.extension !== 'pdf' || pageNumber === null) {
                    new Notice('No PDF or page available.');
                    return;
                }
                const wikiLink = `${activeFile.basename}.translations#Page ${pageNumber}`;
                this.plugin.app.workspace.openLinkText(wikiLink, '', false);
            } catch (error) {
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
            if (handlers.bringToTopHandler) el.removeEventListener('mouseover', handlers.bringToTopHandler);
            if (handlers.resetZIndexHandler) el.removeEventListener('mouseleave', handlers.resetZIndexHandler);
            this.createdOverlays.delete(el);
        }
        this.trackedOverlayElements.delete(el);
        el.remove();
    }

    public cleanup(): void {
        this.trackedOverlayElements.forEach(el => this.cleanupOverlayElement(el));
        this.trackedOverlayElements.clear();
        this.createdOverlays = new WeakMap();
        this.tempDiv = null;
    }

    public extractPlainTextFromHtml(html: string): string {
        if (!this.tempDiv) this.tempDiv = document.createElement('div');
        this.tempDiv.innerHTML = html;
        return this.tempDiv.textContent || this.tempDiv.innerText || '';
    }
}