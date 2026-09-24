'use strict';
// Player accounts, as small as they can be and still work.
//
// A player IS their player id: a short code minted in their browser the first
// time they open the game, shown on the login card, and sent with every round.
// Typing that code into another browser logs them in there. An email and a
// password are optional and only ever a second way to get the same code back.
//
// 🔴 THE PLAYER ID IS A LOGIN KEY, SO IT IS NEVER PUBLISHED. The leaderboard
// shows the name and a 4-character tag hashed from the id (store.tagOf), never
// the id itself. An id only ever goes back to someone who just sent it, or who
// just proved they own it with the right password.
//
// Deliberately NOT here: email verification, password reset, sessions, social
// login. There is no mail sending at all, so a forgotten password is recovered
// by logging in with the player id instead.
//
// 🔴 EVERY HASH IS crypto.scrypt, THE ASYNC ONE. scryptSync would run for tens
// of milliseconds on the same thread as every market's 20 Hz tick.

const crypto = require('crypto');
const store = require('./store');

const NAME_MIN = 2;
const NAME_MAX = 16;
const EMAIL_MAX = 254;
const PASS_MIN = 8;
const PASS_MAX = 128;

// N=16384, r=8 is 16 MB of memory per hash, inside Node's 32 MB default. At that
// memory OWASP's floor is p=5, which is what every new hash uses ('s2'). The
// first accounts were hashed with p=1 ('s1'), and the parameters are not stored
// in the hash, so each prefix keeps its own set and a login checks against the
// set its prefix names.
const SCRYPT = {
  s1: { N: 16384, r: 8, p: 1 },
  s2: { N: 16384, r: 8, p: 5 },
};
const HASH_NOW = 's2';
const KEY_LEN = 32;

// Same strip as the company name in index.js: control characters, bidirectional
// overrides and zero-width joiners. A player name is drawn on a public page
// beside everyone else's.
const NAME_STRIP = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

function cleanPlayerName(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(NAME_STRIP, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, NAME_MAX).join('').trim();
}

