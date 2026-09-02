// modal-edit-translation.ts
//
// Phase 11 (C8): constructor now accepts an `OverlayPositionData` instead of
// `(itemIndex, originalText, currentTranslation)` strings. The overlay DOM
// element already carries the original text via `data-original-text`; we
// bundle it into a full OverlayPositionData so the modal has everything it
// needs to locate and update the entry without an index (which can drift if
// overlays are added/removed between the modal opening and saving).
//
// Phase 14 (C14): now extends `SingletonModal<EditSpecificTranslationModal>`
// instead of `Modal`. Prevents two concurrent edit modals from racing on the
// same `.translations.md` file (the second `open()` closes the first).
//
// Phase 14.3: Save button is explicitly disabled during the async save so a
// double-click can't trigger two concurrent `updatePageOverlaysAndWrite`
// calls on the same file (the second write would clobber the first).

import { App, Modal, Notice, Setting, TextAreaComponent, TFile, ButtonComponent } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
import type { OverlayPositionData } from './types';
import { SingletonModal } from './modal-base';
import { t } from './i18n';

export class EditSpecificTranslationModal extends SingletonModal<EditSpecificTranslationModal> {
    private plugin: OpenRouterTranslatorPlugin;
    private file: TFile;
    private pageNumber: number;
    // Phase 11 (C8): full overlay data — replaces `(itemIndex, originalText,
    // currentTranslation)`. The text fields are sourced from this so the
    // modal stays consistent if the caller passed in stale strings.
    private overlayData: OverlayPositionData;
    private originalText: string;
    private currentTranslation: string;
    private newTranslation: string;

    // P0-3 (Phase 5): tracks whether the user has typed into the textarea
    // since the modal opened (or since the last successful save). Used by
    // the overridden `close()` to decide whether to prompt before
    // discarding unsaved edits.
    private isDirty: boolean = false;

    // Phase 14.3: hold button refs so we can disable during await.
    private saveBtn: ButtonComponent | null = null;
    private cancelBtn: ButtonComponent | null = null;

