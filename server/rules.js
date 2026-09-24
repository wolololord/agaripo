'use strict';
// The rules of AgarIPO, in one place.
//
// This is a 1:1 port of what used to be Scripts/blob_common.gd. The numbers were
// tuned over a long back-and-forth and every one of them is load-bearing, so the
// port keeps the original names and the original comments.
//
// The server is the only thing that runs these. The game client draws what it is
// told and owns no rule at all, which is what stops the "the player and the rivals
// disagreed about who was bigger" class of bug from ever coming back.

// --- Size ---------------------------------------------------------------------
// Past this many raises, capital barely moves the needle. This is the number the
// valuation on the blob is drawn from.
const CELL_FOOD_LIMIT = 50;
// 1% of the normal per-dot gain once past CELL_FOOD_LIMIT.
const POST_LIMIT_RATE = 0.01;
// Area added per dot. 0.1025 makes the first bite identical to the original flat
// `scale += 0.05`, and growth decelerates by itself from there.
const AREA_PER_CELL = 0.1025;
// Hard backstop on the scale multiplier so nothing can fill the screen.
const MAX_SCALE = 20.0;
// A blob's radius in world units. 25 at scale 1, matching the original body shape.
const BLOB_RADIUS = 25.0;

// --- World --------------------------------------------------------------------
// 🔴 6500, down from 10000, and it is arithmetic rather than taste. Culling the
// board from 119 companies to 50 on the same square left every company with 2.4
// times as much empty board to itself, and smoke.js caught it immediately: ZERO
// takeovers in four seconds on a board that used to produce them constantly. A
// game about acquiring your rivals where the rivals never meet is not a game.
//
// The size is chosen to hold company density EXACTLY where it was:
//   119 / 10000^2 = 1.190e-6 per square unit
//    50 /  6500^2 = 1.183e-6 per square unit
// A smaller square is also cheaper: the capital grid goes from 1600 cells to
// 676, and nothing on Railway is free.
const WORLD = 6500;
// 🔴 1300 over 6500^2 is 3.08e-5 dots per square unit, and THAT is the number
// grownByDot was tuned against. Growth is set by dot DENSITY, because a blob
// sweeps an area per second and eats whatever is in it; dots per COMPANY is a
// figure that feels like it should matter and does not. Every past change to
// this constant has been a change to that density held or restored, so read the
// density, not the count. History is in git.
const DOT_COUNT = 1300;
const DOT_RADIUS = 10;
// The board is 50 pre-IPO companies, every one on it exactly once.
//
// 🔴 Culled from 119 on 2026-09-19, and the cull is the feature. 119 balls meant
// most of them were names nobody could place, so meeting one taught a player
// nothing and the board read as noise. tools/cull-companies.py keeps the 49 a
// normal person or a crypto-native recognises and puts PreStocks at index 0, so
// it is the first tile in the picker. All eight companies PreStocks tokenises
// are still on the board; the script refuses to run if one of them is missing.
//
// 🔴 This replaced FIELD_SIZE = 200 with invented names (Northwind, Kestrel...).
// The brief: the point is to meet the real pre-IPO companies and their
// valuations. A made-up name on a real logo misses the same point, so the
// name and the mark now come out of ONE row of companies.json and cannot drift.
//
// 200 was also self-defeating at 119 companies: it would have put "OpenAI 2" on
// the board. world.js refills whichever company is currently missing instead, so
// the field is the whole list at every moment of the round.
const COMPANIES = require('./companies.json');
const FIELD_SIZE = COMPANIES.length;
// Overridable only so the reset can be tested in seconds instead of in minutes.
// Nothing sets it in production; the round is ten minutes.
//
// 🔴 Five was too short FOR THIS BOARD and that is arithmetic, not taste. A
// player starts at $1B and the only fast way up is taking a rival, which needs
// acquireGap. Measured live on the 300 s round, back when the board was 119
// companies: rank 101-110 of 120 at the bell. Ten minutes is the same climb with
// room to finish it, and it is still short enough that a judge with one browser
// tab sees a whole round.
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 600);

// The closing bell. At the bell the market FREEZES on its final positions, the
// table of record goes out once, and the world reopens this many seconds later.
// It is deliberately the only part of a round nobody can play: a round that ends
// by silently teleporting everybody back to $1M has no result, and a game with no
// result has nothing to screenshot.
const CLOSING_SECONDS = Number(process.env.CLOSING_SECONDS || 10);

// How many rows the closing table carries. Ten is what a phone shows without
// scrolling, and the player's own row is sent separately so finishing 74th still
// puts you on the card.
const TABLE_ROWS = 10;

// --- Movement -----------------------------------------------------------------
// Big companies are slower. Without this a blob that has eaten half the map also
// outruns everything on it, and there is no game left.
const BASE_SPEED = 265;
const MIN_SPEED = 95;
const BOOST_FACTOR = 1.7;

// Sprint costs money, not stamina.
//
// 🔴 The stamina bar was deleted, and it deserved to be. It was a 100-point pool
// draining at 45/s and refilling at 14/s, and NOTHING on screen ever drew it, so
// holding the button gave 2.2 seconds of 1.7x speed with no feedback at all and
// read as "sprint is broken". Worse, the HUD already said "burn cash and sprint"
// while nothing burned.
//
// Burning a PERCENTAGE is what makes this un-abusable. A flat cost is trivial for
// a $2T company and ruinous for a $5B one; 0.5% of the pile every 2 seconds costs
// the leader $10B a tick and the newcomer nothing worth counting, so sprinting
// away from a takeover is always available and sprinting everywhere never pays.
const BOOST_BURN_INTERVAL = 2.0;   // seconds between charges
const BOOST_BURN_RATE = 0.005;     // 0.5% of the whole valuation, per charge

