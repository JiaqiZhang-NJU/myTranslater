import { translateDeepSeek } from './deepseek';
import { DEFAULT_OLLAMA_ORIGIN, normalizeOllamaOrigin, validateOllamaModel } from './ollama';
import { translateOllama } from './ollama';
import type { TranslationBatch, TranslationResult } from './shared';
import { TranslationError } from './translation';

export type ProviderKind = 'deepseek' | 'ollama';

export interface ProviderSettings {
  provider: ProviderKind;
  ollamaOrigin: string;
  ollamaModel: string;
  version: number;
}

export function parseProviderSettings(raw: Record<string, unknown>): ProviderSettings {
  const provider = raw.provider === 'ollama' ? 'ollama' : 'deepseek';
  const ollamaOrigin = typeof raw.ollamaOrigin === 'string' ? normalizeOllamaOrigin(raw.ollamaOrigin) : DEFAULT_OLLAMA_ORIGIN;
  const ollamaModel = typeof raw.ollamaModel === 'string' && raw.ollamaModel ? validateOllamaModel(raw.ollamaModel) : '';
  const version = typeof raw.settingsVersion === 'number' && Number.isSafeInteger(raw.settingsVersion) && raw.settingsVersion >= 0 ? raw.settingsVersion : 0;
  return { provider, ollamaOrigin, ollamaModel, version };
}

export function validateSettingsInput(raw: { provider?: unknown; ollamaOrigin?: unknown; ollamaModel?: unknown }): Omit<ProviderSettings, 'version'> {
  if (raw.provider !== 'deepseek' && raw.provider !== 'ollama') throw new TranslationError('请选择翻译方式', 'config');
  if (typeof raw.ollamaOrigin !== 'string' || typeof raw.ollamaModel !== 'string') throw new TranslationError('Ollama 设置无效', 'config');
  let ollamaOrigin = DEFAULT_OLLAMA_ORIGIN;
  let ollamaModel = '';
  if (raw.provider === 'ollama') {
    ollamaOrigin = normalizeOllamaOrigin(raw.ollamaOrigin);
    ollamaModel = raw.ollamaModel.trim() ? validateOllamaModel(raw.ollamaModel) : '';
  } else {
    try { ollamaOrigin = normalizeOllamaOrigin(raw.ollamaOrigin); } catch { /* Hidden Ollama fields do not block DeepSeek settings. */ }
    try { ollamaModel = raw.ollamaModel.trim() ? validateOllamaModel(raw.ollamaModel) : ''; } catch { /* Keep it empty until Ollama is selected. */ }
  }
  if (raw.provider === 'ollama' && !ollamaModel) throw new TranslationError('请选择 Ollama 本机模型', 'config');
  return { provider: raw.provider, ollamaOrigin, ollamaModel };
}

export function providerIdentity(settings: ProviderSettings): string {
  return settings.provider === 'ollama'
    ? `ollama:${settings.ollamaOrigin}:${settings.ollamaModel}:v${settings.version}`
    : `deepseek:deepseek-flash:v${settings.version}`;
}

export function translateConfigured(settings: ProviderSettings, apiKey: string, batch: TranslationBatch, signal: AbortSignal): Promise<TranslationResult> {
  return settings.provider === 'ollama'
    ? translateOllama(settings.ollamaOrigin, settings.ollamaModel, batch, signal)
    : translateDeepSeek(apiKey, batch, signal);
}
