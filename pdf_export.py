import sys
import os
import re
import json
import fitz  # PyMuPDF
import platform
from html.parser import HTMLParser


# ---------------------------------------------------------------------------
# HTML → Plain Text Converter
# ---------------------------------------------------------------------------

class _HtmlSegment:
    """Represents a run of text with an optional style hint."""
    __slots__ = ('text', 'bold', 'italic')

    def __init__(self, text: str, bold: bool = False, italic: bool = False):
        self.text   = text
        self.bold   = bold
        self.italic = italic


class HtmlToTextConverter(HTMLParser):
    """
    Converts a subset of HTML to plain text suitable for PDF insertion.

    Supported tags
    --------------
    Block-level  : <p>, <div>, <br>, <li>, <tr>, <h1>–<h6>
    Inline-style  : <b>, <strong>, <i>, <em>   (tracked but rendered as plain text)
    Ignored       : <style>, <script>, <head> and all unknown tags

    The converter collapses consecutive blank lines to a single blank line
    and trims leading/trailing whitespace from the final result.
    """

    _BLOCK_TAGS   = frozenset({'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'})
    _SKIP_TAGS    = frozenset({'style', 'script', 'head'})
    _BOLD_TAGS    = frozenset({'b', 'strong'})
    _ITALIC_TAGS  = frozenset({'i', 'em'})

    def __init__(self):
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth  = 0
        self._bold_depth  = 0
        self._italic_depth = 0

    # ------------------------------------------------------------------ #
    # HTMLParser callbacks                                                 #
    # ------------------------------------------------------------------ #

    def handle_starttag(self, tag: str, attrs):
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append('\n')
        elif tag == 'br':
            self._parts.append('\n')
        if tag in self._BOLD_TAGS:
            self._bold_depth += 1
        if tag in self._ITALIC_TAGS:
            self._italic_depth += 1

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in self._SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append('\n')
        if tag in self._BOLD_TAGS:
            self._bold_depth = max(0, self._bold_depth - 1)
        if tag in self._ITALIC_TAGS:
            self._italic_depth = max(0, self._italic_depth - 1)

    def handle_data(self, data: str):
        if not self._skip_depth:
            self._parts.append(data)

    def handle_entityref(self, name: str):
        entities = {'amp': '&', 'lt': '<', 'gt': '>', 'nbsp': ' ',
                    'quot': '"', 'apos': "'"}
        if not self._skip_depth:
            self._parts.append(entities.get(name, ''))

    def handle_charref(self, name: str):
        if self._skip_depth:
            return
        try:
            code = int(name[1:], 16) if name.startswith(('x', 'X')) else int(name)
            self._parts.append(chr(code))
        except (ValueError, OverflowError):
            pass

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def get_text(self) -> str:
        text = ''.join(self._parts)
        # Collapse 3+ consecutive newlines → 2
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()


def html_to_plain_text(raw: str) -> str:
    """
    Convert an HTML string to plain text.  If the string contains no HTML
    tags at all it is returned unchanged (fast path).
    """
    if '<' not in raw:
        return raw
    converter = HtmlToTextConverter()
    converter.feed(raw)
    return converter.get_text()


# ---------------------------------------------------------------------------
# Font discovery
# ---------------------------------------------------------------------------

def get_system_font_paths() -> list[str]:
    """
    Return a priority-ordered list of font file paths that support
    Unicode / Cyrillic characters.  The first existing path is used.
    """
    system = platform.system()

    if system == 'Windows':
        return [
            r'C:\Windows\Fonts\arial.ttf',
            r'C:\Windows\Fonts\arialuni.ttf',   # Arial Unicode MS
            r'C:\Windows\Fonts\calibri.ttf',
            r'C:\Windows\Fonts\tahoma.ttf',
        ]
    if system == 'Darwin':
        return [
            '/Library/Fonts/Arial.ttf',
            '/System/Library/Fonts/Supplemental/Arial.ttf',
            '/Library/Fonts/Microsoft/Arial.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
        ]
    # Linux / other
    return [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/TTF/arial.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    ]


def find_system_font() -> str | None:
    """Return the first usable Unicode font path, or None."""
    for path in get_system_font_paths():
        if os.path.isfile(path):
            return path
    return None


# ---------------------------------------------------------------------------
# Color helper
# ---------------------------------------------------------------------------

def parse_color(hex_str: str) -> tuple[float, float, float]:
    """Convert ``#RGB`` or ``#RRGGBB`` to a (r, g, b) tuple in [0, 1]."""
    try:
        s = hex_str.lstrip('#')
        if len(s) == 3:
            s = ''.join(c * 2 for c in s)
        return (
            int(s[0:2], 16) / 255.0,
            int(s[2:4], 16) / 255.0,
            int(s[4:6], 16) / 255.0,
        )
    except Exception:
        return (0.0, 0.0, 0.0)


# ---------------------------------------------------------------------------
# Font-size auto-fit
# ---------------------------------------------------------------------------

_FIT_SCALE_STEPS = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5)

