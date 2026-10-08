import { SELECTION_MAX_CHARS, SELECTION_MIN_CHARS } from '../shared';
import { closestComposed, editableComposed, hiddenComposed, parentElement, OWNED_SELECTOR } from '../dom';
import { visibleText } from './extract';

export interface SelectionOutcome {
  ok: boolean;
  translations?: { id: string; text: string }[];
  usage?: { totalTokens: number } | null;
  error?: string;
  kind?: string;
}

export interface SelectionRequest {
  text: string;
  sessionId: string;
  context: string;
  pageTitle: string;
}

export interface SelectionPanelOptions {
  /** Sends the selection batch and resolves with the background reply. */
  translate(request: SelectionRequest): Promise<SelectionOutcome>;
  cancel(sessionId: string): void;
  extendBudget(): Promise<{ ok: boolean; error?: string }>;
  openOptions(): void;
  notify(message: string, durationMs?: number): void;
  /** Resolves once no page-translation batch is being dispatched. */
  waitForIdle(): Promise<void>;
  providerLabel(): string;
}

export interface SelectionPanel {
  /** Starts a new selection translation; replaces any panel already open. */
  open(rawText: string, blockedReason?: string): void;
  close(): void;
  isOpen(): boolean;
}

/** Loose text nodes keep the selection readable without touching the page markup. */
function normalizeSelection(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function onlySymbols(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

function selectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.startContainer.isConnected) return null;
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height || rect.top || rect.left ? rect : null;
}

