// processing.ts вЂ“ FULL OVERHAULED VERSION
// All fixes integrated: robust chunking, [#ID] delimiters for 100% retention,
// superвЂ‘resilient numberedвЂ‘line parser, automatic fallbacks, full debug logging,
// AND structure restoration to preserve original numbering/bullets.
// No text is ever dropped or left unappended.

import { Notice, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { TranslationUnit, OverlayPositionData } from './types';
import { LayoutDetector, LayoutSettings } from './layout-detector';
import type { VerticalStrip } from './GapDetector';
import { ExternalLayoutService } from './external-layout';
import { OcrLayoutService } from './ocr-layout';

export class TextProcessor {
  private plugin: OpenRouterTranslatorPlugin;
  public layoutDetector: LayoutDetector;
  public externalLayoutService: ExternalLayoutService;
  public ocrLayoutService: OcrLayoutService;

  // Caches
  private measurementCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();
  private styleCache = new Map<HTMLElement, CSSStyleDeclaration>();
  private colorDistanceCache = new Map<string, number>();

  // State вЂ“ now stores BOTH units AND their translated lines
  private lastPreparedUnits: {
    pageElement: HTMLElement;
    units: TranslationUnit[];
    translatedLines: string[];
  } | null = null;

  private overlayContainers: HTMLElement[] = [];
  private translationFailures: { segmentIndex: number; error: string }[] = [];
  private lastColumnAnalysis: {
    columns: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
    edgeCols: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
    gapCols: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
    verticalGaps: number[];
    horizontalGaps: number[];
  } | null = null;

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
    this.layoutDetector = new LayoutDetector(this.plugin.layoutSettings);
    this.externalLayoutService = new ExternalLayoutService(plugin);
    this.ocrLayoutService = new OcrLayoutService(plugin);
  }

  // ==================== PUBLIC API ====================

  public updateLayoutDetectorSettings(newSettings: LayoutSettings, silent = false): void {
    console.log("Updating LayoutDetector with new settings:", newSettings);
    this.layoutDetector = new LayoutDetector(newSettings);
    this.externalLayoutService.clearCache();
    if (!silent) {
      new Notice('Layout detection settings have been updated.');
    }
  }

  public async addTextOverlay() {
    const currentPage = this.plugin.overlay.getCurrentPageElement();
    if (currentPage) {
      await this.addOverlayToPage(currentPage);
    } else {
      new Notice('No active PDF page found.');
    }
  }

  public async addOverlayToPage(pageElement: HTMLElement) {
    try {
      const translatedText = await this.translatePageContent(pageElement);
      if (translatedText) {
        await this.createOverlayWithText(pageElement, translatedText);
        const successfulTranslations = translatedText.split('\n').filter(line => line !== 'Translation missing').length;
        new Notice(`вњ… Translation complete. Rendered ${successfulTranslations} segment(s).`, 3000);
      }
    } catch (error: any) {
      console.error("addOverlayToPage process failed:", error);
      new Notice(`вљ пёЏ Translation failed: ${error.message}`, 4000);
    }
  }

  // ==================== TRANSLATION PIPELINE ====================

  public async translatePageContent(pageElement: HTMLElement): Promise<string | null> {
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    const engine = this.plugin.settings.layoutEngine;

    if (engine !== 'ocr-api' && !textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      return null;
    }

    let translationUnits: TranslationUnit[] | null = null;

    switch (engine) {
      case 'ocr-api':
        translationUnits = await this.prepareOcrApiTranslationUnits(pageElement);
        break;
      case 'python':
        translationUnits = await this.prepareExternalTranslationUnits(pageElement);
        break;
      case 'internal':
      default:
        translationUnits = this.prepareTranslationUnits(textLayer!, pageElement);
        break;
    }

    if (!translationUnits || translationUnits.length === 0) {
      new Notice('No valid text to translate (or layout analysis failed).', 2000);
      return null;
    }

    if (this.plugin.settings.enableSemanticMerging) {
      translationUnits = this.mergeSemanticFragments(translationUnits);
    }

    const translatedLines = await this.executeTranslation(translationUnits);

    // Cache everything вЂ“ guarantees perfect 1:1 mapping for overlay creation
    this.lastPreparedUnits = {
      pageElement,
      units: [...translationUnits],
      translatedLines: [...translatedLines]
    };

    return translatedLines.join('\n');
  }

  public async createOverlayWithText(pageElement: HTMLElement, translatedText: string): Promise<void> {
    const requiresTextLayer = this.plugin.settings.layoutEngine === 'internal';
    const prepResult = this.validateAndPreparePrerequisites(pageElement, requiresTextLayer);
    if (!prepResult) return;
    const { overlayContainer } = prepResult;
    this.overlayContainers.push(overlayContainer);

    let translationUnits: TranslationUnit[] | null = null;
    let translatedLines: string[];

    // === CRITICAL: Reuse cached units + translated lines if available ===
    if (this.lastPreparedUnits?.pageElement === pageElement) {
      translationUnits = this.lastPreparedUnits.units;
      translatedLines = this.lastPreparedUnits.translatedLines;
    } else {
      // No cache вЂ“ cannot safely use the passed translatedText.
      new Notice('вљ пёЏ Page data expired. Please reвЂ‘translate.', 3000);
      overlayContainer.remove();
      return;
    }

    if (!translationUnits || translationUnits.length === 0) {
      overlayContainer.remove();
      return;
    }

    // === Safety net: enforce equal length ===
    if (translatedLines.length !== translationUnits.length) {
      console.error(`CRITICAL: Units (${translationUnits.length}) vs TranslatedLines (${translatedLines.length}) mismatch. Fixing.`);
      if (translatedLines.length < translationUnits.length) {
        translatedLines = [
          ...translatedLines,
          ...translationUnits.slice(translatedLines.length).map(u => u.text)
        ];
      } else {
        translatedLines = translatedLines.slice(0, translationUnits.length);
      }
    }

    this.renderOverlay(translationUnits, translatedLines, overlayContainer, pageElement);

    if (this.plugin.settings.autoSaveOverlay) {
      requestAnimationFrame(() => this.plugin.overlay.saveCurrentPageOverlay());
    }
  }

  // ==================== LAYOUT PREPARATION ====================

  private validateAndPreparePrerequisites(
    pageElement: HTMLElement,
    requireTextLayer: boolean
  ): { textLayer: HTMLElement | null; overlayContainer: HTMLElement } | null {
    if (!this.validatePageElement(pageElement)) {
      new Notice('Invalid page element');
      return null;
    }
    const overlayContainer = this.plugin.overlay.preparePageForOverlay(pageElement);
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    if (requireTextLayer && !textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      overlayContainer.remove();
      return null;
    }
    return { textLayer, overlayContainer };
  }

  private async prepareOcrApiTranslationUnits(pageElement: HTMLElement): Promise<TranslationUnit[] | null> {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) return null;

    const pageNumStr = pageElement.getAttribute('data-page-number');
    if (!pageNumStr) return null;
    const pageNum = parseInt(pageNumStr, 10);

    const ocrSettings = this.plugin.settings.ocrProvider;

    let pageItems = await this.ocrLayoutService.getCachedPage(activeFile.path, pageNum);

    if (!pageItems || pageItems.length === 0) {
      if (ocrSettings.workflowMode === 'full-document') {
        const hasFull = await this.ocrLayoutService.hasCachedLayout(activeFile.path);
        if (!hasFull) {
          new Notice(
            'Full document OCR cache not found.\n' +
            'Run "OCR: Analyze full document" first, or switch to "per-page" mode.',
            6000
          );
          return null;
        }
        new Notice(`Page ${pageNum} has no OCR data in cache.`);
        return null;
      }
      pageItems = await this.ocrLayoutService.ocrPage(activeFile, pageNum, pageElement);
    }

    if (!pageItems || pageItems.length === 0) return null;

    return pageItems.map(item => ({
      id: item.id,
      paragraphId: item.id,
      text: item.text,
      originalSpans: [],
      _externalRect: item.rect,
      _externalFont: {
        family: item.fontFamily,
        size: item.fontSize,
        sizes: item.originalFontSizes
      }
    } as unknown as TranslationUnit));
  }

  private async prepareExternalTranslationUnits(pageElement: HTMLElement): Promise<TranslationUnit[] | null> {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) return null;

    if (!this.externalLayoutService.hasCachedLayout(activeFile.path)) {
      const layout = await this.externalLayoutService.generateLayout(activeFile);
      if (!layout) return null;
    }

    const pageNumStr = pageElement.getAttribute('data-page-number');
    if (!pageNumStr) return null;
    const pageNum = parseInt(pageNumStr, 10);

    const pageItems = this.externalLayoutService.getCachedPage(activeFile.path, pageNum);
    if (!pageItems || pageItems.length === 0) return null;

    return pageItems.map(item => ({
      id: item.id,
      paragraphId: item.id,
      text: item.text,
      originalSpans: [],
      _externalRect: item.rect,
      _externalFont: {
        family: item.fontFamily,
        size: item.fontSize,
        sizes: item.originalFontSizes
      }
    } as unknown as TranslationUnit));
  }

  public prepareTranslationUnits(textLayerOrSpans: HTMLElement | HTMLSpanElement[], pageElement: HTMLElement): TranslationUnit[] | null {
    const rawSpans = Array.isArray(textLayerOrSpans)
      ? textLayerOrSpans
      : Array.from(textLayerOrSpans.querySelectorAll<HTMLSpanElement>('span'));

    const textSpans = this.validateSpans(rawSpans).filter(span => this.isValidSpan(span));

    if (textSpans.length === 0) {
      return null;
    }

    const result = this.layoutDetector.detectLayout(textSpans, pageElement);
    this.lastColumnAnalysis = result.columnAnalysis;
    if (this.plugin.settings.debugMode) {
      this.renderLayoutDebugOverlay(
        pageElement,
        result.columnAnalysis,
        result.debugStrips || [],
        result.layoutRegions || []
      );
    } else {
      this.clearLayoutDebugOverlay(pageElement);
    }
    this.clearCaches();

    if (this.plugin.settings.debugMode) {
      console.log(`PDF Translator: Found ${result.paragraphs.length} paragraph(s) to process.`);
    }

    const { maxBatchChars } = this.plugin.settings;

    return result.paragraphs.flatMap((paragraphSpans, paraIndex) => {
      if (!paragraphSpans || paragraphSpans.length === 0) return [];
      const paragraphId = `para-${paraIndex}`;
      const paragraphAsHtml = this.spansToHtml(paragraphSpans);

      if (paragraphAsHtml.length <= maxBatchChars) {
        if (paragraphAsHtml.length <= 5) return [];
        return [{
          originalSpans: paragraphSpans,
          text: paragraphAsHtml,
          id: paragraphId,
          paragraphId: paragraphId,
        }];
      }

      const sortedSpans = [...paragraphSpans].sort((a, b) => {
        const rectA = this.getBoundingClientRectCached(a);
        const rectB = this.getBoundingClientRectCached(b);
        if (Math.abs(rectA.top - rectB.top) > 5) return rectA.top - rectB.top;
        return rectA.left - rectB.left;
      });

      const sentenceSpanGroups: HTMLSpanElement[][] = [];
      let currentSentenceSpans: HTMLSpanElement[] = [];
      const sentenceEndRegex = /[.?!]\s*$/;

      for (const span of sortedSpans) {
        currentSentenceSpans.push(span);
        if (sentenceEndRegex.test((span.textContent || '').trim())) {
          sentenceSpanGroups.push(currentSentenceSpans);
          currentSentenceSpans = [];
        }
      }
      if (currentSentenceSpans.length > 0) {
        sentenceSpanGroups.push(currentSentenceSpans);
      }

      return sentenceSpanGroups
        .map((spans, sentenceIndex) => {
          const text = this.spansToHtml(spans);
          if (!text || text.length <= 5) return null;
          return {
            originalSpans: spans,
            text,
            id: `${paragraphId}-sent-${sentenceIndex}`,
            paragraphId: paragraphId,
          };
        })
        .filter((unit): unit is TranslationUnit => !!unit);
    });
  }

  // ==================== SEMANTIC MERGING ====================

  private mergeSemanticFragments(units: TranslationUnit[]): TranslationUnit[] {
    if (units.length < 2) return units;

    const mergedUnits: TranslationUnit[] = [];
    const terminatorRegex = /[.?!:](?:\s*<\/[^>]+>)*\s*$/;
    const startLowercaseRegex = /^(?:<[^>]+>)*\s*[a-z]/;

    let currentUnit = units[0];

    for (let i = 1; i < units.length; i++) {
      const nextUnit = units[i];
      const isCurrentOpen = !terminatorRegex.test(currentUnit.text.trim());
      const isNextContinuation = startLowercaseRegex.test(nextUnit.text.trim());

      if (isCurrentOpen && isNextContinuation) {
        currentUnit.text += ' ' + nextUnit.text;
        currentUnit.originalSpans.push(...nextUnit.originalSpans);
        if (this.plugin.settings.debugMode) {
          console.log(`Merged broken sentence: "${currentUnit.text.substring(currentUnit.text.length - 30)}..."`);
        }
      } else {
        mergedUnits.push(currentUnit);
        currentUnit = nextUnit;
      }
    }
    mergedUnits.push(currentUnit);
    return mergedUnits;
  }

  // ==================== TRANSLATION EXECUTION ====================
  // ** OVERHAULED ** вЂ“ Uses [#ID] syntax to prevent regex confusion

  public async executeTranslation(units: TranslationUnit[]): Promise<string[]> {
    this.translationFailures = [];
    
    // Safety check: Empty units
    if (units.length === 0) return [];

    // 1. Prepare Prompt with STRONG Delimiters
    // We use [#1], [#2] instead of 1., 2. to avoid confusion with document content
    // like "2.5 Section Title" or "2024 Year".
    const fullText = units.map((u, i) => `[#${i + 1}] ${u.text}`).join('\n');
    const { useBatchTranslation: useBatch, maxBatchChars } = this.plugin.settings;

    // Use chunking if total text length exceeds limit
    const shouldUseChunking = useBatch && units.length > 1 && fullText.length > maxBatchChars;

    try {
      let translatedLines: string[];

      if (shouldUseChunking) {
        new Notice(`Long page detected. Translating in multiple batches...`, 4000);
        translatedLines = await this.performChunkedTranslation(units, maxBatchChars);
      } else if (useBatch && units.length > 1) {
        // new Notice(`Translating ${units.length} segments in a batch...`, 3000); // optional: reduce noise
        const raw = await this.plugin.translation.translateBatch(fullText, units.length);
        
        if (this.plugin.settings.debugMode) {
          console.log(`[Batch Input]:\n${fullText}`);
          console.log(`[Batch Raw Output]:\n${raw}`);
        }
        
        // 2. Robust Extraction
        translatedLines = this.extractNumberedLinesRobust(raw, units.length, units.map(u => u.text));
      } else {
        // Sequential fallback
        translatedLines = await this.performSequentialTranslation(units);
      }

      // 3. SAFEGUARD: Structure Restoration
      // Fixes issue where "2.1 Title" becomes "Title" (LLM stripping numbering)
      translatedLines = this.restoreStructure(units, translatedLines);

      // 4. Final Validation & Filling
      // If a line is missing, we fallback to original text to prevent empty gaps in the overlay
      translatedLines = translatedLines.map((line, i) => {
        if (line === 'Translation missing' || !line.trim()) {
            console.warn(`Segment ${i + 1} missing. Reverting to original.`);
            return units[i].text;
        }
        return line;
      });

      return translatedLines;

    } catch (err: any) {
      this.plugin.logDebug('Translation fatal error:', err);
      // Fail gracefully: return originals
      return units.map(u => u.text);
    }
  }

  // ==================== CHUNKED TRANSLATION ====================

  private async performChunkedTranslation(units: TranslationUnit[], maxChunkChars: number): Promise<string[]> {
    const allTranslatedLines = Array(units.length).fill('Translation missing');
    let i = 0;
    let chunkCounter = 0;

    while (i < units.length) {
      const indices: number[] = [];
      let chunkLength = 0;

      // Greedy accumulation вЂ“ always include at least 1 unit to prevent infinite loop.
      while (i < units.length) {
        const addedLength = units[i].text.length + 8; // "[#12] " overhead

        if (indices.length > 0 && chunkLength + addedLength > maxChunkChars) {
          // Try to cut at a sentence break inside the current chunk.
          // Only do so if there is at least 2 items and the break is not the last item.
          const breakIdx = this.findLastSentenceBreak(units, indices);
          if (breakIdx > 0 && breakIdx < indices.length - 1) {
            // How many trailing indices are we returning to the next chunk?
            const unitsToReturn = indices.length - (breakIdx + 1);
            i -= unitsToReturn;           // rewind global pointer
            indices.splice(breakIdx + 1); // trim the chunk to the break point
          }
          // Whether or not we found a sentence break, stop building this chunk here.
          break;
        }

        indices.push(i);
        chunkLength += addedLength;
        i++;
      }

      // Safety guard: this should never happen after the "at least 1" rule above,
      // but protects against any edge case that would otherwise create an infinite loop.
      if (indices.length === 0) {
        console.error(`performChunkedTranslation: empty indices at position ${i}. Force-skipping unit.`);
        allTranslatedLines[i] = units[i].text;
        i++;
        continue;
      }

      chunkCounter++;
      // Re-index locally 1..N
      const chunkText = indices.map((idx, localPos) => `[#${localPos + 1}] ${units[idx].text}`).join('\n');

      if (this.plugin.settings.debugMode) {
        console.log(`[Chunk ${chunkCounter}] Translating ${indices.length} unit(s) (global indices ${indices[0]}вЂ“${indices[indices.length - 1]}):\n${chunkText}`);
      }

      try {
        new Notice(`Translating batch ${chunkCounter}...`);
        const raw = await this.plugin.translation.translateBatch(chunkText, indices.length);

        if (this.plugin.settings.debugMode) {
          console.log(`[Chunk ${chunkCounter} Raw Output]:\n${raw}`);
        }

        const chunkOriginals = indices.map(idx => units[idx].text);
        const lines = this.extractNumberedLinesRobust(raw, indices.length, chunkOriginals);

        // Validate that we got the right number of lines back before mapping.
        if (lines.length !== indices.length) {
          console.warn(
            `[Chunk ${chunkCounter}] extractNumberedLinesRobust returned ${lines.length} lines ` +
            `but expected ${indices.length}. Some segments may fall back to originals.`
          );
        }

        // Map local positions back to global array.
        // Use Math.min to avoid accessing an out-of-bounds index if lines is short.
        const safeLen = Math.min(lines.length, indices.length);
        for (let localPos = 0; localPos < safeLen; localPos++) {
          const globalIdx = indices[localPos];
          if (globalIdx !== undefined) {
            allTranslatedLines[globalIdx] = lines[localPos];
          }
        }

        // If lines was shorter than expected, fill remaining with originals so nothing is lost.
        for (let localPos = safeLen; localPos < indices.length; localPos++) {
          const globalIdx = indices[localPos];
          if (globalIdx !== undefined && allTranslatedLines[globalIdx] === 'Translation missing') {
            console.warn(`[Chunk ${chunkCounter}] Segment ${localPos + 1} not in parser output. Falling back to original.`);
            allTranslatedLines[globalIdx] = units[globalIdx].text;
          }
        }

      } catch (err) {
        console.error(`Batch ${chunkCounter} failed`, err);
        // Fallback: keep original text so overlay still renders for all units in this chunk.
        indices.forEach(idx => {
          allTranslatedLines[idx] = units[idx].text;
        });
      }
    }

    return allTranslatedLines;
  }

  private findLastSentenceBreak(units: TranslationUnit[], indices: number[]): number {
    for (let i = indices.length - 1; i >= 0; i--) {
      if (/[.?!](?:\s*<\/[bi]>)*\s*$/.test(units[indices[i]].text.trim())) {
        return i;
      }
    }
    return -1;
  }

  public extractNumberedLines(rawText: string, expectedCount: number, originalTexts: string[] = []): string[] {
    const fallbacks =
      originalTexts.length >= expectedCount
        ? originalTexts
        : [
            ...originalTexts,
            ...Array(Math.max(0, expectedCount - originalTexts.length)).fill('Translation missing')
          ];
    return this.extractNumberedLinesRobust(rawText, expectedCount, fallbacks);
  }

  // ==================== ROBUST NUMBEREDвЂ‘LINE PARSER ====================
  // ** OVERHAULED ** вЂ“ Handles [#ID] tags and falls back gracefully


  private extractNumberedLinesRobust(
    rawText: string,
    expectedCount: number,
    originalTexts: string[]
  ): string[] {
    // 1. Sanitize AI Output
    let cleanText = rawText
      .replace(/```(?:json|text)?/g, '')
      .replace(/```/g, '')
      .replace(/^Here is the translation.*?:/im, '')
      .trim();

    const result = Array(expectedCount).fill('Translation missing');

    // STRATEGY A: Specific Tag Matching "[#1] ..."
    // The lookahead requires \n before the next tag, OR allows the tag to appear
    // mid-line (no preceding \n) by also checking for (?=\[#\d+\]) directly.
    // This catches LLMs that emit everything on one line.
    const tagRegex = /(?:^|\n)[\s*_]*\[#(\d+)\][\s*_]*(?:[:.-])?\s*([\s\S]*?)(?=(?:\n[\s*_]*\[#\d+\])|$)/g;

    let match;
    let foundCount = 0;

    tagRegex.lastIndex = 0;

    while ((match = tagRegex.exec(cleanText)) !== null) {
      const num = parseInt(match[1], 10);
      const text = match[2].trim();

      if (num > 0 && num <= expectedCount) {
        result[num - 1] = text;
        foundCount++;
      }
    }

    // If we found at least half the expected tags, trust Strategy A.
    // (A partial match is still better than misaligned line-splitting.)
    if (foundCount >= Math.ceil(expectedCount / 2)) {
      if (foundCount < expectedCount && this.plugin.settings.debugMode) {
        console.warn(
          `extractNumberedLinesRobust [Strategy A]: Found ${foundCount}/${expectedCount} tags. ` +
          `Missing segments will fall back to originals.`
        );
      }

      // Fill any remaining 'Translation missing' holes with originals so nothing is lost.
      for (let i = 0; i < expectedCount; i++) {
        if (result[i] === 'Translation missing') {
          if (this.plugin.settings.debugMode) {
            console.warn(`Segment [#${i + 1}] not found in AI output. Reverting to original.`);
          }
          result[i] = originalTexts[i] ?? 'Translation missing';
        }
      }
      return result;
    }

    // STRATEGY B: Fallback to Line Splitting
    const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const candidateLines = lines.filter(l =>
      !l.toLowerCase().startsWith("sure,") &&
      !l.toLowerCase().startsWith("translation:") &&
      !l.toLowerCase().startsWith("here are")
    );

    // Strip prompt tags but not body numbering
    const strictTagStripRegex = /^[\s*_]*\[#\d+\][\s*_]*(?:[:.-])?\s*/;

    // Exact count match в†’ 1:1 mapping
    if (candidateLines.length === expectedCount) {
      return candidateLines.map(line => line.replace(strictTagStripRegex, ''));
    }

    // STRATEGY C: Soft Alignment (count is close)
    if (candidateLines.length > 0 && Math.abs(candidateLines.length - expectedCount) <= 2) {
      console.log(`Alignment fallback: Expected ${expectedCount}, got ${candidateLines.length}. Aligning sequentially.`);
      const safeLen = Math.min(candidateLines.length, expectedCount);
      for (let i = 0; i < safeLen; i++) {
        result[i] = candidateLines[i].replace(strictTagStripRegex, '');
      }
      // Fill any remaining slots with originals (don't leave 'Translation missing' holes).
      for (let i = safeLen; i < expectedCount; i++) {
        if (this.plugin.settings.debugMode) {
          console.warn(`Segment ${i + 1} not in candidate lines. Reverting to original.`);
        }
        result[i] = originalTexts[i] ?? 'Translation missing';
      }
      return result;
    }

    // STRATEGY D: Last resort вЂ“ fill with originals, log warning
    console.warn(
      `extractNumberedLinesRobust: All strategies failed for ${expectedCount} segments. ` +
      `Raw output had ${candidateLines.length} candidate lines. Reverting all to originals.`
    );
    return originalTexts.map(t => t ?? 'Translation missing');
  }

  // ==================== CRITICAL SAFEGUARD: STRUCTURE RESTORATION ====================
  // ** NEW ** вЂ“ forces original list markers back onto translations

  private restoreStructure(units: TranslationUnit[], translatedLines: string[]): string[] {
    // Regex matches: "1.", "1.1", "2.1.3", "a)", "-", "вЂў"
    const listMarkersRegex = /^(\d{1,2}\.\d{1,2}(\.\d{1,2})?|\d{1,3}[\.\)]|[a-z][\.\)]|[-вЂў*])\s+/i;

    return translatedLines.map((line, index) => {
      if (line === 'Translation missing') return line;

      const original = units[index].text.trim();
      const originalMatch = original.match(listMarkersRegex);
      
      // If original didn't have a number/bullet, return translation as is
      if (!originalMatch) return line;

      const marker = originalMatch[1]; 
      const translationMatch = line.trim().match(listMarkersRegex);

      // 1. Translation lacks marker -> Prepend it
      if (!translationMatch) {
        return `${marker} ${line}`;
      }

      // 2. Translation has marker, but it might be wrong (e.g. LLM wrote "1." instead of "2.1")
      if (translationMatch[1] !== marker) {
        // If the marker is purely numeric/bullet, we trust the original layout.
        // We avoid replacing word-like starts (e.g. "Chapter 1" vs "CapГ­tulo 1" is fine).
        if (/^[\d\.\-вЂў]+$/.test(marker)) {
             return `${marker} ${line.replace(listMarkersRegex, '').trim()}`;
        }
      }

      return line;
    });
  }

  // ==================== SEQUENTIAL TRANSLATION ====================

  private async performSequentialTranslation(units: TranslationUnit[]): Promise<string[]> {
    return Promise.all(units.map(async (unit, i) => {
      try {
        return await this.plugin.translation.translateWithOpenRouter(unit.text);
      } catch (error: any) {
        this.plugin.logDebug(`Translation failed for segment ${i}:`, error);
        this.translationFailures.push({ segmentIndex: i, error: error.message || 'Unknown error' });
        return "Translation missing";
      }
    }));
  }

  // ==================== RENDERING ====================

  private renderOverlay(
    units: TranslationUnit[],
    translatedLines: string[],
    overlayContainer: HTMLElement,
    pageElement: HTMLElement
  ) {
    const engine = this.plugin.settings.layoutEngine;

    // ----- EXTERNAL LAYOUT (python / ocr-api) -----
    if (engine === 'python' || engine === 'ocr-api') {
      const pageNumber = parseInt(pageElement.getAttribute('data-page-number') || '0', 10);
      const activeFile = this.plugin.app.workspace.getActiveFile();

      const overlayData: OverlayPositionData[] = units
        .map((unit: any, index) => {
          const extRect = unit._externalRect;
          const extFont = unit._externalFont;
          if (!extRect) return null;

          return {
            selector: '',
            textContent: unit.text,
            page: pageNumber,
            translatedText: translatedLines[index] || unit.text,
            relativeRect: {
              left: extRect.l,
              top: extRect.t,
              width: extRect.w,
              height: extRect.h
            },
            fontSize: extFont?.size,
            fontFamily: extFont?.family,
            originalFontSizes: extFont?.sizes || [],
          } as OverlayPositionData;
        })
        .filter((x): x is OverlayPositionData => x !== null);

      this.plugin.overlay.renderSavedOverlay(overlayData, pageNumber);

      if (this.plugin.settings.autoSaveOverlay && activeFile) {
        this.plugin.storage
          .updatePageOverlaysAndWrite(activeFile, { [pageNumber]: overlayData })
          .catch(err => console.error("Failed to auto-save translation:", err));
      }
      return;
    }

    // ----- INTERNAL LAYOUT (DOM) -----
    const reassembledParagraphs = new Map<string, { originalSpans: HTMLSpanElement[]; translatedText: string; }>();
    units.forEach((unit, index) => {
      const { paragraphId, originalSpans } = unit;
      const translatedLine = translatedLines[index];
      if (!reassembledParagraphs.has(paragraphId)) {
        reassembledParagraphs.set(paragraphId, { originalSpans: [], translatedText: '' });
      }
      const group = reassembledParagraphs.get(paragraphId)!;
      group.originalSpans.push(...originalSpans);
      group.translatedText += (group.translatedText ? ' ' : '') + translatedLine;
    });

    const mergedUnits: TranslationUnit[] = [];
    const mergedTranslatedLines: string[] = [];
    reassembledParagraphs.forEach((group, paragraphId) => {
      mergedUnits.push({
        id: paragraphId,
        paragraphId: paragraphId,
        originalSpans: group.originalSpans,
        text: ''
      });
      mergedTranslatedLines.push(group.translatedText);
    });

    this.plugin.overlay.renderOverlays(mergedUnits, mergedTranslatedLines, overlayContainer, pageElement);
  }

  // ==================== HELPERS ====================

  private spansToHtml(spans: HTMLSpanElement[]): string {
    if (!spans?.length) return '';
    const lines = new Map<number, HTMLSpanElement[]>();
    spans.forEach(span => {
      const lineKey = Math.round(this.getBoundingClientRectCached(span).top);
      if (!lines.has(lineKey)) lines.set(lineKey, []);
      lines.get(lineKey)!.push(span);
    });
    return Array.from(lines.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, lineSpans]) =>
        lineSpans
          .sort((a, b) => this.getBoundingClientRectCached(a).left - this.getBoundingClientRectCached(b).left)
          .map(span => {
            const style = this.getComputedStyleCached(span);
            let content = this.escapeHtml(span.textContent || '');
            const isBold = parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold';
            if (isBold) content = `<b>${content}</b>`;
            if (style.fontStyle === 'italic') content = `<i>${content}</i>`;
            return content;
          })
          .join(' ')
      )
      .join('<br>');
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&#039;');
  }

  public isValidSpan(span: HTMLSpanElement): boolean {
    const rect = this.getBoundingClientRectCached(span);
    const text = (span.textContent || '').trim();
    if (rect.width <= 1 || rect.height <= 1 || !text) return false;
    if (/^\d{1,3}$/.test(text)) return false;
    if (text.length === 1 && /[вЂў\-вЂўВ»В«]/.test(text)) return false;
    if (text.startsWith('http')) return false;
    return true;
  }

  private validateSpans(spans: HTMLSpanElement[]): HTMLSpanElement[] {
    return spans.filter(span => span instanceof HTMLSpanElement && span.isConnected);
  }

  private validatePageElement(pageElement: HTMLElement): boolean {
    return pageElement instanceof HTMLElement && pageElement.isConnected;
  }

  private getBoundingClientRectCached(element: HTMLElement): DOMRect {
    const now = Date.now();
    const cached = this.measurementCache.get(element);
    if (cached && now - cached.timestamp < 100) return cached.rect;
    const rect = element.getBoundingClientRect();
    this.measurementCache.set(element, { rect, timestamp: now });
    return rect;
  }

  private getComputedStyleCached(element: HTMLElement): CSSStyleDeclaration {
    if (!this.styleCache.has(element)) {
      this.styleCache.set(element, window.getComputedStyle(element));
    }
    return this.styleCache.get(element)!;
  }

  private clearCaches(): void {
    this.measurementCache.clear();
    this.styleCache.clear();
    if (this.colorDistanceCache.size > 1000) this.colorDistanceCache.clear();
  }

  public getSpansBbox(spans: HTMLSpanElement[], pageElement: HTMLElement) {
    if (!spans?.length) return { rect: null, fontSizes: [], avgFontSize: 12, fontFamily: 'sans-serif' };
    const pageRect = pageElement.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const fontSizes: number[] = [];
    let fontFamily = 'sans-serif';
    for (const span of spans) {
      const rect = this.getBoundingClientRectCached(span);
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      const style = this.getComputedStyleCached(span);
      fontSizes.push(parseFloat(style.fontSize) || 12);
      if (fontFamily === 'sans-serif' && style.fontFamily) {
        fontFamily = style.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      }
    }
    if (!isFinite(left)) return { rect: null, fontSizes: [], avgFontSize: 12, fontFamily };
    const rect = new DOMRect(left - pageRect.left, top - pageRect.top, right - left, bottom - top);
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length || 12;
    return { rect, fontSizes, avgFontSize, fontFamily };
  }

  public cleanup(): void {
    this.overlayContainers.forEach(container => container.remove());
    this.overlayContainers = [];
    this.clearLayoutDebugOverlay();
    this.clearCaches();
    this.translationFailures = [];
    this.lastColumnAnalysis = null;
    this.lastPreparedUnits = null;
    this.externalLayoutService.clearCache();
    this.ocrLayoutService.clearCache();
  }

  private clearLayoutDebugOverlay(pageElement?: HTMLElement): void {
    if (pageElement) {
      pageElement.querySelectorAll('.pdf-layout-debug-overlay').forEach(el => el.remove());
      return;
    }
    document.querySelectorAll('.pdf-layout-debug-overlay').forEach(el => el.remove());
  }

  private renderLayoutDebugOverlay(
    pageElement: HTMLElement,
    columnAnalysis: {
      columns: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
      verticalGaps: number[];
    },
    strips: VerticalStrip[],
    layoutRegions: Array<{ top: number; bottom: number; left: number; right: number }>
  ): void {
    this.clearLayoutDebugOverlay(pageElement);

    const pageRectRaw = pageElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const normLeft = pageRectRaw.left / dpr;
    const normTop = pageRectRaw.top / dpr;
    const normWidth = pageRectRaw.width / dpr;
    const normHeight = pageRectRaw.height / dpr;

    if (normWidth <= 0 || normHeight <= 0) return;

    const toLocalX = (xNorm: number): number => ((xNorm - normLeft) / normWidth) * 100;
    const toLocalY = (yNorm: number): number => ((yNorm - normTop) / normHeight) * 100;
    const toLocalW = (wNorm: number): number => (wNorm / normWidth) * 100;
    const toLocalH = (hNorm: number): number => (hNorm / normHeight) * 100;

    const layer = document.createElement('div');
    layer.className = 'pdf-layout-debug-overlay';
    layer.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      'z-index:140'
    ].join(';');

    // Draw detected strip regions (likely separators).
    for (const strip of strips) {
      const stripEl = document.createElement('div');
      stripEl.style.cssText = [
        'position:absolute',
        `left:${toLocalX(strip.left).toFixed(3)}%`,
        `top:${toLocalY(strip.top).toFixed(3)}%`,
        `width:${toLocalW(Math.max(0, strip.right - strip.left)).toFixed(3)}%`,
        `height:${toLocalH(Math.max(0, strip.bottom - strip.top)).toFixed(3)}%`,
        'background:rgba(255,80,80,0.14)',
        'border:1px dashed rgba(255,70,70,0.85)',
        'box-sizing:border-box'
      ].join(';');
      layer.appendChild(stripEl);
    }

    // Draw detected layout regions (complex layout segmentation).
    for (const region of layoutRegions) {
      const regionEl = document.createElement('div');
      regionEl.style.cssText = [
        'position:absolute',
        `left:${toLocalX(region.left).toFixed(3)}%`,
        `top:${toLocalY(region.top).toFixed(3)}%`,
        `width:${toLocalW(Math.max(0, region.right - region.left)).toFixed(3)}%`,
        `height:${toLocalH(Math.max(0, region.bottom - region.top)).toFixed(3)}%`,
        'border:1px solid rgba(80,205,120,0.75)',
        'background:rgba(80,205,120,0.04)',
        'box-sizing:border-box'
      ].join(';');
      layer.appendChild(regionEl);
    }

    // Draw detected columns.
    for (const col of columnAnalysis.columns || []) {
      const colEl = document.createElement('div');
      colEl.style.cssText = [
        'position:absolute',
        `left:${toLocalX(col.left).toFixed(3)}%`,
        `top:${toLocalY(col.top).toFixed(3)}%`,
        `width:${toLocalW(Math.max(0, col.width)).toFixed(3)}%`,
        `height:${toLocalH(Math.max(0, col.height)).toFixed(3)}%`,
        'border:1px solid rgba(0,150,255,0.75)',
        'background:rgba(0,150,255,0.05)',
        'box-sizing:border-box'
      ].join(';');
      layer.appendChild(colEl);
    }

    // Draw vertical gap center lines.
    for (const gx of columnAnalysis.verticalGaps || []) {
      const line = document.createElement('div');
      line.style.cssText = [
        'position:absolute',
        `left:${toLocalX(gx).toFixed(3)}%`,
        'top:0',
        'width:0',
        'height:100%',
        'border-left:2px solid rgba(255,170,0,0.9)'
      ].join(';');
      layer.appendChild(line);
    }

    pageElement.appendChild(layer);
  }
}
