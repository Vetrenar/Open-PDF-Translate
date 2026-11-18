// layout-detector.ts — FULL OVERHAULED VERSION (pipeline-based)
//
// Complete replacement using the contour-island pipeline:
//   1. Build occupancy grid
//   2. Detect text lines
//   3. Find vertical contour + artifacts
//   4. Find horizontal contour
//   5. Build islands
//   6. Merge touching islands (same font)
//   7. Split by font family/size
//   8. Split by indentation
//
// Public API is backward-compatible with the old LayoutDetector.

// Stage 0.2 (Q8): removed `@ts-nocheck`. The only `as any` cast that
// remained after removing the suppression was the `LayoutSettings` arg
// defaulting to `{} as LayoutSettings` — left as-is because LayoutSettings
// has many optional fields and the contour pipeline reads only a handful
// via `typeof` guards.

import { buildOccupancyMap, getFontFamily } from './OccupancyMap';
import { buildParagraphs } from './IslandBuilder';
import { assessNativeText } from './native-text-quality';
import { buildSnapshot, SpanInfo } from './Snapshot';
import { domInkRight, restoreDeclaredRights, clampRightEdgesToNextStart } from './ink-geometry';
import type { LayoutSettings } from './layout-modal';

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
  debugStrips?: any[];
  layoutRegions?: Array<{ top: number; bottom: number; left: number; right: number }>;
  gaps?: any[];
  regions?: any[];
}

export type { SpanInfo } from './Snapshot';
export { buildSnapshot, estimateLineHeight } from './Snapshot';
export type { LayoutSettings } from './layout-modal';

// Re-export VerticalStrip for backward compat (processing.ts imports it)
export interface VerticalStrip {
  left: number;
  right: number;
  top: number;
  bottom: number;
  confidence: number;
}

export class LayoutDetector {
  private readonly settings: any;

  constructor(options: LayoutSettings = {} as LayoutSettings) {
    this.settings = options;
  }

  // ── LAYOUT-FIX-4 (2026-09-16): viewer-scale normalization ────────────
  // The DOM path feeds page-relative CSS pixels, but the pipeline's
  // calibrated constants (cellSize=4, WIDE_MARGIN=36, TABLE_GAP=25,
  // DECOR_TOL=8, band floors, contour thresholds) were validated in
  // PDF-POINT space (the pdfjs Node path runs at scale 1). pdf.js sizes
  // every textLayer span as `calc(var(--scale-factor) * <pt>px)` — the
  // page renders at --scale-factor CSS px per PDF pt — so a viewer zoom
  // S rescales the WHOLE input by S while every threshold stays fixed:
  //   • inter-word gaps ×S cross the 2-cell island chaining limit
  //     (6pt gap ≈ 1.5 cells at S=1 → 4+ empty cells at S=2.5 → the line
  //     shatters into word-islands),
  //   • WIDE_MARGIN=36px stops covering the (×S) pdfjs width overstatement,
  //     so applyColumnOrder mis-classifies paragraphs as wide,
  //   • STEP 8.8's band-gap floor (80px) breaks label chaining.
  // Measured on try.pdf p5 (real pdf.js DOM textLayer): scale 1.0 → 9
  // units (clean), 1.3333 (pdf.js default PDF_TO_CSS_UNITS!) → 15,
  // 1.35 → 18, 2.0 → 18 — the user-visible oversplitting. Obsidian's
  // built-in viewer renders at ≥ 1.3333 CSS px/pt BY DEFAULT, so the bug
  // reproduced at 100% zoom.
  //
  // FIX: divide the rect feed (and page size) by the resolved
  // --scale-factor, run the pipeline in its calibrated pt space, then
  // multiply everything back. Coordinate systems stay consistent because
  // the rect objects are ours (created below, referenced by the resulting
  // paragraphs) — we unscale them in place BEFORE the span-matching loop,
  // which compares in CSS px.
  //
  // Scale resolution: custom CSS properties inherit, so a span's computed
  // style sees the value set by pdf.js on the viewer / textLayer (both
  // pdf.js 4.x and 5.x set it; Obsidian ships 5.3.34). Fallback 1 when no
  // span reports it (Node tests, fake spans, non-pdf.js hosts) — the
  // fallback reproduces the legacy behaviour exactly, so the change is
  // inert where the signal is absent.
  // Kill-switch: settings.disableScaleNormalization === true restores the
  // legacy un-normalized behaviour (A/B verification in emul3).
  private resolveViewerScale(spans: HTMLSpanElement[]): number {
    try {
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 1;
      // Probe the first few spans (the textLayer's own --scale-factor, set
      // by pdf.js's TextLayer on its container, wins over the viewer's
      // value for the spans that matter).
      for (let i = 0; i < Math.min(3, spans.length); i++) {
        const el = spans[i];
        if (!(el instanceof HTMLElement)) continue;
        const v = window.getComputedStyle(el).getPropertyValue('--scale-factor');
        const s = parseFloat(v);
        if (Number.isFinite(s) && s > 0.05) return s;
      }
    } catch { /* fall through */ }
    return 1;
  }

