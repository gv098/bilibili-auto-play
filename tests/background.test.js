import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../core.js';

const listeners = {};
let saved = {}, tabs = [], deliveries = [], focused = [], slowTab = null;
let metadata = new Map(), navigations = [], navigationError = false;
globalThis.fetch = async url => {
  const id = new URL(url).searchParams.get('bvid');
  const value = metadata.get(id);
  const data = typeof value === 'function' ? await value() : value || { bvid: id, pages: [{ page: 1 }] };
  return { ok: true, async json() { return { code: 0, data }; } };
};
const event = name => ({ addListener(fn) { listeners[name] = fn; } });
globalThis.chrome = {
  runtime: { onMessage: event('message'), onStartup: event('startup') },
  storage: { local: {
    async get() { return structuredClone(saved); },
    async set(value) { Object.assign(saved, structuredClone(value)); },
  } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  scripting: { async executeScript() {} },
  tabs: {
    onRemoved: event('removed'), onUpdated: event('updated'),
    async query(query) { return structuredClone(tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)); },
    async sendMessage(id, payload) {
      deliveries.push({ id, ...structuredClone(payload.policy) });
      if (slowTab?.id === id) await slowTab.promise;
    },
    async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw Error('closed'); return tab; },
    async reload() {},
    async update(id, change) {
      if (change.url) {
        if (navigationError) throw Error('navigation failed');
        navigations.push({ id, url: change.url });
      } else focused.push(id);
    },
  },
};
await import('../background.js');

const video = (id, index, windowId = 1) => ({ id, index, windowId, title: `视频 ${id}_哔哩哔哩_bilibili`, url: `https://www.bilibili.com/video/BVtest${id}/` });
function reset() { metadata = new Map(); navigations = []; navigationError = false; saved = {}; deliveries = []; focused = []; slowTab = null; tabs = [video(1, 2), video(2, 0), video(3, 1), video(4, 0, 2)]; }
function request(message, tabId) { return new Promise(resolve => listeners.message(message, tabId ? { tab: tabs.find(tab => tab.id === tabId) || { id: tabId } } : {}, resolve)); }
async function state() { return (await request({ type: 'GET_STATE' })).state; }
async function start() { return (await request({ type: 'START', windowId: 1 })).state; }
async function playerEvent(type, s, extra = {}) { return request({ type, token: s.token, key: s.items.find(item => item.id === s.activeTabId).key, ...extra }, s.activeTabId); }

test('panel arrows navigate queue, guard boundaries, and reject duplicate or stale clicks', async () => {
  reset();
  assert.equal((await request({ type: 'HELLO' }, 2)).policy.canNext, false);
  let s = await start();
  let policy = (await request({ type: 'HELLO' }, 2)).policy;
  assert.equal(policy.canPrevious, false); assert.equal(policy.canNext, true);
  await playerEvent('PREVIOUS', s);
  assert.equal((await state()).activeTabId, 2);
  await Promise.all([playerEvent('NEXT', s), playerEvent('NEXT', s)]);
  s = await state(); assert.equal(s.activeTabId, 3);
  await request({ type: 'PAUSE' }); s = await state();
  await playerEvent('PREVIOUS', s);
  s = await state(); assert.equal(s.activeTabId, 2); assert.equal(s.status, 'running');
  assert.equal(deliveries.filter(d => d.id === 3).at(-1).mode, 'hold');
  await request({ type: 'PLAY_ITEM', tabId: 1 });
  s = await state();
  policy = (await request({ type: 'HELLO' }, 1)).policy;
  assert.equal(policy.canPrevious, true); assert.equal(policy.canNext, false);
  await playerEvent('NEXT', s);
  assert.equal((await state()).activeTabId, 1);
  await request({ type: 'STOP' });
  await playerEvent('PREVIOUS', s);
  assert.equal((await state()).status, 'idle');
});

test('opening a new queue tab enables the active panel next arrow', async () => {
  reset(); tabs = [video(2, 0)]; await start();
  assert.equal(deliveries.filter(d => d.id === 2).at(-1).canNext, false);
  tabs.push(video(3, 1));
  await request({ type: 'HELLO' }, 3);
  assert.equal(deliveries.filter(d => d.id === 2).at(-1).canNext, true);
});

