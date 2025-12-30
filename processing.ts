
// processing.ts
import { Notice } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { TranslationUnit } from './types';
import { LayoutDetector, LayoutSettings } from './layout-detector';

export class TextProcessor {
  private plugin: OpenRouterTranslatorPlugin;
  public layoutDetector: LayoutDetector;

  // Caches
  private measurementCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();
  private styleCache = new Map<HTMLElement, CSSStyleDeclaration>();
  private colorDistanceCache = new Map<string, number>();
  private lastPreparedUnits: { pageElement: HTMLElement, units: TranslationUnit[] } | null = null;

  // State
  private overlayContainers: HTMLElement[] = [];
  private translationFailures: { segmentIndex: number; error: string }[] = [];
  private lastColumnAnalysis: { edgeCols: DOMRect[]; gapCols: DOMRect[] } | null = null;

  constructor(plugin: OpenRouterTranslatorPlugin) {
    this.plugin = plugin;
    this.layoutDetector = new LayoutDetector(this.plugin.settings.layoutSettings);
  }

  /**
   * Updates the LayoutDetector instance with new settings.
   * @param newSettings The new LayoutSettings object from the modal.
   */
  public updateLayoutDetectorSettings(newSettings: LayoutSettings): void {
    console.log("Updating LayoutDetector with new settings:", newSettings);
    this.layoutDetector = new LayoutDetector(newSettings);
    new Notice('Layout detection settings have been updated.');
  }

  /**
   * Main entry point for the "Translate Page" command.
   */
  public async addTextOverlay() {
    const currentPage = this.plugin.overlay.getCurrentPageElement();
    if (currentPage) {
      await this.addOverlayToPage(currentPage);
    } else {
      new Notice('No active PDF page found.');
    }
  }

  /**
   * Orchestrates the entire translation and rendering process for a single page.
   * @param pageElement The .page element to add the overlay to.
   */
  public async addOverlayToPage(pageElement: HTMLElement) {
    try {
      const translatedText = await this.translatePageContent(pageElement);
      if (translatedText) {
        await this.createOverlayWithText(pageElement, translatedText);
        const successfulTranslations = translatedText.split('\n').filter(line => line !== 'Translation missing').length;
        new Notice(`✅ Translation complete. Rendered ${successfulTranslations} segment(s).`, 3000);
      }
    } catch (error: any) {
        console.error("addOverlayToPage process failed:", error);
        new Notice(`⚠️ Translation failed: ${error.message}`, 4000);
    }
  }

  /**
   * Extracts text, gets the translation, but does NOT modify the DOM.
   * @param pageElement The .page element to process.
   * @returns A single string containing all translated text, or null if failed.
   */
  public async translatePageContent(pageElement: HTMLElement): Promise<string | null> {
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    if (!textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      return null;
    }

    const translationUnits = this.prepareTranslationUnits(textLayer, pageElement);
    if (!translationUnits || translationUnits.length === 0) {
      new Notice('No valid text to translate.', 2000);
      return null;
    }

    this.lastPreparedUnits = { pageElement, units: [...translationUnits] };
    const translatedLines = await this.executeTranslation(translationUnits);
    return translatedLines.join('\n');
  }

  /**
   * Creates an overlay on the page using pre-translated text.
   * @param pageElement The .page element to add the overlay to.
   * @param translatedText A single string of translated text, with lines separated by '\n'.
   */
  public async createOverlayWithText(pageElement: HTMLElement, translatedText: string): Promise<void> {
    const prepResult = this.validateAndPreparePrerequisites(pageElement);
    if (!prepResult) return;
    const { textLayer, overlayContainer } = prepResult;
    this.overlayContainers.push(overlayContainer);

    let translationUnits = (this.lastPreparedUnits?.pageElement === pageElement)
        ? this.lastPreparedUnits.units
        : this.prepareTranslationUnits(textLayer, pageElement);

    if (!translationUnits || translationUnits.length === 0) {
        overlayContainer.remove();
        return;
    }

    const translatedLines = translatedText.split('\n');
    if (translatedLines.length !== translationUnits.length) {
        console.error('Translation structure mismatch. Original units:', translationUnits.length, 'Translated lines:', translatedLines.length);
        new Notice('⚠️ Error: Translation structure mismatch. Cannot create overlay.');
        overlayContainer.remove();
        return;
    }

    this.renderOverlay(translationUnits, translatedLines, overlayContainer, pageElement);

    if (this.plugin.settings.autoSaveOverlay) {
        requestAnimationFrame(() => this.plugin.overlay.saveCurrentPageOverlay());
    }
  }

