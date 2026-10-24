import { batchLanguage, normalizeSource, SOURCE_LANGUAGES, type LanguageSettings } from './languages';
import type { SkipReason, TextBlock, TranslationBatch, TranslationItem, TranslationResult } from './shared';
import { PageCache } from './content/cache';
import { TranslationError } from './translation';

export interface Detection { isReliable: boolean; languages: { language: string; percentage: number }[] }
export type DetectLanguage = (text: string) => Promise<Detection>;
const detectionCache = new PageCache<Detection>(1500, 1_000_000);
const uncertain: Detection = { isReliable: false, languages: [] };
export const detectLanguage: DetectLanguage = async text => {
  const cached = detectionCache.get(text); if (cached) return cached;
  const result = await new Promise<Detection>(resolve => {
    const timer = setTimeout(() => resolve(uncertain), 2500);
    try {
      chrome.i18n.detectLanguage(text, value => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        resolve(error ? uncertain : value);
      });
    } catch { clearTimeout(timer); resolve(uncertain); }
  });
  // API failures do not poison the cache for the lifetime of the worker.
  if (result.languages.length) detectionCache.set(text, result);
  return result;
};
function clean(text: string): string { return text.replace(/⟦\/?i\d+⟧|__MT_(?:CODE|KEEP)_\d+__/g, '').trim(); }
function reliable(result: Detection): string | null {
  const first = result.languages[0];
  return result.isReliable && first && first.percentage >= 85 ? normalizeSource(first.language) : null;
}
function supported(language: string): boolean { return SOURCE_LANGUAGES.some(([code]) => code === language); }
function technical(text: string): boolean {
  return !/\p{L}/u.test(text) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(text)
    || /^[A-Z][A-Z\d_.-]{1,}$/.test(text);
}
function script(char: string): string | null {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) return 'east';
  if (/\p{Script=Hangul}/u.test(char)) return 'ko';
  if (/\p{Script=Latin}/u.test(char)) return 'latin';
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrillic';
  return /\p{L}/u.test(char) ? 'other' : null;
}
/** Keep exact offsets, whitespace and punctuation. Never cut an inline marker. */
export function languageSegments(text: string): string[] {
  if (text.includes('⟦') || text.includes('__MT_')) return [text];
  const parts: string[] = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)) {
    let start = 0; let previous: string | null = null;
    for (let offset = 0; offset < segment.length;) {
      const char = String.fromCodePoint(segment.codePointAt(offset)!);
      const current = script(char);
      if (current && previous && current !== previous) { parts.push(segment.slice(start, offset)); start = offset; }
      if (current) previous = current;
      offset += char.length;
    }
    parts.push(segment.slice(start));
  }
  return parts.filter(Boolean);
}
interface Decision { translate: boolean; reason?: SkipReason; certain?: boolean }
function decide(language: string | null, rule: LanguageSettings): Decision {
  if (language && !supported(language)) return { translate: false, reason: 'unsupported' };
  if (!language) return rule.scope === 'all' ? { translate: true } : { translate: false, reason: 'uncertain' };
  if (rule.scope === 'specific' && language !== rule.source) return { translate: false, reason: 'other' };
  if (language === rule.target) return { translate: false, reason: 'target' };
  // CLD reports zh for both scripts. Let the translator decide the requested form.
  return { translate: true, certain: !(language === 'zh' && rule.target.startsWith('zh')) };
}

