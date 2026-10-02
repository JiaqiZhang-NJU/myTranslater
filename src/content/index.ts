import type { TextBlock, TextGroup, TranslationBatch, TranslationResult } from '../shared';
import { makeBatches, cacheKey } from './context';
import { extractPage, navigationFor, ownedTextOf, prioritize, type PageGroup } from './extract';
import { createControls } from './floating-ball';
import { renderTranslation, clearTranslation, clearTranslations } from './render';
import { createSelectionPanel, type SelectionOutcome, type SelectionRequest } from './selection';

interface RuntimeResponse extends Partial<TranslationResult> {
  ok: boolean; error?: string; kind?: string; ready?: boolean; message?: string; identity?: string; settingsVersion?: number;
  provider?: 'deepseek' | 'ollama';
}

if (window.top === window && document.body) {
  let active = false;
  let hiddenForPage = false;
  let pageRevision = 0;
  let startingForPage: number | null = null;
  let paused = false;
  let processing = false;
  let blocked = false;
  let quotaBlocked = false;
  let sessionId = '';
  let providerIdentity = '';
  let providerName = 'DeepSeek';
  let settingsVersion = 0;
  let tokenTotal = 0;
  let observer: MutationObserver | null = null;
  let scanTimer: number | undefined;
  let mainRoot: Element | null = null;
  let idleWaiters: (() => void)[] = [];
  const dirtyScopes = new Set<Element>();
  const groups = new Map<string, PageGroup>();
  const pending = new Set<string>();
  const translated = new Set<string>();
  const cache = new Map<string, Map<string, string>>();
  let cacheChars = 0;
  const blockCache = new Map<string, string>();
  let blockChars = 0;
  /** Bounded cache for repeated identical selections on this document. */
  const selectionCache = new Map<string, string>();
  const controls = createControls(toggle, retry, () => { void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); }, pauseOrResume, hideForPage);

  function label(provider?: 'deepseek' | 'ollama'): string {
    if (provider) providerName = provider === 'ollama' ? 'Ollama 本机模型' : 'DeepSeek API';
    return providerName;
  }

  function status(message = ''): void {
    const total = [...groups.values()].reduce((sum, group) => sum + group.group.blocks.length, 0);
    const done = [...translated].reduce((sum, id) => sum + (groups.get(id)?.group.blocks.length ?? 0), 0);
    controls.setStatus(message || (paused ? `已暂停 · ${done}/${total} · ${tokenTotal} token` : active ? `已翻译 ${done}/${total} · ${tokenTotal} token` : '点击悬浮球翻译当前页'));
  }

  function same(a: PageGroup, b: PageGroup): boolean {
    return a.fingerprint === b.fingerprint && [...a.nodes].every(([id, node]) => b.nodes.get(id) === node && a.revisions.get(id) === b.revisions.get(id));
  }

  function valid(group: PageGroup): boolean {
    return [...group.nodes].every(([id, node]) =>
      node.isConnected && ownedTextOf(group.textNodes.get(id) ?? []) === group.sources.get(id));
  }

  function removeTranslation(group: PageGroup): void {
    for (const node of group.nodes.values()) clearTranslation(node);
    translated.delete(group.group.id);
  }

  function scan(root: Element): void {
    if (!active) return;
    const previousCount = groups.size;
    let changedCount = 0;
    const fresh = extractPage(root);
    const replacements = new Map(fresh.map(group => [group.group.id, group]));
    for (const [id, old] of groups) {
      if (![...old.nodes.values()].some(node => !node.isConnected || root.contains(node))) continue;
      const next = replacements.get(id);
      if (!next || !same(old, next)) {
        removeTranslation(old);
        pending.delete(id);
        groups.delete(id);
      }
    }
    for (const group of fresh) {
      const old = groups.get(group.group.id);
      if (!old || !same(old, group)) {
        if (old) removeTranslation(old);
        groups.set(group.group.id, group);
        pending.add(group.group.id);
        changedCount += group.group.blocks.length;
      } else groups.set(group.group.id, group);
    }
    status();
    if (previousCount && changedCount) controls.notify(`发现 ${changedCount} 项新内容，正在更新译文`);
    void process();
  }

  function scopeFor(node: Node): Element {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return document.body;
    return navigationFor(element) ?? element.closest('table,ul,ol,section,article,main,footer') ?? element.parentElement ?? document.body;
  }

  function owned(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element?.closest('#mt-controls,.mt-translation,#mt-selection'));
  }

  function changed(records: MutationRecord[]): void {
    if (!active) return;
    const targets = new Set<Node>();
    for (const record of records) {
      if (owned(record.target)) continue;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(owned)) continue;
      targets.add(record.target);
    }
    for (const target of targets) dirtyScopes.add(scopeFor(target));
    if (!dirtyScopes.size) return;
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = window.setTimeout(flushDirty, 800);
  }

  function flushDirty(): void {
    scanTimer = undefined;
    const scopes = [...dirtyScopes].filter(scope => scope.isConnected);
    dirtyScopes.clear();
    const minimal = scopes.filter(scope => !scopes.some(other => other !== scope && other.contains(scope)));
    for (const scope of minimal) scan(scope);
    for (const [id, group] of groups) {
      if ([...group.nodes.values()].some(node => !node.isConnected)) {
        removeTranslation(group);
        groups.delete(id);
        pending.delete(id);
      }
    }
    status();
  }

  function saved(group: PageGroup): Map<string, string> | undefined {
    const key = cacheKey(document.title, group.group, providerIdentity);
    const value = cache.get(key);
    if (value) { cache.delete(key); cache.set(key, value); }
    return value;
  }

  function remember(group: PageGroup, texts: Map<string, string>): void {
    const key = cacheKey(document.title, group.group, providerIdentity);
    if (!cache.has(key)) {
      cache.set(key, texts);
      cacheChars += key.length + [...texts.values()].reduce((sum, value) => sum + value.length, 0);
      while (cache.size > 1000 || cacheChars > 2_500_000) {
        const first = cache.keys().next().value;
        if (!first) break;
        const value = cache.get(first)!;
        cacheChars -= first.length + [...value.values()].reduce((sum, text) => sum + text.length, 0);
        cache.delete(first);
      }
    }
    // Reusing single blocks keeps a changed group from resending the siblings
    // that were already translated (for example one new navigation item).
    for (const block of group.group.blocks) {
      const value = texts.get(block.id);
      if (!value) continue;
      const blockKey = blockCacheKey(block, group.group.section);
      if (blockCache.has(blockKey)) { blockCache.delete(blockKey); blockCache.set(blockKey, value); continue; }
      blockCache.set(blockKey, value);
      blockChars += blockKey.length + value.length;
      while (blockCache.size > 4000 || blockChars > 2_000_000) {
        const first = blockCache.keys().next().value;
        if (!first) break;
        blockChars -= first.length + (blockCache.get(first)?.length ?? 0);
        blockCache.delete(first);
      }
    }
  }

  function blockCacheKey(block: TextBlock, section?: string): string {
    return cacheKey(document.title, section ? { id: 'blk', section, blocks: [block] } : { id: 'blk', blocks: [block] }, providerIdentity);
  }

  function forgetAll(): void {
    cache.clear();
    cacheChars = 0;
    blockCache.clear();
    blockChars = 0;
  }

  function apply(group: PageGroup, texts: Map<string, string>): boolean {
    if (!valid(group) || group.group.blocks.some(block => !texts.get(block.id))) return false;
    for (const block of group.group.blocks) {
      const node = group.nodes.get(block.id)!;
      const carrier = group.carriers.get(block.id) ?? node;
      if (!renderTranslation(node, carrier, group.textNodes.get(block.id) ?? [], group.sources.get(block.id) ?? '', texts.get(block.id)!, block.role, group.inline.get(block.id) ?? new Map())) {
        removeTranslation(group);
        return false;
      }
    }
    translated.add(group.group.id);
    return true;
  }

  function notifyIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function whenIdle(): Promise<void> {
    if (!processing) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
  }

  async function process(): Promise<void> {
    if (!active || paused || blocked || processing) return;
    processing = true;
    try {
      while (active && !paused && !blocked && pending.size) {
        const queue = prioritize([...pending].map(id => groups.get(id)).filter((item): item is PageGroup => Boolean(item)));
        if (!queue.length) { pending.clear(); break; }
        for (const group of queue) {
          const cached = saved(group);
          if (!cached) continue;
          pending.delete(group.group.id);
          if (!apply(group, cached)) {
            cache.delete(cacheKey(document.title, group.group, providerIdentity));
            pending.add(group.group.id);
          }
        }
        const remaining = prioritize([...pending].map(id => groups.get(id)).filter((item): item is PageGroup => Boolean(item)));
        if (!remaining.length) break;
        const reuse = new Map<string, Map<string, string>>();
        const partial: TextGroup[] = [];
        for (const item of remaining) {
          const cached = new Map<string, string>();
          for (const block of item.group.blocks) {
            const value = blockCache.get(blockCacheKey(block, item.group.section));
            if (value) cached.set(block.id, value);
          }
          reuse.set(item.group.id, cached);
          const missing = item.group.blocks.filter(block => !cached.has(block.id));
          if (missing.length) { partial.push({ ...item.group, blocks: missing }); continue; }
          pending.delete(item.group.id);
          const texts = new Map(item.group.blocks.map(block => [block.id, cached.get(block.id)!]));
          if (apply(item, texts)) remember(item, texts);
          else {
            // Stale reused text must not be retried from the cache forever.
            for (const block of item.group.blocks) blockCache.delete(blockCacheKey(block, item.group.section));
            pending.add(item.group.id);
          }
        }
        if (!partial.length) continue;
        const batch = makeBatches(document.title.slice(0, 180), partial)[0];
        if (!batch) break;
        const sent = new Map(batch.groups.map(item => [item.id, groups.get(item.id)!]));
        batch.groups.forEach(item => pending.delete(item.id));
        const thisSession = sessionId;
        let result: RuntimeResponse;
        try {
          result = await chrome.runtime.sendMessage({ type: 'TRANSLATE', sessionId: thisSession, settingsVersion, batch }) as RuntimeResponse;
        } catch {
          if (active && sessionId === thisSession) {
            blocked = true;
            status('连接中断，结果可能已计费；请检查后手动重试');
          }
          return;
        }
        if (!active || sessionId !== thisSession) return;
        const unseen = observer?.takeRecords() ?? [];
        if (unseen.length) changed(unseen);
        if (dirtyScopes.size) {
          if (scanTimer !== undefined) clearTimeout(scanTimer);
          flushDirty();
        }
        if (!result?.ok || !result.translations) {
          if (result?.kind !== 'cancelled') for (const id of sent.keys()) if (groups.has(id)) pending.add(id);
          blocked = true;
          quotaBlocked = result?.kind === 'quota';
          controls.setRetry(true);
          controls.setRetryLabel(quotaBlocked ? '增加预算并继续' : '重试');
          status(result?.error || '翻译失败，请手动重试');
          controls.notify(result?.error || '翻译失败，请手动重试', 5000);
          return;
        }
        tokenTotal += result.usage?.totalTokens ?? 0;
        const translations = new Map(result.translations.map(item => [item.id, item.text]));
        for (const [id, original] of sent) {
          const current = groups.get(id);
          if (!current || !same(current, original)) continue;
          const texts = new Map(current.group.blocks.map(block => [block.id, translations.get(block.id) ?? reuse.get(id)?.get(block.id) ?? '']));
          if (apply(current, texts)) remember(current, texts);
        }
        status();
      }
    } finally {
      processing = false;
      notifyIdle();
      if (active && !paused && !blocked && pending.size) void process();
    }
  }

  async function providerStatus(): Promise<RuntimeResponse | null> {
    try {
      const check = await chrome.runtime.sendMessage({ type: 'GET_PROVIDER_STATUS' }) as RuntimeResponse;
      if (check?.provider) label(check.provider);
      return check;
    } catch {
      return null;
    }
  }

  async function translateSelection(request: SelectionRequest): Promise<SelectionOutcome> {
    const check = await providerStatus();
    if (!check) return { ok: false, error: '扩展后台暂时不可用，请稍后重试', kind: 'unknown' };
    if (!check.ok || !check.ready || !check.identity || !Number.isSafeInteger(check.settingsVersion)) {
      return { ok: false, error: check.message || check.error || '请先配置翻译方式', kind: check.kind ?? 'config' };
    }
    const block: TextBlock = { id: 'sel', role: 'paragraph', text: request.text, ...(request.context ? { context: request.context } : {}) };
    // The key contains the source text, the context actually used, the target
    // language, the provider identity and its settings version, so a repeated
    // word alone never hits a stale entry.
    const selectionKey = cacheKey(request.pageTitle, { id: 'gsel', blocks: [block] }, check.identity);
    const cached = selectionCache.get(selectionKey);
    if (cached) {
      selectionCache.delete(selectionKey);
      selectionCache.set(selectionKey, cached);
      return { ok: true, translations: [{ id: 'sel', text: cached }], usage: null };
    }
    const batch: TranslationBatch = {
      pageTitle: request.pageTitle,
      targetLang: 'zh-CN',
      mode: 'selection',
      groups: [{ id: 'gsel', blocks: [block] }]
    };
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TRANSLATE', sessionId: request.sessionId, settingsVersion: check.settingsVersion, batch
      }) as RuntimeResponse;
      if (result?.ok && result.translations) {
        const text = result.translations[0]?.text;
        if (text) {
          selectionCache.set(selectionKey, text);
          while (selectionCache.size > 50) {
            const first = selectionCache.keys().next().value;
            if (!first) break;
            selectionCache.delete(first);
          }
        }
        return { ok: true, translations: result.translations, usage: result.usage ?? null };
      }
      return { ok: false, error: result?.error || '翻译失败，请稍后重试', kind: result?.kind ?? 'unknown' };
    } catch {
      return { ok: false, error: '连接中断；该请求可能已计费，请谨慎重试', kind: 'unknown' };
    }
  }

  const selection = createSelectionPanel({
    translate: translateSelection,
    cancel: session => { void chrome.runtime.sendMessage({ type: 'CANCEL', sessionId: session }).catch(() => {}); },
    extendBudget: async () => {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'EXTEND_BUDGET' }) as RuntimeResponse;
        return result?.ok ? { ok: true } : { ok: false, error: result?.error || '无法增加预算' };
      } catch {
        return { ok: false, error: '扩展后台暂时不可用' };
      }
    },
    openOptions: () => { void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); },
    notify: (message, duration) => controls.notify(message, duration),
    waitForIdle: whenIdle,
    providerLabel: () => label()
  });

  async function start(): Promise<void> {
    if (startingForPage === pageRevision || active) return;
    const requestedPage = pageRevision;
    startingForPage = requestedPage;
    try {
      const check = await providerStatus();
      if (hiddenForPage || requestedPage !== pageRevision) return;
      if (!check) { status('扩展后台暂时不可用'); return; }
      if (!check?.ok || !check.ready || !check.identity || !Number.isSafeInteger(check.settingsVersion)) {
        status(check?.message || check?.error || '请先配置翻译方式');
        void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        return;
      }
      providerIdentity = check.identity;
      settingsVersion = check.settingsVersion!;
    } finally { if (startingForPage === requestedPage) startingForPage = null; }
    active = true;
    paused = false;
    blocked = false;
    quotaBlocked = false;
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tokenTotal = 0;
    mainRoot = document.querySelector('main');
    controls.setActive(true);
    controls.setPaused(false);
    controls.setRetry(false);
    observer = new MutationObserver(changed);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'class', 'style', 'aria-hidden', 'role', 'scope', 'headers'] });
    scan(document.body);
    if (!groups.size) status('当前页面没有可翻译内容；会继续等待新增内容');
  }

  function stop(): void {
    if (!active) return;
    const old = sessionId;
    active = false;
    sessionId = '';
    observer?.disconnect();
    observer = null;
    mainRoot = null;
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    dirtyScopes.clear();
    forgetAll();
    clearTranslations();
    groups.clear();
    pending.clear();
    translated.clear();
    blocked = false;
    quotaBlocked = false;
    paused = false;
    controls.setActive(false);
    controls.setPaused(false);
    controls.setRetry(false);
    status();
    void chrome.runtime.sendMessage({ type: 'CANCEL', sessionId: old }).catch(() => {});
  }

  function hideForPage(): void {
    hiddenForPage = true;
    pageRevision += 1;
    stop();
    controls.setHidden(true);
  }

  function toggle(): void {
    if (hiddenForPage) {
      hiddenForPage = false;
      controls.setHidden(false);
    }
    if (active) stop(); else void start();
  }
  function pauseOrResume(): void {
    if (!active) return;
    paused = !paused;
    controls.setPaused(paused);
    status();
    if (!paused) void process();
  }
  async function retry(): Promise<void> {
    if (!active || processing) return;
    if (quotaBlocked) {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'EXTEND_BUDGET' }) as RuntimeResponse;
        if (!result?.ok) { status(result?.error || '无法增加预算'); return; }
      } catch { status('扩展后台暂时不可用'); return; }
    }
    blocked = false;
    quotaBlocked = false;
    controls.setRetry(false);
    void process();
  }

  // Menus that only become visible through CSS or interaction do not always
  // produce a DOM record; a bounded local recheck covers the already supported
  // navigation regions without polling the whole page.
  function recheck(event: Event): void {
    if (!active) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || owned(element)) return;
    // Pointer movement is frequent, so the cheap landmark lookup runs first and
    // the structural search only for anchors that have no landmark above them.
    const container = element.closest('nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],footer,header,details')
      ?? (element.closest('a[href],[role="link"]') ? navigationFor(element) : null);
    if (!container) return;
    if (dirtyScopes.has(container)) return;
    dirtyScopes.add(container);
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = window.setTimeout(flushDirty, 300);
  }
  document.addEventListener('pointerover', recheck, true);
  document.addEventListener('focusin', recheck, true);
  document.addEventListener('click', recheck, true);

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    const data = message as { type?: unknown; text?: unknown; editable?: unknown; frameOk?: unknown };
    if (data.type === 'TOGGLE_TRANSLATION') {
      toggle();
      sendResponse({ ok: true });
      return;
    }
    if (data.type === 'MT_SELECTION') {
      const text = typeof data.text === 'string' ? data.text : '';
      if (data.frameOk === false) selection.open(text, '划词翻译只支持顶层网页；子框架中的选区不会发送。');
      else if (data.editable === true) selection.open(text, '输入框、密码框和可编辑区域的内容不会被发送翻译。');
      else selection.open(text);
      sendResponse({ ok: true });
    }
  });

  let currentDocumentUrl = location.origin + location.pathname + location.search;
  setInterval(() => {
    const next = location.origin + location.pathname + location.search;
    if (next !== currentDocumentUrl || (mainRoot && !mainRoot.isConnected)) {
      currentDocumentUrl = next;
      pageRevision += 1;
      selectionCache.clear();
      if (active) { stop(); status('页面已切换；点击悬浮球翻译新页面'); }
      if (hiddenForPage) { hiddenForPage = false; controls.setHidden(false); }
    }
  }, 1000);
}
