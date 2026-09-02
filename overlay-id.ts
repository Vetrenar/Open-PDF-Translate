// overlay-id.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 7 (V4 Schema): stable per-overlay identifier generator.
//
// Purpose
// ───────
// Each overlay persisted to `.translations.md` needs a stable `id` so that:
//   1. The edit-translation modal can locate the exact entry by id instead of
//      fuzzy-matching on `textContent` (which is ambiguous when a page contains
//      duplicate paragraphs — see audit 08 HIGH-8 / Phase 11.5 unimplemented).
//   2. `updatePageOverlaysAndWrite` can merge-by-id-first (P0-9) instead of
//      merge-by-rect-overlap. Rect-overlap merge silently resurrects deleted
//      items when their rects happen to overlap a surviving item; id-equality
//      merge prevents this.
//   3. The DOM element stamped with `data-translation-id` (overlay-ui.ts:532)
//      carries a value that round-trips through save/reload unchanged.
//
// Stability requirement
// ─────────────────────
// The id MUST be deterministic across re-extractions of the same source layout
// — otherwise the merge-by-id-first logic would treat a re-translated overlay
// as "new" (id mismatch with the on-disk version) and resurrect the old entry
// via the rect-overlap fallback. This is why we DO NOT use UUID or Date.now()
// (both of which are non-deterministic); instead we hash
//   `${page}:${rect@3dec}:${textContent}`
// which is invariant across re-translations of the same source PDF page as
// long as:
//   - The page number is unchanged (always true — pages don't renumber).
//   - The relative rect drifts by less than 0.001 (rounds to the same 3-dec
//     value). This survives pdfjs version bumps and minor rendering changes.
//   - The textContent is unchanged (true for the same source PDF; LLM
//     re-translations only change `translatedText`, not `textContent`).
//
// Hash algorithm
// ───────────────
// We use a 32-bit variant of the djb2 string hash, computed twice with
// different seeds, concatenated into a 16-char hex string. This avoids:
//   - The `crypto` module (unavailable in the browser/Obsidian mobile runtime
//     without polyfilling).
//   - The async `crypto.subtle.digest` API (would force all callers to be
//     async, propagating through 8 construction sites).
//   - External dependencies.
// The collision space (2^64) is more than sufficient for the per-overlay scope
// (a 1000-page PDF with 100 overlays/page = 100K overlays → ~5×10^-11 chance
// of any collision across the whole file).
//
// Audit reference
// ───────────────
// Audit 10 §4.1 "Adding `id` field" — recommendation: "Hash of
// `page + relativeRect (3-decimal rounded) + textContent` for all paths."

/**
 * Internal: 32-bit string hash (djb2 variant).
 *
 * Returns a signed 32-bit integer. Callers convert to unsigned hex via
 * `>>> 0` before formatting.
 *
 * @param str  Input string.
 * @param seed Initial hash value (use different seeds to get independent
 *             hashes from the same input — used to synthesise a 64-bit
 *             identifier from two 32-bit halves).
 */
function hash32(str: string, seed: number = 0): number {
    let hash = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // force 32-bit two's-complement semantics
    }
    return hash;
}

/**
 * Generate a stable 16-char hex identifier for an overlay.
 *
 * @param page        1-indexed PDF page number.
 * @param rect        Relative rectangle `{left, top, width, height}` in
 *                    page-normalised coordinates (0–1). Rounded to 3 decimal
 *                    places internally so minor rect drift (e.g. from pdfjs
 *                    version bumps) doesn't change the id.
 * @param textContent The overlay's original text (NOT the translation —
 *                    translations change between LLM runs; the source text
 *                    is stable for a given PDF).
 * @returns 16-char hex string, e.g. `"a3f0c2d1e9b48765"`. Deterministic:
 *          the same inputs always produce the same id.
 */
