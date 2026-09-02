// shared.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 2 (T2.4): single source of truth for constants and small utilities
// that were previously duplicated across overlay.ts / overlay-ui.ts /
// storage.ts / translation.ts / ocr-layout.ts.
//
// Every copy that existed before had a comment demanding "must match the
// other file" — manual synchronization is exactly how the double-BLEED bug
// (saved rects including bleed, re-applied on load) happened once already.
// Import from here instead of re-declaring.
// ─────────────────────────────────────────────────────────────────────────

import type { Plugin } from 'obsidian';

// ════════════════════════════════════════════════════════════════
// Overlay geometry constants (used by BOTH the renderer that applies
// the bleed and the extractor that reverses it — see T4.5/T2.4)
// ════════════════════════════════════════════════════════════════

export const BLEED_X = 4;
export const BLEED_Y_NORMAL = 2;
export const BLEED_Y_TIGHT = 0;

// ════════════════════════════════════════════════════════════════
// DOMPurify whitelist (used by the renderer AND the storage parser —
// they must round-trip byte-identically)
// ════════════════════════════════════════════════════════════════

export const PURIFY_CONFIG = {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'sup', 'sub', 'u'],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
} as const;

// ════════════════════════════════════════════════════════════════
// Rectangle overlap test
// ════════════════════════════════════════════════════════════════

export interface RectLike { left: number; top: number; width: number; height: number }

/**
 * True if two relative rects overlap. `eps` guards against float noise at
 * the serialization precision (writer rounds to 4 decimals → 0.0001).
 */
export function isRectOverlapping(a: RectLike, b: RectLike, eps = 1e-5): boolean {
    return !(
        a.left + a.width < b.left - eps ||
        b.left + b.width < a.left - eps ||
        a.top + a.height < b.top - eps ||
        b.top + b.height < a.top - eps
    );
}

// ════════════════════════════════════════════════════════════════
// Promise timeout
// ════════════════════════════════════════════════════════════════

/**
 * Reject after `ms` if the wrapped promise hasn't settled. The timer is
 * cleared on settlement (no leak). NOTE: the underlying request is NOT
 * aborted — requestUrl does not support AbortSignal (platform limitation).
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = setTimeout(
            () => reject(Object.assign(new Error(`Timeout after ${ms}ms`), { name: 'TimeoutError' })),
            ms,
        );
        p.then(
            (v) => { clearTimeout(id); resolve(v); },
            (e) => { clearTimeout(id); reject(e); },
        );
    });
}

// ════════════════════════════════════════════════════════════════
// Table-like text detection (T5.3 / user-requested table handling)
// ════════════════════════════════════════════════════════════════

/**
 * True when a paragraph's text looks like a table / list block rather than
 * prose: at least 2 non-empty lines AND every non-empty line has fewer than
 * 5 words. This mirrors the source-side heuristic that DECIDES to emit
 * `<br>` between lines (`TextProcessor.shouldPreserveLineBreaks`) and is
 * used on the OUTPUT side to decide whether the translation's line
 * structure must be preserved instead of collapsed.
 *
 * Lines are split on `<br>` (what the DOM path emits into the source) or
 * `\n` (what the pdfjs path emits after T5.3).
 */
export function isTableLikeText(text: string): boolean {
    if (!text) return false;
    const lines = text.split(/<br\s*\/?>|\n/i);
    const nonEmpty = lines.map(l => l.trim()).filter(l => l.length > 0);
    if (nonEmpty.length < 2) return false;
    for (const line of nonEmpty) {
        const wordCount = line.split(/\s+/).filter(Boolean).length;
        if (wordCount >= 5) return false; // found a prose line → not table-like
    }
    return true;
}

/**
 * Normalize a translated segment that is allowed to keep line structure:
 * convert embedded newlines to `<br>` (the renderer understands both, but
 * `<br>` survives the storage round-trip deterministically) and collapse
 * whitespace runs without touching the breaks.
 */
export function normalizeWithLineBreaks(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        // strip spaces/tabs around line breaks
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        // 3+ consecutive breaks → 2
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .replace(/\n/g, '<br>');
}

/**
 * Collapse a translated segment to a single line (prose policy): remove
 * `<br>` tags and any newlines, squeeze whitespace.
 */
export function collapseToSingleLine(text: string): string {
    return text
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ════════════════════════════════════════════════════════════════
// Cancellation token type (T1.2)
// ════════════════════════════════════════════════════════════════

/**
 * Cancellation probe passed by the caller that OWNS a translation run.
 * The background queue passes `() => queue.isCancelled()`; interactive
 * callers pass nothing. The translation core must never reach for global
 * state (the old `plugin.pdfLayoutQueue.isCancelled()` checks cancelled
 * interactive runs whenever the queue had been paused — fixed in T1.2).
 */
export type CancelToken = () => boolean;

/** Helper: true when the (optional) token reports cancellation. */
export function isCancelled(token?: CancelToken): boolean {
    return typeof token === 'function' ? token() === true : false;
}