def insert_text_fitted(page: fitz.Page, rect: fitz.Rect, text: str,
                       fontsize: float, color, font_kwargs: dict) -> bool:
    """
    Try to insert *text* into *rect* at *fontsize*.  If it doesn't fit,
    progressively shrink the font size through ``_FIT_SCALE_STEPS`` until
    it fits or all steps are exhausted.

    Returns True if the text was successfully inserted at some size.
    """
    for scale in _FIT_SCALE_STEPS:
        fs = fontsize * scale
        kwargs = {**font_kwargs, 'fontsize': fs, 'color': color, 'align': 0}
        result = page.insert_textbox(rect, text, **kwargs)
        if result >= 0:
            return True
    # Last-ditch attempt at minimum size — insert anyway (text may clip)
    kwargs = {**font_kwargs, 'fontsize': fontsize * _FIT_SCALE_STEPS[-1],
              'color': color, 'align': 0}
    page.insert_textbox(rect, text, **kwargs)
    return False


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def process_pdf(source_path: str, output_path: str, data: dict) -> None:
    # ── Open source document ────────────────────────────────────────────
    try:
        doc = fitz.open(source_path)
    except Exception as exc:
        sys.stderr.write(f'[pdf_export] Error opening source PDF: {exc}\n')
        sys.exit(1)

    # ── Locate a Unicode-capable font ──────────────────────────────────
    font_path = find_system_font()
    font_key  = 'uf'          # arbitrary internal name for PyMuPDF

    if font_path:
        print(f'[pdf_export] Unicode font: {font_path}')
    else:
        print('[pdf_export] WARNING: No Unicode font found — '
              'Cyrillic/non-Latin characters may appear as "????". '
              'Install DejaVu Sans or Arial to fix this.')

    # Build font kwargs once so we don't repeat the dict every iteration
    base_font_kwargs: dict = {}
    if font_path:
        base_font_kwargs['fontname'] = font_key
        base_font_kwargs['fontfile'] = font_path
    else:
        base_font_kwargs['fontname'] = 'helv'

    total_overlays = sum(len(v) for v in data.values())
    print(f'[pdf_export] Processing {len(data)} page(s), '
          f'{total_overlays} overlay(s)…')

    # ── Page loop ───────────────────────────────────────────────────────
    for page_num_str, overlays in data.items():
        try:
            page_idx = int(page_num_str) - 1          # 1-based → 0-based
        except ValueError:
            print(f'[pdf_export] Skipping invalid page key: {page_num_str!r}')
            continue

        if page_idx < 0 or page_idx >= doc.page_count:
            print(f'[pdf_export] Page {page_num_str} out of range '
                  f'(doc has {doc.page_count} pages) — skipped.')
            continue

        page   = doc[page_idx]
        page_w = page.rect.width
        page_h = page.rect.height

        for item in overlays:
            # ── Resolve and sanitize text ────────────────────────────
            raw_text = item.get('text', '')
            text = html_to_plain_text(raw_text).strip()
            if not text:
                continue

            # ── Coordinates ─────────────────────────────────────────
            try:
                x = float(item.get('x', 0))
                y = float(item.get('y', 0))
                w = float(item.get('width',  0))
                h = float(item.get('height', 0))
            except (TypeError, ValueError):
                print(f'[pdf_export] Bad coordinates on page {page_num_str} — skipped.')
                continue

            if item.get('isNormalized', False):
                rect = fitz.Rect(
                    x       * page_w,
                    y       * page_h,
                    (x + w) * page_w,
                    (y + h) * page_h,
                )
            else:
                rect = fitz.Rect(x, y, x + w, y + h)

            # Guard against degenerate rectangles
            if rect.is_empty or rect.width <= 1 or rect.height <= 1:
                print(f'[pdf_export] Degenerate rect on page {page_num_str} '
                      f'({rect}) — skipped.')
                continue

            # ── Font size ────────────────────────────────────────────
            fs_raw = item.get('fontSize', [10])
            if not isinstance(fs_raw, (list, tuple)):
                fs_raw = [fs_raw]
            try:
                fontsize = max(4.0, float(fs_raw[0]))
            except (TypeError, ValueError, IndexError):
                fontsize = 10.0

            # ── Color ────────────────────────────────────────────────
            color = parse_color(item.get('color', '#000000'))

            # ── Draw white background (erase original content) ───────
            bg = fitz.Rect(rect.x0 - 1, rect.y0 - 1,
                           rect.x1 + 1, rect.y1 + 1)
            page.draw_rect(bg, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)

            # ── Insert text with auto-fit ────────────────────────────
            try:
                fitted = insert_text_fitted(
                    page, rect, text,
                    fontsize, color, base_font_kwargs,
                )
                if not fitted:
                    print(f'[pdf_export] Text clipped on page {page_num_str}: '
                          f'{text[:40]!r}…')
            except Exception as exc:
                print(f'[pdf_export] Warning — could not draw text on '
                      f'page {page_num_str}: {exc}')

    # ── Save ────────────────────────────────────────────────────────────
    try:
        doc.save(output_path, garbage=4, deflate=True)
        doc.close()
        print(f'[pdf_export] Saved → {output_path}')
    except Exception as exc:
        sys.stderr.write(f'[pdf_export] Error saving PDF: {exc}\n')
        sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _load_data(input_arg: str) -> dict:
    """Load overlay JSON from a file path or a raw JSON string."""
    if os.path.isfile(input_arg):
        with open(input_arg, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    # Fallback: treat as raw JSON string
    return json.loads(input_arg)


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('Usage: python pdf_export.py <source.pdf> <output.pdf> '
              '<overlays.json | json-string>')
        sys.exit(1)

    source_pdf = sys.argv[1]
    output_pdf = sys.argv[2]
    data_arg   = sys.argv[3]

    try:
        overlay_data = _load_data(data_arg)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f'[pdf_export] JSON parse error: {exc}\n')
        sys.exit(1)
    except Exception as exc:
        sys.stderr.write(f'[pdf_export] Could not load data: {exc}\n')
        sys.exit(1)

    process_pdf(source_pdf, output_pdf, overlay_data)