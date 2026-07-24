import { start } from '/static/anim.js';

const SLOT_MODES = new Set(['focus', 'hue', 'black', 'white', 'steel']);

export function renderUrl(sprite, frame, mode, slot, hue) {
  const params = new URLSearchParams({ mode });
  if (SLOT_MODES.has(mode)) params.set('slot', String(slot));
  if (mode === 'hue') params.set('hue', String(hue));
  return `/cosmetics-review/render/${sprite}/${frame}.png?${params}`;
}

const state = window.__COSMETICS_REVIEW__;
const modeButtons = [...document.querySelectorAll('[data-review-mode]')];
const slotChoices = [...document.querySelectorAll('[data-review-slot-choice]')];
const cards = [...document.querySelectorAll('.review-variant')];
const slotSelect = document.querySelector('#review-slot');
const materialTool = document.querySelector('#review-material-tool');
const hueTool = document.querySelector('#review-hue-tool');
const hueInput = document.querySelector('#review-hue');
const hueValue = document.querySelector('#review-hue-value');
const motionButton = document.querySelector('#review-motion');

let mode = state.initialMode;
let slot = state.initialSlot;
let hue = state.initialHue;
const controller = start({ periodMs: 700 });

function updateRenderUrls() {
  for (const card of cards) {
    const sprite = card.dataset.sprite;
    card.querySelector('.frame-a').src = renderUrl(sprite, 'a', mode, slot, hue);
    card.querySelector('.frame-b').src = renderUrl(sprite, 'b', mode, slot, hue);
  }
}

function updateModeControls() {
  for (const button of modeButtons) {
    const active = button.dataset.reviewMode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  materialTool.hidden = !SLOT_MODES.has(mode);
  hueTool.hidden = mode !== 'hue';
}

function updateSlotControls() {
  slotSelect.value = String(slot);
  for (const choice of slotChoices) {
    const active = Number(choice.dataset.reviewSlotChoice) === slot;
    choice.classList.toggle('is-active', active);
    choice.setAttribute('aria-pressed', String(active));
  }
}

function updateHueControl() {
  hueInput.value = String(hue);
  hueValue.value = `${hue}°`;
}

function updateMotionControl() {
  const paused = controller.isPaused();
  motionButton.textContent = paused ? 'Resume animation' : 'Pause animation';
  motionButton.setAttribute('aria-pressed', String(paused));
}

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    mode = button.dataset.reviewMode;
    updateModeControls();
    updateRenderUrls();
  });
}

slotSelect.addEventListener('change', () => {
  slot = Number(slotSelect.value);
  updateSlotControls();
  updateRenderUrls();
});

for (const choice of slotChoices) {
  choice.addEventListener('click', () => {
    slot = Number(choice.dataset.reviewSlotChoice);
    updateSlotControls();
    updateRenderUrls();
  });
}

hueInput.addEventListener('input', () => {
  hue = Number(hueInput.value);
  updateHueControl();
  updateRenderUrls();
});

motionButton.addEventListener('click', () => {
  if (controller.isPaused()) controller.resume();
  else controller.pause();
  updateMotionControl();
});

if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
  controller.pause();
}

updateModeControls();
updateSlotControls();
updateHueControl();
updateMotionControl();
