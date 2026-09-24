'use strict';
// One lobby = one live market. The server owns every position, every valuation and
// every takeover; clients send a direction and draw what comes back.

const R = require('./rules');

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const RESPAWN_SECONDS = 3.5;
// A company that spawns inside someone's mouth is not a game. For three seconds
// a new company can neither acquire nor be acquired, which is the difference
// between "I got unlucky" and "I never got a turn".
const SPAWN_SAFE_MS = 3000;

// 🔴 The capital is kept in a uniform grid, not scanned as a flat list. Every
// blob against every dot is FIELD_SIZE x DOT_COUNT x 20 Hz per market, which is
// 1.3 million distance tests a second (50 x 1300 x 20) on the same thread as
// the game tick. With a 250-unit cell a blob only looks at the handful of cells
// its own radius covers, so the work follows the blob's SIZE rather than the
// size of the board.
const CELL = 250;
const GRID_W = Math.ceil(R.WORLD / CELL);

// The roster is one entry per company on the board. Rebroadcasting it whenever
// any company is founded or acquired meant several KB on nearly every tick, so it
// is coalesced to this interval. Positions still move at the full 20 Hz; only
// names, colours and logo indices wait, and those do not change.
const META_INTERVAL_MS = 500;

// The live leaderboard down the side of the screen. It is the same for every
// player, so it is computed once a tick and attached to snapshots every LB_EVERY
// ticks: ten ids and ten valuations is about 80 bytes, and at the full 20 Hz
// that would be 1.6 KB a second per player for a list that visibly changes a few
// times a minute. Every 5th tick is 4 updates a second, which is faster than a
// human reads it.
const LB_ROWS = 10;
const LB_EVERY = 5;

// How many takeovers the end card can name. A player who dominates a ten minute
// round can acquire more companies than there are on the board, because an
// acquired company is refounded behind them, so this is a CAP ON WHAT IS KEPT,
// not a cap on what is counted: the count and the total value are exact and only
// the named list is trimmed, biggest first.
const TROPHY_ROWS = 12;

// A player who closes the tab before the bell still gets their round filed, as
// long as it was a round: this long on the board, and at least one dot eaten.
// Anything shorter is a page that was opened and shut, and a leaderboard full of
// $1B rows from bounced visits says less than one without them.
const LEAVE_MIN_SECONDS = 15;

// View culling bounds. MIN stops a client asking to see nothing and then
// reporting the game as broken; MAX is the board DIAGONAL, so a box that wide
// covers the whole board from any corner and there is nothing more to send.
// 🔴 9000 was not enough and it was measured: the cull is a square box around the
// player, so from a spawn at x < 1000 a 9000 box still missed the far edge and
// probe.js reported 178 of 199 companies.
// 🔴 A client sends input 20 times a second. When the browser tab is backgrounded
// it stops sending entirely, and without this the last frame it DID send keeps
// applying forever: the company sails across the board on its old heading and,
// if the button was down when the tab lost focus, burns 15% of its valuation a
// minute while nobody is playing it. 30 missed frames is the cutoff.
const IDLE_MS = 1500;

const DEFAULT_VIEW = 1600;
const MIN_VIEW = 400;
const MAX_VIEW = Math.ceil(R.WORLD * Math.SQRT2);

// The roster is R.COMPANIES: the Forge Global pre-IPO list, name and logo in the
// same row. Index into it IS the logo id, so a company can never wear another
// company's mark. Humans carry -1 and bring their own.
const NO_LOGO = -1;

let nextId = 1;

function rnd(max) { return Math.random() * max; }
function spawnPoint() { return { x: rnd(R.WORLD), y: rnd(R.WORLD) }; }
function cellIndex(x, y) {
  const cx = Math.min(GRID_W - 1, Math.max(0, (x / CELL) | 0));
  const cy = Math.min(GRID_W - 1, Math.max(0, (y / CELL) | 0));
  return cy * GRID_W + cx;
}

