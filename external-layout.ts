import { isManualMode, rulesForPage } from './region-layout';
import { computeLayoutSettingsHash } from './overlay-id';
// external-layout.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 4 (C1) correction: the previous version imported `spawn` from
// 'child_process' at the top of the module. That is a static CommonJS
// import which will crash the plugin on Obsidian Mobile (and any non-
// desktop Electron build) because `child_process` is undefined outside
// of Node/Electron. We now:
//   1. Import `Platform` from 'obsidian' (Notice was already imported).
//   2. Guard the whole `generateLayout` call site with `Platform.isDesktop`.
//   3. Lazily obtain `spawn` via `(window as any).require('child_process')`
//      at call time — same pattern used by `pdf-export.ts` for its Node
//      modules. This keeps the module load-safe on mobile.
// ─────────────────────────────────────────────────────────────────────────

import { Notice, Platform, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { makeAbortError } from './job-token';

export interface ExternalLayoutItem {
  id: string;
  text: string;
  rect: { l: number; t: number; w: number; h: number };
  fontFamily: string;
  fontSize: number;
  originalFontSizes: number[];
}

// Map: Page Number ("1") -> Array of items
export type ExternalPageLayout = Record<string, ExternalLayoutItem[]>;

export class ExternalLayoutService {
  private plugin: OpenRouterTranslatorPlugin;
  // Cache: PDF File Path -> Layout Data
  private layoutCache: Map<string, ExternalPageLayout> = new Map();
  private cacheRevisions = new Map<string, string>();
  private cacheRevision(file: string): string {
    return computeLayoutSettingsHash(this.plugin.layoutSettings) + JSON.stringify(this.plugin.layoutSettings?.regionLayouts?.[file] || []);
  }
  private activeProcesses: Map<string, boolean> = new Map();

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
  }

  public hasCachedLayout(filePath: string): boolean {
    return this.layoutCache.has(filePath) && this.cacheRevisions.get(filePath) === this.cacheRevision(filePath);
  }

  public getCachedPage(filePath: string, pageNumber: number): ExternalLayoutItem[] | null {
    if (!this.hasCachedLayout(filePath)) return null;
    const docLayout = this.layoutCache.get(filePath);
    if (!docLayout) return null;
    return docLayout[String(pageNumber)] || [];
  }

  public clearCache(filePath?: string) {
    if (filePath) {
      this.layoutCache.delete(filePath);
    } else {
      this.layoutCache.clear();
    }
  }

  /**
   * Helper to safely parse JSON that might be polluted with C-library stdout noise
   * (e.g., MuPDF error messages appearing before the JSON object).
   */
  private tryParseJson(rawOutput: string): any {
    const trimmed = rawOutput.trim();
    if (!trimmed) throw new Error("Output is empty");

    // 1. Try standard parse
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // 2. Fallback: Extract valid JSON object ({...})
      // MuPDF errors often print text *before* the JSON.
      const startIndex = trimmed.indexOf('{');
      const endIndex = trimmed.lastIndexOf('}');

      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        const jsonSubstring = trimmed.substring(startIndex, endIndex + 1);
        try {
          return JSON.parse(jsonSubstring);
        } catch (innerError) {
          throw new Error(`Fallback parsing failed: ${innerError.message}`);
        }
      }
      
      throw e;
    }
  }

  /**
   * Runs the Python script to analyze the PDF.
   * Returns the full layout object.
   *
   * Phase 4 (C1): This method is now desktop-only. On mobile we throw an
   * Error before attempting any Node-only operation. Callers are expected
   * to surface the error to the user (typically via Notice) — most call
   * sites already catch and report failures.
   */
  public async generateLayout(pdfFile: TFile, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ExternalPageLayout | null> {
    if (opts?.signal?.aborted) throw makeAbortError();
    // ── Phase 4 (C1): Platform guard ───────────────────────────────
    // `child_process.spawn` is only available on desktop (Electron/Node).
    // On Obsidian Mobile the static `import { spawn } from 'child_process'`
    // would crash the plugin at module-load time; we therefore obtain it
    // lazily here and refuse to run on non-desktop platforms.
    if (!Platform.isDesktop) {
      throw new Error('Python layout engine is desktop-only.');
    }

    const nodeRequire = (window as any).require;
    if (!nodeRequire) {
      throw new Error('Cannot require child_process on this platform.');
    }

    let spawn: (cmd: string, args: string[], options?: any) => any;
    try {
      const cp = nodeRequire('child_process');
      spawn = cp.spawn;
    } catch (err: any) {
      throw new Error(`Failed to load child_process: ${err?.message ?? err}`);
    }
    if (typeof spawn !== 'function') {
      throw new Error('child_process.spawn is not available on this platform.');
    }

    const { pythonPath, ocrScriptPath } = this.plugin.settings;
    const filePath = pdfFile.path;
    
    // Get absolute path to PDF (needed for Python)
    // @ts-ignore - 'adapter' exists on vault but is internal API
    const basePath = this.plugin.app.vault.adapter.getBasePath(); 
    const absolutePdfPath = `${basePath}/${pdfFile.path}`;

    if (!pythonPath || !ocrScriptPath) {
      new Notice("Python path or Script path is missing in settings.");
      return null;
    }

    if (this.activeProcesses.get(filePath)) {
      new Notice("Layout analysis already in progress for this file.");
      return null;
    }

    const settingsSnapshot = JSON.parse(JSON.stringify(this.plugin.layoutSettings || {}));
    const extractionRevision = this.cacheRevision(filePath);
    const scriptArgs = [ocrScriptPath, absolutePdfPath];
    const preset = this.plugin.layoutSettings?.layoutPreset;
    if (preset && preset !== 'standard' && !isManualMode(preset)) scriptArgs.push('--preset', String(preset));
    // A synchronous spawn error must not leave a permanently busy file.
    const child = spawn(pythonPath, scriptArgs);
    this.activeProcesses.set(filePath, true);
    return new Promise((resolve, reject) => {
      let settled = false, stdout = '', stderr = '';
      const signal = opts?.signal;
      const finish = (error?: Error, result?: ExternalPageLayout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.activeProcesses.delete(filePath);
        if (error) reject(error);
        else { this.layoutCache.set(filePath, result!); this.cacheRevisions.set(filePath, extractionRevision); resolve(result!); }
      };
      const stop = (error: Error) => {
        // Mark settled before kill: mocked or platform close can be synchronous.
        finish(error);
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      };
      const onAbort = () => stop(makeAbortError());
      const timeout = Number(opts?.timeoutMs);
      const timer = setTimeout(() => stop(Object.assign(new Error('Python layout extraction timed out'),
        {name:'TimeoutError'})), Number.isFinite(timeout) && timeout > 0 ? timeout : 300000);
      signal?.addEventListener('abort', onAbort, {once:true});
      child.stdout.on('data', (data: any) => { if (!settled) stdout += data.toString(); });
      child.stderr.on('data', (data: any) => { if (!settled) stderr += data.toString(); });
      child.on('error', (error: Error) => finish(error));
      child.on('close', async (code: number) => {
        if (settled) return;
        if (code !== 0) { finish(new Error(`Python layout exited ${code}: ${stderr.slice(-500)}`)); return; }
        try {
          const result = this.tryParseJson(stdout);
          if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) {
            throw new Error(result?.error || 'Invalid Python layout output');
          }
          if (Object.entries(result).some(([page, items]) => !Number.isInteger(Number(page)) || Number(page) < 1 || !Array.isArray(items))) {
            throw new Error('Invalid Python layout page map');
          }
          // Manual constraints have a single implementation. Re-extract affected
          // pages with native spans instead of feeding already-merged Python boxes.
          for (const key of Object.keys(result)) {
            const page=Number(key);
            if (!isManualMode(settingsSnapshot.layoutPreset) && !rulesForPage(settingsSnapshot,filePath,page).length) continue;
            if (settled || signal?.aborted) return;
            const native=await this.plugin.pdfLayoutService.extractPage(pdfFile,page,settingsSnapshot);
            if (settled || signal?.aborted) return;
            if (!native.paragraphs.length && result[key].length) throw new Error(`No native text for manual layout on page ${page}; Python layout was not overwritten.`);
            result[key]=native.paragraphs.map((p,i)=>({id:`manual-${page}-${i}`,text:p.text,
              rect:{l:p.relativeRect.left,t:p.relativeRect.top,w:p.relativeRect.width,h:p.relativeRect.height},
              fontSize:p.fontSize,fontFamily:p.fontFamily,originalFontSizes:p.originalFontSizes}));
          }
          finish(undefined, result);
        } catch (e: any) { finish(e); }
      });
      if (signal?.aborted) onAbort();
    });
  }
}
