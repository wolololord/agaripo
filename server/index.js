'use strict';
// AgarIPO — one process serves the game client and hosts every lobby.
//
// nginx used to serve the static export and there was no server at all. Putting
// both in one Node process means the WebSocket is same-origin (no CORS, no second
// domain, no second Railway service to pay for) and the lobby list, the game and
// the page always ship together.
//
// 🔴 This is on the public internet with no authentication. Every field on every
// frame is hostile input until it has been checked.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const R = require('./rules');
const store = require('./store');
const accounts = require('./accounts');
const { Lobby, TICK_HZ, META_INTERVAL_MS, cleanView, send, NO_LOGO } = require('./world');

const PORT = Number(process.env.PORT || 8080);
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'build', 'web'));

// --- markets ------------------------------------------------------------------
// The four shared lobbies are GONE. Every player gets their own private world,
// created on join and destroyed the moment their socket closes.
//
// The brief: other players defeat the purpose, because the point is to meet the
// pre-IPO companies and their valuations and eat them one by one. A human in the field takes a pre-IPO company's place on the board,
// and waiting for one to show up is worse than not having them at all. Solo is
// also evergreen: the game is never empty, whoever opens it and whenever.
//
// The server still owns every rule. A client-side rewrite would have thrown away
// the authoritative model, and with it the reason the "the player and the rivals
// disagreed about who was bigger" class of bug cannot come back.
const worlds = new Map();
let worldSeq = 0;
// Stamped by the tick loop and read by /healthz, which is the only thing that
// can tell Railway the simulation has stopped while the HTTP side is still up.
let lastTickAt = Date.now();
// Consecutive failed ticks per market. Declared here, beside the map it is keyed
// by, so closeWorld cannot reference it before it exists.
const tickFails = new Map();

// Each market cost 0.157 ms of CPU per tick, measured over 200 ticks at 119
// companies and 3000 dots, and there are 20 ticks a second. 60 of them is 19% of
// one core; 200 would be 63%, which leaves too little for the HTTP side and the
// 43 MB wasm it serves on a shared Railway container.
const MAX_WORLDS = Number(process.env.MAX_WORLDS || 60);

// `ip` is the address of the one player this market is for.
function openWorld(ip) {
  const id = 'm' + (++worldSeq);
  // The third argument is where a finished round goes. world.js knows nothing
  // about Postgres; it calls whatever it was handed, once per human, at the bell
  // or when they leave. Null with no database, so the closing card never says a
  // round was filed when nothing could file it.
  const l = new Lobby(id, 'Pre-IPO Market', store.enabled ? fileFor(ip) : null);
  worlds.set(id, l);
  return l;
}

// Where a market's rounds go. A round that reached the bell is always filed. A
// round filed because the player LEFT early is counted against their address
// first (accounts.js, 'leave'): fifteen seconds and one dot make such a round
// nearly free, and without a cap one script with eight sockets could fill the
// whole public history in minutes. Only when a real forwarded address was seen,
// for the same reason as MAX_PER_IP, and never at shutdown, when every player on
// the board leaves at once.
function fileFor(ip) {
  return (row) => {
    if (row.secs < R.ROUND_SECONDS && perIpEnabled && !stopping
      && accounts.limited('leave', ip)) return;
    store.record(row);
  };
}

function closeWorld(l) {
  if (!l) return;
  worlds.delete(l.id);
  tickFails.delete(l.id);
}

// --- static files -------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Which files have a pre-compressed twin, read ONCE at boot. The directory is
// baked into the image and never changes, and an fs.existsSync per request put
// blocking disk I/O on the same event loop as the 20 Hz game tick.
const GZIPPED = new Set();
(function indexGz(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) indexGz(full);
    else if (e.name.endsWith('.gz')) GZIPPED.add(full.slice(0, -3));
  }
}(STATIC_DIR));

