// test-runtime-fixes.ts — regression tests for the two 2026-09 runtime fixes.
//
//   FIX 1 (stale-cancel): TextProcessor.executeTranslation must survive a
//   sticky PdfLayoutQueue `cancelled` flag left over from a previous
//   cancelled session. Symptom it guards against:
//     "[PDF Translator] Translation failed: Error: cancelled"
//   …followed by untranslated overlays rendered as if translation succeeded.
//
//   FIX 2 (atomic write): StorageLayer.atomicWrite with an EXISTING target
//   must use vault.modify directly. Obsidian's vault.rename refuses to
//   overwrite ("Destination file already exists!"), so the old code logged
//   "Atomic write failed, falling back to direct write" on every save.
//
//   Both scenarios are driven with fake plugin/vault surfaces — no Obsidian,
//   no LLM endpoint, no real files.
import { TFile } from 'obsidian';
import { PdfLayoutQueue } from './pdf-layout-queue';
import { TextProcessor } from './processing';
import { TranslationStorage } from './storage';

let failures = 0;
function check(name: string, cond: boolean): void {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
    if (!cond) failures++;
}

function makeUnits(): any[] {
    return [
        { text: 'ORIGINAL-A ' + 'x'.repeat(1500) },
        { text: 'ORIGINAL-B ' + 'x'.repeat(1500) },
        { text: 'ORIGINAL-C ' + 'x'.repeat(1500) },
    ];
}

async function testStaleCancel(): Promise<void> {
    console.log('\n── FIX 1: stale queue cancel flag ─────────────────────────');

    const fakePlugin: any = {
        settings: {
            debugMode: false,
            paragraphFilterRules: [],
            useBatchTranslation: true,
            maxBatchChars: 4000,   // 3 units × ~1520 chars → 2 chunks
            sequentialDelayMs: 0,
        },
        layoutSettings: {},
        app: { vault: {} },
        logDebug: () => {},
        markSelfWrite: () => {},
        pdfLayoutQueue: null,
        translation: {
            translateBatch: async (_text: string, count: number) =>
                Array.from({ length: count }, (_, i) => `[#${i + 1}] TRANSLATED-${i + 1}`).join('\n'),
        },
    };

    const queue = new PdfLayoutQueue(fakePlugin, {} as any);
    fakePlugin.pdfLayoutQueue = queue;
    const tp = new TextProcessor(fakePlugin);

    // Scenario 1 — the user's bug: stale flag from a previous cancelled
    // session (modal Cancel / watcher stop), queue idle, new interactive
    // translation must NOT abort.
    queue.cancel();
    check('S1 setup: cancelled=true, idle', queue.isCancelled() === true && queue.isRunning() === false);

    const result = await tp.executeTranslation(makeUnits());
    check('S1: 3 results returned', result.length === 3);
    check('S1: results are translations (not fallback originals)',
        result.every(r => r.startsWith('TRANSLATED-')));
    check('S1: stale flag cleared by pre-flight resume', queue.isCancelled() === false);

    // Scenario 2 — mid-run Cancel still works: cancelling DURING translation
    // (chunk 1) must abort chunk 2 and fall back to originals.
    const queue2 = new PdfLayoutQueue(fakePlugin, {} as any);
    fakePlugin.pdfLayoutQueue = queue2;
    let firstChunk = true;
    fakePlugin.translation.translateBatch = async (_text: string, count: number) => {
        if (firstChunk) { queue2.cancel(); firstChunk = false; }
        return Array.from({ length: count }, (_, i) => `[#${i + 1}] TRANSLATED-${i + 1}`).join('\n');
    };
    const result2 = await tp.executeTranslation(makeUnits());
    check('S2: mid-run cancel aborts → fallback to originals',
        result2.length === 3 && result2.every(r => r.startsWith('ORIGINAL-')));

    // Scenario 3 — plugin.pdfLayoutQueue absent (?. short-circuit path).
    fakePlugin.pdfLayoutQueue = undefined;
    fakePlugin.translation.translateBatch = async (_t: string, n: number) =>
        Array.from({ length: n }, (_, i) => `[#${i + 1}] T-${i + 1}`).join('\n');
    const result3 = await tp.executeTranslation(makeUnits());
    check('S3: no-queue path works', result3[0] === 'T-1');
}

async function testAtomicWrite(): Promise<void> {
    console.log('\n── FIX 2: atomicWrite case split ──────────────────────────');

    const calls: string[] = [];
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warns.push(args.map(String).join(' ')); };

    try {
        const files = new Map<string, TFile>();
        const fakeVault: any = {
            getAbstractFileByPath: (p: string) => files.get(p) ?? null,
            create: async (p: string, _c: string) => {
                calls.push(`create ${p}`);
                const f = new TFile(p);
                files.set(p, f);
                return f;
            },
            rename: async (f: any, np: string) => {
                calls.push(`rename ->${np}`);
                if (files.has(np)) throw new Error('Destination file already exists!'); // real Obsidian behaviour
                files.delete(f.path);
                files.set(np, f);
                f.path = np;
            },
            modify: async (f: any, _c: string) => { calls.push(`modify ${f.path}`); },
            delete: async (f: any) => { calls.push(`delete ${f.path}`); files.delete(f.path); },
        };
        const plugin: any = {
            settings: {},
            app: { vault: fakeVault },
            markSelfWrite: () => {},
        };
        const storage = new TranslationStorage(plugin);
        const atomicWrite = (storage as any).atomicWrite.bind(storage);

        // Existing destination → straight vault.modify, no temp, no doomed
        // rename, no console warning.
        const existing = new TFile('doc.translations.md');
        files.set('doc.translations.md', existing);
        calls.length = 0;
        await atomicWrite(existing, 'doc.translations.md', 'updated');
        check('AW1: direct modify for existing file',
            calls.length === 1 && calls[0] === 'modify doc.translations.md');
        check('AW1: no temp/rename churn',
            !calls.some(c => c.startsWith('create ') || c.startsWith('rename ')));
        check('AW1: no "Atomic write failed" warning', warns.length === 0);

        // New destination → temp + rename (genuinely atomic creation).
        calls.length = 0;
        await atomicWrite(null, 'new-doc.translations.md', 'fresh');
        check('AW2: temp created, then renamed onto free destination',
            calls.length === 2 &&
            calls[0] === 'create new-doc.translations.md.tmp' &&
            calls[1] === 'rename ->new-doc.translations.md');
        check('AW2: no warning on the atomic path', warns.length === 0);
    } finally {
        console.warn = origWarn;
    }
}

async function main(): Promise<void> {
    console.log('── runtime-fixes regression tests (Electron-renderer simulation) ──');
    await testStaleCancel();
    await testAtomicWrite();
    console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
    if (failures > 0) process.exit(1);
}

main().catch((e: any) => {
    console.error('TEST ERROR:', e?.stack || e);
    process.exit(1);
});
