# Timed Consumables and Scalable Player Hub Design

**Date:** 2026-07-28

**Status:** Implemented and locally approved; Pi release gate pending

**Branch:** `feat/player-shop-cosmetics`

## 1. Goal

Launch the first two timed consumables as meaningful, work-driven gold sinks
without turning purchased power into guaranteed profit. Players buy potion
inventory from the Bazaar, manually activate it from their character page, and
receive benefits for two hours of actual combat-active game time.

This increment also reshapes the character page into a scalable player hub.
The current full-width profile and Dye Workbench are already useful enough that
players leave the page open throughout the day. The new structure must support
potions now and later accommodate materials, loot boxes, gems, pets, equipment,
additional effects, richer player statistics, and a compact live-dungeon view
without adding another full-width card for every feature.

The two launch products are deliberately beginner strength. Tier 2 potion
strengths are not designed or sold until live results establish that their
prices and yields can be tuned responsibly.

## 2. Product principles

The launch follows these rules:

1. **Work remains the source of token progress.** No potion creates, doubles,
   or alters XP/effective tokens. Potions may react to work or improve combat,
   but raw token metrics remain earned only through actual Claude Code usage.
2. **The gold potion rewards work directly.** It does not depend on whether a
   long encounter happens to end during its two-hour window.
3. **The damage potion improves opportunity, not certainty.** It helps a player
   deal more damage and therefore improves their chance of climbing damage and
   podium rewards, but it never guarantees that its purchase price is returned.
4. **Time means combat-active time.** Idle pauses, server downtime, and the
   monster-defeat results screen do not consume potion duration.
5. **Supply and use are predictable.** Basic potions do not use randomized
   availability or global competitive stock.
6. **The battlefield stays readable.** Color and restrained pixel particles
   communicate active potion types. Exact descriptions and timers live in the
   player UI.
7. **Every economic result is auditable.** Purchases, activations, work-based
   payouts, damage added by a potion, encounter awards, and player gold changes
   are recorded from launch.

## 3. Launch products

| Product | SKU | Price | Duration | Effect |
| --- | --- | ---: | ---: | --- |
| Beginner Gold Potion | `potion_gold_t1` | 100,000 gold | 2 combat-active hours | 50 gold per 1,000 eligible effective tokens, capped at 125,000 base payout, plus a 25,000 stretch bonus at 2.5M eligible tokens |
| Beginner Damage Potion | `potion_damage_t1` | 150,000 gold | 2 combat-active hours | Player-specific base hit is multiplied by 1.25 while active |

Both products are normal stackable inventory items. Their SKU includes their
type and tier so future strengths can coexist without changing the behavior of
already purchased items.

No Tier 2 product is visible, purchasable, or activatable in this increment.

### 3.1 Launch tuning controls

The typed product catalog reads these launch defaults from settings rather than
scattering balance constants through routes or combat code:

| Setting | Default | Applies to |
| --- | ---: | --- |
| `potion_gold_t1_price` | 100,000 | Future Gold Potion purchases |
| `potion_gold_t1_duration_s` | 7,200 | Future Gold Potion activations |
| `potion_gold_t1_gold_per_1000` | 50 | Future Gold Potion activations |
| `potion_gold_t1_base_cap` | 125,000 | Future Gold Potion activations |
| `potion_gold_t1_stretch_tokens` | 2,500,000 | Future Gold Potion activations |
| `potion_gold_t1_stretch_bonus` | 25,000 | Future Gold Potion activations |
| `potion_damage_t1_price` | 150,000 | Future Damage Potion purchases |
| `potion_damage_t1_duration_s` | 7,200 | Future Damage Potion activations |
| `potion_damage_t1_base_hit_pct` | 25 | Future Damage Potion activations |
| `potion_daily_stock_per_sku` | 3 | Future local-day purchases |
| `potion_daily_uses_per_type` | 3 | Future local-day activations |
| `reward_work_pct` | 80 | Newly spawned encounters |
| `reward_damage_pct` | 10 | Newly spawned encounters |
| `reward_podium_first_pct` | 5 | Newly spawned encounters |
| `reward_podium_second_pct` | 3 | Newly spawned encounters |
| `reward_podium_third_pct` | 2 | Newly spawned encounters |

The settings metadata and grouping tables must be updated in the same change so
their existing parity check remains useful. Percent settings are validated as a
complete allocation totaling 100 before a new reward-model version can become
active.

