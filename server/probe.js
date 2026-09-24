'use strict';
// Diagnostic: sit in a market and report what the wire actually carries.
//   node probe.js [base] [seconds]
// Prints the snapshot stride, the company count, and the leader's valuation over
// time. Used to measure the economy rather than argue about it.

const WebSocket = require('ws');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const SECS = Number(process.argv[3] || 90);

const sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
let meta = [];
let t0 = 0;

sock.on('open', () => {
  sock.send(JSON.stringify({ t: 'join', name: 'Probe' }));
  // 🔴 Ask for the WHOLE board. Snapshots are culled to each client's own view
  // now, and the default view is 1600 units of a 6500 unit board: without this
  // the probe would report ~4 companies and call it the economy.
  setInterval(() => sock.send(JSON.stringify({ t: 'in', dx: 0, dy: 0, b: false, v: 999999 })), 500);
});
sock.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'welcome') { t0 = Date.now(); }
  if (m.t === 'm') { meta = m.blobs; }
  if (m.t !== 's') return;
  const el = Math.round((Date.now() - t0) / 1000);
  if (el % 10 !== 0 || Date.now() % 1000 > 60) return;
  const b = m.b;
  const rows = [];
  for (let i = 0; i + 5 < b.length; i += 6) {
    // Int 6 is a bitmask: bit 0 spawn-protected, bit 1 sprinting.
    rows.push({ id: b[i], count: b[i + 4], safe: (b[i + 5] & 1) !== 0, boost: (b[i + 5] & 2) !== 0 });
  }
  rows.sort((p, q) => q.count - p.count);
  const total = rows.reduce((a, r) => a + r.count, 0);
  const nameOf = (id) => (meta.find((x) => x.i === id) || {}).n || '?';
  console.log(
    `t=${String(el).padStart(3)}s  ints=${b.length}  stride6=${b.length % 6 === 0}  `
    + `companies=${rows.length}  meta=${meta.length}  rank=${m.r}/${m.f}  `
    + `sprinting=${rows.filter((r) => r.boost).length}  total=$${total}B  `
    + `top3=${rows.slice(0, 3).map((r) => `${nameOf(r.id)} $${r.count + 1}B`).join(', ')}`
  );
});

setTimeout(() => { sock.close(); process.exit(0); }, SECS * 1000 + 2000);
