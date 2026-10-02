#!/bin/bash
# 验证「重新编译后辅助功能授权保持」：先确认当前已授权 → 重新编译签名安装 → 重启 → 看新进程的 accessibility_trusted
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/logs/va-autoenter.log"
last_trust() { grep "accessibility_trusted=" "$LOG" | tail -1; }
echo "== 重编译前：$(last_trust)"
echo "== 重编译前 cdhash：$(codesign -dvvv "$ROOT/bin/VA AutoEnter.app" 2>&1 | grep -m1 CDHash)"
bash "$ROOT/scripts/build-autoenter.sh"
sleep 3
echo "== 重编译后 cdhash：$(codesign -dvvv "$ROOT/bin/VA AutoEnter.app" 2>&1 | grep -m1 CDHash)（应与上面不同）"
codesign -d -r- "$ROOT/bin/VA AutoEnter.app" 2>&1 | grep designated
L="$(grep 'va-autoenter started' "$LOG" | tail -1)"
echo "== 重编译后新进程：$L"
if grep -q "accessibility_trusted=true" <<<"$L"; then echo "PASS：重编译后授权保持"; else echo "FAIL：重编译后授权丢失"; exit 1; fi
