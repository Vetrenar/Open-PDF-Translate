# OpenRouter PDF Translator

Translate PDF documents in Obsidian using OpenRouter, OpenAI, Anthropic, Gemini, Ollama, and other LLM providers. Features overlay rendering, OCR for scanned documents, batch translation with background queue, and a BBox edit mode for manual overlay adjustments.

## How It Works

### Translation Pipeline

The plugin follows a multi-stage pipeline to translate PDF content:

**1. Text extraction.** When you open a PDF and trigger translation, the plugin extracts text from the PDF page. Two extraction engines are available:

- **Internal engine** (default, works everywhere): Uses PDF.js (bundled with Obsidian) to read text items, their positions, font sizes, and font families directly from the PDF's content streams. No external dependencies.
- **Python engine** (desktop-only, more accurate on complex layouts): Spawns a PyMuPDF (`fitz`) child process that parses the PDF with a more sophisticated layout model. Requires Python 3.8+ and `pip install pymupdf`.

Both engines produce the same output format: an array of text spans with bounding rectangles (relative to the page, as 0–1 fractions), font metadata, and the raw text content.

**2. Layout detection.** The extracted spans are grouped into paragraphs by the layout detector

Settings like `contourIndentThreshold`, `fontSizeTolerance`, `maxMergePasses`, `columnGapThreshold`, and `decorationThreshold` control how aggressive the splitting/merging is. The `preserveStyle` option (enabled by default) treats bold and italic as different font families, producing finer-grained paragraphs.

**3. Translation.** Each paragraph's text is sent to your configured LLM provider. 

The `maxBatchChars` setting controls the maximum characters per batch. If the total exceeds this, paragraphs are split into multiple batches. A `sequentialDelayMs` setting adds a pause between batches to avoid rate-limiting.

**4. Overlay rendering.** Translated text is rendered as a `position: absolute` div overlay on top of the original PDF page. 

**5. Persistence.** Translations are saved to a `.translations.md` file alongside the PDF (in the same folder, or a configurable storage folder). The file uses the V4 format (see below) with YAML frontmatter and Obsidian `%% {...} %%` comments containing per-overlay JSON metadata. Writes are atomic (temp file + rename) and serialized via a per-file write lock (`writingPromises`).

### Overlay Visibility

You can show or hide overlays without losing translations:

- **Command**: `Toggle PDF overlay visibility` (or hotkey) flips all overlays globally
- **Per-page**: Overlays are loaded lazily as you scroll. If visibility is off, overlays are still created in the DOM but with `visibility: hidden` — they become visible instantly when you toggle back on
- **Settings**: `showOverlayByDefault` controls whether overlays appear when a PDF is first opened

### BBox Edit Mode

BBox Edit Mode is a non-invasive overlay editing system. When enabled:

- **Normal cursor, scrolling, and all Obsidian UI work** — nothing is blocked
- **Click on overlay** → select it (clears previous selection)
- **Ctrl/Shift+click on overlay** → toggle selection (additive — select multiple)
- **Click on empty space** → clear selection
- **Shift+LMB+drag** → marquee selection (a temporary overlay appears only during the drag, then is removed)
- **Escape** → clear selection
- **Right-click on overlay** → context menu:
  - **Retranslate selected** (paragraphs mode) — re-detects paragraphs in the selected region and retranslates
  - **Merge selected** (block mode) — merges selected overlays into one block and retranslates
  - **Delete selected** — removes selected overlays (uses REPLACE semantics, no resurrection)
  - **Edit translation** — opens a modal to manually edit the translated text
  - **Copy translation** — copies plain text (multi-line preserved via `innerText`)
  - **Copy as callout / citation / footnote** — copies with formatting templates
  - **Increase/decrease font size** — adjusts overlay font size (persisted to disk)
  - **Increase/decrease line height** — adjusts overlay line height (persisted to disk)
  - **Force refresh overlays** — reloads all visible overlays from disk
  - **Go to translation file** — opens the `.translations.md` file at the current page heading

BBox Edit Mode does **not** pause the background translation queue. You can edit overlays while background translation is running — writes are serialized via the per-file lock.

### Background Translation Queue

The background queue translates entire PDFs (or page ranges) without blocking the UI:

- **Entry points**: Watcher modal (per-file Translate button), "Translate multiple pages..." modal, "Run All" in watcher
- **Processing**: The `PdfLayoutQueue` processes pages sequentially within a file (extraction is serial, translation is parallel up to `backgroundTranslationConcurrency`). Multiple files are processed in FIFO order.
- **Backpressure**: The extraction-to-translation queue has a high-watermark (`concurrency × 10`). If the queue is full, extraction pauses until translation drains it — prevents OOM on 1000+ page PDFs.
- **Document reuse**: PDF documents are loaded once per batch (not per page), reducing extraction time by ~30–60s on 100-page PDFs.
- **Cancellation**: Cancel stops in-flight work at the next chunk boundary (5–10 seconds). The queue auto-resumes when new tasks are enqueued.
- **Progress**: The watcher modal shows live progress per file (pages done/total + progress bar). Active translations appear in a scrollable accent-bordered section; available files appear in a compact list below.

