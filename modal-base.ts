// modal-base.ts
//
// Stage 0.5 (Q22): SingletonModal base class.
//
// Problem: opening the same modal twice (e.g. user double-clicks the
// command, or opens it from both palette and file-menu) creates two
// concurrent instances. Their state (e.g. `OcrTextTranslator.running`)
// is per-instance, so both start their work in parallel — racing on
// the same `.translations.md` file, the same OCR cache, etc.
//
// Solution: a base class that tracks open instances per subclass. The
// second `open()` call on the same subclass either:
//   (a) closes the existing instance and opens the new one (default), OR
//   (b) focuses the existing instance and skips the new open (configurable).
//
// Subclasses opt in by extending `SingletonModal` instead of `Modal`:
//
//   class OcrRecognizeModal extends SingletonModal<OcrRecognizeModal> { ... }
//
// The generic parameter `<T>` is the subclass itself — needed so the
// static `instances` Map can be keyed per subclass (TypeScript doesn't
// give us per-subclass statics otherwise).

import { Modal, App } from 'obsidian';

export type SingletonModalReopenBehavior = 'replace' | 'focus';

export abstract class SingletonModal<T extends SingletonModal<T>> extends Modal {
    // Per-subclass instance tracking. Keyed by `this.constructor` so each
    // subclass has its own Map. We use a WeakMap so closed/discarded
    // instances don't leak.
    private static instances: WeakMap<Function, SingletonModal<any>> = new WeakMap();

    /**
     * Override in subclasses to change what happens when a second instance
     * is opened while the first is still on screen.
     *
     * - 'replace' (default): close the existing instance, open the new one.
     *   Use for modals that represent a single workflow (e.g. retranslate
     *   options) — the new open supersedes the old.
     * - 'focus': bring the existing instance to the front, skip the new open.
     *   Use for modals that show queue/progress state (e.g. watcher queue)
     *   — opening a second one would just duplicate the view.
     */
    protected reopenBehavior(): SingletonModalReopenBehavior {
        return 'replace';
    }

    /**
     * Override `open()` to enforce the singleton invariant. Callers
     * continue to write `new MyModal(app, ...).open()` — the singleton
     * check happens transparently.
     */
    open(): void {
        const existing = SingletonModal.instances.get(this.constructor);
        if (existing && existing !== this) {
            if (this.reopenBehavior() === 'focus') {
                // Try to bring the existing modal to the front. Obsidian's
                // Modal doesn't have a public `focus()` method, but
                // re-setting `modalEl.style.zIndex` is a reasonable
                // approximation. If the existing instance is closing,
                // we fall through and open the new one.
                try {
                    existing.modalEl.style.zIndex = '101';
                    return;
                } catch {
                    // fall through — existing instance is in a bad state,
                    // open the new one.
                }
            } else {
                // 'replace' — close the existing instance. Its `onClose`
                // will fire and clean up its state.
                try { existing.close(); } catch { /* ignore */ }
            }
        }
        SingletonModal.instances.set(this.constructor, this);
        super.open();
    }

    /**
     * Override `onClose()` to remove ourselves from the instances map.
     * Subclasses that override `onClose()` MUST call `super.onClose()`.
     */
    onClose(): void {
        super.onClose();
        const current = SingletonModal.instances.get(this.constructor);
        if (current === this) {
            SingletonModal.instances.delete(this.constructor);
        }
    }
}
