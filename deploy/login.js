/*
 * AgarIPO: the login card and the pre-IPO company logo picker, injected into the
 * web build.
 *
 * TWO WAYS TO GET A LOGO, AND ONLY ONE OF THEM PUTS BYTES ON THE WIRE.
 *
 * 1. PICK A PRE-IPO COMPANY. logos.js carries 50: PreStocks, whose mark is their
 *    own apple-icon.png, and 49 scraped once from forgeglobal.com and culled from
 *    119 to the ones people have heard of. Picking one sends its INDEX,
 *    a single small integer. The game already owns the same pack inside its own
 *    index.pck, so nothing is encoded, nothing is uploaded, and the mark on the
 *    ball is the 256 px original rather than a re-encode of a re-encode.
 *    🔴 This replaced 86 simple-icons SVG paths rasterised through Path2D. They
 *    were the wrong companies (simple-icons matched 24 of these 119; it carries
 *    household brands, and these are pre-IPO startups) and the round trip through
 *    a 128 px canvas is exactly what made the mark blurry on a big ball.
 *
 * 2. UPLOAD YOUR OWN. This is the only path that sends an image, and it is
 *    re-encoded first: a 256x256 canvas, clipped to a circle, through
 *    toDataURL('image/png'). Only those freshly generated pixels leave the
 *    browser, so EXIF, colour profiles, appended trailing data and any polyglot
 *    payload are dropped on the floor. Validation, all of which must pass, IN
 *    THIS ORDER:
 *      1. size not zero and <= MAX_BYTES
 *      2. filename extension is .png / .jpg / .jpeg
 *      3. MAGIC BYTES are a PNG or a JPEG. This is the check that matters: the
 *         extension comes from the filename, so a renamed .exe passes 2 and is
 *         caught only here.
 *      4. if the browser reported a MIME type at all, it agrees with the magic.
 *         🔴 ADVISORY, not a gate. `File.type` is read from the Windows registry
 *         association for the extension, so on a machine where another
 *         application has claimed .png it comes back "". The old code rejected a
 *         genuine PNG before reading a byte of it.
 *      5. declared dimensions, parsed straight out of the header, are within
 *         MIN_DIM..MAX_DIM. This runs BEFORE any decode. A 4 MB PNG of flat
 *         colour can declare 40000x40000, which is 6.4 GB of RGBA and kills the
 *         tab inside createImageBitmap, so a post-decode check never gets to run.
 *      6. createImageBitmap() decodes it, so it is a real, parseable image
 */
