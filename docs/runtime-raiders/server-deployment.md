# Runtime Raiders server deployment

**Status:** Active procedure
**Audience:** Authorized server release operators
**Applies to:** A reviewed Runtime Raiders server candidate while the dungeon is paused
**Last verified:** 2026-08-28

Use this procedure only for a specifically authorized, scoped server change.
Companion publication is a separate procedure and never enables collection.

## Preconditions

1. Connect only as the trusted release account: `rluser@clauderpg.redlattice.com`.
2. Confirm the candidate is clean, reviewed, pinned to the approved commit, and
   scoped to the authorized change. Stop for unrelated changes, a dirty checkout,
   or an identity mismatch.
3. Preserve the existing database and all game, Run, score, reward, and release
   history. Before any schema or data-risk change, make and verify a recoverable backup
   of the exact prior database and release state.

## Deploy

1. Immediately before any mutation, query the authoritative game state and
   require `game_state.paused=1`. Elapsed time, open Runs, and historical TV
   state are not substitutes for this check.
2. If the pause check is not exactly true, fail closed without pulling,
   restarting, or changing state.
3. Apply only the approved scoped pull and restart required for that candidate.
   Do not fold companion publication, collection activation, broad maintenance,
   configuration replacement, or unrelated upgrades into the deployment.

## Verify and recover

After the scoped change, verify the service is active, health is successful, the
reported version is the approved candidate, and the updater state remains as
approved. Verify database integrity and retained counts for the protected game
and Runtime Raiders history.

On any failed precondition or verification, fail closed. Restore the exact recorded prior checkout,
service state, and (when applicable) verified backup;
then re-check health, pause state, database integrity, and retained counts.
Do not resume the game or enable collection as part of deployment or rollback.
