import { fallbackIndices } from './translation-result';
import { Notice, TFile } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { OverlayPositionData } from './types';
import { generateOverlayId, getCurrentEngine } from './overlay-id';
import { JobToken, raceSignal, isAbortError, makeAbortError, abortableDelay } from './job-token';
import { FileJob } from './file-job';

export interface HeadlessResult {
    ok: boolean;
    pages: number;
    segments: number;
    error?: string;
    failedPages?: number[];
    cancelled?: boolean;
}

/** Python layout extraction followed by the same translation pipeline as the UI. */
export class HeadlessTranslator {
    private job: JobToken | null = null;
    constructor(private plugin: OpenRouterTranslatorPlugin) {}
    cancel() { this.job?.cancel('headless translator cancelled'); }

    canRun(): { ok: boolean; reason?: string } {
        const s = this.plugin.settings;
        if (s.layoutEngine !== 'python') return { ok: false, reason: 'Background translation requires the Python layout engine.' };
        if (!s.pythonPath || !s.ocrScriptPath) return { ok: false, reason: 'Set the Python interpreter and layout script path in settings.' };
        return { ok: true };
    }

    private validRect(r: { l: number; t: number; w: number; h: number }): boolean {
        if (!r) return false;
        const { l, t, w, h } = r;
        return [l,t,w,h].every(Number.isFinite) && w > .001 && h > .001 &&
            l >= -.01 && t >= -.01 && l + w <= 1.01 && t + h <= 1.01;
    }

    async translateFile(pdf: TFile, opts: { force?: boolean; silent?: boolean } = {}): Promise<HeadlessResult> {
        if (this.job) return { ok: false, pages: 0, segments: 0, error: 'Translation already running' };
        const pre = this.canRun();
        if (!pre.ok) return { ok: false, pages: 0, segments: 0, error: pre.reason };
        const job = new JobToken('headless', pdf.basename);
        this.job = job;
        try {
            // Check cache INSIDE the lock: a prior run may have saved while we waited.
            return await this.plugin.pdfLayoutQueue.withFileLock(pdf.path, async () => {
                if (job.cancelled) throw makeAbortError();
                return this.translateLocked(pdf, job, opts);
            }, job.signal);
        } catch (e: any) {
            return { ok: false, pages: 0, segments: 0,
                cancelled: isAbortError(e), error: isAbortError(e) ? 'cancelled' : e?.message ?? String(e) };
        } finally {
            if (this.job === job) this.job = null;
        }
    }

    private async translateLocked(pdf: TFile, job: JobToken, opts: { force?: boolean; silent?: boolean }): Promise<HeadlessResult> {
        const check = () => { if (job.cancelled) throw makeAbortError(); };
        const cached = opts.force ? new Set<number>() : await FileJob.readCachedPages(this.plugin, pdf);
        check();
        const service = this.plugin.processor.externalLayoutService;
        service.clearCache(pdf.path);
        const layout = await raceSignal(service.generateLayout(pdf, {signal:job.signal}), job.signal);
        check();
        if (!layout) return { ok: false, pages: 0, segments: 0, error: 'layout extraction failed' };
        const allWork = Object.keys(layout).map(Number).filter(n => Number.isInteger(n) && n >= 1)
            .sort((a,b) => a-b).map(pageNum => ({pageNum,
                usable: (layout[String(pageNum)] || []).filter((it: any) => it.text?.trim() && this.validRect(it.rect))
            })).filter(page => page.usable.length > 0);
        if (!allWork.length) return { ok: false, pages: 0, segments: 0, error: 'no translatable text (is this a scan? use OCR)' };
        const work = allWork.filter(page => !cached.has(page.pageNum));
        if (!work.length) return { ok: true, pages: 0, segments: 0, error: 'already translated' };
        const configured = Number(this.plugin.settings.backgroundTranslationConcurrency);
        const concurrency = Number.isFinite(configured) ? Math.max(1, Math.min(8, Math.floor(configured))) : 3;
        const delay = Math.max(0, Number(this.plugin.settings.sequentialDelayMs) || 0);
        let pages = 0, segments = 0;
        const failures: Array<{ page: number; error: string }> = [];
        for (let i = 0; i < work.length && !job.cancelled; i += concurrency) {
            await Promise.all(work.slice(i, i + concurrency).map(async ({pageNum, usable}) => {
                try {
                    check();
                    const translated = await this.plugin.processor.executeTranslation(
                        usable.map((it: any) => ({text: it.text, originalSpans: []} as any)),
                        {signal: job.signal},
                    );
                    check();
                    const overlays: OverlayPositionData[] = usable.map((it: any, index: number) => {
                        const rect = {left:it.rect.l, top:it.rect.t, width:it.rect.w, height:it.rect.h};
                        return {selector:'', textContent:it.text, translationStatus:fallbackIndices(translated).has(index) ? 'fallback' : undefined, translatedText:translated[index], relativeRect:rect,
                            page:pageNum, fontSize:it.fontSize, fontFamily:it.fontFamily,
                            originalFontSizes:it.originalFontSizes || [],
                            id:generateOverlayId(pageNum, rect, it.text), engine:getCurrentEngine(this.plugin)};
                    });
                    await this.plugin.storage.updatePageOverlaysAndWrite(pdf, {[pageNum]:overlays});
                    pages++; segments += overlays.length;
                    if (fallbackIndices(translated).size) failures.push({page:pageNum, error:'Original text saved as fallback; retry translation'});
                } catch (e: any) {
                    if (!isAbortError(e)) failures.push({page:pageNum, error:e?.message ?? String(e)});
                }
            }));
            if (!opts.silent) new Notice(`[bg] ${pdf.basename}: ${pages}/${work.length} pages saved, ${failures.length} failed`, 1500);
            if (i + concurrency < work.length && !job.cancelled && delay > 0) {
                try { await abortableDelay(delay, job.signal); } catch (e) { if (!isAbortError(e)) throw e; }
            }
        }
        return {ok:!job.cancelled && failures.length === 0, pages, segments,
            ...(job.cancelled ? {cancelled:true, error:'cancelled'} : failures.length
                ? {error:failures.map(f => `p${f.page}: ${f.error}`).join('; ')} : {}),
            ...(failures.length ? {failedPages:failures.map(f => f.page)} : {})};
    }
}
