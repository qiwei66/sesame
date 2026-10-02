#!/usr/bin/env python3
"""Sesame logo v2: four refinements of the seed direction.

Writes <variant>/{app-icon,menubar,wordmark}.svg, variants.json and board.html next to this file.
The seed geometry is shared: a flat teardrop (pointed tip, round base) with a fine lengthwise ridge.
"""
import json, math, pathlib

HERE = pathlib.Path(__file__).resolve().parent

def squircle(cx, cy, r, n=5.0, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f"{cx + r * math.copysign(abs(c) ** (2 / n), c):.2f},{cy + r * math.copysign(abs(s) ** (2 / n), s):.2f}")
    return "M" + " L".join(pts) + " Z"

def seed(cx, cy, w, h):
    """Flat teardrop, tip up. The tip keeps a small but real point; the base is a full round."""
    t, b, hw = cy - h / 2, cy + h / 2, w / 2
    return (f"M{cx:.2f},{t:.2f} "
            f"C{cx + hw * 0.30:.2f},{t + h * 0.03:.2f} {cx + hw:.2f},{t + h * 0.26:.2f} {cx + hw:.2f},{t + h * 0.60:.2f} "
            f"C{cx + hw:.2f},{b - h * 0.16:.2f} {cx + hw * 0.56:.2f},{b:.2f} {cx:.2f},{b:.2f} "
            f"C{cx - hw * 0.56:.2f},{b:.2f} {cx - hw:.2f},{b - h * 0.16:.2f} {cx - hw:.2f},{t + h * 0.60:.2f} "
            f"C{cx - hw:.2f},{t + h * 0.26:.2f} {cx - hw * 0.30:.2f},{t + h * 0.03:.2f} {cx:.2f},{t:.2f} Z")

def ridge(cx, cy, h, width, start=0.20, end=0.86):
    """Lengthwise ridge as a thin lens (filled, never stroked), widest a little below the middle."""
    t = cy - h / 2
    y0, y1 = t + h * start, t + h * end
    ym = y0 + (y1 - y0) * 0.56
    hw = width / 2
    return (f"M{cx:.2f},{y0:.2f} C{cx + hw:.2f},{y0 + (ym - y0) * 0.5:.2f} {cx + hw:.2f},{ym:.2f} {cx + hw * 0.9:.2f},{ym:.2f} "
            f"C{cx + hw * 0.9:.2f},{ym + (y1 - ym) * 0.6:.2f} {cx + hw * 0.3:.2f},{y1:.2f} {cx:.2f},{y1:.2f} "
            f"C{cx - hw * 0.3:.2f},{y1:.2f} {cx - hw * 0.9:.2f},{ym + (y1 - ym) * 0.6:.2f} {cx - hw * 0.9:.2f},{ym:.2f} "
            f"C{cx - hw:.2f},{ym:.2f} {cx - hw:.2f},{y0 + (ym - y0) * 0.5:.2f} {cx:.2f},{y0:.2f} Z")

BODY = squircle(512, 512, 412)
TILT = -14
SW, SH = 368, 560          # seed size on the 1024 icon canvas
ROT = f"rotate({TILT} 512 512)"

def drop(id_, dy, blur, op):
    return (f'<filter id="{id_}" x="-40%" y="-40%" width="180%" height="190%"><feGaussianBlur in="SourceAlpha" stdDeviation="{blur}"/>'
            f'<feOffset dy="{dy}"/><feComponentTransfer><feFuncA type="linear" slope="{op}"/></feComponentTransfer>'
            f'<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>')

def icon(defs, tile, body):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    {drop("tileDrop", 12, 14, .28)}
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>
    {defs}
  </defs>
  <g filter="url(#tileDrop)"><path d="{BODY}" fill="{tile}"/><path d="{BODY}" fill="none" stroke="url(#rim)" stroke-width="3"/></g>
  <g transform="{ROT}">{body}</g>
</svg>
"""

def menubar(gap):
    s = seed(9, 9.1, 10.6, 16.2)
    r = ridge(9, 9.1, 16.2, gap)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <!-- macOS template image: black + alpha only. Silhouette with the ridge cut out. -->
  <path d="{s} {r}" fill="#000" fill-rule="evenodd" transform="rotate({TILT} 9 9)"/>
</svg>
"""

def wordmark(weight):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="560" height="160" viewBox="0 0 560 160">
  <text x="0" y="112" font-family="SF Pro Rounded, ui-rounded, -apple-system, sans-serif" font-weight="{weight}" font-size="112" letter-spacing="-1" fill="#1C1C20">sesame</text>
