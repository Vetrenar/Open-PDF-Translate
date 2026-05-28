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

export interface GapDetectorSettings {
  minStripConfidence: number;
  maxColumns: number;
  minGapWidthPx: number;
  bandStepFactor: number;
  minStripHeightFactor: number;
  centerXTolFactor: number;
  separatorBinPx: number;
  separatorMinClearRatio: number;
  separatorMinBandCoverage: number;
  separatorMinWidthLineHeightMultiplier: number;
  separatorEdgeMarginLineHeightMultiplier: number;
  separatorMergeGapBins: number;
  widthStabilityWeight: number;
  centerStabilityWeight: number;
  coverageWeight: number;
}

export const defaultGapDetectorSettings: GapDetectorSettings = {
  minStripConfidence: 0.6,
  maxColumns: 6,
  minGapWidthPx: 2,
  bandStepFactor: 0.75,
  minStripHeightFactor: 1.5,
  centerXTolFactor: 0.5,
  separatorBinPx: 3,
  separatorMinClearRatio: 0.72,
  separatorMinBandCoverage: 0.58,
  separatorMinWidthLineHeightMultiplier: 0.6,
  separatorEdgeMarginLineHeightMultiplier: 0.8,
  separatorMergeGapBins: 1,
  widthStabilityWeight: 0.25,
  centerStabilityWeight: 0.25,
  coverageWeight: 0.5,
};

/**
 * Rehauled GapDetector
 * - Works on normalized coordinates (DPR already divided)
 * - Uses y-banded occupancy to build robust vertical strips with confidence
 * - Exposes both classic verticalBoundaries and new verticalStrips
 */
export class GapDetector {
  private readonly settings: GapDetectorSettings;

  constructor(options: Partial<GapDetectorSettings> = {}) {
    this.settings = { ...defaultGapDetectorSettings, ...options };
  }

