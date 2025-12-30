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
import { AVAILABLE_LANGUAGES, DEFAULT_SETTINGS } from './types';

// === Folder Suggester Component (No changes needed) ===
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
            // Style the dropdown to appear correctly
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
                    this.inputEl.dispatchEvent(new Event('blur')); // Trigger save
                    drop.remove();
                };
                drop.appendChild(item);
            });

            this.inputEl.parentElement?.appendChild(drop);
        }
    }

    onBlur() {
        // Delay hiding to allow click event to register
        setTimeout(() => {
            const dropdown = this.inputEl.parentElement?.querySelector('.suggestion-dropdown');
            if (dropdown) dropdown.remove();
        }, 200);
    }
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
                  .addOption('ollama', 'Ollama (Local)')
                  .addOption('custom', 'Custom Endpoint')
                  .setValue(this.plugin.settings.apiProvider)
                  .onChange(async (value: 'openrouter' | 'ollama' | 'custom') => {
                      this.plugin.settings.apiProvider = value;
                      await this.plugin.saveSettings();
                      // Re-render the settings tab to show provider-specific options
                      this.display();
                  });
            });
        
        containerEl.createEl('hr');
        
        const provider = this.plugin.settings.apiProvider;
        const providerSettings = this.plugin.settings.providerSettings[provider];

        // --- PROVIDER-SPECIFIC SETTINGS ---
        
        if (provider === 'openrouter') {
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
                .setDesc('Choose a model (e.g., google/gemini-flash-1.5 is recommended)')
                .addDropdown(async dd => {
                    dd.setDisabled(true);
                    dd.addOption('', 'Loading models...');
                    
                    try {
                        const resp = await requestUrl('https://openrouter.ai/api/v1/models');
                        const data = await resp.json;
                        const models = (Array.isArray(data.data) ? data.data : [])
                            .sort((a: any, b: any) => a.name.localeCompare(b.name));

                        dd.selectEl.empty(); // Clear "Loading..."
                        models.forEach((m: any) => dd.addOption(m.id, `${m.name} (${m.id})`));
                        
                        dd.setValue(providerSettings.model || 'google/gemini-flash-1.5');
                        dd.setDisabled(false);
                    } catch (err) {
                        console.error('Failed to load models from OpenRouter:', err);
                        dd.selectEl.empty();
                        dd.addOption(providerSettings.model || 'google/gemini-flash-1.5', `Default (${providerSettings.model || 'google/gemini-flash-1.5'})`);
                        dd.setValue(providerSettings.model || 'google/gemini-flash-1.5');
                        new Notice('⚠️ Could not load models. Using current setting.');
                        dd.setDisabled(false);
                    }

                    dd.onChange(async v => {
                        providerSettings.model = v;
                        await this.plugin.saveSettings();
                    });
                });

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
                        // Refresh the settings to re-fetch models
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
                .setDesc('The model identifier to include in the request body.')
                .addText(t => t.setValue(providerSettings.model || '').onChange(async v => {
                    providerSettings.model = v; await this.plugin.saveSettings();
                }));

            new Setting(containerEl)
                .setName('Request Headers (JSON)')
                .setDesc('JSON object for request headers. Use {apiKey} for your key.')
                .addTextArea(ta => {
                    ta.setValue(providerSettings.headers || DEFAULT_SETTINGS.providerSettings.custom.headers)
                    .onChange(async v => { providerSettings.headers = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 4;
                });
            
            new Setting(containerEl)
                .setName('Request Body (JSON Template)')
                .setDesc('JSON template with placeholders: {model}, {systemPrompt}, {userPrompt}.')
                .addTextArea(ta => {
                    ta.setValue(providerSettings.requestBody || DEFAULT_SETTINGS.providerSettings.custom.requestBody)
                    .onChange(async v => { providerSettings.requestBody = v; await this.plugin.saveSettings(); });
                    ta.inputEl.rows = 10;
                });

            new Setting(containerEl)
                .setName('Response Path')
                .setDesc('Dot notation path to the translated text in the response JSON.')
                .addText(t => t
                    .setPlaceholder('e.g., choices[0].message.content')
                    .setValue(providerSettings.responsePath || DEFAULT_SETTINGS.providerSettings.custom.responsePath)
                    .onChange(async v => { providerSettings.responsePath = v; await this.plugin.saveSettings(); }));
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
                text.inputEl.replaceWith(folderSuggest.inputEl);

                folderSuggest.inputEl.addEventListener('blur', async () => {
                    let value = folderSuggest.getValue().trim();
                    if (value === '/' || value === '.' || value === '..') value = '';
                    const normalized = value ? normalizePath(value + (value.endsWith('/') ? '' : '/')) : '';
                    
                    this.plugin.settings.storageLocation = normalized; 
                    await this.plugin.saveSettings();
                    new Notice(`📁 Translation location set to: ${normalized || 'Next to PDF'}`);
                });
            });

        // Translation Behavior
        new Setting(containerEl)
            .setName('Enable Translation')
            .addToggle(t => t.setValue(this.plugin.settings.enableTranslation).onChange(async v => {
                this.plugin.settings.enableTranslation = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Use Batch Translation')
            .setDesc('Send all text in one request (recommended).')
            .addToggle(t => t.setValue(this.plugin.settings.useBatchTranslation).onChange(async v => {
                this.plugin.settings.useBatchTranslation = v; await this.plugin.saveSettings();
            }));
                
        new Setting(containerEl)
            .setName('Auto-save Overlay')
            .addToggle(t => t.setValue(this.plugin.settings.autoSaveOverlay).onChange(async v => {
                this.plugin.settings.autoSaveOverlay = v; await this.plugin.saveSettings();
            }));
                
        new Setting(containerEl)
            .setName('Auto-refresh Translations')
            .setDesc('Automatically re-translate when a PDF is opened.')
            .addToggle(t => t.setValue(this.plugin.settings.autoRefreshOverlay).onChange(async v => {
                this.plugin.settings.autoRefreshOverlay = v; await this.plugin.saveSettings();
            }));

        // Language Settings
        new Setting(containerEl)
            .setName('Source Language')
            .addDropdown(d => {
                AVAILABLE_LANGUAGES.forEach(l => d.addOption(l.code, l.name));
                d.setValue(this.plugin.settings.sourceLanguage).onChange(async v => {
                    this.plugin.settings.sourceLanguage = v; await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Target Language')
            .addDropdown(d => {
                AVAILABLE_LANGUAGES.filter(l => l.code !== 'auto').forEach(l => d.addOption(l.code, l.name));
                d.setValue(this.plugin.settings.targetLanguage).onChange(async v => {
                    this.plugin.settings.targetLanguage = v; await this.plugin.saveSettings();
                });
            });

        containerEl.createEl('hr');
        new Setting(containerEl).setName('Advanced Settings').setHeading();

        // Prompts
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

        // --- NEW: CUSTOM COPY FORMATS ---
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
            .setName('Manual Paragraph Refinement')
            .setDesc('Enable Shift+click and Ctrl+M to merge translation blocks.')
            .addToggle(t => t.setValue(this.plugin.settings.manualRefinementMode).onChange(async v => {
                this.plugin.settings.manualRefinementMode = v; await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Log detailed information to the developer console.')
            .addToggle(t => t.setValue(this.plugin.settings.debugMode).onChange(async v => {
                this.plugin.settings.debugMode = v; await this.plugin.saveSettings();
            }));
    }
}