import { RegionLayoutEditor } from './region-layout-editor';
import { fallbackIndices } from './translation-result';
// overlay-ui.ts
// Extracted UI and Rendering logic for PDF Translation Overlays

import { Menu, Notice, FileView } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { EditSpecificTranslationModal } from './modal-edit-translation';
import type { OverlayPositionData } from './types';
import type { LayoutSettings } from './layout-modal';
// Phase 7 (C4): sanitize translated-text HTML before it ever touches the DOM.
// DOMPurify is configured with a strict whitelist (only inline-formatting
// tags, no attributes) so even if a malicious or buggy translation backend
// returns `<img onerror=...>` or `<a href="javascript:...">`, the payload
// is stripped at the boundary instead of being rendered.
import DOMPurify, { type Config } from 'dompurify';
// Phase 16 (C17): i18n shim for the context-menu strings. Falls back to the
// key itself when no translation is registered, so the plugin stays
// functional in English even without a translation file.
import { t } from './i18n';
import { buildSpanFilterCtx } from './table-keep';

// ============================================================
// Constants & Configuration
// ============================================================

const LINE_HEIGHT_MIN = 0.9;
const LINE_HEIGHT_MAX = 1.3;
const LINE_HEIGHT_STEP = 0.05;

// --- Visual Tweaks & Overlap Prevention ---
const BLEED_X = 4;
// BBOX-FIT-3: пол 3px — перезагружаемый путь считает bleed от дескейленного
// размера шрифта (см. ниже) и на serif-книгах (try.pdf p2: асцендеры до
// 2.94px выше спанов при fs 13.5px) упирался в 2.69px < 2.94 — срез
// верхушек возвращался после перезагрузки. Пол 3px покрывает оба пути.
const BLEED_Y_NORMAL = 3;
const BLEED_Y_TIGHT = 0;
// BBOX-FIT-3: вертикальный запас подбирается под размер шрифта — pdf.js
// позиционирует спаны по ascent, измеренному measureText() подставленного
// глифового шрифта, и для ряда шрифтов (serif-книги) фактические чернила
// доходят до ~0.22×fs выше спана (замер на try.pdf p2: 2.94px при fs 13.5px).
// Фиксированные 2px оставляли срез верхушек глифов; кап 4px держит footprint.
const BLEED_Y_FONT_FRAC = 0.22;
const BLEED_Y_MAX = 4;
const TIGHT_LINE_HEIGHT_THRESHOLD = 24;

const DEFAULT_BG = '#ffffff';

// --- Safeguard Constants for Short Phrases/Headings ---
const SHORT_PHRASE_WORD_LIMIT = 4;
const SHORT_PHRASE_PADDING_RIGHT_EM = 0.2;

// --- Auto-fit constants ---
const MIN_FONT_SIZE_PX = 6;
const FONT_SHRINK_FACTOR = 0.95;
const MAX_SHRINK_ITERATIONS = 40; // more iterations = finer fit
const MIN_LINE_HEIGHT_SHRINK = 0.85;

// BBOX-FIT (2026-09-14): подгонка перевода в ИСХОДНЫЙ bbox.
// Баланс трёх требований: (1) переведённый бокс занимает то же место, что
// исходный; (2) текст помещается полностью, без обрезки; (3) текст одной
// группы (например, body) — одного размера. Конфликт разрешается так:
// короткие фразы расширяются ТОЛЬКО в свободное пространство до соседа
// (и не более чем на SHORT_PHRASE_MAX_EXPANSION), дальше — ужимка шрифта;
// длинный текст не меняет бокс вовсе — двоичный поиск шрифта по каждому
// боксу, затем ГРУППОВАЯ унификация (единый размер = минимум по группе,
// но не ниже GROUP_SHRINK_FLOOR — иначе патологический абзац утопит всю
// страницу; остаток дожимается line-height'ом и scroll-фолбэком).
const NEIGHBOR_GAP_PX = 2;               // минимальный визуальный зазор до соседа справа
const RIGHT_PAGE_MARGIN_PX = 4;          // отступ от правого края страницы
const SHORT_PHRASE_MAX_EXPANSION = 1.3;  // короткая фраза расширяется не более чем на 30% исходной ширины
const GROUP_SHRINK_FLOOR = 0.70;         // единый шрифт группы не ниже 70% исходного размера
const GROUP_BUCKET_STEP = 0.5;           // шаг группировки исходных размеров (px)

// BBOX-FIT-2 (2026-09-14, round 2): РЕМОНТ ИСХОДНОЙ ГЕОМЕТРИИ.
// Реальный прогон в Obsidian (EN→RU, книга Tumors in Domestic Animals)
// показал: ИСХОДНЫЕ боксы параграфов сами пересекаются — (а) pdfjs теряет
// TJ-корректировки пробелов InDesign → правые края строк ЛЕВОЙ колонки
// дрейфуют до +22pt и залезают на правую колонку (задокументировано в
// layout-стадии); (б) IslandBuilder иногда оставляет строку-фрагмент
// ОТДЕЛЬНЫМ юнитом, чей бокс лежит ВНУТРИ бокса большого абзаца. Инвариант
// v1 «бокс длинного текста не меняется» честно сохранял эти дефекты —
// непрозрачные белые боксы наползали друг на друга (то, что видел
// пользователь). Правило v2: пара боксов не может перекрываться; исходный
// footprint сохраняется ТОЧНО, пока геометрия не конфликтует — конфликт
// разрешается минимальной правкой (клип раздутого края / слияние фрагмента).
const SRC_CONTAIN_TOL_PX = 3;        // допуск «B целиком внутри A» (px)
const SRC_CONTAIN_AREA_FRAC = 0.55;  // B < 55% площади A → фрагмент, а не равный сосед
const SRC_CLIP_MAX_PX = 60;          // максимум отрезаемого перекрытия (больше — не дрейф, а слом макета)
const SRC_MIN_KEEP_PX = 24;          // минимальная ширина бокса после клипа

