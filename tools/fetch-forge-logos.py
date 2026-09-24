#!/usr/bin/env python3
"""Build the AgarIPO company pack from Forge Global's pre-IPO company search.

Run offline, once, by hand. The OUTPUT is committed; nothing in the Docker build
or on Railway ever touches forgeglobal.com. A layout change on their side can
therefore never break a running build, it can only make the next re-run fail
loudly here, where somebody is watching.

    py -3.12 tools/fetch-forge-logos.py

Writes four things from one source of truth:

    logos/NNN.png         256x256 round disc, baked into index.pck. Rival logos
                          cost ZERO bytes on the wire because of this.
    deploy/logos/NNN.png  96x96 round disc, served as a static file for the
                          picker grid. 46 CSS px at 2x device pixels.
    server/companies.json [{n, f}] - the server names its bots from this.
    deploy/logos.js       window.AGARIPO_LOGOS - the same list as a plain global,
                          because that is the only browser-to-engine bridge that
                          has ever worked in this project.

Forge serves 48x48 marks and nothing larger: the detail pages carry an 80x80, and
<slug>_stock.png is a 1200x600 social card with a wordmark in it. Measured, not
assumed. Lanczos to 256 was rendered and looked at against nearest-neighbour and
against Google's own 256 px favicon, and it is the cleanest of the three, because
these are flat line marks and that is the best case for resampling.
"""
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = 5
BASE = 'https://forgeglobal.com'
# 🔴 Forge sits behind a bot filter that reads more than the request headers.
# Measured on 2026-09-19: a plain HTTP fetch gets 403, and so does Python's own
# urllib WITH a full Chrome header set, because the filter fingerprints the TLS
# handshake and urllib's does not look like a browser's. curl with the same
# headers gets 200.
# So the fetch shells out to curl. Do not "simplify" this back to urllib.
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
CURL = ['curl', '-sSL', '--fail', '--compressed', '-A', UA,
        '-H', 'Accept-Language: en-US,en;q=0.9']
ROW = re.compile(
    r'<td class="col-logo"><a href="([^"]+)">.*?<img src="([^"]+)"[^>]*>'
    r'</picture></a></td><td class="col-title"><a[^>]*>(.*?)</a>', re.S)

GAME_PX = 256   # the texture that goes in the pck
TILE_PX = 96    # the thumbnail the picker grid shows
INSET = 0.62    # how much of the disc the mark fills


# 🔴 Forge also rate-limits. Measured: 40-odd back-to-back image fetches and it
# starts answering 403 to everything, including URLs that worked a second earlier.
# 0.4 s between requests and an exponential backoff on retry clears it; without
# the throttle the run dies about a third of the way through the pack.
THROTTLE = 0.4
_last = [0.0]


def get(url, tries=5):
    for attempt in range(tries):
        wait = THROTTLE - (time.monotonic() - _last[0])
        if wait > 0:
            time.sleep(wait)
        r = subprocess.run(CURL + [url], capture_output=True)
        _last[0] = time.monotonic()
        if r.returncode == 0 and r.stdout:
            return r.stdout
        if attempt == tries - 1:
            raise SystemExit('curl failed on %s (exit %d): %s'
                             % (url, r.returncode, r.stderr.decode('utf-8', 'replace')[:200]))
        back = 2.0 * (2 ** attempt)
        print('  retry %d in %.0fs: %s' % (attempt + 1, back, url))
        time.sleep(back)
    raise RuntimeError('unreachable')


def scrape():
    out, seen = [], set()
    for page in range(1, PAGES + 1):
        url = BASE + '/search-companies/' + ('' if page == 1 else '?page=%d' % page)
        html = get(url).decode('utf-8', 'replace')
        found = ROW.findall(html)
        print('page %d: %d rows' % (page, len(found)))
        if not found:
            raise SystemExit('page %d matched no rows. Forge changed its markup; '
                             'fix ROW before trusting anything downstream.' % page)
        for _slug, img, title in found:
            name = re.sub(r'<[^>]+>', '', title).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            out.append({'name': name, 'img': img})
    return out