### V4 Translation Format

Translation files (`.translations.md`) use the V4 format:

```yaml
---
pdf-source: "[[document.pdf]]"
timestamp: 2026-08-13T12:00:00.000Z
format-version: 4
engine: openrouter/openai/gpt-4o-mini
layoutSettingsHash: a1b2c3d4e5f67890
---
```

```markdown
# Translations for document

> Last updated: 2026-08-13 12:00

## Page 1

[[document.pdf#page=1|→ View page]]

%% {"r":{"l":0.12,"t":0.34,"w":0.56,"h":0.08},"page":1,"ot":"Original text","fs":12,"ff":"sans-serif","ofs":[12,12,11],"id":"a1b2c3d4e5f67890","engine":"openrouter/openai/gpt-4o-mini"} %%

Translated text here
```

#### Per-overlay fields

| Field | Type | Description |
|---|---|---|
| `r` | `{l,t,w,h}` | Relative bounding rect (0–1 fractions of page dimensions, 4-decimal precision) |
| `page` | number | Page number |
| `ot` | string | Original text content (used for edit-modal lookup) |
| `fs` | number | Font size (persisted but inert — rendering uses `ofs` instead) |
| `ff` | string | Font family |
| `ofs` | number[] | Original font sizes array (drives overlay rendering — dominant/mode size) |
| `id` | string | Stable hash `hash(page + rect@2dec + textContent)` — enables exact overlay lookup and merge-by-id |
| `engine` | string | `<provider>/<model>` that produced this translation |

#### Frontmatter fields

| Field | Description |
|---|---|
| `pdf-source` | Wikilink to the source PDF (ties `.translations.md` to its PDF) |
| `timestamp` | ISO-8601 creation/update time (display only) |
| `format-version` | `4` (V3 files are auto-migrated on first edit) |
| `engine` | Primary engine used for this file |
| `layoutSettingsHash` | Hash of layout settings — `isCached` invalidates on mismatch, forcing re-translate when layout preset changes |

#### V3 → V4 Migration

Automatic on first edit/translate after plugin update:
- V3 files (`format-version: 3`) continue to work without changes
- On next edit/translate, `id` and `engine` are stamped on all overlays, `format-version` bumped to 4
- `layoutSettingsHash` added to frontmatter
- No manual migration needed

## Features

- **Multi-provider support**: 15 LLM providers including OpenAI, Anthropic, Gemini, OpenRouter, RouterAI, DeepSeek, xAI, Groq, Mistral, Together, Qwen, Ollama, LM Studio, vLLM, and custom endpoints.
- **PDF overlay rendering**: Translated text appears as an overlay on top of the original PDF, with adjustable positioning, font size, opacity, and colors. Overlays are virtualized (only 15 closest pages loaded in DOM).
- **BBox Edit Mode**: Non-invasive editing — click to select, shift+click to toggle, shift+drag for marquee. Right-click for context menu (retranslate, merge, delete, edit, copy, font adjust).
- **OCR for scanned documents**: Recognize text in scanned PDFs using vision models (GPT-4o, Claude, Gemini, LLaVA, etc.) and generate translation notes.
- **Background translation queue**: Translate entire documents with a background worker. Watch a folder for new PDFs and auto-translate them. Live progress with per-file status and progress bars. Backpressure prevents OOM on large PDFs.
- **Layout detection**: Internal (JS-based) and Python (PyMuPDF) layout engines. Configurable paragraph splitting (indent, font tolerance, merge passes, column gaps, decoration threshold).
- **Watched folders**: Automatically detect and translate PDFs dropped into a watched folder.
- **Export**: Export PDFs with baked-in translations (desktop + Python required).
- **V4 translation format**: Stable overlay IDs, engine stamps, layout settings hash. Automatic V3→V4 migration.
- **Bilingual support**: Show original and translated text side-by-side.

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings → Community Plugins
2. Search for "OpenRouter PDF Translator"
3. Click Install, then Enable

### Manual installation

