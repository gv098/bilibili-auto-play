(() => {
  if (globalThis.__biliRelayInstalled) return;
  globalThis.__biliRelayInstalled = true;

  let policy = { mode: 'loading', speed: 1, token: 0, key: null };
  let currentVideo = null;
  let panel, label, resume, speedInput;
  let endedToken = null;
  let missingTimer;
  const expectedPauses = new WeakSet();
  let applyingPlay = null;
  let resumeRequest = null;
  const attached = new WeakSet();
  const originalLoops = new WeakMap();
  const positionKey = 'biliRelayPanelPosition';
  let panelPosition = null;
  let positionTouched = false;

  function placePanel() {
    if (!panel || panel.hidden || !panelPosition) return;
    const rect = panel.getBoundingClientRect();
    const x = Math.max(8, Math.min(panelPosition.x, innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(panelPosition.y, innerHeight - rect.height - 8));
    Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  }

  function enableDragging(handle) {
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      positionTouched = true;
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.x, y: rect.y, moved: false };
      handle.setPointerCapture(event.pointerId);
      panel.setAttribute('dragging', '');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      panelPosition = { x: drag.x + dx, y: drag.y + dy };
      placePanel();
    });
    const savePosition = () => {
      const rect = panel.getBoundingClientRect();
      panelPosition = { x: rect.x, y: rect.y };
      void chrome.storage.local.set({ [positionKey]: panelPosition }).catch(() => {});
    };
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.moved) savePosition();
      drag = null;
      panel.removeAttribute('dragging');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
    handle.addEventListener('keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      positionTouched = true;
      const rect = panel.getBoundingClientRect();
      const step = event.shiftKey ? 1 : 10;
      panelPosition = { x: rect.x + direction[0] * step, y: rect.y + direction[1] * step };
      placePanel();
      savePosition();
    });
    handle.addEventListener('dblclick', () => {
      positionTouched = true;
      panelPosition = null;
      for (const name of ['left', 'top', 'right', 'bottom']) panel.style.removeProperty(name);
      void chrome.storage.local.remove(positionKey).catch(() => {});
    });
    void chrome.storage.local.get(positionKey).then(saved => {
      const position = saved[positionKey];
      if (!positionTouched && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        panelPosition = position;
        placePanel();
      }
    }).catch(() => {});
    window.addEventListener('resize', placePanel);
    new ResizeObserver(placePanel).observe(panel);
  }

  function key() {
    const match = location.pathname.match(/^\/video\/((?:BV[\w]+|av\d+))\/?$/i);
    return match ? `${match[1]}?p=${new URL(location.href).searchParams.get('p') || '1'}` : null;
  }
  function send(type, extra = {}) {
    return chrome.runtime.sendMessage({ type, token: policy.token, key: key(), ...extra }).catch(() => null);
  }
  function isVideo(node) {
    return node && /^(VIDEO|BWP-VIDEO)$/.test(node.tagName) && typeof node.play === 'function';
  }
  function pause(video) {
    if (!video.paused) { expectedPauses.add(video); video.pause(); }
  }
  function setSpeed(video) {
    try { if (video.playbackRate !== policy.speed) video.playbackRate = policy.speed; } catch { /* Unsupported player implementation. */ }
  }
  function show(text, canResume = false) {
    if (!label) return;
    label.textContent = text;
    resume.hidden = !canResume;
  }
  function updatePanel() {
    if (!panel) return;
    panel.hidden = !key();
    if (panel.shadowRoot.activeElement !== speedInput) speedInput.value = String(policy.speed);
    panel.shadowRoot.querySelectorAll('[data-speed]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === policy.speed));
    });
    if (policy.mode === 'paused') show('队列已暂停', true);
    else if (policy.mode === 'hold') show(policy.status === 'paused' ? '等待当前视频继续' : policy.status === 'completed' ? '队列播放完成' : '等待接力播放');
    else if (policy.mode === 'free') show('自由播放');
    else if (policy.mode === 'play') show(policy.status === 'blocked' ? '点击一次，继续接力' : '正在接力播放', policy.status === 'blocked');
  }
  async function play(video, userGesture = false) {
    if (policy.mode !== 'play' || policy.key !== key()) return;
    if (applyingPlay?.video === video && applyingPlay.token === policy.token) return;
    const token = policy.token;
    const attempt = { video, token };
    applyingPlay = attempt;
    try {
      if (video.ended) video.currentTime = 0;
      await video.play();
      if (token === policy.token && policy.mode === 'play') show('正在接力播放');
    } catch (error) {
      if (token !== policy.token || policy.mode !== 'play' || error.name === 'AbortError') return;
      show(userGesture ? '请点击播放器播放按钮' : '点击一次，继续接力', true);
      await send('BLOCKED');
    } finally { if (applyingPlay === attempt) applyingPlay = null; }
  }

  function resumePausedVideo(video, fromButton = false) {
    if (policy.mode !== 'paused' || policy.key !== key() || video !== currentVideo || resumeRequest) return;
    const previous = policy;
    policy = { ...policy, mode: 'resuming' };
    show('正在继续播放');
    // Keep the native click's user activation while the worker confirms the queue state.
    if (fromButton) void video.play().catch(() => {});
    resumeRequest = send('USER_RESUMED').then(result => {
      if (result?.ok && result.policy) {
        if (result.policy.token >= policy.token) apply(result.policy);
      } else if (policy.mode === 'resuming' && policy.token === previous.token) {
        apply(previous);
        show('恢复失败，请刷新页面后重试', true);
      }
    }).finally(() => { resumeRequest = null; });
  }

  function applyToVideo(video, shouldStart = false) {
    setSpeed(video);
    if (['hold', 'paused', 'resuming', 'play'].includes(policy.mode)) {
      if (!originalLoops.has(video)) originalLoops.set(video, video.loop);
      video.loop = false;
    } else if (policy.mode === 'free' && originalLoops.has(video)) {
      video.loop = originalLoops.get(video);
      originalLoops.delete(video);
    }
    if (policy.mode === 'hold' || policy.mode === 'paused') pause(video);
    if (policy.mode === 'play' && shouldStart) void play(video);
  }
  function scan() {
    const videos = [...document.querySelectorAll('video, bwp-video')].filter(isVideo);
    const video = videos.find(video => video.closest('#bilibili-player, #bilibiliPlayer, .bpx-player-container')) || videos[0];
    if (!video) { currentVideo = null; return; }
    const changed = currentVideo !== video;
    currentVideo = video;
    clearTimeout(missingTimer);
    if (!attached.has(video)) {
      attached.add(video);
      video.addEventListener('ratechange', () => setSpeed(video));
      video.addEventListener('loadedmetadata', () => applyToVideo(video, true));
      video.addEventListener('playing', () => {
        if (policy.mode === 'paused') { resumePausedVideo(video); return; }
        if (policy.mode === 'hold') { pause(video); return; }
        if (policy.mode === 'play') { show('正在接力播放'); void send('PLAYING'); }
      });
      video.addEventListener('pause', () => {
        if (expectedPauses.delete(video)) return;
        if (video !== currentVideo || !video.paused || video.ended || video.seeking || policy.mode !== 'play') return;
        // A genuine native-player pause should pause the queue as well.
        void send('USER_PAUSED');
      });
    }
    applyToVideo(video, changed);
  }

  // Capture before the site's own ended handlers can start a recommendation or next part.
  document.addEventListener('ended', event => {
    if (!isVideo(event.target) || event.target !== currentVideo || policy.mode !== 'play' || policy.key !== key()) return;
    event.stopImmediatePropagation();
    if (endedToken === policy.token) return;
    endedToken = policy.token;
    void send('ENDED');
    policy = { ...policy, mode: 'hold' };
    show('本条播放完成，正在接力');
  }, true);
  document.addEventListener('play', event => {
    if (!isVideo(event.target)) return;
    if (policy.mode === 'paused') resumePausedVideo(event.target);
    else if (policy.mode === 'hold') pause(event.target);
  }, true);

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.id = 'bili-relay-panel';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{position:fixed;right:18px;bottom:24px;width:max-content;max-width:calc(100vw - 36px);z-index:2147483646;font:12px/1.5 system-ui,sans-serif;color:#e9f2f7} :host([hidden]){display:none}
      .box{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 13px;border:1px solid #ffffff25;border-radius:14px;background:#122431ed;box-shadow:0 6px 25px #0003}
      .box .brand{color:#67deed;font-weight:700;background:transparent;padding:0;cursor:grab;touch-action:none;user-select:none;white-space:nowrap}.brand::before{content:'⠿';margin-right:5px;color:#8badb7}:host([dragging]) .brand{cursor:grabbing} input{width:56px;background:#ffffff10;color:white;border:1px solid #ffffff30;border-radius:6px;padding:4px;font:inherit}
      button{border:0;border-radius:6px;background:#68dce9;color:#10252e;padding:5px 8px;font:inherit;cursor:pointer} [hidden]{display:none}
      .speed-controls{display:flex;align-items:center;gap:6px}.preset{background:#ffffff12;color:#a4e9f0;border:1px solid #68dce950;padding:3px 7px}.preset[aria-pressed="true"]{background:#68dce9;color:#10252e}.step{font-size:17px;min-width:26px;padding:1px 5px}.close{background:transparent;color:#a6bcc7;padding:0 2px;font-size:12px} .mini{display:none} :host([collapsed]) .detail{display:none} :host([collapsed]) .mini{display:block}
    </style><div class="box"><button class="brand" aria-label="移动 Bili 接力浮窗" title="按住拖动 · 方向键移动 · 双击恢复默认位置">Bili 接力</button><span class="detail" id="status">连接中</span><span class="detail speed-controls"><button class="preset" data-speed="2" aria-pressed="false" title="直接切换为 2 倍速">2×</button><button class="preset" data-speed="3" aria-pressed="false" title="直接切换为 3 倍速">3×</button><button id="slower" class="step" aria-label="减慢 0.25 倍" title="减慢 0.25 倍">−</button><input aria-label="视频倍速" type="number" min="0.0625" max="16" step="any" value="1"> ×<button id="faster" class="step" aria-label="加快 0.25 倍" title="加快 0.25 倍">+</button></span><button id="resume" hidden>继续播放</button><button class="close detail" id="collapse" title="收起">收起</button><button class="mini" id="expand" title="展开">展开</button></div>`;
    label = shadow.getElementById('status');
    resume = shadow.getElementById('resume');
    speedInput = shadow.querySelector('input');
    resume.addEventListener('click', () => {
      if (!currentVideo) return;
      if (policy.mode === 'paused') resumePausedVideo(currentVideo, true);
      else void play(currentVideo, true);
    });
    shadow.querySelectorAll('[data-speed]').forEach(button => {
      button.addEventListener('click', async () => {
        const result = await send('SET_SPEED', { speed: Number(button.dataset.speed) });
        if (!result?.ok) show('设置失败，请刷新页面');
      });
    });
    for (const [id, direction] of [['slower', -1], ['faster', 1]]) {
      shadow.getElementById(id).addEventListener('click', async () => {
        const result = await send('ADJUST_SPEED', { direction });
        if (!result?.ok) show('设置失败，请刷新页面');
      });
    }
    speedInput.addEventListener('change', async () => {
      const speed = Number(speedInput.value);
      if (!Number.isFinite(speed) || speed < 0.0625 || speed > 16) { speedInput.value = String(policy.speed); show('倍速范围 0.0625～16'); return; }
      const result = await send('SET_SPEED', { speed });
      if (!result?.ok) show('设置失败，请刷新页面');
    });
    shadow.getElementById('collapse').addEventListener('click', () => panel.setAttribute('collapsed', ''));
    shadow.getElementById('expand').addEventListener('click', () => panel.removeAttribute('collapsed'));
    document.body.appendChild(panel);
    updatePanel();
    enableDragging(shadow.querySelector('.brand'));
  }

  function apply(next) {
    const shouldStart = next.mode === 'play' && (policy.mode !== 'play' || next.token !== policy.token);
    policy = next;
    createPanel();
    updatePanel();
    scan();
    if (currentVideo) applyToVideo(currentVideo, shouldStart);
    else if (policy.mode === 'play') {
      clearTimeout(missingTimer);
      missingTimer = setTimeout(() => { if (!currentVideo && policy.mode === 'play') { show('请检查视频加载状态'); void send('BLOCKED', { reason: 'missing' }); } }, 20000);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'APPLY') { apply(message.policy); respond({ ok: true }); }
  });
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; createPanel(); scan(); if (panel) panel.hidden = !key(); }, 100);
  }).observe(document, { childList: true, subtree: true });
  void send('HELLO').then(result => { if (result?.policy && policy.mode === 'loading') apply(result.policy); });
})();
