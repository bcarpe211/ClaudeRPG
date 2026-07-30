# Inventory Detail Card Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wide potion-detail ledger exactly match the 288px inventory-room height while keeping its icon, title, labels, values, and action position stable across potion selections.

**Architecture:** Keep the Inventory markup, data flow, and interaction code unchanged. Tighten only the player-hub CSS: use a shared 70px/remaining-space ledger grid for the header and metadata, a full-height flex content column for bottom anchoring, and a container-query override that restores automatic card height when Inventory stacks.

**Tech Stack:** CSS Grid, CSS Flexbox, container queries, Vitest source-contract tests, local in-app browser verification

## Global Constraints

- Keep the approved 432×288px wide inventory room unchanged.
- The wide `.hub-item-detail` border box is exactly 288px tall with 12px padding.
- Header and metadata use the same `70px minmax(0,1fr)` columns with a 10px column gap.
- The header icon is left-aligned in the first column and must not inherit automatic margins.
- Tier/title starts at exactly the same horizontal coordinate as metadata values.
- Metadata uses an 11px font, 5px row gaps, and a 10px top margin.
- Active progress uses an 8px top margin and 7px padding.
- The action button is bottom-anchored at wide widths and does not move when progress copy changes length.
- At `@container (max-width:739px)`, the card/content return to automatic height and the action button returns to a 14px top margin.
- Keep the separate 520px room-geometry switch, all inventory atlas rules, potion behavior, polling, activation, copy, focus, and disabled states unchanged.
- Do not truncate product names, effects, progress copy, or button labels.
- Production and Raspberry Pi changes are out of scope.

---

### Task 1: Pin the potion-detail ledger geometry and columns

**Files:**
- Modify: `tests/player-hub-css.test.ts:45-75`
- Modify: `src/web/public/player-hub.css:108-125,131-136`

**Interfaces:**
- Consumes: existing `.hub-inventory-layout`, `.hub-inventory-room`, `.hub-item-detail`, `#hub-item-detail-content`, `.hub-item-detail-head`, `.hub-item-icon`, metadata `<dl>`, `.hub-item-active-progress`, and `.hub-item-detail .btn` markup.
- Produces: a 288px wide-layout card, stable shared header/metadata columns, a bottom-anchored action, and automatic-height stacked behavior. No HTML or JavaScript interface changes.

- [ ] **Step 1: Add a failing CSS behavior contract**

Append this test inside `describe('player hub layout CSS', ...)` in `tests/player-hub-css.test.ts`:

```ts
it('keeps the wide potion ledger aligned with the inventory room', () => {
  const constrainedPanel = css.slice(
    css.indexOf('@container (max-width:739px)'),
    css.indexOf('@container (max-width:520px)'),
  );

  expect(css).toMatch(/\.hub-item-detail\{[^}]*box-sizing:border-box[^}]*height:288px[^}]*min-height:0[^}]*padding:12px/);
  expect(css).toMatch(/#hub-item-detail-content\{[^}]*display:flex[^}]*height:100%[^}]*min-height:0[^}]*flex-direction:column/);
  expect(css).toMatch(/\.hub-item-detail-head\{[^}]*display:grid[^}]*grid-template-columns:70px minmax\(0,1fr\)[^}]*gap:10px/);
  expect(css).toMatch(/\.hub-item-detail-head \.hub-item-icon\{[^}]*justify-self:start[^}]*margin:0/);
  expect(css).toMatch(/\.hub-item-detail h3\{[^}]*font-size:16px[^}]*line-height:1\.2/);
  expect(css).toMatch(/\.hub-item-detail dl\{[^}]*grid-template-columns:70px minmax\(0,1fr\)[^}]*gap:5px 10px[^}]*margin:10px 0 0[^}]*font-size:11px/);
  expect(css).toMatch(/\.hub-item-active-progress\{[^}]*margin-top:8px[^}]*padding:7px/);
  expect(css).toMatch(/\.hub-item-detail \.btn\{[^}]*width:100%[^}]*margin-top:auto/);
  expect(constrainedPanel).toMatch(/\.hub-item-detail\{[^}]*height:auto[^}]*min-height:190px/);
  expect(constrainedPanel).toMatch(/#hub-item-detail-content\{[^}]*height:auto/);
  expect(constrainedPanel).toMatch(/\.hub-item-detail \.btn\{[^}]*margin-top:14px/);
});
```

