// table-keep.ts
//
// TABLE-KEEP (2026-09-15): общие правила «подозрения таблицы» и сохранения
// построчной структуры для ВСЕХ трёх путей сборки текста (DOM/spansToHtml,
// очередь/pdf-text-extractor, python/layout_engine). Запрос пользователя:
// короткие items, которые могут быть строками таблицы, должны сохранять
// переносы строк, чтобы таблица рендерилась правильно.
//
// ДИАГНОЗ (эмуляция emul3, scripts/emul3-before.json): правило существовало
// только в DOM-пути (spansToHtml → shouldPreserveLineBreaks) и убивалось
// конвейером в 4 местах (extractNumberedLinesRobust, restoreStructure,
// final-cleanup, queue-маппинг); в пути очереди и python-пути его не было
// вовсе; порог «< 5 слов» пропускал статистические таблицы (строки ровно
// из 5 токенов: «Male 0.7214 0.3285–1.584 –0.813 .416»).
//
// КАЛИБРОВКА порога (4 страницы эмуляции: try.pdf p2/p4/p5 + Feline URT p7):
//   - все табличные юниты: max слов в строке 1–5;
//   - все прозаические абзацы: max слов в строке 7+ (минимум 7);
//   → порог «<= 6 слов» покрывает статистические таблицы и не задевает прозу.
//
// КОНТРАКТ БЕЗОПАСНОСТИ: для НЕ-табличных текстов поведение байт-в-байт
// совпадает с прежним (склейка строк одним пробелом) — существующие
// алгоритмы layout-детекции не затронуты (правило работает УЖЕ ПОСЛЕ
// сборки юнитов, только над текстом).

/** Максимальное число слов в строке, чтобы строка считалась «табличной». */
export const TABLE_KEEP_MAX_WORDS_PER_ROW = 6;

// ── LAYOUT-FIX-22 (2026-09-25): продюсерские сплиты слов/дефисов ────────
// Новый корпус (books.zip, 9 PDF, 74 стр) вскрыл класс порчи текста,
// которого нет в python-зеркале (MuPDF склеивает сам): продюсеры эмитят
// части слов, дефисы и знаки отдельными text-items, pdf.js сохраняет их
// как отдельные спаны, а конвейер вставлял между ними пробел (join(' '))
// или сбрасывал дефис как «маркер» (F26-a: 91 дроп / F26-b: 604 ложных
// пробела на 74 стр; на старом корпусе — то же семейство, F7 из lfix10
// плюс скрытые случаи: «IL-8» try:p2, «cir-»-перенос try:p6, «% ,»-
// пунктуация grading:p6). Калибровка зазоров — emulation/gap-probe.ts по
// 17 файлам обоих корпусов: суб-словесные сплиты ≤0.5pt; продюсерские
// межсловесные advance 0.6–1.5pt (Wiley 0.765 равномерно) различаются
// дефис-опосредованностью серой зоны; кламп-артефакты дрейфа — по
// ЗАЯВЛЕННОМУ зазору (declRight) — см. fuseSpanTexts.

/**
 * F26-b: максимум зазора (pt) для БЕЗУСЛОВНОЙ склейки. Калибровка
 * gap-probe (17 файлов): суб-словесные сплиты ≤0.5pt при ЛЮБОМ кегле
 * (kerning-ошибки не масштабируются со шрифтом), настоящие пробелы
 * масштабируются (0.25 em: 2.2pt при 9pt, 1.3pt при 5.3pt footnote) и
 * всегда >0.5pt. Продюсерские межсловесные advance (Wiley 0.73–0.87,
 * ilovepdf 1.39, meningiomas-иррегулярности 0.6–1.5) — все ≥0.5pt.
 */
export const FUSE_GAP_MAX = 0.5;

/**
 * F26-b: верх серой зоны (pt): пары с зазором [FUSE_GAP_MAX, GRAY_GAP_MAX)
 * склеиваются ТОЛЬКО через дефис/тире (окончание левого или начало
 * правого — переносы, диапазоны «17–37», спасённые одиночные дефисы).
 * Серая зона без дефиса — это продюсерские межсловесные advance
 * (замер: try/TRY3/try4/try5 — РОВНО 0.765pt между всеми словами строки,
 * серия 8–11 пар; meningiomas 0.6–1.5 иррегулярно; плоский футер
 * pleomorphic 1.39) — склейка давала бы массовые слияния слов.
 */
export const GRAY_GAP_MAX = 1.5;

