#!/bin/bash
# Put the GitHub Pages site together in one folder: site/ as is, the app shots from docs/assets (kept in one place,
# the README uses them too), and a zh/ copy of the page whose head is Chinese (link cards in Chinese apps).
#   bash site/assemble.sh [out-dir]     default: _site at the repo root
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"
rm -rf "$OUT"
mkdir -p "$OUT/assets" "$OUT/media" "$OUT/zh"
cp "$ROOT/site/index.html" "$ROOT/site/style.css" "$ROOT/site/app.js" "$OUT/"
cp "$ROOT/site/media/"*.mp4 "$ROOT/site/media/"*.jpg "$OUT/media/"
cp "$ROOT/docs/assets/sesame-icon.png" "$OUT/assets/"
for shot in hero-firstrun voice typing pick; do
  for l in zh en; do for t in light dark; do cp "$ROOT/docs/assets/$shot-$l-$t.gif" "$OUT/assets/"; done; done
done
for l in zh en; do for t in light dark; do cp "$ROOT/docs/assets/share-$l-$t.png" "$OUT/assets/"; done; done
touch "$OUT/.nojekyll"
python3 - "$OUT/index.html" "$OUT/zh/index.html" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
n = 0
def swap(m):
    global n
    n += 1
    tag, zh = m.group(0), m.group(1)
    attr = 'href' if tag.startswith('<link') else 'content'
    tag = re.sub(r'\s*data-zh="[^"]*"', '', tag)
    return re.sub(attr + r'="[^"]*"', attr + '="' + zh + '"', tag, count=1)
s = re.sub(r'<(?:meta|link)\b[^>]*\bdata-zh="([^"]*)"[^>]*>', swap, s)
t = re.search(r'(<title data-zh="([^"]*)"[^>]*>)[^<]*</title>', s)
s = s.replace(t.group(0), t.group(1) + t.group(2) + '</title>')
s = s.replace('<html lang="en" data-lang="en">', '<html lang="zh-CN" data-lang="zh" data-default-lang="zh">', 1)
s = s.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<base href="../">', 1)
assert n >= 10, n
open(dst, 'w', encoding='utf-8').write(s)
print('zh/index.html: %d head tags in Chinese' % n)
PY
echo "assembled: $OUT ($(du -sh "$OUT" | cut -f1))"
