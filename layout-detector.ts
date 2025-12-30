// layout-detector.ts
// LayoutDetector with band-aware, column-wise ordering and noise-resilient strip handling.
// Now enhanced with a modular GridDetector for improved horizontal gap and grid detection.

import { GapDetector, GapAnalysis, VerticalStrip, HorizontalBand } from './GapDetector';
import { GridDetector, GridAnalysis } from './grid-detector'; // <-- NEW: Import GridDetector
import { ParagraphMerger } from './ParagraphMerger';
import { buildSnapshot, SpanInfo } from './Snapshot';
import { LayoutSettings, defaultLayoutSettings } from './layout-modal';

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
  layoutRegions?: Array<{ top: number; bottom: number; left: number; right: number }>;
}

export class LayoutDetector {
  private readonly settings: LayoutSettings;

  private gapDetector: GapDetector;
  private paragraphMerger: ParagraphMerger;
  private gridDetector: GridDetector; // <-- NEW: Add GridDetector instance

  constructor(options: Partial<LayoutSettings> = {}) {
    this.settings = { ...defaultLayoutSettings, ...options };
    this.gapDetector = new GapDetector();
    this.paragraphMerger = new ParagraphMerger(this.settings);
    this.gridDetector = new GridDetector(); // <-- NEW: Initialize GridDetector
  }

  private removeDuplicateSpans(paragraphs: HTMLSpanElement[][], infoMap: Map<HTMLSpanElement, SpanInfo>): HTMLSpanElement[][] {
    const seenSpans = new Set<string>(); // Use a unique identifier for each span
    const uniqueParagraphs: HTMLSpanElement[][] = [];

    for (const paragraph of paragraphs) {
      const uniqueSpans: HTMLSpanElement[] = [];
      
      for (const span of paragraph) {
        // Create a unique identifier based on position and content to handle spans that might be the same element
        const rect = infoMap.get(span)?.rect;
        if (!rect) {
          // If no rect info, use the element itself as identifier (fallback)
          if (!seenSpans.has(span.id || span.textContent || span.outerHTML || span.getBoundingClientRect().toString())) {
            seenSpans.add(span.id || span.textContent || span.outerHTML || span.getBoundingClientRect().toString());
            uniqueSpans.push(span);
          }
        } else {
          // Create a unique key based on coordinates and content
          const spanKey = `${rect.left}-${rect.top}-${rect.right}-${rect.bottom}-${span.textContent || ''}-${span.id || ''}`;
          if (!seenSpans.has(spanKey)) {
            seenSpans.add(spanKey);
            uniqueSpans.push(span);
          }
        }
      }
      
      if (uniqueSpans.length > 0) {
        uniqueParagraphs.push(uniqueSpans);
      }
    }

    return uniqueParagraphs;
  }

  // Alternative method: Remove duplicates within each paragraph and across all paragraphs
  private deduplicateParagraphs(paragraphs: HTMLSpanElement[][]): HTMLSpanElement[][] {
    const globalSeen = new Set<HTMLSpanElement>();
    const uniqueParagraphs: HTMLSpanElement[][] = [];

    for (const paragraph of paragraphs) {
      const paragraphSeen = new Set<HTMLSpanElement>();
      const uniqueSpans: HTMLSpanElement[] = [];

      for (const span of paragraph) {
        // Check both global and paragraph-level duplicates
        if (!globalSeen.has(span) && !paragraphSeen.has(span)) {
          globalSeen.add(span);
          paragraphSeen.add(span);
          uniqueSpans.push(span);
        }
      }

      if (uniqueSpans.length > 0) {
        uniqueParagraphs.push(uniqueSpans);
      }
    }

    return uniqueParagraphs;
  }

