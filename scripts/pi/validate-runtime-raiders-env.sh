#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Runtime Raiders environment rejected: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: %s --env-file <path> --repo-dir <path>\n' "$0" >&2
  exit 64
}

ENV_FILE=''
REPO_DIR=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || usage; ENV_FILE=$2; shift 2 ;;
    --repo-dir) [[ $# -ge 2 ]] || usage; REPO_DIR=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$ENV_FILE" && -n "$REPO_DIR" ]] || usage
[[ "$ENV_FILE" = /* && "$REPO_DIR" = /* ]] || fail 'paths must be absolute'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'environment must be a nonsymlink regular file'
[[ -d "$REPO_DIR" && ! -L "$REPO_DIR" ]] || fail 'repository must be a nonsymlink directory'

if mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null); then :; else
  mode=$(stat -f '%Lp' "$ENV_FILE")
fi
[[ "$mode" = 600 ]] || fail 'environment mode must be 0600'
if [[ $EUID -eq 0 ]]; then
  if owner=$(stat -c '%u' "$ENV_FILE" 2>/dev/null); then :; else
    owner=$(stat -f '%u' "$ENV_FILE")
  fi
  [[ "$owner" = 0 ]] || fail 'environment must be owned by root'
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" = \#* ]] && continue
  [[ "$line" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || fail 'only unquoted KEY=value assignments are allowed'
done < "$ENV_FILE"

required_value() {
  local key=$1
  local count
  count=$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$ENV_FILE")
  [[ "$count" = 1 ]] || fail "$key must appear exactly once"
  ENV_VALUE=$(awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$ENV_FILE")
  [[ -n "$ENV_VALUE" ]] || fail "$key must not be empty"
}

required_value PORT
[[ "$ENV_VALUE" =~ ^[0-9]+$ ]] && (( ENV_VALUE >= 1 && ENV_VALUE <= 65535 )) \
  || fail 'PORT must be an integer from 1 through 65535'

required_value ADMIN_PASSWORD
[[ "$ENV_VALUE" != change-me-please && "$ENV_VALUE" != changeme && ${#ENV_VALUE} -ge 16 ]] \
  || fail 'ADMIN_PASSWORD is placeholder or too short'

required_value SESSION_SECRET
[[ "$ENV_VALUE" != change-me-too && "$ENV_VALUE" != changeme && ${#ENV_VALUE} -ge 32 ]] \
  || fail 'SESSION_SECRET is placeholder or too short'

required_value DB_PATH
[[ "$ENV_VALUE" = "$REPO_DIR/data/claude-rpg.db" ]] || fail 'DB_PATH is not the fixed repository database path'
required_value SPRITES_DIR
[[ "$ENV_VALUE" = "$REPO_DIR/assets/oryx_16-bit_fantasy_1.1/Sliced" ]] \
  || fail 'SPRITES_DIR is not the fixed repository sprite path'
required_value PUBLIC_URL
[[ "$ENV_VALUE" = https://raiders.redlattice.com ]] || fail 'PUBLIC_URL must be the exact HTTPS origin'

required_value SCORING_MODE
SCORING_MODE=$ENV_VALUE
case "$SCORING_MODE" in disabled|legacy-otlp|runtime-raiders) ;; *) fail 'SCORING_MODE is invalid' ;; esac

required_value RAID_POWER_POLICY_PATH
[[ "$ENV_VALUE" = "$REPO_DIR/config/raid-power-policy-v1.json" ]] \
  || fail 'RAID_POWER_POLICY_PATH is not the reviewed repository policy'
[[ -f "$ENV_VALUE" && ! -L "$ENV_VALUE" ]] || fail 'Raid Power policy is missing or unsafe'

required_value RAID_POWER_POLICY_V2_PATH
[[ "$ENV_VALUE" = "$REPO_DIR/config/raid-power-policy-v2.json" ]] \
  || fail 'RAID_POWER_POLICY_V2_PATH is not the reviewed repository policy'
[[ -f "$ENV_VALUE" && ! -L "$ENV_VALUE" ]] || fail 'Raid Power v2 policy is missing or unsafe'

required_value RUN_SCORING_CUTOVER_AT
RUN_SCORING_CUTOVER_AT=$ENV_VALUE
required_value RAID_POWER_V2_CUTOVER_AT
RAID_POWER_V2_CUTOVER_AT=$ENV_VALUE
required_value RUN_ENABLED_SURFACES
RUN_ENABLED_SURFACES=$ENV_VALUE

if [[ "$SCORING_MODE" = runtime-raiders ]]; then
  [[ "$RUN_SCORING_CUTOVER_AT" =~ ^[0-9]{13}$ ]] \
    || fail 'RUN_SCORING_CUTOVER_AT must be one 13-digit millisecond epoch'
  [[ "$RUN_SCORING_CUTOVER_AT" != 1800000000000 ]] \
    || fail 'placeholder RUN_SCORING_CUTOVER_AT is forbidden in runtime-raiders mode'
  [[ "$RAID_POWER_V2_CUTOVER_AT" =~ ^[0-9]{13}$ ]] \
    || fail 'RAID_POWER_V2_CUTOVER_AT must be one 13-digit millisecond epoch'
  [[ "$RAID_POWER_V2_CUTOVER_AT" != 1800000000000 ]] \
    || fail 'placeholder RAID_POWER_V2_CUTOVER_AT is forbidden in runtime-raiders mode'
  [[ "$RAID_POWER_V2_CUTOVER_AT" < "$RUN_SCORING_CUTOVER_AT" ]] \
    && fail 'RAID_POWER_V2_CUTOVER_AT must not be earlier than RUN_SCORING_CUTOVER_AT'
  [[ "$RUN_ENABLED_SURFACES" = codex_desktop,codex_cli ]] \
    || fail 'RUN_ENABLED_SURFACES must be exactly codex_desktop,codex_cli'
fi

printf 'Runtime Raiders environment accepted for SCORING_MODE=%s\n' "$SCORING_MODE"
