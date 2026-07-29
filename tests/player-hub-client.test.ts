import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: FakeEvent) => unknown;

class FakeEvent {
  defaultPrevented = false;
  constructor(
    readonly key = '',
    readonly target: FakeElement | null = null,
    readonly relatedTarget: FakeElement | null = null,
  ) {}
  preventDefault(): void { this.defaultPrevented = true; }
}

class FakeClassList {
  private readonly values = new Set<string>();
  add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
  contains(name: string): boolean { return this.values.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.values.has(name);
    if (on) this.values.add(name); else this.values.delete(name);
    return on;
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Listener[]>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  activeElement: FakeElement | null = null;

  register(element: FakeElement): FakeElement {
    element.ownerDocument = this;
    if (element.id) this.elements.set(element.id, element);
    return element;
  }
  createElement(tag: string): FakeElement { return this.register(new FakeElement('', tag)); }
  getElementById(id: string): FakeElement | null { return this.elements.get(id) ?? null; }
  querySelector(selector: string): FakeElement | null {
    if (selector === '.hub-avatar-trigger') {
      return [...this.elements.values()].find((node) => node.className.includes('hub-avatar-trigger')) ?? null;
    }
    if (selector === '[data-hub-gold]') {
      return [...this.elements.values()].find((node) => node.attributes.has('data-hub-gold')) ?? null;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const all = [...this.elements.values()];
    if (selector === '[role="tab"][aria-controls]') {
      return all.filter((node) => node.getAttribute('role') === 'tab' && node.getAttribute('aria-controls'));
    }
    if (selector === '[data-filter]') return all.filter((node) => node.dataset.filter);
    return [];
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event = new FakeEvent()): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  async dispatchAsync(type: string, event = new FakeEvent()): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
}

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  ownerDocument: FakeDocument | null = null;
  parentElement: FakeElement | null = null;
  hidden = false;
  disabled = false;
  open = false;
  tabIndex = -1;
  focusCount = 0;
  className = '';
  textContent = '';
  type = '';
  src = '';
  alt = '';
  offsetWidth = 42;
  width = 0;
  height = 0;
  canvasContext: Record<string, any> | null = null;

  constructor(readonly id: string, readonly tagName = 'div') {}

  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event = new FakeEvent('', this)): FakeEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  async dispatchAsync(type: string, event = new FakeEvent('', this)): Promise<FakeEvent> {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
    return event;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  matches(selector: string): boolean {
    return selector === ':focus-within'
      && this.contains(this.ownerDocument?.activeElement ?? null);
  }
  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }
  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  contains(candidate: FakeElement | null): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
    if (selector === '[data-sku]') return descendants.filter((node) => node.dataset.sku);
    return [];
  }
  closest(selector: string): FakeElement | null {
    if (selector === '[data-sku]' && this.dataset.sku) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  focus(): void {
    this.focusCount += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  showModal(): void { this.open = true; this.hidden = false; }
  close(): void { this.open = false; this.hidden = true; }
  getContext(type: string): Record<string, any> | null {
    return type === '2d' ? this.canvasContext : null;
  }
}

const source = readFileSync('src/web/public/player-hub.js', 'utf8');

function tabHarness() {
  const document = new FakeDocument();
  const live = document.register(new FakeElement('hub-tab-live', 'button'));
  const inventory = document.register(new FakeElement('hub-tab-inventory', 'button'));
  const wardrobe = document.register(new FakeElement('hub-tab-wardrobe', 'button'));
  const livePanel = document.register(new FakeElement('hub-live'));
  const inventoryPanel = document.register(new FakeElement('hub-inventory'));
  const wardrobePanel = document.register(new FakeElement('hub-wardrobe'));
  const preview = document.register(new FakeElement('dye-preview', 'canvas'));
  for (const [tab, panel] of [[live, livePanel], [inventory, inventoryPanel], [wardrobe, wardrobePanel]] as const) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    tab.setAttribute('aria-selected', tab === live ? 'true' : 'false');
    tab.tabIndex = tab === live ? 0 : -1;
    panel.hidden = tab !== live;
  }
  const dirtyDraft = { slots: new Map([[1, { hue: 210 }]]) };
  const context: Record<string, unknown> = { document, __DYE__: { draft: dirtyDraft } };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { live, inventory, wardrobe, livePanel, wardrobePanel, preview, dirtyDraft, context, document };
}