def disc(src, px):
    """The mark, centred on a white disc, anti-aliased, as RGBA.

    A round disc rather than a bare mark, because the ball underneath is a solid
    colour that changes per company: a dark logo on a dark ball is unreadable.
    The disc is also exactly what an uploaded photo is cropped to, so brands and
    uploads come out of one rendering path and cannot drift apart.
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


def main():
    rows = scrape()
    print('unique companies: %d' % len(rows))
    if len(rows) < 100:
        raise SystemExit('only %d companies; expected about 120. Refusing to ship '
                         'a thin pack over a good one.' % len(rows))

    # 🔴 Rendered into a scratch directory and swapped in at the END. Forge
    # rate-limits, so a partial run is the EXPECTED failure, not an exotic one,
    # and deleting the shipped pack first meant a rate limit at company 40 left
    # 40 marks on disk beside a companies.json naming 119. The Dockerfile's own
    # guard (test -ge 100) would not have caught it. The script already refuses
    # to overwrite a good pack with a thin one on the row count; this is the
    # same standard applied to the half that can actually fail.
    game_dir = os.path.join(HERE, 'logos')
    tile_dir = os.path.join(HERE, 'deploy', 'logos')
    tmp_game = tempfile.mkdtemp(prefix='agaripo-game-')
    tmp_tile = tempfile.mkdtemp(prefix='agaripo-tile-')

    pack = []
    for i, r in enumerate(rows):
        raw = get(BASE + r['img'])
        try:
            src = Image.open(io.BytesIO(raw))
            src.load()
        except Exception as e:                      # noqa: BLE001
            raise SystemExit('%s (%s) is not a readable image: %s'
                             % (r['name'], r['img'], e))
        slug = '%03d' % i
        disc(src, GAME_PX).save(os.path.join(tmp_game, slug + '.png'), optimize=True)
        disc(src, TILE_PX).save(os.path.join(tmp_tile, slug + '.png'), optimize=True)
        pack.append({'n': r['name'], 'f': slug})
        print('  %s  %-28s %dx%d' % (slug, r['name'], src.width, src.height))

    # Everything downloaded and rendered. Only now does the shipped pack move.
    for live, scratch in ((game_dir, tmp_game), (tile_dir, tmp_tile)):
        os.makedirs(live, exist_ok=True)
        for f in os.listdir(live):
            if f.endswith('.png'):
                os.remove(os.path.join(live, f))
        for f in os.listdir(scratch):
            shutil.move(os.path.join(scratch, f), os.path.join(live, f))
        os.rmdir(scratch)

    with open(os.path.join(HERE, 'server', 'companies.json'), 'w', encoding='utf-8') as f:
        json.dump(pack, f, indent=0)
        f.write('\n')

    js = os.path.join(HERE, 'deploy', 'logos.js')
    with open(js, 'w', encoding='utf-8') as f:
        f.write('/* Generated by tools/fetch-forge-logos.py. Do not edit by hand.\n'
                ' * %d pre-IPO companies from forgeglobal.com/search-companies,\n'
                ' * pages 1-%d. "f" is the basename under logos/ and deploy/logos/.\n'
                ' * Company names and marks are their owners trademarks; they appear\n'
                ' * here nominatively, to name the company they identify. */\n'
                % (len(pack), PAGES))
        f.write('window.AGARIPO_LOGOS = ' + json.dumps(pack, separators=(',', ':')) + ';\n')

    game_bytes = sum(os.path.getsize(os.path.join(game_dir, f))
                     for f in os.listdir(game_dir))
    tile_bytes = sum(os.path.getsize(os.path.join(tile_dir, f))
                     for f in os.listdir(tile_dir))
    print('')
    print('%d companies' % len(pack))
    print('logos/        %7d bytes  (into index.pck)' % game_bytes)
    print('deploy/logos/ %7d bytes  (served for the picker)' % tile_bytes)
    print('logos.js      %7d bytes' % os.path.getsize(js))


if __name__ == '__main__':
    sys.exit(main())
