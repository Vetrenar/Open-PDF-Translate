// ocr-layout.ts — FULLY UPGRADED WITH ITERATIVE CORRECTION & ROBUST JSON REPAIR

import { Notice, TFile, normalizePath, requestUrl } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { 
    OcrProviderSettings, OcrBlock, OcrCacheEntry, 
    OcrCachePageData, ExternalLayoutItem 
} from './types';
import { PageCapture, CapturedPageImage } from './page-capture';

export class OcrLayoutService {
    private plugin: OpenRouterTranslatorPlugin;
    private pageCapture: PageCapture;

    // In-memory cache (loaded from disk on demand)
    private memoryCache: Map<string, OcrCacheEntry> = new Map();
    
    // Track in-progress operations to prevent duplicates
    private activeOperations: Map<string, Promise<any>> = new Map();

    // JSON repair statistics for debugging small-model robustness
    private repairStats = { totalAttempts: 0, successfulRepairs: 0 };

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.pageCapture = new PageCapture(plugin);
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PUBLIC API (unchanged)
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    async hasCachedLayout(filePath: string): Promise<boolean> {
        if (this.memoryCache.has(filePath)) return true;
        const cacheFile = await this.getCacheFile(filePath);
        return cacheFile !== null;
    }

    async getCachedPage(filePath: string, pageNumber: number): Promise<ExternalLayoutItem[] | null> {
        let entry = this.memoryCache.get(filePath);
        if (!entry) {
            entry = await this.loadCacheFromDisk(filePath);
            if (!entry) return null;
        }

        const pageData = entry.pages[pageNumber];
        if (!pageData || !pageData.blocks?.length) return null;

        return pageData.blocks.map(block => ({
            id: block.id,
            text: block.text,
            rect: block.rect,
            fontFamily: block.fontFamily || 'sans-serif',
            fontSize: block.fontSize || 12,
            originalFontSizes: [block.fontSize || 12],
        }));
    }

    async ocrPage(pdfFile: TFile, pageNumber: number, pageElement?: HTMLElement): Promise<ExternalLayoutItem[] | null> {
        const opKey = `${pdfFile.path}:page:${pageNumber}`;
        if (this.activeOperations.has(opKey)) {
            return this.activeOperations.get(opKey)!;
        }

        const operation = this._ocrPageImpl(pdfFile, pageNumber, pageElement);
        this.activeOperations.set(opKey, operation);
        
        try {
            return await operation;
        } finally {
            this.activeOperations.delete(opKey);
        }
    }

    async ocrFullDocument(pdfFile: TFile): Promise<boolean> {
        const opKey = `${pdfFile.path}:full`;
        if (this.activeOperations.has(opKey)) {
            new Notice('Full document OCR already in progress.');
            return false;
        }

        const operation = this._ocrFullDocumentImpl(pdfFile);
        this.activeOperations.set(opKey, operation);
        
        try {
            return await operation;
        } finally {
            this.activeOperations.delete(opKey);
        }
    }

