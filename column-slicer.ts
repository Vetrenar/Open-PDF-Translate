// column-slicer.ts
// ─────────────────────────────────────────────────────────────────────────
// Column detection + input slicing for the contour-island pipeline.
//
// WHY THIS EXISTS (calibrated on try.pdf, 2026-09-14):
//
// pdf.js `getTextContent()` reports item `width` as the sum of NOMINAL glyph
// advances. For justified text written by InDesign with per-word TJ kerning
// (e.g. `[(word) -254.4 (word) ...] TJ` + per-line `Tw`), pdf.js drops the
// negative space adjustments: measured inter-word gaps came out ~9.1pt where
// the true rendered gap is ~5.6pt (MinionPro subset in try.pdf). The error
// ACCUMULATES along a line (+3.5pt per word, up to +25pt on a 10-word line),
// so the declared right edge of a left-column line can overshoot the real
// ink end by 2-16pt — straight through a 10pt inter-column gutter and into
// the neighbouring column.
//
// Consequence without slicing: the occupancy grid's row runs bridge the
// gutter, the island BFS fuses both columns into one island, `groupIntoLines`
// mixes spans of both columns on the same baseline, and the final paragraphs
// interleave left/right text ("recognized as one column").
//
// THE SIGNAL — item-start peaks:
//   Every visual line is written as one Tj/TJ sequence anchored by a Tm/TD
//   text matrix. The FIRST item of a line therefore has an EXACT start
//   position, while the start of every following item drifts right by the
//   accumulated space-width error. On a 2-column page the line starts pile
//   up on the exact same x per column: on try.pdf p.2 the left column has
//   56 items starting within 1.5pt of x=48 and the right column 58 items
//   within 1.5pt of x=300 (a "start-dominated peak": far more items START
//   there than END there). Mid-line drifts are scattered (2-4 occurrences
//   per value). Peaks are computed per 1.5pt bin, filtered by count and by
//   the starts/ends ratio, then validated structurally (see below).
//
// THE FIX — partition, don't correct:
//   Once a column boundary is validated, the input rects are PARTITIONED
//   into per-column groups and Steps 5-8 run per group on separate occupancy
//   maps. A group's grid physically cannot bridge into another column
//   because the other column's rects are not in it — the pdfjs width
//   overstatement becomes harmless. Rect coordinates are NEVER modified, so
//   overlays and DOM-path span matching are unaffected. Step 9
//   (applyColumnOrder) still runs ONCE, globally, over the concatenated
//   result — headers, footers and cross-column elements keep their
//   page-level classification.
//
// VALIDATION (false-positive guards, all must pass for a boundary):
//   1. mass: both sides have enough rects;
//   2. co-occurrence within a ±COOCCUR_WINDOW y-band: the two sides' text
//      sits side-by-side — the structural signature of columns. Corpus
//      (8 vet-oncology papers) showed the two columns' baseline grids can
//      be PHASE-SHIFTED by 3-6pt (InDesign text frames with independent
//      first-baselines), so exact-row sharing undercounts: p2 of the
//      "Prognostic Significance" paper has aligned grids above y≈230 and a
//      3pt shift below; "Clinicopathological Features" p2/p7 carry a 6.1pt
//      shift for most of the body. Window matching (±7pt ≈ half a body
//      leading) recovers those pages without loosening anything else;
//   3. column-wide rows: count of wide rows (extent ≥ 18% of page width)
//      on both sides (excludes table cells, figure labels, margin notes);
//   4. mutual vertical overlap of the two sides' y-spans (a short sidebar
//      fully inside the body's span still fails the body-side fraction);
//   5. clean-text-column: at least one side's wide rows are mostly ONE
//      contiguous x-run (no internal gap > TABLE_GAP). A full-width TABLE
//      sliced anywhere has fragmented rows on BOTH sides (cell clusters
//      39-56pt apart) and is rejected → legacy pipeline (measured on
//      "Feline Upper Respiratory" p7/p8 and "Prognostic Value" p8: Table
//      pages). A table-left + text-right page keeps its boundary: the
//      text side is clean even though the table side is fragmented;
//   6. region check (in sliceRectsByColumns): every region BETWEEN kept
//      boundaries must itself have enough wide rows. A cut placed inside
//      a table next to a text column ("Prognostic Significance" p5: cuts
//      201.6+307.5, where [201.6..307.5] holds only 83pt-wide table cells)
//      is dropped and the table stays whole.
//
// SAFETY: when no boundary validates, the slicer returns a single group
// (all rects) and the pipeline behaves EXACTLY as before this module
// existed (single occupancy map built by the caller, single Steps 5-8 pass).
//
// Known limitation (documented, empirical): an item whose declared start
// lands more than ~2pt past a boundary without matching a start-peak and
// not chained after an already-assigned right item (extreme accumulated
// drift of a very long left-column line) can be assigned to the right group;
// it then joins the right column's paragraph flow. Not observed on the
// calibration corpus (max drifted start = 273.7 vs boundary 300); text is
// never lost, only paragraph membership of one word changes.

import { InputRect } from './OccupancyMap';
import {
  lookupColumnMemory,
  observeColumnMemory,
  lookupColumnMemoryLoose,
  ColumnMemorySnapshot,
} from './column-memory';

export interface ColumnSlice {
  /** True when ≥1 validated column boundary was found and rects were partitioned. */
  detected: boolean;
  /** Partition of the input rects, ordered left column group → right. When !detected: [allRects]. */
  groups: InputRect[][];
  /** Validated cut positions (px, viewport space, ascending). Empty when !detected. */
  boundaries: number[];
  /** LAYOUT-FIX-13: true when the cuts came from the cross-page memory
   * fallback (the page's own candidates all failed validation; each cut was
   * corroborated by the page's own starts, bridge rows and reduced structural
   * validation). Diagnostics only — downstream behaviour is identical. */
  memoryFallback?: boolean;
  /** LAYOUT-FIX-15: true when the cuts came from the FORCED detection pass
   * (preset 'two-columns': the page's own candidates all failed the full
   * validation; each candidate re-validated under the reduced 'fallback'
   * gate set — see STEP 4.3 in sliceRectsByColumns). Diagnostics only —
   * downstream behaviour is identical to an own-page detection. */
  forcedDetection?: boolean;
}

// ── Tunables (calibrated on try.pdf + the 8 vet-oncology papers) ──────────
/** Fewer rects than this → not enough signal, never slice. */
const MIN_RECTS = 8;
/** Visual row (baseline) grouping tolerance for rect.bottom. */
const ROW_TOL = 2.0;
/** Start-peak bin width. */
const PEAK_TOL = 1.5;
/** Sub-clustering width inside a peak bin (true Tm-anchored starts repeat
 * the exact same float; drifted mid-line starts scatter). */
const PEAK_SUBTOL = 0.5;
/** Anchor match tolerance for the match set (drift-repair). True line
 * starts sit within float jitter (≤0.3pt) of the dominant value; drifted
 * left-column words land ≥ ~1pt away (try.pdf: "to" at 301.1 vs anchor
 * 300.0, "in" at 323.2 vs anchor 324.0).
 *
 * LAYOUT-FIX-7 (2026-09-17) — F3 sweep verdict: this tolerance CANNOT be
 * widened to rescue non-anchored right-column starts. Calibrated sweep
 * {0.75, 1.0, 1.25, 1.5} on the queue path (scripts/anchor-sweep-run.ts):
 * the D1 case (try3:p3 "Signaling via RAS…" start 333.0 vs boundary/peak
 * 324) keeps cross=2 at EVERY tolerance — the start is ~9pt from the peak
 * (a first-line indent class, not float jitter), while the drifted words
 * "to"/"in" sit at 0.8–1.1pt — the same distance band a wider tolerance
 * would need to accept. The two case classes are not separable by a
 * threshold; D1 closure is deferred to the ink-based assignment redesign
 * (P4/LAYOUT-FIX-9) and cross-page memory anchors (A2/LAYOUT-FIX-10).
 * Keep 0.75. */
const ANCHOR_TOL = 0.75;
/** Minimum starts for a peak to be considered at all. */
const MIN_PEAK_STARTS = 6;
/** Peak must be start-dominated: items ending within ±2pt ≤ 50% of items starting.
 * (Justified-line overshoot from the LEFT column can land items that END
 * within ±2pt of a true column start — e.g. try.pdf p.4: S=16, E=6 — so the
 * classic "nobody ends here" test is too strict. S ≥ 2×E keeps pure
 * end-peaks (the left column's true ink edge) out.) */
const PEAK_END_RATIO = 0.5;
/** Minimum starts for the match set (line-start values used in drift repair). */
const MATCH_SET_MIN_STARTS = 4;
/** LAYOUT-FIX-9 (P4, 2026-09-17): ink-adjacency tolerance for the drift
 * repair — a non-anchored item continues its predecessor's line when the
 * predecessor's INK right edge reaches within this distance of the item's
 * start. Calibrated on the bisect corpus: sequential words of one visual
 * line sit 0–0.6pt apart after the ink channels (queue Tm-clamp: exactly 0;
 * DOM Range: ink + trailing space ≈ next start), while a cross-gutter
 * neighbor sits 9pt+ away (D1: «Signaling via RAS…» start 333.0 vs the left
 * line's ink end 314 — 19pt by PyMuPDF ground truth, 9pt vs the validated
 * boundary 324). The band between ~2 and ~9pt is unassigned by design:
 * drifts beyond 2pt past the boundary were already documented as the known
 * limitation of the slicer (membership of one word changes, text never
 * lost), and first-line indents are ≥ 9pt (≈ one em at body size).
 *
 * LAYOUT-FIX-18c (2026-09-19) opens exactly that band for the
 * crossing-tail continuation: a SHORT unanchored row-final item whose
 * predecessor's DECLARED edge already crosses the cut (the predecessor
 * itself is drift-inflated) is the last word of the lower line — the
 * observed drift gap band is 6–15pt (try4 p3 «and»: gap 13.5pt). */
