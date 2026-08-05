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
REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RUNTIME_RAIDERS_TEAM_ID"'"'
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
[ "$UPDATE_PROTOCOL_LINE" = 'update_protocol_version=1' ] || {
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

TEMP_ROOT=/tmp
[ -n "$TMPDIR" ] && TEMP_ROOT="$TMPDIR"
WORK="$(mktemp -d "$TEMP_ROOT/runtime-raiders-release.XXXXXX")"
TRANSACTION=''
release_transaction_active=0
release_transaction_committed=0
old_zip=0
old_checksum=0
old_install=0
old_manifest=0
placed_zip=0
placed_checksum=0
placed_install=0
placed_manifest=0
rollback_release() {
  [ "$release_transaction_active" -eq 1 ] && [ "$release_transaction_committed" -eq 0 ] || return 0
  release_transaction_active=0
  [ "$placed_zip" -eq 0 ] || rm -f "$OUTPUT/runtime-raiders-agent.zip"
  [ "$placed_checksum" -eq 0 ] || rm -f "$OUTPUT/runtime-raiders-agent.zip.sha256"
  [ "$placed_install" -eq 0 ] || rm -f "$OUTPUT/install.sh"
  [ "$placed_manifest" -eq 0 ] || rm -f "$OUTPUT/runtime-raiders-agent.update.json"
  [ "$old_zip" -eq 0 ] || [ ! -f "$TRANSACTION/old-runtime-raiders-agent.zip" ] || /bin/mv "$TRANSACTION/old-runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip"
  [ "$old_checksum" -eq 0 ] || [ ! -f "$TRANSACTION/old-runtime-raiders-agent.zip.sha256" ] || /bin/mv "$TRANSACTION/old-runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256"
  [ "$old_install" -eq 0 ] || [ ! -f "$TRANSACTION/old-install.sh" ] || /bin/mv "$TRANSACTION/old-install.sh" "$OUTPUT/install.sh"
  [ "$old_manifest" -eq 0 ] || [ ! -f "$TRANSACTION/old-runtime-raiders-agent.update.json" ] || /bin/mv "$TRANSACTION/old-runtime-raiders-agent.update.json" "$OUTPUT/runtime-raiders-agent.update.json"
}
cleanup() {
  status=$?
  rollback_release
  rm -rf "$WORK" "$TRANSACTION"
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
STAGED_OUTPUT="$(mktemp -d "$WORK/output.XXXXXX")"
for arch in arm64 x86_64; do
  if [ -n "$SCRATCH" ]; then
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --scratch-path "$SCRATCH" --product raiders)
    cp "$SCRATCH/$arch-apple-macosx/release/raiders" "$WORK/raiders-$arch"
  else
    (cd "$ROOT/companion" && swift build -c release --arch "$arch" --product raiders)
    cp "$ROOT/companion/.build/$arch-apple-macosx/release/raiders" "$WORK/raiders-$arch"
  fi
done
lipo -create "$WORK/raiders-arm64" "$WORK/raiders-x86_64" -output "$WORK/runtime-raiders-agent"
APP="$WORK/Runtime Raiders Agent.app"
mkdir -p "$APP/Contents/MacOS"
mv "$WORK/runtime-raiders-agent" "$APP/Contents/MacOS/runtime-raiders-agent"
cat > "$APP/Contents/Info.plist" <<EOF
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
<key>RuntimeRaidersUpdateProtocolVersion</key><integer>1</integer>
</dict></plist>
EOF
INFO_PLIST="$APP/Contents/Info.plist"
/usr/bin/plutil -lint "$INFO_PLIST" >/dev/null || {
  echo "release identity plist rendering failed" >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$INFO_PLIST")" = 'com.redlattice.runtime-raiders-agent' ] &&
  [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")" = "$COMPANION_VERSION" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$INFO_PLIST")" = "$RELEASE_SEQUENCE" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$INFO_PLIST")" = "$RELEASE_SHA" ] &&
  [ "$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$INFO_PLIST")" = '1' ] || {
  echo "release identity plist validation failed" >&2
  exit 1
}
codesign --force --options runtime --timestamp --sign "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" "$APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$REQUIREMENT" "$APP"
NOTARY_ZIP="$WORK/notary.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --strict --verbose=2 --all-architectures -R="$REQUIREMENT" "$APP"
ditto -c -k --keepParent "$APP" "$STAGED_OUTPUT/runtime-raiders-agent.zip"
ZIP_ENTRIES="$WORK/distribution-zip-entries"
/usr/bin/unzip -Z1 "$STAGED_OUTPUT/runtime-raiders-agent.zip" > "$ZIP_ENTRIES" || {
  echo "release archive shape validation failed" >&2
  exit 1
}
[ -s "$ZIP_ENTRIES" ] || {
  echo "release archive shape validation failed" >&2
  exit 1
}
saw_app_root=0
while IFS= read -r entry; do
  case "$entry" in
    'Runtime Raiders Agent.app/') saw_app_root=1 ;;
    'Runtime Raiders Agent.app/'*) ;;
    *) echo "release archive shape validation failed" >&2; exit 1 ;;
  esac
