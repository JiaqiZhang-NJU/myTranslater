/**
 * Repeatable DOM regression checks for the content script.
 *
 * The fixtures load the built `dist/content.js` in a real Chromium DOM with a
 * scripted background, so extraction, rendering, incremental updates and the
 * selection panel are exercised together. Set MT_BROWSER to point at a
 * Chromium-based browser; nothing here depends on a particular user profile or
 * a specific Chromium build number.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const fixtures = join(root, 'tests', 'fixtures');
const dist = join(root, 'dist');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };

async function discoverBrowser() {
  const explicit = process.env.MT_BROWSER ?? process.argv.find(value => value.startsWith('--browser='))?.slice('--browser='.length);
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const base of programFiles) {
    candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  const local = process.env['LOCALAPPDATA'];
  if (local) {
    const playwright = join(local, 'ms-playwright');
    let entries = [];
    try { entries = (await readdir(playwright)).filter(name => name.startsWith('chromium-')); }
    catch { entries = []; }
    for (const entry of entries.sort().reverse()) {
      candidates.push(join(playwright, entry, 'chrome-win64', 'chrome.exe'));
      candidates.push(join(playwright, entry, 'chrome-win', 'chrome.exe'));
    }
    if (!entries.length) candidates.push(join(playwright, 'chromium-1234', 'chrome-win64', 'chrome.exe'));
    candidates.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

const browserPath = await discoverBrowser();
if (!browserPath) {
  console.log('SKIP: no Chromium-based browser found. Set MT_BROWSER to the executable path to run these checks.');
  process.exit(0);
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const name = path.replace(/^\//, '');
  const target = name.endsWith('.html') ? join(fixtures, name) : join(dist, name);
  if (!name || !target.startsWith(root) || !existsSync(target)) {
    response.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': `${types[target.slice(target.lastIndexOf('.'))] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(500).end('error');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), 'mytranslater-checks-'));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: 'ignore', windowsHide: true });

const results = [];
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'browser DevTools failed to start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(item => item.type === 'page');
  assert.ok(page, 'no page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression, userGesture = false) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, label = expression) {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function open(path) {
    await send('Page.navigate', { url: `${base}${path}` });
    await until('document.readyState === "complete" && Boolean(window.chrome && window.toggleFromToolbar)', path);
    await evaluate(`window.__clean = value => {
      let text = String(value ?? '');
      let result = '';
      let depth = 0;
      for (const char of text) {
        if (char === '\\u27e6') { depth++; continue; }
        if (char === '\\u27e7') { depth = Math.max(0, depth - 1); continue; }
        if (!depth) result += char;
      }
      return result.replace(/\\s+/g, ' ').trim();
    }`);
  }
  async function check(name, body) {
    try {
      await body();
      results.push({ name, ok: true });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error: String(error.message) });
      console.log(`FAIL ${name}\n     ${String(error.message).split('\n').join('\n     ')}`);
    }
  }

  const controlsVisible = `getComputedStyle(document.querySelector('#mt-controls')).display !== 'none'`;
  await check('controls: fixed edge tab, no dragging, keyboard focus and menu', async () => {
    await open('/fullscreen.html');
    const geometry = `(() => {
      const rect = document.querySelector('.mt-ball').getBoundingClientRect();
      return { right: rect.right, top: rect.top, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()`;
    const before = await evaluate(geometry);
    assert.equal(before.right, before.viewportWidth, 'tab is attached to the right edge');
    assert.equal(before.width, 36);
    assert.equal(before.height, 48);
    assert.equal(before.top, (before.viewportHeight - before.height) / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.right - 18, y: before.top + 24, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.right - 150, y: before.top + 100, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.right - 150, y: before.top + 100, button: 'left', clickCount: 1 });
    assert.deepEqual(await evaluate(geometry), before, 'dragging cannot move the tab');
    await evaluate(`document.querySelector('.mt-ball').focus()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mt-panel')).visibility`), 'visible', 'keyboard focus exposes actions');
    await evaluate(`document.querySelector('.mt-ball').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    const menu = await evaluate(`(() => { const r = document.querySelector('.mt-context-menu').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; })()`);
    assert.ok(menu.left >= 0 && menu.right <= menu.width && menu.top >= 0 && menu.bottom <= menu.height, 'menu stays inside viewport');
  });

  await check('controls: real native document, video and iframe fullscreen', async () => {
    await open('/fullscreen.html');
    await evaluate(`window.toggleFromToolbar()`);
    await until(`document.querySelector('.mt-ball').classList.contains('mt-active')`);
    for (const selector of ['html', '#video', '#frame']) {
      if (selector === '#frame') await evaluate(`const frame = document.createElement('iframe'); frame.id = 'frame'; frame.srcdoc = '<video controls></video>'; document.body.append(frame)`);
      await evaluate(`document.querySelector('${selector}').requestFullscreen()`, true);
      assert.equal(await evaluate(`Boolean(document.fullscreenElement)`), true, 'native API really entered fullscreen');
      await until(`!(${controlsVisible})`);
      await evaluate(`document.exitFullscreen()`);
      await until(controlsVisible);
    }
    assert.equal(await evaluate(`document.querySelector('.mt-ball').classList.contains('mt-active')`), true, 'translation stays active');
    assert.equal(await evaluate('window.cancels.length'), 0, 'automatic hiding never cancels translation');
  });

  await check('controls: CSS web fullscreen, initial fullscreen, resize and player removal', async () => {
    await open('/fullscreen.html?fullscreen');
    await until(`!(${controlsVisible})`);
    await evaluate(`document.querySelector('#player').className = 'player'`);
    await until(controlsVisible);
    for (const mode of ['theater', 'inline-fill']) {
      await evaluate(`document.querySelector('#player').className = 'player ${mode}'`);
      await wait(150);
      assert.equal(await evaluate(controlsVisible), true, `${mode} is not fullscreen`);
    }
    await evaluate(`document.body.style.overflow = 'hidden'; document.querySelector('#player').className = 'player absolute-screen'`);
    await until(`!(${controlsVisible})`);
    await evaluate(`document.body.style.overflow = ''; document.querySelector('#player').className = 'player'`);
    await until(controlsVisible);
    await evaluate(`document.documentElement.style.overflowY = 'scroll'; document.querySelector('#player').className = 'player web-screen'; document.querySelector('#player').style.cssText = 'width:auto;height:auto'`);
    await until(`!(${controlsVisible})`, 'inset fullscreen with a visible scrollbar');
    await evaluate(`document.documentElement.style.overflowY = ''; document.querySelector('#player').style.cssText = ''; document.querySelector('#player').className = 'player'`);
    await until(controlsVisible);
    // Cross-origin player contents need no access: the iframe's geometry suffices.
    await evaluate(`document.querySelector('#player').innerHTML = '<iframe title="Player" src="about:blank" style="width:100%;height:100%;border:0"></iframe>'; document.querySelector('#player').className = 'player web-screen'`);
    await until(`!(${controlsVisible})`);
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    await wait(150);
    assert.equal(await evaluate(controlsVisible), false, 'fullscreen remains hidden after resize');
    await evaluate(`document.querySelector('#player').remove()`);
    await until(controlsVisible);
    const edge = await evaluate(`document.querySelector('.mt-ball').getBoundingClientRect().right === innerWidth`);
    assert.equal(edge, true, 'restored tab still touches the edge');
    await send('Emulation.clearDeviceMetricsOverride');
  });

  await check('controls: fullscreen preserves manual hide and closes menus', async () => {
    await open('/fullscreen.html');
    await evaluate(`document.querySelector('.mt-ball').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); document.querySelector('#player').className = 'player web-screen'`);
    await until(`!(${controlsVisible})`);
    assert.equal(await evaluate(`document.querySelector('.mt-context-menu').hidden`), true);
    await evaluate(`document.querySelector('#player').className = 'player'`);
    await until(controlsVisible);
    await evaluate(`document.querySelector('.mt-context-menu button').click(); document.querySelector('#player').className = 'player web-screen'`);
    await until(`document.querySelector('#mt-controls').classList.contains('mt-fullscreen-hidden')`);
    await evaluate(`document.querySelector('#player').className = 'player'`);
    await until(`!document.querySelector('#mt-controls').classList.contains('mt-fullscreen-hidden')`);
    assert.equal(await evaluate(controlsVisible), false, 'exiting fullscreen preserves manual hide');
    await evaluate(`window.toggleFromToolbar(); document.querySelector('#player').className = 'player web-screen'`);
    await until(`document.querySelector('#mt-controls').classList.contains('mt-fullscreen-hidden')`);
    assert.equal(await evaluate(controlsVisible), false, 'toolbar cannot reveal controls over fullscreen');
    await evaluate(`document.querySelector('#player').className = 'player'`);
    await until(controlsVisible);
  });

  await check('coverage: event navigation, ARIA controls, labels and exclusions', async () => {
    await open('/coverage.html');
    await until('document.querySelectorAll(".mt-translation").length > 8');
    await wait(1500);
    const facts = await evaluate(`(() => {
      const clean = window.__clean;
      const blocks = window.requests.flatMap(batch => batch.groups.flatMap(group => group.blocks));
      const counts = {};
      const roles = {};
      for (const block of blocks) {
        const text = clean(block.text);
        counts[text] = (counts[text] ?? 0) + 1;
        if (!(text in roles)) roles[text] = block.role;
      }
      const matchesLink = [...document.querySelectorAll('.wf-nav-item')].find(link => link.textContent.includes('Matches'));
      const titleNode = matchesLink?.querySelector('.wf-nav-item-title');
      return {
        requests: window.requests.length,
        counts,
        roles,
        texts: blocks.map(block => clean(block.text)),
        tabs: document.querySelectorAll('[role="tab"]').length,
        badge: clean(matchesLink?.querySelector('sup')?.textContent),
        linkText: clean(matchesLink?.textContent),
        linkHref: matchesLink?.getAttribute('href') ?? '',
        carrierParent: titleNode?.querySelector('.mt-translation')?.parentElement?.className ?? '',
        carrierClass: titleNode?.className ?? '',
        cardLinkTranslated: Boolean(document.querySelector('#card-link .mt-translation')),
        cardTranslated: Boolean(document.querySelector('#card ~ .mt-translation')),
        labelTranslated: Boolean(document.querySelector('#lab .mt-translation')),
        summaryTranslated: Boolean(document.querySelector('#sum .mt-translation')),
        captionTranslated: Boolean(document.querySelector('#cap .mt-translation')),
        parentBeforeList: document.querySelector('#parent > ul')?.previousElementSibling?.className ?? '',
        parentShape: [...document.querySelector('#parent').childNodes].map(node => node.nodeType === 3 ? 'text:' + (node.textContent ?? '').trim().slice(0, 12) : node.tagName + '.' + node.className).join(' | '),
        translations: document.querySelectorAll('.mt-translation').length,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        cellContext: document.documentElement.dataset.cellContext ?? '',
        sentPageBatch: window.requests.length > 0
      };
    })()`);
    const count = text => facts.counts[text] ?? 0;
    const roleOf = text => facts.roles[text] ?? '';
    const required = ['Overview', 'Matches', "Pick'em", 'Stats', 'Agents', 'Summary', 'Bracket', 'Highlights',
      'Home', 'Events', 'Champions', 'Group stage rules', 'Each team plays two matches.', 'Tie breakers decide the seed.',
      'Player name', 'Advanced settings', 'Player statistics', 'Player', 'Status', 'Rating', 'TenZ', 'Active',
      'Read more', 'Server maintenance is scheduled for Friday.', 'Read-only release notes'];
    for (const text of required) {
      assert.equal(count(text), 1, `expected exactly one block for ${JSON.stringify(text)}; saw ${JSON.stringify(facts.texts)}`);
    }
    assert.equal(count('News'), 2, 'site navigation and event navigation both keep their own News block');
    const forbidden = ['(34)', '1', '2', '3', '1.24', 'Do not translate this', 'Hidden text here',
      'const answer = 42;', 'Edit me freely', 'Nested read-only island', 'Do not translate'];
    for (const text of forbidden) {
      assert.equal(count(text), 0, `excluded text ${JSON.stringify(text)} must not be requested; saw ${JSON.stringify(facts.texts)}`);
    }
    assert.equal(roleOf('Overview'), 'nav');
    assert.equal(roleOf('Summary'), 'nav');
    assert.equal(roleOf('Highlights'), 'button');
    assert.equal(roleOf('Group stage rules'), 'list-item');
    assert.equal(roleOf('Player statistics'), 'paragraph');
    assert.equal(roleOf('TenZ'), 'table-header');
    assert.equal(roleOf('Active'), 'cell');
    assert.match(facts.cellContext, /Status/);
    assert.equal(facts.badge, '(34)', 'the numeric badge stays untouched in the link');
    assert.match(facts.linkText, /^Matches/);
    assert.equal(facts.linkHref, '/event/matches/2766?series_id=all', 'the original link target is preserved');
    assert.equal(facts.carrierParent, 'wf-nav-item-title', 'the event navigation translation is attached to the title node');
    assert.equal(facts.cardLinkTranslated, false, 'an ordinary content link is not treated as navigation');
    assert.equal(facts.cardTranslated, true);
    assert.equal(facts.labelTranslated, true);
    assert.equal(facts.summaryTranslated, true);
    assert.equal(facts.captionTranslated, true);
    assert.equal(facts.parentBeforeList, 'mt-translation', `the list translation is inserted before the nested list; shape=${facts.parentShape}`);
    assert.ok(facts.translations > 8, 'translations are visible');
    assert.ok(facts.overflow <= 0, `no horizontal overflow (${facts.overflow}px)`);
    assert.equal(await evaluate('window.requests.length'), facts.requests, 'rendering the translations caused no extra request');
  });

  await check('dynamic: added navigation item and changed paragraph update in place', async () => {
    await open('/coverage.html?dynamic');
    await until('document.querySelectorAll(".mt-translation").length > 8');
    await until('document.querySelector("#vod-link .mt-translation") !== null', 'new VODs navigation item translated');
    assert.match(await evaluate('[...document.querySelectorAll("#vod-link .mt-translation")].map(n => n.textContent).join(" ")'), /VODs/);
    const addedItemRequest = await evaluate(`(() => {
      const clean = window.__clean;
      const batch = window.requests.find(item => item.groups.some(group => group.blocks.some(block => clean(block.text) === 'VODs')));
      return batch ? batch.groups.flatMap(group => group.blocks).map(block => clean(block.text)) : null;
    })()`);
    assert.deepEqual(addedItemRequest, ['VODs'], 'only the new navigation item is sent, not the already translated siblings');
    const before = await evaluate('window.requests.length');
    await until('document.querySelector("#intro").textContent.startsWith("Updated coverage")');
    await until('[...document.querySelectorAll("#intro + .mt-translation")].some(n => n.textContent.includes("Updated coverage"))', 'changed paragraph retranslated');
    const facts = await evaluate(`(() => {
      const clean = window.__clean;
      const blocks = window.requests.flatMap(batch => batch.groups.flatMap(group => group.blocks)).map(block => clean(block.text));
      const stale = [...document.querySelectorAll('.mt-translation')].filter(node => node.textContent.includes('The final stage of the 2026 season'));
      return { blocks, stale: stale.length, requests: window.requests.length, before: ${before} };
    })()`);
    assert.equal(facts.stale, 0, 'the outdated paragraph translation is removed');
    assert.equal(facts.blocks.filter(text => text === 'The final stage of the 2026 season begins this weekend in Seoul.').length, 1);
    const lastRequests = await evaluate(`(() => {
      const clean = window.__clean;
      return window.requests[window.requests.length - 1].groups.flatMap(group => group.blocks).map(block => clean(block.text));
    })()`);
    assert.deepEqual(lastRequests, ['Updated coverage starts on Friday.'], 'a changed block is sent alone, not as a full page rescan');
    const settled = await evaluate('window.requests.length');
    await wait(1500);
    assert.equal(await evaluate('window.requests.length'), settled, 'stable content does not keep re-requesting');
  });

  await check('race: a late response never overwrites changed source text', async () => {
    await open('/race.html');
    await until('document.querySelectorAll(".mt-translation").length > 0');
    await wait(2000);
    const facts = await evaluate(`(() => {
      const translations = [...document.querySelectorAll('.mt-translation')].map(node => node.textContent);
      return {
        stale: translations.filter(text => text.includes('Slow old text.')).length,
        current: translations.filter(text => text.includes('Current new text.')).length,
        source: document.querySelector('#raced').textContent,
        translations
      };
    })()`);
    assert.equal(facts.source, 'Current new text.');
    assert.equal(facts.stale, 0, 'the superseded translation is discarded');
    assert.equal(facts.current, 1, 'the current text is translated once');
  });

  await check('large page: first batch latency on about 10,000 nodes', async () => {
    await open('/large.html');
    await until('document.documentElement.dataset.requests !== undefined || document.querySelectorAll(".mt-translation").length > 0', 'first batch dispatched');
    const facts = await evaluate(`(() => ({
      nodes: Number(document.documentElement.dataset.nodes),
      firstBatchMs: Math.round(window.firstBatch - window.start),
      translations: document.querySelectorAll('.mt-translation').length
    }))()`);
    assert.ok(facts.nodes > 8000, `the fixture should hold a large DOM, saw ${facts.nodes} nodes`);
    assert.ok(facts.firstBatchMs >= 0 && facts.firstBatchMs < 3000, `first batch took ${facts.firstBatchMs}ms`);
    console.log(`     ${facts.nodes} nodes, first batch dispatched after ${facts.firstBatchMs}ms`);
  });

  await check('selection: right-click entry point, limits, cancellation and no page requests', async () => {
    await open('/selection.html');
    await evaluate(`window.selectionMessage({ text: 'Overview', editable: false, frameOk: true })`);
    await until('document.querySelector("#mt-selection[data-state=success]") !== null');
    const success = await evaluate(`(() => ({
      visible: !document.querySelector('#mt-selection').classList.contains('mt-sel-closed'),
      result: document.querySelector('#mt-selection .mt-sel-result').textContent,
      source: document.querySelector('#mt-selection .mt-sel-source').textContent,
      pageTranslations: document.querySelectorAll('.mt-translation').length,
      pageRequests: window.requests.length,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(success.visible, true);
    assert.equal(success.result, '划词译文：Overview');
    assert.match(success.source, /Overview/);
    assert.equal(success.pageRequests, 0, 'selection translation never starts a page translation');
    assert.equal(success.pageTranslations, 0, 'the result is not inserted into the page');
    assert.ok(success.overflow <= 0, `the panel causes no horizontal overflow (${success.overflow}px)`);

    const beforeRepeat = await evaluate('window.selectionRequests.length');
    await evaluate(`window.selectionMessage({ text: 'Overview', editable: false, frameOk: true })`);
    await until('document.querySelector("#mt-selection[data-state=success] .mt-sel-result").textContent.includes("划词译文：Overview")');
    assert.equal(await evaluate('window.selectionRequests.length'), beforeRepeat, 'a repeated identical selection is served from the bounded cache');

    const beforeLong = await evaluate('window.selectionRequests.length');
    await evaluate(`window.selectionMessage({ text: 'x'.repeat(2001), editable: false, frameOk: true })`);
    const tooLong = await evaluate(`(() => ({
      result: document.querySelector('#mt-selection .mt-sel-result').textContent,
      state: document.querySelector('#mt-selection').dataset.state,
      requests: window.selectionRequests.length
    }))()`);
    assert.match(tooLong.result, /最多翻译 2,000 字/);
    assert.equal(tooLong.state, 'blocked');
    assert.equal(tooLong.requests, beforeLong, 'an over-long selection is rejected before any request');

    await evaluate(`window.selectionMessage({ text: 'A', editable: false, frameOk: true })`);
    await until('document.querySelector("#mt-selection[data-state=success] .mt-sel-result").textContent.includes("划词译文：A")');
    const single = await evaluate('window.selectionRequests[window.selectionRequests.length - 1].groups[0].blocks[0].text');
    assert.equal(single, 'A');

    const beforeEditable = await evaluate('window.selectionRequests.length');
    await evaluate(`window.selectionMessage({ text: 'sum', editable: true, frameOk: true })`);
    const editable = await evaluate(`(() => ({
      state: document.querySelector('#mt-selection').dataset.state,
      result: document.querySelector('#mt-selection .mt-sel-result').textContent,
      requests: window.selectionRequests.length
    }))()`);
    assert.equal(editable.state, 'blocked');
    assert.match(editable.result, /可编辑区域/);
    assert.equal(editable.requests, beforeEditable, 'an editable selection never reaches the provider');

    const beforeFrame = await evaluate('window.selectionRequests.length');
    await evaluate(`window.selectionMessage({ text: 'Overview', editable: false, frameOk: false })`);
    assert.match(await evaluate(`document.querySelector('#mt-selection .mt-sel-result').textContent`), /顶层网页/);
    assert.equal(await evaluate('window.selectionRequests.length'), beforeFrame, 'a subframe selection is rejected before any request');

    await evaluate(`window.selectionMessage({ text: 'Slow selection', editable: false, frameOk: true })`);
    await until('document.querySelector("#mt-selection").dataset.state === "waiting" || document.querySelector("#mt-selection").dataset.state === "working"');
    await evaluate(`window.selectionMessage({ text: 'Second selection', editable: false, frameOk: true })`);
    await until('document.querySelector("#mt-selection[data-state=success] .mt-sel-result").textContent.includes("Second selection")');
    await wait(1200);
    const raced = await evaluate(`(() => ({
      result: document.querySelector('#mt-selection .mt-sel-result').textContent,
      cancels: window.cancels.length
    }))()`);
    assert.doesNotMatch(raced.result, /Slow selection/, 'a late selection result never replaces the newest one');
    assert.ok(raced.cancels >= 1, 'replacing a pending selection cancels the earlier one');

    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate(`document.querySelector('#mt-selection').classList.contains('mt-sel-closed')`), true, 'Escape closes the panel');
    assert.equal(await evaluate('window.requests.length'), 0, 'no page batch was ever requested on this page');
  });
} finally {
  socket?.close();
  browser.kill();
  server.close();
  if (dirname(profile) === tmpdir() && profile.split(/[\\/]/).at(-1)?.startsWith('mytranslater-checks-')) {
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 4000))]);
    browser.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) process.exitCode = 1;
