# Registration Gender → Sprite Preview — Design

**Date:** 2026-07-13
**Status:** Approved (design), ready to implement
**Backlog:** #2 (Gender selection drives creature/class sprites)

## Goal

On the registration page, the class-picker avatars should show the sprite for
the **currently selected gender**, so a player who picks "Female" sees the
female class variants and gets visual confirmation of their character.

## Background — most of #2 already works

Gender is already wired end-to-end:
- The register form has a `gender` `<select>` (M/F); the POST validates it
  (`z.enum(['M','F'])`) and `createPlayer` stores it in `players.gender`.
- `classSpriteUrl(key, gender)` maps Male → sprite index `maleIndex` (1–9) and
  Female → `maleIndex + 9` (10–18); the female files are verified correct
  variants of the same 9 classes.
- `/tv` (`tvview.ts`) and the character sheet (`character.ts`) both render with
  the stored `p.gender`, so female players already show female sprites in-game.

**The only gap:** the register form's avatar grid always renders `spriteM`
(`registration.ts` passes only the male URL), so selecting "Female" does not
update the previews. This design closes that gap; no in-game behaviour changes.

## Change (front-end only)

1. **`src/web/routes/registration.ts`** — for each class, pass both
   `spriteM: classSpriteUrl(c.key, 'M')` and `spriteF: classSpriteUrl(c.key, 'F')`
   (in the GET handler and the 400 re-render).
2. **`src/web/views/register.ejs`** — render each avatar `<img>` with
   `data-sprite-m` and `data-sprite-f` attributes (and default `src` = the value
   matching the currently-selected gender). Add a small inline script that, on
   the gender `<select>`'s `change` event (and once on load), sets every avatar
   `img.src` to its `data-sprite-m` or `data-sprite-f`.

No domain, DB, or route-contract changes. No new dependencies. Deterministic.

## Rejected alternatives

- **Server round-trip on gender change** — needless latency/complexity for a
  pure display swap.
- **Show male + female side by side** — clutters the 9-class grid and doesn't
  match "pick your character".

## Testing

- **Route test** (`tests/web-registration.test.ts` or existing web test): a GET
  `/` response contains both a male sprite URL (e.g. `_09.png` for paladin) and
  the corresponding female URL (`_18.png`), confirming both are emitted for the
  swap.
- **Manual/visual:** load `/register`, toggle the gender select, confirm all
  avatars swap between male and female variants; confirm a female registration
  still shows the female sprite on `/tv` (already works — sanity check).

Full suite + `tsc --noEmit` stay green.
