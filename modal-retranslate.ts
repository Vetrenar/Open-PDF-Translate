// modal-retranslate.ts
import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';
// Stage 0.5 (Q22): SingletonModal prevents two concurrent retranslate
// modals from racing on the same `.translations.md` file.
import { SingletonModal } from './modal-base';
// Phase 17 (F-D4-1): i18n for the modal title.
import { t } from './i18n';

export class RetranslateUsingOverlaysModal extends SingletonModal<RetranslateUsingOverlaysModal> {
  private plugin: OpenRouterTranslatorPlugin;
  private file: TFile;

  private onlyCurrentPage = true;
  private fromPage: number | null = null;
  private toPage: number | null = null;

  // Options
  private onlyEmpty = false;       // only translate items with empty translatedText
  private confirmOverwrite = true; // show confirmation if overwriting non-empty items

  // P0-4 (Phase 5): cancel signal for the in-progress `runRetranslation`
  // loop. Set by `onClose()` (which fires when the user clicks Cancel,
  // presses Esc, or dismisses the modal) and checked inside the per-job
  // loop and before the final disk write so we don't persist a partial
  // retranslation that the user explicitly abandoned.
  private cancelled: boolean = false;

  constructor(app: App, plugin: OpenRouterTranslatorPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  /**
   * P1-28 (Phase 5): override SingletonModal's reopen behavior. The
   * default 'replace' would call `existing.close()` on the in-progress
   * instance, which fires `onClose()` → sets `cancelled = true` →
   * the running retranslation aborts mid-chunk even though the user
   * just re-invoked the command (e.g. from the palette to peek at
   * progress). Returning 'focus' keeps the existing instance alive
   * and brings it to the front instead.
   */
  protected reopenBehavior(): 'focus' | 'replace' {
    return 'focus';
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();

    // Phase 17 (F-D4-1): was `contentEl.createEl('h2', { text: '...' })`.
    // Obsidian's Style Guide says modal titles go in `titleEl` (the modal
    // header), not as an `<h2>` inside the body. Using `titleEl.setText`
    // also gets us free dark/light theme styling and consistent spacing
    // with the other modals.
    titleEl.setText(t('modal.retranslate.title'));

    // Scope selector
    let rangeSetting: Setting;

    new Setting(contentEl)
      .setName(t('modal.retranslate.scope'))
      .setDesc(t('modal.retranslate.scope.desc'))
      .addDropdown((dd) => {
        dd.addOption('current', t('modal.retranslate.scope.current'));
        dd.addOption('range', t('modal.retranslate.scope.range'));
        dd.setValue('current');
        dd.onChange((val) => {
          this.onlyCurrentPage = (val === 'current');
          if (rangeSetting) {
            rangeSetting.settingEl.toggleClass('is-hidden', this.onlyCurrentPage);
          }
        });
      });

    // Range inputs
    rangeSetting = new Setting(contentEl)
      .setName(t('modal.retranslate.pageRange'))
      .setDesc(t('modal.retranslate.pageRange.desc'))
      .addText((txt) => {
        txt.setPlaceholder(t('modal.retranslate.from'))
          .onChange((val) => {
            const n = parseInt(val, 10);
            this.fromPage = Number.isFinite(n) && n > 0 ? n : null;
          });
      })
      .addText((txt) => {
        txt.setPlaceholder(t('modal.retranslate.to'))
          .onChange((val) => {
            const n = parseInt(val, 10);
            this.toPage = Number.isFinite(n) && n > 0 ? n : null;
          });
      });

    rangeSetting.settingEl.addClass('is-hidden');

    // Options
    new Setting(contentEl)
      .setName(t('modal.retranslate.onlyEmpty'))
      .setDesc(t('modal.retranslate.onlyEmpty.desc'))
      .addToggle((tg) => {
        tg.setValue(this.onlyEmpty)
          .onChange((v) => (this.onlyEmpty = v));
      });

    new Setting(contentEl)
      .setName(t('modal.retranslate.confirmOverwrite'))
      .setDesc(t('modal.retranslate.confirmOverwrite.desc'))
      .addToggle((tg) => {
        tg.setValue(this.confirmOverwrite)
          .onChange((v) => (this.confirmOverwrite = v));
      });

    // Actions
    // Phase 14.3 (F-D4-2): disable Start during the async `runRetranslation()`
    // so a double-click can't kick off two concurrent retranslation passes on
    // the same file (they'd race on `updatePageOverlaysAndWrite` and the
    // second could clobber the first). Cancel stays enabled — user can still
    // bail out mid-run if needed.
    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(t('modal.start'))
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.runRetranslation();
              this.close();
            } catch (e: any) {
              console.error(e);
              new Notice(t('modal.retranslate.failed', { error: e?.message || t('modal.retranslate.unknownError') }));
            } finally {
              btn.setDisabled(false);
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText(t('modal.cancel'))
          .onClick(() => {
            // P0-4 (Phase 5): set the cancel flag BEFORE close() so the
            // runRetranslation loop sees it on the next iteration check.
            // `onClose()` also sets it, but setting it here makes the
            // intent explicit and protects against any future refactor
            // that changes the onClose ordering.
            this.cancelled = true;
            this.close();
          });
      });