const INK_ADJ_TOL = 2;

/**
 * LAYOUT-FIX-18 constants — single-word drift-tail repair.
 */
/** Max declared width (pt) of a drift tail / crossing-tail continuation. */
const DRIFT_TAIL_MAX_WIDTH = 60;
/** Max words in a drift tail's text. */
const DRIFT_TAIL_MAX_WORDS = 2;
/** Max gap (pt) between the crossing predecessor's declared edge and the
 * tail: enough for the observed +6..+15pt inflated gaps, below the ≥25pt
 * first-line indent of a legitimate right-column line. */
const CROSSING_TAIL_MAX_GAP = 20;
/** Same-row overlap (pt) that counts as real for the legacy demotion —
 * sub-half-point overlaps are pdfjs split artifacts («(Figur»→"e 2.17)." at
 * −0.1pt), not drift. */
const SAME_ROW_OVERLAP_EPS = 0.5;
/** Boundary straddle zone (pt): an item whose left sits within this window
 * right of the cut AND overlaps its own group's run is a drifted word
 * crossing INTO the right column — still demoted to the lower group
 * (legacy D1 repair). Beyond the zone, same-group-only overlaps are
 * mid-column split artifacts / drift victims and KEEP their base group. */
const DRIFT_STRADDLE_ZONE = 40;
/** Minimum rows where BOTH sides have text. */
const MIN_SHARED_ROWS = 5;
/** Minimum co-occurrence fraction of the side with fewer rows. 0.4, not
 * 0.5: on figure-heavy pages the right column's rows include table-region
 * rows where the left side is momentarily empty (try.pdf p.4: 19/39 = 0.49
 * for a TRUE column boundary). Heading blocks are rejected by the mutual
 * span gate (they never span the body's height), not by co-occurrence. */
const MIN_COOCCUR = 0.4;
/** Minimum median row width of both sides, fraction of page width. */
const MIN_ROW_WIDTH_FRAC = 0.18;
/** Minimum mutual overlap fraction of the two sides' vertical spans —
 * full-page metric (pre-FIX-12 semantics) for boundaries ABOVE the
 * relaxation floor; the co-occurrence-band metric governs the
 * relaxation zone below it. See isColumnBoundary. */
const MIN_SPAN_OVERLAP = 0.6;
/** LAYOUT-FIX-12 (2026-09-17): relaxation floor for the FULL-PAGE mutual
 * overlap. A side whose entire vertical extent overlaps the other side by
 * < 30% is furniture/fragment traffic beside an unrelated block — rejected
 * outright, no relaxation. True column pairs measured on the corpus stay
 * above it (try4 p1 0.357 / p2 0.488 / p3 0.592); false indent cuts (try.pdf
 * p1 TOC @333: 0.595) sit in the 0.3–0.6 RELAXATION ZONE, where the
 * band + straddle gates below decide. */
const MIN_SPAN_OVERLAP_FLOOR = 0.3;
/** LAYOUT-FIX-12: straddle tolerance (pt). On a row with text on both
 * sides of a TRUE boundary, the left part ENDS and the right part STARTS
 * within this distance of the cut (justified flush 0–2pt, Tm-clamped
 * exactly at the cut, declared overshoot up to +12pt on p2/p3 of try4,
 * one-em paragraph indents at cut+9pt). An indent-peak cut sits 42–133pt
 * right of the left column’s real edge (try.pdf p1 TOC: level-1 entries
 * end at x≤291, the level-2 indent peak is 333). */
const STRADDLE_TOL = 15;
/** LAYOUT-FIX-12: max fraction of crossing rows allowed to violate the
 * straddle geometry. Ragged paragraph-end lines of a true column end
 * mid-column (try4 p2 “soft tissue.”, p3 “include: 24”) — measured
 * 0–11% of crossing rows; the TOC’s indent cut damages ~100%.
 *
 * LAYOUT-FIX-13 (2026-09-18): the third damage condition («left part bleeds
 * deep past the cut») is REMOVED — it rejected rows that FLOW THROUGH the
 * cut (a full-width caption line's word-level items continuing past the
 * boundary: a narrow, continuous L→R transition, not damage). It was never
 * the operative damage mode on the corpus (the measured left overshoot is
 * +2..12pt, under the 15pt tolerance). The two remaining modes (left stops
 * short / right starts deep past) keep the TOC@333 rejection and every
 * corpus verdict unchanged. */
const MAX_STRADDLE_FRAC = 0.25;
/** Co-occurrence window: baselines of the two columns may be phase-shifted
 * (observed 3.0pt and 6.1pt on the corpus). ±7pt ≈ half a body leading —
 * covers every shift below half the leading, and consecutive rows within
 * one column (11-12pt apart) still never match each other. */
const COOCCUR_WINDOW = 7;
/** A gap wider than this splits a row side into clusters — the signature
 * of table cells (corpus: 39-56pt cell gaps) as opposed to text runs
 * ( overstated pdfjs word gaps stay ≤ ~9pt; inter-column gutters ride the
 * boundary itself and never split a SIDE). */
const TABLE_GAP = 25;
/** A side is a "clean text column" when ≥ this fraction of its wide rows
 * are a single x-run. */
const CLEAN_RUN_FRAC = 0.6;
/** Maximum distance between the boundary and the 75th percentile of the
 * left-side wide rows' END (the "gutter width"). Indent levels and
 * heading blocks inside one column produce candidate peaks whose left
 * lines END far away (try.pdf p.1 TOC: cut at 90 while lines end at ~291);
 * a real column pair's left lines end within the gutter of the boundary. */
const MAX_GUTTER_FRAC = 0.08;
/** Minimum rects on each side of a boundary. */
const MIN_SIDE_RECTS = 8;
/** LAYOUT-FIX-13 (A2-fallback): the F19 symptom guard. A page qualifies for
 * the memory fallback only when its LEFT-side rows physically REACH the
 * remembered cut (declared/clamped right edge within this distance of it,
 * or past it) on rows that also carry right-side text nearby
 * (±COOCCUR_WINDOW) — i.e. the single-map occupancy grid would (or did)
 * bridge the gutter and fuse the columns. Pages whose columns are already
 * cleanly separated (grading p1/p5, 2tier p1: left ink ends 11.5pt short
 * of the cut) carry no bridge evidence and keep their single-map output.
 * 8pt: InDesign overstatement reaches the gutter at +2–16pt, while the
 * corpus’s no-fusion pages stop ≥11.5pt short. */
const MEMORY_BRIDGE_TOL = 8;
/** LAYOUT-FIX-13 (A2-fallback): minimum bridge rows for the fallback. */
const MEMORY_MIN_BRIDGE_ROWS = 5;
/** LAYOUT-FIX-13 (A2-fallback): a left wide row whose right edge sits this
 * far PAST the boundary is FURNITURE (a full-width caption/table line
 * legitimately crossing the page), not a column row — excluded from the
 * fallback gutter-gate pool (the unfiltered pool dragged p75 out to the
 * caption edge and sank the gate: book p61 Figure 2.12 caption ends at
 * 546 vs cut 323). Full mode keeps the unfiltered pool byte-identically. */
const FALLBACK_FULL_ROW_OVER = 24;

// ── LAYOUT-FIX-10 (2026-09-17, Phase 4 / A1+A2) ──────────────────────────
/** A1: minimum ink gap (pt) between adjacent items of one visual row for
 * the empty strip to count as whitespace-channel material. 9pt = the
 * narrowest validated gutter of the corpus (try3:p3 [310..324]) — wider
 * than every overstated pdfjs inter-word gap after the Tm-clamp (≤ ~6pt)
 * and narrower than every real inter-column gutter. */
const CHANNEL_MIN_GAP = 9;
/** A1: half-width (pt) of the SELECTION window around a validated
 * boundary — channel intervals ENDING within this distance of the peak
 * vote for the true column start. Deliberately WIDER than the move cap:
 * the D2-class misalignment is 9pt (peak 333 against the true start 324),
 * so a ±6 window would never even see the correcting intervals
 * (measured on the constructible D2 case: flush rows ending their gutters
 * at 324 while the dominant peak sits at 333). */
const CHANNEL_REFINE_WIN = 12;
/** A1: maximum boundary move (pt) — the D2-class peak-vs-start
 * misalignment measured on the TOC page was 9pt (333 against the true
 * start). */
const CHANNEL_REFINE_MAX = 9;
/** A1: moves smaller than this (pt) are float-identity noise, not signal
 * — the peak and the channel's right edge are the SAME position up to
 * sub-pixel float arithmetic (measured: a 3e-14 rightward "move" flipped
 * the 13 items sitting exactly at the peak float from the right group to
 * the left on try3:p3). */
const CHANNEL_REFINE_EPS = 0.05;
/** A1: minimum channel intervals ending within the window for a
 * refinement to apply at all (single accidental gaps must not move a
 * validated boundary). Matches MIN_SHARED_ROWS semantics. */
const CHANNEL_MIN_SUPPORT = 5;
/** A2: lowered start-count threshold for a start-peak within ±2pt of a
 * remembered right-column start (candidate rescue). The rescued peak
 * still passes the FULL isColumnBoundary validation — the memory lowers
 * only the peak-count threshold, never a structural gate. */
