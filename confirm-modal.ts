// confirm-modal.ts
// ─────────────────────────────────────────────────────────────────────────
// A small Obsidian-style confirm dialog. Replaces the native alert()/confirm()
// calls that were scattered across the codebase (notably in layout-modal.ts).
//
// Why not use alert()/confirm()?
//   1. They block the entire UI thread, freezing Obsidian's animations and
//      workspace rendering until the user dismisses the dialog.
//   2. They are NOT themed — they use the OS-native chrome, which clashes
//      with the rest of the Obsidian UI (especially in dark themes).
//   3. They don't support keyboard navigation the way Obsidian Modals do
//      (Tab to focus, Enter to confirm, Esc to cancel).
//   4. On mobile (Obsidian mobile), they often render at the wrong size
//      and are hard to dismiss.
//
// Usage:
//   const ok = await ConfirmModal.prompt(this.app, 'Title', 'Are you sure?');
//   if (ok) { ... }
//
//   await ConfirmModal.alert(this.app, 'Warning', 'Something happened.');
//   // (resolves once the user dismisses)
//
// FIX (Phase 6, F6.3): introduced to replace layout-modal.ts's alert/confirm.
// ─────────────────────────────────────────────────────────────────────────

import { App, Modal, Setting, ButtonComponent } from 'obsidian';

export class ConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private confirmed: boolean = false;

    constructor(app: App, title: string, message: string, opts: { confirmText?: string; cancelText?: string; isWarning?: boolean } = {}) {
        super(app);
        this.titleEl.setText(title);
        this.contentEl.createEl('p', { text: message, cls: 'setting-item-description' });

        new Setting(this.contentEl)
            .addButton(b => {
                b.setButtonText(opts.cancelText ?? 'Cancel')
                 .onClick(() => { this.confirmed = false; this.close(); });
            })
            .addButton(b => {
                b.setButtonText(opts.confirmText ?? 'Confirm')
                 .setCta();
                if (opts.isWarning) b.setWarning();
                b.onClick(() => { this.confirmed = true; this.close(); });
            });
    }

    onOpen(): void {
        // Focus the confirm button by default for keyboard users.
        // (Obsidian Modal handles Esc → close automatically.)
    }

    onClose(): void {
        super.onClose();
        if (this.resolveFn) this.resolveFn(this.confirmed);
    }

    /**
     * Promise-based confirm. Resolves to `true` if the user clicked Confirm,
     * `false` otherwise (Cancel or backdrop-click or Esc).
     */
    static confirm(
        app: App,
        title: string,
        message: string,
        opts?: { confirmText?: string; cancelText?: string; isWarning?: boolean }
    ): Promise<boolean> {
        const m = new ConfirmModal(app, title, message, opts);
        return new Promise<boolean>(resolve => {
            m.resolveFn = resolve;
            m.open();
        });
    }

    /**
     * Promise-based alert. Resolves once the user dismisses the dialog.
     * Single OK button — there is no Cancel.
     */
    static alert(app: App, title: string, message: string, opts?: { okText?: string }): Promise<void> {
        return new Promise<void>(resolve => {
            const m = new Modal(app);
            // P0-7: previously, if the user dismissed via Esc or backdrop
            // click, `m.close()` ran but `resolve()` was NEVER called — the
            // Promise hung forever. The `resolved` guard + `onClose` fallback
            // ensure the Promise always settles.
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };
            m.titleEl.setText(title);
            m.contentEl.createEl('p', { text: message, cls: 'setting-item-description' });
            new Setting(m.contentEl).addButton(b => {
                b.setButtonText(opts?.okText ?? 'OK')
                 .setCta()
                 .onClick(() => { m.close(); done(); });
            });
            // P0-7: cover Esc / backdrop dismiss paths.
            m.onClose = () => done();
            m.open();
        });
    }
}
