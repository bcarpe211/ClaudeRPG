#!/usr/bin/env bash
# Read-only readiness report for a separately authorized Runtime Raiders cutover.
# This script deliberately does not fetch, install, write configuration, alter
# the database, change hostnames, or change service state.
set -u
set -o pipefail

usage() {
  echo "usage: runtime-raiders-preflight.sh --db PATH --env PATH --repo PATH --prior-sha SHA --release-sha SHA --cutover-at MS --caddy-config PATH --caddy-env PATH" >&2
  exit 64
}

DB=''
ENV_FILE=''
REPO=''
PRIOR_SHA=''
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
    --prior-sha)
      [ "$#" -ge 2 ] || usage
      PRIOR_SHA=$2
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
  [ -n "$PRIOR_SHA" ] && [ -n "$RELEASE_SHA" ] && [ -n "$CUTOVER_AT" ] &&
  [ -n "$CADDY_CONFIG" ] && [ -n "$CADDY_ENV" ] || usage

failures=0

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

file_value() {
  value_file=$1
  key=$2
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
  ' "$value_file"
}

env_value() {
  file_value "$ENV_FILE" "$1"
}

protected_regular() {
  node -e '
    const { lstatSync } = require("node:fs");
    const status = lstatSync(process.argv[1]);
    process.exit(status.isFile() && (status.mode & 0o077) === 0 ? 0 : 1);
  ' "$1" >/dev/null 2>&1
}

secret_valid() {
  case "$1" in
    ''|'change-me-please'|'change-me-too'|'replace-with-your-cloudflare-token'|'changeme'|'placeholder') return 1 ;;
    *) return 0 ;;
  esac
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
[ -r "$ENV_FILE" ] && protected_regular "$ENV_FILE" || paths_ok=0
[ -f "$CADDY_CONFIG" ] && [ ! -L "$CADDY_CONFIG" ] && [ -r "$CADDY_CONFIG" ] || paths_ok=0
[ -r "$CADDY_ENV" ] && protected_regular "$CADDY_ENV" || paths_ok=0
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
if [ -d "$REPO" ] && [ -e "$REPO/.git" ]; then
  git_root=$(git --no-optional-locks -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || git_ok=0
  local_commit=$(git --no-optional-locks -C "$REPO" rev-parse HEAD 2>/dev/null) || git_ok=0
  git_status=$(git --no-optional-locks -C "$REPO" status --porcelain 2>/dev/null) || git_ok=0
  target_commit=$(git --no-optional-locks -C "$REPO" rev-parse --verify 'origin/main^{commit}' 2>/dev/null) || git_ok=0
  git --no-optional-locks -C "$REPO" merge-base --is-ancestor "$PRIOR_SHA" "$RELEASE_SHA" >/dev/null 2>&1 || git_ok=0
else
  git_ok=0
fi
[ "$git_root" = "$REPO" ] || git_ok=0
[ -z "$git_status" ] || git_ok=0
case "$target_commit" in
  *[!0-9a-fA-F]*|'') git_ok=0 ;;
esac
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || git_ok=0
[[ "$PRIOR_SHA" =~ ^[0-9a-f]{40}$ ]] || git_ok=0
[ "$PRIOR_SHA" != "$RELEASE_SHA" ] || git_ok=0
[ "$local_commit" = "$PRIOR_SHA" ] || git_ok=0
[ "$target_commit" = "$RELEASE_SHA" ] || git_ok=0
if [ "$git_ok" -eq 1 ]; then pass 'Git readiness'; else fail 'Git readiness'; fi