const MEMORY_MIN_PEAK_STARTS = 3;
/** A2: window (pt) between a weak start-peak and a remembered right-column
 * start for the rescue. Deliberately tighter than the boundary window:
 * start peaks repeat within ≤0.3pt across pages of one layout (Tm
 * anchors), so ±2pt already absorbs cross-page float jitter with margin. */
const MEMORY_RESCUE_WIN = 2;
/** A2: an observation whose boundaries diverge from the active consensus
 * by more than this (pt, per slot) is a DIFFERENT layout that slipped the
 * signature matching — it neither joins nor rewrites the record (plan
 * §7.2 safeguard #3: «одна расхождённая страница не переписывает
 * консенсус»). */
const MEMORY_DIVERGENCE_TOL = 8;

interface ChannelInterval { l: number; r: number; mid: number }

/** A1: whitespace-channel intervals of the page — for every pair of
 * adjacent feed items in one visual row whose gap is ≥ CHANNEL_MIN_GAP,
 * the empty strip [item.right, nextItem.left]. On an ink feed (queue
 * Tm-clamp / DOM Range) these strips are true rendered whitespace; on a
 * declared feed the overstated pdfjs widths close the real gutters, so
 * the channel is naturally silent there — one more reason A1 is gated on
 * the ink feed (see sliceRectsByColumns step 4.1). */
function computeChannelIntervals(rows: Row[]): ChannelInterval[] {
  const out: ChannelInterval[] = [];
  for (const row of rows) {
    const items = [...row.rects].sort((a, b) => a.left - b.left);
    for (let i = 0; i + 1 < items.length; i++) {
      const gap = items[i + 1].left - items[i].right;
      if (gap >= CHANNEL_MIN_GAP) {
        out.push({ l: items[i].right, r: items[i + 1].left, mid: (items[i].right + items[i + 1].left) / 2 });
      }
    }
  }
  return out;
}

/** A1: refine a validated boundary toward the ink-channel's RIGHT EDGE —
 * the TRUE column start. The peak normally IS that start (Tm anchors are
 * exact), so on a healthy page the median right edge of the near
 * intervals equals the peak and NOTHING moves (corpus-inert by
 * construction: measured 0.0pt offset on every corpus page). The
 * refinement exists for the D2 class — a page whose dominant start-peak
 * sits at an INDENT or otherwise misaligned position while the gutter's
 * right edge (the next column's true first line start, the `r` of the
 * channel intervals) exposes the real start LEFT of the peak: the
 * boundary moves there (LEFTWARD only) and the items between the true
 * start and the old peak — currently misassigned to the LEFT group —
 * join the RIGHT group. That membership change is the intended D2
 * correction; rightward moves are REJECTED (the peak is the right
 * column's anchored start — items sit exactly at it, and a rightward
 * move flips them left; measured 13 items on try3:p3 from a 3e-14
 * float-identity "move"), and so are moves below CHANNEL_REFINE_EPS.
 *
 * WHY THE RIGHT EDGE, NOT THE GUTTER MIDPOINT (measured, Task 36): the
 * plan §7.1 sketched «argmax канала» as the gutter CENTRE (PyMuPDF
 * ink-columns.json stores gap midpoints). Landing the boundary there was
 * measured to break STEP 9's wide zone — WIDE_MARGIN=36 was calibrated
 * against column-START positions for 12 versions, and a 6pt leftward
 * move flipped marginal units (try3:p4 DOM: bullet bands [235..331]
 * became «wide», flew to the header bucket, invY 0→27). The boundary's
 * FUNCTIONAL semantics — the cut test `r.left >= b`, the F1 8.65 gate,
 * the wide tests, the colRegion derivation — all read it as the column
 * start; the ink-true column start is the channel's right edge. The
 * PyMuPDF midpoints remain in the release INFO as the reporting truth. */
function refineBoundaryByChannel(
  boundary: number,
  intervals: ChannelInterval[],
  _rects: InputRect[],
): number {
  const near = intervals.filter(it => Math.abs(it.r - boundary) <= CHANNEL_REFINE_WIN);
  if (near.length < CHANNEL_MIN_SUPPORT) return boundary;
  const rights = near.map(it => it.r).sort((a, b) => a - b);
  const target = rights[Math.floor(rights.length / 2)];
  const refined = Math.min(boundary + CHANNEL_REFINE_MAX, Math.max(boundary - CHANNEL_REFINE_MAX, target));
  // LEFTWARD moves only, and only when they carry real signal: a
  // rightward or epsilon move flips the anchored right-column starts at
  // the peak into the left group (float noise — see CHANNEL_REFINE_EPS).
  if (!(refined < boundary - CHANNEL_REFINE_EPS)) return boundary;
  return refined;
}

/** A2: median ink edges + dominant font size of the feed — the numeric
 * fields of the layout signature (column-memory.ts). Memory-independent
 * by construction (computed from the feed, before any slicing decision). */
function medianInkEdges(rects: InputRect[]): { medL: number; medR: number; medFs: number } {
  const ls = rects.map(r => r.left).sort((a, b) => a - b);
  const rs = rects.map(r => r.right).sort((a, b) => a - b);
  const fs = rects
    .map(r => (Number.isFinite((r as any).fontsize) ? (r as any).fontsize : 10))
    .sort((a, b) => a - b);
  const mid = (arr: number[]): number => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
  return { medL: mid(ls), medR: mid(rs), medFs: mid(fs) };
}

interface Row {
  bottom: number;
  rects: InputRect[];
}

/** Group rects into visual rows by baseline (rect.bottom, tolerance ROW_TOL). */
function groupIntoRows(rects: InputRect[]): Row[] {
  const sorted = [...rects].sort((a, b) => a.bottom - b.bottom || a.left - b.left);
  const rows: Row[] = [];
  let cur: Row | null = null;
  for (const r of sorted) {
    if (cur && Math.abs(r.bottom - cur.bottom) <= ROW_TOL) {
      cur.rects.push(r);
    } else {
      cur = { bottom: r.bottom, rects: [r] };
      rows.push(cur);
    }
  }
  return rows;
}

interface Peak {
  value: number;
  starts: number;
  ends: number;
}

/** Cluster item lefts into peaks (bin PEAK_TOL, sub-cluster PEAK_SUBTOL);
 * each peak's value is its DOMINANT sub-value — the x where most of its
 * lines actually start (Tm anchors repeat exactly; drifted strays in the
 * bin would otherwise shift the cut left of the true column start).
 * Counts nearby item rights. */
function computeStartPeaks(rects: InputRect[]): Peak[] {
  const starts = rects.map(r => r.left).sort((a, b) => a - b);
  const raw: Array<{ value: number; starts: number }> = [];
  let i = 0;
  while (i < starts.length) {
    let j = i;
    while (j < starts.length && starts[j] - starts[i] <= PEAK_TOL) j++;
    const bin = starts.slice(i, j);
    // Dominant sub-cluster (max count; ties → leftmost).
    let bestValue = bin[0], bestCount = 0;
    let k = 0;
    while (k < bin.length) {
      let m = k;
      while (m < bin.length && bin[m] - bin[k] <= PEAK_SUBTOL) m++;
      if (m - k > bestCount) { bestCount = m - k; bestValue = bin[k]; }
      k = m;
    }
    raw.push({ value: bestValue, starts: j - i });
    i = j;
  }
  const rights = rects.map(r => r.right).sort((a, b) => a - b);
  return raw.map(p => {
    // items ENDING within ±2pt of the peak value (binary search over sorted rights)
    let lo = 0, hi = rights.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rights[mid] < p.value - 2) lo = mid + 1; else hi = mid; }
    const from = lo;
    lo = from; hi = rights.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rights[mid] <= p.value + 2) lo = mid + 1; else hi = mid; }
    return { value: p.value, starts: p.starts, ends: lo - from };
  });
}

/** True when `sorted` (ascending) holds a value within ±win of y. */
function existsWithin(sorted: number[], y: number, win: number): boolean {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < y - win) lo = mid + 1; else hi = mid; }
  return lo < sorted.length && sorted[lo] <= y + win;
}

