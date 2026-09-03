// main.ts
import { Plugin, TFile, normalizePath, App, Notice, debounce, Platform, Modal, Debouncer } from 'obsidian';
import OpenRouterSettingsTab from './settings';
import { OpenRouterTranslatorSettings, DEFAULT_SETTINGS, OverlayPositionData } from './types';
// Initialise i18n strings for the new provider-registry UI (X-7).
import { initI18n } from './i18n-strings';
import { t } from './i18n';
// CSS for the Progressive Disclosure settings UI.
import { SETTINGS_UI_CSS } from './settings-ui.css';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Stamped on
// every originals-only layout overlay (createLayoutFileWithOriginals) so the
// .translations.md file produced by "Create layout file" command has stable
// ids from the very first write — when the worker later replaces these
// placeholders with real translations, merge-by-id-first can supersede each
// entry instead of falling back to rect-overlap (which would resurrect
// deleted placeholders on sparse pages).
import { generateOverlayId } from './overlay-id';

// Modular classes
import { TranslationStorage } from './storage';
import { OverlayRenderer } from './overlay';
import { TranslationEngine } from './translation';
import { TextProcessor } from './processing';
import { TranslateMultiplePagesModal } from './modal';
import { SingletonModal } from './modal-base';
import { RegionReprocessor } from './reprocessor';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { PdfExportService } from './pdf-export';
import { LayoutParserDebugModule } from './layout-parser-debug';
import { LayoutSettings, defaultLayoutSettings } from './layout-modal';
import {
    readPdfSourceFromCache, readPdfSourceRaw, resolvePdfFromSource,
    setPdfSourceInFrontmatter,
} from './pdf-source';
import { OcrTextTranslator } from './ocr-text';
import { OcrRecognizeModal } from './ocr-modal';
import { PdfWatcher } from './pdf-watcher';
import { WatcherQueueModal } from './watcher-modal';
import { PdfViewerAdapter } from './pdf-dom';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfLayoutQueue } from './pdf-layout-queue';
// Phase 1: static import replaces the CommonJS `require('./providers')` call.
// `require()` is unavailable in Obsidian's mobile WebView (WKWebView on iOS,
// JSC on Android) — only Electron exposes it. A static ES import bundles the
// symbol at build time and works on every platform.
import { ALL_PROVIDER_IDS } from './providers';


export default class OpenRouterTranslatorPlugin extends Plugin {
    settings: OpenRouterTranslatorSettings;
    layoutSettings: LayoutSettings;
    storage: TranslationStorage;
    overlay: OverlayRenderer;
    translation: TranslationEngine;
    processor: TextProcessor;
    pdfDom: PdfViewerAdapter;
    watcher: PdfWatcher;
    layoutParserDebug: LayoutParserDebugModule;
    pdfExport: PdfExportService | null = null; // Nullable for mobile
    pdfLayoutService: PdfTextExtractor;
    pdfLayoutQueue: PdfLayoutQueue;

    // Fast lookup: PDF path → .translations.md file path
    public pdfToMdMap: Map<string, string> = new Map();

    // Debounced function to prevent map spamming
    private debouncedBuildMap: Debouncer<[], Promise<void>>;

    // Phase 10: debounced lifecycle handlers. Wrapping these in `debounce()`
    // (with `resetTimer=true`, matching `debouncedBuildMap`) collapses rapid
    // bursts of leaf-change / rename events into a single trailing-edge call.
    // Previously, switching tabs in quick succession fired N setup passes,
    // racing on the overlay renderer's cache and leaving stale state.
    private debouncedSetupPdfMonitoring: Debouncer<[any], void>;
    private debouncedHandlePdfRename: Debouncer<[TFile, string], void>;

    // Phase 11 (C7): tracks the path of the PDF that was active the last time
    // `active-leaf-change` fired. Updated BEFORE invoking overlay handlers so
    // they can detect "PDF actually changed" vs. "focus shifted within the
    // same PDF" without re-querying the workspace.
    private previousActivePdfPath: string | null = null;

    // Phase 16.5: locale change subscription. Obsidian doesn't emit an event
    // when the user switches UI language, so we poll `detectLocale()` on a
    // 5-second timer and re-initialise i18n if it changed. The cost is
    // negligible (~3 string reads every 5s) and the alternative (re-register
    // commands on every `css-change` event) is far noisier.
    private cachedLocale: string = 'en';
    private localeCheckInterval: number | null = null;

    // #8: paths the plugin itself just wrote, so we can ignore the resulting
    // metadataCache 'changed' event and avoid a self-triggered overlay reload.
    private recentlyWrittenPaths = new Map<string, number>();

    // Readiness gate for file-open handler after initial map build
    private resolveReady!: () => void;
    public isReady: Promise<void>;

