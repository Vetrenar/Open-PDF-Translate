# translate4 — исходники + файлы сборки (плоская структура, стандартная сборка Obsidian)

Комплект для исправления плагина **OpenRouter PDF Translator**. Структура архива
**плоская** — как в вашем репозитории: `main.ts` лежит рядом с `main.js`,
`esbuild.mjs`, `package.json` (папки `src/` нет). Сборка — **обычная,
стандартная схема Obsidian** (esbuild-конфиг уровня obsidian-sample-plugin;
подробности и одно необходимое исключение — в § «Сборка»).

Решает **пять проблем** одним набором файлов:

1. **Ошибка валидатора Obsidian community plugins** —
   `Found 1 dynamic <script> element creation` (динамическое создание `<script>` для
   загрузки pdf.js с cdnjs — запрещено политикой каталога).
2. **Постоянный Notice «pdfjs-dist loaded from CDN (bundled version failed)»** —
   pdf.js никогда не попадал в бандл: esbuild не в состоянии статически разрешить
   `require`, спрятанный в промежуточную переменную `req`, поэтому в `main.js`
   оставался рантайм-`require`, который у установленного плагина всегда падал
   («Cannot find module» — в каталоге плагина нет node_modules), и срабатывал
   CDN-фолбэк — в каждом сеансе.
3. **Скрытая зависимость от CDN у самого pdf.js** — даже после загрузки библиотеки
   pdf.js разрешал свой *worker* через `loadScript()` → ещё один динамический
   `<script>` с cdnjs (`pdf.worker.min.js`). Именно поэтому «фоновый перевод требовал
   интернет», и именно поэтому простое удаление CDN-фолбэка без регистрации воркера
   сломало бы извлечение текста с ошибкой
   `No "GlobalWorkerOptions.workerSrc specified` (доказано экспериментально).
