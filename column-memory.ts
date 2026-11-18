// column-memory.ts
// ─────────────────────────────────────────────────────────────────────────
// LAYOUT-FIX-10 (2026-09-17, Phase 4 / A2): cross-page column-layout memory.
//
// WHY THIS EXISTS (empirics: download/v11-vs-current-layout-bisect.md §6.1):
//
// In a multi-page document the column layout of same-TYPE pages is stable
// (the book body's ink gutter sits at 321±3 / 318 from page to page while
// the slicer cuts at 324/324), while DIFFERENT page types of one document
// have different gutters (TOC ~333/324, abbreviation pages ~294-300, body
// ~324). A per-document memory of confirmed column boundaries and dominant
// right-column start peaks therefore helps exactly the WEAK pages (short,
// jittery, mixed) where the page's own start-peak evidence is thin — and is
// redundant on strong body pages, where the slicer is already correct.
//
// DESIGN (plan §7.2 — "memory is a PRIOR, never a rule"):
//   • Signature {pageBox, columns, median ink left/right, dominant font
//     size} separates TOC / abbreviation / body pages of one document (the
//     median ink-right edge differs by page type), so a page never reads a
//     record of another type — safeguard #2.
//   • Quorum ≥ 2 pages of the same signature activate a record; every
//     stored coordinate is the median over the confirming pages, so one
//     divergent page cannot rewrite the consensus — safeguards #1/#3.
//   • The memory can never VALIDATE a boundary on its own: it only
//     (a) lowers the candidate threshold for a start-peak that sits within
//         ±2pt of a remembered right-column start (the peak still has to
//         pass the full structural validation of isColumnBoundary), and
//     (b) extends the assignment match set with remembered start peaks
//         (same ANCHOR_TOL as the page's own peaks — see the deviation note
//         below), so non-anchored right-column starts on a short page keep
//         their column instead of falling into the drift repair.
//     A page with strong local evidence is untouched by construction: its
//     peaks already clear MIN_PEAK_STARTS and its match set already
//     contains the same anchor values — safeguard #1.
//   • Never a hard filter of units — safeguard #4.
//
// ANCHOR_TOL DEVIATION (documented, empirical): the plan §7.2 proposed
// ±2pt for memory anchors. The F3 sweep (Task 33, scripts/anchor-sweep-
// run.ts) proved that drifted LEFT-column words sit 0.8–1.1pt from the
// right column's anchor («to»@301.1 vs anchor 300.0, «in»@323.2 vs 324.0)
// — the same band a ±2pt memory window would have to accept — while true
// Tm-anchored starts repeat within ≤0.3pt. Memory anchors therefore use
// the SAME 0.75pt tolerance as the page's own peaks (the column-slicer
// merges them into one match set), which preserves the P4 ink-adjacency
// discrimination that closed D1.
//
// STORAGE: module-level LRU, ≤ COLUMN_MEMORY_MAX_FILES documents ×
// ≤ COLUMN_MEMORY_MAX_SIGNATURES signatures each. The store lives in the
// document's life cycle: production entry points set the current file key
// around the pipeline call (setColumnMemoryFile), harnesses and synthetic
// suites never set it — the memory is byte-for-byte inert there. Both
// production paths normalize coordinates to PDF points (FIX-4 + the ink
// channels of FIX-9), so the two paths share one key space per document.
//
// KILL-SWITCH: LayoutSettings.disableColumnMemory (optional, absent from
// defaultLayoutSettings — the settings hash and .translations.md caches
// stay byte-identical) makes lookups return null and observations no-ops.

/** Minimum gap (pt) between an interval's right edge and a remembered peak
 * for the interval to count as supporting that peak. */
const SIGNATURE_PAGE_TOL = 1;
/** Median ink-edge tolerance for signature matching (pt). Page types of one
 * document differ by tens of points (TOC ~335 vs body ~430+ median right);
 * same-type pages repeat within ~1-2pt. */
const SIGNATURE_EDGE_TOL = 4;
/** Dominant font size tolerance for signature matching (pt). */
const SIGNATURE_FS_TOL = 0.75;
/** An observation whose boundaries diverge from the active consensus by
 * more than this (pt, per slot) is a DIFFERENT layout that slipped the
 * signature matching — it neither joins nor rewrites the record. */
const MEMORY_DIVERGENCE_TOL = 8;

