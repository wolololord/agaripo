# AgarIPO

Build a startup. Absorb capital. Acquire your competitors before they acquire you.

**Live: https://agaripo.com** (global leaderboard: https://agaripo.com/leaderboard)

Built for the Stocklana hackathon's PreStocks bounty. AgarIPO is not open source: see
[Licence](#licence).

## How it plays

- Every company floats at **$1B**. Each dot of capital is another **$1B**.
- Past 50 raises, capital barely moves your size. Acquiring is the only real way up.
- You acquire any company worth at least **5% less** than you, and never less than
  **$5B** less. The floor binds under $100B; the percentage binds above it, so two
  giants circle each other instead of the first one to make contact winning.
- Valuations read `$1B` up to `$999B`, then `$1.00T`, `$1.01T`, `$2.15T`.
- A new company cannot be taken for **3 seconds**, and spawns away from anything big
  enough to eat it. Without that you can be acquired before you have moved.
- Hold left mouse to sprint. It **costs 0.5% of your whole valuation every 2 seconds**,
  so the leader pays $10B a tick and a startup pays nothing worth counting. There is no
  stamina bar: a percentage is what makes it un-abusable, and tapping the button does not
  dodge the charge because the held time accumulates.
- A company that is sprinting trails a **comet streak** in its own colour.
- The board is **6500 x 6500** with **1300 dots** and **50 real pre-IPO companies**,
  every one of them exactly once. The market closes every **10 minutes**, publishes a
  final table of the top ten plus everything you acquired, holds it for 10 seconds, and
  reopens.
- **PreStocks is the first company on the board**, and the first tile in the picker.
- Picking a company **names you after it** and **takes its seat**: the bot that was
  running it is removed, so you play as that company rather than beside it.
- A live **Market leaders** panel sits in the top right, top ten with marks and
  valuations, your own row pinned under a divider when you are outside it.
- Get acquired and you get a card naming who took you and at what price, then you
  refound 3.5 seconds later.
- A **generated soundtrack** (Web Audio, no audio file ships) with a speaker and a
  volume slider in the bottom left. It starts on the Go public click, because no
  browser will play a sound before a gesture.

## The board is 50 pre-IPO companies people have actually heard of

Every rival is a real company: PreStocks, OpenAI, Anthropic, SpaceX, xAI, Stripe,
Databricks, Anduril, Kraken, Polymarket, Neuralink, Waymo, Canva, Valve and 36 more, each
wearing its own mark and its own name, exactly once. When you acquire one, that company is
immediately refounded, so the field is the whole list at every moment of the round.

It was 119 until 2026-09-19, and the cull is the feature. Most of those 119 were names
nobody could place, so meeting one taught a player nothing and the board read as noise.
`tools/cull-companies.py` holds the keep list, renumbers the marks so index and file
basename stay the same number, and refuses to run if any of the eight companies PreStocks
itself tokenises would be dropped.

Names and marks for 49 of them come from **forgeglobal.com/search-companies**, pages 1 to
5, scraped once by `tools/fetch-forge-logos.py` and committed. PreStocks' own mark is
their `apple-icon.png`, downloaded once and committed the same way. Nothing in the build
or on Railway ever touches either site.

### There are no lobbies. Every player gets their own market

PreStocks' brief was that other players defeat the purpose: the point is to meet the
pre-IPO companies, see their valuations and eat them one by one. That is
right. A human in the field takes a pre-IPO company's place on the board, and waiting for
one to turn up is worse than not having them at all. Solo is also evergreen: the game is
never empty, whoever opens it and whenever.

A market is created on join and destroyed the moment the socket closes. Measured at
**0.157 ms of CPU per tick** over 200 ticks, so one market is 0.31% of a core and the
default cap of 60 concurrent markets is 19%. That was measured with 119 companies on
the board, before the cut to 50.

The server is still **authoritative**. It owns every position, valuation and takeover; the game
client sends a direction 20 times a second and draws what comes back. That is deliberate:
the rules used to live in the client, and twice the player and the rivals disagreed about
who was bigger.

## Architecture

One Railway service. A single Node process serves the WebAssembly build **and** hosts
every market on the same origin, so the WebSocket needs no second domain, no CORS and no
second service to pay for.

```
GET  /            the game client, with the login card injected
GET  /logos/N.png the picker's company thumbnails
GET  /lobbies     solo=true, the company count and how many markets are live
GET  /healthz     the Railway healthcheck
WS   /ws          join, input at 20 Hz, snapshots at 20 Hz
```

| File | Job |
| --- | --- |
| `server/index.js` | static files, the socket, one market per player, the tick loop |
| `server/world.js` | one market: movement, capital, takeovers, bots, the round |
| `server/rules.js` | valuation, growth curve, acquisition rule, the company list |
| `server/companies.json` | the 50 companies, name and logo basename. Generated |
| `server/store.js` | the global leaderboard's only database code: one table, one row per finished round |
| `server/smoke.js` | acceptance checks over real sockets, exits non-zero on failure |
| `Scripts/main.gd` | socket, snapshot state, camera, input, the logo cache |
| `Scripts/board.gd` | world-space drawing: board, capital, companies, marks, streaks |
| `Scripts/overlay.gd` | every string in the game, drawn in screen space |
| `logos/NNN.png` | 50 company marks at 256px, baked into `index.pck`. Generated |
| `deploy/login.js` | login card, company picker, all image validation |
| `deploy/logos.js` | the picker's copy of the company list. Generated |
| `deploy/logos/NNN.png` | the picker's 96px thumbnails. Generated |
| `deploy/leaderboard.html/.css/.js` | the global leaderboard page, served at `/leaderboard` |
| `brand/` | the AgarIPO mark: app icon 512/180/64/32/16 light and dark, plus the default company disc. Generated by `tools/build-brand.py`, read by the game as `res://brand/` AND served at `/brand/` |
| `tools/fetch-forge-logos.py` | rebuilds the company pack from Forge Global |
| `tools/cull-companies.py` | cuts that pack to the 50 kept names and renumbers it |
| `tools/assets/prestocks-source.png` | prestocks.com's own apple-icon, for index 0 |
| `tools/build-brand.py` | rebuilds the mark: every icon size, both treatments, the default disc, `icon.png` |
| `Dockerfile` | headless web export, then Node serves it |
| `.gitignore` | keeps `archives/` and `node_modules/` out of the upload. Load-bearing |

## Labels are drawn in screen space, and that is the whole point

The valuation and the company name used to be `Control` nodes parented to the blob,
counter-scaled by `1/s` with the font raised by `s`. `anchors_preset = 8` also writes
`grow_horizontal = grow_vertical = GROW_DIRECTION_BOTH`, so the moment the text outgrew its
128x26 rect the engine enlarged the rect **and shifted its position up and left by half the
excess**, while `pivot_offset` still described the rect the code had asked for. The
counter-scale then pivoted about a point that was no longer the centre, and the error
`(64 - W/2)(s - 1)` grew with the company. Three separate fixes chased the symptom.

`Scripts/overlay.gd` uses no layout at all. It takes each blob's screen position, measures
the string, and draws it centred. It cannot drift, and the glyphs are rasterised at final
size, so they are sharp at every blob size.

## The login screen

Your company name, and your logo. That is the whole card now: with lobbies gone there is
nothing to pick and nobody to invite.

### Two ways to get a logo, and only one of them puts bytes on the wire

**Pick a pre-IPO company.** A searchable grid of all 50, PreStocks first, each with its name under the
mark, because most of these are startups nobody recognises from the logo alone. Picking one
sends its **index**, a single small integer: the game already owns the same pack inside its
own `index.pck`, so nothing is encoded and nothing is uploaded.

🔴 This replaced 86 simple-icons SVG paths rasterised through `Path2D`. They were the wrong
companies (simple-icons matched **24 of these 119**; it carries household brands and these
are pre-IPO startups) and the round trip through a 128px canvas is exactly what made the
mark blurry on a big ball.

**Upload your own.** Click the box, or **drop a file on it**. The file is **never
uploaded**: it is read with `FileReader`, validated, then **redrawn onto a canvas, clipped
to a circle and re-encoded as a fresh 256x256 PNG**, with a 256 -> 192 -> 128 ladder so a
noisy photo still fits the server's 96 KB skin cap. Only those generated pixels leave the
script, which drops EXIF, colour profiles, appended data and any polyglot payload.

Validation, in order, all of which must pass:

1. not empty, at most 4 MB
2. extension is `.png` / `.jpg` / `.jpeg`
3. **magic bytes** are a PNG or a JPEG
4. if the browser reported a MIME type *at all*, it agrees with the magic
5. declared dimensions parsed from the header, 16 to 8192, **before any decode**
6. `createImageBitmap()` decodes it

Step 3 is the one that matters: the extension comes from the filename, so a renamed `.exe`
passes 2 and is caught only there. Verified locally against a set of hostile files,
including `evil-exe-renamed.png` (a DOS/PE header named `.png`).

🔴 **Step 4 used to be a hard reject and that was a bug.** `File.type` is read from the
Windows registry association for the extension, so on a machine where another application
has claimed `.png` it comes back `""` and a genuine PNG was refused before a byte of it was
read. The magic bytes are the evidence; the MIME is a second opinion and only votes when
the browser actually cast one. Proven in the browser: a real PNG with `type: ''` is now
accepted, and a DOS/PE header named `.png` is still refused.

**A player who picks nothing and uploads nothing gets a monogram watermark**, drawn by the
renderer from their company name. Every pre-IPO company already wears its own mark.

## Nothing is ever blurry, and that is arithmetic

Forge serves its marks at **48x48** and has nothing bigger: the detail pages carry an
80x80, and `<slug>_stock.png` is a 1200x600 social card with a wordmark in it. Clearbit's
logo API is dead (connection refused) and Google's favicon service returns a mixture of
96 / 180 / 256 and non-PNG, its "256" softer than a Lanczos upscale of Forge's 48. So each
mark is Lanczos-upscaled **once, offline, to 256x256** on a white disc.

Then `board.gd` draws it at `min(r * 0.60, texture_width * 0.5 / zoom)`. The second term is
the fix: the on-screen size **can never exceed the texture's own pixel count**, so the mark
is never magnified, at any valuation, on any screen. At `MAX_SCALE` that is a 256px mark on
a 600px ball, which reads as a badge.

The textures carry **mipmaps** (`[importer_defaults]` in the project file, asserted against
a generated `.import` sidecar in the Dockerfile), because a 256px mark on a $1B startup is
about 50 screen pixels and without them it point-samples every fifth texel and sparkles.

## The global leaderboard

Every finished round is filed under the browser that played it, and
`/leaderboard` ranks players by the **biggest company they ever built**, not by
what they were worth at the bell.

That distinction is the feature. Being acquired refounds you at $1B with minutes
still on the clock, so a board built on the closing valuation would rank someone
who reached $500B and was taken at 9:58 below someone who idled all round. Each
blob carries a `peak`, swept once per tick after the takeovers and before the
respawn, and that is the number stored.

- **Nothing about the score is client-supplied.** The browser contributes one
  thing: a random UUID it keeps in `localStorage` and sends in the join frame.
  Every number comes from the simulation at the closing bell. There is no field
  for anyone to inflate, which is the only reason a public leaderboard with no
  accounts is worth having.
- **The id never comes back out.** Responses carry a 4-character hash of it,
  shown only where two players used the same display name, and a `you` flag for
  the caller. The caller's own id arrives in an `x-agaripo-pid` header, never a
  query string, so it stays out of access logs and out of the `Referer` on the
  prestocks.com link.
- **Postgres, not a Railway volume.** The container ends `USER node`, and
  Railway's docs say a non-root image has permission problems inside a mounted
  volume, with `RAILWAY_RUN_UID=0` as the fix. Running a public game server as
  root to save a few dollars a month is the wrong trade, and Postgres also
  brings SQL, concurrent writes and no single-replica limit.
- **A broken database cannot break the game.** No `DATABASE_URL`, a database
  that is down, a query that throws: all of them leave the game running and cost
  only the board. The write is fire-and-forget because `close()` runs inside the
  tick loop's `try/catch`, where twenty throws close a player's market.
- `/lobbies` reports `board: {enabled, written, failed, schema}`, which is how
  you tell a disabled store from an empty one without opening a database.

## Deploy

Deploys never go through GitHub. The Railway CLI uploads a local checkout directly, and
`.gitignore` decides what it uploads.

```bash
railway up --ci -s web   # from the repository root
```

Rebuilding the generated assets (only when the company list or the brand changes;
`py -3.12` is the Windows launcher, `python3` elsewhere):

```bash
py -3.12 tools/fetch-forge-logos.py   # ~2 min, throttled: Forge rate-limits
py -3.12 tools/cull-companies.py      # then cut it to the 50 on the board, PreStocks first
py -3.12 tools/build-brand.py
```

- Two services: `web` (this Dockerfile) and `Postgres` (the leaderboard's round history).
- `web` reads one variable, `DATABASE_URL`, as a reference to the Postgres service. Without
  it the game still runs and the two leaderboard routes answer 503.
- No volumes, no buckets.

## Test

```bash
# server only, no browser, from server/
cd server && npm install
node index.js &
npm test                           # exit code is the verdict; it prints its own count
# 🔴 Every check that needs the web export is SKIPPED without a build beside
# the server: the picker pack, the thumbnails, the brand marks, the leaderboard page,
# the rules the card promises, and the script order. Only the image and the live
# runs cover those.

# the closing bell, proven in 26 seconds, still from server/. 🔴 Every closing-bell
# check (the reset, the end card, and the leaderboard write-back when a database is
# wired) runs only when the suite lands in the last 60 s of a round. The production
# round is 600 s, so the default run skips them: run this as well, or nothing covers them.
ROUND_SECONDS=26 PORT=8124 node index.js &
ROUND_SECONDS=26 node smoke.js http://127.0.0.1:8124

# the whole thing, from the repository root
cd ..
docker build -t agaripo:local .
docker run -d --rm -p 8099:8099 -e PORT=8099 agaripo:local
node server/smoke.js http://127.0.0.1:8099
```

## Licence

Not open source. Only PreStocks may use, copy, modify, host or deploy this code, and
everyone else needs written permission from Wolo. Playing it at agaripo.com, or anywhere
PreStocks runs it, needs none. The terms are in [LICENSE](LICENSE). A few parts
came from an MIT-licensed Agar.io-style template by mbMayer and stay under its licence,
in [UPSTREAM-LICENSE](UPSTREAM-LICENSE). [UPSTREAM.md](UPSTREAM.md) says which parts.
