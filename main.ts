// main.ts
import { Plugin, TFile, normalizePath, App, Notice, Menu, FuzzySuggestModal, debounce, Platform, Modal } from 'obsidian';
import OpenRouterSettingsTab from './settings';
import { OpenRouterTranslatorSettings, DEFAULT_SETTINGS } from './types';

// Modular classes
import { TranslationStorage } from './storage';
import { OverlayRenderer } from './overlay';
import { TranslationEngine } from './translation';
import { TextProcessor } from './processing';
import { TranslateMultiplePagesModal } from './modal';
import { RegionReprocessor } from './reprocessor';
import { RetranslateUsingOverlaysModal } from './modal-retranslate';
import { PdfExportService } from './pdf-export';
import { LayoutParserDebugModule } from './layout-parser-debug';
import {
    showLayoutSettingsModal,
    LayoutSettings,
    defaultLayoutSettings,
    PresetManager,
    Preset
} from './layout-modal';

export default class OpenRouterTranslatorPlugin extends Plugin {
    settings: OpenRouterTranslatorSettings;
    layoutSettings: LayoutSettings;
    storage: TranslationStorage;
    overlay: OverlayRenderer;
    translation: TranslationEngine;
    processor: TextProcessor;
    layoutParserDebug: LayoutParserDebugModule;
    pdfExport: PdfExportService | null = null; // Nullable for mobile

    // Fast lookup: PDF path → .translations.md file path
    public pdfToMdMap: Map<string, string> = new Map();

    private overlayCleanupFunctions = new Set<() => void>();
    
    // Debounced function to prevent map spamming
    private debouncedBuildMap: () => void;

    // Readiness gate for file-open handler after initial map build
    private resolveReady!: () => void;
    public isReady: Promise<void>;