  /**
   * Compatibility API: Accepts DOM spans and page element, normalizes by DPR,
   * and delegates to detectGapsFromRects.
   */
  public detectGaps(spans: HTMLSpanElement[], pageElement: HTMLElement): GapAnalysis {
    const pageRectRaw = pageElement.getBoundingClientRect();
    const pageRect = new DOMRect(
      pageRectRaw.left,
      pageRectRaw.top,
      pageRectRaw.width,
      pageRectRaw.height
    );

    const rects: DOMRect[] = spans.map(s => {
      const r = s.getBoundingClientRect();
      return new DOMRect(r.left, r.top, r.width, r.height);
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

    // 3) Build vertical strips and horizontal bands using y-banded occupancy per layout segment
    const { verticalStrips, horizontalBands } = this.detectStripsAndBands(
      spanRects,
      pageRect,
      avgLineHeight,
      layoutSegments
    );

    // 4) Convert strips to classic verticalBoundaries (center x) for back-compat
    const verticalBoundaries: GapBoundary[] = verticalStrips.map(s => ({
      x: (s.left + s.right) / 2,
      confidence: s.confidence,
      width: Math.max(1, s.right - s.left),
      height: Math.max(1, s.bottom - s.top),
      segmentIndex: this.findSegmentIndexForStrip(s, layoutSegments)
    }))
      .filter(b => b.confidence >= this.settings.minStripConfidence)
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
    const step = Math.max(4, avgLineHeight * 0.55);
    const bins: Array<{ y1: number; y2: number; density: number }> = [];

    for (let y = pageRect.top; y < pageRect.bottom; y += step) {
      const y1 = y;
      const y2 = Math.min(pageRect.bottom, y + step);
      const active = spanRects
        .filter(r => r.bottom > y1 && r.top < y2)
        .map(r => ({
          left: Math.max(pageRect.left, r.left),
          right: Math.min(pageRect.right, r.right)
        }))
        .filter(r => r.right > r.left)
        .sort((a, b) => a.left - b.left);

      if (!active.length) {
        bins.push({ y1, y2, density: 0 });
        continue;
      }

      const merged: Array<{ left: number; right: number }> = [];
      for (const a of active) {
        if (!merged.length || a.left > merged[merged.length - 1].right + 0.5) {
          merged.push({ left: a.left, right: a.right });
        } else {
          merged[merged.length - 1].right = Math.max(merged[merged.length - 1].right, a.right);
        }
      }

      const covered = merged.reduce((sum, m) => sum + Math.max(0, m.right - m.left), 0);
      const density = clamp01(covered / Math.max(1, pageRect.width));
      bins.push({ y1, y2, density });
    }

    if (bins.length <= 2) {
      return [{
        top: pageRect.top,
        bottom: pageRect.bottom,
        left: pageRect.left,
        right: pageRect.right
      }];
    }

    const smooth = bins.map((b, i) => {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(bins.length - 1, i + 2); k++) {
        sum += bins[k].density;
        n++;
      }
      return n ? sum / n : b.density;
    });

    const lowDensityThreshold = 0.12;
    const minGapHeight = Math.max(10, avgLineHeight * 1.25);
    const splitYs: number[] = [];

    let runStart = -1;
    for (let i = 0; i < smooth.length; i++) {
      const isLow = smooth[i] <= lowDensityThreshold;
      if (isLow && runStart < 0) {
        runStart = i;
      } else if (!isLow && runStart >= 0) {
        const yTop = bins[runStart].y1;
        const yBottom = bins[i - 1].y2;
        if (yBottom - yTop >= minGapHeight) {
          splitYs.push((yTop + yBottom) / 2);
        }
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      const yTop = bins[runStart].y1;
      const yBottom = bins[bins.length - 1].y2;
      if (yBottom - yTop >= minGapHeight) {
        splitYs.push((yTop + yBottom) / 2);
      }
    }

    const ys = [pageRect.top, ...splitYs.filter(y => y > pageRect.top && y < pageRect.bottom), pageRect.bottom]
      .sort((a, b) => a - b);

    const minSegmentHeight = Math.max(36, avgLineHeight * 3.2);
    const segments: Array<{ top: number; bottom: number; left: number; right: number }> = [];
    for (let i = 0; i < ys.length - 1; i++) {
      const top = ys[i];
      const bottom = ys[i + 1];
      if (bottom - top < minSegmentHeight) continue;
      segments.push({ top, bottom, left: pageRect.left, right: pageRect.right });
    }

    if (!segments.length) {
      return [{
        top: pageRect.top,
        bottom: pageRect.bottom,
        left: pageRect.left,
        right: pageRect.right
      }];
    }

    // Merge adjacent tiny leftovers by absorbing them into nearest segment.
    const normalized: Array<{ top: number; bottom: number; left: number; right: number }> = [];
    for (const s of segments) {
      if (!normalized.length) {
        normalized.push({ ...s });
        continue;
      }
      const prev = normalized[normalized.length - 1];
      if (s.top - prev.bottom <= Math.max(2, avgLineHeight * 0.4)) {
        prev.bottom = s.bottom;
      } else {
        normalized.push({ ...s });
      }
    }
    normalized[0].top = pageRect.top;
    normalized[normalized.length - 1].bottom = pageRect.bottom;
    return normalized;
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
    avgLine: number,
    layoutSegments: Array<{ top: number; bottom: number; left: number; right: number }>
  ): { verticalStrips: VerticalStrip[]; horizontalBands: HorizontalBand[] } {
    const bandStep = Math.max(5, avgLine * this.settings.bandStepFactor);
    const xTol = Math.max(3, avgLine * this.settings.centerXTolFactor);
    const minGapWidth = Math.max(1, this.settings.minGapWidthPx);
    const xBin = Math.max(2, this.settings.separatorBinPx);
    const edgeMarginPx = Math.max(2, avgLine * this.settings.separatorEdgeMarginLineHeightMultiplier);
    const minSepWidth = Math.max(minGapWidth, avgLine * this.settings.separatorMinWidthLineHeightMultiplier);
    const segments = layoutSegments.length
      ? layoutSegments
      : [{ top: pageRect.top, bottom: pageRect.bottom, left: pageRect.left, right: pageRect.right }];
    const strips: VerticalStrip[] = [];

    for (const seg of segments) {
      const xStart = Math.max(pageRect.left, seg.left);
      const xEnd = Math.min(pageRect.right, seg.right);
      if (xEnd - xStart <= xBin) continue;

      const binCount = Math.max(1, Math.ceil((xEnd - xStart) / xBin));
      const clearCounts = new Array<number>(binCount).fill(0);
      const bands: Array<{ y1: number; y2: number; hasContent: boolean; freeMask: boolean[] }> = [];

      for (let y = seg.top; y < seg.bottom; y += bandStep) {
        const y1 = y;
        const y2 = Math.min(seg.bottom, y + bandStep);
        const active = spanRects.filter(r => r.bottom > y1 && r.top < y2);
        if (!active.length) {
          bands.push({ y1, y2, hasContent: false, freeMask: new Array<boolean>(binCount).fill(true) });
          continue;
        }

        const occ = new Array<boolean>(binCount).fill(false);
        for (const r of active) {
          const left = Math.max(xStart, r.left);
          const right = Math.min(xEnd, r.right);
          if (right <= left) continue;
          const b1 = Math.max(0, Math.floor((left - xStart) / xBin));
          const b2 = Math.min(binCount - 1, Math.ceil((right - xStart) / xBin) - 1);
          for (let bi = b1; bi <= b2; bi++) occ[bi] = true;
        }
        const freeMask = occ.map(v => !v);
        for (let bi = 0; bi < binCount; bi++) {
          if (freeMask[bi]) clearCounts[bi] += 1;
        }
        bands.push({ y1, y2, hasContent: true, freeMask });
      }

      const contentBands = bands.filter(b => b.hasContent);
      if (!contentBands.length) continue;
      const contentBandCount = contentBands.length;
      const clearRatio = clearCounts.map(c => c / contentBandCount);
      const edgeBins = Math.ceil(edgeMarginPx / xBin);
      const isSeparatorBin = clearRatio.map((r, bi) => {
        if (bi < edgeBins || bi >= binCount - edgeBins) return false;
        return r >= this.settings.separatorMinClearRatio;
      });

      const clusters: Array<{ start: number; end: number }> = [];
      let runStart = -1;
      let holeRun = 0;
      const maxHole = Math.max(0, Math.floor(this.settings.separatorMergeGapBins));
      for (let i = 0; i < isSeparatorBin.length; i++) {
        if (isSeparatorBin[i]) {
          if (runStart < 0) runStart = i;
          holeRun = 0;
          continue;
        }
        if (runStart >= 0) {
          holeRun++;
          if (holeRun > maxHole) {
            clusters.push({ start: runStart, end: i - holeRun });
            runStart = -1;
            holeRun = 0;
          }
        }
      }
      if (runStart >= 0) {
        clusters.push({ start: runStart, end: isSeparatorBin.length - 1 - holeRun });
      }

      for (const cl of clusters) {
        if (cl.end < cl.start) continue;
        const left = xStart + cl.start * xBin;
        const right = Math.min(xEnd, xStart + (cl.end + 1) * xBin);
        const width = right - left;
        if (width < minSepWidth) continue;

        let supportingBands = 0;
        const supportYs: Array<{ y1: number; y2: number }> = [];
        for (const b of contentBands) {
          const len = cl.end - cl.start + 1;
          let free = 0;
          for (let bi = cl.start; bi <= cl.end; bi++) if (b.freeMask[bi]) free++;
          const frac = free / Math.max(1, len);
          if (frac >= 0.85) {
            supportingBands++;
            supportYs.push({ y1: b.y1, y2: b.y2 });
          }
        }

        const coverage = supportingBands / contentBandCount;
        if (coverage < this.settings.separatorMinBandCoverage) continue;
        const meanClear = avg(clearRatio.slice(cl.start, cl.end + 1));
        const confidence = clamp01(meanClear * 0.6 + coverage * 0.4);
        if (confidence < this.settings.minStripConfidence) continue;

        const top = supportYs.length ? Math.min(...supportYs.map(v => v.y1)) : seg.top;
        const bottom = supportYs.length ? Math.max(...supportYs.map(v => v.y2)) : seg.bottom;
        if (bottom - top < avgLine * this.settings.minStripHeightFactor) continue;

        strips.push({ left, right, top, bottom, confidence });
      }
    }

    const horizontalBands: HorizontalBand[] = [];
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1];
      const curr = segments[i];
      const gap = curr.top - prev.bottom;
      if (gap <= 0) continue;
      const bandHeight = Math.max(gap, avgLine * 0.5);
      horizontalBands.push({
        y: prev.bottom,
        height: bandHeight,
        left: pageRect.left,
        right: pageRect.right,
        confidence: 0.9
      });
    }

    // Sort strips left-to-right and merge overlapping/adjacent similar strips for cleanliness.
    const mergedStrips = this.mergeSimilarStrips(strips, xTol);

    return { verticalStrips: mergedStrips, horizontalBands };
  }