  public detectLayout(
    spans: HTMLSpanElement[],
    pageElement: HTMLElement | DOMRect
  ): LayoutResult {
    if (!spans || !Array.isArray(spans) || !pageElement) {
      return this.createEmptyResult();
    }

    const infoMap = buildSnapshot(spans);
    const pageRect = pageElement instanceof HTMLElement
      ? pageElement.getBoundingClientRect()
      : pageElement;

    return this.detectLayoutFromPrepared(spans, infoMap, pageRect);
  }

  public detectLayoutFromPrepared(
    spans: HTMLSpanElement[],
    infoMap: Map<HTMLSpanElement, SpanInfo>,
    pageRect: DOMRect
  ): LayoutResult {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const quality=assessNativeText(spans.map(s=>({str:s.textContent||''})));
    if (!quality.usable) console.warn("Suspect PDF Unicode: attempting model recovery.", quality);
    // P2-11 (Phase 17): removed `estimateLineHeight(infoMap, …)` call —
    // its return value was only consumed by the debugValidation log
    // below, so on production pages (debugValidation=false) the call
    // was pure waste. The debug log now reports `cellSize` (which is
    // what the pipeline actually uses) instead of `lineHeight`.

    // CRITICAL FIX: pipeline.mjs works in PAGE-RELATIVE coordinates.
    // getBoundingClientRect() returns VIEWPORT-ABSOLUTE coords (page offset baked in).
    // Without subtracting pageRect.left/top, span coords overflow grid dimensions
    // and clamp to the right/bottom edge → mass overmerging.
    //
    // Also: use style.fontName (PDF.js g_d0_fN class) instead of fontFamily CSS,
    // because PDF.js may resolve different PDF fonts to the same CSS family.
    const pageLeft = pageRect.left;
    const pageTop = pageRect.top;

    // LAYOUT-FIX-4: viewer-scale normalization (see resolveViewerScale).
    const disableNorm =
      typeof (this.settings as any)?.disableScaleNormalization === 'boolean'
        ? (this.settings as any).disableScaleNormalization
        : false;
    const normScale = disableNorm ? 1 : this.resolveViewerScale(spans);

    // LAYOUT-FIX-9 (P3, 2026-09-17) — DOM-канал ink-геометрии: правые края
    // фида по ФАКТИЧЕСКОМУ рендеру текста (DOM Range по содержимому спана,
    // ink-geometry.ts::domInkRight), а не по заявленным ширинам pdf.js,
    // которыми textLayer sizingует CSS-боксы (то же завышение 2–28pt, что и
    // на очереди). Кламп — только в фиде детектора: каждый ужатый рект
    // несёт declRight, а restoreDeclaredRights ниже (до unscale и цикла
    // матчинга) возвращает заявленный край — СПАН-ИДЕНТИЧНОСТЬ и матчинг
    // не затронуты; px-боксы юнитов остаются ink — семантика детекции.
    // Kill-switch disableInkGeometry: заявленные края, pre-FIX-9.
    const disableInk = (this.settings as any)?.disableInkGeometry === true;

    const rects = spans.map(s => {
      const info = infoMap.get(s);
      if (!info) return null;
      const left =   (info.rect.left   - pageLeft) / normScale;
      const top =    (info.rect.top    - pageTop) / normScale;
      const right =  (info.rect.right  - pageLeft) / normScale;
      const bottom = (info.rect.bottom - pageTop) / normScale;
      // LAYOUT-FIX-11 (DOM|queue parity): спаны textLayer НЕ клампятся
      // через domInkRight — pdf.js 5.x растягивает каждый спан scaleX-ом
      // ДО заявленной ширины item'а, поэтому Range-измерение возвращает
      // РАСТЯНУТЫЙ край (≈ declared), а не истинные чернила. Канал ниже
      // (clampRightEdgesToNextStart) — тот же next-start Tm-clamp, что и
      // у очереди: старт следующего спана на той же строке точен (Tm-якорь),
      // им и ограничивается завышенный правый край.
      let textAngle=0;
      try {
        const css=window.getComputedStyle(s);
        const matrix=css.transform?.match(/^matrix\(([^)]+)\)$/);
        if (matrix) {
          const values=matrix[1].split(',').map(Number);
          textAngle=Math.atan2(values[1],values[0]);
        }
        const rotate=css.rotate;
        if (rotate && rotate!=='none' && /^-?[\d.]+deg$/.test(rotate)) textAngle+=parseFloat(rotate)*Math.PI/180;
      } catch { /* Non-browser test hosts have no computed transform. */ }
      return {
        left, top, right, bottom,
        textAngle,
        fontname: info.style.fontName || info.style.fontFamily || 'unknown',
        fontsize: info.style.fontSize / normScale,
        text: info.text || (s as any).textContent || '',
        __span: s,
      };
    }).filter(Boolean) as any[];

