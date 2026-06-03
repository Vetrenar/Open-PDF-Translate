// ocr-modal.ts
// Page-range + progress UI for the OCR "recognize document" workflow.

import { App, Modal, Setting, ButtonComponent, TFile } from 'obsidian';
import { t } from './i18n';
import type OpenRouterTranslatorPlugin from './main';
import { OcrTextTranslator } from './ocr-text';

export class OcrRecognizeModal extends Modal {
    private plugin: OpenRouterTranslatorPlugin;
    private file: TFile;
    private translator: OcrTextTranslator;

    private fromPage = 1;
    private toPage = 1;
    private total = 1;

    private progressEl: HTMLElement | null = null;
    private startBtn: ButtonComponent | null = null;
    private cancelBtn: ButtonComponent | null = null;
    private busy = false;

    constructor(app: App, plugin: OpenRouterTranslatorPlugin, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.translator = new OcrTextTranslator(plugin);
    }

    async onOpen() {
        const { contentEl } = this;
        this.titleEl.setText(t('modal.ocr.title'));
        contentEl.createEl('p', { text: `${t('modal.ocr.file')} ${this.file.basename}` });

        // Detect total pages up front (best effort).
        const leaf = this.plugin.pdfDom.resolveLeafForFile(this.file);
        this.total = await this.plugin.pdfDom.getTotalPages(leaf, true) || 1;
        this.toPage = this.total;

        contentEl.createEl('p', {
            text: t('modal.ocr.pages.detected', {n: String(this.total)}),
            cls: 'setting-item-description',
        });

        new Setting(contentEl)
            .setName(t('modal.ocr.from'))
            .addText(t => {
                t.inputEl.type = 'number';
                t.setValue('1').onChange(v => {
                    const n = parseInt(v, 10);
                    this.fromPage = Number.isFinite(n) ? Math.max(1, n) : 1;
                });
            });

        new Setting(contentEl)
            .setName(t('modal.ocr.to'))
            .addText(t => {
                t.inputEl.type = 'number';
                t.setValue(String(this.total)).onChange(v => {
                    const n = parseInt(v, 10);
                    this.toPage = Number.isFinite(n) ? Math.min(this.total, Math.max(1, n)) : this.total;
                });
            });

        this.progressEl = contentEl.createEl('p', { text: '', cls: 'setting-item-description' });

        const controls = new Setting(contentEl);
        controls.addButton(b => {
            this.startBtn = b;
            b.setButtonText(t('modal.ocr.btn.start')).setCta().onClick(() => this.start());
        });
        controls.addButton(b => {
            this.cancelBtn = b;
            b.setButtonText(t('modal.ocr.btn.close')).onClick(() => {
                if (this.busy) { this.translator.cancel(); this.setProgress(t('modal.ocr.btn.cancel') + '…'); }
                else this.close();
            });
        });
    }

    private setProgress(text: string) {
        if (this.progressEl) this.progressEl.setText(text);
    }

    private async start() {
        if (this.busy) return;
        if (this.toPage < this.fromPage) { this.setProgress('Invalid range.'); return; }
        this.busy = true;
        this.startBtn?.setDisabled(true);
        this.cancelBtn?.setButtonText('Cancel');

        const span = this.toPage - this.fromPage + 1;
        await this.translator.recognizeDocument(this.file, {
            fromPage: this.fromPage,
            toPage: this.toPage,
            onProgress: (done, _total, page) => {
                this.setProgress(t('modal.ocr.progress', {p: String(page), done: String(done), total: String(span)}));
            },
        });

        this.busy = false;
        this.startBtn?.setDisabled(false);
        this.cancelBtn?.setButtonText('Close');
        this.setProgress(t('modal.ocr.done'));
    }

    onClose() {
        if (this.busy) this.translator.cancel();
        this.contentEl.empty();
    }
}