    async clearCache(filePath?: string): Promise<void> {
        if (filePath) {
            this.memoryCache.delete(filePath);
            await this.deleteCacheFile(filePath);
        } else {
            this.memoryCache.clear();
        }
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: Core OCR with Iterative Correction
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    private async _ocrPageImpl(
        pdfFile: TFile, 
        pageNumber: number, 
        pageElement?: HTMLElement
    ): Promise<ExternalLayoutItem[] | null> {
        const ocrSettings = this.plugin.settings.ocrProvider;
        const MAX_PARSE_ATTEMPTS = ocrSettings.provider === 'ollama' ? 2 : 1; // Ollama small models get one retry
        let lastError: string | null = null;

        new Notice(`Ќ Running OCR on page ${pageNumber}...`);

        try {
            // 1. Capture page image or prepare file path
            let image: CapturedPageImage | null = null;
            let absolutePath: string | null = null;

            if (ocrSettings.inputMode === 'image') {
                if (pageElement) {
                    image = this.pageCapture.capturePageElement(pageElement);
                } else {
                    image = await this.pageCapture.capturePageByNumber(pageNumber);
                }
                if (!image) {
                    new Notice('Failed to capture page image.');
                    return null;
                }
            } else {
                absolutePath = this.pageCapture.getAbsolutePdfPath();
                if (!absolutePath) {
                    new Notice('Could not determine PDF file path.');
                    return null;
                }
            }

            // 2. Iterative attempt loop (retry only on parse failure)
            for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS; attempt++) {
                try {
                    // Build prompt (with attempt number for provider-specific tuning)
                    const prompt = attempt > 1 && lastError
                        ? this.buildCorrectionPrompt(
                            ocrSettings.ocrPromptTemplate,
                            lastError,
                            pageNumber,
                            absolutePath,
                            attempt
                        )
                        : this.buildPrompt(
                            ocrSettings.ocrPromptTemplate,
                            pageNumber,
                            absolutePath,
                            this.pageCapture.getTotalPages(),
                            attempt
                        );

                    // Call OCR model
                    const responseText = await this.callOcrModel(prompt, image);
                    if (!responseText) {
                        throw new Error('Empty response from OCR model');
                    }

                    // Parse with robust repair pipeline
                    const blocks = this.parseOcrResponse(responseText, pageNumber, attempt);
                    
                    if (blocks && blocks.length > 0) {
                        // Save to persistent cache
                        await this.upsertPageCache(
                            pdfFile.path, 
                            pageNumber, 
                            blocks, 
                            ocrSettings.model || 'unknown'
                        );

                        // Log repair success in debug mode
                        if (attempt > 1 && this.plugin.settings.debugMode) {
                            this.plugin.logDebug(
                                `✓ OCR parsing succeeded on attempt ${attempt} after repair. ` +
                                `Total repairs today: ${this.repairStats.successfulRepairs}/${this.repairStats.totalAttempts}`
                            );
                        }

                        new Notice(`✓ OCR complete: ${blocks.length} blocks found on page ${pageNumber}.`);

                        return blocks.map(b => ({
                            id: b.id,
                            text: b.text,
                            rect: b.rect,
                            fontFamily: b.fontFamily,
                            fontSize: b.fontSize,
                            originalFontSizes: [b.fontSize],
                        }));
                    } else {
                        throw new Error('Parsed 0 valid text blocks');
                    }
                } catch (parseErr: any) {
                    lastError = parseErr.message || String(parseErr);
                    
                    if (attempt < MAX_PARSE_ATTEMPTS) {
                        
                        this.plugin.logDebug(
                            `⚠ OCR parsing failed (attempt ${attempt}/${MAX_PARSE_ATTEMPTS}). ` +
                            `Retrying with correction prompt... Error: ${lastError.substring(0, 100)}`
                        );
                        
                        // Replace prompt with correction version for next iteration
                        // (We'll reuse the same callOcrModel but with new prompt built inside the loop)
                        // The next loop iteration will rebuild the prompt using attempt=2 and the correction method
                        // We need to make sure buildPrompt is called with attempt=2; correction logic is inside buildCorrectionPrompt.
                        // We'll just continue the loop; the prompt will be rebuilt at the top.
                        
                        await this.sleep(300); // brief delay before retry
                    } else {
                        throw new Error(`OCR parsing failed after ${attempt} attempts: ${lastError}`);
                    }
                }
            }

            return null; // unreachable

        } catch (err: any) {
            console.error('OCR page failed:', err);
            const errorMsg = err.message || 'Unknown OCR error';
            new Notice(`OCR failed: ${errorMsg.substring(0, 100)}`);

            // Log repair stats on failure for diagnostics
            if (this.plugin.settings.debugMode && this.repairStats.totalAttempts > 0) {
                this.plugin.logDebug(
                    `Љ OCR Repair Stats: ${this.repairStats.successfulRepairs}/${this.repairStats.totalAttempts} successful repairs`
                );
            }

            return null;
        }
    }

