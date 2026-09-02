// OccupancyMap.ts
//
// Steps 1-3 of the pipeline:
//   1. Build occupancy grid
//   2. Detect text lines
//   3. Find vertical contour lines + remove artifacts
//
// Produces: occupied[], contourCells[], lineInfo[]
//
// Phase 17 (P2-1, P2-6, P3-55, P3-56): removed `hContourCells` (Step 4
// horizontal-contour pass was dead compute — the field was read only by an
// `hBreak` check in IslandBuilder that was always false because
// `hContourCells` was never marked for the column-gap pattern it claimed to
// detect). Also removed `colGapStartCell`/`colGapEndCell` (never read outside
// this file) and `artifactCells` (side-effect `continue` is live, but the
// output array was never read).

// Stage 0.2 (Q8): removed `@ts-nocheck`. The file is pure synchronous
// compute with no external dependencies — type errors surfaced by removing
// the suppression have been fixed (InputRect.text declared, no other
// `as any` casts remained).

export interface InputRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontname?: string;
  fontsize?: number;
  // Stage 0.2 (Q8): declared optional. `pdf-text-extractor.ts::buildInputRects`
  // and `Snapshot.ts::buildSnapshot` populate this with the span's text
  // content for downstream use by `IslandBuilder` (debug logging, sentence
  // splitting). The contour pipeline itself doesn't need it, but several
  // helpers read it — without this declaration those reads required
  // `as any` casts which `@ts-nocheck` was masking.
  text?: string;
}

export interface LineInfo {
  index: number;
  realHeight: number;
  avgHeight: number;
  top: number;
  bottom: number;
}

/**
 * T3.5: shared line-grouping tolerance. The old hardcoded 3px did not
 * scale with font size — on a 24pt heading (or at high zoom) glyphs of the
 * SAME visual line can differ in `top` by more than 3px, splitting the
 * line and corrupting downstream paragraph logic. The tolerance is now
 * `max(3, 25% of the global median span height)` — 3px stays the floor for
 * tiny 8pt text, larger type gets proportionally more slack.
 */
export function lineGroupingTolerance(rects: InputRect[]): number {
    const heights = rects.map(r => r.bottom - r.top).filter(h => h > 0).sort((a, b) => a - b);
    if (heights.length === 0) return 3;
    const median = heights[Math.floor(heights.length / 2)];
    return Math.max(3, median * 0.25);
}

/**
 * T3.6: shared line grouping used by BOTH OccupancyMap's Step 2 and
 * IslandBuilder's groupIntoLines (previously two divergent copies with the
 * same hardcoded 3px). Groups spans into lines whose `top` values differ
 * from the line's first span by at most `tol` (input order irrelevant —
 * sorts by top, then left).
 */
export function groupSpansIntoLines(spans: InputRect[], tol: number): InputRect[][] {
    // T-LD-F1 (v2): vertical-OVERLAP line grouping.
    //
    // History: top-based grouping split raised superscripts into phantom
    // one-glyph lines; the first fix (pure baseline/bottom grouping) had
    // the mirrored failure — markers raised by MORE than the tolerance
    // (author numerals "1 1 2 3", citation markers "25,31") still fell
    // into their own line, which then became a separate overlapping
    // paragraph fragment.
    //
    // Overlap criterion: a span joins the current line when their bboxes
    // overlap vertically by at least half the SMALLER height. This is
    // invariant to font-size mix on the line (superscripts overlap the
    // upper half of the body bbox; subscripts the lower half; same-size
    // neighbours on adjacent lines barely overlap at all).
    const sorted = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
    const lines: InputRect[][] = [];
    let curr: InputRect[] = [];
    let currTop = 0;
    let currBottom = 0;
    for (const s of sorted) {
        const h = Math.max(0.01, s.bottom - s.top);
        if (curr.length === 0) {
            curr = [s];
            currTop = s.top;
            currBottom = s.bottom;
            continue;
        }
        const lineH = Math.max(0.01, currBottom - currTop);
        const ov = Math.min(currBottom, s.bottom) - Math.max(currTop, s.top);
        const joins = ov >= 0.5 * Math.min(h, lineH)
            // fallback for the touching-bbox case: baselines within tol
            // with any positive overlap (tight leading, equal sizes)
            || (ov > 0 && Math.abs(s.bottom - currBottom) <= tol);
        if (joins) {
            curr.push(s);
            currTop = Math.min(currTop, s.top);
            currBottom = Math.max(currBottom, s.bottom);
        } else {
            lines.push(curr);
            curr = [s];
            currTop = s.top;
            currBottom = s.bottom;
        }
    }
    if (curr.length > 0) lines.push(curr);
    return lines;
}

