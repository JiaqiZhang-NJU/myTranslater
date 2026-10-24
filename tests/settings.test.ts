import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeLanguage, loadSettings, persistLanguage, persistSettings } from '../src/options-service.ts';
import { DEFAULT_LANGUAGE, LEGACY_LANGUAGE } from '../src/languages.ts';

test('settings migration, atomic updates and concurrent writers retain unrelated settings', async () => {
  const local = new Map<string, unknown>(); const session = new Map<string, unknown>();
  const area = (data: Map<string, unknown>) => ({
    async get(keys: string | string[]) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => data.has(key)).map(key => [key, data.get(key)])); },
    async set(items: Record<string, unknown>) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
    async remove(key: string) { data.delete(key); }
  });
  Object.defineProperty(globalThis, 'chrome', { value: { storage: { local: area(local), session: area(session) } }, configurable: true });
  try {
    await initializeLanguage('install'); assert.deepEqual((await loadSettings()).language, DEFAULT_LANGUAGE);
    local.clear(); await initializeLanguage('update'); assert.deepEqual((await loadSettings()).language, LEGACY_LANGUAGE);
    const input = { provider: 'ollama' as const, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3.5:4b', apiKey: '', remember: false };
    await persistSettings(input);
    const initial = await loadSettings();
    const budgetSettings = { deepseek: { enabled: true, limit: 40000 }, ollama: { enabled: false, limit: 50000 } };
    const pending = persistSettings({ ...input, budgetSettings, expectedRevision: initial.revision });
    const quickChange = persistLanguage({ scope: 'specific', source: 'ja', target: 'en' }, initial.version);
    await Promise.all([pending, quickChange]);
    const updated = await loadSettings();
    assert.equal(updated.ollamaModel, input.ollamaModel);
    assert.deepEqual(updated.budgetSettings, budgetSettings);
    assert.deepEqual(updated.language, { scope: 'specific', source: 'ja', target: 'en' });
    assert.equal(updated.version, initial.version + 1);
    await assert.rejects(persistSettings({ ...input, language: LEGACY_LANGUAGE, expectedRevision: initial.revision }), /其他位置更新/);
    await assert.rejects(persistLanguage(DEFAULT_LANGUAGE, initial.version), /设置已更新/);
    const beforeUnchanged = await loadSettings();
    await persistLanguage(beforeUnchanged.language, beforeUnchanged.version);
    assert.equal((await loadSettings()).revision, beforeUnchanged.revision);
    await persistSettings({ ...input, budgetSettings, language: updated.language, expectedRevision: updated.revision });
    assert.equal((await loadSettings()).version, updated.version, 'saving unchanged translation settings preserves their version');
    await initializeLanguage('update'); assert.deepEqual((await loadSettings()).language, updated.language, 'future updates preserve explicit language settings');
  } finally { delete (globalThis as { chrome?: unknown }).chrome; }
});
