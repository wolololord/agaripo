'use strict';
// The global leaderboard's memory, in Postgres: `rounds`, one row per round
// played, filed at the closing bell or when the player leaves before it and
// never changed after; and `players`, the name each player id plays under.
//
// 🔴 POSTGRES AND NOT A RAILWAY VOLUME, and the reason is in this repo's own
// Dockerfile. The game container ends `USER node`, and Railway's own docs say a
// non-root image "will have permissions issues when performing operations
// within an attached volume", with `RAILWAY_RUN_UID=0` as the fix. That fix is
// "run the public-internet game server as root" — a real downgrade, bought to
// save a few dollars a month on a service that also gives us SQL, concurrent
// writes and no single-replica constraint. A volume was the cheaper answer to
// the wrong question.
//
// 🔴 NOTHING IN HERE IS CLIENT-SUPPLIED EXCEPT THE NAME AND THE PLAYER ID. Every
// number is computed by world.js from the authoritative simulation. That is the
// only reason a public leaderboard anyone can join without signing up is worth
// building: there is no field for anyone to inflate. A player can lie about
// their name, and that is the whole attack surface.
//
// 🔴 THE GAME MUST SURVIVE THIS FILE BEING BROKEN. No DATABASE_URL, a database
// that is down, a query that throws — all of them leave the game running and
// only cost the leaderboard. Every export below is safe to call when `enabled`
// is false, and the write path never returns a promise anyone awaits.

const crypto = require('crypto');

const URL_ENV = process.env.DATABASE_URL || '';
// Railway's private network does not need TLS and its proxy does not require
// it, so this is opt-in rather than guessed from the hostname.
const WANT_SSL = process.env.DATABASE_SSL === '1' || /[?&]sslmode=require/.test(URL_ENV);

let Pool = null;
let pool = null;
let schemaOk = null;      // null = not tried, Promise while trying, true/false after
let writeFails = 0;
let writeOk = 0;
// Every SELECT this process has sent. Exposed by stats() so the cache in front
// of the two public routes can be TESTED rather than asserted: fire eight
// concurrent requests, read this twice, and a thundering herd is visible.
let reads = 0;

if (URL_ENV) {
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    console.error('store: DATABASE_URL is set but `pg` did not load:', e.message);
  }
}

if (Pool) {
  pool = new Pool({
    connectionString: URL_ENV,
    // Four is plenty. This process writes one row per player per ten minutes and
    // answers a cached page; a big pool would only be more idle sockets for
    // Railway to bill and more for the tick loop to compete with.
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 6000,
    ssl: WANT_SSL ? { rejectUnauthorized: false } : undefined,
  });
  // 🔴 A Pool with no 'error' listener CRASHES the process when an idle client
  // dies, and an idle client dies every time Railway restarts the database. The
  // game would go down with it, which is the exact thing this file promises not
  // to do.
  pool.on('error', (e) => {
    console.error('store: idle client error (the game is unaffected):', e.message);
  });
}

const enabled = !!pool;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id         BIGSERIAL   PRIMARY KEY,
  pid        TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  logo       INTEGER     NOT NULL,
  peak       INTEGER     NOT NULL,
  final      INTEGER     NOT NULL,
  rank       INTEGER,
  field      INTEGER     NOT NULL,
  took       INTEGER     NOT NULL,
  took_value INTEGER     NOT NULL,
  secs       INTEGER     NOT NULL,
  ended_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rounds_peak_idx     ON rounds (peak DESC);
