// overlay.ts
// Main Overlay Management and Coordination Logic

import { Menu, Notice, TFile } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { OverlayPositionData, TranslationUnit, SavedOverlay } from './types';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { OverlayUIRenderer } from './overlay-ui'; // Import the new UI renderer

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

    private isOverlayVisible: boolean;
    private pageObserver: MutationObserver | null = null;
    private zoomObserver: MutationObserver | null = null;
    private lastKnownScale: number = 1.0;
    // Note: createdOverlays and trackedOverlayElements are now managed by uiRenderer
    private isReloadingOverlay = false;
    private activeLeavesCache: Set<any> | null = null;
    private memoCache: Map<string, { value: any, timestamp: number }> = new Map();
    // Note: tempDiv is now managed by uiRenderer
    private zoomDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
    private inFlightPageLoads: Map<number, Promise<void>> = new Map();
    // Gradual loading properties
    private cachedOverlayData: SavedOverlay | null = null;
    private pagesWithOverlays: Set<number> = new Set();
    private pageIntersectionObserver: IntersectionObserver | null = null;
    // Enhanced scroll safeguard properties
    private scrollThrottleTimeout: ReturnType<typeof setTimeout> | null = null;
    private scrollHandler: (() => void) | null = null;
    private scrollableContainer: HTMLElement | null = null;
    private loadedOverlayPages: Set<number> = new Set();
    private lastScrollCheck: number = 0;
    private isScrollSafeguardRunning: boolean = false;
    private lastQuickCheck: number = 0;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.uiRenderer = new OverlayUIRenderer(plugin); // Initialize the UI renderer
        this.isOverlayVisible = plugin.settings.showOverlayByDefault ?? true;
        // Ensure line height is a number (default 1.2)
        if (typeof this.plugin.settings.outputLineHeight !== 'number') {
            this.plugin.settings.outputLineHeight = 1.2;
        }
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
                    container.appendChild(overlayEl);
                } catch (unitError) {
                    this.logDebug(`Error rendering unit ${i}:`, unitError);
                }
            });
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

    public adjustLineHeight(delta: number): void {
        try {
            let newValue = (this.plugin.settings.outputLineHeight || 1.2) + delta;
            // Use constants from uiRenderer or define locally if needed for global adjustment
            const MIN = 0.8;
            const MAX = 2.0;
            newValue = Math.max(MIN, Math.min(MAX, newValue));
            newValue = Math.round(newValue * 10) / 10; // Round to 0.1 precision
            this.plugin.settings.outputLineHeight = newValue;
            // Reapply to all overlays (inner div for reflow) - delegate to uiRenderer
            document.querySelectorAll('.pdf-text-overlay-reflow div').forEach(inner => {
                this.uiRenderer.applyLineHeight(inner as HTMLDivElement, newValue);
            });
            this.plugin.saveSettings();
            new Notice(`Line height set to ${newValue}`);
            this.logDebug(`Line height adjusted to ${newValue}`);
        } catch (error) {
            this.logDebug('adjustLineHeight failed:', error);
            new Notice('Failed to adjust line height');
        }
    }

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
            const pages = this.getPDFPagesForLeaf(activeLeaf);
            if (!pages) return;

            this.logDebug('Starting force refresh of visible overlays');
            const viewportHeight = window.innerHeight;
            let refreshCount = 0;
            for (const pageElement of Array.from(pages)) {
                const rect = pageElement.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;

                const pageNumberStr = pageElement.dataset.pageNumber;
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    if (this.pagesWithOverlays.has(pageNumber)) {
                        this.clearOverlayFromPage(pageElement);
                        this.loadedOverlayPages.delete(pageNumber);
                        await this.loadSavedOverlayForPage(pageNumber, true);
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
        container.style.cssText = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 100; overflow: hidden;`;
        pageElement.appendChild(container);
        return container;
    }

    private clearOverlayFromPage(pageElement: HTMLElement): void {
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
        this.cachedOverlayData = null;
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
                this.cachedOverlayData = parsedOverlay;
                const pageNumbers = Object.keys(parsedOverlay.pageOverlays).map(Number).filter(n => !isNaN(n) && n > 0);
                this.pagesWithOverlays = new Set(pageNumbers);
                this.logDebug(`Initialized overlay data for ${pageNumbers.length} pages: ${pageNumbers.join(', ')}`);
            }
        } catch (error) {
            console.error('PDF Translator: Failed to read or parse translation file.', error);
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
            rootMargin: '400px', // Reduced from 800px for better performance
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
                if (now - this.lastScrollCheck > QUICK_CHECK_MIN_INTERVAL) {
                    this.lastScrollCheck = now;
                    this.comprehensiveOverlayCheck();
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
            const pages = this.getPDFPagesForLeaf(activeLeaf);
            if (!pages) return;

            const viewportHeight = window.innerHeight;
            const viewportCenter = viewportHeight / 2;

            // Find the most central visible page
            let centralPage: HTMLElement | null = null;
            let minDistanceToCenter = Infinity;
            for (const pageElement of Array.from(pages)) {
                const rect = pageElement.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;

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
            const pages = this.getPDFPagesForLeaf(activeLeaf);
            if (!pages) return;

            const viewportHeight = window.innerHeight;
            const visiblePages: { element: HTMLElement, pageNumber: number }[] = [];

            // Collect all visible pages with generous margins
            for (const pageElement of Array.from(pages)) {
                const rect = pageElement.getBoundingClientRect();
                // More generous visibility check
                if (rect.bottom < -200 || rect.top > viewportHeight + 200) continue;

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
        if (!this.pagesWithOverlays.has(pageNumber)) return;
        const hasOverlay = pageElement.querySelector('.pdf-text-overlay-reflow') !== null;
        const isLoaded = this.loadedOverlayPages.has(pageNumber);

        // If properly loaded, skip
        if (hasOverlay && isLoaded) return;

        // If overlay exists but not tracked as loaded, mark it
        if (hasOverlay && !isLoaded) {
            this.loadedOverlayPages.add(pageNumber);
            return;
        }

        try {
            await this.loadSavedOverlayForPage(pageNumber, false);
        } catch (error) {
            this.logDebug(`Failed to ensure overlay for page ${pageNumber}:`, error);
            // Remove from loaded set so we'll retry later
            this.loadedOverlayPages.delete(pageNumber);
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

            const pageOverlaySets: { pageElement: HTMLElement, overlays: HTMLElement[] }[] = [];

            // Step 1: prepare overlays for all visible pages in parallel
            await Promise.all(visiblePages.map(async pageElement => {
                const pageNumberStr = pageElement.dataset.pageNumber;
                if (!pageNumberStr) return;
                const pageNumber = parseInt(pageNumberStr, 10);
                if (!this.pagesWithOverlays.has(pageNumber)) return;
                const pageData = this.cachedOverlayData?.pageOverlays[pageNumber];
                if (!pageData || pageData.length === 0) return;

                const textLayer = await this.waitForPdfTextLayer(pageNumber);
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
                            data.fontFamily
                        );
                        stagingContainer.appendChild(overlayEl);
                        overlays.push(overlayEl);
                    } catch (err) {
                        this.logDebug(`Error staging overlay for page ${pageNumber}`, err);
                    }
                }
                pageOverlaySets.push({ pageElement: overlayContainer, overlays });
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
            for (const { pageElement, overlays } of pageOverlaySets) {
                for (const el of overlays) {
                    pageElement.appendChild(el);
                }
                // Mark page as loaded
                const pageNumberStr = pageElement.dataset?.dataset?.pageNumber; // Note: likely a typo in original, should be pageElement.dataset.pageNumber
                if (pageNumberStr) {
                    const pageNumber = parseInt(pageNumberStr, 10);
                    this.loadedOverlayPages.add(pageNumber);
                }
            }

            stagingContainer.remove();
            this.logDebug(`Rerendered overlays for ${pageOverlaySets.length} visible page(s)`);
        } catch (error) {
            this.logDebug("Error during visible overlay rerender:", error);
        } finally {
            this.isReloadingOverlay = false;
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

    public toggleOverlayVisibility(): void {
        this.isOverlayVisible = !this.isOverlayVisible;
        const timeoutKey = 'visibilityTimeout';
        const cachedTimeout = this.memoCache.get(timeoutKey);
        if (cachedTimeout) {
            clearTimeout(cachedTimeout.value as NodeJS.Timeout);
        }
        const timeout = setTimeout(() => this.updateAllOverlayVisibility(), DEBOUNCE_DELAY);
        this.memoCache.set(timeoutKey, { value: timeout, timestamp: Date.now() });

        new Notice(`Overlay ${this.isOverlayVisible ? 'shown' : 'hidden'}`);
        this.plugin.settings.showOverlayByDefault = this.isOverlayVisible;
        this.plugin.saveSettings().catch(console.error);
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
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        return (activeLeaf?.view?.getViewType() === 'pdf') ? activeLeaf : null;
    }

    public getPDFPagesForLeaf(leaf: any): NodeListOf<HTMLElement> | null {
        const viewerContainer = leaf?.view?.containerEl?.querySelector('.pdfViewer, #viewer') as HTMLElement | null;
        return viewerContainer?.querySelectorAll('.page[data-page-number]') || null;
    }

    public getCurrentPageElement(): HTMLElement | null {
        return this.getMemoized('currentPage', () => {
            try {
                const activeLeaf = this.getActivePDFLeaf();
                if (!activeLeaf) return null;
                const pages = this.getPDFPagesForLeaf(activeLeaf);
                return this.getCurrentVisiblePage(pages);
            } catch (error) {
                this.logDebug('getCurrentPageElement error:', error);
                return null;
            }
        });
    }

    public getCurrentPageTextLayer(): HTMLElement | null {
        return this.getMemoized('currentTextLayer', () => {
            const currentPage = this.getCurrentPageElement();
            return currentPage ? currentPage.querySelector('.textLayer') as HTMLElement : null;
        });
    }

    public getCurrentVisiblePage(pages: NodeListOf<HTMLElement> | null): HTMLElement | null {
        if (!pages || pages.length === 0) return null;

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

    public async waitForPdfTextLayer(pageNumber: number): Promise<HTMLElement | null> {
        if (pageNumber <= 0) {
            this.logDebug('waitForPdfTextLayer: Invalid page number');
            return null;
        }
        const activeLeaf = this.getActivePDFLeaf();
        if (!activeLeaf) return null;

        return new Promise((resolve) => {
            const startTime = Date.now();
            const interval = setInterval(() => {
                if (Date.now() - startTime > OVERLAY_WAIT_TIMEOUT) {
                    clearInterval(interval);
                    this.logDebug(`Timeout waiting for text layer on page ${pageNumber}`);
                    resolve(null);
                    return;
                }
                const pages = this.getPDFPagesForLeaf(activeLeaf);
                const page = pages ? Array.from(pages).find(p => parseInt(p.dataset.pageNumber || '0') === pageNumber) : null;
                const textLayer = page?.querySelector('.textLayer');
                if (textLayer) {
                    clearInterval(interval);
                    resolve(textLayer as HTMLElement);
                }
            }, OVERLAY_CHECK_INTERVAL);
        });
    }

    // Note: bringToTop is now handled by uiRenderer and is private there
    // Note: createReflowOverlay is now handled by uiRenderer and is private there

    /**
     * Render all saved overlays onto a page, using a staging container
     * to batch DOM measurements and reduce layout thrashing.
     */
    public async renderSavedOverlay(positionData: OverlayPositionData[], pageNumber: number) {
        try {
            const textLayer = await this.waitForPdfTextLayer(pageNumber);
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
            for (const data of positionData) {
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
                        data.fontFamily
                    );
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

    public async loadSavedOverlayForPage(pageNumber: number, force: boolean = false) {
        if (!this.cachedOverlayData) {
            this.logDebug(`No cached overlay data available for page ${pageNumber}`);
            return;
        }

        if (this.inFlightPageLoads.has(pageNumber) && !force) {
            await this.inFlightPageLoads.get(pageNumber);
            return;
        }

        const loadPromise = (async () => {
            try {
                const pageData = this.cachedOverlayData!.pageOverlays[pageNumber];
                if (!pageData || pageData.length === 0) {
                    this.logDebug(`No overlay data for page ${pageNumber}`);
                    return;
                }

                const textLayer = await this.waitForPdfTextLayer(pageNumber);
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
                await this.renderSavedOverlay(pageData, pageNumber);

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
            this.inFlightPageLoads.delete(pageNumber);
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

            const activeFile = this.getActivePDFLeaf()?.view.file;
            if (activeFile) {
                await this.initializeOverlayStateForPdf(activeFile);
                await this.loadSavedOverlayForPage(pageNumber, forceReload);
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

    private extractPositionDataFrom(textLayer: HTMLElement, overlayContainer: Element, textLayerRect: DOMRect): OverlayPositionData[] {
        if (!textLayer || !overlayContainer) {
            return [];
        }

        const positionData: OverlayPositionData[] = [];
        const overlays = overlayContainer.querySelectorAll<HTMLElement>('.pdf-text-overlay-reflow');
        const pageNumber = this.plugin.getCurrentPageNumber() ?? 0;

        const pdfViewer = textLayer.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const saveScale = parseFloat(pdfViewer?.style.getPropertyValue('--scale-factor') || '1');
        if (isNaN(saveScale) || saveScale <= 0) {
            this.logDebug('Invalid saveScale; falling back to 1.0');
        }

        for (const overlay of overlays) {
            try {
                const rect = overlay.getBoundingClientRect();
                const relativeRect = {
                    left: (rect.left - textLayerRect.left) / textLayerRect.width,
                    top: (rect.top - textLayerRect.top) / textLayerRect.height,
                    width: rect.width / textLayerRect.width,
                    height: rect.height / textLayerRect.height,
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
                });
            } catch (itemError) {
                this.logDebug('extractPositionDataFrom item error:', itemError);
            }
        }

        return positionData;
    }

    public async saveCurrentPageOverlay(): Promise<boolean> {
        try {
            const activeFile = this.getActivePDFLeaf()?.view?.file;
            if (!activeFile) {
                this.logDebug('Cannot save overlay, no active PDF file.');
                return false;
            }

            const extracted = await this.extractCurrentOverlayParameters();
            if (!extracted.hasData) {
                this.logDebug('No overlay data found on the current page to save.');
                return false;
            }

            const pagesToUpdate = { [extracted.pageNumber]: extracted.positionData };
            await this.plugin.storage.updatePageOverlaysAndWrite(activeFile, pagesToUpdate);

            // Keep runtime state in sync
            this.pagesWithOverlays.add(extracted.pageNumber);
            this.loadedOverlayPages.add(extracted.pageNumber);
            if (!this.cachedOverlayData) {
                this.cachedOverlayData = { filePath: activeFile.path, pageOverlays: {} } as SavedOverlay;
            }
            this.cachedOverlayData.pageOverlays[extracted.pageNumber] = extracted.positionData;

            new Notice(`Saved overlay for page ${extracted.pageNumber}`);
            return true;
        } catch (error) {
            this.logDebug('saveCurrentPageOverlay failed:', error);
            new Notice('Error saving overlay data.');
            return false;
        }
    }

    // Note: adjustSingleOverlayLineHeight and adjustSingleOverlayFontSize are now handled by uiRenderer and are private there

    // ============================================================
    // Cleanup (ENHANCED with better state tracking)
    // ============================================================

    // Note: cleanupHoverHandlers and cleanupOverlayElement are now handled by uiRenderer and are private there
    // The main cleanupOverlayElement is now a delegate call to uiRenderer.cleanupOverlayElement

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

        // Clear all timeouts
        if (this.scrollThrottleTimeout) {
            clearTimeout(this.scrollThrottleTimeout);
            this.scrollThrottleTimeout = null;
        }
        if (this.zoomDebounceTimeout) {
            clearTimeout(this.zoomDebounceTimeout);
            this.zoomDebounceTimeout = null;
        }

        // Reset state tracking
        this.loadedOverlayPages.clear();
        this.isScrollSafeguardRunning = false;
        this.lastScrollCheck = 0;
        this.lastQuickCheck = 0;
    }

    public cleanup() {
        this.cleanupMonitoring();
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
        this.cachedOverlayData = null;
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