function series(id, parts = 2, nextId = null) {
  const tab = tabs.find(tab => tab.id === 2);
  tab.url = `https://www.bilibili.com/video/${id}/`;
  metadata.set(id, { bvid: id, pages: Array.from({ length: parts }, (_, i) => ({ page: i + 1 })),
    ...(nextId ? { ugc_season: { sections: [{ episodes: [{ bvid: id }, { bvid: nextId }] }] } } : {}) });
  return tab;
}
async function arrive(tab) {
  tab.url = navigations.at(-1).url;
  listeners.updated(tab.id, { url: tab.url, status: 'loading' }, tab);
  return (await request({ type: 'HELLO' }, tab.id)).policy;
}

test('multipart then collection continuation keeps ownership until all remaining videos finish', async () => {
  reset(); const tab = series('BVmultipart', 2, 'BVcollectionEnd');
  const first = await start();
  await Promise.all([playerEvent('ENDED', first), playerEvent('ENDED', first)]);
  let s = await state();
  assert.equal(s.activeTabId, 2); assert.equal(s.items.length, 3);
  assert.equal(navigations.length, 1);
  assert.equal(s.items[0].key, 'BVmultipart?p=2');
  listeners.updated(2, { title: 'Late old document title' }, tab);
  assert.equal((await state()).items[0].key, 'BVmultipart?p=2');
  assert.equal((await arrive(tab)).mode, 'play');
  s = await state(); await playerEvent('ENDED', s);
  assert.equal(navigations.length, 2);
  assert.equal((await state()).items[0].key, 'BVcollectionEnd?p=1');
  await arrive(tab); s = await state();
  await playerEvent('ENDED', s);
  assert.equal((await state()).activeTabId, 3);
});

test('metadata and navigation failures expose retry instead of stranding a waiting tab', async () => {
  reset(); const tab = series('BVretry', 2);
  metadata.set('BVretry', () => { throw Error('offline'); });
  let s = await start();
  let result = await playerEvent('ENDED', s);
  assert.equal(result.policy.mode, 'sequence-error');
  assert.equal(result.state.activeTabId, 2);
  series('BVretry', 2); navigationError = true;
  result = await request({ type: 'RESUME' });
  assert.equal(result.state.errorKind, 'sequence');
  assert.equal(result.state.items[0].key, 'BVretry?p=1');
  navigationError = false;
  result = await request({ type: 'RESUME' });
  assert.equal(result.state.items[0].key, 'BVretry?p=2');
  assert.equal(deliveries.filter(d => d.id === 2).at(-1).mode, 'transition');
  await arrive(tab);
  assert.equal((await state()).errorKind, '');
});

test('pause and skip stay responsive during metadata loading; late completion cannot hijack queue', async () => {
  reset(); series('BVslowParts');
  let release;
  metadata.set('BVslowParts', () => new Promise(resolve => { release = resolve; }));
  const before = await start();
  const ended = playerEvent('ENDED', before);
  const paused = await request({ type: 'PAUSE' });
  assert.equal(paused.state.status, 'paused');
  await request({ type: 'NEXT' });
  release({ bvid: 'BVslowParts', pages: [{ page: 1 }, { page: 2 }] });
  await ended;
  assert.equal((await state()).activeTabId, 3);
  assert.equal(navigations.length, 0);
});

test('late retry cannot advance a different active tab', async () => {
  reset(); series('BVslowRetry');
  metadata.set('BVslowRetry', () => { throw Error('offline'); });
  await playerEvent('ENDED', await start());
  let release;
  const fetching = new Promise(resolve => {
    metadata.set('BVslowRetry', () => { resolve(); return new Promise(done => { release = done; }); });
  });
  const retry = request({ type: 'RESUME' }); await fetching;
  await request({ type: 'NEXT' });
  release({ bvid: 'BVslowRetry', pages: [{ page: 1 }, { page: 2 }] });
  await retry;
  assert.equal((await state()).activeTabId, 3);
  assert.equal(navigations.length, 0);
});

test('disabling complete series advances directly to the next tab', async () => {
  reset(); series('BVdisabled');
  await request({ type: 'SET_OPTIONS', completeSeries: false });
  await playerEvent('ENDED', await start());
  assert.equal((await state()).activeTabId, 3);
  assert.equal(navigations.length, 0);
});

