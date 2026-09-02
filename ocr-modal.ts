// ocr-modal.ts
// Page-range + progress UI for the OCR "recognize document" workflow.

import { App, Notice, Setting, ButtonComponent, TFile } from 'obsidian';
import { t } from './i18n';
import type OpenRouterTranslatorPlugin from './main';
import { OcrTextTranslator, OcrRunResult } from './ocr-text';
// Stage 0.5 (Q22): SingletonModal prevents two concurrent OcrRecognizeModal
// instances (e.g. user opens it from the command palette while another
// instance is still running). Without this, two OcrTextTranslator instances
// would race on the same `.translated.md` note → data corruption.
import { SingletonModal } from './modal-base';

export class OcrRecognizeModal extends SingletonModal<OcrRecognizeModal> {
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

    // Phase 18.1 (C21): result of the most recent OCR run, kept so we can
    // show a Retry button for failed pages without re-querying the
    // translator. Reset on every fresh `start()` call.
    private lastResult: OcrRunResult | null = null;
    private retrySetting: Setting | null = null;

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
        // P1-29 (Phase 5): wrap getTotalPages in try/catch. If the PDF
        // viewer hasn't fully loaded the document yet (or pdfjs throws
        // an unhandled rejection internally), getTotalPages can reject —
        // previously this aborted onOpen mid-render, leaving the modal
        // with no From/To inputs and no Start button. We fall back to a
        // single-page range and let the user proceed.
        try {
            this.total = await this.plugin.pdfDom.getTotalPages(leaf, true) || 1;
        } catch (err) {
            console.error('Failed to get total pages:', err);
            new Notice('Could not determine page count. Using default.');
            this.total = 1;
        }
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

    /**
     * Phase 18.1 (C21): run OCR on the configured page range, then display
     * a summary line ("OCR complete: 7/10 pages succeeded.") and a Retry
     * button if any pages failed. Retry re-runs ONLY the failed pages.
     *
     * The counter itself lives in `OcrTextTranslator.recognizeDocument`
     * (ocr-text.ts:243-265) — `recognizeDocument` returns
     * `{ done, failed, failedPages }`. We do NOT duplicate the counter
     * here (the original SPEC's proposed `successCount` / `failedCount`
     * fields on the modal would have raced with the translator's own
     * counts). We just consume the result.
     */
    private async start(retryPages?: number[]) {
        if (this.busy) return;

        // For retry: use the failed pages as the range. Validate the
        // from/to inputs against the actual page count.
        const isRetry = Array.isArray(retryPages) && retryPages.length > 0;
        if (!isRetry && this.toPage < this.fromPage) {
            this.setProgress(t('modal.ocr.invalidRange'));
            return;
        }

        // Clear any previous retry Setting before re-rendering.
        if (this.retrySetting) {
            this.retrySetting.settingEl.remove();
            this.retrySetting = null;
        }

        this.busy = true;
        this.startBtn?.setDisabled(true);
        this.cancelBtn?.setButtonText(t('modal.ocr.btn.cancel'));

        const span = isRetry
            ? retryPages!.length
            : (this.toPage - this.fromPage + 1);
        // For retry, show cumulative progress (previous done + retry done)
        // so the user sees a monotically-increasing count instead of
        // restarting from 0.
        const doneOffset = isRetry && this.lastResult ? this.lastResult.done : 0;

        // P1-24 (Phase 5): wrap the recognizeDocument call + post-call
        // bookkeeping in try/finally so `this.busy` is ALWAYS reset, even
        // if recognizeDocument rejects (e.g. getTotalPages throws inside
        // recognizeDocument, getOrCreateNote fails, or any unhandled
        // rejection from the OCR provider bubbles up). Without this, a
        // single failure left `busy = true` permanently — Start stayed
        // disabled and Cancel button showed "Cancel" forever, requiring
        // a plugin reload to recover.
        try {
            const result = await this.translator.recognizeDocument(this.file, {
                fromPage: isRetry ? Math.min(...retryPages!) : this.fromPage,
                toPage: isRetry ? Math.max(...retryPages!) : this.toPage,
                onProgress: (done, _total, page) => {
                    this.setProgress(t('modal.ocr.progress', {
                        p: String(page),
                        done: String(doneOffset + done),
                        total: String(span),
                    }));
                },
            });

            // If retrying, fold the retry's `done` count into the previous
            // result so the displayed summary reflects the cumulative state.
            if (isRetry && this.lastResult) {
                const retriedSet = new Set(retryPages!);
                // Pages that succeeded on retry move from `failed` to `done`.
                const newlyDone = result.done;
                const stillFailed = result.failedPages;
                this.lastResult = {
                    done: this.lastResult.done + newlyDone,
                    failed: stillFailed.length,
                    // Only pages that were retried AND still failed stay in the
                    // failedPages list. Pages that succeeded on retry are dropped.
                    failedPages: stillFailed.filter(p => retriedSet.has(p)),
                };
            } else {
                this.lastResult = result;
            }

            // Summary line
            const total = this.lastResult.done + this.lastResult.failed;
            this.setProgress(t('modal.ocr.result', {
                success: String(this.lastResult.done),
                total: String(total),
            }));

            // Retry button (only if there were failures AND we haven't already
            // exhausted the retry — limit to one retry round to avoid an
            // infinite loop on pages that consistently fail).
            if (this.lastResult.failed > 0 && this.lastResult.failedPages.length > 0) {
                this.retrySetting = new Setting(this.contentEl)
                    .setName(t('modal.ocr.retry.name'))
                    .setDesc(t('modal.ocr.retry.desc', { n: String(this.lastResult.failedPages.length) }))
                    .addButton(b => {
                        b.setButtonText(t('modal.ocr.retry.button'))
                            .setCta()
                            .onClick(() => {
                                const pagesToRetry = [...this.lastResult!.failedPages];
                                void this.start(pagesToRetry);
                            });
                    });
            }
        } catch (err) {
            console.error('[OcrRecognizeModal] recognizeDocument failed:', err);
            new Notice(`OCR failed: ${(err as any)?.message ?? String(err)}`, 7000);
            this.setProgress(`OCR failed: ${(err as any)?.message ?? String(err)}`);
        } finally {
            // P1-24 (Phase 5): always reset busy state and re-enable the
            // Start button, regardless of success or failure.
            this.busy = false;
            this.startBtn?.setDisabled(false);
            this.cancelBtn?.setButtonText(t('modal.ocr.btn.close'));
        }
    }

    onClose() {
        if (this.busy) this.translator.cancel();
        this.contentEl.empty();
        // Stage 0.5 (Q22): MUST call super.onClose() so SingletonModal
        // can remove us from the per-subclass instances Map.
        super.onClose();
    }
}