    async onload() {
        console.log('🧩 OpenRouter PDF Translator plugin loaded');

        await this.loadSettings();

        // Initialize Debouncer (wait 500ms after last call to run)
        this.debouncedBuildMap = debounce(async () => {
            this.logDebug("Debounced: Rebuilding PDF map...");
            await this.buildPdfTranslationMap();
            await this.refreshAffectedOverlays();
        }, 500, true);

        // Ready promise
        this.isReady = new Promise(resolve => {
            this.resolveReady = resolve;
        });

        // Initialize services
        this.translation = new TranslationEngine(this);
        this.overlay = new OverlayRenderer(this);
        this.processor = new TextProcessor(this);
        this.storage = new TranslationStorage(this);
        this.layoutParserDebug = new LayoutParserDebugModule(this);
        
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
            if (this.isTranslationFile(file)) {
                this.logDebug(`Translation file changed: ${file.path}. Rebuilding map.`);
                this.debouncedBuildMap();
            }
        }));

        // ======= File System Events (Renames/Deletes) =======
        
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (!(file instanceof TFile)) return;

            // 1. If a PDF was renamed, we might need to update the translation file name
            if (file.extension === 'pdf') {
                const mdPath = this.pdfToMdMap.get(oldPath);
                if (mdPath) {
                    setTimeout(async () => {
                        try {
                            const mdFile = this.app.vault.getAbstractFileByPath(mdPath);
                            if (mdFile instanceof TFile) {
                                const newMdPath = this.storage.getTranslationFilePath(file);
                                if (normalizePath(mdFile.path) !== normalizePath(newMdPath)) {
                                     await this.app.vault.rename(mdFile, newMdPath);
                                }
                            }
                        } catch (e) { console.error(e); } 
                        finally {
                            this.debouncedBuildMap();
                        }
                    }, 200);
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

        // ======= Standard Commands =======
        
        this.addCommand({
            id: 'rebuild-pdf-translation-map',
            name: 'Rebuild PDF-to-translation file map',
            callback: async () => {
                new Notice('Rebuilding map...');
                await this.buildPdfTranslationMap();
                await this.refreshAffectedOverlays();
                new Notice('Map rebuilt.');
            }
        });

        this.addCommand({
            id: 'clean-unused-translations',
            name: 'Clean unused translation files...',
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
            name: 'Translate multiple pages...',
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

        this.addCommand({
            id: 'adjust-layout-settings',
            name: 'Adjust Layout Detector Settings...',
            callback: () => {
                showLayoutSettingsModal(this.layoutSettings, (newSettings) => {
                    this.activateLayoutSettings(newSettings, null);
                });
            }
        });

        this.addCommand({
            id: 'quick-switch-layout-preset',
            name: 'Layout: Quick switch preset...',
            callback: () => {
                new PresetFuzzyModal(this.app, this).open();
            }
        });

        const savedPresets = PresetManager.getAllPresets();
        savedPresets.forEach(preset => {
            this.addCommand({
                id: `load-layout-preset-${preset.id}`,
                name: `Layout Preset: Load "${preset.name}"`,
                callback: () => this.activateLayoutSettings(preset.settings, preset.name)
            });
        });

        // ======= Overlay Commands =======

        this.addCommand({
            id: 'add-pdf-text-overlay',
            name: 'Translate and add overlay to current PDF page',
            callback: () => this.processor.addTextOverlay(),
        });

        this.addCommand({
            id: 'save-pdf-overlay',
            name: 'Save current PDF overlay',
            callback: () => this.storage.saveCurrentOverlay(),
        });

        this.addCommand({
            id: 'refresh-pdf-overlay',
            name: 'Refresh current PDF overlay',
            callback: () => this.overlay.refreshCurrentOverlay(),
        });

        this.addCommand({
            id: 'clear-pdf-overlay',
            name: 'Clear current PDF overlay',
            callback: () => this.overlay.clearCurrentOverlay(),
        });

        this.addCommand({
            id: 'reprocess-text-region',
            name: 'Reprocess/retranslate a text region...',
            callback: async () => {
                const reprocessor = new RegionReprocessor(this);
                reprocessor.start();
            }
        });

        this.addCommand({
            id: 'retranslate-using-overlays',
            name: 'Retranslate using saved overlay layout...',
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
            name: 'Toggle PDF overlay visibility',
            callback: () => this.overlay.toggleOverlayVisibility(),
        });

        this.addCommand({
            id: 'toggle-bbox-edit-mode',
            name: 'Toggle BBox Edit Mode',
            callback: async () => {
                this.settings.bboxEditMode = !this.settings.bboxEditMode;
                await this.saveSettings();
                new Notice(`BBox Edit Mode ${this.settings.bboxEditMode ? 'enabled' : 'disabled'}.`);
            }
        });

        this.addCommand({
            id: 'toggle-layout-parser-debug-mode',
            name: 'Toggle Layout Parser Debug Mode',
            callback: async () => {
                await this.layoutParserDebug.toggleMode();
            }
        });

        // ======= PDF Export Command (Desktop Only) =======

        if (this.pdfExport) {
            this.addCommand({
                id: 'export-full-pdf',
                name: 'Export PDF with translations',
                callback: () => this.pdfExport?.exportFullPdf()
            });
        }

        // ======= Event Listeners =======

        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && leaf.view.getViewType() === 'pdf') {
                setTimeout(() => {
                    this.overlay.setupPDFMonitoring(leaf);
                    void this.layoutParserDebug.onActiveLeafChange(leaf);
                }, 300);
            } else {
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

    private isTranslationFile(file: any): boolean {
        return file instanceof TFile && 
               file.extension === 'md' && 
               file.name.endsWith('.translations.md');
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
            
            const cache = this.app.metadataCache.getFileCache(mdFile);
            if (!cache?.frontmatter) continue;

            const raw = cache.frontmatter['pdf-source'];
            if (!raw || typeof raw !== 'string') continue;

            // FIX: Simplified cleaning logic that handles WikiLinks, Quotes, or Plain Paths robustly
            // 1. Remove wrapping quotes/brackets if present
            // 2. Remove alias (content after |)
            let linkPath = raw.trim();

            // Strip [[ ]] if present
            if (linkPath.startsWith('[[') && linkPath.endsWith(']]')) {
                linkPath = linkPath.slice(2, -2);
            } 
            // Strip quotes if they somehow survived frontmatter parsing (rare but possible)
            else if ((linkPath.startsWith('"') && linkPath.endsWith('"')) || 
                     (linkPath.startsWith("'") && linkPath.endsWith("'"))) {
                linkPath = linkPath.slice(1, -1);
            }

            // Remove pipe alias
            if (linkPath.includes('|')) {
                linkPath = linkPath.split('|')[0];
            }
            
            linkPath = linkPath.trim();
            if (!linkPath) continue;

            let resolved: TFile | null = null;

            // Strategy 1: Try resolving as a link (handles relative paths, wikilinks)
            resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, mdFile.path) as TFile;

            // Strategy 2: Fallback - Try resolving as an absolute path in the vault
            if (!resolved) {
                const abstractFile = this.app.vault.getAbstractFileByPath(linkPath);
                if (abstractFile instanceof TFile) {
                    resolved = abstractFile;
                }
            }

            // Strategy 3: Try normalizing path if previous attempts failed
            if (!resolved) {
                const normalized = normalizePath(linkPath);
                const abstractFile = this.app.vault.getAbstractFileByPath(normalized);
                if (abstractFile instanceof TFile) {
                    resolved = abstractFile;
                }
            }

            if (resolved && resolved.extension === 'pdf') {
                this.pdfToMdMap.set(resolved.path, mdFile.path);
                count++;
            }
        }
        
        this.logDebug(`Rebuilt map. Found ${count} translation files.`);
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
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...savedSettings,
            providerSettings: {
                openrouter: { ...DEFAULT_SETTINGS.providerSettings.openrouter, ...(savedProviderSettings.openrouter || {}) },
                ollama: { ...DEFAULT_SETTINGS.providerSettings.ollama, ...(savedProviderSettings.ollama || {}) },
                openai: { ...DEFAULT_SETTINGS.providerSettings.openai, ...(savedProviderSettings.openai || {}) },
                gemini: { ...DEFAULT_SETTINGS.providerSettings.gemini, ...(savedProviderSettings.gemini || {}) },
                custom: { ...DEFAULT_SETTINGS.providerSettings.custom, ...(savedProviderSettings.custom || {}) },
            },
            ocrProvider: {
                ...DEFAULT_SETTINGS.ocrProvider,
                ...(savedSettings.ocrProvider || {})
            }
        };
        this.layoutSettings = { ...defaultLayoutSettings, ...data.layoutSettings || {} };

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
    }

    async saveSettings() {
        await this.saveData({
            settings: this.settings,
            layoutSettings: this.layoutSettings
        });
    }

    getCurrentPageNumber(): number | null {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf || activeLeaf.view.getViewType() !== 'pdf') return null;

        const pdfView: any = activeLeaf.view;
        const containerEl = pdfView.containerEl;
        const viewerContainer = containerEl.querySelector('.pdfViewer, #viewer');
        if (!viewerContainer) return null;

        const pages = viewerContainer.querySelectorAll('.page[data-page-number]');
        const currentPageEl = this.overlay.getCurrentVisiblePage(pages);
        if (!currentPageEl) return null;

        const pageNumberStr = currentPageEl.getAttribute('data-page-number');
        const pageNumber = pageNumberStr ? parseInt(pageNumberStr, 10) : 0;
        return pageNumber > 0 ? pageNumber : null;
    }

    onunload() {
        console.log('🧩 OpenRouter PDF Translator plugin unloaded');
        this.layoutParserDebug?.cleanup();
        this.overlay.cleanup();
        this.clearAllOverlays();
        this.pdfToMdMap.clear();
    }

    clearAllOverlays() {
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

export class PresetFuzzyModal extends FuzzySuggestModal<Preset> {
    plugin: OpenRouterTranslatorPlugin;

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Select a preset to load...");
    }

    getItems(): Preset[] {
        return PresetManager.getAllPresets();
    }

    getItemText(preset: Preset): string {
        return preset.name;
    }

    onChooseItem(preset: Preset, evt: MouseEvent | KeyboardEvent): void {
        this.plugin.activateLayoutSettings(preset.settings, preset.name);
    }
}

