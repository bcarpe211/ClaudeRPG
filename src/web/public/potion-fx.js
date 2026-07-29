'use strict';

(function potionFxVocabulary(root) {
  const COLORS = Object.freeze({ gold: '#f1c75b', damage: '#e14b4b' });
  const CYCLE_STEPS = 31;
  const STEP_MS = 120;
  const MAX_MOTES = 8;

  function safeTier(value) {
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  function moteTypes(goldTier, damageTier) {
    const gold = safeTier(goldTier);
    const damage = safeTier(damageTier);
    if (!gold && !damage) return [];

    const types = [];
    if (gold && damage) {
      const count = Math.min(MAX_MOTES, 6 + Math.max(0, gold - 1) + Math.max(0, damage - 1));
      for (let index = 0; index < count; index += 1) {
        types.push(index % 2 === 0 ? 'gold' : 'damage');
      }
      return types;
    }

    const type = gold ? 'gold' : 'damage';
    const tier = gold || damage;
    const count = Math.min(MAX_MOTES, 3 + tier);
    return Array.from({ length: count }, () => type);
  }

  function frame(input) {
    const playerId = Number.isFinite(input?.playerId) ? Math.trunc(input.playerId) : 0;
    const tick = Math.floor((Number.isFinite(input?.timeMs) ? input.timeMs : 0) / STEP_MS);
    const types = moteTypes(input?.goldTier, input?.damageTier);

    return types.map((type, index) => {
      const typeSeed = type === 'gold' ? 17 : 43;
      const seed = Math.abs(playerId * 29 + index * 47 + typeSeed);
      const progress = ((tick + seed) % CYCLE_STEPS + CYCLE_STEPS) % CYCLE_STEPS;
      const jitterStep = Math.floor(progress / 2);
      const jitter = ((jitterStep + seed) % 5) - 2;
      const lane = ((seed % 5) - 2) * 2;
      const alpha = progress < 24 ? 1 : Math.max(0.2, (CYCLE_STEPS - progress) / 7);
      return {
        type,
        color: COLORS[type],
        dx: lane + jitter,
        dy: 2 - progress,
        size: 1 + (seed % 3),
        alpha,
      };
    });
  }

  root.ClaudeRpgPotionFx = Object.freeze({ frame, stepMs: STEP_MS });
})(typeof window === 'undefined' ? globalThis : window);