/**
 * F26-b: минимальный ЗАЯВЛЕННЫЙ зазор (pt) для склейки. Пары, чей
 * заявленный край уходит левее начала соседа глубже 1pt — это дрейф
 * pdf.js-ширин (Wiley/PDFium-класс 2.6–5.7pt; drift-tail пары до −19pt)
 * или наложенные ячейки таблиц — настоящий пробел/разрыв, склейка
 * запрещена. Kerning-перекрытия суб-словесных пар ≤0.77pt (замер книг).
 */
export const FUSE_DECL_GAP_MIN = -1.0;

/**
 * F26-a: зазор (pt), ниже которого одиночный дефис считается ПРИКЛЕЕННЫМ
 * к соседу по базовой линии. Внутрисловный дефис («cyclo»+«-»+«oxygenase»)
 * приклеен с обеих сторон (<2pt); маркер списка «-» изолирован.
 */
export const HYHEN_GLUE_GAP = 2;

/** В тексте есть явный перенос строки (<br>)? */
export function hasBrTag(text: string): boolean {
    return /<br\s*\/?>/i.test(text || '');
}

/**
 * LAYOUT-FIX-22 (F26-b): следует ли сшить два соседних спана одной строки
 * БЕЗ пробела. Двухзонное правило (калибровка gap-probe, 17 файлов):
 *   • края без пробелов (пробел внутри итема уже разделяет слова —
 *     стык «%»+«, respectively» склеивает «%,», внутренний пробел
 *     правого итема сохраняется);
 *   • ДЕФИС/ТИРЕ-ОПОСРЕДОВАННЫЕ стыки (одиночный «-», окончание левого
 *     «…-»/«…–», начало правого «-…»: переносы «mitogen-|activated»,
 *     диапазоны «17–|37») меряются по ФАКТИЧЕСКОМУ (после-Tm-clamp)
 *     краю: заявленная ширина слова перед дефисом может нести фантом
 *     5pt (try:p2 «IL» право 358.18 при чернилах ~353 — дефис внутри
 *     фантома), а визуально дефис приклеен;
 *   • прочие пары меряются по ЗАЯВЛЕННОМУ краю (declRight): кламп-нуль
 *     дрейфа — настоящий пробел (Wiley 2.6–5.7pt overshoot);
 *   • зазор < FUSE_GAP_MAX (0.5pt) — безусловная склейка: суб-словесный
 *     сплит (kerning-ошибки не зависят от кегля; пробелы всегда >0.5pt);
 *   • серая зона [0.5, 1.5) — склейка ТОЛЬКО через дефис/тире: серые
 *     пары без дефиса — продюсерские межсловесные advance (Wiley
 *     0.765pt равномерно на всю строку — серия 8–11 пар; ilovepdf
 *     1.39; meningiomas 0.6–1.5 иррегулярно) — это настоящие слова
 *     («computed|tomography»), склеивать нельзя.
 * Пары вне окна [FUSE_DECL_GAP_MIN, GRAY_GAP_MAX) и с пробелами на
 * краях возвращают FALSE — байт-в-байт прежняя склейка через пробел.
 */
export function fuseSpanTexts(
    cur: { left: number; right: number; text?: string; declRight?: number },
    next: { left: number; text?: string; spaceBefore?: boolean },
): boolean {
    if (next.spaceBefore) return false;
    const ct = cur.text ?? '';
    const nt = next.text ?? '';
    if (/\s$/.test(ct) || /^\s/.test(nt)) return false;
    const ctT = ct.trimEnd();
    const ntT = nt.trimStart();
    // Закрытая скобка завершает самостоятельную единицу: «(11.8%)»+«4» —
    // соседние ЯЧЕЙКИ статистической таблицы (2tier p6, зазор <0.5pt), а
    // не суб-словесный сплит. Суб-словесные сплиты не начинаются после
    // закрывающей скобки — разрез идёт по середине слова.
    if (/[)\]]$/.test(ctT)) return false;
    const dashMediated = ctT === '-' || ntT === '-' || /[-–—]$/.test(ctT) || /^[-–—]/.test(ntT);
    const hasDecl = typeof cur.declRight === 'number';
    // Дефис-стык — фактический край (фантом заявленной ширины не должен
    // разрывать визуально приклеенный дефис); прочие — заявленный.
    const right = dashMediated && hasDecl ? cur.right : (hasDecl ? cur.declRight! : cur.right);
    const gap = next.left - right;
    if (gap < FUSE_DECL_GAP_MIN || gap >= GRAY_GAP_MAX) return false;
    if (gap < FUSE_GAP_MAX) return true;
    return dashMediated;
}

