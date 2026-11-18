import { explicitGroups, isManualMode, type RegionLayoutRule } from './region-layout';
// IslandBuilder.ts
//
// Steps 5-8 of the pipeline:
//   5. Build islands (connected occupied zones, bounded by contours)
//   6. Merge islands whose occupied cells physically touch + same font
//   7. Split paragraphs by font family / size change
//   8. Split paragraphs by indentation
//
// Produces: final paragraphs (array of span arrays)
//
// Phase 4 (C1): removed all `process.env.DEBUG_SF` and
// `process.env.DEBUG_MERGE` gated console.error/console.log calls.
// These were debug-only code paths that read Node-only `process.env`
// at runtime — they have no place in production and were a load-time
// hazard on Obsidian Mobile. The merge / split algorithms themselves
// are unchanged.

// Stage 0.2 (Q8): removed `@ts-nocheck`. The internal `id` and `_merged`
// fields are now declared on the Paragraph interface so the rest of the
// file type-checks cleanly. They're optional because they're only
// populated during the merge passes and are not part of the public
// contract.

import { buildOccupancyMap, OccupancyMapResult, getFontFamily, InputRect } from './OccupancyMap';
// LAYOUT-FIX (2026-09-14): input slicing by detected columns — see column-slicer.ts.
import { sliceRectsByColumns, ColumnSlice } from './column-slicer';
import { setColumnMemoryEnabled } from './column-memory';
// LAYOUT-FIX-3 (2026-09-16): TABLE-KEEP compatibility guard for STEP 8.7 —
// see the table-likeness check in absorbContainedFragments.
import { isTableLikeRowTexts, TABLE_KEEP_MAX_WORDS_PER_ROW } from './table-keep';
import { detectTableRegions } from './table-regions';

export interface Paragraph {
  pxLeft: number;
  pxTop: number;
  pxRight: number;
  pxBottom: number;
  width: number;
  height: number;
  spans: InputRect[];
  dominantFamily: string;
  dominantSize: number;
  // Stage 0.2 (Q8): internal fields used by the merge passes. Declared
  // optional so callers don't need to provide them, but the builder
  // populates them and the merge functions read them back.
  /** Unique island id assigned during Step 5 (island BFS). */
  id?: string;
  /** Flag set during merge passes to prevent double-merging. */
  _merged?: boolean;
  /**
   * LAYOUT-FIX-8 (A3-lite, 2026-09-17): index of the column-slicer group
   * the paragraph was BUILT in (multi-column pages only; undefined for
   * the single-map legacy path and for global/wide elements). Structural
   * same-column insurance for the 8.65 attach — see the columnId gate in
   * fixTocEntries Pass 1. Not part of the public contract; downstream
   * steps (8.7/8.8/9.5/9) re-derive grouping from geometry.
   */
  columnId?: number;
  tableId?: string;
  tableRow?: number;
  tableColumn?: number;
}

export interface ContourSettings {
  /** Pixel threshold for considering a line indented (default 5). */
  indentThreshold?: number;
  /**
   * LAYOUT-FIX-3 (2026-09-16): when true, disables STEP 8.7 (absorption of
   * small fragments whose bbox lies inside a larger paragraph's bbox).
   * Kill-switch restoring the pre-LAYOUT-FIX-3 behavior byte-for-byte.
   * Default false (enabled). See absorbContainedFragments below.
   */
  disableFragmentAbsorption?: boolean;
  /**
   * LAYOUT-FIX-3 (2026-09-16): when true, disables STEP 8.8 (merging of
   * sparse figure-label bands into single units). Kill-switch restoring
   * the pre-LAYOUT-FIX-3 behavior byte-for-byte. Default false (enabled).
   * See mergeFigureLabelBands below.
   */
  disableFigureBandMerge?: boolean;
  /**
   * LAYOUT-FIX-6 (2026-09-16): when true, disables the style-flow gates
   * (STEP 7.7 splitByStyleFlow + the flow-continuity requirement for
   * style-variant merges in STEP 6 / 8.5). Kill-switch restoring the
   * pre-LAYOUT-FIX-6 (i.e. pure LAYOUT-FIX-5) behavior byte-for-byte.
   * Default false (enabled). See the LAYOUT-FIX-6 block comment above.
   */
  disableStyleFlowGuard?: boolean;
  /**
   * LAYOUT-FIX-6 (2026-09-16): when true, disables STEP 8.65 (TOC repair:
   * companion page-number attachment + entry splitting). Kill-switch
   * restoring the pre-LAYOUT-FIX-6 behavior byte-for-byte.
   * Default false (enabled). See fixTocEntries below.
   */
  disableTocRepair?: boolean;
  /**
   * LAYOUT-FIX-11 (2026-09-17): when true, disables STEP 8.62 (split of
   * standalone larger-font heading lines from the body text below).
   * Kill-switch restoring the pre-LAYOUT-FIX-11 behavior byte-for-byte.
   * Default false (enabled). See splitByStandaloneHeading below.
   */
  disableHeadingSplit?: boolean;
  /**
   * LAYOUT-FIX-8 (2026-09-17): when true, disables STEP 9.5 (post-validator
   * that splits a paragraph built from NON-ADJACENT span groups back into
   * per-component units). Kill-switch restoring the pre-LAYOUT-FIX-8 (i.e.
   * pure LAYOUT-FIX-7) behavior byte-for-byte. Default false (enabled).
   * See splitNonAdjacentComponents below.
   */
  disableNonAdjacentSplit?: boolean;
  /**
   * LAYOUT-FIX-10 (2026-09-17): when true, disables the cross-page column
   * memory (A2: candidate rescue + remembered assignment anchors; A1's
   * whitespace-channel refinement is INK-gated, not memory-gated — it
   * rolls back via disableInkGeometry / disableColumnSlicing). Kill-switch
   * restoring the pre-LAYOUT-FIX-10 behavior byte-for-byte on memory-fed
   * pages. Default false (enabled). See column-memory.ts.
   */
  disableColumnMemory?: boolean;
  /**
   * LAYOUT-FIX-13 (2026-09-18): when true, disables STEP 9.6 (re-attachment
   * of small fragments TORN OUT of a body paragraph — a 2-line block that
   * ends mid-sentence directly above a same-column, same-size block that
   * continues it with a lowercase word). Kill-switch restoring the
   * pre-LAYOUT-FIX-13 behavior byte-for-byte. Default false (enabled).
   * See reattachTornFragments below.
   */
  disableFragmentReattach?: boolean;
  /**
   * LAYOUT-FIX-14 (2026-09-18): when true, disables the font-homogeneity
   * rules — STEP 7.3 (splitBySizeClass: partition of a unit whose lines
   * carry ≥2 font SIZE classes / ≥2 base families into per-class units),
   * the size-class gates in STEP 8.5/8.7 (re-merge and absorption now
   * require the same size class, with the caption-label exception), the
   * serif↔sans-serif incompatibility for CSS-generic families in 8.7, and
   * the plural caption-prefix forms (figures/tables/…) in the flow gates.
   * Kill-switch restoring the pre-LAYOUT-FIX-14 behavior byte-for-byte.
   * Default false (enabled).
   */
  disableFontClassSplit?: boolean;
  /**
   * LAYOUT-FIX-15 (2026-09-19): user-facing layout PRESET. Four modes:
   *
   *   'standard'    — the auto-detection pipeline as-is (default; unset
   *                   behaves identically — the flag is absent from the
   *                   settings hash and caches stay valid).
   *   'paragraphs'  — "one column": disableColumnSlicing is forced (the
   *                   slicer never cuts, single occupancy map, full-width
   *                   paragraphs). For documents that ARE single-column;
   *                   applying it to a two-column page reproduces the F19
   *                   interleaving (documented, user's responsibility).
   *   'two-columns' — "columns exist": the slicer's own full validation
   *                   failing no longer ends detection — every start-peak
   *                   candidate is re-validated under the reduced 'fallback'
   *                   gate set (sliceRectsByColumns STEP 4.3). For the
   *                   F19/F20 furniture-page class where auto fails.
   *   'separate'    — "keep table blocks separate": the reading order
   *                   becomes row-major (no column buckets) and STEP 9.7
   *                   (splitByHangingGroups, preset-scoped) cuts the
   *                   vertical chains of table row labels at
   *                   flush-after-indented-run boundaries. The intra-block
   *                   repair passes (8.65/8.7/8.8/9.6) stay ON — they
   *                   re-unite TORN fragments of one block and never
   *                   merge separate table cells (containment/touch
   *                   geometry cannot span cell padding).
   *
   * Resolution happens HERE (single place, shared by the queue and DOM
   * paths — no drift).
   */
  layoutPreset?: 'standard' | 'paragraphs' | 'two-columns' | 'separate' | import('./region-layout').ManualLayoutMode;
  activeRegions?: RegionLayoutRule[];
  regionPageWidth?: number;
  regionPageHeight?: number;
  /**
   * LAYOUT-FIX-16 (2026-09-19): when true, disables the post-loop caption
   * subtraction — the SECOND-pass rebuild of the body layout after the
   * first pass's caption units are removed from the feed. Kill-switch
   * restoring the pre-LAYOUT-FIX-16 behavior byte-for-byte. Default false
   * (enabled). See the LAYOUT-FIX-16 block in buildParagraphs below.
   */
  disableCaptionSubtractLoop?: boolean;
  /**
   * LAYOUT-FIX-18 (2026-09-19): when true, disables the single-word
   * drift-tail repair — the re-seating of justified-line last words whose
   * declared pdf.js boxes were pushed across the column gutter by the
   * cumulative word-spacing error (18a feed shift in ink-geometry + the
   * 18b/18c slicer gates). Kill-switch restoring the pre-FIX-18 behavior
   * byte-for-byte. Default false (enabled) on BOTH paths. The repairs are
   * physical-invariant driven (same-baseline overlap / crossing declared
   * edge): a page without the drift pathology triggers none of them.
   */
  disableWordDriftRepair?: boolean;
  /**
   * LAYOUT-FIX-22 (2026-09-25): when true, disables STEP 6.9 (the
   * same-baseline single-line bridge — merging the word-fragments of one
   * visual line whose inter-word gaps ≥ cellSize keep them apart in the
   * occupancy grid, so a heading / justified tail / caption label line
   * comes out as several one-word units). Kill-switch restoring the
   * pre-FIX-22 behavior byte-for-byte. Default false (enabled); the
   * 'separate' preset disables it by design (row-major table semantics).
   */
  disableSingleLineBridge?: boolean;
  /**
   * LAYOUT-FIX-23 (2026-09-29): when true, disables STEP 9.65 (the caption
   * chain assembly — merging the continuation lines of a figure/table
   * caption into the caption-start unit when the STEP 6 merge could not
   * see them as one family: a bold marker span «Fig. 1.» on the first
   * line shifts that line's primary family (tie → first-occurrence), so
   * the marker line and the body lines land in different units).
   * Kill-switch restoring the pre-FIX-23 behavior byte-for-byte. Default
   * false (enabled); the 'separate' preset disables it by design (row-major
   * table semantics — same as the STEP 6.9 bridge).
   */
  disableCaptionAssembly?: boolean;
  /**
   * LAYOUT-FIX-10 (A1, internal plumbing — NOT a user setting): the feed
   * carries ink-true right edges. Set by the PRODUCTION entry points
   * (queue Tm-clamp / DOM Range) whenever the ink channel is active —
   * including pages where no rect needed a clamp (zero declRight stamps:
   * the declared widths never overlapped the next starts, so the feed is
   * ink-faithful and the whitespace-channel refinement is legitimate
   * there too). Synthetic/harness feeds never set it: their calibrated
   * contracts assert the exact peak-position boundaries (v23 semantics).
   */
  inkChannelFeed?: boolean;
  /** Tolerance in font size points for "same font" merging (default 1). */
  fontSizeTolerance?: number;
  /** Maximum merge passes (default 10). */
  maxMergePasses?: number;
  /**
   * Stage 2.1 (Q5): when true, preserve bold/italic distinction in font
   * family resolution. Bold and Italic variants of the same family are
   * treated as DIFFERENT families — `splitByFont` will split paragraphs
   * at bold/italic boundaries.
   *
   * Default: false (legacy behavior — strip weight/style suffix, treat
   * Bold/Italic as same family).
   *
   * The pdfjs path sets this to `true` so that the cache it writes is
   * consistent with what the DOM path produces on cache miss (DOM path
   * preserves bold/italic distinction via g_d0_fN IDs which are unique
   * per variant).
   */
  preserveStyle?: boolean;
  /**
   * Stage 2.2 (Q6): column gap threshold in pixels. Vertical jumps
   * larger than this are treated as column boundaries in applyColumnOrder.
   * Default 50.
   */
  columnGapThreshold?: number;
  /**
   * Stage 2.2 (Q6): decoration detection threshold. Spans with font size
   * < this fraction of the line's median size are treated as decorations
   * (superscripts, footnote refs) and don't trigger paragraph splits.
   * Default 0.7 (70%).
   */
  decorationThreshold?: number;
  /**
   * LAYOUT-FIX (2026-09-14): when true, disables column detection + input
   * slicing entirely (legacy single-map pipeline). Kill-switch in case a
   * document mis-detects columns; default false. See column-slicer.ts.
   */
  disableColumnSlicing?: boolean;
}

const DEFAULT_INDENT_THRESHOLD = 5;
const DEFAULT_FONT_SIZE_TOLERANCE = 1;
const DEFAULT_MAX_MERGE_PASSES = 10;
// Stage 2.2 (Q6): defaults for the new exposed settings.
const DEFAULT_COLUMN_GAP_THRESHOLD = 50;
const DEFAULT_DECORATION_THRESHOLD = 0.7;

// ════════════════════════════════════════════════════════════════════
// LAYOUT-FIX-3 (2026-09-16): oversplit micro-fragments + figure labels.
// ════════════════════════════════════════════════════════════════════
//
// PROBLEM (calibrated on try.pdf p3/p4/p5 — excerpts of the "Tumors in
// Domestic Animals" 2026 book; p5 is a twin of the user's page 20):
//
//   (a) CONTAINED FRAGMENTS. A word gap ≥ 1 grid cell at a font/style
//       transition (italic "et al.", italic journal names, superscript
//       citation numbers) isolates a 1-2 line run into its own island.
//       The Step 6 / Step 8.5 merge rules (physical touch + same primary
//       family) then NEVER merge it back: the cells don't touch, and the
//       family differs. The fragment survives as a standalone translation
//       unit whose bbox lies INSIDE the bbox of the big paragraph it
//       belongs to — try.pdf p5: 18 such fragments inside the right-column
//       references block ("et", ". (2020) Genome-wide DNA methylation",
//       "15:1014–", "Vet", "l", "BMC Cancer", "Garnett, L., Malho, P.,",
//       ...). In the user's translated markdown they surface as a garbage
//       tail at the end of the page, each fragment translated separately.
//       BBOX-FIT-2 (overlay-ui) already papered over the RENDERING
//       conflict of exactly this pattern ("IslandBuilder иногда оставляет
//       строку-фрагмент ОТДЕЛЬНЫМ юнитом, чей бокс лежит ВНУТРИ бокса
//       большого абзаца") — but only at draw time; the logical oversplit
//       (separate units, separate API calls, broken reading order)
//       remained.
//
//   (b) FIGURE LABELS. Labels floating in a figure's whitespace
//       ("Oncogene-induced senescence", "Normal mucosa", "Hyper-
//       proliferation", "Adenoma", "Carcinoma", "Benign", "Malignant")
//       never touch anything — every label becomes its own micro-unit
//       (7 separate translation calls on a single figure).
//
// FIX — two paragraph-level post-passes (span coordinates are NEVER
// modified, so overlay geometry, DOM-path span matching and the text
// multiset are unaffected):
//
//   STEP 8.7 absorbContainedFragments — a ≤2-line / ≤8-span paragraph
//       whose bbox is ≥80% inside the bbox of a ≥3-line paragraph with a
//       compatible median size (±fontSizeTolerance) is a geometric
//       FRAGMENT of that block and is absorbed into it. Font FAMILY is
//       deliberately NOT checked: the disease IS the italic/roman family
//       split — an inline citation is a decoration of the sentence it
//       sits in (same reasoning as the Step 6 "decoration" spans).
//       Side-by-side layouts (columns, table cells) can never trigger a
//       false absorption: ≥80% containment requires the fragment's whole
//       y-range inside the container's interior, which disjoint
//       neighbours never satisfy; intentional splits (Step 7/7.5/8/8.6)
//       always cut along line boundaries, so their pieces stack
//       vertically and never contain each other either.
//
//   STEP 8.8 mergeFigureLabelBands — a chain of ≥3 narrow (≤20% page
//       width), short (≤4 lines, ≤50px) blocks with ≤25% ink density and
//       no large block in between is figure-label scatter and is merged
//       into one unit in reading order. Dense grids (table cells,
//       measured 37-75% density on the corpus) are rejected by the
//       density gate — TABLE-KEEP's per-cell structure survives. When
//       column boundaries are known, a cluster that would be WIDE under
//       applyColumnOrder's rule (crossing a boundary by > WIDE_MARGIN on
//       both sides) is merged only when it lies entirely OUTSIDE the
//       column region (above/below it) — exactly the cases where
//       applyColumnOrder's y-first header/footer classification keeps the
//       merged unit in its correct reading position. A wide cluster
//       INSIDE the column region is left untouched: its labels keep their
//       per-column bucket positions (merging would jump them to the
//       header bucket and break reading order).
//
// Kill-switches (ContourSettings.disableFragmentAbsorption /
// disableFigureBandMerge) restore the pre-LAYOUT-FIX-3 output
// byte-for-byte — verified continuously by p6-layout-columns B1.

/** STEP 8.7: max lines in a fragment candidate.
 * LAYOUT-FIX-4 (2026-09-16): 2 → 3. A third failure class surfaced on the
 * real DOM textLayer (try.pdf p5 @ scale 1.0): the pipeline leaves
 * "line-scrap" paragraphs — 2-3 short lines of reference tails chained
 * vertically at a column's ragged edge ("et . (2008) Microrna expression
 * in / 19:561– / et", 100% contained in the references block, 4 spans).
 * They are small by EVERY other metric (spans, area, containment), so the
 * line cap was the only rejecting rule — and it rejected a real fragment.
 * 4-line scraps were never observed; the cap stays at 3. */
const FRAGMENT_MAX_LINES = 3;
/** STEP 8.7: max spans in a fragment candidate. */
const FRAGMENT_MAX_SPANS = 8;
/** STEP 8.7: a container must have at least this many lines (fragments
 *  and 1-2 line labels can never act as containers). */
const FRAGMENT_CONTAINER_MIN_LINES = 3;
/** STEP 8.7: container area ≥ FRAGMENT_AREA_RATIO × fragment area
 *  (mirror of BBOX-FIT-2's SRC_CONTAIN_AREA_FRAC = 0.55 fragment rule). */
const FRAGMENT_AREA_RATIO = 1.8;
/** STEP 8.7: ≥ this fraction of the fragment's area must be inside the
 *  container (mirror of BBOX-FIT-2's containment tolerance). */
const FRAGMENT_CONTAIN_FRAC = 0.8;
/** STEP 8.7: reject only drop-cap-scale size mismatches — a fragment
 *  whose median size exceeds this multiple of the container's is NOT an
 *  inline fragment. Everything smaller (or slightly larger) absorbs:
 *  pdfjs reports inflated heights for italic / superscript runs (the
 *  buildInputRects fallback substitutes the BASELINE MEDIAN height when
 *  item.height ≤ 0 — try.pdf p5: italic "et" measured 12pt inside a 7pt
 *  references block, superscript "207" 12pt inside 7.47pt), so an exact
 *  ±fontSizeTolerance match is impossible to require. The containment
 *  geometry (y-interior of the container) is the primary safety signal;
 *  the 2.2× cap only excludes drop-cap-scale elements, mirroring the
 *  Step 8.5 drop-cap ratio (2.5×) with margin. */
const FRAGMENT_SIZE_MAX_RATIO = 2.2;
/** STEP 8.7: max absorption passes (a grown container can qualify for
 *  further fragments; bounded to keep the pass cheap). */
const FRAGMENT_MAX_PASSES = 4;

/** STEP 8.8: max lines in a band block. */
const BAND_SMALL_MAX_LINES = 4;
/** STEP 8.8: max spans in a band block. */
const BAND_SMALL_MAX_SPANS = 8;
/** STEP 8.8: max height of a band block (px). */
const BAND_SMALL_MAX_H = 50;
/** STEP 8.8: min blocks in a band to merge. */
const BAND_MIN_BLOCKS = 3;
/** STEP 8.8: max vertical gap between chained band blocks. */
const BAND_MAX_GAP_PAGE_FRAC = 0.15;
/** STEP 8.8: max ink density (total block area / band bbox area). */
const BAND_DENSITY_MAX = 0.25;
/** STEP 8.8: max width of a band block (fraction of page width). */
const BAND_SMALL_MAX_W_FRAC = 0.2;
/** STEP 8.8: a large block breaks a forming band only when it overlaps
 *  the band's x-range by more than this fraction of the band's width
 *  (a neighbouring column's text must not break this band). */
const BAND_BREAK_OVERLAP_FRAC = 0.2;

/** STEP 8.62: a line's decoration-aware median size must exceed the unit's
 *  body size (mode of line medians) by at least this much (pt) to count as
 *  a standalone heading line. Bold subheads of the calibration corpus
 *  measure +0.71..+0.76pt (MinionPro Semibold 9.75–9.8 vs body 9.04, both
 *  pdf.js item.height and DOM computed font-size); inline emphasis, Lt/LtIt
 *  footnote alternations and superscript decorations all sit within ±0.3.
 *  0.35 splits the gap with margin on both sides. */
const HEADING_SIZE_DELTA = 0.35;
/** STEP 8.62: a line counts as body when its median size is within this
 *  much (pt) of the unit's body size. */
const HEADING_BODY_EPS = 0.15;

// ════════════════════════════════════════════════════════════════════
// LAYOUT-FIX-6 (2026-09-16): style-flow gates + TOC repair
// ════════════════════════════════════════════════════════════════════
//
// PROBLEM (user report, book «Tumors in Domestic Animals» image pages +
// table of contents): LAYOUT-FIX-5 made the whole pipeline style-blind
// (preserveStyle:false everywhere), which fixed the italic mid-paragraph
// oversplitting — but the style barrier had been DOING DOUBLE DUTY as the
// only chain-breaker on dense same-base-family pages:
//   • image pages: body text (MinionPro-Regular) + captions
//     (MinionPro-It, 8pt) physically touch at 4pt-cell granularity (book
//     leading ≈ 10.96pt, glyph height ≈ 8-10.5pt → consecutive rows of
//     occupied cells are 4-adjacent) → ONE geometric island → after FIX-5
//     one UNIT containing caption+body chains around every figure;
//   • table of contents: entries (incl. MinionPro-It sub-entries) all
//     touch → one giant unit per column; page-number islands get banded
//     (STEP 8.8) or absorbed (STEP 8.7) separately;
//   • STEP 8.7 absorbed non-touching fragments (labels inside figure
//     bboxes, TOC numbers) — violating the user's core invariant
//     «НЕ СЛИВАТЬ НЕСОПРИКАСАЮЩИЕСЯ ISLANDS».
//
// FIX — four coordinated rules (kill-switches: disableStyleFlowGuard /
// disableTocRepair restore pre-FIX-6 behavior):
//   STEP 7.7  splitByStyleFlow — within a unit, a style-run boundary
//             (full font name changes between consecutive line runs)
//             SPLITS the unit unless there is positive evidence of
//             sentence-flow continuity (tight line-pitch gap, same
//             column/size, previous run's last line ends mid-sentence,
//             neither run starts with a Figure/Table caption pattern).
//             → italic mid-paragraph (p.11: «evi-/dence») stays MERGED
//             (flow evidence present), captions/labels split OFF.
//   STEP 6/8.5 gates — merging two islands whose primary full fonts are
//             style variants of one base family now requires the same
//             flow continuity (defense in depth for multi-island chains).
//   STEP 8.65 fixTocEntries — attaches trailing same-line page-number
//             islands to their entry unit, then splits TOC-like units
//             after every page-number-ending line (one unit per entry).
//   STEP 8.7  fragment absorption additionally requires base-family
//             compatibility AND physical cell adjacency (ink cells,
//             4-neighbour) — non-touching islands never absorb.
//   STEP 8.8  band members must share base family and compatible size.

/** Flow gap tolerance: boundary gap must be ≤ this multiple of the line
 * pitch (1.35 × max font size) to count as continuous flow. */
const FLOW_GAP_PITCH_MULT = 1.35;
/** Flow size tolerance: |medianSize(a) − medianSize(b)| must be ≤ this
 * (pt) for style-variant merging (captions are typically 2.5pt smaller
 * than body; footnote Lt/LtIt alternations are same-size → pass). */
const FLOW_SIZE_TOLERANCE = 2.0;
// ═══ LAYOUT-FIX-14 (2026-09-18): font-homogeneity grouping ═══
// User report: «плагин проводил слияние параграфов, которые а) имеют разные
// размеры б) принадлежат разным семействам шрифтов. Этого НЕ должно быть;
// текст, за возможным исключением вроде Fig, Figure, Table и таких вариаций,
// должен группироваться в том числе по размеру/семействам шрифтов».
// Calibrated class separations of the book corpus: body 9.03/9.04 (Δ0.01,
// one class), bold subheads 9.79 (Δ0.75 — split, consistent with STEP 8.62's
// HEADING_SIZE_DELTA=0.35), captions 8.02 (Δ1.01), sans figure labels 7.02
// (Δ2.01), footnotes 5.26 (Δ3.77). Intra-class noise (italic/superscript
// inflation, 9.25 drop-cap lines vs 9.04) stays ≤0.3. 0.5 splits the gap.
const SIZE_CLASS_TOL = 0.5;
/** A visual row is split into x-clusters at gaps ≥ this many pt — two
 * columns' texts on one interleaved row (slicer failure) get separate
 * size/family classes. Justified word gaps in this corpus measure ≤ ~12pt;
 * column gutters 32–43pt; TOC dot-leader gaps land in the SAME class as
 * their entry text (same font), so the split never severs them. */
const X_CLUSTER_GAP = 18;
/** Caption prefix pattern — a run whose FIRST line starts with one of
 * these is a figure/table caption and NEVER flow-merges with neighbours.
 * LAYOUT-FIX-14: plural forms added (grading p5 "Figures 1–6…" is a
 * legitimate caption start). Pre-14 set restored by disableFontClassSplit. */
const CAPTION_START_RE =
  /^(figure|figures|fig|figs|fig\.|table|tables|box|boxes|scheme|plate|chart|рис\.?|табл\.?|схема|рисунок|рисунки)\b/i;
const CAPTION_START_RE_PRE14 =
  /^(figure|fig|fig\.|table|box|scheme|plate|chart|рис\.?|табл\.?|схема|рисунок)\b/i;
/** Caption-label test honouring the kill-switch (pre-14 pattern when
 * disabled — the byte-for-byte restore contract). */
function isCaptionStartText(text: string): boolean {
  return (_disableFontClassSplit ? CAPTION_START_RE_PRE14 : CAPTION_START_RE).test(text);
}
/** CSS-generic families (DOM path): serif vs sans-serif IS reliable
 * family information — unlike g_d0_fN ids and 'unknown', which encode
 * nothing comparable. */
const GENERIC_FAMILY_RE = /^(serif|sans-serif|monospace)$/i;
/** Caption-label unit: a TINY unit whose first visible text starts with a
 * caption prefix (the «Fig, Figure, Table» exception — a label LINE may
 * sit in a different size/family than the caption text it belongs to).
 * STRICT caps: (a) ≤4 spans, (b) ≤CAPTION_LABEL_MAX_WORDS words — a full
 * caption block whose first line happens to start with «Figure …» is NOT
 * a label; treating it as one re-opens the caption↔body merge that STEP
 * 7.3 just closed (8.5 re-merged both the p61 body+caption pair and the
 * synthetic 2-span caption block at |Δ|=1.01 ≤ 2.0 until these caps). */
const CAPTION_LABEL_MAX_WORDS = 6;
function isCaptionLabelParagraph(p: Paragraph): boolean {
  if (p.spans.length > 4) return false;
  const rows = visualRows(p);
  for (const row of rows) {
    const t = row.spans.map(s => (s as any).text || '').join('').trim();
    if (t) {
      if (!isCaptionStartText(t)) return false;
      return t.split(/\s+/).filter(Boolean).length <= CAPTION_LABEL_MAX_WORDS;
    }
  }
  return false;
}
/** TOC page-number ending — RESERVED for future text-level TOC heuristics;
 * STEP 8.65 currently uses span-level companion detection instead
 * (attachedSpans / TOC_NUM_NATIVE_GAP), which is robust against inline
 * trailing digits in references and statistical tables. */
const PAGE_NUM_END_RE = /(?:[.…·•\s]|\))?\s*\d{1,4}\s*[.)]?$/;
/** TOC-likeness: at least this many lines and this fraction of them
 * ending with a page number for a unit to be treated as a TOC block.
 * 2 (not 3): entry chains can arrive in PAIRS (Reg-run + style-flow
 * merges) — a 2-line unit with both lines ending in companion numbers
 * must still split; single non-digit lines never split alone. */
const TOC_MIN_LINES = 2;
const TOC_MIN_FRAC = 0.5;
/** Companion page-number island: max span count / width / size delta. */
const TOC_NUM_MAX_SPANS = 2;
const TOC_NUM_MAX_W = 48;
const TOC_NUM_SIZE_TOL = 1.6;
/** Companion page-number island: max horizontal gap to the entry line's
 * ink end (pt floor + fraction of page width — dot leaders can be long). */
const TOC_NUM_GAP_MIN = 90;
/** Native (non-attached) trailing digits-only span must sit at least this
 * many pt from the line's preceding ink to count as a TOC page number
 * (calibrated on try.pdf p1: real companion gap ≈ 9pt; contiguous inline
 * digits in references / statistical tables have gaps ≤ ~3pt). */
const TOC_NUM_NATIVE_GAP = 6;
/** Minimum ink gap for companion-number ATTACHMENT (pass 1). Table cells
 * pad digits 2-5pt from the neighbouring cell's text (observed on
 * Clinicopathological p4, Table 2: outcome scores 3pt right of the
 * treatment cell — gluing them produced "…oral gel, 2" units); real TOC
 * page numbers sit ≥ 7pt from their entry (try.pdf p1: 9pt, no leaders).
 * Below this gap the digit is treated as a table cell, not a TOC number. */
const TOC_NUM_ATTACH_MIN_GAP = 7;
/** TABLE-ROW GUARD: another digits-only unit this close (pt, horizontal,
 * same text row) marks a table digit COLUMN — statistical tables stack
 * score columns 20-30pt apart; TOC page numbers are ≥ 100pt from the
 * nearest neighbouring number (next column). */
const TOC_NUM_ROW_MATE_GAP = 40;

/** Full font name: strip the subset prefix (ABCDEF+), KEEP the style
 * suffix. "SDHTAN+MinionPro-It" → "MinionPro-It". */
function fullFontName(fontname: string | undefined): string {
  if (!fontname) return 'unknown';
  if (/^g_d\d+_f\d+$/.test(fontname)) return fontname; // DOM path ids
  return fontname.includes('+') ? fontname.split('+')[1] : fontname;
}

/** Are two full font names style variants of one base family?
 * ("MinionPro-Regular" vs "MinionPro-It" → true; "MinionPro" vs
 * "FrutigerLTStd-Light" → false.) */
function isStyleVariantPair(aFull: string, bFull: string): boolean {
  if (aFull === bFull) return false;
  const aBase = getFontFamily(aFull, false);
  const bBase = getFontFamily(bFull, false);
  return aBase !== '' && aBase === bBase;
}

/** Median font size of a span collection (decoration-agnostic). */
function medianFontSize(spans: InputRect[]): number {
  const sizes = spans
    .map(s => (Number.isFinite(s.fontsize) ? s.fontsize! : 10))
    .sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
}

/** Line text: concatenation of the line's span texts, trimmed. */
function lineTextOf(line: InputRect[]): string {
  return line.map(s => (s as any).text || '').join('').trim();
}

/**
 * Decoration-aware majority FULL font name of a paragraph.
 * Mirrors getPrimaryFamily but keeps the style suffix.
 */
function primaryFullFontName(para: Paragraph): string {
  const spans = para.spans as any[];
  if (spans.length === 0) return 'unknown';
  const sizes = spans.map(s => (Number.isFinite(s.fontsize) ? s.fontsize! : 10)).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const decorationThreshold = median * _decorationThreshold;
  const counts: Record<string, number> = {};
  let first = '';
  for (const s of spans) {
    if ((Number.isFinite(s.fontsize) ? s.fontsize! : 10) < decorationThreshold) continue;
    const f = fullFontName(s.fontname);
    if (!first) first = f;
    counts[f] = (counts[f] || 0) + 1;
  }
  let best = first || 'unknown';
  let bestCount = 0;
  for (const [f, c] of Object.entries(counts)) {
    if (c > bestCount || (c === bestCount && f === first)) { bestCount = c; best = f; }
  }
  return best;
}

/** Does a LINE end with a TOC-style companion page number — a
 * digits-only TRAILING span separated from the line's text ink by a real
 * gap (≥ TOC_NUM_NATIVE_GAP)? Inline trailing digits (reference page
 * ranges, footnote superscripts, statistical-table cells) have gaps
 * ≤ ~3pt and are NOT companions. Used by the style-flow gates and by
 * STEP 8.8 to recognise TOC entry lines. */
function lineEndsWithCompanionNumber(line: InputRect[]): boolean {
  if (line.length < 2) return false;
  const sorted = [...line].sort((a, b) => a.left - b.left);
  const last = sorted[sorted.length - 1];
  const lastText = ((last as any).text || '').trim();
  if (!/^\d{1,4}[.)]?$/.test(lastText)) return false;
  const prev = sorted[sorted.length - 2];
  return last.left - prev.right >= TOC_NUM_NATIVE_GAP;
}