function serveStatic(req, res, urlPath) {
  let rel;
  // 🔴 decodeURIComponent THROWS on a malformed percent escape. Uncaught, inside
  // the request handler, that is a synchronous crash of the whole process and
  // every lobby with it: one `curl 'https://.../%'` from anyone on the internet.
  try {
    rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  const full = path.resolve(path.join(STATIC_DIR, rel));
  // Anything that resolves outside the static root is a traversal attempt.
  if (full !== STATIC_DIR && !full.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }
  const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  // The engine wasm is 43 MB raw. It is pre-compressed at build time and the .gz is
  // served whenever the browser will take it; compressing 43 MB per request would
  // not be.
  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const pick = (wantsGzip && GZIPPED.has(full)) ? full + '.gz' : full;

  fs.stat(pick, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    // 🔴 "no-cache" means revalidate, NOT "do not store". Every file keeps its
    // ETag so a reload is a cheap 304, but a redeploy can never leave a browser
    // running an old index.pck against a new server. That combination was
    // measured once: the stale client read the new 6-int snapshot with a 5-int
    // stride and drew 24 companies worth $9.98B out of 20 worth $177M.
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end();
      return;
    }
    const headers = {
      'content-type': type,
      'content-length': st.size,
      'cache-control': 'no-cache',
      etag: etag,
      // The same URL answers with the raw file or the .gz depending on the
      // request. Without Vary a shared cache could hand gzipped bytes to a client
      // that never asked for them.
      vary: 'Accept-Encoding',
      'x-content-type-options': 'nosniff',
    };
    if (pick !== full) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(pick);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// The leaderboard cache. Two entries at most, one per route, so there is
// nothing to evict and no key an attacker can vary.
const API_TTL_MS = 2000;
const apiCache = { top: null, all: null };

function apiRead(top, limit) {
  const slot = top ? 'top' : 'all';
  const hit = apiCache[slot];
  const now = Date.now();
  // A smaller limit is served from a bigger cached answer by slicing it; a
  // bigger one misses and refills. Without the limit check a ?limit=200 would
  // be answered from a cached ?limit=10.
  const cut = (data) => (data === null ? null
    : { rows: data.rows.slice(0, limit), totals: data.totals });
  // 🔴 THE PROMISE IS CACHED, NOT THE RESOLVED VALUE. Caching the value only
  // starts working once the first query has come BACK, so N requests arriving
  // in the same millisecond were N misses and N queries: a cold cache plus a
  // page load that fetches both routes, times however many people open the page
  // at once. store.js's own ready() already gets this right.
  if (hit && hit.limit >= limit && now - hit.at < API_TTL_MS) return hit.p.then(cut);
  const entry = { at: now, limit, p: top ? store.leaderboard(limit) : store.recent(limit) };
  // A failure must not be cached for two seconds, and a promise nobody has
  // attached a catch to is an unhandled rejection. This is both fixes.
  entry.p.catch(() => { if (apiCache[slot] === entry) apiCache[slot] = null; });
  apiCache[slot] = entry;
  return entry.p.then(cut);
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }).end(JSON.stringify(body));
}

// 🔴 4 KB, JSON only, and nothing past the cap is kept. An email, a password and
// a player id are well under a kilobyte, and every byte buffered here is memory
// on the process that runs the game.
const MAX_BODY = 4096;

// 🔴 A refused body is NOT read to the end. The answer goes out marked
// `connection: close` and the socket is dropped as soon as it has, so a client
// that declares, or just keeps sending, a gigabyte costs one small reply.
function refuse(req, res, status, reason) {
  res.setHeader('connection', 'close');
  sendJson(res, status, { ok: false, reason });
  res.on('finish', () => req.destroy());
}

