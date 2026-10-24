import { listOllamaModels } from './ollama';
import { parseProviderSettings, translateConfigured, validateSettingsInput, type ProviderKind } from './settings';
import type { TranslationBatch } from './shared';
import { TranslationError } from './translation';
import { parseBudgetSettings, validateBudgetSettings, type BudgetSettings } from './budget';
import { DEFAULT_LANGUAGE, LEGACY_LANGUAGE, languageIdentity, parseLanguageSettings, validLanguageSettings, languageFields, type LanguageSettings } from './languages';

export interface SettingsInput {
  provider: ProviderKind;
  apiKey: string;
  remember: boolean;
  ollamaOrigin: string;
  ollamaModel: string;
  budgetSettings?: BudgetSettings;
  language?: LanguageSettings;
  expectedRevision?: number;
}

export async function loadSettings() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['apiKey', 'remember', 'provider', 'ollamaOrigin', 'ollamaModel', 'settingsVersion', 'budgetSettings', 'language', 'settingsRevision']),
    chrome.storage.session.get('apiKey')
  ]);
  return { apiKey: session.apiKey ?? local.apiKey ?? '', remember: local.remember === true, ...parseProviderSettings(local), budgetSettings: parseBudgetSettings(local.budgetSettings),
    language: parseLanguageSettings(local.language), revision: typeof local.settingsRevision === 'number' ? local.settingsRevision : 0 };
}

let writes: Promise<unknown> = Promise.resolve();
export async function settingsSettled(): Promise<void> { await writes; }
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation); writes = next.catch(() => {}); return next;
}
export function initializeLanguage(reason: string): Promise<void> {
  return serial(async () => {
    const raw = await chrome.storage.local.get(['language', 'settingsSchemaVersion']);
    if (raw.settingsSchemaVersion === 1) return;
    await chrome.storage.local.set({ language: reason === 'install' ? DEFAULT_LANGUAGE : LEGACY_LANGUAGE, settingsSchemaVersion: 1 });
  });
}
export async function saveSettings(input: SettingsInput): Promise<number> {
  const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', input });
  if (!result?.ok) throw new TranslationError(result?.error || '保存失败，请重试', 'config');
  return result.revision;
}
/** Only the trusted background calls these writers; all settings writes share one queue. */
export function persistSettings(input: SettingsInput): Promise<{ revision: number }> {
  return serial(() => writeSettings(input));
}
async function writeSettings(input: SettingsInput): Promise<{ revision: number }> {
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 300 || typeof input.remember !== 'boolean') {
    throw new TranslationError('设置无效', 'config');
  }
  const provider = validateSettingsInput(input);
  const previous = await loadSettings();
  if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) throw new TranslationError('设置已在其他位置更新，请重新打开设置页后保存', 'config');
  if (input.language !== undefined && !validLanguageSettings(input.language)) throw new TranslationError('请选择有效的语言组合，源语言与目标语言不能相同', 'config');
  const language = input.language ?? previous.language;
  const apiKey = input.apiKey.trim();
  const changed = provider.provider !== previous.provider || provider.ollamaOrigin !== previous.ollamaOrigin ||
    provider.ollamaModel !== previous.ollamaModel || apiKey !== previous.apiKey || languageIdentity(language) !== languageIdentity(previous.language);
  const settingsVersion = previous.version + (changed ? 1 : 0);
  const budgetSettings = input.budgetSettings === undefined ? previous.budgetSettings : validateBudgetSettings(input.budgetSettings);
  const revision = previous.revision + 1;
  const common = { ...provider, settingsVersion, budgetSettings, language, settingsSchemaVersion: 1, settingsRevision: revision };
  if (input.remember) {
    await chrome.storage.local.set({ ...common, apiKey, remember: true });
    await chrome.storage.session.remove('apiKey');
  } else {
    await chrome.storage.session.set({ apiKey });
    await chrome.storage.local.remove('apiKey');
    await chrome.storage.local.set({ ...common, remember: false });
  }
  return { revision };
}
export function persistLanguage(language: unknown, expectedVersion: number): Promise<void> {
  return serial(async () => {
    if (!validLanguageSettings(language)) throw new TranslationError('请选择有效的语言组合，源语言与目标语言不能相同', 'config');
    const previous = await loadSettings();
    if (previous.version !== expectedVersion) throw new TranslationError('设置已更新，请重新打开语言面板', 'config');
    if (languageIdentity(language) === languageIdentity(previous.language)) return;
    await chrome.storage.local.set({ language, settingsSchemaVersion: 1, settingsVersion: previous.version + 1, settingsRevision: previous.revision + 1 });
  });
}

export async function testProvider(input: SettingsInput) {
  if (typeof input.apiKey !== 'string' || input.apiKey.length > 300) throw new TranslationError('API Key 无效', 'key');
  const provider = validateSettingsInput(input);
  if (provider.provider === 'deepseek' && !input.apiKey.trim()) throw new TranslationError('请先填写 DeepSeek API Key', 'key');
  const language = input.language ?? LEGACY_LANGUAGE;
  if (!validLanguageSettings(language)) throw new TranslationError('语言设置无效', 'config');
  const samples: Record<string, string> = { en: 'The library opens every morning.', zh: '图书馆每天早晨开放。', ja: '図書館は毎朝開館します。', ko: '도서관은 매일 아침 문을 엽니다.', fr: 'La bibliothèque ouvre chaque matin.', de: 'Die Bibliothek öffnet jeden Morgen.', es: 'La biblioteca abre cada mañana.', pt: 'A biblioteca abre todas as manhãs.', ru: 'Библиотека открывается каждое утро.' };
  const source = language.scope === 'specific' ? language.source : language.target === 'en' ? 'zh' : 'en';
  const sample: TranslationBatch = { pageTitle: 'Connection test', ...languageFields(language), groups: [{ id: 'test', blocks: [
    { id: 'detail', role: 'paragraph', text: samples[source], requireTranslation: true }
  ] }] };
  const result = await translateConfigured({ ...provider, version: 0 }, input.apiKey.trim(), sample,
    AbortSignal.timeout(provider.provider === 'ollama' ? 120_000 : 30_000));
  return { preview: result.translations[0]?.text ?? '', usage: result.usage };
}

export async function models(origin: string): Promise<string[]> {
  return listOllamaModels(origin, AbortSignal.timeout(8_000));
}
