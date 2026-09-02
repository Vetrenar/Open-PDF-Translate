// providers.ts
// ════════════════════════════════════════════════════════════════
// Unified Provider Registry — single source of truth for all AI
// providers (translation AND OCR). Adding a new provider = adding
// one entry to ALL_PROVIDERS. No switch changes needed elsewhere.
// ════════════════════════════════════════════════════════════════
import { requestUrl } from 'obsidian';

// ─── Protocols ─────────────────────────────────────────────────
// Each protocol knows how to:
//   1. build an HTTP request (URL, headers, JSON body) from a
//      system+user prompt (+ optional image for OCR)
//   2. extract the assistant text from the HTTP response
//   3. fetch the list of available models (optional)
export type ProviderProtocol =
  | 'openai-chat'     // OpenAI Chat Completions compatible (most third-party providers)
  | 'anthropic'       // Anthropic Messages API
  | 'gemini'          // Google Generative Language API
  | 'ollama'          // Ollama /api/chat
  | 'mistral'         // Mistral API (OpenAI-compatible with native endpoint)
  | 'qwen-dashscope'  // Alibaba DashScope (OpenAI-compatible)
  | 'custom';         // User-defined request body template

// ─── Auth schemes ───────────────────────────────────────────────
export type AuthScheme =
  | { kind: 'bearer' }                       // Authorization: Bearer {apiKey}
  | { kind: 'header'; headerName: string }   // e.g. x-api-key (Anthropic), api-key (Mistral)
  | { kind: 'query'; paramName: string }     // e.g. ?key= (Gemini)
  | { kind: 'none' };                        // Local servers without auth

// ─── Model descriptor ───────────────────────────────────────────
export interface ProviderModel {
  id: string;
  label?: string;
  vision?: boolean;       // model accepts image input → eligible for OCR
  reasoning?: boolean;    // model supports reasoning/thinking mode
}

// ─── Provider definition ────────────────────────────────────────
export interface ProviderDef {
  id: string;
  label: string;
  category: 'cloud' | 'local' | 'custom';
  docsUrl?: string;
  protocol: ProviderProtocol;
  auth: AuthScheme;
  /** Fixed base URL for cloud providers (omitted for user-configurable endpoints). */
  baseUrl?: string;
  /** Suffix appended to baseUrl for the chat endpoint (default: '/chat/completions' for openai-chat). */
  chatPath?: string;
  /** Default model id used when none is configured. */
  defaultModel: string;
  /** Whether the protocol can carry image payloads (for OCR eligibility). */
  supportsVision: boolean;
  /** Whether a reasoning toggle is meaningful for this provider. */
  supportsReasoning: boolean;
  /** Regexes that detect reasoning-capable model IDs (for auto-detect). */
  reasoningModelPatterns?: RegExp[];
  /** Placeholder shown in the API-key field. */
  apiKeyPlaceholder?: string;
  /** Optional prefix hint (cosmetic). */
  apiKeyPrefix?: string;
  /** Default endpoint for local providers (e.g. http://localhost:11434). */
  defaultEndpoint?: string;
  /** Static fallback model list (used when API fetch fails or no /models endpoint exists). */
  staticModels?: ProviderModel[];
  /**
   * Build the request to list available models. Return null if the provider
   * has no /models endpoint (caller will use staticModels).
   */
  modelsRequest?: (ps: ProviderSettingsLike) => { url: string; headers?: Record<string, string> } | null;
  /** Parse the /models response into a normalized list. */
  parseModelsResponse?: (json: any) => ProviderModel[];
  /** Provider-specific extra headers (e.g. OpenRouter wants HTTP-Referer). */
  extraHeaders?: Record<string, string>;
  /** Cache TTL for fetched model lists (default: 1 hour). */
  modelsCacheTtlMs?: number;
  /**
   * Hard cap on output tokens for translation requests. Used by
   * TranslationEngine.computeMaxTokens() as the upper bound. Defaults to 8192
   * for providers that don't override. Increase for providers with large
   * output budgets (e.g. Gemini 1.5 Pro can output 8192+, Claude 3.5 8192).
   */
  maxOutputTokens?: number;
  /**
   * Approximate context window (input + output tokens) for the provider's
   * default family of models. Used by TranslationEngine.computeMaxTokens()
   * to refuse oversized requests before they hit the network, and by
   * TextProcessor to auto-split oversized batches. Conservative values are
   * used where models vary widely (e.g. OpenRouter, Ollama).
   */
  contextWindow: number;
  /**
   * Number of JSON-parse retry attempts the OCR pipeline should give this
   * provider's models when they emit slightly malformed JSON. Small local
   * vision models (Ollama llava, moondream) often need 2; cloud providers
   * with strong instruction-following (GPT-4o, Claude, Gemini) usually fine
   * with 1. Default: 1.
   */
  jsonRetryAttempts?: number;
  /**
   * Whether to inject strict JSON formatting hints into the OCR prompt when
   * the model is small or instruction-weak. Currently applies to ollama and
   * other local protocols; cloud providers don't need it. Default: false.
   */
  needsStrictJsonHint?: boolean;
}