function postJson(req, res, path) {
  req.on('error', () => {});
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    refuse(req, res, 415, 'Send JSON.');
    return;
  }
  if (Number(req.headers['content-length']) > MAX_BODY) {
    refuse(req, res, 413, 'Too big.');
    return;
  }
  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (c) => {
    if (refused) return;
    size += c.length;
    if (size <= MAX_BODY) { chunks.push(c); return; }
    refused = true;
    chunks.length = 0;
    refuse(req, res, 413, 'Too big.');
  });
  req.on('end', () => {
    if (refused) return;
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, reason: 'Bad request.' });
      return;
    }
    accounts.handle(path, body, ipOf(req))
      .then((out) => sendJson(res, out.status, out.body));
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  // Checked before routing, not after, or POST /lobbies answered 200. The three
  // account routes are the only things in this process that take a POST.
  if (req.method === 'POST' && accounts.isRoute(url.pathname)) {
    postJson(req, res, url.pathname);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }
  // 🔴 A health check that cannot report ill health is not a health check. The
  // tick loop is the thing that has to keep running, and it used to be possible
  // for every market to stop stepping while this still answered 200 and Railway
  // therefore never restarted anything. Two missed ticks is 100 ms; the cutoff
  // is deliberately loose so a garbage collection pause is not an outage.
  if (url.pathname === '/healthz') {
    const behind = Date.now() - lastTickAt;
    if (behind > 3000) {
      res.writeHead(503, { 'content-type': 'text/plain' })
        .end(`tick loop is ${behind} ms behind`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  // What the server is actually doing, for the smoke suite and for anyone
  // looking. 🔴 It used to also return a fabricated one-row `lobbies` array so
  // that a browser holding the PREVIOUS client through a deploy would render
  // something. That was worse than useless: the old card's real error message
  // is "Could not reach the lobby server. Reload the page", and reloading is
  // exactly what that player needs to do.
  if (url.pathname === '/lobbies') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }).end(JSON.stringify({
      solo: true,
      world: R.WORLD,
      field: R.FIELD_SIZE,
      dots: R.DOT_COUNT,
      round: R.ROUND_SECONDS,
      closing: R.CLOSING_SECONDS,
      live: worlds.size,
      capacity: MAX_WORLDS,
      board: store.stats(),
    }));
    return;
  }

  // --- the global leaderboard -------------------------------------------------
  // 🔴 A 2 SECOND CACHE IN FRONT OF BOTH QUERIES, and it is not a performance
  // tweak. These are the only public routes in this process that touch a
  // database, on a page anyone can open and reload, sharing one event loop with
  // a 20 Hz simulation. Cached, a thousand requests a second cost one query.
  //
  // What is cached is the RAW row set, ids and all, and store.publish turns that
  // into a response per request. Caching the response instead would mean either
  // keying the cache on the caller's id — which hands anyone a way to miss it on
  // purpose — or serving one player's `you` flags to another.
  if (url.pathname === '/api/leaderboard' || url.pathname === '/api/rounds') {
    const top = url.pathname === '/api/leaderboard';
    const limit = Math.min(top ? 200 : 500, Math.max(1, Number(url.searchParams.get('limit')) || (top ? 100 : 200)));
    // The caller's own id, from a HEADER. Never a query string: that would put
    // it in the access log, in the Referer of anything the page links to, and in
    // the browser history.
    const me = store.cleanPid(req.headers['x-agaripo-pid']);
    apiRead(top, limit).then((data) => {
      if (!data) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          .end(JSON.stringify({ ok: false, reason: store.enabled ? 'database not ready' : 'no database configured' }));
        return;
      }
      const body = top
        ? { ok: true, players: store.publish(data.rows, me), totals: data.totals }
        : { ok: true, rounds: store.publish(data.rows, me) };
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }).end(JSON.stringify(body));
    }).catch((e) => {
      console.error('leaderboard query failed:', e.message);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: false, reason: 'query failed' }));
    });
    return;
  }
  // An extensionless path, so serveStatic's extension-driven content type would
  // send it as application/octet-stream and the browser would download it.
  //
  // 🔴 THE TRAILING SLASH IS A REDIRECT, NOT THE SAME PAGE. Serving the HTML at
  // /leaderboard/ looks like it works and does not: every reference in that file
  // is relative, so at that base `login.css` resolves to /leaderboard/login.css
  // and 404s, along with the script, the marks and the brand. An unstyled,
  // scriptless page is worse than either a 404 or one extra round trip.
  if (url.pathname === '/leaderboard/') {
    res.writeHead(301, { location: '/leaderboard' }).end();
    return;
  }
  if (url.pathname === '/leaderboard') {
    serveStatic(req, res, '/leaderboard.html');
    return;
  }
  serveStatic(req, res, url.pathname);
});
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// --- sockets ------------------------------------------------------------------
// A 128x128 re-encoded PNG is 10 to 30 KB. 96 KB is generous; 512 KB was not a
// limit, it was an amplifier, because a join relays the logo to everyone present.
const MAX_SKIN = 96 * 1024;
const MAX_NAME = 22;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_SKIN + 4096 });