export function generateOverlayId(
    page: number,
    rect: { left: number; top: number; width: number; height: number },
    textContent: string,
): string {
    // Bug 2 fix: round rect to 2 decimals (was 3) for stronger cross-re-extraction
    // stability. DOM-path (`getBoundingClientRect` of rendered overlay) and pdfjs-path
    // (`convertToViewportPoint` from raw text-item coords) produce rects that routinely
    // differ at the 3rd-4th decimal. 2-decimal rounding absorbs this sub-pixel drift
    // so the same logical paragraph gets the same id regardless of which path extracted it.
    const l = rect.left.toFixed(2);
    const t = rect.top.toFixed(2);
    const w = rect.width.toFixed(2);
    const h = rect.height.toFixed(2);
    const input = `${page}:${l},${t},${w},${h}:${textContent}`;

    // Two independent 32-bit hashes (different seeds) → 64-bit identifier
    // formatted as 16 hex chars. The `>>> 0` converts the signed 32-bit
    // result to unsigned before toString(16) so negative hashes don't
    // produce a leading `-`.
    const h1 = (hash32(input, 0)    >>> 0).toString(16).padStart(8, '0');
    const h2 = (hash32(input, 5381) >>> 0).toString(16).padStart(8, '0');

    return h1 + h2;
}

// Phase 8 (V4 Schema): layoutSettingsHash + engine stamp.
// ─────────────────────────────────────────────────────────────────────────
// Two new V4 schema helpers that share the same hashing primitive as
// `generateOverlayId` so the file's surface stays focused on schema-identity
// concerns.
//
// 1. `computeLayoutSettingsHash(settings)` — 16-hex-char hash of
//    `JSON.stringify(layoutSettings)`. Stored in frontmatter
//    (`layoutSettingsHash:`) so `isCached`/`getCachedPages` in
//    pdf-layout-queue.ts can detect when the user has changed the layout
//    preset and force a re-translate (audit 10 §4.3 / P2-3).
//
//    Migration: V3 files (no `layoutSettingsHash` key) are treated as
//    "match" by `isCached`/`getCachedPages` — the FIRST release after V4
//    cut does NOT mass-invalidate every existing file. Only after a file is
//    re-saved through a Phase-8 construction site does the hash get stamped,
//    at which point subsequent preset changes will invalidate it correctly.
//
// 2. `getCurrentEngine(plugin)` — `${apiProvider}/${model}` string stamped
//    on every overlay (per-overlay `engine`) AND in frontmatter (primary
//    engine for the file). The model is read from
//    `plugin.settings.providerSettings[apiProvider]?.model` (per-provider
//    model storage — `settings.model` doesn't exist as a flat field).
//    Sentinels: `'originals-only'` for createLayoutFileWithOriginals,
//    `'manual-edit'` for the edit-modal partial path.
//
// Both helpers are pure (no side effects, no I/O) so they can be called
// from any context (including the parser/reader path, which is invoked
// synchronously from many call sites).

/**
 * Compute a 16-hex-char hash of `LayoutSettings` for V4 frontmatter.
 *
 * Used by `generateMarkdownForOverlay` (writer) and `isCached`/`getCachedPages`
 * (consumer). The hash is `JSON.stringify(settings)` fed through the same
 * djb2-variant hash as `generateOverlayId` (two 32-bit halves, different
 * seeds, concatenated into 16 hex chars).
 *
 * The hash is deterministic: the same `LayoutSettings` object always
 * produces the same hash (object key insertion order is preserved by
 * `JSON.stringify` for plain objects, which `LayoutSettings` is). This
 * means a file saved under preset X can be reliably detected as stale
 * after the user switches to preset Y.
 *
 * Note: we deliberately do NOT sort object keys before stringifying —
 * `JSON.stringify` already iterates in insertion order, and the
 * `LayoutSettings` interface is constructed deterministically by
 * `defaultLayoutSettings` + spread-merge in `loadSettings()` (main.ts:1022).
 * A user who manually edits `data.json` could in principle reorder keys,
 * but that's an unsupported edge case (and the hash would just mismatch,
 * forcing an unnecessary re-translate — self-correcting).
 */
/**
 * Compute a 16-hex-char hash of the LIVE fields of `LayoutSettings`.
 *
 * T3.1: previously this hashed the ENTIRE settings object, ~110 fields of
 * which ~100 were dead configuration inherited from retired detectors.
 * Touching any dead field changed the hash → `getCachedPages` treated every
 * translated document as stale → full re-translation for a no-op change.
 * Now only the fields the contour pipeline actually reads are hashed, and
 * they are sorted by key first so the hash is independent of key insertion
 * order (a user hand-editing data.json can no longer invalidate anything).
 *
 * Unknown/dead keys present in the object are ignored entirely.
 */
