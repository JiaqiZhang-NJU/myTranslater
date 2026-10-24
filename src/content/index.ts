import type { TextBlock, TextGroup, TranslationBatch, TranslationResult, TranslationItem } from '../shared';
import { pageUrlIdentity } from '../shared';
import { makeBatches, cacheKey } from './context';
import { extractPage, navigationFor, ownedTextOf, prioritize, type PageGroup } from './extract';
import { createControls } from './floating-ball';
import { renderTranslation, clearTranslation, clearTranslations, scheduleLayoutCheck, restrictedCount } from './render';
import { createSelectionPanel, type SelectionOutcome, type SelectionRequest } from './selection';
import type { BudgetSnapshot } from '../budget';
import { closestComposed, containsComposed, parentElement, OWNED_SELECTOR, type ScanRoot } from '../dom';
import { RootObserver } from './roots';
import { PageCache } from './cache';
import { LEGACY_LANGUAGE, languageFields, languageIdentity, languageSummary, parseLanguageSettings, type LanguageSettings } from '../languages';
import { createLanguagePanel } from './language-panel';
type CachedText = Omit<TranslationItem, 'id'>;

interface RuntimeResponse extends Partial<TranslationResult> {
  ok: boolean; error?: string; kind?: string; ready?: boolean; message?: string; identity?: string; settingsVersion?: number;
  provider?: 'deepseek' | 'ollama';
  budget?: BudgetSnapshot;
  language?: LanguageSettings;
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
  let language: LanguageSettings = { ...LEGACY_LANGUAGE };
  let applyingLanguage = false;
  let tokenTotal = 0;
  let observer: RootObserver | null = null;
  let scanTimer: number | undefined;
  let idleWaiters: (() => void)[] = [];
  const dirtyScopes = new Set<ScanRoot>();
  const groups = new Map<string, PageGroup>();
  const pending = new Set<string>();
  const completed = new Map<string, CachedText>();
  const cache = new PageCache<CachedText[]>(1000, 2_500_000);
  const blockCache = new PageCache<CachedText>(4000, 2_000_000);
  /** Bounded cache for repeated identical selections on this document. */
  const selectionCache = new PageCache<CachedText>(50, 200_000);
  let budgetInfo: BudgetSnapshot | undefined;
  const cancelledSelections = new Set<string>();
  const controls = createControls(toggle, retry, () => { void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }); }, pauseOrResume, hideForPage,
    () => { stop(); forgetAll(); selectionCache.clear(); selection.close(); void start(); }, () => { void languagePanel.open(); });

  function label(provider?: 'deepseek' | 'ollama'): string {
    if (provider) providerName = provider === 'ollama' ? 'Ollama 本机模型' : 'DeepSeek API';
    return providerName;
  }

  function status(message = ''): void {
    const total = [...groups.values()].reduce((sum, group) => sum + group.group.blocks.length, 0);
    const skipped = [...completed.values()].filter(item => item.status === 'unchanged');
    const done = completed.size - skipped.length;
    const uncertain = skipped.filter(item => item.reason === 'uncertain').length;
    const unsupported = skipped.filter(item => item.reason === 'unsupported').length;
    const skips = skipped.length ? ` · 跳过 ${skipped.length}${uncertain ? `（语言不确定 ${uncertain}）` : ''}${unsupported ? `（暂不支持 ${unsupported}）` : ''}` : '';
    const usage = budgetInfo ? `${budgetInfo.used}${budgetInfo.enabled ? `/${budgetInfo.limit} token` : ' token · 未限制'}${budgetInfo.inFlight ? ` · 预留 ${budgetInfo.inFlight}` : ''}` : `${tokenTotal} token`;
    const floating = restrictedCount();
    controls.setStatus(`${languageSummary(language)} · ` + (message ? `${message}${budgetInfo ? ` · ${usage}` : ''}` : (paused ? `已暂停 · ${done}/${total}${skips} · ${usage}` : active ? `已翻译 ${done}/${total}${skips} · ${usage}${floating ? ` · ${floating} 处浮层` : ''}` : '点击悬浮球翻译当前页')));
  }

  function same(a: PageGroup, b: PageGroup): boolean {
    return a.fingerprint === b.fingerprint && [...a.nodes].every(([id, node]) => b.nodes.get(id) === node && a.revisions.get(id) === b.revisions.get(id));
  }

  function valid(group: PageGroup): boolean {
    return [...group.nodes].every(([id, node]) =>
      node.isConnected && ownedTextOf(group.textNodes.get(id) ?? []) === group.sources.get(id));
  }

  function removeTranslation(group: PageGroup): void {
    for (const block of group.group.blocks) completed.delete(block.id);
    for (const node of group.nodes.values()) clearTranslation(node);
  }

  function scan(root: ScanRoot): void {
    if (!active) return;
    if (root instanceof ShadowRoot) root = root.host;
    // A component can move the same text into a new inner owner. Include all
    // owners of an affected group so an incremental scan cannot leave the old
    // host translation alongside the new paragraph or split a heading group.
    let expanded: boolean;
    do {
      expanded = false;
      for (const group of groups.values()) {
        const touches = [...group.nodes.values()].some(node => containsComposed(root, node)) ||
          [...group.textNodes.values()].some(nodes => nodes.some(node => containsComposed(root, node)));
        if (!touches) continue;
        for (const node of group.nodes.values()) {
          if (!node.isConnected) continue;
          while (!containsComposed(root, node) && root !== document.body) {
            const parent = parentElement(root);
            if (!parent) break;
            root = parent; expanded = true;
          }
        }
      }
    } while (expanded);
    const previousCount = groups.size;
    let changedCount = 0;
    const fresh = extractPage(root);
    const replacements = new Map(fresh.map(group => [group.group.id, group]));
    for (const [id, old] of groups) {
      if (![...old.nodes.values()].some(node => !node.isConnected || containsComposed(root, node))) continue;
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

  function scopeFor(node: Node): ScanRoot {
    if (node instanceof ShadowRoot) return node;
    const element = node instanceof Element ? node : parentElement(node);
    if (!element) return document.body;
    return navigationFor(element) ?? closestComposed(element, 'table,ul,ol,section,article,main,footer') ?? element.parentElement ?? element.getRootNode() as ScanRoot;
  }

  function owned(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element && closestComposed(element, OWNED_SELECTOR));
  }

  function changed(records: MutationRecord[]): void {
    if (!active) return;
    const targets = new Set<Node>();
    for (const record of records) {
      if (owned(record.target)) continue;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(owned)) continue;
      targets.add(record.target);
    }
    if (targets.size) scheduleLayoutCheck();
    for (const target of targets) dirtyScopes.add(scopeFor(target));
    if (dirtyScopes.size) scheduleScan();
  }
  function scheduleScan(): void {
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = window.setTimeout(flushDirty, 800);
  }

  function flushDirty(): void {
    scanTimer = undefined;
    const scopes = [...dirtyScopes].filter(scope => scope.isConnected);
    dirtyScopes.clear();
    const minimal = scopes.filter(scope => !scopes.some(other => other !== scope && containsComposed(other, scope)));
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

  function saved(group: PageGroup): Map<string, CachedText> | undefined {
    const key = groupCacheKey(group);
    const value = cache.get(key);
    return value ? new Map(group.group.blocks.map((block, i) => [block.id, value[i]])) : undefined;
  }

  function remember(group: PageGroup, texts: Map<string, CachedText>): void {
    cache.set(groupCacheKey(group), group.group.blocks.map(block => texts.get(block.id)!));
    // Single-block entries retain the complete context supplied for the group.
    for (const block of group.group.blocks) {
      const value = texts.get(block.id);
      if (!value) continue;
      blockCache.set(blockCacheKey(block, group), value);
    }
  }

  function groupCacheKey(group: PageGroup): string {
    const signatures = group.group.blocks.map(block => [...(group.inline.get(block.id) ?? [])].map(([key, element]) => [key, element.tagName, element.getAttribute('href') ?? '']));
    return JSON.stringify([cacheKey(document.title, group.group, providerIdentity, language, pageLanguage()), signatures]);
  }
  function pageLanguage(): string | undefined {
    const value = document.documentElement.lang;
    return /^[a-zA-Z-]{1,25}$/.test(value) ? value : undefined;
  }
  function blockCacheKey(block: TextBlock, group: PageGroup): string {
    return `${groupCacheKey(group)}:${group.group.blocks.indexOf(block)}`;
  }

  function forgetAll(): void {
    cache.clear();
    blockCache.clear();
  }

  function apply(group: PageGroup, texts: Map<string, CachedText>): boolean {
    if (!valid(group) || group.group.blocks.some(block => !texts.get(block.id)?.text)) return false;
    for (const block of group.group.blocks) {
      const value = texts.get(block.id)!;
      completed.set(block.id, value);
      if (value.status === 'unchanged' || value.text === block.text) continue;
      const node = group.nodes.get(block.id)!;
      const carrier = group.carriers.get(block.id) ?? node;
      if (renderTranslation(node, carrier, group.textNodes.get(block.id) ?? [], group.sources.get(block.id) ?? '', value.text, block.role, group.inline.get(block.id) ?? new Map(), language.target) === 'failed') {
        removeTranslation(group);
        return false;
      }
    }
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
            cache.delete(groupCacheKey(group));
            pending.add(group.group.id);
          }
        }
        const remaining = prioritize([...pending].map(id => groups.get(id)).filter((item): item is PageGroup => Boolean(item)));
        if (!remaining.length) { status(); break; }
        const reuse = new Map<string, Map<string, CachedText>>();
        const partial: TextGroup[] = [];
        for (const item of remaining) {
          const cached = new Map<string, CachedText>();
          for (const block of item.group.blocks) {
            const value = blockCache.get(blockCacheKey(block, item));
            if (value) cached.set(block.id, value);
          }
          reuse.set(item.group.id, cached);
          const missing = item.group.blocks.filter(block => !cached.has(block.id));
          if (missing.length) { partial.push({ ...item.group, blocks: missing,
            ...(missing.length < item.group.blocks.length ? { reference: item.group.blocks.filter(block => cached.has(block.id)).map(block => block.text).join('\n').slice(0, 400) } : {}) }); continue; }
          pending.delete(item.group.id);
          const texts = new Map(item.group.blocks.map(block => [block.id, cached.get(block.id)!]));
          if (apply(item, texts)) remember(item, texts);
          else {
            // Stale reused text must not be retried from the cache forever.
            for (const block of item.group.blocks) blockCache.delete(blockCacheKey(block, item));
            pending.add(item.group.id);
          }
        }
        if (!partial.length) { status(); continue; }
        const batch = makeBatches(document.title.slice(0, 180), partial, language, pageLanguage())[0];
        if (!batch) break;
        const sent = new Map(batch.groups.map(item => [item.id, groups.get(item.id)!]));
        batch.groups.forEach(item => pending.delete(item.id));
        const thisSession = sessionId;
        const requestUrl = pageUrlIdentity(location.href);
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
        if (requestUrl !== pageUrlIdentity(location.href)) { syncPage(); return; }
        if (batch.pageTitle !== document.title.slice(0, 180)) dirtyScopes.add(document.body);
        const unseen = observer?.takeRecords() ?? [];
        if (unseen.length) changed(unseen);
        if (dirtyScopes.size) {
          if (scanTimer !== undefined) clearTimeout(scanTimer);
          flushDirty();
        }
        if (!result?.ok || !result.translations) {
          if (result?.kind !== 'cancelled') for (const id of sent.keys()) if (groups.has(id)) pending.add(id);
          blocked = true;
          quotaBlocked = result?.kind === 'budget';
          if (result?.budget) budgetInfo = result.budget;
          controls.setRetry(true);
          controls.setRetryLabel(quotaBlocked ? '增加预算并继续' : '重试');
          status(result?.error || '翻译失败，请手动重试');
          controls.notify(result?.error || '翻译失败，请手动重试', 5000);
          return;
        }
        tokenTotal += result.usage?.totalTokens ?? 0;
        if (result.budget) budgetInfo = result.budget;
        const translations = new Map(result.translations.map(item => [item.id, item]));
        for (const [id, original] of sent) {
          const current = groups.get(id);
          if (!current || !same(current, original)) continue;
          const texts = new Map(current.group.blocks.map(block => [block.id, translations.get(block.id) ?? reuse.get(id)?.get(block.id) ?? { text: '' }]));
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
      if (check?.budget) { budgetInfo = check.budget; status(); }
      return check;
    } catch {
      return null;
    }
  }

  async function translateSelection(request: SelectionRequest): Promise<SelectionOutcome> {
    syncPage();
    const revision = pageRevision;
    const check = await providerStatus();
    if (!check) return { ok: false, error: '扩展后台暂时不可用，请稍后重试', kind: 'unknown' };
    if (!check.ok || !check.ready || !check.identity || !Number.isSafeInteger(check.settingsVersion)) {
      return { ok: false, error: check.message || check.error || '请先配置翻译方式', kind: check.kind ?? 'config' };
    }
    const rule = parseLanguageSettings(check.language);
    const version = check.settingsVersion;
    if (revision !== pageRevision || version! < settingsVersion) return { ok: false, kind: 'cancelled', error: '已取消' };
    language = rule; settingsVersion = version!;
    const block: TextBlock = { id: 'sel', role: 'paragraph', text: request.text, ...(request.context ? { context: request.context } : {}), ...(request.lang ? { lang: request.lang } : {}) };
    // The key contains the source text, the context actually used, the target
    // language and the provider identity, so a repeated
    // word alone never hits a stale entry.
    const selectionPageLang = pageLanguage();
    const selectionKey = cacheKey(request.pageTitle, { id: 'gsel', blocks: [block] }, check.identity, rule, selectionPageLang);
    const cached = selectionCache.get(selectionKey);
    if (revision !== pageRevision || request.pageTitle !== document.title.slice(0, 180) || cancelledSelections.delete(request.sessionId)) return { ok: false, kind: 'cancelled', error: '已取消' };
    if (cached) {
      return selectionOutcome({ id: 'sel', ...cached }, null);
    }
    const batch: TranslationBatch = {
      pageTitle: request.pageTitle,
      ...languageFields(rule),
      ...(selectionPageLang ? { pageLang: selectionPageLang } : {}),
      mode: 'selection',
      groups: [{ id: 'gsel', blocks: [block] }]
    };
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TRANSLATE', sessionId: request.sessionId, settingsVersion: check.settingsVersion, batch
      }) as RuntimeResponse;
      syncPage();
      if (cancelledSelections.delete(request.sessionId) || revision !== pageRevision || version !== settingsVersion || languageIdentity(language) !== languageIdentity(rule) || selectionPageLang !== pageLanguage() || request.pageTitle !== document.title.slice(0, 180)) return { ok: false, kind: 'cancelled', error: '已取消' };
      if (result?.budget) { budgetInfo = result.budget; status(); }
      if (result?.ok && result.translations) {
        const item = result.translations[0];
        if (item?.text) selectionCache.set(selectionKey, item);
        return item ? selectionOutcome(item, result.usage ?? null) : { ok: false, error: '未收到译文', kind: 'response' };
      }
      return { ok: false, error: result?.error || '翻译失败，请稍后重试', kind: result?.kind ?? 'unknown' };
    } catch {
      return { ok: false, error: '连接中断；该请求可能已计费，请谨慎重试', kind: 'unknown' };
    }
  }
  function selectionOutcome(item: TranslationItem, usage: TranslationResult['usage']): SelectionOutcome {
    if (item.status === 'unchanged') return { ok: false, kind: 'skipped', usage, error: item.reason === 'other' ? '所选文字不属于指定语言，已保留原文。' : item.reason === 'uncertain' ? '无法可靠判断所选文字的语言，已保留原文。' : item.reason === 'unsupported' ? '所选文字的语言暂不在首批支持范围内。' : '所选文字无需翻译，已保留原文。' };
    return { ok: true, translations: [item], usage };
  }

  const selection = createSelectionPanel({
    translate: translateSelection,
    cancel: session => {
      cancelledSelections.add(session);
      if (cancelledSelections.size > 100) cancelledSelections.delete(cancelledSelections.values().next().value!);
      void chrome.runtime.sendMessage({ type: 'CANCEL', sessionId: session }).catch(() => {});
    },
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
    providerLabel: () => `${label()} · ${languageSummary(language)}`
  });
  const languagePanel = createLanguagePanel(async () => {
    const check = await providerStatus();
    if (!check?.ok || !Number.isSafeInteger(check.settingsVersion)) throw new Error('无法读取语言设置，请重试');
    return { language: parseLanguageSettings(check.language), version: check.settingsVersion! };
  }, async (rule, version) => {
    if (languageIdentity(rule) === languageIdentity(language) && version === settingsVersion) return;
    const restart = active;
    applyingLanguage = true;
    pageRevision++;
    stop(); selection.close();
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'SET_LANGUAGE', language: rule, expectedVersion: version });
      if (!reply?.ok) throw new Error(reply?.error || '应用失败，请重试');
      const check = await providerStatus();
      if (!check?.ok) throw new Error('已保存，但无法读取最新设置，请重新开启翻译');
      language = parseLanguageSettings(check.language); settingsVersion = check.settingsVersion!;
      status();
      if (restart && !hiddenForPage) void start();
    } finally { applyingLanguage = false; }
  });

  async function start(): Promise<void> {
    syncPage();
    if (startingForPage === pageRevision || active) return;
    const requestedPage = pageRevision;
    startingForPage = requestedPage;
    try {
      const check = await providerStatus();
      if (hiddenForPage || requestedPage !== pageRevision || active) return;
      if (!check) { status('扩展后台暂时不可用'); return; }
      if (!check?.ok || !check.ready || !check.identity || !Number.isSafeInteger(check.settingsVersion)) {
        status(check?.message || check?.error || '请先配置翻译方式');
        void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        return;
      }
      providerIdentity = check.identity;
      if (check.settingsVersion! < settingsVersion) { status('设置已更新，请重新开启翻译'); return; }
      settingsVersion = check.settingsVersion!;
      language = parseLanguageSettings(check.language);
    } finally { if (startingForPage === requestedPage) startingForPage = null; }
    active = true;
    paused = false;
    blocked = false;
    quotaBlocked = false;
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    controls.setActive(true);
    controls.setPaused(false);
    controls.setRetry(false);
    observer = new RootObserver(changed, root => { dirtyScopes.add(root); scheduleScan(); }, root => { dirtyScopes.add(root); scheduleScan(); },
      { childList: true, characterData: true, subtree: true, attributes: true,
        attributeFilter: ['hidden', 'class', 'style', 'aria-hidden', 'role', 'scope', 'headers', 'open', 'slot', 'name', 'translate', 'contenteditable', 'href', 'lang'] });
    dirtyScopes.clear();
    scan(document.body);
    if (!groups.size) status('当前页面没有可翻译内容；会继续等待新增内容');
  }

  function stop(): void {
    if (!active) return;
    const old = sessionId;
    selection.close();
    active = false;
    sessionId = '';
    observer?.stop();
    observer = null;
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    scanTimer = undefined;
    dirtyScopes.clear();
    clearTranslations();
    groups.clear();
    pending.clear();
    completed.clear();
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
    selection.close();
    languagePanel.close();
    controls.setHidden(true);
  }

  function toggle(): void {
    syncPage();
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
        const previousLimit = budgetInfo?.limit;
        const check = await providerStatus();
        if (check?.budget && (!check.budget.enabled || (previousLimit !== undefined && check.budget.limit > previousLimit))) quotaBlocked = false;
        if (quotaBlocked) {
        const result = await chrome.runtime.sendMessage({ type: 'EXTEND_BUDGET' }) as RuntimeResponse;
        if (!result?.ok) { status(result?.error || '无法增加预算'); return; }
        if (result.budget) budgetInfo = result.budget;
        }
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
    const element = event.composedPath().find((node): node is Element => node instanceof Element) ?? null;
    if (!element || owned(element)) return;
    // Pointer movement is frequent, so the cheap landmark lookup runs first and
    // the structural search only for anchors that have no landmark above them.
    observer?.discover(element);
    scheduleLayoutCheck();
    const container = closestComposed(element, 'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],footer,header,details')
      ?? (closestComposed(element, 'a[href],[role="link"]') ? navigationFor(element) : null);
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
    const data = message as { type?: unknown; text?: unknown; editable?: unknown; frameOk?: unknown; settingsVersion?: number; language?: LanguageSettings };
    if (data.type === 'MT_SETTINGS_CHANGED' && Number.isSafeInteger(data.settingsVersion) && data.settingsVersion! > settingsVersion) {
      if (!applyingLanguage) {
        pageRevision++; stop(); selection.close();
        settingsVersion = data.settingsVersion!; language = parseLanguageSettings(data.language);
        status('翻译设置已更新；点击悬浮球继续');
      }
      sendResponse({ ok: true }); return;
    }
    if (data.type === 'TOGGLE_TRANSLATION') {
      toggle();
      sendResponse({ ok: true });
      return;
    }
    if (data.type === 'MT_SELECTION') {
      syncPage();
      const text = typeof data.text === 'string' ? data.text : '';
      if (data.frameOk === false) selection.open(text, '划词翻译只支持顶层网页；子框架中的选区不会发送。');
      else if (data.editable === true) selection.open(text, '输入框、密码框和可编辑区域的内容不会被发送翻译。');
      else selection.open(text);
      sendResponse({ ok: true });
    }
  });

  let currentDocumentUrl = pageUrlIdentity(location.href);
  function syncPage(): void {
    const next = pageUrlIdentity(location.href);
    if (next !== currentDocumentUrl) {
      currentDocumentUrl = next;
      pageRevision += 1;
      selectionCache.clear();
      forgetAll();
      tokenTotal = 0;
      budgetInfo = undefined;
      selection.close();
      if (active) { stop(); status('页面已切换；点击悬浮球翻译新页面'); }
      if (hiddenForPage) { hiddenForPage = false; controls.setHidden(false); }
    }
  }
  setInterval(syncPage, 1000);
  let currentTitle = document.title.slice(0, 180);
  const titleObserver = new MutationObserver(() => {
    const next = document.title.slice(0, 180);
    if (next === currentTitle) return;
    currentTitle = next;
    if (active) { dirtyScopes.add(document.body); scheduleScan(); }
  });
  titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true });
  new MutationObserver(() => {
    if (active) { dirtyScopes.add(document.body); scheduleScan(); }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}
