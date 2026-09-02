// pdf-layout-queue.ts
// ─────────────────────────────────────────────────────────────────────────
// Background processing queue that bridges the existing `PdfWatcher` and
// the new `PdfLayoutService` (pdfjs-dist-based paragraph extractor).
//
// Accepts PDFs (single page or whole document) and runs layout extraction
// on each page sequentially in the background, persisting results directly
// to the existing `.translations.md` storage layer so the rest of the
// plugin (overlay renderer, translation engine) treats them identically
// to python-extracted overlays.
//
//
// ── README — design notes ───────────────────────────────────────────────
//
// 1. Concurrency model — single global sequential queue
// ─────────────────────────────────────────────────────────────────────
//    Exactly ONE `processQueue()` loop runs at any time, guarded by the
//    `processing` flag. Tasks are picked off in (file-enqueue-order,
//    page-number-order) via `findNextPendingTask()`. Within a file only
//    one page is in flight at a time, and across files the same worker
//    is shared (the underlying `PdfLayoutService` already serializes
//    worker requests internally via pdfjs' own pdf-worker).
//
//    Re-entrancy: `enqueuePage()` / `enqueuePdf()` always trigger
//    `processQueue()`, but if a loop is already running the call returns
//    immediately — the running loop will pick up the new task on its next
//    `findNextPendingTask()` iteration. After the loop drains, a final
//    re-trigger check picks up any tasks added during teardown.
//
//    This is deliberately simpler than a per-file worker pool: page
//    extraction is CPU-bound on the worker thread, so parallelism wouldn't
//    buy much and would complicate UI progress reporting.
//
//
// 2. Persistence model — direct write to .translations.md
// ────────────────────────────────────────────────────────
//    Each successfully extracted page is converted from
//    `NormalizedParagraph[]` (worker output) to `OverlayPositionData[]`
//    (plugin's existing overlay shape) and written via
//    `plugin.storage.updatePageOverlaysAndWrite(file, { [pageNum]: data })`.
//
//    That storage method already handles:
//      • Read-modify-write under a per-file write lock (no races with
//        the live overlay editor or the translation engine).
//      • Creating the `.translations.md` file if it doesn't exist yet,
//        including the storage folder.
//      • Updating the `pdfToMdMap` so subsequent lookups are O(1).
//      • Marking the write as "self-write" so the metadataCache 'changed'
//        handler doesn't trigger an overlay reload (#8 in main.ts).
//
//    Because we persist page-by-page, a crash mid-PDF leaves the already-
//    processed pages intact in the markdown file — the next run will
//    simply skip them (see cache model below).
//
//
// 3. Cache model — check storage before enqueueing
// ────────────────────────────────────────────────────
//    `enqueuePdf()` queries `plugin.storage.readSavedOverlayForFile(file)`
//    and skips any page that already has a non-empty `pageOverlays[page]`
//    entry. `enqueuePage()` does the same per-page check via the private
//    `getCachedPages(file)` helper (Phase 12 / P2-19). This means re-running
//    the queue on a partially-processed PDF only re-extracts the missing
//    pages — no duplicate work.
//
//    Note: a page counts as "cached" if it has ANY overlay entries, even
//    if they were produced by a different layout engine (python, OCR).
//    This is intentional — the user already has positioning data for
//    that page, and overwriting it would discard translations. To force
//    re-extraction, delete the page's overlay first (via the existing
//    "delete overlay" command) or call `clearFile()` on this queue.
//
//
// 4. Integration with PdfWatcher
// ───────────────────────────────
//    The existing `PdfWatcher` (upload/pdf-watcher/pdf-watcher.ts) detects
//    new PDFs in a watched folder and currently feeds them to the
//    python-based `HeadlessTranslator`. To route detected PDFs through
//    this layout queue instead, the watcher's `onCreated()` handler can
//    call `plugin.layoutQueue.enqueuePdf(file)` after queuing — the queue
//    takes over from there and reports progress via `onChange()`.
//
//    The watcher's `WatcherQueueModal` can also render a second section
//    for layout-queue state by reading `plugin.layoutQueue.getState()`
//    and subscribing via `plugin.layoutQueue.onChange(render)`.
//
//    Concretely, in `PdfWatcher.onCreated(file)`:
//
//        if (this.plugin.layoutQueue) {
//            void this.plugin.layoutQueue.enqueuePdf(file).then(n => {
//                if (n > 0) new Notice(`Queued ${n} page(s) for layout detection.`);
//            });
//        }
//
//    The queue is deliberately decoupled from the watcher, though —
//    manual `enqueuePdf()` calls from a command palette work too.
// ─────────────────────────────────────────────────────────────────────────

