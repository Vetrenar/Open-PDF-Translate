// modal-pdf-export.ts
import { Modal, App, Setting, Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { ExportOptions } from './pdf-export';

export class PdfExportModal extends Modal {
    plugin: OpenRouterTranslatorPlugin;
    pdfFile: TFile;
    options: ExportOptions;
    onSubmit: (options: ExportOptions) => void;

    constructor(
        app: App,
        plugin: OpenRouterTranslatorPlugin,
        pdfFile: TFile,
        onSubmit: (options: ExportOptions) => void
    ) {
        super(app);
        this.plugin = plugin;
        this.pdfFile = pdfFile;
        this.onSubmit = onSubmit;
        
        // Initialize with default options from settings
        this.options = {
            preserveOriginalText: plugin.settings.exportPreserveOriginal,
            backgroundColor: plugin.settings.exportBackgroundColor,
            backgroundOpacity: plugin.settings.exportBackgroundOpacity,
            textColor: plugin.settings.exportTextColor,
            autoOpen: plugin.settings.exportAutoOpen,
            outputFileName: `${pdfFile.basename}_translated`
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Export PDF with Translations' });
        
        contentEl.createEl('p', { 
            text: 'Configure export options for merging translation overlays into the PDF.',
            cls: 'setting-item-description'
        });

        // Output file name
        new Setting(contentEl)
            .setName('Output file name')
            .setDesc('Name for the exported PDF (without .pdf extension)')
            .addText(text => text
                .setPlaceholder('my_document_translated')
                .setValue(this.options.outputFileName || '')
                .onChange(value => {
                    this.options.outputFileName = value;
                }));

        // Page selection
        new Setting(contentEl)
            .setName('Pages to export')
            .setDesc('Leave empty to export all pages with translations, or specify pages (e.g., "1,3,5-7")')
            .addText(text => text
                .setPlaceholder('All pages with translations')
                .onChange(value => {
                    if (!value.trim()) {
                        this.options.pages = undefined;
                        return;
                    }
                    
                    try {
                        this.options.pages = this.parsePageSelection(value);
                    } catch (e) {
                        new Notice('Invalid page selection format');
                    }
                }));

        // Preserve original text
        new Setting(contentEl)
            .setName('Preserve original text')
            .setDesc('Keep the original text visible under the translations')
            .addToggle(toggle => toggle
                .setValue(this.options.preserveOriginalText ?? true)
                .onChange(value => {
                    this.options.preserveOriginalText = value;
                }));

        // Background color
        new Setting(contentEl)
            .setName('Background color')
            .setDesc('Color for translation overlay backgrounds (hex format)')
            .addText(text => text
                .setPlaceholder('#FFFFFF')
                .setValue(this.options.backgroundColor || '#FFFFFF')
                .onChange(value => {
                    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
                        this.options.backgroundColor = value;
                    }
                }));

        // Background opacity
        new Setting(contentEl)
            .setName('Background opacity')
            .setDesc('Opacity of translation backgrounds (0-100)')
            .addSlider(slider => slider
                .setLimits(0, 100, 5)
                .setValue(this.options.backgroundOpacity ?? 90)
                .setDynamicTooltip()
                .onChange(value => {
                    this.options.backgroundOpacity = value;
                }));

        // Text color
        new Setting(contentEl)
            .setName('Text color')
            .setDesc('Color for translated text (hex format)')
            .addText(text => text
                .setPlaceholder('#000000')
                .setValue(this.options.textColor || '#000000')
                .onChange(value => {
                    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
                        this.options.textColor = value;
                    }
                }));

        // Auto-open
        new Setting(contentEl)
            .setName('Auto-open exported PDF')
            .setDesc('Automatically open the PDF after export completes')
            .addToggle(toggle => toggle
                .setValue(this.options.autoOpen ?? true)
                .onChange(value => {
                    this.options.autoOpen = value;
                }));

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        buttonContainer.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => {
                this.close();
            });

        const exportButton = buttonContainer.createEl('button', { 
            text: 'Export PDF',
            cls: 'mod-cta'
        });
        exportButton.addEventListener('click', () => {
            this.onSubmit(this.options);
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    /**
     * Parse page selection string like "1,3,5-7" into array of page numbers
     */
    private parsePageSelection(selection: string): number[] {
        const pages: number[] = [];
        const parts = selection.split(',').map(s => s.trim());

        for (const part of parts) {
            if (part.includes('-')) {
                // Range: "5-7"
                const [start, end] = part.split('-').map(s => parseInt(s.trim(), 10));
                if (isNaN(start) || isNaN(end) || start > end) {
                    throw new Error('Invalid range');
                }
                for (let i = start; i <= end; i++) {
                    pages.push(i);
                }
            } else {
                // Single page: "3"
                const page = parseInt(part, 10);
                if (isNaN(page)) {
                    throw new Error('Invalid page number');
                }
                pages.push(page);
            }
        }

        return [...new Set(pages)].sort((a, b) => a - b);
    }
}

/**
 * Quick export modal with minimal options
 */
export class QuickExportModal extends Modal {
    plugin: OpenRouterTranslatorPlugin;
    pdfFile: TFile;
    exportAll: boolean;

    constructor(app: App, plugin: OpenRouterTranslatorPlugin, pdfFile: TFile, exportAll: boolean = false) {
        super(app);
        this.plugin = plugin;
        this.pdfFile = pdfFile;
        this.exportAll = exportAll;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        const title = this.exportAll ? 'Export Full PDF' : 'Export Current Page';
        contentEl.createEl('h2', { text: title });

        const desc = this.exportAll 
            ? 'Export all pages with translations into a new PDF file.'
            : 'Export the current page with translation overlay into a new PDF file.';
        
        contentEl.createEl('p', { text: desc });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        buttonContainer.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => {
                this.close();
            });

        buttonContainer.createEl('button', { 
            text: 'Export',
            cls: 'mod-cta'
        }).addEventListener('click', async () => {
            this.close();
            
            if (this.exportAll) {
                await this.plugin.pdfExport.exportFullPdf();
            } else {
                await this.plugin.pdfExport.quickExportCurrentPage();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
