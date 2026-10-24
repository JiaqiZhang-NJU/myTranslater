import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_LANGUAGES, SOURCE_LANGUAGES, languageIdentity, languageFields, validLanguageSettings, type LanguageSettings } from '../src/languages.ts';
import { isTranslationBatch, type TranslationBatch } from '../src/shared.ts';
import { cacheKey } from '../src/content/context.ts';
import { prepareTranslation, languageSegments, type Detection } from '../src/language-policy.ts';
import { translationPrompt, validateTranslations } from '../src/translation.ts';

const en = 'The library opens every morning and closes after the last visitor has left.';
const zh = '图书馆每天早晨开放，最后一位读者离开后关闭。';
const ja = '図書館は毎朝開館し、最後の利用者が帰った後に閉館します。';
const fr = 'La bibliothèque ouvre chaque matin et ferme après le départ du dernier visiteur.';
const ar = 'تفتح المكتبة أبوابها كل صباح وتغلق بعد مغادرة آخر زائر.';
// Fixed CLD observations from the P0 public-text probe, including its short-word error.
const observations = new Map<string, Detection>([
  ...[[en, 'en'], [zh, 'zh'], [ja, 'ja'], [fr, 'fr'], [ar, 'ar']].map(([text, language]): [string, Detection] => [text, { isReliable: true, languages: [{ language, percentage: 100 }] }]),
  ['Open', { isReliable: false, languages: [{ language: 'nl', percentage: 100 }] }]
]);
const detect = async (text: string): Promise<Detection> => observations.get(text.trim()) ?? { isReliable: false, languages: [] };
function batch(rule: LanguageSettings, texts = [en]): TranslationBatch {
  return { pageTitle: 'Library', ...languageFields(rule), groups: [{ id: 'g1', blocks: texts.map((text, i) => ({ id: `b${i}`, role: 'paragraph', text })) }] };
}
const specific: LanguageSettings = { scope: 'specific', source: 'en', target: 'zh-CN' };

