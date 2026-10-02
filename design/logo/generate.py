#!/usr/bin/env python3
"""Generate the four Sesame logo directions as SVG.

Each direction: app-icon.svg (1024 macOS icon canvas), menubar.svg (18x18 template, black only),
wordmark.svg. Geometry is computed here so the shapes stay exact and editable.
"""
import math, pathlib

OUT = pathlib.Path(__file__).resolve().parent

# ---------- geometry helpers ----------
def squircle(cx, cy, r, n=5.0, steps=240):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + r * math.copysign(abs(c) ** (2 / n), c)
        y = cy + r * math.copysign(abs(s) ** (2 / n), s)
        pts.append(f"{x:.2f},{y:.2f}")
    return "M" + " L".join(pts) + " Z"

def arch(x, y, w, h):
    """Doorway: flat bottom at y+h, semicircular top. (x,y) = top-left of bounding box."""
    r = w / 2
    return (f"M{x:.2f},{y + h:.2f} L{x:.2f},{y + r:.2f} A{r:.2f},{r:.2f} 0 0 1 {x + w:.2f},{y + r:.2f} "
            f"L{x + w:.2f},{y + h:.2f} Z")

def rect(x, y, w, h):
    return f"M{x:.2f},{y:.2f} H{x + w:.2f} V{y + h:.2f} H{x:.2f} Z"

def keyhole(cx, top, R, stem_w_top, stem_w_bot, stem_h):
    """One closed path: a circle on top that flows into a tapered stem."""
    cy = top + R
    # stem attaches where the circle meets the stem half-width
    a = math.asin(stem_w_top / 2 / R)
    xl, xr = cx - stem_w_top / 2, cx + stem_w_top / 2
    yj = cy + R * math.cos(a)
    yb = cy + R + stem_h
    br = 0.18 * stem_w_bot  # rounded bottom corners
    return (f"M{xl:.2f},{yj:.2f} A{R:.2f},{R:.2f} 0 1 1 {xr:.2f},{yj:.2f} "
            f"L{cx + stem_w_bot / 2:.2f},{yb - br:.2f} Q{cx + stem_w_bot / 2:.2f},{yb:.2f} {cx + stem_w_bot / 2 - br:.2f},{yb:.2f} "
            f"L{cx - stem_w_bot / 2 + br:.2f},{yb:.2f} Q{cx - stem_w_bot / 2:.2f},{yb:.2f} {cx - stem_w_bot / 2:.2f},{yb - br:.2f} Z")

def seed(cx, cy, w, h, tilt=-28):
    """Sesame seed: an almond with a softly rounded tip (horizontal tangent at the tip, so it never reads as a water drop)."""
    t, b = cy - h / 2, cy + h / 2
    hw = w / 2
    p = (f"M{cx:.2f},{t:.2f} "
         f"C{cx + hw * 0.34:.2f},{t:.2f} {cx + hw:.2f},{t + h * 0.28:.2f} {cx + hw:.2f},{t + h * 0.60:.2f} "
         f"C{cx + hw:.2f},{b - h * 0.10:.2f} {cx + hw * 0.52:.2f},{b:.2f} {cx:.2f},{b:.2f} "
         f"C{cx - hw * 0.52:.2f},{b:.2f} {cx - hw:.2f},{b - h * 0.10:.2f} {cx - hw:.2f},{t + h * 0.60:.2f} "
         f"C{cx - hw:.2f},{t + h * 0.28:.2f} {cx - hw * 0.34:.2f},{t:.2f} {cx:.2f},{t:.2f} Z")
    return p, f"rotate({tilt} {cx:.2f} {cy:.2f})"

def bubble_arch(x, y, w, h, tail):
    """Speech bubble whose outline is a doorway arch; the tail grows out of the bottom-left corner."""
    r = w / 2
    yb = y + h
    return (f"M{x:.2f},{yb + tail:.2f} L{x:.2f},{y + r:.2f} A{r:.2f},{r:.2f} 0 0 1 {x + w:.2f},{y + r:.2f} "
            f"L{x + w:.2f},{yb - r * 0.18:.2f} Q{x + w:.2f},{yb:.2f} {x + w - r * 0.18:.2f},{yb:.2f} "
            f"L{x + tail * 1.25:.2f},{yb:.2f} Z")

