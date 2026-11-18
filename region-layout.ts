import type { InputRect } from './OccupancyMap';

export type ManualLayoutMode = 'single-paragraph' | 'explicit-columns' | 'table' | 'separate-paragraphs';
export interface RegionRect { left: number; top: number; width: number; height: number }
export interface RegionLayoutRule {
  id: string;
  page: number;
  rotation?: number;
  /** Fractions of the cropped page in its intrinsic PDF rotation (never screen pixels). */
  rect: RegionRect;
  mode: ManualLayoutMode;
  /** Fractions within rect; columns require exactly one divider. */
  columns?: number[];
  rows?: number[];
  paragraphGapEm?: number;
  /** Inclusive zero-based row/column ranges for merged cells. */
  mergedCells?: {row: number; column: number; lastRow: number; lastColumn: number}[];
}
export interface RegionLayoutSettings {
  layoutPreset?: string;
  regionLayouts?: Record<string, RegionLayoutRule[]>;
  /** Resolved per-call; never persisted as a global setting. */
  activeRegions?: RegionLayoutRule[];
}
export const manualModes: ManualLayoutMode[] = ['single-paragraph', 'explicit-columns', 'table', 'separate-paragraphs'];
export function isManualMode(mode: string | undefined): mode is ManualLayoutMode {
  return manualModes.includes(mode as ManualLayoutMode);
}
export function overlaps(a: RegionRect, b: RegionRect): boolean {
  return Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left)>1e-6 &&
    Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top)>1e-6;
}
export function validateRegion(rule: RegionLayoutRule): void {
  const r = rule.rect;
  if (!isManualMode(rule.mode) || !Number.isInteger(rule.page) || rule.page<1 ||
      ![r.left,r.top,r.width,r.height].every(Number.isFinite) || r.left<0 || r.top<0 ||
      r.width<=0 || r.height<=0 || r.left+r.width>1.000001 || r.top+r.height>1.000001) {
    throw new Error('Invalid layout region');
  }
  for (const cuts of [rule.columns,rule.rows]) {
    if (cuts && (cuts.length>100 || cuts.some((v,i)=>!Number.isFinite(v)||v<=0||v>=1||(i>0&&v<=cuts[i-1]))))
      throw new Error('Dividers must be unique, increasing values between 0 and 100%.');
  }
  if (rule.mode==='explicit-columns' && rule.columns && rule.columns.length!==1)
    throw new Error('Two columns require exactly one divider.');
  for(const [i,m] of (rule.mergedCells || []).entries()) {
    if(![m.row,m.column,m.lastRow,m.lastColumn].every(v=>Number.isInteger(v)&&v>=0) || m.lastRow<m.row || m.lastColumn<m.column || m.lastColumn>(rule.columns??[0.5]).length || (rule.rows && m.lastRow>rule.rows.length))
      throw new Error('Merged cells must fit the table grid.');
    if((rule.mergedCells || []).slice(0,i).some(n=>m.row<=n.lastRow&&m.lastRow>=n.row&&m.column<=n.lastColumn&&m.lastColumn>=n.column))
      throw new Error('Merged cells cannot overlap.');
  }
  if (rule.paragraphGapEm!==undefined && (!(rule.paragraphGapEm>0)||!Number.isFinite(rule.paragraphGapEm)))
    throw new Error('Paragraph gap must be positive.');
}
export function rulesForPage(settings: RegionLayoutSettings, file: string, page: number): RegionLayoutRule[] {
  return (settings.regionLayouts?.[file] || []).filter(r=>r.page===page);
}
export function resolvePageLayout<T extends RegionLayoutSettings>(settings: T, file: string, page: number): T {
  return {...settings,activeRegions:rulesForPage(settings,file,page)};
}
/** Replacement is explicit: overlapping rules are superseded, never stacked. */
export function withRegion<T extends RegionLayoutSettings>(settings: T, file: string, rule: RegionLayoutRule): T {
  validateRegion(rule);
  const previous = settings.regionLayouts?.[file] || [];
  return {...settings,regionLayouts:{...settings.regionLayouts,[file]:[
    ...previous.filter(r=>r.id!==rule.id && (r.page!==rule.page || !overlaps(r.rect,rule.rect))), rule,
  ]}};
}
export function regionRevision(settings: RegionLayoutSettings, file: string, page: number): string {
  const rules=rulesForPage(settings,file,page);
  return rules.length ? JSON.stringify(rules) : '';
}
export interface ExplicitGroup { spans: InputRect[]; column?: number; row?: number }
function lines(spans: InputRect[]): InputRect[][] {
  const result: InputRect[][]=[];
  for(const s of [...spans].sort((a,b)=>a.bottom-b.bottom||a.left-b.left)) {
    const last=result[result.length-1];
    const fs=s.fontsize||s.bottom-s.top||10;
    if(last && Math.abs(last[0].bottom-s.bottom)<=Math.min(fs,last[0].fontsize||fs)*0.35) last.push(s);
    else result.push([s]);
  }
  return result.map(row=>row.sort((a,b)=>a.left-b.left));
}
/** Each input object occurs exactly once. No prose repair runs across these groups. */
export function explicitGroups(spans: InputRect[], rule: RegionLayoutRule, width: number, height: number): ExplicitGroup[] {
  validateRegion(rule);
  if(!spans.length) return [];
  const ordered=lines(spans);
  if(rule.mode==='single-paragraph') return [{spans:ordered.flat()}];
  const x0=rule.rect.left*width, y0=rule.rect.top*height;
  const w=rule.rect.width*width, h=rule.rect.height*height;
  const xs=(rule.columns ?? [0.5]).map(x=>x0+x*w);
  const bucket=(v:number,cuts:number[])=>cuts.filter(c=>v>=c).length;
  if(rule.mode==='explicit-columns') {
    const groups=[[],[]] as InputRect[][];
    for(const s of ordered.flat()) groups[bucket((s.left+s.right)/2,xs)].push(s);
    return groups.map((spans,column)=>({spans,column})).filter(g=>g.spans.length);
  }
  if(rule.mode==='table') {
    // Explicit row dividers support wrapped/multiline cells. Without them,
    // baseline rows are an editable starting grid, not a claim about logical rows.
    const ys=rule.rows?.map(y=>y0+y*h);
    const cells=new Map<string,ExplicitGroup>();
    ordered.forEach((line,lineIndex)=>line.forEach(s=>{
      let column=bucket((s.left+s.right)/2,xs);
      let row=ys?bucket((s.top+s.bottom)/2,ys):lineIndex;
      const merged=rule.mergedCells?.find(m=>row>=m.row&&row<=m.lastRow&&column>=m.column&&column<=m.lastColumn);
      if(merged){row=merged.row;column=merged.column;}
      const key=`${row}:${column}`;const cell=cells.get(key)||{spans:[],row,column};
      cell.spans.push(s);cells.set(key,cell);
    }));
    return [...cells.values()].sort((a,b)=>a.row!-b.row!||a.column!-b.column!);
  }
  // Explicit horizontal dividers take precedence over whitespace grouping.
  if(rule.rows?.length) {
    const ys=rule.rows.map(y=>y0+y*h), groups=new Map<number,InputRect[]>();
    for(const s of ordered.flat()){const i=bucket((s.top+s.bottom)/2,ys);const g=groups.get(i)||[];g.push(s);groups.set(i,g);}
    return [...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([,spans])=>({spans}));
  }
  const groups: ExplicitGroup[]=[];
  for(const line of ordered) {
    // Split widely separated same-line labels before joining consecutive lines.
    const runs: InputRect[][]=[];
    for(const s of line){const last=runs.at(-1);if(!last || s.left-last.at(-1)!.right>Math.max(8,(s.fontsize||10)*1.5))runs.push([s]);else last.push(s);}
    for(const run of runs){
      const top=Math.min(...run.map(s=>s.top)), left=run[0].left, right=Math.max(...run.map(s=>s.right));
      const fs=run[0].fontsize||10;
      const previous=[...groups].reverse().find(g=>{
        const bottom=Math.max(...g.spans.map(s=>s.bottom));
        const gl=Math.min(...g.spans.map(s=>s.left)),gr=Math.max(...g.spans.map(s=>s.right));
        return top>=bottom-0.2*fs && top-bottom<=(rule.paragraphGapEm??0.65)*fs && Math.min(right,gr)>Math.max(left,gl);
      });
      if(previous) previous.spans.push(...run);else groups.push({spans:[...run]});
    }
  }
  return groups;
}

export function screenToPageRegion(selection: {left:number;top:number;right:number;bottom:number},
  frame: {left:number;top:number;width:number;height:number}): RegionRect | null {
  if(!(frame.width>0&&frame.height>0))return null;
  const left=Math.max(0,(selection.left-frame.left)/frame.width), top=Math.max(0,(selection.top-frame.top)/frame.height);
  const right=Math.min(1,(selection.right-frame.left)/frame.width), bottom=Math.min(1,(selection.bottom-frame.top)/frame.height);
  return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;
}
