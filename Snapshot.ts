// Snapshot.ts
export interface NormalizedStyle {
  fontFamily: string;
  fontSize: number;    // normalized by DPR
  fontWeight: number;  // normalized numeric
  fontStyle: string;
  color: string;       // original CSS color string
  colorRGB: [number, number, number];
  styleSig: string;    // "family|fontSizeRounded|weight|style|r,g,b"
}

export interface SpanInfo {
  span: HTMLSpanElement;
  rect: DOMRect;       // normalized by DPR
  style: NormalizedStyle;
  isMathElement: boolean;
  mathContext: 'equation' | 'inline' | 'none';
  text: string;
}

const MATH_FONT_RE = /math|cambria|stix|asana|euler|latin modern/i;
// Extended math/symbol ranges
// Greek: \u0370-\u03FF, Superscripts/Subscripts: \u2070-\u209F, arrows/operators & misc common math
const MATH_CHAR_RE = /[=+\-−×÷√∫∑∏∞Δαβγδθλμρστφψω±≤≥≠≈≡%‰∀∃∈∋∩∪⊂⊃⊆⊇⊕⊗⊥⇒⇔→←↑↓↔∴≅⊢⊨]|[\u0370-\u03FF\u2070-\u209F]/;

function parseColorToRGB(color: string): [number, number, number] {
  if (!color) return [0, 0, 0];
  const m = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  const hex = color.trim().toLowerCase();
  if (/^#([0-9a-f]{3}){1,2}$/i.test(hex)) {
    if (hex.length === 4) {
      return [
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        parseInt(hex[3] + hex[3], 16)
      ];
    }
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
  }
  return [0, 0, 0];
}

function normalizeWeight(weight: string): number {
  const num = parseInt(weight as any, 10);
  if (!isNaN(num)) return num;
  const w = (weight || '').toLowerCase();
  if (w === 'bold') return 700;
  if (w === 'normal') return 400;
  return 400;
}

export function isMathContentFont(fontFamily: string): boolean {
  return MATH_FONT_RE.test(fontFamily || '');
}

export function isMathElementText(text: string, fontFamily: string): boolean {
  if (!text) return false;
  if (isMathContentFont(fontFamily)) return true;
  return MATH_CHAR_RE.test(text);
}

export function determineMathContext(text: string, fontFamily: string): 'equation' | 'inline' | 'none' {
  if (isMathElementText(text, fontFamily)) {
    return (text.includes('=') || text.includes('∑')) ? 'equation' : 'inline';
  }
  return 'none';
}

export function buildSnapshot(spans: HTMLSpanElement[]): Map<HTMLSpanElement, SpanInfo> {
  const dpr = window.devicePixelRatio || 1;
  const map = new Map<HTMLSpanElement, SpanInfo>();

  for (const s of spans) {
    const rectRaw = s.getBoundingClientRect();
    const rect = new DOMRect(
      rectRaw.left / dpr,
      rectRaw.top / dpr,
      rectRaw.width / dpr,
      rectRaw.height / dpr
    );
    const style = window.getComputedStyle(s);
    const fontSize = (parseFloat(style.fontSize) || 12) / dpr;
    const fontWeight = normalizeWeight(style.fontWeight);
    const colorRGB = parseColorToRGB(style.color);
    const text = s.textContent || '';
    const isMath = isMathElementText(text, style.fontFamily);
    const mathContext = determineMathContext(text, style.fontFamily);
    const fontSizeRounded = Math.round(fontSize * 2) / 2; // 0.5px rounding
    const styleSig = [
      style.fontFamily,
      fontSizeRounded.toFixed(1),
      fontWeight,
      style.fontStyle,
      `${colorRGB[0]},${colorRGB[1]},${colorRGB[2]}`
    ].join('|');

    const normStyle: NormalizedStyle = {
      fontFamily: style.fontFamily,
      fontSize,
      fontWeight,
      fontStyle: style.fontStyle,
      color: style.color,
      colorRGB,
      styleSig
    };

    map.set(s, {
      span: s,
      rect,
      style: normStyle,
      isMathElement: isMath,
      mathContext,
      text
    });
  }
  return map;
}