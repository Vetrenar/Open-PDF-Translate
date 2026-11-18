/** A successful PDF parse does not imply usable Unicode. Missing ToUnicode
 * streams can expose glyph IDs as control characters (e.g. U+0003 spaces).
 * This deliberately rejects only strong evidence, not unusual languages. */
export function assessNativeText(items: Array<{ str?: string }>): {
  usable: boolean; characters: number; controls: number; reason?: string;
} {
  const text = items.map(item => item.str || '').join('');
  const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g) || []).length;
  const usable = !(text.length >= 80 && controls >= 8 && controls / text.length > 0.03);
  return {usable,characters:text.length,controls,
    ...(usable ? {} : {reason:'Invalid native Unicode mapping; use OCR or repair the PDF text encoding.'})};
}

export class NativeTextEncodingError extends Error {
  readonly code = 'NATIVE_TEXT_ENCODING';
  constructor(readonly page: number, readonly controls: number, readonly characters: number) {
    super(`${page>0 ? `Page ${page}` : 'PDF page'}: native PDF text has invalid Unicode mapping (${controls}/${characters} characters). Use OCR or repair the PDF text encoding.`);
    this.name = 'NativeTextEncodingError';
  }
}
