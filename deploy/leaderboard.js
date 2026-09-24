/* =============================================================================
 * THE GLOBAL LEADERBOARD, CLIENT SIDE
 *
 * Two fetches, two tables, no framework and no state. The page is a record of
 * what happened, so it renders once and stops; there is no polling loop, no
 * websocket and nothing that keeps a phone awake reading a table.
 *
 * 🔴 EVERY STRING FROM THE SERVER IS WRITTEN WITH textContent. A company name
 * is whatever a player typed into the login card, and it reaches this page
 * having crossed a database. The server strips control characters and caps the
 * length; this file never builds markup from it, which is the half that cannot
 * be got wrong later.
 *
 * 🔴 The valuation format is rules.valuationText, restated here because this
 * page has no server code in it. $1B a dot, two tiers, $1.00T past $999B. If
 * that ever changes in server/rules.js it changes here too, and smoke.js pins
 * the pair the same way it pins the client's mirror in overlay.gd.
 * ========================================================================== */
(function () {
  'use strict';

  var PID_KEY = 'agaripo.pid';

  function myPid() {
    var v = '';
    try { v = localStorage.getItem(PID_KEY) || ''; } catch (e) { v = ''; }
    // The short player id, or the long UUID a browser was handed before it.
    return (/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(v)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) ? v : '';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The same two tiers server/rules.js uses. `b` already includes the $1B a
  // company floats at, because that is what the server stored.
  function money(b) {
    var n = Number(b) || 0;
    if (n < 1000) return '$' + n + 'B';
    return '$' + (n / 1000).toFixed(2) + 'T';
  }

  function plural(n, one, many) {
    return n === 1 ? ('1 ' + one) : (n + ' ' + many);
  }

  // Relative for the first day, then an absolute date. "3 days ago" stops being
  // useful at about the point somebody has to count backwards to use it.
  function when(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    var d = new Date(t);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function markSrc(logo) {
    var n = Number(logo);
    if (!Number.isInteger(n) || n < 0) return 'brand/agaripo-default.png';
    // The same three-digit basenames the picker grid loads, and the same
    // numbering the .pck uses: index IS the filename in this project.
    return 'logos/' + ('00' + n).slice(-3) + '.png';
  }

  // The player cell: the mark of the company they played as, the player's name
  // with its tag, and the company under it. The tag is always shown, because a
  // player name is not unique and the tag is what tells two of them apart; it
  // is a hash of the player id, never the id itself. A row from before player
  // names existed has none, so the company name stands in for it.
  function who(row) {
    var td = el('td', 'c-name');
    var wrap = el('div', 'lb-co');
    var img = el('img');
    img.src = markSrc(row.logo);
    img.alt = '';
    img.loading = 'lazy';
    img.width = 24; img.height = 24;
    // A mark that 404s leaves a broken-image glyph in the middle of a table.
    img.onerror = function () { img.onerror = null; img.src = 'brand/agaripo-default.png'; };
    wrap.appendChild(img);
    var text = el('div', 'lb-who');
    var line = el('div', 'lb-line');
    line.appendChild(el('b', null, row.player || row.name || 'Newco'));
    if (row.tag) line.appendChild(el('span', 'lb-tag', '#' + row.tag));
    text.appendChild(line);
    if (row.player) text.appendChild(el('span', 'lb-as', 'as ' + (row.name || 'Newco')));
    wrap.appendChild(text);
    td.appendChild(wrap);
    return td;
  }

  // Minutes and seconds on the board. A round that reached the bell is the full
  // ten minutes; anything shorter is a player who left before it.
  function played(secs) {
    var n = Math.max(0, Number(secs) || 0);
    var m = Math.floor(n / 60), r = n % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function cell(cls, text) { return el('td', cls, text); }

  function fill(tableId, cols, rows, build, emptyText) {
    var body = document.querySelector('#' + tableId + ' tbody');
    body.textContent = '';
    if (!rows.length) {
      var tr = el('tr', 'lb-empty');
      var td = cell(null, emptyText);
      td.colSpan = cols;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (var i = 0; i < rows.length; i++) body.appendChild(build(rows[i], i));
  }

  function get(path) {
    var opts = { headers: {}, cache: 'no-store' };
    var pid = myPid();
    // 🔴 A HEADER, never a query string. This is the only thing that identifies
    // the browser, and a query string would put it in the server's access log
    // and in the Referer of the prestocks.com link in the footer.
    if (pid) opts.headers['x-agaripo-pid'] = pid;
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function failed(tableId, cols, why) {
    fill(tableId, cols, [], null, why);
  }

  var NOTHING_YET = 'No rounds recorded yet. Play one and you are the board.';

  get('/api/leaderboard?limit=100').then(function (d) {
    if (!d || !d.ok) { failed('lb-top', 6, 'The leaderboard is not available right now.'); return; }

    var t = d.totals || {};
    var tot = document.getElementById('lb-totals');
    [['Rounds played', String(t.rounds || 0)],
     ['Players', String(t.players || 0)],
     ['Biggest company', t.best ? money(t.best) : '—']
    ].forEach(function (pair) {
      var box = el('div');
      box.appendChild(el('dt', null, pair[0]));
      box.appendChild(el('dd', null, pair[1]));
      tot.appendChild(box);
    });

    fill('lb-top', 6, d.players, function (row, i) {
      var tr = el('tr', row.you ? 'me' : null);
      tr.appendChild(cell('c-rank', String(i + 1)));
      tr.appendChild(who(row));
      tr.appendChild(cell('c-num lb-big', money(row.peak)));
      tr.appendChild(cell('c-num c-drop', row.took ? String(row.took) : '—'));
      tr.appendChild(cell('c-num c-drop lb-dim', String(row.plays)));
      tr.appendChild(cell('c-when c-drop lb-dim', when(row.at)));
      return tr;
    }, NOTHING_YET);
  }).catch(function () { failed('lb-top', 6, 'The leaderboard is not available right now.'); });

  get('/api/rounds?limit=200').then(function (d) {
    if (!d || !d.ok) { failed('lb-all', 7, 'The history is not available right now.'); return; }
    var n = d.rounds.length;
    document.getElementById('lb-all-count').textContent =
      n ? ('Showing the last ' + plural(n, 'round', 'rounds') + '.') : '';
    fill('lb-all', 7, d.rounds, function (row) {
      var tr = el('tr', row.you ? 'me' : null);
      tr.appendChild(who(row));
      tr.appendChild(cell('c-num lb-big', money(row.peak)));
      // 0 means they were holding a death card when the bell rang. "Acquired"
      // says that plainly; "$0B" would read as a company worth nothing rather
      // than as no company at all. The rank is missing for that round, and for
      // a round the player left before the bell: a rank is where you finished.
      tr.appendChild(cell('c-num' + (row.final ? '' : ' lb-dim'),
        row.final ? money(row.final) : 'Acquired'));
      tr.appendChild(cell('c-num c-drop lb-dim',
        row.rank ? (row.rank + ' of ' + row.field) : '—'));
      tr.appendChild(cell('c-num c-drop lb-dim', row.took ? String(row.took) : '—'));
      tr.appendChild(cell('c-num c-drop lb-dim', played(row.secs)));
      tr.appendChild(cell('c-when lb-dim', when(row.at)));
      return tr;
    }, NOTHING_YET);
  }).catch(function () { failed('lb-all', 7, 'The history is not available right now.'); });
}());
