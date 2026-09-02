// layout-modal.ts
//
// Phase 3 (T3.1): LayoutSettings reduced to the fields the contour pipeline
// ACTUALLY reads. The previous interface carried ~110 fields inherited from
// three retired detectors (all `pm*`, `gap*`, `grid*`, `profile*`,
// `verticalSeparator*`, `band*`, OccupancyGapDetector-v2 knobs, …). None of
// them influenced detection, but ALL of them participated in
// `computeLayoutSettingsHash` — so touching any dead field silently
// invalidated every translated document (full re-translation on a no-op
// settings change).
//
// loadSettings() (main.ts) strips unknown keys from saved data.json, and
// computeLayoutSettingsHash() hashes only these live fields.
// The v3→v5 storage migration re-stamps the hash on existing files so the
// upgrade itself does NOT trigger mass re-translation.

export interface LayoutSettings {
  /** Grid cell size (px) for the occupancy map. Contour threshold = 2×. Default 4. */
  contourCellSize: number;
  /** Pixel threshold above body left margin for an indented line. Default 5. */
  contourIndentThreshold: number;
  /** Font-size tolerance (pt) for "same font" grouping / splitting. Default 1. */
  contourFontSizeTolerance: number;
  /** Max merge passes for the iterative touching-island merge. Default 10. */
  maxMergePasses: number;
  /** Column gap threshold (px); see applyColumnOrder. Default 50. */
  columnGapThreshold: number;
  /** Spans below this fraction of the line's median size are decorations. Default 0.7. */
  decorationThreshold: number;
  /** Log detection timings/validation to console. Default false. */
  debugValidation: boolean;
}

export const defaultLayoutSettings: LayoutSettings = {
  contourCellSize: 4,
  contourIndentThreshold: 5,
  contourFontSizeTolerance: 1,
  maxMergePasses: 10,
  columnGapThreshold: 50,
  decorationThreshold: 0.7,
  debugValidation: false,
};

/** Live-field whitelist — the ONLY fields hashed and persisted. */
export const LAYOUT_SETTINGS_LIVE_KEYS: readonly (keyof LayoutSettings)[] = [
  'contourCellSize',
  'contourIndentThreshold',
  'contourFontSizeTolerance',
  'maxMergePasses',
  'columnGapThreshold',
  'decorationThreshold',
  'debugValidation',
];

// Preset infrastructure was removed with the dead fields (presets tuned
// knobs the contour pipeline never read — see audit §P1-1 / Q12).
// The interface and defaults above are the whole configuration surface.