1. Download the latest release from [GitHub Releases](https://github.com/openrouter-pdf-translator/releases)
2. Extract `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/openrouter-pdf-translator/` folder
3. Enable the plugin in Obsidian Settings → Community Plugins

## Quick Start

1. **Configure provider**: Open plugin settings → Provider section → Select your LLM provider → Enter API key
2. **Open a PDF**: Open any PDF in Obsidian
3. **Translate**: Right-click on the PDF → "Translate multiple pages..." → Select page range → Start
4. **View overlay**: Translated text appears as an overlay on the PDF
5. **Toggle overlay** (optional): Command palette → "Toggle PDF overlay visibility" to show/hide
6. **Edit overlays** (optional): Toggle BBox Edit Mode → click overlays to select, right-click for context menu (edit, retranslate, delete, copy)

## Desktop-only Features

The following features require desktop Obsidian (Windows, macOS, Linux) and are not available on mobile (iOS/iPadOS):

- **Python layout engine** (`layoutEngine: 'python'`): Uses PyMuPDF for advanced layout detection. Requires Python 3.8+ and PyMuPDF installed on your system:
  ```bash
  pip install pymupdf
  ```
- **PDF Export with translations** (`Export PDF with translations` command): Renders a new PDF with translated text baked in. Same Python+PyMuPDF requirement.

All other features (translation, overlay, OCR via cloud vision models, basic layout detection, BBox edit mode) work on both desktop and mobile.

## Supported Providers

| Provider | API Key Required | Default Model | Notes |
|---|---|---|---|
| OpenAI | Yes | `gpt-4o-mini` | Full support including vision |
| Anthropic | Yes | `claude-3-5-sonnet-latest` | Full support including vision |
| Google Gemini | Yes | `gemini-2.0-flash-exp` | Full support including vision |
| OpenRouter | Yes | `openai/gpt-4o-mini` | Aggregator — access many models |
| RouterAI | Yes | `openai/gpt-4o` | Russian aggregator (routerai.ru) — OpenAI-compatible API |
| DeepSeek | Yes | `deepseek-chat` | Text only |
| xAI (Grok) | Yes | `grok-2` | Text only |
| Groq | Yes | `llama-3.3-70b-versatile` | Fast inference |
| Mistral | Yes | `mistral-small-latest` | Text only |
| Together AI | Yes | `meta-llama/Llama-3-8b-chat-hf` | Open-source models |
| Alibaba Qwen | Yes | `qwen-plus` | Text only |
| Ollama | No | `llama3` | Local, requires Ollama running |
| LM Studio | No | (user-set) | Local, requires LM Studio running |
| vLLM | No | (auto-fetched) | Local, requires vLLM server |
| Custom | Varies | (user-set) | Bring your own endpoint |

## Commands

### Translation
- `Translate multiple pages...` — Open the batch translation modal (page range, start/cancel)
- `Translate and add overlay to current PDF page` — Quick single-page translate
- `Reprocess/retranslate a text region` — Re-translate a selected region (shift+drag)
- `Retranslate using saved overlay layout...` — Bulk re-translation from saved overlays

### Overlay Management
- `Save current PDF overlay` — Save current page's overlays to disk
- `Refresh current PDF overlay` — Reload overlays from disk
- `Clear current PDF overlay` — Remove all overlays from current page
- `Toggle PDF overlay visibility` — Show/hide all overlays globally
- `Toggle BBox Edit Mode` — Enable/disable overlay editing (non-invasive)

### OCR
- `OCR: recognize PDF to translated note` — OCR with translation (multi-page)
- `OCR: recognize current page` — Single-page OCR

### Background Queue
- `Background translation: open watched-folder queue` — Open watcher modal (Card Stack layout: Active + Available sections)

### Layout
- `Layout: extract entire PDF (background)` — Extract layout data in background
- `Layout: create file with originals` — Create originals-only translation file

### Export & Maintenance
- `Export PDF with translations` — Desktop-only, requires Python
- `Repair translation links` — Fix pdf-source frontmatter
- `Repair translation file` — Re-parse and re-write translation files (triggers V3→V4 migration)
- `Rebuild PDF-to-translation file map` — Refresh internal map
- `Clean unused translation files` — Find and delete orphaned files

## Settings

The plugin has 14 settings sections:

1. **Provider** — Select and configure your LLM provider (15 providers supported)
2. **Language** — Source and target languages (auto-detect supported)
3. **Translation** — Batch size (`maxBatchChars`), concurrency, retry settings, reasoning mode
4. **Storage** — Where translation files are saved (`.translations.md` V4 format)
5. **Prompts** — Custom system prompts for translation (single + batch templates, supports `{TEXT}`, `{sourceLang}`, `{targetLang}` placeholders)
6. **Visual** — Overlay appearance (font size scale, opacity, line height, colors)
7. **Layout Engine** — Internal vs Python, detection parameters (indent threshold, font tolerance, merge passes, column gap, decoration threshold)
8. **Watcher** — Auto-translation of dropped PDFs, watched folder path
9. **OCR** — Vision model configuration + Advanced settings (DPI, image quality, pacing)
10. **PDF Export** — Python script paths
11. **UI Behavior** — Context menu, hover behavior, debug mode, layout debug mode
12. **Copy Formats** — How copied translations are formatted (callout, citation, footnote templates)
13. **Paragraph Filter** — Skip page numbers, single letters, URLs (configurable rules with regex)
14. **Advanced** — Debug mode, layout debug mode, cache settings

## License

GLM-3.0 License — see [LICENSE](LICENSE) file for details.

## Bundled Python Scripts

This plugin includes two Python scripts (`layout_engine.py` and `pdf_export.py`) as embedded base64 resources. These are required for the Python layout engine and PDF export features (desktop-only). Both scripts are licensed under the GLM-3.0 License.

## Privacy

- API keys are stored locally in Obsidian's plugin data folder (`data.json`)
- PDF content is sent to your configured LLM provider for translation
- No telemetry or analytics are collected by this plugin
- Translation files (`.translations.md`) are stored in your vault — you own all data
