#!/bin/bash

# Shared by the unpublished Gate 2 harness and its external-effect-free unit tests.
# This file defines functions only; sourcing it never starts or signals a process.

gate_safe_pid() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt 1 ] 2>/dev/null
}

gate_private_regular() {
  local path="$1" mode
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$path")" = "$(id -u)" ] || return 1
  [ "$(/usr/bin/stat -f '%l' "$path")" = 1 ] || return 1
  mode="$(/usr/bin/stat -f '%Lp' "$path")"
  (( (8#$mode & 8#077) == 0 ))
}

gate_private_directory() {
  local path="$1" mode
  [ -d "$path" ] && [ ! -L "$path" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$path")" = "$(id -u)" ] || return 1
  mode="$(/usr/bin/stat -f '%Lp' "$path")"
  (( (8#$mode & 8#077) == 0 ))
}

gate_runtime_path_for_home() {
  [ "$#" -eq 2 ] || return 1
  local home="$1" gate_bin="$2" command_parent command_directory
  case "$home" in /*) ;; *) return 1 ;; esac
  case "$gate_bin" in /*) ;; *) return 1 ;; esac
  case "$home:$gate_bin" in *$'\n'*|*:*:*) return 1 ;; esac
  gate_private_directory "$home" || return 1
  gate_private_directory "$gate_bin" || return 1
  command_parent="$home/.local"
  command_directory="$command_parent/bin"
  if [ -e "$command_directory" ] || [ -L "$command_directory" ]; then
    gate_private_directory "$command_parent" || return 1
    gate_private_directory "$command_directory" || return 1
    printf '%s:%s:/usr/bin:/bin\n' "$command_directory" "$gate_bin"
  else
    printf '%s:/usr/bin:/bin\n' "$gate_bin"
  fi
}

gate_process_format_identity() {
  local start="$1" command="$2"
  [ -n "$start" ] && [ -n "$command" ] || return 1
  printf 'start=%s\ncommand=%s\n' "$start" "$command"
}

gate_process_identity_matches() {
  local identity="$1" expected="$2" argument="${3:-}" start command exact
  [ "$(printf '%s\n' "$identity" | wc -l | tr -d ' ')" -eq 2 ] || return 1
  start="$(printf '%s\n' "$identity" | sed -n '1p')"
  command="$(printf '%s\n' "$identity" | sed -n '2p')"
  case "$start" in start=?*) ;; *) return 1 ;; esac
  exact="command=$expected"
  [ -z "$argument" ] || exact="$exact $argument"
  [ "$command" = "$exact" ]
}

gate_process_probe() {
  local pid="$1" expected="$2" argument="${3:-}" identity image lsof_device lsof_inode
  local stat_device stat_inode
  gate_safe_pid "$pid" || return 4
  if [ -n "${GATE_PROCESS_PROBE:-}" ]; then
    identity="$("$GATE_PROCESS_PROBE" "$pid" "$expected" "$argument")" || return $?
    gate_process_identity_matches "$identity" "$expected" "$argument" || return 4
    printf '%s\n' "$identity"
    return 0
  fi
  [ -n "${GATE_PROCESS_IDENTITY_HELPER:-}" ] || return 4
  [ -f "$GATE_PROCESS_IDENTITY_HELPER" ] && [ ! -L "$GATE_PROCESS_IDENTITY_HELPER" ] &&
    [ -x "$GATE_PROCESS_IDENTITY_HELPER" ] || return 4
  if identity="$("$GATE_PROCESS_IDENTITY_HELPER" "$pid" "$expected" "$argument")"; then :
  else return $?
  fi
  gate_process_identity_matches "$identity" "$expected" "$argument" || return 4
  image="$(/usr/sbin/lsof -a -p "$pid" -d txt -F fDin 2>/dev/null | /usr/bin/awk -v expected="$expected" '
    function emit() {
      if (file == "txt" && name == expected && device != "" && inode != "") {
        print device " " inode
        matches += 1
      }
    }
    /^f/ { emit(); file=substr($0,2); device=""; inode=""; name=""; next }
    /^D/ { device=substr($0,2); next }
    /^i/ { inode=substr($0,2); next }
    /^n/ { name=substr($0,2); next }
    END { emit(); if (matches != 1) exit 4 }
  ')" || return 4
  read -r lsof_device lsof_inode <<<"$image"
  stat_device="$(/usr/bin/stat -f '%d' "$expected" 2>/dev/null)" || return 4
  stat_inode="$(/usr/bin/stat -f '%i' "$expected" 2>/dev/null)" || return 4
  [ "$((lsof_device))" = "$stat_device" ] 2>/dev/null || return 4
  [ "$lsof_inode" = "$stat_inode" ] || return 4
  printf '%s\ndevice=%s\ninode=%s\npath=%s\nargument=%s\n' \
    "$identity" "$stat_device" "$stat_inode" "$expected" "$argument"
}

gate_process_signal() {
  local signal="$1" pid="$2"
  gate_safe_pid "$pid" || return 1
  if [ -n "${GATE_PROCESS_SIGNAL:-}" ]; then
    "$GATE_PROCESS_SIGNAL" "$signal" "$pid"
  else
    /bin/kill "-$signal" "$pid"
  fi
}

gate_process_sleep() {
  if [ -n "${GATE_PROCESS_SLEEP:-}" ]; then "$GATE_PROCESS_SLEEP"
  else /bin/sleep 0.05
  fi
}

gate_process_record_root() {
  [ -n "${GATE_PROCESS_ROOT:-}" ] || return 1
  gate_private_directory "$GATE_PROCESS_ROOT" || return 1
  (CDPATH= cd -- "$GATE_PROCESS_ROOT" && pwd -P)
}

gate_process_allowed_root() {
  local records
  records="$(gate_process_record_root)" || return 1
  (CDPATH= cd -- "$records/.." && pwd -P)
}

gate_process_capture() {
  local label="$1" pid="$2" expected="$3" argument="${4:-}" transition="${5:-}" transition_argument="${6:-}"
  local records allowed record identity admitted admitted_argument probe_status
  case "$label" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  gate_safe_pid "$pid" || return 1
  records="$(gate_process_record_root)" || return 1
  allowed="$(gate_process_allowed_root)" || return 1
  case "$expected" in "$allowed"/*) ;; *) return 1 ;; esac
  case "$expected:$argument:$transition:$transition_argument" in *$'\n'*) return 1 ;; esac
  [ -f "$expected" ] && [ ! -L "$expected" ] && [ -x "$expected" ] || return 1
  if [ -n "$transition" ]; then
    case "$transition" in "$allowed"/*) ;; *) return 1 ;; esac
    [ -f "$transition" ] && [ ! -L "$transition" ] && [ -x "$transition" ] || return 1
  fi
  if identity="$(gate_process_probe "$pid" "$expected" "$argument")"; then
    admitted="$expected"
    admitted_argument="$argument"
  else
    probe_status=$?
    [ -n "$transition" ] && [ "$probe_status" -eq 4 ] || return "$probe_status"
    identity="$(gate_process_probe "$pid" "$transition" "$transition_argument")" || return $?
    admitted="$transition"
    admitted_argument="$transition_argument"
  fi
  [ -n "$identity" ] && [ "$(printf '%s' "$identity" | wc -c | tr -d ' ')" -le 4096 ] || return 1
  record="$records/$label"
  [ ! -e "$record" ] && [ ! -L "$record" ] || return 1
  (umask 077; mkdir "$record") || return 1
  printf '%s\n' "$pid" > "$record/pid"
  printf '%s\n' "$admitted" > "$record/expected"
  printf '%s\n' "$admitted_argument" > "$record/argument"
  printf '%s\n' "$identity" > "$record/identity"
  chmod 600 "$record/pid" "$record/expected" "$record/argument" "$record/identity"
  if [ -n "$transition" ] && [ "$admitted" = "$expected" ]; then
    printf '%s\n' "$transition" > "$record/transition"
    printf '%s\n' "$transition_argument" > "$record/transition-argument"
    chmod 600 "$record/transition" "$record/transition-argument"
  fi
  printf '%s\n' "$record"
}

gate_process_capture_after_exec() {
  local attempt=0 record status
  while [ "$attempt" -lt 40 ]; do
    if record="$(gate_process_capture "$@")"; then
      printf '%s\n' "$record"
      return 0
    else
      status=$?
    fi
    [ "$status" -eq 4 ] || return "$status"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 40 ] || break
    gate_process_sleep
  done
  return 4
}

# Returns 0 for the exact captured process, 3 if it has exited, and 4 for any
# malformed record, executable mismatch, start-identity mismatch, or PID reuse.
gate_process_validate_record() {
  local record="$1" records allowed pid expected argument current status current_file count transition transition_argument
  records="$(gate_process_record_root)" || return 4
  case "$record" in "$records"/*) ;; *) return 4 ;; esac
  gate_private_directory "$record" || return 4
  count="$(find "$record" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')"
  [ "$count" -eq 4 ] || [ "$count" -eq 6 ] || return 4
  for file in pid expected argument identity; do gate_private_regular "$record/$file" || return 4; done
  if [ -e "$record/transition" ] || [ -L "$record/transition" ]; then
    gate_private_regular "$record/transition" || return 4
    gate_private_regular "$record/transition-argument" || return 4
    [ "$(wc -l < "$record/transition" | tr -d ' ')" -eq 1 ] || return 4
  fi
  [ "$(wc -l < "$record/pid" | tr -d ' ')" -eq 1 ] || return 4
  [ "$(wc -l < "$record/expected" | tr -d ' ')" -eq 1 ] || return 4
  pid="$(cat "$record/pid")"
  expected="$(cat "$record/expected")"
  argument="$(cat "$record/argument")"
  gate_safe_pid "$pid" || return 4
  allowed="$(gate_process_allowed_root)" || return 4
  case "$expected" in "$allowed"/*) ;; *) return 4 ;; esac
  [ -f "$expected" ] && [ ! -L "$expected" ] && [ -x "$expected" ] || return 4
  current_file="$records/.current-$pid-$$"
  (umask 077; : > "$current_file") || return 4
  if gate_process_probe "$pid" "$expected" "$argument" > "$current_file"; then status=0
  else status=$?
  fi
  if [ "$status" -eq 3 ]; then rm -f "$current_file"; return 3; fi
  if [ "$status" -eq 4 ] && [ -f "$record/transition" ]; then
    transition="$(cat "$record/transition")"
    transition_argument="$(cat "$record/transition-argument")"
    if gate_process_probe "$pid" "$transition" "$transition_argument" > "$current_file"; then status=0
    else status=$?
    fi
  fi
  [ "$status" -eq 0 ] || { rm -f "$current_file"; return 4; }
  [ "$(wc -c < "$current_file" | tr -d ' ')" -le 4096 ] || { rm -f "$current_file"; return 4; }
  if cmp -s "$record/identity" "$current_file"; then
    :
  else
    [ -f "$record/transition" ] || { rm -f "$current_file"; return 4; }
    [ "$(sed -n '1p' "$record/identity")" = "$(sed -n '1p' "$current_file")" ] || {
      rm -f "$current_file"; return 4
    }
    transition="$(cat "$record/transition")"
    transition_argument="$(cat "$record/transition-argument")"
    case "$transition" in "$allowed"/*) ;; *) rm -f "$current_file"; return 4 ;; esac
    [ -f "$transition" ] && [ ! -L "$transition" ] && [ -x "$transition" ] || {
      rm -f "$current_file"; return 4
    }
    printf '%s\n' "$transition" > "$record/expected"
    printf '%s\n' "$transition_argument" > "$record/argument"
    cp "$current_file" "$record/identity"
    chmod 600 "$record/expected" "$record/identity"
    rm -f "$record/transition"
    rm -f "$record/transition-argument"
  fi
  rm -f "$current_file"
  return 0
}

gate_process_remove_record() {
  local record="$1"
  gate_private_directory "$record" || return 1
  rm -f "$record/pid" "$record/expected" "$record/argument" "$record/identity" \
    "$record/transition" "$record/transition-argument"
  rmdir "$record"
}

gate_process_poll_exit() {
  local record="$1" polls="$2" attempt=0 status
  while [ "$attempt" -lt "$polls" ]; do
    if gate_process_validate_record "$record"; then status=0
    else status=$?
    fi
    if [ "$status" -eq 3 ]; then gate_process_remove_record "$record"; return 0; fi
    [ "$status" -eq 0 ] || return 1
    gate_process_sleep
    attempt=$((attempt + 1))
  done
  return 2
}

gate_process_stop_record() {
  local record="$1" status pid term_polls kill_polls
  term_polls="${GATE_PROCESS_TERM_POLLS:-40}"
  kill_polls="${GATE_PROCESS_KILL_POLLS:-40}"
  case "$term_polls:$kill_polls" in *[!0-9:]*|0:*|*:0) return 1 ;; esac
  if gate_process_validate_record "$record"; then status=0
  else status=$?
  fi
  if [ "$status" -eq 3 ]; then gate_process_remove_record "$record"; return 0; fi
  [ "$status" -eq 0 ] || return 1
  pid="$(cat "$record/pid")"
  gate_process_signal TERM "$pid" || return 1
  if gate_process_poll_exit "$record" "$term_polls"; then return 0
  else status=$?
  fi
  [ "$status" -eq 2 ] || return 1
  gate_process_validate_record "$record" || return 1
  gate_process_signal KILL "$pid" || return 1
  gate_process_poll_exit "$record" "$kill_polls"
}

gate_process_stop_all() {
  local records record status=0
  records="$(gate_process_record_root)" || return 1
  for record in "$records"/*; do
    [ -e "$record" ] || [ -L "$record" ] || continue
    gate_process_stop_record "$record" || status=1
  done
  return "$status"
}

gate_run_without_release_credentials() {
  /usr/bin/env \
    -u RUNTIME_RAIDERS_CODESIGN_IDENTITY \
    -u RUNTIME_RAIDERS_NOTARY_PROFILE \
    -u RUNTIME_RAIDERS_TEAM_ID \
    -u APPLE_ID \
    -u APPLE_APP_SPECIFIC_PASSWORD \
    -u APPLE_TEAM_ID \
    -u AC_PASSWORD \
    "$@"
}

gate_verify_legacy_runtime() {
  [ "$#" -eq 3 ] || return 1
  local home="$1" helper="$2" legacy="$3" support socket lock mode
  local helper_identity legacy_identity
  support="$home/Library/Application Support/Runtime Raiders"
  socket="$support/agent.sock"
  lock="$support/.agent.sock.runtime-raiders.lock"
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] || return 1
  [ -f "$legacy" ] && [ ! -L "$legacy" ] && [ -x "$legacy" ] || return 1
  helper_identity="$(/usr/bin/stat -f '%d:%i' "$helper")" || return 1
  legacy_identity="$(/usr/bin/stat -f '%d:%i' "$legacy")" || return 1
  [ "$helper_identity" != "$legacy_identity" ] || return 1
  [ -S "$socket" ] && [ ! -L "$socket" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$socket")" = "$(id -u)" ] || return 1
  [ -f "$lock" ] && [ ! -L "$lock" ] || return 1
  [ "$(/usr/bin/stat -f '%u:%l' "$lock")" = "$(id -u):1" ] || return 1
  mode="$(/usr/bin/stat -f '%Lp' "$lock")"
  (( (8#$mode & 8#077) == 0 )) || return 1
  gate_run_without_release_credentials env HOME="$home" CFFIXED_USER_HOME="$home" \
    "$helper" __runtime-raiders-installer-status legacy-running >/dev/null
}

gate_start_without_release_credentials() {
  GATE_STARTED_PID=''
  /usr/bin/env \
    -u RUNTIME_RAIDERS_CODESIGN_IDENTITY \
    -u RUNTIME_RAIDERS_NOTARY_PROFILE \
    -u RUNTIME_RAIDERS_TEAM_ID \
    -u APPLE_ID \
    -u APPLE_APP_SPECIFIC_PASSWORD \
    -u APPLE_TEAM_ID \
    -u AC_PASSWORD \
    "$@" <&0 >&1 2>&2 9>&- &
  GATE_STARTED_PID=$!
  gate_safe_pid "$GATE_STARTED_PID"
}

gate_verify_reviewed_source() {
  local root="$1" expected_sha="$2" head status path
  shift 2
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  root="$(CDPATH= cd -- "$root" && pwd -P)" || return 1
  case "$expected_sha" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#expected_sha}" -eq 40 ] || return 1
  head="$(/usr/bin/git -C "$root" rev-parse --verify HEAD 2>/dev/null)" || return 1
  [ "$head" = "$expected_sha" ] || return 1
  status="$(/usr/bin/git -C "$root" status --porcelain --untracked-files=all)" || return 1
  [ -z "$status" ] || return 1
  [ "$#" -gt 0 ] || return 1
  for path in "$@"; do
    case "$path" in ''|/*|../*|*/../*|*/..|*//*) return 1 ;; esac
    /usr/bin/git -C "$root" ls-files --error-unmatch -- "$path" >/dev/null 2>&1 || return 1
    [ -f "$root/$path" ] && [ ! -L "$root/$path" ] || return 1
  done
}

gate_verify_installer_binding() {
  local actual="$1" template="$2" renderer="$3" validator="$4" team="$5"
  local version="$6" sequence="$7" sha="$8" protocol="$9" expected="${10}"
  [ -f "$actual" ] && [ ! -L "$actual" ] || return 1
  [ ! -e "$expected" ] && [ ! -L "$expected" ] || return 1
  "$renderer" "$template" "$validator" "$team" "$version" "$sequence" "$sha" "$protocol" "$expected" || return 1
  cmp -s "$actual" "$expected"
}

gate_emit_xattrs() {
  local path="$1" relative="$2" follow_flag='' name value
  [ -L "$path" ] && follow_flag='-s'
  /usr/bin/xattr $follow_flag "$path" 2>/dev/null | LC_ALL=C sort | while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(/usr/bin/xattr $follow_flag -px "$name" "$path" 2>/dev/null | /usr/bin/tr -d ' \n')" || return 1
    printf 'XATTR %s %s %s\n' "$relative" "$name" "$value"
  done
}

gate_emit_surface_path() {
  local home="$1" path="$2" relative item item_relative metadata
  relative="${path#$home/}"
  if [ -L "$path" ]; then
    metadata="$(/usr/bin/stat -f '%d:%i:%p:%u:%g:%l:%f:%z' "$path")" || return 1
    printf 'SYMLINK %s %s %s\n' "$relative" "$metadata" "$(readlink "$path")"
    gate_emit_xattrs "$path" "$relative"
  elif [ -d "$path" ]; then
    find -P "$path" -print | LC_ALL=C sort | while IFS= read -r item; do
      item_relative="${item#$home/}"
      case "$item_relative" in
        'Library/Application Support/Runtime Raiders/agent.sock'|\
        'Library/Application Support/Runtime Raiders/.agent.sock.runtime-raiders.lock')
          printf 'TRANSIENT %s\n' "$item_relative"
          continue
          ;;
      esac
      metadata="$(/usr/bin/stat -f '%d:%i:%p:%u:%g:%l:%f:%z' "$item")" || exit 1
      if [ -L "$item" ]; then
        printf 'SYMLINK %s %s %s\n' "$item_relative" "$metadata" "$(readlink "$item")"
      elif [ -d "$item" ]; then printf 'DIRECTORY %s %s\n' "$item_relative" "$metadata"
      elif [ -f "$item" ]; then
        printf 'FILE %s %s ' "$item_relative" "$metadata"
        /usr/bin/shasum -a 256 "$item" | awk '{print $1}'
      else
        printf 'UNSAFE-SPECIAL %s %s\n' "$item_relative" "$metadata" >&2
        exit 1
      fi
      gate_emit_xattrs "$item" "$item_relative" || exit 1
    done
  elif [ -f "$path" ]; then
    metadata="$(/usr/bin/stat -f '%d:%i:%p:%u:%g:%l:%f:%z' "$path")" || return 1
    printf 'FILE %s %s ' "$relative" "$metadata"
    /usr/bin/shasum -a 256 "$path" | awk '{print $1}'
    gate_emit_xattrs "$path" "$relative"
  elif [ ! -e "$path" ] && [ ! -L "$path" ]; then
    printf 'ABSENT %s\n' "$relative"
  else
    return 1
  fi
}

gate_fingerprint_migration_surface() {
  local home="$1" destination="$2" support="$1/Library/Application Support/Runtime Raiders"
  local temporary="$destination.tmp.$$"
  [ -d "$home" ] && [ ! -L "$home" ] || return 1
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || return 1
  {
    gate_emit_surface_path "$home" "$support" &&
    printf 'RETIRED-MIGRATION-INPUT ' &&
    gate_emit_surface_path "$home" "$home/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist" &&
    gate_emit_surface_path "$home" "$home/.local" &&
    gate_emit_surface_path "$home" "$home/.zprofile" &&
    gate_emit_surface_path "$home" "$support/launcher" &&
    gate_emit_surface_path "$home" "$support/releases" &&
    gate_emit_surface_path "$home" "$support/installation"
  } > "$temporary" || { rm -f "$temporary"; return 1; }
  chmod 600 "$temporary"
  mv "$temporary" "$destination"
}
