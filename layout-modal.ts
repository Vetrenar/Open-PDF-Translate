// layout-modal.ts

// Configuration settings for LayoutDetector magical numbers and constants.
export interface LayoutSettings {
  /** If true, runs multiple layout mode profiles and picks the best regional fit (default: true) */
  useModeEnsemble: boolean;
  /** Multiplier for line height calculations (default: 1.6) */
  lineHeightMultiplier: number;
  /** Minimum confidence for vertical strips (default: 0.62) */
  minStripConfidence: number;
  /** Minimum width in pixels for vertical strips (default: 3) */
  minStripWidthPx: number;
  /** Enable debug validation logging (default: false) */
  debugValidation: boolean;
  /** Maximum iterations for paragraph merging (default: 10) */
  maxIterMerges: number;
  /** Minimum confidence for horizontal bands (default: 0.6) */
  minBandConfidence: number;
  /** Threshold multiplier for band top/bottom inference relative to line height (default: 0.75) */
  bandTopBottomThresholdMultiplier: number;
  /** Confidence for inferred horizontal bands from strips (default: 0.8) */
  inferredBandConfidence: number;
  /** Minimum pixel gap for merging adjacent bands (default: 2) */
  bandMergeGapPx: number;
  /** Line height multiplier for dynamic band merge gap (default: 0.2) */
  bandMergeGapLineHeightMultiplier: number;
  /** Maximum gap fraction of page height for line height estimation (default: 0.5) */
  maxGapFractionOfPageHeight: number;
  /** Minimum number of gaps required for trimmed average in line height estimation (default: 5) */
  minGapsForTrim: number;
  /** Percentage of gaps to trim from each end for robust average (default: 0.15) */
  trimPercent: number;
  /** Multiplier to convert average gap to line height (default: 1.25) */
  lineHeightFromAvgMultiplier: number;
  /** Multiplier for floor value in line height estimation (default: 0.8) */
  floorMultiplier: number;
  /** Minimum overlap fraction for assigning spans to bands (default: 0.4) */
  minOverlapFracForBand: number;
  /** Minimum width for column regions (default: 1) */
  minRegionWidth: number;
  /** Multiplier for column threshold based on average line height (default: 2) */
  columnThresholdLineHeightMultiplier: number;
  /** Fallback pixel value for column threshold if line height is unavailable (default: 20) */
  columnThresholdFallback: number;
  /** GapDetector: max number of columns produced from vertical boundaries (default: 6) */
  gapMaxColumns: number;
  /** GapDetector: minimum horizontal whitespace width considered as a gap (default: 3) */
  gapMinGapWidthPx: number;
  /** GapDetector: y-band step factor relative to line-height (default: 0.6) */
  gapBandStepFactor: number;
  /** GapDetector: minimum strip height factor relative to line-height (default: 2.0) */
  gapMinStripHeightFactor: number;
  /** GapDetector: x-cluster tolerance factor relative to line-height (default: 0.45) */
  gapCenterXTolFactor: number;
  /** Vertical separator: x-bin width in px for occupancy voting (default: 3) */
  verticalSeparatorBinPx: number;
  /** Vertical separator: min clear-ratio per x-bin across content bands (default: 0.72) */
  verticalSeparatorMinClearRatio: number;
  /** Vertical separator: min content-band coverage of a candidate separator (default: 0.58) */
  verticalSeparatorMinBandCoverage: number;
  /** Vertical separator: min separator width as line-height multiplier (default: 0.6) */
  verticalSeparatorMinWidthLineHeightMultiplier: number;
  /** Vertical separator: edge margin as line-height multiplier (default: 0.8) */
  verticalSeparatorEdgeMarginLineHeightMultiplier: number;
  /** Vertical separator: max short hole size (in bins) merged inside a separator (default: 1) */
  verticalSeparatorMergeGapBins: number;
  /** GridDetector: min horizontal gap as line-height multiplier (default: 1.5) */
  gridMinHorizontalGapLineHeightMultiplier: number;
  /** GridDetector: min vertical gap as line-height multiplier (default: 0.8) */
  gridMinVerticalGapLineHeightMultiplier: number;
  /** GridDetector: edge margin as line-height multiplier (default: 0.75) */
  gridEdgeMarginLineHeightMultiplier: number;
  /** GridDetector: number of strongest vertical gaps to keep (default: 8) */
  gridMaxVerticalGaps: number;
  /** GridDetector: smoothing radius for projection profiles (default: 3) */
  gridSmoothRadius: number;
  /** GridDetector: absolute occupancy threshold for empty bins (default: 1) */
  gridProjectionProfileThreshold: number;