    constructor(
        app: App,
        plugin: OpenRouterTranslatorPlugin,
        file: TFile,
        pageNumber: number,
        overlayData: OverlayPositionData,
    ) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.pageNumber = pageNumber;
        this.overlayData = overlayData;
        this.originalText = overlayData.textContent || '';
        this.currentTranslation = overlayData.translatedText || '';
        this.newTranslation = this.currentTranslation;
    }

    onOpen() {
        const { contentEl, titleEl, modalEl } = this;

        // 1. Setup Modal styling for a wider/cleaner look
        modalEl.addClass('ort-translation-modal');
        titleEl.setText(t('modal.edit.title'));

        // 2. Container for Original Text (Read Only)
        contentEl.createEl('h6', { text: t('modal.edit.original') }).style.cssText =
            'margin: 0 0 5px 0; color: var(--text-muted);';

        const originalContainer = contentEl.createDiv({ cls: 'ort-original-container' });
        const originalTextArea = new TextAreaComponent(originalContainer);

        originalTextArea
            .setValue(this.originalText)
            .setDisabled(true); // Read-only but copyable

        // Style the original text area
        originalTextArea.inputEl.style.width = '100%';
        originalTextArea.inputEl.style.height = '150px';
        originalTextArea.inputEl.style.resize = 'vertical';
        originalTextArea.inputEl.style.background = 'var(--background-secondary)';
        originalTextArea.inputEl.style.color = 'var(--text-muted)';
        originalTextArea.inputEl.style.fontFamily = 'var(--font-monospace)';
        originalTextArea.inputEl.style.fontSize = '0.9em';

        // Spacer (Phase 17: avoid `style` prop on createDiv — DomElementInfo
        // doesn't declare it, so TS strict-mode complains. Set cssText after.)
        const spacer = contentEl.createDiv();
        spacer.style.cssText = 'height: 15px;';

        // 3. Container for Translation (Editable)
        const translationHeader = contentEl.createEl('h6', { text: t('modal.edit.translated') });
        translationHeader.style.cssText = 'margin: 0 0 5px 0; color: var(--text-accent);';

        const translationContainer = contentEl.createDiv({ cls: 'ort-translation-container' });
        const translationTextArea = new TextAreaComponent(translationContainer);

        translationTextArea
            .setValue(this.currentTranslation)
            .setPlaceholder(t('modal.edit.placeholder'))
            .onChange((value) => {
                this.newTranslation = value;
                // P0-3 (Phase 5): mark the edit as unsaved so `close()` can
                // prompt before discarding.
                this.isDirty = true;
            });

        // Style the editing text area
        translationTextArea.inputEl.style.width = '100%';
        translationTextArea.inputEl.style.height = '200px'; // Taller for editing
        translationTextArea.inputEl.style.resize = 'vertical';
        translationTextArea.inputEl.style.fontFamily = 'var(--font-text)';

        // Focus the editor immediately
        setTimeout(() => translationTextArea.inputEl.focus(), 50);

        // 4. Footer / Action Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        this.cancelBtn = new ButtonComponent(buttonContainer)
            .setButtonText(t('modal.edit.cancel'))
            .onClick(() => this.close());

        this.saveBtn = new ButtonComponent(buttonContainer)
            .setButtonText(t('modal.edit.save'))
            .setCta() // Call to action (accent color)
            .onClick(async () => {
                // Phase 14.3: disable BOTH buttons for the duration of the
                // save. Previously only `buttonContainer.addClass('is-loading')`
                // was used — that adds a CSS class but does NOT prevent the
                // click handler from firing again. A double-click would
                // trigger two concurrent `updatePageOverlaysAndWrite` calls
                // on the same file, with the second potentially clobbering
                // the first.
                this.saveBtn?.setDisabled(true);
                this.cancelBtn?.setDisabled(true);
                buttonContainer.addClass('is-loading');
                try {
                    await this.saveChanges();
                    this.close();
                } catch (e) {
                    console.error('Save failed:', e);
                    new Notice(t('modal.edit.saveFailed'));
                    // Re-enable so the user can retry / dismiss.
                    this.saveBtn?.setDisabled(false);
                    this.cancelBtn?.setDisabled(false);
                    buttonContainer.removeClass('is-loading');
                }
            });
    }

    async saveChanges() {
        // Optimization: Don't do anything if text hasn't changed
        if (this.newTranslation === this.currentTranslation) return;

        try {
            // 1. Read the SOURCE OF TRUTH (the file on disk)
            // relying on cache is risky for edits, we want the latest state.
            const result = await this.plugin.storage.readSavedOverlayForFile(this.file);

            if (!result || !result.overlay) {
                new Notice(t('modal.edit.fileNotFound'));
                return;
            }

            const { overlay } = result;
            const pageOverlays = overlay.pageOverlays[this.pageNumber];

            if (!Array.isArray(pageOverlays) || pageOverlays.length === 0) {
                new Notice(t('modal.edit.noOverlays'));
                return;
            }

            // Phase 11 (C8) + Phase 7 (P1-11): locate the entry to edit.
            //
            // P1-11 (Phase 7): primary lookup is now by `id` (the stable
            // per-overlay identifier persisted to .translations.md and
            // stamped on the DOM as `data-translation-id`). This gives an
            // EXACT match — critical when a page contains duplicate
            // paragraphs (e.g. repeated section headings, list items with
            // identical text) where the previous textContent-based lookup
            // would always return the FIRST match, silently editing the
            // wrong overlay.
            //
            // Fallbacks (used when `id` is absent — e.g. V3 files that
            // haven't been re-saved since the Phase 7 upgrade, or in-memory
            // overlays rendered before any save):
            //   1. textContent equality (the original Phase 11 behaviour).
            //   2. translatedText equality (in case the worker reformatted
            //      the original text between modal open and save).
            //
            // The id-based path also survives worker rewrites that change
            // the rect (e.g. re-extraction with a different scale) — the
            // id is hash(page + rect@3dec + textContent), so a small rect
            // drift (≤0.001) keeps the same id; a large drift would change
            // the id, in which case the fallbacks kick in.
            let matchIndex = -1;
            if (this.overlayData.id) {
                matchIndex = pageOverlays.findIndex(o => o.id === this.overlayData.id);
            }
            if (matchIndex === -1) {
                // Fallback 1: match by textContent (Phase 11 behaviour).
                const targetTextContent = (this.overlayData.textContent || '').trim();
                matchIndex = pageOverlays.findIndex(o =>
                    (o.textContent || '').trim() === targetTextContent
                );
            }
            if (matchIndex === -1) {
                // Fallback 2: match by translated text (in case the original
                // text was reformatted by the worker between open and save).
                const targetTranslation = (this.overlayData.translatedText || '').trim();
                matchIndex = pageOverlays.findIndex(o =>
                    (o.translatedText || '').trim() === targetTranslation
                );
            }
            if (matchIndex === -1) {
                new Notice(t('modal.edit.blockNotFound'));
                console.warn(
                    '[EditSpecificTranslationModal] no match for overlayData',
                    {
                        id: this.overlayData.id,
                        targetTextContent: (this.overlayData.textContent || '').trim(),
                        targetTranslation: (this.overlayData.translatedText || '').trim(),
                        pageOverlays,
                    }
                );
                return;
            }

            // Optional: Sanity check to ensure we are editing what we think
            // we are editing. We trim() to avoid minor whitespace issues
            // causing false flags.
            const currentStoredText = pageOverlays[matchIndex].textContent || '';
            if (currentStoredText.trim() !== this.originalText.trim()) {
                console.warn(`[EditModal] Text mismatch warning. Stored: "${currentStoredText}", Modal saw: "${this.originalText}"`);
                // We proceed anyway because the match was found by content,
                // but it's good to log.
            }

            // 3. Update the data in memory (Clone to avoid mutation side-effects before save)
            const updatedOverlays = [...pageOverlays];

            // Merge existing data with new translation
            updatedOverlays[matchIndex] = {
                ...updatedOverlays[matchIndex],
                translatedText: this.newTranslation
            };

            // 4. Write back to disk
            // This method handles the file locking/race conditions
            const pagesToUpdate = { [this.pageNumber]: updatedOverlays };
            // Phase 4 (P0-9): use REPLACE semantics. The edit modal already
            // produces a fully-resolved page array (the existing page with
            // one item replaced by the user's new translation). Without
            // `replace: true`, the merge-by-rect-overlap step could keep
            // stale items whose rects overlap the edited item (e.g. an
            // item that was deleted on a previous save but whose rect
            // happens to overlap this one).
            await this.plugin.storage.updatePageOverlaysAndWrite(this.file, pagesToUpdate, { replace: true });

            // 5. Update Runtime Cache & UI
            // Force visual refresh of this page in the PDF Viewer
            await this.plugin.overlay.loadSavedOverlayForPage(this.pageNumber, true);

            new Notice(t('modal.edit.updated'));
            // P0-3 (Phase 5): clear the dirty flag so a subsequent
            // `close()` won't re-prompt — the user's edits are now on disk.
            this.isDirty = false;

        } catch (error) {
            console.error('Failed to save translation edit:', error);
            new Notice(t('modal.edit.saveFailed'));
        }
    }

    /**
     * P0-3 (Phase 5): intercept close so we can prompt before discarding
     * unsaved edits. We override `close()` (not `onClose()`) because
     * Obsidian's `Modal.onClose` is called AFTER the modal is already
     * closing — by then we cannot cancel. By checking `isDirty` in
     * `close()`, we can decide whether to proceed (`super.close()`) or
     * stay open (`return` without calling super).
     *
     * Three outcomes:
     *   - Save   → run `saveChanges()`, then `super.close()`
     *   - Discard → `super.close()` without save
     *   - Cancel → `return` (modal stays open, edits preserved)
     */
    close(): void {
        if (this.isDirty && this.newTranslation !== this.currentTranslation) {
            void this.promptSaveDiscardCancel();
            return; // don't actually close yet — close in the prompt's callback
        }
        super.close();
    }

    private async promptSaveDiscardCancel(): Promise<void> {
        const choice = await this.confirmThreeWay(
            t('modal.edit.unsavedTitle'),
            t('modal.edit.unsavedMessage'),
            t('modal.edit.save'),
            t('modal.edit.discard'),
            t('modal.edit.cancel'),
        );
        if (choice === 'save') {
            try {
                await this.saveChanges();
            } catch (e) {
                console.error('Save on close failed:', e);
                new Notice(t('modal.edit.saveFailed'));
                // Don't close — let the user retry or discard explicitly.
                return;
            }
            // saveChanges() clears isDirty on success; even if it didn't,
            // we proceed to close since the user explicitly chose Save.
            super.close();
        } else if (choice === 'discard') {
            this.isDirty = false;
            super.close();
        }
        // choice === 'cancel' → do nothing, modal stays open
    }

    private confirmThreeWay(
        title: string,
        message: string,
        saveLabel: string,
        discardLabel: string,
        cancelLabel: string,
    ): Promise<'save' | 'discard' | 'cancel'> {
        return new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
            const dlg = new Modal(this.app);
            // P0-7-style resolved guard: prevents double-resolve if both a
            // button click and the onClose fallback fire during close.
            let resolved = false;
            const done = (v: 'save' | 'discard' | 'cancel') => {
                if (resolved) return;
                resolved = true;
                resolve(v);
            };
            dlg.titleEl.setText(title);
            dlg.contentEl.createEl('p', { text: message });
            new Setting(dlg.contentEl)
                .addButton(b => {
                    b.setButtonText(saveLabel).setCta().onClick(() => {
                        dlg.close();
                        done('save');
                    });
                })
                .addButton(b => {
                    b.setButtonText(discardLabel).setWarning().onClick(() => {
                        dlg.close();
                        done('discard');
                    });
                })
                .addButton(b => {
                    b.setButtonText(cancelLabel).onClick(() => {
                        dlg.close();
                        done('cancel');
                    });
                });
            // Fallback resolve on close — covers Esc and backdrop click.
            dlg.onClose = () => {
                dlg.contentEl.empty();
                done('cancel');
            };
            dlg.open();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        // Phase 14 (C14): MUST call super.onClose() so SingletonModal can
        // remove us from the per-subclass instances Map.
        super.onClose();
    }
}
