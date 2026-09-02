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
//   • recognizeDocument(pdf, opts)  — OCR a page range into the note. Returns
//                                     { done, failed, failedPages } so callers
//                                     (e.g. OcrRecognizeModal) can show a
//                                     summary with a retry button.
//   • recognizeCurrentPage(pdf)     — OCR just the visible page, upsert into note
//   • cancel()                      — stop an in-progress run
// ─────────────────────────────────────────────────────────────────────────

import { Notice, TFile, normalizePath, type WorkspaceLeaf } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { PageCapture } from './page-capture';
import { formatPdfSourceLine } from './pdf-source';

export interface OcrRunOptions {
    fromPage?: number;       // 1-based inclusive. Default 1.
    toPage?: number;         // 1-based inclusive. Default: detected total.
    pacingMs?: number;       // delay between pages. Default 350.
    onProgress?: (done: number, total: number, page: number) => void;
}

/**
 * Result of {@link OcrTextTranslator.recognizeDocument}.  Returned so the
 * caller (e.g. {@link OcrRecognizeModal}) can surface a summary and offer a
 * retry button for the failed pages.
 */
export interface OcrRunResult {
    /** Number of pages successfully written to the note. */
    done: number;
    /** Number of pages that failed OCR or translation. */
    failed: number;
    /** 1-based page numbers that failed (subset of [fromPage, toPage]). */
    failedPages: number[];
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
    // P0-5 (Phase 1): `leaf` is now plumbed through from recognizeDocument
    // (which calls resolveLeafForFile(pdf)) so OCR captures the page from
    // the LEAF THAT OWNS THE PDF — not necessarily the active leaf. Without
    // this, multi-tab OCR would silently capture the wrong tab's page when
    // the user had switched focus to another PDF between page fetches.
    private async ocrSinglePage(pageNum: number, prompt: string, leaf?: WorkspaceLeaf): Promise<string | null> {
        // Make sure the page is rendered (canvas has pixels) before capture.
        let pageEl = await this.dom.waitForRenderedPage(pageNum, { timeoutMs: 12000 }, leaf);
        if (!pageEl) {
            // One more nudge: scroll + wait, viewers sometimes need a beat.
            await this.sleep(400);
            pageEl = await this.dom.waitForRenderedPage(pageNum, { timeoutMs: 6000 }, leaf);
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
        // P2-49 (Phase 16): markSelfWrite AFTER successful vault.create.
        // Previously the mark happened BEFORE the create, so a failed create
        // (race condition, disk full, permission error) would leak the path
        // into the self-write set and silently suppress legitimate future
        // watcher events for any file later created at the same path. Now
        // we only register the self-write when the file actually exists.
        const note = await this.plugin.app.vault.create(outPath, this.buildFrontmatter(pdf));
        this.plugin.markSelfWrite(outPath);
        return note;
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
     *
     * P2-48 (Phase 16): BATCHED writes. The previous implementation did a
     * full read+parse+merge+write on every page, producing O(n²) I/O for an
     * n-page document (100 pages → 10,000 section rewrites + 100 full-note
     * reads + 100 full-note writes). We now buffer up to 5 pages (or 2s
     * elapsed since the first buffered page) and flush them in a single
     * read+merge+write pass, reducing I/O to O(n).
     *
     * Callers that need to guarantee persistence (e.g. before opening the
     * note in a tab) should call `flushPendingPages` explicitly.
     */
    private pendingPages: Map<number, string> = new Map();
    private batchTimer: number | null = null;
    private batchFlushInFlight: Promise<void> | null = null;

    private async upsertPage(note: TFile, pdf: TFile, result: PageResult): Promise<void> {
        this.pendingPages.set(result.page, result.translated);
        if (this.pendingPages.size >= 5) {
            // Size threshold hit — flush immediately.
            await this.flushPendingPages(note, pdf);
        } else if (this.batchTimer === null) {
            // First pending page since the last flush — arm the timer.
            // Capture note/pdf in the closure so the timer can fire even
            // after the calling context returns.
            this.batchTimer = window.setTimeout(() => {
                this.batchTimer = null;
                void this.flushPendingPages(note, pdf);
            }, 2000);
        }
    }

    /**
     * Flush all buffered pages to the note in a single read+merge+write pass.
     * Safe to call concurrently — the second caller awaits the first flush
     * and then re-checks the buffer (which may have been repopulated).
     */
    private async flushPendingPages(note: TFile, pdf: TFile): Promise<void> {
        if (this.batchTimer !== null) {
            window.clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        if (this.pendingPages.size === 0) return;
        // Serialize concurrent flushes (size-triggered + timer-triggered).
        if (this.batchFlushInFlight) {
            await this.batchFlushInFlight;
            // After awaiting, new pages may have arrived — recurse to drain.
            if (this.pendingPages.size > 0) {
                return this.flushPendingPages(note, pdf);
            }
            return;
        }
        const pages = new Map(this.pendingPages);
        this.pendingPages.clear();
        const flush = (async () => {
            try {
                let content = await this.plugin.app.vault.read(note);
                for (const [pageNum, translated] of pages) {
                    content = this.mergePageIntoNote(content, pdf, pageNum, translated);
                }
                this.plugin.markSelfWrite(note.path);
                await this.plugin.app.vault.modify(note, content);
            } finally {
                this.batchFlushInFlight = null;
            }
        })();
        this.batchFlushInFlight = flush;
        await flush;
    }

    /**
     * Pure function: merge a single page section into the existing note
     * content, returning the rebuilt content. Does NOT touch disk. Extracted
     * from the old `upsertPage` so it can be reused for batched merges.
     */
    private mergePageIntoNote(content: string, pdf: TFile, page: number, translated: string): string {
        const newSection = this.pageSection(pdf, page, translated);

        // Split off frontmatter so we never disturb it.
        const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
        const head = fmMatch ? fmMatch[0] : this.buildFrontmatter(pdf) + '\n';
        const body = fmMatch ? content.slice(fmMatch[0].length) : content;

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

        blocks.set(page, newSection.trim());
        const ordered = [...blocks.keys()].sort((a, b) => a - b)
            .map(p => blocks.get(p)!).join('\n\n');

        return head + (preamble.trim() ? preamble.trimEnd() + '\n\n' : '') + ordered + '\n';
    }

    // ── Public: OCR a page range into the note ────────────────────────────
    // Returns { done, failed, failedPages } so the caller can show a summary
    // with a retry button. Early-exit paths return zero counts.
    public async recognizeDocument(pdf: TFile, opts: OcrRunOptions = {}): Promise<OcrRunResult> {
        if (this.running) { new Notice('OCR is already running.'); return { done: 0, failed: 0, failedPages: [] }; }
        const prompt = this.transcriptionPrompt();
        if (!prompt) { new Notice('OCR transcription prompt is not configured.'); return { done: 0, failed: 0, failedPages: [] }; }

        const leaf = this.dom.resolveLeafForFile(pdf);
        if (!leaf) { new Notice('Open the PDF first.'); return { done: 0, failed: 0, failedPages: [] }; }
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
                    // P0-5: pass the leaf we resolved at the start of recognizeDocument
                    // so multi-tab OCR targets the correct leaf, not the active one.
                    const original = await this.ocrSinglePage(p, prompt, leaf);
                    if (!original) { continue; } // genuinely blank page
                    if (this.cancelled) break;
                    const translated = (await this.translateText(original)).trim();
                    if (!translated) { failed++; failedPages.push(p); continue; }

                    // P1-25 (Phase 5): check cancel BEFORE writing. Without
                    // this, a user who clicked Cancel during the translateText
                    // await would still see the page upserted into the note —
                    // wasting a disk write the user explicitly abandoned.
                    if (this.cancelled) {
                        new Notice('OCR cancelled — page not saved.');
                        break;
                    }
                    await this.upsertPage(note, pdf, { page: p, translated });
                    done++;
                } catch (err: any) {
                    console.error(`[OCR] page ${p} failed:`, err);
                    failed++; failedPages.push(p);
                }
                if (p < to) await this.sleep(pacing);
            }

            // P2-48 (Phase 16): drain any pages still buffered by the batched
            // upsertPage before reporting completion or opening the note.
            // Without this, the final <5 pages would be lost on cancellation
            // or queued behind the 2s timer when the user closes the app.
            await this.flushPendingPages(note, pdf);

            if (done > 0 && !this.cancelled) {
                // P1-25 (Phase 5): don't open the note if the run was
                // cancelled — opening a tab steals focus from whatever the
                // user switched to after clicking Cancel, and the partial
                // note may be misleading (suggests a complete result).
                const openLeaf = this.plugin.app.workspace.getLeaf('tab');
                await openLeaf.openFile(note);
            }
            const tail = failed ? ` ${failed} page(s) failed${failedPages.length ? ` (${failedPages.slice(0, 10).join(', ')}${failedPages.length > 10 ? '…' : ''})` : ''}.` : '';
            new Notice(done > 0
                ? `OCR done: ${done} page(s) written.${tail}`
                : `OCR produced no pages.${tail}`, 7000);
            return { done, failed, failedPages };
        } finally {
            this.running = false;
        }
    }

