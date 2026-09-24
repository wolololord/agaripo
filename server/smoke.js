'use strict';
// Acceptance test for the server, run without a browser in the loop.
//
//   node smoke.js [base]        default http://127.0.0.1:8080
//
// Exits non-zero on the first failed check, so it works as a gate.

const crypto = require('crypto');
const WebSocket = require('ws');
const zlib = require('zlib');
const R = require('./rules');
const { Lobby, DT, IDLE_MS } = require('./world');
const store = require('./store');
const accounts = require('./accounts');

// A real, minimal 16x16 PNG, built here rather than committed as a fixture. The
// server now decodes the base64 and checks the magic bytes and the IHDR
// dimensions, so a placeholder string is correctly refused and this test needs an
// actual image to prove the accept path still works.
function tinyPng(side = 16) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((side + 1) * side, 0x80);
  for (let y = 0; y < side; y++) raw[y * (side + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// The 8 byte PNG signature. A 404 page served with a 200 satisfies res.ok on
// its own, so every image check here looks at the bytes as well as the status.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
// 🔴 Rounds are filed, and accounts are written, ONLY against a local server.
// Every player who leaves now files a round, so a run against the live site
// would put a row on the real leaderboard every time it ran.
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);
const FILE_ROUNDS = LOCAL || process.env.SMOKE_FILE === '1';

function post(path, body, type = 'application/json') {
  return fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => {
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json: json || {} };
  });
}

// A fresh short player id, the same shape login.js mints.
function newCode() {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let c = '';
  for (let i = 0; i < 12; i++) c += A[Math.floor(Math.random() * 32)];
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (ok) passed++; else failed++;
}

function open(name, join) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS);
    const state = { sock, name, id: 0, meta: [], dots: [], last: null, dead: null,
      skins: [], lb: null };
    const timer = setTimeout(() => reject(new Error(`${name}: no welcome in 8s`)), 8000);
    sock.on('open', () => sock.send(JSON.stringify(Object.assign({ t: 'join', name }, join))));
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') {
        state.id = m.id; state.world = m.world;
        clearTimeout(timer); resolve(state);
      } else if (m.t === 'dots') state.dots = m.d;
      else if (m.t === 'm') state.meta = m.blobs;
      else if (m.t === 's') {
        state.last = m;
        // The leaderboard rides every fifth snapshot, so it has to be kept as it
        // passes rather than read off the last frame.
        if (m.lb) state.lb = m.lb;
        // Eaten dots are replaced in the same slot. A client that ignores these
        // keeps chasing capital that is no longer there.
        if (m.d) for (let i = 0; i < m.d.length; i += 4) {
          const slot = m.d[i] * 4;
          state.dots[slot] = m.d[i]; state.dots[slot + 1] = m.d[i + 1];
          state.dots[slot + 2] = m.d[i + 2]; state.dots[slot + 3] = m.d[i + 3];
        }
      }
      else if (m.t === 'dead') state.dead = m;
      else if (m.t === 'close') state.close = m;
      else if (m.t === 'skin') state.skins.push(m.id);
    });
    sock.on('error', reject);
  });
}

function mine(s) {
  if (!s.last) return null;
  const b = s.last.b;
  for (let i = 0; i < b.length; i += 6) {
    if (b[i] === s.id) {
      // Int 6 is a bitmask: bit 0 spawn-protected, bit 1 sprinting.
      return {
        x: b[i + 1], y: b[i + 2], scale: b[i + 3] / 100, count: b[i + 4],
        safe: (b[i + 5] & 1) !== 0, boost: (b[i + 5] & 2) !== 0,
      };
    }
  }
  return null;
}

