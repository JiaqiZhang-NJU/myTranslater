import type { TranslationResult } from '../shared';
import { makeBatches, cacheKey } from './context';
import { extractPage, prioritize, visibleText, type PageGroup } from './extract';
import { createControls } from './floating-ball';
import { renderTranslation, clearTranslation, clearTranslations } from './render';

interface RuntimeResponse extends Partial<TranslationResult> {
  ok: boolean; error?: string; kind?: string; ready?: boolean; message?: string; identity?: string; settingsVersion?: number;
}

if (window.top === window && document.body) {
  let active = false;
  let starting = false;
  let paused = false;
  let processing = false;
  let blocked = false;
  let quotaBlocked = false;
  let sessionId = '';
  let providerIdentity = '';
  let settingsVersion = 0;
  let tokenTotal = 0;
  let observer: MutationObserver | null = null;
  let scanTimer: number | undefined;
  let mainRoot: Element | null = null;
  const dirtyScopes = new Set<Element>();
  const groups = new Map<string, PageGroup>();
  const pending = new Set<string>();
  const translated = new Set<string>();
  const cache = new Map<string, Map<string, string>>();
  let cacheChars = 0;
  const controls = createControls(toggle, retry, () => { void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); }, pauseOrResume);

  function status(message = ''): void {
    const total = [...groups.values()].reduce((sum, group) => sum + group.group.blocks.length, 0);
    const done = [...translated].reduce((sum, id) => sum + (groups.get(id)?.group.blocks.length ?? 0), 0);
    controls.setStatus(message || (paused ? `已暂停 · ${done}/${total} · ${tokenTotal} token` : active ? `已翻译 ${done}/${total} · ${tokenTotal} token` : '点击悬浮球翻译当前页'));
  }

  function same(a: PageGroup, b: PageGroup): boolean {
    return a.fingerprint === b.fingerprint && [...a.nodes].every(([id, node]) => b.nodes.get(id) === node && a.revisions.get(id) === b.revisions.get(id));
  }

  function valid(group: PageGroup): boolean {
    return [...group.nodes].every(([id, node]) => node.isConnected && visibleText(node) === group.sources.get(id));
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
    return element.closest('table,nav,[role="navigation"],ul,ol,section,article,main,footer') ?? element.parentElement ?? document.body;
  }

  function owned(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element?.closest('#mt-controls,.mt-translation'));
  }

  function changed(records: MutationRecord[]): void {
    if (!active) return;
    for (const record of records) {
      if (owned(record.target)) continue;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(owned)) continue;
      dirtyScopes.add(scopeFor(record.target));
    }
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
    if (cache.has(key)) return;
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

  function apply(group: PageGroup, texts: Map<string, string>): boolean {
    if (!valid(group) || group.group.blocks.some(block => !texts.get(block.id))) return false;
    for (const block of group.group.blocks) {
      if (!renderTranslation(group.nodes.get(block.id)!, group.sources.get(block.id)!, texts.get(block.id)!, block.role, group.inline.get(block.id) ?? new Map())) {
        removeTranslation(group);
        return false;
      }
    }
    translated.add(group.group.id);
    return true;
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
        const batch = makeBatches(document.title.slice(0, 180), remaining.map(item => item.group))[0];
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
          const texts = new Map(current.group.blocks.map(block => [block.id, translations.get(block.id) ?? '']));
          if (apply(current, texts)) remember(current, texts);
        }
        status();
      }
    } finally {
      processing = false;
      if (active && !paused && !blocked && pending.size) void process();
    }
  }

  async function start(): Promise<void> {
    if (starting || active) return;
    starting = true;
    try {
      const check = await chrome.runtime.sendMessage({ type: 'GET_PROVIDER_STATUS' }) as RuntimeResponse;
      if (!check?.ok || !check.ready || !check.identity || !Number.isSafeInteger(check.settingsVersion)) {
        status(check?.message || check?.error || '请先配置翻译方式');
        void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        return;
      }
      providerIdentity = check.identity;
      settingsVersion = check.settingsVersion!;
    } catch {
      status('扩展后台暂时不可用');
      return;
    } finally { starting = false; }
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
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    dirtyScopes.clear();
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

  function toggle(): void { if (active) stop(); else void start(); }
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

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'TOGGLE_TRANSLATION') return;
    toggle();
    sendResponse({ ok: true });
  });

  let currentDocumentUrl = location.origin + location.pathname + location.search;
  setInterval(() => {
    const next = location.origin + location.pathname + location.search;
    if (next !== currentDocumentUrl || (mainRoot && !mainRoot.isConnected)) {
      currentDocumentUrl = next;
      if (active) { stop(); cache.clear(); cacheChars = 0; status('页面已切换；点击悬浮球翻译新页面'); }
    }
  }, 1000);
}
