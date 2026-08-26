#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0" >&2
  exit 64
}

[ "$#" -eq 0 ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
RELEASE_FILE="$ROOT/companion/RELEASE"
PREPARE="$ROOT/scripts/release/release-runtime-raiders-beta.sh"

[ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ] && [ -x "$PREPARE" ] || {
  echo 'Runtime Raiders local canary source is incomplete.' >&2
  exit 1
}
VERSION_LINE="$(/usr/bin/sed -n '2p' "$RELEASE_FILE")"
case "$VERSION_LINE" in companion_version=*) VERSION="${VERSION_LINE#companion_version=}" ;; *) VERSION='' ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
  /usr/bin/cmp -s "$RELEASE_FILE" <(printf 'format=1\ncompanion_version=%s\n' "$VERSION") || {
  echo 'companion/RELEASE is invalid.' >&2
  exit 1
}

GIT_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" || exit 1
[ -z "$GIT_STATUS" ] || {
  echo 'Runtime Raiders local canary requires a clean reviewed commit.' >&2
  exit 1
}
GIT_SHA="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)"
[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1

/bin/bash "$PREPARE" prepare

OUTPUT="$ROOT/dist/runtime-raiders-beta-$VERSION"
INSTALLER="$OUTPUT/install.sh"
ARCHIVE="$OUTPUT/runtime-raiders-agent.zip"
SUMMARY="$OUTPUT/release-summary.txt"
[ -d "$OUTPUT" ] && [ ! -L "$OUTPUT" ] &&
  [ -x "$INSTALLER" ] && [ -f "$INSTALLER" ] && [ ! -L "$INSTALLER" ] &&
  [ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] &&
  [ -f "$SUMMARY" ] && [ ! -L "$SUMMARY" ] || {
  echo 'Runtime Raiders prepared local release is incomplete.' >&2
  exit 1
}

summary_value() {
  local key="$1" value
  value="$(/usr/bin/awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length($1) + 2) } END { if (count == 1) print value; else exit 1 }' "$SUMMARY")" || return 1
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

SUMMARY_GIT_SHA="$(summary_value git_sha)" &&
  SUMMARY_VERSION="$(summary_value companion_version)" &&
  SUMMARY_ARCHIVE_SHA256="$(summary_value runtime-raiders-agent.zip_sha256)" || {
  echo 'Runtime Raiders release summary is invalid.' >&2
  exit 1
}
ACTUAL_ARCHIVE_SHA256="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk 'NR == 1 { print $1 }')"
[ "$SUMMARY_GIT_SHA" = "$GIT_SHA" ] && [ "$SUMMARY_VERSION" = "$VERSION" ] &&
  [ "$SUMMARY_ARCHIVE_SHA256" = "$ACTUAL_ARCHIVE_SHA256" ] || {
  echo 'Runtime Raiders prepared release does not match the reviewed source.' >&2
  exit 1
}
[ "$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" = '' ] &&
  [ "$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" = "$GIT_SHA" ] || {
  echo 'Runtime Raiders source changed during local preparation.' >&2
  exit 1
}

RUNTIME_RAIDERS_LOCAL_ARCHIVE="$ARCHIVE" /bin/sh "$INSTALLER"

COMMAND="$HOME/.local/bin/raiders"
AGENT="$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent"
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
[ -L "$COMMAND" ] && [ -x "$COMMAND" ] && [ -f "$AGENT" ] && [ ! -L "$AGENT" ] && [ -x "$AGENT" ] &&
  [ ! -e "$LEGACY_PLIST" ] && [ ! -L "$LEGACY_PLIST" ] || {
  echo 'Runtime Raiders local canary installed layout is invalid.' >&2
  exit 1
}

STATUS="$($COMMAND status --json)" || {
  echo 'Runtime Raiders local canary status failed.' >&2
  exit 1
}
status_value() {
  local key="$1"
  printf '%s\n' "$STATUS" | /usr/bin/plutil -extract "$key" raw -o - - 2>/dev/null
}
status_bool() {
  local key="$1"
  printf '%s\n' "$STATUS" | /usr/bin/plutil -extract "$key" raw -expect bool -o - - 2>/dev/null
}

INSTALLED_VERSION="$(status_value installedCompanionVersion)" &&
  DAEMON_RUNNING="$(status_bool daemonRunning)" &&
  ENABLED="$(status_bool enabled)" &&
  ACTIVATION_STATE="$(status_value activationState)" &&
  PERSISTED_STATE="$(status_value persistedState)" &&
  ACTIVE_RUNS="$(status_value activeRunCount)" &&
  QUEUED_EVENTS="$(status_value queuedEventCount)" || {
  echo 'Runtime Raiders local canary status is invalid.' >&2
  exit 1
}
MANAGED_STATUS="$("$AGENT" __runtime-raiders-managed-agent status)" || {
  echo 'Runtime Raiders managed service status failed.' >&2
  exit 1
}

[ "$INSTALLED_VERSION" = "$VERSION" ] && [ "$DAEMON_RUNNING" = true ] &&
  [ "$ENABLED" = false ] && [ "$ACTIVATION_STATE" = disabled ] &&
  { [ "$PERSISTED_STATE" = disabled ] || [ "$PERSISTED_STATE" = missing ]; } &&
  [ "$ACTIVE_RUNS" = 0 ] && [ "$QUEUED_EVENTS" = 0 ] &&
  [ "$MANAGED_STATUS" = enabled ] || {
  echo 'Runtime Raiders local canary did not reach installed-off readiness.' >&2
  exit 1
}

echo "Runtime Raiders $VERSION local installed-off canary passed."
echo 'Nothing was published.'
echo 'Collection remains off.'
