// job-token.ts
// ─────────────────────────────────────────────────────────────────────────
// Phase 5.1 (W-2b + stale-cancel class, 2026-09-13): owner-scoped
// cancellation tokens.
//
// REPLACES: the single global `PdfLayoutQueue.cancelled` boolean. That flag
// had no owner — one Cancel anywhere (watcher stop in settings, modal
// button, plugin unload) cancelled EVERY in-flight job in the shared
// singleton queue, and the flag was sticky: it survived the end of the
// session that set it (the old clearCancelFlag()/resume() workarounds
// existed only to fight that poison — see the removed "stale-cancel" fix
// in processing.ts).
//
// Every enqueue now runs under a JobToken:
//   • watcher stop / Cancel button  → queue.cancelScope('watcher')
//   • plugin unload (dispose)       → queue.cancelAll()
//   • HeadlessTranslator.cancel()   → its own 'headless' token (it no
//     longer touches the queue at all — W-2b)
// A cancelled task returns to 'pending' (it did NOT fail) and is picked
// up by the next enqueue, which re-assigns a fresh token.
//
// ABORT vs ERROR: an abort is not a task failure. Real errors classify via
// TIMEOUT_MATCHER / raw message and land in task.error; an abort lands the
// task back in 'pending' with no Notice. isAbortError() must be honoured
// at every catch site that would otherwise fall back to ORIGINAL text —
// an aborted page must never be written with originals-as-translations.
//
// HTTP NOTE (FIX H5, accepted limitation): requestUrl does not support
// AbortSignal, so an abort cannot stop the in-flight HTTP request.
// raceSignal() detaches the CONVEYOR (the awaiting task rejects within
// milliseconds and moves to 'pending') while the request completes in the
// background and its result is discarded. Between chunks, the
// signal.aborted checks stop further requests. Cancellation saves pipeline
// time and downstream quota, not the current request's quota.
// ─────────────────────────────────────────────────────────────────────────

/** Who owns a job — the cancellation SCOPE. */
export type JobScope = 'watcher' | 'modal' | 'headless' | 'command';

let tokenSeq = 0;

export class JobToken {
    /** Unique, monotonic-ish id (log/debug friendly). */
    readonly id: string;
    readonly scope: JobScope;
    /** Human label for logs/status lines. */
    readonly label: string;
    /** Platform abort signal — composable, checked between chunks. */
    readonly signal: AbortSignal;

    private readonly controller = new AbortController();

    constructor(scope: JobScope, label?: string) {
        tokenSeq++;
        this.id = `job-${Date.now().toString(36)}-${tokenSeq.toString(36)}`;
        this.scope = scope;
        this.label = label ?? scope;
        this.signal = this.controller.signal;
    }

    /** True once cancel() has been called on this token. */
    get cancelled(): boolean {
        return this.signal.aborted;
    }

    /** Idempotent: cancelling twice is a no-op. */
    cancel(reason?: string): void {
        if (this.cancelled) return;
        this.controller.abort(reason ?? `${this.scope} job cancelled`);
    }
}

/**
 * Marker error for owner-scoped cancellation. `name = 'AbortError'`
 * (platform convention) — NEVER classified as a task failure or timeout.
 */
export function makeAbortError(reason = 'cancelled'): Error {
    const err = new Error(reason);
    err.name = 'AbortError';
    return err;
}

/** Distinguish an abort from a real failure (timeout / network / parse). */
export function isAbortError(err: any): boolean {
    return !!err && typeof err === 'object' && err.name === 'AbortError';
}

/**
 * Detach a promise from an AbortSignal — the same pattern as
 * TranslationEngine.withTimeout (FIX H5): the wrapper settles as soon as
 * the signal fires, while the wrapped promise keeps running in the
 * background with its result discarded (and any late rejection swallowed,
 * so the orphaned request can never produce an unhandled rejection).
 *
 * With no signal this is a transparent pass-through — interactive
 * translation paths are never aborted.
 */
export function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) {
        // Detach: the request is already condemned; keep its fate quiet.
        p.then(undefined, () => { /* discarded — conveyor already left */ });
        return Promise.reject(makeAbortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            // 5.1: detach the still-running request — HTTP abort is not
            // possible with requestUrl; the result is simply ignored.
            p.then(undefined, () => { /* discarded */ });
            reject(makeAbortError());
        };
        const onFulfilled = (v: T) => { cleanup(); resolve(v); };
        const onRejected = (e: any) => { cleanup(); reject(e); };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(onFulfilled, onRejected);
    });
}

/** Abortable pacing without leaving a long timer after cancellation. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(makeAbortError());
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => { clearTimeout(timer); cleanup(); reject(makeAbortError()); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
