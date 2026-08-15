#!/bin/bash

set -euo pipefail

if [ "$#" -ne 0 ]; then
  printf 'usage: %s\n' "$0" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"

if [ -z "${RUNTIME_RAIDERS_TEAM_ID:-}" ]; then
  printf 'RUNTIME_RAIDERS_TEAM_ID is required\n' >&2
  exit 64
fi

GIT_STATUS="$(/usr/bin/git status --porcelain --untracked-files=all)" || {
  printf 'private record could not inspect the Git worktree\n' >&2
  exit 64
}
if [ -n "$GIT_STATUS" ]; then
  printf 'private record requires a clean Git worktree\n' >&2
  exit 64
fi

RELEASE_SHA="$(/usr/bin/git rev-parse HEAD)"
COMPANION_VERSION="$(/usr/bin/sed -n 's/^companion_version=//p' companion/RELEASE)"
RELEASE_SEQUENCE="$(/usr/bin/sed -n 's/^release_sequence=//p' companion/RELEASE)"
UPDATE_PROTOCOL_VERSION="$(/usr/bin/sed -n 's/^update_protocol_version=//p' companion/RELEASE)"
if [ -z "$COMPANION_VERSION" ] || [ -z "$RELEASE_SEQUENCE" ] ||
   [ -z "$UPDATE_PROTOCOL_VERSION" ]; then
  printf 'private record requires complete release metadata\n' >&2
  exit 64
fi

DIST="$ROOT/dist"
if [ ! -d "$DIST" ] || [ -L "$DIST" ]; then
  printf 'private record requires a nonsymlink dist directory\n' >&2
  exit 64
fi
DIST_PHYSICAL="$(cd "$DIST" && pwd -P)"
RELEASE_OUTPUT="$DIST_PHYSICAL/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
PRIVATE_OUTPUT="$DIST_PHYSICAL/private-sequence-8-$RELEASE_SEQUENCE-$RELEASE_SHA"

if [ ! -d "$RELEASE_OUTPUT" ] || [ -L "$RELEASE_OUTPUT" ]; then
  printf 'private record requires the exact public release directory\n' >&2
  exit 64
fi
EXPECTED_PUBLIC_FILES="$(printf '%s\n' \
  install.sh \
  runtime-raiders-agent.update.json \
  runtime-raiders-agent.zip \
  runtime-raiders-agent.zip.sha256)"
ACTUAL_PUBLIC_FILES="$(find "$RELEASE_OUTPUT" -mindepth 1 -maxdepth 1 \
  -exec basename {} \; | LC_ALL=C sort)"
if [ "$ACTUAL_PUBLIC_FILES" != "$EXPECTED_PUBLIC_FILES" ]; then
  printf 'private record requires the exact public quartet\n' >&2
  exit 64
fi
for public_file in \
  "$RELEASE_OUTPUT/install.sh" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.update.json" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip" \
  "$RELEASE_OUTPUT/runtime-raiders-agent.zip.sha256"; do
  if [ ! -f "$public_file" ] || [ -L "$public_file" ]; then
    printf 'private record refuses an unsafe public quartet member\n' >&2
    exit 64
  fi
done

if [ -e "$PRIVATE_OUTPUT" ] || [ -L "$PRIVATE_OUTPUT" ]; then
  printf 'private sequence-eight output must be absent\n' >&2
  exit 1
fi

umask 077
PRIVATE_WORK=''
cleanup_private_work() {
  cleanup_result=$?
  trap - EXIT HUP INT TERM
  if [ -n "$PRIVATE_WORK" ]; then
    cleanup_safe=1
    case "$PRIVATE_WORK" in
      "$DIST_PHYSICAL"/.private-sequence-8-work.*) ;;
      *) cleanup_safe=0 ;;
    esac
    if [ "$cleanup_safe" -eq 1 ]; then
      if [ ! -d "$PRIVATE_WORK" ] || [ -L "$PRIVATE_WORK" ] ||
         [ "$(/usr/bin/stat -f '%u' "$PRIVATE_WORK")" != "$(/usr/bin/id -u)" ]; then
        cleanup_safe=0
      fi
    fi
    if [ "$cleanup_safe" -eq 1 ]; then
      /bin/rm -rf -- "$PRIVATE_WORK" || cleanup_result=1
    else
      printf 'private record refused unsafe temporary cleanup\n' >&2
      cleanup_result=1
    fi
  fi
  exit "$cleanup_result"
}
trap cleanup_private_work EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