test('start follows left-to-right order and silences waiting videos before playing', async () => {
  reset(); const s = await start();
  assert.deepEqual(s.items.map(item => item.id), [2, 3, 1]);
  assert.equal(s.activeTabId, 2); assert.equal(s.status, 'running');
  const playIndex = deliveries.findIndex(d => d.id === 2 && d.mode === 'play');
  for (const id of [1, 3]) assert.ok(deliveries.findIndex(d => d.id === id && d.mode === 'hold') < playIndex);
  assert.equal(deliveries.filter(d => d.id === 4).at(-1).mode, 'free');
  assert.deepEqual(focused, [2]);
});
test('duplicate and stale ended events do not skip queue entries', async () => {
  reset(); const s = await start();
  await Promise.all([playerEvent('ENDED', s), playerEvent('ENDED', s)]);
  const next = await state(); assert.equal(next.activeTabId, 3);
  await playerEvent('ENDED', next, { key: 'wrong-video?p=1' });
  assert.equal((await state()).activeTabId, 3);
});
test('pause holds all videos; resume invalidates old events and restores active video', async () => {
  reset(); const s = await start();
  await request({ type: 'PAUSE' });
  assert.equal((await state()).status, 'paused');
  assert.equal(deliveries.filter(d => d.id === 2).at(-1).mode, 'paused');
  for (const id of [1, 3]) assert.equal(deliveries.filter(d => d.id === id).at(-1).mode, 'hold');
  await playerEvent('ENDED', s);
  assert.equal((await state()).activeTabId, 2);
  await request({ type: 'RESUME' });
  assert.equal((await state()).status, 'running');
  assert.ok((await state()).token > s.token);
});
test('autoplay blocked state can recover through actual playing', async () => {
  reset(); const s = await start();
  await playerEvent('BLOCKED', s);
  assert.equal((await state()).status, 'blocked');
  await playerEvent('PLAYING', s);
  assert.equal((await state()).status, 'running');
  assert.equal((await state()).error, '');
});
test('only the current paused video can resume with a matching token and video identity', async () => {
  reset(); const running = await start();
  await playerEvent('USER_PAUSED', running);
  const paused = await state();
  const message = { type: 'USER_RESUMED', token: paused.token, key: paused.items.find(item => item.id === 2).key };
  const waiting = await request({ ...message, key: 'BVtest3?p=1' }, 3);
  assert.equal(waiting.policy.mode, 'hold');
  assert.equal((await state()).status, 'paused');
  await request({ ...message, key: 'BVother?p=1' }, 2);
  await request({ ...message, token: running.token }, 2);
  assert.equal((await state()).status, 'paused');
  const resumed = await request(message, 2);
  assert.equal(resumed.policy.mode, 'play');
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.state.activeTabId, 2);
  assert.ok(resumed.state.token > paused.token);
  const duplicate = await request(message, 2);
  assert.equal(duplicate.state.token, resumed.state.token);
  await request({ type: 'NEXT' });
  const next = await state();
  const stale = await request(message, 2);
  assert.equal(stale.policy.mode, 'hold');
  assert.equal(stale.state.activeTabId, next.activeTabId);
  assert.equal(stale.state.token, next.token);
});

