// settings-ui.css.ts
// ════════════════════════════════════════════════════════════════
// CSS for the Progressive Disclosure settings UI.
// Exported as a string constant and injected into the document head
// by main.ts onload(). All selectors are prefixed with .pdf-translate-
// to avoid collisions with Obsidian's own styles.
//
// Phase 5 cleanup (N8 + N9): removed `.pdf-translate-presets-bar`,
// `.pdf-translate-preset-chip*`, and `.pdf-translate-prompt-preview-*`
// — the corresponding TS code (renderPresetChips, attachPromptPreview)
// was also deleted from settings.ts, so these selectors were dead.
//
// Phase 17 cleanup: removed `.pdf-translate-status-dot*` — these
// were never referenced from any TS file (vestigial from an early
// prototype of the connection-test UI that was later replaced by
// a plain Notice() toast).
// ════════════════════════════════════════════════════════════════

export const SETTINGS_UI_CSS = `
/* ═══ Progressive Disclosure: Level Cards ═══ */
.pdf-translate-level-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 20px;
}

.pdf-translate-level-card {
  background: var(--background-secondary);
  border: 2px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}

.pdf-translate-level-card:hover {
  border-color: var(--text-muted);
  background: var(--background-secondary-alt);
}

.pdf-translate-level-card.active {
  border-color: var(--interactive-accent);
  background: var(--interactive-accent-hover);
}

.pdf-translate-level-card .pdf-translate-level-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-normal);
}

.pdf-translate-level-card.active .pdf-translate-level-name {
  /* FIX (v5): use --text-on-accent (text color that sits on top of accent
     backgrounds) instead of --interactive-accent (which is the SAME color
     as the active background → invisible text). Falls back to --text-normal
     for older Obsidian versions that don't define --text-on-accent. */
  color: var(--text-on-accent, var(--text-normal));
}

.pdf-translate-level-card.active .pdf-translate-level-desc,
.pdf-translate-level-card.active .pdf-translate-level-count {
  /* Same fix for description and count text on active cards */
  color: var(--text-on-accent, var(--text-muted));
}

.pdf-translate-level-card .pdf-translate-level-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.pdf-translate-level-card .pdf-translate-level-count {
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 8px;
}

/* ═══ Section Headings (grouped cards) ═══ */
.pdf-translate-section-group {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 4px 20px;
  margin-bottom: 16px;
}

.pdf-translate-section-group .pdf-translate-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  padding: 14px 0 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
  margin-bottom: 4px;
}

.pdf-translate-section-group .pdf-translate-group-title .pdf-translate-group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--interactive-accent);
  flex-shrink: 0;
}

/* ═══ Warning Box (for Prompts section) ═══ */
.pdf-translate-warning-box {
  padding: 12px 16px;
  background: var(--background-modifier-warning, rgba(250, 166, 26, 0.1));
  border-left: 3px solid var(--text-warning, #faa61a);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--text-normal);
  margin: 12px 0 16px;
  line-height: 1.5;
}

.pdf-translate-warning-box strong {
  color: var(--text-warning, #faa61a);
  font-weight: 600;
}

.pdf-translate-warning-box code {
  background: var(--background-primary);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-monospace, 'SF Mono', 'Fira Code', monospace);
  font-size: 11px;
  border: 1px solid var(--background-modifier-border);
}

/* ═══ Level badge (shown next to advanced-only settings) ═══ */
.pdf-translate-level-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--background-modifier-border);
  color: var(--text-muted);
  margin-left: 6px;
  vertical-align: middle;
}

.pdf-translate-level-badge.advanced {
  background: var(--text-warning-bg, rgba(250, 166, 26, 0.15));
  color: var(--text-warning, #faa61a);
}

/* ═══ Page header for settings tab ═══ */
.pdf-translate-settings-header {
  margin-bottom: 20px;
}

.pdf-translate-settings-header h2 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 4px;
}

.pdf-translate-settings-header p {
  font-size: 13px;
  color: var(--text-muted);
}

/* ═══ Collapsible <details> (Phase 5 N7: Advanced OCR section) ═══ */
/* Native <details>/<summary> styling tweaked to match the surrounding
   .setting-item cards inside a .pdf-translate-section-group. */
.pdf-translate-section-group details {
  margin: 12px 0 4px;
  padding: 0;
  border-top: 1px solid var(--background-modifier-border);
}

.pdf-translate-section-group details > summary {
  cursor: pointer;
  padding: 10px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  user-select: none;
  list-style: none;
  /* Hide the default disclosure triangle; we draw our own via ::marker
     fallback so the visual stays consistent across Obsidian themes. */
}

.pdf-translate-section-group details > summary::-webkit-details-marker {
  display: none;
}

.pdf-translate-section-group details > summary::before {
  content: '▸';
  display: inline-block;
  margin-right: 6px;
  font-size: 11px;
  color: var(--text-muted);
  transition: transform 0.15s ease;
}

.pdf-translate-section-group details[open] > summary::before {
  transform: rotate(90deg);
}

.pdf-translate-section-group details > summary:hover {
  color: var(--text-normal);
}
`;
