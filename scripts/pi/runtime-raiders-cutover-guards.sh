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
