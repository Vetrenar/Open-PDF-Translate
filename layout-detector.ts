// layout-detector.ts — FULL OVERHAULED VERSION (pipeline-based)
//
// Complete replacement using the contour-island pipeline:
//   1. Build occupancy grid
//   2. Detect text lines
//   3. Find vertical contour + artifacts
//   4. Find horizontal contour
//   5. Build islands
//   6. Merge touching islands (same font)
//   7. Split by font family/size
//   8. Split by indentation
//
// Public API is backward-compatible with the old LayoutDetector.

// Stage 0.2 (Q8): removed `@ts-nocheck`. The only `as any` cast that
// remained after removing the suppression was the `LayoutSettings` arg
// defaulting to `{} as LayoutSettings` — left as-is because LayoutSettings
// has many optional fields and the contour pipeline reads only a handful
// via `typeof` guards.

import { buildOccupancyMap, getFontFamily } from './OccupancyMap';
import { buildParagraphs } from './IslandBuilder';
import { buildSnapshot, SpanInfo } from './Snapshot';
import type { LayoutSettings } from './layout-modal';

export interface BoundingRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  paragraphs: HTMLSpanElement[][];
  columnAnalysis: {
    columns: BoundingRect[];
    edgeCols: BoundingRect[];
    gapCols: BoundingRect[];
    verticalGaps: number[];
    horizontalGaps: number[];
  };
  debugStrips?: any[];
  layoutRegions?: Array<{ top: number; bottom: number; left: number; right: number }>;
  gaps?: any[];
  regions?: any[];
}

export type { SpanInfo } from './Snapshot';
export { buildSnapshot, estimateLineHeight } from './Snapshot';
export type { LayoutSettings } from './layout-modal';

// Re-export VerticalStrip for backward compat (processing.ts imports it)
export interface VerticalStrip {
  left: number;
  right: number;
  top: number;
  bottom: number;
  confidence: number;
}

export class LayoutDetector {
  private readonly settings: any;

  constructor(options: LayoutSettings = {} as LayoutSettings) {
    this.settings = options;
  }

  public detectLayout(
    spans: HTMLSpanElement[],
    pageElement: HTMLElement | DOMRect
  ): LayoutResult {
    if (!spans || !Array.isArray(spans) || !pageElement) {
      return this.createEmptyResult();
    }

    const infoMap = buildSnapshot(spans);
    const pageRect = pageElement instanceof HTMLElement
      ? pageElement.getBoundingClientRect()
      : pageElement;

    return this.detectLayoutFromPrepared(spans, infoMap, pageRect);
  }

