// i18n.ts
// ─────────────────────────────────────────────────────────────────────────
// Minimal i18n for the OpenRouter PDF Translator plugin.
// Language is auto-detected from Obsidian's locale (window.moment.locale()).
// Falls back to English for any unsupported locale.
//
// Usage:
//   import { t } from './i18n';
//   new Setting(el).setName(t('settings.provider.label'))
// ─────────────────────────────────────────────────────────────────────────

type Locale = Record<string, string>;

const EN: Locale = {
  // ── Provider section ──────────────────────────────────────────────────
  'provider.section.title':          'Translation Provider',
  'provider.select.label':           'Provider',
  'provider.select.desc':            'Choose the API provider for translation.',
  'provider.apikey.label':           'API Key',
  'provider.apikey.placeholder':     'sk-...',
  'provider.endpoint.label':         'API Endpoint',
  'provider.model.label':            'Model',
  'provider.model.desc':             'Fetched live from the provider. Use Refresh after entering your key, or type a model ID manually below.',
  'provider.model.manual.label':     'Model ID (manual)',
  'provider.model.manual.desc':      'Optional. Type an exact model ID to use one not in the dropdown.',
  'provider.model.refresh.notice.loading': 'Fetching models…',
  'provider.model.refresh.notice.ok':      'Found {n} model(s).',
  'provider.model.refresh.notice.empty':   'No models returned — enter manually.',
  'provider.temperature.label':      'Temperature',
  'provider.temperature.desc':       'Controls randomness (0 = deterministic, 1 = creative). Recommended: 0.3 for translation.',
  'provider.reasoning.label':        'Enable Reasoning',
  'provider.reasoning.desc':         'Enable extended thinking for compatible models (DeepSeek R1, QwQ, O1, etc.). May increase latency.',
  'provider.thinking.label':         'Thinking Mode',
  'provider.thinking.desc':          'Enable thinking mode for Gemini 2.0 Flash Thinking models.',
  'provider.headers.label':          'Request Headers (JSON)',
  'provider.headers.desc':           'Use placeholders: {apiKey}',
  'provider.body.label':             'Request Body Template (JSON)',
  'provider.body.desc':              'Template for the request body. Use {model}, {systemPrompt}, {userMessage}.',

  // ── OpenAI ────────────────────────────────────────────────────────────
  'openai.section':        'OpenAI Settings',

  // ── Gemini ────────────────────────────────────────────────────────────
  'gemini.section':        'Google Gemini Settings',

  // ── OpenRouter ────────────────────────────────────────────────────────
  'openrouter.section':    'OpenRouter Settings',

  // ── Ollama ────────────────────────────────────────────────────────────
  'ollama.section':        'Ollama (Local) Settings',
  'ollama.endpoint.label': 'Ollama API Endpoint',
  'ollama.endpoint.desc':  'The local URL for your Ollama server.',

  // ── Custom endpoint ───────────────────────────────────────────────────
  'custom.section':            'Custom Endpoint Settings',
  'custom.endpoint.label':     'API Endpoint URL',
  'custom.apikey.label':       'API Key (Optional)',
  'custom.apikey.desc':        'Your API key. Use {apiKey} in Headers if needed.',
  'custom.model.label':        'Model Name',
  'custom.responsepath.label': 'Response JSON Path',
  'custom.responsepath.desc':  'Dot-separated path to the translated text in the API response (e.g. choices.0.message.content).',

  // ── General ──────────────────────────────────────────────────────────
  'general.section':              'General Settings',
  'general.language.source':      'Source Language',
  'general.language.target':      'Target Language',
  'general.autosave.label':       'Auto-Save Overlay Data',
  'general.autosave.desc':        'Automatically save translation data when a page is fully translated.',
  'general.storage.label':        'Translation Storage Location',
  'general.storage.desc':         'Where to save translation files. Leave empty to save next to each PDF.',
  'general.semanticmerge.label':  'Merge Split Sentences',
  'general.semanticmerge.desc':   'Rejoin sentence fragments split across lines before translating (internal layout engine only). Improves coherence.',
  'general.delaybatch.label':     'Delay Between Requests (ms)',
  'general.delaybatch.desc':      'Pause between sequential translation requests. Increase to avoid rate-limit errors on free-tier providers.',

  // ── Watcher ──────────────────────────────────────────────────────────
  'watcher.section':          'Folder Watcher (Background Translation)',
  'watcher.desc':             'Watch a folder for new PDFs and queue them for background translation. Python engine only — extracts text with PyMuPDF without opening the file in a tab.',
  'watcher.enable.label':     'Enable Watcher',
  'watcher.enable.desc':      'Detect PDFs added to the watched folder.',
  'watcher.folder.label':     'Watched Folder',
  'watcher.folder.desc':      'Folder to watch (non-recursive). Leave empty for vault root.',
  'watcher.queue.label':      'Queue',
  'watcher.queue.desc':       'Open the detected-PDF queue to translate items in the background.',
  'watcher.queue.btn.open':   'Open Queue',
  'watcher.queue.btn.scan':   'Scan Folder Now',
  'watcher.warning.notpython':'⚠ Background translation needs the Python layout engine. Internal and OCR engines cannot run in the background because they require an open PDF tab.',

  // ── Prompts ───────────────────────────────────────────────────────────
  'prompts.section':                'Translation Prompts',
  'prompts.help.title':             'How to structure a prompt',
  'prompts.help.intro':             'The prompt is the instruction sent to the model with each request. Two modes are used automatically: ',
  'prompts.help.batch':             'Batch',
  'prompts.help.batch.desc':        ' (a whole page at once — faster, cheaper) and ',
  'prompts.help.single':            'Single sentence',
  'prompts.help.single.desc':       ' (one fragment — used as fallback). Edit both below.',
  'prompts.help.placeholders':      'Placeholders (replaced at runtime):',
  'prompts.help.ph.sourcelang':     'source language name (e.g. English)',
  'prompts.help.ph.targetlang':     'target language name (e.g. Russian)',
  'prompts.help.ph.inputtext':      'the text to translate. If omitted, text is appended automatically.',
  'prompts.help.ph.linecount':      'batch only: how many segments must come back',
  'prompts.help.rules.title':       'Rules that keep overlays aligned',
  'prompts.help.rules.1':           'Batch input arrives as [#1], [#2]... segments. The model MUST return the same [#N] tags, one per segment, nothing merged or dropped.',
  'prompts.help.rules.2':           'Return exactly {lineCount} segments — one translation per input segment.',
  'prompts.help.rules.3':           'Output only the translation: no preamble, no notes, no markdown fences.',
  'prompts.help.tips.title':        'Customizing',
  'prompts.help.tips.desc':         'Add domain terminology, a glossary, or a tone instruction at the top. Keep the [#N] and {lineCount} rules intact or batch translation will misalign. Use Restore Default if a prompt stops working.',

  'prompts.special.label':          'Use Special Template',
  'prompts.special.desc':           'Some models (e.g. Gemma and other instruction-tuned local models) work best when the whole request is shaped as one template with a {TEXT} placeholder, rather than separate system/user prompts. When enabled, overrides the batch/single prompts.',
  'prompts.special.template.label': 'Special Template',
  'prompts.special.template.desc':  'Editable. Placeholders: {SOURCE_LANG}, {TARGET_LANG}, {SOURCE_CODE}, {TARGET_CODE}, {TEXT}. The plugin adds [#N] numbering automatically when batching.',
  'prompts.batch.label':            'Batch Translation Prompt',
  'prompts.batch.desc':             'System prompt for batch translations. Placeholders: {sourceLang}, {targetLang}, {lineCount}, {inputText}',
  'prompts.single.label':           'Single Sentence Prompt',
  'prompts.single.desc':            'System prompt for single translations. Placeholders: {sourceLang}, {targetLang}',
  'prompts.restore':                'Restore Default',

  // ── Visual & Processing ──────────────────────────────────────────────
  'visual.section':            'Visual & Processing Settings',
  'visual.fontscale.label':    'Output Font Size Scale',
  'visual.lineheight.label':   'Output Line Height',
  'visual.maxbatch.label':     'Max Batch Input Length',
  'visual.maxbatch.desc':      'Maximum characters sent per batch request. Lower if the model truncates output.',
  'visual.bboxedit.label':     'BBox Edit Mode',
  'visual.bboxedit.desc':      'Enable selecting overlay boxes and applying bulk actions from the right-click menu.',
  'visual.overlayopacity.label': 'Overlay Opacity',
  'visual.showdefault.label':  'Show Overlays by Default',
  'visual.showdefault.desc':   'Automatically show translation overlays when opening a PDF.',

  // ── Layout Engine ────────────────────────────────────────────────────
  'engine.section':            'Layout Engine',
  'engine.section.desc':       'How the plugin finds text positions to place translation overlays. For scanned/image PDFs use the OCR section below.',
  'engine.dropdown.label':     'Layout Engine',
  'engine.dropdown.desc':      'Internal reads the browser text layer. Python uses PyMuPDF on disk (supports background translation).',
  'engine.opt.internal':       'Internal (DOM text layer)',
  'engine.opt.python':         'External Python script (PyMuPDF)',
  'engine.python.path.label':  'Python Interpreter Path',
  'engine.python.path.desc':   'Absolute path to your Python executable (e.g. /usr/bin/python3 or python).',
  'engine.python.script.label':'Layout Script Path',
  'engine.python.script.desc': 'Absolute path to layout_engine.py.',
  'engine.python.install.label':'Bundled Python Scripts',
  'engine.python.install.desc': 'Writes layout_engine.py and pdf_export.py into the plugin folder. You still need Python with PyMuPDF installed (pip install pymupdf).',
  'engine.python.install.btn': 'Install / Update Scripts',
  'engine.python.install.btn.progress': 'Installing…',
  'engine.python.desktop.only': 'Python scripts are only available on desktop.',

  // ── OCR ──────────────────────────────────────────────────────────────
  'ocr.section':                 'OCR (AI Vision)',
  'ocr.section.desc':            'For scanned / image PDFs with no text layer. Recognizes each page with a vision model and writes a separate translated note. Independent from the Layout Engine — you can use both on the same vault.',
  'ocr.provider.section':        'OCR Model Provider',
  'ocr.provider.desc':           'The AI model used for recognition. This is separate from your translation model.',
  'ocr.provider.label':          'OCR Provider',
  'ocr.apikey.label':            'OCR API Key',
  'ocr.apikey.desc':             'API key for the OCR model (can be different from the translation key).',
  'ocr.endpoint.label':          'OCR API Endpoint',
  'ocr.model.label':             'OCR Model',
  'ocr.output.section':          'OCR Output',
  'ocr.folder.label':            'Recognized Files Folder',
  'ocr.folder.desc':             'Vault folder for recognized notes. Leave empty to save next to the source PDF.',
  'ocr.pattern.label':           'Filename Pattern',
  'ocr.pattern.desc':            'Name for recognized notes (without .md). Placeholders: {pdfname}, {date}.',
  'ocr.prompt.label':            'Transcription Prompt',
  'ocr.prompt.desc':             'Prompt asking the model to transcribe the page text (no coordinates, no JSON).',
  'ocr.scale.label':             'Image Scale',
  'ocr.scale.desc':              'Resolution multiplier when capturing each page (2× recommended).',
  'ocr.hint':                    'To run OCR, open a PDF and use commands "OCR: recognize PDF to translated note…" or "OCR: recognize current page".',
  'ocr.workflow.section':        'OCR Workflow',
  'ocr.jsonstrict.label':        'JSON Strictness',

  // ── Export ────────────────────────────────────────────────────────────
  'export.section':         'PDF Export Settings',
  'export.section.desc':    'Export PDFs with translation overlays permanently merged. Requires PyMuPDF (pip install PyMuPDF).',
  'export.script.label':    'PDF Export Script Path',
  'export.script.desc':     'Absolute path to the pdf_export.py script.',
  'export.test.label':      'Test Export Setup',
  'export.test.desc':       'Verify Python and PyMuPDF installation.',
  'export.test.btn':        'Test Setup',
  'export.render.note':     'Export rendering options (font sizing, per-segment color) are controlled per export in the export modal. The exported PDF draws a white background behind each translated block and uses each block\'s own text color.',
  'export.formats.section': 'Custom Copy Formats',
  'export.formats.callout': 'Callout Format',
  'export.formats.citation':'Citation Format',
  'export.formats.footnote':'Footnote Format',

  // ── Debug ─────────────────────────────────────────────────────────────
  'debug.label': 'Debug Mode',
  'debug.desc':  'Log detailed information to the developer console.',

  // ── Modals ────────────────────────────────────────────────────────────
  'modal.translate.title':       'Translate Multiple Pages',
  'modal.translate.file':        'File:',
  'modal.translate.total':       'Estimated total pages:',
  'modal.translate.start.label': 'Start Page',
  'modal.translate.end.label':   'End Page',
  'modal.translate.btn.start':   'Start Translation',
  'modal.translate.btn.cancel':  'Cancel',
  'modal.translate.btn.close':   'Close',

  'modal.ocr.title':          'OCR: Recognize PDF to Translated Note',
  'modal.ocr.file':           'File:',
  'modal.ocr.pages.detected': 'Detected {n} page(s). Choose a range to recognize.',
  'modal.ocr.from':           'From Page',
  'modal.ocr.to':             'To Page',
  'modal.ocr.btn.start':      'Recognize',
  'modal.ocr.btn.cancel':     'Cancel',
  'modal.ocr.btn.close':      'Close',
  'modal.ocr.progress':       'Recognizing page {p}… ({done}/{total} written)',
  'modal.ocr.done':           'Finished.',

  'modal.watcher.title':          'Background Translation Queue',
  'modal.watcher.desc':           'PDFs detected in the watched folder. Translation is Python-only and runs in the background.',
  'modal.watcher.btn.scan':       'Scan Folder Now',
  'modal.watcher.btn.runall':     'Run All Pending',
  'modal.watcher.empty':          'Queue is empty. New PDFs in the watched folder will appear here.',
  'modal.watcher.status.pending': '⏳ Pending',
  'modal.watcher.status.running': '⟳ Running',
  'modal.watcher.status.done':    '✓ Done',
  'modal.watcher.status.error':   '✗ Error',
  'modal.watcher.status.skipped': '↷ Skipped',
  'modal.watcher.btn.translate':  'Translate',
  'modal.watcher.btn.remove':     'Remove from queue',
  'modal.watcher.scan.none':      'No new untranslated PDFs found.',
  'modal.watcher.scan.found':     'Queued {n} untranslated PDF(s).',
};

