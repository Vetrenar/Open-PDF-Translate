// layout-modal.ts

// Configuration settings for LayoutDetector magical numbers and constants.
export interface LayoutSettings {
  /** Multiplier for line height calculations (default: 1.6) */
  lineHeightMultiplier: number;
  /** Minimum confidence for vertical strips (default: 0.7) */
  minStripConfidence: number;
  /** Minimum width in pixels for vertical strips (default: 4) */
  minStripWidthPx: number;
  /** Enable debug validation logging (default: false) */
  debugValidation: boolean;
  /** Maximum iterations for paragraph merging (default: 10) */
  maxIterMerges: number;
  /** Minimum confidence for horizontal bands (default: 0.6) */
  minBandConfidence: number;
  /** Threshold multiplier for band top/bottom inference relative to line height (default: 0.75) */
  bandTopBottomThresholdMultiplier: number;
  /** Confidence for inferred horizontal bands from strips (default: 0.8) */
  inferredBandConfidence: number;
  /** Minimum pixel gap for merging adjacent bands (default: 2) */
  bandMergeGapPx: number;
  /** Line height multiplier for dynamic band merge gap (default: 0.2) */
  bandMergeGapLineHeightMultiplier: number;
  /** Maximum gap fraction of page height for line height estimation (default: 0.5) */
  maxGapFractionOfPageHeight: number;
  /** Minimum number of gaps required for trimmed average in line height estimation (default: 5) */
  minGapsForTrim: number;
  /** Percentage of gaps to trim from each end for robust average (default: 0.15) */
  trimPercent: number;
  /** Multiplier to convert average gap to line height (default: 1.25) */
  lineHeightFromAvgMultiplier: number;
  /** Multiplier for floor value in line height estimation (default: 0.8) */
  floorMultiplier: number;
  /** Minimum overlap fraction for assigning spans to bands (default: 0.4) */
  minOverlapFracForBand: number;
  /** Minimum width for column regions (default: 1) */
  minRegionWidth: number;
  /** Multiplier for column threshold based on average line height (default: 2) */
  columnThresholdLineHeightMultiplier: number;
  /** Fallback pixel value for column threshold if line height is unavailable (default: 20) */
  columnThresholdFallback: number;

  // --- Settings potentially used by ParagraphMerger ---
  
  /** 
   * If true, ignores column alignment, horizontal bands, and font styles. 
   * Tries to merge everything into a single flow based purely on reading order and vertical proximity.
   * (default: false)
   */
  pmForceLinearMerge: boolean;

