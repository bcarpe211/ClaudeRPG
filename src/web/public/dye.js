'use strict';

// Character-page wardrobe. The server-rendered /sprite/skin image remains the
// source of truth; this mirrors its slot operations for immediate local preview.
(function () {
  const D = window.__DYE__;
  const colorMath = window.ClaudeRpgDyeColor;
  const Draft = window.ClaudeRpgDyeDraft;
  if (!D || !colorMath || !Draft) return;

  const preview = document.getElementById('dye-preview');
  const wheel = document.getElementById('dye-wheel');
  const status = document.getElementById('dye-save-status');
  const toneInput = document.getElementById('dye-tone');
  const toneValue = document.getElementById('dye-tone-value');
  const saveButton = document.getElementById('dye-save');
  const discardButton = document.getElementById('dye-discard');
  const reloadButton = document.getElementById('dye-reload');
  const pageAvatars = {
    a: document.getElementById('character-avatar-a'),
    b: document.getElementById('character-avatar-b'),
  };
  if (!preview || !wheel || !status || !toneInput || !toneValue
    || !saveButton || !discardButton || !reloadButton) return;

  const previewContext = preview.getContext('2d');
  const wheelContext = wheel.getContext('2d');
  if (!previewContext || !wheelContext) return;
  previewContext.imageSmoothingEnabled = false;
  wheelContext.imageSmoothingEnabled = false;

  let config = new Map(
    Object.entries(D.config).map(([slot, rule]) => [Number(slot), rule]),
  );
  let states = new Map();
  for (const [slot, rule] of config) states.set(slot, stateFromRule(rule));
  let savedStates = Draft.cloneStates(states);
  let savedConfig = cloneConfig(config);
  let saving = false;
  let stale = false;
  const channelButtons = Array.from(document.querySelectorAll('.dye-chan:not(:disabled)'));
  let active = channelButtons.length > 0 ? Number(channelButtons[0].dataset.slot) : null;
  const revisionSession = Number.isSafeInteger(D.revisionSession) ? D.revisionSession : null;
  let nextRevision = Number.isSafeInteger(D.revisionSeed) ? D.revisionSeed : 1;

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
    return states.get(slot) || stateFromRule(null);
  }

  function cloneConfig(source) {
    return new Map(Array.from(source, ([slot, rule]) => [slot, { ...rule }]));
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
  const frameStates = {};
  for (const frame of ['a', 'b']) {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    const base = new Image();
    base.crossOrigin = 'anonymous';
    frameStates[frame] = {
      canvas,
      context,
      base,
      slotmap: D.frames[frame].slotmap,
      sourcePixels: null,
      rendered: false,
      dataUrl: '',
    };
    base.onload = function () {
      context.clearRect(0, 0, 24, 24);
      context.drawImage(base, 0, 0, 24, 24);
      frameStates[frame].sourcePixels = context.getImageData(0, 0, 24, 24);
      renderPreview();
    };
    base.onerror = function () {
      setStatus('Preview could not load', 'error');
    };
    base.src = D.frames[frame].base;
  }

  let visibleFrame = 'a';

  function renderFrame(frame) {
    const state = frameStates[frame];
    if (!state.sourcePixels) return;
    const output = state.context.createImageData(24, 24);
    const source = state.sourcePixels.data;
    const pixels = output.data;
    const pixelCount = Math.min(state.slotmap.length, 24 * 24);

    for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
      const index = pixel * 4;
      pixels[index] = source[index];
      pixels[index + 1] = source[index + 1];
      pixels[index + 2] = source[index + 2];
      pixels[index + 3] = source[index + 3];
      if (pixel >= pixelCount || source[index + 3] === 0) continue;

      const rule = config.get(state.slotmap[pixel]);
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

    state.context.putImageData(output, 0, 0);
    state.rendered = true;
    state.dataUrl = state.canvas.toDataURL('image/png');
    if (pageAvatars[frame]) pageAvatars[frame].src = state.dataUrl;
  }

  function drawVisibleFrame() {
    const state = frameStates[visibleFrame];
    if (!state.rendered) return;
    previewContext.clearRect(0, 0, preview.width, preview.height);
    previewContext.drawImage(state.canvas, 0, 0, preview.width, preview.height);
  }

  function renderPreview() {
    renderFrame('a');
    renderFrame('b');
    drawVisibleFrame();
  }

  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion) {
    setInterval(function () {
      visibleFrame = visibleFrame === 'a' ? 'b' : 'a';
      drawVisibleFrame();
    }, 700);
  }

  // --- explicit saved/draft persistence ---

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state || '';
  }

  function operations() {
    return Draft.dirtyOperations(savedStates, states);
  }

  function renderSaveState(message) {
    const dirty = operations().length > 0;
    if (stale) {
      saveButton.disabled = true;
      discardButton.disabled = true;
      setStatus(message || 'Wardrobe changed elsewhere — refresh required', 'error');
      return;
    }
    saveButton.disabled = saving || !dirty;
    discardButton.disabled = saving || !dirty;
    setStatus(message || (dirty ? 'Unsaved changes' : 'Saved'), dirty ? 'dirty' : 'saved');
  }

  async function saveDraft() {
    const changes = operations();
    if (saving || stale || changes.length === 0) return;
    const submittedStates = Draft.cloneStates(states);
    saving = true;
    renderSaveState('Saving');
    let message = 'Save failed';
    try {
      const body = new URLSearchParams({
        token: D.token,
        session: String(revisionSession),
        revision: String(nextRevision),
        changes: JSON.stringify(changes),
      });
      const response = await fetch('/character/dye/save', {
        method: 'POST', body, credentials: 'same-origin',
      });
      if (response.status === 409) {
        stale = true;
        reloadButton.hidden = false;
        message = 'Wardrobe changed elsewhere — refresh required';
        return;
      }
      if (!response.ok) throw new Error(`Save failed (${response.status})`);

      const canonical = await response.json();
      const canonicalConfig = new Map(
        Object.entries(canonical.config).map(([slot, rule]) => [Number(slot), rule]),
      );
      const canonicalStates = new Map();
      for (const [slot, rule] of canonicalConfig) {
        canonicalStates.set(slot, stateFromRule(rule));
      }
      const rebasedConfig = cloneConfig(canonicalConfig);
      const rebasedStates = Draft.cloneStates(canonicalStates);
      const touchedWhileSaving = new Set([...submittedStates.keys(), ...states.keys()]);
      for (const slot of touchedWhileSaving) {
        const currentState = states.get(slot);
        if (Draft.equalState(submittedStates.get(slot), currentState)) continue;
        if (!currentState) {
          rebasedConfig.delete(slot);
          rebasedStates.delete(slot);
          continue;
        }
        const currentRule = config.get(slot);
        rebasedConfig.set(slot, currentRule ? { ...currentRule } : ruleFromState(currentState));
        rebasedStates.set(slot, { ...currentState });
      }
      savedConfig = cloneConfig(canonicalConfig);
      savedStates = Draft.cloneStates(canonicalStates);
      config = rebasedConfig;
      states = rebasedStates;
      nextRevision += 1;
      renderPreview();
      renderControls();
      message = operations().length > 0 ? 'Unsaved changes' : 'Saved';
    } catch (_error) {
      // Keep the current draft so the same revision can be retried safely.
    } finally {
      saving = false;
      renderSaveState(message);
    }
  }

  function discardDraft() {
    if (saving || stale) return;
    states = Draft.cloneStates(savedStates);
    config = cloneConfig(savedConfig);
    renderPreview();
    renderControls();
    renderSaveState('Saved');
  }

  window.addEventListener('beforeunload', function (event) {
    if (operations().length === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) location.reload();
  });

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
      button.classList.toggle('active', slot === active);
      button.classList.toggle('configured', !!rule);
      button.setAttribute('aria-pressed', String(slot === active));
      const dot = button.querySelector('.dye-dot');
      if (dot) {
        const color = ruleColor(rule);
        dot.classList.toggle('is-default', !color);
        dot.style.background = color || '';
      }
    }
  }

  function renderControls() {
    const state = active == null ? null : stateFor(active);
    const recipe = state ? state.recipe : 'none';
    const tone = state ? state.tone : 0;

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
    renderPreview();
    renderControls();
    renderSaveState();
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
      renderPreview();
      renderControls();
      renderSaveState();
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
  saveButton.addEventListener('click', saveDraft);
  discardButton.addEventListener('click', discardDraft);
  reloadButton.addEventListener('click', function () { location.reload(); });

  renderControls();
  renderSaveState();
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
