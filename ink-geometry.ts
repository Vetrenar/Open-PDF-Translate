// ink-geometry.ts
// ─────────────────────────────────────────────────────────────────────────
// LAYOUT-FIX-9 (2026-09-17, Phase 3 / P3): right edges by INK, not by the
// declared pdf.js item widths.
//
// WHY THIS EXISTS (calibrated on the bisect corpus, Task 31):
//
// pdf.js `getTextContent()` reports item `width` as the sum of NOMINAL glyph
// advances — dropped TJ kerning and per-line Tw accumulate along a line, so
// the DECLARED right edge of an item can overshoot the real rendered ink end
// by 2–28pt (try3.pdf p4: a list bullet "•" is declared 96pt wide where the
// ink is ~4pt). Those phantom widths are the root of three problem classes:
//   M5  — occupancy rects bridge the inter-column gutter, producing "wide"
//         units whose right part is empty (try3:p4 x7 on the queue path);
//   D1  — the column-slicer's drift repair returns a RIGHT-column line start
//         to the LEFT group because the left line's DECLARED right edge
//         covers it («Signaling via RAS…» start 333 vs declared left edge
//         342, while the true ink ends at 314 — gap 19pt);
//   D2 soil — the whitespace channel between columns is painted over by the
//         overstated widths (matters for A1/LAYOUT-FIX-10).
//
// THE TWO CHANNELS (no font-program parsing anywhere):
//
//   • QUEUE (Tm-clamp, `clampRightEdgesToNextStart`): for items of one
//     visual line (shared exact baseline), sorted by x,
//     `rect_i.right = min(rect_i.right, nextItem.x)` — the next item's Tm
//     start is exact, so it bounds the previous item's declared width,
//     including the trailing space. The LAST item of a line keeps its
//     declared width (fallback per plan §6.1); the residual overshoot of
//     line-end items is contained by the slicer's per-group partition
//     (same as v11–v22 always did). Table inter-cell gaps are preserved:
//     the clamp only fires when the next start is LEFT of the declared
//     right (a real overlap — the drift signature), never across a gap.
//
//   • DOM (`domInkRight`): measure the actual rendered text extent with a
//     DOM Range over the textLayer span's contents (`getClientRects()`).
//     This is the true pdf.js render ink width (pdf.js sizes textLayer
//     spans from the declared item widths, so the same overstatement
//     applies there). Falls back to the declared edge whenever a Range is
//     unavailable (Node harnesses, fake spans, non-browser hosts) — the
//     channel is INERT where the signal is absent.
//
// FEED-ONLY MODIFICATION (the slicer's own invariant — "Rect coordinates
// are never modified" — is preserved by construction):
//   The clamped edges live in the detector feed. Every clamped rect
//   stashes its declared edge in `declRight` (+`inkSource`).
//     • DOM  — layout-detector.ts calls `restoreDeclaredRights(rects)`
//       right after `buildParagraphs`: the span-matching loop compares
//       rect coordinates against CSS-px span boxes, so span identity and
//       matching are unaffected by the channel.
//     • queue — the output KEEPS the ink edges deliberately: phantom
//       frames are exactly the declared overshoot (left line declared
//       342 at ink 314, bullet "•" declared 96pt at ink ~4pt), and the
//       phase-3 promise is that those frames disappear from the
//       inter-column gutter in the overlay. Unit TEXT is unaffected
//       (the clamp touches only `right`); the kill-switch restores
//       declared widths everywhere.
//   Paragraph px-boxes are computed INSIDE the pipeline and therefore keep
//   the ink geometry on both paths — the detection semantics (wide tests,
//   band merges, reading order, STEP 9.5 connectivity) see the true ink.
//
// KILL-SWITCH: `settings.disableInkGeometry === true` (LayoutSettings,
// optional, absent from `defaultLayoutSettings` so the settings hash and
// every `.translations.md` cache stay byte-identical) skips both channels
// entirely — declared widths, pre-FIX-9 behavior.
//
// LAYOUT-FIX-9 (P4 note): the column-slicer's ink-adjacency assignment
// reads `declRight`/`inkSource` to detect an ink feed; 'tm' clamps can
// fake adjacency across the gutter (the left line's last word is clamped
// TO the right column's first item start), so the slicer re-caps such
// edges at the validated column boundary — see column-slicer.ts STEP 6.

import type { InputRect } from './OccupancyMap';

/**
 * Minimum shrink (pt) for a clamp/ink edge to replace the declared edge.
 * Below this the rect keeps its declared geometry byte-for-byte, so pages
 * without measurable overstatement produce identical feeds (I4-friendly).
 */
const INK_MIN_SHRINK = 0.25;

/**
 * Minimum item separation (pt) for a Tm-clamp pair. Items whose lefts sit
 * within this window of each other (corrective overlays, duplicate items)
 * are never clamped — a sub-point wide rect is worse than an overstated one.
 */
const TM_MIN_SEPARATION = 1;