export function createSelectionPanel(options: SelectionPanelOptions): SelectionPanel {
  const root = document.createElement('section');
  root.id = 'mt-selection';
  root.className = 'mt-sel mt-sel-closed';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '划词翻译');

  const head = document.createElement('header');
  head.className = 'mt-sel-head';
  const title = document.createElement('strong');
  title.textContent = '划词翻译';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mt-sel-close';
  close.textContent = '关闭';
  close.addEventListener('click', () => dismiss());
  head.append(title, close);

  const meta = document.createElement('p');
  meta.className = 'mt-sel-meta';

  const source = document.createElement('details');
  source.className = 'mt-sel-source';
  const sourceSummary = document.createElement('summary');
  sourceSummary.textContent = '查看所选原文';
  const sourceText = document.createElement('p');
  source.append(sourceSummary, sourceText);

  const result = document.createElement('p');
  result.className = 'mt-sel-result';

  const usage = document.createElement('p');
  usage.className = 'mt-sel-usage';

  const actions = document.createElement('div');
  actions.className = 'mt-sel-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制译文';
  copy.addEventListener('click', () => void copyTranslation());
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试';
  retry.addEventListener('click', () => { if (current) void run(current, current.text); });
  const extend = document.createElement('button');
  extend.type = 'button';
  extend.textContent = '增加预算并翻译';
  extend.addEventListener('click', () => void extendAndRetry());
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.textContent = '打开设置';
  settings.addEventListener('click', options.openOptions);
  actions.append(copy, retry, extend, settings);

  root.append(head, meta, source, result, usage, actions);
  document.documentElement.append(root);

  let current: { text: string; sessionId: string; context: string; pageTitle: string; token: number } | null = null;
  let token = 0;
  let busy = false;
  let resolved = '';

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    event.stopPropagation();
    dismiss();
  }, true);

  function state(name: 'waiting' | 'working' | 'success' | 'failure' | 'notice' | 'blocked'): void {
    root.dataset.state = name;
    const show = (element: HTMLElement, visible: boolean): void => { element.hidden = !visible; };
    show(source, name === 'success' || name === 'working' || name === 'waiting');
    show(result, name === 'success' || name === 'failure' || name === 'notice' || name === 'blocked');
    show(usage, name === 'success' && Boolean(usage.textContent));
    show(copy, name === 'success');
    show(retry, name === 'failure' || name === 'notice');
    show(extend, name === 'notice');
    show(settings, name === 'failure');
  }

  function place(): void {
    const rect = selectionRect();
    const width = Math.min(360, window.innerWidth - 24);
    root.style.setProperty('width', `${width}px`, 'important');
    if (!rect) {
      root.style.setProperty('left', 'auto', 'important');
      root.style.setProperty('top', 'auto', 'important');
      root.style.setProperty('right', '12px', 'important');
      root.style.setProperty('bottom', '12px', 'important');
      return;
    }
    const height = root.offsetHeight || 160;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 8 + height > window.innerHeight && rect.top - height - 8 >= 8;
    const top = below ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 12);
    root.style.setProperty('left', `${left}px`, 'important');
    root.style.setProperty('top', `${Math.max(8, top)}px`, 'important');
    root.style.setProperty('right', 'auto', 'important');
    root.style.setProperty('bottom', 'auto', 'important');
  }

  function isOpen(): boolean { return !root.classList.contains('mt-sel-closed'); }

  function showPanel(): void {
    root.classList.remove('mt-sel-closed');
    root.removeAttribute('hidden');
    place();
  }

  function dismiss(): void {
    if (busy && current) options.cancel(current.sessionId);
    busy = false;
    current = null;
    token++;
    root.classList.add('mt-sel-closed');
    root.setAttribute('hidden', '');
  }

  function describe(text: string, limit = 70): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
  }

  async function copyTranslation(): Promise<void> {
    if (!resolved) return;
    try {
      await navigator.clipboard.writeText(resolved);
      copy.textContent = '已复制';
      window.setTimeout(() => { copy.textContent = '复制译文'; }, 1600);
    } catch {
      copy.textContent = '复制失败，可手动选择';
      const range = document.createRange();
      range.selectNodeContents(result);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  async function extendAndRetry(): Promise<void> {
    if (!current) return;
    const reply = await options.extendBudget();
    if (!reply.ok) { meta.textContent = reply.error || '无法增加预算'; return; }
    await run(current, current.text);
  }

  async function run(request: { text: string; sessionId: string; context: string; pageTitle: string }, text: string): Promise<void> {
    const mine = ++token;
    busy = true;
    resolved = '';
    current = { ...request, text, token: mine };
    source.open = text.length <= 60;
    sourceText.textContent = text;
    result.textContent = '';
    usage.textContent = '';
    meta.textContent = `${options.providerLabel()} · ${text.length} 字 · ${describe(text)}`;
    state('waiting');
    showPanel();
    await options.waitForIdle();
    if (token !== mine || !isOpen()) return;
    state('working');
    meta.textContent = `${options.providerLabel()} · 正在翻译…`;
    let outcome: SelectionOutcome;
    try {
      outcome = await options.translate({ ...request, text });
    } catch {
      outcome = { ok: false, error: '扩展后台暂时不可用，请稍后重试', kind: 'unknown' };
    }
    if (token !== mine || !isOpen()) return;
    busy = false;
    if (outcome.ok && outcome.translations?.[0]?.text) {
      resolved = outcome.translations[0].text;
      result.textContent = resolved;
      usage.textContent = outcome.usage ? `本次用量约 ${outcome.usage.totalTokens} token` : '';
      meta.textContent = `${options.providerLabel()} · ${text.length} 字`;
      state('success');
      return;
    }
    result.textContent = outcome.error || '翻译失败，请稍后重试';
    if (outcome.kind === 'budget') {
      meta.textContent = '本页翻译预算已用完';
      state('notice');
      return;
    }
    if (outcome.kind === 'cancelled') {
      meta.textContent = '已取消';
      state('failure');
      return;
    }
    meta.textContent = `${options.providerLabel()} · 失败`;
    state('failure');
  }

  function open(rawText: string, blockedReason?: string): void {
    if (busy && current) options.cancel(current.sessionId);
    token++;
    busy = false;
    const text = normalizeSelection(rawText);
    const sessionId = `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pageTitle = document.title.slice(0, 180);
    sourceText.textContent = text;
    result.textContent = '';
    usage.textContent = '';
    meta.textContent = '';
    if (blockedReason) {
      meta.textContent = `${options.providerLabel()} · 未发送`;
      result.textContent = blockedReason;
      current = null;
      state('blocked');
      source.hidden = !text;
      showPanel();
      return;
    }
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const anchorElement = anchor instanceof Element ? anchor : anchor ? parentElement(anchor) : null;
    if (anchorElement && (editableComposed(anchorElement) || hiddenComposed(anchorElement) || closestComposed(anchorElement, `${OWNED_SELECTOR},input,textarea,select,[translate="no"]`))) {
      current = null; result.textContent = '此选区位于编辑、隐藏或不翻译区域，不会发送。'; state('blocked'); showPanel(); return;
    }
    const block = anchorElement ? closestComposed(anchorElement, 'p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,figcaption,blockquote,div,span,label,summary,a,button') : null;
    const near = block ? visibleText(block) : '';
    const selected = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
    const context = selected && near.includes(selected) && near.length > text.length ? near.slice(0, 120) : '';
    if (text.length < SELECTION_MIN_CHARS) {
      meta.textContent = `${options.providerLabel()} · 未选中文字`;
      result.textContent = '请先选中要翻译的文字，再使用右键菜单。';
      current = null;
      state('blocked');
      showPanel();
      return;
    }
    if (text.length > SELECTION_MAX_CHARS) {
      meta.textContent = `${options.providerLabel()} · ${text.length} 字，超过上限`;
      result.textContent = `最多翻译 ${SELECTION_MAX_CHARS.toLocaleString('en-US')} 字，请缩小选区。`;
      current = null;
      state('blocked');
      source.hidden = false;
      showPanel();
      return;
    }
    if (onlySymbols(text)) {
      meta.textContent = `${options.providerLabel()} · 没有可翻译的文字`;
      result.textContent = '所选内容只有数字或符号，未发送翻译请求。';
      current = null;
      state('blocked');
      source.hidden = false;
      showPanel();
      return;
    }
    void run({ text, sessionId, context, pageTitle }, text);
  }

  return { open, close: dismiss, isOpen };
}