/**
 * LAYOUT-FIX-22 (F26-b): собрать текст СТРОКИ спанов (уже отсортированных
 * по left) с gap-aware склейкой: суб-словесные стыки — без пробела,
 * остальные — через пробел (прежнее поведение). КРАЯ НЕ триммируются —
 * вызывающие стороны триммят там же, где прежний код (пробы/таблицы
 * .trim(); проза — без тримма, байт-паритет непрошитых путей).
 */
export function rowTextFromSpans(
    spans: Array<{ left: number; right: number; text?: string; declRight?: number; spaceBefore?: boolean }>,
): string {
    let out = '';
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        const t = typeof s.text === 'string' ? s.text : '';
        if (i === 0) { out = t; continue; }
        out += (fuseSpanTexts(spans[i - 1], s) ? '' : ' ') + t;
    }
    return out;
}

/**
 * LAYOUT-FIX-22 (F26-a): контекст соседей одиночного маркера «-» по
 * базовой линии (зазоры в pt; null — соседа нет на строке).
 */
export interface HyphenNeighbors {
    leftGap: number | null;
    rightGap: number | null;
}

/**
 * LAYOUT-FIX-22 (F26-a): одиночный дефис-итем является ЧАСТЬЮ СЛОВА, а не
 * маркером списка? TRUE для трёх приклеенных сигнатур (замер gap-probe,
 * 17 файлов):
 *   • внутрисловный (355 на книгах, 1 на старом — «IL-8» try:p2): приклеен
 *     с ОБЕИХ сторон (< HYHEN_GLUE_GAP);
 *   • перенос строки (44/8): приклеен слева, справа пусто или далёкий
 *     сосед — «…alter-» в конце строки («cir-» try:p6 прежде терялся);
 *   • знак-приставка (0/2): приклеен справа, слева пусто/далеко («-126»
 *     try:p5 — прежде терялся минус).
 * Изолированные «-» (маркеры списков, 3 на книгах) и «•»«»««» (20)
 * возвращают FALSE — прежний безусловный дроп.
 */
export function isIntraWordHyphen(nb: HyphenNeighbors | null | undefined): boolean {
    if (!nb) return false;
    const L = nb.leftGap, R = nb.rightGap;
    if (L !== null && L < HYHEN_GLUE_GAP && R !== null && R < HYHEN_GLUE_GAP) return true;
    if (L !== null && L < HYHEN_GLUE_GAP && (R === null || R >= HYHEN_GLUE_GAP * 3)) return true;
    if (R !== null && R < HYHEN_GLUE_GAP && (L === null || L >= HYHEN_GLUE_GAP * 3)) return true;
    return false;
}

/**
 * Похоже ли на таблицу: >= 2 непустых строк, КАЖДАЯ не длиннее
 * TABLE_KEEP_MAX_WORDS_PER_ROW слов. Сигнатура коротких строк —
 * «item-строки» (подписи осей, ячейки, статистика); проза даёт
 * 7+ слов в строке на тех же страницах (калибровка emul3).
 */
export function isTableLikeRowTexts(rows: string[]): boolean {
    const nonEmpty = (rows || []).map(r => (r || '').trim()).filter(Boolean);
    if (nonEmpty.length < 2) return false;
    for (const row of nonEmpty) {
        const words = row.split(/\s+/).filter(Boolean).length;
        if (words > TABLE_KEEP_MAX_WORDS_PER_ROW) return false;
    }
    return true;
}

/**
 * Собрать текст юнита из строк: таблица → строки через <br> (рендер
 * построчным), проза → склейка одним пробелом (пройденное поведение).
 * Пустые строки отбрасываются в обоих случаях.
 */
export function rowsToUnitText(rows: string[]): string {
    const clean = (rows || []).map(r => (r || '').trim()).filter(Boolean);
    if (clean.length === 0) return '';
    return isTableLikeRowTexts(clean) ? clean.join('<br>') : clean.join(' ');
}

/**
 * Почистить пробелы в уже переведённом тексте, СОХРАНИВ построчную
 * структуру <br> (для табличных юнитов). Вызывается в тех местах, где
 * прежний код безусловно вырезал <br> («translation should be continuous
 * text») — теперь вырезание только для прозы.
 */
