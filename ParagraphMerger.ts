// ParagraphMerger.ts
import type { VerticalStrip, HorizontalBand } from './GapDetector';
import type { SpanInfo } from './Snapshot';
import type { LayoutSettings } from './layout-modal';

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export class ParagraphMerger {
  // Use the settings from LayoutSettings
  private lineHeightMultiplier: number;
  private debugValidation: boolean;
  
  // New Flag
  private forceLinearMerge: boolean;

  private minStripConfidenceSplit: number;
  private minStripWidthPx: number;
  private minStripOverlapFrac: number;
  private initialMergeBaselineTolNonMath: number;
  private initialMergeBaselineTolMath: number;
  private initialMergeKernTolNonMath: number;
  private initialMergeKernTolMath: number;
  private hyphenContinuationTol: number;
  private initialMergeAlignTolNonMath: number;
  private initialMergeAlignTolMath: number;
  private initialMergeVerticalGapMultiplier: number;
  private initialMergeVerticalGapMaxMultiplier: number;
  private stackedMergeAlignTol: number;
  private stackedMergeOverlapFrac: number;
  private stackedMergeVerticalGapMultiplier: number;
  private stackedMergeVerticalGapMaxMultiplier: number;
  private generalMergeAlignTol: number;
  private generalMergeOverlapFrac: number;
  private generalMergeVerticalGapMultiplier: number;
  private generalMergeVerticalGapMaxMultiplier: number;
  private nestedMergeOverlapFrac: number;
  private stitchBaselineTolNonMath: number;
  private stitchBaselineTolMath: number;
  private stitchKernTolNonMath: number;
  private stitchKernTolMath: number;
  private inlineSpanBaselineTol: number;
  private inlineSpanKernTol: number;
  private sameColumnCoverageRatio: number;
  private mathMergeBaselineTol: number;
  private mathMergeHorizTol: number;
  private mathMergeCenterTol: number;
  private splitLineHeightTol: number;
  private splitBoundaryDedupTol: number;
  private splitInterWordGapTol: number;
  private splitColumnGapTol: number;

  // Configurable properties for inline span merging
  private inlineSpanMaxWeightDiff: number;
  private inlineSpanAllowMixedStyle: boolean;

  constructor(settings: LayoutSettings) {
    // Assign settings from the passed object
    this.lineHeightMultiplier = settings.lineHeightMultiplier;
    this.debugValidation = settings.debugValidation;
    
    // NEW: Capture the force linear merge flag
    this.forceLinearMerge = settings.pmForceLinearMerge;

    this.minStripConfidenceSplit = settings.pmMinStripConfidenceSplit;
    this.minStripWidthPx = settings.pmMinStripWidthPx;
    this.minStripOverlapFrac = settings.pmMinStripOverlapFrac;
    this.initialMergeBaselineTolNonMath = settings.pmInitialMergeBaselineTolNonMath;
    this.initialMergeBaselineTolMath = settings.pmInitialMergeBaselineTolMath;
    this.initialMergeKernTolNonMath = settings.pmInitialMergeKernTolNonMath;
    this.initialMergeKernTolMath = settings.pmInitialMergeKernTolMath;
    this.hyphenContinuationTol = settings.pmHyphenContinuationTol;
    this.initialMergeAlignTolNonMath = settings.pmInitialMergeAlignTolNonMath;
    this.initialMergeAlignTolMath = settings.pmInitialMergeAlignTolMath;
    this.initialMergeVerticalGapMultiplier = settings.pmInitialMergeVerticalGapMultiplier;
    this.initialMergeVerticalGapMaxMultiplier = settings.pmInitialMergeVerticalGapMaxMultiplier;
    this.stackedMergeAlignTol = settings.pmStackedMergeAlignTol;
    this.stackedMergeOverlapFrac = settings.pmStackedMergeOverlapFrac;
    this.stackedMergeVerticalGapMultiplier = settings.pmStackedMergeVerticalGapMultiplier;
    this.stackedMergeVerticalGapMaxMultiplier = settings.pmStackedMergeVerticalGapMaxMultiplier;
    this.generalMergeAlignTol = settings.pmGeneralMergeAlignTol;
    this.generalMergeOverlapFrac = settings.pmGeneralMergeOverlapFrac;
    this.generalMergeVerticalGapMultiplier = settings.pmGeneralMergeVerticalGapMultiplier;
    this.generalMergeVerticalGapMaxMultiplier = settings.pmGeneralMergeVerticalGapMaxMultiplier;
    this.nestedMergeOverlapFrac = settings.pmNestedMergeOverlapFrac;
    this.stitchBaselineTolNonMath = settings.pmStitchBaselineTolNonMath;
    this.stitchBaselineTolMath = settings.pmStitchBaselineTolMath;
    this.stitchKernTolNonMath = settings.pmStitchKernTolNonMath;
    this.stitchKernTolMath = settings.pmStitchKernTolMath;
    this.inlineSpanBaselineTol = settings.pmInlineSpanBaselineTol;
    this.inlineSpanKernTol = settings.pmInlineSpanKernTol;
    this.sameColumnCoverageRatio = settings.pmSameColumnCoverageRatio;
    this.mathMergeBaselineTol = settings.pmMathMergeBaselineTol;
    this.mathMergeHorizTol = settings.pmMathMergeHorizTol;
    this.mathMergeCenterTol = settings.pmMathMergeCenterTol;
    this.splitLineHeightTol = settings.pmSplitLineHeightTol;
    this.splitBoundaryDedupTol = settings.pmSplitBoundaryDedupTol;
    this.splitInterWordGapTol = settings.pmSplitInterWordGapTol;
    this.splitColumnGapTol = settings.pmSplitColumnGapTol;

    this.inlineSpanMaxWeightDiff = settings.pmInlineSpanMaxWeightDiff;
    this.inlineSpanAllowMixedStyle = settings.pmInlineSpanAllowMixedStyle;
  }

  // 1) Initial span-to-paragraph grouping (math-aware), no DOM calls
  public mergeIntoParagraphsFromInfos(spanInfos: Map<HTMLSpanElement, SpanInfo>): HTMLSpanElement[][] {
    const spans = [...spanInfos.keys()];
    const ordered = spans.sort((a, b) => {
      const ia = spanInfos.get(a)!.rect;
      const ib = spanInfos.get(b)!.rect;
      return ia.top - ib.top || ia.left - ib.left;
    });

    const paragraphs: HTMLSpanElement[][] = [];
    let current: HTMLSpanElement[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i];
      const ci = spanInfos.get(cur)!;

      if (!current.length) {
        current.push(cur);
        continue;
      }

      const prev = current[current.length - 1];
      const pi = spanInfos.get(prev)!;

      // Use style match logic (which now respects forceLinearMerge)
      const sameStyle = this.stylesMatch(ci, pi, true);
      const maxFontSize = Math.max(ci.style.fontSize, pi.style.fontSize);
      const minF = Math.min(ci.style.fontSize, pi.style.fontSize);

      const baseTol = minF * (ci.isMathElement || pi.isMathElement ? this.initialMergeBaselineTolMath : this.initialMergeBaselineTolNonMath);
      const sameBaseline = Math.abs(ci.rect.bottom - pi.rect.bottom) < baseTol;

      const isRTL = ci.style.direction === 'rtl' || pi.style.direction === 'rtl';
      const dx = ci.rect.left - pi.rect.right;
      const kernTol = minF * (ci.isMathElement || pi.isMathElement ? this.initialMergeKernTolMath : this.initialMergeKernTolNonMath);
      const smallInlineKerning = sameBaseline &&
        (isRTL ? dx <= 0 && dx > -kernTol : dx >= 0 && dx < kernTol);

      const prevText = (pi.text || '').trim();
      const endsWithHyphen = /[\u00AD-]$/.test(prevText);

      const hyphenContinuation =
        endsWithHyphen &&
        ci.rect.top > pi.rect.top &&
        Math.abs(ci.rect.left - pi.rect.left) < ci.style.fontSize * this.hyphenContinuationTol;

      const leftAlignTol = minF * (ci.isMathElement || pi.isMathElement ? this.initialMergeAlignTolMath : this.initialMergeAlignTolNonMath);
      const rightAlignTol = leftAlignTol;
      const leftAligned = Math.abs(ci.rect.left - pi.rect.left) < leftAlignTol;
      const rightAligned = Math.abs(ci.rect.right - pi.rect.right) < rightAlignTol;

      const lineHeightGuess = maxFontSize * this.lineHeightMultiplier;
      const verticalTolerance = Math.min(
        lineHeightGuess * this.initialMergeVerticalGapMultiplier,
        maxFontSize * this.initialMergeVerticalGapMaxMultiplier
      );
      const verticalGap = ci.rect.top - pi.rect.bottom;

      if (
        sameStyle &&
        (
          (verticalGap <= verticalTolerance && (leftAligned || rightAligned)) ||
          smallInlineKerning ||
          hyphenContinuation
        )
      ) {
        current.push(cur);
      } else {
        paragraphs.push(current);
        current = [cur];
      }
    }

    if (current.length) paragraphs.push(current);
    return paragraphs;
  }

  // 2) Split paragraphs if they cross vertical strips (with noise gating)
  public validateParagraphsAgainstStripsFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>,
    verticalStrips: VerticalStrip[] = [],
    lineHeight: number = 0,
    viewportWidth: number
  ): HTMLSpanElement[][] {
    // OVERHAUL: If forcing linear merge, skip all column splitting
    if (this.forceLinearMerge) {
      return paragraphs;
    }

    if (!verticalStrips?.length) return paragraphs;
    const results: HTMLSpanElement[][] = [];

    const filteredStrips = this.filterStrips(verticalStrips, viewportWidth);

    if (!filteredStrips.length) return paragraphs;

    for (const para of paragraphs) {
      const parts = this.splitParagraphByStrips(para, spanInfos, filteredStrips, lineHeight);
      results.push(...parts);
    }

    return results;
  }

  // 3) Merge vertically stacked paragraphs within the same column and style, respecting gaps
  public mergeParagraphsFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>,
    lineHeight: number,
    verticalStrips: VerticalStrip[] = [],
    horizontalBands: HorizontalBand[] = [],
    viewportWidth: number
  ): HTMLSpanElement[][] {
    const merged: HTMLSpanElement[][] = [];
    const used = new Set<number>();
    const filteredStrips = this.filterStrips(verticalStrips, viewportWidth);

    for (let i = 0; i < paragraphs.length; i++) {
      if (used.has(i)) continue;
      let current = [...paragraphs[i]];
      const currStyle = spanInfos.get(current[0])!.style;
      const currBbox = this.getParaBbox(current, spanInfos);

      for (let j = i + 1; j < paragraphs.length; j++) {
        if (used.has(j)) continue;
        const next = paragraphs[j];
        const nextStyle = spanInfos.get(next[0])!.style;

        if (!this.stylesMatchStyle(currStyle, nextStyle, true)) continue;

        const nextBbox = this.getParaBbox(next, spanInfos);

        // Checks for column alignment and horizontal bands (both now respect forceLinearMerge)
        if (!this.sameColumnByStrips(currBbox, nextBbox, filteredStrips)) continue;
        if (this.hasHorizontalBandBetween(currBbox, nextBbox, horizontalBands)) continue;

        const verticalGap = nextBbox.top - currBbox.bottom;
        const horizontalOverlap = currBbox.left < nextBbox.right && currBbox.right > nextBbox.left;
        const overlapWidth = Math.max(0, Math.min(currBbox.right, nextBbox.right) - Math.max(currBbox.left, nextBbox.left));
        const minParaWidth = Math.max(1, Math.min(currBbox.width, nextBbox.width));
        const overlapStrong = horizontalOverlap && overlapWidth > this.generalMergeOverlapFrac * minParaWidth;

        const leftAlignTol = currStyle.fontSize * this.generalMergeAlignTol;
        const leftAligned = Math.abs(currBbox.left - nextBbox.left) < leftAlignTol;
        const rightAligned = Math.abs(currBbox.right - nextBbox.right) < leftAlignTol;
        const aligned = leftAligned || rightAligned;

        // In forced mode, the layout/alignment checks matter less, but we usually rely on vertical gap
        // to prevent header -> footer merges. The User should increase gap multipliers in settings if
        // they want to bridge large gaps.
        const mergeThreshold = Math.min(lineHeight * this.generalMergeVerticalGapMultiplier, Math.max(currStyle.fontSize, nextStyle.fontSize) * this.generalMergeVerticalGapMaxMultiplier);
        
        // In force mode, we are more permissive about alignment if the gap is small enough
        const permissiveAlignment = this.forceLinearMerge || (aligned || overlapStrong);

        if (verticalGap <= mergeThreshold && permissiveAlignment) {
          current.push(...next);
          used.add(j);
          const newBbox = this.getParaBbox(current, spanInfos);
          Object.assign(currBbox, newBbox);
        }
      }

      merged.push(current);
      used.add(i);
    }

    return merged;
  }

  // 3.5) Merge stacked column-aligned paragraphs (final stacked pass)
  public mergeStackedColumnParagraphsFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>,
    lineHeight: number,
    verticalStrips: VerticalStrip[] = [],
    horizontalBands: HorizontalBand[] = [],
    viewportWidth: number
  ): HTMLSpanElement[][] {
    if (!paragraphs.length) return paragraphs;

    type PInfo = {
      spans: HTMLSpanElement[];
      bbox: RectLike;
      style: SpanInfo['style'];
      isMath: boolean;
    };

    const filteredStrips = this.filterStrips(verticalStrips, viewportWidth);
    const infos: PInfo[] = paragraphs.map(spans => {
      const bbox = this.getParaBbox(spans, spanInfos);
      const style = spanInfos.get(spans[0])!.style;
      const isMath = spans.some(s => spanInfos.get(s)!.isMathElement);
      return { spans, bbox, style, isMath };
    });

    infos.sort((a, b) => a.bbox.top - b.bbox.top || a.bbox.left - b.bbox.left);

    let changed = true;
    while (changed) {
      changed = false;
      const used = new Set<number>();
      const out: PInfo[] = [];

      for (let i = 0; i < infos.length; i++) {
        if (used.has(i)) continue;
        let base = infos[i];

        for (let j = i + 1; j < infos.length; j++) {
          if (used.has(j)) continue;
          const cand = infos[j];

          if (!this.stylesMatchStyle(base.style, cand.style, true)) continue;

          if (!this.sameColumnByStrips(base.bbox, cand.bbox, filteredStrips)) continue;
          if (this.hasHorizontalBandBetween(base.bbox, cand.bbox, horizontalBands)) continue;

          const verticalGap = cand.bbox.top - base.bbox.bottom;
          if (verticalGap < 0) continue;

          const horizontalOverlap = base.bbox.left < cand.bbox.right && base.bbox.right > cand.bbox.left;
          const overlapWidth = Math.max(0, Math.min(base.bbox.right, cand.bbox.right) - Math.max(base.bbox.left, cand.bbox.left));
          const minParaWidth = Math.max(1, Math.min(base.bbox.width, cand.bbox.width));
          const overlapStrong = horizontalOverlap && overlapWidth > this.stackedMergeOverlapFrac * minParaWidth;

          const leftAlignTol = Math.max(1, Math.min(base.style.fontSize, cand.style.fontSize) * this.stackedMergeAlignTol);
          const leftAligned = Math.abs(base.bbox.left - cand.bbox.left) < leftAlignTol;
          const rightAligned = Math.abs(base.bbox.right - cand.bbox.right) < leftAlignTol;
          const aligned = leftAligned || rightAligned;

          const maxFontSize = Math.max(base.style.fontSize, cand.style.fontSize);
          const mergeThreshold = Math.min(lineHeight * this.stackedMergeVerticalGapMultiplier, maxFontSize * this.stackedMergeVerticalGapMaxMultiplier);
          
          const permissiveAlignment = this.forceLinearMerge || (aligned || overlapStrong);

          if (permissiveAlignment && verticalGap <= mergeThreshold) {
            const combinedSpans = [...base.spans, ...cand.spans]
              .map(s => ({ s, r: spanInfos.get(s)!.rect }))
              .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
              .map(x => x.s);

            base = {
              spans: combinedSpans,
              bbox: this.getParaBbox(combinedSpans, spanInfos),
              style: base.style,
              isMath: combinedSpans.some(s => spanInfos.get(s)!.isMathElement)
            };

            used.add(j);
            changed = true;
          }
        }

        out.push(base);
        used.add(i);
      }

      if (changed) {
        infos.length = 0;
        infos.push(...out.sort((a, b) => a.bbox.top - b.bbox.top || a.bbox.left - b.bbox.left));
      } else {
        return out.map(p => p.spans);
      }
    }

    return paragraphs;
  }

  // 4) Single-pass nested/overlap merging, math-aware, respecting strips
  public mergeNestedParagraphsOnceFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>,
    verticalStrips: VerticalStrip[] = [],
    horizontalBands: HorizontalBand[] = [],
    viewportWidth: number
  ): { paragraphs: HTMLSpanElement[][]; changed: boolean } {
    if (!paragraphs.length) return { paragraphs, changed: false };

    type PInfo = {
      spans: HTMLSpanElement[];
      bbox: RectLike;
      style: SpanInfo['style'];
      isMath: boolean;
      text: string;
    };

    const filteredStrips = this.filterStrips(verticalStrips, viewportWidth);
    const infos: PInfo[] = paragraphs.map(p => {
      const bbox = this.getParaBbox(p, spanInfos);
      const style = spanInfos.get(p[0])!.style;
      const isMath = p.some(s => spanInfos.get(s)!.isMathElement);
      const text = p.map(s => spanInfos.get(s)!.text).join('');
      return { spans: [...p], bbox, style, isMath, text };
    });

    let changed = false;
    const used = new Set<number>();
    const out: HTMLSpanElement[][] = [];

    for (let i = 0; i < infos.length; i++) {
      if (used.has(i)) continue;
      let base = infos[i];
      let merged = false;

      for (let j = 0; j < infos.length; j++) {
        if (i === j || used.has(j)) continue;
        const cand = infos[j];

        if (!this.stylesMatchStyle(base.style, cand.style, true)) continue;

        if (!this.sameColumnByStrips(base.bbox, cand.bbox, filteredStrips)) continue;
        if (this.hasHorizontalBandBetween(base.bbox, cand.bbox, horizontalBands)) continue;

        const containsIJ = this.rectContains(base.bbox, cand.bbox, 1);
        const containsJI = this.rectContains(cand.bbox, base.bbox, 1);
        let strongOverlap = false;

        if (!containsIJ && !containsJI) {
          const inter = this.rectIntersection(base.bbox, cand.bbox);
          if (inter) {
            const interArea = inter.width * inter.height;
            const smaller = Math.min(this.area(base.bbox), this.area(cand.bbox)) || 1;
            strongOverlap = interArea / smaller > this.nestedMergeOverlapFrac;
          }
        }

        const mathMerge = (base.isMath || cand.isMath) && this.isMathMergeCandidate(base, cand, filteredStrips);

        if (containsIJ || containsJI || strongOverlap || mathMerge) {
          const baseLarger = this.area(base.bbox) >= this.area(cand.bbox);
          const keep = baseLarger ? base : cand;
          const add = baseLarger ? cand : base;

          const combined = [...keep.spans, ...add.spans]
            .map(s => ({ s, r: spanInfos.get(s)!.rect }))
            .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
            .map(x => x.s);

          base = {
            spans: combined,
            bbox: this.getParaBbox(combined, spanInfos),
            style: keep.style,
            isMath: combined.some(s => spanInfos.get(s)!.isMathElement),
            text: combined.map(s => spanInfos.get(s)!.text).join('')
          };

          used.add(i);
          used.add(j);
          merged = true;
          changed = true;
          break;
        }
      }

      out.push(base.spans);
      if (!merged) used.add(i);
    }

    return { paragraphs: out, changed };
  }

  // 5) Inline ligature/fragment stitching at same baseline
  public stitchInlineLigaturesFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>
  ): HTMLSpanElement[][] {
    if (!paragraphs.length) return paragraphs;

    const results: HTMLSpanElement[][] = [];

    for (const p of paragraphs) {
      if (p.length < 2) { results.push(p); continue; }

      const ordered = p
        .map(s => ({ s, info: spanInfos.get(s)! }))
        .sort((a, b) => a.info.rect.top - b.info.rect.top || a.info.rect.left - b.info.rect.left);

      const stitched: HTMLSpanElement[] = [];
      let group: HTMLSpanElement[] = [ordered[0].s];

      for (let i = 1; i < ordered.length; i++) {
        const prevI = ordered[i - 1].info;
        const curI = ordered[i].info;

        const sameStyle = this.stylesMatch(prevI, curI, true);
        const minF = Math.min(prevI.style.fontSize, curI.style.fontSize);

        const baseTol = minF * (prevI.isMathElement || curI.isMathElement ? this.stitchBaselineTolMath : this.stitchBaselineTolNonMath);
        const baselineClose = Math.abs(prevI.rect.bottom - curI.rect.bottom) < baseTol;

        const dx = curI.rect.left - prevI.rect.right;
        const kernTol = minF * (prevI.isMathElement || curI.isMathElement ? this.stitchKernTolMath : this.stitchKernTolNonMath);

        if (sameStyle && baselineClose && dx >= 0 && dx < kernTol) {
          group.push(ordered[i].s);
        } else {
          stitched.push(...group);
          group = [ordered[i].s];
        }
      }

      stitched.push(...group);
      results.push(stitched);
    }

    return results;
  }

  /**
   * Merge nested inline spans (cursive/bold) that share the same line and font family
   * back into their parent paragraphs.
   */
  public mergeNestedInlineSpansFromInfos(
    paragraphs: HTMLSpanElement[][],
    spanInfos: Map<HTMLSpanElement, SpanInfo>
  ): HTMLSpanElement[][] {
    if (!paragraphs.length) return paragraphs;

    const results: HTMLSpanElement[][] = [];

    for (const paragraph of paragraphs) {
      if (paragraph.length <= 1) {
        results.push([...paragraph]);
        continue;
      }

      const paraStyle = spanInfos.get(paragraph[0])!.style;

      const sortedSpans = [...paragraph].sort((a, b) => {
        const rectA = spanInfos.get(a)!.rect;
        const rectB = spanInfos.get(b)!.rect;
        return rectA.top - rectB.top || rectA.left - rectB.left;
      });

      const lines: HTMLSpanElement[][] = [];
      let currentLine: HTMLSpanElement[] = [];
      let currentLineTop = -Infinity;
      const lineHeightTolerance = paraStyle.fontSize * this.splitLineHeightTol;

      for (const span of sortedSpans) {
        const spanInfo = spanInfos.get(span)!;
        const spanTop = spanInfo.rect.top;

        if (currentLine.length === 0 || Math.abs(spanTop - currentLineTop) > lineHeightTolerance) {
          if (currentLine.length > 0) {
            lines.push(currentLine);
          }
          currentLine = [span];
          currentLineTop = spanTop;
        } else {
          currentLine.push(span);
        }
      }

      if (currentLine.length > 0) {
        lines.push(currentLine);
      }

      const mergedSpans: HTMLSpanElement[] = [];
      for (const line of lines) {
        if (line.length <= 1) {
          mergedSpans.push(...line);
          continue;
        }

        const lineSpans = [...line].sort((a, b) => {
          return spanInfos.get(a)!.rect.left - spanInfos.get(b)!.rect.left;
        });

        let currentGroup: HTMLSpanElement[] = [lineSpans[0]];

        for (let i = 1; i < lineSpans.length; i++) {
          const prevSpan = currentGroup[currentGroup.length - 1];
          const currentSpan = lineSpans[i];
          const prevInfo = spanInfos.get(prevSpan)!;
          const currentInfo = spanInfos.get(currentSpan)!;

          // Geometric checks
          const baselineTolerance = Math.min(prevInfo.style.fontSize, currentInfo.style.fontSize) * this.inlineSpanBaselineTol;
          const sameBaseline = Math.abs(prevInfo.rect.bottom - currentInfo.rect.bottom) < baselineTolerance;
          const horizontalGap = currentInfo.rect.left - prevInfo.rect.right;
          const kerningTolerance = Math.min(prevInfo.style.fontSize, currentInfo.style.fontSize) * this.inlineSpanKernTol;
          const closeHorizontally = Math.abs(horizontalGap) <= kerningTolerance;

          // Style check
          const stylesAreCompatible = this.stylesMatch(prevInfo, currentInfo, true);

          if (sameBaseline && closeHorizontally && stylesAreCompatible) {
            currentGroup.push(currentSpan);
          } else {
            mergedSpans.push(...this.mergeSpanGroup(currentGroup, spanInfos));
            currentGroup = [currentSpan];
          }
        }

        mergedSpans.push(...this.mergeSpanGroup(currentGroup, spanInfos));
      }

      results.push(mergedSpans);
    }

    return results;
  }

  // -----------------------
  // Internal helpers
  // -----------------------

  private getNumericFontWeight(weight: string | number): number {
    if (typeof weight === 'number') return weight;
    if (weight === 'normal') return 400;
    if (weight === 'bold') return 700;
    const numericWeight = parseInt(weight, 10);
    return isNaN(numericWeight) ? 400 : numericWeight;
  }

  private isCursiveOrBoldSpan(spanInfo: SpanInfo): boolean {
    const isCursive = spanInfo.style.fontStyle === 'italic' || spanInfo.style.fontStyle === 'oblique';
    const isBold = spanInfo.style.fontWeight === 'bold' ||
                   (typeof spanInfo.style.fontWeight === 'number' && spanInfo.style.fontWeight >= 600);
    return isCursive || isBold;
  }

  private mergeSpanGroup(
    spans: HTMLSpanElement[],
    spanInfos: Map<HTMLSpanElement, SpanInfo>
  ): HTMLSpanElement[] {
    return spans.sort((a, b) => {
      const rectA = spanInfos.get(a)!.rect;
      const rectB = spanInfos.get(b)!.rect;
      return rectA.top - rectB.top || rectA.left - rectB.left;
    });
  }

  private stylesMatch(a: SpanInfo, b: SpanInfo, mathAware = true): boolean {
    return this.stylesMatchStyle(a.style, b.style, mathAware);
  }

  /**
   * OVERHAULED: Matches styles, but strictly returns TRUE if forceLinearMerge is on.
   */
  private stylesMatchStyle(
    a: SpanInfo['style'],
    b: SpanInfo['style'],
    mathAware = true
  ): boolean {
    // OVERHAUL: Force linear merge bypass
    if (this.forceLinearMerge) return true;

    if (mathAware && (a.isMathElement || b.isMathElement)) {
      if (a.fontFamily !== b.fontFamily) return false;
      if (a.fontStyle !== b.fontStyle) return false;
      if (a.fontWeight !== b.fontWeight) return false;
      if (Math.abs(a.fontSize - b.fontSize) > 1.0) return false;
      const dist = Math.hypot(
        a.colorRGB[0] - b.colorRGB[0],
        a.colorRGB[1] - b.colorRGB[1],
        a.colorRGB[2] - b.colorRGB[2]
      );
      return dist < 10;
    }

    // Core properties check
    if (a.fontFamily !== b.fontFamily) return false;
    if (Math.abs(a.fontSize - b.fontSize) > 1.0) return false;
    const colorDist = Math.hypot(
      a.colorRGB[0] - b.colorRGB[0],
      a.colorRGB[1] - b.colorRGB[1],
      a.colorRGB[2] - b.colorRGB[2]
    );
    if (colorDist >= 10) return false;

    // Flexible weight check
    const weightDiff = Math.abs(
      this.getNumericFontWeight(a.fontWeight) -
      this.getNumericFontWeight(b.fontWeight)
    );
    if (weightDiff > this.inlineSpanMaxWeightDiff) {
      return false;
    }

    // Flexible style check
    if (!this.inlineSpanAllowMixedStyle && a.fontStyle !== b.fontStyle) {
      return false;
    }

    return true;
  }

  private getParaBbox(spans: HTMLSpanElement[], infos: Map<HTMLSpanElement, SpanInfo>): RectLike {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;

    for (const s of spans) {
      const r = infos.get(s)!.rect;
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }

    if (left === Infinity) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private sameColumnByStrips(a: RectLike, b: RectLike, strips: VerticalStrip[]): boolean {
    // OVERHAUL: If forced, we ignore column boundaries
    if (this.forceLinearMerge) return true;

    if (!strips?.length) {
      const horizontalOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const minWidth = Math.min(a.width, b.width) * 0.3;
      const maxReasonableColumnWidth = Math.max(a.width, b.width) * 3;
      const horizontalDistance = Math.abs((a.left + a.right)/2 - (b.left + b.right)/2);
      return horizontalOverlap > minWidth && horizontalDistance < maxReasonableColumnWidth;
    }

    const yTop = Math.min(a.top, b.top);
    const yBot = Math.max(a.bottom, b.bottom);
    const totalHeight = yBot - yTop;

    if (totalHeight <= 0) return true;

    const [leftPara, rightPara] = a.left < b.left ? [a, b] : [b, a];
    const horizontalOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const minWidthOverlap = Math.min(a.width, b.width) * 0.3;
    if (horizontalOverlap > minWidthOverlap) return true;

    const gapLeft = leftPara.right;
    const gapRight = rightPara.left;
    const gapWidth = gapRight - gapLeft;

    if (gapWidth <= 0) return true;

    let totalStripCoverage = 0;
    const minStripCoverage = Math.max(3, gapWidth * 0.1);
    const minVerticalAlignment = this.minStripOverlapFrac;

    for (const s of strips) {
      if (s.confidence < this.minStripConfidenceSplit) continue;
      if (s.right - s.left < this.minStripWidthPx) continue;

      const stripHeight = s.bottom - s.top;
      const yOverlap = Math.min(yBot, s.bottom) - Math.max(yTop, s.top);
      const verticalAlignment = yOverlap / stripHeight;
      if (verticalAlignment < minVerticalAlignment) continue;

      const stripInGap = Math.max(0,
        Math.min(s.right, gapRight) - Math.max(s.left, gapLeft)
      );

      if (stripInGap >= minStripCoverage) {
        totalStripCoverage += stripInGap;
      }
    }

    const coverageRatio = totalStripCoverage / gapWidth;
    return coverageRatio < this.sameColumnCoverageRatio;
  }

  private hasHorizontalBandBetween(a: RectLike, b: RectLike, bands: HorizontalBand[] = []): boolean {
    // OVERHAUL: If forced, ignore bands
    if (this.forceLinearMerge) return false;

    if (!bands?.length) return false;
    const top = Math.min(a.bottom, b.bottom);
    const bottom = Math.max(a.top, b.top);

    for (const band of bands) {
      if (band.confidence < 0.6) continue;
      const within = band.y > top && (band.y + band.height) < bottom;
      if (within) return true;
    }

    return false;
  }

  private rectContains(a: RectLike, b: RectLike, tol = 1): boolean {
    return a.left - tol <= b.left && a.right + tol >= b.right && a.top - tol <= b.top && a.bottom + tol >= b.bottom;
  }

  private rectIntersection(a: RectLike, b: RectLike): RectLike | null {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);

    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private area(r: RectLike): number {
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  private isMathMergeCandidate(
    a: { bbox: RectLike; style: SpanInfo['style']; isMath?: boolean; text?: string },
    b: { bbox: RectLike; style: SpanInfo['style']; isMath?: boolean; text?: string },
    strips: VerticalStrip[]
  ): boolean {
    const fontSize = Math.max(a.style.fontSize, b.style.fontSize) || 12;
    const verticalProximity = Math.abs(a.bbox.top - b.bbox.top) < fontSize * this.mathMergeBaselineTol;
    const horizontalProximity = Math.abs(a.bbox.left - b.bbox.left) < fontSize * this.mathMergeHorizTol;

    if (!this.sameColumnByStrips(a.bbox, b.bbox, strips)) return false;

    const opRe = /[=+\-−×÷√∫∑≠≤≥≈±∞]/;
    const aIsOp = !!(a.text && opRe.test(a.text));
    const bIsOp = !!(b.text && opRe.test(b.text));

    if (aIsOp || bIsOp) return verticalProximity && horizontalProximity;

    const centerA = (a.bbox.left + a.bbox.right) / 2;
    const centerB = (b.bbox.left + b.bbox.right) / 2;
    return verticalProximity && Math.abs(centerA - centerB) < fontSize * this.mathMergeCenterTol;
  }

  private splitParagraphByStrips(
    paragraph: HTMLSpanElement[],
    infos: Map<HTMLSpanElement, SpanInfo>,
    strips: VerticalStrip[],
    lineHeight: number = 0
  ): HTMLSpanElement[][] {
    if (!paragraph.length || !strips.length) return [paragraph];

    const paraBbox = this.getParaBbox(paragraph, infos);
    const sorted = [...paragraph].sort((a, b) => {
      const ra = infos.get(a)!.rect;
      const rb = infos.get(b)!.rect;
      return ra.top - rb.top || ra.left - rb.left;
    });

    const columnBoundaries: number[] = [];
    let currentLineTop = -Infinity;
    let currentLineSpans: { span: HTMLSpanElement; rect: RectLike }[] = [];

    for (const span of sorted) {
      const rect = infos.get(span)!.rect;

      if (currentLineTop === -Infinity || Math.abs(rect.top - currentLineTop) > lineHeight * this.splitLineHeightTol) {
        if (currentLineSpans.length > 1) {
          this.processLineForColumnBoundaries(currentLineSpans, columnBoundaries, lineHeight);
        }
        currentLineTop = rect.top;
        currentLineSpans = [{ span, rect }];
      } else {
        currentLineSpans.push({ span, rect });
      }
    }

    if (currentLineSpans.length > 1) {
      this.processLineForColumnBoundaries(currentLineSpans, columnBoundaries, lineHeight);
    }

    if (columnBoundaries.length === 0) return [paragraph];

    columnBoundaries.sort((a, b) => a - b);
    const uniqueBoundaries = [columnBoundaries[0]];
    for (let i = 1; i < columnBoundaries.length; i++) {
      if (columnBoundaries[i] - uniqueBoundaries[uniqueBoundaries.length - 1] > lineHeight * this.splitBoundaryDedupTol) {
        uniqueBoundaries.push(columnBoundaries[i]);
      }
    }

    const boundaries = [paraBbox.left, ...uniqueBoundaries, paraBbox.right];
    const regions: Array<{ left: number; right: number }> = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      regions.push({ left: boundaries[i], right: boundaries[i + 1] });
    }

    const buckets: HTMLSpanElement[][] = regions.map(() => []);
    for (const span of sorted) {
      const rect = infos.get(span)!.rect;
      const cx = (rect.left + rect.right) / 2;
      let regionIndex = regions.findIndex(r => cx >= r.left && cx < r.right);
      if (regionIndex === -1) {
        regionIndex = cx < regions[0].left ? 0 : regions.length - 1;
      }
      if (regionIndex >= 0 && regionIndex < regions.length) {
        buckets[regionIndex].push(span);
      }
    }

    const groups: HTMLSpanElement[][] = [];
    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      bucket.sort((a, b) => {
        const ra = infos.get(a)!.rect;
        const rb = infos.get(b)!.rect;
        return ra.top - rb.top || ra.left - rb.left;
      });
      groups.push(bucket);
    }

    return groups.length > 1 ? groups : [paragraph];
  }

  private processLineForColumnBoundaries(
    lineSpans: { span: HTMLSpanElement; rect: RectLike }[],
    columnBoundaries: number[],
    lineHeight: number
  ) {
    lineSpans.sort((a, b) => a.rect.left - b.rect.left);

    for (let i = 1; i < lineSpans.length; i++) {
      const prev = lineSpans[i - 1].rect;
      const curr = lineSpans[i].rect;
      const gap = curr.left - prev.right;
      const fontSize = Math.min(prev.height, curr.height) * 0.8;
      const maxInterWordGap = fontSize * this.splitInterWordGapTol;
      const minColumnGap = fontSize * this.splitColumnGapTol;

      if (gap > minColumnGap && gap > maxInterWordGap) {
        const gapCenter = (prev.right + curr.left) / 2;
        columnBoundaries.push(gapCenter);
      }
    }
  }
  
  private filterStrips(strips: VerticalStrip[], viewportWidth: number): VerticalStrip[] {
    if (!strips?.length) return [];
    return strips.filter(s => {
      const width = s.right - s.left;
      const height = s.bottom - s.top;
      if (width < viewportWidth * 0.003) return false;
      const minHeight = Math.max(12, height * 0.7);
      if (height < minHeight) return false;
      return s.confidence >= this.minStripConfidenceSplit &&
             width >= this.minStripWidthPx &&
             height > 0;
    });
  }
}