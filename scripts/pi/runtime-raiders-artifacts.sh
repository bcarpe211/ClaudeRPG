#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PRODUCTION_ROOT=/var/lib/runtime-raiders
ARTIFACT_ROOT=$PRODUCTION_ROOT
CURL=/usr/bin/curl
NODE=/usr/bin/node
SLEEP=/usr/bin/sleep
if [[ ${RUNTIME_RAIDERS_TEST_MODE:-0} == 1 ]]; then
  ARTIFACT_ROOT=${RUNTIME_RAIDERS_ARTIFACT_ROOT:?test artifact root is required}
  CURL=${RUNTIME_RAIDERS_CURL:?test curl is required}
  NODE=${RUNTIME_RAIDERS_NODE:?test node is required}
  SLEEP=${RUNTIME_RAIDERS_SLEEP:?test sleep is required}
fi
RELEASES=$ARTIFACT_ROOT/releases
CURRENT=$ARTIFACT_ROOT/current
PUBLIC_ORIGIN=https://raiders.redlattice.com
PUBLIC_INSTALLER_URL=$PUBLIC_ORIGIN/install.sh
PUBLIC_ZIP_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.zip
PUBLIC_CHECKSUM_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.zip.sha256
PUBLIC_UPDATE_MANIFEST_URL=$PUBLIC_ORIGIN/downloads/runtime-raiders-agent.update.json
PUBLIC_HEALTH_URL=$PUBLIC_ORIGIN/health
LOCAL_HEALTH_URL=http://127.0.0.1:8080/health
INSTALLER_MAX_BYTES=1048576
ZIP_MAX_BYTES=134217728
CHECKSUM_MAX_BYTES=4096
UPDATE_MANIFEST_MAX_BYTES=65536
PUBLIC_VERIFY_ATTEMPTS=5
PUBLIC_CONNECT_TIMEOUT=3
PUBLIC_TOTAL_TIMEOUT=15
PUBLIC_RETRY_DELAY=1
LOCAL_HEALTH_TOTAL_TIMEOUT=5

die() { printf 'runtime-raiders-artifacts: %s\n' "$1" >&2; exit 1; }
verification_checkpoint() {
  printf 'runtime-raiders-artifacts: verify label=%s attempt=%s/%s result=%s category=%s%s\n' \
    "$1" "$2" "$3" "$4" "$5" "${6:+ detail=$6}" >&2
}
header_has_exact_value() {
  awk -v wanted_name="$2" -v wanted_value="$3" '
    {
      sub(/\r$/, "")
      if ($0 ~ /^HTTP\/1\.[0-9][[:space:]]+[0-9][0-9][0-9]([[:space:]].*)?$/ ||
          $0 ~ /^HTTP\/2[[:space:]]+[0-9][0-9][0-9]([[:space:]].*)?$/) {
        have_status = 1
        in_headers = 1
        block_ended = 0
        occurrences = 0
        exact = 0
        malformed = 0
        next
      }
      if (!in_headers) next
      if ($0 == "") {
        in_headers = 0
        block_ended = 1
        next
      }
      separator = index($0, ":")
      if (separator == 0) {
        candidate = $0
        sub(/[[:space:]].*$/, "", candidate)
        if (tolower(candidate) == tolower(wanted_name)) malformed = 1
        next
      }
      raw_name = substr($0, 1, separator - 1)
      name = raw_name
      value = substr($0, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (tolower(name) == tolower(wanted_name)) {
        occurrences++
        if (raw_name != name) malformed = 1
        if (value == wanted_value) exact++
      }
    }
    END {
      exit(have_status && block_ended && !malformed &&
        occurrences == 1 && exact == 1 ? 0 : 1)
    }
  ' "$1"
}
require_root() { test "$(id -u)" = 0 || die 'root is required'; }
require_release_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]] || die 'invalid release SHA'; }
require_digest() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || die "invalid $2 SHA-256"; }
require_release_sequence() {
  [[ $1 =~ ^[1-9][0-9]*$ ]] || die 'invalid release sequence'
  test "${#1}" -le 16 && test "$1" -le 9007199254740991 || die 'invalid release sequence'
}
require_companion_version() {
  [[ $1 =~ ^[A-Za-z0-9._+-]+$ ]] || die 'invalid companion version'
  test "${#1}" -le 100 || die 'invalid companion version'
}
sha256_file() { sha256sum -- "$1" 2>/dev/null | awk 'NR == 1 && NF >= 1 { print $1; exit }'; }
metadata() { stat -c '%u:%g:%a' -- "$1" 2>/dev/null; }
ownership() { stat -c '%u:%g' -- "$1" 2>/dev/null; }
selector_identity() { stat -c '%d:%i' -- "$1" 2>/dev/null; }

require_directory() {
  test -d "$1" && test ! -L "$1" || die "$2 must be a nonsymlink directory"
  test "$(metadata "$1")" = '0:0:755' || die "$2 must be owned by root:root with mode 0755"
}

require_regular_file() {
  test -f "$1" && test ! -L "$1" || die "$2 must be a regular file"
  test -s "$1" || die "$2 must be nonempty"
}

canonicalize() {
  realpath -- "$1" 2>/dev/null || die "$2 could not be canonicalized"
}