/** Minimal shape we need from settings to build a request. */
export interface ProviderSettingsLike {
  apiKey?: string;
  model?: string;
  apiEndpoint?: string;
  headers?: string;
  requestBody?: string;
  responsePath?: string;
  temperature?: number;
  enableReasoning?: boolean;
  maxTokens?: number;
}

// ════════════════════════════════════════════════════════════════
// REGISTRY
// ════════════════════════════════════════════════════════════════

const REASONING_OPENAI = [/^o1/i, /^o3/i, /^o4/i];
const REASONING_PATTERNS_DEEPSEEK = [/deepseek-r/i, /deepseek-reasoner/i];
const REASONING_PATTERNS_GEMINI = [/thinking/i, /^gemini-2\..*flash/i];
const REASONING_PATTERNS_ANTHROPIC = [/^claude-3-7/i, /^claude-4/i, /thinking/i];
const REASONING_PATTERNS_QWEN = [/qwq/i, /qwen.*q.*w/i, /-thinking/i];

export const ALL_PROVIDERS: ProviderDef[] = [
  // ─── Cloud providers ────────────────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'cloud',
    docsUrl: 'https://platform.openai.com/api-keys',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    defaultModel: 'gpt-4o',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: REASONING_OPENAI,
    apiKeyPlaceholder: 'sk-...',
    apiKeyPrefix: 'sk-',
    staticModels: [
      { id: 'gpt-4o', label: 'GPT-4o', vision: true },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', vision: true },
      { id: 'gpt-4', label: 'GPT-4' },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
      { id: 'o1', label: 'o1 (reasoning)', reasoning: true },
      { id: 'o1-mini', label: 'o1-mini (reasoning)', reasoning: true },
      { id: 'o3', label: 'o3 (reasoning)', reasoning: true },
      { id: 'o3-mini', label: 'o3-mini (reasoning)', reasoning: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.openai.com/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .filter((m: any) => /^(gpt|o\d|chatgpt)/i.test(m.id) &&
        !/(embedding|whisper|tts|audio|image|moderation|dall)/i.test(m.id))
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 16384,  // GPT-4o supports up to 16K output tokens
    contextWindow: 128000,   // GPT-4o family: 128K context
  },

  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    category: 'cloud',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    protocol: 'anthropic',
    auth: { kind: 'header', headerName: 'x-api-key' },
    baseUrl: 'https://api.anthropic.com/v1',
    chatPath: '/messages',
    defaultModel: 'claude-3-5-sonnet-20241022',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: REASONING_PATTERNS_ANTHROPIC,
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyPrefix: 'sk-ant-',
    staticModels: [
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', vision: true },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', vision: true },
      { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus', vision: true },
      { id: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet', vision: true },
      { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku', vision: true },
    ],
    // Anthropic does not expose a public /models endpoint, so no modelsRequest.
    maxOutputTokens: 8192,  // Claude 3.5 supports up to 8K output (some models higher with beta header)
    contextWindow: 200000,  // Claude 3.5: 200K context
  },

  {
    id: 'gemini',
    label: 'Google Gemini',
    category: 'cloud',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    protocol: 'gemini',
    auth: { kind: 'query', paramName: 'key' },
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-1.5-flash',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: REASONING_PATTERNS_GEMINI,
    apiKeyPlaceholder: 'your-gemini-api-key',
    staticModels: [
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', vision: true },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', vision: true },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', vision: true },
      { id: 'gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking', vision: true, reasoning: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${ps.apiKey}` }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.models) ? json.models : [])
      .filter((m: any) => /gemini/i.test(m.name) &&
        (!m.supportedGenerationMethods ||
          m.supportedGenerationMethods.includes('generateContent') ||
          m.supportedGenerationMethods.includes('generateMessage')))
      .map((m: any) => ({
        id: m.name.replace(/^models\//, ''),
        label: m.displayName || m.name.replace(/^models\//, ''),
        vision: true,
      })),
    maxOutputTokens: 8192,  // Gemini 1.5 supports 8K output; 2.0 supports more but cap conservatively
    contextWindow: 1000000, // Gemini 1.5/2.0: 1M context
  },

  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'cloud',
    docsUrl: 'https://openrouter.ai/keys',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    defaultModel: 'google/gemini-flash-1.5',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: [
      ...REASONING_OPENAI,
      ...REASONING_PATTERNS_DEEPSEEK,
      ...REASONING_PATTERNS_GEMINI,
      ...REASONING_PATTERNS_QWEN,
    ],
    apiKeyPlaceholder: 'sk-or-v1-...',
    apiKeyPrefix: 'sk-or-v1-',
    extraHeaders: {
      'HTTP-Referer': 'https://obsidian.md',
      'X-Title': 'Obsidian PDF Translator',
    },
    staticModels: [
      { id: 'google/gemini-flash-1.5', label: 'Google Gemini Flash 1.5', vision: true },
      { id: 'google/gemini-pro-1.5', label: 'Google Gemini Pro 1.5', vision: true },
      { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o', vision: true },
      { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini', vision: true },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', vision: true },
      { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', vision: true },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (reasoning)', reasoning: true },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B' },
    ],
    modelsRequest: () => ({ url: 'https://openrouter.ai/api/v1/models' }),
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.name || m.id }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || '')),
    maxOutputTokens: 8192,  // OpenRouter passes through to underlying provider; 8K is a safe default
    contextWindow: 128000,  // Varies by underlying model; 128K is a conservative default
  },

  {
    id: 'routerai',
    label: 'RouterAI',
    category: 'cloud',
    docsUrl: 'https://routerai.ru',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://routerai.ru/api/v1',
    chatPath: '/chat/completions',
    defaultModel: 'openai/gpt-4o',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: [
      ...REASONING_OPENAI,
      ...REASONING_PATTERNS_DEEPSEEK,
      ...REASONING_PATTERNS_GEMINI,
      ...REASONING_PATTERNS_QWEN,
    ],
    apiKeyPlaceholder: 'your-routerai-api-key',
    extraHeaders: {
      'HTTP-Referer': 'https://obsidian.md',
      'X-Title': 'Obsidian PDF Translator',
    },
    staticModels: [
      { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o', vision: true },
      { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini', vision: true },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', vision: true },
      { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', vision: true },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (reasoning)', reasoning: true },
      { id: 'google/gemini-flash-1.5', label: 'Google Gemini Flash 1.5', vision: true },
      { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B' },
    ],
    modelsRequest: (ps) => ({
      url: `${(ps.apiEndpoint || 'https://routerai.ru/api/v1').replace(/\/$/, '')}/models`,
      // FIX H7: include Authorization header — RouterAI /models endpoint requires auth,
      // without it returns 401 and the model dropdown falls back to 8 static models.
      headers: ps.apiKey ? { 'Authorization': `Bearer ${ps.apiKey}` } : {},
    }),
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || '')),
    maxOutputTokens: 8192,
    contextWindow: 128000,
  },

  {
    id: 'deepseek',
    label: 'DeepSeek',
    category: 'cloud',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.deepseek.com/v1',
    chatPath: '/chat/completions',
    defaultModel: 'deepseek-chat',
    supportsVision: false,
    supportsReasoning: true,
    reasoningModelPatterns: REASONING_PATTERNS_DEEPSEEK,
    apiKeyPlaceholder: 'sk-...',
    apiKeyPrefix: 'sk-',
    staticModels: [
      { id: 'deepseek-chat', label: 'DeepSeek V3 (chat)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1 (reasoning)', reasoning: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.deepseek.com/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // DeepSeek default output cap
    contextWindow: 64000,   // DeepSeek V3: 64K context
  },

  {
    id: 'xai',
    label: 'xAI Grok',
    category: 'cloud',
    docsUrl: 'https://console.x.ai/',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.x.ai/v1',
    chatPath: '/chat/completions',
    defaultModel: 'grok-2-latest',
    supportsVision: true,
    supportsReasoning: false,
    apiKeyPlaceholder: 'xai-...',
    staticModels: [
      { id: 'grok-2-latest', label: 'Grok 2 Latest', vision: true },
      { id: 'grok-2', label: 'Grok 2', vision: true },
      { id: 'grok-2-vision-latest', label: 'Grok 2 Vision Latest', vision: true },
      { id: 'grok-beta', label: 'Grok Beta' },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.x.ai/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // xAI Grok output cap
    contextWindow: 32000,   // Grok 2: 32K context
  },

  {
    id: 'groq',
    label: 'Groq',
    category: 'cloud',
    docsUrl: 'https://console.groq.com/keys',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.groq.com/openai/v1',
    chatPath: '/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsVision: false,
    supportsReasoning: false,
    apiKeyPlaceholder: 'gsk_...',
    apiKeyPrefix: 'gsk_',
    staticModels: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
      { id: 'llama3-70b-8192', label: 'Llama 3 70B' },
      { id: 'llama3-8b-8192', label: 'Llama 3 8B' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B' },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.groq.com/openai/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .filter((m: any) => !/(whisper|distil)/i.test(m.id))
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // Groq output cap (varies by model, but 8K is safe)
    contextWindow: 32000,   // Groq models typically 32K context
  },

  {
    id: 'mistral',
    label: 'Mistral AI',
    category: 'cloud',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    protocol: 'mistral',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.mistral.ai/v1',
    chatPath: '/chat/completions',
    defaultModel: 'mistral-large-latest',
    supportsVision: true,
    supportsReasoning: false,
    apiKeyPlaceholder: '...',
    staticModels: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'mistral-small-latest', label: 'Mistral Small' },
      { id: 'mistral-8x7B', label: 'Mixtral 8x7B' },
      { id: 'mistral-7B-Instruct', label: 'Mistral 7B Instruct' },
      { id: 'codestral-latest', label: 'Codestral' },
      { id: 'pixtral-12b-2409', label: 'Pixtral 12B (vision)', vision: true },
      { id: 'pixtral-large-2411', label: 'Pixtral Large (vision)', vision: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.mistral.ai/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // Mistral output cap
    contextWindow: 32000,   // Mistral models typically 32K context
  },

  {
    id: 'together',
    label: 'Together AI',
    category: 'cloud',
    docsUrl: 'https://api.together.xyz/settings/api-keys',
    protocol: 'openai-chat',
    auth: { kind: 'bearer' },
    baseUrl: 'https://api.together.xyz/v1',
    chatPath: '/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    supportsVision: false,
    supportsReasoning: false,
    apiKeyPlaceholder: '...',
    staticModels: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', label: 'Llama 3.1 70B Turbo' },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo' },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B' },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1 (reasoning)', reasoning: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://api.together.xyz/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .filter((m: any) => m.type === 'chat' || !m.type)
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // Together AI output cap (varies by model)
    contextWindow: 32000,   // Together AI models typically 32K context
  },

  {
    id: 'qwen',
    label: 'Alibaba Qwen (DashScope)',
    category: 'cloud',
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    protocol: 'qwen-dashscope',
    auth: { kind: 'bearer' },
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    defaultModel: 'qwen-plus',
    supportsVision: true,
    supportsReasoning: true,
    reasoningModelPatterns: REASONING_PATTERNS_QWEN,
    apiKeyPlaceholder: 'sk-...',
    staticModels: [
      { id: 'qwen-max', label: 'Qwen Max' },
      { id: 'qwen-plus', label: 'Qwen Plus' },
      { id: 'qwen-turbo', label: 'Qwen Turbo' },
      { id: 'qwen-long', label: 'Qwen Long (10M context)' },
      { id: 'qwen-vl-max', label: 'Qwen VL Max (vision)', vision: true },
      { id: 'qwen-vl-plus', label: 'Qwen VL Plus (vision)', vision: true },
      { id: 'qwq-32b-preview', label: 'QwQ 32B (reasoning)', reasoning: true },
    ],
    modelsRequest: (ps) => ps.apiKey
      ? { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', headers: { 'Authorization': `Bearer ${ps.apiKey}` } }
      : null,
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    maxOutputTokens: 8192,  // Qwen DashScope output cap
    contextWindow: 32000,   // Qwen DashScope: 32K context (qwen-long has more)
  },

  // ─── Local providers ────────────────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama',
    category: 'local',
    docsUrl: 'https://ollama.com/',
    protocol: 'ollama',
    auth: { kind: 'none' },
    defaultEndpoint: 'http://localhost:11434',
    defaultModel: 'llama3',
    supportsVision: true,
    supportsReasoning: false,
    apiKeyPlaceholder: '(no key needed)',
    staticModels: [
      { id: 'llama3', label: 'Llama 3' },
      { id: 'llama3.1', label: 'Llama 3.1' },
      { id: 'mistral', label: 'Mistral' },
      { id: 'qwen2.5', label: 'Qwen 2.5' },
      { id: 'llava', label: 'LLaVA (vision)', vision: true },
      { id: 'llava:7b', label: 'LLaVA 7B (vision)', vision: true },
      { id: 'moondream', label: 'Moondream (vision)', vision: true },
      { id: 'bakllava', label: 'BakLLaVA (vision)', vision: true },
    ],
    modelsRequest: (ps) => ({
      url: `${(ps.apiEndpoint || 'http://localhost:11434').replace(/\/$/, '')}/api/tags`,
    }),
    parseModelsResponse: (json) => (Array.isArray(json.models) ? json.models : [])
      .map((m: any) => ({ id: m.name, label: m.name })),
    maxOutputTokens: 4096,   // Local models often have smaller context; keep conservative
    contextWindow: 4096,     // Conservative default for local models (varies by installed model)
    jsonRetryAttempts: 2,    // Small vision models often emit slightly malformed JSON
    needsStrictJsonHint: true,  // Inject strict JSON formatting rules into OCR prompts
  },

  {
    id: 'lmstudio',
    label: 'LM Studio',
    category: 'local',
    docsUrl: 'https://lmstudio.ai/docs/local-server',
    protocol: 'openai-chat',
    auth: { kind: 'none' },
    defaultEndpoint: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    supportsVision: false,
    supportsReasoning: false,
    apiKeyPlaceholder: '(no key needed)',
    staticModels: [
      { id: 'local-model', label: 'Loaded model' },
    ],
    modelsRequest: (ps) => ({
      url: `${(ps.apiEndpoint || 'http://localhost:1234/v1').replace(/\/$/, '')}/models`,
    }),
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id })),
    maxOutputTokens: 4096,
    contextWindow: 4096,     // Conservative default for local models
    jsonRetryAttempts: 2,    // Local models via LM Studio often small
    needsStrictJsonHint: true,
  },

  {
    id: 'vllm',
    label: 'vLLM',
    category: 'local',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    protocol: 'openai-chat',
    auth: { kind: 'none' },
    defaultEndpoint: 'http://localhost:8000/v1',
    defaultModel: '',
    supportsVision: true,
    supportsReasoning: false,
    apiKeyPlaceholder: '(no key needed)',
    staticModels: [],
    maxOutputTokens: 4096,
    contextWindow: 4096,     // Conservative default for local models
    jsonRetryAttempts: 2,   // vLLM often hosts smaller OSS models
    needsStrictJsonHint: true,
    modelsRequest: (ps) => ({
      url: `${(ps.apiEndpoint || 'http://localhost:8000/v1').replace(/\/$/, '')}/models`,
    }),
    parseModelsResponse: (json) => (Array.isArray(json.data) ? json.data : [])
      .map((m: any) => ({ id: m.id, label: m.id })),
  },

  // ─── Custom ─────────────────────────────────────────────────
  {
    id: 'custom',
    label: 'Custom Endpoint',
    category: 'custom',
    docsUrl: '',
    protocol: 'custom',
    auth: { kind: 'none' },
    defaultModel: '',
    supportsVision: true,
    supportsReasoning: false,
    apiKeyPlaceholder: 'optional',
    staticModels: [],
    contextWindow: 8192,     // Conservative default for unknown custom endpoints
  },
];

// ─── Lookup helpers ─────────────────────────────────────────────
const PROVIDER_INDEX: Record<string, ProviderDef> = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p.id, p]),
);

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDER_INDEX[id];
}

export function getProviderOrThrow(id: string): ProviderDef {
  const p = PROVIDER_INDEX[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** All provider ids — used for type widening and settings migration. */
export const ALL_PROVIDER_IDS = ALL_PROVIDERS.map(p => p.id);

/** Vision-capable providers (eligible for OCR). */
export function isVisionCapable(id: string): boolean {
  return getProvider(id)?.supportsVision ?? false;
}

// ════════════════════════════════════════════════════════════════
// REQUEST BUILDER
// ════════════════════════════════════════════════════════════════

export interface BuildRequestInput {
  providerId: string;
  ps: ProviderSettingsLike;
  systemPrompt: string;
  userPrompt: string;
  /** For OCR: optional image payload (base64 without prefix). */
  image?: { base64: string; mimeType: string } | null;
  maxTokens: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function escapeJsonString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function applyAuth(
  headers: Record<string, string>,
  auth: AuthScheme,
  apiKey: string,
  url: string,
): string {
  switch (auth.kind) {
    case 'bearer':
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'header':
      if (apiKey) headers[auth.headerName] = apiKey;
      break;
    case 'query':
      if (apiKey) {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}${auth.paramName}=${encodeURIComponent(apiKey)}`;
      }
      break;
    case 'none':
      break;
  }
  return url;
}

/**
 * Builds an HTTP request for the given provider/protocol. Replaces the
 * giant switch statements that used to live in translation.ts and
 * ocr-layout.ts.
 */
export function buildRequest(input: BuildRequestInput): BuiltRequest {
  const def = getProviderOrThrow(input.providerId);
  const ps = input.ps;
  const { systemPrompt, userPrompt, image, maxTokens } = input;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (def.extraHeaders) Object.assign(headers, def.extraHeaders);

  let url: string;
  let body: any;

  switch (def.protocol) {
    // ─────────── OpenAI-compatible (chat completions) ───────────
    case 'openai-chat':
    case 'mistral':
    case 'qwen-dashscope': {
      const base = ps.apiEndpoint || def.baseUrl || '';
      const path = def.chatPath || '/chat/completions';
      url = `${base.replace(/\/$/, '')}${path}`;
      url = applyAuth(headers, def.auth, ps.apiKey || '', url);

      const messages: any[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      if (image) {
        // OpenAI-style multimodal message
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: 'high' } },
          ],
        });
      } else {
        messages.push({ role: 'user', content: userPrompt });
      }

      body = {
        model: ps.model || def.defaultModel,
        messages,
        temperature: ps.temperature ?? 0.3,
        max_tokens: maxTokens,
      };

      // OpenAI o1/o3/o4 series — no temperature, use max_completion_tokens.
      // P2-38: accept `openai/o1-...` prefix too (OpenRouter-style identifiers
      // pasted into the OpenAI provider's model field).
      if (def.id === 'openai' && /^(?:openai\/)?(o1|o3|o4)/i.test(ps.model || '')) {
        delete body.temperature;
        delete body.max_tokens;
        body.max_completion_tokens = maxTokens;
        if (ps.enableReasoning) body.reasoning_effort = 'high';
      } else if (ps.enableReasoning && def.id === 'openrouter' && def.supportsReasoning) {
        // P1-6: OpenRouter reasoning effort is only valid on the OpenRouter
        // provider. Other OpenAI-compatible providers (DashScope, Mistral,
        // generic OpenAI-compatible endpoints) reject the `reasoning` field
        // with HTTP 400. Anthropic and Gemini have their own thinking/reasoning
        // APIs handled in their respective branches below.
        body.reasoning = { effort: 'high' };
      }
      break;
    }

    // ─────────── Anthropic Messages API ───────────
    case 'anthropic': {
      const base = ps.apiEndpoint || def.baseUrl || '';
      url = `${base.replace(/\/$/, '')}${def.chatPath || '/messages'}`;
      url = applyAuth(headers, def.auth, ps.apiKey || '', url);
      // Anthropic requires these headers
      headers['anthropic-version'] = '2023-06-01';

      const userContent: any[] = [];
      if (image) {
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mimeType,
            data: image.base64,
          },
        });
      }
      userContent.push({ type: 'text', text: userPrompt });

      body = {
        model: ps.model || def.defaultModel,
        max_tokens: maxTokens,
        temperature: ps.temperature ?? 0.3,
        system: systemPrompt || undefined,
        messages: [{ role: 'user', content: userContent }],
      };

      // Extended thinking for Claude 3.7 / Claude 4
      if (ps.enableReasoning && def.supportsReasoning) {
        // FIX C4: Anthropic API requires:
        // 1. temperature=1.0 when thinking is enabled (any other value → HTTP 400)
        // 2. budget_tokens >= 1024 (minimum)
        // 3. budget_tokens < max_tokens (must leave room for output)
        body.thinking = {
          type: 'enabled',
          budget_tokens: Math.min(
            Math.max(1024, Math.floor(maxTokens * 0.6)),
            maxTokens - 1
          )
        };
        body.temperature = 1.0;
      }
      break;
    }

    // ─────────── Google Gemini ───────────
    case 'gemini': {
      const base = ps.apiEndpoint || def.baseUrl || '';
      const model = (ps.model || def.defaultModel).replace(/^models\//, '');
      url = `${base.replace(/\/$/, '')}/models/${model}:generateContent`;
      url = applyAuth(headers, def.auth, ps.apiKey || '', url);

      const parts: any[] = [];
      if (systemPrompt) parts.push({ text: systemPrompt });
      if (image) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
      }
      parts.push({ text: userPrompt });

      body = {
        contents: [{ parts }],
        generationConfig: {
          temperature: ps.temperature ?? 0.3,
          maxOutputTokens: maxTokens,
        },
      };
      if (ps.enableReasoning && /thinking/i.test(model)) {
        body.generationConfig.thinkingMode = 'THINKING_MODE_ENABLED';
      }
      break;
    }

    // ─────────── Ollama ───────────
    case 'ollama': {
      const endpoint = (ps.apiEndpoint || def.defaultEndpoint || 'http://localhost:11434').replace(/\/$/, '');
      url = `${endpoint}/api/chat`;
      url = applyAuth(headers, def.auth, ps.apiKey || '', url);

      const messages: any[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      const userMsg: any = {
        role: 'user',
        content: userPrompt,
        ...(image ? { images: [image.base64] } : {}),
      };
      messages.push(userMsg);

      body = {
        model: ps.model || def.defaultModel,
        stream: false,
        messages,
        options: {
          temperature: ps.temperature ?? 0.3,
          num_predict: maxTokens,
        },
      };
      break;
    }

    // ─────────── Custom (user-defined template) ───────────
    case 'custom': {
      if (!ps.apiEndpoint) throw new Error('Custom API endpoint is missing.');
      url = ps.apiEndpoint;

      // Headers
      if (ps.headers) {
        try {
          // P1-2: use function replacement. `String.prototype.replace`
          // interprets `$&`, `$1`, `$$`, `$\``, `$'` in the replacement
          // string. If `ps.apiKey` contains `$1` (or any user-visible text
          // in systemPrompt / userPrompt for the body case below contains
          // `$`), those sequences are interpreted as capture-group
          // references and silently corrupt the output. Function-form
          // replacements bypass that interpretation entirely.
          // FIX H8: wrap {apiKey} in escapeJsonString — if apiKey contains JSON-special
          // characters (quotes, backslashes), JSON.parse will fail without escaping.
          // Other placeholders ({systemPrompt}, {userPrompt}) are already escaped.
          const populatedHeaders = ps.headers.replace(/\{apiKey\}/g, () => escapeJsonString(ps.apiKey || ''));
          Object.assign(headers, JSON.parse(populatedHeaders));
        } catch {
          throw new Error('Failed to parse custom headers JSON.');
        }
      }

      // Body
      if (!ps.requestBody) throw new Error('Custom request body is missing.');
      // FIX H8: wrap {model} in escapeJsonString for consistency with {apiKey} above.
      const populatedBody = ps.requestBody
        .replace(/{model}/g, () => escapeJsonString(ps.model || ''))
        .replace(/{systemPrompt}/g, () => escapeJsonString(systemPrompt))
        .replace(/{userPrompt}/g, () => escapeJsonString(userPrompt))
        .replace(/{temperature}/g, () => (ps.temperature ?? 0.3).toString())
        .replace(/{maxTokens}/g, () => String(maxTokens))
        .replace(/{imageBase64}/g, () => image?.base64 || '')
        .replace(/{imageMimeType}/g, () => image?.mimeType || '');
      try {
        body = JSON.parse(populatedBody);
      } catch {
        throw new Error('Failed to parse custom request body JSON.');
      }
      break;
    }

    default:
      throw new Error(`Unsupported protocol: ${(def as ProviderDef).protocol}`);
  }

  return { url, headers, body };
}

