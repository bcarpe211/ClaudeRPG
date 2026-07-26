'use strict';

// Character-page wardrobe. The server-rendered /sprite/skin image remains the
// source of truth; this mirrors its slot operations for immediate local preview.
(function () {
  const D = window.__DYE__;
  const colorMath = window.ClaudeRpgDyeColor;
  if (!D || !colorMath) return;

  const preview = document.getElementById('dye-preview');
  const wheel = document.getElementById('dye-wheel');
  const status = document.getElementById('dye-save-status');
  const activeLabel = document.getElementById('dye-active-label');
  const toneInput = document.getElementById('dye-tone');
  const toneValue = document.getElementById('dye-tone-value');
  const pageAvatar = document.getElementById('character-avatar');
  if (!preview || !wheel || !status || !activeLabel || !toneInput || !toneValue) return;

  const previewContext = preview.getContext('2d');
  const wheelContext = wheel.getContext('2d');
  if (!previewContext || !wheelContext) return;
  previewContext.imageSmoothingEnabled = false;
  wheelContext.imageSmoothingEnabled = false;

  const config = new Map(
    Object.entries(D.config).map(([slot, rule]) => [Number(slot), rule]),
  );
  const states = new Map();
  for (const [slot, rule] of config) states.set(slot, stateFromRule(rule));
  const slotmap = D.slotmap;
  const channelButtons = Array.from(document.querySelectorAll('.dye-chan:not(:disabled)'));
  let active = channelButtons.length > 0 ? Number(channelButtons[0].dataset.slot) : null;
  const revisionSession = Number.isSafeInteger(D.revisionSession) ? D.revisionSession : null;
  let nextRevision = Number.isSafeInteger(D.revisionSeed) ? D.revisionSeed : 1;
  let sourcePixels = null;

  function stateFromRule(rule) {
    if (!rule) return { recipe: 'wheel', hue: 0, sat: D.wheelSat, tone: 0 };
    if (rule.op === 'value') {
      const black = rule.lo === 0 && rule.hi === 0.32;
      return { recipe: 'wheel', hue: 0, sat: D.wheelSat, tone: black ? -1 : 1 };
    }
    const preset = Object.entries(D.presets).find(([, value]) => (
      value.hue === rule.hue && value.sat === rule.sat
    ));
    return {
      recipe: preset ? preset[0] : 'wheel',
      hue: rule.hue == null ? 0 : rule.hue,
      sat: rule.sat == null ? D.wheelSat : rule.sat,
      tone: rule.tone == null ? 0 : rule.tone,
    };
  }

  function stateFor(slot) {
    let state = states.get(slot);
    if (!state) {
      state = stateFromRule(null);
      states.set(slot, state);
    }
    return state;
  }

  function ruleFromState(state) {
    if (state.recipe !== 'wheel' && D.presets[state.recipe]) {
      return { ...D.presets[state.recipe], tone: state.tone };
    }
    return { op: 'colorize', hue: state.hue, sat: state.sat, tone: state.tone };
  }

  function toneDisplay(tone) {
    const value = Math.round(tone * 100);
    if (value === -100) return 'Black';
    if (value === 0) return 'Natural';
    if (value === 100) return 'White';
    return `${value > 0 ? '+' : ''}${value}%`;
  }

  // --- low-resolution pixel wheel ---
  const wheelRadius = wheel.width / 2;

  function currentHue() {
    return active == null ? 0 : stateFor(active).hue;
  }

  function drawWheel() {
    wheelContext.clearRect(0, 0, wheel.width, wheel.height);
    const selectedHue = currentHue();

    for (let y = 0; y < wheel.height; y += 1) {
      for (let x = 0; x < wheel.width; x += 1) {
        const dx = x + 0.5 - wheelRadius;
        const dy = y + 0.5 - wheelRadius;
        const radius = Math.hypot(dx, dy);
        if (radius < wheelRadius * 0.31 || radius > wheelRadius - 1) continue;

        if (radius < wheelRadius * 0.35 || radius > wheelRadius - 3) {
          wheelContext.fillStyle = '#160f20';
        } else {
          const raw = Math.atan2(dy, dx) * 180 / Math.PI;
          const hue = (Math.round(raw / 6) * 6 + 360) % 360;
          const color = colorMath.hsvToRgb(hue, D.wheelSat, 1);
          wheelContext.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
        }
        wheelContext.fillRect(x, y, 1, 1);
      }
    }

    const core = colorMath.hsvToRgb(selectedHue, D.wheelSat, 0.9);
    wheelContext.fillStyle = '#0c0912';
    wheelContext.fillRect(wheelRadius - 7, wheelRadius - 7, 14, 14);
    wheelContext.fillStyle = `rgb(${core[0]} ${core[1]} ${core[2]})`;
    wheelContext.fillRect(wheelRadius - 5, wheelRadius - 5, 10, 10);

    const angle = selectedHue * Math.PI / 180;
    const markerX = Math.round(wheelRadius + Math.cos(angle) * wheelRadius * 0.68);
    const markerY = Math.round(wheelRadius + Math.sin(angle) * wheelRadius * 0.68);
    wheelContext.fillStyle = '#0c0912';
    wheelContext.fillRect(markerX - 2, markerY - 2, 5, 5);
    wheelContext.fillStyle = '#fff8dc';
    wheelContext.fillRect(markerX - 1, markerY - 1, 3, 3);
  }

  // --- base sprite and per-slot preview ---
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = 24;
  spriteCanvas.height = 24;
  const spriteContext = spriteCanvas.getContext('2d');
  if (!spriteContext) return;
  spriteContext.imageSmoothingEnabled = false;

  const base = new Image();
  base.crossOrigin = 'anonymous';
  base.onload = function () {
    spriteContext.clearRect(0, 0, 24, 24);
    spriteContext.drawImage(base, 0, 0, 24, 24);
    sourcePixels = spriteContext.getImageData(0, 0, 24, 24);
    renderPreview();
  };
  base.onerror = function () {
    setStatus('Preview could not load', 'error');
  };
  base.src = D.base;

  function renderPreview() {
    if (!sourcePixels) return;
    const output = spriteContext.createImageData(24, 24);
    const source = sourcePixels.data;
    const pixels = output.data;
    const pixelCount = Math.min(slotmap.length, 24 * 24);

    for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
      const index = pixel * 4;
      pixels[index] = source[index];
      pixels[index + 1] = source[index + 1];
      pixels[index + 2] = source[index + 2];
      pixels[index + 3] = source[index + 3];
      if (pixel >= pixelCount || source[index + 3] === 0) continue;

      const rule = config.get(slotmap[pixel]);
      if (!rule) continue;
      const color = colorMath.applyRule(
        rule,
        source[index],
        source[index + 1],
        source[index + 2],
      );
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
    }

    spriteContext.putImageData(output, 0, 0);
    previewContext.clearRect(0, 0, preview.width, preview.height);
    previewContext.drawImage(spriteCanvas, 0, 0, preview.width, preview.height);
    if (pageAvatar) pageAvatar.src = preview.toDataURL('image/png');
  }

  // --- ordered, per-slot autosave ---
  const timers = new Map();
  const pendingSets = new Map();
  const queues = new Map();
  const latestOperations = new Map();
  const failedSlots = new Set();

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state || '';
  }

  function showSettledStatus() {
    if (timers.size > 0 || latestOperations.size > 0) return;
    if (failedSlots.size > 0) {
      const noun = failedSlots.size === 1 ? 'change needs' : 'changes need';
      setStatus(`${failedSlots.size} ${noun} saving — try again`, 'error');
      return;
    }
    setStatus('All changes saved', 'saved');
  }

  async function postSave(endpoint, body) {
    const response = await fetch(endpoint, {
      method: 'POST', body, credentials: 'same-origin', keepalive: true,
    });
    if (!response.ok) throw new Error(`Save failed (${response.status})`);
  }

  function enqueue(slot, operation) {
    setStatus('Saving…', 'saving');
    const previous = queues.get(slot);
    const request = previous
      ? previous.catch(function () {}).then(function () { return postSave(operation.endpoint, operation.body); })
      : postSave(operation.endpoint, operation.body);
    queues.set(slot, request);
    trackRequest(slot, request, operation, true);
  }

  function trackRequest(slot, request, operation, queued) {
    operation.pendingRequests = operation.pendingRequests || new Set();
    operation.pendingRequests.add(request);
    if (queued) {
      operation.queuedRequests = operation.queuedRequests || new Set();
      operation.queuedRequests.add(request);
    }
    operation.currentRequest = request;
    request.then(
      function () {
        completeRequest(slot, request, operation, true);
      },
      function () {
        completeRequest(slot, request, operation, false);
      },
    );
  }

  function completeRequest(slot, request, operation, succeeded) {
    operation.pendingRequests.delete(request);
    if (queues.get(slot) === request) queues.delete(slot);
    if (latestOperations.get(slot) !== operation) {
      showSettledStatus();
      return;
    }
    if (succeeded) operation.succeeded = true;
    if (operation.currentRequest !== request) {
      showSettledStatus();
      return;
    }
    if (operation.succeeded) {
      failedSlots.delete(slot);
      if (operation.queuedRequests?.has(queues.get(slot))) queues.delete(slot);
      latestOperations.delete(slot);
      renderChannels();
      showSettledStatus();
      return;
    }
    const fallback = operation.pendingRequests.values().next().value;
    if (fallback) {
      operation.currentRequest = fallback;
      setStatus('Saving…', 'saving');
      return;
    }
    failedSlots.add(slot);
    latestOperations.delete(slot);
    renderChannels();
    showSettledStatus();
  }

  function saveSet(slot, state) {
    const body = new URLSearchParams({ token: D.token, slot: String(slot) });
    const recipe = state.recipe;
    body.set('recipe', recipe);
    if (recipe === 'wheel') body.set('hue', String(state.hue));
    body.set('tone', String(state.tone));
    body.set('session', String(revisionSession));
    body.set('revision', String(nextRevision));
    const operation = { endpoint: '/character/dye/set', body, revision: nextRevision };
    nextRevision += 1;

    clearTimeout(timers.get(slot));
    pendingSets.set(slot, operation);
    latestOperations.set(slot, operation);
    setStatus('Change queued…', 'saving');
    timers.set(slot, setTimeout(function () {
      timers.delete(slot);
      const pending = pendingSets.get(slot);
      pendingSets.delete(slot);
      if (pending) enqueue(slot, pending);
    }, 120));
  }

  function saveClear(slot) {
    clearTimeout(timers.get(slot));
    timers.delete(slot);
    pendingSets.delete(slot);
    const body = new URLSearchParams({ token: D.token, slot: String(slot) });
    body.set('session', String(revisionSession));
    body.set('revision', String(nextRevision));
    const operation = { endpoint: '/character/dye/clear', body, revision: nextRevision };
    nextRevision += 1;
    latestOperations.set(slot, operation);
    enqueue(slot, operation);
  }

  // During pagehide, re-send every latest operation immediately. The server's
  // player+slot revision tombstone makes duplicates and packet reordering safe.
  function flushPendingSets() {
    for (const [slot] of pendingSets) {
      clearTimeout(timers.get(slot));
      timers.delete(slot);
    }
    pendingSets.clear();
    for (const [slot, operation] of latestOperations) {
      setStatus('Saving…', 'saving');
      const request = postSave(operation.endpoint, operation.body);
      trackRequest(slot, request, operation, false);
    }
  }
  window.addEventListener('beforeunload', flushPendingSets);
  window.addEventListener('pagehide', flushPendingSets);

  // --- server-rendered channels and material controls ---
  function ruleColor(rule) {
    if (!rule) return null;
    const color = colorMath.applyRule(rule, 230, 115, 46);
    return `rgb(${color[0]} ${color[1]} ${color[2]})`;
  }

  function renderChannels() {
    for (const button of channelButtons) {
      const slot = Number(button.dataset.slot);
      const rule = config.get(slot);
      const failed = failedSlots.has(slot);
      button.classList.toggle('active', slot === active);
      button.classList.toggle('configured', !!rule);
      button.classList.toggle('save-failed', failed);
      button.setAttribute('aria-pressed', String(slot === active));
      button.setAttribute('aria-invalid', String(failed));
      button.setAttribute('data-save-state', failed ? 'error' : '');
      const dot = button.querySelector('.dye-dot');
      if (dot) {
        const color = ruleColor(rule);
        dot.classList.toggle('is-default', !color);
        dot.style.background = color || '';
      }
    }
  }

  function renderControls() {
    const channel = D.channels.find((item) => item.slot === active);
    const state = active == null ? null : stateFor(active);
    const recipe = state ? state.recipe : 'none';
    const tone = state ? state.tone : 0;

    activeLabel.textContent = channel ? `${channel.label} selected` : 'Choose a material';
    wheel.classList.toggle('active', recipe === 'wheel');
    wheel.setAttribute('aria-valuenow', String(currentHue()));
    wheel.setAttribute('aria-valuetext', `${currentHue()} degrees`);
    toneInput.value = String(Math.round(tone * 100));
    toneValue.textContent = toneDisplay(tone);

    document.querySelectorAll('.dye-fin').forEach(function (button) {
      const selected = button.dataset.recipe === recipe;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    drawWheel();
    renderChannels();
  }

  function applyState(next) {
    if (active == null) return;
    states.set(active, next);
    config.set(active, ruleFromState(next));
    saveSet(active, next);
    renderPreview();
    renderControls();
  }

  function selectHue(hue) {
    const normalized = ((hue % 360) + 360) % 360;
    const state = stateFor(active);
    applyState({ ...state, recipe: 'wheel', hue: normalized, sat: D.wheelSat });
  }

  function selectTone(value) {
    const state = stateFor(active);
    applyState({ ...state, tone: Number(value) / 100 });
  }

  function selectRecipe(recipe) {
    if (recipe === 'none') {
      if (active == null) return;
      states.delete(active);
      config.delete(active);
      saveClear(active);
      renderPreview();
      renderControls();
      return;
    }
    const preset = D.presets[recipe];
    if (!preset) return;
    applyState({
      recipe,
      hue: preset.hue,
      sat: preset.sat,
      tone: preset.tone == null ? 0 : preset.tone,
    });
  }

  function pickHue(event) {
    const rect = wheel.getBoundingClientRect();
    const x = (event.clientX - rect.left) * wheel.width / rect.width;
    const y = (event.clientY - rect.top) * wheel.height / rect.height;
    const dx = x - wheelRadius;
    const dy = y - wheelRadius;
    const radius = Math.hypot(dx, dy);
    if (radius < wheelRadius * 0.28 || radius > wheelRadius) return;
    const raw = Math.atan2(dy, dx) * 180 / Math.PI;
    selectHue((Math.round(raw / 6) * 6 + 360) % 360);
  }

  let dragging = false;
  wheel.addEventListener('pointerdown', function (event) {
    dragging = true;
    wheel.setPointerCapture(event.pointerId);
    pickHue(event);
  });
  wheel.addEventListener('pointermove', function (event) {
    if (dragging) pickHue(event);
  });
  wheel.addEventListener('pointerup', function (event) {
    dragging = false;
    wheel.releasePointerCapture(event.pointerId);
  });
  wheel.addEventListener('pointercancel', function () { dragging = false; });
  wheel.addEventListener('keydown', function (event) {
    let hue = currentHue();
    if (event.key === 'Home') hue = 0;
    else if (event.key === 'End') hue = 354;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') hue -= 6;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') hue += 6;
    else return;
    event.preventDefault();
    selectHue(hue);
  });
  toneInput.addEventListener('input', function () { selectTone(toneInput.value); });
  for (const button of channelButtons) {
    button.addEventListener('click', function () {
      active = Number(button.dataset.slot);
      renderControls();
    });
  }
  document.querySelectorAll('.dye-fin').forEach(function (button) {
    button.addEventListener('click', function () { selectRecipe(button.dataset.recipe); });
  });

  renderControls();
  // Chromium may discard an off-screen canvas backing store during a responsive
  // viewport reflow. Redraw when the wheel actually enters view; the preview
  // already gets this later paint naturally from its image-load callback.
  if ('IntersectionObserver' in window) {
    const wheelObserver = new IntersectionObserver(function (entries) {
      if (entries.some((entry) => entry.isIntersecting)) drawWheel();
    });
    wheelObserver.observe(wheel);
  }
})();
