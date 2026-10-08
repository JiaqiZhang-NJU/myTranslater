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
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\//, '');
  if (name === 'api/chat') {
    response.setHeader('access-control-allow-origin', '*');
    if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-headers', 'content-type'); response.writeHead(204).end(); return; }
    try {
      let body=''; for await (const part of request) body+=part;
      const input=JSON.parse(body); const batch=JSON.parse(input.messages.find(message=>message.role==='user').content);
      modelRequests.push(batch);
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:8,eval_count:2,message:{content:JSON.stringify({translations:batch.groups.flatMap(group=>group.blocks.map(block=>({id:block.id,text:'测试译文，仅用于检查提取和显示：'+block.text})))})}}));
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

  if (process.env.MT_LIVE) {
    await session.client.evaluate(`chrome.storage.local.set({provider:'ollama',ollamaOrigin:${JSON.stringify(base)},ollamaModel:'validation-fixture',settingsVersion:1,budgetSettings:{deepseek:{enabled:true,limit:30000},ollama:{enabled:false,limit:30000}}})`);
    await pageClient.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await pageClient.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    const output=join(root,'docs','acceptance-v0.5.0'); await mkdir(output,{recursive:true});
    let records=[];
    if(process.env.MT_SITE)try{records=JSON.parse(await readFile(join(output,'live-sites.json'),'utf8')).records.filter(record=>!process.env.MT_SITE.split(',').includes(record.name))}catch{/* first run */}
    const runName='live-'+new Date().toISOString().replaceAll(':','-')+'.json';
    const sites=[
      {name:'mdn',url:'https://developer.mozilla.org/en-US/docs/Web/API/HTMLSlotElement/assignedNodes'},
      {name:'bilibili',url:'https://www.bilibili.com/video/BV1GJ411x7h7/'},
      {name:'youtube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'}
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
        if(site.name!=='mdn')for(let index=0;index<20;index++){
          const available=await pageClient.evaluate(`(() => {const roots=[document];for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*'))if(node.shadowRoot)roots.push(node.shadowRoot);return roots.some(root=>root.querySelector('bili-rich-text,#content-text'));})()`);
          if(available)break;
          await pageClient.evaluate(`document.querySelector('bili-comments,#comments')?.scrollIntoView({block:'start'});window.scrollBy(0,innerHeight*.4)`);
          await wait(750);
        }
        if(site.name!=='mdn')for(let index=0;index<4;index++){await pageClient.evaluate(`window.scrollBy(0,innerHeight*.85)`);await wait(900)}
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
      } catch(error){record.result='blocked';record.error=String(error);console.log(`LIVE ${site.name}: ${record.error}`)}
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
