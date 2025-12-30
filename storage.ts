// storage.ts
import { TFile, TFolder, normalizePath, Notice, parseYaml, App } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';

/**
 * VERSION HISTORY:
 * v1: Original format (comments with raw JSON in a table)
 * v2: Base64 metadata in a table
 * v3: Current improved format (JSON in %% comments, no table)
 */
const STORAGE_FORMAT_VERSION = 3;

/**
 * Manages storage and retrieval of translation overlays in individual .translations.md files.
 * Uses frontmatter linkage (`pdf-source: '[[file.pdf]]'`) for fast, renaming-resilient lookup.
 *
 * Key improvements in v3:
 * - Human-readable JSON metadata inside Obsidian comments (`%%...%%`).
 * - Original text is stored inside the metadata, not in the markdown body.
 * - No more markdown tables, making edits and copy-pasting simpler.
 * - Translated text appears directly under its metadata, with `<br>` for newlines.
 */
export class TranslationStorage {
    private plugin: OpenRouterTranslatorPlugin;
    private app: App;
    private loadingPromises: Map<string, Promise<void>> = new Map();  // Per-file concurrency guard
    private writingPromises: Map<string, Promise<void>> = new Map(); // Concurrency guard for writing

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
    }

    /**
     * Gets the user-defined storage location for translation files.
     * Defaults to same folder as PDF if empty.
     */
    get storageLocation(): string {
        return this.plugin.settings.storageLocation || '';
    }

    /**
     * Ensures the storage folder exists.
     */
    async ensureStorageFolder(): Promise<void> {
        const path = this.storageLocation;
        if (!path || path === '/' || path === '.' || path === '..') return;

        try {
            const folder = this.app.vault.getAbstractFileByPath(path);
            if (folder instanceof TFolder) return;

            if (folder) {
                throw new Error(`Path conflict: a file exists at '${path}'`);
            }

            await this.app.vault.createFolder(path);
        } catch (error) {
            if (!String(error).includes('Folder already exists')) {
                console.error(`PDF Translator: Failed to create folder '${path}'`, error);
                new Notice(`Error: Could not create folder "${path}"`);
            }
        }
    }

    /**
     * Finds the translation file for a PDF using the cached map.
     */
    async findTranslationFileForPdf(pdfFile: TFile): Promise<TFile | null> {
        const translationPath = this.plugin.pdfToMdMap.get(pdfFile.path);
        if (translationPath) {
            const file = this.app.vault.getAbstractFileByPath(translationPath);
            if (file instanceof TFile) return file;
        }
        return null;
    }

    /**
     * Constructs the translation file path based on settings.
     */
    getTranslationFilePath(pdfFile: TFile): string {
        const baseName = pdfFile.basename;
        const dir = this.storageLocation || pdfFile.parent?.path || '';
        const cleanDir = dir && dir !== '/' ? dir.replace(/\/+$/, '') : '';  // Remove trailing slashes, handle root
        return normalizePath(`${cleanDir ? cleanDir + '/' : ''}${baseName}.translations.md`);
    }

    /**
     * Generates the markdown content for a translation file in the v3 format.
     */
    generateMarkdownForOverlay(savedOverlay: SavedOverlay, pdfFile: TFile): string {
        const frontmatter = `---
pdf-source: '[[${pdfFile.path}]]'
timestamp: ${new Date(savedOverlay.timestamp).toISOString()}
format-version: ${STORAGE_FORMAT_VERSION}
---
`;

        let md = frontmatter + `
# Translations for ${pdfFile.basename}
> Last updated: ${new Date(savedOverlay.timestamp).toLocaleString()}

`;

        const pageNumbers = Object.keys(savedOverlay.pageOverlays)
            .map(Number)
            .sort((a, b) => a - b);

        for (const pageNumber of pageNumbers) {
            const items = savedOverlay.pageOverlays[pageNumber];
            if (!items?.length) continue;

            md += `\n## Page ${pageNumber}\n\n`;
            md += `[[${pdfFile.path}#page=${pageNumber}|→ View page]]\n\n`;

            items.forEach(item => {
                const originalText = (item.textContent || '').trim();

                // Build metadata with abbreviated keys for compactness
                const metadata: any = {
                    r: {
                        l: parseFloat(item.relativeRect.left.toFixed(4)),
                        t: parseFloat(item.relativeRect.top.toFixed(4)),
                        w: parseFloat(item.relativeRect.width.toFixed(4)),
                        h: parseFloat(item.relativeRect.height.toFixed(4)),
                    },
                    page: item.page,
                    ot: originalText, // Original Text
                };

                // Add font info if available
                if (item.fontSize !== undefined) {
                    metadata.fs = parseFloat(item.fontSize.toFixed(2)); // fontSize
                }
                if (item.fontFamily) {
                    metadata.ff = item.fontFamily; // fontFamily
                }
                if (item.originalFontSizes && item.originalFontSizes.length > 0) {
                    metadata.ofs = item.originalFontSizes.map(fs => parseFloat(fs.toFixed(2))); // originalFontSizes
                }

                const metadataStr = JSON.stringify(metadata);
                const comment = `%% ${metadataStr} %%`;

                // Convert newlines in translated text to <br> for markdown rendering
                const translated = (item.translatedText || '').trim().replace(/\n/g, '<br>');

                md += `${comment}\n\n`;
                md += `${translated}\n\n`;
            });
        }

        return md;
    }

    /**
     * Validates metadata structure against schema
     */
    private validateMetadata(metadata: any): boolean {
        // Check required top-level properties
        if (typeof metadata !== 'object' || !metadata.r || typeof metadata.page !== 'number') {
            return false;
        }

        // Validate rectangle properties
        const rect = metadata.r;
        if (
            typeof rect.l !== 'number' ||
            typeof rect.t !== 'number' ||
            typeof rect.w !== 'number' ||
            typeof rect.h !== 'number' ||
            rect.w <= 0 ||
            rect.h <= 0
        ) {
            return false;
        }
        return true;
    }

    /**
     * Parses a markdown file into a SavedOverlay object.
     * Supports v1, v2 (table-based), and v3 (comment-based) formats.
     */
    parseMarkdownOverlay(content: string, pdfFile: TFile): SavedOverlay | null {
        const frontmatterMatch = content.match(/---\n([\s\S]+?)\n---/);
        let formatVersion = 1;
        let timestamp = Date.now();

        if (frontmatterMatch) {
            try {
                const fmData = parseYaml(frontmatterMatch[1]);
                // Read version from frontmatter, default to 1 if not present
                formatVersion = fmData['format-version'] || fmData.version || 1;
                if (fmData.timestamp) {
                    const t = new Date(fmData.timestamp);
                    if (!isNaN(t.getTime())) timestamp = t.getTime();
                }
            } catch (err) {
                console.warn('PDF Translator: Failed to parse frontmatter YAML', err);
            }
        }

        const body = content.substring(frontmatterMatch?.[0].length || 0);
        const lines = body.split('\n');
        const pageOverlays: Record<string, OverlayPositionData[]> = {};
        let currentPage: string | null = null;
        
        // Use different parsing logic based on format version
        if (formatVersion >= 3) {
            // New V3 parsing logic (%% comments)
            const V3_META_REGEX = /^%%\s*(\{.*\})\s*%%/;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                const pageMatch = line.match(/^##\s+Page\s+(\d+)/i);
                if (pageMatch) {
                    currentPage = pageMatch[1];
                    if (!pageOverlays[currentPage]) pageOverlays[currentPage] = [];
                    continue;
                }

                if (!currentPage) continue;
                
                const metaMatch = line.match(V3_META_REGEX);
                if (metaMatch) {
                    try {
                        const metadata = JSON.parse(metaMatch[1]);
                        if (!this.validateMetadata(metadata)) {
                            if (this.plugin.settings.debugMode) {
                                console.warn('PDF Translator: Invalid V3 metadata structure', metadata);
                            }
                            continue;
                        }

                        // The translated text is on the next non-empty line
                        let translatedText = '';
                        for (let j = i + 1; j < lines.length; j++) {
                            if (lines[j].trim()) {
                                translatedText = lines[j].trim().replace(/<br>/g, '\n');
                                i = j; // Advance outer loop past the translated text line
                                break;
                            }
                        }

                        const overlayData: OverlayPositionData = {
                            selector: '', // Selector is deprecated
                            textContent: metadata.ot || '', // Original Text from metadata
                            relativeRect: {
                                left: metadata.r.l,
                                top: metadata.r.t,
                                width: metadata.r.w,
                                height: metadata.r.h,
                            },
                            page: metadata.page,
                            translatedText,
                            fontSize: metadata.fs,
                            fontFamily: metadata.ff,
                            originalFontSizes: metadata.ofs,
                        };
                        pageOverlays[currentPage].push(overlayData);
                    } catch (e) {
                         if (this.plugin.settings.debugMode) {
                            console.debug('PDF Translator: Invalid V3 metadata JSON', e);
                        }
                    }
                }
            }
        } else {
            // Fallback for V1/V2 (table-based)
            const NEW_META_REGEX = /<!--\s*PDF_TRANSLATOR_METADATA:([a-zA-Z0-9+/=]+)\s*-->/;
            const OLD_META_REGEX = /<!--\s*(\{.*?\})\s*-->/;

            for (const line of lines) {
                const trimmed = line.trim();
                const pageMatch = trimmed.match(/^##\s+Page\s+(\d+)/i);
                if (pageMatch) {
                    currentPage = pageMatch[1];
                    pageOverlays[currentPage] = [];
                    continue;
                }
                if (!currentPage || !trimmed.startsWith('|') || trimmed.includes('|-|')) continue;

                const cells = this.parseMarkdownTableCells(trimmed);
                if (cells.length !== 2) continue;

                const [originalCell, translatedCell] = cells;
                let metadata: any = null;
                const newMetaMatch = originalCell.match(NEW_META_REGEX); // V2
                if (newMetaMatch) {
                    try {
                        metadata = JSON.parse(decodeURIComponent(escape(atob(newMetaMatch[1]))));
                    } catch (e) { /* ignore */ }
                } else {
                    const oldMetaMatch = originalCell.match(OLD_META_REGEX); // V1
                    if (oldMetaMatch) {
                        try {
                            metadata = JSON.parse(oldMetaMatch[1]);
                        } catch (e) { /* ignore */ }
                    }
                }

                if (!metadata || !this.validateMetadata(metadata)) continue;

                const textContent = originalCell.replace(NEW_META_REGEX, '').replace(OLD_META_REGEX, '').replace(/\\\|/g, '|').trim();
                const translatedText = translatedCell.replace(/\\\|/g, '|').replace(/\\n/g, '\n');
                
                const overlayData: OverlayPositionData = {
                    selector: metadata.sel || '',
                    textContent,
                    relativeRect: { left: metadata.r.l, top: metadata.r.t, width: metadata.r.w, height: metadata.r.h },
                    page: metadata.page,
                    translatedText,
                    fontSize: metadata.fontSize,
                    fontFamily: metadata.fontFamily,
                    originalFontSizes: metadata.originalFontSizes,
                };
                pageOverlays[currentPage].push(overlayData);
            }
        }

        if (Object.keys(pageOverlays).length === 0) {
            return null;
        }

        return {
            fileName: pdfFile.basename.replace(/\.pdf$/i, ''),
            filePath: pdfFile.path,
            timestamp,
            pageOverlays,
        };
    }

    /**
     * Helper to parse Markdown table cells, handling escaped pipes. (For V1/V2)
     */
    private parseMarkdownTableCells(line: string): string[] {
        const cells: string[] = [];
        let current = '';
        let i = 1; // Start after first '|'
        while (i < line.length - 1) { // End before last '|'
            const char = line[i];
            if (char === '\\' && line[i + 1] === '|') {
                current += '|';
                i += 2; // Skip escape and pipe
                continue;
            }
            if (char === '|') {
                cells.push(current.trim());
                current = '';
                i++; // Skip the pipe
                continue;
            }
            current += char;
            i++;
        }
        cells.push(current.trim()); // Last cell
        return cells;
    }

    // ... (The rest of the class methods: saveCurrentOverlay, loadSavedOverlayForCurrentPage, etc., do not need to be changed as they rely on the abstraction provided by the generation and parsing methods.)
    /**
     * Saves the current overlay for the active page.
     * Merges with existing data from file.
     */
    async saveCurrentOverlay() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') {
            new Notice('Please open a PDF first.');
            return;
        }

        const currentPageNumber = this.plugin.getCurrentPageNumber();
        if (currentPageNumber === null) return;

        const textLayer = this.plugin.overlay.getCurrentPageTextLayer();
        const overlayContainer = textLayer?.closest('.page')?.querySelector('.pdf-text-overlay-container');
        if (!textLayer || !overlayContainer) {
            new Notice('No overlay to save.');
            return;
        }

        const positionData = this.extractPositionData(textLayer, overlayContainer);
        if (positionData.length === 0) {
            new Notice('Could not extract overlay data.');
            return;
        }

        // Start with blank or existing data
        let savedOverlay: SavedOverlay = {
            fileName: activeFile.basename.replace(/\.pdf$/i, ''),
            filePath: activeFile.path,
            timestamp: Date.now(),
            pageOverlays: {},
        };

        const translationFile = await this.findTranslationFileForPdf(activeFile);

        // Only overwrite if parse succeeds
        if (translationFile) {
            try {
                const content = await this.app.vault.read(translationFile);
                const parsed = this.parseMarkdownOverlay(content, activeFile);
                if (parsed) savedOverlay = parsed;
            } catch (e) {
                console.warn('PDF Translator: Failed to read existing translation file', e);
            }
        }

        // Update this page
        savedOverlay.timestamp = Date.now();
        savedOverlay.pageOverlays[currentPageNumber] = positionData;

        const markdownContent = this.generateMarkdownForOverlay(savedOverlay, activeFile);

        if (translationFile) {
            await this.app.vault.modify(translationFile, markdownContent);
        } else {
            const translationPath = this.getTranslationFilePath(activeFile);
            await this.ensureStorageFolder();
            await this.app.vault.create(translationPath, markdownContent);
            // Sync map
            this.plugin.pdfToMdMap.set(activeFile.path, translationPath);
            if (this.plugin.settings.debugMode) {
                console.log(`PDF Translator: Created translation file at ${translationPath}`);
            }
        }

        new Notice(`Overlay saved for ${activeFile.basename} page ${currentPageNumber}`);
    }

    /**
     * Loads the saved overlay for the current page.
     * If forceReload is true, removes any existing overlay before loading.
     */
    async loadSavedOverlayForCurrentPage(file: TFile, forceReload: boolean = false) {
        const currentPageNumber = this.plugin.getCurrentPageNumber();
        if (currentPageNumber === null) return;

        const pageElement = this.plugin.overlay.getCurrentPageElement();
        if (!pageElement) return;

        // If forceReload, clear existing overlay to ensure re-render at current zoom
        if (forceReload) {
            const existingOverlay = pageElement.querySelector('.pdf-text-overlay-container');
            if (existingOverlay) {
                existingOverlay.remove();
            }
        }

        // ✅ Instead of using cached lastLoaded, check actual DOM
        const existingOverlay = pageElement.querySelector('.pdf-text-overlay-container');
        if (existingOverlay && !forceReload) {
            // Overlay already rendered — no need to load again
            return;
        }

        // Prevent concurrent loads per file
        const fileKey = file.path;
        if (this.loadingPromises.has(fileKey)) {
            await this.loadingPromises.get(fileKey);
            return;
        }

        const loader = async () => {
            const translationFile = await this.findTranslationFileForPdf(file);
            if (!translationFile) return;

            try {
                const content = await this.app.vault.read(translationFile);
                const savedOverlay = this.parseMarkdownOverlay(content, file);
                if (!savedOverlay) return;

                const pageKey = currentPageNumber.toString();
                const pageData = savedOverlay.pageOverlays[pageKey];
                if (!Array.isArray(pageData) || pageData.length === 0) return;

                const textLayer = await this.plugin.overlay.waitForPdfTextLayer(currentPageNumber);
                if (!textLayer) return;

                this.plugin.overlay.renderSavedOverlay(pageData, currentPageNumber);

                if (this.plugin.settings.debugMode) {
                    console.log(`PDF Translator: Loaded overlay for page ${currentPageNumber} (${pageData.length} items)`);
                }

            } catch (error) {
                console.error('PDF Translator: Failed to load saved overlay', error);
            }
        };

        const promise = loader();
        this.loadingPromises.set(fileKey, promise);
        await promise;
        this.loadingPromises.delete(fileKey);
    }

    /**
     * Deletes the overlay for the current page.
     * If it's the last page, deletes the whole file.
     */
    async deleteCurrentOverlay() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') {
            new Notice('Please open a PDF file first.');
            return;
        }

        const currentPageNumber = this.plugin.getCurrentPageNumber();
        if (currentPageNumber === null) return;

        const translationFile = await this.findTranslationFileForPdf(activeFile);
        if (!translationFile) {
            new Notice('No translation file found for this PDF.');
            return;
        }

        try {
            const content = await this.app.vault.read(translationFile);
            const savedOverlay = this.parseMarkdownOverlay(content, activeFile);
            if (!savedOverlay) {
                new Notice('Could not parse translation data.');
                return;
            }

            const pageKey = currentPageNumber.toString();
            if (!savedOverlay.pageOverlays[pageKey]) {
                new Notice(`No overlay saved for page ${currentPageNumber}.`);
                return;
            }

            // Delete this page
            delete savedOverlay.pageOverlays[pageKey];

            if (Object.keys(savedOverlay.pageOverlays).length === 0) {
                await this.app.vault.trash(translationFile, true);
                this.plugin.pdfToMdMap.delete(activeFile.path);
                new Notice(`Translation file deleted for ${activeFile.basename}`);
            } else {
                const markdownContent = this.generateMarkdownForOverlay(savedOverlay, activeFile);
                await this.app.vault.modify(translationFile, markdownContent);
                new Notice(`Overlay deleted for page ${currentPageNumber}`);
            }

            this.plugin.clearAllOverlays();
        } catch (error) {
            console.error('PDF Translator: Failed to delete overlay', error);
            new Notice('Error deleting overlay.');
        }
    }

    /**
     * Extracts positioning and content data from rendered overlay elements.
     * Uses the closest .page[data-page-number] to determine the page number.
     */
    extractPositionData(textLayer: HTMLElement, overlayContainer: Element): OverlayPositionData[] {
        const positionData: OverlayPositionData[] = [];
        const overlays = overlayContainer.querySelectorAll<HTMLElement>('.pdf-text-overlay-reflow');
        const textLayerRect = textLayer.getBoundingClientRect();

        // Get page number from the closest .page element
        const pageElement = overlayContainer.closest('.page[data-page-number]') as HTMLElement | null;
        const pageNumber = pageElement ? parseInt(pageElement.getAttribute('data-page-number') || '0', 10) : 0;

        if (textLayerRect.width === 0 || textLayerRect.height === 0) {
            console.error('PDF Translator: Text layer has zero dimensions');
            return [];
        }

        // Get scale for normalization (zoom-independent relative fonts)
        const pdfViewer = document.querySelector('.pdfViewer, #viewer') as HTMLElement;
        const saveScale = parseFloat(pdfViewer?.style.getPropertyValue('--scale-factor') || '1');
        if (isNaN(saveScale) || saveScale <= 0) {
            console.warn('PDF Translator: Invalid saveScale, using 1.0');
        }

        overlays.forEach(overlay => {
            const originalText = overlay.getAttribute('data-original-text') || '';
            const translatedDiv = overlay.querySelector('div');
            const translatedText = translatedDiv ? translatedDiv.innerHTML : (overlay.textContent || '');
            const rect = overlay.getBoundingClientRect();

            const relativeRect = {
                left: (rect.left - textLayerRect.left) / textLayerRect.width,
                top: (rect.top - textLayerRect.top) / textLayerRect.height,
                width: rect.width / textLayerRect.width,
                height: rect.height / textLayerRect.height,
            };

            // Extract from attributes (set in overlay.ts createReflowOverlay)
            const fontSizesStr = overlay.getAttribute('data-original-font-sizes') || '';
            let absoluteFontSizes: number[] = [];
            if (fontSizesStr) {
                try {
                    absoluteFontSizes = JSON.parse(fontSizesStr);
                } catch (e) {
                    console.warn('PDF Translator: Failed to parse font sizes from attribute', e);
                }
            }

            // Normalize to relative (divide by saveScale)
            const relativeFontSizes = absoluteFontSizes.length > 0 && saveScale > 0
                ? absoluteFontSizes.map(fs => fs / saveScale)
                : [];

            // Compute avg relative for fontSize
            const avgRelative = relativeFontSizes.length > 0
                ? relativeFontSizes.reduce((a, b) => a + b, 0) / relativeFontSizes.length
                : undefined;

            const fontFamily = overlay.getAttribute('data-font-family') || overlay.style.fontFamily || undefined;

            const overlayData: OverlayPositionData = {
                selector: '',
                textContent: originalText,
                relativeRect,
                page: pageNumber,
                translatedText,
                // Set relative font data
                fontSize: avgRelative,
                fontFamily,
                originalFontSizes: relativeFontSizes,
            };

            positionData.push(overlayData);
        });

        return positionData;
    }

    // ============================================================
    // Helpers for re-translation modal (read/write convenience)
    // ============================================================

    /**
     * Reads the saved overlay structure for a given PDF file.
     * Returns null if no file or no overlay data.
     */
    async readSavedOverlayForFile(pdfFile: TFile): Promise<{ mdFile: TFile; overlay: SavedOverlay } | null> {
        const mdFile = await this.findTranslationFileForPdf(pdfFile);
        if (!mdFile) return null;

        try {
            const content = await this.app.vault.read(mdFile);
            const parsed = this.parseMarkdownOverlay(content, pdfFile);
            if (!parsed) return null;
            return { mdFile, overlay: parsed };
        } catch (e) {
            console.warn('PDF Translator: Failed to read saved overlay for file', pdfFile.path, e);
            return null;
        }
    }

    /**
     * Writes a SavedOverlay structure back to its .translations.md.
     * Ensures timestamp is updated and map stays in sync if file is created.
     */
    async writeSavedOverlayForFile(pdfFile: TFile, savedOverlay: SavedOverlay): Promise<void> {
        const existing = await this.findTranslationFileForPdf(pdfFile);
        const markdownContent = this.generateMarkdownForOverlay(savedOverlay, pdfFile);

        if (existing) {
            await this.app.vault.modify(existing, markdownContent);
        } else {
            const translationPath = this.getTranslationFilePath(pdfFile);
            await this.ensureStorageFolder();
            await this.app.vault.create(translationPath, markdownContent);
            this.plugin.pdfToMdMap.set(pdfFile.path, translationPath);
            if (this.plugin.settings.debugMode) {
                console.log(`PDF Translator: Created translation file at ${translationPath}`);
            }
        }
    }

    /**
     * Updates one or more pages in a SavedOverlay and writes to disk.
     * This function is now corrected to prevent race conditions.
     * pages is a map pageNumber -> array of OverlayPositionData.
     */
    async updatePageOverlaysAndWrite(pdfFile: TFile, pages: Record<number, OverlayPositionData[]>): Promise<void> {
        const lockKey = pdfFile.path;

        // The core logic of reading, updating, and writing the file.
        const writer = async (): Promise<void> => {
            // --- START OF CORRECTED LOGIC ---

            // More robust: Directly check the filesystem for the file's existence
            // at the time of writing. This is the key to fixing the race condition.
            const translationPath = this.getTranslationFilePath(pdfFile);
            const abstractFile = this.app.vault.getAbstractFileByPath(translationPath);
            let mdFile: TFile | null = (abstractFile instanceof TFile) ? abstractFile : null;

            let savedOverlay: SavedOverlay | null = null;

            if (mdFile) {
                // MODIFY PATH: File exists, so we read it.
                try {
                    const content = await this.app.vault.read(mdFile);
                    savedOverlay = this.parseMarkdownOverlay(content, pdfFile);
                } catch (e) {
                    this.plugin.logDebug("Failed to read or parse existing translation file, will overwrite.", e);
                    // Continue with a blank overlay object if parsing fails.
                }
            }

            // If file didn't exist or failed to parse, create a new overlay object.
            if (!savedOverlay) {
                savedOverlay = {
                    fileName: pdfFile.basename.replace(/\.pdf$/i, ''),
                    filePath: pdfFile.path,
                    timestamp: Date.now(),
                    pageOverlays: {},
                };
            }

            // Merge the new page data into the overlay
            for (const [pageStr, items] of Object.entries(pages)) {
                const p = Number(pageStr);
                if (items.length > 0) {
                    savedOverlay.pageOverlays[p] = items;
                } else {
                    delete savedOverlay.pageOverlays[p]; // Handle deletion of a page's overlays
                }
            }
            savedOverlay.timestamp = Date.now();

            const md = this.generateMarkdownForOverlay(savedOverlay, pdfFile);

            if (mdFile) {
                // File exists, so modify it.
                await this.app.vault.modify(mdFile, md);
            } else {
                // CREATE PATH: File does not exist, so create it.
                await this.ensureStorageFolder();
                await this.app.vault.create(translationPath, md);
                // This map update is now safely inside the sequential queue
                this.plugin.pdfToMdMap.set(pdfFile.path, translationPath);
            }

            // --- END OF CORRECTED LOGIC ---
        };

        // Promise-based locking mechanism to serialize write operations for the same file
        const pendingPromise = this.writingPromises.get(lockKey) || Promise.resolve();
        const newPromise = pendingPromise.then(() => writer()).finally(() => {
            // IMPORTANT: Clean up the map once the operation is done.
            // This check ensures we don't accidentally delete a newer promise
            // if operations were chained very quickly.
            if (this.writingPromises.get(lockKey) === newPromise) {
                this.writingPromises.delete(lockKey);
            }
        });

        this.writingPromises.set(lockKey, newPromise);
        await newPromise;
    }


    /**
     * Ensure an existing translation note's pdf-source wikilink points to the given PDF.
     * Repairs stale links after renames or moves. Keeps the original single-quoted wikilink format.
     */
    async ensurePdfSourceLinkPointsTo(fileMd: TFile, pdfFile: TFile): Promise<void> {
        const cache = this.app.metadataCache.getFileCache(fileMd);
        const fm = cache?.frontmatter;
        if (!fm) return;

        const raw = fm['pdf-source'];
        if (typeof raw !== 'string') return;

        // Extract link path from '[[link]]' or [[link]]; handle aliases [[path|alias]]
        const singleQuoted = raw.match(/^'\[\[(.+?)\]\]'$/);
        const bare = !singleQuoted && raw.match(/^\[\[(.+?)\]\]$/);
        const linkRaw = singleQuoted ? singleQuoted[1] : (bare ? bare[1] : raw.trim());
        const linkPath = linkRaw.split('|')[0].trim();

        const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, fileMd.path);
        if (resolved && resolved.path === pdfFile.path) {
            // Already correct
            return;
        }

        // Build replacement string keeping single-quoted wikilink
        const newTarget = `[[${pdfFile.path}]]`;

        // Read, replace frontmatter line, write back
        const content = await this.app.vault.read(fileMd);
        const updated = content.replace(
            /^---[\s\S]*?---/,
            (fmBlock) => {
                if (/^pdf-source:\s*/m.test(fmBlock)) {
                    return fmBlock.replace(/^(pdf-source:\s*).*/m, `$1'[[${pdfFile.path}]]'`);
                } else {
                    // Insert if somehow missing
                    const parts = fmBlock.split('\n');
                    parts.splice(1, 0, `pdf-source: '[[${pdfFile.path}]]'`);
                    return parts.join('\n');
                }
            }
        );

        if (updated !== content) {
            await this.app.vault.modify(fileMd, updated);
        }
    }
}