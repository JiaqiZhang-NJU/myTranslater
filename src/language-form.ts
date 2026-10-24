import { DEFAULT_LANGUAGE, SOURCE_LANGUAGES, TARGET_LANGUAGES, languageSummary, validLanguageSettings, type LanguageSettings } from './languages';
import { TranslationError } from './translation';

/** Shared fields for the trusted options page and the small in-page language panel. */
export function createLanguageFields(container: HTMLElement, prefix: string) {
  function select(name: string, title: string, items: readonly (readonly [string, string, ...string[]])[]) {
    const label = document.createElement('label'); label.htmlFor = `${prefix}-${name}`; label.textContent = title;
    const input = document.createElement('select'); input.id = label.htmlFor;
    for (const [value, text] of items) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    const row = document.createElement('div'); row.append(label, input); container.append(row);
    return { input, row };
  }
  const scope = select('scope', '翻译范围', [['all', '全部翻译'], ['specific', '只翻译指定语言']]);
  const source = select('source', '源语言', SOURCE_LANGUAGES);
  const target = select('target', '目标语言', TARGET_LANGUAGES);
  const summary = document.createElement('p'); summary.className = 'mt-language-summary'; summary.setAttribute('aria-live', 'polite'); container.append(summary);
  const read = (): LanguageSettings => {
    const value = { scope: scope.input.value, source: scope.input.value === 'all' ? null : source.input.value, target: target.input.value };
    if (!validLanguageSettings(value)) throw new TranslationError('源语言与目标语言不能相同，请重新选择', 'config');
    return value;
  };
  function update(): void {
    source.row.hidden = scope.input.value !== 'specific';
    try { summary.textContent = languageSummary(read()); } catch (error) { summary.textContent = (error as Error).message; }
  }
  for (const field of [scope, source, target]) field.input.addEventListener('change', update);
  function write(value: LanguageSettings): void {
    scope.input.value = value.scope; source.input.value = value.source ?? (value.target === 'en' ? 'zh' : 'en'); target.input.value = value.target; update();
  }
  write(DEFAULT_LANGUAGE);
  return { read, write };
}
