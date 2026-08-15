#!/bin/bash

set -euo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: %s\n' "$0" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

require_release_variable() {
  local variable_name="$1"
  if [ -z "${!variable_name:-}" ]; then
    printf '%s is required\n' "$variable_name" >&2
    exit 64
  fi
}

require_release_variable RUNTIME_RAIDERS_CODESIGN_IDENTITY
require_release_variable RUNTIME_RAIDERS_NOTARY_PROFILE
require_release_variable RUNTIME_RAIDERS_TEAM_ID

GIT_STATUS="$(/usr/bin/git status --porcelain --untracked-files=all)" || {
  printf 'Gate 2 could not inspect the Git worktree\n' >&2
  exit 64
}
if [ -n "$GIT_STATUS" ]; then
  printf 'Gate 2 requires a clean Git worktree\n' >&2
  exit 64
fi

RELEASE_SHA="$(/usr/bin/git rev-parse HEAD)"
COMPANION_VERSION="$(/usr/bin/sed -n 's/^companion_version=//p' companion/RELEASE)"
RELEASE_SEQUENCE="$(/usr/bin/sed -n 's/^release_sequence=//p' companion/RELEASE)"
UPDATE_PROTOCOL_VERSION="$(/usr/bin/sed -n 's/^update_protocol_version=//p' companion/RELEASE)"
if [ -z "$COMPANION_VERSION" ] || [ -z "$RELEASE_SEQUENCE" ] ||
   [ -z "$UPDATE_PROTOCOL_VERSION" ]; then
  printf 'Gate 2 requires complete release metadata\n' >&2
  exit 64
fi

DIST="$ROOT/dist"
if [ -e "$DIST" ] || [ -L "$DIST" ]; then
  if [ ! -d "$DIST" ] || [ -L "$DIST" ]; then
    printf 'Gate 2 requires a nonsymlink dist directory\n' >&2
    exit 64
  fi
else
  /bin/mkdir "$DIST"
fi

RELEASE_OUTPUT="$DIST/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
if [ -e "$RELEASE_OUTPUT" ] || [ -L "$RELEASE_OUTPUT" ]; then
  printf 'Gate 2 release output must be absent\n' >&2
  exit 1
fi

scripts/release/build-runtime-raiders-agent.sh \
  --release-sha "$RELEASE_SHA" \
  --output "$RELEASE_OUTPUT"
RUNTIME_RAIDERS_CODESIGN_IDENTITY="$RUNTIME_RAIDERS_CODESIGN_IDENTITY" \
  /bin/bash scripts/test/verify-runtime-raiders-signed-release.sh "$RELEASE_OUTPUT"
/usr/bin/shasum -a 256 \
  "$RELEASE_OUTPUT/install.sh" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.update.json"
