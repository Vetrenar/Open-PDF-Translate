// ocr-text.ts
// ─────────────────────────────────────────────────────────────────────────
// OCR ENGINE — recognize a PDF (scanned/image) into a translated Markdown note.
//
// This is a distinct workflow from the internal/python overlay engines:
//   • It rasterizes each page, sends the image to a vision model for
//     transcription (no coordinates / no JSON), translates the text, and writes
//     a standalone note. No overlays, no viewer geometry math.
//   • The note is written INCREMENTALLY (page by page), so a long run that is
//     cancelled or errors midway still leaves a usable, resumable file.
//
// Public surface:
//   • recognizeDocument(pdf, opts)  — OCR a page range into the note
//   • recognizeCurrentPage(pdf)     — OCR just the visible page, upsert into note
//   • cancel()                      — stop an in-progress run
// ─────────────────────────────────────────────────────────────────────────

import { Notice, TFile, normalizePath } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { PageCapture } from './page-capture';
import { formatPdfSourceLine } from './pdf-source';

export interface OcrRunOptions {
    fromPage?: number;       // 1-based inclusive. Default 1.
    toPage?: number;         // 1-based inclusive. Default: detected total.
    pacingMs?: number;       // delay between pages. Default 350.
    onProgress?: (done: number, total: number, page: number) => void;
}

interface PageResult {
    page: number;
    translated: string;
}

const PAGE_MARKER = (p: number) => `<!-- ocr-page:${p} -->`;

