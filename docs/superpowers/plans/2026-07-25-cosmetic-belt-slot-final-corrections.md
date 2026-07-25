# Cosmetic Belt Slot and Final Pixel Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent Belt material and apply the approved Knight, Thief, Ranger, Wizard, Shaman, Berserker, Swordsman, and Paladin slot-map corrections in both animation frames.

**Architecture:** Append Belt as slot `12` so ids `0..11` and existing saved rules remain unchanged. Correct authored male maps, record female-only differences as explicit overrides, regenerate all female maps deterministically, and prove every boundary with position-specific tests before presenting the animated roster again.

**Tech Stack:** TypeScript, Vitest, PNGJS, Express/Zod, committed 24x24 legend PNG slot maps.

## Global Constraints

- Preserve all existing slot ids; `SLOTS.belt` is appended as `12`.
- Slot `0` remains fixed/outline and is never recolored.
- Belt and Trim are independent whenever both appear on one sprite.
- Male maps are authored artifacts; female maps are generated from male maps plus `FEMALE_OVERRIDES`.
- Every correction covers frames A and B unless the source pixel exists in only one frame.
- Do not begin cosmetic tier products, timed consumables, deployment, merge, or push.
- Phase 2C remains open until the user approves the refreshed animated roster.

---

### Task 1: Extend the slot taxonomy with Belt

**Files:**
- Modify: `src/domain/slots.ts`
- Modify: `src/web/routes/character.ts`
- Modify: `src/web/routes/cosmetics-review.ts`
- Modify: `tools/transfer-female-slotmaps.ts`
- Test: `tests/slots.test.ts`
- Test: `tests/slots-present.test.ts`
- Test: `tests/web-dye.test.ts`
- Test: `tests/web-cosmetics-review.test.ts`
- Test: `tests/transfer-female-slotmaps.test.ts`

**Interfaces:**
- Produces: `SLOTS.belt === 12`, `MAX_RECOLOR_SLOT === SLOTS.belt`, legend RGB `[127, 127, 127]`, label `Belt`, and a picker entry after Trim.

- [ ] **Step 1: Write failing taxonomy and request-validation tests**

Assert 13 total slots, 12 legend/picker entries, a unique Belt legend color,
`SLOT_LABELS[SLOTS.belt] === 'Belt'`, review rendering accepts slot `12`, and
character dye routes parse an authored slot `12` instead of rejecting it at
Zod validation.

- [ ] **Step 2: Run tests and verify the expected failures**

Run:

```bash
npm test -- tests/slots.test.ts tests/slots-present.test.ts tests/web-dye.test.ts tests/web-cosmetics-review.test.ts tests/transfer-female-slotmaps.test.ts
```

Expected: failures because Belt and `MAX_RECOLOR_SLOT` do not exist and both web
schemas stop at `11`.

- [ ] **Step 3: Append Belt without renumbering existing slots**

In `src/domain/slots.ts` append:

```ts
belt: 12,
export const MAX_RECOLOR_SLOT = SLOTS.belt;
```

Add `[SLOTS.belt, [127, 127, 127]]` to `LEGEND`, add `Belt` to
`SLOT_LABELS`, and place `SLOTS.belt` immediately after `SLOTS.trim` in
`PICKER_ORDER`. Replace hard-coded `11`/`SLOTS.flair` range maxima in the two
routes and transfer validation with `MAX_RECOLOR_SLOT`.

- [ ] **Step 4: Run the focused taxonomy tests**

Expected: taxonomy, validation, and transfer tests pass before any map contains
the new slot.

---

### Task 2: Define the corrected inventory and player-facing labels

**Files:**
- Modify: `src/domain/cosmeticsreview.ts`
- Modify: `src/domain/dye.ts`
- Test: `tests/cosmeticsreview.test.ts`
- Test: `tests/dye.test.ts`

**Interfaces:**
- Consumes: `SLOTS.belt` and picker order from Task 1.
- Produces: exact warning-free channel inventories and semantic labels.

- [ ] **Step 1: Write failing inventory and label tests**

Require:

- Knight: Belt replaces Trim.
- Thief and Ranger: both Trim and Belt.
- Wizard: Gold trim uses Trim, Belt uses Belt, and the old Cape alias disappears.
- Priest: Belt replaces Trim.
- Paladin female: Hair is present in addition to Lips.
- Default Belt label is `Belt`; Wizard Trim is `Gold trim`; Thief/Ranger Trim
  remains `Trim`.

- [ ] **Step 2: Run the inventory tests and verify failures**

Run:

```bash
npm test -- tests/cosmeticsreview.test.ts tests/dye.test.ts
```

Expected: failures against the old alias-based inventory.

- [ ] **Step 3: Update `EXPECTED_CHANNELS` and label overrides**

Remove the class overrides that rename Trim to Belt. Set Wizard Trim to
`Gold trim`; let Belt use its global label. Add Paladin female Hair.

- [ ] **Step 4: Keep tests red until map artifacts match the new inventory**

Label-only assertions pass; roster assertions still report missing/unexpected
channels until Task 4 rewrites maps.

---

### Task 3: Add positional regression coverage for every reported pixel

**Files:**
- Modify: `tests/slotmap-collisions.test.ts`
- Modify: `tests/slotmap-integrity.test.ts`

**Interfaces:**
- Produces: source-color-anchored fixtures for every corrected coordinate.

