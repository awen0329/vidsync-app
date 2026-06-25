#!/usr/bin/env bash
# build-release-darwin.sh — one-shot macOS release build of the Vidsync app:
# wails build → stage helper binaries → codesign (Developer ID, Hardened
# Runtime) → notarize → staple → .dmg. The macOS counterpart of
# build-release.ps1. RUN THIS ON A MAC (Wails can only build a darwin .app on
# macOS, with Xcode command-line tools installed).
#
# This produces the recommended DIRECT-distribution artifact: a notarized,
# Gatekeeper-clean .dmg you host yourself. For the Mac App Store path (App
# Sandbox, entitlements.mas.plist) see STORE_PUBLISHING.md — it needs extra
# work and is not what this script builds.
#
# Configure via environment variables (all optional — unset = unsigned local
# build, which is fine for smoke-testing but NOT for distribution):
#   VERSION         release version, leading "v" (default v0.0.1)
#   SIGN_IDENTITY   "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE  notarytool keychain profile name, created once with:
#                     xcrun notarytool store-credentials NOTARY_PROFILE \
#                       --apple-id you@example.com --team-id TEAMID --password <app-specific-pw>
#
# Usage:
#   ./build-release-darwin.sh
#   VERSION=v0.2.0 SIGN_IDENTITY="Developer ID Application: …" NOTARY_PROFILE=vidsync ./build-release-darwin.sh
set -euo pipefail

VERSION="${VERSION:-v0.0.1}"
SIGN_IDENTITY="${SIGN_IDENTITY:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$REPO/cmd/vidsync"
ENTITLEMENTS="$APP_DIR/build/darwin/entitlements.devid.plist"

# Keep the daemon version regex happy and the product metadata in sync, the
# same contract build-release.ps1 enforces: VERSION drives lib/build.Version
# (needs leading v) and wails.json productVersion (plain semver).
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "VERSION '$VERSION' must look like vMAJOR.MINOR.PATCH" >&2; exit 1; }
SEMVER="${VERSION#v}"; SEMVER="${SEMVER%%[-+]*}"
# Patch wails.json productVersion in place (BSD sed: -i needs a backup suffix).
sed -i '' -E "s/(\"productVersion\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$SEMVER\2/" "$APP_DIR/wails.json"
echo "Version: $VERSION (daemon)  /  $SEMVER (product)"

echo "=== Step 1/4: wails build ==="
LDFLAGS="-X github.com/CrownLedger/vidsync/lib/build.Version=$VERSION"
( cd "$APP_DIR" && wails build -platform darwin/universal -ldflags "$LDFLAGS" )

APP="$APP_DIR/build/bin/Vidsync.app"
[[ -d "$APP" ]] || { echo "expected $APP — did wails build succeed?" >&2; exit 1; }
MACOS_DIR="$APP/Contents/MacOS"

echo "=== Step 2/4: stage helper binaries ==="
# The app finds ffmpeg/braw-thumb next to its executable (Contents/MacOS),
# mirroring the Windows layout. Mac builds of these are staged by hand under
# third_party/*/darwin (see each dir's README). Optional: if absent, those
# thumbnail paths just fall back to a glyph.
FF_SRC="$REPO/third_party/ffmpeg/darwin/ffmpeg"
if [[ -f "$FF_SRC" ]]; then
  cp "$FF_SRC" "$MACOS_DIR/ffmpeg"; chmod +x "$MACOS_DIR/ffmpeg"
  echo "  staged ffmpeg"
else
  echo "  WARN: $FF_SRC missing — video thumbnails unavailable in this build"
fi
BRAW_SRC="$REPO/third_party/braw/mac"
if [[ -d "$BRAW_SRC" && -f "$BRAW_SRC/braw-thumb" ]]; then
  mkdir -p "$MACOS_DIR/braw"; cp -R "$BRAW_SRC/." "$MACOS_DIR/braw/"; chmod +x "$MACOS_DIR/braw/braw-thumb"
  echo "  staged braw-thumb + SDK"
else
  echo "  WARN: $BRAW_SRC/braw-thumb missing — .braw thumbnails unavailable"
fi

if [[ -z "$SIGN_IDENTITY" ]]; then
  echo "=== Steps 3-4 SKIPPED: SIGN_IDENTITY unset (unsigned local build) ==="
  echo "Unsigned app at: $APP"
  exit 0
fi

echo "=== Step 3/4: codesign (inside-out, Hardened Runtime) ==="
# Sign nested binaries/dylibs first, then the app bundle last — codesign
# validates inner code, so a --deep pass on the outside is unreliable.
while IFS= read -r -d '' f; do
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$f"
done < <(find "$MACOS_DIR" -type f ! -path "*/Contents/MacOS/Vidsync" \
           \( -name "*.dylib" -o -name "ffmpeg" -o -name "braw-thumb" -o -perm -111 \) -print0)
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "=== Step 4/4: package .dmg + notarize ==="
DIST="$REPO/dist"; mkdir -p "$DIST"
DMG="$DIST/Vidsync-$VERSION.dmg"; rm -f "$DMG"
if command -v create-dmg >/dev/null 2>&1; then
  create-dmg --volname "Vidsync" --app-drop-link 420 200 --icon "Vidsync.app" 140 200 \
    --window-size 600 360 "$DMG" "$APP" || true
else
  # Zero-dependency fallback: a plain read-only DMG (no fancy layout).
  hdiutil create -volname "Vidsync" -srcfolder "$APP" -ov -format UDZO "$DMG"
fi

if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  echo "Notarized + stapled: $DMG"
else
  echo "WARN: NOTARY_PROFILE unset — DMG is signed but NOT notarized."
  echo "Signed (un-notarized) DMG: $DMG"
fi