require_beneath_artifact_root() {
  case $1 in
    "$ARTIFACT_ROOT"/*) ;;
    *) die "$2 must resolve beneath artifact root" ;;
  esac
}

validate_store() {
  require_directory "$ARTIFACT_ROOT" 'artifact root'
  ARTIFACT_ROOT=$(canonicalize "$ARTIFACT_ROOT" 'artifact root')
  RELEASES=$ARTIFACT_ROOT/releases
  CURRENT=$ARTIFACT_ROOT/current
  require_directory "$RELEASES" 'releases directory'
}

acquire_publication_lock() {
  LOCK=$ARTIFACT_ROOT/.publication.lock
  if test -e "$LOCK" || test -L "$LOCK"; then
    test -f "$LOCK" && test ! -L "$LOCK" || die 'publication lock is unsafe'
    test "$(ownership "$LOCK")" = '0:0' || die 'publication lock is unsafe'
  fi
  if ! exec 9>"$LOCK"; then
    die 'publication lock could not be opened'
  fi
  test -f "$LOCK" && test ! -L "$LOCK" || die 'publication lock is unsafe'
  chmod 0600 "$LOCK" 2>/dev/null || die 'publication lock could not be protected'
  test "$(ownership "$LOCK")" = '0:0' || die 'publication lock is unsafe'
  if ! flock -n 9; then
    die 'publication is already in progress'
  fi
}

validate_public_manifest() {
  local manifest=$1
  local expected_release_sha=$2
  local expected_release_sequence=$3
  local expected_companion_version=$4
  local expected_zip_sha256=$5
  local byte_count
  require_regular_file "$manifest" 'public update manifest'
  byte_count=$(wc -c < "$manifest" 2>/dev/null | tr -d ' ') ||
    die 'public update manifest is invalid'
  [[ $byte_count =~ ^[1-9][0-9]*$ ]] && test "$byte_count" -le 65536 ||
    die 'public update manifest is invalid'
  if ! "$NODE" - "$manifest" "$expected_release_sha" "$expected_release_sequence" \
      "$expected_companion_version" "$expected_zip_sha256" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs');
const [path, releaseSHA, releaseSequenceText, companionVersion, zipSHA256] = process.argv.slice(2);
const bytes = fs.readFileSync(path);
if (bytes.length === 0 || bytes.length > 65536) throw new Error('invalid manifest');
const text = bytes.toString('utf8');
const object = JSON.parse(text);
const expected = {
  companion_version: companionVersion,
  manifest_version: 1,
  release_sequence: Number(releaseSequenceText),
  release_sha: releaseSHA,
  update_protocol_version: 1,
  zip_sha256: zipSHA256,
  zip_url: 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
};
if (text !== `${JSON.stringify(expected)}\n`) throw new Error('invalid manifest');
if (Object.getPrototypeOf(object) !== Object.prototype) throw new Error('invalid manifest');
if (Object.keys(object).length !== 7) throw new Error('invalid manifest');
for (const key of Object.keys(expected)) {
  if (!Object.prototype.hasOwnProperty.call(object, key) || object[key] !== expected[key]) {
    throw new Error('invalid manifest');
  }
}
NODE
  then
    die 'public update manifest is invalid'
  fi
}

validate_source() {
  test -d "$SOURCE" && test ! -L "$SOURCE" || die 'source must be a nonsymlink directory'
  SOURCE=$(canonicalize "$SOURCE" 'source')
  require_beneath_artifact_root "$SOURCE" 'source'

  SOURCE_INSTALLER=$SOURCE/install.sh
  SOURCE_ZIP=$SOURCE/runtime-raiders-agent.zip
  SOURCE_CHECKSUM=$SOURCE/runtime-raiders-agent.zip.sha256
  SOURCE_UPDATE_MANIFEST=$SOURCE/runtime-raiders-agent.update.json
  require_regular_file "$SOURCE_INSTALLER" 'source installer'
  require_regular_file "$SOURCE_ZIP" 'source ZIP'
  require_regular_file "$SOURCE_CHECKSUM" 'source checksum'
  require_regular_file "$SOURCE_UPDATE_MANIFEST" 'source update manifest'
  local source_entries
  shopt -s nullglob dotglob
  source_entries=("$SOURCE"/*)
  shopt -u nullglob dotglob
  test "${#source_entries[@]}" = 4 || die 'source contains unexpected entries'
  SOURCE_INSTALLER=$(canonicalize "$SOURCE_INSTALLER" 'source installer')
  SOURCE_ZIP=$(canonicalize "$SOURCE_ZIP" 'source ZIP')
  SOURCE_CHECKSUM=$(canonicalize "$SOURCE_CHECKSUM" 'source checksum')
  SOURCE_UPDATE_MANIFEST=$(canonicalize "$SOURCE_UPDATE_MANIFEST" 'source update manifest')
  require_beneath_artifact_root "$SOURCE_INSTALLER" 'source installer'
  require_beneath_artifact_root "$SOURCE_ZIP" 'source ZIP'
  require_beneath_artifact_root "$SOURCE_CHECKSUM" 'source checksum'
  require_beneath_artifact_root "$SOURCE_UPDATE_MANIFEST" 'source update manifest'

  local normalized_installer=$STAGE/normalized-installer
  if ! awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
      "$SOURCE_INSTALLER" > "$normalized_installer" 2>/dev/null; then
    die 'installer could not be normalized'
  fi
  local artifact_url_count
  local artifact_assignment_count
  local checksum_url_count
  local checksum_assignment_count
  artifact_url_count=$(grep -Fxc -- \
    "ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'" \
    "$normalized_installer" 2>/dev/null || true)
  artifact_assignment_count=$(grep -Ec -- \
    '(^|[^[:alnum:]_])ARTIFACT_URL(\[[^]]*\]|\+)?[[:space:]]*=' \
    "$normalized_installer" 2>/dev/null || true)
  checksum_url_count=$(grep -Fxc -- \
    "CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'" \
    "$normalized_installer" 2>/dev/null || true)
  checksum_assignment_count=$(grep -Ec -- \
    '(^|[^[:alnum:]_])CHECKSUM_URL(\[[^]]*\]|\+)?[[:space:]]*=' \
    "$normalized_installer" 2>/dev/null || true)
  test "$artifact_url_count" = 1 || die 'installer artifact URL is invalid'
  test "$artifact_assignment_count" = 1 || die 'installer artifact URL is invalid'
  test "$checksum_url_count" = 1 || die 'installer checksum URL is invalid'
  test "$checksum_assignment_count" = 1 || die 'installer checksum URL is invalid'
  if grep -Fq -- '__RUNTIME_RAIDERS_TEAM_ID__' "$SOURCE_INSTALLER" 2>/dev/null; then
    die 'installer Team ID is not rendered'
  fi
  rm -f -- "$normalized_installer"

  test "$(sha256_file "$SOURCE_INSTALLER")" = "$INSTALLER_SHA256" || die 'installer SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_ZIP")" = "$ZIP_SHA256" || die 'ZIP SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_CHECKSUM")" = "$CHECKSUM_SHA256" || die 'checksum SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_UPDATE_MANIFEST")" = "$UPDATE_MANIFEST_SHA256" ||
    die 'update manifest SHA-256 mismatch'
  if ! printf '%s  runtime-raiders-agent.zip\n' "$ZIP_SHA256" > "$STAGE/expected.sha256" 2>/dev/null; then
    die 'failed to stage expected checksum'
  fi
  cmp -s -- "$STAGE/expected.sha256" "$SOURCE_CHECKSUM" ||
    die 'checksum file does not match the approved ZIP'
  rm -f -- "$STAGE/expected.sha256"
  validate_public_manifest "$SOURCE_UPDATE_MANIFEST" "$RELEASE_SHA" "$RELEASE_SEQUENCE" \
    "$COMPANION_VERSION" "$ZIP_SHA256"
}

validate_release() {
  local directory=$1
  local expected_sha=$2
  local installer=$directory/install.sh
  local downloads=$directory/downloads
  local zip=$downloads/runtime-raiders-agent.zip
  local checksum=$downloads/runtime-raiders-agent.zip.sha256
  local update_manifest=$downloads/runtime-raiders-agent.update.json
  local manifest=$directory/.release-manifest
  local version_line
  local release_line
  local sequence_line
  local companion_version_line
  local protocol_line
  local installer_line
  local zip_line
  local checksum_line
  local update_manifest_line
  local extra_line
  local release_entries
  local download_entries

  require_release_sha "$expected_sha"
  require_directory "$directory" 'release directory'
  require_directory "$downloads" 'release downloads directory'
  require_regular_file "$installer" 'release installer'
  require_regular_file "$zip" 'release ZIP'
  require_regular_file "$checksum" 'release checksum'
  require_regular_file "$manifest" 'release manifest'
  IFS= read -r version_line < "$manifest" 2>/dev/null || die 'release manifest is invalid'
  shopt -s nullglob dotglob
  release_entries=("$directory"/*)
  download_entries=("$downloads"/*)
  shopt -u nullglob dotglob
  test "${#release_entries[@]}" = 3 || die 'release directory contains unexpected entries'
  test "$(metadata "$installer")" = '0:0:644' || die 'release installer must be owned by root:root with mode 0644'
  test "$(metadata "$zip")" = '0:0:644' || die 'release ZIP must be owned by root:root with mode 0644'
  test "$(metadata "$checksum")" = '0:0:644' || die 'release checksum must be owned by root:root with mode 0644'
  test "$(metadata "$manifest")" = '0:0:600' || die 'release manifest must be owned by root:root with mode 0600'

  VALIDATED_MANIFEST_VERSION=
  VALIDATED_RELEASE_SEQUENCE=
  VALIDATED_COMPANION_VERSION=
  VALIDATED_UPDATE_PROTOCOL_VERSION=
  VALIDATED_UPDATE_MANIFEST_SHA256=
  case $version_line in
    version=1)
      test "${#download_entries[@]}" = 2 || die 'release downloads directory contains unexpected entries'
      {
        IFS= read -r version_line &&
          IFS= read -r release_line &&
          IFS= read -r installer_line &&
          IFS= read -r zip_line &&
          IFS= read -r checksum_line &&
          ! IFS= read -r extra_line
      } < "$manifest" 2>/dev/null || die 'release manifest is invalid'
      test "$version_line" = 'version=1' || die 'release manifest is invalid'
      VALIDATED_MANIFEST_VERSION=1
      ;;
    version=2)
      require_regular_file "$update_manifest" 'release update manifest'
      test "${#download_entries[@]}" = 3 || die 'release downloads directory contains unexpected entries'
      test "$(metadata "$update_manifest")" = '0:0:644' ||
        die 'release update manifest must be owned by root:root with mode 0644'
      {
        IFS= read -r version_line &&
          IFS= read -r release_line &&
          IFS= read -r sequence_line &&
          IFS= read -r companion_version_line &&
          IFS= read -r protocol_line &&
          IFS= read -r installer_line &&
          IFS= read -r zip_line &&
          IFS= read -r checksum_line &&
          IFS= read -r update_manifest_line &&
          ! IFS= read -r extra_line
      } < "$manifest" 2>/dev/null || die 'release manifest is invalid'
      test "$version_line" = 'version=2' || die 'release manifest is invalid'
      [[ $sequence_line == release_sequence=* ]] || die 'release manifest is invalid'
      [[ $companion_version_line == companion_version=* ]] || die 'release manifest is invalid'
      test "$protocol_line" = 'update_protocol_version=1' || die 'release manifest is invalid'
      [[ $update_manifest_line == update_manifest_sha256=* ]] || die 'release manifest is invalid'
      VALIDATED_MANIFEST_VERSION=2
      VALIDATED_RELEASE_SEQUENCE=${sequence_line#release_sequence=}
      VALIDATED_COMPANION_VERSION=${companion_version_line#companion_version=}
      VALIDATED_UPDATE_PROTOCOL_VERSION=1
      VALIDATED_UPDATE_MANIFEST_SHA256=${update_manifest_line#update_manifest_sha256=}
      require_release_sequence "$VALIDATED_RELEASE_SEQUENCE"
      require_companion_version "$VALIDATED_COMPANION_VERSION"
      require_digest "$VALIDATED_UPDATE_MANIFEST_SHA256" 'update manifest'
      ;;
    *) die 'release manifest is invalid' ;;
  esac

  test "$release_line" = "release_sha=$expected_sha" || die 'release manifest is invalid'
  [[ $installer_line == installer_sha256=* ]] || die 'release manifest is invalid'
  [[ $zip_line == zip_sha256=* ]] || die 'release manifest is invalid'
  [[ $checksum_line == checksum_sha256=* ]] || die 'release manifest is invalid'
  VALIDATED_RELEASE_SHA=${release_line#release_sha=}
  VALIDATED_INSTALLER_SHA256=${installer_line#installer_sha256=}
  VALIDATED_ZIP_SHA256=${zip_line#zip_sha256=}
  VALIDATED_CHECKSUM_SHA256=${checksum_line#checksum_sha256=}
  require_digest "$VALIDATED_INSTALLER_SHA256" 'installer'
  require_digest "$VALIDATED_ZIP_SHA256" 'ZIP'
  require_digest "$VALIDATED_CHECKSUM_SHA256" 'checksum'

  test "$(sha256_file "$installer")" = "$VALIDATED_INSTALLER_SHA256" || die 'release installer SHA-256 mismatch'
  test "$(sha256_file "$zip")" = "$VALIDATED_ZIP_SHA256" || die 'release ZIP SHA-256 mismatch'
  test "$(sha256_file "$checksum")" = "$VALIDATED_CHECKSUM_SHA256" || die 'release checksum SHA-256 mismatch'
  printf '%s  runtime-raiders-agent.zip\n' "$VALIDATED_ZIP_SHA256" | cmp -s - "$checksum" || die 'release checksum file is not canonical'
  if test "$VALIDATED_MANIFEST_VERSION" = 2; then
    test "$(sha256_file "$update_manifest")" = "$VALIDATED_UPDATE_MANIFEST_SHA256" ||
      die 'release update manifest SHA-256 mismatch'
    validate_public_manifest "$update_manifest" "$VALIDATED_RELEASE_SHA" \
      "$VALIDATED_RELEASE_SEQUENCE" "$VALIDATED_COMPANION_VERSION" "$VALIDATED_ZIP_SHA256"
  fi
}

print_validated_status() {
  if test "$VALIDATED_MANIFEST_VERSION" = 1; then
    printf '%s\n' \
      "active_release=$VALIDATED_RELEASE_SHA" \
      "installer_sha256=$VALIDATED_INSTALLER_SHA256" \
      "zip_sha256=$VALIDATED_ZIP_SHA256" \
      "checksum_sha256=$VALIDATED_CHECKSUM_SHA256"
  else
    printf '%s\n' \
      "active_release=$VALIDATED_RELEASE_SHA" \
      "release_sequence=$VALIDATED_RELEASE_SEQUENCE" \
      "companion_version=$VALIDATED_COMPANION_VERSION" \
      "update_protocol_version=$VALIDATED_UPDATE_PROTOCOL_VERSION" \
      "installer_sha256=$VALIDATED_INSTALLER_SHA256" \
      "zip_sha256=$VALIDATED_ZIP_SHA256" \
      "checksum_sha256=$VALIDATED_CHECKSUM_SHA256" \
      "update_manifest_sha256=$VALIDATED_UPDATE_MANIFEST_SHA256"
  fi
}

validate_all_stored_releases() {
  local stored_release
  local stored_name
  local seen_sequences=' '
  HIGHEST_STORED_V2_SEQUENCE=0
  shopt -s nullglob dotglob
  for stored_release in "$RELEASES"/*; do
    stored_name=${stored_release##*/}
    require_release_sha "$stored_name"
    test -d "$stored_release" && test ! -L "$stored_release" ||
      die 'stored release must be a nonsymlink directory'
    validate_release "$stored_release" "$stored_name"
    if test "$VALIDATED_MANIFEST_VERSION" = 2; then
      case $seen_sequences in
        *" $VALIDATED_RELEASE_SEQUENCE "*) die 'stored release sequence is duplicated' ;;
      esac
      seen_sequences="$seen_sequences$VALIDATED_RELEASE_SEQUENCE "
      if test "$VALIDATED_RELEASE_SEQUENCE" -gt "$HIGHEST_STORED_V2_SEQUENCE"; then
        HIGHEST_STORED_V2_SEQUENCE=$VALIDATED_RELEASE_SEQUENCE
      fi
    fi
  done
  shopt -u nullglob dotglob
}

