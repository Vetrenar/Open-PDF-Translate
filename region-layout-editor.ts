import { Modal, Notice, Setting, TFile, ButtonComponent } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { LayoutSettings } from './layout-modal';
import type { NormalizedParagraph } from './pdf-text-extractor';
import type { OverlayPositionData } from './types';
import { isManualMode, overlaps, withRegion, validateRegion, type RegionLayoutRule, type RegionRect } from './region-layout';
import { computeLayoutSettingsHash, generateOverlayId, getCurrentEngine, uuid } from './overlay-id';
import { fallbackIndices } from './translation-result';
import { makeAbortError, isAbortError } from './job-token';

export const LAYOUT_LABELS = {
  'single-paragraph': 'Один параграф', 'explicit-columns': 'Две колонки',
  'table': 'Таблица', 'separate-paragraphs': 'Разрозненные параграфы',
};
/** Expand through old/new boxes to replace a complete affected component.
 * A formerly merged box can cover both columns: its unselected remainder
 * must be re-extracted as well, not discarded by a rectangle-overlap merge. */
export function affectedLayout(old: OverlayPositionData[], fresh: NormalizedParagraph[], region: RegionRect) {
  const bounds=[region], oldSet=new Set<number>(), newSet=new Set<number>();
  let changed=true;
  while(changed) {
    changed=false;
    old.forEach((p,i)=>{if(!oldSet.has(i)&&bounds.some(r=>overlaps(r,p.relativeRect))){oldSet.add(i);bounds.push(p.relativeRect);changed=true;}});
    fresh.forEach((p,i)=>{if(!newSet.has(i)&&bounds.some(r=>overlaps(r,p.relativeRect))){newSet.add(i);bounds.push(p.relativeRect);changed=true;}});
  }
  return {oldSet,newSet};
}
function settingsFingerprint(settings: LayoutSettings) {
  return computeLayoutSettingsHash(settings)+JSON.stringify(settings.regionLayouts || {});
}
export async function applyRegionLayout(plugin: OpenRouterTranslatorPlugin, file: TFile, page: number,
  region: RegionRect, next: LayoutSettings, expectedSettings: string, signal?: AbortSignal,
  onProgress: (message: string) => void = () => {}): Promise<{segments:number; fallbacks:number}> {
  const check=()=>{if(signal?.aborted)throw makeAbortError();};
  let segments=0, fallbacks=0;
  onProgress('Ожидание текущего задания для PDF…');
  await plugin.pdfLayoutQueue.withFileLock(file.path,async()=>{
    check();
    if(settingsFingerprint(plugin.layoutSettings)!==expectedSettings) throw new Error('Layout settings changed. Open a fresh preview.');
    onProgress('Чтение сохранённого перевода…');
    const saved=await plugin.storage.readSavedOverlayForFile(file);
    const old: OverlayPositionData[]=saved?.overlay.pageOverlays[page] || [];
    onProgress('Обработка выбранной области…');
    const {paragraphs}=await plugin.pdfLayoutService.extractPage(file,page,next);
    check();
    const {oldSet,newSet}=affectedLayout(old,paragraphs,region);
    const selected=paragraphs.filter((_,i)=>newSet.has(i));
    if(!selected.length) throw new Error('No native text in this region. Existing translations were kept.');
    segments=selected.length;
    onProgress(`Перевод ${segments} блоков…`);
    const translated=await plugin.processor.executeTranslation(selected.map(p=>({text:p.text,originalSpans:[]} as any)),{signal});
    check();
    const replacement: OverlayPositionData[]=selected.map((p,i)=>({
      selector:'',textContent:p.text,translatedText:translated[i] || p.text,
      translationStatus:fallbackIndices(translated).has(i)?'fallback':undefined,
      relativeRect:p.relativeRect,page,fontSize:p.fontSize,fontFamily:p.fontFamily,originalFontSizes:p.originalFontSizes,
      id:generateOverlayId(page,p.relativeRect,p.text),engine:getCurrentEngine(plugin),
    }));
    const combined=[...old.filter((_,i)=>!oldSet.has(i)),...replacement];
    if(settingsFingerprint(plugin.layoutSettings)!==expectedSettings) throw new Error('Layout settings changed during translation. Retry.');
    fallbacks=fallbackIndices(translated).size;
    onProgress('Сохранение перевода и правил…');
    const previous=plugin.layoutSettings;
    plugin.layoutSettings=next;
    try {
      await plugin.saveSettings();
      check();
      await plugin.storage.updatePageOverlaysAndWrite(file,{[page]:combined},{replace:true,expectedPages:{[page]:old}});
    } catch(error) {
      plugin.layoutSettings=previous;
      await plugin.saveSettings();
      throw error;
    }
    plugin.processor.updateLayoutDetectorSettings(next);
    plugin.processor.externalLayoutService?.clearCache(file.path);

  },signal);
  onProgress('Обновление перевода на странице…');
  try {
    plugin.overlay.invalidatePage(page);
    const leaf=plugin.app?.workspace?.getLeavesOfType?.('pdf')?.find(leaf=>(leaf.view as any).file?.path===file.path);
    await plugin.overlay.loadSavedOverlayForPage(page,true,leaf);
  } catch(error) {
    console.error('[RegionLayoutEditor] Translation saved; overlay refresh failed',error);
    new Notice('Перевод сохранён, но страницу не удалось обновить. Повторно откройте PDF.',8000);
  }
  return {segments,fallbacks};
}

