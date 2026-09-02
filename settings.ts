// settings.ts
import {
    PluginSettingTab,
    App,
    Setting,
    debounce,
    TextComponent,
    normalizePath,
    DropdownComponent,
    ToggleComponent,
    SliderComponent,
    TextAreaComponent,
    ButtonComponent,
    Notice,
    requestUrl,
    Platform,
    TFolder
} from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import { installPythonScripts } from './python-scripts';
import { DEFAULT_OCR_TEXT_PROMPT } from './default-prompts';
import { t } from './i18n';
import { WatcherQueueModal } from './watcher-modal';
import {
    ALL_PROVIDERS,
    getProvider,
    fetchProviderModels,
    invalidateModelCache,
    testConnection,
    type ProviderDef,
    type ProviderModel,
} from './providers';
import {
    AVAILABLE_LANGUAGES,
    DEFAULT_SETTINGS,
    GEMMA_TEMPLATE,
    DEFAULT_CUSTOM_TEMPLATE,
    // ════════════════════════════════════════════
    // 🆕 Import Ollama‑specific default prompts
    // ════════════════════════════════════════════
    DEFAULT_OCR_PROMPT,
    DEFAULT_OCR_FILEPATH_PROMPT,
    OLLAMA_OCR_PROMPT_LENIENT,
    OLLAMA_OCR_PROMPT_REPAIR_FRIENDLY,
    // Type needed for helper function
    OcrProviderSettings
} from './types';

// === Folder Suggester Component ===
export class FolderSuggest extends TextComponent {
    app: App;
    private changeCb: ((value: string) => any) | null = null;
    private dropdownEl: HTMLElement | null = null;

    constructor(app: App, containerEl: HTMLElement) {
        super(containerEl);
        this.app = app;
        this.setPlaceholder(t('settings.folderSuggest.placeholder'));
        this.inputEl.style.width = '100%';
        this.inputEl.addEventListener('input', () => { this.fireChange(); this.renderSuggestions(); });
        this.inputEl.addEventListener('focus', () => this.renderSuggestions());
        this.inputEl.addEventListener('blur', () => this.scheduleClose());
    }

    // Own the change callback so selecting a suggestion also persists.
    onChange(cb: (value: string) => any): this {
        this.changeCb = cb;
        return this;
    }
    private fireChange() {
        if (this.changeCb) this.changeCb(this.getValue());
    }

    private allFolders(): string[] {
        return this.app.vault.getAllLoadedFiles()
            .filter((f): f is TFolder => f instanceof TFolder)
            .map(f => f.path)
            .filter(p => p && p !== '/');
    }

    private renderSuggestions() {
        this.closeDropdown();
        const query = this.getValue().toLowerCase();
        const matches = this.allFolders()
            .filter(p => p.toLowerCase().includes(query))
            .slice(0, 12);
        if (matches.length === 0) return;

        const drop = this.inputEl.parentElement!.createDiv({ cls: 'pdf-translate-folder-suggest' });
        drop.style.cssText = [
            'position:absolute', 'z-index:1000', 'margin-top:2px',
            'min-width:' + this.inputEl.offsetWidth + 'px',
            'max-height:200px', 'overflow-y:auto',
            'background:var(--background-secondary)',
            'border:1px solid var(--background-modifier-border)',
            'border-radius:6px', 'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
        ].join(';');

        for (const path of matches) {
            const item = drop.createDiv({ text: path });
            item.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap';
            item.addEventListener('mouseenter', () => item.style.background = 'var(--background-modifier-hover)');
            item.addEventListener('mouseleave', () => item.style.background = '');
            // mousedown (not click) so it fires before the input's blur closes the list.
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.setValue(path);
                this.fireChange();
                this.closeDropdown();
            });
        }
        this.dropdownEl = drop;
    }

    private scheduleClose() { window.setTimeout(() => this.closeDropdown(), 150); }
    private closeDropdown() { this.dropdownEl?.remove(); this.dropdownEl = null; }
}

// ════════════════════════════════════════════════════════════════
// 🆕 Helper: return the correct default OCR prompt based on current settings
// ════════════════════════════════════════════════════════════════
function getDefaultOcrPrompt(ocrSettings: OcrProviderSettings): string {
    // Ollama / small models: use strictness‑specific prompts
    if (ocrSettings.provider === 'ollama') {
        if (ocrSettings.jsonStrictness === 'lenient') {
            return OLLAMA_OCR_PROMPT_LENIENT;
        } else if (ocrSettings.jsonStrictness === 'repair-friendly') {
            return OLLAMA_OCR_PROMPT_REPAIR_FRIENDLY;
        }
        // fallback for 'strict' or undefined
    }
    
    // All other providers or Ollama in strict mode: use standard prompts
    if (ocrSettings.inputMode === 'filepath') {
        return DEFAULT_OCR_FILEPATH_PROMPT;
    }
    return DEFAULT_OCR_PROMPT;
}

// === Settings Tab Implementation ===
export default class OpenRouterSettingsTab extends PluginSettingTab {
    plugin: OpenRouterTranslatorPlugin;

    // Stage 0.4 (Q19): debounced requestDisplay() to prevent ~200ms flicker
    // on every setting change. The previous code called `this.display()`
    // synchronously inside every `onChange` handler, which rebuilds the
    // entire settings DOM. With 7+ such call sites, rapid changes (e.g.
    // typing in an API key field, sliding a slider) caused visible flicker.
    // The debounced version coalesces multiple changes within a 100ms
    // window into a single rebuild.
    //
    // REGRESSION FIX: previously used `super.display()` which calls
    // `PluginSettingTab.display()` — an abstract method with NO runtime
    // implementation. This caused "display is not a function" errors and
    // broke presets + level cards. Now calls `this.display()` which is
    // the actual rendering method defined below.
    private debouncedDisplay = debounce(() => this.display(), 100, true);

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Stage 0.4 (Q19): debounced display for use inside `onChange` handlers.
     * Multiple rapid calls within 100ms coalesce into a single rebuild.
     */
    requestDisplay(): void {
        this.debouncedDisplay();
    }

    /**
     * Stage 0.4 (Q19): immediate (non-debounced) display, for cases where
     * the rebuild must happen synchronously. Cancels any pending debounced
     * display first.
     */
    requestDisplayNow(): void {
        this.debouncedDisplay.cancel?.();
        this.display();
    }

    // ════════════════════════════════════════════════════════════════
    // Progressive Disclosure helpers
    // ════════════════════════════════════════════════════════════════

    private static LEVEL_ORDER: Record<string, number> = {
        quick: 0,
        standard: 1,
        advanced: 2,
    };

    private currentLevel(): 'quick' | 'standard' | 'advanced' {
        return this.plugin.settings.settingsLevel || 'standard';
    }

    private shouldShow(minLevel: 'quick' | 'standard' | 'advanced'): boolean {
        return OpenRouterSettingsTab.LEVEL_ORDER[this.currentLevel()] >= OpenRouterSettingsTab.LEVEL_ORDER[minLevel];
    }

    /**
     * Creates a section group container with a titled heading if the current
     * level is high enough. Returns the container element to append settings
     * to, or null if the section should be hidden.
     */
    private sectionGroup(
        containerEl: HTMLElement,
        titleKey: string,
        minLevel: 'quick' | 'standard' | 'advanced',
    ): HTMLElement | null {
        if (!this.shouldShow(minLevel)) return null;
        const group = containerEl.createDiv({ cls: 'pdf-translate-section-group' });
        const title = group.createDiv({ cls: 'pdf-translate-group-title' });
        title.createSpan({ cls: 'pdf-translate-group-dot' });
        title.appendText(t(titleKey));
        if (minLevel === 'advanced') {
            title.createSpan({ text: t('level.badge.advanced'), cls: 'pdf-translate-level-badge advanced' });
        }
        return group;
    }

    /**
     * Renders the 3 level cards at the top of the settings page.
     */
    private renderLevelCards(containerEl: HTMLElement): void {
        const cardsEl = containerEl.createDiv({ cls: 'pdf-translate-level-cards' });
        const levels: Array<{ id: 'quick' | 'standard' | 'advanced'; nameKey: string; descKey: string; countKey: string }> = [
            { id: 'quick', nameKey: 'level.quick.name', descKey: 'level.quick.desc', countKey: 'level.quick.count' },
            { id: 'standard', nameKey: 'level.standard.name', descKey: 'level.standard.desc', countKey: 'level.standard.count' },
            { id: 'advanced', nameKey: 'level.advanced.name', descKey: 'level.advanced.desc', countKey: 'level.advanced.count' },
        ];
        const current = this.currentLevel();
        for (const lvl of levels) {
            const card = cardsEl.createDiv({ cls: 'pdf-translate-level-card' + (lvl.id === current ? ' active' : '') });
            card.createDiv({ text: t(lvl.nameKey), cls: 'pdf-translate-level-name' });
            card.createDiv({ text: t(lvl.descKey), cls: 'pdf-translate-level-desc' });
            card.createDiv({ text: t(lvl.countKey), cls: 'pdf-translate-level-count' });
            card.addEventListener('click', async () => {
                this.plugin.settings.settingsLevel = lvl.id;
                await this.plugin.saveSettings();
                this.requestDisplay();
            });
        }
    }