capture_previous_selector() {
  PREVIOUS_SELECTOR=
  if test ! -e "$CURRENT" && test ! -L "$CURRENT"; then
    return
  fi
  test -L "$CURRENT" || die 'current selector must be a symlink'
  test "$(ownership "$CURRENT")" = '0:0' || die 'current selector must be owned by root:root'
  PREVIOUS_SELECTOR=$(readlink "$CURRENT" 2>/dev/null) || die 'current selector could not be read'
  [[ $PREVIOUS_SELECTOR =~ ^releases/([0-9a-f]{40})$ ]] || die 'current selector is invalid'
  validate_release "$ARTIFACT_ROOT/$PREVIOUS_SELECTOR" "${BASH_REMATCH[1]}"
}

restore_previous_selector() {
  local selected_selector="releases/$RELEASE_SHA"
  local actual_selector
  local observed_identity
  test -L "$CURRENT" || return 1
  test "$(ownership "$CURRENT")" = '0:0' || return 1
  observed_identity=$(selector_identity "$CURRENT") || return 1
  actual_selector=$(readlink "$CURRENT" 2>/dev/null) || return 1
  test "$actual_selector" = "$selected_selector" || return 1
  if test -n "$PREVIOUS_SELECTOR"; then
    local rollback_candidate=$ARTIFACT_ROOT/.current.rollback.$$
    if test -e "$rollback_candidate" || test -L "$rollback_candidate"; then
      return 1
    fi
    ln -s -- "$PREVIOUS_SELECTOR" "$rollback_candidate" 2>/dev/null || return 1
    TEMP_SELECTOR=$rollback_candidate
  fi
  if [[ ${RUNTIME_RAIDERS_TEST_MODE:-0} == 1 ]] &&
      test -n "${RUNTIME_RAIDERS_TEST_BEFORE_ROLLBACK_MUTATION:-}"; then
    "$RUNTIME_RAIDERS_TEST_BEFORE_ROLLBACK_MUTATION" || return 1
  fi
  test -L "$CURRENT" || return 1
  test "$(ownership "$CURRENT")" = '0:0' || return 1
  test "$(selector_identity "$CURRENT")" = "$observed_identity" || return 1
  actual_selector=$(readlink "$CURRENT" 2>/dev/null) || return 1
  test "$actual_selector" = "$selected_selector" || return 1
  if test -n "$PREVIOUS_SELECTOR"; then
    mv -T -- "$TEMP_SELECTOR" "$CURRENT" 2>/dev/null || return 1
    TEMP_SELECTOR=
  else
    unlink -- "$CURRENT" 2>/dev/null || return 1
  fi
  SELECTOR_CHANGED=0
}

