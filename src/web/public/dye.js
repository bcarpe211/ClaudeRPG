'use strict';

// Character-page wardrobe. The server-rendered /sprite/skin image remains the
// source of truth; this mirrors its slot operations for immediate local preview.
(function () {
  const D = window.__DYE__;
  if (!D) return;

  const preview = document.getElementById('dye-preview');
  const wheel = document.getElementById('dye-wheel');
  const channelWrap = document.getElementById('dye-channels');
  const status = document.getElementById('dye-save-status');
  const activeLabel = document.getElementById('dye-active-label');
  const pageAvatar = document.getElementById('character-avatar');
  if (!preview || !wheel || !channelWrap || !status || !activeLabel) return;

  const previewContext = preview.getContext('2d');
  const wheelContext = wheel.getContext('2d');
  if (!previewContext || !wheelContext) return;
  previewContext.imageSmoothingEnabled = false;
  wheelContext.imageSmoothingEnabled = false;

  // --- color operations: mirrors src/domain/spritetint.ts exactly ---
  function hsvToRgb(hueDegrees, saturation, value) {
    const hue = (((hueDegrees % 360) + 360) % 360) / 360;
    const index = Math.floor(hue * 6);
    const fraction = hue * 6 - index;
    const p = value * (1 - saturation);
    const q = value * (1 - fraction * saturation);
    const t = value * (1 - (1 - fraction) * saturation);
    const channels = [
      [value, t, p],
      [q, value, p],
      [p, value, t],
      [p, q, value],
      [t, p, value],
      [value, p, q],
    ][index % 6];
    return channels.map((channel) => Math.round(channel * 255));
  }

  function applyRule(rule, red, green, blue) {
    const value = Math.max(red, green, blue) / 255;
    if (rule.op === 'value') {
      const lo = rule.lo == null ? 0 : rule.lo;
      const hi = rule.hi == null ? 1 : rule.hi;
      const channel = Math.round((lo + value * (hi - lo)) * 255);
      return [channel, channel, channel];
    }
    if (rule.op === 'colorize') {
      return hsvToRgb(
        rule.hue == null ? 0 : rule.hue,
        rule.sat == null ? 0.6 : rule.sat,
        value,
      );
    }
    const min = Math.min(red, green, blue) / 255;
    const saturation = value === 0 ? 0 : (value - min) / value;
    return hsvToRgb(rule.hue == null ? 0 : rule.hue, saturation, value);
  }

  const config = new Map(
    Object.entries(D.config).map(([slot, rule]) => [Number(slot), rule]),
  );
  const hues = new Map();
  for (const [slot, rule] of config) {
    if (rule.hue != null) hues.set(slot, rule.hue);
  }
  const slotmap = D.slotmap;
  let active = D.channels.length > 0 ? D.channels[0].slot : null;
  let sourcePixels = null;

  // --- low-resolution pixel wheel ---
  const wheelRadius = wheel.width / 2;

  function currentHue() {
    return active == null ? 0 : (hues.get(active) || 0);
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
          const color = hsvToRgb(hue, D.wheelSat, 1);
          wheelContext.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
        }
        wheelContext.fillRect(x, y, 1, 1);
      }
    }

    const core = hsvToRgb(selectedHue, D.wheelSat, 0.9);
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
      const color = applyRule(
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
    previewContext.drawImage(
      spriteCanvas,
      0,
      0,
      preview.width,
      preview.height,
    );
    if (pageAvatar) pageAvatar.src = preview.toDataURL('image/png');
  }

  // --- ordered, per-slot autosave ---
  const timers = new Map();
  const pendingSets = new Map();
  const queues = new Map();
  const failedSlots = new Set();

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state || '';
  }

  function showSettledStatus() {
    if (queues.size > 0 || timers.size > 0) return;
    if (failedSlots.size > 0) {
      const noun = failedSlots.size === 1 ? 'change needs' : 'changes need';
      setStatus(
        `${failedSlots.size} ${noun} saving — try again`,
        'error',
      );
      return;
    }
    setStatus('All changes saved', 'saved');
  }

  async function postSave(endpoint, body) {
    const response = await fetch(endpoint, {
      method: 'POST',
      body,
      credentials: 'same-origin',
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Save failed (${response.status})`);
  }

  function enqueue(slot, endpoint, body) {
    setStatus('Saving…', 'saving');
    const previous = queues.get(slot);
    const request = previous
      ? previous.catch(function () {}).then(function () {
          return postSave(endpoint, body);
        })
      : postSave(endpoint, body);
    queues.set(slot, request);
    request.then(
      function () {
        failedSlots.delete(slot);
        if (queues.get(slot) === request) queues.delete(slot);
        showSettledStatus();
      },
      function () {
        failedSlots.add(slot);
        if (queues.get(slot) === request) queues.delete(slot);
        showSettledStatus();
      },
    );
  }

  function saveSet(slot, finish, hue) {
    const body = new URLSearchParams({
      token: D.token,
      slot: String(slot),
      finish,
    });
    if (hue != null) body.set('hue', String(hue));

    clearTimeout(timers.get(slot));
    pendingSets.set(slot, body);
    setStatus('Change queued…', 'saving');
    timers.set(
      slot,
      setTimeout(function () {
        timers.delete(slot);
        const pending = pendingSets.get(slot);
        pendingSets.delete(slot);
        if (pending) enqueue(slot, '/character/dye/set', pending);
      }, 120),
    );
  }

  function saveClear(slot) {
    clearTimeout(timers.get(slot));
    timers.delete(slot);
    pendingSets.delete(slot);
    enqueue(
      slot,
      '/character/dye/clear',
      new URLSearchParams({ token: D.token, slot: String(slot) }),
    );
  }

  // A reload/navigation can happen inside the 120ms wheel debounce. Start those
  // final requests synchronously during pagehide; keepalive lets the browser
  // finish the small form POST after the document is gone.
  function flushPendingSets() {
    for (const [slot, body] of pendingSets) {
      clearTimeout(timers.get(slot));
      timers.delete(slot);
      pendingSets.delete(slot);
      enqueue(slot, '/character/dye/set', body);
    }
  }
  window.addEventListener('beforeunload', flushPendingSets);
  window.addEventListener('pagehide', flushPendingSets);

  // --- channel and finish controls ---
  function rulesMatch(left, right) {
    if (!left || !right) return false;
    return ['op', 'hue', 'sat', 'lo', 'hi'].every(
      (key) => left[key] === right[key],
    );
  }

  function ruleColor(rule) {
    if (!rule) return null;
    if (rule.op === 'value') {
      const lo = rule.lo == null ? 0 : rule.lo;
      const hi = rule.hi == null ? 1 : rule.hi;
      const value = Math.round(((lo + hi) / 2) * 255);
      return `rgb(${value} ${value} ${value})`;
    }
    const color = hsvToRgb(
      rule.hue == null ? 0 : rule.hue,
      rule.sat == null ? 0.6 : rule.sat,
      0.9,
    );
    return `rgb(${color[0]} ${color[1]} ${color[2]})`;
  }

  function renderChannels() {
    channelWrap.textContent = '';
    for (const channel of D.channels) {
      const button = document.createElement('button');
      const rule = config.get(channel.slot);
      button.type = 'button';
      button.className = 'dye-chan';
      button.classList.toggle('active', channel.slot === active);
      button.classList.toggle('configured', !!rule);
      button.setAttribute('aria-pressed', String(channel.slot === active));

      const dot = document.createElement('span');
      dot.className = 'dye-dot';
      const color = ruleColor(rule);
      if (color) dot.style.background = color;
      else dot.classList.add('is-default');

      const label = document.createElement('span');
      label.textContent = channel.label;
      button.append(dot, label);
      button.addEventListener('click', function () {
        active = channel.slot;
        renderControls();
      });
      channelWrap.appendChild(button);
    }
  }

  function selectedFinish(rule) {
    for (const [name, finishRule] of Object.entries(D.finishes)) {
      if (rulesMatch(rule, finishRule)) return name;
    }
    return rule ? 'wheel' : 'none';
  }

  function renderControls() {
    const channel = D.channels.find((item) => item.slot === active);
    const rule = active == null ? null : config.get(active);
    const finish = selectedFinish(rule);

    activeLabel.textContent = channel
      ? `${channel.label} selected`
      : 'Choose a material';
    wheel.classList.toggle('active', finish === 'wheel');
    wheel.setAttribute('aria-valuenow', String(currentHue()));
    wheel.setAttribute('aria-valuetext', `${currentHue()} degrees`);

    document.querySelectorAll('.dye-fin').forEach(function (button) {
      const selected = button.getAttribute('data-finish') === finish;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    drawWheel();
    renderChannels();
  }

  function applySelection(rule, finish, hue) {
    if (active == null) return;
    if (rule) {
      const stored = { ...rule };
      config.set(active, stored);
      if (hue != null) hues.set(active, hue);
      saveSet(active, finish, hue);
    } else {
      config.delete(active);
      saveClear(active);
    }
    renderPreview();
    renderControls();
  }

  function selectHue(hue) {
    const normalized = ((hue % 360) + 360) % 360;
    applySelection(
      { op: 'colorize', hue: normalized, sat: D.wheelSat },
      'wheel',
      normalized,
    );
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
  wheel.addEventListener('pointercancel', function () {
    dragging = false;
  });
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

  document.querySelectorAll('.dye-fin').forEach(function (button) {
    button.addEventListener('click', function () {
      const finish = button.getAttribute('data-finish');
      if (finish === 'none') {
        applySelection(null, 'none', null);
        return;
      }
      applySelection(D.finishes[finish], finish, null);
    });
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
