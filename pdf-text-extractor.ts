import { resolvePageLayout } from './region-layout';
import type { LayoutSettings } from './layout-modal';
// pdf-text-extractor.ts
// ─────────────────────────────────────────────────────────────────────────
// SIMPLIFIED PDF text + layout extraction on the MAIN-THREAD PSEUDO-WORKER.
//
// REPLACES: pdf-layout-service.ts + pdf-layout-worker.ts (1745 lines combined).
//
// WORKER STRATEGY (NEW-1 fix, 2026-09-12):
//   Obsidian ≥1.5 uses vault-scoped `app://<hash>/...` URLs for plugin
//   resources, and the Worker constructor refuses cross-origin script
//   URLs — so `new Worker(appUrl)` fails. The pre-NEW-1 workaround
//   registered the bundled pdf.js worker on the PROCESS-GLOBAL
//   `globalThis.pdfjsWorker` (pdf.js worker-resolution PATH A). That
//   poisoned Obsidian's OWN PDF.js viewer (5.3.34), which resolves its
//   worker through the SAME global in priority order: it picked up our
//   3.11.174 handler, skipped spawning its own worker, and crashed with
//   "The API version 5.3.34 does not match the Worker version 3.11.174" —
//   permanently, until a full Obsidian restart (the global survives
//   plugin disable/enable).
//
//   NOW (W-PSEUDO 2026-09-21 → W-CLEAN 2026-09-25): the MAIN-THREAD
//   PSEUDO-WORKER is the plugin's ONLY PDF engine. The real-Worker path
//   (opt-in 'auto' mode + a shipped pdf.worker.js file → blob: URL →
//   `new Worker(blob:)`) was REMOVED in W-CLEAN:
//     • Every build ever shipped by the original repo lacks pdf.worker.js
//       (its esbuild pipeline never copies the worker file), so the
//       real-worker branch NEVER executed in the field — every install
//       has ALWAYS run the main-thread path, measured at ~100-500 ms per
//       page, once per document, amortised by extractPagesBatch /
//       openDocSession. That is sufficient; bulk/background translation
//       runs on the python layout engine (headless-translate), which
//       never touches pdf.js at all.
//     • The removed path carried every historical worker failure class:
//       API/worker version mismatch, mid-session spawn failure, worker
//       file loss on plugin update, and the blob-URL lifecycle.
//     • The pseudo-worker is NOT the old fake-worker poison (see NEW-1
//       above): the bundled worker MODULE
//       (`import('pdfjs-dist/legacy/build/pdf.worker.js')`, embedded into
//       main.js by esbuild — LITERAL specifier) is imported under a
//       defineProperty GUARD that captures the UMD wrapper's
//       `root.pdfjsWorker = factory()` write instead of letting it land
//       on the process global. The captured WorkerMessageHandler is
//       injected into OUR OWN pdf.js copy only (static accessor patches
//       on our PDFWorker class — instance-scoped, invisible to
//       Obsidian's viewer), and pdf.js runs the handler over a
//       LoopbackPort on the main thread.
//
//   INVARIANT (kept from NEW-1): NEVER let a value land on the
//   `pdfjsWorker` process global — not even transiently. Obsidian's own
//   PDF.js viewer (5.3.34) resolves its worker through the SAME global
//   with PRIORITY, and a foreign WorkerMessageHandler there crashes it
//   with "The API version 5.3.34 does not match the Worker version
//   3.11.174" — permanently, until a full Obsidian restart. The guard's
//   getter returns the pre-existing value (usually `undefined`) for the
//   entire import window, and the prior descriptor state is re-established
//   immediately after the import settles.
//
//   The engine also patches OUR copy's fake-worker resolution point
//   (`PDFWorker._setupFakeWorkerGlobal`) to resolve through the captured
//   handler directly — never through pdf.js's own loadScript(workerSrc)
//   path, which would execute the worker bundle as a classic script and
//   put the UMD write on the global (a lurking poison hazard of the stock
//   pdf.js fallback chain).
//
//   Failure mode: if the bundled module itself is dead (corrupted
//   install), extraction fails with a LOUD, actionable error. It must NOT
//   fall back to writing the global directly — that reintroduces the
//   viewer crash.
//
// UI RESPONSIVENESS:
//   Parsing runs on the main thread; paragraph post-processing
//   (OccupancyMap / IslandBuilder, ~1-5 ms/page) also runs on the main
//   thread. The progress callback fires after each page so UIs can update
//   between pages; extractPagesBatch / openDocSession amortise the
//   document load.
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
import { assessNativeText } from './native-text-quality';
import { buildParagraphs } from './IslandBuilder';
import { setColumnMemoryFile } from './column-memory';
import { isTableLikeRowTexts, rowsToUnitText, buildRectFilterCtx, isDroppableContentRect, isDetectionPollutingRect, rowTextFromSpans, HyphenNeighbors } from './table-keep';
import { clampRightEdgesToNextStart } from './ink-geometry';

// NOTE (2026-09 overhaul): pdfjs-dist is now loaded via LITERAL dynamic
// import() — see the loading-strategy block below. The `require`-based
// loader and the CDN <script> fallback were removed: the indirect
// `const req = require; req(...)` pattern was NEVER bundled by esbuild, so
// every installed build fell through to the CDN branch (constant Notice +
// "dynamic <script> element creation" rejection by the community-plugin
// validator). Full story: translate4-audit-deep.md.

// ─────────────────────────────────────────────────────────────────────
// CRITICAL: pdfjs-dist is loaded LAZILY via LITERAL dynamic import().
//
// HOW THIS WORKS:
//   `await import('pdfjs-dist/legacy/build/pdf.js')` with a STRING LITERAL
//   specifier is statically resolved by esbuild at build time: the whole
//   pdf.js CJS build is embedded into main.js as a lazy in-bundle module
//   that only executes on first import. No runtime `require`, no CDN, no
//   <script> injection — works on desktop AND mobile, online AND offline.
//
// DO NOT REGRESS (each of these once broke the plugin):
//   1. The specifier MUST stay a string literal. A variable or template
//      specifier is left as a runtime import and fails in Obsidian.
//   2. Do NOT route loading through an intermediate variable
//      (`const req = require; req(...)`) — esbuild only bundles DIRECT
//      calls; an indirect require survives as a runtime require, and the
//      installed plugin folder has no node_modules, so it throws
//      "Cannot find module" on every launch.
//   3. pdfjs-dist MUST stay pinned to 3.11.174 (exact, no `^`). Only the
//      3.x line ships the CJS builds these paths resolve to; pdfjs-dist
//      4.x is ESM-only (.mjs) and additionally crashes esbuild bundles
//      via the `PDFWorker._isSameOrigin` static-init bug.
//   4. After every build, verify: `stat -c%s main.js` > 1.5 MB and
//      `grep -c PDFWorker main.js` > 0 (see scripts/verify-bundle.sh).
//      A green build with a small main.js means pdfjs was NOT bundled.
//
// MAIN-THREAD PSEUDO-WORKER (W-PSEUDO 2026-09-21 → W-CLEAN 2026-09-25):
//   The pre-NEW-1 `globalThis.pdfjsWorker` registration is GONE; the
//   bundled worker module runs on the main thread under the accessor
//   guard (see importBundledWorkerHandler). The "no direct
//   globalThis.pdfjsWorker WRITE from our code" invariant in
//   scripts/verify-bundle.sh keeps the viewer-crash class from
//   regressing.
//
// WHY NOT a top-level static import?
//   It would eagerly execute pdf.js's ~1 MB module body on the plugin
//   startup critical path. The literal dynamic import keeps the same
//   laziness the old loader had (first PDF operation), at negligible cost.
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
    tableId?: string;
    tableRow?: number;
    tableColumn?: number;
}