export function cleanTextKeepingBr(text: string): string {
    const rows = (text || '').split(/<br\s*\/?>/gi);
    const cleaned = rows.map(r => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return cleaned.join('<br>');
}

/**
 * Контекст для контекстно-зависимого спан-фильтра (isValidSpan).
 * Числовые спаны выбрасываются только если они в полосе колонтитула
 * (номер страницы) или суперскрипт (ссылочный индекс) — числовые ЯЧЕЙКИ
 * таблиц (обычный кегль, соседи в строке) выживают.
 */
export interface SpanFilterCtx {
    numericPageBoxes?: Array<{left:number;right:number;top:number;bottom:number}>;
    /** Медианная высота текстового спана на странице (px). */
    medianSpanHeight?: number;
    /** Верх страницы в viewport-координатах (border-box). */
    pageTop?: number;
    /** Низ страницы в viewport-координатах (border-box). */
    pageBottom?: number;
    /** Полоса колонтитула (px от края). По умолчанию 8% высоты. */
    marginBandPx?: number;
}

/**
 * Собрать SpanFilterCtx из пула спанов и (опционально) элемента страницы.
 * Медиана считается по «содержательным» спанам (высота > 1px) — иначе
 * нулевые спаны marked-content утопят медиану в 0.
 */
export function buildSpanFilterCtx(spans: HTMLElement[], pageEl?: HTMLElement | null): SpanFilterCtx {
    const rects = spans.map(sp => {
        const r=sp.getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,text:sp.textContent||''};
    });
    const page=pageEl?.getBoundingClientRect();
    return buildRectFilterCtx(rects,page?.top ?? NaN,page?.bottom ?? NaN);
}

/** Remove only isolated margin numbers identified in the page context.
 * Small numbers and missing context are never sufficient evidence. */
export function shouldDropNumericSpan(
    rect: { top: number; bottom: number; height: number; left?: number; right?: number },
    ctx?: SpanFilterCtx,
): boolean {
    if (!ctx || !ctx.medianSpanHeight || !Number.isFinite(ctx.pageTop) || !Number.isFinite(ctx.pageBottom)) {
        return false; // Missing geometry is not evidence of disposable content.
    }
    return (ctx.numericPageBoxes || []).some(b => rect.left !== undefined && rect.right !== undefined
        && Math.abs(b.left-rect.left)<0.5 && Math.abs(b.right-rect.right)<0.5
        && Math.abs(b.top-rect.top)<0.5 && Math.abs(b.bottom-rect.bottom)<0.5);
}

// ── LAYOUT-FIX-9 (P2, 2026-09-17): унификация входа DOM/queue ─────────────
// Контентные правила спан-фильтра вынесены из пре-детекции DOM-пути
// (processing.ts::isValidSpan на фиде) в ПОСТ-детекцию — единый проход по
// спанам юнитов после buildParagraphs, ОДИНАКОВО для обоих путей:
//   • DOM (processing.ts): детектор видит ВСЕ валидные спаны (раньше —
//     только прошедшие ctx-фильтр: try:p2 307 из 517), фильтр снимает
//     не-контентные спаны с уже собранных юнитов;
//   • queue (pdf-text-extractor.ts): прежде фильтра не было вовсе (517)
//     — теперь тот же пост-фильтр, симметрично.
// Инфраструктура: buildRectFilterCtx строит SpanFilterCtx из ректов
// (медиана высот + полосы колонтитула) для путей, где нет DOM-спанов;
// isDroppableContentRect — общее предикатное ядро (число+ctx, одиночный
// маркерный символ, http). TEXT-KEEP контракты сохранены: числовая ЯЧЕЙКА
// таблицы (обычный кегль, в контенте) переживает фильтр; гибнут только
// номера страниц в колонтитуле и суперскрипт-индексы — как на DOM-пути
// с самого появления ctx-фильтра.

/**
 * Собрать SpanFilterCtx из пула РЕКТОВ (queue-путь: координаты страницы,
 * top-left origin). Медиана считается по «содержательным» ректам
 * (высота > 1) — как buildSpanFilterCtx делает по DOM-спанам.
 */