  // --- Multi-profile selector tuning ---
  /** Column profile score gain multiplier (default: 1.75) */
  profileColumnSpanScoreWeight: number;
  /** Minimum cost advantage for column profile over flow (default: 0.35) */
  profileColumnWinMargin: number;
  /** Minimum spans for table profile consideration (default: 8) */
  profileTableMinParagraphSpans: number;
  /** Row grouping tolerance multiplier for table profile (default: 0.55) */
  profileTableRowTolMultiplier: number;
  /** Absolute minimum horizontal gap (px) when inferring table boundaries (default: 14) */
  profileTableMinGapPx: number;
  /** Line-height-based minimum gap multiplier for table boundaries (default: 1.2) */
  profileTableMinGapLineHeightMultiplier: number;
  /** Median-span-width-based minimum gap multiplier for table boundaries (default: 1.15) */
  profileTableMinGapMedianWidthMultiplier: number;
  /** Minimum rows required for strong table classification (default: 3) */
  profileTableMinRows: number;
  /** Minimum distinct columns required for strong table classification (default: 2) */
  profileTableMinDistinctCols: number;
  /** Minimum multi-cell row ratio for strong table classification (default: 0.66) */
  profileTableMinMultiCellRowRatio: number;
  /** Minimum average cells per row for strong table classification (default: 2.0) */
  profileTableMinAvgCellsPerRow: number;
  /** Maximum fragmentation ratio allowed for table profile (default: 0.65) */
  profileTableMaxFragmentationRatio: number;
  /** Boundary clustering tolerance as line-height multiplier (default: 0.45) */
  profileTableBoundaryTolMultiplier: number;
  /** Minimum repeats per boundary cluster (absolute floor) (default: 2) */
  profileTableBoundaryMinRepeatsAbs: number;
  /** Minimum repeats per boundary cluster as row fraction (default: 0.4) */
  profileTableBoundaryMinRepeatsRowFrac: number;
  /** Region classifier: minimum density ratio for table region (default: 0.7) */
  profileRegionTableDensityRatioMin: number;
  /** Region classifier: minimum occupancy for table region (default: 0.05) */
  profileRegionTableOccupancyMin: number;
  /** Region classifier: minimum density ratio for columns region (default: 0.65) */
  profileRegionColumnsDensityRatioMin: number;
  /** Cost bias for regions classified as columns (default: -0.35) */
  profileRegionColumnsCostBias: number;
  /** Cost bias for regions classified as flow (default: 0.45) */
  profileRegionFlowCostBias: number;

  // --- Settings potentially used by ParagraphMerger ---
  
  /** 
   * If true, ignores column alignment, horizontal bands, and font styles. 
   * Tries to merge everything into a single flow based purely on reading order and vertical proximity.
   * (default: false)
   */
  pmForceLinearMerge: boolean;

