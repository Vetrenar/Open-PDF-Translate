// modal-retranslate.ts
import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { SavedOverlay, OverlayPositionData } from './types';

export class RetranslateUsingOverlaysModal extends Modal {
  private plugin: OpenRouterTranslatorPlugin;
  private file: TFile;

  private onlyCurrentPage = true;
  private fromPage: number | null = null;
  private toPage: number | null = null;

  // Options
  private onlyEmpty = false;       // only translate items with empty translatedText
  private confirmOverwrite = true; // show confirmation if overwriting non-empty items

  constructor(app: App, plugin: OpenRouterTranslatorPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Re-translate using saved overlay boxes' });

    // Scope selector
    let rangeSetting: Setting;

    new Setting(contentEl)
      .setName('Scope')
      .setDesc('Choose which pages to re-translate')
      .addDropdown((dd) => {
        dd.addOption('current', 'Current page only');
        dd.addOption('range', 'Page range…');
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
      .setName('Page range')
      .setDesc('Inclusive page range (1-based indices)')
      .addText((txt) => {
        txt.setPlaceholder('From')
          .onChange((val) => {
            const n = parseInt(val, 10);
            this.fromPage = Number.isFinite(n) && n > 0 ? n : null;
          });
      })
      .addText((txt) => {
        txt.setPlaceholder('To')
          .onChange((val) => {
            const n = parseInt(val, 10);
            this.toPage = Number.isFinite(n) && n > 0 ? n : null;
          });
      });

    rangeSetting.settingEl.addClass('is-hidden');

    // Options
    new Setting(contentEl)
      .setName('Only re-translate empty items')
      .setDesc('If enabled, only items with no translated text will be translated.')
      .addToggle((tg) => {
        tg.setValue(this.onlyEmpty)
          .onChange((v) => (this.onlyEmpty = v));
      });

    new Setting(contentEl)
      .setName('Ask before overwriting non-empty items')
      .setDesc('When unchecked, existing translations will be overwritten without confirmation.')
      .addToggle((tg) => {
        tg.setValue(this.confirmOverwrite)
          .onChange((v) => (this.confirmOverwrite = v));
      });

    // Actions
    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Start')
          .setCta()
          .onClick(async () => {
            try {
              await this.runRetranslation();
              this.close();
            } catch (e: any) {
              console.error(e);
              new Notice(`Retranslation failed: ${e?.message || 'Unknown error'}`);
            }
          });
      })
      .addButton((btn) => {
        btn.setButtonText('Cancel')
          .onClick(() => this.close());
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
    this.contentEl.empty();
  }

  private async runRetranslation(): Promise<void> {
    // Ensure we have an active page (for default selection and rendering)
    const currentPage = this.plugin.getCurrentPageNumber();
    if (currentPage == null) {
      new Notice('No active page detected.');
      return;
    }

    // Load the saved overlay file
    const translationFile = await this.plugin.storage.findTranslationFileForPdf(this.file);
    if (!translationFile) {
      new Notice('No translation file found for this PDF.');
      return;
    }
    const md = await this.app.vault.read(translationFile);
    const saved = this.plugin.storage.parseMarkdownOverlay(md, this.file);
    if (!saved) {
      new Notice('No saved overlays found.');
      return;
    }

    // Build page list
    const targetPages = this.onlyCurrentPage
      ? [currentPage]
      : this.buildPageRange();
    if (targetPages.length === 0) {
      new Notice('Invalid or empty page range.');
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
      new Notice('No matching overlay items found for the selected scope.');
      return;
    }

    // Confirm overwrite if needed
    if (!this.onlyEmpty && this.confirmOverwrite) {
      const willOverwrite = jobs.some(j =>
        j.targetIndexes.some(idx => (j.pageItems[idx]?.translatedText || '').trim().length > 0)
      );
      if (willOverwrite) {
        const proceed = await this.confirm(
          'Overwrite existing translations?',
          'Some items already have translated text. Do you want to overwrite them?'
        );
        if (!proceed) return;
      }
    }

    let totalItems = jobs.reduce((acc, j) => acc + j.targetIndexes.length, 0);
    new Notice(`Re-translating ${totalItems} item(s) across ${jobs.length} page(s)...`, 3000);

    // Execute page by page
    for (const job of jobs) {
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
            translated = this.plugin.processor.extractNumberedLines(raw, texts.length, texts);
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
    const newMd = this.plugin.storage.generateMarkdownForOverlay(saved, this.file);
    await this.app.vault.modify(translationFile, newMd);

    // Re-render current visible page if applicable
    const pageToRefresh = this.onlyCurrentPage ? currentPage : this.plugin.getCurrentPageNumber();
    if (pageToRefresh != null) {
      await this.refreshPageOverlayFromSaved(saved, pageToRefresh);
    }

    new Notice('✅ Re-translation complete.');
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

      // Clear existing overlays on the page
      const pageEl = this.getPageElementByNumber(pageNumber);
      pageEl?.querySelectorAll('.pdf-text-overlay-container')?.forEach(el => el.remove());

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
      dlg.contentEl.createEl('h3', { text: title });
      dlg.contentEl.createEl('p', { text: message });

      new Setting(dlg.contentEl)
        .addButton((btn) => {
          btn.setButtonText('Cancel')
            .onClick(() => {
              dlg.close();
              resolve(false);
            });
        })
        .addButton((btn) => {
          btn.setCta();
          btn.setButtonText('Overwrite')
            .onClick(() => {
              dlg.close();
              resolve(true);
            });
        });

      dlg.onClose = () => dlg.contentEl.empty();
      dlg.open();
    });
  }
}
