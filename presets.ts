// presets.ts
// ════════════════════════════════════════════════════════════════
// One-click configuration presets for the Progressive Disclosure
// settings UI. Each preset applies a bundle of settings at once so
// users can get started without touching 15 individual fields.
// ════════════════════════════════════════════════════════════════

import type { OpenRouterTranslatorSettings, ApiProviderId } from './types';

export type SettingsLevel = 'quick' | 'standard' | 'advanced';

export interface PresetDef {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** Partial settings to merge into the current settings on apply. */
  apply: (settings: OpenRouterTranslatorSettings) => void;
}

/**
 * Apply a deep partial to a settings object in-place.
 * Only top-level keys are merged; nested objects (like providerSettings)
 * are replaced wholesale to keep the logic simple.
 */
function applyPartial(settings: OpenRouterTranslatorSettings, partial: Partial<OpenRouterTranslatorSettings>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      (settings as any)[key] = value;
    }
  }
}

export const PRESETS: PresetDef[] = [
  {
    id: 'cloud-openai',
    label: 'Cloud (OpenAI)',
    icon: '☁️',
    description: 'Use OpenAI GPT-4o for translation. Requires an API key.',
    apply: (s) => {
      s.apiProvider = 'openai' as ApiProviderId;
      if (!s.providerSettings.openai) s.providerSettings.openai = {} as any;
      s.providerSettings.openai!.model = 'gpt-4o';
      s.useBatchTranslation = true;
      s.backgroundTranslationConcurrency = 3;
      s.maxBatchChars = 4000;
    },
  },
  {
    id: 'cloud-claude',
    label: 'Cloud (Claude)',
    icon: '🤖',
    description: 'Use Anthropic Claude 3.5 Sonnet. Best quality for complex documents.',
    apply: (s) => {
      s.apiProvider = 'anthropic' as ApiProviderId;
      if (!s.providerSettings.anthropic) s.providerSettings.anthropic = {} as any;
      s.providerSettings.anthropic!.model = 'claude-3-5-sonnet-20241022';
      s.useBatchTranslation = true;
      s.backgroundTranslationConcurrency = 3;
    },
  },
  {
    id: 'local-ollama',
    label: 'Local (Ollama)',
    icon: '🏠',
    description: 'Run everything locally with Ollama. No API key, privacy-friendly.',
    apply: (s) => {
      s.apiProvider = 'ollama' as ApiProviderId;
      if (!s.providerSettings.ollama) s.providerSettings.ollama = {} as any;
      s.providerSettings.ollama!.apiEndpoint = 'http://localhost:11434';
      s.providerSettings.ollama!.model = 'llama3';
      s.useBatchTranslation = true;
      s.backgroundTranslationConcurrency = 1;  // local models are slow
      s.sequentialDelayMs = 200;
    },
  },
  {
    id: 'ocr-focused',
    label: 'OCR-focused',
    icon: '👁',
    description: 'Optimized for scanned PDFs: vision-capable OCR provider + internal layout.',
    apply: (s) => {
      s.layoutEngine = 'internal';
      s.ocrProvider.provider = 'openai' as ApiProviderId;
      s.ocrProvider.model = 'gpt-4o';
      s.ocrProvider.inputMode = 'image';
      s.ocrProvider.workflowMode = 'per-page';
      s.ocrProvider.jsonStrictness = 'strict';
    },
  },
  {
    id: 'fast-batch',
    label: 'Fast batch',
    icon: '⚡',
    description: 'Maximum parallelism for fast bulk translation of many PDFs.',
    apply: (s) => {
      s.useBatchTranslation = true;
      s.backgroundTranslationConcurrency = 5;
      s.maxBatchChars = 6000;
      // Stage 0.1 (Q17): enableSemanticMerging was removed (dead field).
    },
  },
  {
    id: 'quality-first',
    label: 'Quality first',
    icon: '💎',
    description: 'Sequential translation, lower temperature for best quality.',
    apply: (s) => {
      s.useBatchTranslation = false;
      s.backgroundTranslationConcurrency = 1;
      s.sequentialDelayMs = 300;
      // Stage 0.1 (Q17): enableSemanticMerging was removed (dead field).
      // Set temperature to 0.2 for the active provider (if it supports temperature)
      const activeProvider = s.providerSettings[s.apiProvider];
      if (activeProvider && typeof activeProvider.temperature === 'number') {
        activeProvider.temperature = 0.2;
      }
    },
  },
];

/** Find a preset by id. */
export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find(p => p.id === id);
}

/** Apply a preset to settings in-place. Returns a list of what was changed (for Notice). */
export function applyPreset(id: string, settings: OpenRouterTranslatorSettings): string[] {
  const preset = getPreset(id);
  if (!preset) return [];
  preset.apply(settings);
  settings.currentPreset = id;
  return [preset.label];
}