The production change this test catches is removal of the fixed 288px card, reintroduction of automatic icon margins or intrinsic header placement, divergence between the header/value columns, loss of bottom anchoring, or failure to release the fixed height after the responsive stack.

- [ ] **Step 2: Run the CSS test and verify RED**

Run:

```bash
npm test -- tests/player-hub-css.test.ts
```

Expected: FAIL only in `keeps the wide potion ledger aligned with the inventory room`; the current card has `min-height:190px`, 16px padding, flex header placement, automatic icon margins, auto metadata columns, and no wide/stacked height contract.

- [ ] **Step 3: Implement the fixed ledger geometry**

In `src/web/public/player-hub.css`, replace the existing detail-card rules with:

```css
.hub-item-detail{box-sizing:border-box;height:288px;min-height:0;padding:12px;border:1px solid var(--line);border-radius:11px;background:linear-gradient(180deg,#20142e,#100b18)}
#hub-item-detail-content{display:flex;height:100%;min-height:0;flex-direction:column}
.hub-item-detail-head{display:grid;grid-template-columns:70px minmax(0,1fr);gap:10px;align-items:center;min-height:38px}
.hub-item-detail-head .hub-item-icon{justify-self:start;margin:0}
.hub-item-detail h3{margin:0 0 3px;font-size:16px;line-height:1.2}
.hub-item-tier{color:var(--gold);font:850 9px/1 ui-monospace,monospace;text-transform:uppercase}
.hub-item-detail dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:5px 10px;margin:10px 0 0;font-size:11px}
.hub-item-detail dt{color:var(--muted)}
.hub-item-detail dd{margin:0;color:var(--head)}
.hub-item-detail [hidden]{display:none}
.hub-item-detail .btn{width:100%;margin-top:auto}
.hub-item-active-progress{margin-top:8px;padding:7px;border:1px solid #5d4930;border-radius:7px;background:#e5bf5510;color:var(--gold2);font-size:10px}
```

Do not change `.hub-item-icon` itself; the scoped header override preserves centered icons inside 48px inventory cells.

Inside the existing `@container (max-width:739px)` block, after the Inventory one-column rule, add:

```css
.hub-item-detail{height:auto;min-height:190px}
#hub-item-detail-content{height:auto}
.hub-item-detail .btn{margin-top:14px}
```

Do not move these rules into the 520px block: automatic detail-card height begins whenever the two-column Inventory layout stacks.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/player-hub-css.test.ts tests/player-hub-client.test.ts tests/web-character.test.ts
```

Expected: PASS, 35 tests total. The existing corrupt-class 500-response test may emit its intentional request-error diagnostic while still passing.

- [ ] **Step 5: Run full static verification**

Run each command separately:

```bash
npm test
npm run typecheck
node --check src/web/public/player-hub.js
git diff --check
```

Expected: 127 test files and 1,402 tests pass; typecheck, browser JavaScript syntax, and diff checks exit 0.

- [ ] **Step 6: Verify Gold and Damage geometry in the local browser**

Use the existing local review server at:

```text
http://localhost:8120/character?token=local-potion-demo-3
```

At 1280×720, open Inventory and record `getBoundingClientRect()` values for `.hub-inventory-room`, `.hub-item-detail`, `.hub-item-detail-head .hub-item-icon`, `.hub-item-detail-head h3`, `.hub-item-detail dt`, `.hub-item-detail dd`, and `.hub-item-detail .btn` for both Beginner Gold Potion and Beginner Damage Potion.

Confirm:

- room and detail `top`/`bottom` differ by no more than 0.5px;
- Gold and Damage icon `left` values are identical;
- Gold and Damage title `left` values are identical;
- title `left` equals metadata value `left` within 0.5px;
- metadata label `left` is stable between both potions;
- `scrollHeight <= clientHeight` for the detail card and content;
- the action button stays inside the card and its `bottom` value is identical for both potions.

At 810×998, confirm Inventory remains stacked, the detail card begins 14px below the room, the card height is automatic, and no horizontal or vertical overlap occurs.

- [ ] **Step 7: Commit the verified presentation fix**

```bash
git add tests/player-hub-css.test.ts src/web/public/player-hub.css
git commit -m "style(player): align inventory potion details"
```