verify_public_artifact() {
  local label=$1
  local url=$2
  local max_bytes=$3
  local output=$4
  local expected_sha256=$5
  local max_attempts=$6
  local attempt=1
  local headers=$VERIFY/$label.headers
  local status
  local curl_status
  local byte_count
  local category

  while test "$attempt" -le "$max_attempts"; do
    rm -f -- "$output" "$headers"
    category=
    status=
    curl_status=0
    if status=$("$CURL" --disable --no-location --proto '=https' --fail --silent --show-error \
      --suppress-connect-headers --connect-timeout "$PUBLIC_CONNECT_TIMEOUT" \
      --max-time "$PUBLIC_TOTAL_TIMEOUT" \
      --max-filesize "$max_bytes" --dump-header "$headers" --output "$output" \
      --write-out '%{http_code}' "$url"); then
      curl_status=0
    else
      curl_status=$?
    fi
    if test "$status" != 200 ||
        { test "$curl_status" -ne 0 && test "$curl_status" -ne 63; }; then
      case $status in
        ''|000|200) category=request ;;
        *) category=status ;;
      esac
    else
      verification_checkpoint "$label" "$attempt" "$max_attempts" ok status
      if ! { test -f "$output" && test ! -L "$output" && test -s "$output"; }; then
        category=size
      else
        byte_count=$(wc -c < "$output" 2>/dev/null | tr -d ' ') || byte_count=
        if ! [[ $byte_count =~ ^[1-9][0-9]*$ ]] || ! test "$byte_count" -le "$max_bytes"; then
          category=size
        else
          verification_checkpoint "$label" "$attempt" "$max_attempts" ok size
          if test "$(sha256_file "$output")" != "$expected_sha256"; then
            category=digest
          else
            verification_checkpoint "$label" "$attempt" "$max_attempts" ok digest
            if ! header_has_exact_value "$headers" 'Cache-Control' 'no-store'; then
              category=cache-control
            else
              verification_checkpoint "$label" "$attempt" "$max_attempts" ok cache-control
              if ! header_has_exact_value "$headers" 'X-Content-Type-Options' 'nosniff'; then
                category=nosniff
              else
                verification_checkpoint "$label" "$attempt" "$max_attempts" ok nosniff
                if test "$label" = manifest &&
                    ! ( validate_public_manifest "$output" "$RELEASE_SHA" "$RELEASE_SEQUENCE" \
                      "$COMPANION_VERSION" "$ZIP_SHA256" ) >/dev/null 2>&1; then
                  category=manifest
                else
                  verification_checkpoint "$label" "$attempt" "$max_attempts" ok complete
                  return 0
                fi
              fi
            fi
          fi
        fi
      fi
      verification_checkpoint "$label" "$attempt" "$max_attempts" fail "$category"
      return 1
    fi
    if test "$attempt" -ge "$max_attempts"; then
      verification_checkpoint "$label" "$attempt" "$max_attempts" fail "$category"
      return 1
    fi
    verification_checkpoint "$label" "$attempt" "$max_attempts" retry "$category"
    "$SLEEP" "$PUBLIC_RETRY_DELAY" || return 1
    attempt=$((attempt + 1))
  done
  return 1
}

