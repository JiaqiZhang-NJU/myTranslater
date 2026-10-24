export const TARGET_LANGUAGES = [
  ['zh-CN', '简体中文', 'Simplified Chinese'], ['zh-TW', '繁体中文', 'Traditional Chinese'],
  ['en', '英语', 'English'], ['ja', '日语', 'Japanese'], ['ko', '韩语', 'Korean'],
  ['fr', '法语', 'French'], ['de', '德语', 'German'], ['es', '西班牙语', 'Spanish'],
  ['pt', '葡萄牙语', 'Portuguese'], ['ru', '俄语', 'Russian']
] as const;
export type TargetLanguage = typeof TARGET_LANGUAGES[number][0];
export type SourceLanguage = 'zh' | Exclude<TargetLanguage, 'zh-CN' | 'zh-TW'>;
export type LanguageSettings = { scope: 'all'; source: null; target: TargetLanguage }
  | { scope: 'specific'; source: SourceLanguage; target: TargetLanguage };
export const SOURCE_LANGUAGES = [['zh', '中文'], ...TARGET_LANGUAGES.filter(([code]) => !code.startsWith('zh')).map(([code, name]) => [code, name])] as readonly (readonly [string, string])[];
export const DEFAULT_LANGUAGE: LanguageSettings = { scope: 'all', source: null, target: 'zh-CN' };
export const LEGACY_LANGUAGE: LanguageSettings = { scope: 'specific', source: 'en', target: 'zh-CN' };
export const LANGUAGE_PROTOCOL = 3;

export function isTargetLanguage(value: unknown): value is TargetLanguage { return TARGET_LANGUAGES.some(([code]) => code === value); }
export function normalizeSource(value: string): string { return value.toLowerCase().replace('_', '-').split('-')[0]; }
export function validLanguageSettings(value: unknown): value is LanguageSettings {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<LanguageSettings>;
  return isTargetLanguage(rule.target) && (rule.scope === 'all' ? rule.source === null
    : rule.scope === 'specific' && SOURCE_LANGUAGES.some(([code]) => code === rule.source) && rule.source !== rule.target);
}
export function parseLanguageSettings(value: unknown, fallback: LanguageSettings = LEGACY_LANGUAGE): LanguageSettings {
  return validLanguageSettings(value) ? { ...value } : { ...fallback };
}
export function languageIdentity(rule: LanguageSettings): string { return JSON.stringify([LANGUAGE_PROTOCOL, rule.scope, rule.source, rule.target]); }
export function languageSummary(rule: LanguageSettings): string {
  const target = TARGET_LANGUAGES.find(([code]) => code === rule.target)![1];
  return rule.scope === 'all' ? `全部 → ${target}` : `${SOURCE_LANGUAGES.find(([code]) => code === rule.source)![1]} → ${target}`;
}
export function targetName(code: TargetLanguage): string { return TARGET_LANGUAGES.find(([value]) => value === code)![2]; }
export function targetLabel(code: TargetLanguage): string { return TARGET_LANGUAGES.find(([value]) => value === code)![1]; }
export function batchLanguage(batch: { targetLang: TargetLanguage; translationScope?: 'all' | 'specific'; sourceLang?: SourceLanguage }): LanguageSettings {
  return batch.translationScope === 'all' ? { scope: 'all', source: null, target: batch.targetLang }
    : { scope: 'specific', source: batch.sourceLang ?? 'en', target: batch.targetLang };
}
export function languageFields(rule: LanguageSettings) {
  return { targetLang: rule.target, translationScope: rule.scope, ...(rule.scope === 'specific' ? { sourceLang: rule.source } : {}) };
}
