// pdf-exporter.ts
import { TFile, Notice, Platform, App } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';

export interface PdfExportSettings {
  pythonPath: string;
  mergeScriptPath: string;
  outputDirectory: string;
  textColor: string;          // e.g., "#000000"
  textOpacity: number;        // 0.0 - 1.0
  fontSizeScale: number;      // Relative to detected font size
  addAsAnnotation: boolean;   // true = annotation layer, false = embedded text
}

export interface MergePayload {
  pdfPath: string;            // Absolute path to original PDF
  translations: {
    page: number;
    items: Array<{
      text: string;
      rect: { left: number; top: number; width: number; height: number };
      fontSize: number;
      fontFamily?: string;
    }>;
  }[];
  options: {
    textColor: string;
    textOpacity: number;
    fontSizeScale: number;
    addAsAnnotation: boolean;
  };
}

export class PdfExporter {
  private plugin: OpenRouterTranslatorPlugin;
  private app: App;
  private activeExports: Set<string> = new Set();

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  public async exportPdfWithTranslations(pdfFile: TFile): Promise<void> {
    // Check if running on desktop before attempting export
    if (!Platform.isDesktop) {
      new Notice('PDF export is only available on desktop platforms');
      return;
    }

    const settings = this.plugin.settings;
    const exportSettings: PdfExportSettings = {
      pythonPath: settings.pythonPath,
      mergeScriptPath: settings.mergeScriptPath || '',
      outputDirectory: settings.exportOutputDirectory || '',
      textColor: settings.exportTextColor || '#000000',
      textOpacity: settings.exportTextOpacity !== undefined ? settings.exportTextOpacity : 0.85,
      fontSizeScale: settings.exportFontSizeScale !== undefined ? settings.exportFontSizeScale : 0.95,
      addAsAnnotation: settings.exportAsAnnotation || false,
    };

    // Validate settings
    if (!exportSettings.mergeScriptPath) {
      new Notice('Merge script path not configured in settings');
      return;
    }

    if (!exportSettings.pythonPath) {
      new Notice('Python path not configured in settings');
      return;
    }

    // Prevent concurrent exports for same file
    const lockKey = pdfFile.path;
    if (this.activeExports.has(lockKey)) {
      new Notice('Export already in progress for this PDF');
      return;
    }

    this.activeExports.add(lockKey);
    try {
      // 1. Get translation data
      const storage = this.plugin.storage;
      const overlayResult = await storage.readSavedOverlayForFile(pdfFile);
      
      if (!overlayResult) {
        new Notice('No translations found for this PDF. Translate pages first.');
        return;
      }

      // 2. Get absolute path to PDF (needed for Python)
      const absolutePdfPath = this.getAbsoluteFilePath(pdfFile.path);
      
      // 3. Prepare payload
      const payload: MergePayload = {
        pdfPath: absolutePdfPath,
        translations: this.prepareTranslationData(overlayResult.overlay.pageOverlays),
        options: {
          textColor: exportSettings.textColor,
          textOpacity: exportSettings.textOpacity,
          fontSizeScale: exportSettings.fontSizeScale,
          addAsAnnotation: exportSettings.addAsAnnotation,
        }
      };

      // 4. Execute Python script
      await this.executeMergeScript(payload, pdfFile, exportSettings);
      
    } catch (error) {
      console.error('PDF export failed:', error);
      new Notice(`Export failed: ${error.message || 'Unknown error'}`);
    } finally {
      this.activeExports.delete(lockKey);
    }
  }

  private prepareTranslationData(
    pageOverlays: Record<string, OverlayPositionData[]>
  ): MergePayload['translations'] {
    return Object.entries(pageOverlays).map(([pageStr, items]) => {
      const page = parseInt(pageStr, 10);
      return {
        page,
        items: items.map(item => ({
          text: item.translatedText.replace(/<br\s*\/?>/gi, '\n'), // Convert HTML breaks to real newlines
          rect: {
            left: item.relativeRect.left,
            top: item.relativeRect.top,
            width: item.relativeRect.width,
            height: item.relativeRect.height,
          },
          fontSize: item.fontSize || 12,
          fontFamily: item.fontFamily || 'sans-serif',
        }))
      };
    });
  }

  private async executeMergeScript(
    payload: MergePayload,
    pdfFile: TFile,
    settings: PdfExportSettings
  ): Promise<void> {
    // Dynamic import of Node.js modules (only available on desktop)
    const { spawn } = require('child_process');
    const path = require('path');

    new Notice(`Exporting PDF with translations...`, 4000);

    return new Promise((resolve, reject) => {
      const process = spawn(settings.pythonPath, [settings.mergeScriptPath], {
        cwd: path.dirname(settings.mergeScriptPath),
      });

      // Send payload via stdin as JSON
      process.stdin.write(JSON.stringify(payload));
      process.stdin.end();

      let stdoutData = '';
      let stderrData = '';

      process.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.warn('Python stderr:', data.toString());
      });

      process.on('close', async (code) => {
        if (code !== 0) {
          console.error('PDF merge script failed:', { code, stderr: stderrData, stdout: stdoutData });
          new Notice(`Export failed (exit code ${code}). Check console for details.`);
          reject(new Error(`Python script exited with code ${code}`));
          return;
        }

        try {
          // Parse output - expect JSON with output path
          const result = this.tryParseJson(stdoutData);
          
          if (!result?.outputPath) {
            throw new Error('Invalid response from merge script: missing outputPath');
          }

          // Convert absolute path to vault-relative if possible
          const vaultPath = this.convertToVaultPath(result.outputPath);
          
          new Notice(`✅ PDF exported successfully!\n${vaultPath || result.outputPath}`, 6000);
          
          // Offer to open the file
          if (vaultPath && Platform.isDesktop) {
            const outputFile = this.app.vault.getAbstractFileByPath(vaultPath);
            if (outputFile instanceof TFile) {
              this.app.workspace.openLinkText(outputFile.path, '', true);
            }
          }
          
          resolve();
        } catch (e) {
          console.error('Failed to parse merge script output:', e, stdoutData);
          new Notice('Export completed but output path could not be parsed');
          resolve(); // Don't fail the whole operation
        }
      });

      process.on('error', (err) => {
        console.error('Failed to spawn Python process:', err);
        new Notice(`Cannot start Python: ${err.message}. Check your Python path.`);
        reject(err);
      });
    });
  }

  // Robust JSON parsing (handles MuPDF warnings in stdout)
  private tryParseJson(rawOutput: string): any {
    const trimmed = rawOutput.trim();
    if (!trimmed) throw new Error("Output is empty");

    // Try standard parse first
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // Fallback: extract JSON object from noisy output
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

  private getAbsoluteFilePath(vaultPath: string): string {
    const path = require('path');
    // @ts-ignore - adapter is internal API but necessary for absolute paths
    const basePath = this.app.vault.adapter.getBasePath();
    return path.resolve(basePath, vaultPath);
  }

  private convertToVaultPath(absolutePath: string): string | null {
    const path = require('path');
    // @ts-ignore
    const basePath = this.app.vault.adapter.getBasePath();
    const relative = path.relative(basePath, absolutePath);
    
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null; // Outside vault
    }
    
    return relative.replace(/\\/g, '/');
  }
}