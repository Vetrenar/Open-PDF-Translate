// pdf-source.ts
// ─────────────────────────────────────────────────────────────────────────
// Single source of truth for the `pdf-source` frontmatter link that ties a
// .translations.md (or .translated.md) note to its PDF.
//
// BUG FIXED — apostrophes in filenames:
//   The old emitter wrote a SINGLE-quoted YAML scalar:
//       pdf-source: '[[John's notes.pdf]]'
//   In YAML a single-quoted string ends at the first apostrophe, so the value
//   parsed as `[[John` and the link never resolved → translations silently
//   failed to save/load for any file with a "'" in its name.
//   We now emit a properly escaped DOUBLE-quoted scalar:
//       pdf-source: "[[John's notes.pdf]]"
//   (Obsidian itself uses double quotes for wikilinks in frontmatter.)
//
// DEDUPE — this module replaces the copy-pasted link cleaning + 3-strategy
// resolution that lived in main.ts and storage.ts (twice).
// ─────────────────────────────────────────────────────────────────────────

import { App, TFile, normalizePath } from 'obsidian';

export const PDF_SOURCE_KEY = 'pdf-source';

/** Escape a string for use inside a YAML double-quoted scalar. */
function yamlDoubleQuote(s: string): string {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * The value half of the frontmatter line, e.g. `"[[folder/John's file.pdf]]"`.
 * Safe for apostrophes and for the (rare, non-Windows) double-quote case.
 */
export function formatPdfSourceValue(pdfPath: string): string {
    return yamlDoubleQuote(`[[${pdfPath}]]`);
}

/** The full `pdf-source: "[[...]]"` line. */
export function formatPdfSourceLine(pdfPath: string): string {
    return `${PDF_SOURCE_KEY}: ${formatPdfSourceValue(pdfPath)}`;
}

/**
 * Normalize a raw frontmatter value to a clean vault path.
 * Tolerant of every historical format: wrapping single/double quotes,
 * [[ ]] wikilink brackets, and |aliases. Works on both YAML-parsed values
 * and raw text (so it can recover notes written with the old broken format).
 */
export function cleanPdfSourcePath(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';

    // Strip wrapping quotes (may survive when reading raw frontmatter text).
    // For double-quoted scalars, also reverse YAML's \" and \\ escaping so the
    // raw-recovery path yields the same value the YAML parser would.
    if (s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    } else if (s.startsWith("'") && s.endsWith("'")) {
        s = s.slice(1, -1).trim();
    }
    // Strip [[ ]] wikilink brackets.
    if (s.startsWith('[[') && s.endsWith(']]')) {
        s = s.slice(2, -2).trim();
    }
    // Drop |alias. (A literal "|" in a filename can't be represented in a
    // wikilink anyway — Obsidian treats it as the alias separator — so this is
    // an inherent wikilink limitation, not specific to this parser.)
    const pipe = s.indexOf('|');
    if (pipe !== -1) s = s.slice(0, pipe).trim();

    return s;
}

/**
 * Resolve a cleaned link path to a PDF TFile, trying link resolution, then
 * absolute path, then normalized path. Returns null if it isn't a PDF.
 */
export function resolvePdfFromSource(
    app: App,
    linkPath: string,
    sourceMdPath: string
): TFile | null {
    if (!linkPath) return null;

    const viaLink = app.metadataCache.getFirstLinkpathDest(linkPath, sourceMdPath);
    if (viaLink instanceof TFile && viaLink.extension === 'pdf') return viaLink;

    const viaPath = app.vault.getAbstractFileByPath(linkPath);
    if (viaPath instanceof TFile && viaPath.extension === 'pdf') return viaPath;

    const viaNorm = app.vault.getAbstractFileByPath(normalizePath(linkPath));
    if (viaNorm instanceof TFile && viaNorm.extension === 'pdf') return viaNorm;

    return null;
}

/**
 * Read + clean pdf-source from a note's PARSED frontmatter cache.
 * Returns '' if absent. (For files written with the old broken single-quoted
 * format, the parsed cache may be empty/wrong — use readPdfSourceRaw as a
 * recovery fallback when this returns '' but the file clearly has frontmatter.)
 */
export function readPdfSourceFromCache(app: App, mdFile: TFile): string {
    const fm = app.metadataCache.getFileCache(mdFile)?.frontmatter;
    return cleanPdfSourcePath(fm?.[PDF_SOURCE_KEY]);
}

/**
 * Recovery fallback: extract pdf-source directly from raw file content,
 * bypassing the YAML parser. Use this to migrate notes saved with the old
 * apostrophe-breaking format. `content` is the full note text.
 */
export function readPdfSourceRaw(content: string): string {
    const fm = content.match(/^---\n([\s\S]+?)\n---/);
    if (!fm) return '';
    const line = fm[1].match(/^pdf-source:\s*(.+)$/m);
    return line ? cleanPdfSourcePath(line[1]) : '';
}

/**
 * Rewrite (or insert) the pdf-source line inside an existing frontmatter
 * block, preserving the rest. Returns the new content (or the original if no
 * frontmatter block exists). Use for repairing stale links after rename/move.
 */
export function setPdfSourceInFrontmatter(content: string, pdfPath: string): string {
    return content.replace(/^---[\s\S]*?\n---/, (fmBlock) => {
        if (/^pdf-source:\s*/m.test(fmBlock)) {
            return fmBlock.replace(/^pdf-source:\s*.*$/m, formatPdfSourceLine(pdfPath));
        }
        const parts = fmBlock.split('\n');
        parts.splice(1, 0, formatPdfSourceLine(pdfPath)); // after opening ---
        return parts.join('\n');
    });
}