The office time zone is runtime configuration rather than a numeric game
setting: `OFFICE_TIME_ZONE`, defaulting to `America/New_York`. Product price is
snapshotted on purchase, potion behavior is snapshotted on activation, and the
reward allocation/version is snapshotted when an encounter spawns. Editing a
setting never rewrites a purchase, active potion, or current encounter.

## 4. Effective tokens and Gold Potion accounting

The Gold Potion uses the same effective-token definition already applied to XP,
activity, and combat:

```text
effective tokens = input
                 + output
                 + cache creation
                 + round(cache read × cache_read_weight)
```

At the current default `cache_read_weight=0`, cache reads contribute nothing.
Changing that existing setting changes the potion's eligible-token accounting
in exactly the same way it changes the rest of the game.

### 4.1 Base payout

For each active Gold Potion:

```text
whole token units = floor(eligible effective tokens / 1,000)
base payout        = min(whole token units × 50, 125,000)
```

Only newly crossed 1,000-token units are credited. Gold is added incrementally
inside the same transaction that records the eligible token event, so a server
restart cannot duplicate or lose a payout.

The base payout reaches its cap at 2.5M eligible effective tokens.

### 4.2 Stretch completion bonus

The first time an activation reaches 2.5M eligible effective tokens, it grants
one additional 25,000 gold. This makes almost completing the potion a visible
mini-quest with a meaningful finish rather than an invisible linear cap.

The bonus is awarded once per activation. It cannot be partially earned and is
not granted after the activation expires.

### 4.3 Player economics

The approved maximum for one Beginner Gold Potion is therefore:

| Result | Gold |
| --- | ---: |
| Purchase price | -100,000 |
| Maximum base payout | +125,000 |
| Stretch completion | +25,000 |
| Maximum total payout | +150,000 |
| Maximum net profit | +50,000 |

Break-even occurs at 2M eligible effective tokens. Maximum profit requires
2.5M tokens during the two combat-active hours. The high end is intentionally
possible for somebody working hard, but it is not the expected result of simply
drinking the potion and waiting.

Gold Potion payouts are independent of encounter completion and do not enlarge
the encounter reward pool.

## 5. Damage Potion and encounter rewards

The Damage Potion changes only the active player's base-hit term:

```text
normal hit = base_hit × level multiplier × activity modifier × debuff factor

potion hit = (base_hit × 1.25)
           × level multiplier
           × activity modifier
           × debuff factor
```

The global `base_hit` setting is never mutated. Level, the capped activity
modifier, and monster debuffs continue to work exactly as they do today.

The engine records both the actual hit and the exact difference between the hit
with and without the potion. This `potion bonus damage` is required for the
admin counterfactual report.

### 5.1 Approved encounter reward split

The encounter gold pool remains:

```text
round(monster max HP × dungeon level × gold_factor)
```

The pool is not enlarged by potion use. It is divided into these components:

| Component | Pool share | Allocation |
| --- | ---: | --- |
| Work | 80% | Proportional effective-token contribution during the encounter |
| Damage | 10% | Proportional damage dealt during the encounter |
| First-place podium | 5% | Highest damage rank |
| Second-place podium | 3% | Second-highest damage rank |
| Third-place podium | 2% | Third-highest damage rank |

The podium is carved from the existing pool. It does not mint extra encounter
gold. The Damage Potion can increase a player's proportional-damage share and
chance of entering or climbing the podium, but other players can still outwork
or outdamage them.

Damage ties are resolved by effective tokens during the encounter, then by
player ID for deterministic output. When fewer than three participants exist,
unclaimed podium percentages return to the proportional-damage component. If
an encounter has no eligible effective tokens, the 80% work component also
returns to proportional damage. Integer allocation uses a deterministic
largest-remainder pass so the exact awarded total equals the gold pool.

The kill-award path, stored award rows, and defeat summary must all use the same
reward function. The current `gold_damage_weight` blend is retired from runtime
use by this fixed hybrid model; stale database values may remain but must not
silently alter the approved split.

### 5.2 Backtest rationale

The live-data exploration that led to this split showed:

- a pure 80/20 token/damage blend with +25% base hit improved damage rank in
  roughly 49% of sampled encounters, but median incremental encounter gold was
  only about 1,607 overall and 4,395 on bosses;
- no sampled player recovered a 150,000 price from one encounter under that
  pure proportional model;
- carving 10% into a 5/3/2 podium made entering or climbing the podium occur in
  roughly 20.5% of sampled opportunities;
- exceptional full-encounter results could exceed the potion price, while most
  outcomes remained a high-risk competitive wager.

