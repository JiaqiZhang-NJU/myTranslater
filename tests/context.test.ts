import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBatches, cacheKey } from '../src/content/context.ts';
import { isTranslationBatch, type TextGroup, type TranslationBatch } from '../src/shared.ts';
import { parseTranslationResponse, TranslationError } from '../src/deepseek.ts';
import { renderInline, validInlineMarkers, withoutInlineMarkers } from '../src/inline.ts';

const group: TextGroup = { id: 'g1', blocks: [
  { id: 'about', role: 'heading', text: 'About' },
  { id: 'detail', role: 'paragraph', text: 'Atlas automates repetitive development tasks.' }
] };

test('related heading and paragraph stay together in a contextual request', () => {
  const [batch] = makeBatches('Atlas Documentation', [group]);
  assert.equal(batch.groups.length, 1);
  assert.deepEqual(batch.groups[0].blocks.map(block => block.id), ['about', 'detail']);
  assert.equal(isTranslationBatch(batch), true);
});

test('cache identity changes when section context changes', () => {
  assert.notEqual(cacheKey('Example', { ...group, section: 'Company' }, 'deepseek:v1'), cacheKey('Example', { ...group, section: 'Project' }, 'deepseek:v1'));
  assert.notEqual(cacheKey('Example', group, 'deepseek:v1'), cacheKey('Example', group, 'ollama:qwen:v1'));
  assert.notEqual(cacheKey('Example', group, 'deepseek:v1'), cacheKey('Example', { ...group, blocks: [{ ...group.blocks[0], context: 'navigation' }, group.blocks[1]] }, 'deepseek:v1'));
});

test('inline link and emphasis markers must survive translation once and remain nested', () => {
  const source = 'Read ⟦i1⟧the ⟦i2⟧guide⟦/i2⟧⟦/i1⟧';
  assert.equal(validInlineMarkers(source, '阅读⟦i1⟧这份⟦i2⟧指南⟦/i2⟧⟦/i1⟧'), true);
  assert.equal(validInlineMarkers(source, '阅读这份指南'), false);
  assert.equal(validInlineMarkers(source, '⟦i1⟧指南⟦/i1⟧⟦i2⟧指南⟦/i2⟧'), true);
  assert.equal(validInlineMarkers(source, '⟦i1⟧指南⟦/i2⟧⟦i2⟧指南⟦/i1⟧'), false);
  assert.equal(validInlineMarkers(source, '⟦i1⟧指南⟦/i1⟧⟦i2⟧指南⟦/i2⟧⟦i3⟧额外⟦/i3⟧'), false);
});

test('plain local fallback displays text without inserting broken inline elements', () => {
  assert.equal(withoutInlineMarkers('Read ⟦i1⟧the ⟦i2⟧API guide⟦/i2⟧ first⟦/i1⟧.'), 'Read the API guide first.');
  const previous = (globalThis as { document?: unknown }).document;
  const fragment = { children: [] as unknown[], appendChild(node: unknown) { this.children.push(node); } };
  Object.defineProperty(globalThis, 'document', { value: {
    createDocumentFragment: () => fragment,
    createTextNode: (text: string) => ({ text })
  }, configurable: true });
  try {
    const rendered = renderInline('请先阅读 API 指南。', new Map([['i1', {} as Element], ['i2', {} as Element]]));
    assert.equal(rendered, fragment);
    assert.deepEqual(fragment.children, [{ text: '请先阅读 API 指南。' }]);
  } finally {
    if (previous === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, 'document', { value: previous, configurable: true });
  }
});

test('model results require every exact ID and a complete response', () => {
  const batch: TranslationBatch = { pageTitle: 'Atlas', targetLang: 'zh-CN', groups: [group] };
  const reply = (translations: unknown[], reason = 'stop') => ({ choices: [{ finish_reason: reason, message: { content: JSON.stringify({ translations }) } }] });
  assert.deepEqual(parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'detail', text: 'Atlas 可自动执行重复任务。' }]), batch).translations[0], { id: 'about', text: '项目简介' });
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }]), batch), TranslationError);
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'about', text: '关于' }]), batch), TranslationError);
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'detail', text: 'Atlas 可自动执行重复任务。' }], 'length'), batch), TranslationError);
});

test('technical API identifiers keep their source letter case', () => {
  const batch: TranslationBatch = { pageTitle: 'DOM Reference', targetLang: 'zh-CN', groups: [{ id: 'properties', blocks: [
    { id: 'property', role: 'cell', text: 'Document.body', context: 'Property' },
    { id: 'method', role: 'paragraph', text: 'Use Document.querySelector() to find an element.' }
  ] }] };
  const reply = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [
    { id: 'property', text: 'document.body' },
    { id: 'method', text: '使用 document.queryselector() 查找元素。' }
  ] }) } }] };
  assert.deepEqual(parseTranslationResponse(reply, batch).translations, [
    { id: 'property', text: 'Document.body' },
    { id: 'method', text: '使用 Document.querySelector() 查找元素。' }
  ]);
});

test('an English paragraph copied as its own translation is rejected', () => {
  const source = 'A missing match may return null, so a script should check the result before reading its properties.';
  const batch: TranslationBatch = { pageTitle: 'DOM Reference', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
    { id: 'b1', role: 'paragraph', text: source }
  ] }] };
  const reply = (text: string) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text }] }) } }] });
  assert.throws(() => parseTranslationResponse(reply(source), batch), /未将英文正文译为中文/);
  assert.throws(() => parseTranslationResponse(reply(`请看 ${source}`), batch), /未将英文正文译为中文/);
  assert.deepEqual(parseTranslationResponse(reply('未找到匹配项时可能返回 null，因此脚本应先检查结果。'), batch).translations[0].id, 'b1');
});
