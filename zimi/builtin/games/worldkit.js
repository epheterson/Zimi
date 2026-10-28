/* ZimiGames: the page shell the world board games share (the New game options built from a
   description and handed to the shell's Menu, settings and win/loss stats in localStorage, the status
   line, undo, hint, the computer's turn, the end sheet, and buttons laid over a drawn board).
   Our own code, GPL-3.0. Needs boardkit.js and boardui.js first. No network, no modules. */
(function (root) {
  'use strict';
  var BK = root.BoardKit, UI = root.BoardUI;
  function T(id, vars) { return UI.t(id, vars); }
  // A label is a string id when the table has it, else it is shown as written.
  function L(x) { return root.ZimiText && root.ZimiText.has(x) ? T(x) : x; }
  var COMPUTER_DELAY_MS = 420;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // The levels of the chess family: our own engine's four, then Fairy-Stockfish's two (Strong and Master, when it is there).
  var CLASSIC_LEVELS = [['beginner', 'chess.level.beginner'], ['casual', 'chess.level.casual'], ['club', 'chess.level.club'], ['strong', 'chess.level.strong'], ['fairy', 'chess.level.fairy'], ['master', 'chess.level.master']];

  // The usual options: who you play against, how strong, which side. opts: { base: the level list when it is not Easy to Hard (with levelDef),
  // levels: more levels after them, first, second: what the sides are called, side: false for a game with no sides }.
  function standardOptions(opts) {
    opts = opts || {};
    var out = [{ key: 'mode', legend: 'board.opponent', def: 'cpu', choices: [['cpu', 'board.zimi'], ['two', 'board.twoPlayers']] }];
    out.push({ key: 'level', legend: 'board.level', def: opts.levelDef || 'medium', cpuOnly: true, choices: (opts.base || [['easy', 'board.level.easy'], ['medium', 'board.level.medium'], ['hard', 'board.level.hard']]).concat(opts.levels || []) });
    if (opts.side !== false) out.push({ key: 'side', legend: 'board.youPlay', def: 'first', cpuOnly: true, choices: [['first', opts.first || 'board.first'], ['second', opts.second || 'board.second']] });
    return out;
  }

  // cfg: { id, options:[{key,legend,choices,def,cpuOnly}], checks:[{key,label,def}], statKey(settings),
  //        onNew(settings), onUndo(), onHint() }
  function create(cfg) {
    var $ = function (id) { return document.getElementById(id); };
    var SETTINGS_KEY = cfg.id + '.settings', STATS_KEY = cfg.id + '.stats';
    var settings = BK.load(SETTINGS_KEY, {}), stats = BK.load(STATS_KEY, {});
    var options = cfg.options || standardOptions(), checks = cfg.checks || [];
    options.forEach(function (o) {
      var ok = o.choices.some(function (c) { return c[0] === settings[o.key]; });
      if (!ok) settings[o.key] = o.def;
    });
    checks.forEach(function (c) { if (typeof settings[c.key] !== 'boolean') settings[c.key] = c.def; });

    var G = { settings: settings, thinking: 0, over: false };
    var els = { status: $('wk-status'), stats: $('wk-stats'), undo: $('wk-undo'), hint: $('wk-hint') };

    // ── Menu > New game: the options, built from the description ──
    // The shell shows these rows in its New game pane, with Start last; Start clicks the page's own New game button,
    // which applies what was chosen and begins. Nothing is applied until then.
    var draft = null, rows = [];
    function twoPlayers() { return draft && draft.mode === 'two'; }
    function refreshRows() {
      var two = twoPlayers();
      rows.forEach(function (r) { if (r.opt && r.opt.cpuOnly) r.row.disable(!!two); });
    }
    function menuOptions() {
      draft = Object.assign({}, settings); rows = [];
      options.forEach(function (o) {
        var r = UI.row(L(o.legend), o.choices.map(function (c) { return [c[0], L(c[1])]; }), draft[o.key], function (v) { draft[o.key] = v; refreshRows(); });
        rows.push({ row: r, opt: o });
      });
      checks.forEach(function (c) {
        rows.push({ row: UI.toggle(L(c.label), draft[c.key], function (v) { draft[c.key] = v; }) });
      });
      refreshRows();
      // A page may add rows of its own after these (Mahjong's seats): cfg.extraOptions() returns nodes.
      return UI.options(rows.map(function (r) { return r.row; }).concat(cfg.extraOptions ? cfg.extraOptions() : []));
    }
    function applyDraft() {
      if (!draft) return;
      Object.keys(draft).forEach(function (k) { settings[k] = draft[k]; });
      draft = null;
      BK.save(SETTINGS_KEY, settings);
    }
    function openMenu() { if (root.ZimiShell && root.ZimiShell.openMenu) root.ZimiShell.openMenu(); }

    // ── the page's parts ──
    G.vsComputer = function () { return settings.mode !== 'two'; };
    // Is the player to move (0 first, 1 second) a person at this screen?
    G.watching = null;   // Watch and learn: the driver's controller while a demo runs
    G.human = function (p) { if (G.watching) return false; return !G.vsComputer() || (settings.side === 'second' ? 1 : 0) === p; };
    var line = els.status ? UI.status(els.status) : { turn: function () {}, say: function () {}, reason: function () {}, thinking: function () {} };
    G.status = line;
    G.say = function (text, busy) {
      // While a demo runs nobody is "thinking": the narration above says what is happening.
      if (G.watching && busy) { text = T('board.watching'); busy = false; }
      line.turn(text, busy);
      // the opponent's chip pulses while the computer thinks
      Array.prototype.forEach.call(document.querySelectorAll('.bg-score .wk-who'), function (c) { c.classList.toggle('thinking', !!busy && c.classList.contains('turn')); });
    };
    // An illegal move: the shake on `target` (an element) and the reason, which gives way to the line before it.
    G.refuse = function (target, text) { UI.refuse(line, target, text); };
    // The two sides' names on screen: "You" and "Zimi" against the machine.
    G.names = function (a, b) {
      if (G.watching || !G.vsComputer()) return [a, b];
      return settings.side === 'second' ? [T('board.zimi'), T('board.you')] : [T('board.you'), T('board.zimi')];
    };
    G.who = function (p, a, b) { return G.names(a, b)[p]; };
    // The level as the chip calls it, in lower case (a level can be shown under a different name than its key).
    function levelName() {
      var o = options.filter(function (x) { return x.key === 'level'; })[0], c = o && o.choices.filter(function (x) { return x[0] === settings.level; })[0];
      return c ? L(c[1]) : settings.level;
    }
    G.showStats = function () {
      var s = stats[cfg.statKey ? cfg.statKey(settings) : settings.level];
      if (els.stats) UI.record(els.stats, levelName(), G.vsComputer() ? s : null);
    };
    G.setUndo = function (on) { if (els.undo) els.undo.disabled = !on || !!G.thinking; };
    G.setHint = function (on) { if (els.hint) els.hint.disabled = !on || !!G.thinking || G.over; };

    // The computer's turn runs later, so the screen shows the person's move first. A new
    // game or an undo cancels it (the token no longer matches).
    var seq = 0;
    G.later = function (fn, ms) {
      var token = G.begin();
      setTimeout(function () {
        if (token !== G.thinking) return;
        G.thinking = 0; fn();
      }, ms == null ? COMPUTER_DELAY_MS : ms);
    };
    // An asynchronous computer move (a worker): the caller says when it is done.
    G.begin = function () { G.thinking = ++seq; return G.thinking; };
    G.current = function (token) { return token === G.thinking; };
    G.done = function (token) { if (token === G.thinking) { G.thinking = 0; return true; } return false; };
    G.cancel = function () { seq++; G.thinking = 0; };

    // finish(text, outcome, name): `text` is the one line under the result; outcome is 'w' (a person won against the
    // computer), 'l', 'd', or none (two people: `name` is who won, or nothing for a game with no winner). `line` is
    // what the one status line says when `text` is too long for it (the sheet carries the whole of `text`).
    // The status line says who won as well as why, so it still reads right once the sheet is closed.
    var RESULT_KEY = { w: 'shell.end.win', l: 'shell.end.lose', d: 'shell.end.draw' };
    function resultLine(text, outcome, name) {
      var head = RESULT_KEY[outcome] ? T(RESULT_KEY[outcome]) : name ? T('shell.end.wins', { name: name }) : '';
      var s = head ? head + '. ' + text : text;
      return s.length > 60 ? text : s;
    }
    G.finish = function (text, outcome, name, line) {
      G.over = true;
      if (els.hint) els.hint.disabled = true;
      if (root.ZimiShell) root.ZimiShell.turn(false);
      if (G.watching) { G.say(text); G.watching.finish(T('board.watch.done', { text: text })); return; }
      if (G.vsComputer() && outcome) {
        var key = cfg.statKey ? cfg.statKey(settings) : settings.level;
        var s = stats[key] = stats[key] || { w: 0, l: 0, d: 0 };
        s[outcome]++; BK.save(STATS_KEY, stats);
      }
      G.say(line || resultLine(text, outcome, name)); G.showStats();
      G.result = { text: text, line: line || null, outcome: outcome || null, name: name || null };
      G.showEnd(G.result);
    };
    // The end sheet for a result {text, outcome, name}; also how a finished game comes back after leaving it.
    G.showEnd = function (r) {
      var result = r.outcome === 'w' ? 'win' : r.outcome === 'l' ? 'lose' : r.outcome === 'd' ? 'draw' : r.name ? 'win' : 'over';
      UI.end({ result: result, name: result === 'win' && r.outcome !== 'w' ? r.name : undefined, text: r.text });
    };
    // Never lose a game: leaving and coming back puts the same position on the table (ZimiShell.persist).
    // api: { save() -> the page's state as plain data, or null when no move was made; load(data) -> false if it
    // no longer fits, rebuilds the position; resume() carries on (a computer turn) }. The options in force, the
    // result of a finished game and the typed arrays inside states are kept here, so a page keeps only its own.
    var keeper = null;
    function snapshot() {
      if (G.watching || !keeper) return null;
      var d = keeper.save();
      return d == null ? null : { s: pack(settings), over: !!G.over, res: G.result || null, d: pack(d) };
    }
    G.persist = function (keep) {
      keeper = keep;
      root.ZimiGameSave = function () { var d = snapshot(); return d ? JSON.stringify(d) : ''; };   // the test reads the position here
      if (!root.ZimiShell || !root.ZimiShell.persist) return;
      root.ZimiShell.persist({
        save: snapshot,
        load: function (data) {
          var saved = unpack(data.s);
          G.cancel();
          Object.keys(saved).forEach(function (k) { settings[k] = saved[k]; });
          G.over = !!data.over; G.result = data.res || null;
          if (keep.load(unpack(data.d), saved) === false) return false;
          if (G.over && G.result) { G.say(G.result.line || resultLine(G.result.text, G.result.outcome, G.result.name)); G.showStats(); G.showEnd(G.result); }
          else if (keep.resume) keep.resume();
        }
      });
    };
    G.newGame = function () {
      G.cancel(); G.over = false;
      G.showStats();
      cfg.onNew(settings);
    };
    // The move timer: a person's turn starts (or the turn is not a person's), and what to do at zero.
    G.turnTimer = function (active, onExpire, key) { if (root.ZimiShell) root.ZimiShell.turn(active && !G.watching && !G.over, onExpire, key); };
    // Watch and learn, the part every page shares. def: { script, unit, intro, level, side (the
    // side that moves first, 'first'), whoseTurn() -> 0 or 1, busy() -> true while a move is
    // animating, resume() repaints and carries on after a takeover, hint, stats }.
    G.registerWatch = function (def) {
      if (!root.ZimiShell) return;
      var saved = null;
      root.ZimiShell.game({
        watch: {
          script: def.script, unit: def.unit,
          start: function (ctl) {
            saved = { mode: settings.mode, level: settings.level, side: settings.side };
            // options that would stop a demo (the doubling cube waits for a person's answer)
            Object.keys(def.override || {}).forEach(function (k) { saved[k] = settings[k]; settings[k] = def.override[k]; });
            settings.mode = 'cpu'; settings.level = def.level || 'medium'; settings.side = 'first';
            G.watching = ctl; G.newGame();
            ctl.say(L(def.intro));
          },
          // takeover: you play whoever is to move; stop: a fresh game; new: the New game sheet follows.
          stop: function (kind) {
            var ctl = G.watching; G.watching = null;
            function restore() { Object.keys(saved).forEach(function (k) { settings[k] = saved[k]; }); }
            function settle() {
              if (def.busy && def.busy()) { setTimeout(settle, 100); return; }
              G.cancel();
              var turn = def.whoseTurn();
              if (kind === 'takeover') { restore(); settings.mode = 'cpu'; settings.side = turn === 0 ? 'first' : 'second'; def.resume(); }
              else { restore(); if (kind === 'stop') G.newGame(); }
            }
            if (ctl) settle();
          }
        }
      });
    };
    if (root.ZimiShell) root.ZimiShell.game({
      stats: function () {
        var s = stats[cfg.statKey ? cfg.statKey(settings) : settings.level];
        if (!G.vsComputer() || !s || !(s.w + s.l + s.d)) return [];
        return [T(s.d ? 'board.record.draws' : 'board.record', { level: levelName(), won: s.w, lost: s.l, drawn: s.d })];
      },
      menu: menuOptions
    });
    G.openMenu = openMenu;
    G.closeResult = function () {};

    // The shell hides this button and clicks it from Menu > New game (and from the end sheet): apply the options, begin.
    $('wk-new').addEventListener('click', function () { applyDraft(); G.newGame(); });
    if (els.undo) els.undo.addEventListener('click', function () { if (!els.undo.disabled && cfg.onUndo) cfg.onUndo(); });
    if (els.hint) {
      if (!cfg.onHint) els.hint.hidden = true;
      else els.hint.addEventListener('click', function () { if (!els.hint.disabled) cfg.onHint(); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
      var k = e.key.toLowerCase();
      if (k === 'n') openMenu();
      else if (k === 'u' && els.undo && !els.undo.disabled && cfg.onUndo) cfg.onUndo();
      else if (k === 'h' && els.hint && !els.hint.disabled && cfg.onHint) cfg.onHint();
    });
    return G;
  }

  // Buttons laid over a drawn board, one per place a person can tap or reach with the keys.
  // pts: [{x, y, w, h, label}] in the drawing's units (W by H); arrows move to the nearest
  // place in that direction. Returns the buttons.
  var DIRVEC = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  function overlay(host, W, H, pts, onPick, cls) {
    var btns = [];
    pts.forEach(function (p, i) {
      var b = el('button', 'wk-pt' + (cls ? ' ' + cls : ''));
      b.type = 'button'; b.dataset.i = i;
      var w = p.w, h = p.h || p.w;
      b.style.left = ((p.x - w / 2) / W * 100) + '%'; b.style.top = ((p.y - h / 2) / H * 100) + '%';
      b.style.width = (w / W * 100) + '%'; b.style.height = (h / H * 100) + '%';
      b.tabIndex = i ? -1 : 0;
      b.addEventListener('click', function () { onPick(i); });
      b.addEventListener('focus', function () { btns.forEach(function (o) { o.tabIndex = o === b ? 0 : -1; }); });
      host.appendChild(b); btns.push(b);
    });
    host.addEventListener('keydown', function (e) {
      var d = DIRVEC[e.key], cur = btns.indexOf(document.activeElement);
      if (!d || cur < 0 || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      var c = pts[cur], best = -1, bestCost = Infinity;
      pts.forEach(function (p, i) {
        if (i === cur) return;
        var dx = p.x - c.x, dy = p.y - c.y, along = dx * d[0] + dy * d[1], across = Math.abs(dx * d[1] - dy * d[0]);
        if (along <= 0) return;
        var cost = along + across * 2.2;
        if (cost < bestCost) { bestCost = cost; best = i; }
      });
      if (best >= 0) btns[best].focus();
    });
    return btns;
  }

  // The row above the board: who is who (a colour dot and a name), a number each, and a ring
  // round whoever is to move. defs: [{color}]; update(names, values, turnIndex).
  function scoreBar(host, defs) {
    host.textContent = '';
    var parts = defs.map(function (d) {
      var s = el('span', 'wk-who'), dot = el('i', 'wk-pip'), name = el('span'), b = el('b');
      if (d.color) dot.style.background = d.color;
      if (d.border) dot.style.borderColor = d.border;
      s.appendChild(dot); s.appendChild(name); s.appendChild(b); host.appendChild(s);
      return { s: s, name: name, b: b };
    });
    return function (names, values, turn) {
      parts.forEach(function (p, i) {
        p.name.textContent = names[i];
        p.b.textContent = values && values[i] != null ? values[i] : '';
        p.s.classList.toggle('turn', i === turn);
      });
    };
  }

  // Gradients for round stones (Go, Gomoku, Morris): fill="url(#wk-stone-b)" and "...-w".
  var STONE_DEFS = '<defs><radialGradient id="wk-stone-b" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#5e5953"/><stop offset="0.55" stop-color="#25221f"/><stop offset="1" stop-color="#0c0b0a"/></radialGradient>' +
    '<radialGradient id="wk-stone-w" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#ece8dc"/><stop offset="1" stop-color="#b9b3a2"/></radialGradient></defs>';

  // A flat undo stack of snapshots (the snapshot is whatever the game hands in).
  // The saved history is capped, so the save stays small.
  var KEEP_HISTORY = 40, pack = UI.pack, unpack = UI.unpack;
  function History() { var h = []; return { all: function () { return h.slice(-KEEP_HISTORY); }, set: function (list) { h = list.slice(); }, push: function (s) { h.push(s); }, pop: function () { return h.pop(); }, clear: function () { h.length = 0; }, size: function () { return h.length; }, last: function () { return h[h.length - 1]; } }; }

  // Fisher-Yates with a given random function.
  function shuffle(a, rnd) {
    for (var i = a.length - 1; i > 0; i--) { var j = (rnd() * (i + 1)) | 0, t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function pick(a, rnd) { return a[(rnd() * a.length) | 0]; }

  // Wait for the page's frame before heavy work, so a "thinking" line gets painted first.
  function afterPaint(fn) { setTimeout(fn, 30); }

  root.WorldKit = { CLASSIC_LEVELS: CLASSIC_LEVELS, pack: pack, unpack: unpack, create: create, standardOptions: standardOptions, overlay: overlay, History: History, scoreBar: scoreBar, STONE_DEFS: STONE_DEFS, shuffle: shuffle, pick: pick, afterPaint: afterPaint, el: el };
})(typeof globalThis !== 'undefined' ? globalThis : this);
