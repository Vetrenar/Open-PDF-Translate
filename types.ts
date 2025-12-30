// types.ts
import type { Plugin } from 'obsidian';

// === Interfaces ===

/**
 * Settings for an individual API provider.
 */
export interface ProviderSettings {
    apiKey?: string;
    model?: string;
    apiEndpoint?: string;
    // For custom providers
    headers?: string;
    requestBody?: string;
    responsePath?: string;
}

/**
 * Main settings for the OpenRouter Translator plugin.
 */
export interface OpenRouterTranslatorSettings {
    // --- Provider Management ---
    apiProvider: 'openrouter' | 'ollama' | 'custom';
    providerSettings: {
        openrouter: ProviderSettings;
        ollama: ProviderSettings;
        custom: ProviderSettings;
    };

    // Translation Behavior
    enableTranslation: boolean;
    useBatchTranslation: boolean;
    debugMode: boolean;

    // Language Settings
    sourceLanguage: string;
    targetLanguage: string;

    // Visual Settings
    outputFontSizeScale: number;
    outputLineHeight: number;
    overlayOpacity: number;

    // Processing Settings
    maxBatchChars: number;
    mergeOnStyleChange: boolean;

    // Storage Settings
    autoSaveOverlay: boolean;
    autoRefreshOverlay: boolean;
    storageLocation: string;
    useIndividualMarkdownStorage: boolean;
    indexFilePath: string;

    // UI Settings
    manualRefinementMode: boolean;
    showOverlayByDefault: boolean;
    clickToShowMode: boolean;

    // Custom Prompts
    batchPrompt: string;
    singlePrompt: string;

    // --- NEW: Custom Copy Formats ---
    calloutFormat: string;
    citationFormat: string;
    footnoteFormat: string;
}

export interface TranslationUnit {
    originalSpans: HTMLSpanElement[];
    text: string;
    id: string; // Unique ID for the chunk (sentence or paragraph)
    paragraphId: string; // ID to group chunks by original paragraph
}

export interface OverlayPositionData {
    selector: string;
    textContent: string;
    relativeRect: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
    page: number;
    translatedText: string;
    fontData?: {
        sizes: number[];
        relativeSizes: number[];
        referenceHeight: number;
    };
    fontSize?: number;
    fontFamily?: string;
    originalFontSizes?: number[];
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    textAlign?: string;
    color?: string;
    originalStyledText?: StyledTextSegment[];
}

export interface StyledTextSegment {
    text: string;
    fontSize: number;
    fontFamily: string;
    isBold: boolean;
    isItalic: boolean;
}

export interface SavedOverlay {
    fileName: string;
    filePath: string;
    timestamp: number;
    pageOverlays: Record<string, OverlayPositionData[]>;
    indexLine?: number;
}

export interface OverlayElementData {
    data: OverlayPositionData;
    element: HTMLElement;
    bbox: DOMRect;
}

// === Supported Languages ===
export const AVAILABLE_LANGUAGES = [
    { code: 'auto', name: 'Auto Detect' },
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'it', name: 'Italian' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ru', name: 'Russian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese' },
    { code: 'ar', name: 'Arabic' },
    { code: 'hi', name: 'Hindi' },
    { code: 'nl', name: 'Dutch' },
    { code: 'pl', name: 'Polish' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'no', name: 'Norwegian' },
    { code: 'da', name: 'Danish' },
    { code: 'fi', name: 'Finnish' },
    { code: 'cs', name: 'Czech' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'ro', name: 'Romanian' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'hr', name: 'Croatian' },
    { code: 'sk', name: 'Slovak' },
    { code: 'sl', name: 'Slovenian' },
    { code: 'et', name: 'Estonian' },
    { code: 'lv', name: 'Latvian' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'mt', name: 'Maltese' },
    { code: 'ga', name: 'Irish' },
    { code: 'cy', name: 'Welsh' },
    { code: 'eu', name: 'Basque' },
    { code: 'ca', name: 'Catalan' },
    { code: 'gl', name: 'Galician' },
    { code: 'is', name: 'Icelandic' },
];

// === Default Settings ===
export const DEFAULT_SETTINGS: OpenRouterTranslatorSettings = {
    // --- PROVIDER-AWARE DEFAULTS ---
    apiProvider: 'openrouter',
    providerSettings: {
        openrouter: {
            apiKey: '',
            model: 'google/gemini-flash-1.5'
        },
        ollama: {
            apiEndpoint: 'http://localhost:11434',
            model: 'llama3'
        },
        custom: {
            apiEndpoint: '',
            apiKey: '',
            model: '',
            headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {apiKey}"\n}',
            requestBody: '{\n  "model": "{model}",\n  "messages": [\n    {\n      "role": "system",\n      "content": "{systemPrompt}"\n    },\n    {\n      "role": "user",\n      "content": "{userPrompt}"\n    }\n  ]\n}',
            responsePath: 'choices[0].message.content'
        }
    },

    // Translation Behavior
    enableTranslation: true,
    useBatchTranslation: true,
    debugMode: false,

    // Language Settings
    sourceLanguage: 'auto',
    targetLanguage: 'en',

    // Visual Settings
    outputFontSizeScale: 0.95,
    outputLineHeight: 1.45,
    overlayOpacity: 99,

    // Processing Settings
    maxBatchChars: 7500,
    mergeOnStyleChange: false,

    // Storage Settings
    autoSaveOverlay: false,
    autoRefreshOverlay: false,
    storageLocation: '',
    useIndividualMarkdownStorage: true,
    indexFilePath: 'Index.md',

    // UI Settings
    manualRefinementMode: false,
    showOverlayByDefault: true,
    clickToShowMode: false,

    // Custom Prompts
    batchPrompt: `You are a precise document translator. Translate each of the following numbered lines from {sourceLang} to {targetLang}, and only this language.

Example:
Input:
1. Hello world
2. Thank you very much
Output:
1. Hola mundo
2. Muchas gracias

Now translate:
{inputText}

Return exactly {lineCount} lines in this format:
1. Translated line one
2. Translated line two
...
No extra text. Never skip numbering. Only return the numbered list.`,

    singlePrompt: `Translate from {sourceLang} to {targetLang}. Only output the translation. Preserve formatting and tone.`,

    // --- NEW: Custom Copy Formats ---
    calloutFormat: '> [!quote] Translation\n> {blockquote_text}\n>\n> {pagelink}',
    citationFormat: '{blockquote_text}\n> — *{filename}, page {pagenumber}*',
    footnoteFormat: '^{text} [[{filename}#page={pagenumber}|source]]'
};