// Sockets, not markets: a player reading the login card holds one of these and
// costs nothing, while MAX_WORLDS caps the ones that actually tick. Lowerable
// only so the rejection path can be exercised in a test; nothing sets it in
// production.
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS || 200);
// The client sends 20 input frames a second.
const MAX_FRAMES_PER_SEC = 60;
// ...and a frame budget alone is not a budget: 60 frames of maxPayload is still
// megabytes a second of JSON.parse on the same thread as the game tick.
const MAX_BYTES_PER_SEC = 256 * 1024;
// One machine must not be able to take all 80 seats, nor lock everyone else out
// by filling the global cap. A few browser tabs from one household still work.
const MAX_PER_IP = 8;
const perIp = new Map();

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SKIN_PREFIX = 'data:image/png;base64,';

// The prefix is a claim, not evidence. Decode and look at the bytes, or 96 KB of
// anything at all gets relayed to twenty other players as "a PNG".
function cleanSkin(v) {
  if (typeof v !== 'string' || v.length > MAX_SKIN || !v.startsWith(SKIN_PREFIX)) return '';
  let buf;
  try { buf = Buffer.from(v.slice(SKIN_PREFIX.length), 'base64'); } catch { return ''; }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return '';
  // IHDR width and height, big-endian at offsets 16 and 20.
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w < 8 || h < 8 || w > 512 || h > 512) return '';
  return v;
}

// Drawn onto every other player's screen. Control characters, bidirectional
// overrides and zero-width joiners all come out, or a name can reverse or hide
// the text around it.
const NAME_STRIP = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(NAME_STRIP, '').trim().slice(0, MAX_NAME);
}

// A brand pick is an index into the company pack, not an image. The client owns
// the same pack inside its own .pck, so this integer is all that has to cross
// the wire. Anything that is not a real row becomes "no logo", never an
// out-of-range read on the client.
function cleanLogo(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= R.COMPANIES.length) return NO_LOGO;
  return n;
}

// 🔴 Behind a proxy, every socket shares the proxy's remoteAddress. If
// x-forwarded-for is missing there, a per-IP cap would not limit one abuser, it
// would limit the entire game to MAX_PER_IP players. The first connection logs
// which of the two it got, so this is checkable in `railway logs` rather than
// assumed. `perIpEnabled` stays false until a real forwarded address is seen.
let sawFirst = false;
let perIpEnabled = false;

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  // 🔴 The LAST entry, not the first. A proxy APPENDS the peer it saw, so the
  // leftmost entry is whatever the client put in the header itself: reading it
  // let one forged header per handshake mint a fresh identity and made
  // MAX_PER_IP inert. The rightmost is the address Railway's own edge observed,
  // which is the only one in the list this process has any reason to believe.
  const parts = (typeof fwd === 'string' && fwd.length) ? fwd.split(',') : [];
  const real = parts.length ? parts[parts.length - 1].trim() : '';
  if (!sawFirst) {
    sawFirst = true;
    perIpEnabled = real !== '';
    console.log(`first socket: x-forwarded-for=${real || 'ABSENT'} `
      + `remote=${req.socket.remoteAddress} perIpCap=${perIpEnabled ? 'on' : 'OFF'}`);
  }
  return real || req.socket.remoteAddress || 'unknown';
}