function speedFor(scale) {
  return Math.max(MIN_SPEED, BASE_SPEED * Math.pow(scale, -0.35));
}

// 🔴 The disc has to shrink with the valuation or they disagree, and "the number
// and the body disagreed" is the exact bug class this project has already hit
// twice. Scale is NOT a function of count (a takeover adds the other company's
// area), so the burn cannot recompute it — it removes the same FRACTION of area
// that was removed from the valuation. Floors at 1.0: nobody shrinks below a
// freshly founded company.
function shrunkByBurn(scale, lostFraction) {
  if (!(lostFraction > 0)) return scale;
  return Math.max(1.0, Math.sqrt(scale * scale * (1 - Math.min(1, lostFraction))));
}

// --- Valuation ----------------------------------------------------------------
// Every company floats at $1B, and each dot of capital is worth another $1B.
// Acquiring a rival adds their whole valuation. Past $1,000B it reads in
// trillions to two decimals, so 1000 -> $1.00T, 1010 -> $1.01T, 2150 -> $2.15T.
//
// 🔴 Millions became billions on 2026-09-19 and it is a UNIT CHANGE, not a
// rescale: every number in the simulation is untouched and only the suffix on
// the label moved. A real pre-IPO board is priced in billions, so a game that
// put SpaceX on screen at $47M was quietly telling the player it was not about
// them. There is no third tier above trillions: a leader would need a million
// dots of capital to reach one, and $1,240.00T still reads correctly if the
// impossible ever happens.
const BASE_VALUATION_B = 1;

// `count` is a float on the server since sprinting burns fractions of it, and an
// integer everywhere a human can see it. Rounding here rather than at each call
// site is what stops "$12.4B" appearing on one screen and "$12B" on another.
function valuationText(count) {
  const b = BASE_VALUATION_B + Math.round(count);
  if (b < 1000) return `$${b}B`;
  return `$${(b / 1000).toFixed(2)}T`;
}

// --- Acquisition ---------------------------------------------------------------
// One rule, stated the way a player reads it: you acquire anyone worth at least
// 5% less than you, and never less than $5B less.
//
// 🔴 A PERCENTAGE, not the flat $5B it used to be, and the flat gap survives
// only as a floor. A fixed gap is two different rules at two different sizes: at
// $8B it is a real fight, and at $900B it means a leader swallows anything it
// touches, because everything on the board is more than $5B behind it. 5% scales
// with the acquirer, so at $500B a rival has to be $25B behind to be takeable
// and two giants can circle each other instead of the first one to make contact
// winning.
//
// 🔴 The floor is what stops the percentage collapsing at the bottom. 5% of a
// freshly floated $1B company is $0.05B, and capital arrives in whole $1B dots,
// so without it a company one dot ahead could take a company one dot behind and
// the first thirty seconds would be pure coin flip. max() of the two is one rule
// that is the right rule at both ends.
//
// Crossover is $100B: below it the $5B floor binds, above it the 5% does.
const ACQUIRE_MIN_GAP = 5;
const ACQUIRE_MIN_FRACTION = 0.05;

function acquireGap(mine) {
  return Math.max(ACQUIRE_MIN_GAP, (BASE_VALUATION_B + mine) * ACQUIRE_MIN_FRACTION);
}

function canAcquire(mine, theirs) {
  return (mine - theirs) >= acquireGap(mine);
}

// --- Growth --------------------------------------------------------------------
// Area is what adds, not scale. The eat radius is BLOB_RADIUS * scale, so the area
// swept grows as scale SQUARED. A flat `scale += 0.05` therefore made d(scale)/dt
// proportional to scale squared, which blows up in finite time and ate the map.
function grownByDot(current, count) {
  const rate = count <= CELL_FOOD_LIMIT ? 1.0 : POST_LIMIT_RATE;
  return Math.min(Math.sqrt(current * current + AREA_PER_CELL * rate), MAX_SCALE);
}

// Acquiring a rival. Areas add, so a takeover is worth far more than a dot and is
// the only real way up once CELL_FOOD_LIMIT raises are in.
function grownByAcquisition(current, other) {
  return Math.min(Math.sqrt(current * current + other * other), MAX_SCALE);
}

module.exports = {
  CELL_FOOD_LIMIT, POST_LIMIT_RATE, AREA_PER_CELL, MAX_SCALE, BLOB_RADIUS,
  WORLD, DOT_COUNT, DOT_RADIUS, COMPANIES, FIELD_SIZE, ROUND_SECONDS,
  CLOSING_SECONDS, TABLE_ROWS,
  BASE_SPEED, MIN_SPEED, BOOST_FACTOR, BOOST_BURN_INTERVAL, BOOST_BURN_RATE, speedFor,
  BASE_VALUATION_B, valuationText,
  ACQUIRE_MIN_GAP, ACQUIRE_MIN_FRACTION, acquireGap, canAcquire,
  grownByDot, grownByAcquisition, shrunkByBurn,
};
