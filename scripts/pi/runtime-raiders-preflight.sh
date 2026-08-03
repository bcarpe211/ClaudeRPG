#!/usr/bin/env bash
# Read-only readiness report for a separately authorized Runtime Raiders cutover.
# This script deliberately does not fetch, install, write configuration, alter
# the database, change hostnames, or change service state.
set -u
set -o pipefail

usage() {
  echo "usage: runtime-raiders-preflight.sh --db PATH --env PATH --repo PATH --release-sha SHA --cutover-at MS --caddy-config PATH --caddy-env PATH" >&2
  exit 64
}

DB=''
ENV_FILE=''
REPO=''
RELEASE_SHA=''
CUTOVER_AT=''
CADDY_CONFIG=''
CADDY_ENV=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      [ "$#" -ge 2 ] || usage
      DB=$2
      shift 2
      ;;
    --env)
      [ "$#" -ge 2 ] || usage
      ENV_FILE=$2
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || usage
      REPO=$2
      shift 2
      ;;
    --release-sha)
      [ "$#" -ge 2 ] || usage
      RELEASE_SHA=$2
      shift 2
      ;;
    --cutover-at)
      [ "$#" -ge 2 ] || usage
      CUTOVER_AT=$2
      shift 2
      ;;
    --caddy-config)
      [ "$#" -ge 2 ] || usage
      CADDY_CONFIG=$2
      shift 2
      ;;
    --caddy-env)
      [ "$#" -ge 2 ] || usage
      CADDY_ENV=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -n "$DB" ] && [ -n "$ENV_FILE" ] && [ -n "$REPO" ] &&
  [ -n "$RELEASE_SHA" ] && [ -n "$CUTOVER_AT" ] &&
  [ -n "$CADDY_CONFIG" ] && [ -n "$CADDY_ENV" ] || usage

failures=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

env_value() {
  key=$1
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
        count++
        sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
        value = line
      }
    }
    END {
      if (count == 1) {
        print value
        exit 0
      }
      exit 1
    }
  ' "$ENV_FILE"
}

numeric() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

valid_ipv4() {
  old_ifs=$IFS
  IFS=.
  set -- $1
  IFS=$old_ifs
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    numeric "$octet" || return 1
    [ "$octet" -le 255 ] || return 1
  done
}

paths_ok=1
repo_actual=''
if [ -d "$REPO" ]; then
  repo_actual=$(cd -- "$REPO" 2>/dev/null && pwd -P) || paths_ok=0
else
  paths_ok=0
fi
[ -n "$repo_actual" ] || paths_ok=0
[ -e "$REPO/.git" ] || paths_ok=0
[ -f "$DB" ] && [ -r "$DB" ] || paths_ok=0
[ "$DB" = "$REPO/data/claude-rpg.db" ] || paths_ok=0
[ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || paths_ok=0
[ -f "$REPO/deploy/Caddyfile" ] && [ -r "$REPO/deploy/Caddyfile" ] || paths_ok=0
[ -f "$CADDY_CONFIG" ] && [ -r "$CADDY_CONFIG" ] || paths_ok=0
[ -f "$CADDY_ENV" ] && [ -r "$CADDY_ENV" ] || paths_ok=0
if [ "$paths_ok" -eq 1 ]; then pass 'paths'; else fail 'paths'; fi

integrity=''
if [ -f "$DB" ] && [ -r "$DB" ]; then
  integrity=$(sqlite3 -readonly "$DB" 'PRAGMA query_only=ON; PRAGMA integrity_check;' 2>/dev/null) || integrity=''
fi
if [ "$integrity" = 'ok' ]; then pass 'database integrity'; else fail 'database integrity'; fi

paused=''
if [ -f "$DB" ] && [ -r "$DB" ]; then
  paused=$(sqlite3 -readonly "$DB" 'PRAGMA query_only=ON; SELECT paused FROM game_state WHERE id=1;' 2>/dev/null) || paused=''
fi
if [ "$paused" = '1' ]; then pass 'game paused'; else fail 'game paused'; fi

git_ok=1
git_root=''
git_status=''
target_commit=''
local_commit=''
release_ahead=0
if [ -d "$REPO" ] && [ -e "$REPO/.git" ]; then
  git_root=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || git_ok=0
  local_commit=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || git_ok=0
  git_status=$(git -C "$REPO" status --porcelain 2>/dev/null) || git_ok=0
  target_commit=$(git -C "$REPO" rev-parse --verify 'origin/main^{commit}' 2>/dev/null) || git_ok=0
  if [ "$local_commit" != "$target_commit" ]; then
    release_ahead=1
    git -C "$REPO" merge-base --is-ancestor HEAD origin/main >/dev/null 2>&1 || git_ok=0
  fi
else
  git_ok=0
fi
[ "$git_root" = "$REPO" ] || git_ok=0
[ -z "$git_status" ] || git_ok=0
case "$target_commit" in
  *[!0-9a-fA-F]*|'') git_ok=0 ;;
