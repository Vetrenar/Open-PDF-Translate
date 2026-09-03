// pdf-watcher.ts
// ─────────────────────────────────────────────────────────────────────────
// Watches a single (non-recursive) vault folder for new PDFs and queues them
// for background translation. Per design: detection only auto-queues; the user
// triggers the actual translation manually from the queue.
//
// Background translation supports BOTH layout engines:
//   - 'internal' → PdfLayoutQueue (pdfjs-dist on main thread, fake-worker mode)
//                  Pipeline: extract layout → translate paragraphs → save .translations.md
//                  No Python required. This is the default and recommended path.
//   - 'python'   → HeadlessTranslator (PyMuPDF via external script)
//                  Pipeline: extract layout (python) → translate (LLM) → save .translations.md
//                  Requires Python + PyMuPDF installed.
//
// Phase 2: routing by `plugin.settings.layoutEngine`. The internal path was
// previously broken because the old Web-Worker-based PdfLayoutService couldn't
// spawn a worker under Obsidian ≥1.5's vault-scoped resource URLs. It has been
// replaced by PdfTextExtractor (main-thread fake-worker mode) which works
// reliably. The internal queue now also performs translation inline (not just
// layout extraction), so the result is a fully-translated .translations.md.
//
// Phase 18 (C22): `onCreated` is now `async` and includes rename-race
// protection. When Obsidian fires `create` for a file that already has a
// linked translation (e.g. a `rename` event whose metadataCache hasn't
// fully propagated yet, or a file that was already processed), we skip
// queueing to avoid duplicate work.
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
    private deleteRef: EventRef | null = null;  // FIX H13: cleanup on PDF deletion
    private queue: Map<string, QueueItem> = new Map();
    private running = false;
    private current: HeadlessTranslator | null = null;
    private currentFilePath: string | null = null;  // FIX H13: track for delete-cleanup
    /** Cancel hook for the internal-engine path (PdfLayoutQueue). */
    private currentQueueCancel: (() => void) | null = null;
    /** Unsubscribe from PdfLayoutQueue.onChange for the current internal-engine job. */
    private currentQueueUnsub: (() => void) | null = null;
    private onChange: (() => void) | null = null;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    start(): void {
        this.stop();
        if (!this.plugin.settings.watcherEnabled) return;

        // Phase 18 (C22): onCreated is now async. Obsidian's `vault.on`
        // ignores the returned Promise, so we wrap with `void … .catch()`
        // to surface any unexpected rejections instead of letting them
        // become silent "unhandled promise rejection" warnings.
        const safeOnCreated = (f: TAbstractFile): void => {
            void this.onCreated(f).catch((err) => {
                console.warn('[PdfWatcher] onCreated failed:', err);
            });
        };

        this.createRef = this.plugin.app.vault.on('create', safeOnCreated);
        // A move INTO the folder also counts as "new here".
        this.renameRef = this.plugin.app.vault.on('rename', safeOnCreated);
        // FIX H13: register delete handler to clean up orphaned translations and
        // stale pdfToMdMap entries when a PDF is deleted from the vault.
        this.deleteRef = this.plugin.app.vault.on('delete', (f: TAbstractFile) => {
            try {
                this.onDeleted(f);
            } catch (err) {
                console.warn('[PdfWatcher] onDeleted failed:', err);
            }
        });
        this.plugin.registerEvent(this.createRef);
        this.plugin.registerEvent(this.renameRef);
        this.plugin.registerEvent(this.deleteRef);
    }

    stop(): void {
        // P1-3 (Phase 9): cancel any in-flight translation before tearing
        // down listeners. Previously `stop()` only detached vault event
        // refs, leaving a running HeadlessTranslator / PdfLayoutQueue job
        // alive — it would still call back into `this.current` after stop,
        // write to the .translations.md file, and notify subscribers whose
        // modal had already been detached. `cancelRunning()` is a no-op if
        // nothing is running, so this is safe to call unconditionally.
        this.cancelRunning();
        // Drop the running-job references immediately so any late callback
        // from the cancelled job (Promise resolution, .then() in runOne*)
        // observes `this.current === null` and short-circuits its post-run
        // bookkeeping (status update, Notice, notifyChange).
        this.current = null;
        this.currentFilePath = null;
        if (this.createRef) { this.plugin.app.vault.offref(this.createRef); this.createRef = null; }
        if (this.renameRef) { this.plugin.app.vault.offref(this.renameRef); this.renameRef = null; }
        if (this.deleteRef) { this.plugin.app.vault.offref(this.deleteRef); this.deleteRef = null; }
    }

    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    private notifyChange() { this.onChange?.(); }

    // ── folder matching (non-recursive) ───────────────────────────────────
    /**
     * Non-recursive: the file's immediate parent must equal the watched folder.
     *
     * FIX (W-4): Previously this used `parent === (folder || '/')`, which broke
     * when the watched folder was the vault root. Obsidian represents the root
     * as `/` for `TFile.parent.path` but our normalised `folder` is `''` — so
     * the comparison `'' === '/'` failed. Now we normalise both sides through
     * a single `norm()` helper that maps empty / `/` / `.` to a canonical
     * sentinel, and compares against that.
     */
    private inWatchedFolder(file: TAbstractFile): boolean {
        return this.pathMatchesWatchedFolder(file.parent?.path ?? '');
    }

    /** True if `parentPath` is the immediate parent of the watched folder. */
    private pathMatchesWatchedFolder(parentPath: string): boolean {
        return this.norm(parentPath) === this.norm(this.plugin.settings.watcherFolder || '');
    }

    /** Canonical normaliser: '' / '/' / '.' all map to '/' (vault root). */
    private norm(p: string): string {
        const trimmed = (p || '').trim().replace(/\/+$/, '');
        return trimmed === '' || trimmed === '.' ? '/' : trimmed;
    }

    /**
     * Phase 18 (C22): now `async` to support the rename-race check.
     *
     * When a PDF is moved into the watched folder, Obsidian fires BOTH a
     * `rename` event (for the new path) AND — once metadataCache catches
     * up — a `create` event. The translation map (`pdfToMdMap`) may also
     * be updated asynchronously. To avoid queueing a PDF that already has
     * a linked translation (which would cause `HeadlessTranslator` /
     * `PdfLayoutQueue` to skip it anyway, but only after we've already
     * added a stale item to the queue and shown a misleading Notice),
     * we ask `storage.findTranslationFileForPdf()` for the current state
     * and bail out early if a translation already exists.
     *
     * Best-effort: if `findTranslationFileForPdf` rejects (e.g. storage
     * not yet initialised), we treat it as "no translation found" and
     * proceed with queueing — same as `scanExisting()` does.
     */
    // FIX H13: cleanup when a PDF is deleted from the vault.
    // Removes the PDF from the watcher queue, clears the pdfToMdMap entry,
    // and notifies the queue to clean up its internal state.
    // Does NOT delete the .translations.md file — that's user data and the
    // user might re-add the PDF later. Use "Clean unused translations" command
    // to remove orphaned translation files.
    private onDeleted(file: TAbstractFile): void {
        if (!(file instanceof TFile) || file.extension !== 'pdf') return;

        const pdfPath = file.path;

        // Remove from watcher queue if pending
        const queueItem = this.queue.get(pdfPath);
        if (queueItem) {
            this.queue.delete(pdfPath);
            this.notifyChange();
            console.log(`[PdfWatcher] Removed deleted PDF from queue: ${pdfPath}`);
        }

        // Clear pdfToMdMap entry
        if (this.plugin.pdfToMdMap.has(pdfPath)) {
            this.plugin.pdfToMdMap.delete(pdfPath);
            console.log(`[PdfWatcher] Cleared pdfToMdMap entry for deleted PDF: ${pdfPath}`);
        }

        // Cancel in-flight headless translation if it's for this file
        if (this.current && this.currentFilePath === pdfPath) {
            this.current.cancel();
            console.log(`[PdfWatcher] Cancelled in-flight translation for deleted PDF: ${pdfPath}`);
        }

        // P2-22 (Phase 11): clear PdfLayoutQueue state for the deleted file so
        // its pending/running tasks don't keep firing onChange callbacks into
        // the watcher modal (which would otherwise show a phantom row in the
        // background-queue section forever, with no way to dismiss it since
        // the source TFile is gone). clearFile() is a no-op if the queue has
        // no state for this path, so it's safe to call unconditionally.
        this.plugin.pdfLayoutQueue?.clearFile?.(pdfPath);
    }

    private async onCreated(file: TAbstractFile): Promise<void> {
        if (!this.plugin.settings.watcherEnabled) return;
        if (!(file instanceof TFile) || file.extension !== 'pdf') return;
        if (!this.inWatchedFolder(file)) return;

        // Phase 18 (C22): rename-race protection — if a translation file
        // is already linked to this PDF (rename race, or already processed
        // earlier in this session), skip queueing.
        const existingTranslation = await this.plugin.storage
            .findTranslationFileForPdf(file)
            .catch(() => null);
        if (existingTranslation) {
            this.plugin.logDebug?.(
                `Translation file already exists for ${file.path}, skipping queue addition.`,
            );
            return;
        }

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
        // FIX (W-4): use the same normaliser as inWatchedFolder so root-folder
        // matching works consistently. Previously used a different normalisation
        // (||  '/'  fallback) that diverged from inWatchedFolder's logic.
        const targetNorm = this.norm(this.plugin.settings.watcherFolder || '');
        let added = 0;
        for (const f of this.plugin.app.vault.getFiles()) {
            if (f.extension !== 'pdf') continue;
            const parentNorm = this.norm(f.parent?.path ?? '');
            if (parentNorm !== targetNorm) continue;
            if (this.queue.has(f.path)) continue;
            const translated = await this.plugin.storage.findTranslationFileForPdf(f).catch(() => null);
            if (translated) continue;
            this.queue.set(f.path, { path: f.path, name: f.basename, addedAt: Date.now(), status: 'pending' });
            added++;
        }
        if (added) this.notifyChange();
        return added;
    }

    /**
     * FIX: scan ALL PDFs in the vault (not just watched folder) for untranslated
     * files. The watcher modal should show all pending translations so the user
     * can manage them in one place. Previously only PDFs in the watched folder
     * were shown — PDFs translated via "Translate multiple pages" from other
     * folders were invisible in the queue.
     */
    async scanAllUntranslated(): Promise<number> {
        let added = 0;
        for (const f of this.plugin.app.vault.getFiles()) {
            if (f.extension !== 'pdf') continue;
            if (this.queue.has(f.path)) continue;
            const translated = await this.plugin.storage.findTranslationFileForPdf(f).catch(() => null);
            if (translated) continue;
            this.queue.set(f.path, {
                path: f.path,
                name: f.basename,
                addedAt: Date.now(),
                status: 'pending',
            });
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

    /**
     * Cancel the currently-running job (whichever engine is active).
     * For the internal engine, this calls `pdfLayoutQueue.cancel()` which
     * stops new tasks from starting (the in-flight page finishes naturally).
     * For the python engine, this calls `HeadlessTranslator.cancel()`.
     */
    cancelRunning() {
        if (this.current) {
            this.current.cancel();
        }
        if (this.currentQueueCancel) {
            this.currentQueueCancel();
        }
    }

    // ── manual trigger: run one item or the whole pending queue ───────────
    /**
     * Run a single queued PDF. Routes to the appropriate engine based on
     * `plugin.settings.layoutEngine`:
     *   - 'internal' → PdfLayoutQueue (extract + translate + save, no Python)
     *   - 'python'   → HeadlessTranslator (extract via PyMuPDF + translate + save)
     */
    async runOne(path: string): Promise<void> {
        const item = this.queue.get(path);
        if (!item || item.status === 'running') return;

        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            item.status = 'error';
            item.message = 'file not found';
            this.notifyChange();
            return;
        }

        const engine = this.plugin.settings.layoutEngine;
        if (engine === 'internal') {
            await this.runOneViaQueue(item, file);
        } else {
            await this.runOneViaPython(item, file);
        }
    }

    /**
     * Internal-engine path: enqueue the PDF in PdfLayoutQueue.
     *
     * The queue runs the full pipeline per page (extract layout → translate
     * paragraphs → save to .translations.md). We subscribe to the queue's
     * onChange to relay progress into the watcher's QueueItem.message, so
     * WatcherQueueModal can show live progress.
     *
     * Note: enqueuePdf only queues pages that aren't already cached. If all
     * pages are already translated, the item is marked 'skipped'.
     */
    private async runOneViaQueue(item: QueueItem, file: TFile): Promise<void> {
        item.status = 'running';
        item.message = 'queued for worker extraction + translation';
        this.notifyChange();

        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) {
            item.status = 'error';
            item.message = 'internal layout queue unavailable';
            this.notifyChange();
            new Notice('Internal layout queue unavailable. Try restarting the plugin.', 6000);
            return;
        }

        // Subscribe to queue state changes to relay progress.
        const unsub = queue.onChange(() => {
            const state = queue.getState();
            const fileState = state.files.find(f => f.file.path === file.path);
            if (!fileState) return;
            const tasks = [...fileState.tasks.values()];
            const done = tasks.filter(t => t.status === 'done').length;
            const err = tasks.filter(t => t.status === 'error').length;
            const pend = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
            const total = fileState.totalPages || tasks.length;
            item.message = `worker: ${done}/${total} done, ${pend} pending${err ? `, ${err} error` : ''}`;
            this.notifyChange();
        });
        this.currentQueueUnsub = unsub;
        this.currentQueueCancel = () => {
            queue.cancel();
        };

        try {
            const count = await queue.enqueuePdf(file);
            if (count === 0) {
                // Distinguish "all cached" from "error": if file is NOT in
                // queue state, enqueuePdf threw before creating the file state
                // (e.g. pdfjs failed to load). Check queue state to be sure.
                const state = queue.getState();
                const fileState = state.files.find(f => f.file.path === file.path);
                if (!fileState || fileState.tasks.size === 0) {
                    // enqueuePdf returned 0 without creating tasks — this means
                    // getPageCount threw (pdfjs load failure, corrupt PDF, etc.)
                    // The error was re-thrown by enqueuePdf, so we should have
                    // caught it in the catch block below. But just in case:
                    item.status = 'skipped';
                    item.message = 'no pages queued (PDF may be empty or unreadable — check console for errors)';
                } else {
                    item.status = 'skipped';
                    item.message = 'all pages already cached (delete .translations.md to re-extract)';
                }
            } else {
                // Wait for the queue to finish processing this file's tasks.
                // enqueuePdf only queues; the actual extraction+translation
                // happens asynchronously in processQueue().
                await this.waitForQueueCompletion(file);

                // Determine final status from queue state.
                const state = queue.getState();
                const fileState = state.files.find(f => f.file.path === file.path);
                if (fileState) {
                    const tasks = [...fileState.tasks.values()];
                    const errCount = tasks.filter(t => t.status === 'error').length;
                    const doneCount = tasks.filter(t => t.status === 'done').length;
                    if (errCount > 0 && doneCount === 0) {
                        item.status = 'error';
                        item.message = `${errCount} page(s) failed (see console)`;
                    } else if (errCount > 0) {
                        item.status = 'done';
                        item.message = `${doneCount} page(s) done, ${errCount} failed`;
                    } else {
                        // P2-21 (Phase 11): distinguish a true "all done"
                        // state from a `waitForQueueCompletion` timeout.
                        // `waitForQueueCompletion` returns silently after its
                        // 60-minute timeout (and also returns early if the
                        // queue gets cancelled), so reaching this branch does
                        // NOT guarantee that every task has reached a terminal
                        // state. Previously we always marked `done` here, which
                        // gave a misleading green checkmark on items that were
                        // actually still translating in the background — the
                        // user would close the modal, come back later, and
                        // wonder why the overlays weren't all there yet. Now
                        // we check whether any tasks are still `pending` /
                        // `running` and, if so, leave the item at `running`
                        // with an explicit "(timeout)" suffix so the queue
                        // loop can pick it up on the next pass.
                        const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
                        if (pendingCount > 0) {
                            item.status = 'running';
                            item.message = `${doneCount} done, ${pendingCount} still running (timeout)`;
                        } else {
                            item.status = 'done';
                            item.message = `${doneCount} page(s) extracted + translated`;
                        }
                    }
                } else {
                    item.status = 'done';
                    item.message = 'extracted + translated';
                }
            }
        } catch (e: any) {
            // enqueuePdf threw — most likely pdfjs failed to load.
            // Show the real error, not a misleading "skipped" status.
            const msg = e?.message ?? String(e);
            console.error(`[PdfWatcher] runOneViaQueue failed for "${file.path}":`, e);
            item.status = 'error';
            item.message = msg.length > 120 ? msg.substring(0, 117) + '...' : msg;
            // Also show a Notice so the user doesn't have to hover the queue item
            new Notice(`Background translation failed: ${item.message}`, 8000);
        } finally {
            unsub();
            this.currentQueueUnsub = null;
            this.currentQueueCancel = null;
            this.notifyChange();
        }
    }

    /**
     * Python-engine path: HeadlessTranslator (legacy).
     * Requires Python + PyMuPDF + layout_engine.py script configured in settings.
     */
    private async runOneViaPython(item: QueueItem, file: TFile): Promise<void> {
        const translator = new HeadlessTranslator(this.plugin);
        const pre = translator.canRun();
        if (!pre.ok) {
            item.status = 'error';
            item.message = pre.reason;
            this.notifyChange();
            new Notice(pre.reason!, 6000);
            return;
        }

        this.current = translator;
        // P0-13 (Phase 1): `QueueItem` has no `filePath` field — only `path`.
        // The previous `item.filePath` access silently returned `undefined`,
        // so `currentFilePath` was always null and delete-during-translate
        // cleanup (onDeleted) never matched the in-flight PDF.
        this.currentFilePath = item.path;  // FIX H13: track for delete-cleanup
        item.status = 'running';
        item.message = undefined;
        this.notifyChange();
        try {
            const res = await translator.translateFile(file);
            if (res.ok && res.error === 'already translated') {
                item.status = 'skipped';
                item.message = 'already translated';
            } else if (res.ok) {
                item.status = 'done';
                item.message = `${res.pages} page(s), ${res.segments} segment(s)`;
            } else {
                item.status = 'error';
                item.message = res.error;
            }
        } catch (e: any) {
            item.status = 'error';
            item.message = e?.message ?? String(e);
        } finally {
            this.current = null;
            this.notifyChange();
        }
    }

    /**
     * Wait until all of `file`'s tasks in the PdfLayoutQueue reach a terminal
     * state (done or error). Polls every 500ms with a 60-minute timeout
     * (large PDFs with LLM translation can take a long time).
     * On timeout, returns without error — the queue continues processing in
     * the background and the watcher item will be updated on the next change.
     */
    private async waitForQueueCompletion(file: TFile, timeoutMs = 3_600_000): Promise<void> {
        const start = Date.now();
        const queue = this.plugin.pdfLayoutQueue;
        if (!queue) return;

        let lastProgressMsg = '';
        while (Date.now() - start < timeoutMs) {
            // FIX H12: early-exit if queue is cancelled — pending tasks
            // will never reach terminal state, so waiting would hang for the
            // full 1-hour timeout. After cancel, the watcher item should be
            // marked as done (or error) by the caller.
            if (queue.isCancelled()) {
                console.log(`[PdfWatcher] waitForQueueCompletion: queue cancelled, stopping wait for "${file.path}".`);
                return;
            }

            const state = queue.getState();
            const fileState = state.files.find(f => f.file.path === file.path);
            if (fileState) {
                const tasks = [...fileState.tasks.values()];
                const pending = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
                if (pending === 0) return; // all tasks terminal

                // Log progress every 30 seconds (avoid spamming console)
                const done = tasks.filter(t => t.status === 'done').length;
                const total = fileState.totalPages || tasks.length;
                const elapsed = Math.round((Date.now() - start) / 1000);
                const progressMsg = `[PdfWatcher] "${file.basename}" still processing: ${done}/${total} done, ${pending} pending (${elapsed}s elapsed)`;
                if (elapsed % 30 === 0 && progressMsg !== lastProgressMsg) {
                    console.log(progressMsg);
                    lastProgressMsg = progressMsg;
                }
            }
            await new Promise(r => setTimeout(r, 500));
        }
        // Timeout — not an error, queue keeps running in background.
        console.warn(
            `[PdfWatcher] waitForQueueCompletion timed out for "${file.path}" after ${timeoutMs / 1000}s — ` +
            `queue continues in background. Check the queue state in the watcher modal.`,
        );
    }

    /** Run every pending item sequentially (manual trigger). */
    async runAllPending(): Promise<void> {
        if (this.running) { new Notice('Background translation already running.'); return; }
        this.running = true;
        this.notifyChange();
        try {
            for (const item of this.getQueue()) {
                // P2-14 (Phase 11): retry both `pending` AND `error` items.
                // Previously only `pending` was retried, so a transient
                // failure (network blip, pdfjs load error on the first page,
                // etc.) permanently doomed the file until the user manually
                // clicked its per-item Translate button. Now `error` items
                // get another shot when the user clicks "Run all pending".
                // (`done` / `skipped` are terminal-success; `running` means
                // another call already picked it up.)
                if (item.status === 'done' || item.status === 'skipped' || item.status === 'running') continue;
                await this.runOne(item.path);
            }
            new Notice('Background translation queue finished.', 4000);
        } finally {
            this.running = false;
            this.notifyChange();
        }
    }
}