- [ ] **Step 1: Change existing fixtures to their approved slots**

Use these frame coordinates:

| Boundary | Frame A | Frame B | Slot |
|---|---|---|---|
| Knight sword hilt | `(3,17)`, `(4,17)` | `(3,18)`, `(4,18)` | Weapon |
| Knight belt | `(8..10,17)` | `(8..10,18)` | Belt |
| Thief belt | `(8,17)`, `(9,17)`, `(11..13,17)` | `(8,18)`, `(9,18)`, `(11..13,18)` | Belt |
| Ranger belt | `(8,17)`, `(9,17)`, `(12..14,17)` | `(8,17)`, `(9,17)`, `(11,17)`, `(13,17)`, `(14,17)` | Belt |
| Ranger gold edging | every `#eaff00` Cape coordinate | every `#eaff00` Cape coordinate | Trim |
| Ranger back rectangle | `(16,17..19)` | `(16,17..19)` | Cape |
| Wizard belt | `(8..14,17)` | `(8..14,18)` | Belt |
| Wizard gold edging | every current Cape coordinate | every current Cape coordinate | Trim |
| Wizard grey clothing | `(8..10,20)`, `(7,21)`, `(11,21)`, `(12,22)` | same | Clothing |
| Priest belt | `(9..13,17)` | `(9..13,18)` | Belt |
| Shaman pelt by left hand | `(6,13)`, `(6,15)` | `(6,13)`, `(6,15)` | Pelt/Headgear |
| Shaman dark pelt pixel | `(16,13)` | `(16,14)` | Pelt/Headgear |
| Shaman exposed pelt pixel | `(17,20)` | already mapped at `(17,21)` | Pelt/Headgear |
| Berserker female omission | not present | `(15,20)` | Clothing |
| Paladin female gold hair | `(8,7)`, `(9,7)` | `(8,8)`, `(9,8)` | Hair |
| Swordsman hilt pixel | `(7,13)` | `(7,14)` | Weapon |

Move the Swordsman silver-trim sample to `(7,14)` / `(7,15)` so Trim remains
covered independently from the hilt.

- [ ] **Step 2: Run collision and integrity tests and verify failures**

Run:

```bash
npm test -- tests/slotmap-collisions.test.ts tests/slotmap-integrity.test.ts
```

Expected: failures identify the old map slots and missing Belt legend support.

---

### Task 4: Rewrite authored maps and regenerate female maps

**Files:**
- Modify: affected `slotmaps/*_M_[ab].png`
- Modify: all generated `slotmaps/*_F_[ab].png`
- Modify: `tools/transfer-female-slotmaps.ts`

**Interfaces:**
- Consumes: Belt legend and positional fixtures.
- Produces: deterministic 36-map roster matching `EXPECTED_CHANNELS`.

- [ ] **Step 1: Apply shared corrections to male frame maps**

Rewrite only the coordinates and contiguous regions listed in Task 3. Move all
Thief dark waist Trim pixels to Belt while preserving gold edging as Trim. Move
all Ranger `#eaff00` Cape pixels to Trim, waist Trim pixels to Belt, and the
three-pixel dark back rectangle from Weapon to Cape. Move Wizard Belt and Gold
trim out of their aliases and include all six grey lower-clothing pixels.

- [ ] **Step 2: Add female-only overrides**

Add Berserker frame-B `(15,20) -> body` and Paladin `(8,7)/(9,7)` plus frame-B
`(8,8)/(9,8) -> hair`. Preserve existing female Lips and hair overrides.

- [ ] **Step 3: Regenerate all female maps**

Run:

```bash
npx tsx tools/transfer-female-slotmaps.ts
```

- [ ] **Step 4: Run focused map and inventory verification**

Run:

```bash
npm test -- tests/slots.test.ts tests/slots-present.test.ts tests/dye.test.ts tests/cosmeticsreview.test.ts tests/slotmap-coverage.test.ts tests/slotmap-integrity.test.ts tests/slotmap-collisions.test.ts tests/web-dye.test.ts tests/web-cosmetics-review.test.ts tests/transfer-female-slotmaps.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck pass with zero roster warnings.

---

### Task 5: Animated review, full verification, and stop gate

**Files:**
- Verify only; no production deployment files.

- [ ] **Step 1: Refresh `http://localhost:8101/cosmetics-review`**

Verify all 18 variants render, animate through A/B, expose the corrected Belt
and Trim controls, and show no missing/unexpected inventory warnings.

- [ ] **Step 2: Inspect the corrected classes in Slots, Focus, and Hue modes**

Verify Knight, Thief, Ranger, Wizard, Shaman, Berserker female, Swordsman, and
Paladin female in both frames. Confirm adjacent skin, outline, weapons, capes,
hair, and garment trim do not move with the corrected channel.

- [ ] **Step 3: Run fresh full verification**

```bash
npm test
npm run typecheck
node --check src/web/public/anim.js
node --check src/web/public/cosmetics-review.js
git diff --check
```

- [ ] **Step 4: Commit one coherent correction batch**

```bash
git add docs src tools tests slotmaps
git commit -m "fix(cosmetics): separate belts and final slot details"
```

- [ ] **Step 5: Stop for user visual approval**

Do not mark Phase 2C complete, merge, push, deploy, or begin cosmetic tiers.
