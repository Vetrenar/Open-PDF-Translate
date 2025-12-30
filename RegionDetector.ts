/**
 * @file RegionDetector.ts
 *
 * This file contains the re-engineered logic for detecting and segmenting vertical layout regions.
 * It uses an efficient sampling method and a robust consolidation pass to improve
 * performance and accuracy in identifying areas with consistent column structures.
 */

export interface SimpleRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export interface LayoutSegment {
    top: number;
    bottom: number;
    left: number;
    right: number;
    /** The number of columns detected in this segment. */
    columns: number;
}

interface DensityPoint {
    y: number;
    cols: number;
    left: number;
    right: number;
}

/**
 * Configuration options for tuning region detection.
 */
interface DetectionOptions {
    /** Multiplier for avgLineHeight to determine a column gap. */
    columnGapMultiplier: number;
    /** Horizontal shift required to trigger a layout change, as a multiplier of avgLineHeight. */
    shiftMultiplier: number;
    /** Minimum height of a segment, as a multiplier of avgLineHeight. */
    minSegmentHeightMultiplier: number;
}

const DEFAULT_OPTIONS: DetectionOptions = {
    columnGapMultiplier: 2.0,
    shiftMultiplier: 4.0,
    minSegmentHeightMultiplier: 2.0,
};

/**
 * Segments the page into vertical regions with consistent layout patterns.
 * This orchestrated function calls helpers to perform sampling, change point detection,
 * and segment consolidation.
 *
 * @param spanRects - An array of DOMRect objects for all text spans on the page.
 * @param pageRect - The DOMRect for the entire page container.
 * @param avgLineHeight - The average line height, used for thresholding.
 * @returns An array of LayoutSegment objects, each defining a region.
 */
export function segmentVerticalLayouts(
    spanRects: DOMRect[],
    pageRect: DOMRect,
    avgLineHeight: number
): LayoutSegment[] {
    if (!pageRect || spanRects.length === 0) {
        return [{
            top: pageRect?.top || 0,
            bottom: pageRect?.bottom || 0,
            left: pageRect?.left || 0,
            right: pageRect?.right || 0,
            columns: 1
        }];
    }

    const sortedSpans = [...spanRects].sort((a, b) => a.top - b.top);

    // 1. Create a vertical density profile of the page using an efficient sampling method.
    const densityPoints = _sampleDensityProfile(sortedSpans, pageRect, avgLineHeight, DEFAULT_OPTIONS);
    if (densityPoints.length === 0) {
        return [{
            top: pageRect.top, bottom: pageRect.bottom,
            left: pageRect.left, right: pageRect.right, columns: 1
        }];
    }

    // 2. Identify all points where the layout appears to change.
    const changePoints = _findChangePoints(densityPoints, pageRect, avgLineHeight, DEFAULT_OPTIONS);

    // 3. Consolidate the raw change points into clean, coherent segments. This filters out noise.
    const consolidated = _consolidateSegments(changePoints, avgLineHeight, DEFAULT_OPTIONS);

    // 4. Finalize segments by adding a buffer and ensuring they are valid.
    const finalSegments: LayoutSegment[] = [];
    for (const segment of consolidated) {
        const buffer = Math.min(avgLineHeight * 0.5, (segment.bottom - segment.top) * 0.1);
        finalSegments.push({
            ...segment,
            top: Math.max(pageRect.top, segment.top - buffer),
            bottom: Math.min(pageRect.bottom, segment.bottom + buffer),
        });
    }

    return finalSegments.length > 0 ? finalSegments : [{
        top: pageRect.top, bottom: pageRect.bottom,
        left: pageRect.left, right: pageRect.right, columns: 1
    }];
}

/**
 * Scans the page vertically to create a profile of layout characteristics using an
 * efficient advancing-pointer algorithm.
 * @private
 */
