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
let failCollectionRead = true;
let navigation = Promise.resolve();
let releaseMetadata;
const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
let dropNextEnd = false;
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
    async update(id, change) {
      if (!change.url) return;
      const tab = tabs.find(tab => tab.id === id);
      tab.url = change.url;
      listeners.updated(id, { url: change.url, status: 'loading' }, tab);
      navigation = loadPage(tab).then(() => listeners.updated(id, { status: 'complete' }, tab));
      navigation.catch(() => {});
    }, async reload() {},
    async sendMessage(id, message) { return pages.get(id).evaluate(message => new Promise(resolve => window.contentListener(message, {}, resolve)), message); },
  },
};
const request = (message, tab) => new Promise(resolve => listeners.message(message, tab ? { tab } : {}, resolve));
globalThis.fetch = async url => {
  const bvid = new URL(url).searchParams.get('bvid');
  if (bvid === 'BVtest1') await metadataGate;
  if (bvid === 'BVlast1' && failCollectionRead) throw Error('Temporary metadata outage');
  return { ok: true, async json() { return { code: 0, data: {
    bvid, pages: bvid === 'BVtest1' ? [{ page: 1 }, { page: 2 }] : [{ page: 1 }],
    ...(bvid === 'BVtest1' ? { ugc_season: { sections: [{ episodes: [{ bvid }, { bvid: 'BVlast1' }] }] } } : {}),
  } }; } };
};
await import('../background.js');
const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const wav = Buffer.alloc(44 + 8000 * 2 * 30);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

async function loadPage(tab) {
  const page = pages.get(tab.id);
  await page.goto(tab.url);
  await page.locator('video').evaluate((video, src) => { video.src = src; }, `data:audio/wav;base64,${wav.toString('base64')}`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await page.addScriptTag({ content: source });
}

try {
  for (const tab of tabs) {
    const page = await browser.newPage();
    pages.set(tab.id, page);
    await page.exposeBinding('relaySend', async (_, message) => {
      if (message.type === 'SET_SPEED' && speedGate) await speedGate;
      if (message.type === 'ENDED' && dropNextEnd) { dropNextEnd = false; return null; }
      return request(message, tab);
    });
    await page.addInitScript(() => {
      window.chrome = {
        runtime: { sendMessage: message => window.relaySend(message), onMessage: { addListener(fn) { window.contentListener = fn; } } },
        storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
      };
    });
    await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="bilibili-player"><video controls muted></video><button id="native-play">Play</button><button id="native-pause">Pause</button></div><script>document.querySelector("#native-play").onclick=()=>document.querySelector("video").play().catch(()=>{});document.querySelector("#native-pause").onclick=()=>document.querySelector("video").pause();</script>' }));
    await loadPage(tab);
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
  await waiting.locator('video').evaluate(video => video.play().catch(() => {}));
  await waiting.waitForFunction(() => document.querySelector('video').paused);
  await expectState('running', false);
  assert.equal((await request({ type: 'GET_STATE' })).state.activeTabId, 1);
  console.log('PASS: repeated popup pause/resume; background autoplay cannot take over the queue');

  await waiting.locator('#native-play').click();
  await expectState('running', false, 2);
  assert.equal(await active.locator('video').evaluate(video => video.paused), true);
  await active.getByRole('button', { name: '播放此条', exact: true }).click();
  await expectState('running', false, 1);
  await request({ type: 'PAUSE' });
  await waiting.locator('#native-play').click();
  await expectState('running', false, 2);
  assert.equal(await active.locator('video').evaluate(video => video.paused), true);
  await active.locator('#native-play').focus();
  await active.keyboard.press('Enter');
  await expectState('running', false, 1);
  assert.equal(await waiting.locator('video').evaluate(video => video.paused), true);
  await waiting.locator('video').evaluate(video => video.play().catch(() => {}));
  await waiting.waitForFunction(() => document.querySelector('video').paused);
  assert.equal((await request({ type: 'GET_STATE' })).state.activeTabId, 1);
  console.log('PASS: manual mouse/keyboard play and panel selection switch running or paused queue; old gestures cannot steal it back');

  await request({ type: 'PAUSE' });
  await active.locator('#native-play').click();
  await expectState('running', false);
  await active.locator('video').evaluate(video => { video.currentTime = video.duration - 0.05; });
  await active.waitForFunction(() => document.querySelector('#bili-relay-panel')?.shadowRoot.querySelector('#status').textContent === '本条播放完成，正在接力');
  await request({ type: 'SET_SPEED', speed: 3 });
  assert.equal(await active.locator('video').evaluate(video => video.ended), true);
  assert.equal((await request({ type: 'GET_STATE' })).state.activeTabId, 1);
  releaseMetadata();
  console.log('PASS: a speed broadcast while metadata loads cannot restart the finished part');
  async function expectKey(key) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { state } = await request({ type: 'GET_STATE' });
      if (state.items[0].key === key) { await navigation; await expectState('running', false); return; }
      await delay(25);
    }
    assert.fail(`Did not navigate to ${key}`);
  }
  await expectKey('BVtest1?p=2');
  assert.equal(await waiting.locator('video').evaluate(video => video.paused), true);
  dropNextEnd = true;
  await active.locator('video').evaluate(video => { video.currentTime = video.duration - 0.05; });
  await active.waitForFunction(() => document.querySelector('#bili-relay-panel')?.shadowRoot.querySelector('#status').textContent === '接力未完成，点击重试');
  await active.getByRole('button', { name: '继续播放', exact: true }).click();
  await expectKey('BVlast1?p=1');
  assert.equal(await waiting.locator('video').evaluate(video => video.paused), true);
  console.log('PASS: native ended advances P1 to P2, then next collection episode in the same tab');
  console.log('PASS: missing worker response exposes retry instead of permanent waiting');
  await active.locator('video').evaluate(video => { video.currentTime = video.duration - 0.05; });
  await expectState('blocked', true);
  await active.waitForFunction(() => document.querySelector('#bili-relay-panel')?.shadowRoot.querySelector('#status').textContent === '接力未完成，点击重试');
  failCollectionRead = false;
  await active.getByRole('button', { name: '继续播放', exact: true }).click();
  await expectState('running', false, 2);
  console.log('PASS: metadata failure shows retry; panel retry finishes collection and advances next tab');
  assert.equal(await waiting.getByRole('button', { name: '后一个视频', exact: true }).isDisabled(), true);
  await waiting.getByRole('button', { name: '前一个视频', exact: true }).click();
  await expectState('running', false, 1);
  assert.equal(await waiting.locator('video').evaluate(video => video.paused), true);
  assert.equal(await active.getByRole('button', { name: '前一个视频', exact: true }).isDisabled(), true);
  await active.getByRole('button', { name: '后一个视频', exact: true }).click();
  await expectState('running', false, 2);
  assert.equal(await active.locator('video').evaluate(video => video.paused), true);
  console.log('PASS: panel previous/next arrows switch the actual active player and disable at queue boundaries');
} finally {
  await browser.close();
}
