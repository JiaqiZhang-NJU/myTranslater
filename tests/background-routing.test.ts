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
    assert.deepEqual(session.get('budget:7:ollama'), { documentId: 'https://example.com/', used: localBudgetBefore, inFlight: 0, limit: 30_000 });
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
      if (!attempt.ok) { assert.equal(attempt.kind, 'quota'); exhausted = true; break; }
    }
    assert.equal(exhausted, true);
    await send({ type: 'CANCEL', sessionId: 'session2' }, tabSender);
    assert.equal((await send({ type: 'TRANSLATE', sessionId: 'after-cancel', settingsVersion: 2, batch }, tabSender)).kind, 'quota');
    assert.equal((await send({ type: 'EXTEND_BUDGET' }, tabSender)).ok, true);
    assert.equal((await send({ type: 'TRANSLATE', sessionId: 'after-extension', settingsVersion: 2, batch }, tabSender)).ok, true);
  } finally {
    globalThis.fetch = previousFetch;
    delete (globalThis as { chrome?: unknown }).chrome;
  }
});
