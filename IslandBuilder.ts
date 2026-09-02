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

import { OccupancyMapResult, getFontFamily, InputRect, lineGroupingTolerance, groupSpansIntoLines } from './OccupancyMap';

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
}

export interface ContourSettings {
  /** Pixel threshold for considering a line indented (default 5). */
  indentThreshold?: number;
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
}

const DEFAULT_INDENT_THRESHOLD = 5;
const DEFAULT_FONT_SIZE_TOLERANCE = 1;
const DEFAULT_MAX_MERGE_PASSES = 10;
// Stage 2.2 (Q6): defaults for the new exposed settings.
const DEFAULT_COLUMN_GAP_THRESHOLD = 50;
const DEFAULT_DECORATION_THRESHOLD = 0.7;

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

export function buildParagraphs(
  map: OccupancyMapResult,
  rects: InputRect[],
  settings: ContourSettings = {}
): Paragraph[] {
  // P2-1 + P3-55 (Phase 17): `hContourCells` removed (dead compute — the
  // `hBreak` check below was always false because the horizontal-contour
  // pass never marked cells for the column-gap pattern it claimed to
  // detect, so the BFS never short-circuited). `lineInfo` is also unused
  // in this module — it's only consumed inside OccupancyMap.ts itself.
  const { gridW, gridH, cellSize, occupied, contourCells } = map;
  const INDENT_THRESHOLD = settings.indentThreshold ?? DEFAULT_INDENT_THRESHOLD;
  const FONT_SIZE_TOLERANCE = settings.fontSizeTolerance ?? DEFAULT_FONT_SIZE_TOLERANCE;
  const MAX_MERGE_PASSES = settings.maxMergePasses ?? DEFAULT_MAX_MERGE_PASSES;
  // Stage 2.1 (Q5): propagate preserveStyle to all getFontFamily calls
  // inside this function. The pdfjs path sets this to true so bold/italic
  // variants are treated as different families (matching DOM path behavior).
  const PRESERVE_STYLE = settings.preserveStyle ?? false;
  _preserveStyle = PRESERVE_STYLE;
  // Stage 2.2 (Q6): propagate the new settings to module-level helpers.
  _columnGapThreshold = settings.columnGapThreshold ?? DEFAULT_COLUMN_GAP_THRESHOLD;
  _decorationThreshold = settings.decorationThreshold ?? DEFAULT_DECORATION_THRESHOLD;

  // P2-4 (Phase 17): wrap the entire body in try/finally so the module-level
  // flags are ALWAYS reset, even if an exception escapes (previously a throw
  // inside Step 5-9 would leave `_preserveStyle=true`/`_columnGapThreshold=X`
  // set, leaking into subsequent calls from a different layout engine path).
  try {
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

      // Grid-cell bbox — CONNECTIVITY and size-filter only. The published
      // geometry is recomputed from real span rects below (T-LD-R).
      let pxLeft = minX * cellSize;
      let pxTop = minY * cellSize;
      let pxRight = (maxX + 1) * cellSize;
      let pxBottom = (maxY + 1) * cellSize;
      let width = pxRight - pxLeft;
      let height = pxBottom - pxTop;
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

      // T-LD-R (right-edge accuracy): the island's PUBLISHED bbox is the
      // union of its member spans' REAL rects — pixel-exact. The previous
      // quantized-cell bbox inflated right/bottom edges by up to a full
      // cell (4px); multi-line column paragraphs then visually touched the
      // neighbouring column, and the renderer's BLEED (+4px) extended them
      // further past the original text (user-reported). Grid cells remain
      // the connectivity medium (BFS/contours/touchPairs); geometry comes
      // from the spans themselves.
      pxLeft = Math.min(...paraSpans.map(r => r.left));
      pxTop = Math.min(...paraSpans.map(r => r.top));
      pxRight = Math.max(...paraSpans.map(r => r.right));
      pxBottom = Math.max(...paraSpans.map(r => r.bottom));
      width = pxRight - pxLeft;
      height = pxBottom - pxTop;

      const { dominantFamily, dominantSize } = computeDominantFont(paraSpans);
      // Stage 0.2 (Q8): removed `as any` cast. `id` is now declared on
      // Paragraph as `string?` — we String()-coerce the numeric islandId
      // so the type checks cleanly.
      paragraphs.push({ id: String(islandId), pxLeft, pxTop, pxRight, pxBottom, width, height, spans: paraSpans, dominantFamily, dominantSize });
    }
  }

  // ── STEP 5.5 (T-LD-F4): sweep-up — no input rect may be lost ─────────
  //
  // A rect is assigned to an island by its CENTER CELL. When that cell
  // belongs to a different (filtered-out or adjacent) island, the rect
  // silently vanished from the translation — on the user's PDF this ate
  // one span per page ('Veterinary Pathology' in the journal header, the
  // 'a' table footnote marker). Every unclaimed rect is now attached to
  // the paragraph whose bbox contains it (else the nearest one), and an
  // orphan with no host at all becomes its own paragraph.
  {
    const claimed = new Set<InputRect>();
    for (const p of paragraphs) for (const r of p.spans) claimed.add(r);
    const orphans = rects.filter(r => !claimed.has(r));
    for (const r of orphans) {
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      let host: Paragraph | undefined = paragraphs.find(p =>
        cx >= p.pxLeft && cx <= p.pxRight && cy >= p.pxTop && cy <= p.pxBottom);
      if (!host) {
        let bestDist = Infinity;
        for (const p of paragraphs) {
          const dx = cx - (p.pxLeft + p.pxRight) / 2;
          const dy = cy - (p.pxTop + p.pxBottom) / 2;
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; host = p; }
        }
      }
      if (host) {
        host.spans.push(r);
        host.pxLeft = Math.min(host.pxLeft, r.left);
        host.pxTop = Math.min(host.pxTop, r.top);
        host.pxRight = Math.max(host.pxRight, r.right);
        host.pxBottom = Math.max(host.pxBottom, r.bottom);
        host.width = host.pxRight - host.pxLeft;
        host.height = host.pxBottom - host.pxTop;
        const dom = computeDominantFont(host.spans);
        host.dominantFamily = dom.dominantFamily;
        host.dominantSize = dom.dominantSize;
      } else {
        const dom = computeDominantFont([r]);
        paragraphs.push({
          pxLeft: r.left, pxTop: r.top, pxRight: r.right, pxBottom: r.bottom,
          width: r.right - r.left, height: r.bottom - r.top,
          spans: [r], dominantFamily: dom.dominantFamily, dominantSize: dom.dominantSize,
        });
      }
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
   * T3.6: delegates to the single primaryFamilyOf implementation.
   */
  function getPrimaryFamily(para: Paragraph): string {
    return primaryFamilyOf(para.spans);
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

      // ── TABLE-CELL GUARD (Step 6) ──────────────────────────────────
      // T3.6: shared isTablePattern (was a verbatim duplicate of the
      // Step-8.5 guard).
      if (isTablePattern(a, b)) {
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

  // ── STEP 7: Split by font family / size ────────────────────────────
  finalParagraphs = splitByFont(finalParagraphs, FONT_SIZE_TOLERANCE);

  // T-LD (moved to 8.7): the marker split previously ran here (7.5) and
  // step 8.5's remergeAfterFontSplit immediately GLUED the split pieces
  // back together (same family, same size, physically touching — they came
  // from one island). The pass now runs AFTER remerge; see step 8.7.

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

  // ── STEP 8.7: Split by paragraph-start markers (T-LD, moved from 7.5) ──
  // Footnotes, affiliation blocks and figure/table captions often share the
  // font AND indent of neighbouring text and sit closer than the contour
  // threshold, so steps 7/8/8.5/8.6 cannot separate them. A line-level
  // marker (structural label, footnote number, "Figure N.") on a non-first
  // line starts a new paragraph. Running AFTER remerge guarantees the split
  // is final — nothing downstream re-joins logical blocks that were split
  // on purpose.
  finalParagraphs = splitByParagraphMarkers(finalParagraphs);

  // ── STEP 9: Column-aware reading order ─────────────────────────────
  // Reorder paragraphs to native reading order:
  //   1. Header (above column region) + Wide (cross-column spans) → beginning
  //   2. Column 0 (left, top-to-bottom), Column 1, ... Column N
  //   3. Footer (below column region) → end
  finalParagraphs = applyColumnOrder(finalParagraphs, cellSize);

  // Stage 2.1 (Q5): reset module-level flag so subsequent calls (e.g. from
  // a different layout engine path) default to legacy behavior unless they
  // explicitly set preserveStyle.
  // P2-4 (Phase 17): moved into `finally` so the reset runs even on throw.
  return finalParagraphs;
  } finally {
    _preserveStyle = false;
    // Stage 2.2 (Q6): reset the new settings too.
    _columnGapThreshold = DEFAULT_COLUMN_GAP_THRESHOLD;
    _decorationThreshold = DEFAULT_DECORATION_THRESHOLD;
  }
}

/**
 * T3.6: THE single implementation of the decoration-aware "primary font
 * family" computation. Previously THREE divergent copies existed (Step 6's
 * getPrimaryFamily closure, splitByFont's inline version, and
 * remergeAfterFontSplit's getPrimaryFamilyLocal) — a change to one silently
 * desynchronized the merge and split passes.
 *
 * T-LD-F1/D3 fix: the family vote is now WEIGHTED BY CHARACTER COUNT.
 * Span-count voting let a short bold/italic LEAD-IN ("Figure 1.", "a",
 * "1") outvote the 80-character body text of the same line — flipping the
 * whole line's family and slicing captions/affiliations mid-sentence into
 * a "bold" fragment and a body fragment. Characters, not span fragments,
 * are what the reader sees.
 */
function primaryFamilyOf(spans: InputRect[]): string {
  const candidates: Array<{ family: string; size: number; weight: number }> = [];
  for (const s of spans) {
    const fam = getFontFamily(s.fontname, _preserveStyle);
    const sz = Number.isFinite(s.fontsize) ? s.fontsize! : 10;
    // Weight = visible characters (pdfjs str / DOM textContent). Missing
    // text falls back to weight 1 so DOM/test callers without text still work.
    const weight = Math.max(1, (s.text ?? '').length);
    candidates.push({ family: fam, size: sz, weight });
  }
  if (candidates.length === 0) return 'unknown';

  // Spans much smaller than the median are decorations (superscripts,
  // footnote refs) — they must not influence the primary family.
  const sizes = candidates.map(c => c.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const DECORATION_THRESHOLD = median * _decorationThreshold;
  const mainSpans = candidates.filter(c => c.size >= DECORATION_THRESHOLD);

  const famWeight: Record<string, number> = {};
  let firstFamily = '';
  for (const c of mainSpans) {
    if (!firstFamily) firstFamily = c.family;
    famWeight[c.family] = (famWeight[c.family] || 0) + c.weight;
  }
  let bestFam = firstFamily || 'unknown';
  let bestWeight = 0;
  for (const [fam, weight] of Object.entries(famWeight)) {
    if (weight > bestWeight || (weight === bestWeight && fam === firstFamily)) {
      bestWeight = weight;
      bestFam = fam;
    }
  }
  return bestFam;
}

/**
 * T-LD-F1: character-weighted median font size, decoration-filtered.
 *
 * Replaces the unweighted span median in every size decision (line styles
 * in splitByFont, size compatibility in remerge, table-pattern line-height
 * estimate). The old median had two failure modes on mixed lines:
 *   • an even span count takes the UPPER element, so one 11.5pt
 *     superscript digit "flipped" an 8pt line to 11.5pt → spurious
 *     size-split of affiliations;
 *   • decorations were not filtered at all here (the 0.7 filter existed
 *     only in the family vote — an inconsistency).
 * Weighted-by-characters + decoration filter makes the size statistic
 * describe the text the reader actually sees.
 */
function charWeightedSize(spans: InputRect[]): number {
  if (spans.length === 0) return 10;
  const sizeOf = (s: InputRect) => (Number.isFinite(s.fontsize) ? s.fontsize! : 10);
  const all = spans.map(sizeOf).sort((a, b) => a - b);
  const med = all[Math.floor(all.length / 2)];
  let src = spans.filter(s => sizeOf(s) >= med * _decorationThreshold);
  if (src.length === 0) src = spans;
  const entries = src
    .map(s => ({ size: sizeOf(s), weight: Math.max(1, (s.text ?? '').length) }))
    .sort((a, b) => a.size - b.size);
  const total = entries.reduce((acc, e) => acc + e.weight, 0);
  let acc = 0;
  for (const e of entries) {
    acc += e.weight;
    if (acc * 2 >= total) return e.size;
  }
  return entries[entries.length - 1].size;
}

/**
 * T-LD-F1: glue one-glyph "decoration lines" back into their neighbours.
 *
 * Even with baseline grouping, a raised marker whose bottom deviates from
 * the baseline by more than the tolerance (or a subscript marker below it)
 * can still land in a line of its own. A single-span line whose size is
 * below the decoration threshold of the whole block is a marker, not a
 * paragraph — merge it into the NEXT line (markers precede their text),
 * or into the previous one when it is the last.
 */
function glueDecorationLines(lines: InputRect[][]): InputRect[][] {
  if (lines.length < 2) return lines;
  const flat = lines.reduce<InputRect[]>((acc, l) => acc.concat(l), []);
  const ref = charWeightedSize(flat);
  const sizeOf = (s: InputRect) => (Number.isFinite(s.fontsize) ? s.fontsize! : 10);
  const isDeco = (ln: InputRect[]) =>
    ln.length === 1 && sizeOf(ln[0]) < ref * _decorationThreshold;
  const deco = lines.map(isDeco);
  const swallowed = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!deco[i]) continue;
    let j = i + 1;
    while (j < lines.length && deco[j]) j++;
    if (j < lines.length) {
      lines[j] = [...lines[i], ...lines[j]];
      swallowed[i] = true;
    } else {
      let k = i - 1;
      while (k >= 0 && deco[k]) k--;
      if (k >= 0) {
        lines[k] = [...lines[k], ...lines[i]];
        swallowed[i] = true;
      }
    }
  }
  return lines.filter((_, i) => !swallowed[i]);
}

