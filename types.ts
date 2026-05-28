// types.ts
import type { Plugin } from 'obsidian';

/**
 * Settings for an individual API provider.
 */
export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  apiEndpoint?: string;
  headers?: string;
  requestBody?: string;
  responsePath?: string;
  temperature?: number;
  enableReasoning?: boolean;
}

/**
 * Settings for the OCR‑based layout provider.
 */
export interface OcrProviderSettings {
  provider: 'openrouter' | 'ollama' | 'openai' | 'gemini' | 'custom';
  apiKey: string;
  model: string;
  apiEndpoint?: string;
  headers?: string;
  requestBody?: string;
  temperature: number;
  maxTokens: number;
  inputMode: 'image' | 'filepath';        // how to send the page to the LLM
  workflowMode: 'per-page' | 'full-document';
  ocrPromptTemplate: string;             // prompt for a single page
  ocrFullDocPromptTemplate: string;      // optional, for batch OCR
  responseFormatInstruction: string;     // extra instructions for JSON output
  responseJsonPath: string;              // JMESPath to extract array from response
  imageScale: number;                    // scale factor when capturing screenshot
  imageFormat: 'png' | 'jpeg';
  imageQuality: number;
  
  // NEW: JSON strictness control for small models
  jsonStrictness?: 'strict' | 'lenient' | 'repair-friendly';
}

/**
 * Main settings for the OpenRouter Translator plugin.
 */
export interface OpenRouterTranslatorSettings {
  // --- Provider Management ---
  apiProvider: 'openrouter' | 'ollama' | 'openai' | 'gemini' | 'custom';
  providerSettings: {
    openrouter: ProviderSettings;
    ollama: ProviderSettings;
    openai: ProviderSettings;
    gemini: ProviderSettings;
    custom: ProviderSettings;
  };
  
  // --- Layout Engine Selection ---
  layoutEngine: 'internal' | 'python' | 'ocr-api';   // replaces useExternalLayout
  
  // External Layout / Python settings
  pythonPath: string;
  ocrScriptPath: string;
  
  // --- OCR API Settings ---
  ocrProvider: OcrProviderSettings;
  
  // --- PDF Export Settings ---
  mergeScriptPath: string;
  exportOutputDirectory: string;
  exportTextColor: string;
  exportTextOpacity: number;
  exportFontSizeScale: number;
  exportAsAnnotation: boolean;
  // Legacy/compat keys used by settings UI
  pdfExportScriptPath?: string;
  exportBackgroundColor?: string;
  exportBackgroundOpacity?: number;
  exportPreserveOriginal?: boolean;
  exportAutoOpen?: boolean;
  
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
  bboxEditMode: boolean;
  layoutDebugMode: boolean;
  
  // Custom Prompts
  useGemmaPrompt: boolean;
  batchPrompt: string;
  singlePrompt: string;
  
  // Custom Copy Formats
  calloutFormat: string;
  citationFormat: string;
  footnoteFormat: string;
}

// ════════════════════════════════════════════════════════════════
// OCR LAYOUT TYPES
// ════════════════════════════════════════════════════════════════

/**
 * Single text block extracted by OCR.
 * Normalized coordinate system: 0.0 to 1.0 relative to page dimensions.
 */
export interface OcrBlock {
  id: string;
  text: string;
  rect: {
    l: number;  // left (0.0 to 1.0)
    t: number;  // top (0.0 to 1.0)
    w: number;  // width (0.0 to 1.0)
    h: number;  // height (0.0 to 1.0)
  };
  fontSize: number;                    // estimated font size in points
  fontFamily: string;                  // 'serif', 'sans-serif', 'monospace', etc.
  confidence?: number;                 // OCR confidence score (0-1)
  blockType?: 'text' | 'heading' | 'caption' | 'table' | 'image' | string;
}

/**
 * Cached OCR data for a single page.
 */
export interface OcrCachePageData {
  pageNumber: number;
  ocrTimestamp: string;                // ISO timestamp when OCR was run
  blocks: OcrBlock[];
}