  private findSegmentIndexForStrip(
    strip: VerticalStrip,
    layoutSegments: Array<{ top: number; bottom: number; left: number; right: number }>
  ): number {
    if (!layoutSegments.length) return 0;
    const cy = (strip.top + strip.bottom) / 2;
    const idx = layoutSegments.findIndex(s => cy >= s.top && cy <= s.bottom);
    return idx >= 0 ? idx : 0;
  }

  private mergeSimilarStrips(strips: VerticalStrip[], xMergeTol: number): VerticalStrip[] {
    if (!strips.length) return [];
    const sorted = [...strips].sort((a, b) => (a.left + a.right) / 2 - (b.left + b.right) / 2);
    const out: VerticalStrip[] = [];

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

    if (cols.length <= this.settings.maxColumns) return cols;
    return this.compressColumns(cols, this.settings.maxColumns);
  }

  private compressColumns(cols: SimpleRect[], maxColumns: number): SimpleRect[] {
    const out = [...cols];
    while (out.length > maxColumns && out.length > 1) {
      let bestIdx = 0;
      let bestWidth = Infinity;
      for (let i = 0; i < out.length - 1; i++) {
        const mergedWidth = out[i + 1].right - out[i].left;
        if (mergedWidth < bestWidth) {
          bestWidth = mergedWidth;
          bestIdx = i;
        }
      }
      const merged: SimpleRect = {
        left: out[bestIdx].left,
        top: out[bestIdx].top,
        right: out[bestIdx + 1].right,
        bottom: out[bestIdx].bottom,
        width: out[bestIdx + 1].right - out[bestIdx].left,
        height: out[bestIdx].height,
      };
      out.splice(bestIdx, 2, merged);
    }
    return out;
  }
}

// -----------------------------
// Small helpers
// -----------------------------

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function avg(a: number[]): number {
  if (!a.length) return 0;
  return a.reduce((s, v) => s + v, 0) / a.length;
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

function intervalOverlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}
