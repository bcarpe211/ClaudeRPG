#!/usr/bin/env bash
set -Eeuo pipefail

PRODUCTION_ROOT=/var/lib/runtime-raiders
ARTIFACT_ROOT=$PRODUCTION_ROOT
if [[ ${RUNTIME_RAIDERS_TEST_MODE:-0} == 1 ]]; then
  ARTIFACT_ROOT=${RUNTIME_RAIDERS_ARTIFACT_ROOT:?test artifact root is required}
fi
RELEASES=$ARTIFACT_ROOT/releases
CURRENT=$ARTIFACT_ROOT/current

die() { printf 'runtime-raiders-artifacts: %s\n' "$1" >&2; exit 1; }
require_root() { test "$(id -u)" = 0 || die 'root is required'; }
require_release_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]] || die 'invalid release SHA'; }
require_digest() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || die "invalid $2 SHA-256"; }
sha256_file() { sha256sum -- "$1" 2>/dev/null | awk 'NR == 1 && NF >= 1 { print $1; exit }'; }
metadata() { stat -c '%u:%g:%a' -- "$1" 2>/dev/null; }
ownership() { stat -c '%u:%g' -- "$1" 2>/dev/null; }

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

validate_source() {
  test -d "$SOURCE" && test ! -L "$SOURCE" || die 'source must be a nonsymlink directory'
  SOURCE=$(canonicalize "$SOURCE" 'source')
  require_beneath_artifact_root "$SOURCE" 'source'

  SOURCE_INSTALLER=$SOURCE/install.sh
  SOURCE_ZIP=$SOURCE/runtime-raiders-agent.zip
  SOURCE_CHECKSUM=$SOURCE/runtime-raiders-agent.zip.sha256
  require_regular_file "$SOURCE_INSTALLER" 'source installer'
  require_regular_file "$SOURCE_ZIP" 'source ZIP'
  require_regular_file "$SOURCE_CHECKSUM" 'source checksum'
  SOURCE_INSTALLER=$(canonicalize "$SOURCE_INSTALLER" 'source installer')
  SOURCE_ZIP=$(canonicalize "$SOURCE_ZIP" 'source ZIP')
  SOURCE_CHECKSUM=$(canonicalize "$SOURCE_CHECKSUM" 'source checksum')
  require_beneath_artifact_root "$SOURCE_INSTALLER" 'source installer'
  require_beneath_artifact_root "$SOURCE_ZIP" 'source ZIP'
  require_beneath_artifact_root "$SOURCE_CHECKSUM" 'source checksum'

  local normalized_installer=$STAGE/normalized-installer
  if ! awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
      "$SOURCE_INSTALLER" > "$normalized_installer" 2>/dev/null; then
    die 'installer could not be normalized'
  fi
  local artifact_url_count
  local artifact_identifier_count
  local checksum_url_count
  local checksum_identifier_count
  artifact_url_count=$(grep -Fxc -- \
    "ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'" \
    "$normalized_installer" 2>/dev/null || true)
  artifact_identifier_count=$(grep -Foc -- 'ARTIFACT_URL' "$normalized_installer" 2>/dev/null || true)
  checksum_url_count=$(grep -Fxc -- \
    "CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'" \
    "$normalized_installer" 2>/dev/null || true)
  checksum_identifier_count=$(grep -Foc -- 'CHECKSUM_URL' "$normalized_installer" 2>/dev/null || true)
  test "$artifact_url_count" = 1 || die 'installer artifact URL is invalid'
  test "$artifact_identifier_count" = 1 || die 'installer artifact URL is invalid'
  test "$checksum_url_count" = 1 || die 'installer checksum URL is invalid'
  test "$checksum_identifier_count" = 1 || die 'installer checksum URL is invalid'
  if grep -Fq -- '__RUNTIME_RAIDERS_TEAM_ID__' "$SOURCE_INSTALLER" 2>/dev/null; then
    die 'installer Team ID is not rendered'
  fi
  rm -f -- "$normalized_installer"

  test "$(sha256_file "$SOURCE_INSTALLER")" = "$INSTALLER_SHA256" || die 'installer SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_ZIP")" = "$ZIP_SHA256" || die 'ZIP SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_CHECKSUM")" = "$CHECKSUM_SHA256" || die 'checksum SHA-256 mismatch'
  if ! printf '%s  runtime-raiders-agent.zip\n' "$ZIP_SHA256" > "$STAGE/expected.sha256" 2>/dev/null; then
    die 'failed to stage expected checksum'
  fi
  cmp -s -- "$STAGE/expected.sha256" "$SOURCE_CHECKSUM" ||
    die 'checksum file does not match the approved ZIP'
  rm -f -- "$STAGE/expected.sha256"
}