wss.on('connection', (sock, req) => {
  let lobby = null;
  let blob = null;
  let frames = 0;
  let bytes = 0;
  let frameWindow = 0;
  const ip = ipOf(req);

  // 🔴 Registered FIRST, before any early return. `ws` emits 'error' on a
  // malformed frame, and an EventEmitter with no 'error' listener throws
  // fatally: the socket cap below used to close and return before this line, so
  // a rejected connection sending one bad frame killed the whole process.
  // 🔴 Idempotent, because `ws` fires BOTH 'error' and 'close' on a socket that
  // dies badly and this is bound to both. Decrementing twice under-counts the IP
  // permanently: every errored socket frees a seat its sibling still occupies, so
  // the per-IP cap leaks a little on every bad disconnect until it stops capping.
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    // The round so far goes on the leaderboard first, because the market it was
    // played in is about to stop existing. leave() decides whether it counts.
    if (lobby && blob) lobby.leave(blob, Date.now());
    // The whole market goes with the player. It existed only for them, and a
    // world left running with no human in it is 20 ticks a second of nothing.
    closeWorld(lobby);
    lobby = null; blob = null;
    const n = (perIp.get(ip) || 1) - 1;
    if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
  };
  sock.on('error', drop);
  sock.on('close', drop);

  const here = (perIp.get(ip) || 0) + 1;
  perIp.set(ip, here);
  if (wss.clients.size > MAX_SOCKETS || (perIpEnabled && here > MAX_PER_IP)) {
    try { sock.close(1013, 'busy'); } catch { /* already gone */ }
    return;
  }

  sock.isAlive = true;
  sock.on('pong', () => { sock.isAlive = true; });

  sock.on('message', (raw) => {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== frameWindow) { frameWindow = sec; frames = 0; bytes = 0; }
    frames += 1;
    bytes += raw.length;
    if (frames > MAX_FRAMES_PER_SEC || bytes > MAX_BYTES_PER_SEC) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join') {
      if (blob) return;
      if (worlds.size >= MAX_WORLDS) {
        send(sock, { t: 'full', room: 'solo' });
        return;
      }
      lobby = openWorld(ip);
      // 🔴 cleanPid, not the raw field. It reaches the database as a value in a
      // parameterised query either way, but a join frame is hostile input and a
      // 4 MB string would otherwise sit on this blob for ten minutes and be
      // written at the end of it. Anything that is not a player id, the short
      // code or the old v4 UUID, becomes '', and '' means this round is played
      // but not recorded.
      blob = lobby.addHuman(sock, cleanName(msg.name) || 'Newco',
        cleanSkin(msg.skin), cleanLogo(msg.logo), store.cleanPid(msg.pid));
      lobby.balanceBots();
      send(sock, {
        t: 'welcome',
        id: blob.id,
        room: lobby.id,
        name: lobby.name,
        world: R.WORLD,
        radius: R.BLOB_RADIUS,
      });
      send(sock, { t: 'dots', d: lobby.allDots() });
      send(sock, lobby.metaFrame());
      // Every logo already in the room, then tell the room about this one.
      for (const o of lobby.blobs.values()) {
        if (o.skin) send(sock, { t: 'skin', id: o.id, png: o.skin });
      }
      if (blob.skin) lobby.broadcast({ t: 'skin', id: blob.id, png: blob.skin });
      return;
    }

    if (msg.t === 'in' && blob) {
      const dx = Number(msg.dx);
      const dy = Number(msg.dy);
      // 🔴 Number('1e400') is Infinity, and Infinity / hypot(Inf, Inf) is NaN. A
      // NaN position defeats every `<` and `>` in the simulation at once: the
      // blob ate every dot on the board every tick, could not be acquired because
      // `NaN < r*r` is false, and serialised as null into the fixed-width
      // snapshot. One frame, sent by anyone, with no account needed.
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const len = Math.hypot(dx, dy);
      if (Number.isFinite(len) && len > 0.001) { blob.dx = dx / len; blob.dy = dy / len; }
      else { blob.dx = 0; blob.dy = 0; }
      blob.boost = msg.b === true;
      // Stamped so world.js can tell a player who let go from a tab that stopped
      // talking. Without it a backgrounded tab sprints and steers forever.
      blob.inputAt = Date.now();
      // How far this client can see. Clamped in cleanView, because it decides how
      // much this socket is sent and is therefore an amplification lever.
      if (msg.v !== undefined) blob.view = cleanView(msg.v);
    }
  });
});

