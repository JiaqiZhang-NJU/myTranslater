import assert from 'node:assert/strict';
import test from 'node:test';
import { translateDeepSeek } from '../src/deepseek.ts';
import type { TranslationBatch } from '../src/shared.ts';

test('DeepSeek request sends contextual groups with JSON mode and thinking disabled', async () => {
  const batch: TranslationBatch = {
    pageTitle: 'Atlas Documentation', targetLang: 'zh-CN',
    groups: [{ id: 'g1', blocks: [
      { id: 'b1', role: 'heading', text: 'About' },
      { id: 'b2', role: 'paragraph', text: 'Atlas automates developer tasks.' }
    ] }]
  };
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  let address = '';
  globalThis.fetch = async (input, init) => {
    address = String(input);
    sent = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [
        { id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 可自动执行开发任务。' }
      ] }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await translateDeepSeek('test-key', batch, new AbortController().signal);
    assert.equal(address, 'https://api.deepseek.com/chat/completions');
    assert.equal(sent?.model, 'deepseek-flash');
    assert.deepEqual(sent?.thinking, { type: 'disabled' });
    assert.deepEqual(sent?.response_format, { type: 'json_object' });
    const messages = sent?.messages as { role: string; content: string }[];
    assert.equal(JSON.parse(messages[1].content).groups[0].blocks[0].text, 'About');
    assert.equal(result.usage?.totalTokens, 60);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
