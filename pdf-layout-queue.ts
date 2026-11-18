import { fallbackIndices, withFallbacks } from './translation-result';
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
// 1. Concurrency model — claim + semaphore scheduler (Phase 5.3)
// ─────────────────────────────────────────────────────────────────────
//    Exactly ONE drain loop (`processQueue()`) runs at any time, guarded
//    by the `processing` flag. The loop CLAIMS pages in bounded chunks
//    (FIFO by file-enqueue-order, pages ascending, in-flight window ≤
//    2×concurrency) and launches one translation coroutine per claimed
//    page through a semaphore that bounds concurrent LLM calls to
//    `backgroundTranslationConcurrency`.
//
//    Extraction runs sequentially per file from ONE open document session
//    (P1-23: one `getDocument` per file-pass, `PdfDocSession`), feeding
//    the semaphore while translations are in flight. A parked loop is
//    woken by a condition variable (task settle / enqueue / cancel /
//    dispose) — there is NO timed polling anywhere in the pipeline.
//
//    Every claimed task has exactly ONE owning coroutine; the terminal
//    transition happens in `settleTask` from that coroutine (or from the
//    launcher, for pages that never reach the LLM). A task can therefore
//    never be "dropped on the floor" — the Q-1 worker-death class is
//    structural now, and the Q-2a sweep remains only as an invariant net.
//
//    Re-entrancy: `enqueue*` calls wake a parked loop directly; after the
//    loop finishes, the finally-block re-triggers itself if runnable tasks
//    arrived during teardown.
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
import type { NormalizedParagraph, ExtractPageResult, PdfDocSession } from './pdf-text-extractor';
import type { OverlayPositionData } from './types';
// P0-1 (Phase 1): static import replaces runtime `require('./paragraph-filter')`,
// which throws `ReferenceError: require is not defined` on mobile (Obsidian's
// mobile runtime has no CommonJS shim). Background queue path crashed on
// mobile whenever paragraphFilterRules were enabled (the defaults).
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Stamped on
// every queue-built overlay so the saved result has an id matching what
// the DOM-extraction and headless paths produce for the same source
// paragraph — enables merge-by-id-first in updatePageOverlaysAndWrite.
import { generateOverlayId, getCurrentEngine, computeLayoutSettingsHash } from './overlay-id';
// Phase 5.1 (W-2b, 2026-09-13): owner-scoped job tokens replace the global
// `cancelled` flag. Cancelling a SCOPE (watcher stop, headless Cancel) no
// longer kills unrelated in-flight jobs of the shared queue.
import { JobToken, JobScope, raceSignal, isAbortError, makeAbortError } from './job-token';
// Phase 5.2 (2026-09-13): per-file state object — FileJob owns the task
// map, the disk-cache reads, and a per-file LRU paragraph cache. The old
// raw `QueueFileState` record is gone; the class implements the same
// interface, so getState() snapshots keep their shape.
import { FileJob } from './file-job';

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
  /**
   * Phase 5.1: the job token that OWNS this task. Cancellation is scoped
   * to the owning job (cancelScope / cancelAll); a cancelled job's task
   * returns to 'pending' — it did NOT fail. Re-enqueue re-assigns a fresh
   * token to pending tasks, which re-activates them.
   */
  job?: JobToken;
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
// Phase 5.3: semaphore — bounds concurrent translation coroutines.
//
// Replaces the old N-worker pool + its 50ms polling loop. Parked
// coroutines resume via microtask the moment a slot frees (the `release`
// chain), so there is no wake-up latency and no CPU burn while the LLM
// requests are in flight. ~15 lines, zero dependencies — an in-repo
// equivalent of p-limit (a runtime dep was rejected: Obsidian plugins
// ship bundled, 15 lines do not justify one).
// ─────────────────────────────────────────────────────────────────────