validate_release() {
  local directory=$1
  local expected_sha=$2
  local installer=$directory/install.sh
  local zip=$directory/runtime-raiders-agent.zip
  local checksum=$directory/runtime-raiders-agent.zip.sha256
  local manifest=$directory/.release-manifest
  local version_line
  local release_line
  local installer_line
  local zip_line
  local checksum_line
  local extra_line
  local entries

  require_release_sha "$expected_sha"
  require_directory "$directory" 'release directory'
  require_regular_file "$installer" 'release installer'
  require_regular_file "$zip" 'release ZIP'
  require_regular_file "$checksum" 'release checksum'
  require_regular_file "$manifest" 'release manifest'
  shopt -s nullglob dotglob
  entries=("$directory"/*)
  shopt -u nullglob dotglob
  test "${#entries[@]}" = 4 || die 'release directory contains unexpected entries'
  test "$(metadata "$installer")" = '0:0:644' || die 'release installer must be owned by root:root with mode 0644'
  test "$(metadata "$zip")" = '0:0:644' || die 'release ZIP must be owned by root:root with mode 0644'
  test "$(metadata "$checksum")" = '0:0:644' || die 'release checksum must be owned by root:root with mode 0644'
  test "$(metadata "$manifest")" = '0:0:600' || die 'release manifest must be owned by root:root with mode 0600'

  {
    IFS= read -r version_line &&
      IFS= read -r release_line &&
      IFS= read -r installer_line &&
      IFS= read -r zip_line &&
      IFS= read -r checksum_line &&
      ! IFS= read -r extra_line
  } < "$manifest" 2>/dev/null || die 'release manifest is invalid'
  test "$version_line" = 'version=1' || die 'release manifest is invalid'
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
}

print_validated_status() {
  printf '%s\n' \
    "active_release=$VALIDATED_RELEASE_SHA" \
    "installer_sha256=$VALIDATED_INSTALLER_SHA256" \
    "zip_sha256=$VALIDATED_ZIP_SHA256" \
    "checksum_sha256=$VALIDATED_CHECKSUM_SHA256"
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
  SELECTION_COMMITTED=1
  TEMP_SELECTOR=''
  trap 'exit 0' HUP INT TERM
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

  LOCK=$ARTIFACT_ROOT/.publication.lock
  OWNS_LOCK=0
  if ! mkdir -- "$LOCK" 2>/dev/null; then
    die 'publication is already in progress'
  fi
  OWNS_LOCK=1
  withdraw_cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if test "$OWNS_LOCK" = 1; then
      if test "$LOCK" = "$ARTIFACT_ROOT/.publication.lock"; then
        rmdir -- "$LOCK" 2>/dev/null || status=1
      else
        printf 'runtime-raiders-artifacts: refusing unsafe lock cleanup\n' >&2
        status=1
      fi
    fi
    exit "$status"
  }
  trap withdraw_cleanup EXIT
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
  local seen_source=0
  local seen_release_sha=0
  local seen_installer_sha256=0
  local seen_zip_sha256=0
  local seen_checksum_sha256=0

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
      *) die 'unexpected publish argument' ;;
    esac
    shift 2
  done

  test "$seen_source" -eq 1 || die 'missing --source'
  test "$seen_release_sha" -eq 1 || die 'missing --release-sha'
  test "$seen_installer_sha256" -eq 1 || die 'missing --installer-sha256'
  test "$seen_zip_sha256" -eq 1 || die 'missing --zip-sha256'
  test "$seen_checksum_sha256" -eq 1 || die 'missing --checksum-sha256'
  require_release_sha "$RELEASE_SHA"
  require_digest "$INSTALLER_SHA256" 'installer'
  require_digest "$ZIP_SHA256" 'ZIP'
  require_digest "$CHECKSUM_SHA256" 'checksum'
  require_root
  validate_store

  LOCK=$ARTIFACT_ROOT/.publication.lock
  STAGE=''
  TEMP_SELECTOR=''
  SELECTION_COMMITTED=0
  OWNS_LOCK=0
  if ! mkdir -- "$LOCK" 2>/dev/null; then
    die 'publication is already in progress'
  fi
  OWNS_LOCK=1
  cleanup() {
    local status=$?
    trap - EXIT
    if test "$SELECTION_COMMITTED" = 1; then
      trap '' HUP INT TERM
    else
      trap - HUP INT TERM
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
    if test "$OWNS_LOCK" = 1; then
      if test "$LOCK" = "$ARTIFACT_ROOT/.publication.lock"; then
        if ! rmdir -- "$LOCK" 2>/dev/null && test "$SELECTION_COMMITTED" = 0; then
          status=1
        fi
      else
        printf 'runtime-raiders-artifacts: refusing unsafe lock cleanup\n' >&2
        status=1
      fi
    fi
    if test "$SELECTION_COMMITTED" = 1; then
      status=0
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  local release_target=$RELEASES/$RELEASE_SHA
  if test -e "$release_target" || test -L "$release_target"; then
    validate_release "$release_target" "$RELEASE_SHA"
    test "$VALIDATED_INSTALLER_SHA256" = "$INSTALLER_SHA256" ||
      die 'existing release does not match approved digests'
    test "$VALIDATED_ZIP_SHA256" = "$ZIP_SHA256" ||
      die 'existing release does not match approved digests'
    test "$VALIDATED_CHECKSUM_SHA256" = "$CHECKSUM_SHA256" ||
      die 'existing release does not match approved digests'
    select_release "$RELEASE_SHA"
    print_validated_status
    return
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
  install -d -o root -g root -m 0755 "$staged_release" 2>/dev/null ||
    die 'failed to stage release directory'
  install -o root -g root -m 0644 -- "$SOURCE_INSTALLER" "$staged_release/install.sh" 2>/dev/null ||
    die 'failed to stage installer'
  install -o root -g root -m 0644 -- "$SOURCE_ZIP" "$staged_release/runtime-raiders-agent.zip" 2>/dev/null ||
    die 'failed to stage ZIP'
  install -o root -g root -m 0644 -- "$SOURCE_CHECKSUM" "$staged_release/runtime-raiders-agent.zip.sha256" 2>/dev/null ||
    die 'failed to stage checksum'
  if ! printf '%s\n' \
      'version=1' \
      "release_sha=$RELEASE_SHA" \
      "installer_sha256=$INSTALLER_SHA256" \
      "zip_sha256=$ZIP_SHA256" \
      "checksum_sha256=$CHECKSUM_SHA256" > "$staged_release/.release-manifest" 2>/dev/null; then
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

  validate_release "$release_target" "$RELEASE_SHA"
  select_release "$RELEASE_SHA"
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
