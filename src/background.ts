import { parseProviderSettings, providerIdentity, translateConfigured } from './settings';
import { isTranslationBatch, type ContentMessage, type TranslationBatch } from './shared';
import { TranslationError } from './translation';

const MAX_ACTIVE = 2;
const controllers = new Map<string, Set<AbortController>>();
const budgetSerial = new Map<number, Promise<void>>();
const tabSerial = new Map<number, Promise<unknown>>();
/** Sessions cancelled while queued, so a waiting request never starts. */
const cancelled = new Map<string, number>();
const SELECTION_MENU_ID = 'mt-translation-selection';
let active = 0;
const waiters: { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function apiKey(): Promise<string> {
  const session = await chrome.storage.session.get('apiKey');
  if (typeof session.apiKey === 'string' && session.apiKey) return session.apiKey;
  const local = await chrome.storage.local.get('apiKey');
  return typeof local.apiKey === 'string' ? local.apiKey : '';
}

async function providerSettings() {
  return parseProviderSettings(await chrome.storage.local.get(['provider', 'ollamaOrigin', 'ollamaModel', 'settingsVersion']));
}

async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new TranslationError('已取消', 'cancelled');
  if (active < MAX_ACTIVE) { active++; return; }
  await new Promise<void>((resolve, reject) => {
    const waiter = { resolve, reject, signal };
    waiters.push(waiter);
    signal.addEventListener('abort', () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        reject(new TranslationError('已取消', 'cancelled'));
      }
    }, { once: true });
  });
  if (signal.aborted) { release(); throw new TranslationError('已取消', 'cancelled'); }
}

function release(): void {
  while (waiters.length) {
    const waiter = waiters.shift()!;
    if (!waiter.signal.aborted) { waiter.resolve(); return; }
  }
  active--;
}

function sessionKey(tabId: number, sessionId: string): string { return `${tabId}:${sessionId}`; }

/** At most one provider call per tab; a waiting request keeps FIFO order. */
function withTabSlot<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const prior = tabSerial.get(tabId) ?? Promise.resolve();
  const next = prior.then(operation, operation);
  const tail = next.then(() => undefined, () => undefined);
  tabSerial.set(tabId, tail);
  void tail.then(() => { if (tabSerial.get(tabId) === tail) tabSerial.delete(tabId); });
  return next;
}

function markCancelled(identity: string): void {
  cancelled.set(identity, Date.now());
  if (cancelled.size > 500) {
    const oldest = [...cancelled].sort((a, b) => a[1] - b[1]).slice(0, cancelled.size - 500);
    for (const [key] of oldest) cancelled.delete(key);
  }
}

interface TabBudget { documentId: string; used: number; inFlight: number; limit: number }

async function withBudget<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const prior = budgetSerial.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => current);
  budgetSerial.set(tabId, tail);
  await prior;
  try { return await operation(); }
  finally {
    release();
    if (budgetSerial.get(tabId) === tail) budgetSerial.delete(tabId);
  }
}

async function budget(tabId: number, documentId: string, provider: 'deepseek' | 'ollama', cost = 0, extend = false): Promise<TabBudget> {
  return withBudget(tabId, async () => {
    const key = `budget:${tabId}:${provider}`;
    const raw = (await chrome.storage.session.get(key))[key] as Partial<TabBudget> | undefined;
    const current: TabBudget = raw?.documentId === documentId && Number.isSafeInteger(raw.used) && Number.isSafeInteger(raw.inFlight) && Number.isSafeInteger(raw.limit)
      ? { documentId, used: raw.used!, inFlight: raw.inFlight!, limit: raw.limit! }
      : { documentId, used: 0, inFlight: 0, limit: 30_000 };
    if (cost && current.used + current.inFlight + cost > current.limit) throw new TranslationError('本页达到预计 token 上限；可选择增加本页预算后继续', 'quota');
    if (extend) current.limit += 30_000;
    current.inFlight += cost;
    await chrome.storage.session.set({ [key]: current });
    return current;
  });
}

async function settleBudget(tabId: number, documentId: string, provider: 'deepseek' | 'ollama', reservedCost: number, actualCost: number): Promise<void> {
  await withBudget(tabId, async () => {
    const key = `budget:${tabId}:${provider}`;
    const current = (await chrome.storage.session.get(key))[key] as TabBudget | undefined;
    if (current?.documentId !== documentId) return;
    await chrome.storage.session.set({ [key]: { ...current, used: current.used + actualCost, inFlight: Math.max(0, current.inFlight - reservedCost) } });
  });
}

