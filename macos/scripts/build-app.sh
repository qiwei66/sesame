#!/bin/bash
# Build macos/build/Sesame.app from the Swift package.
#   SESAME_SIGN_IDENTITY  codesign identity; unset = ad-hoc ("-"). Microphone / speech recognition (push-to-talk) are
#                         asked at first use; with ad-hoc signing a rebuilt app may be asked again.
#   SESAME_BUNDLE_ID      default io.github.sesame.app (placeholder)
#   SESAME_CONFIG         release (default) | debug
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${SESAME_CONFIG:-release}"
BUNDLE_ID="${SESAME_BUNDLE_ID:-io.github.sesame.app}"
IDENTITY="${SESAME_SIGN_IDENTITY:--}"
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo 0.1.0)"
OUT="$HERE/build"
APP="$OUT/Sesame.app"
ICONSET_SRC="$HERE/../design/logo/final/AppIcon.appiconset"

swift build --package-path "$HERE" -c "$CONFIG" ${SESAME_SWIFT_FLAGS:-}
BIN="$(swift build --package-path "$HERE" -c "$CONFIG" ${SESAME_SWIFT_FLAGS:-} --show-bin-path)/Sesame"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Sesame"
for l in en zh-Hans; do
  mkdir -p "$APP/Contents/Resources/$l.lproj"
  cp "$HERE/Resources/$l.lproj/Localizable.strings" "$APP/Contents/Resources/$l.lproj/"
  # permission prompt text (NSMicrophoneUsageDescription / NSSpeechRecognitionUsageDescription), per language
  [ -f "$HERE/Resources/$l.lproj/InfoPlist.strings" ] && cp "$HERE/Resources/$l.lproj/InfoPlist.strings" "$APP/Contents/Resources/$l.lproj/"
done

# AppIcon.appiconset already uses iconset file names (icon_16x16.png …); iconutil wants a *.iconset dir
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/AppIcon.iconset"
cp "$ICONSET_SRC"/icon_*.png "$TMP/AppIcon.iconset/"
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Sesame</string>
  <key>CFBundleDisplayName</key><string>Sesame</string>
  <key>CFBundleExecutable</key><string>Sesame</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string></array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Sesame uses the microphone to hear this one sentence. It listens only while you hold the keys and stops when you let go.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Sesame uses the microphone to hear this one sentence. It listens only while you hold the keys and stops when you let go.</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
echo "[build-app] ok: $APP ($(codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Signature|Authority)=' | head -2 | tr '\n' ' '))"