    /**
     * Renders the Prompts warning box — tells users they can edit prompt
     * content for their domain but must NOT change output structure markers.
     */
    private renderPromptsWarning(containerEl: HTMLElement): void {
        const box = containerEl.createDiv({ cls: 'pdf-translate-warning-box' });
        box.createEl('p', { text: t('prompts.warning.title') }).style.fontWeight = '600';
        box.createEl('p', { text: t('prompts.warning.body') });

        const list = box.createEl('ul');
        list.style.margin = '6px 0 6px 20px';
        list.createEl('li').innerHTML = `<code>{sourceLang}</code>, <code>{targetLang}</code>, <code>{lineCount}</code>, <code>{inputText}</code> — ${t('prompts.warning.placeholders')}`;
        list.createEl('li').innerHTML = `<code>[#N]</code> — ${t('prompts.warning.numbering')}`;
        list.createEl('li').innerHTML = `<code>N. Translated text</code> — ${t('prompts.warning.format')}`;

        const consequence = box.createEl('p');
        consequence.createEl('strong', { text: t('prompts.warning.consequence') });
    }

    // ════════════════════════════════════════════════════════════════
    // Main display — restructured for Progressive Disclosure
    // ════════════════════════════════════════════════════════════════

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ─── Page header ───
        const header = containerEl.createDiv({ cls: 'pdf-translate-settings-header' });
        header.createEl('h2', { text: t('settings.page.title') });
        header.createEl('p', { text: t('settings.page.desc') });

        // ─── Level cards (Quick / Standard / Advanced) ───
        this.renderLevelCards(containerEl);

        // ════════════════════════════════════════════════════════════════
        // SECTION: Provider (quick+)
        // ════════════════════════════════════════════════════════════════
        {
            const group = this.sectionGroup(containerEl, 'section.provider', 'quick');
            if (group) {
                // --- API PROVIDER SELECTION ---
                new Setting(group)
                    .setName(t('provider.dropdown.name'))
                    .setDesc(t('provider.dropdown.desc'))
                    .addDropdown(dd => {
                        const groups: Array<{ label: string; cat: 'cloud' | 'local' | 'custom' }> = [
                            { label: t('provider.dropdown.group.cloud'), cat: 'cloud' },
                            { label: t('provider.dropdown.group.local'), cat: 'local' },
                            { label: t('provider.dropdown.group.custom'), cat: 'custom' },
                        ];
                        for (const g of groups) {
                            const optgroup = dd.selectEl.createEl('optgroup');
                            optgroup.label = g.label;
                            for (const p of ALL_PROVIDERS) {
                                if (p.category !== g.cat) continue;
                                optgroup.createEl('option', { value: p.id, text: p.label });
                            }
                        }
                        dd.setValue(this.plugin.settings.apiProvider);
                        dd.onChange(async (value: any) => {
                            this.plugin.settings.apiProvider = value;
                            await this.plugin.saveSettings();
                            this.requestDisplay();
                        });
                    });

                // --- PROVIDER-SPECIFIC SETTINGS ---
                const provider = this.plugin.settings.apiProvider;
                const def = getProvider(provider);
                if (!def) {
                    group.createEl('p', {
                        text: t('provider.dropdown.unknown', { provider }),
                        cls: 'setting-item-description',
                    });
                } else {
                    if (!this.plugin.settings.providerSettings[provider]) {
                        this.plugin.settings.providerSettings[provider] = {};
                    }
                    const providerSettings = this.plugin.settings.providerSettings[provider] as any;
                    this.renderProviderBlock(group, def, providerSettings);
                }
            }
        }

