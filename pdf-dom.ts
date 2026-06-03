// pdf-dom.ts
// ─────────────────────────────────────────────────────────────────────────
// Single place that touches the (undocumented) Obsidian PDF viewer DOM.
//
// Everywhere else in the plugin used to reach into `.pdfViewer`, `.page`,
// `.textLayer`, `canvas`, `--scale-factor`, `activeLeaf`, etc. directly and
// globally — which is both fragile across Obsidian updates and the source of
// the multi-tab bugs (global `document.querySelector` grabbing the first PDF).
//
// All of that now lives here, leaf-scoped. When the viewer's internals change,
// this is the only file to update.
//
// Design notes:
//  • Every lookup is scoped to a specific leaf's `view.containerEl`. Callers
//    that don't pass a leaf get the active PDF leaf.
//  • Methods return null rather than throwing; callers already handle null.
//  • No memoization here (callers that need it, e.g. OverlayRenderer, keep
//    their own short-TTL caches).
// ─────────────────────────────────────────────────────────────────────────

import { App, TFile, WorkspaceLeaf } from 'obsidian';

export interface WaitOptions {
    timeoutMs?: number;
    intervalMs?: number;
}

export class PdfViewerAdapter {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    // ── Leaves ────────────────────────────────────────────────────────────

    /** The active leaf iff it is a PDF view, else null. */
    getActivePdfLeaf(): WorkspaceLeaf | null {
        const leaf = this.app.workspace.activeLeaf as WorkspaceLeaf | null;
        return leaf && (leaf.view as any)?.getViewType?.() === 'pdf' ? leaf : null;
    }

    /** All open PDF leaves. */
    getPdfLeaves(): WorkspaceLeaf[] {
        return this.app.workspace.getLeavesOfType('pdf');
    }

    /**
     * Resolve the leaf that should be used for a given file: prefer one already
     * showing it, then the active PDF leaf, then any PDF leaf, then most-recent.
     */
    resolveLeafForFile(file: TFile): WorkspaceLeaf | null {
        const leaves = this.getPdfLeaves();
        return (
            leaves.find(l => ((l.view as any)?.file as TFile | undefined)?.path === file.path)
            ?? this.getActivePdfLeaf()
            ?? leaves[0]
            ?? (this.app.workspace.getMostRecentLeaf() as WorkspaceLeaf | null)
        );
    }

    /** The TFile shown in a leaf (or the active PDF leaf). */
    getFile(leaf?: WorkspaceLeaf | null): TFile | null {
        const l = leaf ?? this.getActivePdfLeaf();
        const f = (l?.view as any)?.file as TFile | undefined;
        return f && f.extension === 'pdf' ? f : null;
    }

    // ── Containers ──────────────────────────────────────────────────────────

    /** The leaf's DOM subtree to scope all queries to. */
    getLeafContainer(leaf?: WorkspaceLeaf | null): HTMLElement | null {
        const l = leaf ?? this.getActivePdfLeaf();
        return ((l?.view as any)?.containerEl as HTMLElement) ?? null;
    }

    /** The `.pdfViewer` (or `#viewer`) element within a leaf. */
    getViewerRoot(leaf?: WorkspaceLeaf | null): HTMLElement | null {
        const container = this.getLeafContainer(leaf);
        return (container?.querySelector('.pdfViewer, #viewer') as HTMLElement) ?? null;
    }

    // ── Pages ─────────────────────────────────────────────────────────────

    /** All rendered `.page[data-page-number]` elements in a leaf. */
    getPages(leaf?: WorkspaceLeaf | null): HTMLElement[] {
        const root = this.getViewerRoot(leaf);
        if (!root) return [];
        return Array.from(root.querySelectorAll<HTMLElement>('.page[data-page-number]'));
    }

    getPageElement(pageNumber: number, leaf?: WorkspaceLeaf | null): HTMLElement | null {
        const root = this.getViewerRoot(leaf);
        if (!root) return null;
        return root.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
    }

    /**
     * Best-effort total page count. PDF.js virtualizes pages, so the highest
     * rendered data-page-number is the reliable signal; pass `forceLast` to
     * scroll to the bottom first so the final page mounts.
     */
    async getTotalPages(leaf?: WorkspaceLeaf | null, forceLast = false): Promise<number> {
        const root = this.getViewerRoot(leaf);
        if (!root) return 0;
        const readMax = (): number => {
            let max = 0;
            for (const el of this.getPages(leaf)) {
                const n = parseInt(el.dataset.pageNumber || '0', 10);
                if (n > max) max = n;
            }
            return max;
        };
        if (!forceLast) return readMax();

        const scroller = (root.closest('.workspace-leaf-content') as HTMLElement) || root;
        const prev = scroller.scrollTop;
        scroller.scrollTop = scroller.scrollHeight;
        await this.sleep(300);
        const total = readMax();
        scroller.scrollTop = prev;
        await this.sleep(80);
        return total;
    }

