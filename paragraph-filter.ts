// paragraph-filter.ts
//
// Stage 2.4 (NEW): Rule-based Paragraph Filter
//
// Allows users to define regex rules that prevent certain paragraphs from
// being sent to the LLM for translation. Matching paragraphs are kept
// as-is (original text) in the overlay, saving API costs on page numbers,
// single letters, URLs, etc.
//
// Rules are stored in data.json (plugin settings) and applied at the
// `executeTranslation` stage — paragraphs matching a rule have their
// `translatedText` set to the original text, and are NOT sent to the LLM.
//
// UI: Settings → Advanced → "Paragraph Filter Rules" (table with
// [Enabled] [Name] [Pattern] [Action] [Test]).
//
// Defaults (enabled):
//   - Page numbers: ^\d{1,4}$ (1-4 digits, typically page numbers)
//   - Single letter: ^[a-zA-Zа-яА-Я]$ (single letter, often drop-cap/section)
//
// Per Q-F6: rules only apply to NEW translations. Existing `.translations.md`
// files are not retroactively filtered.

export interface ParagraphFilterRule {
    /** Unique identifier (auto-generated). */
    id: string;
    /** User-friendly name shown in the UI table. */
    name: string;
    /** Regex pattern (tested against paragraph text, case-insensitive). */
    pattern: string;
    /** Whether the rule is active. */
    enabled: boolean;
}

/** Default rules — 2 enabled, as per Q-F4 decision. */
export const DEFAULT_PARAGRAPH_FILTER_RULES: ParagraphFilterRule[] = [
    {
        id: 'preset-page-numbers',
        name: 'Page numbers',
        pattern: '^\\d{1,4}$',
        enabled: true,
    },
    {
        id: 'preset-single-letter',
        name: 'Single letter',
        pattern: '^[a-zA-Zа-яА-Я]$',
        enabled: true,
    },
];

/**
 * Compiled rule (regex pre-compiled for performance).
 */
interface CompiledRule {
    id: string;
    name: string;
    regex: RegExp;
}

/**
 * Compile enabled rules into RegExp objects. Called once per translation
 * batch (not per paragraph) for performance.
 *
 * Invalid regex patterns are silently skipped (with a console.warn in
 * debug mode) — we don't want one bad rule to break the entire translation.
 */
export function compileRules(rules: ParagraphFilterRule[]): CompiledRule[] {
    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
        if (!rule.enabled || !rule.pattern) continue;
        try {
            // Case-insensitive, multiline (so ^ and $ match line boundaries
            // within multi-line paragraph text).
            const regex = new RegExp(rule.pattern, 'im');
            compiled.push({ id: rule.id, name: rule.name, regex });
        } catch (err) {
            console.warn(`[ParagraphFilter] Invalid regex in rule "${rule.name}": ${rule.pattern}`, err);
        }
    }
    return compiled;
}

/**
 * Test whether a paragraph's text matches any of the compiled rules.
 * Returns the matching rule (for logging), or null if no match.
 *
 * The text is trimmed before testing so leading/trailing whitespace
 * doesn't prevent matches against patterns like `^\d+$`.
 */
export function matchParagraphFilter(
    text: string,
    compiledRules: CompiledRule[],
): CompiledRule | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    for (const rule of compiledRules) {
        if (rule.regex.test(trimmed)) {
            return rule;
        }
    }
    return null;
}

/**
 * Split an array of paragraphs into (translatable, skipped) groups based
 * on filter rules. Skipped paragraphs will use their original text as the
 * "translation" (per Q-F1 decision: overlay is created with original text,
 * not skipped entirely).
 *
 * Returns:
 *   - translatable: indices of paragraphs that should be sent to the LLM
 *   - skipped: map of index → rule name (for logging/debug)
 */
export function filterParagraphs(
    texts: string[],
    compiledRules: CompiledRule[],
): { translatable: number[]; skipped: Map<number, string> } {
    const translatable: number[] = [];
    const skipped = new Map<number, string>();
    for (let i = 0; i < texts.length; i++) {
        const match = matchParagraphFilter(texts[i], compiledRules);
        if (match) {
            skipped.set(i, match.name);
        } else {
            translatable.push(i);
        }
    }
    return { translatable, skipped };
}

/**
 * Generate a unique ID for a new rule. Uses timestamp + random suffix
 * to avoid collisions.
 */
export function generateRuleId(): string {
    return `rule-${crypto.randomUUID()}`;
}