  public detectLayout(spans: HTMLSpanElement[], pageElement: HTMLElement): LayoutResult {
    if (!spans || !Array.isArray(spans) || !pageElement || !(pageElement instanceof HTMLElement)) {
      this.logDebug('Invalid input; returning empty result');
      return this.createEmptyResult();
    }

    const start = performance.now();

    // 1) Build a normalized snapshot for the entire run
    const infoMap = buildSnapshot(spans);
    const rects = [...infoMap.values()].map(i => i.rect);

    // Normalize page rect by DPR
    const dpr = window.devicePixelRatio || 1;
    const pr = pageElement.getBoundingClientRect();
    const pageRect = new DOMRect(pr.left / dpr, pr.top / dpr, pr.width / dpr, pr.height / dpr);

    // 2) Initial span-to-paragraph grouping (math-aware)
    let paragraphs = this.paragraphMerger.mergeIntoParagraphsFromInfos(infoMap);

    // 3) Estimate line height robustly (with a floor)
    const lineHeight = this.estimateLineHeightFromInfos(paragraphs, infoMap, pageRect);

    // 4) Original Gap detection
    const gapAnalysis = this.gapDetector.detectGapsFromRects(rects, pageRect);

    // 4.5) <-- NEW: Grid Detection Step -->
    // Use projection profiling to find major horizontal and vertical whitespace gutters.
    const gridAnalysis = this.gridDetector.detectGrid(rects, pageRect, lineHeight);
    
    // Convert detected horizontal grid lines into high-confidence HorizontalBands.
    const gridBands: HorizontalBand[] = [];
    if (gridAnalysis && gridAnalysis.horizontalLines.length > 0) {
      this.logDebug(`Grid detector found ${gridAnalysis.horizontalLines.length} horizontal lines.`);
      for (const line of gridAnalysis.horizontalLines) {
        // Model the gap itself as a "band" that acts as a barrier.
        // The height is based on a fraction of the line height to ensure it's not too thick.
        const gapHeight = lineHeight * (this.settings.bandMergeGapLineHeightMultiplier || 1);
        gridBands.push({
          y: line.position - gapHeight / 2,
          height: gapHeight,
          confidence: 0.95, // Assign a very high confidence to respect these gaps
        });
      }
    }
    
    // Filter vertical strips from the original gap detector (noise resilience)
    const verticalStripsAll: VerticalStrip[] = gapAnalysis.verticalStrips || [];
    const verticalStrips: VerticalStrip[] = verticalStripsAll
      .filter(s => s.confidence >= this.settings.minStripConfidence && (s.right - s.left) >= this.settings.minStripWidthPx)
      .sort((a, b) => ((a.left + a.right) / 2) - ((b.left + b.right) / 2));

    // Combine bands from the original detector and the new grid detector
    const horizontalBandsRaw: HorizontalBand[] = (gapAnalysis.horizontalBands || [])
        .filter(b => b.confidence >= this.settings.minBandConfidence);
    const combinedBands = [...horizontalBandsRaw, ...gridBands];

    // Build robust horizontal bands: union of raw bands, grid bands, and inferred bands from strips
    const layoutBands = this.buildLayoutBands(combinedBands, verticalStrips, pageRect, lineHeight);

    if (this.settings.debugValidation) {
      const filteredOut = verticalStripsAll.length - verticalStrips.length;
      this.logDebug(`Strips kept=${verticalStrips.length}, filtered=${filteredOut}, bands=${layoutBands.length}`);
    }

    // 5) Validate paragraphs against vertical strips
    paragraphs = this.paragraphMerger.validateParagraphsAgainstStripsFromInfos(
      paragraphs,
      infoMap,
      verticalStrips
    );

    // 6) Merge vertically stacked paragraphs within same column
    paragraphs = this.paragraphMerger.mergeParagraphsFromInfos(
      paragraphs,
      infoMap,
      lineHeight,
      verticalStrips,
      layoutBands
    );

    // 7) Iterative nested merge loop with post-merge validation
    let guard = 0;
    while (guard++ < this.settings.maxIterMerges) {
      const { paragraphs: mergedOnce, changed } = this.paragraphMerger.mergeNestedParagraphsOnceFromInfos(
        paragraphs,
        infoMap,
        verticalStrips,
        layoutBands
      );
      paragraphs = mergedOnce;
      if (!changed) break;

      paragraphs = this.paragraphMerger.validateParagraphsAgainstStripsFromInfos(
        paragraphs,
        infoMap,
        verticalStrips
      );

      paragraphs = this.paragraphMerger.mergeParagraphsFromInfos(
        paragraphs,
        infoMap,
        lineHeight,
        verticalStrips,
        layoutBands
      );
    }

    // 7.5) Final stacked-column pass to catch residual column-aligned splits
    paragraphs = this.paragraphMerger.mergeStackedColumnParagraphsFromInfos(
      paragraphs,
      infoMap,
      lineHeight,
      verticalStrips,
      layoutBands
    );

    // 8) Optional final inline-ligature stitching
    paragraphs = this.paragraphMerger.stitchInlineLigaturesFromInfos(paragraphs, infoMap);

    // 8.5) Band-aware, column-wise ordering to avoid interleaving when column count changes vertically
    if (layoutBands.length) {
      const perBandColumnRegions = this.buildPerBandColumnRegions(verticalStrips, pageRect, layoutBands);
      paragraphs = paragraphs.map(para =>
        this.orderParagraphByBandsAndColumns(para, infoMap, layoutBands, perBandColumnRegions)
      );
    }

    // 9) Deterministic order of spans within paragraphs
    paragraphs = paragraphs.map(para =>
      [...para].sort((a, b) => {
        const ra = infoMap.get(a)!.rect;
        const rb = infoMap.get(b)!.rect;
        return ra.top - rb.top || ra.left - rb.left;
      })
    );

    // 9.5) Remove duplicate spans to prevent duplicates across paragraphs
    paragraphs = this.deduplicateParagraphs(paragraphs);

    // 10) Build column analysis (back-compat)
    const columnAnalysis = this.analyzeColumns(paragraphs, infoMap, pageRect);

    this.logDebug(
      `Layout detection done in ${(performance.now() - start).toFixed(2)}ms`,
      { paragraphs: paragraphs.length, columns: columnAnalysis.columns.length }
    );

    return { paragraphs, columnAnalysis, layoutRegions: gapAnalysis.layoutSegments };
  }