These figures justify the beginner launch price, but they are not permanent
balance claims. The Potion Lab records real post-launch outcomes before any
higher tier is considered.

## 6. Daily supply, inventory, and use limits

### 6.1 Personal daily Bazaar stock

Each player receives personal stock at midnight in the configured office time
zone:

- 3 Beginner Gold Potions;
- 3 Beginner Damage Potions.

This is not a global pool. One player cannot buy another player's stock, and no
one has to race coworkers at midnight.

Unpurchased stock does not roll over. The next local day simply presents three
of each product again. Purchased inventory persists indefinitely and may grow
into a large saved supply.

Daily availability is derived from purchase rows with a local-day key. It does
not require a fragile midnight background job.

### 6.2 Daily drinking allowance

Each player may activate at most three potions of each effect type per local
day:

- 3 Gold activations;
- 3 Damage activations.

The allowance is per effect type, not three total across both products. Future
Gold strengths share the Gold allowance, and future Damage strengths share the
Damage allowance.

The day is charged when activation is confirmed. A potion that crosses
midnight continues normally and counts only against the day on which it was
activated. The next day's stock and drinking allowances become available at
local midnight.

The initial office time zone is `America/New_York`. Runtime configuration uses
an IANA time-zone name so local midnight and daylight-saving transitions can be
tested without depending on the Pi's process locale.

### 6.3 Purchase interaction

Each Bazaar product card shows:

- unit price;
- current inventory quantity;
- today's remaining personal stock;
- time until midnight restock;
- a quantity selector from 1 through the remaining stock;
- one purchase button containing the computed total price.

Quantity defaults to one. The selected quantity is purchased in one database
transaction. If the player lacks gold, the disabled action explains the missing
amount. Server validation independently checks SKU, unit price, quantity,
remaining stock, inventory update, and the final gold balance.

Buying inventory does not consume the daily drinking allowance.

## 7. Activation rules and combat-active time

### 7.1 Manual activation

Potions are activated manually from the character page. The first action opens
a compact confirmation surface containing:

- potion name, effect, and two-hour combat-active duration;
- inventory remaining after activation;
- daily doses remaining after activation;
- whether it will begin immediately or wait for combat;
- **Drink Potion** and **Keep Corked** actions.

Confirmation atomically decrements inventory, consumes one daily activation,
and creates the active record. Activation cannot be undone or refunded.

### 7.2 Concurrency and stacking

- One Gold Potion may be active at a time.
- One Damage Potion may be active at a time.
- Gold and Damage may overlap.
- A potion cannot stack with, extend, replace, or queue behind an active potion
  of the same type.
- The player may own more of that potion while one is active.

The database enforces one active row per player and potion type so repeated
requests or two open tabs cannot create a duplicate activation.

### 7.3 Persisted combat-active clock

The game owns one monotonic persisted combat-active clock. It advances only
while all of the following are true:

1. the office is not idle-paused;
2. the defeat/results window is not active;
3. a current encounter exists and accepts player attacks.

It does not advance while:

- the dungeon is idle-paused;
- the monster or boss defeat summary is on screen;
- the server is stopped or restarting;
- no active encounter is accepting attacks.

Each potion snapshots the current combat clock and its configured duration at
activation. Expiry is therefore a comparison against the persisted game clock,
not wall time. The first engine tick after process startup establishes a
baseline and never charges server downtime as elapsed potion time.

Activating while combat is paused is allowed. The item and daily dose are
consumed and the potion becomes **Armed — waiting for battle**. Its duration
does not move until combat resumes.

The token event that wakes an idle dungeon counts toward an armed Gold Potion
when the existing encounter can resume. Token events received during the
defeat/results window do not count toward potion progress because the game is
not accepting combat work during that window. The first eligible event after
the next encounter begins counts normally.

## 8. Persistence and audit model

The next migration introduces the minimum durable records below. Exact column
names may be refined in the implementation plan, but the responsibilities are
fixed.

### 8.1 Inventory and purchases

`player_inventory`

- one row per player/SKU;
- non-negative stack quantity;
- updated timestamp.

`shop_purchases`

- player, SKU, quantity, unit price, and total price;
- purchase timestamp and office-local day key;
- resulting inventory quantity and gold balance.

The purchase log is the source for daily personal stock usage.

### 8.2 Potion activations

`potion_activations`

- player, SKU, potion type, and tier;
- activation timestamp and activation local-day key;
- start and expiry values on the combat-active clock;
- active/completed state and completion timestamp;
- a snapshot of duration and effect parameters so an in-flight potion cannot
  change when an administrator edits a future setting;