/**
 * LAYOUT-FIX-6: do two LINE RUNS read as one flowing paragraph?
 *
 * Evidence required when the full font changes between runs:
 *   1. Vertical gap ≈ line pitch (≤ FLOW_GAP_PITCH_MULT × 1.35 × size).
 *   2. Same column (x-overlap ≥ 50% of the narrower run width).
 *   3. Size compatible (≤ FLOW_SIZE_TOLERANCE pt difference) — the PRIMARY
 *      caption guard (book captions are 2-3pt smaller than body text).
 *   4. Neither run's FIRST line starts with a caption pattern
 *      (Figure/Fig/Table/…) — the SECONDARY caption guard.
 *
 * Calibrated (B5/B9 regression, 2026-09-16): the earlier draft also
 * required the upper run's last line to end mid-sentence (lowercase /
 * hyphen / comma). That split two LAYOUT-FIX-5 corpus-validated merges —
 * the classif-p4 footnote block (Lt/LtIt citation lines ending in '.')
 * and the aliment-p1 disclosure+e-mail footnote (Roman line ends '.',
 * italic e-mail line follows). Sentence-ending punctuation before a
 * style switch is NOT evidence of a block boundary in footnote-heavy
 * academic layouts, so the text-ending condition was dropped; captions
 * stay separated by the size gate + the caption-prefix gate, TOC entries
 * by STEP 8.65.
 */
function runsFlowContinuous(
  upperLastLine: InputRect[],
  lowerFirstLine: InputRect[],
  upperFirstLineText: string,
): boolean {
  // (4) caption patterns — a caption is never part of a body paragraph.
  // LAYOUT-FIX-14: isCaptionStartText adds the plural forms behind the
  // kill-switch.
  if (isCaptionStartText(lineTextOf(lowerFirstLine))) return false;
  if (isCaptionStartText(upperFirstLineText)) return false;
  // (5) TOC entry terminator — the upper line ends with a companion page
  // number (trailing digits-only span with a real gap): a TOC entry ended,
  // the next line is a NEW entry, never a style-flow continuation.
  if (lineEndsWithCompanionNumber(upperLastLine)) return false;

  // (1) vertical gap vs line pitch.
  const upperBottom = Math.max(...upperLastLine.map(s => s.bottom));
  const lowerTop = Math.min(...lowerFirstLine.map(s => s.top));
  const gap = lowerTop - upperBottom;
  const pitch = 1.35 * Math.max(medianFontSize(upperLastLine), medianFontSize(lowerFirstLine));
  if (gap < -3 || gap > pitch * FLOW_GAP_PITCH_MULT) return false;

  // (2) same column.
  const uL = Math.min(...upperLastLine.map(s => s.left));
  const uR = Math.max(...upperLastLine.map(s => s.right));
  const lL = Math.min(...lowerFirstLine.map(s => s.left));
  const lR = Math.max(...lowerFirstLine.map(s => s.right));
  const overlap = Math.max(0, Math.min(uR, lR) - Math.max(uL, lL));
  const narrower = Math.min(uR - uL, lR - lL);
  if (overlap < narrower * 0.5) return false;

  // (3) size compatibility.
  if (Math.abs(medianFontSize(upperLastLine) - medianFontSize(lowerFirstLine)) > FLOW_SIZE_TOLERANCE) {
    return false;
  }

  return true;
}

/**
 * LAYOUT-FIX-6: paragraph-level flow continuity (for the STEP 6 / 8.5
 * merge gates). Uses the last line of the upper paragraph and the first
 * line of the lower paragraph.
 */
function parasFlowContinuous(upper: Paragraph, lower: Paragraph): boolean {
  const upperLines = groupIntoLines(upper.spans);
  const lowerLines = groupIntoLines(lower.spans);
  if (upperLines.length === 0 || lowerLines.length === 0) return false;
  return runsFlowContinuous(
    upperLines[upperLines.length - 1],
    lowerLines[0],
    lineTextOf(upperLines[0]),
  );
}

// Stage 2.1 (Q5): module-level flag set by buildParagraphs so that
// module-level helper functions (computeDominantFont, splitByFont, etc.)
// can access the preserveStyle setting without needing it passed as a
// parameter through every call chain. This is a pragmatic trade-off:
// the alternative would be adding `preserveStyle: boolean` to 5+ helper
// function signatures, which is more invasive for a single boolean.
//
// The flag is set at the start of buildParagraphs and reset to false
// at the end. Since JS is single-threaded and buildParagraphs is
// synchronous, there's no risk of concurrent modification.
let _preserveStyle = false;
// Stage 2.2 (Q6): same pattern for the new settings.
let _columnGapThreshold = DEFAULT_COLUMN_GAP_THRESHOLD;
let _decorationThreshold = DEFAULT_DECORATION_THRESHOLD;
// LAYOUT-FIX-3 (2026-09-16): kill-switch flags, same module-level pattern.
let _disableFragmentAbsorption = false;
let _disableFigureBandMerge = false;
// LAYOUT-FIX-6 (2026-09-16): kill-switches for the style-flow gates +
// STEP 7.7 and the TOC repair — same module-level pattern.
let _disableStyleFlowGuard = false;
let _disableTocRepair = false;
// LAYOUT-FIX-8 (2026-09-17): kill-switch flag for STEP 9.5.
let _disableNonAdjacentSplit = false;
// LAYOUT-FIX-11 (2026-09-17): kill-switch flag for STEP 8.62.
let _disableHeadingSplit = false;
// LAYOUT-FIX-13: kill-switch flag for STEP 9.6 (torn-fragment re-attachment).
let _disableFragmentReattach = false;
// LAYOUT-FIX-14: kill-switch flag for the font-homogeneity rules (STEP 7.3
// + the size-class gates in 8.5/8.7 + generic-family equality + plural
// caption prefixes). Same module-level pattern as the other switches.
let _disableFontClassSplit = false;
// LAYOUT-FIX-22: kill-switch for STEP 6.9 (same-baseline single-line
// bridge). Set by runLayoutPass from settings.disableSingleLineBridge /
// the 'separate' preset; same module-level pattern as the other switches.
let _disableSingleLineBridge = false;
// LAYOUT-FIX-23 (STEP 9.65 caption assembly) needs NO module flag: the pass
// runs in buildParagraphs AFTER runLayoutPass's finally, so the kill-switch
// is resolved locally there (see disableCA in buildParagraphs).

export function buildParagraphs(
  map: OccupancyMapResult,
  rects: InputRect[],
  settings: ContourSettings = {}
): Paragraph[] {
  const manual = settings.activeRegions || [];
  const pageW = settings.regionPageWidth ?? map.gridW * map.cellSize, pageH = settings.regionPageHeight ?? map.gridH * map.cellSize;
  if (manual.length || isManualMode(settings.layoutPreset)) {
    const plain = {...settings, activeRegions: [], layoutPreset: isManualMode(settings.layoutPreset) ? 'standard' as const : settings.layoutPreset, disableColumnMemory: true};
    const remaining = new Set(rects);
    const batches: Paragraph[][] = [];
    const rules = [...manual];
    if (isManualMode(settings.layoutPreset)) rules.push({id:'page-default',page:1,
      rect:{left:0,top:0,width:1,height:1},mode:settings.layoutPreset});
    for (const rule of rules) {
      const output: Paragraph[] = [];
      const r=rule.rect;
      const selected=[...remaining].filter(s=>{
        const x=(s.left+s.right)/2/pageW, y=(s.top+s.bottom)/2/pageH;
        return x>=r.left && x<=r.left+r.width && y>=r.top && y<=r.top+r.height;
      });
      selected.forEach(s=>remaining.delete(s));
      for(const group of explicitGroups(selected,rule,pageW,pageH)) {
        if(rule.mode==='explicit-columns') {
          const local=buildOccupancyMap(group.spans,pageW,pageH,map.cellSize);
          output.push(...buildParagraphs(local,group.spans,{...plain,disableColumnSlicing:true}));
        } else {
          const font=computeDominantFont(group.spans);
          const paragraph=makeParagraph(group.spans,font.dominantFamily,font.dominantSize);
          if(rule.mode==='table') Object.assign(paragraph,{tableId:rule.id,tableRow:group.row,tableColumn:group.column});
          output.push(paragraph);
        }
      }
      if(output.length) batches.push(output);
    }
    // Never run global caption/fragment repair over manually partitioned output.
    const rest=[...remaining];
    const automatic=rest.length ? buildParagraphs(buildOccupancyMap(rest,pageW,pageH,map.cellSize),rest,plain) : [];
    // Preserve the automatic reading order outside the edited regions. A global
    // y-sort here would interleave previously independent prose columns.
    const result = [...automatic];
    batches.sort((a,b)=>Math.min(...a.map(p=>p.pxTop))-Math.min(...b.map(p=>p.pxTop)));
    for(const batch of batches) {
      const top=Math.min(...batch.map(p=>p.pxTop));
      const left=Math.min(...batch.map(p=>p.pxLeft)), right=Math.max(...batch.map(p=>p.pxRight));
      let at=result.findIndex(p=>p.pxTop>=top && p.pxRight>left && p.pxLeft<right);
      if(at<0) at=result.findIndex(p=>p.pxLeft>=right);
      if(at<0) at=result.length;
      result.splice(at,0,...batch);
    }
    return result;
  }
  // Analyse each baseline orientation in its own horizontal coordinate
  // system. Page.rotate alone cannot describe rotated tables on upright pages.
  if (rects.some(s => Math.abs(s.textAngle || 0) > 0.01)) {
    const groups = new Map<number, InputRect[]>();
    for (const s of rects) {
      const angle = Math.round((s.textAngle || 0) * 10000) / 10000;
      const group = groups.get(angle) || []; group.push(s); groups.set(angle, group);
    }
    const output: Paragraph[] = [];
    const w = map.gridW * map.cellSize, h = map.gridH * map.cellSize;
    for (const [angle, group] of groups) {
      if (Math.abs(angle) <= 0.01) {
        output.push(...buildParagraphs(buildOccupancyMap(group, w, h, map.cellSize), group, settings));
        continue;
      }
      const c = Math.cos(angle), sn = Math.sin(angle);
      const page = [[0,0], [w,0], [0,h], [w,h]].map(([x,y]) => [c*x+sn*y, -sn*x+c*y]);
      const ox = Math.min(...page.map(p => p[0])), oy = Math.min(...page.map(p => p[1]));
      const rw = Math.max(...page.map(p => p[0])) - ox, rh = Math.max(...page.map(p => p[1])) - oy;
      const transform = (s: InputRect, inverse = false): InputRect => {
        const points = ((!inverse && s.textQuad) || [[s.left,s.top], [s.right,s.top], [s.left,s.bottom], [s.right,s.bottom]])
          .map(([x,y]) => inverse ? [c*(x+ox)-sn*(y+oy), sn*(x+ox)+c*(y+oy)]
            : [c*x+sn*y-ox, -sn*x+c*y-oy]);
        return {...s, left:Math.min(...points.map(p=>p[0])), right:Math.max(...points.map(p=>p[0])),
          top:Math.min(...points.map(p=>p[1])), bottom:Math.max(...points.map(p=>p[1])), textAngle:0,textQuad:undefined};
      };
      const local = group.map(s => transform(s));
      const ps = buildParagraphs(buildOccupancyMap(local, rw, rh, map.cellSize), local,
        {...settings, disableColumnMemory:true});
      for (const p of ps) {
        p.spans = p.spans.map(s => ({...transform(s, true), textAngle:angle,
          readingBox:{left:s.left, top:s.top, right:s.right, bottom:s.bottom}}));
        const font = computeDominantFont(p.spans);
        output.push({...makeParagraph(p.spans, font.dominantFamily, font.dominantSize),
          ...(p.tableId ? {tableId:`angle-${angle}-${p.tableId}`,tableRow:p.tableRow,tableColumn:p.tableColumn} : {})});
      }
    }
    return output;
  }
  // Keep attached indices out of line/column statistics, but never discard
  // them. Attachment uses a local baseline and font, not the page median.
  const attachments = new Map<InputRect, InputRect>();
  for (const s of rects) {
    if (!/^(?:\d{1,3}|[a-z])$/.test((s.text || '').trim())) continue;
    const h = s.fontsize || s.bottom - s.top;
    let best: InputRect | undefined;
    let score = Infinity;
    for (const a of rects) {
      const ah = a.fontsize || a.bottom - a.top;
      if (a === s || h >= ah * 0.85 || !/[\p{L}\p{N})]/u.test(a.text || '')) continue;
      const gap = s.left - a.right;
      if (gap < -ah * 0.3 || gap > ah * 0.65) continue;
      if (s.bottom < a.top + ah * 0.2 || s.top > a.bottom + ah * 0.35) continue;
      const distance = Math.abs(gap) + Math.abs(s.bottom - a.bottom) * 0.2;
      if (distance < score) { best = a; score = distance; }
    }
    if (best) attachments.set(s, best);
  }
  const body = attachments.size ? rects.filter(s => !attachments.has(s)) : rects;
  const tables = detectTableRegions(body, map.gridW * map.cellSize);
  const tableSpans = new Set(tables.flatMap(t => t.spans));
  const prose = body.filter(s => !tableSpans.has(s));
  const cleanMap = attachments.size || tables.length
    ? buildOccupancyMap(prose, map.gridW * map.cellSize, map.gridH * map.cellSize, map.cellSize)
    : map;
  let result = buildParagraphsCore(cleanMap, prose, settings);
  for (const table of tables) {
    const cells = table.cells.map(cell => {
      const font = computeDominantFont(cell.spans);
      return {...makeParagraph(cell.spans,font.dominantFamily,font.dominantSize),
        tableId:table.id,tableRow:cell.row,tableColumn:cell.column};
    });
    const wide = table.right-table.left > map.gridW*map.cellSize*0.6;
    let at = result.findIndex(p => p.pxTop >= table.top-2
      && (wide || (p.pxLeft >= table.left-8 && p.pxLeft < table.right)));
    if (at < 0 && !wide) at=result.findIndex(p => p.pxLeft >= table.right);
    if (at < 0) at=result.length;
    result.splice(at,0,...cells);
  }
  const scriptFragments = new Set<Paragraph>();
  for (const [script, anchor] of attachments) {
    const target = result.find(p => p.spans.includes(anchor));
    if (target) {
      target.spans.push(script);
      target.pxLeft = Math.min(target.pxLeft, script.left);
      target.pxRight = Math.max(target.pxRight, script.right);
      target.pxTop = Math.min(target.pxTop, script.top);
      target.pxBottom = Math.max(target.pxBottom, script.bottom);
      target.width = target.pxRight-target.pxLeft;
      target.height = target.pxBottom-target.pxTop;
      for (const fragment of result) {
        if (fragment===target || fragment.tableId || scriptFragments.has(fragment) || fragment.spans.length!==1) continue;
        const next=fragment.spans[0];
        if (!/^\p{L}{1,5}$/u.test((next.text||'').trim())) continue;
        if (next.fontname!==anchor.fontname || Math.abs((next.fontsize||10)-(anchor.fontsize||10))>0.5) continue;
        if (Math.abs(next.bottom-anchor.bottom)>1 || next.left<script.right || next.left-script.right>6) continue;
        target.spans.push(next); scriptFragments.add(fragment);
        target.pxRight=Math.max(target.pxRight,next.right); target.width=target.pxRight-target.pxLeft;
      }
    } else {
      const font = computeDominantFont([script]);
      result.push(makeParagraph([script], font.dominantFamily, font.dominantSize));
    }
  }
  result=result.filter(p=>!scriptFragments.has(p));
  // A bold caption marker can be separated from its first normal-font row
  // by style-flow splitting. Repair only a pure numbered marker sharing
  // a baseline with adjacent text; never absorb the paragraph below it.
  const removed = new Set<Paragraph>();
  for (const label of result) {
    const text = label.spans.map(s => s.text || '').join(' ').trim();
    if (!/^(?:fig(?:ure)?s?\.?|tables?\.?|рис\.?|рисунок|табл\.?|таблица)\s*\d+[A-Za-z]?[.:]?$/iu.test(text)) continue;
    const s = label.spans[label.spans.length - 1];
    if (!s) continue;
    const candidate = result.filter(p => p !== label && !removed.has(p)).map(p => ({
      p, first: [...p.spans].sort((a, b) => a.top - b.top || a.left - b.left)[0],
    })).filter(({first}) => first && first.left >= s.right - 1
      && first.left - s.right <= Math.max(16, (s.fontsize || 10) * 2)
      && Math.abs(first.bottom - s.bottom) <= 2
      && Math.abs((first.fontsize || 10) - (s.fontsize || 10)) <= 1)
      .sort((a, b) => a.first.left - b.first.left)[0];
    if (!candidate) continue;
    const spans = [...label.spans, ...candidate.p.spans];
    const font = computeDominantFont(spans);
    Object.assign(candidate.p, makeParagraph(spans, font.dominantFamily, font.dominantSize),
      { columnId: candidate.p.columnId ?? label.columnId });
    removed.add(label);
  }
  result = result.filter(p => !removed.has(p));
  if (tables.length) {
    // Treat a table as one region for page order, then expand its row-major
    // cells. Its internal column anchors must not become page columns.
    const expansions = new Map<Paragraph, Paragraph[]>();
    const captions = new Set(result.filter(p=>tables.some(t=>p.spans.includes(t.caption))));
    const regions = result.filter(p => !p.tableId && !captions.has(p));
    for (const t of tables) {
      const cells=result.filter(p=>p.tableId===t.id);
      const caption=[...captions].find(p=>p.spans.includes(t.caption));
      const contents=caption?[caption,...cells]:cells;
      const font=computeDominantFont(contents.flatMap(p=>p.spans));
      const region=makeParagraph(contents.flatMap(p=>p.spans),font.dominantFamily,font.dominantSize);
      expansions.set(region,contents); regions.push(region);
    }
    const wide=map.gridW*map.cellSize;
    const eligible=regions.filter(p=>p.height>25 && p.width>wide*0.2)
      .sort((a,b)=>a.pxLeft-b.pxLeft);
    let cut: number | undefined;
    for(let i=1;i<eligible.length;i++) {
      if(eligible[i].pxLeft-eligible[i-1].pxLeft>wide*0.2) {cut=eligible[i].pxLeft;break;}
    }
    result=applyColumnOrder(regions,map.cellSize,cut===undefined?undefined:[cut])
      .flatMap(p=>expansions.get(p)||[p]);
  }
  return result;
}

function buildParagraphsCore(
  map: OccupancyMapResult,
  rects: InputRect[],
  settings: ContourSettings = {}
): Paragraph[] {
  // ── LAYOUT-FIX-16 (2026-09-19): post-loop caption subtraction ──────
  //
  // USER REPORT (page 61 class): «параграфы для captions определяются
  // верно, а главный текст страдает» — on furniture pages (column
  // detection failed → single map) the caption UNITS come out right
  // (STEP 7.3 split the mixed islands by font class back in FIX-14),
  // but the BODY is left mis-structured: its fragments were built on a
  // grid polluted by caption/figure furniture, and the reading order
  // y-sorts the two columns into each other. The user's idea, adopted
  // verbatim: run the current algorithm ONCE, use its (trusted) caption
  // units to take the furniture OUT OF THE EQUATION, then redistribute
  // the main text on the clean feed.
  //
  // Contract (all must hold — otherwise PASS 1 is returned untouched):
  //   1. kill-switches: disableCaptionSubtractLoop / disableFontClassSplit
  //      (the classifier consumes the 7.3 font-class separation; with
  //      FIX-14 killed there are no caption units to trust) → OFF;
  //   2. presets: 'paragraphs' forces single-map by design, 'separate'
  //      is row-major table semantics — the loop is a column-rescue and
  //      neither preset wants it. 'standard'/'two-columns' only;
  //   3. PASS 1 ran the SINGLE-MAP path (slicer detected === false —
  //      including the 'two-columns' preset's failed forced candidates);
  //   4. ≥1 caption-class unit (conservative gate: caption-prefix text
  //      AND font class ≠ the page-modal body class AND ≤16 rows — a
  //      body sentence starting «Table 1 shows…» is modal-class prose
  //      and is never subtracted);
  //   5. the page has COLUMN EVIDENCE — ≥1 pair of units with disjoint
  //      x-ranges (ink gap ≥20pt) that share a y-band. A true
  //      single-column page failing detection is CORRECT, not a rescue
  //      target; without this gate every single-column page with a
  //      «Figure 1 …» caption would get its body rebuilt (breaking the
  //      corpus byte-parity contract);
  //   6. the subtraction removes a non-empty, non-full slice of the feed.
  //
  // PASS 2 rebuilds islands per its own slicer verdict with the SAME
  // settings plus disableColumnMemory: true — the cross-page memory is
  // neither read (a lookup can only re-fail on a sparser feed) nor
  // WRITTEN (the feed is virtual: a snapshot of a furniture-free page
  // would poison the next real page's loose lookup). PASS 2 never
  // recurses: the dispatcher runs at most two passes, deterministic.
  //
  // UNION: PASS 2's body units + PASS 1's caption units, ordered by the
  // SAME applyColumnOrder the pipeline always uses — with PASS 2's
  // boundaries when its detection succeeded. This reproduces exactly
  // what the page would have produced with a successful first detection
  // (full-width elements → header bucket, right-band captions → right
  // bucket at their y): the solo-page output converges with the
  // memory-rescued page (p61-synth) and with the 'two-columns' preset
  // (p61-solo forced cut ≈323.3) — both already verified correct in
  // FIX-13/15. Text invariant: word-multiset(PASS 2 units ∪ caption
  // units) === word-multiset(PASS 1 units) — the caption units' spans
  // are the exact InputRect objects subtracted from the feed, and the
  // pipeline's partition property (every rect lands in exactly one
  // output unit) holds for both passes.
  _lastCaptionSubtract = null;
  const PRESET16 = settings.layoutPreset ?? 'standard';
  const pass1 = runLayoutPass(map, rects, settings);
  // ── STEP 9.65 wrapper (LAYOUT-FIX-23): the caption chain assembly runs
  // HERE — above BOTH output paths of the caption-subtraction loop (PASS 1
  // verbatim and the PASS-2 union). Running it inside runLayoutPass would
  // miss the union path entirely (maxillary p2: detection off → loop fires
  // → the output comes from PASS 2 + the subtracted caption units, and the
  // assembly inside the passes would only ever see a feed WITHOUT the
  // caption units — nothing to assemble — while its diagnostics counter
  // got reset by the second pass). The boundaries follow the OUTPUT's own
  // pass: pass1's for the verbatim path, PASS 2's for the union. The
  // kill-switch is resolved LOCALLY (not via the module flag —
  // runLayoutPass's finally has already reset _disableCaptionAssembly by
  // the time this wrapper runs; 'separate' keeps it off by design, same
  // as the STEP 6.9 bridge).
  const disableCA = settings.disableCaptionAssembly === true
    || (settings.layoutPreset ?? 'standard') === 'separate';
  const assembleCaptionOutput = (ps: Paragraph[], bnd?: number[]): Paragraph[] =>
    disableCA ? ps : assembleCaptionChains(ps, pass1.pageW, bnd);
  if (settings.disableCaptionSubtractLoop === true) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  if (settings.disableFontClassSplit === true) {
    // KILL14 (pre-FIX-14 A/B): same surface as the other post-slicer
    // passes (6.9/9.6 run inside runLayoutPass under KILL14 too).
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  if (PRESET16 === 'paragraphs' || PRESET16 === 'separate') {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  if (pass1.slice.detected) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.boundaries);
  }
  if (rects.length < 8) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  const captionUnits = classifyCaptionUnitsForSubtraction(pass1.paras);
  if (captionUnits.length === 0) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  const subtracted = new Set<InputRect>();
  for (const c of captionUnits) for (const s of c.spans) subtracted.add(s);
  const feed2 = rects.filter(r => !subtracted.has(r));
  if (feed2.length === 0 || feed2.length === rects.length) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  // LAYOUT-FIX-17c (2026-09-19, try5.pdf p1/p2): the unit-based evidence
  // gate is BLIND exactly where the loop is needed most. It looks for
  // side-by-side UNITS of PASS 1 — but when detection has already failed
  // badly, PASS 1 has FUSED both columns into full-width interleaved
  // units (try5 p1: body units w≈0.83; p2: one 71-span unit x=44–564):
  // no side-by-side pairs survive, the trigger refuses to fire, and the
  // cross-column overmerge stands — a vicious circle (the gate needs the
  // structure the loop is supposed to restore). The SPAN-based evidence
  // below runs on the SUBTRACTED feed instead: spans are the atoms the
  // slicer will actually see, they cannot be «fused» by island building,
  // and full-width furniture (the subtracted captions themselves, wide
  // bridges) is excluded by the width filter. The unit gate is kept as an
  // OR-alternative (it covers sparse pages whose spans sit below the
  // span-count floor).
  if (!pageHasColumnEvidence(pass1.paras) && !spansHaveColumnEvidence(feed2, pass1.pageW)) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  const map2 = buildOccupancyMap(feed2, pass1.pageW, pass1.pageH, map.cellSize);
  const pass2 = runLayoutPass(map2, feed2, { ...settings, disableColumnMemory: true });
  const union = applyColumnOrder(
    [...pass2.paras, ...captionUnits],
    map.cellSize,
    pass2.slice.detected && pass2.slice.boundaries.length > 0
      ? pass2.slice.boundaries
      : undefined,
  );
  // NO-OP GUARANTEE: when the rebuild changed nothing structural — every
  // position of the ordered union carries the SAME span sequence as
  // PASS 1 — return PASS 1 verbatim. The loop may only alter the output
  // where it actually repairs structure (columns detected → bucketed
  // reading order; islands regrouped). This closes the whole class of
  // «fired but nothing changed» pages (2tier p3's benign Table-1 caption,
  // p61-solo's single-map rebuild): their output stays byte-identical to
  // the pre-loop pipeline BY CONSTRUCTION, not by luck — and the span-
  // exact px boxes PASS 1 produced (e.g. a 9.6-absorbed unit) are not
  // traded for PASS 2's grid-quantized ones.
  const noOp = sameSpanSequence(union, pass1.paras);
  _lastCaptionSubtract = {
    captionUnits: captionUnits.length,
    captionSpans: subtracted.size,
    feed2Rects: feed2.length,
    pass2Detected: pass2.slice.detected,
    pass2Boundaries: pass2.slice.boundaries.map(b => +b.toFixed(2)),
    repaired: !noOp,
  };
  if (noOp) {
    return assembleCaptionOutput(pass1.paras, pass1.slice.detected ? pass1.slice.boundaries : undefined);
  }
  return assembleCaptionOutput(
    union,
    pass2.slice.detected && pass2.slice.boundaries.length > 0
      ? pass2.slice.boundaries
      : undefined,
  );
}

/** LAYOUT-FIX-16: diagnostic record of the last caption-subtraction run on
 * this module (null when the loop did not fire; `repaired: false` when it
 * fired but the no-op guarantee returned PASS 1). Production code never
 * reads it; the audit harness does (per-page probe). */
let _lastCaptionSubtract: {
  captionUnits: number;
  captionSpans: number;
  feed2Rects: number;
  pass2Detected: boolean;
  pass2Boundaries: number[];
  repaired: boolean;
} | null = null;

/** LAYOUT-FIX-16: ONE full pipeline pass (slicer → islands → merge/split
 * passes → reading order). Internal — the exported buildParagraphs runs
 * it once (PASS 1) and, when the caption-subtraction trigger fires,
 * again on the furniture-free feed (PASS 2). Never recursive. */