export interface ExtractPageResult {
    rotation?: number;
    paragraphs: NormalizedParagraph[];
    pageWidth: number;
    pageHeight: number;
    pageNum: number;
}

/**
 * Phase 5.3 (2026-09-13): an OPEN pdfjs document handle, kept alive across
 * multiple extraction calls for the same file.
 *
 * The thin scheduler in PdfLayoutQueue claims pages in bounded chunks
 * (in-flight ≈ 2×concurrency, not the whole file) to keep task statuses
 * honest and memory bounded. Without this session, every chunk would call
 * `extractPagesBatch` — re-loading the document (100–300ms + a fresh
 * Uint8Array copy of the whole file) per chunk, regressing P1-23 ×N on
 * large PDFs. The session loads the document ONCE per file-pass:
 *
 *   queue opens session → extract chunk 1 → … translate (parallel) …
 *   → extract chunk 2 from the SAME handle → … → file's claimable pages
 *   exhausted → session.destroy()
 *
 * Failure semantics mirror `extractPagesBatch`: per-page failures are
 * `{ error, pageNum }` entries in the returned Map; only a broken session
 * (disposed mid-flight, destroyed document) rejects.
 */
export interface PdfDocSession {
    /** Sequentially extract paragraphs for the given pages (1-based).
     * Order preserved; empty/image-only pages return `paragraphs: []`. */
    extractPages(pageNums: number[]):
        Promise<Map<number, ExtractPageResult | { error: string; pageNum: number }>>;
    /** Destroy the underlying pdfjs document. Idempotent. */
    destroy(): Promise<void>;
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

import type { InputRect } from './OccupancyMap';
import type { Paragraph } from './IslandBuilder';

/**
 * LAYOUT-FIX-22 (F26-a): контекст соседей для одиночных дефисов юнита.
 *
 * Группировка — по точному baseline Math.round(bottom) (та же, что
 * использует Tm-clamp в ink-geometry.ts: все итемы одной Tj-строки
 * разделяют базлайновый флоат, суперскрипты сидят на своей приподнятой
 * базовой линии и в группу тела не попадают). Внутри строки спаны
 * сортируются по left; для каждого спана с текстом «-» запоминаются
 * зазоры до ближайших соседей слева/справа (null — соседа на строке
 * нет). Возвращает Map span→HyphenNeighbors только для дефисов —
 * прочие спаны в контексте не нуждаются (правило маркера для «•»«»««»
 * осталось безусловным).
 */
function buildHyphenNeighborCtx(spans: InputRect[]): Map<InputRect, HyphenNeighbors> {
    const out = new Map<InputRect, HyphenNeighbors>();
    let hasHyphen = false;
    for (const s of spans) {
        if ((s.text ?? '').trim() === '-') { hasHyphen = true; break; }
    }
    if (!hasHyphen) return out; // быстрый путь: дефисов нет — Map пуст
    const byBaseline = new Map<number, InputRect[]>();
    for (const s of spans) {
        const b = Math.round(s.bottom);
        let g = byBaseline.get(b);
        if (!g) { g = []; byBaseline.set(b, g); }
        g.push(s);
    }
    for (const g of byBaseline.values()) {
        if (g.length < 2) continue; // одиночный спан на строке — соседей нет
        g.sort((a, b) => a.left - b.left);
        for (let i = 0; i < g.length; i++) {
            if ((g[i].text ?? '').trim() !== '-') continue;
            const L = i > 0 ? g[i].left - g[i - 1].right : null;
            const R = i + 1 < g.length ? g[i + 1].left - g[i].right : null;
            out.set(g[i], { leftGap: L, rightGap: R });
        }
    }
    return out;
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
// W-RESILIENCE (2026-09-15): guarded import of the bundled worker module.
// ─────────────────────────────────────────────────────────────────────

/**
 * Imports the bundled pdf.js worker MODULE (`pdfjs-dist/legacy/build/
 * pdf.worker.js`, embedded into main.js by esbuild — LITERAL specifier,
 * exactly like the pre-NEW-1 code) and returns its WorkerMessageHandler —
 * WITHOUT letting the worker bundle poison the `pdfjsWorker` process global.
 *
 * Why the guard is needed: the legacy worker file is UMD-wrapped and its
 * wrapper executes `root.pdfjsWorker = factory()` in EVERY branch (CJS
 * `module.exports = root.pdfjsWorker = factory()`, AMD, and the plain-script
 * `root["pdfjs-dist/build/pdf.worker"] = root.pdfjsWorker = factory()`).
 * Executing the module on the main thread therefore writes the global —
 * the exact viewer-crash poisoning that NEW-1 removed.
 *
 * The guard is an accessor installed on the global for the duration of the
 * import: its SETTER captures the UMD write into a closure variable (the
 * real global is never written), and its GETTER keeps returning the
 * pre-existing value (usually `undefined`) — so Obsidian's viewer, which
 * resolves its own worker through the same global with PRIORITY, sees an
 * unset global at EVERY instant, including mid-import. The prior descriptor
 * is restored in `finally` (or the property deleted if it did not exist).
 *
 * Second-and-later calls in the same process hit the ES-module cache: the
 * UMD body does not re-execute, `captured` stays null, and the handler is
 * read from the module namespace (`workerMod` / `workerMod.default`).
 *
 * Module-level on purpose: stateless (no `this`), so tier-1's lazily
 * installed fake-worker patch never retains a disposed extractor instance.
 */
async function importBundledWorkerHandler(): Promise<any> {
    const g: any = globalThis;
    const PROP = 'pdfjsWorker';
    let captured: any = null;
    const prevDesc = Object.getOwnPropertyDescriptor(g, PROP);
    const prevValue = (): any => {
        try {
            if (typeof prevDesc?.get === 'function') return prevDesc.get.call(g);
            return prevDesc ? prevDesc.value : undefined;
        } catch {
            return undefined;
        }
    };
    let trapped = false;
    try {
        Object.defineProperty(g, PROP, {
            configurable: true,
            get: prevValue,
            set: (v: any) => { captured = v; },
        });
        trapped = true;
    } catch (trapErr: any) {
        // Pre-existing NON-configurable property (the global is already held
        // by a third party). Proceed without the guard and warn — in this
        // corner the import overwrites their value, but the global was
        // already compromised before we got here.
        console.warn(
            `${LOG_PREFIX} could not install the pdfjsWorker guard (pre-existing non-configurable global) — ` +
            `the bundled worker import may overwrite a foreign value on it.`,
            trapErr?.message ?? trapErr,
        );
    }
    try {
        // STATIC string literal — esbuild MUST see this to bundle at build time.
        // Do NOT change to a variable or template literal.
        // @ts-ignore — pdfjs-dist 3.x ships no pdf.worker.d.ts; the module is
        // consumed as an opaque { WorkerMessageHandler } object (typed any).
        const workerMod: any = await import('pdfjs-dist/legacy/build/pdf.worker.js');
        const handler: any =
            captured?.WorkerMessageHandler ??
            workerMod?.WorkerMessageHandler ??
            workerMod?.default?.WorkerMessageHandler;
        if (!handler || typeof handler.setup !== 'function') {
            throw new Error('bundled pdf.worker.js did not export a usable WorkerMessageHandler');
        }
        return handler;
    } finally {
        if (trapped) {
            if (prevDesc) Object.defineProperty(g, PROP, prevDesc);
            else delete g[PROP];
        }
    }
}

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

    /**
     * W-PSEUDO (2026-09-21) / W-CLEAN (2026-09-25): backing field for
     * {@link workerEngine}.
     */
    private _workerEngine: 'pseudo-worker' | null = null;

    /**
     * W-PSEUDO (2026-09-21) / W-CLEAN (2026-09-25): the pdf.js engine this
     * instance initialised with. The MAIN-THREAD PSEUDO-WORKER is the ONLY
     * engine (the real-Worker path was removed — see file header); the
     * getter stays as a read-only surface for logging and tests.
     * null before the first ensurePdfjs().
     */
    get workerEngine(): 'pseudo-worker' | null {
        return this._workerEngine;
    }

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.registerCacheInvalidation();
    }

