/**
 * Real-install integration check: loads the built `dist/` folder as an actual
 * unpacked extension (not a scripted mock) and verifies that the browser
 * starts the MV3 service worker, accepts the selection contextMenus
 * registration, injects the content script and stylesheet, and completes a
 * background round trip from the page.
 *
 * Chrome 137+ refuses `--load-extension` in ordinary installed builds, so the
 * candidates are tried in order and the check reports which browser actually
 * loaded the extension. A native right-click menu cannot be opened
 * programmatically: the menu *registration* is verified here, and the manual
 * click remains a human step. Set MT_BROWSER to pin an executable.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const fixtures = join(root, 'tests', 'fixtures');
const dist = join(root, 'dist');

async function browserCandidates() {
  const explicit = process.env.MT_BROWSER ?? process.argv.find(value => value.startsWith('--browser='))?.slice('--browser='.length);
  const candidates = [];
  if (explicit) candidates.push(explicit);
  // A Chromium build that still honours the command-line switch is the most
  // likely to load an unpacked folder, so it is tried before installed Chrome.
  const local = process.env['LOCALAPPDATA'];
  if (local) {
    const playwright = join(local, 'ms-playwright');
    let entries = [];
    try { entries = (await readdir(playwright)).filter(name => name.startsWith('chromium-')); } catch { entries = []; }
    for (const entry of entries.sort().reverse()) {
      candidates.push(join(playwright, entry, 'chrome-win64', 'chrome.exe'));
      candidates.push(join(playwright, entry, 'chrome-win', 'chrome.exe'));
    }
  }
  for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], local].filter(Boolean)) {
    candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates.filter((value, index) => value && existsSync(value) && candidates.indexOf(value) === index);
}

function client(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  ready.catch(() => {});
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = async (method, params = {}) => {
    await ready;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, close: () => ws.close(), evaluate: async (expression, awaitPromise = true) => {
    await ready;
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } };
}

async function attempt(browserPath) {
  const profile = await mkdtemp(join(tmpdir(), 'mytranslater-install-'));
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    // Older/re-testing builds honour this; installed stable Chrome 137+ does not.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
    '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  const session = {
    browserPath, profile, browser, port: 0, worker: null,
    async stop() {
      browser.kill();
      if (profile.startsWith(tmpdir()) && profile.split(/[\\/]/).at(-1)?.startsWith('mytranslater-install-')) {
        await Promise.race([new Promise(resolve => browser.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
        browser.kill();
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      }
    }
  };
  for (let i = 0; i < 100; i++) {
    try { session.port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  return session;
}

async function targets(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
}

/** Finds the myTranslater service worker, which only exists if the load succeeded. */
async function waitForWorker(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const target of (await targets(session.port).catch(() => [])).filter(item => item.type === 'service_worker' && item.url.startsWith('chrome-extension://'))) {
      const candidate = client(target.webSocketDebuggerUrl);
      try {
        const manifest = await candidate.evaluate(`(() => {
          const manifest = chrome.runtime.getManifest();
          return { name: manifest.name, version: manifest.version, permissions: manifest.permissions };
        })()`);
        if (manifest?.name === 'myTranslater') return { client: candidate, manifest };
      } catch { /* another component worker or a worker that is shutting down */ }
      candidate.close();
    }
    if (session.browser.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

const candidates = await browserCandidates();
if (!candidates.length) {
  console.log('SKIP: no Chromium-based browser found. Set MT_BROWSER to the executable path.');
  process.exit(0);
}
if (!existsSync(join(dist, 'manifest.json'))) {
  console.log('SKIP: build the extension first (npm run build).');
  process.exit(0);
}

let session = null;
const refused = [];
for (const candidate of candidates) {
  const attemptSession = await attempt(candidate);
  const found = await waitForWorker(attemptSession, 5000);
  if (found) {
    session = { ...attemptSession, ...found };
    break;
  }
  refused.push(candidate);
  await attemptSession.stop();
}
if (!session) {
  console.log('SKIP: no available browser accepted an unpacked extension.');
  console.log('      Tried: ' + refused.join(', '));
  console.log('      Recent stable Chrome builds reject --load-extension; load dist/ through chrome://extensions manually.');
  process.exit(0);
}
console.log(`browser: ${session.browserPath}${refused.length ? ` (skipped ${refused.length} build(s) that reject --load-extension)` : ''}`);

const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\//, '');
  const target = join(fixtures, name);
  if (!name.endsWith('.html') || !existsSync(target)) { response.writeHead(404).end('not found'); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(await readFile(target));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const info = session.manifest;
  const expectedManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(info.version, expectedManifest.version, 'the loaded manifest reports the released version');
  assert.deepEqual([...info.permissions].sort(), ['contextMenus', 'storage']);

  const menu = await session.client.evaluate(`(async () => {
    try {
      await new Promise(resolve => chrome.contextMenus.removeAll(resolve));
      await new Promise(resolve => chrome.contextMenus.create({ id: 'install-probe', title: 'probe', contexts: ['selection'] }, resolve));
      const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      await new Promise(resolve => chrome.contextMenus.removeAll(resolve));
      return { error };
    } catch (error) { return { error: String(error) }; }
  })()`);
  assert.equal(menu.error, null, `contextMenus is unusable: ${menu.error}`);
  console.log('PASS service worker: manifest version, permissions and selection menu registration');

  const page = (await targets(session.port)).find(item => item.type === 'page');
  assert.ok(page, 'no page target to test the content script');
  const pageClient = client(page.webSocketDebuggerUrl);
  await pageClient.send('Page.navigate', { url: `${base}/coverage.html` });
  let injected = false;
  for (let i = 0; i < 100; i++) {
    injected = await pageClient.evaluate('Boolean(document.querySelector("#mt-controls .mt-ball"))', false);
    if (injected) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(injected, true, 'the content script and its stylesheet were not injected into an ordinary page');
  const ballStyle = await pageClient.evaluate(`(() => {
    const ball = document.querySelector('.mt-ball');
    const style = getComputedStyle(ball);
    return { radius: style.borderRadius, background: style.backgroundColor, right: ball.getBoundingClientRect().right, viewportWidth: document.documentElement.clientWidth };
  })()`, false);
  assert.equal(ballStyle.radius, '14px 0px 0px 14px', `the extension stylesheet is not applied: ${JSON.stringify(ballStyle)}`);
  assert.equal(ballStyle.right, ballStyle.viewportWidth, 'the translation tab touches the right edge');
  console.log('PASS content script: injection and extension stylesheet');

  await pageClient.evaluate('document.querySelector(".mt-ball").click()', false);
  let statusText = '';
  for (let i = 0; i < 80; i++) {
    statusText = await pageClient.evaluate('document.querySelector("#mt-controls .mt-panel span").textContent', false);
    if (statusText.includes('请先')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(statusText, /请先/, `content script to service worker round trip failed: ${statusText}`);
  assert.equal(await pageClient.evaluate('document.querySelectorAll(".mt-translation").length', false), 0,
    'nothing should be translated without provider settings');
  console.log('PASS round trip: the content script reached the real service worker');
  pageClient.close();
} finally {
  session.client.close();
  server.close();
  await session.stop();
}

console.log('NOTE: opening the native right-click menu and clicking the item stays a manual step.');
