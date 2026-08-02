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
mkdir -p "$OUTPUT"
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
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUTPUT/runtime-raiders-agent.zip"
(cd "$OUTPUT" && shasum -a 256 runtime-raiders-agent.zip > runtime-raiders-agent.zip.sha256)
echo "Built notarized artifact at $OUTPUT/runtime-raiders-agent.zip (publication is manual)."