    // ════════════════════════════════════════════════════════════════
    // INTERNAL — lazy pdfjs loader
    // ════════════════════════════════════════════════════════════════

    /**
     * Lazily load pdfjs-dist on first use.
     *
     * Loading strategy (bundled only — Obsidian community-plugin compliant):
     *
     * 1. LITERAL `await import('pdfjs-dist/legacy/build/pdf.js')` — esbuild
     *    resolves the string literal at build time and embeds the CJS build
     *    into main.js as a LAZY module (body executes on first import).
     *    Interop: the CJS module exports the pdfjsLib object itself, and
     *    esbuild's `__toESM` wrapper exposes it as `mod.default`.
     *
     * 2. WORKER ENGINE (W-PSEUDO 2026-09-21 → W-CLEAN 2026-09-25 — the
     *    pseudo-worker is the ONLY engine; the real-Worker 'auto' path was
     *    removed):
     *
     *    PSEUDO-WORKER: the bundled worker MODULE
     *    (`import('pdfjs-dist/legacy/build/pdf.worker.js')`, LITERAL
     *    specifier — esbuild embeds it) is executed on the main thread
     *    under an accessor GUARD on the `pdfjsWorker` global that CAPTURES
     *    the UMD wrapper's write instead of letting it land (the legacy
     *    worker bundle writes `root.pdfjsWorker = factory()` in EVERY UMD
     *    branch — module, AMD and plain-script). The captured
     *    WorkerMessageHandler is injected into OUR OWN pdf.js copy only,
     *    via instance-scoped static accessor patches on our `PDFWorker`
     *    class (`_mainThreadWorkerMessageHandler` +
     *    `_setupFakeWorkerGlobal`), so pdf.js skips the real-worker spawn
     *    and runs the handler over a LoopbackPort on the main thread. The
     *    global itself stays exactly as it was (getter returns the
     *    pre-existing value during the whole import window; state is
     *    restored in `finally`). Zero file dependencies — the engine every
     *    shipped build has always effectively run (see file header).
     *
     *    CRITICAL INVARIANT (NEW-1): NEVER let a value
     *    land on the `pdfjsWorker` global. The process global is read with
     *    PRIORITY by every pdf.js copy in the process — including
     *    Obsidian's own viewer (5.3.34) — and a foreign
     *    WorkerMessageHandler there crashes the viewer with "API version
     *    does not match Worker version". See the file header.
     *
     * There is deliberately NO CDN/network fallback: dynamic <script>
     * injection ("remote code loading") is rejected by the Obsidian
     * community-plugin validator. If the bundled module is dead, the
     * installation itself is broken → loud error + reinstall hint. We do
     * NOT fall back to writing the global directly — that is the bug this
     * loader removes.
     *
     * @throws Error if the bundled library fails to load or the bundled
     *               worker module is dead (corrupted install).
     */
    private async ensurePdfjs(): Promise<any> {
        if (this.pdfjsLib) return this.pdfjsLib;
        if (this.pdfjsInitError) {
            throw new Error(
                `${LOG_PREFIX} pdfjs-dist previously failed to load and will not be retried.\n` +
                `Original error: ${this.pdfjsInitError}`,
            );
        }

        const debug = !!this.plugin.settings?.debugMode;
        let lastErr: any = null;

        try {
            // ── Library: legacy CJS build (LITERAL specifier — esbuild bundles) ──
            if (debug) console.debug(`${LOG_PREFIX} import('pdfjs-dist/legacy/build/pdf.js')...`);
            // STATIC string literal — esbuild MUST see this to bundle at build time.
            // Do NOT change to a variable or template literal.
            const mod: any = await import('pdfjs-dist/legacy/build/pdf.js');
            this.pdfjsLib = mod.default ?? mod;
            if (debug) console.debug(`${LOG_PREFIX} Loaded pdfjs-dist (legacy CJS). Version: ${this.pdfjsLib.version || 'unknown'}`);

            // ── Worker engine (W-PSEUDO 2026-09-21 → W-CLEAN 2026-09-25) ──
            // The MAIN-THREAD PSEUDO-WORKER is the ONLY engine: the bundled
            // worker module runs on the main thread under the pdfjsWorker
            // guard. Zero file dependencies, zero spawn paths; the engine
            // every real install has always effectively run (no shipped
            // build ever contained pdf.worker.js — see file header). The
            // real-Worker 'auto' path (file → blob: URL → new Worker) was
            // REMOVED in W-CLEAN; a stale pdfWorkerMode key from older
            // data.json files is inert (loadSettings deletes it).
            //
            // Engine setup is deferred to after the try-block so a total
            // failure keeps its PRECISE error message, not the generic
            // "could not load pdfjs-dist" wrapper.
        } catch (e1: any) {
            lastErr = e1;
            if (debug) console.warn(`${LOG_PREFIX} bundled pdfjs-dist import failed:`, e1?.message || e1);
        }

        // ── Bundled load failed → installation is broken ──
        if (!this.pdfjsLib) {
            const msg = lastErr?.message ?? String(lastErr);
            this.pdfjsInitError = msg;
            console.error(`${LOG_PREFIX} Bundled pdfjs-dist failed to load.`, lastErr);
            throw new Error(
                `${LOG_PREFIX} Could not load pdfjs-dist (bundled).\n` +
                `Last error: ${msg}\n\n` +
                `The plugin installation appears to be corrupted — please reinstall the plugin.`,
            );
        }

        // ── Pseudo-worker engine (the ONLY engine — W-CLEAN 2026-09-25) ──
        // Throws its own precise error if the bundled worker module is dead.
        await this.enablePseudoWorkerEngine();

        return this.pdfjsLib;
    }