  // ————————————————————————————————————————————————
  // CORE LOGIC (Now more modular for reuse)
  // ————————————————————————————————————————————————

  private validateAndPreparePrerequisites(pageElement: HTMLElement): { textLayer: HTMLElement; overlayContainer: HTMLElement } | null {
    if (!this.validatePageElement(pageElement)) {
      new Notice('Invalid page element');
      return null;
    }
    const overlayContainer = this.plugin.overlay.preparePageForOverlay(pageElement);
    const textLayer = pageElement.querySelector('.textLayer') as HTMLElement;
    if (!textLayer) {
      new Notice('Text layer not found. Wait for PDF to fully render.');
      overlayContainer.remove();
      return null;
    }
    return { textLayer, overlayContainer };
  }

  /**
   * MODIFIED: Now a public method that can accept either the textLayer element
   * to process a whole page, or a specific array of spans for reprocessing.
   * @param textLayerOrSpans The parent .textLayer element OR an array of HTMLSpanElement.
   * @param pageElement The root .page element for context.
   * @returns An array of TranslationUnit[] or null.
   */
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

      if (this.plugin.settings.debugMode) {
        console.log(`PDF Translator: Paragraph ${paraIndex} is too long, splitting into sentences.`);
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

  /**
   * MODIFIED: Now a public method.
   * Executes the translation process for a given set of text units.
   * @param units The text units to be translated.
   * @returns A promise that resolves to an array of translated strings.
   */
  public async executeTranslation(units: TranslationUnit[]): Promise<string[]> {
    this.translationFailures = [];
    const fullText = units.map((u, i) => `${i + 1}. ${u.text}`).join('\n');
    const { useBatchTranslation: useBatch, maxBatchChars } = this.plugin.settings;
    
    const shouldUseChunking = useBatch && units.length > 1 && fullText.length > maxBatchChars;

    try {
        let translatedLines: string[];
        if (shouldUseChunking) {
            new Notice(`Long page detected. Translating in multiple batches...`, 4000);
            translatedLines = await this.performChunkedTranslation(units, maxBatchChars);
        } else if (useBatch && units.length > 1) {
            new Notice(`Translating ${units.length} segments in a batch...`, 3000);
            const raw = await this.plugin.translation.translateBatch(fullText, units.length);
            translatedLines = this.extractNumberedLines(raw, units.length);
        } else {
            new Notice(`Translating ${units.length} segment(s) sequentially...`, 3000);
            translatedLines = await this.performSequentialTranslation(units);
        }

      const missingCount = translatedLines.filter(t => t === 'Translation missing').length;
      if (missingCount > 0.5 * units.length && units.length > 1) {
        new Notice('⚠️ Invalid response. Falling back to original text.');
        return units.map(u => u.text);
      } else if (missingCount > 0) {
        new Notice(`⚠️ ${missingCount} segments failed translation. See console for details.`);
        this.reportTranslationFailures(units, translatedLines);
      }
      return translatedLines;
    } catch (err: any) {
      this.plugin.logDebug('Translation failed:', err);
      this.translationFailures.push({
        segmentIndex: -1,
        error: `Batch translation failed: ${err.message || 'Unknown error'}`,
      });
      throw err;
    }
  }
  
  private async performChunkedTranslation(units: TranslationUnit[], maxChunkChars: number): Promise<string[]> {
    const allTranslatedLines: string[] = Array(units.length).fill('Translation missing');
    interface Chunk { text: string; originalIndices: number[]; }

    const endsWithSentenceTerminator = (htmlText: string): boolean => {
        const trimmed = htmlText.trim();
        if (trimmed.endsWith('<br>')) return true;
        const regex = /[.?!](?:\s*<\/[bi]>)*\s*$/;
        return regex.test(trimmed);
    };

    const chunks: Chunk[] = [];
    let currentChunkText = '';
    let currentChunkIndices: number[] = [];

    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const line = `${currentChunkIndices.length + 1}. ${unit.text}\n`;

        if (currentChunkText.length + line.length > maxChunkChars && currentChunkText.length > 0) {
            const lastUnitIndex = currentChunkIndices[currentChunkIndices.length - 1];
            const lastUnit = units[lastUnitIndex];

            if (currentChunkIndices.length > 1 && !endsWithSentenceTerminator(lastUnit.text)) {
                currentChunkIndices.pop();
                const newChunkText = currentChunkIndices.map((originalIndex, newIndex) => `${newIndex + 1}. ${units[originalIndex].text}`).join('\n');
                chunks.push({ text: newChunkText, originalIndices: [...currentChunkIndices] });
                currentChunkText = '';
                currentChunkIndices = [];
                i = lastUnitIndex - 1;
                continue; 
            } else {
                chunks.push({ text: currentChunkText.trim(), originalIndices: [...currentChunkIndices] });
                currentChunkText = '';
                currentChunkIndices = [];
            }
        }
        currentChunkText += `${currentChunkIndices.length + 1}. ${unit.text}\n`;
        currentChunkIndices.push(i);
    }
    
    if (currentChunkText.length > 0) {
        chunks.push({ text: currentChunkText.trim(), originalIndices: currentChunkIndices });
    }

    if (this.plugin.settings.debugMode) {
        console.log(`PDF Translator: Splitting translation into ${chunks.length} chunks.`);
    }

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            new Notice(`Translating batch ${i + 1} of ${chunks.length}...`);
            const raw = await this.plugin.translation.translateBatch(chunk.text, chunk.originalIndices.length);
            const translatedChunkLines = this.extractNumberedLines(raw, chunk.originalIndices.length);
            for (let j = 0; j < translatedChunkLines.length; j++) {
                const originalIndex = chunk.originalIndices[j];
                if (originalIndex !== undefined) allTranslatedLines[originalIndex] = translatedChunkLines[j];
            }
        } catch (error: any) {
            this.plugin.logDebug(`Translation for chunk ${i+1} failed:`, error);
            new Notice(`⚠️ Batch ${i+1} failed. Original text will be used for that section.`);
            chunk.originalIndices.forEach(originalIndex => { allTranslatedLines[originalIndex] = units[originalIndex].text; });
        }
    }
    return allTranslatedLines;
  }
  
  private renderOverlay(units: TranslationUnit[], translatedLines: string[], overlayContainer: HTMLElement, pageElement: HTMLElement) {
    const reassembledParagraphs = new Map<string, { originalSpans: HTMLSpanElement[]; translatedText: string; }>();
    units.forEach((unit, index) => {
      const { paragraphId, originalSpans } = unit;
      const translatedLine = translatedLines[index];
      if (!reassembledParagraphs.has(paragraphId)) reassembledParagraphs.set(paragraphId, { originalSpans: [], translatedText: '' });
      const group = reassembledParagraphs.get(paragraphId)!;
      group.originalSpans.push(...originalSpans);
      group.translatedText += (group.translatedText ? ' ' : '') + translatedLine;
    });

    const mergedUnits: TranslationUnit[] = [];
    const mergedTranslatedLines: string[] = [];
    reassembledParagraphs.forEach((group, paragraphId) => {
      mergedUnits.push({ id: paragraphId, paragraphId: paragraphId, originalSpans: group.originalSpans, text: '' });
      mergedTranslatedLines.push(group.translatedText);
    });

    this.plugin.overlay.renderOverlays(mergedUnits, mergedTranslatedLines, overlayContainer, pageElement);
  }

  private spansToHtml(spans: HTMLSpanElement[]): string {
    if (!spans?.length) return '';
    const lines = new Map<number, HTMLSpanElement[]>();
    spans.forEach(span => {
      const lineKey = Math.round(this.getBoundingClientRectCached(span).top);
      if (!lines.has(lineKey)) lines.set(lineKey, []);
      lines.get(lineKey)!.push(span);
    });
    return Array.from(lines.entries()).sort((a, b) => a[0] - b[0]).map(([_, lineSpans]) => lineSpans.sort((a, b) => this.getBoundingClientRectCached(a).left - this.getBoundingClientRectCached(b).left).map(span => {
      const style = this.getComputedStyleCached(span);
      let content = this.escapeHtml(span.textContent || '');
      const isBold = parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold';
      if (isBold) content = `<b>${content}</b>`;
      if (style.fontStyle === 'italic') content = `<i>${content}</i>`;
      return content;
    }).join(' ')).join('<br>');
  }

  private escapeHtml(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }

  private extractNumberedLines(rawText: string, expectedCount: number): string[] {
    const lines: string[] = Array(expectedCount).fill('Translation missing');
    const regex = /^\s*(\d+)\.\s+(.+?)(?:\n|$)/gm;
    let match, found = 0;
    while ((match = regex.exec(rawText)) !== null) {
      const num = parseInt(match[1], 10) - 1;
      if (num >= 0 && num < expectedCount) {
        lines[num] = match[2].trim();
        found++;
      }
    }
    if (found < expectedCount * 0.5 && found < expectedCount) {
      const rawLines = rawText.trim().split('\n').map(l => l.trim().replace(/^\s*\d+\.\s*/, ''));
      if (rawLines.length === expectedCount) return rawLines;
      for (let i = 0; i < Math.min(rawLines.length, expectedCount); i++) lines[i] = rawLines[i];
    }
    return lines;
  }

  public isValidSpan(span: HTMLSpanElement): boolean {
    const rect = this.getBoundingClientRectCached(span);
    const text = (span.textContent || '').trim();
    if (rect.width <= 1 || rect.height <= 1 || !text) return false;
    if (/^\d{1,3}$/.test(text)) return false;
    if (text.length === 1 && /[•\-•»«]/.test(text)) return false;
    if (text.startsWith('http')) return false;
    return true;
  }

  private validateSpans(spans: HTMLSpanElement[]): HTMLSpanElement[] { return spans.filter(span => span instanceof HTMLSpanElement && span.isConnected); }
  private validatePageElement(pageElement: HTMLElement): boolean { return pageElement instanceof HTMLElement && pageElement.isConnected; }
  private getBoundingClientRectCached(element: HTMLElement): DOMRect {
    const now = Date.now();
    const cached = this.measurementCache.get(element);
    if (cached && now - cached.timestamp < 100) return cached.rect;
    const rect = element.getBoundingClientRect();
    this.measurementCache.set(element, { rect, timestamp: now });
    return rect;
  }
  private getComputedStyleCached(element: HTMLElement): CSSStyleDeclaration { return this.styleCache.get(element) || this.styleCache.set(element, window.getComputedStyle(element)).get(element)!; }
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
      left = Math.min(left, rect.left); top = Math.min(top, rect.top); right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
      const style = this.getComputedStyleCached(span);
      fontSizes.push(parseFloat(style.fontSize) || 12);
      if (fontFamily === 'sans-serif' && style.fontFamily) fontFamily = style.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    }
    if (!isFinite(left)) return { rect: null, fontSizes: [], avgFontSize: 12, fontFamily };
    const rect = new DOMRect(left - pageRect.left, top - pageRect.top, right - left, bottom - top);
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length || 12;
    return { rect, fontSizes, avgFontSize, fontFamily };
  }

  private async performSequentialTranslation(units: TranslationUnit[]): Promise<string[]> {
    return Promise.all(units.map(async (unit, i) => {
      try { return await this.plugin.translation.translateWithOpenRouter(unit.text); }
      catch (error: any) {
        this.plugin.logDebug(`Translation failed for segment ${i}:`, error);
        this.translationFailures.push({ segmentIndex: i, error: error.message || 'Unknown error' });
        return "Translation missing";
      }
    }));
  }

  private reportTranslationFailures(units: TranslationUnit[], translatedLines: string[]): void {
    this.translationFailures.forEach(({ segmentIndex, error }) => {
      if (segmentIndex >= 0) this.plugin.logDebug(`Segment ${segmentIndex + 1} failed:`, error, `Original: "${units[segmentIndex].text.substring(0, 100)}..."`);
      else this.plugin.logDebug(`Batch translation failed:`, error);
    });
    for (let i = 0; i < translatedLines.length; i++) {
      if (translatedLines[i] === 'Translation missing') {
        this.plugin.logDebug(`Segment ${i + 1} was missing from the batch response. Original: "${units[i].text.substring(0, 100)}..."`);
        translatedLines[i] = units[i].text;
      }
    }
  }

  public cleanup(): void {
    this.overlayContainers.forEach(container => container.remove());
    this.overlayContainers = [];
    this.clearCaches();
    this.translationFailures = [];
    this.lastColumnAnalysis = null;
    this.lastPreparedUnits = null;
  }
}