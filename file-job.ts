import { regionRevision } from './region-layout';
// file-job.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 5.2 (2026-09-13): per-file state object for PdfLayoutQueue.
//
// The queue previously kept a raw `QueueFileState` record (plain object with
// a `tasks` Map) per file and operated on it from a dozen scattered loops.
// This class promotes that record to an object with a single point of truth
// per file:
//
//   • `isBusy()`        — the ONE occupancy signal the outside world (W-1
//                         guard in PdfWatcher) reads, replacing the old
//                         "walk the global Map, filter by path" helper;
//   • disk-cache access (`readCachedPages` / `refreshCache`) — the storage
//                         reads that decide which pages still need work;
//   • paragraph cache   — an LRU-capped in-memory map of extracted
//                         NormalizedParagraph[] per page, keyed by the
//                         extraction-settings hash. Re-translating a page
//                         (retranslate after a provider switch, re-enqueue
//                         after a scoped cancel, retry after a failed page)
//                         no longer re-runs pdfjs extraction for pages whose
//                         paragraphs are already known — only the LLM +
//                         write stages run.
//   • `dispose()`       — cleanly stops the file's jobs (5.1 tokens) and
//                         frees the caches when the file leaves the queue.
//
// Design constraints honored here:
//
//   1. STRUCTURAL compatibility: FileJob `implements QueueFileState`, so
//      `getState()` snapshots and watcher-modal rendering see the exact same
//      shape as before (`file`, `totalPages`, `tasks`, `startedAt`). No UI
//      or consumer type changes.
//
//   2. NO cross-call disk-cache staleness. `readCachedPages` reads
//      `.translations.md` on EVERY call — exactly like the old
//      `queue.getCachedPages()` did. The only memoization is in-flight
//      de-duplication (concurrent callers await the same promise). A
//      time-based cache was deliberately rejected: a user deleting a page
//      overlay and immediately re-running "translate PDF" must never be
//      told "already cached" from a stale memory copy.
//
//   3. Paragraph cache validity is keyed by `computeLayoutSettingsHash`
//      (overlay-id.ts, same primitive the V4 disk schema uses for P2-3
//      preset-change detection). Extraction output depends on the layout
//      settings, NOT on the translation provider/model or prompts — those
//      only change `translatedText`, never the extracted paragraphs. A
//      layout-preset change invalidates the whole cache in O(1) (hash
//      comparison) before any page is served.
//
//   4. Memory ceiling. A 500-page PDF at ~50 paragraphs × ~2KB would be
//      ~50MB if cached blindly. The cache is LRU per file with a limit of
//      `paragraphCachePages` (default 100; 0 disables). Eviction is plain
//      LRU — safe because translation workers hold cached paragraphs BY
//      REFERENCE, so evicting an in-flight page cannot take anything away
//      from the pipeline (see putParagraphs for the full rationale).
// ─────────────────────────────────────────────────────────────────────────

import type { TFile } from 'obsidian';
import type { QueueTask, QueueFileState } from './pdf-layout-queue';
import type { NormalizedParagraph } from './pdf-text-extractor';
import { computeLayoutSettingsHash } from './overlay-id';

/**
 * Minimal structural view of the plugin that FileJob needs. Kept loose on
 * purpose (same pattern as `getCurrentEngine` in overlay-id.ts) so the class
 * is unit-testable with a plain mock object and does not import main.ts
 * (which would create a module cycle: main → queue → file-job → main).
 */
export interface FileJobHost {
  storage: {
    readSavedOverlayForFile(file: TFile): Promise<any>;
  };
  app: {
    metadataCache: { getFileCache(file: TFile): any };
  };
  settings: {
    /**
     * Phase 5.2: max number of pages of cached paragraphs per file (LRU).
     * Default 100 when undefined; 0 disables the paragraph cache entirely.
     */
    paragraphCachePages?: number;
  };
  /** Current layout settings — hashed to key the paragraph cache. */
  layoutSettings?: unknown;
  logDebug?: (msg: string) => void;
}

/**
 * Per-file aggregation of tasks + caches. One entry per PDF that has been
 * (or is being) processed. `totalPages` is 0 when only single pages have
 * been enqueued (page-count not queried).
 *
 * Structurally identical to the old `QueueFileState` interface —
 * `getState()` consumers (watcher-modal) are unaffected.
 */
export class FileJob implements QueueFileState {
  file: TFile;
  totalPages = 0;
  readonly tasks = new Map<number, QueueTask>();
  readonly startedAt: number;

  private readonly host: FileJobHost;

  // ── Disk-cache (pages already persisted in .translations.md) ────────
  /** Result of the last completed `refreshCache()` (diagnostic/testing). */
  private cachedPages: Set<number> | null = null;
  /** In-flight `refreshCache()` promise — de-duplicates concurrent calls. */
  private refreshInFlight: Promise<Set<number>> | null = null;

