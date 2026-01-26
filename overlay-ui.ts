// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { EditSpecificTranslationModal } from './modal-edit-translation';

// Constants relevant to UI
const LINE_HEIGHT_MIN = 1.05; 
const LINE_HEIGHT_MAX = 2.0;
const LINE_HEIGHT_STEP = 0.1;

// IMPROVEMENT: Dynamic limits for auto-sizing logic
// 1. Mixed case text shouldn't shrink too much (readability first) -> Prefer scrolling.
const FONT_SCALE_MIN_MIXED = 0.85; 
// 2. All-caps text (often headers/labels) can shrink more aggressively to fit the box.
const FONT_SCALE_MIN_UPPERCASE = 0.65; 

const FONT_SCALE_MAX = 1.25; 

// Initial modifier: Start ALL CAPS text slightly smaller to reduce chance of overflow immediately
const UPPERCASE_INITIAL_MODIFIER = 0.85;

// Visual Tweaks
const BLEED_PX = 3; // Expands the box slightly to cover original text artifacts
const DEFAULT_BG = '#ffffff'; // Fallback background (white paper)

// Types for internal state
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
    private stylesInjected = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureGlobalStyles();
    }

    /**
     * Injects CSS once to handle scrollbars and transitions cleanly
     * without cluttering inline styles.
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
                    
                    /* IMPROVEMENT: Use Flexbox to center text vertically if translation is short */
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                }

                /* CRITICAL FIX: When scrolling is enabled ("Final Resort"), 
                   we must switch alignment to TOP. "Center" alignment on overflowing 
                   flex content causes the top lines to be clipped invisibly. */
                .pdf-text-overlay-reflow.is-scrollable {
                    justify-content: flex-start !important;
                }

                .pdf-text-overlay-reflow::-webkit-scrollbar {
                    display: none;
                }
                .pdf-text-overlay-reflow {
                    /* Hide scrollbar for IE, Edge and Firefox */
                    -ms-overflow-style: none;  /* IE and Edge */
                    scrollbar-width: none;  /* Firefox */
                }
                .pdf-text-overlay-reflow:hover {
                    /* Subtle lift effect on hover to show interactivity */
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
                    z-index: 1000 !important;
                    /* Allow the box to expand visually on hover if text is cut off */
                    max-height: none !important;
                }
            `;
            document.head.appendChild(style);
        }
        this.stylesInjected = true;
    }

    // ============================================================
    // Public API for OverlayRenderer
    // ============================================================

    /**
     * Creates the DOM element for an overlay.
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
        
        // --- 1) UPPERCASE DETECTION LOGIC ---
        // We only want to target "ALL CAPS" blocks (usually headers/labels).
        // Mixed case blocks (sentences) should not be penalized.
        const plainText = this.extractPlainTextFromHtml(htmlText).trim();
        
        // Logic: 
        // 1. Must contain content.
        // 2. Converting to Upper must match original.
        // 3. Converting to Lower must NOT match original (proves it has letters).
        const isAllUppercase = plainText.length > 0 && 
                               plainText === plainText.toUpperCase() && 
                               plainText !== plainText.toLowerCase();

        let effectiveScale = outputFontSizeScale;
        
        if (isAllUppercase) {
            // Apply initial penalty for ALL CAPS to start closer to fitting
            effectiveScale = outputFontSizeScale * UPPERCASE_INITIAL_MODIFIER;
        }

        const baseFontSize = avgOriginalFontSize * effectiveScale;
        const currentFontSize = baseFontSize * lastKnownScale;

        // Calculate positioning with "Bleed"
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
            padding: `${BLEED_PX}px`, 
            
            fontSize: `${currentFontSize}px`,
            fontFamily: fontFamily || '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            
            // overflow hidden looks cleaner; scrollbars only if truly necessary (handled in adjustOverlayForOverflow)
            overflow: 'hidden', 
            boxSizing: 'border-box',
            zIndex: '101',
            
            // Visual Styles for "Natural" look
            backgroundColor: 'var(--pdf-overlay-bg, #ffffff)', 
            
            // Force pure black text for readability
            color: '#000000', 
            
            // Spread the background slightly further to mask artifacts
            boxShadow: `0 0 0 1px var(--pdf-overlay-bg, ${DEFAULT_BG})`, 
            
            borderRadius: '2px',
            textRendering: 'optimizeLegibility',
        });

        el.style.setProperty('--overlay-opacity', `${overlayOpacity}`);
        
        if (overlayOpacity < 1) {
             el.style.opacity = `${overlayOpacity}`;
        }

        this.setOverlayElementVisibility(el, true);

        // Inner text container
        const inner = document.createElement('div');
        Object.assign(inner.style, {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            width: '100%',
            // We do NOT set height 100% here, allowing flexbox in parent to center vertically
            letterSpacing: '0.01em', 
            textAlign: 'left', 
        });
        inner.innerHTML = (htmlText || '').trim() || '…';
        el.appendChild(inner);

        // Apply initial line-height
        this.applyLineHeight(inner, outputLineHeight);

        // Metadata for later adjustment and saving
        el.setAttribute('data-original-text', originalTextContent);
        
        // Store intended font size so we don't drift on re-renders
        el.setAttribute('data-intended-font-size', String(currentFontSize));
        
        // Store casing flag for the adjuster logic
        el.setAttribute('data-is-uppercase', isAllUppercase ? 'true' : 'false');

        if (originalFontSizes.length > 0) {
            el.setAttribute('data-original-font-sizes', JSON.stringify(originalFontSizes));
        }

        // Interaction events
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
     * Adjusts overlay's font size and line height.
     * IMPROVEMENT: Dual-limit shrinking (Gentle for mixed case, Aggressive for Upper).
     * IMPROVEMENT: "Final resort" scrolling enables top-alignment to prevent cut-off.
     */
    public adjustOverlayForOverflow(el: HTMLElement, outputLineHeight: number): void {
        const inner = el.querySelector('div');
        if (!inner) return;

        // Retrieve the "base" size we calculated initially.
        const intendedFontSize = parseFloat(el.getAttribute('data-intended-font-size') || el.style.fontSize);
        const isAllUppercase = el.getAttribute('data-is-uppercase') === 'true';
        
        // Helper: Check if text spills out (with small buffer)
        // Used during calculation loops to be slightly conservative
        const checkOverflowForLoop = () => {
            return inner.scrollHeight > (el.clientHeight + 1) || inner.scrollWidth > (el.clientWidth + 1);
        };

        // Helper: Strict check for the final scroll decision
        const checkOverflowStrict = () => {
            return inner.scrollHeight > el.clientHeight || inner.scrollWidth > el.clientWidth;
        };
        
        // Helper: Check if text is significantly smaller than the box (Underflow)
        const checkUnderflow = () => {
            return inner.scrollHeight < (el.clientHeight * 0.70);
        };

        // Reset to initial state for calculation
        let currentSize = intendedFontSize;
        el.style.fontSize = `${currentSize}px`;
        this.applyLineHeight(inner, outputLineHeight);
        
        // Reset scroll state before calculating measurements
        el.style.overflow = 'hidden';
        el.classList.remove('is-scrollable');

        // Determine Minimum Scale based on Text Type
        // Mixed case -> Don't shrink below 85% (keep it readable, prefer scroll)
        // All Caps -> Can shrink down to 65% (fit the box tightly)
        const minScaleLimit = isAllUppercase ? FONT_SCALE_MIN_UPPERCASE : FONT_SCALE_MIN_MIXED;
        const minAllowedSize = intendedFontSize * minScaleLimit;

        // --- STRATEGY 1: SHRINK IF OVERFLOWING ---
        if (checkOverflowForLoop()) {
            let attempts = 0;

            // 1. Try reducing font size first 
            while (checkOverflowForLoop() && currentSize > minAllowedSize && attempts < 15) {
                currentSize *= 0.95; // Reduce by 5%
                el.style.fontSize = `${currentSize}px`;
                attempts++;
            }

            // 2. If still overflowing, try reducing line height slightly
            // Only do this if we really have to.
            if (checkOverflowForLoop()) {
                let currentLH = outputLineHeight;
                while (checkOverflowForLoop() && currentLH > LINE_HEIGHT_MIN) {
                    currentLH -= 0.05;
                    this.applyLineHeight(inner, currentLH);
                }
            }
        }
        
        // --- STRATEGY 2: GROW IF TOO MUCH WHITESPACE ---
        else if (checkUnderflow()) {
            let attempts = 0;
            const maxAllowedSize = intendedFontSize * FONT_SCALE_MAX;
            
            // Grow font size to fill the space
            while (checkUnderflow() && currentSize < maxAllowedSize && attempts < 10) {
                currentSize *= 1.05; // Grow by 5%
                el.style.fontSize = `${currentSize}px`;
                
                // Safety: If we made it overflow, backtrack immediately
                if (checkOverflowForLoop()) {
                    currentSize /= 1.05;
                    el.style.fontSize = `${currentSize}px`;
                    break;
                }
                attempts++;
            }
        }

        // --- 3. FINAL RESORT: ENABLE SCROLL ---
        // If there is ANY strict overflow remaining, enable scrolling.
        if (checkOverflowStrict()) {
            el.style.overflow = 'auto';
            
            // CRITICAL: Switch to top-alignment.
            // With justify-content: center (default), scrolling often hides the top lines.
            el.classList.add('is-scrollable');
        } else {
            el.style.overflow = 'hidden';
            el.classList.remove('is-scrollable');
        }
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
            // Cap reasonable limits
            newValue = Math.max(0.9, Math.min(2.5, newValue));
            newValue = Math.round(newValue * 10) / 10;
            this.applyLineHeight(inner, newValue);
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
            
            // If the user wants full opacity (1), we ensure the background is solid white.
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
        const originalText = targetOverlay.getAttribute('data-original-text') || '';

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

        addItem('Edit Translation', 'pencil', () => {
             if (!activeFile || pageNumber === null) {
                 new Notice('Cannot edit: PDF context missing.');
                 return;
             }
             if (!originalText && !textToCopy) return;
             
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

        addItem('Copy Translation', 'copy', async () => {
            try { await navigator.clipboard.writeText(textToCopy); new Notice('Translation copied.'); } catch {}
        });

        const copyFormattedText = async (format: string, title: string) => {
            if (!activeFile || pageNumber === null) return;
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
            } catch (error) { console.error(error); }
        };

        addItem('Copy as Callout', 'quote-glyph', () => copyFormattedText(this.plugin.settings.calloutFormat, 'callout'));
        addItem('Copy as Citation', 'book-open', () => copyFormattedText(this.plugin.settings.citationFormat, 'citation'));
        addItem('Copy as Footnote', 'superscript', () => copyFormattedText(this.plugin.settings.footnoteFormat, 'footnote'));

        menu.addSeparator();

        addItem('Retranslate Page...', 'refresh-cw', () => {
            if (activeFile) new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, activeFile).open();
        });

        addItem('Force Refresh Overlays', 'refresh-ccw', () => {
            if (typeof (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays === 'function') {
                 (this.plugin.renderer ?? this.plugin).forceRefreshVisibleOverlays();
            }
        });

        menu.addSeparator();

        addItem('Increase Text Size', 'zoom-in', () => this.adjustSingleOverlayFontSize(targetOverlay, 1.1));
        addItem('Decrease Text Size', 'zoom-out', () => this.adjustSingleOverlayFontSize(targetOverlay, 1 / 1.1));
        addItem('Increase Line Height', 'plus', () => this.adjustSingleOverlayLineHeight(targetOverlay, LINE_HEIGHT_STEP));
        addItem('Decrease Line Height', 'minus', () => this.adjustSingleOverlayLineHeight(targetOverlay, -LINE_HEIGHT_STEP));

        menu.addSeparator();

        addItem('Go to Translation File', 'file-text', () => {
            if (!activeFile || activeFile.extension !== 'pdf' || pageNumber === null) return;
            const wikiLink = `${activeFile.basename}.translations#Page ${pageNumber}`;
            this.plugin.app.workspace.openLinkText(wikiLink, '', false);
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