    // ── Public: OCR just the current visible page, upsert into the note ───
    public async recognizeCurrentPage(pdf: TFile): Promise<void> {
        // P1-26 (Phase 5): if a previous recognizeDocument run was cancelled
        // (and `cancelled` was never reset — recognizeDocument's finally only
        // clears `running`, not `cancelled`), bail out immediately. Without
        // this guard, calling recognizeCurrentPage after a cancelled run
        // would silently no-op through every `if (this.cancelled)` check
        // inside translateText / etc. and the user would see no feedback.
        if (this.cancelled) return;
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
            // P1-26 (Phase 5): check cancel after the (slow) OCR await —
            // user may have clicked Cancel during the image recognition.
            if (this.cancelled) { new Notice('OCR cancelled — page not saved.'); return; }
            const translated = (await this.translateText(original)).trim();
            if (!translated) { new Notice(`Page ${pageNum}: translation failed.`); return; }
            // P1-26 (Phase 5): final cancel check before the disk write,
            // mirroring recognizeDocument's pre-upsertPage guard.
            if (this.cancelled) { new Notice('OCR cancelled — page not saved.'); return; }

            const note = await this.getOrCreateNote(pdf);
            await this.upsertPage(note, pdf, { page: pageNum, translated });
            // P2-48 (Phase 16): single-page upsert sits in the batch buffer;
            // flush immediately so the note on disk reflects the new page
            // before we open it and before any cancel/error short-circuit.
            await this.flushPendingPages(note, pdf);
            // P1-26 (Phase 5): don't open the note if cancelled mid-write.
            if (this.cancelled) return;
            await this.plugin.app.workspace.getLeaf('tab').openFile(note);
            new Notice(`OCR page ${pageNum} written.`, 4000);
        } catch (err: any) {
            console.error(`[OCR] current page failed:`, err);
            new Notice(`OCR failed: ${err?.message ?? err}`, 5000);
        } finally {
            this.running = false;
        }
    }

    // Back-compat shim for older callers. Forwards the full result so callers
    // that already awaited `run()` keep working; new callers should call
    // `recognizeDocument` directly to read the counters.
    public async run(pdf: TFile, opts: OcrRunOptions = {}): Promise<OcrRunResult> {
        return this.recognizeDocument(pdf, opts);
    }
}
