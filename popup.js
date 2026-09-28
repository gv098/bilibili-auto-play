import { STORAGE_KEY, orderedVideos, policyFor, videoKey } from './core.js';

const $ = id => document.getElementById(id);
let state;
let windowId;
let preview = [];
let speedTabId = null;
let commands = Promise.resolve();
const statusLabels = { idle: '待开始', running: '接力中', paused: '已暂停', blocked: '待继续', completed: '已完成' };

function error(text) { $('error').textContent = text || ''; $('error').hidden = !text; }
function render() {
  if (!state) return;
  const managed = state.status !== 'idle';
  const items = managed ? state.items : preview;
  const targetTabId = state.activeTabId ?? speedTabId;
  const currentSpeed = targetTabId == null ? state.speed : policyFor(state, targetTabId).speed;
  if (document.activeElement !== $('speed')) $('speed').value = String(currentSpeed);
  if (document.activeElement !== $('defaultSpeed')) $('defaultSpeed').value = String(state.defaultSpeed);
  document.querySelectorAll('[data-speed]').forEach(button => {
    const selected = Number(button.dataset.speed) === currentSpeed;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('stateBadge').textContent = statusLabels[state.status] || '待开始';
  $('stateBadge').classList.toggle('playing', state.status === 'running');
  $('queueCount').textContent = String(items.length);
  $('empty').hidden = Boolean(items.length);
  $('queue').replaceChildren(...items.map((item, index) => {
    const li = document.createElement('li');
    const current = managed && item.id === state.activeTabId;
    li.classList.toggle('current', current);
    const number = document.createElement('span');
    number.className = 'item-number'; number.textContent = current ? '▶' : item.status === 'done' ? '✓' : String(index + 1).padStart(2, '0');
    const title = document.createElement('button');
    title.className = 'item-title'; title.textContent = item.title; title.title = item.title;
    title.addEventListener('click', () => { if (managed) void run({ type: 'PLAY_ITEM', tabId: item.id }); else void chrome.tabs.update(item.id, { active: true }); });
    const status = document.createElement('span'); status.className = 'item-status';
    status.textContent = current ? statusLabels[state.status] : item.status === 'done' ? '已播' : '待播';
    li.append(number, title, status);
    return li;
  }));
  $('start').hidden = managed && state.status !== 'completed';
  $('start').innerHTML = state.status === 'completed' ? '<span>↻</span> 重新开始顺序播放' : '<span>▶</span> 开始顺序播放';
  $('transport').hidden = !managed;
  $('pause').disabled = state.status === 'completed';
  $('pause').textContent = ['paused', 'blocked'].includes(state.status) ? '▶ 继续队列' : 'Ⅱ 暂停队列';
  $('next').disabled = state.status === 'completed';
  $('restart').hidden = !managed || state.status === 'completed';
  $('autoAdd').checked = state.autoAdd;
  $('followTab').checked = state.followTab;
  const currentIndex = items.findIndex(item => item.id === state.activeTabId);
  $('progress').hidden = !managed;
  $('progress').textContent = state.status === 'completed' ? '全部播放完成，下一场放映见。' : `第 ${Math.max(0, currentIndex + 1)} / ${items.length} 条${state.windowId !== windowId ? ' · 队列位于另一个窗口' : ''}`;
  error(state.error);
}

function run(message) {
  commands = commands.then(() => execute(message));
  return commands;
}
async function execute(message) {
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '插件未响应，请重试');
    state = result.state;
    render();
    if (message.type === 'SET_DEFAULT_SPEED') $('defaultSaved').textContent = `已保存：新视频默认 ${state.defaultSpeed}×，当前页面也已应用`;
  } catch (err) { error(err.message); }
}
function setSpeed(speed) { return run({ type: 'SET_SPEED', speed }); }
$('speed').addEventListener('change', () => void setSpeed($('speed').value));
$('speed').addEventListener('keydown', event => { if (event.key === 'Enter') $('speed').blur(); });
$('slower').addEventListener('click', () => void run({ type: 'ADJUST_SPEED', direction: -1, tabId: state?.activeTabId ?? speedTabId }));
$('faster').addEventListener('click', () => void run({ type: 'ADJUST_SPEED', direction: 1, tabId: state?.activeTabId ?? speedTabId }));
$('saveDefault').addEventListener('click', () => void run({ type: 'SET_DEFAULT_SPEED', speed: $('defaultSpeed').value }));
$('defaultSpeed').addEventListener('keydown', event => { if (event.key === 'Enter') { $('saveDefault').click(); $('defaultSpeed').blur(); } });
document.querySelectorAll('[data-speed]').forEach(button => button.addEventListener('click', () => void setSpeed(button.dataset.speed)));
$('start').addEventListener('click', () => void run({ type: 'START', windowId }));
$('restart').addEventListener('click', () => void run({ type: 'START', windowId }));
$('pause').addEventListener('click', () => void run({ type: ['paused', 'blocked'].includes(state.status) ? 'RESUME' : 'PAUSE' }));
$('next').addEventListener('click', () => void run({ type: 'NEXT' }));
$('stop').addEventListener('click', () => void run({ type: 'STOP' }));
for (const key of ['autoAdd', 'followTab']) $(key).addEventListener('change', () => void run({ type: 'SET_OPTIONS', [key]: $(key).checked }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]?.newValue) { state = changes[STORAGE_KEY].newValue; render(); }
});
try {
  windowId = (await chrome.windows.getCurrent()).id;
  const tabs = await chrome.tabs.query({ windowId });
  speedTabId = tabs.find(tab => tab.active && videoKey(tab.url))?.id ?? null;
  preview = orderedVideos(tabs);
  await run({ type: 'GET_STATE' });
} catch (err) { error(err.message); }
