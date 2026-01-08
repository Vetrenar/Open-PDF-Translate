import { App, Modal, Notice, TextAreaComponent, TFile, ButtonComponent } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
// We don't strictly need OverlayPositionData type here for logic, 
// but it helps if you have strict typing enabled.
import type { OverlayPositionData } from './types'; 

export class EditSpecificTranslationModal extends Modal {
    private plugin: OpenRouterTranslatorPlugin;
    private file: TFile;
    private pageNumber: number;
    private itemIndex: number;
    private originalText: string;
    private currentTranslation: string;
    private newTranslation: string;

    constructor(
        app: App,
        plugin: OpenRouterTranslatorPlugin,
        file: TFile,
        pageNumber: number,
        itemIndex: number,
        originalText: string,
        currentTranslation: string
    ) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.pageNumber = pageNumber;
        this.itemIndex = itemIndex;
        this.originalText = originalText;
        this.currentTranslation = currentTranslation;
        this.newTranslation = currentTranslation;
    }

    onOpen() {
        const { contentEl, titleEl, modalEl } = this;
        
        // 1. Setup Modal styling for a wider/cleaner look
        modalEl.addClass('ort-translation-modal');
        titleEl.setText('Edit Translation');
        
        // 2. Container for Original Text (Read Only)
        contentEl.createEl('h6', { text: 'Original Text', style: 'margin: 0 0 5px 0; color: var(--text-muted);' });
        
        const originalContainer = contentEl.createDiv({ cls: 'ort-original-container' });
        const originalTextArea = new TextAreaComponent(originalContainer);
        
        originalTextArea
            .setValue(this.originalText)
            .setDisabled(true); // Read-only but copyable
            
        // Style the original text area
        originalTextArea.inputEl.style.width = '100%';
        originalTextArea.inputEl.style.height = '150px';
        originalTextArea.inputEl.style.resize = 'vertical';
        originalTextArea.inputEl.style.background = 'var(--background-secondary)';
        originalTextArea.inputEl.style.color = 'var(--text-muted)';
        originalTextArea.inputEl.style.fontFamily = 'var(--font-monospace)';
        originalTextArea.inputEl.style.fontSize = '0.9em';

        // Spacer
        contentEl.createDiv({ style: 'height: 15px;' });

        // 3. Container for Translation (Editable)
        contentEl.createEl('h6', { text: 'Translation', style: 'margin: 0 0 5px 0; color: var(--text-accent);' });

        const translationContainer = contentEl.createDiv({ cls: 'ort-translation-container' });
        const translationTextArea = new TextAreaComponent(translationContainer);

        translationTextArea
            .setValue(this.currentTranslation)
            .setPlaceholder('Enter translation here...')
            .onChange((value) => {
                this.newTranslation = value;
            });

        // Style the editing text area
        translationTextArea.inputEl.style.width = '100%';
        translationTextArea.inputEl.style.height = '200px'; // Taller for editing
        translationTextArea.inputEl.style.resize = 'vertical';
        translationTextArea.inputEl.style.fontFamily = 'var(--font-text)';
        
        // Focus the editor immediately
        setTimeout(() => translationTextArea.inputEl.focus(), 50);

        // 4. Footer / Action Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Save Changes')
            .setCta() // Call to action (accent color)
            .onClick(async () => {
                // Disable button to prevent double clicks
                buttonContainer.addClass('is-loading');
                await this.saveChanges();
                this.close();
            });
    }

    async saveChanges() {
        // Optimization: Don't do anything if text hasn't changed
        if (this.newTranslation === this.currentTranslation) return;

        try {
            // 1. Read the SOURCE OF TRUTH (the file on disk)
            // relying on cache is risky for edits, we want the latest state.
            const result = await this.plugin.storage.readSavedOverlayForFile(this.file);
            
            if (!result || !result.overlay) {
                new Notice('Error: Translation file not found or could not be read.');
                return;
            }

            const { overlay } = result;
            const pageOverlays = overlay.pageOverlays[this.pageNumber];

            // 2. Validate that the data at the index exists
            if (!pageOverlays || !pageOverlays[this.itemIndex]) {
                new Notice('Error: Original translation block not found at this index.');
                console.error(`Index ${this.itemIndex} not found in page data`, pageOverlays);
                return;
            }

            // Optional: Sanity check to ensure we are editing what we think we are editing.
            // We trim() to avoid minor whitespace issues causing false flags.
            const currentStoredText = pageOverlays[this.itemIndex].textContent || '';
            if (currentStoredText.trim() !== this.originalText.trim()) {
                console.warn(`[EditModal] Text mismatch warning. Stored: "${currentStoredText}", Modal saw: "${this.originalText}"`);
                // We proceed anyway because the Index is the authority, but it's good to log.
            }

            // 3. Update the data in memory (Clone to avoid mutation side-effects before save)
            const updatedOverlays = [...pageOverlays];
            
            // Merge existing data with new translation
            updatedOverlays[this.itemIndex] = {
                ...updatedOverlays[this.itemIndex],
                translatedText: this.newTranslation
            };

            // 4. Write back to disk
            // This method handles the file locking/race conditions
            const pagesToUpdate = { [this.pageNumber]: updatedOverlays };
            await this.plugin.storage.updatePageOverlaysAndWrite(this.file, pagesToUpdate);

            // 5. Update Runtime Cache & UI
            if (this.plugin.renderer) {
                // If the renderer keeps a cache, update it to prevent visual reversion
                if (this.plugin.renderer['cachedOverlayData']?.pageOverlays) {
                    this.plugin.renderer['cachedOverlayData'].pageOverlays[this.pageNumber] = updatedOverlays;
                }
                
                // Force visual refresh of this page in the PDF Viewer
                await this.plugin.renderer.loadSavedOverlayForPage(this.pageNumber, true);
            }

            new Notice('Translation updated.');

        } catch (error) {
            console.error('Failed to save translation edit:', error);
            new Notice('Failed to save changes.');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}