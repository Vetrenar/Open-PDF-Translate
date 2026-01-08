// grid-detector.ts

import { BoundingRect } from './layout-detector'; // Assumes BoundingRect is exported

/**
 * Represents a detected horizontal or vertical line in a grid.
 */
export interface GridLine {
  position: number; // The y-coordinate for horizontal lines, or x-coordinate for vertical lines.
  start: number;    // The starting coordinate of the line (e.g., pageRect.left).
  end: number;      // The ending coordinate of the line (e.g., pageRect.right).
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
  // The threshold (number of pixels) to consider a projection profile value as "empty".
  projectionProfileThreshold: number;
}

export const defaultGridSettings: GridSettings = {
  minHorizontalGapLineHeightMultiplier: 1.5,
  projectionProfileThreshold: 1, // A very low threshold; any pixel presence counts.
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
    const horizontalProfile = this.createProjectionProfile(rects, pageRect, 'horizontal');
    const verticalProfile = this.createProjectionProfile(rects, pageRect, 'vertical');

    // 2. Identify significant gaps in the profiles.
    const minGapHeight = estimatedLineHeight * this.settings.minHorizontalGapLineHeightMultiplier;
    const horizontalGaps = this.findGapsInProfile(horizontalProfile, minGapHeight);
    
    // For vertical gaps, we can use a simpler threshold, like the line height itself.
    const verticalGaps = this.findGapsInProfile(verticalProfile, estimatedLineHeight);

    // 3. Convert these gaps into grid line representations.
    const horizontalLines: GridLine[] = horizontalGaps.map(gap => ({
      position: pageRect.top + gap.start + gap.length / 2, // Midpoint of the gap
      start: pageRect.left,
      end: pageRect.right,
    }));

    const verticalLines: GridLine[] = verticalGaps.map(gap => ({
      position: pageRect.left + gap.start + gap.length / 2, // Midpoint
      start: pageRect.top,
      end: pageRect.bottom,
    }));

    // A simple heuristic: if there are no horizontal lines, it's not a grid we're looking for.
    if (horizontalLines.length === 0) {
      return null;
    }

    return { horizontalLines, verticalLines };
  }

  /**
   * Creates a projection profile (a histogram of pixel occupancy).
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
      const value = isHorizontal ? rect.width : rect.height;

      for (let i = start; i < end; i++) {
        if (i >= 0 && i < profileSize) {
          profile[i] += value; // We can weight by size for more robustness
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
  private findGapsInProfile(profile: number[], minGapSize: number): { start: number; length: number }[] {
    const gaps: { start: number; length: number }[] = [];
    let gapStart = -1;

    for (let i = 0; i < profile.length; i++) {
      if (profile[i] < this.settings.projectionProfileThreshold) {
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
}