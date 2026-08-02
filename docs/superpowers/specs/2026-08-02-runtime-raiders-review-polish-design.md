# Runtime Raiders Review Polish — Design

**Date:** 2026-08-02

**Status:** Approved design; implementation pending

**Scope:** Landing-page typography and treasure gutters, Raider Login width, and wide-screen TV allocation

## Goal

Resolve the five presentation issues found during the Runtime Raiders review while preserving the approved fantasy artwork, moss-wall framing, purple-and-gold palette, mobile behavior, and existing game rules.

This pass changes layout and presentation only. It does not change scoring, raids, player data, authentication behavior, combat, compact-TV behavior, deployment, DNS, Caddy, or the Raspberry Pi.

## 1. Three-line landing motto

The landing motto will render as three deliberate lines at normal desktop widths:

1. **Clock in.**
2. **Clear dungeons.**
3. **Get paid.**

Each sentence stays intact instead of relying on the browser to wrap one continuous heading. The canonical brand wording remains available as one accessible phrase; the visual line treatment must not create awkward pauses or duplicate text for assistive technology.

At narrow widths, each sentence may scale with the existing responsive typography, but words within **Clear dungeons.** must remain together.

## 2. Treasure gutters beneath the walls

The landing treasures remain decorative elements in the left and right outer gutters. Their visible boundary will be the moss walls, not an invisible inner edge:

- each gutter includes the adjacent wall region in its animation space;
- treasure is layered below the moss walls and below interactive page content;
- the existing vertical bob gains a small, mirrored horizontal drift toward and beneath the nearest wall;
- wall artwork provides the visible occlusion as a treasure passes under it; and
- the inner gutter boundary must not crop a treasure before it reaches the wall.

The movement stays slow and restrained so the landing page remains readable. Existing breakpoints that hide the gutters on space-constrained screens remain in effect. Under `prefers-reduced-motion`, the treasure stays still and the composition remains intentional.

The central content width does not need to expand solely to make room for this effect; the gutter geometry and stacking order should solve the clipping without squeezing the page.

## 3. Landing footer edge

The one-pixel purple rule above **Your AI keeps running. Your Raider keeps raiding.** will be removed on the landing page. The change is landing-specific so footer separators elsewhere remain available where they help structure denser pages.

## 4. Full-width Raider Login

Raider Login will use the same normal content width established by the surrounding application instead of an inline `520px` maximum. The form itself may retain comfortable field sizing through its internal layout, but the containing dungeon panel should span the available page column at wide viewports and follow the existing responsive behavior on narrow screens.

## 5. Adaptive TV leaderboard width

Wide TV layouts will give the leaderboard more room for long Raider names without sacrificing the dungeon's crisp presentation.

The layout will:

1. calculate the largest integer dungeon scale that fits the viewport height while preserving the existing health-bar, bottom, and side clearances;
2. reserve the field width required for that dungeon panel at the calculated scale;
3. target a leaderboard/sidebar width of approximately `38%` of the viewport; and
4. cap the sidebar at the maximum width that still leaves the required field width and clearances.

This allows a 1920×1080 display to use the currently empty horizontal strip for names while keeping the dungeon at its height-limited integer scale. On narrower displays, the sidebar yields space before the dungeon loses an otherwise available integer scale. Existing measured text ellipsis remains the final fallback for unusually long names.

Compact TV mode, dungeon proportions, defeat presentation, combat rendering, and leaderboard content remain unchanged.

## 6. Component boundaries

- The landing view owns the intentional sentence-level motto markup while the brand configuration remains the source of the approved wording.
- Landing styles own the gutter geometry, layering, motion, and page-specific footer override.
- The shared dungeon shell remains responsible for the moss-wall foreground layer.
- Raider Login uses a semantic page class rather than a one-off inline width limit when a selector is needed.
- The TV renderer owns the adaptive sidebar calculation because it already controls canvas geometry and integer dungeon scaling.

## 7. Accessibility and resilience

- The motto is announced once in a natural reading order.
- Decorative treasure remains hidden from assistive technology and never intercepts input.
- Reduced-motion users receive a stable, non-animated treasure composition.
- Login labels, focus order, and form behavior remain unchanged.
- Longer leaderboard names gain space, but the existing safe ellipsis prevents overlap at all supported widths.

## 8. Test and review strategy

### Automated

- Landing route/template and CSS tests assert the three sentence lines, landing-only footer override, wall-layered gutter treatment, and reduced-motion rule.
- Raider Login rendering tests assert that the inline `520px` constraint is gone and the normal content-width contract is used.
- TV geometry tests cover at least 1920×1080 and 3840×2160, asserting that the adaptive sidebar widens when spare horizontal space exists without reducing the largest height-supported integer dungeon scale.
- Existing mobile, compact-TV, long-name ellipsis, defeat, animation, and dungeon-shell suites remain green.

### Visual review

Inspect the local companion at:

1. landing desktop width for the exact three-line motto, missing footer rule, and treasures disappearing beneath both moss walls;
2. landing narrow width and reduced motion for a stable, unclipped composition;
3. Raider Login at wide and narrow widths;
4. TV at 1920×1080 with representative long Raider names; and
5. TV at 3840×2160 to confirm integer-pixel dungeon rendering and balanced spacing.

Production deployment remains a separate, explicitly authorized gate.