async function translateFromTab(tabId: number, documentId: string, sessionId: string, settingsVersion: number, batch: TranslationBatch) {
  const identity = sessionKey(tabId, sessionId);
  if (cancelled.delete(identity)) throw new TranslationError('已取消', 'cancelled');
  return withTabSlot(tabId, async () => {
    await storageReady;
    if (cancelled.delete(identity)) throw new TranslationError('已取消', 'cancelled');
    const settings = await providerSettings();
    if (settings.version !== settingsVersion) throw new TranslationError('翻译方式已更新，请重新开启本页翻译', 'config');
    const key = settings.provider === 'deepseek' ? await apiKey() : '';
    if (settings.provider === 'deepseek' && !key) throw new TranslationError('请先在设置中填写 DeepSeek API Key', 'key');
    if (settings.provider === 'ollama' && !settings.ollamaModel) throw new TranslationError('请先选择 Ollama 本机模型', 'config');
    // A short selection needs far less completion room than a full page batch.
    const reserve = batch.mode === 'selection' ? 512 : 2048;
    const cost = Math.ceil(JSON.stringify(batch).length / 2) + reserve;
    await budget(tabId, documentId, settings.provider, cost);
    const controller = new AbortController();
    const set = controllers.get(identity) ?? new Set<AbortController>();
    set.add(controller);
    controllers.set(identity, set);
    let acquired = false;
    let requestStarted = false;
    let actualCost = 0;
    try {
      await acquire(controller.signal);
      acquired = true;
      requestStarted = true;
      const result = await translateConfigured(settings, key, batch, controller.signal);
      if ((await providerSettings()).version !== settingsVersion) throw new TranslationError('翻译方式已更新，请重新开启本页翻译', 'config');
      actualCost = result.usage?.totalTokens ?? cost;
      return { ok: true as const, ...result };
    } catch (error) {
      // A failed cloud request may still be billed; retain its estimate only if
      // the provider call began. Failed local requests consume no API budget.
      if (requestStarted && settings.provider === 'deepseek') actualCost = cost;
      throw error;
    } finally {
      if (acquired) release();
      set.delete(controller);
      if (!set.size) controllers.delete(identity);
      cancelled.delete(identity);
      await settleBudget(tabId, documentId, settings.provider, cost, actualCost);
    }
  });
}

async function handle(message: unknown, sender: chrome.runtime.MessageSender) {
  if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return { ok: false, error: '消息无效' };
  const data = message as ContentMessage;
  const fromTab = sender.id === chrome.runtime.id && sender.tab?.id !== undefined && /^https?:\/\//.test(sender.url ?? '');
  if (fromTab) {
    const tabId = sender.tab!.id!;
    const documentId = sender.documentId ?? (sender.url ?? '').split('#')[0];
    if (data.type === 'GET_PROVIDER_STATUS') {
      const settings = await providerSettings();
      const ready = settings.provider === 'ollama' ? Boolean(settings.ollamaModel) : Boolean(await apiKey());
      return { ok: true, ready, provider: settings.provider, identity: providerIdentity(settings), settingsVersion: settings.version,
        message: ready ? '' : settings.provider === 'ollama' ? '请先选择 Ollama 本机模型' : '请先填写 DeepSeek API Key' };
    }
    if (data.type === 'OPEN_OPTIONS') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
    if (data.type === 'CANCEL' && typeof data.sessionId === 'string' && /^[\w-]{1,80}$/.test(data.sessionId)) {
      const identity = sessionKey(tabId, data.sessionId);
      markCancelled(identity);
      for (const controller of controllers.get(identity) ?? []) controller.abort();
      return { ok: true };
    }
    if (data.type === 'EXTEND_BUDGET') { const settings = await providerSettings(); await budget(tabId, documentId, settings.provider, 0, true); return { ok: true }; }
    if (data.type === 'TRANSLATE' && typeof data.sessionId === 'string' && /^[\w-]{1,80}$/.test(data.sessionId) && Number.isSafeInteger(data.settingsVersion) && data.settingsVersion >= 0 && isTranslationBatch(data.batch)) {
      return translateFromTab(tabId, documentId, data.sessionId, data.settingsVersion, data.batch);
    }
  }
  return { ok: false, error: '不允许此操作' };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  handle(message, sender).then(sendResponse).catch((error: unknown) => {
    const known = error instanceof TranslationError;
    sendResponse({ ok: false, error: known ? error.message : '扩展发生错误', kind: known ? error.kind : 'unknown' });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settingsVersion) return;
  for (const set of controllers.values()) for (const controller of set) controller.abort();
});

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) { void chrome.runtime.openOptionsPage(); return; }
  void chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATION' })
    .catch(() => chrome.runtime.openOptionsPage());
});

/**
 * The selection entry point uses the browser's own context menu. Registration
 * is idempotent so installs, updates and service-worker wakeups cannot stack
 * duplicate items; the menu never repeats the selected text.
 */
function registerSelectionMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: '用 myTranslater 翻译所选文字',
      contexts: ['selection']
    });
  });
}

registerSelectionMenu();
chrome.runtime.onInstalled.addListener(registerSelectionMenu);

async function openSelection(tabId: number, info: chrome.contextMenus.OnClickData): Promise<void> {
  const text = typeof info.selectionText === 'string' ? info.selectionText : '';
  const action = chrome.action;
  const payload = { type: 'MT_SELECTION', text, editable: info.editable === true, frameOk: (info.frameId ?? 0) === 0 };
  try {
    await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
  } catch {
    // No receiver: the page was never injected (browser page, store page) or
    // site access is blocked. Say so through the toolbar instead of silence.
    await action.setBadgeText({ tabId, text: '!' });
    await action.setTitle({ tabId, title: 'myTranslater 未在此页就绪：请刷新页面或检查网站访问权限' });
    setTimeout(() => {
      void action.setBadgeText({ tabId, text: '' });
      void action.setTitle({ tabId, title: '翻译当前网页' });
    }, 6000);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SELECTION_MENU_ID || tab?.id === undefined) return;
  void openSelection(tab.id, info);
});