- Gold progress, base payout, and stretch payout;
- Damage baseline and potion-added damage totals.

A partial unique index enforces one active row per player/potion type.

`potion_work_events`

- activation ID and source token-event ID;
- eligible effective-token delta;
- incremental base and stretch gold awarded;
- wall timestamp and combat-clock position.

This append-only detail supports exact Gold Potion reconstruction without
altering the canonical token event.

`(activation_id, source_token_event_id)` is unique. Retrying ingestion can
therefore observe the existing work event and must not award its gold twice.

### 8.3 Encounter rewards

`encounter_reward_awards`

- encounter and player;
- effective-token and damage inputs;
- actual damage, potion-added damage, and damage rank;
- work, proportional-damage, and podium components;
- exact total awarded and award timestamp;
- reward-model version.

The defeat summary reads these stored awards after a kill rather than
recomputing an approximation from mutable settings.

### 8.4 Gold ledger

`gold_ledger`

- player;
- signed amount and resulting balance;
- reason (`opening_balance`, `encounter_reward`, `shop_purchase`,
  `gold_potion_base`, `gold_potion_stretch`, `monster_steal`, or future type);
- source table and source ID;
- timestamp.

Migration inserts one opening-balance row per existing player. From that point
forward, all material gold mutations write a ledger row in the same transaction
as the player balance change.

Ledger-producing operations use a stable source type and source ID. Non-null
source references are unique across player, reason, source table, and source ID;
including the reason allows one Gold Potion work event to award both a base
increment and its one-time stretch bonus without conflating them. A retried
purchase, potion increment, encounter award, or monster attack must find the
original mutation rather than apply it again.

### 8.5 Existing-table additions

- `game_state` receives the persisted combat-active clock.
- `encounter_damage` records potion-added damage separately from total damage.
- encounters or their stored awards carry a reward-model version so a current
  fight can finish under the model with which it began.

## 9. Domain and route boundaries

The implementation keeps game logic out of Express handlers.

Recommended domain modules:

- `src/domain/inventory.ts` — stack reads and atomic adjustments;
- `src/domain/shop-products.ts` — typed permanent and consumable catalog;
- `src/domain/potions.ts` — activation, active lookup, expiry, progress, limits,
  and effect snapshots;
- `src/domain/gameclock.ts` — persisted combat-active clock;
- `src/domain/goldledger.ts` — atomic balance mutations and audit rows;
- `src/domain/rewards.ts` — exact 80/10/5/3/2 allocation and deterministic
  rounding;
- `src/domain/playerhub.ts` — authenticated player-hub view model;
- `src/domain/potionlab.ts` — admin-only aggregate and counterfactual reports.

All domain entry points accept `now: number`; none call `Date.now()` or
`Math.random()` internally. Local-day helpers accept the configured IANA time
zone explicitly.

Web handlers continue using the project's `asyncHandler` pattern and validate
all purchase/activation payloads with Zod. Purchase and activation POST routes
use redirect-after-post or JSON results consistent with the final interaction
chosen in the implementation plan.

## 10. Scalable player hub

The character page becomes a persistent player hub with one compact hero header
and three in-page sections:

1. **Live Dungeon** — default section;
2. **Inventory**;
3. **Wardrobe**.

The sections stay mounted in one page. Switching tabs hides and reveals them
without navigation, so unsaved Wardrobe work remains in memory. Existing
guarded navigation still protects links that leave the page.

### 10.1 Hero header and Active Effects

The hero header contains:

- animated player sprite;
- name, class, gender, and connection state;
- compact Level, XP, total-token, and Gold values;
- the existing token-preserving **Store** button.

No second Store link appears in Inventory.

When potions are active, the approved motes render directly over the character.
The character is the trigger for a small **Active Effects** popover:

- pointer hover opens it temporarily;
- keyboard focus opens it;
- click/tap pins or unpins it;
- Escape and the close control dismiss it;
- losing hover closes an unpinned popover;
- mobile uses tap rather than relying on hover.

Each effect row contains a small icon, remaining combat-active time, and a short
plain-language effect description. Gold includes its 2.5M progress bar. Damage
shows the 25% personal base-hit benefit. Monster debuffs use the existing red
exclamation icon and state their remaining duration and penalty.

The list has a bounded height and scrolls when many future buffs/debuffs are
active, so effect count never expands the hero card indefinitely.

### 10.2 Live Dungeon

The default tab is a compact form of the actual live TV, not a separate fake
simulation. It shows:

