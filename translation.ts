// translation.ts
import { requestUrl, Notice, RequestUrlParam } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { AVAILABLE_LANGUAGES, GEMMA_TEMPLATE } from './types';
import {
    buildRequest,
    extractResponseContent,
    getProvider,
    isReasoningModel,
    getMaxOutputTokens,
} from './providers';

// Neutral, domain-agnostic fallback template (used only if the editable
// custom template is empty). Single source of truth lives in types.ts.

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
     * Stage 1.1 (Q3): Replaces placeholders in the prompt template.
     *
     * Unified variable naming: all variables support `{UPPER_CASE}` form
     * (preferred, visually distinct from markdown syntax). Lowercase forms
     * (`{sourceLang}`, `{targetLang}`, `{lineCount}`, `{inputText}`) are
     * preserved as backward-compat aliases — old custom templates continue
     * to work without modification.
     *
     * Full variable reference:
     *   {SOURCE_LANG}   / {sourceLang}   — source language display name (e.g. "English")
     *   {TARGET_LANG}   / {targetLang}   — target language display name (e.g. "Russian")
     *   {SOURCE_CODE}                    — source language ISO code (e.g. "en")
     *   {TARGET_CODE}                    — target language ISO code (e.g. "ru")
     *   {LINE_COUNT}   / {lineCount}     — number of segments in batch mode
     *   {TEXT}         / {inputText}     — the text to translate
     *
     * Note: {SOURCE_CODE} / {TARGET_CODE} exist only in UPPERCASE form
     * (no lowercase alias) — they were added after the lowercase forms
     * were established and weren't backported. Keeping it that way to
     * avoid introducing new aliases that could collide with user text.
     */
    private applyTemplateVariables(template: string, textContent: string, lineCount: number = 0): string {
        const sourceLangName = this.getSourceLangName();
        const targetLangName = this.getTargetLangName();
        const sourceLangCode = this.getSourceLangCode();
        const targetLangCode = this.getTargetLangCode();
        const lineCountStr = lineCount.toString();

        // Phase 6 (P0-12): use FUNCTION-FORM replacements (`() => value`)
        // instead of plain string values. `String.prototype.replace`
        // interprets `$&`, `$1`-`$9`, `$10`+, `$$`, `$\``, `$'` in the
        // replacement string as capture-group references. If any of the
        // substituted values contains a literal `$` followed by a digit
        // (e.g. user text like "Cost: $5 $10", LaTeX "$x^2$", regex
        // "/\d+/", or even a translated string that itself contains `$`),
        // those sequences get silently mangled — `$$` collapses to `$`,
        // `$5` becomes the 5th capture group (empty for our placeholder
        // regex), `$&` becomes the matched placeholder, etc. Function-form
        // replacements bypass this special-casing entirely: the return
        // value is inserted verbatim. See providers.ts:870-879 for the
        // same fix applied to custom-template `{apiKey}`/`{model}`/etc.
        return template
            // ── Preferred {UPPER_CASE} form ─────────────────────────────
            .replace(/{SOURCE_LANG}/g, () => sourceLangName)
            .replace(/{TARGET_LANG}/g, () => targetLangName)
            .replace(/{SOURCE_CODE}/g, () => sourceLangCode)
            .replace(/{TARGET_CODE}/g, () => targetLangCode)
            .replace(/{LINE_COUNT}/g, () => lineCountStr)
            .replace(/{TEXT}/g, () => textContent)

            // ── Lowercase aliases (backward compat) ─────────────────────
            // Stage 1.1 (Q3): old custom templates may use {sourceLang} /
            // {targetLang} / {lineCount} / {inputText}. Preserve them so
            // user-edited templates don't silently break.
            .replace(/{sourceLang}/g, () => sourceLangName)
            .replace(/{targetLang}/g, () => targetLangName)
            .replace(/{lineCount}/g, () => lineCountStr)
            .replace(/{inputText}/g, () => textContent);
    }

    // === High-Level Translation Methods ===

    /** The active "special template" text: user's editable customTemplate,
     *  falling back to the legacy default if unset. */
    private activeTemplate(): string {
        const t = (this.plugin.settings as any).customTemplate;
        return (typeof t === 'string' && t.trim()) ? t : GEMMA_TEMPLATE;
    }

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
            // P2-33: replaceAll — user templates may contain multiple {TEXT} placeholders.
            const baseTemplate = this.activeTemplate().replaceAll('{TEXT}', '').trim();
            
            // 2. Add strict instructions for Numbered Lines so processing.ts can parse it
            // FIX C3: use [#N] format (matching Standard branch) so extractNumberedLinesRobust
            // can parse with strict regex. Previous "1. 2." format caused 100% fallback to
            // originals when strict regex was introduced.
            const batchInstruction = `
            
COMMAND: Translate the following numbered lines from {SOURCE_LANG} to {TARGET_LANG}.
Return exactly {lineCount} lines in this format:
[#1] Translated text
[#2] Translated text
...
Do NOT translate the [#N] markers. Maintain the list structure. No extra commentary.

{TEXT}`;
            
            finalSystemPrompt = this.applyTemplateVariables(baseTemplate + batchInstruction, originalText, expectedLineCount);
        } else {
            // Standard Mode
            let template = this.plugin.settings.batchPrompt;
            // Ensure input text is placed if the user used {inputText} or {TEXT}.
            // P2-34: previously only {inputText} was checked, so users who used
            // the {TEXT} alias silently fell through to the append fallback —
            // which substituted {TEXT} with '' (losing the user's intent for
            // where the text should appear inside the template) AND appended
            // the text at the end. Both placeholders are documented aliases
            // for the same purpose (see applyTemplateVariables docstring), so
            // both should trigger the substitution path.
            if (template.includes('{inputText}') || template.includes('{TEXT}')) {
                 finalSystemPrompt = this.applyTemplateVariables(template, originalText, expectedLineCount);
            } else {
                 // Fallback if user messed up the prompt
                 finalSystemPrompt = this.applyTemplateVariables(template, '', expectedLineCount) + `\n\n${originalText}`;
            }
        }

        // P2-35: textBakedIn is explicit — in every branch above, originalText
        // ends up inside finalSystemPrompt (via {TEXT}/{inputText} substitution
        // or via the fallback append). The previous substring heuristic
        // (`systemPrompt.includes(originalText.substring(0, 50))`) was
        // unreliable for short text and false-positive-prone when the same
        // prefix appeared inside a templated example.
        return await this.makeApiCall(finalSystemPrompt, originalText, true, true);
    }

    /**
     * Translates a single piece of text (Sequential Mode).
     */
    async translateWithOpenRouter(text: string): Promise<string> {
        let finalSystemPrompt: string;
        const useGemma = (this.plugin.settings as any).useGemmaPrompt;

        if (useGemma) {
            // In Gemma mode, the text is baked into the System Prompt via {TEXT}
            finalSystemPrompt = this.applyTemplateVariables(this.activeTemplate(), text);
        } else {
            // Standard Mode
            let template = this.plugin.settings.singlePrompt;
            if (template.includes('{inputText}')) {
                finalSystemPrompt = this.applyTemplateVariables(template, text);
            } else {
                finalSystemPrompt = this.applyTemplateVariables(template, '') + `\n\n${text}`;
            }
        }

        // P2-35: textBakedIn is explicit (see translateBatch for rationale).
        return await this.makeApiCall(finalSystemPrompt, text, false, true);
    }

    // === Low-Level API Communication ===

    // NOTE: getPropertyByPath and escapeJsonString moved to providers.ts
    // (registry is now the single source of truth for response parsing
    // and custom-body templating).

    /**
     * Check if a model supports reasoning/thinking mode, using the
     * provider-aware registry instead of a global hardcoded list.
     */
    private supportsReasoning(providerId: string, modelId?: string): boolean {
        return isReasoningModel(providerId, modelId);
    }

    /**
     * Constructs the request URL, headers, and body.
     * Delegates to providers.ts buildRequest() — single source of truth.
     * @param fullPrompt The fully constructed system prompt (which might contain the text already).
     * @param originalText The raw text (used for User role if not baked into System).
     * @param isBakedIn If true, the text is already inside fullPrompt, so User content should be minimal.
     */
    private getRequestConfig(fullPrompt: string, originalText: string, isBakedIn: boolean, maxTokens: number): { url: string; options: RequestUrlParam } {
        const providerId = this.plugin.settings.apiProvider;
        const provider = this.plugin.settings.providerSettings[providerId] || {};
        const def = getProvider(providerId);
        if (!def) throw new Error(`Unknown provider: ${providerId}`);

        // Auth/key validation up front (registry doesn't know which providers REQUIRE a key).
        if (def.auth.kind !== 'none' && !provider.apiKey) {
            throw new Error(`${def.label} API key is missing.`);
        }
        if (def.protocol === 'ollama' && !provider.apiEndpoint && !def.defaultEndpoint) {
            throw new Error('Ollama endpoint is missing.');
        }
        if (def.protocol === 'custom' && !provider.apiEndpoint) {
            throw new Error('Custom API endpoint is missing.');
        }

        // Determine content distribution
        const useGemma = (this.plugin.settings as any).useGemmaPrompt;
        const systemContent = fullPrompt;
        const userContent = isBakedIn ? 'Translate.' : originalText;

        const built = buildRequest({
            providerId,
            ps: provider,
            systemPrompt: systemContent,
            userPrompt: userContent,
            image: null,
            maxTokens,
        });

        return {
            url: built.url,
            options: {
                url: built.url,
                method: 'POST',
                headers: built.headers,
                body: JSON.stringify(built.body),
                throw: false,
            } as RequestUrlParam,
        };
    }

    async makeApiCall(systemPrompt: string, originalText: string, isBatch: boolean, textBakedIn: boolean): Promise<string> {
        const providerId = this.plugin.settings.apiProvider;
        const providerSettings = this.plugin.settings.providerSettings[providerId] || {};
        const def = getProvider(providerId);

        // Provider-aware Qwen rate-limit warning (OpenRouter + DashScope).
        if (def && /qwen|qwq/i.test(providerSettings.model || '') && providerId === 'openrouter' && !this.warnedAboutQwen) {
            new Notice('Warning: Some Qwen models have low rate limits on OpenRouter.', 6000);
            this.warnedAboutQwen = true;
        }

        const MAX_RETRIES = 3;
        const BASE_DELAY = 1000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const { url, options } = this.getRequestConfig(systemPrompt, originalText, textBakedIn, this.computeMaxTokens(systemPrompt, originalText, isBatch, textBakedIn));

                // requestUrl ignores AbortSignal, so we race it against a real timeout instead.
                // Local servers (ollama) tend to be slower; cloud providers default to 45s.
                const isLocal = def?.category === 'local';
                const isGemini = def?.protocol === 'gemini';
                const timeoutMs = isGemini ? 60000 : (isLocal ? 120000 : 45000);

                const response = await this.withTimeout(requestUrl(options), timeoutMs);

                // DIAGNOSTIC: Log the full response if debug mode is enabled
                if (this.plugin.settings.debugMode) {
                    console.log('=== API RESPONSE DEBUG ===');
                    console.log('Status:', response.status);
                    console.log('Response:', JSON.stringify(response.json, null, 2));
                    console.log('==========================');
                }

                if (response.status === 200) {
                    // Use registry to extract content (provider-aware path).
                    const customPath = def?.protocol === 'custom' ? providerSettings.responsePath : undefined;
                    const translatedText = extractResponseContent(providerId, response.json, customPath);

                    // FIX: detect truncated responses. Reasoning models often hit
                    // max_tokens mid-translation — the response is technically valid
                    // (200 OK) but incomplete. Log a warning so the user can diagnose
                    // (reduce maxBatchChars or increase maxTokens).
                    // P2-32: per-provider truncation signals. OpenAI/OpenRouter/Mistral/
                    // DashScope use choices[0].finish_reason='length'. Gemini uses
                    // candidates[0].finishReason='MAX_TOKENS'. Anthropic uses
                    // stop_reason='max_tokens'. Ollama uses done_reason='length'.
                    const finishReason = response.json?.choices?.[0]?.finish_reason;
                    if (finishReason === 'length' || finishReason === 'MAX_TOKENS') {
                        const reasoningTokens = response.json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
                        const completionTokens = response.json?.usage?.completion_tokens ?? 0;
                        console.warn(
                            `[makeApiCall] Response truncated (finish_reason: ${finishReason}). ` +
                            `Model used ${reasoningTokens} reasoning tokens out of ${completionTokens} completion tokens. ` +
                            `Translation may be incomplete. Consider: ` +
                            `(1) reduce maxBatchChars, (2) disable reasoning for this model, ` +
                            `(3) use a non-reasoning model. ` +
                            `Content preview: ${(translatedText || '').substring(0, 100)}...`
                        );
                    }
                    const geminiFinishReason = response.json?.candidates?.[0]?.finishReason;
                    if (geminiFinishReason === 'MAX_TOKENS') {
                        console.warn(
                            `[makeApiCall] Response truncated (Gemini finishReason: MAX_TOKENS). ` +
                            `Translation may be incomplete. Consider: ` +
                            `(1) reduce maxBatchChars, (2) increase provider maxOutputTokens, ` +
                            `(3) use a model with a larger output budget. ` +
                            `Content preview: ${(translatedText || '').substring(0, 100)}...`
                        );
                    }
                    const anthropicStopReason = response.json?.stop_reason;
                    if (anthropicStopReason === 'max_tokens') {
                        console.warn(
                            `[makeApiCall] Response truncated (Anthropic stop_reason: max_tokens). ` +
                            `Translation may be incomplete. Consider: ` +
                            `(1) reduce maxBatchChars, (2) increase provider maxOutputTokens, ` +
                            `(3) if thinking is enabled, lower thinking.budget_tokens to leave more room for output. ` +
                            `Content preview: ${(translatedText || '').substring(0, 100)}...`
                        );
                    }
                    const ollamaDoneReason = response.json?.done_reason;
                    if (ollamaDoneReason === 'length') {
                        console.warn(
                            `[makeApiCall] Response truncated (Ollama done_reason: length). ` +
                            `Translation may be incomplete. Consider: ` +
                            `(1) reduce maxBatchChars, (2) increase num_predict in Ollama options, ` +
                            `(3) use a model with a larger context window. ` +
                            `Content preview: ${(translatedText || '').substring(0, 100)}...`
                        );
                    }

                    // FIX: distinguish null (path not found / malformed response) from
                    // empty string (legitimate empty translation). extractResponseContent
                    // returns null when the response shape doesn't match; it returns ''
                    // when the path exists but the content is empty. Only null should
                    // trigger "Empty response" error — empty string is valid (e.g., LLM
                    // returned nothing for a trivial input).
                    if (translatedText === null) {
                        console.warn("Empty response from API or invalid response path.", response.json);
                        console.warn("Provider:", providerId, "Protocol:", def?.protocol);
                        throw new Error('Empty response from API or invalid response path.');
                    }

                    // Empty string is valid — return as-is (trim may make it empty)
                    return (translatedText || '').trim();
                }

                // Error Handling
                const errorMsg = response.json?.error?.message || JSON.stringify(response.json) || response.text;
                
                console.error('=== API ERROR DEBUG ===');
                console.error('Status:', response.status);
                console.error('Provider:', providerId);
                console.error('Model:', providerSettings.model);
                console.error('Error Message:', errorMsg);
                console.error('Full Response:', response.json);
                console.error('=======================');
                
                // Rate limit handling
                if (response.status === 429 || (typeof errorMsg === 'string' && errorMsg.toLowerCase().includes('rate limit'))) {
                    if (attempt === MAX_RETRIES) {
                        throw new Error(`Rate limit exceeded after ${MAX_RETRIES} attempts. Please wait and try again.`);
                    }
                    // Phase 13.5: honor `Retry-After` header when present.
                    // Tries to parse the header as seconds first (the common
                    // form), then falls back to an HTTP-date, and finally to
                    // the previous exponential backoff. The final delay is
                    // capped at 5 min (P2-31: was 30s, raised to 5 min so
                    // background translation can honor longer provider-side
                    // rate-limit windows — e.g. OpenRouter returns 300s for
                    // daily quota resets, Anthropic returns 60s for spike
                    // backoff). Interactive translation runs through the same
                    // path; the Obsidian Notice on each retry keeps the user
                    // informed so a 5 min wait is acceptable.
                    const retryAfter = (response as any)?.headers?.['retry-after'];
                    let delay: number;
                    if (retryAfter) {
                        const seconds = parseInt(retryAfter, 10);
                        if (!isNaN(seconds)) {
                            delay = Math.max(seconds * 1000, BASE_DELAY);
                        } else {
                            const date = new Date(retryAfter);
                            delay = !isNaN(date.getTime())
                                ? Math.max(date.getTime() - Date.now(), BASE_DELAY)
                                : BASE_DELAY * Math.pow(2, attempt - 1);
                        }
                    } else {
                        delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
                    }
                    delay = Math.min(delay, 300000); // Cap at 5 min (P2-31)
                    console.log(`Rate limit hit. Retrying in ${delay}ms...`);
                    await this.sleep(delay);
                    continue;
                }
                
                // Provider-specific error messages
                let userFriendlyError = `API Error - HTTP ${response.status}`;
                // P1-1: mark 4xx (except 429 Too Many Requests) as
                // non-retryable. Retrying 400/401/403/404 is wasteful —
                // the API key, model name, or request shape won't change
                // between attempts, so the user just waits through 3 retries
                // (~7 seconds of exponential backoff) before seeing the
                // failure. Only 429 (rate limit), 408 (Request Timeout),
                // and 5xx (provider error) deserve a retry.
                let nonRetryable = false;
                if (response.status === 400) {
                    userFriendlyError += ': Bad request - check your model selection and API key';
                    nonRetryable = true;
                } else if (response.status === 401) {
                    userFriendlyError += ': Invalid API key';
                    nonRetryable = true;
                } else if (response.status === 403) {
                    userFriendlyError += ': Access forbidden - check your API permissions';
                    nonRetryable = true;
                } else if (response.status === 404) {
                    userFriendlyError += ': Model not found - check your model name';
                    nonRetryable = true;
                } else if (response.status === 500 || response.status === 502 || response.status === 503) {
                    userFriendlyError += ': Provider service error - try again later';
                } else {
                    userFriendlyError += `: ${errorMsg}`;
                }

                const err = new Error(userFriendlyError) as Error & { nonRetryable?: boolean };
                err.nonRetryable = nonRetryable;
                throw err;

            } catch (err: any) {
                // P1-1: 4xx (except 429) — fail fast, no retry.
                if (err?.nonRetryable) {
                    new Notice(`⚠ ${err.message}`, 5000);
                    throw err;
                }
                if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                    if (attempt < MAX_RETRIES) {
                        new Notice(`Request timed out. Retrying (${attempt}/${MAX_RETRIES})...`);
                        // P1-1 (also flagged as T-7 in audit): add a short
                        // delay before retrying after a timeout, otherwise
                        // we hammer an already-slow server.
                        await this.sleep(BASE_DELAY);
                        continue;
                    }
                    throw new Error('Request timed out. The model may be slow or overloaded.');
                }
                
                if (attempt === MAX_RETRIES) {
                    new Notice(`Translation failed: ${err.message}`);
                    throw err;
                }
                
                // For network errors, retry with exponential backoff + jitter
                // FIX H6: add jitter (0-500ms) to prevent retry storms when multiple
                // requests fail simultaneously (e.g., network blip affecting 10 pages).
                const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
                console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`, err);
                await this.sleep(delay);
            }
        }

        throw new Error('Translation failed after multiple retries. Please check your connection and try again.');
    }

    async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * FIX: Simplified character-based maxTokens computation.
     *
     * Previous approach used per-script token estimation (CJK 0.67, Arabic 0.5,
     * Latin 0.33) which was inaccurate and caused problems with reasoning models
     * (Gemini Flash Thinking, DeepSeek R1, etc.) that burn tokens unpredictably
     * on internal reasoning.
     *
     * New approach: just use provider's maxOutputTokens cap, with a floor of 1024.
     * Chunking is handled by `maxBatchChars` (character-based) in processing.ts —
     * that's the right place for size control, not here.
     *
     * P1-5: previously this method had a separate `if (isReasoning)` branch that
     * computed `Math.min(cap, Math.max(2048, cap))` — which is just `cap` (since
     * `Math.min(cap, cap)` is `cap` whenever `cap >= 2048`, and the providers in
     * the registry all set maxOutputTokens ≥ 4096). The branch was dead code
     * dressed up as a reasoning-model override. Removed.
     */
    private computeMaxTokens(
        systemPrompt: string,
        originalText: string,
        isBatch: boolean = false,
        textBakedIn: boolean = false
    ): number {
        const cap = getMaxOutputTokens(this.plugin.settings.apiProvider);
        return Math.max(1024, cap);
    }

    /**
     * FIX: detect if the current model is a reasoning-capable model that burns
     * output tokens on internal reasoning before producing visible output.
     * Checks both the provider's reasoningModelPatterns AND the user's
     * enableReasoning setting.
     */
    private isReasoningModel(def: any, settings: any): boolean {
        if (!def) return false;
        // User explicitly enabled reasoning
        const providerSettings = settings.providerSettings?.[settings.apiProvider];
        if (providerSettings?.enableReasoning) return true;
        // Model name matches reasoning patterns
        const model = providerSettings?.model || def.defaultModel || '';
        if (def.reasoningModelPatterns) {
            for (const pattern of def.reasoningModelPatterns) {
                if (pattern.test(model)) return true;
            }
        }
        // Check model's static reasoning flag
        if (def.staticModels) {
            for (const m of def.staticModels) {
                if (m.id === model && m.reasoning) return true;
            }
        }
        return false;
    }

    /**
     * Reject after `ms` if the wrapped promise hasn't settled.
     *
     * FIX H5: requestUrl does NOT support AbortSignal (confirmed by Obsidian API
     * and code comment at line 259). The underlying HTTP request continues to
     * completion even after timeout — we just ignore the result. This means
     * timed-out requests still consume API quota/GPU. To actually cancel HTTP,
     * would need fetch() with AbortController, but fetch() doesn't support
     * Obsidian's auth/cert handling. Accept this limitation.
     *
     * The timer IS properly cleared via clearTimeout in both success and error
     * paths — no timer leak.
     */
    private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const id = setTimeout(
                () => reject(Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })),
                ms,
            );
            p.then(
                (v) => { clearTimeout(id); resolve(v); },
                (e) => { clearTimeout(id); reject(e); },
            );
        });
    }
}