export class OcrTextTranslator {
    private plugin: OpenRouterTranslatorPlugin;
    private capture: PageCapture;
    private cancelled = false;
    private running = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.capture = new PageCapture(plugin);
    }

    public cancel(): void { this.cancelled = true; }
    public isRunning(): boolean { return this.running; }

    private get dom() { return this.plugin.pdfDom; }
    private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

    // ── Prompt ────────────────────────────────────────────────────────────
    private transcriptionPrompt(): string | null {
        const ocr = this.plugin.settings.ocrProvider;
        return ocr?.ocrTextPromptTemplate || ocr?.ocrPromptTemplate || null;
    }

    // ── Capture + OCR a single page (with render retries) ─────────────────
    private async ocrSinglePage(pageNum: number, prompt: string): Promise<string | null> {
        // Make sure the page is rendered (canvas has pixels) before capture.
        let pageEl = await this.dom.waitForRenderedPage(pageNum, { timeoutMs: 12000 });
        if (!pageEl) {
            // One more nudge: scroll + wait, viewers sometimes need a beat.
            await this.sleep(400);
            pageEl = await this.dom.waitForRenderedPage(pageNum, { timeoutMs: 6000 });
            if (!pageEl) throw new Error(`page ${pageNum} did not render`);
        }

        const image = this.capture.captureForOcr(pageEl);
        if (!image) throw new Error(`page ${pageNum} capture returned no image`);

        const raw = await this.plugin.processor.ocrLayoutService.ocrPageText(prompt, image);
        return (raw || '').trim() || null;
    }

    // ── Translate transcribed text (chunked to avoid output truncation) ────
    private async translateText(text: string): Promise<string> {
        const limit = Math.max(1000, this.plugin.settings.maxBatchChars || 4000);
        if (text.length <= limit) {
            return (await this.plugin.translation.translateWithOpenRouter(text)).trim();
        }
        const paras = text.split(/\n{2,}/);
        const chunks: string[] = [];
        let cur = '';
        for (const p of paras) {
            if (cur && cur.length + p.length + 2 > limit) { chunks.push(cur); cur = ''; }
            cur = cur ? `${cur}\n\n${p}` : p;
        }
        if (cur) chunks.push(cur);
        const out: string[] = [];
        for (const c of chunks) {
            if (this.cancelled) break;
            out.push((await this.plugin.translation.translateWithOpenRouter(c)).trim());
        }
        return out.join('\n\n');
    }

    // ── Output path ────────────────────────────────────────────────────────
    private sanitizeName(name: string): string {
        return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'recognized';
    }

    private outputPath(pdf: TFile): string {
        const ocr = this.plugin.settings.ocrProvider;
        const pattern = ocr?.ocrOutputFilenamePattern || '{pdfname}.translated';
        const date = new Date().toISOString().slice(0, 10);
        const baseName = this.sanitizeName(
            pattern.replace(/\{pdfname\}/g, pdf.basename).replace(/\{date\}/g, date)
        );
        const folderRaw = (ocr?.ocrOutputFolder || '').trim().replace(/\/+$/, '');
        let dir: string;
        if (folderRaw) {
            dir = folderRaw + '/';
        } else {
            const parent = pdf.parent?.path;
            dir = parent && parent !== '/' ? `${parent}/` : '';
        }
        return normalizePath(`${dir}${baseName}.md`);
    }

    private async ensureFolder(filePath: string): Promise<void> {
        const slash = filePath.lastIndexOf('/');
        if (slash <= 0) return;
        const folder = filePath.slice(0, slash);
        const existing = this.plugin.app.vault.getAbstractFileByPath(folder);
        if (!existing) {
            try { await this.plugin.app.vault.createFolder(folder); } catch { /* exists/race */ }
        }
    }

    // ── Note file: read/create, then upsert page sections by marker ───────
    private buildFrontmatter(pdf: TFile): string {
        const ocr = this.plugin.settings.ocrProvider;
        return [
            '---',
            formatPdfSourceLine(pdf.path),
            `ocr-model: ${ocr?.model || 'unknown'}`,
            `target-language: ${this.plugin.settings.targetLanguage}`,
            `generated: ${new Date().toISOString()}`,
            '---',
            '',
            `# ${pdf.basename} — translation`,
            '',
        ].join('\n');
    }

    private async getOrCreateNote(pdf: TFile): Promise<TFile> {
        const outPath = this.outputPath(pdf);
        await this.ensureFolder(outPath);
        const existing = this.plugin.app.vault.getAbstractFileByPath(outPath);
        if (existing instanceof TFile) return existing;
        this.plugin.markSelfWrite(outPath);
        return this.plugin.app.vault.create(outPath, this.buildFrontmatter(pdf));
    }

    private pageSection(pdf: TFile, page: number, translated: string): string {
        return [
            PAGE_MARKER(page),
            `## Page ${page}`,
            `[[${pdf.path}#page=${page}|→ page ${page}]]`,
            '',
            translated,
            '',
        ].join('\n');
    }

    /**
     * Insert or replace a page's section in the note, keeping sections ordered
     * by page number. Idempotent — re-running a page overwrites its block.
     */
    private async upsertPage(note: TFile, pdf: TFile, result: PageResult): Promise<void> {
        const content = await this.plugin.app.vault.read(note);
        const newSection = this.pageSection(pdf, result.page, result.translated);

        // Split off frontmatter so we never disturb it.
        const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
        const head = fmMatch ? fmMatch[0] : this.buildFrontmatter(pdf) + '\n';
        let body = fmMatch ? content.slice(fmMatch[0].length) : content;

        // Parse existing page blocks keyed by page number.
        const blocks = new Map<number, string>();
        const re = /<!-- ocr-page:(\d+) -->[\s\S]*?(?=<!-- ocr-page:\d+ -->|$)/g;
        let m: RegExpExecArray | null;
        let firstIdx = -1;
        while ((m = re.exec(body)) !== null) {
            if (firstIdx < 0) firstIdx = m.index;
            blocks.set(parseInt(m[1], 10), m[0].trim());
        }
        const preamble = firstIdx >= 0 ? body.slice(0, firstIdx) : body;

        blocks.set(result.page, newSection.trim());
        const ordered = [...blocks.keys()].sort((a, b) => a - b)
            .map(p => blocks.get(p)!).join('\n\n');

        const rebuilt = head + (preamble.trim() ? preamble.trimEnd() + '\n\n' : '') + ordered + '\n';
        this.plugin.markSelfWrite(note.path);
        await this.plugin.app.vault.modify(note, rebuilt);
    }

    // ── Public: OCR a page range into the note ────────────────────────────
    public async recognizeDocument(pdf: TFile, opts: OcrRunOptions = {}): Promise<void> {
        if (this.running) { new Notice('OCR is already running.'); return; }
        const prompt = this.transcriptionPrompt();
        if (!prompt) { new Notice('OCR transcription prompt is not configured.'); return; }

        const leaf = this.dom.resolveLeafForFile(pdf);
        if (!leaf) { new Notice('Open the PDF first.'); return; }
        // Ensure the target PDF is actually shown in that leaf.
        if (this.dom.getFile(leaf)?.path !== pdf.path) {
            await (leaf as any).openFile(pdf);
            await this.sleep(300);
        }

        this.cancelled = false;
        this.running = true;
        try {
            const total = await this.dom.getTotalPages(leaf, true);
            const from = Math.max(1, opts.fromPage ?? 1);
            const to = Math.max(from, opts.toPage ?? (total || from));
            const pacing = opts.pacingMs ?? 350;

            const note = await this.getOrCreateNote(pdf);
            let done = 0, failed = 0;
            const failedPages: number[] = [];

            for (let p = from; p <= to; p++) {
                if (this.cancelled) { new Notice('OCR cancelled.'); break; }
                opts.onProgress?.(done, to - from + 1, p);

                try {
                    const original = await this.ocrSinglePage(p, prompt);
                    if (!original) { continue; } // genuinely blank page
                    if (this.cancelled) break;
                    const translated = (await this.translateText(original)).trim();
                    if (!translated) { failed++; failedPages.push(p); continue; }
                    await this.upsertPage(note, pdf, { page: p, translated });
                    done++;
                } catch (err: any) {
                    console.error(`[OCR] page ${p} failed:`, err);
                    failed++; failedPages.push(p);
                }
                if (p < to) await this.sleep(pacing);
            }

            if (done > 0) {
                const openLeaf = this.plugin.app.workspace.getLeaf('tab');
                await openLeaf.openFile(note);
            }
            const tail = failed ? ` ${failed} page(s) failed${failedPages.length ? ` (${failedPages.slice(0, 10).join(', ')}${failedPages.length > 10 ? '…' : ''})` : ''}.` : '';
            new Notice(done > 0
                ? `OCR done: ${done} page(s) written.${tail}`
                : `OCR produced no pages.${tail}`, 7000);
        } finally {
            this.running = false;
        }
    }

    // ── Public: OCR just the current visible page, upsert into the note ───
    public async recognizeCurrentPage(pdf: TFile): Promise<void> {
        if (this.running) { new Notice('OCR is already running.'); return; }
        const prompt = this.transcriptionPrompt();
        if (!prompt) { new Notice('OCR transcription prompt is not configured.'); return; }

        const pageNum = this.plugin.getCurrentPageNumber();
        if (!pageNum) { new Notice('Could not determine the current page.'); return; }

        this.cancelled = false;
        this.running = true;
        try {
            new Notice(`OCR page ${pageNum}…`, 2000);
            const original = await this.ocrSinglePage(pageNum, prompt);
            if (!original) { new Notice(`Page ${pageNum}: no text recognized.`); return; }
            const translated = (await this.translateText(original)).trim();
            if (!translated) { new Notice(`Page ${pageNum}: translation failed.`); return; }

            const note = await this.getOrCreateNote(pdf);
            await this.upsertPage(note, pdf, { page: pageNum, translated });
            await this.plugin.app.workspace.getLeaf('tab').openFile(note);
            new Notice(`OCR page ${pageNum} written.`, 4000);
        } catch (err: any) {
            console.error(`[OCR] current page failed:`, err);
            new Notice(`OCR failed: ${err?.message ?? err}`, 5000);
        } finally {
            this.running = false;
        }
    }

    // Back-compat shim for older callers.
    public async run(pdf: TFile, opts: OcrRunOptions = {}): Promise<void> {
        return this.recognizeDocument(pdf, opts);
    }
}
