// overlay-factory.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 2 (T2.5): the single construction site for OverlayPositionData.
//
// Before this module, FIVE places built overlay records by hand with
// slightly different field sets and normalization rules:
//   processing.ts (cached-units render path), pdf-layout-queue.ts
//   (buildOverlayData), headless-translate.ts, reprocessor.ts and
//   main.ts (createLayoutFileWithOriginals). Divergent construction is
// exactly how "almost identical" records with different stable ids ended
// up on disk and duplicated after the rect-overlap merge.
//
// Invariants enforced here:
//   • every record gets a stable `generateOverlayId(page, rect, text)` id
//     (unless the caller supplies one — e.g. a preserved disk id);
//   • every record gets an `engine` stamp;
//   • relativeRect components are finite (non-finite input throws — the
//     caller decides whether to skip the paragraph).
// ─────────────────────────────────────────────────────────────────────────

import type { OverlayPositionData } from './types';
import { generateOverlayId, getCurrentEngine } from './overlay-id';

export interface MakeOverlayInput {
    /** 1-based page number (required, > 0). */
    page: number;
    /** Page-relative rect {left, top, width, height} in 0..1 space. */
    rect: { left: number; top: number; width: number; height: number };
    /** Original (source) paragraph text. */
    text: string;
    /** Translated text; falls back to `text` when empty. */
    translated?: string;
    fontFamily?: string;
    fontSize?: number;
    originalFontSizes?: number[];
    /** Engine stamp; defaults to the live provider/model. */
    engine?: string;
    /** T4.3 (v5): manual font-size override (scale-free px), if any. */
    adjustedFontSize?: number;
    /** T4.3 (v5): manual line-height override (unitless), if any. */
    adjustedLineHeight?: number;
    /** Pre-existing stable id (preserved on re-save); generated when absent. */
    id?: string;
}

export function makeOverlay(input: MakeOverlayInput): OverlayPositionData {
    const { page, rect, text } = input;
    if (!Number.isFinite(page) || page < 1) {
        throw new Error(`makeOverlay: invalid page ${page}`);
    }
    const { left, top, width, height } = rect ?? ({} as any);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw new Error(`makeOverlay: invalid rect for page ${page}`);
    }

    const translated = (input.translated ?? '').trim();

    return {
        selector: '',
        textContent: text,
        translatedText: translated || text,
        relativeRect: { left, top, width, height },
        page,
        fontFamily: input.fontFamily,
        fontSize: input.fontSize,
        originalFontSizes: input.originalFontSizes ?? [],
        id: input.id ?? generateOverlayId(page, rect, text || ''),
        engine: input.engine ?? 'unknown',
        ...(Number.isFinite(input.adjustedFontSize) ? { adjustedFontSize: input.adjustedFontSize } : {}),
        ...(Number.isFinite(input.adjustedLineHeight) ? { adjustedLineHeight: input.adjustedLineHeight } : {}),
    };
}

/** Convenience: engine stamp for the CURRENT provider settings. */
export function currentEngine(plugin: Parameters<typeof getCurrentEngine>[0]): string {
    return getCurrentEngine(plugin);
}