    private async _ocrFullDocumentImpl(pdfFile: TFile): Promise<boolean> {
        const totalPages = this.pageCapture.getTotalPages();
        if (!totalPages) {
            new Notice('Cannot determine PDF page count. Open the PDF first.');
            return false;
        }

        new Notice(`Ќ Starting full document OCR (${totalPages} pages)...`);

        let successCount = 0;
        let failCount = 0;

        for (let page = 1; page <= totalPages; page++) {
            const existing = await this.getCachedPage(pdfFile.path, page);
            if (existing && existing.length > 0) {
                this.plugin.logDebug(`Page ${page} already cached, skipping.`);
                successCount++;
                continue;
            }

            try {
                new Notice(`OCR page ${page}/${totalPages}...`, 2000);
                const result = await this._ocrPageImpl(pdfFile, page);
                if (result && result.length > 0) {
                    successCount++;
                } else {
                    failCount++;
                }

                if (page < totalPages) {
                    await this.sleep(500);
                }
            } catch (err) {
                console.error(`OCR failed for page ${page}:`, err);
                failCount++;
            }
        }

        if (failCount === 0) {
            new Notice(`✓ Full document OCR complete. ${successCount} pages processed.`);
        } else {
            new Notice(`⚠ OCR done: ${successCount} succeeded, ${failCount} failed.`);
        }

        return failCount === 0;
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: Prompt Engineering (Provider-Aware)
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    private buildPrompt(
        template: string, 
        pageNumber: number, 
        absoluteFilePath: string | null,
        totalPages: number | null,
        attempt: number = 1
    ): string {
        let prompt = template;

        // Replace standard placeholders
        prompt = prompt.replace(/\{\{pageNumber\}\}/g, String(pageNumber));
        prompt = prompt.replace(/\{\{totalPages\}\}/g, String(totalPages || '?'));
        if (absoluteFilePath) {
            prompt = prompt.replace(/\{\{absoluteFilePath\}\}/g, absoluteFilePath);
            prompt = prompt.replace(/\{\{absolutePathtothefile\}\}/g, absoluteFilePath);
        }

        const ocr = this.plugin.settings.ocrProvider;

        // --- Provider-specific enhancements for small models ---
        if (ocr.provider === 'ollama' && attempt === 1) {
            // Inject strict JSON formatting instructions if not already present
            const hasJsonInstruction = /json|format|valid|output/i.test(prompt);
            if (!hasJsonInstruction) {
                prompt += '\n\nCRITICAL FORMATTING RULES:\n' +
                    '- Output ONLY a JSON array starting with [ and ending with ]\n' +
                    '- Use DOUBLE quotes for all strings and keys\n' +
                    '- NO trailing commas\n' +
                    '- NO comments, markdown, or explanatory text\n' +
                    '- If uncertain about coordinates, use best estimate but KEEP JSON VALID\n' +
                    '- Example: [{"id":"b1","text":"Sample","rect":{"l":0.1,"t":0.2,"w":0.3,"h":0.05},"fontSize":12,"fontFamily":"sans-serif"}]';
            }

            // Encourage lower creativity for small models
            if (ocr.temperature > 0.3 && !/7b|8b|13b/i.test(ocr.model || '')) {
                prompt += '\n\nIMPORTANT: Be concise and precise. Avoid creative elaboration.';
            }
        }

        // Append user-defined response format instruction
        const formatInstr = ocr.responseFormatInstruction;
        if (formatInstr) {
            prompt += '\n\n' + formatInstr;
        }

        return prompt;
    }

    private buildCorrectionPrompt(
        baseTemplate: string,
        lastError: string,
        pageNumber: number,
        absoluteFilePath: string | null,
        attempt: number
    ): string {
        // Start with the base prompt (attempt = current retry)
        let prompt = this.buildPrompt(baseTemplate, pageNumber, absoluteFilePath, null, attempt);
        
        // Append targeted correction instructions based on the error
        prompt += `\n\n⚠ PREVIOUS ATTEMPT FAILED ⚠\n` +
            `Error: "${lastError.substring(0, 150)}"\n` +
            `CORRECTION REQUIRED:\n` +
            `- Output ONLY valid JSON array. NO other text.\n` +
            `- Start with [ and end with ]\n` +
            `- Fix these specific issues: ${
                lastError.includes('trailing comma') ? 'Remove trailing commas' : 
                lastError.includes('single quote') ? 'Replace single quotes with double quotes' :
                lastError.includes('Unexpected token') ? 'Fix malformed JSON structure' :
                'Ensure valid JSON syntax'
            }\n` +
            `- If you cannot output perfect JSON, output the BEST POSSIBLE JSON-LIKE STRUCTURE\n` +
            `- I will repair minor formatting errors\n\n` +
            `NOW OUTPUT ONLY THE CORRECTED JSON ARRAY:`;
        
        return prompt;
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: API Communication (Enhanced)
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    /**
     * #23: public entry for true-OCR text mode. Returns RAW transcribed text
     * (no JSON, no coordinates). Used by OcrTextTranslator.
     */
    public async ocrPageText(prompt: string, image: CapturedPageImage | null): Promise<string | null> {
        return this.callOcrModel(prompt, image);
    }

    private async callOcrModel(
        prompt: string, 
        image: CapturedPageImage | null
    ): Promise<string | null> {
        const ocr = this.plugin.settings.ocrProvider;
        const MAX_RETRIES = 2;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const { url, options } = this.buildApiRequest(prompt, image);
                const response = await requestUrl({ url, ...options });

                if (this.plugin.settings.debugMode) {
                    this.plugin.logDebug('=== OCR API RESPONSE ===', {
                        status: response.status,
                        preview: JSON.stringify(response.json, null, 2)?.substring(0, 500) || response.text.substring(0, 500)
                    });
                }

                if (response.status !== 200) {
                    const errMsg = response.json?.error?.message || response.text || `HTTP ${response.status}`;
                    throw new Error(`OCR API HTTP ${response.status}: ${errMsg}`);
                }

                const content = this.extractResponseContent(response.json);
                if (!content || content.trim().length < 10) {
                    throw new Error('Empty or too-short response from model');
                }

                return content;

            } catch (err: any) {
                if (attempt === MAX_RETRIES) throw err;
                this.plugin.logDebug(`⚠ OCR API attempt ${attempt} failed: ${err.message}. Retrying...`);
                await this.sleep(1000 * attempt);
            }
        }

        return null;
    }

