// watcher-modal.ts
// Queue view for the PDF watcher: list detected PDFs, run one / run all, remove.

import { App, Modal, Setting, ButtonComponent } from 'obsidian';
import { t } from './i18n';
import type OpenRouterTranslatorPlugin from './main';

export class WatcherQueueModal extends Modal {
    private plugin: OpenRouterTranslatorPlugin;
    private listEl: HTMLElement | null = null;

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        this.titleEl.setText(t('modal.watcher.title'));
        const watcher = this.plugin.watcher;

        const header = new Setting(this.contentEl)
            .setName(t('watcher.queue.label'))
            .setDesc(t('modal.watcher.desc'));
        header.addButton(b => b.setButtonText(t('watcher.queue.btn.scan')).onClick(async () => {
            const n = await watcher.scanExisting();
            new Setting(this.contentEl); // noop to keep layout consistent
            this.render();
            if (n === 0) this.flash(t('modal.watcher.scan.none'));
        }));
        header.addButton(b => b.setButtonText(t('modal.watcher.btn.runall')).setCta().onClick(async () => {
            await watcher.runAllPending();
        }));

        this.listEl = this.contentEl.createDiv();
        watcher.setOnChange(() => this.render());
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

        const items = this.plugin.watcher.getQueue();
        if (items.length === 0) {
            el.createEl('p', { text: t('modal.watcher.empty'), cls: 'setting-item-description' });
            return;
        }

        for (const item of items) {
            const row = new Setting(el)
                .setName(item.name)
                .setDesc(`${this.statusLabel(item.status)}${item.message ? ' — ' + item.message : ''}`);

            if (item.status === 'pending' || item.status === 'error') {
                row.addButton((b: ButtonComponent) => b.setButtonText(t('modal.watcher.btn.translate')).onClick(async () => {
                    await this.plugin.watcher.runOne(item.path);
                }));
            }
            row.addExtraButton(b => b.setIcon('trash').setTooltip(t('modal.watcher.btn.remove')).onClick(() => {
                this.plugin.watcher.remove(item.path);
            }));
        }
    }

    onClose() {
        this.plugin.watcher.setOnChange(null);
        this.contentEl.empty();
    }
}