test('all supported language combinations validate and invalid combinations do not', () => {
  for (const [target] of TARGET_LANGUAGES) {
    assert.ok(isTranslationBatch(batch({ scope: 'all', source: null, target })));
    for (const [source] of SOURCE_LANGUAGES) {
      const rule = { scope: 'specific', source, target };
      assert.equal(validLanguageSettings(rule), source !== target);
      if (validLanguageSettings(rule)) assert.ok(isTranslationBatch(batch(rule)));
    }
  }
  for (const value of [{ scope: 'all', source: 'en', target: 'zh-CN' }, { scope: 'specific', source: 'xx', target: 'en' }, { scope: 'all', source: null, target: 'xx' }]) assert.equal(validLanguageSettings(value), false);
  assert.equal(isTranslationBatch({ ...batch(specific), translationScope: 'invalid' }), false);
  assert.equal(isTranslationBatch({ ...batch(specific), translationScope: 'all' }), false);
  assert.equal(isTranslationBatch({ ...batch(specific), sourceLang: undefined }), false);
});
test('language scope, source and target separate cache entries; display settings do not', () => {
  const group = batch(specific).groups[0];
  const key = (rule: LanguageSettings) => cacheKey('Library', group, 'model', rule);
  assert.notEqual(key(specific), key({ scope: 'all', source: null, target: 'zh-CN' }));
  assert.notEqual(key(specific), key({ ...specific, target: 'ja' }));
  assert.notEqual(key(specific), key({ ...specific, source: 'fr' }));
  assert.equal(languageIdentity(specific), languageIdentity({ ...specific }));
});
test('specific filtering preserves other languages and keeps their context available', async () => {
  const prepared = await prepareTranslation(batch(specific, [en, ja, fr]), detect);
  assert.deepEqual(prepared.batch?.groups[0].blocks.map(block => block.id), ['b0']);
  assert.match(prepared.batch!.groups[0].reference!, /bibliothèque/);
  const result = prepared.finish({ translations: [{ id: 'b0', text: zh }], usage: null });
  assert.equal(result.translations[0].text, zh);
  assert.equal(result.translations[1].status, 'unchanged');
  assert.equal(result.translations[1].text, ja);
  assert.equal(result.translations[2].reason, 'other');
});
test('all mode skips the exact target, unsupported languages and bare identifiers', async () => {
  const prepared = await prepareTranslation(batch({ scope: 'all', source: null, target: 'en' }, [en, ja, ar, 'Document.body']), detect);
  assert.deepEqual(prepared.batch?.groups[0].blocks.map(block => block.id), ['b1']);
  const result = prepared.finish({ translations: [{ id: 'b1', text: en }], usage: null });
  assert.equal(result.translations[0].reason, 'target');
  assert.equal(result.translations[2].reason, 'unsupported');
  assert.equal(result.translations[3].reason, 'nonlinguistic');
});
test('uncertain Latin short words are not assumed English; a local language hint resolves a label', async () => {
  const input = batch(specific, ['Open']);
  const uncertain = await prepareTranslation(input, detect);
  assert.equal(uncertain.batch, null);
  assert.equal(uncertain.finish({ translations: [], usage: null }).translations[0].reason, 'uncertain');
  input.groups[0].blocks[0].lang = 'en-US';
  assert.equal((await prepareTranslation(input, detect)).batch?.groups[0].blocks.length, 1);
  input.pageLang = 'en'; input.groups[0].blocks[0].lang = undefined;
  assert.equal((await prepareTranslation(input, detect)).batch, null, 'a page-level hint cannot override the conflicting short-word candidate');
  const kanji = batch({ scope: 'specific', source: 'ja', target: 'en' }, ['図書館']);
  kanji.groups[0].blocks[0].lang = 'ja';
  assert.equal((await prepareTranslation(kanji, detect)).batch?.groups[0].blocks.length, 1, 'shared Han characters alone cannot force a Chinese label onto Japanese');
});
test('mixed CJK and Latin sentences preserve exact non-source spans, whitespace and punctuation', async () => {
  const text = `${zh} ${en}`;
  assert.equal(languageSegments(text).join(''), text);
  const prepared = await prepareTranslation(batch(specific, [text]), detect);
  const request = prepared.batch!.groups[0].blocks[0].text;
  assert.ok(request.includes('__MT_KEEP_1__'));
  const output = request.replace(en, '这里是译文。');
  assert.equal(prepared.finish({ translations: [{ id: 'b0', text: output }], usage: null }).translations[0].text, `${zh} 这里是译文。`);
  assert.throws(() => prepared.finish({ translations: [{ id: 'b0', text: output.replace('__MT_KEEP_1__', '') }], usage: null }), /不应翻译/);
});
test('English and French sentences in one block are filtered independently', async () => {
  const prepared = await prepareTranslation(batch(specific, [`${en} ${fr}`]), detect);
  const request = prepared.batch!.groups[0].blocks[0].text;
  assert.ok(request.endsWith('__MT_KEEP_1__'));
  const result = prepared.finish({ translations: [{ id: 'b0', text: request.replace(en, zh) }], usage: null });
  assert.equal(result.translations[0].text, `${zh} ${fr}`);
});
test('rich mixed content with uncertain boundaries stays unchanged', async () => {
  const input = batch(specific, ['这是 ⟦i1⟧an English link⟦/i1⟧。']);
  const prepared = await prepareTranslation(input, detect);
  assert.equal(prepared.batch, null);
  assert.equal(prepared.finish({ translations: [], usage: null }).translations[0].reason, 'uncertain');
});
test('Chinese target scripts are requested explicitly and CLD zh alone does not prove the target form', async () => {
  for (const target of ['zh-CN', 'zh-TW'] as const) {
    const input = batch({ scope: 'all', source: null, target }, [zh]);
    const prepared = await prepareTranslation(input, detect);
    assert.equal(prepared.batch?.groups[0].blocks[0].requireTranslation, false);
    assert.match(translationPrompt(input), target === 'zh-CN' ? /Simplified Chinese/ : /Traditional Chinese/);
  }
});
test('translation validation preserves protected spans and rejects fraudulent unchanged results', () => {
  const input = batch(specific, ['__MT_KEEP_1__ The library opens. __MT_KEEP_2__']);
  const reply = (text: string, status?: string) => JSON.stringify({ translations: [{ id: 'b0', text, ...(status ? { status } : {}) }] });
  assert.throws(() => validateTranslations(reply('__MT_KEEP_2__ 图书馆开放。 __MT_KEEP_1__'), input), /不应翻译/);
  assert.throws(() => validateTranslations(reply('原文', 'unchanged'), input), /错误地跳过/);
  input.groups[0].blocks[0].requireTranslation = true;
  assert.throws(() => validateTranslations(reply(input.groups[0].blocks[0].text, 'unchanged'), input), /错误地跳过/);
  assert.ok(validateTranslations(reply('__MT_KEEP_1__ 图书馆开放。 __MT_KEEP_2__'), input));
  const english = batch({ scope: 'all', source: null, target: 'en' }, [zh]);
  assert.equal(validateTranslations(reply(en), english)[0].text, en);
  const korean = batch({ scope: 'all', source: null, target: 'ko' }, [zh]);
  assert.throws(() => validateTranslations(reply('도서관은每天早上开放，最后一位读者离开后关闭。'), korean), /未完整译为韩语/);
});
test('a cancelled detection cannot create a new translation request', async () => {
  const controller = new AbortController();
  const detectAndCancel = async () => { controller.abort(); return observations.get(en)!; };
  await assert.rejects(prepareTranslation(batch(specific), detectAndCancel, controller.signal), /已取消/);
});
