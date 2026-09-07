// watcher-modal.ts
// Queue view for the PDF watcher: Card Stack layout with Active / Available sections.

import { App, Modal, Setting, ButtonComponent, Notice } from 'obsidian';
import { t } from './i18n';
import type OpenRouterTranslatorPlugin from './main';
import { TFile } from 'obsidian';
import { SingletonModal } from './modal-base';

type SortMode = 'addedAt' | 'name' | 'modifiedAt';

export class WatcherQueueModal extends SingletonModal<WatcherQueueModal> {
    private plugin: OpenRouterTranslatorPlugin;
    private listEl: HTMLElement | null = null;
    private sortMode: SortMode = 'addedAt';
    private layoutQueueUnsub: (() => void) | null = null;

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    protected reopenBehavior() {
        return 'focus' as const;
    }

    onOpen() {
        this.titleEl.setText(t('modal.watcher.title'));
        const watcher = this.plugin.watcher;

        const engine = this.plugin.settings.layoutEngine;
        const engineLabel = engine === 'python' ? 'Python (PyMuPDF)' : 'Internal (pdfjs)';
        this.titleEl.createEl('span', {
            text: `  [${engineLabel}]`,
            attr: { style: 'font-size: 0.75em; color: var(--text-muted); margin-left: 8px;' }
        });

        // ── Sort control ──
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

        // ── Action buttons — flex-wrap to prevent overflow ──
        const btnContainer = this.contentEl.createDiv();
        btnContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0;';

        const scanBtn = btnContainer.createEl('button', { text: t('watcher.queue.btn.scan') });
        scanBtn.style.cssText = 'padding: 4px 10px; font-size: 0.85em;';
        scanBtn.onclick = async () => {
            const n = await watcher.scanExisting();
            this.render();
            if (n === 0) this.flash(t('modal.watcher.scan.none'));
        };

        const scanAllBtn = btnContainer.createEl('button', { text: t('modal.watcher.scanAll') });
        scanAllBtn.style.cssText = 'padding: 4px 10px; font-size: 0.85em;';
        scanAllBtn.onclick = async () => {
            const n = await watcher.scanAllUntranslated();
            this.render();
            new Notice(n > 0 ? t('modal.watcher.scan.found', { n: String(n) }) : t('modal.watcher.scan.none'), 4000);
        };

        const runAllBtn = btnContainer.createEl('button', { text: t('modal.watcher.btn.runall') });
        runAllBtn.style.cssText = 'padding: 4px 10px; font-size: 0.85em; font-weight: bold;';
        runAllBtn.onclick = async () => {
            await watcher.runAllPending();
        };

        const clearBtn = btnContainer.createEl('button', { text: t('modal.watcher.clearFinished') });
        clearBtn.style.cssText = 'padding: 4px 10px; font-size: 0.85em;';
        clearBtn.onclick = () => {
            let cleared = 0;
            for (const item of this.plugin.watcher.getQueue()) {
                if (item.status === 'done' || item.status === 'skipped' || item.status === 'error') {
                    this.plugin.watcher.remove(item.path);
                    cleared++;
                }
            }
            this.render();
            const clearedMsg = cleared > 0
                ? t('modal.watcher.cleared', { n: String(cleared) })
                : t('modal.watcher.noFinished');
            new Notice(clearedMsg, 3000);
        };

        // Auto-scan on open
        void watcher.scanAllUntranslated().then(n => {
            if (n > 0) {
                new Notice(t('modal.watcher.scan.found', { n: String(n) }), 3000);
                this.render();
            }
        });

        // Hint
        const hint = this.contentEl.createDiv();
        hint.style.cssText =
            'font-size: 0.8em; color: var(--text-muted); margin: 6px 0; ' +
            'padding: 4px 8px; border-left: 2px solid var(--background-modifier-border);';
        hint.setText(t('modal.watcher.hint'));

        // File list container — render() fills it with Active + Available sections
        this.listEl = this.contentEl.createDiv();
        watcher.setOnChange(() => this.render());

        // Subscribe to queue changes for live progress
        const queue = this.plugin.pdfLayoutQueue;
        if (queue) {
            this.layoutQueueUnsub = queue.onChange(() => this.render());
        }

        this.render();
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

        items = this.sortItems(items);

        // Split into active (running) and available (everything else)
        const activeItems = items.filter(i => i.status === 'running');
        const availableItems = items.filter(i => i.status !== 'running');

        // ── ACTIVE TRANSLATIONS section (scrollable, limited height) ──
        if (activeItems.length > 0) {
            const activeSection = el.createDiv();
            activeSection.style.cssText = 'margin-bottom: 16px;';

            const activeHeader = activeSection.createDiv();
            activeHeader.style.cssText =
                'font-weight: 600; font-size: 0.8em; text-transform: uppercase; ' +
                'letter-spacing: 1px; color: var(--interactive-accent); margin-bottom: 8px;';
            activeHeader.setText(`▸ ${t('modal.watcher.activeTranslations')} (${activeItems.length})`);

            // Scrollable container with limited height
            const activeList = activeSection.createDiv();
            activeList.style.cssText =
                'max-height: 200px; overflow-y: auto; ' +
                'border: 1px solid var(--interactive-accent); border-radius: 8px; ' +
                'padding: 10px; ' +
                'background: color-mix(in srgb, var(--interactive-accent) 5%, transparent);';

            for (const item of activeItems) {
                const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
                const card = activeList.createDiv();
                card.style.cssText = 'margin-bottom: 10px; padding-bottom: 10px; ' +
                    (activeItems.indexOf(item) < activeItems.length - 1
                        ? 'border-bottom: 1px solid var(--background-modifier-border);'
                        : '');

                // Title row
                const titleRow = card.createDiv();
                titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;';
                titleRow.createEl('span', {
                    text: item.name,
                    attr: { style: 'font-weight: 600; font-size: 0.9em;' }
                });
                const cancelBtn = titleRow.createEl('button', { text: t('modal.watcher.btn.cancel') });
                cancelBtn.style.cssText = 'font-size: 0.8em; padding: 2px 10px;';
                cancelBtn.onclick = () => {
                    this.plugin.watcher.cancelRunning();
                    new Notice(t('modal.watcher.cancelling'), 3000);
                };

                // Status text
                const statusText = `${this.statusLabel(item.status)}${item.message ? ' — ' + item.message : ''}`;
                card.createEl('div', {
                    text: statusText,
                    attr: { style: 'font-size: 0.8em; color: var(--text-muted); margin-bottom: 6px;' }
                });

                // Progress bar
                this.appendProgressBarTo(card, item);
            }
        }

        // ── AVAILABLE FILES section (full, no scroll limit) ──
        if (availableItems.length > 0) {
            const availSection = el.createDiv();

            const availHeader = availSection.createDiv();
            availHeader.style.cssText =
                'font-weight: 600; font-size: 0.8em; text-transform: uppercase; ' +
                'letter-spacing: 1px; color: var(--text-muted); margin-bottom: 8px;';
            availHeader.setText(`▸ ${t('modal.watcher.availableFiles')} (${availableItems.length})`);

            const availList = availSection.createDiv();
            availList.style.cssText =
                'border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 4px;';

            for (const item of availableItems) {
                const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
                let fileInfo = '';
                if (file instanceof TFile) {
                    const size = file.stat.size;
                    const sizeStr = size > 1024 * 1024
                        ? `${(size / 1024 / 1024).toFixed(1)} MB`
                        : `${Math.round(size / 1024)} KB`;
                    fileInfo = ` · ${sizeStr}`;
                }

                const row = availList.createDiv();
                row.style.cssText =
                    'display: flex; justify-content: space-between; align-items: center; ' +
                    'padding: 6px 8px; font-size: 0.85em; ' +
                    'border-bottom: 1px solid var(--background-modifier-border);';
                // Remove border on last item
                if (availableItems.indexOf(item) === availableItems.length - 1) {
                    row.style.borderBottom = 'none';
                }

                // Left: name + status (wrap instead of truncate)
                const leftDiv = row.createDiv();
                leftDiv.style.cssText = 'flex: 1; min-width: 0; margin-right: 8px;';
                leftDiv.createEl('span', {
                    text: item.name,
                    attr: { style: 'font-weight: 500; word-break: break-word;' }
                });
                leftDiv.createEl('span', {
                    text: `  ${this.statusLabel(item.status)}${item.message ? ' — ' + item.message : ''}${fileInfo}`,
                    attr: { style: 'color: var(--text-muted); font-size: 0.9em; word-break: break-word;' }
                });

                // Right: action buttons
                const rightDiv = row.createDiv();
                rightDiv.style.cssText = 'display: flex; gap: 4px; flex-shrink: 0; margin-left: 8px;';

                if (item.status === 'done' || item.status === 'skipped') {
                    const btn = rightDiv.createEl('button', { text: t('modal.watcher.btn.retranslate') });
                    btn.style.cssText = 'font-size: 0.85em; padding: 2px 8px;';
                    btn.onclick = async () => {
                        if (file instanceof TFile) {
                            new Notice(t('modal.watcher.retranslating', { name: item.name }), 3000);
                            void this.plugin.watcher.runOne(file.path, { force: true }).then(() => this.render());
                        }
                    };
                } else {
                    // pending / error
                    const btn = rightDiv.createEl('button', { text: t('modal.watcher.btn.translate') });
                    btn.style.cssText = 'font-size: 0.85em; padding: 2px 8px; font-weight: bold;';
                    btn.onclick = async () => {
                        if (file instanceof TFile) {
                            new Notice(t('modal.watcher.translating', { name: item.name }), 3000);
                            void this.plugin.watcher.runOne(file.path).then(() => this.render());
                        }
                    };
                }

                // Trash button
                const trashBtn = rightDiv.createEl('button', { text: '🗑' });
                trashBtn.style.cssText = 'font-size: 0.85em; padding: 2px 6px; cursor: pointer;';
                trashBtn.title = t('modal.watcher.btn.remove');
                trashBtn.onclick = () => {
                    this.plugin.watcher.remove(item.path);
                };
            }
        }
    }

    private appendProgressBarTo(container: HTMLElement, item: any): void {
        if (item.status !== 'running' || !item.message) return;
        const match = String(item.message).match(/(\d+)\s*\/\s*(\d+)/);
        if (!match) return;
        const done = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
        const pct = Math.max(0, Math.min(100, (done / total) * 100));

        const barContainer = container.createDiv();
        barContainer.style.cssText =
            'height: 8px; background: var(--background-modifier-border); ' +
            'border-radius: 4px; overflow: hidden;';
        const barFill = barContainer.createDiv();
        barFill.style.cssText =
            `height: 100%; width: ${pct.toFixed(1)}%; ` +
            'background: var(--interactive-accent); transition: width 0.3s ease; ' +
            'border-radius: 4px;';
    }

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
                    return mb - ma;
                });
                break;
            case 'addedAt':
            default:
                sorted.sort((a, b) => a.addedAt - b.addedAt);
                break;
        }
        return sorted;
    }

    onClose() {
        this.plugin.watcher.setOnChange(null);
        if (this.layoutQueueUnsub) {
            this.layoutQueueUnsub();
            this.layoutQueueUnsub = null;
        }
        this.contentEl.empty();
        super.onClose();
    }
}