    if (!disableInk && rects.length > 0) {
      // LAYOUT-FIX-11: канал 1 — next-start кламп (симметрично очереди).
      // Группировка по Math.round(bottom): DOM-боксы спанов одной строки
      // одного шрифта имеют идентичный bottom (baseline + descent-offset),
      // пары разношрифтовых строк могут не сгруппироваться — деградация
      // ровно та же, что допускается очередью для незаклампленных краёв.
      const clamped = clampRightEdgesToNextStart(rects, {
        // LAYOUT-FIX-18a: re-seat justified-line drift tails (near-same-start
        // overlap pairs). Kill-switch: disableWordDriftRepair (LayoutSettings,
        // absent by default — hash untouched).
        driftTailShift: (this.settings as any)?.disableWordDriftRepair !== true,
      });
      rects.length = 0;
      rects.push(...clamped);
      // Канал 2 (domInkRight) — только для ректов, не заклампленных
      // каналом 1: на реальном textLayer он инертен (ink ≈ declared у
      // растянутых спанов), но сохранён для нестандартных хостов, где
      // спаны не растянуты (кастомные вьюеры без scaleX).
      for (const r of rects) {
        if ((r as any).declRight !== undefined) continue;
        const s = (r as any).__span;
        if (!s) continue;
        const ink = domInkRight(s, pageLeft, normScale);
        if (ink !== null && ink > r.left + 0.5 && ink < r.right - 0.25) {
          (r as any).declRight = r.right;
          (r as any).inkSource = 'range';
          r.right = ink;
        }
      }
    }

    // CRITICAL FIX: pipeline.mjs uses CELL_SIZE = 4 hardcoded.
    // The user explicitly stated "контур - это 2хвысота ячейки, не line height".
    // Dynamic cellSize = floor(lineHeight/3) shifts the contour threshold
    // (2 × cellSize) and breaks the validated pipeline behavior.
    const settings: any = this.settings || {};
    const cellSize = (typeof settings.contourCellSize === 'number' && settings.contourCellSize > 0)
      ? settings.contourCellSize
      : 4;

