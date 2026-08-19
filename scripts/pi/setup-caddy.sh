#!/bin/bash

# One-time, separately authorized Runtime Raiders beta publication bootstrap.
# Normal beta publication never invokes this script, installs config, or reloads Caddy.
set -euo pipefail
umask 077

usage() {
  echo "usage: $0 runtime-raiders-beta-bootstrap" >&2
  exit 64
}
[ "$#" -eq 1 ] && [ "$1" = runtime-raiders-beta-bootstrap ] || usage

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DEST_ROOT=''
CADDY_TOOL=/usr/bin/caddy
SYSTEMCTL_TOOL=/usr/bin/systemctl
VISUDO_TOOL=/usr/sbin/visudo
CURL_TOOL=/usr/bin/curl
ID_TOOL=/usr/bin/id
INSTALL_TOOL=/usr/bin/install
STAT_TOOL=/usr/bin/stat
BEFORE_REPLACE_HOOK=''
TEST_MODE=0
EXPECTED_OWNER=0
EXPECTED_GROUP=0

invalid_test_configuration() {
  echo "Caddy bootstrap test configuration is invalid" >&2
  exit 64
}
validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) invalid_test_configuration ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || invalid_test_configuration
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$(/usr/bin/id -u)" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || invalid_test_configuration
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || invalid_test_configuration
}

