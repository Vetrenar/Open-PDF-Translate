// GapDetector.ts

export interface SimpleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GapBoundary {
  x: number;
  confidence: number;
  width: number;
  height: number;
  segmentIndex: number;
}

export interface VerticalStrip {
  left: number;
  right: number;
  top: number;
  bottom: number;
  confidence: number;
}

export interface HorizontalBand {
  y: number;
  height: number;
  left: number;
  right: number;
  confidence: number;
}

export interface GapAnalysis {
  verticalBoundaries: GapBoundary[];
  columns: SimpleRect[];
  layoutSegments: Array<{ top: number; bottom: number; left: number; right: number }>;
  verticalStrips?: VerticalStrip[];
  horizontalBands?: HorizontalBand[];
}

/**
 * Rehauled GapDetector
 * - Works on normalized coordinates (DPR already divided)
 * - Uses y-banded occupancy to build robust vertical strips with confidence
 * - Exposes both classic verticalBoundaries and new verticalStrips
 */
export class GapDetector {
  // Tuning parameters
  private readonly MIN_STRIP_CONFIDENCE = 0.6;
  private readonly MAX_COLUMNS = 6;
  private readonly MIN_GAP_WIDTH_PX = 2;           // Minimum horizontal gap width to consider
  private readonly BAND_STEP_FACTOR = 0.75;        // step = max(6, avgLineHeight * BAND_STEP_FACTOR)
  private readonly MIN_STRIP_HEIGHT_FACTOR = 1.5;  // min strip height in multiples of avgLineHeight
  private readonly CENTER_X_TOL_FACTOR = 0.5;      // x clustering tolerance in multiples of avgLineHeight
  private readonly WIDTH_STABILITY_WEIGHT = 0.25;
  private readonly CENTER_STABILITY_WEIGHT = 0.25;
  private readonly COVERAGE_WEIGHT = 0.5;

  /**
   * Compatibility API: Accepts DOM spans and page element, normalizes by DPR,
   * and delegates to detectGapsFromRects.
   */
  public detectGaps(spans: HTMLSpanElement[], pageElement: HTMLElement): GapAnalysis {
    const dpr = window.devicePixelRatio || 1;
    const pageRectRaw = pageElement.getBoundingClientRect();
    const pageRect = new DOMRect(
      pageRectRaw.left / dpr,
      pageRectRaw.top / dpr,
      pageRectRaw.width / dpr,
      pageRectRaw.height / dpr
    );

    const rects: DOMRect[] = spans.map(s => {
      const r = s.getBoundingClientRect();
      return new DOMRect(r.left / dpr, r.top / dpr, r.width / dpr, r.height / dpr);
    });

    return this.detectGapsFromRects(rects, pageRect);
  }

  /**
   * Preferred API: Accepts normalized span rects and page rect.
   */
  public detectGapsFromRects(spanRects: DOMRect[], pageRect: DOMRect): GapAnalysis {
    if (!spanRects || spanRects.length === 0) {
      return {
        verticalBoundaries: [],
        columns: [],
        layoutSegments: [],
        verticalStrips: [],
        horizontalBands: []
      };
    }

    // 1) Estimate average line height
    const avgLineHeight = this.estimateAverageLineHeight(spanRects);

    // 2) Segment the page by vertical layout (simple single segment by default)
    const layoutSegments = this.segmentVerticalLayouts(spanRects, pageRect, avgLineHeight);

    // 3) Build vertical strips and horizontal bands using y-banded occupancy
    const { verticalStrips, horizontalBands } = this.detectStripsAndBands(
      spanRects,
      pageRect,
      avgLineHeight
    );

    // 4) Convert strips to classic verticalBoundaries (center x) for back-compat
    const verticalBoundaries: GapBoundary[] = verticalStrips.map(s => ({
      x: (s.left + s.right) / 2,
      confidence: s.confidence,
      width: Math.max(1, s.right - s.left),
      height: pageRect.height,
      segmentIndex: 0
    }))
      .filter(b => b.confidence >= this.MIN_STRIP_CONFIDENCE)
      .sort((a, b) => a.x - b.x);

    // 5) Create columns based on boundaries
    const columns = this.createColumnsFromBoundaries(verticalBoundaries, pageRect);

    return {
      verticalBoundaries,
      columns,
      layoutSegments,
      verticalStrips,
      horizontalBands
    };
  }

  // -----------------------------
  // Core computations
  // -----------------------------

