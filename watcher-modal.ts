// watcher-modal.ts
// Queue view for the PDF watcher: list detected PDFs, run one / run all, remove.

import { App, Modal, Setting, ButtonComponent, Notice } from 'obsidian';
import { t } from './i18n';
import type OpenRouterTranslatorPlugin from './main';
import { TFile } from 'obsidian';
// Stage 0.5 (Q22): SingletonModal with 'focus' reopen behavior — opening
// a second watcher modal just brings the existing one to the front
// instead of replacing it (which would lose scroll position).
import { SingletonModal } from './modal-base';

type SortMode = 'addedAt' | 'name' | 'modifiedAt';

export class WatcherQueueModal extends SingletonModal<WatcherQueueModal> {
    private plugin: OpenRouterTranslatorPlugin;
    private listEl: HTMLElement | null = null;
    private sortMode: SortMode = 'addedAt';
    private selectedPaths: Set<string> = new Set();

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    // Stage 0.5 (Q22): 'focus' instead of default 'replace' — the watcher
    // modal shows live progress; opening a second one would just duplicate
    // the view. Better to bring the existing one to the front.
    protected reopenBehavior() {
        return 'focus' as const;
    }

    onOpen() {
        this.titleEl.setText(t('modal.watcher.title'));
        const watcher = this.plugin.watcher;

        // Show which engine is active.
        const engine = this.plugin.settings.layoutEngine;
        const engineLabel = engine === 'python' ? 'Python (PyMuPDF)' : 'Internal (pdfjs)';
        this.titleEl.createEl('span', {
            text: `  [${engineLabel}]`,
            attr: { style: 'font-size: 0.75em; color: var(--text-muted); margin-left: 8px;' }
        });

        // ── Row 1: Sort control ──
        const sortSetting = new Setting(this.contentEl)
            .setName(t('watcher.queue.label'))
            .setDesc(t('modal.watcher.desc'));
        sortSetting.addDropdown(dd => {
            dd.addOption('addedAt', t('modal.watcher.sort.addedAt'))
              .addOption('name', t('modal.watcher.sort.name'))
              .addOption('modifiedAt', t('modal.watcher.sort.modifiedAt'))
              .setValue(this.sortMode)
              .onChange(v => {
                  this.sortMode = v as SortMode;
                  this.render();
              });
        });

        // ── Row 2: Action buttons ──
        const actionSetting = new Setting(this.contentEl).setName('');
        actionSetting.addButton(b => b.setButtonText(t('watcher.queue.btn.scan')).onClick(async () => {
            const n = await watcher.scanExisting();
            this.render();
            if (n === 0) this.flash(t('modal.watcher.scan.none'));
        }));
        actionSetting.addButton(b => b.setButtonText(t('modal.watcher.scanAll')).onClick(async () => {
            const n = await watcher.scanAllUntranslated();
            this.render();
            new Notice(n > 0 ? `Found ${n} untranslated PDF(s) in vault.` : 'No untranslated PDFs found in vault.', 4000);
        }));
        // FIX: "Translate Selected" — runs each checked file through watcher.runOne
        // for proper progress tracking + cancel support (bg-queue audit fix).
        // Previously called enqueuePdf directly → no onChange subscription, no
        // progress updates, items stuck at "running" forever.
        actionSetting.addButton(b => b.setButtonText(t('modal.watcher.translateSelected')).setCta().onClick(async () => {
            const paths = [...this.selectedPaths];
            if (paths.length === 0) {
                new Notice('Select at least one file first (checkboxes on the left).', 3000);
                return;
            }
            this.selectedPaths.clear();
            // Run each file through watcher.runOne (serial — runAllPending pattern)
            for (const path of paths) {
                await watcher.runOne(path);
            }
            this.render();
        }));
        actionSetting.addButton(b => b.setButtonText(t('modal.watcher.btn.runall')).onClick(async () => {
            await watcher.runAllPending();
        }));
        actionSetting.addButton(b => b.setButtonText(t('modal.watcher.clearFinished')).onClick(() => {
            let cleared = 0;
            for (const item of this.plugin.watcher.getQueue()) {
                if (item.status === 'done' || item.status === 'skipped' || item.status === 'error') {
                    this.plugin.watcher.remove(item.path);
                    cleared++;
                }
            }
            this.render();
            new Notice(cleared > 0 ? `Cleared ${cleared} finished item(s).` : 'No finished items to clear.', 3000);
        }));

        // Auto-scan all untranslated PDFs on modal open (non-blocking).
        void watcher.scanAllUntranslated().then(n => {
            if (n > 0) {
                new Notice(`Found ${n} untranslated PDF(s) in vault.`, 3000);
                this.render();
            }
        });

        // Background queue section (PdfLayoutQueue state).
        this.renderLayoutQueueSection();

        // File list.
        this.listEl = this.contentEl.createDiv();
        watcher.setOnChange(() => this.render());
        this.render();
    }