/**
 * Modal that displays orphaned translation files (ones whose PDF no longer exists)
 * and allows the user to selectively delete them.
 */
export class CleanTranslationsModal extends Modal {
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
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Clean Unused Translation Files' });

        contentEl.createEl('p', {
            text: `Found ${this.orphans.length} translation file(s) whose source PDF no longer exists in the vault. Select the files you want to delete.`
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
                text: `Translation file: ${orphan.mdFile.path}`,
                attr: { style: 'color: var(--text-muted);' }
            });
            labelEl.createEl('br');
            labelEl.createEl('small', {
                text: `Missing PDF: ${orphan.pdfSource}`,
                attr: { style: 'color: var(--text-error);' }
            });
        }

        // Select All / Deselect All buttons
        const toggleBar = contentEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px; margin-bottom: 16px;' }
        });

        const selectAllBtn = toggleBar.createEl('button', { text: 'Select All' });
        const deselectAllBtn = toggleBar.createEl('button', { text: 'Deselect All' });

        selectAllBtn.onclick = () => checkboxes.forEach(cb => (cb.checked = true));
        deselectAllBtn.onclick = () => checkboxes.forEach(cb => (cb.checked = false));

        // Action buttons
        const actionBar = contentEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px; justify-content: flex-end;' }
        });

        const cancelBtn = actionBar.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const deleteBtn = actionBar.createEl('button', {
            text: 'Delete Selected',
            cls: 'mod-warning'
        });

        deleteBtn.onclick = async () => {
            const toDelete = this.orphans.filter((_, i) => checkboxes[i].checked);
            if (toDelete.length === 0) {
                new Notice('No files selected for deletion.');
                return;
            }

            // Disable buttons to prevent double-click
            deleteBtn.disabled = true;
            cancelBtn.disabled = true;
            deleteBtn.textContent = 'Deleting...';

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
                ? `Deleted ${deleted} file(s), ${errors} error(s).`
                : `Deleted ${deleted} unused translation file(s).`;
            new Notice(msg);

            this.close();
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}