    // Run the pipeline (normalized to PDF-pt space; grid is consistent)
    const map = buildOccupancyMap(
      rects,
      pageRect.width / normScale,
      pageRect.height / normScale,
      cellSize,
    );
    const paragraphs = buildParagraphs(map, rects, {
      indentThreshold: typeof settings.contourIndentThreshold === 'number' ? settings.contourIndentThreshold : undefined,
      fontSizeTolerance: typeof settings.contourFontSizeTolerance === 'number' ? settings.contourFontSizeTolerance : undefined,
      maxMergePasses: typeof settings.maxMergePasses === 'number' ? settings.maxMergePasses : (typeof settings.maxIterMerges === 'number' ? settings.maxIterMerges : undefined),
      // Stage 2.2 (Q6): pass the new exposed settings through.
      columnGapThreshold: typeof settings.columnGapThreshold === 'number' ? settings.columnGapThreshold : undefined,
      decorationThreshold: typeof settings.decorationThreshold === 'number' ? settings.decorationThreshold : undefined,
      // LAYOUT-FIX-5 (2026-09-16): preserveStyle: false — aligned with the
      // pdfjs path (see pdf-text-extractor.ts). The earlier "Bug 2 fix
      // (Phase 17 P2-2)" set `true` to keep DOM/pdfjs splits consistent,
      // but on modern pdf.js (4.x/5.x — Obsidian ships 5.3.34) the
      // textLayer no longer emits g_d0_fN classes: buildSnapshot resolves
      // every span to the GENERIC computed font-family ("serif"/"sans-
      // serif"; empirically 319/319 spans on a real pdfjs 4.10.38 page),
      // so the DOM path can't see style variants at all — and `true` here
      // merely made the DOM path split on serif↔sans-serif real-family
      // changes exactly as before, while the pdfjs path oversplit every
      // Regular↔Italic run inside a paragraph. `false` restores the
      // original user spec (bold/italic = same style) on BOTH paths and
      // removes the mid-word, mid-sentence paragraph tears
      // ("oversplitting на курсив тексте внутри абзаца").
      preserveStyle: false,
      // LAYOUT-FIX-8 (P1, 2026-09-17): pipeline kill-switches now flow from
      // LayoutSettings into buildParagraphs on the PRODUCTION DOM path too
      // (previously they only worked in Node test harnesses — Infra-1 of
      // the layout bisect). Programmatic A/B flags, absent by default:
      // `undefined` leaves every step at its validated default behavior.
      disableColumnSlicing: settings.disableColumnSlicing === true,
      disableFragmentAbsorption: settings.disableFragmentAbsorption === true,
      disableFigureBandMerge: settings.disableFigureBandMerge === true,
      disableStyleFlowGuard: settings.disableStyleFlowGuard === true,
      disableTocRepair: settings.disableTocRepair === true,
      disableNonAdjacentSplit: settings.disableNonAdjacentSplit === true,
      // LAYOUT-FIX-10 (A2): the DOM path previously hard-disabled the
      // cross-page memory (no file context). LAYOUT-FIX-13 opens it:
      // processing.ts wraps detectLayout with setColumnMemoryFile(owner.path)
      // — the owning document comes from the pageElement's DOM ancestry
      // (O-1 rule), so the sequential viewing/batch flow accumulates the
      // same boundary consensus the queue path does, and a furniture page
      // (book p61 class) can borrow the remembered boundary through the
      // slicer's memory fallback. Detached pages keep the memory closed.
      // Kill-switch: LayoutSettings.disableColumnMemory (programmatic A/B).
      disableColumnMemory: settings.disableColumnMemory === true,
      // LAYOUT-FIX-13: STEP 9.6 kill-switch (torn-fragment re-attachment).
      disableFragmentReattach: settings.disableFragmentReattach === true,
      // LAYOUT-FIX-16: post-loop caption subtraction kill-switch.
      disableCaptionSubtractLoop: settings.disableCaptionSubtractLoop === true,
      // LAYOUT-FIX-18: single-word drift-tail repair kill-switch (18a feed
      // shift above + the 18b/18c slicer gates inside buildParagraphs).
      disableWordDriftRepair: settings.disableWordDriftRepair === true,
      // LAYOUT-FIX-22: STEP 6.9 single-line bridge kill-switch.
      disableSingleLineBridge: settings.disableSingleLineBridge === true,
      // LAYOUT-FIX-23: STEP 9.65 caption chain assembly kill-switch.
      disableCaptionAssembly: settings.disableCaptionAssembly === true,
      // LAYOUT-FIX-15: user layout preset (standard / paragraphs /
      // two-columns / separate) — resolved inside buildParagraphs.
      layoutPreset: settings.layoutPreset,
            activeRegions: settings.activeRegions,
            regionPageWidth: pageRect.width / normScale,
            regionPageHeight: pageRect.height / normScale,
      // LAYOUT-FIX-10 (A1): production ink-channel flag — the DOM Range
      // measurement (or honestly declared widths) makes the feed ink-true.
      inkChannelFeed: disableInk === false,
    });