    /**
     * FIX: render a section showing PdfLayoutQueue state. This covers
     * translations started via:
     *   - TranslateMultiplePagesModal (enqueuePageRange)
     *   - "Layout: extract entire PDF (background)" command (enqueuePdf)
     *   - "Layout: extract current page (background)" command (enqueuePage)
     *
     * Without this section, the user would have no visibility into background
     * translations that weren't triggered by the watcher.
     */
    private layoutQueueSection: HTMLElement | null = null;
    private layoutQueueUnsub: (() => void) | null = null;

    private renderLayoutQueueSection() {
        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) return;

        this.layoutQueueSection = this.contentEl.createDiv();
        this.layoutQueueSection.createEl('h3', {
            text: t('modal.watcher.backgroundQueue'),
            attr: { style: 'margin-top: 16px; margin-bottom: 8px;' },
        });

        const queueList = this.layoutQueueSection.createDiv();
        const renderQueue = () => {
            queueList.empty();
            const state = queue.getState();

            // Phase 14.4: was `this.layoutQueueSection.createEl('p', {...})`
            // which created a NEW `<p>` on every render, leaving stale
            // duplicates stacked up in the DOM. Now we re-use a single
            // `.queue-summary` div (created on first render, looked up
            // thereafter) and update its `textContent` in place.
            let summaryDiv = this.layoutQueueSection.querySelector('.queue-summary') as HTMLElement | null;
            if (!summaryDiv) {
                summaryDiv = this.layoutQueueSection.createDiv({ cls: 'queue-summary' });
                summaryDiv.style.cssText = 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px;';
                // Insert before the queueList so the summary stays on top.
                this.layoutQueueSection.insertBefore(summaryDiv, queueList);
            }

            if (state.files.length === 0) {
                summaryDiv.textContent = '';
                queueList.createEl('p', {
                    text: t('modal.watcher.noBackground'),
                    attr: { style: 'color: var(--text-muted); font-size: 0.9em;' },
                });
                return;
            }

            // Summary line (updated in place — no DOM churn)
            summaryDiv.textContent =
                t('modal.watcher.summary', {
                    pending: String(state.totalPending),
                    done: String(state.totalDone),
                    failed: String(state.totalError),
                });

            // Per-file rows
            for (const fileState of state.files) {
                const tasks = [...fileState.tasks.values()];
                const done = tasks.filter(t => t.status === 'done').length;
                const err = tasks.filter(t => t.status === 'error').length;
                const pend = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
                const total = fileState.totalPages || tasks.length;

                const row = new Setting(queueList)
                    .setName(fileState.file.basename)
                    .setDesc(
                        (err > 0
                            ? t('modal.watcher.rowStatusWithError', { done: String(done), total: String(total), pend: String(pend), err: String(err) })
                            : t('modal.watcher.rowStatus', { done: String(done), total: String(total), pend: String(pend) })
                        ) + (queue.isCancelled() ? t('modal.watcher.paused') : '')
                    );

                if (pend > 0 && !queue.isCancelled()) {
                    row.addButton(b => b
                        .setButtonText(t('modal.watcher.pause'))
                        .onClick(() => {
                            queue.cancel();
                            renderQueue();
                        }));
                } else if (queue.isCancelled() && state.totalPending > 0) {
                    row.addButton(b => b
                        .setButtonText(t('modal.watcher.resume'))
                        .setCta()
                        .onClick(() => {
                            queue.resume();
                            renderQueue();
                        }));
                }
            }
        };
        renderQueue();
        this.layoutQueueUnsub = queue.onChange(renderQueue);
    }

    private flash(msg: string) {
        if (!this.listEl) return;
        const p = this.listEl.createEl('p', { text: msg, cls: 'setting-item-description' });
        setTimeout(() => p.remove(), 2500);
    }

    private statusLabel(s: string): string {
        return ({ pending: t('modal.watcher.status.pending'), running: t('modal.watcher.status.running'), done: t('modal.watcher.status.done'), error: t('modal.watcher.status.error'), skipped: t('modal.watcher.status.skipped') } as any)[s] || s;
    }

    private render() {
        const el = this.listEl;
        if (!el) return;
        el.empty();

        let items = this.plugin.watcher.getQueue();
        if (items.length === 0) {
            el.createEl('p', { text: t('modal.watcher.empty'), cls: 'setting-item-description' });
            return;
        }

        // FIX: sort items based on sortMode
        items = this.sortItems(items);

        const isRunning = this.plugin.watcher.isRunning();

        for (const item of items) {
            // FIX: get file modification time and size for display
            const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
            let fileInfo = '';
            if (file instanceof TFile) {
                const mtime = file.stat.mtime;
                const size = file.stat.size;
                const dateStr = new Date(mtime).toLocaleDateString();
                const sizeStr = size > 1024 * 1024
                    ? `${(size / 1024 / 1024).toFixed(1)} MB`
                    : `${Math.round(size / 1024)} KB`;
                fileInfo = ` · ${dateStr} · ${sizeStr}`;
            }

            const row = new Setting(el)
                .setName(item.name)
                .setDesc(`${this.statusLabel(item.status)}${item.message ? ' — ' + item.message : ''}${fileInfo}`);

            // FIX: add checkbox for multi-select (only for non-running items)
            if (item.status !== 'running') {
                row.addExtraButton(b => {
                    b.setIcon(this.selectedPaths.has(item.path) ? 'check-square' : 'square')
                        .setTooltip(this.selectedPaths.has(item.path) ? 'Deselect' : 'Select')
                        .onClick(() => {
                            if (this.selectedPaths.has(item.path)) {
                                this.selectedPaths.delete(item.path);
                            } else {
                                this.selectedPaths.add(item.path);
                            }
                            this.render();
                        });
                });
            }

            // FIX (W-7): every non-running item gets a Translate button.
            // Don't disable when another job is running — PdfLayoutQueue supports
            // multiple files. Individual "Translate" enqueues into the queue
            // (non-blocking).
            if (item.status === 'running') {
                row.addButton((b: ButtonComponent) => b
                    .setButtonText(t('modal.watcher.btn.cancel'))
                    .setDisabled(false)
                    .onClick(async () => {
                        this.plugin.watcher.cancelRunning();
                    }));
            } else if (item.status === 'done' || item.status === 'skipped') {
                // P2-16 (Phase 11): "Retranslate" — use enqueuePageRange(1, totalPages)
                // so EVERY page is re-queued (reset to `pending`), even pages whose
                // overlays are already on disk. The previous shared handler called
                // `enqueuePdf`, which silently skipped cached pages — so "Retranslate"
                // on an already-translated file was a no-op, leaving the user
                // staring at unchanged overlays after switching providers or editing
                // a prompt. enqueuePageRange's reset-to-pending branch (see
                // pdf-layout-queue.ts lines 311-323) only skips tasks currently
                // `running`, so it's safe even if another job is mid-flight.
                row.addButton((b: ButtonComponent) => b
                    .setButtonText(t('modal.watcher.btn.retranslate'))
                    .onClick(async () => {
                        if (file instanceof TFile) {
                            try {
                                const totalPages = await this.plugin.pdfLayoutService.getPageCount(file);
                                const count = await this.plugin.pdfLayoutQueue.enqueuePageRange(file, 1, totalPages);
                                item.status = 'running';
                                item.message = `${count} pages re-queued`;
                                this.render();
                                new Notice(`Re-queued ${count} pages for "${item.name}".`, 3000);
                            } catch (e: any) {
                                new Notice(`Retranslate failed: ${e?.message || e}`);
                            }
                        }
                    }));
            } else {
                // P2-15 (Phase 11): per-item "Translate" button now routes through
                // `watcher.runOne(file.path)` instead of calling
                // `pdfLayoutQueue.enqueuePdf` directly. runOne updates the
                // QueueItem to `running`, subscribes to queue progress to relay
                // per-page status into `item.message` (so the modal shows live
                // `worker: 3/12 done, 9 pending` updates), waits for completion
                // via waitForQueueCompletion, and finally marks the item
                // `done` / `error` based on the terminal task states. The
                // previous direct `enqueuePdf` call left the item stuck at
                // `running` forever — it only kicked the queue and never
                // observed the result.
                row.addButton((b: ButtonComponent) => b
                    .setButtonText(t('modal.watcher.btn.translate'))
                    .onClick(async () => {
                        if (file instanceof TFile) {
                            item.status = 'running';
                            item.message = 'Starting...';
                            this.render();
                            void this.plugin.watcher.runOne(file.path).then(() => {
                                this.render();
                            });
                        }
                    }));
            }
            row.addExtraButton(b => b.setIcon('trash').setTooltip(t('modal.watcher.btn.remove')).onClick(() => {
                this.plugin.watcher.remove(item.path);
                this.selectedPaths.delete(item.path);
            }));
        }
    }

    /**
     * FIX: sort items based on current sortMode.
     * - 'addedAt': by queue-add time (oldest first)
     * - 'name': alphabetical by filename
     * - 'modifiedAt': by file modification time (newest first)
     */
    private sortItems(items: any[]): any[] {
        const sorted = [...items];
        switch (this.sortMode) {
            case 'name':
                sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                break;
            case 'modifiedAt':
                sorted.sort((a, b) => {
                    const fa = this.plugin.app.vault.getAbstractFileByPath(a.path);
                    const fb = this.plugin.app.vault.getAbstractFileByPath(b.path);
                    const ma = (fa instanceof TFile) ? fa.stat.mtime : 0;
                    const mb = (fb instanceof TFile) ? fb.stat.mtime : 0;
                    return mb - ma;  // newest first
                });
                break;
            case 'addedAt':
            default:
                sorted.sort((a, b) => a.addedAt - b.addedAt);
                break;
        }
        // Always sort running items to top so user sees active job first
        sorted.sort((a, b) => {
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (b.status === 'running' && a.status !== 'running') return 1;
            return 0;
        });
        return sorted;
    }

    onClose() {
        this.plugin.watcher.setOnChange(null);
        if (this.layoutQueueUnsub) {
            this.layoutQueueUnsub();
            this.layoutQueueUnsub = null;
        }
        this.contentEl.empty();
        // Stage 0.5 (Q22): MUST call super.onClose() so SingletonModal can
        // remove us from the per-subclass instances Map.
        super.onClose();
    }
}