# ---------- app icon shell (macOS 1024 grid: 824 body, 100 margin) ----------
BODY = squircle(512, 512, 412)

def icon(defs, tile_fill, body, tile_extra=""):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/>
      <feComponentTransfer><feFuncA type="linear" slope=".28"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".12"/>
    </linearGradient>
    {defs}
  </defs>
  <g filter="url(#drop)">
    <path d="{BODY}" fill="{tile_fill}"/>
    {tile_extra}
    <path d="{BODY}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  </g>
  {body}
</svg>
"""

def soft_shadow(id_, dy, blur, op):
    return (f'<filter id="{id_}" x="-40%" y="-40%" width="180%" height="190%">'
            f'<feGaussianBlur in="SourceAlpha" stdDeviation="{blur}"/><feOffset dy="{dy}"/>'
            f'<feComponentTransfer><feFuncA type="linear" slope="{op}"/></feComponentTransfer>'
            f'<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>')

def menubar(path, transform="", rule="nonzero"):
    t = f' transform="{transform}"' if transform else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
  <!-- macOS template image: black + alpha only; the system tints it for light and dark menu bars -->
  <path d="{path}" fill="#000" fill-rule="{rule}"{t}/>
</svg>
"""

def wordmark(text, family, weight, tracking, fill="#1C1C20"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="560" height="160" viewBox="0 0 560 160">
  <text x="0" y="112" font-family="{family}" font-weight="{weight}" font-size="112" letter-spacing="{tracking}" fill="{fill}">{text}</text>
</svg>
"""

D = {}

# A. 朱门 Gate ajar: vermilion doorway, an off-centre slit is the gap of the door.
aw, ah = 420, 566
ax, ay = 512 - aw / 2, 512 - ah / 2 + 10
slit_x = ax + aw * 0.62
A_shape = arch(ax, ay, aw, ah) + " " + rect(slit_x, ay + 168, 32, ah - 168)
D["a-gate"] = dict(
    name="朱门", en="Gate ajar",
    meaning="推开一条缝的朱红大门：要找的产物就在门后。",
    icon=icon(
        defs='<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E7E7EC"/></linearGradient>'
             '<linearGradient id="shape" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E5583B"/><stop offset="1" stop-color="#B42E17"/></linearGradient>'
             '<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>'
             + soft_shadow("lift", 18, 22, .30),
        tile_fill="url(#tile)",
        body=f'<g filter="url(#lift)"><path d="{A_shape}" fill="url(#shape)" fill-rule="evenodd"/></g>'
             f'<path d="{A_shape}" fill="url(#gloss)" fill-rule="evenodd"/>'),
    menubar=menubar(arch(4, 1.5, 10, 15) + " " + rect(4 + 10 * 0.6, 6, 1.6, 10.5), rule="evenodd"),
    wordmark=wordmark("Sesame", "SF Pro Display, -apple-system, sans-serif", 600, -1.5),
    word=dict(family="sfd", weight=600, tracking="-0.012em", case="Sesame", label="SF Pro Display Semibold"),
)

# B. 钥匙孔里的光 Keyhole light: a lit keyhole on graphite, the room behind the door is on.
B_shape = keyhole(512, 222, 128, 122, 206, 330)
D["b-keyhole"] = dict(
    name="钥匙孔", en="Keyhole light",
    meaning="门后亮着灯：说出口的那句话就是钥匙。",
    icon=icon(
        defs='<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B3D45"/><stop offset="1" stop-color="#16171B"/></linearGradient>'
             '<radialGradient id="shape" cx=".5" cy=".28" r=".85"><stop offset="0" stop-color="#FFF6E8"/><stop offset=".55" stop-color="#FFC98F"/><stop offset="1" stop-color="#F08A4B"/></radialGradient>'
             '<filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="34"/></filter>',
        tile_fill="url(#tile)",
        body=f'<path d="{B_shape}" fill="#FFB070" opacity=".45" filter="url(#glow)"/>'
             f'<path d="{B_shape}" fill="url(#shape)"/>'),
    menubar=menubar(keyhole(9, 1.5, 4.4, 4.0, 7.0, 7.6)),
    wordmark=wordmark("Sesame", "SF Pro Text, -apple-system, sans-serif", 500, 2),
    word=dict(family="sft", weight=500, tracking="0.02em", case="Sesame", label="SF Pro Text Medium，略放宽字距"),
)

# C. 一粒芝麻 Seed: one glossy black sesame seed on porcelain.
C_shape, C_rot = seed(512, 512, 340, 560, tilt=-30)
c_mb, c_mb_rot = seed(9, 9, 8.6, 15.8, tilt=-30)
D["c-seed"] = dict(
    name="芝麻", en="One seed",
    meaning="一粒芝麻很小，却能开门：小工具，一句话的事。",
    icon=icon(
        defs='<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBFAF8"/><stop offset="1" stop-color="#E6E4E1"/></linearGradient>'
             '<linearGradient id="shape" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#4A4542"/><stop offset=".55" stop-color="#1E1B19"/><stop offset="1" stop-color="#0E0C0B"/></linearGradient>'
             '<radialGradient id="spec" cx=".42" cy=".30" r=".30" gradientTransform="translate(.42 .30) scale(.55 1) translate(-.42 -.30)"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
             + soft_shadow("lift", 22, 26, .32),
        tile_fill="url(#tile)",
        body=f'<g filter="url(#lift)"><path d="{C_shape}" transform="{C_rot}" fill="url(#shape)"/></g>'
             f'<path d="{C_shape}" transform="{C_rot}" fill="url(#spec)"/>'),
    menubar=menubar(c_mb, c_mb_rot),
    wordmark=wordmark("sesame", "SF Pro Rounded, ui-rounded, -apple-system, sans-serif", 600, -1),
    word=dict(family="sfr", weight=600, tracking="-0.008em", case="sesame", label="SF Pro Rounded Semibold，全小写"),
)

# D. 说话的门 Speaking arch: the doorway outline doubles as a speech bubble.
dw, dh = 440, 500
dx, dy = 512 - dw / 2 + 14, 512 - dh / 2 - 22
D_shape = bubble_arch(dx, dy, dw, dh, 92)
D["d-voice-arch"] = dict(
    name="说话的门", en="Speaking arch",
    meaning="门的轮廓就是一个对话气泡：说出来，门就开了。",
    icon=icon(
        defs='<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EE6142"/><stop offset="1" stop-color="#B92F18"/></linearGradient>'
             '<linearGradient id="shape" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F3E9E5"/></linearGradient>'
             + soft_shadow("lift", 18, 22, .30),
        tile_fill="url(#tile)",
        body=f'<g filter="url(#lift)"><path d="{D_shape}" fill="url(#shape)"/></g>'),
    menubar=menubar(bubble_arch(3.6, 1.2, 11, 12.4, 3.6)),
    wordmark=wordmark("Sesame", "SF Pro Display, -apple-system, sans-serif", 700, -2.5),
    word=dict(family="sfd", weight=700, tracking="-0.022em", case="Sesame", label="SF Pro Display Bold，收紧字距"),
)

if __name__ == "__main__":
    import json
    for k, v in D.items():
        d = OUT / k; d.mkdir(parents=True, exist_ok=True)
        (d / "app-icon.svg").write_text(v["icon"])
        (d / "menubar.svg").write_text(v["menubar"])
        (d / "wordmark.svg").write_text(v["wordmark"])
    meta = {k: {kk: v[kk] for kk in ("name", "en", "meaning", "word")} for k, v in D.items()}
    (OUT / "directions.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print("wrote", sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*.svg")))