    // LAYOUT-FIX-9 (P3): восстановить заявленные правые края СПАНОВ до
    // unscale и цикла матчинга (сравнивает ректы с CSS-px боксами спанов).
    restoreDeclaredRights(rects);

    // LAYOUT-FIX-4: unscale back to CSS px. The rect objects are shared
    // with the paragraphs' span arrays, so the in-place unscale restores
    // the exact CSS-px coordinates the mapping loop below compares
    // against; the paragraph boxes are scaled separately (they were
    // computed inside the pipeline in normalized space).
    if (normScale !== 1) {
      for (const r of rects as any[]) {
        r.left *= normScale; r.top *= normScale;
        r.right *= normScale; r.bottom *= normScale;
        if (Number.isFinite(r.fontsize)) r.fontsize *= normScale;
      }
      for (const p of paragraphs as any[]) {
        p.pxLeft *= normScale; p.pxTop *= normScale;
        p.pxRight *= normScale; p.pxBottom *= normScale;
        if (Number.isFinite(p.width)) p.width *= normScale;
        if (Number.isFinite(p.height)) p.height *= normScale;
      }
    }

    // Map back to HTMLSpanElements.
    // CRITICAL FIX: paragraphs store page-relative coords in their span rects,
    // so we must compare against page-relative coords too.
    const matched = new Set<HTMLSpanElement>();
    const result: HTMLSpanElement[][] = paragraphs.map(para => {
      const paraSpans: HTMLSpanElement[] = [];
      for (const r of para.spans) {
        const original = (r as any).__span as HTMLSpanElement | undefined;
        if (original && infoMap.has(original) && !matched.has(original)) {
          paraSpans.push(original); matched.add(original); continue;
        }
        for (const s of spans) {
          if (matched.has(s)) continue;
          const info = infoMap.get(s);
          if (!info) continue;
          const sLeft   = info.rect.left   - pageLeft;
          const sTop    = info.rect.top    - pageTop;
          const sRight  = info.rect.right  - pageLeft;
          const sBottom = info.rect.bottom - pageTop;
          if (Math.abs(sLeft   - r.left)   < 1 &&
              Math.abs(sTop    - r.top)    < 1 &&
              Math.abs(sRight  - r.right)  < 1 &&
              Math.abs(sBottom - r.bottom) < 1) {
            paraSpans.push(s);
            matched.add(s);
            break;
          }
        }
      }
      return paraSpans;
    }).filter(p => p.length > 0);

    // Build column analysis (backward-compat).
    // CRITICAL FIX: convert page-relative paragraph coords → viewport-absolute
    // for downstream consumers (renderLayoutDebugOverlay subtracts pageRect.left).
    const columnAnalysis = this.buildColumnAnalysis(paragraphs, pageRect, pageLeft, pageTop);