(function () {
  'use strict';

  var MAX_BYTES = 4 * 1024 * 1024;
  var MIN_DIM = 16;
  var MAX_DIM = 8192;
  // 🔴 256 now, not 128, and that is the fix for "the logo goes blurry when the
  // ball grows". A company at MAX_SCALE wears a 468 px mark, so 128 was a 3.7x
  // magnification. The ladder exists because this one crosses the wire: the
  // server refuses a skin over 96 KB, so if a noisy photo does not fit at 256 it
  // is re-encoded smaller rather than silently dropped by the server.
  var SKIN_SIZES = [256, 192, 128];
  var WIRE_LIMIT = 92 * 1024;
  // Enough to reach a JPEG start-of-frame past a real photo's EXIF and ICC blocks.
  var HEAD_BYTES = 256 * 1024;

  var PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  var JPEG_MAGIC = [0xFF, 0xD8, 0xFF];

  // Exactly one of these is ever set. skinDataUrl is an upload; pickedLogo is an
  // index into the company pack. -1 and null together mean a plain disc.
  var skinDataUrl = null;
  var pickedLogo = -1;
  var companies = (window.AGARIPO_LOGOS || []);

  /* ==========================================================================
   * WHO THIS PLAYER IS
   *
   * A player id is a short code, K7QM-3XPD-9RWT, minted here the first time a
   * browser opens the game and kept in localStorage. It is the player's whole
   * identity: every round they play is filed under it, and typing it into
   * another browser logs them in there. An email and a password are optional,
   * and only ever a second way to get the same code back.
   *
   * 🔴 IT IS A LOGIN KEY, SO IT IS NEVER PUBLISHED. The card shows it to the
   * one person it belongs to. The server receives it in a request body or a
   * header, never in a URL, and the leaderboard shows a 4-character tag hashed
   * from it instead.
   *
   * 🔴 THE SCORE DOES NOT TRAVEL WITH IT AND NEVER WILL. The valuation, the rank
   * and the acquisitions are all computed by the server from its own
   * simulation. A public leaderboard is only worth having because there is no
   * number here for anyone to edit.
   * ======================================================================== */

  var PID_KEY = 'agaripo.pid';
  var PLAYER_KEY = 'agaripo.player';
  // Crockford's base32: no I, L, O or U, so a code written on paper types back
  // in correctly. Twelve characters is 60 bits.
  var CODE_ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
  // The long form browsers were handed before the short one existed. Still a
  // valid id, and moved to a short code the next time the card loads.
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // This player, as the card and the closing card know them. `email` only ever
  // arrives masked, and only for the owner of `pid`. `named` is true once the
  // server has confirmed it filed `name` against `pid`.
  var me = { pid: '', name: '', tag: '', email: '', named: false };

  function load(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  // A browser in private mode, or one with site data blocked, throws on write.
  // That player still plays; their id just does not outlive the tab.
  function save(key, v) {
    try {
      if (v) { localStorage.setItem(key, v); } else { localStorage.removeItem(key); }
    } catch (e) { /* not stored */ }
  }

  function newCode() {
    var b = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(b); }
    else { for (var i = 0; i < 12; i++) { b[i] = (Math.random() * 256) | 0; } }
    var s = '';
    // 256 is a multiple of 32, so the low five bits of a random byte are uniform.
    for (var j = 0; j < 12; j++) { s += CODE_ALPHA.charAt(b[j] & 31); }
    return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
  }

  function playerId() {
    var v = load(PID_KEY);
    if (CODE_RE.test(v) || UUID_RE.test(v)) { return v; }
    v = newCode();
    save(PID_KEY, v);
    return v;
  }

  // The server strips control and direction characters as well; this only
  // keeps what the card measures in step with what will be stored.
  function cleanName(v) {
    return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  }

  // The name a player gets when they leave the box empty, so Go public never
  // answers with an error. Random digits, never anything taken from the player
  // id: the id is a login key and the name is printed on a public page.
  function defaultName() {
    var b = new Uint16Array(1);
    if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(b); }
    else { b[0] = (Math.random() * 65536) | 0; }
    return 'Founder ' + (1000 + (b[0] % 9000));
  }

  // Every call to the account routes. Always resolves, with { ok, status, ...}:
  // a failure is a sentence on the card, never an exception.
  function api(path, body) {
    return fetch(path, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d = d || {};
        d.status = r.status;
        if (!r.ok && !d.reason) { d.reason = 'Something went wrong. Try again.'; }
        if (!r.ok) { d.ok = false; }
        return d;
      });
    }).catch(function () {
      return { ok: false, status: 0, reason: 'Could not reach the server. Try again.' };
    });
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) { for (var k in attrs) { n.setAttribute(k, attrs[k]); } }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function logoUrl(company) { return 'logos/' + company.f + '.png'; }

  function matches(bytes, magic) {
    if (bytes.length < magic.length) { return false; }
    for (var i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) { return false; }
    }
    return true;
  }

  function readBytes(file, n) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(new Error('Could not read that file.')); };
      r.readAsArrayBuffer(file.slice(0, n));
    });
  }

  function be32(b, off) {
    return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
  }

  // PNG declares width and height in the IHDR chunk at byte offsets 16..23.
  function pngDims(head) {
    if (head.length < 24) { return null; }
    return { w: be32(head, 16), h: be32(head, 20) };
  }

  // JPEG hides them in a start-of-frame marker, so walk the segment chain.
  // Returns null if the header slice ran out. 🔴 That case is REFUSED rather than
  // waved through. The whole reason dimensions are read from the header is that a
  // 4 MB file can declare 40000x40000, which is 6.4 GB of RGBA and kills the tab
  // inside createImageBitmap before any post-decode check can run. Letting the
  // JPEG path fall through on "unknown" made that defence PNG-only. HEAD_BYTES is
  // 256 KB so a real camera photo's EXIF and ICC blocks fit in front of the SOF;
  // a JPEG that still hides its size past that is pathological.
  function jpegDims(buf) {
    var i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      var marker = buf[i + 1];
      // 0xFF is also legal padding before a marker, so skip a run of them.
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      var len = (buf[i + 2] << 8) | buf[i + 3];
      // Every SOFn except the four that are not frame headers.
      var isSof = (marker >= 0xC0 && marker <= 0xCF)
        && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) {
        return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
      }
      if (len <= 0) { return null; }
      i += 2 + len;
    }
    return null;
  }

  function roundCanvas(px) {
    var cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    // Clipped round HERE, so the game draws an already-circular PNG. That is why
    // there is no mask shader and no per-blob material on the engine side.
    ctx.beginPath();
    ctx.arc(px / 2, px / 2, px / 2 - 1, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    return { cv: cv, ctx: ctx };
  }

  // The single exit for anything that becomes a PNG. Encodes at the largest size
  // that still fits the server's skin cap, so nobody has to guess whether a photo
  // will make it through.
  function encodeRound(draw) {
    var out = { url: '', px: 0 };
    for (var i = 0; i < SKIN_SIZES.length; i++) {
      var px = SKIN_SIZES[i];
      var r = roundCanvas(px);
      draw(r.ctx, px);
      out = { url: r.cv.toDataURL('image/png'), px: px };
      if (out.url.length <= WIRE_LIMIT) { return out; }
    }
    return out;
  }

  function validateAndReencode(file) {
    if (file.size === 0) { return Promise.reject(new Error('That file is empty.')); }
    if (file.size > MAX_BYTES) {
      return Promise.reject(new Error('Too big. Max 4 MB, that one is '
        + (file.size / 1048576).toFixed(1) + ' MB.'));
    }
    if (!/\.(png|jpe?g)$/.test((file.name || '').toLowerCase())) {
      return Promise.reject(new Error('Only .png, .jpg and .jpeg files are accepted.'));
    }
    var mime = (file.type || '').toLowerCase();

    return readBytes(file, HEAD_BYTES).then(function (head) {
      var isPng = matches(head, PNG_MAGIC);
      var isJpeg = matches(head, JPEG_MAGIC);
      // The bytes decide. Always.
      if (!isPng && !isJpeg) {
        throw new Error('That file is not a PNG or a JPEG inside, whatever it is named.');
      }
      // The MIME only gets a vote when the browser actually cast one.
      if (mime === 'image/png' && !isPng) {
        throw new Error('Named .png but the contents are not a PNG. Rejected.');
      }
      if (mime === 'image/jpeg' && !isJpeg) {
        throw new Error('Named .jpg but the contents are not a JPEG. Rejected.');
      }

      var dims = isPng ? pngDims(head) : jpegDims(head);
      if (dims === null) {
        throw new Error('Could not read the size out of that image. Re-save it as a '
          + 'plain PNG or JPEG and try again.');
      }
      if (dims.w > MAX_DIM || dims.h > MAX_DIM) {
        throw new Error('Declared size ' + dims.w + 'x' + dims.h + ' is too large. Max '
          + MAX_DIM + ' either side.');
      }
      if (dims.w < MIN_DIM || dims.h < MIN_DIM) {
        throw new Error('Too small: ' + dims.w + 'x' + dims.h + '. Min ' + MIN_DIM + ' either side.');
      }

      if (typeof createImageBitmap !== 'function') {
        throw new Error('This browser cannot decode images here. Try Chrome, Edge or Firefox.');
      }
      return createImageBitmap(file);
    }).then(function (bmp) {
      if (bmp.width > MAX_DIM || bmp.height > MAX_DIM
          || bmp.width < MIN_DIM || bmp.height < MIN_DIM) {
        bmp.close();
        throw new Error('Decoded size ' + bmp.width + 'x' + bmp.height + ' is out of range.');
      }
      var side = Math.min(bmp.width, bmp.height);
      var res = encodeRound(function (ctx, px) {
        ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side,
                      0, 0, px, px);
      });
      bmp.close();
      if (res.url.length > WIRE_LIMIT) {
        throw new Error('That image will not compress small enough to send. Try a '
          + 'simpler logo, or pick a company above.');
      }
      return { url: res.url, px: res.px };
    });
  }

  function build() {
    var card = el('div', { id: 'ipo-card' });

    var head = el('header', { id: 'ipo-head' });
    // The wordmark, as real text rather than an image: it stays sharp at any
    // zoom, it is readable by a screen reader, and it needs no extra request.
    // 🔴 THE O IS HIDDEN AND REPLACED, not labelled. The final O is a drawn mark
    // now, so the text stream would say "AgarIP" on its own. The obvious fix is
    // role="img" + aria-label on the h1, and it is wrong twice over: `img` is not
    // an allowed role on a heading, and it removes the page's only h1 from the
    // accessibility tree, so the document outline starts at h2. This keeps the
    // heading a heading, puts the O back in the text stream for a screen reader
    // AND for the clipboard, and hides the decorative span from both.
    var mark = el('h1', { id: 'ipo-wordmark' });
    mark.appendChild(el('span', { class: 'wm-a' }, 'Agar'));
    mark.appendChild(el('span', { class: 'wm-b' }, 'IP'));
    mark.appendChild(el('span', { class: 'wm-o', 'aria-hidden': 'true' }));
    mark.appendChild(el('span', { class: 'wm-sr' }, 'O'));
    head.appendChild(mark);
    // The goal, and only the goal. The three verbs that used to be here are the
    // rules, and the rules are listed under the button; saying them twice made
    // the first thing on the card a paragraph rather than a reason to play.
    head.appendChild(el('p', { class: 'sub' }, 'Become the biggest unicorn!'));
    card.appendChild(head);

    // --- 1. you ---------------------------------------------------------------
    // 🔴 THE PLAYER, NOT THE COMPANY. The company is who you play AS, and it is
    // what is written on your ball. This is who you ARE on the global
    // leaderboard, and it stays the same whichever company you pick.
    me.pid = playerId();
    var s0 = section(card, '1', 'You');
    var playerInput = el('input', {
      id: 'ipo-player', class: 'ipo-input', type: 'text', maxlength: '16',
      placeholder: 'Your player name', autocomplete: 'nickname', spellcheck: 'false',
      'aria-label': 'Player name'
    });
    playerInput.value = load(PLAYER_KEY);
    var playerTyped = false;
    playerInput.addEventListener('input', function () { playerTyped = true; });
    s0.appendChild(playerInput);
    var playerMsg = el('div', { id: 'ipo-player-msg', role: 'status' });
    s0.appendChild(playerMsg);

    var idRow = el('div', { id: 'ipo-idrow' });
    idRow.appendChild(el('span', { class: 'ipo-id-label' }, 'Player ID'));
    // 🔴 HIDDEN UNTIL ASKED FOR. The id logs in on any device, and this card is
    // the first thing on screen: a stream or a screenshot of it would hand the
    // account to whoever was watching. Copy works without showing it.
    var idCode = el('code', { id: 'ipo-id' });
    idRow.appendChild(idCode);
    var showBtn = el('button', { type: 'button', class: 'ipo-link', id: 'ipo-id-show',
      'aria-pressed': 'false' }, 'Show');
    idRow.appendChild(showBtn);
    var copyBtn = el('button', { type: 'button', class: 'ipo-link', id: 'ipo-id-copy' }, 'Copy');
    idRow.appendChild(copyBtn);
    // The account links share the id's line: the card must still show Go
    // public on a 900 px laptop screen, and a line of its own cost that.
    var acctRow = el('span', { id: 'ipo-acct-row' });
    idRow.appendChild(acctRow);
    s0.appendChild(idRow);
    var fine = el('p', { class: 'ipo-fine' },
      'Save your ID. It logs you in on any device, so keep it to yourself. ');
    var newIdBtn = el('button', { type: 'button', class: 'ipo-link', id: 'ipo-id-new' },
      'Get a new ID');
    fine.appendChild(newIdBtn);
    s0.appendChild(fine);

    // The account panel: closed until asked for. Three small forms, because a
    // player id and an email are two different ways in, and a password manager
    // only recognises a form with a username and a password in it.
    var acct = el('div', { id: 'ipo-acct', hidden: 'hidden' });
    var inView = el('div', { class: 'ipo-acct-view' });
    inView.appendChild(el('h3', null, 'Log in'));
    var idForm = el('form', { class: 'ipo-form', novalidate: 'novalidate' });
    idForm.appendChild(el('label', { class: 'ipo-lbl', for: 'ipo-in-id' }, 'With your player ID'));
    var inId = el('input', { id: 'ipo-in-id', class: 'ipo-input', type: 'text', maxlength: '40',
      placeholder: 'K7QM-3XPD-9RWT', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'characters' });
    var idGo = el('button', { type: 'submit', class: 'ipo-btn2' }, 'Log in');
    idForm.appendChild(pair(inId, idGo));
    inView.appendChild(idForm);
    var mailForm = el('form', { class: 'ipo-form', novalidate: 'novalidate' });
    mailForm.appendChild(el('label', { class: 'ipo-lbl', for: 'ipo-in-email' }, 'Or with your email'));
    var inEmail = el('input', { id: 'ipo-in-email', class: 'ipo-input', type: 'email',
      maxlength: '254', placeholder: 'Email', autocomplete: 'username' });
    var inPass = el('input', { id: 'ipo-in-pass', class: 'ipo-input', type: 'password',
      maxlength: '128', placeholder: 'Password', autocomplete: 'current-password',
      'aria-label': 'Password' });
    var mailGo = el('button', { type: 'submit', class: 'ipo-btn2' }, 'Log in');
    mailForm.appendChild(inEmail);
    mailForm.appendChild(pair(inPass, mailGo));
    inView.appendChild(mailForm);
    inView.appendChild(el('p', { class: 'ipo-fine' },
      'Logging in swaps the player ID saved in this browser for yours.'));

    var upView = el('div', { class: 'ipo-acct-view' });
    upView.appendChild(el('h3', null, 'Create an account'));
    upView.appendChild(el('p', { class: 'ipo-fine ipo-fine-top' },
      'Puts an email and a password on your player ID, so you can log in anywhere without it.'));
    var upForm = el('form', { class: 'ipo-form', novalidate: 'novalidate' });
    var upEmail = el('input', { id: 'ipo-up-email', class: 'ipo-input', type: 'email',
      maxlength: '254', placeholder: 'Email', autocomplete: 'email', 'aria-label': 'Email' });
    var upPass = el('input', { id: 'ipo-up-pass', class: 'ipo-input', type: 'password',
      maxlength: '128', placeholder: 'Password, 8 or more characters',
      autocomplete: 'new-password', 'aria-label': 'Password' });
    var upGo = el('button', { type: 'submit', class: 'ipo-btn2' }, 'Create');
    upForm.appendChild(upEmail);
    upForm.appendChild(pair(upPass, upGo));
    upView.appendChild(upForm);
    upView.appendChild(el('p', { class: 'ipo-fine' },
      'Your email is only used to log you in. Nothing is ever sent to it, so there '
      + 'is no password reset: if you forget the password, log in with your player ID.'));

    var acctMsg = el('p', { id: 'ipo-acct-msg', role: 'status' });
    var acctClose = el('button', { type: 'button', class: 'ipo-link', id: 'ipo-acct-close' }, 'Close');
    acct.appendChild(inView);
    acct.appendChild(upView);
    acct.appendChild(acctMsg);
    acct.appendChild(acctClose);
    s0.appendChild(acct);

    function pair(input, button) {
      var row = el('div', { class: 'ipo-inline' });
      row.appendChild(input);
      row.appendChild(button);
      return row;
    }

    function sayPlayer(text, kind) {
      playerMsg.textContent = text;
      playerMsg.className = kind || '';
    }

    function sayAcct(text, kind) {
      acctMsg.textContent = text || '';
      acctMsg.className = kind || '';
    }

    function linkButton(text, fn) {
      var b = el('button', { type: 'button', class: 'ipo-link' }, text);
      b.addEventListener('click', fn);
      return b;
    }

    var idShown = false;
    function paintId() {
      idCode.textContent = idShown ? me.pid : '••••-••••-••••';
      showBtn.textContent = idShown ? 'Hide' : 'Show';
      showBtn.setAttribute('aria-pressed', idShown ? 'true' : 'false');
    }
    showBtn.addEventListener('click', function () { idShown = !idShown; paintId(); });

    // The name this player goes public under: what they typed, or a default
    // written into the box so they can see it, and keep or change it next time.
    function playerName() {
      var n = cleanName(playerInput.value);
      if (n.length < 2) { n = defaultName(); playerInput.value = n; }
      return n;
    }

    function paintAcct() {
      acctRow.textContent = '';
      if (me.email) {
        acctRow.appendChild(document.createTextNode('Signed in as '));
        acctRow.appendChild(el('b', null, me.email));
        acctRow.appendChild(document.createTextNode('  ·  '));
        acctRow.appendChild(linkButton('Log out', logOut));
        return;
      }
      acctRow.appendChild(linkButton('Log in', function () { openAcct('in'); }));
      acctRow.appendChild(document.createTextNode('  ·  '));
      acctRow.appendChild(linkButton('Sign up', function () { openAcct('up'); }));
    }

    function openAcct(mode) {
      acct.hidden = false;
      inView.hidden = mode !== 'in';
      upView.hidden = mode !== 'up';
      sayAcct('', '');
      (mode === 'in' ? inId : upEmail).focus();
    }

    function closeAcct() { acct.hidden = true; sayAcct('', ''); }
    acctClose.addEventListener('click', closeAcct);

    // Whatever the server said about the player this browser now is.
    function adopt(d) {
      me.pid = d.pid;
      save(PID_KEY, d.pid);
      me.tag = d.tag || '';
      me.email = d.email || '';
      if (d.name) { playerInput.value = d.name; save(PLAYER_KEY, d.name); }
      paintId();
      paintAcct();
      closeAcct();
      sayPlayer(d.name ? 'Logged in as ' + d.name + '.' : 'Logged in.', 'ok');
    }

    function logOut() {
      me.pid = newCode();
      save(PID_KEY, me.pid);
      me.tag = '';
      me.email = '';
      playerInput.value = '';
      save(PLAYER_KEY, '');
      paintId();
      paintAcct();
      sayPlayer('Logged out. This browser has a new player ID.', '');
      playerInput.focus();
    }

    function refresh() {
      api('/api/player', { pid: me.pid }).then(function (d) {
        if (!d.ok) {
          if (d.status === 503) {
            acctRow.textContent = 'Accounts offline. You can still play.';
          }
          return;
        }
        me.tag = d.tag || '';
        if (d.found) {
          me.email = d.email || '';
          if (d.name && !playerTyped) { playerInput.value = d.name; save(PLAYER_KEY, d.name); }
        }
        paintAcct();
      });
    }

    // A browser still holding the long UUID gets a short code, and its rounds
    // move to it on the server. 🔴 COMPARE AND SET: two tabs of the same browser
    // can both get here, and whichever answer lands second adopts what the first
    // one already saved instead of writing its own code over it.
    // `moving` is the move while it is in flight. Go public waits for it, or the
    // round would be filed under the UUID after its rounds had already left it.
    var moving = null;
    function moveOffUuid() {
      var old = me.pid;
      moving = api('/api/player', { pid: newCode(), from: old }).then(function (d) {
        if (!d.ok) { refresh(); return; }
        var now = load(PID_KEY);
        if (now && now !== old) { me.pid = now; paintId(); refresh(); return; }
        me.pid = d.pid;
        save(PID_KEY, d.pid);
        me.tag = d.tag || '';
        if (d.found) {
          me.email = d.email || '';
          if (d.name && !playerTyped) { playerInput.value = d.name; save(PLAYER_KEY, d.name); }
        }
        paintId();
        paintAcct();
      }).then(function () { moving = null; }, function () { moving = null; });
    }

    // A leaked ID is replaced, not revoked: everything it holds moves to a fresh
    // one on the server, and the old one is left holding nothing. Two clicks,
    // because the second cannot be taken back, and an account's own password on
    // top, because a leaked ID is exactly what someone else would use to take
    // the account. The new ID stays hidden: a player swapping it because it was
    // on screen does not want the new one on screen either.
    var newIdArmed = 0;
    var swapPass = el('input', { id: 'ipo-swap-pass', class: 'ipo-input', type: 'password',
      maxlength: '128', placeholder: 'Your password', autocomplete: 'current-password',
      'aria-label': 'Password' });
    var swapGo = el('button', { type: 'submit', class: 'ipo-btn2' }, 'New ID');
    var swapForm = el('form', { id: 'ipo-swap', class: 'ipo-form', novalidate: 'novalidate',
      hidden: 'hidden' });
    swapForm.appendChild(pair(swapPass, swapGo));
    fine.parentNode.insertBefore(swapForm, fine.nextSibling);

    function disarmNewId() {
      clearTimeout(newIdArmed);
      newIdArmed = 0;
      swapForm.hidden = true;
      swapPass.value = '';
      newIdBtn.textContent = 'Get a new ID';
    }

    function swapId(password) {
      var old = me.pid;
      // Another tab may have logged in or swapped already. Its ID wins, and this
      // one is not swapped out from under it.
      var held = load(PID_KEY);
      if (held && held !== old) {
        me.pid = held;
        paintId();
        refresh();
        disarmNewId();
        sayPlayer('Your ID changed in another tab. Check it, then try again.', 'err');
        return;
      }
      var body = { pid: newCode(), from: old };
      if (password) { body.password = password; }
      newIdBtn.disabled = true;
      swapGo.disabled = true;
      api('/api/player', body).then(function (d) {
        newIdBtn.disabled = false;
        swapGo.disabled = false;
        if (!d.ok) {
          sayPlayer(d.reason, 'err');
          if (d.status !== 401) { disarmNewId(); return; }
          // The server knows this ID has an account, even if this card did not.
          swapForm.hidden = false;
          newIdBtn.textContent = 'Cancel';
          swapPass.select();
          return;
        }
        disarmNewId();
        // COMPARE AND SET, as moveOffUuid does: an ID another tab saved while
        // this one was in flight is kept.
        var now = load(PID_KEY);
        if (now && now !== old) { me.pid = now; paintId(); refresh(); return; }
        me.pid = d.pid;
        save(PID_KEY, d.pid);
        me.tag = d.tag || '';
        me.email = d.found ? (d.email || '') : '';
        idShown = false;
        paintId();
        paintAcct();
        sayPlayer(d.found
          ? 'New ID made, and the old one no longer works. Copy it and save it.'
          : 'New ID made. The old one held nothing yet. Copy the new one and save it.', 'ok');
      });
    }

    newIdBtn.addEventListener('click', function () {
      if (!swapForm.hidden) { disarmNewId(); return; }        // the Cancel of an open form
      if (!newIdArmed) {
        newIdBtn.textContent = 'Sure? Click again';
        newIdArmed = setTimeout(disarmNewId, 4000);
        return;
      }
      if (!me.email) { disarmNewId(); swapId(''); return; }
      // An account: ask for its password before anything moves.
      clearTimeout(newIdArmed);
      newIdBtn.textContent = 'Cancel';
      swapForm.hidden = false;
      swapPass.focus();
    });
    swapForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!swapPass.value) { sayPlayer('Type your password to get a new ID.', 'err'); swapPass.focus(); return; }
      swapId(swapPass.value);
    });

    idForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!inId.value.trim()) { sayAcct('Type your player ID.', 'err'); inId.focus(); return; }
      idGo.disabled = true;
      api('/api/player', { pid: inId.value }).then(function (d) {
        idGo.disabled = false;
        if (!d.ok) { sayAcct(d.reason, 'err'); return; }
        if (!d.found) { sayAcct('No player has that ID yet. Check it and try again.', 'err'); return; }
        inId.value = '';
        adopt(d);
      });
    });

    mailForm.addEventListener('submit', function (e) {
      e.preventDefault();
      mailGo.disabled = true;
      api('/api/login', { email: inEmail.value, password: inPass.value }).then(function (d) {
        mailGo.disabled = false;
        if (!d.ok) { sayAcct(d.reason, 'err'); if (d.status === 401) { inPass.select(); } return; }
        inPass.value = '';
        adopt(d);
      });
    });

    upForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = playerName();
      upGo.disabled = true;
      api('/api/register', { pid: me.pid, name: name, email: upEmail.value,
        password: upPass.value }).then(function (d) {
        upGo.disabled = false;
        if (!d.ok) { sayAcct(d.reason, 'err'); return; }
        upPass.value = '';
        save(PLAYER_KEY, name);
        me.tag = d.tag || me.tag;
        me.email = d.email || '';
        paintAcct();
        closeAcct();
        sayPlayer('Account created. You can now log in with your email on any device.', 'ok');
      });
    });

    copyBtn.addEventListener('click', function () {
      function done() {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1600);
      }
      // No clipboard (an old browser, or a page that is not https): select the
      // code instead, so a Ctrl+C still works. Shown first, or the selection
      // would copy the dots.
      function select() {
        idShown = true;
        paintId();
        var r = document.createRange();
        r.selectNodeContents(idCode);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        sayPlayer('Selected. Press Ctrl+C to copy it.', '');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(me.pid).then(done, select);
      } else { select(); }
    });

    paintId();
    paintAcct();
    if (UUID_RE.test(me.pid)) { moveOffUuid(); } else { refresh(); }

    // --- 2. company ----------------------------------------------------------
    var s1 = section(card, '2', 'Your company');
    var nameInput = el('input', {
      id: 'ipo-name', type: 'text', maxlength: '18',
      placeholder: 'Pick a company below', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Company name'
    });
    // 🔴 Has the player typed their OWN name? Picking a company fills this box
    // with that company's name, which is what puts every player on the board as
    // a real pre-IPO company instead of as "Acme Capital", a name that is not
    // even the right KIND of company. But a name somebody typed is theirs, so
    // the auto-fill only ever writes into a box they have not touched, or into
    // one still holding the last company they clicked.
    var nameTyped = false;
    nameInput.addEventListener('input', function () { nameTyped = true; });
    s1.appendChild(nameInput);

    var markRow = el('div', { id: 'ipo-markrow' });
    var preview = el('div', { id: 'ipo-preview' });
    var markText = el('div', { id: 'ipo-marktext' });
    // 🔴 NOT "a plain disc" any more, and this line is what a player reads
    // before deciding whether to pick anything. The default company now wears
    // the AgarIPO mark, which the preview beside this text is showing. A
    // sentence that describes the version before last is a lie the tests
    // cannot see.
    var status = el('div', { id: 'ipo-status' },
      'No logo yet. Your company will wear the AgarIPO mark.');
    markText.appendChild(status);
    markRow.appendChild(preview);
    markRow.appendChild(markText);
    s1.appendChild(markRow);

    // --- 3. logo -------------------------------------------------------------
    var s2 = section(card, '3', 'Your logo');
    var search = el('input', {
      id: 'ipo-search', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search ' + companies.length + ' pre-IPO companies',
      'aria-label': 'Search companies'
    });
    var grid = el('div', { id: 'ipo-grid' });
    if (companies.length) {
      s2.appendChild(search);
      s2.appendChild(grid);
    }

    // The input is a CHILD of the drop zone and stretched over it at opacity 0,
    // so a click anywhere on the zone lands on the real file control. The zone
    // also accepts a dropped file: it was styled as a drop target for a whole
    // release while dropping a file on it navigated the tab away from the game.
    var drop = el('div', { id: 'ipo-drop' });
    var file = el('input', {
      id: 'ipo-file', type: 'file', accept: '.png,.jpg,.jpeg,image/png,image/jpeg',
      title: 'Choose a PNG or JPEG', 'aria-label': 'Upload your own logo'
    });
    drop.appendChild(el('span', { class: 'ipo-dropmain' }, 'Or drop your own logo here, or click to browse'));
    // The privacy promise used to be a sentence in the footer nobody reads. It
    // belongs on the control it is about.
    drop.appendChild(el('span', { class: 'ipo-dropfine' },
      'PNG or JPEG, up to 4 MB. Checked and cropped round here; the original file never leaves this browser.'));
    drop.appendChild(file);
    s2.appendChild(drop);

    // --- go ------------------------------------------------------------------
    var play = el('button', { id: 'ipo-play', type: 'button' }, 'Go public');
    card.appendChild(play);

    var rules = el('ul', { id: 'ipo-rules' });
    var lines = [
      'Every company floats at $1B. Each dot of capital is another $1B.',
      'Past 50 raises, capital barely moves your size. Acquire instead.',
      'You acquire any company worth at least 5% less than you, or $5B, '
        + 'whichever is bigger.',
      'Hold left mouse to sprint. It costs 0.5% of your valuation every 2 seconds.',
      companies.length + ' real pre-IPO companies on the board, and only you. '
        + 'The market closes every 10 minutes and the table is published.'
    ];
    for (var i = 0; i < lines.length; i++) { rules.appendChild(el('li', null, lines[i])); }
    card.appendChild(rules);
    var note = el('p', { id: 'ipo-note' });
    // 🔴 target="_blank". The game is 43 MB of WebAssembly: navigating away from
    // it in the same tab to read a table means downloading all of it again to
    // come back, and a player who does that mid-session loses their round.
    var lbLine = el('span', { class: 'ipo-note-l' });
    lbLine.appendChild(el('a', { id: 'ipo-lb-link', href: '/leaderboard',
      target: '_blank', rel: 'noopener' }, 'See the global leaderboard'));
    note.appendChild(lbLine);
    note.appendChild(el('span', { class: 'ipo-note-l' }, 'Created for the Stocklana hackathon.'));
    var tail = el('span', { class: 'ipo-note-l' });
    tail.appendChild(document.createTextNode('Trade tokenized pre-IPO stocks at '));
    tail.appendChild(el('a', { href: 'https://prestocks.com', target: '_blank',
      rel: 'noopener noreferrer' }, 'prestocks.com'));
    note.appendChild(tail);
    card.appendChild(note);

    var overlay = el('div', { id: 'ipo-login' });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    // 🔴 The entrance is a pure CSS animation, deliberately NOT a class this
    // script adds. Motion has to fail open: a reveal that waits on JS leaves the
    // card invisible for anyone whose JS hiccups, and an invisible login card is
    // an unplayable game.

    function section(parent, num, title) {
      var sec = el('section', { class: 'ipo-step' });
      var h = el('h2', null, title);
      h.insertBefore(el('span', { class: 'ipo-num' }, num), h.firstChild);
      sec.appendChild(h);
      parent.appendChild(sec);
      return sec;
    }

    // The empty state is the DEFAULT MARK, not an empty circle, because an
    // empty circle is not what a player who picks nothing actually gets. The
    // same file the board draws: brand/agaripo-default.png.
    var DEFAULT_MARK_URL = 'brand/agaripo-default.png';

    function setMark(url) {
      preview.style.backgroundImage = 'url("' + (url || DEFAULT_MARK_URL) + '")';
      preview.classList.remove('pop');
      // Reading offsetWidth is what restarts the animation; without it a second
      // pick in a row does not move at all.
      void preview.offsetWidth;
      if (url) { preview.classList.add('pop'); }
    }

    function say(text, kind) {
      status.textContent = text;
      status.className = kind || '';
    }

    function clearTiles() {
      for (var t = 0; t < tiles.length; t++) { tiles[t].el.classList.remove('on'); }
    }

    // --- company grid --------------------------------------------------------
    var tiles = [];
    function paintGrid() {
      companies.forEach(function (company, idx) {
        var btn = el('button', { type: 'button', class: 'ipo-tile', title: company.n });
        // 🔴 Lazy, and it still matters at 50: that is 50 requests on a card
        // most players scroll two rows of. loading="lazy" makes the browser fetch
        // only what is actually near the viewport.
        var img = el('img', { src: logoUrl(company), alt: '', width: '46', height: '46',
          loading: 'lazy', decoding: 'async' });
        btn.appendChild(img);
        btn.appendChild(el('span', { class: 'ipo-tile-name' }, company.n));
        btn.addEventListener('click', function () {
          // Cancels the file-dialog watchdog. Click the drop zone, change your
          // mind and pick a company inside four seconds, and it would otherwise
          // still announce that the file window may have opened behind you.
          stopWaiting();
          clearTiles();
          btn.classList.add('on');
          file.value = '';
          skinDataUrl = null;
          pickedLogo = idx;
          setMark(logoUrl(company));
          if (!nameTyped) { nameInput.value = company.n; }
          say(company.n + ' is your mark. Rivals see it on your ball.', 'ok');
        });
        grid.appendChild(btn);
        tiles.push({ el: btn, name: company.n.toLowerCase() });
      });
    }

    if (companies.length) {
      paintGrid();
      search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        var shown = 0;
        tiles.forEach(function (t) {
          var hit = q === '' || t.name.indexOf(q) !== -1;
          t.el.hidden = !hit;
          if (hit) { shown++; }
        });
        grid.classList.toggle('empty', shown === 0);
      });
    }

    function takeFile(f) {
      if (!f) { return; }
      setMark(null);
      clearTiles();
      pickedLogo = -1;
      skinDataUrl = null;
      say('Checking ' + f.name + '...', '');
      play.disabled = true;
      validateAndReencode(f).then(function (res) {
        skinDataUrl = res.url;
        setMark(res.url);
        say('Accepted. Cropped round and redrawn at ' + res.px + 'x' + res.px + '.', 'ok');
        play.disabled = false;
      }).catch(function (err) {
        skinDataUrl = null;
        setMark(null);
        file.value = '';
        say(err && err.message ? err.message : 'That file was rejected.', 'err');
        play.disabled = false;
      });
    }

    // Nothing in JavaScript can see the OS file dialog, so it cannot see the
    // dialog opening behind a maximised browser window, which on Windows is a
    // common enough complaint to plan for. What it CAN see is that neither
    // `change` nor `cancel` ever arrived, and it can say so rather than leaving
    // the player staring at a box that appears to do nothing.
    var pickTimer = 0;
    function stopWaiting() { clearTimeout(pickTimer); pickTimer = 0; }
    file.addEventListener('click', function () {
      stopWaiting();
      pickTimer = setTimeout(function () {
        if (skinDataUrl) { return; }
        say('No file window? It can open behind this browser window on Windows. '
          + 'Or just pick a company above.', 'err');
      }, 4000);
    });
    file.addEventListener('cancel', stopWaiting);
    file.addEventListener('change', function () {
      stopWaiting();
      var f = file.files && file.files[0];
      if (!f) {
        setMark(null);
        say('No logo yet. Your company will wear the AgarIPO mark.', '');
        return;
      }
      takeFile(f);
    });

    // 🔴 Drag and drop, which the dashed box promised and never had. Without a
    // dragover handler that calls preventDefault the browser's default wins and
    // dropping a file NAVIGATES THE TAB to it: the whole game disappears and is
    // replaced by the image.
    ['dragenter', 'dragover'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      stopWaiting();
      var dt = e.dataTransfer;
      takeFile(dt && dt.files && dt.files[0]);
    });
    // ...and the same default, on the page as a whole. A file dropped an inch
    // wide of the box would otherwise still replace the game with the image.
    ['dragover', 'drop'].forEach(function (evt) {
      window.addEventListener(evt, function (e) { e.preventDefault(); }, false);
    });

    function start() {
      // A move still in flight: the round waits for it. The sound does not: it
      // has to start inside this click, the one gesture every browser accepts.
      if (moving) { startAudio(); moving.then(start); return; }
      // Another tab may have logged in, logged out or taken a new ID since this
      // card was built. The round is filed under what this browser holds NOW.
      var held = load(PID_KEY);
      if (held !== me.pid && (CODE_RE.test(held) || UUID_RE.test(held))) { me.pid = held; }
      // 🔴 Every player has a name on the global leaderboard, because that is
      // the whole point of it: without one every row is a company name, and a
      // board of fifty companies is four OpenAIs and three PreStocks. An empty
      // box gets a default rather than an error on the only button.
      var pname = playerName();
      save(PLAYER_KEY, pname);
      me.name = pname;
      me.named = false;
      // The game neither waits for this nor needs it. The closing card does:
      // it only names the player once the server has said the name is filed.
      api('/api/player', { pid: me.pid, name: pname }).then(function (d) {
        if (!d.ok) { return; }
        me.named = true;
        if (d.tag) { me.tag = d.tag; }
      });
      var picked = pickedLogo >= 0 && companies[pickedLogo]
        ? companies[pickedLogo].n : '';
      var n = (nameInput.value || '').trim().slice(0, 18) || picked || 'Newco';
      // A plain global. The engine reads it with one JSON.stringify eval, which
      // is the only browser-to-engine path in this project that has ever worked.
      window.AGARIPO_PLAYER = {
        name: n,
        logo: pickedLogo,
        skin: skinDataUrl || '',
        // The game forwards this in the join frame. See WHO THIS PLAYER IS above
        // for what it is and, more importantly, what it is not.
        pid: me.pid
      };
      // The one user gesture this game has, and every browser requires one
      // before any sound can play. Built here, never on page load.
      startAudio();
      overlay.classList.add('out');
      // Matches the 260 ms exit in login.css. Hiding it is what actually removes
      // it from the hit-testing stack; the class only fades it.
      setTimeout(function () {
        overlay.hidden = true;
        overlay.classList.remove('out');
        var cv = document.getElementById('canvas');
        if (cv) { cv.focus(); }
      }, 260);
    }
    play.addEventListener('click', start);
    [playerInput, nameInput].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !play.disabled) { start(); }
      });
    });
    (playerInput.value ? nameInput : playerInput).focus();
  }

  /* ==========================================================================
   * THE SOUNDTRACK, AND THE CONTROL IN THE BOTTOM LEFT CORNER
   *
   * 🔴 THERE IS NO AUDIO FILE. The whole score is generated here with the Web
   * Audio API: oscillators, one buffer of white noise, a few filters and a
   * delay, scheduled ahead of time. A licensed loop is bytes on a page that
   * already ships 43 MB of WebAssembly, a licence to honour, and a third-party
   * binary downloaded into a build. Oscillators are none of those things.
   *
   * 🔴 IT CANNOT START BEFORE A CLICK. Every browser blocks audio until a user
   * gesture, and an AudioContext created at page load starts `suspended` and
   * stays there. The gesture this game already has is the Go public button, so
   * that is where the context is built. Nothing here runs on the login card.
   *
   * The music is game music, and it used to be a spa. The first score was a slow
   * four-chord pad with a sparse pentatonic walk over it, a note roughly every
   * second: calm, and wrong for a game about eating your rivals. This one runs
   * at 128 BPM on a sixteenth-note grid: a four-on-the-floor kick, a snare on
   * two and four, hats on every sixteenth, a sawtooth bass pumping on the
   * eighths, a square-wave arpeggio, and a four-bar hook over the top. Same
   * chords, A minor, F, C, G, one a bar. It arrives in layers over a sixteen-bar
   * cycle (drums and bass, then the arpeggio, then the hook), with a snare fill
   * closing every eighth bar, so it builds and never sits still.
   * ======================================================================== */

  var MUSIC_KEY = 'agaripo.music';
  var VOL_KEY = 'agaripo.vol';
  var BPM = 128;
  var STEP = 60 / BPM / 4;  // one sixteenth note, 0.117 s
  var LOOKAHEAD = 1.4;      // how far ahead notes are scheduled, in seconds
  var TICK_MS = 340;        // how often the scheduler wakes up

  var actx = null, master = null, song = null;
  var musicTimer = 0, musicStep = 0, musicAt = 0;
  var musicOn = true, musicVol = 0.5;
  var audioBox = null, volInput = null, muteBtn = null, waves = [], slash = null;

  function prefRead() {
    try {
      var m = window.localStorage.getItem(MUSIC_KEY);
      if (m === 'off') { musicOn = false; }
      var v = parseFloat(window.localStorage.getItem(VOL_KEY));
      if (v >= 0 && v <= 1) { musicVol = v; }
    } catch (e) { /* private window, or site data blocked. Defaults stand. */ }
  }

  function prefWrite() {
    try {
      window.localStorage.setItem(MUSIC_KEY, musicOn ? 'on' : 'off');
      window.localStorage.setItem(VOL_KEY, String(musicVol));
    } catch (e) { /* same */ }
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) { n.setAttribute(k, attrs[k]); }
    return n;
  }

  // The whole score. Called once per AudioContext with the node everything plays
  // into, and returns the function that schedules one sixteenth note. It reads
  // nothing but its two arguments and STEP, so it can be rendered offline and
  // measured without the game around it.
  function makeSong(ctx, out) {
    function hz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

    // One chord a bar. The bass plays the root; the arpeggio walks the tones.
    var BARS = [
      { root: 45, tones: [57, 60, 64] },   // A minor
      { root: 41, tones: [57, 60, 65] },   // F
      { root: 48, tones: [55, 60, 64] },   // C
      { root: 43, tones: [55, 59, 62] }    // G
    ];
    // Index into the chord tones an octave up: 3 and 4 are another octave again.
    var ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3];
    // The hook, one bar per chord: [sixteenth, MIDI note, length in sixteenths].
    // Chord tones on every strong beat, so it cannot clash with what is under it.
    var HOOK = [
      [[0, 76, 2], [2, 76, 1], [3, 74, 1], [4, 72, 2], [6, 69, 2], [8, 72, 2], [10, 74, 2], [12, 76, 4]],
      [[0, 77, 2], [2, 76, 1], [3, 74, 1], [4, 72, 2], [6, 69, 2], [8, 72, 4], [12, 69, 2], [14, 72, 2]],
      [[0, 79, 2], [2, 76, 2], [4, 72, 2], [6, 76, 2], [8, 79, 3], [11, 81, 1], [12, 79, 4]],
      [[0, 74, 2], [2, 71, 2], [4, 67, 2], [6, 71, 2], [8, 74, 2], [10, 79, 2], [12, 74, 2], [14, 71, 2]]
    ];

    // One second of white noise, made once. The snare and the hats are filtered
    // slices of it, started at a random point so no two hits are identical.
    var noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var nd = noise.getChannelData(0);
    for (var i = 0; i < nd.length; i++) { nd[i] = Math.random() * 2 - 1; }

    function bus(type, freq, q) {
      var f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.connect(out);
      return f;
    }
    var hats = bus('highpass', 7200, 0.7);
    var snare = bus('bandpass', 1900, 0.8);
    var bass = bus('lowpass', 900, 3.5);
    var keys = bus('lowpass', 3000, 0.7);
    // An echo a dotted eighth behind the arpeggio and the hook. No reverb: a
    // convolver needs an impulse response, which is the audio file this avoids.
    var echo = ctx.createDelay(1.0);
    echo.delayTime.value = STEP * 3;
    var feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    var wet = ctx.createGain();
    wet.gain.value = 0.22;
    keys.connect(echo);
    echo.connect(feedback);
    feedback.connect(echo);
    echo.connect(wet);
    wet.connect(out);

    // A hit: in within 4 ms, gone by `hold`.
    function env(g, at, peak, hold) {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + hold);
    }

    function tone(type, note, at, peak, hold, dest) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      o.frequency.value = hz(note);
      env(g, at, peak, hold);
      o.connect(g);
      g.connect(dest);
      o.start(at);
      o.stop(at + hold + 0.02);
    }

    function hiss(at, peak, hold, dest) {
      var src = ctx.createBufferSource();
      var g = ctx.createGain();
      src.buffer = noise;
      env(g, at, peak, hold);
      src.connect(g);
      g.connect(dest);
      src.start(at, Math.random() * 0.8, hold + 0.02);
    }

    // A sine dropping from 150 Hz to 45 Hz in an eighth of a second is a kick.
    function kick(at) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, at);
      o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
      env(g, at, 0.5, 0.24);
      o.connect(g);
      g.connect(out);
      o.start(at);
      o.stop(at + 0.26);
    }

    // The hook holds its notes, where everything else is a hit.
    function lead(note, at, len) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = hz(note);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.06, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.03, at + len * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g);
      g.connect(keys);
      o.start(at);
      o.stop(at + len + 0.02);
    }

    return function (at, step) {
      var bar = (step / 16) | 0;
      var s = step % 16;
      var chord = BARS[bar % 4];
      var phrase = bar % 16;
      var fill = bar % 8 === 7 && s >= 12;

      if (s % 4 === 0) { kick(at); }
      if (fill) {
        // Four sixteenth snares rising into the next phrase, and no hats under them.
        hiss(at, 0.2 + (s - 12) * 0.035, 0.1, snare);
      } else {
        if (s === 4 || s === 12) {
          hiss(at, 0.3, 0.16, snare);
          tone('triangle', 55, at, 0.12, 0.08, out);
        }
        hiss(at, s % 4 === 2 ? 0.1 : 0.04, s % 4 === 2 ? 0.06 : 0.03, hats);
      }
      // Eighths, quieter on the kick so the two do not pile up, with a jump up
      // the octave twice a bar.
      if (s % 2 === 0) {
        var up = (s === 6 || s === 14) ? 12 : 0;
        tone('sawtooth', chord.root + up, at, s % 4 === 0 ? 0.12 : 0.2, STEP * 1.7, bass);
      }
      if (phrase >= 4) {
        var k = ARP[s];
        tone('square', chord.tones[k % 3] + 12 * (1 + ((k / 3) | 0)), at, 0.035, 0.12, keys);
      }
      if (phrase >= 8) {
        var hook = HOOK[bar % 4];
        for (var h = 0; h < hook.length; h++) {
          if (hook[h][0] === s) { lead(hook[h][1], at, hook[h][2] * STEP * 0.95); }
        }
      }
    };
  }

  // 🔴 A LOOKAHEAD SCHEDULER, not one setTimeout per note. This page runs a
  // 60 fps WebAssembly game on the same thread, so a timer that fires exactly
  // when a note is due fires late, and late is audible. Notes are handed to the
  // audio thread up to 1.4 s early with an exact start time, so a stutter in the
  // game cannot become a stutter in the music.
  function scheduleAhead() {
    if (!actx || !song) { return; }
    // Muted, or the slider at zero: there is nothing to hear, so nothing is
    // built. The song holds its place and carries on from there.
    if (!musicOn || musicVol <= 0) {
      musicAt = Math.max(musicAt, actx.currentTime + 0.05);
      return;
    }
    // Behind the clock after a long stall: skip ahead rather than play every
    // missed note at once.
    if (musicAt < actx.currentTime) { musicAt = actx.currentTime + 0.05; }
    while (musicAt < actx.currentTime + LOOKAHEAD) {
      song(musicAt, musicStep);
      musicAt += STEP;
      musicStep += 1;
    }
  }

  function applyVolume() {
    if (!master) { return; }
    // Squared, so the slider feels linear to an ear rather than to a number.
    var want = musicOn ? musicVol * musicVol * 0.6 : 0;
    var now = actx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(want, now + 0.25);
  }

  function paintMute() {
    for (var i = 0; i < waves.length; i++) { waves[i].style.opacity = musicOn ? '1' : '0'; }
    if (slash) { slash.style.opacity = musicOn ? '0' : '1'; }
    if (muteBtn) {
      muteBtn.setAttribute('aria-pressed', musicOn ? 'false' : 'true');
      muteBtn.setAttribute('aria-label', musicOn ? 'Mute music' : 'Unmute music');
      muteBtn.setAttribute('title', musicOn ? 'Mute music' : 'Unmute music');
    }
    if (audioBox) { audioBox.classList.toggle('off', !musicOn); }
  }

  function buildAudioBox() {
    var box = el('div', { id: 'ipo-audio', hidden: 'hidden' });
    var btn = el('button', { id: 'ipo-audio-btn', type: 'button' });
    var svg = svgEl('svg', { viewBox: '0 0 24 24', width: '17', height: '17',
      'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgEl('path', { d: 'M4 9.5v5h3.4L12 18.5v-13L7.4 9.5H4z',
      fill: 'currentColor' }));
    waves = [
      svgEl('path', { d: 'M15.2 9.4a3.6 3.6 0 0 1 0 5.2', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }),
      svgEl('path', { d: 'M17.7 7.2a7 7 0 0 1 0 9.6', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }),
    ];
    waves.forEach(function (w) { svg.appendChild(w); });
    slash = svgEl('path', { d: 'M15.6 9.6l5.2 4.8M20.8 9.6l-5.2 4.8', fill: 'none',
      stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' });
    slash.style.opacity = '0';
    svg.appendChild(slash);
    btn.appendChild(svg);

    var vol = el('input', { id: 'ipo-audio-vol', type: 'range', min: '0', max: '100',
      step: '1', 'aria-label': 'Music volume' });
    vol.value = String(Math.round(musicVol * 100));

    box.appendChild(btn);
    box.appendChild(vol);
    document.body.appendChild(box);

    // 🔴 The game canvas is underneath this and reads the left mouse button as
    // sprint. A press that lands on the control must not also be a press on the
    // game, or nudging the volume would burn half a per cent of the player's
    // valuation. The engine listens on the canvas element, so an event here
    // never reaches it; stopping propagation as well costs nothing and closes
    // the case if that ever changes.
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
      box.addEventListener(evt, function (e) { e.stopPropagation(); });
    });

    btn.addEventListener('click', function () {
      musicOn = !musicOn;
      applyVolume();
      paintMute();
      prefWrite();
      scheduleAhead();
    });
    vol.addEventListener('input', function () {
      musicVol = Math.min(1, Math.max(0, (parseInt(vol.value, 10) || 0) / 100));
      // Dragging the slider up is an unmistakable request to hear something.
      if (musicVol > 0 && !musicOn) { musicOn = true; paintMute(); }
      applyVolume();
      prefWrite();
      scheduleAhead();
    });

    audioBox = box;
    volInput = vol;
    muteBtn = btn;
    paintMute();
    return box;
  }

  // Called from the Go public button, which is the user gesture every browser
  // insists on. Total: a second click can only ever resume what is already here.
  function startAudio() {
    if (!audioBox) { buildAudioBox(); }
    audioBox.hidden = false;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { audioBox.hidden = true; return; }   // no Web Audio, no control
    if (actx) {
      if (actx.state === 'suspended') { actx.resume(); }
      return;
    }
    try {
      actx = new Ctor();
    } catch (e) {
      audioBox.hidden = true;
      return;
    }

    master = actx.createGain();
    master.gain.value = 0;
    // 🔴 A compressor on the way out, so a kick, a bass note, the arpeggio and
    // the hook landing on the same sixteenth come out as one level. MEASURED, by
    // an offline render of the whole 16-bar cycle at the top of the slider: peak
    // -7.8 dBFS without it and -4.0 dBFS with it, so nothing clips either way. Its
    // automatic makeup gain adds 4.3 to 4.8 dB at every slider position, and that
    // is part of the level the slider sets: -35 dBFS RMS at the default half.
    var limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter);
    limiter.connect(actx.destination);
    song = makeSong(actx, master);

    musicAt = actx.currentTime + 0.2;
    musicStep = 0;
    scheduleAhead();
    musicTimer = setInterval(scheduleAhead, TICK_MS);
    applyVolume();

    // A backgrounded tab should be silent, and should not be scheduling notes
    // either. Browsers throttle timers in a hidden tab, so without this the
    // scheduler wakes up late, sees a big gap and dumps a burst of notes.
    document.addEventListener('visibilitychange', function () {
      if (!actx) { return; }
      if (document.hidden) { actx.suspend(); }
      else if (musicOn || musicVol > 0) { actx.resume(); }
    });
  }

  prefRead();

  /* ==========================================================================
   * THE CLOSING BELL AND THE ACQUISITION CARD
   *
   * The game calls these two globals through JavaScriptBridge.eval. The argument is
   * always ONE JSON STRING, never interpolated source: a company name is player
   * input, and a name with a quote in it would otherwise close the string
   * literal that the eval is built from. Nothing here ever touches innerHTML
   * either, so a name is text on both sides of the bridge.
   *
   * Both functions are total: null or anything unparseable hides the card. A
   * card that could get stuck on screen would end the game as surely as a crash,
   * so every path out of here either shows a card or removes one.
   * ======================================================================== */

  var endBox = null, endTick = 0, endBail = 0;
  var deadBox = null, deadBail = 0;

  // 🔴 A DEAD MAN'S SWITCH ON EVERY CARD. Both are dismissed by a message from
  // the server, and a message can be missed: a dropped frame on the reset, a
  // reconnect that lands after the respawn. The closing card covers the whole
  // window and takes the mouse with it, so a stuck one is an unplayable game.
  // Every show therefore also schedules its own removal, a few seconds past the
  // point the server should have removed it.
  function bail(timer, node, ms) {
    if (timer) { clearTimeout(timer); }
    return setTimeout(function () { if (node) { node.hidden = true; } }, ms);
  }

  function markFor(node, g) {
    var c = (g >= 0 && companies[g]) ? companies[g] : null;
    node.style.backgroundImage = c ? 'url("' + logoUrl(c) + '")' : 'none';
  }

  function parse(raw) {
    if (raw == null) { return null; }
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return null; }
  }

  function buildEnd() {
    var wrap = el('div', { id: 'ipo-end', hidden: 'hidden' });
    var card = el('div', { id: 'ipo-end-card' });
    card.appendChild(el('h2', null, 'Market closed'));
    card.appendChild(el('p', { id: 'ipo-end-sub' }));

    var you = el('div', { id: 'ipo-you' });
    you.appendChild(el('div', { id: 'ipo-you-mark' }));
    var mid = el('div', { id: 'ipo-you-mid' });
    mid.appendChild(el('div', { id: 'ipo-you-rank' }));
    mid.appendChild(el('div', { id: 'ipo-you-name' }));
    mid.appendChild(el('div', { id: 'ipo-you-of' }));
    you.appendChild(mid);
    you.appendChild(el('div', { id: 'ipo-you-val' }));
    card.appendChild(you);

    // 🔴 EVERYTHING THAT CAN GROW GOES IN HERE, and the reason is measured: with
    // the acquisitions panel added the card came to 926 px against a 900 px
    // window, which put the prestocks.com line below the fold on a laptop. The
    // card is up for ten seconds. Nobody scrolls a card that is about to vanish,
    // so a line that needs scrolling to reach is a line nobody reads.
    //
    // The standard dialog shape fixes it at every height rather than at 900:
    // the card is capped to the viewport, the heading and the result and the
    // footer are pinned, and the one region in the middle takes the overflow.
    var scroll = el('div', { id: 'ipo-end-scroll' });
    var table = el('div', { id: 'ipo-table' });
    var head = el('div', { class: 'ipo-hrow' });
    head.appendChild(el('span', { class: 'ipo-crank' }, '#'));
    // A spacer the width of the mark column. Without it the word "Company" sat
    // 36 px to the left of every company name under it.
    head.appendChild(el('span', { class: 'ipo-cmark' }));
    head.appendChild(el('span', { class: 'ipo-cname' }, 'Company'));
    head.appendChild(el('span', { class: 'ipo-cval' }, 'Valuation'));
    table.appendChild(head);
    table.appendChild(el('div', { id: 'ipo-rows' }));
    scroll.appendChild(table);

    // What you took, under the table that says where you finished. The table is
    // the result; this is the story of how it happened, and it is the half a
    // player actually wants to screenshot.
    var took = el('div', { id: 'ipo-took' });
    var th = el('div', { id: 'ipo-took-head' });
    th.appendChild(el('span', { id: 'ipo-took-title' }, 'Companies you acquired'));
    th.appendChild(el('span', { id: 'ipo-took-count' }));
    took.appendChild(th);
    took.appendChild(el('div', { id: 'ipo-took-list' }));
    // 🔴 OUTSIDE the scroll region, and the table is the only thing inside it.
    // With both in there, a short window cut the words "Companies you acquired"
    // in half along the scroll edge: the panel degraded in exact proportion to
    // how well the player had played, which is the worst possible direction for
    // it to fail. A heading is never allowed to straddle a scroll boundary.
    card.appendChild(scroll);
    card.appendChild(took);

    var foot = el('p', { id: 'ipo-end-foot' });
    // The one moment a player has a number worth comparing. The round they just
    // finished is already filed by the time this card is on screen: the server
    // writes it in the same closing bell that sends this frame.
    var lb = el('a', { id: 'ipo-end-lb', href: '/leaderboard', target: '_blank', rel: 'noopener' },
      'See the global leaderboard');
    foot.appendChild(lb);
    foot.appendChild(el('br'));
    foot.appendChild(document.createTextNode('Trade tokenized pre-IPO stocks at '));
    var a = el('a', { href: 'https://prestocks.com', target: '_blank', rel: 'noopener noreferrer' }, 'prestocks.com');
    foot.appendChild(a);
    card.appendChild(foot);

    wrap.appendChild(card);
    document.body.appendChild(wrap);
    return wrap;
  }

  function buildDead() {
    var wrap = el('div', { id: 'ipo-dead', hidden: 'hidden' });
    var card = el('div', { id: 'ipo-dead-card' });
    card.appendChild(el('div', { id: 'ipo-dead-mark' }));
    card.appendChild(el('h2', null, 'You got acquired'));
    card.appendChild(el('p', { id: 'ipo-dead-line' }));
    card.appendChild(el('p', { id: 'ipo-dead-foot' }, 'Refounding'));
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    return wrap;
  }

  window.AGARIPO_CLOSE = function (raw) {
    var d = parse(raw);
    if (!endBox) { endBox = buildEnd(); }
    if (endTick) { clearInterval(endTick); endTick = 0; }
    if (endBail) { clearTimeout(endBail); endBail = 0; }
    if (!d || !d.top) { endBox.hidden = true; return; }
    // One card at a time. The bell can ring while a player is still holding a
    // death card, and two stacked cards is not a screen anybody designed.
    if (deadBox) { deadBox.hidden = true; }
    endBail = bail(0, endBox, (Math.max(0, d.secs | 0) + 5) * 1000);

    var sub = document.getElementById('ipo-end-sub');
    var left = Math.max(0, d.secs | 0);
    function paintClock() {
      sub.textContent = '';
      sub.appendChild(document.createTextNode('The market reopens in '));
      sub.appendChild(el('b', null, left + 's'));
    }
    paintClock();
    endTick = setInterval(function () {
      left -= 1;
      if (left <= 0) { clearInterval(endTick); endTick = 0; left = 0; }
      paintClock();
    }, 1000);

    var you = document.getElementById('ipo-you');
    if (d.you) {
      document.getElementById('ipo-you-rank').textContent = 'Rank ' + d.you.r + ' of ' + d.field;
      document.getElementById('ipo-you-name').textContent = d.you.n;
      document.getElementById('ipo-you-of').textContent = 'Your final valuation';
      document.getElementById('ipo-you-val').textContent = d.you.v;
      markFor(document.getElementById('ipo-you-mark'), d.you.g);
    } else {
      // 🔴 Acquired at the bell, and NOTHING here is invented. An earlier cut
      // refused to invent a rank and then printed "$0M of 120 companies" beside
      // it, which is exactly the fabricated number the refusal was about. A dash
      // is the honest glyph for a company that no longer exists.
      document.getElementById('ipo-you-rank').textContent = 'Acquired before the bell';
      document.getElementById('ipo-you-name').textContent = 'No final position';
      document.getElementById('ipo-you-of').textContent = 'You were taken over before the close';
      document.getElementById('ipo-you-val').textContent = '--';
      markFor(document.getElementById('ipo-you-mark'), -1);
    }
    you.hidden = false;

    var rows = document.getElementById('ipo-rows');
    rows.textContent = '';
    var top = d.top.length ? d.top[0].m : 1;
    for (var i = 0; i < d.top.length; i++) {
      var r = d.top[i];
      var row = el('div', { class: 'ipo-row' + (r.h ? ' me' : '') });
      var bar = el('span', { class: 'ipo-bar' });
      // Capped at 82%: the valuation is hard right, and a leader's full-width bar
      // would run underneath its own number.
      bar.style.width = Math.max(3, Math.round((r.m / (top || 1)) * 82)) + '%';
      row.appendChild(bar);
      row.appendChild(el('span', { class: 'ipo-crank' }, String(r.r)));
      var mark = el('span', { class: 'ipo-cmark' });
      markFor(mark, r.g);
      row.appendChild(mark);
      row.appendChild(el('span', { class: 'ipo-cname' }, r.n));
      row.appendChild(el('span', { class: 'ipo-cval' }, r.v));
      rows.appendChild(row);
    }
    paintTook(d);
    // The round is already filed by the time this card is up: the same bell
    // that sent this frame wrote it. Say under which name, so the player knows
    // what to look for on the board. 🔴 Only a name the server confirmed: if the
    // call that files it failed, the board shows the company instead, and the
    // card must not promise a name that is not there.
    document.getElementById('ipo-end-lb').textContent = !d.rec
      ? 'See the global leaderboard'
      : me.named
        ? 'On the global leaderboard as ' + me.name + (me.tag ? ' #' + me.tag : '')
        : 'On the global leaderboard';
    endBox.hidden = false;
  };

  // The acquisitions panel. `took` and `worth` are the exact totals for the
  // round; `mine` is only the biggest few, because a dominant player can acquire
  // more companies than there are on the board and a wall of ninety chips is not
  // a trophy case.
  function paintTook(d) {
    var list = document.getElementById('ipo-took-list');
    var count = document.getElementById('ipo-took-count');
    var mine = d.mine || [];
    var total = d.took | 0;
    list.textContent = '';
    if (!total) {
      count.textContent = '';
      var none = el('p', { class: 'ipo-took-none' },
        'None this round. Capital alone will not make you the biggest unicorn.');
      list.appendChild(none);
      return;
    }
    count.textContent = total + (total === 1 ? ' company' : ' companies')
      + (d.worth ? '  ·  ' + d.worth : '');
    for (var i = 0; i < mine.length; i++) {
      var chip = el('span', { class: 'ipo-chip' });
      var mk = el('span', { class: 'ipo-chip-mark' });
      markFor(mk, mine[i].g);
      chip.appendChild(mk);
      chip.appendChild(el('span', { class: 'ipo-chip-n' }, mine[i].n));
      chip.appendChild(el('span', { class: 'ipo-chip-v' }, mine[i].v));
      list.appendChild(chip);
    }
    if (total > mine.length) {
      list.appendChild(el('span', { class: 'ipo-chip more' },
        '+' + (total - mine.length) + ' more'));
    }
  }

  window.AGARIPO_DEAD = function (raw) {
    var d = parse(raw);
    if (!deadBox) { deadBox = buildDead(); }
    if (deadBail) { clearTimeout(deadBail); deadBail = 0; }
    if (!d) { deadBox.hidden = true; return; }
    deadBail = bail(0, deadBox, 12000);
    markFor(document.getElementById('ipo-dead-mark'), d.g);
    var line = document.getElementById('ipo-dead-line');
    line.textContent = '';
    line.appendChild(el('b', null, d.by || 'A rival'));
    line.appendChild(document.createTextNode(' took you at '));
    line.appendChild(el('i', null, d.val || ''));
    deadBox.hidden = false;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
}());
