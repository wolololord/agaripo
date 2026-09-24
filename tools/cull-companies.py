#!/usr/bin/env python3
"""Cut the AgarIPO board down to the 50 companies people have heard of, and put
PreStocks first.

Run offline, once, by hand. The OUTPUT is committed; nothing in the Docker build
or on Railway ever runs this.

    py -3.12 tools/cull-companies.py

WHY A RENUMBER AND NOT A FILTER. Scripts/main.gd builds a mark's path as
`res://logos/%03d.png` from the company's INDEX, so index and basename are the
same number by construction. Filtering companies.json alone would leave index 3
pointing at Anduril's row and Figure AI's picture. So the kept marks are COPIED
to fresh 000..049 names and the list is rewritten to match, which also drops 69
unused 256 px textures out of index.pck.

Nothing is deleted. The culled marks and every file this replaces move to
archives/ with a date prefix.

PRESTOCKS IS INDEX 0, so it is the first tile in the picker, top left. Its mark
comes from tools/assets/prestocks-source.png, which is prestocks.com's own
228x228 apple-icon.png downloaded on 2026-09-19 and committed, for the same
reason the Forge marks are committed: a live fetch inside a build is a build
that breaks when somebody else redesigns their site.
"""
import json
import os
import shutil
import sys
from datetime import date

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GAME_PX = 256   # the texture that goes in the pck
TILE_PX = 96    # the thumbnail the picker grid shows
INSET = 0.62    # how much of the disc the mark fills, same as the Forge pack

# 🔴 The board is a NAME TEST, not a valuation ranking. PreStocks' point was that a
# player should meet the pre-IPO companies; meeting Ayar Labs and Taalas teaches
# nobody anything, and 119 balls on one board made every individual one
# forgettable. These are the 49 a normal person or a crypto-native actually
# recognises, plus PreStocks. Every one of the eight companies PreStocks itself
# tokenises is in here, and that is asserted below rather than eyeballed.
#
# Order is deliberate: PreStocks, then the household AI and space names, then
# fintech and crypto, then consumer. It is the order the picker grid reads in.
KEEP = [
    'PreStocks',
    'OpenAI', 'Anthropic', 'SpaceX', 'xAI', 'Stripe', 'Databricks', 'Anduril',
    'ByteDance', 'Discord', 'Epic Games', 'Canva', 'Revolut', 'Ripple',
    'Kraken', 'Polymarket', 'Kalshi', 'Chainalysis', 'Perplexity', 'Neuralink',
    'Blue Origin', 'Waymo', 'DJI', 'Valve', 'OnlyFans', 'Plaid', 'Deel',
    'Rippling', 'Ramp', 'Mercury', 'Vercel', 'Replit', 'Hugging Face',
    'Mistral AI', 'DeepSeek', 'Cohere', 'Scale AI', 'Groq', 'Cerebras',
    'Figure AI', 'Zipline', 'Skydio', 'Flexport', 'Whoop', 'OURA', 'Strava',
    'Fanatics', 'The Boring Company', 'Beast Industries', 'Suno',
]

# The eight PreStocks tokenises today, read off prestocks.com on 2026-09-19.
# Culling one of these would be the single dumbest thing this script could do at
# their own hackathon, so it cannot happen silently.
PRESTOCKS_PRODUCTS = ['OpenAI', 'Anthropic', 'Anduril', 'Figure AI', 'SpaceX',
                      'Kalshi', 'Neuralink', 'Polymarket']

# deploy/login.js sets maxlength on the name box, and the name now DEFAULTS to
# the company you picked. A name longer than the box silently loses its tail.
MAX_NAME = 18

PRESTOCKS_SRC = os.path.join(HERE, 'tools', 'assets', 'prestocks-source.png')


def disc(src, px):
    """The mark, centred on a white disc, anti-aliased, as RGBA.

    Lifted unchanged from tools/fetch-forge-logos.py so PreStocks comes out of
    the same rendering path as the other 49 and cannot look like a visitor.
    """
    ss = px * 4                                     # supersample, then downsample
    canvas = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
    mask = Image.new('L', (ss, ss), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, ss - 1, ss - 1), fill=255)
    canvas.paste(Image.new('RGBA', (ss, ss), (255, 255, 255, 255)), (0, 0), mask)

    mark = src.convert('RGBA')
    side = int(ss * INSET)
    mark = mark.resize((side, side), Image.LANCZOS)
    at = (ss - side) // 2
    canvas.alpha_composite(mark, (at, at))
    return canvas.resize((px, px), Image.LANCZOS)


def trimmed_prestocks():
    """PreStocks' apple-icon as a tight mark on transparency.

    Their icon is a rounded white SQUARE with the hexagon inset in it. Fed
    straight through disc() it would land at 62% of 62% and read as a small logo
    on a big empty disc beside 49 marks that fill theirs. So the white plate and
    the transparent corners are cropped away first and only the hexagon is
    handed on, which is exactly the shape Forge serves for everybody else.
    """
    src = Image.open(PRESTOCKS_SRC)
    src.load()
    if src.format != 'PNG':
        raise SystemExit('%s is a %s, not a PNG.' % (PRESTOCKS_SRC, src.format))
    src = src.convert('RGBA')
    w, h = src.size
    px = src.load()
    # The bounding box of everything that is neither transparent nor near-white.
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 24:
                continue
            if r > 238 and g > 238 and b > 238:
                continue
            if x < x0:
                x0 = x
            if y < y0:
                y0 = y
            if x > x1:
                x1 = x
            if y > y1:
                y1 = y
    if x1 < x0 or y1 < y0:
        raise SystemExit('%s is blank once white and transparency are removed.'
                         % PRESTOCKS_SRC)
    # Square it about its own centre, so the hexagon is not stretched.
    side = max(x1 - x0, y1 - y0) + 1
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(src.crop(box), (0, 0))
    print('  prestocks mark cropped to %dx%d from %dx%d' % (side, side, w, h))
    return out


