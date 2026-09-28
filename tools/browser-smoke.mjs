// Optional browser QA: npm install --no-save playwright-core
// BROWSER_PATH selects a locally installed Chrome/Edge executable.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright-core');
const browserPath = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const names = new Set(['/popup.html', '/popup.css', '/popup.js', '/core.js']);
  if (!names.has(pathname)) { res.writeHead(404).end(); return; }
  const type = pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(await fs.readFile(path.join(root, pathname.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 398, height: 780 }, deviceScaleFactor: 1 });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const tabs = [
      { id: 1, index: 0, active: true, title: '从零理解大语言模型：注意力机制到底在做什么', url: 'https://www.bilibili.com/video/BVtest1/' },
      { id: 2, index: 1, title: '把时间留给好奇心：我的知识管理工作流', url: 'https://www.bilibili.com/video/BVtest2/' },
      { id: 3, index: 2, title: '一口气看懂浏览器的工作原理', url: 'https://www.bilibili.com/video/BVtest3/' },
    ];
    let state = { speed: 1.5, defaultSpeed: 1.5, speedOverrides: {}, autoAdd: true, followTab: true, status: 'idle', items: [], activeTabId: null, windowId: 1, error: '' };
    window.chrome = {
      windows: { async getCurrent() { return { id: 1 }; } },
      tabs: { async query() { return tabs; }, async update() {} },
      storage: { onChanged: { addListener() {} } },
      runtime: { async sendMessage(message) {
        if (message.type === 'SET_SPEED' || message.type === 'ADJUST_SPEED') {
          state.speed = message.type === 'SET_SPEED' ? Number(message.speed) : state.speed + message.direction * 0.25;
          for (const tab of tabs) state.speedOverrides[tab.id] = { speed: state.speed };
        }
        if (message.type === 'SET_DEFAULT_SPEED') { state.defaultSpeed = Number(message.speed); state.speed = state.defaultSpeed; state.speedOverrides = {}; }
        if (message.type === 'START') Object.assign(state, { status: 'running', activeTabId: 1, items: tabs.map((tab, index) => ({ ...tab, status: index === 0 ? 'playing' : 'waiting' })) });
        if (message.type === 'PAUSE') state.status = 'paused';
        if (message.type === 'RESUME') state.status = 'running';
        return { ok: true, state: structuredClone(state) };
      } },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await page.getByRole('button', { name: '2×', exact: true }).click();
  assert.equal(await page.locator('#speed').inputValue(), '2');
  await page.locator('#speed').fill('2.75');
  await page.locator('#speed').press('Enter');
  await page.waitForFunction(() => document.querySelector('#speed').value === '2.75');
  await page.locator('#defaultSpeed').fill('3');
  await page.locator('#saveDefault').click();
  await page.waitForFunction(() => document.querySelector('#speed').value === '3');
  await page.locator('#faster').click();
  await page.waitForFunction(() => document.querySelector('#speed').value === '3.25');
  await page.locator('#slower').click();
  await page.locator('#slower').click();
  await page.waitForFunction(() => document.querySelector('#speed').value === '2.75');
  assert.equal(await page.locator('#defaultSpeed').inputValue(), '3');
  await page.locator('#start').click();
  await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === '接力中');
  assert.equal(await page.locator('#queue li').count(), 3);
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === '已暂停');
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === '接力中');
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/popup-preview.png'), fullPage: true });
  assert.deepEqual(failures, []);
  console.log('PASS: popup rendering, preset/custom/default speed, quarter-step controls, queue start, pause/resume');

  // Run content.js with real Chromium media elements on a controlled Bilibili URL.
  const player = await browser.newPage();
  player.on('console', message => console.log('PLAYER:', message.text()));
  await player.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="bilibili-player"><video loop></video></div></body></html>' }));
  await player.addInitScript(() => {
    window.events = [];
    window.testPolicy = { mode: 'free', speed: 1.25, token: 0, key: null, status: 'idle' };
    window.chrome = { storage: { local: {
      async get(key) { return { [key]: JSON.parse(sessionStorage.getItem(key) || 'null') }; },
      async set(values) { for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, JSON.stringify(value)); },
      async remove(key) { sessionStorage.removeItem(key); },
    } }, runtime: {
      onMessage: { addListener(fn) { window.applyRelay = policy => { window.testPolicy = policy; fn({ type: 'APPLY', policy }, {}, () => {}); }; } },
      async sendMessage(message) {
        window.events.push(message);
        if (message.type === 'ADJUST_SPEED') window.applyRelay({ ...window.testPolicy, speed: window.testPolicy.speed + message.direction * 0.25 });
        return { ok: true, policy: window.testPolicy };
      },
    } };
  });
  await player.goto('https://www.bilibili.com/video/BVtest1/');
  await player.addScriptTag({ content: await fs.readFile(path.join(root, 'content.js'), 'utf8') });
  await player.waitForFunction(() => document.querySelector('video').playbackRate === 1.25);
  await player.getByRole('button', { name: '加快 0.25 倍' }).click();
  assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1.5);
  assert.equal(await player.getByRole('spinbutton', { name: '视频倍速' }).inputValue(), '1.5');
  await player.getByRole('button', { name: '减慢 0.25 倍' }).click();
  assert.equal(await player.locator('video').evaluate(video => video.playbackRate), 1.25);
  console.log('PASS: content script initialization');
  // A one-second silent WAV exercises the native media timeline without codecs or downloads.
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  await player.evaluate(async source => {
    const video = document.querySelector('video'); video.muted = true;
    video.src = source;
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(Error(`Media error ${video.error?.message}`)); setTimeout(() => reject(Error('Metadata timeout')), 5000); });
  }, `data:audio/wav;base64,${wav.toString('base64')}`);
  console.log('PASS: generated test media');
  await player.evaluate(() => window.applyRelay({ mode: 'hold', speed: 2.75, token: 1, key: 'BVtest1?p=1', status: 'running' }));
  assert.equal(await player.locator('video').evaluate(video => video.loop), false);
  await player.locator('video').evaluate(video => video.play().catch(() => {}));
  await player.waitForFunction(() => document.querySelector('video').paused);
  await player.evaluate(() => window.applyRelay({ mode: 'play', speed: 2.75, token: 2, key: 'BVtest1?p=1', status: 'running' }));
  await player.waitForFunction(() => window.events.some(event => event.type === 'ENDED'));
  assert.equal(await player.evaluate(() => window.events.filter(event => event.type === 'ENDED').length), 1);
  assert.equal(await player.evaluate(() => window.events.filter(event => event.type === 'USER_PAUSED').length), 0);
  await player.locator('video').evaluate(video => video.dispatchEvent(new Event('ended')));
  assert.equal(await player.evaluate(() => window.events.filter(event => event.type === 'ENDED').length), 1);
  await player.evaluate(() => window.applyRelay({ mode: 'free', speed: 1.25, token: 3, key: null, status: 'idle' }));
  assert.equal(await player.locator('video').evaluate(video => video.loop), true);
  console.log('PASS: real media playback, waiting-tab hold, precise rate, loop suppression/restoration, single ended event');
  const floatingPanel = player.locator('#bili-relay-panel');
  const handle = player.getByRole('button', { name: '移动 Bili 接力浮窗' });
  const before = await floatingPanel.boundingBox();
  const grip = await handle.boundingBox();
  await player.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await player.mouse.down();
  await player.mouse.move(grip.x + grip.width / 2 - 180, grip.y + grip.height / 2 - 120, { steps: 8 });
  await player.mouse.up();
  const moved = await floatingPanel.boundingBox();
  assert.ok(Math.abs(moved.x - (before.x - 180)) < 2);
  assert.ok(Math.abs(moved.y - (before.y - 120)) < 2);
  await player.reload();
  await player.addScriptTag({ content: await fs.readFile(path.join(root, 'content.js'), 'utf8') });
  await player.waitForFunction(() => document.querySelector('#bili-relay-panel')?.style.left);
  const restored = await floatingPanel.boundingBox();
  assert.ok(Math.abs(restored.x - moved.x) < 2 && Math.abs(restored.y - moved.y) < 2);
  await player.setViewportSize({ width: 360, height: 240 });
  await player.waitForFunction(() => {
    const rect = document.querySelector('#bili-relay-panel').getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  await player.getByRole('button', { name: '收起', exact: true }).click();
  await handle.focus();
  await player.keyboard.press('ArrowRight');
  await player.getByRole('button', { name: '展开', exact: true }).click();
  await player.waitForFunction(() => document.querySelector('#bili-relay-panel').getBoundingClientRect().right <= innerWidth);
  await handle.dblclick();
  assert.equal(await floatingPanel.evaluate(element => element.style.left), '');
  assert.equal(await player.evaluate(() => sessionStorage.getItem('biliRelayPanelPosition')), null);
  await floatingPanel.screenshot({ path: path.join(root, 'artifacts/floating-panel-preview.png') });
  console.log('PASS: floating panel drag, saved position after reload, viewport bounds, collapse/expand, reset');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
