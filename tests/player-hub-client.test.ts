import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  constructor(readonly key = '') {}
  preventDefault(): void { this.defaultPrevented = true; }
}

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  hidden = false;
  tabIndex = -1;
  focusCount = 0;

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event = new FakeEvent()): FakeEvent {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  focus(): void { this.focusCount += 1; }
}

function harness() {
  const live = new FakeElement('hub-tab-live');
  const inventory = new FakeElement('hub-tab-inventory');
  const wardrobe = new FakeElement('hub-tab-wardrobe');
  const livePanel = new FakeElement('hub-live');
  const inventoryPanel = new FakeElement('hub-inventory');
  const wardrobePanel = new FakeElement('hub-wardrobe');
  const preview = new FakeElement('dye-preview');
  const tabs = [live, inventory, wardrobe];
  const elements = new Map([
    [live.id, live], [inventory.id, inventory], [wardrobe.id, wardrobe],
    [livePanel.id, livePanel], [inventoryPanel.id, inventoryPanel],
    [wardrobePanel.id, wardrobePanel], [preview.id, preview],
  ]);
  for (const [tab, panel] of [[live, livePanel], [inventory, inventoryPanel], [wardrobe, wardrobePanel]] as const) {
    tab.setAttribute('aria-controls', panel.id);
    tab.setAttribute('aria-selected', tab === live ? 'true' : 'false');
    tab.tabIndex = tab === live ? 0 : -1;
    panel.hidden = tab !== live;
  }
  const dirtyDraft = { slots: new Map([[1, { hue: 210 }]]) };
  const context: Record<string, unknown> = {
    document: {
      querySelectorAll(selector: string) {
        return selector === '[role="tab"][aria-controls]' ? tabs : [];
      },
      getElementById(id: string) { return elements.get(id) ?? null; },
    },
    __DYE__: { draft: dirtyDraft },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync('src/web/public/player-hub.js', 'utf8'), context);
  return { live, inventory, wardrobe, livePanel, inventoryPanel, wardrobePanel, preview, dirtyDraft, context };
}

describe('mounted player hub tabs', () => {
  it('switches panels without replacing the Wardrobe preview or dirty draft', () => {
    const h = harness();
    const preview = h.preview;
    const draft = h.dirtyDraft;

    h.wardrobe.dispatch('click');
    h.inventory.dispatch('click');
    h.wardrobe.dispatch('click');

    expect(h.wardrobe.getAttribute('aria-selected')).toBe('true');
    expect(h.wardrobe.tabIndex).toBe(0);
    expect(h.wardrobePanel.hidden).toBe(false);
    expect(h.livePanel.hidden).toBe(true);
    expect((h.context.document as { getElementById(id: string): FakeElement }).getElementById('dye-preview')).toBe(preview);
    expect((h.context.__DYE__ as { draft: object }).draft).toBe(draft);
  });

  it('supports ArrowLeft, ArrowRight, Home, and End with focus', () => {
    const h = harness();

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
