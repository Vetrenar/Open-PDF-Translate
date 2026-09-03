// storage.ts
import { TFile, TFolder, normalizePath, Notice, parseYaml, App } from 'obsidian';
import DOMPurify from 'dompurify';
import OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';
import {
    formatPdfSourceLine, readPdfSourceFromCache, readPdfSourceRaw,
    resolvePdfFromSource, setPdfSourceInFrontmatter,
} from './pdf-source';
// Phase 7 (V4 Schema): stable per-overlay identifier generator. Used at
// every OverlayPositionData construction site that doesn't already have an
// `id` from a prior save (i.e. all extraction paths — see overlay-id.ts for
// the rationale and stability guarantees).
// Phase 8 (V4 Schema): layoutSettingsHash + engine stamp helpers. The hash
// is emitted in frontmatter and consulted by `isCached`/`getCachedPages`
// (pdf-layout-queue.ts) to detect preset changes. `getCurrentEngine` is
// used by `updatePageOverlaysAndWrite`'s V3→V4 migration step to back-fill
// the `engine` field on overlays that predate Phase 8.
import { generateOverlayId, computeLayoutSettingsHash, getCurrentEngine } from './overlay-id';

// Phase 7 (C4): DOMPurify config for sanitizing translated text on read.
//
// Translation files (.translations.md) are user-editable markdown — anything
// the user (or a malicious actor with vault write access) puts in the
// `translatedText` line would otherwise end up in the DOM via innerHTML in
// the overlay renderer. DOMPurify strips everything except a strict
// whitelist of inline formatting tags so the rendered overlay can't execute
// arbitrary HTML/JS.
//
// - ALLOWED_TAGS: only basic inline formatting (`<b>`, `<i>`, `<br>`, etc.).
//   No `<a>` (click-handler / javascript: URL risk), no `<img>` (onerror
//   risk), no `<script>`/`<style>`/`<iframe>`.
// - ALLOWED_ATTR: empty — no attributes at all, so no `onerror`, `onclick`,
//   `style`, `class`, `href`. This is stricter than necessary but matches
//   the SPEC's defense-in-depth posture.
// - KEEP_CONTENT: true — strip disallowed tags but keep their text content
//   (so `<script>alert(1)</script>` becomes `alert(1)` instead of executing,
//   and `<a href="...">click</a>` becomes `click`).
const PURIFY_CONFIG: DOMPurify.Config = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'sup', 'sub', 'u'],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
};

/**
 * VERSION HISTORY:
 * v1: Original format (comments with raw JSON in a table)
 * v2: Base64 metadata in a table  (DEPRECATED — parser removed in Phase 8)
 * v3: Improved format (JSON in %% comments, no table) — still readable
 * v4: V4 schema — adds `engine` (per-overlay + frontmatter),
 *     `layoutSettingsHash` (frontmatter), and stamps `id` on every overlay.
 *     V3 files continue to parse (back-compat) and are lazily migrated to
 *     V4 on the next write through `updatePageOverlaysAndWrite` (see
 *     `needsMigration` flag on SavedOverlay).
 */
export const STORAGE_FORMAT_VERSION = 4;

/**
 * Manages storage and retrieval of translation overlays in individual .translations.md files.
 * Uses frontmatter linkage (`pdf-source: '[[file.pdf]]'`) for fast, renaming-resilient lookup.
 *
 * Key improvements in v3:
 * - Human-readable JSON metadata inside Obsidian comments (`%%...%%`).
 * - Original text is stored inside the metadata, not in the markdown body.
 * - No more markdown tables, making edits and copy-pasting simpler.
 * - Translated text appears directly under its metadata, with `<br>` for newlines.
 */
export class TranslationStorage {
    private plugin: OpenRouterTranslatorPlugin;
    private app: App;
    private loadingPromises: Map<string, Promise<void>> = new Map();  // Per-file concurrency guard
    private writingPromises: Map<string, Promise<void>> = new Map(); // Concurrency guard for writing