function runLayoutPass(
  map: OccupancyMapResult,
  rects: InputRect[],
  settings: ContourSettings
): { paras: Paragraph[]; slice: ColumnSlice; pageW: number; pageH: number } {
  // LAYOUT-FIX-15 (2026-09-19): resolve the user preset into EFFECTIVE
  // pipeline flags BEFORE any propagation — single resolution point shared
  // by both production paths (the queue and the DOM path pass the raw
  // settings.layoutPreset through). The preset ORs with the explicit
  // kill-switches (A/B flags keep working under a preset):
  //   • 'paragraphs'  → disableColumnSlicing (single map, no cuts);
  //   • 'two-columns' → forceDetection for the slicer (STEP 4.3 reduced
  //                     validation of the page's own start-peak candidates);
  //   • 'separate'    → the cross-block merge passes OFF + row-major reading
  //                     order (columnGapThreshold → 1e9 ⇒ applyColumnOrder's
  //                     legacy clustering degenerates to the y-sort: every
  //                     row's blocks read left-to-right, no column buckets).
  // 'standard'/undefined → everything at its validated default.
  const PRESET = settings.layoutPreset ?? 'standard';
  const presetSeparate = PRESET === 'separate';
  const presetParagraphs = PRESET === 'paragraphs';
  const presetTwoColumns = PRESET === 'two-columns';

  // LAYOUT-FIX (2026-09-14): the per-field map destructure moved into
  // buildParagraphsInRegion (Steps 5-8 run there, per column group).
  const INDENT_THRESHOLD = settings.indentThreshold ?? DEFAULT_INDENT_THRESHOLD;
  const FONT_SIZE_TOLERANCE = settings.fontSizeTolerance ?? DEFAULT_FONT_SIZE_TOLERANCE;
  const MAX_MERGE_PASSES = settings.maxMergePasses ?? DEFAULT_MAX_MERGE_PASSES;
  // Stage 2.1 (Q5): propagate preserveStyle to all getFontFamily calls
  // inside this function. The pdfjs path sets this to true so bold/italic
  // variants are treated as different families (matching DOM path behavior).
  const PRESERVE_STYLE = settings.preserveStyle ?? false;
  _preserveStyle = PRESERVE_STYLE;
  // Stage 2.2 (Q6): propagate the new settings to module-level helpers.
  // LAYOUT-FIX-15: 'separate' neutralises the reading-order column
  // clustering (see the preset block above).
  _columnGapThreshold = presetSeparate ? 1e9 : (settings.columnGapThreshold ?? DEFAULT_COLUMN_GAP_THRESHOLD);
  _decorationThreshold = settings.decorationThreshold ?? DEFAULT_DECORATION_THRESHOLD;
  // LAYOUT-FIX-3 (2026-09-16): propagate the kill-switch flags.
  // LAYOUT-FIX-15: the repair passes stay at their defaults under every
  // preset — 'separate' achieves its semantics via STEP 9.7 + the reading
  // order (below), NOT by disabling intra-block repair (measured: 8.7-off
  // tears reference entries ". 2011; 48(1):147–155." on grading p7 —
  // fragments of ONE block, exactly what absorption exists to re-unite).
  _disableFragmentAbsorption = settings.disableFragmentAbsorption === true;
  _disableFigureBandMerge = settings.disableFigureBandMerge === true;
  // LAYOUT-FIX-6 (2026-09-16): propagate the new kill-switch flags.
  _disableStyleFlowGuard = settings.disableStyleFlowGuard === true;
  _disableTocRepair = settings.disableTocRepair === true;
  // LAYOUT-FIX-8: STEP 9.5 kill-switch.
  _disableNonAdjacentSplit = settings.disableNonAdjacentSplit === true;
  // LAYOUT-FIX-11: STEP 8.62 kill-switch.
  _disableHeadingSplit = settings.disableHeadingSplit === true;
  // LAYOUT-FIX-13: STEP 9.6 kill-switch.
  _disableFragmentReattach = settings.disableFragmentReattach === true;
  // LAYOUT-FIX-14: font-homogeneity kill-switch.
  _disableFontClassSplit = settings.disableFontClassSplit === true;
  // LAYOUT-FIX-22: STEP 6.9 kill-switch — explicit flag or the 'separate'
  // preset (row-major table semantics: same-line neighbours are separate
  // blocks by design, the bridge must not glue them).
  _disableSingleLineBridge = settings.disableSingleLineBridge === true || presetSeparate;
  // LAYOUT-FIX-10 (A2): cross-page memory kill-switch — the slicer's
  // lookups/observations become no-ops for this pipeline call.
  setColumnMemoryEnabled(settings.disableColumnMemory !== true);

  // P2-4 (Phase 17): wrap the entire body in try/finally so the module-level
  // flags are ALWAYS reset, even if an exception escapes (previously a throw
  // inside Step 5-9 would leave `_preserveStyle=true`/`_columnGapThreshold=X`
  // set, leaking into subsequent calls from a different layout engine path).
  try {
  // LAYOUT-FIX (2026-09-14): detect column structure on the input rects and
  // partition them BEFORE any grid/island work. Each column group then runs
  // Steps 5-8 on its OWN occupancy map — a group's grid physically cannot
  // bridge into a neighbouring column because the other column's rects are
  // not in it (pdfjs item-width overstatement becomes harmless). Rect
  // coordinates are never modified, so span identity, overlay geometry and
  // the DOM-path span matching are unaffected. Step 9 (applyColumnOrder)
  // still runs ONCE, globally, over the concatenated result — headers,
  // footers and cross-column elements keep their page-level classification.
  //
  // When no column pair validates (single-column pages, tables, figure
  // labels), `detected === false` and the pipeline is byte-identical to the
  // pre-fix behavior: one map (the caller's), one Steps 5-8 pass.
  const pageW = map.gridW * map.cellSize;
  const pageH = map.gridH * map.cellSize;
  // LAYOUT-FIX-15: 'paragraphs' forces the single-map path (the preset is
  // an explicit user assertion "this document is one column"); the explicit
  // disableColumnSlicing kill-switch keeps its precedence semantics.
  const slices: ColumnSlice = settings.disableColumnSlicing === true || presetParagraphs
    ? { detected: false, groups: [rects], boundaries: [] }
    : sliceRectsByColumns(rects, pageW, pageH, {
        inkChannel: settings.inkChannelFeed === true,
        forceDetection: presetTwoColumns,
        // LAYOUT-FIX-18: the drift-tail slicer gates (18b demotion zone +
        // 18c crossing-tail continuation) — production feeds only (the
        // flag is absent on harness/suite calls, keeping their calibrated
        // contracts byte-stable).
        driftTailRepair: settings.disableWordDriftRepair !== true && settings.inkChannelFeed === true,
      });

  let finalParagraphs: Paragraph[];
  if (!slices.detected) {
    finalParagraphs = buildParagraphsInRegion(map, rects, INDENT_THRESHOLD, FONT_SIZE_TOLERANCE, MAX_MERGE_PASSES);
  } else {
    finalParagraphs = [];
    slices.groups.forEach((group, gi) => {
      const gmap = buildOccupancyMap(group, pageW, pageH, map.cellSize);
      const built = buildParagraphsInRegion(gmap, group, INDENT_THRESHOLD, FONT_SIZE_TOLERANCE, MAX_MERGE_PASSES);
      // LAYOUT-FIX-8 (A3-lite): remember which slicer group built each
      // unit. fixTocEntries (8.65) reads this as a construction-based
      // same-column gate — the structural insurance for the F1 boundary
      // gate (see the columnId check in its Pass 1 host loop).
      for (const p of built) p.columnId = gi;
      finalParagraphs.push(...built);
    });
    finalParagraphs.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // ── STEP 8.65: TOC entry repair (LAYOUT-FIX-6) ────────────────────
  // Runs globally over the concatenated groups, BEFORE 8.7/8.8: TOC
  // page-number islands must be attached to their entries and entry
  // units split BEFORE the fragment/band passes see them (otherwise
  // 8.7 absorbs the numbers into the entry-chain block and 8.8 bands
  // the leftover numbers into a vertical "2/6/10…" unit — both observed
  // on try.pdf p1, the book's table of contents).
  if (!_disableTocRepair) {
    // LAYOUT-FIX-7 (2026-09-17): pass the slicer's validated column
    // boundaries into fixTocEntries. Its Pass-1 host search had NO column
    // geometry — the only "column" check was numInkLeft >= host.pxLeft - 2
    // ("number right of the host's left edge"), which says nothing about
    // same-column membership. On classif.pdf p4 a citation superscript "2"
    // (x=340, RIGHT column, 6pt) got attached to a LEFT-column body line
    // (ink right 297, gap 43pt in [7,90]) because the number's NATIVE
    // right-column line was rejected as "table cell padding" (gap 4 < 7).
    // The merged unit crossed the boundary (cross/ileav) and its
    // grid-quantized pxRight (348 > 311.6 + 36) flipped it WIDE → header
    // bucket → read as position #2, before the TABLE 2 heading (M3).
    finalParagraphs = fixTocEntries(
      finalParagraphs,
      pageW,
      slices.detected ? slices.boundaries : undefined,
    );
  }

  // ── STEP 8.7: Absorb contained fragments ──────────────────────────
  // LAYOUT-FIX-3 (2026-09-16): runs GLOBALLY over the concatenated
  // groups (not per group): the column slicer's drift repair can
  // mis-assign an isolated italic fragment to the NEIGHBOURING group —
  // its left edge overlaps the OVERSTATED declared right edge of the
  // preceding item on the same row (try.pdf p5: italic "et" at x=442
  // vs the roman line's declared right ≈444 → "drifted left-column
  // word" → left group), so a per-group pass would never find the
  // fragment's true container in the other group. Containment geometry
  // is group-agnostic and cannot span a real gutter (≥80% of the
  // fragment's area inside the container's interior), so running
  // globally is strictly safer for real columns.
  if (!_disableFragmentAbsorption) {
    finalParagraphs = absorbContainedFragments(finalParagraphs, map.cellSize);
  }

  // ── STEP 8.8: Merge sparse figure-label bands ─────────────────────
  // LAYOUT-FIX-3 (2026-09-16): runs globally (over the concatenated
  // groups) because a figure can span the full page width — its labels
  // live in several column groups. See mergeFigureLabelBands below.
  if (!_disableFigureBandMerge) {
    finalParagraphs = mergeFigureLabelBands(
      finalParagraphs,
      pageW,
      pageH,
      slices.detected ? slices.boundaries : undefined,
    );
  }

  // ── STEP 8.62: Split standalone styled headings from body text ────
  // LAYOUT-FIX-11 (2026-09-17, user report «написанные bold подзаголовки
  // НЕ должны сливаться с body text»): строка, ЦЕЛИКОМ набранная более
  // крупным кеглем (bold-подзаголовки книги: MinionPro-Semibold 9.75–9.8pt
  // против body 9.04pt — и pdf.js item.height, и DOM computed font-size
  // сообщают высоту Semibold с запасом), стоящая НАД строками обычного
  // кегля, — это заголовок, а не продолжение абзаца. Сплит ПОСЛЕ такого
  // прогона строк. Канонические кейсы («Oncogene creation», «Point
  // mutations» — try3:p3 = стр. 22 книги Tumors in Domestic Animals)
  // сливаются на ОБОИХ путях: DOM не видит ни веса (generic 'serif',
  // computed weight 400 — PDF's Semibold maps to plain CSS family), ни
  // имени шрифта; очередь видит высоту (item.height 9.8 vs 9.0), но
  // STYLE-FLOW гейты (7.7/6/8.5) считают |9.8−9.04| ≤
  // FLOW_SIZE_TOLERANCE=2.0 «совместимыми» и сливают. Правило работает по
  // единственному сигналу, видимому на ОБОИХ путях: кегль строки.
  // Гейты против ложных срабатываний:
  //   • кегль сравнивается с МОДОЙ кеглей строк юнита (body), а не с
  //     соседней строкой — встроенные bold-слова медиану строки не
  //     двигают;
  //   • сплит только между прогоном крупных строк и ПОСЛЕДУЮЩИМ body
  //     (заголовок над телом — по спеке пользователя; крупная строка в
  //     конце юнита не режется);
  //   • целиком крупный юнит (заголовочный блок без body) не режется;
  //   • drop-cap: медиана строки с буквицей остаётся body (один крупный
  //     спан среди обычных) — 8.5 не затронут;
  //   • курсивные сноски Lt/LtIt (FIX-6 корпус) — тот же кегль, дельта 0
  //     — не режутся.
  // PLACEMENT (измерено, try:p6): ПОСЛЕ 8.7 — раньше сплит отнимал у
  // 2-строчного подзаголовка статус контейнера (FRAGMENT_CONTAINER_MIN
  // _LINES=3), и STEP 8.7 больше не мог вернуть в него MID-LINE фрагмент
  // (« oncogenes and oncogenes» оставался отдельным мусорным юнитом).
  // После 8.8 — бэнды не цепляют сплит-остатки (подзаголовки шире
  // BAND_SMALL_MAX_W_FRAC страницы). До 9.5 — новые юниты получают
  // порядок чтения STEP 9.
  if (!_disableHeadingSplit) {
    finalParagraphs = splitByStandaloneHeading(finalParagraphs);
  }

  // ── STEP 9.5: Non-adjacency post-validator (LAYOUT-FIX-8) ──────
  // The INVARIANT "never merge what does not touch": a unit whose spans
  // fall into ≥2 connectivity components separated by ≥20pt is a merge of
  // unrelated material (figure labels banded across a diagram, table
  // header cells, list bullets chained across a page) — cut it back into
  // per-component units. Runs BEFORE STEP 9 so the new units get ordered
  // by applyColumnOrder. See splitNonAdjacentComponents below.
  if (!_disableNonAdjacentSplit) {
    finalParagraphs = splitNonAdjacentComponents(finalParagraphs);
  }

  // ── STEP 9: Column-aware reading order ─────────────────────────────
  // Reorder paragraphs to native reading order:
  //   1. Header (above column region) + Wide (cross-column spans) → beginning
  //   2. Column 0 (left, top-to-bottom), Column 1, ... Column N
  //   3. Footer (below column region) → end
  // LAYOUT-FIX-15: 'separate' forces the ROW-MAJOR order — a table page's
  // natural reading order is row-by-row (cells share their y), not the
  // column buckets of a text layout. Passing undefined boundaries drops
  // the bucket path; the 1e9 columnGapThreshold (set above) then collapses
  // the legacy clustering to the plain y-sort (left-to-right within a row).
  const ordered = applyColumnOrder(
    finalParagraphs,
    map.cellSize,
    presetSeparate ? undefined : (slices.detected ? slices.boundaries : undefined),
  );

  // ── STEP 9.6: Re-attach fragments torn out of a body paragraph ────
  // LAYOUT-FIX-13 (2026-09-18, user report «overseparating мелкие
  // параграфы из body — двустрочные»): the user's page 61 showed a
  // 2-line block ending mid-sentence ("…occasionally for the removal of")
  // directly above the continuation that belonged to it ("incompletely
  // excised malignancies…" — kidnapped into a cross-column merged unit
  // there; on healthy pages a torn pair can appear after STEP 9.5/8.7
  // splits). The pass runs AFTER STEP 9 (reading order), over ADJACENT
  // pairs only, and merges A+B strictly when EVERY guard holds:
  //   • SAME COLUMN — both units were built in one slicer group
  //     (columnId), or (single-map pages) their x-ranges overlap ≥70% of
  //     the narrower AND neither unit is WIDE (a full-width caption/table
  //     row or a unit crossing a validated boundary by > WIDE_MARGIN);
  //   • LEFT ALIGNED — |B.pxLeft − A.pxLeft| ≤ 8pt: continuation blocks
  //     start at the column's flush edge, while mid-line STRAY fragments
  //     (the D1 drift class "and"/"thickness") start mid-column;
  //   • VERTICALLY ADJACENT — B sits below A with a gap ≤ max(12pt,
  //     1.4 × dominant size): one leading, not a figure/table band;
  //   • A ENDS MID-SENTENCE — last visible char not in .!?:;»"› AND A's
  //     last span is not a superscript footnote ref (size < median−2.5:
  //     «…tumors. 5,6» terminates the paragraph — user rule);
  //   • B STARTS LOWERCASE — first alphabetic char (a torn continuation
  //     is never a new sentence; new paragraphs and captions start
  //     uppercase);
  //   • SAME SIZE + FAMILY — |domA − domB| ≤ 0.5pt (headings 9.79 vs
  //     body 9.04 are 0.75 apart → STEP 8.62 splits stay split; captions
  //     8.02 vs body 9.03 never merge) and equal dominant family
  //     (sans-serif figure labels never merge into serif body);
  //   • NEITHER IS A LIST/REFERENCE ITEM — first span not a bullet and
  //     not /^\(?\d{1,3}[.)]/ (reference entries "20. Howard…"), and A's
  //     text does not end in dot-leaders+page (TOC entries).
  // Merging is unidirectional (A absorbs the NEXT unit), chainable, and
  // never re-merges what STEP 8.62 split (the size guard) or what 8.65
  // attached (dot-leader/number guards). Kill-switch:
  // disableFragmentReattach.
  if (_disableFragmentReattach) return { paras: presetSeparate
    ? splitByHangingGroups(ordered, INDENT_THRESHOLD)
    : ordered, slice: slices, pageW, pageH };
  const reattached = reattachTornFragments(
    ordered,
    pageW,
    slices.detected ? slices.boundaries : undefined,
  );
  // LAYOUT-FIX-23: the STEP 9.65 caption chain assembly does NOT run here —
  // it runs in buildParagraphs ABOVE both output paths of the caption-
  // subtraction loop (see the assembleCaptionOutput wrapper there). Keeping
  // it out of runLayoutPass preserves the single-application contract (the
  // loop's PASS 2 would otherwise reset the assembly's diagnostics and
  // assemble a feed whose caption units were already subtracted away).
  // ── STEP 9.7: Split hanging-group chains (LAYOUT-FIX-15, 'separate') ─
  // Table row labels whose vertical ink gaps are too tight for the
  // occupancy grid (measured on grading p4: 0.8–1.4pt gaps at a 9.4pt
  // pitch — below any grid resolution that still keeps prose paragraphs
  // intact) chain into one unit via STEP 6. The chain's internal
  // flush/indent structure is the only separating signal — see
  // splitByHangingGroups. Preset-scoped: 'standard' output is byte-identical.
  if (presetSeparate) {
    return { paras: splitByHangingGroups(reattached, INDENT_THRESHOLD), slice: slices, pageW, pageH };
  }
  return { paras: reattached, slice: slices, pageW, pageH };
  } finally {
    _preserveStyle = false;
    // Stage 2.2 (Q6): reset the new settings too.
    _columnGapThreshold = DEFAULT_COLUMN_GAP_THRESHOLD;
    _decorationThreshold = DEFAULT_DECORATION_THRESHOLD;
    // LAYOUT-FIX-3 (2026-09-16): reset the kill-switch flags too.
    _disableFragmentAbsorption = false;
    _disableFigureBandMerge = false;
    // LAYOUT-FIX-6 (2026-09-16): reset the new kill-switch flags too.
    _disableStyleFlowGuard = false;
    _disableTocRepair = false;
    // LAYOUT-FIX-8 (2026-09-17): reset the new kill-switch flag too.
    _disableNonAdjacentSplit = false;
    // LAYOUT-FIX-11 (2026-09-17): reset the heading-split kill-switch too.
    _disableHeadingSplit = false;
    // LAYOUT-FIX-13: reset the torn-fragment re-attach kill-switch too.
    _disableFragmentReattach = false;
    // LAYOUT-FIX-14: reset the font-homogeneity kill-switch too.
    _disableFontClassSplit = false;
    // LAYOUT-FIX-22: reset the single-line bridge kill-switch too.
    _disableSingleLineBridge = false;
    // LAYOUT-FIX-10 (2026-09-17): re-enable the cross-page memory module
    // flag (the file context itself is owned/reset by the production entry
    // points — a stray `false` here must not leak into the next document).
    setColumnMemoryEnabled(true);
  }
}

// ── STEP 9.6 (LAYOUT-FIX-13): torn-fragment re-attachment ───────────────────

/** Terminal punctuation: a block ending in one of these is a COMPLETE
 * sentence/paragraph and never absorbs its successor. */
const REATTACH_TERMINALS = new Set(['.', '!', '?', ':', ';', '…', '«', '»', '\u201C', '\u201D', '\u2018', '\u2019', '›', '\u203A']);
/** Size tolerance for the A/B dominant-size compatibility guard (pt). The
 * calibrated separations: book subheadings 9.79 vs body 9.04 (0.75 apart —
 * a STEP 8.62 split must STAY split); captions 8.02 vs body 9.03 (1.01). */
const REATTACH_SIZE_TOL = 0.5;
/** Left-edge alignment tolerance (pt): a continuation block starts at the
 * column's flush edge like its predecessor; a mid-line stray fragment
 * (the D1 drift class: «and»/«thickness») starts mid-column. */
const REATTACH_LEFT_TOL = 8;
/** Horizontal-overlap fraction (of the narrower unit) required when the
 * columnId structural check is unavailable (single-map pages). */
const REATTACH_OVERLAP_FRAC = 0.7;
/** A superscript footnote span is this much smaller than the unit's median
 * size («…tumors. 5,6» — the 5.26pt refs against the 9.03 body). */
const REATTACH_SUP_DELTA = 2.5;
/** LAYOUT-FIX-13 (table guard): minimum words in ONE visual row for the unit
 * to count as PROSE. The table-keep calibration (emul3, try.pdf p2/p4/p5):
 * table rows are 1–5 words, prose rows are 7+. A torn body continuation
 * always carries at least one full prose row; a vertical sequence of table
 * cells (grading p2 «Nucleolar prominence/» + «chromatin clusters»…, p4
 * P-value column «.002 d / .050 / .145…») never does — and without this
 * guard the chain walked the whole cell column (the 133pt jump u17→u22
 * on grading p4 came from chained adjacencies, not one leap). */
const REATTACH_PROSE_WORDS = 6;

function medianNum(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Spans of a unit in VISUAL order (rows clustered by ≥35% y-overlap,
 * rows by top, spans within a row by left) — the same clustering the
 * queue's normalizeParagraph and the DOM's spansToHtml use, so the text
 * assembled here matches what the block will actually read like. */
function visualRows(p: Paragraph): { spans: InputRect[]; y0: number; y1: number }[] {
  const rows: { spans: InputRect[]; y0: number; y1: number }[] = [];
  for (const s of p.spans || []) {
    const h = s.bottom - s.top;
    if (!(h > 0)) continue;
    let best: (typeof rows)[0] | null = null;
    let bestFrac = 0;
    for (const row of rows) {
      const ov = Math.min(row.y1, s.bottom) - Math.max(row.y0, s.top);
      if (ov <= 0) continue;
      const frac = ov / Math.min(row.y1 - row.y0, h);
      if (frac > bestFrac) { bestFrac = frac; best = row; }
    }
    if (best && bestFrac >= 0.35) {
      best.spans.push(s);
      best.y0 = Math.min(best.y0, s.top);
      best.y1 = Math.max(best.y1, s.bottom);
    } else {
      rows.push({ spans: [s], y0: s.top, y1: s.bottom });
    }
  }
  rows.sort((a, b) => a.y0 - b.y0);
  for (const row of rows) row.spans.sort((a, b) => a.left - b.left);
  return rows;
}

function visualSpans(p: Paragraph): InputRect[] {
  return visualRows(p).flatMap(row => row.spans);
}

/** True when at least one visual row is a full PROSE row (≥
 * REATTACH_PROSE_WORDS words) — table cell blocks never qualify, torn
 * body continuations always do. */
function hasProseRow(p: Paragraph): boolean {
  for (const row of visualRows(p)) {
    const words = row.spans
      .map(s => (typeof s.text === 'string' ? s.text : ''))
      .join(' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length >= REATTACH_PROSE_WORDS) return true;
  }
  return false;
}

// ── LAYOUT-FIX-16: post-loop caption subtraction helpers ────────────────

/** Max visual rows in a subtractable caption unit. Safety cap: a unit whose
 * prefix matches but which merged with its TABLE body (20+ rows on the
 * grading tables) must never subtract the whole furniture block; real
 * captions in the corpus measure 2–9 rows (Fig 2.12/2.13: label + 8). */
const CAPTION_SUBTRACT_MAX_ROWS = 16;
/** Ink x-gap (pt) between two units' spans for the page to count as having
 * column evidence. Real gutters in the corpus: 10pt (try4) – 43pt; the
 * paragraph px boxes carry grid quantization (+cellSize) and pdfjs width
 * overstatement, so the comparison uses SPAN ink edges and 20pt safely
 * separates a gutter from an intra-column justified gap (≤ ~12pt). */
const COLUMN_EVIDENCE_XGAP = 20;
// LAYOUT-FIX-17c: span-side floor for spansHaveColumnEvidence (see below).
const SPAN_EVIDENCE_MIN = 8;
/** A single stray D1-drift word («and», «thickness») must not fabricate
 * column evidence: both units must be real multi-span blocks. */
const COLUMN_EVIDENCE_MIN_SPANS = 2;
const COLUMN_EVIDENCE_MIN_W = 36;
const COLUMN_EVIDENCE_MIN_H = 8;

/** LAYOUT-FIX-16: front-matter titles that MATCH the caption prefix
 * vocabulary but are page HEADINGS — never furniture to subtract. */
const TITLE_NOT_CAPTION_RE =
  /^(?:table\s+of\s+contents|contents|list\s+of\s+(?:tables|figures|illustrations|schemes))\b[.:]?\s*$/i;

/** LAYOUT-FIX-16: the unit's first non-empty visual row, joined. */
function firstRowTextOf(p: Paragraph): string {
  for (const row of visualRows(p)) {
    const t = row.spans
      .map(s => (typeof s.text === 'string' ? s.text : ''))
      .join('')
      .trim();
    if (t) return t;
  }
  return '';
}

/**
 * LAYOUT-FIX-16: which PASS-1 units are trusted CAPTIONS to subtract from
 * the feed before the second pass. Conservative THREE-part gate (all must
 * hold — measured on the corpus classes):
 *   1. TEXT — the first non-empty visual row starts with a caption prefix
 *      (CAPTION_START_RE: Figure/Fig(s)/Table(s)/Box/Scheme/Plate/Chart +
 *      RU forms; plurals per FIX-14). Runs with the post-14 pattern: the
 *      dispatcher returns before reaching here whenever
 *      disableFontClassSplit is set, so the module flag is always false
 *      (post-14) at the call site.
 *   2. SIZE — ≤ CAPTION_SUBTRACT_MAX_ROWS visual rows (see the constant).
 *   3. FONT CLASS — the unit's dominant (size-class 0.5pt × family) is NOT
 *      the page-modal class weighted by span count. The modal class IS the
 *      body; a body sentence starting «Table 1 shows…» is modal-class
 *      prose and is never subtracted (the FIX-14 adversarial class). A
 *      caption set in the body's own size+family (same-font columns) is
 *      also not subtracted — nothing to separate it by, and the loop's
 *      premise (captions are already well-formed units) fails anyway.
 */
function classifyCaptionUnitsForSubtraction(units: Paragraph[]): Paragraph[] {
  if (units.length === 0) return [];
  const classKey = (p: Paragraph) =>
    `${Math.round(p.dominantSize * 2) / 2}|${p.dominantFamily}`;
  const weight = new Map<string, number>();
  for (const p of units) {
    const k = classKey(p);
    weight.set(k, (weight.get(k) || 0) + Math.max(1, p.spans.length));
  }
  let modal = '';
  let modalW = -1;
  for (const [k, w] of weight) {
    if (w > modalW) { modal = k; modalW = w; }
  }
  const out: Paragraph[] = [];
  for (const p of units) {
    const t = firstRowTextOf(p);
    if (!t || !isCaptionStartText(t)) continue;
    // Front-matter TITLES share the caption vocabulary but are page
    // headings, not captions (try.pdf p1: «Table of contents», 9pt,
    // single span — classified, subtracted, a pure wasted pass; the
    // output stayed identical only because the title touches nothing).
    if (TITLE_NOT_CAPTION_RE.test(t)) continue;
    if (visualRows(p).length > CAPTION_SUBTRACT_MAX_ROWS) continue;
    if (classKey(p) === modal) continue;
    out.push(p);
  }
  return out;
}

/**
 * LAYOUT-FIX-16: does the page (as PASS 1 sees it) carry evidence of a
 * MULTI-column layout — ≥1 pair of real units positioned SIDE-BY-SIDE
 * (x-disjoint cores sharing a y-band)?
 *
 * The core box of a unit is the MEDIAN of its span lefts / rights, not the
 * min/max: interleave BRIDGES are exactly long invisible tails (measured on
 * p61-solo: dotted 9.03pt tails reaching 324–326pt, a 5.26pt footnote ref
 * ending at 323.4pt) that stretch the min/max box across the gutter and
 * hide the very column structure this gate must see. Medians ignore them
 * (tails are < 50% of a body unit's spans; line-level feeds make the
 * median the typical line start/end = the column edges themselves).
 * Containment (a full-width caption spanning both columns) does not
 * count: the pair must be side-by-side with a real gutter.
 *
 * This gate keeps the loop away from genuinely single-column pages whose
 * detection failure is CORRECT (their body must not be rebuilt — the
 * corpus byte-parity contract), including single-column pages carrying
 * ordinary «Figure 1 …» captions: stacked same-column units have
 * overlapping cores and never pair.
 */
function pageHasColumnEvidence(units: Paragraph[]): boolean {
  const med = (xs: number[]): number => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const boxes: { l: number; r: number; t: number; b: number }[] = [];
  for (const p of units) {
    if (p.spans.length < COLUMN_EVIDENCE_MIN_SPANS) continue;
    if ((p.pxRight - p.pxLeft) < COLUMN_EVIDENCE_MIN_W) continue;
    if ((p.pxBottom - p.pxTop) < COLUMN_EVIDENCE_MIN_H) continue;
    boxes.push({
      l: med(p.spans.map(s => s.left)),
      r: med(p.spans.map(s => s.right)),
      t: p.pxTop,
      b: p.pxBottom,
    });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const gap = Math.max(a.l - b.r, b.l - a.r); // > 0 only when cores are x-disjoint
      if (gap < COLUMN_EVIDENCE_XGAP) continue;
      const yOv = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (yOv >= Math.max(6, 0.3 * Math.min(a.b - a.t, b.b - b.t))) return true;
    }
  }
  return false;
}

/** LAYOUT-FIX-17c: SPAN-based column evidence on the subtracted feed.
 * Two x-disjoint span clusters (by midpoint) whose y-extents overlap —
 * the atoms the PASS-2 slicer will actually judge. Full-width furniture
 * (the subtracted captions, wide bridges) is excluded by the width
 * filter; a single-column page keeps all its midpoints on one side and
 * never pairs. Floor: ≥ SPAN_EVIDENCE_MIN spans per side, y-overlap ≥
 * max(6, 30% of the shorter side's height). Calibrated on try5 p1/p2
 * (feeds of 86/72 spans after caption subtraction: L/R ≈ 40/45 and
 * ≈30/42) while a caption-only side (p61-solo after subtraction: ≈0
 * right spans) stays false — the loop must not fire there. */
function spansHaveColumnEvidence(feed2: InputRect[], pageW: number): boolean {
  if (!feed2 || feed2.length === 0) return false;
  const FURNITURE_W = 0.6 * pageW;
  let lN = 0, rN = 0;
  let lTop = Infinity, lBot = -Infinity, rTop = Infinity, rBot = -Infinity;
  for (const r of feed2) {
    if (r.right - r.left >= FURNITURE_W) continue; // full-width furniture
    const mid = (r.left + r.right) / 2;
    if (mid < pageW / 2) {
      lN++;
      if (r.top < lTop) lTop = r.top;
      if (r.bottom > lBot) lBot = r.bottom;
    } else {
      rN++;
      if (r.top < rTop) rTop = r.top;
      if (r.bottom > rBot) rBot = r.bottom;
    }
  }
  if (lN < SPAN_EVIDENCE_MIN || rN < SPAN_EVIDENCE_MIN) return false;
  const ov = Math.min(lBot, rBot) - Math.max(lTop, rTop);
  if (ov <= 0) return false;
  return ov >= Math.max(6, 0.3 * Math.min(lBot - lTop, rBot - rTop));
}

/** LAYOUT-FIX-16: internals for the audit harness / unit suite (same
 * module pattern as __columnSlicerInternals). */
export const __captionSubtractInternals = {
  classify: classifyCaptionUnitsForSubtraction,
  columnEvidence: pageHasColumnEvidence,
  spanColumnEvidence: spansHaveColumnEvidence,
  firstRowText: firstRowTextOf,
  sameSpanSequence: sameSpanSequence,
  lastRun: () => _lastCaptionSubtract,
};

/** LAYOUT-FIX-16: do the two ordered unit lists carry the SAME span
 * sequence at every position (span identity — the exact InputRect
 * objects)? Used by the dispatcher's no-op guarantee. */
function sameSpanSequence(a: Paragraph[], b: Paragraph[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ua = a[i];
    const ub = b[i];
    if (ua.spans.length !== ub.spans.length) return false;
    for (let k = 0; k < ua.spans.length; k++) {
      if (ua.spans[k] !== ub.spans[k]) return false;
    }
  }
  return true;
}

function unitVisualText(p: Paragraph): string {
  return visualSpans(p)
    .map(s => (typeof s.text === 'string' ? s.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the unit is a WIDE/global element (full-width caption or table
 * row): either it crosses a validated column boundary by > WIDE_MARGIN, or
 * (no boundaries) it spans >55% of the page width. */
function isWideUnit(p: Paragraph, pageW: number, boundaries?: number[]): boolean {
  if (boundaries && boundaries.length > 0) {
    for (const b of boundaries) {
      if (p.pxLeft < b - 36 && p.pxRight > b + 36) return true;
    }
    return false;
  }
  return p.pxRight - p.pxLeft > pageW * 0.55;
}

function isListItemStart(p: Paragraph): boolean {
  const first = visualSpans(p).find(s => typeof s.text === 'string' && s.text.trim().length > 0);
  const t = (first?.text ?? '').trim();
  return /^[•·▪‣◦\-–—]\s/.test(t) || /^\(?\d{1,3}[.)]\s/.test(t);
}

/** STEP 9.6 core: can B be the continuation torn out of A? See the buildParagraphs
 * comment for the guard list and calibration. */
function canReattachTornPair(
  a: Paragraph,
  b: Paragraph,
  pageW: number,
  boundaries?: number[],
): boolean {
  const textA = unitVisualText(a);
  const textB = unitVisualText(b);
  if (!textA || !textB) return false;

  // Same column (structural first, geometric fallback) + not wide.
  if (isWideUnit(a, pageW, boundaries) || isWideUnit(b, pageW, boundaries)) return false;
  if (a.columnId !== undefined && b.columnId !== undefined) {
    if (a.columnId !== b.columnId) return false;
  } else {
    const ov = Math.min(a.pxRight, b.pxRight) - Math.max(a.pxLeft, b.pxLeft);
    if (ov < REATTACH_OVERLAP_FRAC * Math.min(a.pxRight - a.pxLeft, b.pxRight - b.pxLeft)) return false;
  }

  // Left-edge alignment (flush column starts; strays start mid-column).
  if (Math.abs(b.pxLeft - a.pxLeft) > REATTACH_LEFT_TOL) return false;

  // Vertical adjacency: B right below A, within ~1.2 leadings.
  const gap = b.pxTop - a.pxBottom;
  const gapMax = Math.max(12, 1.4 * Math.max(a.dominantSize, b.dominantSize));
  if (gap < -1.5 || gap > gapMax) return false;

  // Size + family compatibility (headings/captions/labels excluded).
  if (Math.abs(a.dominantSize - b.dominantSize) > REATTACH_SIZE_TOL) return false;
  if (a.dominantFamily !== b.dominantFamily) return false;

  // List / reference / TOC entries are atomic items, never continuations.
  if (isListItemStart(a) || isListItemStart(b)) return false;
  if (/\.{2,}\s*\d+$/.test(textA)) return false; // TOC dot-leader + page

  // Table guard (LAYOUT-FIX-13): both units must carry at least one full
  // PROSE row — vertical table-cell sequences (1–5 words per row) look
  // like continuations to every other guard (same column, same size,
  // adjacent, non-terminal, lowercase) but must never merge. Calibration:
  // grading p2 label column, p4 P-value column.
  if (!hasProseRow(a) || !hasProseRow(b)) return false;

  // A must end MID-SENTENCE…
  const lastChar = textA.slice(-1);
  if (REATTACH_TERMINALS.has(lastChar)) return false;
  // …and not on a superscript footnote reference («…tumors. 5,6»).
  const vspans = visualSpans(a);
  const lastSpan = vspans[vspans.length - 1];
  if (lastSpan && typeof lastSpan.fontsize === 'number') {
    const medA = medianNum(vspans.map(s => (typeof s.fontsize === 'number' ? s.fontsize : a.dominantSize)).filter(Number.isFinite));
    if (lastSpan.fontsize <= medA - REATTACH_SUP_DELTA) return false;
  }

  // B must start lowercase (a continuation is never a new sentence).
  const firstAlpha = textB.match(/[A-Za-zА-Яа-яЁё]/);
  if (!firstAlpha || firstAlpha[0] !== firstAlpha[0].toLowerCase()) return false;

  return true;
}

/** Absorb B into A (span union, box union, dominant size/family by mode). */
function absorbInto(a: Paragraph, b: Paragraph): void {
  a.spans.push(...b.spans);
  a.pxLeft = Math.min(a.pxLeft, b.pxLeft);
  a.pxTop = Math.min(a.pxTop, b.pxTop);
  a.pxRight = Math.max(a.pxRight, b.pxRight);
  a.pxBottom = Math.max(a.pxBottom, b.pxBottom);
  a.width = a.pxRight - a.pxLeft;
  a.height = a.pxBottom - a.pxTop;
  if (a.columnId === undefined) a.columnId = b.columnId;
  const sizeCount = new Map<number, number>();
  const famCount = new Map<string, number>();
  for (const s of a.spans) {
    if (typeof s.fontsize === 'number' && Number.isFinite(s.fontsize)) {
      const k = +s.fontsize.toFixed(2);
      sizeCount.set(k, (sizeCount.get(k) || 0) + 1);
    }
    const fam = s.fontname || 'unknown';
    famCount.set(fam, (famCount.get(fam) || 0) + 1);
  }
  let bestSize = a.dominantSize, bestSizeN = -1;
  for (const [v, n] of sizeCount) if (n > bestSizeN) { bestSize = v; bestSizeN = n; }
  let bestFam = a.dominantFamily, bestFamN = -1;
  for (const [v, n] of famCount) if (n > bestFamN) { bestFam = v; bestFamN = n; }
  a.dominantSize = bestSize;
  a.dominantFamily = bestFam;
}

/** STEP 9.6: merge reading-order-adjacent units where A ends mid-sentence and
 * B continues it (see the guard list in buildParagraphs). Chainable — the
 * merged unit keeps absorbing while the guards hold. */
function reattachTornFragments(
  paragraphs: Paragraph[],
  pageW: number,
  boundaries?: number[],
): Paragraph[] {
  if (!paragraphs || paragraphs.length < 2) return paragraphs;
  const out: Paragraph[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const cur = paragraphs[i];
    while (true) {
      const next = paragraphs[i + 1];
      if (!next) break;
      if (!canReattachTornPair(cur, next, pageW, boundaries)) break;
      absorbInto(cur, next);
      i++;
    }
    out.push(cur);
  }
  return out;
}

// ── STEP 9.65 (LAYOUT-FIX-23): caption chain assembly ─────────────────────

/** STEP 9.65: caption marker with a NUMBER — the start signature the
 * assembly matches (unlike CAPTION_START_RE, which is the prefix-only
 * label test). Requires the leading «Fig. 1.» / «FIGURE 8:» /
 * «Figures 1–6.» / «Table 4.» run so a sentence merely starting with
 * «Figures» never qualifies; the marker itself may span 1–2 spans. */
const CAPTION_CHAIN_START_RE =
  /^(?:figures?|figs?|tables?|box|boxes|scheme|plate|chart|рис\.?|табл\.?|схема|рисунок|рисунки)\.?\s*(?:\d{1,3}\b|[†‡*])/i;
/** STEP 9.65: max vertical gap between a caption line and its continuation
 * (pt): max(floor, 1.2 × dominant size). Calibrated on the corpora — real
 * caption-continuation pairs measure 1.4–4.0pt (books) and −1.0…1.5
 * (grid-quantized overlaps, pleomorphic); the 6pt floor covers scan-noise
 * rows (meningiomas 1996). MUST stay below the Table-label→table-title
 * separation (14pt, consensus p5 «Table 4.» → its stacked title) and the
 * Wiley book legend separations (16–48pt). */
const CAPTION_LEADING_MAX = 1.2;
/** STEP 9.65: vertical-gap floor (pt). */
const CAPTION_GAP_FLOOR = 6;
/** STEP 9.65: bbox vertical overlap tolerance (pt): grid-quantized unit
 * boxes of consecutive caption lines can overlap by up to ~1pt (the
 * pleomorphic p3 pairs measure −1.0/−0.5), never more. */
const CAPTION_GAP_TOL = -2;
/** STEP 9.65: caption size tolerance (pt) — same calibration as
 * REATTACH_SIZE_TOL: book subheads 9.79 vs body 9.04 (0.75 — stay split),
 * captions 8.02 vs body 9.03 (1.01 — never merge), real caption pairs
 * share the size exactly (8.97/8.97, 9.5/9.5, 9.96/9.96). */
const CAPTION_SIZE_TOL = 0.5;
/** STEP 9.65: x-band overlap fraction (of the narrower unit) OR left-edge
 * delta (pt). Real pairs: overlap ≥ 0.95 or flush left edges (hanging
 * indent — the pleomorphic continuation starts 11.8pt LEFT of the marker
 * line); a unit in the neighbouring column overlaps ≤ 0.21. */
const CAPTION_OVERLAP_FRAC = 0.55;
const CAPTION_LEFT_TOL = 8;
/** STEP 9.65: max continuation units absorbed by one caption start. The
 * longest split caption in the corpora is 4 units (maxillary p2: marker
 * line + 3-line tail); the cap is a runaway-chain backstop. */
const CAPTION_CHAIN_MAX = 4;

/** STEP 9.65: does the unit's first visible row start with a numbered
 * caption marker? (The match is on the FIRST ROW only — a mid-block
 * «…Figure 2. …» reference inside body text never qualifies.) */
function isCaptionChainStart(p: Paragraph): boolean {
  const rows = visualRows(p);
  for (const row of rows) {
    const t = row.spans.map(s => (typeof s.text === 'string' ? s.text : '')).join('').trim();
    if (t) return CAPTION_CHAIN_START_RE.test(t);
  }
  return false;
}

/** STEP 9.65: split a caption-start unit's spans into MARKER spans (the
 * leading «Fig. 1.» run of the first visual row) and BODY spans (the rest
 * of the unit — the caption text whose family the continuation must
 * match). Returns null when the marker does not assemble from whole
 * spans (defensive — isCaptionChainStart already screened the unit).
 * When the whole first row collapses into one span (marker + text
 * typeset as one run), bodySpans falls back to the unit's OTHER rows,
 * then to that very span (a one-run row still carries the body family —
 * the marker share of its width is a minority). */
function splitCaptionMarkerSpans(p: Paragraph): { markerSpans: InputRect[]; bodySpans: InputRect[] } | null {
  const rows = visualRows(p);
  const firstRow = rows.find(r => r.spans.some(s => typeof s.text === 'string' && s.text.trim().length > 0));
  if (!firstRow) return null;
  const spans = [...firstRow.spans].sort((a, b) => a.left - b.left);
  let acc = '';
  for (let i = 0; i < spans.length; i++) {
    acc += (typeof spans[i].text === 'string' ? spans[i].text : '');
    const trimmed = acc.replace(/^\s+/, '');
    const m = CAPTION_CHAIN_START_RE.exec(trimmed);
    if (m && trimmed.length >= m[0].length) {
      // The BODY is the WHOLE unit minus the marker spans: the first row's
      // remainder plus every span of the unit's later rows (a caption's
      // body family must summarise all its lines, not just the first).
      const laterRows = rows.slice(rows.indexOf(firstRow) + 1).flatMap(r => r.spans);
      const firstRowBody = spans.slice(i + 1);
      const bodySpans = [...firstRowBody, ...laterRows];
      if (bodySpans.length > 0) return { markerSpans: spans.slice(0, i + 1), bodySpans };
      // marker-only unit («Fig. 3.»): nothing but the marker — the caller's
      // family comparison degrades to marker-vs-B (PS/MT-normalized).
      return { markerSpans: spans.slice(0, i + 1), bodySpans: spans.slice(0, i + 1) };
    }
  }
  return null;
}

/** STEP 9.65: dominant family of the caption BODY spans (span count, ties
 * broken by first occurrence — same rule as getPrimaryFamily), with the
 * 6.9 bridge's PS/MT-tail normalization so producer suffix noise
 * («TimesNewRomanPS» from -BoldMT vs «TimesNewRomanPSMT») compares equal. */
function captionBodyFamily(p: Paragraph): string | null {
  const split = splitCaptionMarkerSpans(p);
  if (!split || split.bodySpans.length === 0) return null;
  const counts = new Map<string, number>();
  let first = '';
  for (const s of split.bodySpans) {
    const fam = getFontFamily(s.fontname, _preserveStyle);
    if (!first) first = fam;
    counts.set(fam, (counts.get(fam) || 0) + 1);
  }
  let best = first, bestN = -1;
  for (const [fam, n] of counts) {
    if (n > bestN || (n === bestN && fam === first)) { best = fam; bestN = n; }
  }
  return best.replace(/PS(?:MT)?$/, '').replace(/MT$/, '');
}

/** STEP 9.65: TABLE-GRID discriminator for B. A unit whose visual rows
 * split into ≥ CAPTION_GRID_CLUSTERS x-clusters (inter-cluster gaps ≥
 * X_CLUSTER_GAP — the STEP 7.3 spacing scale) is a table LATTICE row
 * (consensus p5 «Tubule formation | Most tumors (>75%) | Moderate degree
 * (10-75%) | Little or none (<10%)» — 4 cells) and never joins a caption;
 * a caption legend tail is one or two clusters per row (the glial p5
 * two-column legend «As reported previously, n ¼ 10 … undefined n ¼ 6»
 * measures 2 — a legit cross-column legend). Replaces the isWideUnit
 * test, which rejected legitimate full-width captions and cross-column
 * legends (consensus p11 «Table 9.» x=57–555; glial p5 B x=44–376). */
const CAPTION_GRID_CLUSTERS = 3;

/** STEP 9.65: max visual rows in a caption continuation unit. Real
 * legend tails in the corpora measure 1–11 rows (sabattini p5 «associated
 * with pink strands of osteoid matrix…» — a 108pt, ~11-line legend); a
 * DENSE table body merged into one unit by STEP 6 runs 20+ rows
 * (consensus p5 «Tubule formation | Most tumors (>75%) | …» — 31 spans,
 * 228pt tall). 14 splits the two classes. */
const CAPTION_MAX_TAIL_ROWS = 14;
/** STEP 9.65: same-line companion cells that mark B's row as a TABLE
 * row (separate x-disjoint units inside the caption's x-band sharing B's
 * first line — consensus p11 «M1*», «Single tumor localization», «< 3 cm
 * (T1)…» around «Regional mastectomy (M1-M2 + axillary lymph node)»). */
const CAPTION_COMPANION_CELLS = 2;
/** STEP 9.65: min x-gap (pt) for a unit to count as a separate COMPANION
 * cell (visual gaps under this are word spacing). */
const CAPTION_COMPANION_XGAP = 6;

// ── STEP 9.65 / LAYOUT-FIX-24: dangling-tail rescue ──────────────────────

/** LFIX-24: sentence-complete terminator test for caption tails. A
 * caption start whose text does NOT end this way is the user's
 * «оборванное предложение» — the rescue's trigger; an absorbed tail MUST
 * end this way so the merged caption reads complete. Calibrated on the
 * corpora: real tails end «receptor.» / «Mast Cell Tumors.» /
 * «Cutaneous Mast Cell Tumor.» / «= 25 μm.» (all periods); bare closing
 * quotes/brackets also close a block («…(continued)» 2tier p4,
 * «…(Adapted from Willard 2008 and Jergens 2016)» try4 p3). A comma is
 * deliberately NOT complete — mid-enumeration legend lines
 * («…ER, Estrogen receptor;») continue below. */
const CAPTION_TAIL_COMPLETE_RE = /(?:[.!?:;…][")'\u201D\u2019\]]*)$|[)"\]'”’]$/;
/** LFIX-24: max WORDS in a rescue tail — the «не body» bound (user
 * heuristic #3). A body-paragraph line runs 6+ words; every real tail in
 * the corpora measures 1–4 words («receptor.», «Mast Cell Tumors.»,
 * «Cutaneous Mast Cell Tumor.», «= 25 μm.»). The sysreview p3 3-row
 * header stack (7 words) and try p4 hallmark box (12 words) are rejected
 * here before the punctuation gate even fires. */
const CAPTION_TAIL_WORDS = 5;
/** LFIX-24: max visual ROWS in a rescue tail — second «не body» bound.
 * Real tails are 1–2 rows (a wrapped title continuation); table header
 * stacks (try p4 «Sustaining proliferative signaling / Evading growth
 * suppressors / Resisting cell death / …» — 4 rows) never qualify. */
const CAPTION_TAIL_ROWS = 3;
/** LFIX-24: H-case max x-gap (pt) between the head's last-row right edge
 * and the tail's left edge on the same visual row. Real same-line tails
 * sit flush (0pt — pleomorphic p4 «…HE. Bar» + «= 25 μm.»); column
 * gutters measure 32–43pt (BRIDGE_GAP_MAX calibration), so 12 splits a
 * continuation from a neighbouring column's first line. */
const CAPTION_TAIL_XGAP = 12;
/** LFIX-24: same-row y-overlap fraction for the H-case (same calibration
 * as the STEP 6.9 bridge — a tail shares its row with the head's LAST
 * visual row). */
const CAPTION_TAIL_ROWOVL = 0.6;

/** LFIX-24: per-row texts of a unit (visual rows, spans left-sorted) —
 * the material the punctuation/word-count gates read. */
function captionRowTexts(p: Paragraph): string[] {
  return visualRows(p).map(r =>
    [...r.spans].sort((a, b) => a.left - b.left)
      .map(s => (typeof s.text === 'string' ? s.text : '')).join(''));
}

/** LFIX-24: does the unit's LAST non-empty row end sentence-complete? */
function captionEndsComplete(p: Paragraph): boolean {
  const rows = captionRowTexts(p).map(t => t.replace(/\s+$/, ''));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].length > 0) return CAPTION_TAIL_COMPLETE_RE.test(rows[i]);
  }
  return false;
}

/** LFIX-24: total word count over ALL of the unit's rows (a wrapped
 * title tail «Cutaneous Mast Cell / Tumor.» counts 4, not 2+2). */
function captionWordCount(p: Paragraph): number {
  const joined = captionRowTexts(p).join(' ').trim();
  if (!joined) return 0;
  return joined.split(/\s+/).filter(w => w.length > 0).length;
}

/** LFIX-24 core: can B be the dangling TAIL of caption-start A? The
 * rescue branch of STEP 9.65 — fires ONLY when A's text ends
 * mid-sentence (no terminal punctuation), and replaces the main chain's
 * hasProseRow + family gates with the user-calibrated «не body» bounds:
 *   • B is NOT a caption start itself (the next «Fig. …» below a
 *     truncated caption is the next figure — pleomorphic p3's stacked
 *     Fig. 1/2/3 band);
 *   • B is not a list/reference item, not a table lattice;
 *   • B ≤ CAPTION_TAIL_WORDS words and ≤ CAPTION_TAIL_ROWS rows — a
 *     body paragraph or a table header stack never qualifies (user
 *     heuristic #3 «не является body»);
 *   • B ends sentence-complete (the merged caption must read closed);
 *   • |sizeA − sizeB| ≤ CAPTION_SIZE_TOL (same calibration as the main
 *     chain — book subheads stay split);
 *   • V-case: gap ∈ [CAPTION_GAP_TOL, max(CAPTION_GAP_FLOOR,
 *     CAPTION_LEADING_MAX × size)] (user heuristic #2 «одна сразу под
 *     другой»), x-band overlap/left-flush as the main chain, no ≥2
 *     companion cells, same columnId when both are known;
 *   • H-case: B sits on A's LAST visual row (y-overlap ≥
 *     CAPTION_TAIL_ROWOVL — user heuristic #2's same-line form), flush
 *     to the right of that row's ink within CAPTION_TAIL_XGAP, one row
 *     only, and NOTHING further right on the row (a table row's cells
 *     have right siblings; a line tail is the last thing on its line).
 *     columnId is deliberately NOT checked here: a same-line tail
 *     straddling the slicer's column boundary is exactly the artifact
 *     being rescued (pleomorphic p4 Fig. 5 — colId 0 vs 1);
 *   • FAMILY is deliberately NOT checked: the two surviving tail
 *     classes are producer-split symbol-font scale labels («= 25 μm.» —
 *     μ from Universal-GreekwithMathPi) and subset-alias faces of one
 *     typeface (AdvPAC5A vs AdvPAC59). The bounds above (tiny + complete
 *     + same size + flush position under an UNPUNCTUATED caption start)
 *     are the family evidence replaces. */
function canAbsorbCaptionTail(
  a: Paragraph,
  b: Paragraph,
  companions = 0,
  horizontal = false,
): boolean {
  // The next figure/table caption is never a continuation.
  if (isCaptionChainStart(b)) return false;
  // List / reference items never join a caption.
  if (isListItemStart(b)) return false;
  // Table lattice rows never join a caption.
  if (captionRowIsTableLattice(b)) return false;
  const rowsB = visualRows(b).length;
  if (rowsB < 1 || rowsB > CAPTION_TAIL_ROWS) return false;
  // A same-line tail is a single row by construction.
  if (horizontal && rowsB > 1) return false;
  // «Не body»: a rescue tail is a handful of words.
  const wordsB = captionWordCount(b);
  if (wordsB < 1 || wordsB > CAPTION_TAIL_WORDS) return false;
  // The tail must CLOSE the sentence — the merged caption reads complete.
  if (!captionEndsComplete(b)) return false;
  // Size compatibility (headings vs captions vs body calibration).
  if (Math.abs(a.dominantSize - b.dominantSize) > CAPTION_SIZE_TOL) return false;
  if (horizontal) {
    // Same visual row as A's LAST row …
    const lastRow = visualRows(a)[visualRows(a).length - 1];
    if (!lastRow) return false;
    const yOv = Math.min(lastRow.y1, b.pxBottom) - Math.max(lastRow.y0, b.pxTop);
    const hMin = Math.min(lastRow.y1 - lastRow.y0, b.pxBottom - b.pxTop);
    if (hMin <= 0 || yOv < CAPTION_TAIL_ROWOVL * hMin) return false;
    // … flush to the right of that row's ink …
    let rowRight = -Infinity;
    for (const s of lastRow.spans) rowRight = Math.max(rowRight, s.right);
    if (!Number.isFinite(rowRight)) return false;
    const xgap = b.pxLeft - rowRight;
    if (xgap < -2 || xgap > CAPTION_TAIL_XGAP) return false;
  } else {
    // Table-row companionship (same calibration as the main chain).
    if (companions >= CAPTION_COMPANION_CELLS) return false;
    // Same column (structural check first, geometric fallback).
    if (a.columnId !== undefined && b.columnId !== undefined) {
      if (a.columnId !== b.columnId) return false;
    }
    // Vertical adjacency: B right below A within ~1.2 leadings.
    const gap = b.pxTop - a.pxBottom;
    const gapMax = Math.max(CAPTION_GAP_FLOOR, CAPTION_LEADING_MAX * Math.max(a.dominantSize, b.dominantSize));
    if (gap < CAPTION_GAP_TOL || gap > gapMax) return false;
    // X-band: column overlap or flush left edge (hanging indent).
    const ov = Math.min(a.pxRight, b.pxRight) - Math.max(a.pxLeft, b.pxLeft);
    const wMin = Math.min(a.pxRight - a.pxLeft, b.pxRight - b.pxLeft);
    if (ov < CAPTION_OVERLAP_FRAC * wMin && Math.abs(b.pxLeft - a.pxLeft) > CAPTION_LEFT_TOL) return false;
  }
  return true;
}

/** STEP 9.65: does the unit carry a visual row that splits into ≥
 * CAPTION_GRID_CLUSTERS x-clusters at X_CLUSTER_GAP spacing — the
 * table-lattice signature (row of ≥3 cells)? Uses span-level clustering
 * exactly like splitBySizeClass: a gap ≥ X_CLUSTER_GAP between
 * consecutive spans starts a new cluster. */
function captionRowIsTableLattice(p: Paragraph): boolean {
  for (const row of visualRows(p)) {
    const spans = [...row.spans].sort((s, t) => s.left - t.left);
    let clusters = 1;
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i].left - spans[i - 1].right;
      if (gap >= X_CLUSTER_GAP) clusters++;
    }
    if (clusters >= CAPTION_GRID_CLUSTERS) return true;
  }
  return false;
}

/** STEP 9.65 core: can B be the continuation of caption-start A? See the
 * buildParagraphs STEP 9.65 comment for the full guard list.
 *   • B is NOT a caption start itself (a new «Fig. …» / «Table …» below
 *     a caption is the NEXT figure/table, never a continuation —
 *     hamartomatous FIGURE 7→8→9→10 chains, maxillary «Figure 5» →
 *     «Figure 7»);
 *   • B carries a PROSE row (≥ REATTACH_PROSE_WORDS words in one visual
 *     row) — table headers/first cells («Growth Pattern», «Category»,
 *     «Mast Cell Tumors.», «Cat.<br>No.», «Age at<br>Surgery…») are 1–4
 *     word rows and never qualify, while caption legend tails are
 *     6+ word rows («assessing histological grade in canine and feline
 *     mammary Carcinomas*.», «(E) Ki-67 (F) COX-2. DAB Chromogen. 40x.»);
 *   • B is not a TABLE LATTICE (no visual row with ≥ CAPTION_GRID_CLUSTERS
 *     x-clusters at X_CLUSTER_GAP spacing — wide multi-cell rows);
 *   • B is not a DENSE merged table body (≤ CAPTION_MAX_TAIL_ROWS visual
 *     rows — the 20-row consensus p5 lattice vs the 1–4-row real tails);
 *   • B's first line is not flanked by ≥ CAPTION_COMPANION_CELLS separate
 *     cells inside A's x-band (companionCells — a table-row signature
 *     counted by the caller over the page's units);
 *   • B is not a list/reference item («1.5 Columnar cell lesions»,
 *     «20. Howard…»);
 *   • VERTICAL: B sits right below A, gap ∈ [CAPTION_GAP_TOL,
 *     max(CAPTION_GAP_FLOOR, CAPTION_LEADING_MAX × size)] — the Wiley
 *     16–48pt legend separations, figure bands and the Table-label→
 *     stacked-title 14pt separation never qualify;
 *   • SIZE: |domA − domB| ≤ CAPTION_SIZE_TOL (same calibration as the
 *     9.6 guard — book subheads stay split);
 *   • X-BAND: overlap ≥ CAPTION_OVERLAP_FRAC of the narrower unit OR the
 *     left edges align within CAPTION_LEFT_TOL (hanging indent);
 *   • FAMILY: the caption BODY family of A (marker spans excluded — that
 *     is the whole point of this pass) equals B's dominant family under
 *     the PS/MT normalization. */
function canAbsorbCaptionContinuation(
  a: Paragraph,
  b: Paragraph,
  pageW: number,
  boundaries?: number[],
  companionCells = 0,
): boolean {
  // B is not itself a caption start (the next figure/table caption).
  if (isCaptionChainStart(b)) return false;
  // Prose evidence — table headers/first cells never qualify.
  if (!hasProseRow(b)) return false;
  // Table lattice — multi-cell rows never join a caption.
  if (captionRowIsTableLattice(b)) return false;
  // Dense table body merged into ONE unit — too many visual rows for a
  // caption legend tail.
  if (visualRows(b).length > CAPTION_MAX_TAIL_ROWS) return false;
  // Table-row companionship — B's first line flanked by ≥2 separate
  // x-disjoint cells inside the caption's x-band is a table row, not a
  // legend tail (the cells are too SHORT for hasProseRow themselves).
  if (companionCells >= CAPTION_COMPANION_CELLS) return false;
  // List / reference items never join a caption («1.5 Columnar cell
  // lesions», «20. Howard…»).
  if (isListItemStart(b)) return false;
  // Same column: structural check first, geometric fallback.
  if (a.columnId !== undefined && b.columnId !== undefined) {
    if (a.columnId !== b.columnId) return false;
  }
  // Vertical adjacency: B right below A within ~1.2 leadings.
  const gap = b.pxTop - a.pxBottom;
  const gapMax = Math.max(CAPTION_GAP_FLOOR, CAPTION_LEADING_MAX * Math.max(a.dominantSize, b.dominantSize));
  if (gap < CAPTION_GAP_TOL || gap > gapMax) return false;
  // Size compatibility (headings vs captions vs body calibration).
  if (Math.abs(a.dominantSize - b.dominantSize) > CAPTION_SIZE_TOL) return false;
  // X-band: column overlap or flush left edge (hanging indent).
  const ov = Math.min(a.pxRight, b.pxRight) - Math.max(a.pxLeft, b.pxLeft);
  const wMin = Math.min(a.pxRight - a.pxLeft, b.pxRight - b.pxLeft);
  if (ov < CAPTION_OVERLAP_FRAC * wMin && Math.abs(b.pxLeft - a.pxLeft) > CAPTION_LEFT_TOL) return false;
  // Family: A's caption BODY family (marker excluded) vs B's dominant.
  const famA = captionBodyFamily(a);
  if (!famA) return false;
  const famB = (b.dominantFamily || 'unknown').replace(/PS(?:MT)?$/, '').replace(/MT$/, '');
  return famA === famB;
}

/** STEP 9.65: assemble caption chains. For every caption-START unit A
 * (in reading order), find the GEOMETRICALLY NEXT unit below it in A's
 * x-band (min pxTop within the leading window, ANY unit — not just a
 * guards-passing one), then apply the guards to THAT unit only: a guard
 * failure stops the chain rather than skipping over the failed unit to
 * a further one (a table header row 1.5pt below a Table caption must
 * BLOCK the chain, not be jumped over). Chainable up to
 * CAPTION_CHAIN_MAX links; the absorbed unit leaves the array while A
 * keeps its slot (A is the block's topmost line — its slot is the
 * block's slot). */
function assembleCaptionChains(
  paragraphs: Paragraph[],
  pageW: number,
  boundaries?: number[],
): Paragraph[] {
  if (!paragraphs || paragraphs.length < 2) return paragraphs;
  _lastCaptionAssemblyMerges = 0;
  const absorbed = new Set<Paragraph>();
  const bases = paragraphs.filter(p => isCaptionChainStart(p));
  for (const base of bases) {
    if (absorbed.has(base)) continue; // an earlier start already ate this one
    let head = base;
    for (let link = 0; link < CAPTION_CHAIN_MAX; link++) {
      // the geometrically next unit below the head in its x-band
      let next: Paragraph | null = null;
      let nextTop = Infinity;
      for (const cand of paragraphs) {
        if (cand === head || absorbed.has(cand)) continue;
        if (cand.pxTop < head.pxBottom + CAPTION_GAP_TOL) continue;
        if (cand.pxTop - head.pxBottom > Math.max(CAPTION_GAP_FLOOR, CAPTION_LEADING_MAX * Math.max(head.dominantSize, cand.dominantSize))) continue;
        const ov = Math.min(head.pxRight, cand.pxRight) - Math.max(head.pxLeft, cand.pxLeft);
        if (ov <= 0) continue; // a different column's unit is not a neighbour
        if (cand.pxTop < nextTop) { next = cand; nextTop = cand.pxTop; }
      }
      if (!next) break;
      // Same-line companion cells inside the caption's x-band: a table
      // row flanks its prose cell with short sibling cells (consensus p11
      // «M1*» / «Single tumor localization» / «< 3 cm (T1)…»). Companions
      // must y-overlap B's first visual line and sit ≥CAPTION_COMPANION_XGAP
      // away — a different column's caption (maxillary p2 «Figure 1.» left
      // of the band) is NOT a companion.
      const firstRow = visualRows(next)[0];
      let companions = 0;
      if (firstRow) {
        const rowTop = firstRow.y0, rowBot = firstRow.y1;
        for (const other of paragraphs) {
          if (other === head || other === next || absorbed.has(other)) continue;
          const yOv = Math.min(other.pxBottom, rowBot) - Math.max(other.pxTop, rowTop);
          if (yOv <= 0) continue;
          const xGap = Math.max(other.pxLeft - next.pxRight, next.pxLeft - other.pxRight);
          if (xGap < CAPTION_COMPANION_XGAP) continue;
          // inside the caption's x-band (± the companion gap)
          if (other.pxLeft < head.pxLeft - CAPTION_COMPANION_XGAP
            || other.pxRight > head.pxRight + CAPTION_COMPANION_XGAP) continue;
          companions++;
        }
      }
      if (!canAbsorbCaptionContinuation(head, next, pageW, boundaries, companions)) break;
      absorbInto(head, next);
      absorbed.add(next);
      _lastCaptionAssemblyMerges++;
    }
  }

  // ── LFIX-24 phase 2: dangling-tail rescue ──────────────────────────
  // The main chain above requires a ≥6-word prose row and a family match
  // — calibrated against table content, but it also blocks the two
  // legitimate tail classes the user re-reported: SHORT title
  // continuations («Cutaneous Mast Cell Tumor.» — 4 words, subset-alias
  // face AdvPAC59) and symbol-font scale labels («= 25 μm.» — μ from
  // Universal-GreekwithMathPi, sliced off the caption's line by the
  // column slicer). Phase 2 gives every caption start whose text still
  // ends MID-SENTENCE (no terminal punctuation — «…Bar», «…Feline»,
  // «…Progesterone») exactly one more chance: the GEOMETRICALLY NEXT
  // neighbour below it in its x-band (V-case, same blocking semantics as
  // the main chain — a guard failure stops, never skips), or — when the
  // band below is empty — the flush-right fragment on its LAST visual
  // row (H-case). The relaxed gate set lives in canAbsorbCaptionTail;
  // the chain re-checks the «ends mid-sentence» trigger after every
  // absorption, so a completed caption never keeps eating.
  for (const base of bases) {
    if (absorbed.has(base)) continue; // an earlier start already ate this one
    let head = base;
    for (let link = 0; link < CAPTION_CHAIN_MAX; link++) {
      // trigger: the head's text ends mid-sentence
      if (captionEndsComplete(head)) break;
      // V-candidate: the geometrically next unit below the head in its
      // x-band (same search as the main chain).
      let nextV: Paragraph | null = null;
      let nextVTop = Infinity;
      for (const cand of paragraphs) {
        if (cand === head || absorbed.has(cand)) continue;
        if (cand.pxTop < head.pxBottom + CAPTION_GAP_TOL) continue;
        if (cand.pxTop - head.pxBottom > Math.max(CAPTION_GAP_FLOOR, CAPTION_LEADING_MAX * Math.max(head.dominantSize, cand.dominantSize))) continue;
        const ov = Math.min(head.pxRight, cand.pxRight) - Math.max(head.pxLeft, cand.pxLeft);
        if (ov <= 0) continue; // a different column's unit is not a neighbour
        if (cand.pxTop < nextVTop) { nextV = cand; nextVTop = cand.pxTop; }
      }
      let next: Paragraph | null = null;
      let companions = 0;
      let horizontal = false;
      if (nextV) {
        next = nextV;
        const firstRow = visualRows(next)[0];
        if (firstRow) {
          const rowTop = firstRow.y0, rowBot = firstRow.y1;
          for (const other of paragraphs) {
            if (other === head || other === next || absorbed.has(other)) continue;
            const yOv = Math.min(other.pxBottom, rowBot) - Math.max(other.pxTop, rowTop);
            if (yOv <= 0) continue;
            const xGap = Math.max(other.pxLeft - next.pxRight, next.pxLeft - other.pxRight);
            if (xGap < CAPTION_COMPANION_XGAP) continue;
            if (other.pxLeft < head.pxLeft - CAPTION_COMPANION_XGAP
              || other.pxRight > head.pxRight + CAPTION_COMPANION_XGAP) continue;
            companions++;
          }
        }
      } else {
        // H-candidate: the left-most unit sharing the head's LAST visual
        // row, flush to the right of that row's ink. A table row's next
        // cell also qualifies geometrically — the rightmost-position
        // requirement below is what rejects it: the candidate must be
        // the LAST thing on the row (nothing further right within the
        // same row band). Figure bands and neighbouring columns sit
        // ≥32pt away (BRIDGE_GAP_MAX) — beyond CAPTION_TAIL_XGAP.
        const lastRow = visualRows(head)[visualRows(head).length - 1];
        if (lastRow) {
          let rowRight = -Infinity;
          for (const s of lastRow.spans) rowRight = Math.max(rowRight, s.right);
          let bestH: Paragraph | null = null;
          let bestHX = Infinity;
          for (const cand of paragraphs) {
            if (cand === head || absorbed.has(cand)) continue;
            const yOv = Math.min(lastRow.y1, cand.pxBottom) - Math.max(lastRow.y0, cand.pxTop);
            const hMin = Math.min(lastRow.y1 - lastRow.y0, cand.pxBottom - cand.pxTop);
            if (hMin <= 0 || yOv < CAPTION_TAIL_ROWOVL * hMin) continue;
            const xgap = cand.pxLeft - rowRight;
            if (xgap < -2 || xgap > CAPTION_TAIL_XGAP) continue;
            if (cand.pxLeft < bestHX) { bestH = cand; bestHX = cand.pxLeft; }
          }
          if (bestH) {
            // rightmost requirement: nothing else on the row to the
            // right of the candidate (a mid-row table cell would have
            // siblings at ≥ CAPTION_COMPANION_XGAP further right).
            // Compares INK edges — a unit's px-box is grid-quantized
            // (+cellSize slop) and would let a 6pt-gap sibling slip
            // under the threshold.
            let bestInkRight = -Infinity;
            for (const s of bestH.spans) bestInkRight = Math.max(bestInkRight, s.right);
            let rightSibling = false;
            for (const other of paragraphs) {
              if (other === head || other === bestH || absorbed.has(other)) continue;
              const yOv = Math.min(lastRow.y1, other.pxBottom) - Math.max(lastRow.y0, other.pxTop);
              if (yOv <= 0) continue;
              let otherInkLeft = Infinity;
              for (const s of other.spans) otherInkLeft = Math.min(otherInkLeft, s.left);
              if (otherInkLeft >= bestInkRight + CAPTION_COMPANION_XGAP) { rightSibling = true; break; }
            }
            if (!rightSibling) { next = bestH; horizontal = true; }
          }
        }
      }
      if (!next) break;
      if (!canAbsorbCaptionTail(head, next, companions, horizontal)) break;
      absorbInto(head, next);
      absorbed.add(next);
      _lastCaptionAssemblyMerges++;
    }
  }
  if (absorbed.size === 0) return paragraphs;
  return paragraphs.filter(p => !absorbed.has(p));
}

/** LAYOUT-FIX-23: diagnostics counter for the harness (merges of the last
 * assembleCaptionChains call; reset at its start). */
let _lastCaptionAssemblyMerges = 0;

/** LAYOUT-FIX-23: internals for the audit harness / unit suite (same
 * module pattern as __captionSubtractInternals). LFIX-24 adds the
 * dangling-tail rescue surface (phase 2 of assembleCaptionChains). */
export const __captionAssemblyInternals = {
  startRe: CAPTION_CHAIN_START_RE,
  isCaptionChainStart,
  splitCaptionMarkerSpans,
  captionBodyFamily,
  captionRowIsTableLattice,
  canAbsorbCaptionContinuation,
  lastRun: () => (_lastCaptionAssemblyMerges),
  // ── LAYOUT-FIX-24: dangling-tail rescue ──
  tailCompleteRe: CAPTION_TAIL_COMPLETE_RE,
  tailWordsMax: CAPTION_TAIL_WORDS,
  tailRowsMax: CAPTION_TAIL_ROWS,
  tailXgapMax: CAPTION_TAIL_XGAP,
  captionEndsComplete,
  captionWordCount,
  captionRowTexts,
  canAbsorbCaptionTail,
};

/**
 * LAYOUT-FIX (2026-09-14): Steps 5-8 of the pipeline, extracted verbatim
 * from buildParagraphs so they can run per column group. Does NOT apply
 * applyColumnOrder (Step 9) — the caller runs it once over the
 * concatenated result of all groups.
 */
function buildParagraphsInRegion(
  map: OccupancyMapResult,
  rects: InputRect[],
  INDENT_THRESHOLD: number,
  FONT_SIZE_TOLERANCE: number,
  MAX_MERGE_PASSES: number,
): Paragraph[] {
  const { gridW, gridH, cellSize, occupied, contourCells } = map;
  {
  // ── STEP 5: Build islands ──────────────────────────────────────────
  const rowRuns: Array<Array<{ y: number; x0: number; x1: number }>> = [];
  for (let y = 0; y < gridH; y++) {
    const runs: Array<{ y: number; x0: number; x1: number }> = [];
    let runStart = -1;
    for (let x = 0; x <= gridW; x++) {
      const isOcc = x < gridW && occupied[y * gridW + x];
      if (isOcc) { if (runStart < 0) runStart = x; }
      else {
        if (runStart >= 0) { runs.push({ y, x0: runStart, x1: x - 1 }); runStart = -1; }
      }
    }
    rowRuns.push(runs);
  }

  const paragraphs: Paragraph[] = [];
  const visited = new Set<string>();
  const cellIslandId = new Int32Array(gridW * gridH).fill(-1);
  let nextIslandId = 0;

  for (let y = 0; y < gridH; y++) {
    for (const run of rowRuns[y]) {
      const key = y + '_' + run.x0;
      if (visited.has(key)) continue;
      visited.add(key);

      const islandId = nextIslandId++;
      for (let x = run.x0; x <= run.x1; x++) cellIslandId[y * gridW + x] = islandId;

      const queue: Array<{ y: number; x0: number; x1: number }> = [{ y, x0: run.x0, x1: run.x1 }];
      let minY = y, maxY = y, minX = run.x0, maxX = run.x1;

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.y + 1 >= gridH) continue;

        // P2-1 (Phase 17): the `hBreak` check that lived here was dead —
        // it scanned `hContourCells` (always empty after the Step-4
        // removal), so the BFS never short-circuited. Deleted along with
        // the hContourCells field.

        for (const nextRun of rowRuns[cur.y + 1]) {
          const nKey = (cur.y + 1) + '_' + nextRun.x0;
          if (visited.has(nKey)) continue;

          let hasUnblockedOverlap = false;
          for (let x = Math.max(cur.x0, nextRun.x0); x <= Math.min(cur.x1, nextRun.x1); x++) {
            if (!contourCells[cur.y * gridW + x] && !contourCells[(cur.y + 1) * gridW + x]) {
              hasUnblockedOverlap = true; break;
            }
          }
          if (!hasUnblockedOverlap) continue;

          visited.add(nKey);
          for (let x = nextRun.x0; x <= nextRun.x1; x++) cellIslandId[(cur.y + 1) * gridW + x] = islandId;
          queue.push({ y: cur.y + 1, x0: nextRun.x0, x1: nextRun.x1 });
          minY = Math.min(minY, cur.y + 1);
          maxY = Math.max(maxY, cur.y + 1);
          minX = Math.min(minX, nextRun.x0);
          maxX = Math.max(maxX, nextRun.x1);
        }
      }

      const pxLeft = minX * cellSize;
      const pxTop = minY * cellSize;
      const pxRight = (maxX + 1) * cellSize;
      const pxBottom = (maxY + 1) * cellSize;
      const width = pxRight - pxLeft;
      const height = pxBottom - pxTop;
      if (width < cellSize || height < cellSize) continue;

      // FIX: use cellIslandId (actual cells) instead of bounding box.
      // The original bbox-based filter caused rect duplication when one
      // island's bbox contained another's bbox — same rect ended up in
      // multiple islands, leading to duplicated text after merge.
      const paraSpans = rects.filter(r => {
        const cx = Math.floor(((r.left + r.right) / 2) / cellSize);
        const cy = Math.floor(((r.top + r.bottom) / 2) / cellSize);
        if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) return false;
        return cellIslandId[cy * gridW + cx] === islandId;
      });
      if (paraSpans.length === 0) continue;

      const { dominantFamily, dominantSize } = computeDominantFont(paraSpans);
      // Stage 0.2 (Q8): removed `as any` cast. `id` is now declared on
      // Paragraph as `string?` — we String()-coerce the numeric islandId
      // so the type checks cleanly.
      paragraphs.push({ id: String(islandId), pxLeft, pxTop, pxRight, pxBottom, width, height, spans: paraSpans, dominantFamily, dominantSize });
    }
  }

  paragraphs.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  // ── STEP 6: Merge islands whose occupied cells physically touch ────
  //
  // CRITICAL RULES (per user spec):
  //   1. ONLY islands whose occupied cells PHYSICALLY TOUCH (4-neighbour
  //      adjacent) can be merged. Non-touching islands NEVER merge.
  //   2. Two islands can merge ONLY IF they share a common "primary" font
  //      family (i.e., the family that takes up significant space in both).
  //      Islands with DIFFERENT primary families NEVER merge, even if they
  //      touch — per spec "НЕ СЛИВАТЬ РАЗЛИЧНЫЕ СЕМЕЙСТВА ШРИФТОВ".
  //   3. "Primary" family = family used by majority of spans, but we also
  //      verify the OTHER island has the same primary family (not just
  //      dominant by count).
  //
  // The "primary family" approach handles the 50/50 case correctly:
  //   Island A: 50% FamilyA + 50% FamilyB → primary could be either.
  //   In that case, we use the family of the FIRST span (top-left-most) as
  //   the primary — this is a deterministic tiebreaker.
  //
  // Size tolerance: spans within FONT_SIZE_TOLERANCE pt are considered
  // "same size". Links/symbols that are MUCH smaller (e.g., footnote refs)
  // do NOT prevent merging — they're treated as inline decorations of the
  // primary text (handled properly in Step 7 font split).
  const touchPairs = new Set<string>();
  // P2-7 (Phase 17): extracted the touchPairs build into a helper so we can
  // recompute it at the start of each merge pass. Without this recomputation,
  // when island A absorbs island B in pass 1, any pair (B, C) is still in
  // touchPairs in pass 2 — but B is `_merged` and gets skipped, and there's
  // no pair (A, C) even though A now owns B's cells (and is therefore
  // adjacent to C). The merge of A+C never happens. Relabeling B's cells
  // to A's id in `cellIslandId` (after each merge) plus recomputing
  // `touchPairs` at the top of each pass makes the new (A, C) adjacency
  // visible.
  const recomputeTouchPairs = (): void => {
    touchPairs.clear();
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const idx = y * gridW + x;
        const id = cellIslandId[idx];
        if (id < 0) continue;
        const neighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
          const nId = cellIslandId[ny * gridW + nx];
          if (nId >= 0 && nId !== id) {
            const pairKey = id < nId ? id + '_' + nId : nId + '_' + id;
            touchPairs.add(pairKey);
          }
        }
      }
    }
  };
  recomputeTouchPairs();

  // Stage 0.2 (Q8): `p.id` is now `string` (was untyped under @ts-nocheck).
  const islandById = new Map<string, Paragraph>();
  for (const p of paragraphs) {
    if (p.id !== undefined) islandById.set(p.id, p);
  }

  /**
   * Determine if two islands can be merged based on font compatibility.
   *
   * Rule: Both islands must share a "primary" font family. The primary
   * family is the one with the most spans (ties broken by first-occurrence).
   *
   * Special case: spans that are MUCH smaller than the island's median size
   * (e.g., footnote reference numbers, superscripts) are treated as
   * "decorations" and excluded from the primary family calculation — they
   * should not prevent merging of the main text.
   */
  function getPrimaryFamily(para: Paragraph): string {
    // Collect all (family, size) pairs
    const candidates: Array<{ family: string; size: number }> = [];
    for (const s of para.spans as any[]) {
      const fam = getFontFamily(s.fontname, _preserveStyle);
      const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
      candidates.push({ family: fam, size: sz });
    }

    if (candidates.length === 0) return 'unknown';

    // Find median size — spans much smaller than median are "decorations"
    const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const DECORATION_THRESHOLD = median * _decorationThreshold;  // <70% of median = decoration

    // Filter out decoration spans
    const mainSpans = candidates.filter(c => c.size >= DECORATION_THRESHOLD);

    // Count families among main spans
    const famCounts: Record<string, number> = {};
    let firstFamily = '';
    for (const c of mainSpans) {
      if (!firstFamily) firstFamily = c.family;
      famCounts[c.family] = (famCounts[c.family] || 0) + 1;
    }

    // Pick family with most spans; ties broken by first-occurrence
    let bestFam = firstFamily;
    let bestCount = 0;
    for (const [fam, count] of Object.entries(famCounts)) {
      if (count > bestCount || (count === bestCount && fam === firstFamily)) {
        bestCount = count;
        bestFam = fam;
      }
    }
    return bestFam;
  }

  function sameFont(a: Paragraph, b: Paragraph): boolean {
    const aFam = getPrimaryFamily(a);
    const bFam = getPrimaryFamily(b);
    return aFam === bFam;
  }

  let changed = true, mergePass = 0;
  while (changed && mergePass < MAX_MERGE_PASSES) {
    mergePass++;
    changed = false;
    // P2-7 (Phase 17): recompute touchPairs at the start of every pass after
    // the first so newly-adjacent islands (A absorbed B's cells and is now
    // touching C) get considered. The first pass uses the initial
    // recomputeTouchPairs() call above.
    if (mergePass > 1) recomputeTouchPairs();
    for (const pairKey of touchPairs) {
      // Stage 0.2 (Q8): islandById is now keyed by string, so we don't
      // convert back to number — we split and use the string parts
      // directly as keys.
      const [idAStr, idBStr] = pairKey.split('_');
      const a = islandById.get(idAStr);
      const b = islandById.get(idBStr);
      if (!a || !b || a._merged || b._merged) continue;
      if (!sameFont(a, b)) continue;

      // ── STYLE-FLOW GATE (Step 6, LAYOUT-FIX-6) ────────────────────
      // Two touching islands whose primary FULL fonts are style variants
      // of one base family (Regular↔Italic…) merge only with positive
      // sentence-flow evidence. This keeps the italic-in-paragraph case
      // (p.11 «evi-/dence») merging while blocking caption↔body and
      // TOC-entry chains on dense book pages. Kill-switch:
      // disableStyleFlowGuard.
      if (!_disableStyleFlowGuard) {
        const aFull = primaryFullFontName(a);
        const bFull = primaryFullFontName(b);
        if (isStyleVariantPair(aFull, bFull)) {
          const upper = a.pxTop <= b.pxTop ? a : b;
          const lower = a.pxTop <= b.pxTop ? b : a;
          if (!parasFlowContinuous(upper, lower)) continue;
        }
      }

      // ── TABLE-CELL GUARD (Step 6) ──────────────────────────────────
      // Same logic as in remergeAfterFontSplit: do NOT merge side-by-side
      // islands with a clear horizontal gap (table row pattern).
      const hGap6 = Math.max(0, Math.max(a.pxLeft, b.pxLeft) - Math.min(a.pxRight, b.pxRight));
      const vOverlapTop6 = Math.max(a.pxTop, b.pxTop);
      const vOverlapBottom6 = Math.min(a.pxBottom, b.pxBottom);
      const vOverlap6 = Math.max(0, vOverlapBottom6 - vOverlapTop6);
      const smallerHeight6 = Math.min(a.pxBottom - a.pxTop, b.pxBottom - b.pxTop);
      const vOverlapFrac6 = smallerHeight6 > 0 ? vOverlap6 / smallerHeight6 : 0;
      const aSizes6 = a.spans.map((s: any) => Number.isFinite(s.fontsize) ? s.fontsize : 10).sort((x, y) => x - y);
      const bSizes6 = b.spans.map((s: any) => Number.isFinite(s.fontsize) ? s.fontsize : 10).sort((x, y) => x - y);
      const medianSize6 = aSizes6.length && bSizes6.length
        ? Math.min(aSizes6[Math.floor(aSizes6.length / 2)], bSizes6[Math.floor(bSizes6.length / 2)])
        : 10;
      const estLineHeight6 = medianSize6 * 1.2;
      if (hGap6 >= estLineHeight6 * 1.5 && vOverlapFrac6 > 0.5) {
        // Table-cell pattern — skip merge
        continue;
      }

      a.spans.push(...b.spans);
      a.pxLeft = Math.min(a.pxLeft, b.pxLeft);
      a.pxTop = Math.min(a.pxTop, b.pxTop);
      a.pxRight = Math.max(a.pxRight, b.pxRight);
      a.pxBottom = Math.max(a.pxBottom, b.pxBottom);
      a.width = a.pxRight - a.pxLeft;
      a.height = a.pxBottom - a.pxTop;
      // Recompute dominant family/size after merge (cached value is stale)
      const recomputed = computeDominantFont(a.spans);
      a.dominantFamily = recomputed.dominantFamily;
      a.dominantSize = recomputed.dominantSize;
      b._merged = true;
      changed = true;
      // P2-7 (Phase 17): relabel b's cells in cellIslandId to a's id so the
      // next pass's recomputeTouchPairs() sees the new (A, X) adjacencies
      // for every X that was previously touching B. Scoped to b's bbox to
      // avoid a full O(grid) scan per merge.
      const aIdNum = parseInt(idAStr, 10);
      const bIdNum = parseInt(idBStr, 10);
      if (Number.isFinite(aIdNum) && Number.isFinite(bIdNum) && aIdNum !== bIdNum) {
        const x0 = Math.max(0, Math.floor(b.pxLeft / cellSize));
        const x1 = Math.min(gridW - 1, Math.floor(b.pxRight / cellSize));
        const y0 = Math.max(0, Math.floor(b.pxTop / cellSize));
        const y1 = Math.min(gridH - 1, Math.floor(b.pxBottom / cellSize));
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const ci = yy * gridW + xx;
            if (cellIslandId[ci] === bIdNum) cellIslandId[ci] = aIdNum;
          }
        }
      }
    }
  }

  let finalParagraphs = paragraphs.filter(p => !p._merged);
  finalParagraphs.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  // ── STEP 6.9: Same-baseline single-line bridge (LAYOUT-FIX-22) ─────
  // USER REPORT (books corpus, F26-c): одиночная строка с межсловесными
  // зазорами ≥ cellSize рассыпается на юниты-слова — бег-острова STEP 5
  // сшиваются ТОЛЬКО вертикальными цепочками (BFS вниз), горизонтальной
  // склейки внутри строки нет; многострочный абзац выживают за счёт
  // вертикальных партнёров, а ЗАГОЛОВОК / хвост justified-строки / метка
  // подписи — нет. Наблюдения (consensus p6: «criteria» «for» «feline»
  // при зазорах 6-7pt; ossfying p4: «hasil» «berupa» «anemia»
  // «normositik»; pleomorphic: «Table 1.»/«Fig. 3.»; sysreview p6:
  // «17.»–«23.» оторваны от записей).
  //
  // ГЕЙТЫ (калибровка scripts/f26c-dump.py по books-корпусу):
  //   1. одна строка: y-перекрытие ≥ 0.6 меньшей высоты боксов;
  //   2. горизонтальный зазор ∈ [0, 10)pt — проза-осколки 4–9.4pt,
  //      ячейки таблиц ≥ 12pt и жёлобы колонок 32–43pt не задеты;
  //   3. хотя бы одна сторона — однострочный остров (все спаны на одной
  //      визуальной строке): это сигнатура «нет вертикального партнёра»;
  //      многострочные ячейки таблиц (2-строчные шапки «Cat.<br>No.»)
  //      отбрасываются этим гейтом;
  //   4. sameFont с нормализацией PS/MT-хвостов (мягче STEP 6 —
  //      «TimesNewRomanPS-BoldMT» и «TimesNewRomanPSMT» одно лицо);
  //   5. ТАБЛИЧНЫЕ ГЕЙТЫ (кроме caption-пар Fig/Table…):
  //      • окно ±6pt над/под строкой без чужих спанов в x-полосе
  //        однострочной стороны (BMC-стеки sabattini p7, 1.5pt);
  //      • колоночная сигнатура: чужой спан с тем же левым краем ±4pt
  //        в пределах 2.5 высот строки (glial p3 «Number»→«1/2/3…»);
  //      • ≥3 чужих островов в полосе ±2.5 высоты строки (решётка
  //        ячеек glial p4); у прозы-фрагментов соседей ≤2;
  //   6. kill-switch disableSingleLineBridge / пресет 'separate'.
  // Слияние повторяет бухгалтерию STEP 6 (spans push, bbox union,
  // доминантный шрифт, _merged) — идемпотентно к порядку пар.
  if (!_disableSingleLineBridge) {
    // LAYOUT-FIX-22: шрифтовой гейт моста мягче STEP 6: продюсерские
    // имена одного гартурного лица расходятся хвостовым шумом
    // («TimesNewRomanPS-BoldMT» → срез суффикса → «TimesNewRomanPS»,
    // а прямой начертательный — «TimesNewRomanPSMT»; pleomorphic p2
    // «Table 1.» не склеивался с подписью). Нормализация PS/MT-хвостов
    // только ВНУТРИ моста — семантика STEP 6/7 не затронута.
    const bridgeFontOk = (a: Paragraph, b: Paragraph): boolean => {
      const norm = (f: string) => f.replace(/PS(?:MT)?$/, '').replace(/MT$/, '');
      return norm(getPrimaryFamily(a)) === norm(getPrimaryFamily(b));
    };
    finalParagraphs = bridgeSameLineFragments(finalParagraphs, bridgeFontOk);
    finalParagraphs.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // ── STEP 7: Split by font family / size ────────────────────────────
  finalParagraphs = splitByFont(finalParagraphs, FONT_SIZE_TOLERANCE);

  // ── STEP 7.7: Split at style boundaries without flow continuity ────
  // LAYOUT-FIX-6 (2026-09-16): a unit whose consecutive line RUNS change
  // full font (style variant of one base family — Regular↔Italic, …)
  // splits at that boundary UNLESS there is positive evidence of
  // sentence-flow continuity. Restores the caption/TOC boundaries that
  // LAYOUT-FIX-5's style-blindness removed on dense book pages, while
  // keeping italic mid-paragraph fragments merged (flow evidence).
  if (!_disableStyleFlowGuard) {
    finalParagraphs = splitByStyleFlow(finalParagraphs);
  }

  // ── STEP 7.3: Split by font size class / family (LAYOUT-FIX-14) ────
  // A unit whose visual rows carry ≥2 font SIZE classes (width-weighted
  // medians, Δ > SIZE_CLASS_TOL) or ≥2 base families is a merge of
  // different-typography material and is partitioned into per-class
  // units. Defence in depth for the slicer-failure class (interleaved
  // columns — every bridge row mixes both columns' fonts) AND for
  // caption/label/footnote chains fused inside one geometric island.
  // Guards:
  //   • rows are first split into x-clusters at gaps ≥ X_CLUSTER_GAP —
  //     an interleaved row's left/right halves get independent classes;
  //   • decoration spans (< 70% of the CLUSTER median) follow their
  //     cluster's class (superscript refs stay inside their body row);
  //   • caption-label exception: a class-group whose first text starts
  //     with Fig/Figure/Table… glues to the group directly BELOW it;
  //   • table-like units (TABLE-KEEP) and TOC entry chains are exempt;
  //   • single-class units return unchanged (byte-identical fast path).
  if (!_disableFontClassSplit) {
    finalParagraphs = splitBySizeClass(finalParagraphs);
  }

  // ── STEP 7.5: Split by paragraph-start markers ─────────────────────
  // Footnotes and other distinct logical blocks (Corresponding Author,
  // Supplemental Material, etc.) often have the SAME font and SAME indent
  // as adjacent text, so Step 7 (font) and Step 8 (indent) cannot separate
  // them. They also have <8px vertical gap, so contour detection (Step 4)
  // doesn't create horizontal boundaries between them.
  //
  // This step detects line-level markers that signal a NEW paragraph:
  //   - Leading footnote number: "1", "12" at start of line (after optional
  //     whitespace, followed by capital letter or symbol)
  //   - Known structural labels: "Corresponding", "Supplemental", "Email:",
  //     "Author contributions", "Acknowledgments", "References", etc.
  //
  // When such a marker is found on a line that is NOT the first line of the
  // paragraph, a new paragraph is started.
  finalParagraphs = splitByParagraphMarkers(finalParagraphs);

  // ── STEP 8: Split by indentation ───────────────────────────────────
  finalParagraphs = splitByIndent(finalParagraphs, INDENT_THRESHOLD);

  // ── STEP 8.5: Re-merge islands AFTER all splits ────────────────────
  //
  // PROBLEM: Steps 7 (splitByFont), 7.5 (splitByParagraphMarkers), and 8
  // (splitByIndent) can OVER-SPLIT paragraphs. The most common case is the
  // drop-cap region:
  //
  //   Original island (one cellIslandId):
  //     "A"           (x=129, h=41pt — drop-cap)
  //     "naphylaxis is the term given to"     (x=158, h=9.25pt — body line 1)
  //     "extremely severe allergic reactions." (x=158, h=9.25pt — body line 2)
  //     "Though frequently encountered,"       (x=158, h=9.25pt — body line 3)
  //     "particularly in some geographic..."   (x=129, h=9.25pt — body line 4)
  //     ...
  //
  // splitByIndent sees bodyLeft=129 (majority) and treats lines with
  // left=158 as "indented" → splits each indented line into a separate
  // paragraph. This produces 7+ fragments from ONE original paragraph.
  //
  // RE-MERGE RULE (per user spec, STRICT):
  //   ONLY islands whose occupied cells PHYSICALLY TOUCH (4-neighbour
  //   adjacency in the original grid) can be merged.
  //   Non-touching islands NEVER merge.
  //
  // Additional compatibility checks:
  //   - Same primary font family (decoration-aware, as in Step 6)
  //   - Size compatible: |size_a - size_b| ≤ fontSizeTolerance,
  //     OR one is a drop-cap (size ≥ 2.5× the other) — drop-cap is treated
  //     as an inline decoration of the body text and merges with it.
  finalParagraphs = remergeAfterFontSplit(finalParagraphs, touchPairs, islandById, FONT_SIZE_TOLERANCE, cellSize, gridW, gridH, cellIslandId, rects);

  // ── STEP 8.6: Split by standard paragraph indent ───────────────────
  //
  // PROBLEM: remergeAfterFontSplit (Step 8.5) can OVER-MERGE paragraphs
  // that were originally separate but physically touching. The classic
  // case is two adjacent body-text paragraphs in the same column:
  //
  //   Para A: "Biphasic reactions have been demonstrated..."
  //            "tial recovery is followed by..."
  //            "exposure. 13 This usually occurs..."
  //            ...
  //            "lasting greater than 5 hours. 12, 15"
  //   Para B: "  The severity of anaphylactic reactions..."  ← INDENTED
  //            "or severe (Figure 129.1) and it depends..."
  //            ...
  //
  // Para B's first line has a STANDARD PARAGRAPH INDENT (left margin
  // increased by ~10-15px from body left). This is the typographic
  // convention for "new paragraph starts here". But because Para A and
  // Para B physically touch (no empty line between them), Step 8.5
  // merges them into one.
  //
  // This step detects that pattern and splits:
  //   1. For each paragraph, find bodyLeft (most common left margin).
  //   2. Walk lines top-to-bottom. A line is a "paragraph break candidate"
  //      if its leftmost > bodyLeft + indentThreshold.
  //   3. CRITICAL: only split if the indented line is followed by a
  //      bodyLeft line (i.e. the indent is ONE line, then back to body).
  //      This distinguishes:
  //        - Real paragraph indent (one indented line, then body) → SPLIT
  //        - Drop-cap wrap (multiple indented lines around the drop-cap)
  //          → DO NOT SPLIT (drop-cap is handled by remergeAfterFontSplit)
  finalParagraphs = splitByParagraphIndent(finalParagraphs, INDENT_THRESHOLD);

  return finalParagraphs;
  }
}

