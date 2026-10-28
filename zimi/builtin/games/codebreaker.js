/* ZimiGames: Code Breaker. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var PEGS = 4, COLOURS = 6, ROWS = 10;

  // Score a guess: `exact` pegs right in colour and place, `colour` right in colour only.
  // Each peg of the code answers at most one peg of the guess, so repeats are never counted twice.
  function feedback(code, guess) {
    var exact = 0, cc = [], gc = [], i, total = 0;
    for (i = 0; i < COLOURS; i++) { cc.push(0); gc.push(0); }
    for (i = 0; i < code.length; i++) {
      if (code[i] === guess[i]) exact++;
      else { cc[code[i]]++; gc[guess[i]]++; }
    }
    for (i = 0; i < COLOURS; i++) total += Math.min(cc[i], gc[i]);
    return { exact: exact, colour: total };
  }

  function makeCode(rng, repeats) {
    var code = [], pool = [], i;
    for (i = 0; i < COLOURS; i++) pool.push(i);
    while (code.length < PEGS) {
      var k = Math.floor(rng() * pool.length);
      code.push(pool[k]);
      if (!repeats) pool.splice(k, 1);
    }
    return code;
  }
  function isValid(guess, repeats) {
    if (guess.length !== PEGS) return false;
    if (!guess.every(function (c) { return c >= 0 && c < COLOURS && c === Math.floor(c); })) return false;
    return repeats || guess.every(function (c, i) { return guess.indexOf(c) === i; });
  }

  var Engine = { PEGS: PEGS, COLOURS: COLOURS, ROWS: ROWS, feedback: feedback, makeCode: makeCode, isValid: isValid };
  root.CodeBreakerEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, END_AFTER_MS = 700;
  var SETTINGS_KEY = 'zimi.games.codebreaker.settings', BEST_KEY = 'zimi.games.codebreaker.best';
  function pegName(c) { return T('cb.peg.' + c); }
  Play.applyTheme();

  var els = { secret: $('cb-secret'), rows: $('cb-rows'), msg: $('cb-msg'), palette: $('cb-palette'), undo: $('cb-undo'), check: $('cb-check'), nu: $('cb-new') };
  var line = Play.status(els.msg);
  var settings = Play.load(SETTINGS_KEY, { repeats: true }), best = Play.load(BEST_KEY, {});
  var code, rows, cur, status, seats; // status: 'setting' (a person makes the code) | 'playing' | 'won' | 'lost'
  // Seat 0 breaks the code, seat 1 makes it: the Computer makes it by default; a second person
  // makes it behind a handoff, then the device goes to the breaker.
  function seatsNow(onChange) {
    var sx = root.ZimiSeats.create({ id: 'codebreaker', seats: 2, onChange: onChange });
    if (!sx.person(0)) sx.setKind(0, 'person'); // the computer does not break codes
    return sx;
  }
  seats = seatsNow();
  var active = function () { return status === 'playing' || status === 'setting'; };
  var secret = function () { return status === 'playing' || status === 'setting'; };

  function peg(c, size) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'pl-peg';
    if (c >= 0) { b.dataset.c = c; b.innerHTML = Play.symbolSVG(c, size || 22); b.setAttribute('aria-label', pegName(c)); }
    return b;
  }
  function fbEl(fb) {
    var d = document.createElement('span'); d.className = 'cb-fb';
    d.setAttribute('role', 'img'); d.setAttribute('aria-label', fb ? T('cb.feedback', { exact: fb.exact, color: fb.colour }) : T('cb.notScored'));
    for (var i = 0; i < PEGS; i++) {
      var k = document.createElement('i');
      k.className = fb ? (i < fb.exact ? 'cb-x' : i < fb.exact + fb.colour ? 'cb-c' : 'cb-0') : 'cb-0';
      d.appendChild(k);
    }
    return d;
  }

  function paint() {
    // the secret
    els.secret.textContent = '';
    for (var i = 0; i < PEGS; i++) {
      var s = secret() ? peg(-1) : peg(code[i]); s.disabled = true;
      if (secret()) s.textContent = '?';
      els.secret.appendChild(s);
    }
    els.secret.setAttribute('aria-label', secret() ? T('cb.hidden') : T('cb.theCode', { pegs: code.map(pegName).join(', ') }));
    // the rows
    els.rows.textContent = '';
    for (var r = 0; r < ROWS; r++) {
      var li = document.createElement('li'), now = r === rows.length && active();
      li.className = 'cb-row' + (now ? ' cb-now' : '');
      var n = document.createElement('span'); n.className = 'cb-n'; n.textContent = r + 1; n.setAttribute('aria-hidden', 'true'); li.appendChild(n);
      var pegs = document.createElement('span'); pegs.className = 'cb-pegs';
      for (var k = 0; k < PEGS; k++) {
        var c = r < rows.length ? rows[r].guess[k] : now ? cur[k] : -1, b = peg(c);
        if (now) { b.setAttribute('aria-label', c >= 0 ? T('cb.tapRemove', { peg: pegName(c) }) : T('cb.emptyPlace', { n: k + 1 })); (function (slot) { b.addEventListener('click', function () { cur[slot] = -1; paint(); }); })(k); }
        else b.disabled = true;
        pegs.appendChild(b);
      }
      li.appendChild(pegs);
      li.appendChild(fbEl(r < rows.length ? rows[r].fb : null));
      els.rows.appendChild(li);
    }
    // the palette
    els.palette.textContent = '';
    for (var p = 0; p < COLOURS; p++) {
      var pb = peg(p, 26);
      pb.disabled = !active() || cur.indexOf(-1) < 0 || (!settings.repeats && cur.indexOf(p) >= 0);
      (function (c) { pb.addEventListener('click', function () { add(c); }); })(p);
      els.palette.appendChild(pb);
    }
    els.check.disabled = !active() || cur.indexOf(-1) >= 0;
    els.check.textContent = T(status === 'setting' ? 'cb.hide' : 'cb.check');
    els.undo.disabled = !active() || cur.every(function (c) { return c < 0; });
  }

  function add(c) {
    if (!active()) return;
    var i = cur.indexOf(-1);
    if (i < 0 || (!settings.repeats && cur.indexOf(c) >= 0)) return;
    cur[i] = c; paint();
  }
  function back() {
    for (var i = PEGS - 1; i >= 0; i--) if (cur[i] >= 0) { cur[i] = -1; break; }
    paint();
  }
  function check() {
    if (!active() || !isValid(cur, settings.repeats)) return;
    if (status === 'setting') {
      code = cur.slice(); cur = [-1, -1, -1, -1]; status = 'playing'; paint();
      line.say(T('cb.tenGuesses'));
      seats.cover(0, paint, T('cb.passBreaker'));
      return;
    }
    var fb = feedback(code, cur);
    rows.push({ guess: cur.slice(), fb: fb });
    cur = [-1, -1, -1, -1];
    if (fb.exact === PEGS) { status = 'won'; paint(); return finish(); }
    if (rows.length >= ROWS) { status = 'lost'; paint(); return finish(); }
    line.say(T('cb.scored', { exact: fb.exact, color: fb.colour, left: ROWS - rows.length }));
    paint();
  }
  // replay: a finished game coming back from a save shows its end sheet again without recording a best twice.
  function finish(replay) {
    var k = settings.repeats ? 'repeats' : 'single', opts = { after: replay ? 0 : END_AFTER_MS }, text;
    if (status === 'won') {
      text = T('cb.cracked', { n: rows.length });
      if (seats.hotseat()) { opts.result = 'win'; opts.name = seats.name(0); text = T('cb.crackedBy', { breaker: seats.name(0), maker: seats.name(1), n: rows.length }); }
      else { if (!replay && (!best[k] || rows.length < best[k])) { best[k] = rows.length; Play.save(BEST_KEY, best); } opts.result = 'win'; opts.stats = [[T('cb.guesses'), Play.num(rows.length)], [T('play.best'), Play.num(best[k])]]; }
    } else if (seats.hotseat()) { opts.result = 'win'; opts.name = seats.name(1); text = T('cb.held'); }
    else { opts.result = 'lose'; text = T('cb.outOfGuesses'); }
    line.say(text);
    ZimiShell.endSheet(opts);
  }

  // The rules and who plays are choices about the game, so they sit in the New game pane: Repeat colors, then the seats.
  function menuOptions() {
    var host = document.createElement('div');
    host.appendChild(Play.optionRow(T('cb.repeat'), [[false, T('shell.off')], [true, T('shell.on')]], !!settings.repeats, function (v) { settings.repeats = v; Play.save(SETTINGS_KEY, settings); }));
    host.appendChild(root.ZimiSeats.create({ id: 'codebreaker', seats: 2 }).block(null, { labels: [T('cb.breaker'), T('cb.maker')] }));
    return [host];
  }
  function begin() {
    seats = seatsNow(function () { paint(); });
    rows = []; cur = [-1, -1, -1, -1];
    if (seats.hotseat()) {
      code = [0, 1, 2, 3]; status = 'setting';
      line.say(T('cb.makeCode', { name: seats.name(1) }));
      paint();
      seats.begin(paint, 1);
      return;
    }
    code = makeCode(Math.random, settings.repeats); status = 'playing';
    line.say(T('cb.tenGuesses'));
    paint();
    seats.begin(paint);
  }
  els.nu.addEventListener('click', begin);
  ZimiShell.game({
    inProgress: function () { return (status === 'playing' || status === 'setting') && (rows.length > 0 || cur.some(function (c) { return c >= 0; })); },
    menu: function () { return { options: menuOptions() }; },
    stats: function () { return [[T('cb.bestRow', { mode: T('cb.mode.repeats') }), best.repeats ? T('cb.nGuesses', { n: best.repeats }) : '-'], [T('cb.bestRow', { mode: T('cb.mode.single') }), best.single ? T('cb.nGuesses', { n: best.single }) : '-']]; }
  });
  els.undo.addEventListener('click', back);
  els.check.addEventListener('click', check);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])') || !active() || seats.covering) return;
    if (e.key >= '1' && e.key <= '6') add(+e.key - 1);
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 'Enter' && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); check(); }
  });

  begin();
  // Leaving keeps the code, the guesses, the half-made guess and who is playing; a finished game comes back to its end sheet.
  function kept() {
    if (!rows.length && cur.every(function (c) { return c < 0; }) && status !== 'setting') return null;
    return { code: code, rows: rows, cur: cur, status: status, repeats: !!settings.repeats };
  }
  function takeUp(d) {
    var okPeg = function (c) { return c >= -1 && c < COLOURS && c === Math.floor(c); };
    if (!d || !Array.isArray(d.code) || d.code.length !== PEGS || !Array.isArray(d.cur) || d.cur.length !== PEGS || !d.cur.every(okPeg) || !Array.isArray(d.rows) || d.rows.length > ROWS || ['setting', 'playing', 'won', 'lost'].indexOf(d.status) < 0) return false;
    settings.repeats = !!d.repeats; Play.save(SETTINGS_KEY, settings);
    seats = seatsNow(function () { paint(); });
    code = d.code; rows = d.rows; cur = d.cur; status = d.status;
    paint();
    if (status === 'won' || status === 'lost') finish(true);
    else line.say(status === 'setting' ? T('cb.makeCode', { name: seats.name(1) }) : T('cb.tenGuesses'));
    return true;
  }
  ZimiShell.persist({ save: kept, load: takeUp });
  root.__codebreaker = { get code() { return code; }, get rows() { return rows; }, get cur() { return cur; } };
})(this);
