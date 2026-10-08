import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranslationBatch } from '../src/shared.ts';

test('background keeps provider selection and key separate, and rejects stale sessions', async () => {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const storageListeners: ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void)[] = [];
  const area = (values: Map<string, unknown>, areaName: string) => ({
    async get(keys: string | string[]) {
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter(key => values.has(key)).map(key => [key, values.get(key)]));
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: values.get(key), newValue: value };
        values.set(key, value);
      }
      for (const listener of storageListeners) listener(changes, areaName);
    },
    async remove(key: string) { values.delete(key); },
    async setAccessLevel() {}
  });
  let handler: ((message: unknown, sender: chrome.runtime.MessageSender, respond: (response: any) => void) => boolean) | undefined;
  let actionHandler: ((tab: chrome.tabs.Tab) => void) | undefined;
  let contextMenuHandler: ((info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void) | undefined;
  let installedHandler: (() => void) | undefined;
  const createdMenus: { id?: string; title?: string; contexts?: string[] }[] = [];
  const badge = new Map<number, string>();
  let openOptionsCount = 0;
  let sentToTab: { tabId: number; message: unknown } | undefined;
  let contentScriptAvailable = true;
  const chromeMock = {
    storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: { addListener: (fn: typeof storageListeners[number]) => { storageListeners.push(fn); } } },
    runtime: {
      id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: (fn: typeof handler) => { handler = fn; } },
      onInstalled: { addListener: (fn: typeof installedHandler) => { installedHandler = fn; } },
      openOptionsPage: async () => { openOptionsCount++; }
    },
    action: {
      onClicked: { addListener: (fn: typeof actionHandler) => { actionHandler = fn; } },
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => { badge.set(tabId, text); },
      setTitle: async () => {}
    },
    contextMenus: {
      removeAll: (callback: () => void) => { createdMenus.length = 0; callback(); },
      create: (item: { id?: string; title?: string; contexts?: string[] }) => { createdMenus.push(item); },
      onClicked: { addListener: (fn: typeof contextMenuHandler) => { contextMenuHandler = fn; } }
    },
    tabs: { sendMessage: async (tabId: number, message: unknown) => {
      if (!contentScriptAvailable) throw new Error('No receiving content script');
      sentToTab = { tabId, message };
      return { ok: true };
    } }
  };
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, configurable: true });
  try {
    await import('../src/background.ts');
    const { loadSettings, saveSettings } = await import('../src/options-service.ts');
    assert.ok(handler);
    assert.ok(actionHandler);
    assert.deepEqual(createdMenus, [{ id: 'mt-translation-selection', title: '用 myTranslater 翻译所选文字', contexts: ['selection'] }]);
    installedHandler?.();
    assert.equal(createdMenus.length, 1);
    assert.ok(contextMenuHandler);
    actionHandler({ id: 7 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sentToTab, { tabId: 7, message: { type: 'TOGGLE_TRANSLATION' } });
    assert.equal(openOptionsCount, 0);
    contentScriptAvailable = false;
    actionHandler({ id: 8 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(openOptionsCount, 1);
    contextMenuHandler!({ menuItemId: 'mt-translation-selection', selectionText: 'Overview', editable: false, frameId: 0 } as chrome.contextMenus.OnClickData, { id: 8 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(badge.get(8), '!');
    contentScriptAvailable = true;
    sentToTab = undefined;
    contextMenuHandler!({ menuItemId: 'mt-translation-selection', selectionText: 'Overview', editable: false, frameId: 0 } as chrome.contextMenus.OnClickData, { id: 7 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sentToTab, { tabId: 7, message: { type: 'MT_SELECTION', text: 'Overview', editable: false, frameOk: true } });
    sentToTab = undefined;
    contextMenuHandler!({ menuItemId: 'mt-translation-selection', selectionText: 'sum', editable: true, frameId: 3 } as chrome.contextMenus.OnClickData, { id: 7 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sentToTab, { tabId: 7, message: { type: 'MT_SELECTION', text: 'sum', editable: true, frameOk: false } });
    sentToTab = undefined;
    contextMenuHandler!({ menuItemId: 'unrelated', selectionText: 'Overview' } as chrome.contextMenus.OnClickData, { id: 7 } as chrome.tabs.Tab);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sentToTab, undefined);
    const optionsSender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html', tab: { id: 42 } } as chrome.runtime.MessageSender;
    const tabSender = { id: 'test-extension', url: 'https://example.com/', tab: { id: 7 } } as chrome.runtime.MessageSender;
    const send = (message: unknown, sender: chrome.runtime.MessageSender) => new Promise<any>(resolve => handler!(message, sender, resolve));
    const batch: TranslationBatch = { pageTitle: 'Atlas', targetLang: 'zh-CN', groups: [{ id: 'g1', blocks: [
      { id: 'b1', role: 'heading', text: 'About' }, { id: 'b2', role: 'paragraph', text: 'Atlas is a tool.' }
    ] }] };
    await saveSettings({ provider: 'ollama', apiKey: '', remember: false, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b' });
    assert.equal((await loadSettings()).provider, 'ollama');
    assert.equal((await send({ type: 'SAVE_SETTINGS' }, optionsSender)).ok, false);
    const blocked = await send({ type: 'SAVE_SETTINGS', provider: 'deepseek', apiKey: 'stolen', remember: true, ollamaOrigin: '', ollamaModel: '' }, tabSender);
    assert.equal(blocked.ok, false);
    assert.equal(local.get('provider'), 'ollama');
    const status = await send({ type: 'GET_PROVIDER_STATUS' }, tabSender);
    assert.equal(status.ready, true);
    assert.equal(status.settingsVersion, 1);
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:11434/api/chat');
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [
        { id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 是一个工具。' }
      ] }) }, prompt_eval_count: 40, eval_count: 10 }), { status: 200 });
    };
    const translated = await send({ type: 'TRANSLATE', sessionId: 'session1', settingsVersion: 1, batch }, tabSender);
    assert.equal(translated.ok, true);
    assert.equal(translated.usage.totalTokens, 50);
    // A user selection waits for the page batch on the same tab and can still
    // be cancelled before it ever reaches the provider.
    let releaseSlow: (() => void) | undefined;
    globalThis.fetch = () => new Promise(resolve => {
      releaseSlow = () => resolve(new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [
        { id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 是一个工具。' }
      ] }) }, prompt_eval_count: 10, eval_count: 5 }), { status: 200 }));
    });
    const slow = send({ type: 'TRANSLATE', sessionId: 'slow-page', settingsVersion: 1, batch }, tabSender);
    await new Promise(resolve => setImmediate(resolve));
    let selectionFetches = 0;
    const selectionBatch: TranslationBatch = { pageTitle: 'Atlas', targetLang: 'zh-CN', mode: 'selection',
      groups: [{ id: 'gsel', blocks: [{ id: 'sel', role: 'paragraph', text: 'About' }] }] };
    globalThis.fetch = async () => {
      selectionFetches++;
      return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'sel', text: '关于' }] }) },
        prompt_eval_count: 20, eval_count: 4 }), { status: 200 });
    };
    const queued = send({ type: 'TRANSLATE', sessionId: 'sel-1', settingsVersion: 1, batch: selectionBatch }, tabSender);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(selectionFetches, 0);
    await send({ type: 'CANCEL', sessionId: 'sel-1' }, tabSender);
    releaseSlow!();
    assert.equal((await slow).ok, true);
    const cancelledSelection = await queued;
    assert.equal(cancelledSelection.ok, false);
    assert.equal(cancelledSelection.kind, 'cancelled');
    assert.equal(selectionFetches, 0);
    const forwarded = await send({ type: 'TRANSLATE', sessionId: 'sel-2', settingsVersion: 1, batch: selectionBatch }, tabSender);
    assert.equal(forwarded.ok, true);
    assert.deepEqual(forwarded.translations, [{ id: 'sel', text: '关于' }]);
    assert.equal(selectionFetches, 1);
    const localBudgetBefore = (session.get('budget:7:ollama') as { used: number }).used;
    const oneBlock: TranslationBatch = { ...batch, groups: [{ ...batch.groups[0], blocks: [batch.groups[0].blocks[0]] }] };
    globalThis.fetch = async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'wrong', text: '关于' }] }) } }), { status: 200 });
    for (let index = 0; index < 15; index++) {
      const failed = await send({ type: 'TRANSLATE', sessionId: `local-failed-${index}`, settingsVersion: 1, batch: oneBlock }, tabSender);
      assert.equal(failed.kind, 'response');
      assert.match(failed.error, /译文 ID/);
    }
    assert.deepEqual(session.get('budget:7:ollama'), { documentId: 'https://example.com/', used: localBudgetBefore, inFlight: 0, limit: 30_000, configuredLimit: 30_000, enabled: true });
    await saveSettings({ provider: 'deepseek', apiKey: 'test-key', remember: true, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b' });
    assert.equal((await loadSettings()).apiKey, 'test-key');
    assert.equal(local.get('apiKey'), 'test-key');
    assert.equal(session.has('apiKey'), false);
    const stale = await send({ type: 'TRANSLATE', sessionId: 'session1', settingsVersion: 1, batch }, tabSender);
    assert.equal(stale.ok, false);
    assert.equal(stale.kind, 'config');
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.deepseek.com/chat/completions');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [
        { id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 是一个工具。' }
      ] }) } }], usage: { prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 } }), { status: 200 });
    };
    const cloud = await send({ type: 'TRANSLATE', sessionId: 'session2', settingsVersion: 2, batch }, tabSender);
    assert.equal(cloud.ok, true);
    assert.equal(cloud.usage.totalTokens, 57);
    assert.equal((session.get('budget:7:deepseek') as { used: number }).used, 57);
    for (let index = 0; index < 20; index++) {
      const attempt = await send({ type: 'TRANSLATE', sessionId: `budget-${index}`, settingsVersion: 2, batch }, tabSender);
      assert.equal(attempt.ok, true);
    }
    assert.equal((session.get('budget:7:deepseek') as { used: number }).used, 57 * 21);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [
      { id: 'b1', text: '项目简介' }, { id: 'b2', text: 'Atlas 是一个工具。' }
    ] }) } }], usage: { prompt_tokens: 4000, completion_tokens: 2000, total_tokens: 6000 } }), { status: 200 });
    let exhausted = false;
    for (let index = 0; index < 10; index++) {
      const attempt = await send({ type: 'TRANSLATE', sessionId: `expensive-${index}`, settingsVersion: 2, batch }, tabSender);
      if (!attempt.ok) { assert.equal(attempt.kind, 'budget'); exhausted = true; break; }
    }
    assert.equal(exhausted, true);
    await send({ type: 'CANCEL', sessionId: 'session2' }, tabSender);
    assert.equal((await send({ type: 'TRANSLATE', sessionId: 'after-cancel', settingsVersion: 2, batch }, tabSender)).kind, 'budget');
    assert.equal((await send({ type: 'EXTEND_BUDGET' }, tabSender)).ok, true);
    assert.equal((await send({ type: 'TRANSLATE', sessionId: 'after-extension', settingsVersion: 2, batch }, tabSender)).ok, true);
    const cloudInput = { provider: 'deepseek' as const, apiKey: 'test-key', remember: true, ollamaOrigin: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b' };
    const afterExtension = await send({ type: 'GET_PROVIDER_STATUS' }, tabSender);
    assert.equal(afterExtension.budget.limit, 60_000);
    await saveSettings(cloudInput);
    assert.equal((await send({ type: 'GET_PROVIDER_STATUS' }, tabSender)).budget.limit, 60_000, 'saving unchanged settings preserves the extended allowance');
    await saveSettings({ ...cloudInput, budgetSettings: { deepseek: { enabled: true, limit: 100_000 }, ollama: { enabled: true, limit: 7000 } } });
    const raised = await send({ type: 'GET_PROVIDER_STATUS' }, tabSender);
    assert.equal(raised.settingsVersion, 2, 'budgets do not change the request settings version');
    assert.equal(raised.budget.limit, 100_000, 'a changed configuration replaces manually added allowance');
    assert.equal(raised.budget.used, afterExtension.budget.used);
    let heldSignal: AbortSignal | undefined;
    let finishHeld: (() => void) | undefined;
    globalThis.fetch = async (_input, init) => new Promise(resolve => {
      heldSignal = init!.signal as AbortSignal;
      finishHeld = () => resolve(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text: '关于项目' }] }) } }], usage: { prompt_tokens: 14, completion_tokens: 9, total_tokens: 23 } }), { status: 200 }));
    });
    const held = send({ type: 'TRANSLATE', sessionId: 'held-budget-edit', settingsVersion: 2, batch: oneBlock }, tabSender);
    while (!finishHeld) await new Promise(resolve => setImmediate(resolve));
    const reserved = (await send({ type: 'GET_PROVIDER_STATUS' }, tabSender)).budget;
    assert.ok(reserved.inFlight > 0);
    await saveSettings({ ...cloudInput, budgetSettings: { deepseek: { enabled: false, limit: 11 }, ollama: { enabled: true, limit: 7000 } } });
    const disabled = await send({ type: 'GET_PROVIDER_STATUS' }, tabSender);
    assert.equal(disabled.settingsVersion, 2);
    assert.equal(disabled.budget.limit, 11);
    assert.equal(disabled.budget.used, reserved.used);
    assert.equal(disabled.budget.inFlight, reserved.inFlight, 'editing preserves the in-flight reservation');
    assert.equal(heldSignal!.aborted, false, 'budget changes do not cancel in-flight calls');
    finishHeld!();
    const settled = await held;
    assert.equal(settled.ok, true);
    assert.deepEqual(settled.budget, { enabled: false, limit: 11, used: reserved.used + 23, inFlight: 0 });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 });
    const accountError = await send({ type: 'TRANSLATE', sessionId: 'empty-account', settingsVersion: 2, batch: oneBlock }, tabSender);
    assert.equal(accountError.kind, 'quota', 'account balance is distinct from the page budget');
    assert.match(accountError.error, /账户余额/);
    assert.ok(accountError.budget.used > settled.budget.used, 'failed cloud calls preserve conservative accounting');
    await saveSettings({ ...cloudInput, budgetSettings: { deepseek: { enabled: true, limit: 11 }, ollama: { enabled: true, limit: 7000 } } });
    assert.equal((await send({ type: 'TRANSLATE', sessionId: 'lower-budget', settingsVersion: 2, batch: oneBlock }, tabSender)).kind, 'budget');
    const beforeAdd = (await send({ type: 'GET_PROVIDER_STATUS' }, tabSender)).budget;
    const added = (await send({ type: 'EXTEND_BUDGET' }, tabSender)).budget;
    assert.equal(added.limit, beforeAdd.limit + 11, 'manual extension adds exactly the configured allowance');
    assert.equal(added.used, beforeAdd.used);
    await saveSettings({ ...cloudInput, provider: 'ollama', budgetSettings: { deepseek: { enabled: true, limit: 11 }, ollama: { enabled: true, limit: 7000 } } });
    const localStatus = await send({ type: 'GET_PROVIDER_STATUS' }, tabSender);
    assert.equal(localStatus.budget.used, localBudgetBefore, 'providers have independent cumulative page usage');
    assert.equal(localStatus.budget.limit, 7000);
    const documentSender = { ...tabSender, documentId: 'same-document', url: 'https://example.com/page-one' };
    await send({ type: 'GET_PROVIDER_STATUS' }, documentSender);
    session.set('budget:7:ollama', { ...(session.get('budget:7:ollama') as object), used: 100 });
    assert.equal((await send({ type: 'GET_PROVIDER_STATUS' }, { ...documentSender, url: 'https://example.com/page-two' })).budget.used, 0, 'SPA route changes reset the page identity even with the same document ID');
    let finishOld: (() => void) | undefined;
    const localResponse = () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ translations: [{ id: 'b1', text: '关于项目' }] }) }, prompt_eval_count: 25, eval_count: 6 }), { status: 200 });
    globalThis.fetch = async () => new Promise(resolve => { finishOld = () => resolve(localResponse()); });
    const oldDocument = { ...documentSender, url: 'https://example.com/old-page' };
    const newDocument = { ...documentSender, url: 'https://example.com/new-page' };
    const older = send({ type: 'TRANSLATE', sessionId: 'old-document', settingsVersion: localStatus.settingsVersion, batch: oneBlock }, oldDocument);
    while (!finishOld) await new Promise(resolve => setImmediate(resolve));
    await send({ type: 'GET_PROVIDER_STATUS' }, newDocument);
    finishOld(); await older;
    assert.equal((session.get('budget:7:ollama') as { documentId: string }).documentId, 'same-document:https://example.com/new-page', 'an older settlement and response never replace a newer page budget');
    const concurrent: (() => void)[] = [];
    globalThis.fetch = async () => new Promise(resolve => concurrent.push(() => resolve(localResponse())));
    const senderA = { ...tabSender, tab: { ...tabSender.tab!, id: 9 } };
    const senderB = { ...tabSender, tab: { ...tabSender.tab!, id: 10 } };
    const requestA = send({ type: 'TRANSLATE', sessionId: 'parallel-a', settingsVersion: localStatus.settingsVersion, batch: oneBlock }, senderA);
    const requestB = send({ type: 'TRANSLATE', sessionId: 'parallel-b', settingsVersion: localStatus.settingsVersion, batch: oneBlock }, senderB);
    while (concurrent.length < 2) await new Promise(resolve => setImmediate(resolve));
    concurrent[1]();
    assert.equal((await requestB).budget.used, 31);
    const stillReserved = (await send({ type: 'GET_PROVIDER_STATUS' }, senderA)).budget;
    assert.equal(stillReserved.used, 0); assert.ok(stillReserved.inFlight > 0, 'another tab settling cannot release this reservation');
    concurrent[0](); assert.equal((await requestA).budget.used, 31);
    // Cancellation while the async reservation write is pending must release
    // that reservation without starting a model request.
    const originalSet = chromeMock.storage.session.set;
    let releaseReservation: (() => void) | undefined;
    chromeMock.storage.session.set = async items => {
      await originalSet(items);
      if ((items['budget:11:ollama'] as { inFlight?: number } | undefined)?.inFlight) await new Promise<void>(resolve => { releaseReservation = resolve; });
    };
    const reserveSender = { ...tabSender, tab: { ...tabSender.tab!, id: 11 } };
    let unintendedFetches = 0;
    globalThis.fetch = async () => { unintendedFetches++; return localResponse(); };
    const reservedCancellation = send({ type: 'TRANSLATE', sessionId: 'cancel-during-reserve', settingsVersion: localStatus.settingsVersion, batch: oneBlock }, reserveSender);
    while (!releaseReservation) await new Promise(resolve => setImmediate(resolve));
    await send({ type: 'CANCEL', sessionId: 'cancel-during-reserve' }, reserveSender);
    releaseReservation();
    const reservationCancelled = await reservedCancellation;
    chromeMock.storage.session.set = originalSet;
    assert.equal(reservationCancelled.kind, 'cancelled');
    assert.equal(unintendedFetches, 0);
    assert.deepEqual(reservationCancelled.budget, { enabled: true, limit: 7000, used: 0, inFlight: 0 });
    assert.equal((await send({ type: 'GET_DOCK_POSITION' }, tabSender)).ratio, .5);
    await send({ type: 'SET_DOCK_POSITION', ratio: .9, origin: 'https://spoof.invalid' }, tabSender);
    assert.equal((await send({ type: 'GET_DOCK_POSITION' }, { ...tabSender, url: 'https://example.com/another' })).ratio, .9, 'position uses the verified sender origin');
    assert.equal((await send({ type: 'GET_DOCK_POSITION' }, { ...tabSender, url: 'https://other.example/' })).ratio, .5);
    assert.equal((await send({ type: 'SET_DOCK_POSITION', ratio: 2 }, tabSender)).ok, false);
    assert.equal((await send({ type: 'SET_DOCK_POSITION', ratio: .2 }, { ...tabSender, frameId: 1 })).ok, false);
    for (let index = 0; index < 202; index++) await send({ type: 'SET_DOCK_POSITION', ratio: .25 }, { ...tabSender, url: `https://site-${index}.example/` });
    const positions = local.get('dockPositions') as { origin: string }[];
    assert.equal(positions.length, 200);
    assert.equal(positions[0].origin, 'https://site-201.example');
    assert.equal(positions.some(item => item.origin === 'https://site-0.example'), false);
    await send({ type: 'GET_DOCK_POSITION' }, { ...tabSender, url: 'https://site-2.example/' });
    await send({ type: 'SET_DOCK_POSITION', ratio: .25 }, { ...tabSender, url: 'https://site-202.example/' });
    const touchedPositions = local.get('dockPositions') as { origin: string }[];
    assert.equal(touchedPositions.some(item => item.origin === 'https://site-2.example'), true, 'reading a recently used origin preserves it in the next bounded save');
    assert.equal(touchedPositions.some(item => item.origin === 'https://site-3.example'), false);
  } finally {
    globalThis.fetch = previousFetch;
    delete (globalThis as { chrome?: unknown }).chrome;
  }
});
