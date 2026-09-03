// overlay.ts
// Main Overlay Management and Coordination Logic

import { Menu, Notice, TFile } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { OverlayPositionData, TranslationUnit, SavedOverlay } from './types';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
// P1-19 (Variant 4): also surface the multi-page translate command in the
// right-click menu — discoverability for the most common bulk action.
import { TranslateMultiplePagesModal } from './modal';
import { OverlayUIRenderer } from './overlay-ui'; // Import the new UI renderer
// Phase 7 (V4 Schema): stable per-overlay identifier. Stamped at every
// OverlayPositionData construction site so that downstream save/merge/edit
// paths can locate the exact entry by id instead of fuzzy-matching on
// textContent (which is ambiguous when a page contains duplicate paragraphs).
import { generateOverlayId, getCurrentEngine } from './overlay-id';
// Phase 16 (C17): i18n shim — replaces hardcoded English menu strings with
// localizable keys. Falls back to the key itself when no translation is
// registered, so the plugin stays functional in English even without a
// translation file.
import { t } from './i18n';

// Constants
const OVERLAY_WAIT_TIMEOUT = 5000;
const OVERLAY_CHECK_INTERVAL = 100;
const RETRY_DELAY = 50;
const MAX_DIMENSION_RETRIES = 50;
const EXTRACT_RETRY_INTERVAL = 100;
const EXTRACT_MAX_RETRIES = 20;
const OVERLAY_RELOAD_DELAY = 100;
const ZOOM_CHANGE_DELAY = 150;
const DEBOUNCE_DELAY = 50;
const CACHE_TTL = 100; // ms for memoization
// Stage 3.1 (Q14): unified visible-page margin. Previously 4 different
// values were used across IO callback (400px), quickVisibilityCheck (0px),
// comprehensiveOverlayCheck (200px), and forceRefreshVisibleOverlays (0px).
// Now all use this single constant via pdfDom.getVisiblePages().
const VISIBLE_PAGE_MARGIN_PX = 200;
// const LINE_HEIGHT_MIN = 0.8; // Moved to overlay-ui.ts
// const LINE_HEIGHT_MAX = 2.0; // Moved to overlay-ui.ts
// const LINE_HEIGHT_STEP = 0.1; // Moved to overlay-ui.ts
const ZOOM_REPOSITION_DEBOUNCE = 200; // ms to debounce continuous zoom
const ZOOM_DIM_STABLE_WAIT = 300; // ms to wait for PDF.js to settle zoom
const SCROLL_THROTTLE_DELAY = 150; // ms to throttle scroll checks
const SCROLL_SETTLE_DELAY = 200; // ms to wait after scrolling stops
const QUICK_CHECK_MIN_INTERVAL = 100; // ms minimum between quick checks

/**
 * Manages the rendering, interaction, and data extraction of translation overlays on PDF pages.
 * It is the expert on all things related to the PDF viewer's DOM.
 * Delegates UI rendering and styling to OverlayUIRenderer.
 */
export class OverlayRenderer {
    private plugin: OpenRouterTranslatorPlugin;
    private uiRenderer: OverlayUIRenderer; // New instance for UI logic

    // P1-20: `isOverlayVisible` was previously `private`. The
    // `OverlayUIRenderer.createReflowOverlay` needs to read it so newly-
    // created overlays start in the right state (visible or hidden) instead
    // of always being created visible. Exposed via a public getter below;
    // the backing field stays private so only `toggleOverlayVisibility`
    // and the constructor can mutate it.
    private _isOverlayVisible: boolean;
    /** P1-20: public read accessor for OverlayUIRenderer and menu rendering. */
    public get isOverlayVisible(): boolean { return this._isOverlayVisible; }
    private pageObserver: MutationObserver | null = null;
    private zoomObserver: MutationObserver | null = null;
    private lastKnownScale: number = 1.0;
    // Note: createdOverlays and trackedOverlayElements are now managed by uiRenderer
    private isReloadingOverlay = false;
    /**
     * P2-59 / P2-60 (Phase 14): public read-only accessor so
     * `overlay-ui.ts:showContextMenu` can warn the user when a rerender is
     * in flight (prevents context-menu actions from racing with the
     * zoom-triggered re-render). Also used by the sentinel check inside
     * `loadSavedOverlayForPage` to queue loads behind an in-progress rerender.
     */
    public get isReloadingOverlayFlag(): boolean {
        return this.isReloadingOverlay;
    }
    /**
     * P2-59 (Phase 14): sentinel key used in `inFlightPageLoads` to mark
     * that a `rerenderVisibleOverlays` pass is in flight. Negative value
     * avoids collision with real (1-indexed) page numbers.
     */
    private static readonly RERENDER_SENTINEL = -1;
    private activeLeavesCache: Set<any> | null = null;
    private memoCache: Map<string, { value: any, timestamp: number }> = new Map();
    // Note: tempDiv is now managed by uiRenderer
    private zoomDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
    private inFlightPageLoads: Map<number, Promise<void>> = new Map();
    // Gradual loading properties
    //
    // Phase 4 (P1-33): `cachedOverlayData` is now PRIVATE. External callers
    // must use the public accessor methods below:
    //   - `getCachedOverlayForRecovery(pdfPath)` — read-only access for
    //     storage.ts's parse-failure recovery path (formerly direct field
    //     access at storage.ts:694).
    //   - `invalidateCache()` — full reset of cache + tracking sets.
    //     Replaces the old `overlay.cachedOverlayData = null` mutation at
    //     overlay-ui.ts:1315.
    //   - `invalidatePage(pageNumber)` — clear a single page entry + its
    //     `loadedOverlayPages` tracking bit so the next access force-reloads.
    //     Replaces `storage.invalidateDomCache(path, pageNumber)` (P1-34).
    //   - `mergePage(pageNumber, data)` — write a single page entry directly
    //     into the cache (kept for completeness; no live external callers —
    //     all writes go through `storage.updatePageOverlaysAndWrite` which
    //     calls `updateCacheFromWrite` internally).
    //   - `reloadPage(pageNumber)` — convenience wrapper that delegates to
    //     `loadSavedOverlayForPage(pageNumber, true)`.
    private _cachedOverlayData: SavedOverlay | null = null;
    private pagesWithOverlays: Set<number> = new Set();
    private pageIntersectionObserver: IntersectionObserver | null = null;
    // Enhanced scroll safeguard properties
    private scrollThrottleTimeout: ReturnType<typeof setTimeout> | null = null;
    private visibilityDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
    private scrollHandler: (() => void) | null = null;
    private scrollableContainer: HTMLElement | null = null;
    private loadedOverlayPages: Set<number> = new Set();
    private lastScrollCheck: number = 0;
    private isScrollSafeguardRunning: boolean = false;
    private lastQuickCheck: number = 0;

