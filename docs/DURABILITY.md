# Database Durability — Power-Loss Safety

ClaudeRPG runs as an always-on kiosk that gets powered off by pulling the plug.
This documents the durability guarantees and how they were verified.

## The bug (observed 2026-06-27)

After a power loss the dungeon came back at an earlier state (different decor)
and the **token count had regressed** to a value lower than at the moment the
plug was pulled.

**Root cause:** the SQLite connection used WAL journal mode but never set
`synchronous`. better-sqlite3's effective value in WAL mode is `NORMAL` (1),
which does **not** fsync the WAL on commit — committed transactions live in the
WAL + OS page cache until a checkpoint. A power loss before the next checkpoint
silently rolls those commits back (no corruption, just lost recent writes). The
dungeon "drift" was the same cause: the dungeon is regenerated deterministically
from `theme`+`seed`, so a lost `game_state`/dungeon commit pointed the renderer
back at an earlier seed.

## The fix

1. **`synchronous = FULL`** (`src/db/db.ts`). In WAL mode this fsyncs the WAL on
   every commit, so committed transactions survive power loss. This is the real
   durability guarantee.
2. **Graceful shutdown** (`src/web/shutdown.ts`, wired in `src/index.ts`). On
   SIGTERM/SIGINT: stop the tick loop, stop accepting new connections and
   **force-close existing ones** (the kiosk's SSE stream never drains on its
   own), then `wal_checkpoint(TRUNCATE)` + close. This keeps clean restarts tidy
   (small main file, no giant WAL). It does **not** affect power-loss durability
   — `synchronous=FULL` does that. (An earlier attempt gated the checkpoint
   inside `server.close()`'s callback, which hung on the SSE connection until
   systemd SIGKILLed the process; fixed by not waiting on connection drain.)

Both are covered by tests: `tests/db.test.ts` asserts `journal_mode=wal` +
`synchronous=2`; `tests/shutdown.test.ts` asserts the WAL is flushed on shutdown
even with a persistent connection open.

## Verification on real hardware (Raspberry Pi 5, 2026-06-27)

Simulated a true power loss with a **SysRq immediate reboot**
(`echo b > /proc/sysrq-trigger`) — an instant reset with no filesystem sync and
no clean unmount, the software equivalent of yanking power. Confirmed real by
uptime resetting.

Method: wrote a durability probe row via a `synchronous=FULL` connection
(mirroring the server) so a known sentinel sat in a ~1.9 MB un-checkpointed WAL,
snapshotted the live token data, then triggered the no-sync reset.

| Check | Pre-crash | After hard reset | Result |
|---|---|---|---|
| `PRAGMA integrity_check` | — | `ok` | no corruption |
| Durability probe sentinel | written | **survived** | ✅ |
| Player effective tokens | 220,571 | 228,154 | no regression (grew) |
| Token events (count / max id) | 85 / 85 | 88 / 88 | even the last commits before the crash survived |

**Control:** a `.cjs` file copied to the Pi via `scp` (a non-fsync'd write) just
before the reset was *destroyed* by the crash, while every `synchronous=FULL`
database commit survived — confirming the reset really skipped syncing and that
only fsync'd writes persist. The original token-regression symptom is gone.
