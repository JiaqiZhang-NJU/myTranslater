import { createLanguageFields } from '../language-form';
import type { LanguageSettings } from '../languages';

export function createLanguagePanel(load: () => Promise<{ language: LanguageSettings; version: number }>, apply: (language: LanguageSettings, version: number) => Promise<void>) {
  const root = document.createElement('section'); root.id = 'mt-language'; root.hidden = true; root.setAttribute('data-mt-owned', '');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '翻译语言');
  const title = document.createElement('strong'); title.textContent = '翻译语言';
  const form = document.createElement('form');
  const fields = createLanguageFields(form, 'mt-language');
  const hint = document.createElement('p'); hint.textContent = '应用后保存为默认设置。其他页面会停止旧翻译，等待手动继续。';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'mt-language-actions';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '应用';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  actions.append(submit, cancel); form.append(hint, message, actions); root.append(title, form);
  document.getElementById('mt-controls')!.append(root);
  let token = 0; let version = 0; let busy = false; let lastFocus: HTMLElement | null = null;
  function close(): void {
    if (busy) return; token++; root.hidden = true;
    if (lastFocus?.isConnected && lastFocus.getClientRects().length) lastFocus.focus();
    else document.querySelector<HTMLButtonElement>('.mt-ball')?.focus();
  }
  function place(): void { root.style.top = `${Math.max(8, (innerHeight - root.offsetHeight) / 2)}px`; }
  cancel.addEventListener('click', close);
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  window.addEventListener('resize', place);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || submit.disabled) return;
    let language: LanguageSettings;
    try { language = fields.read(); } catch (error) { message.textContent = (error as Error).message; return; }
    busy = true; submit.disabled = true; cancel.disabled = true; message.textContent = '正在应用…';
    void apply(language, version).then(() => { busy = false; close(); }).catch(error => { busy = false; message.textContent = error instanceof Error ? error.message : '应用失败，请重试'; })
      .finally(() => { submit.disabled = false; cancel.disabled = false; });
  });
  return {
    async open() {
      const mine = ++token; lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false; submit.disabled = true; message.textContent = '正在读取设置…'; place();
      try { const current = await load(); if (mine !== token) return; version = current.version; fields.write(current.language); message.textContent = ''; submit.disabled = false; place(); root.querySelector('select')?.focus(); }
      catch (error) { if (mine === token) message.textContent = error instanceof Error ? error.message : '无法读取设置'; }
    },
    close
  };
}
