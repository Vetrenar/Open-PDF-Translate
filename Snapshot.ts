// Snapshot.ts
//
// Extracts span information (rect + style + text) from HTMLSpanElements.
// Designed to work both in the browser (real DOM) and in Node.js tests
// (fake span objects with .rect / .style / .text properties).

export interface SpanStyle {
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  fontFamily: string;
  color: string;
  isMath: boolean;
  /**
   * Raw PDF font name as exposed by PDF.js textLayer.
   * - "g_d0_f1" style class identifier (PDF.js internal font id)
   * - "AGaramondPro-Regular" if data-font-name is set
   * - Falls back to fontFamily CSS value
   * Used by contour pipeline for font-family-based paragraph splitting.
   */
  fontName: string;
}

export interface SpanInfo {
  rect: DOMRect;
  style: SpanStyle;
  text: string;
}

// Accept any object that quacks like a span — works for both real
// HTMLSpanElement (browser) and fake test spans.
interface DomLike {
  getBoundingClientRect?: () => DOMRect;
  rect?: DOMRect;
  // Real DOM .style is CSSStyleDeclaration; fake spans may use Partial<SpanStyle>
  style?: { fontSize?: string | number; fontWeight?: string | number; fontStyle?: string; color?: string; fontFamily?: string; isMath?: boolean; fontName?: string } | CSSStyleDeclaration;
  textContent?: string | null;
  text?: string;
  className?: string;
  getAttribute?: (name: string) => string | null;
}

function getRect(span: DomLike): DOMRect {
  if (typeof span.getBoundingClientRect === 'function') {
    return span.getBoundingClientRect();
  }
  if (span.rect) {
    return span.rect;
  }
  // Fallback: zero rect
  return new DOMRect(0, 0, 0, 0);
}

/**
 * Parse a CSS font-size value like "16px" → 16, or pass through a number.
 */