// A browser tab that is closed without a clean close frame leaves a socket that
// looks open for minutes. Ping every 20 s and drop anything that stops answering,
// or dead companies pile up on the board.
setInterval(() => {
  for (const sock of wss.clients) {
    if (!sock.isAlive) { sock.terminate(); continue; }
    sock.isAlive = false;
    try { sock.ping(); } catch { /* already gone */ }
  }
}, 20000);

// --- the loop -----------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  lastTickAt = now;
  for (const l of worlds.values()) {
    // One market must never be able to stop the others. But swallowing the same
    // throw 20 times a second forever is worse than crashing: that lobby would
    // stop sending snapshots while /healthz still answered 200, so Railway would
    // never restart it. Tolerate a blip, give up on a pattern.
    try {
      l.step(now);
      // 🔴 Coalesced, not sent on every change. Companies are founded and acquired
      // all round, so `metaDirty` is set on many ticks, and the unthrottled version
      // pushed the whole roster of unchanging names down every socket each time. Positions still
      // move at the full 20 Hz — only the names wait, and names do not change.
      if (l.metaDirty && now - l.metaSentAt >= META_INTERVAL_MS) {
        l.broadcast(l.metaFrame());
        l.metaDirty = false;
        l.metaSentAt = now;
      }
      l.sendSnapshots(now);
      tickFails.delete(l.id);
    } catch (e) {
      const n = (tickFails.get(l.id) || 0) + 1;
      tickFails.set(l.id, n);
      console.error(`lobby ${l.id} tick failed (${n}):`, e && e.stack ? e.stack : e);
      // One player's market must not take the process down with everybody
      // else's. A world that throws 20 ticks running is closed and its player is
      // told. `process.exit(1)` made sense when there were four fixed lobbies and
      // a broken one meant a broken build; it does not when a world is per-player.
      if (n >= 20) {
        console.error(`market ${l.id} failed 20 ticks running, closing it`);
        for (const b of l.blobs.values()) {
          if (b.human && b.sock) send(b.sock, { t: 'full', room: 'solo' });
        }
        closeWorld(l);
      }
    }
    l.dotAdds.length = 0;
  }
}, 1000 / TICK_HZ);

// Railway sends SIGTERM on every redeploy. Without this, Node exits when the
// event loop empties, which it never does here, so the platform eventually SIGKILLs
// and every open socket is reset mid-frame with no reason code. File every round
// in progress, stop listening, tell each player why, give the writes a moment to
// land, then go.
//
// 🔴 The writes are AWAITED, up to two seconds, and the pool is closed only after.
// The old handler closed the pool straight away and exited at 400 ms, which was
// fine while a round could only be filed at the bell. Now a redeploy files one
// for every player on the board. 400 ms is still the floor, so the close frames
// below reach the players even when there is nothing to write.
//
// 🔴 NONE OF THIS RUNS UNLESS RAILWAY WAITS FOR IT. Its documented default gap
// between SIGTERM and SIGKILL is 0 seconds (RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
// railway.json sets deploy.drainingSeconds to 5, past the 2.5 s cap below.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    const now = Date.now();
    let filed = 0;
    for (const l of worlds.values()) {
      for (const b of l.blobs.values()) if (b.human && l.leave(b, now)) filed += 1;
    }
    console.log(`${sig}: closing ${worlds.size} markets and ${wss.clients.size} sockets, `
      + `${filed} rounds filed`);
    server.close();
    for (const sock of wss.clients) {
      try { sock.close(1001, 'server restarting'); } catch { /* already gone */ }
    }
    setTimeout(() => process.exit(0), 2500).unref();
    Promise.all([store.drain(2000), new Promise((r) => setTimeout(r, 400))])
      .then(() => store.close())
      .catch(() => {})
      .then(() => process.exit(0));
  });
}

server.listen(PORT, () => {
  console.log(`AgarIPO on :${PORT}  static=${STATIC_DIR}  gz=${GZIPPED.size}  `
    + `solo markets, ${R.FIELD_SIZE} pre-IPO companies each, max ${MAX_WORLDS}`);
});
