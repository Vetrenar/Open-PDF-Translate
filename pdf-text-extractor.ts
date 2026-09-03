// pdf-text-extractor.ts
// ─────────────────────────────────────────────────────────────────────────
// SIMPLIFIED main-thread PDF text + layout extraction.
//
// REPLACES: pdf-layout-service.ts + pdf-layout-worker.ts (1745 lines combined).
// THIS FILE: ~250 lines.
//
// WHY NO WEB WORKER?
//   Obsidian ≥1.5 uses vault-scoped `app://<hash>/...` URLs for plugin
//   resources. The Worker constructor refuses cross-origin script URLs, so
//   spawning a Web Worker from the plugin folder became a fragile 3-strategy
//   dance (getResourcePath → file:// → blob:) that still failed on many
//   setups. On top of that, pdfjs-dist itself wants ITS OWN inner worker
//   (`pdf.worker.mjs`), compounding the cross-origin problem.
//
//   This module runs pdfjs directly on the main thread in "fake-worker" mode
//   (pdfjs parses PDFs synchronously instead of spawning an inner worker).
//   No Worker construction → no cross-origin issues → works on every Obsidian
//   version and platform.
//
// UI RESPONSIVENESS:
//   Parsing one page takes ~100-500ms (mostly getTextContent + getOperatorList
//   for font resolution). Between pages, callers should `await new
//   Promise(r => setTimeout(r, 0))` to let Obsidian repaint. For 100-page
//   PDFs this gives ~10-50s total wall time with a responsive UI between
//   pages. The progress callback fires after each page so UIs can update.
//
// PIPELINE (per page):
//   1. getDocument(pdfBytes)            → pdf document handle
//   2. page.getViewport({ scale: 1 })   → pageWidth / pageHeight
//   3. page.getTextContent()            → text items with str/transform/width/height/fontName
//   4. page.getOperatorList()           → TRIGGERS font loading in commonObjs
//   5. resolve each item.fontName via page.commonObjs → "DAAHPF+AdvGillSans-Bold"
//   6. buildInputRects (flip y from bottom-origin → top-origin)
//   7. buildOccupancyMap(rects, w, h, 4)
//   8. buildParagraphs(map, rects, { indentThreshold, fontSizeTolerance, maxMergePasses })
//   9. normalize to page-relative coordinates
//  10. pdf.destroy()                    → free resources
// ─────────────────────────────────────────────────────────────────────────

