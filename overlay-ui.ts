// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { EditSpecificTranslationModal } from './modal-edit-translation';
import type { OverlayPositionData } from './types';
// Phase 7 (C4): sanitize translated-text HTML before it ever touches the DOM.
// DOMPurify is configured with a strict whitelist (only inline-formatting
// tags, no attributes) so even if a malicious or buggy translation backend
// returns `<img onerror=...>` or `<a href="javascript:...">`, the payload
// is stripped at the boundary instead of being rendered.
import DOMPurify from 'dompurify';
// Phase 16 (C17): i18n shim for the context-menu strings. Falls back to the
// key itself when no translation is registered, so the plugin stays
// functional in English even without a translation file.
import { t } from './i18n';

// ============================================================
// Constants & Configuration
// ============================================================

const LINE_HEIGHT_MIN = 0.9;
const LINE_HEIGHT_MAX = 1.3;
const LINE_HEIGHT_STEP = 0.05;

// --- Visual Tweaks & Overlap Prevention ---
// T2.4: BLEED constants imported from shared.ts (single source of truth —
// overlay.ts reverses the exact same values when extracting).
// T4.2: TIGHT_LINE_HEIGHT_THRESHOLD (absolute 24px) REMOVED — tight-line
// detection is now scale-relative inside createReflowOverlay.
import { BLEED_X, BLEED_Y_NORMAL, BLEED_Y_TIGHT, PURIFY_CONFIG } from './shared';

// --- Safeguard Constants for Short Phrases/Headings ---
// (T6.1: SHORT_PHRASE_WIDTH_SAFETY_MARGIN_PX and WIDTH_EXPANSION_LIMIT were
// dead constants — never read — and have been removed.)
const SHORT_PHRASE_WORD_LIMIT = 4;
const SHORT_PHRASE_PADDING_RIGHT_EM = 0.2;

// --- Auto-fit constants ---
const MIN_FONT_SIZE_PX = 6;
const FONT_SHRINK_FACTOR = 0.95;
const MAX_SHRINK_ITERATIONS = 40; // more iterations = finer fit
const MIN_LINE_HEIGHT_SHRINK = 0.85;