// ═══ STEP 6.9 (LAYOUT-FIX-22): same-baseline single-line bridge ═══

/** STEP 6.9: максимум горизонтального зазора (pt) для моста (калибровка
 * books-корпуса: проза-осколки 4–9.4pt; ячейки таблиц ≥ 12pt, жёлобы
 * колонок 32–43pt). */
const BRIDGE_GAP_MAX = 10;
/** STEP 6.9: окно «стерильности» (pt) над/под строкой — чужие спаны в
 * этом окне в x-полосе однострочной стороны означают табличную
 * окрестность (тело таблицы в 4pt под шапкой glial p3; BMC-стек в 1.5pt
 * над sabattini p7) и блокируют мост. Заголовки/подписи/justified-хвосты
 * имеют просвет ≥ 8pt — проходят. */
const BRIDGE_CLEAR_WINDOW = 6;
/** STEP 6.9: порог y-перекрытия пары (доля меньшей высоты бокса). */
const BRIDGE_Y_OVERLAP = 0.6;

/** STEP 6.9: метка подписи в начале текста стороны пары (каптион-
 * исключение — табличные гейты обходятся). Те же префиксы, что
 * CAPTION_START_RE (8.5/8.7), безplural-форм — достаточно для метки). */
const captionStartRe = /^(figure|figures|fig|figs|fig\.|table|tables|box|boxes|scheme|plate|chart|рис\.?|табл\.?|схема|рисунок|рисунки)\b/i;

