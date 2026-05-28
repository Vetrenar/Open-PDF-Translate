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
    TFolder
} from 'obsidian';
import OpenRouterTranslatorPlugin from './main';
import {
    AVAILABLE_LANGUAGES,
    DEFAULT_SETTINGS,
    GEMMA_TEMPLATE,
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

    constructor(app: App, containerEl: HTMLElement) {
        super(containerEl);
        this.app = app;
        this.setPlaceholder('e.g. My Translations/');
        this.inputEl.addEventListener('input', this.onInput.bind(this));
        this.inputEl.addEventListener('blur', this.onBlur.bind(this));
    }

    onInput() {
        const query = this.getValue().toLowerCase();
        const abstractFiles = this.app.vault.getAllLoadedFiles();
        const folders = abstractFiles.filter(f => f instanceof TFolder).map(f => f.path);
        
        const suggestions = folders.filter(p => p.toLowerCase().includes(query));
        this.setSuggestions(suggestions);
    }

    setSuggestions(suggestions: string[]) {
        const dropdown = this.inputEl.parentElement?.querySelector('.suggestion-dropdown');
        if (dropdown) dropdown.remove();

        if (suggestions.length > 0 && this.getValue()) {
            const drop = createEl('div', { cls: 'suggestion-dropdown' });
            drop.style.position = 'absolute';
            drop.style.top = this.inputEl.offsetTop + this.inputEl.offsetHeight + 'px';
            drop.style.left = this.inputEl.offsetLeft + 'px';
            drop.style.width = this.inputEl.offsetWidth + 'px';
            drop.style.zIndex = '1000';
            drop.style.background = 'var(--background-secondary)';
            drop.style.border = '1px solid var(--background-modifier-border)';
            drop.style.borderRadius = '4px';
            drop.style.maxHeight = '200px';
            drop.style.overflowY = 'auto';
            drop.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';

            suggestions.forEach(sug => {
                const item = createEl('div', { text: sug, cls: 'suggestion-item' });
                item.style.padding = '6px 10px';
                item.style.cursor = 'pointer';
                
                item.addEventListener('mouseenter', () => item.style.background = 'var(--background-modifier-hover)');
                item.addEventListener('mouseleave', () => item.style.background = '');
                
                item.onclick = () => {
                    this.setValue(sug);
                    this.inputEl.dispatchEvent(new Event('blur'));
                    drop.remove();
                };
                drop.appendChild(item);
            });

            this.inputEl.parentElement?.appendChild(drop);
        }
    }

    onBlur() {
        setTimeout(() => {
            const dropdown = this.inputEl.parentElement?.querySelector('.suggestion-dropdown');
            if (dropdown) dropdown.remove();
        }, 200);
    }
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
            new Setting(containerEl).setName('OpenAI Settings').setHeading();

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

            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose an OpenAI model.')
                .addDropdown(async dd => {
                    dd.setDisabled(true);
                    
                    const defaultModels = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];
                    let models = defaultModels.map(m => ({ id: m, name: m }));

                    if (providerSettings.apiKey) {
                        try {
                            const resp = await requestUrl({
                                url: 'https://api.openai.com/v1/models',
                                headers: { 'Authorization': `Bearer ${providerSettings.apiKey}` }
                            });
                            const data = await resp.json;
                            if (data.data && Array.isArray(data.data)) {
                                models = data.data
                                    .filter((m: any) => m.id.includes('gpt') || m.id.includes('o1'))
                                    .sort((a: any, b: any) => a.id.localeCompare(b.id));
                            }
                        } catch (e) {
                            console.error('Failed to fetch OpenAI models', e);
                            new Notice('Could not fetch OpenAI models. Using default list.');
                        }
                    }

                    dd.selectEl.empty();
                    models.forEach(m => dd.addOption(m.id, m.id));
                    
                    const currentModel = providerSettings.model || 'gpt-4o';
                    if (!models.find(m => m.id === currentModel)) {
                        dd.addOption(currentModel, `${currentModel} (Saved)`);
                    }
                    dd.setValue(currentModel);
                    dd.setDisabled(false);

                    dd.onChange(async v => {
                        providerSettings.model = v;
                        await this.plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName('Temperature')
                .setDesc('Controls randomness (0 = deterministic, 1 = creative). Recommended: 0.3 for translation. Note: O1/O3 models ignore this setting.')
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
                .setDesc('Enable extended thinking for O1/O3 models. Increases accuracy for complex translations but may increase latency.')
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
            new Setting(containerEl).setName('Google Gemini Settings').setHeading();

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

            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose a Gemini model.')
                .addDropdown(async dd => {
                    dd.setDisabled(true);

                    const defaultModels = ['gemini-2.0-flash-thinking-exp', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];
                    let models = defaultModels.map(m => ({ name: `models/${m}`, displayName: m }));

                    if (providerSettings.apiKey) {
                        try {
                            const resp = await requestUrl(
                                `https://generativelanguage.googleapis.com/v1beta/models?key=${providerSettings.apiKey}`
                            );
                            const data = await resp.json;
                            if (data.models && Array.isArray(data.models)) {
                                models = data.models
                                    .filter((m: any) => m.name.includes('gemini'))
                                    .map((m: any) => ({ name: m.name, displayName: m.displayName || m.name }));
                            }
                        } catch (e) {
                            console.error('Failed to fetch Gemini models', e);
                        }
                    }

                    dd.selectEl.empty();
                    models.forEach(m => dd.addOption(m.name, m.displayName));
                    
                    const currentModel = providerSettings.model || 'models/gemini-1.5-flash';
                    dd.setValue(currentModel);
                    dd.setDisabled(false);

                    dd.onChange(async v => {
                        providerSettings.model = v;
                        await this.plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName('Temperature')
                .setDesc('Controls randomness (0 = deterministic, 1 = creative). Recommended: 0.3 for translation.')
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
            new Setting(containerEl).setName('OpenRouter Settings').setHeading();

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

            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose a model (e.g., google/gemini-flash-1.5, deepseek/deepseek-r1)')
                .addDropdown(async dd => {
                    dd.setDisabled(true);
                    dd.addOption('', 'Loading models...');
                    
                    try {
                        const resp = await requestUrl('https://openrouter.ai/api/v1/models');
                        const data = await resp.json;
                        const models = (Array.isArray(data.data) ? data.data : [])
                            .sort((a: any, b: any) => a.name.localeCompare(b.name));

                        dd.selectEl.empty();
                        models.forEach((m: any) => dd.addOption(m.id, `${m.name} (${m.id})`));
                        
                        dd.setValue(providerSettings.model || 'google/gemini-flash-1.5');
                    } catch (err) {
                        console.error('Failed to load models from OpenRouter:', err);
                        dd.selectEl.empty();
                        dd.addOption(providerSettings.model || 'google/gemini-flash-1.5', 'Default');
                        dd.setValue(providerSettings.model || 'google/gemini-flash-1.5');
                        new Notice('⚠️ Could not load models. Using current setting.');
                    }
                    dd.setDisabled(false);

                    dd.onChange(async v => {
                        providerSettings.model = v;
                        await this.plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName('Temperature')
                .setDesc('Controls randomness (0 = deterministic, 1 = creative). Recommended: 0.3 for translation.')
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
                .setDesc('Enable extended thinking for compatible models (DeepSeek R1, QwQ, O1, etc.). May increase latency.')
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
            new Setting(containerEl).setName('Ollama (Local) Settings').setHeading();

            new Setting(containerEl)
                .setName('Ollama API Endpoint')
                .setDesc('The local URL for your Ollama server.')
                .addText(text => text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(providerSettings.apiEndpoint || '')
                    .onChange(async (value) => {
                        providerSettings.apiEndpoint = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            new Setting(containerEl)
                .setName('Model')
                .setDesc('Choose a local model to use.')
                .addDropdown(async dd => {
                    dd.setDisabled(true);
                    dd.addOption('', 'Fetching local models...');
                    
                    const endpoint = providerSettings.apiEndpoint || 'http://localhost:11434';
                    try {
                        const resp = await requestUrl({ url: `${endpoint}/api/tags` });
                        const data = await resp.json;
                        
                        dd.selectEl.empty();
                        if (data.models && data.models.length > 0) {
                             data.models.forEach((m: any) => dd.addOption(m.name, m.name));
                             dd.setValue(providerSettings.model || data.models[0].name);
                        } else {
                            dd.addOption('', 'No models found');
                        }
                    } catch(e) {
                        console.error("Error fetching Ollama models:", e);
                        new Notice(`⚠️ Could not connect to Ollama at ${endpoint}.`);
                        dd.selectEl.empty();
                        dd.addOption(providerSettings.model || 'llama3', `(Enter model name manually)`);
                        dd.setValue(providerSettings.model || 'llama3');
                    }
                    dd.setDisabled(false);

                    dd.onChange(async v => {
                        providerSettings.model = v;
                        await this.plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName('Temperature')
                .setDesc('Controls randomness (0 = deterministic, 1 = creative). Recommended: 0.3 for translation.')
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
            new Setting(containerEl).setName('Custom Endpoint Settings').setHeading();
            
            new Setting(containerEl)
                .setName('API Endpoint URL')
                .addText(t => t.setValue(providerSettings.apiEndpoint || '').onChange(async v => {
                    providerSettings.apiEndpoint = v; await this.plugin.saveSettings();
                }));
            
            new Setting(containerEl)
                .setName('API Key (Optional)')
                .setDesc('Your API key. Use {apiKey} in Headers if needed.')
                .addText(t => {
                    t.setValue(providerSettings.apiKey || '').onChange(async v => {
                        providerSettings.apiKey = v.trim(); await this.plugin.saveSettings();
                    });
                    t.inputEl.type = 'password';
                });

            new Setting(containerEl)
                .setName('Model Name')
                .addText(t => t.setValue(providerSettings.model || '').onChange(async v => {
                    providerSettings.model = v; await this.plugin.saveSettings();
                }));

            new Setting(containerEl)
                .setName('Request Headers (JSON)')
                .setDesc('Use placeholders: {apiKey}')
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
        new Setting(containerEl).setName('General Settings').setHeading();

        // Storage Location
        new Setting(containerEl)
            .setName('Translation Storage Location')
            .setDesc('Choose where to save translation files. Leave empty to save next to each PDF.')
            .addText(text => {
                const folderSuggest = new FolderSuggest(this.app, text.inputEl.parentElement!);
                folderSuggest.setValue(this.plugin.settings.storageLocation);
                folderSuggest.onChange(async (value) => {
                    this.plugin.settings.storageLocation = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Auto-Save Overlay Data')
            .setDesc('Automatically save overlay positions each time you translate.')
            .addToggle(t => t.setValue(this.plugin.settings.autoSaveOverlay).onChange(async v => {
                this.plugin.settings.autoSaveOverlay = v; await this.plugin.saveSettings();
            }));

        // Language Settings
        new Setting(containerEl)
            .setName('Source Language')
            .addDropdown(dd => {
                AVAILABLE_LANGUAGES.forEach(lang => dd.addOption(lang.code, lang.name));
                dd.setValue(this.plugin.settings.sourceLanguage).onChange(async v => {
                    this.plugin.settings.sourceLanguage = v; await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Target Language')
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

        containerEl.createEl('hr');
        
        // --- PROMPTS ---
        new Setting(containerEl).setName('Translation Prompts').setHeading();

        new Setting(containerEl)
            .setName('Use Gemma Template')
            .setDesc('Use a specialized veterinary translation template. When enabled, custom prompts below are ignored.')
            .addToggle(t => t.setValue(this.plugin.settings.useGemmaPrompt).onChange(async v => {
                this.plugin.settings.useGemmaPrompt = v; 
                await this.plugin.saveSettings();
                this.display();
            }));

        if (this.plugin.settings.useGemmaPrompt) {
            new Setting(containerEl)
                .setName('Active Gemma Template (Read-Only)')
                .setDesc('This specialized template will be used for all translations.')
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';
                    
                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(GEMMA_TEMPLATE);
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 6;
                    textarea.setDisabled(true);
                });

        } else {
            new Setting(containerEl)
                .setName('Batch Translation Prompt')
                .setDesc('System prompt for batch translations. Placeholders: {sourceLang}, {targetLang}, {lineCount}, {inputText}')
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';
                    
                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings.batchPrompt).onChange(async v => {
                            this.plugin.settings.batchPrompt = v; await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 8;

                    new ButtonComponent(setting.controlEl).setButtonText('Restore Default').onClick(async () => {
                        this.plugin.settings.batchPrompt = DEFAULT_SETTINGS.batchPrompt;
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS.batchPrompt);
                    }).buttonEl.style.marginTop = '8px';
                });

            new Setting(containerEl)
                .setName('Single Sentence Prompt')
                .setDesc('System prompt for single translations. Placeholders: {sourceLang}, {targetLang}')
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';
                    
                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(this.plugin.settings.singlePrompt).onChange(async v => {
                            this.plugin.settings.singlePrompt = v; await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 4;

                    new ButtonComponent(setting.controlEl).setButtonText('Restore Default').onClick(async () => {
                        this.plugin.settings.singlePrompt = DEFAULT_SETTINGS.singlePrompt;
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS.singlePrompt);
                    }).buttonEl.style.marginTop = '8px';
                });
        }

        // --- CUSTOM COPY FORMATS ---
        containerEl.createEl('hr');
        new Setting(containerEl).setName('Custom Copy Formats').setHeading();

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

                    new ButtonComponent(setting.controlEl).setButtonText('Restore Default').onClick(async () => {
                        this.plugin.settings[settingKey] = DEFAULT_SETTINGS[settingKey];
                        await this.plugin.saveSettings();
                        textarea.setValue(DEFAULT_SETTINGS[settingKey]);
                    }).buttonEl.style.marginTop = '8px';
                });
        };

        createFormatSetting('Callout Format', 'calloutFormat');
        createFormatSetting('Citation Format', 'citationFormat');
        createFormatSetting('Footnote Format', 'footnoteFormat');

        // Visuals and Processing
        containerEl.createEl('hr');
        new Setting(containerEl).setName('Visual & Processing Settings').setHeading();

        new Setting(containerEl)
            .setName('Output Font Size Scale')
            .addSlider(s => s.setLimits(0.4, 1.2, 0.05).setValue(this.plugin.settings.outputFontSizeScale).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.outputFontSizeScale = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Output Line Height')
            .addSlider(s => s.setLimits(0.5, 2.0, 0.05).setValue(this.plugin.settings.outputLineHeight).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.outputLineHeight = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Max Batch Input Length')
            .setDesc('Maximum characters sent at once to prevent API errors.')
            .addSlider(s => s.setLimits(50, 15000, 50).setValue(this.plugin.settings.maxBatchChars).setDynamicTooltip().onChange(async v => {
                this.plugin.settings.maxBatchChars = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('BBox Edit Mode')
            .setDesc('Enable selecting one or multiple overlay boxes and applying bulk actions from right-click menu.')
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
        containerEl.createEl('h3', { text: 'Layout Engine' });
        containerEl.createEl('p', {
            text: 'Choose how the plugin detects text positions on PDF pages.',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Layout Engine')
            .setDesc('Internal = parse browser text layer. Python = local script. OCR API = send to AI model.')
            .addDropdown(dd => {
                dd.addOption('internal', 'Internal (DOM Text Layer)')
                  .addOption('python', 'External Python Script')
                  .addOption('ocr-api', 'OCR via AI Model (API)')
                  .setValue(this.plugin.settings.layoutEngine)
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
                .setName('Python Interpreter Path')
                .setDesc('Absolute path to your Python executable.')
                .addText(text => text
                    .setPlaceholder('python')
                    .setValue(this.plugin.settings.pythonPath)
                    .onChange(async (value) => {
                        this.plugin.settings.pythonPath = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Layout Script Path')
                .setDesc('Absolute path to the "layout_engine.py" script.')
                .addText(text => text
                    .setPlaceholder('/path/to/layout_engine.py')
                    .setValue(this.plugin.settings.ocrScriptPath)
                    .onChange(async (value) => {
                        this.plugin.settings.ocrScriptPath = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // ── OCR API Engine Settings ──
        if (engine === 'ocr-api') {
            const ocrSettings = this.plugin.settings.ocrProvider;

            containerEl.createEl('h4', { text: 'OCR Model Provider' });
            containerEl.createEl('p', {
                text: 'Configure the AI model used for OCR. This is separate from your translation model.',
                cls: 'setting-item-description'
            });

            // Provider Selection
            new Setting(containerEl)
                .setName('OCR Provider')
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
                    .setName('OCR API Key')
                    .setDesc('API key for the OCR model (can be different from translation key).')
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
            
            new Setting(containerEl)
                .setName('JSON strictness')
                .setDesc(
                    ocrSettings.provider === 'ollama'
                        ? 'Strict = perfect JSON required; Lenient = strict formatting instructions; Repair‑friendly = accept imperfect output (will be auto‑repaired).'
                        : 'Controls how strictly the model must follow JSON formatting. For Ollama small models, use lenient or repair‑friendly.'
                )
                .addDropdown(dd => {
                    dd.addOption('strict', 'Strict (perfect JSON)')
                      .addOption('lenient', 'Lenient (strict instructions)')
                      .addOption('repair-friendly', 'Repair‑friendly (allow imperfect)')
                      .setValue(ocrSettings.jsonStrictness || 'strict')
                      .onChange(async (value: 'strict' | 'lenient' | 'repair-friendly') => {
                          ocrSettings.jsonStrictness = value;
                          await this.plugin.saveSettings();
                          this.display();
                      });
                });

            containerEl.createEl('hr');
            containerEl.createEl('h4', { text: 'OCR Workflow' });

            // Input Mode
            new Setting(containerEl)
                .setName('Input Mode')
                .setDesc('"Image" = capture page as image and send to vision model. "File Path" = inject file path into prompt (for local models).')
                .addDropdown(dd => {
                    dd.addOption('image', 'Image (Vision API)')
                      .addOption('filepath', 'File Path (in prompt)')
                      .setValue(ocrSettings.inputMode)
                      .onChange(async (value: any) => {
                          ocrSettings.inputMode = value;
                          await this.plugin.saveSettings();
                          this.display();
                      });
                });

            // Image settings (only if image mode)
            if (ocrSettings.inputMode === 'image') {
                new Setting(containerEl)
                    .setName('Image Scale')
                    .setDesc('Resolution multiplier (2x recommended for OCR quality).')
                    .addSlider(slider => slider
                        .setLimits(1, 4, 0.5)
                        .setValue(ocrSettings.imageScale ?? 2)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            ocrSettings.imageScale = value;
                            await this.plugin.saveSettings();
                        }));

                new Setting(containerEl)
                    .setName('Image Format')
                    .addDropdown(dd => {
                        dd.addOption('png', 'PNG (lossless)')
                          .addOption('jpeg', 'JPEG (smaller)')
                          .setValue(ocrSettings.imageFormat || 'png')
                          .onChange(async (value: any) => {
                              ocrSettings.imageFormat = value;
                              await this.plugin.saveSettings();
                          });
                    });
            }

            // Workflow Mode
            new Setting(containerEl)
                .setName('Workflow')
                .setDesc('"Per page" = OCR on demand when you translate a page. "Full document" = pre-OCR all pages, cache to disk, translate later.')
                .addDropdown(dd => {
                    dd.addOption('per-page', 'Per Page (on demand)')
                      .addOption('full-document', 'Full Document (pre-cache)')
                      .setValue(ocrSettings.workflowMode)
                      .onChange(async (value: any) => {
                          ocrSettings.workflowMode = value;
                          await this.plugin.saveSettings();
                      });
                });

            containerEl.createEl('hr');
            containerEl.createEl('h4', { text: 'OCR Prompt Template' });

            // Prompt Template
            new Setting(containerEl)
                .setName('OCR Prompt')
                .setDesc('Prompt sent to the OCR model. Placeholders: {{absoluteFilePath}}, {{pageNumber}}, {{totalPages}}')
                .then(setting => {
                    setting.controlEl.style.flexDirection = 'column';
                    setting.controlEl.style.alignItems = 'flex-end';

                    const textarea = new TextAreaComponent(setting.controlEl)
                        .setValue(ocrSettings.ocrPromptTemplate)
                        .onChange(async (value) => {
                            ocrSettings.ocrPromptTemplate = value;
                            await this.plugin.saveSettings();
                        });
                    textarea.inputEl.style.width = '100%';
                    textarea.inputEl.rows = 12;
                    textarea.inputEl.style.fontFamily = 'monospace';
                    textarea.inputEl.style.fontSize = '12px';

                    // 🆕 Restore default button now uses the context‑aware helper
                    new ButtonComponent(setting.controlEl)
                        .setButtonText('Restore Default')
                        .onClick(async () => {
                            const defaultPrompt = getDefaultOcrPrompt(ocrSettings);
                            ocrSettings.ocrPromptTemplate = defaultPrompt;
                            await this.plugin.saveSettings();
                            textarea.setValue(defaultPrompt);
                        })
                        .buttonEl.style.marginTop = '8px';
                });

            // Custom response path (for custom providers)
            if (ocrSettings.provider === 'custom') {
                new Setting(containerEl)
                    .setName('Response JSON Path')
                    .setDesc('JSON path to extract content from response (e.g., choices[0].message.content)')
                    .addText(text => text
                        .setValue(ocrSettings.responseJsonPath || '')
                        .onChange(async (value) => {
                            ocrSettings.responseJsonPath = value;
                            await this.plugin.saveSettings();
                        }));

                new Setting(containerEl)
                    .setName('Custom Headers (JSON)')
                    .setDesc('Use {apiKey} placeholder.')
                    .addTextArea(ta => {
                        ta.setValue(ocrSettings.headers || '{}')
                          .onChange(async v => {
                              ocrSettings.headers = v;
                              await this.plugin.saveSettings();
                          });
                        ta.inputEl.rows = 3;
                    });

                new Setting(containerEl)
                    .setName('Custom Request Body (JSON Template)')
                    .setDesc('Placeholders: {model}, {prompt}, {imageBase64}, {imageMimeType}, {temperature}, {maxTokens}')
                    .addTextArea(ta => {
                        ta.setValue(ocrSettings.requestBody || '{}')
                          .onChange(async v => {
                              ocrSettings.requestBody = v;
                              await this.plugin.saveSettings();
                          });
                        ta.inputEl.rows = 10;
                    });
            }

            // Cache Management
            containerEl.createEl('hr');
            containerEl.createEl('h4', { text: 'OCR Cache' });

            new Setting(containerEl)
                .setName('Clear OCR Cache')
                .setDesc('Remove the cached OCR data for the currently open PDF.')
                .addButton(btn => btn
                    .setButtonText('Clear Current PDF Cache')
                    .setWarning()
                    .onClick(async () => {
                        const file = this.plugin.app.workspace.getActiveFile();
                        if (file && file.extension === 'pdf') {
                            await this.plugin.ocrLayout.clearCache(file.path);
                            new Notice('OCR cache cleared for this PDF.');
                        } else {
                            new Notice('No PDF is currently open.');
                        }
                    }));

            // Test OCR Button
            new Setting(containerEl)
                .setName('Test OCR Setup')
                .setDesc('Run OCR on the current page to verify your settings.')
                .addButton(btn => btn
                    .setButtonText('Test Current Page')
                    .onClick(async () => {
                        const file = this.plugin.app.workspace.getActiveFile();
                        const pageEl = this.plugin.getCurrentPageElement();
                        if (file && file.extension === 'pdf' && pageEl) {
                            const pageNum = parseInt(pageEl.getAttribute('data-page-number') || '1', 10);
                            const result = await this.plugin.ocrLayout.ocrPage(file, pageNum, pageEl);
                            if (result) {
                                new Notice(`✅ Test passed: found ${result.length} text blocks.`);
                                console.log('OCR Test Result:', result);
                            }
                        } else {
                            new Notice('Open a PDF and navigate to a page first.');
                        }
                    }));
        }

        // ============================================================
        // End of Layout Engine Section
        // ============================================================

        // ============================================================
        // PDF EXPORT SETTINGS
        // ============================================================
        
        containerEl.createEl('hr');
        containerEl.createEl('h3', { text: 'PDF Export Settings' });
        containerEl.createEl('p', {
            text: 'Export PDFs with translation overlays permanently merged. Requires PyMuPDF (pip install PyMuPDF).',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('PDF Export Script Path')
            .setDesc('Absolute path to the "pdf_export.py" script.')
            .addText(text => text
                .setPlaceholder('/path/to/pdf_export.py')
                .setValue(this.plugin.settings.pdfExportScriptPath || '')
                .onChange(async (value) => {
                    this.plugin.settings.pdfExportScriptPath = value;
                    await this.plugin.saveSettings();
                }));

        // Test Setup Button
        new Setting(containerEl)
            .setName('Test Export Setup')
            .setDesc('Verify Python and PyMuPDF installation')
            .addButton(button => button
                .setButtonText('Test Setup')
                .onClick(async () => {
                    await this.testExportSetup();
                }));

        containerEl.createEl('h4', { text: 'Default Export Options' });
        containerEl.createEl('p', {
            text: 'These settings are used as defaults when exporting. You can override them in the export modal.',
            cls: 'setting-item-description'
        });

        new Setting(containerEl)
            .setName('Background Color')
            .setDesc('Default color for translation overlay backgrounds (hex format, e.g., #FFFFFF)')
            .addText(text => text
                .setPlaceholder('#FFFFFF')
                .setValue(this.plugin.settings.exportBackgroundColor || '#FFFFFF')
                .onChange(async (value) => {
                    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
                        this.plugin.settings.exportBackgroundColor = value;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Background Opacity')
            .setDesc('Default opacity for translation backgrounds (0-100)')
            .addSlider(slider => slider
                .setLimits(0, 100, 5)
                .setValue(this.plugin.settings.exportBackgroundOpacity || 90)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.exportBackgroundOpacity = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Text Color')
            .setDesc('Default color for translated text (hex format, e.g., #000000)')
            .addText(text => text
                .setPlaceholder('#000000')
                .setValue(this.plugin.settings.exportTextColor || '#000000')
                .onChange(async (value) => {
                    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
                        this.plugin.settings.exportTextColor = value;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Preserve Original Text')
            .setDesc('By default, keep the original text visible under translations')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.exportPreserveOriginal ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.exportPreserveOriginal = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-Open Exported PDFs')
            .setDesc('Automatically open PDFs in Obsidian after export completes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.exportAutoOpen ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.exportAutoOpen = value;
                    await this.plugin.saveSettings();
                }));

        // ============================================================
        // End of PDF Export Section
        // ============================================================

        containerEl.createEl('hr');
        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Log detailed information to the developer console.')
            .addToggle(t => t.setValue(this.plugin.settings.debugMode).onChange(async v => {
                this.plugin.settings.debugMode = v; await this.plugin.saveSettings();
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