// ════════════════════════════════════════════════════════════════
// RESPONSE EXTRACTOR
// ════════════════════════════════════════════════════════════════

export function getPropertyByPath(obj: any, path: string): string | undefined {
  if (!path) return undefined;
  const keys = path.replace(/\[(\w+)\]/g, '.$1').replace(/^\./, '').split('.');
  let result: any = obj;
  for (const key of keys) {
    if (result === null || result === undefined) return undefined;
    result = result[key];
  }
  return result;
}

/**
 * Extracts the assistant text from a provider response. Honors custom
 * responsePath from settings; otherwise uses the protocol default.
 */
export function extractResponseContent(
  providerId: string,
  json: any,
  customPath?: string,
): string | null {
  const def = getProviderOrThrow(providerId);
  if (customPath) {
    // P2-36: use ?? instead of || so an explicit empty string at the path
    // is preserved (the LLM legitimately returned nothing for a trivial
    // input). The previous `|| null` collapsed '' to null, which the
    // upstream caller in translation.ts treats as "invalid response path"
    // — different error message than "empty translation".
    return getPropertyByPath(json, customPath) ?? null;
  }
  // Switch on protocol to extract content. The responsePath baked in by
  // buildRequest is intentionally NOT threaded through here — this switch
  // is the single source of truth for the default extraction path per
  // protocol, and customPath above handles user overrides.
  switch (def.protocol) {
    case 'anthropic':
      // Claude responses have content[] with type:text blocks
      return extractAnthropicText(json);
    case 'gemini': {
      // P2-37: don't short-circuit on '' via || — if parts[0].text is the
      // empty string (a legitimate empty reply), return it as-is so the
      // caller can distinguish "empty translation" from "no path matched".
      const firstPart = json?.candidates?.[0]?.content?.parts?.[0];
      if (firstPart?.text !== undefined) {
        return firstPart.text;
      }
      // Fallback: join all parts (handles multi-part responses where the
      // first part is non-text, e.g. a function call).
      return json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || null;
    }
    case 'ollama':
      return json?.message?.content || json?.choices?.[0]?.message?.content || null;
    case 'openai-chat':
    case 'mistral':
    case 'qwen-dashscope':
    case 'custom':
    default:
      return json?.choices?.[0]?.message?.content || null;
  }
}