  private estimateAverageLineHeight(spanRects: DOMRect[]): number {
    if (!spanRects || spanRects.length === 0) return 15;
    const heights = spanRects.map(r => r.height).filter(h => h > 3);
    if (!heights.length) return 15;
    heights.sort((a, b) => a - b);
    const mid = Math.floor(heights.length / 2);
    return heights.length % 2 ? heights[mid] : (heights[mid - 1] + heights[mid]) / 2;
  }

  /**
   * Simple single-segment implementation.
   * Keep API so you can later swap with a more advanced segmenter if needed.
   */
  private segmentVerticalLayouts(
    spanRects: DOMRect[],
    pageRect: DOMRect,
    avgLineHeight: number
  ): Array<{ top: number; bottom: number; left: number; right: number }> {
    return [{
      top: pageRect.top,
      bottom: pageRect.bottom,
      left: pageRect.left,
      right: pageRect.right
    }];
  }

  /**
   * Detect vertical strips (gaps) via y-banded occupancy and optional horizontal bands.
   * Steps:
   *  - Sweep the page in horizontal bands (y-axis), collect occupied x-intervals
   *  - Invert to gaps within each band
   *  - Cluster gaps across adjacent bands by center x
   *  - Compute strip confidence from coverage and stability
   */
  private detectStripsAndBands(
    spanRects: DOMRect[],
    pageRect: DOMRect,
    avgLine: number
  ): { verticalStrips: VerticalStrip[]; horizontalBands: HorizontalBand[] } {
    const bandStep = Math.max(6, avgLine * this.BAND_STEP_FACTOR);
    const bands: Array<{ y1: number; y2: number; gaps: Array<{ left: number; right: number }> }> = [];

    // 1) Build y-bands and inverted occupancy as gap intervals
    for (let y = pageRect.top; y < pageRect.bottom; y += bandStep) {
      const y1 = y;
      const y2 = Math.min(pageRect.bottom, y + bandStep);

      // Collect spans intersecting this band
      const active = spanRects.filter(r => r.bottom > y1 && r.top < y2);
      // If none, entire width is a gap
      if (active.length === 0) {
        bands.push({ y1, y2, gaps: [{ left: pageRect.left, right: pageRect.right }] });
        continue;
      }

      // Merge occupied intervals [left,right] across active rects
      const occ = active.map(r => ({ left: r.left, right: r.right }))
        .sort((a, b) => a.left - b.left);

      const mergedOcc: Array<{ left: number; right: number }> = [];
      for (const o of occ) {
        if (!mergedOcc.length || o.left > mergedOcc[mergedOcc.length - 1].right) {
          mergedOcc.push({ left: o.left, right: o.right });
        } else {
          mergedOcc[mergedOcc.length - 1].right = Math.max(mergedOcc[mergedOcc.length - 1].right, o.right);
        }
      }

      // Invert to gaps within pageRect
      const gaps: Array<{ left: number; right: number }> = [];
      let cursor = pageRect.left;
      for (const m of mergedOcc) {
        if (m.left - cursor >= this.MIN_GAP_WIDTH_PX) {
          gaps.push({ left: cursor, right: m.left });
        }
        cursor = Math.max(cursor, m.right);
      }
      if (pageRect.right - cursor >= this.MIN_GAP_WIDTH_PX) {
        gaps.push({ left: cursor, right: pageRect.right });
      }

      bands.push({ y1, y2, gaps });
    }

    // 2) Cluster gaps across bands by center x proximity
    const xTol = Math.max(4, avgLine * this.CENTER_X_TOL_FACTOR);
    type Cluster = {
      centers: number[];
      widths: number[];
      lefts: number[];
      rights: number[];
      y1s: number[];
      y2s: number[];
    };
    const clusters: Cluster[] = [];

    for (const band of bands) {
      const { y1, y2 } = band;
      for (const g of band.gaps) {
        const width = g.right - g.left;
        if (width < this.MIN_GAP_WIDTH_PX) continue;

        const center = (g.left + g.right) / 2;
        let placed = false;

        // Try to assign to an existing cluster by proximity to last center
        for (const c of clusters) {
          const lastCenter = c.centers[c.centers.length - 1];
          if (Math.abs(center - lastCenter) <= xTol) {
            c.centers.push(center);
            c.widths.push(width);
            c.lefts.push(g.left);
            c.rights.push(g.right);
            c.y1s.push(y1);
            c.y2s.push(y2);
            placed = true;
            break;
          }
        }

        // Create a new cluster if no match
        if (!placed) {
          clusters.push({
            centers: [center],
            widths: [width],
            lefts: [g.left],
            rights: [g.right],
            y1s: [y1],
            y2s: [y2]
          });
        }
      }
    }

    // 3) Convert clusters into vertical strips with confidence
    const minStripHeight = avgLine * this.MIN_STRIP_HEIGHT_FACTOR;
    const totalBands = bands.length;
    const strips: VerticalStrip[] = [];

    for (const c of clusters) {
      if (!c.centers.length) continue;

      // Strip geometry via medians (robust)
      const left = median(c.lefts);
      const right = median(c.rights);
      const top = Math.min(...c.y1s);
      const bottom = Math.max(...c.y2s);
      const height = bottom - top;

      if (height < minStripHeight) continue;

      // Coverage: how many bands participated
      const coverage = approxUniqueBandCount(c.y1s) / totalBands;

      // Stability: width & center stdev normalized by their medians
      const widthStd = stddev(c.widths);
      const centerStd = stddev(c.centers);
      const normWidthStd = widthStd / Math.max(1, median(c.widths));
      const normCenterStd = centerStd / Math.max(1, median(c.centers));

      // Confidence: weighted combo
      let confidence =
        this.COVERAGE_WEIGHT * coverage +
        this.WIDTH_STABILITY_WEIGHT * (1 - clamp01(normWidthStd)) +
        this.CENTER_STABILITY_WEIGHT * (1 - clamp01(normCenterStd));
      confidence = clamp01(confidence);

      if (confidence >= this.MIN_STRIP_CONFIDENCE) {
        strips.push({ left, right, top, bottom, confidence });
      }
    }

    // 4) Optional: Horizontal band detection (kept empty for now; can implement similar banded-x occupancy)
    const horizontalBands: HorizontalBand[] = [];

    // 5) Sort strips left-to-right and merge overlapping/adjacent similar strips for cleanliness
    const mergedStrips = this.mergeSimilarStrips(strips);

    return { verticalStrips: mergedStrips, horizontalBands };
  }

