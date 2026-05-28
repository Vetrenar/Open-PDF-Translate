import { spawn } from 'child_process';
import { Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';

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
  private activeProcesses: Map<string, boolean> = new Map();

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
  }

  public hasCachedLayout(filePath: string): boolean {
    return this.layoutCache.has(filePath);
  }

  public getCachedPage(filePath: string, pageNumber: number): ExternalLayoutItem[] | null {
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
   */
  public async generateLayout(pdfFile: TFile): Promise<ExternalPageLayout | null> {
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

    this.activeProcesses.set(filePath, true);
    new Notice(`Analyzing PDF layout with Python...`);

    return new Promise((resolve) => {
      const process = spawn(pythonPath, [ocrScriptPath, absolutePdfPath]);
      
      let stdoutData = '';
      let stderrData = '';

      process.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      process.on('close', (code) => {
        this.activeProcesses.delete(filePath);
        
        // If Python exited with a non-zero code, it's usually a hard crash
        if (code !== 0) {
          console.error("Python Script Failed (exit code:", code, ")");
          console.error("STDERR:", stderrData);
          console.error("STDOUT:", stdoutData.substring(0, 500) + "...");
          new Notice("Layout analysis failed. Check console for details.");
          resolve(null);
          return;
        }

        try {
          // Attempt to parse the output using the robust helper
          const result = this.tryParseJson(stdoutData);

          // Check for logical errors returned by the script
          if (result.error) {
            new Notice(`PDF Analysis Error: ${result.error}`);
            console.error("Python Logical Error:", result.error);
            resolve(null);
            return;
          }

          // Success: Cache the results
          this.layoutCache.set(filePath, result);
          console.log(`External Layout Cached for ${filePath}`);
          resolve(result);

        } catch (e) {
          console.error("Failed to parse Python output.");
          console.error("Raw Output was:", stdoutData.substring(0, 500) + "...");
          console.error("Parse Error:", e);
          new Notice("Failed to parse PDF layout data. Check console for details.");
          resolve(null);
        }
      });

      process.on('error', (err) => {
        this.activeProcesses.delete(filePath);
        console.error("Failed to spawn Python process:", err);
        new Notice("Could not start Python process. Check your Python path in settings.");
        resolve(null);
      });
    });
  }
}