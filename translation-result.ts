/** Per-call fallback bookkeeping; never inferred from equality with source text. */
const failures = new WeakMap<string[], Set<number>>();
export function fallbackIndices(lines: string[]): Set<number> {
    return failures.get(lines) ?? new Set<number>();
}
export function withFallbacks(lines: string[], indices: Iterable<number>): string[] {
    failures.set(lines, new Set(indices));
    return lines;
}