def main():
    old = json.load(open(os.path.join(HERE, 'server', 'companies.json'), encoding='utf-8'))
    by_name = {row['n']: row for row in old}
    print('current board: %d companies' % len(old))

    if len(KEEP) != len(set(KEEP)):
        raise SystemExit('KEEP has a duplicate in it.')
    missing = [n for n in KEEP[1:] if n not in by_name]
    if missing:
        raise SystemExit('not on the current board: %s' % ', '.join(missing))
    if KEEP[0] != 'PreStocks':
        raise SystemExit('PreStocks has to be index 0. It is the first tile.')
    lost = [n for n in PRESTOCKS_PRODUCTS if n not in KEEP]
    if lost:
        raise SystemExit('these are PreStocks own products and were culled: %s'
                         % ', '.join(lost))
    too_long = [n for n in KEEP if len(n) > MAX_NAME]
    if too_long:
        raise SystemExit('longer than the name box (%d chars): %s'
                         % (MAX_NAME, ', '.join(too_long)))

    game_dir = os.path.join(HERE, 'logos')
    tile_dir = os.path.join(HERE, 'deploy', 'logos')
    stamp = date.today().isoformat()
    arch = os.path.join(HERE, 'archives', stamp + '-culled-logos')
    os.makedirs(os.path.join(arch, 'logos'), exist_ok=True)
    os.makedirs(os.path.join(arch, 'deploy-logos'), exist_ok=True)

    # Rendered into memory first and written only once every check has passed,
    # for the same reason fetch-forge-logos.py stages into a scratch directory:
    # a half-renumbered pack beside a full companies.json is a broken board that
    # still boots.
    plan = []
    for i, name in enumerate(KEEP):
        slug = '%03d' % i
        if name == 'PreStocks':
            mark = trimmed_prestocks()
            plan.append((slug, name, None, disc(mark, GAME_PX), disc(mark, TILE_PX)))
            continue
        src = by_name[name]['f']
        plan.append((slug, name, src, None, None))
        for d in (game_dir, tile_dir):
            if not os.path.isfile(os.path.join(d, src + '.png')):
                raise SystemExit('%s/%s.png is missing (%s)' % (d, src, name))

    # Everything the new pack needs is in hand. Move the old pack aside whole,
    # then lay the new one down from it.
    for live, into in ((game_dir, 'logos'), (tile_dir, 'deploy-logos')):
        for f in sorted(os.listdir(live)):
            if f.endswith('.png') or f.endswith('.import'):
                shutil.move(os.path.join(live, f), os.path.join(arch, into, f))

    pack = []
    for slug, name, src, game_img, tile_img in plan:
        if src is None:
            game_img.save(os.path.join(game_dir, slug + '.png'), optimize=True)
            tile_img.save(os.path.join(tile_dir, slug + '.png'), optimize=True)
        else:
            shutil.copyfile(os.path.join(arch, 'logos', src + '.png'),
                            os.path.join(game_dir, slug + '.png'))
            shutil.copyfile(os.path.join(arch, 'deploy-logos', src + '.png'),
                            os.path.join(tile_dir, slug + '.png'))
        pack.append({'n': name, 'f': slug})
        print('  %s  %-20s <- %s' % (slug, name, src or 'prestocks.com'))

    with open(os.path.join(HERE, 'server', 'companies.json'), 'w', encoding='utf-8') as f:
        json.dump(pack, f, indent=0)
        f.write('\n')

    js = os.path.join(HERE, 'deploy', 'logos.js')
    with open(js, 'w', encoding='utf-8') as f:
        f.write('/* Generated by tools/cull-companies.py. Do not edit by hand.\n'
                ' * %d pre-IPO companies. PreStocks is index 0 and its mark is\n'
                ' * prestocks.com own apple-icon.png; the other %d were scraped\n'
                ' * from forgeglobal.com/search-companies by fetch-forge-logos.py\n'
                ' * and culled from 119 to the ones people have heard of.\n'
                ' * "f" is the basename under logos/ and deploy/logos/, and it is\n'
                ' * always the row index: Scripts/main.gd builds the path from the\n'
                ' * index, so the two can never be allowed to drift.\n'
                ' * Company names and marks are their owners trademarks; they\n'
                ' * appear here nominatively, to name the company they identify. */\n'
                % (len(pack), len(pack) - 1))
        f.write('window.AGARIPO_LOGOS = ' + json.dumps(pack, separators=(',', ':')) + ';\n')

    game_bytes = sum(os.path.getsize(os.path.join(game_dir, f)) for f in os.listdir(game_dir))
    tile_bytes = sum(os.path.getsize(os.path.join(tile_dir, f)) for f in os.listdir(tile_dir))
    print('')
    print('%d companies, %d archived to %s' % (len(pack), len(old) - len(KEEP) + 1, arch))
    print('logos/        %7d bytes  (into index.pck)' % game_bytes)
    print('deploy/logos/ %7d bytes  (served for the picker)' % tile_bytes)
    print('logos.js      %7d bytes' % os.path.getsize(js))


if __name__ == '__main__':
    sys.exit(main())