// Steer at the nearest dot, exactly as the real client does.
function chase(s) {
  const me = mine(s);
  if (!me) return;
  let best = Infinity, tx = 0, ty = 0;
  for (let i = 0; i < s.dots.length; i += 4) {
    const dx = s.dots[i + 1] - me.x, dy = s.dots[i + 2] - me.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; tx = dx; ty = dy; }
  }
  s.sock.send(JSON.stringify({ t: 'in', dx: tx, dy: ty, b: false }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`${BASE}/lobbies`)).json();
  // 🔴 Relative to a BASELINE, not to zero. The last check in this file used to
  // assert `live === 0`, which made it fail whenever anything else was connected
  // to the same server: a browser tab left on the game reconnects every 1.5 s on
  // its own. A test whose result depends on the room it runs in is not a gate.
  // What this run is responsible for is the markets IT opened.
  const liveBefore = list.live;
  check('the server reports solo markets, not lobbies', list.solo === true,
    `solo=${list.solo}`);
  check(`the board is ${R.WORLD} across`, list.world === R.WORLD, `world=${list.world}`);
  check(`each market carries ${R.FIELD_SIZE} pre-IPO companies`,
    list.field === R.FIELD_SIZE, `field=${list.field}`);
  check(`each market carries ${R.DOT_COUNT} dots of capital`,
    list.dots === R.DOT_COUNT, `dots=${list.dots}`);
  check(`a round runs ${R.ROUND_SECONDS / 60} minutes`,
    list.round === R.ROUND_SECONDS, `round=${list.round}s`);
  check(`the closing bell holds the board for ${R.CLOSING_SECONDS}s`,
    list.closing === R.CLOSING_SECONDS, `closing=${list.closing}s`);

  // 🔴 WITH A PLAYER ID, because the real client sends one and the whole
  // leaderboard write path is gated on it. The first cut of this suite joined
  // without one, so the closing bell correctly filed nothing and the insert was
  // never once executed over a real socket while every check still said PASS.
  // Fixed rather than random: it makes the row this run writes identifiable in
  // a database somebody is looking at by hand.
  const SMOKE_PID = 'a9a9a9a9-5b0c-4e00-8aaa-000000000001';
  if (FILE_ROUNDS) await post('/api/player', { pid: SMOKE_PID, name: 'Smoke Alpha' });
  const a = await open('AlphaCo', FILE_ROUNDS ? { pid: SMOKE_PID } : {});
  // 🔴 900 ms, not 400. The roster broadcast is coalesced to 2 Hz now that there
  // are 200 companies in it, so a 400 ms wait raced the first meta frame.
  await wait(900);
  check(`all ${R.DOT_COUNT} dots of capital delivered on join`,
    a.dots.length === R.DOT_COUNT * 4, `ints=${a.dots.length}`);
  // 🔴 A BAND, and a tight one. balanceBots() refills at the top of every tick but
  // acquire() removes a bot LATER in the same tick, so a roster built right after
  // it legitimately reads a few short of the full field.
  check(`the field is the whole company list plus you`,
    a.meta.length >= R.FIELD_SIZE - 5 && a.meta.length <= R.FIELD_SIZE + 1,
    `meta=${a.meta.length} of ${R.FIELD_SIZE}+1`);
  check('exactly one human on the board', a.meta.filter((m) => m.h === 1).length === 1);

  // 🔴 The point of the whole change, in three checks. PreStocks' brief: the
  // board has to BE the pre-IPO list. A made-up name on a real mark, or the same
  // company twice, misses that just as badly as a human in the field does.
  const rivals = a.meta.filter((m) => m.h !== 1);
  const byName = new Map(R.COMPANIES.map((co, i) => [co.n, i]));
  const strangers = rivals.filter((m) => !byName.has(m.n));
  check('every rival is a real pre-IPO company from the pack', strangers.length === 0,
    strangers.slice(0, 4).map((m) => m.n).join(',') || `${rivals.length} checked`);
  const mismatched = rivals.filter((m) => m.g !== byName.get(m.n));
  check('the mark a rival wears is its OWN company logo', mismatched.length === 0,
    mismatched.slice(0, 3).map((m) => `${m.n}#${m.g}`).join(',') || 'name and index agree');
  const dupes = rivals.length - new Set(rivals.map((m) => m.g)).size;
  check('no company appears on the board twice', dupes === 0, `duplicates=${dupes}`);

  // Two players must NOT share a board. That is the whole reason lobbies went.
  const b = await open('BetaCo', { skin: tinyPng() });
  await wait(900);
  check('a second player gets their own market, not this one',
    !a.meta.some((m) => m.i === b.id) && !b.meta.some((m) => m.i === a.id),
    `a=${a.id} b=${b.id}`);
  check('the second market is the same full company list',
    b.meta.length >= R.FIELD_SIZE - 5 && b.meta.length <= R.FIELD_SIZE + 1,
    `meta=${b.meta.length}`);
  check('an uploaded logo comes back on the wire', b.skins.includes(b.id),
    `skins=${b.skins.join(',') || 'none'}`);

  // A picked brand is an INDEX, and an index is all that crosses the wire.
  // GammaCo also carries a fresh player id that is never named, so if the bell
  // rings in this run its round is that id's only trace (checked at the bell).
  const C_PID = FILE_ROUNDS ? newCode() : '';
  const c = await open('GammaCo', C_PID ? { logo: 7, pid: C_PID } : { logo: 7 });
  await wait(900);
  check('a picked company logo travels as an index, not an image',
    c.meta.some((m) => m.i === c.id && m.g === 7) && c.skins.length === 0,
    `skins=${c.skins.length}`);
  const outOfRange = await open('CheatCo', { logo: 999999 });
  await wait(900);
  check('a logo index outside the pack is refused, not read out of bounds',
    outOfRange.meta.some((m) => m.i === outOfRange.id && m.g === -1));
  outOfRange.sock.close();

  // The data: prefix is a claim, not evidence. A logo is relayed to twenty other
  // players, so the bytes behind it have to be a PNG.
  const liar = await open('LiarCo', {
    skin: 'data:image/png;base64,' + Buffer.from('MZ\u0000not a png at all, just bytes').toString('base64'),
  });
  await wait(900);
  check('a logo that is not really a PNG is refused', !c.skins.includes(liar.id),
    `relayed=${c.skins.join(',') || 'none'}`);
  liar.sock.close();

  // 🔴 BOTH of these are tested on a company founded HERE, not on `a`.
  // Protection lasts 3 s and `a` joined several waits ago, so reading it off `a`
  // measured how long the checks above happened to take. Worse, `a` has been
  // sitting still among the whole board since it joined: against Railway, where
  // every wait is a round trip longer, it had reliably been ACQUIRED by this
  // point and was legitimately absent from its own snapshot. Both checks passed
  // locally and failed live, three runs out of three, which is the whole reason
  // the live run is not optional.
  const fresh = await open('FreshCo', {});
  await wait(250);
  const freshMe = mine(fresh);
  check('snapshot carries my own blob', !!freshMe,
    freshMe ? `count=${freshMe.count}` : 'missing');
  check('a new company spawns protected', freshMe && freshMe.safe === true,
    freshMe ? `safe=${freshMe.safe}` : 'no snapshot');
  fresh.sock.close();

  // Eat for 10 s. A company that chases the nearest dot must gain valuation and size.
  const drive = setInterval(() => { chase(a); chase(b); }, 50);
  await wait(10000);
  clearInterval(drive);

  const after = mine(a);
  check('spawn protection has expired by now', after && after.safe === false,
    after ? `safe=${after.safe}` : 'n/a');
  check('capital was absorbed', after && after.count >= 5, `count=${after ? after.count : 'n/a'}`);
  check('absorbing capital grew the company', after && after.scale > 1.0,
    `scale=${after ? after.scale.toFixed(3) : 'n/a'}`);
  check('growth decelerates, it does not run away', after && after.scale < 4.0,
    `scale=${after ? after.scale.toFixed(3) : 'n/a'}`);
  check('nothing left the board',
    after && after.x >= 0 && after.x <= R.WORLD && after.y >= 0 && after.y <= R.WORLD,
    after ? `${after.x},${after.y}` : 'n/a');
  const roundLen = Number(process.env.ROUND_SECONDS || 600);
  check('the round clock is counting down', a.last.k < roundLen && a.last.k > 0, `k=${a.last.k}`);

  const busy = await (await fetch(`${BASE}/lobbies`)).json();
  check('one live market per connected player', busy.live >= 3,
    `live=${busy.live} capacity=${busy.capacity}`);

  // Bots must actually take each other over, or the market never consolidates.
  // Counting the roster never tested that; watching it CHURN does. Any id that
  // leaves the roster was acquired, because nothing else removes a bot mid-round.
  //
  // 🔴 TWELVE seconds, up from four, and the reason is the cull rather than a
  // flaky machine. Takeovers per second scale with the NUMBER of companies, not
  // with their density: half as many balls is half as many collisions even on a
  // board shrunk to keep them as close together. Measured over four runs at 50
  // companies, a 4 s window caught 0, 0, 2 and 4 takeovers, so the check failed
  // one run in three on a board that was working perfectly. 12 s puts the
  // expected count near 7 and the false failure rate under a per cent.
  const rosterBefore = new Set(a.meta.map((m) => m.i));
  await wait(12000);
  const gone = a.meta.length ? [...rosterBefore].filter((i) => !a.meta.some((m) => m.i === i)) : [];
  check('bots are acquiring each other', gone.length > 0,
    `${gone.length} of ${rosterBefore.size} companies were taken over in 12 s`);

  // --- the attacks that an audit found, each now a permanent regression test ---
  // A malformed percent escape used to throw URIError straight out of the HTTP
  // handler and kill the process, every lobby with it.
  const malformed = [];
  for (const u of ['%', '%zz', 'a%', '%E0%A4%A']) {
    try { malformed.push((await fetch(`${BASE}/${u}`)).status); } catch { malformed.push(0); }
  }
  // Direct to Node this is a 400. Through Railway's edge it is a 502, because the
  // proxy refuses the malformed URL before Node ever sees it, which is why this
  // crash was latent in production rather than live. Either way it must be
  // REFUSED and the process must survive, and the second half is the real check.
  check('a malformed URL escape is refused',
    malformed.every((s) => s >= 400), `statuses=${malformed.join(',')}`);
  check('the server is still up after those', (await fetch(`${BASE}/healthz`)).ok);
  check('POST is refused', (await fetch(`${BASE}/lobbies`, { method: 'POST' })).status === 405);

  // Number('1e400') is Infinity, and Infinity/hypot(Inf,Inf) is NaN. A NaN
  // position beat every comparison in the simulation at once: ate every dot
  // per tick, could not be acquired, and serialised as null into the snapshot.
  const evil = await open('EvilCo', {});
  await wait(600);
  const evilBefore = mine(evil);
  for (const bad of [1e400, 'Infinity', NaN, '-1e400']) {
    evil.sock.send(`{"t":"in","dx":${JSON.stringify(bad) || 'null'},"dy":1,"b":false}`);
  }
  evil.sock.send('{"t":"in","dx":1e400,"dy":1e400,"b":false}');
  await wait(2500);
  const evilAfter = mine(evil);
  check('a non-finite direction cannot move a company off the number line',
    evilAfter && Number.isFinite(evilAfter.x) && Number.isFinite(evilAfter.y),
    evilAfter ? `${evilAfter.x},${evilAfter.y}` : 'blob gone');
  check('a non-finite direction cannot farm the whole board',
    evilAfter && (evilAfter.count - (evilBefore ? evilBefore.count : 0)) < 50,
    evilAfter ? `count=${evilAfter.count}` : 'n/a');
  check('the snapshot still carries six finite ints per company',
    evil.last.b.length % 6 === 0 && evil.last.b.every((v) => Number.isFinite(v)),
    `len=${evil.last.b.length}`);
  evil.sock.close();

  // --- sprint burns capital ----------------------------------------------------
  // 🔴 The arithmetic is proven IN PROCESS, against the same rules.js the server
  // runs, because it cannot be proven over the wire: the burn is a PERCENTAGE, and
  // a company that has been alive for ten seconds is worth $12B, so 0.5% of it is
  // $0.06B and rounds to zero on a wire that carries whole billions. Testing it at
  // a realistic $2T valuation needs a company set to one, which only a local Lobby
  // allows. The live socket below proves the flag and the plumbing.
  {
    const lab = new Lobby('lab', 'Lab');
    const sub = lab.makeBlob({ name: 'BurnCo', colour: 0 });
    sub.count = 2000;          // $2.001T
    sub.scale = 8;
    sub.boost = true;
    const c0 = sub.count, s0 = sub.scale;
    // Exactly one charge: 2 s of held sprint at the tick rate.
    for (let i = 0; i < Math.round(R.BOOST_BURN_INTERVAL / DT); i++) lab.burnForBoost(sub);
    const burned = c0 - sub.count;
    check('sprinting for 2 s burns 0.5% of the whole pile',
      Math.abs(burned - (1 + c0) * R.BOOST_BURN_RATE) < 0.01,
      `burned=${burned.toFixed(3)} of ${c0}`);
    check('the disc shrinks with the valuation', sub.scale < s0 && sub.scale > s0 * 0.99,
      `scale ${s0} -> ${sub.scale.toFixed(4)}`);
    check('a company can never burn below a fresh float',
      R.shrunkByBurn(1.0, 0.9) === 1.0 && R.shrunkByBurn(1.4, 1) === 1.0);

    // Tapping the button must not dodge the charge. The held time accumulates and
    // is never reset by letting go, or 19 taps a second is a free permanent 1.7x.
    const tap = lab.makeBlob({ name: 'TapCo', colour: 1 });
    tap.count = 2000;
    const t0 = tap.count;
    for (let i = 0; i < 80; i++) {
      tap.boost = (i % 2 === 0);
      if (tap.boost) lab.burnForBoost(tap);
    }
    check('tapping sprint still pays for the time it was held', t0 - tap.count > 0,
      `paid=${(t0 - tap.count).toFixed(3)} over 40 held ticks`);

    // A brand new company sprints free: 0.5% of $1B is $0.005B and there is no
    // capital to take it from. It must not go negative.
    const tiny = lab.makeBlob({ name: 'TinyCo', colour: 2 });
    tiny.boost = true;
    for (let i = 0; i < 200; i++) lab.burnForBoost(tiny);
    check('a $1B company cannot be burned into debt', tiny.count === 0 && tiny.scale === 1,
      `count=${tiny.count} scale=${tiny.scale}`);
  }

  // --- the valuation format --------------------------------------------------
  // 🔴 This format exists TWICE: R.valuationText here and Scripts/overlay.gd's
  // valuation_text, which is what a player actually reads. Nothing can make one
  // call the other across the engine boundary, so the only defence against drift
  // is pinning the exact strings. If this fails, one of the two moved.
  {
    const cases = [[0, '$1B'], [214, '$215B'], [998, '$999B'], [999, '$1.00T'],
      [1009, '$1.01T'], [2149, '$2.15T'], [999999, '$1000.00T']];
    const wrong = cases.filter(([n, want]) => R.valuationText(n) !== want)
      .map(([n, want]) => `${n}->${R.valuationText(n)} want ${want}`);
    check('the valuation format is exactly what the client draws', wrong.length === 0,
      wrong.join('; ') || `${cases.length} cases`);
    check('a fractional valuation is rounded, never shown as a decimal',
      R.valuationText(214.4) === '$215B' && R.valuationText(213.6) === '$215B',
      `${R.valuationText(214.4)} ${R.valuationText(213.6)}`);
  }

  // --- the acquisition rule ------------------------------------------------------
  // 🔴 Proven against rules.js itself, because the rule is a PERCENTAGE now and
  // the interesting cases are two companies within 5% of each other at a size
  // that takes a whole round to reach. Waiting for that to happen on a live
  // board is not a test, it is a hope.
  {
    check('two freshly floated companies cannot acquire each other',
      !R.canAcquire(0, 0) && !R.canAcquire(1, 0) && !R.canAcquire(4, 0),
      'the $5B floor holds at the bottom');
    check('the floor binds below $100B and the percentage above it',
      R.acquireGap(0) === R.ACQUIRE_MIN_GAP && R.acquireGap(99) === R.ACQUIRE_MIN_GAP
      && R.acquireGap(999) > R.ACQUIRE_MIN_GAP,
      `$1B->${R.acquireGap(0)} $100B->${R.acquireGap(99)} $1T->${R.acquireGap(999).toFixed(2)}`);
    check('a giant cannot take a near-peer it could have swallowed under a flat gap',
      !R.canAcquire(500, 480) && R.canAcquire(500, 470),
      '$501B vs $481B is inside 5%, vs $471B is not');
    check('the gap is measured against the ACQUIRER, so being small is no shield',
      R.canAcquire(6, 0) && !R.canAcquire(0, 6),
      'asymmetric by construction');
  }

  // --- you play AS the company you picked, not beside it ---------------------------
  {
    const lab = new Lobby('lab2', 'Lab2');
    lab.balanceBots();
    const beforeN = lab.blobs.size;
    lab.addHuman(null, 'Me', '', 2);
    lab.balanceBots();
    const wearing = [...lab.blobs.values()].filter((x) => x.logo === 2);
    check('picking a company removes the bot that was running it',
      wearing.length === 1 && wearing[0].human === true,
      `${wearing.length} blobs wearing logo 2`);
    check('the board is still every company exactly once',
      lab.blobs.size === beforeN && new Set([...lab.blobs.values()].map((x) => x.logo)).size === R.FIELD_SIZE,
      `blobs=${lab.blobs.size} distinct marks=${new Set([...lab.blobs.values()].map((x) => x.logo)).size}`);

    // The trophy case. Capped at what the card can show, exact in what it counts.
    const me = [...lab.blobs.values()].find((x) => x.human);
    me.count = 4000;
    // Every takeover tells the player straight away, for the banner over the
    // ball. A stub socket is all acquire() needs to send one.
    const tookFrames = [];
    me.sock = { readyState: 1, bufferedAmount: 0, send: (raw) => tookFrames.push(JSON.parse(raw)) };
    for (let i = 0; i < 30; i++) {
      const prey = lab.makeBlob({ name: 'Prey' + i, logo: -1, colour: 0 });
      prey.count = i * 10;
      lab.acquire(me, prey);
    }
    const lastTook = tookFrames[tookFrames.length - 1] || {};
    check('every takeover sends the player a took frame, the moment it lands',
      tookFrames.length === 30 && tookFrames.every((f) => f.t === 'took'),
      `${tookFrames.length} frames for 30 takeovers`);
    check('the took frame names the company, its mark and the price it was taken at',
      lastTook.n === 'Prey29' && lastTook.g === -1 && lastTook.v === '$291B',
      JSON.stringify(lastTook));
    const botA = lab.makeBlob({ name: 'BotA', logo: -1, colour: 0 });
    const botB = lab.makeBlob({ name: 'BotB', logo: -1, colour: 0 });
    botA.count = 500;
    const before = tookFrames.length;
    lab.acquire(botA, botB);
    check('a bot taking a bot tells nobody', tookFrames.length === before,
      `${tookFrames.length - before} frames`);
    me.sock = null;
    check('every takeover is counted, even past what the card can name',
      me.tookCount === 30 && me.taken.length <= 12,
      `counted=${me.tookCount} named=${me.taken.length}`);
    check('the card names the BIGGEST takeovers, not the most recent',
      me.taken.every((x, i) => i === 0 || me.taken[i - 1].m >= x.m)
      && me.taken[0].m === 1 + 290,
      `top=$${me.taken[0].m}B`);
    // 🔴 The POPULATED close frame, over the real close() path. The live bell
    // test only ever fires for an idle client that took nobody, so the empty
    // branch is the only one a round can prove; the twelve chips and the total
    // would otherwise ship having been rendered from a hand-written payload and
    // never once produced by the server. A stub socket is all close() needs:
    // rawSend checks readyState and bufferedAmount and then calls send.
    let frame = null;
    me.sock = { readyState: 1, bufferedAmount: 0, send: (raw) => { frame = JSON.parse(raw); } };
    lab.close(Date.now());
    check('the close frame carries the trophy case the takeovers built',
      !!frame && frame.t === 'close' && frame.took === 30 && frame.mine.length === 12,
      frame ? `took=${frame.took} named=${frame.mine.length} worth=${frame.worth}` : 'no frame');
    check('the chips are the twelve biggest, formatted like every other price',
      !!frame && frame.mine.every((x, i) => x.v.startsWith('$')
        && (i === 0 || Number(frame.mine[i - 1].v.slice(1, -1)) >= Number(x.v.slice(1, -1))))
      && frame.mine[0].v === '$291B',
      frame ? frame.mine.map((x) => x.v).join(' ') : 'no frame');
    // 30 companies at 1 + 0,10,20..290 is 30 + 4350 = 4380, which is past the
    // billion tier, so the total also proves the trillion format on a number the
    // simulation actually produced rather than on a hand-picked constant.
    check('the total is every takeover, not just the named ones', !!frame && frame.worth === '$4.38T',
      frame ? frame.worth : 'no frame');
    me.sock = null;

    check('the bell clears the trophy case',
      (lab.reset(Date.now()), me.tookCount === 0 && me.taken.length === 0),
      `after reset counted=${me.tookCount}`);
  }

  // --- what the global leaderboard is told, and when ----------------------------
  // 🔴 THE HIGH SCORE HAS TO SURVIVE BEING ACQUIRED, and that is the whole reason
  // `peak` exists. Being taken refounds a player at $1B with minutes still on
  // the clock, so a leaderboard built on the closing valuation would rank a
  // player who reached $500B and was eaten at 9:58 below one who idled all
  // round. This proves the number the board stores is the one the player
  // actually reached, over the real step() and acquire() and revive() path.
  {
    const filed = [];
    const lab = new Lobby('lab-board', 'Board Lab', (row) => filed.push(row));
    const PID = '11111111-2222-4333-8444-555555555555';
    const stub = { readyState: 1, bufferedAmount: 0, send: () => {} };
    const me = lab.addHuman(stub, 'BigCo', '', 7, PID);
    me.count = 500;
    const t0 = Date.now();
    lab.step(t0);
    check('the peak is read off the live simulation, not handed in',
      me.peak >= 500, `peak=${Math.round(me.peak)} count=${Math.round(me.count)}`);

    const shark = lab.makeBlob({ name: 'Shark', logo: -1, colour: 0 });
    shark.count = 50000;
    lab.acquire(shark, me);
    me.respawnAt = 0;
    lab.step(t0 + 50);
    check('being acquired refounds the company and does NOT erase the high score',
      me.count === 0 && me.peak >= 500,
      `count=${Math.round(me.count)} peak=${Math.round(me.peak)}`);

    const reached = Math.round(me.peak);
    lab.endsAt = t0;
    lab.step(t0 + 100);
    check('the closing bell files exactly one row for the one human',
      filed.length === 1, `${filed.length} rows filed`);
    const row = filed[0] || {};
    check('the filed row is the PEAK, not what survived the last takeover',
      row.peak === R.BASE_VALUATION_B + reached && row.pid === PID && row.name === 'BigCo',
      `peak=$${row.peak}B pid=${row.pid ? 'set' : 'MISSING'} name=${row.name}`);
    check('the filed row carries the rank and the field it was won in',
      typeof row.field === 'number' && row.field > 0 && row.secs === R.ROUND_SECONDS,
      `rank=${row.rank} field=${row.field} secs=${row.secs}`);

    // A client too old to send a player id, or one in a browser that refuses to
    // store one. The round is played and simply not recorded; nothing throws and
    // no row is invented.
    const filed2 = [];
    const solo = new Lobby('lab-nopid', 'No Pid Lab', (row) => filed2.push(row));
    const anon = solo.addHuman(stub, 'Anon', '', 3, '');
    anon.count = 90;
    solo.endsAt = Date.now();
    solo.step(Date.now() + 10);
    check('a player with no id plays the round and files nothing',
      filed2.length === 0, `${filed2.length} rows filed`);

    // The privacy boundary, over the real publisher. A player id is the only
    // identity this game has and it must never leave the process.
    const shown = store.publish([{ pid: PID, name: 'BigCo', peak: 42 }], PID);
    const other = store.publish([{ pid: PID, name: 'BigCo', peak: 42 }], 'ffffffff-2222-4333-8444-555555555555');
    check('a published row carries a tag and never a player id',
      !('pid' in shown[0]) && /^[0-9a-f]{4}$/.test(shown[0].tag) && shown[0].peak === 42,
      JSON.stringify(shown[0]));
    check('a row is flagged as yours only for you',
      shown[0].you === true && other[0].you === false && other[0].tag === shown[0].tag,
      `me=${shown[0].you} them=${other[0].you}`);
    check('a player id that is neither a short code nor a v4 UUID is refused before it reaches SQL',
      store.cleanPid(PID) === PID && store.cleanPid('K7QM-3XPD-9RWT') === 'K7QM-3XPD-9RWT'
      && store.cleanPid('k7qm-3xpd-9rwt') === '' && store.cleanPid('K7QM-3XPD-9RWU') === ''
      && store.cleanPid('../../etc') === ''
      && store.cleanPid("' OR 1=1--") === '' && store.cleanPid(null) === ''
      && store.cleanPid('x'.repeat(4000)) === '',
      'hostile shapes and a lowercase or U-bearing code rejected, both good forms kept');
    check('a typed player id forgives case, spacing, and I, L and O for 1, 1 and 0',
      store.typedPid(' k7qm 3xpd 9rwi ') === 'K7QM-3XPD-9RW1'
      && store.typedPid('K7QO3XPD9RWL') === 'K7Q0-3XPD-9RW1'
      && store.typedPid('K7QU-3XPD-9RWT') === '' && store.typedPid('K7QM-3XPD') === '',
      `${store.typedPid(' k7qm 3xpd 9rwi ')}`);

    // --- a player who leaves before the bell ------------------------------------
    // 🔴 Before this, only a player who sat through all ten minutes was ever
    // filed, and the live board held two rounds after four days. leave() is the
    // path index.js calls when a socket closes.
    const filed3 = [];
    const lab3 = new Lobby('lab-leave', 'Leave Lab', (row) => filed3.push(row));
    const start3 = lab3.endsAt - R.ROUND_SECONDS * 1000;
    const quick = lab3.addHuman(stub, 'QuickCo', '', 4, PID);
    quick.count = 40; quick.peak = 40;
    check('a player who leaves inside the first seconds files nothing',
      lab3.leave(quick, start3 + 5000) === false && filed3.length === 0, `${filed3.length} rows`);
    const stay = lab3.addHuman(stub, 'StayCo', '', 5, PID);
    stay.count = 40; stay.peak = 60;
    // Inside the round at any ROUND_SECONDS this suite is run with.
    const midway = Math.min(120, R.ROUND_SECONDS - 5);
    const went = lab3.leave(stay, start3 + midway * 1000);
    const r3 = filed3[0] || {};
    check('a player who leaves mid-round files the round so far',
      went === true && filed3.length === 1 && r3.secs === midway && r3.peak === 61
      && r3.final === 41 && r3.pid === PID,
      `secs=${r3.secs} peak=$${r3.peak}B final=$${r3.final}B`);
    // A rank is where you FINISHED. The same player at the bell keeps one.
    const atBell = lab3.resultFor(stay, lab3.standings(), R.ROUND_SECONDS);
    check('a round left before the bell has no rank, and one that reached it does',
      r3.rank === null && Number.isInteger(atBell.rank) && atBell.rank >= 1,
      `left=${r3.rank} bell=${atBell.rank}`);
    check('the same player cannot be filed twice on the way out',
      lab3.leave(stay, start3 + 121000) === false && filed3.length === 1, `${filed3.length} rows`);
    const idle3 = lab3.addHuman(stub, 'IdleCo', '', 6, PID);
    check('a player who never grew files nothing',
      lab3.leave(idle3, start3 + 120000) === false && filed3.length === 1, `${filed3.length} rows`);
    const late = lab3.addHuman(stub, 'LateCo', '', 8, PID);
    late.count = 10; late.peak = 10;
    lab3.closedAt = Date.now();
    check('leaving after the bell files nothing: the bell already did',
      lab3.leave(late, start3 + 125000) === false && filed3.length === 1, `${filed3.length} rows`);
  }

  // --- accounts, in process ---------------------------------------------------------
  {
    const hash = await accounts.hashPassword('correct horse');
    const again = await accounts.hashPassword('correct horse');
    check('a password is stored as a salted scrypt hash at p=5, never as itself',
      hash.startsWith('s2$') && !hash.includes('correct horse') && hash !== again,
      'two hashes of one password differ');
    check('the right password passes and a near miss does not',
      await accounts.checkPassword('correct horse', hash)
      && !(await accounts.checkPassword('correct hors', hash))
      && !(await accounts.checkPassword('correct horse', 'junk')));
    // The first accounts were hashed at p=1 under 's1'. They must still log in.
    const salt1 = crypto.randomBytes(16);
    const key1 = crypto.scryptSync('correct horse', salt1, 32, { N: 16384, r: 8, p: 1 });
    const old1 = `s1$${salt1.toString('base64')}$${key1.toString('base64')}`;
    check('a password hashed before p=5 still checks, and still refuses a near miss',
      await accounts.checkPassword('correct horse', old1)
      && !(await accounts.checkPassword('correct hors', old1)));
    check('an email with a control character in it is not an email',
      accounts.cleanEmail('wo\u0000lo@example.com') === ''
      && accounts.cleanEmail('wolo@exam\u0007ple.com') === ''
      && accounts.cleanEmail(' Wolo@Example.com ') === 'wolo@example.com');
    // One email, tried from a different address every time: the per-address
    // bucket never fills, and the per-email one still stops it. With no
    // database in this process the tries before that answer 503.
    const [emailMax] = accounts.LIMITS['login-email'];
    const target = `throttle-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.invalid`;
    let lastTry = null;
    for (let i = 0; i <= emailMax; i++) {
      lastTry = await accounts.handle('/api/login', { email: target, password: 'not the password' },
        `198.51.100.${i + 1}`);
    }
    check(`one email gets ${emailMax} login tries per window, from any number of addresses`,
      lastTry.status === 429, `try ${emailMax + 1} answered ${lastTry.status}`);
    // The bucket behind the early-exit cap. This tests the bucket only: the line
    // in index.js that consults it (fileFor) only runs behind a proxy that sends
    // x-forwarded-for, and turning that on for this suite would also turn on the
    // eight-sockets-per-address cap it opens more sockets than.
    const [leaveMax] = accounts.LIMITS.leave;
    const addr = `203.0.113.${Math.floor(Math.random() * 200) + 1}-${Date.now()}`;
    let overAt = 0;
    for (let i = 1; i <= leaveMax + 1 && !overAt; i++) if (accounts.limited('leave', addr)) overAt = i;
    check(`the early-exit bucket takes ${leaveMax} rounds from one address, then refuses`,
      overAt === leaveMax + 1, `first refused: ${overAt}`);
    check('an email goes back masked', accounts.maskEmail('wolo@example.com') === 'w***@example.com',
      accounts.maskEmail('wolo@example.com'));
    const nm = accounts.cleanPlayerName('  a\u202eb   c\u0000 ' + 'x'.repeat(40));
    check('a player name loses direction and control characters and is capped at 16',
      [...nm].length <= 16 && !/[\u202e\u0000]/.test(nm) && nm.startsWith('ab c'), JSON.stringify(nm));
  }

  // --- eating capital is not an acquisition --------------------------------------
  // 🔴 The banner says "You acquired", and only taking over another company earns
  // it. A dot of capital is $1B of growth, never a company, and must stay silent.
  {
    const lab = new Lobby('dot-lab', 'Dot Lab');
    const sent = [];
    const h = lab.makeBlob({ human: true, name: 'DotCo', colour: 0,
      sock: { readyState: 1, bufferedAmount: 0, send: (raw) => sent.push(JSON.parse(raw)) } });
    const d = lab.dots.find((x) => x.x > 200 && x.x < R.WORLD - 200 && x.y > 200 && x.y < R.WORLD - 200);
    h.x = d.x; h.y = d.y; h.inputAt = Date.now();
    lab.step(Date.now());
    check('eating capital grows the company and never sends a took frame',
      h.count >= 1 && !sent.some((f) => f.t === 'took'),
      `count=${h.count} frames=${sent.map((f) => f.t).join(',') || 'none'}`);
  }

  // --- a browser tab that stops talking stops playing ---------------------------
  // 🔴 Proven in process, not over a socket: the live version would have to idle
  // for IDLE_MS while 199 bots hunt the test company, and a check that fails when
  // an unrelated bot eats you is a check nobody will trust. This is deterministic.
  {
    const lab = new Lobby('idle-lab', 'Idle Lab');
    const h = lab.makeBlob({ human: true, name: 'IdleCo', colour: 0 });
    h.count = 2000;              // too big for anything on the board to acquire
    h.dx = 1; h.dy = 0; h.boost = true;
    const t = Date.now();
    h.inputAt = t;
    const x0 = h.x;
    lab.step(t);
    check('a client that is talking moves and sprints', h.x !== x0 && h.boost === true,
      `x ${Math.round(x0)} -> ${Math.round(h.x)} boost=${h.boost}`);

    // Now say nothing at all, which is exactly what a backgrounded tab does.
    h.boost = true; h.dx = 1; h.dy = 0;
    const later = t + IDLE_MS + 100;
    lab.step(later);
    const parked = h.x;
    lab.step(later + 50);
    check('a client that goes quiet stops sprinting and stops moving',
      h.boost === false && h.dx === 0 && h.x === parked,
      `boost=${h.boost} dx=${h.dx} x=${Math.round(h.x)}`);
  }

  // --- the sprint flag reaches the wire ----------------------------------------
  const sp = await open('SprintCo', {});
  await wait(600);
  sp.sock.send(JSON.stringify({ t: 'in', dx: 1, dy: 0, b: true, v: 4000 }));
  await wait(400);
  check('holding sprint sets bit 1 of the flags', mine(sp) && mine(sp).boost === true,
    `flags boost=${mine(sp) ? mine(sp).boost : 'n/a'}`);
  sp.sock.send(JSON.stringify({ t: 'in', dx: 1, dy: 0, b: false, v: 4000 }));
  await wait(400);
  check('releasing sprint clears it', mine(sp) && mine(sp).boost === false);

  // --- the snapshot is cut to the view ------------------------------------------
  // 200 companies is 4.4 KB a frame, 86 KB/s per player. Everything past the edge
  // of the window is bytes nobody can see.
  sp.sock.send(JSON.stringify({ t: 'in', dx: 1, dy: 0, b: false, v: 9000 }));
  await wait(400);
  const wide = sp.last.b.length / 6;
  sp.sock.send(JSON.stringify({ t: 'in', dx: 1, dy: 0, b: false, v: 400 }));
  await wait(400);
  const tight = sp.last.b.length / 6;
  check('a narrow view is sent far fewer companies than a wide one', tight < wide / 3,
    `narrow=${tight} wide=${wide}`);
  check('a culled snapshot still carries the player themselves', !!mine(sp));
  check('rank and field size come from the server, not from the culled list',
    sp.last.f >= R.FIELD_SIZE - 5 && sp.last.f <= R.FIELD_SIZE + 1
    && sp.last.r >= 1 && sp.last.r <= R.FIELD_SIZE + 1,
    `rank=${sp.last.r} of ${sp.last.f}`);

  // A view radius is an amplification lever, so it is hostile input.
  for (const bad of [1e400, -1, 'huge', null, 1e9]) {
    sp.sock.send(`{"t":"in","dx":1,"dy":0,"b":false,"v":${JSON.stringify(bad)}}`);
  }
  await wait(500);
  check('a hostile view radius is clamped, not obeyed',
    sp.last.b.length % 6 === 0 && sp.last.b.length / 6 <= R.FIELD_SIZE + 1,
    `companies=${sp.last.b.length / 6}`);
  check('the server survives a hostile view radius', (await fetch(`${BASE}/healthz`)).ok);

  // --- the live leaderboard ------------------------------------------------------
  // 🔴 It is NOT culled to the view, and that is the whole point: a leaderboard
  // that only lists companies you can already see is not a leaderboard. The
  // narrow view above is still in force here, so the count proves it.
  {
    const lb = sp.lb;
    check('the snapshot carries a live leaderboard', Array.isArray(lb) && lb.length > 0,
      lb ? `entries=${lb.length / 2}` : 'never arrived');
    if (Array.isArray(lb) && lb.length) {
      check('the leaderboard is pairs of id and valuation, richest first',
        lb.length % 2 === 0 && lb.every((v) => Number.isFinite(v))
        && lb.filter((_, i) => i % 2 === 1).every((v, i, a) => i === 0 || a[i - 1] >= v),
        `${lb.length / 2} rows`);
      // Every id has to be nameable from the meta frame or the client draws a
      // blank row. meta is the whole roster and is never view-culled.
      const known = new Set(sp.meta.map((e) => e.i));
      check('every leader can be named from the roster the client already has',
        lb.filter((_, i) => i % 2 === 0).every((id) => known.has(id)),
        `roster=${known.size}`);
      check('the leaderboard is not cut to the view the way the snapshot is',
        lb.length / 2 > sp.last.b.length / 6 || lb.length / 2 === 10,
        `leaders=${lb.length / 2} visible=${sp.last.b.length / 6}`);
    }
  }
  sp.sock.close();

  // --- the brand logo pack -------------------------------------------------------
  // 🔴 These four are SKIPPED when the web export is not beside the server, which
  // is the normal state of a bare `node index.js` checkout. They are covered by
  // the Docker run and the Railway run, and by nothing else: a green local run
  // does NOT mean the picker shipped.
  const indexRes = await fetch(`${BASE}/`);
  if (!indexRes.ok) {
    // 🔴 No count in this line. It said "8 static-asset checks" and the block
    // has grown twice since; a number in a message nothing computes is a number
    // that goes quietly wrong, which is the same defect as a magic number in a
    // build gate. Say what is skipped and why, not how many.
    console.log('SKIP  every check that needs the web export: no build beside this '
      + `server (GET / is ${indexRes.status}). Run them against the image or Railway.`);
  } else {
    const html = await indexRes.text();
    const logosRes = await fetch(`${BASE}/logos.js`);
    const logosBody = logosRes.ok ? await logosRes.text() : '';
    check('logos.js is served', logosRes.ok, `status=${logosRes.status}`);
    let pack = [];
    try {
      pack = JSON.parse(logosBody.slice(logosBody.indexOf('['), logosBody.lastIndexOf(']') + 1));
    } catch { pack = []; }
    // 🔴 The picker and the server MUST agree row for row, or a player picks
    // Stripe and a Databricks mark turns up on their ball. Same generator writes
    // both files; this is what proves one was not shipped stale.
    check('the picker pack is the same list the server names its companies from',
      pack.length === R.COMPANIES.length
      && pack.every((e, i) => e.n === R.COMPANIES[i].n && e.f === R.COMPANIES[i].f),
      `picker=${pack.length} server=${R.COMPANIES.length}`);
    check('no SVG document is ever built from the pack',
      !/<svg|image\/svg/i.test(logosBody));
    // 🔴 Index 0 is the top left tile in the picker grid, and the host of the
    // hackathon this was built for belongs in it. Asserted rather than trusted
    // to the order of a hand-written list in a Python script.
    check('PreStocks is the first company on the board and the first tile',
      R.COMPANIES[0].n === 'PreStocks' && pack.length > 0 && pack[0].n === 'PreStocks',
      `server=${R.COMPANIES[0].n} picker=${pack[0] ? pack[0].n : 'none'}`);
    // Order matters: login.js reads window.AGARIPO_LOGOS as it parses.
    check('logos.js is loaded BEFORE login.js',
      html.indexOf('logos.js') !== -1 && html.indexOf('logos.js') < html.indexOf('login.js'),
      `logos@${html.indexOf('logos.js')} login@${html.indexOf('login.js')}`);

    // Thumbnails: first, last and one in the middle, plus the PNG magic, because
    // a 404 page served with a 200 would satisfy `res.ok` on its own.
    const probes = [0, Math.floor(R.COMPANIES.length / 2), R.COMPANIES.length - 1];
    const tiles = await Promise.all(probes.map(async (i) => {
      const r = await fetch(`${BASE}/logos/${R.COMPANIES[i].f}.png`);
      if (!r.ok) return { i, ok: false, status: r.status };
      const buf = Buffer.from(await r.arrayBuffer());
      return { i, ok: buf.subarray(0, 8).equals(PNG_MAGIC), w: buf.readUInt32BE(16), bytes: buf.length };
    }));
    check('the picker thumbnails are served as real PNGs', tiles.every((t) => t.ok),
      tiles.map((t) => `${t.i}:${t.ok ? t.w + 'px' : 'status ' + t.status}`).join(' '));
    check('a thumbnail is 96x96, the size the grid draws',
      tiles.every((t) => t.w === 96), tiles.map((t) => t.w).join(','));

    // 🔴 The rules exist in three places: rules.js runs them, login.js promises
    // them in English and overlay.gd repeats the sprint cost. Nothing can make
    // one call the other, so change BOOST_BURN_RATE and the login card lies
    // silently. This is the same defence smoke.js already applies to the
    // valuation FORMAT, extended to the numbers that are easier to get wrong.
    const loginRes = await fetch(`${BASE}/login.js`);
    const loginBody = loginRes.ok ? await loginRes.text() : '';
    // The round length only when this run keeps the real one. A server started
    // with ROUND_SECONDS to reach the bell quickly runs a round the card rightly
    // does not describe, and "1.25 minutes" missing from it is not a finding.
    const roundOverride = process.env.ROUND_SECONDS !== undefined;
    if (roundOverride) {
      console.log(`INFO  round length not checked on the card: this run sets ROUND_SECONDS=${R.ROUND_SECONDS}`);
    }
    const promised = [
      `$${R.BASE_VALUATION_B}B`,
      `${R.CELL_FOOD_LIMIT} raises`,
      `${R.ACQUIRE_MIN_FRACTION * 100}% less than you`,
      `$${R.ACQUIRE_MIN_GAP}B`,
      `${R.BOOST_BURN_RATE * 100}% of your valuation every ${R.BOOST_BURN_INTERVAL} seconds`,
      ...(roundOverride ? [] : [`${R.ROUND_SECONDS / 60} minutes`]),
      // 🔴 The FRAGMENT, not the number, and that distinction is the finding.
      // The card writes the board size as companies.length at runtime, out of
      // the same generated logos.js the picker is built from, so the literal
      // "50" is nowhere in its source and asserting it failed on a correct
      // build. What can actually go stale is the two lists disagreeing, and the
      // picker-pack check above already pins that, row for row.
      ' real pre-IPO companies on the board',
    ];
    const missing = promised.filter((t) => loginBody.indexOf(t) === -1);
    check('the login card promises the rules the server actually runs',
      loginRes.ok && missing.length === 0,
      missing.length ? `not on the card: ${missing.join(' | ')}` : promised.length + ' checked');

    const icon = await fetch(`${BASE}/index.icon.png`);
    const iconBuf = icon.ok ? Buffer.from(await icon.arrayBuffer()) : Buffer.alloc(0);
    check('the tab icon is the AgarIPO mark, not the engine logo',
      icon.ok && iconBuf.subarray(0, 8).equals(PNG_MAGIC) && iconBuf.readUInt32BE(16) === 64,
      icon.ok ? `${iconBuf.readUInt32BE(16)}px ${iconBuf.length}B` : `status=${icon.status}`);
    // 🔴 The app icon, not a wordmark PNG. The wordmark is live text on the card
    // now (the O is the mark, drawn in CSS from the icon's own ratios), so there
    // is no wordmark file left to fetch and this check used to name one.
    const light = await fetch(`${BASE}/brand/agaripo-icon-512-light.png`);
    const lightBuf = light.ok ? Buffer.from(await light.arrayBuffer()) : Buffer.alloc(0);
    check('the light treatment of the mark ships beside the game',
      light.ok && lightBuf.subarray(0, 8).equals(PNG_MAGIC) && lightBuf.readUInt32BE(16) === 512,
      light.ok ? `${lightBuf.readUInt32BE(16)}px ${lightBuf.length}B` : `status=${light.status}`);

    // --- the leaderboard PAGE, which needs the static export like everything
    // else in this block. The API checks below do not and live outside it.
    const page = await fetch(`${BASE}/leaderboard`);
    const pageBody = page.ok ? await page.text() : '';
    check('/leaderboard serves a page, not a download',
      page.ok && /text\/html/.test(page.headers.get('content-type') || ''),
      `status=${page.status} type=${page.headers.get('content-type')}`);
    // 🔴 A trailing slash must REDIRECT, not serve. Every reference in that file
    // is relative, so served at /leaderboard/ the stylesheet, the script and
    // every mark resolve one directory too deep and 404.
    const slash = await fetch(`${BASE}/leaderboard/`, { redirect: 'manual' });
    check('a trailing slash redirects instead of serving a page with no CSS',
      slash.status === 301 && slash.headers.get('location') === '/leaderboard',
      `status=${slash.status} location=${slash.headers.get('location')}`);
    check('the leaderboard page wears the same wordmark as the game',
      pageBody.includes('id="ipo-wordmark"') && pageBody.includes('class="wm-o"'),
      'the same markup login.js builds');
    // The drawn O is not in the text stream, so something has to put it back.
    // role="img" on the h1 is the obvious answer and the wrong one: `img` is not
    // an allowed role on a heading and it removes the page's only h1 from the
    // accessibility tree.
    check('the drawn O is hidden from readers and replaced by a real one',
      pageBody.includes('class="wm-o" aria-hidden="true"')
      && pageBody.includes('class="wm-sr">O<')
      && !/id="ipo-wordmark"[^>]*role=/.test(pageBody),
      'aria-hidden on the mark, a visually hidden O beside it, no role on the h1');
    check('the leaderboard page loads the game\'s own stylesheet for the palette',
      pageBody.includes('href="login.css"'), 'one palette, one file');

    const lbCss = await fetch(`${BASE}/leaderboard.css`);
    const lbJs = await fetch(`${BASE}/leaderboard.js`);
    const lbJsBody = lbJs.ok ? await lbJs.text() : '';
    check('the leaderboard page ships its own script and stylesheet',
      lbCss.ok && lbJs.ok, `css=${lbCss.status} js=${lbJs.status}`);

    // 🔴 THE PAGE'S OWN money() IS RUN AND COMPARED WITH rules.valuationText.
    // The first cut of this check grepped the served source for two hardcoded
    // literals, so it could never notice a change to the tier boundary in
    // rules.js, which is the only thing it was written to catch. Lifting the
    // function out and running it is the difference between a pin and a comment.
    const body = (lbJsBody.match(/function money\(b\) \{\n([\s\S]*?)\n  \}/) || [])[1];
    let mismatch = 'money() not found in the served file';
    if (body) {
      const money = new Function('b', body);
      // money() takes the STORED value, which already includes the $1B float.
      const bad = [0, 1, 42, 997, 998, 999, 1000, 4379, 999999]
        .map((n) => [n, money(R.BASE_VALUATION_B + n), R.valuationText(n)])
        .filter(([, mine, theirs]) => mine !== theirs);
      mismatch = bad.length
        ? bad.map(([n, a, b2]) => `${n}: page ${a} vs rules ${b2}`).join(' | ')
        : '9 values agree, both tiers';
    }
    check('the leaderboard page prices a company exactly as rules.js does',
      !!body && !/ vs rules /.test(mismatch), mismatch);
    check('the leaderboard page never builds markup from a company name',
      !/innerHTML/.test(lbJsBody), 'textContent only');

    // The way in. A player who never sees a link never sees the board.
    const cardJs = await (await fetch(`${BASE}/login.js`)).text();
    const links = (cardJs.match(/\/leaderboard/g) || []).length;
    check('both the login card and the closing card link to the leaderboard',
      cardJs.includes("href: '/leaderboard'") && links >= 2,
      `${links} links in login.js`);
  }

  // --- the global leaderboard's two public routes ---------------------------------
  // 🔴 OUTSIDE the static-export guard above, on purpose: these answer on a bare
  // `node index.js` with no web export beside it, and the first cut of this
  // block sat in the guarded half and printed five red lines that were not
  // failures.
  {
    const board = await fetch(`${BASE}/api/leaderboard?limit=5`);
    const boardBody = await board.text();
    let boardJson = null;
    try { boardJson = JSON.parse(boardBody); } catch { /* left null */ }
    // 200 with rows when a database is wired up, 503 with a reason when it is
    // not. Both are correct; a 404 or a crash is not, and neither is a 200 with
    // a player id in it.
    check('/api/leaderboard answers JSON, with rows or with a reason',
      (board.status === 200 && boardJson && boardJson.ok === true && Array.isArray(boardJson.players))
      || (board.status === 503 && boardJson && boardJson.ok === false && !!boardJson.reason),
      `status=${board.status} ${boardBody.slice(0, 90)}`);
    check('no player id is ever in a leaderboard response',
      !/"pid"/.test(boardBody) && !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(boardBody),
      'no pid key and no v4 UUID in the body');

    const rounds = await fetch(`${BASE}/api/rounds?limit=5`);
    const roundsBody = await rounds.text();
    let roundsJson = null;
    try { roundsJson = JSON.parse(roundsBody); } catch { /* left null */ }
    check('/api/rounds answers JSON, with rows or with a reason',
      (rounds.status === 200 && roundsJson && Array.isArray(roundsJson.rounds))
      || (rounds.status === 503 && roundsJson && roundsJson.ok === false),
      `status=${rounds.status} ${roundsBody.slice(0, 90)}`);
    check('no player id is ever in a history response',
      !/"pid"/.test(roundsBody) && !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(roundsBody),
      'no pid key and no v4 UUID in the body');

    // 🔴 COUNT THE QUERIES, do not time the requests. This check used to fire
    // four requests and assert the wall clock was under two seconds, which is
    // true of a working cache, a broken cache, and a server with no database at
    // all: it could not fail. store.stats() now reports every SELECT this
    // process has sent, so eight SIMULTANEOUS requests against a cold cache are
    // the actual test, and they are simultaneous because a cache that stores the
    // resolved value instead of the in-flight promise passes a serial version.
    const lobbies0 = await (await fetch(`${BASE}/lobbies`)).json();
    check('/lobbies says whether the leaderboard has a database at all',
      lobbies0.board && typeof lobbies0.board.enabled === 'boolean',
      JSON.stringify(lobbies0.board));
    if (lobbies0.board && lobbies0.board.enabled) {
      // Past the 2 s TTL, so the burst below starts cold.
      await wait(2200);
      const before = lobbies0.board.reads;
      await Promise.all(Array.from({ length: 8 },
        () => fetch(`${BASE}/api/leaderboard?limit=5`)));
      const after = (await (await fetch(`${BASE}/lobbies`)).json()).board.reads;
      // One miss is two SELECTs (the rows and the totals). Eight misses is 16.
      check('eight simultaneous readers are one query, not eight',
        after - before <= 4, `${after - before} SELECTs for 8 concurrent requests`);
    } else {
      console.log('INFO  cache-stampede block skipped: no database on this server');
    }

  }

  // --- accounts over HTTP ----------------------------------------------------------
  // 🔴 These are the only routes in this process that take a POST, so every shape
  // of bad request is thrown at them first, and none of those may write.
  {
    const typed = await post('/api/player', 'pid=K7QM-3XPD-9RWT', 'text/plain');
    check('an account route refuses anything that is not JSON', typed.status === 415,
      `status=${typed.status}`);
    const big = await post('/api/login', { email: 'a@b.co', password: 'x'.repeat(5000) });
    check('an account route refuses a body over 4 KB', big.status === 413, `status=${big.status}`);
    // The same, with no length declared up front: 64 KB streamed in pieces. The
    // server answers 413 and drops the connection rather than reading the rest,
    // so the client may see the answer or the hang-up. Either way it must stay up.
    let streamed = 'no answer';
    try {
      const piece = Buffer.alloc(8192, 0x61);
      const body = new ReadableStream({
        start(ctl) { for (let i = 0; i < 8; i++) ctl.enqueue(piece); ctl.close(); },
      });
      const r = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
      });
      streamed = r.status;
    } catch (e) {
      streamed = 'hung up';
    }
    const upAfter = await fetch(`${BASE}/healthz`).then((r) => r.status).catch(() => 0);
    check('a streamed body over 4 KB is refused, and the server stays up',
      (streamed === 413 || streamed === 'hung up') && upAfter === 200,
      `answer=${streamed} healthz=${upAfter}`);
    const junk = await post('/api/player', '{not json', 'application/json');
    check('an account route refuses a body that is not valid JSON', junk.status === 400,
      `status=${junk.status}`);
    const badId = await post('/api/player', { pid: "' OR 1=1--" });
    check('a malformed player id is refused with a reason',
      badId.status === 400 && !!badId.json.reason, `status=${badId.status}`);
    check('GET on an account route is not an account route',
      (await fetch(`${BASE}/api/login`)).status !== 200);
    const lookup = await post('/api/player', { pid: newCode() });
    const lobbiesA = await (await fetch(`${BASE}/lobbies`)).json();
    const hasDb = !!(lobbiesA.board && lobbiesA.board.enabled);
    check('an unknown player id finds nobody, or says accounts are offline',
      hasDb ? (lookup.status === 200 && lookup.json.found === false) : lookup.status === 503,
      `status=${lookup.status} found=${lookup.json.found}`);

    if (hasDb && FILE_ROUNDS) {
      const pid = newCode();
      // Random as well as timed: two suites against one database must not collide.
      const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`;
      const pw = 'correct horse battery';
      const named = await post('/api/player', { pid, name: '  Smoke   Tester ' });
      check('naming a player id creates it, with the name cleaned',
        named.status === 200 && named.json.found === true && named.json.name === 'Smoke Tester',
        `status=${named.status} name=${JSON.stringify(named.json.name)}`);
      const reg = await post('/api/register', { pid, name: 'Smoke Tester', email, password: pw });
      check('an account can be created on a player id',
        reg.status === 201 && reg.json.email === 's***@example.invalid',
        `status=${reg.status} ${reg.json.reason || ''}`);
      const again = await post('/api/register', { pid, name: 'Smoke Tester', email: 'x' + email, password: pw });
      check('a player id with an account cannot be given a second one', again.status === 409,
        `status=${again.status}`);
      const taken = await post('/api/register', { pid: newCode(), name: 'Other', email, password: pw });
      check('an email can only be on one account', taken.status === 409, `status=${taken.status}`);
      const shortPw = await post('/api/register',
        { pid: newCode(), name: 'Other', email: 'y' + email, password: 'short' });
      check('a password under 8 characters is refused', shortPw.status === 400,
        `status=${shortPw.status}`);
      const wrong = await post('/api/login', { email, password: pw + '!' });
      const nobody = await post('/api/login', { email: 'nobody-' + email, password: pw });
      check('a wrong password and an unknown email get the same answer',
        wrong.status === 401 && nobody.status === 401 && wrong.json.reason === nobody.json.reason,
        `${wrong.status}/${nobody.status}`);
      const ok = await post('/api/login', { email: email.toUpperCase(), password: pw });
      check('the right password hands back that player id, whatever the email case',
        ok.status === 200 && ok.json.pid === pid && ok.json.name === 'Smoke Tester',
        `status=${ok.status}`);
      const back = await post('/api/player', { pid: pid.toLowerCase().replace(/-/g, ' ') });
      check('typing the player id back in finds the player, email masked',
        back.status === 200 && back.json.found === true && back.json.pid === pid
        && back.json.email === 's***@example.invalid',
        `status=${back.status} email=${back.json.email}`);
      // The move from an old UUID to a short code: allowed once, onto a free id.
      const old = 'b1b1b1b1-5b0c-4e00-8aaa-' + String(Date.now()).slice(-12).padStart(12, '0');
      const code = newCode();
      const moved = await post('/api/player', { pid: code, from: old });
      check('a browser holding an old UUID can move to a short code',
        moved.status === 200 && moved.json.pid === code,
        `status=${moved.status} ${moved.json.reason || ''}`);
      const onto = await post('/api/player', { pid, from: old });
      check('rounds can never be moved onto a player id somebody already holds',
        onto.status === 409, `status=${onto.status}`);
      // "Get a new ID": the account, email and all, moves to a fresh id and the
      // leaked one is left holding nothing. Last in this block, because `pid`
      // stops being a player the moment it passes.
      const self = await post('/api/player', { pid, from: pid });
      check('a player id cannot be moved onto itself', self.status === 400, `status=${self.status}`);
      // 🔴 An account needs its own password to move: the id alone is exactly
      // what a stranger who once saw it would have.
      const noPw = await post('/api/player', { pid: newCode(), from: pid });
      const badPw = await post('/api/player', { pid: newCode(), from: pid, password: pw + '!' });
      const still = await post('/api/player', { pid });
      check('an account cannot be moved without its password, or with the wrong one',
        noPw.status === 401 && badPw.status === 401 && still.json.found === true
        && still.json.email === 's***@example.invalid',
        `none=${noPw.status} wrong=${badPw.status} still there=${still.json.found}`);
      const swapTo = newCode();
      const swapped = await post('/api/player', { pid: swapTo, from: pid, password: pw });
      check('a player can swap their id for a new one, account and all',
        swapped.status === 200 && swapped.json.pid === swapTo && swapped.json.found === true
        && swapped.json.name === 'Smoke Tester' && swapped.json.email === 's***@example.invalid',
        `status=${swapped.status} ${swapped.json.reason || ''}`);
      const leaked = await post('/api/player', { pid });
      check('the old id holds nothing after the swap',
        leaked.status === 200 && leaked.json.found === false, `found=${leaked.json.found}`);
      const relog = await post('/api/login', { email, password: pw });
      check('the email now logs in to the new id',
        relog.status === 200 && relog.json.pid === swapTo, `status=${relog.status}`);
      // A login that succeeds gives its try back to the per-email bucket. Three
      // failures are already in it from above; without the refund, nine more
      // right answers would run it past ten.
      let rightAgain = 0;
      for (let i = 0; i < 9; i++) {
        if ((await post('/api/login', { email, password: pw })).status === 200) rightAgain++;
      }
      check('an owner logging in again and again is never throttled by their own logins',
        rightAgain === 9, `${rightAgain} of 9 answered 200`);
    } else {
      console.log('INFO  account write-back block skipped: '
        + (hasDb ? 'not a local server, so nothing is written' : 'no database on this server'));
    }

    // 🔴 THE PRIVACY LINE. Neither public route may ever carry an email, or a
    // player id in either of its two shapes.
    const pub = (await (await fetch(`${BASE}/api/leaderboard?limit=200`)).text())
      + (await (await fetch(`${BASE}/api/rounds?limit=500`)).text());
    check('no email and no player id in either public leaderboard response',
      !/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i.test(pub) && !/"pid"/.test(pub)
      && !/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/.test(pub),
      `${pub.length} bytes checked`);
  }

  // The 10 minute reset. Run the server with ROUND_SECONDS=26 and this proves it
  // for real instead of waiting ten minutes (the same recipe as the README):
  //   ROUND_SECONDS=26 PORT=8124 node index.js &
  //   ROUND_SECONDS=26 node smoke.js http://127.0.0.1:8124
  // Whether the closing bell is reachable depends on where this run lands in
  // the round, so SAY where it landed. A silently skipped block reads exactly
  // like a passing one in the summary line, which is how the bell shipped once
  // without its new payload ever having been sent over a real socket.
  console.log(`INFO  closing-bell block: k=${a.last.k}s, runs when k < 60`);
  const bellRan = a.last.k < 60;
  if (bellRan) {
    const total = (f) => f.b.filter((_, i) => i % 6 === 4).reduce((x, y) => x + y, 0);
    let before = null, after = null, fired = false;
    // Sampled on the frames either side of the reset itself. Sampling on a timer
    // instead measured a fresh round that had already been running for seconds.
    a.sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'reset') { fired = true; return; }
      if (m.t !== 's') return;
      if (!fired) before = total(m);
      else if (after === null) after = total(m);
    });
    // 🔴 THE ORDER MATTERS AND IT IS THE ONLY WAY THIS BLOCK CAN BE WRITTEN.
    // The bell rings at k=0 and the reset lands CLOSING_SECONDS later, so the
    // table and the freeze have to be read INSIDE that window. Waiting the whole
    // way through first and checking afterwards reads a world that is already
    // running again, and "the board is frozen" would fail on a working freeze.
    await wait((a.last.k + 2) * 1000);

    // The closing bell itself. This is the whole end-of-match screen: without a
    // table there is no result, and a round with no result is the thing the bell
    // was added to fix.
    const cl = a.close;
    check('the closing bell sends a final table', !!cl && Array.isArray(cl.top),
      cl ? `rows=${cl.top.length}` : 'no close frame');
    if (cl && Array.isArray(cl.top) && cl.top.length) {
      const names = new Set(R.COMPANIES.map((x) => x.n));
      check(`the table is ${R.TABLE_ROWS} rows or the whole field`,
        cl.top.length === Math.min(R.TABLE_ROWS, cl.field), `rows=${cl.top.length} field=${cl.field}`);
      check('the table is sorted by valuation, richest first',
        cl.top.every((r, i) => i === 0 || cl.top[i - 1].m >= r.m));
      check('every row is ranked in order',
        cl.top.every((r, i) => r.r === i + 1));
      // A row carries the name, the mark index and the SAME formatted price the
      // ball wore. Formatting it twice is how the card and the board drift.
      check('every row carries a real company, its mark and its price',
        cl.top.every((r) => (r.h === 1 || names.has(r.n))
          && Number.isInteger(r.g) && typeof r.v === 'string' && r.v.startsWith('$')));
      // 🔴 NULL IS A CORRECT ANSWER HERE, and this check used to call it a
      // failure. `you` is deliberately null for a player holding a death card
      // when the bell rings, because the card refuses to invent a rank for a
      // company that no longer exists. The test client stands still for 75
      // seconds among fifty hunting bots and is acquired in roughly one run in
      // three, so this failed at random and taught everyone to ignore it. What
      // is actually being asserted is: a rank, or an honest absence, never a
      // made-up number.
      check('the player is on the card with their own rank, or is honestly absent',
        cl.you === null || (cl.you.r >= 1 && cl.you.r <= cl.field),
        cl.you ? `#${cl.you.r} of ${cl.field} at ${cl.you.v}`
          : 'acquired at the bell: no rank invented');
      // What this player acquired. The counters are exact; the named list is
      // capped, so `took` is allowed to be larger than `mine.length` and must
      // never be smaller.
      check('the card carries the acquisitions panel',
        Array.isArray(cl.mine) && Number.isInteger(cl.took) && typeof cl.worth === 'string',
        `took=${cl.took} named=${cl.mine ? cl.mine.length : 'none'} worth=${cl.worth}`);
      check('the named takeovers never claim more than the counter',
        Array.isArray(cl.mine) && cl.mine.length <= cl.took,
        `${cl.mine ? cl.mine.length : 0} named of ${cl.took}`);
      check('a takeover with no companies in it says so with an empty total',
        cl.took > 0 ? cl.worth.startsWith('$') : cl.worth === '',
        `took=${cl.took} worth="${cl.worth}"`);
      // 🔴 THE END TO END PROOF OF THE GLOBAL LEADERBOARD, and the only place
      // it exists. Everything else about the board is checked in process or
      // against an empty table; this is a real socket, a real round, a real
      // closing bell and a real INSERT, read back over the public HTTP API.
      // It only runs when a database is actually wired up, so the suite still
      // passes against a server with no DATABASE_URL.
      const after = await (await fetch(`${BASE}/lobbies`)).json();
      if (after.board && after.board.enabled) {
        check('the closing bell wrote the round to the global leaderboard',
          after.board.written >= 1 && after.board.failed === 0,
          `written=${after.board.written} failed=${after.board.failed}`);
        // 🔴 BOTH BRANCHES, because a stationary test client is acquired in
        // roughly one run in three and `cl.you` is null when it was. The first
        // cut of this block dereferenced it and took the whole suite down with a
        // TypeError on a round that had worked perfectly. Which branch runs is a
        // coin toss, so both are written and the outcome is printed either way.
        const died = !cl.you;
        const floor = died ? R.BASE_VALUATION_B : cl.you.m;
        const top = await (await fetch(`${BASE}/api/leaderboard?limit=20`)).json();
        const mine = (top.players || []).find((r) => r.name === 'AlphaCo');
        // >=, NOT ===, and the difference is the entire point of the feature.
        // The board stores the PEAK and the closing card shows the FINAL, so a
        // player acquired near the bell is worth $1B on the card and whatever
        // they reached on the board. One run measured $26B against $1B, which is
        // a working leaderboard and was a failing assertion.
        check('the round that just finished is on the board, at the price it reached',
          !!mine && mine.peak >= floor && mine.plays >= 1,
          mine ? `board=$${mine.peak}B card=$${floor}B plays=${mine.plays} `
            + `(${died ? 'acquired at the bell' : 'alive at the bell'})`
            : `AlphaCo not in ${(top.players || []).length} rows`);

        const hist = await (await fetch(`${BASE}/api/rounds?limit=20`)).json();
        // The bell's own row: secs is the whole round. A row filed when a
        // player LEFT has fewer, and is checked at the end of the run.
        const row = (hist.rounds || []).find((r) => r.name === 'AlphaCo' && r.secs === R.ROUND_SECONDS);
        if (died) {
          // The documented shape for a player holding a death card at the bell:
          // no rank, and a final of zero rather than the price they were taken
          // at. They finished the round owning nothing. The peak still stands.
          check('a player acquired at the bell is filed with no rank and nothing left',
            !!row && row.rank === null && row.final === 0 && row.peak >= R.BASE_VALUATION_B,
            row ? `rank=${row.rank} final=$${row.final}B peak=$${row.peak}B`
              : `AlphaCo not in ${(hist.rounds || []).length} rounds`);
        } else {
          // The history row is where final and rank ARE the card's own numbers,
          // so this is the tight pin the board check deliberately is not.
          check('the play history carries the exact rank and price the card showed',
            !!row && row.rank === cl.you.r && row.final === cl.you.m && row.peak >= row.final,
            row ? `rank=${row.rank}/${cl.you.r} final=$${row.final}B/$${cl.you.m}B peak=$${row.peak}B`
              : `AlphaCo not in ${(hist.rounds || []).length} rounds`);
        }
        // 🔴 An id with rounds on the board is a player even if the call that
        // names it never landed. GammaCo's id was never named; its market rings
        // a moment after AlphaCo's, so wait for its card and then for the write.
        if (C_PID) {
          for (let i = 0; i < 60 && !c.close; i++) await wait(100);
          await wait(800);
          const cFound = await post('/api/player', { pid: C_PID });
          check('an id with rounds on the board but no name is found, so it can log in',
            !!c.close && cFound.status === 200 && cFound.json.found === true && !cFound.json.name,
            `card=${!!c.close} status=${cFound.status} found=${cFound.json.found}`);
        }
      } else {
        console.log('INFO  leaderboard write-back block skipped: no database on this server');
      }
      check('every named takeover carries a company, a mark and a price',
        (cl.mine || []).every((x) => typeof x.n === 'string' && x.n !== ''
          && Number.isInteger(x.g) && typeof x.v === 'string' && x.v.startsWith('$')),
        `${(cl.mine || []).length} chips`);
      // 🔴 The whole point of the freeze. If the world kept stepping behind the
      // card, the table would be out of date before anybody finished reading it.
      // Skipped when the bell is too short to sample inside safely.
      if (R.CLOSING_SECONDS >= 5) {
        const frozen = total(a.last);
        await wait(1500);
        check('the board is frozen while the bell is up', total(a.last) === frozen,
          `total=$${total(a.last)}B held=$${frozen}B`);
      }
    }

    // ...and only now, through the bell and out the other side.
    await wait((R.CLOSING_SECONDS + 3) * 1000);
    check('the round reset fires', fired === true);
    check('the reset wipes every valuation', after === 0 && before > 0,
      `before=$${before}B after=$${after}B`);
  }

  for (const s of [a, b, c]) s.sock.close();
  await wait(900);
  const quiet = await (await fetch(`${BASE}/lobbies`)).json();
  // 🔴 A market exists only for its player. If leaving did not close it, every
  // visitor would leave 20 ticks a second of nothing behind them forever, and
  // the box would fall over on its own after a few hundred page loads.
  check('leaving closes the market it opened', quiet.live <= liveBefore,
    `live=${quiet.live} baseline=${liveBefore}`);

  // 🔴 THE END TO END PROOF that leaving files a round: a real socket that ate
  // for ten seconds, closed, and read back over the public API. Only when the
  // bell did not run, because after the reset AlphaCo has not grown again.
  if (FILE_ROUNDS && quiet.board && quiet.board.enabled && !bellRan) {
    await wait(1200);
    const hist3 = await (await fetch(`${BASE}/api/rounds?limit=30`)).json();
    const leftRow = (hist3.rounds || []).find((r) => r.name === 'AlphaCo' && r.secs < R.ROUND_SECONDS);
    check('a player who leaves mid-round is on the history, under their player name',
      !!leftRow && leftRow.player === 'Smoke Alpha' && leftRow.peak > R.BASE_VALUATION_B
      && leftRow.secs >= 15 && typeof leftRow.tag === 'string',
      leftRow ? `player=${leftRow.player} peak=$${leftRow.peak}B secs=${leftRow.secs}`
        : `no AlphaCo row under ${R.ROUND_SECONDS}s in ${(hist3.rounds || []).length}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? `${failed} FAILED` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e.message); process.exit(1); });