  public detectLayoutFromPrepared(
    spans: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): LayoutResult {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // P2-11 (Phase 17): removed `estimateLineHeight(infoMap, …)` call —
    // its return value was only consumed by the debugValidation log
    // below, so on production pages (debugValidation=false) the call
    // was pure waste. The debug log now reports `cellSize` (which is
    // what the pipeline actually uses) instead of `lineHeight`.

    // CRITICAL FIX: pipeline.mjs works in PAGE-RELATIVE coordinates.
    // getBoundingClientRect() returns VIEWPORT-ABSOLUTE coords (page offset baked in).
    // Without subtracting pageRect.left/top, span coords overflow grid dimensions
    // and clamp to the right/bottom edge → mass overmerging.
    //
    // Also: use style.fontName (PDF.js g_d0_fN class) instead of fontFamily CSS,
    // because PDF.js may resolve different PDF fonts to the same CSS family.
    const pageLeft = pageRect.left;
    const pageTop = pageRect.top;

    const rects = spans.map(s => {
      const info = infoMap.get(s);
      if (!info) return null;
      return {
        left:   info.rect.left   - pageLeft,
        top:    info.rect.top    - pageTop,
        right:  info.rect.right  - pageLeft,
        bottom: info.rect.bottom - pageTop,
        fontname: info.style.fontName || info.style.fontFamily || 'unknown',
        fontsize: info.style.fontSize,
        text: info.text || (s as any).textContent || '',
      };
    }).filter(Boolean) as any[];

    // CRITICAL FIX: pipeline.mjs uses CELL_SIZE = 4 hardcoded.
    // The user explicitly stated "контур - это 2хвысота ячейки, не line height".
    // Dynamic cellSize = floor(lineHeight/3) shifts the contour threshold
    // (2 × cellSize) and breaks the validated pipeline behavior.
    const settings: any = this.settings || {};
    const cellSize = (typeof settings.contourCellSize === 'number' && settings.contourCellSize > 0)
      ? settings.contourCellSize
      : 4;

    // Run the pipeline (page-relative coords now, so grid is consistent)
    const map = buildOccupancyMap(rects, pageRect.width, pageRect.height, cellSize);
    const paragraphs = buildParagraphs(map, rects, {
      indentThreshold: typeof settings.contourIndentThreshold === 'number' ? settings.contourIndentThreshold : undefined,
      fontSizeTolerance: typeof settings.contourFontSizeTolerance === 'number' ? settings.contourFontSizeTolerance : undefined,
      maxMergePasses: typeof settings.maxMergePasses === 'number' ? settings.maxMergePasses : (typeof settings.maxIterMerges === 'number' ? settings.maxIterMerges : undefined),
      // Stage 2.2 (Q6): pass the new exposed settings through.
      columnGapThreshold: typeof settings.columnGapThreshold === 'number' ? settings.columnGapThreshold : undefined,
      decorationThreshold: typeof settings.decorationThreshold === 'number' ? settings.decorationThreshold : undefined,
      // Bug 2 fix (Phase 17 P2-2 was incomplete): align preserveStyle with pdfjs path
      // (pdf-text-extractor.ts uses true). Without this, DOM and pdfjs paths produce
      // different paragraph splits for bold/italic text → different bboxes → duplicate overlays.
      preserveStyle: true,
    });

    // Map back to HTMLSpanElements.
    // CRITICAL FIX: paragraphs store page-relative coords in their span rects,
    // so we must compare against page-relative coords too.
    //
    // T3.4: O(n) matching via a rect-keyed index (was O(paragraphSpans ×
    // allSpans) with 4-coordinate fuzzy compares — millions of iterations
    // on main thread for pages with 1000+ spans). The rect of a given span
    // is identical in both arrays (they are built from the SAME infoMap in
    // this same synchronous pass), so exact key equality is safe; the old
    // 1px tolerance only masked nothing. Bonus fix: when two DOM spans
    // shared identical rects, the old loop matched the FIRST one twice
    // (duplicating its text in a paragraph) and lost the second — the
    // queue-per-key below assigns each span exactly once.
    const spanIndex = new Map<string, HTMLSpanElement[]>();
    for (const s of spans) {
      const info = infoMap.get(s);
      if (!info) continue;
      const key = [
        Math.round(info.rect.left - pageLeft),
        Math.round(info.rect.top - pageTop),
        Math.round(info.rect.right - pageLeft),
        Math.round(info.rect.bottom - pageTop),
      ].join(',');
      const bucket = spanIndex.get(key);
      if (bucket) bucket.push(s); else spanIndex.set(key, [s]);
    }

    const result: HTMLSpanElement[][] = paragraphs.map(para => {
      const paraSpans: HTMLSpanElement[] = [];
      for (const r of para.spans) {
        const key = [
          Math.round(r.left),
          Math.round(r.top),
          Math.round(r.right),
          Math.round(r.bottom),
        ].join(',');
        const bucket = spanIndex.get(key);
        if (bucket && bucket.length > 0) {
          paraSpans.push(bucket.shift()!);
        }
      }
      return paraSpans;
    }).filter(p => p.length > 0);

    // T-LD-F4: coverage self-check — every input span must land in exactly
    // one output paragraph. The sweep-up step (IslandBuilder Step 5.5)
    // guarantees this; the check turns any future regression into an
    // immediate, visible warning instead of silently missing text.
    // NOTE (hotfix): computed from the LOCAL `spans` argument (this method
    // is detectLayoutFromPrepared — the first version referenced
    // `textSpans`, a variable of the OUTER detectLayout wrapper, which
    // crashed every interactive translation with "textSpans is not
    // defined" — user-reported on page 3).
    {
      const totalChars = spans.reduce(
        (n, s) => n + ((s as any).textContent?.length ?? 0), 0);
      const gotChars = result.reduce(
        (n, ps) => n + ps.reduce(
          (m, s) => m + ((s as any).textContent?.length ?? 0), 0), 0);
      if (totalChars !== gotChars) {
        console.warn(
          `[LayoutDetector] COVERAGE: ${gotChars}/${totalChars} chars — ` +
          `${totalChars - gotChars} chars would be LOST. ` +
          `(spans=${spans.length}, paragraphs=${result.length})`
        );
      }
    }

    // Build column analysis (backward-compat).
    // CRITICAL FIX: convert page-relative paragraph coords → viewport-absolute
    // for downstream consumers (renderLayoutDebugOverlay subtracts pageRect.left).
    const columnAnalysis = this.buildColumnAnalysis(paragraphs, pageRect, pageLeft, pageTop);

    // Build layout regions — viewport-absolute for downstream overlay rendering.
    const layoutRegions = paragraphs.map(p => ({
      top: p.pxTop + pageTop, bottom: p.pxBottom + pageTop,
      left: p.pxLeft + pageLeft, right: p.pxRight + pageLeft,
    }));

    if (settings.debugValidation) {
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
      // eslint-disable-next-line no-console
      console.log('[LayoutDetector Pipeline]', {
        spans: spans.length,
        paragraphs: result.length,
        cellSize,
        pageW: Number(pageRect.width.toFixed(1)),
        pageH: Number(pageRect.height.toFixed(1)),
        elapsedMs: Number(elapsed.toFixed(2)),
      });
    }

    return {
      paragraphs: result,
      columnAnalysis,
      debugStrips: [],
      layoutRegions,
      gaps: [],
      regions: layoutRegions,
    };
  }

