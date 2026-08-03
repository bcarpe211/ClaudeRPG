#!/usr/bin/env bash
# Read-only readiness report for a separately authorized Runtime Raiders cutover.
# This script deliberately does not fetch, install, write configuration, alter
# the database, change hostnames, or change service state.
set -u
set -o pipefail

usage() {
  echo "usage: runtime-raiders-preflight.sh --db PATH --env PATH --repo PATH" >&2
  exit 64
}

DB=''
ENV_FILE=''
REPO=''

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
    *) usage ;;
  esac
done

[ -n "$DB" ] && [ -n "$ENV_FILE" ] && [ -n "$REPO" ] || usage

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
if [ -d "$REPO" ] && [ -e "$REPO/.git" ]; then
  git_root=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || git_ok=0
  git_status=$(git -C "$REPO" status --porcelain 2>/dev/null) || git_ok=0
  target_commit=$(git -C "$REPO" rev-parse --verify 'origin/main^{commit}' 2>/dev/null) || git_ok=0
  git -C "$REPO" merge-base --is-ancestor HEAD origin/main >/dev/null 2>&1 || git_ok=0
else
  git_ok=0
fi
[ "$git_root" = "$REPO" ] || git_ok=0
[ -z "$git_status" ] || git_ok=0
case "$target_commit" in
  *[!0-9a-fA-F]*|'') git_ok=0 ;;
esac
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
[ "$policy_path" = "$REPO/config/raid-power-policy-v1.json" ] || environment_ok=0
[ "$enabled_surfaces" = 'codex_desktop,codex_cli' ] || environment_ok=0
if [ -f "$policy_path" ] && [ -r "$policy_path" ] && [ -s "$policy_path" ]; then
  node -e '
    const fs = require("node:fs");
    const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1 ||
        !Array.isArray(policy.enabled_providers) || !policy.enabled_providers.includes("codex")) {
      process.exit(1);
    }
  ' "$policy_path" >/dev/null 2>&1 || environment_ok=0
else
  environment_ok=0
fi
if [ "$environment_ok" -eq 1 ]; then pass 'Runtime Raiders environment'; else fail 'Runtime Raiders environment'; fi

if [ "$paths_ok" -eq 1 ] && caddy validate --config "$REPO/deploy/Caddyfile" --adapter caddyfile --envfile "$ENV_FILE" >/dev/null 2>&1; then
  pass 'Caddy configuration'
else
  fail 'Caddy configuration'
fi

if curl --fail --silent --show-error --max-time 10 --output /dev/null 'https://raiders.redlattice.com/health' >/dev/null 2>&1; then
  pass 'HTTPS new host'
else
  fail 'HTTPS new host'
fi

if curl --fail --silent --show-error --max-time 10 --output /dev/null 'https://clauderpg.redlattice.com/health' >/dev/null 2>&1; then
  pass 'HTTPS old host'
else
  fail 'HTTPS old host'
fi

hostname_ok=1
current_hostname=$(hostname --short 2>/dev/null) || hostname_ok=0
if [ -n "$current_hostname" ]; then
  getent hosts "$current_hostname.local" >/dev/null 2>&1 || hostname_ok=0
else
  hostname_ok=0
fi
getent hosts 'raiders.local' >/dev/null 2>&1 || hostname_ok=0
if [ "$hostname_ok" -eq 1 ]; then pass 'hostname resolution'; else fail 'hostname resolution'; fi

units_ok=1
systemctl is-active --quiet claude-rpg.service || units_ok=0
systemctl is-enabled --quiet claude-rpg-autoupdate.timer || units_ok=0
systemctl is-active --quiet claude-rpg-autoupdate.timer || units_ok=0
if [ "$units_ok" -eq 1 ]; then pass 'systemd units'; else fail 'systemd units'; fi

disk_ok=1
db_bytes=''
release_kb=''
free_kb=''
if [ -f "$DB" ] && [ -d "$REPO" ]; then
  db_bytes=$(stat -c %s -- "$DB" 2>/dev/null) || disk_ok=0
  release_kb=$(du -sk -- "$REPO" 2>/dev/null | awk 'NR == 1 { print $1 }') || disk_ok=0
  free_kb=$(df -Pk -- "$REPO" 2>/dev/null | awk 'NR == 2 { print $4 }') || disk_ok=0
else
  disk_ok=0
fi
numeric "$db_bytes" || disk_ok=0
numeric "$release_kb" || disk_ok=0
numeric "$free_kb" || disk_ok=0
if [ "$disk_ok" -eq 1 ]; then
  if [ "${#db_bytes}" -gt 15 ] || [ "${#release_kb}" -gt 15 ] || [ "${#free_kb}" -gt 15 ]; then
    disk_ok=0
  else
    backup_kb=$(((db_bytes + 1023) / 1024))
    required_kb=$((release_kb + (2 * backup_kb)))
    [ "$free_kb" -ge "$required_kb" ] || disk_ok=0
  fi
fi
if [ "$disk_ok" -eq 1 ]; then pass 'disk capacity'; else fail 'disk capacity'; fi

if [ "$failures" -eq 0 ]; then
  echo 'READY separately authorized cutover gates passed'
  exit 0
fi

echo 'NOT READY one or more cutover gates failed'
exit 1
