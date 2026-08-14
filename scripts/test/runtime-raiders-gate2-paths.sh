#!/bin/bash

gate2_root_matches() {
  case "$1" in
    /Users/Shared/r2.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

gate2_home_suffixes() {
  printf '%s\n' l f A B C D E F G H I J K L M N O P
}

gate2_migration_home() {
  local root="$1" index="$2" suffix
  case "$index" in
    1) suffix=A ;; 2) suffix=B ;; 3) suffix=C ;; 4) suffix=D ;; 5) suffix=E ;;
    6) suffix=F ;; 7) suffix=G ;; 8) suffix=H ;; 9) suffix=I ;; 10) suffix=J ;;
    11) suffix=K ;; 12) suffix=L ;; 13) suffix=M ;; 14) suffix=N ;; 15) suffix=O ;;
    16) suffix=P ;; *) return 1 ;;
  esac
  printf '%s/%s\n' "$root" "$suffix"
}

gate2_emit_unix_paths() {
  local root="$1" suffix home support
  case "$root" in /*) ;; *) return 1 ;; esac
  case "$root" in *$'\n'*) return 1 ;; esac
  while IFS= read -r suffix; do
    home="$root/$suffix"
    support="$home/Library/Application Support/Runtime Raiders"
    printf '%s\n' "$support/agent.sock" "$support/.agent.sock.runtime-raiders.lock"
  done < <(gate2_home_suffixes)
}

gate2_verify_unix_path() {
  local path="$1" bytes
  case "$path" in /*) ;; *) return 1 ;; esac
  case "$path" in *$'\n'*) return 1 ;; esac
  bytes="$(LC_ALL=C printf '%s' "$path" | wc -c | tr -d ' ')" || return 1
  [ "$bytes" -le 103 ]
}

gate2_verify_all_unix_paths() {
  local root="$1" path count=0
  while IFS= read -r path; do
    gate2_verify_unix_path "$path" || return 1
    count=$((count + 1))
  done < <(gate2_emit_unix_paths "$root")
  [ "$count" -eq 36 ]
}

gate2_create_owned_root() {
  local root owner mode
  owner="$(id -u)" || return 1
  root="$(/usr/bin/mktemp -d /Users/Shared/r2.XXXXXX)" || return 1
  root="$(cd "$root" && pwd -P)" || { /bin/rm -rf -- "$root"; return 1; }
  if ! gate2_root_matches "$root" || [ ! -d "$root" ] || [ -L "$root" ] ||
     [ "$(/usr/bin/stat -f '%u' "$root")" != "$owner" ]; then
    /bin/rm -rf -- "$root"
    return 1
  fi
  chmod 700 "$root" || { /bin/rm -rf -- "$root"; return 1; }
  mode="$(/usr/bin/stat -f '%Lp' "$root")" || { /bin/rm -rf -- "$root"; return 1; }
  [ "$mode" = 700 ] && gate2_verify_all_unix_paths "$root" || {
    /bin/rm -rf -- "$root"
    return 1
  }
  printf '%s\n' "$root"
}

gate2_remove_owned_root() {
  local root="$1"
  gate2_root_matches "$root" || return 1
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$root")" = "$(id -u)" ] || return 1
  /bin/rm -rf -- "$root"
}