type HubState = {
  gold: number;
  activationTiming: 'starts_now' | 'waits_for_battle';
  inventory: Array<Record<string, any>>;
  effects: Array<Record<string, any>>;
  today: Record<string, any>;
  currentFight: { leaders: Array<Record<string, any>> };
};

type HarnessResponse = { ok: boolean; json: () => Promise<any> } | Error;

function interactionHarness(options: {
  responses?: HarnessResponse[];
  activationTiming?: HubState['activationTiming'];
  reducedMotion?: boolean;
} = {}) {
  const document = new FakeDocument();
  const register = (id: string, tag = 'div') => document.register(new FakeElement(id, tag));
  const ids = [
    'hub-inventory-grid', 'hub-item-detail', 'hub-potion-drink', 'potion-confirm',
    'potion-confirm-drink', 'potion-confirm-keep', 'hub-effects', 'hub-effects-list',
    'hub-effects-close', 'hub-avatar-wrap', 'hub-item-detail-empty',
    'hub-item-detail-content', 'hub-item-detail-icon', 'hub-item-detail-tier',
    'hub-item-detail-name', 'hub-item-detail-owned', 'hub-item-detail-effect',
    'hub-item-detail-duration', 'hub-item-detail-doses', 'hub-item-detail-reset',
    'hub-item-active-progress', 'potion-confirm-title', 'potion-confirm-copy',
    'potion-confirm-inventory', 'potion-confirm-doses', 'hub-potion-feedback',
    'hub-bottle-burst', 'hub-leaders', 'hub-today-tokens', 'hub-today-damage',
    'hub-today-rank', 'hub-today-gold', 'hub-today-active', 'hub-today-potions',
    'hub-potion-fx',
  ];
  ids.forEach((id) => register(
    id,
    id === 'potion-confirm' ? 'dialog' : id === 'hub-potion-fx' ? 'canvas' : 'div',
  ));
  const avatar = register('avatar-trigger', 'button');
  avatar.className = 'hub-avatar-trigger';
  register('hub-gold').attributes.set('data-hub-gold', '');
  const filterAll = register('hub-filter-all', 'button');
  filterAll.dataset.filter = 'all';
  const filterPotions = register('hub-filter-potions', 'button');
  filterPotions.dataset.filter = 'potions';
  document.getElementById('hub-avatar-wrap')!.append(avatar);
  document.getElementById('hub-effects')!.append(
    document.getElementById('hub-effects-close')!,
  );
  document.getElementById('hub-avatar-wrap')!.append(
    document.getElementById('hub-effects')!,
  );
  document.getElementById('hub-item-detail')!.append(
    document.getElementById('hub-item-detail-empty')!,
    document.getElementById('hub-item-detail-content')!,
  );

  const initialState: HubState = {
    gold: 450_000,
    activationTiming: options.activationTiming ?? 'starts_now',
    inventory: [
      {
        sku: 'potion_gold_t1', name: 'Beginner Gold Potion', potionType: 'gold', tier: 1,
        quantity: 2, durationMs: 7_200_000, iconClass: 'potion-gold',
        effectCopy: '50g per 1,000 effective tokens', usesRemaining: 2,
        nextResetAt: Date.parse('2026-07-30T04:00:00Z'),
      },
      {
        sku: 'potion_damage_t1', name: 'Beginner Damage Potion', potionType: 'damage', tier: 1,
        quantity: 1, durationMs: 7_200_000, iconClass: 'potion-damage',
        effectCopy: '+25% personal base hit', usesRemaining: 3,
        nextResetAt: Date.parse('2026-07-30T04:00:00Z'),
      },
    ],
    effects: [
      {
        kind: 'gold', iconClass: 'potion-gold', title: 'Beginner Gold Potion',
        description: '50g per 1,000 effective tokens', remainingMs: 3_600_000,
        tier: 1, state: 'paused', progress: { value: 500_000, max: 2_500_000 },
      },
      {
        kind: 'debuff', iconClass: 'effect-debuff', title: 'Monster Hex',
        description: '15% less damage', remainingMs: 4_000,
      },
    ],
    today: {
      effectiveTokens: 1_000, damage: 200, fightRank: 2, goldEarned: 300,
      combatActiveMs: 3_600_000, potionsUsed: 1,
    },
    currentFight: { leaders: [{ playerId: 2, name: 'Rogue', damage: 900 }] },
  };
  const refreshed: HubState = {
    ...initialState,
    gold: 451_000,
    inventory: initialState.inventory.filter((item) => item.sku === 'potion_gold_t1'),
    effects: [...initialState.effects, {
      kind: 'damage', iconClass: 'potion-damage', title: 'Beginner Damage Potion',
      description: '+25% personal base hit', remainingMs: 7_200_000, tier: 1, state: 'armed',
    }],
    today: { ...initialState.today, potionsUsed: 2 },
  };
  const fetchCalls: Array<{ url: string; options: Record<string, any> }> = [];
  const responses: HarnessResponse[] = options.responses ?? [
    { ok: true, json: async () => ({
      ok: true, duplicate: false, potionType: 'damage', inventoryRemaining: 0,
      usesRemaining: 2, state: 'armed',
    }) },
    { ok: true, json: async () => refreshed },
  ];
  const intervals: Array<{ callback: () => unknown; delay: number }> = [];
  const timers: Array<() => unknown> = [];
  const animationFrames: Array<{ id: number; callback: (time: number) => unknown }> = [];
  const cancelledFrames: number[] = [];
  const potionFxInputs: Array<Record<string, unknown>> = [];
  const potionCanvasCalls: Array<{ method: string; args: unknown[] }> = [];
  const reducedMotionListeners: Array<() => unknown> = [];
  const reducedMotionQuery = {
    matches: options.reducedMotion ?? false,
    addEventListener(type: string, listener: () => unknown) {
      if (type === 'change') reducedMotionListeners.push(listener);
    },
  };
  const potionCanvas = document.getElementById('hub-potion-fx')!;
  potionCanvas.canvasContext = {
    clearRect(...args: unknown[]) { potionCanvasCalls.push({ method: 'clearRect', args }); },
    fillRect(...args: unknown[]) { potionCanvasCalls.push({ method: 'fillRect', args }); },
    save() { potionCanvasCalls.push({ method: 'save', args: [] }); },
    restore() { potionCanvasCalls.push({ method: 'restore', args: [] }); },
    globalAlpha: 1,
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
  };
  const context: Record<string, any> = {
    document,
    __PLAYER_HUB__: {
      playerId: 42,
      token: 'secret-token',
      initialState,
      endpoints: { state: '/character/state?token=secret-token', activate: '/character/potions/activate' },
    },
    fetch: async (url: string, options: Record<string, any> = {}) => {
      fetchCalls.push({ url, options });
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      if (response instanceof Error) throw response;
      return response;
    },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    URLSearchParams,
    Intl,
    Date,
    setInterval(callback: () => unknown, delay: number) { intervals.push({ callback, delay }); return 1; },
    setTimeout(callback: () => unknown) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    matchMedia: () => reducedMotionQuery,
    requestAnimationFrame(callback: (time: number) => unknown) {
      const id = animationFrames.length + 1;
      animationFrames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id: number) { cancelledFrames.push(id); },
    ClaudeRpgPotionFx: {
      frame(input: Record<string, unknown>) {
        potionFxInputs.push(input);
        return [{ type: 'gold', color: '#f1c75b', dx: 1, dy: -2, size: 2, alpha: 1 }];
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return {
    document, context, fetchCalls, responses, intervals, initialState, refreshed, avatar,
    animationFrames, cancelledFrames, potionFxInputs, potionCanvasCalls,
    reducedMotionQuery, reducedMotionListeners,
  };
}

describe('mounted player hub tabs', () => {
  it('switches panels without replacing the Wardrobe preview or dirty draft', () => {
    const h = tabHarness();
    const preview = h.preview;
    const draft = h.dirtyDraft;
    h.wardrobe.dispatch('click');
    h.inventory.dispatch('click');
    h.wardrobe.dispatch('click');
    expect(h.wardrobe.getAttribute('aria-selected')).toBe('true');
    expect(h.wardrobe.tabIndex).toBe(0);
    expect(h.wardrobePanel.hidden).toBe(false);
    expect(h.livePanel.hidden).toBe(true);
    expect(h.document.getElementById('dye-preview')).toBe(preview);
    expect((h.context.__DYE__ as { draft: object }).draft).toBe(draft);
  });

  it('supports ArrowLeft, ArrowRight, Home, and End with focus', () => {
    const h = tabHarness();
    expect(h.live.dispatch('keydown', new FakeEvent('ArrowRight')).defaultPrevented).toBe(true);
    expect(h.inventory.getAttribute('aria-selected')).toBe('true');
    expect(h.inventory.focusCount).toBe(1);
    h.inventory.dispatch('keydown', new FakeEvent('End'));
    expect(h.wardrobe.getAttribute('aria-selected')).toBe('true');
    h.wardrobe.dispatch('keydown', new FakeEvent('ArrowRight'));
    expect(h.live.getAttribute('aria-selected')).toBe('true');
    h.live.dispatch('keydown', new FakeEvent('ArrowLeft'));
    expect(h.wardrobe.getAttribute('aria-selected')).toBe('true');
    h.wardrobe.dispatch('keydown', new FakeEvent('Home'));
    expect(h.live.getAttribute('aria-selected')).toBe('true');
  });
});

describe('player hub inventory, effects, and refresh behavior', () => {
  it('selects one reusable detail panel, confirms once, and refreshes without touching Wardrobe', async () => {
    const h = interactionHarness();
    const grid = h.document.getElementById('hub-inventory-grid')!;
    const detail = h.document.getElementById('hub-item-detail')!;
    const wardrobe = h.document.register(new FakeElement('hub-wardrobe'));
    const damage = grid.querySelectorAll('[data-sku]')
      .find((button) => button.dataset.sku === 'potion_damage_t1')!;

    grid.dispatch('click', new FakeEvent('', damage));
    expect(detail.dataset.selectedSku).toBe('potion_damage_t1');
    expect(h.document.getElementById('hub-item-detail-effect')!.textContent)
      .toBe('+25% personal base hit');

    h.document.getElementById('hub-potion-drink')!.dispatch('click');
    const dialog = h.document.getElementById('potion-confirm')!;
    expect(dialog.open).toBe(true);
    expect(h.document.getElementById('potion-confirm-inventory')!.textContent).toBe('1 → 0 owned');
    expect(h.document.getElementById('potion-confirm-copy')!.textContent).toContain('Starts now');
    expect(h.fetchCalls).toHaveLength(0);

    await h.document.getElementById('potion-confirm-drink')!.dispatchAsync('click');
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[0].url).toBe('/character/potions/activate');
    expect(String(h.fetchCalls[0].options.body)).toContain('request_id=11111111-1111-4111-8111-111111111111');
    expect(h.fetchCalls[1].url).toContain('/character/state');
    expect(h.document.getElementById('hub-potion-feedback')!.textContent).toContain('waits for battle');
    expect(h.document.getElementById('hub-bottle-burst')!.classList.contains('is-bursting')).toBe(true);
    expect(h.document.getElementById('hub-today-potions')!.textContent).toBe('2');
    expect(h.document.getElementById('hub-wardrobe')).toBe(wardrobe);
  });

  it('opens effects on hover/focus, pins on click, and closes with Escape', () => {
    const h = interactionHarness();
    const effects = h.document.getElementById('hub-effects')!;
    effects.hidden = true;
    h.avatar.dispatch('pointerenter');
    expect(effects.hidden).toBe(false);
    h.document.getElementById('hub-avatar-wrap')!.dispatch('pointerleave');
    expect(effects.hidden).toBe(true);
    h.avatar.dispatch('click');
    h.document.getElementById('hub-avatar-wrap')!.dispatch('pointerleave');
    expect(effects.hidden).toBe(false);
    h.document.dispatch('keydown', new FakeEvent('Escape'));
    expect(effects.hidden).toBe(true);
    expect(h.avatar.focusCount).toBe(1);
    h.avatar.dispatch('pointerenter');
    h.document.getElementById('hub-effects-close')!.dispatch('click');
    expect(effects.hidden).toBe(true);
    expect(h.avatar.focusCount).toBe(2);
  });

  it('keeps an unpinned effects popover open on pointer leave while focus stays within the avatar', () => {
    const h = interactionHarness();
    const effects = h.document.getElementById('hub-effects')!;
    const avatarWrap = h.document.getElementById('hub-avatar-wrap')!;
    effects.hidden = true;

    h.avatar.focus();
    h.avatar.dispatch('focus');
    expect(effects.hidden).toBe(false);
    avatarWrap.dispatch('pointerleave');
    expect(effects.hidden).toBe(false);

    avatarWrap.dispatch('focusout', new FakeEvent('', avatarWrap, null));
    expect(effects.hidden).toBe(true);
  });

  it('keeps a bottle corked without a request and restores rejected actions with thematic feedback', async () => {
    const rejected = interactionHarness({ responses: [{
        ok: false,
        json: async () => ({ ok: false, reason: 'type_active' }),
      }],
    });
    const grid = rejected.document.getElementById('hub-inventory-grid')!;
    const damage = grid.querySelectorAll('[data-sku]')
      .find((button) => button.dataset.sku === 'potion_damage_t1')!;
    grid.dispatch('click', new FakeEvent('', damage));
    rejected.document.getElementById('hub-potion-drink')!.dispatch('click');
    rejected.document.getElementById('potion-confirm-keep')!.dispatch('click');
    expect(rejected.fetchCalls).toHaveLength(0);
    expect(rejected.document.getElementById('potion-confirm')!.hidden).toBe(true);

    rejected.document.getElementById('hub-potion-drink')!.dispatch('click');
    await rejected.document.getElementById('potion-confirm-drink')!.dispatchAsync('click');
    expect(rejected.fetchCalls).toHaveLength(1);
    expect(rejected.document.getElementById('potion-confirm-drink')!.disabled).toBe(false);
    expect(rejected.document.getElementById('hub-potion-feedback')!.textContent)
      .toContain('already flowing');
    expect(rejected.document.getElementById('hub-bottle-burst')!.classList.contains('is-bursting'))
      .toBe(false);
  });

  it('freezes confirmed SKU and UUID across a lost reply and a state refresh', async () => {
    const h = interactionHarness({ responses: [new Error('reply lost')] });
    const grid = h.document.getElementById('hub-inventory-grid')!;
    const damage = grid.querySelectorAll('[data-sku]')
      .find((button) => button.dataset.sku === 'potion_damage_t1')!;
    grid.dispatch('click', new FakeEvent('', damage));
    h.document.getElementById('hub-potion-drink')!.dispatch('click');

    await h.document.getElementById('potion-confirm-drink')!.dispatchAsync('click');
    expect(h.fetchCalls).toHaveLength(1);

    const withoutDamage: HubState = {
      ...h.initialState,
      activationTiming: 'waits_for_battle',
      inventory: h.initialState.inventory.filter((item) => item.sku === 'potion_gold_t1'),
    };
    h.responses.push(
      { ok: true, json: async () => withoutDamage },
      { ok: true, json: async () => ({
        ok: true, duplicate: true, potionType: 'damage', inventoryRemaining: 0,
        usesRemaining: 2, state: 'armed',
      }) },
      { ok: true, json: async () => withoutDamage },
    );
    await h.intervals[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.document.getElementById('hub-item-detail')!.dataset.selectedSku).toBe('potion_gold_t1');

    await h.document.getElementById('potion-confirm-drink')!.dispatchAsync('click');
    const firstBody = String(h.fetchCalls[0].options.body);
    const retryBody = String(h.fetchCalls[2].options.body);
    expect(firstBody).toContain('sku=potion_damage_t1');
    expect(retryBody).toContain('sku=potion_damage_t1');
    expect(retryBody).toBe(firstBody);
  });

  it('shows Waits for battle before submission and suppresses the burst for reduced motion', async () => {
    const h = interactionHarness({ activationTiming: 'waits_for_battle', reducedMotion: true });
    const grid = h.document.getElementById('hub-inventory-grid')!;
    const damage = grid.querySelectorAll('[data-sku]')
      .find((button) => button.dataset.sku === 'potion_damage_t1')!;
    grid.dispatch('click', new FakeEvent('', damage));
    h.document.getElementById('hub-potion-drink')!.dispatch('click');
    expect(h.document.getElementById('potion-confirm-copy')!.textContent).toContain('Waits for battle');
    await h.document.getElementById('potion-confirm-drink')!.dispatchAsync('click');
    expect(h.document.getElementById('hub-bottle-burst')!.classList.contains('is-bursting'))
      .toBe(false);
    expect(h.animationFrames).toHaveLength(0);
  });

  it('reuses the shared active-potion motes on the profile and omits armed effects', () => {
    const h = interactionHarness();

    expect(h.animationFrames).toHaveLength(1);
    h.animationFrames[0].callback(1_234);

    expect(h.potionFxInputs[0]).toEqual({
      playerId: 42,
      goldTier: 1,
      damageTier: null,
      timeMs: 1_234,
    });
    expect(h.potionCanvasCalls.some((call) => call.method === 'fillRect')).toBe(true);
  });

  it('redraws the profile only when the shared 120ms mote step changes', () => {
    const h = interactionHarness();

    h.animationFrames[0].callback(1_234);
    h.animationFrames[1].callback(1_235);
    expect(h.potionFxInputs).toHaveLength(1);

    h.animationFrames[2].callback(1_320);
    expect(h.potionFxInputs).toHaveLength(2);
  });

  it('cancels and resumes one profile loop across visibility and reduced-motion changes', async () => {
    const h = interactionHarness();
    h.document.visibilityState = 'hidden';
    h.document.dispatch('visibilitychange');
    expect(h.cancelledFrames).toContain(1);

    h.responses.splice(0, h.responses.length, { ok: true, json: async () => h.initialState });
    h.document.visibilityState = 'visible';
    h.document.dispatch('visibilitychange');
    expect(h.animationFrames).toHaveLength(2);

    h.reducedMotionQuery.matches = true;
    h.reducedMotionListeners[0]();
    expect(h.cancelledFrames).toContain(2);

    h.reducedMotionQuery.matches = false;
    h.reducedMotionListeners[0]();
    expect(h.animationFrames).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('stops and clears the profile mote loop when no started potion remains', async () => {
    const h = interactionHarness();
    const noPotions: HubState = { ...h.initialState, effects: h.initialState.effects.filter((effect) => effect.kind === 'debuff') };
    h.responses.splice(0, h.responses.length, { ok: true, json: async () => noPotions });

    await h.intervals[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.cancelledFrames).toContain(1);
    expect(h.potionCanvasCalls.some((call) => call.method === 'clearRect')).toBe(true);
  });

  it('polls every five seconds only while visible and refreshes immediately on return', async () => {
    const h = interactionHarness();
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].delay).toBe(5_000);
    h.document.visibilityState = 'hidden';
    await h.intervals[0].callback();
    await Promise.resolve();
    expect(h.fetchCalls).toHaveLength(0);

    h.document.visibilityState = 'visible';
    await h.document.dispatchAsync('visibilitychange');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fetchCalls[0].url).toContain('/character/state');
  });
});
