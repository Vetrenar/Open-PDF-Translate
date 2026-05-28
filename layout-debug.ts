import { normalizePath, Notice, TFile, TFolder } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { LayoutResult } from './layout-detector';

interface DebugRectAbsolute {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
}

interface DebugRectNormalized {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
}

interface DebugRectRecord {
    absolute: DebugRectAbsolute;
    normalized: DebugRectNormalized;
}

interface DebugSpanRecord {
    id: string;
    text: string;
    rect: DebugRectRecord;
}

interface DebugParagraphRecord {
    id: string;
    textPreview: string;
    spanCount: number;
    rect: DebugRectRecord;
}

interface DebugDetectionRun {
    id: string;
    source: string;
    createdAt: string;
    pageNumber: number;
    pageSizePx: { width: number; height: number };
    viewerScale: number;
    spanCount: number;
    columns: DebugRectRecord[];
    strips: Array<DebugRectRecord & { confidence: number }>;
    regions: DebugRectRecord[];
    paragraphs: DebugParagraphRecord[];
    spans: DebugSpanRecord[];
}

interface DebugManualBox {
    id: string;
    createdAt: string;
    source: 'manual-shift-drag';
    pageNumber: number;
    note: string;
    rect: DebugRectRecord;
}

interface DebugPageRecord {
    pageNumber: number;
    updatedAt: string;
    pageSizePx: { width: number; height: number };
    detectionRuns: DebugDetectionRun[];
    manualBoxes: DebugManualBox[];
}

interface LayoutDebugDocument {
    version: 1;
    pdfPath: string;
    updatedAt: string;
    pages: Record<string, DebugPageRecord>;
}

const STYLE_ID = 'pdf-layout-debug-mode-styles';
const LAYER_CLASS = 'pdf-layout-debug-box-layer';
const BOX_CLASS = 'pdf-layout-debug-box';
const GHOST_CLASS = 'pdf-layout-debug-ghost-box';
const MIN_DRAW_PX = 4;
const MAX_RUNS_PER_PAGE = 30;

export class LayoutDebugService {
    private readonly plugin: OpenRouterTranslatorPlugin;
    private writingLocks = new Map<string, Promise<void>>();
    private listenersBound = false;
    private drawStart: { x: number; y: number } | null = null;
    private drawPage: HTMLElement | null = null;
    private ghostBox: HTMLDivElement | null = null;

