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
// Phase 5.1 (W-2b): watcher-owned job tokens — stop()/Cancel kill ONLY
// the watcher scope, never the shared queue's other jobs.
import { JobToken } from './job-token';
import { FileJob } from './file-job';
// Phase 5.3: the queue's FileJob becomes the single source of truth for a
// running item's status — the watcher only DERIVES its QueueItem from it
// (type-only import: no runtime cycle).
import type { PdfLayoutQueue } from './pdf-layout-queue';

/**
 * Phase 5.3: safety cap for the event-driven runOneViaQueue wait. Same
 * 60-minute budget the old 500ms-polling `waitForQueueCompletion` had — a
 * pathological queue hang must not block `runOne` (Run All) forever.
 */
const WAIT_TERMINAL_TIMEOUT_MS = 3_600_000;

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
    private pythonJobs = new Map<string, HeadlessTranslator>();
    private queueTokens = new Set<JobToken>();
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
        for (const translator of this.pythonJobs.values()) translator.cancel();
        // W-2a fix (2026-09-12): `stop()` NO LONGER cancels the shared
        // PdfLayoutQueue. The queue is a singleton shared between the watcher,
        // "Translate Multiple Pages" (modal.ts) and the extract command
        // (main.ts) — the old `cancelRunning()` call here meant that flipping
        // the watcher OFF in settings (settings.ts toggle) or CHANGING the
        // watched folder (start() → stop() at the top of this method) silently
        // killed unrelated in-flight translations. We now cancel only the
        // watcher's OWN python-engine translator (`this.current`).
        //
        // Consequences (accepted, documented in CHANGELOG):
        //   • Turning the watcher off while ITS OWN internal-engine translation
        //     runs: the translation continues in the background and finishes —
        //     data stays valid, the watcher item is updated via its queue
        //     subscription until it reaches a terminal status.
        //   • The python path keeps its direct cancel: `this.current.cancel()`
        //     (translator stays alive until the `finally` in runOneViaPython).
        //   • Plugin unload is NOT weakened: main.ts onunload separately calls
        //     pdfLayoutQueue.dispose(), which stops everything.
        //   • The watcher-modal Cancel button is unaffected — it calls
        //     cancelRunning() directly (watcher-modal.ts).
        if (this.current) {
            try {
                this.current.cancel();
            } catch (e) {
                console.warn('[PdfWatcher] cancel failed:', e);
            }
        }
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

    /**
     * W-1 fix (2026-09-12): real-time occupancy check for a file in the
     * shared PdfLayoutQueue.
     *
     * The watcher item's own `status === 'running'` is NOT evidence of
     * anything — it can be stale (the 60-minute waitForQueueCompletion
     * timeout exits silently while the item still says 'running'; a queue
     * crash leaves items 'running' forever). The only trustworthy signals
     * are: (a) the queue's processing loop is alive, AND (b) the file has
     * pending/running tasks in the queue's OWN state. If either is false,
     * the file is not being worked on right now and a retry is safe.
     */
    private isItemActuallyBusyInQueue(path: string): boolean {
        if (this.pythonJobs.has(path)) return true;
        // Phase 5.2: FileJob.isBusy() is the single point of truth for a
        // file's occupancy in the queue — no more walking getState()
        // snapshots. The loop-liveness check stays HERE (W-1 semantics):
        // a dead processing loop means nothing is actually busy, so a
        // watcher retry remains safe.
        const q = this.plugin.pdfLayoutQueue;
        if (!q || !q.isRunning()) return false;  // dead loop → nothing is busy
        return q.getFileJob(path)?.isBusy() ?? false;
    }

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
        this.pythonJobs.get(file.path)?.cancel();
        if (!(file instanceof TFile) || file.extension !== 'pdf') return;

        const pdfPath = file.path;

        // Remove from watcher queue if pending
        const queueItem = this.queue.get(pdfPath);
        if (queueItem) {
            this.queue.delete(pdfPath);
            this.notifyChange();
            console.debug(`[PdfWatcher] Removed deleted PDF from queue: ${pdfPath}`);
        }

        // Clear pdfToMdMap entry
        if (this.plugin.pdfToMdMap.has(pdfPath)) {
            this.plugin.pdfToMdMap.delete(pdfPath);
            console.debug(`[PdfWatcher] Cleared pdfToMdMap entry for deleted PDF: ${pdfPath}`);
        }

        // Cancel in-flight headless translation if it's for this file
        if (this.current && this.currentFilePath === pdfPath) {
            this.current.cancel();
            console.debug(`[PdfWatcher] Cancelled in-flight translation for deleted PDF: ${pdfPath}`);
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
        if (await this.isFullyTranslated(file)) return;

        if (this.queue.has(file.path)) return;

        this.queue.set(file.path, {
            path: file.path, name: file.basename,
            addedAt: Date.now(), status: 'pending',
        });
        this.notifyChange();
        new Notice(`New PDF detected: ${file.basename}. Queued for background translation.`, 4000);
    }

    private async isFullyTranslated(file: TFile): Promise<boolean> {
        try {
            const cached = await FileJob.readCachedPages(this.plugin, file);
            if (!cached.size) return false;
            const count = await this.plugin.pdfLayoutService.getPageCount(file);
            return Number.isInteger(count) && count > 0 &&
                Array.from({length:count}, (_, i) => i + 1).every(n => cached.has(n));
        } catch { return false; }
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
            if (await this.isFullyTranslated(f)) continue;
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
            if (await this.isFullyTranslated(f)) continue;
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
     *
     * FIX (bg-queue audit fix): always cancel the queue side directly
     * instead of relying on the single `currentQueueCancel` slot — when
     * multiple `runOneViaQueue` calls are in flight (Translate Selected /
     * Run All in parallel), only the LAST one's cancel fn is stored, so a
     * slot-based cancel would silently no-op for still-running siblings.
     *
     * 5.1 (W-2b): the queue side is now SCOPED — cancelScope('watcher')
     * cancels every watcher-owned job (all parallel runOneViaQueue calls
     * run under watcher tokens), and NOTHING else: an unrelated
     * "Translate pages" (modal) translation or an extract command keeps
     * running. The old global `queue.cancel()` murdered them all.
     */
    cancelRunning() {
        for (const token of this.queueTokens) this.plugin.pdfLayoutQueue?.cancelJob(token);
        for (const translator of this.pythonJobs.values()) translator.cancel();
        if (this.current) {
            this.current.cancel();
        }
        // Scoped: watcher jobs only (covers parallel runOneViaQueue calls).
        this.plugin.pdfLayoutQueue?.cancelScope('watcher');
    }

    // ── manual trigger: run one item or the whole pending queue ───────────
    /**
     * Run a single queued PDF. Routes to the appropriate engine based on
     * `plugin.settings.layoutEngine`:
     *   - 'internal' → PdfLayoutQueue (extract + translate + save, no Python)
     *   - 'python'   → HeadlessTranslator (extract via PyMuPDF + translate + save)
     *
     * @param opts.force  When true, re-queues ALL pages via `enqueuePageRange`
     *                    (forces re-translation of already-cached pages).
     *                    Used by the per-item "Retranslate" button. Default
     *                    false — uses `enqueuePdf` which skips cached pages.
     *
     * FIX (bg-queue audit fix): allow retry when item is stuck at 'running'
     * due to a prior queue cancel. Previously the guard was
     * `if (item.status === 'running') return;` which permanently blocked
     * retry on items that had been paused mid-flight (status was set to
     * 'running' with a '(timeout)' message and never cleared). Now we allow
     * re-entry when the queue is cancelled — the next `enqueuePdf` /
     * `enqueuePageRange` call will auto-resume via `triggerProcessing`.
     */
    async runOne(path: string, opts?: { force?: boolean }): Promise<void> {
        const item = this.queue.get(path);
        if (!item) return;
        // W-1 fix (2026-09-12): block a retry ONLY when the file is
        // genuinely busy in a LIVE queue. The old guard
        // (`running && !queue.isCancelled()`) trusted the watcher item's
        // own status — after the 60-min waitForQueueCompletion timeout (or
        // a queue crash) that status is a lie, and Translate became a
        // silent no-op while the modal still showed "Translating…".
        if (item.status === 'running' && this.isItemActuallyBusyInQueue(path)) {
            return;
        }

        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            item.status = 'error';
            item.message = 'file not found';
            this.notifyChange();
            return;
        }

        const engine = this.plugin.settings.layoutEngine;
        if (engine === 'internal') {
            await this.runOneViaQueue(item, file, opts);
        } else {
            await this.runOneViaPython(item, file, opts);
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
     *
     * @param opts.force  When true, re-queues ALL pages via `enqueuePageRange`
     *                    so cached pages are re-translated. Used by the
     *                    per-item "Retranslate" button.
     */
    private async runOneViaQueue(item: QueueItem, file: TFile, opts?: { force?: boolean }): Promise<void> {
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

        // 5.3: ONE subscription drives BOTH progress display and the wait:
        // every queue change re-derives the item's status/message from the
        // file's FileJob (single source of truth) and resolves the wait when
        // the derivation reaches a terminal / paused state. This replaces the
        // old progress relay + waitForQueueCompletion poll + post-hoc status
        // inference — the watcher no longer keeps a second state machine.
        let settleWait: (() => void) | null = null;
        const waitTerminal = new Promise<void>(resolve => { settleWait = resolve; });
        const token = new JobToken('watcher', item.path);
        this.queueTokens.add(token);
        let enqueued = false;
        const unsub = queue.onChange(() => {
            if (enqueued && this.syncItemFromQueue(item, queue)) settleWait?.();
        });
        this.currentQueueUnsub = unsub;
        this.currentQueueCancel = () => {
            queue.cancelScope('watcher');  // 5.1 (W-2b): scoped, not global
        };

        try {
            // 5.1 (W-2b): this run is a watcher-owned job — cancelRunning() /
            // stop() cancel exactly this scope; modal/command jobs of other
            // files are not touched.

            // FIX (bg-queue audit fix): when `opts.force` is true, use
            // `enqueuePageRange(1, totalPages)` instead of `enqueuePdf` so
            // already-cached pages are re-queued for re-translation. Used by
            // the per-item "Retranslate" button on done/skipped items.
            let count: number;
            if (opts?.force) {
                const totalPages = await this.plugin.pdfLayoutService.getPageCount(file);
                count = await queue.enqueuePageRange(file, 1, totalPages, { token });
            } else {
                count = await queue.enqueuePdf(file, { token });
            }
            if (token.cancelled) {
                item.status = 'pending';
                item.message = 'cancelled — click Translate to resume';
                return;
            }
            enqueued = true;
            if (this.syncItemFromQueue(item, queue)) settleWait?.();
            if (count === 0 && !queue.getFileJob(file.path)?.isBusy()) {
                // Distinguish "all cached" from "error": if file is NOT in
                // queue state, enqueuePdf threw before creating the file state
                // (e.g. pdfjs failed to load). Check queue state to be sure.
                const state = queue.getState();
                const fileState = state.files.find(f => f.file.path === file.path);
                const tasks = fileState ? [...fileState.tasks.values()] : [];
                // M-11 fix (2026-09-12): report the TRUTH. Previously ANY
                // count===0 situation claimed "all pages already cached" —
                // a lie for pages that were abandoned (Q-2 cancel) or failed;
                // users deleted a perfectly good .translations.md and re-paid
                // LLM costs on the false premise that everything was cached.
                const notTranslated = tasks.filter(t => t.status === 'error' || t.status === 'pending').length;
                if (notTranslated > 0) {
                    item.status = 'error';
                    item.message = `${notTranslated} page(s) not translated (cancelled or failed — click Translate to retry)`;
                } else if (!fileState || tasks.length === 0) {
                    // enqueuePdf returned 0 without creating tasks — this means
                    // getPageCount threw (pdfjs load failure, corrupt PDF, etc.)
                    // The error was re-thrown by enqueuePdf, so we should have
                    // caught it in the catch block below. But just in case:
                    item.status = 'skipped';
                    item.message = 'all pages already cached';
                } else {
                    item.status = 'skipped';
                    item.message = 'all pages already cached (delete .translations.md to re-extract)';
                }
            } else {
                // 5.3: event-driven wait. The subscription above re-derives
                // the item from FileJob state on every change and resolves
                // `waitTerminal` at terminal/paused — no 500ms polling loop.
                // The 60-minute safety timeout is kept (a pathological hang
                // must not block Run All forever); on timeout the item keeps
                // its 'running' status with an explicit suffix (P2-21).
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    if (item.status === 'running') {
                        item.message = `${item.message ?? ''} (timeout)`;
                    }
                    this.notifyChange();
                    settleWait?.();
                }, WAIT_TERMINAL_TIMEOUT_MS);
                try {
                    await waitTerminal;
                } finally {
                    clearTimeout(timer);
                }
                if (!timedOut) {
                    // Final re-derivation (idempotent — the subscription's
                    // last sync already produced this state; belt and braces).
                    this.syncItemFromQueue(item, queue);
                }
            }
        } catch (e: any) {
            // enqueuePdf / enqueuePageRange threw — most likely pdfjs failed
            // to load. Show the real error, not a misleading "skipped" status.
            const msg = e?.message ?? String(e);
            console.error(`[PdfWatcher] runOneViaQueue failed for "${file.path}":`, e);
            item.status = 'error';
            item.message = msg.length > 120 ? msg.substring(0, 117) + '...' : msg;
            // Also show a Notice so the user doesn't have to hover the queue item
            new Notice(`Background translation failed: ${item.message}`, 8000);
        } finally {
            this.queueTokens.delete(token);
            unsub();
            // FIX (bg-queue audit fix): only clear the shared refs if they
            // still point to THIS call's unsub/cancel. When multiple
            // runOneViaQueue calls run in parallel (Translate Selected / Run
            // All), later calls overwrite these slots — clearing them
            // unconditionally would strip the still-running siblings of their
            // cancel hook. The local `unsub()` above always cleans up THIS
            // call's subscription correctly.
            if (this.currentQueueUnsub === unsub) {
                this.currentQueueUnsub = null;
            }
            // currentQueueCancel is a fresh closure per call; we can't
            // identity-compare meaningfully, so just leave it — cancelRunning
            // now calls queue.cancel() directly anyway.
            this.notifyChange();
        }
    }

    /**
     * Python-engine path: HeadlessTranslator (legacy).
     * Requires Python + PyMuPDF + layout_engine.py script configured in settings.
     */
    private async runOneViaPython(item: QueueItem, file: TFile, opts?: { force?: boolean }): Promise<void> {
        const translator = new HeadlessTranslator(this.plugin);
        const pre = translator.canRun();
        if (!pre.ok) {
            item.status = 'error';
            item.message = pre.reason;
            this.notifyChange();
            new Notice(pre.reason!, 6000);
            return;
        }

        this.pythonJobs.set(file.path, translator);
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
            const res = await translator.translateFile(file, opts);
            if (res.ok && res.error === 'already translated') {
                item.status = 'skipped';
                item.message = 'already translated';
            } else if (res.ok) {
                item.status = 'done';
                item.message = `${res.pages} page(s), ${res.segments} segment(s)`;
            } else {
                item.status = res.cancelled ? 'pending' : 'error';
                item.message = `${res.error}; ${res.pages} page(s) saved`;
            }
        } catch (e: any) {
            item.status = 'error';
            item.message = e?.message ?? String(e);
        } finally {
            this.pythonJobs.delete(file.path);
            if (this.current === translator) this.current = null;
            this.notifyChange();
        }
    }

    /**
     * Phase 5.3: derive a watcher QueueItem's status/message from the
     * queue's FileJob — the single source of truth. One mapping replaces
     * BOTH old machines: the progress relay (message-only updates) and the
     * post-hoc final-status inference in runOneViaQueue. Message strings
     * are unchanged so the watcher modal and the tests see the same UX.
     *
     * Returns true when the item reached a state the runOneViaQueue wait
     * can stop on:
     *   • terminal (all tasks done / error — item set accordingly);
     *   • PAUSED — the file's non-terminal tasks all belong to cancelled
     *     jobs (isFileStalled): no progress is possible until a fresh
     *     enqueue re-activates them, so waiting is pointless (the exact
     *     old FIX H12 early-exit);
     *   • no queue state for the file (cleared / never created).
     */
    private syncItemFromQueue(item: QueueItem, queue: PdfLayoutQueue): boolean {
        const job = queue.getFileJob(item.path);
        if (!job) return true;   // no queue state — nothing to wait for
        const tasks = [...job.tasks.values()];
        if (tasks.length === 0) return false;   // transient — don't touch, don't resolve

        const done = tasks.filter(t => t.status === 'done').length;
        const err = tasks.filter(t => t.status === 'error').length;
        const pend = tasks.filter(t => t.status === 'pending' || t.status === 'running').length;
        const total = job.totalPages || tasks.length;

        if (pend > 0) {
            // 5.1: per-file stalled check — this file's non-terminal tasks
            // all belong to cancelled jobs: paused, retryable via Translate.
            if (queue.isFileStalled(item.path)) {
                item.status = 'pending';
                item.message = `paused — ${done} done, ${pend} pending (click Translate to resume)`;
                this.notifyChange();
                return true;
            }
            item.status = 'running';
            item.message = `worker: ${done}/${total} done, ${pend} pending${err ? `, ${err} error` : ''}`;
            this.notifyChange();
            return false;
        }

        // All tasks terminal — final mapping (same strings as the old
        // post-hoc inference block).
        if (err > 0 && done === 0) {
            item.status = 'error';
            item.message = `${err} page(s) failed (see console)`;
        } else if (err > 0) {
            item.status = 'error';
            item.message = `${done} page(s) done, ${err} failed`;
        } else if (done > 0) {
            item.status = 'done';
            item.message = `${done} page(s) extracted + translated`;
        }
        // (done === 0 && err === 0: zero tasks — the count===0 branch of
        // runOneViaQueue already produced the honest message.)
        this.notifyChange();
        return true;
    }

    /**
     * Run every pending/error item (manual trigger).
     *
     * FIX (bg-queue audit fix): kick off all eligible items IN PARALLEL via
     * `Promise.allSettled` instead of awaiting each `runOne` sequentially.
     * Previously the serial `await this.runOne(item.path)` loop blocked the
     * UI thread for up to 60 minutes PER FILE (waitForQueueCompletion's
     * timeout) — so clicking "Run All" on a queue of 5 untranslated PDFs
     * would not even enqueue the 2nd file until the 1st finished. The user
     * saw only the first item progress and assumed "Run All" was broken.
     *
     * The PdfLayoutQueue itself processes files SEQUENTIALLY (one page at a
     * time, one file at a time), so running runOne in parallel doesn't
     * actually parallelize the work — but it DOES enqueue all files
     * immediately, sets all their item.status to 'running' immediately,
     * and lets each runOne's queue.onChange subscription relay progress
     * for its own file. The user sees all items as 'running' with live
     * progress, and the queue drains them in FIFO order.
     *
     * P2-14 (Phase 11): retry both `pending` AND `error` items. Previously
     * only `pending` was retried, so a transient failure permanently doomed
     * the file until the user manually clicked its per-item Translate
     * button. Now `error` items get another shot when the user clicks
     * "Run All". (`done` / `skipped` are terminal-success; `running` means
     * another call already picked it up.)
     */
    async runAllPending(): Promise<void> {
        if (this.running) { new Notice('Background translation already running.'); return; }
        this.running = true;
        this.notifyChange();
        try {
            // W-1 fix (2026-09-12): a 'running' item is skipped ONLY if it is
            // genuinely busy in a live queue; stale 'running' items (timeout,
            // crash) are included so Run All can resurrect them.
            const items = this.getQueue().filter(item => {
                if (item.status === 'done' || item.status === 'skipped') return false;
                if (item.status === 'running') return !this.isItemActuallyBusyInQueue(item.path);
                return true;  // pending, error — as before (P2-14)
            });
            if (items.length === 0) {
                new Notice('No pending items to translate.', 3000);
                return;
            }
            new Notice(`Starting translation for ${items.length} file(s)...`, 3000);
            // Kick off all in parallel — each runOne enqueues into the
            // PdfLayoutQueue and subscribes to its own file's progress. The
            // queue processes files sequentially, but the UI shows all items
            // as "running" with live progress immediately.
            await Promise.allSettled(items.map(item => this.runOne(item.path)));
            new Notice('Background translation queue finished.', 4000);
        } finally {
            this.running = false;
            this.notifyChange();
        }
    }
}