/**
 * Full OCR cache entry for a PDF document.
 */
export interface OcrCacheEntry {
  version: number;                     // schema version for migrations
  pdfPath: string;                     // original PDF vault path
  generatedAt: string;                 // ISO timestamp when cache was created
  modelId: string;                     // OCR model identifier (e.g., 'llava:7b')
  totalPages: number;                  // total pages in document
  pages: Record<number, OcrCachePageData>;
}

/**
 * External layout item interface (matches existing plugin structure).
 * Used to bridge OCR blocks with the overlay system.
 */
export interface ExternalLayoutItem {
  id: string;
  text: string;
  rect: {
    l: number;
    t: number;
    w: number;
    h: number;
  };
  fontFamily: string;
  fontSize: number;
  originalFontSizes: number[];         // array of font sizes in the block
}

// ════════════════════════════════════════════════════════════════
// TRANSLATION & OVERLAY TYPES (EXISTING)
// ════════════════════════════════════════════════════════════════

export interface TranslationUnit {
  originalSpans: HTMLSpanElement[];
  text: string;
  id: string;
  paragraphId: string;
  _externalRect?: { l: number; t: number; w: number; h: number };
  _externalFont?: { family: string; size: number; sizes: number[] };
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

export interface PdfExportSettings {
  pythonPath: string;
  pdfExportScriptPath: string;
  exportBackgroundColor: string;
  exportBackgroundOpacity: number;
  exportTextColor: string;
  exportPreserveOriginal: boolean;
  exportAutoOpen: boolean;
}

export interface MergePayload {
  pdfPath: string;
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
  outputDirectory?: string;
}

export interface MergeResult {
  success: boolean;
  outputPath: string;
  pagesProcessed: number;
  error?: string;
}

export interface SavedOverlayData {
  pageOverlays: Record<number, PdfTranslationOverlay[]>;
  pageDimensions: Record<number, { width: number; height: number }>;
}

export interface PdfTranslationOverlay {
  translatedText?: string;
  originalText?: string;
  region: { l: number; t: number; w: number; h: number };
  fontSizes?: number[];
  fontFamily?: string;
  color?: string;
  opacity?: number;
}

// ════════════════════════════════════════════════════════════════
// SUPPORTED LANGUAGES
// ════════════════════════════════════════════════════════════════

export const AVAILABLE_LANGUAGES = [
  { code: 'auto', name: 'Auto-detect' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'bn', name: 'Bengali' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'tl', name: 'Filipino' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'cs', name: 'Czech' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'et', name: 'Estonian' },
  { code: 'sl', name: 'Slovenian' },
];

// ════════════════════════════════════════════════════════════════
// PROMPT TEMPLATES
// ════════════════════════════════════════════════════════════════

export const GEMMA_TEMPLATE = `You are a professional {SOURCE_LANG} ({SOURCE_CODE}) to {TARGET_LANG} ({TARGET_CODE}) translator, with specialization in veterinary medicine. Your goal is to accurately convey the meaning and nuances of the original {SOURCE_LANG} text while adhering to {TARGET_LANG} grammar, vocabulary, terminology. Produce only the {TARGET_LANG} translation, without any additional explanations or commentary. 

Be accurate with russian grammar, use only correct and actual terminology corresponding to veterinary medicine, as clinical, pathological, anatomical, pharmacological or any other terminology. Double check the output. For acronyms, don't translate them, leave them in original language. Please translate the following {SOURCE_LANG} text into {TARGET_LANG}: {TEXT}`;

// ════════════════════════════════════════════════════════════════
// OCR PROMPTS (PROVIDER-OPTIMIZED)
// ════════════════════════════════════════════════════════════════

/**
 * Default OCR prompt with strict JSON formatting requirements.
 */
export const DEFAULT_OCR_PROMPT = `Analyze the layout of this document page and extract ALL text blocks with their precise positions.

For each text block, provide:
- The exact text content (preserve formatting, line breaks within blocks)
- Bounding box as normalized coordinates (0.0 to 1.0 relative to page dimensions): left, top, width, height
- Estimated font size in points
- Font family category: "serif", "sans-serif", or "monospace"

Return ONLY a valid JSON array, no commentary:

[
  {
    "id": "block-1",
    "text": "extracted text here",
    "rect": { "l": 0.05, "t": 0.03, "w": 0.90, "h": 0.04 },
    "fontSize": 12,
    "fontFamily": "serif"
  }
]`;

/**
 * OCR prompt for filepath mode (when sending PDF path instead of image).
 */
export const DEFAULT_OCR_FILEPATH_PROMPT = `Analyze layout of the file: {{absoluteFilePath}}
Page: {{pageNumber}}

Extract all text blocks with their positions. Return ONLY valid JSON:

[
  {
    "id": "block-1",
    "text": "extracted text",
    "rect": { "l": 0.0, "t": 0.0, "w": 1.0, "h": 0.05 },
    "fontSize": 12,
    "fontFamily": "serif"
  }
]`;

/**
 * Ollama-specific prompt optimized for small models (llava:7b, moondream, etc.).
 * Emphasizes strict JSON formatting and provides concrete examples.
 */
export const OLLAMA_OCR_PROMPT_LENIENT = `Analyze the layout of this page, coordinates of each text block. Extract ALL text blocks with positions.

RULES:
1. Output ONLY a JSON array. NO other text.
2. Start with [ and end with ]
3. Each block: {"id":"b1","text":"...","rect":{"l":0.x,"t":0.x,"w":0.x,"h":0.x},"fontSize":12,"fontFamily":"sans-serif"}
4. Use DOUBLE quotes only
5. NO comments, NO markdown, NO explanations
6. NO trailing commas after last item
7. If uncertain about coordinates, estimate but KEEP JSON VALID

Example valid output:
[{"id":"b1","text":"Hello","rect":{"l":0.1,"t":0.2,"w":0.3,"h":0.05},"fontSize":12,"fontFamily":"sans-serif"}]

Now analyze the image and output ONLY the JSON array:`;

/**
 * Repair-friendly prompt for models that struggle with perfect JSON.
 * Explicitly allows imperfect output that will be repaired.
 */
export const OLLAMA_OCR_PROMPT_REPAIR_FRIENDLY = `OCR this page. Extract all text blocks.

IMPORTANT: If you cannot output perfect JSON, output the best JSON-like structure you can.
- Use brackets [] and braces {}
- Use double quotes " for strings
- Separate items with commas
- I will repair formatting errors

Return the data in this format:
[
  {
    "id": "block-1",
    "text": "content here",
    "rect": { "l": 0.0, "t": 0.0, "w": 0.0, "h": 0.0 },
    "fontSize": 12,
    "fontFamily": "sans-serif"
  }
]

Analyze the image now:`;

// ════════════════════════════════════════════════════════════════
// DEFAULT OCR PROVIDER SETTINGS
// ════════════════════════════════════════════════════════════════

export const DEFAULT_OCR_PROVIDER_SETTINGS: OcrProviderSettings = {
  provider: 'openrouter',
  apiKey: '',
  model: 'google/gemini-flash-1.5',
  apiEndpoint: '',
  headers: '{}',
  requestBody: '{}',
  temperature: 0.1,
  maxTokens: 8192,
  inputMode: 'image',
  workflowMode: 'per-page',
  ocrPromptTemplate: DEFAULT_OCR_PROMPT,
  ocrFullDocPromptTemplate: DEFAULT_OCR_PROMPT,
  responseFormatInstruction: '',
  responseJsonPath: '',
  imageScale: 2,
  imageFormat: 'png',
  imageQuality: 0.92,
  jsonStrictness: 'strict',  // Default to strict, can be relaxed for small models
};

// ════════════════════════════════════════════════════════════════
// DEFAULT PLUGIN SETTINGS
// ════════════════════════════════════════════════════════════════

export const DEFAULT_SETTINGS: OpenRouterTranslatorSettings = {
  // --- Provider-Aware Defaults ---
  apiProvider: 'openrouter',
  providerSettings: {
    openrouter: {
      apiKey: '',
      model: 'google/gemini-flash-1.5',
      temperature: 0.3,
      enableReasoning: false,
    },
    openai: {
      apiKey: '',
      model: 'gpt-4o',
      temperature: 0.3,
      enableReasoning: false,
    },
    gemini: {
      apiKey: '',
      model: 'models/gemini-1.5-flash',
      temperature: 0.3,
      enableReasoning: false,
    },
    ollama: {
      apiEndpoint: 'http://localhost:11434',
      model: 'llama3',
      temperature: 0.3,
      enableReasoning: false,
    },
    custom: {
      apiEndpoint: '',
      apiKey: '',
      model: '',
      temperature: 0.3,
      enableReasoning: false,
      headers: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer {apiKey}"\n}',
      requestBody: '{\n  "model": "{model}",\n  "messages": [\n    {\n      "role": "system",\n      "content": "{systemPrompt}"\n    },\n    {\n      "role": "user",\n      "content": "{userPrompt}"\n    }\n  ],\n  "temperature": {temperature}\n}',
      responsePath: 'choices[0].message.content',
    },
  },
  
  // --- Layout Engine (replaces useExternalLayout) ---
  layoutEngine: 'internal',
  
  // External Layout / Python settings
  pythonPath: 'python',
  ocrScriptPath: '',
  
  // --- OCR Provider ---
  ocrProvider: { ...DEFAULT_OCR_PROVIDER_SETTINGS },
  
  // --- PDF Export Settings ---
  mergeScriptPath: '',
  exportOutputDirectory: '',
  exportTextColor: '#000000',
  exportTextOpacity: 1.0,
  exportFontSizeScale: 0.95,
  exportAsAnnotation: true,
  // Legacy/compat defaults
  pdfExportScriptPath: '',
  exportBackgroundColor: '#FFFFFF',
  exportBackgroundOpacity: 90,
  exportPreserveOriginal: true,
  exportAutoOpen: true,
  
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
  autoRefreshOverlay: true,
  storageLocation: '',
  useIndividualMarkdownStorage: true,
  indexFilePath: 'Index.md',
  
  // UI Settings
  manualRefinementMode: false,
  showOverlayByDefault: true,
  clickToShowMode: false,
  bboxEditMode: false,
  layoutDebugMode: false,
  
  // Custom Prompts
  useGemmaPrompt: false,
  
  // UPDATED BATCH PROMPT to match processing.ts [#ID] logic
  batchPrompt: `You are a precise document translator working in veterinary medicine, translating between {sourceLang} and {targetLang}. 

Your task is to translate the provided lines while STRICTLY maintaining a specific separator format.

Format Requirements:
1. The input uses "[#ID]" tags to identify segments.
2. You MUST return the translation using the EXACT same "[#ID]" tags.
3. Do not merge lines. Do not delete tags.
4. Output ONLY the translated segments. No conversational filler.

Example:
Input:
[#1] Acute kidney injury (AKI) in dogs.
[#2] Treatment options include fluid therapy.
Output:
[#1] Острое повреждение почек (AKI) у собак.
[#2] Варианты лечения включают инфузионную терапию.

Translation Rules:
- Return exactly {lineCount} lines.
- Use precise veterinary terminology (clinical, pathological, anatomical, pharmacological).
- DO NOT translate acronyms (e.g., FeLV, FIV, AKI); keep them in the original language.
- Do not split paragraphs. One input line = One output line.
- Do not add conversational text, markdown code blocks, or notes.
- Ensure 1:1 mapping: if the input has 5 lines, the output must have 5 lines.

Now translate:
{inputText}`,

  singlePrompt: `Translate from {sourceLang} to {targetLang}. Only output the translation. Preserve formatting and tone.`,
  
  // Custom Copy Formats
  calloutFormat: '> [!quote] Translation\n> {blockquote_text}\n>\n> {pagelink}',
  citationFormat: '{blockquote_text}\n> — {filename}, page {pagenumber}',
  footnoteFormat: '^{text} [[{filename}#page={pagenumber}|source]]',
};