function extractAnthropicText(json: any): string | null {
  if (!json?.content || !Array.isArray(json.content)) return null;
  const text = json.content
    .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
  return text || null;
}

// ════════════════════════════════════════════════════════════════
// MODEL LIST FETCHER (with cache)
// ════════════════════════════════════════════════════════════════

interface CacheEntry {
  timestamp: number;
  models: ProviderModel[];
}
const modelCache = new Map<string, CacheEntry>();
const DEFAULT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the model list for a provider. Uses cache (1h default).
 * Falls back to staticModels when no modelsRequest is defined or on error.
 */
export async function fetchProviderModels(
  providerId: string,
  ps: ProviderSettingsLike,
  opts: { force?: boolean } = {},
): Promise<ProviderModel[]> {
  const def = getProvider(providerId);
  if (!def) return [];

  const cacheKey = `${providerId}::${ps.apiKey || ''}::${ps.apiEndpoint || ''}`;
  const ttl = def.modelsCacheTtlMs ?? DEFAULT_CACHE_TTL;
  const cached = modelCache.get(cacheKey);
  if (!opts.force && cached && Date.now() - cached.timestamp < ttl) {
    return cached.models;
  }

  if (!def.modelsRequest || !def.parseModelsResponse) {
    return def.staticModels || [];
  }

  try {
    const req = def.modelsRequest(ps);
    if (!req) return def.staticModels || [];

    const resp = await requestUrl({
      url: req.url,
      headers: req.headers || {},
      method: 'GET',
      throw: false,
    });
    if (resp.status >= 200 && resp.status < 300) {
      const models = def.parseModelsResponse(resp.json);
      modelCache.set(cacheKey, { timestamp: Date.now(), models });
      return models;
    }
    console.warn(`Models fetch for ${providerId} returned HTTP ${resp.status}`, resp.json);
  } catch (e) {
    console.warn(`Models fetch for ${providerId} failed:`, e);
  }

  return def.staticModels || [];
}

