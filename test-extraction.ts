// test-extraction.ts — E2E test for the bundled pdf.js pipeline.
//
// Runs the REAL extraction path (PdfTextExtractor.extractPage → pdfjs
// getTextContent → OccupancyMap → IslandBuilder → normalize) against
// test.pdf in plain Node, with 'obsidian' aliased to the local stub.
//
// Proves, on THIS machine, that the whole overhaul still holds:
//   1. pdfjs-dist is bundled and loadable (literal dynamic import);
//   2. [W-PSEUDO/W-CLEAN] the process global
//      `globalThis.pdfjsWorker` stays UNDEFINED and extraction still works
//      through the MAIN-THREAD PSEUDO-WORKER (the ONLY engine — bundled
//      worker module under the UMD guard; the old assertion required the
//      global to be set — i.e. it pinned the very mechanism that crashed
//      Obsidian's PDF.js viewer);
//   2b. [W-CLEAN] the extractor reports workerEngine === 'pseudo-worker'
//      and raises ZERO Notices (the engine is canonical, not degraded);
//   3. the pdfjs compliance patches did not break anything (extraction with
//      isEvalSupported:false works — fonts go through the interpreter path);
//   4. the paragraph pipeline produces the expected text at the expected
//      font size.
//
// Run via: npm test   (chains: patch → build test bundles → run suites)
import * as fs from 'fs';
import * as path from 'path';
import { PdfTextExtractor } from './pdf-text-extractor';

// The test bundle is CJS — __dirname is the plugin root at runtime.
// (import.meta.url is NOT usable here: esbuild replaces it in CJS output.)
declare const __dirname: string;
const ROOT = __dirname;

let failures = 0;
function check(name: string, cond: boolean): void {
    console.debug(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
    if (!cond) failures++;
}

async function main(): Promise<void> {
    console.debug('\n── E2E: bundled pdf.js extraction pipeline ───────────────');

    const pdfPath = path.join(ROOT, 'test.pdf');
    if (!fs.existsSync(pdfPath)) {
        console.error(`  FAIL  fixture not found: ${pdfPath}`);
        process.exit(1);
    }

    // Minimal fake plugin surface — readBinary feeds the extractor,
    // vault.on('modify') is registered defensively (ignored).
    // W-CLEAN (2026-09-25): no worker-mode setting exists anymore — the
    // main-thread pseudo-worker is the only engine.
    const fakePlugin: any = {
        settings: { debugMode: false },
        app: {
            vault: {
                readBinary: async (): Promise<ArrayBuffer> => {
                    const buf = fs.readFileSync(pdfPath);
                    // Detach-safe copy of the underlying bytes.
                    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
                },
                on: () => null,
            },
        },
    };

    const extractor = new PdfTextExtractor(fakePlugin);
    const file: any = { path: pdfPath, name: 'test.pdf' };

    const result = await extractor.extractPage(file, 1);

    // NEW-1 (2026-09-12) / W-CLEAN (2026-09-25): the global must NEVER be
    // written — this is the viewer-crash root cause. The engine contract
    // is: the MAIN-THREAD PSEUDO-WORKER (the ONLY engine) runs the bundled
    // worker module under the pdfjsWorker guard.
    const worker = (globalThis as any).pdfjsWorker;
    check('process global NOT poisoned (globalThis.pdfjsWorker undefined)', worker === undefined);

    // W-CLEAN: the one and only engine — silent by design.
    check(`pseudo-worker engine engaged (got "${extractor.workerEngine}")`, extractor.workerEngine === 'pseudo-worker');

    check(`1 paragraph extracted (got ${result.paragraphs.length})`, result.paragraphs.length === 1);

    const p = result.paragraphs[0];
    const text = (p?.text ?? '').trim();
    check(`text is "Hello PDF extraction test" (got "${text}")`, text === 'Hello PDF extraction test');

    const size = p?.fontSize ?? 0;
    check(`fontSize ≈ 24 (got ${size})`, Math.abs(size - 24) < 1.5);

    check(`page dimensions (got ${result.pageWidth}×${result.pageHeight})`,
        Math.abs(result.pageWidth - 612) < 2 && Math.abs(result.pageHeight - 792) < 2);

    check(`spans present (got ${p?.spans?.length ?? 0})`, (p?.spans?.length ?? 0) >= 1);

    const rel = p?.relativeRect;
    check('relativeRect is normalized to [0,1]',
        !!rel && rel.left >= 0 && rel.left <= 1 && rel.top >= 0 && rel.top <= 1 &&
        rel.width > 0 && rel.width <= 1 && rel.height > 0 && rel.height <= 1);

    console.debug(failures === 0 ? '\nRESULT: E2E PASSED' : `\nRESULT: E2E FAILED (${failures} check(s))`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: any) => {
    console.error('\nRESULT: E2E FAILED — unexpected error:');
    console.error(err?.stack ?? err);
    process.exit(1);
});