  private buildColumnAnalysis(
    paragraphs: any[],
    pageRect: DOMRect,
    pageLeft: number = 0,
    pageTop: number = 0
  ): LayoutResult['columnAnalysis'] {
    // paragraph coords are page-relative (0..pageW, 0..pageH).
    // We offset by pageLeft/pageTop to produce viewport-absolute column rects,
    // matching the old detector's coordinate system (so renderLayoutDebugOverlay
    // can subtract pageRect.left/top as before).
    const full: BoundingRect = {
      left: pageLeft,
      top: pageTop,
      right: pageLeft + pageRect.width,
      bottom: pageTop + pageRect.height,
      width: pageRect.width,
      height: pageRect.height,
    };

    if (!paragraphs.length) {
      return { columns: [full], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: [] };
    }

    // Find column gap from paragraphs (sort by page-relative left)
    const sorted = [...paragraphs].sort((a, b) => a.pxLeft - b.pxLeft);
    const columns: BoundingRect[] = [];
    const mergeTol = Math.max(1, pageRect.width * 0.005);

    for (const p of sorted) {
      // Convert page-relative → viewport-absolute
      const vLeft = p.pxLeft + pageLeft;
      const vTop = p.pxTop + pageTop;
      const vRight = p.pxRight + pageLeft;
      const vBottom = p.pxBottom + pageTop;
      const last = columns[columns.length - 1];
      if (!last || vLeft > last.right + mergeTol) {
        columns.push({
          left: vLeft, top: vTop, right: vRight, bottom: vBottom,
          width: vRight - vLeft, height: vBottom - vTop,
        });
      } else {
        last.left = Math.min(last.left, vLeft);
        last.right = Math.max(last.right, vRight);
        last.top = Math.min(last.top, vTop);
        last.bottom = Math.max(last.bottom, vBottom);
        last.width = last.right - last.left;
        last.height = last.bottom - last.top;
      }
    }

    const minColWidth = Math.max(1, pageRect.width * 0.03);
    let normalized = columns.filter(c => c.width >= minColWidth);
    if (!normalized.length) normalized = [full];

    const edgeCols = normalized.length >= 2
      ? [normalized[0], normalized[normalized.length - 1]]
      : [];
    const gapCols = normalized.length > 2 ? normalized.slice(1, -1) : [];

    const verticalGaps: number[] = [];
    for (let i = 1; i < normalized.length; i++) {
      const gap = normalized[i].left - normalized[i - 1].right;
      if (gap > 1) verticalGaps.push((normalized[i - 1].right + normalized[i].left) / 2);
    }

    return { columns: normalized, edgeCols, gapCols, verticalGaps, horizontalGaps: [] };
  }

  private createEmptyResult(): LayoutResult {
    return {
      paragraphs: [],
      columnAnalysis: { columns: [], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: [] },
      debugStrips: [], layoutRegions: [], gaps: [], regions: [],
    };
  }
}
