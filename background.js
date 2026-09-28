import { STORAGE_KEY, MIN_SPEED, MAX_SPEED, newState, videoKey, validSpeed, orderedVideos, makeItem, policyFor } from './core.js';

// Serialize events, including duplicate ended notifications and tabs closing mid-transition.
let serial = Promise.resolve();
function enqueue(fn) {
  const result = serial.then(fn);
  serial = result.catch(() => {});
  return result;
}

async function readState() {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return { ...newState(), ...saved, defaultSpeed: saved?.defaultSpeed ?? saved?.speed ?? 1 };
}

async function save(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  await chrome.action.setBadgeText({ text: state.status === 'running' ? '▶' : state.status === 'blocked' ? '!' : state.status === 'paused' ? 'Ⅱ' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#008caa' });
}

async function deliver(tabId, policy) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'APPLY', policy });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'APPLY', policy });
      return true;
    } catch { return false; } // A loading/discarded page receives its policy in HELLO.
  }
}

async function publish(state) {
  await save(state);
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.startsWith('https://www.bilibili.com/'));
  // Silence other players before starting the active player.
  await Promise.all(tabs.filter(tab => tab.id !== state.activeTabId).map(tab => deliver(tab.id, policyFor(state, tab.id))));
  if (state.activeTabId !== null) await deliver(state.activeTabId, policyFor(state, state.activeTabId));
}

async function activate(state, index) {
  state.token += 1;
  state.error = '';
  if (index < 0 || index >= state.items.length) {
    state.activeTabId = null;
    state.status = 'completed';
    await publish(state);
    return;
  }
  const item = state.items[index];
  state.activeTabId = item.id;
  state.status = 'running';
  for (let i = 0; i < state.items.length; i++) state.items[i].status = i < index ? 'done' : i === index ? 'playing' : 'waiting';
  await publish(state);
  try {
    const tab = await chrome.tabs.get(item.id);
    if (tab.discarded) await chrome.tabs.reload(item.id);
    if (state.followTab) await chrome.tabs.update(item.id, { active: true });
  } catch { /* onRemoved handles a concurrently closed tab. */ }
}

async function getLiveQueue(state) {
  const liveTabs = await chrome.tabs.query({ windowId: state.windowId });
  const liveIds = new Set(liveTabs.filter(tab => videoKey(tab.url)).map(tab => tab.id));
  state.items = state.items.filter(item => liveIds.has(item.id));
}