function parseFontSize(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

function parseFontWeight(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  // Named weights
  const named: Record<string, number> = {
    'normal': 400, 'bold': 700, 'lighter': 300, 'bolder': 600,
  };
  const lower = v.trim().toLowerCase();
  if (named[lower] !== undefined) return named[lower];
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

/**
 * Extract the PDF font name from a span.
 *
 * PDF.js textLayer exposes font information in one of three ways:
 *   1. `data-font-name` attribute (custom builds, e.g. pdfplumber integration)
 *   2. CSS class `g_d0_fN` (PDF.js internal font id — different per actual PDF font)
 *   3. Inline `style.fontFamily` (preserves original font-family string)
 *
 * We prefer them in that order — the more raw/specific the identifier, the better,
 * because the contour pipeline splits paragraphs by font family change. Two spans
 * with the same resolved CSS font but different PDF fonts SHOULD split.
 */
function extractFontName(span: DomLike, computedFontFamily: string): string {
  // 1. Test-mode: explicit fontName on style
  const s = span.style as any;
  if (s?.fontName && typeof s.fontName === 'string') return s.fontName;

  // 2. data-font-name attribute (custom)
  if (typeof span.getAttribute === 'function') {
    try {
      const attr = span.getAttribute('data-font-name');
      if (attr && attr.trim()) return attr.trim();
    } catch { /* ignore */ }
  }

  // 3. PDF.js class g_d0_fN
  const cls = span.className;
  if (typeof cls === 'string' && cls) {
    const m = cls.match(/\b(g_d\d+_f\d+)\b/);
    if (m) return m[1];
  }

  // 4. Inline style.fontFamily (first declared family)
  const inlineFf = s?.fontFamily;
  if (typeof inlineFf === 'string' && inlineFf.trim()) {
    return inlineFf.split(',')[0].trim().replace(/['"]/g, '');
  }

  // 5. Computed font-family fallback
  if (computedFontFamily && computedFontFamily !== 'default') {
    return computedFontFamily.split(',')[0].trim().replace(/['"]/g, '');
  }

  return 'default';
}

function getStyle(span: DomLike): SpanStyle {
  // If the span provides numeric style info directly (test mode), use it
  const s = span.style as any;
  if (s) {
    const fontSize = parseFontSize(s.fontSize);
    const fontWeight = parseFontWeight(s.fontWeight);
    if (fontSize !== undefined || fontWeight !== undefined) {
      const fontFamily = s.fontFamily ?? 'default';
      return {
        fontSize: fontSize ?? 16,
        fontWeight: fontWeight ?? 400,
        fontStyle: s.fontStyle ?? 'normal',
        fontFamily,
        color: typeof s.color === 'string' ? s.color : '#000000',
        isMath: s.isMath ?? false,
        fontName: extractFontName(span, fontFamily),
      };
    }
  }

  // Browser mode: use getComputedStyle (works for real HTMLSpanElements)
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && span instanceof Element) {
    try {
      const computed = window.getComputedStyle(span);
      const className = span.className || '';
      const isMath = className.includes('math') || className.includes('katex');
      const fontFamily = computed.fontFamily || 'default';
      return {
        fontSize: parseFloat(computed.fontSize) || 16,
        fontWeight: parseFontWeight(computed.fontWeight) ?? 400,
        fontStyle: computed.fontStyle || 'normal',
        fontFamily,
        color: computed.color || '#000000',
        isMath,
        fontName: extractFontName(span, fontFamily),
      };
    } catch {
      // Fall through to defaults
    }
  }

  return {
    fontSize: 16,
    fontWeight: 400,
    fontStyle: 'normal',
    fontFamily: 'default',
    color: '#000000',
    isMath: false,
    fontName: extractFontName(span, 'default'),
  };
}

function getText(span: DomLike): string {
  if (typeof span.textContent === 'string') return span.textContent;
  if (typeof span.text === 'string') return span.text;
  return '';
}

/**
 * Build a snapshot map of span → SpanInfo.
 *
 * Works with:
 *   - Real HTMLSpanElement[] in the browser
 *   - Fake span objects in tests: { getBoundingClientRect: () => rect, textContent: '...', style: {...} }
 *   - Or even simpler: { rect: DOMRect, text: '...', style: {...} }
 */
export function buildSnapshot<T extends DomLike>(spans: T[]): Map<T, SpanInfo> {
  const infoMap = new Map<T, SpanInfo>();
  for (const span of spans) {
    infoMap.set(span, {
      rect: getRect(span),
      style: getStyle(span),
      text: getText(span),
    });
  }
  return infoMap;
}

/**
 * Estimate line height from span info.
 *
 * Strategy:
 * 1. Collect vertical gaps between vertically-adjacent spans (same column)
 * 2. Use trimmed average of gaps × multiplier
 * 3. Also compute median font size
 * 4. Return max(gap-based, font-based floor)
 */
export function estimateLineHeight<T>(
  infoMap: Map<T, SpanInfo>,
  pageRect: { height: number }
): number {
  // Collect span heights
  const heights: number[] = [];
  const fontSizes: number[] = [];
  for (const info of infoMap.values()) {
    if (info.rect.height > 0) heights.push(info.rect.height);
    if (info.style.fontSize > 0) fontSizes.push(info.style.fontSize);
  }

  // Median font size → floor
  fontSizes.sort((a, b) => a - b);
  const medianFont = fontSizes.length
    ? fontSizes[Math.floor(fontSizes.length / 2)]
    : 16;
  const floor = medianFont * 1.6 * 0.8;

  // Collect vertical gaps between spans in the same column
  const sortedByTop = [...infoMap.values()]
    .filter(i => i.rect.height > 0)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

  const gaps: number[] = [];
  const maxGapFraction = 0.5;
  for (let i = 1; i < sortedByTop.length; i++) {
    const prev = sortedByTop[i - 1].rect;
    const curr = sortedByTop[i].rect;
    // Same column? (x-overlap > 50% of smaller width)
    const overlapX = Math.min(prev.right, curr.right) - Math.max(prev.left, curr.left);
    const minWidth = Math.min(prev.width, curr.width);
    if (minWidth <= 0 || overlapX < minWidth * 0.5) continue;

    const gap = curr.top - prev.bottom;
    if (gap > 0 && gap < pageRect.height * maxGapFraction) {
      gaps.push(gap);
    }
  }

  if (gaps.length >= 5) {
    gaps.sort((a, b) => a - b);
    const trim = Math.floor(gaps.length * 0.15);
    const trimmed = gaps.slice(trim, gaps.length - trim);
    if (trimmed.length) {
      const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
      const lhFromGaps = avg * 1.25;
      return Math.max(lhFromGaps, floor);
    }
  }

  // Fallback: median height
  heights.sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : floor;
  return Math.max(medianHeight, floor);
}
