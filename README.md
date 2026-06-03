# OpenRouter PDF Translator

An [Obsidian](https://obsidian.md/)  plugin that translates PDF documents directly inside your vault. Translated text is displayed as a transparent overlay on top of the original PDF, or written to a separate Markdown note for scanned documents. 

---

## Table of Contents

1. [Requirements](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#requirements)
2. [Quick Start](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#quick-start)
3. [How It Works](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#how-it-works)
4. [Layout Engines](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#layout-engines)
5. [Providers](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#providers)
6. [OCR (AI Vision)](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#ocr-ai-vision)
7. [Background Translation (Folder Watcher)](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#background-translation-folder-watcher)
8. [Commands Reference](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#commands-reference)
9. [Settings Reference](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#settings-reference)
10. [Translation Files](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#translation-files)
11. [PDF Export](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#pdf-export)
12. [Troubleshooting](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#troubleshooting)
13. [Languages](https://claude.ai/chat/f101c9a3-53aa-4d1f-a5e4-c331f1198385#languages)

---

## Requirements

|Component|Required for|
|---|---|
|Obsidian 1.4+|All features|
|An API key (OpenRouter, OpenAI, Gemini) or local Ollama|Translation|
|Python 3.8+ with `pymupdf` (`pip install pymupdf`)|Python layout engine, background translation, PDF export|

The **Internal layout engine** works without Python — it reads the text layer already rendered by Obsidian's PDF viewer. Use Python for better layout accuracy or for background/headless translation.

---

## Quick Start

1. Install the plugin and enable it in **Settings → Community Plugins**.
2. Open **Settings → OpenRouter PDF Translator**.
3. Choose a **Provider** (e.g. OpenRouter) and enter your API key.
4. Click **Refresh** next to the model dropdown and select a model.
5. Set **Source Language** and **Target Language**.
6. Open any PDF in Obsidian.
7. Run the command **"Translate and add overlay to current PDF page"** (or assign a hotkey).

The translated text appears as a coloured overlay on top of the original. Scroll to another page and run the command again, or use **"Translate multiple pages…"** to process a range at once.

---

## How It Works

### Overlay Mode (for PDFs with a text layer)

1. The plugin extracts text blocks and their positions from the current PDF page.
2. Each block's text is sent to the configured AI provider for translation.
3. The translated text is rendered as an absolutely-positioned HTML overlay on top of the PDF viewer — the original PDF is not modified.
4. Overlay data is saved to a companion `.translations.md` file in your vault. The next time you open the PDF, overlays load instantly without re-translating.

### OCR Mode (for scanned / image PDFs)

For PDFs with no text layer, a different pipeline is used. See OCR (Ai Vision)

---

## Layout Engines

Choose the engine in **Settings → Layout Engine**.

### Internal (default)

Reads the text layer that Obsidian's built-in PDF.js renderer produces. Works out of the box with no extra dependencies.

- **Best for:** PDFs with clean text layers (digital-born PDFs).
- **Limitation:** Cannot run in the background; requires the PDF to be open in a tab.

### External Python (PyMuPDF)

Runs `layout_engine.py` (a bundled script) using your local Python installation. PyMuPDF reads the PDF directly from disk without the browser renderer.

- **Best for:** Better layout accuracy, multi-column documents, and **background translation** (Folder Watcher).
- **Requirement:** Python 3.8+ and `pip install pymupdf`.

**Setup:**

1. Go to **Settings → Layout Engine → Bundled Python Scripts** and click **Install / Update Scripts**. The scripts are written into the plugin folder and the paths are filled in automatically.
2. Set the path to your Python interpreter (e.g. `/usr/bin/python3`).
3. Switch the Layout Engine dropdown to **External Python script (PyMuPDF)**.

> **Note:** The Python engine is the only one that supports headless background translation via the Folder Watcher, because it reads the file from disk rather than from the browser's DOM.

---

## Providers

Go to **Settings → Translation Provider** to configure which AI service handles translation.

| Provider            | Notes                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **OpenRouter**      | Aggregates hundreds of models. Recommended for the widest model choice. Free tier available.                          |
| **OpenAI**          | GPT-4o, o1, o3, and others. Requires a paid API key.                                                                  |
| **Google Gemini**   | Gemini Flash, Pro, etc. Free quota available.                                                                         |
| **Ollama**          | Runs models locally — no API key needed, full privacy. Requires [Ollama](https://ollama.ai/) running on your machine. |
| **Custom Endpoint** | Any OpenAI-compatible API. Supply the URL, key, and model name manually.                                              |

Model lists are fetched live from each provider. Click **Refresh** (⟳) after entering your key to populate the dropdown. If your model isn't in the list, type its exact ID in the **Model ID (manual)** field — this always takes precedence.

### Temperature

Controls how deterministic the output is. `0.0` = always picks the highest-probability token (best for translation consistency). `1.0` = more creative/varied. Default is `0.3`.

---

## OCR (AI Vision)

For scanned PDFs or image-only PDFs that have no text layer, use the OCR subsystem. It is **independent** from the Layout Engine — you can keep Python for normal PDFs and run OCR on scans at the same time.

### How OCR works

1. Each page is rasterized to a high-resolution image (configurable scale, default 2×).
2. The image is sent to a vision-capable AI model (your configured OCR provider) with a transcription prompt.
3. The returned text is translated via the main translation pipeline.
4. The result is written to a Markdown note in your vault, with one section per page. The note is updated incrementally — each page is written as it completes, so cancelling mid-run still leaves you with partial results.

### OCR Provider

The OCR model can be different from the translation model. Configure it in **Settings → OCR (AI Vision)**. Supported providers: OpenRouter, OpenAI, Google Gemini, Ollama, Custom.

### Output format

Each recognized note has this structure:

```markdown
---
pdf-source: "[[path/to/document.pdf]]"
ocr-model: google/gemini-flash-1.5
target-language: Russian
generated: 2026-06-01T12:00:00Z
---

# document — translation

<!-- ocr-page:1 -->
## Page 1
[[path/to/document.pdf#page=1|→ page 1]]

Translated text of page 1…

<!-- ocr-page:2 -->
## Page 2
…
```

Running OCR on a page that already exists in the note **overwrites only that page's section** — the rest of the note is untouched. Pages always stay in order regardless of what order they were recognized.

### Running OCR

- **One page:** Command **"OCR: recognize current page to translated note"** — processes whatever page is currently visible.
- **Page range:** Command **"OCR: recognize PDF to translated note (choose pages)…"** — opens a dialog to select a start and end page, with a real-time progress indicator and a Cancel button.

> **Tip:** For the best recognition quality, set Image Scale to **2** or higher in OCR settings, and choose a vision model with strong OCR ability
---

## Background Translation (Folder Watcher)

The Folder Watcher monitors a vault folder for new PDFs and queues them for background translation. **Requires the Python layout engine** — Python is the only engine that can extract text from a file without opening it in a tab.

The watcher never starts a translation automatically. Detection only queues files; you trigger translation manually from the queue.

### Setup

1. Go to **Settings → Folder Watcher**.
2. Enable the watcher and select the folder to watch (non-recursive — only immediate children of that folder are detected).
3. The watcher starts when the plugin loads and stops when you disable it or close Obsidian.

### Queue

Open the queue with the command **"Background translation: open watched-folder queue"** or the button in Settings.

Click **Translate** on a single item or **Run all pending** to process the whole queue sequentially.

**Scan folder now** checks the watched folder for existing PDFs that don't yet have a translation file and adds them to the queue.

### What background translation produces

The output is the same as a normal Python overlay translation: a `.translations.md` file saved according to your storage location setting. When you open the PDF, overlays load from this file instantly without re-translating.

---

## Commands Reference

Open the command palette (`Ctrl/Cmd + P`) and search for any of these commands.

### Overlay Translation

|Command|What it does|
|---|---|
|**Translate and add overlay to current PDF page**|Translate the currently visible page and show the overlay. Main command — assign a hotkey.|
|**Translate multiple pages…**|Open a dialog to translate a range of pages with progress and cancel.|
|**Save current PDF overlay**|Manually save the current page's overlay data to the `.translations.md` file.|
|**Refresh current PDF overlay**|Reload overlay data from the file (useful after editing the file externally).|
|**Clear current PDF overlay**|Remove all overlays from the current page (does not delete the file).|
|**Toggle PDF overlay visibility**|Show or hide all overlays on the current PDF without removing them.|
|**Reprocess/retranslate a text region…**|Retranslate a specific text block (useful for fixing a bad translation).|
|**Retranslate using saved overlay layout…**|Re-run translation using the previously saved segment layout.|

### OCR

|Command|What it does|
|---|---|
|**OCR: recognize PDF to translated note (choose pages)…**|Open the OCR dialog with page range selection, progress, and cancel.|
|**OCR: recognize current page to translated note**|Recognize the current visible page and write/update its section in the note.|

### Background Translation

|Command|What it does|
|---|---|
|**Background translation: open watched-folder queue**|Open the queue of detected PDFs.|

### Maintenance

| Command                                               | What it does                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rebuild PDF-to-translation file map**               | Rescan the vault and rebuild the index that links PDFs to their `.translations.md` files. Run if overlays stop loading after moving files. |
| **Clean unused translation files…**                   | Find and optionally delete `.translations.md` files whose source PDF no longer exists.                                                     |
| **Export PDF with translations**                      | Permanently embed the current page's translation into a new PDF file.                                                                      |

### Layout & Debug

|Command|What it does|
|---|---|
|**Adjust Layout Detector Settings…**|Fine-tune how the plugin groups text blocks into translation units.|
|**Layout: Quick switch preset…**|Switch to a predefined layout preset.|
|**Toggle BBox Edit Mode**|Enable dragging overlay boxes to correct their positions.|
|**Toggle Layout Parser Debug Mode**|Show layout parsing diagnostics for troubleshooting.|

---

## Settings Reference

### Translation Provider

Configure the AI model used for **translation text**. Each provider has its own model list  and API key field.

- **Model dropdown:** populated from the provider's API. If your model isn't listed, type the exact ID in **Model ID (manual)**.
- **Temperature:** `0.0`–`1.0`. Default `0.3`. Lower = more consistent terminology. Higher = more varied phrasing.
- **Enable Reasoning:** For models like DeepSeek R1, o1, QwQ — enables extended thinking mode.

### General Settings

|Setting|Default|Description|
|---|---|---|
|Source Language|English|Language of the PDF text|
|Target Language|Russian|Language to translate into|
|Translation Storage Location|_(empty)_|Folder for `.translations.md` files. Empty = next to each PDF|
|Auto-Save Overlay Data|On|Save overlay data automatically after translating a page|
|Merge Split Sentences|On|Rejoin sentences split across lines before sending to the API (Internal engine only)|
|Delay Between Requests|150 ms|Pause between sequential requests — increase for free-tier rate limits|

### Folder Watcher

|Setting|Description|
|---|---|
|Enable Watcher|Start watching for new PDFs|
|Watched Folder|Vault-relative path. Non-recursive (subfolders are not watched)|

### Translation Prompts

**Read the help text in the settings panel** before editing prompts — it explains placeholders and the rules that keep batch translation aligned.

In short:

- **Batch prompt** handles full pages at once. It receives numbered `[#1]`, `[#2]`… segments and must return them with the same tags. Do not remove `{lineCount}` or the `[#N]` instructions.
- **Single sentence prompt** handles one fragment at a time and has no numbering requirement.
- **Special template** (optional): for models like Gemma that expect a single combined prompt with `{TEXT}`. Overrides both prompts above when enabled.

### Layout Engine

|Setting|Description|
|---|---|
|Layout Engine|`Internal` or `External Python script (PyMuPDF)`|
|Python Interpreter Path|Path to `python3` (e.g. `/usr/bin/python3`)|
|Layout Script Path|Path to `layout_engine.py` (auto-filled after Install)|
|Install / Update Scripts|Write bundled scripts to the plugin folder|

### OCR (AI Vision)

|Setting|Description|
|---|---|
|OCR Provider / API Key / Model|Independent from the translation provider|
|Recognized Files Folder|Where to save OCR notes. Empty = next to the PDF|
|Filename Pattern|Template for the note name. Placeholders: `{pdfname}`, `{date}`|
|Transcription Prompt|The instruction sent to the vision model|
|Image Scale|Resolution multiplier for page capture. `2` recommended|

### PDF Export

|Setting|Description|
|---|---|
|PDF Export Script Path|Path to `pdf_export.py`|
|Test Setup|Verify Python and PyMuPDF are working|

The export renders a white background behind each translated block and uses each block's own text color. Additional rendering options (font scale, color per block) are set per-export in the export dialog.

---

## Translation Files

Each translated PDF gets a companion file: `<pdfname>.translations.md` (or `<pdfname>.translated.md` for OCR notes). These files live next to the PDF by default, or in the folder you specify in **Translation Storage Location**.

### Overlay data format (`.translations.md`)

```yaml
---
pdf-source: "[[path/to/document.pdf]]"
timestamp: 2026-06-01T12:00:00Z
format-version: 3
---
```

The rest of the file contains serialized overlay position data. **Do not edit this file manually** unless you know what you're doing — it will be overwritten on the next translation.

### Linking

The `pdf-source` field uses a wiki-link so Obsidian graph view shows the relationship between the PDF and its translation file. If you move or rename a PDF, run **"Repair translation links"** to update the link.

---

## PDF Export

**Export PDF with translations** permanently embeds the overlay text into a new PDF file using PyMuPDF. The original PDF is not modified — a new file is created.

**Requirements:** Python + `pip install pymupdf`.

**Setup:**

1. Install the bundled scripts (Settings → Layout Engine → Install / Update Scripts).
2. The PDF export script path is set automatically.
3. Run **"Export PDF with translations"** from the command palette.

---

## Troubleshooting

### Overlays don't appear after opening a PDF

1. Run **"Rebuild PDF-to-translation file map"**. This happens automatically on startup, but a vault rescan fixes stale links after moving files.
2. Check that the `.translations.md` file exists and its `pdf-source` field points to the correct PDF path. If the PDF has an apostrophe in its filename, run **"Repair translation links"**.

### Translation produces garbled or misaligned text

- The model returned segments out of order or dropped some `[#N]` tags. Lower **Max Batch Input Length** (try 2000–3000 chars) to reduce the chance of truncation.
- Enable **Debug Mode** to see the exact prompt and response in the developer console (`Ctrl/Cmd + Shift + I`).
- If using a custom model, check that it actually supports chat completions and returns plain text.

### Python engine doesn't work

1. Verify the interpreter path: open a terminal and run `python3 --version`.
2. Verify PyMuPDF: `python3 -c "import fitz; print(fitz.__version__)"`.
3. Use **Settings → Layout Engine → Test Setup** to run a diagnostic check.
4. On Windows, use the full path to `python.exe` (e.g. `C:\Python311\python.exe`).

### OCR quality is poor

- Increase **Image Scale** to `3` or `4` (higher = better quality, larger API payload).
- Use a vision model known for strong OCR (GPT-4o, Gemini 1.5 Pro, or a fine-tuned local model).
- Edit the **Transcription Prompt** to mention the document language or domain (e.g. "This is a medical document in Russian").

### Rate limit errors (429)

- Increase **Delay Between Requests** in General Settings (try 500–1000 ms).
- Switch to batch mode (enabled by default) — it sends fewer, larger requests.
- Upgrade to a paid API tier or switch providers.

### Background translation skips files

- Make sure the Layout Engine is set to **Python** — background translation requires PyMuPDF and will not run on Internal or OCR engines.
- Check the Python interpreter and script paths are correct.
- Open the watcher queue (command: **"Background translation: open watched-folder queue"**) and read the error message next to the failed item.

---

## Languages

The plugin UI automatically switches between **English** and **Russian** based on Obsidian's language setting. To change Obsidian's language: **Settings → General → Language**.

All other languages currently display in English. To add a new language, edit `i18n.ts` and add a new locale object following the existing `EN` and `RU` pattern.

---

## Privacy

All PDF text and translation requests go directly from your machine to the API provider you configure. No data passes through any intermediate server operated by this plugin. When using Ollama, everything stays entirely local.

---

## Credits

Built on [Obsidian](https://obsidian.md/), [PDF.js](https://mozilla.github.io/pdf.js/) (bundled in Obsidian), and optionally [PyMuPDF](https://pymupdf.readthedocs.io/). Translation is powered by whichever AI provider you choose.