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
    speed: 1, defaultSpeed: 1, speedOverrides: {}, autoAdd: true, followTab: true,
    status: 'idle', windowId: null, activeTabId: null,
    token: 0, items: [], error: '',
  };
}

export function makeItem(tab) {
  return { id: tab.id, url: tab.url, key: videoKey(tab.url),
    title: (tab.title || '哔哩哔哩视频').replace(/_哔哩哔哩_bilibili$/, ''), status: 'waiting' };
}

export function orderedVideos(tabs) {
  return tabs.filter(tab => videoKey(tab.url)).sort((a, b) => a.index - b.index).map(makeItem);
}

export function policyFor(state, tabId) {
  const item = state.items.find(item => item.id === tabId);
  const managed = Boolean(item) && !['idle'].includes(state.status);
  const active = managed && state.activeTabId === tabId;
  return {
    speed: state.speedOverrides?.[tabId]?.speed ?? state.defaultSpeed ?? state.speed,
    mode: !managed ? 'free' : active && ['running', 'blocked'].includes(state.status) ? 'play' : active && state.status === 'paused' ? 'paused' : 'hold',
    token: state.token, key: item?.key || null,
    status: state.status,
  };
}
