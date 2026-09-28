import assert from 'node:assert/strict';
import test from 'node:test';
import { listOllamaModels, normalizeOllamaOrigin, parseOllamaResponse, validateOllamaModel } from '../src/ollama.ts';
import { providerIdentity, translateConfigured, validateSettingsInput } from '../src/settings.ts';
import type { TranslationBatch } from '../src/shared.ts';
import { TranslationError } from '../src/translation.ts';

const batch: TranslationBatch = { pageTitle: 'Atlas Documentation', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
  { id: 'b1', role: 'heading', text: 'About' },
  { id: 'b2', role: 'paragraph', text: 'Atlas automates developer tasks.' }
] }] };
const translations = [{ id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 可自动执行开发任务。' }];

test('Ollama address is limited to local origins and model rejects cloud labels', () => {
  assert.equal(normalizeOllamaOrigin('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(normalizeOllamaOrigin('http://127.0.0.1:11500'), 'http://127.0.0.1:11500');
  for (const address of ['https://localhost:11434', 'http://localhost.evil:11434', 'http://127.0.0.1:11434/admin', 'http://user:pass@localhost:11434']) {
    assert.throws(() => normalizeOllamaOrigin(address), TranslationError);
  }
  assert.throws(() => validateOllamaModel('example:cloud'), TranslationError);
  assert.throws(() => validateSettingsInput({ provider: 'ollama', ollamaOrigin: 'http://localhost:11434', ollamaModel: '' }), TranslationError);
});

test('local model listing uses only Ollama tags and excludes cloud labels', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/tags');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'example:cloud' }] }), { status: 200 });
  };
  try { assert.deepEqual(await listOllamaModels('http://127.0.0.1:11434'), ['qwen3:8b']); }
  finally { globalThis.fetch = original; }
});

test('provider selection calls Ollama without API key and keeps contextual JSON validation', async () => {
  const original = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/chat');
    assert.equal((init?.headers as Record<string, string>)?.Authorization, undefined);
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations }) }, prompt_eval_count: 42, eval_count: 19 }), { status: 200 });
  };
  try {
    const settings = { provider: 'ollama' as const, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 };
    const result = await translateConfigured(settings, '', batch, new AbortController().signal);
    assert.equal(request?.model, 'qwen3:8b');
    assert.equal(request?.stream, false);
    assert.deepEqual(((request?.format as { properties: { translations: { items: { properties: { id: { enum: string[] } } } } } }).properties.translations.items.properties.id.enum), ['b1', 'b2']);
    assert.equal(request?.think, false);
    assert.equal(JSON.parse((request?.messages as { content: string }[])[1].content).groups[0].blocks[0].text, 'About');
    assert.equal(result.usage?.totalTokens, 61);
    assert.notEqual(providerIdentity(settings), providerIdentity({ provider: 'deepseek', ollamaOrigin: settings.ollamaOrigin, ollamaModel: settings.ollamaModel, version: 3 }));
  } finally { globalThis.fetch = original; }
});

test('malformed local batch is retried as smaller contextual batches without trusting wrong IDs', async () => {
  const original = globalThis.fetch;
  const requested: string[][] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[]; format: unknown };
    const part = JSON.parse(body.messages[1].content) as TranslationBatch;
    const ids = part.groups.flatMap(group => group.blocks.map(block => block.id));
    requested.push(ids);
    const items = ids.length > 1 ? [{ id: 'wrong', text: '项目简介' }, { id: 'b2', text: 'Atlas 可自动执行开发任务。' }]
      : [{ id: ids[0], text: ids[0] === 'b1' ? '项目简介' : 'Atlas 可自动执行开发任务。' }];
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: items }) }, prompt_eval_count: 10, eval_count: 5 }), { status: 200 });
  };
  try {
    const result = await translateConfigured({ provider: 'ollama', ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 }, '', batch, new AbortController().signal);
    assert.deepEqual(requested, [['b1', 'b2'], ['b1'], ['b2']]);
    assert.deepEqual(result.translations, translations);
    assert.equal(result.usage?.totalTokens, 30);
  } finally { globalThis.fetch = original; }
});