4. **«Translation failed: Error: cancelled» при интерактивном переводе** —
   «липкий» флаг `cancelled` очереди (PdfLayoutQueue): одно нажатие Cancel
   (в модалке перевода, в watcher-модалке, остановка watcher'а) оставляло флаг
   навсегда, и КАЖДЫЙ следующий перевод страницы мгновенно падал с 'cancelled',
   подменялся оригинальным текстом и рендерился как «успешные» непереведённые
   оверлеи. Это существующий баг плагина, не связанный с pdfjs-фиксом.
5. **«Atomic write failed, falling back to direct write: Destination file already
   exists!»** в консоли при каждом сохранении оверлеев — `vault.rename` в Obsidian
   **отказывается перезаписывать существующий файл**, поэтому «атомарная» запись
   всегда падала в фолбэк (данные при этом сохранялись корректно через `modify`).
   Тоже существующий баг, не связанный с pdfjs-фиксом.

Полный разбор с экспериментальными доказательствами — в отчётах
`translate4-audit.md` (v1) и `translate4-audit-deep.md` (v2).

---

## Что чем заменить в вашем репозитории

Изменены **четыре** TS-файла (остальные 36 TS-файлов идентичны вашим — они включены
для сверки и чтобы архив был полностью собираемым «из коробки»). Все пути —
корень репозитория (плоская структура).

| Файл в архиве | Куда положить | Действие |
|---|---|---|
| `pdf-text-extractor.ts` | корень репо, рядом с `main.ts` | **ЗАМЕНИТЬ** — фикс загрузки pdf.js (см. ниже) |
| `processing.ts` | корень репо | **ЗАМЕНИТЬ** — фикс «липкого» cancelled (см. § Runtime-фиксы) |
| `pdf-layout-queue.ts` | корень репо | **ЗАМЕНИТЬ** — новый метод `clearCancelFlag()` |
| `storage.ts` | корень репо | **ЗАМЕНИТЬ** — фикс atomicWrite (case split) |
| `*.ts` (остальные), `styles.css` | корень репо | не тронуты (для сверки: `diff`) |
| `esbuild.mjs` | корень репо | **ЗАМЕНИТЬ** — теперь это стандартный конфиг obsidian-sample-plugin (без кастомных esbuild-плагинов) |
| `package.json` | корень репо | **ЗАМЕНИТЬ** или слить (npm-скрипты + пин зависимостей) |
| `package-lock.json` | корень репо | заменить (фиксирует pdfjs-dist@3.11.174) |
| `tsconfig.json` | корень репо | **ЗАМЕНИТЬ/добавить** (для IDE, `include: ["*.ts"]`) |
| `scripts/patch-pdfjs.mjs` | `scripts/` | **ДОБАВИТЬ** — патч pdfjs-dist в node_modules (запускается автоматически) |
| `scripts/verify-bundle.mjs` | `scripts/` | **ДОБАВИТЬ** — гейт проверки бандла (кросс-платформенный) |
| `scripts/verify-bundle.sh` | — | **УДАЛИТЬ**, если стоял из прошлой версии (заменён на `.mjs` — bash больше не нужен, работает на Windows) |
| `.gitignore` | корень репо | **ДОБАВИТЬ** (`node_modules/`, `main.js.map`, бандлы тестов — не коммитить) |
| `test-runtime-fixes.ts`, `test-extraction.ts`, `test-obsidian-stub.cjs`, `build-runtime-tests.mjs`, `test.pdf` | корень репо | **ДОБАВИТЬ** (регрессионные + E2E тесты, `npm test`; можно не ставить в прод) |
| `manifest.json`, `versions.json` | — | ваши файлы, не меняются |

Если у вас свой `package.json`, который жалко терять, — перенесите отсюда как
минимум:

```json
"dependencies": {
  "dompurify": "^3.1.6",
  "pdfjs-dist": "3.11.174"
}
```

(пин **точный, без `^`** — pdfjs-dist 4.x несовместим с этой схемой загрузки) и
скрипты из `"scripts"` (см. § «Сборка»). Убедитесь, что `pdfjs-dist` **не**
попадает в `external` вашего esbuild-конфига: в `main.js` НЕ должны попадать
`require("pdfjs-dist…")`-вызовы.

`main.js` в архив **не включён** намеренно: он собирается одной командой из этих
исходников (референсная сборка прошла все проверки: 4.78 МБ, E2E-тест извлечения
текста PASSED, вывод побайтово совпадает с предыдущей схемой сборки).

## Сборка: возврат к обычной схеме Obsidian (v2.3)

Кастомный esbuild-конфиг с плагином `pdfjs-community-patch` **убран**. Теперь
архитектура сборки максимально близка к `obsidian-sample-plugin`:

```
esbuild.mjs               ← СТАНДАРТНЫЙ конфиг sample-plugin:
                            entryPoints ["main.ts"], format "cjs", banner,
                            watch/dev + production — БЕЗ кастомных esbuild-плагинов
scripts/patch-pdfjs.mjs   ← единственная нестандартная деталь (см. ниже)
scripts/verify-bundle.mjs ← проверка готового main.js (входит в npm run build)
```

**npm-скрипты** (всё через `node` — bash не нужен, работает на Windows):

```json
"dev":         "node scripts/patch-pdfjs.mjs && node esbuild.mjs",
"build":       "node scripts/patch-pdfjs.mjs && node esbuild.mjs production && node scripts/verify-bundle.mjs",
"verify":      "node scripts/verify-bundle.mjs",
"test":        "node scripts/patch-pdfjs.mjs && node build-runtime-tests.mjs && node test-runtime-bundle.js && node test-e2e-bundle.js",
"postinstall": "node scripts/patch-pdfjs.mjs"
```

Два осознанных отличия `esbuild.mjs` от sample-plugin (оба закомментированы в
файле):

1. `sourcemap: prod ? false : true` — в dev **внешний** map вместо inline
   (иначе main.js в dev весит ~15 МБ — см. § «Размеры»);
2. `pdfjs-dist` и `dompurify` **не** в `external` — они обязаны бандлиться
   в `main.js` (у установленного плагина нет node_modules).

### Зачем нужен `scripts/patch-pdfjs.mjs` (и почему его нельзя убрать совсем)

В pdf.js 3.11.174 есть участки кода, которые **никогда не выполняются** в
конфигурации плагина (воркер зарегистрирован через `globalThis.pdfjsWorker`,
PDF всегда передаётся байтами, `isEvalSupported: false`), но которые
**статически** ловит валидатор каталога. Эксперимент: чисто стандартная сборка
(конфиг sample-plugin дословно, без патча) даёт в `main.js`:

| Паттерн в бандле | Сколько | Откуда в pdf.js |
|---|---|---|
| `document.createElement("script")` | **1** | loadScript (PATH C) — тот самый «Found 1 dynamic <script>…» |
| `eval(` | 1 | `eval("require")` (PATH B, только Node) |
| `new Function` | 4 | проба isEvalSupported + компиляция PostScript/глифов |

То есть при полном отказе от патча плагин снова не пройдёт проверку каталога —
именно с той ошибкой, с которой всё началось.

Скрипт применяет 6 точечных замен к двум файлам в `node_modules/pdfjs-dist/
legacy/build/` (подход как у `patch-package`):

| Паттерн в pdf.js 3.11.174 | Где | Почему безопасно патчить |
|---|---|---|
| `document.createElement("script")` (loadScript, PATH C) | `pdf.js` | недостижимо: воркер зарегистрирован (PATH A) |
| `eval("require")` (PATH B, только Node) | `pdf.js` | `isNodeJS = false` в Electron-рендерере Obsidian |
| `new Function("")` (проба isEvalSupported) | `pdf.js`, `pdf.worker.js` | заменена на `throw` → детерминированный `false` |
| `new Function("c","size",…)` / `new Function("src",…)` (компиляция PostScript/глифов) | `pdf.js`, `pdf.worker.js` | под guard'ом `isEvalSupported`, а плагин передаёт `isEvalSupported: false` в каждый `getDocument` |

Свойства скрипта:

- **идемпотентный** — повторный запуск ничего не портит (определяет
  «уже пропатчено» и пропускает);
- **самозащищённый** — отказывается работать, если pdfjs-dist не ровно
  3.11.174 или ожидаемые строки не найдены (т.е. после обновления версии):
  сборка падает с внятной ошибкой, а не отгружает непатченный код;
- **кросс-платформенный** — чистый Node, без bash;
- **запускается сам**: после `npm install`/`npm ci` (postinstall) и перед каждой
  сборкой (`npm run build` / `npm run dev` / `npm run test`).

Вывод новой схемы **побайтово совпадает** со старой (проверено `cmp`): функция
патча просто переехала из esbuild-плагина в отдельный скрипт.

### `scripts/verify-bundle.mjs` — гейт после сборки

Заменяет прежний `scripts/verify-bundle.sh` (который требовал bash и на Windows
ронял `npm run verify`). Проверяет готовый `main.js`: pdfjs (lib+worker) и
dompurify в бандле, размер > 1.5 МБ, маркер патча присутствует, запрещённых
паттернов нет (`createElement("script")` / `eval(` / `new Function` /
`document.write` / ссылки на CDN). Запускается автоматически в конце
`npm run build`, отдельно — `npm run verify`.

## Runtime-фиксы (v2.2): «cancelled» и «Atomic write failed»

Оба бага существовали в плагине до pdfjs-оверхола и не связаны с ним. Симптомы —
ровно те, что в консоли:

```
[PDF Translator] Translation failed: Error: cancelled
[OverlayRenderer] Rendered 9 overlay(s) for page 1        ← оверлеи рендерятся,
                                                            но с НЕпереведённым текстом
Atomic write failed, falling back to direct write: Error: Destination file already exists!
```

### Фикс A — «липкий» флаг `cancelled` (processing.ts + pdf-layout-queue.ts)

`PdfLayoutQueue.cancel()` ставит флаг, который сбрасывается только `resume()` или
следующим enqueue. Интерактивный перевод (команда «Translate», без очереди)
проверял этот флаг в начале каждой пачки, но никогда не сбрасывал. Итог: одно
нажатие Cancel где угодно (модалка перевода, watcher-модалка, смена настроек
watcher'а → `stop()` → `cancelRunning()`) — и **каждый следующий перевод страницы**
мгновенно бросал `'cancelled'`, `executeTranslation` возвращал оригинальные тексты,
а рендер рисовался «успешным» с непереведённым содержимым.

Решение: перед началом нового интерактивного перевода (`executeTranslation`)
«залипший» флаг сбрасывается — только если очередь простаивает
(`!isRunning()`), чтобы не ломать идущую в этот момент отмену фоновой задачи.
Новый метод `PdfLayoutQueue.clearCancelFlag()` сбрасывает флаг **без** запуска
обработки отложенных задач (в отличие от `resume()`). Отмена во время перевода
(кнопка Cancel в модалке) работает как раньше — проверка между пачками сохранена.

### Фикс B — atomicWrite (storage.ts)

`vault.rename(temp, target)` в Obsidian **отказывается перезаписывать существующий
файл** («Destination file already exists!») — это публичное API, атомарной замены
через него нет. Старый код всегда пытался temp+rename даже для существующих
`.translations.md` → rename всегда падал → console.warn при каждом сохранении →
фолбэк `vault.modify` (данные сохранялись, но шум + лишний churn temp-файла).

Решение — case split: существующий файл → сразу `vault.modify` (то же, что делал
фолбэк, без шума); новый файл → temp + `vault.rename` (по-настоящему атомарно,
адресат свободен). Поведение при сбоях (кросс-устройство, права) — прежний
фолбэк, сохранён как страховка.

### Тесты (`npm test`)

Два набора, оба на фейковых plugin/vault (без Obsidian, без LLM, без сети):

1. **runtime-фиксы** — 11 проверок: залипший флаг сбрасывается; отмена во время
   перевода по-прежнему прерывает; путь без очереди; существующий файл → прямой
   modify без temp/warning; новый файл → temp+rename.
2. **E2E извлечения** — полный конвейер `extractPage` на `test.pdf` в Node:
   воркер зарегистрирован (`globalThis.pdfjsWorker`), текст
   «Hello PDF extraction test», fontSize 24, размеры страницы, нормализация
   координат. Проверяет на ВАШЕЙ машине, что pdfjs забандлился и пропатчился
   корректно — полезно, если что-то падает локально.

## Что изменено в `pdf-text-extractor.ts`

| Было | Стало |
|---|---|
| `declare const require` + `const req = …; req('pdfjs-dist/…')` (косвенный вызов — **никогда не бандлился**) | `await import('pdfjs-dist/legacy/build/pdf.js')` — **литеральный** динамический импорт: esbuild вшивает библиотеку в `main.js` как ленивый модуль |
| — | `await import('pdfjs-dist/legacy/build/pdf.worker.js')` + регистрация `globalThis.pdfjsWorker` — активирует путь разрешения воркера **PATH A** (без Web Worker, без `loadScript`, без сети) |
| `loadPdfjsFromCdn()` — `document.createElement('script')` + cdnjs + таймаут 15 с | **удалён полностью** (вместе с Attempt 3, Notice и текстами про npm install) |
| Тексты ошибок «run: npm install pdfjs-dist@3.11.174» (для разработчика, показывались пользователю) | «The plugin installation appears to be corrupted — please reinstall the plugin» |
| Устаревшая require-стратегия в шапке файла | актуальная документация + правила «DO NOT REGRESS» |

`pdfjsInitError`, кэши байт PDF, fake-worker (`workerSrc = ''`), весь конвейер
извлечения (OccupancyMap → IslandBuilder → нормализация) — **без изменений**;
функционал сохранён полностью.

## Файлы сборки

- **`esbuild.mjs`** — стандартный конфиг obsidian-sample-plugin (entry point
  `main.ts`, вывод `main.js` — оба в корне). Никаких кастомных esbuild-плагинов;
  два осознанных отличия от sample описаны в § «Сборка».
- **`scripts/patch-pdfjs.mjs`** — патч pdfjs-dist в node_modules (автозапуск:
  postinstall + перед каждой сборкой). Подробности и таблицу замен — в § «Сборка».
- **`package.json`** — скрипты: `dev`, `build` (production + патч + verify),
  `verify`, `test`, `postinstall`. Зависимости: `pdfjs-dist@3.11.174` (пин),
  `dompurify`.
- **`tsconfig.json`** — для IDE (`include: ["*.ts"]` — корневые файлы, node_modules
  исключается автоматически). Сборка — esbuild-only (дерево и раньше не проходило
  строгий tsc; `npm run build` не вызывает tsc намеренно).
- **`scripts/verify-bundle.mjs`** — автономная проверка готового `main.js`
  (маркеры бандла + запрещённые паттерны), подходит для Windows/CI/перед релизом.

## Сборка и проверка

```bash
npm install                 # зависимости + postinstall сам патчит pdfjs-dist
npm run build               # патч → esbuild production → проверка бандла
npm run verify              # повторная проверка артефакта (по желанию)
npm test                    # регрессионные + E2E тесты (без Obsidian, без сети)
# режим разработки:
npm run dev                 # watch-режим, пересборка при изменениях
```

Ожидаемый результат — см. таблицу ниже. Это нормально для PDF-плагинов: pdf.js
lib ~1.9 МБ + pdf.worker ~1.9 МБ + dompurify + код плагина.

| Режим | Команда | `main.js` | Побочные файлы |
|---|---|---|---|
| dev (watch) | `npm run dev` | **≈ 4.8 МБ** | `main.js.map` (~8 МБ, внешний sourcemap — только для отладки в DevTools) |
| production | `npm run build` | **4.78 МБ**, без sourcemap | — |

- **В релиз и каталог идёт ТОЛЬКО production-сборка** (`npm run build`).
- Obsidian при загрузке плагина читает только `main.js` — `main.js.map` не читается;
  не коммитите его и не включайте в релизный zip (см. `.gitignore` в архиве:
  `node_modules/`, `main.js.map`, `test-*-bundle.js`).
- Если сборка «зелёная», а `main.js` меньше 1.5 МБ — pdfjs **не** забандлился
  (`npm run build` это ловит и роняет сборку на этапе verify).
- **Почему раньше main.js весил ~15 МБ**: dev-сборка использовала *inline*
  sourcemap (карта ~11 МБ вшивалась прямо в main.js). Теперь sourcemap вынесен в
  отдельный файл `main.js.map`, и даже в dev-режиме Obsidian перечитывает только
  ~4.8 МБ — перезагрузки плагина быстрее, а отладка в DevTools работает как раньше.
- Если npm-скрипты по какой-то причине не использовались и патч не применился —
  это не проблема: `npm run build`/`npm run dev` всегда запускают патч первыми.

Замечание про `ExperimentalWarning: Importing JSON modules is an experimental feature`:
это безвредное предупреждение Node (появляется при загрузке некоторых зависимостей
на определённых версиях Node, чаще всего в dev/watch-режиме). На результат сборки
оно не влияет. Отключить, если мешает: `NODE_OPTIONS=--no-warnings node esbuild.mjs`
(Windows PowerShell: `$env:NODE_OPTIONS="--no-warnings"; node esbuild.mjs`).

Смоук-тест в Obsidian:

1. Скопировать `main.js`, `manifest.json`, `styles.css` в
   `.obsidian/plugins/<id>/`, перезапустить Obsidian.
2. Открыть PDF → команда Translate → извлечение текста и вёрстки работает,
   **Notice про CDN больше не появляется**.
3. Повторить **при выключенном интернете** — извлечение текста должно работать
   (перевод через API недоступен офлайн — это ожидаемо).
4. Перезапустить Obsidian → поведение идентично.

## Правила, нарушение которых вернёт баг (продублировано в шапке pdf-text-extractor.ts)

1. Спецификаторы `import('pdfjs-dist/…')` — **только строковые литералы** (никаких
   переменных/шаблонов) — иначе останутся рантайм-импортами.
2. **Не** оборачивать загрузку в промежуточную переменную `req`.
3. `pdfjs-dist` — **пин 3.11.174** (4.x — только ESM, пути `…/pdf.js` не существуют;
   плюс краш `_isSameOrigin` при бандлинге esbuild).
4. **Не** удалять регистрацию `globalThis.pdfjsWorker` — иначе
   `No "GlobalWorkerOptions.workerSrc specified`.
5. **Не** собирать напрямую `node esbuild.mjs` в обход npm-скриптов — патч pdfjs
   запускается скриптами (`npm run build` / `npm run dev`).
6. После каждой сборки — проверка размера/маркеров (входит в `npm run build`;
   отдельно: `npm run verify`).

## Перед повторной подачей в community plugins

- Поднять `version` в `manifest.json`, синхронизировать `versions.json`.
- `isDesktopOnly`: после этой правки PDF-конвейер работает и на мобильных
  (компилированный код не использует рантайм-`require`), но `child_process`-функции
  (Python-движок вёрстки, экспорт PDF) остаются desktop-only — они уже обвешаны
  проверками `window.require`; при сомнениях ставьте `isDesktopOnly: true`.
- В описание PR включить: pdfjs-dist (lib + worker) бандлится в `main.js`,
  CDN-fallback удалён; сетевые вызовы — только API провайдеров перевода/OCR через
  `requestUrl`; `child_process` — опциональный desktop-движок вёрстки, запускается
  только по команде пользователя.
- В бандле остаются неиспользуемые в этой конфигурации упоминания `new Worker` и
  `fetch`/`XMLHttpRequest` внутри кода pdf.js (стандартно для плагинов, бандлящих
  pdf.js; недостижимы при передаче PDF байтами напрямую и зарегистрированном воркере) —
  если ревьюер спросит, поясните это.