class Lobby {
  // `onResult` is called once per human with that player's round: at the
  // closing bell, or when they leave before it (see leave()). INJECTED rather
  // than required at the top of this file, so
  // the simulation has no opinion about whether a database exists: smoke.js
  // constructs a Lobby with no sink and every rule in here behaves identically.
  constructor(id, name, onResult) {
    this.id = id;
    this.name = name;
    this.onResult = typeof onResult === 'function' ? onResult : null;
    this.blobs = new Map();
    this.dots = new Array(R.DOT_COUNT);
    this.cells = new Array(GRID_W * GRID_W);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.dotAdds = [];        // [slot, x, y, colour, ...] since the last snapshot
    this.lbTick = 0;          // counts to LB_EVERY, then a leaderboard rides along
    this.metaDirty = true;    // the blob set changed, resend names and colours
    this.metaSentAt = 0;
    this.endsAt = Date.now() + R.ROUND_SECONDS * 1000;
    // Non-zero only between the closing bell and the reopen. While it is set the
    // world does not step at all, which is what makes the final table final.
    this.closedAt = 0;
    for (let i = 0; i < R.DOT_COUNT; i++) this.placeDot(i, false);
  }

  // Somewhere on the board, but not within reach of anything big enough to take
  // you. 24 tries, then the best of them: a bounded search, never a while(true).
  safeSpawn() {
    let best = null, bestScore = -1;
    for (let i = 0; i < 24; i++) {
      const p = spawnPoint();
      let score = Infinity;
      for (const o of this.blobs.values()) {
        if (o.dead || !R.canAcquire(o.count, 0)) continue;
        score = Math.min(score, Math.hypot(o.x - p.x, o.y - p.y));
      }
      if (score === Infinity) return p;
      if (score > bestScore) { bestScore = score; best = p; }
      if (score > 1600) return p;
    }
    return best || spawnPoint();
  }

  placeDot(slot, announce = true) {
    const old = this.dots[slot];
    if (old) {
      const bucket = this.cells[old.g];
      const at = bucket.indexOf(slot);
      if (at !== -1) bucket.splice(at, 1);
    }
    const x = Math.round(rnd(R.WORLD));
    const y = Math.round(rnd(R.WORLD));
    const d = { x, y, c: (Math.random() * 12) | 0, g: cellIndex(x, y) };
    this.dots[slot] = d;
    this.cells[d.g].push(slot);
    if (announce) this.dotAdds.push(slot, d.x, d.y, d.c);
  }