/**
 * LAYOUT-FIX-18a (2026-09-19): geometry caps for the drift-tail shift.
 *
 * A drifted tail is the LAST word (rarely two) of a justified line whose
 * declared pdf.js box was pushed past the column gutter by the cumulative
 * word-spacing error (measured on the Wiley/PDFium try-file class: 2.6–5.7pt
 * per space, +18–40pt by the line end). Its signature inside one baseline
 * row is a NEAR-SAME-START pair — the tail's left lands within
 * TM_MIN_SEPARATION of the next item's left (the victim's start), which is
 * exactly the pair shape the width clamp above refuses to touch. The caps
 * below keep the shift surgical: only short, single-word items, only a
 * PARTIAL overlap (the tail sticks INTO the victim, never a stacked
 * duplicate), never a blank/space item (sub-visual, nothing to repair).
 */
const DRIFT_TAIL_MAX_WIDTH = 60;
const DRIFT_TAIL_MAX_WORDS = 2;
/** Gap kept between the re-seated tail and the victim it was stacked on. */
const DRIFT_TAIL_CLEAR_GAP = 0.1;
/** Same-row overlap that counts as real for the shift (sub-visual = noise). */
const DRIFT_TAIL_MIN_OVERLAP = 0.25;

/**
 * Queue channel (Tm-clamp): bound each item's declared right edge by the
 * exact start of the next item on the same visual line.
 *
 * Baseline grouping uses `Math.round(rect.bottom)` — for unrotated viewports
 * `bottom` IS the exact pdf.js baseline (the same key `buildInputRects` uses
 * for its height fallback), and every item of one Tj/TJ line repeats the
 * same baseline float. Superscripts sit on their own raised baseline (~3pt
 * up) and therefore land in their own groups — a superscript's start is not
 * used to clamp the body item before it (plan §6.1 risk list), and the
 * body's clamp never sees the superscript as its successor.
 *
 * NON-MUTATING: returns shallow copies (the caller may share the original
 * array between engines — the A/B harnesses feed the SAME rects to a frozen
 * baseline engine and the current one; a mutating clamp would corrupt the
 * baseline). Copies carry `declRight` + `inkSource:'tm'`.
 *
 * Rotation caveat: on rotated pages the viewport-space "baseline row" is
 * not the visual line; the guards below (clamp only when it strictly
 * shrinks a positive-width rect) limit the damage, and the corpus is
 * unrotated — `disableInkGeometry` restores declared widths if ever needed.
 */
export function clampRightEdgesToNextStart(
  rects: InputRect[],
  opts?: { driftTailShift?: boolean },
): InputRect[] {
  const out: InputRect[] = rects.map(r => ({ ...r }));
  // DOM text-layer order also follows source order. Recover bounded runs
  // before the baseline buckets sort by x; keep explicit extractor IDs.
  if (out.every(r => r.sourceRun === undefined)) {
    let run=0, previous: InputRect | undefined;
    for (const r of out) {
      if (!previous || Math.abs(r.bottom-previous.bottom)>0.5 || r.left<previous.left-1
        || r.left-previous.right>(r.fontsize||10)*2) run++;
      r.sourceRun=run; previous=r;
    }
  }

  // Group copies by exact (rounded) baseline.
  const byBaseline = new Map<number, InputRect[]>();
  for (const r of out) {
    if (Math.abs(r.textAngle || 0) > 0.01) continue; // clamp in the local baseline system only
    const b = Math.round(r.bottom);
    let g = byBaseline.get(b);
    if (!g) { g = []; byBaseline.set(b, g); }
    g.push(r);
  }

  for (const g of byBaseline.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.left - b.left);
    for (let i = 0; i + 1 < g.length; i++) {
      const cur = g[i];
      const next = g[i + 1];
      // Only clamp a real overlap: the next start must sit strictly right
      // of the current item's left (no degenerate slivers) and strictly
      // left of the declared right edge by a measurable margin.
      if (!(next.left > cur.left + TM_MIN_SEPARATION)) {
        // LAYOUT-FIX-18a: near-same-start pair — the width clamp's blind
        // spot. When the overlap is real (> DRIFT_TAIL_MIN_OVERLAP) and
        // `cur` passes the drift-tail caps, it is a justified line's last
        // word stacked on the victim's start: re-seat it LEFT of the
        // victim (chain-constrained by the previous row item, degrading to
        // the width clamp when the chain blocks the full shift). Inert
        // without the explicit opt-in — harness/suite callers keep the
        // pre-FIX behavior byte-for-byte.
        if (
          opts?.driftTailShift === true &&
          next.left > cur.left &&
          next.left < cur.right - DRIFT_TAIL_MIN_OVERLAP
        ) {
          repairDriftTail(cur, next, i > 0 ? g[i - 1] : null);
        }
        continue;
      }
      if (!(next.left < cur.right - INK_MIN_SHRINK)) continue;
      (cur as any).declRight = cur.right;
      (cur as any).inkSource = 'tm';
      cur.right = next.left;
    }
  }
  return out;
}

