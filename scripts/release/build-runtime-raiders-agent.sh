#!/bin/sh
set -e

if [ -z "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" ]; then
  echo "RUNTIME_RAIDERS_CODESIGN_IDENTITY is required" >&2
  exit 64
fi
if [ -z "$RUNTIME_RAIDERS_NOTARY_PROFILE" ]; then
  echo "RUNTIME_RAIDERS_NOTARY_PROFILE is required" >&2
  exit 64
fi
if [ -z "$RUNTIME_RAIDERS_TEAM_ID" ]; then
  echo "RUNTIME_RAIDERS_TEAM_ID is required" >&2
  exit 64
fi
case "$RUNTIME_RAIDERS_TEAM_ID" in *[!A-Z0-9]*|'') echo "RUNTIME_RAIDERS_TEAM_ID is invalid" >&2; exit 64 ;; esac
[ "$(printf '%s' "$RUNTIME_RAIDERS_TEAM_ID" | wc -c | tr -d ' ')" -eq 10 ] || {
  echo "RUNTIME_RAIDERS_TEAM_ID is invalid" >&2
  exit 64
}
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RUNTIME_RAIDERS_TEAM_ID"'"'
LAUNCHER_REQUIREMENT='identifier "com.redlattice.runtime-raiders-launcher" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RUNTIME_RAIDERS_TEAM_ID"'"'
PACKAGED_UPDATE_PROTOCOL_VERSION=2
LAUNCHER_PROTOCOL_VERSION=1
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
OUTPUT="$ROOT/dist"
SCRATCH=''
RELEASE_SHA=''
SEEN_RELEASE_SHA=0
usage() {
  echo "usage: $0 --release-sha 40-lowercase-hex [--output directory] [--scratch-path directory]" >&2
  exit 64
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-sha)
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage
      [ "$SEEN_RELEASE_SHA" -eq 0 ] || {
        echo "--release-sha may be provided only once" >&2
        exit 64
      }
      SEEN_RELEASE_SHA=1
      RELEASE_SHA="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] && [ -n "$2" ] || {
        usage
      }
      OUTPUT="$2"
      shift 2
      ;;
    --scratch-path)
      [ "$#" -ge 2 ] && [ -n "$2" ] || {
        usage
      }
      case "$2" in
        /*) SCRATCH="$2" ;;
        *) SCRATCH="$(pwd -P)/$2" ;;
      esac
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done
[ -n "$RELEASE_SHA" ] || {
  echo "--release-sha is required" >&2
  exit 64
}
case "$RELEASE_SHA" in *[!0-9a-f]*) echo "--release-sha is invalid" >&2; exit 64 ;; esac
[ "$(printf '%s' "$RELEASE_SHA" | wc -c | tr -d ' ')" -eq 40 ] || {
  echo "--release-sha is invalid" >&2
  exit 64
}

RELEASE_FILE="$ROOT/companion/RELEASE"
[ -f "$RELEASE_FILE" ] && [ ! -L "$RELEASE_FILE" ] || {
  echo "companion/RELEASE is required" >&2
  exit 64
}
RELEASE_NEWLINES="$(wc -l < "$RELEASE_FILE" | tr -d ' ')"
RELEASE_LINES="$(awk 'END { print NR }' "$RELEASE_FILE")"
[ "$RELEASE_NEWLINES" -eq 4 ] && [ "$RELEASE_LINES" -eq 4 ] || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}
RELEASE_FORMAT="$(sed -n '1p' "$RELEASE_FILE")"
COMPANION_VERSION_LINE="$(sed -n '2p' "$RELEASE_FILE")"
RELEASE_SEQUENCE_LINE="$(sed -n '3p' "$RELEASE_FILE")"
UPDATE_PROTOCOL_LINE="$(sed -n '4p' "$RELEASE_FILE")"
[ "$RELEASE_FORMAT" = 'version=1' ] || {
  echo "companion/RELEASE is invalid" >&2
  exit 64
}
case "$COMPANION_VERSION_LINE" in companion_version=*) COMPANION_VERSION=${COMPANION_VERSION_LINE#companion_version=} ;; *) echo "companion/RELEASE is invalid" >&2; exit 64 ;; esac
case "$COMPANION_VERSION" in ''|*[!A-Za-z0-9._+-]*) echo "companion_version is invalid" >&2; exit 64 ;; esac
[ "$(printf '%s' "$COMPANION_VERSION" | wc -c | tr -d ' ')" -le 100 ] || {
  echo "companion_version is invalid" >&2
  exit 64
}
case "$RELEASE_SEQUENCE_LINE" in release_sequence=*) RELEASE_SEQUENCE=${RELEASE_SEQUENCE_LINE#release_sequence=} ;; *) echo "companion/RELEASE is invalid" >&2; exit 64 ;; esac
case "$RELEASE_SEQUENCE" in ''|0|0*|*[!0-9]*) echo "release_sequence is invalid" >&2; exit 64 ;; esac
[ "$(printf '%s' "$RELEASE_SEQUENCE" | wc -c | tr -d ' ')" -le 16 ] &&
  [ "$RELEASE_SEQUENCE" -le 9007199254740991 ] || {
  echo "release_sequence is invalid" >&2
  exit 64
}
[ "$UPDATE_PROTOCOL_LINE" = 'update_protocol_version=2' ] || {
  echo "update_protocol_version is invalid" >&2
  exit 64
}
/usr/bin/git -C "$ROOT" ls-files --error-unmatch -- companion/RELEASE >/dev/null 2>&1 || {
  echo "companion/RELEASE must be tracked by Git" >&2
  exit 64
}
GIT_STATUS="$(/usr/bin/git -C "$ROOT" status --porcelain --untracked-files=all)" || {
  echo "unable to inspect Git worktree" >&2
  exit 64
}
[ -z "$GIT_STATUS" ] || {
  echo "Git worktree is not clean" >&2
  exit 64
}
GIT_HEAD="$(/usr/bin/git -C "$ROOT" rev-parse --verify HEAD)" || {
  echo "unable to inspect Git HEAD" >&2
  exit 64
}
[ "$GIT_HEAD" = "$RELEASE_SHA" ] || {
  echo "release SHA does not match Git HEAD" >&2
  exit 64
}

case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$(pwd -P)/$OUTPUT" ;;
esac
OUTPUT_PARENT="$(dirname "$OUTPUT")"
OUTPUT_NAME="$(basename "$OUTPUT")"
case "$OUTPUT_NAME" in ''|.|..|/) echo "release output is invalid" >&2; exit 64 ;; esac
[ -d "$OUTPUT_PARENT" ] && [ ! -L "$OUTPUT_PARENT" ] || {
  echo "release output parent must be an existing nonsymlink directory" >&2
  exit 64
}
OUTPUT_PARENT="$(CDPATH= cd -- "$OUTPUT_PARENT" && pwd -P)"
OUTPUT="$OUTPUT_PARENT/$OUTPUT_NAME"
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "release output must be absent; publish immutable generations with scripts/pi/runtime-raiders-artifacts.sh" >&2
  exit 1
}

TEMP_ROOT=/tmp
[ -n "$TMPDIR" ] && TEMP_ROOT="$TMPDIR"
WORK="$(mktemp -d "$TEMP_ROOT/runtime-raiders-release.XXXXXX")"
UNPUBLISHED_STAGE=''
cleanup() {
  status=$?
  rm -rf "$WORK"
  [ -z "$UNPUBLISHED_STAGE" ] || rm -rf "$UNPUBLISHED_STAGE"
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
STAGED_OUTPUT="$(mktemp -d "$WORK/output.XXXXXX")"
for arch in arm64 x86_64; do
  if [ -n "$SCRATCH" ]; then
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --scratch-path "$SCRATCH" --product raiders)
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --scratch-path "$SCRATCH" --product runtime-raiders-launcher)
    cp "$SCRATCH/$arch-apple-macosx/release/raiders" "$WORK/raiders-$arch"
    cp "$SCRATCH/$arch-apple-macosx/release/runtime-raiders-launcher" "$WORK/runtime-raiders-launcher-$arch"
  else
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --product raiders)
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --product runtime-raiders-launcher)
    cp "$ROOT/companion/.build/$arch-apple-macosx/release/raiders" "$WORK/raiders-$arch"
    cp "$ROOT/companion/.build/$arch-apple-macosx/release/runtime-raiders-launcher" "$WORK/runtime-raiders-launcher-$arch"
  fi
done
lipo -create "$WORK/raiders-arm64" "$WORK/raiders-x86_64" -output "$WORK/runtime-raiders-agent"
lipo -create "$WORK/runtime-raiders-launcher-arm64" "$WORK/runtime-raiders-launcher-x86_64" -output "$WORK/runtime-raiders-launcher"
lipo -verify_arch arm64 x86_64 "$WORK/runtime-raiders-agent"
lipo -verify_arch arm64 x86_64 "$WORK/runtime-raiders-launcher"
"$ROOT/scripts/release/build-runtime-raiders-release-validator.sh" \
  "$ROOT/companion" \
  "$WORK/validator-scratch" \
  "$WORK/runtime-raiders-release-validator"
RELEASE_VALIDATOR="$WORK/runtime-raiders-release-validator"
RELEASE_VALIDATOR_SHA256="$(/usr/bin/shasum -a 256 "$RELEASE_VALIDATOR" | awk 'NR == 1 { print $1 }')"
case "$RELEASE_VALIDATOR_SHA256" in ''|*[!0-9a-f]*) echo "release validator checksum failed" >&2; exit 1 ;; esac
[ "${#RELEASE_VALIDATOR_SHA256}" -eq 64 ] || { echo "release validator checksum failed" >&2; exit 1; }
RELEASE_CONTAINER="$WORK/Runtime Raiders Release"
AGENT_APP="$RELEASE_CONTAINER/Runtime Raiders Agent.app"
LAUNCHER_APP="$RELEASE_CONTAINER/Runtime Raiders Launcher.app"
mkdir -p "$AGENT_APP/Contents/MacOS" "$LAUNCHER_APP/Contents/MacOS"
mv "$WORK/runtime-raiders-agent" "$AGENT_APP/Contents/MacOS/runtime-raiders-agent"
mv "$WORK/runtime-raiders-launcher" "$LAUNCHER_APP/Contents/MacOS/runtime-raiders-launcher"
cat > "$AGENT_APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>runtime-raiders-agent</string>
<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>
<key>CFBundleName</key><string>Runtime Raiders Agent</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$COMPANION_VERSION</string>
<key>RuntimeRaidersReleaseSequence</key><integer>$RELEASE_SEQUENCE</integer>
<key>RuntimeRaidersReleaseSHA</key><string>$RELEASE_SHA</string>
<key>RuntimeRaidersUpdateProtocolVersion</key><integer>$PACKAGED_UPDATE_PROTOCOL_VERSION</integer>
</dict></plist>
EOF
cat > "$LAUNCHER_APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>runtime-raiders-launcher</string>
<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-launcher</string>
<key>CFBundleName</key><string>Runtime Raiders Launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$COMPANION_VERSION</string>
<key>RuntimeRaidersLauncherProtocolVersion</key><integer>$LAUNCHER_PROTOCOL_VERSION</integer>
</dict></plist>
EOF
AGENT_INFO_PLIST="$AGENT_APP/Contents/Info.plist"
LAUNCHER_INFO_PLIST="$LAUNCHER_APP/Contents/Info.plist"
/usr/bin/plutil -lint "$AGENT_INFO_PLIST" >/dev/null &&
  /usr/bin/plutil -lint "$LAUNCHER_INFO_PLIST" >/dev/null || {
  echo "release identity plist rendering failed" >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$AGENT_INFO_PLIST")" = 'com.redlattice.runtime-raiders-agent' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$AGENT_INFO_PLIST")" = 'runtime-raiders-agent' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$AGENT_INFO_PLIST")" = "$COMPANION_VERSION" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$AGENT_INFO_PLIST")" = "$RELEASE_SEQUENCE" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$AGENT_INFO_PLIST")" = "$RELEASE_SHA" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$AGENT_INFO_PLIST")" = "$PACKAGED_UPDATE_PROTOCOL_VERSION" ] &&
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$LAUNCHER_INFO_PLIST")" = 'com.redlattice.runtime-raiders-launcher' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$LAUNCHER_INFO_PLIST")" = 'runtime-raiders-launcher' ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersLauncherProtocolVersion raw -o - "$LAUNCHER_INFO_PLIST")" = "$LAUNCHER_PROTOCOL_VERSION" ] &&
  ! /usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$LAUNCHER_INFO_PLIST" >/dev/null 2>&1 || {
  echo "release identity plist validation failed" >&2
  exit 1
}
codesign --force --options runtime --timestamp --sign "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" "$AGENT_APP"
codesign --force --options runtime --timestamp --sign "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" "$LAUNCHER_APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$AGENT_REQUIREMENT" "$AGENT_APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$LAUNCHER_REQUIREMENT" "$LAUNCHER_APP"
NOTARY_ZIP="$WORK/notary.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$RELEASE_CONTAINER" "$NOTARY_ZIP"
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE" --wait
xcrun stapler staple "$AGENT_APP"
xcrun stapler staple "$LAUNCHER_APP"
xcrun stapler validate "$AGENT_APP"
xcrun stapler validate "$LAUNCHER_APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$AGENT_REQUIREMENT" "$AGENT_APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$LAUNCHER_REQUIREMENT" "$LAUNCHER_APP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$RELEASE_CONTAINER" "$STAGED_OUTPUT/runtime-raiders-agent.zip"
ARCHIVE_VALIDATION="$(mktemp -d "$WORK/archive-validation.XXXXXX")"
/usr/bin/ditto -x -k "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$ARCHIVE_VALIDATION"
PACKAGED_RELEASE="$ARCHIVE_VALIDATION/Runtime Raiders Release"
PACKAGED_AGENT_APP="$PACKAGED_RELEASE/Runtime Raiders Agent.app"
PACKAGED_LAUNCHER_APP="$PACKAGED_RELEASE/Runtime Raiders Launcher.app"
[ -d "$PACKAGED_RELEASE" ] && [ ! -L "$PACKAGED_RELEASE" ] &&
  [ -d "$PACKAGED_AGENT_APP" ] && [ ! -L "$PACKAGED_AGENT_APP" ] &&
  [ -d "$PACKAGED_LAUNCHER_APP" ] && [ ! -L "$PACKAGED_LAUNCHER_APP" ] || {
  echo "release archive extraction validation failed" >&2
  exit 1
}
codesign --verify --strict --verbose=2 --all-architectures -R="$AGENT_REQUIREMENT" "$PACKAGED_AGENT_APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$LAUNCHER_REQUIREMENT" "$PACKAGED_LAUNCHER_APP"
xcrun stapler validate "$PACKAGED_AGENT_APP"
xcrun stapler validate "$PACKAGED_LAUNCHER_APP"
[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = 'com.redlattice.runtime-raiders-agent' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = 'runtime-raiders-agent' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = "$COMPANION_VERSION" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = "$RELEASE_SEQUENCE" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = "$RELEASE_SHA" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$PACKAGED_AGENT_APP/Contents/Info.plist")" = "$PACKAGED_UPDATE_PROTOCOL_VERSION" ] &&
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$PACKAGED_LAUNCHER_APP/Contents/Info.plist")" = 'com.redlattice.runtime-raiders-launcher' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$PACKAGED_LAUNCHER_APP/Contents/Info.plist")" = 'runtime-raiders-launcher' ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersLauncherProtocolVersion raw -o - "$PACKAGED_LAUNCHER_APP/Contents/Info.plist")" = "$LAUNCHER_PROTOCOL_VERSION" ] || {
  echo "release archive identity validation failed" >&2
  exit 1
}
"$RELEASE_VALIDATOR" "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$ARCHIVE_VALIDATION" \
  "$RELEASE_SEQUENCE" "$RELEASE_SHA" "$COMPANION_VERSION" \
  "$PACKAGED_UPDATE_PROTOCOL_VERSION" "$RUNTIME_RAIDERS_TEAM_ID" || {
  echo "release archive shape validation failed" >&2
  exit 1
}
ZIP_SHA256="$(shasum -a 256 "$STAGED_OUTPUT/runtime-raiders-agent.zip" | awk 'NR == 1 { print $1 }')"
case "$ZIP_SHA256" in ''|*[!0-9a-f]*) echo "release archive checksum staging failed" >&2; exit 1 ;; esac
[ "$(printf '%s' "$ZIP_SHA256" | wc -c | tr -d ' ')" -eq 64 ] || {
  echo "release archive checksum staging failed" >&2
  exit 1
}
printf '%s  runtime-raiders-agent.zip\n' "$ZIP_SHA256" > "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256"
[ -s "$STAGED_OUTPUT/runtime-raiders-agent.zip" ] && [ -s "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" ] || {
  echo "release archive checksum staging failed" >&2
  exit 1
}
MANIFEST_JSON='{"companion_version":"'"$COMPANION_VERSION"'","manifest_version":1,"release_sequence":'"$RELEASE_SEQUENCE"',"release_sha":"'"$RELEASE_SHA"'","update_protocol_version":'"$PACKAGED_UPDATE_PROTOCOL_VERSION"',"zip_sha256":"'"$ZIP_SHA256"'","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}'
printf '%s\n' "$MANIFEST_JSON" > "$STAGED_OUTPUT/runtime-raiders-agent.update.json"
/usr/bin/plutil -convert json -o - "$STAGED_OUTPUT/runtime-raiders-agent.update.json" >/dev/null || {
  echo "release update manifest validation failed" >&2
  exit 1
}
[ "$(wc -l < "$STAGED_OUTPUT/runtime-raiders-agent.update.json" | tr -d ' ')" -eq 1 ] &&
  [ "$(awk 'END { print NR }' "$STAGED_OUTPUT/runtime-raiders-agent.update.json")" -eq 1 ] &&
  [ "$(cat "$STAGED_OUTPUT/runtime-raiders-agent.update.json")" = "$MANIFEST_JSON" ] || {
  echo "release update manifest validation failed" >&2
  exit 1
}
"$ROOT/scripts/release/render-runtime-raiders-installer.sh" \
  "$ROOT/companion/packaging/install.sh" \
  "$RELEASE_VALIDATOR" \
  "$RUNTIME_RAIDERS_TEAM_ID" \
  "$COMPANION_VERSION" \
  "$RELEASE_SEQUENCE" \
  "$RELEASE_SHA" \
  "$PACKAGED_UPDATE_PROTOCOL_VERSION" \
  "$STAGED_OUTPUT/install.sh"
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "release output must be absent; publish immutable generations with scripts/pi/runtime-raiders-artifacts.sh" >&2
  exit 1
}
UNPUBLISHED_STAGE="$(mktemp -d "$OUTPUT_PARENT/.runtime-raiders-unpublished.XXXXXX")"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$UNPUBLISHED_STAGE/runtime-raiders-agent.zip"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" "$UNPUBLISHED_STAGE/runtime-raiders-agent.zip.sha256"
cp "$STAGED_OUTPUT/install.sh" "$UNPUBLISHED_STAGE/install.sh"
cp "$STAGED_OUTPUT/runtime-raiders-agent.update.json" "$UNPUBLISHED_STAGE/runtime-raiders-agent.update.json"
[ "$(find "$UNPUBLISHED_STAGE" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -eq 4 ] || {
  echo "unpublished release staging is incomplete" >&2
  exit 1
}
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "release output must be absent; publish immutable generations with scripts/pi/runtime-raiders-artifacts.sh" >&2
  exit 1
}
/bin/mv "$UNPUBLISHED_STAGE" "$OUTPUT"
UNPUBLISHED_STAGE=''
echo "Built unpublished signed quartet at $OUTPUT (publication requires scripts/pi/runtime-raiders-artifacts.sh)."