  allDots() {
    const out = [];
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i];
      out.push(i, d.x, d.y, d.c);
    }
    return out;
  }

  // Every dot slot whose cell overlaps the square of half-width `reach` around
  // (x, y). Cheap enough to call once per blob per tick, which is the point.
  dotsNear(x, y, reach, out) {
    out.length = 0;
    const x0 = Math.max(0, ((x - reach) / CELL) | 0);
    const x1 = Math.min(GRID_W - 1, ((x + reach) / CELL) | 0);
    const y0 = Math.max(0, ((y - reach) / CELL) | 0);
    const y1 = Math.min(GRID_W - 1, ((y + reach) / CELL) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * GRID_W;
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells[row + cx];
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }

  makeBlob(opts) {
    const p = this.safeSpawn();
    const b = {
      id: nextId++,
      human: !!opts.human,
      sock: opts.sock || null,
      name: opts.name,
      skin: opts.skin || '',
      // Index into R.COMPANIES, or -1. The client loads res://logos/NNN.png from
      // its own pack, so a rival's mark costs one small integer every 500 ms
      // instead of a 20 KB PNG per company.
      logo: Number.isInteger(opts.logo) ? opts.logo : NO_LOGO,
      colour: opts.colour,
      x: p.x, y: p.y,
      // 🔴 `count` is a FLOAT here and an integer on the wire. Sprinting burns
      // 0.5% of the pile, and 0.5% of $8M is 0.04: with an integer it truncates
      // to nothing and sprinting is free for everyone under $200M.
      scale: 1, count: 0,
      dx: 0, dy: 0, boost: false, burnHeld: 0, inputAt: Date.now(),
      // How far this player can see, in world units, as reported by their own
      // client each input frame. Only the browser knows its window size and the
      // camera zoom it derived from the blob's radius. The default covers a
      // 1440p window at the widest zoom, so the first frames before any input
      // arrives are still complete.
      view: DEFAULT_VIEW,
      dead: false, respawnAt: 0, safeUntil: Date.now() + SPAWN_SAFE_MS,
      think: 0, goal: null,
      // Who this company acquired THIS ROUND. Survives being acquired and
      // refounding, because the round is the unit a player plays; cleared only
      // at the bell, by reset(). Bots keep the counters too and never read them,
      // which is cheaper than branching on b.human in the takeover hot path.
      taken: [], tookCount: 0, tookValue: 0,
      // 🔴 THE HIGH SCORE IS THE PEAK, NOT THE FINAL VALUATION, and on this board
      // those are wildly different numbers. Being acquired refounds you at zero
      // with eight minutes still on the clock, so a player who reached $600B and
      // was taken at 9:58 would otherwise file a $1B round. `count` only ever
      // rises between ticks, so one comparison per tick captures it.
      // Cleared at the bell by reset(), because the round is the unit.
      peak: 0,
      // Which browser to file the result under. Empty for every bot and for any
      // client too old to send one; store.js drops those rows.
      // 🔴 READ FROM opts. This literal is written out field by field rather than
      // spread from the argument, so a new key that is not picked up here is
      // silently dropped: the first cut of this line said `pid: ''` and every
      // round filed nothing, with addHuman passing a perfectly good id into a
      // function that threw it away. smoke.js caught it in one line.
      pid: typeof opts.pid === 'string' ? opts.pid : '',
      // Set once this player's round has been filed on the way out, so a
      // shutdown that files every open round and the socket close that follows
      // it cannot file the same round twice.
      left: false,
    };
    this.blobs.set(b.id, b);
    this.metaDirty = true;
    return b;
  }

  // 🔴 The bot wearing the picked mark is REMOVED, not left running. The board
  // is every company exactly once, and the login card now fills the name box
  // with the company whose logo you clicked, so without this a player who picks
  // OpenAI puts a second OpenAI on the board and the closing table lists the
  // name twice with two different valuations. You do not play ALONGSIDE the
  // company you picked, you play AS it.
  addHuman(sock, name, skin, logo, pid) {
    if (logo >= 0) {
      for (const o of this.blobs.values()) {
        if (!o.human && o.logo === logo) this.remove(o.id);
      }
    }
    return this.makeBlob({
      human: true, sock, name, skin, logo,
      pid: typeof pid === 'string' ? pid : '',
      colour: (Math.random() * 18) | 0,
    });
  }

  remove(id) {
    if (this.blobs.delete(id)) this.metaDirty = true;
  }

  // Every company in R.COMPANIES is on the board exactly once, always. Whichever
  // one is missing is the one that gets founded, so an acquisition is immediately
  // followed by that company re-entering the market rather than by a duplicate of
  // somebody else. Runs every tick: one Set of at most FIELD_SIZE small integers.
  balanceBots() {
    const held = new Set();
    // Humans count. The seat a player is sitting in is taken, including while
    // they are dead and waiting to refound: a bot founded into that seat for
    // three and a half seconds would be acquired by the player the moment they
    // came back, wearing their own mark.
    for (const b of this.blobs.values()) {
      if (b.logo >= 0) held.add(b.logo);
    }
    if (held.size >= R.COMPANIES.length) return;
    for (let i = 0; i < R.COMPANIES.length; i++) {
      if (held.has(i)) continue;
      this.makeBlob({ name: R.COMPANIES[i].n, logo: i, colour: i % 18 });
    }
  }

  // --- the bot brain, all of it ------------------------------------------------
  steerBot(b, scratch) {
    b.think -= DT;
    if (b.think <= 0) {
      b.think = 0.4 + Math.random() * 0.3;
      b.goal = null;
      let bestThreat = 900 * 900, threat = null;
      let bestPrey = 2200 * 2200, prey = null;
      for (const o of this.blobs.values()) {
        if (o === b || o.dead) continue;
        const d2 = (o.x - b.x) ** 2 + (o.y - b.y) ** 2;
        if (R.canAcquire(o.count, b.count)) {
          if (d2 < bestThreat) { bestThreat = d2; threat = o; }
        } else if (R.canAcquire(b.count, o.count) && d2 < bestPrey) {
          bestPrey = d2; prey = o;
        }
      }
      if (threat) {
        b.goal = { x: b.x * 2 - threat.x, y: b.y * 2 - threat.y, flee: true };
      } else if (prey) {
        b.goal = { x: prey.x, y: prey.y };
      } else {
        // Through the grid, not the whole array. Every bot re-deciding twice a
        // second against every dot is hundreds of thousands of comparisons a
        // second per market, for a number that only ever mattered within a few
        // hundred units.
        let best = Infinity, pick = null;
        const near = this.dotsNear(b.x, b.y, 1200, scratch);
        for (let i = 0; i < near.length; i++) {
          const d = this.dots[near[i]];
          const d2 = (d.x - b.x) ** 2 + (d.y - b.y) ** 2;
          if (d2 < best) { best = d2; pick = d; }
        }
        b.goal = pick ? { x: pick.x, y: pick.y } : spawnPoint();
      }
    }
    if (!b.goal) return;
    const vx = b.goal.x - b.x, vy = b.goal.y - b.y;
    const len = Math.hypot(vx, vy) || 1;
    b.dx = vx / len; b.dy = vy / len;
    // Sprinting to escape, but only once there is something to spend. Under $9M
    // the 0.5% charge rounds to nothing anyway, and a bot burning its last dollar
    // to run away reads as a bug.
    b.boost = !!b.goal.flee && b.count > 8;
  }

  // Sprint is paid for in capital: 0.5% of the whole valuation every 2 seconds
  // the button is held. The held time ACCUMULATES and is never reset by letting
  // go, or tapping the button 19 times a second would be a free permanent 1.7x.
  burnForBoost(b) {
    b.burnHeld += DT;
    while (b.burnHeld >= R.BOOST_BURN_INTERVAL) {
      b.burnHeld -= R.BOOST_BURN_INTERVAL;
      const pile = R.BASE_VALUATION_B + b.count;
      const lost = pile * R.BOOST_BURN_RATE;
      const spent = Math.min(b.count, lost);
      if (spent <= 0) continue;
      b.scale = R.shrunkByBurn(b.scale, spent / (b.count || 1));
      b.count -= spent;
    }
  }

  step(now) {
    // 🔴 The frozen window. sendSnapshots() is called separately by the tick loop
    // and keeps running, so the client stays connected and keeps drawing; it is
    // only the SIMULATION that stops. Returning here rather than gating six
    // separate loops is also the version that cannot half-freeze: no bot moves,
    // no dot is eaten, nobody is acquired after the bell.
    if (this.closedAt) {
      if (now >= this.closedAt + R.CLOSING_SECONDS * 1000) this.reset(now);
      return;
    }
    this.balanceBots();
    const scratch = [];

    for (const b of this.blobs.values()) {
      if (b.dead) continue;
      if (!b.human) this.steerBot(b, scratch);
      else if (now - b.inputAt > IDLE_MS) { b.boost = false; b.dx = 0; b.dy = 0; }

      let speed = R.speedFor(b.scale);
      if (b.boost) {
        speed *= R.BOOST_FACTOR;
        this.burnForBoost(b);
      }
      b.x += b.dx * speed * DT;
      b.y += b.dy * speed * DT;
      // Nothing leaves the board. Outside it there are no dots and no rivals, and
      // an empty screen is indistinguishable from a crash.
      const r = R.BLOB_RADIUS * b.scale;
      b.x = Math.min(R.WORLD - r, Math.max(r, b.x));
      b.y = Math.min(R.WORLD - r, Math.max(r, b.y));

      // Capital. The dot always disappears; only the size gain is conditional.
      const rr = r + R.DOT_RADIUS;
      const near = this.dotsNear(b.x, b.y, rr, scratch);
      for (let n = 0; n < near.length; n++) {
        const i = near[n];
        const d = this.dots[i];
        const ddx = d.x - b.x;
        if (ddx > rr || ddx < -rr) continue;
        const ddy = d.y - b.y;
        if (ddy > rr || ddy < -rr) continue;
        if (ddx * ddx + ddy * ddy > rr * rr) continue;
        b.count += 1;
        b.scale = R.grownByDot(b.scale, b.count);
        this.placeDot(i);
      }
    }

    // Takeovers. The valuation on the blob is what decides, so what a player reads
    // and what happens can never disagree.
    const live = [...this.blobs.values()].filter((b) => !b.dead);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], c = live[j];
        if (a.dead || c.dead) continue;
        const ra = R.BLOB_RADIUS * a.scale, rc = R.BLOB_RADIUS * c.scale;
        const d2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
        if (a.safeUntil > now || c.safeUntil > now) continue;
        if (R.canAcquire(a.count, c.count) && d2 < ra * ra) this.acquire(a, c);
        else if (R.canAcquire(c.count, a.count) && d2 < rc * rc) this.acquire(c, a);
      }
    }

    // 🔴 AFTER the takeovers and BEFORE revive(), and both halves of that matter.
    // acquire() leaves the loser's `count` alone and only marks them dead, so
    // reading it here still sees the valuation they were taken at. revive() is
    // what zeroes it, so a sweep placed after that would record the respawn.
    // Humans only: a bot's peak is never read and this runs 20 times a second.
    for (const b of this.blobs.values()) {
      if (b.human && b.count > b.peak) b.peak = b.count;
    }

    for (const b of this.blobs.values()) {
      if (b.dead && b.human && now >= b.respawnAt) this.revive(b);
    }

    if (now >= this.endsAt) this.close(now);
  }

  // Every live company, richest first. The bell and an early exit both rank a
  // player against this, so a row filed either way means the same thing.
  standings() {
    return [...this.blobs.values()]
      .filter((b) => !b.dead)
      .sort((a, b) => b.count - a.count || a.id - b.id);
  }

  // One round as the global leaderboard files it, for the bell and for a player
  // who leaves early alike.
  //
  // 🔴 `final` is 0 for a player holding a death card, not the price they were
  // taken at. They finished owning nothing, and the closing card already refuses
  // to invent a rank for them for the same reason. `peak` is the honest record
  // of how big they got, and `peak` is what the leaderboard ranks on.
  //
  // 🔴 `rank` is null for a round that did not reach the bell. A rank is where
  // you FINISHED: a player who quit at 0:16 in third place did not finish third,
  // and the history would have said "3rd of 51" as if they had.
  resultFor(me, order, secs) {
    const at = order.indexOf(me);
    return {
      pid: me.pid,
      name: me.name,
      logo: me.logo,
      peak: R.BASE_VALUATION_B + Math.round(Math.max(me.peak, me.count)),
      final: at < 0 ? 0 : R.BASE_VALUATION_B + Math.round(me.count),
      rank: at < 0 || secs < R.ROUND_SECONDS ? null : at + 1,
      field: order.length,
      took: me.tookCount,
      tookValue: me.tookCount ? me.tookValue : 0,
      secs,
    };
  }

  // A player closed the tab, lost the connection, or the server is shutting
  // down. 🔴 Their round is filed HERE or never: the market exists only for
  // them and is destroyed straight after this. Before this existed, only a
  // player who sat through the whole ten minutes reached the leaderboard, and in
  // four days that was two rounds.
  //
  // Not during the frozen window after the bell: that round was filed at the
  // bell, and the next one has not started. Returns whether a row was sent.
  leave(me, now) {
    if (!me || !me.human || me.left || !this.onResult || !me.pid || this.closedAt) return false;
    me.left = true;
    const secs = Math.round((now - (this.endsAt - R.ROUND_SECONDS * 1000)) / 1000);
    if (secs < LEAVE_MIN_SECONDS || Math.max(me.peak, me.count) < 1) return false;
    this.onResult(this.resultFor(me, this.standings(), Math.min(secs, R.ROUND_SECONDS)));
    return true;
  }

  // The closing bell. One message per socket, not a broadcast, because each
  // player's own row is on their own card and a player who finished 74th still
  // has to be told they finished 74th.
  //
  // Valuations are formatted HERE, by the same rules.valuationText the ball
  // labels use, so the number on the card and the number that was on the ball
  // cannot disagree. The raw billions travel too, for the bar width.
  close(now) {
    this.closedAt = now;
    const order = this.standings();
    const row = (b, rank) => ({
      r: rank,
      n: b.name,
      g: b.logo,
      c: b.colour,
      v: R.valuationText(b.count),
      m: R.BASE_VALUATION_B + Math.round(b.count),
      h: b.human ? 1 : 0,
    });
    const top = order.slice(0, R.TABLE_ROWS).map((b, i) => row(b, i + 1));
    for (const me of this.blobs.values()) {
      if (!me.sock) continue;
      const at = order.indexOf(me);
      const mine = [...me.taken].sort((a, b) => b.m - a.m)
        .map((x) => ({ n: x.n, g: x.g, v: R.valuationText(x.m - R.BASE_VALUATION_B) }));
      send(me.sock, {
        t: 'close',
        secs: R.CLOSING_SECONDS,
        field: order.length,
        top,
        // What this player acquired, for the panel under the table. `took` and
        // `worth` are the exact totals; `mine` is only the twelve biggest.
        mine,
        took: me.tookCount,
        worth: me.tookCount ? R.valuationText(me.tookValue - R.BASE_VALUATION_B) : '',
        // null when the player was holding a death card at the bell. The card
        // says so rather than inventing a rank for a company that no longer
        // exists.
        you: at < 0 ? null : row(me, at + 1),
        // 1 when this round is being filed on the global leaderboard, so the card
        // can say so. 0 for a client with no player id, or no database.
        rec: this.onResult && me.pid && !me.left ? 1 : 0,
      });

      // ...and the same bell files the round on the global leaderboard. Fire and
      // forget: store.js never throws back into here, because this runs inside
      // step(), which runs inside the tick loop's try/catch, where twenty throws
      // close the player's market.
      if (this.onResult && me.pid && !me.left) {
        this.onResult(this.resultFor(me, order, R.ROUND_SECONDS));
      }
    }
  }

  acquire(winner, loser) {
    const worth = R.BASE_VALUATION_B + Math.round(loser.count);
    winner.tookCount += 1;
    winner.tookValue += worth;
    winner.taken.push({ n: loser.name, g: loser.logo, m: worth });
    // Biggest first, trimmed to the cap. A trophy case of the twelve largest
    // companies you took is a better record of the round than the twelve most
    // recent, and sorting 13 entries is not a cost worth thinking about.
    if (winner.taken.length > TROPHY_ROWS) {
      winner.taken.sort((a, b) => b.m - a.m);
      winner.taken.length = TROPHY_ROWS;
    }
    winner.scale = R.grownByAcquisition(winner.scale, loser.scale);
    winner.count += loser.count;
    // The player hears about their own takeover the moment it lands, so the
    // client can put it over their ball. The mirror of the `dead` frame below:
    // the name, the mark and the price the ball was wearing. A new frame type,
    // so a client from before this change ignores it rather than misreading it.
    if (winner.human) {
      send(winner.sock, { t: 'took', n: loser.name, g: loser.logo, v: R.valuationText(loser.count) });
    }
    // 🔴 Marked dead FIRST, always. The takeover loop iterates a snapshot array
    // taken before any of this ran, so an acquired bot that was only deleted from
    // the map is still in that array and its `dead` flag is the only thing
    // stopping it being acquired a second time in the same tick, handing its
    // valuation to two different companies.
    loser.dead = true;
    if (loser.human) {
      loser.respawnAt = Date.now() + RESPAWN_SECONDS * 1000;
      // `val` and `g` are for the death card: the formatted price the same way
      // the ball label formats it, and the acquirer's mark, so the card can show
      // WHO took you rather than only naming them.
      send(loser.sock, {
        t: 'dead',
        by: winner.name,
        at: Math.round(loser.count),
        val: R.valuationText(loser.count),
        g: winner.logo,
      });
    } else {
      this.remove(loser.id);
    }
  }

  revive(b) {
    const p = this.safeSpawn();
    b.x = p.x; b.y = p.y;
    b.scale = 1; b.count = 0; b.dead = false;
    b.boost = false; b.burnHeld = 0; b.inputAt = Date.now();
    b.safeUntil = Date.now() + SPAWN_SAFE_MS;
    this.metaDirty = true;
    send(b.sock, { t: 'respawn', id: b.id });
  }

  reset(now) {
    this.endsAt = now + R.ROUND_SECONDS * 1000;
    this.closedAt = 0;
    for (let i = 0; i < this.dots.length; i++) this.placeDot(i);
    for (const b of [...this.blobs.values()]) {
      if (!b.human) { this.remove(b.id); continue; }
      const p = this.safeSpawn();
      b.x = p.x; b.y = p.y; b.scale = 1; b.count = 0;
      b.dead = false; b.boost = false; b.burnHeld = 0; b.inputAt = now;
      b.safeUntil = now + SPAWN_SAFE_MS;
      b.taken = []; b.tookCount = 0; b.tookValue = 0; b.peak = 0;
    }
    this.metaDirty = true;
    this.broadcast({ t: 'reset' });
  }

  metaFrame() {
    const list = [];
    for (const b of this.blobs.values()) {
      list.push({ i: b.id, n: b.name, c: b.colour, h: b.human ? 1 : 0, g: b.logo });
    }
    return { t: 'm', blobs: list };
  }

  // 🔴 Every human gets their OWN snapshot, cut to what they can actually see.
  // The whole board is six ints per company per frame, which at 20 Hz is tens of
  // KB a second down to a player whose window shows a few per cent of a
  // 6500x6500 board. The view half-width comes from the client,
  // which is the only thing that knows its own window size and zoom, and is
  // clamped here because it arrives over the wire.
  //
  // Rank and field size move to the server with it: the client used to count them
  // out of the snapshot, and a culled snapshot cannot answer "of how many".
  sendSnapshots(now) {
    const k = Math.max(0, Math.round((this.endsAt - now) / 1000));
    const ids = [];
    const xs = [];
    const ys = [];
    const rows = [];
    for (const o of this.blobs.values()) {
      if (o.dead) continue;
      ids.push(o.id);
      xs.push(o.x);
      ys.push(o.y);
      rows.push(o.id, Math.round(o.x), Math.round(o.y), Math.round(o.scale * 100),
        Math.round(o.count), (o.safeUntil > now ? 1 : 0) | (o.boost ? 2 : 0));
    }
    const field = ids.length;
    const dots = this.dotAdds.length ? this.dotAdds : null;

    // The top of the market, [id, valuation, id, valuation, ...], richest first.
    // Only ids travel: the client already has every name, colour and mark from
    // the meta frame, which is the whole roster and is never culled to the view.
    this.lbTick = (this.lbTick + 1) % LB_EVERY;
    let lb = null;
    if (this.lbTick === 0) {
      const at = ids.map((_, i) => i)
        .sort((a, b) => rows[b * 6 + 4] - rows[a * 6 + 4] || ids[a] - ids[b])
        .slice(0, LB_ROWS);
      lb = [];
      for (const i of at) lb.push(ids[i], rows[i * 6 + 4]);
    }

    for (const me of this.blobs.values()) {
      if (!me.sock) continue;
      // A dead player keeps their last position until they refound, so the board
      // behind the death card is the board they died on.
      const reach = me.view;
      const b = [];
      for (let i = 0, n = ids.length; i < n; i++) {
        const dx = xs[i] - me.x;
        if (dx > reach || dx < -reach) continue;
        const dy = ys[i] - me.y;
        if (dy > reach || dy < -reach) continue;
        const at = i * 6;
        b.push(rows[at], rows[at + 1], rows[at + 2], rows[at + 3], rows[at + 4], rows[at + 5]);
      }
      let ahead = 0;
      for (let i = 0, n = ids.length; i < n; i++) {
        if (rows[i * 6 + 4] > Math.round(me.count)) ahead++;
      }
      const frame = { t: 's', k, b, r: ahead + 1, f: field };
      if (dots) frame.d = dots;
      if (lb) frame.lb = lb;
      rawSend(me.sock, JSON.stringify(frame), true);
    }
  }

  // `skippable` is true for snapshots, which are disposable: the next one is 50 ms
  // away and carries the whole world state again. Names, logos and round resets
  // are not, so they are never dropped.
  broadcast(msg, skippable = false) {
    const raw = JSON.stringify(msg);
    for (const b of this.blobs.values()) if (b.sock) rawSend(b.sock, raw, skippable);
  }
}

