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
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT HUP INT TERM
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
codesign --verify --strict --verbose=2 "$APP"
NOTARY_ZIP="$WORK/notary.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$NOTARY_ZIP"
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$RUNTIME_RAIDERS_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --strict --verbose=2 "$APP"
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
if [ -e "$OUTPUT/runtime-raiders-agent.zip" ] || [ -e "$OUTPUT/runtime-raiders-agent.zip.sha256" ]; then
  [ -f "$OUTPUT/runtime-raiders-agent.zip" ] && [ -f "$OUTPUT/runtime-raiders-agent.zip.sha256" ] || {
    echo "refusing to replace an unmatched existing release pair" >&2
    exit 1
  }
  mv "$OUTPUT/runtime-raiders-agent.zip" "$WORK/old-runtime-raiders-agent.zip"
  mv "$OUTPUT/runtime-raiders-agent.zip.sha256" "$WORK/old-runtime-raiders-agent.zip.sha256"
  [ -f "$OUTPUT/install.sh" ] && mv "$OUTPUT/install.sh" "$WORK/old-install.sh"
fi
if ! mv "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip" ||
   ! mv "$STAGED_OUTPUT/runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256" ||
   ! mv "$STAGED_OUTPUT/install.sh" "$OUTPUT/install.sh"; then
  rm -f "$OUTPUT/runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip.sha256" "$OUTPUT/install.sh"
  [ -f "$WORK/old-runtime-raiders-agent.zip" ] && mv "$WORK/old-runtime-raiders-agent.zip" "$OUTPUT/runtime-raiders-agent.zip"
  [ -f "$WORK/old-runtime-raiders-agent.zip.sha256" ] && mv "$WORK/old-runtime-raiders-agent.zip.sha256" "$OUTPUT/runtime-raiders-agent.zip.sha256"
  [ -f "$WORK/old-install.sh" ] && mv "$WORK/old-install.sh" "$OUTPUT/install.sh"
  echo "release output replacement failed; previous pair restored" >&2
  exit 1
fi
echo "Built notarized artifact at $OUTPUT/runtime-raiders-agent.zip (publication is manual)."
