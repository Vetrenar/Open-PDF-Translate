// ocr-layout.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 16 (P1-31): DEAD CODE REMOVAL.
//
// Previously this module was 1168 LOC and exposed a full layout-mode OCR
// subsystem (hasCachedLayout / getCachedPage / ocrPage / ocrFullDocument /
// clearCache, plus a 7-strategy JSON-repair pipeline and an on-disk OCR
// cache). Grep across the codebase confirms NONE of those methods have any
// external caller — the only entry point used in production is
// `ocrPageText`, which is invoked by OcrTextTranslator (ocr-text.ts) for
// the true-OCR (transcribed-text) workflow.
//
// The layout-mode workflow has been superseded by:
//   • ExternalLayoutService (external-layout.ts) — on-disk layout cache +
//     layout-block retrieval for the overlay pipeline.
//   • OcrTextTranslator (ocr-text.ts) — image-OCR → translate → note.
//
// Both subsystems have their own storage and do not depend on the dead
// methods removed below. All ~750 LOC of dead code (cache layer, JSON
// repair, prompt builders, layout-mode impls, modify-listener) have been
// deleted. What remains is the minimum needed to honour `ocrPageText`:
//   • constructor
//   • withTimeout (utility)
//   • sleep (utility)
//   • callOcrModel (private helper)
//   • ocrPageText (public entry)
// ─────────────────────────────────────────────────────────────────────────

import { requestUrl } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { CapturedPageImage } from './page-capture';
// Phase 12.1 (C9): the provider-specific request builder and response
// extractor live in providers.ts as a single source of truth.
import { buildRequest, extractResponseContent } from './providers';

/**
 * Phase 12.3 (C10): `withTimeout` is a PRIVATE method on TranslationEngine,
 * not exported from translation.ts. Define a local equivalent so we can
 * bound OCR requests without refactoring translation.ts.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        p,
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

export class OcrLayoutService {
    private plugin: OpenRouterTranslatorPlugin;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;

        // Phase 16 (P1-31): the previous `registerEvent(vault.on('modify'))`
        // listener that called `invalidateCacheForPdf` has been removed.
        // The cache it was invalidating (memoryCache + on-disk
        // `.ocr-cache.json`) was part of the dead layout-mode subsystem
        // and is gone too, so the listener had no observable effect
        // beyond burning a vault-modify dispatch on every PDF save.
        //
        // The `pageCapture: PageCapture` field and its instantiation are
        // likewise gone — `ocrPageText` receives the image from its caller
        // (OcrTextTranslator.ocrSinglePage), so the field was unused after
        // the dead layout-mode methods were removed.
    }

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
                // Phase 12.2 (C9): delegate request construction to the
                // shared registry. `ocr` is treated as `ProviderSettingsLike`
                // via `as any` because OcrProviderSettings carries extra
                // fields (ocrPromptTemplate, imageScale, ...) that the
                // registry doesn't need.
                const built = buildRequest({
                    providerId: ocr.provider,
                    ps: ocr as any,
                    systemPrompt: '',
                    userPrompt: prompt,
                    image: image ? { base64: image.base64, mimeType: image.mimeType } : null,
                    maxTokens: ocr.maxTokens || 4096,
                });
                // Phase 12.3 (C10): bound the request with our local
                // `withTimeout`. Local model servers (ollama / lmstudio /
                // vllm) frequently take 60s+ to produce a single page of
                // OCR text, so give them 180s; cloud providers get 60s.
                const TIMEOUT_MS =
                    ocr.provider === 'ollama' || ocr.provider === 'lmstudio' || ocr.provider === 'vllm'
                        ? 180000
                        : 60000;
                const response = await withTimeout(
                    requestUrl({
                        url: built.url,
                        method: 'POST',
                        headers: built.headers,
                        body: JSON.stringify(built.body),
                        throw: false,
                    }),
                    TIMEOUT_MS
                );

                if (this.plugin.settings.debugMode) {
                    this.plugin.logDebug('=== OCR API RESPONSE ===', {
                        status: response.status,
                        preview:
                            JSON.stringify(response.json, null, 2)?.substring(0, 500) ||
                            response.text.substring(0, 500),
                    });
                }

                if (response.status !== 200) {
                    const errMsg =
                        response.json?.error?.message || response.text || `HTTP ${response.status}`;
                    throw new Error(`OCR API HTTP ${response.status}: ${errMsg}`);
                }

                // Phase 12.2 (C9): delegate response extraction to the
                // shared registry. `ocr.responseJsonPath` (when set) is
                // forwarded as `customPath` so users who pointed OCR at a
                // custom endpoint with a non-standard response shape keep
                // working.
                const content = extractResponseContent(
                    ocr.provider,
                    response.json,
                    ocr.responseJsonPath || undefined
                );
                if (!content || content.trim().length < 10) {
                    throw new Error('Empty or too-short response from model');
                }

                return content;
            } catch (err: any) {
                if (attempt === MAX_RETRIES) throw err;
                this.plugin.logDebug(
                    `⚠ OCR API attempt ${attempt} failed: ${err.message}. Retrying...`
                );
                await this.sleep(1000 * attempt);
            }
        }

        return null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}