/** Number of x-clusters in a row side (gaps > TABLE_GAP split clusters). */
function countRowClusters(rects: InputRect[]): number {
  const sorted = [...rects].sort((a, b) => a.left - b.left);
  let clusters = 0;
  let prevRight = -Infinity;
  for (const r of sorted) {
    if (clusters === 0 || r.left - prevRight > TABLE_GAP) clusters++;
    prevRight = Math.max(prevRight, r.right);
  }
  return clusters;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** LAYOUT-FIX-13 (A2-fallback): the F19 symptom counter — rows with LEFT-side
 * text whose declared/clamped right edge REACHES the remembered cut (within
 * MEMORY_BRIDGE_TOL or past it) while right-side text sits within
 * ±COOCCUR_WINDOW of the row’s baseline. ≥ MEMORY_MIN_BRIDGE_ROWS such rows
 * mean the single-map occupancy grid bridges the gutter and the columns
 * fuse into interleaved units — the exact failure the fallback exists to
 * prevent. Pages without bridges (cleanly separated columns) get no
 * fallback, keeping the corpus contract intact. */
function countBridgeRows(boundary: number, rows: Row[]): number {
  const rightRowBottoms: number[] = [];
  for (const row of rows) {
    if (row.rects.some(r => r.left >= boundary - 0.5)) rightRowBottoms.push(row.bottom);
  }
  rightRowBottoms.sort((a, b) => a - b);
  let bridges = 0;
  for (const row of rows) {
    let lMax = -Infinity, hasL = false;
    for (const r of row.rects) {
      if (r.left < boundary - 0.5) { lMax = Math.max(lMax, r.right); hasL = true; }
    }
    if (!hasL || lMax < boundary - MEMORY_BRIDGE_TOL) continue;
    if (existsWithin(rightRowBottoms, row.bottom, COOCCUR_WINDOW)) bridges++;
  }
  return bridges;
}

/**
 * Validate a candidate boundary: the rects left of it and right of it must
 * look like side-by-side text columns (mass, y-window co-occurrence, row
 * width, mutual vertical span overlap, clean-text-column).
 *
 * LAYOUT-FIX-13: `mode` — 'full' (default, the page's own candidates;
 * byte-identical to the pre-FIX-13 semantics except the desert-gap
 * straddle test) or 'fallback' (a remembered boundary re-validated after
 * the page's own candidates all failed: the full-page mutual-overlap
 * gates are skipped, the co-occurrence band + straddle always run, and
 * the gutter pool excludes full-width furniture rows).
 */
function isColumnBoundary(
  boundary: number,
  rows: Row[],
  pageW: number,
  mode: 'full' | 'fallback' = 'full',
): boolean {
  const cut = boundary - 0.5;
  const minW = pageW * MIN_ROW_WIDTH_FRAC;
  let leftRects = 0, rightRects = 0;
  let leftRows = 0, rightRows = 0;
  const leftWidths: number[] = [];
  const rightWidths: number[] = [];
  const leftWideEnds: number[] = [];
  const leftRowBottoms: number[] = [];
  const rightRowBottoms: number[] = [];
  // LAYOUT-FIX-12: per-crossing-row straddle geometry (lMax/rMin), for the
  // relaxation-zone straddle test — see the span gate below.
  const crossRows: Array<{ lMax: number; rMin: number; wideLeft: boolean }> = [];
  let leftWideRows = 0, rightWideRows = 0;
  let leftFragWide = 0, rightFragWide = 0;
  let leftTop = Infinity, leftBottom = -Infinity;
  let rightTop = Infinity, rightBottom = -Infinity;

  for (const row of rows) {
    let lMin = Infinity, lMax = -Infinity;
    let rMin = Infinity, rMax = -Infinity;
    let hasL = false, hasR = false;
    const lRects: InputRect[] = [];
    const rRects: InputRect[] = [];
    for (const r of row.rects) {
      if (r.left < cut) {
        leftRects++;
        lRects.push(r);
        lMin = Math.min(lMin, r.left); lMax = Math.max(lMax, r.right);
        leftTop = Math.min(leftTop, r.bottom); leftBottom = Math.max(leftBottom, r.bottom);
        hasL = true;
      } else {
        rightRects++;
        rRects.push(r);
        rMin = Math.min(rMin, r.left); rMax = Math.max(rMax, r.right);
        rightTop = Math.min(rightTop, r.bottom); rightBottom = Math.max(rightBottom, r.bottom);
        hasR = true;
      }
    }
    if (hasL) {
      leftRows++;
      leftRowBottoms.push(row.bottom);
      leftWidths.push(lMax - lMin);
      if (lMax - lMin >= minW) {
        leftWideRows++;
        leftWideEnds.push(lMax);
        if (countRowClusters(lRects) > 1) leftFragWide++;
      }
    }
    if (hasL && hasR) crossRows.push({ lMax, rMin, wideLeft: lMax - lMin >= minW }); // LAYOUT-FIX-12/17a
    if (hasR) {
      rightRows++;
      rightRowBottoms.push(row.bottom);
      rightWidths.push(rMax - rMin);
      if (rMax - rMin >= minW) {
        rightWideRows++;
        if (countRowClusters(rRects) > 1) rightFragWide++;
      }
    }
  }

  if (leftRects < MIN_SIDE_RECTS || rightRects < MIN_SIDE_RECTS) return false;

  // Co-occurrence within a ±COOCCUR_WINDOW y-band, counted on the side
  // with fewer rows (the phase-shift-tolerant replacement of exact-row
  // sharing). A column's own consecutive baselines (11-12pt apart) are
  // outside the window, so only genuinely side-by-side text matches.
  const smaller = leftRows <= rightRows ? leftRowBottoms : rightRowBottoms;
  const biggerSorted = (leftRows <= rightRows ? rightRowBottoms : leftRowBottoms).sort((a, b) => a - b);
  let sharedRows = 0;
  for (const y of smaller) { if (existsWithin(biggerSorted, y, COOCCUR_WINDOW)) sharedRows++; }
  if (sharedRows < MIN_SHARED_ROWS) return false;
  if (sharedRows / Math.min(leftRows, rightRows) < MIN_COOCCUR) return false;

  // Column-wide rows only (excludes table cells / figure labels / notes).
  // COUNT of wide rows, not the median row width: superscript rows (w≈5-20,
  // raised baselines), figure-label rows (w≈25-50) and caption fragments
  // dominate the row population on figure-heavy pages (try.pdf p.3: 13 text
  // rows vs ~20 noise rows → median 96pt) and would sink a median-based gate
  // even though real 240pt-wide text lines exist.
  if (leftWideRows < MIN_SHARED_ROWS || rightWideRows < MIN_SHARED_ROWS) return false;

  // Mutual vertical overlap (a heading block never spans the body's height).
  // LAYOUT-FIX-12 (2026-09-17, try4.pdf): the pre-fix gate measured each
  // side's span over ALL of its rows — including page furniture (running
  // headers/footers sit on ONE side of the cut) and full-width figure
  // captions (their left half extends the LEFT side far below the columns).
  // On figure-dominated pages the two-column body itself covers only 30–45%
  // of the page height, so furniture stretches one side's span and sinks
  // overlap/span below 0.6 for a TRUE boundary:
  //   try4 p1 (body 242pt of 783): header y=32 + captions y=679–709 both
  //     LEFT of the cut → leftSpan 677 vs rightSpan 242 → 0.357 FAIL;
  //   try4 p2 (body 336pt): running header "Specimen Submission…" (x=373,
  //     RIGHT of the cut) → rightSpan 688 vs leftSpan 336 → 0.488 FAIL;
  //   try4 p3 (staircase: right 303–721, left 464–722 + full-width Fig 2.15
  //     caption left-below): 0.592 FAIL — off by 0.008.
  // With detection dead the single-map fallback fused both columns into
  // interleaved units (cross-column overmerge, user report).
  //
  // THE FIX — three zones:
  //   1. full-page overlap ≥ MIN_SPAN_OVERLAP (0.6) both sides → PASS,
  //      byte-identical to v23–lfix11 (grading/2tier/try3 corpus pages).
  //   2. < MIN_SPAN_OVERLAP_FLOOR (0.3) → FAIL (furniture beside an
  //      unrelated block; nothing relaxes below the floor).
  //   3. RELAXATION ZONE [0.3, 0.6): the boundary passes only when BOTH
  //      hold:
  //      (a) CO-OCCURRENCE BAND — each side's span restricted to rows with
  //          opposite-side text within ±COOCCUR_WINDOW mutually overlaps
  //          ≥ 0.6. Furniture rows (header at the page top, captions in a
  //          figure region the other column does not reach) have no
  //          counterpart and drop out; staircase layouts pass by
  //          construction (the band is the shared strip).
  //      (b) STRADDLE TEST — on rows with text on both sides, the left
  //          part must END and the right part must START within
  //          STRADDLE_TOL (15pt) of the cut. try.pdf p1's TOC showed why
  //          (a) alone is not enough: its right "column" is the entries'
  //          level-2/3 INDENT peak at 333 (level-1 entries end at x≤291),
  //          every crossing row is straddle-damaged, and slicing at 333
  //          split atomic entry lines mid-sentence ("Veterinary cancers –"
  //          | "molecular approaches…", "…Daniel Regan" | ", and Susan J.
  //          G. Shapiro"). A true column's rows straddle the cut cleanly
  //          (0–11% damaged — ragged paragraph-end lines only), the TOC's
  //          ~100% → rejected; the page keeps its correct unsliced output.
  const leftSpan = leftBottom - leftTop;
  const rightSpan = rightBottom - rightTop;
  if (leftSpan <= 0 || rightSpan <= 0) return false;
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
  const fullOvL = overlap / leftSpan;
  const fullOvR = overlap / rightSpan;
  // LAYOUT-FIX-13 (A2-fallback): 'fallback' mode re-validates a REMEMBERED
  // boundary from the cross-page memory when the page's own candidates all
  // failed the full gates. The full-page mutual-overlap gates are exactly
  // the ones a furniture page cannot pass (book p61: the right column is a
  // bottom Figure 2.13 caption of 8 lines — rightSpan 75pt vs leftSpan 726pt
  // incl. the running header → fullOvL 0.10 < FLOOR), so the fallback mode
  // SKIPS them and decides on the page's own LOCAL evidence instead — the
  // co-occurrence band + the desert-gap straddle below. Every other gate
  // (mass, co-occurrence, wide rows, gutter, clean text) applies in full.
  //
  // LAYOUT-FIX-17b (2026-09-19, try5.pdf): the FLOOR gate used to be an
  // INSTANT full-mode rejection — but a single furniture line living on ONE
  // side of the cut (try5 p2's running header «Tumors in Domestic Animals»,
  // x 68–164, page top) stretches that side's full-page span and sinks
  // fullOvL to 0.16 even though the page's column BODIES are perfectly
  // aligned. The band spans are therefore computed BEFORE the floor gate,
  // and a floor failure re-tests on the CO-OCCURRENCE BAND core (the side's
  // rows with an opposite-side row within ±COOCCUR_WINDOW): furniture rows
  // have no counterpart and drop out. A page whose band core also fails the
  // floor is still rejected here (furniture beside an unrelated block);
  // a page with a live band core falls through to the relaxation branch
  // below, which re-validates everything (band ≥ MIN_SPAN_OVERLAP, wide
  // rows, straddle, gutter, clean text) in full.
  const leftBottomsSorted = [...leftRowBottoms].sort((a, b) => a - b);
  const rightBottomsSorted = [...rightRowBottoms].sort((a, b) => a - b);
  let lBandTop = Infinity, lBandBottom = -Infinity;
  let rBandTop = Infinity, rBandBottom = -Infinity;
  for (const y of leftRowBottoms) {
    if (existsWithin(rightBottomsSorted, y, COOCCUR_WINDOW)) {
      if (y < lBandTop) lBandTop = y;
      if (y > lBandBottom) lBandBottom = y;
    }
  }
  for (const y of rightRowBottoms) {
    if (existsWithin(leftBottomsSorted, y, COOCCUR_WINDOW)) {
      if (y < rBandTop) rBandTop = y;
      if (y > rBandBottom) rBandBottom = y;
    }
  }
  const bandFinite = Number.isFinite(lBandTop) && Number.isFinite(rBandTop);
  const lBandSpan = lBandBottom - lBandTop;
  const rBandSpan = rBandBottom - rBandTop;
  const bandSpanOk = bandFinite && lBandSpan > 0 && rBandSpan > 0;
  const bandOverlap = bandFinite ? Math.min(lBandBottom, rBandBottom) - Math.max(lBandTop, rBandTop) : NaN;
  if (mode === 'full') {
    if (fullOvL < MIN_SPAN_OVERLAP_FLOOR || fullOvR < MIN_SPAN_OVERLAP_FLOOR) {
      // LAYOUT-FIX-17b: furniture-robust re-test on the band core.
      if (!bandSpanOk
        || (bandOverlap / lBandSpan) < MIN_SPAN_OVERLAP_FLOOR
        || (bandOverlap / rBandSpan) < MIN_SPAN_OVERLAP_FLOOR) return false;
    }
  }
  if (mode === 'fallback' || fullOvL < MIN_SPAN_OVERLAP || fullOvR < MIN_SPAN_OVERLAP) {
    // (a) co-occurrence band spans — precomputed above (LAYOUT-FIX-17b).
    if (!bandFinite) return false;
    if (lBandSpan <= 0 || rBandSpan <= 0) return false;
    if (bandOverlap / lBandSpan < MIN_SPAN_OVERLAP || bandOverlap / rBandSpan < MIN_SPAN_OVERLAP) return false;

    // (b) straddle test — crossing rows must break AT the cut, not around it.
    // LAYOUT-FIX-13: the left part must not STOP SHORT of the cut
    // (boundary − lMax > STRADDLE_TOL — the TOC@333 signature: level-1
    // entries end at ≤291 while the "right column" starts at the indent
    // peak 333) and the right part must not START DEEP past it
    // (rMin − boundary > STRADDLE_TOL). The pre-fix third condition
    // («left bleeds deep past the cut», lMax − boundary > STRADDLE_TOL)
    // rejected rows that FLOW THROUGH the cut — a full-width caption line
    // whose word-level items continue past the boundary: its L→R
    // transition is narrow and continuous, not a desert. It was never the
    // operative damage mode on the corpus (the measured overshoot is
    // +2..12pt, under the 15pt tolerance) and the desert-gap variant
    // (rMin − lMax > STRADDLE_TOL) broke the ragged-line corner: a row
    // ending 14pt short of the cut with the right part starting AT it
    // (try4 p2) has a 16pt "gap" that is NOT damage. Removed.
    //
    // LAYOUT-FIX-17a (2026-09-19, try5.pdf p1): the damage FRACTION is
    // now computed over WIDE crossing rows only (left part ≥ minW). A
    // rubric-bearing column page carries SHORT left rows — section
    // headings ('Fibrosarcoma' w≈70, 'Classification' w≈56) sitting on
    // shared y-bands with the opposite column's full text lines; they are
    // legitimate left-column content, yet every one of them counted as
    // «left stops short» damage, sinking try5 p1's TRUE cut at 5-6/16
    // (31-38% > 25%). The TOC@333 damage mode the gate was built for is
    // made of WIDE rows (level-1 entries: left part 72→291 = 219pt) and
    // stays fully visible to the wide-only denominator; narrow
    // heading/label rows carry no straddle information either way.
    let crossing = 0, damaged = 0;
    let crossingWide = 0, damagedWide = 0;
    for (const cr of crossRows) {
      crossing++;
      const dmg = boundary - cr.lMax > STRADDLE_TOL   // left part stops short of the cut
        || cr.rMin - boundary > STRADDLE_TOL;         // right part starts deep past it
      if (dmg) damaged++;
      if (cr.wideLeft) {
        crossingWide++;
        if (dmg) damagedWide++;
      }
    }
    void crossing; void damaged; // (diagnostic counters, see FIX-17a note)
    if (crossingWide > 0 && damagedWide / crossingWide > MAX_STRADDLE_FRAC) return false;
  }

  // Gutter gate: the left column's wide rows must END near the boundary —
  // the whitespace band between the columns. Indent levels (a column's own
  // level-2/3 starts) and wide headings produce peaks whose "left side"
  // ends hundreds of points away; a real neighbouring column starts where
  // this column stops. 75th percentile (ragged paragraph-end lines don't
  // reach the margin); overstated ends land a few pt INTO the gutter, which
  // the tolerance absorbs.
  // LAYOUT-FIX-13: in FALLBACK mode, full-width furniture rows (caption /
  // table lines crossing the whole page, right edge past the cut by
  // FALLBACK_FULL_ROW_OVER) are not column rows and drop out of the pool —
  // on book p61 the Figure 2.12 full-width caption (9 rows ending at 546)
  // otherwise drags p75 out and sinks the gate for the TRUE cut at 323.
  const gutterPool = mode === 'fallback'
    ? leftWideEnds.filter(e => e <= boundary + FALLBACK_FULL_ROW_OVER)
    : leftWideEnds;
  if (gutterPool.length >= MIN_SHARED_ROWS) {
    const sortedEnds = [...gutterPool].sort((a, b) => a - b);
    const p75 = sortedEnds[Math.floor(sortedEnds.length * 0.75)];
    if (Math.abs(p75 - boundary) > pageW * MAX_GUTTER_FRAC) return false;
  }

  // Clean-text gate: at least one side must be a text column — ≥60% of its
  // wide rows a single x-run. A full-width table sliced anywhere yields
  // cell clusters on both sides of the cut and is rejected (legacy path);
  // table-left + text-right pages keep the cut at the text column's edge.
  const leftClean = leftWideRows >= MIN_SHARED_ROWS && leftFragWide <= leftWideRows * (1 - CLEAN_RUN_FRAC);
  const rightClean = rightWideRows >= MIN_SHARED_ROWS && rightFragWide <= rightWideRows * (1 - CLEAN_RUN_FRAC);
  if (!leftClean && !rightClean) return false;

  return true;
}

/**
 * Partition rects into per-column groups.
 *
 * Returns {detected:false, groups:[rects]} when no column structure is
 * validated — callers then run the legacy single-map pipeline.
 *
 * LAYOUT-FIX-10 (A1): `opts.inkChannel` marks a PRODUCTION ink feed (queue
 * Tm-clamp / DOM Range — set via ContourSettings.inkChannelFeed). Only
 * then does the whitespace-channel refinement reposition validated
 * boundaries at the ink gutter centre; every other feed (synthetic suites,
 * declared-width harnesses, the disableInkGeometry kill-switch path) keeps
 * the exact v23 peak positions.
 */
export function sliceRectsByColumns(
  rects: InputRect[],
  pageW: number,
  pageH: number,
  opts?: { inkChannel?: boolean; forceDetection?: boolean; driftTailRepair?: boolean },
): ColumnSlice {
  const single: ColumnSlice = { detected: false, groups: [rects], boundaries: [] };
  void pageH; // reserved (mutual-span overlap covers the vertical gates)
  if (!rects || rects.length < MIN_RECTS) return single;

  // 1. Visual rows (baseline groups). rect.bottom of a pdfjs item is its
  //    exact baseline (viewport, top-down); same-row items share it within
  //    font-descent variance on the DOM path.
  const rows = groupIntoRows(rects);
  if (rows.length < MIN_SHARED_ROWS * 2) return single;

  // LAYOUT-FIX-10 (A2): pre-slice cross-page memory lookup by the PARTIAL
  // signature (column count still unknown — cols: 0 wildcard). Inert
  // without a file context (harnesses / synthetic suites), when killed
  // (LayoutSettings.disableColumnMemory), or before the ≥2-page quorum:
  // the FIRST TWO pages of every document are byte-for-byte v23. On strong
  // pages the remembered anchors duplicate the page's own peaks — inert
  // again; the memory only matters where the page's own start evidence is
  // thin (short / jittery pages).
  const { medL, medR, medFs } = medianInkEdges(rects);
  const memory: ColumnMemorySnapshot | null = lookupColumnMemory({ pageW, pageH, medL, medR, medFs, cols: 0 });
  const memPeaks = memory ? memory.rightPeaks : [];

  // LAYOUT-FIX-9 (P4): is this an INK feed? Computed once, used by the A1
  // refinement (step 4.1) and the drift repair (step 6). LAYOUT-FIX-10
  // (A1): a feed with ZERO clamped rects (no overstated widths) carries no
  // declRight stamps but is still ink-faithful — the explicit
  // opts.inkChannel flag (production plumbing) covers that case; the
  // stamp-based test alone would leave no-overstatement pages (classif:p4,
  // urt:p7 on the corpus) without the channel refinement.
  const inkFeed = opts?.inkChannel === true || rects.some(r => typeof (r as any).declRight === 'number');

  // 2. Start-dominated peaks = candidate column starts.
  const peaks = computeStartPeaks(rects);
  const candidates = peaks.filter(p => p.starts >= MIN_PEAK_STARTS && p.ends <= p.starts * PEAK_END_RATIO);
  // LAYOUT-FIX-10 (A2) — candidate rescue: a WEAK start-peak (≥
  // MEMORY_MIN_PEAK_STARTS instead of MIN_PEAK_STARTS) within
  // ±MEMORY_RESCUE_WIN of a remembered right-column start joins the
  // candidate list. The memory cannot validate it: isColumnBoundary
  // (mass / co-occurrence / wide rows / span overlap / gutter /
  // clean-text) applies in full below — the prior only lowers the
  // PEAK-COUNT threshold, exactly the «бонус ≤ собственной evidences»
  // bound of plan §7.2 (a rescued boundary without its own structural
  // evidence still fails validation).
  if (memPeaks.length > 0) {
    for (const p of peaks) {
      if (candidates.includes(p)) continue;
      if (p.starts >= MEMORY_MIN_PEAK_STARTS && p.ends <= p.starts * PEAK_END_RATIO
          && memPeaks.some(v => Math.abs(p.value - v) <= MEMORY_RESCUE_WIN)) {
        candidates.push(p);
      }
    }
  }
  if (candidates.length < 2) {
    // LAYOUT-FIX-13: no own candidates — still let the memory fallback
    // (below) hear the page before returning single.
  } else {
    candidates.sort((a, b) => a.value - b.value);
  }

  // 3. The leftmost candidate is the page's first column — no cut before it.
  const boundaries = candidates.length >= 2 ? candidates.slice(1).map(p => p.value) : [];

  // 4. Validate each boundary structurally; keep only passing ones.
  let valid = boundaries.filter(b => isColumnBoundary(b, rows, pageW));

  // 4.2 LAYOUT-FIX-13 (A2-fallback, 2026-09-18): the page's own validation
  //     found NO boundary, but the cross-page memory holds a confirmed layout
  //     for this document (≥2 earlier pages of the same page size). The F19
  //     class (try4 / book p61): a furniture page (running header, full-width
  //     figure caption, short/asymmetric column bodies) fails the full-page
  //     mutual-overlap gates even though its columns are REAL — the single-map
  //     fallback then bridges the gutter and fuses both columns into
  //     interleaved units (user report «cross-column overmerging»). The memory
  //     fallback re-validates each REMEMBERED boundary against THIS page's
  //     own ink under the three-part corroboration:
  //       (a) OWN START EVIDENCE — ≥ MEMORY_MIN_PEAK_STARTS items start within
  //           ±MEMORY_RESCUE_WIN of the boundary (the page's own Tm-anchored
  //           column starts; a 1-column opener / TOC has none → refused);
  //       (b) BRIDGE SYMPTOM — ≥ MEMORY_MIN_BRIDGE_ROWS left rows physically
  //           reach the cut while right-side text sits nearby: the page
  //           actually exhibits the fusion failure mode (cleanly separated
  //           pages — grading p1/p5, 2tier p1 — are refused);
  //       (c) REDUCED STRUCTURAL VALIDATION — isColumnBoundary(mode:’fallback’):
  //           mass / co-occurrence / wide rows / co-occurrence band /
  //           desert-gap straddle / gutter (furniture excluded) / clean text.
  //     A boundary passing all three becomes this page's cut; the A1 channel
  //     refinement, the region check (4.6) and the assignment (step 6) then
  //     run exactly as for an own-page detection. The memory never overrides
  //     an own-page detection (this block runs only when valid.length===0)
  //     and never relaxes a structural gate that a same-page candidate would
  //     have to pass — the full-page overlap gates are the ONLY exemption,
  //     replaced by the band+straddle pair (see isColumnBoundary).
  let memoryFallback = false;
  if (valid.length === 0) {
    const loose = lookupColumnMemoryLoose(pageW, pageH);
    if (loose && loose.boundaries.length > 0) {
      const corroborated: number[] = [];
      for (const b of loose.boundaries) {
        const p = peaks.find(pk => Math.abs(pk.value - b) <= MEMORY_RESCUE_WIN);
        if (!p || p.starts < MEMORY_MIN_PEAK_STARTS) continue;
        if (countBridgeRows(b, rows) < MEMORY_MIN_BRIDGE_ROWS) continue;
        if (!isColumnBoundary(b, rows, pageW, 'fallback')) continue;
        corroborated.push(b);
      }
      if (corroborated.length > 0) {
        valid = corroborated;
        memoryFallback = true;
      }
    }
  }
  // 4.3 LAYOUT-FIX-15 (preset 'two-columns', 2026-09-19): the user has
  //     ASSERTED the page has columns, but neither the page's own full
  //     validation (step 4) nor the cross-page memory fallback (4.2) found
  //     a cut. Re-run the candidate set under the REDUCED 'fallback'
  //     validation — the same gate set the memory fallback uses, minus the
  //     memory itself:
  //       • candidates: EVERY start-dominated peak with ≥ MEMORY_MIN_
  //         PEAK_STARTS (3) starts and the end-ratio filter — a thin right
  //         column (a short caption column beside a tall body, the book
  //         p61 Figure 2.13 case: 8 anchored starts) can sit below the
  //         normal MIN_PEAK_STARTS=6 floor;
  //       • the leftmost candidate is still the first column (boundaries =
  //         candidates.slice(1), exactly as step 3);
  //       • validation: isColumnBoundary(b, rows, pageW, 'fallback') — mass,
  //         co-occurrence band, wide rows, straddle, gutter (furniture-
  //         filtered pool), clean-text. The FULL-page mutual-overlap gates
  //         are the ONLY exemption: they are exactly the gates a furniture
  //         page (running header + full-width caption + asymmetric column
  //         bodies — the F19/F20 class) cannot pass even though its
  //         columns are real.
  //     The STRADDLE test remains the anti-damage guard in forced mode —
  //     a cut through atomic lines (TOC@333: level-1 entries end 42pt left
  //     of the indent peak) is refused REGARDLESS of the user's assertion,
  //     and the gutter gate keeps single-column indent peaks out (their
  //     left lines end hundreds of pt away from the cut). A refused forced
  //     cut degrades to the single-map path, never to a garbled slice.
  //     Forced cuts are NOT written to the cross-page memory (STEP 8 below)
  //     — a user's preset choice must not contaminate the auto-detection
  //     consensus if they switch back to 'standard'.
  let forcedDetection = false;
  if (valid.length === 0 && opts?.forceDetection === true) {
    const forcedCandidates = peaks
      .filter(p => p.starts >= MEMORY_MIN_PEAK_STARTS && p.ends <= p.starts * PEAK_END_RATIO)
      .sort((a, b) => a.value - b.value);
    const forcedBoundaries = forcedCandidates.length >= 2
      ? forcedCandidates.slice(1).map(p => p.value)
      : [];
    const corroborated = forcedBoundaries.filter(b => isColumnBoundary(b, rows, pageW, 'fallback'));
    if (corroborated.length > 0) {
      valid = corroborated;
      forcedDetection = true;
    }
  }
  if (valid.length === 0) return single;

  // 4.1 LAYOUT-FIX-10 (A1): whitespace-channel refinement — INK feeds
  //     only (a declared feed's overstated widths close the real gutters,
  //     so its channel intervals would lie; synthetic suites and the
  //     disableInkGeometry kill-switch path therefore keep the exact v23
  //     boundary values). The refined position is the ink-true COLUMN
  //     START (the channel's right edge) — corpus-inert by construction
  //     (the Tm-anchored peak already sits there), the D2 insurance for
  //     pages whose dominant peak misaligns RIGHT of the true start; the
  //     move is leftward-only and capped at CHANNEL_REFINE_MAX.
  let cuts0 = valid;
  if (inkFeed) {
    const intervals = computeChannelIntervals(rows);
    cuts0 = valid.map(b => refineBoundaryByChannel(b, intervals, rects));
  }

  // 4.5 LAYOUT-FIX: enforce minimum column width between kept boundaries —
  // adjacent candidate peaks can sit inside ONE column (its own indent
  // levels, e.g. TOC level-2/level-3 starts 333/342 on try.pdf p.1). A real
  // column is at least ~6% of the page wide; drops later peaks that are too
  // close to an already-kept one (the leftmost of a tight group wins — the
  // column's flush-left start, not its indents). The corpus showed 12% was
  // too wide: a table-cell peak can sit 47.9pt left of the TRUE text-column
  // boundary ("Feline Upper Respiratory" p8: cells start 259.6, text column
  // 307.5) and smother it. With a 6% separation both survive, and the region
  // check below drops the cell peak: the strip between them holds only
  // narrow table cells, a left-flow continuation. Indent levels 30-36pt from
  // the column flush are still rejected by the gutter gate (their "left
  // side" contains the rest of the line, ending far from the cut).
  const MIN_COL_SEP = Math.max(30, pageW * 0.06);
  const separated: number[] = [];
  for (const b of cuts0) {
    if (separated.length === 0 || b - separated[separated.length - 1] >= MIN_COL_SEP) {
      separated.push(b);
    }
  }
  let cuts = separated.length > 0 ? separated : cuts0;

  // 4.6 LAYOUT-FIX-2 (corpus-driven): every region between kept cuts must
  // itself look like a column — enough wide rows WITHIN the region. A cut
  // placed inside a table next to a text column creates a region of narrow
  // table cells ("Prognostic Significance" p5: [201.6..307.5] holds 83pt
  // cells); drop that cut's LEFT boundary, merging the fragment back into
  // the table region. Merging can only widen regions (wide-row counts can
  // only grow), so the loop terminates in ≤ cuts.length steps.
  for (let guard = 0; guard < 16 && cuts.length > 0; guard++) {
    const regionWide: number[] = [];
    const edges = [0, ...cuts];
    for (let i = 0; i < edges.length; i++) {
      const start = edges[i];
      const end = i < cuts.length ? cuts[i] : Infinity;
      let wide = 0;
      for (const row of rows) {
        let mn = Infinity, mx = -Infinity, has = false;
        for (const r of row.rects) {
          if (r.left >= start && r.left < end) {
            mn = Math.min(mn, r.left); mx = Math.max(mx, r.right); has = true;
          }
        }
        if (has && mx - mn >= pageW * MIN_ROW_WIDTH_FRAC) wide++;
      }
      regionWide.push(wide);
    }
    const failIdx = regionWide.findIndex(w => w < MIN_SHARED_ROWS);
    if (failIdx === -1) break;
    // Region i lies between edges[i] and (i < cuts.length ? cuts[i] : ∞).
    // Drop its LEFT boundary; for the first region that is cuts[0] itself,
    // for the last region it is the final cut.
    const dropIdx = failIdx === 0 ? 0 : (failIdx === cuts.length ? cuts.length - 1 : failIdx - 1);
    cuts = cuts.filter((_, idx) => idx !== dropIdx);
  }
  if (cuts.length === 0) return single;

  // 5. Match set: line-start values (peaks with enough starts, ANY ends
  //    ratio — an indented column start can sit in dense right-column
  //    traffic). Used for drift repair during assignment.
  const matchSet = peaks.filter(p => p.starts >= MATCH_SET_MIN_STARTS).map(p => p.value);
  // LAYOUT-FIX-10 (A2): remembered right-column starts join the match set
  // as SECOND anchors for non-anchored right starts on pages whose own
  // right column is too thin to confirm them (< MATCH_SET_MIN_STARTS).
  // Same ANCHOR_TOL as the own peaks — the plan §7.2 ±2pt window was
  // calibrated BEFORE the F3 sweep verdict (drifted left words sit at
  // 0.8–1.1pt from the anchor: «to»@301.1, «in»@323.2 — a ±2pt memory
  // window would re-open D1); see column-memory.ts for the deviation
  // note. Own peaks win ties; the memory only ADDS anchors.
  if (memPeaks.length > 0) {
    for (const v of memPeaks) {
      if (!matchSet.some(w => Math.abs(w - v) <= ANCHOR_TOL)) matchSet.push(v);
    }
  }

  // LAYOUT-FIX-9 (P4): is this an INK feed? The production entry points
  // clamp the feed's right edges to ink-based geometry (ink-geometry.ts)
  // and stamp `declRight` on every clamped rect. Synthetic/harness feeds
  // and the `disableInkGeometry` kill-switch path keep declared widths —
  // no declRight — and get the pre-FIX-9 drift repair unchanged (their
  // calibrated contracts depend on it). [Moved above step 2 in
  // LAYOUT-FIX-10 — the A1 refinement needs it before validation.]

  // 6. Assign each rect to a group. Rows are processed bottom-up; within a
  //    row items are ordered by start. True right-column items either START
  //    at a dominant line-start value (anchored) or follow their column's
  //    run without overlapping it. A drifted left-column word (accumulated
  //    pdfjs space-width error pushing it past the boundary) necessarily
  //    OVERLAPS the end of an earlier item — sequential words never overlap
  //    — and is returned to the left run. Per-group right-edge tracking
  //    keeps a stray from poisoning the chain for the words after it.
  //
  //    LAYOUT-FIX-9 (P4) — ink-adjacency of the IMMEDIATE predecessor:
  //    on an ink feed the decision no longer uses the declared group
  //    runRight (that is exactly the D1 mechanism: the left line's declared
  //    right edge 342 covers «Signaling»@333 while its ink ends at 314).
  //    Instead, a non-anchored item with base>0 continues the line of the
  //    item directly before it in the row iff the predecessor's ink edge
  //    reaches r.left − INK_ADJ_TOL:
  //      • queue 'tm' clamps — the left line's last word is clamped TO the
  //        right column's first item start, which would fake adjacency
  //        across the gutter, so such edges are re-capped at the validated
  //        boundary of the predecessor's group (the gutter is empty by
  //        construction of the validated cut — left ink never legitimately
  //        crosses its column's boundary);
  //      • DOM 'range' edges are true rendered ink — no cap (a genuinely
  //        wide line's ink may legitimately cross the boundary, and its
  //        sequential words must keep chaining);
  //      • unclamped predecessors keep their declared right edge: a
  //        declared edge can only mislead when it OVERRUNS r.left, and any
  //        overrun pair was clamped by the Tm channel, so the unclamped
  //        case degrades to the legacy permissiveness instead of lying.
  //    Non-adjacent ⇒ r starts its own cluster ⇒ stays in `base`. The
  //    declared runRight map is kept for tracking/debugging only.
  const groups: InputRect[][] = Array.from({ length: cuts.length + 1 }, () => []);
  // LAYOUT-FIX-18 (2026-09-19): single-word drift-tail repair, active only on
  // production feeds (opts.driftTailRepair — plumbed from buildParagraphs
  // under LayoutSettings.disableWordDriftRepair). Synthetic/harness callers
  // keep the pre-FIX assignment byte-for-byte.
  const driftRepair = opts?.driftTailRepair === true;
  for (const row of rows) {
    const items = [...row.rects].sort((a, b) => a.left - b.left);
    let prevGroup = -1;
    let prevRect: InputRect | null = null;
    let lastLower = -1; // highest group below the current base seen in this row
    const runRight = new Map<number, number>(); // group → right edge of its last item in this row (tracking only under P4)
    for (const r of items) {
      let base = 0;
      while (base < cuts.length && r.left >= cuts[base]) base++;
      if (prevGroup >= 0 && prevGroup < base) lastLower = prevGroup;
      let group = base;
      if (base > 0) {
        const anchored = matchSet.some(v => Math.abs(r.left - v) <= ANCHOR_TOL);
        if (!anchored) {
          if (inkFeed && prevRect && prevGroup >= 0 && prevGroup < base) {
            // P4 (LAYOUT-FIX-9): ink-adjacency of the direct predecessor.
            let prevInk = prevRect.right;
            if ((prevRect as any).inkSource === 'tm' || (prevRect as any).inkSource === 'range') {
              // Undo the Tm-clamp's cross-gutter fake adjacency: cap the
              // clamped edge at the predecessor's column boundary.
              // LAYOUT-FIX-11: 'range' capped identically — on the DOM path
              // the Range measurement is taken over a pdf.js-STRETCHED span
              // (scaleX to the declared item width), so a 'range' edge is
              // the overstated declared edge, not true ink: an uncapped
              // 'range' right re-opens D1 exactly where the 'tm' cap closed
              // it (measured: try3:p3 «neoplasms,» 341.6 covering
              // «Signaling»@333 — the cross-column merge the DOM path
              // showed on book page 22).
              prevInk = Math.min(prevInk, cuts[prevGroup]);
            }
            if (prevInk >= r.left - INK_ADJ_TOL) {
              // Ink adjacent/overlapping (gap ≤ INK_ADJ_TOL) — r continues
              // the predecessor's line ⇒ same group («to»@301.1 continues
              // the left line whose ink ends ≈300.5).
              group = prevGroup;
            } else if (
              // LAYOUT-FIX-18c (2026-09-19): crossing-tail continuation.
              // The P4 adjacency fails only because the PREDECESSOR's own
              // declared edge is drift-inflated across the cut (true left
              // ink never crosses a validated boundary — a crossing edge IS
              // the drift signature). A SHORT unanchored item right after
              // it, in the (INK_ADJ_TOL, CROSSING_TAIL_MAX_GAP] band, is the
              // line's drifted last word (try4 p3 «and»: predecessor
              // «fixation» declared [273.1, 300.9], true ink ends 266.8 —
              // the 13.5pt declared gap hid the 7.7pt true gap): return it
              // to the lower group AND re-seat its box left of the cut so
              // it chains back into its line's island instead of stranding
              // as a one-word island in the right column.
              driftRepair &&
              isCrossingTailContinuation(r, prevRect, items, cuts, base)
            ) {
              group = prevGroup;
              reseatCrossingTail(r, cuts[base - 1], prevRect);
            }
            // else: ink gap ≥ INK_ADJ_TOL — r starts a separate cluster
            // («Signaling»@333, 9pt past the boundary cap) ⇒ stays in base.
          } else {
            const ownRight = runRight.get(base) ?? -Infinity;
            let lowerRight = -Infinity;
            for (let g = 0; g < base; g++) {
              lowerRight = Math.max(lowerRight, runRight.get(g) ?? -Infinity);
            }
            // LAYOUT-FIX-18b (2026-09-19): the legacy demotion is now
            // reserved for items that actually REACH a lower group's run
            // (cross-boundary drift, the original D1 contract) or sit in
            // the boundary straddle zone. A same-group-only overlap DEEP
            // inside a column is the other failure mode: the VICTIM of a
            // drifted word stacked onto it (try4 p3 «thickness» under the
            // +14.7pt «full-») or a pdfjs split artifact («(Figur» vs
            // "e 2.17)." at −0.1pt) — demoting those to base−1 stranded
            // right-column words as islands inside the LEFT group
            // (try4 p3 u6 "e 2.17). thickness" at x=468–504, col=0).
            // They keep their base group; the overlap itself is repaired
            // upstream by the 18a feed shift.
            if (driftRepair) {
              const lowerOverlap = r.left < lowerRight - SAME_ROW_OVERLAP_EPS;
              const ownOverlap = r.left < ownRight - SAME_ROW_OVERLAP_EPS;
              const inStraddleZone = r.left - cuts[base - 1] <= DRIFT_STRADDLE_ZONE;
              if (lowerOverlap || (ownOverlap && inStraddleZone)) {
                group = prevGroup >= 0 && prevGroup < base ? prevGroup : (lastLower >= 0 ? lastLower : base - 1);
              }
            } else if (r.left < Math.max(ownRight, lowerRight)) {
              // Overlaps an earlier item of this row — physically impossible
              // for sequential words, signature of a drifted left stray.
              group = prevGroup >= 0 && prevGroup < base ? prevGroup : (lastLower >= 0 ? lastLower : base - 1);
            }
          }
        }
      }
      groups[group].push(r);
      runRight.set(group, Math.max(runRight.get(group) ?? -Infinity, r.right));
      prevGroup = group;
      prevRect = r;
    }
  }

  // Source runs retain information that x-sorting destroys: a drifted tail
  // can sort AFTER the neighbouring column's real line start. Only move a
  // short tail belonging to a multi-item source line anchored on the left.
  if (driftRepair) {
    const runs = new Map<number, InputRect[]>();
    for (const r of rects) if (r.sourceRun !== undefined) {
      const run=runs.get(r.sourceRun)||[]; run.push(r); runs.set(r.sourceRun,run);
    }
    for (const run of runs.values()) {
      if (run.length < 3) continue;
      const first=run[0];
      let owner=0; while(owner<cuts.length && first.left>=cuts[owner]) owner++;
      if (owner>=cuts.length || first.left>cuts[owner]-40) continue;
      for (let i=1;i<run.length;i++) {
        const r=run[i], prev=run[i-1];
        if (r.left<cuts[owner] || r.left>cuts[owner]+24 || r.right-r.left>60) continue;
        if ((r.text||'').trim().split(/\s+/).length>2 || Math.abs(r.bottom-first.bottom)>0.5) continue;
        const gap=r.left-(prev.declRight ?? prev.right);
        if (gap < -1 || gap > (r.fontsize || 10)*2) continue;
        const from=groups.findIndex(g=>g.includes(r));
        if (from<0 || from===owner) continue;
        groups[from].splice(groups[from].indexOf(r),1);
        groups[owner].push(r);
        r.spaceBefore = gap > 1;
        reseatCrossingTail(r,cuts[owner],prev);
      }
    }
  }
  // 7. Sanity: every group non-empty and all rects retained.
  const total = groups.reduce((s, g) => s + g.length, 0);
  if (total !== rects.length || groups.some(g => g.length === 0)) return single;

  // 8. LAYOUT-FIX-10 (A2): record this page's confirmed layout for the
  //    NEXT pages of the same signature. Only DETECTED pages write (a
  //    single-column page carries no column anchors — recording it would
  //    only occupy a signature slot). Boundaries are the A1-refined ink
  //    gutter positions — stable across pages of one type; rightPeaks are
  //    the dominant start values right of the first cut (the anchors the
  //    next thin page of this type can borrow). No-op without a file
  //    context / when killed. A divergent observation (> MEMORY_DIVERGENCE_TOL
  //    per slot against the active consensus) is a different layout that
  //    slipped the signature matching — it neither joins nor rewrites the
  //    record.
  //    LAYOUT-FIX-15: FORCED detections (preset 'two-columns') do not write
  //    — the auto-detection consensus must stay uncontaminated by the
  //    user's per-document assertions (switching back to 'standard' keeps
  //    behaving exactly as before the preset was ever used).
  if (!forcedDetection) {
    const rightPeaks = peaks
      .filter(p => p.starts >= MEMORY_MIN_PEAK_STARTS && p.value >= cuts[0])
      .sort((a, b) => b.starts - a.starts)
      .slice(0, 4)
      .map(p => p.value);
    observeColumnMemory(
      { pageW, pageH, medL, medR, medFs, cols: cuts.length + 1 },
      cuts, rightPeaks,
    );
  }

  return { detected: true, groups, boundaries: cuts, memoryFallback, forcedDetection };
}

/**
 * LAYOUT-FIX-18c helpers: the crossing-tail continuation test + box re-seat.
 *
 * The signature (all must hold):
 *   • r is SHORT — ≤ DRIFT_TAIL_MAX_WORDS words, ≤ DRIFT_TAIL_MAX_WIDTH pt
 *     (a drifted tail is one word, rarely two; legitimate right-column
 *     line starts are anchored, and their content is longer);
 *   • r is the LAST item of its row (a tail ends the line);
 *   • the predecessor's DECLARED right edge crosses the cut by ≥ −0.25pt —
 *     true left ink never crosses a validated boundary, so a crossing
 *     predecessor is itself drift-inflated (the whole failure mode);
 *   • the declared gap from the predecessor's edge is in
 *     (INK_ADJ_TOL, CROSSING_TAIL_MAX_GAP] — beyond P4's reach (the
 *     inflated edge pushed the apparent gap out), but far below a
 *     first-line indent.
 */
function isCrossingTailContinuation(
  r: InputRect,
  prevRect: InputRect,
  items: InputRect[],
  cuts: number[],
  base: number,
): boolean {
  if (items[items.length - 1] !== r) return false;
  const w = r.right - r.left;
  if (!(w > 0) || w > DRIFT_TAIL_MAX_WIDTH) return false;
  const t = String((r as any).text ?? '').trim();
  if (!t) return false;
  if (t.split(/\s+/).filter(Boolean).length > DRIFT_TAIL_MAX_WORDS) return false;
  if (!(prevRect.right >= cuts[base - 1] - 0.25)) return false;
  const gap = r.left - prevRect.right;
  if (!(gap > INK_ADJ_TOL && gap <= CROSSING_TAIL_MAX_GAP)) return false;
  return true;
}

/**
 * LAYOUT-FIX-18c: re-seat the returned tail's box left of the cut so it
 * chains back into its line's island (the occupancy grid co-occupies the
 * cells the inflated predecessor covers — chain guaranteed) instead of
 * stranding 14pt into the right column as a one-word island. The declared
 * geometry is stashed (`declLeft`/`declRight` + `inkSource:'tm'`) for the
 * DOM channel's restoreDeclaredRights — the same contract the 18a feed
 * shift and the width clamp use. Width is preserved unless the predecessor
 * blocks the full placement (then the width shrinks toward the cut, never
 * crossing it).
 */
function reseatCrossingTail(r: InputRect, cut: number, prevRect: InputRect): void {
  const w = r.right - r.left;
  if (!(w > 0)) return;
  let newLeft = Math.max(cut - 0.1 - w, prevRect.left + 0.5);
  let newRight = newLeft + w;
  if (newRight > cut - 0.05) newRight = cut - 0.1;
  if (newRight - newLeft < 0.5) return; // degenerate placement — keep declared box
  const a = r as any;
  if (typeof a.declLeft !== 'number') a.declLeft = r.left;
  if (typeof a.declRight !== 'number') a.declRight = r.right;
  a.inkSource = 'tm';
  r.left = newLeft;
  r.right = newRight;
}

/** Internal hooks for tests/debugging (not part of the public contract). */
export const __columnSlicerInternals = {
  computeStartPeaks,
  isColumnBoundary,
  isCrossingTailContinuation,
  reseatCrossingTail,
  DRIFT_TAIL_MAX_WIDTH,
  CROSSING_TAIL_MAX_GAP,
  DRIFT_STRADDLE_ZONE,
  groupIntoRows,
  countRowClusters,
  existsWithin,
  MIN_PEAK_STARTS,
  PEAK_END_RATIO,
  COOCCUR_WINDOW,
  TABLE_GAP,
  CLEAN_RUN_FRAC,
  // LAYOUT-FIX-7 (Task 33): exposed for the ANCHOR_TOL sweep experiment
  // (scripts/anchor-sweep-run.ts) — the F3 calibration of the drift-repair
  // tolerance against the D1 «Signaling»/«in»/«to» distance conflict.
  ANCHOR_TOL,
  // LAYOUT-FIX-9 (Task 35): exposed for the P4 unit suite (ink-adjacency
  // drift repair) — p9-ink-geometry.ts.
  INK_ADJ_TOL,
  // LAYOUT-FIX-10 (Task 36): exposed for the A1/A2 unit suite —
  // p10-column-memory.ts (channel refinement + memory rescue/anchors).
  computeChannelIntervals,
  refineBoundaryByChannel,
  medianInkEdges,
  CHANNEL_MIN_GAP,
  CHANNEL_REFINE_WIN,
  CHANNEL_REFINE_MAX,
  CHANNEL_REFINE_EPS,
  CHANNEL_MIN_SUPPORT,
  MEMORY_MIN_PEAK_STARTS,
  MEMORY_RESCUE_WIN,
  // LAYOUT-FIX-13: fallback internals — p13-column-fallback.ts suite.
  countBridgeRows,
  MEMORY_BRIDGE_TOL,
  MEMORY_MIN_BRIDGE_ROWS,
  FALLBACK_FULL_ROW_OVER,
};