/** Все спаны юнита на одной визуальной строке? (группировка groupIntoLines
 * с её 3pt-допуском — суперскрипт на приподнятой строке консервативно
 * считается второй строкой). */
function isSingleVisualLine(p: Paragraph): boolean {
  return p.spans.length > 0 && groupIntoLines(p.spans).length === 1;
}

/**
 * STEP 6.9 (LAYOUT-FIX-22): сшить фрагменты одной визуальной строки.
 *
 * Острова STEP 5 сшиваются только ВЕРТИКАЛЬНЫМИ цепочками — строка с
 * межсловесными зазорами ≥ cellSize, у которой нет вертикального
 * партнёра (заголовок, хвост justified-абзаца, метка подписи, номер
 * ссылки), рассыпается на юниты-слова. Мост сливает соседей по строке
 * (A слева, B справа, зазор < BRIDGE_GAP_MAX), когда хотя бы одна
 * сторона — однострочный остров, шрифты совместимы (sameFont из STEP 6),
 * а полоса ± BRIDGE_CLEAR_WINDOW над/под строкой в x-полосе
 * однострочной стороны свободна от чужих спанов (табличная окрестность
 * отбраковывается). Бухгалтерия слияния идентична STEP 6; после каждого
 * слияния проход перезапускается (выросший бокс меняет соседство).
 */
function bridgeSameLineFragments(
  paras: Paragraph[],
  sameFont: (a: Paragraph, b: Paragraph) => boolean,
): Paragraph[] {
  let live = paras.slice();
  let merges = 0;
  let changed = true;
  while (changed && merges < 200) {
    changed = false;
    scan:
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (a._merged) continue;
      for (let j = 0; j < live.length; j++) {
        if (i === j) continue;
        const b = live[j];
        if (b._merged) continue;
        // A строго слева от B, зазор в окне моста
        if (!(b.pxLeft >= a.pxRight)) continue;
        const gap = b.pxLeft - a.pxRight;
        if (gap >= BRIDGE_GAP_MAX) continue;
        // одна визуальная строка (y-перекрытие ≥ 0.6 меньшей высоты)
        const rowTop = Math.max(a.pxTop, b.pxTop);
        const rowBottom = Math.min(a.pxBottom, b.pxBottom);
        const minH = Math.min(a.pxBottom - a.pxTop, b.pxBottom - b.pxTop);
        if (minH <= 0 || rowBottom - rowTop < BRIDGE_Y_OVERLAP * minH) continue;
        // сигнатура фрагментации: хотя бы одна сторона однострочная,
        // а НЕ-однострочная сторона — ≤3 строк (фрагмент строки/блока,
        // не плотная колонка). Без потолка линий мост склеивал 6-строчный
        // блок сносок со ссылкой соседней колонки через рваный жёлоб 8pt
        // (maxillary p6, страница без детекции).
        const aSingle = isSingleVisualLine(a);
        const bSingle = isSingleVisualLine(b);
        if (!aSingle && !bSingle) continue;
        if (!aSingle && groupIntoLines(a.spans).length > 3) continue;
        if (!bSingle && groupIntoLines(b.spans).length > 3) continue;
        // шрифтовая совместимость (нормализация PS/MT-хвостов — вызов выше)
        if (!sameFont(a, b)) continue;
        // CAPTION-ИСКЛЮЧЕНИЕ: метка подписи (Fig./Figure/Table/Box/…)
        // БЕЗ табличных гейтов — её правый сосед это текст подписи
        // (pleomorphic: «Table 1.»+«Case summaries…», «Fig. 3.»+«Haired
        // skin…») независимо от таблицы под ними.
        const aText = (a.spans.map(s => String((s as any).text ?? '')).join(' ') || '').trim();
        const bText = (b.spans.map(s => String((s as any).text ?? '')).join(' ') || '').trim();
        const captionPair = captionStartRe.test(aText) || captionStartRe.test(bText);
        if (!captionPair) {
          // стерильность полосы + колоночная сигнатура + плотность
          // табличного соседства (калибровка books-корпуса):
          //   • чужой спан в ±BRIDGE_CLEAR_WINDOW над/под строкой в
          //     x-полосе однострочной стороны (BMC-стеки 1.5pt);
          //   • чужой спан с тем же левым краем (±4pt) в пределах
          //     2.5 высот строки (колонка таблицы под шапкой: glial
          //     «Number»→«1/2/3…», реальный зазор 9.75pt);
          //   • ≥3 чужих островов в вертикальной полосе ±2.5 высоты
          //     строки, x-пересекающих чью-либо полосу — регулярная
          //     решётка ячеек (glial p3/p4 шапки), у заголовков и
          //     justified-хвостов соседей ≤2 (consensus p6: под
          //     заголовком один «Hormonal receptors», 26.8pt ниже).
          let nearIslands = 0;
          let blocked = false;
          for (let k = 0; k < live.length && !blocked; k++) {
            if (k === i || k === j) continue;
            const c = live[k];
            if (c._merged) continue;
            let islandNear = false;
            for (const s of c.spans) {
              const xOvA = aSingle && s.left < a.pxRight && s.right > a.pxLeft;
              const xOvB = bSingle && s.left < b.pxRight && s.right > b.pxLeft;
              if (!xOvA && !xOvB) continue;
              const above = s.top < rowTop && s.bottom > rowTop - BRIDGE_CLEAR_WINDOW;
              const below = s.bottom > rowBottom && s.top < rowBottom + BRIDGE_CLEAR_WINDOW;
              const colReach = 2.5 * minH;
              const colA = aSingle && Math.abs(s.left - a.pxLeft) <= 4
                && s.top < rowBottom + colReach && s.bottom > rowTop - colReach;
              const colB = bSingle && Math.abs(s.left - b.pxLeft) <= 4
                && s.top < rowBottom + colReach && s.bottom > rowTop - colReach;
              const near = s.top < rowBottom + 2.5 * minH && s.bottom > rowTop - 2.5 * minH;
              if (near) islandNear = true;
              if (above || below || colA || colB) { blocked = true; break; }
            }
            if (islandNear) nearIslands++;
            if (nearIslands >= 3) blocked = true;
          }
          if (blocked) continue;
        }
        // СЛИЯНИЕ B → A (бухгалтерия STEP 6)
        a.spans.push(...b.spans);
        a.pxLeft = Math.min(a.pxLeft, b.pxLeft);
        a.pxTop = Math.min(a.pxTop, b.pxTop);
        a.pxRight = Math.max(a.pxRight, b.pxRight);
        a.pxBottom = Math.max(a.pxBottom, b.pxBottom);
        a.width = a.pxRight - a.pxLeft;
        a.height = a.pxBottom - a.pxTop;
        const rec = computeDominantFont(a.spans);
        a.dominantFamily = rec.dominantFamily;
        a.dominantSize = rec.dominantSize;
        b._merged = true;
        merges++;
        changed = true;
        break scan;
      }
    }
    if (changed) live = live.filter(p => !p._merged);
  }
  return live.filter(p => !p._merged);
}

