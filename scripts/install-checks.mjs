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
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
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
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}: browser response timed out`))},20000);
      pending.set(id, message => {clearTimeout(timer);message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)});
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
    ...(process.env.MT_PROXY ? [`--proxy-server=${process.env.MT_PROXY}`] : []),
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

const modelRequests = [];
let modelDelay = 0;
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\//, '');
  if (name === 'api/chat') {
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-headers', 'content-type'); response.writeHead(204).end(); return; }
    try {
      let body=''; for await (const part of request) body+=part;
      const input=JSON.parse(body); const batch=JSON.parse(input.messages.find(message=>message.role==='user').content);
      modelRequests.push(batch);
      const phrases = { 'zh-CN':'图书馆每天早晨开放，最后一位读者离开后关闭。', 'zh-TW':'圖書館每天早晨開放，最後一位讀者離開後關閉。', en:'The library opens every morning.',ja:'図書館は毎朝開館します。',ko:'도서관은 매일 아침 문을 엽니다.',fr:'La bibliothèque ouvre chaque matin.',de:'Die Bibliothek öffnet jeden Morgen.',es:'La biblioteca abre cada mañana.',pt:'A biblioteca abre todas as manhãs.',ru:'Библиотека открывается каждое утро.' };
      if (batch.pageTitle === 'Language integration' && modelDelay) await new Promise(resolve=>setTimeout(resolve,modelDelay));
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:8,eval_count:2,message:{content:JSON.stringify({translations:batch.groups.flatMap(group=>group.blocks.map(block=>({id:block.id,text:batch.pageTitle === 'Language integration' ? block.text.split(/(__MT_KEEP_\d+__)/g).map(part=>/^__MT_KEEP_\d+__$/.test(part)?part:part.trim()?phrases[batch.targetLang]:part).join('') : '测试译文，仅用于检查提取和显示：'+block.text})))})}}));
    } catch { response.writeHead(400).end(); }
    return;
  }
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
  // Save budgets through the real options UI, including a disabled limit.
  const extensionId = await session.client.evaluate('chrome.runtime.id');
  await pageClient.send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  for (let index=0;index<60;index++) {
    if (await pageClient.evaluate(`document.readyState==='complete' && document.querySelector('#build-version')?.textContent && document.querySelector('#settings button[type=submit]')?.disabled === false`, false)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await pageClient.evaluate(`document.querySelector('#deepseek-budget-limit').value='40000';document.querySelector('#ollama-budget-limit').value='50000';document.querySelector('#ollama-budget-enabled').click();document.querySelector('#settings').requestSubmit()`,false);
  for (let index=0;index<60;index++) {
    if ((await pageClient.evaluate(`document.querySelector('#status').textContent`,false)).includes('已保存')) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const saved=await session.client.evaluate(`chrome.storage.local.get(['budgetSettings','settingsVersion'])`);
  assert.deepEqual(saved.budgetSettings,{deepseek:{enabled:true,limit:40000},ollama:{enabled:false,limit:50000}});
  assert.equal(saved.settingsVersion,0,'saving budgets alone keeps the translation settings version');
  await pageClient.send('Page.reload');
  for (let index=0;index<60;index++) {
    if (await pageClient.evaluate(`document.readyState==='complete' && document.querySelector('#ollama-budget-limit')?.value === '50000'`,false)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await pageClient.evaluate(`document.querySelector('#ollama-budget-limit').disabled`,false),true);
  console.log('PASS options: real budget save, disabled value retained and reload');

  const installedLanguage = await session.client.evaluate(`chrome.storage.local.get('language')`);
  assert.deepEqual(installedLanguage.language, {scope:'all',source:null,target:'zh-CN'}, 'a new installation defaults to all → Simplified Chinese');
  async function waitUI(expression, label) {
    for(let i=0;i<100;i++){if(await pageClient.evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}
    throw new Error(`language check timed out: ${label}: `+await pageClient.evaluate(`document.querySelector('.mt-panel')?.textContent`));
  }
  for(const target of ['zh-TW','en','ja','ko','fr','de','es','pt','ru','zh-CN']) {
    await pageClient.evaluate(`document.querySelector('#language-target').value=${JSON.stringify(target)}; document.querySelector('#language-target').dispatchEvent(new Event('change')); document.querySelector('#settings').requestSubmit()`);
    await waitUI(`document.querySelector('#settings button[type=submit]').disabled === false`, 'save '+target);
    assert.equal((await session.client.evaluate(`chrome.storage.local.get('language')`)).language.target,target);
  }
  console.log('PASS languages: new-install default and all 10 target settings persist');
  await mkdir(join(root,'docs','acceptance-v0.6.0'),{recursive:true});
  if (process.env.MT_SCREENSHOTS) {
    const optionsShot = await pageClient.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(join(root,'docs','acceptance-v0.6.0','options.png'),Buffer.from(optionsShot.data,'base64'));
  }
  await session.client.evaluate(`(async()=>{const raw=await chrome.storage.local.get(['settingsVersion','settingsRevision']);await chrome.storage.local.set({provider:'ollama',ollamaOrigin:${JSON.stringify(base)},ollamaModel:'validation-fixture',language:{scope:'specific',source:'en',target:'zh-CN'},settingsVersion:(raw.settingsVersion||0)+1,settingsRevision:(raw.settingsRevision||0)+1,budgetSettings:{deepseek:{enabled:true,limit:40000},ollama:{enabled:false,limit:50000}}});})()`);
  await pageClient.send('Page.navigate',{url:`${base}/languages.html`});
  await waitUI(`!!document.querySelector('.mt-ball')`, 'content injection');
  const requestStart=modelRequests.length;
  await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);
  await waitUI(`document.querySelectorAll('.mt-translation').length >= 2 && document.querySelector('.mt-panel').textContent.includes('跳过')`, 'specific translation');
  const sourceBlocks=modelRequests.slice(requestStart).flatMap(batch=>batch.groups.flatMap(group=>group.blocks));
  assert.ok(sourceBlocks.some(block=>block.text.includes('library opens')));
  assert.equal(sourceBlocks.some(block=>block.text.includes('bibliothèque')||block.text.includes('図書館')),false,'specific mode excludes other-language blocks');
  assert.ok(sourceBlocks.some(block=>block.text.includes('__MT_KEEP_')),'mixed-language blocks protect the existing Chinese');
  assert.equal(await pageClient.evaluate(`document.querySelectorAll('.mt-translation').length`),2,'only the English paragraph and safe mixed paragraph get translations');
  const repeatedStart=modelRequests.length;
  await pageClient.evaluate(`document.querySelector('.mt-ball').click();document.querySelector('.mt-ball').click()`);
  await waitUI(`document.querySelectorAll('.mt-translation').length===2`,'cached restoration');
  assert.equal(modelRequests.length,repeatedStart,'translated and skipped blocks both reuse the current-rule cache');
  console.log('PASS languages: real CLD filtering, mixed-span protection, skip states and cache restoration');
  async function applyRule(rule) {
    await pageClient.evaluate(`document.querySelector('.mt-ball').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));Array.from(document.querySelectorAll('.mt-context-menu button')).find(button=>button.textContent==='切换翻译语言').click()`);
    await waitUI(`!document.querySelector('#mt-language').hidden && document.querySelector('#mt-language button[type=submit]').disabled===false`,'language panel ready');
    if (process.env.MT_SCREENSHOTS) {
      const screenshot=await pageClient.send('Page.captureScreenshot',{format:'png'});
      await writeFile(join(root,'docs','acceptance-v0.6.0','language-panel.png'),Buffer.from(screenshot.data,'base64'));
    }
    await pageClient.evaluate(`document.querySelector('#mt-language-scope').value=${JSON.stringify(rule.scope)};document.querySelector('#mt-language-scope').dispatchEvent(new Event('change'));document.querySelector('#mt-language-source').value=${JSON.stringify(rule.source||'en')};document.querySelector('#mt-language-target').value=${JSON.stringify(rule.target)};document.querySelector('#mt-language form').requestSubmit()`);
    await waitUI(`document.querySelector('#mt-language').hidden`,'apply language');
  }
  await applyRule({scope:'specific',source:'ja',target:'en'});
  await waitUI(`document.querySelectorAll('.mt-translation').length===1`,'Japanese to English');
  assert.equal(await pageClient.evaluate(`document.querySelector('.mt-translation').textContent`),'The library opens every morning.');
  assert.equal(await pageClient.evaluate(`document.querySelector('.mt-translation').lang`),'en','rendered language follows the selected target');
  await applyRule({scope:'specific',source:'en',target:'zh-CN'});
  await waitUI(`document.querySelectorAll('.mt-translation').length===2`,'switch back to cached English');
  assert.equal(modelRequests.length,repeatedStart+1,'switching back reuses the earlier language cache');
  await applyRule({scope:'all',source:null,target:'ja'});
  await waitUI(`document.querySelectorAll('.mt-translation').length>=3`,'all to Japanese');
  assert.ok(await pageClient.evaluate(`Array.from(document.querySelectorAll('.mt-translation')).every(node=>node.lang==='ja')`),'all rendered translations carry the Japanese language tag');
  assert.ok(await pageClient.evaluate(`Array.from(document.querySelectorAll('.mt-translation')).every(node=>!node.textContent.includes('__MT_KEEP_'))`));
  const allUsage=await session.client.evaluate(`chrome.storage.session.get(null)`);
  const budgets=Object.entries(allUsage).filter(([key])=>key.endsWith(':ollama')).map(([,value])=>value);
  assert.ok(budgets.some(budget=>budget.used>10),'switching languages preserves accumulated use');
  console.log('PASS languages: quick menu, two modes, separate caches, switch-back reuse and budget accumulation');

  // A settings change in another tab stops the active document without issuing new calls.
  const beforeExternal=modelRequests.length;
  await session.client.evaluate(`(async()=>{const raw=await chrome.storage.local.get(['settingsVersion','settingsRevision']);await chrome.storage.local.set({language:{scope:'specific',source:'en',target:'fr'},settingsVersion:raw.settingsVersion+1,settingsRevision:raw.settingsRevision+1});})()`);
  await waitUI(`document.querySelectorAll('.mt-translation').length===0 && !document.querySelector('.mt-ball').classList.contains('mt-active')`,'external change stops old page');
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(modelRequests.length,beforeExternal,'other tabs wait for manual restart');
  // A response already sent by the model cannot be inserted after another rule takes effect.
  modelDelay=700;
  await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);
  for(let i=0;i<60&&modelRequests.length===beforeExternal;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(modelRequests.length>beforeExternal,'a delayed request really started');
  await session.client.evaluate(`(async()=>{const raw=await chrome.storage.local.get('settingsVersion');await chrome.storage.local.set({language:{scope:'specific',source:'en',target:'de'},settingsVersion:raw.settingsVersion+1});})()`);
  await waitUI(`!document.querySelector('.mt-ball').classList.contains('mt-active')`,'cancel delayed request');
  await new Promise(resolve=>setTimeout(resolve,900));
  assert.equal(await pageClient.evaluate(`document.querySelectorAll('.mt-translation').length`),0,'late result is never inserted');
  modelDelay=0;
  console.log('PASS languages: cross-tab updates stop requests and reject late results');
  const activeTab=(await session.client.evaluate(`chrome.tabs.query({})`)).find(tab=>tab.url===`${base}/languages.html`)?.id;
  assert.ok(activeTab,'find the test document rather than an options tab opened by the no-key check');
  async function selectText(id) {
    const text=await pageClient.evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();})()`);
    await session.client.evaluate(`chrome.tabs.sendMessage(${activeTab},{type:'MT_SELECTION',text:${JSON.stringify(text)},editable:false,frameOk:true},{frameId:0})`);
  }
  const beforeSkippedSelection=modelRequests.length;
  await selectText('ja');
  await waitUI(`document.querySelector('#mt-selection').dataset.state==='blocked' && document.querySelector('.mt-sel-result').textContent.includes('不属于指定语言')`,'selection skips other language');
  assert.equal(modelRequests.length,beforeSkippedSelection);
  await selectText('en');
  await waitUI(`document.querySelector('#mt-selection').dataset.state==='success'`,'selection target language');
  assert.equal(await pageClient.evaluate(`document.querySelector('.mt-sel-result').textContent`),'Die Bibliothek öffnet jeden Morgen.');
  await selectText('en');
  await waitUI(`document.querySelector('#mt-selection').dataset.state==='success'`,'selection cache');
  assert.equal(modelRequests.length,beforeSkippedSelection+1);
  console.log('PASS languages: selection shares current rules, skips other languages and reuses its language-specific cache');
  await mkdir(join(root,'docs','acceptance-v0.6.0'),{recursive:true});
  await writeFile(join(root,'docs','acceptance-v0.6.0','install-languages.json'),JSON.stringify({browser:session.browserPath,version:info.version,passed:true,requests:modelRequests},null,2));

  if (process.env.MT_LIVE) {
    await session.client.evaluate(`chrome.storage.local.set({provider:'ollama',ollamaOrigin:${JSON.stringify(base)},ollamaModel:'validation-fixture',settingsVersion:1,budgetSettings:{deepseek:{enabled:true,limit:30000},ollama:{enabled:false,limit:30000}}})`);
    await pageClient.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await pageClient.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    const output=join(root,'docs',process.env.MT_SITE==='fla'?'acceptance-legacy-html':'acceptance-v0.5.0'); await mkdir(output,{recursive:true});
    let records=[];
    if(process.env.MT_SITE)try{records=JSON.parse(await readFile(join(output,'live-sites.json'),'utf8')).records.filter(record=>!process.env.MT_SITE.split(',').includes(record.name))}catch{/* first run */}
    const runName='live-'+new Date().toISOString().replaceAll(':','-')+'.json';
    const sites=[
      {name:'mdn',url:'https://developer.mozilla.org/en-US/docs/Web/API/HTMLSlotElement/assignedNodes'},
      {name:'bilibili',url:'https://www.bilibili.com/video/BV1GJ411x7h7/'},
      {name:'youtube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'},
      // The site's fragment links point to index.html, so start at that alias
      // to test same-document navigation without an intentional page reload.
      {name:'fla',url:'https://fla26course.github.io/index.html'}
    ].filter(site=>!process.env.MT_SITE||process.env.MT_SITE.split(',').includes(site.name));
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const inspect=`(() => {
      const roots=[document],hosts=[];for(let i=0;i<roots.length;i++)for(const element of roots[i].querySelectorAll('*'))if(element.shadowRoot){roots.push(element.shadowRoot);hosts.push(element.tagName.toLowerCase())}
      const comments=roots.flatMap(root=>[...root.querySelectorAll('bili-rich-text,#content-text')]);
      const translations=roots.flatMap(root=>[...root.querySelectorAll('.mt-translation')]);
      const slots=roots.flatMap(root=>[...root.querySelectorAll('slot')]);
      const clean=node=>{
        const visit=node=>{
          if(node.nodeType===3)return node.textContent||'';
          if(node instanceof Element){if(node.matches('.mt-translation,[data-mt-owned],style,script,input,textarea,[contenteditable=true]'))return '';const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return '';}
          const children=node instanceof HTMLSlotElement?node.assignedNodes({flatten:true}):node instanceof Element&&node.shadowRoot?[...node.shadowRoot.childNodes]:[...node.childNodes];
          return children.map(visit).join('');
        };
        return visit(node).replace(/\\s+/g,' ').trim().slice(0,180);
      };
      return {url:location.href,title:document.title,bodyStart:document.body?.innerText.slice(0,240),nodes:roots.reduce((sum,root)=>sum+root.querySelectorAll('*').length,0),openRoots:roots.length-1,hosts:[...new Set(hosts)],slots:slots.length,assignedSlots:slots.filter(slot=>slot.assignedNodes().length).length,comments:comments.length,commentSamples:comments.slice(0,5).map(node=>({tag:node.tagName.toLowerCase(),text:clean(node),shadow:Boolean(node.shadowRoot)})),translations:translations.length,rootStyles:roots.filter(root=>root instanceof ShadowRoot).map(root=>root.querySelectorAll('style[data-mt-owned]').length),overflow:document.documentElement.scrollWidth-innerWidth,status:document.querySelector('.mt-panel [role=status]')?.textContent};
    })()`;
    for(const site of sites){
      const record={name:site.name,url:site.url,provider:'local deterministic fixture (no language-quality assessment)'};
      try {
        for(let attempt=0;attempt<2;attempt++){
          await pageClient.send('Page.navigate',{url:site.url});
          for(let index=0;index<80;index++){
            if(await pageClient.evaluate(`document.readyState !== 'loading' && (Boolean(document.querySelector('.mt-ball')) || location.protocol==='chrome-error:')`,false))break;
            await wait(200);
          }
          if(await pageClient.evaluate(`Boolean(document.querySelector('.mt-ball'))`,false))break;
          record.navigationRetry=true;await wait(1500);
        }
        await wait(2500);
        if(['bilibili','youtube'].includes(site.name))for(let index=0;index<20;index++){
          const available=await pageClient.evaluate(`(() => {const roots=[document];for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*'))if(node.shadowRoot)roots.push(node.shadowRoot);return roots.some(root=>root.querySelector('bili-rich-text,#content-text'));})()`);
          if(available)break;
          await pageClient.evaluate(`document.querySelector('bili-comments,#comments')?.scrollIntoView({block:'start'});window.scrollBy(0,innerHeight*.4)`);
          await wait(750);
        }
        if(['bilibili','youtube'].includes(site.name))for(let index=0;index<4;index++){await pageClient.evaluate(`window.scrollBy(0,innerHeight*.85)`);await wait(900)}
        const courseSnapshot=String.raw`(() => {
          const text=(node,skipParagraphs=false,first=true)=>{
            if(node.nodeType===3)return node.textContent||'';
            if(node instanceof Element && (node.matches('.mt-translation,[data-mt-owned],#mt-controls,#mt-layout-panel,script,style') || (!first && skipParagraphs && node.matches('p'))))return '';
            return [...node.childNodes].map(child=>text(child,skipParagraphs,false)).join('');
          };
          const clean=value=>value.replace(/\s+/g,' ').trim();
          const targets=[...document.querySelectorAll('table td,p,body > a')].map(node=>({text:clean(text(node,node.matches('td'))),table:node.matches('td')||Boolean(node.closest('table'))})).filter(item=>item.text && !/^[\s\d\p{P}\p{S}]+$/u.test(item.text));
          const clone=document.body.cloneNode(true);clone.querySelectorAll('.mt-translation,[data-mt-owned],#mt-controls,#mt-layout-panel,#mt-selection').forEach(node=>node.remove());
          return {targets,shape:clone.innerHTML,width:document.documentElement.scrollWidth,links:[...document.querySelectorAll('body > a[href]')].map(node=>({text:clean(text(node)),href:node.getAttribute('href')}))};
        })()`;
        if(site.name==='fla'){
          assert.equal(await pageClient.evaluate(`location.origin`),'https://fla26course.github.io','the real course page must load');
          record.courseBefore=await pageClient.evaluate(courseSnapshot);
          assert.ok(record.courseBefore.targets.length>=30,'expected course DOM is present');
          await pageClient.evaluate(`window.__courseOriginalLinks=[...document.querySelectorAll('body > a[href]')];window.__courseClickCount=0;window.__courseOriginalLinks[0].addEventListener('click',()=>window.__courseClickCount++);`);
        }
        record.before=await pageClient.evaluate(inspect);
        const navBefore=await pageClient.evaluate(`[...document.querySelectorAll('header,nav')].filter(node=>node.getBoundingClientRect().top<100).slice(0,6).map(node=>({tag:node.tagName,top:node.getBoundingClientRect().top,height:node.getBoundingClientRect().height}))`);
        const start=modelRequests.length;
        await pageClient.evaluate(`document.querySelector('.mt-ball')?.click()`);
        for(let index=0;index<60;index++){await wait(300);const state=await pageClient.evaluate(`document.querySelector('.mt-panel [role=status]')?.textContent||''`);const match=state.match(/已翻译 (\d+)\/(\d+)/);if(match&&match[1]===match[2])break}
        record.after=await pageClient.evaluate(inspect);record.requests=modelRequests.length-start;
        record.blocks=modelRequests.slice(start).reduce((sum,batch)=>sum+batch.groups.reduce((sum,group)=>sum+group.blocks.length,0),0);
        record.commentBlocks=modelRequests.slice(start).flatMap(batch=>batch.groups.flatMap(group=>group.blocks)).filter(block=>record.before.commentSamples?.some(sample=>sample.text&&block.text.includes(sample.text))).length;
        record.navBefore=navBefore;
        record.navAfter=await pageClient.evaluate(`[...document.querySelectorAll('header,nav')].filter(node=>node.getBoundingClientRect().top<100).slice(0,6).map(node=>({tag:node.tagName,top:node.getBoundingClientRect().top,height:node.getBoundingClientRect().height}))`);
        if(record.before.url.startsWith('https://') && record.requests>0){const image=await pageClient.send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,`${site.name}.png`),Buffer.from(image.data,'base64'))}
        if(site.name==='fla'){
          const clean=value=>value.replace(/⟦\/?i\d+⟧/g,'').replace(/\s+/g,' ').trim();
          const translationText=value=>{const prefix='测试译文，仅用于检查提取和显示：';return value.startsWith(prefix)?clean(value.slice(prefix.length)):null;};
          // Ollama protects dotted names (e.g. B.Sc and D.Ullman) before the
          // HTTP request. Compare the observed request against that transport
          // representation; displayed translations must use the original.
          const requestText=value=>{let index=0;return value.replace(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?/g,()=>`__MT_CODE_${++index}__`);};
          const blocks=modelRequests.slice(start).flatMap(batch=>batch.groups.flatMap(group=>group.blocks));
          const expected=new Map();for(const target of record.courseBefore.targets)expected.set(target.text,(expected.get(target.text)||0)+1);
          record.coverage=[...expected].map(([text,count])=>({text,expected:count,requested:blocks.filter(block=>clean(block.text)===requestText(text)).length}));
          assert.deepEqual(record.coverage.filter(item=>item.expected!==item.requested),[],'every course target is requested exactly once per source location');
          const completed=/已翻译 (\d+)\/(\d+)/.exec(record.after.status||'');
          assert.ok(completed && +completed[1]>0 && completed[1]===completed[2],'every requested block completes rendering');
          const translations=async()=>{
            await pageClient.evaluate(`[...document.querySelectorAll('.mt-panel button')].find(button=>button.textContent==='查看受限译文')?.click()`);
            return pageClient.evaluate(`[...document.querySelectorAll('.mt-translation'),...document.querySelectorAll('#mt-layout-panel [lang=zh-CN]')].map(node=>node.textContent)`);
          };
          const shown=await translations();
          record.accessible=record.coverage.map(item=>({...item,displayed:shown.filter(text=>translationText(text)===item.text).length}));
          assert.deepEqual(record.accessible.filter(item=>item.displayed!==item.expected),[],'each course translation is accessible inline or in the restricted panel');
          await pageClient.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));window.__courseOriginalLinks[0].scrollIntoView()`);await wait(300);
          const point=await pageClient.evaluate(`(() => {const link=window.__courseOriginalLinks[0];const walker=document.createTreeWalker(link,NodeFilter.SHOW_TEXT);const range=document.createRange();range.selectNodeContents(walker.nextNode());const r=range.getBoundingClientRect();return {x:r.left+4,y:r.top+r.height/2};})()`);
          await pageClient.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
          await pageClient.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await wait(300);
          record.navigation=await pageClient.evaluate(`({clicks:window.__courseClickCount,hash:decodeURIComponent(location.hash),sameNodes:window.__courseOriginalLinks.every((node,index)=>node===[...document.querySelectorAll('body > a[href]')][index]),targetTop:document.getElementById('Course Information').getBoundingClientRect().top})`);
          assert.equal(record.navigation.clicks,1);assert.equal(record.navigation.hash,'#Course Information');assert.ok(record.navigation.sameNodes);assert.ok(record.navigation.targetTop<10);
          const count=modelRequests.length;
          await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);
          record.restored=await pageClient.evaluate(courseSnapshot);
          assert.equal(record.restored.shape,record.courseBefore.shape,'restore preserves original course DOM');
          assert.equal(await pageClient.evaluate(`document.querySelectorAll('.mt-translation').length`),0);
          await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);await wait(1500);
          record.restoreNewRequests=modelRequests.length-count;assert.equal(record.restoreNewRequests,0,'stable real course page reuses cache');
          await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);
          await pageClient.send('Emulation.setDeviceMetricsOverride',{width:430,height:800,deviceScaleFactor:1,mobile:false});await wait(400);
          record.narrowBefore=await pageClient.evaluate(courseSnapshot);
          await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);await wait(1500);
          record.narrowAfter=await pageClient.evaluate(courseSnapshot);
          assert.ok(record.narrowAfter.width<=Math.max(430,record.narrowBefore.width)+2,'no added overflow at 430px');
          const narrowShown=await translations();
          assert.ok(record.coverage.every(item=>narrowShown.filter(text=>translationText(text)===item.text).length===item.expected),'narrow-window translations remain accessible');
          const screenshot=await pageClient.send('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'fla-narrow.png'),Buffer.from(screenshot.data,'base64'));
          record.remainingTranslations=0;
          await pageClient.evaluate(`document.querySelector('.mt-ball').click()`);
          assert.equal(await pageClient.evaluate(`document.querySelectorAll('.mt-translation').length`),0);
          record.result='passed: source coverage, display access, native anchor click, cache, narrow layout and DOM restore';
          console.log(`LIVE fla: ${record.result}; targets=${record.courseBefore.targets.length}, requests=${record.requests}, blocks=${record.blocks}`);
        }else{
        await wait(1200);
        const count=modelRequests.length;
        await pageClient.evaluate(`document.querySelector('.mt-ball')?.click();document.querySelector('.mt-ball')?.click()`);
        await wait(2500);record.restoreNewRequests=modelRequests.length-count;
        const key=group=>JSON.stringify([group.section||'',group.blocks.map(block=>[block.role,block.text,block.context||''])]);
        const priorGroups=new Set(modelRequests.slice(start,count).flatMap(batch=>batch.groups.map(key)));
        record.restoreGroups=modelRequests.slice(count).flatMap(batch=>batch.groups.map(group=>({repeatedContext:priorGroups.has(key(group)),section:group.section,texts:group.blocks.map(block=>({text:block.text.slice(0,200),role:block.role,context:block.context}))})));
        record.repeatedRestoreGroups=record.restoreGroups.filter(group=>group.repeatedContext).length;
        await pageClient.evaluate(`document.querySelector('.mt-ball')?.click()`);
        record.remainingTranslations=(await pageClient.evaluate(inspect)).translations;
        await pageClient.evaluate(`document.querySelector('.mt-ball')?.click()`);await wait(500);
        if(site.name==='mdn'){
          record.dropdown=await pageClient.evaluate(`(() => {const node=document.querySelector('mdn-dropdown');return {light:node?.innerHTML.slice(0,3500),shadow:node?.shadowRoot?.innerHTML.slice(0,3500)}})()`);
          const menu=await pageClient.evaluate(`(() => {const dropdown=document.querySelector('mdn-dropdown');const button=dropdown?.shadowRoot?.querySelector('button,[role=button],summary,a')||dropdown?.querySelector('button,[role=button],summary,a');if(button){button.click();return true}return false})()`);
          record.menuOpened=menu;await wait(1600);record.menuAfter=await pageClient.evaluate(inspect);
          if(menu){await pageClient.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await wait(800)}
        }else{
          const beforeExpand=modelRequests.length;
          record.expandAction=await pageClient.evaluate(`(() => {
            const roots=[document];for(let i=0;i<roots.length;i++)for(const element of roots[i].querySelectorAll('*'))if(element.shadowRoot)roots.push(element.shadowRoot);
            const sourceText=node=>{
              if(node.nodeType===3)return node.textContent||'';
              if(node instanceof Element&&node.matches('.mt-translation,[data-mt-owned],style,script'))return '';
              const children=node instanceof HTMLSlotElement?(node.assignedNodes({flatten:true}).length?node.assignedNodes({flatten:true}):[...node.childNodes]):node instanceof Element&&node.shadowRoot?[...node.shadowRoot.childNodes]:[...node.childNodes];
              return children.map(sourceText).join('');
            };
            const shown=node=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'};
            let button=roots.flatMap(root=>[...root.querySelectorAll('button,bili-text-button')]).find(node=>shown(node)&&!node.closest('#mt-controls,#mt-selection')&&/展开|条回复|查看回复|(?:view\\s+)?\\d+\\s+replies/i.test(sourceText(node)));
            if(!button){
              const replyRoots=roots.flatMap(root=>[...root.querySelectorAll('bili-comment-replies-renderer')]).map(host=>host.shadowRoot).filter(Boolean);
              button=replyRoots.flatMap(root=>[...root.querySelectorAll('*')]).find(node=>shown(node)&&/^(点击查看|查看全部回复|展开.*回复|更多回复)$/.test(sourceText(node).trim()));
            }
            if(!button)return null;
            button.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
            const root=button.getRootNode();const rect=button.getBoundingClientRect();
            return {tag:button.tagName,id:button.id,text:sourceText(button).trim().slice(0,160),host:root instanceof ShadowRoot?root.host.tagName:null,html:button.outerHTML.slice(0,1400),shadowHtml:button.shadowRoot?.innerHTML.slice(0,2500),point:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
          })()`);
          if(record.expandAction?.point){
            const point=record.expandAction.point;
            await pageClient.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
            await pageClient.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
            await pageClient.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
          }
          await wait(2500);record.expanded=await pageClient.evaluate(inspect);
          if(record.expandAction)for(let index=0;index<12&&record.expanded.comments<=record.before.comments;index++){await wait(500);record.expanded=await pageClient.evaluate(inspect)}
          record.expansionNewRequests=modelRequests.length-beforeExpand;
          record.newCommentNodes=record.expanded.comments-record.before.comments;
        }
        record.result=record.requests>0&&(site.name==='mdn'||record.before.comments>0)?'loaded and translated; inspect detailed results':'blocked: expected page/comment DOM not loaded';
        console.log(`LIVE ${site.name}: ${record.result}; open roots=${record.before.openRoots}, comments=${record.before.comments}, requests=${record.requests}, inline=${record.after.translations}, restore requests=${record.restoreNewRequests}`);
        }
      } catch(error){record.result='blocked';record.error=String(error);if(site.name==='fla')process.exitCode=1;console.log(`LIVE ${site.name}: ${record.error}`)}
      records.push(record);
      const report=JSON.stringify({at:new Date().toISOString(),browser:session.browserPath,version:session.manifest.version,records},null,2);
      await writeFile(join(output,'live-sites.json'),report);await writeFile(join(output,runName),report);
    }
  }
  pageClient.close();
} finally {
  session.client.close();
  server.close();
  await session.stop();
}

console.log('NOTE: opening the native right-click menu and clicking the item stays a manual step.');