PRIVATE_WORK="$(/usr/bin/mktemp -d "$DIST_PHYSICAL/.private-sequence-8-work.XXXXXX")"
if [ ! -d "$PRIVATE_WORK" ] || [ -L "$PRIVATE_WORK" ] ||
   [ "$(/usr/bin/stat -f '%u' "$PRIVATE_WORK")" != "$(/usr/bin/id -u)" ] ||
   [ "$(/usr/bin/stat -f '%Lp' "$PRIVATE_WORK")" != 700 ]; then
  printf 'private record temporary directory is unsafe\n' >&2
  exit 1
fi

PRIVATE_STAGE="$PRIVATE_WORK/private-record"
/bin/mkdir "$PRIVATE_STAGE"
PRIVATE_VALIDATOR="$PRIVATE_STAGE/runtime-raiders-release-validator"
scripts/release/build-runtime-raiders-release-validator.sh \
  "$ROOT/companion" \
  "$PRIVATE_WORK/validator-scratch" \
  "$PRIVATE_VALIDATOR"

PUBLIC_VALIDATOR_SHA="$(/usr/bin/sed -n \
  "s/^RELEASE_VALIDATOR_SHA256='\\([0-9a-f]*\\)'$/\\1/p" \
  "$RELEASE_OUTPUT/install.sh")"
case "$PUBLIC_VALIDATOR_SHA" in
  ''|*[!0-9a-f]*)
    printf 'public installer validator identity is invalid\n' >&2
    exit 1
    ;;
esac
if [ "${#PUBLIC_VALIDATOR_SHA}" -ne 64 ]; then
  printf 'public installer validator identity is invalid\n' >&2
  exit 1
fi
PRIVATE_VALIDATOR_SHA="$(/usr/bin/shasum -a 256 "$PRIVATE_VALIDATOR" |
  /usr/bin/awk 'NR == 1 { print $1 }')"
if [ "$PRIVATE_VALIDATOR_SHA" != "$PUBLIC_VALIDATOR_SHA" ]; then
  printf 'private validator does not match public installer\n' >&2
  exit 1
fi

PRIVATE_MIGRATOR="$PRIVATE_STAGE/migrate-sequence-8.sh"
scripts/release/render-runtime-raiders-installer.sh \
  "$ROOT/companion/legacy-sequence8/migrate.sh" \
  "$PRIVATE_VALIDATOR" \
  "$RUNTIME_RAIDERS_TEAM_ID" \
  "$COMPANION_VERSION" \
  "$RELEASE_SEQUENCE" \
  "$RELEASE_SHA" \
  "$UPDATE_PROTOCOL_VERSION" \
  "$PRIVATE_MIGRATOR"
/bin/sh -n "$PRIVATE_MIGRATOR"

EXPECTED_PRIVATE_FILES="$(printf '%s\n' \
  migrate-sequence-8.sh \
  runtime-raiders-release-validator)"
ACTUAL_PRIVATE_FILES="$(find "$PRIVATE_STAGE" -mindepth 1 -maxdepth 1 \
  -exec basename {} \; | LC_ALL=C sort)"
if [ "$ACTUAL_PRIVATE_FILES" != "$EXPECTED_PRIVATE_FILES" ]; then
  printf 'private sequence-eight staging is incomplete\n' >&2
  exit 1
fi
for private_file in "$PRIVATE_VALIDATOR" "$PRIVATE_MIGRATOR"; do
  if [ ! -f "$private_file" ] || [ -L "$private_file" ]; then
    printf 'private sequence-eight staging contains an unsafe file\n' >&2
    exit 1
  fi
done

if [ -e "$PRIVATE_OUTPUT" ] || [ -L "$PRIVATE_OUTPUT" ]; then
  printf 'private sequence-eight output must remain absent until commit\n' >&2
  exit 1
fi
/bin/mv "$PRIVATE_STAGE" "$PRIVATE_OUTPUT"

FINAL_PRIVATE_FILES="$(find "$PRIVATE_OUTPUT" -mindepth 1 -maxdepth 1 \
  -exec basename {} \; | LC_ALL=C sort)"
if [ "$FINAL_PRIVATE_FILES" != "$EXPECTED_PRIVATE_FILES" ]; then
  printf 'private sequence-eight record is incomplete\n' >&2
  exit 1
fi
/usr/bin/shasum -a 256 \
  "$PRIVATE_OUTPUT/runtime-raiders-release-validator" \
  "$PRIVATE_OUTPUT/migrate-sequence-8.sh"
