#!/usr/bin/env python3
"""Sesame logo v3: slender ivory seed, ridge drawn only with same-colour light and shade.

Writes <variant>/{app-icon,menubar,wordmark}.svg, variants.json and board.html next to this file.
Proportion follows measured sesame seeds (about 2.8 x 1.7 mm, 1.7-2 : 1); here 1.8 : 1.
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
            f"C{cx + hw * 0.12:.2f},{t + h * 0.05:.2f} {cx + hw:.2f},{t + h * 0.30:.2f} {cx + hw:.2f},{t + h * 0.62:.2f} "
            f"C{cx + hw:.2f},{b - h * 0.18:.2f} {cx + hw * 0.56:.2f},{b:.2f} {cx:.2f},{b:.2f} "
            f"C{cx - hw * 0.56:.2f},{b:.2f} {cx - hw:.2f},{b - h * 0.18:.2f} {cx - hw:.2f},{t + h * 0.62:.2f} "
            f"C{cx - hw:.2f},{t + h * 0.30:.2f} {cx - hw * 0.12:.2f},{t + h * 0.05:.2f} {cx:.2f},{t:.2f} Z")

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
TILT = -18
SW, SH = 322, 600          # seed size on the 1024 icon canvas
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
    s = seed(9, 9, 8.9, 16.6)
    r = ridge(9, 9, 16.6, gap)
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
# Emboss: a lit lens on the left of the axis and a shaded lens on the right, same ivory hue family.
RL = ridge(506, 512, SH, 20)
RS = ridge(519, 512, SH, 16)
IVORY = ('<linearGradient id="seed" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#FFFDF9"/>'
         '<stop offset=".55" stop-color="#F3EBDF"/><stop offset="1" stop-color="#DCCDB8"/></linearGradient>'
         '<radialGradient id="vol" cx=".36" cy=".30" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".55"/>'
         '<stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>'
         '<radialGradient id="edge" cx=".5" cy=".5" r=".55"><stop offset=".72" stop-color="#7A6146" stop-opacity="0"/>'
         '<stop offset="1" stop-color="#7A6146" stop-opacity=".28"/></radialGradient>'
         '<linearGradient id="ridgeLit" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>'
         '<stop offset=".45" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
         '<linearGradient id="ridgeShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9C8467" stop-opacity="0"/>'
         '<stop offset=".5" stop-color="#9C8467" stop-opacity=".22"/><stop offset="1" stop-color="#9C8467" stop-opacity="0"/></linearGradient>'
         f'<clipPath id="inSeed"><path d="{S}"/></clipPath>')
GRAPHITE = ('<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34323A"/>'
            '<stop offset="1" stop-color="#141318"/></linearGradient>')
VERMILION = ('<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D94A2C"/>'
             '<stop offset="1" stop-color="#9E2914"/></linearGradient>')

def seed_body(op, with_ridge):
    ridge_svg = (f'<g clip-path="url(#inSeed)"><path d="{RS}" fill="url(#ridgeShade)"/><path d="{RL}" fill="url(#ridgeLit)"/></g>'
                 if with_ridge else '')
    return (f'<g filter="url(#lift)"><path d="{S}" fill="url(#seed)"/></g>'
            f'<path d="{S}" fill="url(#edge)"/><path d="{S}" fill="url(#vol)"/>' + ridge_svg)

V = {}
V["a-graphite-ridge"] = dict(
    name="石墨 · 浮雕棱", en="Graphite, embossed",
    meaning="近黑的底上一粒象牙白芝麻，棱线只靠一侧亮一侧暗隆起来。",
    menubar_gap=1.2, word=600,
    icon=icon(GRAPHITE + IVORY + drop("lift", 18, 22, .55), "url(#tile)", seed_body(.55, True)),
)
V["b-vermilion-ridge"] = dict(
    name="朱红 · 浮雕棱", en="Vermilion, embossed",
    meaning="朱红的底上一粒象牙白芝麻，同样的浮雕棱线，更暖、更像一枚印章。",
    menubar_gap=1.2, word=600,
    icon=icon(VERMILION + IVORY + drop("lift", 20, 22, .40), "url(#tile)", seed_body(.40, True)),
)
V["c-graphite-pure"] = dict(
    name="石墨 · 纯粹", en="Graphite, pure",
    meaning="只留一粒有体积的白芝麻，不画棱线：最安静的版本。",
    menubar_gap=1.2, word=600,
    icon=icon(GRAPHITE + IVORY + drop("lift", 18, 22, .55), "url(#tile)", seed_body(.55, False)),
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
main {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 28px 56px 0; }}
.dir {{ background: var(--card); border-radius: 24px; box-shadow: 0 0 0 0.5px var(--hair), 0 10px 30px -18px rgba(30,30,60,.25); padding: 28px 26px 26px; display: flex; flex-direction: column; }}
.hero {{ height: 250px; display: grid; place-items: center; }}
.hero img {{ width: 250px; height: 250px; }}
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
<header><h1>Sesame 芝麻 v3</h1><span>每个变体包含 App 图标、缩放、菜单栏模板图标（浅色与深色菜单栏）、图形加字标</span></header>
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
