#!/usr/bin/env bash
# ClaudeRPG kiosk auto-updater.
#
# Pulls origin/<branch> and restarts the game service — but ONLY when the game is
# idle-paused (game_state.paused = 1, i.e. "the dungeon rests"), so a deploy never
# interrupts a live fight. Fast-forward only; never touches data/ or node_modules.
# Run periodically by claude-rpg-autoupdate.timer. Logs go to the journal
# (journalctl -u claude-rpg-autoupdate).
#
# Overridable via the environment (see the .service unit):
#   CLAUDE_RPG_REPO     repo path            (default /home/rluser/ClaudeRPG)
#   CLAUDE_RPG_DB       sqlite db path       (default $REPO/data/claude-rpg.db)
#   CLAUDE_RPG_BRANCH   branch to track      (default main)
#   CLAUDE_RPG_SERVICE  systemd unit name    (default claude-rpg)
set -euo pipefail

REPO="${CLAUDE_RPG_REPO:-/home/rluser/ClaudeRPG}"
DB="${CLAUDE_RPG_DB:-$REPO/data/claude-rpg.db}"
BRANCH="${CLAUDE_RPG_BRANCH:-main}"
SERVICE="${CLAUDE_RPG_SERVICE:-claude-rpg}"

# Single-flight: never let two runs overlap (a slow pull + a fast timer tick).
exec 9>"/tmp/claude-rpg-autoupdate.lock"
flock -n 9 || { echo "another auto-update run is in progress — skipping"; exit 0; }

cd "$REPO"

# 1. Anything to deploy?
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "up to date (${LOCAL:0:7})"
  exit 0
fi

# 2. Fast-forward only. Bail if history diverged or the tree is dirty — never clobber.
if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  echo "WARN: local ${LOCAL:0:7} is not an ancestor of origin/$BRANCH (${REMOTE:0:7}) — diverged, skipping"
  exit 0
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "WARN: working tree has local changes — skipping auto-update"
  exit 0
fi

# 3. Deploy ONLY when the game is idle-paused (no live combat). Any read error or
#    non-idle state => hold off. Conservative by construction.
PAUSED="$(node -e '
try {
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  const gs = db.prepare("SELECT paused FROM game_state WHERE id=1").get();
  process.stdout.write(String(gs && gs.paused ? 1 : 0));
} catch (e) { process.stdout.write("0"); }
' "$DB" 2>/dev/null || echo 0)"

if [ "$PAUSED" != "1" ]; then
  echo "update ${REMOTE:0:7} pending — game is active, waiting for the dungeon to rest"
  exit 0
fi

echo "idle window detected — deploying ${LOCAL:0:7} -> ${REMOTE:0:7}"

# 4. npm ci only when dependencies actually changed in the delta.
NEED_NPM=0
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json package.json; then
  NEED_NPM=1
fi

git pull --ff-only origin "$BRANCH"

if [ "$NEED_NPM" = "1" ]; then
  echo "dependencies changed — running npm ci"
  npm ci
fi

sudo systemctl restart "$SERVICE"
echo "deployed $(git rev-parse HEAD | cut -c1-7); restarted $SERVICE"
