#!/bin/bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0" >&2
  exit 64
}

[ "$#" -eq 0 ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OWNER="$(/usr/bin/id -u)"
INVALID_TEST_TOOLS='Runtime Raiders live gate test tool configuration is invalid'

fail_test_tools() {
  echo "$INVALID_TEST_TOOLS" >&2
  exit 64
}

validate_test_tool() {
  local tool="$1" mode
  case "$tool" in /*) ;; *) fail_test_tools ;; esac
  [ -f "$tool" ] && [ ! -L "$tool" ] && [ -x "$tool" ] || fail_test_tools
  [ "$(/usr/bin/stat -f '%u' "$tool")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$tool")" = 1 ] || fail_test_tools
  mode="$(/usr/bin/stat -f '%Lp' "$tool")"
  (( (8#$mode & 8#022) == 0 )) || fail_test_tools
}

if [ -n "${RUNTIME_RAIDERS_LIVE_GATE_TEST_MODE:-}" ]; then
  [ "$RUNTIME_RAIDERS_LIVE_GATE_TEST_MODE" = 1 ] &&
    [ "${RUNTIME_RAIDERS_LIVE_GATE_TEST_ROOT:-}" = "$ROOT" ] || fail_test_tools
  RAIDERS_TOOL="${RUNTIME_RAIDERS_LIVE_GATE_TEST_RAIDERS:-}"
  SSH_TOOL="${RUNTIME_RAIDERS_LIVE_GATE_TEST_SSH:-}"
  CODESIGN_TOOL="${RUNTIME_RAIDERS_LIVE_GATE_TEST_CODESIGN:-}"
  SPCTL_TOOL="${RUNTIME_RAIDERS_LIVE_GATE_TEST_SPCTL:-}"
  SLEEP_TOOL="${RUNTIME_RAIDERS_LIVE_GATE_TEST_SLEEP:-}"
  REPORT_ROOT="${RUNTIME_RAIDERS_LIVE_GATE_TEST_REPORT_ROOT:-}"
  READY_ATTEMPTS="${RUNTIME_RAIDERS_LIVE_GATE_TEST_READY_ATTEMPTS:-}"
  UPLOAD_ATTEMPTS="${RUNTIME_RAIDERS_LIVE_GATE_TEST_UPLOAD_ATTEMPTS:-}"
  for test_tool in "$RAIDERS_TOOL" "$SSH_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$SLEEP_TOOL"; do
    validate_test_tool "$test_tool"
  done
  case "$REPORT_ROOT" in /*) ;; *) fail_test_tools ;; esac
  [ -d "$REPORT_ROOT" ] && [ ! -L "$REPORT_ROOT" ] &&
    [ "$(/usr/bin/stat -f '%u' "$REPORT_ROOT")" = "$OWNER" ] || fail_test_tools
  [[ "$READY_ATTEMPTS" =~ ^[1-9][0-9]?$ ]] &&
    [[ "$UPLOAD_ATTEMPTS" =~ ^[1-9][0-9]?$ ]] || fail_test_tools
  SOURCE_SHA=test-mode
else
  for injected_name in \
    RUNTIME_RAIDERS_LIVE_GATE_TEST_ROOT RUNTIME_RAIDERS_LIVE_GATE_TEST_RAIDERS \
    RUNTIME_RAIDERS_LIVE_GATE_TEST_SSH RUNTIME_RAIDERS_LIVE_GATE_TEST_CODESIGN \
    RUNTIME_RAIDERS_LIVE_GATE_TEST_SPCTL RUNTIME_RAIDERS_LIVE_GATE_TEST_SLEEP \
    RUNTIME_RAIDERS_LIVE_GATE_TEST_REPORT_ROOT RUNTIME_RAIDERS_LIVE_GATE_TEST_READY_ATTEMPTS \
    RUNTIME_RAIDERS_LIVE_GATE_TEST_UPLOAD_ATTEMPTS; do
    [ -z "${!injected_name:-}" ] || fail_test_tools
  done
  RAIDERS_TOOL="$HOME/.local/bin/raiders"
  SSH_TOOL=/usr/bin/ssh
  CODESIGN_TOOL=/usr/bin/codesign
  SPCTL_TOOL=/usr/sbin/spctl
  SLEEP_TOOL=/bin/sleep
  REPORT_ROOT=/private/tmp
  READY_ATTEMPTS=180
  UPLOAD_ATTEMPTS=45
  [ -z "$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=no)" ] || {
    echo "Runtime Raiders live gate requires a clean reviewed checkout" >&2
    exit 1
  }
  SOURCE_SHA="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "Runtime Raiders live gate could not identify reviewed source" >&2
    exit 1
  }
fi

for required_tool in "$RAIDERS_TOOL" "$SSH_TOOL" "$CODESIGN_TOOL" "$SPCTL_TOOL" "$SLEEP_TOOL"; do
  [ -x "$required_tool" ] || {
    echo "required live gate tool is unavailable" >&2
    exit 69
  }
done

HOME_PHYSICAL="$(cd "$HOME" && pwd -P)"
[ "$HOME_PHYSICAL" = "$HOME" ] && [ ! -L "$HOME" ] &&
  [ "$(/usr/bin/stat -f '%u' "$HOME")" = "$OWNER" ] || {
  echo "Runtime Raiders live gate refuses an unsafe HOME" >&2
  exit 1
}

SESSION_ROOT="$HOME/.codex/sessions"
SUPPORT_ROOT="$HOME/Library/Application Support/Runtime Raiders"
AGENT_APP="$SUPPORT_ROOT/Runtime Raiders.app"
[ -d "$SESSION_ROOT" ] && [ ! -L "$SESSION_ROOT" ] &&
  [ "$(/usr/bin/stat -f '%u' "$SESSION_ROOT")" = "$OWNER" ] || {
  echo "Runtime Raiders live gate requires an owner-controlled Codex session directory" >&2
  exit 1
}

STAMP="$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
REPORT="$(/usr/bin/mktemp "$REPORT_ROOT/runtime-raiders-activation-gate-$STAMP.XXXXXX")"
[ -f "$REPORT" ] && [ ! -L "$REPORT" ] &&
  [ "$(/usr/bin/stat -f '%u' "$REPORT")" = "$OWNER" ] &&
  [ "$(/usr/bin/stat -f '%l' "$REPORT")" = 1 ] || {
  echo "Runtime Raiders live gate could not create a private report" >&2
  exit 1
}
/bin/chmod 600 "$REPORT"

SHUTDOWN_REQUIRED=1
FIXTURE_DIRECTORY=''
FIXTURE_CREATED=0
RESULT=FAIL
FAILURE='gate did not complete'
READINESS_STARTED=0
READINESS_ATTEMPTS=0
READINESS_PREPARING_OBSERVATIONS=0
READINESS_LAST_STATE=unobserved
SHUTDOWN_ATTEMPTS=0
SHUTDOWN_FAILURE=''

report_line() {
  printf '%s\n' "$1" >> "$REPORT"
}

report_line 'runtime_raiders_live_activation_gate=1'
report_line "started_at=$STAMP"
report_line "source_git_sha=$SOURCE_SHA"
report_line 'privacy=metadata_and_aggregate_counts_only'

gate_fail() {
  FAILURE="$1"
  echo "FAIL: $1" >&2
  exit 1
}

status_wire_is_disabled() {
  local status="$1"
  /usr/bin/grep -F '"activationState":"disabled"' <<<"$status" >/dev/null &&
    /usr/bin/grep -F '"enabled":false' <<<"$status" >/dev/null &&
    /usr/bin/grep -F '"queuedEventCount":0' <<<"$status" >/dev/null &&
    /usr/bin/grep -F '"activeRunCount":0' <<<"$status" >/dev/null
}

status_is_disabled() {
  local status
  status="$("$RAIDERS_TOOL" status 2>/dev/null)" || return 1
  status_wire_is_disabled "$status"
}

cleanup() {
  local status=$? shutdown_ok=0 attempt
  trap - EXIT HUP INT TERM
  if [ -n "$FIXTURE_DIRECTORY" ] && [ "$FIXTURE_CREATED" -eq 1 ]; then
    if [[ "$FIXTURE_DIRECTORY" == "$SESSION_ROOT"/.runtime-raiders-gate-* ]] &&
      [ -d "$FIXTURE_DIRECTORY" ] && [ ! -L "$FIXTURE_DIRECTORY" ] &&
      [ "$(/usr/bin/stat -f '%u' "$FIXTURE_DIRECTORY")" = "$OWNER" ]; then
      /bin/rm -f -- \
        "$FIXTURE_DIRECTORY/.synthetic.pending" \
        "$FIXTURE_DIRECTORY/synthetic.jsonl" || status=1
      /bin/rmdir "$FIXTURE_DIRECTORY" || status=1
    elif [ -e "$FIXTURE_DIRECTORY" ] || [ -L "$FIXTURE_DIRECTORY" ]; then
      status=1
    fi
  fi
  if [ "$SHUTDOWN_REQUIRED" -eq 1 ]; then
    for ((attempt = 0; attempt < 10; attempt++)); do
      SHUTDOWN_ATTEMPTS=$((SHUTDOWN_ATTEMPTS + 1))
      if "$RAIDERS_TOOL" off >/dev/null 2>&1 && status_is_disabled; then
        shutdown_ok=1
        break
      fi
      if [ "$attempt" -lt 9 ]; then "$SLEEP_TOOL" 1; fi
    done
    if [ "$shutdown_ok" -ne 1 ]; then
      SHUTDOWN_FAILURE='emergency shutdown could not prove collection is off'
      status=1
    fi
  fi
  if [ "$READINESS_STARTED" -eq 1 ]; then
    report_line "readiness_attempts=$READINESS_ATTEMPTS"
    report_line "readiness_preparing_observations=$READINESS_PREPARING_OBSERVATIONS"
    report_line "readiness_last_state=$READINESS_LAST_STATE"
  fi
  report_line "shutdown_attempts=$SHUTDOWN_ATTEMPTS"
  report_line "shutdown=$([ "$shutdown_ok" -eq 1 ] && printf PASS || printf FAIL)"
  report_line "result=$([ "$status" -eq 0 ] && [ "$RESULT" = PASS ] && printf PASS || printf FAIL)"
  if [ -n "$FAILURE" ]; then report_line "failure=$FAILURE"; fi
  if [ -n "$SHUTDOWN_FAILURE" ]; then report_line "shutdown_failure=$SHUTDOWN_FAILURE"; fi
  /bin/chmod 600 "$REPORT" 2>/dev/null || status=1
  printf 'Report: %s\n' "$REPORT"
  exit "$status"
}
trap cleanup EXIT
trap 'FAILURE="interrupted by hangup"; echo "FAIL: $FAILURE" >&2; exit 129' HUP
trap 'FAILURE="interrupted by user"; echo "FAIL: $FAILURE" >&2; exit 130' INT
trap 'FAILURE="interrupted by termination"; echo "FAIL: $FAILURE" >&2; exit 143' TERM

provider_fingerprint() {
  local count fingerprint
  count="$(/usr/bin/find "$SESSION_ROOT" -type f -name '*.jsonl' -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  [[ "$count" =~ ^[0-9]+$ ]] || return 1
  fingerprint="$(/usr/bin/find "$SESSION_ROOT" -type f -name '*.jsonl' -exec /usr/bin/stat -f '%N|%d|%i|%z|%m|%c' {} \; |
    /usr/bin/sort | /usr/bin/shasum -a 256 | /usr/bin/awk 'NR == 1 { print $1 }')" || return 1
  printf '%s|%s\n' "$count" "$fingerprint"
}

server_snapshot() {
  local base_run="${1:--1}" base_event="${2:--1}" base_token="${3:--1}"
  [[ "$base_run" =~ ^-?[0-9]+$ ]] && [[ "$base_event" =~ ^-?[0-9]+$ ]] &&
    [[ "$base_token" =~ ^-?[0-9]+$ ]] || return 1
  "$SSH_TOOL" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ConnectionAttempts=1 \
    -o StrictHostKeyChecking=yes \
    -o HostKeyAlias=raiders.redlattice.com \
    -o 'ProxyCommand=/usr/bin/nc -b en0 %h %p' \
    rluser@raiders.redlattice.com /bin/bash -s -- "$base_run" "$base_event" "$base_token" <<'REMOTE_SNAPSHOT'
set -euo pipefail
base_run="$1"
base_event="$2"
base_token="$3"
baseline_query='SELECT "ok",(SELECT paused FROM game_state LIMIT 1),COALESCE((SELECT last_activity_at FROM game_state LIMIT 1),0),COALESCE((SELECT combat_active_ms FROM game_state LIMIT 1),0),(SELECT COUNT(*) FROM runs),COALESCE((SELECT SUM(raid_power) FROM runs),0),COALESCE((SELECT MAX(id) FROM runs),0),(SELECT COUNT(*) FROM run_events),COALESCE((SELECT MAX(rowid) FROM run_events),0),(SELECT COUNT(*) FROM token_events),COALESCE((SELECT SUM(effective_delta) FROM token_events),0),COALESCE((SELECT SUM(total_delta) FROM token_events),0),COALESCE((SELECT MAX(id) FROM token_events),0),(SELECT COUNT(*) FROM players),COALESCE((SELECT SUM(total_tokens) FROM players),0),COALESCE((SELECT SUM(effective_tokens) FROM players),0),COALESCE((SELECT SUM(gold) FROM players),0),(SELECT COUNT(*) FROM raider_devices),(SELECT COUNT(*) FROM raider_devices WHERE revoked_at IS NULL)'
repository=/home/rluser/ClaudeRPG
database="$repository/data/claude-rpg.db"
[ -f "$database" ] && [ ! -L "$database" ]
[ -z "$(/usr/bin/git -C "$repository" status --porcelain --untracked-files=no)" ]
/usr/bin/systemctl is-active --quiet claude-rpg.service
/usr/bin/systemctl is-active --quiet caddy.service
[ "$(/usr/bin/sqlite3 "$database" 'PRAGMA integrity_check;')" = ok ]
if [ "$base_run" -lt 0 ]; then
  /usr/bin/sqlite3 -separator '|' "$database" "$baseline_query;"
else
  post_query="$baseline_query,
    (SELECT COUNT(*) FROM runs WHERE id > $base_run),
    COALESCE((SELECT id FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT provider FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),''),
    COALESCE((SELECT surface FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),''),
    COALESCE((SELECT state FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),''),
    COALESCE((SELECT usage_input FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT usage_output FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT usage_cache_read FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT usage_cache_write FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT usage_reasoning_output FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT awarded_usage_credit FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT awarded_completion_credit FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT awarded_duration_credit FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    COALESCE((SELECT raid_power FROM runs WHERE id > $base_run ORDER BY id LIMIT 1),0),
    (SELECT COUNT(*) FROM run_events WHERE rowid > $base_event),
    COALESCE((SELECT SUM(awarded_delta) FROM run_events WHERE rowid > $base_event),0),
    (SELECT COUNT(DISTINCT run_id) FROM run_events WHERE rowid > $base_event),
    COALESCE((SELECT MAX(run_id) FROM run_events WHERE rowid > $base_event),0),
    (SELECT COUNT(*) FROM token_events WHERE id > $base_token),
    COALESCE((SELECT SUM(effective_delta) FROM token_events WHERE id > $base_token),0),
    COALESCE((SELECT SUM(total_delta) FROM token_events WHERE id > $base_token),0)"
  /usr/bin/sqlite3 -separator '|' "$database" "$post_query;"
fi
REMOTE_SNAPSHOT
}

parse_baseline() {
  local wire="$1" field
  IFS='|' read -r -a SNAP_FIELDS <<<"$wire"
  [ "${#SNAP_FIELDS[@]}" -eq 19 ] && [ "${SNAP_FIELDS[0]}" = ok ] &&
    [ "${SNAP_FIELDS[1]}" = 1 ] || return 1
  for field in "${SNAP_FIELDS[@]:1}"; do [[ "$field" =~ ^[0-9]+$ ]] || return 1; done
}

stable_server_history_matches() {
  local wire="$1" field_index
  parse_baseline "$wire" || return 1
  for ((field_index = 0; field_index < 19; field_index++)); do
    [ "$field_index" -eq 2 ] && continue
    [ "${SNAP_FIELDS[$field_index]}" = "${BASE_FIELDS[$field_index]}" ] || return 1
  done
}

reconciles_post_snapshot() {
  local wire="$1" field raid usage completion duration new_events new_tokens
  IFS='|' read -r -a POST_FIELDS <<<"$wire"
  [ "${#POST_FIELDS[@]}" -eq 40 ] && [ "${POST_FIELDS[0]}" = ok ] || return 1
  for field in "${POST_FIELDS[@]:1:20}" "${POST_FIELDS[@]:24}"; do
    [[ "$field" =~ ^[0-9]+$ ]] || return 1
  done
  [ "${POST_FIELDS[21]}" = codex ] &&
    [ "${POST_FIELDS[22]}" = codex_desktop ] &&
    [ "${POST_FIELDS[23]}" = completed ] || return 1
  raid="${POST_FIELDS[32]}"
  usage="${POST_FIELDS[29]}"
  completion="${POST_FIELDS[30]}"
  duration="${POST_FIELDS[31]}"
  new_events="${POST_FIELDS[33]}"
  new_tokens="${POST_FIELDS[37]}"
  # Positive activity can wake the game; fields 1-3 and 16 are report-only here.
  [ "${POST_FIELDS[4]}" -eq "$((BASE_FIELDS[4] + 1))" ] &&
    [ "${POST_FIELDS[5]}" -eq "$((BASE_FIELDS[5] + raid))" ] &&
    [ "${POST_FIELDS[6]}" = "${POST_FIELDS[20]}" ] &&
    [ "${POST_FIELDS[19]}" -eq 1 ] && [ "${POST_FIELDS[20]}" -gt "${BASE_FIELDS[6]}" ] &&
    [ "${POST_FIELDS[24]}" -eq 40 ] && [ "${POST_FIELDS[25]}" -eq 5 ] &&
    [ "${POST_FIELDS[26]}" -eq 0 ] && [ "${POST_FIELDS[27]}" -eq 1 ] &&
    [ "${POST_FIELDS[28]}" -eq 2 ] && [ "$usage" -eq 48 ] &&
    [ "$completion" -eq 854 ] && [ "$duration" -eq 0 ] && [ "$raid" -eq 902 ] &&
    [ "$raid" -eq "$((usage + completion + duration))" ] &&
    [ "$new_events" -eq 3 ] && [ "${POST_FIELDS[7]}" -eq "$((BASE_FIELDS[7] + new_events))" ] &&
    [ "${POST_FIELDS[8]}" -gt "${BASE_FIELDS[8]}" ] &&
    [ "${POST_FIELDS[34]}" -eq "$raid" ] && [ "${POST_FIELDS[35]}" -eq 1 ] &&
    [ "${POST_FIELDS[36]}" = "${POST_FIELDS[20]}" ] &&
    [ "$new_tokens" -eq 2 ] && [ "${POST_FIELDS[9]}" -eq "$((BASE_FIELDS[9] + new_tokens))" ] &&
    [ "${POST_FIELDS[10]}" -eq "$((BASE_FIELDS[10] + raid))" ] &&
    [ "${POST_FIELDS[11]}" = "${BASE_FIELDS[11]}" ] && [ "${POST_FIELDS[12]}" -gt "${BASE_FIELDS[12]}" ] &&
    [ "${POST_FIELDS[38]}" -eq "$raid" ] && [ "${POST_FIELDS[39]}" -eq 0 ] &&
    [ "${POST_FIELDS[13]}" = "${BASE_FIELDS[13]}" ] &&
    [ "${POST_FIELDS[14]}" = "${BASE_FIELDS[14]}" ] &&
    [ "${POST_FIELDS[15]}" -eq "$((BASE_FIELDS[15] + raid))" ] &&
    [ "${POST_FIELDS[17]}" = "${BASE_FIELDS[17]}" ] &&
    [ "${POST_FIELDS[18]}" = "${BASE_FIELDS[18]}" ]
}

INITIAL_STATUS="$("$RAIDERS_TOOL" status 2>/dev/null)" || gate_fail 'raiders status failed'
status_wire_is_disabled "$INITIAL_STATUS" || gate_fail 'collection was not disabled at the start'
INSTALLED_VERSION="$(/usr/bin/sed -n 's/.*"installedCompanionVersion":"\([^"]*\)".*/\1/p' <<<"$INITIAL_STATUS")"
[[ "$INSTALLED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || gate_fail 'installed companion version was invalid'
report_line "installed_companion_version=$INSTALLED_VERSION"

echo 'Runtime Raiders live gate: checking that Codex history is quiet...'
QUIET_BEFORE="$(provider_fingerprint)" || gate_fail 'could not fingerprint provider history'
QUIET_COUNT="${QUIET_BEFORE%%|*}"
[ "$QUIET_COUNT" -ge 816 ] || gate_fail 'fewer than 816 provider records are available'
"$SLEEP_TOOL" 60
QUIET_AFTER="$(provider_fingerprint)" || gate_fail 'could not fingerprint provider history'
[ "$QUIET_AFTER" = "$QUIET_BEFORE" ] || gate_fail 'provider history changed during the quiet window'
report_line "provider_records=$QUIET_COUNT"
report_line 'provider_quiet_window=PASS'

DOCTOR="$("$RAIDERS_TOOL" doctor 2>/dev/null)" || gate_fail 'raiders doctor failed'
for required_health in \
  '"codexRootReadable":true' '"serverHealthy":true' '"signingValid":true' \
  '"enrollmentMatchesCompiledAdapters":true' '"compatibilityNeedsReview":false'; do
  /usr/bin/grep -F "$required_health" <<<"$DOCTOR" >/dev/null || gate_fail 'raiders doctor was not fully healthy'
done
"$CODESIGN_TOOL" --verify --deep --strict --verbose=2 "$AGENT_APP" >/dev/null 2>&1 ||
  gate_fail 'Apple signature verification failed'
"$SPCTL_TOOL" --assess --type execute --verbose=2 "$AGENT_APP" >/dev/null 2>&1 ||
  gate_fail 'Apple Gatekeeper assessment failed'

BASELINE_WIRE="$(server_snapshot)" || gate_fail 'server preflight failed'
parse_baseline "$BASELINE_WIRE" || gate_fail 'server preflight returned an invalid or unpaused baseline'
BASE_FIELDS=("${SNAP_FIELDS[@]}")
report_line "baseline_runs=${BASE_FIELDS[4]}"
report_line "baseline_run_events=${BASE_FIELDS[7]}"
report_line "baseline_raid_power=${BASE_FIELDS[5]}"
report_line "baseline_game_paused=${BASE_FIELDS[1]}"
report_line "baseline_game_last_activity_at=${BASE_FIELDS[2]}"
report_line "baseline_combat_active_ms=${BASE_FIELDS[3]}"
report_line "baseline_token_events=${BASE_FIELDS[9]}"
report_line "baseline_token_effective=${BASE_FIELDS[10]}"
report_line "baseline_token_total=${BASE_FIELDS[11]}"
report_line "baseline_player_total=${BASE_FIELDS[14]}"
report_line "baseline_player_effective=${BASE_FIELDS[15]}"
report_line "baseline_player_gold=${BASE_FIELDS[16]}"

echo 'Runtime Raiders live gate: enabling collection for the bounded proof...'
ON_RESPONSE="$("$RAIDERS_TOOL" on)" || gate_fail 'raiders on failed'
[ "$ON_RESPONSE" = preparing ] || gate_fail 'raiders on did not return preparing'
READY=0
READINESS_STARTED=1
for ((attempt = 0; attempt < READY_ATTEMPTS; attempt++)); do
  STATUS="$("$RAIDERS_TOOL" status 2>/dev/null)" || true
  READINESS_ATTEMPTS=$((READINESS_ATTEMPTS + 1))
  READINESS_LAST_STATE="$(/usr/bin/sed -n 's/.*"activationState":"\([^"]*\)".*/\1/p' <<<"$STATUS")"
  case "$READINESS_LAST_STATE" in
    preparing) READINESS_PREPARING_OBSERVATIONS=$((READINESS_PREPARING_OBSERVATIONS + 1)) ;;
    ready) ;;
    disabled) gate_fail 'agent disabled itself while preparing' ;;
    *) READINESS_LAST_STATE=unavailable ;;
  esac
  if /usr/bin/grep -F '"activationState":"ready"' <<<"$STATUS" >/dev/null &&
    /usr/bin/grep -F '"enabled":true' <<<"$STATUS" >/dev/null &&
    /usr/bin/grep -F '"queuedEventCount":0' <<<"$STATUS" >/dev/null &&
    /usr/bin/grep -F '"activeRunCount":0' <<<"$STATUS" >/dev/null; then
    READY=1
    break
  fi
  "$SLEEP_TOOL" 1
done
[ "$READY" -eq 1 ] || gate_fail 'agent did not become ready'

READY_WIRE="$(server_snapshot)" || gate_fail 'server history recheck failed'
stable_server_history_matches "$READY_WIRE" || gate_fail 'server history changed before the synthetic Run'
report_line 'history_only_activation=PASS'

RUN_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
TURN_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
EVENT_TIME="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
FIXTURE_DIRECTORY="$SESSION_ROOT/.runtime-raiders-gate-$RUN_ID"
/bin/mkdir -m 700 "$FIXTURE_DIRECTORY" || gate_fail 'could not create the synthetic fixture directory'
FIXTURE_CREATED=1
FIXTURE_PENDING="$FIXTURE_DIRECTORY/.synthetic.pending"
FIXTURE_FILE="$FIXTURE_DIRECTORY/synthetic.jsonl"
/usr/bin/printf '%s\n' \
  "{\"timestamp\":\"$EVENT_TIME\",\"type\":\"session_meta\",\"payload\":{\"id\":\"$RUN_ID\",\"originator\":\"runtime-raiders-live-gate\",\"source\":\"vscode\",\"cli_version\":\"1.0.0\"}}" \
  "{\"timestamp\":\"$EVENT_TIME\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}" \
  "{\"timestamp\":\"$EVENT_TIME\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"$TURN_ID\",\"model\":\"runtime-raiders-gate\",\"effort\":\"low\"}}" \
  "{\"timestamp\":\"$EVENT_TIME\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":40,\"cached_input_tokens\":0,\"cache_write_input_tokens\":1,\"output_tokens\":5,\"reasoning_output_tokens\":2}}}}" \
  "{\"timestamp\":\"$EVENT_TIME\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}" > "$FIXTURE_PENDING"
/bin/chmod 600 "$FIXTURE_PENDING"
/bin/mv "$FIXTURE_PENDING" "$FIXTURE_FILE"

RECONCILED=0
for ((attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++)); do
  STATUS="$("$RAIDERS_TOOL" status 2>/dev/null)" || true
  if /usr/bin/grep -F '"activationState":"ready"' <<<"$STATUS" >/dev/null &&
    /usr/bin/grep -F '"queuedEventCount":0' <<<"$STATUS" >/dev/null &&
    /usr/bin/grep -E '"lastSuccessfulUploadMS":[0-9]+' <<<"$STATUS" >/dev/null; then
    POST_WIRE="$(server_snapshot "${BASE_FIELDS[6]}" "${BASE_FIELDS[8]}" "${BASE_FIELDS[12]}")" || true
    if reconciles_post_snapshot "$POST_WIRE"; then RECONCILED=1; break; fi
  fi
  "$SLEEP_TOOL" 1
done
[ "$RECONCILED" -eq 1 ] || gate_fail 'synthetic Run scoring did not reconcile'

report_line "new_run_id=${POST_FIELDS[20]}"
report_line "new_raid_power=${POST_FIELDS[32]}"
report_line "post_game_paused=${POST_FIELDS[1]}"
report_line "post_game_last_activity_at=${POST_FIELDS[2]}"
report_line "post_combat_active_ms=${POST_FIELDS[3]}"
report_line "post_player_gold=${POST_FIELDS[16]}"
report_line 'exactly_one_scored_run=PASS'
RESULT=PASS
FAILURE=''
echo 'PASS: exactly one synthetic Runtime Raiders Run was scored; collection is being turned off.'