    private readonly onMouseDown = (event: MouseEvent) => {
        if (!this.plugin.settings.layoutDebugMode || !this.plugin.settings.layoutDebugDrawMode) return;
        if (!event.shiftKey || event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;

        const pageElement = target.closest('.page[data-page-number]') as HTMLElement | null;
        if (!pageElement) return;

        event.preventDefault();
        event.stopPropagation();

        this.drawStart = { x: event.clientX, y: event.clientY };
        this.drawPage = pageElement;
        this.removeGhostBox();

        const ghost = document.createElement('div');
        ghost.className = GHOST_CLASS;
        ghost.style.left = `${event.clientX}px`;
        ghost.style.top = `${event.clientY}px`;
        ghost.style.width = '0px';
        ghost.style.height = '0px';
        document.body.appendChild(ghost);
        this.ghostBox = ghost;
    };

    private readonly onMouseMove = (event: MouseEvent) => {
        if (!this.drawStart || !this.drawPage || !this.ghostBox) return;

        const left = Math.min(this.drawStart.x, event.clientX);
        const top = Math.min(this.drawStart.y, event.clientY);
        const width = Math.abs(event.clientX - this.drawStart.x);
        const height = Math.abs(event.clientY - this.drawStart.y);

        this.ghostBox.style.left = `${left}px`;
        this.ghostBox.style.top = `${top}px`;
        this.ghostBox.style.width = `${width}px`;
        this.ghostBox.style.height = `${height}px`;
    };

    private readonly onMouseUp = (event: MouseEvent) => {
        if (!this.drawStart || !this.drawPage) return;
        const pageElement = this.drawPage;
        const start = this.drawStart;

        this.drawStart = null;
        this.drawPage = null;

        const pageRect = pageElement.getBoundingClientRect();
        const left = Math.max(pageRect.left, Math.min(start.x, event.clientX));
        const top = Math.max(pageRect.top, Math.min(start.y, event.clientY));
        const right = Math.min(pageRect.right, Math.max(start.x, event.clientX));
        const bottom = Math.min(pageRect.bottom, Math.max(start.y, event.clientY));

        this.removeGhostBox();

        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        if (width < MIN_DRAW_PX || height < MIN_DRAW_PX) return;

        const localRect = {
            left: left - pageRect.left,
            top: top - pageRect.top,
            width,
            height
        };
        const rect = this.toDebugRectFromLocal(localRect, pageRect);
        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) return;
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') return;

        const manualBox: DebugManualBox = {
            id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            createdAt: new Date().toISOString(),
            source: 'manual-shift-drag',
            pageNumber,
            note: 'Manual debug box',
            rect
        };

        this.renderManualBox(pageElement, manualBox);
        void this.appendManualBox(activeFile, manualBox, {
            width: pageRect.width,
            height: pageRect.height
        });
    };

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            this.drawStart = null;
            this.drawPage = null;
            this.removeGhostBox();
        }
    };

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureStyles();
        void this.onSettingsChanged(false);
    }

    public async onSettingsChanged(captureCurrentPage: boolean): Promise<void> {
        this.ensureStyles();

        if (!this.plugin.settings.layoutDebugMode) {
            this.unbindListeners();
            this.clearRenderedLayers();
            this.removeGhostBox();
            return;
        }

        if (this.plugin.settings.layoutDebugDrawMode) {
            this.bindListeners();
        } else {
            this.unbindListeners();
            this.removeGhostBox();
        }

        await this.refreshForCurrentPage();

        if (captureCurrentPage) {
            await this.captureCurrentPageLayoutDetection('layout-debug-mode-enabled');
        }
    }

    public async refreshForCurrentPage(): Promise<void> {
        this.clearRenderedLayers();

        if (!this.plugin.settings.layoutDebugMode) return;
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') return;

        const pageElement = this.plugin.getCurrentPageElement();
        if (!pageElement) return;

        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) return;

        const doc = await this.readDebugDocument(activeFile);
        const pageRecord = doc?.pages?.[String(pageNumber)];
        if (!pageRecord?.manualBoxes?.length) return;

        for (const box of pageRecord.manualBoxes) {
            this.renderManualBox(pageElement, box);
        }
    }

    public recordDetectedLayout(
        pageElement: HTMLElement,
        spans: HTMLSpanElement[],
        result: LayoutResult,
        source: string = 'internal-layout-pipeline'
    ): void {
        if (!this.plugin.settings.layoutDebugMode) return;
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') return;
        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) return;

        const run = this.buildDetectionRun(pageElement, spans, result, source, pageNumber);
        void this.appendDetectionRun(activeFile, pageNumber, run);
    }

    public async captureCurrentPageLayoutDetection(source: string = 'layout-debug-command'): Promise<boolean> {
        if (!this.plugin.settings.layoutDebugMode) {
            new Notice('Enable Layout Debug Mode first.');
            return false;
        }

        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') {
            new Notice('Open a PDF file first.');
            return false;
        }

        const pageElement = this.plugin.getCurrentPageElement();
        if (!pageElement) {
            new Notice('No visible PDF page found.');
            return false;
        }

        const textLayer = pageElement.querySelector('.textLayer') as HTMLElement | null;
        if (!textLayer) {
            new Notice('Text layer not ready for debug capture.');
            return false;
        }

        const spans = Array.from(textLayer.querySelectorAll<HTMLSpanElement>('span'))
            .filter(span => this.plugin.processor.isValidSpan(span));

        if (!spans.length) {
            new Notice('No valid text spans found on this page.');
            return false;
        }

        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) return false;

        const result = this.plugin.processor.layoutDetector.detectLayout(spans, pageElement);
        const run = this.buildDetectionRun(pageElement, spans, result, source, pageNumber);
        await this.appendDetectionRun(activeFile, pageNumber, run);
        await this.refreshForCurrentPage();

        const path = this.getDebugFilePath(activeFile);
        new Notice(`Layout debug saved to ${path}`);
        return true;
    }

    public cleanup(): void {
        this.unbindListeners();
        this.clearRenderedLayers();
        this.removeGhostBox();
    }

    private bindListeners(): void {
        if (this.listenersBound) return;
        document.addEventListener('mousedown', this.onMouseDown, true);
        document.addEventListener('mousemove', this.onMouseMove, true);
        document.addEventListener('mouseup', this.onMouseUp, true);
        document.addEventListener('keydown', this.onKeyDown, true);
        this.listenersBound = true;
    }

    private unbindListeners(): void {
        if (!this.listenersBound) return;
        document.removeEventListener('mousedown', this.onMouseDown, true);
        document.removeEventListener('mousemove', this.onMouseMove, true);
        document.removeEventListener('mouseup', this.onMouseUp, true);
        document.removeEventListener('keydown', this.onKeyDown, true);
        this.listenersBound = false;
    }

    private removeGhostBox(): void {
        this.ghostBox?.remove();
        this.ghostBox = null;
    }

    private clearRenderedLayers(): void {
        document.querySelectorAll(`.${LAYER_CLASS}`).forEach(el => el.remove());
    }

    private ensureStyles(): void {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${LAYER_CLASS} {
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 190;
            }
            .${BOX_CLASS} {
                position: absolute;
                box-sizing: border-box;
                border: 2px solid rgba(255, 183, 0, 0.96);
                background: rgba(255, 183, 0, 0.18);
                pointer-events: none;
            }
            .${BOX_CLASS} .layout-debug-box-label {
                position: absolute;
                left: 0;
                top: 0;
                transform: translateY(-100%);
                background: rgba(10, 14, 24, 0.88);
                color: #fff;
                font-size: 10px;
                font-family: Menlo, Consolas, monospace;
                padding: 1px 4px;
                white-space: nowrap;
                border-radius: 2px;
            }
            .${GHOST_CLASS} {
                position: fixed;
                border: 2px dashed rgba(255, 183, 0, 0.95);
                background: rgba(255, 183, 0, 0.12);
                pointer-events: none;
                z-index: 100000;
                box-sizing: border-box;
            }
        `;
        document.head.appendChild(style);
    }

    private getDebugFilePath(pdfFile: TFile): string {
        const storageDir = this.plugin.settings.storageLocation || '';
        const fileName = `${pdfFile.basename}.layout-debug.json`;
        if (storageDir) return normalizePath(`${storageDir}${fileName}`);

        const pdfDir = pdfFile.parent?.path || '';
        if (!pdfDir) return normalizePath(fileName);
        return normalizePath(`${pdfDir}/${fileName}`);
    }

    private async readDebugDocument(pdfFile: TFile): Promise<LayoutDebugDocument | null> {
        const path = this.getDebugFilePath(pdfFile);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) return null;
        try {
            const raw = await this.plugin.app.vault.read(existing);
            const parsed = JSON.parse(raw) as LayoutDebugDocument;
            if (parsed && parsed.version === 1 && parsed.pages) return parsed;
        } catch (err) {
            this.plugin.logDebug('[LayoutDebug] Failed to read debug file', err);
        }
        return null;
    }

    private async appendDetectionRun(pdfFile: TFile, pageNumber: number, run: DebugDetectionRun): Promise<void> {
        await this.writeDocument(pdfFile, (doc) => {
            const page = this.ensurePageRecord(doc, pageNumber, run.pageSizePx);
            page.updatedAt = new Date().toISOString();
            page.pageSizePx = run.pageSizePx;
            page.detectionRuns.push(run);
            if (page.detectionRuns.length > MAX_RUNS_PER_PAGE) {
                page.detectionRuns.splice(0, page.detectionRuns.length - MAX_RUNS_PER_PAGE);
            }
        });
    }

    private async appendManualBox(
        pdfFile: TFile,
        box: DebugManualBox,
        pageSize: { width: number; height: number }
    ): Promise<void> {
        await this.writeDocument(pdfFile, (doc) => {
            const page = this.ensurePageRecord(doc, box.pageNumber, pageSize);
            page.updatedAt = new Date().toISOString();
            page.manualBoxes.push(box);
        });
    }

    private async writeDocument(
        pdfFile: TFile,
        mutator: (doc: LayoutDebugDocument) => void
    ): Promise<void> {
        const path = this.getDebugFilePath(pdfFile);
        const run = async () => {
            let existingDoc = await this.readDebugDocument(pdfFile);
            if (!existingDoc) {
                existingDoc = {
                    version: 1,
                    pdfPath: pdfFile.path,
                    updatedAt: new Date().toISOString(),
                    pages: {}
                };
            }

            mutator(existingDoc);
            existingDoc.updatedAt = new Date().toISOString();
            await this.writeDebugDocument(path, existingDoc);
        };

        const previous = this.writingLocks.get(path) || Promise.resolve();
        const current = previous.then(run, run).finally(() => {
            if (this.writingLocks.get(path) === current) {
                this.writingLocks.delete(path);
            }
        });
        this.writingLocks.set(path, current);
        await current;
    }

    private async writeDebugDocument(path: string, doc: LayoutDebugDocument): Promise<void> {
        const payload = JSON.stringify(doc, null, 2);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, payload);
            return;
        }

        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (dir) await this.ensureFolder(dir);
        await this.plugin.app.vault.create(path, payload);
    }

    private async ensureFolder(path: string): Promise<void> {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += current ? `/${part}` : part;
            const existing = this.plugin.app.vault.getAbstractFileByPath(current);
            if (existing instanceof TFolder) continue;
            if (!existing) {
                try {
                    await this.plugin.app.vault.createFolder(current);
                } catch {}
            }
        }
    }

    private ensurePageRecord(
        doc: LayoutDebugDocument,
        pageNumber: number,
        size: { width: number; height: number }
    ): DebugPageRecord {
        const key = String(pageNumber);
        if (!doc.pages[key]) {
            doc.pages[key] = {
                pageNumber,
                updatedAt: new Date().toISOString(),
                pageSizePx: { width: this.round(size.width, 3), height: this.round(size.height, 3) },
                detectionRuns: [],
                manualBoxes: []
            };
        }
        return doc.pages[key];
    }

    private buildDetectionRun(
        pageElement: HTMLElement,
        spans: HTMLSpanElement[],
        result: LayoutResult,
        source: string,
        pageNumber: number
    ): DebugDetectionRun {
        const pageRect = pageElement.getBoundingClientRect();
        const viewerScale = this.readViewerScale(pageElement);

        const columns = (result.columnAnalysis?.columns || [])
            .map(col => this.toDebugRectFromLocal({
                left: col.left - pageRect.left,
                top: col.top - pageRect.top,
                width: col.width,
                height: col.height
            }, pageRect))
            .filter(Boolean);

        const strips = (result.debugStrips || []).map(strip => {
            const rect = this.toDebugRectFromLocal({
                left: strip.left - pageRect.left,
                top: strip.top - pageRect.top,
                width: Math.max(0, strip.right - strip.left),
                height: Math.max(0, strip.bottom - strip.top)
            }, pageRect);
            return { ...rect, confidence: this.round(strip.confidence ?? 0, 4) };
        });

        const regions = (result.layoutRegions || []).map(region => this.toDebugRectFromLocal({
            left: region.left - pageRect.left,
            top: region.top - pageRect.top,
            width: Math.max(0, region.right - region.left),
            height: Math.max(0, region.bottom - region.top)
        }, pageRect));

        const paragraphRecords: DebugParagraphRecord[] = [];
        for (let i = 0; i < result.paragraphs.length; i++) {
            const paragraph = result.paragraphs[i];
            if (!paragraph.length) continue;
            const paragraphRect = this.unionSpanRects(paragraph, pageRect);
            if (!paragraphRect) continue;
            const preview = paragraph
                .map(s => (s.textContent || '').trim())
                .filter(Boolean)
                .join(' ')
                .slice(0, 160);

            paragraphRecords.push({
                id: `paragraph-${i + 1}`,
                textPreview: preview,
                spanCount: paragraph.length,
                rect: paragraphRect
            });
        }

        const spanRecords = spans.map((span, idx) => {
            const rect = span.getBoundingClientRect();
            const local = this.toDebugRectFromLocal({
                left: rect.left - pageRect.left,
                top: rect.top - pageRect.top,
                width: rect.width,
                height: rect.height
            }, pageRect);

            return {
                id: `span-${idx + 1}`,
                text: (span.textContent || '').trim().slice(0, 180),
                rect: local
            };
        });

        return {
            id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            source,
            createdAt: new Date().toISOString(),
            pageNumber,
            pageSizePx: {
                width: this.round(pageRect.width, 3),
                height: this.round(pageRect.height, 3)
            },
            viewerScale,
            spanCount: spans.length,
            columns,
            strips,
            regions,
            paragraphs: paragraphRecords,
            spans: spanRecords
        };
    }

    private renderManualBox(pageElement: HTMLElement, box: DebugManualBox): void {
        const layer = this.ensureLayer(pageElement);
        const el = document.createElement('div');
        el.className = BOX_CLASS;
        el.style.left = `${(box.rect.normalized.left * 100).toFixed(4)}%`;
        el.style.top = `${(box.rect.normalized.top * 100).toFixed(4)}%`;
        el.style.width = `${(box.rect.normalized.width * 100).toFixed(4)}%`;
        el.style.height = `${(box.rect.normalized.height * 100).toFixed(4)}%`;
        el.setAttribute('data-debug-box-id', box.id);

        const label = document.createElement('div');
        label.className = 'layout-debug-box-label';
        label.textContent =
            `${box.id} ` +
            `x=${box.rect.absolute.left.toFixed(1)} y=${box.rect.absolute.top.toFixed(1)} ` +
            `w=${box.rect.absolute.width.toFixed(1)} h=${box.rect.absolute.height.toFixed(1)}`;
        el.appendChild(label);

        layer.appendChild(el);
    }

    private ensureLayer(pageElement: HTMLElement): HTMLElement {
        let layer = pageElement.querySelector(`.${LAYER_CLASS}`) as HTMLElement | null;
        if (!layer) {
            layer = document.createElement('div');
            layer.className = LAYER_CLASS;
            pageElement.appendChild(layer);
        }
        return layer;
    }

    private getPageNumber(pageElement: HTMLElement): number | null {
        const raw = pageElement.getAttribute('data-page-number');
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    private readViewerScale(pageElement: HTMLElement): number {
        const pdfViewer = pageElement.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const scale = parseFloat(pdfViewer?.style.getPropertyValue('--scale-factor') || '1');
        if (!Number.isFinite(scale) || scale <= 0) return 1;
        return this.round(scale, 4);
    }

    private unionSpanRects(spans: HTMLSpanElement[], pageRect: DOMRect): DebugRectRecord | null {
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;

        for (const span of spans) {
            const r = span.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            left = Math.min(left, r.left);
            top = Math.min(top, r.top);
            right = Math.max(right, r.right);
            bottom = Math.max(bottom, r.bottom);
        }

        if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) {
            return null;
        }

        return this.toDebugRectFromLocal({
            left: left - pageRect.left,
            top: top - pageRect.top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top)
        }, pageRect);
    }

    private toDebugRectFromLocal(
        rect: { left: number; top: number; width: number; height: number },
        pageRect: DOMRect
    ): DebugRectRecord {
        const left = this.round(rect.left, 3);
        const top = this.round(rect.top, 3);
        const width = this.round(rect.width, 3);
        const height = this.round(rect.height, 3);
        const right = this.round(left + width, 3);
        const bottom = this.round(top + height, 3);

        const pageW = Math.max(1e-6, pageRect.width);
        const pageH = Math.max(1e-6, pageRect.height);
        const nLeft = this.clamp01(left / pageW);
        const nTop = this.clamp01(top / pageH);
        const nWidth = this.clamp01(width / pageW);
        const nHeight = this.clamp01(height / pageH);

        return {
            absolute: { left, top, width, height, right, bottom },
            normalized: {
                left: this.round(nLeft, 6),
                top: this.round(nTop, 6),
                width: this.round(nWidth, 6),
                height: this.round(nHeight, 6),
                right: this.round(this.clamp01(nLeft + nWidth), 6),
                bottom: this.round(this.clamp01(nTop + nHeight), 6)
            }
        };
    }

    private clamp01(v: number): number {
        return Math.max(0, Math.min(1, v));
    }

    private round(v: number, digits: number): number {
        const p = 10 ** digits;
        return Math.round(v * p) / p;
    }
}