export function computeLayoutSettingsHash(settings: unknown): string {
    const liveKeys = [
        'contourCellSize', 'contourIndentThreshold', 'contourFontSizeTolerance',
        'maxMergePasses', 'columnGapThreshold', 'decorationThreshold', 'debugValidation',
    ];
    const src = (settings && typeof settings === 'object') ? settings as Record<string, unknown> : {};
    const live: Record<string, unknown> = {};
    for (const k of liveKeys) live[k] = src[k];
    // `JSON.stringify(undefined)` returns undefined (not a string) — coerce
    // to a stable representation that is distinct from any real value set.
    const json = JSON.stringify(live) === undefined ? 'undefined' : JSON.stringify(live);
    const h1 = (hash32(json, 0)    >>> 0).toString(16).padStart(8, '0');
    const h2 = (hash32(json, 5381) >>> 0).toString(16).padStart(8, '0');
    return h1 + h2;
}

/**
 * Build the `engine` stamp string for the current translation provider/model.
 *
 * Returns `${apiProvider}/${model}` (e.g. `"openrouter/openai/gpt-4o-mini"`),
 * falling back to `'unknown'` for either component when settings are missing.
 *
 * The model is read from `plugin.settings.providerSettings[apiProvider].model`
 * — the plugin stores per-provider settings (API key, endpoint, model) keyed
 * by provider id, NOT as a flat `plugin.settings.model` field. See audit 10
 * §4.2 for the rationale (per-overlay + file-level engine stamp enables
 * stale-detection after engine switch and A/B comparison).
 *
 * @param plugin The plugin instance (typed loosely to avoid importing the
 *               full plugin type — keeps this helper decoupled from main.ts).
 */
export function getCurrentEngine(plugin: {
    settings: { apiProvider?: string; providerSettings?: Record<string, { model?: string }> };
}): string {
    const providerId = plugin?.settings?.apiProvider || 'unknown';
    const model = plugin?.settings?.providerSettings?.[providerId]?.model || 'unknown';
    return `${providerId}/${model}`;
}

// Phase 17 (P2-12): RFC 4122 v4 UUID helper with graceful fallback.
// ─────────────────────────────────────────────────────────────────────────
// `crypto.randomUUID()` is available in modern browsers (>=2022), Obsidian
// desktop (Electron 95+), and Obsidian mobile (Capacitor 4+/WebKit 16+).
// Older runtimes (notably pre-2022 Safari and some embedded webviews) lack
// it; this helper falls back to a Math.random-based v4 generator so callers
// don't need to feature-detect.
//
// Used by layout-parser-debug.ts for debug-file id generation (manual box
// ids + detection snapshot ids). Debug-file ids are NOT security-sensitive
// (they only need to be unique within one JSON file), so the lower-entropy
// Math.random fallback is acceptable.
//
// Why not use generateOverlayId (the djb2-based helper above)?
// `generateOverlayId` is deterministic — same inputs always produce the
// same id. That's the right thing for overlay persistence (stable id
// across re-extractions) but the WRONG thing for one-shot debug-file ids
// (which need to be unique even when the user draws two boxes at the same
// page-relative coordinates within the same millisecond).

/**
 * Generate an RFC 4122 v4 UUID string.
 *
 * Prefers the native `crypto.randomUUID()` when available (modern browsers,
 * Obsidian desktop, recent Obsidian mobile). Falls back to a
 * Math.random-based v4 generator for older runtimes that lack the API.
 *
 * Not suitable for security-sensitive contexts — the fallback is
 * cryptographically weaker than `crypto.randomUUID()`. Acceptable for
 * debug-file id generation and other non-security contexts.
 */
export function uuid(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // `crypto` can throw on access in some sandboxed environments —
        // fall through to the manual implementation.
    }
    // Manual RFC 4122 v4 fallback. Lower entropy than crypto.randomUUID
    // (Math.random instead of CSPRNG) but sufficient for debug-file ids.
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            out += '-';
            continue;
        }
        if (i === 14) {
            out += '4'; // version nibble
            continue;
        }
        if (i === 19) {
            // variant nibble: 8/9/a/b
            out += hex[8 + ((Math.random() * 4) | 0)];
            continue;
        }
        out += hex[(Math.random() * 16) | 0];
    }
    return out;
}