</svg>
"""

S = seed(512, 512, SW, SH)
R_THIN = ridge(512, 512, SH, 14)
R_GAP = ridge(512, 512, SH, 30)
PORCELAIN = ('<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FCFBFA"/>'
             '<stop offset="1" stop-color="#E4E2DF"/></linearGradient>')
BLACK = ('<linearGradient id="seed" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#4C4744"/>'
         '<stop offset=".5" stop-color="#1F1C1A"/><stop offset="1" stop-color="#0D0B0A"/></linearGradient>'
         '<radialGradient id="spec" cx=".40" cy=".34" r=".5" gradientTransform="translate(.4 .34) scale(.42 1) translate(-.4 -.34)">'
         '<stop offset="0" stop-color="#fff" stop-opacity=".50"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>')

V = {}

V["1-real"] = dict(
    name="写实修形", en="True seed",
    meaning="真实的黑芝麻：一头尖、一头圆，一条细棱线就是它的名片。",
    menubar_gap=1.3, word=600,
    icon=icon(PORCELAIN + BLACK + drop("lift", 22, 26, .32) +
              '<linearGradient id="ridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".05"/>'
              '<stop offset=".5" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity=".04"/></linearGradient>',
              "url(#tile)",
              f'<g filter="url(#lift)"><path d="{S}" fill="url(#seed)"/></g>'
              f'<path d="{S}" fill="url(#spec)"/><path d="{R_THIN}" fill="url(#ridge)"/>'),
)

V["2-seam-light"] = dict(
    name="门缝芝麻", en="Open seam",
    meaning="芝麻沿棱线裂开一道缝，里面透出暖光：种子在开，门也在开。",
    menubar_gap=2.0, word=600,
    icon=icon(PORCELAIN + BLACK + drop("lift", 22, 26, .32) +
              '<linearGradient id="light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE7C7"/>'
              '<stop offset=".55" stop-color="#FFB46B"/><stop offset="1" stop-color="#F07A3A"/></linearGradient>'
              '<filter id="bloom" x="-200%" y="-20%" width="500%" height="140%"><feGaussianBlur stdDeviation="16"/></filter>'
              f'<clipPath id="inSeed"><path d="{S}"/></clipPath>',
              "url(#tile)",
              f'<g filter="url(#lift)"><path d="{S}" fill="url(#seed)"/></g>'
              f'<path d="{S}" fill="url(#spec)"/>'
              f'<g clip-path="url(#inSeed)"><path d="{R_GAP}" fill="#FFB06A" opacity=".75" filter="url(#bloom)"/></g>'
              f'<path d="{R_GAP}" fill="url(#light)"/>'),
)

V["3-white"] = dict(
    name="白芝麻", en="Ivory seed",
    meaning="一粒象牙白的芝麻放在朱红上：柔和、温暖，像一块芝麻糖。",
    menubar_gap=1.3, word=600,
    icon=icon('<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D94A2C"/><stop offset="1" stop-color="#9E2914"/></linearGradient>'
              '<linearGradient id="seed" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#FFFDF8"/><stop offset=".6" stop-color="#F4EADB"/><stop offset="1" stop-color="#E2D2BC"/></linearGradient>'
              '<linearGradient id="ridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8A6A4A" stop-opacity=".05"/><stop offset=".5" stop-color="#8A6A4A" stop-opacity=".32"/><stop offset="1" stop-color="#8A6A4A" stop-opacity=".05"/></linearGradient>'
              + drop("lift", 22, 24, .38),
              "url(#tile)",
              f'<g filter="url(#lift)"><path d="{S}" fill="url(#seed)"/></g><path d="{R_THIN}" fill="url(#ridge)"/>'),
)

# 4. my pick: the ivory seed opening at night. Combines the softness of 3 with the story of 2,
#    and the dark tile lets the light carry at 16px where a thin seam on porcelain disappears.
V["4-night-open"] = dict(
    name="夜里开的门", en="Night seam",
    meaning="深色底上一粒白芝麻裂开一线光：夜里亮起的那扇门，16px 也认得出。",
    menubar_gap=2.0, word=600,
    icon=icon('<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E2B33"/><stop offset="1" stop-color="#121116"/></linearGradient>'
              '<linearGradient id="seed" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#FFFDF8"/><stop offset=".6" stop-color="#F1E6D6"/><stop offset="1" stop-color="#D9C7AE"/></linearGradient>'
              '<linearGradient id="light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD9A8"/><stop offset=".55" stop-color="#FF9A4E"/><stop offset="1" stop-color="#E5552C"/></linearGradient>'
              '<filter id="bloom" x="-60%" y="-30%" width="220%" height="160%"><feGaussianBlur stdDeviation="40"/></filter>'
              + drop("lift", 18, 22, .55),
              "url(#tile)",
              f'<path d="{S}" fill="#FF9A55" opacity=".28" filter="url(#bloom)"/>'
              f'<g filter="url(#lift)"><path d="{S} {R_GAP}" fill="url(#seed)" fill-rule="evenodd"/></g>'
              f'<path d="{R_GAP}" fill="url(#light)"/>'),
)

def board():
    cols = []
    for k, v in V.items():
        cols.append(f"""
  <section class="dir">
    <div class="hero"><img src="{k}/app-icon.svg" alt=""></div>
    <div class="sizes"><img class="s128" src="{k}/app-icon.svg" alt=""><img class="s32" src="{k}/app-icon.svg" alt=""><img class="s16" src="{k}/app-icon.svg" alt=""><span class="lbl">128 / 32 / 16 pt</span></div>
    <div class="bars">
      <div class="bar light"><img src="{k}/menubar.svg" alt=""><span>21:14</span></div>
      <div class="bar dark"><img src="{k}/menubar.svg" alt=""><span>21:14</span></div>
    </div>
    <div class="lockup"><img src="{k}/app-icon.svg" alt=""><span class="word">sesame</span></div>
    <h2>{v['name']}<span>{v['en']}</span></h2>
    <p>{v['meaning']}</p>
  </section>""")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Sesame Seed Board</title>
<style>
@font-face {{ font-family: "SesameRounded"; src: url("file:///System/Library/Fonts/SFNSRounded.ttf"); font-weight: 100 900; }}
:root {{ --bg: #F4F4F6; --card: #FFFFFF; --t1: #1C1C20; --t2: #55555E; --t3: #8A8A93; --hair: rgba(28,28,40,.08); }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; width: 1600px; height: 900px; background: var(--bg); font-family: -apple-system, "PingFang SC", sans-serif; color: var(--t1); -webkit-font-smoothing: antialiased; }}
header {{ padding: 40px 56px 0; display: flex; align-items: baseline; gap: 14px; }}
header h1 {{ margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }}
header span {{ font-size: 14px; color: var(--t3); }}
main {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 28px 56px 0; }}
.dir {{ background: var(--card); border-radius: 24px; box-shadow: 0 0 0 0.5px var(--hair), 0 10px 30px -18px rgba(30,30,60,.25); padding: 28px 26px 26px; display: flex; flex-direction: column; }}
.hero {{ height: 250px; display: grid; place-items: center; }}
.hero img {{ width: 230px; height: 230px; }}
.sizes {{ display: flex; align-items: flex-end; gap: 14px; height: 140px; padding-top: 6px; border-top: 0.5px solid var(--hair); position: relative; }}
.s128 {{ width: 128px; height: 128px; }} .s32 {{ width: 32px; height: 32px; margin-bottom: 4px; }} .s16 {{ width: 16px; height: 16px; margin-bottom: 4px; }}
.sizes .lbl {{ position: absolute; right: 0; bottom: 4px; font-size: 11px; color: var(--t3); }}
.bars {{ display: grid; gap: 8px; margin-top: 18px; }}
.bar {{ height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 0 12px; font-size: 13px; }}
.bar img {{ width: 18px; height: 18px; }}
.bar.light {{ background: linear-gradient(90deg, #DCE5F3, #F1E4DD); color: rgba(0,0,0,.85); }} .bar.light img {{ opacity: .85; }}
.bar.dark {{ background: linear-gradient(90deg, #151A30, #2A1B28); color: rgba(255,255,255,.92); }} .bar.dark img {{ filter: invert(1); opacity: .92; }}
.lockup {{ margin-top: 24px; display: flex; align-items: center; gap: 12px; }}
.lockup img {{ width: 52px; height: 52px; }}
.word {{ font-family: "SesameRounded", ui-rounded, sans-serif; font-weight: 600; font-size: 40px; letter-spacing: -0.008em; line-height: 1; }}
h2 {{ margin: 22px 0 0; font-size: 16px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }}
h2 span {{ font-size: 13px; font-weight: 400; color: var(--t3); }}
p {{ margin: 6px 0 0; font-size: 13.5px; line-height: 1.55; color: var(--t2); }}
</style></head><body>
<header><h1>Sesame 芝麻方向的四个变体</h1><span>每个变体包含 App 图标、缩放、菜单栏模板图标（浅色与深色菜单栏）、图形加字标</span></header>
<main>{''.join(cols)}
</main></body></html>"""

if __name__ == "__main__":
    for k, v in V.items():
        d = HERE / k; d.mkdir(parents=True, exist_ok=True)
        (d / "app-icon.svg").write_text(v["icon"])
        (d / "menubar.svg").write_text(menubar(v["menubar_gap"]))
        (d / "wordmark.svg").write_text(wordmark(v["word"]))
    (HERE / "variants.json").write_text(json.dumps({k: {x: v[x] for x in ("name", "en", "meaning", "word")} for k, v in V.items()}, ensure_ascii=False, indent=2))
    (HERE / "board.html").write_text(board())
    print("ok", list(V))
