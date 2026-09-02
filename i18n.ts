// i18n.ts
// ─────────────────────────────────────────────────────────────────────────
// Lightweight i18n shim. The real production version reads from a translations
// JSON (ru / en / etc.) and resolves keys via a fluent.js or i18next backend;
// this stub returns the key itself if no translation is registered, which
// means English callers see English text and the rest of the plugin still
// type-checks against `t(key, params)`.
//
// Plugin authors who want full translations should patch STRINGS below (or
// load a JSON file at runtime into `registerStrings`).
// ─────────────────────────────────────────────────────────────────────────

type Params = Record<string, string | number>;

const STRINGS: Record<string, string> = {};

/** Register a batch of translations (locale → key → value). */
export function registerStrings(map: Record<string, string>): void {
    Object.assign(STRINGS, map);
}

/**
 * Translate a key with optional {placeholder} substitution.
 * Falls back to the key itself when no translation is registered — this
 * keeps the plugin functional in English even without a translation file.
 */
export function t(key: string, params?: Params): string {
    let s = STRINGS[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return s;
}
