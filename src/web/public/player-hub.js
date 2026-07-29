'use strict';

(function playerHubTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"][aria-controls]'));
  if (tabs.length === 0) return;

  function activate(next, moveFocus) {
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
    if (moveFocus) next.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab, false));
    tab.addEventListener('keydown', (event) => {
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activate(tabs[nextIndex], true);
    });
  });
})();

(function playerHubInventoryAndEffects(root) {
  const bootstrap = root.__PLAYER_HUB__;
  if (!bootstrap || !bootstrap.initialState || !bootstrap.endpoints) return;

  const documentRef = root.document;
  const byId = (id) => documentRef.getElementById(id);
  const grid = byId('hub-inventory-grid');
  const detail = byId('hub-item-detail');
  const drinkButton = byId('hub-potion-drink');
  const confirmDialog = byId('potion-confirm');
  const confirmDrink = byId('potion-confirm-drink');
  const confirmKeep = byId('potion-confirm-keep');
  const effectsSurface = byId('hub-effects');
  const effectsList = byId('hub-effects-list');
  const effectsClose = byId('hub-effects-close');
  const avatarTrigger = documentRef.querySelector('.hub-avatar-trigger');
  const avatarWrap = byId('hub-avatar-wrap');
  const potionCanvas = byId('hub-potion-fx');
  const potionContext = potionCanvas?.getContext?.('2d') ?? null;
  const reducedMotion = root.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  if (!grid || !detail || !drinkButton || !confirmDialog || !confirmDrink) return;

  const number = new Intl.NumberFormat('en-US');
  let state = bootstrap.initialState;
  let selectedSku = state.inventory[0]?.sku ?? null;
  let selectedFilter = 'all';
  let effectsPinned = false;
  let suppressFocusOpen = false;
  let pendingActivation = null;
  let refreshing = false;
  let refreshQueued = false;
  let potionFrameRequest = null;
  let potionFrameKey = null;

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function element(tag, className, text) {
    const next = documentRef.createElement(tag);
    if (className) next.className = className;
    if (text !== undefined) next.textContent = text;
    return next;
  }

  function durationLabel(ms) {
    if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
      const value = ms / 3_600_000;
      return `${value} active ${value === 1 ? 'hour' : 'hours'}`;
    }
    if (ms >= 60_000 && ms % 60_000 === 0) {
      const value = ms / 60_000;
      return `${value} active ${value === 1 ? 'minute' : 'minutes'}`;
    }
    const value = ms / 1_000;
    return `${number.format(value)} active ${value === 1 ? 'second' : 'seconds'}`;
  }

  function remainingLabel(ms) {
    if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1_000))}s remaining`;
    const totalMinutes = Math.ceil(ms / 60_000);
    if (totalMinutes < 60) return `${totalMinutes}m remaining`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m remaining`;
  }

  function selectedItem() {
    return state.inventory.find((item) => item.sku === selectedSku) ?? null;
  }

  function itemEffect(item) {
    return state.effects.find((effect) => effect.kind === item.potionType) ?? null;
  }

  function inventoryButton(item) {
    const button = element('button', 'hub-item-slot');
    button.type = 'button';
    button.dataset.sku = item.sku;
    button.setAttribute('aria-label', `${item.name}, ${number.format(item.quantity)} owned`);
    button.setAttribute('aria-pressed', item.sku === selectedSku ? 'true' : 'false');
    const icon = element('img', `hub-item-icon ${item.iconClass}`);
    icon.src = '/static/landing/potion.png';
    icon.alt = '';
    const quantity = element('span', 'hub-item-qty', number.format(item.quantity));
    quantity.setAttribute('aria-hidden', 'true');
    button.append(icon, quantity);
    return button;
  }

  function renderInventory() {
    const priorFocus = documentRef.activeElement;
    const refocus = priorFocus && grid.contains(priorFocus);
    const items = selectedFilter === 'potions'
      ? state.inventory.filter((item) => item.potionType === 'gold' || item.potionType === 'damage')
      : state.inventory;
    if (!items.some((item) => item.sku === selectedSku)) selectedSku = items[0]?.sku ?? null;
    clear(grid);
    if (items.length === 0) {
      const empty = element('div', 'hub-satchel-empty');
      empty.append(element('strong', '', 'Your satchel is quiet.'));
      empty.append(element('span', '', 'Purchased supplies will settle into these floor spaces.'));
      grid.append(empty);
    } else {
      items.forEach((item) => grid.append(inventoryButton(item)));
    }
    renderDetail();
    if (refocus) {
      const next = Array.from(grid.querySelectorAll('[data-sku]'))
        .find((button) => button.dataset.sku === selectedSku);
      next?.focus();
    }
  }

  function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value;
  }

  function renderDetail() {
    const item = selectedItem();
    const empty = byId('hub-item-detail-empty');
    const content = byId('hub-item-detail-content');
    detail.dataset.selectedSku = item?.sku ?? '';
    if (!item) {
      if (empty) empty.hidden = false;
      if (content) content.hidden = true;
      drinkButton.disabled = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    const icon = byId('hub-item-detail-icon');
    if (icon) icon.className = `hub-item-icon ${item.iconClass}`;
    setText('hub-item-detail-tier', `Tier ${item.tier} potion`);
    setText('hub-item-detail-name', item.name);
    setText('hub-item-detail-owned', number.format(item.quantity));
    setText('hub-item-detail-effect', item.effectCopy);
    setText(
      'hub-item-detail-duration',
      item.available ? durationLabel(item.durationMs) : 'Unavailable until tuning is repaired',
    );
    setText(
      'hub-item-detail-doses',
      item.available ? `${item.usesRemaining} remaining` : 'Unavailable until tuning is repaired',
    );
    setText('hub-item-detail-reset', new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(item.nextResetAt)));

    const active = itemEffect(item);
    const progress = byId('hub-item-active-progress');
    if (progress) {
      progress.hidden = !active;
      if (active) {
        const stateLabel = active.state
          ? active.state[0].toUpperCase() + active.state.slice(1)
          : 'Active';
        progress.textContent = `${stateLabel} · ${remainingLabel(active.remainingMs)}`;
        if (active.progress) {
          progress.textContent += ` · ${number.format(active.progress.value)} / ${number.format(active.progress.max)} tokens`;
        }
      }
    }
    drinkButton.disabled = !item.available || item.usesRemaining <= 0 || Boolean(active);
    drinkButton.textContent = !item.available
      ? 'Potion Unavailable'
      : active
        ? 'Potion Already Active'
        : item.usesRemaining <= 0
          ? 'Daily Limit Reached'
          : 'Drink Potion';
  }

  function renderEffects() {
    if (!effectsList) return;
    clear(effectsList);
    if (state.effects.length === 0) {
      effectsList.append(element('p', 'hub-empty-line', 'No magic is clinging to you right now.'));
      return;
    }
    state.effects.forEach((effect) => {
      const row = element('article', `hub-effect-row ${effect.iconClass}`);
      const icon = element('img', 'px hub-effect-icon');
      icon.src = effect.kind === 'debuff'
        ? '/static/landing/skull.png'
        : '/static/landing/potion.png';
      icon.alt = '';
      const copy = element('div');
      copy.append(element('strong', '', effect.title));
      copy.append(element('span', '', effect.description));
      const stateLabel = effect.state
        ? `${effect.state[0].toUpperCase()}${effect.state.slice(1)} · `
        : '';
      copy.append(element('small', '', `${stateLabel}${remainingLabel(effect.remainingMs)}`));
      if (effect.progress) {
        const bar = element('div', 'hub-effect-progress');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(effect.progress.max));
        bar.setAttribute('aria-valuenow', String(effect.progress.value));
        const fill = element('i');
        fill.style.width = `${Math.min(100, effect.progress.max > 0
          ? effect.progress.value / effect.progress.max * 100
          : 0)}%`;
        bar.append(fill);
        copy.append(bar);
      }
      row.append(icon, copy);
      effectsList.append(row);
    });
  }

  function renderTodayAndFight() {
    const gold = documentRef.querySelector('[data-hub-gold]');
    if (gold) gold.textContent = number.format(state.gold);
    setText('hub-today-tokens', number.format(state.today.effectiveTokens));
    setText('hub-today-damage', number.format(state.today.damage));
    setText('hub-today-rank', state.today.fightRank == null ? '—' : `#${state.today.fightRank}`);
    setText('hub-today-gold', `${number.format(state.today.goldEarned)}g`);
    const hours = Math.floor(state.today.combatActiveMs / 3_600_000);
    const minutes = Math.floor((state.today.combatActiveMs % 3_600_000) / 60_000);
    setText('hub-today-active', `${hours}h ${minutes}m`);
    setText('hub-today-potions', String(state.today.potionsUsed));

    const leaders = byId('hub-leaders');
    if (!leaders) return;
    clear(leaders);
    if (state.currentFight.leaders.length === 0) {
      leaders.append(element('p', 'hub-empty-line', 'The damage ledger is waiting for its first mark.'));
      return;
    }
    const list = element('ol', 'hub-leaders');
    state.currentFight.leaders.forEach((leader, index) => {
      const row = element('li');
      row.append(element('span', 'hub-leaders-rank', `#${index + 1}`));
      row.append(element('span', 'hub-leaders-name', leader.name));
      row.append(element('span', 'hub-leaders-damage', `${number.format(leader.damage)} dmg`));
      list.append(row);
    });
    leaders.append(list);
  }

  function renderState(nextState) {
    const nextPendingItem = pendingActivation
      ? nextState.inventory.find((item) => item.sku === pendingActivation.sku)
      : null;
    if (
      pendingActivation
      && !pendingActivation.attempted
      && (!nextPendingItem || !nextPendingItem.available)
    ) {
      closeDialog();
    }
    state = nextState;
    renderInventory();
    renderEffects();
    renderTodayAndFight();
    syncPotionAnimation();
  }

  function activePotionTiers() {
    const tiers = { goldTier: null, damageTier: null };
    for (const effect of state.effects) {
      if (effect.state === 'armed' || !Number.isInteger(effect.tier) || effect.tier < 1) continue;
      if (effect.kind === 'gold') tiers.goldTier = effect.tier;
      if (effect.kind === 'damage') tiers.damageTier = effect.tier;
    }
    return tiers;
  }

  function clearPotionCanvas() {
    potionContext?.clearRect(0, 0, potionCanvas.width, potionCanvas.height);
  }

  function stopPotionAnimation() {
    if (potionFrameRequest !== null) root.cancelAnimationFrame?.(potionFrameRequest);
    potionFrameRequest = null;
    potionFrameKey = null;
    clearPotionCanvas();
  }

  function drawPotionFrame(timeMs) {
    potionFrameRequest = null;
    const tiers = activePotionTiers();
    const hasEffect = tiers.goldTier !== null || tiers.damageTier !== null;
    if (
      !potionContext
      || !hasEffect
      || reducedMotion?.matches
      || documentRef.visibilityState === 'hidden'
      || !root.ClaudeRpgPotionFx
    ) {
      stopPotionAnimation();
      return;
    }

    const stepMs = Number.isFinite(root.ClaudeRpgPotionFx.stepMs)
      ? root.ClaudeRpgPotionFx.stepMs
      : 120;
    const frameKey = `${tiers.goldTier ?? 0}:${tiers.damageTier ?? 0}:${Math.floor(timeMs / stepMs)}`;
    if (frameKey !== potionFrameKey) {
      potionFrameKey = frameKey;
      clearPotionCanvas();
      const motes = root.ClaudeRpgPotionFx.frame({
        playerId: bootstrap.playerId,
        ...tiers,
        timeMs,
      });
      for (const mote of motes) {
        const size = mote.size;
        const x = Math.round(24 + mote.dx - size / 2);
        const y = Math.round(45 + mote.dy - size);
        potionContext.save();
        potionContext.globalAlpha = mote.alpha;
        potionContext.fillStyle = 'rgba(7,4,12,0.9)';
        potionContext.fillRect(x + 1, y + 1, size, size);
        potionContext.shadowColor = mote.color;
        potionContext.shadowBlur = 1;
        potionContext.fillStyle = mote.color;
        potionContext.fillRect(x, y, size, size);
        potionContext.restore();
      }
    }
    potionFrameRequest = root.requestAnimationFrame?.(drawPotionFrame) ?? null;
  }

  function syncPotionAnimation() {
    const tiers = activePotionTiers();
    const hasEffect = tiers.goldTier !== null || tiers.damageTier !== null;
    if (
      !potionContext
      || !hasEffect
      || reducedMotion?.matches
      || documentRef.visibilityState === 'hidden'
      || !root.ClaudeRpgPotionFx
      || typeof root.requestAnimationFrame !== 'function'
    ) {
      stopPotionAnimation();
      return;
    }
    if (potionFrameRequest === null) {
      potionFrameRequest = root.requestAnimationFrame(drawPotionFrame);
    }
  }

  function showFeedback(message, isError) {
    const feedback = byId('hub-potion-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
    feedback.classList.toggle('is-error', Boolean(isError));
    root.clearTimeout?.(showFeedback.timer);
    showFeedback.timer = root.setTimeout?.(() => { feedback.hidden = true; }, 4_500);
  }

  function openDialog() {
    const item = selectedItem();
    if (!item || drinkButton.disabled) return;
    pendingActivation = {
      requestId: root.crypto.randomUUID(),
      sku: item.sku,
      item: { ...item },
      attempted: false,
    };
    const timing = state.activationTiming === 'starts_now'
      ? 'Starts now.'
      : 'Waits for battle.';
    setText('potion-confirm-title', `Drink ${item.name}?`);
    setText('potion-confirm-copy', `${timing} Drinking is irreversible. ${item.effectCopy} for ${durationLabel(item.durationMs)}. The timer pauses whenever the dungeon is not accepting work.`);
    setText('potion-confirm-inventory', `${item.quantity} → ${Math.max(0, item.quantity - 1)} owned`);
    setText('potion-confirm-doses', `${item.usesRemaining} → ${Math.max(0, item.usesRemaining - 1)} remaining`);
    if (typeof confirmDialog.showModal === 'function') {
      confirmDialog.hidden = false;
      confirmDialog.showModal();
    }
    else {
      confirmDialog.hidden = false;
      confirmDialog.classList.add('is-open');
    }
  }

  function closeDialog(clearRequest = true) {
    if (typeof confirmDialog.close === 'function') {
      if (confirmDialog.open) confirmDialog.close();
    } else {
      confirmDialog.hidden = true;
    }
    confirmDialog.classList.remove('is-open');
    if (clearRequest) pendingActivation = null;
  }

  function activationError(reason) {
    const messages = {
      no_inventory: 'That bottle is no longer in your satchel.',
      daily_limit: 'Your potion ledger is full for today. Try again after midnight.',
      type_active: 'That kind of magic is already flowing. Let it finish first.',
      request_conflict: 'The potion ledger rejected a mismatched retry.',
      invalid_config: 'The apothecary has pulled that bottle for inspection.',
    };
    return messages[reason] ?? 'The cork would not budge. Nothing was consumed.';
  }

  function burstBottle() {
    const burst = byId('hub-bottle-burst');
    if (!burst || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    burst.classList.remove('is-bursting');
    void burst.offsetWidth;
    burst.classList.add('is-bursting');
    root.setTimeout?.(() => burst.classList.remove('is-bursting'), 900);
  }

  async function refreshState(force = false) {
    if (refreshing) {
      if (force) refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      const response = await root.fetch(bootstrap.endpoints.state, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) return;
      renderState(await response.json());
    } catch {
      // The next visible poll remains authoritative; keep the last good state.
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshState();
      }
    }
  }

  async function activateSelected() {
    const pending = pendingActivation;
    if (!pending) return;
    pending.attempted = true;
    const item = pending.item;
    confirmDrink.disabled = true;
    confirmDrink.textContent = 'Uncorking…';
    const body = new URLSearchParams({
      token: bootstrap.token,
      sku: pending.sku,
      request_id: pending.requestId,
    });
    try {
      const response = await root.fetch(bootstrap.endpoints.activate, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        showFeedback(activationError(result.reason), true);
        closeDialog();
        return;
      }
      const timing = result.state === 'active' ? 'starts now' : 'waits for battle';
      showFeedback(`${item.name} uncorked — ${timing}.`, false);
      closeDialog();
      burstBottle();
      await refreshState(true);
    } catch {
      showFeedback('The courier lost the reply. Try again—the same ledger mark will be reused.', true);
      // Keep the confirmed UUID and SKU so a retry cannot consume a different bottle.
    } finally {
      confirmDrink.disabled = false;
      confirmDrink.textContent = 'Drink Potion';
    }
  }

  function openEffects() {
    if (!effectsSurface || !avatarTrigger) return;
    effectsSurface.hidden = false;
    avatarTrigger.setAttribute('aria-expanded', 'true');
  }

  function closeEffects() {
    if (!effectsSurface || !avatarTrigger) return;
    effectsSurface.hidden = true;
    avatarTrigger.setAttribute('aria-expanded', 'false');
  }

  function returnFocusToAvatar() {
    suppressFocusOpen = true;
    avatarTrigger?.focus();
    suppressFocusOpen = false;
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-sku]');
    if (!button || !grid.contains(button)) return;
    selectedSku = button.dataset.sku;
    Array.from(grid.querySelectorAll('[data-sku]')).forEach((candidate) => {
      candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false');
    });
    renderDetail();
  });
  documentRef.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedFilter = button.dataset.filter;
      documentRef.querySelectorAll('[data-filter]').forEach((candidate) => {
        candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false');
      });
      renderInventory();
    });
  });
  drinkButton.addEventListener('click', openDialog);
  confirmDrink.addEventListener('click', activateSelected);
  confirmKeep?.addEventListener('click', (event) => {
    event.preventDefault();
    closeDialog();
  });

  avatarTrigger?.addEventListener('pointerenter', openEffects);
  avatarTrigger?.addEventListener('focus', () => {
    if (!suppressFocusOpen) openEffects();
  });
  avatarTrigger?.addEventListener('click', () => {
    effectsPinned = !effectsPinned;
    if (effectsPinned) openEffects(); else closeEffects();
  });
  avatarWrap?.addEventListener('pointerleave', () => {
    if (!effectsPinned && !avatarWrap.matches(':focus-within')) closeEffects();
  });
  avatarWrap?.addEventListener('focusout', (event) => {
    if (!effectsPinned && !avatarWrap.contains(event.relatedTarget)) closeEffects();
  });
  effectsClose?.addEventListener('click', () => {
    effectsPinned = false;
    closeEffects();
    returnFocusToAvatar();
  });
  documentRef.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const effectsWasOpen = effectsSurface && !effectsSurface.hidden;
    effectsPinned = false;
    closeEffects();
    if (effectsWasOpen) returnFocusToAvatar();
    if (confirmDialog.open || !confirmDialog.hidden) closeDialog();
  });
  documentRef.addEventListener('visibilitychange', () => {
    syncPotionAnimation();
    if (documentRef.visibilityState === 'visible') void refreshState();
  });
  reducedMotion?.addEventListener?.('change', syncPotionAnimation);
  root.setInterval?.(() => {
    if (documentRef.visibilityState !== 'hidden') void refreshState();
  }, 5_000);

  renderState(state);
})(globalThis);