  /** Minimum confidence for vertical strips used in ParagraphMerger (default: 0.7) */
  pmMinStripConfidenceSplit: number;
  /** Minimum width in pixels for vertical strips used in ParagraphMerger (default: 6) */
  pmMinStripWidthPx: number;
  /** Minimum vertical overlap fraction required for spans to be considered in the same column (default: 0.6) */
  pmMinStripOverlapFrac: number;
  /** Tolerance multiplier for baseline alignment in initial merge (non-math) (default: 0.45) */
  pmInitialMergeBaselineTolNonMath: number;
  /** Tolerance multiplier for baseline alignment in initial merge (math) (default: 0.75) */
  pmInitialMergeBaselineTolMath: number;
  /** Tolerance multiplier for inline kerning in initial merge (non-math) (default: 0.55) */
  pmInitialMergeKernTolNonMath: number;
  /** Tolerance multiplier for inline kerning in initial merge (math) (default: 0.9) */
  pmInitialMergeKernTolMath: number;
  /** Tolerance multiplier for hyphenation continuation (default: 1.8) */
  pmHyphenContinuationTol: number;
  /** Tolerance multiplier for left/right alignment in initial merge (non-math) (default: 2.0) */
  pmInitialMergeAlignTolNonMath: number;
  /** Tolerance multiplier for left/right alignment in initial merge (math) (default: 2.0) */
  pmInitialMergeAlignTolMath: number;
  /** Vertical gap multiplier relative to line height in initial merge (default: 1.3) */
  pmInitialMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of font size in initial merge (default: 2.2) */
  pmInitialMergeVerticalGapMaxMultiplier: number;
  /** Tolerance multiplier for left/right alignment in stacked merge (default: 2.0) */
  pmStackedMergeAlignTol: number;
  /** Horizontal overlap fraction threshold for strong overlap in stacked merge (default: 0.25) */
  pmStackedMergeOverlapFrac: number;
  /** Vertical gap multiplier relative to line height in stacked merge (default: 1.35) */
  pmStackedMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of max font size in stacked merge (default: 2.0) */
  pmStackedMergeVerticalGapMaxMultiplier: number;
  /** Tolerance multiplier for left/right alignment in general merge (default: 2.0) */
  pmGeneralMergeAlignTol: number;
  /** Horizontal overlap fraction threshold for strong overlap in general merge (default: 0.25) */
  pmGeneralMergeOverlapFrac: number;
  /** Vertical gap multiplier relative to line height in general merge (default: 1.35) */
  pmGeneralMergeVerticalGapMultiplier: number;
  /** Maximum vertical gap as a multiplier of max font size in general merge (default: 2.0) */
  pmGeneralMergeVerticalGapMaxMultiplier: number;
  /** Overlap fraction threshold for strong overlap in nested merge (default: 0.7) */
  pmNestedMergeOverlapFrac: number;
  /** Tolerance multiplier for baseline alignment in inline stitching (non-math) (default: 0.45) */
  pmStitchBaselineTolNonMath: number;
  /** Tolerance multiplier for baseline alignment in inline stitching (math) (default: 0.75) */
  pmStitchBaselineTolMath: number;
  /** Tolerance multiplier for inline kerning in inline stitching (non-math) (default: 0.55) */
  pmStitchKernTolNonMath: number;
  /** Tolerance multiplier for inline kerning in inline stitching (math) (default: 0.9) */
  pmStitchKernTolMath: number;
  /** Baseline tolerance multiplier for inline span merging (default: 0.3) */
  pmInlineSpanBaselineTol: number;
  /** Kerning tolerance multiplier for inline span merging (default: 0.6) */
  pmInlineSpanKernTol: number;
  /** Maximum difference in numeric font weight (e.g., 400 vs 700) to allow merging. (default: 300) */
  pmInlineSpanMaxWeightDiff: number;
  /** Whether to allow merging of spans with different font styles. (default: true) */
  pmInlineSpanAllowMixedStyle: boolean;
  /** Coverage ratio threshold for determining if strips separate columns (default: 0.65) */
  pmSameColumnCoverageRatio: number;
  /** Baseline proximity tolerance multiplier for math merge candidate (default: 2.0) */
  pmMathMergeBaselineTol: number;
  /** Horizontal proximity tolerance multiplier for math merge candidate (default: 1.5) */
  pmMathMergeHorizTol: number;
  /** Center proximity tolerance multiplier for math merge candidate (default: 2.5) */
  pmMathMergeCenterTol: number;
  /** Line height tolerance multiplier for grouping spans by line during splitting (default: 0.7) */
  pmSplitLineHeightTol: number;
  /** Boundary deduplication tolerance multiplier relative to line height (default: 0.3) */
  pmSplitBoundaryDedupTol: number;
  /** Inter-word gap tolerance multiplier relative to font size (default: 1.2) */
  pmSplitInterWordGapTol: number;
  /** Column gap tolerance multiplier relative to font size (default: 2.5) */
  pmSplitColumnGapTol: number;
}

// Interface for preset data
export interface Preset {
  id: string;
  name: string;
  settings: LayoutSettings;
  createdAt: Date;
  updatedAt: Date;
}