test('broken nested inline markers fall back to a plain translation for one block', async () => {
  const original = globalThis.fetch;
  const rich: TranslationBatch = { pageTitle: 'Atlas', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
    { id: 'b1', role: 'paragraph', text: 'Read ⟦i1⟧the ⟦i2⟧API guide⟦/i2⟧ first⟦/i1⟧.' }
  ] }] };
  const requests: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const text = (JSON.parse(body.messages[1].content) as TranslationBatch).groups[0].blocks[0].text;
    requests.push(text);
    const translated = text.includes('⟦') ? '请先阅读 ⟦i1⟧API 指南⟦/i2⟧。' : '请先阅读 API 指南。';
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text: translated }] }) } }), { status: 200 });
  };
  try {
    const result = await translateConfigured({ provider: 'ollama', ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 }, '', rich, new AbortController().signal);
    assert.equal(result.translations[0].text, '请先阅读 API 指南。');
    assert.deepEqual(requests, [rich.groups[0].blocks[0].text, 'Read the API guide first.']);
  } finally { globalThis.fetch = original; }
});

test('Ollama masks dotted API identifiers and restores exact spelling', async () => {
  const original = globalThis.fetch;
  const technical: TranslationBatch = { pageTitle: 'DOM', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
    { id: 'b1', role: 'cell', text: 'Document.body', context: 'Property' }
  ] }] };
  const seen: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const text = (JSON.parse(body.messages[1].content) as TranslationBatch).groups[0].blocks[0].text;
    seen.push(text);
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text: '文档对象模型 __MT_CODE_1__' }] }) } }), { status: 200 });
  };
  try {
    const result = await translateConfigured({ provider: 'ollama', ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 }, '', technical, new AbortController().signal);
    assert.deepEqual(seen, ['__MT_CODE_1__']);
    assert.equal(result.translations[0].text, 'Document.body');
  } finally { globalThis.fetch = original; }
});

test('a model that damages the identifier placeholder gets one unmasked retry', async () => {
  const original = globalThis.fetch;
  const technical: TranslationBatch = { pageTitle: 'DOM', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
    { id: 'b1', role: 'paragraph', text: 'Edit Document.body before applying a new style.' }
  ] }] };
  const seen: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const text = (JSON.parse(body.messages[1].content) as TranslationBatch).groups[0].blocks[0].text;
    seen.push(text);
    const output = text.includes('__MT_CODE_1__') ? '编辑文档.body 后应用新样式。' : '编辑 Document.body 后应用新样式。';
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text: output }] }) } }), { status: 200 });
  };
  try {
    const result = await translateConfigured({ provider: 'ollama', ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 }, '', technical, new AbortController().signal);
    assert.deepEqual(seen, ['Edit __MT_CODE_1__ before applying a new style.', technical.groups[0].blocks[0].text]);
    assert.equal(result.translations[0].text, '编辑 Document.body 后应用新样式。');
  } finally { globalThis.fetch = original; }
});

test('HTTP 403 identifies Ollama extension-origin configuration', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 403 });
  try {
    const settings = { provider: 'ollama' as const, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', version: 3 };
    await assert.rejects(translateConfigured(settings, '', batch, new AbortController().signal), error =>
      error instanceof TranslationError && error.message.includes('OLLAMA_ORIGINS') && error.message.includes('HTTP 403'));
  } finally { globalThis.fetch = original; }
});

test('Ollama response rejects missing IDs and incomplete generation', () => {
  const reply = (items: unknown[], reason = 'stop') => ({ done: true, done_reason: reason, message: { content: JSON.stringify({ translations: items }) } });
  assert.throws(() => parseOllamaResponse(reply([{ id: 'b1', text: '项目简介' }]), batch), TranslationError);
  assert.throws(() => parseOllamaResponse(reply(translations, 'length'), batch), TranslationError);
  assert.deepEqual(parseOllamaResponse({ done: true, done_reason: 'stop', message: { content: '', thinking: JSON.stringify({ translations }) } }, batch).translations, translations);
  assert.throws(() => parseOllamaResponse({ done: false, message: { content: '', thinking: JSON.stringify({ translations }) } }, batch), TranslationError);
});