verify_health() {
  local label=$1
  local url=$2
  local protocol=$3
  local max_time=$4
  local max_attempts=$5
  local attempt=1
  local status
  local curl_status
  local category

  while test "$attempt" -le "$max_attempts"; do
    status=
    curl_status=0
    if status=$("$CURL" --disable --no-location --proto "$protocol" --fail --silent --show-error \
      --connect-timeout "$PUBLIC_CONNECT_TIMEOUT" --max-time "$max_time" \
      --output /dev/null --write-out '%{http_code}' "$url"); then
      curl_status=0
    else
      curl_status=$?
    fi
    if test "$curl_status" -ne 0; then
      case $status in
        ''|000) category=request ;;
        *) category=status ;;
      esac
    elif test "$status" != 200; then
      category=status
    else
      verification_checkpoint "$label" "$attempt" "$max_attempts" ok status
      verification_checkpoint "$label" "$attempt" "$max_attempts" ok complete
      return 0
    fi
    if test "$attempt" -ge "$max_attempts"; then
      verification_checkpoint "$label" "$attempt" "$max_attempts" fail "$category"
      return 1
    fi
    verification_checkpoint "$label" "$attempt" "$max_attempts" retry "$category"
    "$SLEEP" "$PUBLIC_RETRY_DELAY" || return 1
    attempt=$((attempt + 1))
  done
  return 1
}

