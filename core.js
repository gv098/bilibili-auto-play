export const STORAGE_KEY = 'biliQueueState';
export const MIN_SPEED = 0.0625;
export const MAX_SPEED = 16;

export function videoKey(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'www.bilibili.com') return null;
    const match = url.pathname.match(/^\/video\/((?:BV[\w]+|av\d+))\/?$/i);
    if (!match) return null;
    return `${match[1]}?p=${url.searchParams.get('p') || '1'}`;
  } catch { return null; }
}

export function validSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new Error('请输入 0.0625～16 之间的倍速');
  }
  return speed;
}

export function newState() {
  return {
    speed: 1, defaultSpeed: 1, speedOverrides: {}, autoAdd: true, followTab: true, completeSeries: true,
    status: 'idle', windowId: null, activeTabId: null,
    token: 0, revision: 0, items: [], error: '', errorKind: '',
  };
}

export function makeItem(tab) {
  return { id: tab.id, url: tab.url, key: videoKey(tab.url),
    title: (tab.title || '哔哩哔哩视频').replace(/_哔哩哔哩_bilibili$/, ''), status: 'waiting' };
}

export function orderedVideos(tabs, previous = []) {
  const known = new Map(previous.map(item => [item.id, item]));
  return tabs.map(tab => ({ ...tab,
    url: tab.url || (videoKey(tab.pendingUrl) ? tab.pendingUrl : known.get(tab.id)?.url),
    title: tab.title || known.get(tab.id)?.title,
  })).filter(tab => videoKey(tab.url)).sort((a, b) => a.index - b.index).map(makeItem);
}

export async function discoverVideos(tabsApi, windowId, previous = []) {
  const tabs = await tabsApi.query({ windowId });
  const knownIds = new Set(previous.map(item => item.id));
  await Promise.all(tabs.map(async tab => {
    if (tab.url || knownIds.has(tab.id) || videoKey(tab.pendingUrl)) return;
    let timer;
    try {
      // Existing content scripts can identify their page if the tabs API omits URL.
      const description = await Promise.race([
        tabsApi.sendMessage(tab.id, { type: 'DESCRIBE_VIDEO' }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 400); }),
      ]);
      if (videoKey(description?.url)) Object.assign(tab, { url: description.url, title: tab.title || description.title });
    } catch { /* No content script on this tab; retain any last known metadata. */ }
    finally { clearTimeout(timer); }
  }));
  return { tabs, videos: orderedVideos(tabs, previous) };
}

export function policyFor(state, tabId) {
  const item = state.items.find(item => item.id === tabId);
  const managed = Boolean(item) && !['idle'].includes(state.status);
  const active = managed && state.activeTabId === tabId;
  const activeIndex = state.items.findIndex(item => item.id === state.activeTabId);
  return {
    speed: state.speedOverrides?.[tabId]?.speed ?? state.defaultSpeed ?? state.speed,
    mode: !managed ? 'free' : active && state.status === 'paused' ? 'paused' : active && item.pendingUrl ? 'transition' : active && state.errorKind === 'sequence' ? 'sequence-error' : active && ['running', 'blocked'].includes(state.status) ? 'play' : 'hold',
    token: state.token, key: item?.key || null,
    revision: state.revision ?? 0,
    status: state.status,
    canPrevious: managed && activeIndex > 0,
    canNext: managed && activeIndex >= 0 && activeIndex < state.items.length - 1,
  };
}