    // Phase 4 (P1-34): the `domCacheTimestamps` Map, the
    // `invalidateDomCache` method, the `DOM_CACHE_TTL_MS` constant, and
    // the constructor's `vault.on('modify')` handler that cleared the
    // map on external edits have ALL been removed.
    //
    // Rationale: the DOM-level TTL cache (introduced in Phase 20 / C24)
    // was a second source of truth alongside the renderer's
    // `_cachedOverlayData` (now private per P1-33). It existed to catch
    // *external* edits that bypassed `updateCacheFromWrite`, but the
    // 30s TTL was a poor freshness guarantee — it would either needlessly
    // re-read from disk (under-invalidation) or briefly serve stale
    // overlays (over-invalidation).
    //
    // After Phase 4, external edits are caught by `metadataCache.on('changed')`
    // in main.ts (which rebuilds `pdfToMdMap` and triggers a renderer
    // refresh via `resetStateForNewFile` + `initializeOverlayStateForPdf`).
    // Callers that need to force a specific page to re-render after an
    // in-process mutation now use `overlay.invalidatePage(N)` (which
    // clears both the `_cachedOverlayData.pageOverlays[N]` entry and the
    // `loadedOverlayPages` tracking bit) — see overlay-ui.ts:1334.

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
    }

    /**
     * Gets the user-defined storage location for translation files.
     * Defaults to same folder as PDF if empty.
     */
    get storageLocation(): string {
        return this.plugin.settings.storageLocation || '';
    }

    /**
     * Ensures the storage folder exists.
     */
    async ensureStorageFolder(): Promise<void> {
        const path = this.storageLocation;
        if (!path || path === '/' || path === '.' || path === '..') return;

        try {
            const folder = this.app.vault.getAbstractFileByPath(path);
            if (folder instanceof TFolder) return;

            if (folder) {
                throw new Error(`Path conflict: a file exists at '${path}'`);
            }

            await this.app.vault.createFolder(path);
        } catch (error) {
            if (!String(error).includes('Folder already exists')) {
                console.error(`PDF Translator: Failed to create folder '${path}'`, error);
                new Notice(`Error: Could not create folder "${path}"`);
            }
        }
    }

    /**
     * Finds the translation file for a PDF using the cached map.
     */
    async findTranslationFileForPdf(pdfFile: TFile): Promise<TFile | null> {
        const translationPath = this.plugin.pdfToMdMap.get(pdfFile.path);
        if (translationPath) {
            const file = this.app.vault.getAbstractFileByPath(translationPath);
            if (file instanceof TFile) return file;
        }
        return null;
    }

    /**
     * Constructs the translation file path based on settings.
     */
    getTranslationFilePath(pdfFile: TFile): string {
        const baseName = pdfFile.basename;
        const dir = this.storageLocation || pdfFile.parent?.path || '';
        const cleanDir = dir && dir !== '/' ? dir.replace(/\/+$/, '') : '';  // Remove trailing slashes, handle root
        return normalizePath(`${cleanDir ? cleanDir + '/' : ''}${baseName}.translations.md`);
    }

    /**
     * Generates the markdown content for a translation file in the v3 format.
     *
     * Phase 4 (P0-10): added optional `opts` parameter so callers that need
     * extra frontmatter fields (e.g. `createLayoutFileWithOriginals` setting
     * `originals-only: true`) can go through the canonical generator instead
     * of post-injecting flags via regex. The default behaviour is unchanged
     * when `opts` is omitted.
     */
    generateMarkdownForOverlay(
        savedOverlay: SavedOverlay,
        pdfFile: TFile,
        opts?: {
            originalsOnly?: boolean;
            frontmatter?: Record<string, string>;
        },
    ): string {
        // Phase 4 (P0-10): build frontmatter as ordered lines so the
        // originals-only / custom-frontmatter flags can be inserted
        // deterministically between format-version and the closing `---`.
        // The on-disk field order is preserved exactly as before for the
        // default (no-opts) case: pdf-source, timestamp, format-version.
        //
        // Phase 8 (V4 Schema): after format-version, emit `engine` (primary
        // engine for the file — derived from the first overlay's engine, or
        // `getCurrentEngine(plugin)` if no overlays have one yet) and
        // `layoutSettingsHash` (current `plugin.layoutSettings` hash). Both
        // are V4 additions; V3 readers ignore unknown frontmatter keys.
        const fmLines: string[] = [
            '---',
            formatPdfSourceLine(pdfFile.path),
            `timestamp: ${new Date(savedOverlay.timestamp).toISOString()}`,
            `format-version: ${STORAGE_FORMAT_VERSION}`,
        ];
        // Phase 8 (V4 Schema): primary engine for the file. Prefer the
        // first overlay's `engine` (most accurate — reflects what actually
        // produced the bulk of the content); fall back to the live
        // `getCurrentEngine(plugin)` for empty / pre-V4 files. The
        // `'unknown'` fallback matches `getCurrentEngine`'s own default.
        const allOverlays = Object.values(savedOverlay.pageOverlays).flat() as Array<{ engine?: string }>;
        const primaryEngine = allOverlays.find(o => o.engine)?.engine
            || getCurrentEngine(this.plugin)
            || 'unknown';
        fmLines.push(`engine: ${primaryEngine}`);
        // Phase 8 (V4 Schema): layoutSettingsHash. Computed from the live
        // `plugin.layoutSettings` so the file always reflects the settings
        // under which its bboxes were extracted. `isCached`/`getCachedPages`
        // (pdf-layout-queue.ts) compare this hash against the current hash
        // and force a re-translate on mismatch (P2-3 layout invalidation).
        fmLines.push(`layoutSettingsHash: ${computeLayoutSettingsHash(this.plugin.layoutSettings)}`);
        if (opts?.originalsOnly) {
            fmLines.push('originals-only: true');
        }
        if (opts?.frontmatter) {
            for (const [k, v] of Object.entries(opts.frontmatter)) {
                fmLines.push(`${k}: ${v}`);
            }
        }
        fmLines.push('---', '');
        const frontmatter = fmLines.join('\n');

        let md = frontmatter + `
# Translations for ${pdfFile.basename}
> Last updated: ${new Date(savedOverlay.timestamp).toLocaleString()}

`;

        const pageNumbers = Object.keys(savedOverlay.pageOverlays)
            .map(Number)
            .sort((a, b) => a - b);

        for (const pageNumber of pageNumbers) {
            const items = savedOverlay.pageOverlays[pageNumber];
            if (!items?.length) continue;

            md += `\n## Page ${pageNumber}\n\n`;
            md += `[[${pdfFile.path}#page=${pageNumber}|→ View page]]\n\n`;

            items.forEach(item => {
                const originalText = (item.textContent || '').trim();

                // Build metadata with abbreviated keys for compactness
                const metadata: any = {
                    r: {
                        l: parseFloat(item.relativeRect.left.toFixed(4)),
                        t: parseFloat(item.relativeRect.top.toFixed(4)),
                        w: parseFloat(item.relativeRect.width.toFixed(4)),
                        h: parseFloat(item.relativeRect.height.toFixed(4)),
                    },
                    page: item.page,
                    ot: originalText, // Original Text
                };

                // Add font info if available
                if (item.fontSize !== undefined) {
                    metadata.fs = parseFloat(item.fontSize.toFixed(2)); // fontSize
                }
                if (item.fontFamily) {
                    metadata.ff = item.fontFamily; // fontFamily
                }
                if (item.originalFontSizes && item.originalFontSizes.length > 0) {
                    metadata.ofs = item.originalFontSizes.map(fs => parseFloat(fs.toFixed(2))); // originalFontSizes
                }
                // Phase 7 (V4 Schema): emit `id` if present. Conditional (like
                // `ff` above) so V3 files without an id continue to round-trip
                // without forcing a rewrite on every save. Once an overlay has
                // been through a Phase-7-or-later construction site, the id is
                // stable across all subsequent saves.
                if (item.id) {
                    metadata.id = item.id;
                }
                // Phase 8 (V4 Schema): emit `engine` if present. Conditional
                // for the same reason as `id` — V3 files without `engine`
                // round-trip unchanged until re-saved through a Phase-8
                // construction site. The V3→V4 migration in
                // `updatePageOverlaysAndWrite` back-fills this field on
                // first write after Phase 8 deployment.
                if (item.engine) {
                    metadata.engine = item.engine;
                }

                const metadataStr = JSON.stringify(metadata);
                const comment = `%% ${metadataStr} %%`;

                // Convert newlines in translated text to <br> for markdown rendering
                const translated = (item.translatedText || '').trim().replace(/\n/g, '<br>');

                md += `${comment}\n\n`;
                if (translated) {
                    md += `${translated}\n\n`;
                } else {
                    // FIX A3: emit explicit empty marker so parser can distinguish
                    // "empty translation" from "missing translation line".
                    // Without this, the parser's "first non-empty line" heuristic
                    // swallows the next %% comment or ## Page header as the translation.
                    md += `<!-- empty -->\n\n`;
                }
            });
        }

        return md;
    }

    /**
     * Validates metadata structure against schema
     */
    private validateMetadata(metadata: any): boolean {
        // Check required top-level properties
        if (typeof metadata !== 'object' || !metadata.r || typeof metadata.page !== 'number') {
            return false;
        }

        // Validate rectangle properties
        const rect = metadata.r;
        if (
            typeof rect.l !== 'number' ||
            typeof rect.t !== 'number' ||
            typeof rect.w !== 'number' ||
            typeof rect.h !== 'number' ||
            rect.w <= 0 ||
            rect.h <= 0
        ) {
            return false;
        }
        return true;
    }

    /**
     * Checks if two rectangles overlap (used for merge-on-write to avoid duplicates).
     */
    private isRectOverlapping(
        a: { left: number; top: number; width: number; height: number },
        b: { left: number; top: number; width: number; height: number }
    ): boolean {
        const eps = 1e-5;
        return !(
            a.left + a.width < b.left - eps ||
            b.left + b.width < a.left - eps ||
            a.top + a.height < b.top - eps ||
            b.top + b.height < a.top - eps
        );
    }

    /**
     * Parses a markdown file into a SavedOverlay object.
     * Supports v1 (table-based, raw JSON in HTML comment) and v3 (comment-based).
     *
     * V2 (base64-encoded metadata) is NO LONGER SUPPORTED — its parser was
     * removed in Phase 8 because `escape()` and `atob()` are deprecated and
     * the format has been superseded by v3 since the audit. Encountering a
     * V2 file logs a warning and skips the affected overlay; the user should
     * run the "Repair translation file" command to migrate.
     */
    parseMarkdownOverlay(content: string, pdfFile: TFile): SavedOverlay | null {
        // FIX A5: anchored to start-of-file so a '---' inside the body
        // (e.g. an em-dash in translated text) doesn't get misread as frontmatter.
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
        let formatVersion = 1;
        let timestamp = Date.now();
        // Phase 8 (V4 Schema): primary engine + layoutSettingsHash are V4
        // frontmatter additions. Defaults are `undefined` so V3 files (which
        // lack these keys) are distinguishable from V4 files that explicitly
        // wrote `engine: unknown` / `layoutSettingsHash: 0000...`. The
        // `needsMigration` flag is set when format-version < 4 and consulted
        // by `updatePageOverlaysAndWrite` to stamp V4 fields on first write.
        let primaryEngine: string | undefined;
        let layoutSettingsHash: string | undefined;
        let needsMigration = false;

        if (frontmatterMatch) {
            try {
                const fmData = parseYaml(frontmatterMatch[1]);
                // Read version from frontmatter, default to 1 if not present
                formatVersion = fmData['format-version'] || fmData.version || 1;
                if (fmData.timestamp) {
                    const t = new Date(fmData.timestamp);
                    if (!isNaN(t.getTime())) timestamp = t.getTime();
                }
                // Phase 8 (V4 Schema): read primary engine + hash. V3 files
                // don't have these keys → `undefined` (not the empty string).
                // We deliberately do NOT default to `'unknown'` here so the
                // consumer can distinguish "file explicitly stamped unknown
                // engine" from "V3 file that predates the engine field".
                primaryEngine = fmData.engine;
                layoutSettingsHash = fmData.layoutSettingsHash;
                // Phase 8 (V4 Schema): V3 files (format-version < 4) need
                // migration. The flag is consumed by
                // `updatePageOverlaysAndWrite`, which stamps `id` + `engine`
                // on every overlay and bumps format-version to 4 on the next
                // write. Lazy migration keeps V3 files working without a
                // forced one-time rewrite of every file in the vault.
                if (formatVersion < 4) {
                    needsMigration = true;
                }
            } catch (err) {
                console.warn('PDF Translator: Failed to parse frontmatter YAML', err);
            }
        }

        // FIX A5: anchored frontmatter regex (was matching first '---' anywhere)
        const body = content.substring(frontmatterMatch?.[0].length || 0);
        const lines = body.split('\n');
        const pageOverlays: Record<string, OverlayPositionData[]> = {};
        let currentPage: string | null = null;

        // Use different parsing logic based on format version
        if (formatVersion >= 3) {
            // New V3 parsing logic (%% comments) — FIXED A1+A2+A3
            //
            // P2-44 (Phase 7): the regex previously required `^%%` at the
            // very start of the line — any leading whitespace (e.g. a
            // manually-indented `%% {...} %%` block edited in Obsidian's
            // markdown view) would silently fail to match, dropping the
            // overlay on parse. pdf-export.ts:293 already uses the looser
            // `^\s*%%...%%\s*$` form; this aligns the two parsers so a
            // file round-tripped through export → re-import produces
            // identical results.
            const V3_META_REGEX = /^\s*%%\s*(\{.*\})\s*%%\s*$/;
            const V3_PAGE_HEADER = /^##\s+Page\s+(\d+)/i;
            const V3_EMPTY_MARKER = /^<!--\s*empty\s*-->$/i;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                const pageMatch = line.match(V3_PAGE_HEADER);
                if (pageMatch) {
                    currentPage = pageMatch[1];
                    if (!pageOverlays[currentPage]) pageOverlays[currentPage] = [];
                    continue;
                }

                if (!currentPage) continue;

                const metaMatch = line.match(V3_META_REGEX);
                if (metaMatch) {
                    try {
                        const metadata = JSON.parse(metaMatch[1]);
                        if (!this.validateMetadata(metadata)) {
                            if (this.plugin.settings.debugMode) {
                                console.warn('PDF Translator: Invalid V3 metadata structure', metadata);
                            }
                            continue;
                        }

                        // P2-45 (Phase 7): read ALL non-empty lines until the
                        // next `%%` overlay comment, `## Page` header, or
                        // `<!-- empty -->` marker — not just the first one.
                        //
                        // Previously this loop grabbed only the first
                        // non-empty line after the `%%` metadata block, so a
                        // multi-line translation (e.g. a stanza, a list, or
                        // any translation whose source paragraph spanned
                        // multiple display lines) was silently TRUNCATED on
                        // reload — only line 1 survived. pdf-export.ts:264-268
                        // already joined all lines until the next `%%`/`#`;
                        // this aligns the two parsers.
                        //
                        // Empty-line handling: a SINGLE blank line between two
                        // content lines is preserved (joined with `\n`). A
                        // blank line immediately followed by `%%` or `## Page`
                        // is treated as the end of the translation (the blank
                        // is the writer's separator, not part of the content —
                        // see `generateMarkdownForOverlay` which always emits
                        // `\n\n` between an overlay's text and the next `%%`).
                        //
                        // `<br>` (case-insensitive, optional self-closing
                        // slash) is converted to `\n` to reverse the writer's
                        // `\n` → `<br>` substitution.
                        const translatedLines: string[] = [];
                        for (let j = i + 1; j < lines.length; j++) {
                            const nextLine = lines[j].trim();

                            // End-of-translation markers
                            if (V3_META_REGEX.test(nextLine)) break;        // next overlay → stop
                            if (V3_PAGE_HEADER.test(nextLine)) break;      // page header → stop
                            if (V3_EMPTY_MARKER.test(nextLine)) {          // explicit empty marker
                                i = j; // consume the marker so the outer loop skips it
                                break;
                            }

                            if (nextLine === '') {
                                // Blank line: end of translation if followed by
                                // a structural marker (writer emits `\n\n`
                                // between translated text and the next `%%`/
                                // `## Page`). Otherwise it's an in-translation
                                // paragraph break — preserve it.
                                const after = lines[j + 1]?.trim() ?? '';
                                if (after === '' || V3_META_REGEX.test(after) || V3_PAGE_HEADER.test(after)) {
                                    break;
                                }
                                translatedLines.push('');
                                continue;
                            }

                            translatedLines.push(nextLine);
                            i = j; // advance past the last consumed content line
                        }
                        let translatedText = translatedLines.length > 0
                            ? translatedLines.join('\n').replace(/<br\s*\/?>/gi, '\n')
                            : '';

                        // Phase 7 (C4): sanitize translated text to prevent stored XSS.
                        // The overlay renderer injects this string via innerHTML, so any
                        // HTML/JS in the file would otherwise execute. The whitelist
                        // (PURIFY_CONFIG) only permits inline formatting tags.
                        translatedText = DOMPurify.sanitize(translatedText, PURIFY_CONFIG);

                        // FIX A2: bucket by metadata.page (canonical), NOT by ## Page header.
                        // Recovery mode: if an overlay sits under a mismatched header
                        // (e.g. due to a previous writer bug or manual edit), we
                        // re-bucket it to its canonical page and log a warning.
                        const realPageKey = String(metadata.page);
                        if (metadata.page !== Number(currentPage)) {
                            console.warn(
                                `[storage] Recovery: overlay under ## Page ${currentPage} ` +
                                `has metadata.page=${metadata.page}. Re-bucketing to page ${metadata.page}.`
                            );
                            if (!pageOverlays[realPageKey]) pageOverlays[realPageKey] = [];
                        }

                        const overlayData: OverlayPositionData = {
                            selector: '', // Selector is deprecated
                            textContent: metadata.ot || '', // Original Text from metadata
                            relativeRect: {
                                left: metadata.r.l,
                                top: metadata.r.t,
                                width: metadata.r.w,
                                height: metadata.r.h,
                            },
                            page: metadata.page,
                            translatedText,
                            fontSize: metadata.fs,
                            fontFamily: metadata.ff,
                            originalFontSizes: metadata.ofs,
                            // Phase 7 (V4 Schema): read `id` if present.
                            // V3 files (no `id` key) get `undefined` here —
                            // merge-by-id-first in `updatePageOverlaysAndWrite`
                            // falls back to rect-overlap for these, so V3
                            // files continue to work without migration.
                            id: metadata.id,
                            // Phase 8 (V4 Schema): read `engine` if present.
                            // V3 files (no `engine` key) get `undefined`;
                            // the V3→V4 migration in `updatePageOverlaysAndWrite`
                            // back-fills this on first write. Consumers
                            // (e.g. future stale-engine-detection) should
                            // treat `undefined` as "unknown — pre-V4".
                            engine: metadata.engine,
                        };
                        if (!pageOverlays[realPageKey]) pageOverlays[realPageKey] = [];
                        pageOverlays[realPageKey].push(overlayData);
                    } catch (e) {
                         if (this.plugin.settings.debugMode) {
                            console.debug('PDF Translator: Invalid V3 metadata JSON', e);
                        }
                    }
                }
            }
        } else {
            // Fallback for V1/V2 (table-based)
            //
            // Phase 8: V2 (base64-encoded metadata via `escape(atob(...))`) is
            // deprecated and its parser has been removed. When V2 metadata is
            // detected we log a warning and skip the row; the user should run
            // "Repair translation file" to migrate. V1 (raw JSON in an HTML
            // comment) is kept for backward compatibility with very old files.
            const NEW_META_REGEX = /<!--\s*PDF_TRANSLATOR_METADATA:([a-zA-Z0-9+/=]+)\s*-->/;
            const OLD_META_REGEX = /<!--\s*(\{.*?\})\s*-->/;

            for (const line of lines) {
                const trimmed = line.trim();
                const pageMatch = trimmed.match(/^##\s+Page\s+(\d+)/i);
                if (pageMatch) {
                    currentPage = pageMatch[1];
                    pageOverlays[currentPage] = [];
                    continue;
                }
                if (!currentPage || !trimmed.startsWith('|') || trimmed.includes('|-|')) continue;

                const cells = this.parseMarkdownTableCells(trimmed);
                if (cells.length !== 2) continue;

                const [originalCell, translatedCell] = cells;

                // Phase 8: V2 format (base64-encoded metadata) is deprecated.
                // Log a warning and skip this row — do NOT attempt to decode it.
                // The user should run "Repair translation file" to migrate.
                if (NEW_META_REGEX.test(originalCell)) {
                    console.warn(
                        'V2 translation format detected (deprecated). ' +
                        'Run "Repair translation file" command to migrate.'
                    );
                    continue;
                }

                // V1 parsing path (raw JSON in HTML comment) — kept for
                // backward compatibility with very old translation files.
                const oldMetaMatch = originalCell.match(OLD_META_REGEX);
                let metadata: any = null;
                if (oldMetaMatch) {
                    try {
                        metadata = JSON.parse(oldMetaMatch[1]);
                    } catch (e) { /* ignore — malformed V1 JSON */ }
                }

                if (!metadata || !this.validateMetadata(metadata)) continue;

                const textContent = originalCell.replace(NEW_META_REGEX, '').replace(OLD_META_REGEX, '').replace(/\\\|/g, '|').trim();
                let translatedText = translatedCell.replace(/\\\|/g, '|').replace(/\\n/g, '\n');

                // Phase 7 (C4): sanitize translated text on read.
                translatedText = DOMPurify.sanitize(translatedText, PURIFY_CONFIG);

                const overlayData: OverlayPositionData = {
                    selector: metadata.sel || '',
                    textContent,
                    relativeRect: { left: metadata.r.l, top: metadata.r.t, width: metadata.r.w, height: metadata.r.h },
                    page: metadata.page,
                    translatedText,
                    fontSize: metadata.fontSize,
                    fontFamily: metadata.fontFamily,
                    originalFontSizes: metadata.originalFontSizes,
                    // Phase 7 (V4 Schema): V1 files predate the `id` field —
                    // `metadata.id` is always `undefined` here. Included for
                    // type-symmetry with the V3 reader so downstream code can
                    // treat both paths identically.
                    id: metadata.id,
                    // Phase 8 (V4 Schema): same — V1 files predate `engine`.
                    // Always `undefined` for V1; the migration step back-fills
                    // it on first write.
                    engine: metadata.engine,
                };
                pageOverlays[currentPage].push(overlayData);
            }
        }

        if (Object.keys(pageOverlays).length === 0) {
            return null;
        }

        return {
            fileName: pdfFile.basename.replace(/\.pdf$/i, ''),
            filePath: pdfFile.path,
            timestamp,
            pageOverlays,
            // Phase 8 (V4 Schema): propagate frontmatter-derived fields.
            // `engine` and `layoutSettingsHash` are read by consumers
            // (pdf-layout-queue.ts isCached/getCachedPages consults the
            // hash; future stale-engine-detection will consult engine).
            // `needsMigration` is consumed by `updatePageOverlaysAndWrite`
            // to stamp V4 fields on first write.
            engine: primaryEngine,
            layoutSettingsHash,
            needsMigration,
        };
    }

    /**
     * Helper to parse Markdown table cells, handling escaped pipes. (For V1/V2)
     */
    private parseMarkdownTableCells(line: string): string[] {
        const cells: string[] = [];
        let current = '';
        let i = 1; // Start after first '|'
        while (i < line.length - 1) { // End before last '|'
            const char = line[i];
            if (char === '\\' && line[i + 1] === '|') {
                current += '|';
                i += 2; // Skip escape and pipe
                continue;
            }
            if (char === '|') {
                cells.push(current.trim());
                current = '';
                i++; // Skip the pipe
                continue;
            }
            current += char;
            i++;
        }
        cells.push(current.trim()); // Last cell
        return cells;
    }

    /**
     * Deletes the overlay for the current page.
     * If it's the last page, deletes the whole file.
     */
    async deleteCurrentOverlay() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'pdf') {
            new Notice('Please open a PDF file first.');
            return;
        }

        const currentPageNumber = this.plugin.getCurrentPageNumber();
        if (currentPageNumber === null) return;

        const translationFile = await this.findTranslationFileForPdf(activeFile);
        if (!translationFile) {
            new Notice('No translation file found for this PDF.');
            return;
        }

        try {
            const content = await this.app.vault.read(translationFile);
            const savedOverlay = this.parseMarkdownOverlay(content, activeFile);
            if (!savedOverlay) {
                new Notice('Could not parse translation data.');
                return;
            }

            const pageKey = currentPageNumber.toString();
            if (!savedOverlay.pageOverlays[pageKey]) {
                new Notice(`No overlay saved for page ${currentPageNumber}.`);
                return;
            }

            // Delete this page
            delete savedOverlay.pageOverlays[pageKey];

            if (Object.keys(savedOverlay.pageOverlays).length === 0) {
                await this.app.vault.trash(translationFile, true);
                this.plugin.pdfToMdMap.delete(activeFile.path);
                new Notice(`Translation file deleted for ${activeFile.basename}`);
            } else {
                const markdownContent = this.generateMarkdownForOverlay(savedOverlay, activeFile);
                // Phase 2 (markSelfWrite fold): atomicWrite stamps self-write internally.
                // Phase 8 (C5): atomic write — partial writes could otherwise
                // corrupt the file mid-delete if Obsidian is interrupted.
                await this.atomicWrite(translationFile, translationFile.path, markdownContent);
                new Notice(`Overlay deleted for page ${currentPageNumber}`);
            }

            this.plugin.clearAllOverlays();
        } catch (error) {
            console.error('PDF Translator: Failed to delete overlay', error);
            new Notice('Error deleting overlay.');
        }
    }

    /**
     * Extracts positioning and content data from rendered overlay elements.
     * Uses the closest .page[data-page-number] to determine the page number.
     */
    extractPositionData(textLayer: HTMLElement, overlayContainer: Element): OverlayPositionData[] {
        // Delegate to the canonical implementation in OverlayRenderer, which is
        // leaf-scoped (via the PDF adapter) instead of using a global
        // document.querySelector. (#15 dedupe.)
        const textLayerRect = textLayer.getBoundingClientRect();
        if (textLayerRect.width === 0 || textLayerRect.height === 0) {
            console.error('PDF Translator: Text layer has zero dimensions');
            return [];
        }
        return this.plugin.overlay.extractPositionDataFrom(textLayer, overlayContainer, textLayerRect);
    }


    // ============================================================
    // Helpers for re-translation modal (read/write convenience)
    // ============================================================

    /**
     * Reads the saved overlay structure for a given PDF file.
     * Returns null if no file or no overlay data.
     */
    async readSavedOverlayForFile(pdfFile: TFile): Promise<{ mdFile: TFile; overlay: SavedOverlay } | null> {
        const mdFile = await this.findTranslationFileForPdf(pdfFile);
        if (!mdFile) return null;

        // Phase 4 (P1-32): race-condition fix. Before reading, await any
        // pending write for THIS pdfFile.path. Without this, `vault.read`
        // returns the pre-modify content while a `vault.modify`/atomic-write
        // is in flight — callers (e.g. applyBulkOverlayAction delete branch,
        // modal-edit-translation pre-read) would then build their update on
        // stale data and clobber the in-flight write.
        //
        // We swallow write errors here because a failed write should NOT
        // block the read — the on-disk file is still consistent (atomicWrite
        // either fully replaces or leaves the old content intact), so a read
        // is always safe and may even return the now-current (post-failure)
        // state. The original write error is surfaced by its own caller.
        const pendingWrite = this.writingPromises.get(pdfFile.path);
        if (pendingWrite) {
            try { await pendingWrite; } catch { /* write errors don't block reads */ }
        }

        try {
            const content = await this.app.vault.read(mdFile);
            const parsed = this.parseMarkdownOverlay(content, pdfFile);
            if (!parsed) return null;
            return { mdFile, overlay: parsed };
        } catch (e) {
            console.warn('PDF Translator: Failed to read saved overlay for file', pdfFile.path, e);
            return null;
        }
    }

    /**
     * Updates one or more pages in a SavedOverlay and writes to disk.
     * This function is now corrected to prevent race conditions.
     * pages is a map pageNumber -> array of OverlayPositionData.
     *
     * Phase 4 (P0-9 + P0-10): added optional `opts` parameter.
     *   - `opts.replace: true` → REPLACE per-page arrays directly (no
     *     merge-by-rect-overlap). Use this for callers that already have
     *     a fully-resolved view of the target page (delete, edit, retranslate)
     *     — without it, merge-by-overlap can silently resurrect deleted
     *     items (P0-9) when the caller's "new" array omits items that
     *     overlap the survivors.
     *   - `opts.originalsOnly: true` → emit `originals-only: true` in
     *     frontmatter (used by `createLayoutFileWithOriginals`).
     *   - `opts.frontmatter` → additional frontmatter fields merged after
     *     the default `pdf-source / timestamp / format-version` block.
     */
    async updatePageOverlaysAndWrite(
        pdfFile: TFile,
        pages: Record<number, OverlayPositionData[]>,
        opts?: {
            originalsOnly?: boolean;
            frontmatter?: Record<string, string>;
            replace?: boolean;
        },
    ): Promise<void> {
        const lockKey = pdfFile.path;

        // The core logic of reading, updating, and writing the file.
        const writer = async (): Promise<void> => {
            // --- START OF CORRECTED LOGIC ---

            // More robust: Directly check the filesystem for the file's existence
            // at the time of writing. This is the key to fixing the race condition.
            const translationPath = this.getTranslationFilePath(pdfFile);
            const abstractFile = this.app.vault.getAbstractFileByPath(translationPath);
            let mdFile: TFile | null = (abstractFile instanceof TFile) ? abstractFile : null;

            let savedOverlay: SavedOverlay | null = null;
            let parseFailed = false;

            if (mdFile) {
                // MODIFY PATH: File exists, so we read it.
                try {
                    const content = await this.app.vault.read(mdFile);
                    savedOverlay = this.parseMarkdownOverlay(content, pdfFile);
                } catch (e) {
                    this.plugin.logDebug("Failed to read or parse existing translation file, will overwrite.", e);
                    parseFailed = true;
                }
            }

            // If file didn't exist or failed to parse, create a new overlay object.
            // FIX: if parsing failed but the in-memory cache has data, use that
            // as the base instead of starting blank — prevents total data loss
            // when a transient parse error occurs on a file that has valid data
            // in the renderer's cache.
            //
            // Phase 4 (P1-33): access the cache via the public recovery accessor
            // instead of touching `cachedOverlayData` directly (the field is now
            // private).
            if (!savedOverlay) {
                const cached = this.plugin.overlay?.getCachedOverlayForRecovery(pdfFile.path);
                if (parseFailed && cached && cached.filePath === pdfFile.path) {
                    this.plugin.logDebug("Recovering from cache after parse failure.");
                    savedOverlay = {
                        fileName: pdfFile.basename.replace(/\.pdf$/i, ''),
                        filePath: pdfFile.path,
                        timestamp: cached.timestamp,
                        pageOverlays: { ...cached.pageOverlays },
                        // Phase 8 (V4 Schema): recovery-from-cache path. The
                        // cache holds the in-memory mirror of the last parsed
                        // overlay, so propagate any V4 fields it carries.
                        // `needsMigration` defaults to `false` — if the cache
                        // was populated from a V3 file, the migration flag was
                        // already consumed by the prior write attempt (and if
                        // not, the next read will re-set it from disk).
                        engine: cached.engine,
                        layoutSettingsHash: cached.layoutSettingsHash,
                        needsMigration: false,
                    };
                } else {
                    savedOverlay = {
                        fileName: pdfFile.basename.replace(/\.pdf$/i, ''),
                        filePath: pdfFile.path,
                        timestamp: Date.now(),
                        pageOverlays: {},
                        // Phase 8 (V4 Schema): brand-new file — no V3 → V4
                        // migration needed (we'll write V4 directly). Engine
                        // and hash are stamped by `generateMarkdownForOverlay`.
                        needsMigration: false,
                    };
                }
            }

            // Phase 8 (V4 Schema): V3→V4 migration. If the parsed file was
            // V3 (format-version < 4), back-fill `id` + `engine` on every
            // overlay. The `id` is generated via the same `generateOverlayId`
            // inputs the construction sites use, so merge-by-id-first will
            // work correctly on subsequent writes. The `engine` defaults to
            // `getCurrentEngine(plugin)` — we can't know which engine produced
            // a V3 overlay (V3 had no engine stamp), so the current engine is
            // the most honest answer (and matches what a fresh translation
            // would stamp). The format-version bump happens implicitly when
            // `generateMarkdownForOverlay` writes `STORAGE_FORMAT_VERSION`
            // (now 4).
            if (savedOverlay.needsMigration) {
                if (this.plugin.settings.debugMode) {
                    console.debug(
                        '[PDF Translator] V3→V4 migration: stamping id+engine on all overlays for',
                        pdfFile.path,
                    );
                }
                const migrationEngine = getCurrentEngine(this.plugin);
                for (const overlaysOfPage of Object.values(savedOverlay.pageOverlays)) {
                    for (const item of overlaysOfPage) {
                        if (!item.id) {
                            item.id = generateOverlayId(
                                item.page,
                                item.relativeRect,
                                item.textContent || '',
                            );
                        }
                        if (!item.engine) {
                            item.engine = migrationEngine;
                        }
                    }
                }
                // Clear the flag so we don't re-migrate on subsequent writes
                // (the format-version bump on disk will also prevent
                // `parseMarkdownOverlay` from re-setting it on next read).
                savedOverlay.needsMigration = false;
            }

            // Merge the new page data into the overlay.
            // FIX A7: instead of blindly replacing the per-page array, we merge
            // by rect overlap — new items supersede old items that overlap them,
            // but non-overlapping old items are preserved. This prevents data loss
            // when two processes (e.g. interactive re-translation of one region +
            // background worker writing the full page) write the same page.
            //
            // Phase 4 (P0-9): when `opts.replace === true`, REPLACE per-page
            // directly (skip the merge-by-overlap step). This is required for
            // delete/edit/retranslate callers — they already have a fully
            // resolved view of the target page and any items they DON'T list
            // must be considered intentionally removed. Merge-by-overlap would
            // keep "orphaned" items from the existing page whose rects overlap
            // the survivors, silently resurrecting deleted overlays on next
            // render (see P0-9 / audit 08 finding X1).
            for (const [pageStr, newItems] of Object.entries(pages)) {
                const p = Number(pageStr);
                if (newItems.length > 0) {
                    if (opts?.replace === true) {
                        // REPLACE: drop the entire existing page array, install
                        // the new one verbatim. No rect-overlap merge.
                        savedOverlay.pageOverlays[p] = [...newItems];
                    } else {
                        // MERGE (default): keep non-overlapping existing items,
                        // drop overlapping ones, append new items.
                        //
                        // P0-9 (Phase 7): merge-by-id-first. If an existing
                        // item has an `id`, it's considered superseded by a
                        // new item with the SAME `id` (regardless of rect
                        // overlap) — this is the V4 fast path that prevents
                        // deleted items from being silently resurrected when
                        // their rects happen to overlap a survivor.
                        //
                        // Items without an `id` (V3 files that haven't been
                        // re-saved since the Phase 7 upgrade) fall back to the
                        // legacy rect-overlap merge. This keeps V3 files
                        // working without a forced migration — once any page
                        // is edited or re-translated, the writer stamps `id`
                        // on the new items and the merge becomes id-based on
                        // subsequent writes.
                        const existing = savedOverlay.pageOverlays[p] || [];
                        const nonOverlapping = existing.filter(oldItem => {
                            // Bug 2 fix: V4 merge-by-id-first must ALSO fall back to
                            // rect-overlap when ids differ. Without this, DOM-path and
                            // pdfjs-path overlays (which produce slightly different rects
                            // due to different metrics) get different id hashes and both
                            // persist on disk → visible duplicate bboxes.
                            //
                            // Old logic: if oldItem has id, ONLY check id-equality.
                            //   → different ids = "distinct items" = both kept (BUG)
                            //
                            // New logic: drop old item if EITHER:
                            //   (a) a new item has the same id (id-equality, V4 path), OR
                            //   (b) a new item overlaps it rect-wise (rect-overlap, catches
                            //       id-mismatched duplicates from rect drift)
                            return !newItems.some(newItem =>
                                (oldItem.id && newItem.id && newItem.id === oldItem.id) ||
                                this.isRectOverlapping(oldItem.relativeRect, newItem.relativeRect)
                            );
                        });
                        savedOverlay.pageOverlays[p] = [...nonOverlapping, ...newItems];
                    }
                } else {
                    delete savedOverlay.pageOverlays[p]; // Handle deletion of a page's overlays
                }
            }
            savedOverlay.timestamp = Date.now();

            const md = this.generateMarkdownForOverlay(savedOverlay, pdfFile, {
                originalsOnly: opts?.originalsOnly,
                frontmatter: opts?.frontmatter,
            });

            if (mdFile) {
                // File exists, so modify it.
                // Phase 2 (markSelfWrite fold): atomicWrite stamps self-write internally.
                // Phase 8 (C5): atomic write (modify path).
                await this.atomicWrite(mdFile, mdFile.path, md);
            } else {
                // CREATE PATH: File does not exist, so create it.
                await this.ensureStorageFolder();
                // Phase 2 (markSelfWrite fold): atomicWrite stamps self-write internally.
                // Phase 8 (C5): atomic write (create path).
                await this.atomicWrite(null, translationPath, md);
                // This map update is now safely inside the sequential queue
                this.plugin.pdfToMdMap.set(pdfFile.path, translationPath);
            }

            // FIX B1 (revised): directly update the renderer's in-memory cache
            // with the freshly-written data. This replaces the previous approach
            // of invalidating the cache via metadataCache.on('changed') — which
            // was too aggressive (cleared pagesWithOverlays, preventing any page
            // from loading) and never re-initialized for self-writes.
            //
            // By updating the cache HERE (in the writer, where we know the full
            // merged result), the renderer always has fresh data without needing
            // a disk re-read.
            //
            // Phase 20 (C24): this call is the single source of truth for the
            // overlay-level cache after a write. We deliberately do NOT keep a
            // separate translationsCache Map in this class — that would create
            // a two-cache coherence problem (per C24 in the addendum).
            if (this.plugin.overlay) {
                this.plugin.overlay.updateCacheFromWrite(pdfFile, savedOverlay);
            }

            // --- END OF CORRECTED LOGIC ---
        };

        // Promise-based locking mechanism to serialize write operations for the same file
        const pendingPromise = this.writingPromises.get(lockKey) || Promise.resolve();
        const newPromise = pendingPromise.then(() => writer()).finally(() => {
            // IMPORTANT: Clean up the map once the operation is done.
            // This check ensures we don't accidentally delete a newer promise
            // if operations were chained very quickly.
            if (this.writingPromises.get(lockKey) === newPromise) {
                this.writingPromises.delete(lockKey);
            }
        });

        this.writingPromises.set(lockKey, newPromise);
        await newPromise;
    }


    /**
     * Finds all .translations.md files whose referenced PDF no longer exists in the vault.
     * These are "orphaned" translation files that serve no purpose and can be safely deleted.
     *
     * Returns an array of objects containing the translation file and the unresolved PDF path.
     */
    async findOrphanedTranslations(): Promise<Array<{ mdFile: TFile; pdfSource: string }>> {
        const orphans: Array<{ mdFile: TFile; pdfSource: string }> = [];

        let mdFiles = this.app.vault.getMarkdownFiles();
        if (this.storageLocation) {
            mdFiles = mdFiles.filter(file => file.path.startsWith(this.storageLocation));
        }

        for (const mdFile of mdFiles) {
            if (!mdFile.name.endsWith('.translations.md')) continue;

            const cache = this.app.metadataCache.getFileCache(mdFile);
            if (!cache?.frontmatter) {
                // No frontmatter at all — cannot determine which PDF this belongs to
                orphans.push({ mdFile, pdfSource: '(no frontmatter)' });
                continue;
            }

            // Prefer parsed cache; recover apostrophe-broken files from raw text.
            let linkPath = readPdfSourceFromCache(this.app, mdFile);
            if (!linkPath) {
                const content = await this.app.vault.cachedRead(mdFile);
                linkPath = readPdfSourceRaw(content);
            }
            if (!linkPath) {
                orphans.push({ mdFile, pdfSource: '(missing pdf-source)' });
                continue;
            }

            const resolved = resolvePdfFromSource(this.app, linkPath, mdFile.path);

            // If PDF doesn't exist (or isn't a PDF), this is an orphan
            if (!resolved) {
                orphans.push({ mdFile, pdfSource: linkPath });
            }
        }

        return orphans;
    }

    /**
     * Ensure an existing translation note's pdf-source wikilink points to the given PDF.
     * Repairs stale links after renames or moves. Keeps the original single-quoted wikilink format.
     */
    async ensurePdfSourceLinkPointsTo(fileMd: TFile, pdfFile: TFile): Promise<void> {
        const content = await this.app.vault.read(fileMd);

        // Prefer parsed cache; fall back to raw recovery for old broken files.
        let linkPath = readPdfSourceFromCache(this.app, fileMd);
        if (!linkPath) linkPath = readPdfSourceRaw(content);

        const resolved = resolvePdfFromSource(this.app, linkPath, fileMd.path);
        if (resolved && resolved.path === pdfFile.path) return; // already correct

        const updated = setPdfSourceInFrontmatter(content, pdfFile.path);
        if (updated !== content) {
            // Phase 2 (markSelfWrite fold): atomicWrite stamps self-write internally.
            // Phase 8 (C5): atomic write — this is the 6th vault.modify call
            // that the original SPEC omitted (per ADDENDUM C5). Without atomic
            // write, an interrupted rename-repair could leave a half-written
            // frontmatter and a broken pdf-source link.
            await this.atomicWrite(fileMd, fileMd.path, updated);
        }
    }

    // ============================================================
    // Phase 8 (C5): Atomic write helper
    // ============================================================

    /**
     * Atomic write: write to a temp file, then rename it over the destination.
     *
     * Why: `vault.modify(file, content)` truncates the file in place and writes
     * the new content. If Obsidian (or the OS) is interrupted mid-write — crash,
     * power loss, sync conflict, mobile app being killed by the OS — the file
     * can be left with a partial write, corrupting the user's translation data.
     *
     * How: we write `targetPath + '.tmp'` first, then `vault.rename(temp, targetPath)`
     * which is a single atomic filesystem operation on most platforms. Either the
     * rename succeeds (new content fully visible) or it fails (old content still
     * intact). No partial state.
     *
     * Fallback: if rename fails (e.g. cross-device, permission, or adapter
     * doesn't support rename on mobile), we fall back to direct modify/create.
     * This is non-atomic but matches the pre-Phase-8 behaviour so we don't
     * regress on platforms where rename is unavailable.
     *
     * Temp cleanup: any leftover `.tmp` file from a previous failed write is
     * deleted at the start. If the rename itself fails, the temp file we just
     * created is deleted in the catch block (best-effort) before falling back.
     *
     * @param targetFile Existing TFile to overwrite, or `null` if the target
     *                   doesn't exist yet (in which case we create it).
     * @param targetPath Vault path of the destination file.
     * @param content    Full text content to write.
     */
    private async atomicWrite(
        targetFile: TFile | null,
        targetPath: string,
        content: string
    ): Promise<void> {
        // Phase 2 (markSelfWrite fold): every caller of `atomicWrite` previously
        // had to remember to call `this.plugin.markSelfWrite(targetPath)` right
        // before invoking us. Six storage.ts sites did so; some forgot (audit 09).
        // Folding the call into `atomicWrite` itself makes self-write suppression
        // (metadataCache.on('changed') short-circuit) guaranteed for every
        // atomic-write path, and lets us delete the redundant manual calls at
        // the 6 storage.ts sites. The 2 ms-window is the same: markSelfWrite
        // stamps the path before `vault.create(tempPath, ...)` runs, so the
        // eventual rename into `targetPath` (and the metadataCache.on('changed')
        // event it fires) lands inside the TTL window.
        this.plugin.markSelfWrite(targetPath);

        const tempPath = targetPath + '.tmp';
        let tempFile: TFile | null = null;
        try {
            // Clean up any existing temp file first (leftover from a previous
            // failed write). `vault.create` would otherwise throw "file already
            // exists".
            const existingTemp = this.app.vault.getAbstractFileByPath(tempPath);
            if (existingTemp instanceof TFile) {
                await this.app.vault.delete(existingTemp);
            }

            // Write temp file (same folder as target — required for rename to
            // be atomic; cross-folder renames can be non-atomic on some
            // filesystems).
            tempFile = await this.app.vault.create(tempPath, content);

            // Rename temp over target. `vault.rename` handles both the
            // "overwrite existing" and "create new" cases atomically —
            // Obsidian's adapter delegates to the underlying FS rename which
            // is atomic on POSIX systems and on Windows (with ReplaceFile semantics).
            await this.app.vault.rename(tempFile, targetPath);
            // After a successful rename, `tempFile` is no longer at `tempPath`
            // (it now lives at `targetPath`), so the finally/cleanup below
            // must not try to delete it.
            tempFile = null;
        } catch (e) {
            console.warn('Atomic write failed, falling back to direct write:', e);
            // Cleanup temp file if it still exists (rename didn't happen).
            if (tempFile) {
                try { await this.app.vault.delete(tempFile); } catch { /* ignore cleanup errors */ }
                tempFile = null;
            }
            // Best-effort cleanup of any other leftover temp at this path
            // (e.g. the rename succeeded on the FS but threw in Obsidian's
            // event dispatch — leaving a stale entry in the cache).
            try {
                const staleTemp = this.app.vault.getAbstractFileByPath(tempPath);
                if (staleTemp instanceof TFile) {
                    await this.app.vault.delete(staleTemp);
                }
            } catch { /* ignore */ }

            // Fallback to direct write (non-atomic, but matches pre-Phase-8 behaviour).
            if (targetFile) {
                await this.app.vault.modify(targetFile, content);
            } else {
                await this.app.vault.create(targetPath, content);
            }
        }
    }
}