        // ════════════════════════════════════════════════════════════════
        // SECTION: Language (quick+) — Stage 1.3 (Q18)
        // ════════════════════════════════════════════════════════════════
        // Previously Language settings were buried inside the Translation
        // section on `standard` level — new users with `quick` level
        // couldn't change the target language and were stuck with the
        // default 'en'. Per Q18, Language + Batch toggle now live on
        // `quick` level so a new user can: pick provider → pick languages
        // → enable batch → start translating, all without elevating to
        // `standard`.
        {
            const group = this.sectionGroup(containerEl, 'section.language', 'quick');
            if (group) {
                new Setting(group)
                    .setName(t('general.language.source'))
                    .addDropdown(dd => {
                        AVAILABLE_LANGUAGES.forEach(lang => dd.addOption(lang.code, lang.name));
                        dd.setValue(this.plugin.settings.sourceLanguage).onChange(async v => {
                            this.plugin.settings.sourceLanguage = v; await this.plugin.saveSettings();
                        });
                    });

                new Setting(group)
                    .setName(t('general.language.target'))
                    .addDropdown(dd => {
                        AVAILABLE_LANGUAGES.forEach(lang => dd.addOption(lang.code, lang.name));
                        dd.setValue(this.plugin.settings.targetLanguage).onChange(async v => {
                            this.plugin.settings.targetLanguage = v; await this.plugin.saveSettings();
                        });
                    });

                new Setting(group)
                    .setName(t('general.translation.batch.label'))
                    .setDesc(t('general.translation.batch.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.useBatchTranslation).onChange(async v => {
                        this.plugin.settings.useBatchTranslation = v; await this.plugin.saveSettings();
                    }));
            }
        }

        // ════════════════════════════════════════════════════════════════
        // SECTION: Translation (standard+)
        // ════════════════════════════════════════════════════════════════
        // Stage 1.3 (Q18): Language settings + Batch toggle moved to the
        // new Language section above (quick+). This section now contains
        // only advanced translation settings (concurrency, maxBatchChars,
        // sequentialDelayMs, prompts).
        {
            const group = this.sectionGroup(containerEl, 'section.translation', 'standard');
            if (group) {
                // Advanced-only translation settings
                if (this.shouldShow('advanced')) {
                    // REMOVED (v5 cleanup): 'enableSemanticMerging' toggle —
                    // the setting is declared but no code reads it. The
                    // worker pipeline does its own paragraph grouping via
                    // PdfTextExtractor.extractPage (IslandBuilder), and
                    // processing.ts explicitly says "No post-processing:
                    // no semantic merging, no sentence re-flow."

                    new Setting(group)
                        .setName(t('general.translation.concurrency.label'))
                        .setDesc(t('general.translation.concurrency.desc'))
                        .addSlider(s => s
                            .setLimits(1, 8, 1)
                            .setValue(this.plugin.settings.backgroundTranslationConcurrency)
                            .setDynamicTooltip()
                            .onChange(async v => {
                                this.plugin.settings.backgroundTranslationConcurrency = v;
                                await this.plugin.saveSettings();
                            }));

                    new Setting(group)
                        .setName(t('general.translation.maxbatch.label'))
                        .setDesc(t('general.translation.maxbatch.desc'))
                        .addText(txt => txt
                            .setValue(String(this.plugin.settings.maxBatchChars))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n > 0) {
                                    this.plugin.settings.maxBatchChars = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('general.translation.delay.label'))
                        .setDesc(t('general.translation.delay.desc'))
                        .addText(txt => txt
                            .setValue(String(this.plugin.settings.sequentialDelayMs))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n >= 0) {
                                    this.plugin.settings.sequentialDelayMs = n;
                                    await this.plugin.saveSettings();
                                }
                            }));
                }
            }
        }

        // ════════════════════════════════════════════════════════════════
        // SECTION: Storage (standard+)
        // ════════════════════════════════════════════════════════════════
        {
            const group = this.sectionGroup(containerEl, 'section.storage', 'standard');
            if (group) {
                // Storage Location
                new Setting(group)
                    .setName(t('general.storage.label'))
                    .setDesc(t('general.storage.desc'))
                    .then(setting => {
                        setting.controlEl.style.position = 'relative';
                        const folderSuggest = new FolderSuggest(this.app, setting.controlEl);
                        folderSuggest.setValue(this.plugin.settings.storageLocation);
                        folderSuggest.onChange(async (value) => {
                            this.plugin.settings.storageLocation = value;
                            await this.plugin.saveSettings();
                        });
                    });

                // Auto Save
                new Setting(group)
                    .setName(t('general.autosave.label'))
                    .setDesc(t('general.autosave.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.autoSaveOverlay).onChange(async v => {
                        this.plugin.settings.autoSaveOverlay = v; await this.plugin.saveSettings();
                    }));

                // REMOVED (v5 cleanup): dead settings that were rendered but never read:
                //   - autoRefreshOverlay (no code reads it)
                //   - useIndividualMarkdownStorage (no code reads it)
                //   - indexFilePath (no code reads it; always hardcoded 'Index.md')
                // These were leftover from past versions. The worker pipeline
                // always saves per-page via updatePageOverlaysAndWrite and
                // auto-refreshes the overlay via updateCacheFromWrite.
            }
        }

        // ════════════════════════════════════════════════════════════════
        // SECTION: Prompts (standard+) — WITH WARNING
        // ════════════════════════════════════════════════════════════════
        {
            const group = this.sectionGroup(containerEl, 'section.prompts', 'standard');
            if (group) {
                // ⚠️ Warning: don't change output structure markers
                this.renderPromptsWarning(group);

                // Use Custom Template toggle
                new Setting(group)
                    .setName(t('prompts.special.label'))
                    .setDesc(t('prompts.special.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.useGemmaPrompt).onChange(async v => {
                        this.plugin.settings.useGemmaPrompt = v;
                        await this.plugin.saveSettings();
                        this.requestDisplay();
                    }));

                if (this.plugin.settings.useGemmaPrompt) {
                    new Setting(group)
                        .setName(t('prompts.special.template.label'))
                        .setDesc(t('prompts.special.template.desc'))
                        .then(setting => {
                            setting.controlEl.style.flexDirection = 'column';
                            setting.controlEl.style.alignItems = 'flex-end';
                            const textarea = new TextAreaComponent(setting.controlEl)
                                .setValue(this.plugin.settings.customTemplate || DEFAULT_CUSTOM_TEMPLATE)
                                .onChange(async v => { this.plugin.settings.customTemplate = v; await this.plugin.saveSettings(); });
                            textarea.inputEl.style.width = '100%';
                            textarea.inputEl.rows = 8;
                            textarea.inputEl.style.fontFamily = 'monospace';
                            textarea.inputEl.style.fontSize = '12px';
                            new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                                this.plugin.settings.customTemplate = DEFAULT_CUSTOM_TEMPLATE;
                                await this.plugin.saveSettings();
                                textarea.setValue(DEFAULT_CUSTOM_TEMPLATE);
                            }).buttonEl.style.marginTop = '8px';
                        });
                } else {
                    new Setting(group)
                        .setName(t('prompts.batch.label'))
                        .setDesc(t('prompts.batch.desc'))
                        .then(setting => {
                            setting.controlEl.style.flexDirection = 'column';
                            setting.controlEl.style.alignItems = 'flex-end';
                            const textarea = new TextAreaComponent(setting.controlEl)
                                .setValue(this.plugin.settings.batchPrompt).onChange(async v => { this.plugin.settings.batchPrompt = v; await this.plugin.saveSettings(); });
                            textarea.inputEl.style.width = '100%';
                            textarea.inputEl.rows = 8;
                            new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                                this.plugin.settings.batchPrompt = DEFAULT_SETTINGS.batchPrompt;
                                await this.plugin.saveSettings();
                                textarea.setValue(DEFAULT_SETTINGS.batchPrompt);
                            }).buttonEl.style.marginTop = '8px';
                        });

                    new Setting(group)
                        .setName(t('prompts.single.label'))
                        .setDesc(t('prompts.single.desc'))
                        .then(setting => {
                            setting.controlEl.style.flexDirection = 'column';
                            setting.controlEl.style.alignItems = 'flex-end';
                            const textarea = new TextAreaComponent(setting.controlEl)
                                .setValue(this.plugin.settings.singlePrompt).onChange(async v => { this.plugin.settings.singlePrompt = v; await this.plugin.saveSettings(); });
                            textarea.inputEl.style.width = '100%';
                            textarea.inputEl.rows = 4;
                            new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                                this.plugin.settings.singlePrompt = DEFAULT_SETTINGS.singlePrompt;
                                await this.plugin.saveSettings();
                                textarea.setValue(DEFAULT_SETTINGS.singlePrompt);
                            }).buttonEl.style.marginTop = '8px';
                        });
                }
            }
        }

        // ═══ SECTION: Visual (standard+) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.visual', 'standard');
            if (group) {
                new Setting(group)
                    .setName(t('visual.fontscale.label'))
                    .addSlider(s => s.setLimits(0.4, 1.2, 0.05).setValue(this.plugin.settings.outputFontSizeScale).setDynamicTooltip().onChange(async v => { this.plugin.settings.outputFontSizeScale = v; await this.plugin.saveSettings(); }));

                new Setting(group)
                    .setName(t('visual.opacity.label'))
                    .setDesc(t('visual.opacity.desc'))
                    .addSlider(s => s.setLimits(0.1, 1.0, 0.05).setValue(this.plugin.settings.overlayOpacity).setDynamicTooltip().onChange(async v => {
                        const snapped = Math.round(v * 100) / 100;
                        this.plugin.settings.overlayOpacity = snapped;
                        await this.plugin.saveSettings();
                        this.plugin.overlay.updateAllOverlayVisibility();
                    }));

                if (this.shouldShow('advanced')) {
                    new Setting(group)
                        .setName(t('visual.lineheight.label'))
                        .addSlider(s => s.setLimits(0.5, 2.0, 0.05).setValue(this.plugin.settings.outputLineHeight).setDynamicTooltip().onChange(async v => { this.plugin.settings.outputLineHeight = v; await this.plugin.saveSettings(); }));

                    new Setting(group)
                        .setName(t('visual.preservebreaks.label'))
                        .setDesc(t('visual.preservebreaks.desc'))
                        .addToggle(toggle => toggle
                            .setValue(this.plugin.settings.preserveSourceLineBreaks ?? false)
                            .onChange(async v => { this.plugin.settings.preserveSourceLineBreaks = v; await this.plugin.saveSettings(); }));
                }
            }
        }

        // ═══ SECTION: Layout Engine (standard+) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.layout', 'standard');
            if (group) {
                new Setting(group)
                    .setName(t('engine.dropdown.label'))
                    .setDesc(t('engine.dropdown.desc'))
                    .addDropdown(dd => {
                        dd.addOption('internal', t('engine.opt.internal'));
                        // Phase 6: Python layout engine uses Node's child_process
                        // via external-layout.ts, so it cannot run on mobile.
                        if (Platform.isDesktop) {
                            dd.addOption('python', t('engine.opt.python'));
                        }
                        dd.setValue(this.plugin.settings.layoutEngine === 'python' && Platform.isDesktop ? 'python' : 'internal')
                          .onChange(async (value: any) => { this.plugin.settings.layoutEngine = value; await this.plugin.saveSettings(); this.requestDisplay(); });
                    });

                // Phase 6: hide the Python sub-section entirely on mobile.
                // Even if a legacy config has layoutEngine === 'python', the
                // sub-section's install button uses Node-only APIs and the
                // engine itself cannot run on mobile, so showing the settings
                // would be misleading.
                if (this.plugin.settings.layoutEngine === 'python' && Platform.isDesktop) {
                    new Setting(group)
                        .setName(t('engine.python.path.label'))
                        .setDesc(t('engine.python.path.desc'))
                        .addText(text => text.setPlaceholder('python').setValue(this.plugin.settings.pythonPath).onChange(async (value) => { this.plugin.settings.pythonPath = value; await this.plugin.saveSettings(); }));

                    new Setting(group)
                        .setName(t('engine.python.script.label'))
                        .setDesc(t('engine.python.script.desc'))
                        .addText(text => text.setPlaceholder('/path/to/layout_engine.py').setValue(this.plugin.settings.ocrScriptPath).onChange(async (value) => { this.plugin.settings.ocrScriptPath = value; await this.plugin.saveSettings(); }));

                    if (Platform.isDesktop) {
                        const installSetting = new Setting(group).setName(t('engine.python.install.label')).setDesc(t('engine.python.install.desc'));
                        installSetting.addButton(btn => btn.setButtonText(t('engine.python.install.btn')).setCta().onClick(async () => {
                            btn.setDisabled(true).setButtonText(t('engine.python.install.btn.progress'));
                            const result = await installPythonScripts(this.plugin, { overwrite: true });
                            btn.setDisabled(false).setButtonText(t('engine.python.install.btn'));
                            if (result) this.requestDisplay();
                        }));
                    }
                }

                // Stage 2.2 (Q6): 6 layout settings for the contour pipeline.
                // Advanced-only — these are tuning parameters for power users.
                if (this.shouldShow('advanced')) {
                    group.createEl('h4', { text: t('settings.layout.advanced.heading') });
                    group.createEl('p', {
                        text: t('settings.layout.advanced.intro'),
                        cls: 'setting-item-description',
                    });

                    const ls = this.plugin.layoutSettings;

                    new Setting(group)
                        .setName(t('settings.layout.cellSize.name'))
                        .setDesc(t('settings.layout.cellSize.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.cellSize.placeholder'))
                            .setValue(String(ls.contourCellSize))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n > 0) {
                                    ls.contourCellSize = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('settings.layout.indentThreshold.name'))
                        .setDesc(t('settings.layout.indentThreshold.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.indentThreshold.placeholder'))
                            .setValue(String(ls.contourIndentThreshold))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n >= 0) {
                                    ls.contourIndentThreshold = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('settings.layout.fontSizeTolerance.name'))
                        .setDesc(t('settings.layout.fontSizeTolerance.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.fontSizeTolerance.placeholder'))
                            .setValue(String(ls.contourFontSizeTolerance))
                            .onChange(async v => {
                                const n = parseFloat(v);
                                if (Number.isFinite(n) && n >= 0) {
                                    ls.contourFontSizeTolerance = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('settings.layout.columnGapThreshold.name'))
                        .setDesc(t('settings.layout.columnGapThreshold.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.columnGapThreshold.placeholder'))
                            .setValue(String(ls.columnGapThreshold))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n > 0) {
                                    ls.columnGapThreshold = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('settings.layout.decorationThreshold.name'))
                        .setDesc(t('settings.layout.decorationThreshold.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.decorationThreshold.placeholder'))
                            .setValue(String(ls.decorationThreshold))
                            .onChange(async v => {
                                const n = parseFloat(v);
                                if (Number.isFinite(n) && n > 0 && n < 1) {
                                    ls.decorationThreshold = n;
                                    await this.plugin.saveSettings();
                                }
                            }));

                    new Setting(group)
                        .setName(t('settings.layout.maxMergePasses.name'))
                        .setDesc(t('settings.layout.maxMergePasses.desc'))
                        .addText(text => text
                            .setPlaceholder(t('settings.layout.maxMergePasses.placeholder'))
                            .setValue(String(ls.maxMergePasses))
                            .onChange(async v => {
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n) && n > 0) {
                                    ls.maxMergePasses = n;
                                    await this.plugin.saveSettings();
                                }
                            }));
                }
            }
        }

        // ═══ SECTION: Watcher (advanced only) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.watcher', 'advanced');
            if (group) {
                new Setting(group)
                    .setName(t('watcher.enable.label'))
                    .setDesc(t('watcher.enable.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.watcherEnabled).onChange(async v => {
                        this.plugin.settings.watcherEnabled = v; await this.plugin.saveSettings();
                        if (v) this.plugin.watcher.start(); else this.plugin.watcher.stop();
                    }));

                new Setting(group)
                    .setName(t('watcher.folder.label'))
                    .setDesc(t('watcher.folder.desc'))
                    .then(setting => {
                        setting.controlEl.style.position = 'relative';
                        const fs = new FolderSuggest(this.app, setting.controlEl);
                        fs.setValue(this.plugin.settings.watcherFolder || '');
                        fs.onChange(async (value) => {
                            this.plugin.settings.watcherFolder = value.trim();
                            await this.plugin.saveSettings();
                            if (this.plugin.settings.watcherEnabled) this.plugin.watcher.start();
                        });
                    });

                new Setting(group)
                    .setName(t('watcher.queue.label'))
                    .setDesc(t('watcher.queue.desc'))
                    .addButton(b => b.setButtonText(t('watcher.queue.btn.open')).onClick(() => { new WatcherQueueModal(this.app, this.plugin).open(); }))
                    .addButton(b => b.setButtonText(t('watcher.queue.btn.scan')).onClick(async () => {
                        const n = await this.plugin.watcher.scanExisting();
                        new Notice(n > 0 ? t('modal.watcher.scan.found', {n}) : t('modal.watcher.scan.none'));
                    }));
            }
        }

        // ═══ SECTION: OCR (advanced only) ═══
        if (this.shouldShow('advanced')) {
            const ocrGroup = this.sectionGroup(containerEl, 'section.ocr', 'advanced');
            if (ocrGroup) {
                const ocrSettings = this.plugin.settings.ocrProvider;

                // OCR Provider dropdown
                new Setting(ocrGroup)
                    .setName(t('ocr.dropdown.name'))
                    .setDesc(t('ocr.dropdown.desc'))
                    .addDropdown(dd => {
                        const groups: Array<{ label: string; cat: 'cloud' | 'local' | 'custom' }> = [
                            { label: t('ocr.dropdown.group.cloud'), cat: 'cloud' },
                            { label: t('ocr.dropdown.group.local'), cat: 'local' },
                            { label: t('ocr.dropdown.group.custom'), cat: 'custom' },
                        ];
                        for (const g of groups) {
                            const optgroup = dd.selectEl.createEl('optgroup');
                            optgroup.label = g.label;
                            for (const p of ALL_PROVIDERS) {
                                if (p.category !== g.cat) continue;
                                if (!p.supportsVision && p.protocol !== 'custom') continue;
                                optgroup.createEl('option', { value: p.id, text: p.label });
                            }
                        }
                        const savedOcrProvider = ocrSettings.provider;
                        const ocrDef = getProvider(savedOcrProvider);
                        if (!ocrDef || (!ocrDef.supportsVision && ocrDef.protocol !== 'custom')) {
                            ocrSettings.provider = 'openrouter';
                        }
                        dd.setValue(ocrSettings.provider);
                        dd.onChange(async (value: any) => {
                            ocrSettings.provider = value;
                            const newDef = getProvider(value);
                            ocrSettings.model = newDef?.defaultModel || '';
                            await this.plugin.saveSettings();
                            this.requestDisplay();
                        });
                    });

                // OCR provider-specific fields
                const ocrDef = getProvider(ocrSettings.provider);
                if (ocrDef) {
                    const ocrPsView: any = {
                        get apiKey() { return ocrSettings.apiKey; }, set apiKey(v) { ocrSettings.apiKey = v; },
                        get model() { return ocrSettings.model; }, set model(v) { ocrSettings.model = v; },
                        get apiEndpoint() { return ocrSettings.apiEndpoint; }, set apiEndpoint(v) { ocrSettings.apiEndpoint = v; },
                        get headers() { return ocrSettings.headers; }, set headers(v) { ocrSettings.headers = v; },
                        get requestBody() { return ocrSettings.requestBody; }, set requestBody(v) { ocrSettings.requestBody = v; },
                        get responsePath() { return ocrSettings.responseJsonPath; }, set responsePath(v) { ocrSettings.responseJsonPath = v; },
                        get temperature() { return ocrSettings.temperature; }, set temperature(v) { ocrSettings.temperature = v; },
                        enableReasoning: false,
                    };
                    this.renderOcrProviderBlock(ocrGroup, ocrDef, ocrSettings, ocrPsView);
                }

                // OCR Temperature
                new Setting(ocrGroup)
                    .setName(t('ocr.temperature.label'))
                    .setDesc(t('ocr.temperature.desc'))
                    .addSlider(s => s.setLimits(0, 1, 0.05).setValue(ocrSettings.temperature ?? 0.1).setDynamicTooltip().onChange(async v => { ocrSettings.temperature = v; await this.plugin.saveSettings(); }));

                // Max Tokens
                new Setting(ocrGroup)
                    .setName(t('ocr.maxtokens.label'))
                    .setDesc(t('ocr.maxtokens.desc'))
                    .addSlider(s => s.setLimits(1024, 32768, 1024).setValue(ocrSettings.maxTokens ?? 8192).setDynamicTooltip().onChange(async v => { ocrSettings.maxTokens = v; await this.plugin.saveSettings(); }));

                // JSON Strictness (for ollama / local)
                if (ocrSettings.provider === 'ollama' || ocrSettings.provider === 'lmstudio' || ocrSettings.provider === 'vllm') {
                    new Setting(ocrGroup)
                        .setName(t('ocr.jsonstrict.label'))
                        .setDesc(t('ocr.jsonstrict.desc'))
                        .addDropdown(dd => {
                            dd.addOption('strict', t('ocr.jsonstrict.strict'))
                              .addOption('lenient', t('ocr.jsonstrict.lenient'))
                              .addOption('repair-friendly', t('ocr.jsonstrict.repair'))
                              .setValue(ocrSettings.jsonStrictness || 'strict')
                              .onChange(async v => { ocrSettings.jsonStrictness = v as any; await this.plugin.saveSettings(); });
                        });
                }

                // OCR Output section
                new Setting(ocrGroup)
                    .setName(t('ocr.output.mode.label'))
                    .setDesc(t('ocr.output.mode.desc'))
                    .addDropdown(dd => {
                        dd.addOption('translation-note', t('ocr.output.mode.note'))
                          .setValue(ocrSettings.ocrOutputMode || 'translation-note')
                          .onChange(async v => { ocrSettings.ocrOutputMode = v as any; await this.plugin.saveSettings(); });
                    });

                new Setting(ocrGroup)
                    .setName(t('ocr.output.folder.label'))
                    .setDesc(t('ocr.output.folder.desc'))
                    .then(setting => {
                        setting.controlEl.style.position = 'relative';
                        const fs = new FolderSuggest(this.app, setting.controlEl);
                        fs.setValue(ocrSettings.ocrOutputFolder || '');
                        fs.onChange(async (value) => { ocrSettings.ocrOutputFolder = value.trim(); await this.plugin.saveSettings(); });
                    });

                // ════════════════════════════════════════════════════════════════
                // Phase 5 (N7): Advanced OCR settings — collapsed <details>.
                // These are power-user tuning knobs (image capture format,
                // scale, per-mode prompt templates, filename pattern, etc.).
                // Hidden by default to avoid overwhelming the basic OCR user.
                // ════════════════════════════════════════════════════════════════
                const advancedOcrDetails = ocrGroup.createEl('details');
                advancedOcrDetails.createEl('summary').setText(t('settings.ocr.advanced.title'));

                // inputMode dropdown — image (base64) vs file path
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.inputMode.name'))
                    .setDesc(t('settings.ocr.advanced.inputMode.desc'))
                    .addDropdown(dd => {
                        dd.addOption('image', 'Image (base64)')
                          .addOption('filepath', 'File path')
                          .setValue(ocrSettings.inputMode || 'image')
                          .onChange(async v => { ocrSettings.inputMode = v as any; await this.plugin.saveSettings(); });
                    });

                // imageScale slider — screenshot capture scale
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.imageScale.name'))
                    .setDesc(t('settings.ocr.advanced.imageScale.desc'))
                    .addSlider(sl => {
                        sl.setLimits(1.0, 3.0, 0.1)
                          .setValue(ocrSettings.imageScale || 2.0)
                          .setDynamicTooltip()
                          .onChange(async v => { ocrSettings.imageScale = v; await this.plugin.saveSettings(); });
                    });

                // imageFormat dropdown — PNG vs JPEG
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.imageFormat.name'))
                    .setDesc(t('settings.ocr.advanced.imageFormat.desc'))
                    .addDropdown(dd => {
                        dd.addOption('png', 'PNG')
                          .addOption('jpeg', 'JPEG')
                          .setValue(ocrSettings.imageFormat || 'png')
                          .onChange(async v => { ocrSettings.imageFormat = v as any; await this.plugin.saveSettings(); });
                    });

                // imageQuality slider — only meaningful for JPEG
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.imageQuality.name'))
                    .setDesc(t('settings.ocr.advanced.imageQuality.desc'))
                    .addSlider(sl => {
                        sl.setLimits(0.5, 1.0, 0.05)
                          .setValue(ocrSettings.imageQuality || 0.92)
                          .setDynamicTooltip()
                          .onChange(async v => { ocrSettings.imageQuality = v; await this.plugin.saveSettings(); });
                    });

                // ocrPromptTemplate textarea — single-page JSON+bbox prompt
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.ocrPromptTemplate.name'))
                    .setDesc(t('settings.ocr.advanced.ocrPromptTemplate.desc'))
                    .addTextArea(ta => {
                        ta.setValue(ocrSettings.ocrPromptTemplate || '')
                          .onChange(async v => { ocrSettings.ocrPromptTemplate = v; await this.plugin.saveSettings(); });
                        ta.inputEl.rows = 6;
                        ta.inputEl.style.width = '100%';
                        ta.inputEl.style.fontFamily = 'monospace';
                        ta.inputEl.style.fontSize = '11px';
                    });

                // ocrTextPromptTemplate textarea — transcription-only prompt (no JSON/bboxes)
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.ocrTextPromptTemplate.name'))
                    .setDesc(t('settings.ocr.advanced.ocrTextPromptTemplate.desc'))
                    .addTextArea(ta => {
                        ta.setValue(ocrSettings.ocrTextPromptTemplate || '')
                          .onChange(async v => { ocrSettings.ocrTextPromptTemplate = v; await this.plugin.saveSettings(); });
                        ta.inputEl.rows = 6;
                        ta.inputEl.style.width = '100%';
                        ta.inputEl.style.fontFamily = 'monospace';
                        ta.inputEl.style.fontSize = '11px';
                    });

                // responseFormatInstruction textarea — extra JSON formatting hints
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.responseFormatInstruction.name'))
                    .setDesc(t('settings.ocr.advanced.responseFormatInstruction.desc'))
                    .addTextArea(ta => {
                        ta.setValue(ocrSettings.responseFormatInstruction || '')
                          .onChange(async v => { ocrSettings.responseFormatInstruction = v; await this.plugin.saveSettings(); });
                        ta.inputEl.rows = 4;
                        ta.inputEl.style.width = '100%';
                        ta.inputEl.style.fontFamily = 'monospace';
                        ta.inputEl.style.fontSize = '11px';
                    });

                // ocrOutputFilenamePattern text — template for output filename
                new Setting(advancedOcrDetails)
                    .setName(t('settings.ocr.advanced.ocrOutputFilenamePattern.name'))
                    .setDesc(t('settings.ocr.advanced.ocrOutputFilenamePattern.desc'))
                    .addText(text => {
                        text.setPlaceholder('{pdfname}.translated')
                            .setValue(ocrSettings.ocrOutputFilenamePattern || '')
                            .onChange(async v => { ocrSettings.ocrOutputFilenamePattern = v; await this.plugin.saveSettings(); });
                    });
            }
        }

        // ═══ SECTION: PDF Export (advanced only) ═══
        // Stage 0.1 (Q17): removed the entire PDF Export section — all 4
        // settings (exportTextColor, exportTextOpacity, exportFontSizeScale,
        // exportAsAnnotation) were write-only: set by this UI but never
        // read by `pdf-export.ts` or any other module. The actual export
        // colors/fonts are hardcoded in `pdf_export.py` (Python script).
        // If we ever need to expose them again, re-add here AND wire them
        // through to the Python script via the merge JSON payload.
        {
            const group = this.sectionGroup(containerEl, 'section.export', 'advanced');
            if (group) {
                group.createEl('p', {
                    text: t('settings.export.note'),
                    cls: 'setting-item-description',
                });
            }
        }

        // ═══ SECTION: UI Behavior (advanced only) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.ui', 'advanced');
            if (group) {
                new Setting(group)
                    .setName(t('ui.showbydefault.label'))
                    .setDesc(t('ui.showbydefault.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.showOverlayByDefault).onChange(async v => { this.plugin.settings.showOverlayByDefault = v; await this.plugin.saveSettings(); }));

                new Setting(group)
                    .setName(t('ui.bboxedit.label'))
                    .setDesc(t('ui.bboxedit.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.bboxEditMode).onChange(async v => { this.plugin.settings.bboxEditMode = v; await this.plugin.saveSettings(); }));

                // REMOVED (v5 cleanup): 'clickToShowMode' and 'manualRefinementMode'
                // toggles. Both settings are declared but no code reads them —
                // they were leftover from past versions. The overlay visibility
                // is controlled by 'showOverlayByDefault' + the toggle command;
                // manual refinement is always available via bbox edit mode.
            }
        }

        // ═══ SECTION: Copy Formats (advanced only) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.copyFormats', 'advanced');
            if (group) {
                const createFormatSetting = (name: string, settingKey: 'calloutFormat' | 'citationFormat' | 'footnoteFormat') => {
                    new Setting(group)
                        .setName(name)
                        .addTextArea(ta => {
                            ta.setValue(this.plugin.settings[settingKey] || '').onChange(async v => {
                                (this.plugin.settings as any)[settingKey] = v;
                                await this.plugin.saveSettings();
                            });
                            ta.inputEl.rows = 2;
                            ta.inputEl.style.width = '100%';
                        });
                };
                createFormatSetting(t('export.formats.callout'), 'calloutFormat');
                createFormatSetting(t('export.formats.citation'), 'citationFormat');
                createFormatSetting(t('export.formats.footnote'), 'footnoteFormat');
            }
        }

        // ═══ SECTION: Paragraph Filter Rules (advanced only) ═══
        // Stage 2.4 (NEW): Rule-based paragraph filter. Rules are regex
        // patterns that prevent matching paragraphs from being sent to
        // the LLM — they keep their original text in the overlay.
        {
            const group = this.sectionGroup(containerEl, 'section.paragraphFilter', 'advanced');
            if (group) {
                group.createEl('p', {
                    text: t('settings.paragraphFilter.intro'),
                    cls: 'setting-item-description',
                });

                const rules = this.plugin.settings.paragraphFilterRules || [];

                // Render existing rules as a table
                for (const rule of rules) {
                    new Setting(group)
                        .setName(rule.name)
                        .setDesc(t('settings.paragraphFilter.pattern.desc', { pattern: rule.pattern }))
                        .addToggle(tg => tg
                            .setValue(rule.enabled)
                            .onChange(async v => {
                                rule.enabled = v;
                                await this.plugin.saveSettings();
                            }))
                        .addExtraButton(btn => btn
                            .setIcon('trash')
                            .setTooltip(t('settings.paragraphFilter.deleteRule.tooltip'))
                            .onClick(async () => {
                                const idx = this.plugin.settings.paragraphFilterRules.indexOf(rule);
                                if (idx >= 0) {
                                    this.plugin.settings.paragraphFilterRules.splice(idx, 1);
                                    await this.plugin.saveSettings();
                                    this.requestDisplay();
                                }
                            }));
                }

                // Add new rule button
                new Setting(group)
                    .setName(t('settings.paragraphFilter.addNew.name'))
                    .setDesc(t('settings.paragraphFilter.addNew.desc'))
                    .addButton(btn => btn
                        .setButtonText(t('settings.paragraphFilter.addNew.btn'))
                        .setCta()
                        .onClick(async () => {
                            const { generateRuleId } = await import('./paragraph-filter');
                            this.plugin.settings.paragraphFilterRules.push({
                                id: generateRuleId(),
                                name: t('settings.paragraphFilter.newRule.name'),
                                pattern: '^$',
                                enabled: false,
                            });
                            await this.plugin.saveSettings();
                            this.requestDisplay();
                        }));

                // Edit rules inline (simple text area for power users)
                new Setting(group)
                    .setName(t('settings.paragraphFilter.bulkEdit.name'))
                    .setDesc(t('settings.paragraphFilter.bulkEdit.desc'))
                    .then(setting => {
                        setting.controlEl.style.flexDirection = 'column';
                        setting.controlEl.style.alignItems = 'flex-end';
                        const ta = new TextAreaComponent(setting.controlEl);
                        ta.setValue(JSON.stringify(this.plugin.settings.paragraphFilterRules, null, 2));
                        ta.inputEl.style.width = '100%';
                        ta.inputEl.rows = 6;
                        ta.inputEl.style.fontFamily = 'monospace';
                        ta.inputEl.style.fontSize = '11px';
                        ta.onChange(async v => {
                            try {
                                const parsed = JSON.parse(v);
                                if (Array.isArray(parsed)) {
                                    this.plugin.settings.paragraphFilterRules = parsed;
                                    await this.plugin.saveSettings();
                                    new Notice(t('settings.paragraphFilter.bulkEdit.valid'), 2000);
                                }
                            } catch {
                                new Notice(t('settings.paragraphFilter.bulkEdit.invalid'), 3000);
                            }
                        });
                    });
            }
        }

        // ═══ SECTION: Advanced / Debug (advanced only) ═══
        {
            const group = this.sectionGroup(containerEl, 'section.advanced', 'advanced');
            if (group) {
                new Setting(group)
                    .setName(t('advanced.debug.label'))
                    .setDesc(t('advanced.debug.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.debugMode).onChange(async v => { this.plugin.settings.debugMode = v; await this.plugin.saveSettings(); }));

                new Setting(group)
                    .setName(t('advanced.layoutdebug.label'))
                    .setDesc(t('advanced.layoutdebug.desc'))
                    .addToggle(tg => tg.setValue(this.plugin.settings.layoutDebugMode).onChange(async v => { this.plugin.settings.layoutDebugMode = v; await this.plugin.saveSettings(); }));

                // REMOVED (v5 cleanup): 'manualRefinementMode' toggle —
                // declared but never read. Manual refinement is always
                // available via bbox edit mode + context menu actions.
            }
        }
    }

    /**
     * Fetch the model list for a provider (wraps `fetchProviderModels`
     * from the providers registry).
     *
     * Phase 13.4 (C6): for vLLM, if no model has been chosen yet, attempt
     * to auto-pick the first available model from the `/v1/models`
     * endpoint. vLLM doesn't ship a curated static model list (it serves
     * whatever the user passed to `--model`), so this avoids forcing the
     * user to manually type a model ID. The auto-fetch is best-effort:
     * any failure (network down, wrong endpoint, auth required) is logged
     * to the console but does not throw — the user can still enter a
     * model manually via the Manual Override field.
     */
    async fetchModelsFor(provider: string, ps: any): Promise<{ id: string; label: string }[]> {
        // Phase 13.4: vLLM auto-fetch the first available model when none
        // is selected. Endpoint already includes `/v1` (e.g.
        // `http://localhost:8000/v1`), so we append `/models` — NOT
        // `/v1/models` — to avoid doubling the path prefix.
        if (provider === 'vllm' && (!ps.model || ps.model === '')) {
            try {
                const endpoint = (ps.apiEndpoint || 'http://localhost:8000/v1').replace(/\/$/, '');
                const response = await requestUrl({ url: `${endpoint}/models`, method: 'GET' });
                const models = response.json?.data || [];
                if (models.length > 0) {
                    ps.model = models[0].id;
                    await this.plugin.saveSettings();
                    console.info(`vLLM: auto-selected model "${ps.model}" from ${endpoint}/models`);
                }
            } catch (e) {
                console.warn('Failed to auto-fetch vLLM models:', e);
            }
        }

        const models = await fetchProviderModels(provider, ps);
        return models.map(m => ({ id: m.id, label: m.label || m.id }));
    }

    // ════════════════════════════════════════════════════════════════
    // 🆕 REGISTRY-DRIVEN PROVIDER BLOCK RENDERER
    // ════════════════════════════════════════════════════════════════
    // Renders API key / endpoint / model / temperature / reasoning fields
    // based on the ProviderDef's auth scheme and protocol. Same renderer is
    // used for both the translation provider and the OCR provider section.

    /**
     * OCR-specific variant of renderProviderBlock. Renders API key, endpoint,
     * model (labelled "OCR Model"), and — for the custom protocol — the
     * headers/requestBody/responseJsonPath fields. Does NOT render temperature
     * (OCR section has its own temperature control below) or reasoning (OCR
     * doesn't use it). Includes a Test connection button.
     */
    renderOcrProviderBlock(
        containerEl: HTMLElement,
        def: ProviderDef,
        ocrSettings: any,
        psView: any,
    ): void {
        // API key
        if (def.auth.kind !== 'none') {
            new Setting(containerEl)
                .setName(t('provider.block.apikey.name'))
                .setDesc(def.docsUrl ? t('provider.block.apikey.docs', { url: def.docsUrl }) : t('provider.block.apikey.desc'))
                .addText(text => {
                    text.setPlaceholder(def.apiKeyPlaceholder || 'sk-...')
                        .setValue(ocrSettings.apiKey || '')
                        .onChange(async (value) => {
                            ocrSettings.apiKey = value.trim();
                            invalidateModelCache(def.id);
                            await this.plugin.saveSettings();
                            // Stage 1.4 (Q21): warn on empty OCR API key.
                            if (!ocrSettings.apiKey) {
                                new Notice(
                                    t('provider.block.apikey.empty.ocr.warning', { provider: def.label }),
                                    5000,
                                );
                            }
                        });
                    text.inputEl.type = 'password';
                });
        }

        // Endpoint (local + custom)
        const showsEndpoint =
            def.category === 'local' ||
            def.protocol === 'ollama' ||
            def.protocol === 'custom';
        if (showsEndpoint) {
            new Setting(containerEl)
                .setName(t('ocr.block.endpoint.name'))
                .setDesc(t('ocr.block.endpoint.desc', { provider: def.label }))
                .addText(text => text
                    .setPlaceholder(def.defaultEndpoint || 'http://localhost:...')
                    .setValue(ocrSettings.apiEndpoint || '')
                    .onChange(async (value) => {
                        ocrSettings.apiEndpoint = value;
                        invalidateModelCache(def.id);
                        await this.plugin.saveSettings();
                        // Stage 1.4 (Q21): validate OCR endpoint URL format.
                        if (ocrSettings.apiEndpoint) {
                            const trimmed = ocrSettings.apiEndpoint.trim();
                            try {
                                const u = new URL(trimmed);
                                if (!['http:', 'https:'].includes(u.protocol)) {
                                    new Notice(
                                        t('provider.block.endpoint.invalid.protocol.ocr', { protocol: u.protocol }),
                                        5000,
                                    );
                                }
                            } catch {
                                new Notice(
                                    t('provider.block.endpoint.invalid.url.ocr', { url: trimmed }),
                                    5000,
                                );
                            }
                        }
                    }));
        }

        // Model dropdown — uses the same buildModelSetting helper but with
        // OCR-specific psView (which reads/writes ocrSettings.model).
        if (def.protocol === 'custom') {
            new Setting(containerEl)
                .setName(t('ocr.block.model.name'))
                .setDesc(t('ocr.block.model.desc.custom'))
                .addText(text => text
                    .setPlaceholder(def.defaultModel || '...')
                    .setValue(ocrSettings.model || '')
                    .onChange(async v => { ocrSettings.model = v; await this.plugin.saveSettings(); }));
        } else {
            // buildModelSetting takes (containerEl, providerId, ps, fallback).
            // The ps here is psView — getters/setters proxy to ocrSettings.
            const setting = new Setting(containerEl)
                .setName(t('ocr.block.model.name'))
                .setDesc(t('ocr.block.model.desc.fetched'));

            let dropdown: import('obsidian').DropdownComponent | null = null;
            const populate = async (models: ProviderModel[]) => {
                if (!dropdown) return;
                dropdown.selectEl.empty();
                // For OCR, prefer vision-capable models at the top.
                const sorted = [...models].sort((a, b) => {
                    if (!!a.vision !== !!b.vision) return a.vision ? -1 : 1;
                    return (a.label || a.id).localeCompare(b.label || b.id);
                });
                if (sorted.length === 0) {
                    dropdown.addOption('', t('provider.model.dropdown.empty'));
                } else {
                    sorted.forEach(m => dropdown!.addOption(m.id, m.label || m.id));
                }
                const current = ocrSettings.model || def.defaultModel;
                if (current && !sorted.find(m => m.id === current)) {
                    dropdown.addOption(current, t('provider.model.dropdown.saved', { model: current }));
                }
                dropdown.setValue(current || '');
            };

            setting.addDropdown(dd => {
                dropdown = dd;
                dd.addOption(ocrSettings.model || def.defaultModel || '', t('provider.model.dropdown.loading'));
                dd.setValue(ocrSettings.model || def.defaultModel || '');
                dd.onChange(async v => { ocrSettings.model = v; await this.plugin.saveSettings(); });
                fetchProviderModels(def.id, psView).then(populate);
            });

            setting.addExtraButton(b => b
                .setIcon('refresh-cw')
                .setTooltip(t('provider.model.refresh.tooltip'))
                .onClick(async () => {
                    new Notice(t('provider.model.refresh.notice.loading'));
                    const models = await fetchProviderModels(def.id, psView, { force: true });
                    await populate(models);
                    new Notice(models.length ? t('provider.model.refresh.notice.ok', { n: models.length }) : t('provider.model.refresh.notice.empty'));
                }));

            // Manual override
            new Setting(containerEl)
                .setName(t('provider.model.manual.label'))
                .setDesc(t('provider.model.manual.desc'))
                .addText(text => text
                    .setPlaceholder(def.defaultModel)
                    .setValue(ocrSettings.model || '')
                    .onChange(async v => {
                        const val = v.trim();
                        if (val) { ocrSettings.model = val; await this.plugin.saveSettings(); }
                    }));
        }

        // Custom protocol extras (NEW: the OCR section never exposed these
        // before, which made ocr-provider='custom' essentially unusable).
        if (def.protocol === 'custom') {
            new Setting(containerEl)
                .setName(t('provider.headers.label'))
                .setDesc(t('provider.block.headers.desc'))
                .addTextArea(ta => {
                    ta.setValue(ocrSettings.headers || '{}');
                    ta.onChange(async v => { ocrSettings.headers = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 4;
                });

            new Setting(containerEl)
                .setName(t('ocr.block.requestBody.name'))
                .setDesc(t('ocr.block.requestBody.desc'))
                .addTextArea(ta => {
                    ta.setValue(ocrSettings.requestBody || '{}');
                    ta.onChange(async v => { ocrSettings.requestBody = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 10;
                });

            new Setting(containerEl)
                .setName(t('ocr.block.responsePath.name'))
                .setDesc(t('ocr.block.responsePath.desc'))
                .addText(text => text
                    .setValue(ocrSettings.responseJsonPath || '')
                    .onChange(async v => { ocrSettings.responseJsonPath = v; await this.plugin.saveSettings(); }));
        }

        // Test connection
        new Setting(containerEl)
            .setName(t('ocr.block.test.name'))
            .setDesc(t('ocr.block.test.desc'))
            .addButton(btn => btn
                .setButtonText(t('provider.block.test.button'))
                .onClick(async () => {
                    btn.setButtonText(t('provider.block.test.button.testing'));
                    btn.setDisabled(true);
                    const result = await testConnection(def.id, psView);
                    new Notice(result.message, 8000);
                    btn.setButtonText(t('provider.block.test.button'));
                    btn.setDisabled(false);
                }));
    }

    renderProviderBlock(
        containerEl: HTMLElement,
        def: ProviderDef,
        ps: any,
    ): void {
        new Setting(containerEl).setName(def.label).setHeading();

        if (def.docsUrl) {
            containerEl.createEl('p', {
                text: t('provider.docs.prefix', { url: def.docsUrl }),
                cls: 'setting-item-description',
            });
        }

        // ─── API key ─────────────────────────────────────────────
        if (def.auth.kind !== 'none') {
            new Setting(containerEl)
                .setName(t('provider.block.apikey.name'))
                .setDesc(def.docsUrl ? t('provider.block.apikey.docs', { url: def.docsUrl }) : t('provider.block.apikey.desc'))
                .addText(text => {
                    text.setPlaceholder(def.apiKeyPlaceholder || '...')
                        .setValue(ps.apiKey || '')
                        .onChange(async (value) => {
                            ps.apiKey = value.trim();
                            invalidateModelCache(def.id);
                            await this.plugin.saveSettings();
                            // Stage 1.4 (Q21): warn (but don't block) when
                            // the user saves an empty API key. They may be
                            // switching providers and intend to fill it in
                            // later, so we don't prevent the save — just
                            // make the missing key visible.
                            if (!ps.apiKey) {
                                new Notice(
                                    t('provider.block.apikey.empty.warning', { provider: def.label }),
                                    5000,
                                );
                            }
                        });
                    text.inputEl.type = 'password';
                });
        }

        // ─── Endpoint (local + custom protocols) ─────────────────
        const showsEndpoint =
            def.category === 'local' ||
            def.protocol === 'ollama' ||
            def.protocol === 'custom';
        if (showsEndpoint) {
            new Setting(containerEl)
                .setName(t('provider.block.endpoint.name'))
                .setDesc(t('provider.block.endpoint.desc', { provider: def.label }))
                .addText(text => text
                    .setPlaceholder(def.defaultEndpoint || 'http://localhost:...')
                    .setValue(ps.apiEndpoint || '')
                    .onChange(async (value) => {
                        ps.apiEndpoint = value;
                        invalidateModelCache(def.id);
                        await this.plugin.saveSettings();
                        // Stage 1.4 (Q21): validate URL format for endpoints.
                        // Common typos: missing http://, typos like 'htp://',
                        // extra spaces. Warn (but don't block) so the user
                        // can fix and re-save.
                        if (ps.apiEndpoint) {
                            const trimmed = ps.apiEndpoint.trim();
                            try {
                                // URL constructor is strict — rejects 'htp://',
                                // 'localhost:11434' (no protocol), etc.
                                const u = new URL(trimmed);
                                if (!['http:', 'https:'].includes(u.protocol)) {
                                    new Notice(
                                        t('provider.block.endpoint.invalid.protocol', { protocol: u.protocol }),
                                        5000,
                                    );
                                }
                            } catch {
                                new Notice(
                                    t('provider.block.endpoint.invalid.url', { url: trimmed }),
                                    5000,
                                );
                            }
                        }
                    }));
        }

        // ─── Model ───────────────────────────────────────────────
        if (def.protocol === 'custom') {
            // For custom, just a plain text input — model is usually baked
            // into the request body template via {model}.
            new Setting(containerEl)
                .setName(t('provider.block.model.name'))
                .setDesc(t('provider.block.model.desc'))
                .addText(text => text
                    .setPlaceholder(def.defaultModel || '...')
                    .setValue(ps.model || '')
                    .onChange(async v => { ps.model = v; await this.plugin.saveSettings(); }));
        } else {
            this.buildModelSetting(containerEl, def.id, ps, def.defaultModel);
        }

        // ─── Temperature ─────────────────────────────────────────
        new Setting(containerEl)
            .setName(t('provider.temperature.label'))
            .setDesc(t('provider.temperature.desc'))
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(ps.temperature ?? 0.3)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    ps.temperature = value;
                    await this.plugin.saveSettings();
                }));

        // ─── Reasoning toggle ────────────────────────────────────
        if (def.supportsReasoning) {
            new Setting(containerEl)
                .setName(t('provider.reasoning.label'))
                .setDesc(t('provider.reasoning.desc'))
                .addToggle(toggle => toggle
                    .setValue(ps.enableReasoning ?? false)
                    .onChange(async (value) => {
                        ps.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // ─── Custom protocol extras ──────────────────────────────
        if (def.protocol === 'custom') {
            new Setting(containerEl)
                .setName(t('provider.headers.label'))
                .setDesc(t('provider.block.headers.desc'))
                .addTextArea(ta => {
                    ta.setValue(ps.headers || '{}');
                    ta.onChange(async v => { ps.headers = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 4;
                });

            new Setting(containerEl)
                .setName(t('provider.block.requestBody.name'))
                .setDesc(t('provider.block.requestBody.desc'))
                .addTextArea(ta => {
                    ta.setValue(ps.requestBody || '{}');
                    ta.onChange(async v => { ps.requestBody = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 10;
                });

            new Setting(containerEl)
                .setName(t('provider.block.responsePath.name'))
                .setDesc(t('provider.block.responsePath.desc'))
                .addText(text => text
                    .setValue(ps.responsePath || '')
                    .onChange(async v => { ps.responsePath = v; await this.plugin.saveSettings(); }));
        }

        // ─── Test connection ─────────────────────────────────────
        new Setting(containerEl)
            .setName(t('provider.block.test.name'))
            .setDesc(t('provider.block.test.desc'))
            .addButton(btn => btn
                .setButtonText(t('provider.block.test.button'))
                .onClick(async () => {
                    btn.setButtonText(t('provider.block.test.button.testing'));
                    btn.setDisabled(true);
                    const result = await testConnection(def.id, ps);
                    new Notice(result.message, 8000);
                    btn.setButtonText(t('provider.block.test.button'));
                    btn.setDisabled(false);
                }));
    }

    /**
     * Build a Model setting: a dropdown populated from the live API (via the
     * registry's fetchProviderModels, with 1-hour cache) plus a Refresh button
     * and a manual-entry fallback so unusual/new model IDs are always
     * reachable even if the API list is incomplete.
     */
    buildModelSetting(
        containerEl: HTMLElement,
        provider: string,
        ps: any,
        fallback: string,
    ): void {
        const setting = new Setting(containerEl)
            .setName(t('provider.block.model.name.default'))
            .setDesc(t('provider.block.model.desc.default'));

        let dropdown: import('obsidian').DropdownComponent | null = null;

        const populate = async (models: ProviderModel[]) => {
            if (!dropdown) return;
            dropdown.selectEl.empty();
            if (models.length === 0) {
                dropdown.addOption('', t('provider.model.dropdown.empty'));
            } else {
                models.forEach(m => dropdown!.addOption(m.id, m.label || m.id));
            }
            const current = ps.model || fallback;
            if (current && !models.find(m => m.id === current)) {
                dropdown.addOption(current, t('provider.model.dropdown.saved', { model: current }));
            }
            dropdown.setValue(current || '');
        };

        setting.addDropdown(dd => {
            dropdown = dd;
            dd.addOption(ps.model || fallback || '', t('provider.model.dropdown.loading'));
            dd.setValue(ps.model || fallback || '');
            dd.onChange(async v => { ps.model = v; await this.plugin.saveSettings(); });
            // Initial fetch (uses cache, falls back to staticModels).
            fetchProviderModels(provider, ps).then(populate);
        });

        setting.addExtraButton(b => b
            .setIcon('refresh-cw')
            .setTooltip(t('provider.model.refresh.tooltip'))
            .onClick(async () => {
                new Notice(t('provider.model.refresh.notice.loading'));
                const models = await fetchProviderModels(provider, ps, { force: true });
                await populate(models);
                new Notice(models.length ? t('provider.model.refresh.notice.ok', { n: models.length }) : t('provider.model.refresh.notice.empty'));
            }));

        // Manual override — always works regardless of the API list.
        new Setting(containerEl)
            .setName(t('provider.model.manual.label'))
            .setDesc(t('provider.model.manual.desc'))
            .addText(t => t
                .setPlaceholder(fallback)
                .setValue(ps.model || '')
                .onChange(async v => {
                    const val = v.trim();
                    if (val) { ps.model = val; await this.plugin.saveSettings(); }
                }));
    }

    /**
     * Tests the PDF export setup by running a simple Python command.
     *
     * Phase 4 (C1): guarded with `Platform.isDesktop` because it relies on
     * Node's `child_process.spawn` which is unavailable on mobile (Obsidian
     * mobile runs in a Capacitor shell without Node integration).
     */
    async testExportSetup(): Promise<void> {
        // Phase 4 (C1): Node-only API — bail on mobile before touching require().
        if (!Platform.isDesktop) {
            new Notice(t('settings.test.desktop.only'), 5000);
            return;
        }

        const { pythonPath, pdfExportScriptPath } = this.plugin.settings as any;

        if (!pythonPath) {
            new Notice(t('settings.test.python.missing'));
            return;
        }

        if (!pdfExportScriptPath) {
            new Notice(t('settings.test.export.script.missing'));
            return;
        }

        new Notice(t('settings.test.export.testing'));

        try {
            const { spawn } = (window as any).require('child_process');

            const pythonTest = spawn(pythonPath, ['--version']);

            let pythonOutput = '';
            pythonTest.stdout.on('data', (data: any) => {
                pythonOutput += data.toString();
            });

            pythonTest.stderr.on('data', (data: any) => {
                pythonOutput += data.toString();
            });

            pythonTest.on('close', (code: number) => {
                if (code === 0) {
                    new Notice(t('settings.test.python.found', { version: pythonOutput.trim() }));
                    this.testPyMuPDF(pythonPath);
                } else {
                    new Notice(t('settings.test.python.failed'));
                    console.error('Python test output:', pythonOutput);
                }
            });

            pythonTest.on('error', (err: any) => {
                new Notice(t('settings.test.python.spawn.error'));
                console.error('Python spawn error:', err);
            });

        } catch (error) {
            new Notice(t('settings.test.export.error'));
            console.error('Test error:', error);
        }
    }

    /**
     * Tests PyMuPDF installation.
     *
     * Phase 4 (C1): guarded with `Platform.isDesktop`. This method is only
     * ever called from `testExportSetup()` which already bails on mobile,
     * but we re-check here in case a future caller invokes it directly.
     */
    async testPyMuPDF(pythonPath: string): Promise<void> {
        if (!Platform.isDesktop) {
            new Notice(t('settings.test.desktop.only'), 5000);
            return;
        }
        const { spawn } = (window as any).require('child_process');

        const test = spawn(pythonPath, ['-c', 'import fitz; print(fitz.__version__)']);

        let output = '';
        test.stdout.on('data', (data: any) => {
            output += data.toString();
        });

        test.stderr.on('data', (data: any) => {
            output += data.toString();
        });

        test.on('close', (code: number) => {
            if (code === 0) {
                new Notice(t('settings.test.pymupdf.found', { version: output.trim() }));
                this.testScriptExists();
            } else {
                new Notice(t('settings.test.pymupdf.missing'));
                console.error('PyMuPDF test output:', output);
            }
        });

        test.on('error', (err: any) => {
            new Notice(t('settings.test.pymupdf.error'));
            console.error('PyMuPDF test error:', err);
        });
    }

    /**
     * Tests if the export script exists.
     *
     * Phase 4 (C1): guarded with `Platform.isDesktop` — uses Node's `fs`.
     */
    async testScriptExists(): Promise<void> {
        if (!Platform.isDesktop) {
            new Notice(t('settings.test.desktop.only'), 5000);
            return;
        }
        const { pdfExportScriptPath } = this.plugin.settings as any;

        try {
            const fs = (window as any).require('fs');

            if (fs.existsSync(pdfExportScriptPath)) {
                new Notice(t('settings.test.script.found', { path: pdfExportScriptPath }));
                new Notice(t('settings.test.script.all.met'));
            } else {
                new Notice(t('settings.test.script.missing'));
            }
        } catch (error) {
            new Notice(t('settings.test.script.error'));
            console.error('Script check error:', error);
        }
    }
}