    /**
     * W-PSEUDO (2026-09-21) / W-CLEAN (2026-09-25): enable the MAIN-THREAD
     * PSEUDO-WORKER engine — the plugin's ONLY PDF engine (the real-Worker
     * path was removed in W-CLEAN; see the file header).
     *
     * The bundled worker MODULE (`pdfjs-dist/legacy/build/pdf.worker.js`,
     * embedded into main.js by esbuild) is imported under the pdfjsWorker
     * guard ({@link importBundledWorkerHandler}) and its captured
     * WorkerMessageHandler is injected into OUR OWN pdf.js copy only:
     *   • `PDFWorker._mainThreadWorkerMessageHandler` → the captured
     *     handler: `_initialize()` sees a truthy main-thread handler and
     *     skips the real-worker spawn entirely.
     *   • `PDFWorker._setupFakeWorkerGlobal` → resolves the captured handler
     *     directly (never consults the global, never loadScript).
     *   • `GlobalWorkerOptions.workerSrc = ''` — parity with the pre-NEW-1
     *     fake-worker configuration; with the patches above, none of our
     *     code paths read it.
     * pdf.js then runs the handler over a LoopbackPort on the main thread.
     * THE GLOBAL ITSELF IS NEVER WRITTEN (NEW-1 invariant — see file
     * header).
     *
     * Messaging: ONE soft console.info, NO Notice — the pseudo-worker is
     * the canonical engine, not a degraded state.
     *
     * Performance: parsing runs on the main thread (the profile every
     * shipped build has always had) — a one-time module load (~50-150 ms)
     * plus the usual per-document parse cost, amortised by
     * extractPagesBatch / openDocSession.
     *
     * @throws Error (and pins `pdfjsInitError`) only if the bundled module
     *               is dead (broken install). The plugin code NEVER writes
     *               the global directly in any branch.
     */
    private async enablePseudoWorkerEngine(): Promise<void> {
        let handler: any;
        try {
            handler = await importBundledWorkerHandler();
        } catch (mErr: any) {
            const msg = mErr?.message ?? String(mErr);
            this.pdfjsInitError = `the bundled PDF worker module failed to load: ${msg}`;
            this.pdfjsLib = null; // allow a retry once the install is repaired
            this._workerEngine = null;
            console.error(`${LOG_PREFIX} ${this.pdfjsInitError}`);
            new Notice(
                'PDF Translator: PDF engine failed to initialise — the bundled ' +
                'worker module could not be loaded. Please reinstall the plugin.',
                10000,
            );
            throw new Error(`${LOG_PREFIX} ${this.pdfjsInitError}`);
        }

        this._workerEngine = 'pseudo-worker';
        const lib: any = this.pdfjsLib;
        Object.defineProperty(lib.PDFWorker, '_mainThreadWorkerMessageHandler', {
            configurable: true,
            get: () => handler,
        });
        Object.defineProperty(lib.PDFWorker, '_setupFakeWorkerGlobal', {
            configurable: true,
            get: () => Promise.resolve(handler),
        });
        lib.GlobalWorkerOptions.workerSrc = '';

        // The canonical engine, chosen on purpose — informational only.
        console.info(
            `${LOG_PREFIX} pdf engine: MAIN-THREAD pseudo-worker — ` +
            `the bundled worker module runs under the pdfjsWorker guard; parsing stays ` +
            `on the main thread (~100-500 ms/page, once per document, amortised by batch ` +
            `extraction).`,
        );
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
     * Engine (W-PSEUDO, 2026-09-21): by default pdfjs runs on the main
     * thread (pseudo-worker) — the UI may be blocked for ~100-500ms
     * depending on page complexity; the opt-in 'auto' engine mode moves
     * parsing onto a real worker thread. Callers doing multi-page
     * extraction should use {@link extractAllPages} (yields between pages,
     * but still loads the document per page) or, preferably,
     * {@link extractPagesBatch} (Phase 10: loads the document ONCE for the
     * whole batch — eliminates the 100× loadingTask overhead on multi-page
     * PDFs and avoids per-page Uint8Array copies).
     */
    async extractPage(file: TFile, pageNum: number, layoutSettings?: LayoutSettings): Promise<ExtractPageResult> {
        this.assertNotDisposed();
        if (!Number.isFinite(pageNum) || pageNum < 1) {
            throw new Error(`${LOG_PREFIX} pageNum must be a positive finite number, got ${pageNum}`);
        }

        const debug = !!this.plugin.settings?.debugMode;
        const t0 = Date.now();
        if (debug) console.debug(`${LOG_PREFIX} extractPage("${file.path}", p${pageNum}) starting...`);

        const pdfBytes = await this.readPdfBytes(file);
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] PDF bytes: ${(pdfBytes.byteLength / 1024).toFixed(1)}KB (cached=${this.pdfBytesCache.has(file.path)})`);

        // Lazily load pdfjs-dist on first use (async — literal dynamic import
        // of the bundled module; no network, no <script> tag).
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
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Document loaded in ${Date.now() - t1}ms`);