  /** Minimum confidence for vertical strips used in ParagraphMerger (default: 0.58) */
  pmMinStripConfidenceSplit: number;
  /** Minimum width in pixels for vertical strips used in ParagraphMerger (default: 4) */
  pmMinStripWidthPx: number;
  /** Minimum vertical overlap fraction required for spans to be considered in the same column (default: 0.6) */
  pmMinStripOverlapFrac: number;
  /** Tolerance multiplier for baseline alignment in initial merge (non-math) (default: 0.45) */
  pmInitialMergeBaselineTolNonMath: number;
  /** Tolerance multiplier for baseline alignment in initial merge (math) (default: 0.75) */
  pmInitialMergeBaselineTolMath: number;
  /** Tolerance multiplier for inline kerning in initial merge (non-math) (default: 0.55) */
  pmInitialMergeKernTolNonMath: number;
  /** Tolerance multiplier for inline kerning in initial merge (math) (default: 0.9) */
  pmInitialMergeKernTolMath: number;
  /** Tolerance multiplier for hyphenation continuation (default: 1.8) */
  pmHyphenContinuationTol: number;
  /** Tolerance multiplier for left/right alignment in initial merge (non-math) (default: 1.8) */
  pmInitialMergeAlignTolNonMath: number;
  /** Tolerance multiplier for left/right alignment in initial merge (math) (default: 1.8) */
  pmInitialMergeAlignTolMath: number;
  /** Vertical gap multiplier relative to line height in initial merge (default: 1.15) */
  pmInitialMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of font size in initial merge (default: 1.95) */
  pmInitialMergeVerticalGapMaxMultiplier: number;
  /** Tolerance multiplier for left/right alignment in stacked merge (default: 1.6) */
  pmStackedMergeAlignTol: number;
  /** Horizontal overlap fraction threshold for strong overlap in stacked merge (default: 0.35) */
  pmStackedMergeOverlapFrac: number;
  /** Vertical gap multiplier relative to line height in stacked merge (default: 1.05) */
  pmStackedMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of max font size in stacked merge (default: 1.5) */
  pmStackedMergeVerticalGapMaxMultiplier: number;
  /** Tolerance multiplier for left/right alignment in general merge (default: 1.6) */
  pmGeneralMergeAlignTol: number;
  /** Horizontal overlap fraction threshold for strong overlap in general merge (default: 0.35) */
  pmGeneralMergeOverlapFrac: number;
  /** Vertical gap multiplier relative to line height in general merge (default: 1.05) */
  pmGeneralMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of max font size in general merge (default: 1.5) */
  pmGeneralMergeVerticalGapMaxMultiplier: number;
  /** Overlap fraction threshold for strong overlap in nested merge (default: 0.7) */
  pmNestedMergeOverlapFrac: number;
  /** Tolerance multiplier for baseline alignment in inline stitching (non-math) (default: 0.45) */
  pmStitchBaselineTolNonMath: number;
  /** Tolerance multiplier for baseline alignment in inline stitching (math) (default: 0.75) */
  pmStitchBaselineTolMath: number;
  /** Tolerance multiplier for inline kerning in inline stitching (non-math) (default: 0.55) */
  pmStitchKernTolNonMath: number;
  /** Tolerance multiplier for inline kerning in inline stitching (math) (default: 0.9) */
  pmStitchKernTolMath: number;
  /** Baseline tolerance multiplier for inline span merging (default: 0.3) */
  pmInlineSpanBaselineTol: number;
  /** Kerning tolerance multiplier for inline span merging (default: 0.6) */
  pmInlineSpanKernTol: number;
  /** Maximum difference in numeric font weight (e.g., 400 vs 700) to allow merging. (default: 300) */
  pmInlineSpanMaxWeightDiff: number;
  /** Whether to allow merging of spans with different font styles. (default: true) */
  pmInlineSpanAllowMixedStyle: boolean;
  /** Coverage ratio threshold for determining if strips separate columns (default: 0.45) */
  pmSameColumnCoverageRatio: number;
  /** Baseline proximity tolerance multiplier for math merge candidate (default: 2.0) */
  pmMathMergeBaselineTol: number;
  /** Horizontal proximity tolerance multiplier for math merge candidate (default: 1.5) */
  pmMathMergeHorizTol: number;
  /** Center proximity tolerance multiplier for math merge candidate (default: 2.5) */
  pmMathMergeCenterTol: number;
  /** Line height tolerance multiplier for grouping spans by line during splitting (default: 0.7) */
  pmSplitLineHeightTol: number;
  /** Boundary deduplication tolerance multiplier relative to line height (default: 0.3) */
  pmSplitBoundaryDedupTol: number;
  /** Inter-word gap tolerance multiplier relative to font size (default: 1.2) */
  pmSplitInterWordGapTol: number;
  /** Column gap tolerance multiplier relative to font size (default: 2.5) */
  pmSplitColumnGapTol: number;

