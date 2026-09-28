// Runs the real background and content scripts together against native media elements.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const listeners = {};
const pages = new Map();
const tabs = [1, 2].map(id => ({ id, index: id - 1, windowId: 1, title: `Video ${id}`, url: `https://www.bilibili.com/video/BVtest${id}/` }));
let storage = {};
let speedGate = null;
const event = name => ({ addListener(fn) { listeners[name] = fn; } });
globalThis.chrome = {
  runtime: { onMessage: event('message'), onStartup: event('startup') },
  storage: { local: {
    async get() { return structuredClone(storage); },
    async set(value) { Object.assign(storage, structuredClone(value)); },
  } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  scripting: { async executeScript() { throw new Error('Content script should already be installed'); } },
  tabs: {
    onRemoved: event('removed'), onUpdated: event('updated'),
    async query(query) { return structuredClone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); },
    async get(id) { return tabs.find(tab => tab.id === id); },
    async update() {}, async reload() {},
    async sendMessage(id, message) { return pages.get(id).evaluate(message => new Promise(resolve => window.contentListener(message, {}, resolve)), message); },
  },
};
const request = (message, tab) => new Promise(resolve => listeners.message(message, tab ? { tab } : {}, resolve));
await import('../background.js');
const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const wav = Buffer.alloc(44 + 8000 * 2 * 30);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

try {
  for (const tab of tabs) {
    const page = await browser.newPage();
    pages.set(tab.id, page);
    await page.exposeBinding('relaySend', async (_, message) => {
      if (message.type === 'SET_SPEED' && speedGate) await speedGate;
      return request(message, tab);
    });
    await page.addInitScript(() => {
      window.chrome = {
        runtime: { sendMessage: message => window.relaySend(message), onMessage: { addListener(fn) { window.contentListener = fn; } } },
        storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
      };
    });
    await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="bilibili-player"><video controls muted></video><button id="native-play">Play</button><button id="native-pause">Pause</button></div><script>document.querySelector("#native-play").onclick=()=>document.querySelector("video").play().catch(()=>{});document.querySelector("#native-pause").onclick=()=>document.querySelector("video").pause();</script>' }));
    await page.goto(tab.url);
    await page.locator('video').evaluate((video, src) => { video.src = src; }, `data:audio/wav;base64,${wav.toString('base64')}`);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => document.querySelector('#bili-relay-panel')?.shadowRoot.querySelector('#status').textContent === '自由播放');
  }
  const active = pages.get(1);
  const waiting = pages.get(2);
  async function expectState(status, paused, tabId = 1) {
    const deadline = Date.now() + 5000;
    let actual;
    do {
      const { state } = await request({ type: 'GET_STATE' });
      actual = { status: state.status, paused: await pages.get(tabId).locator('video').evaluate(video => video.paused), tabId: state.activeTabId };
      if (actual.status === status && actual.paused === paused && actual.tabId === tabId) return;
      await delay(25);
    } while (Date.now() < deadline);
    assert.deepEqual(actual, { status, paused, tabId });
  }
  assert.equal((await request({ type: 'START', windowId: 1 })).ok, true);
  await expectState('running', false);
  for (const tab of tabs) listeners.updated(tab.id, { title: 'Still playing' }, { id: tab.id, windowId: 1 });
  const retained = (await request({ type: 'GET_STATE' })).state;
  assert.deepEqual(retained.items.map(item => item.id), [1, 2]);
  assert.equal(retained.activeTabId, 1);
  await expectState('running', false);
  console.log('PASS: queue survives partial tab metadata while native video continues playing');
  let releaseSpeed;
  speedGate = new Promise(resolve => { releaseSpeed = resolve; });
  const immediate = await active.evaluate(() => {
    const shadow = document.querySelector('#bili-relay-panel').shadowRoot;
    shadow.querySelector('[data-speed="2"]').click();
    const preset = document.querySelector('video').playbackRate;
    for (let i = 0; i < 3; i++) shadow.querySelector('#faster').click();
    return { preset, speed: document.querySelector('video').playbackRate, displayed: shadow.querySelector('input').value };
  });
  assert.deepEqual(immediate, { preset: 2, speed: 2.75, displayed: '2.75' });
  releaseSpeed();
  speedGate = null;
  await waiting.waitForFunction(() => document.querySelector('video').playbackRate === 2.75);
  assert.equal(await active.locator('video').evaluate(video => video.playbackRate), 2.75);
  console.log('PASS: speed changes in the click handler before any worker reply; rapid clicks converge across tabs');
  await active.locator('#native-pause').click();
  await expectState('paused', true);
  const stalePause = (await request({ type: 'HELLO' }, tabs[0])).policy;
  await active.locator('#native-play').click();
  await expectState('running', false);
  await chrome.tabs.sendMessage(1, { type: 'APPLY', policy: stalePause });
  assert.equal(await active.locator('video').evaluate(video => video.paused), false);
  console.log('PASS: a delayed pause message cannot undo a newer resume');
  console.log('PASS: native pause then native play resumes the queue');

  await request({ type: 'PAUSE' });
  await expectState('paused', true);
  await active.getByRole('button', { name: '继续播放', exact: true }).click();
  await expectState('running', false);
  console.log('PASS: floating-panel resume after queue pause');

  for (let i = 0; i < 3; i++) {
    await request({ type: 'PAUSE' });
    await request({ type: 'RESUME' });
    await expectState('running', false);
  }
  await waiting.locator('#native-play').click();
  await waiting.waitForFunction(() => document.querySelector('video').paused);
  await expectState('running', false);
  assert.equal((await request({ type: 'GET_STATE' })).state.activeTabId, 1);
  console.log('PASS: repeated popup pause/resume; waiting videos stay paused');

  await request({ type: 'PAUSE' });
  await active.locator('#native-play').click();
  await expectState('running', false);
  await active.locator('video').evaluate(video => { video.currentTime = video.duration - 0.05; });
  await expectState('running', false, 2);
  console.log('PASS: resuming still advances to the next tab when playback ends');
} finally {
  await browser.close();
}
