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
  debugStrips?: VerticalStrip[];
  layoutRegions?: Array<{ top: number; bottom: number; left: number; right: number }>;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export class LayoutDetector {
  private readonly settings: LayoutSettings;

  private gapDetector: GapDetector;
  private paragraphMerger: ParagraphMerger;
  private gridDetector: GridDetector; // <-- NEW: Add GridDetector instance

  constructor(options: Partial<LayoutSettings> = {}) {
    this.settings = { ...defaultLayoutSettings, ...options };
    this.gapDetector = new GapDetector({
      minStripConfidence: this.settings.minStripConfidence,
      maxColumns: this.settings.gapMaxColumns,
      minGapWidthPx: this.settings.gapMinGapWidthPx,
      bandStepFactor: this.settings.gapBandStepFactor,
      minStripHeightFactor: this.settings.gapMinStripHeightFactor,
      centerXTolFactor: this.settings.gapCenterXTolFactor,
      separatorBinPx: this.settings.verticalSeparatorBinPx,
      separatorMinClearRatio: this.settings.verticalSeparatorMinClearRatio,
      separatorMinBandCoverage: this.settings.verticalSeparatorMinBandCoverage,
      separatorMinWidthLineHeightMultiplier: this.settings.verticalSeparatorMinWidthLineHeightMultiplier,
      separatorEdgeMarginLineHeightMultiplier: this.settings.verticalSeparatorEdgeMarginLineHeightMultiplier,
      separatorMergeGapBins: this.settings.verticalSeparatorMergeGapBins,
    });
    this.paragraphMerger = new ParagraphMerger(this.settings);
    this.gridDetector = new GridDetector({
      minHorizontalGapLineHeightMultiplier: this.settings.gridMinHorizontalGapLineHeightMultiplier,
      minVerticalGapLineHeightMultiplier: this.settings.gridMinVerticalGapLineHeightMultiplier,
      edgeMarginLineHeightMultiplier: this.settings.gridEdgeMarginLineHeightMultiplier,
      maxVerticalGaps: this.settings.gridMaxVerticalGaps,
      smoothRadius: this.settings.gridSmoothRadius,
      projectionProfileThreshold: this.settings.gridProjectionProfileThreshold,
    }); // <-- NEW: Initialize GridDetector
  }

  private readonly REGION_TABLE = 'table';
  private readonly REGION_COLUMNS = 'columns';
  private readonly REGION_FLOW = 'flow';

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

  // Remove duplicate span refs within each paragraph only.
  private deduplicateParagraphs(paragraphs: HTMLSpanElement[][]): HTMLSpanElement[][] {
    const uniqueParagraphs: HTMLSpanElement[][] = [];

    for (const paragraph of paragraphs) {
      const paragraphSeen = new Set<HTMLSpanElement>();
      const uniqueSpans: HTMLSpanElement[] = [];

      for (const span of paragraph) {
        if (!paragraphSeen.has(span)) {
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

    if (!this.settings.useModeEnsemble) {
      return this.detectLayoutSingle(spans, pageElement);
    }

    const ensembleResult = this.detectLayoutWithModeEnsemble(spans, pageElement);
    return ensembleResult ?? this.detectLayoutSingle(spans, pageElement);
  }

  private detectLayoutSingle(spans: HTMLSpanElement[], pageElement: HTMLElement): LayoutResult {
    if (!spans || !Array.isArray(spans) || !pageElement || !(pageElement instanceof HTMLElement)) {
      this.logDebug('Invalid input; returning empty result');
      return this.createEmptyResult();
    }

    const infoMap = buildSnapshot(spans);
    const pr = pageElement.getBoundingClientRect();
    const pageRect = new DOMRect(pr.left, pr.top, pr.width, pr.height);
    return this.detectLayoutFromPrepared(infoMap, pageRect);
  }

  private detectLayoutFromPrepared(
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): LayoutResult {
    const start = performance.now();
    const rects = [...infoMap.values()].map(i => i.rect);

    // 2) Initial span-to-paragraph grouping (math-aware)
    let paragraphs = this.paragraphMerger.mergeIntoParagraphsFromInfos(infoMap);
    this.logStage('initial-merge', paragraphs, infoMap);

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
        const rawThickness = Math.max(0, line.thickness || 0);
        const minHardGap = Math.max(3, lineHeight * 0.9);
        if (rawThickness < minHardGap) continue;

        // Keep grid bands conservative to avoid over-separating normal paragraph flow.
        const gapHeight = Math.max(
          1.5,
          Math.min(
            lineHeight * 0.9,
            Math.max(rawThickness, lineHeight * Math.max(0.35, this.settings.bandMergeGapLineHeightMultiplier))
          )
        );
        gridBands.push({
          y: line.position - gapHeight / 2,
          height: gapHeight,
          left: pageRect.left,
          right: pageRect.right,
          confidence: 0.82,
        });
      }
    }
    
    // Filter vertical strips from the original gap detector (noise resilience)
    const verticalStripsAll: VerticalStrip[] = gapAnalysis.verticalStrips || [];
    const verticalStrips: VerticalStrip[] = verticalStripsAll
      .filter(s => s.confidence >= this.settings.minStripConfidence && (s.right - s.left) >= this.settings.minStripWidthPx)
      .sort((a, b) => ((a.left + a.right) / 2) - ((b.left + b.right) / 2));

    // Augment strips with robust vertical guides from projection-based grid detection.
    const enhancedStrips = this.enhanceStripsWithGrid(verticalStrips, gridAnalysis, pageRect, lineHeight);

    // Combine bands from the original detector and the new grid detector
    const horizontalBandsRaw: HorizontalBand[] = (gapAnalysis.horizontalBands || [])
        .filter(b => b.confidence >= this.settings.minBandConfidence);
    const combinedBands = [...horizontalBandsRaw, ...gridBands];

    // Build robust horizontal bands: union of raw bands, grid bands, and inferred bands from strips
    const layoutBands = this.buildLayoutBands(combinedBands, enhancedStrips, pageRect, lineHeight);
    if (this.settings.debugValidation) {
      this.logDebug('separator-summary', {
        lineHeight: Number(lineHeight.toFixed(2)),
        strips: enhancedStrips.length,
        bands: layoutBands.length,
        gridHorizontal: gridAnalysis?.horizontalLines?.length || 0,
        gridVertical: gridAnalysis?.verticalLines?.length || 0
      });
    }

    if (this.settings.debugValidation) {
      const filteredOut = verticalStripsAll.length - verticalStrips.length;
      this.logDebug(`Strips kept=${verticalStrips.length}, filtered=${filteredOut}, bands=${layoutBands.length}`);
    }

    // 5) Validate paragraphs against vertical strips
    paragraphs = this.paragraphMerger.validateParagraphsAgainstStripsFromInfos(
      paragraphs,
      infoMap,
      enhancedStrips,
      lineHeight,
      pageRect.width
    );
    this.logStage('post-strip-validate', paragraphs, infoMap);

    // 6) Merge vertically stacked paragraphs within same column
    paragraphs = this.paragraphMerger.mergeParagraphsFromInfos(
      paragraphs,
      infoMap,
      lineHeight,
      enhancedStrips,
      layoutBands,
      pageRect.width
    );
    this.logStage('post-general-merge', paragraphs, infoMap);

    // 7) Iterative nested merge loop with post-merge validation
    let guard = 0;
    while (guard++ < this.settings.maxIterMerges) {
      const { paragraphs: mergedOnce, changed } = this.paragraphMerger.mergeNestedParagraphsOnceFromInfos(
        paragraphs,
        infoMap,
        enhancedStrips,
        layoutBands,
        pageRect.width
      );
      paragraphs = mergedOnce;
      if (!changed) break;

      paragraphs = this.paragraphMerger.validateParagraphsAgainstStripsFromInfos(
        paragraphs,
        infoMap,
        enhancedStrips,
        lineHeight,
        pageRect.width
      );
      this.logStage(`iter-${guard}-post-validate`, paragraphs, infoMap);

      paragraphs = this.paragraphMerger.mergeParagraphsFromInfos(
        paragraphs,
        infoMap,
        lineHeight,
        enhancedStrips,
        layoutBands,
        pageRect.width
      );
      this.logStage(`iter-${guard}-post-merge`, paragraphs, infoMap);
    }

    // 7.5) Final stacked-column pass to catch residual column-aligned splits
    paragraphs = this.paragraphMerger.mergeStackedColumnParagraphsFromInfos(
      paragraphs,
      infoMap,
      lineHeight,
      enhancedStrips,
      layoutBands,
      pageRect.width
    );
    this.logStage('post-stacked-merge', paragraphs, infoMap);

    // 8) Optional final inline-ligature stitching
    paragraphs = this.paragraphMerger.stitchInlineLigaturesFromInfos(paragraphs, infoMap);
    this.logStage('post-inline-stitch', paragraphs, infoMap);

    // 8.25 + 8.5 + 9) Multi-profile pass:
    // evaluate flow / columns / tables and keep the best profile per paragraph.
    paragraphs = this.optimizeParagraphsWithProfiles(
      paragraphs,
      infoMap,
      pageRect,
      enhancedStrips,
      layoutBands,
      lineHeight
    );
    this.logStage('post-profile-opt', paragraphs, infoMap);

    // 9.5) Remove duplicate spans to prevent duplicates across paragraphs
    paragraphs = this.deduplicateParagraphs(paragraphs);
    this.logStage('post-dedup', paragraphs, infoMap);

    // 10) Build column analysis (back-compat)
    const columnAnalysis = this.analyzeColumns(paragraphs, infoMap, pageRect, enhancedStrips);

    this.logDebug(
      `Layout detection done in ${(performance.now() - start).toFixed(2)}ms`,
      { paragraphs: paragraphs.length, columns: columnAnalysis.columns.length }
    );

    return {
      paragraphs,
      columnAnalysis,
      debugStrips: enhancedStrips,
      layoutRegions: gapAnalysis.layoutSegments
    };
  }

  private logStage(
    stage: string,
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>
  ) {
    if (!this.settings.debugValidation) return;
    const sizes = paragraphs.map(p => p.length).filter(n => n > 0);
    const totalSpans = sizes.reduce((a, b) => a + b, 0);
    const avgSize = sizes.length ? totalSpans / sizes.length : 0;
    const maxSize = sizes.length ? Math.max(...sizes) : 0;
    this.logDebug(`stage:${stage}`, {
      paragraphs: paragraphs.length,
      totalSpans,
      avgParagraphSize: Number(avgSize.toFixed(2)),
      maxParagraphSize: maxSize,
      uniqueSpanRefs: new Set(paragraphs.flat()).size,
      trackedSpans: infoMap.size
    });
  }

  private detectLayoutWithModeEnsemble(spans: HTMLSpanElement[], pageElement: HTMLElement): LayoutResult | null {
    const profiles = this.getEnsembleProfiles();
    if (!profiles.length) return null;

    const candidates: Array<{ name: string; result: LayoutResult; features: number[]; intrinsic: number; score: number }> = [];
    const infoMap = buildSnapshot(spans);
    const pr = pageElement.getBoundingClientRect();
    const pageRect = new DOMRect(pr.left, pr.top, pr.width, pr.height);
    const rectMap = new Map<HTMLSpanElement, DOMRect>();
    for (const [s, info] of infoMap.entries()) {
      rectMap.set(s, info.rect);
    }

    for (const profile of profiles) {
      try {
        const detector = new LayoutDetector({
          ...this.settings,
          ...profile.overrides,
          useModeEnsemble: false,
          debugValidation: false,
        });
        const result = detector.detectLayoutFromPrepared(infoMap, pageRect);
        const features = this.buildCandidateFeatureVector(result, spans.length, rectMap, pageRect);
        const intrinsic = this.computeIntrinsicCandidateScore(result, spans.length, rectMap, pageRect);
        candidates.push({ name: profile.name, result, features, intrinsic, score: 0 });
      } catch (e) {
        this.logDebug(`Ensemble profile "${profile.name}" failed`, e);
      }
    }

    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].result;

    for (let i = 0; i < candidates.length; i++) {
      let distSum = 0;
      let distN = 0;
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        distSum += this.euclideanDistance(candidates[i].features, candidates[j].features);
        distN++;
      }
      const avgDist = distN ? distSum / distN : 0;
      const consensusScore = 1 / (1 + avgDist);
      const intrinsicNorm = clamp01(0.5 + candidates[i].intrinsic * 0.5);
      candidates[i].score = consensusScore * 0.65 + intrinsicNorm * 0.35;
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    const second = candidates[1];
    const chosen =
      second && top.name !== 'default' && Math.abs(top.score - second.score) < 0.008
        ? (candidates.find(c => c.name === 'default') || top)
        : top;

    if (this.settings.debugValidation) {
      this.logDebug(
        'Ensemble ranking',
        candidates.map(c => ({ mode: c.name, score: Number(c.score.toFixed(4)), intrinsic: Number(c.intrinsic.toFixed(4)) }))
      );
      this.logDebug(`Ensemble selected mode: ${chosen.name}`);
    }
    return chosen.result;
  }

  private getEnsembleProfiles(): Array<{ name: string; overrides: Partial<LayoutSettings> }> {
    return [
      { name: 'default', overrides: {} },
      {
        name: 'columns',
        overrides: {
          minStripConfidence: Math.min(this.settings.minStripConfidence, 0.4),
          minStripWidthPx: Math.min(this.settings.minStripWidthPx, 2),
          maxIterMerges: Math.min(this.settings.maxIterMerges, 4),
          gapMinGapWidthPx: Math.min(this.settings.gapMinGapWidthPx, 1),
          gapBandStepFactor: Math.min(this.settings.gapBandStepFactor, 0.55),
          gapMinStripHeightFactor: Math.min(this.settings.gapMinStripHeightFactor, 1.0),
          gapCenterXTolFactor: Math.max(this.settings.gapCenterXTolFactor, 0.85),
          gridMinVerticalGapLineHeightMultiplier: Math.min(this.settings.gridMinVerticalGapLineHeightMultiplier, 0.45),
          gridEdgeMarginLineHeightMultiplier: Math.min(this.settings.gridEdgeMarginLineHeightMultiplier, 0.5),
          gridProjectionProfileThreshold: Math.min(this.settings.gridProjectionProfileThreshold, 0.45),
          pmMinStripConfidenceSplit: Math.min(this.settings.pmMinStripConfidenceSplit, 0.35),
          pmMinStripWidthPx: Math.min(this.settings.pmMinStripWidthPx, 2),
          pmMinStripOverlapFrac: Math.min(this.settings.pmMinStripOverlapFrac, 0.35),
          pmGeneralMergeVerticalGapMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMultiplier, 0.95),
          pmGeneralMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMaxMultiplier, 1.35),
          pmStackedMergeVerticalGapMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMultiplier, 0.95),
          pmStackedMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMaxMultiplier, 1.35),
          pmSplitBoundaryDedupTol: Math.min(this.settings.pmSplitBoundaryDedupTol, 0.16),
          pmSplitInterWordGapTol: Math.min(this.settings.pmSplitInterWordGapTol, 0.8),
          pmSplitColumnGapTol: Math.min(this.settings.pmSplitColumnGapTol, 1.55),
          profileColumnSpanScoreWeight: Math.max(this.settings.profileColumnSpanScoreWeight, 2.6),
          profileColumnWinMargin: Math.min(this.settings.profileColumnWinMargin, 0.1),
          profileRegionColumnsDensityRatioMin: Math.min(this.settings.profileRegionColumnsDensityRatioMin, 0.48),
          profileRegionColumnsCostBias: Math.min(this.settings.profileRegionColumnsCostBias, -0.75),
          profileRegionFlowCostBias: Math.max(this.settings.profileRegionFlowCostBias, 0.85),
        }
      },
      {
        name: 'table',
        overrides: {
          minStripConfidence: Math.min(this.settings.minStripConfidence, 0.45),
          minStripWidthPx: Math.min(this.settings.minStripWidthPx, 2),
          maxIterMerges: Math.min(this.settings.maxIterMerges, 5),
          gapMinGapWidthPx: Math.min(this.settings.gapMinGapWidthPx, 1),
          gapBandStepFactor: Math.min(this.settings.gapBandStepFactor, 0.55),
          gapMinStripHeightFactor: Math.min(this.settings.gapMinStripHeightFactor, 1.0),
          gapCenterXTolFactor: Math.max(this.settings.gapCenterXTolFactor, 0.7),
          gridMinHorizontalGapLineHeightMultiplier: Math.min(this.settings.gridMinHorizontalGapLineHeightMultiplier, 1.0),
          gridMinVerticalGapLineHeightMultiplier: Math.min(this.settings.gridMinVerticalGapLineHeightMultiplier, 0.5),
          gridProjectionProfileThreshold: Math.min(this.settings.gridProjectionProfileThreshold, 0.5),
          pmMinStripConfidenceSplit: Math.min(this.settings.pmMinStripConfidenceSplit, 0.45),
          pmMinStripWidthPx: Math.min(this.settings.pmMinStripWidthPx, 2),
          pmMinStripOverlapFrac: Math.min(this.settings.pmMinStripOverlapFrac, 0.4),
          pmGeneralMergeVerticalGapMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMultiplier, 1.0),
          pmGeneralMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMaxMultiplier, 1.4),
          pmStackedMergeVerticalGapMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMultiplier, 1.0),
          pmStackedMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMaxMultiplier, 1.4),
          pmSplitBoundaryDedupTol: Math.min(this.settings.pmSplitBoundaryDedupTol, 0.15),
          pmSplitInterWordGapTol: Math.min(this.settings.pmSplitInterWordGapTol, 0.75),
          pmSplitColumnGapTol: Math.min(this.settings.pmSplitColumnGapTol, 1.6),
          profileTableMinParagraphSpans: Math.min(this.settings.profileTableMinParagraphSpans, 6),
          profileTableMinRows: Math.min(this.settings.profileTableMinRows, 2),
          profileTableMinDistinctCols: Math.min(this.settings.profileTableMinDistinctCols, 2),
          profileTableMinMultiCellRowRatio: Math.min(this.settings.profileTableMinMultiCellRowRatio, 0.5),
          profileTableMinAvgCellsPerRow: Math.min(this.settings.profileTableMinAvgCellsPerRow, 1.7),
          profileTableBoundaryMinRepeatsAbs: Math.min(this.settings.profileTableBoundaryMinRepeatsAbs, 1),
          profileTableBoundaryMinRepeatsRowFrac: Math.min(this.settings.profileTableBoundaryMinRepeatsRowFrac, 0.3),
          profileRegionTableDensityRatioMin: Math.min(this.settings.profileRegionTableDensityRatioMin, 0.55),
          profileRegionTableOccupancyMin: Math.min(this.settings.profileRegionTableOccupancyMin, 0.03),
        }
      },
      {
        name: 'paragraphs',
        overrides: {
          minStripConfidence: Math.min(this.settings.minStripConfidence, 0.5),
          minStripWidthPx: Math.min(this.settings.minStripWidthPx, 2.5),
          maxIterMerges: Math.min(this.settings.maxIterMerges, 6),
          gapMinGapWidthPx: Math.min(this.settings.gapMinGapWidthPx, 1.2),
          gapBandStepFactor: Math.min(this.settings.gapBandStepFactor, 0.6),
          gapMinStripHeightFactor: Math.min(this.settings.gapMinStripHeightFactor, 1.1),
          gridMinHorizontalGapLineHeightMultiplier: Math.min(this.settings.gridMinHorizontalGapLineHeightMultiplier, 1.1),
          gridMinVerticalGapLineHeightMultiplier: Math.min(this.settings.gridMinVerticalGapLineHeightMultiplier, 0.55),
          gridProjectionProfileThreshold: Math.min(this.settings.gridProjectionProfileThreshold, 0.6),
          pmMinStripConfidenceSplit: Math.min(this.settings.pmMinStripConfidenceSplit, 0.5),
          pmMinStripWidthPx: Math.min(this.settings.pmMinStripWidthPx, 2),
          pmGeneralMergeVerticalGapMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMultiplier, 0.95),
          pmGeneralMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMaxMultiplier, 1.5),
          pmStackedMergeVerticalGapMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMultiplier, 0.95),
          pmStackedMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMaxMultiplier, 1.5),
          pmSplitBoundaryDedupTol: Math.min(this.settings.pmSplitBoundaryDedupTol, 0.18),
          pmSplitInterWordGapTol: Math.min(this.settings.pmSplitInterWordGapTol, 0.85),
          pmSplitColumnGapTol: Math.min(this.settings.pmSplitColumnGapTol, 1.8),
          profileRegionFlowCostBias: Math.min(this.settings.profileRegionFlowCostBias, 0.05),
        }
      },
      {
        name: 'split',
        overrides: {
          minStripConfidence: Math.min(this.settings.minStripConfidence, 0.3),
          minStripWidthPx: Math.min(this.settings.minStripWidthPx, 1),
          maxIterMerges: Math.min(this.settings.maxIterMerges, 1),
          gapMinGapWidthPx: Math.min(this.settings.gapMinGapWidthPx, 1),
          gapBandStepFactor: Math.min(this.settings.gapBandStepFactor, 0.45),
          gapMinStripHeightFactor: Math.min(this.settings.gapMinStripHeightFactor, 0.75),
          gapCenterXTolFactor: Math.max(this.settings.gapCenterXTolFactor, 0.9),
          gridMinHorizontalGapLineHeightMultiplier: Math.min(this.settings.gridMinHorizontalGapLineHeightMultiplier, 0.75),
          gridMinVerticalGapLineHeightMultiplier: Math.min(this.settings.gridMinVerticalGapLineHeightMultiplier, 0.35),
          gridEdgeMarginLineHeightMultiplier: Math.min(this.settings.gridEdgeMarginLineHeightMultiplier, 0.45),
          gridProjectionProfileThreshold: Math.min(this.settings.gridProjectionProfileThreshold, 0.35),
          pmMinStripConfidenceSplit: Math.min(this.settings.pmMinStripConfidenceSplit, 0.25),
          pmMinStripWidthPx: Math.min(this.settings.pmMinStripWidthPx, 1),
          pmMinStripOverlapFrac: Math.min(this.settings.pmMinStripOverlapFrac, 0.2),
          pmGeneralMergeVerticalGapMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMultiplier, 0.7),
          pmGeneralMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmGeneralMergeVerticalGapMaxMultiplier, 1.0),
          pmStackedMergeVerticalGapMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMultiplier, 0.7),
          pmStackedMergeVerticalGapMaxMultiplier: Math.min(this.settings.pmStackedMergeVerticalGapMaxMultiplier, 1.0),
          pmSplitBoundaryDedupTol: Math.min(this.settings.pmSplitBoundaryDedupTol, 0.06),
          pmSplitInterWordGapTol: Math.min(this.settings.pmSplitInterWordGapTol, 0.5),
          pmSplitColumnGapTol: Math.min(this.settings.pmSplitColumnGapTol, 1.05),
          profileTableMaxFragmentationRatio: Math.max(this.settings.profileTableMaxFragmentationRatio, 0.98),
        }
      }
    ];
  }

  private buildCandidateFeatureVector(
    result: LayoutResult,
    spanCount: number,
    rectMap: Map<HTMLSpanElement, DOMRect>,
    pageRect: DOMRect
  ): number[] {
    const paraSizes = result.paragraphs.map(p => p.length).filter(n => n > 0);
    const paraAvg = paraSizes.length ? paraSizes.reduce((a, b) => a + b, 0) / paraSizes.length : 0;
    const paraVar = paraSizes.length
      ? paraSizes.reduce((a, b) => a + Math.pow(b - paraAvg, 2), 0) / paraSizes.length
      : 0;
    const paraStd = Math.sqrt(paraVar);
    const regions = result.layoutRegions || [];
    const cols = result.columnAnalysis.columns || [];
    const vGaps = result.columnAnalysis.verticalGaps || [];
    const regionUse = this.computeRegionUsage(regions, rectMap);
    const paraAreaNorm = this.computeAvgParagraphAreaNorm(result.paragraphs, rectMap, pageRect);

    return [
      clamp01(result.paragraphs.length / Math.max(1, Math.sqrt(spanCount) * 1.8)),
      clamp01(paraAvg / Math.max(1, spanCount * 0.3)),
      clamp01(paraStd / Math.max(1, paraAvg * 2)),
      clamp01(cols.length / 6),
      clamp01(regions.length / 8),
      clamp01(vGaps.length / 8),
      clamp01(regionUse),
      clamp01(paraAreaNorm),
    ];
  }

  private computeIntrinsicCandidateScore(
    result: LayoutResult,
    spanCount: number,
    rectMap: Map<HTMLSpanElement, DOMRect>,
    pageRect: DOMRect
  ): number {
    const unique = new Set<HTMLSpanElement>();
    let refs = 0;
    for (const p of result.paragraphs) {
      for (const s of p) {
        refs++;
        unique.add(s);
      }
    }

    const coverage = spanCount > 0 ? unique.size / spanCount : 0;
    const duplicatePenalty = spanCount > 0 ? Math.max(0, refs - unique.size) / spanCount : 0;
    const fragRatio = unique.size > 0 ? result.paragraphs.length / unique.size : 0;
    const fragPenalty = clamp01((fragRatio - 0.42) * 0.9);
    const emptyRegionPenalty = 1 - this.computeRegionUsage(result.layoutRegions || [], rectMap);
    const paraAreaNorm = this.computeAvgParagraphAreaNorm(result.paragraphs, rectMap, pageRect);
    const tinyParaPenalty = clamp01((0.006 - paraAreaNorm) * 45);

    return coverage * 1.1 - duplicatePenalty * 0.9 - fragPenalty * 0.6 - emptyRegionPenalty * 0.45 - tinyParaPenalty * 0.35;
  }

  private computeRegionUsage(
    regions: Array<{ top: number; bottom: number; left: number; right: number }>,
    rectMap: Map<HTMLSpanElement, DOMRect>
  ): number {
    if (!regions.length) return 1;
    let occupied = 0;
    for (const rg of regions) {
      const hasSpan = [...rectMap.values()].some(r => {
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        return cx >= rg.left && cx <= rg.right && cy >= rg.top && cy <= rg.bottom;
      });
      if (hasSpan) occupied++;
    }
    return occupied / regions.length;
  }

  private computeAvgParagraphAreaNorm(
    paragraphs: HTMLSpanElement[][],
    rectMap: Map<HTMLSpanElement, DOMRect>,
    pageRect: DOMRect
  ): number {
    if (!paragraphs.length) return 0;
    const pageArea = Math.max(1, pageRect.width * pageRect.height);
    let sum = 0;
    let n = 0;
    for (const p of paragraphs) {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const s of p) {
        const r = rectMap.get(s);
        if (!r) continue;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      }
      if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) continue;
      sum += Math.max(1, (right - left) * (bottom - top)) / pageArea;
      n++;
    }
    return n ? sum / n : 0;
  }

  private euclideanDistance(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum / n);
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
    pageRect: DOMRect,
    strips: VerticalStrip[] = []
  ): LayoutResult['columnAnalysis'] {
    const allSpans = paragraphs.flat();
    const cleanStrips = this.sanitizeStripsForColumnBoundaries(strips, pageRect);
    const stripGapHints = this.extractVerticalGapHintsFromStrips(cleanStrips, pageRect);
    const lineConsensus = this.inferColumnsFromLineGapConsensus(allSpans, infoMap, pageRect);
    let gapHints = this.mergeVerticalGapHints(
      stripGapHints,
      lineConsensus.gapHints,
      pageRect
    );

    if (allSpans.length < 2) {
      return this.buildColumnAnalysisFromRects(
        [{
          left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
          width: pageRect.width, height: pageRect.height
        }],
        pageRect,
        gapHints
      );
    }

    const stripDriven = this.analyzeColumnsFromStrips(allSpans, infoMap, pageRect, cleanStrips, gapHints);
    if (stripDriven) return stripDriven;

    if (lineConsensus.columns.length >= 2) {
      return this.buildColumnAnalysisFromRects(lineConsensus.columns, pageRect, gapHints);
    }

    const fallbackColumns = this.inferColumnsFromLargestGap(allSpans, infoMap, pageRect);
    if (fallbackColumns.length >= 2) {
      return this.buildColumnAnalysisFromRects(fallbackColumns, pageRect, gapHints);
    }

    return this.buildColumnAnalysisFromRects(
      [{
        left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
        width: pageRect.width, height: pageRect.height
      }],
      pageRect,
      gapHints
    );
  }

  private analyzeColumnsFromStrips(
    allSpans: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect,
    strips: VerticalStrip[],
    stripGapHints: number[] = []
  ): LayoutResult['columnAnalysis'] | null {
    const cleanStrips = strips?.length ? strips : [];
    if (!cleanStrips.length) return null;

    const regions = this.buildColumnRegionsFromStrips(cleanStrips, pageRect, true);
    if (regions.length < 2) return null;

    const buckets: HTMLSpanElement[][] = regions.map(() => []);
    for (const span of allSpans) {
      const rect = infoMap.get(span)?.rect;
      if (!rect) continue;
      const cx = (rect.left + rect.right) / 2;
      let idx = regions.findIndex(r => cx >= r.left && cx < r.right);
      if (idx < 0) idx = cx < regions[0].left ? 0 : regions.length - 1;
      buckets[idx].push(span);
    }

    const columnRects: BoundingRect[] = [];
    const minSpansPerColumn = Math.max(2, Math.floor(allSpans.length * 0.02));
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const spans = buckets[i];
      if (!spans.length) continue;
      if (spans.length < minSpansPerColumn) continue;
      const spanRects: DOMRect[] = [];
      for (const span of spans) {
        const r = infoMap.get(span)?.rect;
        if (!r) continue;
        spanRects.push(r);
      }
      const rect = this.buildRobustRectFromSpanRects(spanRects, region, pageRect);
      if (!rect) continue;
      columnRects.push(rect);
    }

    const analysis = this.buildColumnAnalysisFromRects(columnRects, pageRect, stripGapHints);
    return analysis.columns.length >= 2 ? analysis : null;
  }

  private inferColumnsFromLargestGap(
    allSpans: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): BoundingRect[] {
    const rects = allSpans
      .map(span => infoMap.get(span)?.rect)
      .filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0);

    if (rects.length < 8) return [];

    const widths = rects.map(r => r.width).filter(w => w > 0).sort((a, b) => a - b);
    const medianWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
    const minGap = Math.max(pageRect.width * 0.03, medianWidth * 0.75, 14);
    const interiorMargin = Math.max(pageRect.width * 0.12, 36);

    const sorted = [...rects].sort((a, b) => a.left - b.left || a.top - b.top);
    let bestGap = 0;
    let splitX: number | null = null;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.left - prev.right;
      if (gap < minGap) continue;

      const cx = prev.right + gap / 2;
      if (cx < pageRect.left + interiorMargin || cx > pageRect.right - interiorMargin) continue;

      if (gap > bestGap) {
        bestGap = gap;
        splitX = cx;
      }
    }

    if (splitX === null) return [];

    const leftRects = rects.filter(r => ((r.left + r.right) / 2) <= splitX!);
    const rightRects = rects.filter(r => ((r.left + r.right) / 2) > splitX!);
    const minSideSpans = Math.max(5, Math.floor(rects.length * 0.15));
    if (leftRects.length < minSideSpans || rightRects.length < minSideSpans) return [];

    const leftCol = this.buildRobustRectFromSpanRects(
      leftRects,
      { left: pageRect.left, right: splitX },
      pageRect
    );
    const rightCol = this.buildRobustRectFromSpanRects(
      rightRects,
      { left: splitX, right: pageRect.right },
      pageRect
    );
    if (!leftCol || !rightCol) return [];

    const minColumnWidth = Math.max(pageRect.width * 0.15, 90);
    if (leftCol.width < minColumnWidth || rightCol.width < minColumnWidth) return [];

    return [leftCol, rightCol].sort((a, b) => a.left - b.left);
  }

  private inferColumnsFromLineGapConsensus(
    allSpans: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): { columns: BoundingRect[]; gapHints: number[] } {
    const rects = allSpans
      .map(span => infoMap.get(span)?.rect)
      .filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0);

    if (rects.length < 12) return { columns: [], gapHints: [] };

    const pageW = Math.max(1, pageRect.width);
    const widths = rects.map(r => r.width).sort((a, b) => a - b);
    const heights = rects.map(r => r.height).sort((a, b) => a - b);
    const medianWidth = widths[Math.floor(widths.length / 2)] || 0;
    const medianHeight = heights[Math.floor(heights.length / 2)] || 0;
    const rowTol = Math.max(2, medianHeight * 0.65);
    const minGap = Math.max(pageW * 0.028, medianWidth * 0.85, 12);
    const interiorMargin = Math.max(28, pageW * 0.11);

    const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
    const rows: DOMRect[][] = [];
    let current: DOMRect[] = [];
    let currentTop = Number.NaN;
    for (const r of sorted) {
      if (!current.length) {
        current = [r];
        currentTop = r.top;
        continue;
      }
      if (Math.abs(r.top - currentTop) <= rowTol) {
        current.push(r);
      } else {
        rows.push(current);
        current = [r];
        currentTop = r.top;
      }
    }
    if (current.length) rows.push(current);
    if (!rows.length) return { columns: [], gapHints: [] };

    const candidates: number[] = [];
    for (const row of rows) {
      if (row.length < 2) continue;
      const rSorted = [...row].sort((a, b) => a.left - b.left);
      let bestGap = 0;
      let bestCenter = Number.NaN;
      for (let i = 1; i < rSorted.length; i++) {
        const prev = rSorted[i - 1];
        const currRect = rSorted[i];
        const gap = currRect.left - prev.right;
        if (gap < minGap) continue;
        const cx = prev.right + gap / 2;
        if (cx <= pageRect.left + interiorMargin || cx >= pageRect.right - interiorMargin) continue;
        if (gap > bestGap) {
          bestGap = gap;
          bestCenter = cx;
        }
      }
      if (isFinite(bestCenter)) candidates.push(bestCenter);
    }

    if (!candidates.length) return { columns: [], gapHints: [] };

    const sortedCandidates = candidates.sort((a, b) => a - b);
    const clusterTol = Math.max(8, pageW * 0.02);
    const clusters: Array<{ center: number; count: number }> = [];
    for (const c of sortedCandidates) {
      const last = clusters[clusters.length - 1];
      if (!last || Math.abs(c - last.center) > clusterTol) {
        clusters.push({ center: c, count: 1 });
      } else {
        last.center = (last.center * last.count + c) / (last.count + 1);
        last.count += 1;
      }
    }

    const minVotes = Math.max(3, Math.floor(rows.length * 0.12));
    let bestCluster = clusters
      .filter(c => c.count >= minVotes)
      .sort((a, b) => b.count - a.count || a.center - b.center)[0];
    if (!bestCluster) {
      bestCluster = clusters
        .filter(c => c.count >= 2)
        .sort((a, b) => b.count - a.count || a.center - b.center)[0];
    }
    if (!bestCluster) return { columns: [], gapHints: [] };

    const splitX = bestCluster.center;
    const gapHints = [splitX];

    const leftRects = rects.filter(r => ((r.left + r.right) / 2) <= splitX);
    const rightRects = rects.filter(r => ((r.left + r.right) / 2) > splitX);
    const minSideSpans = Math.max(6, Math.floor(rects.length * 0.12));
    if (leftRects.length < minSideSpans || rightRects.length < minSideSpans) {
      return { columns: [], gapHints };
    }

    const leftCol = this.buildRobustRectFromSpanRects(
      leftRects,
      { left: pageRect.left, right: splitX },
      pageRect
    );
    const rightCol = this.buildRobustRectFromSpanRects(
      rightRects,
      { left: splitX, right: pageRect.right },
      pageRect
    );
    if (!leftCol || !rightCol) return { columns: [], gapHints };

    const minColumnWidth = Math.max(pageRect.width * 0.14, 85);
    if (leftCol.width < minColumnWidth || rightCol.width < minColumnWidth) {
      return { columns: [], gapHints };
    }

    return { columns: [leftCol, rightCol].sort((a, b) => a.left - b.left), gapHints };
  }

  private sanitizeStripsForColumnBoundaries(
    strips: VerticalStrip[],
    pageRect: DOMRect
  ): VerticalStrip[] {
    if (!strips?.length) return [];

    const pageW = Math.max(1, pageRect.width);
    const pageH = Math.max(1, pageRect.height);
    const edgeMargin = Math.max(14, pageW * 0.06);
    const maxStripWidth = Math.max(this.settings.minStripWidthPx * 2.2, pageW * 0.28);
    const minStripHeight = pageH * 0.12;
    const minConfidence = Math.max(0.38, this.settings.minStripConfidence - 0.18);

    const candidates = strips
      .filter(s => {
        const width = s.right - s.left;
        const height = s.bottom - s.top;
        const center = (s.left + s.right) / 2;
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return false;
        if (width < this.settings.minStripWidthPx || width > maxStripWidth) return false;
        if (height < minStripHeight) return false;
        if (s.confidence < minConfidence) return false;
        if (center <= pageRect.left + edgeMargin || center >= pageRect.right - edgeMargin) return false;
        return true;
      })
      .sort((a, b) => ((a.left + a.right) / 2) - ((b.left + b.right) / 2));

    if (!candidates.length) return [];

    const merged: VerticalStrip[] = [];
    const centerTol = Math.max(3, pageW * 0.008);
    for (const s of candidates) {
      const c = (s.left + s.right) / 2;
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push({ ...s });
        continue;
      }

      const lc = (last.left + last.right) / 2;
      if (Math.abs(c - lc) <= centerTol) {
        last.left = Math.min(last.left, s.left);
        last.right = Math.max(last.right, s.right);
        last.top = Math.min(last.top, s.top);
        last.bottom = Math.max(last.bottom, s.bottom);
        last.confidence = Math.max(last.confidence, s.confidence);
      } else {
        merged.push({ ...s });
      }
    }

    const deduped: VerticalStrip[] = [];
    const minBoundaryGap = Math.max(8, pageW * 0.03);
    for (const s of merged) {
      const c = (s.left + s.right) / 2;
      const last = deduped[deduped.length - 1];
      if (!last) {
        deduped.push({ ...s });
        continue;
      }

      const lc = (last.left + last.right) / 2;
      if (c - lc < minBoundaryGap) {
        const lastW = Math.max(1, last.right - last.left);
        const currW = Math.max(1, s.right - s.left);
        const scoreLast = last.confidence * 1.2 - (lastW / pageW);
        const scoreCurr = s.confidence * 1.2 - (currW / pageW);
        if (scoreCurr > scoreLast) {
          deduped[deduped.length - 1] = { ...s };
        }
        continue;
      }
      deduped.push({ ...s });
    }

    return deduped.sort((a, b) => a.left - b.left);
  }

  private extractVerticalGapHintsFromStrips(
    strips: VerticalStrip[],
    pageRect: DOMRect
  ): number[] {
    if (!strips?.length) return [];
    const interiorMargin = Math.max(12, pageRect.width * 0.04);
    const centers = strips
      .map(s => (s.left + s.right) / 2)
      .filter(c => c > pageRect.left + interiorMargin && c < pageRect.right - interiorMargin)
      .sort((a, b) => a - b);
    return this.dedupeSortedNumbers(centers, Math.max(4, pageRect.width * 0.012));
  }

  private mergeVerticalGapHints(
    baseGaps: number[],
    hintGaps: number[],
    pageRect: DOMRect
  ): number[] {
    const interiorMargin = Math.max(10, pageRect.width * 0.03);
    const merged = [...baseGaps, ...hintGaps]
      .filter(g => isFinite(g) && g > pageRect.left + interiorMargin && g < pageRect.right - interiorMargin)
      .sort((a, b) => a - b);
    return this.dedupeSortedNumbers(merged, Math.max(4, pageRect.width * 0.012));
  }

  private dedupeSortedNumbers(values: number[], tolerance: number): number[] {
    if (!values.length) return [];
    const out: number[] = [];
    for (const v of values) {
      const last = out[out.length - 1];
      if (last === undefined || v - last > tolerance) {
        out.push(v);
      } else {
        out[out.length - 1] = (last + v) / 2;
      }
    }
    return out;
  }

  private percentileSorted(values: number[], q: number): number {
    if (!values.length) return 0;
    const clamped = Math.min(1, Math.max(0, q));
    if (values.length === 1) return values[0];
    const idx = (values.length - 1) * clamped;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return values[lo];
    const t = idx - lo;
    return values[lo] * (1 - t) + values[hi] * t;
  }

  private buildRobustRectFromSpanRects(
    rects: DOMRect[],
    region: { left: number; right: number },
    pageRect: DOMRect
  ): BoundingRect | null {
    if (!rects.length) return null;
    const union = this.unionRects(rects);
    if (!union) return null;

    const regionLeft = Math.max(pageRect.left, Math.min(region.left, region.right));
    const regionRight = Math.min(pageRect.right, Math.max(region.left, region.right));
    if (regionRight <= regionLeft) return null;

    let left = Math.max(regionLeft, union.left);
    let right = Math.min(regionRight, union.right);
    let top = Math.max(pageRect.top, union.top);
    let bottom = Math.min(pageRect.bottom, union.bottom);

    if (rects.length >= 8) {
      const lefts = rects.map(r => r.left).sort((a, b) => a - b);
      const rights = rects.map(r => r.right).sort((a, b) => a - b);
      const widths = rects.map(r => Math.max(1, r.width)).sort((a, b) => a - b);
      const medianWidth = this.percentileSorted(widths, 0.5);
      const padX = Math.max(1.5, medianWidth * 0.22);

      const robustLeft = this.percentileSorted(lefts, 0.06) - padX * 0.45;
      const robustRight = this.percentileSorted(rights, 0.9) + padX;
      left = Math.max(left, robustLeft);
      right = Math.min(right, robustRight);
    }

    const minWidth = Math.max(8, union.width * 0.5);
    if (right - left < minWidth) {
      left = Math.max(regionLeft, union.left);
      right = Math.min(regionRight, union.right);
    }

    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom) || right <= left || bottom <= top) {
      return null;
    }

    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  }

  private buildColumnAnalysisFromRects(
    rects: BoundingRect[],
    pageRect: DOMRect,
    gapHints: number[] = []
  ): LayoutResult['columnAnalysis'] {
    const full: BoundingRect = {
      left: pageRect.left,
      top: pageRect.top,
      right: pageRect.right,
      bottom: pageRect.bottom,
      width: pageRect.width,
      height: pageRect.height
    };

    if (!rects?.length) {
      return {
        columns: [full],
        edgeCols: [],
        gapCols: [],
        verticalGaps: this.mergeVerticalGapHints([], gapHints, pageRect),
        horizontalGaps: []
      };
    }

    const valid = rects
      .filter(r => isFinite(r.left) && isFinite(r.top) && isFinite(r.right) && isFinite(r.bottom) && r.right > r.left && r.bottom > r.top)
      .map(r => ({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.right - r.left,
        height: r.bottom - r.top
      }))
      .sort((a, b) => a.left - b.left || a.top - b.top);

    if (!valid.length) {
      return {
        columns: [full],
        edgeCols: [],
        gapCols: [],
        verticalGaps: this.mergeVerticalGapHints([], gapHints, pageRect),
        horizontalGaps: []
      };
    }

    const merged: BoundingRect[] = [];
    const mergeTol = Math.max(1, pageRect.width * 0.0035);
    for (const col of valid) {
      const last = merged[merged.length - 1];
      if (!last || col.left > last.right + mergeTol) {
        merged.push({ ...col });
        continue;
      }
      last.left = Math.min(last.left, col.left);
      last.top = Math.min(last.top, col.top);
      last.right = Math.max(last.right, col.right);
      last.bottom = Math.max(last.bottom, col.bottom);
      last.width = last.right - last.left;
      last.height = last.bottom - last.top;
    }

    const minColWidth = Math.max(this.settings.minRegionWidth, pageRect.width * 0.035);
    let normalized = merged.filter(c => c.width >= minColWidth);
    if (!normalized.length) normalized = [this.unionColumnRects(merged)];

    const maxColumns = Math.max(2, Math.min(3, this.settings.gapMaxColumns || 3));
    if (normalized.length > maxColumns) {
      normalized = this.collapseColumnsToMajorGroups(normalized, pageRect);
    }

    normalized = normalized
      .filter(c => c.width > 0 && c.height > 0)
      .sort((a, b) => a.left - b.left);

    if (!normalized.length) normalized = [full];

    const verticalGapsRaw: number[] = [];
    const minGapPx = Math.max(1, pageRect.width * 0.002);
    for (let i = 1; i < normalized.length; i++) {
      const gap = normalized[i].left - normalized[i - 1].right;
      if (gap <= minGapPx) continue;
      verticalGapsRaw.push((normalized[i - 1].right + normalized[i].left) / 2);
    }
    const verticalGaps = this.mergeVerticalGapHints(verticalGapsRaw, gapHints, pageRect);

    const edgeCols = normalized.length >= 2 ? [normalized[0], normalized[normalized.length - 1]] : [];
    const gapCols = normalized.length > 2 ? normalized.slice(1, -1) : [];
    return { columns: normalized, edgeCols, gapCols, verticalGaps, horizontalGaps: [] };
  }

  private collapseColumnsToMajorGroups(
    cols: BoundingRect[],
    pageRect: DOMRect
  ): BoundingRect[] {
    if (cols.length <= 2) return cols;

    const sorted = [...cols].sort((a, b) => a.left - b.left);
    let bestGap = -Infinity;
    let split = -1;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].left - sorted[i - 1].right;
      if (gap > bestGap) {
        bestGap = gap;
        split = i - 1;
      }
    }

    const minSplitGap = Math.max(pageRect.width * 0.028, 12);
    if (split >= 0 && split < sorted.length - 1 && bestGap >= minSplitGap) {
      const left = this.unionColumnRects(sorted.slice(0, split + 1));
      const right = this.unionColumnRects(sorted.slice(split + 1));
      return [left, right].sort((a, b) => a.left - b.left);
    }

    return [this.unionColumnRects(sorted)];
  }

  private unionColumnRects(rects: BoundingRect[]): BoundingRect {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom) || right <= left || bottom <= top) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private unionRects(rects: DOMRect[]): BoundingRect | null {
    if (!rects.length) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom) || right <= left || bottom <= top) {
      return null;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
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
        out.push({
          y: pageRect.top,
          height: minTop - pageRect.top,
          left: pageRect.left,
          right: pageRect.right,
          confidence: this.settings.inferredBandConfidence
        });
      }
      if (maxBottom < pageRect.bottom - lineHeight * this.settings.bandTopBottomThresholdMultiplier) {
        out.push({
          y: maxBottom,
          height: pageRect.bottom - maxBottom,
          left: pageRect.left,
          right: pageRect.right,
          confidence: this.settings.inferredBandConfidence
        });
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
        last.left = Math.min(last.left, b.left);
        last.right = Math.max(last.right, b.right);
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
    separators: HorizontalBand[]
  ): Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }> {
    const contentBands = this.buildContentBandsFromSeparators(pageRect, separators);
    const results: Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }> = [];

    for (const band of contentBands) {
      const top = band.top;
      const bottom = band.bottom;
      const bandStrips = strips.filter(s => {
        const yOverlap = Math.min(bottom, s.bottom) - Math.max(top, s.top);
        const stripH = s.bottom - s.top;
        const overlapFrac = yOverlap / Math.max(1, Math.min(stripH, bottom - top));
        return yOverlap > 0 && overlapFrac >= this.settings.minOverlapFracForBand;
      });
      const regions = this.buildColumnRegionsFromStrips(bandStrips, pageRect);
      results.push({ band: { top, bottom }, regions });
    }

    if (!results.length) {
      results.push({
        band: { top: pageRect.top, bottom: pageRect.bottom },
        regions: this.buildColumnRegionsFromStrips(strips, pageRect)
      });
    }
    return results;
  }

  private buildContentBandsFromSeparators(
    pageRect: DOMRect,
    separators: HorizontalBand[]
  ): Array<{ top: number; bottom: number }> {
    if (!separators.length) return [{ top: pageRect.top, bottom: pageRect.bottom }];

    const sorted = separators
      .filter(b => b.confidence >= 0.82 && b.height >= 2.5)
      .map(b => ({
        top: Math.max(pageRect.top, b.y),
        bottom: Math.min(pageRect.bottom, b.y + b.height),
      }))
      .filter(b => b.bottom > b.top)
      .sort((a, b) => a.top - b.top);

    if (!sorted.length) return [{ top: pageRect.top, bottom: pageRect.bottom }];

    const merged: Array<{ top: number; bottom: number }> = [];
    for (const s of sorted) {
      const last = merged[merged.length - 1];
      if (!last || s.top > last.bottom) {
        merged.push({ ...s });
      } else {
        last.bottom = Math.max(last.bottom, s.bottom);
      }
    }

    const bands: Array<{ top: number; bottom: number }> = [];
    let cursor = pageRect.top;
    for (const sep of merged) {
      if (sep.top - cursor > 1) bands.push({ top: cursor, bottom: sep.top });
      cursor = Math.max(cursor, sep.bottom);
    }
    if (pageRect.bottom - cursor > 1) bands.push({ top: cursor, bottom: pageRect.bottom });
    return bands.length ? bands : [{ top: pageRect.top, bottom: pageRect.bottom }];
  }

  private buildColumnRegionsFromStrips(
    strips: VerticalStrip[],
    pageRect: DOMRect,
    stripsAreSanitized: boolean = false
  ): Array<{ left: number; right: number }> {
    if (!strips?.length) {
      return [{ left: pageRect.left, right: pageRect.right }];
    }

    const effectiveStrips = stripsAreSanitized
      ? strips
      : this.sanitizeStripsForColumnBoundaries(strips, pageRect);
    if (!effectiveStrips.length) {
      return [{ left: pageRect.left, right: pageRect.right }];
    }

    const regions: Array<{ left: number; right: number }> = [];
    const blocked = [...effectiveStrips]
      .map(s => ({
        left: Math.max(pageRect.left, s.left),
        right: Math.min(pageRect.right, s.right),
      }))
      .filter(s => s.right > s.left)
      .sort((a, b) => a.left - b.left);

    if (!blocked.length) return [{ left: pageRect.left, right: pageRect.right }];

    const mergedBlocked: Array<{ left: number; right: number }> = [];
    for (const b of blocked) {
      const last = mergedBlocked[mergedBlocked.length - 1];
      if (!last || b.left > last.right) {
        mergedBlocked.push({ ...b });
      } else {
        last.right = Math.max(last.right, b.right);
      }
    }

    let cursor = pageRect.left;
    for (const b of mergedBlocked) {
      if (b.left - cursor > this.settings.minRegionWidth) {
        regions.push({ left: cursor, right: b.left });
      }
      cursor = Math.max(cursor, b.right);
    }
    if (pageRect.right - cursor > this.settings.minRegionWidth) {
      regions.push({ left: cursor, right: pageRect.right });
    }
    if (!regions.length) return [{ left: pageRect.left, right: pageRect.right }];
    return regions;
  }

  private orderParagraphByBandsAndColumns(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    _bands: HorizontalBand[],
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

  private enhanceStripsWithGrid(
    base: VerticalStrip[],
    grid: GridAnalysis | null,
    pageRect: DOMRect,
    lineHeight: number
  ): VerticalStrip[] {
    if (!grid?.verticalLines?.length) return base;

    const minEdgeOffset = Math.max(6, lineHeight * 0.8);
    const stripWidth = Math.max(this.settings.minStripWidthPx, lineHeight * 0.35);

    const gridAsStrips: VerticalStrip[] = grid.verticalLines
      .filter(line => line.position > pageRect.left + minEdgeOffset && line.position < pageRect.right - minEdgeOffset)
      .map(line => ({
        left: line.position - stripWidth / 2,
        right: line.position + stripWidth / 2,
        top: pageRect.top,
        bottom: pageRect.bottom,
        confidence: 0.85
      }));

    const all = [...base, ...gridAsStrips].sort((a, b) => ((a.left + a.right) / 2) - ((b.left + b.right) / 2));
    if (!all.length) return all;

    const merged: VerticalStrip[] = [];
    const centerTol = Math.max(3, lineHeight * 0.35);
    for (const s of all) {
      const center = (s.left + s.right) / 2;
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push({ ...s });
        continue;
      }
      const lastCenter = (last.left + last.right) / 2;
      if (Math.abs(center - lastCenter) <= centerTol) {
        last.left = Math.min(last.left, s.left);
        last.right = Math.max(last.right, s.right);
        last.top = Math.min(last.top, s.top);
        last.bottom = Math.max(last.bottom, s.bottom);
        last.confidence = Math.max(last.confidence, s.confidence);
      } else {
        merged.push({ ...s });
      }
    }

    return merged;
  }

  private splitTableLikeParagraphs(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect,
    strips: VerticalStrip[],
    lineHeight: number
  ): HTMLSpanElement[][] {
    if (!paragraphs.length) return paragraphs;
    const regions = this.buildColumnRegionsFromStrips(strips, pageRect);
    if (regions.length < 2) return paragraphs;

    const rowTol = Math.max(2, lineHeight * 0.6);
    const out: HTMLSpanElement[][] = [];

    for (const para of paragraphs) {
      if (para.length < 6) {
        out.push(para);
        continue;
      }

      const sorted = [...para].sort((a, b) => {
        const ra = infoMap.get(a)!.rect;
        const rb = infoMap.get(b)!.rect;
        return ra.top - rb.top || ra.left - rb.left;
      });

      const rows: HTMLSpanElement[][] = [];
      for (const span of sorted) {
        const r = infoMap.get(span)!.rect;
        const row = rows.find(existing => {
          const first = infoMap.get(existing[0])!.rect;
          return Math.abs(first.top - r.top) <= rowTol;
        });
        if (row) row.push(span);
        else rows.push([span]);
      }

      if (rows.length < 2) {
        out.push(para);
        continue;
      }

      const coveredRegions = new Set<number>();
      const cellGroups: HTMLSpanElement[][] = [];
      for (const row of rows) {
        const buckets: HTMLSpanElement[][] = regions.map(() => []);
        for (const span of row) {
          const rect = infoMap.get(span)!.rect;
          const cx = (rect.left + rect.right) / 2;
          let idx = regions.findIndex(reg => cx >= reg.left && cx < reg.right);
          if (idx < 0) idx = cx < regions[0].left ? 0 : regions.length - 1;
          buckets[idx].push(span);
          coveredRegions.add(idx);
        }
        for (const bucket of buckets) {
          if (!bucket.length) continue;
          bucket.sort((a, b) => {
            const ra = infoMap.get(a)!.rect;
            const rb = infoMap.get(b)!.rect;
            return ra.top - rb.top || ra.left - rb.left;
          });
          cellGroups.push(bucket);
        }
      }

      const avgRowDensity = para.length / Math.max(1, rows.length);
      const isLikelyTable =
        coveredRegions.size >= 2 &&
        cellGroups.length >= 3 &&
        (rows.length >= 3 || avgRowDensity >= 3);

      if (isLikelyTable) {
        out.push(...cellGroups);
      } else {
        out.push(para);
      }
    }

    return out;
  }

  private optimizeParagraphsWithProfiles(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect,
    strips: VerticalStrip[],
    layoutBands: HorizontalBand[],
    lineHeight: number
  ): HTMLSpanElement[][] {
    if (!paragraphs.length) return paragraphs;

    const perBandColumnRegions = this.buildPerBandColumnRegions(strips, pageRect, layoutBands);
    const globalRegions = this.buildColumnRegionsFromStrips(strips, pageRect);
    const regionProfiles = this.classifyRegionProfiles(
      paragraphs,
      infoMap,
      pageRect,
      perBandColumnRegions,
      globalRegions,
      lineHeight
    );
    const out: HTMLSpanElement[][] = [];

    for (const para of paragraphs) {
      if (para.length <= 2) {
        out.push(this.sortParagraphTopLeft(para, infoMap));
        continue;
      }

      const paraRect = this.getParagraphBoundingRect(para, infoMap);
      const regionClass = this.getRegionClassForParagraph(paraRect, regionProfiles);

      const flowOrdered = this.sortParagraphTopLeft(para, infoMap);
      const flowCost = this.computeReadingOrderCost(flowOrdered, infoMap, lineHeight);

      const colOrdered = this.orderParagraphByBandsAndColumns(para, infoMap, layoutBands, perBandColumnRegions);
      const colCost = this.computeReadingOrderCost(colOrdered, infoMap, lineHeight);
      const columnSpanScore = this.computeColumnSpanScore(para, infoMap, globalRegions);
      const columnAdjustedCost = colCost - columnSpanScore * this.settings.profileColumnSpanScoreWeight;

      const tableCandidate = this.buildTableProfileCandidate(para, infoMap, pageRect, globalRegions, lineHeight);

      if (tableCandidate.strongTable) {
        out.push(...tableCandidate.groups);
        continue;
      }

      const columnBias =
        regionClass === this.REGION_COLUMNS ? this.settings.profileRegionColumnsCostBias :
        regionClass === this.REGION_FLOW ? this.settings.profileRegionFlowCostBias : 0;
      const effectiveColumnCost = columnAdjustedCost + columnBias;

      if (effectiveColumnCost + this.settings.profileColumnWinMargin < flowCost) {
        out.push(colOrdered);
      } else {
        out.push(flowOrdered);
      }
    }

    return out;
  }

  private classifyRegionProfiles(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect,
    perBandRegions: Array<{ band: { top: number; bottom: number }, regions: Array<{ left: number; right: number }> }>,
    globalRegions: Array<{ left: number; right: number }>,
    lineHeight: number
  ): Array<{ rect: BoundingRect; kind: string; score: number }> {
    const regionRects: BoundingRect[] = [];
    for (const entry of perBandRegions) {
      for (const reg of entry.regions) {
        const left = reg.left;
        const right = reg.right;
        const top = entry.band.top;
        const bottom = entry.band.bottom;
        if (right - left <= 1 || bottom - top <= 1) continue;
        regionRects.push({ left, top, right, bottom, width: right - left, height: bottom - top });
      }
    }
    if (!regionRects.length) {
      regionRects.push({
        left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
        width: pageRect.width, height: pageRect.height
      });
    }

    const globalChars = [...infoMap.values()].reduce((s, i) => s + (i.text || '').trim().length, 0);
    const globalArea = Math.max(1, pageRect.width * pageRect.height);
    const globalCharDensity = globalChars / globalArea;

    const profiles: Array<{ rect: BoundingRect; kind: string; score: number }> = [];

    for (const rr of regionRects) {
      const spansInRegion = this.collectSpansInRect(paragraphs, infoMap, rr);
      if (!spansInRegion.length) continue;

      let chars = 0;
      let occupiedArea = 0;
      const rowTol = Math.max(2, lineHeight * Math.max(0.6, this.settings.profileTableRowTolMultiplier));
      const rows: HTMLSpanElement[][] = [];
      const touchedCols = new Set<number>();

      const sorted = spansInRegion.slice().sort((a, b) => {
        const ra = infoMap.get(a)!.rect;
        const rb = infoMap.get(b)!.rect;
        return ra.top - rb.top || ra.left - rb.left;
      });

      for (const span of sorted) {
        const info = infoMap.get(span)!;
        const r = info.rect;
        chars += (info.text || '').trim().length;
        occupiedArea += Math.max(1, r.width * r.height);

        const cx = (r.left + r.right) / 2;
        let ci = globalRegions.findIndex(g => cx >= g.left && cx < g.right);
        if (ci < 0) ci = cx < globalRegions[0].left ? 0 : globalRegions.length - 1;
        touchedCols.add(ci);

        const row = rows.find(existing => {
          const first = infoMap.get(existing[0])!.rect;
          return Math.abs(first.top - r.top) <= rowTol;
        });
        if (row) row.push(span);
        else rows.push([span]);
      }

      let multiCellRows = 0;
      let totalCells = 0;
      for (const row of rows) {
        const rowCols = new Set<number>();
        for (const span of row) {
          const r = infoMap.get(span)!.rect;
          const cx = (r.left + r.right) / 2;
          let ci = globalRegions.findIndex(g => cx >= g.left && cx < g.right);
          if (ci < 0) ci = cx < globalRegions[0].left ? 0 : globalRegions.length - 1;
          rowCols.add(ci);
        }
        totalCells += rowCols.size;
        if (rowCols.size >= 2) multiCellRows++;
      }

      const regionArea = Math.max(1, rr.width * rr.height);
      const charDensity = chars / regionArea;
      const densityRatio = globalCharDensity > 0 ? charDensity / globalCharDensity : 0;
      const occupancy = occupiedArea / regionArea;
      const rowCount = rows.length;
      const multiCellRatio = multiCellRows / Math.max(1, rowCount);
      const avgCellsPerRow = totalCells / Math.max(1, rowCount);

      let kind = this.REGION_FLOW;
      let score = 0.5;

      if (
        rowCount >= this.settings.profileTableMinRows &&
        touchedCols.size >= this.settings.profileTableMinDistinctCols &&
        multiCellRatio >= Math.max(0.5, this.settings.profileTableMinMultiCellRowRatio - 0.1) &&
        avgCellsPerRow >= Math.max(1.8, this.settings.profileTableMinAvgCellsPerRow - 0.2) &&
        densityRatio >= this.settings.profileRegionTableDensityRatioMin &&
        occupancy >= this.settings.profileRegionTableOccupancyMin
      ) {
        kind = this.REGION_TABLE;
        score = multiCellRatio + avgCellsPerRow * 0.15 + Math.min(0.5, occupancy);
      } else if (
        touchedCols.size >= 2 &&
        densityRatio >= this.settings.profileRegionColumnsDensityRatioMin &&
        rowCount >= 2
      ) {
        kind = this.REGION_COLUMNS;
        score = touchedCols.size + densityRatio * 0.4;
      }

      profiles.push({ rect: rr, kind, score });
    }

    if (!profiles.length) {
      profiles.push({
        rect: {
          left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom,
          width: pageRect.width, height: pageRect.height
        },
        kind: this.REGION_FLOW,
        score: 0
      });
    }

    return profiles;
  }

  private collectSpansInRect(
    paragraphs: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    rect: BoundingRect
  ): HTMLSpanElement[] {
    const spans: HTMLSpanElement[] = [];
    for (const para of paragraphs) {
      for (const span of para) {
        const r = infoMap.get(span)!.rect;
        const overlapX = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
        const overlapY = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top);
        if (overlapX > 0 && overlapY > 0) spans.push(span);
      }
    }
    return spans;
  }

  private getParagraphBoundingRect(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>
  ): BoundingRect {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const span of paragraph) {
      const r = infoMap.get(span)!.rect;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private getRegionClassForParagraph(
    paraRect: BoundingRect,
    profiles: Array<{ rect: BoundingRect; kind: string; score: number }>
  ): string {
    const cx = (paraRect.left + paraRect.right) / 2;
    const cy = (paraRect.top + paraRect.bottom) / 2;

    let bestKind = this.REGION_FLOW;
    let bestScore = -Infinity;
    for (const p of profiles) {
      const inside = cx >= p.rect.left && cx <= p.rect.right && cy >= p.rect.top && cy <= p.rect.bottom;
      if (!inside) continue;
      if (p.score > bestScore) {
        bestScore = p.score;
        bestKind = p.kind;
      }
    }
    return bestKind;
  }

  private sortParagraphTopLeft(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>
  ): HTMLSpanElement[] {
    return [...paragraph].sort((a, b) => {
      const ra = infoMap.get(a)!.rect;
      const rb = infoMap.get(b)!.rect;
      return ra.top - rb.top || ra.left - rb.left;
    });
  }

  private computeReadingOrderCost(
    ordered: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    lineHeight: number
  ): number {
    if (ordered.length < 2) return 0;
    let cost = 0;
    const yBacktrackTol = Math.max(2, lineHeight * 0.35);
    const sameLineTol = Math.max(2, lineHeight * 0.6);
    const largeXJump = Math.max(18, lineHeight * 2.8);

    for (let i = 1; i < ordered.length; i++) {
      const prev = infoMap.get(ordered[i - 1])!.rect;
      const curr = infoMap.get(ordered[i])!.rect;
      const dy = curr.top - prev.top;
      const dx = Math.abs(curr.left - prev.left);

      if (dy < -yBacktrackTol) cost += 5;
      if (Math.abs(dy) <= sameLineTol && dx > largeXJump) cost += 2;
      if (dy > lineHeight * 2.6 && dx > largeXJump) cost += 1.25;
    }

    return cost;
  }

  private computeColumnSpanScore(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    regions: Array<{ left: number; right: number }>
  ): number {
    if (regions.length < 2 || paragraph.length < 4) return 0;
    const touched = new Set<number>();
    for (const span of paragraph) {
      const r = infoMap.get(span)!.rect;
      const cx = (r.left + r.right) / 2;
      let idx = regions.findIndex(reg => cx >= reg.left && cx < reg.right);
      if (idx < 0) idx = cx < regions[0].left ? 0 : regions.length - 1;
      touched.add(idx);
    }
    return Math.max(0, touched.size - 1);
  }

  private buildTableProfileCandidate(
    paragraph: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect,
    fallbackRegions: Array<{ left: number; right: number }>,
    lineHeight: number
  ): { groups: HTMLSpanElement[][]; strongTable: boolean } {
    if (paragraph.length < this.settings.profileTableMinParagraphSpans) {
      return { groups: [this.sortParagraphTopLeft(paragraph, infoMap)], strongTable: false };
    }

    const sorted = this.sortParagraphTopLeft(paragraph, infoMap);
    const rowTol = Math.max(2, lineHeight * this.settings.profileTableRowTolMultiplier);
    const rows: HTMLSpanElement[][] = [];

    for (const span of sorted) {
      const r = infoMap.get(span)!.rect;
      const row = rows.find(existing => {
        const first = infoMap.get(existing[0])!.rect;
        return Math.abs(first.top - r.top) <= rowTol;
      });
      if (row) row.push(span);
      else rows.push([span]);
    }

    if (rows.length < this.settings.profileTableMinRows) {
      return { groups: [sorted], strongTable: false };
    }

    const boundaries = this.inferStableTableBoundaries(rows, infoMap, lineHeight);
    const regions = boundaries.length
      ? this.buildRegionsFromBoundaries(boundaries, pageRect)
      : fallbackRegions;
    if (regions.length < 2) {
      return { groups: [sorted], strongTable: false };
    }

    let multiCellRows = 0;
    const groups: HTMLSpanElement[][] = [];
    const touchedColsGlobal = new Set<number>();

    for (const row of rows) {
      row.sort((a, b) => {
        const ra = infoMap.get(a)!.rect;
        const rb = infoMap.get(b)!.rect;
        return ra.left - rb.left || ra.top - rb.top;
      });

      const buckets: HTMLSpanElement[][] = regions.map(() => []);
      const touchedRow = new Set<number>();

      for (const span of row) {
        const r = infoMap.get(span)!.rect;
        const cx = (r.left + r.right) / 2;
        let idx = regions.findIndex(reg => cx >= reg.left && cx < reg.right);
        if (idx < 0) idx = cx < regions[0].left ? 0 : regions.length - 1;
        buckets[idx].push(span);
        touchedRow.add(idx);
        touchedColsGlobal.add(idx);
      }

      if (touchedRow.size >= 2) multiCellRows++;

      for (const bucket of buckets) {
        if (!bucket.length) continue;
        groups.push(bucket);
      }
    }

    const rowCount = rows.length;
    const multiCellRatio = multiCellRows / Math.max(1, rowCount);
    const avgCellsPerRow = groups.length / Math.max(1, rowCount);
    const distinctCols = touchedColsGlobal.size;
    const tooFragmented =
      groups.some(g => g.length === 1) &&
      groups.length > paragraph.length * this.settings.profileTableMaxFragmentationRatio;

    const headerLikeFirstRow = this.isLikelyTableHeaderRow(rows, infoMap);
    const minMultiCellRatio = headerLikeFirstRow
      ? Math.max(0.45, this.settings.profileTableMinMultiCellRowRatio - 0.15)
      : this.settings.profileTableMinMultiCellRowRatio;
    const minAvgCellsPerRow = headerLikeFirstRow
      ? Math.max(1.6, this.settings.profileTableMinAvgCellsPerRow - 0.3)
      : this.settings.profileTableMinAvgCellsPerRow;

    const strongTable =
      !tooFragmented &&
      distinctCols >= this.settings.profileTableMinDistinctCols &&
      rowCount >= this.settings.profileTableMinRows &&
      multiCellRatio >= minMultiCellRatio &&
      avgCellsPerRow >= minAvgCellsPerRow;

    if (!strongTable) return { groups: [sorted], strongTable: false };
    return { groups, strongTable: true };
  }

  private isLikelyTableHeaderRow(
    rows: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>
  ): boolean {
    if (rows.length < 2 || !rows[0].length) return false;
    const firstRow = rows[0];
    const body = rows.slice(1).flat();
    if (!body.length) return false;

    const firstRowAvgWeight =
      firstRow.reduce((sum, span) => sum + infoMap.get(span)!.style.fontWeight, 0) / firstRow.length;
    const bodyAvgWeight =
      body.reduce((sum, span) => sum + infoMap.get(span)!.style.fontWeight, 0) / body.length;

    const firstRowAvgSize =
      firstRow.reduce((sum, span) => sum + infoMap.get(span)!.style.fontSize, 0) / firstRow.length;
    const bodyAvgSize =
      body.reduce((sum, span) => sum + infoMap.get(span)!.style.fontSize, 0) / body.length;

    const firstRowText = firstRow.map(span => (infoMap.get(span)!.text || '').trim()).join(' ').trim();
    const upperChars = (firstRowText.match(/[A-Z]/g) || []).length;
    const letterChars = (firstRowText.match(/[A-Za-z]/g) || []).length;
    const upperRatio = letterChars > 0 ? upperChars / letterChars : 0;
    const firstRowFewCells = firstRow.length <= Math.max(1, Math.round(rows.slice(1).reduce((s, r) => s + r.length, 0) / Math.max(1, rows.length - 1) * 0.7));

    return (
      firstRowAvgWeight >= bodyAvgWeight + 120 ||
      firstRowAvgSize >= bodyAvgSize * 1.06 ||
      (upperRatio >= 0.65 && firstRowFewCells)
    );
  }

  private inferStableTableBoundaries(
    rows: HTMLSpanElement[][],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    lineHeight: number
  ): Array<{ left: number; right: number; center: number }> {
    const candidates: Array<{ left: number; right: number; center: number }> = [];
    const allWidths = rows
      .flat()
      .map(span => infoMap.get(span)!.rect.width)
      .filter(w => w > 0)
      .sort((a, b) => a - b);
    const medianWidth = allWidths.length ? allWidths[Math.floor(allWidths.length / 2)] : 0;
    const minGap = Math.max(
      this.settings.profileTableMinGapPx,
      lineHeight * this.settings.profileTableMinGapLineHeightMultiplier,
      medianWidth * this.settings.profileTableMinGapMedianWidthMultiplier
    );

    for (const row of rows) {
      const rowRects = row.map(s => infoMap.get(s)!.rect).sort((a, b) => a.left - b.left);
      if (rowRects.length < 2) continue;
      for (let i = 1; i < rowRects.length; i++) {
        const prev = rowRects[i - 1];
        const curr = rowRects[i];
        const gap = curr.left - prev.right;
        if (gap >= minGap) {
          candidates.push({
            left: prev.right,
            right: curr.left,
            center: prev.right + gap / 2
          });
        }
      }
    }

    if (!candidates.length) return [];
    candidates.sort((a, b) => a.center - b.center);

    const clusters: Array<{ center: number; left: number; right: number; count: number }> = [];
    const tol = Math.max(3, lineHeight * this.settings.profileTableBoundaryTolMultiplier);
    for (const c of candidates) {
      if (!clusters.length || Math.abs(c.center - clusters[clusters.length - 1].center) > tol) {
        clusters.push({ center: c.center, left: c.left, right: c.right, count: 1 });
      } else {
        const last = clusters.length - 1;
        const n = clusters[last].count;
        clusters[last].center = (clusters[last].center * n + c.center) / (n + 1);
        clusters[last].left = (clusters[last].left * n + c.left) / (n + 1);
        clusters[last].right = (clusters[last].right * n + c.right) / (n + 1);
        clusters[last].count = n + 1;
      }
    }

    const minRepeats = Math.max(
      this.settings.profileTableBoundaryMinRepeatsAbs,
      Math.floor(rows.length * this.settings.profileTableBoundaryMinRepeatsRowFrac)
    );
    const strong = clusters
      .filter(c => c.count >= minRepeats)
      .map(c => ({ left: c.left, right: c.right, center: c.center }));
    if (strong.length) return strong;

    // Fallback: keep near-stable separators when strict repeat threshold is missed by noise.
    const fallbackRepeats = Math.max(1, minRepeats - 1);
    return clusters
      .filter(c => c.count >= fallbackRepeats && (c.right - c.left) >= Math.max(2, minGap * 0.45))
      .map(c => ({ left: c.left, right: c.right, center: c.center }));
  }

  private buildRegionsFromBoundaries(
    boundaries: Array<{ left: number; right: number; center: number }>,
    pageRect: DOMRect
  ): Array<{ left: number; right: number }> {
    if (!boundaries.length) return [{ left: pageRect.left, right: pageRect.right }];
    const ordered = [...boundaries].sort((a, b) => a.center - b.center);
    const regions: Array<{ left: number; right: number }> = [];
    let cursor = pageRect.left;

    for (const b of ordered) {
      const gapLeft = Math.max(pageRect.left, Math.min(b.left, b.center));
      const gapRight = Math.min(pageRect.right, Math.max(b.right, b.center));
      const regionRight = Math.max(cursor, gapLeft);
      if (regionRight - cursor > 1) {
        regions.push({ left: cursor, right: regionRight });
      }
      cursor = Math.max(cursor, gapRight);
    }

    if (pageRect.right - cursor > 1) {
      regions.push({ left: cursor, right: pageRect.right });
    }

    if (!regions.length) return [{ left: pageRect.left, right: pageRect.right }];
    return regions;
  }

  private createEmptyResult(): LayoutResult {
    return {
      paragraphs: [],
      columnAnalysis: {
        columns: [], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: []
      },
      debugStrips: [],
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
