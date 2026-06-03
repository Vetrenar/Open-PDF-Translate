// default-prompts.ts
// ─────────────────────────────────────────────────────────────────────────
// Neutral, domain-agnostic default prompts + per-mode UI descriptions.
// These are the defaults for new users. The optional "special template"
// (useGemmaPrompt / customTemplate) is a separate, user-editable override.
// ─────────────────────────────────────────────────────────────────────────

/** Single-segment / sequential translation. */
export const DEFAULT_SINGLE_PROMPT =
`You are a professional translator. Translate the text from {sourceLang} to {targetLang}.
Output only the translation — no explanations, notes, or commentary.
Preserve the original formatting, line breaks, inline emphasis, and tone.
Keep acronyms, code identifiers, URLs, and proper nouns that are conventionally left untranslated exactly as they appear in the source.`;

/**
 * Batch translation. The [#ID] contract is what processing.ts parses back,
 * so the rules below must stay strict and explicit.
 */
export const DEFAULT_BATCH_PROMPT =
`You are a professional translator. Translate the segments below from {sourceLang} to {targetLang}.

Format rules (follow exactly):
1. Each input segment is marked with a [#ID] tag.
2. Return each translation prefixed with the SAME [#ID] tag.
3. Do not merge, split, reorder, or drop segments. One input segment = one output segment.
4. Output only the translated segments — no commentary and no markdown code fences.
5. Return exactly {lineCount} segments.

Translation rules:
- Preserve inline emphasis, numbering, and list markers.
- Keep acronyms, code identifiers, and untranslatable proper nouns in the original language.

Example
Input:
[#1] The sample begins here.
[#2] It continues on the next line.
Output:
[#1] <translated segment 1>
[#2] <translated segment 2>

Now translate:
{inputText}`;

/**
 * TRUE-OCR (text) mode — transcription only. No JSON, no coordinates.
 * Used by ocr-text.ts. This is the prompt that makes the OCR engine reliable,
 * because it asks the vision model only for what it does well (reading text).
 */
export const DEFAULT_OCR_TEXT_PROMPT =
`Transcribe ALL readable text from this page in natural reading order
(top to bottom; for multi-column layouts, finish the left column before the right).

- Join lines that belong to the same paragraph; separate paragraphs with a blank line.
- Keep each heading on its own line.
- Keep list items with their markers.
- Transcribe tables row by row, left to right.
- Do NOT output commentary, coordinates, JSON, or invented page numbers.
- If the page contains no readable text, output nothing.

Output only the transcribed text.`;

// ── Per-mode help text for the settings UI ───────────────────────────────
// Show these next to the relevant selector so users pick the right tool
// instead of guessing.

export const LAYOUT_ENGINE_DESCRIPTIONS: Record<'internal' | 'python' | 'ocr-api', string> = {
    internal:
        'DOM text layer. Fast, no setup. Works only on PDFs that already have selectable text (not scans). Overlay positions are approximate.',
    python:
        'External PyMuPDF script. Best coordinate accuracy and table handling. Requires Python + PyMuPDF and the bundled script (install via the command). PDFs with a text layer only.',
    'ocr-api':
        'Vision-model OCR. The only option for scanned PDFs with no text layer. Recommended output is a translation-only note (see OCR output mode below); overlay coordinates from vision models are unreliable.',
};

export const OCR_OUTPUT_MODE_DESCRIPTIONS: Record<'translation-note' | 'overlay', string> = {
    'translation-note':
        'Recommended. Transcribes each page and writes a translation-only Markdown note linked to the PDF. No overlay, no coordinates — robust for scans.',
    overlay:
        'Experimental. Attempts to place translated overlays using coordinates the vision model estimates. Most models do this poorly; expect misplaced or zero-size boxes.',
};
