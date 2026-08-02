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
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = '--output' ] || {
    echo "usage: $0 [--output directory]" >&2
    exit 64
  }
  OUTPUT="$2"
fi
TEMP_ROOT=/tmp
[ -n "$TMPDIR" ] && TEMP_ROOT="$TMPDIR"
WORK="$(mktemp -d "$TEMP_ROOT/runtime-raiders-release.XXXXXX")"
TRANSACTION=''
release_transaction_active=0
release_transaction_committed=0
old_zip=0
old_checksum=0
old_install=0
placed_zip=0
placed_checksum=0
placed_install=0
rollback_release() {
  [ "$release_transaction_active" -eq 1 ] && [ "$release_transaction_committed" -eq 0 ] || return 0
  release_transaction_active=0
  [ "$placed_zip" -eq 0 ] || rm -f "$OUTPUT/runtime-raiders-agent.zip"
  [ "$placed_checksum" -eq 0 ] || rm -f "$OUTPUT/runtime-raiders-agent.zip.sha256"
  [ "$placed_install" -eq 0 ] || rm -f "$OUTPUT/install.sh"
  [ "$old_zip" -eq 0 ] || [ ! -f "$TRANSACTION/old-runtime-raiders-agent.zip" ] || /bin/mv "$TRANSACTION/old-runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip"
  [ "$old_checksum" -eq 0 ] || [ ! -f "$TRANSACTION/old-runtime-raiders-agent.zip.sha256" ] || /bin/mv "$TRANSACTION/old-runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256"
  [ "$old_install" -eq 0 ] || [ ! -f "$TRANSACTION/old-install.sh" ] || /bin/mv "$TRANSACTION/old-install.sh" "$OUTPUT/install.sh"
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
  (cd "$ROOT/companion" && swift build -c release --arch "$arch" --product raiders)
  cp "$ROOT/companion/.build/$arch-apple-macosx/release/raiders" "$WORK/raiders-$arch"
done
lipo -create "$WORK/raiders-arm64" "$WORK/raiders-x86_64" -output "$WORK/runtime-raiders-agent"
APP="$WORK/Runtime Raiders Agent.app"
mkdir -p "$APP/Contents/MacOS"
mv "$WORK/runtime-raiders-agent" "$APP/Contents/MacOS/runtime-raiders-agent"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>runtime-raiders-agent</string>
<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>
<key>CFBundleName</key><string>Runtime Raiders Agent</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
codesign --force --options runtime --timestamp --sign "$RUNTIME_RAIDERS_CODESIGN_IDENTITY" "$APP"
codesign --verify --strict --verbose=2 -R="$REQUIREMENT" "$APP"
NOTARY_ZIP="$WORK/notary.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --strict --verbose=2 -R="$REQUIREMENT" "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$STAGED_OUTPUT/runtime-raiders-agent.zip"
(cd "$STAGED_OUTPUT" && shasum -a 256 runtime-raiders-agent.zip > runtime-raiders-agent.zip.sha256)
[ -s "$STAGED_OUTPUT/runtime-raiders-agent.zip" ] && [ -s "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" ] || {
  echo "release archive checksum staging failed" >&2
  exit 1
}
sed "s/__RUNTIME_RAIDERS_TEAM_ID__/$RUNTIME_RAIDERS_TEAM_ID/g" "$ROOT/companion/packaging/install.sh" > "$STAGED_OUTPUT/install.sh"
chmod 755 "$STAGED_OUTPUT/install.sh"
grep -F '__RUNTIME_RAIDERS_TEAM_ID__' "$STAGED_OUTPUT/install.sh" >/dev/null && {
  echo "release installer Team ID rendering failed" >&2
  exit 1
}
mkdir -p "$OUTPUT"
for target in "$OUTPUT/runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip.sha256" "$OUTPUT/install.sh"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] || {
      echo "refusing unsafe existing release target: $target" >&2
      exit 1
    }
  fi
done
if [ -e "$OUTPUT/runtime-raiders-agent.zip" ] || [ -e "$OUTPUT/runtime-raiders-agent.zip.sha256" ]; then
  [ -f "$OUTPUT/runtime-raiders-agent.zip" ] && [ -f "$OUTPUT/runtime-raiders-agent.zip.sha256" ] || {
    echo "refusing to replace an unmatched existing release pair" >&2
    exit 1
  }
fi
TRANSACTION="$(mktemp -d "$OUTPUT/.runtime-raiders-transaction.XXXXXX")"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$TRANSACTION/new-runtime-raiders-agent.zip"
cp "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" "$TRANSACTION/new-runtime-raiders-agent.zip.sha256"
cp "$STAGED_OUTPUT/install.sh" "$TRANSACTION/new-install.sh"
release_transaction_active=1
if [ -f "$OUTPUT/runtime-raiders-agent.zip" ]; then
  old_zip=1
  mv "$OUTPUT/runtime-raiders-agent.zip" "$TRANSACTION/old-runtime-raiders-agent.zip"
  old_checksum=1
  mv "$OUTPUT/runtime-raiders-agent.zip.sha256" "$TRANSACTION/old-runtime-raiders-agent.zip.sha256"
fi
if [ -f "$OUTPUT/install.sh" ]; then
  old_install=1
  mv "$OUTPUT/install.sh" "$TRANSACTION/old-install.sh"
fi
placed_zip=1
mv "$TRANSACTION/new-runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip"
placed_checksum=1
mv "$TRANSACTION/new-runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256"
placed_install=1
mv "$TRANSACTION/new-install.sh" "$OUTPUT/install.sh"
release_transaction_committed=1
echo "Built notarized artifact at $OUTPUT/runtime-raiders-agent.zip (publication is manual)."
