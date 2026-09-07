// test-extraction.ts — E2E test for the bundled pdf.js pipeline.
//
// Runs the REAL extraction path (PdfTextExtractor.extractPage → pdfjs
// getTextContent → OccupancyMap → IslandBuilder → normalize) against
// test.pdf in plain Node, with 'obsidian' aliased to the local stub.
//
// Proves, on THIS machine, that the whole overhaul still holds:
//   1. pdfjs-dist is bundled and loadable (literal dynamic import);
//   2. the bundled worker is registered (globalThis.pdfjsWorker, PATH A —
//      no network, no <script> tag);
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
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
    if (!cond) failures++;
}

async function main(): Promise<void> {
    console.log('\n── E2E: bundled pdf.js extraction pipeline ───────────────');

    const pdfPath = path.join(ROOT, 'test.pdf');
    if (!fs.existsSync(pdfPath)) {
        console.error(`  FAIL  fixture not found: ${pdfPath}`);
        process.exit(1);
    }

    // Minimal fake plugin surface — readBinary feeds the extractor,
    // vault.on('modify') is registered defensively (ignored).
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

    const worker = (globalThis as any).pdfjsWorker;
    check('bundled worker registered (globalThis.pdfjsWorker)', !!worker?.WorkerMessageHandler);

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

    console.log(failures === 0 ? '\nRESULT: E2E PASSED' : `\nRESULT: E2E FAILED (${failures} check(s))`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: any) => {
    console.error('\nRESULT: E2E FAILED — unexpected error:');
    console.error(err?.stack ?? err);
    process.exit(1);
});
