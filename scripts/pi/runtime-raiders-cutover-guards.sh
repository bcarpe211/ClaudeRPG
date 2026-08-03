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