    private buildApiRequest(prompt: string, image: CapturedPageImage | null): { url: string; options: any } {
        const ocr = this.plugin.settings.ocrProvider;
        let url: string;
        let headers: Record<string, string> = { 'Content-Type': 'application/json' };
        let body: any;

        switch (ocr.provider) {
            case 'openrouter': {
                if (!ocr.apiKey) throw new Error('OCR: OpenRouter API key is missing.');
                url = 'https://openrouter.ai/api/v1/chat/completions';
                headers['Authorization'] = `Bearer ${ocr.apiKey}`;
                headers['HTTP-Referer'] = 'https://obsidian.md';

                const messages: any[] = [];
                if (image) {
                    messages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }
                        ]
                    });
                } else {
                    messages.push({ role: 'user', content: prompt });
                }

                body = {
                    model: ocr.model,
                    messages,
                    temperature: ocr.temperature ?? 0.1,
                    max_tokens: ocr.maxTokens ?? 8192,
                };
                break;
            }
            case 'openai': {
                if (!ocr.apiKey) throw new Error('OCR: OpenAI API key is missing.');
                url = 'https://api.openai.com/v1/chat/completions';
                headers['Authorization'] = `Bearer ${ocr.apiKey}`;

                const messages: any[] = [];
                if (image) {
                    messages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: 'high' } }
                        ]
                    });
                } else {
                    messages.push({ role: 'user', content: prompt });
                }

                body = {
                    model: ocr.model || 'gpt-4o',
                    messages,
                    temperature: ocr.temperature ?? 0.1,
                    max_tokens: ocr.maxTokens ?? 8192,
                };
                break;
            }
            case 'gemini': {
                if (!ocr.apiKey) throw new Error('OCR: Gemini API key is missing.');
                const model = (ocr.model || 'gemini-1.5-flash').replace('models/', '');
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ocr.apiKey}`;

                const parts: any[] = [{ text: prompt }];
                if (image) {
                    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
                }

                body = {
                    contents: [{ parts }],
                    generationConfig: {
                        temperature: ocr.temperature ?? 0.1,
                        maxOutputTokens: ocr.maxTokens ?? 8192,
                    }
                };
                break;
            }
            case 'ollama': {
                const endpoint = (ocr.apiEndpoint || 'http://localhost:11434').replace(/\/$/, '');
                url = `${endpoint}/api/chat`;

                const messages: any[] = [{
                    role: 'user',
                    content: prompt,
                    ...(image ? { images: [image.base64] } : {})
                }];

                body = {
                    model: ocr.model || 'llava',
                    stream: false,
                    messages,
                    options: {
                        temperature: ocr.temperature ?? 0.1,
                        num_predict: ocr.maxTokens ?? 8192,
                    }
                };
                break;
            }
            case 'custom': {
                if (!ocr.apiEndpoint) throw new Error('OCR: Custom API endpoint is missing.');
                url = ocr.apiEndpoint;

                if (ocr.headers) {
                    try {
                        const parsed = JSON.parse(ocr.headers.replace(/\{apiKey\}/g, ocr.apiKey || ''));
                        headers = { ...headers, ...parsed };
                    } catch {
                        throw new Error('OCR: Failed to parse custom headers.');
                    }
                }

                if (ocr.requestBody) {
                    const imageB64 = image?.base64 || '';
                    const populated = ocr.requestBody
                        .replace(/\{model\}/g, ocr.model || '')
                        .replace(/\{prompt\}/g, this.escapeJsonString(prompt))
                        .replace(/\{imageBase64\}/g, imageB64)
                        .replace(/\{imageMimeType\}/g, image?.mimeType || '')
                        .replace(/\{temperature\}/g, String(ocr.temperature ?? 0.1))
                        .replace(/\{maxTokens\}/g, String(ocr.maxTokens ?? 8192));
                    try {
                        body = JSON.parse(populated);
                    } catch {
                        throw new Error('OCR: Failed to parse custom request body.');
                    }
                } else {
                    throw new Error('OCR: Custom request body is missing.');
                }
                break;
            }
            default:
                throw new Error(`OCR: Unsupported provider "${ocr.provider}".`);
        }

        return {
            url,
            options: {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                throw: false,
            }
        };
    }

    private extractResponseContent(json: any): string | null {
        const ocr = this.plugin.settings.ocrProvider;

        if (ocr.responseJsonPath) {
            return this.getByPath(json, ocr.responseJsonPath) || null;
        }

        switch (ocr.provider) {
            case 'openrouter':
            case 'openai':
                return json?.choices?.[0]?.message?.content || null;
            case 'gemini':
                return json?.candidates?.[0]?.content?.parts?.[0]?.text || null;
            case 'ollama':
                return json?.message?.content || null;
            case 'custom':
                return json?.choices?.[0]?.message?.content || JSON.stringify(json);
            default:
                return null;
        }
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: Robust JSON Parsing & Repair Pipeline
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    private parseOcrResponse(rawResponse: string, pageNumber: number, attempt: number = 1): OcrBlock[] {
        this.repairStats.totalAttempts++;
        const originalResponse = rawResponse.trim();

        if (this.plugin.settings.debugMode) {
            this.plugin.logDebug(`Ќ Parsing OCR response (attempt ${attempt})`, {
                rawLength: originalResponse.length,
                preview: originalResponse.substring(0, 200)
            });
        }

        // STEP 1: Extract JSON candidate region
        let candidate = this.extractJsonCandidate(originalResponse);

        // STEP 2: Progressive repair strategies
        const repairStrategies = [
            { name: 'raw', fn: (s: string) => s },
            { name: 'clean-control-chars', fn: this.removeInvalidControlChars },
            { name: 'fix-common-errors', fn: this.fixCommonJsonErrors },
            { name: 'wrap-as-array', fn: this.wrapAsArrayIfNecessary },
            { name: 'extract-brackets', fn: this.extractBracketsContent },
            { name: 'aggressive-repair', fn: this.aggressiveJsonRepair }
        ];

        for (const { name, fn } of repairStrategies) {
            try {
                const repaired = fn(candidate);
                const parsed = JSON.parse(repaired);
                const blocks = this.normalizeToBlocks(parsed, pageNumber);

                if (blocks.length > 0) {
                    if (name !== 'raw' && this.plugin.settings.debugMode) {
                        this.plugin.logDebug(`✓ JSON repaired successfully using strategy: "${name}"`);
                    }
                    if (name !== 'raw') this.repairStats.successfulRepairs++;
                    return blocks;
                }
            } catch (e: any) {
                if (this.plugin.settings.debugMode) {
                    this.plugin.logDebug(`⚠ Strategy "${name}" failed: ${e.message?.substring(0, 80)}`);
                }
                continue;
            }
        }

        // STEP 3: Fallback text extraction (only on first attempt)
        if (attempt === 1) {
            const fallbackBlocks = this.fallbackTextExtraction(originalResponse, pageNumber);
            if (fallbackBlocks.length > 0) {
                this.plugin.logDebug('⚠ Using fallback text extraction (no positional data)');
                return fallbackBlocks;
            }
        }

        // STEP 4: Total failure – provide actionable error
        const errorMessage = this.generateParseErrorMessage(originalResponse);
        console.error('вќЊ OCR JSON parsing failed after all repair strategies:', {
            errorMessage,
            rawPreview: originalResponse.substring(0, 500)
        });

        throw new Error(errorMessage);
    }

    // --- JSON Repair Helpers ---
    private extractJsonCandidate(text: string): string {
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenceMatch?.[1]) return fenceMatch[1].trim();

        const arrayMatch = text.match(/\[([\s\S]{50,}?)\]/);
        if (arrayMatch?.[0]) return arrayMatch[0];

        const objMatch = text.match(/\{([\s\S]{50,}?)\}/);
        if (objMatch?.[0]) return objMatch[0];

        return text.trim();
    }

    private removeInvalidControlChars = (jsonStr: string): string => {
        return jsonStr.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
    };

    private fixCommonJsonErrors = (jsonStr: string): string => {
        let fixed = jsonStr;
        fixed = fixed.replace(/,(\s*[}\]])/g, '$1'); // trailing commas

        const structuralKeys = ['id', 'text', 'rect', 'fontSize', 'fontFamily', 'confidence', 'blockType',
                               'l', 't', 'w', 'h', 'left', 'top', 'width', 'height', 'bbox', 'bounds'];
        structuralKeys.forEach(key => {
            const regex = new RegExp(`([,{\\s])${key}([\\s]*:)(?!")`, 'g');
            fixed = fixed.replace(regex, `$1"${key}"$2`);
        });

        fixed = fixed
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bNone\b/g, 'null')
            .replace(/\\?'/g, '"')
            .replace(/\\"/g, '"')
            .replace(/""/g, '"');

        return fixed;
    };

    private wrapAsArrayIfNecessary = (jsonStr: string): string => {
        const trimmed = jsonStr.trim();
        if (trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            return `[${trimmed}]`;
        }
        return trimmed;
    };

    private extractBracketsContent = (jsonStr: string): string => {
        const arrayStart = jsonStr.indexOf('[');
        const arrayEnd = jsonStr.lastIndexOf(']');
        if (arrayStart !== -1 && arrayEnd > arrayStart) {
            return jsonStr.substring(arrayStart, arrayEnd + 1);
        }
        const objStart = jsonStr.indexOf('{');
        const objEnd = jsonStr.lastIndexOf('}');
        if (objStart !== -1 && objEnd > objStart) {
            return jsonStr.substring(objStart, objEnd + 1);
        }
        return jsonStr;
    };

    private aggressiveJsonRepair = (jsonStr: string): string => {
        const arrayStart = jsonStr.search(/\[/);
        if (arrayStart !== -1) jsonStr = jsonStr.substring(arrayStart);
        const arrayEnd = jsonStr.lastIndexOf(']');
        if (arrayEnd !== -1 && arrayEnd < jsonStr.length - 1) jsonStr = jsonStr.substring(0, arrayEnd + 1);
        return this.fixCommonJsonErrors(jsonStr);
    };

    // --- Normalization & Fallback ---
    private normalizeToBlocks(parsed: any, pageNumber: number): OcrBlock[] {
        let blocks: any[] = [];

        if (Array.isArray(parsed)) {
            blocks = parsed;
        } else if (parsed.blocks && Array.isArray(parsed.blocks)) {
            blocks = parsed.blocks;
        } else if (parsed.pages) {
            const pageKey = String(pageNumber);
            const pageData = parsed.pages[pageKey] || parsed.pages[pageNumber - 1] || parsed.pages[`page_${pageNumber}`];
            if (pageData) {
                blocks = Array.isArray(pageData) ? pageData : (pageData.blocks || []);
            }
        } else if (typeof parsed === 'object' && parsed.text) {
            blocks = [parsed];
        }

        return blocks
            .map((raw, index) => this.normalizeBlock(raw, index))
            .filter((b): b is OcrBlock => b !== null && b.text.trim().length > 0);
    }

    private normalizeBlock(raw: any, index: number): OcrBlock | null {
        if (!raw || typeof raw !== 'object') return null;

        const text = (raw.text || raw.content || raw.value || '').trim();
        if (!text) return null;

        let rect = { l: 0, t: 0, w: 0, h: 0 };
        if (raw.rect && typeof raw.rect === 'object') {
            rect = {
                l: raw.rect.l ?? raw.rect.left ?? raw.rect.x ?? 0,
                t: raw.rect.t ?? raw.rect.top ?? raw.rect.y ?? 0,
                w: raw.rect.w ?? raw.rect.width ?? 0,
                h: raw.rect.h ?? raw.rect.height ?? 0,
            };
        } else if (raw.bbox && Array.isArray(raw.bbox) && raw.bbox.length === 4) {
            const [x1, y1, x2, y2] = raw.bbox;
            rect = { l: x1, t: y1, w: x2 - x1, h: y2 - y1 };
        } else if (raw.bounds && typeof raw.bounds === 'object') {
            rect = {
                l: raw.bounds.left ?? raw.bounds.x ?? 0,
                t: raw.bounds.top ?? raw.bounds.y ?? 0,
                w: raw.bounds.width ?? raw.bounds.w ?? 0,
                h: raw.bounds.height ?? raw.bounds.h ?? 0,
            };
        }

        // Detect whether the model actually supplied coordinates (vs our 0,0,0,0 default).
        const hasRect = !!(
            (raw.rect && typeof raw.rect === 'object') ||
            (raw.bbox && Array.isArray(raw.bbox) && raw.bbox.length === 4) ||
            (raw.bounds && typeof raw.bounds === 'object')
        );
        const validRect = hasRect && rect.w > 0.001 && rect.h > 0.001;

        // Warn about non-normalized coordinates (common with filepath mode)
        if ((rect.l > 2 || rect.t > 2 || rect.w > 2 || rect.h > 2) && this.plugin.settings.debugMode) {
            this.plugin.logDebug(
                `⚠ Block "${text.substring(0, 20)}" has non-normalized coords. Expected 0-1 range, got:`,
                rect
            );
        }
        if (!validRect && this.plugin.settings.debugMode) {
            this.plugin.logDebug(`⚠ Block "${text.substring(0, 20)}" has no usable coordinates (model omitted rect).`);
        }

        return {
            id: raw.id || `ocr-block-${Date.now()}-${index}`,
            text,
            rect,
            hasValidRect: validRect,
            fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : typeof raw.font_size === 'number' ? raw.font_size : 12,
            fontFamily: raw.fontFamily || raw.font_family || 'sans-serif',
            confidence: raw.confidence,
            blockType: raw.blockType || raw.type || 'text',
        };
    }

    private fallbackTextExtraction(rawResponse: string, pageNumber: number): OcrBlock[] {
        const lines = rawResponse
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !/^\s*[\[\]{}]/.test(l));

        if (lines.length === 0) return [];

        const lineHeight = 0.03;
        return lines.map((line, index) => ({
            id: `fallback-${pageNumber}-${index}`,
            text: line,
            rect: { l: 0.05, t: 0.1 + (index * lineHeight), w: 0.9, h: lineHeight },
            fontSize: 12,
            fontFamily: 'sans-serif',
            blockType: 'text',
        }));
    }

    private generateParseErrorMessage(rawResponse: string): string {
        const preview = rawResponse.substring(0, 300).replace(/\s+/g, ' ');
        const issues: string[] = [];

        if (/```/.test(rawResponse)) issues.push('contained markdown code fences');
        if (/'/.test(rawResponse)) issues.push('used single quotes instead of double quotes');
        if (/,\s*[}\]]/.test(rawResponse)) issues.push('had trailing commas');
        if (!/\[.*\]/.test(rawResponse) && !/\{.*\}/.test(rawResponse)) {
            issues.push('did not contain valid JSON structure');
        }

        return `Invalid JSON response${issues.length ? ` (${issues.join(', ')})` : ''}. Preview: "${preview}..." (Full response in console)`;
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: Persistent Cache (Disk I/O)
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    private getCacheFilePath(pdfVaultPath: string): string {
        const baseName = pdfVaultPath.replace(/\.pdf$/i, '');
        const fileName = baseName.split('/').pop()!;
        const storageDir = this.plugin.settings.storageLocation;
        if (storageDir) {
            return normalizePath(`${storageDir}${fileName}.ocr-cache.json`);
        }
        const pdfDir = pdfVaultPath.substring(0, pdfVaultPath.lastIndexOf('/'));
        return normalizePath(`${pdfDir}/${fileName}.ocr-cache.json`);
    }

    private async loadCacheFromDisk(pdfVaultPath: string): Promise<OcrCacheEntry | null> {
        const cachePath = this.getCacheFilePath(pdfVaultPath);
        try {
            const file = this.plugin.app.vault.getAbstractFileByPath(cachePath);
            if (!(file instanceof TFile)) return null;
            const content = await this.plugin.app.vault.read(file);
            const parsed = JSON.parse(content) as OcrCacheEntry;
            this.memoryCache.set(pdfVaultPath, parsed);
            this.plugin.logDebug(`Loaded OCR cache from disk: ${cachePath}`);
            return parsed;
        } catch {
            return null;
        }
    }

    private async writeCacheToDisk(pdfVaultPath: string, entry: OcrCacheEntry): Promise<void> {
        const cachePath = this.getCacheFilePath(pdfVaultPath);
        const content = JSON.stringify(entry, null, 2);

        const dir = cachePath.substring(0, cachePath.lastIndexOf('/'));
        if (dir) await this.ensureDirectory(dir);

        const existing = this.plugin.app.vault.getAbstractFileByPath(cachePath);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, content);
        } else {
            await this.plugin.app.vault.create(cachePath, content);
        }

        this.plugin.logDebug(`Saved OCR cache to disk: ${cachePath}`);
    }

    private async upsertPageCache(
        pdfVaultPath: string,
        pageNumber: number,
        blocks: OcrBlock[],
        modelId: string
    ): Promise<void> {
        let entry = this.memoryCache.get(pdfVaultPath);
        if (!entry) {
            entry = await this.loadCacheFromDisk(pdfVaultPath) || {
                version: 1,
                pdfPath: pdfVaultPath,
                generatedAt: new Date().toISOString(),
                modelId,
                totalPages: this.pageCapture.getTotalPages() || 0,
                pages: {},
            };
        }

        entry.pages[pageNumber] = {
            pageNumber,
            ocrTimestamp: new Date().toISOString(),
            blocks,
        };

        this.memoryCache.set(pdfVaultPath, entry);
        await this.writeCacheToDisk(pdfVaultPath, entry);
    }

    private async getCacheFile(pdfVaultPath: string): Promise<TFile | null> {
        const cachePath = this.getCacheFilePath(pdfVaultPath);
        const file = this.plugin.app.vault.getAbstractFileByPath(cachePath);
        return file instanceof TFile ? file : null;
    }

    private async deleteCacheFile(pdfVaultPath: string): Promise<void> {
        const file = await this.getCacheFile(pdfVaultPath);
        if (file) {
            await this.plugin.app.vault.delete(file);
            this.plugin.logDebug(`Deleted OCR cache: ${file.path}`);
        }
    }

    private async ensureDirectory(dirPath: string): Promise<void> {
        const parts = dirPath.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += (current ? '/' : '') + part;
            const existing = this.plugin.app.vault.getAbstractFileByPath(current);
            if (!existing) {
                try { await this.plugin.app.vault.createFolder(current); } catch {}
            }
        }
    }

    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
    // PRIVATE: Utilities
    // в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

    private getByPath(obj: any, path: string): string | undefined {
        const keys = path.replace(/\[(\w+)\]/g, '.$1').split('.');
        let result = obj;
        for (const key of keys) {
            if (!result) return undefined;
            result = result[key];
        }
        return typeof result === 'string' ? result : undefined;
    }

    private escapeJsonString(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                  .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}