done < "$ZIP_ENTRIES"
[ "$saw_app_root" -eq 1 ] || {
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
MANIFEST_JSON='{"companion_version":"'"$COMPANION_VERSION"'","manifest_version":1,"release_sequence":'"$RELEASE_SEQUENCE"',"release_sha":"'"$RELEASE_SHA"'","update_protocol_version":1,"zip_sha256":"'"$ZIP_SHA256"'","zip_url":"https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip"}'
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
sed \
  -e "s/__RUNTIME_RAIDERS_TEAM_ID__/$RUNTIME_RAIDERS_TEAM_ID/g" \
  -e "s/__RUNTIME_RAIDERS_COMPANION_VERSION__/$COMPANION_VERSION/g" \
  -e "s/__RUNTIME_RAIDERS_RELEASE_SEQUENCE__/$RELEASE_SEQUENCE/g" \
  -e "s/__RUNTIME_RAIDERS_RELEASE_SHA__/$RELEASE_SHA/g" \
  -e 's/__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__/1/g' \
  "$ROOT/companion/packaging/install.sh" > "$STAGED_OUTPUT/install.sh"
chmod 755 "$STAGED_OUTPUT/install.sh"
grep -F '__RUNTIME_RAIDERS_' "$STAGED_OUTPUT/install.sh" >/dev/null && {
  echo "release installer contract rendering failed" >&2
  exit 1
}
[ ! -L "$OUTPUT" ] || {
  echo "refusing unsafe release output directory: $OUTPUT" >&2
  exit 1
}
if [ -e "$OUTPUT" ]; then
  [ -d "$OUTPUT" ] || {
    echo "refusing unsafe release output directory: $OUTPUT" >&2
    exit 1
  }
else
  mkdir -p "$OUTPUT"
fi
existing_targets=0
for target in "$OUTPUT/install.sh" "$OUTPUT/runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.update.json"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] || {
      echo "refusing unsafe existing release target: $target" >&2
      exit 1
    }
    existing_targets=$((existing_targets + 1))
  fi
done
[ "$existing_targets" -eq 0 ] || [ "$existing_targets" -eq 4 ] || {
  echo "refusing to replace an incomplete existing release quartet" >&2
  exit 1
}
TRANSACTION="$(mktemp -d "$OUTPUT/.runtime-raiders-transaction.XXXXXX")"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$TRANSACTION/new-runtime-raiders-agent.zip"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" "$TRANSACTION/new-runtime-raiders-agent.zip.sha256"
cp "$STAGED_OUTPUT/install.sh" "$TRANSACTION/new-install.sh"
cp "$STAGED_OUTPUT/runtime-raiders-agent.update.json" "$TRANSACTION/new-runtime-raiders-agent.update.json"
release_transaction_active=1
if [ "$existing_targets" -eq 4 ]; then
  old_zip=1
  mv "$OUTPUT/runtime-raiders-agent.zip" "$TRANSACTION/old-runtime-raiders-agent.zip"
  old_checksum=1
  mv "$OUTPUT/runtime-raiders-agent.zip.sha256" "$TRANSACTION/old-runtime-raiders-agent.zip.sha256"
  old_install=1
  mv "$OUTPUT/install.sh" "$TRANSACTION/old-install.sh"
  old_manifest=1
  mv "$OUTPUT/runtime-raiders-agent.update.json" "$TRANSACTION/old-runtime-raiders-agent.update.json"
fi
placed_zip=1
mv "$TRANSACTION/new-runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip"
placed_checksum=1
mv "$TRANSACTION/new-runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256"
placed_install=1
mv "$TRANSACTION/new-install.sh" "$OUTPUT/install.sh"
placed_manifest=1
mv "$TRANSACTION/new-runtime-raiders-agent.update.json" "$OUTPUT/runtime-raiders-agent.update.json"
release_transaction_committed=1
echo "Built notarized artifact at $OUTPUT/runtime-raiders-agent.zip (publication is manual)."
