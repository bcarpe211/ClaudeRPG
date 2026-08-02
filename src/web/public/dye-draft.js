'use strict';

(function exposeDyeDraft(root) {
  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizedHue(value) {
    const hue = finiteNumber(value, 0);
    return ((hue % 360) + 360) % 360;
  }

  function normalizedState(state) {
    return {
      recipe: state.recipe,
      hue: normalizedHue(state.hue),
      sat: finiteNumber(state.sat, 0),
      tone: finiteNumber(state.tone, 0),
    };
  }

  function cloneStates(states) {
    return new Map(Array.from(states, ([slot, state]) => [slot, { ...state }]));
  }

  function equalState(left, right) {
    if (!left || !right) return left === right;
    const a = normalizedState(left);
    const b = normalizedState(right);
    return a.recipe === b.recipe
      && a.hue === b.hue
      && a.sat === b.sat
      && a.tone === b.tone;
  }

  function dirtyOperations(saved, draft) {
    const slots = new Set([...saved.keys(), ...draft.keys()]);
    return Array.from(slots).sort((a, b) => a - b).flatMap((slot) => {
      const savedState = saved.get(slot);
      const draftState = draft.get(slot);
      if (equalState(savedState, draftState)) return [];
      if (!draftState) return [{ action: 'clear', slot }];

      const state = normalizedState(draftState);
      return [{
        action: 'set',
        slot,
        recipe: state.recipe,
        ...(state.recipe === 'wheel' ? { hue: state.hue } : {}),
        tone: state.tone,
      }];
    });
  }

  root.ClaudeRpgDyeDraft = Object.freeze({ cloneStates, equalState, dirtyOperations }); // runtime-raiders-copy-allow -- compatibility global
})(globalThis);
