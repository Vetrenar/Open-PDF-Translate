// translation.ts
import { requestUrl, Notice, RequestUrlParam } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { AVAILABLE_LANGUAGES } from './types';

// The template definition (Fallback if not in types.ts)
export const GEMMA_TEMPLATE = `You are a professional {SOURCE_LANG} ({SOURCE_CODE}) to {TARGET_LANG} ({TARGET_CODE}) translator. Your goal is to accurately convey the meaning and nuances of the original {SOURCE_LANG} text while adhering to {TARGET_LANG} grammar, vocabulary, and cultural sensitivities.
Produce only the {TARGET_LANG} translation, without any additional explanations or commentary. Please translate the following {SOURCE_LANG} text into {TARGET_LANG}:

{TEXT}`;

export class TranslationEngine {
    private plugin: OpenRouterTranslatorPlugin;
    private warnedAboutQwen = false;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
    }

    // === Language Helpers ===

    getSourceLangName(): string {
        return this.plugin.settings.sourceLanguage === 'auto'
            ? 'Auto-detect'
            : AVAILABLE_LANGUAGES.find(l => l.code === this.plugin.settings.sourceLanguage)?.name || this.plugin.settings.sourceLanguage;
    }

    getSourceLangCode(): string {
        return this.plugin.settings.sourceLanguage;
    }

    getTargetLangName(): string {
        return AVAILABLE_LANGUAGES.find(l => l.code === this.plugin.settings.targetLanguage)?.name || this.plugin.settings.targetLanguage;
    }

    getTargetLangCode(): string {
        return this.plugin.settings.targetLanguage;
    }

    // === Template Processing ===

    /**
     * Replaces placeholders in the prompt template.
     * Supports both standard Plugin variables and Custom/Gemma variables.
     */
    private applyTemplateVariables(template: string, textContent: string, lineCount: number = 0): string {
        return template
            // Standard Plugin Variables
            .replace(/{sourceLang}/g, this.getSourceLangName())
            .replace(/{targetLang}/g, this.getTargetLangName())
            .replace(/{lineCount}/g, lineCount.toString())
            .replace(/{inputText}/g, textContent)
            
            // Custom / Gemma Variables (UPPERCASE)
            .replace(/{SOURCE_LANG}/g, this.getSourceLangName())
            .replace(/{TARGET_LANG}/g, this.getTargetLangName())
            .replace(/{SOURCE_CODE}/g, this.getSourceLangCode())
            .replace(/{TARGET_CODE}/g, this.getTargetLangCode())
            .replace(/{TEXT}/g, textContent);
    }

    // === High-Level Translation Methods ===

    /**
     * Translates a batch of text.
     * Note: If using Gemma Template, we must inject numbering instructions, 
     * otherwise the Overlay will fail to parse the response.
     */
    async translateBatch(originalText: string, expectedLineCount: number): Promise<string> {
        let finalSystemPrompt: string;
        
        // Check for the setting (casting to any in case types.ts isn't updated yet)
        const useGemma = (this.plugin.settings as any).useGemmaPrompt;

        if (useGemma) {
            // 1. Remove {TEXT} from the base template because we need to format the input specifically for batching
            const baseTemplate = GEMMA_TEMPLATE.replace('{TEXT}', '').trim();
            
            // 2. Add strict instructions for Numbered Lines so processing.ts can parse it
            const batchInstruction = `
            
COMMAND: Translate the following numbered lines from {SOURCE_LANG} to {TARGET_LANG}.
Return exactly {lineCount} lines in this format:
1. Translated text
2. Translated text
...
Do NOT translate the numbers. Maintain the list structure. No extra commentary.

{TEXT}`;
            
            finalSystemPrompt = this.applyTemplateVariables(baseTemplate + batchInstruction, originalText, expectedLineCount);
        } else {
            // Standard Mode
            let template = this.plugin.settings.batchPrompt;
            // Ensure input text is placed if the user used {inputText}
            if (template.includes('{inputText}')) {
                 finalSystemPrompt = this.applyTemplateVariables(template, originalText, expectedLineCount);
            } else {
                 // Fallback if user messed up the prompt
                 finalSystemPrompt = this.applyTemplateVariables(template, '', expectedLineCount) + `\n\n${originalText}`;
            }
        }

        return await this.makeApiCall(finalSystemPrompt, originalText, true);
    }

    /**
     * Translates a single piece of text (Sequential Mode).
     */
    async translateWithOpenRouter(text: string): Promise<string> {
        let finalSystemPrompt: string;
        const useGemma = (this.plugin.settings as any).useGemmaPrompt;

        if (useGemma) {
            // In Gemma mode, the text is baked into the System Prompt via {TEXT}
            finalSystemPrompt = this.applyTemplateVariables(GEMMA_TEMPLATE, text);
        } else {
            // Standard Mode
            let template = this.plugin.settings.singlePrompt;
            if (template.includes('{inputText}')) {
                finalSystemPrompt = this.applyTemplateVariables(template, text);
            } else {
                finalSystemPrompt = this.applyTemplateVariables(template, '') + `\n\n${text}`;
            }
        }

        return await this.makeApiCall(finalSystemPrompt, text, false);
    }

    // === Low-Level API Communication ===

    private getPropertyByPath(obj: any, path: string): string | undefined {
        const keys = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
        let result = obj;
        for (const key of keys) {
            if (result === null || result === undefined) return undefined;
            result = result[key];
        }
        return result;
    }
    
    private escapeJsonString(str: string): string {
        return str.replace(/\\/g, '\\\\')
                  .replace(/"/g, '\\"')
                  .replace(/\n/g, '\\n')
                  .replace(/\r/g, '\\r')
                  .replace(/\t/g, '\\t');
    }

    /**
     * Constructs the request URL, headers, and body.
     * @param fullPrompt The fully constructed system prompt (which might contain the text already).
     * @param originalText The raw text (used for User role if not baked into System).
     * @param isBakedIn If true, the text is already inside fullPrompt, so User content should be minimal.
     */
    private getRequestConfig(fullPrompt: string, originalText: string, isBakedIn: boolean): { url: string; options: RequestUrlParam } {
        const providerId = this.plugin.settings.apiProvider;
        const provider = this.plugin.settings.providerSettings[providerId];
        
        let url: string;
        let body: any;
        let headers: Record<string, string> = { 'Content-Type': 'application/json' };

        // Determine Content Distribution
        // If using Gemma Template, text is in System. User prompt should be empty-ish to avoid double tokens.
        // If using Standard, text is usually in User prompt (unless user edited Standard to use {inputText}).
        const useGemma = (this.plugin.settings as any).useGemmaPrompt;
        
        // Logic: If the prompt template ALREADY replaced {TEXT} or {inputText}, we don't want to send it again.
        const textIsInsideSystem = useGemma || fullPrompt.includes(originalText.substring(0, 20));

        const systemContent = fullPrompt;
        const userContent = textIsInsideSystem ? " " : originalText; // " " keeps APIs happy that demand user content

        switch (providerId) {
            case 'openrouter':
                if (!provider.apiKey) throw new Error('OpenRouter API key is missing.');
                url = 'https://openrouter.ai/api/v1/chat/completions';
                headers['Authorization'] = `Bearer ${provider.apiKey}`;
                headers['HTTP-Referer'] = 'obsidian://pdf-translator';
                headers['X-Title'] = 'PDF Translator Plugin';
                body = {
                    model: provider.model,
                    messages: [
                        { role: 'system', content: systemContent },
                        { role: 'user', content: userContent }
                    ],
                    max_tokens: 4096,
                    temperature: 0.1,
                };
                break;

            case 'openai':
                if (!provider.apiKey) throw new Error('OpenAI API key is missing.');
                url = 'https://api.openai.com/v1/chat/completions';
                headers['Authorization'] = `Bearer ${provider.apiKey}`;
                body = {
                    model: provider.model || 'gpt-4o',
                    messages: [
                        { role: 'system', content: systemContent },
                        { role: 'user', content: userContent }
                    ],
                    temperature: 0.1,
                };
                break;

            case 'gemini':
                if (!provider.apiKey) throw new Error('Gemini API key is missing.');
                const modelName = provider.model?.startsWith('models/') ? provider.model : `models/${provider.model || 'gemini-1.5-flash'}`;
                url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${provider.apiKey}`;
                
                // Gemini prefers context combined nicely.
                const combinedGeminiText = textIsInsideSystem 
                    ? systemContent 
                    : `${systemContent}\n\nTask:\n${userContent}`;

                body = {
                    contents: [{
                        parts: [{ text: combinedGeminiText }]
                    }],
                    generationConfig: { temperature: 0.1 }
                };
                break;
            
            case 'ollama':
                if (!provider.apiEndpoint || !provider.model) throw new Error('Ollama endpoint or model is missing.');
                const endpoint = provider.apiEndpoint.endsWith('/') ? provider.apiEndpoint.slice(0, -1) : provider.apiEndpoint;
                url = `${endpoint}/api/chat`;
                body = {
                    model: provider.model,
                    stream: false,
                    messages: [
                        { role: 'system', content: systemContent },
                        { role: 'user', content: userContent }
                    ]
                };
                break;

            case 'custom':
                if (!provider.apiEndpoint) throw new Error('Custom API endpoint is missing.');
                url = provider.apiEndpoint;
                
                if (provider.headers) {
                    const populatedHeaders = provider.headers.replace(/{apiKey}/g, provider.apiKey || '');
                    try { headers = { ...headers, ...JSON.parse(populatedHeaders) }; } 
                    catch (e) { throw new Error('Failed to parse custom headers JSON.'); }
                }

                if (provider.requestBody) {
                    const populatedBody = provider.requestBody
                        .replace(/{model}/g, provider.model || '')
                        .replace(/{systemPrompt}/g, this.escapeJsonString(systemContent))
                        .replace(/{userPrompt}/g, this.escapeJsonString(userContent));
                    try { body = JSON.parse(populatedBody); } 
                    catch (e) { throw new Error('Failed to parse custom request body JSON.'); }
                } else {
                     throw new Error('Custom request body setting is missing.');
                }
                break;

            default:
                throw new Error(`Unsupported API provider: ${providerId}`);
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

    async makeApiCall(systemPrompt: string, originalText: string, isBatch: boolean): Promise<string> {
        const providerId = this.plugin.settings.apiProvider;
        const providerSettings = this.plugin.settings.providerSettings[providerId];

        if (providerId === 'openrouter' && providerSettings.model?.includes('qwen') && !this.warnedAboutQwen) {
            new Notice('Warning: Some Qwen models have low rate limits.', 6000);
            this.warnedAboutQwen = true;
        }

        const MAX_RETRIES = 3;
        const BASE_DELAY = 1000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Determine if the text was already baked into the system prompt
                const useGemma = (this.plugin.settings as any).useGemmaPrompt;
                const textBakedIn = useGemma || systemPrompt.includes(originalText.substring(0, 50));

                const { url, options } = this.getRequestConfig(systemPrompt, originalText, textBakedIn);
                
                const controller = new AbortController();
                const timeoutMs = providerId === 'gemini' ? 60000 : 45000;
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                options.signal = controller.signal;

                const response = await requestUrl({ url, ...options });
                clearTimeout(timeoutId);

                if (response.status === 200) {
                    let responsePath = 'choices[0].message.content';
                    if (providerId === 'ollama') responsePath = 'message.content';
                    else if (providerId === 'gemini') responsePath = 'candidates[0].content.parts[0].text';
                    else if (providerId === 'custom') responsePath = providerSettings.responsePath || responsePath;

                    const translatedText = this.getPropertyByPath(response.json, responsePath);
                    
                    if (!translatedText) {
                        if (this.plugin.settings.debugMode) console.log("Full Response:", response.json);
                        throw new Error('Empty response from API or invalid path.');
                    }

                    return translatedText.trim();
                }

                // Error Handling
                const errorMsg = response.json?.error?.message || JSON.stringify(response.json) || response.text;
                if (response.status === 429 || (typeof errorMsg === 'string' && errorMsg.toLowerCase().includes('rate limit'))) {
                    if (attempt === MAX_RETRIES) break;
                    const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
                    if (this.plugin.settings.debugMode) console.log(`Rate limit hit. Retrying in ${delay}ms...`);
                    await this.sleep(delay);
                    continue;
                }
                
                throw new Error(`API Error - HTTP ${response.status}: ${errorMsg}`);

            } catch (err: any) {
                if (err.name === 'AbortError') throw new Error('Request timed out.');
                if (attempt === MAX_RETRIES) {
                    new Notice(`Translation failed: ${err.message}`);
                    throw err;
                }
            }
        }

        throw new Error('Rate limit exceeded or API unavailable after retries.');
    }

    async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}