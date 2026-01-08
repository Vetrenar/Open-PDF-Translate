// translation.ts
import { requestUrl, Notice, RequestUrlParam } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { AVAILABLE_LANGUAGES } from './types';

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

    getTargetLangName(): string {
        return AVAILABLE_LANGUAGES.find(l => l.code === this.plugin.settings.targetLanguage)?.name || this.plugin.settings.targetLanguage;
    }

    // === High-Level Translation Methods ===

    /**
     * Translates a batch of text using the currently configured provider.
     */
    async translateBatch(originalText: string, expectedLineCount: number): Promise<string> {
        const systemPromptTemplate = this.plugin.settings.batchPrompt;
        
        // Prepare the system prompt
        const systemPrompt = systemPromptTemplate
            .replace(/{sourceLang}/g, this.getSourceLangName())
            .replace(/{targetLang}/g, this.getTargetLangName())
            .replace(/{lineCount}/g, expectedLineCount.toString())
            .replace(/{inputText}/g, ''); 

        return await this.makeApiCall(systemPrompt, originalText);
    }

    /**
     * Translates a single piece of text.
     */
    async translateWithOpenRouter(text: string): Promise<string> {
        const systemPromptTemplate = this.plugin.settings.singlePrompt;
        
        const systemPrompt = systemPromptTemplate
            .replace(/{sourceLang}/g, this.getSourceLangName())
            .replace(/{targetLang}/g, this.getTargetLangName())
            .replace(/{inputText}/g, ''); 

        return await this.makeApiCall(systemPrompt, text.slice(0, 3000));
    }

    // === Low-Level API Communication ===

    /**
     * Safely retrieves a nested property from an object using a string path.
     */
    private getPropertyByPath(obj: any, path: string): string | undefined {
        const keys = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
        let result = obj;
        for (const key of keys) {
            if (result === null || result === undefined) {
                return undefined;
            }
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
     * Constructs the request URL, headers, and body based on the selected provider.
     */
    private getRequestConfig(systemPrompt: string, userPrompt: string): { url: string; options: RequestUrlParam } {
        const providerId = this.plugin.settings.apiProvider;
        const provider = this.plugin.settings.providerSettings[providerId];
        
        let url: string;
        let body: any;
        let headers: Record<string, string> = { 'Content-Type': 'application/json' };

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
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
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
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.1,
                };
                break;

            case 'gemini':
                if (!provider.apiKey) throw new Error('Gemini API key is missing.');
                // Ensure model has 'models/' prefix if not present, though usually handled in settings
                const modelName = provider.model?.startsWith('models/') ? provider.model : `models/${provider.model || 'gemini-1.5-flash'}`;
                url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${provider.apiKey}`;
                
                // Gemini doesn't use a "system" role in the same way as OpenAI in the 'generateContent' endpoint.
                // We combine system and user prompt for best compatibility across Gemini versions.
                body = {
                    contents: [{
                        parts: [{
                            text: `${systemPrompt}\n\nTask:\n${userPrompt}`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.1
                    }
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
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                };
                break;

            case 'custom':
                if (!provider.apiEndpoint) throw new Error('Custom API endpoint is missing.');
                url = provider.apiEndpoint;
                
                if (provider.headers) {
                    const populatedHeaders = provider.headers.replace(/{apiKey}/g, provider.apiKey || '');
                    try {
                        headers = { ...headers, ...JSON.parse(populatedHeaders) };
                    } catch (e) {
                        throw new Error('Failed to parse custom headers JSON.');
                    }
                }

                if (provider.requestBody) {
                    const populatedBody = provider.requestBody
                        .replace(/{model}/g, provider.model || '')
                        .replace(/{systemPrompt}/g, this.escapeJsonString(systemPrompt))
                        .replace(/{userPrompt}/g, this.escapeJsonString(userPrompt));
                    try {
                        body = JSON.parse(populatedBody);
                    } catch (e) {
                        throw new Error('Failed to parse custom request body JSON.');
                    }
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

    /**
     * Makes an API call to the configured provider with retry logic.
     */
    async makeApiCall(systemPrompt: string, userPrompt: string): Promise<string> {
        const providerId = this.plugin.settings.apiProvider;
        const providerSettings = this.plugin.settings.providerSettings[providerId];

        // Specific warning for OpenRouter/Qwen free models
        if (providerId === 'openrouter' && providerSettings.model?.includes('qwen') && !this.warnedAboutQwen) {
            new Notice('Warning: Some Qwen models have low rate limits.', 6000);
            this.warnedAboutQwen = true;
        }

        const MAX_RETRIES = 3;
        const BASE_DELAY = 1000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const { url, options } = this.getRequestConfig(systemPrompt, userPrompt);
                
                const controller = new AbortController();
                // Gemini can be slow with large contexts, give it more time
                const timeoutMs = providerId === 'gemini' ? 60000 : 45000;
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                options.signal = controller.signal;

                const response = await requestUrl({ url, ...options });
                clearTimeout(timeoutId);

                if (response.status === 200) {
                    // Determine where to look for the translation based on provider
                    let responsePath = 'choices[0].message.content'; // Default (OpenAI/OpenRouter)
                    
                    if (providerId === 'ollama') {
                        responsePath = 'message.content';
                    } else if (providerId === 'gemini') {
                        responsePath = 'candidates[0].content.parts[0].text';
                    } else if (providerId === 'custom') {
                        responsePath = providerSettings.responsePath || responsePath;
                    }

                    const translatedText = this.getPropertyByPath(response.json, responsePath);
                    
                    if (!translatedText) {
                        if (this.plugin.settings.debugMode) console.log("Full Response:", response.json);
                        throw new Error('Empty response from API or invalid path.');
                    }

                    return translatedText.trim();
                }

                // Handle Errors
                const errorMsg = response.json?.error?.message || JSON.stringify(response.json) || response.text;
                
                // Rate Limits (429) handling
                if (response.status === 429 || (typeof errorMsg === 'string' && errorMsg.toLowerCase().includes('rate limit'))) {
                    if (attempt === MAX_RETRIES) break;
                    const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
                    if (this.plugin.settings.debugMode) {
                        console.log(`Rate limit hit. Retrying in ${delay}ms (attempt ${attempt})`);
                    }
                    await this.sleep(delay);
                    continue;
                }
                
                throw new Error(`API Error - HTTP ${response.status}: ${errorMsg}`);

            } catch (err: any) {
                if (err.name === 'AbortError') {
                    throw new Error('Request timed out.');
                }
                if (attempt === MAX_RETRIES) {
                    new Notice(`Translation failed: ${err.message}`);
                    throw err;
                }
            }
        }

        throw new Error('Rate limit exceeded or API unavailable after retries.');
    }

    // === Utility: Safe delay ===
    async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}