const RU: Locale = {
  // ── Provider section ──────────────────────────────────────────────────
  'provider.section.title':          'Провайдер перевода',
  'provider.select.label':           'Провайдер',
  'provider.select.desc':            'Выберите API-провайдера для перевода.',
  'provider.apikey.label':           'API-ключ',
  'provider.apikey.placeholder':     'sk-...',
  'provider.endpoint.label':         'Адрес API',
  'provider.model.label':            'Модель',
  'provider.model.desc':             'Список загружается в реальном времени от провайдера. Нажмите Обновить после ввода ключа или введите ID модели вручную.',
  'provider.model.manual.label':     'ID модели (вручную)',
  'provider.model.manual.desc':      'Необязательно. Введите точный ID модели, если её нет в списке.',
  'provider.model.refresh.notice.loading': 'Загружаю модели…',
  'provider.model.refresh.notice.ok':      'Найдено моделей: {n}.',
  'provider.model.refresh.notice.empty':   'Модели не получены — введите вручную.',
  'provider.temperature.label':      'Температура',
  'provider.temperature.desc':       'Управляет случайностью (0 = детерминировано, 1 = творчески). Рекомендуется 0.3 для перевода.',
  'provider.reasoning.label':        'Расширенный режим мышления',
  'provider.reasoning.desc':         'Включить расширенное мышление для совместимых моделей (DeepSeek R1, QwQ, O1 и др.). Может увеличить задержку.',
  'provider.thinking.label':         'Режим размышления',
  'provider.thinking.desc':          'Включить режим размышления для моделей Gemini 2.0 Flash Thinking.',
  'provider.headers.label':          'Заголовки запроса (JSON)',
  'provider.headers.desc':           'Используйте плейсхолдеры: {apiKey}',
  'provider.body.label':             'Шаблон тела запроса (JSON)',
  'provider.body.desc':              'Шаблон тела запроса. Используйте {model}, {systemPrompt}, {userMessage}.',

  'openai.section':        'Настройки OpenAI',
  'gemini.section':        'Настройки Google Gemini',
  'openrouter.section':    'Настройки OpenRouter',
  'ollama.section':        'Настройки Ollama (локально)',
  'ollama.endpoint.label': 'Адрес сервера Ollama',
  'ollama.endpoint.desc':  'Локальный URL Ollama-сервера.',
  'custom.section':            'Настройки произвольного эндпоинта',
  'custom.endpoint.label':     'URL API',
  'custom.apikey.label':       'API-ключ (необязательно)',
  'custom.apikey.desc':        'Ваш API-ключ. Используйте {apiKey} в заголовках.',
  'custom.model.label':        'Название модели',
  'custom.responsepath.label': 'Путь к ответу (JSON)',
  'custom.responsepath.desc':  'Путь через точку до переведённого текста в ответе API (например: choices.0.message.content).',

  // ── General ──────────────────────────────────────────────────────────
  'general.section':              'Основные настройки',
  'general.language.source':      'Язык оригинала',
  'general.language.target':      'Язык перевода',
  'general.autosave.label':       'Автосохранение данных оверлея',
  'general.autosave.desc':        'Автоматически сохранять данные перевода после полного перевода страницы.',
  'general.storage.label':        'Папка для файлов перевода',
  'general.storage.desc':         'Куда сохранять файлы переводов. Оставьте пустым — файлы будут рядом с PDF.',
  'general.semanticmerge.label':  'Объединять разрывы предложений',
  'general.semanticmerge.desc':   'Склеивать фрагменты предложений, разорванные PDF-рендерером, перед отправкой на перевод (только для режима Internal). Улучшает связность.',
  'general.delaybatch.label':     'Задержка между запросами (мс)',
  'general.delaybatch.desc':      'Пауза между последовательными запросами перевода. Увеличьте, чтобы избежать ограничений частоты запросов у бесплатных провайдеров.',

  // ── Watcher ──────────────────────────────────────────────────────────
  'watcher.section':          'Слежение за папкой (фоновый перевод)',
  'watcher.desc':             'Следить за папкой и добавлять новые PDF в очередь для фонового перевода. Только Python-движок — извлекает текст через PyMuPDF без открытия файла.',
  'watcher.enable.label':     'Включить слежение',
  'watcher.enable.desc':      'Обнаруживать PDF, добавленные в отслеживаемую папку.',
  'watcher.folder.label':     'Отслеживаемая папка',
  'watcher.folder.desc':      'Папка для наблюдения (без вложенных папок). Оставьте пустым — корень хранилища.',
  'watcher.queue.label':      'Очередь',
  'watcher.queue.desc':       'Открыть очередь обнаруженных PDF для фонового перевода.',
  'watcher.queue.btn.open':   'Открыть очередь',
  'watcher.queue.btn.scan':   'Сканировать папку',
  'watcher.warning.notpython':'⚠ Фоновый перевод требует Python-движка. Internal и OCR-движки не работают в фоне, так как им нужен открытый PDF.',

  // ── Prompts ───────────────────────────────────────────────────────────
  'prompts.section':                'Промпты перевода',
  'prompts.help.title':             'Как структурировать промпт',
  'prompts.help.intro':             'Промпт — это инструкция, которая отправляется модели с каждым запросом. Автоматически используются два режима: ',
  'prompts.help.batch':             'Пакетный',
  'prompts.help.batch.desc':        ' (вся страница за один запрос — быстрее и дешевле) и ',
  'prompts.help.single':            'Одиночный',
  'prompts.help.single.desc':       ' (один фрагмент — используется как резерв). Оба промпта можно редактировать ниже.',
  'prompts.help.placeholders':      'Плейсхолдеры (заменяются в рантайме):',
  'prompts.help.ph.sourcelang':     'название языка оригинала (например, English)',
  'prompts.help.ph.targetlang':     'название языка перевода (например, Russian)',
  'prompts.help.ph.inputtext':      'текст для перевода. Если не указан — добавляется автоматически.',
  'prompts.help.ph.linecount':      'только пакетный: количество сегментов, которые должны вернуться',
  'prompts.help.rules.title':       'Правила для корректного выравнивания оверлея',
  'prompts.help.rules.1':           'Пакетный ввод приходит в виде сегментов [#1], [#2]... Модель ОБЯЗАНА вернуть те же теги [#N] — по одному на сегмент, ничего не объединяя и не пропуская.',
  'prompts.help.rules.2':           'Вернуть ровно {lineCount} сегментов — один перевод на входной сегмент.',
  'prompts.help.rules.3':           'Выводить только перевод: без преамбул, заметок и markdown-ограждений.',
  'prompts.help.tips.title':        'Настройка',
  'prompts.help.tips.desc':         'Добавьте терминологию предметной области, глоссарий или указание на стиль в начало промпта. Не нарушайте правила [#N] и {lineCount} — иначе пакетный перевод даст сбой выравнивания. При проблемах используйте «Восстановить по умолчанию».',

  'prompts.special.label':          'Использовать специальный шаблон',
  'prompts.special.desc':           'Некоторые модели (например, Gemma и другие instruction-tuned локальные модели) лучше работают, когда весь запрос оформлен единым шаблоном с плейсхолдером {TEXT}, а не отдельными системным и пользовательским промптами. При включении переопределяет пакетный и одиночный промпты.',
  'prompts.special.template.label': 'Специальный шаблон',
  'prompts.special.template.desc':  'Редактируется. Плейсхолдеры: {SOURCE_LANG}, {TARGET_LANG}, {SOURCE_CODE}, {TARGET_CODE}, {TEXT}. Нумерацию [#N] плагин добавляет автоматически при пакетном переводе.',
  'prompts.batch.label':            'Промпт пакетного перевода',
  'prompts.batch.desc':             'Системный промпт для пакетного перевода. Плейсхолдеры: {sourceLang}, {targetLang}, {lineCount}, {inputText}',
  'prompts.single.label':           'Промпт одиночного перевода',
  'prompts.single.desc':            'Системный промпт для одиночного перевода. Плейсхолдеры: {sourceLang}, {targetLang}',
  'prompts.restore':                'Восстановить по умолчанию',

  // ── Visual & Processing ──────────────────────────────────────────────
  'visual.section':            'Визуальные настройки и обработка',
  'visual.fontscale.label':    'Масштаб шрифта перевода',
  'visual.lineheight.label':   'Межстрочный интервал',
  'visual.maxbatch.label':     'Макс. длина пакетного ввода',
  'visual.maxbatch.desc':      'Максимальное количество символов в одном пакетном запросе. Уменьшите, если модель обрезает ответ.',
  'visual.bboxedit.label':     'Режим редактирования блоков',
  'visual.bboxedit.desc':      'Включить выделение блоков оверлея и массовые действия через контекстное меню.',
  'visual.overlayopacity.label': 'Прозрачность оверлея',
  'visual.showdefault.label':  'Показывать оверлей по умолчанию',
  'visual.showdefault.desc':   'Автоматически показывать переводы при открытии PDF.',

  // ── Layout Engine ────────────────────────────────────────────────────
  'engine.section':            'Движок раскладки',
  'engine.section.desc':       'Определяет, как плагин находит позиции текста для наложения перевода. Для сканов используйте раздел OCR ниже.',
  'engine.dropdown.label':     'Движок раскладки',
  'engine.dropdown.desc':      'Internal читает текстовый слой браузера. Python использует PyMuPDF с диска (поддерживает фоновый перевод).',
  'engine.opt.internal':       'Internal (DOM текстовый слой)',
  'engine.opt.python':         'Внешний Python-скрипт (PyMuPDF)',
  'engine.python.path.label':  'Путь к интерпретатору Python',
  'engine.python.path.desc':   'Абсолютный путь к Python (например: /usr/bin/python3 или python).',
  'engine.python.script.label':'Путь к скрипту раскладки',
  'engine.python.script.desc': 'Абсолютный путь к layout_engine.py.',
  'engine.python.install.label':'Встроенные Python-скрипты',
  'engine.python.install.desc': 'Записывает layout_engine.py и pdf_export.py в папку плагина. Требуется Python с PyMuPDF (pip install pymupdf).',
  'engine.python.install.btn': 'Установить / Обновить скрипты',
  'engine.python.install.btn.progress': 'Устанавливаю…',
  'engine.python.desktop.only': 'Python-скрипты доступны только на настольной версии.',

  // ── OCR ──────────────────────────────────────────────────────────────
  'ocr.section':                 'OCR (ИИ-распознавание)',
  'ocr.section.desc':            'Для сканированных/графических PDF без текстового слоя. Распознаёт каждую страницу через vision-модель и создаёт отдельную переведённую заметку. Независимо от движка раскладки — оба могут работать одновременно.',
  'ocr.provider.section':        'Провайдер OCR-модели',
  'ocr.provider.desc':           'Модель ИИ для распознавания. Может отличаться от модели перевода.',
  'ocr.provider.label':          'OCR-провайдер',
  'ocr.apikey.label':            'API-ключ для OCR',
  'ocr.apikey.desc':             'API-ключ для OCR-модели (может отличаться от ключа перевода).',
  'ocr.endpoint.label':          'Адрес API для OCR',
  'ocr.model.label':             'OCR-модель',
  'ocr.output.section':          'Вывод OCR',
  'ocr.folder.label':            'Папка для распознанных файлов',
  'ocr.folder.desc':             'Папка хранилища для распознанных заметок. Оставьте пустым — рядом с PDF.',
  'ocr.pattern.label':           'Шаблон имени файла',
  'ocr.pattern.desc':            'Имя распознанных заметок (без .md). Плейсхолдеры: {pdfname}, {date}.',
  'ocr.prompt.label':            'Промпт транскрипции',
  'ocr.prompt.desc':             'Промпт, просящий модель распознать текст страницы (без координат и JSON).',
  'ocr.scale.label':             'Масштаб изображения',
  'ocr.scale.desc':              'Множитель разрешения при захвате страницы (рекомендуется 2×).',
  'ocr.hint':                    'Для запуска OCR откройте PDF и используйте команды «OCR: распознать PDF в заметку…» или «OCR: распознать текущую страницу».',
  'ocr.workflow.section':        'Процесс OCR',
  'ocr.jsonstrict.label':        'Строгость JSON',

  // ── Export ────────────────────────────────────────────────────────────
  'export.section':         'Настройки экспорта PDF',
  'export.section.desc':    'Экспортировать PDF с постоянно встроенными переводами. Требуется PyMuPDF (pip install PyMuPDF).',
  'export.script.label':    'Путь к скрипту экспорта',
  'export.script.desc':     'Абсолютный путь к pdf_export.py.',
  'export.test.label':      'Проверка настройки экспорта',
  'export.test.desc':       'Проверить установку Python и PyMuPDF.',
  'export.test.btn':        'Проверить',
  'export.render.note':     'Параметры рендеринга (размер шрифта, цвет) задаются при каждом экспорте в диалоге экспорта. Экспортированный PDF рисует белый фон за каждым блоком перевода и использует собственный цвет текста блока.',
  'export.formats.section': 'Форматы копирования',
  'export.formats.callout': 'Формат Callout',
  'export.formats.citation':'Формат цитирования',
  'export.formats.footnote':'Формат сноски',

  // ── Debug ─────────────────────────────────────────────────────────────
  'debug.label': 'Режим отладки',
  'debug.desc':  'Выводить подробную информацию в консоль разработчика.',

  // ── Modals ────────────────────────────────────────────────────────────
  'modal.translate.title':       'Перевод нескольких страниц',
  'modal.translate.file':        'Файл:',
  'modal.translate.total':       'Страниц примерно:',
  'modal.translate.start.label': 'Начальная страница',
  'modal.translate.end.label':   'Конечная страница',
  'modal.translate.btn.start':   'Начать перевод',
  'modal.translate.btn.cancel':  'Отмена',
  'modal.translate.btn.close':   'Закрыть',

  'modal.ocr.title':          'OCR: Распознать PDF в переведённую заметку',
  'modal.ocr.file':           'Файл:',
  'modal.ocr.pages.detected': 'Обнаружено страниц: {n}. Выберите диапазон.',
  'modal.ocr.from':           'С страницы',
  'modal.ocr.to':             'По страницу',
  'modal.ocr.btn.start':      'Распознать',
  'modal.ocr.btn.cancel':     'Отмена',
  'modal.ocr.btn.close':      'Закрыть',
  'modal.ocr.progress':       'Распознаю страницу {p}… ({done}/{total} записано)',
  'modal.ocr.done':           'Готово.',

  'modal.watcher.title':          'Очередь фонового перевода',
  'modal.watcher.desc':           'PDF, обнаруженные в отслеживаемой папке. Перевод работает только через Python и выполняется в фоне.',
  'modal.watcher.btn.scan':       'Сканировать папку',
  'modal.watcher.btn.runall':     'Перевести все ожидающие',
  'modal.watcher.empty':          'Очередь пуста. Новые PDF из отслеживаемой папки появятся здесь.',
  'modal.watcher.status.pending': '⏳ Ожидает',
  'modal.watcher.status.running': '⟳ Выполняется',
  'modal.watcher.status.done':    '✓ Готово',
  'modal.watcher.status.error':   '✗ Ошибка',
  'modal.watcher.status.skipped': '↷ Пропущено',
  'modal.watcher.btn.translate':  'Перевести',
  'modal.watcher.btn.remove':     'Убрать из очереди',
  'modal.watcher.scan.none':      'Новых непереведённых PDF не найдено.',
  'modal.watcher.scan.found':     'Добавлено в очередь: {n} PDF.',
};

const LOCALES: Record<string, Locale> = { en: EN, ru: RU };

function getLang(): string {
  // Obsidian exposes moment globally. Fall back to 'en' for any unsupported code.
  const code = (window as any)?.moment?.locale?.() ?? 'en';
  const base = code.split('-')[0].toLowerCase();
  return LOCALES[base] ? base : 'en';
}

/**
 * Return the localised string for `key`.
 * Replacements: t('key', { n: 5 }) → replaces {n} in the string.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = getLang();
  let s = (LOCALES[lang]?.[key] ?? LOCALES['en']?.[key] ?? key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}