verify_selected_public_release() {
  local created_verify
  local fetched_installer
  local fetched_zip
  local fetched_checksum
  local fetched_manifest
  created_verify=$(mktemp -d -- "$ARTIFACT_ROOT/.verify.XXXXXXXXXX" 2>/dev/null) || return 1
  VERIFY=$created_verify
  case $VERIFY in
    "$ARTIFACT_ROOT"/.verify.*) ;;
    *) return 1 ;;
  esac
  test "$(metadata "$VERIFY")" = '0:0:700' || return 1
  fetched_installer=$VERIFY/install.sh
  fetched_zip=$VERIFY/runtime-raiders-agent.zip
  fetched_checksum=$VERIFY/runtime-raiders-agent.zip.sha256
  fetched_manifest=$VERIFY/runtime-raiders-agent.update.json
  verify_public_artifact installer "$PUBLIC_INSTALLER_URL" "$INSTALLER_MAX_BYTES" "$fetched_installer" \
    "$INSTALLER_SHA256" "$PUBLIC_VERIFY_ATTEMPTS" || return 1
  verify_public_artifact zip "$PUBLIC_ZIP_URL" "$ZIP_MAX_BYTES" "$fetched_zip" "$ZIP_SHA256" \
    "$PUBLIC_VERIFY_ATTEMPTS" || return 1
  verify_public_artifact checksum "$PUBLIC_CHECKSUM_URL" "$CHECKSUM_MAX_BYTES" "$fetched_checksum" \
    "$CHECKSUM_SHA256" "$PUBLIC_VERIFY_ATTEMPTS" || return 1
  verify_public_artifact manifest "$PUBLIC_UPDATE_MANIFEST_URL" "$UPDATE_MANIFEST_MAX_BYTES" \
    "$fetched_manifest" "$UPDATE_MANIFEST_SHA256" "$PUBLIC_VERIFY_ATTEMPTS" || return 1
  verify_health public-health "$PUBLIC_HEALTH_URL" '=https' "$PUBLIC_TOTAL_TIMEOUT" \
    "$PUBLIC_VERIFY_ATTEMPTS" || return 1
  verify_health local-health "$LOCAL_HEALTH_URL" '=http' "$LOCAL_HEALTH_TOTAL_TIMEOUT" 1 || return 1
}

select_release() {
  local selected_sha=$1
  local selector_candidate=$ARTIFACT_ROOT/.current.$$
  if test -e "$selector_candidate" || test -L "$selector_candidate"; then
    die 'temporary selector already exists'
  fi
  if ! ln -s -- "releases/$selected_sha" "$selector_candidate" 2>/dev/null; then
    die 'failed to create temporary selector'
  fi
  TEMP_SELECTOR=$selector_candidate
  trap '' HUP INT TERM
  if ! mv -T -- "$TEMP_SELECTOR" "$CURRENT" 2>/dev/null; then
    trap 'exit 1' HUP INT TERM
    die 'failed to select published release'
  fi
  SELECTOR_CHANGED=1
  TEMP_SELECTOR=''
  trap 'exit 1' HUP INT TERM
}