interface Semaphore {
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function makeSemaphore(limit: number): Semaphore {
  let active = 0;
  const parked: Array<() => void> = [];   // queued invocations (FIFO)
  const release = (): void => {
    active--;
    const next = parked.shift();
    if (next) next();
  };
  return {
    run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const invoke = (): void => {
          active++;
          try {
            fn().then(resolve, reject).finally(release);
          } catch (err) {
            // fn() threw synchronously (async fns never do, but defensive):
            // release the slot, then propagate.
            release();
            reject(err);
          }
        };
        if (active < limit) invoke();
        else parked.push(invoke);
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────────────

export class PdfLayoutQueue {
  // ── 5.4: emission / Notice throttling windows ──────────────────────
  /** Coalescing window for subscriber flushes (leading+trailing). */
  private static readonly NOTIFY_COALESCE_MS = 100;
  /** Minimum spacing between aggregated progress Notices. */
  private static readonly PROGRESS_NOTICE_MS = 500;

  // ── Dependencies ──────────────────────────────────────────────────
  private readonly plugin: OpenRouterTranslatorPlugin;
  private readonly extractor: PdfTextExtractor;

  // ── Per-file state, keyed by vault path ───────────────────────────
  // 5.2: FileJob — the raw record promoted to a class. Map invariant:
  // the key is always `file.path` (the only writer, getOrCreateFileJob,
  // uses the TFile's path), so direct key lookups are safe.
  private readonly files: Map<string, FileJob> = new Map();

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
  // ── Subscribers ───────────────────────────────────────────────────
  private readonly subscribers = new Set<() => void>();
  // ── 5.4: coalesced change emission ────────────────────────────────
  // notifyChange() used to invoke every subscriber synchronously on EVERY
  // state transition — a 500-page PDF produced ~1500 subscriber calls
  // (each a full watcher-modal render() + modal progress pass). Now the
  // first transition after a quiet period flushes immediately (leading
  // edge) and everything inside the window collapses into ONE trailing
  // flush at the window boundary — a burst that previously rendered N
  // times renders at most twice.
  /** Timestamp (Date.now) of the last ACTUAL subscriber flush. */
  private notifyLastFlushAt = 0;
  /** Pending trailing-flush timer while a burst is being coalesced. */
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  // ── 5.4: aggregated progress Notice ───────────────────────────────
  // The per-page `🌐 [file] pN: translating M segment(s)` Notice stormed
  // the UI (one popup per page ≈ 500 on a big PDF). reportProgressNotice
  // throttles to one aggregated status per 500 ms with the LATEST
  // done/total numbers; terminal Notices keep dedicated semantics.
  private progressNoticeLastAt = 0;
  private progressNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────
  private disposed = false;

  // ── Scheduler (Phase 5.3) ────────────────────────────────────────
  /**
   * Claimed-but-not-terminal tasks: extraction in progress, translation
   * queued in the semaphore or running. `claimNextChunk` keeps this ≤
   * 2×concurrency (the honest-status window — a 'running' page is inside
   * the ACTIVE pipeline, not the whole file as in the pre-5.3 pre-mark).
   * Every claim does exactly one ++; every `settleTask` exactly one --.
   */
  private activeTasks = 0;
  /**
   * Parked drain-loop waiters (the condition variable). `wakeDrain()`
   * resolves them all — called from settleTask, every enqueue, cancel*,
   * clearFile and dispose. Between the loop's condition check and the
   * park there is no await, so a wake can never be lost to a race: a
   * settle either happens entirely before the check (loop sees the new
   * activeTasks) or entirely after the park (waiter registered).
   */
  private drainWaiters: Array<() => void> = [];

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
  async withFileLock<T>(filePath: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const existing = this.fileTranslationLocks.get(filePath) || Promise.resolve();
    // S-1 fix (2026-09-12): a lock must not inherit its previous holder's
    // rejection. `await existing` below threw when the previous holder had
    // failed — `fn()` was then skipped, so the headless pipeline lost EVERY
    // subsequent page of the file after one failed page. The previous error
    // is already reported to its own caller; here we only neutralize it.
    // `newLock = existingSafe.then(() => next)` keeps the serialization
    // semantics (next holder waits for the previous holder in ANY terminal
    // state).
    const existingSafe = existing.catch(() => {});
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
    const newLock = existingSafe.then(() => next);
    this.fileTranslationLocks.set(filePath, newLock);

    // Keep the lock chain registered until previous holders finish, even
    // when this waiter is cancelled before acquiring it.
    void newLock.then(() => {
      if (this.fileTranslationLocks.get(filePath) === newLock) this.fileTranslationLocks.delete(filePath);
    });
    try {
      await raceSignal(existingSafe, signal);
      if (signal?.aborted) throw makeAbortError();
      return await fn();
    } finally {
      resolveNext();
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
      /** Phase 5.1: owner token. Omitted → a fresh 'command' job. */
      token?: JobToken;
    },
  ): Promise<number> {
    this.assertNotDisposed();
    // 5.1: job ownership. The caller may pass its own scoped token
    // (modal.ts → 'modal'); otherwise this is a user command.
    const token = options?.token
      ?? new JobToken('command', `pageRange ${file.basename} [${startPage}-${endPage}]`);
    if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
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
    this.assertNotDisposed();
    if (token.cancelled) return 0;
    if (endPage > totalPages) endPage = totalPages;
    if (startPage > totalPages) return 0;

    // FIX: removed cached-pages check — user can now re-translate already-cached
    // pages via "Translate multiple pages". Previously cached pages were skipped
    // silently, which was confusing when the user wanted to overwrite with a
    // different provider or updated prompt. Now ALL pages in the range are
    // queued (cached or not), giving the user full control.
    const state = this.getOrCreateFileJob(file);
    state.totalPages = totalPages;

    let queued = 0;
    for (let p = startPage; p <= endPage; p++) {
      const existing = state.tasks.get(p);
      if (existing) {
        // Allow re-translation: reset any existing task to pending.
        // (Previously 'done' and 'running' were skipped — now only 'running'
        // is preserved to avoid duplicate in-flight work on the same page.)
        // Q-2b fix (2026-09-12): 'running' is only meaningful while the
        // processing loop is ALIVE. A 'running' task with a dead loop is an
        // abandoned job (cancel/crash) that must be re-queued, not skipped —
        // the sweep in processQueue's finally normally cleans these, this
        // guard covers the enqueue racing the sweep.
        if ((existing.status === 'running' || (existing.status === 'pending' && !existing.job?.cancelled)) && this.processing) continue;
        existing.status = 'pending';
        // 5.1: re-assignment — a pending/error/done task being re-queued
        // now belongs to THIS job (paused tasks re-activate here).
        existing.job = token;
        existing.error = undefined;
        existing.startedAt = undefined;
        existing.finishedAt = undefined;
      } else {
        state.tasks.set(p, { file, pageNum: p, status: 'pending', job: token });
      }
      queued++;
    }

    if (queued > 0) {
      this.plugin.logDebug?.(
        `Queued ${queued} page(s) [${startPage}-${endPage}] for "${file.path}".`
      );
      this.notifyChange();
      this.triggerProcessing();
      this.wakeDrain();   // 5.3: a parked loop picks the new pages up now
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
   * Phase 5.1: paused (job-cancelled) pending tasks are re-activated by
   * any enqueue — the task is re-assigned to the new job's token.
   */
  async enqueuePage(
    file: TFile,
    pageNum: number,
    opts?: { token?: JobToken },
  ): Promise<void> {
    this.assertNotDisposed();
    const token = opts?.token
      ?? new JobToken('command', `page ${file.basename} p${pageNum}`);
    if (!Number.isInteger(pageNum) || pageNum < 1) {
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
      // 5.2: the disk-cache read moved into FileJob (static — no job/state
      // object is created on the cached-skip path, exactly like the old
      // helper; an empty job in the Map would be visible junk in the
      // watcher modal). Same fail-open semantics on storage errors.
      const cachedPages = await FileJob.readCachedPages(this.plugin, file);
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

    this.assertNotDisposed();
    if (token.cancelled) return;
    const state = this.getOrCreateFileJob(file);
    const existing = state.tasks.get(pageNum);

    if (existing) {
      // Q-2b fix (2026-09-12): 'running' blocks re-enqueue ONLY while the
      // loop is alive; a 'running' task with a dead loop is abandoned and
      // gets re-queued (see the finally-sweep in processQueue).
      if ((existing.status === 'running' || (existing.status === 'pending' && !existing.job?.cancelled)) && this.processing) {
        // Already processed or in-flight — no-op (per spec).
        return;
      }
      // Was 'pending' or 'error' (or a paused task of a cancelled job) —
      // reset to pending AND re-assign to the new job (5.1).
      existing.status = 'pending';
      existing.job = token;
      existing.error = undefined;
      existing.startedAt = undefined;
      existing.finishedAt = undefined;
    } else {
      state.tasks.set(pageNum, {
        file,
        pageNum,
        status: 'pending',
        job: token,
      });
    }

    this.notifyChange();
    this.triggerProcessing();
    this.wakeDrain();     // 5.3: a parked loop picks the new page up now
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
  async enqueuePdf(file: TFile, opts?: { token?: JobToken }): Promise<number> {
    this.assertNotDisposed();
    // 5.1: job ownership — watcher passes its 'watcher' token, commands
    // create a fresh 'command' job here.
    const token = opts?.token
      ?? new JobToken('command', `pdf ${file.basename}`);

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
    // 5.2: disk-cache read lives on FileJob (same originals-only /
    // layoutSettingsHash / fail-open semantics as the old helper).
    const cachedPages = await FileJob.readCachedPages(this.plugin, file);

    this.assertNotDisposed();
    if (token.cancelled) return 0;

    // 3. Find or create the file's job; update totalPages.
    const state = this.getOrCreateFileJob(file);
    state.totalPages = totalPages;

    let queued = 0;
    for (let p = 1; p <= totalPages; p++) {
      if (cachedPages.has(p)) continue;

      const existing = state.tasks.get(p);
      if (existing) {
        // Q-2b fix (2026-09-12): 'running' is a skip ONLY for a live loop;
        // an abandoned 'running' (dead loop) is re-queued — finally-sweep's
        // enqueue-side twin.
        if ((existing.status === 'running' || (existing.status === 'pending' && !existing.job?.cancelled)) && this.processing) {
          // In-flight or already finished — skip.
          continue;
        }
        // Reset 'error' / stale 'pending' to a fresh pending under THIS
        // job (5.1: re-assignment re-activates paused tasks).
        existing.status = 'pending';
        existing.job = token;
        existing.error = undefined;
        existing.startedAt = undefined;
        existing.finishedAt = undefined;
      } else {
        state.tasks.set(p, { file, pageNum: p, status: 'pending', job: token });
      }
      queued++;
    }

    if (queued > 0) {
      this.plugin.logDebug?.(`Queued ${queued}/${totalPages} page(s) for "${file.path}" (${cachedPages.size} cached).`);
      this.notifyChange();
      this.triggerProcessing();
      this.wakeDrain();   // 5.3: a parked loop picks the new pages up now
    } else {
      this.plugin.logDebug?.(`"${file.path}" — all ${totalPages} page(s) already cached; nothing to queue.`);
    }

    return queued;
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
   * Back-compat alias for `cancelAll()` (Phase 5.1). Prefer the scoped
   * `cancelScope()` — scoped cancellation is the entire point of job
   * tokens (W-2b: a watcher stop must not kill a modal translation).
   */
  cancel(): void {
    this.cancelAll();
  }

  /**
   * Phase 5.1 (W-2b): cancel every live job. Running tasks of cancelled
   * jobs return to 'pending' at their next per-task check (worker-level
   * job checks / raceSignal in translateParagraphs) — they did NOT fail.
   * Pending tasks stay pending; the next enqueue re-assigns them a fresh
   * token, which re-activates them (the old auto-resume semantics).
   *
   * Used by the public `cancel()` alias and by `dispose()`.
   */
  cancelJob(token: JobToken): void {
    token.cancel();
    this.notifyChange();
    this.wakeDrain();
  }

  cancelAll(): void {
    let cancelledJobs = 0;
    const seen = new Set<JobToken>();
    for (const state of this.files.values()) {
      for (const task of state.tasks.values()) {
        const job = task.job;
        if (job && !job.cancelled && !seen.has(job)) {
          seen.add(job);
          job.cancel('cancelled (all jobs)');
          cancelledJobs++;
        }
      }
    }
    this.plugin.logDebug?.(
      cancelledJobs > 0
        ? `${LOG_PREFIX} cancelAll: ${cancelledJobs} live job(s) cancelled — running tasks return to pending, paused tasks await re-enqueue.`
        : `${LOG_PREFIX} cancelAll: no live jobs.`,
    );
    if (cancelledJobs > 0) {
      this.notifyChange();
      this.wakeDrain();   // 5.3: in-flight aborts settle and wake on their own,
    }                     // but a parked loop should re-check claimability now
  }

  /**
   * Phase 5.1 (W-2b): cancel ONLY the jobs owned by `scope` — the scoped
   * replacement for the old global `cancel()`:
   *   • PdfWatcher.stop()/cancelRunning() → cancelScope('watcher') —
   *     an interactive "Translate pages" (modal) job and other files'
   *     command jobs keep running;
   *   • plugin unload → cancelAll().
   */
  cancelScope(scope: JobScope): void {
    let cancelledJobs = 0;
    const seen = new Set<JobToken>();
    for (const state of this.files.values()) {
      for (const task of state.tasks.values()) {
        const job = task.job;
        if (job && job.scope === scope && !job.cancelled && !seen.has(job)) {
          seen.add(job);
          job.cancel(`cancelled (${scope} scope)`);
          cancelledJobs++;
        }
      }
    }
    if (cancelledJobs > 0) {
      this.plugin.logDebug?.(
        `${LOG_PREFIX} cancelScope('${scope}'): ${cancelledJobs} job(s) cancelled.`,
      );
      this.notifyChange();
      this.wakeDrain();   // 5.3: paused tasks are not claimable — let the loop see it
    }
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
   * dropped the loop's next `claimNextChunk` call simply won't
   * see them.
   *
   * `processQueue()` itself never re-creates a file state on its own —
   * states are only created by `enqueuePdf` / `enqueuePageRange` /
   * `enqueuePage` / `getOrCreateFileJob` — so deleting the state here
   * will not race with the loop resurrecting it.
   *
   * Best-effort: if `processQueue()` is currently extracting / translating
   * a page for this exact file, that one in-flight task will still write
   * its overlay to `.translations.md` before the task is observed missing
   * on the next iteration. This is acceptable — the user can run "Clean
   * unused translations" later to remove the orphaned translation file.
   */
  clearFile(filePath: string): void {
    // 5.2: the file's job owns its teardown — dispose() cancels the file's
    // job tokens (the 5.1 behavior, so a still-referenced token cannot
    // masquerade as a live job) and frees the disk/paragraph caches.
    const job = this.getFileJob(filePath);
    if (!job) return;
    job.dispose();
    this.files.delete(job.file.path);
    this.notifyChange();
    this.plugin.logDebug?.(`clearFile: dropped queue state for "${filePath}".`);
    this.wakeDrain();     // 5.3: the file's in-flight tasks settle via their own
  }                       // coroutines; a parked loop must re-check claimability


  /**
   * Phase 5.2: read-only access to a file's job object — the W-1 occupancy
   * guard in PdfWatcher (and tests) reads this instead of walking
   * getState() snapshots. Returns undefined when the file has no queue
   * state. Direct Map lookup is safe: the key is always `file.path`.
   */
  getFileJob(filePath: string): FileJob | undefined {
    return this.files.get(filePath);
  }

  /**
   * Phase 5.1: true when every non-terminal task of the file belongs to a
   * CANCELLED job — the file will make no progress until re-enqueued
   * (fresh token re-assignment). Replaces the old global `isCancelled()`
   * early-exits in PdfWatcher's wait/status paths, now PER-FILE: a
   * cancelled job on file A no longer stalls the wait for file B (W-2b).
   */
  isFileStalled(filePath: string): boolean {
    // 5.2: direct job lookup (Map keyed by vault path).
    const job = this.getFileJob(filePath);
    if (!job) return false;
    let nonTerminal = 0;
    let stalled = 0;
    for (const task of job.tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') {
        nonTerminal++;
        if (task.job?.cancelled) stalled++;
      }
    }
    return nonTerminal > 0 && nonTerminal === stalled;
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
   * repeat calls. All live jobs are cancelled immediately (synchronously)
   * so that any subsequent `triggerProcessing()` re-entry from a racing
   * subscriber callback no-ops, and the in-flight loop stops picking up
   * new tasks (cancelled-job tasks are skipped by claimNextChunk).
   *
   * NOTE: callers that cannot await (e.g. Obsidian's sync `onunload`)
   * should fire-and-forget with a `.catch(() => {})` to avoid leaking
   * an unhandled rejection — see `main.ts onunload`.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // 5.1: cancel every live job (was: flipping the global cancel flag).
    // The loop
    // stops picking up tasks (claimNextChunk skips cancelled-job
    // tasks); in-flight tasks return to 'pending' via the per-task checks.
    this.cancelAll();
    // 5.3: wake a parked drain loop — it re-checks `disposed`, exits its
    // loop, drains the tracked coroutines and returns (processingPromise).
    this.wakeDrain();
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
    // 5.4: drop pending coalescing work — no flushes after teardown.
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
    if (this.progressNoticeTimer) { clearTimeout(this.progressNoticeTimer); this.progressNoticeTimer = null; }
    // 5.2: each job owns its caches — dispose them all before dropping
    // (tokens were already cancelled by cancelAll() above; this also
    // clears the paragraph caches so a disposed queue holds no memory).
    for (const job of this.files.values()) {
      job.dispose();
    }
    this.files.clear();
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — queue processing
  // ════════════════════════════════════════════════════════════════

  /**
   * Trigger `processQueue()` if not already running.
   *
   * 5.1: the old auto-resume hack (clearing a stuck global flag here) is
   * gone with the flag itself. A paused (job-cancelled) task is re-activated
   * by RE-ENQUEUE: the enqueue APIs assign a fresh token to pending tasks,
   * which makes them runnable again — the same UX ("pressing Translate
   * starts the work"), scoped to the jobs the user actually restarted.
   *
   * 5.3: enqueues additionally call `wakeDrain()` — a parked loop claims
   * the new tasks immediately instead of waiting for its next park cycle.
   */
  private triggerProcessing(): void {
    if (this.processing) return;
    // P1-4 (Phase 9): capture the promise so `dispose()` can await it.
    // Attach a no-op catch so the fire-and-forget can never leak an
    // unhandled rejection if processQueue itself rejects (it shouldn't —
    // its body is fully try/catch'd — but defensive).
    this.processingPromise = this.processQueue().catch(() => { /* swallow — see processQueue's own logging */ });
  }

  /**
   * Phase 5.3: resolve every parked drain-loop waiter. The condition
   * variable's "notify all". See `drainWaiters` for the no-lost-wake
   * argument (the check+park region is synchronous).
   */
  private wakeDrain(): void {
    if (this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) {
      try { w(); } catch { /* a resolver never throws, but defensive */ }
    }
  }

  /** Phase 5.3: park the drain loop until the next `wakeDrain()`. */
  private waitDrainSignal(): Promise<void> {
    return new Promise<void>(resolve => { this.drainWaiters.push(resolve); });
  }

  /**
   * Phase 5.3: THE terminal transition — one place, one owner.
   *
   * Every claimed task passes through here exactly once (claimed by
   * `claimNextChunk`, settled by its coroutine's completion — or by the
   * launcher for pages that never reach the LLM: cancelled pre-launch,
   * extraction failure). This centralizes what the old worker loop,
   * distribution loop and sweep each did a slice of:
   *
   *   • status + error + timestamps;
   *   • the activeTasks decrement (the in-flight window);
   *   • notifyChange (subscribers re-render);
   *   • wakeDrain (a parked loop re-checks claimability).
   *
   * 'pending' means PAUSED (5.1 semantics: a cancelled job's task did NOT
   * fail — no startedAt/finishedAt, re-activated by the next enqueue).
   */
  private settleTask(task: QueueTask, status: 'done' | 'error' | 'pending', error?: string): void {
    task.status = status;
    task.error = error;
    if (status === 'pending') {
      task.startedAt = undefined;
      task.finishedAt = undefined;
    } else {
      task.finishedAt = Date.now();
    }
    // Math.max defense: claim is the only ++ site and settle the only --
    // site, so the counter cannot drift; the finally-block of processQueue
    // hard-resets it to 0 anyway before the next loop starts.
    this.activeTasks = Math.max(0, this.activeTasks - 1);
    this.notifyChange();
    this.wakeDrain();
  }

  /**
   * Phase 5.3: claim the next chunk of pages.
   *
   * FIFO by file `startedAt` (enqueue order), pages ascending — the exact
   * order `findNextPendingTask` guaranteed. Marks each claimed task
   * 'running' AT THE MOMENT OF CLAIM (honest statuses: claimed pages are
   * inside the active extraction/translation window — not the whole file
   * pre-marked before extraction even starts, as pre-5.3 did).
   *
   * In-flight cap = 2×concurrency — the replacement for the old P1-22
   * watermark (concurrency×10 = 30 pages of parked paragraphs):
   *   • the pipeline stays fed (extraction runs ahead of translation);
   *   • 'running' stays honest (≤ 2×concurrency pages in the window);
   *   • memory is bounded by the ACTIVE window (+ the 5.2 LRU cache).
   *
   * Returns null when nothing is claimable right now (no pending runnable
   * task, or the cap is saturated) — the drain loop then parks.
   */
  private claimNextChunk(concurrency: number): { job: FileJob; tasks: QueueTask[] } | null {
    if (this.disposed) return null;
    const cap = Math.max(2, concurrency * 2);
    if (this.activeTasks >= cap) return null;
    const room = cap - this.activeTasks;

    const jobs = [...this.files.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const job of jobs) {
      const claimed: QueueTask[] = [];
      const pageNums = [...job.tasks.keys()].sort((a, b) => a - b);
      for (const pageNum of pageNums) {
        if (claimed.length >= room) break;
        const task = job.tasks.get(pageNum);
        // 5.1: skip paused tasks — a pending task of a cancelled job is
        // NOT runnable until a fresh enqueue re-assigns its token.
        if (task && task.status === 'pending' && !task.job?.cancelled) {
          task.status = 'running';
          task.startedAt = Date.now();
          task.error = undefined;
          task.finishedAt = undefined;
          this.activeTasks++;
          claimed.push(task);
        }
      }
      if (claimed.length > 0) return { job, tasks: claimed };
    }
    return null;
  }

  /**
   * Phase 5.3 (P1-23): open the file's document session — the queue's ONE
   * `getDocument` per file-pass. Duck-typed fallback for minimal
   * extractors without `openDocSession` (external test doubles): wraps
   * `extractPagesBatch`, degrading P1-23 to chunk granularity (correctness
   * unchanged). The real PdfTextExtractor always has the method.
   */
  private async openExtractorSession(file: TFile): Promise<PdfDocSession> {
    const extractor: any = this.extractor;
    if (typeof extractor.openDocSession === 'function') {
      return extractor.openDocSession(file) as Promise<PdfDocSession>;
    }
    return {
      extractPages: async (pageNums: number[]) => this.extractor.extractPagesBatch(file, pageNums),
      destroy: async () => { /* batch API holds nothing open */ },
    };
  }

  /**
   * The main processing loop (Phase 5.3: the drain loop).
   *
   *   while claimable:  claim chunk → extract (sequential, one open
   *                     document session per file-pass) → launch one
   *                     translation coroutine per page through the
   *                     semaphore (concurrency-bounded)
   *   otherwise:        active tasks in flight? park on the condition
   *                     variable (NO timed polling). Nothing in flight?
   *                     FINISHED — the event that replaces the old
   *                     translationQueueClosed flag + allSettled(workers).
   *
   * Runs ONE at a time (guarded by `this.processing`). Pending tasks of
   * cancelled jobs are paused and skipped (5.1); `dispose()` cancels all
   * jobs, which drains the loop through this same path.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    const loopStartedAt = Date.now();
    const hadQueuedFiles = this.files.size > 0;
    const debug = this.plugin.settings?.debugMode;

    const concurrency = Math.max(1, Math.min(8,
      Math.floor(Number(this.plugin.settings.backgroundTranslationConcurrency) || 3)
    ));
    if (debug) console.debug(`${LOG_PREFIX} scheduler starting (concurrency=${concurrency})`);

    // 5.3: the semaphore bounds CONCURRENT translations to `concurrency`
    // with microtask wake-up — the 50ms worker poll is gone. The chunk cap
    // in claimNextChunk bounds the claimed-not-terminal window at
    // 2×concurrency — the 100ms backpressure poll and the P1-22 watermark
    // (MAX_QUEUE_SIZE) are gone with the queue array itself.
    const semaphore = makeSemaphore(concurrency);

    // P1-4 (Phase 9): every in-flight translation coroutine is tracked so
    // dispose() can drain them before state teardown. runClaimedChunk is
    // the ONLY launcher, so nothing can join `tracked` after the loop
    // exits — one allSettled pass in the finally is complete.
    const tracked = new Set<Promise<void>>();

    // P1-23 (Phase 10, 5.3): ONE document session per file-pass, opened
    // lazily (only when a page actually needs extraction — cached pages
    // never open it) and destroyed on file switch / loop exit.
    let openSession: { path: string; session: PdfDocSession } | null = null;
    const closeSession = async (): Promise<void> => {
      if (!openSession) return;
      const s = openSession;
      openSession = null;
      try { await s.session.destroy(); } catch { /* ignore cleanup errors */ }
    };
    const getSession = async (file: TFile): Promise<PdfDocSession> => {
      if (!openSession || openSession.path !== file.path) {
        await closeSession();
        openSession = { path: file.path, session: await this.openExtractorSession(file) };
      }
      return openSession.session;
    };

    // 5.3: one "extracting N page(s)" Notice per file-pass (the first
    // chunk that opens the session) — single-page refill chunks of the
    // steady state only debug-log (Notice aggregation is 5.4's business).
    let announcedExtractionFor: string | null = null;

    try {
      // ── DRAIN LOOP — condition variable, ZERO timed polling ──────────
      while (!this.disposed) {
        const claim = this.claimNextChunk(concurrency);
        if (claim) {
          await this.runClaimedChunk(claim, {
            getSession,
            shouldAnnounceExtraction: () => {
              if (announcedExtractionFor === claim.job.file.path) return false;
              announcedExtractionFor = claim.job.file.path;
              return true;
            },
          }, semaphore, tracked, concurrency, debug);
          // Yield to the event loop between chunks so Obsidian can repaint
          // (the old loop yielded between files for the same reason).
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          continue;
        }
        // Nothing claimable RIGHT NOW. Nothing in flight either → FINISHED.
        if (this.activeTasks === 0) break;
        // Work in flight: park until a task settles, a new enqueue lands,
        // or a cancel/dispose changes the picture. The check + park region
        // is synchronous, so a wake can never be lost (see drainWaiters).
        await this.waitDrainSignal();
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} processQueue drain loop crashed:`, err);
    } finally {
      // The file-pass' document handle is released FIRST — extraction is
      // done (nothing claimable or loop exited), so nothing needs it.
      await closeSession();

      // P1-4 (Phase 9): drain every in-flight coroutine — terminal
      // transitions (settleTask) happen inside them, so this MUST precede
      // the sweep and the re-trigger below.
      if (tracked.size > 0) await Promise.allSettled([...tracked]);

      // Q-2a fix (2026-09-12) — kept as an INVARIANT SAFETY NET (5.3):
      // with per-task coroutines every claimed task settles in its own
      // settleTask, so after the drain above NOTHING may legitimately be
      // 'running'. A survivor means a bug — warn loudly (console.warn, not
      // just logDebug: this is an invariant violation report) and sweep.
      let swept = 0;
      for (const state of this.files.values()) {
        for (const task of state.tasks.values()) {
          if (task.status === 'running') {
            task.status = 'pending';
            task.startedAt = undefined;
            task.error = undefined;
            task.finishedAt = undefined;
            swept++;
          }
        }
      }
      // Fresh accounting for the next loop (claim/settle kept the counter
      // exact in healthy runs; this covers crash-path stragglers only).
      this.activeTasks = 0;
      if (swept > 0) {
        console.warn(
          `${LOG_PREFIX} invariant violated: swept ${swept} 'running' task(s) back to 'pending' ` +
          `(coroutine should have settled them — please report).`,
        );
        this.notifyChange();
      }

      this.processing = false;

      // 5.1: re-trigger ONLY for runnable tasks — pending tasks of
      // cancelled jobs are paused and must not resurrect the loop.
      // Teardown (`disposed`) cancelled every job, so it is excluded here.
      if (!this.disposed && this.hasRunnablePendingTasks()) {
        // P1-4 (Phase 9): store the re-trigger promise too, so a
        // concurrent dispose() still awaits the chained drain.
        this.processingPromise = this.processQueue().catch(() => { /* swallow */ });
      } else if (hadQueuedFiles && !this.disposed) {
        const { totalDone, totalError } = this.getState();
        const parts: string[] = [];
        if (totalDone > 0) parts.push(`${totalDone} page(s) extracted+translated`);
        if (totalError > 0) parts.push(`${totalError} failed`);
        if (parts.length > 0) {
          new Notice(`Layout queue finished: ${parts.join(', ')}.`, 4000);
        }
        this.plugin.logDebug?.(
          `${LOG_PREFIX} Queue drained in ${Date.now() - loopStartedAt}ms (concurrency=${concurrency}).`
        );
      }
    }
  }

  /**
   * Phase 5.3: process ONE claimed chunk — extract, then launch one
   * translation coroutine per page.
   *
   * Extraction (cache-miss pages only — 5.2 paragraph cache) runs
   * sequentially from the file-pass' open session; translations launch
   * through the semaphore immediately as pages become ready, so the
   * pipeline overlaps extraction with in-flight LLM calls (the old
   * translationQueue's purpose, without its array/polling/watermark).
   *
   * Every claimed task leaves this method either settled (extraction
   * error / paused) or owning a launched coroutine that will settle it —
   * Q-1-class "dropped tasks" are structurally impossible.
   */
  private async runClaimedChunk(
    claim: { job: FileJob; tasks: QueueTask[] },
    hooks: {
      getSession: (file: TFile) => Promise<PdfDocSession>;
      shouldAnnounceExtraction: () => boolean;
    },
    semaphore: Semaphore,
    tracked: Set<Promise<void>>,
    concurrency: number,
    debug: boolean,
  ): Promise<void> {
    const { job, tasks } = claim;
    const shortName = job.file.basename.length > 30
      ? job.file.basename.slice(0, 27) + '...'
      : job.file.basename;

    this.notifyChange();   // the claim marked pages 'running'

    // 5.2 (FileJob paragraph cache): split the chunk — cached pages skip
    // extraction entirely. P1-23 is unaffected: a session opens only when
    // the file has pages to extract, then serves EVERY chunk of that
    // file-pass from the same open document.
    const cachedParagraphs = new Map<number, any[]>();
    const pagesToExtract: number[] = [];
    for (const task of tasks) {
      // 5.1: skip paused (job-cancelled) pages here — they settle to
      // 'pending' in the distribution loop below without extraction cost.
      if (task.job?.cancelled) continue;
      const cached = job.peekParagraphs(task.pageNum);
      if (cached) cachedParagraphs.set(task.pageNum, cached);
      else pagesToExtract.push(task.pageNum);
    }

    let results: Map<number, ExtractPageResult | { error: string; pageNum: number }> = new Map();
    if (pagesToExtract.length > 0) {
      if (debug) {
        console.debug(
          `${LOG_PREFIX} [${shortName}] Batch extracting ${pagesToExtract.length} page(s): ${pagesToExtract.join(',')}`
        );
      }
      if (cachedParagraphs.size > 0) {
        this.plugin.logDebug?.(
          `${LOG_PREFIX} [${shortName}] paragraph cache: serving ${cachedParagraphs.size} page(s) from cache, extracting ${pagesToExtract.length}.`
        );
      }
      if (hooks.shouldAnnounceExtraction()) {
        new Notice(`📖 [${shortName}] extracting ${pagesToExtract.length} page(s)...`, 2000);
      }

      try {
        const session = await hooks.getSession(job.file);
        results = await session.extractPages(pagesToExtract);
      } catch (err: any) {
        // Catastrophic extraction failure (corrupt PDF, encrypted document,
        // session torn down mid-chunk) — mark the pages that WERE sent for
        // extraction as errored and move on to the next chunk/file. 5.2:
        // pages served from the cache were NOT part of the failed batch —
        // they stay runnable through the normal launch path below (their
        // paragraphs are still cached, a retry costs no extraction).
        const rawMsg = err?.message ?? String(err);
        const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
        console.error(
          `${LOG_PREFIX} Batch extraction failed for "${job.file.path}" (${pagesToExtract.length} page(s)): ${rawMsg}`,
          err,
        );
        for (const task of tasks) {
          if (cachedParagraphs.has(task.pageNum)) continue;  // 5.2
          results.set(task.pageNum, { pageNum: task.pageNum, error: isTimeout ? 'timeout' : rawMsg });
        }
      }
    } else if (debug && cachedParagraphs.size > 0) {
      console.debug(
        `${LOG_PREFIX} [${shortName}] paragraph cache: ALL ${cachedParagraphs.size} page(s) served from cache — extraction skipped.`
      );
    }

    // Distribution: launch ONE translation coroutine per claimed page.
    // The semaphore bounds concurrent translations; the terminal
    // transition lives in the coroutine (settleTask), so a task can never
    // be dropped on the floor.
    for (const task of tasks) {
      if (task.job?.cancelled) { this.settleTask(task, 'pending'); continue; }
      // 5.2: cache hit — paragraphs already known (the extraction above
      // only contained cache-MISS pages, so results.get() is not
      // meaningful here).
      const cachedPars = cachedParagraphs.get(task.pageNum);
      let paragraphs: any[];  // NormalizedParagraph[]
      if (cachedPars) {
        paragraphs = cachedPars;
      } else {
        const result = results.get(task.pageNum);
        if (!result) {
          console.error(`${LOG_PREFIX} [p${task.pageNum}] of "${job.file.path}" — no result returned.`);
          this.settleTask(task, 'error', 'no result returned from batch extraction');
          continue;
        }

        if ('error' in result) {
          const rawMsg = result.error;
          const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
          console.error(
            `${LOG_PREFIX} Page ${task.pageNum} of "${job.file.path}" extraction failed: ${rawMsg}`,
          );
          this.settleTask(task, 'error', isTimeout ? 'timeout' : rawMsg);
          continue;
        }

        if (debug) {
          console.debug(`${LOG_PREFIX} [p${task.pageNum}] Extracted ${result.paragraphs.length} paragraph(s).`);
        }
        paragraphs = result.paragraphs;
        // 5.2: fill the file's LRU paragraph cache — the next retranslate /
        // scoped-cancel re-enqueue / failed-page retry of this page skips
        // the pdfjs extraction entirely. This happens BEFORE the cancelled
        // check below on purpose: a job cancelled MID-CHUNK still gets its
        // already-extracted pages cached — the work is done and valid, and
        // the next activation of the paused task becomes extraction-free.
        job.putParagraphs(task.pageNum, paragraphs);
      }

      // 5.1 (scoped): if this task's job was cancelled mid-chunk, return it
      // to 'pending' (paused, not failed) and skip the LLM pipeline. Its
      // paragraphs were cached above, so re-activation costs no extraction.
      if (task.job?.cancelled) {
        this.settleTask(task, 'pending');
        continue;
      }

      // Launch through the semaphore — fire-and-forget, but tracked so
      // dispose() can drain it (P1-4).
      const coroutine = semaphore.run(() =>
        this.translateAndPersist(job, task, paragraphs, shortName, concurrency, debug)
      ).catch(err => {
        // translateAndPersist absorbs its own errors; this is pure defense
        // against an unexpected throw escaping it — settle rather than leak.
        console.error(`${LOG_PREFIX} [p${task.pageNum}] translation coroutine escaped:`, err);
        if (task.status === 'running') {
          this.settleTask(task, 'error', err?.message ?? String(err));
        }
      });
      const trackedPromise = coroutine.finally(() => { tracked.delete(trackedPromise); });
      tracked.add(trackedPromise);
    }
    this.notifyChange();
  }

  /**
   * Phase 5.3: ONE task's pipeline — translate its paragraphs, persist the
   * overlay, settle the task. The old translationWorker's per-job body,
   * promoted to a per-task coroutine owned by a semaphore slot.
   *
   * Q-1 discipline is now STRUCTURAL: `return` ends only THIS task's
   * coroutine — the semaphore slot frees and the next queued page starts.
   * An empty/image-only page can no longer kill a shared worker loop
   * (that was the scan-PDF deadlock: three empty pages, three dead
   * workers, backpressure poll forever).
   *
   * FIX H1: no withFileLock wrapper — storage's writingPromises already
   * serializes the read-modify-write in updatePageOverlaysAndWrite, so
   * translation (API calls) runs in parallel and only the disk writes
   * serialize (per file).
   */
  private async translateAndPersist(
    job: FileJob,
    task: QueueTask,
    paragraphs: any[],  // NormalizedParagraph[]
    shortName: string,
    concurrency: number,
    debug: boolean,
  ): Promise<void> {
    try {
      const translatableCount = paragraphs.filter(
        (p: any) => p.text && p.text.trim().length > 0
      ).length;
      if (translatableCount > 0) {
        // 5.4: aggregated progress instead of the per-page Notice storm
        // (was: `🌐 [file] pN: translating M segment(s)` per page —
        // ~500 popups on a big PDF). One status line per 500 ms with
        // the latest page-level numbers.
        this.reportProgressNotice(job, shortName);
      }

      const translateStart = Date.now();
      // 5.1: the task's owning job — scoped abort inside translation.
      const translatedTexts = await this.translateParagraphs(paragraphs, task.pageNum, debug, task.job);
      const translateMs = Date.now() - translateStart;

      // FIX: respect sequentialDelayMs between pages when concurrency = 1
      // (sequential mode). When concurrency > 1, pages run in parallel and
      // a delay would only slow the pipeline without benefit.
      if (concurrency === 1) {
        const delayMs = this.plugin.settings.sequentialDelayMs ?? 150;
        if (delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }

      // FIX C3 (5.1, scoped): check cancel AFTER translation but BEFORE
      // write. If this task's job was cancelled, don't persist partial
      // overlays — the task returns to 'pending' (NOT error: it did not
      // fail) and is re-activated by the next enqueue.
      if (task.job?.cancelled) {
        this.settleTask(task, 'pending');
        return;
      }

      if (debug) {
        console.debug(
          `${LOG_PREFIX} [p${task.pageNum}] Translated ${translatedTexts.length} segment(s) in ${translateMs}ms.`
        );
      }

      const overlayData = this.buildOverlayData(paragraphs, translatedTexts);

      // FIX C4: if all paragraphs were empty (e.g. image-only page), don't
      // write anything — prevents creating a page bucket with only
      // empty-ot overlays that would trigger parser bugs.
      if (overlayData.length === 0) {
        this.plugin.logDebug?.(
          `${LOG_PREFIX} [p${task.pageNum}] Done: 0 paragraphs (all empty, nothing to write).`
        );
        this.settleTask(task, 'done');
        return;
      }

      await this.plugin.storage.updatePageOverlaysAndWrite(
        job.file,
        { [task.pageNum]: overlayData },
      );

      const totalMs = Date.now() - (task.startedAt ?? Date.now());
      this.plugin.logDebug?.(
        `${LOG_PREFIX} [p${task.pageNum}] Done: ${overlayData.length} paragraph(s) ` +
        `(translate=${translateMs}ms, total=${totalMs}ms).`
      );
      if (fallbackIndices(translatedTexts).size) this.settleTask(task, 'error', 'Original text saved as fallback; retry translation');
      else this.settleTask(task, 'done');
    } catch (err: any) {
      // 5.1: an abort is NOT a failure. raceSignal rejects the moment the
      // owning job is cancelled; the task returns to 'pending'
      // (re-activatable by the next enqueue) instead of 'error'.
      if (isAbortError(err) || task.job?.cancelled) {
        this.settleTask(task, 'pending');
        return;
      }
      const rawMsg = err?.message ?? String(err);
      const isTimeout = TIMEOUT_MATCHER.test(rawMsg);
      console.error(
        `${LOG_PREFIX} Page ${task.pageNum} of "${job.file.path}" translation failed: ${rawMsg}`,
        err,
      );
      this.settleTask(task, 'error', isTimeout ? 'timeout' : rawMsg);
    }
  }

  /**
   * 5.1: True if any task anywhere is 'pending' AND runnable (its owning
   * job is not cancelled). Replaces the raw hasPendingTasks() in the
   * finally re-trigger — paused tasks must not spin the loop forever.
   */
  private hasRunnablePendingTasks(): boolean {
    for (const state of this.files.values()) {
      for (const task of state.tasks.values()) {
        if (task.status === 'pending' && !task.job?.cancelled) return true;
      }
    }
    return false;
  }

  /** Shared page pipeline. Fallback text is saved with its bbox and retry status.
   * Empty paragraphs keep their slots; cancellation never becomes fallback. */
  private async translateParagraphs(
    paragraphs: NormalizedParagraph[], pageNum: number, debug: boolean, job?: JobToken,
  ): Promise<string[]> {
    if (job?.cancelled) throw makeAbortError();
    const indices = paragraphs.map((p, i) => p.text?.trim() ? i : -1).filter(i => i >= 0);
    const result = new Array<string>(paragraphs.length).fill('');
    if (!indices.length) return result;
    const units = indices.map(i => ({text:paragraphs[i].text, originalSpans:[],
      id:`p${pageNum}-${i}`, paragraphId:`p${pageNum}-${i}`}));
    const translated = await this.plugin.processor.executeTranslation(units, {signal:job?.signal});
    if (job?.cancelled) throw makeAbortError();
    indices.forEach((index, i) => { result[index] = translated[i]; });
    return withFallbacks(result, [...fallbackIndices(translated)].map(i => indices[i]));
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

      result.push({
        selector: '',
        textContent: p.text,
        translationStatus: fallbackIndices(translatedTexts).has(i) ? 'fallback' : undefined,
        relativeRect: p.relativeRect,
        page: p.page,
        // If translation is empty but original exists, fall back to original
        // (better than empty — at least the user sees the source text).
        translatedText: translated || p.text,
        fontSize: p.fontSize,
        fontFamily: p.fontFamily,
        originalFontSizes: p.originalFontSizes,
        // Phase 7 (V4 Schema): stable id from page + rect@3dec + textContent.
        // Matches the id produced by overlay.ts extractPositionDataFrom
        // and headless-translate.ts buildOverlays for the same source
        // paragraph — enables merge-by-id-first in updatePageOverlaysAndWrite.
        id: generateOverlayId(p.page, p.relativeRect, p.text || ''),
        // Phase 8 (V4 Schema): engine stamp from current provider/model.
        // Queue path runs through the TranslationEngine (via processing.ts
        // executeTranslation), so current settings match.
        engine: getCurrentEngine(this.plugin),
      });
    }
    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — state helpers
  // ════════════════════════════════════════════════════════════════

  /**
   * 5.2: look up or create the file's `FileJob`. The raw record became a
   * class — the task map, the disk-cache reads (static readCachedPages)
   * and the LRU paragraph cache live on the job object now.
   */
  private getOrCreateFileJob(file: TFile): FileJob {
    let job = this.files.get(file.path);
    if (!job) {
      job = new FileJob(this.plugin, file);
      this.files.set(file.path, job);
    } else {
      // Refresh the TFile reference in case the path is the same but
      // the file object changed (e.g. after a vault reload).
      job.updateFileRef(file);
    }
    return job;
  }

  // ════════════════════════════════════════════════════════════════
  // INTERNAL — subscriber notification
  // ════════════════════════════════════════════════════════════════

  /**
   * 5.4: request a subscriber notification — COALESCED.
   *
   * Leading edge: the first request after a quiet period (≥ window since
   * the last flush) flushes immediately, so a freshly opened modal paints
   * without perceptible delay. Trailing edge: requests arriving inside
   * the window collapse into a single flush scheduled at the window's
   * END — the final state (done/error) is always delivered (≤ window
   * latency), but a burst of transitions renders at most twice per
   * window instead of once per transition.
   *
   * Subscriber callbacks are still invoked synchronously within a flush;
   * errors in one callback do not block the others (each is wrapped in
   * try/catch). The snapshot survives callbacks that (un)subscribe
   * mid-iteration.
   */
  private notifyChange(): void {
    if (this.subscribers.size === 0) return;
    const now = Date.now();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (now - this.notifyLastFlushAt >= PdfLayoutQueue.NOTIFY_COALESCE_MS) {
      this.notifyLastFlushAt = now;
      this.emitChangeNow();
      return;
    }
    // Inside the window: ONE trailing flush at the window boundary. A
    // later request in the SAME window re-arms the timer to the SAME
    // boundary (cleared above) — no request is dropped, no extra flush.
    const wait = PdfLayoutQueue.NOTIFY_COALESCE_MS - (now - this.notifyLastFlushAt);
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notifyLastFlushAt = Date.now();
      this.emitChangeNow();
    }, wait);
  }

  /** 5.4: the actual synchronous flush of every subscriber. */
  private emitChangeNow(): void {
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

  /**
   * 5.4: throttled aggregated progress Notice — one status line per
   * 500 ms (leading immediate + one trailing refresh with the LATEST
   * done/total numbers), replacing the per-page `🌐 pN: translating`
   * storm. Terminal Notices (page fallback, "Layout queue finished")
   * are NOT routed through here and keep their one-shot semantics.
   */
  private reportProgressNotice(job: FileJob, shortName: string): void {
    const snapshot = (): string => {
      const tasks = [...job.tasks.values()];
      const done = tasks.filter(t => t.status === 'done').length;
      const total = job.totalPages || tasks.length || 1;
      return `🌐 [${shortName}] ${done}/${total} pages`;
    };
    const now = Date.now();
    if (now - this.progressNoticeLastAt >= PdfLayoutQueue.PROGRESS_NOTICE_MS) {
      this.progressNoticeLastAt = now;
      new Notice(snapshot(), 1500);
      return;
    }
    if (this.progressNoticeTimer) return;
    this.progressNoticeTimer = setTimeout(() => {
      this.progressNoticeTimer = null;
      this.progressNoticeLastAt = Date.now();
      new Notice(snapshot(), 1500);
    }, PdfLayoutQueue.PROGRESS_NOTICE_MS - (now - this.progressNoticeLastAt));
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