    // Small helper style
    const style = document.createElement('style');
    style.textContent = `
      .is-hidden { display: none !important; }
      .modal .setting-item.is-hidden { display: none !important; }
    `;
    contentEl.appendChild(style);
  }

  onClose(): void {
    // P0-4 (Phase 5): signal cancel. Covers Esc, backdrop click, and
    // any other dismiss path that doesn't go through the Cancel button.
    // The runRetranslation loop checks this flag on every iteration and
    // before the final disk write.
    this.cancelled = true;
    this.contentEl.empty();
    // Stage 0.5 (Q22): MUST call super.onClose() so SingletonModal can
    // remove us from the per-subclass instances Map.
    super.onClose();
  }

  private async runRetranslation(): Promise<void> {
    // Ensure we have an active page (for default selection and rendering)
    const currentPage = this.plugin.getCurrentPageNumber();
    if (currentPage == null) {
      new Notice(t('modal.retranslate.noActivePage'));
      return;
    }

    // Load the saved overlay file
    const translationFile = await this.plugin.storage.findTranslationFileForPdf(this.file);
    if (!translationFile) {
      new Notice(t('modal.retranslate.noFile'));
      return;
    }
    const md = await this.app.vault.read(translationFile);
    const saved = this.plugin.storage.parseMarkdownOverlay(md, this.file);
    if (!saved) {
      new Notice(t('modal.retranslate.noOverlays'));
      return;
    }

    // Build page list
    const targetPages = this.onlyCurrentPage
      ? [currentPage]
      : this.buildPageRange();
    if (targetPages.length === 0) {
      new Notice(t('modal.retranslate.invalidRange'));
      return;
    }

    // Collect jobs
    const jobs: { page: number; pageItems: OverlayPositionData[]; targetIndexes: number[] }[] = [];
    for (const p of targetPages) {
      const key = String(p);
      const pageItems = saved.pageOverlays[key] || [];
      const targetIndexes = pageItems
        .map((it, idx) => ({ it, idx }))
        .filter(({ it }) => (it.textContent || '').trim().length > 0)
        .filter(({ it }) => !this.onlyEmpty || !it.translatedText || !it.translatedText.trim())
        .map(({ idx }) => idx);

      if (targetIndexes.length > 0) {
        jobs.push({ page: p, pageItems, targetIndexes });
      }
    }

    if (jobs.length === 0) {
      new Notice(t('modal.retranslate.noMatching'));
      return;
    }

    // Confirm overwrite if needed
    if (!this.onlyEmpty && this.confirmOverwrite) {
      const willOverwrite = jobs.some(j =>
        j.targetIndexes.some(idx => (j.pageItems[idx]?.translatedText || '').trim().length > 0)
      );
      if (willOverwrite) {
        const proceed = await this.confirm(
          t('modal.retranslate.overwriteTitle'),
          t('modal.retranslate.overwriteMessage')
        );
        if (!proceed) return;
      }
    }

    let totalItems = jobs.reduce((acc, j) => acc + j.targetIndexes.length, 0);
    new Notice(t('modal.retranslate.translatingNotice', { total: String(totalItems), pages: String(jobs.length) }), 3000);

    // Execute page by page
    for (const job of jobs) {
      // P0-4 (Phase 5): check cancel at the top of each iteration so we
      // don't start a new page's translation work after the user has
      // dismissed the modal. The await points inside the loop body are
      // the only places the flag can flip (close() is synchronous from
      // the user's click but the flag is set before close() runs).
      if (this.cancelled) break;
      const texts = job.targetIndexes.map(idx => job.pageItems[idx]?.textContent || '');

      let translated: string[] = [];
      try {
        if (this.plugin.settings.useBatchTranslation && texts.length > 1) {
          const numbered = texts.map((t, idx) => `${idx + 1}. ${t}`).join('\n');
          const maxChars = this.plugin.settings.maxBatchChars;
          if (numbered.length > maxChars) {
            translated = [];
            for (const t of texts) {
              translated.push(await this.plugin.translation.translateWithOpenRouter(t));
            }
          } else {
            const raw = await this.plugin.translation.translateBatch(numbered, texts.length);
            // Fix: extractNumberedLines is async (returns Promise<string[]>).
            // Without `await`, `translated` is the Promise object, and
            // `translated[i]` is undefined — every translated entry would
            // fall back to the original text, silently defeating the
            // batch path.
            translated = await this.plugin.processor.extractNumberedLines(raw, texts.length, texts);
          }
        } else {
          // Sequential
          translated = [];
          for (const t of texts) {
            try {
              const out = await this.plugin.translation.translateWithOpenRouter(t);
              translated.push(out);
            } catch (e) {
              console.error('Sequential translate failed:', e);
              translated.push(t); // fallback
            }
          }
        }
      } catch (e) {
        console.error('Retranslation error on page', job.page, e);
        translated = texts.slice(); // fallback: keep original
      }

      // Update saved overlay data
      job.targetIndexes.forEach((itemIndex, i) => {
        const item = job.pageItems[itemIndex];
        if (!item) return;
        item.translatedText = translated[i] || item.textContent || '';
      });

      // Preserve full page array; only targeted entries are updated.
      saved.pageOverlays[String(job.page)] = job.pageItems;
    }

    // Persist to disk
    saved.timestamp = Date.now();

    // P0-4 (Phase 5): if the user cancelled mid-run, skip the disk write
    // and the visual refresh — the partial in-memory `saved` object may
    // contain half-translated pages that the user explicitly abandoned.
    // We return early with a Notice so the user knows their cancellation
    // was honored and the on-disk file is unchanged.
    if (this.cancelled) {
      new Notice(t('modal.retranslate.cancelled'));
      return;
    }

    // P0-8: previously called `this.app.vault.modify(translationFile, newMd)`
    // directly — bypassing `storage.updatePageOverlaysAndWrite`. Consequences:
    //   1. No `markSelfWrite()` — the metadataCache 'changed' event fired,
    //      `isSelfWrite` returned false, `debouncedBuildMap` rebuilt the
    //      entire `pdfToMdMap` (noticeable lag on large vaults).
    //   2. `overlay.cachedOverlayData` was NOT updated in-place — only the
    //      current page was refreshed via `refreshPageOverlayFromSaved`;
    //      other cached pages became stale until next navigation.
    //   3. No per-file write lock — race with background `PdfLayoutQueue`
    //      worker that could be writing the same file simultaneously.
    // Going through `updatePageOverlaysAndWrite` fixes all three. We must
    // convert the keys from string (YAML-style) to number to match the
    // expected `Record<number, OverlayPositionData[]>` signature.
    //
    // Phase 4 (P0-9): pass `replace: true` so retranslated pages REPLACE
    // the existing page arrays directly (no merge-by-rect-overlap). The
    // `saved` object was built by selectively replacing items the user
    // chose to retranslate — the resulting per-page array is the
    // authoritative new state and any items it omits must be considered
    // intentionally removed.
    const overlaysByPage: Record<number, OverlayPositionData[]> = {};
    for (const [k, v] of Object.entries(saved.pageOverlays)) {
      const pageNum = Number(k);
      if (Number.isFinite(pageNum)) {
        overlaysByPage[pageNum] = v as OverlayPositionData[];
      }
    }
    await this.plugin.storage.updatePageOverlaysAndWrite(this.file, overlaysByPage, { replace: true });

    // Re-render current visible page if applicable
    const pageToRefresh = this.onlyCurrentPage ? currentPage : this.plugin.getCurrentPageNumber();
    if (pageToRefresh != null) {
      await this.refreshPageOverlayFromSaved(saved, pageToRefresh);
    }

    new Notice(t('modal.retranslate.complete'));
  }

  private buildPageRange(): number[] {
    const out: number[] = [];
    if (this.fromPage == null || this.toPage == null) return out;
    if (this.toPage < this.fromPage) return out;
    for (let p = this.fromPage; p <= this.toPage; p++) out.push(p);
    return out;
  }

  private async refreshPageOverlayFromSaved(saved: SavedOverlay, pageNumber: number): Promise<void> {
    try {
      const pageData = saved.pageOverlays[String(pageNumber)];
      if (!Array.isArray(pageData) || pageData.length === 0) return;

      const textLayer = await this.plugin.overlay.waitForPdfTextLayer(pageNumber);
      if (!textLayer) return;

      // P1-13 (Phase 14): use overlay.clearOverlayFromPage for proper
      // listener cleanup (uiRenderer.cleanupOverlayElement detaches
      // per-overlay contextmenu / click / mouseover / mouseleave handlers
      // and removes the element from trackedOverlayElements). The previous
      // direct .remove() on the container left those listeners attached to
      // the detached DOM subtree, leaking memory across retranslates.
      const pageEl = this.getPageElementByNumber(pageNumber);
      if (pageEl) {
        this.plugin.overlay?.clearOverlayFromPage?.(pageEl);
      }

      // Render from saved data
      this.plugin.overlay.renderSavedOverlay(pageData, pageNumber);
    } catch (e) {
      console.error('Failed to refresh overlay for page', pageNumber, e);
    }
  }

  // Use overlay helper if present; otherwise use a local query
  private getPageElementByNumber(pageNumber: number): HTMLElement | null {
    // Prefer plugin.overlay.getPageElementByNumber if available
    const anyOverlay: any = this.plugin.overlay as any;
    if (typeof anyOverlay.getPageElementByNumber === 'function') {
      return anyOverlay.getPageElementByNumber(pageNumber);
    }
    const viewer = document.querySelector('.pdfViewer, #viewer');
    if (!viewer) return null;
    return viewer.querySelector(`.page[data-page-number="${pageNumber}"]`) as HTMLElement | null;
  }

  private async confirm(title: string, message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const dlg = new Modal(this.app);
      // P0-7: previously, if the user dismissed the dialog via Esc or by
      // clicking the backdrop, `dlg.close()` ran, `onClose` emptied the
      // contentEl, but `resolve()` was NEVER called. The Promise hung
      // forever, `await this.confirm(...)` in `runRetranslation` never
      // returned, and the whole retranslate workflow was permanently stuck.
      // The `resolved` guard ensures we only resolve once even if both a
      // button click and the onClose fire (race window during close).
      let resolved = false;
      const done = (v: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve(v);
      };
      dlg.contentEl.createEl('h3', { text: title });
      dlg.contentEl.createEl('p', { text: message });

      new Setting(dlg.contentEl)
        .addButton((btn) => {
          btn.setButtonText(t('modal.cancel'))
            .onClick(() => {
              dlg.close();
              done(false);
            });
        })
        .addButton((btn) => {
          btn.setCta();
          btn.setButtonText(t('modal.translate.overwrite'))
            .onClick(() => {
              dlg.close();
              done(true);
            });
        });

      // P0-7: fallback resolve on close — covers Esc, backdrop click, and
      // any other dismiss path that doesn't go through the buttons.
      dlg.onClose = () => {
        dlg.contentEl.empty();
        done(false);
      };
      dlg.open();
    });
  }
}
