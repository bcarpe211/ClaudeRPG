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
  const navToast = document.getElementById('dye-nav-toast');
  const navTitle = document.getElementById('dye-nav-title');
  const navMessage = document.getElementById('dye-nav-message');
  const navSaveButton = document.getElementById('dye-nav-save');
  const navSaveLabel = document.getElementById('dye-nav-save-label');
  const navLeaveButton = document.getElementById('dye-nav-leave');
  const navCloseButton = document.getElementById('dye-nav-close');
  const guardedLinks = Array.from(document.querySelectorAll('[data-dye-guarded-nav]'));
  const pageAvatars = {
    a: document.getElementById('character-avatar-a'),
    b: document.getElementById('character-avatar-b'),
  };
  if (!preview || !wheel || !status || !toneInput || !toneValue
    || !saveButton || !discardButton || !reloadButton
    || !navToast || !navTitle || !navMessage || !navSaveButton || !navSaveLabel
    || !navLeaveButton || !navCloseButton) return;

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
  let refreshRequired = false;
  let refreshMessage = 'Wardrobe changed elsewhere — refresh required';
  let saveError = false;
  let pendingAttempt = null;
  let savePromise = null;
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

  let pendingDestination = null;
  let pendingNavigationTrigger = null;

  function hasPendingChanges() {
    return operations().length > 0 || pendingAttempt !== null || saving || savePromise !== null || refreshRequired;
  }

  function showDirtyNavigationToast(link) {
    const canLeave = !saving && !savePromise && pendingAttempt === null && !refreshRequired;
    pendingDestination = link.getAttribute('href');
    pendingNavigationTrigger = link;
    navTitle.textContent = 'The tailor catches your sleeve!';
    navMessage.textContent = canLeave
      ? 'You still have unfinished dye work on the fitting table. Save it before heading out, or leave it behind.'
      : 'Your dye work is still being reconciled on the fitting table. Finish saving or reload before heading out.';
    navSaveLabel.textContent = 'Save & Continue';
    navSaveButton.hidden = false;
    navSaveButton.disabled = false;
    navLeaveButton.hidden = !canLeave;
    navToast.hidden = false;
    navSaveButton.focus();
  }

  function closeNavigationToast(restoreFocus) {
    const trigger = pendingNavigationTrigger;
    navToast.hidden = true;
    pendingDestination = null;
    pendingNavigationTrigger = null;
    if (restoreFocus && trigger) trigger.focus();
  }

  function navigatePending() {
    const destination = pendingDestination;
    closeNavigationToast(false);
    if (destination) location.assign(destination);
  }

  function leaveWithoutSaving() {
    if (saving || savePromise || pendingAttempt !== null || refreshRequired) return;
    discardDraft();
    navigatePending();
  }

  function renderSaveState(message) {
    const dirty = operations().length > 0 || pendingAttempt !== null;
    if (refreshRequired) {
      saveButton.disabled = true;
      discardButton.disabled = true;
      setStatus(message || refreshMessage, 'error');
      return;
    }
    if (saving) {
      saveButton.disabled = true;
      discardButton.disabled = true;
      setStatus(message || 'Saving', 'saving');
      return;
    }
    saveButton.disabled = saving || !dirty;
    discardButton.disabled = saving || !dirty;
    setStatus(
      message || (saveError ? 'Save failed' : (dirty ? 'Unsaved changes' : 'Saved')),
      saveError ? 'error' : (dirty ? 'dirty' : 'saved'),
    );
  }

  async function performSave() {
    if (refreshRequired) return 'refresh-required';
    if (!pendingAttempt) {
      const changes = operations();
      if (changes.length === 0) return 'clean';
      pendingAttempt = {
        changes,
        revision: nextRevision,
        submittedStates: Draft.cloneStates(states),
      };
    }
    const attempt = pendingAttempt;
    saving = true;
    saveError = false;
    renderSaveState('Saving');
    let message = 'Save failed';
    let result = 'retryable-error';
    try {
      const body = new URLSearchParams({
        token: D.token,
        session: String(revisionSession),
        revision: String(attempt.revision),
        changes: JSON.stringify(attempt.changes),
      });
      const response = await fetch('/character/dye/save', {
        method: 'POST', body, credentials: 'same-origin',
      });
      if (response.status === 409) {
        refreshRequired = true;
        refreshMessage = 'Wardrobe changed elsewhere — refresh required';
        reloadButton.hidden = false;
        message = refreshMessage;
        result = 'refresh-required';
        return result;
      }
      if (response.status === 400 || response.status === 403 || response.status === 404) {
        pendingAttempt = null;
        refreshRequired = true;
        refreshMessage = response.status === 400
          ? 'Wardrobe save was rejected — refresh required'
          : response.status === 403
            ? 'Wardrobe access changed — refresh required'
            : 'Character session expired — reload required';
        reloadButton.hidden = false;
        message = refreshMessage;
        result = 'refresh-required';
        return result;
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
      const touchedWhileSaving = new Set([...attempt.submittedStates.keys(), ...states.keys()]);
      for (const slot of touchedWhileSaving) {
        const currentState = states.get(slot);
        if (Draft.equalState(attempt.submittedStates.get(slot), currentState)) continue;
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
      pendingAttempt = null;
      nextRevision = Math.max(nextRevision, attempt.revision + 1);
      renderPreview();
      renderControls();
      result = operations().length > 0 ? 'dirty' : 'saved';
      message = result === 'dirty' ? 'Unsaved changes' : 'Saved';
    } catch (_error) {
      // Keep the current draft so the same revision can be retried safely.
      saveError = true;
      result = 'retryable-error';
    } finally {
      saving = false;
      renderSaveState(message);
    }
    return result;
  }

  function saveDraft() {
    if (savePromise) return savePromise;
    savePromise = performSave().finally(function () { savePromise = null; });
    return savePromise;
  }

  function discardDraft() {
    if (saving || refreshRequired) return;
    states = Draft.cloneStates(savedStates);
    config = cloneConfig(savedConfig);
    renderPreview();
    renderControls();
    renderSaveState(pendingAttempt ? 'Save failed' : 'Saved');
  }

  function showWaitingNavigationToast() {
    navTitle.textContent = 'The tailor is tying the last knot!';
    navMessage.textContent = 'The tailor is finishing your dye work before opening the next door.';
    navSaveButton.hidden = false;
    navSaveButton.disabled = true;
    navLeaveButton.hidden = true;
    navToast.hidden = false;
  }

  function showRetryNavigationToast() {
    navTitle.textContent = 'The ledger ink is still wet!';
    navMessage.textContent = 'The fitting could not be confirmed. Retry the same save before leaving.';
    navSaveLabel.textContent = 'Retry Save';
    navSaveButton.hidden = false;
    navSaveButton.disabled = false;
    navLeaveButton.hidden = true;
    navToast.hidden = false;
    navSaveButton.focus();
  }

  function showRefreshNavigationToast() {
    navTitle.textContent = 'The ledger has changed!';
    navMessage.textContent = 'The tailor’s ledger must be reloaded before this fitting can leave the workbench.';
    navSaveButton.hidden = true;
    navLeaveButton.hidden = true;
    navToast.hidden = false;
  }

  let navigationSaveWait = null;

  function handleNavigationSaveResult(result) {
    if (!pendingDestination) return;
    if (result === 'saved' || result === 'clean') {
      navigatePending();
      return;
    }
    if (result === 'dirty') {
      navTitle.textContent = 'The tailor found another loose thread!';
      navMessage.textContent = 'The tailor found another loose thread! New dye work appeared while the ledger was saving. Save again before heading out, or leave it behind.';
      navSaveLabel.textContent = 'Save & Continue';
      navSaveButton.hidden = false;
      navSaveButton.disabled = false;
      navLeaveButton.hidden = false;
      navToast.hidden = false;
      navSaveButton.focus();
      return;
    }
    if (result === 'retryable-error') {
      showRetryNavigationToast();
      return;
    }
    showRefreshNavigationToast();
  }

  function saveAndContinue() {
    if (!pendingDestination || navigationSaveWait) return;
    showWaitingNavigationToast();
    navigationSaveWait = saveDraft()
      .then(handleNavigationSaveResult)
      .finally(function () { navigationSaveWait = null; });
  }

  window.addEventListener('beforeunload', function (event) {
    if (operations().length === 0 && pendingAttempt === null) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      location.reload();
      return;
    }
    renderControls();
    renderSaveState();
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
  for (const link of guardedLinks) {
    link.addEventListener('click', function (event) {
      if (!hasPendingChanges()) return;
      event.preventDefault();
      pendingDestination = link.getAttribute('href');
      pendingNavigationTrigger = link;
      if (saving || savePromise) {
        showWaitingNavigationToast();
        saveAndContinue();
        return;
      }
      if (saveError && pendingAttempt !== null) {
        showRetryNavigationToast();
        return;
      }
      showDirtyNavigationToast(link);
    });
  }
  navSaveButton.addEventListener('click', saveAndContinue);
  navLeaveButton.addEventListener('click', leaveWithoutSaving);
  navCloseButton.addEventListener('click', function () { closeNavigationToast(true); });
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !navToast.hidden) closeNavigationToast(true);
  });

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