  // ── Paragraph cache (Phase 5.2) ──────────────────────────────────────
  /** pageNum → extracted paragraphs. Map insertion order = LRU order. */
  private readonly paragraphCache = new Map<number, NormalizedParagraph[]>();
  /** Hash of layout settings captured when the cache was filled. */
  private extractionHash: string | null = null;

  constructor(host: FileJobHost, file: TFile, startedAt: number = Date.now()) {
    this.host = host;
    this.file = file;
    this.startedAt = startedAt;
  }

  /**
   * Refresh the TFile reference in case the path is the same but the file
   * object changed (e.g. after a vault reload). Mirrors the old
   * `getOrCreateFileState()` else-branch.
   */
  updateFileRef(file: TFile): void {
    this.file = file;
  }

  // ════════════════════════════════════════════════════════════════
  // Occupancy (W-1 guard's single point of truth)
  // ════════════════════════════════════════════════════════════════

  /**
   * Phase 5.2: true when this file has pending or running tasks in the
   * queue — the ONE occupancy signal for the outside world.
   *
   * NOTE (W-1 semantics preserved): a file whose loop is dead is not
   * actually busy. The queue-liveness part of the old check
   * (`queue.isRunning()`) stays with the CALLER (PdfWatcher), because a
   * FileJob does not know whether the processing loop is alive.
   */
  isBusy(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') return true;
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════════
  // Disk cache — which pages are already persisted?
  // ════════════════════════════════════════════════════════════════

  /**
   * Read the set of page numbers already cached in `.translations.md` for
   * the given PDF. Static so `enqueuePage`/`enqueuePdf` can check BEFORE a
   * FileJob exists (the old code did not create state on the cached-skip
   * path either, and an empty job in `getState()` would be visible junk in
   * the watcher modal).
   *
   * Behavior is byte-for-byte the old `queue.getCachedPages()`:
   *   • originals-only files → empty set (always re-translate);
   *   • `layoutSettingsHash` mismatch (V4 frontmatter) → empty set;
   *   • storage read failure → empty set (fail open — will re-extract).
   */
  static async readCachedPages(host: FileJobHost, file: TFile): Promise<Set<number>> {
    const cached = new Set<number>();
    try {
      const saved = await host.storage.readSavedOverlayForFile(file);
      if (!saved) return cached;

      // FIX (originals-only): files marked in frontmatter contain original
      // text as placeholder translations — never "cached", re-translate all.
      const mdFile: TFile | null | undefined = saved.mdFile;
      if (mdFile && FileJob.isOriginalsOnly(host, mdFile)) {
        host.logDebug?.(
          `[FileJob] readCachedPages: "${file.path}" is originals-only — will re-translate all pages.`
        );
        return cached;
      }

      // Phase 8 (V4 / P2-3): layoutSettingsHash mismatch → nothing cached.
      // Missing hash (V3 file) = treated as match (migration policy).
      if (saved.overlay.layoutSettingsHash !== undefined) {
        const currentHash = computeLayoutSettingsHash(host.layoutSettings);
        if (saved.overlay.layoutSettingsHash !== currentHash) {
          host.logDebug?.(
            `[FileJob] readCachedPages: "${file.path}" layoutSettingsHash mismatch ` +
            `(file=${saved.overlay.layoutSettingsHash.slice(0, 8)}… current=${currentHash.slice(0, 8)}…) — re-translating all pages.`
          );
          return cached;
        }
      }

      for (const key of Object.keys(saved.overlay.pageOverlays)) {
        const items = saved.overlay.pageOverlays[key];
        if (Array.isArray(items) && items.length > 0 && !items.some(item => item.translationStatus === 'fallback' || (item.layoutRegionRevision || '') !== regionRevision(host.layoutSettings || {}, file.path, Number(key)))) {
          const n = Number(key);
          if (Number.isFinite(n) && n >= 1) cached.add(n);
        }
      }
    } catch (err: any) {
      console.warn(`[FileJob] readCachedPages: storage read failed for "${file.path}":`, err);
    }
    return cached;
  }

  /** See `readCachedPages` — frontmatter originals-only check. */
  private static isOriginalsOnly(host: FileJobHost, mdFile: TFile): boolean {
    try {
      const cache = host.app.metadataCache.getFileCache(mdFile);
      const fm = cache?.frontmatter;
      if (!fm) return false;
      return fm['originals-only'] === true || fm['originalsOnly'] === true;
    } catch {
      return false;
    }
  }

  /**
   * Instance flavor of `readCachedPages`: read the disk cache NOW, remember
   * the result, return it. Concurrent calls share one storage read
   * (in-flight de-duplication). Every completed call re-reads the file —
   * NO time-based memoization, by design (see header note 2).
   */
  async refreshCache(): Promise<Set<number>> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = FileJob.readCachedPages(this.host, this.file)
      .then(pages => {
        this.cachedPages = pages;
        return pages;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    this.refreshInFlight = p;
    return p;
  }

  /** Last `refreshCache()` result (diagnostics/testing). Null = never read. */
  get diskCachePages(): Set<number> | null {
    return this.cachedPages;
  }

  // ════════════════════════════════════════════════════════════════
  // Paragraph cache (Phase 5.2)
  // ════════════════════════════════════════════════════════════════

  /** Current extraction-settings hash (layout preset). */
  private currentExtractionHash(): string {
    return computeLayoutSettingsHash(this.host.layoutSettings) + JSON.stringify((this.host.layoutSettings as any)?.regionLayouts?.[this.file.path] || []);
  }

  /**
   * Cached paragraphs for a page, or null when not cached / invalid.
   *
   * Hash guard first: if the layout settings changed since the cache was
   * filled, the WHOLE cache is dropped (the paragraphs would be stale for
   * the new preset — same invalidation the V4 disk schema applies).
   * A hit also touches the LRU order (delete + re-insert = most-recent).
   *
   * Note: an EMPTY page (`paragraphs: []`) is a valid cache entry —
   * extraction legitimately returns no paragraphs for image-only pages,
   * and that answer is exactly as stable as any other.
   */
  peekParagraphs(pageNum: number): NormalizedParagraph[] | null {
    const current = this.currentExtractionHash();
    if (this.extractionHash !== current) {
      this.paragraphCache.clear();
      this.extractionHash = current;
      return null;
    }
    const paragraphs = this.paragraphCache.get(pageNum);
    if (paragraphs === undefined) return null;
    // LRU touch
    this.paragraphCache.delete(pageNum);
    this.paragraphCache.set(pageNum, paragraphs);
    return paragraphs;
  }

  /**
   * Store extraction results for a page. Enforces the LRU limit.
   *
   * Eviction is a PLAIN least-recently-used policy — deliberately NOT
   * "protect running tasks": the queue pre-marks every page of a batch as
   * `running` (before the batch extraction starts), so a running-guard
   * would protect the WHOLE batch and the limit would never engage while
   * a file is being processed. That is safe because cached paragraphs are
   * shared BY REFERENCE with the translation pipeline: once a page's
   * paragraphs are pushed to a translation worker, that worker holds the
   * array directly and eviction from this cache cannot take it away.
   * Evicting an in-flight page only means a hypothetical re-enqueue in
   * that narrow window would re-extract that page — a lost optimization,
   * never a correctness issue (the cache is an accelerator, not a source
   * of record: .translations.md on disk is).
   *
   * `paragraphCachePages: 0` disables the cache (clears it).
   */
  putParagraphs(pageNum: number, paragraphs: NormalizedParagraph[]): void {
    const limit = this.host.settings?.paragraphCachePages ?? 100;
    if (limit <= 0) {
      if (this.paragraphCache.size > 0) this.paragraphCache.clear();
      return;
    }
    const current = this.currentExtractionHash();
    if (this.extractionHash !== current) {
      this.paragraphCache.clear();
      this.extractionHash = current;
    }
    this.paragraphCache.delete(pageNum);
    this.paragraphCache.set(pageNum, paragraphs);

    // Plain LRU trim: Map insertion order = recency; evict from the front.
    while (this.paragraphCache.size > limit) {
      const oldest = this.paragraphCache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.paragraphCache.delete(oldest);
    }
  }

  /** Number of pages currently held in the paragraph cache (testing/logs). */
  get paragraphCacheSize(): number {
    return this.paragraphCache.size;
  }

  /** Drop the paragraph cache (e.g. after a hard invalidation). */
  clearParagraphCache(): void {
    this.paragraphCache.clear();
    this.extractionHash = null;
  }

  // ════════════════════════════════════════════════════════════════
  // Teardown
  // ════════════════════════════════════════════════════════════════

  /**
   * Phase 5.2: stop this file's jobs and free its caches. Called by
   * `queue.clearFile()` (PDF deleted from vault) and by `queue.dispose()`
   * after the in-flight loop has drained.
   *
   * Cancelling the pending/running tasks' tokens (5.1) keeps a still-
   * referenced token from masquerading as a live job after the bookkeeping
   * is gone — the exact behavior `clearFile` grew in Phase 5.1, now owned
   * by the file's object.
   */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') {
        task.job?.cancel(`file disposed: ${this.file.path}`);
      }
    }
    this.tasks.clear();
    this.paragraphCache.clear();
    this.cachedPages = null;
    this.refreshInFlight = null;
  }
}