export interface PreparedTranslation {
  batch: TranslationBatch | null;
  finish(result: TranslationResult): TranslationResult;
}
export async function prepareTranslation(batch: TranslationBatch, detect: DetectLanguage = detectLanguage, signal?: AbortSignal): Promise<PreparedTranslation> {
  const rule = batchLanguage(batch);
  const skipped = new Map<string, TranslationItem>();
  const protections = new Map<string, Map<string, string>>();
  const original = new Map(batch.groups.flatMap(group => group.blocks.map(block => [block.id, block] as const)));
  const groups: TranslationBatch['groups'] = [];
  function check(): void { if (signal?.aborted) throw new TranslationError('已取消', 'cancelled'); }
  for (const group of batch.groups) {
    check();
    const combined = group.blocks.map(block => clean(block.text)).join('\n');
    const groupLanguage = combined.length >= 40 ? reliable(await detect(combined)) : null;
    const blocks: TextBlock[] = [];
    for (const block of group.blocks) {
      check();
      const plain = clean(block.text);
      if (technical(plain)) { skipped.set(block.id, { id: block.id, text: block.text, status: 'unchanged', reason: 'nonlinguistic' }); continue; }
      const pieces = languageSegments(block.text);
      const keep = new Map<string, string>();
      let changes = 0; let certain = false; let reason: SkipReason = 'uncertain'; let prepared = '';
      if (pieces.length > 32) { skipped.set(block.id, { id: block.id, text: block.text, status: 'unchanged', reason }); continue; }
      for (const piece of pieces) {
        check();
        const text = clean(piece);
        let decision: Decision;
        if (technical(text)) decision = { translate: false, reason: 'nonlinguistic' };
        else {
          const detected = await detect(text); check();
          let language = reliable(detected);
          // Native scripts are useful for very short labels. Latin/Cyrillic scripts alone are not language IDs.
          if (!language && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) && !/\p{Script=Latin}/u.test(text)) language = 'ja';
          if (!language && /\p{Script=Hangul}/u.test(text) && !/\p{Script=Latin}/u.test(text)) language = 'ko';
          const short = text.replace(/[^\p{L}]/gu, '').length <= 30;
          if (!language && short && pieces.length === 1) {
            const hint = block.lang ? normalizeSource(block.lang) : groupLanguage;
            // A local hint cannot turn native CJK text into a Latin language.
            if (hint && (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) || ['zh', 'ja', 'ko'].includes(hint))) language = hint;
            // Page-wide metadata is weak: it must agree with the detector's candidate.
            if (!language && batch.pageLang && detected.languages.some(item => normalizeSource(item.language) === normalizeSource(batch.pageLang!) && item.percentage >= 85)) language = normalizeSource(batch.pageLang);
          }
          // Rich mixed blocks cannot safely be split without changing inline topology.
          const mixed = block.text.includes('⟦') && (detected.languages.filter(item => item.percentage >= 15).length > 1
            || /\p{Script=Latin}/u.test(text) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(text));
          decision = mixed && rule.scope === 'specific' ? { translate: false, reason: 'uncertain' } : decide(language, rule);
        }
        if (decision.translate) { prepared += piece; changes++; certain ||= decision.certain === true; }
        else {
          reason = decision.reason ?? reason;
          let token = `__MT_KEEP_${keep.size + 1}__`;
          while (block.text.includes(token) || keep.has(token)) token = `__MT_KEEP_${Number(token.match(/\d+/)![0]) + 1}__`;
          keep.set(token, piece); prepared += token;
        }
      }
      if (!changes) { skipped.set(block.id, { id: block.id, text: block.text, status: 'unchanged', reason }); continue; }
      protections.set(block.id, keep);
      blocks.push({ ...block, text: prepared, requireTranslation: certain });
    }
    if (blocks.length) groups.push({ ...group, blocks,
      ...(blocks.length < group.blocks.length ? { reference: group.blocks.filter(block => !blocks.some(item => item.id === block.id)).map(block => clean(block.text)).join('\n').slice(0, 400) } : {}) });
  }
  check();
  return {
    batch: groups.length ? { ...batch, groups } : null,
    finish(result) {
      const translated = new Map(result.translations.map(item => [item.id, item]));
      const translations = [...original].map(([id, source]): TranslationItem => {
        const skip = skipped.get(id); if (skip) return skip;
        const item = translated.get(id); if (!item) throw new TranslationError('译文缺少请求的文本块', 'response');
        let text = item.text;
        for (const [token, literal] of protections.get(id) ?? []) {
          if (text.split(token).length !== 2) throw new TranslationError('模型改写了不应翻译的语言片段', 'response');
          text = text.replace(token, () => literal);
        }
        if (text === source.text) return { id, text, status: 'unchanged', reason: 'target' };
        return { id, text };
      });
      return { ...result, translations };
    }
  };
}
