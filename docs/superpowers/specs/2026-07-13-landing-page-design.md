# Public Landing Page (#10) — Design

**Date:** 2026-07-13
**Status:** Approved (design), ready to plan/implement
**Backlog:** #10 (Public landing page)

## Goal

Give ClaudeRPG a proper front door at `/`: a playful, dungeon-themed page that
(1) shows the office's live battle, (2) routes people to register (pick a class),
(3) explains how to join, and (4) makes the scope honest — it reads Claude Code
**usage counts only**, and only from the **Claude Code CLI** (not the API, not
the desktop/web app). A design prototype was approved as an Artifact.

## Routing changes

| Route | Before | After |
|-------|--------|-------|
| `GET /` | registration form | **landing page** |
| `GET /register` | (none) | the class/gender **form**, honors `?class=<key>` preselect |
| `POST /register` | unchanged | unchanged |
| nav (`layout.ejs`) | Register / Character Login / Admin | **Home** / Register / Character Login / Admin |

## Page sections (landing, dark dungeon theme)

1. **Top bar** — ⚔ CLAUDERPG wordmark + nav (Watch the TV → `/tv`, Log in →
   `/character`, Admin).
2. **Hero** — headline + pitch ("runs on your Claude Code usage…") + two CTAs:
   **Create your character** (`/register`) and **Watch on the TV** (`/tv`).
3. **Live boss snapshot** — current monster name + sprite + HP bar + active
   adventurer count, via `buildTvState(db, now)` (single-sourced with `/tv`).
   Idle fallback: "The dungeon rests — be the first to wake it" (no boss card).
4. **Pick your fighter** — the 9 class sprites, each a **link to
   `/register?class=<key>`** (hover lift/glow is the affordance; click enlists).
5. **How to join** — 3 numbered steps (register → add one shell line → code as
   usual), then the setup snippet (uses `PUBLIC_URL`).
6. **Claude-Code-only callout** — prominent: tracks the **Claude Code CLI**;
   does **not** count Claude **API** tokens or **desktop/web app** usage.
7. **What it sees / doesn't** — sees: token counts, model, timestamps (OTel
   metrics); never: prompts, code, files, conversations. Pause via `rpg_off`.
8. **Final CTA** + footer (Oryx art credit).

## `PUBLIC_URL` config (used everywhere)

- New config field `publicUrl`, from env **`PUBLIC_URL`**, default
  `http://clauderpg.redlattice.com:8080` (DNS already resolves to the Pi's
  internal IP). After Caddy+TLS: flip env to `https://clauderpg.redlattice.com`.
- Refactor `buildSetupSnippet` to take the full **endpoint URL** (not host+port)
  and set `OTEL_EXPORTER_OTLP_ENDPOINT` to it. The landing's displayed snippet
  and the post-register snippet both read `publicUrl`.
- Keep `otelHost`/`port` for backward-compat / local dev fallback (derive
  `publicUrl` default from them if `PUBLIC_URL` unset).

## Post-join page

`registered.ejs` gains the same **Claude-Code-only** note (the user explicitly
asked for it "after the user joins"): this only counts Claude Code CLI usage —
not the API or the desktop/web app.

## Assets

- Heroes + boss: served from `/sprites/creatures_24x24/` (via `classSpriteUrl`
  and a creature-file helper) — already mounted.
- Items/gems/torch used as decor: extract the ~15 needed 16×16/24×24 sprites
  once into `src/web/public/landing/*.png` (committed) and reference by URL —
  avoids inlining and keeps the served CSS small.
- Dungeon backdrop texture: the world sheet tile via `/sheet/world.png`
  background-position (or an extracted tile).
- Styling: `src/web/public/landing.css` (new), linked from the landing view.
  Reduced-motion disables torch flicker / loot bob.

## Testing

- Update `tests/web-registration.test.ts`: the form now lives at `GET /register`
  (not `/`); `/register?class=wizard` marks wizard selected.
- New landing tests: `GET /` → 200, contains the pitch, the **Claude-Code-only**
  copy, and links to `/register` and `/tv`; live snapshot shows the monster name
  when an encounter exists and the fallback when idle.
- Snippet test: `buildSetupSnippet` uses `PUBLIC_URL`; `registered` page shows
  the Claude-Code-only note.
- Full suite + `tsc --noEmit` stay green.

## Follow-on (NOT in this build)

- **Caddy + Cloudflare DNS-01 wildcard TLS** for `*.redlattice.com`: reverse-proxy
  443→8080, real cert. Then flip `PUBLIC_URL` to `https://clauderpg.redlattice.com`.
  Cloudflare API token supplied by the user into a Pi env file (never handled in
  code/by the assistant). Decide whether the OTEL endpoint also moves to 443 or
  stays on `:8080` for exporter reliability.