export interface OccupancyMapResult {
  gridW: number;
  gridH: number;
  cellSize: number;
  occupied: Uint8Array;
  contourCells: Uint8Array;
  lineInfo: LineInfo[];
}

/**
 * Stage 2.1 (Q5): Resolve a PDF font name to a "family" identifier used
 * by the contour pipeline for paragraph grouping.
 *
 * Two modes:
 *   - `preserveStyle: false` (default, legacy behavior): strips weight/style
 *     suffix. "AGaramondPro-Bold" → "AGaramondPro". Bold and Italic variants
 *     of the same family are treated as the SAME family — used by the DOM
 *     path (which can't resolve g_d0_fN to real font names) and by the
 *     pdfjs path (which historically also stripped to keep behavior
 *     consistent with DOM).
 *   - `preserveStyle: true` (new): keeps weight/style suffix.
 *     "AGaramondPro-Bold" → "AGaramondPro-Bold". Bold and Italic are
 *     treated as DIFFERENT families — used by the pdfjs path so that
 *     `splitByFont` correctly splits paragraphs at bold/italic boundaries,
 *     matching what the DOM path already does (via g_d0_fN distinction).
 *
 * The pdfjs path now uses `preserveStyle: true` (see pdf-text-extractor.ts).
 * This makes the cache written by background translation consistent with
 * what the DOM path produces on cache miss. Without this, the same PDF
 * would produce different paragraph splits depending on whether the cache
 * was populated by the DOM path (preserves) or the pdfjs path (stripped),
 * causing translations to be applied to the wrong paragraphs.
 *
 * PDF.js textLayer class identifiers like "g_d0_f1" are already unique per
 * PDF font variant — passed through unchanged in both modes (DOM path
 * can't resolve them without PDF.js internals).
 */
export function getFontFamily(fontname: string | undefined, preserveStyle: boolean = false): string {
  if (!fontname) return 'unknown';

  // PDF.js textLayer class identifiers like "g_d0_f1" are already unique per
  // PDF font — do NOT split by '-' (would yield "g" which is meaningless).
  // These are produced by Snapshot.ts::extractFontName from span.className.
  //
  // Each g_d0_fN maps to one PDF font VARIANT (Regular, Bold, Italic each
  // get separate IDs). Both preserveStyle modes pass these through as-is —
  // the DOM path uses g_d0_fN directly (can't resolve without PDF.js
  // internals), and the distinction between variants is preserved.
  if (/^g_d\d+_f\d+$/.test(fontname)) return fontname;

  let fam = fontname;
  // pdfplumber-style: "ABCDEF+AGaramondPro-Regular" → strip subset prefix
  if (fam.includes('+')) fam = fam.split('+')[1];

  // Stage 2.1 (Q5): if preserveStyle is true, keep the full family name
  // including weight/style suffix. This makes pdfjs path produce the same
  // paragraph splits as DOM path (which preserves bold/italic distinction
  // via g_d0_fN IDs).
  if (preserveStyle) return fam;

  // Legacy behavior: strip weight/style suffix.
  // "AGaramondPro-Regular" → "AGaramondPro"
  // "AGaramondPro-BoldItalic" → "AGaramondPro"
  //
  // Per user spec: "bold, italic, другой цвет - можно допускать как один
  // стиль" — Bold/Italic variants of the same family are treated as the
  // SAME family for paragraph splitting purposes.
  const parts = fam.split('-');
  return parts.length > 1 ? parts.slice(0, -1).join('-') : fam;
}

