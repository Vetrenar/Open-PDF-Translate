// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { EditSpecificTranslationModal } from './modal-edit-translation';
import type { OverlayPositionData } from './types';
import type { LayoutSettings } from './layout-modal';

// ============================================================
// Constants & Configuration
// ============================================================

const LINE_HEIGHT_MIN = 0.9;
const LINE_HEIGHT_MAX = 1.3;
const LINE_HEIGHT_STEP = 0.05;

// --- Visual Tweaks & Overlap Prevention ---
const BLEED_X = 4;
const BLEED_Y_NORMAL = 2;
const BLEED_Y_TIGHT = 0;
const TIGHT_LINE_HEIGHT_THRESHOLD = 24;

const DEFAULT_BG = '#ffffff';

// --- Safeguard Constants for Short Phrases/Headings ---
const SHORT_PHRASE_WORD_LIMIT = 4;
const SHORT_PHRASE_WIDTH_SAFETY_MARGIN_PX = 10;
const SHORT_PHRASE_PADDING_RIGHT_EM = 0.2;
const WIDTH_EXPANSION_LIMIT = 1.35;

// --- Auto-fit constants ---
const MIN_FONT_SIZE_PX = 6;
const FONT_SHRINK_FACTOR = 0.95;
const MAX_SHRINK_ITERATIONS = 40; // more iterations = finer fit
const MIN_LINE_HEIGHT_SHRINK = 0.85;

