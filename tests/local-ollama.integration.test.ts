import assert from 'node:assert/strict';
import test from 'node:test';
import { translateOllama } from '../src/ollama.ts';
import type { TranslationBatch } from '../src/shared.ts';

test('real local Ollama translates a contextual title and paragraph', { skip: process.env.OLLAMA_INTEGRATION !== '1' }, async () => {
  const model = process.env.OLLAMA_MODEL;
  assert.ok(model, 'Set OLLAMA_MODEL to an installed model name');
  const batch: TranslationBatch = { pageTitle: 'Atlas Documentation', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
    { id: 'b1', role: 'heading', text: 'About' },
    { id: 'b2', role: 'paragraph', text: 'Atlas automates repetitive development tasks.' }
  ] }] };
  const result = await translateOllama('http://127.0.0.1:11434', model, batch, AbortSignal.timeout(120_000));
  assert.deepEqual(result.translations.map(item => item.id).sort(), ['b1', 'b2']);
  assert.ok(result.translations.every(item => item.text.length > 0));
  assert.ok(result.usage?.totalTokens && result.usage.totalTokens > 0);
});