        try {
            const page = await pdf.getPage(pageNum);
            // P1-23 (Phase 10): the per-page extraction logic (viewport,
            // getTextContent, getOperatorList, font resolution, OccupancyMap,
            // IslandBuilder, normalize) is now factored out into
            // `extractPageFromHandle` so it can be shared with
            // `extractPagesBatch` — which loads the PDF document ONCE and
            // reuses it across many pages (eliminating the per-page
            // loadingTask + Uint8Array.copy overhead).
            return await this.extractPageFromHandle(pdf, page, pageNum, debug, t0, file.path, layoutSettings);
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
        if (debug) console.debug(`${LOG_PREFIX} extractPagesBatch("${file.path}", ${pageNumsPreview}) starting...`);

        const pdfBytes = await this.readPdfBytes(file);
        if (debug) console.debug(`${LOG_PREFIX} PDF bytes: ${(pdfBytes.byteLength / 1024).toFixed(1)}KB (cached=${this.pdfBytesCache.has(file.path)})`);

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
        if (debug) console.debug(`${LOG_PREFIX} Document loaded in ${Date.now() - t1}ms (reused for ${pageNums.length} page(s))`);

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

                // PIPE-FIX-25 (F28-a): free this page's pdf.js resources
                // (operator lists + page objs) — same rationale as the
                // session loop (see the PIPE-FIX-25 block there). Batches
                // are bounded, but the retention applies here identically.
                let page: any = null;
                try {
                    page = await pdf.getPage(pageNum);
                    const result = await this.extractPageFromHandle(pdf, page, pageNum, debug, t0, file.path);
                    results.set(pageNum, result);
                } catch (err: any) {
                    const errMsg = err?.message ?? String(err);
                    console.warn(`${LOG_PREFIX} [p${pageNum}] Batch extraction failed: ${errMsg}`);
                    results.set(pageNum, { error: errMsg, pageNum });
                } finally {
                    this.releasePageResources(page);
                }
                // PIPE-FIX-25 (F28-c): per-page macrotask yield — the
                // LoopbackPort delivers microtasks only; a timer boundary per
                // page keeps the UI responsive during batch bursts.
                await new Promise<void>(resolve => { setTimeout(resolve, 0); });
            }
            return results;
        } finally {
            try { await pdf.destroy(); } catch { /* ignore cleanup errors */ }
            if (debug) {
                const okCount = [...results.values()].filter(r => !('error' in r)).length;
                const errCount = results.size - okCount;
                console.debug(`${LOG_PREFIX} Batch done in ${Date.now() - t0}ms (${okCount} ok, ${errCount} failed).`);
            }
        }
    }

    /**
     * Phase 5.3 (P1-23, scheduler): open the file's document ONCE and keep it
     * open across chunked extraction calls — see `PdfDocSession`.
     *
     * Shares all the amortizations of `extractPagesBatch`: LRU bytes cache
     * (`readPdfBytes`), lazy pdfjs load (`ensurePdfjs`), ONE `Uint8Array` copy
     * for the whole session (P2-40), and the same encrypted-PDF / loadingTask
     * error handling. The buffer copy is made once here; `getDocument` owns
     * it, so the cached bytes stay untouched.
     *
     * The caller MUST call `destroy()` when done (PdfLayoutQueue does this in
     * its drain loop's finally and on file switches). Double-`destroy()` is a
     * no-op.
     */
    async openDocSession(file: TFile): Promise<PdfDocSession> {
        this.assertNotDisposed();
        const debug = !!this.plugin.settings?.debugMode;
        const pdfBytes = await this.readPdfBytes(file);
        if (debug) console.debug(`${LOG_PREFIX} openDocSession("${file.path}") — ${(pdfBytes.byteLength / 1024).toFixed(1)}KB (cached=${this.pdfBytesCache.has(file.path)})`);

        const pdfjsLib = await this.ensurePdfjs();

        // P2-40: single buffer copy per session — getDocument may detach the
        // buffer it receives, so never hand it the cached bytes directly.
        const data = new Uint8Array(pdfBytes.slice(0));
        const loadingTask = pdfjsLib.getDocument({
            data,
            isEvalSupported: false,
            useSystemFonts: false,
        });

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

        let destroyed = false;
        const session: PdfDocSession = {
            extractPages: async (pageNums: number[]) => {
                const results = new Map<number, ExtractPageResult | { error: string; pageNum: number }>();
                if (pageNums.length === 0) return results;
                if (destroyed) {
                    // Cooperative cancellation — same contract as
                    // extractPagesBatch's `this.disposed` break: pages not
                    // yet extracted return no entry; the caller (queue)
                    // re-checks cancellation before treating that as an error.
                    return results;
                }
                const t0 = Date.now();
                if (debug) {
                    const preview = pageNums.length <= 8
                        ? `[${pageNums.join(',')}]`
                        : `[${pageNums.slice(0, 8).join(',')}+${pageNums.length - 8} more]`;
                    console.debug(`${LOG_PREFIX} session.extractPages("${file.path}", ${preview}) starting…`);
                }
                for (const pageNum of pageNums) {
                    // Stop pulling pages once the session/extractor is torn
                    // down — pages already in `results` stay valid.
                    if (destroyed || this.disposed) break;
                    if (!Number.isFinite(pageNum) || pageNum < 1) {
                        results.set(pageNum, { error: `pageNum must be a positive finite number, got ${pageNum}`, pageNum });
                        continue;
                    }
                    let page: any = null;
                    try {
                        page = await pdf.getPage(pageNum);
                        const result = await this.extractPageFromHandle(pdf, page, pageNum, debug, t0, file.path);
                        results.set(pageNum, result);
                    } catch (err: any) {
                        const errMsg = err?.message ?? String(err);
                        console.warn(`${LOG_PREFIX} [p${pageNum}] session extraction failed: ${errMsg}`);
                        results.set(pageNum, { error: errMsg, pageNum });
                    } finally {
                        // PIPE-FIX-25 (F28-a): free this page's pdf.js resources
                        // (operator lists + page objs) — the session holds the
                        // document for the whole file-pass and pdf.js retains
                        // every fetched page in its transport pageCache until
                        // destroy(). Measured 0.5-2 MB/page → hundreds of MB
                        // on a long book → GC death spiral → "app freezes
                        // completely". Document-level commonObjs fonts are
                        // KEPT (later pages still resolve font names); a
                        // re-extract of a cleaned page re-parses it — output
                        // verified byte-identical.
                        this.releasePageResources(page);
                    }
                    // PIPE-FIX-25 (F28-c): the pseudo-worker's LoopbackPort
                    // delivers every pdf.js message as a MICROTASK (a .then
                    // chain on a fixed resolved promise). Awaiting inside the
                    // loop therefore never reaches the macrotask queue — the
                    // whole chunk (up to 2×concurrency pages) monopolizes the
                    // main thread with zero repaint/input/timer opportunities.
                    // One setTimeout(0) per page inserts a real event-loop
                    // boundary (same pattern as extractAllPages).
                    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
                }
                if (debug) {
                    const okCount = [...results.values()].filter(r => !('error' in r)).length;
                    console.debug(`${LOG_PREFIX} session.extractPages done in ${Date.now() - t0}ms (${okCount}/${pageNums.length} ok).`);
                }
                return results;
            },
            destroy: async () => {
                if (destroyed) return;
                destroyed = true;
                try { await pdf.destroy(); } catch { /* ignore cleanup errors */ }
            },
        };
        return session;
    }

    /**
     * PIPE-FIX-25 (F28-a): release a fetched page's pdf.js resources.
     *
     * `PDFPageProxy.cleanup()` clears the page's `_intentStates` (the
     * operator list built by extractPageFromHandle's deliberate
     * `getOperatorList()` font-load call — 0.5-2 MB/page retained) and its
     * page-local `objs`. Document-level `commonObjs` (fonts, deduped across
     * pages) are KEPT, so later pages still resolve font names cheaply, and a
     * re-extract of a cleaned page re-parses it (retranslate flow) with
     * verified byte-identical output.
     *
     * Named method (not an inline `page.cleanup()`) so the bundled build can
     * be verified: the [PIPE-FIX-25] invariant in scripts/verify-bundle.sh
     * greps for `releasePageResources` call sites — an inline call would be
     * indistinguishable from pdf.js's own internal `page.cleanup()` uses.
     */
    private releasePageResources(page: any): void {
        if (!page) return;
        try { page.cleanup(); } catch { /* ignore cleanup errors */ }
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
        fileKey?: string,
        layoutSettings?: LayoutSettings,
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
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Page size: ${pageWidth.toFixed(0)}×${pageHeight.toFixed(0)}`, {
            view: page.view,
            offsetX: viewport.offsetX,
            offsetY: viewport.offsetY,
            rotation: page.rotate,
        });

        const t2 = Date.now();
        const textContent = await page.getTextContent();
        const quality = assessNativeText(textContent.items);
        if (!quality.usable) console.warn("Suspect PDF Unicode: attempting model recovery.", quality);
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] getTextContent: ${textContent.items.length} items in ${Date.now() - t2}ms`);

        // CRITICAL: font objects in page.commonObjs are NOT populated by
        // getTextContent() alone. They are registered lazily as the page
        // operator list is parsed. Without this call, commonObjs.get(fid)
        // throws "Requesting object that isn't resolved yet".
        const t3 = Date.now();
        await page.getOperatorList();
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] getOperatorList: ${Date.now() - t3}ms (font loading)`);

        const fontNames = this.resolveFontNames(textContent.items, page);
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Resolved ${fontNames.size} font(s)`);

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
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Built ${rects.length} input rects`);

        // P2-2 (Phase 17): cellSize and tuning knobs now come from
        // `plugin.layoutSettings` so user-tuned values apply symmetrically
        // to the pdfjs (background-translation) path and the DOM path.
        // Previously these were hardcoded, which meant the cache written by
        // background translation could use different tuning than the DOM
        // path used on cache miss.
        const t4 = Date.now();
        const ls = resolvePageLayout(layoutSettings ?? this.plugin.layoutSettings, fileKey || '', pageNum);
        const contourCellSize = (typeof ls?.contourCellSize === 'number' && ls.contourCellSize > 0)
            ? ls.contourCellSize
            : 4;

        // LAYOUT-FIX-9 (P3, 2026-09-17) — очередь, канал Tm-clamp: правые
        // края фида ограничиваются ТОЧНЫМ стартом следующего item'а той же
        // визуальной строки (ink-geometry.ts). Заявленные ширины pdf.js
        // завышены на 2–28pt (буллет «•» = 96pt при чернилах ~4pt — M5,
        // фантомные wide-юниты try3:p4 x7), а заявленный край левой
        // колонки (342 при чернилах 314) — почва D1-присвоения в слайсере.
        // Кламп меняет ТОЛЬКО фид детектора; выход очереди несёт ink-края
        // (рамки-фантомы исчезают из межколонника в overlay). Kill-switch
        // disableInkGeometry (LayoutSettings, вне дефолтов — хеш настроек
        // и кэши не трогаем) восстанавливает заявленные ширины.
        //
        // LAYOUT-FIX-9 (P2): пре-детекционная гигиена фида — числовые
        // суперскрипты (isDetectionPollutingRect) выбрасываются ДО клампа
        // и карты: они загрязняют строчную статистику и рвут записи TOC
        // (эмпирика try:p1 — та же болезнь, которую queue-фид носил всегда).
        // Остальные контентные правила — ПОСТ-детекция (ниже).
        const filterCtx = ls?.disableSpanFilterUnification === true
            ? null
            : buildRectFilterCtx(rects, 0, pageHeight);
        const preFeed = filterCtx
            ? rects.filter(r => !isDetectionPollutingRect(r, filterCtx))
            : rects;
        const feedRects: InputRect[] = ls?.disableInkGeometry === true
            ? preFeed
            : clampRightEdgesToNextStart(preFeed, {
                // LAYOUT-FIX-18a: re-seat justified-line drift tails (the
                // near-same-start overlap pair the width clamp refuses).
                // Same kill-switch family as disableInkGeometry; absent by
                // default → enabled, settings hash untouched.
                driftTailShift: ls?.disableWordDriftRepair !== true,
              });

        const map = buildOccupancyMap(feedRects, pageWidth, pageHeight, contourCellSize);
        // LAYOUT-FIX-5 (2026-09-16): preserveStyle: false — REVERSAL of the
        // Stage 2.1 (Q5) decision. Q5 set `true` so the pdfjs path would
        // match the DOM path, which "preserves bold/italic distinction via
        // g_d0_fN IDs". That rationale is dead on modern pdf.js: since 4.x
        // the textLayer sets only a GENERIC inline font-family on every
        // span (serif / sans-serif / monospace — from the font's fallback
        // name; verified empirically on pdfjs 4.10.38: 319/319 spans on a
        // real page resolve to "sans-serif", no g_d0_fN classes exist), so
        // the DOM path cannot distinguish style variants AT ALL. Meanwhile
        // `true` made STEP 7 (splitByFont) tear paragraphs at every
        // Regular↔Italic line boundary — the user's "oversplitting на
        // курсив тексте внутри абзаца" (book p.11: one Preface paragraph →
        // 5 units; hyphenated words like "evi-/dence" split mid-word across
        // units). `false` restores the ORIGINAL user spec ("bold, italic,
        // другой цвет — можно допускать как один стиль": OccupancyMap
        // getFontFamily strips the style suffix) and makes the pdfjs path
        // produce the SAME style-tolerant grouping the DOM path (generic
        // families) and the python mirror (classify_font → serif/sans) already
        // produce. Corpus A/B (36 pages, real font names via commonObjs):
        // 788 → 767 units, every eliminated boundary inspected — italic
        // mid-paragraph fragments, footnote Lt/LtIt alternations, footer
        // copyright pairs, sidebar label+value pairs; headings/tables/math
        // fonts untouched (different base family or size, or separate
        // islands); text multiset 1:1, F1 unchanged. Kill-switch: set back
        // to `true` to restore the Q5 behavior.
        // LAYOUT-FIX-10 (A2): cross-page column memory — the queue path is
        // the sequential multi-page consumer (batch translation walks the
        // file's pages in order), so it owns the per-document context.
        // Both production paths normalize coordinates to PDF pt (FIX-4 +
        // the FIX-9 ink channels), so the memory store is shared per file.
        // Kill-switch disableColumnMemory (LayoutSettings, outside the
        // defaults — the settings hash stays byte-identical) keeps the
        // context closed: no lookups, no observations.
        const memFileKey = fileKey && ls?.disableColumnMemory !== true ? fileKey : null;
        let paragraphs: any[];
        setColumnMemoryFile(memFileKey);
        try {
        paragraphs = buildParagraphs(map, feedRects, {
            // LAYOUT-FIX-10 (A1): production ink-channel flag — the feed's
            // right edges are ink-true (clamped or honestly declared), so
            // the whitespace-channel boundary refinement is legitimate.
            inkChannelFeed: ls?.disableInkGeometry !== true,
            indentThreshold: typeof ls?.contourIndentThreshold === 'number' ? ls.contourIndentThreshold : 5,
            fontSizeTolerance: typeof ls?.contourFontSizeTolerance === 'number' ? ls.contourFontSizeTolerance : 1,
            maxMergePasses: typeof ls?.maxMergePasses === 'number' ? ls.maxMergePasses
                : (typeof ls?.maxIterMerges === 'number' ? ls.maxIterMerges : 10),
            preserveStyle: false,
            // Stage 2.2 (Q6) + P2-2 (Phase 17): user-tunable column-gap and
            // decoration thresholds now flow from layoutSettings (same
            // defaults as layout-detector.ts uses for the DOM path).
            columnGapThreshold: typeof ls?.columnGapThreshold === 'number' ? ls.columnGapThreshold : 50,
            decorationThreshold: typeof ls?.decorationThreshold === 'number' ? ls.decorationThreshold : 0.7,
            // LAYOUT-FIX-8 (P1, 2026-09-17): pipeline kill-switches now flow
            // from LayoutSettings into buildParagraphs on the PRODUCTION
            // queue path too (previously they only worked in Node test
            // harnesses — Infra-1 of the layout bisect). Same programmatic
            // A/B surface as the DOM path (layout-detector.ts).
            disableColumnSlicing: ls?.disableColumnSlicing === true,
            disableFragmentAbsorption: ls?.disableFragmentAbsorption === true,
            disableFigureBandMerge: ls?.disableFigureBandMerge === true,
            disableStyleFlowGuard: ls?.disableStyleFlowGuard === true,
            disableTocRepair: ls?.disableTocRepair === true,
            disableNonAdjacentSplit: ls?.disableNonAdjacentSplit === true,
            // LAYOUT-FIX-10 (P1/A2): kill-switch — belt-and-suspenders with
            // the closed context above (double protection for A/B runs).
            disableColumnMemory: ls?.disableColumnMemory === true,
            // LAYOUT-FIX-13: STEP 9.6 kill-switch (torn-fragment re-attachment).
            disableFragmentReattach: ls?.disableFragmentReattach === true,
            // LAYOUT-FIX-16: post-loop caption subtraction kill-switch.
            disableCaptionSubtractLoop: ls?.disableCaptionSubtractLoop === true,
            disableWordDriftRepair: ls?.disableWordDriftRepair === true,
            // LAYOUT-FIX-22: STEP 6.9 single-line bridge kill-switch.
            disableSingleLineBridge: ls?.disableSingleLineBridge === true,
            // LAYOUT-FIX-23: STEP 9.65 caption chain assembly kill-switch.
            disableCaptionAssembly: ls?.disableCaptionAssembly === true,
            // LAYOUT-FIX-15: user layout preset (standard / paragraphs /
            // two-columns / separate) — resolved inside buildParagraphs.
            layoutPreset: ls?.layoutPreset,
            activeRegions: ls?.activeRegions,
            regionPageWidth: pageWidth,
            regionPageHeight: pageHeight,
        });
        } finally {
            setColumnMemoryFile(null);
        }
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Pipeline: ${rects.length} rects → ${paragraphs.length} paragraphs in ${Date.now() - t4}ms`);

        // LAYOUT-FIX-9 (P3): выход очереди несёт INK-края спанов (БЕЗ
        // реставрации заявленных — в отличие от DOM-пути, где матчинг
        // требует CSS-px координат). Это и есть пользовательское обещание
        // фазы 3: рамки-фантомы (заявленный край левой строки 342 при
        // чернилах 314, буллет «•» 96pt) исчезают из межколонника в
        // overlay. Текст юнитов не меняется (кламп трогает только right);
        // kill-switch disableInkGeometry возвращает заявленные края.
        // px-боксы юнитов — ink, семантика детекции (см. ink-geometry.ts).

        // LAYOUT-FIX-9 (P2, 2026-09-17): ЕДИНЫЙ пост-детекционный
        // контентный фильтр — тот же проход, что DOM-путь делает в
        // processing.ts после detectLayout (Infra-2 бисекта: очередь не
        // применяла ctx-фильтр вовсе, вход путей расходился 517 против 307
        // на try:p2). Снимает со юнитов не-контентные спаны (номера страниц
        // в колонтитуле, суперскрипт-остатки, одиночные «•-»«», http) и
        // выбрасывает опустевшие юниты; числовые ячейки таблиц и числа в
        // теле переживают фильтр (контракт TABLE-KEEP, shouldDropNumericSpan).
        // Kill-switch disableSpanFilterUnification возвращает поведение
        // v22 (без фильтра на очереди).
        const finalParagraphs: Paragraph[] = !filterCtx
            ? paragraphs
            : this.applyUnifiedSpanFilter(paragraphs, filterCtx);

        const normalized = finalParagraphs.map(p => this.normalizeParagraph(p, pageWidth, pageHeight, pageNum));
        const totalMs = Date.now() - t0;
        if (debug) console.debug(`${LOG_PREFIX} [p${pageNum}] Total: ${normalized.length} paragraphs in ${totalMs}ms`);
        return { paragraphs: normalized, pageWidth, pageHeight, pageNum, rotation: page.rotate || 0 };
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

        // Lazily load pdfjs-dist on first use (async — literal dynamic import
        // of the bundled module; no network, no <script> tag).
        const pdfjsLib = await this.ensurePdfjs();

        const loadingTask = pdfjsLib.getDocument({
            data,
            isEvalSupported: false,
            useSystemFonts: false,
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
        let sourceRun = 0;
        let previousItem: any = null;

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
            const tm = item.transform;
            const advance = Math.hypot(tm[0], tm[1]) || 1;
            const rise = Math.hypot(tm[2], tm[3]) || 1;
            const dx = tm[0] / advance, dy = tm[1] / advance;
            const ux = tm[2] / rise, uy = tm[3] / rise;
            const points = [[x, yBase], [x + dx * w, yBase + dy * w],
                [x + ux * h, yBase + uy * h],
                [x + dx * w + ux * h, yBase + dy * w + uy * h]]
                .map(([px, py]) => viewport.convertToViewportPoint(px, py));
            const baseline = viewport.convertToViewportPoint(x + dx, yBase + dy);
            const textAngle = Math.atan2(baseline[1] - points[0][1], baseline[0] - points[0][0]);

            if (!previousItem || previousItem.hasEOL
                || Math.abs(previousItem.transform[5] - yBase) > 0.5
                || x < previousItem.transform[4] - 1
                || x - (previousItem.transform[4] + previousItem.width) > h * 2) sourceRun++;
            previousItem = item;
            rects.push({
                left: Math.min(...points.map(p => p[0])),
                top: Math.min(...points.map(p => p[1])),
                right: Math.max(...points.map(p => p[0])),
                bottom: Math.max(...points.map(p => p[1])),
                textAngle,
                textQuad: points,
                sourceRun,
                fontname: resolvedFont,
                fontsize: h,
                text: item.str,
            });
        }
        return rects;
    }

    /**
     * LAYOUT-FIX-9 (P2): пост-детекционный контентный фильтр очереди.
     *
     * ЕДИНЫЙ проход по спанам юнитов после buildParagraphs — зеркало
     * того, что DOM-путь (processing.ts) делает с result.paragraphs.
     * Контекст (медиана кегля + полосы колонтитула) строится из ректов
     * фида (buildRectFilterCtx, table-keep.ts), правила — общие
     * (isDroppableContentRect): чистые числа гибнут только как номер
     * страницы (колонтитул) или суперскрипт-индекс; числовые ЯЧЕЙКИ
     * таблиц и числа в теле выживают (контракт TABLE-KEEP); одиночные
     * маркеры [•-»«] и http-префиксы гибнут. Опустевшие юниты
     * выбрасываются; бокс юнита пересчитывается по оставшимся спанам.
     *
     * LAYOUT-FIX-22 (F26-a): одиночный дефис получает контекст соседей
     * по базовой линии (та же группировка Math.round(bottom), что и
     * Tm-clamp) — приклеенный дефис (внутрисловный/перенос/приставка)
     * переживает фильтр (isIntraWordHyphen, table-keep.ts). Соседи
     * считаются по спанам юнита ДО фильтра; «-» без приклеенной
     * сигнатуры (маркер списка) по-прежнему выбрасывается.
     */
    private applyUnifiedSpanFilter(paragraphs: Paragraph[], ctx: ReturnType<typeof buildRectFilterCtx>): Paragraph[] {
        const kept: Paragraph[] = [];
        for (const p of paragraphs) {
            const spans = p.spans || [];
            if (spans.length === 0) continue;
            // LAYOUT-FIX-22 (F26-a): соседей считаем один раз на юнит —
            // строки по точному baseline, внутри строки сортировка по left.
            const hyphenCtx = buildHyphenNeighborCtx(spans as InputRect[]);
            const surviving = spans.filter(s => !isDroppableContentRect(
                s, ctx, hyphenCtx.get(s) ?? null));
            if (surviving.length === 0) continue;
            if (surviving.length === spans.length) { kept.push(p); continue; }
            p.spans = surviving;
            // Пересобрать бокс юнита по оставшимся спанам (makeParagraph-эквивалент).
            p.pxLeft = Math.min(...surviving.map(s => s.left));
            p.pxRight = Math.max(...surviving.map(s => s.right));
            p.pxTop = Math.min(...surviving.map(s => s.top));
            p.pxBottom = Math.max(...surviving.map(s => s.bottom));
            p.width = p.pxRight - p.pxLeft;
            p.height = p.pxBottom - p.pxTop;
            kept.push(p);
        }
        return kept;
    }

    /**
     * Normalize a Paragraph (pixel-space, spans reference InputRects) into
     * the page-relative transport format consumed by the queue.
     *
     * TABLE-KEEP (2026-09-15): текст собирается ПОСТРОЧНО — спаны
     * кластеризуются в строки по y-перекрытию; абзац из коротких
     * item-строк (все <= TABLE_KEEP_MAX_WORDS_PER_ROW слов, >= 2 строк —
     * «подозрение таблицы») получает <br> между строками, чтобы таблица
     * рендерилась построчно. Проза — прежнее поведение байт-в-байт:
     * все спаны склеены одним пробелом.
     */
    private normalizeParagraph(p: Paragraph, pageWidth: number, pageHeight: number, pageNum: number): NormalizedParagraph {
        // TABLE-KEEP: двухфазный выбор пути.
        // Фаза 1 — «подозрение таблицы»: кластеризация спанов в строки по
        // y-перекрытию (>= 35% меньшей высоты; порядок спанов — исходный,
        // булево суждение от порядка внутри строки не зависит).
        // Фаза 2 — таблица: строки по y0, спаны внутри строки по left
        // (визуальный порядок ячеек), строки через <br>.
        // Проза: ЛЕГАСИ-склейка всех спанов в ИСХОДНОМ порядке join(' ') —
        // байт-в-байт прежнее поведение (контракт table-keep: существующие
        // алгоритмы не затронуты; суперскрипты остаются в порядке pdfjs,
        // как раньше).
        const displayRects = new Map<InputRect, InputRect>();
        const rowGroups: { spans: InputRect[]; y0: number; y1: number }[] = [];
        for (const original of p.spans) {
            const s = original.readingBox ? { ...original, ...original.readingBox } : original;
            displayRects.set(s, original);
            const h = s.bottom - s.top;
            if (!(h > 0)) continue;
            let best: (typeof rowGroups)[0] | null = null;
            let bestFrac = 0;
            for (const row of rowGroups) {
                const ov = Math.min(row.y1, s.bottom) - Math.max(row.y0, s.top);
                if (ov <= 0) continue;
                const frac = ov / Math.min(row.y1 - row.y0, h);
                if (frac > bestFrac) { bestFrac = frac; best = row; }
            }
            if (best && bestFrac >= 0.35) {
                best.spans.push(s);
                best.y0 = Math.min(best.y0, s.top);
                best.y1 = Math.max(best.y1, s.bottom);
            } else {
                rowGroups.push({ spans: [s], y0: s.top, y1: s.bottom });
            }
        }
        // LAYOUT-FIX-13 (span order, user report «проверь порядок spans»):
        // текст собирается в визуальном порядке (Fix D), но массив spans и
        // originalFontSizes (→ ofs в .translations.md) прежде шли в ИСХОДНОМ
        // порядке массива спанов — на юнитах, чей порядок был сломан
        // (поглощённые 8.7 фрагменты, кросс-колоночные слияния), ofs
        // описывал ДРУГИЕ спаны, чем читал ot (книжная стр. 61: ot начинался
        // с 9.03-строки левой колонки при ofs[0] = 8.02). Теперь всё трое —
        // text, spans, originalFontSizes — идут в одном визуальном порядке;
        // для неполоманных юнитов визуальный порядок == исходному, вывод
        // байт-в-байт прежний.
        const ordered: InputRect[] = rowGroups
            .slice().sort((a, b) => a.y0 - b.y0)
            .flatMap(row => row.spans.slice().sort((a, b) => a.left - b.left));
        const spans: NormalizedSpan[] = ordered.map(local => {
          const s = displayRects.get(local) || local;
          return ({
            left: s.left / pageWidth,
            top: s.top / pageHeight,
            right: s.right / pageWidth,
            bottom: s.bottom / pageHeight,
            fontname: s.fontname || 'unknown',
            fontsize: typeof s.fontsize === 'number' ? s.fontsize : 0,
            text: typeof s.text === 'string' ? s.text : '',
          });
        });
        // Проба: строки в порядке обнаружения — только чтобы решить,
        // таблица это или проза (решение зависит от числа слов в строке,
        // не от порядка). Спаны сортируются по left, чтобы gap-aware
        // склейка (rowTextFromSpans, LAYOUT-FIX-22/F26-b) видела
        // ПРОСТРАНСТВЕННО соседние пары, а не соседние по индексу.
        const probeTexts = rowGroups
            .map(row => rowTextFromSpans(
                row.spans.slice().sort((a, b) => a.left - b.left)).trim())
            .filter(t => t);
        let text: string;
        if (isTableLikeRowTexts(probeTexts)) {
            // Таблица: визуальный порядок — строки по y0, ячейки по left.
            const rowTexts = rowGroups
                .slice().sort((a, b) => a.y0 - b.y0)
                .map(row => rowTextFromSpans(
                    row.spans.slice().sort((a, b) => a.left - b.left)).trim())
                .filter(t => t);
            text = rowsToUnitText(rowTexts);
        } else {
            // Проза: LAYOUT-FIX-11 — ВИЗУАЛЬНЫЙ порядок (строки по y0,
            // спаны внутри строки по left). Прежняя легаси-склейка в
            // ИСХОДНОМ порядке массива спанов ставила поглощённые STEP 8.7
            // фрагменты ХВОСТОМ юнита («…gene expression. into oncogenes
            // following» — слова середины абзаца в конце, try3:p3 u05):
            // absorbContainedFragments делает push(...) в конец массива.
            // Для фидов в порядке контент-потока (все неполоманные юниты)
            // визуальный порядок == исходному — текст байт-в-байт тот же;
            // меняются только юниты, чей порядок УЖЕ был сломан.
            //
            // LAYOUT-FIX-22 (F26-b): склейка внутри строки — gap-aware
            // (rowTextFromSpans): суб-словесные стыки продюсера сшиваются
            // без пробела («tum or»→«tumor», «% ,»→«%,», «656 – 663»→
            // «656–663», F7 «Fundamentals o f c ancer»→«Fundamentals of
            // cancer»). Межстрочные стыки — всегда пробел (как прежде);
            // для пар без суб-словесной сигнатуры вывод байт-в-байт прежний.
            const proseRows = rowGroups
                .slice().sort((a, b) => a.y0 - b.y0)
                .map(row => rowTextFromSpans(
                    row.spans.slice().sort((a, b) => a.left - b.left)));
            text = proseRows.join(' ');
        }

        return {
            relativeRect: {
                left: p.pxLeft / pageWidth,
                top: p.pxTop / pageHeight,
                width: (p.pxRight - p.pxLeft) / pageWidth,
                height: (p.pxBottom - p.pxTop) / pageHeight,
            },
            page: pageNum,
            ...(p.tableId ? {tableId:p.tableId,tableRow:p.tableRow,tableColumn:p.tableColumn} : {}),
            text,
            fontSize: p.dominantSize,
            fontFamily: p.dominantFamily,
            originalFontSizes: [...new Set(
                ordered.map(s => s.fontsize).filter((v): v is number => typeof v === 'number')
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
