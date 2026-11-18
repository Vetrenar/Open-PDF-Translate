import type { InputRect } from './OccupancyMap';

export interface TableRegion {
  id: string;
  left: number; top: number; right: number; bottom: number;
  spans: InputRect[];
  caption: InputRect;
  cells: { spans: InputRect[]; row: number; column: number }[];
}

const text = (ss: InputRect[]) => ss.map(s => s.text || '').join(' ').trim();
function rowsOf(spans: InputRect[]): InputRect[][] {
  const rows: InputRect[][] = [];
  for (const s of [...spans].sort((a,b) => a.bottom-b.bottom || a.left-b.left)) {
    const row = rows.find(r => Math.abs(r[0].bottom-s.bottom) <= 2 ||
      Math.min(r[0].bottom,s.bottom)-Math.max(r[0].top,s.top) >=
      Math.min(r[0].bottom-r[0].top,s.bottom-s.top)*0.35);
    if (row) row.push(s); else rows.push([s]);
  }
  return rows.map(r => r.sort((a,b) => a.left-b.left));
}
function clusters(row: InputRect[]): InputRect[][] {
  const out: InputRect[][] = [];
  let right = -Infinity;
  for (const s of row) {
    if (!out.length || s.left-right > 12) out.push([]);
    out[out.length-1].push(s); right=Math.max(right,s.right);
  }
  return out;
}

/** Caption-seeded local grids. Uncaptioned/ambiguous regions remain in
 * the normal paragraph detector. A caption alone never establishes a table:
 * we require a short multi-column header and repeated aligned body rows. */
export function detectTableRegions(rects: InputRect[], pageWidth: number): TableRegion[] {
  const result: TableRegion[] = [];
  const used = new Set<InputRect>();
  const seeds = rects.filter(s => /^(?:Table|Таблица)\s+\d+(?:\.\d+)*[A-Za-z]?[.:]?(?:\s|$)/iu.test(s.text || ''));
  for (const seed of seeds) {
    const left = seed.left - 16;
    const size = seed.fontsize || seed.bottom-seed.top;
    const candidates = rects.filter(s => !used.has(s) && s.left >= left
      && s.top > seed.bottom + 2 && s.top < seed.bottom + 72
      && (s.fontsize || s.bottom-s.top) <= size + 0.5);
    const headers = rowsOf(candidates).map(row => ({row, parts:clusters(row)}))
      .filter(h => h.parts.length >= 2 && h.parts.length <= 12
        && h.parts.every(c => text(c).split(/\s+/).length <= 5)
        && h.parts.some(c => /[\p{L}]/u.test(text(c))))
      .sort((a,b) => {
        const labels=(parts:InputRect[][]) => parts.filter(c=>/[\p{L}]/u.test(text(c))
          && !/^(?:NA|N\/A)$/i.test(text(c)) && !/^[<>≤≥]?\d/.test(text(c))).length;
        return labels(b.parts)-labels(a.parts) || b.parts.length-a.parts.length || a.row[0].top-b.row[0].top;
      });
    const header = headers[0];
    if (!header) continue;
    const anchors = header.parts.map(c => c[0].left);
    if (anchors[0]-seed.left>40 && rects.filter(s=>s.left>=seed.left-4
      && s.left<anchors[0]-16 && s.top>header.row[0].bottom && s.top<header.row[0].bottom+180).length>=3) {
      anchors.unshift(seed.left); // an intentionally blank row-label header
    }
    const x0 = Math.min(seed.left, anchors[0]) - 4;
    let x1 = Math.max(...header.row.map(s => s.right)) + 12;
    // A left-half table next to prose must not claim the neighbouring column.
    if (x1 < pageWidth * 0.6) x1 = Math.min(pageWidth * 0.5, x1 + 12);
    else x1 = pageWidth - 16;
    const headerSize = Math.max(...header.row.map(s=>s.fontsize || s.bottom-s.top));
    const headerTop = Math.min(...header.row.map(s=>s.top));
    const headerBottom = Math.max(...header.row.map(s=>s.bottom));
    const preceding = rowsOf(candidates).filter(row => row.every(s => s.top >= headerTop-headerSize*2
      && s.bottom < headerTop+1 && s.left >= x0 && s.right <= x1
      && text([s]).split(/\s+/).length <= 3));
    const top = Math.min(headerTop,...preceding.flat().map(s=>s.top));
    const rows = rowsOf(rects.filter(s => !used.has(s) && s.left >= x0 && s.left < x1
      && s.top >= top-1));
    const selected: InputRect[][] = [];
    let bottom = top, gridRows = 0;
    for (const row of rows) {
      const y = Math.min(...row.map(s=>s.top));
      if (y-bottom > Math.max(24,headerSize*2.5)) break;
      const t = text(row);
      if (selected.length && /^(?:Abbreviations?\b|Figures?\s+\d|Table\s+\d|a\s+Cell markers)/i.test(t)) break;
      const byColumn = new Set(row.map(s => {
        let col=0; for(let i=1;i<anchors.length;i++) if(s.left >= anchors[i]-12) col=i; return col;
      }));
      // A long sentence spanning the grid is a footnote/body transition.
      if (selected.length && row.some(s => s.left < anchors[1]-8 && s.right > anchors[1]+16)) break;
      selected.push(row);
      if (byColumn.size >= 2) gridRows++;
      bottom=Math.max(...row.map(s=>s.bottom));
    }
    if (gridRows < 3) continue;
    const cells: TableRegion['cells'] = [];
    let logicalRow = -1;
    let previous: Map<number, InputRect[]> | undefined;
    for (const row of selected) {
      const cols = new Map<number, InputRect[]>();
      for (const s of row) {
        let col=0; for(let i=1;i<anchors.length;i++) if(s.left >= anchors[i]-12) col=i;
        const ss=cols.get(col)||[]; ss.push(s); cols.set(col,ss);
      }
      const first = cols.get(0);
      const previousLabel = previous?.get(0);
      const wrappedLabel = first && previousLabel && (/^\(/.test(text(first))
        || /\/$/.test(text(previousLabel)) || (cols.size===1 && /^[a-z]/.test(text(first))));
      // Nested tables have a row-spanning category/definition and a repeated
      // subcategory column. A new subcategory starts a row, but a wrap in
      // morphology/markers alone does not.
      const keyColumn = first ? (wrappedLabel ? -1 : 0)
        : anchors.length >= 3 && cols.has(2) && /^[A-Z]/.test(text(cols.get(2)!).replace(/^[•-]\s*/,'')) ? 2 : -1;
      const continuation = previous && (keyColumn < 0 || Math.max(...row.map(s=>s.bottom))<=headerBottom+1);
      if (!continuation) { logicalRow++; }
      if (!previous) previous = new Map();
      for (const [column,ss] of cols) {
        const existing=previous!.get(column);
        if(existing && (continuation || column < keyColumn)) existing.push(...ss);
        else { previous!.set(column,ss); cells.push({spans:ss,row:logicalRow,column}); }
      }
    }
    const spans=selected.flat();
    spans.forEach(s=>used.add(s));
    cells.sort((a,b)=>a.row-b.row||a.column-b.column);
    result.push({id:`table-${result.length}`,left:x0,top,right:x1,bottom,spans,cells,caption:seed});
  }
  return result;
}