import { TFile, Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import { buildOccupancyMap } from './OccupancyMap';
import { buildParagraphs } from './IslandBuilder';

// `require` is available globally in Obsidian (Electron CommonJS context).
// We declare it here because TypeScript in ESM mode doesn't know about it.
declare const require: ((id: string) => any) | undefined;

// ─────────────────────────────────────────────────────────────────────
// CRITICAL: pdfjs-dist is loaded LAZILY via require() on first use.
//
// WHY NOT A TOP-LEVEL IMPORT?
//   pdfjs-dist 4.x has a static initializer (class PDFWorker { static
//   _isSameOrigin = ...; }) that runs at module-load time. When esbuild
//   bundles the ESM (.mjs) build into a CommonJS Obsidian plugin, circular
//   dependencies inside pdfjs can cause `PDFWorker` to be `undefined` when
//   the static field initializer runs, throwing:
//     TypeError: Cannot set properties of undefined (setting '_isSameOrigin')
//   This crashes the ENTIRE plugin at startup.
//
// WHY NOT dynamic `import()`?
//   Dynamic `import('pdfjs-dist/legacy/build/pdf.mjs')` still triggers the
//   static initializer (just deferred to first call). The ESM `.mjs` build
//   crashes the same way. And `import('pdfjs-dist/legacy/build/pdf.js')`
//   fails with "Failed to resolve module specifier" because esbuild does
//   not resolve dynamic import() calls with explicit file extensions for
//   bare module specifiers.
//
// WHY `require()` WITH THE CJS (`.js`) BUILD?
//   1. esbuild correctly resolves `require('pdfjs-dist/...')` at bundle time.
//   2. The CJS build (`pdf.js`, not `pdf.mjs`) is compiled without static
//      class fields — it uses prototype assignment, which avoids the
//      `_isSameOrigin` static-init crash entirely.
//   3. `require()` is synchronous, which is fine for our use case (we call
//      it inside `ensurePdfjs()` which runs on first extraction, not at
//      plugin load).
//
// FAKE-WORKER MODE:
//   `GlobalWorkerOptions.workerSrc = ''` makes pdfjs fall back to
//   "fake-worker" mode — it parses PDFs synchronously on the calling thread
//   instead of spawning a Web Worker. This avoids Obsidian ≥1.5's
//   cross-origin restrictions on plugin resource URLs.
//
// IF THIS STILL FAILS:
//   The `_isSameOrigin` crash is a known pdfjs-dist 4.x + esbuild bug.
//   Workaround: pin pdfjs-dist to v3.11.174 in package.json:
//     npm install pdfjs-dist@3.11.174
//   pdfjs-dist 3.x does not use static class fields and bundles cleanly.
// ─────────────────────────────────────────────────────────────────────

// Re-export types so callers can `import type { ... }` from here instead of
// from the deleted pdf-layout-worker.ts.
export interface NormalizedSpan {
    left: number;
    top: number;
    right: number;
    bottom: number;
    fontname: string;
    fontsize: number;
    text: string;
}

export interface NormalizedParagraph {
    relativeRect: { left: number; top: number; width: number; height: number };
    page: number;
    text: string;
    fontSize: number;
    fontFamily: string;
    originalFontSizes: number[];
    spans: NormalizedSpan[];
}

export interface ExtractPageResult {
    paragraphs: NormalizedParagraph[];
    pageWidth: number;
    pageHeight: number;
    pageNum: number;
}

export interface ExtractAllPagesOptions {
    onProgress?: (current: number, total: number) => void;
    onPageResult?: (pageNum: number, result: ExtractPageResult) => void;
    /** Yield to the event loop between pages so UI can repaint. Default: true. */
    yieldBetweenPages?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Types (mirror pdf-layout-worker.ts's InputRect / Paragraph)
// ─────────────────────────────────────────────────────────────────────

interface InputRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    fontname?: string;
    fontsize?: number;
    text?: string;
}

interface Paragraph {
    pxLeft: number;
    pxTop: number;
    pxRight: number;
    pxBottom: number;
    width: number;
    height: number;
    spans: InputRect[];
    dominantFamily: string;
    dominantSize: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const LOG_PREFIX = '[PdfTextExtractor]';

/** TTL for the per-file PDF bytes cache. */
const PDF_BYTES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Phase 10 (LRU): hard caps on the per-file PDF bytes cache. PDFs can be
// large (tens of MB), and without bounds the cache would grow unbounded
// as the user opens more files. We keep at most MAX_ENTRIES distinct files
// AND at most MAX_BYTES total — whichever is hit first triggers eviction
// of the oldest entry (Map insertion order = LRU-ish; we don't promote on
// read because the cost of an extra Map mutation per page outweighs the
// minor hit-rate improvement for a 5-minute-TTL cache).
const PDF_BYTES_CACHE_MAX_ENTRIES = 3;
const PDF_BYTES_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256 MB

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export class PdfTextExtractor {
    private readonly plugin: OpenRouterTranslatorPlugin;

    /** Per-file PDF bytes cache (avoid re-reading from disk on every page). */
    private readonly pdfBytesCache: Map<string, { bytes: ArrayBuffer; timestamp: number; size: number }> = new Map();

    /** Phase 10 (LRU): running total of `pdfBytesCache` entry sizes (bytes). */
    private pdfBytesCacheTotalBytes = 0;

    /** Ref returned by `vault.on('modify', ...)` — used to unregister on dispose. */
    private modifyEventRef: any | null = null;

    private disposed: boolean = false;

    /**
     * Lazily-loaded pdfjs-dist module. Set on first call to ensurePdfjs().
     * Using `any` because we can't import the types without triggering the
     * static initializer that crashes the plugin at load time.
     */
    private pdfjsLib: any = null;

    /** Cached error from a previous pdfjs load attempt (avoids retrying on every call). */
    private pdfjsInitError: string | null = null;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.registerCacheInvalidation();
    }

    // ════════════════════════════════════════════════════════════════
    // INTERNAL — lazy pdfjs loader
    // ════════════════════════════════════════════════════════════════

    /**
     * Lazily load pdfjs-dist on first use. Async because the CDN fallback
     * requires loading a <script> tag.
     *
     * Loading strategy (3 fallbacks):
     *
     * 1. STATIC `require('pdfjs-dist/legacy/build/pdf.js')` — esbuild
     *    bundles this at build time IF the argument is a string literal.
     *    (The previous bug was using `require(candidate)` with a variable,
     *    which esbuild leaves as a runtime require — fails in Obsidian.)
     *    The CJS build avoids the ESM `_isSameOrigin` static-init crash.
     *
     * 2. STATIC `require('pdfjs-dist/build/pdf.js')` — non-legacy CJS
     *    build, alternative path.
     *
     * 3. CDN fallback — load pdfjs v3.11.174 from cdnjs.cloudflare.com
     *    via a <script> tag. v3.x does NOT have the static class field
     *    bug, so it always works. Requires internet access.
     *
     * @throws Error if all three strategies fail.
     */
    private async ensurePdfjs(): Promise<any> {
        if (this.pdfjsLib) return this.pdfjsLib;
        if (this.pdfjsInitError) {
            throw new Error(
                `${LOG_PREFIX} pdfjs-dist previously failed to load and will not be retried.\n` +
                `Original error: ${this.pdfjsInitError}\n` +
                `If the error mentions '_isSameOrigin', pin pdfjs-dist to v3.11.174:\n` +
                `  npm install pdfjs-dist@3.11.174`,
            );
        }

        const debug = !!this.plugin.settings?.debugMode;
        const req: ((id: string) => any) | undefined =
            (typeof require !== 'undefined' ? require : (globalThis as any).require);

        let lastErr: any = null;

        // ── Attempt 1: legacy CJS build (static literal — esbuild bundles) ──
        if (typeof req === 'function') {
            try {
                if (debug) console.log(`${LOG_PREFIX} Trying require('pdfjs-dist/legacy/build/pdf.js')...`);
                // STATIC string literal — esbuild MUST see this to bundle at build time.
                // Do NOT change to a variable or template literal.
                const mod: any = req('pdfjs-dist/legacy/build/pdf.js');
                this.pdfjsLib = mod.default || mod;
                if (debug) console.log(`${LOG_PREFIX} Loaded pdfjs-dist (legacy CJS). Version: ${this.pdfjsLib.version || 'unknown'}`);
            } catch (e1: any) {
                lastErr = e1;
                if (debug) console.warn(`${LOG_PREFIX} legacy CJS require failed:`, e1?.message || e1);

                // ── Attempt 2: non-legacy CJS build ──
                try {
                    if (debug) console.log(`${LOG_PREFIX} Trying require('pdfjs-dist/build/pdf.js')...`);
                    const mod: any = req('pdfjs-dist/build/pdf.js');
                    this.pdfjsLib = mod.default || mod;
                    if (debug) console.log(`${LOG_PREFIX} Loaded pdfjs-dist (non-legacy CJS). Version: ${this.pdfjsLib.version || 'unknown'}`);
                } catch (e2: any) {
                    lastErr = e2;
                    if (debug) console.warn(`${LOG_PREFIX} non-legacy CJS require failed:`, e2?.message || e2);
                }
            }
        }

        // ── Attempt 3: CDN fallback (pdfjs v3.11.174 — no static field bug) ──
        if (!this.pdfjsLib) {
            try {
                if (debug) console.log(`${LOG_PREFIX} Trying CDN fallback (pdfjs 3.11.174)...`);
                this.pdfjsLib = await this.loadPdfjsFromCdn();
                if (debug) console.log(`${LOG_PREFIX} Loaded pdfjs-dist from CDN. Version: ${this.pdfjsLib.version || 'unknown'}`);
                new Notice(
                    'PDF Translator: pdfjs-dist loaded from CDN (bundled version failed). ' +
                    'Background translation requires internet access. ' +
                    'To fix permanently, run: npm install pdfjs-dist@3.11.174',
                    8000,
                );
            } catch (e3: any) {
                lastErr = e3;
                if (debug) console.warn(`${LOG_PREFIX} CDN fallback failed:`, e3?.message || e3);
            }
        }

        // ── All attempts failed ──
        if (!this.pdfjsLib) {
            const msg = lastErr?.message ?? String(lastErr);
            this.pdfjsInitError = msg;
            console.error(`${LOG_PREFIX} All pdfjs-dist loading strategies failed.`, lastErr);
            throw new Error(
                `${LOG_PREFIX} Could not load pdfjs-dist.\n` +
                `Last error: ${msg}\n\n` +
                `To fix:\n` +
                `  1. Run: npm install pdfjs-dist@3.11.174\n` +
                `  2. Rebuild the plugin\n` +
                `  3. If that fails, ensure internet access is available (CDN fallback)\n` +
                `Or pin pdfjs-dist to v3.x in package.json to avoid the _isSameOrigin bug.`,
            );
        }

        // Configure fake-worker mode (no Web Worker — parse on main thread).
        try {
            if (this.pdfjsLib.GlobalWorkerOptions) {
                this.pdfjsLib.GlobalWorkerOptions.workerSrc = '';
                if (debug) console.log(`${LOG_PREFIX} pdfjs fake-worker mode enabled (workerSrc = '').`);
            } else {
                console.warn(`${LOG_PREFIX} pdfjsLib.GlobalWorkerOptions not found — worker may spawn unexpectedly.`);
            }
        } catch (cfgErr: any) {
            console.warn(`${LOG_PREFIX} Failed to set workerSrc (continuing anyway):`, cfgErr);
        }

        return this.pdfjsLib;
    }

    /**
     * Load pdfjs v3.11.174 from cdnjs CDN via a <script> tag.
     *
     * v3.x is used because it does NOT have the static class field bug
     * (`_isSameOrigin`) that crashes pdfjs-dist 4.x when bundled by esbuild.
     *
     * The script sets `window.pdfjsLib` globally on load.
     *
     * @throws Error if the script fails to load or window.pdfjsLib is not set.
     */
    private loadPdfjsFromCdn(): Promise<any> {
        return new Promise((resolve, reject) => {
            // If already loaded (e.g. from a previous call), reuse.
            const existing = (window as any).pdfjsLib;
            if (existing && typeof existing.getDocument === 'function') {
                resolve(existing);
                return;
            }

            const script = document.createElement('script');
            // v3.11.174 — last 3.x release, no static field bug, API-compatible.
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.async = true;
            script.crossOrigin = 'anonymous';

            const timeoutMs = 15_000;
            const timer = setTimeout(() => {
                script.onload = null;
                script.onerror = null;
                reject(new Error(`CDN script load timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            script.onload = () => {
                clearTimeout(timer);
                const lib = (window as any).pdfjsLib;
                if (lib && typeof lib.getDocument === 'function') {
                    resolve(lib);
                } else {
                    reject(new Error('CDN script loaded but window.pdfjsLib not found or missing getDocument'));
                }
            };
            script.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Failed to load pdfjs script from CDN (cdnjs.cloudflare.com). Check internet connection.'));
            };

            document.head.appendChild(script);
        });
    }

    // ════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ════════════════════════════════════════════════════════════════

    /**
     * Read a PDF file from the vault, returning its bytes as an ArrayBuffer.
     * Cached per file path with TTL {@link PDF_BYTES_CACHE_TTL_MS}.
     */
    async readPdfBytes(file: TFile): Promise<ArrayBuffer> {
        this.assertNotDisposed();

        const cached = this.getCachedBytes(file);
        if (cached) return cached;

        let bytes: ArrayBuffer;
        try {
            bytes = await this.plugin.app.vault.readBinary(file);
        } catch (err: any) {
            throw new Error(`${LOG_PREFIX} Failed to read PDF "${file.path}": ${err?.message ?? err}`);
        }

        if (!bytes || bytes.byteLength === 0) {
            throw new Error(`${LOG_PREFIX} PDF "${file.path}" is empty or unreadable`);
        }

        this.pdfBytesCache.set(file.path, { bytes, timestamp: Date.now(), size: bytes.byteLength });
        this.pdfBytesCacheTotalBytes += bytes.byteLength;
        // Phase 10 (LRU): enforce the size/count cap immediately after the
        // insert. Eviction may remove this very entry if it is the oldest
        // AND exceeds the byte cap on its own — that's an acceptable edge
        // case (the caller already has the bytes in hand).
        this.evictPdfBytesCache();
        return bytes;
    }

    /**
     * Extract normalized paragraphs for a single page of a PDF.
     *
     * Runs pdfjs on the main thread (fake-worker mode). UI will be blocked
     * for ~100-500ms depending on page complexity. Callers doing multi-page
     * extraction should use {@link extractAllPages} (yields between pages,
     * but still loads the document per page) or, preferably,
     * {@link extractPagesBatch} (Phase 10: loads the document ONCE for the
     * whole batch — eliminates the 100× loadingTask overhead on multi-page
     * PDFs and avoids per-page Uint8Array copies).
     */
    async extractPage(file: TFile, pageNum: number): Promise<ExtractPageResult> {
        this.assertNotDisposed();
        if (!Number.isFinite(pageNum) || pageNum < 1) {
            throw new Error(`${LOG_PREFIX} pageNum must be a positive finite number, got ${pageNum}`);
        }

        const debug = !!this.plugin.settings?.debugMode;
        const t0 = Date.now();
        if (debug) console.log(`${LOG_PREFIX} extractPage("${file.path}", p${pageNum}) starting...`);

        const pdfBytes = await this.readPdfBytes(file);
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] PDF bytes: ${(pdfBytes.byteLength / 1024).toFixed(1)}KB (cached=${this.pdfBytesCache.has(file.path)})`);

        // Lazily load pdfjs-dist on first use (async — CDN fallback needs <script> tag).
        const pdfjsLib = await this.ensurePdfjs();

        // getDocument takes ownership of the Uint8Array and may detach the
        // underlying ArrayBuffer. We pass a COPY so the cache stays valid
        // for subsequent calls (matches pdf-layout-service.ts behavior).
        const data = new Uint8Array(pdfBytes.slice(0));

        const t1 = Date.now();
        const loadingTask = pdfjsLib.getDocument({
            data,
            isEvalSupported: false,
            useSystemFonts: false,
            // disableWorker is not an official option, but workerSrc='' above
            // already forces fake-worker mode. Setting this too is belt-and-
            // suspenders for older pdfjs versions that checked it.
            disableWorker: true,
        });

        // P0-5: if `loadingTask.promise` rejects (corrupt PDF, encrypted PDF,
        // network issue), the previous code fell through to `finally` and
        // tried `pdf.destroy()` on `undefined` — a TypeError that was silently
        // swallowed. The `loadingTask` itself was NEVER destroyed, leaking
        // its underlying transport, font cache, and pending object requests
        // for the lifetime of the plugin. We now destroy the loadingTask in
        // the rejection path before re-throwing the original error.
        //
        // Phase 18 (C21): pdfjs throws a `PasswordException` (with
        // `err.name === 'PasswordException'`) for encrypted PDFs. Surface a
        // clear Notice and re-throw a plain Error so callers don't have to
        // know about pdfjs-specific exception types.
        let pdf: any;
        try {
            pdf = await loadingTask.promise;
        } catch (err: any) {
            try { await loadingTask.destroy(); } catch { /* ignore cleanup errors */ }
            if (err?.name === 'PasswordException') {
                new Notice('PDF is encrypted — password-protected PDFs are not supported.', 8000);
                throw new Error('PDF is encrypted. Password-protected PDFs are not supported.');
            }
            throw err;
        }
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Document loaded in ${Date.now() - t1}ms`);

        try {
            const page = await pdf.getPage(pageNum);
            // P1-23 (Phase 10): the per-page extraction logic (viewport,
            // getTextContent, getOperatorList, font resolution, OccupancyMap,
            // IslandBuilder, normalize) is now factored out into
            // `extractPageFromHandle` so it can be shared with
            // `extractPagesBatch` — which loads the PDF document ONCE and
            // reuses it across many pages (eliminating the per-page
            // loadingTask + Uint8Array.copy overhead).
            return await this.extractPageFromHandle(pdf, page, pageNum, debug, t0);
        } catch (err: any) {
            console.error(`${LOG_PREFIX} [p${pageNum}] Extraction FAILED after ${Date.now() - t0}ms:`, err);
            throw err;
        } finally {
            try { await pdf.destroy(); } catch { /* ignore cleanup errors */ }
        }
    }

    /**
     * Phase 10 (P1-23 + P2-40): Extract paragraphs for a batch of pages from
     * a single PDF, loading the PDF document ONCE and reusing the `pdf`
     * handle across every page.
     *
     * Why this exists:
     *   - **P1-23**: the previous `extractPage`-in-a-loop pattern loaded the
     *     PDF document once PER PAGE (`pdfjsLib.getDocument()` →
     *     `loadingTask.promise` → `pdf.destroy()`). On a 100-page PDF that's
     *     100 document loads — each parsing the cross-reference table, the
     *     page tree, and the font catalogue. The pdfjs `getDocument` call
     *     alone takes 100-300ms even before any page is touched. For a
     *     1000-page PDF this was 100-300 SECONDS of pure overhead, with the
     *     UI completely frozen.
     *   - **P2-40**: each `extractPage` call also did `new
     *     Uint8Array(pdfBytes.slice(0))` — a full memcpy of the PDF (often
     *     5-50 MB). 100 pages → 100 memcpys of the same buffer, all
     *     immediately GC'd. `extractPagesBatch` slices the buffer exactly
     *     ONCE for the whole batch.
     *
     * Per-page failures (encrypted page, missing page, parsing error) are
     * recorded as `{ error, pageNum }` in the returned Map — the overall
     * batch only rejects on catastrophic failure (corrupt PDF, encrypted
     * document, IO error). This mirrors the per-page resilience of
     * {@link extractAllPages} while amortizing the document-load cost.
     *
     * @param file The PDF file to extract from.
     * @param pageNums Page numbers (1-indexed) to extract. Order is
     *     preserved — pages are extracted sequentially in the given order,
     *     with the same `pdf` handle reused across calls. Duplicates are
     *     allowed (each occurrence returns a fresh result).
     * @returns Map<pageNum, ExtractPageResult | { error, pageNum }>. Empty
     *     pages (e.g. image-only PDFs) return a successful
     *     `ExtractPageResult` with `paragraphs: []`.
     */
    async extractPagesBatch(
        file: TFile,
        pageNums: number[],
    ): Promise<Map<number, ExtractPageResult | { error: string; pageNum: number }>> {
        this.assertNotDisposed();
        const results = new Map<number, ExtractPageResult | { error: string; pageNum: number }>();
        if (pageNums.length === 0) return results;

        const debug = !!this.plugin.settings?.debugMode;
        const t0 = Date.now();
        const pageNumsPreview = pageNums.length <= 8
            ? `[${pageNums.join(',')}]`
            : `[${pageNums.slice(0, 8).join(',')}+${pageNums.length - 8} more]`;
        if (debug) console.log(`${LOG_PREFIX} extractPagesBatch("${file.path}", ${pageNumsPreview}) starting...`);

        const pdfBytes = await this.readPdfBytes(file);
        if (debug) console.log(`${LOG_PREFIX} PDF bytes: ${(pdfBytes.byteLength / 1024).toFixed(1)}KB (cached=${this.pdfBytesCache.has(file.path)})`);

        const pdfjsLib = await this.ensurePdfjs();

        // P2-40 (Phase 10): copy the underlying ArrayBuffer ONCE for the
        // whole batch. `pdfjsLib.getDocument()` takes ownership of the
        // Uint8Array and may detach the underlying ArrayBuffer (so we can't
        // pass `pdfBytes` directly — that would corrupt the per-file cache).
        // Previously `extractPage` did this copy per page; now it's once per
        // batch. For a 100-page 10MB PDF this saves ~1 GB of allocations
        // (and the corresponding GC churn) per extraction run.
        const data = new Uint8Array(pdfBytes.slice(0));

        const t1 = Date.now();
        const loadingTask = pdfjsLib.getDocument({
            data,
            isEvalSupported: false,
            useSystemFonts: false,
            disableWorker: true,
        });

        // P0-5 / Phase 18 (C21): same encrypted-PDF + loadingTask-cleanup
        // handling as `extractPage`. Catastrophic failures here propagate to
        // the caller as a rejected promise — per-page failures are recorded
        // in the result Map instead.
        let pdf: any;
        try {
            pdf = await loadingTask.promise;
        } catch (err: any) {
            try { await loadingTask.destroy(); } catch { /* ignore */ }
            if (err?.name === 'PasswordException') {
                new Notice('PDF is encrypted — password-protected PDFs are not supported.', 8000);
                throw new Error('PDF is encrypted. Password-protected PDFs are not supported.');
            }
            throw err;
        }
        if (debug) console.log(`${LOG_PREFIX} Document loaded in ${Date.now() - t1}ms (reused for ${pageNums.length} page(s))`);

        try {
            for (const pageNum of pageNums) {
                // Cooperative cancellation: if the extractor was disposed
                // mid-batch (e.g. plugin unload), stop pulling more pages and
                // let the finally block destroy the document. Pages already
                // in `results` remain valid.
                if (this.disposed) break;

                if (!Number.isFinite(pageNum) || pageNum < 1) {
                    results.set(pageNum, { error: `pageNum must be a positive finite number, got ${pageNum}`, pageNum });
                    continue;
                }

                try {
                    const page = await pdf.getPage(pageNum);
                    const result = await this.extractPageFromHandle(pdf, page, pageNum, debug, t0);
                    results.set(pageNum, result);
                } catch (err: any) {
                    const errMsg = err?.message ?? String(err);
                    console.warn(`${LOG_PREFIX} [p${pageNum}] Batch extraction failed: ${errMsg}`);
                    results.set(pageNum, { error: errMsg, pageNum });
                }
            }
            return results;
        } finally {
            try { await pdf.destroy(); } catch { /* ignore cleanup errors */ }
            if (debug) {
                const okCount = [...results.values()].filter(r => !('error' in r)).length;
                const errCount = results.size - okCount;
                console.log(`${LOG_PREFIX} Batch done in ${Date.now() - t0}ms (${okCount} ok, ${errCount} failed).`);
            }
        }
    }

    /**
     * Phase 10 (P1-23): Extract paragraphs from a single page using an
     * already-loaded PDF document handle.
     *
     * Factored out of {@link extractPage} so that {@link extractPagesBatch}
     * can amortize the document-load cost across many pages. The caller
     * owns the `pdf` lifecycle (must call `pdf.destroy()` after use).
     *
     * @param pdf A loaded pdfjs document handle (from `loadingTask.promise`).
     * @param page A loaded pdfjs page handle (from `pdf.getPage(pageNum)`).
     *     Passed in (rather than fetched inside) so single-page callers can
     *     still control page-handle lifecycle if needed.
     * @param pageNum 1-indexed page number (used for logging + returned in
     *     the result for caller convenience).
     * @param debug Whether to emit per-step timing logs.
     * @param t0 Batch start timestamp (for total-elapsed logging).
     */
    private async extractPageFromHandle(
        pdf: any,
        page: any,
        pageNum: number,
        debug: boolean,
        t0: number,
    ): Promise<ExtractPageResult> {
        const viewport = page.getViewport({ scale: 1 });
        const pageWidth = viewport.width;
        const pageHeight = viewport.height;
        // P0-11: log page.view + viewport offsets in debug mode so
        // bbox-shift issues can be diagnosed. `page.view = [xMin, yMin,
        // xMax, yMax]` is the CropBox (or MediaBox if no CropBox). When
        // xMin or yMin are non-zero, `item.transform[4]/[5]` (PDF
        // user-space from MediaBox origin) needs CropBox-offset
        // compensation — see `buildInputRects` below.
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Page size: ${pageWidth.toFixed(0)}×${pageHeight.toFixed(0)}`, {
            view: page.view,
            offsetX: viewport.offsetX,
            offsetY: viewport.offsetY,
            rotation: page.rotate,
        });

        const t2 = Date.now();
        const textContent = await page.getTextContent();
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] getTextContent: ${textContent.items.length} items in ${Date.now() - t2}ms`);

        // CRITICAL: font objects in page.commonObjs are NOT populated by
        // getTextContent() alone. They are registered lazily as the page
        // operator list is parsed. Without this call, commonObjs.get(fid)
        // throws "Requesting object that isn't resolved yet".
        const t3 = Date.now();
        await page.getOperatorList();
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] getOperatorList: ${Date.now() - t3}ms (font loading)`);

        const fontNames = this.resolveFontNames(textContent.items, page);
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Resolved ${fontNames.size} font(s)`);

        // P0-11: pass `viewport` (not just `pageHeight`) so that
        // `buildInputRects` can use `viewport.convertToViewportPoint()`.
        // That pdfjs API correctly handles BOTH the CropBox offset
        // (`page.view[0]` / `page.view[1]`) AND page rotation, which the
        // previous manual Y-flip (`pageHeight - yBase - h`) did not. On
        // PDFs with non-zero CropBox origin (common with InDesign/Word
        // exports and scans) or page.rotate != 0, the previous math
        // produced bboxes shifted up-and-right relative to the actual
        // text. Going through `convertToViewportPoint` returns viewport
        // pixels (top-left origin), which we then normalise to 0-1 by
        // dividing by viewport.width / viewport.height.
        const rects = this.buildInputRects(textContent.items, fontNames, viewport);
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Built ${rects.length} input rects`);

        // P2-2 (Phase 17): cellSize and tuning knobs now come from
        // `plugin.layoutSettings` so user-tuned values apply symmetrically
        // to the pdfjs (background-translation) path and the DOM path.
        // Previously these were hardcoded, which meant the cache written by
        // background translation could use different tuning than the DOM
        // path used on cache miss.
        const t4 = Date.now();
        const ls = this.plugin.layoutSettings;
        const contourCellSize = (typeof ls?.contourCellSize === 'number' && ls.contourCellSize > 0)
            ? ls.contourCellSize
            : 4;
        const map = buildOccupancyMap(rects, pageWidth, pageHeight, contourCellSize);
        // Stage 2.1 (Q5) + P2-2 (Phase 17): preserveStyle: true — keep
        // bold/italic distinction in font family resolution. This makes
        // the pdfjs path produce the same paragraph splits as the DOM path
        // (which preserves bold/italic via g_d0_fN IDs), so the cache
        // written by background translation is consistent with what
        // the DOM path produces on cache miss.
        const paragraphs = buildParagraphs(map, rects, {
            indentThreshold: typeof ls?.contourIndentThreshold === 'number' ? ls.contourIndentThreshold : 5,
            fontSizeTolerance: typeof ls?.contourFontSizeTolerance === 'number' ? ls.contourFontSizeTolerance : 1,
            maxMergePasses: typeof ls?.maxMergePasses === 'number' ? ls.maxMergePasses
                : (typeof ls?.maxIterMerges === 'number' ? ls.maxIterMerges : 10),
            preserveStyle: true,
            // Stage 2.2 (Q6) + P2-2 (Phase 17): user-tunable column-gap and
            // decoration thresholds now flow from layoutSettings (same
            // defaults as layout-detector.ts uses for the DOM path).
            columnGapThreshold: typeof ls?.columnGapThreshold === 'number' ? ls.columnGapThreshold : 50,
            decorationThreshold: typeof ls?.decorationThreshold === 'number' ? ls.decorationThreshold : 0.7,
        });
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Pipeline: ${rects.length} rects → ${paragraphs.length} paragraphs in ${Date.now() - t4}ms`);

        const normalized = paragraphs.map(p => this.normalizeParagraph(p, pageWidth, pageHeight, pageNum));
        const totalMs = Date.now() - t0;
        if (debug) console.log(`${LOG_PREFIX} [p${pageNum}] Total: ${normalized.length} paragraphs in ${totalMs}ms`);
        return { paragraphs: normalized, pageWidth, pageHeight, pageNum };
    }

    /**
     * Extract paragraphs for every page of a PDF, sequentially.
     *
     * Calls `onProgress(completedPages, totalPages)` after each page.
     * Calls `onPageResult(pageNum, result)` for each SUCCESSFUL page.
     * Failed pages are logged and recorded in the returned Map as
     * `{ error, pageNum }` so the caller can detect partial failures.
     *
     * Between pages, yields to the event loop so UI can repaint.
     */
    async extractAllPages(
        file: TFile,
        options?: ExtractAllPagesOptions,
    ): Promise<Map<number, ExtractPageResult | { error: string; pageNum: number }>> {
        this.assertNotDisposed();

        const totalPages = await this.getPageCount(file);
        const results = new Map<number, ExtractPageResult | { error: string; pageNum: number }>();
        const yieldBetween = options?.yieldBetweenPages !== false;

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            try {
                const result = await this.extractPage(file, pageNum);
                results.set(pageNum, result);
                try { options?.onPageResult?.(pageNum, result); } catch (cbErr) {
                    console.error(`${LOG_PREFIX} onPageResult callback threw:`, cbErr);
                }
            } catch (err: any) {
                const errMsg = err?.message ?? String(err);
                console.warn(`${LOG_PREFIX} Page ${pageNum} of "${file.path}" failed: ${errMsg}`);
                results.set(pageNum, { error: errMsg, pageNum });
            }

            try { options?.onProgress?.(pageNum, totalPages); } catch (cbErr) {
                console.error(`${LOG_PREFIX} onProgress callback threw:`, cbErr);
            }

            // Yield to the event loop between pages so Obsidian can repaint
            // and the user can see progress / click Cancel.
            if (yieldBetween && pageNum < totalPages) {
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }

        return results;
    }

    /**
     * Number of pages in a PDF, without extracting any content.
     */
    async getPageCount(file: TFile): Promise<number> {
        this.assertNotDisposed();

        const pdfBytes = await this.readPdfBytes(file);
        const data = new Uint8Array(pdfBytes.slice(0));

        // Lazily load pdfjs-dist on first use (async — CDN fallback needs <script> tag).
        const pdfjsLib = await this.ensurePdfjs();

        const loadingTask = pdfjsLib.getDocument({
            data,
            isEvalSupported: false,
            useSystemFonts: false,
            disableWorker: true,
        });

        // P0-5: same fix as in extractPage — destroy loadingTask on rejection.
        let pdf: any;
        try {
            pdf = await loadingTask.promise;
        } catch (err) {
            try { await loadingTask.destroy(); } catch { /* ignore */ }
            throw err;
        }
        try {
            return pdf.numPages;
        } finally {
            try { await pdf.destroy(); } catch { /* ignore */ }
        }
    }

    /**
     * Tear down: clear caches and unregister the vault 'modify' listener.
     * Safe to call multiple times.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.pdfBytesCache.clear();
        // Phase 10 (LRU): reset the running total — all entries are gone.
        this.pdfBytesCacheTotalBytes = 0;

        if (this.modifyEventRef !== null) {
            try {
                this.plugin.app.vault.offref(this.modifyEventRef);
            } catch { /* ignore */ }
            this.modifyEventRef = null;
        }
    }

    // ════════════════════════════════════════════════════════════════
    // INTERNAL — pdfjs helpers (ported from pdf-layout-worker.ts)
    // ════════════════════════════════════════════════════════════════

    /**
     * Resolve every unique `fontName` referenced by textContent items into
     * the real PDF font name via `page.commonObjs`.
     *
     * CRITICAL: `page.commonObjs.get(fid)` throws "Requesting object that
     * isn't resolved yet" if called before `page.getOperatorList()` completes.
     * Caller MUST have called getOperatorList() first.
     */
    private resolveFontNames(items: any[], page: any): Map<string, string> {
        const seen = new Set<string>();
        const resolved = new Map<string, string>();

        for (const item of items) {
            const fid = item?.fontName;
            if (!fid || seen.has(fid)) continue;
            seen.add(fid);

            let name = 'unknown';
            try {
                if (page.commonObjs.has(fid)) {
                    const font = page.commonObjs.get(fid);
                    if (font?.name) name = font.name;
                    else if (font?.fallbackName) name = font.fallbackName;
                }
            } catch { /* keep 'unknown' */ }
            resolved.set(fid, name);
        }
        return resolved;
    }

    /**
     * Convert pdf.js textContent items into InputRect[] for the contour pipeline.
     *
     * P0-11: Coordinate system handling rewritten.
     *
     * PREVIOUSLY (BUGGY):
     *   The code used the raw PDF user-space coordinates from `item.transform`
     *   and flipped Y manually:
     *     top    = pageHeight - transform[5] - height
     *     bottom = pageHeight - transform[5]
     *     left   = transform[4]
     *     right  = transform[4] + width
     *   `transform[4]` / `transform[5]` are PDF user-space coords from the
     *   **MediaBox origin**, but `pageHeight = viewport.height = view[3] -
     *   view[1]` is the **CropBox height**. When the PDF has a non-zero
     *   CropBox origin (`view[0] != 0` or `view[1] != 0`) — common with
     *   InDesign/Word exports, scanned PDFs, and any PDF that was cropped —
     *   this produced a systematic shift. With `view[0] < 0` or `view[1] < 0`
     *   (typical for scanned PDFs), bboxes shifted UP and to the RIGHT,
     *   exactly matching the user-reported symptom. The manual flip also did
     *   not account for `page.rotate` (90/180/270), which swaps axes.
     *
     * NOW (FIXED):
     *   We use `viewport.convertToViewportPoint(x, y)` — the standard pdfjs
     *   API that handles CropBox offset, rotation, AND scale in one call.
     *   Returns viewport-space pixels with top-left origin (matching the
     *   rest of our pipeline). We convert two opposite corners of each text
     *   item's bounding rectangle and take the min/max to get a normalised
     *   axis-aligned rect (handles rotation by collapsing the rotated rect
     *   onto its axis-aligned bounding box).
     *
     * PDF.js emits space-only items with height=0 — we substitute the median
     * height from same-baseline siblings so they don't create degenerate rects.
     */
    private buildInputRects(items: any[], fontNames: Map<string, string>, viewport: any): InputRect[] {
        const rects: InputRect[] = [];

        // First pass: collect non-zero heights per baseline for space-item fallback.
        // P0-11: baseline must be computed in viewport space (not raw PDF Y) so
        // that the fallback logic still works correctly on rotated pages.
        // Map key is `number` (rounded viewport Y) — matches the lookup below.
        const nonZeroHeightsByBaseline = new Map<number, number[]>();
        for (const item of items) {
            // FIX (v5): consistent with second pass — skip whitespace-only items
            if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
            if (!item.transform) continue;
            if (typeof item.height !== 'number' || item.height <= 0) continue;
            // Use viewport Y as the baseline key — handles rotation + CropBox.
            const [, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const baseline = Math.round(vy);
            if (!nonZeroHeightsByBaseline.has(baseline)) {
                nonZeroHeightsByBaseline.set(baseline, []);
            }
            nonZeroHeightsByBaseline.get(baseline)!.push(item.height);
        }

        for (const item of items) {
            if (!item || typeof item.str !== 'string') continue;
            // FIX (v5): skip whitespace-only items — they produce degenerate
            // rects with width > 0 but no visible text, which pollute the
            // OccupancyMap and can cause incorrect paragraph grouping.
            if (item.str.length === 0 || !item.str.trim()) continue;
            if (!item.transform) continue;
            if (typeof item.width !== 'number' || typeof item.height !== 'number') continue;

            const x = item.transform[4];
            const yBase = item.transform[5];
            const w = item.width;

            let h = item.height;
            if (h <= 0) {
                // P0-11: use viewport-space baseline for the lookup.
                const [, vy] = viewport.convertToViewportPoint(x, yBase);
                const baseline = Math.round(vy);
                const siblings = nonZeroHeightsByBaseline.get(baseline);
                if (siblings && siblings.length > 0) {
                    const sorted = [...siblings].sort((a, b) => a - b);
                    h = sorted[Math.floor(sorted.length / 2)];
                } else {
                    continue; // isolated space we can't place
                }
            }

            const resolvedFont = fontNames.get(item.fontName) || 'unknown';

            // P0-11: convert two opposite corners of the text item's PDF
            // user-space rect into viewport space. `convertToViewportPoint`
            // applies CropBox offset, rotation, and (here scale=1) — so the
            // result is correctly top-left-origin viewport pixels.
            //
            // PDF text item origin (transform[4], transform[5]) is the
            // baseline-left of the text. The text extends RIGHT by `width`
            // and UP by `height` (PDF Y goes up). So the two opposite corners
            // in PDF user-space are:
            //   (x, yBase)             — bottom-left
            //   (x + w, yBase + h)     — top-right
            const [vx1, vy1] = viewport.convertToViewportPoint(x, yBase);
            const [vx2, vy2] = viewport.convertToViewportPoint(x + w, yBase + h);

            rects.push({
                left: Math.min(vx1, vx2),
                top: Math.min(vy1, vy2),
                right: Math.max(vx1, vx2),
                bottom: Math.max(vy1, vy2),
                fontname: resolvedFont,
                fontsize: h,
                text: item.str,
            });
        }
        return rects;
    }

    /**
     * Normalize a Paragraph (pixel-space, spans reference InputRects) into
     * the page-relative transport format consumed by the queue.
     */
    private normalizeParagraph(p: Paragraph, pageWidth: number, pageHeight: number, pageNum: number): NormalizedParagraph {
        const spans: NormalizedSpan[] = p.spans.map(s => ({
            left: s.left / pageWidth,
            top: s.top / pageHeight,
            right: s.right / pageWidth,
            bottom: s.bottom / pageHeight,
            fontname: s.fontname || 'unknown',
            fontsize: typeof s.fontsize === 'number' ? s.fontsize : 0,
            text: typeof s.text === 'string' ? s.text : '',
        }));

        return {
            relativeRect: {
                left: p.pxLeft / pageWidth,
                top: p.pxTop / pageHeight,
                width: (p.pxRight - p.pxLeft) / pageWidth,
                height: (p.pxBottom - p.pxTop) / pageHeight,
            },
            page: pageNum,
            text: p.spans.map(s => typeof s.text === 'string' ? s.text : '').join(' '),
            fontSize: p.dominantSize,
            fontFamily: p.dominantFamily,
            originalFontSizes: [...new Set(
                p.spans.map(s => s.fontsize).filter((v): v is number => typeof v === 'number')
            )],
            spans,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // INTERNAL — PDF bytes cache
    // ════════════════════════════════════════════════════════════════

    private getCachedBytes(file: TFile): ArrayBuffer | null {
        const entry = this.pdfBytesCache.get(file.path);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > PDF_BYTES_CACHE_TTL_MS) {
            // Phase 10 (LRU): keep the running total in sync on TTL-evict.
            this.pdfBytesCacheTotalBytes -= entry.size;
            this.pdfBytesCache.delete(file.path);
            return null;
        }
        if (entry.bytes.byteLength === 0) {
            // Phase 10 (LRU): keep the running total in sync on empty-bytes-evict.
            this.pdfBytesCacheTotalBytes -= entry.size;
            this.pdfBytesCache.delete(file.path);
            return null;
        }
        return entry.bytes;
    }

    /**
     * Phase 10 (LRU): evict oldest entries until both the entry-count cap
     * and the total-bytes cap are satisfied.
     *
     * Map iteration order is insertion order, so `keys().next().value`
     * gives the oldest entry. We don't promote entries on read (would
     * require `delete` + `set` on every cache hit, doubling the work);
     * with a 5-minute TTL the slight hit-rate degradation is acceptable.
     *
     * Guarded against infinite loops: if the oldest entry is somehow
     * larger than MAX_BYTES on its own, we still evict it (otherwise a
     * single oversized PDF would pin the cache forever).
     */
    private evictPdfBytesCache(): void {
        while (
            this.pdfBytesCache.size > PDF_BYTES_CACHE_MAX_ENTRIES ||
            this.pdfBytesCacheTotalBytes > PDF_BYTES_CACHE_MAX_BYTES
        ) {
            const oldestKey = this.pdfBytesCache.keys().next().value;
            if (oldestKey === undefined) break; // map empty — defensive
            const entry = this.pdfBytesCache.get(oldestKey);
            if (!entry) break; // defensive — should not happen
            this.pdfBytesCacheTotalBytes -= entry.size;
            this.pdfBytesCache.delete(oldestKey);
        }
        // Defensive: clamp to zero in case of accounting drift (e.g. a
        // future code path that deletes a cache entry without updating
        // the total). A negative counter would break the byte-cap check.
        if (this.pdfBytesCacheTotalBytes < 0) this.pdfBytesCacheTotalBytes = 0;
    }

    private registerCacheInvalidation(): void {
        try {
            this.modifyEventRef = this.plugin.app.vault.on('modify', (file: TFile) => {
                if (file && typeof (file as any).path === 'string') {
                    // Phase 10 (LRU): keep the running total in sync when a
                    // cached file is modified on disk and its bytes are
                    // dropped from the cache.
                    const key = (file as TFile).path;
                    const entry = this.pdfBytesCache.get(key);
                    if (entry) {
                        this.pdfBytesCacheTotalBytes -= entry.size;
                        this.pdfBytesCache.delete(key);
                    }
                }
            });
        } catch (err: any) {
            console.warn(`${LOG_PREFIX} Failed to register vault 'modify' listener: ${err?.message ?? err}`);
            this.modifyEventRef = null;
        }
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new Error(`${LOG_PREFIX} extractor has been disposed`);
        }
    }
}

export default PdfTextExtractor;