    async onload() {
        console.log('🧩 OpenRouter PDF Translator plugin loaded');

        // ─── Locale detection ───
        // Detect Obsidian's UI language so the plugin UI matches. Priority:
        //   1. app.localeId (Obsidian's official API, e.g. "ru", "en", "zh-TW")
        //   2. moment().locale() (fallback for older Obsidian versions)
        //   3. 'en' (safe default — all keys are defined in English)
        // We map the detected locale to one of our supported locales ('en', 'ru').
        // Unsupported locales fall back to English (keys are defined in EN first).
        try {
            const detected = this.detectLocale();
            console.log(`[PDF Translator] Detected locale: "${detected}" → using "${this.mapLocale(detected)}"`);
            initI18n(this.mapLocale(detected));
        } catch (e) {
            console.warn('[PDF Translator] Locale detection failed, falling back to English:', e);
            initI18n('en');
        }

        // Inject CSS for the Progressive Disclosure settings UI (level cards,
        // preset chips, warning boxes, section groups).
        try {
            const styleEl = document.createElement('style');
            styleEl.id = 'pdf-translate-settings-ui-css';
            styleEl.textContent = SETTINGS_UI_CSS;
            document.head.appendChild(styleEl);
            this.register(() => styleEl.remove());
        } catch (e) {
            console.warn('[PDF Translator] Failed to inject settings UI CSS:', e);
        }

        await this.loadSettings();

        // Initialize Debouncer (wait 500ms after last call to run)
        this.debouncedBuildMap = debounce(async () => {
            this.logDebug("Debounced: Rebuilding PDF map...");
            await this.buildPdfTranslationMap();
            await this.refreshAffectedOverlays();
        }, 500, true);

        // Phase 10: debounced lifecycle handlers. The third arg `true` is
        // `resetTimer` — every subsequent call within the window resets the
        // wait, so a burst of N leaf-changes collapses into one trailing
        // invocation (matches `debouncedBuildMap` above).
        this.debouncedSetupPdfMonitoring = debounce((leaf: any) => {
            this.overlay.setupPDFMonitoring(leaf);
            void this.layoutParserDebug.onActiveLeafChange(leaf);
        }, 300, true);

        this.debouncedHandlePdfRename = debounce(async (mdFile: TFile, newMdPath: string) => {
            try {
                await this.app.vault.rename(mdFile, newMdPath);
            } catch (e) { console.error(e); }
            finally { this.debouncedBuildMap(); }
        }, 200, true);

        // Phase 16.5: cache the detected locale so we can detect changes later.
        // `cachedLocale` is the locale we last used to call `initI18n()`; if
        // `detectLocale()` ever diverges from it (user changed Obsidian's UI
        // language in Settings) we re-init i18n and re-register commands.
        this.cachedLocale = this.mapLocale(this.detectLocale());
        this.localeCheckInterval = window.setInterval(() => {
            const current = this.mapLocale(this.detectLocale());
            if (current !== this.cachedLocale) {
                this.cachedLocale = current;
                this.logDebug(`Locale changed → "${current}". Re-initialising i18n.`);
                try { initI18n(current); } catch (e) { console.warn('[PDF Translator] i18n re-init failed:', e); }
                // Re-register commands so their display names pick up the new
                // locale. Obsidian's `addCommand` with the same id replaces
                // the existing entry (verified in Obsidian API docs).
                try { this.registerCommands(); } catch (e) { console.warn('[PDF Translator] command re-register failed:', e); }
            }
        }, 5000);

        // Ready promise
        this.isReady = new Promise(resolve => {
            this.resolveReady = resolve;
        });

        // Initialize services
        this.pdfDom = new PdfViewerAdapter(this.app);
        this.translation = new TranslationEngine(this);
        this.overlay = new OverlayRenderer(this);
        this.processor = new TextProcessor(this);
        this.storage = new TranslationStorage(this);
        this.watcher = new PdfWatcher(this);
        this.layoutParserDebug = new LayoutParserDebugModule(this);

        // Background layout detection (pdfjs-dist, main thread)
        // Uses PdfTextExtractor (fake-worker mode) instead of the old
        // PdfLayoutService (Web Worker) which broke on Obsidian ≥1.5 due
        // to cross-origin restrictions on plugin resource URLs.
        this.pdfLayoutService = new PdfTextExtractor(this);
        this.pdfLayoutQueue = new PdfLayoutQueue(this, this.pdfLayoutService);

        // Phase 10: cleanup of `pdfLayoutService` / `pdfLayoutQueue` happens
        // explicitly in `onunload()` (see lines further down). We deliberately
        // do NOT also register them via `this.register(...)` here — that would
        // cause a double-free (Obsidian calls registered callbacks AND
        // `onunload` on shutdown, so `dispose()` would run twice and the
        // second call would touch already-freed timers / workers).

        // Only initialize PDF export on desktop platforms
        if (Platform.isDesktop && !Platform.isMobile) {
            try {
                this.pdfExport = new PdfExportService(this);
            } catch (error) {
                console.error('[PDF Export] Failed to initialize:', error);
                this.pdfExport = null;
            }
        }

        // ======= Initialization for Cold and Warm Starts =======

        this.app.workspace.onLayoutReady(async () => {
            // FIX: Build map ONLY when layout (and cache) is ready
            this.logDebug("Layout ready. Building initial translation map...");
            await this.buildPdfTranslationMap();
            this.resolveReady();
            this.watcher.start();

            await this.isReady;
            const activeLeaf = this.app.workspace.activeLeaf;
            if (activeLeaf && activeLeaf.view.getViewType() === 'pdf') {
                this.overlay.setupPDFMonitoring(activeLeaf);
                await this.refreshAffectedOverlays();
                await this.layoutParserDebug.onActiveLeafChange(activeLeaf);
            }
        });

        // ======= CACHE EVENTS (The Fix) =======

        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            // Only rebuild if a translation file changed its metadata/content
            if (!this.isTranslationFile(file)) return;
            // FIX B1 (revised): self-writes are handled DIRECTLY by
            // updatePageOverlaysAndWrite, which updates cachedOverlayData
            // in-place after writing. So we DON'T need to invalidate the
            // cache here — doing so would clear pagesWithOverlays and
            // prevent ensurePageOverlayLoaded from loading any page.
            //
            // The previous approach (invalidateCacheForFile on self-write)
            // caused a regression: it cleared ALL renderer state but never
            // re-initialized it (debouncedBuildMap was skipped for self-writes),
            // leaving the user with no overlays on any page they hadn't
            // already scrolled past.
            if (this.isSelfWrite(file.path)) {
                this.logDebug(`Ignoring self-write for ${file.path} (cache updated by writer).`);
                return;
            }
            this.logDebug(`Translation file changed: ${file.path}. Rebuilding map.`);
            this.debouncedBuildMap();
        }));

        // ======= File System Events (Renames/Deletes) =======
        
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (!(file instanceof TFile)) return;

            // 1. If a PDF was renamed, we might need to update the translation file name
            if (file.extension === 'pdf') {
                const mdPath = this.pdfToMdMap.get(oldPath);
                if (mdPath) {
                    // Phase 10: was `setTimeout(async () => { ... }, 200)`.
                    // Replaced with `debouncedHandlePdfRename` so rapid renames
                    // (e.g. sync app re-renaming a file several times in a row)
                    // collapse into a single trailing-edge write.
                    try {
                        const mdFile = this.app.vault.getAbstractFileByPath(mdPath);
                        if (mdFile instanceof TFile) {
                            const newMdPath = this.storage.getTranslationFilePath(file);
                            if (normalizePath(mdFile.path) !== normalizePath(newMdPath)) {
                                this.debouncedHandlePdfRename(mdFile, newMdPath);
                            }
                        }
                    } catch (e) { console.error(e); }
                }
            } 
            // 2. If a Translation file was renamed, just rebuild the map
            else if (this.isTranslationFile(file)) {
                const oldPdfPath = [...this.pdfToMdMap.entries()].find(([_, md]) => md === oldPath)?.[0];
                if (oldPdfPath) this.pdfToMdMap.delete(oldPdfPath);
                this.debouncedBuildMap();
            }
        }));

        this.registerEvent(this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile && this.isTranslationFile(file)) {
                const oldPdfPath = [...this.pdfToMdMap.entries()].find(([_, mdPath]) => mdPath === file.path)?.[0];
                if (oldPdfPath) this.pdfToMdMap.delete(oldPdfPath);
                this.debouncedBuildMap();
            }
        }));

        // Phase 16.5: command registration extracted into a method so the
        // locale-change poll can re-invoke it (Obsidian's `addCommand` with
        // the same id replaces the previous entry, so hotkeys survive).
        this.registerCommands();

        // ======= Event Listeners =======

        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && leaf.view.getViewType() === 'pdf') {
                // FIX (stale overlay on new PDF): IMMEDIATELY clear the overlay
                // renderer's cache and remove all DOM overlays when switching
                // to a different PDF. Without this, the old PDF's overlays
                // would remain visible on the new PDF for ~300ms (until
                // setupPDFMonitoring runs), causing the "previous translation
                // appears on new file" bug.
                //
                // The 300ms delay below is for setupPDFMonitoring only — it
                // waits for the PDF viewer to render. But cache cleanup must
                // happen synchronously to prevent the stale data from being
                // used by scroll/IO handlers during that window.
                //
                // Phase 11 (C7): `previousActivePdfPath` is the instance-level
                // record of the last PDF we showed overlays for. We capture
                // the OLD value (so the diff below works) and update the field
                // BEFORE invoking overlay handlers — that way handlers called
                // later in this listener (and any debounced follow-ups) see a
                // consistent view of "what PDF are we on now".
                const newFile = (leaf.view as any)?.file as TFile | undefined;
                const newFilePath = newFile?.path ?? null;
                const previousFilePath = this.previousActivePdfPath;
                this.previousActivePdfPath = newFilePath;

                if (newFile && (!previousFilePath || previousFilePath !== newFilePath)) {
                    this.logDebug(
                        `active-leaf-change: switching from ` +
                        `"${previousFilePath ?? 'none'}" to "${newFilePath}" — clearing overlay cache immediately.`
                    );
                    // Clear all DOM overlays from ALL leaves (the old PDF's
                    // overlays might be in a different leaf that's still open).
                    this.clearAllOverlays();
                    // Reset the renderer's in-memory state so no stale data
                    // is used during the 300ms window before setupPDFMonitoring.
                    if (this.overlay) {
                        this.overlay.resetStateForNewFile();
                    }
                }

                // Phase 10: was `setTimeout(() => { ... }, 300)`. Replaced
                // with `debouncedSetupPdfMonitoring` so a rapid sequence of
                // leaf changes (user tabbing through several PDFs) collapses
                // into a single `setupPDFMonitoring` call on the last leaf —
                // previous leaves never get monitored (avoids stale watchers).
                this.debouncedSetupPdfMonitoring(leaf);
            } else {
                // FIX (v5.1): do NOT clear overlays when the user clicks on a
                // side tab (file explorer, search, etc.). The PDF is still
                // open in its leaf — only the ACTIVE focus changed.
                //
                // Previously, any non-PDF leaf-change would call
                // clearAllOverlays() + resetStateForNewFile(), which made all
                // overlays disappear as soon as the user clicked anywhere
                // outside the PDF viewer. The overlays should remain visible
                // as long as the PDF is open, regardless of which pane has focus.
                //
                // Only reset state if there are NO PDF leaves open at all
                // (user closed the PDF).
                const pdfLeaves = this.app.workspace.getLeavesOfType('pdf');
                if (pdfLeaves.length === 0) {
                    this.logDebug('active-leaf-change: no PDF leaves open — clearing overlay state.');
                    this.clearAllOverlays();
                    if (this.overlay) {
                        this.overlay.resetStateForNewFile();
                    }
                    // Phase 11 (C7): no PDF leaves left — forget the cached path
                    // so the next open is treated as a real "file changed".
                    this.previousActivePdfPath = null;
                }
                void this.layoutParserDebug.onActiveLeafChange(leaf);
            }
        }));

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile && file.extension === 'pdf') {
                    this.overlay.addOverlayToggleToPDFMenu(menu, file);
                }
            })
        );

        this.addSettingTab(new OpenRouterSettingsTab(this.app, this));
    }

    /**
     * Phase 16.5: register all plugin commands. Extracted from onload() so the
     * locale-change poll can re-invoke it to refresh command display names in
     * the user's new UI language. Obsidian's `addCommand` with the same id
     * replaces the existing entry — hotkey assignments are preserved.
     */
    private registerCommands(): void {
        // ======= Standard Commands =======
        
        this.addCommand({
            id: 'rebuild-pdf-translation-map',
            name: this.tCmd('rebuild-pdf-translation-map', 'Rebuild PDF-to-translation file map'),
            callback: async () => {
                new Notice('Rebuilding map...');
                await this.buildPdfTranslationMap();
                await this.refreshAffectedOverlays();
                new Notice('Map rebuilt.');
            }
        });

        this.addCommand({
            id: 'clean-unused-translations',
            name: this.tCmd('clean-unused-translations', 'Clean unused translation files...'),
            callback: async () => {
                new Notice('Scanning for orphaned translations...');
                const orphans = await this.storage.findOrphanedTranslations();
                if (orphans.length === 0) {
                    new Notice('No unused translation files found.');
                    return;
                }
                new CleanTranslationsModal(this.app, this, orphans).open();
            }
        });

        this.addCommand({
            id: 'translate-multiple-pages',
            name: this.tCmd('translate-multiple-pages', 'Translate multiple pages...'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'pdf') {
                    new TranslateMultiplePagesModal(this, file).open();
                } else {
                    new Notice('Please open a PDF first.');
                }
            }
        });

        // ======= Layout & Preset Commands =======

        // REMOVED (v5 cleanup): legacy layout-detector commands that no longer
        // apply to the overhauled worker pipeline:
        //   - 'adjust-layout-settings' (Adjust Layout Detector Settings...)
        //   - 'quick-switch-layout-preset' (Layout: Quick switch preset...)
        //   - 'load-layout-preset-${id}' (Layout Preset: Load "${name}")
        // The contour-pipeline layout settings (profileRegionFlowCostBias etc.)
        // are not used by PdfTextExtractor.extractPage — they only affected the
        // legacy DOM-based LayoutDetector. Layout presets from past versions
        // are also irrelevant. The worker uses fixed, well-tuned defaults.

        // ======= Overlay Commands =======

        this.addCommand({
            id: 'add-pdf-text-overlay',
            name: this.tCmd('add-pdf-text-overlay', 'Translate and add overlay to current PDF page'),
            callback: () => this.processor.addTextOverlay(),
        });

        this.addCommand({
            id: 'save-pdf-overlay',
            name: this.tCmd('save-pdf-overlay', 'Save current PDF overlay'),
            // Phase 3 (P0-2 partial): re-pointed from `this.storage.saveCurrentOverlay()`
            // (deleted in this phase — see storage.ts Phase 3 notes) to the
            // canonical overlay-side `saveCurrentPageOverlayForPage(pageElement)`.
            // This matches the path used by the rAF callback in processing.ts
            // after a live translation, so the command-palette save and the
            // post-translation save now share the same writer (and the same
            // `writingPromises[pdfFile.path]` lock key via
            // `updatePageOverlaysAndWrite`).
            callback: async () => {
                const pageElement = this.overlay.getCurrentPageElement();
                if (!pageElement) {
                    new Notice('No active PDF page to save.');
                    return;
                }
                await this.overlay.saveCurrentPageOverlayForPage(pageElement);
            },
        });

        this.addCommand({
            id: 'refresh-pdf-overlay',
            name: this.tCmd('refresh-pdf-overlay', 'Refresh current PDF overlay'),
            callback: () => this.overlay.refreshCurrentOverlay(),
        });

        this.addCommand({
            id: 'clear-pdf-overlay',
            name: this.tCmd('clear-pdf-overlay', 'Clear current PDF overlay'),
            callback: () => this.overlay.clearCurrentOverlay(),
        });

        this.addCommand({
            id: 'reprocess-text-region',
            name: this.tCmd('reprocess-text-region', 'Reprocess/retranslate a text region...'),
            callback: async () => {
                const reprocessor = new RegionReprocessor(this);
                reprocessor.start();
            }
        });

        this.addCommand({
            id: 'retranslate-using-overlays',
            name: this.tCmd('retranslate-using-overlays', 'Retranslate using saved overlay layout...'),
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'pdf') {
                    new RetranslateUsingOverlaysModal(this.app, this, file).open();
                } else {
                    new Notice('Please open a PDF first.');
                }
            }
        });

        this.addCommand({
            id: 'toggle-pdf-overlay',
            name: this.tCmd('toggle-pdf-overlay', 'Toggle PDF overlay visibility'),
            // P1-20: toggleOverlayVisibility is now async (Variant 4) — it
            // walks all visible pages and loads/hides overlays as needed.
            // Fire-and-forget; errors are caught inside the method.
            callback: () => { void this.overlay.toggleOverlayVisibility(); },
        });

        // #0: one-time migration / repair of pdf-source links (fixes apostrophe files).
        this.addCommand({
            id: 'repair-translation-links',
            name: this.tCmd('repair-translation-links', 'Repair translation links (pdf-source frontmatter)'),
            callback: () => this.repairAllTranslationLinks(),
        });

        // FIX: Repair translation file — re-parses the .translations.md file
        // for the active PDF with the fixed parser (which rebuckets overlays
        // by metadata.page), then rewrites it to disk in the canonical format
        // (with <!-- empty --> markers, sorted pages, correct bucketing).
        //
        // Use this on files that were corrupted by the v1 parser bug — it
        // eliminates cross-page bucket contamination and writes a clean file.
        this.addCommand({
            id: 'repair-translation-file',
            name: this.tCmd('repair-translation-file', 'Repair translation file (re-parse + re-write)'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'pdf') {
                    new Notice('Open a PDF first.');
                    return;
                }
                const translationFile = await this.storage.findTranslationFileForPdf(file);
                if (!translationFile) {
                    new Notice(`No .translations.md found for "${file.basename}".`);
                    return;
                }
                try {
                    const content = await this.app.vault.read(translationFile);
                    const parsed = this.storage.parseMarkdownOverlay(content, file);
                    if (!parsed) {
                        new Notice('Could not parse translation file (malformed).');
                        return;
                    }
                    const totalPages = Object.keys(parsed.pageOverlays).length;
                    let totalOverlays = 0;
                    for (const items of Object.values(parsed.pageOverlays)) {
                        totalOverlays += items?.length ?? 0;
                    }
                    // Rewrite via updatePageOverlaysAndWrite (read-modify-write
                    // with the fixed parser + canonical writer). This will
                    // emit the clean format with <!-- empty --> markers and
                    // correct bucketing.
                    await this.storage.updatePageOverlaysAndWrite(
                        file,
                        parsed.pageOverlays as Record<number, OverlayPositionData[]>,
                    );
                    new Notice(
                        `✓ Repaired "${file.basename}": ${totalPages} pages, ${totalOverlays} overlays. ` +
                        `Check console for any "Recovery:" warnings (re-bucketed overlays).`,
                        8000,
                    );
                    // Force the renderer to re-read the cleaned file.
                    await this.overlay.refreshOverlayStateForCurrentPdf();
                } catch (err: any) {
                    console.error('[repair-translation-file] failed:', err);
                    new Notice(`Repair failed: ${err?.message ?? err}`, 8000);
                }
            },
        });

        // #4 (delivery): Python script installation lives in Settings → Layout Engine
        // (user-initiated button), not a command.

        // OCR engine: recognize scanned/image PDFs into a translated note.
        this.addCommand({
            id: 'ocr-recognize-document',
            name: this.tCmd('ocr-recognize-document', 'OCR: recognize PDF to translated note (choose pages)…'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'pdf') { new Notice('Open a PDF first.'); return; }
                new OcrRecognizeModal(this.app, this, file).open();
            },
        });

        this.addCommand({
            id: 'ocr-recognize-current-page',
            name: this.tCmd('ocr-recognize-current-page', 'OCR: recognize current page to translated note'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'pdf') { new Notice('Open a PDF first.'); return; }
                await new OcrTextTranslator(this).recognizeCurrentPage(file);
            },
        });

        this.addCommand({
            id: 'open-watcher-queue',
            name: this.tCmd('open-watcher-queue', 'Background translation: open watched-folder queue'),
            callback: () => new WatcherQueueModal(this.app, this).open(),
        });

        // REMOVED (v5 cleanup): 'extract-layout-current-page' command.
        // It was a duplicate of the background enrichment that
        // processing.ts already triggers automatically on cache miss.
        // The 'extract-layout-current-pdf' command below covers the
        // explicit "translate this whole PDF" use case.

        this.addCommand({
            id: 'extract-layout-current-pdf',
            name: this.tCmd('extract-layout-current-pdf', 'Layout: extract entire PDF (background)'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'pdf') {
                    new Notice('Open a PDF file first.');
                    return;
                }
                try {
                    const count = await this.pdfLayoutQueue.enqueuePdf(file);
                    if (count > 0) {
                        new Notice(`${count} page(s) queued for background extraction + translation.`);
                    } else {
                        new Notice('All pages already cached. Delete .translations.md to re-extract.', 5000);
                    }
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    console.error('[Layout Extract] enqueuePdf failed:', err);
                    new Notice(`Background extraction failed: ${msg}`, 8000);
                }
            },
        });

        // Create layout file: extracts original text from PDF and creates a
        // .translations.md file with ORIGINAL text as placeholder translations.
        // The file is marked `originals-only: true` in frontmatter so the
        // background queue knows to re-translate (not skip as "already cached").
        //
        // Use cases:
        //   - Prepare a file for backdoor translation (extract → edit in chat → import)
        //   - Pre-populate layout so the user can see bboxes before translation
        //   - Recover layout after a corrupt file was deleted
        this.addCommand({
            id: 'create-layout-file',
            name: this.tCmd('create-layout-file', 'Layout: create file with originals (no translation)'),
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== 'pdf') {
                    new Notice('Open a PDF file first.');
                    return;
                }
                await this.createLayoutFileWithOriginals(file);
            },
        });

        this.addCommand({
            id: 'toggle-bbox-edit-mode',
            name: this.tCmd('toggle-bbox-edit-mode', 'Toggle BBox Edit Mode'),
            callback: async () => {
                this.settings.bboxEditMode = !this.settings.bboxEditMode;
                await this.saveSettings();
                // P1-17 (Phase 14): attach/detach marquee listeners lazily
                // so they only fire while BBox edit mode is active. Without
                // this, the listeners (registered on the document) would
                // fire on every mousedown/mousemove/mouseup even when the
                // user is just reading the PDF.
                try {
                    if (this.settings.bboxEditMode) {
                        this.overlay?.attachMarqueeListeners?.();
                    } else {
                        this.overlay?.detachMarqueeListeners?.();
                    }
                } catch (e) {
                    console.error('[toggle-bbox-edit-mode] marquee listener attach/detach failed:', e);
                }
                // FIX (bbox race): pause/resume the background queue while the
                // user is editing overlays. Without this, the worker could
                // write a page mid-edit and clobber the user's manual changes
                // via the read-modify-write merge in updatePageOverlaysAndWrite.
                if (this.pdfLayoutQueue) {
                    if (this.settings.bboxEditMode) {
                        this.pdfLayoutQueue.cancel();
                        new Notice(
                            `BBox Edit Mode enabled. Background translation paused ` +
                            `(running task will finish, no new tasks start).`,
                            4000,
                        );
                    } else {
                        this.pdfLayoutQueue.resume();
                        new Notice(
                            `BBox Edit Mode disabled. Background translation resumed.`,
                            3000,
                        );
                    }
                } else {
                    new Notice(`BBox Edit Mode ${this.settings.bboxEditMode ? 'enabled' : 'disabled'}.`);
                }
            }
        });

        // REMOVED (v5 cleanup): 'toggle-layout-parser-debug-mode' command.
        // It was a duplicate of the 'layoutDebugMode' toggle in
        // Settings → Advanced / Debug. Users who need it can toggle it there.

        // ======= PDF Export Command (Desktop Only) =======

        if (this.pdfExport) {
            this.addCommand({
                id: 'export-full-pdf',
                name: this.tCmd('export-full-pdf', 'Export PDF with translations'),
                callback: () => this.pdfExport?.exportFullPdf()
            });
        }

    }


    private isTranslationFile(file: any): boolean {
        return file instanceof TFile && 
               file.extension === 'md' && 
               file.name.endsWith('.translations.md');
    }

    // #8: record a path the plugin is about to write, so the metadataCache
    // 'changed' event it produces doesn't trigger a self-reload of the overlay.
    public markSelfWrite(path: string, ttlMs = 2500): void {
        this.recentlyWrittenPaths.set(path, Date.now() + ttlMs);
    }
    private isSelfWrite(path: string): boolean {
        const exp = this.recentlyWrittenPaths.get(path);
        if (exp === undefined) return false;
        if (Date.now() > exp) { this.recentlyWrittenPaths.delete(path); return false; }
        return true;
    }

    async activateLayoutSettings(newSettings: LayoutSettings, presetName: string | null) {
        this.layoutSettings = newSettings;
        await this.saveSettings();
        if (this.processor) {
            this.processor.updateLayoutDetectorSettings(newSettings);
        }
        if (presetName) {
            new Notice(`Layout preset loaded: "${presetName}"`);
        } else if (presetName === null) {
            new Notice('Layout settings saved.');
        }
    }

    /**
     * Create a .translations.md file with ORIGINAL text as placeholder
     * translations. The file is marked `originals-only: true` in frontmatter
     * so the background queue knows to re-translate (not skip as "cached").
     *
     * Uses PdfTextExtractor (same as the worker) for consistency — the
     * extracted paragraphs will have the same bboxes as a full background
     * translation would produce.
     *
     * After creation, the file can be:
     *   - Opened in Obsidian to see the layout (bboxes show original text)
     *   - Edited externally (e.g. paste into Claude/ChatGPT for backdoor translation)
     *   - Used as a starting point for the background queue (which will overwrite
     *     the originals with real translations, clearing the originals-only flag)
     */
    async createLayoutFileWithOriginals(file: TFile): Promise<void> {
        const extractor = this.pdfLayoutService;
        if (!extractor) {
            new Notice('Layout extractor unavailable.', 5000);
            return;
        }

        let totalPages: number;
        try {
            totalPages = await extractor.getPageCount(file);
        } catch (err: any) {
            new Notice(`Could not read PDF: ${err?.message ?? err}`, 8000);
            return;
        }

        new Notice(`Extracting layout from ${file.basename} (${totalPages} pages)...`, 3000);

        const pageOverlays: Record<number, OverlayPositionData[]> = {};
        let totalOverlays = 0;
        let lastNoticeAt = Date.now();

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            try {
                const result = await extractor.extractPage(file, pageNum);
                const overlays: OverlayPositionData[] = [];
                for (const p of result.paragraphs) {
                    const text = (p.text || '').trim();
                    if (!text) continue;  // skip empty paragraphs (Fix C4)
                    overlays.push({
                        selector: '',
                        textContent: p.text,
                        relativeRect: p.relativeRect,
                        page: p.page,
                        // Phase 15.3: use original text verbatim as the
                        // placeholder translation. Previously this was
                        // prefixed with `[ORIGINAL] ` — but that marker
                        // leaked into user-visible overlay text and was
                        // never stripped on real translation, so the first
                        // page of a backdoor-translated file would show
                        // "[ORIGINAL] Foo bar" instead of "Foo bar". The
                        // `originals-only: true` frontmatter flag (set
                        // further down) is the real signal to the worker
                        // that these are placeholders, not a text prefix.
                        translatedText: p.text,
                        fontSize: p.fontSize,
                        fontFamily: p.fontFamily,
                        originalFontSizes: p.originalFontSizes,
                        // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
                        // The originals-only file thus has stable ids from creation; when
                        // the worker later writes real translations for these paragraphs
                        // (via pdf-layout-queue.ts buildOverlayData, which uses the same
                        // generateOverlayId inputs), merge-by-id-first supersedes each
                        // placeholder exactly — no orphaned placeholders survive.
                        id: generateOverlayId(p.page, p.relativeRect, p.text || ''),
                        // Phase 8 (V4 Schema): sentinel engine stamp. The
                        // originals-only file contains placeholders (raw
                        // source text), not translations — so the file-level
                        // engine is `'originals-only'` rather than a real
                        // provider/model. This sentinel is consumed by the
                        // V4 parser (which propagates it back to SavedOverlay.engine)
                        // and is visible in frontmatter. When the worker
                        // re-translates the page (via pdf-layout-queue.ts
                        // buildOverlayData), the new overlay's `engine` is
                        // stamped with the live provider/model, replacing
                        // the sentinel on a per-overlay basis.
                        engine: 'originals-only',
                    });
                }
                if (overlays.length > 0) {
                    pageOverlays[pageNum] = overlays;
                    totalOverlays += overlays.length;
                }
            } catch (err: any) {
                console.error(`[createLayoutFile] page ${pageNum} failed:`, err);
            }

            // Throttle notices
            const now = Date.now();
            if (now - lastNoticeAt > 1500) {
                lastNoticeAt = now;
                new Notice(`Extracting: ${pageNum}/${totalPages} pages...`, 1500);
            }

            // Yield to event loop so UI can repaint
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }

        if (totalOverlays === 0) {
            new Notice('No text found in PDF (might be scanned — use OCR).', 8000);
            return;
        }

        // Phase 4 (P0-10): write through the canonical writer instead of
        // bypassing it with raw `vault.modify` / `vault.create`. Previously
        // this command set the `originals-only: true` frontmatter flag by
        // post-injecting it via a fragile regex on the generated markdown
        // (see audit 09 §4 / P0-10). That bypass skipped the per-file
        // `writingPromises` lock and the `markSelfWrite` self-write
        // suppression fold from Phase 2, so:
        //   1. It could race with a concurrent `updatePageOverlaysAndWrite`
        //      for the same PDF (no lock acquired).
        //   2. It always triggered a spurious `debouncedBuildMap()` rebuild
        //      via `metadataCache.on('changed')` (no self-write suppression).
        //   3. The regex injection silently broke if the `format-version: 3`
        //      line format ever changed (audit 10 finding I-7).
        // Going through `updatePageOverlaysAndWrite({ originalsOnly: true })`
        // fixes all three: it acquires the lock, routes through `atomicWrite`
        // (which `markSelfWrite`s internally per Phase 2), and emits the
        // `originals-only: true` flag via `generateMarkdownForOverlay`'s
        // `opts` parameter (deterministic, no regex).
        try {
            await this.storage.updatePageOverlaysAndWrite(file, pageOverlays, {
                originalsOnly: true,
            });
        } catch (err: any) {
            new Notice(`Failed to write file: ${err?.message ?? err}`, 8000);
            return;
        }

        new Notice(
            `✓ Layout file created: ${totalPages} pages, ${totalOverlays} blocks.\n` +
            `Marked as originals-only — background queue will re-translate.\n` +
            `Open ${file.name}.translations.md to edit or use for backdoor translation.`,
            8000,
        );

        // Refresh the overlay renderer so it picks up the new file.
        // (Note: `updatePageOverlaysAndWrite` already calls
        // `overlay.updateCacheFromWrite` internally, but the renderer's
        // `cachedOverlayData` may have been null before this write — in
        // which case `updateCacheFromWrite` did the FIX B5 force-load path
        // already. We still call `refreshOverlayStateForCurrentPdf` here to
        // re-init `pagesWithOverlays` from the freshly-parsed overlay, which
        // is what the original code did.)
        if (this.overlay) {
            await this.overlay.refreshOverlayStateForCurrentPdf();
        }
    }

    // === Helper: Build Map ===
    async buildPdfTranslationMap() {
        this.pdfToMdMap.clear();
        let mdFiles = this.app.vault.getMarkdownFiles();

        if (this.settings.storageLocation) {
            mdFiles = mdFiles.filter(file => file.path.startsWith(this.settings.storageLocation));
        }

        let count = 0;
        for (const mdFile of mdFiles) {
            if (!mdFile.name.endsWith('.translations.md')) continue;

            // Prefer parsed cache; recover apostrophe-broken files from raw text (#0).
            let linkPath = readPdfSourceFromCache(this.app, mdFile);
            if (!linkPath) {
                const content = await this.app.vault.cachedRead(mdFile);
                linkPath = readPdfSourceRaw(content);
            }
            if (!linkPath) continue;

            const resolved = resolvePdfFromSource(this.app, linkPath, mdFile.path);
            if (resolved) {
                this.pdfToMdMap.set(resolved.path, mdFile.path);
                count++;
            }
        }
        
        this.logDebug(`Rebuilt map. Found ${count} translation files.`);
    }

    // #0: rewrite every translation note into the apostrophe-safe format,
    // recovering links from raw text for files saved with the old broken format.
    async repairAllTranslationLinks(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.name.endsWith('.translations.md') || f.name.endsWith('.translated.md'));
        let fixed = 0;
        for (const md of files) {
            const content = await this.app.vault.read(md);
            const linkPath = readPdfSourceFromCache(this.app, md) || readPdfSourceRaw(content);
            if (!linkPath) continue;
            const pdf = resolvePdfFromSource(this.app, linkPath, md.path);
            const targetPath = pdf ? pdf.path : linkPath; // keep link even if PDF missing
            const updated = setPdfSourceInFrontmatter(content, targetPath);
            if (updated !== content) {
                // Phase 2 (markSelfWrite fold): manual `markSelfWrite` call
                // removed. NOTE: this path uses raw `vault.modify` (NOT
                // `atomicWrite`). For each repaired file, `metadataCache.on('changed')`
                // will fire `debouncedBuildMap()`. The debouncer collapses the
                // burst into a single trailing call, and this same command already
                // calls `this.buildPdfTranslationMap()` at line ~904 after the
                // loop, so the extra debounced call is wasted work but not a
                // correctness issue. Phase 4 (P0-10) will route this through
                // `atomicWrite` and restore self-write suppression.
                await this.app.vault.modify(md, updated);
                fixed++;
            }
        }
        new Notice(`Repaired ${fixed} translation link(s).`);
        await this.buildPdfTranslationMap();
    }

    private async refreshAffectedOverlays() {
        await this.isReady;
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') return;

        const mdPath = this.pdfToMdMap.get(activeFile.path);
        if (mdPath) {
            this.logDebug(`Found translation for current PDF: ${mdPath}`);
            await this.overlay.loadSavedOverlayForCurrentPage(true);
        } else {
            this.logDebug(`No translation found for current PDF: ${activeFile.path}`);
        }
    }

    // ... (Rest of the class methods remain unchanged) ...
    
    async loadSettings() {
        const data = await this.loadData() || {};
        const savedSettings = data.settings || {};
        const savedProviderSettings = savedSettings.providerSettings || {};

        // Build providerSettings for EVERY registered provider. Defaults come
        // from the registry (via DEFAULT_SETTINGS.providerSettings), then any
        // saved per-provider overrides are merged on top. This means new
        // providers added to the registry are auto-available without code
        // changes here.
        const mergedProviderSettings: Record<string, any> = {};
        for (const providerId of Object.keys(DEFAULT_SETTINGS.providerSettings)) {
            mergedProviderSettings[providerId] = {
                ...DEFAULT_SETTINGS.providerSettings[providerId as keyof typeof DEFAULT_SETTINGS.providerSettings],
                ...(savedProviderSettings[providerId] || {}),
            };
        }
        // Also pick up any saved provider ids that aren't in the registry
        // (e.g. user downgraded the plugin) — preserve them so user data is
        // never silently lost.
        for (const providerId of Object.keys(savedProviderSettings)) {
            if (!mergedProviderSettings[providerId]) {
                mergedProviderSettings[providerId] = { ...(savedProviderSettings[providerId] || {}) };
            }
        }

        // Validate apiProvider/ocrProvider.provider — if the saved value is
        // no longer a registered provider (e.g. user removed a custom patch),
        // fall back to the default.
        // Phase 1: `ALL_PROVIDER_IDS` is now a static ES import (top of file).
        // Previously this was `const { ALL_PROVIDER_IDS } = require('./providers')`
        // — a CommonJS call that breaks on Obsidian mobile (WKWebView/JSC).
        const savedApiProvider = savedSettings.apiProvider;
        const apiProvider = ALL_PROVIDER_IDS.includes(savedApiProvider)
            ? savedApiProvider
            : DEFAULT_SETTINGS.apiProvider;
        const savedOcrProvider = savedSettings.ocrProvider?.provider;
        const ocrProviderId = ALL_PROVIDER_IDS.includes(savedOcrProvider)
            ? savedOcrProvider
            : DEFAULT_SETTINGS.ocrProvider.provider;

        this.settings = {
            ...DEFAULT_SETTINGS,
            ...savedSettings,
            apiProvider,
            providerSettings: mergedProviderSettings,
            ocrProvider: {
                ...DEFAULT_SETTINGS.ocrProvider,
                ...(savedSettings.ocrProvider || {}),
                provider: ocrProviderId,
            },
        };
        // Load layout settings, filtering out undefined/null/NaN values that
        // would override defaults (bug: { ...defaults, ...{ x: undefined } }
        // sets x to undefined, NOT to the default).  This happens when old
        // saved settings (pre-OCC v2) don't have the new OCC fields.
        const savedLayout = data.layoutSettings || {};
        const cleanSavedLayout: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(savedLayout)) {
            if (value !== undefined && value !== null && !(typeof value === 'number' && Number.isNaN(value))) {
                cleanSavedLayout[key] = value;
            }
        }
        this.layoutSettings = { ...defaultLayoutSettings, ...cleanSavedLayout };

        // CRITICAL: validate OCC fields — reset invalid values to defaults.
        // Old presets/custom settings may have 0 for OCC fields (from the
        // form's '0' fallback), which breaks the detector:
        //   textThresholdFactor=0 → max*0=0 → textProj<0 never true
        //   emptinessThresholdFactor=0 → gapThreshold=spanLength → need 100% empty
        //   maxHoleBins=0 → no morphological closing
        //   edgeMarginFraction=0 → no edge margin
        const occCriticalFields: Array<keyof typeof defaultLayoutSettings> = [
            'textThresholdFactor', 'emptinessThresholdFactor', 'absoluteTextThreshold',
            'crossingFactor', 'minGapSegmentPx', 'smoothRadius', 'emptinessRadius',
            'maxRecursionDepth', 'minAdjacentContentFraction', 'mergeGapPx',
            'maxVerticalGaps', 'maxHorizontalGaps', 'edgeMarginPx', 'edgeMarginFraction',
            'maxHoleBins', 'paragraphLineGapMultiplier', 'paragraphLineAlignTol',
            'minParagraphSpans', 'minVerticalGapPx', 'minHorizontalGapPx',
            // Contour pipeline — must be > 0 or pipeline breaks
            'contourCellSize', 'contourIndentThreshold', 'contourFontSizeTolerance',
            // Stage 2.2 (Q6): new exposed settings — validate on load.
            'columnGapThreshold', 'decorationThreshold', 'maxMergePasses',
        ];
        let occFixed = 0;
        for (const field of occCriticalFields) {
            const val = (this.layoutSettings as any)[field];
            const defaultVal = defaultLayoutSettings[field];
            // Reset if: undefined, null, NaN, or 0 where default is non-zero
            if (val === undefined || val === null ||
                (typeof val === 'number' && Number.isNaN(val)) ||
                (val === 0 && defaultVal !== 0)) {
                (this.layoutSettings as any)[field] = defaultVal;
                occFixed++;
            }
        }
        if (occFixed > 0 && this.settings.debugMode) {
            console.log(`[LayoutDetector] Reset ${occFixed} invalid OCC field(s) to defaults`);
        }

        // Phase 1 (C2): the PresetManager + VaultStorage adapter (~50 lines)
        // was removed. PresetManager itself is dead code (presets are not used
        // by the worker — see layout-modal.ts:481-786 removal in Phase 1.1).
        // The adapter only existed to bridge `PresetManager.init()` to the
        // plugin's per-vault `data.json`; with PresetManager gone, the bridge
        // is dead weight. `_pluginData` (line 59 of the old file) is also gone.

        // Migration: 'ocr-api' is deprecated and forced to 'internal'.
        // 'python' is preserved as a valid engine choice — bulk translation
        // and background layout extraction now work for both 'internal'
        // (via PdfTextExtractor, main thread) and 'python' (via PyMuPDF) engines.
        if ((this.settings.layoutEngine as string) === 'ocr-api') {
            this.settings.layoutEngine = 'internal';
        }

        // Phase 1: normalize overlayOpacity from legacy 0–100 scale to 0.0–1.0.
        // Old default was `99`, which was treated as `0.99` in some code paths
        // and `99` (interpreted as fully opaque) in others. Now the canonical
        // scale is 0.0–1.0; values > 1 are divided by 100 on load.
        if (typeof this.settings.overlayOpacity === 'number' && this.settings.overlayOpacity > 1) {
            this.settings.overlayOpacity = this.settings.overlayOpacity / 100;
        }
        // Clamp to valid range
        if (typeof this.settings.overlayOpacity !== 'number' || !isFinite(this.settings.overlayOpacity)) {
            this.settings.overlayOpacity = 0.95;
        } else {
            this.settings.overlayOpacity = Math.max(0.1, Math.min(1.0, this.settings.overlayOpacity));
        }

        // Phase 7: preserveSourceLineBreaks defaults to false for existing users
        // (new installations get false from DEFAULT_SETTINGS). No migration needed
        // — `undefined` is falsy and the `?? false` fallbacks in code handle it.
        if (typeof this.settings.preserveSourceLineBreaks !== 'boolean') {
            this.settings.preserveSourceLineBreaks = false;
        }

        // Background translation concurrency: default 3 for new installs.
        // Existing users without the field get 3 too (parallel = faster).
        // Clamp to 1–8 to prevent abuse (high values trigger API rate limits).
        if (typeof this.settings.backgroundTranslationConcurrency !== 'number'
            || !isFinite(this.settings.backgroundTranslationConcurrency)) {
            this.settings.backgroundTranslationConcurrency = 3;
        } else {
            this.settings.backgroundTranslationConcurrency =
                Math.max(1, Math.min(8, Math.round(this.settings.backgroundTranslationConcurrency)));
        }
        // OCR is recognize-to-note only now; retire the experimental overlay mode.
        if (this.settings.ocrProvider && (this.settings.ocrProvider.ocrOutputMode as string) === 'overlay') {
            this.settings.ocrProvider.ocrOutputMode = 'translation-note';
        }

        if (this.settings.storageLocation) {
            let trimmed = this.settings.storageLocation.trim();
            if (['/', '.', '..', ''].includes(trimmed)) {
                this.settings.storageLocation = '';
            } else {
                trimmed = normalizePath(trimmed);
                if (!trimmed.endsWith('/')) trimmed += '/';
                this.settings.storageLocation = trimmed.replace(/\/+/g, '/');
            }
        }

        // Stage 0.1 (Q17): strip 18 dead settings fields from saved data.
        // These fields were removed from the OpenRouterTranslatorSettings
        // interface (see types.ts) but old data.json files may still
        // contain them. We delete them here so they don't get re-saved
        // on the next saveSettings() call, keeping data.json clean.
        // IMPORTANT: we use `delete (this.settings as any)[field]` because
        // TypeScript correctly flags access to removed interface fields.
        const deadSettingsFields: string[] = [
            'mergeScriptPath',
            'exportOutputDirectory',
            'exportTextColor',
            'exportTextOpacity',
            'exportFontSizeScale',
            'exportAsAnnotation',
            'pdfExportScriptPath',
            'exportBackgroundColor',
            'exportBackgroundOpacity',
            'exportPreserveOriginal',
            'exportAutoOpen',
            'mergeOnStyleChange',
            'enableSemanticMerging',
            'autoRefreshOverlay',
            'useIndividualMarkdownStorage',
            'indexFilePath',
            'manualRefinementMode',
            'clickToShowMode',
        ];
        for (const field of deadSettingsFields) {
            if (field in (this.settings as any)) {
                delete (this.settings as any)[field];
            }
        }
    }

    async saveSettings() {
        // Phase 1 (C2): `_pluginData` was removed — it only existed to ferry
        // PresetManager state into `data.json`. Without PresetManager, the
        // plugin persists only `settings` + `layoutSettings`.
        await this.saveData({
            settings: this.settings,
            layoutSettings: this.layoutSettings,
        });
    }

    /**
     * Phase 9.1: typed setter for nested settings fields. Avoids the
     * `as any`-and-pray pattern scattered through the codebase, and gives
     * us a single chokepoint that calls `saveSettings()` after the write.
     *
     * Accepts either a flat key (`'apiProvider'`) or a dotted path as an
     * array (`['ocrProvider', 'model']`) for nested updates.
     */
    async setSetting(key: string | string[], value: any): Promise<void> {
        if (Array.isArray(key)) {
            let obj: any = this.settings;
            for (let i = 0; i < key.length - 1; i++) {
                obj = obj[key[i]];
            }
            obj[key[key.length - 1]] = value;
        } else {
            (this.settings as any)[key] = value;
        }
        await this.saveSettings();
    }

    getCurrentPageNumber(): number | null {
        const currentPageEl = this.pdfDom.getCurrentVisiblePage();
        if (!currentPageEl) return null;
        return this.pdfDom.getPageNumberOf(currentPageEl);
    }

    // ════════════════════════════════════════════════════════════════
    // Locale detection — auto-match Obsidian's UI language
    // ════════════════════════════════════════════════════════════════

    /**
     * Detect the user's Obsidian UI locale. Tries (in order):
     *   1. `app.localeId` — Obsidian's official API (e.g. "ru", "en", "zh-TW")
     *   2. `moment().locale()` — moment.js locale, set by Obsidian to match UI
     *   3. `window.navigator.language` — browser locale (last resort)
     * Returns a locale string like "ru", "en", "zh-CN", "de", etc.
     */
    private detectLocale(): string {
        // 1. Obsidian's official API (available on App instance since ~1.0)
        try {
            const localeId = (this.app as any).localeId;
            if (typeof localeId === 'string' && localeId.length > 0) {
                return localeId;
            }
        } catch { /* app not ready yet — fall through */ }

        // 2. moment.js locale — Obsidian sets moment's locale to match the UI
        try {
            // Obsidian bundles moment.js; it's available globally as `moment`
            // (declared in obsidian.d.ts). Some builds may not expose it,
            // so we wrap in try/catch.
            const momentFn = (window as any).moment;
            if (typeof momentFn === 'function') {
                const ml = momentFn().locale();
                if (typeof ml === 'string' && ml.length > 0) return ml;
            }
        } catch { /* moment not available — fall through */ }

        // 3. Browser language (last resort — not as reliable as Obsidian's setting)
        try {
            const navLang = (window.navigator?.language) || '';
            if (navLang.length > 0) return navLang;
        } catch { /* navigator not available */ }

        // 4. Safe default
        return 'en';
    }

    /**
     * Map a detected locale (e.g. "ru", "ru-RU", "zh-CN", "en-US") to one of
     * our supported locale codes ('en' | 'ru'). Unsupported locales fall back
     * to 'en' — all keys are defined in English first, so the UI will always
     * be readable.
     *
     * To add a new locale: add a case here + a new dictionary block in
     * i18n-strings.ts + a registerStrings() call in initI18n().
     */
    private mapLocale(detected: string): 'en' | 'ru' {
        if (!detected) return 'en';
        // Normalise: lowercase, take the primary subtag (before any '-' or '_')
        const primary = detected.toLowerCase().split(/[-_]/)[0];
        switch (primary) {
            case 'ru':
            case 'be':  // Belarusian — close enough, falls back to RU for missing keys
            case 'uk':  // Ukrainian — same
            case 'kk':  // Kazakh — same
                return 'ru';
            // English and all other languages fall back to English
            case 'en':
            default:
                return 'en';
        }
    }

    /**
     * FIX (v5): translate command names based on the active locale.
     * Command names are NOT in the i18n-strings.ts file (they were
     * hardcoded English strings). This method provides Russian
     * translations for all 19 commands when the locale is 'ru'.
     *
     * If a command ID has no translation, returns the English fallback.
     */
    private tCmd(commandId: string, englishName: string): string {
        if (this.mapLocale(this.detectLocale()) !== 'ru') return englishName;

        const ru: Record<string, string> = {
            'rebuild-pdf-translation-map': 'Перестроить карту PDF-файлов переводов',
            'clean-unused-translations': 'Очистить неиспользуемые файлы переводов...',
            'translate-multiple-pages': 'Перевести несколько страниц...',
            'add-pdf-text-overlay': 'Перевести и добавить оверлей на текущую страницу PDF',
            'save-pdf-overlay': 'Сохранить оверлей текущего PDF',
            'refresh-pdf-overlay': 'Обновить оверлей текущего PDF',
            'clear-pdf-overlay': 'Очистить оверлей текущего PDF',
            'reprocess-text-region': 'Перепроцесс/перевести область текста...',
            'retranslate-using-overlays': 'Перевести заново, используя сохранённый layout оверлеев...',
            'toggle-pdf-overlay': 'Переключить видимость оверлея PDF',
            'repair-translation-links': 'Починить ссылки переводов (frontmatter pdf-source)',
            'repair-translation-file': 'Починить файл перевода (re-parse + re-write)',
            'ocr-recognize-document': 'OCR: распознать PDF в переведённую заметку (выбор страниц)…',
            'ocr-recognize-current-page': 'OCR: распознать текущую страницу в переведённую заметку',
            'open-watcher-queue': 'Фоновый перевод: открыть очередь наблюдаемой папки',
            'extract-layout-current-pdf': 'Layout: извлечь весь PDF (в фоне)',
            'create-layout-file': 'Layout: создать файл с оригиналами (без перевода)',
            'toggle-bbox-edit-mode': 'Переключить режим редактирования BBox',
            'export-full-pdf': 'Экспорт PDF с переводами',
        };

        return ru[commandId] || englishName;
    }

    onunload() {
        console.log('🧩 OpenRouter PDF Translator plugin unloaded');
        // FIX (v5): use optional chaining on ALL services — if onload failed
        // early (e.g. import error), some services may not be initialized yet.
        // Without this, onunload crashes with "Cannot read properties of
        // undefined (reading 'cleanup')" and masks the real onload error.

        // Phase 10: cancel any pending debounced lifecycle handlers so they
        // don't fire AFTER the plugin is torn down (which would touch freed
        // services / closed DOM leaves). `?.cancel?.()` covers both the
        // Obsidian debounce helper (which exposes `.cancel()`) and the case
        // where the field wasn't initialised because onload crashed early.
        try { this.debouncedBuildMap?.cancel?.(); } catch (e) { console.error('[onunload] debouncedBuildMap.cancel failed:', e); }
        try { this.debouncedSetupPdfMonitoring?.cancel?.(); } catch (e) { console.error('[onunload] debouncedSetupPdfMonitoring.cancel failed:', e); }
        try { this.debouncedHandlePdfRename?.cancel?.(); } catch (e) { console.error('[onunload] debouncedHandlePdfRename.cancel failed:', e); }

        // Phase 16.5: stop the locale-change poll so we don't keep firing
        // `initI18n` / `registerCommands` on a half-unloaded plugin.
        if (this.localeCheckInterval !== null) {
            try { window.clearInterval(this.localeCheckInterval); } catch (e) { console.error('[onunload] clearInterval failed:', e); }
            this.localeCheckInterval = null;
        }

        try {
            this.watcher?.stop();
        } catch (e) { console.error('[onunload] watcher.stop failed:', e); }
        try {
            this.layoutParserDebug?.cleanup();
        } catch (e) { console.error('[onunload] layoutParserDebug.cleanup failed:', e); }
        try {
            this.overlay?.cleanup();
        } catch (e) { console.error('[onunload] overlay.cleanup failed:', e); }
        // Phase 10: explicit `dispose()` calls for pdfLayoutQueue /
        // pdfLayoutService. We do NOT also register these via `this.register()`
        // — that would double-dispose on shutdown (Obsidian calls registered
        // callbacks AND onunload).
        // Phase 9 (P1-4): `pdfLayoutQueue.dispose()` is now async — it awaits
        // the in-flight `processQueue()` so the current page's pending disk
        // write completes before unload. Obsidian's `onunload` is sync (void
        // return), so we cannot `await` here. Fire-and-forget with a catch
        // so: (a) the sync flag-clearing (`disposed = true`, `cancelled = true`)
        //     runs immediately, blocking new tasks from starting, (b) the
        //     async drain doesn't leak an unhandled rejection, (c) unload
        //     itself never throws. The drain typically finishes within ~1s
        //     (one page's worth of storage write); if Obsidian force-kills
        //     the process first, the in-flight page may still be lost — but
        //     that's the same failure mode as a hard crash, and FIX E1's
        //     incremental-save means all PREVIOUSLY-translated pages are
        //     already on disk.
        try {
            void this.pdfLayoutQueue?.dispose?.()?.catch?.(() => {});
        } catch (e) { console.error('[onunload] pdfLayoutQueue.dispose failed:', e); }
        try {
            this.pdfLayoutService?.dispose();
        } catch (e) { console.error('[onunload] pdfLayoutService.dispose failed:', e); }
        try {
            this.clearAllOverlays();
        } catch (e) { console.error('[onunload] clearAllOverlays failed:', e); }
        try {
            this.pdfToMdMap.clear();
        } catch (e) { console.error('[onunload] pdfToMdMap.clear failed:', e); }
    }

    clearAllOverlays() {
        // P1-7 (Phase 14): delegate to overlay.cleanup for proper listener cleanup
        // (uiRenderer.trackedOverlayElements, marquee listeners, in-flight loads,
        // memo cache, etc.). Direct .remove() on container DOM nodes leaks the
        // per-overlay event listeners + interact handles tracked by uiRenderer.
        try {
            this.overlay?.cleanup?.();
        } catch (e) {
            console.error('[clearAllOverlays] overlay.cleanup failed:', e);
        }
        // Also remove any remaining containers (defense in depth — covers
        // orphan containers from prior versions or external render paths).
        document.querySelectorAll('.pdf-text-overlay-container').forEach(el => el.remove());
    }

    getCurrentPageElement(): HTMLElement | null {
        return this.overlay.getCurrentPageElement();
    }

    logDebug(message: string, ...args: any[]): void {
        if (this.settings.debugMode) {
            console.log(`[PDF Translator] ${message}`, ...args);
        }
    }
}