- the whole generated dungeon;
- current monster or mob and health bar;
- all currently placed player sprites;
- potion motes and monster debuff markers;
- a compact current-fight leaderboard;
- the player's Today statistics.

Today initially includes effective tokens, damage, fight rank, gold earned,
combat-active time, and potions used.

“Today” is the current calendar day in `OFFICE_TIME_ZONE`, matching Bazaar
stock and potion-use resets. The panel updates from live state without resetting
the surrounding tab or Wardrobe draft.

The existing global **Watch the TV** link remains the full-screen option. The
compact renderer consumes the same `TvHub` layout/state and sprite URLs as the
TV. Implementation should share or parameterize the renderer rather than copy
combat or positioning logic into a divergent character-page simulation.

### 10.3 Inventory

Inventory uses a compact RPG slot grid, not one full product card per item.
Stacks occupy one slot and show quantity in a corner badge. Launch filters are
**All**, **Potions**, **Materials**, and **Quest**; empty future categories may
remain disabled or hidden until populated.

Selecting a slot opens one item-detail panel containing:

- item art, name, tier, and owned quantity;
- effect and combat-active duration;
- remaining daily doses and time until reset;
- Gold stretch progress when that potion is active;
- active/armed state or the **Drink Potion** action.

The confirmation workflow appears from this detail panel. This pattern scales
to armor parts, weapons, loot-box contents, gems, pet items, and other future
inventory without growing the page vertically for each item type.

### 10.4 Wardrobe

The approved Dye Workbench moves into the Wardrobe tab without changing:

- cosmetic entitlements;
- slot maps;
- atomic batch save;
- revision conflict handling;
- Tone, material presets, or Restore Default;
- dirty-navigation protection.

The tab change itself is local and does not discard a draft.

### 10.5 Responsive behavior

- The hero card, tabs, and section panels remain inside the existing moss-wall
  safe area.
- Tabs remain reachable and may become sticky below the site header on narrow
  screens.
- The Live Dungeon stacks its compact leaderboard and Today statistics below
  the dungeon.
- Inventory changes from grid/detail columns to a vertical layout.
- The Active Effects popover reanchors below the avatar at mobile width.
- All hover interactions have focus, click, and tap equivalents.

## 11. TV and player effect presentation

### 11.1 Persistent potion state

Persistent potion icons do not sit on player tiles. Potion type is communicated
by color:

- Gold Potion — warm gold squares;
- Damage Potion — vivid red squares.

The approved beginner effect uses sparse solid pixel squares in slightly
different sizes. They rise from below the player's feet, move left and right in
discrete stepped increments, pass in front of the sprite, and fade only a few
source pixels above the character. Each square receives a crisp dark offset
shadow and a restrained same-color bloom so it stays visible against clothing.

One beginner potion renders four sparse motes. When both types are active, six
interleaved motes share a player-level particle budget so the effect does not
double into noise. Gold and red spawn out of phase.

### 11.2 Monster debuffs

The existing red `!` debuff badge remains above the affected hero while the
debuff is active. It renders in addition to potion motes, not instead of them.
The Active Effects popover contains the same debuff with duration and the
configured damage penalty.

### 11.3 Activation moment and future intensity

Drinking a potion may use its bottle icon for a short one-shot cork/burst event.
The icon disappears after activation; persistent state uses motes only.

Future potion strength is communicated by a controlled increase in spawn
cadence, visible-particle budget, and occasional larger or paired sparkle. Color
continues to mean potion type. Exact tier and time remain in the player UI.

Higher intensities must respect a player-level particle cap, especially when
two potion types overlap. Tier 2 visuals are supported by the payload shape but
are not authored or sold in this increment.

Reduced-motion clients keep static color evidence in the Active Effects UI and
may suppress or dramatically reduce ambient motes.

## 12. Admin-only Potion Lab

Launch reporting is admin-only. A later player-facing report or dungeon
newsletter is backlog work.

The Potion Lab reports by product, player, activation, and date range.

### 12.1 Gold Potion report

- purchase price and purchase date;
- activation and completion state;
- wall-clock span and combat-active elapsed time;
- eligible effective tokens;
- base payout, stretch payout, total payout, and net result;
- break-even and stretch completion rates;
- distributions by player and time of day.

### 12.2 Damage Potion report

- purchase price and activation window;
- normal/counterfactual damage and exact potion-added damage;
- damage rank with and without the potion;
- actual encounter reward and counterfactual reward under the same pool;
- podium entries or climbs attributable to bonus damage;
- net gold result across encounters touched by the activation.

