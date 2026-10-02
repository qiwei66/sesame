#!/bin/bash
# Screenshot every panel state in demo mode, light + dark, window only (screencapture -l, no clicks or keys).
#   macos/scripts/shoot.sh <out-dir> [states…]     default states: 1 2 3 5 6 7 8 0 4 4s h t1 t2 t3 v m s
# Needs Screen Recording permission for the terminal that runs it.
# Demo windows never take the keyboard or activate Sesame (CLAUDE.md invariant 13): you can keep typing meanwhile.
# State 9 (the status menu) is the exception — an open menu takes keystrokes — so it is not in the default list and
# runs only when named, with --allow-menu.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?out dir}"; shift || true
if [ $# -gt 0 ]; then STATES=("$@"); else STATES=(1 2 3 5 6 7 8 0 4 4s h t1 t2 t3 v m s); fi
BIN="$HERE/build/Sesame.app/Contents/MacOS/Sesame"
mkdir -p "$OUT"
for theme in light dark; do
  for s in "${STATES[@]}"; do
    lang=zh-Hans; [ "$s" = 8 ] && lang=en
    log="$OUT/.demo-$s-$theme.log"
    extra=(); [ "$s" = 9 ] && extra=(--allow-menu) && echo "[shoot] state 9 opens the status menu: it takes keystrokes for ~3 s"
    "$BIN" --demo "$s" "--$theme" --lang "$lang" --quit-after 5 ${extra[@]+"${extra[@]}"} >"$log" 2>/dev/null &
    pid=$!
    for _ in $(seq 1 40); do grep -q 'window=' "$log" && break; sleep 0.1; done
    sleep 0.3
    if [ "$s" = 9 ]; then
      # the menu window: the one with a non-zero layer and the largest height
      wid=$(grep 'window=' "$log" | grep -v 'layer=25 ' | sed -n 's/.*window=\([0-9]*\) layer=\([0-9]*\).*/\1 \2/p' | awk '$2>25{print $1}' | tail -1)
    else
      wid=$(sed -n 's/.*window=\([0-9]*\).*/\1/p' "$log" | head -1)
    fi
    if [ -n "${wid:-}" ]; then
      # remove the old picture first: a failed capture must not leave last run's image looking current
      rm -f "$OUT/$s-$theme.png"
      if screencapture -x -o -l "$wid" "$OUT/$s-$theme.png" && [ -s "$OUT/$s-$theme.png" ]; then echo "[shoot] $s-$theme -> window $wid"
      else echo "[shoot] $s-$theme: capture FAILED (window $wid)"; fi
    else
      echo "[shoot] $s-$theme: no window id"; cat "$log"
    fi
    wait "$pid" 2>/dev/null || true
  done
done
