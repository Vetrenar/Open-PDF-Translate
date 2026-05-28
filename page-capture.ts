import { FileSystemAdapter } from 'obsidian';
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

    getTotalPages(): number | null {
        const viewer = document.querySelector('.pdfViewer, #viewer');
        if (!viewer) return null;
        const pages = viewer.querySelectorAll('.page[data-page-number]');
        return pages.length > 0 ? pages.length : null;
    }

    getAbsolutePdfPath(): string | null {
        const file = this.plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== 'pdf') return null;

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return null;
        const basePath = adapter.getBasePath();
        return `${basePath}/${file.path}`;
    }

    capturePageElement(pageElement: HTMLElement): CapturedPageImage | null {
        const canvas = pageElement.querySelector('canvas') as HTMLCanvasElement | null;
        if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
        return this.canvasToImage(canvas);
    }

    async capturePageByNumber(pageNumber: number): Promise<CapturedPageImage | null> {
        const pageEl = document.querySelector(
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