  // -----------------------------
  // New Column Analysis Implementation (unchanged)
  // -----------------------------

  private average = (arr: number[]): number => 
    arr.reduce((a, b) => a + b, 0) / arr.length || 0;

  private getAverageLineHeight(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>
  ): number {
    const lineHeights: number[] = [];
    for (const p of paragraphs) {
      for (const span of p) {
        const info = infoMap.get(span);
        if (info) {
          lineHeights.push(info.rect.height);
        }
      }
    }
    return this.average(lineHeights);
  }

  private analyzeColumns(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): LayoutResult['columnAnalysis'] {
    const allSpans = paragraphs.flat();

    if (allSpans.length < 2) {
      return {
        columns: [{
          left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
          width: pageRect.width, height: pageRect.height
        }],
        edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: []
      };
    }

    const avgLineHeight = this.getAverageLineHeight(paragraphs, infoMap);
    const columnThreshold = avgLineHeight > 0 ? avgLineHeight * this.settings.columnThresholdLineHeightMultiplier : this.settings.columnThresholdFallback;

    const sortedByX = [...allSpans].sort((a, b) => {
      const rectA = infoMap.get(a)?.rect;
      const rectB = infoMap.get(b)?.rect;
      if (!rectA || !rectB) return 0;
      return rectA.left - rectB.left;
    });

    const columns: HTMLSpanElement[][] = [];
    if (sortedByX.length > 0) {
      columns.push([sortedByX[0]]);
      for (let i = 1; i < sortedByX.length; i++) {
        const currentSpan = sortedByX[i];
        const currentRect = infoMap.get(currentSpan)?.rect;
        if (!currentRect) continue;

        const lastColumn = columns[columns.length - 1];
        const lastSpanInColumn = lastColumn[lastColumn.length - 1];
        const lastRect = infoMap.get(lastSpanInColumn)?.rect;
        if (!lastRect) continue;

        if (Math.abs(currentRect.left - lastRect.left) < columnThreshold) {
          lastColumn.push(currentSpan);
        } else {
          columns.push([currentSpan]);
        }
      }
    }

    const columnRects: BoundingRect[] = columns.map(column => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const span of column) {
        const rect = infoMap.get(span)?.rect;
        if (rect) {
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      if (left === Infinity) {
        return {
          left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
          width: pageRect.width, height: pageRect.height
        };
      }
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    });

    const edgeCols = columnRects.length ? [columnRects[0], columnRects[columnRects.length - 1]] : [];
    const gapCols = columnRects.slice(1, -1);
    const verticalGaps: number[] = [];
    for (let i = 1; i < columnRects.length; i++) {
      verticalGaps.push((columnRects[i].left + columnRects[i-1].right) / 2);
    }

    return { columns: columnRects, edgeCols, gapCols, verticalGaps, horizontalGaps: [] };
  }

  // -----------------------------
  // Existing Helpers (unchanged)
  // -----------------------------