import { TFile, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { PdfTextExtractor } from './pdf-text-extractor';
import type { NormalizedParagraph, ExtractPageResult } from './pdf-text-extractor';
import type { OverlayPositionData } from './types';
// T2.5: THE single construction site for saved overlay records.
import { makeOverlay } from './overlay-factory';
import { getCurrentEngine, computeLayoutSettingsHash } from './overlay-id';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/**
 * A single page-extraction task within the queue.
 *
 * Lifecycle: pending → running → (done | error).
 * A task in `done` or `running` state is a no-op for `enqueuePage()`;
 * a task in `error` state can be re-enqueued by the user.
 */
export interface QueueTask {
  file: TFile;
  pageNum: number;        // 1-based
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * Per-file aggregation of tasks. One entry per PDF that has been
 * (or is being) processed. `totalPages` is 0 when only single pages
 * have been enqueued via `enqueuePage()` (page-count not queried).
 */
export interface QueueFileState {
  file: TFile;
  totalPages: number;
  tasks: Map<number, QueueTask>;  // pageNum → task
  startedAt: number;
}

/**
 * Snapshot returned by `getState()` for UI rendering.
 * `files` is sorted by `startedAt` ascending (oldest first).
 */
export interface QueueStateSnapshot {
  files: QueueFileState[];
  totalPending: number;   // includes 'running'
  totalDone: number;
  totalError: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[PdfLayoutQueue]';

/**
 * Substring matched against service error messages to classify a task
 * failure as a timeout. The service throws messages of the form
 * "[PdfLayoutService] Request N (page M) timed out after 30000ms".
 */
const TIMEOUT_MATCHER = /timed?\s*out/i;

// ─────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────

export class PdfLayoutQueue {
  // ── Dependencies ──────────────────────────────────────────────────
  private readonly plugin: OpenRouterTranslatorPlugin;
  private readonly extractor: PdfTextExtractor;

  // ── Per-file state, keyed by vault path ───────────────────────────
  private readonly files: Map<string, QueueFileState> = new Map();

  // FIX C1: per-file translation lock. Only ONE worker at a time translates
  // a page of a given file. This eliminates read-modify-write contention in
  // updatePageOverlaysAndWrite (which re-reads the file, merges, and writes
  // back under a per-file write lock). Without this, 3 parallel workers
  // translating pages 2/3/4 of the same PDF would each read the file before
  // the others' writes landed, causing merge conflicts and lost updates.
  // Cross-file parallelism is preserved: file A's worker doesn't block file B.
  private readonly fileTranslationLocks: Map<string, Promise<void>> = new Map();

  // ── Concurrency / cancellation ────────────────────────────────────
  /** True while `processQueue()` is running. Guards re-entry. */
  private processing = false;
  /**
   * P1-4 (Phase 9): the in-flight `processQueue()` promise, if any.
   * Populated by `triggerProcessing()` (and the finally-block re-trigger
   * inside `processQueue` itself). Awaited by `dispose()` so that the
   * current page's pending extraction / translation / disk write has a
   * chance to complete before subscribers and file-state are torn down —
   * otherwise closing Obsidian mid-translation could discard the in-flight
   * page even though its LLM call already returned.
   */
  private processingPromise: Promise<void> | null = null;
  /** Set by `cancel()`. Checked between tasks; pending tasks remain pending. */
  private cancelled = false;

  // ── Subscribers ───────────────────────────────────────────────────
  private readonly subscribers = new Set<() => void>();

  // ── Lifecycle ────────────────────────────────────────────────────
  private disposed = false;

  constructor(plugin: OpenRouterTranslatorPlugin, extractor: PdfTextExtractor) {
    this.plugin = plugin;
    this.extractor = extractor;
  }

  // ════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════

  /**
   * FIX C1: serialize translation+persist per file.
   *
   * Multiple translation workers can run in parallel (one per file), but
   * within a single file only ONE worker holds the lock at a time. This
   * prevents the read-modify-write race in updatePageOverlaysAndWrite
   * where worker A reads the file, worker B reads the same file, worker A
   * writes, worker B writes (overwriting A's changes).
   */
  // FIX H4: made public so HeadlessTranslator can use the same per-file lock.
  // This ensures interactive translation and headless (watcher) translation on
  // the same PDF are serialized — prevents data races on .translations.md.
  async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.fileTranslationLocks.get(filePath) || Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>(resolve => { resolveNext = resolve; });
    // P0-4: capture the new lock promise in a variable. Previously the code
    // called `existing.then(() => next)` twice — once to store in the Map
    // (line below) and again in the `finally` block to compare. Each
    // `Promise.prototype.then()` call returns a NEW Promise, so the equality
    // check `current === existing.then(() => next)` was ALWAYS false. The
    // Map entry was never deleted, and `fileTranslationLocks` grew by one
    // entry per page translation for the lifetime of the plugin. On a
    // 100-page PDF with 3 worker concurrency that's 100 leaked entries per
    // file. Capturing `newLock` once makes the comparison correct.
    const newLock = existing.then(() => next);
    this.fileTranslationLocks.set(filePath, newLock);

    await existing;
    try {
      return await fn();
    } finally {
      resolveNext();
      // Clean up if we're still the latest lock holder.
      if (this.fileTranslationLocks.get(filePath) === newLock) {
        this.fileTranslationLocks.delete(filePath);
      }
    }
  }

  /**
   * Queue a specific range of pages for background processing.
   *
   * Used by TranslateMultiplePagesModal (migrated from DOM-based to worker-based).
   * Does NOT require the PDF to be open — extraction reads bytes directly
   * from the vault via PdfTextExtractor.readPdfBytes.
   *
   * @returns Number of pages newly queued (0 if all pages in range already cached).
   */
  async enqueuePageRange(
    file: TFile,
    startPage: number,
    endPage: number,
    options?: {
      silent?: boolean;
    },
  ): Promise<number> {
    this.assertNotDisposed();
    if (!Number.isFinite(startPage) || !Number.isFinite(endPage) || startPage < 1 || endPage < startPage) {
      console.warn(`${LOG_PREFIX} enqueuePageRange: invalid range [${startPage}, ${endPage}]`);
      return 0;
    }

    // Get total pages to validate range.
    let totalPages: number;
    try {
      totalPages = await this.extractor.getPageCount(file);
    } catch (err: any) {
      throw new Error(`Could not determine PDF page count: ${err?.message ?? err}`);
    }
    if (endPage > totalPages) endPage = totalPages;
    if (startPage > totalPages) return 0;

    // FIX: removed cached-pages check — user can now re-translate already-cached
    // pages via "Translate multiple pages". Previously cached pages were skipped
    // silently, which was confusing when the user wanted to overwrite with a
    // different provider or updated prompt. Now ALL pages in the range are
    // queued (cached or not), giving the user full control.
    const state = this.getOrCreateFileState(file);
    state.totalPages = totalPages;

    let queued = 0;
    for (let p = startPage; p <= endPage; p++) {
      const existing = state.tasks.get(p);
      if (existing) {
        // Allow re-translation: reset any existing task to pending.
        // (Previously 'done' and 'running' were skipped — now only 'running'
        // is preserved to avoid duplicate in-flight work on the same page.)
        if (existing.status === 'running') continue;
        existing.status = 'pending';
        existing.error = undefined;
        existing.startedAt = undefined;
        existing.finishedAt = undefined;
      } else {
        state.tasks.set(p, { file, pageNum: p, status: 'pending' });
      }
      queued++;
    }

    if (queued > 0) {
      this.plugin.logDebug?.(
        `Queued ${queued} page(s) [${startPage}-${endPage}] for "${file.path}".`
      );
      this.notifyChange();
      this.triggerProcessing();
    } else if (!options?.silent) {
      new Notice(
        `No pages queued for range ${startPage}-${endPage}.`,
        5000,
      );
    }

    return queued;
  }

  /**
   * Queue a single page for background processing.
   *
   * Returns immediately (the method is async but fire-and-forget — callers
   * don't need to await it); processing happens asynchronously in
   * `processQueue()`. No-op if the page is already `done` or `running`,
   * or if the page is already cached on disk (Phase 12 / P2-19).
   * If the page is `error` or `pending`, it is (re)set to `pending`.
   *
   * Calling this on a cancelled queue does NOT resume processing —
   * call `resume()` explicitly to clear the cancel flag.
   */
  async enqueuePage(file: TFile, pageNum: number): Promise<void> {
    this.assertNotDisposed();
    if (!Number.isFinite(pageNum) || pageNum < 1) {
      console.warn(`${LOG_PREFIX} enqueuePage: pageNum must be positive, got ${pageNum}`);
      return;
    }

    // P2-19 (Phase 12): skip if page is already cached on disk. The cache
    // check covers three cases the in-memory task-state check below does
    // NOT cover:
    //   1. Page was translated in a PREVIOUS session (queue state was wiped
    //      on plugin reload, but `.translations.md` still has the overlay).
    //   2. Page was extracted by a different engine (python, OCR) that
    //      wrote directly to `.translations.md` without going through this
    //      queue.
    //   3. Page was translated by a parallel `enqueuePdf` call that already
    //      finished and wrote to disk but hasn't yet been reflected in this
    //      caller's in-memory task map.
    // The check is best-effort: storage errors fail open (we proceed with
    // the enqueue) so a flaky read doesn't permanently block re-translation.
    try {
      const cachedPages = await this.getCachedPages(file);
      if (cachedPages.has(pageNum)) {
        this.plugin.logDebug?.(
          `${LOG_PREFIX} enqueuePage: "${file.path}" p${pageNum} already cached — skipping.`
        );
        return;
      }
    } catch (err: any) {
      console.warn(
        `${LOG_PREFIX} enqueuePage: cache check failed for "${file.path}" p${pageNum}, proceeding with enqueue:`,
        err,
      );
    }

    const state = this.getOrCreateFileState(file);
    const existing = state.tasks.get(pageNum);

    if (existing) {
      if (existing.status === 'done' || existing.status === 'running') {
        // Already processed or in-flight — no-op (per spec).
        return;
      }
      // Was 'pending' or 'error' — reset to pending.
      existing.status = 'pending';
      existing.error = undefined;
      existing.startedAt = undefined;
      existing.finishedAt = undefined;
    } else {
      state.tasks.set(pageNum, {
        file,
        pageNum,
        status: 'pending',
      });
    }

    this.notifyChange();
    this.triggerProcessing();
  }

  /**
   * Queue all pages of a PDF that aren't already cached.
   *
   * Steps:
   *   1. Query `service.getPageCount(file)` for total pages.
   *   2. Read existing `pageOverlays` from `plugin.storage` and skip
   *      any page with non-empty overlay data.
   *   3. For each missing page, create a `pending` task (or reset an
   *      existing `error` task).
   *   4. Trigger `processQueue()`.
   *
   * @returns Number of pages newly queued (0 if PDF has no missing
   *          pages, or if page-count query failed).
   */
  async enqueuePdf(file: TFile): Promise<number> {
    this.assertNotDisposed();

    // 1. Get total pages (also lazily primes the extractor's PDF-bytes cache).
    // NOTE: we deliberately do NOT catch errors here — the caller (watcher or
    // command) needs to know if pdfjs failed to load so it can show a real
    // error message instead of a misleading "all pages cached" status.
    let totalPages: number;
    totalPages = await this.extractor.getPageCount(file);

    if (!Number.isFinite(totalPages) || totalPages < 1) {
      console.warn(`${LOG_PREFIX} "${file.path}" reported ${totalPages} pages; skipping.`);
      return 0;
    }

    // 2. Determine which pages are already cached in .translations.md.
    const cachedPages = await this.getCachedPages(file);

    // 3. Find or create file state; update totalPages.
    const state = this.getOrCreateFileState(file);
    state.totalPages = totalPages;

    let queued = 0;
    for (let p = 1; p <= totalPages; p++) {
      if (cachedPages.has(p)) continue;

      const existing = state.tasks.get(p);
      if (existing) {
        if (existing.status === 'done' || existing.status === 'running') {
          // In-flight or already finished — skip.
          continue;
        }
        // Reset 'error' / stale 'pending' to a fresh pending.
        existing.status = 'pending';
        existing.error = undefined;
        existing.startedAt = undefined;
        existing.finishedAt = undefined;
      } else {
        state.tasks.set(p, { file, pageNum: p, status: 'pending' });
      }
      queued++;
    }

    if (queued > 0) {
      this.plugin.logDebug?.(`Queued ${queued}/${totalPages} page(s) for "${file.path}" (${cachedPages.size} cached).`);
      this.notifyChange();
      this.triggerProcessing();
    } else {
      this.plugin.logDebug?.(`"${file.path}" — all ${totalPages} page(s) already cached; nothing to queue.`);
    }

    return queued;
  }

  /**
   * FIX (originals-only): Check if a .translations.md file is marked as
   * `originals-only: true` in frontmatter. Such files contain original text
   * as placeholder translations (created by the "create layout file" command)
   * and should be re-translated by the queue, not skipped.
   *
   * Reads the frontmatter from the metadataCache for efficiency.
   */
  private isOriginalsOnly(mdFile: TFile): boolean {
    try {
      const cache = this.plugin.app.metadataCache.getFileCache(mdFile);
      const fm = cache?.frontmatter;
      if (!fm) return false;
      return fm['originals-only'] === true || fm['originalsOnly'] === true;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot of the queue for UI rendering.
   * `files` is sorted oldest-first by enqueue time.
   * `totalPending` includes both 'pending' and 'running' tasks.
   */
  getState(): QueueStateSnapshot {
    let totalPending = 0;
    let totalDone = 0;
    let totalError = 0;

    for (const state of this.files.values()) {
      for (const task of state.tasks.values()) {
        if (task.status === 'pending' || task.status === 'running') totalPending++;
        else if (task.status === 'done') totalDone++;
        else if (task.status === 'error') totalError++;
      }
    }

    return {
      files: [...this.files.values()].sort((a, b) => a.startedAt - b.startedAt),
      totalPending,
      totalDone,
      totalError,
    };
  }

  /**
   * Subscribe to state changes. The callback is invoked synchronously
   * whenever a task transitions state (pending→running→done/error) or
   * when files are added/removed.
   *
   * Returns an unsubscribe function. Calling it removes the callback.
   * Safe to call from within a callback (the Set is mutated via a
   * deferred delete — see `notifyChange`).
   */
  onChange(cb: () => void): () => void {
    this.assertNotDisposed();
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Cancel the queue. Pending tasks remain pending (so the user can
   * resume); the currently-running task finishes naturally — we do
   * NOT abort the worker, since the service doesn't expose a clean
   * cancellation path and a partial result is still useful.
   *
   * No new tasks will start until `resume()` is called.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.plugin.logDebug?.('Queue cancelled — running task (if any) will finish, no new tasks will start.');
    this.notifyChange();
  }

  /**
   * Resume processing after a `cancel()`. Resets the cancel flag and
   * kicks `processQueue()` if there are pending tasks.
   */
  resume(): void {
    if (!this.cancelled) return;
    this.cancelled = false;
    this.plugin.logDebug?.('Queue resumed.');
    this.notifyChange();
    this.triggerProcessing();
  }

  /**
   * Phase 11 (P2-22): remove ALL queue state for `filePath` — including
   * pending, running, and done tasks — without regard for terminal status.
   *
   * Called by `PdfWatcher.onDeleted` when the source PDF is removed from
   * the vault. This targets a single path and is safe to call from the
   * delete handler even while the queue's `processQueue()` loop is
   * mid-flight on a different file: in-flight page extraction /
   * translation is keyed by `QueueTask`, and once the file's tasks are
   * dropped the loop's next `findNextPendingTask()` iteration simply
   * won't see them.
   *
   * `processQueue()` itself never re-creates a file state on its own —
   * states are only created by `enqueuePdf` / `enqueuePageRange` /
   * `enqueuePage` / `getOrCreateFileState` — so deleting the state here
   * will not race with the loop resurrecting it.
   *
   * Best-effort: if `processQueue()` is currently extracting / translating
   * a page for this exact file, that one in-flight task will still write
   * its overlay to `.translations.md` before the task is observed missing
   * on the next iteration. This is acceptable — the user can run "Clean
   * unused translations" later to remove the orphaned translation file.
   */
  clearFile(filePath: string): void {
    for (const [key, state] of this.files.entries()) {
      if (state.file.path === filePath) {
        this.files.delete(key);
        this.notifyChange();
        this.plugin.logDebug?.(`clearFile: dropped queue state for "${filePath}".`);
        break;
      }
    }
  }

  /** True if `cancel()` has been called and `resume()` has not. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /** True if `processQueue()` is currently running. */
  isRunning(): boolean {
    return this.processing;
  }

  /**
   * P1-4 (Phase 9): now async — awaits the in-flight `processQueue()` so
   * that the page currently being extracted / translated / written to
   * `.translations.md` has a chance to land on disk before subscribers
   * and file-state are torn down. Without this, closing Obsidian
   * mid-translation discarded the in-flight page even though its LLM
   * call had already returned, violating the FIX E1 incremental-save
   * contract ("crash only loses the in-flight page" — but unload
   * shouldn't even lose that, since we have time to drain).
   *
   * Safe to call multiple times: the `disposed` guard short-circuits
   * repeat calls. The `cancelled` flag is set immediately (synchronously)
   * so that any subsequent `triggerProcessing()` re-entry from a racing
   * subscriber callback no-ops, and the in-flight loop stops picking up
   * new tasks at its next `cancelled` check.
   *
   * NOTE: callers that cannot await (e.g. Obsidian's sync `onunload`)
   * should fire-and-forget with a `.catch(() => {})` to avoid leaking
   * an unhandled rejection — see `main.ts onunload`.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelled = true;
    // P1-4 (Phase 9): wait for the in-flight processQueue to drain so
    // the current page's pending disk write completes. The loop will
    // observe `cancelled === true` on its next iteration and bail out
    // without picking up further tasks, but whatever step it was
    // mid-flight on (extraction / translateBatch / storage write) is
    // allowed to finish.
    if (this.processingPromise) {
      try {
        await this.processingPromise;
      } catch {
        // ignore — we're disposing anyway; processQueue already logs
        // its own errors via the try/catch around the extraction loop.
      }
    }
    this.subscribers.clear();
    this.files.clear();
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — queue processing
  // ════════════════════════════════════════════════════════════════

  /**
   * Trigger `processQueue()` if not already running.
   *
   * Bug fix (bg-queue audit): if `cancelled` is stuck true from a previous
   * Cancel/Pause, auto-resume when new tasks are explicitly enqueued by the
   * user (via `enqueuePageRange` / `enqueuePdf`). Without this, the queue
   * is permanently stuck after one cancel — "pressing buttons doesn't start
   * the process." The `cancelled` flag is for BEST-EFFORT cancellation of
   * in-flight work, NOT a permanent pause that requires explicit `resume()`.
   */
  private triggerProcessing(): void {
    if (this.cancelled) {
      // Auto-resume: user explicitly enqueued new work, so clear the stale
      // cancel flag. (If the user wanted to stay paused, they wouldn't have
      // clicked "Translate" / "Run all pending".)
      this.cancelled = false;
    }
    if (this.processing) return;
    // P1-4 (Phase 9): capture the promise so `dispose()` can await it.
    // Attach a no-op catch so the fire-and-forget can never leak an
    // unhandled rejection if processQueue itself rejects (it shouldn't —
    // its body is fully try/catch'd — but defensive).
    this.processingPromise = this.processQueue().catch(() => { /* swallow — see processQueue's own logging */ });
  }

  /**
   * The main processing loop. Runs ONE at a time (guarded by
   * `this.processing`). Picks pending tasks in (file-enqueue-order,
   * page-number-order) until either:
   *   - no pending tasks remain, OR
   *   - `this.cancelled` is set (between tasks).
   *
   * On exit, if new tasks arrived during teardown AND we're not
   * cancelled, re-triggers itself to drain them.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    const startedAt = Date.now();
    const hadQueuedFiles = this.files.size > 0;
    const debug = this.plugin.settings?.debugMode;

    // ── Parallel translation pipeline ────────────────────────────────
    //
    // Architecture:
    //   - EXTRACTION is sequential (1 page at a time). pdfjs blocks the
    //     main thread for 100–500ms per page; running extractions in
    //     parallel would freeze the UI and not actually speed things up
    //     (single-threaded JS).
    //   - TRANSLATION runs in parallel (configurable concurrency, default 3).
    //     LLM API calls are I/O-bound (network wait), so parallel requests
    //     give a 2–3× speedup on multi-page PDFs.
    //
    // Flow:
    //   1. Extraction loop: pick next pending task, extract paragraphs,
    //      push {state, task, paragraphs} to translationQueue.
    //   2. N translation workers run in parallel, each pulling from
    //      translationQueue, calling translateParagraphs(), building
    //      overlayData, persisting to .translations.md.
    //   3. After extraction loop finishes, wait for all translation workers
    //      to drain the queue.
    //
    // If concurrency is 1, this degrades gracefully to fully sequential
    // (extraction → translation → extraction → ...) — same as before.

    const concurrency = Math.max(1, Math.min(8,
      this.plugin.settings.backgroundTranslationConcurrency ?? 3
    ));
    if (debug) console.log(`${LOG_PREFIX} processQueue starting (concurrency=${concurrency})`);

    // P1-22 (Phase 10): high-watermark backpressure for the translation
    // queue. Without this, a fast extractor (e.g. 1000-page PDF) pushes
    // jobs into `translationQueue` far faster than the `concurrency`
    // workers can drain them (LLM API calls are I/O-bound, ~2-10s each),
    // causing `translationQueue` to grow unbounded and OOM the tab.
    //
    // The cap scales with concurrency so the queue can always keep the
    // workers busy (no idle time waiting for the next extraction) but
    // never holds more than `concurrency * 10` pages of paragraphs in
    // memory. For the default concurrency=3 → cap=30. Each
    // NormalizedParagraph is ~1-3 KB, so 30 pages × ~50 paragraphs each
    // × ~2 KB ≈ 3 MB worst case — well within the tab's heap budget.
    const MAX_QUEUE_SIZE = Math.max(10, concurrency * 10);

    // Queue of extracted-but-not-yet-translated pages.
    type TranslationJob = {
      state: QueueFileState;
      task: QueueTask;
      paragraphs: any[];  // NormalizedParagraph[]
      shortName: string;
    };
    const translationQueue: TranslationJob[] = [];
    let translationQueueClosed = false;

    // T1.3: count of workers that are still alive (a worker exits when it
    // observes cancellation, or — before the fix — after an empty page,
    // which killed workers one by one and DEADLOCKED the extraction loop's
    // backpressure wait once all of them were gone).
    let activeWorkers = 0;

    // Worker function: pull jobs from translationQueue, translate, persist.
    const translationWorker = async (workerId: number): Promise<void> => {
      activeWorkers++;
      try {
      while (true) {
        if (this.cancelled) return;
        // Shift the oldest job (FIFO — preserves page order within a file)
        const job = translationQueue.shift();
        if (!job) {
          if (translationQueueClosed) return;
          // Queue empty but extraction still running — wait briefly
          await new Promise(r => setTimeout(r, 50));
          continue;
        }

        const { state: jobState, task: jobTask, paragraphs, shortName } = job;

        // FIX H1: removed withFileLock wrapper — storage's writingPromises already
        // serializes the read-modify-write in updatePageOverlaysAndWrite. The outer
        // lock was serializing the entire translate+write per file, defeating
        // backgroundTranslationConcurrency for single-file batch (effective concurrency
        // = 1 instead of 3). Now translation (API calls) runs in parallel, writes are
        // serialized by storage's writingPromises lock.
        try {
            const translatableCount = paragraphs.filter((p: any) => p.text && p.text.trim().length > 0).length;
            if (translatableCount > 0) {
              new Notice(`🌐 [${shortName}] p${jobTask.pageNum}: translating ${translatableCount} segment(s)...`, 2000);
            }
            const translateStart = Date.now();
            const translatedTexts = await this.translateParagraphs(paragraphs, jobTask.pageNum, debug);
            const translateMs = Date.now() - translateStart;

            // FIX: respect sequentialDelayMs between pages when concurrency = 1
            // (sequential mode). When concurrency > 1, pages run in parallel and
            // delay would slow things down without benefit — parallel requests
            // are already spread across time by the worker pool.
            const concurrency = Math.max(1, Math.min(8,
              this.plugin.settings.backgroundTranslationConcurrency ?? 3
            ));
            if (concurrency === 1) {
              const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
              if (delayMs > 0) {
                await new Promise(r => setTimeout(r, delayMs));
              }
            }

            // FIX C3: check cancel AFTER translation but BEFORE write.
            // T1.3: a cancelled task returns to 'pending' (NOT 'error') so a
            // later Resume re-processes it instead of leaving it stuck as a
            // failed page. The worker itself exits — cancellation means stop.
            if (this.cancelled) {
              jobTask.status = 'pending';
              jobTask.error = undefined;
              jobTask.finishedAt = undefined;
              this.notifyChange();
              return;
            }

            if (debug) {
              console.log(`${LOG_PREFIX} [p${jobTask.pageNum}] Translated ${translatedTexts.length} segment(s) in ${translateMs}ms (worker ${workerId}).`);
            }

            const overlayData = this.buildOverlayData(paragraphs, translatedTexts);

            // FIX C4: if all paragraphs were empty (e.g. image-only page),
            // don't write anything — prevents creating a page bucket with
            // only empty-ot overlays that would trigger parser bugs.
            //
            // T1.3 (deadlock fix): `continue`, NOT `return`. The old `return`
            // KILLED THE WORKER after every textless page; with default
            // concurrency 3, three scanned pages in a row left zero workers
            // alive, and the extraction loop's backpressure wait
            // (`while (translationQueue.length >= MAX_QUEUE_SIZE) …`)
            // blocked forever with nobody left to drain the queue.
            if (overlayData.length === 0) {
              jobTask.status = 'done';
              jobTask.finishedAt = Date.now();
              this.plugin.logDebug?.(
                `${LOG_PREFIX} [p${jobTask.pageNum}] Done: 0 paragraphs (all empty, nothing to write).`
              );
              this.notifyChange();
              continue;
            }

            await this.plugin.storage.updatePageOverlaysAndWrite(
              jobState.file,
              { [jobTask.pageNum]: overlayData },
              // T-FULLPAGE-OVERWRITE: overlayData enumerates EVERY paragraph
              // of the page (complete state) — REPLACE, don't merge, or a
              // re-translated page keeps the previous generation's items
              // wherever rects drifted apart.
              { replace: true },
            );

            jobTask.status = 'done';
            jobTask.finishedAt = Date.now();
            const totalMs = jobTask.finishedAt - (jobTask.startedAt ?? jobTask.finishedAt);
            this.plugin.logDebug?.(
              `${LOG_PREFIX} [p${jobTask.pageNum}] Done: ${overlayData.length} paragraph(s) ` +
              `(translate=${translateMs}ms, total=${totalMs}ms, worker ${workerId}).`,
            );
            this.notifyChange();
          } catch (err: any) {
            const rawMsg = err?.message ?? String(err);
            const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
            jobTask.status = 'error';
            jobTask.error = isTimeout ? 'timeout' : rawMsg;
            jobTask.finishedAt = Date.now();
            console.error(
              `${LOG_PREFIX} Page ${jobTask.pageNum} of "${jobState.file.path}" translation failed: ${rawMsg}`,
              err,
            );
            this.notifyChange();
          }
      }
      } finally {
        // T1.3: worker bookkeeping — decrement no matter how the loop exits.
        activeWorkers--;
      }
    };

    // Start N translation workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(translationWorker(i));
    }

    try {
      // ── EXTRACTION LOOP (sequential, batched per file) ───────────
      //
      // P1-23 (Phase 10): the previous loop called `extractPage` once per
      // page, which re-loaded the PDF document on every iteration (100
      // document loads for a 100-page PDF — each ~100-300ms of pure
      // overhead, plus a fresh Uint8Array copy of the whole file). Now
      // we collect ALL pending pages for the current file and call
      // `extractPagesBatch` once — the document is loaded exactly once
      // per file, and the buffer is copied exactly once per batch.
      //
      // `findNextPendingTask` already returns the (file, page) with the
      // smallest `startedAt` and smallest page number — so consecutive
      // iterations naturally operate on the same file until its pending
      // pages are exhausted, then move to the next file. We exploit
      // that here by batching all pending pages of `next.state` in one
      // `extractPagesBatch` call.
      while (!this.cancelled) {
        const next = this.findNextPendingTask();
        if (!next) break;  // no more pending tasks
        const { state } = next;

        // Collect ALL pending pages for THIS file (page-ascending order,
        // matching the previous per-page iteration order).
        const pendingTasks: Array<{ pageNum: number; task: QueueTask }> = [];
        const pageNums = [...state.tasks.keys()].sort((a, b) => a - b);
        for (const pn of pageNums) {
          const t = state.tasks.get(pn);
          if (t && t.status === 'pending') {
            pendingTasks.push({ pageNum: pn, task: t });
          }
        }
        if (pendingTasks.length === 0) continue;  // defensive — findNextPendingTask guarantees ≥1

        const shortName = state.file.basename.length > 30
          ? state.file.basename.slice(0, 27) + '...'
          : state.file.basename;

        // Mark all pending tasks in this file as 'running' BEFORE the
        // batch extraction starts, so the UI shows them as in-progress
        // while the (long-running) batch is in flight.
        for (const { task } of pendingTasks) {
          task.status = 'running';
          task.startedAt = Date.now();
          task.error = undefined;
          task.finishedAt = undefined;
        }
        this.notifyChange();

        const batchPageNums = pendingTasks.map(p => p.pageNum);
        if (debug) console.log(`${LOG_PREFIX} [${shortName}] Batch extracting ${batchPageNums.length} page(s): ${batchPageNums.join(',')}`);
        new Notice(`📖 [${shortName}] extracting ${batchPageNums.length} page(s)...`, 2000);

        const extractStart = Date.now();
        let results: Map<number, ExtractPageResult | { error: string; pageNum: number }>;
        try {
          results = await this.extractor.extractPagesBatch(state.file, batchPageNums);
        } catch (err: any) {
          // Catastrophic batch failure (corrupt PDF, encrypted document,
          // IO error) — mark ALL pending tasks in this file as errored
          // and move on to the next file. Per-page failures are handled
          // in the loop below (they're recorded in the result Map).
          const rawMsg = err?.message ?? String(err);
          const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
          console.error(
            `${LOG_PREFIX} Batch extraction failed for "${state.file.path}" (${batchPageNums.length} page(s)): ${rawMsg}`,
            err,
          );
          for (const { task } of pendingTasks) {
            task.status = 'error';
            task.error = isTimeout ? 'timeout' : rawMsg;
            task.finishedAt = Date.now();
          }
          this.notifyChange();
          // Yield to the event loop before the next file (UI repaint)
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          continue;
        }
        const extractMs = Date.now() - extractStart;
        if (debug) console.log(`${LOG_PREFIX} [${shortName}] Batch extraction done in ${extractMs}ms (${results.size} results).`);

        // Distribute per-page results and push to translationQueue with
        // P1-22 (Phase 10) backpressure.
        for (const { pageNum, task } of pendingTasks) {
          // Cancellation check after the batch — if cancelled mid-batch,
          // mark remaining un-pushed tasks as cancelled.
          if (this.cancelled) {
            task.status = 'error';
            task.error = 'cancelled';
            task.finishedAt = Date.now();
            this.notifyChange();
            continue;
          }

          const result = results.get(pageNum);
          if (!result) {
            task.status = 'error';
            task.error = 'no result returned from batch extraction';
            task.finishedAt = Date.now();
            console.error(`${LOG_PREFIX} [p${pageNum}] of "${state.file.path}" — no result returned.`);
            this.notifyChange();
            continue;
          }

          if ('error' in result) {
            const rawMsg = result.error;
            const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
            task.status = 'error';
            task.error = isTimeout ? 'timeout' : rawMsg;
            task.finishedAt = Date.now();
            console.error(
              `${LOG_PREFIX} Page ${pageNum} of "${state.file.path}" extraction failed: ${rawMsg}`,
            );
            this.notifyChange();
            continue;
          }

          if (debug) {
            console.log(`${LOG_PREFIX} [p${pageNum}] Extracted ${result.paragraphs.length} paragraph(s).`);
          }

          // P1-22 (Phase 10): high-watermark backpressure. Wait for the
          // translation workers to drain the queue before pushing more
          // jobs — prevents `translationQueue` from growing unbounded on
          // large PDFs (which would OOM the tab).
          //
          // T1.3 (deadlock guard): if NO workers are alive anymore, break —
          // waiting would be forever. (Workers can exit on cancellation;
          // combined with the empty-page `continue` fix above, this makes
          // the loop structurally unable to hang.)
          while (translationQueue.length >= MAX_QUEUE_SIZE) {
            if (this.cancelled || this.disposed || activeWorkers === 0) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (this.cancelled) {
            task.status = 'error';
            task.error = 'cancelled before queue push';
            task.finishedAt = Date.now();
            this.notifyChange();
            continue;
          }

          // Push to translation queue — workers will pick it up
          translationQueue.push({
            state, task,
            paragraphs: result.paragraphs,
            shortName,
          });
          this.notifyChange();
        }

        // Yield to the event loop between extractions so Obsidian can repaint
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} processQueue extraction loop crashed:`, err);
    } finally {
      // Signal workers that no more jobs will be added
      translationQueueClosed = true;
      // Wait for all workers to finish remaining translations
      await Promise.allSettled(workers);
      this.processing = false;

      // T1.2 (safety net): auto-clear a stale cancel flag once the queue is
      // fully idle. `cancelled` was meant as a best-effort stop for in-flight
      // work, NOT a permanent pause — but combined with the old global probes
      // in processing.ts it used to poison every subsequent manual run (see
      // the "Error: cancelled" boot bug, T1.1). With tokens in place this is
      // belt-and-suspenders, keeping the flag from sticking around after an
      // aborted batch was fully drained or cleared.
      if (this.cancelled && !this.hasPendingTasks()) {
        this.cancelled = false;
      }

      // If a task was added during teardown, re-trigger
      if (!this.cancelled && this.hasPendingTasks()) {
        // P1-4 (Phase 9): store the re-trigger promise too, so a
        // concurrent dispose() still awaits the chained drain.
        this.processingPromise = this.processQueue().catch(() => { /* swallow */ });
      } else if (hadQueuedFiles && !this.cancelled) {
        const { totalDone, totalError } = this.getState();
        const parts: string[] = [];
        if (totalDone > 0) parts.push(`${totalDone} page(s) extracted+translated`);
        if (totalError > 0) parts.push(`${totalError} failed`);
        if (parts.length > 0) {
          new Notice(`Layout queue finished: ${parts.join(', ')}.`, 4000);
        }
        this.plugin.logDebug?.(`${LOG_PREFIX} Queue drained in ${Date.now() - startedAt}ms (concurrency=${concurrency}).`);
      }
    }
  }

  /**
   * Find the next pending task in priority order:
   *   1. Files in order of `startedAt` (FIFO — oldest file first).
   *   2. Pages within a file in ascending page-number order.
   *
   * Returns `null` if no pending tasks remain.
   */
  private findNextPendingTask(): { state: QueueFileState; task: QueueTask } | null {
    // FIX: sort by startedAt (enqueue order) — oldest first. This ensures
    // files are processed in the order the user enqueued them, not in
    // arbitrary Map iteration order. When the user selects file A then
    // file B, A's pages are translated before B's.
    const states = [...this.files.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const state of states) {
      // Sort page numbers ascending — natural reading order.
      const pageNums = [...state.tasks.keys()].sort((a, b) => a - b);
      for (const pageNum of pageNums) {
        const task = state.tasks.get(pageNum);
        if (task && task.status === 'pending') {
          return { state, task };
        }
      }
    }
    return null;
  }

  /** True if any task anywhere is in 'pending' state. */
  private hasPendingTasks(): boolean {
    for (const state of this.files.values()) {
      for (const task of state.tasks.values()) {
        if (task.status === 'pending') return true;
      }
    }
    return false;
  }

  /**
   * Translate all paragraphs on a page using batch translation.
   *
   * Mirrors HeadlessTranslator.translateFile() logic:
   *   1. Build `[#N] text` numbered batch from paragraph texts
   *   2. Call translation.translateBatch()
   *   3. Extract numbered lines via processor.extractNumberedLines()
   *   4. Strip <br> tags (Phase 7: translation should be continuous text)
   *
   * Falls back to original text on translation failure (page-level fault
   * tolerance — one bad page doesn't abort the whole PDF).
   *
   * Empty paragraphs (no text content) are skipped and get empty translations.
   *
   * Called by translation workers in processQueue() — runs in parallel
   * with other pages (configurable via backgroundTranslationConcurrency).
   */
  private async translateParagraphs(
    paragraphs: NormalizedParagraph[],
    pageNum: number,
    debug: boolean,
  ): Promise<string[]> {
    if (!paragraphs.length) return [];

    // Identify which paragraphs have translatable text
    const translatableIndices: number[] = [];
    const translatableTexts: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i].text;
      if (text && text.trim().length > 0) {
        translatableIndices.push(i);
        translatableTexts.push(text);
      }
    }

    // Initialize result with empty strings; fill in translated entries below
    const result: string[] = new Array(paragraphs.length).fill('');

    if (translatableTexts.length === 0) {
      if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] No translatable text on page.`);
      return result;
    }

    // T2.2: the queue's own paragraph-filter pass was REMOVED — it ran in
    // addition to the identical pass inside executeTranslation, doubling
    // the work and drifting apart from the interactive path whenever one
    // of the two was changed. executeTranslation now owns filtering (and
    // fills skipped paragraphs with their original text itself).

    let translated: string[];
    try {
      // Minimal TranslationUnit-like wrappers; executeTranslation applies
      // the paragraph filter, [#N] batching, line-break policy and
      // degradation tracking (T1.8) exactly like the interactive path.
      // T1.2: cancellation is passed explicitly as a TOKEN owned by this
      // queue — the translation core no longer probes the queue's global
      // flag (which poisoned interactive runs — see T1.1/T1.2 notes).
      const pseudoUnits = translatableTexts.map((text, i) => ({
        id: `p${pageNum}-${i}`,
        paragraphId: `p${pageNum}-${i}`,
        originalSpans: [],
        text,
      } as any));
      translated = await this.plugin.processor.executeTranslation(pseudoUnits, {
        isCancelled: () => this.isCancelled(),
      });
    } catch (err: any) {
      // Page-level fault tolerance: fall back to originals rather than
      // aborting the whole PDF. The user can re-translate this page later.
      const failureReason = err?.message ?? String(err);
      console.warn(`${LOG_PREFIX} [p${pageNum}] Translation failed, using originals as fallback:`, err);
      new Notice(
        `[p${pageNum}] Translation failed: ${failureReason.length > 80 ? failureReason.substring(0, 77) + '...' : failureReason}\n` +
        `Translation completed. Some pages fell back to original text.`,
        8000,
      );
      translated = translatableTexts.slice();
    }

    // Map translated texts back to original paragraph indices (1:1 by
    // construction — executeTranslation returns one line per pseudo-unit).
    for (let j = 0; j < translatableIndices.length; j++) {
      const origIdx = translatableIndices[j];
      const fallback = translatableTexts[j];
      // NOTE (T5.3): no unconditional <br>-stripping anymore — the line-break
      // policy (table-like / preserveSourceLineBreaks) was already applied
      // inside executeTranslation; stripping here would flatten tables again.
      const line = (translated[j] || '').trim();
      result[origIdx] = line || fallback;
    }

    return result;
  }

  /**
   * Build OverlayPositionData[] from extracted paragraphs and their translations.
   *
   * FIX C4: skip paragraphs that have NEITHER original text NOR a translation.
   * These would produce overlays with empty `textContent` AND empty
   * `translatedText`, which the writer emits as `%% {"ot":""} %%` followed
   * by `<!-- empty -->`. While the parser now handles this correctly (Fix A1),
   * creating such overlays in the first place is wasteful and was the
   * trigger for the original cross-page contamination bug.
   *
   * Empty-ot overlays typically come from PDF page-jump indicators or
   * whitespace-only text spans that pdfjs extracts with valid bboxes but
   * empty `str`.
   */
  private buildOverlayData(paragraphs: NormalizedParagraph[], translatedTexts: string[]): OverlayPositionData[] {
    if (!Array.isArray(paragraphs)) return [];
    const result: OverlayPositionData[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const translated = (translatedTexts[i] || '').trim();
      const original = (p.text || '').trim();

      // FIX C4: skip paragraphs with no original text and no translation.
      if (!original && !translated) continue;

      try {
        // T2.5: single construction site (stable id + engine stamped inside
        // the factory, invalid rects rejected by its invariant instead of
        // silently producing corrupt records).
        result.push(makeOverlay({
          page: p.page,
          rect: p.relativeRect,
          text: p.text,
          translated: translated || p.text,
          fontFamily: p.fontFamily,
          fontSize: p.fontSize,
          originalFontSizes: p.originalFontSizes,
          engine: getCurrentEngine(this.plugin),
        }));
      } catch {
        // invalid rect/page — skip (factory invariant)
      }
    }
    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — state helpers
  // ════════════════════════════════════════════════════════════════

  /** Look up or create a `QueueFileState` for the given file. */
  private getOrCreateFileState(file: TFile): QueueFileState {
    let state = this.files.get(file.path);
    if (!state) {
      state = {
        file,
        totalPages: 0,
        tasks: new Map(),
        startedAt: Date.now(),
      };
      this.files.set(file.path, state);
    } else {
      // Refresh the TFile reference in case the path is the same but
      // the file object changed (e.g. after a vault reload).
      state.file = file;
    }
    return state;
  }

  /**
   * Return the set of page numbers already cached in `.translations.md`
   * for the given PDF. Used by `enqueuePdf()` to skip already-processed
   * pages.
   *
   * Returns an empty set on storage errors — fail open (will re-extract).
   *
   * FIX (originals-only): if the file is marked `originals-only: true`,
   * returns an empty set so ALL pages are re-translated.
   */
  private async getCachedPages(file: TFile): Promise<Set<number>> {
    const cached = new Set<number>();
    try {
      const saved = await this.plugin.storage.readSavedOverlayForFile(file);
      if (!saved) return cached;

      // FIX: originals-only files are never "cached" — always re-translate.
      if (this.isOriginalsOnly(saved.mdFile)) {
        this.plugin.logDebug?.(
          `${LOG_PREFIX} getCachedPages: "${file.path}" is originals-only — will re-translate all pages.`
        );
        return cached;
      }

      // Phase 8 (V4 Schema / P2-3): layoutSettingsHash mismatch → no pages
      // cached. Same migration policy as the per-page check: missing hash
      // (V3 file) = treat as match.
      if (saved.overlay.layoutSettingsHash !== undefined) {
        const currentHash = computeLayoutSettingsHash(this.plugin.layoutSettings);
        if (saved.overlay.layoutSettingsHash !== currentHash) {
          this.plugin.logDebug?.(
            `${LOG_PREFIX} getCachedPages: "${file.path}" layoutSettingsHash mismatch ` +
            `(file=${saved.overlay.layoutSettingsHash.slice(0, 8)}… current=${currentHash.slice(0, 8)}…) — re-translating all pages.`
          );
          return cached;
        }
      }

      for (const key of Object.keys(saved.overlay.pageOverlays)) {
        const items = saved.overlay.pageOverlays[key];
        if (Array.isArray(items) && items.length > 0) {
          const n = Number(key);
          if (Number.isFinite(n) && n >= 1) cached.add(n);
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} getCachedPages: storage read failed for "${file.path}":`, err);
    }
    return cached;
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — subscriber notification
  // ════════════════════════════════════════════════════════════════

  /**
   * Notify all subscribers of a state change. Subscriber callbacks are
   * invoked synchronously; errors in one callback do not block the
   * others (each is wrapped in try/catch).
   */
  private notifyChange(): void {
    if (this.subscribers.size === 0) return;
    // Snapshot to a local array so a callback that unsubscribes itself
    // (or adds a new subscriber) doesn't mutate the Set mid-iteration.
    const callbacks = [...this.subscribers];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error(`${LOG_PREFIX} subscriber callback threw:`, err);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — lifecycle guards
  // ════════════════════════════════════════════════════════════════

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`${LOG_PREFIX} queue has been disposed`);
    }
  }
}