function cleanEmail(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  // 🔴 Control characters are refused here, not left to the database: a NUL in
  // a query parameter is a Postgres error, which answered 500 instead of 400.
  if (s.length > EMAIL_MAX || /[\u0000-\u001f\u007f]/.test(s)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

// "w***@example.com". Enough for the owner to recognise it, not enough to read.
function maskEmail(e) {
  if (typeof e !== 'string' || e.indexOf('@') < 1) return '';
  return e[0] + '***' + e.slice(e.indexOf('@'));
}

function scrypt(pw, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, KEY_LEN, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT[HASH_NOW]);
  return `${HASH_NOW}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(pw, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 3 || !Object.prototype.hasOwnProperty.call(SCRYPT, parts[0])) return false;
  const want = Buffer.from(parts[2], 'base64');
  const got = await scrypt(pw, Buffer.from(parts[1], 'base64'), SCRYPT[parts[0]]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// --- attempts per address -------------------------------------------------------
// Fixed windows, in memory. A restart forgets them, which is fine: a restart
// also takes long enough to be its own rate limit. The login window is the one
// that matters, and at 20 tries per 10 minutes a guessed password is a long
// project.
const LIMITS = {
  player: [60, 60 * 1000],
  register: [6, 10 * 60 * 1000],
  login: [20, 10 * 60 * 1000],
  // Per EMAIL as well as per address, so a password tried from many addresses
  // at once still runs into a wall. The price: someone who fills it can hold an
  // owner's EMAIL login shut for up to ten minutes. Their player id still logs
  // them in wherever they have it, and a login that succeeds gives its try back.
  'login-email': [10, 10 * 60 * 1000],
  // Rounds filed by players who left before the bell, per address. index.js
  // counts these; a round that reaches the bell is never capped.
  leave: [20, 10 * 60 * 1000],
};
const hits = new Map();

// Counts one attempt and says whether it is over the limit. `who` is an address,
// or an email for 'login-email'.
function limited(route, who) {
  const [max, windowMs] = LIMITS[route];
  const key = route + ' ' + who;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now >= h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n += 1;
  return h.n > max;
}

// Gives one attempt back: a password that turned out to be right is not a guess.
function refund(route, who) {
  const h = hits.get(route + ' ' + who);
  if (h && h.n > 0) h.n -= 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now >= h.reset) hits.delete(k);
}, 60 * 1000).unref();

// --- the three routes -------------------------------------------------------------
const say = (status, body) => ({ status, body });
const nope = (status, reason) => say(status, { ok: false, reason });
const OFFLINE = 'Accounts are offline right now. You can still play.';
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';

// POST /api/player  { pid, name?, from?, password? }
//   pid alone         who is this id? Used on load, and by "log in with a player id".
//   pid + name        Go public: play under this name from now on.
//   pid + from        everything `from` holds moves to `pid`, a fresh short id:
//                     a browser trading its old UUID for a code, or a player
//                     swapping an id they leaked for a new one. The old id then
//                     holds nothing, so it stops working. `password` too, when
//                     `from` has an account.
async function player(body, ip) {
  const pid = store.typedPid(body.pid);
  if (!pid) return nope(400, 'That is not a player ID. It looks like K7QM-3XPD-9RWT.');
  if (body.from !== undefined) {
    const from = store.cleanPid(body.from);
    if (!from || from === pid || store.isLegacyPid(pid)) return nope(400, 'Nothing to move.');
    // 🔴 WITH A PASSWORD, THE ID ALONE IS NOT ENOUGH TO MOVE IT. For an id with
    // nothing behind it, knowing the id is the only proof there is, so it is
    // proof enough. An account has a stronger one, and a move that skipped it
    // would let anyone who ever saw the id take the account and lock its owner
    // out. Checked behind the same two buckets as a login.
    const owner = await store.secretOf(from);
    if (owner === undefined) return nope(503, OFFLINE);
    if (owner && owner.pass) {
      if (limited('login', ip) || limited('login-email', owner.email)) return nope(429, TOO_MANY);
      const pw = typeof body.password === 'string' ? body.password.slice(0, PASS_MAX + 1) : '';
      if (!pw) return nope(401, 'This ID has an account. Type its password to move it.');
      if (!(await checkPassword(pw, owner.pass))) {
        return nope(401, 'That is not the password on this account.');
      }
      refund('login-email', owner.email);
    }
    // store.upgrade() only ever moves onto an id nobody holds yet.
    const moved = await store.upgrade(from, pid);
    if (moved === undefined) return nope(503, OFFLINE);
    if (moved < 0) return nope(409, 'That player ID is already taken.');
  }
  let row;
  if (body.name !== undefined) {
    const name = cleanPlayerName(body.name);
    if (name.length < NAME_MIN) return nope(400, `Pick a player name of ${NAME_MIN} to ${NAME_MAX} characters.`);
    row = await store.nameAs(pid, name);
  } else {
    row = await store.findPlayer(pid);
  }
  if (row === undefined) return nope(503, OFFLINE);
  if (!row) return say(200, { ok: true, found: false, pid, tag: store.tagOf(pid) });
  return say(200, {
    ok: true, found: true, pid, tag: store.tagOf(pid),
    name: row.name, email: maskEmail(row.email),
  });
}

// POST /api/register  { pid, name, email, password }
// Puts an email and a password in front of an id that has neither.
async function register(body) {
  const pid = store.cleanPid(body.pid);
  const name = cleanPlayerName(body.name);
  const email = cleanEmail(body.email);
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!pid) return nope(400, 'This browser has no player ID yet. Reload the page.');
  if (name.length < NAME_MIN) return nope(400, `Pick a player name of ${NAME_MIN} to ${NAME_MAX} characters first.`);
  if (!email) return nope(400, 'Enter a real email address.');
  if (pw.length < PASS_MIN) return nope(400, `Use a password of at least ${PASS_MIN} characters.`);
  if (pw.length > PASS_MAX) return nope(400, `Keep the password under ${PASS_MAX} characters.`);
  const hash = await hashPassword(pw);
  const done = await store.register(pid, name, email, hash);
  if (done === undefined) return nope(503, OFFLINE);
  if (done === 'email-taken') return nope(409, 'That email already has an account. Log in instead.');
  if (done === 'has-account') return nope(409, 'This player already has an account. Log in with it.');
  return say(201, { ok: true, pid, tag: store.tagOf(pid), name, email: maskEmail(email) });
}

// POST /api/login  { email, password }
// The one response that hands out a player id, and only for the right password.
async function login(body) {
  const email = cleanEmail(body.email);
  const pw = typeof body.password === 'string' ? body.password.slice(0, PASS_MAX + 1) : '';
  if (!email || !pw) return nope(400, 'Enter your email and your password.');
  if (limited('login-email', email)) return nope(429, TOO_MANY);
  const row = await store.byEmail(email);
  if (row === undefined) return nope(503, OFFLINE);
  // An unknown email costs a full hash, as an account made since p=5 does, so a
  // login is no quicker way to learn who plays than register already is.
  // Register has to say "that email already has an account", and it does: which
  // emails exist is not a secret this game keeps. What stops a password being
  // guessed is the two buckets, per address and per email.
  const ok = row ? await checkPassword(pw, row.pass) : (await hashPassword(pw), false);
  if (!ok) return nope(401, 'Wrong email or password.');
  refund('login-email', email);
  return say(200, {
    ok: true, pid: row.pid, tag: store.tagOf(row.pid),
    name: row.name, email: maskEmail(row.email),
  });
}

const ROUTES = { '/api/player': player, '/api/register': register, '/api/login': login };

function isRoute(path) {
  return Object.prototype.hasOwnProperty.call(ROUTES, path);
}

// Never throws: every path out is a status and a JSON body.
async function handle(path, body, ip) {
  const route = path.slice(5);   // '/api/login' -> 'login'
  if (limited(route, ip)) return nope(429, TOO_MANY);
  try {
    return await ROUTES[path](body, ip);
  } catch (e) {
    console.error(`accounts: ${route} failed:`, e && e.message ? e.message : e);
    return nope(500, 'Something went wrong. Try again.');
  }
}

module.exports = {
  handle, isRoute, limited, cleanPlayerName, cleanEmail, maskEmail, hashPassword, checkPassword,
  NAME_MIN, NAME_MAX, PASS_MIN, LIMITS,
};