environment_ok=1
configured_db=''
public_url=''
scoring_mode=''
cutover=''
policy_path=''
enabled_surfaces=''
admin_password=''
session_secret=''
if [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
  configured_db=$(env_value DB_PATH 2>/dev/null) || environment_ok=0
  public_url=$(env_value PUBLIC_URL 2>/dev/null) || environment_ok=0
  scoring_mode=$(env_value SCORING_MODE 2>/dev/null) || environment_ok=0
  cutover=$(env_value RUN_SCORING_CUTOVER_AT 2>/dev/null) || environment_ok=0
  policy_path=$(env_value RAID_POWER_POLICY_PATH 2>/dev/null) || environment_ok=0
  enabled_surfaces=$(env_value RUN_ENABLED_SURFACES 2>/dev/null) || environment_ok=0
  admin_password=$(env_value ADMIN_PASSWORD 2>/dev/null) || environment_ok=0
  session_secret=$(env_value SESSION_SECRET 2>/dev/null) || environment_ok=0
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
[ "$paths_ok" -eq 1 ] || environment_ok=0
secret_valid "$admin_password" || environment_ok=0
secret_valid "$session_secret" || environment_ok=0
if [ "$git_ok" -eq 1 ]; then
  (
    cd -- "$REPO" &&
      node -e '
        const { execFileSync } = require("node:child_process");
        const fs = require("node:fs");
        const ts = require("typescript");
        const repo = process.argv[1];
        const release = process.argv[2];
        const show = (path) => execFileSync(
          "git",
          ["--no-optional-locks", "-C", repo, "show", `${release}:${path}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const policy = show("config/raid-power-policy-v1.json");
        const source = show("src/domain/raid-power-policy.ts");
        const javascript = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        const sentinel = "approved-release-policy";
        const moduleObject = { exports: {} };
        const moduleRequire = (id) => id === "node:fs"
          ? { ...fs, readFileSync: (path, encoding) => {
              if (path !== sentinel) throw new Error("unexpected policy path");
              return encoding ? policy : Buffer.from(policy);
            } }
          : require(id);
        Function("require", "module", "exports", javascript)(
          moduleRequire,
          moduleObject,
          moduleObject.exports,
        );
        moduleObject.exports.loadRaidPowerPolicy(sentinel);
      ' "$REPO" "$RELEASE_SHA"
  ) >/dev/null 2>&1 || environment_ok=0
else
  environment_ok=0
fi
if [ "$environment_ok" -eq 1 ]; then pass 'Runtime Raiders environment'; else fail 'Runtime Raiders environment'; fi

caddy_ok=1
caddy_unit=$(systemctl cat caddy.service 2>/dev/null) || caddy_ok=0
caddy_unit_env=$(printf '%s\n' "$caddy_unit" | awk '
  /^[[:space:]]*EnvironmentFile=/ {
    count++
    line = $0
    sub("^[[:space:]]*EnvironmentFile=", "", line)
    sub("^-", "", line)
    value = line
  }
  END { if (count == 1 && value != "") print value; else exit 1 }
') || caddy_ok=0
caddy_unit_config=$(printf '%s\n' "$caddy_unit" | awk '
  /^[[:space:]]*ExecStart=/ {
    lines++
    for (field_index = 1; field_index <= NF; field_index++) {
      if ($field_index == "--config" && field_index < NF) {
        configs++
        value = $(field_index + 1)
      }
    }
  }
  END { if (lines == 1 && configs == 1 && value != "") print value; else exit 1 }
') || caddy_ok=0
[ "$caddy_unit_env" = "$CADDY_ENV" ] || caddy_ok=0
[ "$caddy_unit_config" = "$CADDY_CONFIG" ] || caddy_ok=0
caddy_token=$(file_value "$CADDY_ENV" CLOUDFLARE_API_TOKEN 2>/dev/null) || caddy_ok=0
secret_valid "$caddy_token" || caddy_ok=0
if [ "$caddy_ok" -eq 1 ] && [ "$paths_ok" -eq 1 ] && [ "$git_ok" -eq 1 ] &&
  git --no-optional-locks -C "$REPO" show "$RELEASE_SHA:deploy/Caddyfile" 2>/dev/null | cmp -s - "$CADDY_CONFIG" &&
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

dns_ok=1
for internal_name in raiders.redlattice.com clauderpg.redlattice.com; do
  getent ahostsv4 "$internal_name" 2>/dev/null |
    awk -v expected="$resolved_local" '$1 == expected { found = 1 } END { exit(found ? 0 : 1) }' || dns_ok=0
done
if [ "$dns_ok" -eq 1 ]; then pass 'internal DNS'; else fail 'internal DNS'; fi

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
updater_service_state=$(systemctl is-active claude-rpg-autoupdate.service 2>/dev/null) || true
avahi_state=$(systemctl is-active avahi-daemon.service 2>/dev/null) || true
[ "$server_state" = 'active' ] || units_ok=0
[ "$avahi_state" = 'active' ] || units_ok=0
[ "$timer_enabled_state" = 'disabled' ] || units_ok=0
[ "$timer_active_state" = 'inactive' ] || units_ok=0
[ "$updater_service_state" = 'inactive' ] || units_ok=0
if [ "$units_ok" -eq 1 ]; then pass 'systemd units'; else fail 'systemd units'; fi

disk_ok=1
snapshot_geometry=''
page_count=''
page_size=''
target_tree_bytes=''
node_modules_kb=''
free_kb=''
if [ -f "$DB" ] && [ -d "$REPO" ]; then
  snapshot_geometry=$(sqlite3 -readonly "$DB" 'PRAGMA query_only=ON; PRAGMA page_count; PRAGMA page_size;' 2>/dev/null) || disk_ok=0
  page_count=$(printf '%s\n' "$snapshot_geometry" | awk 'NR == 1 { print }')
  page_size=$(printf '%s\n' "$snapshot_geometry" | awk 'NR == 2 { print }')
  [ "$(printf '%s\n' "$snapshot_geometry" | awk 'END { print NR }')" = '2' ] || disk_ok=0
  target_tree_bytes=$(git --no-optional-locks -C "$REPO" ls-tree -r -l "$RELEASE_SHA" 2>/dev/null | awk '
    $2 == "blob" {
      if ($4 !~ /^[0-9]+$/) bad = 1
      else { total += $4; blobs++ }
    }
    END { if (!bad && blobs > 0) printf "%.0f\n", total; else exit 1 }
  ') || disk_ok=0
  node_modules_kb=$(du -sk -- "$REPO/node_modules" 2>/dev/null | awk 'NR == 1 { print $1 }') || disk_ok=0
  free_kb=$(df -Pk -- "$REPO" 2>/dev/null | awk 'NR == 2 { print $4 }') || disk_ok=0
else
  disk_ok=0
fi
numeric "$page_count" || disk_ok=0
numeric "$page_size" || disk_ok=0
numeric "$target_tree_bytes" || disk_ok=0
numeric "$node_modules_kb" || disk_ok=0
numeric "$free_kb" || disk_ok=0
if [ "$disk_ok" -eq 1 ]; then
  if [ "${#page_count}" -gt 10 ] || [ "${#page_size}" -gt 5 ] ||
    [ "${#target_tree_bytes}" -gt 15 ] || [ "${#node_modules_kb}" -gt 15 ] ||
    [ "${#free_kb}" -gt 15 ]; then
    disk_ok=0
  else
    snapshot_bytes=$((page_count * page_size))
    backup_bytes_with_margin=$(((snapshot_bytes * 110 + 99) / 100))
    backup_kb=$(((backup_bytes_with_margin + 1023) / 1024))
    target_tree_kb=$(((target_tree_bytes + 1023) / 1024))
    target_tree_with_margin_kb=$(((target_tree_kb * 125 + 99) / 100))
    dependency_allowance_kb=$((node_modules_kb * 2))
    [ "$dependency_allowance_kb" -ge 524288 ] || dependency_allowance_kb=524288
    release_kb=$((target_tree_with_margin_kb + dependency_allowance_kb))
    required_kb=$((release_kb + (2 * backup_kb)))
    [ "$free_kb" -ge "$required_kb" ] || disk_ok=0
  fi
fi
if [ "$disk_ok" -eq 1 ]; then pass 'disk capacity'; else fail 'disk capacity'; fi

final_timer_enabled=$(systemctl is-enabled claude-rpg-autoupdate.timer 2>/dev/null) || true
final_timer_active=$(systemctl is-active claude-rpg-autoupdate.timer 2>/dev/null) || true
final_updater_service=$(systemctl is-active claude-rpg-autoupdate.service 2>/dev/null) || true
if [ "$final_timer_enabled" = 'disabled' ] &&
  [ "$final_timer_active" = 'inactive' ] &&
  [ "$final_updater_service" = 'inactive' ]; then
  pass 'final updater hold'
else
  fail 'final updater hold'
fi

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