  private mergeSimilarStrips(strips: VerticalStrip[]): VerticalStrip[] {
    if (!strips.length) return [];
    const sorted = [...strips].sort((a, b) => (a.left + a.right) / 2 - (b.left + b.right) / 2);
    const out: VerticalStrip[] = [];
    const xMergeTol = 3; // small pixel tolerance for merging nearly identical strips

    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
      const s = sorted[i];
      const centersClose = Math.abs(((cur.left + cur.right) / 2) - ((s.left + s.right) / 2)) <= xMergeTol;
      const verticalOverlap = Math.min(cur.bottom, s.bottom) - Math.max(cur.top, s.top) > 0;

      if (centersClose && verticalOverlap) {
        // Merge ranges and average confidence
        cur.left = Math.min(cur.left, s.left);
        cur.right = Math.max(cur.right, s.right);
        cur.top = Math.min(cur.top, s.top);
        cur.bottom = Math.max(cur.bottom, s.bottom);
        cur.confidence = Math.max(cur.confidence, s.confidence);
      } else {
        out.push(cur);
        cur = { ...s };
      }
    }
    out.push(cur);
    return out;
  }

  private createColumnsFromBoundaries(boundaries: GapBoundary[], pageRect: DOMRect): SimpleRect[] {
    if (!boundaries?.length) return [{
      left: pageRect.left,
      top: pageRect.top,
      right: pageRect.right,
      bottom: pageRect.bottom,
      width: pageRect.width,
      height: pageRect.height
    }];

    const sorted = [...boundaries].sort((a, b) => a.x - b.x);
    const cols: SimpleRect[] = [];

    let prevX = pageRect.left;
    for (const b of sorted) {
      const x = Math.max(pageRect.left, Math.min(pageRect.right, b.x));
      if (x > prevX) {
        cols.push({
          left: prevX,
          top: pageRect.top,
          right: x,
          bottom: pageRect.bottom,
          width: x - prevX,
          height: pageRect.height
        });
        prevX = x;
      }
    }

    if (prevX < pageRect.right) {
      cols.push({
        left: prevX,
        top: pageRect.top,
        right: pageRect.right,
        bottom: pageRect.bottom,
        width: pageRect.right - prevX,
        height: pageRect.height
      });
    }

    return cols.slice(0, this.MAX_COLUMNS);
  }
}

// -----------------------------
// Small helpers
// -----------------------------

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(a: number[]): number {
  if (!a.length) return 0;
  if (a.length === 1) return 0;
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const variance = a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (a.length - 1);
  return Math.sqrt(variance);
}

function approxUniqueBandCount(y1s: number[]): number {
  // Count approximate unique bands by rounding each y1 to integer and using a set
  const s = new Set<number>();
  for (const y of y1s) s.add(Math.round(y));
  return s.size;
}