### 12.3 Economy report

- potion gold spent;
- Gold Potion gold minted by base and stretch rewards;
- encounter gold redistributed, not minted, by the hybrid reward model;
- monster gold stolen;
- total ledger inflow/outflow and reconciliation against player balances;
- daily stock purchased and daily doses used.

Tier 2 balancing does not begin until there are at least:

- 14 combat-active game days of results;
- 30 completed activations of each launch product;
- 5 distinct participating players.

These are minimum evidence thresholds, not an automatic release trigger.

## 13. Future product hooks

The launch schema and UI leave room for stronger product SKUs, but basic Tier 1
potions remain dependable daily stock.

A future **Traveling Merchant** may offer scarce, rotating, or randomized
higher-tier products. That system should create anticipation without making
beginner consumables schedule-dependent or globally competitive. Traveling
Merchant inventory, schedules, randomness, and presentation are explicitly
backlogged.

## 14. Rollout and compatibility

- Existing player gold receives an opening ledger balance; no historical
  potion or reward rows are invented.
- A current encounter finishes under the reward-model version with which it
  began. The 80/10/5/3/2 model applies to newly spawned encounters after the
  feature is enabled.
- Potion products remain unavailable until the migration, clock, ledger,
  reward storage, character activation flow, and admin reporting are all ready.
- Production deployment still follows the project's idle-only deployment rule.
- Raspberry Pi visual/performance verification remains a release gate when Pi
  access is available; it is not required to begin local implementation.

## 15. Verification

### 15.1 Domain and database tests

- inventory purchase is atomic and cannot make gold or quantity negative;
- per-player daily stock is three per launch SKU and does not roll over;
- purchase quantity cannot exceed current local-day stock;
- local-day keys and next-reset times are correct across Eastern daylight-saving
  boundaries;
- daily activation limits are three per effect type across future tiers;
- duplicate tabs cannot activate the same type twice;
- Gold and Damage can overlap while same-type stacking/queueing is rejected;
- combat-active clock advances only while an encounter accepts attacks;
- idle, defeat popup, and restart downtime do not consume duration;
- the first idle-waking token is Gold-Potion eligible;
- defeat-window token events are not potion eligible;
- Gold payout increments, cap, stretch bonus, and retry idempotency are exact;
- Damage Potion changes only personal base hit and records exact bonus damage;
- reward components sum exactly to the encounter pool;
- zero-token, fewer-than-three-player, and tie fallbacks are deterministic;
- stored reward rows match the gold ledger and defeat summary;
- every post-migration material gold mutation reconciles through the ledger.

### 15.2 Route and view tests

- Bazaar stock, inventory count, quantity bounds, totals, missing gold, and
  midnight reset copy render from fresh database state;
- purchase POST revalidates price, quantity, stock, player, and balance;
- player hub preserves the authenticated Store URL;
- Live Dungeon, Inventory, and Wardrobe are keyboard-operable tabs;
- Wardrobe drafts survive section switches;
- Active Effects supports hover, focus, click/tap pinning, close, and Escape;
- Gold progress, Damage description, armed/active state, timers, and monster
  debuffs render correctly;
- inventory selection updates one reusable detail panel;
- activation confirmation states exactly what is consumed and when time starts;
- admin Potion Lab remains inaccessible without admin authentication.

### 15.3 TV and browser verification

- gold-only, damage-only, dual-potion, debuff-only, and potion-plus-debuff states
  are visually distinct on multiple male/female class sprites;
- solid squares keep their approved sizes, jitter, height, shadow, and restrained
  bloom without obscuring combat;
- multiple potion users do not overwhelm a crowded fight;
- compact and full TV views receive identical encounter placement and state;
- mini leaderboard and Today stats remain readable at desktop and phone widths;
- player hub panels never cross the moss-wall boundary;
- reduced-motion behavior retains understandable state without ambient motion.

The implementation completion gate is `npm test`, `npm run typecheck`, public
JavaScript syntax checks, and local browser review with real animated sprites.

## 16. Out of scope

- token/XP multipliers;
- automatic potion activation or queued refills;
- randomized/basic-potion daily stock;
- global competitive stock;
- Tier 2 or Tier 3 potion products;
- Traveling Merchant implementation;
- loot boxes, crafting parts, gems, pets, or equipment behavior;
- player-facing Potion Lab, newsletter, or shareable daily report;
- changing encounter HP pacing;
- deploying or Pi-testing this design before local implementation is complete.