function send(sock, msg) {
  if (sock) rawSend(sock, JSON.stringify(msg));
}

// Outbound backpressure. A client that stalls its TCP receive window would
// otherwise accumulate an unbounded send buffer inside this process, which is the
// memory-exhaustion path: 20 Hz of snapshots into a socket nobody is reading.
const SKIP_ABOVE = 256 * 1024;
const KILL_ABOVE = 4 * 1024 * 1024;

function rawSend(sock, raw, skippable = false) {
  if (sock.readyState !== 1) return;
  const queued = sock.bufferedAmount;
  if (queued > KILL_ABOVE) { try { sock.terminate(); } catch { /* gone */ } return; }
  if (skippable && queued > SKIP_ABOVE) return;
  try { sock.send(raw); } catch { /* a socket closing mid-broadcast is normal */ }
}

// The view half-width arrives over the wire, so it is hostile until clamped.
function cleanView(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_VIEW;
  return Math.min(MAX_VIEW, Math.max(MIN_VIEW, n));
}

module.exports = {
  Lobby, TICK_HZ, DT, send, rawSend, NO_LOGO, CELL, GRID_W, META_INTERVAL_MS,
  DEFAULT_VIEW, MIN_VIEW, MAX_VIEW, IDLE_MS, LEAVE_MIN_SECONDS, cleanView,
};