/**
 * LAYOUT-FIX-18a: re-seat a drifted tail left of the item it was stacked on.
 *
 * `cur` is the tail (short, single-word, partially overlapping `next` with a
 * near-identical left), `prev` is the row item before `cur` (its declared
 * right bounds the shift — the tail must never jump over its own line's
 * previous word). The shift keeps the tail's (true) width: its right edge
 * lands at `next.left − DRIFT_TAIL_CLEAR_GAP`. When the previous item's
 * declared edge (itself drift-inflated) blocks the full shift, the repair
 * degrades to the width clamp at the victim's start — position over width.
 *
 * The declared geometry is stashed (`declLeft`/`declRight`) so the DOM
 * channel's `restoreDeclaredRights` can put it back for span matching,
 * exactly like the width clamp's `declRight` stash.
 */
function repairDriftTail(cur: InputRect, next: InputRect, prev: InputRect | null): void {
  const w = cur.right - cur.left;
  if (!(w > 0) || w > DRIFT_TAIL_MAX_WIDTH) return;
  const t = String((cur as any).text ?? '').trim();
  if (!t) return; // blank/space item — nothing visual to repair
  if (t.split(/\s+/).filter(Boolean).length > DRIFT_TAIL_MAX_WORDS) return;
  if (t === String((next as any).text ?? '').trim()) return; // duplicate item
  // Partial overlap only: a stacked duplicate/overlay reaches the victim's
  // right edge; a drifted tail sticks INTO the victim and stops well short.
  if (!(cur.right < next.right - 2)) return;
  const floor = prev ? prev.right + DRIFT_TAIL_CLEAR_GAP : -Infinity;
  let newLeft = Math.max(next.left - DRIFT_TAIL_CLEAR_GAP - w, floor);
  let newRight = newLeft + w;
  if (newRight > next.left - DRIFT_TAIL_CLEAR_GAP / 2) {
    // Chain-blocked: the previous item's declared edge (itself drifted)
    // leaves no room for the full-width shift — clamp the width at the
    // victim's start instead (same contract as the width clamp above,
    // minus the separation guard that created the blind spot).
    if (floor >= next.left - 0.5) return; // no sane placement — leave as-is
    newRight = next.left;
  }
  const a = cur as any;
  if (typeof a.declLeft !== 'number') a.declLeft = cur.left;
  if (typeof a.declRight !== 'number') a.declRight = cur.right;
  a.inkSource = 'tm';
  cur.left = newLeft;
  cur.right = newRight;
}

/**
 * DOM channel: the actual rendered ink right edge (viewport CSS px →
 * normalized by the same pageLeft/normScale the caller uses), or `null`
 * when a Range cannot be taken (Node harness fake spans, no document).
 *
 * `getClientRects()` of a range over the span contents returns one rect per
 * line box — textLayer spans are single-line, so the union's right edge is
 * the ink end. Trailing spaces ARE part of the item text in pdf.js, so this
 * edge lands at ink + trailing space ≈ the next item's start: sequential
 * words stay "adjacent" (gap ≈ 0–2pt) for the slicer's P4 rule, while a
 * cross-gutter neighbor sits 9–19pt away.
 */
export function domInkRight(
  span: unknown,
  pageLeft: number,
  normScale: number,
): number | null {
  try {
    if (typeof document === 'undefined' || typeof document.createRange !== 'function') return null;
    const el = span as HTMLElement | null;
    if (!el || typeof (el as any).nodeType !== 'number' || (el as any).nodeType !== 1) return null;
    const range = document.createRange();
    range.selectNodeContents(el as Node);
    const rects = range.getClientRects();
    if (!rects || rects.length === 0) return null;
    let right = -Infinity;
    for (let i = 0; i < rects.length; i++) right = Math.max(right, rects[i].right);
    if (!Number.isFinite(right)) return null;
    return (right - pageLeft) / normScale;
  } catch {
    return null;
  }
}

/**
 * Undo the feed clamps in place: every rect that carries `declRight` gets
 * its declared right edge back, and every rect that carries `declLeft`
 * (LAYOUT-FIX-18a drift-tail shift) its declared left edge. Call AFTER
 * `buildParagraphs`, BEFORE any consumer reads the rects (queue
 * normalization / DOM span matching). Paragraph px-boxes are NOT restored —
 * they were computed inside the pipeline and carry the detection (ink)
 * semantics by design.
 */
export function restoreDeclaredRights(rects: InputRect[]): void {
  for (const r of rects) {
    const d = (r as any).declRight;
    if (typeof d === 'number') r.right = d;
    const l = (r as any).declLeft;
    if (typeof l === 'number') r.left = l;
  }
}

/** True when at least one rect was ink-clamped (P4 enables its ink rules). */
export function hasInkFeed(rects: InputRect[]): boolean {
  return rects.some(r => typeof (r as any).declRight === 'number');
}

/** Internal hooks for tests/debugging (not part of the public contract). */
export const __inkGeometryInternals = {
  INK_MIN_SHRINK,
  TM_MIN_SEPARATION,
  DRIFT_TAIL_MAX_WIDTH,
  DRIFT_TAIL_MAX_WORDS,
  DRIFT_TAIL_CLEAR_GAP,
  DRIFT_TAIL_MIN_OVERLAP,
  repairDriftTail,
};
