import { Notice, Platform, TFile, FileSystemAdapter, normalizePath } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One translated region sent to the Python overlay script. */
interface ExportOverlay {
    text: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fontFamily: string;
    /** Original font sizes observed in the source block (index 0 is used). */
    fontSize: number[];
    color: string;
    /** When true, x/y/width/height are in the range [0, 1] relative to page size. */
    isNormalized: boolean;
}

export interface ExportOptions {
    preserveOriginalText?: boolean;
    backgroundColor?: string;
    backgroundOpacity?: number;
    textColor?: string;
    autoOpen?: boolean;
    outputFileName?: string;
    pages?: number[];
}

// ---------------------------------------------------------------------------
// HTML → plain text (runs in the renderer process, no Node needed)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a string and convert block / line-break elements into
 * plain-text newlines.  Handles `<br>`, `<p>`, `<div>`, `<li>`, headings,
 * `&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, and numeric character refs.
 *
 * Uses the browser's own DOMParser so no third-party library is required and
 * entity decoding is automatic.
 */
function htmlToPlainText(html: string): string {
    // Fast path: no tags present
    if (!html.includes('<')) return html;

    // Inject newlines before block-level elements so they survive innerText
    // normalisation.  We do this with simple string replacements to avoid
    // having to walk the DOM.
    const BLOCK_RE = /<\/?(p|div|li|tr|h[1-6]|br)\b[^>]*>/gi;
    const withNewlines = html.replace(BLOCK_RE, (match) => {
        // Self-closing br or opening block → newline before, closing block → newline after
        return '\n' + match;
    });

    // Use DOMParser for correct entity decoding and tag removal
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(withNewlines, 'text/html');
        // innerText respects white-space better than textContent
        const text = (doc.body as HTMLElement).innerText ?? doc.body.textContent ?? '';
        // Collapse 3+ consecutive newlines → 2 and trim
        return text.replace(/\n{3,}/g, '\n\n').trim();
    } catch {
        // Fallback: naive tag-strip regex (should never be reached in modern browsers)
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PdfExportService {
    private plugin:     OpenRouterTranslatorPlugin;
    private scriptPath: string | null = null;
    private isDesktop:  boolean;

    // Lazily loaded Node.js / Electron modules
    private spawn: any = null;
    private path:  any = null;
    private fs:    any = null;
    private os:    any = null;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin    = plugin;
        this.isDesktop = Platform.isDesktop;

        if (this.isDesktop) {
            this.initDesktopModules();
        }
    }

    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    private initDesktopModules(): void {
        try {
            const nodeRequire = (window as any).require;
            if (!nodeRequire) {
                console.error('[PDF Export] window.require unavailable — Electron context missing?');
                this.isDesktop = false;
                return;
            }

            const cp   = nodeRequire('child_process');
            this.spawn = cp.spawn;
            this.path  = nodeRequire('path');
            this.fs    = nodeRequire('fs');
            this.os    = nodeRequire('os');

            const basePath  = this.getVaultBasePath();
            const pluginDir = this.plugin.manifest.dir ?? '';

            if (basePath) {
                this.scriptPath = this.path.join(basePath, pluginDir, 'pdf_export.py');
            } else {
                console.error('[PDF Export] Could not determine vault base path.');
                this.isDesktop = false;
            }
        } catch (err) {
            console.error('[PDF Export] Failed to load Node.js modules:', err);
            this.isDesktop = false;
        }
    }

    private getVaultBasePath(): string | null {
        const adapter = this.plugin.app.vault.adapter;
        return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    }

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------

    async exportFullPdf(): Promise<void> {
        if (!this.isDesktop) {
            new Notice('❌ PDF Export is only available on desktop.');
            return;
        }
        if (!this.spawn || !this.scriptPath) {
            new Notice('❌ PDF Export failed to initialise — check the console.');
            return;
        }

        try {
            // ── Validate active file ──────────────────────────────────────
            const file = this.plugin.app.workspace.getActiveFile();
            if (!file || file.extension !== 'pdf') {
                new Notice('❌ Please open a PDF file first.');
                return;
            }

            // ── Locate the linked translation Markdown file ───────────────
            const mdPath = this.plugin.pdfToMdMap.get(file.path);
            if (!mdPath) {
                new Notice('❌ No linked translation file found for this PDF.');
                return;
            }
            const mdFile = this.plugin.app.vault.getAbstractFileByPath(mdPath);
            if (!(mdFile instanceof TFile)) {
                new Notice(`❌ Translation file missing: ${mdPath}`);
                return;
            }

            // ── Parse overlays ────────────────────────────────────────────
            new Notice('⏳ Parsing translations…');
            const overlays      = await this.parseMarkdownStructure(mdFile);
            const totalOverlays = Object.values(overlays).reduce((n, a) => n + a.length, 0);

            if (totalOverlays === 0) {
                new Notice('❌ No translation blocks found in the linked file.');
                return;
            }

            // ── Build paths ───────────────────────────────────────────────
            const basePath = this.getVaultBasePath();
            if (!basePath) throw new Error('Vault base path not found.');

            const sourceAbsPath  = this.path.join(basePath, file.path);
            const outputFileName = `${file.basename}-translated.pdf`;
            const parentPath     = file.parent?.path ?? '';
            const outputRelPath  = normalizePath(`${parentPath}/${outputFileName}`);
            const outputAbsPath  = this.path.join(basePath, outputRelPath);

            // ── Run Python ────────────────────────────────────────────────
            new Notice(`🚀 Exporting ${totalOverlays} translation(s) to PDF…`);
            await this.executePythonExport(sourceAbsPath, outputAbsPath, overlays);

            // ── Wait for the file to appear in Obsidian's cache ───────────
            const appeared = await this.waitForFile(outputRelPath, 3000, 300);

            if (appeared) {
                new Notice(`✅ Export saved:\n${outputFileName}`, 6000);
                const exportedFile = this.plugin.app.vault.getAbstractFileByPath(outputRelPath);
                if (exportedFile instanceof TFile) {
                    this.plugin.app.workspace.getLeaf('tab').openFile(exportedFile);
                } else {
                    new Notice('File created — browse to it in the file explorer.');
                }
            } else {
                throw new Error('Python script exited cleanly but the output file was not found on disk.');
            }
        } catch (err: any) {
            console.error('[PDF Export]', err);
            new Notice(`❌ Export failed: ${err?.message ?? err}`);
        }
    }

    // -----------------------------------------------------------------------
    // Markdown parsing
    // -----------------------------------------------------------------------

    /**
     * T5.2: THE canonical storage parser is now the single reader of
     * `.translations.md`. The previous hand-rolled walker diverged from
     * storage.ts in three ways (multi-line translation joining, `<!-- empty -->`
     * handling, html stripping) — a file that rendered perfectly could
     * export differently from what the overlay showed.
     */
    private async parseMarkdownStructure(
        file: TFile,
    ): Promise<Record<string, ExportOverlay[]>> {
        const pdfFile = this.plugin.app.workspace.getActiveFile();
        const content = await this.plugin.app.vault.read(file);
        const saved = this.plugin.storage.parseMarkdownOverlay(
            content,
            (pdfFile && pdfFile.extension === 'pdf') ? pdfFile : file,
        );
        const exportData: Record<string, ExportOverlay[]> = {};
        if (!saved) return exportData;

        for (const [pageKey, items] of Object.entries(saved.pageOverlays)) {
            for (const item of items) {
                const text = htmlToPlainText(item.translatedText || '');
                if (!text) continue;
                const region = item.relativeRect;
                if (!exportData[pageKey]) exportData[pageKey] = [];
                exportData[pageKey].push({
                    text,
                    page: item.page,
                    x: region.left,
                    y: region.top,
                    width: region.width,
                    height: region.height,
                    fontFamily: this.normalizeFontFamily(item.fontFamily),
                    fontSize: Array.isArray(item.originalFontSizes) && item.originalFontSizes.length > 0
                        ? item.originalFontSizes
                        : [item.fontSize ?? 10],
                    color: '#000000',
                    isNormalized: true,
                });
            }
        }
        return exportData;
    }

    private normalizeFontFamily(ff?: string): string {
        if (!ff) return 'helvetica';
        const lower = ff.toLowerCase();
        if (lower.includes('mono') || lower.includes('courier')) return 'courier';
        if (lower.includes('serif') && !lower.includes('sans'))   return 'times';
        return 'helvetica';
    }

    // -----------------------------------------------------------------------
    // Python execution
    // -----------------------------------------------------------------------

    private async executePythonExport(
        sourceAbs: string,
        destAbs:   string,
        data:      Record<string, ExportOverlay[]>,
    ): Promise<void> {
        if (!this.spawn || !this.path || !this.fs || !this.os) {
            throw new Error('Node.js modules not initialised.');
        }

        return new Promise<void>((resolve, reject) => {
            const pythonCmd = this.plugin.settings.pythonPath
                || (Platform.isWin ? 'python' : 'python3');

            // Write overlay data to a temp file with explicit UTF-8 encoding
            const tempFile = this.path.join(
                this.os.tmpdir(),
                `obsidian-pdf-export-${Date.now()}.json`,
            );

            try {
                this.fs.writeFileSync(tempFile, JSON.stringify(data), { encoding: 'utf-8' });
            } catch (err: any) {
                return reject(new Error(`Failed to write temp JSON: ${err.message}`));
            }

            console.log(`[PDF Export] Spawning: ${pythonCmd} "${this.scriptPath}"`);

            // Phase 4 (C1): `process.env` is a Node-only global — on non-
            // desktop / sandboxed renderer contexts it may be undefined.
            // We are already inside `exportFullPdf()` which is gated by
            // `this.isDesktop` (Platform.isDesktop), so spawning itself is
            // safe; we just need to access env safely. Use the Electron
            // `window.process` proxy when available, otherwise spawn with
            // an empty env (Python will still inherit a minimal env from
            // the Electron main process in practice).
            const spawnEnv = Platform.isDesktop
                ? { env: { ...(((window as any).process?.env) || {}) } }
                : {};

            const child = this.spawn(
                pythonCmd,
                [this.scriptPath, sourceAbs, destAbs, tempFile],
                spawnEnv,   // copy env so PATH is inherited (desktop only)
            );

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk: any) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk: any) => { stderr += chunk.toString(); });

            child.on('close', (code: number) => {
                this.tryDeleteTemp(tempFile);

                if (stdout) console.log('[PDF Export] stdout:\n' + stdout);
                if (stderr) console.warn('[PDF Export] stderr:\n' + stderr);

                if (code === 0) {
                    resolve();
                } else {
                    const msg = this.extractPythonError(stderr) || `Exit code ${code}`;
                    reject(new Error(msg));
                }
            });

            child.on('error', (err: any) => {
                this.tryDeleteTemp(tempFile);
                reject(new Error(
                    `Could not start Python ("${pythonCmd}"): ${err.message}. ` +
                    'Check the Python Path setting.',
                ));
            });
        });
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Poll for a vault file to appear, up to ``timeoutMs`` milliseconds,
     * checking every ``intervalMs`` milliseconds.
     */
    private async waitForFile(
        relPath:    string,
        timeoutMs:  number,
        intervalMs: number,
    ): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, intervalMs));
            if (await this.plugin.app.vault.adapter.exists(relPath)) {
                return true;
            }
        }
        return false;
    }

    /** Extract the most informative line from a Python traceback. */
    private extractPythonError(log: string): string {
        const lines = log.split('\n').map(l => l.trim()).filter(Boolean);
        // Walk backwards; prefer lines with "Error:" or "Exception:"
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].match(/Error:|Exception:/)) return lines[i];
        }
        // Fallback: last non-empty line
        return lines[lines.length - 1] ?? 'Unknown Python error — check the console.';
    }

    private tryDeleteTemp(filePath: string): void {
        try {
            if (this.fs?.existsSync(filePath)) this.fs.unlinkSync(filePath);
        } catch { /* best-effort */ }
    }
}