  // ===========================================================================
  // NEW: OccupancyGapDetector v2 (dual-map architecture)
  // These settings drive the new pipeline. Legacy fields above are kept for
  // preset backward-compatibility but are IGNORED by the new detector.
  // ===========================================================================
  /** Bin size in px for the occupancy map. 0 = auto from lineHeight (default: 0) */
  binSize: number;
  /** Neighborhood radius for emptiness confidence map (in bins) (default: 1) */
  emptinessRadius: number;
  /** Minimum vertical gap thickness in px (default: 4) */
  minVerticalGapPx: number;
  /** Minimum horizontal gap thickness in px (default: 4) */
  minHorizontalGapPx: number;
  /** Gap if textProj < maxTextProj * textThresholdFactor (default: 0.1) */
  textThresholdFactor: number;
  /** Gap if gapProj >= spanLength * (1 - factor) (default: 0.5) */
  emptinessThresholdFactor: number;
  /** Absolute floor for text threshold in density units (default: 0.5) */
  absoluteTextThreshold: number;
  /** Crossing detection: cell is crossing if textMap > maxText * factor (default: 0.15) */
  crossingFactor: number;
  /** Minimum gap segment length after crossing split, in px (default: 2) */
  minGapSegmentPx: number;
  /** Projection smoothing radius in bins (0 = off, recommended) (default: 0) */
  smoothRadius: number;
  /** Enable recursive local gap detection within content bands (default: true) */
  detectLocalGaps: boolean;
  /** Max recursion depth for local gap detection (default: 2) */
  maxRecursionDepth: number;
  /** Min adjacent content fraction for local gaps (default: 0.05) */
  minAdjacentContentFraction: number;
  /** Merge gaps on same axis within this px distance (default: 8) */
  mergeGapPx: number;
  /** Max vertical gaps to keep (default: 16) */
  maxVerticalGaps: number;
  /** Max horizontal gaps to keep (default: 24) */
  maxHorizontalGaps: number;
  /** Absolute edge margin in px (default: 4) */
  edgeMarginPx: number;
  /** Fractional edge margin: gaps within pageWidth * fraction are discarded (default: 0.08) */
  edgeMarginFraction: number;
  /** Use the larger of edgeMarginPx and pageWidth * edgeMarginFraction (default: true) */
  useAdaptiveEdgeMargin: boolean;
  /**
   * Morphological closing radius for gap detection (in bins).
   * Holes (non-gap bins) of size <= maxHoleBins inside a gap run get
   * filled in.  This handles text spillover and orphan cells that
   * cross column gaps.  Set to 0 to disable.
   */
  maxHoleBins: number;
  /** Aura dilation in px (default: 2) */
  aura: number;
  /** Row occupancy ratio threshold for full-width (default: 0.65) */
  fullWidthThreshold: number;
  /** Row occupancy ratio threshold for empty (default: 0.05) */
  emptyThreshold: number;
  /** Fraction of body rows where column must be empty (default: 0.80) */
  gapColumnThreshold: number;
  /** Minimum gap width in cells (default: 2) */
  minGapWidthCells: number;
  /** Minimum gap height in cells (default: 5) */
  minGapHeightCells: number;
  /** Page margin fraction (default: 0.04) */
  pageMargin: number;
  /** emptyBinTolerance: bin is empty if <= this × avg (default: 0.15) */
  emptyBinTolerance: number;
  /** Header/footer margin fraction for X projection (default: 0.08) */
  headerFooterMarginFraction: number;
  /** Gap search start fraction (default: 0.15) */
  gapSearchStartFraction: number;
  /** Gap search end fraction (default: 0.85) */
  gapSearchEndFraction: number;
  /** Max distance from centre for gap (default: 0.15) */
  maxGapDistFromCentre: number;
  /** Valley depth ratio (default: 0.6) */
  valleyDepthRatio: number;
  /** Y-overlap tolerance for same-line detection (default: 1) */
  lineHeightTolerance: number;
  /** Vertical gap threshold for paragraph breaks, as lineHeight multiplier (default: 0.5) */
  paragraphLineGapMultiplier: number;
  /** X-overlap fraction for "same line" detection (default: 0.3) */
  paragraphLineAlignTol: number;
  /** Discard paragraphs with fewer than this many spans (default: 1) */
  minParagraphSpans: number;

  // --- Contour pipeline (steps 1-8 in pipeline.mjs) ---
  /** Grid cell size in pixels for occupancy map. Contour threshold = 2 × this value.
   *  Default 4 (validated against pdfplumber reference pipeline). */
  contourCellSize: number;
  /** Pixel threshold above body left margin for considering a line indented (default 5).
   *  Indented lines start new sub-paragraphs in step 8. */
  contourIndentThreshold: number;
  /** Tolerance in font size units for "same font" merging (default 1).
   *  Lines whose dominant size differs by > this value are split into separate paragraphs. */
  contourFontSizeTolerance: number;
  // Stage 2.2 (Q6): 3 new layout settings exposed in Settings → Advanced.
  /** Column gap threshold in pixels — vertical strips wider than this are
   *  treated as column separators. Default 50. */
  columnGapThreshold: number;
  /** Decoration detection threshold — spans with font size < this fraction
   *  of the line's median size are treated as decorations (superscripts,
   *  footnote refs) and don't trigger paragraph splits. Default 0.7 (70%). */
  decorationThreshold: number;
  /** Maximum merge passes for the iterative paragraph merge step (default 10).
   *  Each pass merges touching islands with the same primary font family. */
  maxMergePasses: number;
}

