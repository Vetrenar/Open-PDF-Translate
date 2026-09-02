import { Menu, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { LayoutResult } from './layout-detector';
import { uuid } from './overlay-id';

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

interface VerticalGapLineRecord {
    absoluteX: number;
    normalizedX: number;
}

interface DetectionSnapshot {
    id: string;
    createdAt: string;
    source: string;
    pageNumber: number;
    pageSizePx: { width: number; height: number };
    spanCount: number;
    paragraphBoxes: DebugRectRecord[];
    columns: DebugRectRecord[];
    gapStrips: Array<DebugRectRecord & { confidence: number }>;
    verticalGapLines: VerticalGapLineRecord[];
}

interface ManualBoxRecord {
    id: string;
    createdAt: string;
    source: 'manual-context-draw';
    pageNumber: number;
    rect: DebugRectRecord;
}

interface DebugPageRecord {
    pageNumber: number;
    updatedAt: string;
    detections: DetectionSnapshot[];
    manualBoxes: ManualBoxRecord[];
}

interface LayoutParserDebugDocument {
    version: 1;
    pdfPath: string;
    updatedAt: string;
    pages: Record<string, DebugPageRecord>;
}

const STYLE_ID = 'pdf-layout-parser-debug-styles';
const LAYER_CLASS = 'pdf-layout-parser-debug-layer';
const BOX_PARAGRAPH_CLASS = 'pdf-layout-parser-debug-paragraph';
const BOX_COLUMN_CLASS = 'pdf-layout-parser-debug-column';
const BOX_GAP_CLASS = 'pdf-layout-parser-debug-gap';
const BOX_MANUAL_CLASS = 'pdf-layout-parser-debug-manual';
const LINE_VERTICAL_GAP_CLASS = 'pdf-layout-parser-debug-vgap-line';
const LEGEND_CLASS = 'pdf-layout-parser-debug-legend';
const GHOST_CLASS = 'pdf-layout-parser-debug-ghost';
const MAX_DETECTIONS_PER_PAGE = 30;
const MIN_DRAW_SIZE_PX = 5;

export class LayoutParserDebugModule {
    private readonly plugin: OpenRouterTranslatorPlugin;
    private enabled = false;
    private listenersBound = false;
    private drawArmed = false;
    private drawStart: { x: number; y: number } | null = null;
    private drawPage: HTMLElement | null = null;
    private ghostBox: HTMLDivElement | null = null;
    private writeLocks = new Map<string, Promise<void>>();

    private readonly onContextMenu = (event: MouseEvent) => {
        if (!this.enabled) return;
        const target = event.target as HTMLElement | null;
        if (!target) return;
        const pageElement = target.closest('.page[data-page-number]') as HTMLElement | null;
        if (!pageElement) return;

        event.preventDefault();
        event.stopPropagation();

        const pageNumber = this.getPageNumber(pageElement);
        const menu = new Menu();

        menu.addItem(item =>
            item
                .setTitle('Refresh parser debug overlay')
                .setIcon('refresh-cw')
                .onClick(() => {
                    void this.refreshCurrentPage('context-refresh');
                })
        );

        if (this.drawArmed) {
            menu.addItem(item =>
                item
                    .setTitle('Cancel manual bbox draw')
                    .setIcon('x-circle')
                    .onClick(() => {
                        this.drawArmed = false;
                        this.cancelDrawing();
                        new Notice('Manual bbox draw canceled.');
                    })
            );
        } else {
            menu.addItem(item =>
                item
                    .setTitle('Draw manual bbox (next drag)')
                    .setIcon('pencil')
                    .onClick(() => {
                        this.drawArmed = true;
                        new Notice('Manual bbox draw armed. Drag left mouse on the page.');
                    })
            );
        }

        menu.addItem(item =>
            item
                .setTitle('Clear manual bboxes on this page')
                .setIcon('trash')
                .onClick(() => {
                    if (!pageNumber) return;
                    void this.clearManualBoxes(pageNumber);
                })
        );

        menu.showAtPosition({ x: event.clientX, y: event.clientY });
    };

    private readonly onMouseDown = (event: MouseEvent) => {
        if (!this.enabled || !this.drawArmed) return;
        if (event.button !== 0) return;
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
        if (width < MIN_DRAW_SIZE_PX || height < MIN_DRAW_SIZE_PX) {
            return;
        }

        const activeFile = this.getActivePdfFile();
        if (!activeFile) return;

        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) return;

        const rect = this.toDebugRectFromLocal(
            {
                left: left - pageRect.left,
                top: top - pageRect.top,
                width,
                height
            },
            pageRect
        );

        const manual: ManualBoxRecord = {
            id: `manual-${uuid()}`,
            createdAt: new Date().toISOString(),
            source: 'manual-context-draw',
            pageNumber,
            rect
        };

        void this.appendManualBox(activeFile, pageNumber, manual).then(async () => {
            await this.refreshCurrentPage('manual-draw');
            new Notice('Manual bbox saved to parser debug file.');
        });

        this.drawArmed = false;
    };

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        this.drawArmed = false;
        this.cancelDrawing();
    };

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.ensureStyles();
        this.enabled = !!this.plugin.settings.layoutDebugMode;
        if (this.enabled) {
            this.bindListeners();
            setTimeout(() => {
                void this.refreshCurrentPage('startup');
            }, 300);
        }
    }

    public async toggleMode(): Promise<void> {
        this.enabled = !this.enabled;
        this.plugin.settings.layoutDebugMode = this.enabled;
        await this.plugin.saveSettings();

        if (this.enabled) {
            this.bindListeners();
            await this.refreshCurrentPage('toggle-on');
            new Notice('Layout parser debug mode enabled. Right-click page for debug actions.');
            return;
        }

        this.drawArmed = false;
        this.cancelDrawing();
        this.unbindListeners();
        this.clearVisualLayers();
        new Notice('Layout parser debug mode disabled.');
    }

    public async onActiveLeafChange(leaf: any): Promise<void> {
        if (!this.enabled) {
            this.clearVisualLayers();
            return;
        }
        if (!leaf || leaf.view?.getViewType?.() !== 'pdf') {
            this.clearVisualLayers();
            return;
        }
        setTimeout(() => {
            void this.refreshCurrentPage('leaf-change');
        }, 280);
    }

    public async refreshCurrentPage(source: string): Promise<void> {
        if (!this.enabled) return;

        const activeFile = this.getActivePdfFile();
        if (!activeFile) {
            this.clearVisualLayers();
            return;
        }

        const pageElement = this.plugin.getCurrentPageElement();
        if (!pageElement) {
            this.clearVisualLayers();
            return;
        }

        const pageNumber = this.getPageNumber(pageElement);
        if (!pageNumber) {
            this.clearVisualLayers();
            return;
        }

        const textLayer = pageElement.querySelector('.textLayer') as HTMLElement | null;
        if (!textLayer) {
            this.clearVisualLayers();
            return;
        }

        const spans = Array.from(textLayer.querySelectorAll<HTMLSpanElement>('span'))
            .filter(span => this.plugin.processor.isValidSpan(span));
        if (!spans.length) {
            this.clearVisualLayers();
            return;
        }

        const result = this.plugin.processor.layoutDetector.detectLayout(spans, pageElement);
        this.renderVisualization(pageElement, result);

        const snapshot = this.buildDetectionSnapshot(pageElement, spans, result, pageNumber, source);
        await this.appendDetection(activeFile, pageNumber, snapshot);

        const pageData = await this.readPageDebugData(activeFile, pageNumber);
        if (pageData?.manualBoxes?.length) {
            this.renderManualBoxes(pageElement, pageData.manualBoxes);
        }
    }

    public cleanup(): void {
        this.enabled = false;
        this.drawArmed = false;
        this.cancelDrawing();
        this.unbindListeners();
        this.clearVisualLayers();
    }

    private bindListeners(): void {
        if (this.listenersBound) return;
        document.addEventListener('contextmenu', this.onContextMenu, true);
        document.addEventListener('mousedown', this.onMouseDown, true);
        document.addEventListener('mousemove', this.onMouseMove, true);
        document.addEventListener('mouseup', this.onMouseUp, true);
        document.addEventListener('keydown', this.onKeyDown, true);
        this.listenersBound = true;
    }

    private unbindListeners(): void {
        if (!this.listenersBound) return;
        document.removeEventListener('contextmenu', this.onContextMenu, true);
        document.removeEventListener('mousedown', this.onMouseDown, true);
        document.removeEventListener('mousemove', this.onMouseMove, true);
        document.removeEventListener('mouseup', this.onMouseUp, true);
        document.removeEventListener('keydown', this.onKeyDown, true);
        this.listenersBound = false;
    }

    private cancelDrawing(): void {
        this.drawStart = null;
        this.drawPage = null;
        this.removeGhostBox();
    }

    private removeGhostBox(): void {
        this.ghostBox?.remove();
        this.ghostBox = null;
    }

    private getActivePdfFile(): TFile | null {
        const file = this.plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== 'pdf') return null;
        return file;
    }

    private getPageNumber(pageElement: HTMLElement): number | null {
        const raw = pageElement.getAttribute('data-page-number');
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    private renderVisualization(pageElement: HTMLElement, result: LayoutResult): void {
        this.clearVisualLayers();
        const layer = this.ensureLayer(pageElement);
        const pageRect = pageElement.getBoundingClientRect();

        const addRect = (rect: DebugRectRecord, cls: string): void => {
            const el = document.createElement('div');
            el.className = cls;
            el.style.left = `${(rect.normalized.left * 100).toFixed(4)}%`;
            el.style.top = `${(rect.normalized.top * 100).toFixed(4)}%`;
            el.style.width = `${(rect.normalized.width * 100).toFixed(4)}%`;
            el.style.height = `${(rect.normalized.height * 100).toFixed(4)}%`;
            layer.appendChild(el);
        };

        for (const para of result.paragraphs || []) {
            const rect = this.unionParagraphRect(para, pageRect);
            if (!rect) continue;
            addRect(rect, BOX_PARAGRAPH_CLASS);
        }

        for (const col of result.columnAnalysis?.columns || []) {
            const rect = this.toDebugRectFromLocal(
                {
                    left: col.left - pageRect.left,
                    top: col.top - pageRect.top,
                    width: col.width,
                    height: col.height
                },
                pageRect
            );
            addRect(rect, BOX_COLUMN_CLASS);
        }

        for (const strip of result.debugStrips || []) {
            const rect = this.toDebugRectFromLocal(
                {
                    left: strip.left - pageRect.left,
                    top: strip.top - pageRect.top,
                    width: Math.max(0, strip.right - strip.left),
                    height: Math.max(0, strip.bottom - strip.top)
                },
                pageRect
            );
            addRect(rect, BOX_GAP_CLASS);
        }

        for (const gx of result.columnAnalysis?.verticalGaps || []) {
            const normX = this.clamp01((gx - pageRect.left) / Math.max(1e-6, pageRect.width));
            const line = document.createElement('div');
            line.className = LINE_VERTICAL_GAP_CLASS;
            line.style.left = `${(normX * 100).toFixed(4)}%`;
            layer.appendChild(line);
        }

        const legend = document.createElement('div');
        legend.className = LEGEND_CLASS;
        legend.innerHTML = [
            '<span class="i p"></span> parser bboxes',
            '<span class="i c"></span> columns',
            '<span class="i g"></span> gap strips',
            '<span class="i v"></span> vertical gaps',
            '<span class="i m"></span> manual bboxes'
        ].join('<br>');
        layer.appendChild(legend);
    }

    private renderManualBoxes(pageElement: HTMLElement, boxes: ManualBoxRecord[]): void {
        const layer = this.ensureLayer(pageElement);
        for (const box of boxes) {
            const el = document.createElement('div');
            el.className = BOX_MANUAL_CLASS;
            el.style.left = `${(box.rect.normalized.left * 100).toFixed(4)}%`;
            el.style.top = `${(box.rect.normalized.top * 100).toFixed(4)}%`;
            el.style.width = `${(box.rect.normalized.width * 100).toFixed(4)}%`;
            el.style.height = `${(box.rect.normalized.height * 100).toFixed(4)}%`;
            el.title =
                `${box.id}: ` +
                `x=${box.rect.absolute.left.toFixed(1)} ` +
                `y=${box.rect.absolute.top.toFixed(1)} ` +
                `w=${box.rect.absolute.width.toFixed(1)} ` +
                `h=${box.rect.absolute.height.toFixed(1)}`;
            layer.appendChild(el);
        }
    }

    private clearVisualLayers(): void {
        document.querySelectorAll(`.${LAYER_CLASS}`).forEach(el => el.remove());
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
                z-index: 220;
            }
            .${BOX_PARAGRAPH_CLASS} {
                position: absolute;
                box-sizing: border-box;
                border: 1px solid rgba(37, 190, 122, 0.98);
                background: rgba(37, 190, 122, 0.10);
            }
            .${BOX_COLUMN_CLASS} {
                position: absolute;
                box-sizing: border-box;
                border: 1px solid rgba(53, 130, 246, 0.96);
                background: rgba(53, 130, 246, 0.07);
            }
            .${BOX_GAP_CLASS} {
                position: absolute;
                box-sizing: border-box;
                border: 1px dashed rgba(255, 78, 78, 0.98);
                background: rgba(255, 78, 78, 0.12);
            }
            .${LINE_VERTICAL_GAP_CLASS} {
                position: absolute;
                top: 0;
                width: 0;
                height: 100%;
                border-left: 2px solid rgba(255, 177, 31, 0.96);
            }
            .${BOX_MANUAL_CLASS} {
                position: absolute;
                box-sizing: border-box;
                border: 2px solid rgba(255, 221, 87, 0.98);
                background: rgba(255, 221, 87, 0.15);
            }
            .${LEGEND_CLASS} {
                position: absolute;
                left: 8px;
                top: 8px;
                padding: 6px 8px;
                background: rgba(0, 0, 0, 0.74);
                color: #ffffff;
                font-size: 11px;
                line-height: 1.35;
                border-radius: 4px;
                font-family: Menlo, Consolas, monospace;
            }
            .${LEGEND_CLASS} .i {
                display: inline-block;
                width: 10px;
                height: 10px;
                margin-right: 6px;
                vertical-align: -1px;
            }
            .${LEGEND_CLASS} .i.p { background: rgba(37, 190, 122, 0.9); }
            .${LEGEND_CLASS} .i.c { background: rgba(53, 130, 246, 0.9); }
            .${LEGEND_CLASS} .i.g { background: rgba(255, 78, 78, 0.9); }
            .${LEGEND_CLASS} .i.v { background: rgba(255, 177, 31, 0.9); }
            .${LEGEND_CLASS} .i.m { background: rgba(255, 221, 87, 0.9); }
            .${GHOST_CLASS} {
                position: fixed;
                box-sizing: border-box;
                pointer-events: none;
                z-index: 100000;
                border: 2px dashed rgba(255, 221, 87, 0.98);
                background: rgba(255, 221, 87, 0.14);
            }
        `;
        document.head.appendChild(style);
    }

    private buildDetectionSnapshot(
        pageElement: HTMLElement,
        spans: HTMLSpanElement[],
        result: LayoutResult,
        pageNumber: number,
        source: string
    ): DetectionSnapshot {
        const pageRect = pageElement.getBoundingClientRect();

        const paragraphBoxes: DebugRectRecord[] = [];
        for (const para of result.paragraphs || []) {
            const rect = this.unionParagraphRect(para, pageRect);
            if (rect) paragraphBoxes.push(rect);
        }

        const columns = (result.columnAnalysis?.columns || []).map(col =>
            this.toDebugRectFromLocal(
                {
                    left: col.left - pageRect.left,
                    top: col.top - pageRect.top,
                    width: col.width,
                    height: col.height
                },
                pageRect
            )
        );

        const gapStrips = (result.debugStrips || []).map(strip => {
            const rect = this.toDebugRectFromLocal(
                {
                    left: strip.left - pageRect.left,
                    top: strip.top - pageRect.top,
                    width: Math.max(0, strip.right - strip.left),
                    height: Math.max(0, strip.bottom - strip.top)
                },
                pageRect
            );
            return { ...rect, confidence: this.round(strip.confidence ?? 0, 4) };
        });

        const verticalGapLines = (result.columnAnalysis?.verticalGaps || []).map(gx => {
            const absoluteX = this.round(gx - pageRect.left, 3);
            const normalizedX = this.round(
                this.clamp01(absoluteX / Math.max(1e-6, pageRect.width)),
                6
            );
            return { absoluteX, normalizedX };
        });

        return {
            id: `det-${uuid()}`,
            createdAt: new Date().toISOString(),
            source,
            pageNumber,
            pageSizePx: {
                width: this.round(pageRect.width, 3),
                height: this.round(pageRect.height, 3)
            },
            spanCount: spans.length,
            paragraphBoxes,
            columns,
            gapStrips,
            verticalGapLines
        };
    }

    private unionParagraphRect(paragraph: HTMLSpanElement[], pageRect: DOMRect): DebugRectRecord | null {
        if (!paragraph.length) return null;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;

        for (const span of paragraph) {
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

        return this.toDebugRectFromLocal(
            {
                left: left - pageRect.left,
                top: top - pageRect.top,
                width: Math.max(0, right - left),
                height: Math.max(0, bottom - top)
            },
            pageRect
        );
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

    private getDebugFilePath(pdfFile: TFile): string {
        const baseDir = this.plugin.settings.storageLocation || pdfFile.parent?.path || '';
        const cleanDir = baseDir ? baseDir.replace(/\/+$/, '') : '';
        const fileName = `${pdfFile.basename}.layout-parser-debug.json`;
        return cleanDir ? normalizePath(`${cleanDir}/${fileName}`) : normalizePath(fileName);
    }

    private async appendDetection(
        pdfFile: TFile,
        pageNumber: number,
        snapshot: DetectionSnapshot
    ): Promise<void> {
        await this.writeDoc(pdfFile, (doc) => {
            const page = this.ensurePage(doc, pageNumber);
            page.updatedAt = new Date().toISOString();
            page.detections.push(snapshot);
            if (page.detections.length > MAX_DETECTIONS_PER_PAGE) {
                page.detections.splice(0, page.detections.length - MAX_DETECTIONS_PER_PAGE);
            }
        });
    }

    private async appendManualBox(
        pdfFile: TFile,
        pageNumber: number,
        box: ManualBoxRecord
    ): Promise<void> {
        await this.writeDoc(pdfFile, (doc) => {
            const page = this.ensurePage(doc, pageNumber);
            page.updatedAt = new Date().toISOString();
            page.manualBoxes.push(box);
        });
    }

    private async clearManualBoxes(pageNumber: number): Promise<void> {
        const pdfFile = this.getActivePdfFile();
        if (!pdfFile) return;

        await this.writeDoc(pdfFile, (doc) => {
            const page = this.ensurePage(doc, pageNumber);
            page.updatedAt = new Date().toISOString();
            page.manualBoxes = [];
        });
        await this.refreshCurrentPage('clear-manual');
        new Notice(`Manual bboxes cleared for page ${pageNumber}.`);
    }

    private async readPageDebugData(pdfFile: TFile, pageNumber: number): Promise<DebugPageRecord | null> {
        const doc = await this.readDoc(pdfFile);
        if (!doc) return null;
        return doc.pages[String(pageNumber)] || null;
    }

    private async readDoc(pdfFile: TFile): Promise<LayoutParserDebugDocument | null> {
        const path = this.getDebugFilePath(pdfFile);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(existing instanceof TFile)) return null;
        try {
            const raw = await this.plugin.app.vault.read(existing);
            const parsed = JSON.parse(raw) as LayoutParserDebugDocument;
            if (parsed && parsed.version === 1 && parsed.pages) return parsed;
        } catch (err) {
            this.plugin.logDebug('[LayoutParserDebug] Failed to parse debug file', err);
        }
        return null;
    }

    private async writeDoc(
        pdfFile: TFile,
        mutator: (doc: LayoutParserDebugDocument) => void
    ): Promise<void> {
        const path = this.getDebugFilePath(pdfFile);
        const runner = async () => {
            let doc = await this.readDoc(pdfFile);
            if (!doc) {
                doc = {
                    version: 1,
                    pdfPath: pdfFile.path,
                    updatedAt: new Date().toISOString(),
                    pages: {}
                };
            }

            mutator(doc);
            doc.updatedAt = new Date().toISOString();
            await this.writeDocToPath(path, doc);
        };

        const prev = this.writeLocks.get(path) || Promise.resolve();
        const current = prev.then(runner, runner).finally(() => {
            if (this.writeLocks.get(path) === current) {
                this.writeLocks.delete(path);
            }
        });
        this.writeLocks.set(path, current);
        await current;
    }

    private async writeDocToPath(path: string, doc: LayoutParserDebugDocument): Promise<void> {
        const payload = JSON.stringify(doc, null, 2);
        const existing = this.plugin.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, payload);
            return;
        }

        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (dir) await this.ensureDirectory(dir);
        await this.plugin.app.vault.create(path, payload);
    }

    private async ensureDirectory(path: string): Promise<void> {
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

    private ensurePage(doc: LayoutParserDebugDocument, pageNumber: number): DebugPageRecord {
        const key = String(pageNumber);
        if (!doc.pages[key]) {
            doc.pages[key] = {
                pageNumber,
                updatedAt: new Date().toISOString(),
                detections: [],
                manualBoxes: []
            };
        }
        return doc.pages[key];
    }

    private clamp01(v: number): number {
        return Math.max(0, Math.min(1, v));
    }

    private round(v: number, digits: number): number {
        const p = 10 ** digits;
        return Math.round(v * p) / p;
    }
}