function computeDominantFont(spans: InputRect[]): { dominantFamily: string; dominantSize: number } {
  const famCounts: Record<string, number> = {};
  const sizeCounts: Record<string, number> = {};
  for (const s of spans) {
    const family = getFontFamily(s.fontname, _preserveStyle);
    famCounts[family] = (famCounts[family] || 0) + 1;
    const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
    sizeCounts[sz] = (sizeCounts[sz] || 0) + 1;
  }
  const dominantFamily = Object.entries(famCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  const dominantSize = parseFloat(Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '10');
  return { dominantFamily, dominantSize };
}

function groupIntoLines(spans: InputRect[]): InputRect[][] {
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: InputRect[][] = [];
  let curr: InputRect[] = [];
  let currTop = -Infinity;
  for (const s of sorted) {
    if (curr.length === 0) { curr = [s]; currTop = s.top; }
    else if (Math.abs(s.top - currTop) <= 3) { curr.push(s); }
    else { lines.push(curr); curr = [s]; currTop = s.top; }
  }
  if (curr.length > 0) lines.push(curr);
  return lines;
}

/**
 * Step 7: Split paragraph by font family change.
 *
 * Per user spec:
 *   - Split by "different family" (Bold, Italic, different real family)
 *     NOT by "different from dominant". A 50/50 paragraph MUST split into 2.
 *   - EXCEPTION: links/special symbols INSIDE the main text that are much
 *     smaller (e.g., footnote refs, superscripts) should NOT trigger a split
 *     — they merge back into the surrounding main text.
 *
 * Algorithm:
 *   1. Group spans into lines (by Y position).
 *   2. For each line, determine its "primary family" (the family used by
 *      main-size spans — decoration spans are ignored for family calc).
 *   3. Walk lines top-to-bottom. Whenever the primary family changes from
 *      one line to the next, start a new sub-paragraph.
 *   4. Consecutive lines with the same primary family stay grouped.
 *
 * This produces N sub-paragraphs for N distinct family regions, regardless
 * of which family is "dominant" overall.
 */
function splitByFont(paras: Paragraph[], fontSizeTolerance: number): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length <= 1) { result.push(para); continue; }

    // Compute primary family for each line (decoration spans excluded)
    const lineStyles = lines.map(lineSpans => {
      const candidates: Array<{ family: string; size: number }> = [];
      for (const s of lineSpans as any[]) {
        const fam = getFontFamily(s.fontname, _preserveStyle);
        const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
        candidates.push({ family: fam, size: sz });
      }

      // Find median size of this line
      const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
      const median = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 10;
      const DECORATION_THRESHOLD = median * _decorationThreshold;  // <70% of median = decoration

      // Filter decorations out
      const mainCandidates = candidates.filter(c => c.size >= DECORATION_THRESHOLD);

      // Find primary family (most spans; ties broken by first occurrence)
      const famCounts: Record<string, number> = {};
      let firstFam = '';
      for (const c of mainCandidates) {
        if (!firstFam) firstFam = c.family;
        famCounts[c.family] = (famCounts[c.family] || 0) + 1;
      }
      let primaryFam = firstFam || 'unknown';
      let maxCount = 0;
      for (const [fam, count] of Object.entries(famCounts)) {
        if (count > maxCount || (count === maxCount && fam === firstFam)) {
          maxCount = count;
          primaryFam = fam;
        }
      }

      // Also compute median size (for size-change detection)
      const primarySize = median;

      return { lineSpans, primaryFam, primarySize };
    });

    // Walk lines and group by primary family
    // Split point: line N (N > 0) starts a new group if its primaryFam
    // differs from line N-1's primaryFam.
    const subGroups: Array<{ lines: typeof lineStyles; family: string }> = [];
    let currGroup: typeof lineStyles = [lineStyles[0]];
    let currFam = lineStyles[0].primaryFam;

    for (let i = 1; i < lineStyles.length; i++) {
      const ls = lineStyles[i];
      if (ls.primaryFam !== currFam) {
        // Family change → start new group
        subGroups.push({ lines: currGroup, family: currFam });
        currGroup = [ls];
        currFam = ls.primaryFam;
      } else {
        currGroup.push(ls);
      }
    }
    if (currGroup.length > 0) {
      subGroups.push({ lines: currGroup, family: currFam });
    }

    if (subGroups.length <= 1) {
      result.push(para);
      continue;
    }

    // Emit one paragraph per subgroup
    for (const sg of subGroups) {
      const sgSpans = sg.lines.flatMap((l: any) => l.lineSpans);
      if (sgSpans.length === 0) continue;
      const { dominantFamily, dominantSize } = computeDominantFont(sgSpans);
      result.push(makeParagraph(sgSpans, dominantFamily, dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

/**
 * STEP 7.7 (LAYOUT-FIX-6, 2026-09-16): Split at style boundaries without
 * flow continuity.
 *
 * LAYOUT-FIX-5 (preserveStyle:false) made splitByFont style-blind, so a
 * geometric island whose consecutive line RUNS switch full font
 * (Regular↔Italic of one base family) stays ONE unit — correct for italic
 * phrases flowing mid-sentence (book p.11 Preface), wrong for captions,
 * TOC entries and labels chained into body text on dense book pages.
 *
 * Algorithm per paragraph:
 *   1. Group spans into lines (groupIntoLines).
 *   2. Group lines into RUNS of equal majority full font name.
 *   3. Between consecutive runs R_i, R_i+1 whose full fonts DIFFER but
 *      share the base family (style variant pair): keep them together
 *      only when runsFlowContinuous(R_i, R_i+1) — positive sentence-flow
 *      evidence (tight gap + same column/size + mid-sentence ending +
 *      no caption/page-number markers). Otherwise SPLIT.
 *   4. Runs of DIFFERENT base families are left alone here — STEP 7
 *      (splitByFont) already handles base-family changes.
 *
 * Inline emphasis inside one line is unaffected (a line's majority font
 * only changes when the whole line switches style).
 */
function splitByStyleFlow(paras: Paragraph[]): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length <= 1) { result.push(para); continue; }

    // Majority full font per line (decoration-aware), mirroring the
    // splitByFont line-style computation but on FULL font names.
    const lineFonts = lines.map(lineSpans => {
      const candidates: Array<{ font: string; size: number }> = [];
      for (const s of lineSpans as any[]) {
        candidates.push({ font: fullFontName(s.fontname), size: Number.isFinite(s.fontsize) ? s.fontsize! : 10 });
      }
      const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
      const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
      const decorationThreshold = median * _decorationThreshold;
      const counts: Record<string, number> = {};
      let first = '';
      for (const c of candidates) {
        if (c.size < decorationThreshold) continue;
        if (!first) first = c.font;
        counts[c.font] = (counts[c.font] || 0) + 1;
      }
      let best = first || 'unknown';
      let bestCount = 0;
      for (const [f, c] of Object.entries(counts)) {
        if (c > bestCount || (c === bestCount && f === first)) { bestCount = c; best = f; }
      }
      return best;
    });

    // Group consecutive lines into runs of equal majority full font.
    const runs: Array<{ font: string; lines: InputRect[][] }> = [];
    let curRun: { font: string; lines: InputRect[][] } | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (!curRun || curRun.font !== lineFonts[i]) {
        curRun = { font: lineFonts[i], lines: [lines[i]] };
        runs.push(curRun);
      } else {
        curRun.lines.push(lines[i]);
      }
    }
    if (runs.length <= 1) { result.push(para); continue; }

    // Walk run pairs; keep them together only with flow evidence.
    // Groups of runs are accumulated; a boundary without flow evidence
    // starts a new group.
    const groups: InputRect[][][] = [];      // groups of runs
    let curGroup: InputRect[][] = [...runs[0].lines];

    for (let r = 1; r < runs.length; r++) {
      const prev = runs[r - 1];
      const cur = runs[r];
      const together =
        !isStyleVariantPair(prev.font, cur.font) ||
        runsFlowContinuous(
          prev.lines[prev.lines.length - 1],
          cur.lines[0],
          lineTextOf(prev.lines[0]),
        );
      if (together) {
        curGroup.push(...cur.lines);
      } else {
        groups.push(curGroup);
        curGroup = [...cur.lines];
      }
    }
    groups.push(curGroup);

    if (groups.length <= 1) { result.push(para); continue; }

    // Emit one paragraph per group.
    for (const g of groups) {
      const spans = g.flatMap(l => l as InputRect[]);
      if (spans.length === 0) continue;
      const { dominantFamily, dominantSize } = computeDominantFont(spans);
      result.push(makeParagraph(spans, dominantFamily, dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

// ═══ STEP 7.3 (LAYOUT-FIX-14): split by font size class / family ═══

/**
 * Split a paragraph's rows into x-clusters at horizontal gaps ≥
 * X_CLUSTER_GAP. An interleaved row (slicer failure) carries both columns'
 * texts; the clusters give each half its own size/family class. Returns
 * clusters in x order, each cluster's spans in x order.
 */
function rowXClusters(line: InputRect[]): InputRect[][] {
  const sorted = [...line].sort((a, b) => a.left - b.left);
  const clusters: InputRect[][] = [];
  let cur: InputRect[] = [];
  let curRight = -Infinity;
  for (const s of sorted) {
    if (cur.length > 0 && s.left - curRight >= X_CLUSTER_GAP) {
      clusters.push(cur); cur = [];
    }
    cur.push(s);
    curRight = Math.max(curRight, s.right);
  }
  if (cur.length > 0) clusters.push(cur);
  return clusters;
}

/** Width-weighted median font size of a span collection (decoration spans
 * below 70% of the collection's median follow their cluster's class and
 * are excluded here). The width weighting keeps pdfjs's inflated heights
 * for short italic/superscript runs (a 12pt "et" inside a 7pt references
 * block) from moving the median — the tiny run carries almost no ink. */
function weightedMedianSize(spans: InputRect[]): number {
  const sized = spans
    .map(s => ({ fs: Number.isFinite((s as any).fontsize) ? (s as any).fontsize as number : 10, w: Math.max(1, s.right - s.left) }))
    .sort((a, b) => a.fs - b.fs);
  if (sized.length === 0) return 10;
  const median = sized[Math.floor(sized.length / 2)].fs;
  const thr = median * _decorationThreshold;
  const main = sized.filter(s => s.fs >= thr);
  const pool = main.length > 0 ? main : sized;
  const total = pool.reduce((s, e) => s + e.w, 0);
  if (total <= 0) return pool[Math.floor(pool.length / 2)].fs;
  let acc = 0;
  for (const e of pool) {
    acc += e.w;
    if (acc >= total / 2) return e.fs;
  }
  return pool[pool.length - 1].fs;
}

/**
 * STEP 7.3 core. Partition each paragraph into per-(size class, base
 * family) units. See the buildParagraphsInRegion call-site comment for
 * the guard list and the user rule («разные размеры/семейства не
 * сливаются; исключение — подписи Fig/Figure/Table»).
 *
 * Algorithm (v3):
 *   1. Rows → x-clusters at gaps ≥ X_CLUSTER_GAP (clean column gutters).
 *   2. Per x-cluster: sub-groups by (size class, base family) over
 *      non-decoration spans; decorations (< 70% of the cluster's median
 *      size — superscript refs) attach to the cluster's majority
 *      sub-group.
 *   3. A MINORITY sub-group separates from its cluster ONLY when it
 *      CHAINS vertically: a same-key sub-group in the row above or
 *      below overlaps it by ≥ 50% of ITS OWN width. Chained sub-groups
 *      are column material — including the pdfjs D1-bridge case: a body
 *      line's last span is declared past the right column's start, so
 *      the x-gap test cannot see the gutter, but the 9.03 tail chains
 *      with the body above while the 8.02 spans chain with the caption
 *      block below, and the two classes part ways inside one cluster.
 *      Non-chained minorities (an inline italic phrase, a label span)
 *      stay with the cluster majority — the inline-emphasis rule.
 *   4. Caption-label glue: a standalone small caption-prefixed sub-group
 *      (≤3 spans, «Fig/Figure/Table…» or a bare A/B panel marker) glues
 *      to the nearest sub-group BELOW it or ROW-OVERLAPPING it (the
 *      user's label exception).
 */
function splitBySizeClass(paras: Paragraph[]): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const rows = groupIntoLines(para.spans);
    if (rows.length <= 1) { result.push(para); continue; }

    // ── table guard: TABLE-KEEP rows are cell rows, not prose classes ──
    const rowTexts = rows.map(line => line.map(s => (s as any).text || '').join('').trim()).filter(t => t);
    if (rowTexts.length >= 2 && isTableLikeRowTexts(rowTexts)) { result.push(para); continue; }

    // ── TOC guard: entry chains with companion page numbers ───────────
    const tocRows = rows.filter(line => lineEndsWithCompanionNumber(line)).length;
    if (rows.length >= 2 && tocRows / rows.length >= 0.5) { result.push(para); continue; }

    // ── classify: rows → x-clusters → class sub-groups ─────────────────
    interface SubGroup {
      spans: InputRect[]; size: number; fam: string;
      yTop: number; yBottom: number; xL: number; xR: number; text: string;
      ownKey: string;      // "size|fam" (raw size)
      majKey: string;      // cluster majority's "size|fam"
      separate: boolean;   // chains vertically → leaves the cluster
    }
    const rowGroups: SubGroup[][] = [];
    const allGroups: SubGroup[] = [];

    // pass 1: raw per-cluster sub-groups (ownKey only)
    interface RawSub { spans: InputRect[]; size: number; fam: string; cluster: number }
    const rawRows: RawSub[][] = [];
    let clusterSeq = 0;
    for (const row of rows) {
      const gs: RawSub[] = [];
      for (const xc of rowXClusters(row)) {
        if (xc.length === 0) continue;
        const clusterId = clusterSeq++;
        const clusterMedian = weightedMedianSize(xc);
        const thr = clusterMedian * _decorationThreshold;
        const byKey = new Map<string, RawSub>();
        const decoSpans: InputRect[] = [];
        for (const s of xc) {
          const fs = Number.isFinite((s as any).fontsize) ? (s as any).fontsize as number : 10;
          if (fs < thr) { decoSpans.push(s); continue; }
          const fam = getFontFamily((s as any).fontname, false);
          const k = fs.toFixed(2) + '|' + fam;
          let sub = byKey.get(k);
          if (!sub) { sub = { spans: [], size: fs, fam, cluster: clusterId }; byKey.set(k, sub); }
          sub.spans.push(s);
        }
        // decorations attach to the cluster's ink-majority sub-group
        if (byKey.size > 0) {
          let maj: RawSub | null = null; let majInk = -1;
          for (const sub of byKey.values()) {
            const w = sub.spans.reduce((s, e) => s + Math.max(1, e.right - e.left), 0);
            if (w > majInk) { majInk = w; maj = sub; }
          }
          maj!.spans.push(...decoSpans);
        }
        for (const sub of byKey.values()) gs.push(sub);
      }
      rawRows.push(gs);
    }

    // pass 2: size anchors across ALL sub-groups (heaviest ink first)
    const inkBySize = new Map<number, number>();
    for (const gs of rawRows) for (const g of gs) {
      inkBySize.set(g.size, (inkBySize.get(g.size) || 0) + g.spans.reduce((s, e) => s + Math.max(1, e.right - e.left), 0));
    }
    const sizeAnchor = new Map<number, number>();
    const anchors: number[] = [];
    const bySize = [...inkBySize.keys()].sort((a, b) => (inkBySize.get(b) || 0) - (inkBySize.get(a) || 0));
    for (const size of bySize) {
      let assigned = -1;
      for (let ci = 0; ci < anchors.length; ci++) {
        if (Math.abs(anchors[ci] - size) <= SIZE_CLASS_TOL) { assigned = ci; break; }
      }
      if (assigned < 0) { anchors.push(size); assigned = anchors.length - 1; }
      sizeAnchor.set(size, anchors[assigned]);
    }
    if (anchors.length <= 1) { result.push(para); continue; }   // single size class — fast path

    const classKey = (size: number, fam: string) => sizeAnchor.get(size)!.toFixed(2) + '|' + fam;

    // pass 3: per-row groups with CLUSTER-majority + chain separation.
    // The majority is scoped to the sub-group's own X-CLUSTER (not the
    // whole row): a D1-bridge tail of the BODY column that lands in the
    // caption's cluster must not follow the caption's ink majority — with
    // a row-scoped majority it did exactly that when the caption's ink
    // outweighed the body's on that row (synthetic t14 case 1b).
    const clusterMajKey = new Map<number, string>();
    const clusterMajInk = new Map<number, number>();
    for (const gs of rawRows) {
      for (const g of gs) {
        const k = classKey(g.size, g.fam);
        const w = g.spans.reduce((s, e) => s + Math.max(1, e.right - e.left), 0);
        if (w > (clusterMajInk.get(g.cluster) || -1)) {
          clusterMajKey.set(g.cluster, k);
          clusterMajInk.set(g.cluster, w);
        }
      }
    }
    for (let ri = 0; ri < rawRows.length; ri++) {
      const gs = rawRows[ri];
      if (gs.length === 0) { rowGroups.push([]); continue; }
      const built: SubGroup[] = gs.map(g => {
        const xL = Math.min(...g.spans.map(s => s.left));
        const xR = Math.max(...g.spans.map(s => s.right));
        const ownKey = classKey(g.size, g.fam);
        const majKey = clusterMajKey.get(g.cluster) || ownKey;
        // chain test against the row above/below
        let chain = false;
        if (ownKey !== majKey) {
          for (const nr of [ri - 1, ri + 1]) {
            if (nr < 0 || nr >= rawRows.length) continue;
            for (const og of rawRows[nr]) {
              if (classKey(og.size, og.fam) !== ownKey) continue;
              const oL = Math.min(...og.spans.map(s => s.left));
              const oR = Math.max(...og.spans.map(s => s.right));
              const ov = Math.min(xR, oR) - Math.max(xL, oL);
              if (ov >= 0.5 * Math.max(1, xR - xL)) { chain = true; break; }
            }
            if (chain) break;
          }
        }
        return {
          spans: g.spans, size: g.size, fam: g.fam,
          yTop: Math.min(...g.spans.map(s => s.top)),
          yBottom: Math.max(...g.spans.map(s => s.bottom)),
          xL, xR,
          text: g.spans.map(s => (s as any).text || '').join('').trim(),
          ownKey, majKey, separate: chain,
        };
      });
      rowGroups.push(built);
      allGroups.push(...built);
    }
    if (allGroups.length === 0) { result.push(para); continue; }
    if (new Set(allGroups.map(g => g.ownKey)).size <= 1) { result.push(para); continue; }

    // ── caption-label glue (standalone label rows / label clusters) ────
    // A label group binds to the nearest candidate group BELOW it or
    // ROW-OVERLAPPING it. Candidate ranking: x-overlap with the label
    // first (a caption label sits at the caption's x-range — the D1
    // bridge tails of the BODY column also reach into that range, so a
    // pure y-order tie-break grabs the body group: measured on p61-solo,
    // «Figure 2.13» 7.02 landed in the body unit), then vertical gap,
    // then horizontal gap, then ink width.
    const glue = new Map<SubGroup, SubGroup>();
    for (const g of allGroups) {
      const isLabel =
        g.spans.length <= 3 &&
        (isCaptionStartText(g.text) || /^(?:[A-Z][).]?|[ivx]+[).])$/.test(g.text));
      if (!isLabel) continue;
      const pitch = 1.35 * Math.max(6, g.size);
      const gW = Math.max(1, g.xR - g.xL);
      let best: SubGroup | null = null;
      let bestScore: number[] | null = null;
      for (const og of allGroups) {
        if (og === g) continue;
        const overlapsRow = og.yTop <= g.yBottom + 2 && og.yBottom >= g.yTop - 2;
        const below = og.yTop >= g.yBottom - 2 && og.yTop - g.yBottom <= 3 * pitch;
        if (!overlapsRow && !below) continue;
        const vGap = Math.max(0, og.yTop - g.yBottom, g.yTop - og.yBottom);
        const hGap = Math.max(0, og.xL - g.xR, g.xL - og.xR);
        const ov = Math.max(0, Math.min(g.xR, og.xR) - Math.max(g.xL, og.xL));
        const ink = og.spans.reduce((s, e) => s + Math.max(1, e.right - e.left), 0);
        const score = [-ov / gW, vGap, hGap, -ink];
        if (bestScore === null) { best = og; bestScore = score; continue; }
        let cmp = 0;
        for (let i = 0; i < score.length; i++) {
          if (score[i] < bestScore[i]) { cmp = -1; break; }
          if (score[i] > bestScore[i]) { cmp = 1; break; }
        }
        if (cmp < 0) { best = og; bestScore = score; }
      }
      if (best !== null && best.ownKey !== g.ownKey) glue.set(g, best);
    }

    // ── emit key per group: own key (separated/unique) / cluster majority
    //    / glue target's key (chased transitively, ≤5 hops) ─────────────
    const keyOf = (g: SubGroup, seen = 0): string => {
      if (glue.has(g) && seen < 5) return keyOf(glue.get(g)!, seen + 1);
      return g.separate ? g.ownKey : g.majKey;
    };
    const emit = new Map<string, InputRect[]>();
    for (const g of allGroups) {
      const key = keyOf(g);
      const arr = emit.get(key) || [];
      arr.push(...g.spans);
      emit.set(key, arr);
    }
    if (emit.size <= 1) { result.push(para); continue; }

    for (const [, spans] of emit) {
      if (spans.length === 0) continue;
      const { dominantFamily, dominantSize } = computeDominantFont(spans);
      result.push(makeParagraph(spans, dominantFamily, dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

/**
 * Step 7.6: Re-merge islands AFTER splitByFont.
 *
 * After splitByFont, one original island may be split into multiple
 * sub-paragraphs (e.g. drop-cap "A" separated from body text by size
 * threshold). These fragments need to be re-merged if:
 *   1. Their SOURCE islands physically touched (we use the original
 *      `touchPairs` Set from Step 6 — only pairs already known to touch).
 *   2. They share the same primary font family (decoration-aware).
 *   3. Their primary sizes are compatible: either within fontSizeTolerance,
 *      OR one of them is a "drop-cap" (size ≥ 2.5× the other's primary size),
 *      in which case the larger is treated as an inline decoration of the
 *      smaller body text — they merge.
 *
 * CRITICAL RULE: only pairs in `touchPairs` (built from `cellIslandId`
 * 4-neighbour adjacency in Step 5) are considered. Non-touching islands
 * NEVER merge.
 *
 * Algorithm:
 *   1. For each sub-paragraph, find its SOURCE island id (the original
 *      island whose cellIslandId region contained it).
 *   2. For each pair (P_a, P_b) of sub-paragraphs whose source islands
 *      are in `touchPairs`:
 *      - If sameFont(P_a, P_b) AND sizeCompatible(P_a, P_b) → merge.
 *   3. Iterate until no changes (or MAX_MERGE_PASSES reached).
 */
function remergeAfterFontSplit(
  paras: Paragraph[],
  touchPairs: Set<string>,
  // Stage 0.2 (Q8): key type updated to string to match the caller.
  islandById: Map<string, Paragraph>,
  fontSizeTolerance: number,
  cellSize: number,
  gridW: number,
  gridH: number,
  cellIslandId: Int32Array,
  rects: InputRect[],
): Paragraph[] {
  if (paras.length <= 1) return paras;

  // Build a quick-lookup Set of touch pair keys
  const touchSet = new Set<string>(touchPairs);

  /**
   * Find the original island ID that owns a sub-paragraph.
   * Strategy: take the first span's center cell and look up cellIslandId.
   * Returns -1 if the span falls outside the grid.
   */
  function findSourceIslandId(para: Paragraph): number {
    if (para.spans.length === 0) return -1;
    // Use the median span position (avoid outlier at extreme corner)
    const sortedSpans = [...para.spans].sort((a, b) =>
      (a.top - b.top) || (a.left - b.left));
    const mid = sortedSpans[Math.floor(sortedSpans.length / 2)];
    const cx = Math.floor(((mid.left + mid.right) / 2) / cellSize);
    const cy = Math.floor(((mid.top + mid.bottom) / 2) / cellSize);
    if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) return -1;
    return cellIslandId[cy * gridW + cx];
  }

  // Cache source island IDs
  const sourceIds = new Map<Paragraph, number>();
  for (const p of paras) sourceIds.set(p, findSourceIslandId(p));

  /**
   * Collect the set of occupied cells that belong to a sub-paragraph.
   * For each span, mark its center cell (and surrounding cells if the
   * span covers more than one cell).
   *
   * Used to check physical adjacency between two sub-paragraphs that
   * came from the SAME source island (after font split).
   */
  function collectCells(para: Paragraph): Set<number> {
    const cells = new Set<number>();
    for (const r of para.spans) {
      const x0 = Math.max(0, Math.floor(r.left / cellSize));
      const y0 = Math.max(0, Math.floor(r.top / cellSize));
      const x1 = Math.min(gridW - 1, Math.floor((r.right - 0.01) / cellSize));
      const y1 = Math.min(gridH - 1, Math.floor((r.bottom - 0.01) / cellSize));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          cells.add(y * gridW + x);
        }
      }
    }
    return cells;
  }

  // Cache cells per paragraph
  const cellsCache = new Map<Paragraph, Set<number>>();
  for (const p of paras) cellsCache.set(p, collectCells(p));

  /**
   * Check if two cell sets physically touch (4-neighbour adjacency).
   * Returns true if any cell of A is 4-adjacent to any cell of B.
   */
  function cellSetsTouch(cellsA: Set<number>, cellsB: Set<number>): boolean {
    for (const idx of cellsA) {
      const x = idx % gridW;
      const y = Math.floor(idx / gridW);
      const neighbours = [
        (x - 1) + y * gridW,
        (x + 1) + y * gridW,
        x + (y - 1) * gridW,
        x + (y + 1) * gridW,
      ];
      for (const n of neighbours) {
        if (cellsB.has(n)) return true;
      }
    }
    return false;
  }

  /**
   * Get primary family (decoration-aware, same as Step 6).
   * Re-implemented locally to avoid capturing closure vars.
   */
  function getPrimaryFamilyLocal(para: Paragraph): string {
    const candidates: Array<{ family: string; size: number }> = [];
    for (const s of para.spans as any[]) {
      const fam = getFontFamily(s.fontname, _preserveStyle);
      const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
      candidates.push({ family: fam, size: sz });
    }
    if (candidates.length === 0) return 'unknown';
    const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const DECORATION_THRESHOLD = median * _decorationThreshold;
    const mainSpans = candidates.filter(c => c.size >= DECORATION_THRESHOLD);
    const famCounts: Record<string, number> = {};
    let firstFamily = '';
    for (const c of mainSpans) {
      if (!firstFamily) firstFamily = c.family;
      famCounts[c.family] = (famCounts[c.family] || 0) + 1;
    }
    let bestFam = firstFamily || 'unknown';
    let bestCount = 0;
    for (const [fam, count] of Object.entries(famCounts)) {
      if (count > bestCount || (count === bestCount && fam === firstFamily)) {
        bestCount = count;
        bestFam = fam;
      }
    }
    return bestFam;
  }

  /**
   * Get primary size: the median fontsize of non-decoration spans.
   * Used for size-compatibility check.
   */
  function getPrimarySize(para: Paragraph): number {
    const candidates: number[] = [];
    for (const s of para.spans as any[]) {
      const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
      candidates.push(sz);
    }
    if (candidates.length === 0) return 10;
    const sorted = candidates.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const DECORATION_THRESHOLD = median * _decorationThreshold;
    const mainSizes = candidates.filter(s => s >= DECORATION_THRESHOLD);
    if (mainSizes.length === 0) return median;
    mainSizes.sort((a, b) => a - b);
    return mainSizes[Math.floor(mainSizes.length / 2)];
  }

  /**
   * Two paragraphs are size-compatible if:
   *   - |primarySize_a - primarySize_b| <= min(fontSizeTolerance,
   *     SIZE_CLASS_TOL) — the LAYOUT-FIX-14 font-homogeneity rule (user:
   *     «параграфы с разными размерами не сливаются»); pre-14 the window
   *     was the raw fontSizeTolerance (default 1pt), which let e.g. an
   *     8.5pt caption chain re-merge into a 9.3pt body block;
   *   - OR one is a "drop-cap": larger primary size >= 2.5 × smaller
   *     primary size (the drop-cap is treated as an inline decoration of
   *     the body text);
   *   - OR the pair is a caption label + caption text (the «Fig, Figure,
   *     Table» exception — the label line may differ from the caption's
   *     body size/family by up to 2pt).
   */
  function sizeCompatible(a: Paragraph, b: Paragraph): boolean {
    const sa = getPrimarySize(a);
    const sb = getPrimarySize(b);
    // LAYOUT-FIX-14: caption-label exception (label line above caption text).
    if (!_disableFontClassSplit &&
        (isCaptionLabelParagraph(a) || isCaptionLabelParagraph(b)) &&
        Math.abs(sa - sb) <= 2.0) {
      return true;
    }
    const tol = _disableFontClassSplit ? fontSizeTolerance : Math.min(fontSizeTolerance, SIZE_CLASS_TOL);
    if (Math.abs(sa - sb) <= tol) return true;
    const larger = Math.max(sa, sb);
    const smaller = Math.min(sa, sb);
    if (smaller > 0 && larger / smaller >= 2.5) return true;  // drop-cap case
    return false;
  }

  /**
   * Check if two paragraphs' source islands physically touched.
   *
   * Two cases:
   *   1. Different source islands — check the original touchPairs Set.
   *   2. SAME source island (after font split) — verify that their actual
   *      occupied cells are 4-neighbour adjacent. This is more strict than
   *      "they share an island ID" — we want to ensure the cells literally
   *      touch, so that non-adjacent fragments (e.g. left column + right
   *      column from a wrongly-merged super-island) do NOT re-merge.
   */
  function physicallyTouch(a: Paragraph, b: Paragraph): boolean {
    const idA = sourceIds.get(a);
    const idB = sourceIds.get(b);
    if (idA < 0 || idB < 0) return false;
    if (idA === idB) {
      // Same source island — verify actual cell adjacency.
      const cellsA = cellsCache.get(a);
      const cellsB = cellsCache.get(b);
      if (!cellsA || !cellsB) return false;
      return cellSetsTouch(cellsA, cellsB);
    }
    // Different source islands — use original touchPairs.
    const key = idA < idB ? idA + '_' + idB : idB + '_' + idA;
    return touchSet.has(key);
  }

  // ── Merge loop ───────────────────────────────────────────────────
  // Build working list of "alive" paragraphs (not merged).
  // Each iteration: find first compatible touching pair, merge, repeat.
  let changed = true;
  let passes = 0;
  const MAX_PASSES = 10;

  while (changed && passes < MAX_PASSES) {
    changed = false;
    passes++;

    // Sort by reading order for deterministic merge direction
    paras.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

    for (let i = 0; i < paras.length; i++) {
      const a = paras[i];
      if (a._merged) continue;

      for (let j = i + 1; j < paras.length; j++) {
        const b = paras[j];
        if (b._merged) continue;

        // CRITICAL: only physically touching islands can merge.
        const touch = physicallyTouch(a, b);
        if (!touch) continue;

        // Same primary family
        const famA = getPrimaryFamilyLocal(a);
        const famB = getPrimaryFamilyLocal(b);
        if (famA !== famB) continue;

        // ── STYLE-FLOW GATE (Step 8.5, LAYOUT-FIX-6) ────────────────
        // Same rule as the Step 6 gate: style-variant pairs re-merge only
        // with sentence-flow evidence. Without this, Step 8.5 would undo
        // the STEP 7.7 style-flow splits (same source island + touching
        // cells + same base family otherwise re-merges them).
        if (!_disableStyleFlowGuard) {
          const aFull = primaryFullFontName(a);
          const bFull = primaryFullFontName(b);
          if (isStyleVariantPair(aFull, bFull)) {
            const upper = a.pxTop <= b.pxTop ? a : b;
            const lower = a.pxTop <= b.pxTop ? b : a;
            if (!parasFlowContinuous(upper, lower)) continue;
          }
        }

        // Size compatible (same body size OR drop-cap)
        const szCompat = sizeCompatible(a, b);
        if (!szCompat) continue;

        // ── TABLE-CELL GUARD ──────────────────────────────────────────
        // Do NOT merge two paragraphs if they sit SIDE-BY-SIDE horizontally
        // with a clear vertical gap between them. This pattern is typical of
        // table cells in the same row:
        //
        //   | Cell A   | Cell B   | Cell C   |
        //   | text...  | text...  | text...  |
        //
        // Cells in the same row touch vertically (same top/bottom) but are
        // separated by a horizontal gap. Merging them would destroy the
        // table structure and produce one giant paragraph per row.
        //
        // Detection: if the horizontal gap between A and B is significant
        // (>= 1.5× the median line height of the smaller paragraph) AND
        // their vertical ranges overlap by > 50% of the smaller height,
        // treat them as table cells and SKIP the merge.
        const hGap = Math.max(0, Math.max(a.pxLeft, b.pxLeft) - Math.min(a.pxRight, b.pxRight));
        const vOverlapTop = Math.max(a.pxTop, b.pxTop);
        const vOverlapBottom = Math.min(a.pxBottom, b.pxBottom);
        const vOverlap = Math.max(0, vOverlapBottom - vOverlapTop);
        const smallerHeight = Math.min(a.pxBottom - a.pxTop, b.pxBottom - b.pxTop);
        const vOverlapFrac = smallerHeight > 0 ? vOverlap / smallerHeight : 0;
        // Estimate line height from span sizes (median font size × 1.2)
        const aSizes = a.spans.map((s: any) => Number.isFinite(s.fontsize) ? s.fontsize : 10).sort((x, y) => x - y);
        const bSizes = b.spans.map((s: any) => Number.isFinite(s.fontsize) ? s.fontsize : 10).sort((x, y) => x - y);
        const medianSize = aSizes.length && bSizes.length
          ? Math.min(aSizes[Math.floor(aSizes.length / 2)], bSizes[Math.floor(bSizes.length / 2)])
          : 10;
        const estLineHeight = medianSize * 1.2;
        const isTablePattern = hGap >= estLineHeight * 1.5 && vOverlapFrac > 0.5;
        if (isTablePattern) {
          continue;
        }

        // Merge b into a
        a.spans.push(...b.spans);
        a.pxLeft = Math.min(a.pxLeft, b.pxLeft);
        a.pxTop = Math.min(a.pxTop, b.pxTop);
        a.pxRight = Math.max(a.pxRight, b.pxRight);
        a.pxBottom = Math.max(a.pxBottom, b.pxBottom);
        a.width = a.pxRight - a.pxLeft;
        a.height = a.pxBottom - a.pxTop;
        const recomputed = computeDominantFont(a.spans);
        a.dominantFamily = recomputed.dominantFamily;
        a.dominantSize = recomputed.dominantSize;
        // Update cell cache: union of A and B cells (for future adjacency checks)
        const cellsA = cellsCache.get(a)!;
        const cellsB = cellsCache.get(b)!;
        for (const c of cellsB) cellsA.add(c);
        cellsCache.set(a, cellsA);
        b._merged = true;
        changed = true;
        break;  // restart outer loop after a merge (safer)
      }
    }
  }

  return paras.filter(p => !p._merged);
}

function splitByParagraphMarkers(paras: Paragraph[]): Paragraph[] {
  const result: Paragraph[] = [];

  // Known structural labels that ALWAYS start a new paragraph.
  // Matched case-insensitively at the start of a line's text.
  const STRUCTURAL_LABELS = [
    /^corresponding\s+author/i,
    /^correspondence\s*:/i,
    /^email\s*:/i,
    /^supplemental\s+material/i,
    /^supplementary\s+material/i,
    /^author\s+contributions?\s*:/i,
    /^acknowledg(e?)ments?\s*:/i,
    /^conflicts?\s+of\s+interest\s*:/i,
    /^declaration/i,
    /^references\s*:/i,
    /^funding\s*:/i,
    /^data\s+availability\s*:/i,
    /^ethics\s+approval\s*:/i,
    /^abbreviations?\s*:/i,
    /^keywords?\s*:/i,
    /^abstract\s*:/i,
  ];

  // Footnote number pattern: 1-3 digits at start of line, followed by
  // a capital letter or symbol (avoid matching decimal numbers like "3.5"
  // or page numbers mid-line).
  // Examples that match: "1University", "12Smith", "3The"
  // Examples that don't match: "3.5", "100", "12."
  const FOOTNOTE_NUM = /^\d{1,3}(?=[A-ZÀ-Þ\u00c0-\u00de«ª])/;

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length <= 1) { result.push(para); continue; }

    // Get text content of each line (concatenated spans, trimmed)
    const lineTexts = lines.map(line =>
      line.map(s => (s as any).text || '').join('').trim()
    );

    // Detect split points: line N (N > 0) starts a new paragraph if:
    //   - It matches a structural label, OR
    //   - It starts with a footnote number pattern AND the previous line
    //     doesn't look like a footnote continuation
    const splitPoints: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const text = lineTexts[i];
      if (!text) continue;

      let isSplitPoint = false;

      // Check structural labels
      for (const pattern of STRUCTURAL_LABELS) {
        if (pattern.test(text)) {
          isSplitPoint = true;
          break;
        }
      }

      // Check footnote number pattern
      if (!isSplitPoint && FOOTNOTE_NUM.test(text)) {
        // Footnote pattern: digit(s) immediately followed by capital letter.
        // This is a strong signal of a new footnote even if the previous
        // line doesn't end with a sentence terminator (footnote text often
        // wraps without punctuation at line end).
        //
        // Additional guard: only trigger if previous line text is non-empty
        // AND doesn't itself start with the same footnote pattern (otherwise
        // we'd split every line of a single footnote that starts with a number).
        const prevText = lineTexts[i - 1] || '';
        const prevStartsWithFootnote = FOOTNOTE_NUM.test(prevText);
        if (prevText && !prevStartsWithFootnote) {
          isSplitPoint = true;
        } else if (prevStartsWithFootnote) {
          // Both prev and current start with footnote number — definitely
          // different footnotes, split.
          isSplitPoint = true;
        }
      }

      if (isSplitPoint) {
        splitPoints.push(i);
      }
    }

    if (splitPoints.length === 0) {
      result.push(para);
      continue;
    }

    // Split the paragraph at detected split points
    const subGroups: InputRect[][][] = [];
    let startIdx = 0;
    for (const sp of splitPoints) {
      subGroups.push(lines.slice(startIdx, sp));
      startIdx = sp;
    }
    subGroups.push(lines.slice(startIdx));

    for (const sg of subGroups) {
      const sgSpans = sg.flatMap(l => l);
      if (sgSpans.length === 0) continue;
      result.push(makeParagraph(sgSpans, para.dominantFamily, para.dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

/**
 * Step 8.6: Split by standard paragraph indent (final pass after remerge).
 *
 * Detects "real" paragraph indents — where one line has left margin
 * increased by > indentThreshold from bodyLeft, and the NEXT line
 * returns to bodyLeft. This is the standard typographic convention
 * for "new paragraph starts here" (first-line indent).
 *
 * Does NOT split when consecutive lines are all indented (that's
 * drop-cap wrap or table layout, handled elsewhere).
 *
 * Algorithm:
 *   1. Group spans into lines.
 *   2. Find bodyLeft = most common leftmost.
 *   3. Walk lines. For each line i (i > 0):
 *      - isIndented = leftmost_i > bodyLeft + indentThreshold
 *      - nextIsBody = (i+1 < n) && |leftmost_{i+1} - bodyLeft| <= indentThreshold
 *        OR (i+1 == n) — last line, treat as "next is body" (end of paragraph)
 *      - If isIndented AND nextIsBody → split BEFORE line i.
 *   4. Emit one paragraph per subgroup.
 *
 * Edge cases:
 *   - First line of paragraph can be indented (that's the paragraph's own
 *     first-line indent, not a break point). We don't split before line 0.
 *   - If a paragraph has only 1-2 lines, skip (not enough signal).
 *   - If bodyLeft can't be determined (all distinct), skip.
 */
function splitByParagraphIndent(paras: Paragraph[], indentThreshold: number): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length < 3) { result.push(para); continue; }

    // ── Skip paragraphs with drop-cap ───────────────────────────────
    // A drop-cap is a span with size ≥ 2.5× the median span size.
    // Such paragraphs are already handled by remergeAfterFontSplit (Step 8.5)
    // and their "indented" lines are drop-cap wrap (text flowing around
    // the large initial letter), NOT paragraph indents. Splitting here
    // would re-fragment the drop-cap region that we just merged.
    const spanSizes = para.spans
      .map(s => Number.isFinite(s.fontsize) ? s.fontsize! : 10)
      .filter(s => s > 0)
      .sort((a, b) => a - b);
    if (spanSizes.length > 0) {
      const medianSize = spanSizes[Math.floor(spanSizes.length / 2)];
      const maxSize = spanSizes[spanSizes.length - 1];
      if (maxSize >= medianSize * 2.5) {
        // Drop-cap detected — skip splitting
        result.push(para);
        continue;
      }
    }

    // Find bodyLeft (most common leftmost)
    const leftCounts: Record<string, number> = {};
    for (const line of lines) {
      const leftMost = line.map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
      const key = String(Math.round(leftMost));
      leftCounts[key] = (leftCounts[key] || 0) + 1;
    }
    const distinctMargins = Object.keys(leftCounts).map(Number);
    if (distinctMargins.length <= 1) { result.push(para); continue; }
    const bodyLeft = parseInt(
      Object.entries(leftCounts).sort((a, b) => b[1] - a[1])[0][0]
    );

    // Find split points
    const splitPoints: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const leftMost = lines[i].map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
      const isIndented = leftMost > bodyLeft + indentThreshold;
      if (!isIndented) continue;

      // Check next line
      let nextIsBody: boolean;
      if (i + 1 < lines.length) {
        const nextLeftMost = lines[i + 1].map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
        nextIsBody = Math.abs(nextLeftMost - bodyLeft) <= indentThreshold;
      } else {
        // Last line — treat as end of paragraph (next "is body" trivially)
        nextIsBody = true;
      }

      if (nextIsBody) {
        splitPoints.push(i);
      }
    }

    if (splitPoints.length === 0) {
      result.push(para);
      continue;
    }

    // Build subgroups
    const subGroups: InputRect[][][] = [];
    let startIdx = 0;
    for (const sp of splitPoints) {
      subGroups.push(lines.slice(startIdx, sp));
      startIdx = sp;
    }
    subGroups.push(lines.slice(startIdx));

    for (const sg of subGroups) {
      const sgSpans = sg.flatMap(l => l);
      if (sgSpans.length === 0) continue;
      result.push(makeParagraph(sgSpans, para.dominantFamily, para.dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

/**
 * STEP 8.62 (LAYOUT-FIX-11, 2026-09-17): Split standalone styled headings
 * from the body text below them.
 *
 * USER SPEC: «Если строчка полностью написана bold или другим стилем, и
 * визуально отделена от остального текста (находится над ним), то она не
 * должна полностью сливаться с ним (body/italic сливаются только ВНУТРИ
 * параграфа/строчки обычного текста)».
 *
 * Signal: the line's decoration-aware median size vs the unit's body size
 * (mode of line medians). Bold faces measure taller in BOTH feeds:
 *   • queue — pdf.js item.height (MinionPro-Semibold 9.8 vs Regular 9.04);
 *   • DOM — computed font-size of the stretched textLayer span (9.75 vs
 *     9.0; weight/name are invisible there: generic 'serif' + weight 400).
 * A run of ≥1 lines whose median ≥ body + HEADING_SIZE_DELTA, followed by
 * body-sized lines, is a heading block — split AFTER the run.
 *
 * Anti-regression gates (see the STEP 8.62 call-site comment for the full
 * list): body size is the MODE of the unit's line medians (inline bold
 * words do not move a line's median); a trailing styled line with nothing
 * below is never cut; a fully-styled unit (no body lines) is never cut.
 */
function splitByStandaloneHeading(paras: Paragraph[]): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length < 2) { result.push(para); continue; }

    // Decoration-aware median size per line (medianFontSize already
    // tolerates superscripts/decorations: they are a minority of spans).
    const lineMedians = lines.map(line => medianFontSize(line));

    // Body size = mode of line medians (the paragraph's regular text).
    const counts: Record<string, number> = {};
    for (const m of lineMedians) {
      const k = m.toFixed(2);
      counts[k] = (counts[k] || 0) + 1;
    }
    const bodyEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const bodySize = parseFloat(bodyEntries[0][0]);
    if (!Number.isFinite(bodySize)) { result.push(para); continue; }

    const isBig = (m: number) => m >= bodySize + HEADING_SIZE_DELTA;
    const isBody = (m: number) => m <= bodySize + HEADING_BODY_EPS;

    // Find split points: END of each run of big lines followed by body.
    const splitAfter: number[] = [];
    let i = 0;
    while (i < lines.length) {
      if (isBig(lineMedians[i])) {
        let j = i;
        while (j + 1 < lines.length && isBig(lineMedians[j + 1])) j++;
        const wholeUnit = i === 0 && j === lines.length - 1;
        if (!wholeUnit && j + 1 < lines.length && isBody(lineMedians[j + 1])) {
          splitAfter.push(j);
        }
        i = j + 1;
      } else {
        i++;
      }
    }

    if (splitAfter.length === 0) { result.push(para); continue; }

    // Build subgroups [0..s1], (s1..s2], ..., (sN..end].
    const subGroups: InputRect[][][] = [];
    let startIdx = 0;
    for (const sp of splitAfter) {
      subGroups.push(lines.slice(startIdx, sp + 1));
      startIdx = sp + 1;
    }
    subGroups.push(lines.slice(startIdx));

    for (const sg of subGroups) {
      const sgSpans = sg.flatMap(l => l);
      if (sgSpans.length === 0) continue;
      const { dominantFamily, dominantSize } = computeDominantFont(sgSpans);
      result.push(makeParagraph(sgSpans, dominantFamily, dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

function splitByIndent(paras: Paragraph[], indentThreshold: number): Paragraph[] {
  const result: Paragraph[] = [];

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length <= 1) { result.push(para); continue; }

    const leftCounts: Record<string, number> = {};
    for (const line of lines) {
      const leftMost = line.map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
      const key = String(Math.round(leftMost));
      leftCounts[key] = (leftCounts[key] || 0) + 1;
    }
    const bodyLeft = parseInt(Object.entries(leftCounts).sort((a, b) => b[1] - a[1])[0][0]);
    // P2-9 (Phase 17): removed `.filter(l => leftCounts[String(l)] >= 1)` —
    // tautology. `leftCounts` keys are only ever inserted with count >= 1
    // (the line above does `leftCounts[key] = (leftCounts[key] || 0) + 1`),
    // so every key already satisfies the filter predicate.
    const distinctMargins = Object.keys(leftCounts).map(Number);
    if (distinctMargins.length <= 1) { result.push(para); continue; }

    const subGroups: InputRect[][][] = [];
    let currGroup: InputRect[][] = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
      const leftMost = lines[i].map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
      const isIndented = leftMost > bodyLeft + indentThreshold;
      if (isIndented) {
        if (currGroup.length > 0) subGroups.push(currGroup);
        currGroup = [lines[i]];
      } else {
        currGroup.push(lines[i]);
      }
    }
    if (currGroup.length > 0) subGroups.push(currGroup);

    if (subGroups.length <= 1) { result.push(para); continue; }

    for (const sg of subGroups) {
      const sgSpans = sg.flatMap(l => l);
      if (sgSpans.length === 0) continue;
      result.push(makeParagraph(sgSpans, para.dominantFamily, para.dominantSize));
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

function makeParagraph(spans: InputRect[], dominantFamily: string, dominantSize: number): Paragraph {
  const pxLeft = spans.map(s => s.left).reduce((a, b) => Math.min(a, b), Infinity);
  const pxTop = spans.map(s => s.top).reduce((a, b) => Math.min(a, b), Infinity);
  const pxRight = spans.map(s => s.right).reduce((a, b) => Math.max(a, b), -Infinity);
  const pxBottom = spans.map(s => s.bottom).reduce((a, b) => Math.max(a, b), -Infinity);
  return {
    pxLeft, pxTop, pxRight, pxBottom,
    width: pxRight - pxLeft, height: pxBottom - pxTop,
    spans, dominantFamily, dominantSize,
  };
}

// ════════════════════════════════════════════════════════════════════
// STEP 8.65 (LAYOUT-FIX-6, 2026-09-16): TOC entry repair
// ════════════════════════════════════════════════════════════════════
//
// PROBLEM (user report «Оглавление совершенно порушилось»; reproduced on
// try.pdf p1 — the book's table of contents — and in the synthetic TOC
// repro): TOC entries are dense single lines that physically touch at
// cell granularity, so they chain into one giant unit per column. The
// page numbers are separate islands (dot-leader gap > one cell), so
// STEP 6 cannot attach them — instead STEP 8.7 absorbed them into the
// entry-chain block's bbox or STEP 8.8 banded them into a vertical
// "2/6/10…" unit. Result: an untranslatable blob per column.
//
// REPAIR (two passes, runs BEFORE 8.7/8.8 so they see proper units):
//   Pass 1 — attachCompanionPageNumbers: a tiny digits-only unit (≤2
//   spans, ≤48pt wide) sitting on the SAME text line as a host unit's
//   line, to the RIGHT of that line's ink, within a leader-gap
//   (≤ max(90pt, 30% page width)), size-compatible, host not
//   table-like → the number's spans join the host unit. (TABLE-KEEP:
//   table-like hosts are rejected — table-row digits are cells, not
//   TOC numbers.)
//   Pass 2 — splitTocEntries: a unit with ≥3 lines where ≥50% of the
//   lines END with a page-number pattern ("… 12", "…. 143") is a TOC
//   block → split AFTER every page-number-ending line. Wrapped entries
//   stay attached (their continuation lines do not end with digits).
//
// Kill-switch: ContourSettings.disableTocRepair.
// LAYOUT-FIX-7 (2026-09-17): `boundaries` are the column slicer's validated
// cut positions (px, ascending). Pass 1 refuses to attach a page number to
// a host line that does not lie in the SAME column range — see the
// SAME-COLUMN GATE below. Pass 2 (entry splitting) is geometry-local and
// needs no boundaries.
function fixTocEntries(paras: Paragraph[], pageW: number, boundaries?: number[]): Paragraph[] {
  if (paras.length < 2) return paras;

  const digitUnit = (p: Paragraph): boolean =>
    p.spans.length >= 1 &&
    p.spans.length <= TOC_NUM_MAX_SPANS &&
    (p.pxRight - p.pxLeft) <= TOC_NUM_MAX_W &&
    p.spans.every(s => /^\d{1,4}[.)]?$/.test(((s as any).text || '').trim()));

  // TABLE vs TOC discriminator (LAYOUT-FIX-6, calibrated on try.pdf p1):
  // a table ROW carries multiple cells per line — its spans form >=2 ink
  // clusters separated by gaps >= ~1.2 x glyph size. A TOC entry line is a
  // SINGLE text cluster (the page number is a separate island, not yet in
  // the host). Word-count table-likeness (isTableLikeRowTexts) CANNOT be
  // used here — real TOC entries are often short (<=6 words) too; the
  // reliable structural signal is the intra-line cluster count.
  const isMultiClusterLine = (line: InputRect[]): boolean => {
    if (line.length < 2) return false;
    const sorted = [...line].sort((a, b) => a.left - b.left);
    const glyph = medianFontSize(line);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].left - sorted[i - 1].right >= Math.max(8, glyph * 1.2)) return true;
    }
    return false;
  };

  // ── Pass 1: attach companion page numbers ────────────────────────
  const hosts = paras.filter(p => !digitUnit(p) && !p._merged);
  const maxGap = Math.max(TOC_NUM_GAP_MIN, pageW * 0.3);
  const attachedNums = new Set<Paragraph>();
  const attachedSpans = new Set<InputRect>();
  const digitUnitsList = paras.filter(p => digitUnit(p) && !p._merged);

  for (const num of paras) {
    if (num._merged || !digitUnit(num) || attachedNums.has(num)) continue;
    // INK coordinates, not grid-quantized px boxes (pxLeft can be up to
    // one cell SMALLER than the real ink — a 9pt leader gap shrinks to
    // 6pt in px space and trips TOC_NUM_ATTACH_MIN_GAP).
    const numInkLeft = Math.min(...num.spans.map(s => s.left));
    const numInkRight = Math.max(...num.spans.map(s => s.right));
    const numMidY = (num.pxTop + num.pxBottom) / 2;
    const numSize = medianFontSize(num.spans);

    // TABLE-ROW GUARD: a digits-only neighbour on the same row within
    // TOC_NUM_ROW_MATE_GAP pt means a table digit column, not a TOC page
    // number (see the constant's docblock for the calibration).
    const hasRowMate = digitUnitsList.some(d2 => {
      if (d2 === num || d2._merged || attachedNums.has(d2)) return false;
      const mid2 = (d2.pxTop + d2.pxBottom) / 2;
      if (Math.abs(mid2 - numMidY) > 3.5) return false;
      const d2InkLeft = Math.min(...d2.spans.map(s => s.left));
      const d2InkRight = Math.max(...d2.spans.map(s => s.right));
      const gap = Math.max(d2InkLeft - numInkRight, numInkLeft - d2InkRight);
      return gap >= -2 && gap <= TOC_NUM_ROW_MATE_GAP;
    });
    if (hasRowMate) continue;

    // Best host: a unit with a line vertically aligned with the number
    // whose ink ends LEFT of the number; pick the CLOSEST ink end (the
    // entry text on that line, not a neighbouring column's line).
    let bestHost: Paragraph | null = null;
    let bestHostRight = -Infinity;
    let bestHostB: number | undefined; // LAYOUT-FIX-7: boundary of the winning line's column
    for (const host of hosts) {
      if (host._merged || attachedNums.has(host)) continue;
      if (Math.abs(medianFontSize(host.spans) - numSize) > TOC_NUM_SIZE_TOL) continue;
      // LAYOUT-FIX-8 (A3-lite) NOTE: a construction-based columnId gate
      // (num.columnId !== host.columnId → skip) was implemented and then
      // REMOVED after empirical rejection on try.pdf p1 (queue): the
      // slicer's drift repair builds right-column drift units (drop-cap
      // "f"/"m" at x=420) in the LEFT group, so their columnId contradicts
      // their ink — the gate blocked the v21 attach of TOC number "21" to
      // its (visually correct) host and broke 3 attaches (u51→u54).
      // Construction-group identity is NOT a same-column oracle in the
      // presence of drift repair; F1's ink/boundary gate (above) already
      // makes the M2-class attach impossible. The columnId FIELD stays
      // assigned (pipeline above) for A3's phase-4 group invariant.
      if (numInkLeft < host.pxLeft - 2) continue;    // number must sit in the host's column
      for (const line of groupIntoLines(host.spans)) {
        const lineMidY = (Math.min(...line.map(s => s.top)) + Math.max(...line.map(s => s.bottom))) / 2;
        if (Math.abs(lineMidY - numMidY) > 3.5) continue;
        if (isMultiClusterLine(line)) continue;         // table row — cells, not a TOC entry
        const lineRight = Math.max(...line.map(s => s.right));
        // LAYOUT-FIX-7 (SAME-COLUMN GATE): the number and the host line
        // must lie in ONE column range [b_{k-1}, b_k), where b is the
        // first boundary right of the line's ink start. A number at/after
        // b lives in a DIFFERENT column (classif.pdf p4: citation "2" at
        // 340 vs boundary 311.6 — it must stay with its own right-column
        // line, not glue to the left body); a line whose own ink reaches
        // b is a wide/footer element, not a TOC entry. On real TOC pages
        // entries and their numbers share a column — the gate is inert
        // there (try.pdf p1: 51 units before and after).
        let gateB: number | undefined;
        if (boundaries && boundaries.length > 0) {
          const lineLeft = Math.min(...line.map(s => s.left));
          gateB = boundaries.find(bd => bd > lineLeft);
          if (gateB !== undefined) {
            if (numInkLeft >= gateB) continue;   // number in another column
            if (lineRight >= gateB) continue;    // host line crosses the boundary (wide/footer)
          }
        }
        if (lineRight > numInkLeft - 1) continue;       // ink must end before the number
        if (numInkLeft - lineRight < TOC_NUM_ATTACH_MIN_GAP) continue;  // table cell padding, not a leader gap
        if (numInkLeft - lineRight > maxGap) continue;  // leader gap cap
        if (lineRight > bestHostRight) { bestHostRight = lineRight; bestHost = host; bestHostB = gateB; }
      }
    }
    if (bestHost) {
      const hostRightBefore = bestHost.pxRight;
      bestHost.spans.push(...num.spans);
      bestHost.pxRight = Math.max(bestHost.pxRight, num.pxRight);
      // LAYOUT-FIX-7: never let the attach EXPAND the host's declared box
      // past its own column boundary. Grid quantization of the attached
      // number's box (+cellSize) pushed pxRight past boundary + WIDE_MARGIN
      // and flipped the merged unit WIDE in STEP 9 — the mid-page paragraph
      // then landed in the header bucket as reading position #2 (M3).
      // Only the EXPANSION is capped: a host that was already
      // (phantom-)wide before the merge keeps its pre-merge box — declared
      // width overstatement is P3's (LAYOUT-FIX-9) territory, not this fix.
      if (bestHostB !== undefined && bestHost.pxRight > bestHostB && hostRightBefore <= bestHostB) {
        bestHost.pxRight = bestHostB;
      }
      bestHost.pxBottom = Math.max(bestHost.pxBottom, num.pxBottom);
      bestHost.pxTop = Math.min(bestHost.pxTop, num.pxTop);
      bestHost.width = bestHost.pxRight - bestHost.pxLeft;
      bestHost.height = bestHost.pxBottom - bestHost.pxTop;
      const recomputed = computeDominantFont(bestHost.spans);
      bestHost.dominantFamily = recomputed.dominantFamily;
      bestHost.dominantSize = recomputed.dominantSize;
      num._merged = true;
      attachedNums.add(num);
      for (const s of num.spans) attachedSpans.add(s);
    }
  }

  let alive = paras.filter(p => !p._merged);

  // ── Pass 2: split TOC-like units after page-number-ending lines ──
  // A line "ends with a page number" ONLY when its trailing digits are a
  // SEPARATE companion span — either attached in Pass 1, or a native
  // digits-only span separated from the line's text ink by a real gap
  // (>= TOC_NUM_NATIVE_GAP pt). Contiguous trailing digits (references
  // "…53(1):1-12.", statistical table rows "… –0.813 .416") are inline
  // text and NEVER split — this is what keeps the LAYOUT-FIX-3/4
  // references-block and TABLE-KEEP contracts intact.
  const result: Paragraph[] = [];
  for (const p of alive) {
    const lines = groupIntoLines(p.spans);
    if (lines.length < TOC_MIN_LINES) { result.push(p); continue; }

    const lineHasCompanionNumber = (line: InputRect[]): boolean => {
      if (line.length === 0) return false;
      const sorted = [...line].sort((a, b) => a.left - b.left);
      const last = sorted[sorted.length - 1];
      const lastText = ((last as any).text || '').trim();
      if (!/^\d{1,4}[.)]?$/.test(lastText)) return false;
      if (attachedSpans.has(last)) return true;          // attached in Pass 1
      return lineEndsWithCompanionNumber(line);
    };

    const digitEnds = lines.filter(line => lineHasCompanionNumber(line)).length;
    if (digitEnds < Math.max(TOC_MIN_LINES, Math.ceil(lines.length * TOC_MIN_FRAC))) {
      result.push(p);
      continue;
    }

    // Split after every companion-number-ending line.
    let current: InputRect[] = [];
    let didSplit = false;
    for (let i = 0; i < lines.length; i++) {
      current.push(...(lines[i] as InputRect[]));
      const endsWithNum = lineHasCompanionNumber(lines[i]);
      if (endsWithNum && i < lines.length - 1) {
        if (current.length > 0) {
          const { dominantFamily, dominantSize } = computeDominantFont(current);
          result.push(makeParagraph(current, dominantFamily, dominantSize));
        }
        current = [];
        didSplit = true;
      }
    }
    if (current.length > 0) {
      if (didSplit) {
        const { dominantFamily, dominantSize } = computeDominantFont(current);
        result.push(makeParagraph(current, dominantFamily, dominantSize));
      } else {
        result.push(p); // nothing split — keep the ORIGINAL object (stable identity)
      }
    }
  }

  result.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return result;
}

// ════════════════════════════════════════════════════════════════════
// STEP 8.7 (LAYOUT-FIX-3, 2026-09-16): Absorb contained fragments
// ════════════════════════════════════════════════════════════════════
//
// Runs per column group at the very end of buildParagraphsInRegion,
// AFTER every split step. See the LAYOUT-FIX-3 block comment above for
// the full rationale and the safety analysis.
function absorbContainedFragments(paras: Paragraph[], cellSize = 4): Paragraph[] {
  if (paras.length < 2) return paras;

  // LAYOUT-FIX-4 (2026-09-16): DUAL containment test. Paragraph px boxes
  // have INCONSISTENT provenance: raw islands carry GRID-QUANTIZED coords
  // (pxTop = cell × cellSize — up to 4px of inflation), while paragraphs
  // that passed a split step carry exact span coords — and a font-split
  // sub-paragraph can also keep the PRE-SPLIT island box (stale, wider
  // than its ink). The legacy single px test therefore failed in BOTH
  // directions on real pages:
  //   • under-measured (reject) — try.pdf p5 DOM: the first references
  //     line "Lander, E.S. (2013) Lessons" (ink y[822.45..831.91]) tested
  //     79.6% inside the block whose exact bbox starts at 822.5 — a
  //     phantom 2.45px stick-out that was pure quantization noise;
  //   • over-measured (accept) — Alimentary p1: "vetsmall.theclinics.com"
  //     sits RIGHT of the footer block's ink (0.3pt x-overlap) but inside
  //     its stale pre-font-split island box — an absorption that is
  //     CORRECT (same visual row of the journal footer) and must survive.
  // Rule: accept when EITHER the EXACT ink bounds OR the px boxes give
  // ≥ FRAGMENT_CONTAIN_FRAC. The px path alone reproduces the LAYOUT-FIX-3
  // corpus-validated accept set; the exact path only ADDS fragments whose
  // ink is truly inside the container's ink — a strictly stronger
  // geometric statement — so the union cannot over-absorb beyond what the
  // remaining guards (min-lines, area, size, TABLE-KEEP) already police.
  const boundsOf = (p: Paragraph) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const s of p.spans as any[]) {
      if (s.left < l) l = s.left;
      if (s.top < t) t = s.top;
      if (s.right > r) r = s.right;
      if (s.bottom > b) b = s.bottom;
    }
    if (!Number.isFinite(l)) { l = p.pxLeft; t = p.pxTop; r = p.pxRight; b = p.pxBottom; }
    return { l, t, r, b };
  };
  const overlapFrac = (
    fl: number, ft: number, fr: number, fb: number,
    cl: number, ct: number, cr: number, cb: number,
  ): number => {
    const fa = Math.max(1, (fr - fl) * (fb - ft));
    const ix = Math.max(0, Math.min(fr, cr) - Math.max(fl, cl));
    const iy = Math.max(0, Math.min(fb, cb) - Math.max(ft, ct));
    return (ix * iy) / fa;
  };
  // Area/ratio semantics stay on px boxes (LAYOUT-FIX-3 calibration).
  const areaOf = (p: Paragraph) =>
    Math.max(1, (p.pxRight - p.pxLeft) * (p.pxBottom - p.pxTop));

  // Per-pass caches (invalidated for a container when it grows).
  const linesCache = new Map<Paragraph, InputRect[][]>();
  const sizeCache = new Map<Paragraph, number>();
  const linesOf = (p: Paragraph): InputRect[][] => {
    let l = linesCache.get(p);
    if (!l) { l = groupIntoLines(p.spans); linesCache.set(p, l); }
    return l;
  };
  const medianSizeOf = (p: Paragraph): number => {
    let s = sizeCache.get(p);
    if (s === undefined) {
      const sizes = p.spans
        .map((sp: any) => (Number.isFinite(sp.fontsize) ? sp.fontsize : 10))
        .sort((a: number, b: number) => a - b);
      s = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 10;
      sizeCache.set(p, s);
    }
    return s;
  };

  // TABLE-KEEP compatibility: a container whose every line is a short
  // item (isTableLikeRowTexts) renders row-per-line via <br>. Absorbing a
  // fragment with a LONG line into such a container flips the whole unit
  // to prose join and destroys the table structure (observed on
  // "Classification of Canine Mast Cell Neoplasms" p4: the cross-column
  // row "<3 multinucleated cells/10 HPF ≥3 multinucleated cells/10 HPF"
  // absorbed into the TABLE 2 block). Rule: table-like containers reject
  // fragments carrying long lines; short-line rows (table cells, e.g.
  // "<3 bizarre nuclei/10 HPF" — 5 words) absorb freely and keep the
  // container table-like.
  const tableLikeCache = new Map<Paragraph, boolean>();
  const isTableLike = (p: Paragraph): boolean => {
    let t = tableLikeCache.get(p);
    if (t === undefined) {
      const rows = groupIntoLines(p.spans).map(line =>
        line.map((s: any) => s.text || '').join('').trim());
      t = rows.length >= 2 && isTableLikeRowTexts(rows);
      tableLikeCache.set(p, t);
    }
    return t;
  };
  const hasLongLine = (p: Paragraph): boolean =>
    groupIntoLines(p.spans).some(line =>
      line.map((s: any) => s.text || '').join('').trim()
        .split(/\s+/).filter(Boolean).length > TABLE_KEEP_MAX_WORDS_PER_ROW);

  // ── LAYOUT-FIX-6 gates: family compatibility + physical adjacency ─
  // The user's core invariant «НЕ СЛИВАТЬ НЕСОПРИКАСАЮЩИЕСЯ ISLANDS» was
  // violated by pure-bbox absorption: figure labels inside a grown
  // body-block bbox and TOC page numbers inside the entry-chain bbox
  // were absorbed WITHOUT their ink cells touching the container. Two
  // guards:
  //   • base-family compatibility (style-tolerant) — a Frutiger label
  //     never absorbs into a MinionPro container. OPAQUE font ids
  //     (pdfjs "g_d0_fN" and CSS-generic "serif"/"sans-serif"/
  //     "monospace"/"unknown") are treated as always-compatible: they
  //     encode NO reliable family info, and the pre-FIX-6 absorptions
  //     (reference tails across italic/roman variants, try.pdf p5) must
  //     keep working on the raw-fontName path;
  //   • ink adjacency — the fragment must touch the container's ink cells
  //     (8-neighbour) or sit within ~2 line pitches of them (a reference
  //     tail can be separated from its container by one blank-ish line:
  //     try.pdf p5 "Lessons from the cancer genome…", 11pt gap). Gaps of
  //     image/figure scale (≥ 30pt) remain rejected — labels inside a
  //     figure never bridge to the body text.
  const OPAQUE_FONT_RE = /^(g_d\d+_f\d+|unknown)$/i;
  /** Pre-14 opaque set (the CSS generics were members — LAYOUT-FIX-14
   * moved them to the strict GENERIC_FAMILY_RE comparison). */
  const OPAQUE_FONT_RE_PRE14 = /^(g_d\d+_f\d+|unknown|serif|sans-serif|monospace)$/i;
  const familyCache = new Map<Paragraph, string>();
  const fullOf = (p: Paragraph): string => {
    let f = familyCache.get(p);
    if (f === undefined) { f = primaryFullFontName(p); familyCache.set(p, f); }
    return f;
  };
  const baseFamilyOf = (p: Paragraph): string => getFontFamily(fullOf(p), false);
  // LAYOUT-FIX-14: CSS-generic families carry REAL class information on
  // the DOM path — serif vs sans-serif must NOT absorb into each other
  // (user rule б: «разные семейства не сливаются»). Pre-14 the whole
  // OPAQUE set (incl. the generics) was always-compatible, so a sans
  // figure label absorbed into a serif caption/body container whenever
  // the geometry allowed. g_d0_fN ids and 'unknown' stay always-compatible
  // (they encode nothing comparable). The kill-switch restores the exact
  // pre-14 semantics (generics opaque, concrete = base-family equality).
  const familyCompat = (a: Paragraph, b: Paragraph): boolean => {
    const fa = fullOf(a), fb = fullOf(b);
    if (_disableFontClassSplit) {
      return OPAQUE_FONT_RE_PRE14.test(fa) || OPAQUE_FONT_RE_PRE14.test(fb) ||
        baseFamilyOf(a) === baseFamilyOf(b);
    }
    if (OPAQUE_FONT_RE.test(fa) && OPAQUE_FONT_RE.test(fb)) return true;
    const aGen = GENERIC_FAMILY_RE.test(fa), bGen = GENERIC_FAMILY_RE.test(fb);
    if (aGen && bGen) return fa.toLowerCase() === fb.toLowerCase();
    if (aGen || bGen) return true; // generic vs concrete — no comparable info
    return baseFamilyOf(a) === baseFamilyOf(b);
  };
  const cellsOf = (p: Paragraph): Set<number> => {
    const cells = new Set<number>();
    for (const s of p.spans) {
      const x0 = Math.max(0, Math.floor(s.left / cellSize));
      const x1 = Math.max(0, Math.floor((s.right - 0.01) / cellSize));
      const y0 = Math.max(0, Math.floor(s.top / cellSize));
      const y1 = Math.max(0, Math.floor((s.bottom - 0.01) / cellSize));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) cells.add(y * 100000 + x);
    }
    return cells;
  };
  const cellsCache = new Map<Paragraph, Set<number>>();
  const cellsCached = (p: Paragraph): Set<number> => {
    let c = cellsCache.get(p);
    if (!c) { c = cellsOf(p); cellsCache.set(p, c); }
    return c;
  };
  const inksAdjacent = (frag: Paragraph, cont: Paragraph): boolean => {
    const cf = cellsCached(frag);
    const cc = cellsCached(cont);
    if (cf.size === 0 || cc.size === 0) return false;
    // Near-touch radius in cells: ~2 line pitches of the fragment's size
    // (ceil keeps it ≥ 3 cells ≈ 12pt at cellSize 4).
    const fragSize = Math.max(6, medianFontSize(frag.spans));
    const radius = Math.max(3, Math.ceil((fragSize * 2.0) / cellSize));
    for (const cell of cf) {
      const y = Math.floor(cell / 100000);
      const x = cell % 100000;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (cc.has((y + dy) * 100000 + (x + dx))) return true;
        }
      }
    }
    return false;
  };

  let changed = true;
  let pass = 0;
  while (changed && pass < FRAGMENT_MAX_PASSES) {
    changed = false;
    pass++;
    const alive = paras.filter(p => !p._merged);

    // Fragment candidates, deterministic reading order.
    const frags = alive
      .filter(p => {
        const L = linesOf(p);
        return L.length > 0 && L.length <= FRAGMENT_MAX_LINES && p.spans.length <= FRAGMENT_MAX_SPANS;
      })
      .sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

    for (const f of frags) {
      if (f._merged) continue;
      const fArea = areaOf(f);
      const fBounds = boundsOf(f);

      // Smallest qualifying container = most specific parent.
      let best: Paragraph | null = null;
      let bestArea = Infinity;
      const fragHasLongLine = hasLongLine(f);
      for (const c of alive) {
        if (c === f || c._merged) continue;
        if (linesOf(c).length < FRAGMENT_CONTAINER_MIN_LINES) continue;
        if (areaOf(c) < fArea * FRAGMENT_AREA_RATIO) continue;
        // LAYOUT-FIX-4 dual test: px-box containment (legacy) OR exact
        // ink-bounds containment (fixes grid-quantization rejections).
        const pxFrac = overlapFrac(f.pxLeft, f.pxTop, f.pxRight, f.pxBottom, c.pxLeft, c.pxTop, c.pxRight, c.pxBottom);
        const cBounds = boundsOf(c);
        const inkFrac = overlapFrac(fBounds.l, fBounds.t, fBounds.r, fBounds.b, cBounds.l, cBounds.t, cBounds.r, cBounds.b);
        if (Math.max(pxFrac, inkFrac) < FRAGMENT_CONTAIN_FRAC) continue;
        // Size guard. Pre-14: drop-cap-scale fragments only (a fragment
        // whose median size exceeds 2.2× the container's is NOT inline
        // material). LAYOUT-FIX-14: a fragment also absorbs ONLY within
        // the container's SIZE CLASS (|Δ| ≤ SIZE_CLASS_TOL — an 8.02pt
        // 2-line caption fragment no longer absorbs into a 9.03pt body
        // container), with two exceptions mirroring the user rule:
        //   • caption-label fragments («Fig, Figure, Table» exception) —
        //     a label line absorbs into the caption text it belongs to;
        //   • tiny decoration fragments (≤2 spans, ≤24pt wide, smaller
        //     than the container) — stray superscript footnote refs
        //     («…tumors. 5,6») that are INLINE decorations, not blocks.
        //   • drop-cap-scale (≥2.5×) fragments stay eligible for the
        //     8.5 drop-cap re-merge path.
        const fs = medianSizeOf(f), cs = medianSizeOf(c);
        const tinyDecoration =
          f.spans.length <= 2 &&
          Math.max(...f.spans.map(s => s.right - s.left)) <= 24 &&
          fs < cs;
        const dropCapScale =
          Math.max(fs, cs) / Math.max(1, Math.min(fs, cs)) >= 2.5;
        const sizeOk = _disableFontClassSplit
          ? fs <= FRAGMENT_SIZE_MAX_RATIO * Math.max(1, cs)
          : (Math.abs(fs - cs) <= SIZE_CLASS_TOL ||
             dropCapScale || tinyDecoration ||
             isCaptionLabelParagraph(f));
        if (!sizeOk) continue;
        // TABLE-KEEP guard: a table-like container rejects fragments with
        // long lines — see the comment above isTableLike.
        if (isTableLike(c) && fragHasLongLine) continue;
        // LAYOUT-FIX-6: family compatibility + ink adjacency.
        if (!familyCompat(f, c)) continue;
        if (!inksAdjacent(f, c)) continue;
        // LAYOUT-FIX-10 (A3) — REJECTED EMPIRICALLY (Task 36): an explicit
        // column invariant here ("reject a fragment/container pair
        // separated by a validated boundary: f.inkL >= b && c.inkR < b, or
        // mirrored") was implemented and measured on the corpus. It
        // FAILED on try3:p3 (u20→u22, a NEW cross-column unit [72..575]):
        // the Tm-clamp caps D1-row left tails AT the right column's first
        // start (left ink 333 > boundary 324 — see column-slicer STEP 6),
        // so LEFT containers' ink bounds legitimately cross the boundary
        // and the separation test goes blind exactly where it is needed;
        // meanwhile blocking right→right chain absorptions reshuffles the
        // smallest-qualifying-container landscape so right fragments fall
        // into LEFT containers — the gate CREATES the merges it exists to
        // prevent. Same lesson as the A3-lite columnId gate (Task 34):
        // constructive/derived column identity cannot gate 8.7 merges.
        // The cross-column merge protection stays where it is provably
        // honest: the slicer's PARTITION (validated gutters hold no item
        // starts), the F1 boundary gate in 8.65, and STEP 9.5 (≥20pt).
        if (areaOf(c) < bestArea) { best = c; bestArea = areaOf(c); }
      }
      if (!best) continue;

      // Absorb. Spans keep their coordinates; reading order is restored
      // by groupIntoLines (top, left) at text-assembly time. The bbox
      // grows to the union (harmless: the fragment was ≥80% inside).
      best.spans.push(...f.spans);
      best.pxLeft = Math.min(best.pxLeft, f.pxLeft);
      best.pxTop = Math.min(best.pxTop, f.pxTop);
      best.pxRight = Math.max(best.pxRight, f.pxRight);
      best.pxBottom = Math.max(best.pxBottom, f.pxBottom);
      best.width = best.pxRight - best.pxLeft;
      best.height = best.pxBottom - best.pxTop;
      const recomputed = computeDominantFont(best.spans);
      best.dominantFamily = recomputed.dominantFamily;
      best.dominantSize = recomputed.dominantSize;
      // The grown container's cached line/size data is stale.
      linesCache.delete(best);
      sizeCache.delete(best);
      tableLikeCache.delete(best);
      // LAYOUT-FIX-6: the grown container's ink cells changed too.
      cellsCache.delete(best);
      f._merged = true;
      changed = true;
    }
  }

  const out = paras.filter(p => !p._merged);
  out.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return out;
}