    // Build layout regions — viewport-absolute for downstream overlay rendering.
    const layoutRegions = paragraphs.map(p => ({
      top: p.pxTop + pageTop, bottom: p.pxBottom + pageTop,
      left: p.pxLeft + pageLeft, right: p.pxRight + pageLeft,
    }));

    if (settings.debugValidation) {
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
      console.debug('[LayoutDetector Pipeline]', {
        spans: spans.length,
        paragraphs: result.length,
        cellSize,
        pageW: Number(pageRect.width.toFixed(1)),
        pageH: Number(pageRect.height.toFixed(1)),
        elapsedMs: Number(elapsed.toFixed(2)),
      });
    }

    return {
      paragraphs: result,
      columnAnalysis,
      debugStrips: [],
      layoutRegions,
      gaps: [],
      regions: layoutRegions,
    };
  }

  private buildColumnAnalysis(
    paragraphs: any[],
    pageRect: DOMRect,
    pageLeft: number = 0,
    pageTop: number = 0
  ): LayoutResult['columnAnalysis'] {
    // paragraph coords are page-relative (0..pageW, 0..pageH).
    // We offset by pageLeft/pageTop to produce viewport-absolute column rects,
    // matching the old detector's coordinate system (so renderLayoutDebugOverlay
    // can subtract pageRect.left/top as before).
    const full: BoundingRect = {
      left: pageLeft,
      top: pageTop,
      right: pageLeft + pageRect.width,
      bottom: pageTop + pageRect.height,
      width: pageRect.width,
      height: pageRect.height,
    };

    if (!paragraphs.length) {
      return { columns: [full], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: [] };
    }

    // Find column gap from paragraphs (sort by page-relative left)
    const sorted = [...paragraphs].sort((a, b) => a.pxLeft - b.pxLeft);
    const columns: BoundingRect[] = [];
    const mergeTol = Math.max(1, pageRect.width * 0.005);

    for (const p of sorted) {
      // Convert page-relative → viewport-absolute
      const vLeft = p.pxLeft + pageLeft;
      const vTop = p.pxTop + pageTop;
      const vRight = p.pxRight + pageLeft;
      const vBottom = p.pxBottom + pageTop;
      const last = columns[columns.length - 1];
      if (!last || vLeft > last.right + mergeTol) {
        columns.push({
          left: vLeft, top: vTop, right: vRight, bottom: vBottom,
          width: vRight - vLeft, height: vBottom - vTop,
        });
      } else {
        last.left = Math.min(last.left, vLeft);
        last.right = Math.max(last.right, vRight);
        last.top = Math.min(last.top, vTop);
        last.bottom = Math.max(last.bottom, vBottom);
        last.width = last.right - last.left;
        last.height = last.bottom - last.top;
      }
    }

    const minColWidth = Math.max(1, pageRect.width * 0.03);
    let normalized = columns.filter(c => c.width >= minColWidth);
    if (!normalized.length) normalized = [full];

    const edgeCols = normalized.length >= 2
      ? [normalized[0], normalized[normalized.length - 1]]
      : [];
    const gapCols = normalized.length > 2 ? normalized.slice(1, -1) : [];

    const verticalGaps: number[] = [];
    for (let i = 1; i < normalized.length; i++) {
      const gap = normalized[i].left - normalized[i - 1].right;
      if (gap > 1) verticalGaps.push((normalized[i - 1].right + normalized[i].left) / 2);
    }

    return { columns: normalized, edgeCols, gapCols, verticalGaps, horizontalGaps: [] };
  }

  private createEmptyResult(): LayoutResult {
    return {
      paragraphs: [],
      columnAnalysis: { columns: [], edgeCols: [], gapCols: [], verticalGaps: [], horizontalGaps: [] },
      debugStrips: [], layoutRegions: [], gaps: [], regions: [],
    };
  }
}