// Types for internal state
type OverlayHandlers = {
    contextHandler: EventListener;
    clickHandler?: EventListener;
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

    // Reusable measurement element — created once, reused every call (perf fix)
    private measureSpan: HTMLSpanElement | null = null;
    private selectedOverlays: Set<HTMLElement> = new Set();
    private selectionBox: HTMLDivElement | null = null;
    private marqueeActive = false;
    private marqueeStart: { x: number; y: number } | null = null;
    private marqueeContainer: HTMLElement | null = null;
    private marqueeHoldTimer: number | null = null;
    private marqueeHandlers: {
        down?: (event: MouseEvent) => void;
        move?: (event: MouseEvent) => void;
        up?: (event: MouseEvent) => void;
    } = {};

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureGlobalStyles();
        this.initMarqueeSelection();
    }

    /**
     * Injects CSS once to handle the "Borderless" look and Flexbox centering.
     *
     * FIX: Removed conflicting duplicate rule block for `.pdf-text-overlay-reflow`
     *      (the original had the class declared twice in the same <style> tag,
     *      causing the `-ms-overflow-style` / `scrollbar-width` declarations to be
     *      applied in a *separate* rule that also reset `display`, `flex-direction`
     *      etc. — defeating the flex layout for scrollbar-hiding in some browsers).
     *      Both sets of properties are now merged into one rule.
     *
     * FIX: `:hover { overflow: visible }` caused visible text bleed-through onto
     *      adjacent overlays. Replaced with a less aggressive `overflow: auto` so
     *      the user can still read overflowing content on hover without z-fighting.
     */
    private ensureGlobalStyles() {
        if (this.stylesInjected) return;
        const styleId = 'pdf-overlay-ui-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .pdf-text-overlay-reflow {
                    transition: box-shadow 0.2s ease, transform 0.1s ease, width 0.1s ease, height 0.1s ease;
                    -webkit-overflow-scrolling: touch;

                    /* Flexbox centers text vertically in the bbox */
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: flex-start;

                    /* Hide scrollbars (merged — was split into two rules before) */
                    -ms-overflow-style: none;
                    scrollbar-width: none;
                }

                .pdf-text-overlay-reflow::-webkit-scrollbar {
                    display: none;
                }

                /* Short phrases / headings: top-align so the first line is never clipped */
                .pdf-text-overlay-reflow.force-top-align {
                    justify-content: flex-start !important;
                }

                /* Scrollable fallback: switch to block so overflow:auto works correctly */
                .pdf-text-overlay-reflow.is-scrollable {
                    justify-content: flex-start !important;
                    display: block !important;
                    overflow: auto !important;
                }

                /* Hover: raise z-index and allow auto-scroll — NOT overflow:visible,
                   which would bleed text over neighbouring overlays. */
                .pdf-text-overlay-reflow:hover {
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06) !important;
                    z-index: 1000 !important;
                    overflow: auto !important;
                }

                .pdf-text-overlay-reflow.bbox-selected {
                    outline: 2px solid #1d7afc !important;
                    outline-offset: -1px;
                    box-shadow: 0 0 0 2px rgba(29, 122, 252, 0.25) !important;
                }
            `;
            document.head.appendChild(style);
        }
        this.stylesInjected = true;
    }

    private isBBoxEditMode(): boolean {
        return !!this.plugin.settings.bboxEditMode;
    }

    private initMarqueeSelection(): void {
        const startSelectionBox = (x: number, y: number) => {
            if (this.selectionBox) return;
            const box = document.createElement('div');
            box.style.position = 'fixed';
            box.style.left = `${x}px`;
            box.style.top = `${y}px`;
            box.style.width = '0px';
            box.style.height = '0px';
            box.style.border = '1px dashed #1d7afc';
            box.style.background = 'rgba(29,122,252,0.12)';
            box.style.pointerEvents = 'none';
            box.style.zIndex = '100000';
            document.body.appendChild(box);
            this.selectionBox = box;
        };

        const clearHoldTimer = () => {
            if (this.marqueeHoldTimer !== null) {
                window.clearTimeout(this.marqueeHoldTimer);
                this.marqueeHoldTimer = null;
            }
        };

        const onMouseDown = (event: MouseEvent) => {
            if (!this.isBBoxEditMode()) return;
            if (event.button !== 0) return;
            const target = event.target as HTMLElement | null;
            if (!target) return;
            const container = target.closest('.pdf-text-overlay-container') as HTMLElement | null;
            if (!container) return;
            const clickedOverlay = target.closest('.pdf-text-overlay-reflow');
            if (clickedOverlay) return;

            event.preventDefault();
            event.stopPropagation();
            this.marqueeActive = true;
            this.marqueeContainer = container;
            this.marqueeStart = { x: event.clientX, y: event.clientY };
            this.selectionBox?.remove();
            this.selectionBox = null;
            clearHoldTimer();
            // Hold LMB briefly to trigger marquee box, like standard bbox tools.
            this.marqueeHoldTimer = window.setTimeout(() => {
                if (!this.marqueeActive || !this.marqueeStart) return;
                startSelectionBox(this.marqueeStart.x, this.marqueeStart.y);
            }, 140);
        };

        const onMouseMove = (event: MouseEvent) => {
            if (!this.marqueeActive || !this.marqueeStart) return;
            const dist = Math.hypot(event.clientX - this.marqueeStart.x, event.clientY - this.marqueeStart.y);
            if (dist > 6 && !this.selectionBox) {
                clearHoldTimer();
                startSelectionBox(this.marqueeStart.x, this.marqueeStart.y);
            }
            if (!this.selectionBox) return;
            const left = Math.min(this.marqueeStart.x, event.clientX);
            const top = Math.min(this.marqueeStart.y, event.clientY);
            const width = Math.abs(event.clientX - this.marqueeStart.x);
            const height = Math.abs(event.clientY - this.marqueeStart.y);
            this.selectionBox.style.left = `${left}px`;
            this.selectionBox.style.top = `${top}px`;
            this.selectionBox.style.width = `${width}px`;
            this.selectionBox.style.height = `${height}px`;
        };

        const onMouseUp = (event: MouseEvent) => {
            if (!this.marqueeActive || !this.marqueeStart || !this.marqueeContainer) return;
            clearHoldTimer();
            const left = Math.min(this.marqueeStart.x, event.clientX);
            const top = Math.min(this.marqueeStart.y, event.clientY);
            const right = Math.max(this.marqueeStart.x, event.clientX);
            const bottom = Math.max(this.marqueeStart.y, event.clientY);

            if (this.selectionBox) {
                const overlays = Array.from(this.marqueeContainer.querySelectorAll<HTMLElement>('.pdf-text-overlay-reflow'));
                if (!event.ctrlKey && !event.metaKey) this.clearSelection();
                for (const ov of overlays) {
                    const r = ov.getBoundingClientRect();
                    const overlaps = !(r.right < left || r.left > right || r.bottom < top || r.top > bottom);
                    if (overlaps) {
                        this.selectedOverlays.add(ov);
                        this.updateSelectionVisual(ov, true);
                    }
                }
            }

            this.selectionBox?.remove();
            this.selectionBox = null;
            this.marqueeActive = false;
            this.marqueeStart = null;
            this.marqueeContainer = null;
        };

        this.marqueeHandlers = { down: onMouseDown, move: onMouseMove, up: onMouseUp };
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
    }

    private updateSelectionVisual(el: HTMLElement, isSelected: boolean): void {
        if (isSelected) el.classList.add('bbox-selected');
        else el.classList.remove('bbox-selected');
    }

    private clearSelection(): void {
        for (const el of this.selectedOverlays) {
            this.updateSelectionVisual(el, false);
        }
        this.selectedOverlays.clear();
    }

    private selectOverlay(el: HTMLElement, additive: boolean): void {
        if (!additive) this.clearSelection();
        this.selectedOverlays.add(el);
        this.updateSelectionVisual(el, true);
    }

    private toggleOverlaySelection(el: HTMLElement): void {
        if (this.selectedOverlays.has(el)) {
            this.selectedOverlays.delete(el);
            this.updateSelectionVisual(el, false);
        } else {
            this.selectedOverlays.add(el);
            this.updateSelectionVisual(el, true);
        }
    }

    // ============================================================
    // Private Helpers
    // ============================================================

    /**
     * Measures the pixel width of a string using a single reusable <span>.
     *
     * FIX (perf): The original created and destroyed a DOM node on *every call*.
     *             With many overlays this is very expensive. We now reuse one element.
     */
    private estimateTextWidth(text: string, fontSize: number, fontFamily: string): number {
        if (!this.measureSpan) {
            this.measureSpan = document.createElement('span');
            Object.assign(this.measureSpan.style, {
                position: 'absolute',
                visibility: 'hidden',
                whiteSpace: 'nowrap',
                top: '-9999px',
                left: '-9999px',
            });
            document.body.appendChild(this.measureSpan);
        }
        this.measureSpan.style.fontSize = `${fontSize}px`;
        this.measureSpan.style.fontFamily = fontFamily;
        this.measureSpan.textContent = text;
        return this.measureSpan.offsetWidth;
    }

    private pxFromEm(em: number, fontSizePx: number): number {
        return em * fontSizePx;
    }

    // ============================================================
    // Public API: Creation
    // ============================================================

    /**
     * Creates the DOM element for an overlay.
     *
     * KEY FIXES vs. original:
     *  1. `isShortPhrase` detection is decoupled from `force-top-align` class
     *     (the class was only applied to short phrases, but `adjustOverlayForOverflow`
     *     read the class to decide the branch — coupling class name to logic is fragile).
     *     A `data-is-short-phrase` attribute is now used for that gate.
     *  2. Short-phrase `overflow:visible` on the *outer* element allowed text to
     *     overwrite adjacent overlays at scale. We keep it hidden and only expand width.
     *  3. `adjustOverlayForOverflow` is called *after* the element is attached to the
     *     DOM (caller's responsibility noted in JSDoc) so that `scrollHeight` /
     *     `clientHeight` return real values, not 0.
     *     ⚠ If the caller inserts the element into the DOM before this returns it will
     *       still work; if not, the caller must call `adjustOverlayForOverflow` once
     *       the element is live.
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

        // --- 1. Short-phrase analysis ---
        const plainText = this.extractPlainTextFromHtml(htmlText).trim();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length; // FIX: filter empty tokens
        const isShortPhrase = wordCount <= SHORT_PHRASE_WORD_LIMIT;

        // --- 2. Tight-line detection ---
        const isTightLine = rect.height < TIGHT_LINE_HEIGHT_THRESHOLD;
        const currentBleedY = isTightLine ? BLEED_Y_TIGHT : BLEED_Y_NORMAL;

        const el = document.createElement('div');
        el.className = 'pdf-text-overlay-reflow';

        if (isShortPhrase) {
            el.classList.add('force-top-align');
        }

        // FIX: store short-phrase flag in data attr so sizing logic doesn't depend on CSS class name
        el.setAttribute('data-is-short-phrase', isShortPhrase ? 'true' : 'false');

        // --- 3. Font calculation ---
        const avgOriginalFontSize = originalFontSizes.length > 0
            ? originalFontSizes.reduce((a, b) => a + b, 0) / originalFontSizes.length
            : parseFloat(window.getComputedStyle(referenceSpan).fontSize) || 12;

        const baseFontSize = avgOriginalFontSize * outputFontSizeScale;
        const currentFontSize = baseFontSize * lastKnownScale;

        // --- 4. Positioning & dimensions ---
        const adjustedLeft   = rect.left - BLEED_X;
        const adjustedTop    = rect.top  - currentBleedY;
        const adjustedWidth  = rect.width  + (BLEED_X * 2);
        const adjustedHeight = rect.height + (currentBleedY * 2);

        Object.assign(el.style, {
            position:        'absolute',
            left:            `${adjustedLeft}px`,
            top:             `${adjustedTop}px`,
            width:           `${adjustedWidth}px`,
            height:          `${adjustedHeight}px`,
            padding:         '0px',
            fontSize:        `${currentFontSize}px`,
            fontFamily:      fontFamily || '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            overflow:        'hidden',
            boxSizing:       'border-box',
            zIndex:          '101',
            backgroundColor: 'var(--pdf-overlay-bg, #ffffff)',
            color:           '#000000',
            boxShadow:       `0 0 0 1px var(--pdf-overlay-bg, ${DEFAULT_BG})`,
            borderRadius:    '2px',
            textRendering:   'optimizeLegibility',
        });

        el.setAttribute('data-initial-width',  `${adjustedWidth}`);
        el.setAttribute('data-initial-left',   `${adjustedLeft}`);
        el.setAttribute('data-is-tight',        isTightLine ? 'true' : 'false');

        el.style.setProperty('--overlay-opacity', `${overlayOpacity}`);
        this.setOverlayElementVisibility(el, true);

        // --- 5. Inner text container ---
        const inner = document.createElement('div');
        Object.assign(inner.style, {
            whiteSpace:    'pre-wrap',
            wordBreak:     'break-word',
            overflowWrap:  'anywhere',
            width:         '100%',
            margin:        '0',
            textAlign:     'left',
        });
        inner.innerHTML = (htmlText || '').trim() || '…';
        el.appendChild(inner);

        // Short-phrase overrides: force nowrap, but keep outer overflow hidden
        // (original used overflow:visible on the outer element which caused bleed)
        if (isShortPhrase) {
            inner.style.whiteSpace  = 'nowrap';
            inner.style.overflow    = 'visible';
            // FIX: do NOT set el.style.overflow = 'visible' — bleeds over neighbours
            el.style.paddingRight   = `${SHORT_PHRASE_PADDING_RIGHT_EM}em`;
            el.style.minWidth       = `${adjustedWidth}px`;
        }

        // --- 6. Line height ---
        let startLH = outputLineHeight;
        if (isTightLine) {
            startLH = Math.min(outputLineHeight, 1.1);
        } else if (startLH > 1.2) {
            startLH = 1.2;
        }
        this.applyLineHeight(inner, startLH);

        // --- 7. Metadata ---
        el.setAttribute('data-original-text', originalTextContent);
        if (originalFontSizes.length > 0) {
            el.setAttribute('data-original-font-sizes', JSON.stringify(originalFontSizes));
        }

        // --- 8. Interaction events ---
        const contextHandler    = (event: Event) => this.showContextMenu(event, inner.textContent || '', el);
        const bringToTopHandler = () => this.bringToTop(el);
        const resetZIndexHandler = () => { el.style.zIndex = '101'; };
        const clickHandler = (event: Event) => {
            if (!this.isBBoxEditMode()) return;
            const me = event as MouseEvent;
            me.preventDefault();
            me.stopPropagation();
            if (me.ctrlKey || me.metaKey) {
                this.toggleOverlaySelection(el);
            } else {
                this.selectOverlay(el, false);
            }
        };

        el.addEventListener('contextmenu', contextHandler);
        el.addEventListener('mouseover',   bringToTopHandler);
        el.addEventListener('mouseleave',  resetZIndexHandler);
        el.addEventListener('click', clickHandler);

        this.createdOverlays.set(el, { contextHandler, clickHandler, bringToTopHandler, resetZIndexHandler });
        this.trackedOverlayElements.add(el);

        // NOTE: adjustOverlayForOverflow reads scrollHeight/clientHeight which require
        // the element to be in the DOM. If your caller appends *after* createReflowOverlay
        // returns, call adjustOverlayForOverflow(el, startLH) immediately after appending.
        this.adjustOverlayForOverflow(el, startLH);

        return el;
    }

    // ============================================================
    // Public API: Post-Processing Overlap Fixer
    // ============================================================

    /**
     * Resolves vertical overlaps between overlay elements after they are all placed.
     *
     * FIX: The original only compared each element to the *immediately next* sorted
     *      element. If two non-adjacent boxes overlapped (e.g., a tall box spanning
     *      several short ones), those were silently skipped.
     *      Now each box is checked against ALL subsequent boxes, not just index i+1.
     *
     * FIX: parseFloat(el.style.top) returns NaN when top is not set inline.
     *      Falls back to getBoundingClientRect() for robustness.
     */
    public fixVerticalOverlaps(overlays: HTMLElement[]): void {
        if (!overlays || overlays.length < 2) return;

        const getTop    = (el: HTMLElement) => parseFloat(el.style.top)    || el.getBoundingClientRect().top;
        const getHeight = (el: HTMLElement) => parseFloat(el.style.height) || el.getBoundingClientRect().height;

        const sorted = [...overlays].sort((a, b) => getTop(a) - getTop(b));

        for (let i = 0; i < sorted.length - 1; i++) {
            const current = sorted[i];
            if (current.style.display === 'none') continue;

            const currentTop    = getTop(current);
            const currentHeight = getHeight(current);
            let   currentBottom = currentTop + currentHeight;

            // FIX: check against ALL subsequent boxes, not just i+1
            for (let j = i + 1; j < sorted.length; j++) {
                const next = sorted[j];
                if (next.style.display === 'none') continue;

                const nextTop = getTop(next);
                if (currentBottom <= nextTop - 1) break; // sorted — no further collisions possible

                const newBottom = nextTop - 1;
                const newHeight = newBottom - currentTop;

                if (newHeight > 8) {
                    current.style.height = `${newHeight}px`;
                    currentBottom = newBottom; // update for subsequent checks

                    const innerEl = current.querySelector('div') as HTMLDivElement | null;
                    const lh = innerEl ? parseFloat(innerEl.style.lineHeight) || 1.1 : 1.1;
                    this.adjustOverlayForOverflow(current, lh);
                }
                break; // once we've resolved the first collision, stop (box is now smaller)
            }
        }
    }

    // ============================================================
    // Sizing Logic (Overflow & Fit)
    // ============================================================

    /**
     * Fits text inside the bounding box using a shrink-first, then line-height-reduce,
     * then scroll fallback strategy.
     *
     * CORE FIXES:
     *  1. Short-phrase detection now reads `data-is-short-phrase` instead of the CSS
     *     class `force-top-align` — prevents misclassification when the class is
     *     toggled externally.
     *  2. Short-phrase branch: width expansion is tried first; if the box is already
     *     wide enough we skip it. Font shrink loop is retained as a safety net.
     *     `overflow:visible` is no longer set on the outer element.
     *  3. Long-text branch: after font shrink, we now *also* reset font size if the
     *     content fits at a *larger* size (i.e., it was shrunk in a previous call but
     *     the box was later enlarged by fixVerticalOverlaps — previously it would stay
     *     tiny forever).
     *  4. Removed the `el.style.overflow = 'auto'` line in Strategy 3; this is now
     *     handled exclusively by the `is-scrollable` CSS class to avoid inline style
     *     vs. class conflicts.
     */
    public adjustOverlayForOverflow(el: HTMLElement, outputLineHeight: number): void {
        const inner = el.querySelector('div') as HTMLDivElement | null;
        if (!inner) return;

        const isShortPhrase = el.getAttribute('data-is-short-phrase') === 'true';

        // Reset scrollable state
        el.classList.remove('is-scrollable');
        el.style.overflow = 'hidden';

        // ----------------------------------------------------------------
        // SHORT PHRASE — measurement-based width expansion, then font-shrink
        // ----------------------------------------------------------------
        if (isShortPhrase) {
            inner.style.whiteSpace = 'nowrap';
            inner.style.overflow   = 'visible';
            // Keep outer hidden so we don't bleed — visual overflow is via inner

            const currentFontSize = parseFloat(el.style.fontSize) || 12;
            const fontFamily      = el.style.fontFamily || 'sans-serif';
            const plainText       = inner.textContent || '';
            if (!plainText.trim()) return;

            const requiredTextWidth = this.estimateTextWidth(plainText, currentFontSize, fontFamily);
            const paddingRightPx    = this.pxFromEm(SHORT_PHRASE_PADDING_RIGHT_EM, currentFontSize);
            let targetWidth         = requiredTextWidth + paddingRightPx + SHORT_PHRASE_WIDTH_SAFETY_MARGIN_PX;

            const initialWidth = parseFloat(el.getAttribute('data-initial-width') || '0') || parseFloat(el.style.width);
            const maxWidth     = initialWidth * WIDTH_EXPANSION_LIMIT;
            targetWidth        = Math.min(targetWidth, maxWidth);

            // Only expand — never shrink the width
            if (targetWidth > (el.offsetWidth || parseFloat(el.style.width))) {
                el.style.width = `${targetWidth}px`;
            }

            // Safety: if text still overflows width after expansion → shrink font
            if (inner.scrollWidth > (el.clientWidth || parseFloat(el.style.width)) + 1) {
                let fs = parseFloat(el.style.fontSize);
                let iterations = 0;
                while (inner.scrollWidth > el.clientWidth + 1 && fs > MIN_FONT_SIZE_PX && iterations < MAX_SHRINK_ITERATIONS) {
                    fs *= FONT_SHRINK_FACTOR;
                    el.style.fontSize = `${fs}px`;
                    iterations++;
                }
            }

            // Short phrases never get a scrollbar
            return;
        }

        // ----------------------------------------------------------------
        // LONG TEXT — shrink font → shrink line-height → scroll fallback
        // ----------------------------------------------------------------

        const isOverflowing = () =>
            inner.scrollHeight > el.clientHeight + 1 ||
            inner.scrollWidth  > el.clientWidth  + 1;

        if (!isOverflowing()) {
            // FIX: box may have been grown (e.g. after fixVerticalOverlaps re-runs this).
            // Try to recover font size up toward original if there's now spare room.
            // (This is a mild upward-fit — only a few steps to avoid expensive loops.)
            const originalFontSize = parseFloat(el.getAttribute('data-original-font-size') || '0');
            if (originalFontSize > 0) {
                let fs = parseFloat(el.style.fontSize);
                let attempts = 0;
                while (!isOverflowing() && fs < originalFontSize && attempts < 10) {
                    el.style.fontSize = `${Math.min(fs / FONT_SHRINK_FACTOR, originalFontSize)}px`;
                    if (isOverflowing()) { el.style.fontSize = `${fs}px`; break; }
                    fs = parseFloat(el.style.fontSize);
                    attempts++;
                }
            }
            return;
        }

        // Strategy 1 — Shrink font size
        // FIX: cache the starting size as data-original-font-size so we can recover later
        if (!el.getAttribute('data-original-font-size')) {
            el.setAttribute('data-original-font-size', el.style.fontSize);
        }

        let currentFontSize = parseFloat(el.style.fontSize);
        let iterations = 0;
        while (isOverflowing() && currentFontSize > MIN_FONT_SIZE_PX && iterations < MAX_SHRINK_ITERATIONS) {
            currentFontSize *= FONT_SHRINK_FACTOR;
            el.style.fontSize = `${currentFontSize}px`;
            iterations++;
        }

        // Strategy 2 — Shrink line height
        if (isOverflowing()) {
            let currentLineHeight = outputLineHeight;
            let lhIterations = 0;
            while (currentLineHeight > MIN_LINE_HEIGHT_SHRINK && isOverflowing() && lhIterations < 10) {
                currentLineHeight -= 0.05;
                this.applyLineHeight(inner, currentLineHeight);
                lhIterations++;
            }
        }

        // Strategy 3 — Scrollable fallback
        if (isOverflowing()) {
            // Ensure a minimum readable size before enabling scroll
            if (currentFontSize < 9) {
                el.style.fontSize = '9px';
            }
            // FIX: don't set overflow:auto inline — let CSS class handle it
            el.classList.add('is-scrollable');
            if (this.plugin.settings.debugMode) {
                console.debug('[OverlayUIRenderer] Fallback scroll enabled for:', inner.textContent?.substring(0, 30));
            }
        }
    }

    // ============================================================
    // Manual Adjustments
    // ============================================================

    public adjustSingleOverlayLineHeight(overlayEl: HTMLElement, delta: number): void {
        const inner = overlayEl.querySelector('div') as HTMLDivElement | null;
        if (!inner) return;
        try {
            const currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;
            let newValue = Math.round((currentLineHeight + delta) * 100) / 100; // FIX: round before clamp
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            this.applyLineHeight(inner, newValue);
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
            const newSize = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, currentSize * scaleFactor));
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
            if (parseFloat(op) >= 0.95) {
                el.style.opacity = '1';
                el.style.backgroundColor = 'var(--pdf-overlay-bg, #ffffff)';
            } else {
                el.style.opacity = op;
            }
            el.style.pointerEvents = 'auto';
            el.style.visibility    = 'visible';
        } else {
            el.style.opacity       = '0';
            el.style.pointerEvents = 'none';
            el.style.visibility    = 'hidden';
        }
    }

    public bringToTop(el: HTMLElement): void {
        let maxZIndex = 100;
        document.querySelectorAll('.pdf-text-overlay-reflow').forEach(overlay => {
            const z = parseInt(window.getComputedStyle(overlay).zIndex, 10);
            if (!isNaN(z) && z > maxZIndex) maxZIndex = z;
        });
        el.style.zIndex = `${maxZIndex + 1}`;
    }

    private getOverlayIndex(el: HTMLElement): number {
        const fromAttr = parseInt(el.getAttribute('data-overlay-index') || '', 10);
        if (Number.isFinite(fromAttr)) return fromAttr;
        const container = el.parentElement;
        if (!container) return -1;
        const siblings = Array.from(container.children).filter(ch => ch.classList.contains('pdf-text-overlay-reflow'));
        return siblings.indexOf(el);
    }

    private getSelectionForAction(targetOverlay: HTMLElement): HTMLElement[] {
        if (!this.isBBoxEditMode()) return [targetOverlay];
        if (!this.selectedOverlays.has(targetOverlay)) {
            this.selectOverlay(targetOverlay, false);
        }
        return [...this.selectedOverlays].filter(el => el.isConnected);
    }

    private sortIndicesByMode(
        indices: number[],
        pageItems: OverlayPositionData[],
        mode: 'column' | 'table' | 'block' | 'paragraphs' | 'split'
    ): number[] {
        const sorted = [...indices];
        sorted.sort((a, b) => {
            const ra = pageItems[a]?.relativeRect;
            const rb = pageItems[b]?.relativeRect;
            if (!ra || !rb) return a - b;
            if (mode === 'column') {
                if (Math.abs(ra.left - rb.left) > 0.03) return ra.left - rb.left;
                return ra.top - rb.top;
            }
            // table + block default to row-major
            if (Math.abs(ra.top - rb.top) > 0.01) return ra.top - rb.top;
            return ra.left - rb.left;
        });
        return sorted;
    }

    private relayoutAsColumns(pageItems: OverlayPositionData[], selected: number[]): OverlayPositionData[] {
        const updated = pageItems.map(x => ({ ...x, relativeRect: { ...x.relativeRect } }));
        if (selected.length < 2) return updated;
        const centers = selected
            .map(i => ({ i, x: updated[i].relativeRect.left + updated[i].relativeRect.width / 2 }))
            .sort((a, b) => a.x - b.x);
        const threshold = 0.05;
        const columns: number[][] = [];
        for (const c of centers) {
            const lastCol = columns[columns.length - 1];
            if (!lastCol) {
                columns.push([c.i]);
                continue;
            }
            const lastCenter = lastCol
                .map(idx => updated[idx].relativeRect.left + updated[idx].relativeRect.width / 2)
                .reduce((a, b) => a + b, 0) / lastCol.length;
            if (Math.abs(c.x - lastCenter) <= threshold) lastCol.push(c.i);
            else columns.push([c.i]);
        }
        for (const col of columns) {
            const left = Math.min(...col.map(i => updated[i].relativeRect.left));
            const right = Math.max(...col.map(i => updated[i].relativeRect.left + updated[i].relativeRect.width));
            for (const i of col) {
                updated[i].relativeRect.left = left;
                updated[i].relativeRect.width = Math.max(0.005, right - left);
            }
        }
        return updated;
    }

    private relayoutAsTable(pageItems: OverlayPositionData[], selected: number[]): OverlayPositionData[] {
        const updated = pageItems.map(x => ({ ...x, relativeRect: { ...x.relativeRect } }));
        if (selected.length < 4) return updated;

        const heights = selected.map(i => updated[i].relativeRect.height).sort((a, b) => a - b);
        const widths = selected.map(i => updated[i].relativeRect.width).sort((a, b) => a - b);
        const medH = heights[Math.floor(heights.length / 2)] || 0.02;
        const medW = widths[Math.floor(widths.length / 2)] || 0.05;
        const rowTol = Math.max(0.008, medH * 0.6);
        const colTol = Math.max(0.01, medW * 0.6);

        const rowCenters = selected
            .map(i => ({ i, y: updated[i].relativeRect.top + updated[i].relativeRect.height / 2 }))
            .sort((a, b) => a.y - b.y);
        const colCenters = selected
            .map(i => ({ i, x: updated[i].relativeRect.left + updated[i].relativeRect.width / 2 }))
            .sort((a, b) => a.x - b.x);

        const rows: number[][] = [];
        for (const r of rowCenters) {
            const last = rows[rows.length - 1];
            if (!last) { rows.push([r.i]); continue; }
            const cy = last.map(i => updated[i].relativeRect.top + updated[i].relativeRect.height / 2).reduce((a, b) => a + b, 0) / last.length;
            if (Math.abs(r.y - cy) <= rowTol) last.push(r.i);
            else rows.push([r.i]);
        }
        const cols: number[][] = [];
        for (const c of colCenters) {
            const last = cols[cols.length - 1];
            if (!last) { cols.push([c.i]); continue; }
            const cx = last.map(i => updated[i].relativeRect.left + updated[i].relativeRect.width / 2).reduce((a, b) => a + b, 0) / last.length;
            if (Math.abs(c.x - cx) <= colTol) last.push(c.i);
            else cols.push([c.i]);
        }
        if (rows.length < 2 || cols.length < 2) return updated;

        const rowBounds = rows.map(group => ({
            top: Math.min(...group.map(i => updated[i].relativeRect.top)),
            bottom: Math.max(...group.map(i => updated[i].relativeRect.top + updated[i].relativeRect.height))
        }));
        const colBounds = cols.map(group => ({
            left: Math.min(...group.map(i => updated[i].relativeRect.left)),
            right: Math.max(...group.map(i => updated[i].relativeRect.left + updated[i].relativeRect.width))
        }));

        for (const i of selected) {
            const rect = updated[i].relativeRect;
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const rowIdx = rowBounds.reduce((best, rb, idx) =>
                Math.abs((rb.top + rb.bottom) / 2 - cy) < Math.abs((rowBounds[best].top + rowBounds[best].bottom) / 2 - cy) ? idx : best, 0);
            const colIdx = colBounds.reduce((best, cb, idx) =>
                Math.abs((cb.left + cb.right) / 2 - cx) < Math.abs((colBounds[best].left + colBounds[best].right) / 2 - cx) ? idx : best, 0);
            const rb = rowBounds[rowIdx];
            const cb = colBounds[colIdx];
            updated[i].relativeRect.top = rb.top;
            updated[i].relativeRect.height = Math.max(0.004, rb.bottom - rb.top);
            updated[i].relativeRect.left = cb.left;
            updated[i].relativeRect.width = Math.max(0.004, cb.right - cb.left);
        }

        return updated;
    }

    private splitTextByWeights(text: string, weights: number[]): string[] {
        const clean = (text || '').trim();
        if (!clean || !weights.length) return weights.map(() => '');
        const total = Math.max(1, weights.reduce((a, b) => a + Math.max(1, b), 0));
        const words = clean.split(/\s+/).filter(Boolean);
        if (!words.length) return weights.map(() => '');

        const out: string[] = [];
        let cursor = 0;
        for (let i = 0; i < weights.length; i++) {
            const remainingBuckets = weights.length - i;
            const remainingWords = words.length - cursor;
            if (remainingBuckets <= 1) {
                out.push(words.slice(cursor).join(' '));
                break;
            }
            const frac = Math.max(1, weights[i]) / total;
            const targetCount = Math.max(1, Math.round(words.length * frac));
            const take = Math.min(remainingWords - (remainingBuckets - 1), targetCount);
            out.push(words.slice(cursor, cursor + take).join(' '));
            cursor += take;
        }
        while (out.length < weights.length) out.push('');
        return out;
    }

    private async retranslateSelection(
        pageItems: OverlayPositionData[],
        selectedIndices: number[],
        mode: 'column' | 'table' | 'block' | 'paragraphs' | 'split'
    ): Promise<OverlayPositionData[]> {
        const updated = pageItems.map(item => ({ ...item }));
        const ordered = this.sortIndicesByMode(selectedIndices, pageItems, mode);

        if (mode === 'block') {
            const joined = ordered.map(i => pageItems[i]?.textContent || pageItems[i]?.translatedText || '').join('\n\n').trim();
            if (!joined) return updated;
            const translated = await this.plugin.translation.translateWithOpenRouter(joined);
            const weights = ordered.map(i => (pageItems[i]?.textContent || '').length || 1);
            const parts = this.splitTextByWeights(translated, weights);
            ordered.forEach((idx, i) => {
                updated[idx].translatedText = parts[i] || updated[idx].translatedText;
            });
            return updated;
        }

        for (const idx of ordered) {
            const source = (pageItems[idx]?.textContent || pageItems[idx]?.translatedText || '').trim();
            if (!source) continue;
            const prompt =
                mode === 'table'
                    ? `Translate this table cell. Keep it concise and cell-local:\n${source}`
                    : mode === 'paragraphs'
                        ? `Translate this paragraph naturally and preserve paragraph meaning:\n${source}`
                        : mode === 'split'
                            ? `Translate this text fragment independently and clearly:\n${source}`
                            : `Translate this column fragment preserving context:\n${source}`;
            const line = await this.plugin.translation.translateWithOpenRouter(prompt);
            if (line?.trim()) updated[idx].translatedText = line.trim();
        }
        return updated;
    }

    private buildLayoutSettingsForBBoxMode(
        mode: 'column' | 'table' | 'paragraphs' | 'split' | 'block',
        base: LayoutSettings
    ): LayoutSettings {
        if (mode === 'column') {
            return {
                ...base,
                useModeEnsemble: false,
                minStripConfidence: Math.min(base.minStripConfidence, 0.4),
                minStripWidthPx: Math.min(base.minStripWidthPx, 2),
                maxIterMerges: Math.min(base.maxIterMerges, 4),
                gapMinGapWidthPx: Math.min(base.gapMinGapWidthPx, 1),
                gapBandStepFactor: Math.min(base.gapBandStepFactor, 0.55),
                gapMinStripHeightFactor: Math.min(base.gapMinStripHeightFactor, 1.0),
                gapCenterXTolFactor: Math.max(base.gapCenterXTolFactor, 0.85),
                gridMinVerticalGapLineHeightMultiplier: Math.min(base.gridMinVerticalGapLineHeightMultiplier, 0.45),
                gridEdgeMarginLineHeightMultiplier: Math.min(base.gridEdgeMarginLineHeightMultiplier, 0.5),
                gridProjectionProfileThreshold: Math.min(base.gridProjectionProfileThreshold, 0.45),
                pmMinStripConfidenceSplit: Math.min(base.pmMinStripConfidenceSplit, 0.35),
                pmMinStripWidthPx: Math.min(base.pmMinStripWidthPx, 2),
                pmMinStripOverlapFrac: Math.min(base.pmMinStripOverlapFrac, 0.35),
                pmGeneralMergeVerticalGapMultiplier: Math.min(base.pmGeneralMergeVerticalGapMultiplier, 0.95),
                pmGeneralMergeVerticalGapMaxMultiplier: Math.min(base.pmGeneralMergeVerticalGapMaxMultiplier, 1.35),
                pmStackedMergeVerticalGapMultiplier: Math.min(base.pmStackedMergeVerticalGapMultiplier, 0.95),
                pmStackedMergeVerticalGapMaxMultiplier: Math.min(base.pmStackedMergeVerticalGapMaxMultiplier, 1.35),
                pmSplitBoundaryDedupTol: Math.min(base.pmSplitBoundaryDedupTol, 0.16),
                pmSplitInterWordGapTol: Math.min(base.pmSplitInterWordGapTol, 0.8),
                pmSplitColumnGapTol: Math.min(base.pmSplitColumnGapTol, 1.55),
                profileColumnSpanScoreWeight: Math.max(base.profileColumnSpanScoreWeight, 2.6),
                profileColumnWinMargin: Math.min(base.profileColumnWinMargin, 0.1),
                profileRegionColumnsDensityRatioMin: Math.min(base.profileRegionColumnsDensityRatioMin, 0.48),
                profileRegionColumnsCostBias: Math.min(base.profileRegionColumnsCostBias, -0.75),
                profileRegionFlowCostBias: Math.max(base.profileRegionFlowCostBias, 0.85),
            };
        }

        if (mode === 'paragraphs') {
            return {
                ...base,
                useModeEnsemble: false,
                minStripConfidence: Math.min(base.minStripConfidence, 0.5),
                minStripWidthPx: Math.min(base.minStripWidthPx, 2.5),
                maxIterMerges: Math.min(base.maxIterMerges, 6),
                gapMinGapWidthPx: Math.min(base.gapMinGapWidthPx, 1.2),
                gapBandStepFactor: Math.min(base.gapBandStepFactor, 0.6),
                gapMinStripHeightFactor: Math.min(base.gapMinStripHeightFactor, 1.1),
                gridMinHorizontalGapLineHeightMultiplier: Math.min(base.gridMinHorizontalGapLineHeightMultiplier, 1.1),
                gridMinVerticalGapLineHeightMultiplier: Math.min(base.gridMinVerticalGapLineHeightMultiplier, 0.55),
                gridProjectionProfileThreshold: Math.min(base.gridProjectionProfileThreshold, 0.6),
                pmMinStripConfidenceSplit: Math.min(base.pmMinStripConfidenceSplit, 0.5),
                pmMinStripWidthPx: Math.min(base.pmMinStripWidthPx, 2),
                pmGeneralMergeVerticalGapMultiplier: Math.min(base.pmGeneralMergeVerticalGapMultiplier, 0.95),
                pmGeneralMergeVerticalGapMaxMultiplier: Math.min(base.pmGeneralMergeVerticalGapMaxMultiplier, 1.5),
                pmStackedMergeVerticalGapMultiplier: Math.min(base.pmStackedMergeVerticalGapMultiplier, 0.95),
                pmStackedMergeVerticalGapMaxMultiplier: Math.min(base.pmStackedMergeVerticalGapMaxMultiplier, 1.5),
                pmSplitBoundaryDedupTol: Math.min(base.pmSplitBoundaryDedupTol, 0.18),
                pmSplitInterWordGapTol: Math.min(base.pmSplitInterWordGapTol, 0.85),
                pmSplitColumnGapTol: Math.min(base.pmSplitColumnGapTol, 1.8),
                profileRegionFlowCostBias: Math.min(base.profileRegionFlowCostBias, 0.05),
            };
        }

        if (mode === 'split') {
            return {
                ...base,
                useModeEnsemble: false,
                minStripConfidence: Math.min(base.minStripConfidence, 0.3),
                minStripWidthPx: Math.min(base.minStripWidthPx, 1),
                maxIterMerges: Math.min(base.maxIterMerges, 1),
                gapMinGapWidthPx: Math.min(base.gapMinGapWidthPx, 1),
                gapBandStepFactor: Math.min(base.gapBandStepFactor, 0.45),
                gapMinStripHeightFactor: Math.min(base.gapMinStripHeightFactor, 0.75),
                gapCenterXTolFactor: Math.max(base.gapCenterXTolFactor, 0.9),
                gridMinHorizontalGapLineHeightMultiplier: Math.min(base.gridMinHorizontalGapLineHeightMultiplier, 0.75),
                gridMinVerticalGapLineHeightMultiplier: Math.min(base.gridMinVerticalGapLineHeightMultiplier, 0.35),
                gridEdgeMarginLineHeightMultiplier: Math.min(base.gridEdgeMarginLineHeightMultiplier, 0.45),
                gridProjectionProfileThreshold: Math.min(base.gridProjectionProfileThreshold, 0.35),
                pmMinStripConfidenceSplit: Math.min(base.pmMinStripConfidenceSplit, 0.25),
                pmMinStripWidthPx: Math.min(base.pmMinStripWidthPx, 1),
                pmMinStripOverlapFrac: Math.min(base.pmMinStripOverlapFrac, 0.2),
                pmGeneralMergeVerticalGapMultiplier: Math.min(base.pmGeneralMergeVerticalGapMultiplier, 0.7),
                pmGeneralMergeVerticalGapMaxMultiplier: Math.min(base.pmGeneralMergeVerticalGapMaxMultiplier, 1.0),
                pmStackedMergeVerticalGapMultiplier: Math.min(base.pmStackedMergeVerticalGapMultiplier, 0.7),
                pmStackedMergeVerticalGapMaxMultiplier: Math.min(base.pmStackedMergeVerticalGapMaxMultiplier, 1.0),
                pmSplitBoundaryDedupTol: Math.min(base.pmSplitBoundaryDedupTol, 0.06),
                pmSplitInterWordGapTol: Math.min(base.pmSplitInterWordGapTol, 0.5),
                pmSplitColumnGapTol: Math.min(base.pmSplitColumnGapTol, 1.05),
                profileTableMaxFragmentationRatio: Math.max(base.profileTableMaxFragmentationRatio, 0.98),
            };
        }

        if (mode === 'block') {
            return {
                ...base,
                useModeEnsemble: false,
                pmForceLinearMerge: true,
                minStripConfidence: Math.max(base.minStripConfidence, 0.75),
                pmMinStripConfidenceSplit: Math.max(base.pmMinStripConfidenceSplit, 0.75),
                maxIterMerges: Math.max(base.maxIterMerges, 12),
                pmGeneralMergeVerticalGapMultiplier: Math.max(base.pmGeneralMergeVerticalGapMultiplier, 1.6),
                pmGeneralMergeVerticalGapMaxMultiplier: Math.max(base.pmGeneralMergeVerticalGapMaxMultiplier, 2.8),
                profileRegionFlowCostBias: Math.min(base.profileRegionFlowCostBias, -0.25),
            };
        }

        return {
            ...base,
            useModeEnsemble: false,
            minStripConfidence: Math.min(base.minStripConfidence, 0.45),
            minStripWidthPx: Math.min(base.minStripWidthPx, 2),
            maxIterMerges: Math.min(base.maxIterMerges, 5),
            gapMinGapWidthPx: Math.min(base.gapMinGapWidthPx, 1),
            gapBandStepFactor: Math.min(base.gapBandStepFactor, 0.55),
            gapMinStripHeightFactor: Math.min(base.gapMinStripHeightFactor, 1.0),
            gapCenterXTolFactor: Math.max(base.gapCenterXTolFactor, 0.7),
            gridMinHorizontalGapLineHeightMultiplier: Math.min(base.gridMinHorizontalGapLineHeightMultiplier, 1.0),
            gridMinVerticalGapLineHeightMultiplier: Math.min(base.gridMinVerticalGapLineHeightMultiplier, 0.5),
            gridProjectionProfileThreshold: Math.min(base.gridProjectionProfileThreshold, 0.5),
            pmMinStripConfidenceSplit: Math.min(base.pmMinStripConfidenceSplit, 0.45),
            pmMinStripWidthPx: Math.min(base.pmMinStripWidthPx, 2),
            pmMinStripOverlapFrac: Math.min(base.pmMinStripOverlapFrac, 0.4),
            pmGeneralMergeVerticalGapMultiplier: Math.min(base.pmGeneralMergeVerticalGapMultiplier, 1.0),
            pmGeneralMergeVerticalGapMaxMultiplier: Math.min(base.pmGeneralMergeVerticalGapMaxMultiplier, 1.4),
            pmStackedMergeVerticalGapMultiplier: Math.min(base.pmStackedMergeVerticalGapMultiplier, 1.0),
            pmStackedMergeVerticalGapMaxMultiplier: Math.min(base.pmStackedMergeVerticalGapMaxMultiplier, 1.4),
            pmSplitBoundaryDedupTol: Math.min(base.pmSplitBoundaryDedupTol, 0.15),
            pmSplitInterWordGapTol: Math.min(base.pmSplitInterWordGapTol, 0.75),
            pmSplitColumnGapTol: Math.min(base.pmSplitColumnGapTol, 1.6),
            profileTableMinParagraphSpans: Math.min(base.profileTableMinParagraphSpans, 6),
            profileTableMinRows: Math.min(base.profileTableMinRows, 2),
            profileTableMinDistinctCols: Math.min(base.profileTableMinDistinctCols, 2),
            profileTableMinMultiCellRowRatio: Math.min(base.profileTableMinMultiCellRowRatio, 0.5),
            profileTableMinAvgCellsPerRow: Math.min(base.profileTableMinAvgCellsPerRow, 1.7),
            profileTableBoundaryMinRepeatsAbs: Math.min(base.profileTableBoundaryMinRepeatsAbs, 1),
            profileTableBoundaryMinRepeatsRowFrac: Math.min(base.profileTableBoundaryMinRepeatsRowFrac, 0.3),
            profileRegionTableDensityRatioMin: Math.min(base.profileRegionTableDensityRatioMin, 0.55),
            profileRegionTableOccupancyMin: Math.min(base.profileRegionTableOccupancyMin, 0.03),
        };
    }

    private getSelectedSpanPool(
        pageItems: OverlayPositionData[],
        selectedIndices: number[],
        pageEl: HTMLElement,
        textLayer: HTMLElement
    ): HTMLSpanElement[] {
        const pageRect = pageEl.getBoundingClientRect();
        const selectedRects = selectedIndices
            .map(i => pageItems[i]?.relativeRect)
            .filter((r): r is OverlayPositionData['relativeRect'] => !!r)
            .map(r => ({
                left: pageRect.left + r.left * pageRect.width,
                top: pageRect.top + r.top * pageRect.height,
                right: pageRect.left + (r.left + r.width) * pageRect.width,
                bottom: pageRect.top + (r.top + r.height) * pageRect.height,
            }));

        if (!selectedRects.length) return [];

        const spans = Array.from(textLayer.querySelectorAll<HTMLSpanElement>('span'))
            .filter(span => this.plugin.processor.isValidSpan(span))
            .filter(span => {
                const r = span.getBoundingClientRect();
                return selectedRects.some(s =>
                    !(r.right < s.left || r.left > s.right || r.bottom < s.top || r.top > s.bottom)
                );
            });

        return spans;
    }

    private async retranslateSelectionWithLayoutMode(
        pageItems: OverlayPositionData[],
        selectedIndices: number[],
        mode: 'column' | 'table' | 'paragraphs' | 'split' | 'block'
    ): Promise<OverlayPositionData[]> {
        const pageNumber = this.plugin.getCurrentPageNumber();
        if (pageNumber == null) {
            return mode === 'split'
                ? this.splitSelectedByParagraphs(pageItems, selectedIndices)
                : this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
        const textLayer = pageEl?.querySelector<HTMLElement>('.textLayer');
        if (!pageEl || !textLayer) {
            return mode === 'split'
                ? this.splitSelectedByParagraphs(pageItems, selectedIndices)
                : this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const selectedSpans = this.getSelectedSpanPool(pageItems, selectedIndices, pageEl, textLayer);
        if (!selectedSpans.length) {
            return mode === 'split'
                ? this.splitSelectedByParagraphs(pageItems, selectedIndices)
                : this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const originalSettings = { ...this.plugin.layoutSettings };
        const tuned = this.buildLayoutSettingsForBBoxMode(mode, originalSettings);
        const viewer = pageEl.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const currentScale = parseFloat(viewer?.style.getPropertyValue('--scale-factor') || '1') || 1;

        try {
            this.plugin.processor.updateLayoutDetectorSettings(tuned, true);
            const units = this.plugin.processor.prepareTranslationUnits(selectedSpans, pageEl);
            if (!units || units.length === 0) {
                return mode === 'split'
                    ? this.splitSelectedByParagraphs(pageItems, selectedIndices)
                    : this.retranslateSelection(pageItems, selectedIndices, mode);
            }

            if (mode === 'block') {
                const joined = units.map(u => u.text).join('\n\n').trim();
                if (!joined) {
                    return this.retranslateSelection(pageItems, selectedIndices, mode);
                }
                const translatedBlock = await this.plugin.translation.translateWithOpenRouter(
                    `Translate as one coherent text block:\n${joined}`
                );
                const bbox = this.plugin.processor.getSpansBbox(selectedSpans, pageEl);
                if (!bbox.rect) {
                    return this.retranslateSelection(pageItems, selectedIndices, mode);
                }
                const pageRect = pageEl.getBoundingClientRect();
                const blockRect = {
                    left: bbox.rect.left / pageRect.width,
                    top: bbox.rect.top / pageRect.height,
                    width: bbox.rect.width / pageRect.width,
                    height: bbox.rect.height / pageRect.height,
                };
                if (!isFinite(blockRect.left) || !isFinite(blockRect.top) || !isFinite(blockRect.width) || !isFinite(blockRect.height)) {
                    return this.retranslateSelection(pageItems, selectedIndices, mode);
                }
                const drop = new Set(selectedIndices);
                const preserved = pageItems
                    .filter((_, idx) => !drop.has(idx))
                    .map(x => ({ ...x, relativeRect: { ...x.relativeRect } }));
                return [
                    ...preserved,
                    {
                        selector: '',
                        textContent: joined,
                        translatedText: translatedBlock?.trim() || joined,
                        relativeRect: blockRect,
                        page: pageNumber,
                        originalFontSizes: bbox.fontSizes.map(s => s / currentScale),
                        fontSize: bbox.avgFontSize / currentScale,
                        fontFamily: bbox.fontFamily,
                    }
                ].sort((a, b) => {
                    if (Math.abs(a.relativeRect.top - b.relativeRect.top) > 0.003) {
                        return a.relativeRect.top - b.relativeRect.top;
                    }
                    return a.relativeRect.left - b.relativeRect.left;
                });
            }

            const translated = await this.plugin.processor.executeTranslation(units);
            const pageRect = pageEl.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const normPageRect = new DOMRect(
                pageRect.left / dpr,
                pageRect.top / dpr,
                pageRect.width / dpr,
                pageRect.height / dpr
            );
            const snapColumns = mode === 'column'
                ? (this.plugin.processor.layoutDetector
                    .detectLayout(selectedSpans, pageEl)
                    .columnAnalysis.columns || [])
                : [];
            const replacementItems: OverlayPositionData[] = [];

            for (let i = 0; i < units.length; i++) {
                const unit = units[i];
                const bbox = this.plugin.processor.getSpansBbox(unit.originalSpans, pageEl);
                if (!bbox.rect) continue;

                const relativeRect = {
                    left: bbox.rect.left / pageRect.width,
                    top: bbox.rect.top / pageRect.height,
                    width: bbox.rect.width / pageRect.width,
                    height: bbox.rect.height / pageRect.height,
                };
                if (!isFinite(relativeRect.left) || !isFinite(relativeRect.top) || !isFinite(relativeRect.width) || !isFinite(relativeRect.height)) {
                    continue;
                }

                if (mode === 'column' && snapColumns.length >= 2) {
                    const cxNorm = normPageRect.left + (relativeRect.left + relativeRect.width / 2) * normPageRect.width;
                    let chosen = snapColumns.find(c => cxNorm >= c.left && cxNorm <= c.right);
                    if (!chosen) {
                        chosen = snapColumns.reduce((best, c) => {
                            const bc = (best.left + best.right) / 2;
                            const cc = (c.left + c.right) / 2;
                            return Math.abs(cc - cxNorm) < Math.abs(bc - cxNorm) ? c : best;
                        }, snapColumns[0]);
                    }

                    const snappedLeft = (chosen.left - normPageRect.left) / Math.max(1e-6, normPageRect.width);
                    const snappedWidth = (chosen.right - chosen.left) / Math.max(1e-6, normPageRect.width);
                    relativeRect.left = Math.max(0, Math.min(1, snappedLeft));
                    relativeRect.width = Math.max(0.002, Math.min(1 - relativeRect.left, snappedWidth));
                }

                replacementItems.push({
                    selector: '',
                    textContent: unit.text,
                    translatedText: translated[i] || unit.text,
                    relativeRect,
                    page: pageNumber,
                    originalFontSizes: bbox.fontSizes.map(s => s / currentScale),
                    fontSize: bbox.avgFontSize / currentScale,
                    fontFamily: bbox.fontFamily,
                });
            }

            if (!replacementItems.length) {
                return this.retranslateSelection(pageItems, selectedIndices, mode);
            }

            const drop = new Set(selectedIndices);
            const preserved = pageItems
                .filter((_, idx) => !drop.has(idx))
                .map(x => ({ ...x, relativeRect: { ...x.relativeRect } }));
            const merged = [...preserved, ...replacementItems];
            merged.sort((a, b) => {
                if (Math.abs(a.relativeRect.top - b.relativeRect.top) > 0.003) {
                    return a.relativeRect.top - b.relativeRect.top;
                }
                return a.relativeRect.left - b.relativeRect.left;
            });
            return merged;
        } finally {
            this.plugin.processor.updateLayoutDetectorSettings(originalSettings, true);
        }
    }

    private splitSelectedByParagraphs(
        pageItems: OverlayPositionData[],
        selectedIndices: number[]
    ): OverlayPositionData[] {
        const selected = new Set(selectedIndices);
        const out: OverlayPositionData[] = [];
        for (let i = 0; i < pageItems.length; i++) {
            const item = pageItems[i];
            if (!selected.has(i)) {
                out.push({ ...item });
                continue;
            }
            const text = (item.translatedText || '').replace(/<br\s*\/?>/gi, '\n');
            const paragraphs = text
                .split(/\n\s*\n+/)
                .map(p => p.trim())
                .filter(Boolean);
            if (paragraphs.length <= 1) {
                out.push({ ...item });
                continue;
            }
            const partHeight = item.relativeRect.height / paragraphs.length;
            for (let p = 0; p < paragraphs.length; p++) {
                out.push({
                    ...item,
                    translatedText: paragraphs[p],
                    relativeRect: {
                        ...item.relativeRect,
                        top: item.relativeRect.top + partHeight * p,
                        height: partHeight
                    }
                });
            }
        }
        return out;
    }

    private async applyBulkOverlayAction(
        targetOverlay: HTMLElement,
        action: 'column' | 'table' | 'paragraphs' | 'block' | 'split' | 'delete'
    ): Promise<void> {
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        const activeFile = activeLeaf?.view?.file;
        const pageNumber = this.plugin.getCurrentPageNumber();
        if (!activeFile || activeFile.extension !== 'pdf' || pageNumber === null) {
            new Notice('PDF context is missing.');
            return;
        }

        const selectedEls = this.getSelectionForAction(targetOverlay);
        const selectedIndices = [...new Set(
            selectedEls.map(el => this.getOverlayIndex(el)).filter(i => i >= 0)
        )].sort((a, b) => a - b);
        if (!selectedIndices.length) {
            new Notice('No overlay boxes selected.');
            return;
        }

        let loaded = await this.plugin.storage.readSavedOverlayForFile(activeFile);
        if (!loaded || !loaded.overlay) {
            const extracted = await this.plugin.overlay.extractCurrentOverlayParameters();
            if (extracted.hasData) {
                await this.plugin.storage.updatePageOverlaysAndWrite(activeFile, {
                    [extracted.pageNumber]: extracted.positionData
                });
                loaded = await this.plugin.storage.readSavedOverlayForFile(activeFile);
            }
        }
        if (!loaded || !loaded.overlay) {
            new Notice('No saved overlay data found. Save overlay first.');
            return;
        }

        const pageKey = String(pageNumber);
        const pageItems = loaded.overlay.pageOverlays[pageKey] || [];
        if (!pageItems.length) {
            new Notice('No overlay items on this page.');
            return;
        }

        const validSelected = selectedIndices.filter(i => i >= 0 && i < pageItems.length);
        if (!validSelected.length) {
            new Notice('Selection does not match saved overlay items.');
            return;
        }

        let updatedPageItems: OverlayPositionData[] = pageItems.map(x => ({ ...x }));
        try {
            if (action === 'delete') {
                const kill = new Set(validSelected);
                updatedPageItems = pageItems.filter((_, idx) => !kill.has(idx)).map(x => ({ ...x }));
            } else {
                let usedLayoutReprocess = false;
                if (action === 'column' || action === 'table' || action === 'paragraphs' || action === 'split' || action === 'block') {
                    updatedPageItems = await this.retranslateSelectionWithLayoutMode(pageItems, validSelected, action);
                    usedLayoutReprocess = true;
                } else {
                    updatedPageItems = await this.retranslateSelection(pageItems, validSelected, action);
                }
                if (!usedLayoutReprocess && action === 'column') {
                    updatedPageItems = this.relayoutAsColumns(updatedPageItems, validSelected);
                } else if (!usedLayoutReprocess && action === 'table') {
                    updatedPageItems = this.relayoutAsTable(updatedPageItems, validSelected);
                }
            }

            await this.plugin.storage.updatePageOverlaysAndWrite(activeFile, {
                [pageNumber]: updatedPageItems
            });

            this.clearSelection();
            await this.plugin.overlay.loadSavedOverlayForCurrentPage(true);
            new Notice(`BBox action "${action}" applied to ${validSelected.length} box(es).`);
        } catch (error: any) {
            console.error('[OverlayUI] Bulk action failed:', error);
            new Notice(`BBox action failed: ${error?.message || 'Unknown error'}`);
        }
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

        if (this.isBBoxEditMode()) {
            if (!this.selectedOverlays.has(targetOverlay)) {
                this.selectOverlay(targetOverlay, false);
            }

            const selectedCount = this.getSelectionForAction(targetOverlay).length;
            addItem(`BBox Mode: ${selectedCount} selected`, 'check-circle', () => {});
            menu.addSeparator();

            addItem('Retranslate as Columns', 'columns', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'column');
            });
            addItem('Retranslate as Table Cells', 'table', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'table');
            });
            addItem('Retranslate as Paragraphs', 'pilcrow', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'paragraphs');
            });
            addItem('Retranslate as Text Block', 'align-left', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'block');
            });
            addItem('Retranslate with Aggressive Split', 'split', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'split');
            });
            addItem('Delete Selected Boxes', 'trash', () => {
                void this.applyBulkOverlayAction(targetOverlay, 'delete');
            });
            menu.addSeparator();
            addItem('Select All Boxes on Page', 'selection', () => {
                const pageContainer = targetOverlay.parentElement;
                if (!pageContainer) return;
                const overlays = Array.from(pageContainer.children).filter(el =>
                    (el as HTMLElement).classList.contains('pdf-text-overlay-reflow')
                ) as HTMLElement[];
                this.clearSelection();
                for (const ov of overlays) {
                    this.selectedOverlays.add(ov);
                    this.updateSelectionVisual(ov, true);
                }
                new Notice(`Selected ${overlays.length} boxes.`);
            });
            addItem('Clear BBox Selection', 'x-circle', () => {
                this.clearSelection();
            });
            menu.addSeparator();
        }

        addItem('Edit Translation', 'pencil', () => {
            if (!activeFile || pageNumber === null) { new Notice('Cannot edit: PDF context missing.'); return; }
            if (!originalText && !textToCopy)       { new Notice('Cannot edit: Reference text missing.'); return; }
            if (itemIndex === -1)                   { new Notice('Cannot edit: Could not determine overlay position.'); return; }
            new EditSpecificTranslationModal(
                this.plugin.app, this.plugin, activeFile, pageNumber, itemIndex, originalText, textToCopy
            ).open();
        });

        menu.addSeparator();

        addItem('Copy Translation', 'copy', async () => {
            try { await navigator.clipboard.writeText(textToCopy); new Notice('Translation copied.'); } catch {}
        });

        const copyFormattedText = async (format: string, title: string) => {
            if (!activeFile || pageNumber === null) {
                new Notice(`Cannot copy as ${title}: PDF file or page number is not available.`);
                return;
            }
            try {
                const pageLink      = `[[${activeFile.path}#page=${pageNumber}]]`;
                const blockquoteText = textToCopy.split('\n').map(line => `> ${line}`).join('\n');
                const formattedText = format
                    .replace(/{blockquote_text}/g, blockquoteText)
                    .replace(/{text}/g,            textToCopy)
                    .replace(/{filename}/g,         activeFile.name)
                    .replace(/{pagelink}/g,         pageLink)
                    .replace(/{pagenumber}/g,       String(pageNumber));
                await navigator.clipboard.writeText(formattedText);
                new Notice(`Copied as ${title}.`);
            } catch (error) {
                console.error(`Failed to copy translation as ${title}:`, error);
                new Notice(`Failed to copy as ${title}.`);
            }
        };

        addItem('Copy as Callout',  'quote-glyph',  () => copyFormattedText(this.plugin.settings.calloutFormat,  'callout'));
        addItem('Copy as Citation', 'book-open',    () => copyFormattedText(this.plugin.settings.citationFormat, 'citation'));
        addItem('Copy as Footnote', 'superscript',  () => copyFormattedText(this.plugin.settings.footnoteFormat, 'footnote'));

        menu.addSeparator();

        addItem('Retranslate Page...', 'refresh-cw', () => {
            if (activeFile) new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, activeFile).open();
        });

        addItem('Force Refresh Overlays', 'refresh-ccw', () => {
            const renderer = this.plugin.overlay as any;
            if (typeof renderer?.forceRefreshVisibleOverlays === 'function') {
                renderer.forceRefreshVisibleOverlays();
            } else {
                new Notice('Refresh function not available');
            }
        });

        menu.addSeparator();

        addItem('Increase Text Size',   'zoom-in',  () => this.adjustSingleOverlayFontSize(targetOverlay, 1.1));
        addItem('Decrease Text Size',   'zoom-out', () => this.adjustSingleOverlayFontSize(targetOverlay, 1 / 1.1));
        addItem('Increase Line Height', 'plus',     () => this.adjustSingleOverlayLineHeight(targetOverlay,  LINE_HEIGHT_STEP));
        addItem('Decrease Line Height', 'minus',    () => this.adjustSingleOverlayLineHeight(targetOverlay, -LINE_HEIGHT_STEP));

        menu.addSeparator();

        addItem('Go to Translation File', 'file-text', () => {
            try {
                if (!activeFile || activeFile.extension !== 'pdf' || pageNumber === null) {
                    new Notice('No PDF or page available.'); return;
                }
                const wikiLink = `${activeFile.basename}.translations#Page ${pageNumber}`;
                this.plugin.app.workspace.openLinkText(wikiLink, '', false);
            } catch {
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
            if (handlers.clickHandler) el.removeEventListener('click', handlers.clickHandler);
            if (handlers.bringToTopHandler)  el.removeEventListener('mouseover',   handlers.bringToTopHandler);
            if (handlers.resetZIndexHandler) el.removeEventListener('mouseleave',  handlers.resetZIndexHandler);
            this.createdOverlays.delete(el);
        }
        this.selectedOverlays.delete(el);
        this.trackedOverlayElements.delete(el);
        el.remove();
    }

    public cleanup(): void {
        this.trackedOverlayElements.forEach(el => this.cleanupOverlayElement(el));
        this.trackedOverlayElements.clear();
        this.selectedOverlays.clear();
        this.createdOverlays = new WeakMap();
        this.tempDiv = null;
        this.selectionBox?.remove();
        this.selectionBox = null;
        if (this.marqueeHoldTimer !== null) {
            window.clearTimeout(this.marqueeHoldTimer);
            this.marqueeHoldTimer = null;
        }
        if (this.marqueeHandlers.down) document.removeEventListener('mousedown', this.marqueeHandlers.down, true);
        if (this.marqueeHandlers.move) document.removeEventListener('mousemove', this.marqueeHandlers.move, true);
        if (this.marqueeHandlers.up) document.removeEventListener('mouseup', this.marqueeHandlers.up, true);
        this.marqueeHandlers = {};

        // FIX: also clean up the persistent measure span
        if (this.measureSpan) {
            this.measureSpan.remove();
            this.measureSpan = null;
        }
    }

    public extractPlainTextFromHtml(html: string): string {
        if (!this.tempDiv) this.tempDiv = document.createElement('div');
        this.tempDiv.innerHTML = html;
        return this.tempDiv.textContent || this.tempDiv.innerText || '';
    }
}
