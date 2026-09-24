#!/usr/bin/env python3
"""Render the AgarIPO mark: the app icon at 512/180/64/32/16, light and dark.

    py -3.12 tools/build-brand.py

This REPLACED the AIPO-on-a-tag generator. The mark is one shape: a
company disc taking a bite out of its own rim at the upper right, with a smaller
company halfway in. The absorption mechanic, in one glyph. The same drawing is
the O in the wordmark (live CSS, see #ipo-wordmark in deploy/login.css) and the
app icon, so the tab and the page are literally the same drawing.

Ratios are measured off the brand's reference artwork (kept outside this
repository), not picked:
    ring     = 0.65  x the square
    stroke   = 0.23  x the ring
    going in = 0.326 x the ring, CENTRE ON THE RIM at 45 degrees up-right
    bite     = 0.223 x the ring, about that same centre

Punching the bite and then filling the disc at the same centre leaves an even
0.06-ring gap between the two, which is what reads as "being eaten" rather than
"a dot beside a circle". Do not widen it and do not move the disc off the rim.

Colours are prestocks.com's own and DID NOT CHANGE with the mark: #14154F
headings, #6264D9 -> #4E50C0 accent. White on #6264D9 is 4.83:1 and on #4E50C0
is 6.50:1, both measured, so the gradient's worst pixel under the mark passes AA.

🔴 EVERYTHING IS WRITTEN TO brand/ AT THE REPO ROOT, and that is not where the
old generator wrote. Three separate things need these bytes and only one folder
can be the source:
  - The game, as res://brand/... — overlay.gd preloads the 64px light icon for the
    HUD wordmark and board.gd uses agaripo-default.png as the fallback company
    disc.
  - The browser, as /brand/... — the Dockerfile copies this folder into the web
    root, so the tab icon and anything linked from the page come from here too.
  - res://icon.png at the repo root, which the engine turns into the runtime
    favicon blob. Written HERE rather than copied by hand: a hand copy goes
    stale the first time the mark changes and the tab keeps showing the old one
    while every file in brand/ is correct. That already happened once.

🔴 THE DEFAULT COMPANY DISC IS NOT IN logos/. The brand kit put it at
logos/agaripo-default.png, and that would break the Docker build: the Dockerfile
gate asserts `ls logos/*.png | wc -l` equals the number of companies in
server/companies.json, because index and basename are the same number in
Scripts/main.gd. A 51st PNG in that folder fails the build. It lives in brand/.
"""
import math
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'brand')

TAG_TOP = (98, 100, 217, 255)    # #6264D9, --brand
TAG_BOT = (78, 80, 192, 255)     # #4E50C0, --brand-2 / --brand-ink
BRAND_INK = (78, 80, 192, 255)   # #4E50C0, the mark on a light ground
WHITE = (255, 255, 255, 255)
LINE = (229, 231, 235, 255)      # #E5E7EB, --line, the light icon's hairline

RING = 0.65
STROKE = 0.23
DOT = 0.326
DOT_OUT = 0.487
BITE = 0.223
SQUIRCLE = 0.22
SS = 4                           # supersample, then Lanczos down

SIZES = (512, 180, 64, 32, 16)


def mark_alpha(px, ring_d):
    """The mark as an L-mode alpha mask on a px-square canvas."""
    n, d = px * SS, ring_d * SS
    m = Image.new('L', (n, n), 0)
    dr = ImageDraw.Draw(m)
    cx = cy = n / 2.0
    outer = d / 2.0
    inner = outer - STROKE * d
    dr.ellipse((cx - outer, cy - outer, cx + outer, cy + outer), fill=255)
    dr.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=0)
    off = DOT_OUT * d / math.sqrt(2.0)
    dx, dy = cx + off, cy - off
    br = BITE * d
    dr.ellipse((dx - br, dy - br, dx + br, dy + br), fill=0)
    rr = DOT * d / 2.0
    dr.ellipse((dx - rr, dy - rr, dx + rr, dy + rr), fill=255)
    return m.resize((px, px), Image.LANCZOS)


def vgradient(size, top, bottom):
    w, h = size
    g = Image.new('RGBA', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4)))
    return g.resize((w, h), Image.NEAREST)


def squircle(px, radius, fill=None, gradient=None, hairline=None):
    m = Image.new('L', (px * SS, px * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, px * SS - 1, px * SS - 1), radius=int(radius * SS), fill=255)
    m = m.resize((px, px), Image.LANCZOS)
    out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    tile = vgradient((px, px), *gradient) if gradient else Image.new('RGBA', (px, px), fill)
    out.paste(tile, (0, 0), m)
    if hairline:
        edge = Image.new('L', (px * SS, px * SS), 0)
        dr = ImageDraw.Draw(edge)
        dr.rounded_rectangle((0, 0, px * SS - 1, px * SS - 1), radius=int(radius * SS), fill=255)
        w = max(1, int(round(px / 512.0))) * SS
        dr.rounded_rectangle((w, w, px * SS - 1 - w, px * SS - 1 - w),
                             radius=max(1, int(radius * SS) - w), fill=0)
        out.paste(Image.new('RGBA', (px, px), hairline), (0, 0),
                  edge.resize((px, px), Image.LANCZOS))
    return out