// Phase 7 (C4): DOMPurify whitelist. Only inline-formatting tags survive —
// no `<a>`, no `<img>`, no `<script>`, no attributes (so no `style=`,
// no `onerror=`, no `href="javascript:"`). `KEEP_CONTENT: true` means
// disallowed tags are unwrapped (their text content is preserved) instead
// of being dropped wholesale, so a translation that arrives wrapped in a
// `<span>` still renders its text.
const PURIFY_CONFIG = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'sup', 'sub', 'u'],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
} satisfies Config;

// Types for internal state
type OverlayHandlers = {
    contextHandler: EventListener;
    clickHandler?: EventListener;
    bringToTopHandler?: EventListener;
    resetZIndexHandler?: EventListener;
};

// BBOX-FIT-2: снапшот геометрии одного оверлея для пакетного ремонта/подгонки.
type SourceBoxRec = {
    el: HTMLElement;
    left: number;
    top: number;
    width: number;
    height: number;
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
        // fix-bbox-selection: marquee/selection system is now lazily
        // attached via attachMarqueeListeners() when BBox Edit Mode is
        // toggled ON, and fully torn down via detachMarqueeListeners() on
        // OFF / cleanup. No constructor-time initialisation is needed.
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
        overlayData?: { id?: string; engine?: string; translationStatus?: 'fallback' } | OverlayPositionData
    ): HTMLElement {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return document.createElement('div');
        }

        // --- 1. Short-phrase analysis ---
        const plainText = this.extractPlainTextFromHtml(htmlText).trim();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length; // FIX: filter empty tokens
        // TABLE-KEEP: построчный (табличный) текст НЕ короткая фраза, даже если
        // слов <= 4 — nowrap-путь (fitShortPhraseToBox + estimateTextWidth)
        // не понимает <br> и разъезжается; такие боксы идут по длинному пути
        // (двоичный поиск реальной геометрии, scrollWidth = широчайшая строка).
        const isShortPhrase = wordCount <= SHORT_PHRASE_WORD_LIMIT && !/<br\s*\/?>/i.test(htmlText || '');

        // --- 2. Tight-line detection ---
        const isTightLine = rect.height < TIGHT_LINE_HEIGHT_THRESHOLD;

        const el = document.createElement('div');
        el.className = 'pdf-text-overlay-reflow';

        if (isShortPhrase) {
            el.classList.add('force-top-align');
        }

        // FIX: store short-phrase flag in data attr so sizing logic doesn't depend on CSS class name
        el.setAttribute('data-is-short-phrase', isShortPhrase ? 'true' : 'false');

        // --- 3. Font calculation ---
        // FIX (v5): use DOMINANT font size (most frequent) instead of average.
        // Average is skewed by superscripts/subscripts (e.g. [22] in 8pt mixed
        // with 10pt body → avg=9pt, but body should render at 10pt).
        // Dominant = the size that appears most often in originalFontSizes.
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

        const baseFontSize = avgOriginalFontSize * outputFontSizeScale;
        const currentFontSize = baseFontSize * lastKnownScale;

        // --- 3.5. Line height (computed early for vertical compensation) ---
        let startLH = outputLineHeight;
        if (isTightLine) {
            startLH = Math.min(outputLineHeight, 1.1);
        } else if (startLH > 1.2) {
            startLH = 1.2;
        }

        // BBOX-FIT-3: вертикальный bleed пропорционален экранному размеру
        // шрифта (0.22×fs, пол 2px, кап 4px) — см. константы выше. Значение
        // фиксируется в data-bleed-y: extractPositionDataFrom реверсирует
        // именно его при save (иначе дроби в .translations.md несут сдвиг).
        const currentBleedY = isTightLine
            ? BLEED_Y_TIGHT
            : Math.min(BLEED_Y_MAX, Math.max(BLEED_Y_NORMAL, currentFontSize * BLEED_Y_FONT_FRAC));

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
        el.setAttribute('data-bleed-y',         `${currentBleedY}`);
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
        // TABLE-KEEP: единый маркер перевода строки — <br>. Сырые \n (старые
        // .translations.md, edit-модаль) в white-space:normal рендерятся
        // пробелом — конвертируем ДО санитайза (br в белом списке).
        const htmlNormalized = String(htmlText ?? '').replace(/\r?\n/g, '<br>');
        const sanitized = DOMPurify.sanitize(htmlNormalized.trim() || '…', PURIFY_CONFIG);
        // eslint-disable-next-line no-unsanitized/property -- DOMPurify-sanitized with a strict whitelist (inline formatting only; no script/img/event handlers); required to render translation HTML
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
        if (overlayData?.translationStatus === 'fallback') inner.dataset.translationStatus = 'fallback';
        if (overlayData?.engine) {
            inner.dataset.engine = overlayData.engine;
        }
        el.appendChild(inner);

        // Short-phrase overrides: force nowrap, but keep outer overflow hidden
        // (original used overflow:visible on the outer element which caused bleed)
        if (isShortPhrase) {
            inner.setCssStyles({ whiteSpace: 'nowrap', overflow: 'visible' });
            // FIX: do NOT set el.style.overflow = 'visible' — bleeds over neighbours
            el.style.paddingRight   = `${SHORT_PHRASE_PADDING_RIGHT_EM}em`;
            el.style.minWidth       = `${adjustedWidth}px`;
        }

        // --- 6. Line height (startLH computed in step 3.5) ---
        this.applyLineHeight(inner, startLH);

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
        const resetZIndexHandler = () => { el.setCssStyles({ zIndex: '101' }); };
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
    // BBOX-FIT (2026-09-14): Sizing Logic (Overflow & Fit)
    // ============================================================
    // Продакшн-вход — пакетная подгонка СТРАНИЦЫ (см. fitOverlayBatch):
    // все три рендер-пути (renderOverlays / renderSavedOverlay /
    // rerenderVisibleOverlaysInner) собирают оверлеи страницы и зовут
    // ОДИН пакетный проход. Одиночный вход (adjustOverlayForOverflow)
    // сохранён для ручных/внешних путей и тестов.
    //
    // Инварианты подгонки:
    //   1. Бокс длинного текста НЕ меняется ни по ширине, ни по высоте
    //      (перевод обязан поместиться в исходное пространство).
    //   2. Короткая фраза может занять свободное пространство справа —
    //      но не далее чем до соседнего бокса (минус NEIGHBOR_GAP_PX) и
    //      не шире SHORT_PHRASE_MAX_EXPANSION от исходной ширины; что не
    //      влезло — ужимается шрифтом.
    //   3. Шрифт длинного текста един в группе исходных размеров
    //      (bucket GROUP_BUCKET_STEP): target = min(fitted) по группе,
    //      но не ниже GROUP_SHRINK_FLOOR. Остаток — line-height, затем
    //      scroll-фолбэк (текст всегда доступен целиком, обрезки нет).

    /** Пакетная подгонка оверлеев одной страницы.
     *
     *  @param entries  оверлеи страницы + исходный line-height настройки
     *                  (используется как fallback при дожатии line-height).
     *  @param pageWidth ширина страницы в координатах style.left оверлеев
     *                  (page-relative px). Обязателен для staging-путей, где
     *                  `closest('.page')` недоступен; иначе берётся из DOM.
     */
    public fitOverlayBatch(entries: { el: HTMLElement; lh: number }[], pageWidth?: number): void {
        const live = (entries || []).filter(e => e && e.el && e.el.isConnected);
        if (live.length === 0) return;

        // 1. Снапшот исходной геометрии ДО любых мутаций (координаты
        //    контейнера/страницы, уже запечённые в style.left/top/width/height).
        let boxes = live.map(({ el }) => ({
            el,
            left: parseFloat(el.style.left) || 0,
            top: parseFloat(el.style.top) || 0,
            width: parseFloat(el.style.width) || 0,
            height: parseFloat(el.style.height) || 0,
        }));

        // 1.5 BBOX-FIT-2: РЕМОНТ ИСХОДНОЙ ГЕОМЕТРИИ. Исходные боксы сами
        //     могут пересекаться (pdfjs-дрейф правых краёв левой колонки;
        //     фрагмент-строки отдельными юнитами внутри большого абзаца) —
        //     «наползания», которые видел пользователь в Obsidian. Инвариант
        //     v1 «бокс не меняется» их сохранял; v2 чинит ДО подгонки:
        //       (a) фрагмент внутри абзаца → текст фрагмента вливается в
        //           абзац (бокс фрагмента убирается с рендера);
        //       (b) поперечное перекрытие ≤ SRC_CLIP_MAX_PX → клип
        //           раздутого правого края до зазора перед соседом.
        //     Страница без конфликтов → ремонт не меняет НИЧЕГО (байт-
        //     идентичное поведение v1).
        const repair = this.repairSourceOverlaps(boxes);
        boxes = repair.boxes;

        // 2. Правые пределы: край страницы → ближайший сосед по вертикали.
        //    Сосед — бокс, чей y-диапазон перекрывает мой (строгая проверка
        //    отсекает касания bleed'ом и диагональные пары).
        const caps: number[] = boxes.map(b => {
            let cap = Number.isFinite(pageWidth as number) ? (pageWidth as number) : this.pageWidthOf(b.el);
            if (!Number.isFinite(cap) || cap <= 0) cap = Infinity;
            return cap - b.left - RIGHT_PAGE_MARGIN_PX;
        });
        for (let i = 0; i < boxes.length; i++) {
            for (let j = 0; j < boxes.length; j++) {
                if (i === j) continue;
                const a = boxes[i];
                const b = boxes[j];
                const yOver = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
                if (!(yOver > 4 && yOver > 0.2 * Math.min(a.height, b.height))) continue;
                if (b.left >= a.left + a.width - 0.5) {
                    caps[i] = Math.min(caps[i], b.left - a.left - NEIGHBOR_GAP_PX);
                }
            }
        }

        // 3. Индивидуальная подгонка. Длинный текст — ТОЛЬКО Strategy 1
        //    (двоичный поиск шрифта): дожатие line-height/scroll отложено
        //    до группового прохода, чтобы не бороться с самим собой.
        const longs: { el: HTMLElement; base: number; fitted: number }[] = [];
        boxes.forEach((box, idx) => {
            const el = box.el;
            const isShort = el.getAttribute('data-is-short-phrase') === 'true';
            el.classList.remove('is-scrollable');
            el.setCssStyles({ overflow: 'hidden' });
            if (isShort) {
                this.fitShortPhraseToBox(el, caps[idx]);
            } else {
                const fitted = this.fitLongTextFontSize(el);
                const base = parseFloat(el.getAttribute('data-original-font-size') || '0') || fitted;
                longs.push({ el, base, fitted });
            }
        });

        // 4. Групповая унификация шрифта длинного текста: bucket = исходный
        //    размер (шаг 0.5px). Единый target = min(fitted) по группе,
        //    зажатый снизу GROUP_SHRINK_FLOOR (патологический абзац не топит
        //    всю страницу — ему достанется scroll-фолбэк на шаге 5).
        const groups = new Map<number, { el: HTMLElement; base: number; fitted: number }[]>();
        for (const rec of longs) {
            const bucket = Math.round(rec.base / GROUP_BUCKET_STEP) * GROUP_BUCKET_STEP;
            if (!groups.has(bucket)) groups.set(bucket, []);
            groups.get(bucket)!.push(rec);
        }
        for (const recs of groups.values()) {
            if (recs.length < 2) continue;
            const minFitted = Math.min(...recs.map(r => r.fitted));
            const floor = Math.max(MIN_FONT_SIZE_PX, recs[0].base * GROUP_SHRINK_FLOOR);
            const target = Math.min(Math.max(minFitted, floor), recs[0].base);
            for (const rec of recs) {
                const cur = parseFloat(rec.el.style.fontSize);
                if (Number.isFinite(cur) && Math.abs(cur - target) > 0.01) {
                    rec.el.style.fontSize = `${target}px`;
                }
            }
        }

        // 5. Дожатие остатков: line-height → scroll (единый путь для всех
        //    длинных, включая одиночные bucket'ы и «поднятые полом» члены).
        //    ВАЖНО: без бампа к 9px — иначе члены со scroll получают размер
        //    больше группового target и униформа рушится.
        for (const rec of longs) {
            const inner = rec.el.querySelector('div') as HTMLDivElement | null;
            if (!inner) continue;
            if (this.isLongTextOverflowing(rec.el, inner)) this.shrinkLineHeightTo(inner);
            if (this.isLongTextOverflowing(rec.el, inner)) this.enableScrollFallback(rec.el, false);
        }
    }

    // ── BBOX-FIT-2: строительные блоки ремонта исходной геометрии ────────

    /**
     * Ремонт перекрытий ИСХОДНЫХ боксов (см. константы SRC_*).
     *
     * Порядок: (a) слияние фрагментов (до фикспоинта, ≤3 прохода — фрагмент
     * может сам содержать фрагмент); (b) поперечный клип остатков.
     * Вертикальные касания bleed'ом (≤5px, белое на белом) НЕ чинятся —
     * визуально неотличимы, а правка высоты ломала бы «footprint точь-в-точь».
     *
     * Мутирует style.width/minWidth/data-initial-width (клип) и innerHTML
     * (слияние) + УДАЛЯЕТ элементы-фрагменты из DOM. Возвращает пост-ремонтный
     * список боксов (без слитых).
     */
    private repairSourceOverlaps(boxes: SourceBoxRec[]): { boxes: SourceBoxRec[]; fused: number; clipped: number } {
        let fused = 0;
        let clipped = 0;
        const alive: SourceBoxRec[] = [...boxes];

        // (a) Слияние фрагментов: B целиком внутри A (допуск SRC_CONTAIN_TOL_PX)
        //     и B заметно меньше (площадь < SRC_CONTAIN_AREA_FRAC) → B это
        //     строка-фрагмент, выпавшая из абзаца A при layout-анализе.
        //     Текст фрагмента дописывается в конец текста абзаца (фрагменты
        //     одного абзаца — по порядку сверху-вниз), бокс фрагмента
        //     снимается с рендера (его запись в .translations.md будет
        //     поглощена при merge-by-overlap на ближайшем save).
        for (let pass = 0; pass < 3; pass++) {
            const fragsByBig = new Map<SourceBoxRec, SourceBoxRec[]>();
            for (let i = 0; i < alive.length; i++) {
                for (let j = 0; j < alive.length; j++) {
                    if (i === j) continue;
                    const A = alive[i], B = alive[j];
                    if (!this.boxContains(A, B)) continue;
                    if (B.width * B.height > SRC_CONTAIN_AREA_FRAC * A.width * A.height) continue;
                    if (!fragsByBig.has(A)) fragsByBig.set(A, []);
                    if (!fragsByBig.get(A)!.includes(B)) fragsByBig.get(A)!.push(B);
                }
            }
            if (fragsByBig.size === 0) break;
            for (const [big, frags] of fragsByBig) {
                frags.sort((p, q) => (p.top - q.top) || (p.left - q.left));
                for (const frag of frags) {
                    this.fuseFragmentInto(big, frag);
                    const k = alive.indexOf(frag);
                    if (k >= 0) alive.splice(k, 1);
                    fused++;
                }
            }
        }

        // (b) Поперечный клип: пара с x-перекрытием ≤ SRC_CLIP_MAX_PX и
        //     < половины более узкого бокса (то есть ДРЕЙФ края, а не
        //     вертикальная стопка в одной колонке, где xo ≈ ширине колонки).
        //     Режем ПРАВЫЙ край ЛЕВОГО бокса до зазора перед соседом:
        //     левые якоря (Tm первых строк) точны, раздувается именно правый
        //     край. Если клип оставляет < SRC_MIN_KEEP_PX — делим перекрытие
        //     пополам (крайний случай, оба якоря теряют по чуть-чуть).
        for (let i = 0; i < alive.length; i++) {
            for (let j = 0; j < alive.length; j++) {
                if (i === j) continue;
                const A = alive[i], B = alive[j];
                const xo = Math.min(A.left + A.width, B.left + B.width) - Math.max(A.left, B.left);
                const yo = Math.min(A.top + A.height, B.top + B.height) - Math.max(A.top, B.top);
                if (xo <= 1 || yo <= 1) continue;
                if (xo > SRC_CLIP_MAX_PX || xo > 0.5 * Math.min(A.width, B.width)) continue;
                // A должен быть левым (режем ЕГО правый край); при равных
                // left режем более широкий.
                const aIsLeft = A.left < B.left - 0.5 || (Math.abs(A.left - B.left) <= 0.5 && A.width >= B.width);
                const L = aIsLeft ? A : B;
                const R = aIsLeft ? B : A;
                if (L.left + L.width <= R.left + 0.5) continue; // уже не перекрываются
                const newWidth = R.left - L.left - NEIGHBOR_GAP_PX;
                if (newWidth >= Math.max(SRC_MIN_KEEP_PX, 0.3 * L.width)) {
                    this.applyBoxWidth(L, newWidth);
                    clipped++;
                } else {
                    // Крайний случай: сосед почти вплотную к левому якорю —
                    // делим перекрытие пополам, зазор NEIGHBOR_GAP_PX/2 каждому.
                    const mid = (R.left + L.left + L.width) / 2;
                    const cutL = L.left + L.width - (mid - NEIGHBOR_GAP_PX / 2);
                    const cutR = (mid + NEIGHBOR_GAP_PX / 2) - R.left;
                    if (cutL > 0) this.applyBoxWidth(L, L.width - cutL);
                    if (cutR > 0) {
                        R.el.style.left = `${R.left + cutR}px`;
                        R.el.setAttribute('data-initial-left', `${R.left + cutR}`);
                        this.applyBoxWidth(R, R.width - cutR);
                        R.left += cutR; R.width -= cutR;
                    }
                    clipped++;
                }
            }
        }

        if ((fused > 0 || clipped > 0) && this.plugin.settings.debugMode) {
            console.debug(`[OverlayUIRenderer] Source-geometry repair: fused=${fused}, clipped=${clipped}`);
        }
        return { boxes: alive, fused, clipped };
    }

    /** B (с допуском SRC_CONTAIN_TOL_PX) целиком внутри A? */
    private boxContains(A: SourceBoxRec, B: SourceBoxRec): boolean {
        return A.left - SRC_CONTAIN_TOL_PX <= B.left
            && A.top - SRC_CONTAIN_TOL_PX <= B.top
            && A.left + A.width + SRC_CONTAIN_TOL_PX >= B.left + B.width
            && A.top + A.height + SRC_CONTAIN_TOL_PX >= B.top + B.height;
    }

    /** Вливает текст фрагмента в конец текста абзаца; бокс фрагмента убирает. */
    private fuseFragmentInto(big: SourceBoxRec, frag: SourceBoxRec): void {
        const bigInner = big.el.querySelector('div') as HTMLDivElement | null;
        const fragInner = frag.el.querySelector('div') as HTMLDivElement | null;
        try {
            if (bigInner && fragInner) {
                const add = (fragInner.innerHTML || '').trim();
                if (add) {
                    const cur = (bigInner.innerHTML || '').trim();
                    bigInner.innerHTML = cur ? `${cur} ${add}` : add;
                }
            }
        } catch (e) {
            console.debug('[OverlayUIRenderer] fuseFragmentInto failed:', e);
        }
        // Снять оверлей с рендера (вызывает ripple на WeakMap-хендлеры —
        // teardown идёт через общий destroy, здесь достаточно remove()).
        frag.el.remove();
    }

    /** Применяет новую ширину к боксу: style.width + minWidth + data-initial-width
     *  (атрибут читают save-реверс и fitShortPhraseToBox — клип обязан
     *  доехать и туда, иначе расползание вернётся после перезагрузки). */
    private applyBoxWidth(box: SourceBoxRec, newWidth: number): void {
        if (!(newWidth > 0)) return;
        box.width = newWidth;
        box.el.style.width = `${newWidth}px`;
        if (box.el.style.minWidth) box.el.style.minWidth = `${newWidth}px`;
        box.el.setAttribute('data-initial-width', `${newWidth}`);
    }

    /**
     * Одиночная подгонка одного оверлея (внешние/ручные пути, тесты).
     *
     * Длинный текст: шрифт (двоичный поиск) → line-height → scroll.
     * Короткая фраза: расширение до предела (кап/страница) → ужимка шрифта.
     * Если бокс уже вмещает текст — мягкое восстановление размера к
     * исходному (grow-back, как в исходной версии).
     *
     * @param rightCapPx необязательный правый предел ШИРИНЫ (px, в
     *        координатах style.left). Без него — край страницы через
     *        `closest('.page')` (старое поведение).
     */
    public adjustOverlayForOverflow(el: HTMLElement, outputLineHeight: number, rightCapPx?: number): void {
        void outputLineHeight; // line-height читается из inner.style (см. shrinkLineHeightTo)
        const inner = el.querySelector('div') as HTMLDivElement | null;
        if (!inner) return;

        const isShortPhrase = el.getAttribute('data-is-short-phrase') === 'true';

        // Reset scrollable state
        el.classList.remove('is-scrollable');
        el.setCssStyles({ overflow: 'hidden' });

        if (isShortPhrase) {
            this.fitShortPhraseToBox(el, rightCapPx);
            return;
        }

        // ----------------------------------------------------------------
        // LONG TEXT — shrink font → recover → shrink line-height → scroll
        // ----------------------------------------------------------------
        if (!this.isLongTextOverflowing(el, inner)) {
            // Бокс мог вырасти (или текст стал короче) — пробуем вернуть
            // шрифт к исходному, пока помещается (мягкий grow-back).
            const originalFontSize = parseFloat(el.getAttribute('data-original-font-size') || '0');
            if (originalFontSize > 0) {
                let fs = parseFloat(el.style.fontSize);
                let attempts = 0;
                while (!this.isLongTextOverflowing(el, inner) && fs < originalFontSize && attempts < 10) {
                    el.style.fontSize = `${Math.min(fs / FONT_SHRINK_FACTOR, originalFontSize)}px`;
                    if (this.isLongTextOverflowing(el, inner)) { el.style.fontSize = `${fs}px`; break; }
                    fs = parseFloat(el.style.fontSize);
                    attempts++;
                }
            }
            return;
        }

        // Strategy 1 — Shrink font size (binary search, v5/P2-63)
        this.fitLongTextFontSize(el);

        // Strategy 2 — Shrink line height
        if (this.isLongTextOverflowing(el, inner)) this.shrinkLineHeightTo(inner);

        // Strategy 3 — Scrollable fallback
        if (this.isLongTextOverflowing(el, inner)) this.enableScrollFallback(el);
    }

    // ── Приватные строительные блоки подгонки ──────────────────────────

    /** Ширина страницы в координатах style.left оверлея (или Infinity). */
    private pageWidthOf(el: HTMLElement): number {
        const pageEl = el.closest ? (el.closest('.page') as HTMLElement | null) : null;
        if (!pageEl) return Infinity;
        // BBOX-FIT-3: padding-box (clientWidth) — рамка координат оверлеев;
        // border-box шире на --page-border pdf.js 4.x. jsdom-фолбэк — rect.
        const cw = pageEl.clientWidth;
        if (cw > 0) return cw;
        const w = pageEl.getBoundingClientRect().width;
        return Number.isFinite(w) && w > 0 ? w : Infinity;
    }

    /** Длинный текст не помещается в бокс (по вертикали или горизонтали)? */
    private isLongTextOverflowing(el: HTMLElement, inner: HTMLDivElement): boolean {
        return inner.scrollHeight > el.clientHeight + 1 ||
               inner.scrollWidth > el.clientWidth + 1;
    }

    /**
     * Strategy 1: двоичный поиск НАИБОЛЬШЕГО шрифта, при котором длинный
     * текст помещается в бокс. Применяет найденный размер и возвращает его.
     * Аттрибут data-original-font-size фиксирует исходный размер (первый
     * вызов), чтобы повторные подгонки не «ползли» вниз от уже ужатого.
     */
    private fitLongTextFontSize(el: HTMLElement): number {
        const inner = el.querySelector('div') as HTMLDivElement | null;
        const currentFs = parseFloat(el.style.fontSize) || 12;
        if (!inner) return currentFs;

        if (!el.getAttribute('data-original-font-size')) {
            el.setAttribute('data-original-font-size', el.style.fontSize);
        }
        const originalFs = parseFloat(el.getAttribute('data-original-font-size') || '12');
        let lo = MIN_FONT_SIZE_PX;
        let hi = originalFs;
        // Уже помещается при исходном размере — не трогаем.
        el.style.fontSize = `${hi}px`;
        if (!this.isLongTextOverflowing(el, inner)) return hi;
        // P2-63 (Phase 15): 6 итераций, точность 1px — визуально достаточно.
        for (let iter = 0; iter < 6 && hi - lo > 1; iter++) {
            const mid = (lo + hi) / 2;
            el.style.fontSize = `${mid}px`;
            if (this.isLongTextOverflowing(el, inner)) hi = mid;
            else lo = mid;
        }
        el.style.fontSize = `${lo}px`;
        return lo;
    }

    /**
     * Strategy 2: дожимает line-height шагами 0.05 до MIN_LINE_HEIGHT_SHRINK.
     * Стартует с ТЕКУЩЕГО line-height inner-элемента (создание могло дать
     * 1.1 для tight-строк — стартовать с 1.2 настройки значило бы УВЕЛИЧИТЬ
     * межстрочный интервал tight-бокса).
     */
    private shrinkLineHeightTo(inner: HTMLDivElement): void {
        const el = inner.parentElement as HTMLElement | null;
        if (!el) return;
        const cur = parseFloat(inner.style.lineHeight);
        let lh = Number.isFinite(cur) ? cur : (this.plugin.settings.outputLineHeight || 1.2);
        let iterations = 0;
        while (lh > MIN_LINE_HEIGHT_SHRINK && this.isLongTextOverflowing(el, inner) && iterations < 10) {
            lh -= 0.05;
            this.applyLineHeight(inner, lh);
            iterations++;
        }
    }

    /**
     * Strategy 3: scroll-фолбэк (текст доступен целиком).
     * @param bumpToReadable одиночный путь бампает шрифт к 9px для
     *        читаемости (легаси-поведение); пакетный путь НЕ бампает —
     *        бамп разрушает групповую униформу размеров.
     */
    private enableScrollFallback(el: HTMLElement, bumpToReadable = true): void {
        const fs = parseFloat(el.style.fontSize);
        if (bumpToReadable && Number.isFinite(fs) && fs < 9) {
            el.setCssStyles({ fontSize: '9px' });
        }
        // BBOX-FIT-2: класса `is-scrollable` НЕТ в CSS плагина (styles.css
        // отсутствует, все стили инлайн) — реальный Chromium подтвердил
        // эмуляцией: overflow оставался hidden и текст просто ОБРЕЗАЛСЯ.
        // Ставим инлайн-стиль напрямую; класс сохранён для совместимости
        // с существующими проверками/селекторами.
        el.classList.add('is-scrollable');
        el.setCssStyles({ overflow: 'auto' });
        if (this.plugin.settings.debugMode) {
            const inner = el.querySelector('div');
            console.debug('[OverlayUIRenderer] Fallback scroll enabled for:', inner?.textContent?.substring(0, 30));
        }
    }

    /**
     * Короткая фраза (≤4 слов, nowrap): адаптировать текст к боксу.
     *
     * ПРАВИЛА:
     *   1. Бокс никогда не уже исходного.
     *   2. Перевод длиннее бокса → расширение В СВОБОДНОЕ пространство:
     *      не далее соседа справа (rightCapPx, минус NEIGHBOR_GAP_PX) и не
     *      шире SHORT_PHRASE_MAX_EXPANSION. Раньше пределом был только
     *      край страницы — в 2-колоночном layout'e фразы заползали на
     *      правую колонку и соседние ячейки таблиц.
     *   3. Дальше — ужимка шрифта (пол MIN_FONT_SIZE_PX).
     */
    private fitShortPhraseToBox(el: HTMLElement, rightCapPx?: number): void {
        const inner = el.querySelector('div') as HTMLDivElement | null;
        if (!inner) return;
        inner.setCssStyles({ whiteSpace: 'nowrap', overflow: 'visible' });

        const currentFontSize = parseFloat(el.style.fontSize) || 12;
        const fontFamily = el.style.fontFamily || 'sans-serif';
        const plainText = inner.textContent || '';
        if (!plainText.trim()) return;

        const originalWidth = parseFloat(el.getAttribute('data-initial-width') || '0')
                           || parseFloat(el.style.width)
                           || el.offsetWidth;
        // BBOX-FIT-2: измерение ЧЕРЕЗ estimateTextWidth, а не inner.scrollWidth.
        // В реальном Chromium scrollWidth элемента с overflow:visible НЕ
        // включает выходящий за границы контент (подтверждено real-browser
        // эмуляцией) — прежние ужимки коротких фраз были НО-ОПами и текст
        // молча обрезался. estimateTextWidth меряет настоящий глифовый
        // advance скрытым span'ом — тот же механизм, что в Step 1/2.
        const textNeeds = (fs: number): number =>
            this.estimateTextWidth(plainText, fs, fontFamily)
            + this.pxFromEm(SHORT_PHRASE_PADDING_RIGHT_EM, fs) + 2; // +2px safety
        const paddingRightPx = this.pxFromEm(SHORT_PHRASE_PADDING_RIGHT_EM, currentFontSize);
        const requiredWidth = textNeeds(currentFontSize);

        // Step 1: помещается в исходный бокс — не расширяем.
        if (requiredWidth <= originalWidth) {
            if (textNeeds(parseFloat(el.style.fontSize) || currentFontSize) > el.clientWidth + 0.5) {
                let fs = parseFloat(el.style.fontSize) || currentFontSize;
                let iter = 0;
                while (textNeeds(fs) > el.clientWidth + 0.5 && fs > MIN_FONT_SIZE_PX && iter < MAX_SHRINK_ITERATIONS) {
                    fs *= FONT_SHRINK_FACTOR;
                    el.style.fontSize = `${fs}px`;
                    iter++;
                }
            }
            return;
        }

        // Step 2: правый предел — сосед/страница, и не шире 1.3× исходного.
        let maxAllowed: number;
        if (rightCapPx !== undefined && Number.isFinite(rightCapPx)) {
            maxAllowed = rightCapPx;
        } else {
            const pageWidth = this.pageWidthOf(el);
            const currentLeft = parseFloat(el.style.left) || 0;
            maxAllowed = pageWidth - currentLeft - RIGHT_PAGE_MARGIN_PX;
        }
        maxAllowed = Math.min(maxAllowed, originalWidth * SHORT_PHRASE_MAX_EXPANSION);

        const newWidth = Math.min(requiredWidth, maxAllowed);
        if (newWidth > originalWidth) {
            el.style.width = `${newWidth}px`;
            el.style.minWidth = `${newWidth}px`;
        }

        // Step 3: не влезло и после расширения — ужимка шрифта.
        if (textNeeds(parseFloat(el.style.fontSize) || currentFontSize) > el.clientWidth + 0.5) {
            let fs = parseFloat(el.style.fontSize) || currentFontSize;
            let iter = 0;
            while (textNeeds(fs) > el.clientWidth + 0.5 && fs > MIN_FONT_SIZE_PX && iter < MAX_SHRINK_ITERATIONS) {
                fs *= FONT_SHRINK_FACTOR;
                el.style.fontSize = `${fs}px`;
                iter++;
            }
        }

        // Step 4 (BBOX-FIT): упёрлись в пол шрифта при nowrap, а текст всё
        // ещё шире бокса — раньше он просто ОБРЕЗАЛСЬ (overflow hidden).
        // Включаем перенос строк и подгоняем как длинный текст: повторный
        // поиск шрифта под переносный layout → line-height → scroll.
        // Инвариант: перевод всегда доступен целиком, бокс не меняется.
        if (textNeeds(parseFloat(el.style.fontSize) || currentFontSize) > el.clientWidth + 0.5) {
            inner.setCssStyles({ whiteSpace: 'normal', overflow: 'hidden' });
            this.fitLongTextFontSize(el);
            if (this.isLongTextOverflowing(el, inner)) this.shrinkLineHeightTo(inner);
            if (this.isLongTextOverflowing(el, inner)) this.enableScrollFallback(el, false);
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
            el.setCssStyles({ pointerEvents: 'auto', visibility: 'visible' });
        } else {
            el.setCssStyles({ opacity: '0', pointerEvents: 'none', visibility: 'hidden' });
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

    private buildLayoutSettingsForBBoxMode(
        // Phase 2 (C3): 'column' / 'table' / 'split' branches have been
        // removed. Only 'paragraphs' and 'block' remain — both have
        // dedicated branches below; the final fall-back block (previously
        // the default for the removed modes) is now unreachable and has
        // been deleted along with them.
        mode: 'paragraphs' | 'block',
        base: LayoutSettings
    ): LayoutSettings {
        return {...base, layoutPreset: mode === 'block' ? 'single-paragraph' : base.layoutPreset};
    }

    private getSelectedSpanPool(
        pageItems: OverlayPositionData[],
        selectedIndices: number[],
        pageEl: HTMLElement,
        textLayer: HTMLElement
    ): HTMLSpanElement[] {
        // BBOX-FIT-3: сохранённые дроби — textLayer-relative: обратное
        // преобразование должно идти через рамку textLayer (раньше — border-box
        // .page, что при --page-border pdf.js 4.x давало +9px и +2.2% масштаба).
        const tlRect = textLayer.getBoundingClientRect();
        const selectedRects = selectedIndices
            .map(i => pageItems[i]?.relativeRect)
            .filter((r): r is OverlayPositionData['relativeRect'] => !!r)
            .map(r => ({
                left: tlRect.left + r.left * tlRect.width,
                top: tlRect.top + r.top * tlRect.height,
                right: tlRect.left + (r.left + r.width) * tlRect.width,
                bottom: tlRect.top + (r.top + r.height) * tlRect.height,
            }));

        if (!selectedRects.length) return [];

        const allPoolSpans = Array.from(textLayer.querySelectorAll<HTMLSpanElement>('span'));
        // TABLE-KEEP: контекст спан-фильтра — числовые ячейки таблиц выживают
        // (не в колонтитуле и не суперскрипт), номера страниц гибнут как прежде.
        const spanFilterCtx = buildSpanFilterCtx(allPoolSpans, pageEl);
        const spans = allPoolSpans
            .filter(span => this.plugin.processor.isValidSpan(span, spanFilterCtx))
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

        const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
        const textLayer = pageEl?.querySelector<HTMLElement>('.textLayer');
        if (!pageEl || !textLayer) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const selectedSpans = this.getSelectedSpanPool(pageItems, selectedIndices, pageEl, textLayer);
        if (!selectedSpans.length) {
            return this.retranslateSelection(pageItems, selectedIndices, mode);
        }

        const originalSettings = { ...this.plugin.layoutSettings };
        const tuned = this.buildLayoutSettingsForBBoxMode(mode, originalSettings);
        const viewer = pageEl.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const currentScale = parseFloat(viewer?.style.getPropertyValue('--scale-factor') || '1') || 1;

        // P1-9 (Phase 13): pass `tuned` directly to
        // `prepareTranslationUnits` instead of mutating the global
        // `processor.layoutDetector` (via
        // `updateLayoutDetectorSettings(tuned, true)` + `finally { restore
        // originalSettings }`). The previous pattern was racy under rapid
        // double-click retranslates: two concurrent calls would each
        // `try`/`finally` the same global detector and one could end up
        // restoring the other's tuned settings — corrupting
        // `plugin.layoutSettings`-derived state for subsequent page
        // translations. `originalSettings` is a shallow defensive copy of
        // `plugin.layoutSettings` passed as `base` to
        // `buildLayoutSettingsForBBoxMode`; it's no longer used for
        // restore-on-finally.
        const units = await this.plugin.processor.prepareTranslationUnits(selectedSpans, pageEl, /* forceFresh */ true, tuned);
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
            // BBOX-FIT-3: дроби — textLayer-relative (как у save/reload);
            // делим на размеры textLayer, а не border-box .page.
            const tlRectB = textLayer.getBoundingClientRect();
            const blockRect = {
                left: bbox.rect.left / tlRectB.width,
                top: bbox.rect.top / tlRectB.height,
                width: bbox.rect.width / tlRectB.width,
                height: bbox.rect.height / tlRectB.height,
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
        // BBOX-FIT-3: дроби — textLayer-relative (см. block-режим выше).
        const tlRectP = textLayer.getBoundingClientRect();
        const replacementItems: OverlayPositionData[] = [];

        for (let i = 0; i < units.length; i++) {
            const unit = units[i];
            const bbox = this.plugin.processor.getSpansBbox(unit.originalSpans, pageEl);
            if (!bbox.rect) continue;

            const relativeRect = {
                left: bbox.rect.left / tlRectP.width,
                top: bbox.rect.top / tlRectP.height,
                width: bbox.rect.width / tlRectP.width,
                height: bbox.rect.height / tlRectP.height,
            };
            if (!isFinite(relativeRect.left) || !isFinite(relativeRect.top) || !isFinite(relativeRect.width) || !isFinite(relativeRect.height)) {
                continue;
            }

            replacementItems.push({
                selector: '',
                textContent: unit.text,
                translationStatus: fallbackIndices(translated).has(i) ? 'fallback' : undefined,
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
        const activeFile = activeLeaf?.view instanceof FileView ? activeLeaf.view.file : null;
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
        const activeFile = activeLeaf?.view instanceof FileView ? activeLeaf.view.file : null;
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

            addItem('Layout выделенной области…', 'columns', () => {
                if (!activeFile || pageNumber == null) return;
                const selected=this.getSelectionForAction(targetOverlay);
                const pageEl=targetOverlay.closest('.page');
                const frame=pageEl?.querySelector('.textLayer')?.getBoundingClientRect();
                if(!frame || !selected.length) return;
                const boxes=selected.map(el=>el.getBoundingClientRect());
                const left=Math.max(0,(Math.min(...boxes.map(b=>b.left))-frame.left)/frame.width);
                const top=Math.max(0,(Math.min(...boxes.map(b=>b.top))-frame.top)/frame.height);
                const right=Math.min(1,(Math.max(...boxes.map(b=>b.right))-frame.left)/frame.width);
                const bottom=Math.min(1,(Math.max(...boxes.map(b=>b.bottom))-frame.top)/frame.height);
                const rotation=pageEl?.querySelector('.textLayer')?.getAttribute('data-main-rotation');
                new RegionLayoutEditor(this.plugin,activeFile,pageNumber,{left,top,width:right-left,height:bottom-top},rotation==null?undefined:Number(rotation)).open();
            });
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
        // TABLE-KEEP: <br> в textContent исчезает БЕЗ следа ("a<br>b" → "ab",
        // одно слово!) — ломает wordCount для isShortPhrase. Замена ПОСЛЕ
        // чтения textContent была мёртвой (тег к тому моменту уже стал
        // DOM-элементом и выпал из текста). Заменяем на пробел ДО
        // sanitize/innerHTML, чтобы построчный текст считался словами корректно.
        // eslint-disable-next-line no-unsanitized/property -- DOMPurify-sanitized with a strict whitelist (PURIFY_CONFIG); this detached tempDiv is only used to strip tags and read back plain text
        this.tempDiv.innerHTML = DOMPurify.sanitize((html || '').replace(/<br\s*\/?>/gi, ' '), PURIFY_CONFIG);
        return this.tempDiv.textContent || this.tempDiv.innerText || '';
    }
}
