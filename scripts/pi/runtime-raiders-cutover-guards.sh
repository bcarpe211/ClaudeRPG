#!/usr/bin/env bash
set -Eeuo pipefail

rr_assert_checkout() {
  local repo="$1"
  local expected_head="$2"
  local expected_origin="${3:--}"
  local observed_head
  local observed_status
  local observed_origin

  observed_head="$(sudo -u rluser git --no-optional-locks -C "$repo" rev-parse HEAD)"
  test "$observed_head" = "$expected_head"

  observed_status="$(sudo -u rluser git --no-optional-locks -C "$repo" status --porcelain)"
  test -z "$observed_status"

  if test "$expected_origin" != -; then
    observed_origin="$(sudo -u rluser git --no-optional-locks -C "$repo" rev-parse origin/main)"
    test "$observed_origin" = "$expected_origin"
  fi
}

rr_assert_owned_tree() {
  local root="$1"
  local foreign_path

  foreign_path="$(sudo find "$root" -xdev ! -user rluser -print -quit)"
  test -z "$foreign_path"
}

rr_authenticate_rollback_record() {
  local record="$1"
  local seal="$2"
  local expected="$3"
  local sealed
  local actual_line
  local actual

  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  sealed="$(awk '
    NR == 1 && NF == 1 { value = $1; next }
    { exit 1 }
    END { if (NR != 1) exit 1; print value }
  ' "$seal")" || return 1
  [[ "$sealed" =~ ^[0-9a-f]{64}$ ]] || return 1
  test "$sealed" = "$expected" || return 1

  actual_line="$(sha256sum -- "$record")" || return 1
  actual="${actual_line%% *}"
  [[ "$actual" =~ ^[0-9a-f]{64}$ ]] || return 1
  test "$actual" = "$expected" || return 1
}

rr_observe_systemctl() {
  local destination="${1:-}"
  shift || return 64
  [[ "$destination" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 64
  test "$#" -ge 2 || return 64

  local action="$1"
  local observed=''
  local status=0
  if observed="$(trap - ERR; systemctl "$@" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi

  case "$action" in
    is-active)
      case "$status" in 0|3|4) ;; *) return "$status" ;; esac
      ;;
    is-enabled)
      case "$status" in 0|1) ;; *) return "$status" ;; esac
      ;;
    show)
      test "$status" -eq 0 || return "$status"
      ;;
    *) return 64 ;;
  esac
  test -n "$observed" || return 1
  printf -v "$destination" '%s' "$observed"
}

rr_assert_updater_held() {
  local timer="${1:-}"
  local service="${2:-}"
  test -n "$timer" && test -n "$service" || return 64

  local timer_enabled timer_active updater_active
  rr_observe_systemctl timer_enabled is-enabled "$timer" || return $?
  rr_observe_systemctl timer_active is-active "$timer" || return $?
  rr_observe_systemctl updater_active is-active "$service" || return $?
  test "$timer_enabled" = disabled
  test "$timer_active" = inactive
  test "$updater_active" = inactive
}

rr_assert_game_unit() {
  local service="${1:-}"
  local repo="${2:-}"
  local env_file="${3:-}"
  local exec_path="${4:-}"
  test -n "$service" && test -n "$repo" &&
    test -n "$env_file" && test -n "$exec_path" || return 64

  local unit_user unit_working unit_environment loaded_exec
  rr_observe_systemctl unit_user show "$service" --property=User --value
  rr_observe_systemctl unit_working show "$service" --property=WorkingDirectory --value
  rr_observe_systemctl unit_environment show "$service" --property=EnvironmentFiles --value
  rr_observe_systemctl loaded_exec show "$service" --property=ExecStart --value

  test "$unit_user" = rluser
  test "$unit_working" = "$repo"
  test "$unit_environment" = "$env_file (ignore_errors=no)"
  [[ "$loaded_exec" != *$'\n'* ]]

  local path_count=0
  local argv_count=0
  local token
  local -a tokens=()
  read -r -a tokens <<<"$loaded_exec"
  for token in "${tokens[@]}"; do
    case "$token" in
      path=*)
        path_count=$((path_count + 1))
        test "$token" = "path=$exec_path"
        ;;
      'argv[]='*)
        argv_count=$((argv_count + 1))
        test "$token" = "argv[]=$exec_path"
        ;;
    esac
  done
  test "$path_count" -eq 1
  test "$argv_count" -eq 1
}