status_command() {
  test "$#" -eq 0 || die 'status accepts no arguments'
  require_root
  validate_store

  if test ! -e "$CURRENT" && test ! -L "$CURRENT"; then
    printf 'unpublished\n'
    return
  fi
  test -L "$CURRENT" || die 'current selector must be a symlink'
  test "$(ownership "$CURRENT")" = '0:0' || die 'current selector must be owned by root:root'

  local selector
  local selected_sha
  selector=$(readlink "$CURRENT" 2>/dev/null) || die 'current selector could not be read'
  [[ $selector =~ ^releases/([0-9a-f]{40})$ ]] || die 'current selector is invalid'
  selected_sha=${BASH_REMATCH[1]}
  validate_release "$ARTIFACT_ROOT/$selector" "$selected_sha"
  print_validated_status
}

withdraw_command() {
  test "$#" -eq 2 || die 'withdraw requires exactly --release-sha SHA'
  test "$1" = '--release-sha' || die 'withdraw requires exactly --release-sha SHA'
  local release_sha=$2
  require_release_sha "$release_sha"
  require_root
  validate_store
  acquire_publication_lock
  trap 'exit 1' HUP INT TERM

  test -L "$CURRENT" || die 'current selector must be a symlink'
  test "$(ownership "$CURRENT")" = '0:0' || die 'current selector must be owned by root:root'
  local selector
  selector=$(readlink "$CURRENT" 2>/dev/null) || die 'current selector could not be read'
  test "$selector" = "releases/$release_sha" || die 'selected release does not match withdrawal SHA'

  local tombstone=$ARTIFACT_ROOT/.withdrawn.$$
  case "$tombstone" in
    "$ARTIFACT_ROOT"/.withdrawn.*) ;;
    *) die 'withdrawal tombstone is outside artifact root' ;;
  esac
  if test -e "$tombstone" || test -L "$tombstone"; then
    die 'withdrawal tombstone already exists'
  fi
  if ! mv -T -- "$CURRENT" "$tombstone" 2>/dev/null; then
    die 'failed to withdraw current selector'
  fi
  if ! unlink -- "$tombstone" 2>/dev/null; then
    die 'release is withdrawn but tombstone cleanup is required'
  fi

  printf 'withdrawn_release=%s\n' "$release_sha"
}

