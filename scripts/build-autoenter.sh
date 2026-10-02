#!/bin/bash
# 编译 va-autoenter 并打包成 bin/VA AutoEnter.app（bundle id $VA_BUNDLE_PREFIX.va-autoenter），用固定开发身份签整个 bundle。
# 不变式：
#  - 必须是 .app bundle：TCC 按 bundle id 记录授权（client_type=0）。裸二进制会按「路径」记录（client_type=1），
#    首次授权时的 csreq 会被钉成当时的 cdhash，之后换签名也不会更新 → 新版本永远拿不到授权（2026-10-01 教训）。
#  - 必须用稳定身份签名：designated requirement = 「identifier + 证书」，重编译后授权保持。
#  - 找不到身份直接失败，绝不退回 ad-hoc。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bin/va-env
. "$ROOT/bin/va-env"
# 签名身份：VA_SIGN_IDENTITY（写进 ~/.config/voice-agent/env.sh）；没设就用钥匙串里第一个 Apple Development 身份
IDENTITY="${VA_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)}"
BUNDLE_ID="$VA_BUNDLE_PREFIX.va-autoenter"
APP_NAME="VA AutoEnter.app"
BUILD="$ROOT/autoenter/build"
APP="$BUILD/$APP_NAME"
DEST="$ROOT/bin/$APP_NAME"

if ! security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\""; then
  echo "[build-autoenter] 找不到签名身份「$IDENTITY」（security find-identity -v -p codesigning）。" >&2
  echo "[build-autoenter] 拒绝用 ad-hoc 签名（会让辅助功能授权每次编译都失效）。新电脑请先装开发证书，或设 VA_SIGN_IDENTITY=<身份名>。" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/va-autoenter" "$ROOT/autoenter/main.swift"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>VA AutoEnter</string>
  <key>CFBundleDisplayName</key><string>VA AutoEnter</string>
  <key>CFBundleExecutable</key><string>va-autoenter</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
DR="$(codesign -d -r- "$APP" 2>&1)"
if ! grep -q "identifier \"$BUNDLE_ID\"" <<<"$DR" || grep -q "cdhash" <<<"$DR"; then
  echo "[build-autoenter] 签名要求不对：$DR" >&2
  exit 1
fi
"$APP/Contents/MacOS/va-autoenter" --selftest >/dev/null
if [ "${1:-}" != "--no-install" ]; then
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  if launchctl print "gui/$(id -u)/$BUNDLE_ID" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$BUNDLE_ID"
  fi
  echo "[build-autoenter] ok: $(codesign -d -r- "$DEST" 2>&1 | grep designated)"
else
  echo "[build-autoenter] ok (not installed): $(grep designated <<<"$DR")"
fi