esac
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || git_ok=0
[ "$target_commit" = "$RELEASE_SHA" ] || git_ok=0
if [ "$git_ok" -eq 1 ]; then pass 'Git readiness'; else fail 'Git readiness'; fi

environment_ok=1
configured_db=''
public_url=''
scoring_mode=''
cutover=''
policy_path=''
enabled_surfaces=''
if [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
  configured_db=$(env_value DB_PATH 2>/dev/null) || environment_ok=0
  public_url=$(env_value PUBLIC_URL 2>/dev/null) || environment_ok=0
  scoring_mode=$(env_value SCORING_MODE 2>/dev/null) || environment_ok=0
  cutover=$(env_value RUN_SCORING_CUTOVER_AT 2>/dev/null) || environment_ok=0
  policy_path=$(env_value RAID_POWER_POLICY_PATH 2>/dev/null) || environment_ok=0
  enabled_surfaces=$(env_value RUN_ENABLED_SURFACES 2>/dev/null) || environment_ok=0
else
  environment_ok=0
fi
[ "$configured_db" = "$DB" ] || environment_ok=0
[ "$public_url" = 'https://raiders.redlattice.com' ] || environment_ok=0
[ "$scoring_mode" = 'runtime-raiders' ] || environment_ok=0
[[ "$cutover" =~ ^[0-9]{13}$ ]] || environment_ok=0
[[ "$CUTOVER_AT" =~ ^[0-9]{13}$ ]] || environment_ok=0
[ "$cutover" = "$CUTOVER_AT" ] || environment_ok=0
[ "$CUTOVER_AT" != '1800000000000' ] || environment_ok=0
[ "$policy_path" = "$REPO/config/raid-power-policy-v1.json" ] || environment_ok=0
[ "$enabled_surfaces" = 'codex_desktop,codex_cli' ] || environment_ok=0
if [ -f "$policy_path" ] && [ -r "$policy_path" ] && [ -s "$policy_path" ]; then
  (
    cd -- "$REPO" &&
      node --import tsx --input-type=module -e '
        const { loadRaidPowerPolicy } = await import("./src/domain/raid-power-policy.ts");
        loadRaidPowerPolicy(process.argv[1]);
      ' "$policy_path"
  ) >/dev/null 2>&1 || environment_ok=0
else
  environment_ok=0
fi
if [ "$environment_ok" -eq 1 ]; then pass 'Runtime Raiders environment'; else fail 'Runtime Raiders environment'; fi

if [ "$paths_ok" -eq 1 ] &&
  git -C "$REPO" show "$RELEASE_SHA:deploy/Caddyfile" 2>/dev/null | cmp -s - "$CADDY_CONFIG" &&
  caddy validate --config "$CADDY_CONFIG" --adapter caddyfile --envfile "$CADDY_ENV" >/dev/null 2>&1; then
  pass 'Caddy configuration'
else
  fail 'Caddy configuration'
fi

hostname_ok=1
current_hostname=$(hostname --short 2>/dev/null) || hostname_ok=0
[ "$current_hostname" = 'raiders' ] || hostname_ok=0
local_addresses=$(hostname -I 2>/dev/null) || hostname_ok=0
resolved_local=$(getent ahostsv4 'raiders.local' 2>/dev/null | awk 'NR == 1 { print $1 }') || hostname_ok=0
valid_ipv4 "$resolved_local" || hostname_ok=0
address_is_local=0
for local_address in $local_addresses; do
  if [ "$local_address" = "$resolved_local" ]; then
    address_is_local=1
    break
  fi
done
[ "$address_is_local" -eq 1 ] || hostname_ok=0
if [ "$hostname_ok" -eq 1 ]; then pass 'hostname resolution'; else fail 'hostname resolution'; fi

if [ "$hostname_ok" -eq 1 ] &&
  curl --fail --silent --show-error --max-time 10 --output /dev/null --noproxy '*' \
    --resolve "raiders.redlattice.com:443:$resolved_local" \
    'https://raiders.redlattice.com/health' >/dev/null 2>&1; then
  pass 'HTTPS new host'
else
  fail 'HTTPS new host'
fi

if [ "$hostname_ok" -eq 1 ] &&
  curl --fail --silent --show-error --max-time 10 --output /dev/null --noproxy '*' \
    --resolve "clauderpg.redlattice.com:443:$resolved_local" \
    'https://clauderpg.redlattice.com/health' >/dev/null 2>&1; then
  pass 'HTTPS old host'
else
  fail 'HTTPS old host'
fi

units_ok=1
server_state=$(systemctl is-active claude-rpg.service 2>/dev/null) || true
timer_enabled_state=$(systemctl is-enabled claude-rpg-autoupdate.timer 2>/dev/null) || true
timer_active_state=$(systemctl is-active claude-rpg-autoupdate.timer 2>/dev/null) || true
avahi_state=$(systemctl is-active avahi-daemon.service 2>/dev/null) || true
[ "$server_state" = 'active' ] || units_ok=0
[ "$avahi_state" = 'active' ] || units_ok=0
if [ "$release_ahead" -eq 1 ]; then
  [ "$timer_enabled_state" = 'disabled' ] || units_ok=0
  [ "$timer_active_state" = 'inactive' ] || units_ok=0
fi
if [ "$units_ok" -eq 1 ]; then pass 'systemd units'; else fail 'systemd units'; fi

disk_ok=1
snapshot_geometry=''
page_count=''
page_size=''
release_kb=''
free_kb=''
if [ -f "$DB" ] && [ -d "$REPO" ]; then
  snapshot_geometry=$(sqlite3 -readonly "$DB" 'PRAGMA query_only=ON; PRAGMA page_count; PRAGMA page_size;' 2>/dev/null) || disk_ok=0
  page_count=$(printf '%s\n' "$snapshot_geometry" | awk 'NR == 1 { print }')
  page_size=$(printf '%s\n' "$snapshot_geometry" | awk 'NR == 2 { print }')
  [ "$(printf '%s\n' "$snapshot_geometry" | awk 'END { print NR }')" = '2' ] || disk_ok=0
  release_kb=$(du -sk -- "$REPO" 2>/dev/null | awk 'NR == 1 { print $1 }') || disk_ok=0
  free_kb=$(df -Pk -- "$REPO" 2>/dev/null | awk 'NR == 2 { print $4 }') || disk_ok=0
else
  disk_ok=0
fi
numeric "$page_count" || disk_ok=0
numeric "$page_size" || disk_ok=0
numeric "$release_kb" || disk_ok=0
numeric "$free_kb" || disk_ok=0
if [ "$disk_ok" -eq 1 ]; then
  if [ "${#page_count}" -gt 10 ] || [ "${#page_size}" -gt 5 ] ||
    [ "${#release_kb}" -gt 15 ] || [ "${#free_kb}" -gt 15 ]; then
    disk_ok=0
  else
    snapshot_bytes=$((page_count * page_size))
    backup_bytes_with_margin=$(((snapshot_bytes * 110 + 99) / 100))
    backup_kb=$(((backup_bytes_with_margin + 1023) / 1024))
    required_kb=$((release_kb + (2 * backup_kb)))
    [ "$free_kb" -ge "$required_kb" ] || disk_ok=0
  fi
fi
if [ "$disk_ok" -eq 1 ]; then pass 'disk capacity'; else fail 'disk capacity'; fi

# This is intentionally the final external operation. A ready result is valid
# only for the pause state observed after every slower readiness check.
final_paused=''
if [ -f "$DB" ] && [ -r "$DB" ]; then
  final_paused=$(sqlite3 -readonly "$DB" 'PRAGMA query_only=ON; SELECT paused FROM game_state WHERE id=1;' 2>/dev/null) || final_paused=''
fi
if [ "$final_paused" = '1' ]; then pass 'final game paused'; else fail 'final game paused'; fi

if [ "$failures" -eq 0 ]; then
  echo 'READY separately authorized cutover gates passed'
  exit 0
fi

echo 'NOT READY one or more cutover gates failed'
exit 1