/** LRU caps (plan §7.2: "≤3 файла × ≤4 сигнатуры"). */
const COLUMN_MEMORY_MAX_FILES = 3;
const COLUMN_MEMORY_MAX_SIGNATURES = 4;

/** Kill-switch (mirrored from LayoutSettings by buildParagraphs). */
let _enabled = true;

/** Current document key (set by production entry points; null = inert). */
let _fileKey: string | null = null;

export interface ColumnMemorySignature {
  pageW: number;
  pageH: number;
  /** Median ink left/right edge of the page's feed rects (pt). */
  medL: number;
  medR: number;
  /** Dominant (median) font size (pt). */
  medFs: number;
  /** Column count (0 = unknown, pre-slice partial signature). */
  cols: number;
}

export interface ColumnMemorySnapshot {
  /** Confirmed column boundaries (median over ≥2 pages, ascending). */
  boundaries: number[];
  /** Dominant right-column start peaks (merged over ≥half the pages). */
  rightPeaks: number[];
  /** Number of confirming pages (≥2 when active). */
  pages: number;
}

interface Observation {
  boundaries: number[];
  rightPeaks: number[];
}

interface MemoryRecord {
  observations: Observation[];
}

const store = new Map<string, Map<string, MemoryRecord>>();
const fileLRU: string[] = [];

/** Quantize a signature into a stable map key (3pt edges, 0.5pt font). */
function sigKey(sig: ColumnMemorySignature): string {
  return [
    Math.round(sig.pageW), Math.round(sig.pageH),
    Math.round(sig.medL / 3), Math.round(sig.medR / 3),
    Math.round(sig.medFs * 2) / 2,
    sig.cols,
  ].join('|');
}

/** Numeric tolerance matching between a live signature and a stored key. */
function sigMatches(key: string, sig: ColumnMemorySignature): boolean {
  const parts = key.split('|').map(Number);
  if (parts.length !== 6 || parts.some(n => !Number.isFinite(n))) return false;
  const [w, h, ml, mr, fs, cols] = parts;
  if (Math.abs(w - sig.pageW) > SIGNATURE_PAGE_TOL) return false;
  if (Math.abs(h - sig.pageH) > SIGNATURE_PAGE_TOL) return false;
  if (Math.abs(ml * 3 - sig.medL) > SIGNATURE_EDGE_TOL + 1.5) return false;
  if (Math.abs(mr * 3 - sig.medR) > SIGNATURE_EDGE_TOL + 1.5) return false;
  if (Math.abs(fs - sig.medFs) > SIGNATURE_FS_TOL) return false;
  // cols: exact (0 = wildcard from the pre-slice partial lookup).
  if (sig.cols !== 0 && cols !== sig.cols) return false;
  return true;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Snapshot of a record: per-slot boundary medians over the observations
 * that agree with the modal boundary count; right peaks clustered to
 * values present in at least half of the observations. Returns null while
 * the quorum (< 2 agreeing pages) is not met. */
function snapshotOf(rec: MemoryRecord): ColumnMemorySnapshot | null {
  if (rec.observations.length < 2) return null;
  // Modal boundary count (safeguard #3: a divergent page with another
  // count does not rewrite the consensus).
  const counts = new Map<number, number>();
  for (const o of rec.observations) counts.set(o.boundaries.length, (counts.get(o.boundaries.length) || 0) + 1);
  let modalCount = 0, modalVotes = -1;
  for (const [c, v] of counts) if (v > modalVotes || (v === modalVotes && c > modalCount)) { modalCount = c; modalVotes = v; }
  const agreeing = rec.observations.filter(o => o.boundaries.length === modalCount);
  if (agreeing.length < 2) return null;
  const boundaries: number[] = [];
  for (let i = 0; i < modalCount; i++) {
    // LAYOUT-FIX-13: FLOOR, not round — a boundary rounded UP (DOM subpixel
    // 323.3086… → toFixed(2) → 323.31) sits a hair RIGHT of the very column
    // starts it represents: the slicer's region check (r.left >= boundary)
    // then sees zero items right of the cut and DROPS it, and the assignment
    // sends the anchored starts into the LEFT group. Flooring keeps the
    // remembered boundary at-or-below every observed cut; the ≤0.01pt
    // leftward bias is far below every tolerance in the pipeline.
    boundaries.push(Math.floor(median(agreeing.map(o => o.boundaries[i])) * 100) / 100);
  }
  // Right peaks: cluster all observed peak values within 1.5pt of the
  // running cluster tail; keep clusters supported by ≥ half of the
  // agreeing pages (page-specific indent peaks drop out, the column's
  // flush start survives). Cluster value = median of its members.
  const all: number[] = [];
  for (const o of agreeing) all.push(...o.rightPeaks);
  all.sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of all) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(v - c[c.length - 1]) <= 1.5) c.push(v);
    else clusters.push([v]);
  }
  const rightPeaks: number[] = [];
  const minPages = Math.ceil(agreeing.length / 2);
  for (const c of clusters) {
    const value = median(c);
    let supportingPages = 0;
    for (const o of agreeing) {
      if (o.rightPeaks.some(p => Math.abs(p - value) <= 1.5)) supportingPages++;
    }
    if (supportingPages >= minPages) rightPeaks.push(+value.toFixed(2));
  }
  rightPeaks.sort((a, b) => a - b);
  return { boundaries, rightPeaks, pages: agreeing.length };
}

