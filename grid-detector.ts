// grid-detector.ts

import type { BoundingRect } from './layout-detector';

/**
 * Represents a detected horizontal or vertical line in a grid.
 */
export interface GridLine {
  position: number; // The y-coordinate for horizontal lines, or x-coordinate for vertical lines.
  start: number;    // The starting coordinate of the line (e.g., pageRect.left).
  end: number;      // The ending coordinate of the line (e.g., pageRect.right).
  thickness: number; // Estimated gap thickness in px.
}

/**
 * Contains the results of the grid detection analysis.
 */
export interface GridAnalysis {
  horizontalLines: GridLine[];
  verticalLines: GridLine[];
}

/**
 * Configuration settings for the GridDetector.
 */
export interface GridSettings {
  // The minimum height of a horizontal gap, as a multiplier of the document's line height.
  minHorizontalGapLineHeightMultiplier: number;
  // The minimum width of a vertical gap, as a multiplier of the document's line height.
  minVerticalGapLineHeightMultiplier: number;
  // Ignore near-page-edge gaps by this line-height-based margin.
  edgeMarginLineHeightMultiplier: number;
  // Keep at most this many strongest vertical gaps.
  maxVerticalGaps: number;
  // Radius for projection smoothing.
  smoothRadius: number;
  // The threshold (span-count per bin) to consider a projection profile value as "empty".
  projectionProfileThreshold: number;
}

export const defaultGridSettings: GridSettings = {
  minHorizontalGapLineHeightMultiplier: 1.5,
  minVerticalGapLineHeightMultiplier: 0.8,
  edgeMarginLineHeightMultiplier: 0.75,
  maxVerticalGaps: 8,
  smoothRadius: 3,
  projectionProfileThreshold: 0,
};

export class GridDetector {
  private readonly settings: GridSettings;

  constructor(options: Partial<GridSettings> = {}) {
    this.settings = { ...defaultGridSettings, ...options };
  }

  /**
   * Analyzes a set of rectangles to detect grid-like structures.
   *
   * @param rects - The bounding rectangles of all text spans on the page.
   * @param pageRect - The bounding rectangle for the entire page.
   * @param estimatedLineHeight - The estimated line height, used for dynamic thresholding.
   * @returns A GridAnalysis object, or null if no grid is detected.
   */
  public detectGrid(
    rects: BoundingRect[],
    pageRect: DOMRect,
    estimatedLineHeight: number
  ): GridAnalysis | null {
    if (!rects || rects.length < 2) {
      return null;
    }

    // 1. Create projection profiles to find whitespace.
    const horizontalProfileRaw = this.createProjectionProfile(rects, pageRect, 'horizontal');
    const verticalProfileRaw = this.createProjectionProfile(rects, pageRect, 'vertical');
    const horizontalProfile = this.smoothProfile(horizontalProfileRaw, this.settings.smoothRadius);
    const verticalProfile = this.smoothProfile(verticalProfileRaw, this.settings.smoothRadius);

    // 2. Identify significant gaps in the profiles.
    const minGapHeight = estimatedLineHeight * this.settings.minHorizontalGapLineHeightMultiplier;
    const edgeMargin = Math.max(2, Math.round(estimatedLineHeight * this.settings.edgeMarginLineHeightMultiplier));
    const emptyThreshold = this.settings.projectionProfileThreshold;
    const horizontalGaps = this.findGapsInProfile(horizontalProfile, minGapHeight, emptyThreshold)
      .filter(g => g.start > edgeMargin && (g.start + g.length) < (horizontalProfile.length - edgeMargin));
    
    // For vertical gaps, keep only persistent separators and ignore margin whitespace.
    const verticalMinGap = Math.max(4, estimatedLineHeight * this.settings.minVerticalGapLineHeightMultiplier);
    const verticalGaps = this.findGapsInProfile(verticalProfile, verticalMinGap, emptyThreshold)
      .filter(g => g.start > edgeMargin && (g.start + g.length) < (verticalProfile.length - edgeMargin))
      .sort((a, b) => b.length - a.length)
      .slice(0, Math.max(1, this.settings.maxVerticalGaps));

    // 3. Convert these gaps into grid line representations.
    const horizontalLines: GridLine[] = horizontalGaps.map(gap => ({
      position: pageRect.top + gap.start + gap.length / 2, // Midpoint of the gap
      start: pageRect.left,
      end: pageRect.right,
      thickness: gap.length,
    }));

    const verticalLines: GridLine[] = verticalGaps.map(gap => ({
      position: pageRect.left + gap.start + gap.length / 2, // Midpoint
      start: pageRect.top,
      end: pageRect.bottom,
      thickness: gap.length,
    }));

    // Accept vertical-only detections too: many real pages have strong column gutters
    // without strong horizontal separators.
    if (horizontalLines.length === 0 && verticalLines.length === 0) {
      return null;
    }

    return { horizontalLines, verticalLines };
  }

  /**
   * Creates a projection profile (a histogram of span-count occupancy).
   * @param rects - The rectangles to project.
   * @param pageRect - The bounds of the page.
   * @param orientation - 'horizontal' to scan rows, 'vertical' to scan columns.
   * @returns An array of numbers representing the profile.
   */
  private createProjectionProfile(
    rects: BoundingRect[],
    pageRect: DOMRect,
    orientation: 'horizontal' | 'vertical'
  ): number[] {
    const isHorizontal = orientation === 'horizontal';
    const profileSize = Math.ceil(isHorizontal ? pageRect.height : pageRect.width);
    const profile = new Array(profileSize).fill(0);
    const offset = isHorizontal ? pageRect.top : pageRect.left;

    for (const rect of rects) {
      const start = Math.floor((isHorizontal ? rect.top : rect.left) - offset);
      const end = Math.ceil((isHorizontal ? rect.bottom : rect.right) - offset);
      for (let i = start; i < end; i++) {
        if (i >= 0 && i < profileSize) {
          profile[i] += 1;
        }
      }
    }
    return profile;
  }

  /**
   * Finds continuous sequences of near-zero values in a profile.
   * @param profile - The projection profile array.
   * @param minGapSize - The minimum length for a gap to be considered significant.
   * @returns An array of detected gaps with their start and length.
   */
  private findGapsInProfile(
    profile: number[],
    minGapSize: number,
    emptyThreshold: number
  ): { start: number; length: number }[] {
    const gaps: { start: number; length: number }[] = [];
    let gapStart = -1;

    for (let i = 0; i < profile.length; i++) {
      if (profile[i] <= emptyThreshold) {
        if (gapStart === -1) {
          gapStart = i;
        }
      } else {
        if (gapStart !== -1) {
          const gapLength = i - gapStart;
          if (gapLength >= minGapSize) {
            gaps.push({ start: gapStart, length: gapLength });
          }
          gapStart = -1;
        }
      }
    }

    // Handle a gap that might extend to the end of the profile
    if (gapStart !== -1) {
      const gapLength = profile.length - gapStart;
      if (gapLength >= minGapSize) {
        gaps.push({ start: gapStart, length: gapLength });
      }
    }
    return gaps;
  }

  private smoothProfile(profile: number[], radius: number): number[] {
    if (radius <= 0 || profile.length <= 2) return profile;
    const out = new Array(profile.length).fill(0);
    for (let i = 0; i < profile.length; i++) {
      let sum = 0;
      let count = 0;
      const from = Math.max(0, i - radius);
      const to = Math.min(profile.length - 1, i + radius);
      for (let j = from; j <= to; j++) {
        sum += profile[j];
        count++;
      }
      out[i] = count > 0 ? sum / count : profile[i];
    }
    return out;
  }

}