def _tint(alpha, colour, px):
    out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    out.paste(Image.new('RGBA', (px, px), colour), (0, 0), alpha)
    return out


def icon(px, dark=True):
    if dark:
        img = squircle(px, px * SQUIRCLE, gradient=(TAG_TOP, TAG_BOT))
        ink = WHITE
    else:
        img = squircle(px, px * SQUIRCLE, fill=WHITE, hairline=LINE)
        ink = BRAND_INK
    img.alpha_composite(_tint(mark_alpha(px, px * RING), ink, px), (0, 0))
    return img


def disc_skin(px=256):
    """The default company disc: the mark reversed out of brand indigo.

    A company with no picked mark and no uploaded photo wears this. board.gd
    draws every skin as-is and login.js clips uploads to a circle, so a fallback
    skin has to arrive already round.
    """
    m = Image.new('L', (px * SS, px * SS), 0)
    ImageDraw.Draw(m).ellipse((0, 0, px * SS - 1, px * SS - 1), fill=255)
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    img.paste(Image.new('RGBA', (px, px), TAG_BOT), (0, 0), m.resize((px, px), Image.LANCZOS))
    img.alpha_composite(_tint(mark_alpha(px, px * 0.58), WHITE, px), (0, 0))
    return img


def gate(path, want_px, ink):
    """Look at the bytes that were just written, rather than trusting the draw.

    🔴 THIS MEASURES THE INK, NOT THE GROUND, and the first version did not. It
    summed the alpha channel and failed below 55%, which the squircle alone
    satisfies at ~96% at every size: an empty mask, a collapsed supersample or a
    mark drawn in the ground's own colour would all have shipped green under a
    docstring that promised to catch exactly those three things. A gate that
    cannot fail is worse than no gate, because it is quoted as evidence.

    So: count the pixels that are actually the MARK's colour. The mark is a ring
    of fixed proportions, so its share of the square is arithmetic and not taste.
    The ring band spans 0.27 to 0.50 of the ring diameter, the ring is 0.65 of
    the square (0.58 for the disc skin), and the company going in adds a little;
    that lands between 7% and 26% of the square at every size this writes. A
    blank, a solid, and a mark in the wrong colour are all outside it.

    `ink` is the RGB the mark was drawn in. Compared with a tolerance, because
    the PNG is Lanczos-downsampled and antialiased pixels are blends.
    """
    im = Image.open(path).convert('RGBA')
    if im.width != want_px or im.height != want_px:
        raise SystemExit('%s is %dx%d, wanted %d square' % (path, im.width, im.height, want_px))
    n = 0
    for r, g, b, a in im.get_flattened_data() if hasattr(im, 'get_flattened_data') else im.getdata():
        if a > 200 and abs(r - ink[0]) < 26 and abs(g - ink[1]) < 26 and abs(b - ink[2]) < 26:
            n += 1
    frac = n / float(im.width * im.height)
    if not (0.07 <= frac <= 0.26):
        raise SystemExit('%s: the mark covers %.1f%% of the square, wanted 7-26%%. '
                         'Blank, solid, or drawn in the wrong colour.' % (path, frac * 100))
    return frac


def main():
    os.makedirs(OUT, exist_ok=True)
    made = []
    for px in SIZES:
        for dark in (True, False):
            name = 'agaripo-icon-%d%s.png' % (px, '' if dark else '-light')
            path = os.path.join(OUT, name)
            icon(px, dark).save(path, optimize=True)
            gate(path, px, WHITE[:3] if dark else BRAND_INK[:3])
            made.append(path)

    # 🔴 GATED LIKE EVERYTHING ELSE. This is the one file BOTH the board and the
    # login card fall back to when a player picks nothing, and it was the only
    # output written without a check.
    skin = os.path.join(OUT, 'agaripo-default.png')
    disc_skin(256).save(skin, optimize=True)
    gate(skin, 256, WHITE[:3])
    made.append(skin)

    root_icon = os.path.join(HERE, 'icon.png')
    icon(512, True).save(root_icon, optimize=True)
    gate(root_icon, 512, WHITE[:3])
    made.append(root_icon)

    for p in made:
        im = Image.open(p)
        print('%-44s %4dx%-4d %7d bytes' % (os.path.relpath(p, HERE).replace(os.sep, '/'),
                                            im.width, im.height, os.path.getsize(p)))
    print('%d files written to %s' % (len(made), os.path.relpath(OUT, HERE)))


if __name__ == '__main__':
    sys.exit(main())