// ════════════════════════════════════════════════════════════════════
// STEP 8.8 (LAYOUT-FIX-3, 2026-09-16): Merge sparse figure-label bands
// ════════════════════════════════════════════════════════════════════
//
// Runs globally in buildParagraphs (a figure can span the full page
// width — its labels live in several column groups). See the
// LAYOUT-FIX-3 block comment above for the full rationale.
function mergeFigureLabelBands(
  paras: Paragraph[],
  pageW: number,
  pageH: number,
  boundaries?: number[],
): Paragraph[] {
  if (paras.length < BAND_MIN_BLOCKS) return paras;

  const smallMaxW = Math.max(80, pageW * BAND_SMALL_MAX_W_FRAC);
  const bandMaxGap = Math.max(80, pageH * BAND_MAX_GAP_PAGE_FRAC);

  const isSmall = (p: Paragraph): boolean => {
    const L = groupIntoLines(p.spans);
    return L.length > 0 && L.length <= BAND_SMALL_MAX_LINES
      && p.spans.length <= BAND_SMALL_MAX_SPANS
      && (p.pxRight - p.pxLeft) <= smallMaxW
      && (p.pxBottom - p.pxTop) <= BAND_SMALL_MAX_H
      // LAYOUT-FIX-6: TOC entries are NOT band material. After STEP 8.65
      // attached a page number, a short entry ("Genetic injury 6") is
      // small by every geometric metric — banding chained entries into
      // pseudo-"figure label" units. A line ending with a companion
      // page number marks an entry; figure labels never carry one.
      && !L.some(line => lineEndsWithCompanionNumber(line));
  };

  // Column region (mirrors applyColumnOrder's boundary-path math) for
  // the wide-cluster safety check. Computed only when boundaries exist.
  let haveRegion = false;
  let colRegionTop = 0;
  let colRegionBottom = 0;
  if (boundaries && boundaries.length > 0) {
    const eligible = paras.filter(p =>
      (p.pxBottom - p.pxTop) >= 30 && (p.pxRight - p.pxLeft) >= 50);
    const isWideB = (p: Paragraph) => {
      // LAYOUT-FIX-7: ink-based wide test — mirrors applyColumnOrder's
      // boundary-path rule so this region derivation and the final
      // classification agree on what "wide" means (px boxes carry grid
      // quantization + pdfjs width overstatement).
      const l = p.spans.length ? Math.min(...p.spans.map(s => s.left)) : p.pxLeft;
      const r = p.spans.length ? Math.max(...p.spans.map(s => s.right)) : p.pxRight;
      return boundaries.some(b => l < b - WIDE_MARGIN && r > b + WIDE_MARGIN);
    };
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (let ci = 0; ci <= boundaries.length; ci++) {
      const lo = ci === 0 ? -Infinity : boundaries[ci - 1] - 8;
      const hi = ci === boundaries.length ? Infinity : boundaries[ci] - 1 - (ci > 0 ? 8 : 0);
      const nonWide = eligible.filter(p => !isWideB(p) && p.pxLeft >= lo && p.pxLeft <= hi);
      if (nonWide.length > 0) {
        tops.push(Math.min(...nonWide.map(p => p.pxTop)));
        bottoms.push(Math.max(...nonWide.map(p => p.pxBottom)));
      }
    }
    if (tops.length > 0) {
      haveRegion = true;
      colRegionTop = Math.min(...tops) - 5;
      colRegionBottom = Math.max(...bottoms) + 5;
    }
  }

  // Walk paragraphs in reading order; chain small blocks into clusters.
  // Chaining uses the CHEBYSHEV distance to the current cluster bbox
  // (max of the x-gap and y-gap; either is 0 when the ranges overlap):
  // figure-label scatter is an 8-neighbour-ish cloud, while a purely
  // vertical gap rule would chain unrelated blocks stacked above each
  // other (try.pdf p4: the running header "4 Tumors in Domestic Animals"
  // and a figure corner label 144pt to the right share a 16pt vertical
  // gap — same as a real label row — but 144pt of horizontal emptiness
  // between them).
  // A large block closes the current cluster only when it x-overlaps the
  // cluster (a neighbouring column's body text must not break this
  // column's band; measured overlap of the pdfjs-drifted left column
  // into a right-column band is ≤ ~15px on a ~250px band).
  const sorted = [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  const clusters: Paragraph[][] = [];
  let cur: Paragraph[] = [];
  let curL = Infinity, curT = Infinity, curR = -Infinity, curB = -Infinity;
  const closeCluster = () => {
    if (cur.length > 0) clusters.push(cur);
    cur = [];
    curL = Infinity; curT = Infinity; curR = -Infinity; curB = -Infinity;
  };
  for (const p of sorted) {
    if (isSmall(p)) {
      // LAYOUT-FIX-6 note: a member font-compatibility gate was evaluated
      // here and DROPPED — the corpus-validated figure-label bands mix
      // font variants and even families (try.pdf p3/p4: FrutigerLTStd
      // Bold/Light labels + stray MinionPro connector words inside the
      // figure; raw-g_d0_fN ids on the DOM replica path where every
      // variant is a distinct "family"). TOC page-number bands are
      // prevented structurally instead: STEP 8.65 attaches the numbers to
      // their entries BEFORE this step, so they never reach the band pool.
      const xGap = cur.length === 0
        ? Infinity
        : Math.max(0, Math.max(curL, p.pxLeft) - Math.min(curR, p.pxRight));
      const yGap = cur.length === 0 ? 0 : Math.max(0, p.pxTop - curB);
      if (cur.length === 0 || Math.max(xGap, yGap) <= bandMaxGap) {
        cur.push(p);
        curL = Math.min(curL, p.pxLeft);
        curT = Math.min(curT, p.pxTop);
        curR = Math.max(curR, p.pxRight);
        curB = Math.max(curB, p.pxBottom);
      } else {
        closeCluster();
        cur.push(p);
        curL = p.pxLeft; curT = p.pxTop; curR = p.pxRight; curB = p.pxBottom;
      }
    } else if (cur.length > 0) {
      const ov = Math.max(0, Math.min(curR, p.pxRight) - Math.max(curL, p.pxLeft));
      if (ov > BAND_BREAK_OVERLAP_FRAC * (curR - curL)) closeCluster();
    }
  }
  closeCluster();

  const mergedAway = new Set<Paragraph>();
  const units: Paragraph[] = [];
  // Paragraphs eligible as fragment containers (for the leftover-fragment
  // skip below). A cluster member that is ≥80% inside one of these is a
  // reference-list tail / citation fragment, NOT a figure label — STEP 8.7
  // should have absorbed it; if it ever fails to (rule drift), STEP 8.8
  // must not sweep the leftovers into a pseudo "figure band" (observed
  // pre-calibration on try.pdf p5: five reference tails banding together
  // at 23% density at the bottom of the references block).
  const containers = paras.filter(p =>
    groupIntoLines(p.spans).length >= FRAGMENT_CONTAINER_MIN_LINES && !isSmall(p));
  const containedInContainer = (p: Paragraph, exclude: Set<Paragraph>): boolean => {
    const a = Math.max(1, (p.pxRight - p.pxLeft) * (p.pxBottom - p.pxTop));
    for (const c of containers) {
      if (exclude.has(c)) continue;
      if ((c.pxRight - c.pxLeft) * (c.pxBottom - c.pxTop) < a * FRAGMENT_AREA_RATIO) continue;
      const ix = Math.max(0, Math.min(p.pxRight, c.pxRight) - Math.max(p.pxLeft, c.pxLeft));
      const iy = Math.max(0, Math.min(p.pxBottom, c.pxBottom) - Math.max(p.pxTop, c.pxTop));
      if (ix * iy >= a * FRAGMENT_CONTAIN_FRAC) return true;
    }
    return false;
  };
  for (const cl of clusters) {
    if (cl.length < BAND_MIN_BLOCKS) continue;
    const clSet = new Set(cl);
    if (cl.some(p => containedInContainer(p, clSet))) continue;
    const l = cl.reduce((m, p) => Math.min(m, p.pxLeft), Infinity);
    const t = cl.reduce((m, p) => Math.min(m, p.pxTop), Infinity);
    const r = cl.reduce((m, p) => Math.max(m, p.pxRight), -Infinity);
    const b = cl.reduce((m, p) => Math.max(m, p.pxBottom), -Infinity);
    const ink = cl.reduce((s, p) => s + Math.max(1, (p.pxRight - p.pxLeft) * (p.pxBottom - p.pxTop)), 0);
    const bandArea = Math.max(1, (r - l) * (b - t));
    // Dense grid → table cells / tight multi-column lists: keep structure.
    if (ink / bandArea > BAND_DENSITY_MAX) continue;

    // Wide-cluster safety (see LAYOUT-FIX-3 block comment): the merged
    // unit would be classified by applyColumnOrder; replicate its WIDE
    // rule. Crossing clusters are merged only fully OUTSIDE the column
    // region (header/footer buckets keep reading order there).
    // LAYOUT-FIX-7: ink-based, mirroring applyColumnOrder's rule (px
    // boxes of banded small blocks carry grid quantization noise).
    if (boundaries && boundaries.length > 0) {
      const inkL = Math.min(...cl.flatMap(p => p.spans).map(s => s.left));
      const inkR = Math.max(...cl.flatMap(p => p.spans).map(s => s.right));
      const crosses = boundaries.some(bd => inkL < bd - WIDE_MARGIN && inkR > bd + WIDE_MARGIN);
      if (crosses) {
        if (!haveRegion) continue;                              // no region info — stay conservative
        if (!(b < colRegionTop || t > colRegionBottom)) continue; // inside region — leave as-is
      }
    }

    const spans = cl
      .flatMap(p => p.spans)
      .sort((a, b2) => a.top - b2.top || a.left - b2.left);
    const { dominantFamily, dominantSize } = computeDominantFont(spans);
    units.push(makeParagraph(spans, dominantFamily, dominantSize));
    for (const p of cl) mergedAway.add(p);
  }
  if (units.length === 0) return paras;

  const out = [...paras.filter(p => !mergedAway.has(p)), ...units];
  out.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return out;
}

// ════════════════════════════════════════════════════════════════════
// STEP 9.5 (LAYOUT-FIX-8, 2026-09-17): Non-adjacency post-validator
// ════════════════════════════════════════════════════════════════════
//
// PROBLEM (user report «сливаются несвязанные куски», bisect
// download/v11-vs-current-layout-bisect.md §3.1/M1): STEP 8.7 absorb and
// STEP 8.8 bands merge by DECLARED boxes with no max-gap invariant, so
// units accrete material that does not physically touch: figure labels
// banded across a diagram (try3.pdf p2: 5 labels, 65pt apart), table
// header cells (classif.pdf p4: 141pt), list bullets (aliment p1: 257pt),
// abbreviation chains (try.pdf p4: 110pt, 13 components). v11 kept these
// as separate units — the user confirmed that as the correct behavior
// («на картинках всё было правильно», bisect line 19). The component
// analysis itself (union-find over span rects with +6pt connectivity,
// inter-component gap ≥ 20pt) found EVERY real unrelated-merge on the
// 12-page corpus with zero false positives and costs < 2ms/page.
//
// RULE (an explicit invariant instead of scattered side effects of 8.x):
// a paragraph whose spans form ≥2 connectivity components with a gap
// ≥ NONADJ_SPLIT_GAP between consecutive component boxes is cut back into
// per-component paragraphs (makeParagraph per component — the same
// construction Pass 2 of fixTocEntries uses). The 12–20pt zone is suspect
// (kept unsplit — no debug channel in production since Phase 4 C1).
//
// SAFETY ANALYSIS (calibrated on the corpus + suites):
//   • Real tables are SINGLE components — rows stack at a line pitch
//     (< 12pt) and bridge every inter-cell gap (urt.pdf p7 queue: the
//     34-row TABLE-KEEP table = 1 component, maxGap 0.0). The table-like
//     word-count exception from the optimization plan was DROPPED: every
//     na-unit on the corpus is also "table-like" by word count (figure
//     labels are short words), so that exception would have protected the
//     very merges this step exists to cut.
//   • Intentional splits (Steps 7/7.5/8/8.6) cut along line boundaries —
//     pieces stack at a line pitch and stay ONE component.
//   • 8.7 absorbees are ≥80% inside their container — their ink
//     interleaves the container's rows, so the merged unit stays one
//     component (fragment absorption is NOT affected).
//   • Declared-rect gaps ≤ ink-rect gaps (pdfjs overstates widths, left
//     edges are exact): this step on declared rects is strictly
//     CONSERVATIVE relative to the ink-based bisect metric — it can only
//     under-split, never over-split vs what the metric flags.
//
// EXCEPTION (caption bands): a unit whose SOME component starts with a
// figure/table caption pattern ("Figure 1.3 …", "Table 3. …") AND whose
// overall maxGap ≤ NONADJ_CAPTION_MAX_GAP is a caption+labels band — its
// contract (since LAYOUT-FIX-3) is exactly that gluing. The distance cap
// keeps the exception local: urt.pdf p7's "Table 3. Univariate Analysis."
// banded with a running header 469pt away does NOT qualify and is split.
//
// Kill-switch: ContourSettings.disableNonAdjacentSplit → byte-for-byte
// pre-LAYOUT-FIX-8 output (I4 invariant, p6-layout-columns B1).

/** STEP 9.5: connectivity tolerance — rects closer than this (inflation)
 * in BOTH axes are "touching". Mirrors the bisect metric's +6pt. */
const NONADJ_CONNECT = 6;
/** STEP 9.5: inter-component gap at which a unit is cut (pt). 12–20 = suspect zone (kept). */
const NONADJ_SPLIT_GAP = 20;
/** STEP 9.5: caption-band exception — max overall gap of a caption-anchored
 * band that stays merged (pt). */
const NONADJ_CAPTION_MAX_GAP = 120;
/** STEP 9.5: caption pattern anchoring the caption-band exception. */
const NONADJ_CAPTION_RE = /^(Figure|Fig\.|Таблица|Table)\s*\d/i;

function splitNonAdjacentComponents(paras: Paragraph[]): Paragraph[] {
  if (paras.length === 0) return paras;
  const out: Paragraph[] = [];
  let changed = false;
  for (const p of paras) {
    const spans = p.spans;
    if (spans.length < 2) { out.push(p); continue; }

    // Union-find over span rects (+6pt inflation connectivity).
    const n = spans.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = spans[i], b = spans[j];
        if (a.left < b.right + NONADJ_CONNECT && b.left < a.right + NONADJ_CONNECT
          && a.top < b.bottom + NONADJ_CONNECT && b.top < a.bottom + NONADJ_CONNECT) {
          parent[find(i)] = find(j);
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      let g = groups.get(root);
      if (!g) { g = []; groups.set(root, g); }
      g.push(i);
    }
    if (groups.size < 2) { out.push(p); continue; }

    // Component boxes in reading order; Chebyshev gap between neighbours.
    const comps = Array.from(groups.values()).map(idx => {
      const rs = idx.map(i => spans[i]);
      return {
        idx,
        l: Math.min(...rs.map(s => s.left)), t: Math.min(...rs.map(s => s.top)),
        r: Math.max(...rs.map(s => s.right)), b: Math.max(...rs.map(s => s.bottom)),
      };
    }).sort((a, b) => a.t - b.t || a.l - b.l);
    let maxGap = 0;
    for (let i = 1; i < comps.length; i++) {
      const a = comps[i - 1], b = comps[i];
      const dx = Math.max(0, Math.max(a.l - b.r, b.l - a.r));
      const dy = Math.max(0, Math.max(a.t - b.b, b.t - a.b));
      maxGap = Math.max(maxGap, dx, dy);
    }
    if (maxGap < NONADJ_SPLIT_GAP) { out.push(p); continue; }

    // Caption-band exception (local caption+labels gluing only).
    if (maxGap <= NONADJ_CAPTION_MAX_GAP) {
      const isCaptionComp = comps.some(c => NONADJ_CAPTION_RE.test(
        c.idx.map(i => (spans[i] as any).text || '').join(' ').replace(/\s+/g, ' ').trim()));
      if (isCaptionComp) { out.push(p); continue; }
    }

    // Cut: one paragraph per component (spans in reading order).
    for (const c of comps) {
      const compSpans = c.idx
        .map(i => spans[i])
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const { dominantFamily, dominantSize } = computeDominantFont(compSpans);
      out.push(makeParagraph(compSpans, dominantFamily, dominantSize));
    }
    changed = true;
  }
  if (!changed) return paras;
  out.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return out;
}

// ════════════════════════════════════════════════════════════════════
// STEP 9: Column-aware reading order
// ════════════════════════════════════════════════════════════════════
//
// Reorders paragraphs to native reading order for multi-column layouts.
//
// Algorithm:
//   1. Find "column-eligible" paragraphs (substantial height ≥30px AND width ≥50px).
//   2. Cluster eligible paragraphs by pxLeft (gap > 50px = new column).
//   3. Only clusters with ≥2 paragraphs are "real columns".
//   4. Compute column boundaries (left = cluster min pxLeft, medianRight = median pxRight).
//   5. Gaps = [col[i].medianRight+1, col[i+1].left-1].
//   6. A paragraph is "wide" if it spans across any gap (pLeft < gap.left AND pRight > gap.right).
//   7. Column region (vertical) = intersection of all real columns' non-wide eligible paragraph y-ranges.
//   8. Classify each paragraph:
//      - Wide → header bucket (beginning)
//      - pxTop < colRegionTop → header bucket
//      - pxBottom > colRegionBottom → footer bucket
//      - Otherwise → column bucket (by pxLeft)
//   9. Sort: header+wide (pxTop, pxLeft) → columns (left-to-right, pxTop within) → footer (pxTop, pxLeft).
//
// For single-column pages (no detected columns), falls back to simple pxTop, pxLeft sort.

// LAYOUT-FIX (2026-09-14): half of the max accumulated pdfjs start-drift.
// Paragraphs whose declared right edge crosses a boundary by LESS than this
// are NOT considered cross-column (the overstatement of justified lines can
// reach ~25pt past the true ink end); genuinely wide elements (titles,
// captions, abstracts) cross by hundreds of points.
const WIDE_MARGIN = 36;

// ════════════════════════════════════════════════════════════════════
// STEP 9.7 (LAYOUT-FIX-15, 2026-09-19): split hanging-group chains
// ════════════════════════════════════════════════════════════════════
//
// PROBLEM (preset 'separate', calibrated on grading p4 — the Table 2 page):
//   A table's row-label column chains into ONE unit: 'Breed DSH Other Sex
//   Male Female Age, y, mean ± SD Nodules at presentation …' (30 spans).
//   The label lines stack at a 9.4pt pitch with 0.8–1.4pt ink gaps — BELOW
//   every occupancy-grid resolution that still keeps prose paragraphs
//   intact (body boxes at a 10.1pt pitch OVERLAP; table labels sit 1pt
//   apart; no cellSize separates them), so STEP 6's touch-merge chains the
//   whole column. The vertical extent of a real chain is not the grid's
//   business — the chain's INTERNAL STRUCTURE is the signal:
//
//     flush (307.5): 'Breed'        ─ group start (table row group)
//     ind  (315.9): 'DSH'           ┐
//     ind  (315.9): 'Other'          ┘ sub-rows
//     flush (307.5): 'Sex'           ─ NEXT group → SPLIT here
//     ind  (315.9): 'Male' 'Female'  ┘
//     ...
//
// RULE: within a unit, a FLUSH line that follows a run of ≥2 consecutive
// INDENTED lines (left ≥ bodyLeft + indentThreshold, where bodyLeft is the
// unit's minimum line left) starts a new group. The ≥2-run guard keeps the
// classic first-line-indent PROSE paragraph intact (its indented run is
// exactly 1 line — the paragraph's first); a wrapped label continuation of
// ONE line ('Sites with negative prognosis' + 'dogs f') also stays with its
// header. Measured on grading p4: the 30-span chain cuts into 7 groups
// ([Breed DSH Other][Sex Male Female][Age… Nodules Single Multiple]
// [Anatomic location Head Trunk Limbs Sites… dogs f][…]); consecutive
// single-line flush rows stay chained (documented limitation — a flush row
// after a flush row carries no boundary evidence).
//
// PRESET-SCOPED: runs ONLY under ContourSettings.layoutPreset ===
// 'separate' (buildParagraphs STEP 9.7 call site). The 'standard' output
// is byte-identical without it.

/** STEP 9.7: minimum lines for a chain to be splittable at all. */
const HANGING_MIN_LINES = 4;
/** STEP 9.7: minimum consecutive indented lines before the next flush
 * line counts as a group boundary (≥2 keeps 1-line prose first-line
 * indents and 1-line wrapped label continuations attached). */
const HANGING_MIN_RUN = 2;
/** STEP 9.7: sanity cap on boundaries per unit (a split-happy unit is a
 * misread page, not a table). */
const HANGING_MAX_BOUNDS = 12;

function splitByHangingGroups(paras: Paragraph[], indentThreshold: number): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of paras) {
    const spans = p.spans;
    if (!spans || spans.length < HANGING_MIN_LINES) { out.push(p); continue; }
    const lines = groupIntoLines(spans);
    if (lines.length < HANGING_MIN_LINES) { out.push(p); continue; }

    // Line lefts (min span left per line) + the unit's flush edge.
    const lineLeft = lines.map(ln => ln.reduce((m, s) => Math.min(m, s.left), Infinity));
    const bodyLeft = Math.min(...lineLeft);
    const indented = lineLeft.map(l => l - bodyLeft >= indentThreshold);
    // No indented lines at all (or all indented — no flush anchor): the
    // hanging structure is absent, the unit passes through untouched.
    if (!indented.some(Boolean)) { out.push(p); continue; }

    // Boundaries: before a flush line that follows a run of ≥ HANGING_
    // MIN_RUN indented lines.
    const bounds: number[] = [];
    let run = 0;
    for (let i = 1; i < lines.length; i++) {
      if (indented[i - 1]) run++; else run = 0;
      if (!indented[i] && run >= HANGING_MIN_RUN) bounds.push(i);
    }
    if (bounds.length === 0 || bounds.length > HANGING_MAX_BOUNDS) { out.push(p); continue; }

    // Cut along the boundaries; every part keeps its own dominant font
    // (the same construction splitNonAdjacentComponents uses).
    const edges = [0, ...bounds, lines.length];
    for (let e = 1; e < edges.length; e++) {
      const partSpans = lines.slice(edges[e - 1], edges[e]).flat();
      if (partSpans.length === 0) continue;
      const { dominantFamily, dominantSize } = computeDominantFont(partSpans);
      const part = makeParagraph(partSpans, dominantFamily, dominantSize);
      out.push(part);
    }
  }
  // The parts of a split chain inherit the chain's single slot in the
  // reading order (its later groups sit up to a table's height below it) —
  // re-assert the preset's row-major order over the result.
  out.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  return out;
}