/** Invalidate the model cache for one provider (or all, if id omitted). */
export function invalidateModelCache(providerId?: string): void {
  if (providerId) {
    for (const key of modelCache.keys()) {
      if (key.startsWith(`${providerId}::`)) modelCache.delete(key);
    }
  } else {
    modelCache.clear();
  }
}

// ════════════════════════════════════════════════════════════════
// CONNECTION TEST
// ════════════════════════════════════════════════════════════════

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  /** HTTP status code, if available. */
  status?: number;
  /** Latency in ms. */
  latencyMs?: number;
}

/**
 * Sends a tiny "ping" request to verify the provider config.
 * For chat providers we still have to issue a chat completion with a 1-token
 * reply (most providers don't expose a lightweight auth check).
 */
export async function testConnection(
  providerId: string,
  ps: ProviderSettingsLike,
): Promise<ConnectionTestResult> {
  const def = getProvider(providerId);
  if (!def) return { ok: false, message: `Unknown provider: ${providerId}` };

  const t0 = Date.now();
  try {
    // For providers with /models — call that, it's cheap.
    if (def.modelsRequest && def.parseModelsResponse) {
      const req = def.modelsRequest(ps);
      if (req) {
        const resp = await requestUrl({
          url: req.url,
          headers: req.headers || {},
          method: 'GET',
          throw: false,
        });
        const latency = Date.now() - t0;
        if (resp.status >= 200 && resp.status < 300) {
          const models = def.parseModelsResponse(resp.json);
          return {
            ok: true,
            status: resp.status,
            latencyMs: latency,
            message: `✓ Connected — ${models.length} models available (${latency} ms)`,
          };
        }
        return {
          ok: false,
          status: resp.status,
          latencyMs: latency,
          message: `✗ HTTP ${resp.status}: ${resp.json?.error?.message || resp.json?.message || resp.text || 'request failed'}`,
        };
      }
    }

    // For providers without /models — issue a minimal chat completion.
    const built = buildRequest({
      providerId,
      ps,
      systemPrompt: '',
      userPrompt: 'ping',
      image: null,
      maxTokens: 16,
    });
    const resp = await requestUrl({
      url: built.url,
      headers: built.headers,
      method: 'POST',
      body: JSON.stringify(built.body),
      throw: false,
    });
    const latency = Date.now() - t0;
    if (resp.status >= 200 && resp.status < 300) {
      return {
        ok: true,
        status: resp.status,
        latencyMs: latency,
        message: `✓ Connected — chat completion succeeded (${latency} ms)`,
      };
    }
    return {
      ok: false,
      status: resp.status,
      latencyMs: latency,
      message: `✗ HTTP ${resp.status}: ${resp.json?.error?.message || resp.json?.message || resp.text || 'request failed'}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      message: `✗ ${e.message || 'Network error'}`,
    };
  }
}

// ════════════════════════════════════════════════════════════════
// REASONING DETECTION
// ════════════════════════════════════════════════════════════════

/**
 * Returns true if the given model ID is a reasoning-capable model
 * for the given provider. Used to gate the reasoning toggle.
 */
export function isReasoningModel(providerId: string, modelId?: string): boolean {
  if (!modelId) return false;
  const def = getProvider(providerId);
  if (!def?.reasoningModelPatterns?.length) return false;
  return def.reasoningModelPatterns.some(re => re.test(modelId));
}

/**
 * Returns the per-provider output-token cap used as the upper bound
 * for translation requests. Falls back to 8192 (the historical default)
 * when the provider doesn't override.
 */
export function getMaxOutputTokens(providerId: string): number {
  return getProvider(providerId)?.maxOutputTokens ?? 8192;
}

/**
 * Returns the number of JSON-parse retry attempts the OCR pipeline should
 * give this provider's models. Defaults to 1 (single attempt, no retry).
 */
export function getJsonRetryAttempts(providerId: string): number {
  return getProvider(providerId)?.jsonRetryAttempts ?? 1;
}

/**
 * Returns true if the OCR pipeline should inject strict JSON formatting
 * hints into the prompt for this provider (typically small local models
 * that struggle with structured output).
 */
export function needsStrictJsonHint(providerId: string): boolean {
  return getProvider(providerId)?.needsStrictJsonHint ?? false;
}

// ════════════════════════════════════════════════════════════════
// DEFAULT PROVIDER SETTINGS BUILDER
// ════════════════════════════════════════════════════════════════

/**
 * Returns a Record<providerId, ProviderSettings> with sensible defaults
 * for every registered provider. Used by DEFAULT_SETTINGS and loadSettings().
 */
export function buildDefaultProviderSettings(): Record<string, ProviderSettingsLike> {
  const out: Record<string, ProviderSettingsLike> = {};
  for (const def of ALL_PROVIDERS) {
    const base: ProviderSettingsLike = {
      apiKey: '',
      model: def.defaultModel,
      temperature: 0.3,
      enableReasoning: false,
    };
    if (def.category === 'local' || def.protocol === 'ollama' || def.protocol === 'custom') {
      base.apiEndpoint = def.defaultEndpoint || '';
    }
    if (def.protocol === 'custom') {
      base.headers = '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {apiKey}"\n}';
      base.requestBody = '{\n  "model": "{model}",\n  "messages": [\n    {\n      "role": "system",\n      "content": "{systemPrompt}"\n    },\n    {\n      "role": "user",\n      "content": "{userPrompt}"\n    }\n  ],\n  "temperature": {temperature},\n  "max_tokens": {maxTokens}\n}';
      base.responsePath = 'choices[0].message.content';
    }
    out[def.id] = base;
  }
  return out;
}