if [ -n "${RUNTIME_RAIDERS_CADDY_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_CADDY_TEST_MODE" = 1 ] || invalid_test_configuration
  TEST_MODE=1
  DEST_ROOT="${RUNTIME_RAIDERS_CADDY_TEST_ROOT:-}"
  CADDY_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_CADDY:-}"
  SYSTEMCTL_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL:-}"
  VISUDO_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_VISUDO:-}"
  CURL_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_CURL:-}"
  ID_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_ID:-}"
  INSTALL_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_INSTALL:-}"
  STAT_TOOL="${RUNTIME_RAIDERS_CADDY_TEST_STAT:-}"
  BEFORE_REPLACE_HOOK="${RUNTIME_RAIDERS_CADDY_TEST_BEFORE_REPLACE:-}"
  case "$DEST_ROOT" in /*) ;; *) invalid_test_configuration ;; esac
  [ -d "$DEST_ROOT" ] && [ ! -L "$DEST_ROOT" ] &&
    [ "$(cd "$DEST_ROOT" && pwd -P)" = "$DEST_ROOT" ] || invalid_test_configuration
  EXPECTED_OWNER="$(/usr/bin/id -u)"
  EXPECTED_GROUP="$(/usr/bin/id -g)"
  for tool in "$CADDY_TOOL" "$SYSTEMCTL_TOOL" "$VISUDO_TOOL" "$CURL_TOOL" "$ID_TOOL" "$INSTALL_TOOL" "$STAT_TOOL"; do
    validate_test_tool "$tool"
  done
  [ -z "$BEFORE_REPLACE_HOOK" ] || validate_test_tool "$BEFORE_REPLACE_HOOK"
else
  for injected_name in \
    RUNTIME_RAIDERS_CADDY_TEST_ROOT RUNTIME_RAIDERS_CADDY_TEST_CADDY \
    RUNTIME_RAIDERS_CADDY_TEST_SYSTEMCTL RUNTIME_RAIDERS_CADDY_TEST_VISUDO \
    RUNTIME_RAIDERS_CADDY_TEST_CURL RUNTIME_RAIDERS_CADDY_TEST_ID \
    RUNTIME_RAIDERS_CADDY_TEST_INSTALL RUNTIME_RAIDERS_CADDY_TEST_STAT \
    RUNTIME_RAIDERS_CADDY_TEST_BEFORE_REPLACE; do
    [ -z "${!injected_name:-}" ] || invalid_test_configuration
  done
fi

RELEASE_USER="${RUNTIME_RAIDERS_RELEASE_USER:-rluser}"
[[ "$RELEASE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || {
  echo "RUNTIME_RAIDERS_RELEASE_USER is invalid" >&2
  exit 64
}
"$ID_TOOL" -u "$RELEASE_USER" >/dev/null 2>&1 || {
  echo "Runtime Raiders release user does not exist: $RELEASE_USER" >&2
  exit 67
}

target() { printf '%s%s\n' "$DEST_ROOT" "$1"; }
as_root() {
  if [ "$TEST_MODE" = 1 ]; then "$@"; else /usr/bin/sudo -n "$@"; fi
}
file_uid() { "$STAT_TOOL" -c '%u' "$1" 2>/dev/null || "$STAT_TOOL" -f '%u' "$1"; }
file_gid() { "$STAT_TOOL" -c '%g' "$1" 2>/dev/null || "$STAT_TOOL" -f '%g' "$1"; }
file_links() { "$STAT_TOOL" -c '%h' "$1" 2>/dev/null || "$STAT_TOOL" -f '%l' "$1"; }
file_mode() { "$STAT_TOOL" -c '%a' "$1" 2>/dev/null || "$STAT_TOOL" -f '%Lp' "$1"; }

CADDY_PARENT="$(target /etc/caddy)"
PUBLISHER_PARENT="$(target /usr/local/sbin)"
SUDOERS_PARENT="$(target /etc/sudoers.d)"
VAR_LIB_PARENT="$(target /var/lib)"
CADDY_TARGET="$CADDY_PARENT/Caddyfile"
CADDY_ENV="$CADDY_PARENT/cloudflare.env"
PUBLISHER_TARGET="$PUBLISHER_PARENT/runtime-raiders-publish"
SUDOERS_TARGET="$SUDOERS_PARENT/runtime-raiders-publish"
RUNTIME_ROOT="$(target /var/lib/runtime-raiders)"
PUBLIC_ROOT="$RUNTIME_ROOT/public"
STAGING_ROOT="$RUNTIME_ROOT/staging"

safe_parent() {
  local directory="$1" resolved mode
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  resolved="$(cd "$directory" && pwd -P)" || return 1
  [ "$resolved" = "$directory" ] && [ "$(file_uid "$directory")" = "$EXPECTED_OWNER" ] || return 1
  mode="$(file_mode "$directory")"
  (( (8#$mode & 8#022) == 0 ))
}
safe_target() {
  local path="$1" required="${2:-0}" mode
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then [ "$required" = 0 ]; return; fi
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(file_uid "$path")" = "$EXPECTED_OWNER" ] &&
    [ "$(file_links "$path")" = 1 ] || return 1
  mode="$(file_mode "$path")"
  (( (8#$mode & 8#022) == 0 ))
}
check_boundary() {
  safe_parent "${1%/*}" && safe_target "$1" "${2:-0}"
}
safe_caddy_environment() {
  local mode
  safe_parent "${CADDY_ENV%/*}" &&
    [ -f "$CADDY_ENV" ] && [ ! -L "$CADDY_ENV" ] &&
    [ "$(file_uid "$CADDY_ENV")" = "$EXPECTED_OWNER" ] &&
    [ "$(file_gid "$CADDY_ENV")" = "$EXPECTED_GROUP" ] &&
    [ "$(file_links "$CADDY_ENV")" = 1 ] || return 1
  mode="$(file_mode "$CADDY_ENV")"
  (( 8#$mode == 8#600 ))
}
manager_exec_is_exact() {
  local value="$1" expected="$2"
  printf '%s\n' "$value" | /usr/bin/awk -v expected="$expected" '
    NR == 1 {
      prefix = "{ path=/usr/bin/caddy ; argv[]="
      suffix = " ; ignore_errors=no ;"
      if (substr($0, 1, length(prefix)) != prefix) exit 1
      rest = substr($0, length(prefix) + 1)
      stop = index(rest, suffix)
      if (stop == 0 || substr(rest, 1, stop - 1) != expected) exit 1
      tail = substr(rest, stop + length(suffix))
      if (index(tail, "argv[]=") > 0 || index(tail, "} {") > 0) exit 1
      seen = 1
    }
    NR > 1 { exit 1 }
    END { if (seen != 1) exit 1 }
  '
}
manager_unit_is_exact() {
  local start reload environment_files
  start="$("$SYSTEMCTL_TOOL" show caddy --property=ExecStart --value --no-pager)" || return 1
  reload="$("$SYSTEMCTL_TOOL" show caddy --property=ExecReload --value --no-pager)" || return 1
  environment_files="$("$SYSTEMCTL_TOOL" show caddy --property=EnvironmentFiles --value --no-pager)" || return 1
  manager_exec_is_exact "$start" '/usr/bin/caddy run --config /etc/caddy/Caddyfile' &&
    manager_exec_is_exact "$reload" '/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force' &&
    [ "$environment_files" = '/etc/caddy/cloudflare.env (ignore_errors=no)' ]
}

for directory in "$CADDY_PARENT" "$PUBLISHER_PARENT" "$SUDOERS_PARENT" "$VAR_LIB_PARENT"; do
  safe_parent "$directory" || { echo "unsafe bootstrap parent: $directory" >&2; exit 1; }
done
check_boundary "$CADDY_TARGET" 1 || { echo "existing Caddy target is unsafe or missing" >&2; exit 1; }
safe_caddy_environment || { echo "protected Caddy environment metadata is invalid" >&2; exit 1; }
check_boundary "$PUBLISHER_TARGET" 0 || { echo "existing publisher target is unsafe" >&2; exit 1; }
check_boundary "$SUDOERS_TARGET" 0 || { echo "existing sudoers target is unsafe" >&2; exit 1; }

[ -x "$CADDY_TOOL" ] && "$CADDY_TOOL" list-modules 2>/dev/null | /usr/bin/grep -q dns.providers.cloudflare || {
  echo "Caddy with the Cloudflare DNS module must already be installed" >&2
  exit 69
}
manager_unit_is_exact || {
  echo "manager-loaded Caddy unit does not use the required config, reload, and environment" >&2
  exit 1
}

WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-caddy-bootstrap.XXXXXX")"
BACKUP="$WORK/backup"
/bin/mkdir -m 0700 "$BACKUP"
CANDIDATE_PUBLISHER="$WORK/runtime-raiders-publish"
CANDIDATE_SUDOERS="$WORK/runtime-raiders-publish.sudoers"
CANDIDATE_CADDY="$WORK/Caddyfile"
/bin/cp "$REPO_DIR/scripts/pi/publish-runtime-raiders-beta.sh" "$CANDIDATE_PUBLISHER"
/bin/chmod 0755 "$CANDIDATE_PUBLISHER"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/runtime-raiders-publish /var/lib/runtime-raiders/staging/release-*\n' \
  "$RELEASE_USER" > "$CANDIDATE_SUDOERS"
/bin/chmod 0440 "$CANDIDATE_SUDOERS"
/bin/cp "$REPO_DIR/deploy/Caddyfile" "$CANDIDATE_CADDY"
/bin/chmod 0644 "$CANDIDATE_CADDY"

/bin/bash -n "$CANDIDATE_PUBLISHER"
"$VISUDO_TOOL" -cf "$CANDIDATE_SUDOERS"
"$CADDY_TOOL" validate --config "$CANDIDATE_CADDY"

PUBLISHER_EXISTED=0
SUDOERS_EXISTED=0
CADDY_EXISTED=1
backup_target() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then
    as_root /bin/cp -p "$path" "$BACKUP/$label"
    case "$label" in publisher) PUBLISHER_EXISTED=1 ;; sudoers) SUDOERS_EXISTED=1 ;; esac
  fi
}

TRANSACTION_ACTIVE=0
CREATED_RUNTIME_ROOT=0
CREATED_PUBLIC_ROOT=0
CREATED_STAGING_ROOT=0
rollback_target() {
  local label="$1" path="$2" existed="$3"
  safe_parent "${path%/*}" || return 1
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ ! -d "$path" ] || return 1
    as_root /bin/rm -f -- "$path"
  fi
  if [ "$existed" = 1 ]; then
    as_root /bin/cp -p "$BACKUP/$label" "$path"
    /usr/bin/cmp -s "$BACKUP/$label" "$path" || return 1
  fi
}
rollback() {
  local rollback_status=0
  rollback_target caddy "$CADDY_TARGET" "$CADDY_EXISTED" || rollback_status=1
  rollback_target sudoers "$SUDOERS_TARGET" "$SUDOERS_EXISTED" || rollback_status=1
  rollback_target publisher "$PUBLISHER_TARGET" "$PUBLISHER_EXISTED" || rollback_status=1
  if [ -f "$CADDY_TARGET" ] && [ ! -L "$CADDY_TARGET" ]; then
    as_root "$CADDY_TOOL" validate --config "$CADDY_TARGET" \
      --adapter caddyfile --envfile "$CADDY_ENV" || rollback_status=1
    if manager_unit_is_exact; then
      as_root "$SYSTEMCTL_TOOL" reload caddy || rollback_status=1
    else
      as_root "$CADDY_TOOL" adapt --config "$CADDY_TARGET" \
        --adapter caddyfile --envfile "$CADDY_ENV" |
        as_root "$CADDY_TOOL" reload --config - --force || rollback_status=1
    fi
  else
    rollback_status=1
  fi
  [ "$CREATED_STAGING_ROOT" = 0 ] || as_root /bin/rmdir "$STAGING_ROOT" 2>/dev/null || rollback_status=1
  [ "$CREATED_PUBLIC_ROOT" = 0 ] || as_root /bin/rmdir "$PUBLIC_ROOT" 2>/dev/null || rollback_status=1
  [ "$CREATED_RUNTIME_ROOT" = 0 ] || as_root /bin/rmdir "$RUNTIME_ROOT" 2>/dev/null || rollback_status=1
  return "$rollback_status"
}
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ "$TRANSACTION_ACTIVE" = 1 ]; then rollback || status=1; fi
  as_root /bin/rm -rf -- "$WORK" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$TEST_MODE" = 0 ]; then /usr/bin/sudo -v; fi
backup_target publisher "$PUBLISHER_TARGET"
backup_target sudoers "$SUDOERS_TARGET"
backup_target caddy "$CADDY_TARGET"
TRANSACTION_ACTIVE=1

ensure_runtime_directory() {
  local directory="$1" mode="$2" created_variable="$3" actual_mode
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    safe_parent "$directory" || return 1
    actual_mode="$(file_mode "$directory")"
    (( 8#$actual_mode == 8#$mode )) || return 1
  else
    safe_parent "${directory%/*}" || return 1
    if [ "$TEST_MODE" = 1 ]; then
      as_root "$INSTALL_TOOL" -d -m "$mode" "$directory"
    else
      as_root "$INSTALL_TOOL" -d -m "$mode" -o root -g root "$directory"
    fi
    printf -v "$created_variable" '%s' 1
    safe_parent "$directory" || return 1
    actual_mode="$(file_mode "$directory")"
    (( 8#$actual_mode == 8#$mode ))
  fi
}
ensure_runtime_directory "$RUNTIME_ROOT" 0755 CREATED_RUNTIME_ROOT
ensure_runtime_directory "$PUBLIC_ROOT" 0755 CREATED_PUBLIC_ROOT
ensure_runtime_directory "$STAGING_ROOT" 0700 CREATED_STAGING_ROOT

replace_target() {
  local label="$1" candidate="$2" destination="$3" mode="$4" required="$5"
  check_boundary "$destination" "$required" || { echo "unsafe target before replacement: $label" >&2; return 1; }
  [ -z "$BEFORE_REPLACE_HOOK" ] || "$BEFORE_REPLACE_HOOK" "$label" "$destination"
  check_boundary "$destination" "$required" || { echo "unsafe target at replacement: $label" >&2; return 1; }
  if [ "$TEST_MODE" = 1 ]; then
    as_root "$INSTALL_TOOL" -m "$mode" "$candidate" "$destination"
  else
    as_root "$INSTALL_TOOL" -o root -g root -m "$mode" "$candidate" "$destination"
  fi
  check_boundary "$destination" 1 && /usr/bin/cmp -s "$candidate" "$destination"
}

replace_target publisher "$CANDIDATE_PUBLISHER" "$PUBLISHER_TARGET" 0755 0
/bin/bash -n "$PUBLISHER_TARGET"
replace_target sudoers "$CANDIDATE_SUDOERS" "$SUDOERS_TARGET" 0440 0
as_root "$VISUDO_TOOL" -cf "$SUDOERS_TARGET"
replace_target caddy "$CANDIDATE_CADDY" "$CADDY_TARGET" 0644 1
"$CADDY_TOOL" validate --config "$CADDY_TARGET"
safe_caddy_environment || { echo "protected Caddy environment changed before reload" >&2; exit 1; }
as_root "$SYSTEMCTL_TOOL" reload caddy
manager_unit_is_exact || {
  echo "manager-loaded Caddy unit changed after reload" >&2
  exit 1
}
safe_caddy_environment || { echo "protected Caddy environment changed after reload" >&2; exit 1; }
as_root "$SYSTEMCTL_TOOL" is-active --quiet caddy

for hostname in raiders.redlattice.com clauderpg.redlattice.com; do
  HEALTH_RESULT="$WORK/health-$hostname"
  "$CURL_TOOL" -fsS "https://$hostname/health" > "$HEALTH_RESULT"
  /usr/bin/cmp -s "$HEALTH_RESULT" <(printf '{"ok":true}\n') || {
    echo "Caddy bootstrap health check failed: $hostname" >&2
    exit 1
  }
done

TRANSACTION_ACTIVE=0
echo "Runtime Raiders beta Caddy bootstrap installed and verified."
echo "Normal releases now use the fixed root-owned publisher without reloading Caddy."
