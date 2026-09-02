// modal.ts
// ─────────────────────────────────────────────────────────────────────────
// MIGRATED: TranslateMultiplePagesModal is now a thin wrapper over
// PdfLayoutQueue (background worker pipeline).
//
// Previously: full DOM-based pipeline (~520 lines) that navigated pages,
// waited for text layers, called translatePageContent + createOverlayWithText
// per page, verified overlays, and saved. Required the PDF to be open and
// blocked the UI during translation.
//
// Now: enqueues a page range into PdfLayoutQueue and subscribes to its
// onChange for live progress. The worker handles extraction+translation+save
// in the background. The PDF does NOT need to be open. The modal can be
// closed without aborting the translation — the queue continues running.
//
// Removed features:
//   - Time-window pacing (worker uses concurrency + sequentialDelayMs instead)
//   - Per-page retry with exponential backoff (TranslationEngine handles retries)
//   - DOM navigation / waitForPageAndTextLayer (worker reads bytes directly)
//   - Overlay verification (worker writes verified data via updatePageOverlaysAndWrite)
//   - Translation cache (worker doesn't re-translate cached pages)
//
// Phase 14 (C14): now extends `SingletonModal<TranslateMultiplePagesModal>`
// instead of `Modal`. SingletonModal tracks open instances per subclass and
// either replaces or focuses the existing instance when a second `open()` is
// called. This eliminates the previous static `isBulkTranslationInProgress` /
// `currentInstance` fields, which duplicated that responsibility (and could
// get out of sync with the queue's actual state).
//
// Translation-in-progress detection now consults `pdfLayoutQueue` directly:
//   - "Is a translation running?" → `queue.isRunning() || state.totalPending > 0`
//   - "Which file is being translated?" → first file in `state.files` with
//     any non-done task.
// ─────────────────────────────────────────────────────────────────────────

import { Setting, Notice, ButtonComponent, TFile } from 'obsidian';
import { t } from './i18n';
import OpenRouterTranslatorPlugin from './main';
import { SingletonModal } from './modal-base';

export class TranslateMultiplePagesModal extends SingletonModal<TranslateMultiplePagesModal> {
    plugin: OpenRouterTranslatorPlugin;
    file: TFile;

    // User-configurable settings for the current job
    startPage: number = 1;
    endPage: number = 1;
    totalPages: number = 1;

    // UI state
    private progressEl: HTMLElement | null = null;
    private unsubQueue: (() => void) | null = null;

    // Phase 14.3: holds references to the Start / Close buttons so they can
    // be disabled during the async `startWorkerTranslation()` call. Prevents
    // a double-click from enqueuing the same page range twice.
    private startBtn: ButtonComponent | null = null;
    private closeBtn: ButtonComponent | null = null;
    private cancelBtn: ButtonComponent | null = null;  // Bug fix (bg-queue audit): Cancel in start view