function touchFileLRU(fileKey: string): void {
  const i = fileLRU.indexOf(fileKey);
  if (i >= 0) fileLRU.splice(i, 1);
  fileLRU.push(fileKey);
  while (fileLRU.length > COLUMN_MEMORY_MAX_FILES) {
    const evicted = fileLRU.shift();
    if (evicted !== undefined) store.delete(evicted);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Set the current document key (production entry points wrap their
 *  buildParagraphs call with this). `null` disables the memory — the
 *  default state for every harness and synthetic feed. The entry point
 *  itself checks the kill-switch, so a disabled document never opens a
 *  context. */
export function setColumnMemoryFile(fileKey: string | null): void {
  _fileKey = fileKey;
}

/** Kill-switch mirror (buildParagraphs sets it from ContourSettings for
 *  the duration of one pipeline call, restoring `true` in its finally). */
export function setColumnMemoryEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/** Active snapshot for a live signature, or null (no file context, killed,
 *  no matching record, or quorum not met). `cols: 0` = pre-slice partial
 *  signature (matches any column count). */
export function lookupColumnMemory(sig: ColumnMemorySignature): ColumnMemorySnapshot | null {
  if (!_enabled || !_fileKey) return null;
  const fileStore = store.get(_fileKey);
  if (!fileStore) return null;
  for (const [key, rec] of fileStore) {
    if (!sigMatches(key, sig)) continue;
    const snap = snapshotOf(rec);
    if (snap && (sig.cols === 0 || snap.boundaries.length === sig.cols - 1)) return snap;
  }
  return null;
}

/**
 * LAYOUT-FIX-13 (2026-09-18, A2-fallback): the LOOSE lookup for the memory
 * fallback path. The strict signature above is content-sensitive by design
 * (median ink edges separate TOC / abbreviation / body pages), but that is
 * exactly why it never fires where it is needed most: a furniture page
 * (book p61: full-width figure caption + header + short asymmetric column
 * bodies) has a DIFFERENT medL/medR/medFs than the plain body pages whose
 * boundary it needs to borrow — the strict lookup returns null and the
 * page falls to the single-map pipeline that fuses its columns.
 *
 * The loose lookup matches on the page BOX only (pageW/pageH ±1pt) and
 * returns the record with the most confirming observations. It is safe
 * precisely BECAUSE the caller (column-slicer.ts step 4.2) corroborates
 * every remembered boundary against the page's own ink — own start
 * evidence (≥3 Tm-anchored starts within ±2pt), the bridge symptom
 * (left rows physically reaching the cut beside right-side text), and the
 * reduced structural validation (isColumnBoundary mode 'fallback'). A
 * TOC/1-column/abbrev page of the same box fails the start evidence; a
 * cleanly separated 2-column page fails the bridge symptom; garbage
 * boundaries fail the structural gates. The loose match only decides
 * WHICH candidate numbers are worth corroborating.
 */
export function lookupColumnMemoryLoose(pageW: number, pageH: number): ColumnMemorySnapshot | null {
  if (!_enabled || !_fileKey) return null;
  const fileStore = store.get(_fileKey);
  if (!fileStore) return null;
  // LAYOUT-FIX-13 (DOM subpixel): the DOM path derives pageW/pageH from
  // getBoundingClientRect().width / normScale — a hair over 612.0 becomes
  // ceil(612.0000001 / cellSize 4) = 154 cells → pageW 616, while other
  // pages of the same document store 612 (and the queue path, whose
  // viewport is exact, always stores 612). A ±1pt tolerance would split
  // one document's records across 612/616 keys and the fallback would
  // never fire. The grid quantization can inflate a page edge by just
  // under one cell (4pt); 5pt absorbs it, while genuinely different page
  // sizes differ by tens of points.
  const LOOSE_PAGE_TOL = 5;
  let best: ColumnMemorySnapshot | null = null;
  for (const [key, rec] of fileStore) {
    const parts = key.split('|').map(Number);
    if (parts.length !== 6 || parts.some(n => !Number.isFinite(n))) continue;
    const [w, h] = parts;
    if (Math.abs(w - pageW) > LOOSE_PAGE_TOL) continue;
    if (Math.abs(h - pageH) > LOOSE_PAGE_TOL) continue;
    const snap = snapshotOf(rec);
    if (snap && (!best || snap.pages > best.pages)) best = snap;
  }
  return best;
}

/** Record one page's confirmed layout (called by the slicer after the
 *  partition sanity check). No-op without a file context or when killed.
 *  A divergent observation — an active record exists and any boundary
 *  slot differs from the consensus median by > MEMORY_DIVERGENCE_TOL — is
 *  a different layout that slipped the signature matching: it neither
 *  joins nor rewrites the consensus (plan §7.2 safeguard #3). */
export function observeColumnMemory(
  sig: ColumnMemorySignature,
  boundaries: number[],
  rightPeaks: number[],
): void {
  if (!_enabled || !_fileKey) return;
  let fileStore = store.get(_fileKey);
  if (!fileStore) { fileStore = new Map(); store.set(_fileKey, fileStore); }
  touchFileLRU(_fileKey);
  // Find or create the record by tolerance matching (the live signature
  // floats; the stored key is quantized).
  let target: MemoryRecord | undefined;
  let targetKey: string | undefined;
  for (const [key, rec] of fileStore) {
    if (sigMatches(key, sig)) { target = rec; targetKey = key; break; }
  }
  if (!target) {
    // LRU within the file: drop the least-recently-touched signature.
    if (fileStore.size >= COLUMN_MEMORY_MAX_SIGNATURES) {
      const first = fileStore.keys().next().value;
      if (first !== undefined) fileStore.delete(first);
    }
    target = { observations: [] };
    targetKey = sigKey(sig);
    fileStore.set(targetKey, target);
  } else if (targetKey !== undefined) {
    // Re-insert to refresh LRU order (Map preserves insertion order).
    fileStore.delete(targetKey);
    fileStore.set(targetKey, target);
    // Divergence guard: the incoming page must agree with an ACTIVE
    // consensus before it may join it.
    const snap = snapshotOf(target);
    if (snap && snap.boundaries.length === boundaries.length) {
      const divergent = snap.boundaries.some((b, i) => Math.abs(b - boundaries[i]) > MEMORY_DIVERGENCE_TOL);
      if (divergent) return;
    }
  }
  target.observations.push({ boundaries, rightPeaks });
  // Bounded growth: keep the newest 8 observations per signature (the
  // median consensus only needs a stable majority).
  if (target.observations.length > 8) target.observations.shift();
}

/** Drop everything (or one document's) — test hook. */
export function resetColumnMemory(fileKey?: string): void {
  if (fileKey === undefined) { store.clear(); fileLRU.length = 0; }
  else { store.delete(fileKey); const i = fileLRU.indexOf(fileKey); if (i >= 0) fileLRU.splice(i, 1); }
}

/** Internal hooks for tests/debugging (not part of the public contract). */
export const __columnMemoryInternals = {
  SIGNATURE_PAGE_TOL,
  SIGNATURE_EDGE_TOL,
  SIGNATURE_FS_TOL,
  MEMORY_DIVERGENCE_TOL,
  COLUMN_MEMORY_MAX_FILES,
  COLUMN_MEMORY_MAX_SIGNATURES,
  snapshotOf,
  sigKey,
  sigMatches,
  storeSize: (): number => {
    let n = 0;
    for (const fs of store.values()) n += fs.size;
    return n;
  },
  currentFile: (): string | null => _fileKey,
};
