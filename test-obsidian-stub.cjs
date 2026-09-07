// test-obsidian-stub.cjs — CommonJS stand-in for the 'obsidian' module.
// CJS on purpose: esbuild resolves named imports from CJS at RUNTIME
// (property access), so any symbol the plugin graph imports but the tests
// never touch can be absent without breaking the build. Classes that are
// EXTENDED at module top-level (Plugin, Modal, PluginSettingTab,
// TextComponent, TFile, TFolder, TAbstractFile) must be real classes.
class TAbstractFile {}
class TFile extends TAbstractFile {
    constructor(path) {
        super();
        this.path = path;
        this.name = path;
        this.stat = { mtime: 1, ctime: 1, size: 1 };
        this.vault = null;
    }
}
class TFolder extends TAbstractFile {
    constructor(path) { super(); this.path = path; this.isRoot = () => false; }
}
class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    load() {}
    onload() {}
    unload() {}
    onunload() {}
    addCommand() { return {}; }
    addRibbonIcon() { return {}; }
    addSettingTab() {}
    registerEvent() {}
    registerDomEvent() {}
    registerInterval() {}
    register() {}
    registerMarkdownPostProcessor() {}
}
class Modal {
    constructor(app) { this.app = app; this.contentEl = null; this.modalEl = null; }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
}
class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; }
    display() {}
}
class TextComponent {}
class TextAreaComponent {}
class ButtonComponent {
    setButtonText() { return this; }
    setWarning() { return this; }
    onClick() { return this; }
    setCta() { return this; }
    setDisabled() { return this; }
    setTooltip() { return this; }
}
class Setting {
    constructor() {}
}
class Menu {
    addItem(cb) { cb({ setTitle: () => ({ setIcon: () => ({ onClick: () => {} }) }), setIcon: () => ({ onClick: () => {} }), onClick: () => {} }); return this; }
    addSeparator() { return this; }
    showAtMouseEvent() { return this; }
    hide() { return this; }
}
class FileSystemAdapter {}
class WorkspaceLeaf {}
class Notice {
    constructor(message, timeout) {
        console.log(`[Notice] ${String(message).slice(0, 160)}`);
    }
}
const Platform = {
    isDesktop: true,
    isDesktopApp: true,
    isMobile: false,
    isMobileApp: false,
    isIosApp: false,
    isAndroidApp: false,
};
function normalizePath(p) { return String(p).replace(/\\/g, '/'); }
function parseYaml() { return {}; }
function stringifyYaml() { return ''; }
function requestUrl() {
    return Promise.resolve({ status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}
function debounce(fn) {
    const d = (...a) => fn(...a);
    d.cancel = () => {};
    d.run = () => {};
    return d;
}

module.exports = {
    TAbstractFile, TFile, TFolder, Plugin, Modal, PluginSettingTab,
    TextComponent, TextAreaComponent, ButtonComponent, Setting, Menu,
    FileSystemAdapter, WorkspaceLeaf, Notice, Platform, normalizePath,
    parseYaml, stringifyYaml, requestUrl, debounce,
};