CREATE INDEX IF NOT EXISTS rounds_pid_peak_idx ON rounds (pid, peak DESC);
CREATE INDEX IF NOT EXISTS rounds_ended_idx    ON rounds (ended_at DESC);
-- One row per player id: the name they play under and, only if they made an
-- account, an email and a password hash. rounds.pid carries no foreign key on
-- purpose: a round is filed whether or not this row exists, and rows from before
-- accounts existed still render.
CREATE TABLE IF NOT EXISTS players (
  pid        TEXT        PRIMARY KEY,
  name       TEXT        NOT NULL DEFAULT '',
  email      TEXT        UNIQUE,
  pass       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Lazy, and retried. Railway's private DNS can still be resolving when this
// container starts, so a schema pass at boot would fail for a reason that has
// gone away by the time anyone finishes a round.
function ready() {
  if (!pool) return Promise.resolve(false);
  if (schemaOk === true) return Promise.resolve(true);
  if (schemaOk && typeof schemaOk.then === 'function') return schemaOk;
  schemaOk = pool.query(SCHEMA)
    .then(() => { schemaOk = true; console.log('store: rounds table ready'); return true; })
    .catch((e) => {
      schemaOk = null;   // null, not false: the next round tries again.
      console.error('store: schema not ready, will retry:', e.message);
      return false;
    });
  return schemaOk;
}

const INSERT = `INSERT INTO rounds
  (pid, name, logo, peak, final, rank, field, took, took_value, secs)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;

// A player id is the player's login key: three groups of four out of Crockford's
// base32, which has no I, L, O or U, so nothing on it can be misread when it is
// written down and typed back in on another device. 60 bits, minted in the
// browser. The older form, a v4 UUID, is still honoured for the browsers that
// were handed one before this existed.
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const PID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Control characters, bidirectional overrides and zero-width joiners. A name is
// drawn on a public page beside other people's names, where a right-to-left
// override reverses the text around it.
const NAME_STRIP = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e'
  + '\\u2066-\\u2069\\ufeff]', 'g');

// What arrives on the wire, exactly as the client stored it. Anything else is ''.
function cleanPid(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  return (CODE_RE.test(v) || PID_RE.test(v)) ? v : '';
}

// What a player TYPES into the log-in box: any case, with or without the
// dashes, and I, L and O read as the digits they are mistaken for.
function typedPid(v) {
  if (typeof v !== 'string' || v.length > 64) return '';
  const t = v.trim();
  if (PID_RE.test(t.toLowerCase())) return t.toLowerCase();
  const s = t.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(s)) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function isLegacyPid(v) {
  return typeof v === 'string' && PID_RE.test(v);
}

// A stable 4-character tag for a player id, shown beside every player name on
// the leaderboard. Names are not unique, and the tag is what tells two players
// who chose the same one apart.
//
// 🔴 A HASH, not a slice of the id. The id is this browser's only identity and
// it is never published; handing out even a few characters of it would put a
// guessable prefix in front of anyone who wanted to file rounds as somebody
// else. 16 bits collide often enough that the tag is a hint, not a key.
function tagOf(pid) {
  return crypto.createHash('sha256').update('agaripo:' + pid).digest('hex').slice(0, 4);
}

const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
};

// Every write still in flight. Only record() adds to it.
const pending = new Set();

// Fire and forget, by design and not by laziness. close() is called from step(),
// which runs inside the tick loop's try/catch: a throw here would be counted as
// a failed tick, and twenty of those close the player's market. An awaited write
// would be worse still, because it would put a network round trip on the same
// thread as a 20 Hz simulation.
function record(row) {
  if (!pool) return;
  const pid = cleanPid(row.pid);
  if (!pid) return;                       // a client too old to send one, or junk
  // The same strip index.js applies to a join frame, applied again at the
  // boundary that actually writes. index.js is the only caller today and it
  // already cleans; this file calls itself the boundary, so it behaves like one
  // rather than trusting a module one import away to keep doing it.
  const name = String(row.name || '')
    .replace(NAME_STRIP, '').trim().slice(0, 22);
  const args = [
    pid, name, int(row.logo, -1, 9999),
    int(row.peak, 0, 2000000000), int(row.final, 0, 2000000000),
    row.rank == null ? null : int(row.rank, 1, 100000),
    int(row.field, 0, 100000), int(row.took, 0, 100000),
    int(row.tookValue, 0, 2000000000), int(row.secs, 0, 86400),
  ];
  const p = ready().then((ok) => (ok ? pool.query(INSERT, args) : null))
    .then((r) => { if (r) writeOk += 1; })
    .catch((e) => {
      writeFails += 1;
      console.error(`store: round not recorded (${writeFails} failed, ${writeOk} written):`,
        e.message);
    });
  // Kept until it settles, so a shutdown can wait for the rounds it just filed
  // instead of exiting underneath them. See drain().
  pending.add(p);
  p.finally(() => pending.delete(p));
}


// For SIGTERM: give the writes already sent up to `ms` to land, then stop
// waiting. Never rejects, because nothing after it can do anything about a
// failure except exit.
function drain(ms) {
  if (!pending.size) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...pending]),
    new Promise((r) => setTimeout(r, ms).unref()),
  ]);
}

// One row per player: their best round. DISTINCT ON would need a second pass to
// order the result, and the window function gets the play count in the same
// scan rather than in a second query.
const TOP = `
-- 🔴 plays::int. COUNT() is bigint and node-postgres hands bigint back as a
-- STRING, because a 64-bit integer does not fit a JavaScript number. It would
-- have reached the page as "1" and rendered correctly by luck, and broken the
-- first time anything compared or added it.
--
-- The player's name comes from the players table, the one place it is kept, so a
-- rename shows on every round they ever played. 🔴 NEVER p.email: these two
-- queries feed public routes. last_at is the player's most recent round, which
-- is what "last seen" means; the best round's own date is not.
SELECT x.name, x.logo, x.peak, x.final, x.rank, x.took, x.secs, x.ended_at,
       x.last_at, x.plays::int AS plays, x.best_pid, p.name AS player
FROM (
  SELECT r.name, r.logo, r.peak, r.final, r.rank, r.took, r.secs,
         r.ended_at, r.pid AS best_pid,
         ROW_NUMBER() OVER (PARTITION BY r.pid ORDER BY r.peak DESC, r.id DESC) AS rn,
         COUNT(*)      OVER (PARTITION BY r.pid) AS plays,
         MAX(r.ended_at) OVER (PARTITION BY r.pid) AS last_at
  FROM rounds r
) x
LEFT JOIN players p ON p.pid = x.best_pid
WHERE x.rn = 1
ORDER BY x.peak DESC, x.ended_at ASC
LIMIT $1`;

const RECENT = `
SELECT r.name, r.logo, r.peak, r.final, r.rank, r.field, r.took, r.secs, r.ended_at,
       r.pid, p.name AS player
FROM rounds r LEFT JOIN players p ON p.pid = r.pid
ORDER BY r.id DESC LIMIT $1`;

const TOTALS = `
SELECT COUNT(*)::int AS rounds, COUNT(DISTINCT pid)::int AS players,
       COALESCE(MAX(peak), 0)::int AS best, MIN(ended_at) AS since
FROM rounds`;

// 🔴 THE TWO READERS RETURN ROWS THAT STILL CARRY `pid`, AND NOTHING MAY SEND
// ONE. index.js caches what comes back here and runs publish() over it per
// request, which is the ONE place an id is turned into a tag and a `you` flag.
// Splitting it that way is what lets the HTTP layer cache a result for every
// caller without either serving one player's identity to another or handing an
// attacker a way to miss the cache with a header. If you add a third reader,
// route it through publish() too.
async function leaderboard(limit) {
  if (!pool || !(await ready())) return null;
  const n = Math.min(200, Math.max(1, limit | 0));
  reads += 2;
  const [top, totals] = await Promise.all([pool.query(TOP, [n]), pool.query(TOTALS)]);
  return {
    rows: top.rows.map((r) => ({
      pid: r.best_pid,
      player: r.player || '',
      name: r.name,
      logo: r.logo,
      peak: r.peak,
      final: r.final,
      rank: r.rank,
      took: r.took,
      plays: r.plays,
      at: r.last_at,
    })),
    totals: totals.rows[0] || null,
  };
}

async function recent(limit) {
  if (!pool || !(await ready())) return null;
  const n = Math.min(500, Math.max(1, limit | 0));
  reads += 1;
  const r = await pool.query(RECENT, [n]);
  return {
    rows: r.rows.map((x) => ({
      pid: x.pid,
      player: x.player || '',
      name: x.name,
      logo: x.logo,
      peak: x.peak,
      final: x.final,
      rank: x.rank,
      field: x.field,
      took: x.took,
      secs: x.secs,
      at: x.ended_at,
    })),
  };
}

// --- players -------------------------------------------------------------------
// Everything below answers one player about themselves. Each function returns
// `undefined` when there is no database, so a caller can tell "accounts are
// offline" apart from "no such player" without a second flag.

// A player id with a row here, OR with any round on the board. 🔴 The round
// counts on its own: it is filed whether or not the call that names the player
// ever landed, and an id with rounds on the board is a player who can log in
// with it, row or no row.
async function findPlayer(pid) {
  if (!pool || !(await ready())) return undefined;
  const r = await pool.query('SELECT name, email FROM players WHERE pid = $1', [pid]);
  if (r.rows[0]) return r.rows[0];
  const any = await pool.query('SELECT 1 FROM rounds WHERE pid = $1 LIMIT 1', [pid]);
  return any.rowCount ? { name: '', email: null } : null;
}

// Go public: the name this player id plays under from now on. Creates the row on
// first use. Returns the row as it now stands.
async function nameAs(pid, name) {
  if (!pool || !(await ready())) return undefined;
  const r = await pool.query(`INSERT INTO players (pid, name) VALUES ($1, $2)
    ON CONFLICT (pid) DO UPDATE SET name = EXCLUDED.name, seen_at = now()
    RETURNING name, email`, [pid, name]);
  return r.rows[0] || null;
}

// An email and a password hash, attached to an id that has none yet. Returns
// 'ok', 'has-account' (this id already has an email) or 'email-taken'.
async function register(pid, name, email, pass) {
  if (!pool || !(await ready())) return undefined;
  try {
    const r = await pool.query(`INSERT INTO players (pid, name, email, pass)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (pid) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email, pass = EXCLUDED.pass, seen_at = now()
        WHERE players.email IS NULL
      RETURNING pid`, [pid, name, email, pass]);
    return r.rowCount ? 'ok' : 'has-account';
  } catch (e) {
    // 23505 is a unique violation, and the only unique column the upsert does
    // not handle is the email.
    if (e && e.code === '23505') return 'email-taken';
    throw e;
  }
}

// The email and password hash on one player id, for the one check that needs
// them by id: moving an account that has a password. Never sent anywhere.
async function secretOf(pid) {
  if (!pool || !(await ready())) return undefined;
  const r = await pool.query('SELECT email, pass FROM players WHERE pid = $1', [pid]);
  return r.rows[0] || null;
}

async function byEmail(email) {
  if (!pool || !(await ready())) return undefined;
  const r = await pool.query('SELECT pid, name, email, pass FROM players WHERE email = $1', [email]);
  return r.rows[0] || null;
}

// Everything one player id holds moves to another: a browser trading its old
// UUID for a short id it can write down, or a player swapping an id they leaked
// for a new one. The rounds and the row, email and password included, move in
// one transaction, and only onto an id nobody holds yet. Returns how many
// rounds moved, or -1 if `to` is taken.
async function upgrade(from, to) {
  if (!pool || !(await ready())) return undefined;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const busy = await c.query(`SELECT 1 FROM players WHERE pid = $1
      UNION ALL SELECT 1 FROM rounds WHERE pid = $1 LIMIT 1`, [to]);
    if (busy.rowCount) { await c.query('ROLLBACK'); return -1; }
    const moved = await c.query('UPDATE rounds SET pid = $1 WHERE pid = $2', [to, from]);
    await c.query('UPDATE players SET pid = $1 WHERE pid = $2', [to, from]);
    await c.query('COMMIT');
    return moved.rowCount;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// The privacy boundary, and the only function that is allowed to see both a
// stored id and an outgoing object. `me` is the caller's own id, read from a
// request header rather than a query string so it is never in a URL, a log line
// or a Referer.
function publish(rows, me) {
  return rows.map((r) => {
    const out = { tag: tagOf(r.pid), you: !!me && r.pid === me };
    for (const k of Object.keys(r)) if (k !== 'pid') out[k] = r[k];
    return out;
  });
}

function stats() {
  return {
    enabled, written: writeOk, failed: writeFails, schema: schemaOk === true, reads,
  };
}

async function close() {
  if (pool) await pool.end().catch(() => {});
}

module.exports = {
  enabled, record, drain, leaderboard, recent, publish, stats, close,
  cleanPid, typedPid, isLegacyPid, tagOf,
  findPlayer, nameAs, register, secretOf, byEmail, upgrade,
};