    constructor(plugin: OpenRouterTranslatorPlugin, file: TFile) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
    }

    /**
     * Phase 14 (C14): 'focus' reopen behavior. If the user triggers the
     * "Translate multiple pages" command while this modal is already open
     * (e.g. from the command palette while inspecting progress), we focus
     * the existing instance instead of closing it and opening a new one —
     * the new instance would lose the live progress subscription.
     */
    protected reopenBehavior() {
        return 'focus' as const;
    }

    /**
     * Returns the file currently being translated by the queue, or `null`
     * if no translation is in progress. Replaces the old `currentInstance.file`
     * static-field lookup — now derived from live queue state so it can never
     * go stale.
     */
    private getRunningQueueFile(): TFile | null {
        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) return null;
        const state = queue.getState();
        if (state.totalPending === 0 && !queue.isRunning()) return null;
        for (const fs of state.files) {
            for (const task of fs.tasks.values()) {
                if (task.status === 'pending' || task.status === 'running') {
                    return fs.file;
                }
            }
        }
        return null;
    }

    /**
     * FIX: returns ALL files in the queue with pending/running tasks.
     * Used by the management view to show the full queue, not just the
     * first running file.
     */
    private getAllQueuedFiles(): Array<{ file: TFile; done: number; total: number; pending: number; error: number }> {
        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) return [];
        const state = queue.getState();
        const result: Array<{ file: TFile; done: number; total: number; pending: number; error: number }> = [];
        for (const fs of state.files) {
            const tasks = [...fs.tasks.values()];
            const done = tasks.filter(t => t.status === 'done').length;
            const pending = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
            const error = tasks.filter(t => t.status === 'error').length;
            const total = fs.totalPages || tasks.length;
            if (pending > 0 || done > 0 || error > 0) {
                result.push({ file: fs.file, done, total, pending, error });
            }
        }
        return result;
    }

    /**
     * Called when the modal is opened. Renders the UI.
     */
    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Phase 14 (C14): the static `isBulkTranslationInProgress` flag is
        // gone. We consult the queue directly: if any file has pending or
        // running tasks, show the management view; otherwise show the start
        // view. This is more accurate than the flag (which had to be set/
        // cleared manually and could drift out of sync with the queue).
        const runningFile = this.getRunningQueueFile();
        if (runningFile) {
            this.displayManagementView(contentEl, runningFile);
            return;
        }

        this.titleEl.setText(t('modal.translate.title'));
        contentEl.createEl('p', { text: `${t('modal.translate.file')} ${this.file.basename}` });

        try {
            this.totalPages = await this.plugin.pdfLayoutService.getPageCount(this.file);
        } catch (err: any) {
            contentEl.createEl('p', {
                text: t('modal.translate.errorPageCount', { error: err?.message ?? String(err) }),
                attr: { style: 'color: var(--text-error);' },
            });
            return;
        }
        // FIX: use {n} placeholder instead of concatenation (was producing
        // "Всего {n} страниц 10" instead of "Всего 10 страниц").
        this.endPage = this.totalPages;
        contentEl.createEl('p', { text: t('modal.translate.total', { n: String(this.totalPages) }) });

        this.renderSettings(contentEl);

        const progressContainer = contentEl.createDiv({ cls: 'translator-progress-container' });
        this.progressEl = progressContainer;

        const buttonContainer = contentEl.createDiv({ cls: 'translator-button-container' });
        this.renderActionButtons(buttonContainer);
    }

    /**
     * Renders a view to manage an in-progress translation job.
     * FIX: now shows ALL queued files, not just the first running one.
     */
    private displayManagementView(contentEl: HTMLElement, runningFile: TFile) {
        this.titleEl.setText(t('modal.translate.inProgress'));

        contentEl.createEl('p', { text: t('modal.translate.backgroundRunning') });

        // FIX: create a container for per-file progress rows
        const progressContainer = contentEl.createDiv({ cls: 'translator-progress-container' });

        const queue = this.plugin.pdfLayoutQueue;
        if (queue) {
            const updateProgress = () => {
                progressContainer.empty();

                // FIX: show all queued files, not just runningFile
                const allFiles = this.getAllQueuedFiles();
                if (allFiles.length === 0) {
                    progressContainer.createEl('p', {
                        text: t('modal.translate.noActive'),
                        attr: { style: 'color: var(--text-muted);' },
                    });
                    return;
                }

                for (const item of allFiles) {
                    const fileRow = progressContainer.createEl('div', {
                        cls: 'translator-file-progress',
                        attr: { style: 'padding: 8px 0; border-bottom: 1px solid var(--background-modifier-border);' },
                    });

                    // File name
                    fileRow.createEl('div', {
                        text: item.file.basename,
                        attr: { style: 'font-weight: 600; margin-bottom: 4px;' },
                    });

                    // Progress text
                    const progressText = item.error > 0
                        ? t('modal.translate.progressWithError', {
                            done: String(item.done),
                            total: String(item.total),
                            pend: String(item.pending),
                            err: String(item.error),
                        })
                        : t('modal.translate.progress', {
                            done: String(item.done),
                            total: String(item.total),
                            pend: String(item.pending),
                        });
                    fileRow.createEl('div', {
                        text: progressText,
                        attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
                    });

                    // Progress bar
                    if (item.total > 0) {
                        const pct = Math.round((item.done / item.total) * 100);
                        const barContainer = fileRow.createEl('div', {
                            attr: {
                                style: 'margin-top: 4px; height: 6px; background: var(--background-modifier-border); border-radius: 3px; overflow: hidden;',
                            },
                        });
                        barContainer.createEl('div', {
                            attr: {
                                style: `height: 100%; width: ${pct}%; background: var(--interactive-accent); transition: width 0.3s ease;`,
                            },
                        });
                    }
                }
            };
            updateProgress();
            // P1-30 (Phase 5): unsubscribe any previous subscription before
            // overwriting `this.unsubQueue`. Without this, re-entering the
            // management view (e.g. via 'focus' reopenBehavior after a prior
            // onClose failed to clear it, or after a code path that assigned
            // unsubQueue without going through cleanup) would leak the old
            // callback — the queue would keep invoking a closure that
            // references a detached `progressContainer`, growing the
            // listener list indefinitely across reopens.
            if (this.unsubQueue) {
                this.unsubQueue();
                this.unsubQueue = null;
            }
            this.unsubQueue = queue.onChange(updateProgress);
        }

        const buttonContainer = contentEl.createDiv({ cls: 'translator-button-container' });

        new ButtonComponent(buttonContainer)
            .setButtonText(t('modal.translate.cancelTranslation'))
            .setWarning()
            .onClick(() => {
                if (queue) {
                    queue.cancel();
                    new Notice(
                        t('modal.translate.translationCancelled'),
                        6000,
                    );
                }
                this.close();
            });

        new ButtonComponent(buttonContainer)
            .setButtonText(t('modal.translate.close'))
            .onClick(() => this.close());
    }

    /**
     * Renders the settings for page range.
     */
    private renderSettings(contentEl: HTMLElement) {
        let startInput: HTMLInputElement;
        let endInput: HTMLInputElement;
        let validationMsg: HTMLElement;

        // FIX: add validation message element for real-time feedback.
        // Without it, user can type invalid values and only see an error
        // after clicking Start — confusing UX.
        const validationEl = contentEl.createEl('p', {
            cls: 'translator-page-validation',
            attr: { style: 'color: var(--text-warning); font-size: 0.85em; min-height: 1.2em; margin: 4px 0;' },
        });
        validationMsg = validationEl;

        const validateAndUpdate = () => {
            const s = this.startPage;
            const e = this.endPage;
            if (s < 1) {
                validationMsg.setText(t('modal.translate.validation.startTooLow'));
                return false;
            }
            if (e < s) {
                validationMsg.setText(t('modal.translate.validation.endBeforeStart'));
                return false;
            }
            if (e > this.totalPages) {
                validationMsg.setText(t('modal.translate.validation.endTooHigh', { total: String(this.totalPages) }));
                return false;
            }
            validationMsg.setText('');
            return true;
        };

        new Setting(contentEl).setName(t('modal.translate.startPage')).addText((cb) => {
            startInput = cb.inputEl;
            cb.setValue(String(this.startPage)).onChange((value) => {
                const n = parseInt(value, 10);
                if (!isNaN(n) && n >= 1 && n <= this.totalPages) {
                    this.startPage = n;
                    validateAndUpdate();
                } else {
                    validationMsg.setText(t('modal.translate.validation.invalid', { total: String(this.totalPages) }));
                }
            });
        });

        new Setting(contentEl).setName(t('modal.translate.endPage')).addText((cb) => {
            endInput = cb.inputEl;
            cb.setValue(String(this.endPage)).onChange((value) => {
                const n = parseInt(value, 10);
                if (!isNaN(n) && n >= 1 && n <= this.totalPages) {
                    this.endPage = n;
                    validateAndUpdate();
                } else {
                    validationMsg.setText(t('modal.translate.validation.invalid', { total: String(this.totalPages) }));
                }
            });
        });

        new Setting(contentEl).addButton((cb) => {
            cb.setButtonText(t('modal.translate.allPages')).setCta().onClick(() => {
                this.startPage = 1;
                this.endPage = this.totalPages;
                startInput.value = '1';
                endInput.value = String(this.totalPages);
                validationMsg.setText('');
            });
        });

        // Info note about worker mode
        contentEl.createEl('p', {
            text: t('modal.translate.workerInfo'),
            attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-top: 12px;' },
        });
    }

    /**
     * Renders the Start, Cancel, and Close buttons.
     */
    private renderActionButtons(container: HTMLElement) {
        this.startBtn = new ButtonComponent(container)
            .setButtonText(t('modal.translate.btn.start'))
            .setCta()
            .onClick(async () => {
                if (this.startPage > this.endPage) {
                    new Notice(t('modal.translate.startPageError'));
                    return;
                }

                // Phase 14.3: disable BOTH buttons for the duration of the
                // await. Previously only Start was disabled, leaving Close
                // clickable — a fast double-click could enqueue the range
                // and immediately close the modal, losing the live progress
                // subscription. With both disabled, the user has to wait
                // for the enqueue to settle.
                this.startBtn?.setDisabled(true);
                this.closeBtn?.setDisabled(true);

                try {
                    await this.startWorkerTranslation();
                    // FIX: after enqueue, show immediate feedback so user knows
                    // the process started. Without this, there's a delay between
                    // clicking Start and the first progress update from queue.onChange.
                    this.updateProgress(t('modal.translate.starting'));
                    // Bug fix (bg-queue audit): show Cancel button now that translation
                    // is running, so user can stop it without closing the modal.
                    this.cancelBtn?.setDisabled(false);
                } catch (err: any) {
                    new Notice(t('modal.translate.failedToStart', { error: err.message }), 7000);
                    console.error('Worker translation failed to start:', err);
                    this.cleanup();
                } finally {
                    // Re-enable Close so the user can dismiss the modal after
                    // the worker has been enqueued. Start stays disabled once
                    // translation has begun (re-enabling would allow a second
                    // enqueue on top of the running one).
                    this.closeBtn?.setDisabled(false);
                }
            });

        // Bug fix (bg-queue audit): add Cancel button to start view so user can
        // stop a running translation without closing the modal. Previously the
        // Cancel button only existed in the management view (which only shows
        // when a PRIOR run was already in progress on modal open).
        this.cancelBtn = new ButtonComponent(container)
            .setButtonText(t('modal.translate.cancelTranslation'))
            .setWarning()
            .setDisabled(true)  // enabled after Start succeeds
            .onClick(() => {
                const queue = this.plugin.pdfLayoutQueue;
                if (queue) {
                    queue.cancel();
                    new Notice(t('modal.translate.translationCancelled'), 6000);
                    this.updateProgress(t('modal.translate.translationCancelled'));
                }
                this.startBtn?.setDisabled(false);
                this.cancelBtn?.setDisabled(true);
            });

        this.closeBtn = new ButtonComponent(container)
            .setButtonText(t('modal.translate.close'))
            .onClick(() => this.close());
    }

    /**
     * Enqueue the page range into PdfLayoutQueue and subscribe to progress.
     */
    private async startWorkerTranslation() {
        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) {
            new Notice(t('modal.translate.queueUnavailable'), 6000);
            this.cleanup();
            return;
        }

        // Subscribe to queue state changes for live progress
        const fileKey = this.file.path;
        // P1-30 (Phase 5): unsubscribe any previous subscription before
        // overwriting `this.unsubQueue`. The Start button can be clicked
        // multiple times in succession if the prior enqueue returned 0
        // cached pages and the modal wasn't dismissed — each click would
        // overwrite `unsubQueue` without unsubscribing the previous one,
        // leaking the closure and double-firing progress callbacks.
        if (this.unsubQueue) {
            this.unsubQueue();
            this.unsubQueue = null;
        }
        this.unsubQueue = queue.onChange(() => {
            this.updateProgressFromQueue(queue, fileKey);
        });

        try {
            const count = await queue.enqueuePageRange(this.file, this.startPage, this.endPage);

            if (count === 0) {
                new Notice(
                    t('modal.translate.allCached', { start: String(this.startPage), end: String(this.endPage) }),
                    5000,
                );
                this.updateProgress(t('modal.translate.allCachedNothing'));
                this.cleanup();
                return;
            }

            this.updateProgress(
                t('modal.translate.queued', { count: String(count), start: String(this.startPage), end: String(this.endPage) })
            );
            new Notice(
                t('modal.translate.started', { count: String(count), file: this.file.basename }),
                4000,
            );

            // Don't close the modal — show live progress until done.
            // The user can close manually; the queue continues in background.
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            console.error('[TranslateMultiplePagesModal] enqueuePageRange failed:', err);
            new Notice(t('modal.translate.failedToQueue', { error: msg }), 7000);
            this.cleanup();
        }
    }

    private updateProgress(msg: string) {
        if (this.progressEl) {
            this.progressEl.setText(msg);
        }
    }

    private updateProgressFromQueue(queue: any, fileKey: string) {
        const state = queue.getState();
        const fileState = state.files.find((f: any) => f.file.path === fileKey);
        if (!fileState) return;

        const tasks = [...fileState.tasks.values()];
        const done = tasks.filter((t: any) => t.status === 'done').length;
        const err = tasks.filter((t: any) => t.status === 'error').length;
        const pend = tasks.filter((t: any) => t.status === 'pending' || t.status === 'running').length;
        const total = fileState.totalPages || tasks.length;

        const status = err > 0
            ? t('modal.translate.progressWithError', { done: String(done), total: String(total), pend: String(pend), err: String(err) })
            : t('modal.translate.progress', { done: String(done), total: String(total), pend: String(pend) });

        this.updateProgress(`🔄 ${status}`);

        if (pend === 0) {
            const summary = err > 0
                ? t('modal.translate.finishedSummary', { done: String(done), total: String(total), err: String(err) })
                : t('modal.translate.finishedSummaryOk', { done: String(done), total: String(total) });
            this.updateProgress(summary);
            new Notice(
                t('modal.translate.completeWithSummary', { summary, file: this.file.basename }),
                7000,
            );
            this.cleanup();
        }
    }

    onClose() {
        this.contentEl.empty();
        // Unsubscribe from queue changes (but DON'T cancel the queue —
        // closing the modal doesn't stop the background translation)
        if (this.unsubQueue) {
            this.unsubQueue();
            this.unsubQueue = null;
        }
        // Phase 14 (C14): MUST call super.onClose() so SingletonModal can
        // remove us from the per-subclass instances Map.
        super.onClose();
    }

    private cleanup() {
        if (this.unsubQueue) {
            this.unsubQueue();
            this.unsubQueue = null;
        }
    }

    /**
     * Returns true if the background queue is currently processing any task.
     * Phase 14 (C14): replaces the old `isBulkTranslationInProgress` static
     * flag — now derived from live queue state so it can never drift.
     */
    static isTranslationInProgress(plugin: OpenRouterTranslatorPlugin): boolean {
        const queue = plugin.pdfLayoutQueue;
        if (!queue) return false;
        return queue.isRunning() || queue.getState().totalPending > 0;
    }

    /**
     * Cancel the currently-running translation via the queue.
     * Returns true if a cancellation was issued.
     */
    static cancelCurrentTranslation(plugin: OpenRouterTranslatorPlugin): boolean {
        const queue = plugin.pdfLayoutQueue;
        if (queue && (queue.isRunning() || queue.getState().totalPending > 0)) {
            queue.cancel();
            return true;
        }
        return false;
    }
}
