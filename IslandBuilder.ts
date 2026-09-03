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

import { OccupancyMapResult, getFontFamily, InputRect } from './OccupancyMap';

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

  // ── STEP 7: Split by font family / size ────────────────────────────
  finalParagraphs = splitByFont(finalParagraphs, FONT_SIZE_TOLERANCE);

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
   *   - |primarySize_a - primarySize_b| <= fontSizeTolerance  (same body text size)
   *   - OR one is a "drop-cap": larger primary size >= 2.5 × smaller primary size
   *     (the drop-cap is treated as an inline decoration of the body text)
   */
  function sizeCompatible(a: Paragraph, b: Paragraph): boolean {
    const sa = getPrimarySize(a);
    const sb = getPrimarySize(b);
    if (Math.abs(sa - sb) <= fontSizeTolerance) return true;
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
