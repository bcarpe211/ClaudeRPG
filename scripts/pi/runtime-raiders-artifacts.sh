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
sha256_file() { sha256sum -- "$1" | awk 'NR == 1 && NF >= 1 { print $1; exit }'; }
metadata() { stat -c '%u:%g:%a' -- "$1"; }

require_directory() {
  test -d "$1" && test ! -L "$1" || die "$2 must be a nonsymlink directory"
  test "$(metadata "$1")" = '0:0:755' || die "$2 must be owned by root:root with mode 0755"
}

require_regular_file() {
  test -f "$1" && test ! -L "$1" || die "$2 must be a regular file"
}

validate_store() {
  require_directory "$ARTIFACT_ROOT" 'artifact root'
  require_directory "$RELEASES" 'releases directory'
}

validate_source() {
  test -d "$SOURCE" && test ! -L "$SOURCE" || die 'source must be a nonsymlink directory'

  SOURCE_INSTALLER=$SOURCE/install.sh
  SOURCE_ZIP=$SOURCE/runtime-raiders-agent.zip
  SOURCE_CHECKSUM=$SOURCE/runtime-raiders-agent.zip.sha256
  require_regular_file "$SOURCE_INSTALLER" 'source installer'
  require_regular_file "$SOURCE_ZIP" 'source ZIP'
  require_regular_file "$SOURCE_CHECKSUM" 'source checksum'

  test "$(sha256_file "$SOURCE_INSTALLER")" = "$INSTALLER_SHA256" || die 'installer SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_ZIP")" = "$ZIP_SHA256" || die 'ZIP SHA-256 mismatch'
  test "$(sha256_file "$SOURCE_CHECKSUM")" = "$CHECKSUM_SHA256" || die 'checksum SHA-256 mismatch'
  printf '%s  runtime-raiders-agent.zip\n' "$ZIP_SHA256" | cmp -s - "$SOURCE_CHECKSUM" || die 'checksum file is not canonical'
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

  require_release_sha "$expected_sha"
  require_directory "$directory" 'release directory'
  require_regular_file "$installer" 'release installer'
  require_regular_file "$zip" 'release ZIP'
  require_regular_file "$checksum" 'release checksum'
  require_regular_file "$manifest" 'release manifest'
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
  } < "$manifest" || die 'release manifest is invalid'
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

status_command() {
  test "$#" -eq 0 || die 'status accepts no arguments'
  require_root
  validate_store

  if test ! -e "$CURRENT" && test ! -L "$CURRENT"; then
    printf 'unpublished\n'
    return
  fi
  test -L "$CURRENT" || die 'current selector must be a symlink'

  local selector
  local selected_sha
  selector=$(readlink "$CURRENT")
  [[ $selector =~ ^releases/([0-9a-f]{40})$ ]] || die 'current selector is invalid'
  selected_sha=${BASH_REMATCH[1]}
  validate_release "$ARTIFACT_ROOT/$selector" "$selected_sha"
  print_validated_status
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
  validate_source

  LOCK=$ARTIFACT_ROOT/.publication.lock
  mkdir -- "$LOCK" || die 'publication is already in progress'
  STAGE=''
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if test -n "$STAGE"; then
      case "$STAGE" in
        "$ARTIFACT_ROOT"/.stage.*) rm -rf -- "$STAGE" ;;
        *) printf 'refusing unsafe staging cleanup\n' >&2; status=1 ;;
      esac
    fi
    rmdir -- "$LOCK" 2>/dev/null || true
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  local release_target=$RELEASES/$RELEASE_SHA
  if test -e "$release_target" || test -L "$release_target"; then
    die 'release already exists'
  fi

  STAGE=$ARTIFACT_ROOT/.stage.$$
  if test -e "$STAGE" || test -L "$STAGE"; then
    die 'staging path already exists'
  fi
  local staged_release=$STAGE/release
  install -d -o root -g root -m 0755 "$STAGE"
  install -d -o root -g root -m 0755 "$staged_release"
  install -o root -g root -m 0644 -- "$SOURCE_INSTALLER" "$staged_release/install.sh"
  install -o root -g root -m 0644 -- "$SOURCE_ZIP" "$staged_release/runtime-raiders-agent.zip"
  install -o root -g root -m 0644 -- "$SOURCE_CHECKSUM" "$staged_release/runtime-raiders-agent.zip.sha256"
  printf '%s\n' \
    'version=1' \
    "release_sha=$RELEASE_SHA" \
    "installer_sha256=$INSTALLER_SHA256" \
    "zip_sha256=$ZIP_SHA256" \
    "checksum_sha256=$CHECKSUM_SHA256" > "$staged_release/.release-manifest"
  chown root:root "$staged_release/.release-manifest"
  chmod 0600 "$staged_release/.release-manifest"

  validate_release "$staged_release" "$RELEASE_SHA"
  mv -- "$staged_release" "$release_target"
  rmdir -- "$STAGE"
  STAGE=''

  local new_current=$ARTIFACT_ROOT/.current.$$
  if test -e "$new_current" || test -L "$new_current"; then
    die 'temporary selector already exists'
  fi
  ln -s "releases/$RELEASE_SHA" "$new_current"
  if ! mv -- "$new_current" "$CURRENT"; then
    rm -f -- "$new_current"
    die 'failed to select published release'
  fi

  validate_release "$release_target" "$RELEASE_SHA"
  print_validated_status
}

command=${1:-}
test -n "$command" || die 'command is required'
shift
case $command in
  publish) publish_command "$@" ;;
  status) status_command "$@" ;;
  *) die 'unknown command' ;;
esac
