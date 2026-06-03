// headless-translate.ts
// ─────────────────────────────────────────────────────────────────────────
// Background (no open viewer) PDF → .translations.md translation.
//
// This works ONLY via the python layout engine: layout_engine.py (PyMuPDF)
// extracts text + coordinates straight from the file on disk, so nothing needs
// to be rendered in a tab. The internal/OCR engines can't do this because they
// read the live PDF.js DOM.
//
// Pipeline (entirely headless):
//   generateLayout(pdf)  →  per-page items {text, rect, font}
//   translate each item's text (batched, index-aligned)
//   build OverlayPositionData[] per page  (rect → relativeRect, with guards)
//   storage.writeSavedOverlayForFile(...)  →  <pdf>.translations.md
// ─────────────────────────────────────────────────────────────────────────

import { Notice, TFile } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';

export interface HeadlessResult {
    ok: boolean;
    pages: number;
    segments: number;
    error?: string;
}

export class HeadlessTranslator {
    private plugin: OpenRouterTranslatorPlugin;
    private cancelled = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    cancel() { this.cancelled = true; }

    /** Preconditions for headless mode (python engine + script + interpreter). */
    canRun(): { ok: boolean; reason?: string } {
        const s = this.plugin.settings;
        if (s.layoutEngine !== 'python') {
            return { ok: false, reason: 'Background translation requires the Python layout engine.' };
        }
        if (!s.pythonPath || !s.ocrScriptPath) {
            return { ok: false, reason: 'Set the Python interpreter and layout script path in settings.' };
        }
        return { ok: true };
    }

    private validRect(r: { l: number; t: number; w: number; h: number }): boolean {
        const { l, t, w, h } = r || ({} as any);
        return [l, t, w, h].every(Number.isFinite) &&
            w > 0.001 && h > 0.001 && l >= -0.01 && t >= -0.01 && l <= 1.01 && t <= 1.01;
    }

    /**
     * Translate one PDF headlessly and write its .translations.md.
     * Skips files that already have a translation unless force=true.
     */
    async translateFile(pdf: TFile, opts: { force?: boolean; silent?: boolean } = {}): Promise<HeadlessResult> {
        this.cancelled = false;
        const pre = this.canRun();
        if (!pre.ok) return { ok: false, pages: 0, segments: 0, error: pre.reason };

        // Don't redo existing work unless asked.
        if (!opts.force) {
            const existing = await this.plugin.storage.findTranslationFileForPdf(pdf).catch(() => null);
            if (existing) return { ok: true, pages: 0, segments: 0, error: 'already translated' };
        }

        // 1) Headless layout extraction (PyMuPDF, no DOM).
        this.plugin.processor.externalLayoutService.clearCache(pdf.path);
        const layout = await this.plugin.processor.externalLayoutService.generateLayout(pdf);
        if (!layout) return { ok: false, pages: 0, segments: 0, error: 'layout extraction failed' };
        if (this.cancelled) return { ok: false, pages: 0, segments: 0, error: 'cancelled' };

        // 2) Translate + build overlay data per page.
        const pageOverlays: Record<string, OverlayPositionData[]> = {};
        let pageCount = 0;
        let segCount = 0;

        const pageNumbers = Object.keys(layout).map(Number).sort((a, b) => a - b);
        for (const pageNum of pageNumbers) {
            if (this.cancelled) break;
            const items = layout[String(pageNum)] || [];
            const usable = items.filter(it => it.text?.trim() && this.validRect(it.rect));
            if (usable.length === 0) continue;

            // Batch-translate this page's segments, index-aligned.
            const fullText = usable.map((u, i) => `[#${i + 1}] ${u.text}`).join('\n');
            let translated: string[];
            try {
                const raw = await this.plugin.translation.translateBatch(fullText, usable.length);
                translated = await this.plugin.processor.extractNumberedLines(raw, usable.length, usable.map(u => u.text));
            } catch (e: any) {
                // Fall back to originals for this page rather than aborting the file.
                translated = usable.map(u => u.text);
            }

            const overlays: OverlayPositionData[] = usable.map((it, i) => ({
                selector: '',
                textContent: it.text,
                relativeRect: { left: it.rect.l, top: it.rect.t, width: it.rect.w, height: it.rect.h },
                page: pageNum,
                translatedText: translated[i] || it.text,
                fontSize: it.fontSize,
                fontFamily: it.fontFamily,
                originalFontSizes: it.originalFontSizes || [],
            }));

            pageOverlays[String(pageNum)] = overlays;
            pageCount++;
            segCount += overlays.length;
            if (!opts.silent) new Notice(`[bg] ${pdf.basename}: page ${pageNum}`, 1200);
        }

        if (pageCount === 0) {
            return { ok: false, pages: 0, segments: 0, error: 'no translatable text (is this a scan? use OCR)' };
        }

        // 3) Write .translations.md (headless; no viewer needed).
        const savedOverlay: SavedOverlay = {
            fileName: pdf.name,
            filePath: pdf.path,
            timestamp: Date.now(),
            pageOverlays,
        };

        await this.plugin.storage.writeSavedOverlayForFile(pdf, savedOverlay);
        return { ok: true, pages: pageCount, segments: segCount };
    }
}
