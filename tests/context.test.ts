import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBatches, cacheKey } from '../src/content/context.ts';
import { isTranslationBatch, type TextGroup, type TranslationBatch } from '../src/shared.ts';
import { parseTranslationResponse, TranslationError } from '../src/deepseek.ts';
import { validInlineMarkers } from '../src/inline.ts';

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

test('model results require every exact ID and a complete response', () => {
  const batch: TranslationBatch = { pageTitle: 'Atlas', targetLang: 'zh-CN', groups: [group] };
  const reply = (translations: unknown[], reason = 'stop') => ({ choices: [{ finish_reason: reason, message: { content: JSON.stringify({ translations }) } }] });
  assert.deepEqual(parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'detail', text: 'Atlas 可自动执行重复任务。' }]), batch).translations[0], { id: 'about', text: '项目简介' });
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }]), batch), TranslationError);
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'about', text: '关于' }]), batch), TranslationError);
  assert.throws(() => parseTranslationResponse(reply([{ id: 'about', text: '项目简介' }, { id: 'detail', text: 'Atlas 可自动执行重复任务。' }], 'length'), batch), TranslationError);
});