async function command(message, sender) {
  const state = await readState();
  if (message.type === 'GET_STATE') return { state };
  if (message.type === 'HELLO') {
    const tab = sender.tab;
    if (tab && videoKey(tab.url) && !state.items.some(item => item.id === tab.id) && state.autoAdd && tab.windowId === state.windowId && ['running', 'paused', 'blocked'].includes(state.status)) {
      state.items.push(makeItem(tab));
      await save(state);
    }
    return { policy: policyFor(state, tab?.id) };
  }
  if (message.type === 'SET_SPEED' || message.type === 'ADJUST_SPEED') {
    const tabId = sender.tab?.id ?? message.tabId ?? state.activeTabId;
    if (message.type === 'ADJUST_SPEED' && ![-1, 1].includes(message.direction)) throw new Error('无效的倍速调整方向');
    const current = tabId == null ? state.speed : policyFor(state, tabId).speed;
    state.speed = message.type === 'SET_SPEED' ? validSpeed(message.speed) : Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round((current + message.direction * 0.25) * 10000) / 10000));
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const key = videoKey(tab.url);
      if (key) state.speedOverrides[tab.id] = { key, speed: state.speed };
    }
    await publish(state);
  } else if (message.type === 'SET_DEFAULT_SPEED') {
    state.defaultSpeed = validSpeed(message.speed);
    state.speed = state.defaultSpeed;
    state.speedOverrides = {};
    await publish(state);
  } else if (message.type === 'SET_OPTIONS') {
    for (const key of ['autoAdd', 'followTab']) if (typeof message[key] === 'boolean') state[key] = message[key];
    await save(state);
  } else if (message.type === 'START') {
    const windowId = Number(message.windowId);
    if (!Number.isInteger(windowId)) throw new Error('未找到当前浏览器窗口');
    const items = orderedVideos(await chrome.tabs.query({ windowId }));
    if (!items.length) throw new Error('请先在当前窗口打开哔哩哔哩视频');
    // Release the previous queue if the user starts in another window.
    state.status = 'idle';
    await publish(state);
    state.items = items;
    state.windowId = windowId;
    await activate(state, 0);
  } else if (message.type === 'PAUSE') {
    if (['running', 'blocked'].includes(state.status)) {
      state.status = 'paused'; state.error = ''; state.token += 1;
      await publish(state);
    }
  } else if (message.type === 'RESUME') {
    await getLiveQueue(state);
    if (!state.items.length) throw new Error('队列中的视频已关闭，请重新开始');
    const index = state.items.findIndex(item => item.id === state.activeTabId);
    await activate(state, Math.max(index, 0));
  } else if (message.type === 'USER_RESUMED') {
    const item = state.items.find(item => item.id === sender.tab?.id);
    if (state.status === 'paused' && item?.id === state.activeTabId && item?.key === message.key && message.token === state.token) {
      await activate(state, state.items.indexOf(item));
    }
    return { state, policy: policyFor(state, sender.tab?.id) };
  } else if (message.type === 'STOP') {
    // Pause first; releasing management must not leave a video playing unexpectedly.
    state.status = 'paused'; state.token += 1;
    await publish(state);
    state.status = 'idle'; state.activeTabId = null; state.items = []; state.error = '';
    await publish(state);
  } else if (message.type === 'NEXT' || message.type === 'PLAY_ITEM') {
    const index = message.type === 'NEXT' ? state.items.findIndex(item => item.id === state.activeTabId) + 1 : state.items.findIndex(item => item.id === message.tabId);
    if (message.type === 'PLAY_ITEM' && index < 0) throw new Error('该视频已不在队列中');
    await activate(state, index);
  } else if (['ENDED', 'BLOCKED', 'PLAYING', 'USER_PAUSED'].includes(message.type)) {
    const item = state.items.find(item => item.id === sender.tab?.id);
    if (!item || item.id !== state.activeTabId || message.token !== state.token || message.key !== item.key || !['running', 'blocked'].includes(state.status)) return { state };
    if (message.type === 'ENDED') {
      item.status = 'done';
      await activate(state, state.items.indexOf(item) + 1);
    } else if (message.type === 'BLOCKED') {
      state.status = 'blocked'; state.error = message.reason === 'missing' ? '未检测到可播放的视频，请检查页面是否加载完成或需要登录。' : '浏览器暂未允许自动播放，请在视频页点击「继续播放」。';
      await save(state);
    } else if (message.type === 'USER_PAUSED') {
      state.status = 'paused'; state.token += 1;
      await publish(state);
    } else {
      state.status = 'running'; state.error = '';
      await save(state);
    }
  } else throw new Error('未知操作');
  return { state };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  enqueue(() => command(message, sender)).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});

async function removeTab(state, tabId) {
  const index = state.items.findIndex(item => item.id === tabId);
  if (index < 0) return;
  const wasActive = state.activeTabId === tabId;
  state.items.splice(index, 1);
  if (wasActive && ['running', 'blocked'].includes(state.status)) await activate(state, index);
  else {
    if (wasActive) state.activeTabId = state.items[index]?.id ?? state.items[index - 1]?.id ?? null;
    if (!state.items.length && state.status !== 'idle') state.status = 'completed';
    await publish(state);
  }
}

chrome.tabs.onRemoved.addListener(tabId => { enqueue(async () => {
  const state = await readState();
  delete state.speedOverrides[tabId];
  await save(state);
  await removeTab(state, tabId);
}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && !change.title && !change.status) return;
  enqueue(async () => {
    const state = await readState();
    const key = videoKey(tab.url);
    if (state.speedOverrides[tabId] && (change.status === 'loading' || state.speedOverrides[tabId].key !== key)) {
      delete state.speedOverrides[tabId];
      await save(state);
    }
    const item = state.items.find(item => item.id === tabId);
    if (item && !key) { await removeTab(state, tabId); return; }
    if (item) {
      const changedVideo = item.key !== key;
      Object.assign(item, { url: tab.url, key, title: makeItem(tab).title });
      if (changedVideo && tabId === state.activeTabId) state.token += 1;
      await save(state);
      if (changedVideo || change.status === 'complete') await deliver(tabId, policyFor(state, tabId));
    } else if (key && state.autoAdd && tab.windowId === state.windowId && ['running', 'paused', 'blocked'].includes(state.status)) {
      state.items.push(makeItem(tab));
      await save(state);
      await deliver(tabId, policyFor(state, tabId));
    } else if (key && (change.url || change.status === 'complete')) {
      await deliver(tabId, policyFor(state, tabId));
    }
  });
});

// A browser restart must not unexpectedly start playing saved tabs with recycled IDs.
chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    const state = await readState();
    Object.assign(state, { status: 'idle', items: [], activeTabId: null, windowId: null, error: '', token: state.token + 1, speed: state.defaultSpeed, speedOverrides: {} });
    await publish(state);
  });
});