// REMOVED (v5 cleanup): PresetFuzzyModal class.
// It was used by the removed 'quick-switch-layout-preset' command.
// Layout presets from past versions are no longer relevant — the worker
// uses fixed, well-tuned defaults from PdfTextExtractor.extractPage.

/**
 * Modal that displays orphaned translation files (ones whose PDF no longer exists)
 * and allows the user to selectively delete them.
 */
export class CleanTranslationsModal extends SingletonModal<CleanTranslationsModal> {
    private plugin: OpenRouterTranslatorPlugin;
    private orphans: Array<{ mdFile: TFile; pdfSource: string }>;

    constructor(
        app: App,
        plugin: OpenRouterTranslatorPlugin,
        orphans: Array<{ mdFile: TFile; pdfSource: string }>
    ) {
        super(app);
        this.plugin = plugin;
        this.orphans = orphans;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        contentEl.empty();

        // Phase 17 (F-D4-1): use titleEl instead of <h2> in body
        titleEl.setText(t('modal.clean.title'));

        contentEl.createEl('p', {
            text: t('modal.clean.found', { count: this.orphans.length })
        });

        const checkboxes: HTMLInputElement[] = [];

        // Build the list of orphaned files with checkboxes
        const listContainer = contentEl.createEl('div', {
            cls: 'clean-translations-list',
            attr: { style: 'max-height: 400px; overflow-y: auto; margin-bottom: 12px;' }
        });

        for (const orphan of this.orphans) {
            const itemEl = listContainer.createEl('div', {
                attr: {
                    style: 'display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-bottom: 1px solid var(--background-modifier-border);'
                }
            });

            const checkbox = itemEl.createEl('input', { type: 'checkbox' });
            checkbox.checked = true;
            checkbox.style.marginTop = '4px';
            checkboxes.push(checkbox);

            const labelEl = itemEl.createEl('div');

            const mdName = orphan.mdFile.name.replace('.translations.md', '');
            labelEl.createEl('strong', { text: mdName });

            labelEl.createEl('br');
            labelEl.createEl('small', {
                text: `${t('modal.clean.translationFile')}${orphan.mdFile.path}`,
                attr: { style: 'color: var(--text-muted);' }
            });
            labelEl.createEl('br');
            labelEl.createEl('small', {
                text: `${t('modal.clean.missingPdf')}${orphan.pdfSource}`,
                attr: { style: 'color: var(--text-error);' }
            });
        }

        // Select All / Deselect All buttons
        const toggleBar = contentEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px; margin-bottom: 16px;' }
        });

        const selectAllBtn = toggleBar.createEl('button', { text: t('modal.clean.selectAll') });
        const deselectAllBtn = toggleBar.createEl('button', { text: t('modal.clean.deselectAll') });

        selectAllBtn.onclick = () => checkboxes.forEach(cb => (cb.checked = true));
        deselectAllBtn.onclick = () => checkboxes.forEach(cb => (cb.checked = false));

        // Action buttons
        const actionBar = contentEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px; justify-content: flex-end;' }
        });

        const cancelBtn = actionBar.createEl('button', { text: t('modal.clean.cancel') });
        cancelBtn.onclick = () => this.close();

        const deleteBtn = actionBar.createEl('button', {
            text: t('modal.clean.deleteSelected'),
            cls: 'mod-warning'
        });

        deleteBtn.onclick = async () => {
            const toDelete = this.orphans.filter((_, i) => checkboxes[i].checked);
            if (toDelete.length === 0) {
                new Notice(t('modal.clean.noneSelected'));
                return;
            }

            // Disable buttons to prevent double-click
            deleteBtn.disabled = true;
            cancelBtn.disabled = true;
            deleteBtn.textContent = t('modal.clean.deleting');

            let deleted = 0;
            let errors = 0;

            for (const orphan of toDelete) {
                try {
                    await this.app.vault.trash(orphan.mdFile, true);
                    // Remove any stale entry from the map
                    const mapEntry = [...this.plugin.pdfToMdMap.entries()].find(
                        ([_, md]) => md === orphan.mdFile.path
                    );
                    if (mapEntry) {
                        this.plugin.pdfToMdMap.delete(mapEntry[0]);
                    }
                    deleted++;
                } catch (e) {
                    console.error('PDF Translator: Failed to delete translation file:', orphan.mdFile.path, e);
                    errors++;
                }
            }

            const msg = errors > 0
                ? t('modal.clean.deleted', { count: String(deleted), errors: String(errors) })
                : t('modal.clean.deletedSuccess', { count: String(deleted) });
            new Notice(msg);

            this.close();
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}