    // P2-66 (Phase 15): re-render overlays on window resize. When the user
    // resizes the Obsidian window (or the PDF pane within a split), the
    // PDF.js viewer scales pages to fit and the `.textLayer` rectangles
    // shift. Previously the overlay DOM was left in place with stale
    // absolute coordinates — overlays would be misaligned with the
    // underlying text until the user manually scrolled or zoomed. The
    // debounced `rerenderVisibleOverlays` call rebuilds overlays at the
    // new scale after the resize gesture settles.
    //
    // `window.addEventListener('resize', ...)` is used (rather than
    // `workspace.on('resize', ...)`) because the workspace event only
    // fires on layout-toggle actions (open/close pane), NOT on continuous
    // window drags — the window-level listener is what catches a user
    // dragging the OS window border. The debounce coalesces the rapid
    // stream of resize events that fire during a drag.
    private resizeDebounce: ReturnType<typeof setTimeout> | null = null;
    private static readonly RESIZE_DEBOUNCE_MS = 300;
    private onWindowResize = (): void => {
        if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
        this.resizeDebounce = setTimeout(() => {
            this.resizeDebounce = null;
            // P2-66: only re-render if a PDF leaf is actually active —
            // otherwise the rerender path will early-return anyway (no
            // active leaf) but we'd still pay the cost of entering the
            // async function and grabbing the leaf. Skipping at the
            // listener level is cheaper.
            if (!this.getActivePDFLeaf()) return;
            void this.rerenderVisibleOverlays();
        }, OverlayRenderer.RESIZE_DEBOUNCE_MS);
    };

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.uiRenderer = new OverlayUIRenderer(plugin); // Initialize the UI renderer
        this._isOverlayVisible = plugin.settings.showOverlayByDefault ?? true;
        // Ensure line height is a number (default 1.2)
        if (typeof this.plugin.settings.outputLineHeight !== 'number') {
            this.plugin.settings.outputLineHeight = 1.2;
        }
        // P1-17 (Phase 14): if BBox edit mode was already enabled at plugin
        // load (e.g. user had it on, then reloaded Obsidian), attach the
        // marquee listeners now — they're no longer auto-attached in the
        // OverlayUIRenderer constructor.
        if (plugin.settings.bboxEditMode) {
            this.uiRenderer.attachMarqueeListeners();
        }
        // P2-66 (Phase 15): register the window-resize listener once at
        // construction. The listener is removed in `cleanupMonitoring()`
        // (which the renderer's `cleanup()` delegates to). The bound
        // `onWindowResize` arrow function preserves `this` across the
        // add/removeEventListener pair without needing a separate
        // `.bind(this)` allocation.
        window.addEventListener('resize', this.onWindowResize);
    }

    /**
     * P1-17 (Phase 14): delegate to uiRenderer.attachMarqueeListeners().
     * Called from `main.ts` when the user toggles BBox edit mode ON.
     */
    public attachMarqueeListeners(): void {
        this.uiRenderer.attachMarqueeListeners();
    }

    /**
     * P1-17 (Phase 14): delegate to uiRenderer.detachMarqueeListeners().
     * Called from `main.ts` when the user toggles BBox edit mode OFF.
     */
    public detachMarqueeListeners(): void {
        this.uiRenderer.detachMarqueeListeners();
    }

    // ============================================================
    // Public API for TextProcessor
    // ============================================================

    public preparePageForOverlay(pageElement: HTMLElement): HTMLElement {
        if (!pageElement) {
            this.logDebug('preparePageForOverlay: Page element is null');
            throw new Error('Page element is required');
        }
        this.clearOverlayFromPage(pageElement);
        return this.createOverlayContainer(pageElement);
    }

    public renderOverlays(
        units: TranslationUnit[],
        translatedLines: string[],
        container: HTMLElement,
        pageElement: HTMLElement
    ) {
        if (!units?.length || !translatedLines?.length) {
            this.logDebug('renderOverlays: No units or translated lines provided');
            return;
        }
        const textMemo = new Map<string, string>(); // Per-render memo for plain text
        try {
            const pageNumber = parseInt(pageElement.dataset.pageNumber || '0');
            // P1-18 (Phase 15): collect appended overlays so we can fit them
            // to their bbox in a single RAF after the append loop. The
            // previous code relied on `createReflowOverlay` calling
            // `adjustOverlayForOverflow` internally — but at that point the
            // element was still detached, so scrollHeight/clientHeight
            // returned 0 and the fit step was a no-op (P2-64 removes that
            // dead call). Running the fit in a RAF after `appendChild`
            // guarantees the element is attached and has a real layout box
            // when the measurement runs. Batching in one RAF (rather than
            // scheduling one RAF per overlay) avoids N layout-thrashing
            // style reads in a tight loop.
            const appended: { el: HTMLElement; lh: number }[] = [];
            units.forEach((unit, i) => {
                try {
                    const translatedText = translatedLines[i] || unit.text;
                    if (!translatedText.trim()) return;
                    const { rect, fontSizes, fontFamily } = this.plugin.processor.getSpansBbox(unit.originalSpans, pageElement);
                    if (!rect) return;
                    const originalPlainText = textMemo.get(unit.text) || this.uiRenderer.extractPlainTextFromHtml(unit.text); // Use helper from uiRenderer
                    textMemo.set(unit.text, originalPlainText);
                    // Pass necessary settings to uiRenderer
                    const overlayEl = this.uiRenderer.createReflowOverlay(
                        rect, translatedText, unit.originalSpans[0], fontSizes, pageNumber, originalPlainText,
                        this.plugin.settings.overlayOpacity, this.plugin.settings.outputFontSizeScale,
                        this.plugin.settings.outputLineHeight, this.lastKnownScale, fontFamily
                    );
                    overlayEl.setAttribute('data-overlay-index', String(i));
                    overlayEl.setAttribute('data-overlay-page', String(pageNumber));
                    container.appendChild(overlayEl);
                    appended.push({ el: overlayEl, lh: this.plugin.settings.outputLineHeight });
                } catch (unitError) {
                    this.logDebug(`Error rendering unit ${i}:`, unitError);
                }
            });
            // P1-18 (Phase 15): fit overlays to bbox after append (when layout is available)
            if (appended.length > 0) {
                requestAnimationFrame(() => {
                    for (const { el, lh } of appended) {
                        if (el.isConnected) this.uiRenderer.adjustOverlayForOverflow(el, lh);
                    }
                });
            }
            // Mark page as loaded
            this.loadedOverlayPages.add(pageNumber);
            this.logDebug(`Rendered ${units.length} overlay(s) for page ${pageNumber}`);
        } catch (error) {
            this.logDebug('renderOverlays failed:', error);
        }
    }

    public async refreshCurrentOverlay() {
        try {
            if (!this.getCurrentPageElement()) {
                new Notice('No active PDF page found to refresh.');
                return;
            }
            new Notice('Refreshing overlay...');
            await this.plugin.processor.addTextOverlay();
        } catch (error) {
            this.logDebug('Error refreshing overlay:', error);
            new Notice('Failed to refresh overlay');
        }
    }

    public clearCurrentOverlay(): void {
        const pageElement = this.getCurrentPageElement();
        if (!pageElement) {
            new Notice('No active PDF page found.');
            return;
        }
        this.clearOverlayFromPage(pageElement);
        new Notice('Current page overlay cleared.');
    }

    public addOverlayToggleToPDFMenu(menu: Menu, file: TFile): void {
        // P1-19 (Variant 4): restructured the right-click menu for clarity.
        //   1. Translate multiple pages...     (new — was palette-only)
        //   2. Show / Hide translation overlay  (toggle visibility)
        //   3. Reload overlays for visible pages (was "current page" — text
        //      updated to reflect the P1-20 fix that toggles across the whole
        //      viewport, not just the active page)
        //   4. Retranslate using saved overlay layout...
        //      (kept — P0-7 fixed the hanging confirm dialog that previously
        //      made this item a dead-end if the user pressed Esc)
        menu.addItem((item) =>
            item
                .setTitle(t('overlay.menu.translateMultiple'))
                .setIcon('languages')
                .onClick(() => new TranslateMultiplePagesModal(this.plugin, file).open())
        );

        menu.addItem((item) =>
            item
                .setTitle(this.isOverlayVisible ? t('overlay.menu.hideOverlay') : t('overlay.menu.showOverlay'))
                .setIcon(this.isOverlayVisible ? 'eye-off' : 'eye')
                // P1-20: toggle is async — fire-and-forget.
                .onClick(() => { void this.toggleOverlayVisibility(); })
        );

        menu.addItem((item) =>
            item
                .setTitle(t('overlay.menu.reloadOverlays'))
                .setIcon('refresh-cw')
                .onClick(() => void this.forceRefreshVisibleOverlays())
        );

        menu.addItem((item) =>
            item
                .setTitle(t('overlay.menu.retranslateUsingLayout'))
                .setIcon('wand')
                .onClick(() => new RetranslateUsingOverlaysModal(this.plugin.app, this.plugin, file).open())
        );
    }

    // Phase 2 (dead-code removal): the `adjustLineHeight` method that lived
    // here had zero callers — the global line-height control flow now goes
    // through `uiRenderer.applyLineHeight` invoked from the context-menu
    // handlers (adjustSingleOverlayLineHeight) and from createReflowOverlay.
    // Removing it eliminates a confusing "global adjust" path that was
    // never reachable from the UI.

    /**
     * Force refresh all visible overlays - useful for troubleshooting
     */
    public async forceRefreshVisibleOverlays(): Promise<void> {
        try {
            const activeLeaf = this.getActivePDFLeaf();
            if (!activeLeaf) {
                new Notice('No active PDF found');
                return;
            }
            // Stage 3.1 (Q14): use pdfDom.getVisiblePages() with the unified
            // margin constant instead of inline rect checks with 0px margin.
            const pages = this.plugin.pdfDom.getVisiblePages(activeLeaf, VISIBLE_PAGE_MARGIN_PX);
            if (!pages || pages.length === 0) return;

            this.logDebug('Starting force refresh of visible overlays');
            let refreshCount = 0;
            for (const pageElement of pages) {
                const pageNumberStr = pageElement.dataset.pageNumber;
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    if (this.pagesWithOverlays.has(pageNumber)) {
                        this.clearOverlayFromPage(pageElement);
                        this.loadedOverlayPages.delete(pageNumber);
                        // Phase 11 (C7): forward the captured leaf so the
                        // load does not re-query and risk landing on a
                        // different leaf if the user switches files mid-loop.
                        await this.loadSavedOverlayForPage(pageNumber, true, activeLeaf);
                        refreshCount++;
                    }
                }
            }
            new Notice(`Refreshed ${refreshCount} overlay(s)`);
            this.logDebug(`Force refreshed ${refreshCount} overlays`);
        } catch (error) {
            this.logDebug('forceRefreshVisibleOverlays error:', error);
            new Notice('Error refreshing overlays');
        }
    }

    // Note: applyLineHeight is now handled by uiRenderer and is private there

    // ============================================================
    // Internal DOM Management & Utilities
    // ============================================================

    private createOverlayContainer(pageElement: HTMLElement): HTMLElement {
        const container = document.createElement('div');
        container.className = 'pdf-text-overlay-container';
        // FIX: removed `overflow: hidden` — it was clipping PDF.js rendering
        // of images/canvas underneath on some PDFs. Also removed `z-index: 100`
        // — overlay container should NOT be above PDF.js canvas/image layers.
        // Individual overlay elements have their own z-index (101) which is
        // sufficient to appear above text. The container itself is transparent
        // and non-interactive (pointer-events: none).
        container.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;`;
        pageElement.appendChild(container);
        return container;
    }

    /**
     * P1-13 (Phase 14): public so external callers (e.g.
     * `modal-retranslate.ts:refreshPageOverlayFromSaved`) can clear a single
     * page's overlays with proper listener cleanup via
     * `uiRenderer.cleanupOverlayElement`. Previously those callers did
     * `pageEl.querySelectorAll('.pdf-text-overlay-container').forEach(el => el.remove())`
     * which left per-overlay event listeners (contextmenu / click / mouseover /
     * mouseleave) and interact handles leaked on the detached DOM tree.
     */
    public clearOverlayFromPage(pageElement: HTMLElement): void {
        const existingContainer = pageElement.querySelector('.pdf-text-overlay-container');
        if (existingContainer) {
            existingContainer.querySelectorAll('.pdf-text-overlay-reflow').forEach(overlay => {
                this.uiRenderer.cleanupOverlayElement(overlay as HTMLElement); // Delegate cleanup to uiRenderer
            });
            existingContainer.remove();
        }
        // Clear from loaded pages tracking
        const pageNumberStr = pageElement.dataset.pageNumber;
        if (pageNumberStr) {
            const pageNumber = parseInt(pageNumberStr, 10);
            this.loadedOverlayPages.delete(pageNumber);
        }
    }

    // Note: extractPlainTextFromHtml is now handled by uiRenderer and is private there
    // If needed locally, it can be kept here or delegated via uiRenderer.

    // ============================================================
    // Setup & Monitoring (ENHANCED with better performance)
    // ============================================================

    public async setupPDFMonitoring(leaf: any) {
        if (!leaf?.view?.file || leaf.view.getViewType() !== 'pdf') {
            this.logDebug('setupPDFMonitoring: Invalid leaf or not a PDF view.');
            return;
        }

        // Cleanup previous observers
        this.cleanupMonitoring();

        // Load translation data and identify pages that need overlays
        await this.initializeOverlayStateForPdf(leaf.view.file);

        // If there are no pages with saved overlays, we don't need to monitor anything.
        if (this.pagesWithOverlays.size === 0) {
            this.logDebug('No saved overlays found for this PDF. No monitoring will be started.');
            return;
        }

        let attempts = 0;
        const maxAttempts = 50; // 5s total
        const checkViewer = () => {
            attempts++;
            const viewerContainer = leaf.view.containerEl.querySelector('.pdfViewer, #viewer');
            if (viewerContainer) {
                this.logDebug(`PDF viewer found. Monitoring for ${this.pagesWithOverlays.size} pages with saved translations.`);
                // Determine scroll container first so IO uses the correct root
                this.monitorScrolling(viewerContainer as HTMLElement);
                // Now IO uses scrollableContainer as root
                this.setupIntersectionObserver();
                this.monitorPageContainer(viewerContainer as HTMLElement);
                this.monitorZoom(viewerContainer as HTMLElement);
            } else if (attempts < maxAttempts) {
                setTimeout(checkViewer, 100);
            } else {
                this.logDebug('PDF viewer not found after maximum attempts');
            }
        };
        checkViewer();
    }

    private async initializeOverlayStateForPdf(pdfFile: TFile) {
        // Reset state for the new file
        this._cachedOverlayData = null;
        this.pagesWithOverlays.clear();
        this.loadedOverlayPages.clear();

        const translationFile = await this.plugin.storage.findTranslationFileForPdf(pdfFile);
        if (!translationFile) {
            return; // No translation file exists.
        }

        try {
            const content = await this.plugin.app.vault.read(translationFile);
            const parsedOverlay = this.plugin.storage.parseMarkdownOverlay(content, pdfFile);
            if (parsedOverlay && parsedOverlay.pageOverlays) {
                this._cachedOverlayData = parsedOverlay;
                const pageNumbers = Object.keys(parsedOverlay.pageOverlays).map(Number).filter(n => !isNaN(n) && n > 0);
                this.pagesWithOverlays = new Set(pageNumbers);
                this.logDebug(`Initialized overlay data for ${pageNumbers.length} pages: ${pageNumbers.join(', ')}`);
            }
        } catch (error) {
            console.error('PDF Translator: Failed to read or parse translation file.', error);
        }
    }

    /**
     * FIX B5: Re-initialize overlay state for the currently-active PDF.
     *
     * `setupPDFMonitoring` only calls `initializeOverlayStateForPdf` once when
     * the PDF leaf becomes active. If the translation file is created LATER
     * (e.g. user opens the PDF, then runs a background translation from
     * another tab/command), the renderer's cache stays empty and no overlays
     * ever appear — until the user manually switches files back and forth.
     *
     * This method is now called from `updateCacheFromWrite` (when the writer
     * has fresh data) and can also be called manually (e.g. from a "refresh"
     * command). It's safe to call multiple times — it re-reads the file from
     * disk and rebuilds pagesWithOverlays from scratch.
     */
    public async refreshOverlayStateForCurrentPdf(): Promise<void> {
        const activeFile = this.getActivePDFLeaf()?.view?.file;
        if (!activeFile || activeFile.extension !== 'pdf') return;
        await this.initializeOverlayStateForPdf(activeFile);

        // After re-init, force-reload any visible pages so the user sees
        // the new overlays immediately.
        // Stage 3.1 (Q14): use pdfDom.getVisiblePages() with unified margin.
        const leaf = this.getActivePDFLeaf();
        const pages = this.plugin.pdfDom.getVisiblePages(leaf, VISIBLE_PAGE_MARGIN_PX);
        if (!pages || pages.length === 0) return;

        for (const pageElement of pages) {
            const pageNumberStr = pageElement.dataset.pageNumber;
            if (!pageNumberStr) continue;
            const pageNumber = parseInt(pageNumberStr, 10);
            if (this.pagesWithOverlays.has(pageNumber)) {
                this.clearOverlayFromPage(pageElement);
                this.loadedOverlayPages.delete(pageNumber);
                // Phase 11 (C7): forward the captured leaf.
                await this.loadSavedOverlayForPage(pageNumber, true, leaf);
            }
        }
    }

    private setupIntersectionObserver() {
        this.pageIntersectionObserver?.disconnect();
        // Better root detection
        let root: Element | null = null;
        if (this.scrollableContainer) {
            root = this.scrollableContainer;
        }
        const options: IntersectionObserverInit = {
            root: root,
            // Stage 3.1 (Q14): unified margin. Was '400px', then changed to
            // 200px which caused regression — overlays not loading on scroll
            // stop because pages fell outside the 200px detection zone.
            // Restored to 400px (larger than VISIBLE_PAGE_MARGIN_PX) so IO
            // pre-loads pages BEFORE they enter the visible zone. The scroll
            // handlers (quickVisibilityCheck, comprehensiveOverlayCheck) use
            // the tighter 200px margin for their own checks — IO is the
            // "early warning" system with a wider net.
            rootMargin: '400px',
            threshold: [0, 0.1, 0.3] // Multiple thresholds for better detection
        };

        this.pageIntersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && entry.intersectionRatio > 0) {
                    const pageElement = entry.target as HTMLElement;
                    const pageNumberStr = pageElement.dataset.pageNumber;
                    if (pageNumberStr) {
                        const pageNumber = parseInt(pageNumberStr, 10);
                        if (this.pagesWithOverlays.has(pageNumber)) {
                            // Use the optimized loader
                            this.ensurePageOverlayLoaded(pageNumber, pageElement).catch(err =>
                                this.logDebug(`IO load error page ${pageNumber}`, err)
                            );
                        }
                    }
                }
            }
        }, options);

        // Observe existing pages immediately
        this.observeExistingPages();
    }

    private observeExistingPages() {
        const activeLeaf = this.getActivePDFLeaf();
        if (!activeLeaf) return;
        const pages = this.getPDFPagesForLeaf(activeLeaf);
        if (!pages) return;

        let observedCount = 0;
        pages.forEach(page => {
            const pageNumberStr = page.dataset.pageNumber;
            if (pageNumberStr) {
                const pageNumber = parseInt(pageNumberStr, 10);
                if (this.pagesWithOverlays.has(pageNumber)) {
                    this.pageIntersectionObserver?.observe(page);
                    observedCount++;
                }
            }
        });
        this.logDebug(`Started observing ${observedCount} pages with overlays`);
    }

    private monitorPageContainer(pdfViewer: HTMLElement) {
        this.pageObserver?.disconnect();
        const handleMutations = (mutations: MutationRecord[]) => {
            let newPagesAdded = 0;
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    // Check for newly added pages
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof HTMLElement && node.classList.contains('page')) {
                            const pageNumberStr = node.dataset.pageNumber;
                            if (pageNumberStr) {
                                const pageNumber = parseInt(pageNumberStr, 10);
                                // If this page is supposed to have an overlay, start watching it for visibility.
                                if (this.pagesWithOverlays.has(pageNumber)) {
                                    this.pageIntersectionObserver?.observe(node);
                                    newPagesAdded++;
                                }
                            }
                        }
                    });
                    // Clean up observer for removed pages
                    mutation.removedNodes.forEach(node => {
                        if (node instanceof HTMLElement && node.classList.contains('page')) {
                            this.pageIntersectionObserver?.unobserve(node);
                            // Clear from loaded tracking
                            const pageNumberStr = node.dataset.pageNumber;
                            if (pageNumberStr) {
                                const pageNumber = parseInt(pageNumberStr, 10);
                                this.loadedOverlayPages.delete(pageNumber);
                            }
                        }
                    });
                }
            }
            if (newPagesAdded > 0) {
                this.logDebug(`Started observing ${newPagesAdded} new pages`);
            }
        };

        this.pageObserver = new MutationObserver(handleMutations);
        this.pageObserver.observe(pdfViewer, { childList: true, subtree: true });
    }

    private monitorZoom(pdfViewer: HTMLElement) {
        this.zoomObserver?.disconnect();
        const handleZoomChange = () => {
            const scaleFactorStr = pdfViewer.style.getPropertyValue('--scale-factor');
            if (!scaleFactorStr) return;
            const newScale = parseFloat(scaleFactorStr);
            if (!isNaN(newScale) && Math.abs(newScale - this.lastKnownScale) > 0.001) {
                this.logDebug(`Zoom changed from ${this.lastKnownScale} to ${newScale}. Triggering overlay update.`);
                this.lastKnownScale = newScale;
                if (this.zoomDebounceTimeout) {
                    clearTimeout(this.zoomDebounceTimeout);
                }
                this.zoomDebounceTimeout = setTimeout(() => {
                    this.rerenderVisibleOverlays();
                }, ZOOM_REPOSITION_DEBOUNCE);
                this.memoCache.clear();
            }
        };

        this.zoomObserver = new MutationObserver(handleZoomChange);
        this.zoomObserver.observe(pdfViewer, { attributes: true, attributeFilter: ['style'] });

        const initialScaleStr = pdfViewer.style.getPropertyValue('--scale-factor');
        if (initialScaleStr) this.lastKnownScale = parseFloat(initialScaleStr) || 1.0;
    }

    private monitorScrolling(pdfViewer: HTMLElement) {
        if (this.scrollableContainer && this.scrollHandler) {
            this.scrollableContainer.removeEventListener('scroll', this.scrollHandler);
        }
        // Better container detection with fallbacks
        this.scrollableContainer = pdfViewer.closest('.mod-vertical') ||
                                  pdfViewer.closest('.workspace-leaf-content') ||
                                  pdfViewer.parentElement ||
                                  pdfViewer;
        this.logDebug(`Scroll container detected: ${this.scrollableContainer.className || 'no class'}`);

        // Enhanced scroll handler with two-tier checking
        this.scrollHandler = () => {
            const now = Date.now();
            // Immediate lightweight check for critical visibility
            if (now - this.lastQuickCheck > QUICK_CHECK_MIN_INTERVAL) {
                this.lastQuickCheck = now;
                this.quickVisibilityCheck();
            }
            // Throttled comprehensive check
            if (this.scrollThrottleTimeout) {
                clearTimeout(this.scrollThrottleTimeout);
            }
            this.scrollThrottleTimeout = setTimeout(() => {
                // REGRESSION FIX: use current time (not `now` from scroll
                // event) so the comprehensive check always runs after scroll
                // settles. Previously `now` was captured at scroll event time,
                // and if the user scrolled for >100ms, `now - lastScrollCheck`
                // could be < QUICK_CHECK_MIN_INTERVAL, causing the comprehensive
                // check to be skipped. The user had to click the mouse to
                // trigger a re-layout that forced the check to run.
                const checkNow = Date.now();
                if (checkNow - this.lastScrollCheck > QUICK_CHECK_MIN_INTERVAL) {
                    this.lastScrollCheck = checkNow;
                    this.comprehensiveOverlayCheck();
                } else {
                    // Schedule a follow-up check after the minimum interval
                    // to ensure overlays load even if the user stops scrolling
                    // during the throttle window.
                    setTimeout(() => {
                        this.lastScrollCheck = Date.now();
                        this.comprehensiveOverlayCheck();
                    }, QUICK_CHECK_MIN_INTERVAL + 50);
                }
            }, SCROLL_THROTTLE_DELAY);
        };

        this.scrollableContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    // Light check that runs immediately on scroll
    private quickVisibilityCheck() {
        if (this.isScrollSafeguardRunning) return;
        try {
            const activeLeaf = this.getActivePDFLeaf();
            if (!activeLeaf) return;
            // Stage 3.1 (Q14): use pdfDom.getVisiblePages() with unified
            // margin instead of inline rect checks with 0px margin.
            const pages = this.plugin.pdfDom.getVisiblePages(activeLeaf, VISIBLE_PAGE_MARGIN_PX);
            if (!pages || pages.length === 0) return;

            const viewportHeight = window.innerHeight;
            const viewportCenter = viewportHeight / 2;

            // Find the most central visible page
            let centralPage: HTMLElement | null = null;
            let minDistanceToCenter = Infinity;
            for (const pageElement of pages) {
                const rect = pageElement.getBoundingClientRect();
                const pageCenter = rect.top + rect.height / 2;
                const distanceToCenter = Math.abs(pageCenter - viewportCenter);
                if (distanceToCenter < minDistanceToCenter) {
                    minDistanceToCenter = distanceToCenter;
                    centralPage = pageElement;
                }
            }

            // Ensure the central page has its overlay if it should
            if (centralPage) {
                const pageNumberStr = centralPage.dataset.pageNumber;
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    this.ensurePageOverlayLoaded(pageNumber, centralPage).catch(err =>
                        this.logDebug(`Quick check load error page ${pageNumber}`, err)
                    );
                }
            }
        } catch (error) {
            this.logDebug("quickVisibilityCheck error", error);
        }
    }

    // Comprehensive check that runs after scroll settles
    private async comprehensiveOverlayCheck() {
        if (this.isScrollSafeguardRunning) return;
        this.isScrollSafeguardRunning = true;
        try {
            const activeLeaf = this.getActivePDFLeaf();
            if (!activeLeaf) return;
            // Stage 3.1 (Q14): use pdfDom.getVisiblePages() with unified
            // margin instead of inline rect checks with hardcoded 200px.
            const pages = this.plugin.pdfDom.getVisiblePages(activeLeaf, VISIBLE_PAGE_MARGIN_PX);
            if (!pages || pages.length === 0) return;

            const visiblePages: { element: HTMLElement, pageNumber: number }[] = [];
            for (const pageElement of pages) {
                const pageNumberStr = pageElement.dataset.pageNumber;
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    if (this.pagesWithOverlays.has(pageNumber)) {
                        visiblePages.push({ element: pageElement, pageNumber });
                    }
                }
            }

            // Load overlays for visible pages in parallel with limited concurrency
            const batchSize = 3; // Limit concurrent loads
            for (let i = 0; i < visiblePages.length; i += batchSize) {
                const batch = visiblePages.slice(i, i + batchSize);
                const loadPromises = batch.map(({ element, pageNumber }) =>
                    this.ensurePageOverlayLoaded(pageNumber, element)
                );
                await Promise.allSettled(loadPromises);
            }
            this.logDebug(`Comprehensive check completed for ${visiblePages.length} visible pages`);
        } catch (error) {
            this.logDebug("comprehensiveOverlayCheck error", error);
        } finally {
            this.isScrollSafeguardRunning = false;
        }
    }

    // Improved single page overlay loading with better state tracking
    private async ensurePageOverlayLoaded(pageNumber: number, pageElement: HTMLElement): Promise<void> {
        // P1-20 (revised per user feedback): when the user has toggled
        // overlays OFF, we must NOT load/create overlays for any page that
        // scrolls into view. The previous implementation still called
        // `loadSavedOverlayForPage` (which creates DOM nodes via
        // `createReflowOverlay`) and merely set their CSS visibility to
        // hidden — that meant overlays were still being built, measured,
        // and attached to the DOM on every scroll, just invisible. The
        // user's intent with "Hide overlay" is a temporary global disable:
        // no overlays should appear for ANY page entering the viewport
        // until they toggle back to "Show". Early-return here is the
        // single chokepoint that enforces this — IntersectionObserver,
        // `quickVisibilityCheck`, `comprehensiveOverlayCheck`, and the
        // `markPageAsHavingOverlays` path all funnel through this method
        // before any DOM creation happens.
        if (!this._isOverlayVisible) {
            return;
        }
        if (!this.pagesWithOverlays.has(pageNumber)) return;
        const hasOverlay = pageElement.querySelector('.pdf-text-overlay-reflow') !== null;
        const isLoaded = this.loadedOverlayPages.has(pageNumber);

        // If properly loaded, skip
        if (hasOverlay && isLoaded) return;

        // If overlay exists but not tracked as loaded, mark it
        if (hasOverlay && !isLoaded) {
            this.loadedOverlayPages.add(pageNumber);
            // Stage 3.3 (Q16): enforce virtualization limit. If we've
            // exceeded MAX_LOADED_PAGES, unload the oldest non-visible
            // page to keep memory bounded.
            this.enforceLoadedPagesLimit();
            return;
        }

        try {
            await this.loadSavedOverlayForPage(pageNumber, false);
            // Stage 3.3 (Q16): after loading, enforce the limit again.
            // The newly loaded page is now the "newest" — oldest pages
            // get unloaded first.
            this.enforceLoadedPagesLimit();
        } catch (error) {
            this.logDebug(`Failed to ensure overlay for page ${pageNumber}:`, error);
            // Remove from loaded set so we'll retry later
            this.loadedOverlayPages.delete(pageNumber);
        }
    }

    /**
     * Stage 3.3 (Q16): Virtualization — unload overlays for pages that
     * are no longer visible when we exceed MAX_LOADED_PAGES. Keeps
     * memory bounded for large PDFs (500+ pages) without sacrificing
     * scroll performance.
     *
     * REGRESSION FIX: previously MAX_LOADED_PAGES was 5, which was too
     * aggressive. When the user scrolled, new pages couldn't load
     * because the limit was reached, and old pages weren't unloaded
     * fast enough. The user had to click the mouse to trigger a
     * re-layout that forced IO to re-fire. Now MAX_LOADED_PAGES is 15
     * — large enough to cover visible (3-5) + buffer (10) pages, but
     * still bounded for 500+ page PDFs.
     *
     * Algorithm:
     *   1. If loadedOverlayPages.size <= MAX_LOADED_PAGES, do nothing.
     *   2. Otherwise, find loaded pages that are NOT currently visible
     *      (using getVisiblePages with the unified margin).
     *   3. Sort them by distance from the viewport center (farthest first).
     *   4. Unload (clearOverlayFromPage + delete from loadedOverlayPages)
     *      until we're under the limit.
     *
     * Pages currently visible are NEVER unloaded — only off-screen ones.
     * This prevents flickering during normal scroll.
     */
    private static readonly MAX_LOADED_PAGES = 15;

    private enforceLoadedPagesLimit(): void {
        if (this.loadedOverlayPages.size <= OverlayRenderer.MAX_LOADED_PAGES) {
            return;
        }

        const leaf = this.getActivePDFLeaf();
        if (!leaf) return;

        // Get currently visible page numbers (these are protected from unload).
        const visiblePages = this.plugin.pdfDom.getVisiblePages(leaf, VISIBLE_PAGE_MARGIN_PX);
        const visiblePageNumbers = new Set<number>();
        for (const pageEl of visiblePages) {
            const num = parseInt(pageEl.dataset.pageNumber || '', 10);
            if (Number.isFinite(num)) visiblePageNumbers.add(num);
        }

        // Find loaded pages that are NOT visible — candidates for unload.
        const allPages = this.plugin.pdfDom.getPages(leaf);
        const pageElementMap = new Map<number, HTMLElement>();
        for (const pageEl of allPages) {
            const num = parseInt(pageEl.dataset.pageNumber || '', 10);
            if (Number.isFinite(num)) pageElementMap.set(num, pageEl);
        }

        const unloadCandidates: Array<{ pageNum: number; pageEl: HTMLElement; distance: number }> = [];
        const viewportCenter = window.innerHeight / 2;

        for (const pageNum of this.loadedOverlayPages) {
            if (visiblePageNumbers.has(pageNum)) continue;  // never unload visible
            const pageEl = pageElementMap.get(pageNum);
            if (!pageEl) {
                // Page element no longer in DOM — just untrack.
                this.loadedOverlayPages.delete(pageNum);
                continue;
            }
            const rect = pageEl.getBoundingClientRect();
            const pageCenter = rect.top + rect.height / 2;
            const distance = Math.abs(pageCenter - viewportCenter);
            unloadCandidates.push({ pageNum, pageEl, distance });
        }

        // Sort by distance (farthest first = unload first).
        unloadCandidates.sort((a, b) => b.distance - a.distance);

        // Unload until we're under the limit.
        let toUnload = this.loadedOverlayPages.size - OverlayRenderer.MAX_LOADED_PAGES;
        for (const candidate of unloadCandidates) {
            if (toUnload <= 0) break;
            this.clearOverlayFromPage(candidate.pageEl);
            this.loadedOverlayPages.delete(candidate.pageNum);
            this.logDebug(`Virtualization: unloaded page ${candidate.pageNum} (distance ${candidate.distance.toFixed(0)}px from viewport center)`);
            toUnload--;
        }
    }

    /**
     * [Optimized] Rerender all visible overlays after zoom or layout change.
     * Uses staging + batching to minimize reflows and parallelize across pages.
     */
    private async rerenderVisibleOverlays() {
        if (this.isReloadingOverlay) return;
        this.isReloadingOverlay = true;
        this.logDebug("Rerendering visible overlays due to zoom or layout change.");
        // P2-59 (Phase 14): register a sentinel in `inFlightPageLoads` for
        // the duration of this rerender. `loadSavedOverlayForPage` checks
        // the sentinel at entry and awaits it, preventing a race where a
        // scroll-triggered load creates overlays on a page that this
        // rerender is about to wipe via `clearOverlayFromPage`. The
        // sentinel key is negative (-1) so it can't collide with real
        // (1-indexed) page numbers.
        const rerenderPromise = this.rerenderVisibleOverlaysInner();
        this.inFlightPageLoads.set(OverlayRenderer.RERENDER_SENTINEL, rerenderPromise);
        try {
            await rerenderPromise;
        } finally {
            this.isReloadingOverlay = false;
            if (this.inFlightPageLoads.get(OverlayRenderer.RERENDER_SENTINEL) === rerenderPromise) {
                this.inFlightPageLoads.delete(OverlayRenderer.RERENDER_SENTINEL);
            }
        }
    }

    private async rerenderVisibleOverlaysInner() {
        try {
            const leaf = this.getActivePDFLeaf();
            if (!leaf) return;
            const viewerContainer = leaf.view.containerEl.querySelector('.pdfViewer, #viewer');
            if (!viewerContainer) {
                this.logDebug("Could not find viewer container during rerender. Aborting.");
                return;
            }

            // Let the DOM settle after zoom
            await new Promise(r => setTimeout(r, ZOOM_DIM_STABLE_WAIT));

            const pages = this.getPDFPagesForLeaf(leaf);
            if (!pages) return;

            const viewportHeight = window.innerHeight;
            const visiblePages: HTMLElement[] = Array.from(pages).filter(p => {
                const rect = p.getBoundingClientRect();
                return rect.bottom > 0 && rect.top < viewportHeight;
            });

            if (visiblePages.length === 0) return;

            // Clear loaded state for visible pages since we're rerendering
            visiblePages.forEach(pageElement => {
                const pageNumberStr = pageElement.dataset.pageNumber;
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    this.loadedOverlayPages.delete(pageNumber);
                }
            });

            // --- Batching optimization ---
            const stagingContainer = document.createElement('div');
            stagingContainer.style.cssText = `
                position: absolute;
                top: -99999px;
                left: -99999px;
                visibility: hidden;
            `;
            document.body.appendChild(stagingContainer);

            const pageOverlaySets: { pageNumber: number, pageElement: HTMLElement, overlays: HTMLElement[] }[] = [];

            // Step 1: prepare overlays for all visible pages in parallel
            await Promise.all(visiblePages.map(async pageElement => {
                const pageNumberStr = pageElement.dataset.pageNumber;
                if (!pageNumberStr) return;
                const pageNumber = parseInt(pageNumberStr, 10);
                if (!this.pagesWithOverlays.has(pageNumber)) return;
                if (this.inFlightPageLoads.has(pageNumber)) return; // a load owns this page (#9)
                const pageData = this._cachedOverlayData?.pageOverlays[pageNumber];
                if (!pageData || pageData.length === 0) return;

                // FIX B3: pass the leaf we already captured (the loop's leaf).
                const textLayer = await this.waitForPdfTextLayer(pageNumber, leaf);
                if (!textLayer) return;

                // guarantee container
                if (pageElement.querySelector('.pdf-text-overlay-container')) {
                    this.clearOverlayFromPage(pageElement);
                }
                const overlayContainer = this.preparePageForOverlay(pageElement);

                const textLayerRect = textLayer.getBoundingClientRect();
                const fallbackRef = (textLayer.querySelector('span') as HTMLSpanElement) || document.createElement('span');
                const overlays: HTMLElement[] = [];

                for (const data of pageData) {
                    try {
                        // Saved positions are textLayer-relative fractions.
                        // Multiply by textLayerRect dimensions to get textLayer-relative pixels.
                        // The overlay container is page-relative, but in standard PDF.js 4.x
                        // textLayer covers the entire page (offset = 0), so no shift needed.
                        const absRect = new DOMRect(
                            data.relativeRect.left * textLayerRect.width,
                            data.relativeRect.top * textLayerRect.height,
                            data.relativeRect.width * textLayerRect.width,
                            data.relativeRect.height * textLayerRect.height
                        );
                        // Pass necessary settings to uiRenderer
                        const overlayEl = this.uiRenderer.createReflowOverlay(
                            absRect,
                            data.translatedText,
                            fallbackRef,
                            data.originalFontSizes || [],
                            pageNumber,
                            data.textContent || '',
                            this.plugin.settings.overlayOpacity,
                            this.plugin.settings.outputFontSizeScale,
                            this.plugin.settings.outputLineHeight,
                            this.lastKnownScale,
                            data.fontFamily,
                            // Phase 8 (V4 Schema): pass the source OverlayPositionData
                            // so createReflowOverlay can stamp `data-translation-id`
                            // and `data-engine` onto the inner element. The
                            // edit-translation modal reads these back to preserve
                            // the overlay's identity and engine across the edit
                            // cycle (otherwise the modal falls back to textContent
                            // lookup and stamps `engine: 'manual-edit'`).
                            data,
                        );
                        stagingContainer.appendChild(overlayEl);
                        overlays.push(overlayEl);
                    } catch (err) {
                        this.logDebug(`Error staging overlay for page ${pageNumber}`, err);
                    }
                }
                pageOverlaySets.push({ pageNumber, pageElement: overlayContainer, overlays });
            }));

            // Step 2: batch adjustments in one RAF
            await new Promise<void>(resolve => requestAnimationFrame(() => {
                for (const { overlays } of pageOverlaySets) {
                    for (const el of overlays) {
                        // Pass the current global line height setting to the adjustment function
                        this.uiRenderer.adjustOverlayForOverflow(el, this.plugin.settings.outputLineHeight);
                    }
                }
                resolve();
            }));

            // Step 3: move overlays to their actual containers and mark as loaded
            for (const { pageNumber, pageElement, overlays } of pageOverlaySets) {
                for (const el of overlays) {
                    pageElement.appendChild(el);
                }
                // Mark page as loaded (previously read pageElement.dataset.dataset — always undefined)
                this.loadedOverlayPages.add(pageNumber);
            }

            stagingContainer.remove();
            this.logDebug(`Rerendered overlays for ${pageOverlaySets.length} visible page(s)`);
        } catch (error) {
            this.logDebug("Error during visible overlay rerender:", error);
        }
    }

    private clampAllBboxPositions(): void {
        const currentPageEl = this.getCurrentPageElement();
        if (!currentPageEl) return;

        const pageRect = currentPageEl.getBoundingClientRect();
        currentPageEl.querySelectorAll('.pdf-text-overlay-reflow').forEach(el => {
            const htmlEl = el as HTMLElement;
            let left = parseFloat(htmlEl.style.left || '0');
            let top = parseFloat(htmlEl.style.top || '0');
            const width = parseFloat(htmlEl.style.width || '0');
            const height = parseFloat(htmlEl.style.height || '0');

            left = Math.max(0, Math.min(left, pageRect.width - width));
            top = Math.max(0, Math.min(top, pageRect.height - height));

            htmlEl.style.left = `${left}px`;
            htmlEl.style.top = `${top}px`;
        });
    }

    // ============================================================
    // Visibility & Utility
    // ============================================================

    /**
     * P1-20 (revised per user feedback): toggle overlay visibility across
     * ALL visible pages — and enforce it as a true global disable.
     *
     * User requirement: when "Hide overlay" is pressed, NO overlays should
     * appear for ANY page that enters the viewport, until the user toggles
     * back to "Show". This is a temporary global disable, not just a CSS
     * visibility flip — overlays are physically removed from the DOM and
     * not recreated on scroll.
     *
     * Implementation (3 parts):
     *   1. Flip `_isOverlayVisible`.
     *   2. For HIDE: `applyVisibilityToVisiblePages(false)` walks every
     *      visible page and calls `clearOverlayFromPage` to physically
     *      remove overlay DOM nodes, then drops them from
     *      `loadedOverlayPages`. The saved data in `.translations.md` is
     *      NOT touched — only the in-DOM rendering is suppressed.
     *   3. The early-return in `ensurePageOverlayLoaded` (which checks
     *      `_isOverlayVisible`) is the second line of defense: even if
     *      the IntersectionObserver, `quickVisibilityCheck`, or
     *      `comprehensiveOverlayCheck` fire while hidden, no overlay is
     *      created for any page scrolling into view.
     *   4. For SHOW: `applyVisibilityToVisiblePages(true)` calls
     *      `loadSavedOverlayForPage` for every visible page that has saved
     *      data but no DOM nodes yet. `createReflowOverlay` also consults
     *      `_isOverlayVisible` (now `true`) so newly-created overlays
     *      start visible.
     *   5. Persist `_isOverlayVisible` to `showOverlayByDefault` so the
     *      setting survives reloads.
     */
    public async toggleOverlayVisibility(): Promise<void> {
        this._isOverlayVisible = !this._isOverlayVisible;
        if (this.visibilityDebounceTimeout) clearTimeout(this.visibilityDebounceTimeout);

        // P1-20: persist + Notice fire synchronously so the user gets
        // immediate feedback even though the DOM work is debounced.
        new Notice(`Overlay ${this.isOverlayVisible ? 'shown' : 'hidden'} (visible pages)`);
        this.plugin.settings.showOverlayByDefault = this.isOverlayVisible;
        this.plugin.saveSettings().catch(console.error);

        // Run the actual work on a debounced timeout so rapid toggles
        // coalesce into a single pass.
        return new Promise<void>(resolve => {
            this.visibilityDebounceTimeout = setTimeout(async () => {
                this.visibilityDebounceTimeout = null;
                try {
                    await this.applyVisibilityToVisiblePages(this.isOverlayVisible);
                } catch (err) {
                    this.logDebug('toggleOverlayVisibility error:', err);
                } finally {
                    resolve();
                }
            }, DEBOUNCE_DELAY);
        });
    }

    /**
     * P1-20 (revised per user feedback): apply the current visibility state
     * to all visible pages.
     *
     * - If `visible === false`: REMOVE every `.pdf-text-overlay-reflow`
     *   (and their container) from every visible page, and untrack them
     *   from `loadedOverlayPages`. Combined with the early-return in
     *   `ensurePageOverlayLoaded` (which checks `_isOverlayVisible`),
     *   this prevents any overlay from being recreated when the user
     *   scrolls. The saved data in `.translations.md` is untouched — only
     *   the in-DOM rendering is suppressed. When the user toggles back to
     *   "Show", `loadSavedOverlayForPage` will rebuild the overlays from
     *   disk.
     * - If `visible === true`: ensure overlays are loaded for every
     *   visible page that has saved data but no DOM nodes yet.
     */
    private async applyVisibilityToVisiblePages(visible: boolean): Promise<void> {
        const leaves = this.plugin.app.workspace.getLeavesOfType('pdf');
        for (const leaf of leaves) {
            const pages = this.plugin.pdfDom.getVisiblePages(leaf);
            for (const pageEl of pages) {
                const pageNumStr = pageEl.dataset.pageNumber;
                if (!pageNumStr) continue;
                const pageNum = parseInt(pageNumStr, 10);
                if (!Number.isFinite(pageNum)) continue;

                if (!visible) {
                    // P1-20 (revised): physically remove overlay DOM nodes
                    // from this page (not just hide them via CSS) AND
                    // untrack from `loadedOverlayPages`. Otherwise, when
                    // the user scrolls away and back, PDF.js may have
                    // destroyed and recreated the page element (its DOM
                    // children change), in which case `hasOverlay === false`
                    // and `ensurePageOverlayLoaded` would proceed to
                    // `loadSavedOverlayForPage`. The early-return on
                    // `_isOverlayVisible` in `ensurePageOverlayLoaded`
                    // catches that path too. Clearing `loadedOverlayPages`
                    // here keeps the state consistent for the SHOW toggle:
                    // when the user toggles back, every visible page is
                    // treated as "needs reload".
                    this.clearOverlayFromPage(pageEl);
                    this.loadedOverlayPages.delete(pageNum);
                } else {
                    // SHOW: load saved overlays for any visible page that
                    // doesn't yet have them in the DOM. The
                    // `createReflowOverlay` call inside
                    // `loadSavedOverlayForPage` consults
                    // `_isOverlayVisible` (now `true`) so newly-created
                    // overlays start visible.
                    if (this.pagesWithOverlays.has(pageNum) && !this.loadedOverlayPages.has(pageNum)) {
                        try {
                            // Phase 11 (C7): forward the loop's leaf so
                            // loadSavedOverlayForPage uses it for the entire
                            // load+render cycle.
                            await this.loadSavedOverlayForPage(pageNum, false, leaf);
                        } catch (err) {
                            this.logDebug(`loadSavedOverlayForPage(${pageNum}) during show:`, err);
                        }
                    }
                }
            }
        }
        // P1-8 (Phase 14): after the SHOW load-loop, update CSS visibility
        // on ALL already-loaded overlays across every leaf. This catches
        // overlays that were created by the background worker (or any other
        // path) WHILE the user was in HIDE state — those overlays had
        // `_isOverlayVisible === false` at creation time, so their CSS
        // `visibility` is still `hidden` even though SHOW was just toggled.
        // Without this pass, the user would see only the freshly-loaded
        // overlays and miss the worker-created ones until the next scroll
        // trigger. HIDE doesn't need this (it physically removes the
        // overlays above), so we only call on SHOW.
        if (visible) {
            this.updateAllOverlayVisibility();
        }
    }

    /**
     * Mark a page as having overlays and ensure it's tracked by the
     * IntersectionObserver / scroll handlers.
     *
     * Called by TextProcessor.createOverlayWithText() after rendering
     * fresh overlays, so that:
     *   1. The page is added to `pagesWithOverlays` (drives IO subscription).
     *   2. The page is observed by `pageIntersectionObserver` (if active)
     *      so future scroll/visibility checks include it.
     *   3. `updateAllOverlayVisibility()` is called to apply the current
     *      `isOverlayVisible` state to the new overlays (otherwise they
     *      would render visible even if the user had toggled overlays off).
     *
     * Phase 1 (F1.2): fixes "overlay created but not auto-refreshed on page".
     */
    public markPageAsHavingOverlays(pageNumber: number, pageElement: HTMLElement): void {
        try {
            this.pagesWithOverlays.add(pageNumber);
            // If monitoring is active, subscribe this page to the IO.
            // (If monitoring isn't active yet — e.g. first translation on a
            // freshly opened PDF — setupPDFMonitoring will pick it up on the
            // next active-leaf-change via observeExistingPages.)
            if (this.pageIntersectionObserver) {
                this.pageIntersectionObserver.observe(pageElement);
            }
            // Apply current visibility state to the newly created overlays.
            this.updateAllOverlayVisibility();

            // FIX B4: ensure _cachedOverlayData has an entry for this page so
            // subsequent loadSavedOverlayForPage(N) calls find a (possibly empty)
            // bucket instead of skipping the page entirely.
            if (this._cachedOverlayData && !this._cachedOverlayData.pageOverlays[pageNumber]) {
                this._cachedOverlayData.pageOverlays[pageNumber] = [];
            }
        } catch (err) {
            this.logDebug(`markPageAsHavingOverlays failed for page ${pageNumber}:`, err);
        }
    }

    private updateAllOverlayVisibility(): void {
        const cacheKey = 'cacheRefresh';
        if (!this.activeLeavesCache || Date.now() - (this.memoCache.get(cacheKey)?.timestamp || 0) > 1000) {
            this.activeLeavesCache = new Set(this.plugin.app.workspace.getLeavesOfType('pdf'));
            this.memoCache.set(cacheKey, { value: null, timestamp: Date.now() });
        }

        this.activeLeavesCache.forEach(leaf => {
            const pages = this.getPDFPagesForLeaf(leaf);
            pages?.forEach(page => {
                page.querySelectorAll('.pdf-text-overlay-reflow').forEach(overlay => {
                    // Delegate visibility update to uiRenderer
                    this.uiRenderer.setOverlayElementVisibility(overlay as HTMLElement, this.isOverlayVisible);
                });
            });
        });
    }

    // Note: adjustOverlayForOverflow is now handled by uiRenderer and is private there
    // Note: setOverlayElementVisibility is now handled by uiRenderer and is private there

    // ============================================================
    // Getters (with memoization)
    // ============================================================

    private getMemoized<T>(key: string, fn: () => T, ttl: number = CACHE_TTL): T {
        const cached = this.memoCache.get(key);
        if (cached && Date.now() - cached.timestamp < ttl) return cached.value;
        const value = fn();
        this.memoCache.set(key, { value, timestamp: Date.now() });
        return value;
    }

    public getActivePDFLeaf(): any | null {
        return this.plugin.pdfDom.getActivePdfLeaf();
    }

    public getPDFPagesForLeaf(leaf: any): NodeListOf<HTMLElement> | null {
        const viewerContainer = this.plugin.pdfDom.getViewerRoot(leaf);
        return viewerContainer?.querySelectorAll('.page[data-page-number]') || null;
    }

    public getCurrentPageElement(): HTMLElement | null {
        // FIX B2: removed memoization (was TTL=100ms via getMemoized).
        // The short TTL caused cross-page contamination when the user scrolled
        // quickly: saveCurrentPageOverlay() could grab a stale cached page
        // element from the previous page and save overlays into the wrong bucket.
        // getBoundingClientRect() is cheap enough to call directly on each access.
        try {
            return this.plugin.pdfDom.getCurrentVisiblePage();
        } catch (error) {
            this.logDebug('getCurrentPageElement error:', error);
            return null;
        }
    }

    public getCurrentPageTextLayer(): HTMLElement | null {
        // FIX B2: removed memoization for the same reason as getCurrentPageElement.
        const currentPage = this.getCurrentPageElement();
        return currentPage ? this.plugin.pdfDom.getTextLayerOf(currentPage) : null;
    }

    public getCurrentVisiblePage(pages: NodeListOf<HTMLElement> | null): HTMLElement | null {
        // Kept for backward compatibility; the adapter owns the real logic.
        if (!pages || pages.length === 0) return this.plugin.pdfDom.getCurrentVisiblePage();
        let bestPage: HTMLElement | null = null;
        let maxVisibleArea = -1;
        for (const page of Array.from(pages)) {
            const rect = page.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const viewportHeight = window.innerHeight;
            const visibleTop = Math.max(0, rect.top);
            const visibleBottom = Math.min(viewportHeight, rect.bottom);
            const visibleHeight = Math.max(0, visibleBottom - visibleTop);
            const visibleArea = visibleHeight * rect.width;
            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                bestPage = page;
            }
        }
        return bestPage;
    }

    // ============================================================
    // Overlay Creation & Rendering
    // ============================================================

    public async waitForPdfTextLayer(
        pageNumber: number,
        leaf?: any,
    ): Promise<HTMLElement | null> {
        // FIX B3: pass leaf through to pdfDom.waitForTextLayer.
        // Previously leaf was omitted, defaulting to activeLeaf inside pdfDom.
        // When multiple PDFs were open in split view, overlays could be rendered
        // onto the wrong PDF's page (same page number, wrong leaf).
        return this.plugin.pdfDom.waitForTextLayer(
            pageNumber,
            { timeoutMs: OVERLAY_WAIT_TIMEOUT, intervalMs: OVERLAY_CHECK_INTERVAL },
            leaf,
        );
    }

    // Note: bringToTop is now handled by uiRenderer and is private there
    // Note: createReflowOverlay is now handled by uiRenderer and is private there

    /**
     * Render all saved overlays onto a page, using a staging container
     * to batch DOM measurements and reduce layout thrashing.
     *
     * Phase 11 (C7): the method now accepts an optional `leaf` parameter so
     * callers that have already captured the active PDF leaf can pass it
     * through. Previously the method re-queried `getActivePDFLeaf()` after
     * an `await`, which — combined with split-pane PDF views or rapid file
     * switches — could render the saved overlay onto the *wrong* leaf (the
     * one that happened to be active when the await resolved, not the one
     * the caller intended). The defense-in-depth re-check below bails out
     * if the active leaf has changed since the caller captured theirs.
     */
    public async renderSavedOverlay(
        positionData: OverlayPositionData[],
        pageNumber: number,
        leaf?: any,
    ): Promise<void> {
        try {
            // Use the caller-provided leaf if available; otherwise fall back
            // to a fresh query. Either way, we keep `activeLeaf` for the
            // entire render so waitForPdfTextLayer does not default to a
            // different leaf mid-await.
            const activeLeaf = leaf || this.getActivePDFLeaf();
            if (!activeLeaf) {
                this.logDebug(`renderSavedOverlay: no active leaf for page ${pageNumber}`);
                return;
            }

            // Defense-in-depth: re-check that the active leaf is still the
            // one the caller captured. If the user has switched files (or
            // split panes) during the await chain, abort — rendering onto
            // the wrong leaf's pages is worse than skipping the render.
            const currentLeaf = this.getActivePDFLeaf();
            if (currentLeaf && currentLeaf !== activeLeaf) {
                this.logDebug(`renderSavedOverlay: leaf changed during await, aborting (page ${pageNumber})`);
                return;
            }

            // FIX B3: pass active leaf so waitForPdfTextLayer doesn't default
            // to whatever leaf happens to be active at the moment of the await.
            const textLayer = await this.waitForPdfTextLayer(pageNumber, activeLeaf);
            if (!textLayer) {
                this.logDebug(`Cannot render overlay – no textLayer for page ${pageNumber}`);
                return;
            }

            const pageElement = textLayer.closest('.page') as HTMLElement;
            if (!pageElement) return;

            // Wait for textLayer dimensions to become valid
            let retries = 0;
            let textLayerRect = textLayer.getBoundingClientRect();
            while ((textLayerRect.width === 0 || textLayerRect.height === 0) && retries < MAX_DIMENSION_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY));
                retries++;
                textLayerRect = textLayer.getBoundingClientRect();
            }
            if (textLayerRect.width === 0 || textLayerRect.height === 0) {
                this.logDebug(`TextLayer still unavailable for page ${pageNumber} after ${retries} retries`);
                return;
            }

            // Ensure overlay container
            const overlayContainer = this.preparePageForOverlay(pageElement);
            const fallbackRef = (textLayer.querySelector('span') as HTMLSpanElement) || document.createElement('span');

            // --- Batching optimization ---
            const stagingContainer = document.createElement('div');
            stagingContainer.style.cssText = `
                position: absolute;
                top: -99999px;
                left: -99999px;
                visibility: hidden;
            `;
            document.body.appendChild(stagingContainer);

            const overlays: HTMLElement[] = [];

            // Step 1: Create all overlays and put them in staging container
            for (let overlayIndex = 0; overlayIndex < positionData.length; overlayIndex++) {
                const data = positionData[overlayIndex];
                try {
                    const scaleX = textLayerRect.width;
                    const scaleY = textLayerRect.height;
                    const absoluteRect = new DOMRect(
                        data.relativeRect.left * scaleX,
                        data.relativeRect.top * scaleY,
                        data.relativeRect.width * scaleX,
                        data.relativeRect.height * scaleY
                    );
                    // Pass necessary settings to uiRenderer
                    const overlayEl = this.uiRenderer.createReflowOverlay(
                        absoluteRect,
                        data.translatedText,
                        fallbackRef,
                        data.originalFontSizes || [],
                        pageNumber,
                        data.textContent || '',
                        this.plugin.settings.overlayOpacity,
                        this.plugin.settings.outputFontSizeScale,
                        this.plugin.settings.outputLineHeight,
                        this.lastKnownScale,
                        data.fontFamily,
                        // Phase 8 (V4 Schema): pass the source OverlayPositionData
                        // so createReflowOverlay can stamp `data-translation-id`
                        // and `data-engine` onto the inner element. Same
                        // rationale as the loadSavedOverlayForPage call site
                        // above — preserves id + engine across the edit cycle.
                        data,
                    );
                    overlayEl.setAttribute('data-overlay-index', String(overlayIndex));
                    overlayEl.setAttribute('data-overlay-page', String(pageNumber));
                    stagingContainer.appendChild(overlayEl);
                    overlays.push(overlayEl);
                } catch (itemError) {
                    this.logDebug(`Error staging overlay for page ${pageNumber}`, itemError);
                }
            }

            // Step 2: Batch measure & adjust for overflow
            await new Promise<void>(resolve => requestAnimationFrame(() => {
                for (const el of overlays) {
                    // Pass the current global line height setting to the adjustment function
                    this.uiRenderer.adjustOverlayForOverflow(el, this.plugin.settings.outputLineHeight);
                }
                resolve();
            }));

            // Step 3: Move finished overlays into the actual overlay container
            for (const el of overlays) {
                overlayContainer.appendChild(el);
            }

            // Clean up staging container
            stagingContainer.remove();

            // Mark as loaded
            this.loadedOverlayPages.add(pageNumber);

            this.logDebug(`Rendered saved overlay for page ${pageNumber} (${overlays.length} items)`);
            setTimeout(() => this.clampAllBboxPositions(), 50);
        } catch (error) {
            this.logDebug(`renderSavedOverlay failed for page ${pageNumber}:`, error);
        }
    }

    // ============================================================
    // Loading & Saving (ENHANCED with better state tracking)
    // ============================================================

    public async loadSavedOverlayForPage(
        pageNumber: number,
        force: boolean = false,
        leaf?: any,
    ): Promise<void> {
        // P2-59 (Phase 14): if a `rerenderVisibleOverlays` pass is in flight,
        // wait for it to complete before loading this page. Without this
        // queueing, the rerender's `clearOverlayFromPage` (called inside its
        // per-page loop) could wipe overlays we're about to create, or our
        // freshly-created overlays could be on a page the rerender is about
        // to clear — leading to flicker / lost overlays / double-renders.
        // The sentinel is registered at key `-1` (negative to avoid collision
        // with real 1-indexed page numbers).
        if (this.isReloadingOverlay) {
            const sentinel = this.inFlightPageLoads.get(OverlayRenderer.RERENDER_SENTINEL);
            if (sentinel) {
                this.logDebug(`loadSavedOverlayForPage(${pageNumber}): waiting for in-progress rerender.`);
                await sentinel.catch(() => {});
                // After the rerender completes, the page may already have
                // been reloaded by the rerender itself. If we're not a forced
                // load and the page is now loaded, exit early.
                if (!force && this.loadedOverlayPages.has(pageNumber)) {
                    this.logDebug(`loadSavedOverlayForPage(${pageNumber}): page already loaded after rerender, skipping.`);
                    return;
                }
            }
        }

        if (!this._cachedOverlayData) {
            this.logDebug(`No cached overlay data available for page ${pageNumber}`);
            return;
        }

        // Always chain behind any in-flight load for this page (#9).
        const existing = this.inFlightPageLoads.get(pageNumber);
        if (existing) {
            await existing.catch(() => {});
            // A non-forced caller is satisfied by the load that just completed.
            if (!force) return;
        }

        // Phase 11 (C7): capture leaf once for the whole load operation.
        // Callers that already have a leaf (e.g. forceRefreshVisibleOverlays,
        // refreshOverlayStateForCurrentPdf, applyVisibilityToVisiblePages,
        // forceLoadVisiblePages, loadSavedOverlayForCurrentPage) pass it in
        // so we don't re-query mid-await and risk landing on the wrong leaf
        // after a file switch. The fallback below preserves the existing
        // behaviour for external callers that don't pass a leaf.
        const activeLeaf = leaf || this.getActivePDFLeaf();
        if (!activeLeaf) {
            this.logDebug(`loadSavedOverlayForPage: no active leaf for page ${pageNumber}`);
            return;
        }

        const loadPromise = (async () => {
            try {
                const pageData = this._cachedOverlayData!.pageOverlays[pageNumber];
                if (!pageData || pageData.length === 0) {
                    this.logDebug(`No overlay data for page ${pageNumber}`);
                    return;
                }

                const textLayer = await this.waitForPdfTextLayer(pageNumber, activeLeaf);
                if (!textLayer) {
                    this.logDebug(`No text layer found for page ${pageNumber}`);
                    return;
                }

                const pageElement = textLayer.closest('.page') as HTMLElement;
                if (!pageElement) {
                    this.logDebug(`No page element found for page ${pageNumber}`);
                    return;
                }

                const hasOverlay = pageElement.querySelector('.pdf-text-overlay-reflow') !== null;
                const isLoaded = this.loadedOverlayPages.has(pageNumber);

                if (hasOverlay && isLoaded && !force) {
                    return; // Already properly loaded
                }

                if (force) {
                    this.clearOverlayFromPage(pageElement);
                }

                this.logDebug(`Loading overlays for page ${pageNumber}`);
                // Phase 11 (C7): forward the captured leaf so renderSavedOverlay
                // uses the same leaf for waitForPdfTextLayer and applies the
                // defense-in-depth re-check (aborting if the active leaf has
                // changed during the await chain).
                await this.renderSavedOverlay(pageData, pageNumber, activeLeaf);

                // Clear relevant memoization cache
                this.memoCache.delete('currentPage');
                this.memoCache.delete('currentTextLayer');
            } catch (error) {
                this.logDebug(`Error loading overlay for page ${pageNumber}:`, error);
                this.loadedOverlayPages.delete(pageNumber);
                throw error;
            }
        })();

        this.inFlightPageLoads.set(pageNumber, loadPromise);
        try {
            await loadPromise;
        } finally {
            // Only clear if we're still the current entry (a later forced load may have replaced us).
            if (this.inFlightPageLoads.get(pageNumber) === loadPromise) {
                this.inFlightPageLoads.delete(pageNumber);
            }
        }
    }

    public async loadSavedOverlayForCurrentPage(forceReload: boolean = false) {
        try {
            const pageNumber = this.plugin.getCurrentPageNumber();
            if (pageNumber === null) return;

            const pageElement = this.getCurrentPageElement();
            if (!pageElement) return;

            if (forceReload) {
                this.clearOverlayFromPage(pageElement);
            }

            const hasOverlay = pageElement.querySelector('.pdf-text-overlay-container') !== null;
            const isLoaded = this.loadedOverlayPages.has(pageNumber);

            if (hasOverlay && isLoaded && !forceReload) {
                return; // Already loaded and not forcing reload
            }

            const activeLeaf = this.getActivePDFLeaf();
            const activeFile = activeLeaf?.view?.file;
            if (activeFile) {
                await this.initializeOverlayStateForPdf(activeFile);
                // Phase 11 (C7): forward the captured leaf so the load uses
                // the same leaf for waitForPdfTextLayer and renderSavedOverlay.
                await this.loadSavedOverlayForPage(pageNumber, forceReload, activeLeaf);
            }
        } catch (error) {
            this.logDebug('loadSavedOverlayForCurrentPage failed:', error);
        }
    }

    public async extractCurrentOverlayParameters(): Promise<{
        positionData: OverlayPositionData[];
        pageNumber: number;
        hasData: boolean;
    }> {
        try {
            const currentPageNumber = this.plugin.getCurrentPageNumber();
            if (currentPageNumber === null) {
                return { positionData: [], pageNumber: 0, hasData: false };
            }

            const textLayer = this.getCurrentPageTextLayer();
            const overlayContainer = textLayer?.closest('.page')?.querySelector('.pdf-text-overlay-container');

            if (!textLayer || !overlayContainer) {
                return { positionData: [], pageNumber: currentPageNumber, hasData: false };
            }

            let textLayerRect = textLayer.getBoundingClientRect();
            let retries = 0;
            while ((textLayerRect.width === 0 || textLayerRect.height === 0) && retries < EXTRACT_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, EXTRACT_RETRY_INTERVAL));
                retries++;
                if (retries % 5 === 0) this.logDebug(`Extract retry ${retries}/${EXTRACT_MAX_RETRIES} for dims`);
                textLayerRect = textLayer.getBoundingClientRect();
            }
            if (textLayerRect.width === 0 || textLayerRect.height === 0) {
                this.logDebug('Extraction failed: Text layer dims still zero after retries.');
                return { positionData: [], pageNumber: currentPageNumber, hasData: false };
            }

            const positionData = this.extractPositionDataFrom(textLayer, overlayContainer, textLayerRect);

            return {
                positionData,
                pageNumber: currentPageNumber,
                hasData: positionData.length > 0
            };
        } catch (error) {
            this.logDebug('extractCurrentOverlayParameters failed:', error);
            return { positionData: [], pageNumber: 0, hasData: false };
        }
    }

    public extractPositionDataFrom(textLayer: HTMLElement, overlayContainer: Element, textLayerRect: DOMRect): OverlayPositionData[] {
        if (!textLayer || !overlayContainer) {
            return [];
        }

        // FIX: BLEED constants must match overlay-ui.ts to reverse the bleed applied
        // during createReflowOverlay. Without this, saved positions include the bleed
        // (expanded rect), and on load createReflowOverlay applies bleed AGAIN →
        // double-bleed → overlay shifted and larger than intended.
        const BLEED_X = 4;
        const BLEED_Y_NORMAL = 2;
        const BLEED_Y_TIGHT = 0;

        const positionData: OverlayPositionData[] = [];
        const overlays = Array.from(overlayContainer.querySelectorAll<HTMLElement>('.pdf-text-overlay-reflow'));
        const pageNumber = this.plugin.getCurrentPageNumber() ?? 0;

        const saveScale = this.plugin.pdfDom.getScaleFactorFromPage(textLayer);

        for (const overlay of overlays) {
            try {
                const rect = overlay.getBoundingClientRect();

                // Reverse the bleed applied by createReflowOverlay to recover the
                // tight bbox of the original text. This ensures that on reload,
                // createReflowOverlay can re-apply the bleed correctly.
                const isTight = overlay.getAttribute('data-is-tight') === 'true';
                const bleedY = isTight ? BLEED_Y_TIGHT : BLEED_Y_NORMAL;
                const tightRect = {
                    left:   rect.left   + BLEED_X,
                    top:    rect.top    + bleedY,
                    width:  rect.width  - (BLEED_X * 2),
                    height: rect.height - (bleedY * 2),
                };
                // Clamp to non-negative
                if (tightRect.width <= 0 || tightRect.height <= 0) {
                    this.logDebug('Skipping overlay with zero/negative tight rect');
                    continue;
                }

                const relativeRect = {
                    left:   (tightRect.left - textLayerRect.left) / textLayerRect.width,
                    top:    (tightRect.top  - textLayerRect.top)  / textLayerRect.height,
                    width:  tightRect.width  / textLayerRect.width,
                    height: tightRect.height / textLayerRect.height,
                };

                let originalFontSizes: number[] = [];
                const fontSizesAttr = overlay.getAttribute('data-original-font-sizes');
                if (fontSizesAttr) {
                    try {
                        originalFontSizes = JSON.parse(fontSizesAttr);
                    } catch (e) {
                        this.logDebug("Could not parse font sizes from attribute", e);
                    }
                }

                const relativeFontSizes: number[] = originalFontSizes.length > 0 && saveScale > 0
                    ? originalFontSizes.map(fs => fs / saveScale)
                    : [];

                positionData.push({
                    selector: '',
                    textContent: overlay.getAttribute('data-original-text') || '',
                    translatedText: overlay.querySelector('div')?.innerHTML || overlay.textContent || '',
                    relativeRect,
                    page: pageNumber,
                    originalFontSizes: relativeFontSizes,
                    fontFamily: overlay.style.fontFamily || undefined,
                    // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
                    // Generated here (DOM-extraction path) so the saved overlay has an
                    // id that matches what the retranslator/queue/processing paths
                    // produce for the same source paragraph — enables merge-by-id-first
                    // in updatePageOverlaysAndWrite and exact lookup in edit modal.
                    id: generateOverlayId(pageNumber, relativeRect, overlay.getAttribute('data-original-text') || ''),
                    // Phase 8 (V4 Schema): engine stamp from current provider/model.
                    // The DOM-extraction path runs AFTER a translation has rendered
                    // into the DOM (so the engine that produced the text is the
                    // current one in settings — there's no per-overlay DOM
                    // attribute carrying the original engine for this path, since
                    // the rendered overlays were just created from TranslationUnits
                    // that didn't carry an engine field). For reload-from-disk
                    // paths (renderSavedOverlay), the engine is read from the
                    // saved overlay's metadata, not from the DOM.
                    engine: getCurrentEngine(this.plugin),
                });
            } catch (itemError) {
                this.logDebug('extractPositionDataFrom item error:', itemError);
            }
        }

        return positionData;
    }

    // Phase 2 (P3-15): the no-arg `saveCurrentPageOverlay()` was dead code
    // (zero live callers — confirmed via grep; only comment references in
    // processing.ts and overlay.ts remained). The page-element-scoped variant
    // `saveCurrentPageOverlayForPage(pageElement)` below is the live path
    // (called from processing.ts rAF callback). Phase 3 will re-point the
    // `save-pdf-overlay` command palette entry at this method.

    // FIX H11: save overlay for a SPECIFIC page element (not the current page).
    // Used by rAF callback in processing.ts to prevent stale-page saves when
    // the user scrolls/flips pages between translation completion and rAF fire.
    public async saveCurrentPageOverlayForPage(pageElement: HTMLElement): Promise<boolean> {
        try {
            const activeFile = this.getActivePDFLeaf()?.view?.file;
            if (!activeFile) {
                this.logDebug('Cannot save overlay, no active PDF file.');
                return false;
            }

            const pageNumber = parseInt(pageElement.getAttribute('data-page-number') || '0', 10);
            if (pageNumber === 0) {
                this.logDebug('Cannot save overlay, page number not found on element.');
                return false;
            }

            const textLayer = pageElement.querySelector('.textLayer') as HTMLElement | null;
            const overlayContainer = pageElement.querySelector('.pdf-text-overlay-container') as HTMLElement | null;

            if (!textLayer || !overlayContainer) {
                this.logDebug(`No overlay data found on page ${pageNumber} to save.`);
                return false;
            }

            let textLayerRect = textLayer.getBoundingClientRect();
            let retries = 0;
            while ((textLayerRect.width === 0 || textLayerRect.height === 0) && retries < EXTRACT_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, EXTRACT_RETRY_INTERVAL));
                retries++;
                textLayerRect = textLayer.getBoundingClientRect();
            }
            if (textLayerRect.width === 0 || textLayerRect.height === 0) {
                this.logDebug('Extraction failed: Text layer dims still zero after retries.');
                return false;
            }

            const positionData = this.extractPositionDataFrom(textLayer, overlayContainer, textLayerRect);
            if (positionData.length === 0) {
                this.logDebug(`No position data extracted from page ${pageNumber}.`);
                return false;
            }

            this.logDebug(`Saving ${positionData.length} overlays for page ${pageNumber} (captured page element)`);

            const pagesToUpdate = { [pageNumber]: positionData };
            await this.plugin.storage.updatePageOverlaysAndWrite(activeFile, pagesToUpdate);

            // Keep runtime state in sync
            this.pagesWithOverlays.add(pageNumber);
            this.loadedOverlayPages.add(pageNumber);
            // Phase 2 (P1-19): the manual `cachedOverlayData.pageOverlays[pageNumber]
            // = positionData` patch was redundant — `updatePageOverlaysAndWrite`
            // already calls `updateCacheFromWrite` after the write resolves, which
            // correctly refreshes `cachedOverlayData` from the merged result.
            // The manual patch was a double-write that could mask cache-coherency
            // bugs (and would diverge from disk if the merge produced a different
            // array than `positionData`, e.g. on overlap-collision with stale items).

            return true;
        } catch (error) {
            this.logDebug('saveCurrentPageOverlayForPage failed:', error);
            return false;
        }
    }

    // Note: adjustSingleOverlayLineHeight and adjustSingleOverlayFontSize are now handled by uiRenderer and are private there

    // ============================================================
    // Cleanup (ENHANCED with better state tracking)
    // ============================================================

    // Note: cleanupHoverHandlers and cleanupOverlayElement are now handled by uiRenderer and are private there
    // The main cleanupOverlayElement is now a delegate call to uiRenderer.cleanupOverlayElement

    /**
     * FIX (stale overlay on new PDF): Reset ALL in-memory state when the
     * active PDF changes. Called synchronously from the active-leaf-change
     * handler in main.ts — BEFORE the 300ms setupPDFMonitoring delay.
     *
     * Without this, the old PDF's `cachedOverlayData` + `pagesWithOverlays`
     * + `loadedOverlayPages` remain active during the 300ms window, and
     * scroll/IO handlers can use them to render the old PDF's overlays on
     * the new PDF's pages.
     *
     * This is safe to call multiple times — it just clears state. The next
     * `setupPDFMonitoring` call will re-initialize everything from disk.
     */
    public resetStateForNewFile(): void {
        this._cachedOverlayData = null;
        this.pagesWithOverlays.clear();
        this.loadedOverlayPages.clear();
        this.inFlightPageLoads.clear();
        this.memoCache.clear();
        this.activeLeavesCache = null;
        // Note: do NOT call cleanupMonitoring() here — that disconnects
        // observers which setupPDFMonitoring will re-create. We just clear
        // the data state; the observers will be replaced when the new PDF
        // is set up.
        this.logDebug('resetStateForNewFile: cleared all overlay state.');
    }

    /**
     * FIX B1 (revised): Update the in-memory cache directly from the writer's
     * merged result. Called by storage.updatePageOverlaysAndWrite AFTER the
     * file has been written to disk.
     *
     * This replaces the previous approach of invalidating the cache via
     * metadataCache.on('changed') + invalidateCacheForFile(). That approach
     * was too aggressive — it cleared pagesWithOverlays (which drives the
     * IntersectionObserver and ensurePageOverlayLoaded), preventing any page
     * from loading after a self-write. It also never re-initialized for
     * self-writes (debouncedBuildMap was skipped), leaving the renderer in
     * a permanently broken state until the user switched files.
     *
     * Now: the writer passes us the FULL merged savedOverlay (all pages,
     * not just the newly written one). We update cachedOverlayData in-place
     * and add any new page numbers to pagesWithOverlays so the IO picks them up.
     *
     * P2-20 (Phase 12): the previously-visible page is also force-reloaded
     * if it has any data in the freshly-written savedOverlay. The original
     * "leave already-loaded pages alone" rule meant that when the background
     * worker wrote overlays for the page the user was CURRENTLY looking at,
     * the DOM never updated until the user scrolled the page out of and
     * back into view (relying on the IO). Force-reloading the visible page
     * makes worker writes appear live. Non-visible pages still rely on the
     * IO subscription so we don't churn the DOM for off-screen pages.
     */
    public updateCacheFromWrite(pdfFile: TFile, savedOverlay: SavedOverlay): void {
        // Only update if this write is for the currently-active PDF.
        const activeFile = this.getActivePDFLeaf()?.view?.file;
        if (!activeFile || activeFile.path !== pdfFile.path) return;

        // FIX B5: if cachedOverlayData was null (PDF was open before the
        // translation file existed), we need to do a FULL re-init — not
        // just update the cache. This sets up pagesWithOverlays and
        // subscribes the IO observer. Without this, the first worker write
        // on a freshly-opened PDF would update cachedOverlayData but leave
        // pagesWithOverlays empty, so the IO would never trigger loads.
        const wasUninitialized = this._cachedOverlayData === null;

        // Update the cached overlay data with the full merged result.
        this._cachedOverlayData = savedOverlay;

        // Add any new page numbers to pagesWithOverlays so the IO subscribes.
        const pageNumbers = Object.keys(savedOverlay.pageOverlays)
            .map(Number)
            .filter(n => !isNaN(n) && n > 0);
        for (const n of pageNumbers) {
            if (!this.pagesWithOverlays.has(n)) {
                this.pagesWithOverlays.add(n);
                // If the page element is already in the DOM, subscribe it.
                const pageEl = this.plugin.pdfDom.getPageElement(n, this.getActivePDFLeaf());
                if (pageEl && this.pageIntersectionObserver) {
                    this.pageIntersectionObserver.observe(pageEl);
                }
            }
        }

        // Clear memoization cache so next access gets fresh data.
        this.memoCache.clear();

        // P2-20 (Phase 12): re-render the currently-visible page if it was
        // just written. `loadSavedOverlayForPage(N, true)` clears any
        // existing DOM overlay for page N and re-renders from the freshly-
        // updated `_cachedOverlayData`. Fire-and-forget: the writer doesn't
        // need to wait for the DOM to update, and `updateCacheFromWrite`
        // remains synchronous so its existing callers (storage.ts) are not
        // broken.
        const currentPageNum = this.plugin.getCurrentPageNumber?.();
        if (currentPageNum != null && savedOverlay.pageOverlays[String(currentPageNum)]) {
            this.logDebug(
                `updateCacheFromWrite: visible page ${currentPageNum} was written — force re-render.`,
            );
            void this.loadSavedOverlayForPage(currentPageNum, true);
        }

        // FIX B5: if we were previously uninitialized, also force-load
        // any visible pages now (otherwise the user has to scroll to
        // trigger the IO).
        if (wasUninitialized) {
            this.logDebug(`First write detected for uninit'd PDF — force-loading visible pages.`);
            void this.forceLoadVisiblePages();
        }

        this.logDebug(
            `Cache updated from write: ${pageNumbers.length} pages for ${pdfFile.path}`
        );
    }

    /**
     * Force-load overlays for all currently-visible pages. Used after
     * cache re-initialization to make new overlays appear immediately
     * without requiring the user to scroll.
     */
    private async forceLoadVisiblePages(): Promise<void> {
        const leaf = this.getActivePDFLeaf();
        if (!leaf) return;
        const pages = this.getPDFPagesForLeaf(leaf);
        if (!pages) return;

        const viewportHeight = window.innerHeight;
        const visible: { el: HTMLElement; num: number }[] = [];
        for (const pageElement of Array.from(pages)) {
            const rect = pageElement.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;
            const pageNumberStr = pageElement.dataset.pageNumber;
            if (!pageNumberStr) continue;
            const pageNumber = parseInt(pageNumberStr, 10);
            if (this.pagesWithOverlays.has(pageNumber)) {
                visible.push({ el: pageElement, num: pageNumber });
            }
        }

        // Load in small batches to avoid DOM thrashing.
        const batchSize = 3;
        for (let i = 0; i < visible.length; i += batchSize) {
            const batch = visible.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(({ num }) =>
                // Phase 11 (C7): forward the captured leaf so each load uses
                // the same leaf for waitForPdfTextLayer + renderSavedOverlay.
                this.loadSavedOverlayForPage(num, false, leaf)
            ));
        }
    }

    // Phase 2 (dead-code removal): the deprecated no-op `invalidateCacheForFile`
    // method that lived here has been removed. Its body was already empty (the
    // real cache-update path is `updateCacheFromWrite`), and a grep across the
    // codebase confirmed no remaining callers. Keeping a no-op stub only added
    // confusion — readers thought there was logic worth preserving here.

    // ============================================================
    // Phase 4 (P1-33 + P1-34): public accessors for `_cachedOverlayData`
    // ============================================================
    //
    // The cache field is now private. These methods are the only sanctioned
    // external entry points for cache reads / invalidations. The writer
    // (`storage.updatePageOverlaysAndWrite`) is still the single source of
    // truth for cache *writes* — it calls `updateCacheFromWrite` internally,
    // and direct field mutation from outside this class is no longer
    // possible (compile-time enforcement).

    /**
     * Read-only access to the cached overlay. Used by storage.ts's
     * `updatePageOverlaysAndWrite` parse-failure recovery path: when the
     * on-disk translation file fails to parse but the in-memory cache has
     * a valid entry for the same pdfPath, the writer uses the cache as the
     * base for the next write instead of starting from an empty overlay.
     *
     * The `pdfPath` argument is asserted against the cache's `filePath`
     * before returning — a stale cache from a previously-active PDF must
     * never leak into a write for a different file. Returns `null` if the
     * cache is empty or the path doesn't match.
     */
    public getCachedOverlayForRecovery(pdfPath: string): SavedOverlay | null {
        const cached = this._cachedOverlayData;
        if (!cached) return null;
        if (cached.filePath !== pdfPath) return null;
        return cached;
    }

    /**
     * Invalidate a single page in the cache: drop the page's entry from
     * `_cachedOverlayData.pageOverlays` and remove the page from the
     * `loadedOverlayPages` tracking set. The next call to
     * `loadSavedOverlayForPage(N)` / `loadSavedOverlayForCurrentPage()`
     * will treat the page as not-yet-loaded and force a fresh render.
     *
     * Phase 4 (P1-34): this replaces `storage.invalidateDomCache(path,
     * pageNumber)`. The DOM-level TTL cache (`domCacheTimestamps` map in
     * storage.ts) has been removed; the renderer's tracking sets are now
     * the single source of truth for "is this page's DOM overlay fresh?".
     */
    public invalidatePage(pageNumber: number): void {
        if (this._cachedOverlayData) {
            delete this._cachedOverlayData.pageOverlays[String(pageNumber)];
            delete this._cachedOverlayData.pageOverlays[pageNumber];
        }
        this.loadedOverlayPages.delete(pageNumber);
        // Drop any in-flight load promise so a concurrent load doesn't
        // short-circuit the next forced reload (loadSavedOverlayForPage
        // would otherwise return early via the `inFlightPageLoads` chain).
        this.inFlightPageLoads.delete(pageNumber);
    }

    /**
     * Full cache reset: clear `_cachedOverlayData`, `pagesWithOverlays`,
     * and `loadedOverlayPages`. Used by `overlay-ui.ts` after a bulk
     * action (delete / retranslate) to force the next reload to read
     * fresh data from disk instead of using the (now-stale) cache.
     *
     * Replaces the old direct mutation `overlay.cachedOverlayData = null`
     * which left `pagesWithOverlays` and `loadedOverlayPages` populated
     * and could cause `loadSavedOverlayForPage` to short-circuit on
     * pages whose tracking bits hadn't been cleared.
     */
    public invalidateCache(): void {
        this._cachedOverlayData = null;
        this.loadedOverlayPages.clear();
        // Note: we deliberately do NOT clear `pagesWithOverlays` here —
        // that set drives the IntersectionObserver subscription set, and
        // clearing it would silently unsubscribe pages that still have
        // valid overlay data on disk. The next `initializeOverlayStateForPdf`
        // (called from `loadSavedOverlayForCurrentPage` when the cache is
        // null) will rebuild it from the freshly-parsed overlay.
        this.memoCache.delete('currentPage');
        this.memoCache.delete('currentTextLayer');
    }

    /**
     * Write a single page's overlay data directly into the cache. Provided
     * for completeness — the canonical write path goes through
     * `storage.updatePageOverlaysAndWrite` → `updateCacheFromWrite`, which
     * installs the FULL merged savedOverlay (not just one page). The
     * per-page `mergePage` here is intended for narrow cases where a caller
     * has only the affected page's data and wants to update the cache
     * without round-tripping through the storage layer.
     *
     * If `_cachedOverlayData` is null (PDF was open before any overlay
     * existed), a stub SavedOverlay is created so the page entry can be
     * stored. The stub's `fileName` / `filePath` are left empty — the
     * next `initializeOverlayStateForPdf` call will replace the stub
     * with the disk-parsed overlay.
     */
    public mergePage(pageNumber: number, data: OverlayPositionData[]): void {
        if (!this._cachedOverlayData) {
            this._cachedOverlayData = {
                fileName: '',
                filePath: '',
                timestamp: Date.now(),
                pageOverlays: {},
            };
        }
        this._cachedOverlayData.pageOverlays[String(pageNumber)] = data;
        this.pagesWithOverlays.add(pageNumber);
    }

    /**
     * Convenience wrapper: force-reload a single page from disk via
     * `loadSavedOverlayForPage(pageNumber, true)`. Provided so callers
     * don't have to remember the `force = true` second argument.
     */
    public reloadPage(pageNumber: number): Promise<void> {
        return this.loadSavedOverlayForPage(pageNumber, true);
    }

    public cleanupMonitoring() {
        this.pageObserver?.disconnect();
        this.pageObserver = null;
        this.zoomObserver?.disconnect();
        this.zoomObserver = null;
        this.pageIntersectionObserver?.disconnect();
        this.pageIntersectionObserver = null;

        if (this.scrollableContainer && this.scrollHandler) {
            this.scrollableContainer.removeEventListener('scroll', this.scrollHandler);
            this.scrollableContainer = null;
            this.scrollHandler = null;
        }

        // P2-66 (Phase 15): NOT removing the window-resize listener here.
        // `cleanupMonitoring` is called by `setupPDFMonitoring` whenever
        // the user switches PDFs — the resize listener needs to survive
        // PDF switches (it's bound to the OverlayRenderer instance, not to
        // any specific PDF), so its removeEventListener lives in the
        // one-shot `cleanup()` method instead. We DO cancel any in-flight
        // resize debounce here so a stale timer doesn't fire after we've
        // torn down the per-PDF observers (it would re-enter
        // `rerenderVisibleOverlays` which would no-op cleanly thanks to
        // the early-returns, but skipping it entirely is cheaper).

        // Clear all timeouts
        if (this.scrollThrottleTimeout) {
            clearTimeout(this.scrollThrottleTimeout);
            this.scrollThrottleTimeout = null;
        }
        if (this.zoomDebounceTimeout) {
            clearTimeout(this.zoomDebounceTimeout);
            this.zoomDebounceTimeout = null;
        }
        if (this.visibilityDebounceTimeout) {
            clearTimeout(this.visibilityDebounceTimeout);
            this.visibilityDebounceTimeout = null;
        }
        // P2-66 (Phase 15): cancel any in-flight resize debounce too,
        // otherwise a resize that fired just before a file switch could
        // still trigger `rerenderVisibleOverlays` against stale observers.
        if (this.resizeDebounce) {
            clearTimeout(this.resizeDebounce);
            this.resizeDebounce = null;
        }

        // Reset state tracking
        this.loadedOverlayPages.clear();
        this.isScrollSafeguardRunning = false;
        this.lastScrollCheck = 0;
        this.lastQuickCheck = 0;
    }

    public cleanup() {
        this.cleanupMonitoring();
        // P2-66 (Phase 15): remove the window-resize listener registered in
        // the constructor. `cleanup` is the one-shot teardown called on
        // plugin unload (main.ts:1352/1391). Without this removeEventListener
        // the listener would leak across plugin reload cycles and the
        // `onWindowResize` closure (which captures `this`) would keep the
        // dead OverlayRenderer alive in the window's listener list.
        window.removeEventListener('resize', this.onWindowResize);
        // The main cleanup for individual overlay elements is handled by uiRenderer
        // We don't need to iterate and call uiRenderer.cleanupOverlayElement here
        // as uiRenderer manages its own set of tracked elements.
        // We just need to tell uiRenderer to clear its state.
        this.uiRenderer.cleanup();
        this.memoCache.clear();
        this.activeLeavesCache = null;
        // tempDiv is now managed by uiRenderer, so no need to clear it here if it was only used for text extraction
        // this.tempDiv = null; // Commented out if tempDiv is only in uiRenderer

        // Reset all state
        this._cachedOverlayData = null;
        this.pagesWithOverlays.clear();
        this.loadedOverlayPages.clear();
        this.inFlightPageLoads.clear();
    }

    // Note: showContextMenu is now handled by uiRenderer and is private there
    // If the context menu logic needs to be triggered from here, it should be done
    // by calling a method on uiRenderer that receives the required context.

    // ============================================================
    // Logging Utility
    // ============================================================

    private logDebug(message: string, ...args: any[]): void {
        const prefixed = `[OverlayRenderer] ${message}`;
        if (typeof this.plugin.logDebug === 'function') {
            this.plugin.logDebug(prefixed, ...args);
        } else if (this.plugin.settings?.debugMode) {
            console.log(prefixed, ...args);
        }
    }
}