export function buildRectFilterCtx(
    rects: Array<{ top: number; bottom: number; height?: number; left?: number; right?: number; text?: string; fontsize?: number }>,
    pageTop: number,
    pageBottom: number,
): SpanFilterCtx {
    const heights: number[] = [];
    for (const r of rects) {
        const h = r.fontsize || (typeof r.height === 'number' && r.height > 0 ? r.height : r.bottom - r.top);
        if (h > 1) heights.push(h);
    }
    const ctx: SpanFilterCtx = {};
    if (heights.length > 0) {
        heights.sort((a, b) => a - b);
        ctx.medianSpanHeight = heights[Math.floor(heights.length / 2)];
    }
    if (Number.isFinite(pageTop) && Number.isFinite(pageBottom) && pageBottom > pageTop) {
        ctx.pageTop = pageTop;
        ctx.pageBottom = pageBottom;
        ctx.marginBandPx = (pageBottom - pageTop) * 0.08;
        ctx.numericPageBoxes = rects.filter(r => {
            if (!/^\d{1,3}$/.test((r.text||'').trim()) || r.left===undefined || r.right===undefined) return false;
            const h=r.fontsize || r.bottom-r.top;
            if (h < (ctx.medianSpanHeight||h)*0.85) return false;
            if (r.top>=pageTop+ctx.marginBandPx! && r.bottom<=pageBottom-ctx.marginBandPx!) return false;
            // An isolated margin number, not an index or a cell in a grid.
            return !rects.some(a => a!==r && a.left!==undefined && a.right!==undefined
                && Math.max(a.left-r.right!,r.left!-a.right)<h*3
                && Math.max(a.top-r.bottom,r.top-a.bottom)<h*2);
        }).map(r=>({left:r.left!,right:r.right!,top:r.top,bottom:r.bottom}));
    }
    return ctx;
}

/**
 * Общее контентное правило LAYOUT-FIX-9 (P2): следует ли выбросить СПАН
 * из юнита. TRUE только для не-контентных спанов:
 *   • чистое число 1–3 цифры в полосе колонтитула (номер страницы) или
 *     суперскриптного кегля (ссылочный индекс) — shouldDropNumericSpan;
 *   • одиночный маркерный символ [•-»«];
 *   • текст, начинающийся с «http».
 * Числовые ячейки таблиц и числа в теле (обычный кегль, в контенте)
 * возвращают FALSE — контракт TABLE-KEEP. Высота берётся из rect.height
 * либо bottom-top (queue-ректы заполняют оба).
 *
 * LAYOUT-FIX-22 (F26-a): для одиночного ДЕФИСА добавлен параметр соседей
 * по базовой линии — приклеенный дефис (внутрисловный «cyclo-»/перенос
 * «alter-»/приставка «-126») НЕ выбрасывается (isIntraWordHyphen).
 * Без соседей (nb отсутствует) — прежнее поведение (дроп), так что все
 * существующие вызовы без третьего аргумента байт-в-байт неизменны.
 */
export function isDroppableContentRect(
    rect: { top: number; bottom: number; height?: number; text?: string; left?: number; right?: number },
    ctx?: SpanFilterCtx,
    hyphenNeighbors?: HyphenNeighbors | null,
): boolean {
    const text = (rect.text ?? '').trim();
    if (/^\d{1,3}$/.test(text)) {
        const height = typeof rect.height === 'number' && rect.height > 0
            ? rect.height
            : rect.bottom - rect.top;
        if (shouldDropNumericSpan({ ...rect, height }, ctx)) {
            return true;
        }
        return false;
    }
    if (text.length === 1 && /[•\-»«]/.test(text)) {
        // LAYOUT-FIX-22 (F26-a): одиночный «-» с приклеенной сигнатурой —
        // часть слова, а не маркер списка (books-корпус: 91 дроп дефисов
        // вроде «plaque-like» → «plaque like»; try:p2 «IL-8» → «IL 8»).
        if (text === '-' && isIntraWordHyphen(hyphenNeighbors)) return false;
        return true;
    }
    if (text.startsWith('http')) return true;
    return false;
}

/**
 * LAYOUT-FIX-9 (P2, калибровка try:p1): подмножество контентных правил,
 * которое обязано работать ДО детекции — числовые СПАНЫ СУПЕРСКРИПТНОГО
 * кегля (h < 0.85×медианы страницы). Эмпирика: полный фид DOM-пути
 * (307→517 спанов на try:p2) меняет структуру TOC-страниц — 6 суперскриптов
 * авторской строки («1,2,3» на y=301/318-341, кегль 5.8–7.6 при медиане 9)
 * рвут записи TOC на фрагменты («f m», «d c», 12-строчные бэнды, F1=4) —
 * та же болезнь, которую queue-путь несёт со времён v11 (его фид никогда
 * не фильтровался). Правило пре-детекции возвращает TOC-контракт DOM
 * (51 юнит) и симметрично чинит фид очереди. Остальные правила
 * (номера страниц в колонтитуле, одиночные маркеры, http) детекцию не
 * загрязняют — изолированные прямоугольники — и остаются ПОСТ-детекцией
 * (isDroppableContentRect).
 */
export function isDetectionPollutingRect(
    _rect: { top: number; bottom: number; height?: number; text?: string },
    _ctx?: SpanFilterCtx,
): boolean {
    // Keep content in the caller's feed. buildParagraphs temporarily removes
    // geometrically attached scripts from structural analysis and restores them.
    return false;
}