  private estimateLineHeightFromInfos(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): number {
    const gaps: number[] = [];
    for (const p of paragraphs) {
      if (p.length < 2) continue;
      const lines = [...p].map(s => infoMap.get(s)!.rect).sort((a, b) => a.top - b.top);
      for (let i = 1; i < lines.length; i++) {
        const gap = lines[i].top - lines[i - 1].bottom;
        if (gap > 0 && gap < pageRect.height * this.settings.maxGapFractionOfPageHeight) gaps.push(gap);
      }
    }

    let lhFromGaps: number | undefined;
    if (gaps.length >= this.settings.minGapsForTrim) {
      gaps.sort((a, b) => a - b);
      const trim = Math.floor(gaps.length * this.settings.trimPercent);
      const trimmed = gaps.slice(trim, gaps.length - trim);
      if (trimmed.length) {
        const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
        lhFromGaps = avg * this.settings.lineHeightFromAvgMultiplier;
      }
    }

    const fontSizes = [...infoMap.values()].map(i => i.style.fontSize).filter(v => v > 0);
    if (!fontSizes.length) return 16;
    fontSizes.sort((a, b) => a - b);
    const mid = Math.floor(fontSizes.length / 2);
    const median = fontSizes.length % 2 ? fontSizes[mid] : (fontSizes[mid - 1] + fontSizes[mid]) / 2;

    const floor = median * this.settings.lineHeightMultiplier * this.settings.floorMultiplier;
    const chosen = Math.max(lhFromGaps ?? 0, floor);
    return chosen || median * this.settings.lineHeightMultiplier;
  }

  private buildLayoutBands(
    bands: HorizontalBand[],
    strips: VerticalStrip[],
    pageRect: DOMRect,
    lineHeight: number
  ): HorizontalBand[] {
    const out: HorizontalBand[] = [];

    // Start with given bands (now includes grid bands)
    for (const b of bands) out.push({ ...b });

    // Infer bands from vertical strips: detect top and bottom extents of strip clusters
    if (strips.length) {
      let minTop = Infinity, maxBottom = -Infinity;
      for (const s of strips) {
        minTop = Math.min(minTop, s.top);
        maxBottom = Math.max(maxBottom, s.bottom);
      }
      if (minTop > pageRect.top + lineHeight * this.settings.bandTopBottomThresholdMultiplier) {
        out.push({ y: pageRect.top, height: minTop - pageRect.top, confidence: this.settings.inferredBandConfidence });
      }
      if (maxBottom < pageRect.bottom - lineHeight * this.settings.bandTopBottomThresholdMultiplier) {
        out.push({ y: maxBottom, height: pageRect.bottom - maxBottom, confidence: this.settings.inferredBandConfidence });
      }
    }

    // Merge overlapping/adjacent bands
    out.sort((a, b) => a.y - b.y);
    const merged: HorizontalBand[] = [];
    for (const b of out) {
      if (!merged.length) { merged.push({ ...b }); continue; }
      const last = merged[merged.length - 1];
      const lastBottom = last.y + last.height;
      if (b.y <= lastBottom + Math.max(this.settings.bandMergeGapPx, lineHeight * this.settings.bandMergeGapLineHeightMultiplier)) {
        const newBottom = Math.max(lastBottom, b.y + b.height);
        last.height = newBottom - last.y;
        last.confidence = Math.max(last.confidence, b.confidence);
      } else {
        merged.push({ ...b });
      }
    }
    return merged;
  }