function applyColumnOrder(paras: Paragraph[], _cellSize: number, boundaries?: number[]): Paragraph[] {
  if (paras.length <= 1) return paras;
  if (boundaries?.length) {
    const wide = (p: Paragraph) => boundaries.some(b => p.pxLeft < b-36 && p.pxRight > b+36);
    const body=paras.filter(p=>!wide(p)&&p.height>=30&&p.width>=50);
    const bodyTop=body.length?Math.min(...body.map(p=>p.pxTop)):-Infinity;
    const header=paras.filter(p=>p.pxBottom<bodyTop-4);
    const rest=paras.filter(p=>!header.includes(p));
    const separators=rest.filter(wide).sort((a,b)=>a.pxTop-b.pxTop);
    const remaining=rest.filter(p=>!wide(p));
    const ordered: Paragraph[]=[...header].sort((a,b)=>a.pxTop-b.pxTop||a.pxLeft-b.pxLeft);
    const flush=(limit:number) => {
      const band=remaining.filter(p=>p.pxTop<limit);
      for(const p of band) remaining.splice(remaining.indexOf(p),1);
      const column=(p:Paragraph) => boundaries.filter(b=>p.pxLeft>=b-8).length;
      band.sort((a,b)=>column(a)-column(b)||a.pxTop-b.pxTop||a.pxLeft-b.pxLeft);
      ordered.push(...band);
    };
    for(const p of separators) {flush(p.pxTop);ordered.push(p);}
    flush(Infinity);
    return ordered;
  }

  // --- Step 1: Find column-eligible paragraphs ---
  const eligible = paras.filter(p =>
    (p.pxBottom - p.pxTop) >= 30 && (p.pxRight - p.pxLeft) >= 50
  );

  if (eligible.length < 4) {
    return [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // --- Step 2: Cluster eligible paragraphs by pxLeft ---
  const sortedEligible = [...eligible].sort((a, b) => a.pxLeft - b.pxLeft);
  const COLUMN_GAP_THRESHOLD = _columnGapThreshold; // px — significant horizontal jump = new column
  const MIN_COLUMN_SIZE = 2;       // need ≥2 eligible paras to be a "real column"

  const rawClusters: Paragraph[][] = [[sortedEligible[0]]];
  for (let i = 1; i < sortedEligible.length; i++) {
    const prevCluster = rawClusters[rawClusters.length - 1];
    // P2-10 (Phase 17): cluster against prevCluster's MAX pxLeft, not just
    // the last appended paragraph's pxLeft. The two values happen to be
    // identical today (sortedEligible is sorted ascending, so the cluster's
    // last element is its max), but the explicit reducer makes the intent
    // clear and is robust to future reordering inside a cluster.
    const clusterMaxPxLeft = prevCluster.reduce((m, p) => Math.max(m, p.pxLeft), -Infinity);
    if (sortedEligible[i].pxLeft - clusterMaxPxLeft > COLUMN_GAP_THRESHOLD) {
      rawClusters.push([sortedEligible[i]]);
    } else {
      prevCluster.push(sortedEligible[i]);
    }
  }

  // --- Step 3: Filter to real columns (≥ MIN_COLUMN_SIZE paragraphs) ---
  const realColumns = rawClusters
    .map(cluster => {
      const lefts = cluster.map(p => p.pxLeft);
      const rights = cluster.map(p => p.pxRight).sort((a, b) => a - b);
      return {
        left: lefts.reduce((a, b) => Math.min(a, b), Infinity),
        medianRight: rights[Math.floor(rights.length / 2)],
        paras: cluster,
      };
    })
    .filter(c => c.paras.length >= MIN_COLUMN_SIZE);

  // Single or zero columns → simple sort
  if (realColumns.length <= 1) {
    return [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // --- Step 4: Compute gaps between real columns ---
  const gaps: Array<{ left: number; right: number }> = [];
  for (let i = 0; i < realColumns.length - 1; i++) {
    const gapLeft = realColumns[i].medianRight + 1;
    const gapRight = realColumns[i + 1].left - 1;
    if (gapLeft < gapRight) {
      gaps.push({ left: gapLeft, right: gapRight });
    }
  }

  if (gaps.length === 0) {
    return [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // --- Step 5: Define column ranges for assignment ---
  // Column i: [realColumns[i].left, realColumns[i+1].left - 1] (or Infinity for last)
  const columnRanges = realColumns.map((c, i) => ({
    left: c.left,
    right: i < realColumns.length - 1 ? realColumns[i + 1].left - 1 : Infinity,
  }));

  // --- Step 6: Wide check ---
  const isWide = (p: Paragraph): boolean => {
    for (const g of gaps) {
      if (p.pxLeft < g.left && p.pxRight > g.right) return true;
    }
    return false;
  };

  // --- Step 7: Compute column region (vertical extent) ---
  // Use non-wide eligible paragraphs in each column.
  // colRegionTop = MIN of column tops (with tolerance, so paragraphs starting
  //   a few pixels earlier than the latest column don't get misclassified as header)
  // colRegionBottom = MAX of column bottoms (symmetric reasoning)
  const TOLERANCE_PX = 5;
  const colRegionTops: number[] = [];
  const colRegionBottoms: number[] = [];
  for (const col of realColumns) {
    const nonWide = col.paras.filter(p => !isWide(p));
    if (nonWide.length > 0) {
      colRegionTops.push(nonWide.map(p => p.pxTop).reduce((a, b) => Math.min(a, b), Infinity));
      colRegionBottoms.push(nonWide.map(p => p.pxBottom).reduce((a, b) => Math.max(a, b), -Infinity));
    }
  }

  // If no non-wide paragraphs found, fall back to simple sort
  if (colRegionTops.length === 0) {
    return [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  const colRegionTop = colRegionTops.reduce((a, b) => Math.min(a, b), Infinity) - TOLERANCE_PX;
  const colRegionBottom = colRegionBottoms.reduce((a, b) => Math.max(a, b), -Infinity) + TOLERANCE_PX;

  // --- Step 8: Classify paragraphs ---
  const header: Paragraph[] = [];
  const footer: Paragraph[] = [];
  const columnBuckets: Paragraph[][] = realColumns.map(() => []);

  for (const p of paras) {
    if (p.pxTop < colRegionTop) {
      // Above column region → header (regardless of wide/narrow)
      header.push(p);
    } else if (p.pxBottom > colRegionBottom) {
      // Below column region → footer (regardless of wide/narrow)
      footer.push(p);
    } else if (isWide(p)) {
      // In column region but spans across columns → header
      // (per user spec: cross-column spans go to beginning)
      header.push(p);
    } else {
      // In column region, not wide → assign to column by pxLeft
      const colIdx = columnRanges.findIndex(c => p.pxLeft >= c.left && p.pxLeft <= c.right);
      if (colIdx >= 0) {
        columnBuckets[colIdx].push(p);
      } else {
        // pxLeft doesn't match any column range → header fallback
        header.push(p);
      }
    }
  }

  // --- Step 9: Sort each bucket ---
  // Header → beginning (by pxTop, then pxLeft)
  header.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  // Each column → top to bottom
  for (const bucket of columnBuckets) {
    bucket.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // Footer → end (by pxTop, then pxLeft)
  footer.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  return [...header, ...columnBuckets.flat(), ...footer];
}

// LAYOUT-FIX-3 (2026-09-16): internal hooks for tests/debugging (not part
// of the public contract) — same pattern as column-slicer's
// __columnSlicerInternals.
export const __islandBuilderInternals = {
  absorbContainedFragments,
  mergeFigureLabelBands,
  // LAYOUT-FIX-7: exposed for the p7 unit suite (same-column gate, ink-wide
  // classification, pxRight cap). Not part of the public contract.
  fixTocEntries,
  applyColumnOrder,
  // LAYOUT-FIX-8: exposed for the p8 unit suite (non-adjacency split).
  splitNonAdjacentComponents,
  WIDE_MARGIN,
  FRAGMENT_MAX_LINES,
  FRAGMENT_MAX_SPANS,
  FRAGMENT_CONTAINER_MIN_LINES,
  FRAGMENT_AREA_RATIO,
  FRAGMENT_CONTAIN_FRAC,
  FRAGMENT_SIZE_MAX_RATIO,
  BAND_MIN_BLOCKS,
  BAND_DENSITY_MAX,
  NONADJ_CONNECT,
  NONADJ_SPLIT_GAP,
  NONADJ_CAPTION_MAX_GAP,
  // LAYOUT-FIX-11: exposed for the DOM|queue parity suite (heading split).
  splitByStandaloneHeading,
  HEADING_SIZE_DELTA,
  HEADING_BODY_EPS,
  // LAYOUT-FIX-13: exposed for the torn-fragment re-attach unit suite
  // (p13-fragment-reattach.ts).
  reattachTornFragments,
  canReattachTornPair,
  visualRows,
  REATTACH_TERMINALS,
  REATTACH_SIZE_TOL,
  REATTACH_LEFT_TOL,
  REATTACH_PROSE_WORDS,
  REATTACH_SUP_DELTA,
};