export const defaultLayoutSettings: LayoutSettings = {
  lineHeightMultiplier: 1.6,
  minStripConfidence: 0.7,
  minStripWidthPx: 4,
  debugValidation: false,
  maxIterMerges: 10,
  minBandConfidence: 0.6,
  bandTopBottomThresholdMultiplier: 0.75,
  inferredBandConfidence: 0.8,
  bandMergeGapPx: 2,
  bandMergeGapLineHeightMultiplier: 0.2,
  maxGapFractionOfPageHeight: 0.5,
  minGapsForTrim: 5,
  trimPercent: 0.15,
  lineHeightFromAvgMultiplier: 1.25,
  floorMultiplier: 0.8,
  minOverlapFracForBand: 0.4,
  minRegionWidth: 1,
  columnThresholdLineHeightMultiplier: 2,
  columnThresholdFallback: 20,
  
  // -- Paragraph Merger Defaults --
  pmForceLinearMerge: false, // Default: Off

  pmMinStripConfidenceSplit: 0.7,
  pmMinStripWidthPx: 6,
  pmMinStripOverlapFrac: 0.6,
  pmInitialMergeBaselineTolNonMath: 0.45,
  pmInitialMergeBaselineTolMath: 0.75,
  pmInitialMergeKernTolNonMath: 0.55,
  pmInitialMergeKernTolMath: 0.9,
  pmHyphenContinuationTol: 1.8,
  pmInitialMergeAlignTolNonMath: 2.0,
  pmInitialMergeAlignTolMath: 2.0,
  pmInitialMergeVerticalGapMultiplier: 1.3,
  pmInitialMergeVerticalGapMaxMultiplier: 2.2,
  pmStackedMergeAlignTol: 2.0,
  pmStackedMergeOverlapFrac: 0.25,
  pmStackedMergeVerticalGapMultiplier: 1.35,
  pmStackedMergeVerticalGapMaxMultiplier: 2.0,
  pmGeneralMergeAlignTol: 2.0,
  pmGeneralMergeOverlapFrac: 0.25,
  pmGeneralMergeVerticalGapMultiplier: 1.35,
  pmGeneralMergeVerticalGapMaxMultiplier: 2.0,
  pmNestedMergeOverlapFrac: 0.7,
  pmStitchBaselineTolNonMath: 0.45,
  pmStitchBaselineTolMath: 0.75,
  pmStitchKernTolNonMath: 0.55,
  pmStitchKernTolMath: 0.9,
  pmInlineSpanBaselineTol: 0.3,
  pmInlineSpanKernTol: 0.6,
  pmInlineSpanMaxWeightDiff: 300,
  pmInlineSpanAllowMixedStyle: true,
  pmSameColumnCoverageRatio: 0.65,
  pmMathMergeBaselineTol: 2.0,
  pmMathMergeHorizTol: 1.5,
  pmMathMergeCenterTol: 2.5,
  pmSplitLineHeightTol: 0.7,
  pmSplitBoundaryDedupTol: 0.3,
  pmSplitInterWordGapTol: 1.2,
  pmSplitColumnGapTol: 2.5,
};

// Storage key for presets
const PRESETS_STORAGE_KEY = 'layoutSettingsPresets';

/**
 * Manages presets in localStorage
 */
export class PresetManager {
  static getAllPresets(): Preset[] {
    try {
      const stored = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (!stored) return [];
      const presets = JSON.parse(stored);
      return presets.map((preset: any) => ({
        ...preset,
        createdAt: new Date(preset.createdAt),
        updatedAt: new Date(preset.updatedAt)
      }));
    } catch (error) {
      console.error('Error loading presets:', error);
      return [];
    }
  }

  static savePreset(preset: Omit<Preset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Preset {
    // Re-read from storage to minimize race conditions with other windows
    const allPresets = this.getAllPresets();
    const now = new Date();
    
    const newPreset: Preset = {
      id: preset.id || Date.now().toString(),
      name: preset.name,
      settings: preset.settings,
      createdAt: preset.createdAt || now,
      updatedAt: now
    };

    const existingIndex = allPresets.findIndex(p => p.id === newPreset.id);
    if (existingIndex >= 0) {
      // Preserve creation date if updating
      newPreset.createdAt = allPresets[existingIndex].createdAt;
      allPresets[existingIndex] = newPreset;
    } else {
      allPresets.push(newPreset);
    }

    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(allPresets));
    return newPreset;
  }

