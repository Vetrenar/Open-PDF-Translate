// pdf-watcher.ts
// ─────────────────────────────────────────────────────────────────────────
// Watches a single (non-recursive) vault folder for new PDFs and queues them
// for background translation. Per design: detection only auto-queues; the user
// triggers the actual translation manually from the queue.
//
// Background translation is headless and python-only (see HeadlessTranslator).
// ─────────────────────────────────────────────────────────────────────────

import { Notice, TFile, TAbstractFile, EventRef } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { HeadlessTranslator } from './headless-translate';

export interface QueueItem {
    path: string;
    name: string;
    addedAt: number;
    status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
    message?: string;
}

export class PdfWatcher {
    private plugin: OpenRouterTranslatorPlugin;
    private createRef: EventRef | null = null;
    private renameRef: EventRef | null = null;
    private queue: Map<string, QueueItem> = new Map();
    private running = false;
    private current: HeadlessTranslator | null = null;
    private onChange: (() => void) | null = null;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    start(): void {
        this.stop();
        if (!this.plugin.settings.watcherEnabled) return;

        this.createRef = this.plugin.app.vault.on('create', (f) => this.onCreated(f));
        // A move INTO the folder also counts as "new here".
        this.renameRef = this.plugin.app.vault.on('rename', (f) => this.onCreated(f));
        this.plugin.registerEvent(this.createRef);
        this.plugin.registerEvent(this.renameRef);
    }

    stop(): void {
        if (this.createRef) { this.plugin.app.vault.offref(this.createRef); this.createRef = null; }
        if (this.renameRef) { this.plugin.app.vault.offref(this.renameRef); this.renameRef = null; }
    }

    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    private notifyChange() { this.onChange?.(); }

    // ── folder matching (non-recursive) ───────────────────────────────────
    private inWatchedFolder(file: TAbstractFile): boolean {
        const folder = (this.plugin.settings.watcherFolder || '').replace(/\/+$/, '');
        const parent = file.parent?.path ?? '';
        // Non-recursive: the file's immediate parent must equal the watched folder.
        // Empty watched folder = vault root.
        return parent === (folder || '/');
    }

    private onCreated(file: TAbstractFile): void {
        if (!this.plugin.settings.watcherEnabled) return;
        if (!(file instanceof TFile) || file.extension !== 'pdf') return;
        if (!this.inWatchedFolder(file)) return;
        if (this.queue.has(file.path)) return;

        this.queue.set(file.path, {
            path: file.path, name: file.basename,
            addedAt: Date.now(), status: 'pending',
        });
        this.notifyChange();
        new Notice(`New PDF detected: ${file.basename}. Queued for background translation.`, 4000);
    }

    /** Scan the folder for existing untranslated PDFs and queue them. */
    async scanExisting(): Promise<number> {
        const folder = (this.plugin.settings.watcherFolder || '').replace(/\/+$/, '') || '/';
        let added = 0;
        for (const f of this.plugin.app.vault.getFiles()) {
            if (f.extension !== 'pdf') continue;
            const parent = f.parent?.path ?? '';
            if (parent !== folder) continue;
            if (this.queue.has(f.path)) continue;
            const translated = await this.plugin.storage.findTranslationFileForPdf(f).catch(() => null);
            if (translated) continue;
            this.queue.set(f.path, { path: f.path, name: f.basename, addedAt: Date.now(), status: 'pending' });
            added++;
        }
        if (added) this.notifyChange();
        return added;
    }

    // ── queue access ──────────────────────────────────────────────────────
    getQueue(): QueueItem[] {
        return [...this.queue.values()].sort((a, b) => a.addedAt - b.addedAt);
    }
    remove(path: string) { this.queue.delete(path); this.notifyChange(); }
    clearFinished() {
        for (const [k, v] of this.queue) if (v.status === 'done' || v.status === 'skipped') this.queue.delete(k);
        this.notifyChange();
    }
    isRunning() { return this.running; }
    cancelRunning() { this.current?.cancel(); }

    // ── manual trigger: run one item or the whole pending queue ───────────
    async runOne(path: string): Promise<void> {
        const item = this.queue.get(path);
        if (!item || item.status === 'running') return;

        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) { item.status = 'error'; item.message = 'file not found'; this.notifyChange(); return; }

        const translator = new HeadlessTranslator(this.plugin);
        const pre = translator.canRun();
        if (!pre.ok) { item.status = 'error'; item.message = pre.reason; this.notifyChange(); new Notice(pre.reason!, 6000); return; }

        this.current = translator;
        item.status = 'running'; item.message = undefined; this.notifyChange();
        try {
            const res = await translator.translateFile(file);
            if (res.ok && res.error === 'already translated') { item.status = 'skipped'; item.message = 'already translated'; }
            else if (res.ok) { item.status = 'done'; item.message = `${res.pages} page(s), ${res.segments} segment(s)`; }
            else { item.status = 'error'; item.message = res.error; }
        } catch (e: any) {
            item.status = 'error'; item.message = e?.message ?? String(e);
        } finally {
            this.current = null;
            this.notifyChange();
        }
    }

    /** Run every pending item sequentially (manual trigger). */
    async runAllPending(): Promise<void> {
        if (this.running) { new Notice('Background translation already running.'); return; }
        this.running = true;
        this.notifyChange();
        try {
            for (const item of this.getQueue()) {
                if (item.status !== 'pending') continue;
                await this.runOne(item.path);
            }
            new Notice('Background translation queue finished.', 4000);
        } finally {
            this.running = false;
            this.notifyChange();
        }
    }
}