function _sampleDensityProfile(
    sortedSpans: DOMRect[],
    pageRect: DOMRect,
    avgLineHeight: number,
    options: DetectionOptions
): DensityPoint[] {
    const densityPoints: DensityPoint[] = [];
    const step = Math.max(5, avgLineHeight * 0.5);
    let spanIndex = 0;
    const activeSpans: DOMRect[] = [];

    for (let y = pageRect.top; y < pageRect.bottom; y += step) {
        // Remove spans that are no longer in the current sampling window
        for (let i = activeSpans.length - 1; i >= 0; i--) {
            if (activeSpans[i].bottom < y) {
                activeSpans.splice(i, 1);
            }
        }

        // Add spans that have entered the sampling window
        while (spanIndex < sortedSpans.length && sortedSpans[spanIndex].top <= y) {
            if (sortedSpans[spanIndex].bottom >= y) {
                activeSpans.push(sortedSpans[spanIndex]);
            }
            spanIndex++;
        }

        if (activeSpans.length > 0) {
            const colCount = _countColumnsHistogram(activeSpans, options.columnGapMultiplier * avgLineHeight);
            densityPoints.push({
                y,
                cols: colCount,
                left: Math.min(...activeSpans.map(s => s.left)),
                right: Math.max(...activeSpans.map(s => s.right)),
            });
        }
    }
    return densityPoints;
}

/**
 * Counts columns using a histogram of left coordinates for better accuracy.
 * @private
 */
function _countColumnsHistogram(spans: DOMRect[], gapThreshold: number): number {
    if (spans.length === 0) return 0;
    if (spans.length === 1) return 1;

    const leftCoords = spans.map(s => s.left).sort((a, b) => a - b);
    const columns = [leftCoords[0]];

    for (let i = 1; i < leftCoords.length; i++) {
        const currentLeft = leftCoords[i];
        // Find the closest existing column
        const closestCol = columns.reduce((prev, curr) =>
            (Math.abs(curr - currentLeft) < Math.abs(prev - currentLeft) ? curr : prev)
        );

        // If it's too far from the closest column, it's a new column.
        if (Math.abs(currentLeft - closestCol) > gapThreshold) {
            columns.push(currentLeft);
        }
    }
    return columns.length;
}

/**
 * Identifies points in the density profile where layout characteristics change significantly.
 * @private
 */
function _findChangePoints(
    densityPoints: DensityPoint[],
    pageRect: DOMRect,
    avgLineHeight: number,
    options: DetectionOptions
): LayoutSegment[] {
    const segments: LayoutSegment[] = [];
    if (densityPoints.length === 0) return [];

    let lastPoint = densityPoints[0];
    segments.push({
        top: pageRect.top,
        bottom: lastPoint.y,
        left: lastPoint.left,
        right: lastPoint.right,
        columns: lastPoint.cols,
    });

    for (let i = 1; i < densityPoints.length; i++) {
        const currPoint = densityPoints[i];
        const colChange = currPoint.cols !== lastPoint.cols;
        const leftShift = Math.abs(currPoint.left - lastPoint.left) > options.shiftMultiplier * avgLineHeight;
        const rightShift = Math.abs(currPoint.right - lastPoint.right) > options.shiftMultiplier * avgLineHeight;

        if (colChange || leftShift || rightShift) {
            segments.push({
                top: lastPoint.y,
                bottom: currPoint.y,
                left: currPoint.left,
                right: currPoint.right,
                columns: currPoint.cols
            });
            lastPoint = currPoint;
        }
    }

    segments[segments.length - 1].bottom = pageRect.bottom;
    return segments;
}

/**
 * Merges and filters the raw segment list to produce a clean, coherent set of layout regions.
 * @private
 */
function _consolidateSegments(
    segments: LayoutSegment[],
    avgLineHeight: number,
    options: DetectionOptions
): LayoutSegment[] {
    if (segments.length === 0) return [];

    const consolidated: LayoutSegment[] = [];
    let currentSegment = { ...segments[0] };

    for (let i = 1; i < segments.length; i++) {
        const nextSegment = segments[i];
        const height = currentSegment.bottom - currentSegment.top;

        // If the current segment is too short, merge it with the next one.
        if (height < options.minSegmentHeightMultiplier * avgLineHeight) {
            currentSegment.bottom = nextSegment.bottom;
            currentSegment.right = Math.max(currentSegment.right, nextSegment.right); // Take widest bounds
            currentSegment.left = Math.min(currentSegment.left, nextSegment.left);
            continue;
        }

        // If the next segment has the same column count, merge it.
        if (nextSegment.columns === currentSegment.columns) {
            currentSegment.bottom = nextSegment.bottom;
            currentSegment.right = Math.max(currentSegment.right, nextSegment.right);
            currentSegment.left = Math.min(currentSegment.left, nextSegment.left);
        } else {
            consolidated.push(currentSegment);
            currentSegment = { ...nextSegment };
        }
    }
    consolidated.push(currentSegment);

    // Final filter for valid segments
    return consolidated.filter(s => s.bottom - s.top > options.minSegmentHeightMultiplier * avgLineHeight);
}