import { FileSystemAdapter, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';

export interface CapturedPageImage {
    base64: string;
    mimeType: string;
    width: number;
    height: number;
}

export class PageCapture {
    private plugin: OpenRouterTranslatorPlugin;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    getTotalPages(root: ParentNode = document): number | null {
        const viewer = root.querySelector('.pdfViewer, #viewer');
        if (!viewer) return null;
        const pages = viewer.querySelectorAll('.page[data-page-number]');
        return pages.length > 0 ? pages.length : null;
    }

    getAbsolutePdfPath(file?: TFile): string | null {
        const target = file ?? this.plugin.app.workspace.getActiveFile();
        if (!target || target.extension !== 'pdf') return null;

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return null;
        const basePath = adapter.getBasePath();
        return `${basePath}/${target.path}`;
    }

    capturePageElement(pageElement: HTMLElement): CapturedPageImage | null {
        const canvas = pageElement.querySelector('canvas') as HTMLCanvasElement | null;
        if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
        return this.canvasToImage(canvas);
    }

    /**
     * Capture a page for OCR, upscaling to the configured imageScale and using
     * the configured format/quality. The on-screen canvas is whatever the
     * current zoom produced, which is often too low-res for reliable OCR — so
     * we redraw it onto a larger offscreen canvas.
     */
    captureForOcr(pageElement: HTMLElement): CapturedPageImage | null {
        const src = pageElement.querySelector('canvas') as HTMLCanvasElement | null;
        if (!src || src.width === 0 || src.height === 0) return null;

        const ocr = this.plugin.settings.ocrProvider;
        const targetScale = Math.max(1, ocr?.imageScale ?? 2);
        const format = ocr?.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = format === 'image/jpeg' ? Math.min(1, Math.max(0.5, (ocr?.imageQuality ?? 85) / 100)) : undefined;

        // Aim for a reasonable absolute resolution: scale up small canvases more.
        // Cap the long edge so we don't ship absurdly large base64 payloads.
        const MAX_EDGE = 3000;
        let scale = targetScale;
        const longEdge = Math.max(src.width, src.height) * scale;
        if (longEdge > MAX_EDGE) scale = MAX_EDGE / Math.max(src.width, src.height);

        try {
            const out = document.createElement('canvas');
            out.width = Math.round(src.width * scale);
            out.height = Math.round(src.height * scale);
            const ctx = out.getContext('2d');
            if (!ctx) return this.canvasToImage(src);
            if (format === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(src, 0, 0, out.width, out.height);

            const dataUrl = quality !== undefined ? out.toDataURL(format, quality) : out.toDataURL(format);
            const prefix = `data:${format};base64,`;
            if (!dataUrl.startsWith(prefix)) return this.canvasToImage(src);
            return { base64: dataUrl.slice(prefix.length), mimeType: format, width: out.width, height: out.height };
        } catch {
            // Fall back to the raw on-screen canvas if anything goes wrong.
            return this.canvasToImage(src);
        }
    }

    async capturePageByNumber(pageNumber: number, root: ParentNode = document): Promise<CapturedPageImage | null> {
        const pageEl = root.querySelector(
            `.page[data-page-number="${pageNumber}"]`
        ) as HTMLElement | null;
        if (!pageEl) return null;

        pageEl.scrollIntoView({ block: 'nearest' });
        await new Promise(resolve => setTimeout(resolve, 200));
        return this.capturePageElement(pageEl);
    }

    private canvasToImage(canvas: HTMLCanvasElement): CapturedPageImage | null {
        try {
            const mimeType = 'image/png';
            const dataUrl = canvas.toDataURL(mimeType);
            const prefix = `data:${mimeType};base64,`;
            if (!dataUrl.startsWith(prefix)) return null;
            return {
                base64: dataUrl.slice(prefix.length),
                mimeType,
                width: canvas.width,
                height: canvas.height,
            };
        } catch {
            return null;
        }
    }
}