// Types for internal state
type OverlayHandlers = {
    contextHandler: EventListener;
    clickHandler?: EventListener;
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

    // fix-bbox-selection: full-screen transparent overlay that captures
    // ALL pointer events while BBox Edit Mode is ON. This replaces the old
    // document-level capture-phase mousedown/mousemove/mouseup listeners
    // which conflicted with per-overlay click handlers (the document
    // handler fired first in the capture phase, called stopPropagation(),
    // and prevented the overlay's click from ever firing). With a
    // dedicated overlay div we get clean event ownership: this overlay
    // owns all pointer events in BBox mode, and per-overlay handlers
    // only fire in non-BBox mode (when this overlay is not in the DOM).
    private selectionOverlay: HTMLElement | null = null;
    // The marquee selection rectangle drawn on top of selectionOverlay.
    private selectionDiv: HTMLElement | null = null;
    // True while BBox Edit Mode is ON (selectionOverlay is present in DOM).
    private isSelecting: boolean = false;
    // True while a pointer drag is in progress (pointerdown → pointerup).
    private isDragging: boolean = false;
    // Anchor point of the current drag (clientX/Y from pointerdown).
    private startX: number = 0;
    private startY: number = 0;
    // Escape-key listener registered while selectionOverlay is attached.
    private boundOnKeyDown: ((e: KeyboardEvent) => void) | null = null;

    // P1-16 (Phase 15): monotonic z-index counter for `bringToTop`. The
    // previous implementation scanned every `.pdf-text-overlay-reflow` node
    // on the document and called `getComputedStyle(...).zIndex` per node on
    // every `mouseover` — an O(N) DOM+style read fired on hover for pages
    // with 50+ overlays, which caused noticeable lag. Replacing it with a
    // simple counter is O(1) and produces the same "raise to top" behaviour
    // (each subsequent raise gets a strictly-higher z-index than the last).
    // The base of 100 matches the previous floor so existing CSS rules that
    // expect overlays to live in the 100+ range continue to work.
    private maxZIndex: number = 100;

    // P2-24 (Phase 15): debounce token for `persistOverlayAdjustment`. Font
    // / line-height adjustments can fire in rapid bursts when the user
    // clicks "increase text size" repeatedly — without debouncing we'd write
    // to `.translations.md` on every click, hammering the vault.
    private persistAdjustmentTimer: number | null = null;
    private static readonly PERSIST_ADJUSTMENT_DEBOUNCE_MS = 400;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureGlobalStyles();
        // fix-bbox-selection: marquee/selection system is now lazily
        // attached via attachMarqueeListeners() when BBox Edit Mode is
        // toggled ON, and fully torn down via detachMarqueeListeners() on
        // OFF / cleanup. No constructor-time initialisation is needed.
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

                    /* FIX: flex-start instead of center — center causes downward shift when line-height > 1.0 */
                    display: flex;
                    flex-direction: column;
                    justify-content: flex-start;
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
                    /* Phase 17 (C19): use Obsidian interactive-accent CSS
                       variable so the selection outline respects the user
                       theme (light/dark/custom) instead of hardcoding the
                       old #1d7afc blue. The box-shadow uses color-mix to
                       produce a 25%-opacity accent halo, equivalent to the
                       old rgba(29,122,252,0.25) but theme-aware. */
                    outline: 2px solid var(--interactive-accent) !important;
                    outline-offset: -1px;
                    box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 25%, transparent) !important;
                }
            `;
            document.head.appendChild(style);
        }
        this.stylesInjected = true;
    }

    private isBBoxEditMode(): boolean {
        return !!this.plugin.settings.bboxEditMode;
    }

    // ============================================================
    // BBox Selection (pointer-events based, fix-bbox-selection)
    // ============================================================
    //
    // WHY POINTER EVENTS ON A FULL-SCREEN OVERLAY?
    //
    // The previous implementation registered mousedown/mousemove/mouseup
    // listeners on `document` with capture phase (`true`). Because the
    // capture phase fires top-down, the document-level handler ran BEFORE
    // the per-overlay click handler — and called `event.stopPropagation()`,
    // which prevented the click from ever reaching the overlay. Result:
    // shift+LMB mass-selection and empty-space deselect silently did
    // nothing.
    //
    // The empty-space deselect also failed because `marqueeActive` was
    // only armed when the mousedown landed on a `.pdf-text-overlay-container`
    // but NOT on a `.pdf-text-overlay-reflow`. A plain click on empty space
    // (e.g. on the page background outside the container) didn't even enter
    // the marquee code path, so `onMouseUp` early-returned and never ran
    // the deselect branch.
    //
    // The fix follows the user-provided reference pattern: while BBox Edit
    // Mode is ON, a full-screen transparent `div` is appended to
    // `document.body` with `position: fixed; inset: 0; z-index: 99999`. It
    // intercepts ALL pointer events (pointerdown / pointermove / pointerup)
    // and uses `setPointerCapture` so the same element keeps receiving
    // events even if the pointer leaves its bounds. On pointerup:
    //   - If the pointer moved > 5px → marquee drag → intersect the
    //     drawn rect against every `.pdf-text-overlay-reflow` on the page
    //     and add the hits to the selection.
    //   - Otherwise it's a click → temporarily hide the overlay, call
    //     `elementFromPoint` to find what's underneath, then either toggle
    //     / select that overlay or clear the selection (empty space).
    //
    // Right-clicks are forwarded to the underlying overlay's
    // `showContextMenu` via a `contextmenu` listener on the overlay, so the
    // existing context-menu workflow keeps working in BBox mode.

    /**
     * fix-bbox-selection: turn BBox Edit Mode ON. Creates the full-screen
     * pointer-capture overlay and registers the Escape key listener.
     * Idempotent — safe to call multiple times. Called from
     * `overlay.attachMarqueeListeners()` (in turn called from `main.ts`
     * when the user toggles BBox edit mode ON, and from `overlay.ts`
     * constructor if BBox mode was already enabled at plugin load).
     */
    public attachMarqueeListeners(): void {
        if (this.isSelecting) return;
        this.isSelecting = true;

        // NEW APPROACH: No permanent overlay. BBox Edit Mode is non-invasive:
        //   - Normal cursor, scrolling works, all UI works
        //   - Click on bbox → select (per-overlay clickHandler already handles this)
        //   - Ctrl/shift+click → toggle (per-overlay clickHandler handles this)
        //   - Click on empty space → deselect (document-level click listener)
        //   - Shift+LMB+drag → temporary marquee overlay (created on pointerdown, removed on pointerup)
        //
        // Listeners are on `document` (not a full-screen overlay) so they
        // don't block scrolling, menus, or any other Obsidian UI.

        // 1. Shift+LMB mousedown → start temporary marquee
        //    Use mousedown (not pointerdown) for broader compatibility —
        //    some Obsidian/Electron environments don't fire pointerdown reliably.
        document.addEventListener('mousedown', this.onDocMouseDown, true);

        // 2. Click on empty space → deselect (uses click, not mousedown,
        //    so it doesn't interfere with scrolling or drag-start)
        document.addEventListener('click', this.onDocClick, true);

        // 3. Escape clears selection
        this.boundOnKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.clearSelection();
            }
        };
        document.addEventListener('keydown', this.boundOnKeyDown);
    }

    /**
     * fix-bbox-selection: turn BBox Edit Mode OFF. Removes the full-screen
     * overlay, aborts any in-flight drag, and unregisters the Escape
     * listener. Idempotent. Called from `overlay.detachMarqueeListeners()`
     * on BBox edit mode OFF and from `cleanup()`.
     */
    public detachMarqueeListeners(): void {
        document.removeEventListener('mousedown', this.onDocMouseDown, true);
        document.removeEventListener('click', this.onDocClick, true);
        // Clean up any in-flight marquee
        if (this.selectionOverlay) {
            this.selectionOverlay.remove();
            this.selectionOverlay = null;
        }
        this.selectionDiv?.remove();
        this.selectionDiv = null;
        this.isSelecting = false;
        this.isDragging = false;
        this.startX = 0;
        this.startY = 0;
        if (this.boundOnKeyDown) {
            document.removeEventListener('keydown', this.boundOnKeyDown);
            this.boundOnKeyDown = null;
        }
    }

    /**
     * Document-level pointerdown (capture phase). Only fires when:
     *   - BBox Edit Mode is ON
     *   - Shift is held (marquee mode)
     *   - Left mouse button
     *   - NOT on a .pdf-text-overlay-reflow (let per-overlay handler deal with clicks)
     *
     * Creates a TEMPORARY overlay only for the duration of the drag.
     * Does NOT block scrolling or any UI when not dragging.
     */
    private onDocMouseDown = (e: MouseEvent): void => {
        if (!this.isBBoxEditMode()) return;
        if (e.button !== 0) return;
        if (!e.shiftKey) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('.pdf-text-overlay-reflow')) return;

        e.preventDefault();
        e.stopPropagation();

        // Create TEMPORARY full-screen overlay — only exists during drag
        this.selectionOverlay = document.body.createEl('div', { cls: 'ort-bbox-marquee-overlay' });
        this.selectionOverlay.style.cssText = [
            'position: fixed', 'top: 0', 'left: 0', 'right: 0', 'bottom: 0',
            'z-index: 99999', 'cursor: crosshair', 'background-color: transparent',
        ].join('; ');

        this.startX = e.clientX;
        this.startY = e.clientY;
        this.isDragging = true;

        this.selectionDiv = this.selectionOverlay.createEl('div', { cls: 'ort-selection-box' });
        this.selectionDiv.style.cssText = [
            'position: fixed',
            'border: 2px dashed var(--interactive-accent)',
            'background-color: color-mix(in srgb, var(--interactive-accent) 12%, transparent)',
            'left: 0', 'top: 0', 'width: 0', 'height: 0',
            'pointer-events: none', 'z-index: 100000',
            `transform: translate(${this.startX}px, ${this.startY}px)`,
        ].join('; ');

        // Mouse events on the temporary overlay
        this.selectionOverlay.addEventListener('mousemove', this.onMarqueeMouseMove);
        this.selectionOverlay.addEventListener('mouseup', this.onMarqueeMouseUp);
    };

    private onMarqueeMouseMove = (e: MouseEvent): void => {
        if (!this.isDragging || !this.selectionDiv) return;
        e.preventDefault();
        const left = Math.min(this.startX, e.clientX);
        const top = Math.min(this.startY, e.clientY);
        const width = Math.abs(this.startX - e.clientX);
        const height = Math.abs(this.startY - e.clientY);
        this.selectionDiv.style.transform = `translate(${left}px, ${top}px)`;
        this.selectionDiv.style.width = `${width}px`;
        this.selectionDiv.style.height = `${height}px`;
    };

    private onMarqueeMouseUp = (e: MouseEvent): void => {
        if (!this.isDragging) return;
        e.preventDefault();

        const rect = this.selectionDiv?.getBoundingClientRect();
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;

        this.teardownMarqueeOverlay();

        if (rect && rect.width > 5 && rect.height > 5) {
            if (!additive) this.clearSelection();
            const overlays = document.querySelectorAll<HTMLElement>('.pdf-text-overlay-reflow');
            let added = 0;
            for (const ov of overlays) {
                const r = ov.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const overlaps = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
                if (overlaps) {
                    this.selectedOverlays.add(ov);
                    this.updateSelectionVisual(ov, true);
                    added++;
                }
            }
            if (added > 0) {
                new Notice(`Selected ${added} box${added === 1 ? '' : 'es'}.`, 2000);
            }
        }
    };

    private teardownMarqueeOverlay(): void {
        if (this.selectionOverlay) {
            this.selectionOverlay.removeEventListener('mousemove', this.onMarqueeMouseMove);
            this.selectionOverlay.removeEventListener('mouseup', this.onMarqueeMouseUp);
            this.selectionOverlay.remove();
            this.selectionOverlay = null;
        }
        this.selectionDiv?.remove();
        this.selectionDiv = null;
        this.isDragging = false;
    };

    /**
     * Document-level click (capture phase). When BBox Edit Mode is ON and
     * the click landed on empty space (inside PDF viewer but NOT on an
     * overlay), clear the selection. Does NOT block scrolling or any UI
     * because `click` fires AFTER pointerup — scrolling has already
     * happened by then.
     */
    private onDocClick = (e: MouseEvent): void => {
        if (!this.isBBoxEditMode()) return;
        // Only handle clicks inside the PDF viewer
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // If click landed on an overlay, let per-overlay clickHandler handle it
        if (target.closest('.pdf-text-overlay-reflow')) return;
        // If click is inside a PDF page container → it's "empty space" in the PDF
        if (target.closest('.pdf-viewer, .pdf-view, .page')) {
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                this.clearSelection();
            }
        }
    };

    // ============================================================
    // Selection state helpers
    // ============================================================

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
        fontFamily?: string,
        // Phase 11 (C8): optional overlay metadata. When the caller has the
        // source `OverlayPositionData` (e.g. loadSavedOverlayForPage), we
        // stamp `data-translation-id` onto the inner element so that
        // downstream consumers (edit-translation modal, future
        // re-translation flows) can locate the exact overlay without relying
        // on positional indices that shift when boxes are added/removed.
        // The field is optional because some callers (renderOverlays in
        // processing.ts) build overlays from in-memory TranslationUnits
        // that don't yet have an `id`; for those, the dataset attribute is
        // simply set to an empty string.
        //
        // Phase 8 (V4 Schema): `overlayData` may also carry an `engine`
        // field. We stamp it onto `data-engine` for the same round-trip
        // reason — the edit-modal partial (built in
        // `openTranslationContextMenu`) needs to preserve the engine across
        // the edit cycle, and it has no other way to recover it (the DOM
        // element is the only handle it has to the source overlay). When
        // the engine is absent (V3 file rendered from disk without V4
        // migration), the attribute is omitted entirely, matching the
        // `data-translation-id` policy.
        // T4.3 (v5): overlayData may carry MANUAL style overrides in the
        // dedicated fields (parsed from `afs`/`alh`). Legacy `fontSize`/`fs`
        // is the ORIGINAL dominant size — explicitly NOT an override.
        overlayData?: { id?: string; engine?: string; adjustedFontSize?: number; adjustedLineHeight?: number } | OverlayPositionData
    ): HTMLElement {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return document.createElement('div');
        }

        // --- 1. Short-phrase analysis ---
        const plainText = this.extractPlainTextFromHtml(htmlText).trim();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length; // FIX: filter empty tokens
        const isShortPhrase = wordCount <= SHORT_PHRASE_WORD_LIMIT;

        // --- 3 (hoisted). Font calculation ---
        // (T4.2: hoisted ABOVE the tight-line check because the tight
        // threshold is now derived from the dominant font size.)
        let avgOriginalFontSize: number;
        if (originalFontSizes.length > 0) {
            // Find dominant (mode) font size
            const sizeCounts = new Map<number, number>();
            for (const fs of originalFontSizes) {
                const rounded = Math.round(fs * 10) / 10;  // round to 0.1
                sizeCounts.set(rounded, (sizeCounts.get(rounded) || 0) + 1);
            }
            let maxCount = 0;
            let dominantSize = originalFontSizes[0];
            for (const [size, count] of sizeCounts) {
                if (count > maxCount) {
                    maxCount = count;
                    dominantSize = size;
                }
            }
            avgOriginalFontSize = dominantSize;
        } else {
            avgOriginalFontSize = parseFloat(window.getComputedStyle(referenceSpan).fontSize) || 12;
        }

        // --- 2. Tight-line detection (T4.2: scale-RELATIVE) ---
        // The old absolute threshold (24px) classified the SAME line as
        // "tight" at 50% zoom and "normal" at 200% zoom, flipping BLEED and
        // the line-height ceiling between zoom levels. A line is tight when
        // its bbox height is under ~1.5× the rendered font size of its
        // dominant span — invariant under viewer zoom.
        const scaleFactor = (lastKnownScale > 0 ? lastKnownScale : 1);
        const tightThreshold = avgOriginalFontSize * 1.5 * scaleFactor;
        const isTightLine = rect.height < tightThreshold;
        const currentBleedY = isTightLine ? BLEED_Y_TIGHT : BLEED_Y_NORMAL;

        const el = document.createElement('div');
        el.className = 'pdf-text-overlay-reflow';

        if (isShortPhrase) {
            el.classList.add('force-top-align');
        }

        // FIX: store short-phrase flag in data attr so sizing logic doesn't depend on CSS class name
        el.setAttribute('data-is-short-phrase', isShortPhrase ? 'true' : 'false');

        const baseFontSize = avgOriginalFontSize * outputFontSizeScale;
        let currentFontSize = baseFontSize * lastKnownScale;
        // T4.3 (format v5): a persisted manual font-size adjustment
        // (saved scale-free in extractPositionDataFrom) overrides the
        // computed size so "increase/decrease text" survives reloads.
        // T4.3 (CORRECTED): only the DEDICATED `adjustedFontSize` field counts
        // — the legacy `fontSize` is the original dominant size and must never
        // be treated as an override (the earlier version did, silently
        // dropping outputFontSizeScale for every queue-saved overlay).
        const persistedFS = (overlayData as any)?.adjustedFontSize;
        if (typeof persistedFS === 'number' && Number.isFinite(persistedFS) && persistedFS > 0) {
            currentFontSize = persistedFS * scaleFactor;
        }

        // --- 3.5. Line height (computed early for vertical compensation) ---
        let startLH = outputLineHeight;
        if (isTightLine) {
            startLH = Math.min(outputLineHeight, 1.1);
        } else if (startLH > 1.2) {
            startLH = 1.2;
        }

        // --- 4. Positioning & dimensions ---
        // BLEED expands the bbox slightly to cover original text edges.
        // No lineHeightCompensation — getBoundingClientRect() already includes
        // font ascent/descent in rect.height, and leading is part of that.
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
            // FIX: opaque white background — user wants original text fully hidden.
            // Opacity slider controls the WHOLE overlay (background + text together).
            backgroundColor: '#ffffff',
            color:           'var(--text-normal)',
            borderRadius:    '2px',
            textRendering:   'optimizeLegibility',
        });

        el.setAttribute('data-initial-width',  `${adjustedWidth}`);
        el.setAttribute('data-initial-left',   `${adjustedLeft}`);
        el.setAttribute('data-is-tight',        isTightLine ? 'true' : 'false');
        el.setAttribute('data-original-font-size', `${currentFontSize}`);

        el.style.setProperty('--overlay-opacity', `${overlayOpacity}`);
        // P1-20 (Variant 4): consult the renderer's current visibility
        // state when creating a new overlay. Previously this was hardcoded
        // to `true`, which meant that after the user hit "Hide overlay"
        // any newly-scrolled-into-view page would appear WITH its overlays
        // visible — defeating the toggle. Reading from `plugin.overlay`
        // keeps the new overlay consistent with the user's last toggle.
        const initialVisibility = this.plugin.overlay?.isOverlayVisible ?? true;
        this.setOverlayElementVisibility(el, initialVisibility);

        // --- 5. Inner text container ---
        // FIX (v5): whiteSpace 'normal' (was 'pre-wrap') — collapse multiple
        // spaces from LLM output, prevents text "разъезжание".
        // FIX (v5): hyphens 'auto' + lang attr — browser-native hyphenation
        // for long words (e.g. "иммуногистохимическими" → "иммуногистохи-мическими").
        // Requires `lang` attribute on the element to pick the right dictionary.
        // FIX (v5): wordBreak 'normal' (was 'break-word') — don't break inside
        // words unless absolutely necessary; overflowWrap 'break-word' handles
        // the fallback for genuinely unbreakable strings.
        const inner = document.createElement('div');
        Object.assign(inner.style, {
            whiteSpace:    'normal',
            wordBreak:     'normal',
            overflowWrap:  'break-word',
            hyphens:       'auto',
            WebkitHyphens: 'auto',
            width:         '100%',
            margin:        '0',
            textAlign:     'left',
        });
        // Set lang attribute for hyphenation dictionary selection.
        // Without this, `hyphens: auto` does nothing in most browsers.
        inner.lang = this.plugin.settings.targetLanguage || 'en';
        // Phase 7 (C4): sanitize before assigning to innerHTML. The translated
        // text can come from arbitrary LLM backends (or, on reload, from the
        // user-editable `.translations.md` file), so we treat it as untrusted.
        // The whitelist allows only inline-formatting tags; everything else
        // (including event-handler attributes and `<script>`/`<img>`) is
        // stripped. An empty/whitespace-only translation falls back to an
        // ellipsis so the box doesn't visually collapse.
        const sanitized = DOMPurify.sanitize((htmlText || '').trim() || '…', PURIFY_CONFIG);
        inner.innerHTML = sanitized;
        // Phase 11 (C8) + Phase 7 (P1-12): stamp the overlay's stable ID onto
        // the inner element so downstream consumers (edit-translation modal,
        // future re-translation flows) can locate the exact overlay without
        // relying on the positional `data-overlay-index` attribute (which
        // shifts when boxes are added/removed).
        //
        // P1-12 (Phase 7): previously this ALWAYS stamped the attribute,
        // falling back to `''` when no id was available — that produced a
        // sea of `data-translation-id=""` attributes on every overlay,
        // making it impossible for consumers to distinguish "no id" from
        // "id is the empty string". Now we ONLY stamp when a real id
        // exists; consumers check `el.dataset.translationId` (which returns
        // `undefined` when the attribute is absent) to detect the no-id
        // case and fall back to textContent-based lookup.
        if (overlayData?.id) {
            inner.dataset.translationId = overlayData.id;
        }
        // Phase 8 (V4 Schema): stamp the engine onto the DOM so the
        // edit-modal partial (built in `openTranslationContextMenu`) can
        // recover the original engine when the user edits the translation.
        // Without this, the edit-modal path would have no way to know
        // whether the overlay was produced by an actual LLM (`engine:
        // 'provider/model'`) or by the originals-only path (`engine:
        // 'originals-only'`), and the V4 stamp would be lost on save.
        if (overlayData?.engine) {
            inner.dataset.engine = overlayData.engine;
        }
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

        // --- 6. Line height (startLH computed in step 3.5) ---
        // T4.3 (format v5, CORRECTED): a persisted MANUAL line-height
        // adjustment (dedicated `adjustedLineHeight` field only) overrides
        // the computed start value.
        const persistedLH = (overlayData as any)?.adjustedLineHeight;
        const effectiveLH = (typeof persistedLH === 'number' && Number.isFinite(persistedLH) && persistedLH > 0)
            ? Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, persistedLH))
            : startLH;
        this.applyLineHeight(inner, effectiveLH);

        // --- 7. Metadata ---
        el.setAttribute('data-original-text', originalTextContent);
        if (originalFontSizes.length > 0) {
            el.setAttribute('data-original-font-sizes', JSON.stringify(originalFontSizes));
        }

        // --- 8. Interaction events ---
        // P2-23 (Phase 15): capture `innerText` (not `textContent`) for the
        // context-menu copy path. `innerText` honors visible layout — `<br>`
        // tags are returned as `\n` line breaks, and `display:none` children
        // are skipped — so multi-line translations copy as multi-line text.
        // `textContent` collapses everything to a flat string with no line
        // breaks, so a `<br>`-separated list of bullet items would paste as
        // a single run-on line. Fall back to `textContent` only when
        // `innerText` is unavailable (detached element / older browsers).
        const contextHandler    = (event: Event) => this.showContextMenu(event, inner.innerText || inner.textContent || '', el);
        const bringToTopHandler = () => this.bringToTop(el);
        const resetZIndexHandler = () => { el.style.zIndex = '101'; };
        const clickHandler = (event: Event) => {
            if (!this.isBBoxEditMode()) return;
            const me = event as MouseEvent;
            me.preventDefault();
            me.stopPropagation();
            // feat-1 (mass-select): shift+LMB toggles individual overlay
            // (additive). Previously only ctrl/meta toggled; shift fell
            // through to `selectOverlay(el, false)` which collapsed the
            // existing selection. Now shift+LMB on an unselected bbox ADDS
            // it; on a selected bbox REMOVES it — same semantics as the
            // pre-existing ctrl/meta path, reusing `toggleOverlaySelection`.
            if (me.shiftKey || me.ctrlKey || me.metaKey) {
                this.toggleOverlaySelection(el);
                return;
            }
            // feat-1 (mass-select): LMB without modifier on an
            // already-selected bbox → keep selection as-is. This lets the
            // user preserve a multi-selection (e.g. to start a drag-move
            // with the whole group). Previously this re-ran
            // `selectOverlay(el, false)` and collapsed the selection down
            // to just this overlay, defeating mass-selection. Clicking an
            // UNSELECTED bbox still falls through to the
            // clear-and-select-only-this-one behaviour below.
            if (this.selectedOverlays.has(el)) {
                return;
            }
            this.selectOverlay(el, false);
        };

        el.addEventListener('contextmenu', contextHandler);
        el.addEventListener('mouseover',   bringToTopHandler);
        el.addEventListener('mouseleave',  resetZIndexHandler);
        el.addEventListener('click', clickHandler);

        this.createdOverlays.set(el, { contextHandler, clickHandler, bringToTopHandler, resetZIndexHandler });
        this.trackedOverlayElements.add(el);

        // P2-64 (Phase 15): adjustOverlayForOverflow removed — caller MUST
        // call it after append. The previous call was a no-op because `el`
        // is still DETACHED at this point (the caller hasn't appended it to
        // the page container / staging container yet). `adjustOverlayForOverflow`
        // reads `inner.scrollHeight` / `el.clientHeight` which both return 0
        // for detached elements, so the function early-returned without
        // fitting anything. Worse, the no-op wasted a style read on every
        // `createReflowOverlay` call. Callers that need a fit pass now do
        // it explicitly after append:
        //   - `renderOverlays` schedules a RAF after `container.appendChild`
        //     (P1-18, see overlay.ts).
        //   - `rerenderVisibleOverlaysInner` and `loadSavedOverlayForPage`
        //     already scheduled a RAF after appending to the staging
        //     container — those paths were already correct.
        return el;
    }

    // ============================================================
    // Public API: Post-Processing Overlap Fixer
    // ============================================================

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
     *     the box was later enlarged (e.g. by a caller growing it) — previously it would stay
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
        // SHORT PHRASE — adapt text to bbox, expand bbox only if needed
        // ----------------------------------------------------------------
        // RULES (per user spec):
        //   1. Bbox must NEVER be smaller than the original text bbox.
        //   2. If translation fits in original bbox → keep bbox as-is.
        //   3. If translation is LONGER than original bbox → expand bbox
        //      (but only to fit the translation, no arbitrary +35% reserve).
        //   4. If translation overflows after expansion → shrink font to fit.
        // ----------------------------------------------------------------
        if (isShortPhrase) {
            inner.style.whiteSpace = 'nowrap';
            inner.style.overflow   = 'visible';

            const currentFontSize = parseFloat(el.style.fontSize) || 12;
            const fontFamily      = el.style.fontFamily || 'sans-serif';
            const plainText       = inner.textContent || '';
            if (!plainText.trim()) return;

            const originalWidth = parseFloat(el.getAttribute('data-initial-width') || '0')
                               || parseFloat(el.style.width)
                               || el.offsetWidth;
            const paddingRightPx = this.pxFromEm(SHORT_PHRASE_PADDING_RIGHT_EM, currentFontSize);
            const requiredWidth   = this.estimateTextWidth(plainText, currentFontSize, fontFamily)
                                  + paddingRightPx + 2; // +2px safety (was 10)

            // Step 1: If translation fits in original bbox → keep bbox as-is.
            //         Do NOT expand. The bbox stays at original text boundaries.
            if (requiredWidth <= originalWidth) {
                // Text fits — no width change needed.
                // But check if font needs shrinking (rare for short phrases that fit).
                if (inner.scrollWidth > el.clientWidth + 1) {
                    let fs = parseFloat(el.style.fontSize);
                    let iter = 0;
                    while (inner.scrollWidth > el.clientWidth + 1 && fs > MIN_FONT_SIZE_PX && iter < MAX_SHRINK_ITERATIONS) {
                        fs *= FONT_SHRINK_FACTOR;
                        el.style.fontSize = `${fs}px`;
                        iter++;
                    }
                }
                return;
            }

            // Step 2: Translation is LONGER than original bbox.
            //         Expand bbox to fit the translation (but not beyond page width).
            //         Use the ACTUAL required width, not initialWidth × 1.35.
            const pageEl = el.closest('.page') as HTMLElement;
            const pageWidth = pageEl ? pageEl.getBoundingClientRect().width : Infinity;
            const currentLeft = parseFloat(el.style.left) || 0;
            const maxAllowedWidth = pageWidth - currentLeft - 4; // 4px right margin

            const newWidth = Math.min(requiredWidth, maxAllowedWidth);
            if (newWidth > originalWidth) {
                el.style.width = `${newWidth}px`;
                el.style.minWidth = `${newWidth}px`;
            }

            // Step 3: If text still overflows after expansion → shrink font
            if (inner.scrollWidth > el.clientWidth + 1) {
                let fs = parseFloat(el.style.fontSize);
                let iter = 0;
                while (inner.scrollWidth > el.clientWidth + 1 && fs > MIN_FONT_SIZE_PX && iter < MAX_SHRINK_ITERATIONS) {
                    fs *= FONT_SHRINK_FACTOR;
                    el.style.fontSize = `${fs}px`;
                    iter++;
                }
            }

            return;
        }

        // ----------------------------------------------------------------
        // LONG TEXT — shrink font → shrink line-height → scroll fallback
        // ----------------------------------------------------------------

        const isOverflowing = () =>
            inner.scrollHeight > el.clientHeight + 1 ||
            inner.scrollWidth  > el.clientWidth  + 1;

        if (!isOverflowing()) {
            // FIX: box may have been grown by a caller between fits — recover size.
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

        // Strategy 1 — Shrink font size (BINARY SEARCH, v5 optimization)
        // FIX (v5): replaced linear shrink (×0.95 per iteration, up to 40 iters)
        // with binary search (~6 iterations for same precision). This is 6×
        // faster on complex pages with many overlays, and produces a more
        // precise fit (no over-shrink).
        // P2-63 (Phase 15): cap iterations at 6 and stop once the search
        // range narrows below 1px (was 12 iters / 0.5px). For text fitting
        // 1px of font-size precision is invisible to the user — the extra
        // 6 iterations of the old cap bought no visible improvement but
        // doubled the layout-thrash cost on pages with many overflowing
        // overlays. Each iteration forces a reflow (read of
        // `inner.scrollHeight` after a style mutation), so cutting the cap
        // in half cuts the worst-case fit cost in half too.
        if (!el.getAttribute('data-original-font-size')) {
            el.setAttribute('data-original-font-size', el.style.fontSize);
        }

        const originalFs = parseFloat(el.getAttribute('data-original-font-size') || '12');
        let lo = MIN_FONT_SIZE_PX;
        let hi = originalFs;
        let currentFontSize: number;
        // Check if it already fits at original size — no shrink needed
        el.style.fontSize = `${hi}px`;
        if (!isOverflowing()) {
            // Fits at original — done
            currentFontSize = hi;
        } else {
            // Binary search for the largest font size that fits
            // P2-63 (Phase 15): cap at 6 iterations (0.5px precision overkill for text fitting)
            for (let iter = 0; iter < 6 && hi - lo > 1; iter++) {
                const mid = (lo + hi) / 2;
                el.style.fontSize = `${mid}px`;
                if (isOverflowing()) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            el.style.fontSize = `${lo}px`;
            currentFontSize = lo;
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
        // P2-28 (Phase 15): refuse to operate on a detached overlay — the
        // user's right-click target may have been torn down by a
        // concurrent `rerenderVisibleOverlays` pass between menu-open and
        // menu-action-click. Mutating a detached node's style has no
        // visible effect and would write a stale `--overlay-line-height`
        // back to a parent that is no longer in the document.
        if (!overlayEl.isConnected) {
            new Notice('Overlay no longer available. Try again.', 2000);
            return;
        }
        try {
            const currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;
            let newValue = Math.round((currentLineHeight + delta) * 100) / 100; // FIX: round before clamp
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            this.applyLineHeight(inner, newValue);
            // T4.3: mark as a MANUAL adjustment so the extractor persists it
            // (creation/auto-fit styles must NOT be persisted as overrides).
            overlayEl.dataset.styleAdjusted = '1';
            // P2-24 (Phase 15): persist font adjustment to storage
            void this.persistOverlayAdjustment(overlayEl);
        } catch (error) {
            console.debug('[OverlayUIRenderer] adjustSingleOverlayLineHeight failed:', error);
        }
    }

    public adjustSingleOverlayFontSize(overlayEl: HTMLElement, scaleFactor: number): void {
        if (!overlayEl) return;
        // P2-28 (Phase 15): same detached-overlay guard as
        // `adjustSingleOverlayLineHeight` — see that method for rationale.
        if (!overlayEl.isConnected) {
            new Notice('Overlay no longer available. Try again.', 2000);
            return;
        }
        try {
            const currentSize = parseFloat(overlayEl.style.fontSize);
            if (isNaN(currentSize)) return;

            const FONT_SIZE_MIN_PX = 6;
            const FONT_SIZE_MAX_PX = 72;
            const newSize = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, currentSize * scaleFactor));
            overlayEl.style.fontSize = `${newSize}px`;
            // T4.3: mark as a MANUAL adjustment (see adjustSingleOverlayLineHeight).
            overlayEl.dataset.styleAdjusted = '1';
            // P2-24 (Phase 15): persist font adjustment to storage
            void this.persistOverlayAdjustment(overlayEl);
        } catch (error) {
            console.debug('[OverlayUIRenderer] adjustSingleOverlayFontSize failed:', error);
        }
    }

    public applyLineHeight(inner: HTMLDivElement, value: number): void {
        const lineHeightStr = `${value}`;
        inner.style.lineHeight = lineHeightStr;
        inner.parentElement?.style.setProperty('--overlay-line-height', lineHeightStr);
    }

    /**
     * P2-24 (Phase 15): persist a user-initiated font-size / line-height
     * adjustment to `.translations.md` so it survives reloads.
     *
     * The implementation calls `extractCurrentOverlayParameters` (which
     * reads ALL overlays on the current page from the DOM, including the
     * just-adjusted one) and writes the result back via
     * `updatePageOverlaysAndWrite(... { replace: true })`. The `replace`
     * flag is required because the merge-by-overlap default would treat
     * the re-extracted items as NEW items and double-up with the existing
     * page array.
     *
     * NOTE: `extractCurrentOverlayParameters` captures `relativeRect`,
     * `originalFontSizes`, `fontFamily`, and the translated text — it does
     * NOT currently capture the live `style.fontSize` / `style.lineHeight`
     * the user just set (the `OverlayPositionData` schema has no such
     * fields). What this persistence DOES accomplish today:
     *   1. Triggers a re-save with the current geometric rect (so any
     *      auto-shrinkage applied by `adjustOverlayForOverflow` is
     *      preserved on the bbox, not reverted on reload).
     *   2. Re-stamps V4 `id` + `engine` on the saved items.
     *   3. Establishes the write-back hook so a future schema extension
     *      (Phase 19 type-safety pass) that adds `adjustedFontSize` /
     *      `adjustedLineHeight` fields can capture them with a one-line
     *      change to `extractPositionDataFrom`.
     *
     * Debounced: rapid clicks on "increase text size" coalesce into a
     * single write at the end of the burst (`PERSIST_ADJUSTMENT_DEBOUNCE_MS`).
     */
    private async persistOverlayAdjustment(overlayEl: HTMLElement): Promise<void> {
        try {
            const activeFile = this.plugin.app.workspace.getActiveFile();
            if (!activeFile || activeFile.extension !== 'pdf') return;
            const pageNumber = parseInt(
                overlayEl.getAttribute('data-overlay-page') ||
                overlayEl.closest('.page')?.getAttribute('data-page-number') || '0',
                10
            );
            if (!pageNumber) return;
            // P2-24: debounce the actual extraction + write so a burst of
            // "increase text size" clicks doesn't hammer `.translations.md`.
            // The latest overlayEl is captured at write time — if the user
            // adjusted several overlays in quick succession, each call
            // reschedules the timer and the final write reads whichever
            // overlay was last touched.
            if (this.persistAdjustmentTimer !== null) {
                window.clearTimeout(this.persistAdjustmentTimer);
            }
            this.persistAdjustmentTimer = window.setTimeout(async () => {
                this.persistAdjustmentTimer = null;
                try {
                    // P2-28 (Phase 15): re-check connectivity at write time
                    // too — the user may have right-clicked, then closed the
                    // PDF, then the timer fired. Skip the write rather than
                    // persisting a stale page snapshot.
                    if (!overlayEl.isConnected) return;
                    const params = await this.plugin.overlay?.extractCurrentOverlayParameters?.();
                    if (!params || !params.hasData || !params.positionData?.length) return;
                    // Only write if the page the user adjusted matches the
                    // page the renderer is currently on — otherwise the
                    // extracted positionData belongs to a different page
                    // and `replace: true` would clobber the wrong page's
                    // saved state.
                    if (params.pageNumber !== pageNumber) return;
                    await this.plugin.storage.updatePageOverlaysAndWrite(
                        activeFile,
                        { [pageNumber]: params.positionData },
                        { replace: true }
                    );
                } catch (e) {
                    console.warn('[OverlayUIRenderer] Failed to persist font adjustment (debounced):', e);
                }
            }, OverlayUIRenderer.PERSIST_ADJUSTMENT_DEBOUNCE_MS);
        } catch (e) {
            console.warn('[OverlayUIRenderer] Failed to persist font adjustment:', e);
        }
    }

    public setOverlayElementVisibility(el: HTMLElement, isVisible: boolean): void {
        if (isVisible) {
            // Read opacity from the per-overlay CSS variable (set in createReflowOverlay),
            // falling back to the global setting. Phase 1: normalize legacy 0–100 values
            // to the 0.0–1.0 scale so the slider works as expected.
            const raw = el.style.getPropertyValue('--overlay-opacity') || `${this.plugin.settings.overlayOpacity}`;
            let op = parseFloat(raw);
            if (!isFinite(op)) op = 0.95;
            // Legacy 0–100 → 0.0–1.0
            if (op > 1) op = op / 100;
            // Clamp to valid CSS opacity range
            op = Math.max(0, Math.min(1, op));

            // FIX: apply opacity to the WHOLE element (background + text together).
            // This gives the user control over how much of the underlying PDF shows
            // through — at opacity 1.0 the white background fully hides original text,
            // at lower values the original text becomes visible.
            el.style.opacity = `${op}`;
            el.style.pointerEvents = 'auto';
            el.style.visibility = 'visible';
        } else {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            el.style.visibility = 'hidden';
        }
    }

    public bringToTop(el: HTMLElement): void {
        // P1-16 (Phase 15): O(1) counter replaces O(N) per-hover scan of
        // every `.pdf-text-overlay-reflow` node + `getComputedStyle` read.
        // Each call strictly increases the assigned z-index, so the most
        // recently hovered overlay is always on top — same observable
        // behaviour as the old max-scan, with no per-hover reflow cost.
        el.style.zIndex = `${++this.maxZIndex}`;
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
        // P2-29 (Phase 13): do NOT mutate `selectedOverlays` from a read
        // path. Previously this method called `selectOverlay(targetOverlay,
        // false)` (which clears the Set and re-adds only the target) when
        // the target wasn't already selected — a "read" with a write side
        // effect. The user opened a context menu on an unselected overlay
        // expecting to see "1 box selected" but the underlying selection
        // state was silently mutated, so the next bulk action would
        // surprise them. Now we include the target in the returned array
        // (a preview) without touching `selectedOverlays`; the bulk action
        // itself is what commits the selection (via `applyBulkOverlayAction`).
        const result = this.selectedOverlays.has(targetOverlay)
            ? [...this.selectedOverlays]
            : [...this.selectedOverlays, targetOverlay];
        return result.filter(el => el.isConnected);
    }

    private sortIndicesByMode(
        indices: number[],
        pageItems: OverlayPositionData[],
        // Phase 2 (C3): 'column' / 'table' / 'split' modes have been removed
        // — the menu items that invoked them were deleted in an earlier
        // refactor because they relied on legacy layout settings the
        // contour pipeline ignores. Only 'block' and 'paragraphs' remain,
        // and both default to row-major ordering below.
        mode: 'block' | 'paragraphs'
    ): number[] {
        const sorted = [...indices];
        sorted.sort((a, b) => {
            const ra = pageItems[a]?.relativeRect;
            const rb = pageItems[b]?.relativeRect;
            if (!ra || !rb) return a - b;
            // All remaining modes (block + paragraphs) sort row-major.
            if (Math.abs(ra.top - rb.top) > 0.01) return ra.top - rb.top;
            return ra.left - rb.left;
        });
        return sorted;
    }

    // Phase 2 (C3): the `relayoutAsColumns` and `relayoutAsTable` helpers
    // that lived here have been removed. They were only reachable from
    // `applyBulkOverlayAction`'s dead `action === 'column'` / `action ===
    // 'table'` branches (see that method for details), and from nowhere
    // else. Keeping them only invited future callers to resurrect the
    // removed layout modes.

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
        // Phase 2 (C3): 'column' / 'table' / 'split' modes have been removed.
        // Only 'block' (joined-then-split translation) and 'paragraphs'
        // (per-fragment translation) remain.
        mode: 'block' | 'paragraphs'
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

        // mode === 'paragraphs' — translate each fragment independently.
        for (const idx of ordered) {
            const source = (pageItems[idx]?.textContent || pageItems[idx]?.translatedText || '').trim();
            if (!source) continue;
            const prompt = `Translate this paragraph naturally and preserve paragraph meaning:\n${source}`;
            const line = await this.plugin.translation.translateWithOpenRouter(prompt);
            if (line?.trim()) updated[idx].translatedText = line.trim();
        }
        return updated;
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
        // Phase 2 (C3): 'column' / 'table' / 'split' modes have been removed.
        // Only 'paragraphs' and 'block' remain — both go through the layout
        // detector with tuned settings, then either merge-into-one-block
        // ('block') or per-unit translation ('paragraphs'). The 'split'
        // fallback to `splitSelectedByParagraphs` is gone along with the
        // mode itself; that helper was unreachable from any remaining path.
        mode: 'paragraphs' | 'block',
        // P1-10 (Phase 13): captured-at-menu-open page number from
        // `targetOverlay.getAttribute('data-overlay-page')`. When provided
        // (i.e. when called from `applyBulkOverlayAction` invoked by the
        // context menu), this is used instead of re-querying the live
        // `getCurrentPageNumber()` — fixes the bug where scrolling between
        // right-click and click would target the wrong page. Falls back
        // to `getCurrentPageNumber()` for non-menu callers.
        pageNumberOverride?: number | null
    ): Promise<OverlayPositionData[]> {
        const pageNumber = pageNumberOverride ?? this.plugin.getCurrentPageNumber();
        if (pageNumber == null) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        // T4.1 (split-view fix): leaf-scoped lookup — the old global
        // document.querySelector returned the first matching page across ALL
        // open PDF leaves and re-translated/detected layout on the WRONG file.
        const activeLeaf = this.plugin.pdfDom.getActivePdfLeaf();
        const pageEl = this.plugin.pdfDom.getPageElement(pageNumber, activeLeaf);
        const textLayer = pageEl?.querySelector<HTMLElement>('.textLayer');
        if (!pageEl || !textLayer) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const selectedSpans = this.getSelectedSpanPool(pageItems, selectedIndices, pageEl, textLayer);
        if (!selectedSpans.length) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const viewer = pageEl.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const currentScale = parseFloat(viewer?.style.getPropertyValue('--scale-factor') || '1') || 1;

        // T3.7 (Q12 decision): the old `buildLayoutSettingsForBBoxMode` tuned
        // ~25 layout fields the contour pipeline never read — a placebo that
        // only obscured what the two modes actually differ in: the
        // TRANSLATION strategy (joined single block vs per-unit). Detection
        // now runs with the user's global settings; the mode difference
        // lives purely in the strategy branches below.
        const units = await this.plugin.processor.prepareTranslationUnits(selectedSpans, pageEl, /* forceFresh */ true);
        if (!units || units.length === 0) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        // P1-14 (Phase 13): reject non-contiguous block selections BEFORE
        // the branch decision below — a block-mode merge of spans
        // scattered across two columns (or two non-adjacent paragraphs)
        // produces a giant mega-overlay covering empty whitespace. Sort
        // spans row-major and verify each adjacent pair is roughly below
        // (same column) or right-of (same row) the previous one; otherwise
        // fall back to 'paragraphs' mode (per-unit translation, no merge).
        // The check runs only when the user explicitly asked for block
        // mode AND selected more than one span; the reassignment to
        // 'paragraphs' happens BEFORE the `if (mode === 'block')` branch
        // so the paragraphs path runs naturally without needing a
        // recursive call or early return.
        if (mode === 'block' && selectedSpans.length > 1) {
            const sorted = [...selectedSpans].sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return ra.top - rb.top || ra.left - rb.left;
            });
            let isContiguous = true;
            for (let i = 1; i < sorted.length; i++) {
                const prev = sorted[i - 1].getBoundingClientRect();
                const curr = sorted[i].getBoundingClientRect();
                const verticalGap = curr.top - prev.bottom;
                const horizontalGap = curr.left - prev.right;
                if (verticalGap > prev.height * 2 && horizontalGap > prev.width * 2) {
                    isContiguous = false;
                    break;
                }
            }
            if (!isContiguous) {
                new Notice('Non-contiguous selection. Falling back to paragraphs mode.', 4000);
                mode = 'paragraphs';
            }
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

        // mode === 'paragraphs' — translate each layout-detected unit.
        const translated = await this.plugin.processor.executeTranslation(units);
        const pageRect = pageEl.getBoundingClientRect();
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
    }

    // Phase 2 (C3): the `splitSelectedByParagraphs` helper that lived here
    // has been removed. It was only ever called from the `'split'` fallback
    // branches in `retranslateSelectionWithLayoutMode`, which themselves
    // were only reachable when `mode === 'split'` — a mode that no longer
    // exists in the type union. With both caller and helper gone, the
    // feature is fully excised.

    private async applyBulkOverlayAction(
        targetOverlay: HTMLElement,
        // Phase 2 (C3): 'column' / 'table' / 'split' have been removed from
        // the action union. Only 'paragraphs', 'block', and 'delete'
        // remain — these are the only actions the context menu ever
        // invokes (see showContextMenu). The else-branch below that
        // previously called `retranslateSelection` for the removed modes
        // is now unreachable (the only remaining non-delete actions go
        // through `retranslateSelectionWithLayoutMode`), and the dead
        // `relayoutAsColumns` / `relayoutAsTable` cleanup that followed
        // it has been deleted too.
        action: 'paragraphs' | 'block' | 'delete',
        // P1-10 (Phase 13): captured-at-menu-open page number from
        // `targetOverlay.getAttribute('data-overlay-page')` (see
        // `showContextMenu`). When provided, used instead of re-querying
        // the live `getCurrentPageNumber()` so the bulk action targets the
        // page the user right-clicked on, not whatever page they scrolled
        // to before clicking the menu item.
        pageNumberOverride?: number | null
    ): Promise<void> {
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        const activeFile = activeLeaf?.view?.file;
        const pageNumber = pageNumberOverride ?? this.plugin.getCurrentPageNumber();
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
                // 'paragraphs' or 'block' — both go through the layout-aware
                // retranslator (which tunes the layout detector for the chosen
                // mode, then re-detects columns/paragraphs and retranslates).
                updatedPageItems = await this.retranslateSelectionWithLayoutMode(pageItems, validSelected, action, pageNumber);
            }

            await this.plugin.storage.updatePageOverlaysAndWrite(
                activeFile,
                { [pageNumber]: updatedPageItems },
                // Phase 4 (P0-9) + Bug 2 fix: use REPLACE semantics for ALL bulk
                // actions (delete, paragraphs, block). Previously only 'delete' used
                // replace; 'paragraphs'/'block' used MERGE which could keep old items
                // alongside new ones when rects drifted slightly → duplicate bboxes.
                // REPLACE is safe here because `updatedPageItems` is a fully-resolved
                // page array (the retranslator builds the complete new set including
                // unmodified items).
                { replace: true },
            );

            // P2-65 (Phase 14): this bulk action only touches ONE page (the
            // page whose overlays were right-clicked), so use the targeted
            // `invalidatePage(pageNumber)` instead of the heavier
            // `invalidateCache()`. The previous `invalidateCache()` call
            // (Phase 4 / P1-33) was overkill — it wiped the entire
            // `_cachedOverlayData` for ALL pages and forced the next
            // `loadSavedOverlayForCurrentPage` to re-read the entire
            // `.translations.md` from disk + rebuild `pagesWithOverlays`
            // from scratch, even though only one page's data had changed.
            // `invalidatePage` deletes just the affected page's entries
            // from `_cachedOverlayData.pageOverlays` and `loadedOverlayPages`,
            // plus drops any in-flight load promise for the page so a
            // concurrent load doesn't short-circuit the forced reload below.
            this.plugin.overlay.invalidatePage(pageNumber);

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

        // P2-60 (Phase 14): don't open the menu if a `rerenderVisibleOverlays`
        // pass is in flight — the user's right-click target may be torn down
        // by the rerender mid-menu, leading to a context-menu action landing
        // on a stale/detached overlay node (the Phase 15 `targetOverlay.isConnected`
        // check will also catch this at action-click time, but warning at
        // menu-open is friendlier — the user gets immediate feedback instead
        // of clicking an action and seeing nothing happen).
        if (this.plugin.overlay?.isReloadingOverlayFlag) {
            new Notice('Overlays are being refreshed. Try again in a moment.', 2000);
            return;
        }

        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        const activeFile = activeLeaf?.view?.file;
        // P1-10 (Phase 13): capture `pageNumber` at menu-open time from
        // the overlay element (stamped by `createReflowOverlay` as
        // `data-overlay-page`). Falls back to the nearest `.page` ancestor's
        // `data-page-number` for overlays rendered before the attribute was
        // added. Previously this called `this.plugin.getCurrentPageNumber()`
        // — a live read of the PDF viewer's current scroll position — which
        // meant scrolling between right-click and click would target the
        // wrong page (the action would land on the page the user had
        // scrolled TO, not the page whose overlay they had right-clicked).
        // The captured value is closed over by every menu item below so the
        // action always targets the page that owned `targetOverlay` at
        // menu-open, regardless of subsequent scrolling.
        const pageNumberStr = targetOverlay.getAttribute('data-overlay-page')
            || targetOverlay.closest('.page')?.getAttribute('data-page-number');
        const pageNumber = pageNumberStr ? parseInt(pageNumberStr, 10) : null;
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
        // Phase 16 (C17): the addItem helper now supports an optional
        // `disabled` flag, used by the BBox Mode header item (which is a
        // status indicator, not a clickable action — see C4 correction).
        const addItem = (title: string, icon: string, onClick: () => void, disabled: boolean = false) =>
            menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(onClick).setDisabled(disabled));

        if (this.isBBoxEditMode()) {
            // P2-29 (Phase 13): do NOT mutate `selectedOverlays` at
            // menu-open. Previously this called
            // `selectOverlay(targetOverlay, false)` (which clears the Set
            // and re-adds only the target) when the target wasn't already
            // selected — opening the menu on an unselected overlay would
            // silently wipe the user's existing multi-selection. Now we
            // only preview the count via `getSelectionForAction` (which
            // itself no longer mutates). The bulk action handler is what
            // commits the selection.
            const selectedCount = this.getSelectionForAction(targetOverlay).length;
            // Phase 2 (C4) + Phase 16 (C17): this is a disabled status
            // indicator, not a clickable action — the title shows the
            // current selection count. The i18n key takes a {count}
            // placeholder so the format is locale-aware.
            addItem(t('overlay.menu.bboxMode', { count: selectedCount }), 'check-circle', () => {}, true);
            menu.addSeparator();

            // ── Active BBox operations (work with current contour pipeline) ──
            // The old "Retranslate as Columns/Table/Paragraphs/Block/Split" modes
            // used legacy layout settings (profileRegionFlowCostBias, pmForceLinearMerge,
            // etc.) that the contour pipeline ignores. They have been removed.
            // The operations below work with the current pipeline:

            addItem(t('overlay.menu.retranslateSelected'), 'refresh-cw', () => {
                // P2-28 (Phase 15): check if target overlay is still attached
                if (!targetOverlay.isConnected) {
                    new Notice('Overlay no longer available. Try again.', 2000);
                    return;
                }
                void this.applyBulkOverlayAction(targetOverlay, 'paragraphs', pageNumber);
            });
            addItem(t('overlay.menu.mergeSelected'), 'align-left', () => {
                if (!targetOverlay.isConnected) {
                    new Notice('Overlay no longer available. Try again.', 2000);
                    return;
                }
                void this.applyBulkOverlayAction(targetOverlay, 'block', pageNumber);
            });
            addItem(t('overlay.menu.deleteSelected'), 'trash', () => {
                if (!targetOverlay.isConnected) {
                    new Notice('Overlay no longer available. Try again.', 2000);
                    return;
                }
                void this.applyBulkOverlayAction(targetOverlay, 'delete', pageNumber);
            });
            menu.addSeparator();
            addItem(t('overlay.menu.selectAllBoxes'), 'selection', () => {
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
            addItem(t('overlay.menu.clearBboxSelection'), 'x-circle', () => {
                this.clearSelection();
            });
            menu.addSeparator();
        }

        addItem(t('overlay.menu.editTranslation'), 'pencil', () => {
            // P2-28 (Phase 15): check if target overlay is still attached
            if (!targetOverlay.isConnected) {
                new Notice('Overlay no longer available. Try again.', 2000);
                return;
            }
            if (!activeFile || pageNumber === null) { new Notice('Cannot edit: PDF context missing.'); return; }
            if (!originalText && !textToCopy)       { new Notice('Cannot edit: Reference text missing.'); return; }
            // Phase 11 (C8): build a partial OverlayPositionData for the
            // modal. The `relativeRect` fields are placeholders because the
            // modal only uses `textContent` and `translatedText` to locate
            // the entry on save (matches by content rather than index, since
            // indices can drift between modal open and save if the worker
            // writes a new page version).
            //
            // Phase 7 (P1-11): preserve the `id` from the source overlay's
            // `data-translation-id` attribute (stamped by createReflowOverlay
            // when the overlay was loaded from disk). The modal's save logic
            // (modal-edit-translation.ts:saveChanges) now does primary lookup
            // by `id` — this gives an exact match even when the page contains
            // duplicate textContent paragraphs. If the attribute is absent
            // (e.g. the overlay was rendered from in-memory TranslationUnits
            // that don't have an id), `id` is left undefined and the modal
            // falls back to textContent-based lookup.
            //
            // Phase 8 (V4 Schema): preserve the `engine` from the source
            // overlay's `data-engine` attribute (also stamped by
            // createReflowOverlay). When the attribute is absent (V3 file
            // that hasn't been re-saved through a Phase-8 construction
            // site), stamp `'manual-edit'` — the user is editing the
            // translation by hand, so the engine that produced the new text
            // is "manual" rather than any LLM provider. This sentinel is
            // visible in the per-overlay `%% {...} %%` block after save and
            // lets future stale-engine-detection distinguish "user hand-edited"
            // from "LLM-produced".
            const innerEl = targetOverlay.querySelector('div');
            const overlayId = innerEl?.dataset?.translationId || undefined;
            const overlayEngine = innerEl?.dataset?.engine || 'manual-edit';
            const overlayData: OverlayPositionData = {
                selector: '',
                textContent: originalText,
                relativeRect: { left: 0, top: 0, width: 0, height: 0 },
                page: pageNumber,
                translatedText: textToCopy,
                ...(overlayId ? { id: overlayId } : {}),
                engine: overlayEngine,
            };
            new EditSpecificTranslationModal(
                this.plugin.app, this.plugin, activeFile, pageNumber, overlayData
            ).open();
        });

        menu.addSeparator();

        addItem(t('overlay.menu.copyTranslation'), 'copy', async () => {
            // P2-28 (Phase 15): check if target overlay is still attached
            // (textToCopy was captured at menu-open, so the copy would
            // technically still work on a detached node — but warning the
            // user is friendlier than silently succeeding on a stale box).
            if (!targetOverlay.isConnected) {
                new Notice('Overlay no longer available. Try again.', 2000);
                return;
            }
            // P2-26 (Phase 15): surface clipboard failures to the user.
            // The previous `catch {}` swallowed EVERYTHING — including
            // `NotAllowedError` (user denied clipboard permission),
            // `NotFoundError` (no clipboard on this frame), and any other
            // throw — so the user saw no feedback when copy failed.
            try {
                await navigator.clipboard.writeText(textToCopy);
                new Notice('Translation copied.');
            } catch (e: any) {
                new Notice('Copy failed: ' + (e?.message || e));
            }
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

        addItem(t('overlay.menu.copyAsCallout'),  'quote-glyph',  () => copyFormattedText(this.plugin.settings.calloutFormat,  'callout'));
        addItem(t('overlay.menu.copyAsCitation'), 'book-open',    () => copyFormattedText(this.plugin.settings.citationFormat, 'citation'));
        addItem(t('overlay.menu.copyAsFootnote'), 'superscript',  () => copyFormattedText(this.plugin.settings.footnoteFormat, 'footnote'));

        menu.addSeparator();

        addItem(t('overlay.menu.retranslatePage'), 'refresh-cw', () => {
            if (activeFile) new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, activeFile).open();
        });

        addItem(t('overlay.menu.forceRefresh'), 'refresh-ccw', () => {
            const renderer = this.plugin.overlay as any;
            if (typeof renderer?.forceRefreshVisibleOverlays === 'function') {
                renderer.forceRefreshVisibleOverlays();
            } else {
                new Notice('Refresh function not available');
            }
        });

        menu.addSeparator();

        addItem(t('overlay.menu.increaseTextSize'),   'zoom-in',  () => this.adjustSingleOverlayFontSize(targetOverlay, 1.1));
        addItem(t('overlay.menu.decreaseTextSize'),   'zoom-out', () => this.adjustSingleOverlayFontSize(targetOverlay, 1 / 1.1));
        addItem(t('overlay.menu.increaseLineHeight'), 'plus',     () => this.adjustSingleOverlayLineHeight(targetOverlay,  LINE_HEIGHT_STEP));
        addItem(t('overlay.menu.decreaseLineHeight'), 'minus',    () => this.adjustSingleOverlayLineHeight(targetOverlay, -LINE_HEIGHT_STEP));

        menu.addSeparator();

        addItem(t('overlay.menu.goToTranslationFile'), 'file-text', () => {
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

    // Phase 1 (dead-code removal): the `cleanupHoverHandlers` method that
    // lived here has been removed along with the `hoverHandlers` field on
    // `OverlayHandlers`. They were leftovers from a hover-tooltip feature
    // that was deleted in an earlier refactor — no caller ever set
    // `hoverHandlers`, so the method always returned without doing
    // anything. Keeping it only confused readers into thinking there was
    // state worth preserving here.

    public cleanupOverlayElement(el: HTMLElement): void {
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
        // fix-bbox-selection: detachMarqueeListeners() is now responsible
        // for the full teardown of the selection overlay, in-flight drag
        // state, and the Escape key listener. It is idempotent — safe to
        // call whether BBox mode is currently ON or OFF.
        this.detachMarqueeListeners();

        // FIX: also clean up the persistent measure span
        if (this.measureSpan) {
            this.measureSpan.remove();
            this.measureSpan = null;
        }
        // P2-24 (Phase 15): cancel any in-flight font-adjustment persist
        // timer. If the user adjusted an overlay's font size and then
        // immediately closed the PDF / unloaded the plugin before the
        // PERSIST_ADJUSTMENT_DEBOUNCE_MS window elapsed, the timer would
        // otherwise fire against a stale overlayEl (whose `isConnected`
        // check now safely short-circuits, but cancelling the timer here
        // is cleaner and avoids the closure keeping `overlayEl` alive
        // past teardown).
        if (this.persistAdjustmentTimer !== null) {
            window.clearTimeout(this.persistAdjustmentTimer);
            this.persistAdjustmentTimer = null;
        }
    }

    public extractPlainTextFromHtml(html: string): string {
        if (!this.tempDiv) this.tempDiv = document.createElement('div');
        // Phase 7 (C4): sanitize before assigning to innerHTML. Even though
        // this method only reads back `textContent` (so no script execution
        // is *expected*), defense-in-depth says: never assign untrusted
        // strings to innerHTML unsanitized. If a future code change ever
        // appends this tempDiv to the DOM (or reads its innerHTML), the
        // sanitize call here ensures the content is already safe.
        this.tempDiv.innerHTML = DOMPurify.sanitize(html, PURIFY_CONFIG);
        return this.tempDiv.textContent || this.tempDiv.innerText || '';
    }
}
