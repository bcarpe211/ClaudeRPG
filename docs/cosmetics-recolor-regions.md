# Cosmetic Recolor Regions — per-character slot inventory

Reference for the sprite-tint / shop-cosmetics feature. Every hex below was read
from the **male** class sprites (authoritative art); female differences are noted
per slot. Female sprites currently mis-tint — see §7 (Known female bug).

## Frame / file model
Each character is **4 sprites** in `creatures_24x24` (`spriteFileIndex` in
`cosmetics.ts`: frame `b` = base+18; female base = male+9):

| | Frame A (idle/step 1) | Frame B (idle/step 2) |
|---|---|---|
| **Male** | `base` (1–9) | `base+18` (19–27) |
| **Female** | `base+9` (10–18) | `base+27` (28–36) |

A and B are the **same silhouette bobbed ~1px vertically** with tiny limb changes.
→ Any recolor mask authored on frame A maps to B with a small vertical offset;
author/verify masks on **both** frames (cheap — they're near-identical).

---

## 1. Three recolor operations (only #1 exists today)
`recolorSprite()` → `hueSwap()` replaces **hue**, keeps **S & V**. So:
- **Chromatic** pixels (S ≳ 0.15: blues, greens, reds, gold) → hue-swap works. ✅
- **Achromatic** pixels (S ≈ 0: steel, white, black, grey) → hue-swap does **nothing** (S=0 stays grey at any hue). ❌

To cover the full "white/grey/black/RGB" ask, add two transforms:
1. **HUE-SWAP** *(exists)* — chromatic garment → any RGB hue, shading preserved.
2. **COLORIZE** *(add)* — achromatic region → pick hue, inject S≈0.5–0.7, keep source V. Turns white robe / steel plate / grey fur any RGB color.
3. **VALUE-REMAP** *(add)* — achromatic region → keep S=0, remap V. The literal white↔grey↔black finish sweep (holy-white ↔ silver ↔ gunmetal ↔ blackened iron).

Same per-pixel loop as today; each gated on a per-slot hex set (+ mask where noted).

## 2. Shared "system" ramps (recur in every class → best as global channels)
| Ramp | Hex | Type | Use |
|---|---|---|---|
| **Outline** | `#262626`, `#1b1b1b` | achrom | linework — **never tint** |
| **Skin** | `#fc9838` mid · `#b86e28` shadow · `#ffd1a6` hi | chrom (orange) | **Skin channel — curated tones only, not a 360° wheel** |
| **Gold/brass trim** | `#887000` · `#b89600` · `#5d4b00` · `#eaff00`/`#b4c21d` bright | chrom (H49–65) | **Trim channel** — buckles, staves, bow, pommels, plumes |
| **Steel/white** | `#f3f3f3 #ffffff #c9c9c9 #bdbdbd #919191 #9c9c9c #696969 #616060 #595959 #3d3d3d` | **achrom** | **Metal channel** — blades, plate, shields, white robes (needs colorize/value) |

### Color collisions (exact-hex match CANNOT separate these → require a mask)
- **Blonde hair == gold trim ramp.** Hair, belt, boots, cape, staff all share `#887000`/`#eaff00`.
- **Dark hair == outline black** (`#262626`/`#3d3d3d`) — swordsman.
- **Leather brown `#b86e28` == skin-shadow hex** — thief, swordsman, ranger bow.
- **White plate == white robe == white shield-cross == white boots** — one hex, several slots (priest, paladin).

---

## 3. Per-character slot inventories
Type: **hue** = chromatic (works today) · **colorize/value** = achromatic (needs new op).
M/F = present on male / female. ⭐ = the slot that most defines the class.
"mask" = needs a spatial mask because its hex collides with another slot.

### 1 · Knight (base 1) — blue man-at-arms
| Slot | Element | Hex / ramp | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Cap + tunic | head cloth + torso | `#3cbcfc #9adcfd #2985b2` | hue | ✓ | ✓→red | ⭐ primary; group cap+tunic |
| Cape (back) | cloth behind head, hangs behind shield | gold ramp | hue | ✓ | ✓ | mask (gold collision) |
| Hair | — | blonde/gold | — | — | ✓ | **male has none**; mask |
| Sword blade | left vertical bar | steel | colorize/value | ✓ | ✓ | |
| Shield | round, front-right | steel | colorize/value | ✓ | ✓ | big surface |
| Belt + boots | waist + bottom row | gold ramp | hue | ✓ | ✓ | mask (gold) |
| Skin | face + hands | skin ramp | curated | ✓ | ✓ | |

### 2 · Thief (base 2) — green hood + cloak
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Cap + cloak | feathered cap + flowing cloak | `#1eba4a #24e35a` | hue | ✓ | ✓→teal | ⭐ primary |
| Feather | red plume on cap | `#cf3232 #ff3d3d` | hue | ✓ | ✓ | accent |
| Cloak lacing | yellow edge trim | `#eaff00` | hue | ✓ | ✓ | mask (gold) |
| Dagger | blade, upheld left | steel/white | colorize/value | ✓ | ✓ | |
| Hair | strand by cheek | gold | — | ✓sm | ✓ | mask |
| Tunic/pants | torso + legs | `#3d3d3d` dark | value | ✓ | ✓ | near-black |
| Boots | feet | grey | value/colorize | ✓ | ✓ | |
| Skin | face + hand | skin ramp | curated | ✓ | ✓ | |
| *absent* | — | — | — | | | no shield, no metal helmet |

### 3 · Ranger (base 3) — archer
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Hat | floppy cap | `#476575 #7c94a4` | hue (muted, low-sat) | ✓ | ✓ | ⭐ primary; desaturated → subtle sweep |
| Hair | under hat | blonde/gold | — | ✓ | ✓ | mask |
| Shirt | torso | `#cf3232` red | hue | ✓ | ✓ | 2nd garment |
| Bow | curved limbs | `#887000` wood | hue | ✓ | ✓ | mask (gold); weapon |
| Arrow | white shaft | steel/white | colorize/value | ✓ | ✓ | |
| Fletching/quiver | red dots | `#ff0000` | hue | ✓ | ✓ | accent |
| Pants/boots | legs | grey | value | ✓ | ✓ | |
| Skin | face + **bare arms** + hands | skin ramp | curated | ✓ | ✓ | large skin area |
| *absent* | — | — | — | | | no shield, no helmet, no cape |

### 4 · Wizard (base 4) — most reduced slot set
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Hood + robe | head + body | `#cf3232 #ff3d3d` | hue | ✓ | ✓→purple | ⭐ primary (dominant) |
| Robe trim/sash | edge lines | `#eaff00` | hue | ✓ | ✓ | mask (gold) |
| Staff | left | `#887000 #b89600` | hue | ✓ | ✓ | mask (gold); weapon |
| Eyes | glow in hood shadow | `#ff3d3d` | accent | ✓ | ✓ | tiny |
| Hand | on staff | skin | curated | ✓ | ✓ | only skin visible |
| Inner robe | shadow | `#3d3d3d` | value | ✓ | ✓ | |
| *absent* | — | — | — | | | **no hair, no face-skin, no boots, no shield, no armor, no cape** |

### 5 · Priest (base 5) — white robe ⚠ achromatic dominant
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Robe body | hood + body (dominant) | `#c9c9c9 #f3f3f3 #919191` | **colorize/value** | ✓ | ✓→maroon | ⭐ the defining garment — **not tintable today** |
| Cross + stole | red trim down front | `#cf3232` | hue | ✓ | ✓ | current tint target (trim only) |
| Cross emblem | on hood | `#919191` grey | mask | ✓ | ✓ | keep holy symbol distinct |
| Staff (ankh) | left | gold ramp | hue | ✓ | ✓ | mask (gold); weapon |
| Hair | — | blonde | — | — | ✓ | male none (hood); mask |
| Skin | face + hand | skin ramp | curated | ✓ | ✓ | |
| *absent* | — | — | — | | | no shield, no boots, no metal weapon |

### 6 · Shaman (base 6) — pelt hood + face paint
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Pelt-hood cloak | horned hood + body (dominant) | `#887000 #b89600` | hue | ✓ | ✓→grey | ⭐ primary; == gold ramp → mask to isolate from trim |
| **Face paint** | stripe across eyes | `#2985b2` | hue | ✓blue | ✓red | ⭐ the face-paint slot |
| Staff/spear | held | gold ramp | hue | ✓ | ✓ | weapon |
| Loincloth | waist | white | colorize/value | ✓ | ✓ | |
| Skin | face + **bare arms + legs** | skin ramp | curated | ✓ | ✓ | large skin area |
| Sandals | feet | dark grey | value | ✓ | ✓ | |
| *absent* | — | — | — | | | no shield, no metal helmet, hair hidden |

### 7 · Berserker (base 7) — horned helmet + axe
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Helmet | horned (dominant) | `#616060 #919191 #9c9c9c #c9c9c9` | **colorize/value** | ✓ | ✓→red | ⭐ achromatic — no hue channel today |
| Headband | stripe under helm | `#eaff00` | hue | ✓ | ✓ | mask (gold) |
| Axe blades | double bit | steel | colorize/value | ✓ | ✓ | weapon |
| Axe handle | shaft | `#887000` wood | hue | ✓ | ✓ | mask (gold) |
| Tunic/body | torso | `#887000` olive | hue | ✓ | ✓ | == gold ramp |
| Skin | face + arms | skin ramp | curated | ✓ | ✓ | |
| Pants/boots | legs | dark grey | value | ✓ | ✓ | |
| Cape | tail at back | red | hue | — | ✓ | female only |
| *absent* | — | — | — | | | no shield; hair hidden |

### 8 · Swordsman (base 8) — ⭐ visible male hair
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Hair | large, framing face | `#262626 #3d3d3d` | mask | ✓ | ✓ | ⭐ **male hair present**, but == outline hex → mask required |
| Shirt | torso | `#0e7cb3` | hue | ✓ | ✓→magenta | primary |
| Pauldron + belt | shoulder armor + straps | `#887000` | hue | ✓ | ✓ | mask (gold) |
| Sword + scabbard | upheld + back | steel | colorize/value | ✓ | ✓ | weapon |
| Boots/greaves | legs | grey | value | ✓ | ✓ | |
| Skin | face + **bare arms** | skin ramp | curated | ✓ | ✓ | |
| Earring / lips | flair | gold / red | accent | — | ✓ | female only |
| *absent* | — | — | — | | | no shield, no helmet, no cape |

### 9 · Paladin (base 9) — winged helm + cross shield (most slots)
| Slot | Element | Hex | Type | M | F | Notes |
|---|---|---|---|---|---|---|
| Helmet + wings | winged helm | `#f3f3f3 #ffffff #c9c9c9` | **colorize/value** | ✓ | ✓ | ⭐ wings are signature flair |
| Plume/crest | on helm | `#b4c21d` + gold | hue | ✓ | ✓ | flair |
| Shield field | large kite shield | `#0e7cb3 #0b5e87` | hue | ✓ | ✓→red | primary |
| Shield cross | emblem | `#ffffff` | mask | ✓ | ✓ | keep holy symbol distinct |
| Shield rim | border | steel | colorize/value | ✓ | ✓ | |
| Armor/tabard | body | `#887000` olive | hue | ✓ | ✓ | == gold ramp |
| Weapon | mace/sword upheld | steel | colorize/value | ✓ | ✓ | |
| Boots | feet | white | value | ✓ | ✓ | |
| Skin | face | skin ramp | curated | ✓ | ✓ | |
| *absent* | — | — | — | | | hair hidden; no cape |

---

## 4. UI channel presence matrix
Drives which cosmetic channels to **show/hide** per class (✓ show · — hide · **F** female-only).

| Class | Headgear | Hair | FacePaint | Cape | Body | Trim(gold) | Weapon | Shield | Boots | Skin | Flair |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Knight | ✓cloth | **F** | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Thief | ✓cloth | ✓ | — | ✓ | ✓(=cape) | ✓ | ✓ | — | ✓ | ✓ | ✓feather |
| Ranger | ✓cloth | ✓ | — | — | ✓ | ✓ | ✓bow | — | ✓ | ✓ | ✓fletch |
| Wizard | ✓(=body) | — | — | — | ✓ | ✓ | ✓staff | — | — | hand | ✓eyes |
| Priest | ✓(=body) | **F** | — | — | ✓⚠ | ✓ | ✓staff | — | — | ✓ | ✓cross |
| Shaman | ✓(=body) | — | ✓ | ✓(=body) | ✓ | ✓ | ✓staff | — | ✓ | ✓ | — |
| Berserker | ✓helm⚠ | — | — | **F** | ✓ | ✓ | ✓axe | — | ✓ | ✓ | ✓horns |
| Swordsman | — | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | **F**earring |
| Paladin | ✓helm | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓wings |

⚠ = the class's headgear/body is **achromatic** → its main channel needs colorize/value, not hue.

---

## 5. Recommended recolor-rule model (for the applying session)
Represent each class as an ordered list of slot rules:
```
{ slot, hexSet, region?: mask|bbox, op: 'hue'|'colorize'|'value' }
```
- **hexSet alone** resolves most slots.
- Add **region** only for the collision slots in §2 (blonde hair vs gold; dark hair vs outline; white robe vs white cross; leather vs skin).
- Author region masks per **frame** (A + B); B ≈ A shifted down ~1px, so start from A and nudge.
- **Skin** = a curated palette (e.g. 4–6 tones), never a free hue wheel.
- **Outline** is excluded from every slot.

Suggested exposed channels: **Primary** (hue on body/headgear), **Metal/armor**
(colorize+value on steel — biggest win; unlocks priest robe, berserker helm,
paladin plate, all blades/shields), **Trim** (hue on gold), **Cape/2nd**,
**Skin** (curated). **Hair** and **Face-paint** are per-class opt-ins (only where
present, and hair always needs a mask).

## 6. Implementation TODO
- Add `colorize()` and `valueRemap()` next to `hueSwap()` in `spritetint.ts`.
- Extend `CLOTHING` (`cosmetics.ts`) into per-slot rules with the hex sets above (add `steel`, `white`, `gold`, `skin` groups).
- Author collision masks (§2) for the ~10 slots that need them, per frame.
- Wire the presence matrix (§4) into the shop/character UI so absent channels are hidden.

## 7. Known female bug — root cause visible in the art
Every female sprite is a **palette-swapped variant with a different dominant hue**
than the male: knight blue→**red**, thief green→**teal**, wizard red→**purple**,
priest white→**maroon**, shaman gold→**grey**, berserker grey→**red**, swordsman
blue→**magenta**. The `CLOTHING` map's hexes are male-only, so on a female sprite
they **match nothing and the tint silently no-ops**. Whatever the rendering-side
female bug is, the tint layer also needs **female-specific hex sets** (re-dump the
palette on indices 10–18 / 28–36 once the sprites render correctly) before any of
the above works on female characters.