export function buildOccupancyMap(
  rects: InputRect[],
  pageW: number,
  pageH: number,
  cellSize: number
): OccupancyMapResult {
  const gridW = Math.ceil(pageW / cellSize);
  const gridH = Math.ceil(pageH / cellSize);

  // ── STEP 1: Build occupancy grid ──────────────────────────────────
  const occupied = new Uint8Array(gridW * gridH);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.left / cellSize));
    const y0 = Math.max(0, Math.floor(r.top / cellSize));
    const x1 = Math.min(gridW - 1, Math.floor((r.right - 0.01) / cellSize));
    const y1 = Math.min(gridH - 1, Math.floor((r.bottom - 0.01) / cellSize));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        occupied[y * gridW + x] = 1;
  }

  // ── STEP 2: Detect text lines ──────────────────────────────────────
  // T3.5: tolerance is font-scale-aware (see lineGroupingTolerance) — the
  // old hardcoded 3px split large-type lines whose glyphs differ in `top`.
  // T3.6: shared grouping helper (was a duplicate of IslandBuilder's).
  const tol = lineGroupingTolerance(rects);
  const textLines: InputRect[][] = groupSpansIntoLines(rects, tol);

  // P2-6 (Phase 17): defensive guard — `textLines` only ever contains
  // non-empty arrays (the grouping loop in Step 2 always pushes a
  // one-element array first), but if a future caller passes an empty
  // `rects` (which makes `textLines` empty too) the `Math.min(...[])`
  // below would yield `Infinity` and propagate through the contour scan.
  // Skip empty lines defensively.
  const lineInfo: LineInfo[] = [];
  textLines.forEach((spans, i) => {
    if (spans.length === 0) return;
    const heights = spans.map(s => s.bottom - s.top).filter(h => h > 0);
    const realHeight = heights.length > 0 ? Math.max(...heights) : 10;
    const avgHeight = heights.reduce((s, v) => s + v, 0) / Math.max(1, heights.length);
    const top = Math.min(...spans.map(s => s.top));
    const bottom = Math.max(...spans.map(s => s.bottom));
    lineInfo.push({ index: i, realHeight, avgHeight, top, bottom });
  });

  // ── STEP 3: Vertical contour + artifacts ───────────────────────────
  const allEmptyRuns: Array<{ x: number; y0: number; y1: number; height: number }> = [];
  for (let x = 0; x < gridW; x++) {
    let runStart = -1;
    for (let y = 0; y <= gridH; y++) {
      const isEmpty = y < gridH && !occupied[y * gridW + x];
      if (isEmpty) { if (runStart < 0) runStart = y; }
      else {
        if (runStart >= 0) {
          allEmptyRuns.push({ x, y0: runStart, y1: y - 1, height: y - runStart });
          runStart = -1;
        }
      }
    }
  }

  const contourCells = new Uint8Array(gridW * gridH);

  for (const run of allEmptyRuns) {
    const heightPx = run.height * cellSize;

    let nearestLH = 10;
    const runTopPx = run.y0 * cellSize;
    const runBottomPx = (run.y1 + 1) * cellSize;
    for (const l of lineInfo) {
      const gap = Math.min(Math.abs(l.bottom - runTopPx), Math.abs(l.top - runBottomPx));
      if (gap < l.realHeight * 3) nearestLH = Math.max(nearestLH, l.realHeight);
    }

    // Artifact: 0.1-1.25 × lineHeight, 3/4 sides surrounded
    const minArtPx = nearestLH * 0.1;
    const maxArtPx = nearestLH * 1.25;
    if (heightPx >= minArtPx && heightPx <= maxArtPx) {
      const CHECK_RADIUS = 4;
      let surroundedRows = 0, rowsWithText = 0;
      for (let y = run.y0; y <= run.y1; y++) {
        let leftOcc = 0, leftTot = 0, rightOcc = 0, rightTot = 0;
        for (let dx = 1; dx <= CHECK_RADIUS; dx++) {
          const lx = run.x - dx, rx = run.x + dx;
          if (lx >= 0) { leftTot++; if (occupied[y * gridW + lx]) leftOcc++; }
          if (rx < gridW) { rightTot++; if (occupied[y * gridW + rx]) rightOcc++; }
        }
        const lr = leftTot > 0 ? leftOcc / leftTot : 0;
        const rr = rightTot > 0 ? rightOcc / rightTot : 0;
        if (leftOcc > 0 || rightOcc > 0) {
          rowsWithText++;
          let up = false, down = false;
          if (y > 0 && occupied[(y - 1) * gridW + run.x]) up = true;
          if (y < gridH - 1 && occupied[(y + 1) * gridW + run.x]) down = true;
          let sides = 0;
          if (lr >= 0.75) sides++;
          if (rr >= 0.75) sides++;
          if (up) sides++;
          if (down) sides++;
          if (sides >= 3) surroundedRows++;
        }
      }
      const sf = rowsWithText > 0 ? surroundedRows / rowsWithText : 0;
      // P3-56 (Phase 17): the `artifactCells` write was dead — the array
      // was returned but never read by any consumer. The side-effect we
      // need to keep is the `continue` below: it prevents artifact runs
      // (e.g. tiny gaps inside a glyph cluster) from being marked as
      // contour cells, which would otherwise fragment islands.
      if (sf >= 0.75) {
        continue;
      }
    }

    // Contour: height >= 2 × cellSize
    if (run.height >= 2) {
      for (let y = run.y0; y <= run.y1; y++) contourCells[y * gridW + run.x] = 1;
    }
  }

  return {
    gridW, gridH, cellSize,
    occupied, contourCells,
    lineInfo,
  };
}