  private buildPerBandColumnRegions(
    strips: VerticalStrip[],
    pageRect: DOMRect,
    bands: HorizontalBand[]
  ): Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }> {
    const results: Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }> = [];

    for (const band of bands) {
      const top = band.y;
      const bottom = band.y + band.height;
      const bandStrips = strips.filter(s => {
        const yOverlap = Math.min(bottom, s.bottom) - Math.max(top, s.top);
        const stripH = s.bottom - s.top;
        const overlapFrac = yOverlap / Math.max(1, stripH, bottom - top);
        return yOverlap > 0 && overlapFrac >= this.settings.minOverlapFracForBand;
      });
      const regions = this.buildColumnRegionsFromStrips(bandStrips, pageRect);
      results.push({ band: { top, bottom }, regions });
    }

    if (!bands.length) {
      results.push({
        band: { top: pageRect.top, bottom: pageRect.bottom },
        regions: this.buildColumnRegionsFromStrips(strips, pageRect)
      });
    }
    return results;
  }

  private buildColumnRegionsFromStrips(
    strips: VerticalStrip[],
    pageRect: DOMRect
  ): Array<{ left: number; right: number }> {
    if (!strips?.length) {
      return [{ left: pageRect.left, right: pageRect.right }];
    }
    const s = [...strips].sort((a, b) => ((a.left + a.right) / 2) - ((b.left + b.right) / 2));
    const xs: number[] = [pageRect.left];
    for (const st of s) {
      const mid = (st.left + st.right) / 2;
      if (mid > xs[xs.length - 1]) xs.push(mid);
    }
    xs.push(pageRect.right);

    const regions: Array<{ left: number; right: number }> = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const l = xs[i], r = xs[i + 1];
      if (r - l > this.settings.minRegionWidth) regions.push({ left: l, right: r });
    }
    return regions;
  }

  private orderParagraphByBandsAndColumns(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    bands: HorizontalBand[],
    perBandRegions: Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }>
  ): HTMLSpanElement[] {
    if (!paragraph.length) return paragraph;

    type Bucket = { spans: HTMLSpanElement[]; regions: Array<{ left: number; right: number }> };
    const bandBuckets: Bucket[] = perBandRegions.map(entry => ({ spans: [], regions: entry.regions }));

    for (const s of paragraph) {
      const r = infoMap.get(s)!.rect;
      const sTop = r.top, sBot = r.bottom;
      let bestIdx = -1, bestOverlap = 0;
      for (let i = 0; i < perBandRegions.length; i++) {
        const band = perBandRegions[i].band;
        const yOverlap = Math.min(sBot, band.bottom) - Math.max(sTop, band.top);
        if (yOverlap <= 0) continue;
        const overlap = yOverlap / Math.max(1, sBot - sTop, band.bottom - band.top);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        bandBuckets[bestIdx].spans.push(s);
      } else {
        if (perBandRegions.length) {
          let idx = 0, bestDist = Infinity;
          const sc = (sTop + sBot) / 2;
          for (let i = 0; i < perBandRegions.length; i++) {
            const band = perBandRegions[i].band;
            const bc = (band.top + band.bottom) / 2;
            const d = Math.abs(sc - bc);
            if (d < bestDist) { bestDist = d; idx = i; }
          }
          bandBuckets[idx].spans.push(s);
        } else {
          if (!bandBuckets.length) bandBuckets.push({ spans: [], regions: [{ left: -Infinity, right: Infinity }] });
          bandBuckets[0].spans.push(s);
        }
      }
    }

    const ordered: HTMLSpanElement[] = [];
    for (const bucket of bandBuckets) {
      if (!bucket.spans.length) continue;
      const regions = bucket.regions.length ? bucket.regions : [{ left: -Infinity, right: Infinity }];
      const colBuckets: HTMLSpanElement[][] = regions.map(() => []);

      for (const s of bucket.spans) {
        const r = infoMap.get(s)!.rect;
        const cx = (r.left + r.right) / 2;
        let idx = regions.findIndex(reg => cx >= reg.left && cx < reg.right);
        if (idx < 0) {
          idx = (cx < regions[0].left) ? 0 : regions.length - 1;
        }
        colBuckets[idx].push(s);
      }

      if (colBuckets.filter(b => b.length > 0).length <= 1) {
        const sorted = bucket.spans.slice().sort((a, b) => {
          const ra = infoMap.get(a)!.rect;
          const rb = infoMap.get(b)!.rect;
          return ra.top - rb.top || ra.left - rb.left;
        });
        ordered.push(...sorted);
        continue;
      }

      for (const b of colBuckets) {
        b.sort((a, b) => {
          const ra = infoMap.get(a)!.rect;
          const rb = infoMap.get(b)!.rect;
          return ra.top - rb.top || ra.left - rb.left;
        });
        ordered.push(...b);
      }
    }
    return ordered.length ? ordered : paragraph;
  }

  private createEmptyResult(): LayoutResult {
    return {
      paragraphs: [],
      columnAnalysis: {
        columns: [], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: []
      },
      layoutRegions: []
    };
  }

  private logDebug(message: string, details?: unknown) {
    if (!this.settings.debugValidation) return;
    if (details !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`[LayoutDetector] ${message}`, details);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[LayoutDetector] ${message}`);
    }
  }
}