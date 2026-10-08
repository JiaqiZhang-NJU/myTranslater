import { listOllamaModels } from './ollama';
import { parseProviderSettings, translateConfigured, validateSettingsInput, type ProviderKind } from './settings';
import type { TranslationBatch } from './shared';
import { TranslationError } from './translation';
import { parseBudgetSettings, validateBudgetSettings, type BudgetSettings } from './budget';

export interface SettingsInput {
  provider: ProviderKind;
  apiKey: string;
  remember: boolean;
  ollamaOrigin: string;
  ollamaModel: string;
  budgetSettings?: BudgetSettings;
}

export async function loadSettings() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['apiKey', 'remember', 'provider', 'ollamaOrigin', 'ollamaModel', 'settingsVersion', 'budgetSettings']),
    chrome.storage.session.get('apiKey')
  ]);
  return { apiKey: session.apiKey ?? local.apiKey ?? '', remember: local.remember === true, ...parseProviderSettings(local), budgetSettings: parseBudgetSettings(local.budgetSettings) };
}

export async function saveSettings(input: SettingsInput): Promise<void> {
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 300 || typeof input.remember !== 'boolean') {
    throw new TranslationError('设置无效', 'config');
  }
  const provider = validateSettingsInput(input);
  const previous = await loadSettings();
  const apiKey = input.apiKey.trim();
  const changed = provider.provider !== previous.provider || provider.ollamaOrigin !== previous.ollamaOrigin ||
    provider.ollamaModel !== previous.ollamaModel || apiKey !== previous.apiKey;
  const settingsVersion = previous.version + (changed ? 1 : 0);
  const budgetSettings = input.budgetSettings === undefined ? previous.budgetSettings : validateBudgetSettings(input.budgetSettings);
  if (input.remember) {
    await chrome.storage.local.set({ ...provider, settingsVersion, budgetSettings, apiKey, remember: true });
    await chrome.storage.session.remove('apiKey');
  } else {
    await chrome.storage.session.set({ apiKey });
    await chrome.storage.local.remove('apiKey');
    await chrome.storage.local.set({ ...provider, settingsVersion, budgetSettings, remember: false });
  }
}

export async function testProvider(input: SettingsInput) {
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 300) throw new TranslationError('API Key 无效', 'key');
  const provider = validateSettingsInput(input);
  if (provider.provider === 'deepseek' && !input.apiKey.trim()) throw new TranslationError('请先填写 DeepSeek API Key', 'key');
  const sample: TranslationBatch = { pageTitle: 'Atlas project', targetLang: 'zh-CN', groups: [{ id: 'test', blocks: [
    { id: 'about', role: 'heading', text: 'About' },
    { id: 'detail', role: 'paragraph', text: 'Atlas is a small tool for developers.' }
  ] }] };
  const result = await translateConfigured({ ...provider, version: 0 }, input.apiKey.trim(), sample,
    AbortSignal.timeout(provider.provider === 'ollama' ? 120_000 : 30_000));
  return { preview: result.translations[0]?.text ?? '', usage: result.usage };
}

export async function models(origin: string): Promise<string[]> {
  return listOllamaModels(origin, AbortSignal.timeout(8_000));
}
