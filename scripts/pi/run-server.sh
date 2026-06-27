#!/usr/bin/env bash
# ExecStart target for claude-rpg.service. Runs the Node server from the repo.
set -euo pipefail

# Resolve the repo root (this script lives in <repo>/scripts/pi/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

# NodeSource installs node/npm into /usr/bin; ensure it's on PATH for systemd.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

exec npm start