// Interface for preset data
export interface Preset {
  id: string;
  name: string;
  settings: LayoutSettings;
  createdAt: Date;
  updatedAt: Date;
}

export const defaultLayoutSettings: LayoutSettings = {
  useModeEnsemble: true,
  lineHeightMultiplier: 1.6,
  minStripConfidence: 0.62,
  minStripWidthPx: 3,
  debugValidation: false,
  maxIterMerges: 10,
  minBandConfidence: 0.6,
  bandTopBottomThresholdMultiplier: 0.75,
  inferredBandConfidence: 0.8,
  bandMergeGapPx: 2,
  bandMergeGapLineHeightMultiplier: 0.2,
  maxGapFractionOfPageHeight: 0.5,
  minGapsForTrim: 5,
  trimPercent: 0.15,
  lineHeightFromAvgMultiplier: 1.25,
  floorMultiplier: 0.8,
  minOverlapFracForBand: 0.4,
  minRegionWidth: 1,
  columnThresholdLineHeightMultiplier: 2,
  columnThresholdFallback: 20,
  gapMaxColumns: 6,
  gapMinGapWidthPx: 3,
  gapBandStepFactor: 0.6,
  gapMinStripHeightFactor: 2.0,
  gapCenterXTolFactor: 0.45,
  verticalSeparatorBinPx: 3,
  verticalSeparatorMinClearRatio: 0.72,
  verticalSeparatorMinBandCoverage: 0.58,
  verticalSeparatorMinWidthLineHeightMultiplier: 0.6,
  verticalSeparatorEdgeMarginLineHeightMultiplier: 0.8,
  verticalSeparatorMergeGapBins: 1,
  gridMinHorizontalGapLineHeightMultiplier: 1.5,
  gridMinVerticalGapLineHeightMultiplier: 0.8,
  gridEdgeMarginLineHeightMultiplier: 0.75,
  gridMaxVerticalGaps: 8,
  gridSmoothRadius: 3,
  gridProjectionProfileThreshold: 0,
  profileColumnSpanScoreWeight: 1.75,
  profileColumnWinMargin: 0.35,
  profileTableMinParagraphSpans: 8,
  profileTableRowTolMultiplier: 0.55,
  profileTableMinGapPx: 14,
  profileTableMinGapLineHeightMultiplier: 1.2,
  profileTableMinGapMedianWidthMultiplier: 1.15,
  profileTableMinRows: 3,
  profileTableMinDistinctCols: 2,
  profileTableMinMultiCellRowRatio: 0.66,
  profileTableMinAvgCellsPerRow: 2.0,
  profileTableMaxFragmentationRatio: 0.65,
  profileTableBoundaryTolMultiplier: 0.45,
  profileTableBoundaryMinRepeatsAbs: 2,
  profileTableBoundaryMinRepeatsRowFrac: 0.4,
  profileRegionTableDensityRatioMin: 0.7,
  profileRegionTableOccupancyMin: 0.05,
  profileRegionColumnsDensityRatioMin: 0.65,
  profileRegionColumnsCostBias: -0.35,
  profileRegionFlowCostBias: 0.45,
  
  // -- Paragraph Merger Defaults --
  pmForceLinearMerge: false, // Default: Off

  pmMinStripConfidenceSplit: 0.58,
  pmMinStripWidthPx: 4,
  pmMinStripOverlapFrac: 0.6,
  pmInitialMergeBaselineTolNonMath: 0.45,
  pmInitialMergeBaselineTolMath: 0.75,
  pmInitialMergeKernTolNonMath: 0.55,
  pmInitialMergeKernTolMath: 0.9,
  pmHyphenContinuationTol: 1.8,
  pmInitialMergeAlignTolNonMath: 1.8,
  pmInitialMergeAlignTolMath: 1.8,
  pmInitialMergeVerticalGapMultiplier: 1.15,
  pmInitialMergeVerticalGapMaxMultiplier: 1.95,
  pmStackedMergeAlignTol: 1.6,
  pmStackedMergeOverlapFrac: 0.35,
  pmStackedMergeVerticalGapMultiplier: 1.05,
  pmStackedMergeVerticalGapMaxMultiplier: 1.5,
  pmGeneralMergeAlignTol: 1.6,
  pmGeneralMergeOverlapFrac: 0.35,
  pmGeneralMergeVerticalGapMultiplier: 1.05,
  pmGeneralMergeVerticalGapMaxMultiplier: 1.5,
  pmNestedMergeOverlapFrac: 0.7,
  pmStitchBaselineTolNonMath: 0.45,
  pmStitchBaselineTolMath: 0.75,
  pmStitchKernTolNonMath: 0.55,
  pmStitchKernTolMath: 0.9,
  pmInlineSpanBaselineTol: 0.3,
  pmInlineSpanKernTol: 0.6,
  pmInlineSpanMaxWeightDiff: 300,
  pmInlineSpanAllowMixedStyle: true,
  pmSameColumnCoverageRatio: 0.45,
  pmMathMergeBaselineTol: 2.0,
  pmMathMergeHorizTol: 1.5,
  pmMathMergeCenterTol: 2.5,
  pmSplitLineHeightTol: 0.7,
  pmSplitBoundaryDedupTol: 0.3,
  pmSplitInterWordGapTol: 1.2,
  pmSplitColumnGapTol: 2.5,

  // ===========================================================================
  // OccupancyGapDetector v2 defaults (dual-map architecture)
  // ===========================================================================
  binSize: 0,
  emptinessRadius: 1,
  minVerticalGapPx: 4,
  minHorizontalGapPx: 4,
  textThresholdFactor: 0.15,
  emptinessThresholdFactor: 0.3,
  absoluteTextThreshold: 0.5,
  crossingFactor: 0.15,
  minGapSegmentPx: 2,
  smoothRadius: 0,
  detectLocalGaps: true,
  maxRecursionDepth: 2,
  minAdjacentContentFraction: 0.05,
  mergeGapPx: 8,
  maxVerticalGaps: 16,
  maxHorizontalGaps: 24,
  edgeMarginPx: 4,
  edgeMarginFraction: 0.04,
  useAdaptiveEdgeMargin: true,
  maxHoleBins: 2,
  aura: 2,
  fullWidthThreshold: 0.65,
  emptyThreshold: 0.05,
  gapColumnThreshold: 0.80,
  minGapWidthCells: 2,
  minGapHeightCells: 5,
  pageMargin: 0.04,
  emptyBinTolerance: 0.15,
  headerFooterMarginFraction: 0.08,
  gapSearchStartFraction: 0.15,
  gapSearchEndFraction: 0.85,
  maxGapDistFromCentre: 0.15,
  valleyDepthRatio: 0.6,
  lineHeightTolerance: 1,
  paragraphLineGapMultiplier: 0.5,
  paragraphLineAlignTol: 0.3,
  minParagraphSpans: 1,

  // --- Contour pipeline (steps 1-8 in pipeline.mjs) ---
  contourCellSize: 4,
  contourIndentThreshold: 5,
  contourFontSizeTolerance: 1,
  // Stage 2.2 (Q6): 3 new layout settings with defaults.
  columnGapThreshold: 50,
  decorationThreshold: 0.7,
  maxMergePasses: 10,
};

// Storage key for presets (used for localStorage migration only)
const PRESETS_STORAGE_KEY = 'layoutSettingsPresets';
const PRESETS_MIGRATION_KEY = 'layoutSettingsPresetsBuiltinV7Migrated';
const PRESETS_LOCALSTORAGE_MIGRATED_KEY = 'layoutSettingsPresetsLocalStorageMigratedToVault';

/**
 * Shows a user-friendly modal dialog for adjusting layout settings.
 * @param currentSettings The current settings to prefill the modal with.
 * @param onSave Callback function to handle the saved settings.
 */

// Stage 0.3 (Q20): showLayoutSettingsModal (477 lines) was here but never
// called from anywhere in the codebase. Removed to reduce dead code.
// Layout settings are now managed via presets (applyPreset) and the
// defaultLayoutSettings constant. The contour pipeline reads its
// tuning parameters from defaultLayoutSettings directly.
// Stage 2 will add 6 meaningful layout settings to Settings → Advanced.