publish_command() {
  SOURCE=
  RELEASE_SHA=
  INSTALLER_SHA256=
  ZIP_SHA256=
  CHECKSUM_SHA256=
  RELEASE_SEQUENCE=
  COMPANION_VERSION=
  UPDATE_MANIFEST_SHA256=
  local seen_source=0
  local seen_release_sha=0
  local seen_installer_sha256=0
  local seen_zip_sha256=0
  local seen_checksum_sha256=0
  local seen_release_sequence=0
  local seen_companion_version=0
  local seen_update_manifest_sha256=0

  while test "$#" -gt 0; do
    test "$#" -ge 2 || die 'publish option requires a value'
    case $1 in
      --source)
        test "$seen_source" -eq 0 || die 'duplicate --source'
        SOURCE=$2
        seen_source=1
        ;;
      --release-sha)
        test "$seen_release_sha" -eq 0 || die 'duplicate --release-sha'
        RELEASE_SHA=$2
        seen_release_sha=1
        ;;
      --installer-sha256)
        test "$seen_installer_sha256" -eq 0 || die 'duplicate --installer-sha256'
        INSTALLER_SHA256=$2
        seen_installer_sha256=1
        ;;
      --zip-sha256)
        test "$seen_zip_sha256" -eq 0 || die 'duplicate --zip-sha256'
        ZIP_SHA256=$2
        seen_zip_sha256=1
        ;;
      --checksum-sha256)
        test "$seen_checksum_sha256" -eq 0 || die 'duplicate --checksum-sha256'
        CHECKSUM_SHA256=$2
        seen_checksum_sha256=1
        ;;
      --release-sequence)
        test "$seen_release_sequence" -eq 0 || die 'duplicate --release-sequence'
        RELEASE_SEQUENCE=$2
        seen_release_sequence=1
        ;;
      --companion-version)
        test "$seen_companion_version" -eq 0 || die 'duplicate --companion-version'
        COMPANION_VERSION=$2
        seen_companion_version=1
        ;;
      --update-manifest-sha256)
        test "$seen_update_manifest_sha256" -eq 0 || die 'duplicate --update-manifest-sha256'
        UPDATE_MANIFEST_SHA256=$2
        seen_update_manifest_sha256=1
        ;;
      *) die 'unexpected publish argument' ;;
    esac
    shift 2
  done

  test "$seen_source" -eq 1 || die 'missing --source'
  test "$seen_release_sha" -eq 1 || die 'missing --release-sha'
  test "$seen_installer_sha256" -eq 1 || die 'missing --installer-sha256'
  test "$seen_zip_sha256" -eq 1 || die 'missing --zip-sha256'
  test "$seen_checksum_sha256" -eq 1 || die 'missing --checksum-sha256'
  test "$seen_release_sequence" -eq 1 || die 'missing --release-sequence'
  test "$seen_companion_version" -eq 1 || die 'missing --companion-version'
  test "$seen_update_manifest_sha256" -eq 1 || die 'missing --update-manifest-sha256'
  require_release_sha "$RELEASE_SHA"
  require_digest "$INSTALLER_SHA256" 'installer'
  require_digest "$ZIP_SHA256" 'ZIP'
  require_digest "$CHECKSUM_SHA256" 'checksum'
  require_release_sequence "$RELEASE_SEQUENCE"
  require_companion_version "$COMPANION_VERSION"
  require_digest "$UPDATE_MANIFEST_SHA256" 'update manifest'
  require_root
  validate_store
  acquire_publication_lock
  STAGE=''
  VERIFY=''
  TEMP_SELECTOR=''
  SELECTION_COMMITTED=0
  SELECTOR_CHANGED=0
  PREVIOUS_SELECTOR=''
  cleanup() {
    local status=$?
    trap - EXIT
    trap '' HUP INT TERM
    if test "$SELECTOR_CHANGED" = 1; then
      if ! restore_previous_selector; then
        printf 'runtime-raiders-artifacts: failed to restore previous selector\n' >&2
        status=1
      fi
    fi
    if test -n "$TEMP_SELECTOR"; then
      case "$TEMP_SELECTOR" in
        "$ARTIFACT_ROOT"/.current.*)
          rm -f -- "$TEMP_SELECTOR" 2>/dev/null || status=1
          ;;
        *)
          printf 'runtime-raiders-artifacts: refusing unsafe selector cleanup\n' >&2
          status=1
          ;;
      esac
    fi
    if test -n "$STAGE"; then
      case "$STAGE" in
        "$ARTIFACT_ROOT"/.stage.*)
          rm -rf -- "$STAGE" 2>/dev/null || status=1
          ;;
        *)
          printf 'runtime-raiders-artifacts: refusing unsafe staging cleanup\n' >&2
          status=1
          ;;
      esac
    fi
    if test -n "$VERIFY"; then
      case "$VERIFY" in
        "$ARTIFACT_ROOT"/.verify.*)
          rm -rf -- "$VERIFY" 2>/dev/null || status=1
          ;;
        *)
          printf 'runtime-raiders-artifacts: refusing unsafe verification cleanup\n' >&2
          status=1
          ;;
      esac
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  local release_target=$RELEASES/$RELEASE_SHA
  validate_all_stored_releases
  test "$RELEASE_SEQUENCE" -gt "$HIGHEST_STORED_V2_SEQUENCE" ||
    die 'release sequence must increase monotonically'
  capture_previous_selector
  if test -e "$release_target" || test -L "$release_target"; then
    die 'release already exists'
  fi

  local created_stage
  created_stage=$(mktemp -d -- "$ARTIFACT_ROOT/.stage.XXXXXXXXXX" 2>/dev/null) ||
    die 'failed to create staging directory'
  STAGE=$created_stage
  case "$STAGE" in
    "$ARTIFACT_ROOT"/.stage.*) ;;
    *) die 'staging directory is outside artifact root' ;;
  esac
  validate_source

  local staged_release=$STAGE/release
  local staged_downloads=$staged_release/downloads
  install -d -o root -g root -m 0755 "$staged_release" 2>/dev/null ||
    die 'failed to stage release directory'
  install -d -o root -g root -m 0755 "$staged_downloads" 2>/dev/null ||
    die 'failed to stage downloads directory'
  install -o root -g root -m 0644 -- "$SOURCE_INSTALLER" "$staged_release/install.sh" 2>/dev/null ||
    die 'failed to stage installer'
  install -o root -g root -m 0644 -- "$SOURCE_ZIP" "$staged_downloads/runtime-raiders-agent.zip" 2>/dev/null ||
    die 'failed to stage ZIP'
  install -o root -g root -m 0644 -- "$SOURCE_CHECKSUM" "$staged_downloads/runtime-raiders-agent.zip.sha256" 2>/dev/null ||
    die 'failed to stage checksum'
  install -o root -g root -m 0644 -- "$SOURCE_UPDATE_MANIFEST" "$staged_downloads/runtime-raiders-agent.update.json" 2>/dev/null ||
    die 'failed to stage update manifest'
  if ! printf '%s\n' \
      'version=2' \
      "release_sha=$RELEASE_SHA" \
      "release_sequence=$RELEASE_SEQUENCE" \
      "companion_version=$COMPANION_VERSION" \
      'update_protocol_version=1' \
      "installer_sha256=$INSTALLER_SHA256" \
      "zip_sha256=$ZIP_SHA256" \
      "checksum_sha256=$CHECKSUM_SHA256" \
      "update_manifest_sha256=$UPDATE_MANIFEST_SHA256" > "$staged_release/.release-manifest" 2>/dev/null; then
    die 'failed to stage release manifest'
  fi
  chown root:root "$staged_release/.release-manifest" 2>/dev/null ||
    die 'failed to set release manifest ownership'
  chmod 0600 "$staged_release/.release-manifest" 2>/dev/null ||
    die 'failed to set release manifest mode'

  validate_release "$staged_release" "$RELEASE_SHA"
  mv -T -n -- "$staged_release" "$release_target" 2>/dev/null ||
    die 'failed to publish immutable release'
  if test -e "$staged_release" || test -L "$staged_release"; then
    die 'release appeared during publication'
  fi
  rmdir -- "$STAGE" 2>/dev/null || die 'failed to remove empty staging directory'
  STAGE=''

  validate_all_stored_releases
  validate_release "$release_target" "$RELEASE_SHA"
  select_release "$RELEASE_SHA"
  if ! verify_selected_public_release; then
    return 1
  fi
  rm -rf -- "$VERIFY" 2>/dev/null || die 'failed to remove public verification directory'
  VERIFY=''
  SELECTION_COMMITTED=1
  SELECTOR_CHANGED=0
  trap 'exit 0' HUP INT TERM
  print_validated_status
}

command=${1:-}
test -n "$command" || die 'command is required'
shift
case $command in
  publish) publish_command "$@" ;;
  status) status_command "$@" ;;
  withdraw) withdraw_command "$@" ;;
  *) die 'unknown command' ;;
esac
