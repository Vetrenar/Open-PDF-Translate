// settings.ts
import {
    PluginSettingTab,
    App,
    Setting,
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
        this.setPlaceholder('e.g. My Translations/ (empty = next to PDF)');
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

    constructor(app: App, plugin: OpenRouterTranslatorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'PDF Text Translator' });

        // --- API PROVIDER SELECTION ---
        new Setting(containerEl)
            .setName('API Provider')
            .setDesc('Choose your preferred translation service.')
            .addDropdown(dd => {
                dd.addOption('openrouter', 'OpenRouter')
                  .addOption('openai', 'OpenAI')
                  .addOption('gemini', 'Google Gemini')
                  .addOption('ollama', 'Ollama (Local)')
                  .addOption('custom', 'Custom Endpoint')
                  .setValue(this.plugin.settings.apiProvider)
                  .onChange(async (value: any) => {
                      this.plugin.settings.apiProvider = value;
                      await this.plugin.saveSettings();
                      this.display();
                  });
            });
        
        containerEl.createEl('hr');
        
        const provider = this.plugin.settings.apiProvider;
        if (!this.plugin.settings.providerSettings[provider]) {
            this.plugin.settings.providerSettings[provider] = {};
        }
        const providerSettings = this.plugin.settings.providerSettings[provider];

        // --- PROVIDER-SPECIFIC SETTINGS ---
        
        // ==========================================================
        // OPENAI
        // ==========================================================
        if (provider === 'openai') {
            new Setting(containerEl).setName(t('openai.section')).setHeading();

            new Setting(containerEl)
                .setName('OpenAI API Key')
                .setDesc('Get your key from https://platform.openai.com/api-keys')
                .addText(text => {
                    text.setPlaceholder('sk-...')
                        .setValue(providerSettings.apiKey || '')
                        .onChange(async (value) => {
                            providerSettings.apiKey = value.trim();
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.type = 'password';
                });

            this.buildModelSetting(containerEl, 'openai', providerSettings, 'gpt-4o');

            new Setting(containerEl)
                .setName(t('provider.temperature.label'))
                .setDesc(t('provider.temperature.desc'))
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(providerSettings.temperature ?? 0.3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        providerSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(t('provider.reasoning.label'))
                .setDesc(t('provider.reasoning.desc'))
                .addToggle(toggle => toggle
                    .setValue(providerSettings.enableReasoning ?? false)
                    .onChange(async (value) => {
                        providerSettings.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));

        // ==========================================================
        // GOOGLE GEMINI
        // ==========================================================
        } else if (provider === 'gemini') {
            new Setting(containerEl).setName(t('gemini.section')).setHeading();

            new Setting(containerEl)
                .setName('Gemini API Key')
                .setDesc('Get your key from https://aistudio.google.com/app/apikey')
                .addText(text => {
                    text.setPlaceholder('AIzaSy...')
                        .setValue(providerSettings.apiKey || '')
                        .onChange(async (value) => {
                            providerSettings.apiKey = value.trim();
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.type = 'password';
                });

            this.buildModelSetting(containerEl, 'gemini', providerSettings, 'models/gemini-1.5-flash');

            new Setting(containerEl)
                .setName(t('provider.temperature.label'))
                .setDesc(t('provider.temperature.desc'))
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(providerSettings.temperature ?? 0.3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        providerSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Enable Thinking Mode')
                .setDesc('Enable thinking mode for Gemini 2.0 Flash Thinking models. Provides deeper analysis.')
                .addToggle(toggle => toggle
                    .setValue(providerSettings.enableReasoning ?? false)
                    .onChange(async (value) => {
                        providerSettings.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));

        // ==========================================================
        // OPENROUTER
        // ==========================================================
        } else if (provider === 'openrouter') {
            new Setting(containerEl).setName(t('openrouter.section')).setHeading();

            new Setting(containerEl)
                .setName('OpenRouter API Key')
                .setDesc('Get your key from https://openrouter.ai/keys')
                .addText(text => {
                    text.setPlaceholder('sk-or-v1-...')
                        .setValue(providerSettings.apiKey || '')
                        .onChange(async (value) => {
                            providerSettings.apiKey = value.trim();
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.type = 'password';
                });

            this.buildModelSetting(containerEl, 'openrouter', providerSettings, 'google/gemini-flash-1.5');

            new Setting(containerEl)
                .setName(t('provider.temperature.label'))
                .setDesc(t('provider.temperature.desc'))
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(providerSettings.temperature ?? 0.3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        providerSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(t('provider.reasoning.label'))
                .setDesc(t('provider.reasoning.desc'))
                .addToggle(toggle => toggle
                    .setValue(providerSettings.enableReasoning ?? false)
                    .onChange(async (value) => {
                        providerSettings.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));

        // ==========================================================
        // OLLAMA
        // ==========================================================
        } else if (provider === 'ollama') {
            new Setting(containerEl).setName(t('ollama.section')).setHeading();

            new Setting(containerEl)
                .setName(t('ollama.endpoint.label'))
                .setDesc(t('ollama.endpoint.desc'))
                .addText(text => text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(providerSettings.apiEndpoint || '')
                    .onChange(async (value) => {
                        providerSettings.apiEndpoint = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            this.buildModelSetting(containerEl, 'ollama', providerSettings, 'llama3');

            new Setting(containerEl)
                .setName(t('provider.temperature.label'))
                .setDesc(t('provider.temperature.desc'))
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(providerSettings.temperature ?? 0.3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        providerSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Enable Reasoning')
                .setDesc('Enable extended thinking for compatible Ollama models.')
                .addToggle(toggle => toggle
                    .setValue(providerSettings.enableReasoning ?? false)
                    .onChange(async (value) => {
                        providerSettings.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));

        // ==========================================================
        // CUSTOM
        // ==========================================================
        } else if (provider === 'custom') {
            new Setting(containerEl).setName(t('custom.section')).setHeading();
            
            new Setting(containerEl)
                .setName(t('custom.endpoint.label'))
                .addText(t => t.setValue(providerSettings.apiEndpoint || '').onChange(async v => {
                    providerSettings.apiEndpoint = v; await this.plugin.saveSettings();
                }));
            
            new Setting(containerEl)
                .setName(t('custom.apikey.label'))
                .setDesc(t('custom.apikey.desc'))
                .addText(t => {
                    t.setValue(providerSettings.apiKey || '').onChange(async v => {
                        providerSettings.apiKey = v.trim(); await this.plugin.saveSettings();
                    });
                    t.inputEl.type = 'password';
                });

            new Setting(containerEl)
                .setName(t('custom.model.label'))
                .addText(t => t.setValue(providerSettings.model || '').onChange(async v => {
                    providerSettings.model = v; await this.plugin.saveSettings();
                }));

            new Setting(containerEl)
                .setName(t('provider.headers.label'))
                .setDesc(t('provider.headers.desc'))
                .addTextArea(ta => {
                    ta.setValue(providerSettings.headers || '{}')
                    .onChange(async v => { providerSettings.headers = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 4;
                });
            
            new Setting(containerEl)
                .setName('Request Body (JSON Template)')
                .setDesc('Use placeholders: {model}, {systemPrompt}, {userPrompt}, {temperature}')
                .addTextArea(ta => {
                    ta.setValue(providerSettings.requestBody || '{}')
                    .onChange(async v => { providerSettings.requestBody = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 10;
                });

            new Setting(containerEl)
                .setName('Response Path')
                .setDesc('JSON path to the translated text (e.g., choices[0].message.content)')
                .addText(t => t
                    .setValue(providerSettings.responsePath || '')
                    .onChange(async v => { providerSettings.responsePath = v; await this.plugin.saveSettings(); }));

            new Setting(containerEl)
                .setName('Temperature')
                .setDesc('Default temperature value. Use {temperature} placeholder in request body.')
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(providerSettings.temperature ?? 0.3)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        providerSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Enable Reasoning')
                .setDesc('Enable this for reasoning-capable models. Add appropriate fields to request body.')
                .addToggle(toggle => toggle
                    .setValue(providerSettings.enableReasoning ?? false)
                    .onChange(async (value) => {
                        providerSettings.enableReasoning = value;
                        await this.plugin.saveSettings();
                    }));
        }

        containerEl.createEl('hr');

        // --- GENERAL SETTINGS ---
        new Setting(containerEl).setName(t('general.section')).setHeading();

        // Storage Location
        new Setting(containerEl)
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

        // ── Folder Watcher (background translation) ──
        containerEl.createEl('hr');
        new Setting(containerEl).setName(t('watcher.section')).setHeading();
        containerEl.createEl('p', {
            text: 'Watch a folder for new PDFs and queue them for background translation. This is python-only: it extracts text + coordinates from the file on disk (PyMuPDF) without opening the PDF, then writes a .translations.md. Detection only queues — you trigger translation from the queue.',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName(t('watcher.enable.label'))
            .setDesc(t('watcher.enable.desc'))
            .addToggle(t => t.setValue(this.plugin.settings.watcherEnabled).onChange(async v => {
                this.plugin.settings.watcherEnabled = v;
                await this.plugin.saveSettings();
                if (v) this.plugin.watcher.start(); else this.plugin.watcher.stop();
            }));

        new Setting(containerEl)
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

        new Setting(containerEl)
            .setName(t('watcher.queue.label'))
            .setDesc(t('watcher.queue.desc'))
            .addButton(b => b.setButtonText(t('watcher.queue.btn.open')).onClick(() => {
                new WatcherQueueModal(this.app, this.plugin).open();
            }))
            .addButton(b => b.setButtonText(t('watcher.queue.btn.scan')).onClick(async () => {
                const n = await this.plugin.watcher.scanExisting();
                new Notice(n > 0 ? t('modal.watcher.scan.found',{n}) : t('modal.watcher.scan.none'));
            }));

        if (this.plugin.settings.layoutEngine !== 'python') {
            containerEl.createEl('p', {
                text: '⚠ Background translation needs the Python layout engine (set Layout Engine to Python above). The internal and OCR engines require an open PDF and cannot run in the background.',
                cls: 'setting-item-description',
            });
        }

        new Setting(containerEl)
            .setName(t('general.autosave.label'))
            .setDesc('Automatically save overlay positions each time you translate.')
            .addToggle(t => t.setValue(this.plugin.settings.autoSaveOverlay).onChange(async v => {
                this.plugin.settings.autoSaveOverlay = v; await this.plugin.saveSettings();
            }));

        // Language Settings
        new Setting(containerEl)
            .setName(t('general.language.source'))
            .addDropdown(dd => {
                AVAILABLE_LANGUAGES.forEach(lang => dd.addOption(lang.code, lang.name));
                dd.setValue(this.plugin.settings.sourceLanguage).onChange(async v => {
                    this.plugin.settings.sourceLanguage = v; await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName(t('general.language.target'))
            .addDropdown(dd => {
                AVAILABLE_LANGUAGES.forEach(lang => dd.addOption(lang.code, lang.name));
                dd.setValue(this.plugin.settings.targetLanguage).onChange(async v => {
                    this.plugin.settings.targetLanguage = v; await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Translation Mode')
            .setDesc('Batch mode is faster but may have formatting issues.')
            .addToggle(t => t.setValue(this.plugin.settings.useBatchTranslation).onChange(async v => {
                this.plugin.settings.useBatchTranslation = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName(t('general.semanticmerge.label'))
            .setDesc(t('general.semanticmerge.desc'))
            .addToggle(t => t.setValue(this.plugin.settings.enableSemanticMerging).onChange(async v => {
                this.plugin.settings.enableSemanticMerging = v; await this.plugin.saveSettings();
            }));

        containerEl.createEl('hr');
        
        // --- PROMPTS ---
        new Setting(containerEl).setName(t('prompts.section')).setHeading();

        // How-to-structure-a-prompt help.
        const promptHelp = containerEl.createEl('div', { cls: 'setting-item-description' });
        promptHelp.style.cssText = 'border-left:3px solid var(--interactive-accent);padding:8px 12px;margin:4px 0 12px;background:var(--background-secondary);border-radius:0 6px 6px 0;line-height:1.5;';
        promptHelp.createEl('p', { text: t('prompts.help.title') }).style.fontWeight = '600';

        const intro = promptHelp.createEl('p');
        intro.appendText(t('prompts.help.intro'));
        intro.createEl('b', { text: t('prompts.help.batch') });
        intro.appendText(t('prompts.help.batch.desc'));
        intro.createEl('b', { text: t('prompts.help.single') });
        intro.appendText(t('prompts.help.single.desc'));

        const phTitle = promptHelp.createEl('p');
        phTitle.createEl('b', { text: 'Placeholders' });
        phTitle.appendText(' ' + t('prompts.help.placeholders'));
        const phList = promptHelp.createEl('ul');
        phList.style.margin = '4px 0 4px 18px';
        const ph = (code: string, what: string) => {
            const li = phList.createEl('li');
            li.createEl('code', { text: code });
            li.appendText(' — ' + what);
        };
        ph('{sourceLang}', t('prompts.help.ph.sourcelang'));
        ph('{targetLang}', t('prompts.help.ph.targetlang'));
        ph('{inputText}', t('prompts.help.ph.inputtext'));
        ph('{lineCount}', t('prompts.help.ph.linecount'));

        const rulesTitle = promptHelp.createEl('p');
        rulesTitle.createEl('b', { text: t('prompts.help.rules.title') });
        const rules = promptHelp.createEl('ul');
        rules.style.margin = '4px 0 4px 18px';
        rules.createEl('li', { text: t('prompts.help.rules.1') });
        rules.createEl('li', { text: t('prompts.help.rules.2') });
        rules.createEl('li', { text: t('prompts.help.rules.3') });

        const tips = promptHelp.createEl('p');
        tips.createEl('b', { text: t('prompts.help.tips.title') });
        tips.appendText(': add domain terminology, a glossary, or a tone instruction at the top (e.g. “Use formal legal terminology; keep acronyms untranslated”). Keep the [#N] and {lineCount} rules intact or batch translation will misalign. Use Restore Default if a prompt stops working.');

        new Setting(containerEl)
            .setName(t('prompts.special.label'))
            .setDesc('Some models (e.g. Gemma and other instruction-tuned local models) work best when the whole request is shaped as one template with a {TEXT} placeholder, rather than separate system/user prompts. Enable this to override the batch/single prompts below with the single template.')
            .addToggle(t => t.setValue(this.plugin.settings.useGemmaPrompt).onChange(async v => {
                this.plugin.settings.useGemmaPrompt = v;
                await this.plugin.saveSettings();
                this.display();
            }));

        if (this.plugin.settings.useGemmaPrompt) {
            new Setting(containerEl)
                .setName(t('prompts.special.template.label'))
                .setDesc(t('prompts.special.template.desc'))
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';

                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings.customTemplate || DEFAULT_CUSTOM_TEMPLATE)
                        .onChange(async v => {
                            this.plugin.settings.customTemplate = v;
                            await this.plugin.saveSettings();
                        });
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
            new Setting(containerEl)
                .setName(t('prompts.batch.label'))
                .setDesc(t('prompts.batch.desc'))
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';
                    
                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings.batchPrompt).onChange(async v => {
                            this.plugin.settings.batchPrompt = v; await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 8;

                    new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                        this.plugin.settings.batchPrompt = DEFAULT_SETTINGS.batchPrompt;
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS.batchPrompt);
                    }).buttonEl.style.marginTop = '8px';
                });

            new Setting(containerEl)
                .setName(t('prompts.single.label'))
                .setDesc(t('prompts.single.desc'))
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';
                    
                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings.singlePrompt).onChange(async v => {
                            this.plugin.settings.singlePrompt = v; await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 4;

                    new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                        this.plugin.settings.singlePrompt = DEFAULT_SETTINGS.singlePrompt;
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS.singlePrompt);
                    }).buttonEl.style.marginTop = '8px';
                });
        }

        // (Custom Copy Formats moved down to the Export section.)

        // Visuals and Processing
        containerEl.createEl('hr');
        new Setting(containerEl).setName(t('visual.section')).setHeading();

        new Setting(containerEl)
            .setName(t('visual.fontscale.label'))
            .addSlider(s => s.setLimits(0.4, 1.2, 0.05).setValue(this.plugin.settings.outputFontSizeScale).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.outputFontSizeScale = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName(t('visual.lineheight.label'))
            .addSlider(s => s.setLimits(0.5, 2.0, 0.05).setValue(this.plugin.settings.outputLineHeight).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.outputLineHeight = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName(t('visual.maxbatch.label'))
            .setDesc(t('visual.maxbatch.desc'))
            .addSlider(s => s.setLimits(50, 15000, 50).setValue(this.plugin.settings.maxBatchChars).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.maxBatchChars = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName(t('visual.bboxedit.label'))
            .setDesc(t('visual.bboxedit.desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.bboxEditMode)
                .onChange(async (value) => {
                    this.plugin.settings.bboxEditMode = value;
                    await this.plugin.saveSettings();
                    new Notice(`BBox Edit Mode ${value ? 'enabled' : 'disabled'}.`);
                }));

            
        // ============================================================
        // LAYOUT ENGINE SETTINGS (Replaces old external layout section)
        // ============================================================

        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: t('engine.section') });
        containerEl.createEl('p', {
            text: t('engine.section.desc'),
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName(t('engine.dropdown.label'))
            .setDesc(t('engine.dropdown.desc'))
            .addDropdown(dd => {
                dd.addOption('internal', t('engine.opt.internal'))
                  .addOption('python', t('engine.opt.python'))
                  .setValue(this.plugin.settings.layoutEngine === 'python' ? 'python' : 'internal')
                  .onChange(async (value: any) => {
                      this.plugin.settings.layoutEngine = value;
                      await this.plugin.saveSettings();
                      this.display();
                  });
            });

        const engine = this.plugin.settings.layoutEngine;

        // ── Python Engine Settings ──
        if (engine === 'python') {
            new Setting(containerEl)
                .setName(t('engine.python.path.label'))
                .setDesc(t('engine.python.path.desc'))
                .addText(text => text
                    .setPlaceholder('python')
                    .setValue(this.plugin.settings.pythonPath)
                    .onChange(async (value) => {
                        this.plugin.settings.pythonPath = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(t('engine.python.script.label'))
                .setDesc(t('engine.python.script.desc'))
                .addText(text => text
                    .setPlaceholder('/path/to/layout_engine.py')
                    .setValue(this.plugin.settings.ocrScriptPath)
                    .onChange(async (value) => {
                        this.plugin.settings.ocrScriptPath = value;
                        await this.plugin.saveSettings();
                    }));

            // Install the bundled Python scripts on demand (user-initiated, desktop only).
            const installSetting = new Setting(containerEl)
                .setName(t('engine.python.install.label'))
                .setDesc(t('engine.python.install.desc'));
            if (Platform.isDesktop) {
                installSetting.addButton(btn => btn
                    .setButtonText(t('engine.python.install.btn'))
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true).setButtonText(t('engine.python.install.btn.progress'));
                        const result = await installPythonScripts(this.plugin, { overwrite: true });
                        btn.setDisabled(false).setButtonText('Install / Update scripts');
                        if (result) this.display(); // refresh to show the new resolved path
                    }));
            } else {
                installSetting.setDesc(t('engine.python.desktop.only'));
            }
        }

        // ============================================================
        // End of Layout Engine Section
        // ============================================================
        containerEl.createEl('hr');

        // ============================================================
        // OCR (AI VISION) — independent subsystem, always available
        // ============================================================
        {
            const ocrSettings = this.plugin.settings.ocrProvider;

            new Setting(containerEl).setName(t('ocr.section')).setHeading();
            containerEl.createEl('p', {
                text: t('ocr.section.desc'),
                cls: 'setting-item-description'
            });

            containerEl.createEl('h4', { text: t('ocr.provider.section') });
            containerEl.createEl('p', {
                text: 'The AI model used for recognition. This is separate from your translation model.',
                cls: 'setting-item-description'
            });

            // Provider Selection
            new Setting(containerEl)
                .setName(t('ocr.provider.label'))
                .addDropdown(dd => {
                    dd.addOption('openrouter', 'OpenRouter')
                      .addOption('openai', 'OpenAI')
                      .addOption('gemini', 'Google Gemini')
                      .addOption('ollama', 'Ollama (Local)')
                      .addOption('custom', 'Custom Endpoint')
                      .setValue(ocrSettings.provider)
                      .onChange(async (value: any) => {
                          ocrSettings.provider = value;
                          await this.plugin.saveSettings();
                          this.display();
                      });
                });

            // API Key (for providers that need it)
            if (['openrouter', 'openai', 'gemini'].includes(ocrSettings.provider)) {
                new Setting(containerEl)
                    .setName(t('ocr.apikey.label'))
                    .setDesc(t('ocr.apikey.desc'))
                    .addText(text => {
                        text.setPlaceholder('sk-...')
                            .setValue(ocrSettings.apiKey || '')
                            .onChange(async (value) => {
                                ocrSettings.apiKey = value.trim();
                                await this.plugin.saveSettings();
                            });
                        text.inputEl.type = 'password';
                    });
            }

            // Endpoint (for ollama/custom)
            if (['ollama', 'custom'].includes(ocrSettings.provider)) {
                new Setting(containerEl)
                    .setName('OCR API Endpoint')
                    .addText(text => text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(ocrSettings.apiEndpoint || '')
                        .onChange(async (value) => {
                            ocrSettings.apiEndpoint = value;
                            await this.plugin.saveSettings();
                        }));
            }

            // Model (Dynamic dropdown based on provider)
            new Setting(containerEl)
                .setName('OCR Model')
                .setDesc('Choose a vision-capable model for OCR.')
                .addDropdown(async dd => {
                    dd.setDisabled(true);
                    dd.addOption('', 'Loading models...');
                    
                    const ocrSettings = this.plugin.settings.ocrProvider;
                    const provider = ocrSettings.provider;
                    
                    try {
                        if (provider === 'openrouter') {
                            const resp = await requestUrl('https://openrouter.ai/api/v1/models');
                            const data = await resp.json;
                            const models = (Array.isArray(data.data) ? data.data : [])
                                .sort((a: any, b: any) => a.name.localeCompare(b.name));
                            
                            dd.selectEl.empty();
                            models.forEach((m: any) => 
                                dd.addOption(m.id, `${m.name} (${m.id})`)
                            );
                            
                            const currentValue = ocrSettings.model || 'google/gemini-flash-1.5';
                            if (!models.some((m: any) => m.id === currentValue)) {
                                dd.addOption(currentValue, `${currentValue} (Saved)`);
                            }
                            dd.setValue(currentValue);
                            
                        } else if (provider === 'openai') {
                            if (ocrSettings.apiKey) {
                                const resp = await requestUrl({
                                    url: 'https://api.openai.com/v1/models',
                                    headers: { 'Authorization': `Bearer ${ocrSettings.apiKey}` }
                                });
                                const data = await resp.json;
                                const models = (data.data || [])
                                    .filter((m: any) => 
                                        m.id.includes('gpt-4o') || 
                                        m.id.includes('gpt-4-turbo') ||
                                        m.id.includes('o1')
                                    )
                                    .sort((a: any, b: any) => a.id.localeCompare(b.id));
                                
                                dd.selectEl.empty();
                                models.forEach((m: any) => dd.addOption(m.id, m.id));
                                
                                const currentValue = ocrSettings.model || 'gpt-4o';
                                if (!models.some((m: any) => m.id === currentValue)) {
                                    dd.addOption(currentValue, `${currentValue} (Saved)`);
                                }
                                dd.setValue(currentValue);
                            } else {
                                const defaultModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
                                dd.selectEl.empty();
                                defaultModels.forEach(m => dd.addOption(m, m));
                                dd.setValue(ocrSettings.model || 'gpt-4o');
                            }
                            
                        } else if (provider === 'gemini') {
                            if (ocrSettings.apiKey) {
                                const resp = await requestUrl(
                                    `https://generativelanguage.googleapis.com/v1beta/models?key=${ocrSettings.apiKey}`
                                );
                                const data = await resp.json;
                                const models = (data.models || [])
                                    .filter((m: any) => 
                                        m.name.includes('gemini') && 
                                        (m.supportedGenerationMethods?.includes('generateContent') || 
                                         m.supportedGenerationMethods?.includes('generateMessage'))
                                    )
                                    .map((m: any) => ({ 
                                        name: m.name, 
                                        displayName: m.displayName || m.name.replace('models/', '') 
                                    }));
                                
                                dd.selectEl.empty();
                                models.forEach((m: any) => dd.addOption(m.name, m.displayName));
                                
                                const currentValue = ocrSettings.model || 'models/gemini-1.5-flash';
                                dd.setValue(currentValue);
                            } else {
                                const defaultModels = [
                                    { name: 'models/gemini-1.5-pro', displayName: 'gemini-1.5-pro' },
                                    { name: 'models/gemini-1.5-flash', displayName: 'gemini-1.5-flash' },
                                    { name: 'models/gemini-2.0-flash-exp', displayName: 'gemini-2.0-flash-exp' }
                                ];
                                dd.selectEl.empty();
                                defaultModels.forEach(m => dd.addOption(m.name, m.displayName));
                                dd.setValue(ocrSettings.model || 'models/gemini-1.5-flash');
                            }
                            
                        } else if (provider === 'ollama') {
                            const endpoint = ocrSettings.apiEndpoint || 'http://localhost:11434';
                            try {
                                const resp = await requestUrl({ url: `${endpoint}/api/tags` });
                                const data = await resp.json;
                                dd.selectEl.empty();
                                
                                if (data.models && data.models.length > 0) {
                                    let visionModels = data.models.filter((m: any) => 
                                        m.name.includes('llava') || 
                                        m.name.includes('moondream') || 
                                        m.name.includes('bakllava') ||
                                        m.name.includes('vision')
                                    );
                                    
                                    if (visionModels.length === 0) {
                                        visionModels = data.models;
                                    }
                                    
                                    visionModels.forEach((m: any) => dd.addOption(m.name, m.name));
                                    dd.setValue(ocrSettings.model || visionModels[0].name);
                                } else {
                                    dd.addOption('', 'No models found');
                                    dd.setValue('');
                                }
                            } catch(e) {
                                console.error("Error fetching Ollama models:", e);
                                dd.selectEl.empty();
                                dd.addOption(ocrSettings.model || 'llava', `(Enter model name manually)`);
                                dd.setValue(ocrSettings.model || 'llava');
                            }
                            
                        } else if (provider === 'custom') {
                            dd.selectEl.empty();
                            dd.addOption('', 'Custom provider - enter model in Request Body');
                            dd.setValue('');
                        }
                        
                    } catch (err) {
                        console.error(`Failed to load ${provider} models for OCR:`, err);
                        dd.selectEl.empty();
                        dd.addOption(ocrSettings.model || 'google/gemini-flash-1.5', 'Current setting (offline)');
                        dd.setValue(ocrSettings.model || 'google/gemini-flash-1.5');
                        new Notice(`⚠️ Could not load ${provider} models. Using current setting.`);
                    }
                    
                    dd.setDisabled(false);
                    dd.onChange(async (value) => {
                        ocrSettings.model = value;
                        await this.plugin.saveSettings();
                    });
                });

            // Temperature
            new Setting(containerEl)
                .setName('OCR Temperature')
                .setDesc('Lower is more deterministic. Recommended: 0.1 for structured OCR output.')
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.05)
                    .setValue(ocrSettings.temperature ?? 0.1)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        ocrSettings.temperature = value;
                        await this.plugin.saveSettings();
                    }));

            // Max Tokens
            new Setting(containerEl)
                .setName('Max Output Tokens')
                .setDesc('Maximum tokens for OCR response. Increase for dense pages.')
                .addSlider(slider => slider
                    .setLimits(1024, 32768, 1024)
                    .setValue(ocrSettings.maxTokens ?? 8192)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        ocrSettings.maxTokens = value;
                        await this.plugin.saveSettings();
                    }));

            // ════════════════════════════════════════════════════════
            // 🆕 NEW: JSON Strictness for Ollama / small models
            // ════════════════════════════════════════════════════════
            if (ocrSettings.provider === 'ollama') {
                containerEl.createEl('p', {
                    text: 'Small vision models (e.g., llava:7b, moondream) often struggle with perfect JSON. ' +
                          'Select a strictness level that matches your model’s capability.',
                    cls: 'setting-item-description'
                });
            }

            // ── OCR Output ──
            containerEl.createEl('hr');
            containerEl.createEl('h4', { text: t('ocr.output.section') });

            {
                // Output folder (with folder autocomplete)
                new Setting(containerEl)
                    .setName(t('ocr.folder.label'))
                    .setDesc(t('ocr.folder.desc'))
                    .then(setting => {
                        setting.controlEl.style.position = 'relative';
                        const fs = new FolderSuggest(this.app, setting.controlEl);
                        fs.setValue(ocrSettings.ocrOutputFolder || '');
                        fs.onChange(async (value) => {
                            ocrSettings.ocrOutputFolder = value.trim();
                            await this.plugin.saveSettings();
                        });
                    });

                // Filename pattern
                new Setting(containerEl)
                    .setName(t('ocr.pattern.label'))
                    .setDesc(t('ocr.pattern.desc'))
                    .addText(text => text
                        .setPlaceholder('{pdfname}.translated')
                        .setValue(ocrSettings.ocrOutputFilenamePattern || '{pdfname}.translated')
                        .onChange(async (value) => {
                            ocrSettings.ocrOutputFilenamePattern = value.trim() || '{pdfname}.translated';
                            await this.plugin.saveSettings();
                        }));

                // Transcription prompt (text mode; no JSON)
                new Setting(containerEl)
                    .setName(t('ocr.prompt.label'))
                    .setDesc(t('ocr.prompt.desc'))
                    .then(setting => {
                        setting.controlEl.style.flexDirection = 'column';
                        setting.controlEl.style.alignItems = 'flex-end';
                        const ta = new TextAreaComponent(setting.controlEl)
                            .setValue(ocrSettings.ocrTextPromptTemplate || DEFAULT_OCR_TEXT_PROMPT)
                            .onChange(async (value) => {
                                ocrSettings.ocrTextPromptTemplate = value;
                                await this.plugin.saveSettings();
                            });
                        ta.inputEl.style.width = '100%';
                        ta.inputEl.rows = 8;
                        ta.inputEl.style.fontFamily = 'monospace';
                        ta.inputEl.style.fontSize = '12px';
                        new ButtonComponent(setting.controlEl)
                            .setButtonText(t('prompts.restore'))
                            .onClick(async () => {
                                ocrSettings.ocrTextPromptTemplate = DEFAULT_OCR_TEXT_PROMPT;
                                await this.plugin.saveSettings();
                                ta.setValue(DEFAULT_OCR_TEXT_PROMPT);
                            })
                            .buttonEl.style.marginTop = '8px';
                    });

                new Setting(containerEl)
                    .setName(t('ocr.scale.label'))
                    .setDesc(t('ocr.scale.desc'))
                    .addSlider(slider => slider
                        .setLimits(1, 4, 0.5)
                        .setValue(ocrSettings.imageScale ?? 2)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            ocrSettings.imageScale = value;
                            await this.plugin.saveSettings();
                        }));

                containerEl.createEl('p', {
                    text: t('ocr.hint'),
                    cls: 'setting-item-description',
                });
            }

        }

        // ============================================================
        // PDF EXPORT SETTINGS
        // ============================================================
        
        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: t('export.section') });
        containerEl.createEl('p', {
            text: t('export.section.desc'),
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName(t('export.script.label'))
            .setDesc(t('export.script.desc'))
            .addText(text => text
                .setPlaceholder('/path/to/pdf_export.py')
                .setValue(this.plugin.settings.pdfExportScriptPath || '')
                .onChange(async (value) => {
                    this.plugin.settings.pdfExportScriptPath = value;
                    await this.plugin.saveSettings();
                }));

        // Test Setup Button
        new Setting(containerEl)
            .setName(t('export.test.label'))
            .setDesc(t('export.test.desc'))
            .addButton(button => button
                .setButtonText(t('export.test.btn'))
                .onClick(async () => {
                    await this.testExportSetup();
                }));

        containerEl.createEl('p', {
            text: 'Export rendering options (font sizing, per-segment color) are controlled per export in the export modal. The exported PDF draws a white background behind each translated block and uses each block\u2019s own text color.',
            cls: 'setting-item-description'
        });

        // Custom Copy Formats live here, next to export, since both concern
        // getting translated content OUT of the plugin.
        this.renderCopyFormats(containerEl);

        // ============================================================
        // End of PDF Export Section
        // ============================================================

        containerEl.createEl('hr');
        new Setting(containerEl)
            .setName(t('debug.label'))
            .setDesc(t('debug.desc'))
            .addToggle(t => t.setValue(this.plugin.settings.debugMode).onChange(async v => {
                this.plugin.settings.debugMode = v; await this.plugin.saveSettings();
            }));
    }

    /** Custom copy-format templates (callout/citation/footnote). Rendered in
     *  the Export area since it concerns getting content out of the plugin. */
    renderCopyFormats(containerEl: HTMLElement): void {
        containerEl.createEl('hr');
        new Setting(containerEl).setName(t('export.formats.section')).setHeading();

        const placeholderDesc = createFragment(doc => {
            doc.createSpan({ text: 'Placeholders: ' });
            doc.createEl('code', { text: '{text}' });
            doc.createSpan({ text: ', ' });
            doc.createEl('code', { text: '{blockquote_text}' });
            doc.createSpan({ text: ', ' });
            doc.createEl('code', { text: '{filename}' });
            doc.createSpan({ text: ', ' });
            doc.createEl('code', { text: '{pagelink}' });
            doc.createSpan({ text: ', ' });
            doc.createEl('code', { text: '{pagenumber}' });
        });

        const createFormatSetting = (name: string, settingKey: 'calloutFormat' | 'citationFormat' | 'footnoteFormat') => {
            new Setting(containerEl)
                .setName(name)
                .setDesc(placeholderDesc)
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';

                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings[settingKey]).onChange(async v => {
                            this.plugin.settings[settingKey] = v; await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 5;

                    new ButtonComponent(setting.controlEl).setButtonText(t('prompts.restore')).onClick(async () => {
                        this.plugin.settings[settingKey] = DEFAULT_SETTINGS[settingKey];
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS[settingKey]);
                    }).buttonEl.style.marginTop = '8px';
                });
        };

        createFormatSetting(t('export.formats.callout'), 'calloutFormat');
        createFormatSetting(t('export.formats.citation'), 'citationFormat');
        createFormatSetting(t('export.formats.footnote'), 'footnoteFormat');
    }

    /**
     * Fetch the list of available model IDs for a translation provider directly
     * from its API. Returns [] on failure (caller falls back to manual entry).
     * This replaces hardcoded model lists with live data.
     */
    async fetchModelsFor(provider: string, ps: any): Promise<{ id: string; label: string }[]> {
        try {
            if (provider === 'openrouter') {
                const resp = await requestUrl('https://openrouter.ai/api/v1/models');
                const data = await resp.json;
                return (Array.isArray(data.data) ? data.data : [])
                    .map((m: any) => ({ id: m.id, label: `${m.name || m.id}` }))
                    .sort((a: any, b: any) => a.label.localeCompare(b.label));
            }
            if (provider === 'openai') {
                if (!ps.apiKey) return [];
                const resp = await requestUrl({
                    url: 'https://api.openai.com/v1/models',
                    headers: { 'Authorization': `Bearer ${ps.apiKey}` },
                });
                const data = await resp.json;
                return (Array.isArray(data.data) ? data.data : [])
                    // Keep chat-capable families; exclude embeddings/audio/image/moderation.
                    .filter((m: any) => /^(gpt|o\d|chatgpt)/i.test(m.id) &&
                        !/(embedding|whisper|tts|audio|image|moderation|dall)/i.test(m.id))
                    .map((m: any) => ({ id: m.id, label: m.id }))
                    .sort((a: any, b: any) => a.id.localeCompare(b.id));
            }
            if (provider === 'gemini') {
                if (!ps.apiKey) return [];
                const resp = await requestUrl(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${ps.apiKey}`
                );
                const data = await resp.json;
                return (Array.isArray(data.models) ? data.models : [])
                    .filter((m: any) =>
                        /gemini/i.test(m.name) &&
                        (!m.supportedGenerationMethods ||
                         m.supportedGenerationMethods.includes('generateContent')))
                    .map((m: any) => ({ id: m.name, label: m.displayName || m.name }));
            }
            if (provider === 'ollama') {
                const endpoint = ps.apiEndpoint || 'http://localhost:11434';
                const resp = await requestUrl({ url: `${endpoint}/api/tags` });
                const data = await resp.json;
                return (Array.isArray(data.models) ? data.models : [])
                    .map((m: any) => ({ id: m.name, label: m.name }));
            }
        } catch (e) {
            console.error(`Failed to fetch models for ${provider}:`, e);
        }
        return [];
    }

    /**
     * Build a Model setting: a dropdown populated from the live API plus a
     * Refresh button, and a manual-entry fallback so unusual/new model IDs are
     * always reachable even if the API list is incomplete.
     */
    buildModelSetting(
        containerEl: HTMLElement,
        provider: string,
        ps: any,
        fallback: string,
    ): void {
        const setting = new Setting(containerEl)
            .setName('Model')
            .setDesc('Fetched live from the provider. Use Refresh after entering your key, or type a model ID manually below.');

        let dropdown: import('obsidian').DropdownComponent | null = null;

        const populate = async (models: { id: string; label: string }[]) => {
            if (!dropdown) return;
            dropdown.selectEl.empty();
            if (models.length === 0) {
                dropdown.addOption('', '(no models — enter manually)');
            } else {
                models.forEach(m => dropdown!.addOption(m.id, m.label));
            }
            const current = ps.model || fallback;
            if (current && !models.find(m => m.id === current)) {
                dropdown.addOption(current, `${current} (saved)`);
            }
            dropdown.setValue(current || '');
        };

        setting.addDropdown(dd => {
            dropdown = dd;
            dd.addOption(ps.model || fallback || '', 'Loading…');
            dd.setValue(ps.model || fallback || '');
            dd.onChange(async v => { ps.model = v; await this.plugin.saveSettings(); });
            // Initial fetch.
            this.fetchModelsFor(provider, ps).then(populate);
        });

        setting.addExtraButton(b => b
            .setIcon('refresh-cw')
            .setTooltip('Refresh model list')
            .onClick(async () => {
                new Notice(t('provider.model.refresh.notice.loading'));
                const models = await this.fetchModelsFor(provider, ps);
                await populate(models);
                new Notice(models.length ? t('provider.model.refresh.notice.ok',{n:models.length}) : t('provider.model.refresh.notice.empty'));
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
     * Tests the PDF export setup by running a simple Python command
     */
    async testExportSetup(): Promise<void> {
        const { pythonPath, pdfExportScriptPath } = this.plugin.settings;

        if (!pythonPath) {
            new Notice('Python path is not configured');
            return;
        }

        if (!pdfExportScriptPath) {
            new Notice('PDF export script path is not configured');
            return;
        }

        new Notice('Testing export setup...');

        try {
            const { spawn } = require('child_process');
            
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
                    new Notice(`✓ Python found: ${pythonOutput.trim()}`);
                    this.testPyMuPDF(pythonPath);
                } else {
                    new Notice('✗ Python test failed. Check console for details.');
                    console.error('Python test output:', pythonOutput);
                }
            });

            pythonTest.on('error', (err: any) => {
                new Notice('✗ Could not run Python. Check path in settings.');
                console.error('Python spawn error:', err);
            });

        } catch (error) {
            new Notice('✗ Error testing export setup');
            console.error('Test error:', error);
        }
    }

    /**
     * Tests PyMuPDF installation
     */
    async testPyMuPDF(pythonPath: string): Promise<void> {
        const { spawn } = require('child_process');
        
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
                new Notice(`✓ PyMuPDF found: version ${output.trim()}`);
                this.testScriptExists();
            } else {
                new Notice('✗ PyMuPDF not found. Install: pip install PyMuPDF');
                console.error('PyMuPDF test output:', output);
            }
        });

        test.on('error', (err: any) => {
            new Notice('✗ Error testing PyMuPDF');
            console.error('PyMuPDF test error:', err);
        });
    }

    /**
     * Tests if the export script exists
     */
    async testScriptExists(): Promise<void> {
        const { pdfExportScriptPath } = this.plugin.settings;
        
        try {
            const fs = require('fs');
            
            if (fs.existsSync(pdfExportScriptPath)) {
                new Notice(`✓ Export script found at ${pdfExportScriptPath}`);
                new Notice('✓ All export prerequisites met!');
            } else {
                new Notice('✗ Export script not found. Check path in settings.');
            }
        } catch (error) {
            new Notice('✗ Error checking script path');
            console.error('Script check error:', error);
        }
    }
}