    /** The page with the largest visible area in the viewport. */
    getCurrentVisiblePage(leaf?: WorkspaceLeaf | null): HTMLElement | null {
        const pages = this.getPages(leaf);
        if (pages.length === 0) return null;

        let best: HTMLElement | null = null;
        let maxArea = -1;
        const vh = window.innerHeight;
        for (const page of pages) {
            const rect = page.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const visible = Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top));
            const area = visible * rect.width;
            if (area > maxArea) { maxArea = area; best = page; }
        }
        return best;
    }

    getPageNumberOf(pageEl: HTMLElement): number | null {
        const n = parseInt(pageEl.dataset.pageNumber || '', 10);
        return Number.isFinite(n) ? n : null;
    }

    // ── Text layer & canvas ─────────────────────────────────────────────────

    getTextLayer(pageNumber: number, leaf?: WorkspaceLeaf | null): HTMLElement | null {
        const page = this.getPageElement(pageNumber, leaf);
        return (page?.querySelector('.textLayer') as HTMLElement) ?? null;
    }

    getTextLayerOf(pageEl: HTMLElement): HTMLElement | null {
        return (pageEl.querySelector('.textLayer') as HTMLElement) ?? null;
    }

    getCanvasOf(pageEl: HTMLElement): HTMLCanvasElement | null {
        return (pageEl.querySelector('canvas') as HTMLCanvasElement) ?? null;
    }

    // ── Scale ───────────────────────────────────────────────────────────────

    /** The viewer's current `--scale-factor` (zoom), defaulting to 1. */
    getScaleFactor(leaf?: WorkspaceLeaf | null): number {
        const root = this.getViewerRoot(leaf);
        const raw = root?.style.getPropertyValue('--scale-factor');
        const n = parseFloat(raw || '1');
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    /** The scale factor relative to a specific page's viewer (for save math). */
    getScaleFactorFromPage(pageEl: HTMLElement): number {
        const root = pageEl.closest('.pdfViewer, #viewer') as HTMLElement | null;
        const n = parseFloat(root?.style.getPropertyValue('--scale-factor') || '1');
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    // ── Waiting / rendering ───────────────────────────────────────────────────

    /** Resolve once the page's text layer exists (has rendered), else null. */
    async waitForTextLayer(
        pageNumber: number,
        opts: WaitOptions = {},
        leaf?: WorkspaceLeaf | null,
    ): Promise<HTMLElement | null> {
        if (pageNumber <= 0) return null;
        const timeoutMs = opts.timeoutMs ?? 5000;
        const intervalMs = opts.intervalMs ?? 100;
        const targetLeaf = leaf ?? this.getActivePdfLeaf();
        if (!targetLeaf) return null;

        const deadline = Date.now() + timeoutMs;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const tl = this.getTextLayer(pageNumber, targetLeaf);
            if (tl) return tl;
            if (Date.now() > deadline) return null;
            await this.sleep(intervalMs);
        }
    }

    /**
     * Scroll a page into view and resolve once its canvas has real pixels —
     * needed before capturing a page image (OCR), since PDF.js renders lazily.
     */
    async waitForRenderedPage(
        pageNumber: number,
        opts: WaitOptions = {},
        leaf?: WorkspaceLeaf | null,
    ): Promise<HTMLElement | null> {
        const timeoutMs = opts.timeoutMs ?? 8000;
        const intervalMs = opts.intervalMs ?? 150;
        const targetLeaf = leaf ?? this.getActivePdfLeaf();
        if (!targetLeaf) return null;

        const deadline = Date.now() + timeoutMs;
        let pageEl = this.getPageElement(pageNumber, targetLeaf);
        pageEl?.scrollIntoView({ block: 'center' });
        while (Date.now() < deadline) {
            pageEl = this.getPageElement(pageNumber, targetLeaf);
            const canvas = pageEl ? this.getCanvasOf(pageEl) : null;
            if (pageEl && canvas && canvas.width > 0 && canvas.height > 0) return pageEl;
            pageEl?.scrollIntoView({ block: 'center' });
            await this.sleep(intervalMs);
        }
        return pageEl ?? null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}
