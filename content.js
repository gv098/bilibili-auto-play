(() => {
  if (globalThis.__biliRelayInstalled) return;
  globalThis.__biliRelayInstalled = true;

  let policy = { mode: 'loading', speed: 1, token: 0, revision: -1, key: null };
  let currentVideo = null;
  let panel, label, resume, speedInput;
  let endedToken = null;
  let endRequest = null;
  let missingTimer;
  const expectedPauses = new WeakSet();
  let applyingPlay = null;
  let resumeRequest = null;
  let pendingSpeed = null;
  let navigating = false;
  let playerGesture = null;
  let selectionRequest = null;
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
  function changeSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed < 0.0625 || speed > 16) {
      speedInput.value = String(policy.speed);
      show('倍速范围 0.0625～16');
      return;
    }
    const previousSpeed = policy.speed;
    const request = { speed };
    pendingSpeed = request;
    policy = { ...policy, speed };
    if (currentVideo) setSpeed(currentVideo);
    speedInput.value = String(speed);
    updatePanel();
    // Apply locally in the click handler; persistence and other tabs follow asynchronously.
    void send('SET_SPEED', { speed }).then(result => {
      if (pendingSpeed !== request) return;
      pendingSpeed = null;
      if (result?.ok) {
        if (result.policy) apply(result.policy);
      } else {
        policy = { ...policy, speed: previousSpeed };
        if (currentVideo) setSpeed(currentVideo);
        updatePanel();
        show('同步失败，请刷新页面后重试');
      }
    });
  }
  function show(text, canResume = false) {
    if (!label) return;
    label.textContent = text;
    label.title = text;
    label.setAttribute('aria-label', text);
    label.dataset.warning = String(canResume);
    resume.hidden = !canResume;
    resume.textContent = policy.mode === 'hold' ? '播放此条' : '继续播放';
  }
  function updatePanel() {
    if (!panel) return;
    panel.hidden = !key();
    panel.dataset.mode = policy.mode;
    for (const [id, allowed] of [['previous', policy.canPrevious], ['next', policy.canNext]]) {
      const button = panel.shadowRoot.getElementById(id);
      button.disabled = navigating || !allowed;
      button.title = policy.mode === 'free' || policy.mode === 'loading' ? '请先在扩展弹窗开始顺序播放' : id === 'previous' ? '接力队列中的前一个视频' : '接力队列中的后一个视频';
    }
    if (panel.shadowRoot.activeElement !== speedInput) speedInput.value = String(policy.speed);
    panel.shadowRoot.querySelectorAll('[data-speed]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === policy.speed));
    });
    if (policy.mode === 'paused') show('队列已暂停', true);
    else if (policy.mode === 'advancing') show('本条播放完成，正在接力');
    else if (policy.mode === 'transition') show('正在打开下一分 P / 合集视频');
    else if (policy.mode === 'sequence-error') show('接力未完成，点击重试', true);
    else if (policy.mode === 'hold') show(policy.status === 'paused' ? '队列已暂停，可播放此条' : policy.status === 'completed' ? '队列播放完成，可重播此条' : '等待接力，也可手动播放此条', true);
    else if (policy.mode === 'selecting') show('正在切换到此条');
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

  async function navigateQueue(type) {
    if (navigating || !(type === 'PREVIOUS' ? policy.canPrevious : policy.canNext)) return;
    navigating = true;
    updatePanel();
    let timer;
    try {
      const result = await Promise.race([
        send(type),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); }),
      ]);
      if (result?.ok && result.policy) apply(result.policy);
      if (!result?.ok) show('切换失败，请重试');
    } finally {
      clearTimeout(timer);
      navigating = false;
      for (const [id, allowed] of [['previous', policy.canPrevious], ['next', policy.canNext]]) panel.shadowRoot.getElementById(id).disabled = !allowed;
    }
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

  async function selectVideo(video) {
    if (policy.mode !== 'hold' || policy.key !== key() || video !== currentVideo || selectionRequest) return;
    const request = { token: policy.token, key: key() };
    selectionRequest = request;
    playerGesture = null;
    policy = { ...policy, mode: 'selecting' };
    // The worker pauses the old owner before allowing this player to start.
    pause(video);
    updatePanel();
    let timer;
    try {
      const result = await Promise.race([
        send('USER_SELECTED', request),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); }),
      ]);
      if (result?.ok && result.policy) apply(result.policy);
      else if (policy.token === request.token && ['selecting', 'hold'].includes(policy.mode)) {
        apply({ ...policy, mode: 'hold' });
        show('切换失败，请点击播放此条重试', true);
      }
    } finally { clearTimeout(timer); selectionRequest = null; }
  }

  function manualPlay(video) {
    if (policy.mode !== 'hold' || policy.key !== key() || video !== currentVideo || !playerGesture || playerGesture.video !== video || playerGesture.key !== key() || playerGesture.token !== policy.token || Date.now() > playerGesture.expires) return false;
    playerGesture = null;
    void selectVideo(video);
    return true;
  }

  // A media play event is trusted even for autoplay. Require a recent real player
  // interaction so background autoplay cannot take ownership of the queue.
  for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, event => {
    if (!event.isTrusted || policy.mode !== 'hold' || !currentVideo) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('#bili-relay-panel, input, textarea, select, [contenteditable="true"]')) return;
    const inPlayer = target.closest('video, bwp-video, #bilibili-player, #bilibiliPlayer, .bpx-player-container');
    if (type === 'keydown') {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || !['Space', 'KeyK', 'Enter'].includes(event.code) || (!inPlayer && event.code === 'Enter')) return;
    } else if (!inPlayer || (type === 'pointerdown' && event.button !== 0)) return;
    playerGesture = { video: currentVideo, key: key(), token: policy.token, expires: Date.now() + 1500 };
  }, true);

  function applyToVideo(video, shouldStart = false) {
    setSpeed(video);
    if (['hold', 'paused', 'resuming', 'selecting', 'play', 'advancing', 'transition', 'sequence-error'].includes(policy.mode)) {
      if (!originalLoops.has(video)) originalLoops.set(video, video.loop);
      video.loop = false;
    } else if (policy.mode === 'free' && originalLoops.has(video)) {
      video.loop = originalLoops.get(video);
      originalLoops.delete(video);
    }
    if (['hold', 'paused', 'selecting', 'advancing', 'transition', 'sequence-error'].includes(policy.mode)) pause(video);
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
        if (manualPlay(video)) return;
        if (['hold', 'selecting', 'advancing', 'transition', 'sequence-error'].includes(policy.mode)) { pause(video); return; }
        if (policy.mode === 'play' && policy.key === key()) { show('正在接力播放'); void send('PLAYING'); }
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

  async function finishVideo() {
    if (endRequest || policy.key !== key()) return;
    const request = { token: policy.token, key: key() };
    endRequest = request;
    endedToken = request.token;
    policy = { ...policy, mode: 'advancing' };
    updatePanel();
    let timer;
    const result = await Promise.race([
      send('ENDED', request),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); }),
    ]);
    clearTimeout(timer);
    if (endRequest !== request) return;
    endRequest = null;
    if (result?.ok && result.policy) apply(result.policy);
    else if (policy.token === request.token && policy.mode === 'advancing') {
      policy = { ...policy, mode: 'sequence-error' };
      updatePanel();
    }
  }

  // Capture before the site's own ended handlers can start a recommendation or next part.
  document.addEventListener('ended', event => {
    if (!isVideo(event.target) || event.target !== currentVideo || policy.key !== key() || !['play', 'advancing', 'transition', 'sequence-error'].includes(policy.mode)) return;
    event.stopImmediatePropagation();
    if (policy.mode !== 'play') return;
    if (endedToken === policy.token) return;
    void finishVideo();
  }, true);
  document.addEventListener('play', event => {
    if (!isVideo(event.target)) return;
    if (policy.mode === 'paused') resumePausedVideo(event.target);
    else if (manualPlay(event.target)) return;
    else if (['hold', 'selecting', 'advancing', 'transition', 'sequence-error'].includes(policy.mode)) pause(event.target);
  }, true);

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.id = 'bili-relay-panel';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{position:fixed;right:18px;bottom:24px;width:max-content;max-width:calc(100vw - 36px);z-index:2147483646;font:12px/1.4 system-ui,sans-serif;color:#e9f2f7} :host([hidden]){display:none}
      *{box-sizing:border-box}.box{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:6px 8px;border:1px solid #ffffff25;border-radius:10px;background:#122431ed;box-shadow:0 4px 18px #0003}
      button{display:inline-flex;align-items:center;justify-content:center;height:26px;border:0;border-radius:5px;background:#68dce9;color:#10252e;padding:0 5px;font:inherit;cursor:pointer}button:disabled{opacity:.3;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #b5f5ff;outline-offset:2px}[hidden]{display:none}
      .box .grip{width:14px;padding:0;background:transparent;color:#8badb7;font-size:16px;cursor:grab;touch-action:none;user-select:none}:host([dragging]) .grip{cursor:grabbing}
      #status{width:8px;height:8px;overflow:hidden;font-size:0;border-radius:50%;background:#8badb7;flex:none}:host([data-mode="play"]) #status{background:#68dce9}#status[data-warning="true"]{background:#ffc46b}
      .transport,.speed-controls{display:flex;align-items:center;gap:2px}.transport{gap:3px}.arrow{width:26px;font-size:17px;background:#ffffff12;color:#c7f5fa}
      .preset{min-width:27px;background:#ffffff0c;color:#a4e9f0;border:1px solid #68dce940}.preset[aria-pressed="true"]{background:#68dce9;color:#10252e}.step{width:23px;font-size:17px;background:transparent;color:#a4e9f0}
      input{width:43px;height:26px;background:#ffffff0c;color:white;border:1px solid #ffffff25;border-radius:5px;padding:0 2px;font:inherit;text-align:center;appearance:textfield}input:focus{width:58px}input::-webkit-inner-spin-button,input::-webkit-outer-spin-button{appearance:none;margin:0}
      .close{background:transparent;color:#a6bcc7;padding:0 2px;font-size:11px}.mini{display:none}:host([collapsed]) .detail{display:none}:host([collapsed]) .mini{display:inline-flex}
    </style><div class="box"><button class="grip" aria-label="移动 Bili 接力浮窗" title="按住拖动 · 方向键移动 · 双击恢复默认位置">⠿</button><span class="detail" id="status" role="status">连接中</span><span class="detail transport"><button id="previous" class="arrow" aria-label="前一个视频" disabled>←</button><button id="next" class="arrow" aria-label="后一个视频" disabled>→</button></span><span class="detail speed-controls"><button class="preset" data-speed="2" aria-pressed="false" title="直接切换为 2 倍速">2×</button><button class="preset" data-speed="3" aria-pressed="false" title="直接切换为 3 倍速">3×</button><button id="slower" class="step" aria-label="减慢 0.25 倍" title="减慢 0.25 倍">−</button><input aria-label="视频倍速" title="自定义倍速" type="number" min="0.0625" max="16" step="any" value="1"><button id="faster" class="step" aria-label="加快 0.25 倍" title="加快 0.25 倍">+</button></span><button id="resume" hidden>继续播放</button><button class="close detail" id="collapse" title="收起">收起</button><button class="close mini" id="expand" title="展开">展开</button></div>`;
    label = shadow.getElementById('status');
    resume = shadow.getElementById('resume');
    speedInput = shadow.querySelector('input');
    shadow.getElementById('previous').addEventListener('click', () => void navigateQueue('PREVIOUS'));
    shadow.getElementById('next').addEventListener('click', () => void navigateQueue('NEXT'));
    resume.addEventListener('click', () => {
      if (policy.mode === 'sequence-error') { void finishVideo(); return; }
      if (!currentVideo) return;
      if (policy.mode === 'hold') void selectVideo(currentVideo);
      else if (policy.mode === 'paused') resumePausedVideo(currentVideo, true);
      else void play(currentVideo, true);
    });
    shadow.querySelectorAll('[data-speed]').forEach(button => {
      button.addEventListener('click', () => changeSpeed(button.dataset.speed));
    });
    for (const [id, direction] of [['slower', -1], ['faster', 1]]) {
      shadow.getElementById(id).addEventListener('click', () => changeSpeed(Math.min(16, Math.max(0.0625, Math.round((policy.speed + direction * 0.25) * 10000) / 10000))));
    }
    speedInput.addEventListener('change', () => changeSpeed(speedInput.value));
    shadow.getElementById('collapse').addEventListener('click', () => panel.setAttribute('collapsed', ''));
    shadow.getElementById('expand').addEventListener('click', () => panel.removeAttribute('collapsed'));
    document.body.appendChild(panel);
    updatePanel();
    enableDragging(shadow.querySelector('.grip'));
  }

  function apply(next) {
    if ((next.revision ?? 0) < (policy.revision ?? 0)) return;
    // Speed/settings broadcasts during metadata loading must not replay an ended video.
    if (endRequest && next.token === endRequest.token && next.key === endRequest.key && next.mode === 'play') next = { ...next, mode: 'advancing' };
    if (endRequest && (next.token !== endRequest.token || next.key !== endRequest.key || next.mode === 'paused' || next.mode === 'hold' || next.mode === 'free')) endRequest = null;
    const shouldStart = next.mode === 'play' && (policy.mode !== 'play' || next.token !== policy.token);
    policy = pendingSpeed ? { ...next, speed: pendingSpeed.speed } : next;
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
    if (message.type === 'DESCRIBE_VIDEO') { respond({ url: location.href, title: document.title }); return; }
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