/**
 * T3.6: THE single table-cell guard (was duplicated verbatim in Step 6 and
 * Step 8.5). Two side-by-side islands with a clear horizontal gap and
 * strong vertical overlap are table cells in the same row — never merge.
 */
function isTablePattern(a: Paragraph, b: Paragraph): boolean {
  const hGap = Math.max(0, Math.max(a.pxLeft, b.pxLeft) - Math.min(a.pxRight, b.pxRight));
  const vOverlapTop = Math.max(a.pxTop, b.pxTop);
  const vOverlapBottom = Math.min(a.pxBottom, b.pxBottom);
  const vOverlap = Math.max(0, vOverlapBottom - vOverlapTop);
  const smallerHeight = Math.min(a.pxBottom - a.pxTop, b.pxBottom - b.pxTop);
  const vOverlapFrac = smallerHeight > 0 ? vOverlap / smallerHeight : 0;
  // T-LD-F1: char-weighted, decoration-filtered sizes (a superscript in a
  // cell no longer inflates the estimated line height and unlocks merges).
  const estLineHeight = Math.min(charWeightedSize(a.spans), charWeightedSize(b.spans)) * 1.2;
  return hGap >= estLineHeight * 1.5 && vOverlapFrac > 0.5;
}

/**
 * Dominant (most frequent) family+size across a paragraph's spans.
 * Kept for the merge passes' recomputation after islands are unioned.
 */
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
  // T3.6: shared, font-scale-aware grouping (baseline-based since T-LD-F1).
  // T-LD-F1: decoration lines (stray superscript markers) are glued back
  // into their neighbours BEFORE any split pass sees them.
  return glueDecorationLines(groupSpansIntoLines(spans, lineGroupingTolerance(spans)));
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

    // Compute primary family AND primary (median) size per line.
    // T3.6: family calc delegates to the shared primaryFamilyOf.
    // T3.2: primarySize is now actually USED — the old implementation
    // computed it and never compared it, so a 22pt heading and 10pt body
    // set in the SAME typeface stayed glued together whenever they
    // physically touched (gap < contour threshold). Size change beyond
    // fontSizeTolerance now starts a new sub-paragraph, honouring the
    // step's own docstring ("Split by font family change … and size").
    // T-LD-F1: family vote is char-weighted (a short bold "Figure 1."
    // lead-in no longer flips the line), size is the char-weighted,
    // decoration-filtered median (a stray superscript digit no longer
    // flips an 8pt line to 11.5pt).
    const lineStyles = lines.map(lineSpans => {
      const primaryFam = primaryFamilyOf(lineSpans);
      const primarySize = charWeightedSize(lineSpans);
      return { lineSpans, primaryFam, primarySize };
    });

    // Walk lines and group by (family, size) continuity
    const subGroups: Array<{ lines: typeof lineStyles; family: string; size: number }> = [];
    let currGroup: typeof lineStyles = [lineStyles[0]];
    let currFam = lineStyles[0].primaryFam;
    let currSize = lineStyles[0].primarySize;

    for (let i = 1; i < lineStyles.length; i++) {
      const ls = lineStyles[i];
      const famChanged = ls.primaryFam !== currFam;
      const sizeChanged = Math.abs(ls.primarySize - currSize) > fontSizeTolerance;
      if (famChanged || sizeChanged) {
        // Family OR size change → start new group (T3.2)
        subGroups.push({ lines: currGroup, family: currFam, size: currSize });
        currGroup = [ls];
        currFam = ls.primaryFam;
        currSize = ls.primarySize;
      } else {
        currGroup.push(ls);
      }
    }
    if (currGroup.length > 0) {
      subGroups.push({ lines: currGroup, family: currFam, size: currSize });
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
 * Step 7.6: Re-merge islands AFTER splitByFont.
 *
 * After splitByFont, one original island may be split into multiple
 * sub-paragraphs (e.g. drop-cap "A" separated from body text by size
 * threshold). These fragments need to be re-merged if:
 *   1. Their SOURCE islands physically touched (we use the original
 *      `touchPairs` Set from Step 6 — only pairs already known to touch).
 *   2. They share the same primary font family (decoration-aware).
 *   3. Their primary sizes are compatible: either within fontSizeTolerance,
 *      OR one of them is a "drop-cap" (size >= 2.5x the other's primary size),
 *      in which case the larger is treated as an inline decoration of the
 *      smaller body text — they merge.
 *
 * CRITICAL RULE: only pairs in `touchPairs` (built from `cellIslandId`
 * 4-neighbour adjacency in Step 5) are considered. Non-touching islands
 * NEVER merge.
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
   * Two paragraphs are size-compatible if:
   *   - |primarySize_a - primarySize_b| <= fontSizeTolerance  (same body text size)
   *   - OR one is a "drop-cap": larger primary size >= 2.5 x smaller primary size
   *     (the drop-cap is treated as an inline decoration of the body text)
   */
  function sizeCompatible(a: Paragraph, b: Paragraph): boolean {
    // T-LD-F1: char-weighted, decoration-filtered size (replaces the old
    // local unweighted getPrimarySize median).
    const sa = charWeightedSize(a.spans);
    const sb = charWeightedSize(b.spans);
    if (Math.abs(sa - sb) <= fontSizeTolerance) return true;
    const larger = Math.max(sa, sb);
    const smaller = Math.min(sa, sb);
    if (smaller > 0 && larger / smaller >= 2.5) return true;  // drop-cap case
    return false;
  }

  /**
   * Check if two paragraphs' source islands physically touched.
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
  let changed = true;
  let passes = 0;
  const MAX_PASSES = 10;

  while (changed && passes < MAX_PASSES) {
    changed = false;
    passes++;

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
        if (primaryFamilyOf(a.spans) !== primaryFamilyOf(b.spans)) continue;

        // Size compatible (same body size OR drop-cap)
        const szCompat = sizeCompatible(a, b);
        if (!szCompat) continue;

        // ── TABLE-CELL GUARD ──────────────────────────────────────────
        // T3.6: shared isTablePattern (was a verbatim duplicate of the
        // Step-6 guard).
        if (isTablePattern(a, b)) {
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
        // Update cell cache: union of A and B cells
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

/**
 * Step 8.7: Split by paragraph-start markers (runs AFTER remerge — T-LD).
 *
 * Footnotes, affiliation blocks and figure/table captions often share the
 * font AND indent of neighbouring text and sit closer than the contour
 * threshold, so steps 7/8/8.5/8.6 cannot separate them. A line-level
 * marker (structural label, footnote number, "Figure N.") on a non-first
 * line starts a new paragraph. Running AFTER remerge guarantees the split
 * is final — nothing downstream re-joins logical blocks that were split
 * on purpose.
 */
function splitByParagraphMarkers(paras: Paragraph[]): Paragraph[] {
  const result: Paragraph[] = [];

  // Known structural labels that ALWAYS start a new paragraph.
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
    // T-LD (figure/table captions): a caption LABEL spans its OWN BOLD/ITALIC
    // SPAN that starts a new block. Caption blocks on the user's PDF are
    // glued by the contour threshold (< 8px gaps); the label span is the
    // only reliable boundary. Matched against the SPAN TEXT, not the joined
    // line — see CAPTION_LABEL below.
    /^(figure|fig\.?|table|scheme|plate)\s+\d+\s*[.:)](\s|$)/i,
  ];

  // Footnote number pattern: 1-3 digits at start of line, followed by
  // a capital letter or symbol (avoid matching decimal numbers like "3.5"
  // or page numbers mid-line).
  const FOOTNOTE_NUM = /^\d{1,3}(?=[A-ZÀ-Þ\u00c0-\u00de«ª])/;

  // T-LD: caption-label pattern matched against INDIVIDUAL SPAN texts.
  // The label ("Figure 2.", "Table 1.") is a distinct bold/italic span that
  // sits mid-line: "Bar 25 mm. |Figure 2.| Mammary…". Splitting at the
  // SPAN boundary (not a character offset in the joined line) keeps the
  // bold lead-in as the OPENING of its caption block — per the user's
  // correction, a caption label must never be separated from its caption.
  const CAPTION_LABEL = /^(figure|fig\.?|table|scheme|plate)\s+\d+\s*[.:)](\s|$)/i;

  for (const para of paras) {
    const lines = groupIntoLines(para.spans);
    if (lines.length <= 1) { result.push(para); continue; }

    // T-LD: build LOGICAL LINES first. A mid-line caption-label SPAN
    // ("Bar 25 mm. |Figure 2.| Mammary…") cuts its line in two at the span
    // boundary: the label span and everything to its right become a new
    // logical line flagged as a block start — the bold lead-in OPENS its
    // caption block and is never stranded in the previous one (user's
    // requirement). Structural/footnote markers are then evaluated on the
    // logical lines exactly as before (T3.3 guard intact).
    const logicalLines: Array<{ spans: InputRect[]; isSplitStart: boolean }> = [];
    let forceSplitNext = false;

    for (let i = 0; i < lines.length; i++) {
      let line = [...lines[i]].sort((a, b) => a.left - b.left);

      // Cut at every non-leading caption-label span (loop guards against
      // multiple labels in one line, e.g. "… HE. Bar 25 mm. |Figure 5.|").
      for (;;) {
        const labelIdx = line.findIndex(s => CAPTION_LABEL.test(((s as any).text || '').trim()));
        if (labelIdx <= 0) break; // no label, or the label already opens the line
        const left = line.slice(0, labelIdx);
        const right = line.slice(labelIdx);
        if (left.length > 0) {
          logicalLines.push({ spans: left, isSplitStart: forceSplitNext });
          forceSplitNext = false;
        }
        logicalLines.push({ spans: right, isSplitStart: true });
        line = [];
        break;
      }
      if (line.length === 0) continue;

      const text = line.map(s => (s as any).text || '').join('').trim();
      let isSplit = forceSplitNext;
      forceSplitNext = false;

      if (i > 0 && text) {
        // Structural labels (line-start anchored).
        for (const pattern of STRUCTURAL_LABELS) {
          if (pattern.test(text)) { isSplit = true; break; }
        }
        // Footnote numbers — T3.3 guard: a line starting with digits+capital
        // is a NEW footnote only when the previous line does not also start
        // with a footnote number (otherwise it is a wrapped continuation).
        if (!isSplit && FOOTNOTE_NUM.test(text)) {
          const prevText = logicalLines.length > 0
            ? logicalLines[logicalLines.length - 1].spans
                .map(s => (s as any).text || '').join('').trim()
            : '';
          if (prevText && !FOOTNOTE_NUM.test(prevText)) isSplit = true;
        }
      }
      logicalLines.push({ spans: line, isSplitStart: isSplit });
    }

    // Emit groups of logical lines between split starts.
    const groups: InputRect[][][] = [];
    let currentGroup: InputRect[][] = [];
    for (const ll of logicalLines) {
      if (ll.isSplitStart && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(ll.spans);
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    if (groups.length <= 1) {
      result.push(para);
      continue;
    }

    for (const sg of groups) {
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

function applyColumnOrder(paras: Paragraph[], _cellSize: number): Paragraph[] {
  if (paras.length <= 1) return paras;

  // --- Step 1: Find column-eligible paragraphs ---
  const eligible = paras.filter(p =>
    (p.pxBottom - p.pxTop) >= 30 && (p.pxRight - p.pxLeft) >= 50
  );

  if (eligible.length < 4) {
    return [...paras].sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);
  }

  // --- Step 2: Cluster eligible paragraphs by pxLeft ---
  const sortedEligible = [...eligible].sort((a, b) => a.pxLeft - b.pxLeft);
  // T3.5: the column-gap threshold now scales with page width. A fixed
  // 50px merged two close columns on wide pages/scans while splitting
  // tight justified text on narrow ones. The effective threshold is
  // max(user setting, 4% of page width).
  const pageWidth = (paras.reduce((m, p) => Math.max(m, p.pxRight), 0)) || 1000;
  const COLUMN_GAP_THRESHOLD = Math.max(_columnGapThreshold, pageWidth * 0.04);
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
  // T-LD-F2: wide elements INSIDE the column region are no longer hoisted
  // into the header. The old "cross-column spans go to beginning" rule
  // pushed mid-page figure captions / wide tables ABOVE the column text
  // that logically precedes them, corrupting reading order. A wide element
  // now forms a full-width BAND at its own vertical position: the column
  // flow is emitted up to the band's top, then the band, then the flow
  // continues below it.
  const header: Paragraph[] = [];
  const footer: Paragraph[] = [];
  const wideBands: Paragraph[] = [];
  const columnBuckets: Paragraph[][] = realColumns.map(() => []);

  for (const p of paras) {
    if (p.pxTop < colRegionTop) {
      // Above column region → header (regardless of wide/narrow)
      header.push(p);
    } else if (p.pxBottom > colRegionBottom) {
      // Below column region → footer (regardless of wide/narrow)
      footer.push(p);
    } else if (isWide(p)) {
      // In column region, spans across columns → full-width band at its
      // own vertical position (T-LD-F2).
      wideBands.push(p);
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

  // Wide bands → by their vertical position
  wideBands.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  // Footer → end (by pxTop, then pxLeft)
  footer.sort((a, b) => a.pxTop - b.pxTop || a.pxLeft - b.pxLeft);

  // Interleave: header → (column flow above each band → band)* → remaining
  // column flow → footer. Within a band segment, columns are emitted in
  // left-to-right order, top-to-bottom inside each.
  const result: Paragraph[] = [...header];
  const emitted = new Set<Paragraph>();
  for (const band of wideBands) {
    for (const bucket of columnBuckets) {
      for (const p of bucket) {
        if (!emitted.has(p) && p.pxTop < band.pxTop) {
          result.push(p);
          emitted.add(p);
        }
      }
    }
    result.push(band);
    emitted.add(band);
  }
  for (const bucket of columnBuckets) {
    for (const p of bucket) {
      if (!emitted.has(p)) {
        result.push(p);
        emitted.add(p);
      }
    }
  }
  return [...result, ...footer];
}