test('manual selection takes over a paused queue and continues from the selected item', async () => {
  reset(); const old = await start();
  await request({ type: 'PAUSE' });
  const paused = await state();
  const message = { type: 'USER_SELECTED', key: 'BVtest3?p=1', token: paused.token };
  await request({ ...message, key: 'BVwrong?p=1' }, 3);
  await request({ ...message, token: old.token }, 3);
  await request({ ...message, key: 'BVtest4?p=1' }, 4);
  assert.equal((await state()).activeTabId, 2);
  const result = await request(message, 3);
  assert.equal(result.policy.mode, 'play');
  assert.equal(result.state.activeTabId, 3); assert.equal(result.state.status, 'running');
  assert.equal(deliveries.filter(d => d.id === 2).at(-1).mode, 'hold');
  assert.ok(deliveries.findLastIndex(d => d.id === 2 && d.mode === 'hold') < deliveries.findLastIndex(d => d.id === 3 && d.mode === 'play'));
  const duplicate = await request(message, 3);
  assert.equal(duplicate.state.token, result.state.token);
  await playerEvent('ENDED', old);
  assert.equal((await state()).activeTabId, 3);
  await playerEvent('ENDED', result.state);
  assert.equal((await state()).activeTabId, 1);
});
test('closing active or waiting tabs maintains queue progression', async () => {
  reset(); await start();
  tabs = tabs.filter(tab => tab.id !== 3); listeners.removed(3);
  assert.deepEqual((await state()).items.map(item => item.id), [2, 1]);
  tabs = tabs.filter(tab => tab.id !== 2); listeners.removed(2);
  assert.equal((await state()).activeTabId, 1);
  tabs = tabs.filter(tab => tab.id !== 1); listeners.removed(1);
  assert.equal((await state()).status, 'completed');
});
test('new videos append and stay paused, including early content-script HELLO', async () => {
  reset(); await start(); const added = video(5, 4); tabs.push(added);
  const hello = await request({ type: 'HELLO' }, 5);
  assert.equal(hello.policy.mode, 'hold');
  listeners.updated(5, { status: 'complete' }, added);
  assert.deepEqual((await state()).items.map(item => item.id), [2, 3, 1, 5]);
  const otherWindow = video(6, 3, 2); tabs.push(otherWindow);
  listeners.updated(6, { url: otherWindow.url }, otherWindow);
  assert.equal((await state()).items.length, 4);
  await request({ type: 'SET_OPTIONS', autoAdd: false });
  const ignored = video(7, 5); tabs.push(ignored); listeners.updated(7, { url: ignored.url }, ignored);
  assert.equal((await state()).items.length, 4);
});
test('native pause, finish, and stop yield correct management policies', async () => {
  reset(); let s = await start();
  await playerEvent('USER_PAUSED', s); assert.equal((await state()).status, 'paused');
  await request({ type: 'PLAY_ITEM', tabId: 1 }); s = await state();
  await playerEvent('ENDED', s); assert.equal((await state()).status, 'completed');
  assert.equal((await state()).items.at(-1).status, 'done');
  await request({ type: 'STOP' }); assert.equal((await state()).status, 'idle');
  assert.equal((await state()).items.length, 0);
  assert.equal(deliveries.filter(d => d.id === 1).at(-1).mode, 'free');
});
test('speed persists and is delivered to tabs outside the queue without taking control', async () => {
  reset(); await start(); await request({ type: 'SET_SPEED', speed: 2.75 });
  assert.equal((await state()).speed, 2.75);
  assert.equal(saved[STORAGE_KEY].speed, 2.75);
  assert.equal(deliveries.filter(d => d.id === 4).at(-1).mode, 'free');
  assert.equal(deliveries.filter(d => d.id === 4).at(-1).speed, 2.75);
  assert.equal((await request({ type: 'SET_SPEED', speed: 17 })).ok, false);
  assert.equal((await state()).speed, 2.75);
});
test('SPA video changes reject previous video completion and navigation away removes item', async () => {
  reset(); const previous = await start();
  const tab = tabs.find(tab => tab.id === 2); tab.url = 'https://www.bilibili.com/video/BVnew/?p=2';
  listeners.updated(2, { url: tab.url }, tab); await state();
  await playerEvent('ENDED', previous);
  assert.equal((await state()).activeTabId, 2);
  tab.url = 'https://www.bilibili.com/'; listeners.updated(2, { url: tab.url }, tab);
  assert.equal((await state()).activeTabId, 3);
});
test('browser restart clears stale tab identities but retains settings', async () => {
  reset(); await start(); await request({ type: 'SET_DEFAULT_SPEED', speed: 1.75 });
  await request({ type: 'SET_SPEED', speed: 2.5 });
  listeners.startup(); const s = await state();
  assert.equal(s.status, 'idle'); assert.equal(s.items.length, 0); assert.equal(s.speed, 1.75);
  assert.equal(s.defaultSpeed, 1.75); assert.deepEqual(s.speedOverrides, {});
});
test('default speed applies immediately and new pages retain it after temporary changes', async () => {
  reset(); await request({ type: 'SET_DEFAULT_SPEED', speed: 3 });
  assert.ok(deliveries.every(d => d.speed === 3));
  await request({ type: 'ADJUST_SPEED', direction: 1 }, 1);
  assert.equal((await request({ type: 'HELLO' }, 1)).policy.speed, 3.25);
  tabs.push(video(5, 4));
  assert.equal((await request({ type: 'HELLO' }, 5)).policy.speed, 3);
  await start();
  assert.equal(deliveries.filter(d => d.id === 5).at(-1).speed, 3);
  assert.equal((await state()).defaultSpeed, 3);
});
test('rapid quarter-step adjustments accumulate and respect browser limits', async () => {
  reset(); await request({ type: 'SET_DEFAULT_SPEED', speed: 2 });
  await Promise.all(Array.from({ length: 4 }, () => request({ type: 'ADJUST_SPEED', direction: 1 }, 1)));
  assert.equal((await state()).speed, 3);
  await request({ type: 'ADJUST_SPEED', direction: -1 }, 1);
  assert.equal((await state()).speed, 2.75);
  assert.equal((await state()).defaultSpeed, 2);
  await request({ type: 'SET_SPEED', speed: 16 });
  await request({ type: 'ADJUST_SPEED', direction: 1 }, 1);
  assert.equal((await state()).speed, 16);
  await request({ type: 'SET_SPEED', speed: 0.1 });
  await request({ type: 'ADJUST_SPEED', direction: -1 }, 1);
  assert.equal((await state()).speed, 0.0625);
});
test('refresh and SPA navigation restore the default without changing other tabs', async () => {
  reset(); await request({ type: 'SET_DEFAULT_SPEED', speed: 2 });
  await request({ type: 'SET_SPEED', speed: 2.75 });
  const tab = tabs.find(tab => tab.id === 1);
  listeners.updated(1, { status: 'loading' }, tab);
  assert.equal((await request({ type: 'HELLO' }, 1)).policy.speed, 2);
  assert.equal((await request({ type: 'HELLO' }, 2)).policy.speed, 2.75);
  await request({ type: 'SET_SPEED', speed: 3 });
  tab.url = 'https://www.bilibili.com/video/BVchanged/?p=2';
  listeners.updated(1, { url: tab.url }, tab);
  assert.equal((await request({ type: 'HELLO' }, 1)).policy.speed, 2);
});
test('invalid defaults are rejected and previous-version speed migrates', async () => {
  reset(); saved[STORAGE_KEY] = { speed: 2.5 };
  assert.equal((await state()).defaultSpeed, 2.5);
  assert.equal((await request({ type: 'HELLO' }, 1)).policy.speed, 2.5);
  assert.equal((await request({ type: 'SET_DEFAULT_SPEED', speed: 20 })).ok, false);
  assert.equal((await state()).defaultSpeed, 2.5);
});
test('slow waiting tabs do not delay current speed, pause, or resume commands', async () => {
  reset(); await start();
  let release;
  slowTab = { id: 3, promise: new Promise(resolve => { release = resolve; }) };
  listeners.updated(3, { status: 'complete' }, tabs.find(tab => tab.id === 3));
  let timeout;
  const operations = (async () => {
    await request({ type: 'SET_SPEED', speed: 2 }, 2);
    await request({ type: 'PAUSE' });
    await request({ type: 'RESUME' });
    return true;
  })();
  try {
    const completed = await Promise.race([operations, new Promise(resolve => { timeout = setTimeout(() => resolve(false), 500); })]);
    assert.equal(completed, true, 'current controls waited for an unrelated tab');
    assert.equal((await state()).status, 'running');
    assert.equal(deliveries.filter(d => d.id === 2).at(-1).speed, 2);
    const revisions = deliveries.filter(d => d.id === 2).map(d => d.revision);
    assert.ok(revisions.at(-1) > revisions.at(-2));
  } finally {
    clearTimeout(timeout);
    release();
    await operations;
    slowTab = null;
  }
});
test('partial tab updates and temporarily unavailable URLs do not delete queue entries', async () => {
  reset(); const before = await start();
  listeners.updated(2, { title: 'Updated title' }, { id: 2, windowId: 1 });
  listeners.updated(3, { status: 'loading' }, { id: 3, windowId: 1, status: 'loading' });
  listeners.updated(1, { status: 'complete' }, { id: 1, windowId: 1 });
  const after = await state();
  assert.deepEqual(after.items.map(item => item.id), before.items.map(item => item.id));
  assert.equal(after.activeTabId, 2);
  assert.equal(after.status, 'running');
  assert.equal(after.items[0].key, before.items[0].key);
});
test('resume preserves existing tabs whose URLs are temporarily missing', async () => {
  reset(); await start(); await request({ type: 'PAUSE' });
  for (const tab of tabs) delete tab.url;
  const result = await request({ type: 'RESUME' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.items.map(item => item.id), [2, 3, 1]);
});
