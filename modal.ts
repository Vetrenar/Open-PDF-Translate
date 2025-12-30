// modal.ts
import { Modal, Setting, Notice, ButtonComponent, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';

/**
 * A modal for translating a range of pages within a PDF file.
 *
 * This modal implements a robust translation workflow with the following features:
 * - **Translation Caching:** Temporarily stores successful translations to prevent data loss on overlay creation failure.
 * - **Overlay Verification:** Explicitly checks that the created overlay contains the translated text, triggering a retry if it doesn't.
 * - **Optional Paced Distribution:** Users can optionally define a time window. If set,
 *   the translation calls are evenly distributed from the start to fit within that
 *   time, preventing API rate-limiting. If not set, it runs as fast as possible.
 * - **Adaptive Retries:** Handles transient network errors with an exponential backoff strategy.
 * - **Clear UI Feedback:** Provides detailed progress updates to the user.
 * - **Singleton Job Management:** Prevents multiple bulk translation jobs from running simultaneously,
 *   and provides an interface to manage the running job.
 */
export class TranslateMultiplePagesModal extends Modal {
    // Plugin and File Context
    plugin: OpenRouterTranslatorPlugin;
    file: TFile;

    // User-configurable settings for the current job
    startPage: number = 1;
    endPage: number = 1;
    totalPages: number = 1;
    useTimeWindow: boolean = false;
    timeWindowHours: number = 2; // Default time window of 2 hours

    // Internal state management
    isProcessing: boolean = false;
    isCancelled: boolean = false;
    activeOverlays: HTMLElement[] = [];
    private retryTimeout: number = 0;

    // NEW: Cache to store translated text, preventing data loss on DOM errors.
    private translationCache: Map<number, string> = new Map();

    // State for pacing
    private pacingDelay: number = 200; // Default "sprint" delay

    // Properties for live progress tracking
    private progressMessage: string = 'Initializing...';
    private progressEl: HTMLElement | null = null;

    // Static properties to ensure only one bulk translation runs at a time
    static isBulkTranslationInProgress: boolean = false;
    static currentInstance: TranslateMultiplePagesModal | null = null;

    constructor(plugin: OpenRouterTranslatorPlugin, file: TFile) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
    }

    /**
     * Called when the modal is opened. Renders the UI.
     */
    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        if (TranslateMultiplePagesModal.isBulkTranslationInProgress && TranslateMultiplePagesModal.currentInstance) {
            this.displayManagementView(contentEl);
            return;
        }

        this.titleEl.setText('Translate Multiple Pages');
        contentEl.createEl('p', { text: `File: ${this.file.basename}` });

        this.totalPages = await this.estimateTotalPages();
        this.endPage = this.totalPages;
        contentEl.createEl('p', { text: `Estimated total pages: ${this.totalPages}` });

        this.renderSettings(contentEl);

        const progressContainer = contentEl.createDiv({ cls: 'translator-progress-container' });
        this.progressEl = progressContainer;

        const buttonContainer = contentEl.createDiv({ cls: 'translator-button-container' });
        this.renderActionButtons(buttonContainer);
    }

    /**
     * Renders a view to manage an in-progress translation job.
     */
    private displayManagementView(contentEl: HTMLElement) {
        this.titleEl.setText('Translation in Progress');
        const instance = TranslateMultiplePagesModal.currentInstance;

        if (!instance) {
            contentEl.setText('Could not find the active translation process.');
            return;
        }

        contentEl.createEl('p', { text: 'A batch translation is already running.' });

        const progressDisplay = contentEl.createEl('p', { cls: 'translator-progress-display' });
        progressDisplay.setText(instance.progressMessage);

        const intervalId = window.setInterval(() => {
            if (TranslateMultiplePagesModal.isBulkTranslationInProgress && instance) {
                progressDisplay.setText(instance.progressMessage);
            } else {
                window.clearInterval(intervalId);
                new Notice('Translation job has finished.');
                this.close();
            }
        }, 1000);

        const buttonContainer = contentEl.createDiv({ cls: 'translator-button-container' });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel Translation')
            .setWarning()
            .onClick(() => {
                if (TranslateMultiplePagesModal.cancelCurrentTranslation()) {
                    new Notice('Translation aborted.');
                }
                this.close();
            });

        new ButtonComponent(buttonContainer)
            .setButtonText('Close')
            .onClick(() => this.close());
    }

    /**
     * Renders the settings for page range and time window.
     */
    private renderSettings(contentEl: HTMLElement) {
        let startInput: HTMLInputElement;
        let endInput: HTMLInputElement;

        new Setting(contentEl).setName('Start page').addText((cb) => {
            startInput = cb.el;
            cb.setValue(String(this.startPage)).onChange((value) => {
                const n = parseInt(value, 10);
                if (!isNaN(n) && n >= 1 && n <= this.totalPages) this.startPage = n;
            });
        });

        new Setting(contentEl).setName('End page').addText((cb) => {
            endInput = cb.el;
            cb.setValue(String(this.endPage)).onChange((value) => {
                const n = parseInt(value, 10);
                if (!isNaN(n) && n >= this.startPage && n <= this.totalPages) this.endPage = n;
            });
        });

        new Setting(contentEl).addButton((cb) => {
            cb.setButtonText('All Pages').setCta().onClick(() => {
                this.startPage = 1;
                this.endPage = this.totalPages;
                startInput.value = '1';
                endInput.value = String(this.totalPages);
            });
        });

        const timeWindowSetting = new Setting(contentEl)
            .setName('Use Time Window')
            .setDesc('Distribute translations over a set time to avoid rate limits. If off, it will run as fast as possible.')
            .addToggle(toggle => toggle
                .setValue(this.useTimeWindow)
                .onChange(value => {
                    this.useTimeWindow = value;
                    timeInputSetting.settingEl.style.display = value ? '' : 'none';
                }));

        const timeInputSetting = new Setting(contentEl)
            .setName('Job Time (Hours)')
            .setDesc('The total time to spread the translation job over.')
            .addText(text => text
                .setValue(String(this.timeWindowHours))
                .onChange(value => {
                    const n = parseFloat(value);
                    if (!isNaN(n) && n > 0) this.timeWindowHours = n;
                }));

        timeInputSetting.settingEl.style.display = this.useTimeWindow ? '' : 'none';
    }

    /**
     * Renders the Start and Abort buttons.
     */
    private renderActionButtons(container: HTMLElement) {
        const startButton = new ButtonComponent(container)
            .setButtonText('Start Translation')
            .setCta()
            .onClick(async () => {
                if (this.startPage > this.endPage) {
                    new Notice('Start page must be less than or equal to End page.');
                    return;
                }

                this.initializeJobState();
                startButton.setDisabled(true);
                abortButton.setDisabled(false);

                this.updateProgress('Starting translation job...');

                try {
                    await this.translatePageRange(this.file, this.startPage, this.endPage);
                    if (!this.isCancelled) {
                        this.close();
                    }
                } catch (err: any) {
                    new Notice('Error: ' + (err.message || 'Unknown error'), 7000);
                    console.error('Bulk translation failed:', err);
                } finally {
                    this.cleanup();
                    if (!this.isCancelled) {
                        startButton.setDisabled(false);
                    }
                    abortButton.setDisabled(true);
                }
            });

        const abortButton = new ButtonComponent(container)
            .setButtonText('Abort')
            .setDisabled(true)
            .onClick(() => {
                if (this.isProcessing) {
                    new Notice('Aborting translation...');
                    this.isCancelled = true;
                    abortButton.setButtonText('Aborting...').setDisabled(true);
                }
            });
    }

    /**
     * Sets the initial state for a new translation job.
     */
    private initializeJobState() {
        this.isProcessing = true;
        this.isCancelled = false;

        TranslateMultiplePagesModal.isBulkTranslationInProgress = true;
        TranslateMultiplePagesModal.currentInstance = this;
    }

    /**
     * Centralized method for updating the progress message.
     */
    private updateProgress(msg: string) {
        this.progressMessage = msg;
        if (this.progressEl) {
            this.progressEl.setText(msg);
        }
    }

    /**
     * The main logic loop for processing a range of pages.
     */
    private async translatePageRange(pdfFile: TFile, startPage: number, endPage: number): Promise<void> {
        const pdfLeaf = this.app.workspace.getLeavesOfType('pdf')[0] || this.app.workspace.getMostRecentLeaf();
        if (!pdfLeaf) {
            throw new Error('No available workspace leaf to open PDF.');
        }

        try {
            await pdfLeaf.openFile(pdfFile);
            if (!await this.waitForEl('.pdfViewer', 10000)) throw new Error('Failed to load PDF viewer.');
        } catch (err) {
            throw new Error('Could not open the specified PDF file.');
        }

        const originalAutoSave = this.plugin.settings.autoSaveOverlay;
        this.plugin.settings.autoSaveOverlay = true;

        let completed = 0, failed = 0;
        const totalPagesToProcess = endPage - startPage + 1;
        const processingQueue = Array.from({ length: totalPagesToProcess }, (_, i) => startPage + i);

        if (this.useTimeWindow && this.timeWindowHours > 0 && totalPagesToProcess > 0) {
            const totalMilliseconds = this.timeWindowHours * 3600 * 1000;
            this.pacingDelay = totalMilliseconds / totalPagesToProcess;
            const paceInSeconds = Math.round(this.pacingDelay / 1000);
            this.updateProgress(`Pacing enabled. Each page will be processed approx. every ${paceInSeconds} seconds.`);
            await this.sleep(1000);
        } else {
            this.pacingDelay = 200;
        }

        try {
            while (processingQueue.length > 0) {
                if (this.isCancelled) {
                    this.updateProgress('⏹️ Translation cancelled by user.');
                    return;
                }

                const pageNum = processingQueue.shift()!;
                const progressPrefix = `[${completed + 1}/${totalPagesToProcess}]`;
                this.updateProgress(`${progressPrefix} 🔄 Processing page ${pageNum}...`);

                try {
                    // MODIFIED: Reworked the core logic with caching and verification
                    await this.retryWithBackoff(async () => {
                        const navSuccess = await this.navigateToPage(pdfLeaf, pageNum);
                        if (!navSuccess) throw new Error('Navigation failed.');

                        const pageEl = await this.waitForPageAndTextLayer(pageNum, 30000);
                        if (!pageEl) throw new Error('Page or text layer failed to render.');

                        // Step 1: Get translation (from cache or new API call)
                        let translatedText = this.translationCache.get(pageNum);
                        if (!translatedText) {
                            this.updateProgress(`${progressPrefix} ✍️ Translating page ${pageNum}...`);
                            // ASSUMPTION: You need a method that only does the translation and returns a string.
                            translatedText = await this.plugin.processor.translatePageContent(pageEl);
                            if (!translatedText || translatedText.trim() === '') {
                                throw new Error('Translation returned empty content.');
                            }
                            this.translationCache.set(pageNum, translatedText); // Cache the successful translation
                        } else {
                            this.updateProgress(`${progressPrefix} 📄 Using cached translation for page ${pageNum}.`);
                        }

                        // Step 2: Create the overlay with the translated text
                        // ASSUMPTION: You need a method that creates the overlay from a given text string.
                        await this.plugin.processor.createOverlayWithText(pageEl, translatedText);
                        const newOverlay = pageEl.querySelector<HTMLElement>('.pdf-text-overlay-container');

                        // Step 3: VERIFY the overlay was created and contains the correct text
                        if (!newOverlay) {
                            throw new Error('Overlay element was not found after creation.');
                        }

                        const overlayText = newOverlay.innerText.trim();
                        // Verify a snippet of the text to avoid issues with formatting differences
                        const verificationSnippet = translatedText.substring(0, 50);
                        if (!overlayText.includes(verificationSnippet)) {
                            console.error(`Verification FAILED for page ${pageNum}. Overlay text did not match translated text.`);
                            console.log('Expected snippet:', verificationSnippet);
                            console.log('Actual overlay text:', overlayText.substring(0, 100));
                            throw new Error('Overlay content verification failed.');
                        }

                        // If verification passes, add to active overlays for cleanup
                        this.activeOverlays.push(newOverlay);
                    }, pageNum);

                    completed++;
                    this.updateProgress(`${progressPrefix} ✅ Page ${pageNum} complete.`);

                    // Manage memory by removing old overlays from the DOM
                    if (this.activeOverlays.length > 5) {
                        const oldOverlay = this.activeOverlays.shift();
                        oldOverlay?.parentElement?.removeChild(oldOverlay);
                    }

                } catch (err: any) {
                    if (this.isCancelled) break;
                    console.error(`Page ${pageNum} failed permanently after all retries:`, err);
                    this.updateProgress(`${progressPrefix} ❌ Page ${pageNum} failed: ${err.message || 'Unknown error'}`);
                    failed++;
                }

                if (this.pacingDelay > 1000) {
                    this.updateProgress(`Pacing... Next page in ${Math.round(this.pacingDelay / 1000)}s`);
                }
                await this.sleep(this.pacingDelay);
            }
        } finally {
            this.plugin.settings.autoSaveOverlay = originalAutoSave;
            const summary = `🏁 Finished: ${completed}/${totalPagesToProcess} succeeded${failed ? `, ${failed} failed` : ''}.`;
            this.updateProgress(summary);
            new Notice(summary, 7000);
        }
    }

    /**
     * A robust retry mechanism that handles transient errors.
     */
    private async retryWithBackoff<T>(
        operation: () => Promise<T>,
        pageNum: number
    ): Promise<T> {
        const maxRetries = 3;
        const baseDelay = 1500;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (this.isCancelled) throw new Error('Operation cancelled');
            try {
                return await operation();
            } catch (error) {
                if (attempt < maxRetries - 1) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    this.updateProgress(`Page ${pageNum} failed (attempt ${attempt + 1}), retrying in ${delay / 1000}s...`);
                    await this.sleep(delay);
                } else {
                    throw error;
                }
            }
        }
        throw new Error('Retry mechanism failed unexpectedly.');
    }

    onClose() {
        this.contentEl.empty();
        if (this.isProcessing) {
            this.cleanup();
        }
    }

    private cleanup() {
        this.isProcessing = false;

        // MODIFIED: Clear the cache on cleanup
        this.translationCache.clear();

        this.activeOverlays.forEach(overlay => overlay.parentElement?.removeChild(overlay));
        this.activeOverlays = [];

        clearTimeout(this.retryTimeout);

        if (TranslateMultiplePagesModal.currentInstance === this) {
            TranslateMultiplePagesModal.isBulkTranslationInProgress = false;
            TranslateMultiplePagesModal.currentInstance = null;
        }
    }

    private async estimateTotalPages(): Promise<number> {
        await this.sleep(500);
        const viewer = await this.waitForEl('.pdfViewer', 8000);
        return viewer?.querySelectorAll('.page[data-page-number]').length || 1;
    }

    private async navigateToPage(pdfLeaf: any, pageNum: number): Promise<boolean> {
        if (this.isCancelled) return false;

        const pdfView = pdfLeaf.view;
        const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNum}"]`);
        if (!pdfView || !pageEl) {
            console.error(`PDF view or page element ${pageNum} not found.`);
            return false;
        }

        pageEl.scrollIntoView({ block: 'nearest' });

        const success = await this.waitForCondition(() => {
            const rect = pageEl.getBoundingClientRect();
            const viewHeight = window.innerHeight || document.documentElement.clientHeight;
            return rect.bottom > 0 && rect.top < viewHeight;
        }, 15000);

        if (!success) console.warn(`Failed to confirm page ${pageNum} is in view.`);
        await this.sleep(500);
        return true;
    }

    private async waitForPageAndTextLayer(pageNum: number, timeoutMs: number): Promise<HTMLElement | null> {
        return this.waitForCondition(async () => {
            const pageEl = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNum}"] .textLayer`);
            const hasText = pageEl?.querySelector('span[role="presentation"]')?.textContent?.trim().length ?? 0 > 0;
            return hasText ? pageEl!.parentElement as HTMLElement : null;
        }, timeoutMs, 250);
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            if (this.isCancelled) return resolve();
            this.retryTimeout = window.setTimeout(resolve, ms);
        });
    }

    private async waitForEl(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
        return this.waitForCondition(() => document.querySelector<HTMLElement>(selector), timeoutMs);
    }

    private async waitForCondition<T>(
        condition: () => T | null | false,
        timeoutMs: number,
        intervalMs: number = 100
    ): Promise<T | null> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isCancelled) return null;
            const result = condition();
            if (result) return result;
            await this.sleep(intervalMs);
        }
        return null;
    }

    static isTranslationInProgress(): boolean {
        return this.isBulkTranslationInProgress;
    }

    static cancelCurrentTranslation(): boolean {
        if (this.currentInstance?.isProcessing) {
            this.currentInstance.isCancelled = true;
            return true;
        }
        return false;
    }
}