/** Native extraction preview; no LLM calls until Apply. */
export class RegionLayoutEditor extends Modal {
  private id=uuid();
  private intrinsicRotation?: number;
  private mode='explicit-columns';
  private columns='50';
  private rows='';
  private merges='';
  private region: RegionRect;
  private revision=0;
  private busy=false;
  private closed=false;
  private applyComponent?: ButtonComponent;
  private previewComponent?: ButtonComponent;
  private progressNotice?: Notice;
  private abort=new AbortController();
  private baseline: LayoutSettings;
  private fingerprint: string;
  private previewEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private applyButton!: HTMLButtonElement;
  private columnInput?: HTMLInputElement;
  private rowInput?: HTMLInputElement;
  private prepared?: LayoutSettings;
  constructor(private plugin: OpenRouterTranslatorPlugin,private file: TFile,private page: number, region: RegionRect, private displayRotation?: number) {
    super(plugin.app);
    this.region={...region};
    if(isManualMode(plugin.layoutSettings.layoutPreset))this.mode=plugin.layoutSettings.layoutPreset;
    this.baseline=JSON.parse(JSON.stringify(plugin.layoutSettings));
    this.fingerprint=settingsFingerprint(this.baseline);
    const prior=this.baseline.regionLayouts?.[file.path]?.find(r=>r.page===page && overlaps(r.rect,region));
    if(prior){this.id=prior.id;this.mode=prior.mode;this.region={...prior.rect};this.columns=(prior.columns??[0.5]).map(x=>x*100).join(', ');this.rows=(prior.rows??[]).map(x=>x*100).join(', ');this.merges=(prior.mergedCells||[]).map(m=>`${m.row+1}:${m.column+1}-${m.lastRow+1}:${m.lastColumn+1}`).join('; ');}
  }
  onOpen() {
    this.titleEl.setText(`Layout — ${this.file.basename}, стр. ${this.page}`);
    this.contentEl.createEl('p',{text:'Предпросмотр не вызывает модель. Разделители задаются в % ширины/высоты области; их можно перетаскивать на схеме. Для таблицы задайте строки вручную, чтобы объединить переносы в одну ячейку. Страницы с ручными правилами используют native layout, в том числе при Python-переводе.'});
    const existing=(this.baseline.regionLayouts?.[this.file.path]||[]).filter(r=>r.page===this.page);
    if(existing.length>1) {
      const list=this.contentEl.createDiv();
      list.createEl('p',{text:'Сохранённые области этой страницы:'});
      existing.forEach((r,i)=>{
        const button=list.createEl('button',{text:`${i+1}. ${LAYOUT_LABELS[r.mode]}`});
        button.onclick=()=>{if(this.busy)return;this.close();new RegionLayoutEditor(this.plugin,this.file,this.page,r.rect,this.displayRotation).open();};
      });
    }
    new Setting(this.contentEl).setName('Режим').addDropdown(d=>{
      d.addOption('auto','Удалить ручное правило (Авто)');
      for(const [id,label] of Object.entries(LAYOUT_LABELS))d.addOption(id,label);
      d.setValue(this.mode).onChange(v=>{this.mode=v;this.invalidate();});
    });
    for(const key of ['left','top','width','height'] as const) {
      new Setting(this.contentEl).setName({left:'Слева, %',top:'Сверху, %',width:'Ширина, %',height:'Высота, %'}[key])
        .addText(t=>t.setValue((this.region[key]*100).toFixed(2)).onChange(v=>{this.region[key]=Number(v)/100;this.invalidate();}));
    }
    new Setting(this.contentEl).setName('Вертикальные разделители, %').setDesc('Например: 35, 70. Для двух колонок нужен один разделитель.')
      .addText(t=>{this.columnInput=t.inputEl;t.setValue(this.columns).onChange(v=>{this.columns=v;this.invalidate();});});
    new Setting(this.contentEl).setName('Горизонтальные разделители, %').setDesc('Пусто: автоматическая группировка строк. Например: 20, 45, 75.')
      .addText(t=>{this.rowInput=t.inputEl;t.setValue(this.rows).onChange(v=>{this.rows=v;this.invalidate();});});
    new Setting(this.contentEl).setName('Объединённые ячейки').setDesc('Строка:столбец–строка:столбец, нумерация с 1. Например: 1:1-1:3; 2:1-3:1')
      .addText(t=>t.setValue(this.merges).onChange(v=>{this.merges=v;this.invalidate();}));
    this.previewEl=this.contentEl.createDiv();
    Object.assign(this.previewEl.style,{position:'relative',width:'100%',height:'480px',background:'var(--background-secondary)',overflow:'hidden'});
    this.statusEl=this.contentEl.createEl('p');
    this.statusEl.setAttribute('role','status');
    this.statusEl.setAttribute('aria-live','polite');
    new Setting(this.contentEl).addButton(b=>{this.previewComponent=b;b.setButtonText('Предпросмотр').onClick(()=>void this.preview());})
      .addButton(b=>{this.applyComponent=b;this.applyButton=b.buttonEl;b.setButtonText('Применить и перевести').setCta().setDisabled(false).onClick(()=>void this.apply());});
    void this.preview();
  }
  private invalidate(){
    this.revision++;this.prepared=undefined;
    if(!this.busy)this.setApplyDisabled(false);
    if(this.statusEl)this.statusEl.setText('Параметры изменены. «Применить и перевести» проверит их и запустит перевод.');
  }
  private setApplyDisabled(disabled:boolean){
    if(this.applyComponent)this.applyComponent.setDisabled(disabled);
    else if(this.applyButton)this.applyButton.disabled=disabled;
  }
  private setBusy(busy:boolean){
    this.busy=busy;
    this.setApplyDisabled(busy);
    this.previewComponent?.setDisabled(busy);
    this.contentEl.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input, select').forEach(el=>el.disabled=busy);
    this.applyComponent?.setButtonText(busy?'Выполняется…':'Применить и перевести');
  }
  private progress(message:string){
    if(this.closed)return;
    this.statusEl.setText(message);
    this.progressNotice?.setMessage(message);
  }
  private cuts(text:string):number[]{return text.trim()?text.split(',').map(s=>Number(s.trim())/100):[];}
  private nextSettings(): LayoutSettings {
    validateRegion({id:this.id,page:this.page,rect:this.region,mode:'single-paragraph'});
    if(!isManualMode(this.mode)) {
      return {...this.baseline,regionLayouts:{...this.baseline.regionLayouts,[this.file.path]:(this.baseline.regionLayouts?.[this.file.path]||[]).filter(r=>r.page!==this.page||!overlaps(r.rect,this.region))}};
    }
    const rule:RegionLayoutRule={id:this.id,page:this.page,rotation:this.intrinsicRotation,rect:{...this.region},mode:this.mode,
      columns:this.cuts(this.columns),rows:this.rows.trim()?this.cuts(this.rows):undefined,
      mergedCells:this.merges.trim()?this.merges.split(';').map(part=>{
        const match=part.trim().match(/^(\d+):(\d+)[–-](\d+):(\d+)$/);
        if(!match)throw new Error('Формат объединения: 1:1-1:3; 2:1-3:1');
        return {row:Number(match[1])-1,column:Number(match[2])-1,lastRow:Number(match[3])-1,lastColumn:Number(match[4])-1};
      }):undefined};
    return withRegion(this.baseline,this.file.path,rule);
  }
  private async preview(forApply=false):Promise<boolean>{
    if(this.closed || (this.busy&&!forApply))return false;
    const revision=++this.revision;this.prepared=undefined;
    this.baseline=JSON.parse(JSON.stringify(this.plugin.layoutSettings));
    this.fingerprint=settingsFingerprint(this.baseline);
    try {
      const next=this.nextSettings();this.progress('Извлечение и проверка layout…');
      const result=await this.plugin.pdfLayoutService.extractPage(this.file,this.page,next);
      if(this.abort.signal.aborted||revision!==this.revision)return false;
      if(this.displayRotation!==undefined && ((this.displayRotation-(result.rotation||0))%360+360)%360!==0)
        throw new Error('Сбросьте дополнительный поворот PDF в просмотрщике перед правкой layout. Встроенный поворот страницы поддерживается.');
      this.intrinsicRotation=result.rotation||0;
      this.previewEl.empty();
      this.previewEl.style.height=`${Math.min(650,Math.max(280,500*result.pageHeight/result.pageWidth))}px`;
      for(const [i,p] of result.paragraphs.entries()){
        const box=this.previewEl.createDiv();const r=p.relativeRect;
        Object.assign(box.style,{position:'absolute',left:`${r.left*100}%`,top:`${r.top*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`,border:'1px solid var(--interactive-accent)',fontSize:'8px',overflow:'hidden'});
        box.setText(`${i+1}. ${p.text}`);box.title=p.text;
      }
      const selection=this.previewEl.createDiv();const r=this.region;
      Object.assign(selection.style,{position:'absolute',left:`${r.left*100}%`,top:`${r.top*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`,border:'2px dashed orange',pointerEvents:'none'});
      for(const axis of ['columns','rows'] as const){
        const cuts=this.cuts(axis==='columns'?this.columns:this.rows);
        cuts.forEach((cut,index)=>this.divider(axis,index,cut,cuts));
      }
      const saved=await this.plugin.storage.readSavedOverlayForFile(this.file);
      if(this.abort.signal.aborted||revision!==this.revision)return false;
      const affected=affectedLayout(saved?.overlay.pageOverlays[this.page]||[],result.paragraphs,this.region);
      this.statusEl.setText(`Страница: ${result.paragraphs.length} блоков. Будут переведены ${affected.newSet.size} блоков; старый объединённый bbox может расширить область правки. Оранжевая рамка — ваше правило.`);
      if(this.mode==='explicit-columns' || this.mode==='table') {
        const cuts=this.cuts(this.columns).map(x=>this.region.left+x*this.region.width);
        const crossing=result.paragraphs.flatMap(p=>p.spans).filter(s=>
          s.top<this.region.top+this.region.height&&s.bottom>this.region.top&&cuts.some(x=>s.left<x-0.002&&s.right>x+0.002));
        if(crossing.length) this.statusEl.appendText(` Внимание: ${crossing.length} исходных текстовых фрагментов пересекают разделитель. Проверьте схему и переместите его: фрагменты сохраняются целиком.`);
      }
      if(!affected.newSet.size)throw new Error('В выбранной области нет native-текста. Перевод не запущен; существующие блоки сохранены.');
      this.prepared=this.nextSettings();
      if(!this.busy)this.setApplyDisabled(false);
      return true;
    }catch(error:any){
      if(!this.abort.signal.aborted&&revision===this.revision)this.progress(error.message||String(error));
      if(forApply)throw error;
      return false;
    }
  }
  private divider(axis:'columns'|'rows',index:number,cut:number,cuts:number[]){
    const el=this.previewEl.createDiv(),r=this.region,vertical=axis==='columns';
    Object.assign(el.style,{position:'absolute',background:'orange',zIndex:'5',touchAction:'none',cursor:vertical?'col-resize':'row-resize',
      left:`${(vertical?r.left+cut*r.width:r.left)*100}%`,top:`${(vertical?r.top:r.top+cut*r.height)*100}%`,
      width:vertical?'4px':`${r.width*100}%`,height:vertical?`${r.height*100}%`:'4px'});
    el.onpointerdown=e=>{if(this.busy)return;el.setPointerCapture(e.pointerId);e.preventDefault();};
    el.onpointermove=e=>{
      if(!el.hasPointerCapture(e.pointerId)||this.busy)return;
      const box=this.previewEl.getBoundingClientRect();
      const value=vertical?((e.clientX-box.left)/box.width-r.left)/r.width:((e.clientY-box.top)/box.height-r.top)/r.height;
      cuts[index]=Math.max((cuts[index-1]??0)+0.005,Math.min((cuts[index+1]??1)-0.005,value));
      const text=cuts.map(x=>(x*100).toFixed(2)).join(', ');
      if(vertical){this.columns=text;if(this.columnInput)this.columnInput.value=text;el.style.left=`${(r.left+cuts[index]*r.width)*100}%`;}
      else{this.rows=text;if(this.rowInput)this.rowInput.value=text;el.style.top=`${(r.top+cuts[index]*r.height)*100}%`;}
      this.invalidate();
    };
    el.onpointerup=e=>{if(el.hasPointerCapture(e.pointerId)){el.releasePointerCapture(e.pointerId);void this.preview();}};
  }
  private async apply(){
    if(this.busy || this.closed)return;
    this.setBusy(true);
    this.progressNotice=new Notice('Проверка разметки перед переводом…',0);
    try{
      // The primary action is self-contained: edited controls do not require
      // a separate Preview click. A stale in-flight preview cannot win this one.
      if(!this.prepared && !await this.preview(true)) {
        if(this.abort.signal.aborted)throw makeAbortError();
        throw new Error('Параметры изменились во время проверки. Повторите применение.');
      }
      if(this.abort.signal.aborted)throw makeAbortError();
      const result=await applyRegionLayout(this.plugin,this.file,this.page,{...this.region},this.prepared!,this.fingerprint,
        this.abort.signal,message=>this.progress(message));
      new Notice(result.fallbacks
        ? `Сохранено ${result.segments} блоков. Для ${result.fallbacks} блоков сохранён оригинал с bbox: перевод можно повторить.`
        : `Переведено и сохранено ${result.segments} блоков.`);
      this.close();
    }catch(error:any){
      if(!isAbortError(error) && !this.closed){
        const message=`Не удалось применить layout: ${error.message||String(error)}`;
        console.error('[RegionLayoutEditor] Apply failed',error);
        this.progress(message);
        new Notice(message,8000);
      }
    }finally{
      this.progressNotice?.hide();this.progressNotice=undefined;
      this.prepared=undefined;
      if(!this.closed)this.setBusy(false);
    }
  }
  onClose(){this.closed=true;this.revision++;this.abort.abort();this.progressNotice?.hide();this.contentEl.empty();}
}