  static deletePreset(id: string): boolean {
    const allPresets = this.getAllPresets();
    const filteredPresets = allPresets.filter(preset => preset.id !== id);
    
    if (filteredPresets.length < allPresets.length) {
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(filteredPresets));
      return true;
    }
    return false;
  }

  static getPresetById(id: string): Preset | undefined {
    const allPresets = this.getAllPresets();
    return allPresets.find(preset => preset.id === id);
  }
}

/**
 * Shows a user-friendly modal dialog for adjusting layout settings.
 * @param currentSettings The current settings to prefill the modal with.
 * @param onSave Callback function to handle the saved settings.
 */
export function showLayoutSettingsModal(
    currentSettings: LayoutSettings = defaultLayoutSettings, 
    onSave: (settings: LayoutSettings) => void
): void {
  // 1. Prevent Duplicate Modals
  const EXISTING_MODAL_ID = 'layout-settings-modal-container';
  if (document.getElementById(EXISTING_MODAL_ID)) {
    return;
  }

  // 2. Generate a unique scope ID for this instance to prevent ID collisions in DOM
  const UID = Math.random().toString(36).substring(2, 9);

  const dialog = document.createElement('dialog');
  dialog.id = EXISTING_MODAL_ID;
  dialog.style.padding = '20px';
  dialog.style.border = '1px solid var(--background-modifier-border, #ccc)';
  dialog.style.borderRadius = '8px';
  dialog.style.maxWidth = '700px';
  dialog.style.width = '90%';
  dialog.style.overflowY = 'auto';
  dialog.style.maxHeight = '85vh';
  dialog.style.backgroundColor = 'var(--background-primary, #ffffff)';
  dialog.style.color = 'var(--text-normal, #000000)';
  dialog.style.fontFamily = 'var(--font-interface, sans-serif)';
  dialog.style.boxShadow = '0 10px 40px rgba(0,0,0,0.3)';
  dialog.style.zIndex = '9999';

  const style = document.createElement('style');
  style.textContent = `
    .toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; justify-self: start; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
    .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
    input:checked + .slider { background-color: var(--interactive-accent, #007acc); }
    input:focus + .slider { box-shadow: 0 0 1px var(--interactive-accent, #007acc); }
    input:checked + .slider:before { transform: translateX(20px); }
  `;
  dialog.appendChild(style);

  const form = document.createElement('form');
  form.style.display = 'grid';
  form.style.gap = '10px';
  // Prevent default form submission (which causes page reload)
  form.onsubmit = (e) => e.preventDefault();

  const title = document.createElement('h2');
  title.textContent = 'Adjust Layout Settings';
  title.style.marginTop = '0';
  form.appendChild(title);

  // --- Preset Section ---
  const presetSection = document.createElement('div');
  presetSection.style.border = '1px solid var(--background-modifier-border, #ddd)';
  presetSection.style.borderRadius = '4px';
  presetSection.style.padding = '15px';
  presetSection.style.marginBottom = '15px';
  presetSection.style.backgroundColor = 'var(--background-secondary, #f9f9f9)';

  const presetTitle = document.createElement('h3');
  presetTitle.textContent = 'Presets';
  presetTitle.style.marginTop = '0';
  presetTitle.style.marginBottom = '10px';
  presetSection.appendChild(presetTitle);

  // Helper to extract values from form safely
  const getCurrentFormValues = (): LayoutSettings => {
    const newSettings: Partial<LayoutSettings> = {};
    for (const key in defaultLayoutSettings) {
        const input = form.elements.namedItem(key) as HTMLInputElement;
        if (input) {
            if (input.type === 'checkbox') {
                newSettings[key as keyof LayoutSettings] = input.checked;
            } else {
                const parsedValue = parseFloat(input.value);
                if (!isNaN(parsedValue)) {
                    newSettings[key as keyof LayoutSettings] = parsedValue;
                } else {
                    newSettings[key as keyof LayoutSettings] = 0;
                }
            }
        }
    }
    return { ...currentSettings, ...newSettings } as LayoutSettings;
  };

  // Preset dropdown
  const presetSelect = document.createElement('select');
  presetSelect.style.marginRight = '10px';
  presetSelect.style.padding = '5px';
  presetSelect.style.marginBottom = '10px';
  presetSelect.style.width = '100%';
  presetSelect.style.backgroundColor = 'var(--background-modifier-form-field, #ffffff)';
  presetSelect.style.border = '1px solid var(--background-modifier-border, #ddd)';
  
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Select a preset...';
  presetSelect.appendChild(defaultOption);

  const refreshPresetDropdown = (selectId: string) => {
    presetSelect.innerHTML = '';
    presetSelect.appendChild(defaultOption);
    PresetManager.getAllPresets().forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        presetSelect.appendChild(opt);
    });
    presetSelect.value = selectId;
  };

  refreshPresetDropdown('');

  // Preset name input
  const presetNameInput = document.createElement('input');
  presetNameInput.type = 'text';
  presetNameInput.placeholder = 'Preset Name (required for "Save New")';
  presetNameInput.classList.add('mousetrap');
  presetNameInput.style.marginRight = '10px';
  presetNameInput.style.padding = '5px';
  presetNameInput.style.marginBottom = '10px';
  presetNameInput.style.width = '100%';
  presetNameInput.style.backgroundColor = 'var(--background-modifier-form-field, #ffffff)';
  presetNameInput.style.border = '1px solid var(--background-modifier-border, #ddd)';
  
  // Fix: Stop ALL propagation to prevent Obsidian interference
  ['keydown', 'keyup', 'keypress'].forEach(evt => {
      presetNameInput.addEventListener(evt, (e) => {
          if ((e as KeyboardEvent).key === 'Escape') return;
          e.stopPropagation();
      });
  });

  // Buttons container
  const presetButtonsDiv = document.createElement('div');
  presetButtonsDiv.style.display = 'flex';
  presetButtonsDiv.style.gap = '8px';
  presetButtonsDiv.style.alignItems = 'center';
  presetButtonsDiv.style.flexWrap = 'wrap';

  // Status Label
  const statusLabel = document.createElement('span');
  statusLabel.style.marginLeft = '8px';
  statusLabel.style.color = 'var(--text-success, green)';
  statusLabel.style.fontWeight = 'bold';
  statusLabel.style.opacity = '0';
  statusLabel.style.transition = 'opacity 0.5s';
  statusLabel.textContent = 'Saved!';

  const showStatus = (msg: string) => {
      statusLabel.textContent = msg;
      statusLabel.style.opacity = '1';
      setTimeout(() => { statusLabel.style.opacity = '0'; }, 2000);
  };

  // 1. Save New Preset
  const saveNewPresetBtn = document.createElement('button');
  saveNewPresetBtn.type = 'button';
  saveNewPresetBtn.textContent = '💾 Save New';
  saveNewPresetBtn.title = "Save current settings as a NEW preset";
  saveNewPresetBtn.onclick = () => {
    const presetName = presetNameInput.value.trim();
    if (!presetName) {
      alert('Please enter a name for the new preset.');
      presetNameInput.focus();
      return;
    }
    const fullSettings = getCurrentFormValues();
    
    const savedPreset = PresetManager.savePreset({
      name: presetName,
      settings: fullSettings
    });

    refreshPresetDropdown(savedPreset.id);
    updatePresetBtn.disabled = false;
    deletePresetButton.disabled = false;
    showStatus(`Saved: ${presetName}`);
  };

  // 2. Update Selected Preset
  const updatePresetBtn = document.createElement('button');
  updatePresetBtn.type = 'button';
  updatePresetBtn.textContent = '🔄 Update Selected';
  updatePresetBtn.disabled = true;
  updatePresetBtn.onclick = () => {
      const selectedId = presetSelect.value;
      if (!selectedId) return;
      
      const existing = PresetManager.getPresetById(selectedId);
      if (!existing) {
          alert('Error: Preset not found.');
          return;
      }

      const presetName = presetNameInput.value.trim() || existing.name;

      if (confirm(`Overwrite settings for preset "${existing.name}"?`)) {
          const fullSettings = getCurrentFormValues();
          PresetManager.savePreset({
              id: selectedId,
              name: presetName,
              settings: fullSettings
          });
          refreshPresetDropdown(selectedId);
          updatePresetBtn.disabled = false; 
          deletePresetButton.disabled = false;
          showStatus('Preset Updated!');
      }
  };

  // 3. Delete Preset
  const deletePresetButton = document.createElement('button');
  deletePresetButton.type = 'button';
  deletePresetButton.textContent = '🗑️ Delete';
  deletePresetButton.disabled = true;
  deletePresetButton.onclick = () => {
    const selectedId = presetSelect.value;
    if (selectedId && confirm('Delete this preset?')) {
        PresetManager.deletePreset(selectedId);
        refreshPresetDropdown('');
        presetNameInput.value = '';
        updatePresetBtn.disabled = true;
        deletePresetButton.disabled = true;
    }
  };

  // 4. Restore Defaults
  const restoreDefaultsButton = document.createElement('button');
  restoreDefaultsButton.type = 'button';
  restoreDefaultsButton.textContent = '↺ Form Defaults';
  restoreDefaultsButton.title = "Reset the form below to factory default values";
  restoreDefaultsButton.style.marginLeft = 'auto';
  restoreDefaultsButton.onclick = () => {
    if (confirm('Reset current form to factory default settings?')) {
      Object.entries(defaultLayoutSettings).forEach(([key, value]) => {
        const input = form.elements.namedItem(key) as HTMLInputElement;
        if (input) {
          if (typeof value === 'boolean') input.checked = value;
          else input.value = value.toString();
        }
      });
    }
  };

  presetSelect.addEventListener('change', () => {
    const selectedId = presetSelect.value;
    
    if (!selectedId) {
        updatePresetBtn.disabled = true;
        deletePresetButton.disabled = true;
        return;
    }

    updatePresetBtn.disabled = false;
    deletePresetButton.disabled = false;

    const preset = PresetManager.getPresetById(selectedId);
    if (preset) {
      Object.entries(preset.settings).forEach(([key, value]) => {
        const input = form.elements.namedItem(key) as HTMLInputElement;
        if (input) {
          if (input.type === 'checkbox') {
            input.checked = value as boolean;
          } else {
            input.value = value.toString();
          }
        }
      });
      presetNameInput.value = preset.name;
    }
  });

  presetButtonsDiv.appendChild(saveNewPresetBtn);
  presetButtonsDiv.appendChild(updatePresetBtn);
  presetButtonsDiv.appendChild(deletePresetButton);
  presetButtonsDiv.appendChild(restoreDefaultsButton);
  presetButtonsDiv.appendChild(statusLabel);

  presetSection.appendChild(presetSelect);
  presetSection.appendChild(presetNameInput);
  presetSection.appendChild(presetButtonsDiv);
  form.appendChild(presetSection);

  // --- Settings Container ---
  const settingsContainer = document.createElement('div');
  settingsContainer.style.maxHeight = '400px';
  settingsContainer.style.overflowY = 'auto';
  settingsContainer.style.padding = '5px';
  settingsContainer.style.border = '1px solid var(--background-modifier-border, #ddd)';
  settingsContainer.style.borderRadius = '4px';
  
  const addInput = (key: keyof LayoutSettings, label: string, type: 'number' | 'checkbox' = 'number') => {
    const div = document.createElement('div');
    div.style.display = 'grid';
    div.style.gridTemplateColumns = '2fr 1fr';
    div.style.alignItems = 'center';
    div.style.padding = '5px 0';
    div.style.borderBottom = '1px solid var(--background-modifier-border, #eee)';
    
    const scopedId = `${key}_${UID}`;

    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.htmlFor = scopedId;
    div.appendChild(lbl);
    
    if (type === 'checkbox') {
        const toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'toggle-switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!currentSettings[key];
        input.id = scopedId;
        input.name = key; 
        input.classList.add('mousetrap');
        
        const slider = document.createElement('span');
        slider.className = 'slider';
        toggleSwitch.appendChild(input);
        toggleSwitch.appendChild(slider);
        div.appendChild(toggleSwitch);
    } else {
        const input = document.createElement('input');
        
        // Use text+decimal to allow free typing
        input.type = 'text'; 
        input.inputMode = 'decimal';
        input.classList.add('mousetrap');

        input.value = currentSettings[key]?.toString() || '0';
        input.id = scopedId;
        input.name = key; 
        input.style.width = '100%';
        input.style.padding = '4px';
        input.style.border = '1px solid var(--background-modifier-border, #ddd)';
        input.style.borderRadius = '4px';

        // FIX: Stop ALL propagation to ensure Obsidian hotkeys don't trigger
        ['keydown', 'keyup', 'keypress'].forEach(evt => {
            input.addEventListener(evt, (e) => {
                if ((e as KeyboardEvent).key === 'Escape' || (e as KeyboardEvent).key === 'Tab') return;
                e.stopPropagation();
            });
        });

        div.appendChild(input);
    }
    settingsContainer.appendChild(div);
  };

  // General / Band Settings
  addInput('lineHeightMultiplier', 'Line Height Multiplier');
  addInput('minStripConfidence', 'Min Strip Confidence');
  addInput('minStripWidthPx', 'Min Strip Width (px)');
  addInput('debugValidation', 'Debug Validation', 'checkbox');
  addInput('maxIterMerges', 'Max Iter Merges');
  addInput('minBandConfidence', 'Min Band Confidence');
  addInput('bandTopBottomThresholdMultiplier', 'Band Top/Bottom Threshold Multiplier');
  addInput('inferredBandConfidence', 'Inferred Band Confidence');
  addInput('bandMergeGapPx', 'Band Merge Gap (px)');
  addInput('bandMergeGapLineHeightMultiplier', 'Band Merge Gap Line Height Multiplier');
  addInput('maxGapFractionOfPageHeight', 'Max Gap Fraction of Page Height');
  addInput('minGapsForTrim', 'Min Gaps For Trim');
  addInput('trimPercent', 'Trim Percent');
  addInput('lineHeightFromAvgMultiplier', 'Line Height From Avg Multiplier');
  addInput('floorMultiplier', 'Floor Multiplier');
  addInput('minOverlapFracForBand', 'Min Overlap Frac For Band');
  addInput('minRegionWidth', 'Min Region Width');
  addInput('columnThresholdLineHeightMultiplier', 'Column Threshold Line Height Multiplier');
  addInput('columnThresholdFallback', 'Column Threshold Fallback');

  // Paragraph Merger Settings
  // Place the FORCE override at the top of this section
  addInput('pmForceLinearMerge', '🔥 Force Linear Merge (Ignore All Layout/Styles)', 'checkbox');

  addInput('pmMinStripConfidenceSplit', 'PM Min Strip Confidence Split');
  addInput('pmMinStripWidthPx', 'PM Min Strip Width Px (for PM)');
  addInput('pmMinStripOverlapFrac', 'PM Min Strip Overlap Frac');
  addInput('pmInitialMergeBaselineTolNonMath', 'PM Init Merge Baseline Tol Non-Math');
  addInput('pmInitialMergeBaselineTolMath', 'PM Init Merge Baseline Tol Math');
  addInput('pmInitialMergeKernTolNonMath', 'PM Init Merge Kern Tol Non-Math');
  addInput('pmInitialMergeKernTolMath', 'PM Init Merge Kern Tol Math');
  addInput('pmHyphenContinuationTol', 'PM Hyphen Continuation Tol');
  addInput('pmInitialMergeAlignTolNonMath', 'PM Init Merge Align Tol Non-Math');
  addInput('pmInitialMergeAlignTolMath', 'PM Init Merge Align Tol Math');
  addInput('pmInitialMergeVerticalGapMultiplier', 'PM Init Merge Vertical Gap Multiplier');
  addInput('pmInitialMergeVerticalGapMaxMultiplier', 'PM Init Merge Vertical Gap Max Multiplier');
  addInput('pmStackedMergeAlignTol', 'PM Stacked Merge Align Tol');
  addInput('pmStackedMergeOverlapFrac', 'PM Stacked Merge Overlap Frac');
  addInput('pmStackedMergeVerticalGapMultiplier', 'PM Stacked Merge Vertical Gap Multiplier');
  addInput('pmStackedMergeVerticalGapMaxMultiplier', 'PM Stacked Merge Vertical Gap Max Multiplier');
  addInput('pmGeneralMergeAlignTol', 'PM General Merge Align Tol');
  addInput('pmGeneralMergeOverlapFrac', 'PM General Merge Overlap Frac');
  addInput('pmGeneralMergeVerticalGapMultiplier', 'PM General Merge Vertical Gap Multiplier');
  addInput('pmGeneralMergeVerticalGapMaxMultiplier', 'PM General Merge Vertical Gap Max Multiplier');
  addInput('pmNestedMergeOverlapFrac', 'PM Nested Merge Overlap Frac');
  addInput('pmStitchBaselineTolNonMath', 'PM Stitch Baseline Tol Non-Math');
  addInput('pmStitchBaselineTolMath', 'PM Stitch Baseline Tol Math');
  addInput('pmStitchKernTolNonMath', 'PM Stitch Kern Tol Non-Math');
  addInput('pmStitchKernTolMath', 'PM Stitch Kern Tol Math');
  addInput('pmInlineSpanBaselineTol', 'PM Inline Span Baseline Tol');
  addInput('pmInlineSpanKernTol', 'PM Inline Span Kern Tol');
  addInput('pmInlineSpanMaxWeightDiff', 'PM Inline Span Max Weight Diff');
  addInput('pmInlineSpanAllowMixedStyle', 'PM Inline Span Allow Mixed Style', 'checkbox');
  addInput('pmSameColumnCoverageRatio', 'PM Same Column Coverage Ratio');
  addInput('pmMathMergeBaselineTol', 'PM Math Merge Baseline Tol');
  addInput('pmMathMergeHorizTol', 'PM Math Merge Horiz Tol');
  addInput('pmMathMergeCenterTol', 'PM Math Merge Center Tol');
  addInput('pmSplitLineHeightTol', 'PM Split Line Height Tol');
  addInput('pmSplitBoundaryDedupTol', 'PM Split Boundary Dedup Tol');
  addInput('pmSplitInterWordGapTol', 'PM Split Inter Word Gap Tol');
  addInput('pmSplitColumnGapTol', 'PM Split Column Gap Tol');

  form.appendChild(settingsContainer);

  // --- Action Buttons (Bottom) ---
  const buttonDiv = document.createElement('div');
  buttonDiv.style.display = 'flex';
  buttonDiv.style.justifyContent = 'flex-end';
  buttonDiv.style.gap = '10px';
  buttonDiv.style.marginTop = '20px';
  buttonDiv.style.paddingTop = '10px';
  buttonDiv.style.borderTop = '1px solid var(--background-modifier-border, #ddd)';

  const closeDialog = () => {
      dialog.close();
      if (document.body.contains(dialog)) {
          document.body.removeChild(dialog);
      }
  };

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Close';
  cancelButton.onclick = closeDialog;

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.textContent = 'Save & Close';
  saveButton.style.backgroundColor = 'var(--interactive-accent, #007acc)';
  saveButton.style.color = 'white';
  saveButton.style.border = 'none';
  saveButton.style.padding = '6px 12px';
  saveButton.style.borderRadius = '4px';
  saveButton.style.cursor = 'pointer';
  saveButton.onclick = () => {
    const s = getCurrentFormValues();
    onSave(s);
    closeDialog();
  };

  buttonDiv.appendChild(cancelButton);
  buttonDiv.appendChild(saveButton);
  form.appendChild(buttonDiv);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  dialog.showModal();

  // Allow "Enter" to submit the main form (Save) if not in a text area
  dialog.addEventListener('keydown', (e) => {
      const isInput = e.target instanceof HTMLInputElement;
      if (e.key === 'Enter' && !isInput && e.target instanceof HTMLElement && e.target.tagName !== 'TEXTAREA') {
          if (e.target.tagName !== 'BUTTON') {
              e.preventDefault();
              saveButton.click();
          }
      }
  });

  // Close on Backdrop click
  dialog.addEventListener('click', (e) => {
      const rect = dialog.getBoundingClientRect();
      const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!isInDialog) {
          closeDialog();
      }
  });
}