/* ZimiGames: Jigsaw. A picture cut into 12 to 100 pieces, dragged into place with a snap. Inside Zimi the picture
   comes from the player's own Wikipedia: the day's picture (the same for everyone on that Zimi) or one at random,
   credited to its article. In Kiwix, from a folder, or when the library has no pictures, the pictures are drawn
   here (drawScene) so the game is never empty. Our own code, GPL-3.0.
   The math (pure functions, no DOM, so node can test it) and the page (only when there is a document). */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the math ─────────────────────────────────────────────────────────────
  var COUNTS = [12, 24, 48, 100];
  var MIN_ASPECT = 0.7, MAX_ASPECT = 1.6;   // a picture's shape, kept to what a phone and a desktop both hold
  var SNAP_FRACTION = 0.42;                  // of the smaller side of a piece: how near is near enough
  var MIN_SIDE = 220;                        // smaller than this (pixels) a picture is too small to cut up

  // Columns and rows for about `count` pieces on a board of this aspect (width over height): the grid with the
  // fewest pieces off the count whose cells are closest to square.
  function gridFor(count, aspect) {
    var best = null;
    for (var rows = 1; rows <= count; rows++) {
      var cols = Math.max(1, Math.round(rows * aspect));
      var n = cols * rows, cell = (aspect / cols) * rows;      // cell width over cell height, ideally 1
      var score = Math.abs(n - count) / count + Math.abs(Math.log(cell)) * 2;
      if (!best || score < best.score) best = { cols: cols, rows: rows, score: score };
    }
    return { cols: best.cols, rows: best.rows };
  }
  function clampAspect(a) { return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a)); }

  // How a picture of iw x ih fills a board of W x H without stretching (the overflow is cropped, centred):
  // the size it is drawn at and the offset of its top left from the board's.
  function cover(iw, ih, W, H) {
    var s = Math.max(W / iw, H / ih), w = iw * s, h = ih * s;
    return { w: w, h: h, x: (W - w) / 2, y: (H - h) / 2 };
  }

  // Where piece i (counting along rows) belongs on the board, and the piece's size.
  function home(i, cols, rows, W, H) {
    var pw = W / cols, ph = H / rows;
    return { x: (i % cols) * pw, y: Math.floor(i / cols) * ph, w: pw, h: ph };
  }

  // Is a piece dropped at (x, y) close enough to its home to snap into it?
  function snaps(x, y, h) {
    var tol = Math.min(h.w, h.h) * SNAP_FRACTION;
    return Math.hypot(x - h.x, y - h.y) <= tol;
  }

  // Starting places in a tray (a rectangle), scattered by chance so no piece starts home and none starts hidden
  // off the tray: [{x, y}] top left corners.
  function scatter(n, tray, pw, ph, rng) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ x: tray.x + rng() * Math.max(0, tray.w - pw), y: tray.y + rng() * Math.max(0, tray.h - ph) });
    return out;
  }

  function solved(pieces) { return pieces.length > 0 && pieces.every(function (p) { return p.locked; }); }

  // The picture drawn here for a page with nothing to draw from: a scene, from a seed, on a canvas context.
  var SCENES = ['sunrise', 'night', 'sea', 'meadow'];
  function drawScene(ctx, W, H, kind, rng) {
    var i, g;
    var sky = {
      sunrise: ['#f7c873', '#e9786b', '#503a77'], night: ['#0b1030', '#243a7a', '#5a4a8a'],
      sea: ['#9fd6f2', '#6bb7e0', '#2a6fa8'], meadow: ['#bfe3f5', '#e8f4d8', '#8cc86b']
    }[kind];
    g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, sky[0]); g.addColorStop(0.55, sky[1]); g.addColorStop(1, sky[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // the sun or the moon
    ctx.fillStyle = kind === 'night' ? '#f4f1d6' : '#fff6c9';
    ctx.beginPath(); ctx.arc(W * (0.2 + rng() * 0.6), H * (0.18 + rng() * 0.15), H * 0.08, 0, Math.PI * 2); ctx.fill();
    if (kind === 'night') { ctx.fillStyle = '#fff'; for (i = 0; i < 70; i++) ctx.fillRect(rng() * W, rng() * H * 0.55, 2, 2); }
    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (i = 0; i < 4; i++) { var cx = rng() * W, cy = H * (0.1 + rng() * 0.3); ctx.beginPath(); ctx.ellipse(cx, cy, W * 0.09, H * 0.03, 0, 0, Math.PI * 2); ctx.ellipse(cx + W * 0.06, cy + 4, W * 0.07, H * 0.025, 0, 0, Math.PI * 2); ctx.fill(); }
    // far and near hills or waves
    var layers = kind === 'sea' ? ['#3d86b8', '#2a6fa8', '#1b5388'] : kind === 'night' ? ['#1a2250', '#131a40', '#0c1230'] : kind === 'sunrise' ? ['#7a4a7d', '#4d3566', '#2f2250'] : ['#7fb86a', '#5fa055', '#3f8444'];
    layers.forEach(function (col, l) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H);
      var base = H * (0.55 + l * 0.13), amp = H * (0.12 - l * 0.025), ph = rng() * 6;
      for (var x = 0; x <= W; x += 8) ctx.lineTo(x, base - Math.sin(x / W * (4 + l * 2) + ph) * amp - (kind === 'sea' ? 0 : Math.sin(x / W * 9 + ph * 2) * amp * 0.3));
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    });
    // a few things to look at: trees, or a boat
    if (kind === 'sea') {
      var bx = W * (0.3 + rng() * 0.4), by = H * 0.66;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(bx, by - H * 0.14); ctx.lineTo(bx + W * 0.07, by - 6); ctx.lineTo(bx, by - 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c4443a'; ctx.fillRect(bx - W * 0.06, by - 6, W * 0.14, 12);
    } else {
      for (i = 0; i < 9; i++) {
        var tx = rng() * W, ty = H * (0.7 + rng() * 0.25), th = H * (0.07 + rng() * 0.06);
        ctx.fillStyle = kind === 'night' ? '#0a0f26' : '#2f6f3f'; ctx.beginPath(); ctx.moveTo(tx, ty - th); ctx.lineTo(tx + th * 0.45, ty); ctx.lineTo(tx - th * 0.45, ty); ctx.closePath(); ctx.fill();
      }
    }
  }

  var Engine = { COUNTS: COUNTS, gridFor: gridFor, clampAspect: clampAspect, cover: cover, home: home, snaps: snaps, scatter: scatter, solved: solved, SCENES: SCENES, drawScene: drawScene, MIN_SIDE: MIN_SIDE };
  root.JigsawEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var PREFS_KEY = 'zimi.games.jigsaw.prefs', BEST_KEY = 'zimi.games.jigsaw.best';
  var PICTURE_TRIES = 10, SCENE_W = 800, SCENE_H = 600, TRAY_RATIO = 0.55, MAX_BOARD_W = 640, TICK_MS = 500, SNAP_MS = 160;
  var els = { area: $('jg-area'), board: $('jg-board'), ghost: $('jg-ghost'), msg: $('jg-msg'), time: $('jg-time'), peek: $('jg-peek'), credit: $('jg-credit'), read: $('jg-read'), newBtn: $('jg-new') };
  var line = Play.status(els.msg), pending = null;   // a choice made in the New game pane, taken when it starts
  var zim = null, zimTitle = '';
  var prefs = Play.load(PREFS_KEY, { count: 24, today: false });
  var puzzle = null, timer = null, today = Lib.dayKey(new Date()), z = 1;

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function say(t) { line.say(t || ''); els.msg.classList.toggle('gl-loading', !!t); }

  // A picture to cut: {url, w, h, credit, title?, path?, zim?}.
  function fromLibrary(daily) {
    var attempts = 0;
    function ask(wantDaily) {
      return Lib.random(zim, { thumb: true, requireThumb: true, day: wantDaily ? today : '' }).then(function (r) {
        if (!r || !r.thumbnail) throw new Error('no picture');
        return new Promise(function (ok, no) {
          var img = new Image();
          img.onload = function () { Math.min(img.naturalWidth, img.naturalHeight) >= MIN_SIDE ? ok({ url: r.thumbnail, w: img.naturalWidth, h: img.naturalHeight, title: r.title, path: r.path, zim: zim, credit: T('jigsaw.credit', { title: r.title, source: zimTitle }) }) : no(new Error('too small')); };
          img.onerror = function () { no(new Error('no image')); };
          img.src = r.thumbnail;
        });
      }).catch(function (e) {
        if (++attempts >= PICTURE_TRIES) throw e;
        return ask(false);
      });
    }
    return ask(daily);
  }
  function drawn(seed) {
    var c = document.createElement('canvas'); c.width = SCENE_W; c.height = SCENE_H;
    var rng = Lib.rng(seed), kind = SCENES[Math.floor(rng() * SCENES.length)];
    drawScene(c.getContext('2d'), SCENE_W, SCENE_H, kind, rng);
    return { url: c.toDataURL('image/jpeg', 0.9), w: SCENE_W, h: SCENE_H, credit: T('jigsaw.drawn') };
  }
  function getPicture(daily) {
    var seed = daily ? Lib.hash('jigsaw|' + today) : Math.floor(Math.random() * 4294967295);
    if (!zim) return Promise.resolve(drawn(seed));
    return fromLibrary(daily).catch(function () {
      var p = drawn(seed); p.note = T('jigsaw.noPictures'); return p;
    });
  }

  // ── a puzzle ──
  function boardSize(aspect) {
    var avail = els.area.parentNode.clientWidth - 24, vh = window.innerHeight;   // the page's own side padding
    var W = Math.min(MAX_BOARD_W, avail), H = W / aspect;
    var maxH = Math.max(180, (vh - 330) / (1 + TRAY_RATIO));      // the bar, the readouts and the buttons take the rest
    if (H > maxH) { H = maxH; W = H * aspect; }
    return { W: Math.floor(W), H: Math.floor(H) };
  }
  function layout() {
    if (!puzzle) return;
    var s = boardSize(puzzle.aspect), P = puzzle;
    P.W = s.W; P.H = s.H; P.trayH = Math.round(s.H * TRAY_RATIO);
    els.area.style.width = s.W + 'px'; els.area.style.height = (s.H + P.trayH + 12) + 'px';
    els.board.style.width = s.W + 'px'; els.board.style.height = s.H + 'px';
    var c = cover(P.pic.w, P.pic.h, s.W, s.H);
    P.pieces.forEach(function (p) {
      var h = home(p.i, P.cols, P.rows, s.W, s.H);
      p.home = h;
      p.node.style.width = h.w + 'px'; p.node.style.height = h.h + 'px';
      p.node.style.backgroundSize = c.w + 'px ' + c.h + 'px';
      p.node.style.backgroundPosition = (c.x - h.x) + 'px ' + (c.y - h.y) + 'px';
      var at = p.locked ? h : { x: p.fx * s.W, y: p.fy * s.W };       // free pieces keep their place as fractions of the board's width
      p.node.style.left = at.x + 'px'; p.node.style.top = at.y + 'px';
    });
    els.ghost.style.backgroundImage = 'url("' + P.pic.url + '")';
    els.ghost.style.backgroundSize = c.w + 'px ' + c.h + 'px'; els.ghost.style.backgroundPosition = c.x + 'px ' + c.y + 'px';
  }
  // Inside Zimi the game's own bar is hidden, and a bar that held only the clock was an empty band under Zimi's header:
  // there the clock joins the status line ("3 of 20 placed · 0:42") and the bar goes.
  var clockInLine = !!(window.ZimiShell && ZimiShell.hosted);
  if (clockInLine) { els.time.classList.remove('ar-stat'); els.time.hidden = true; }
  function paintClock() {
    var clock = puzzle ? Play.fmtClock(elapsed()) : '0:00';
    els.time.textContent = clock;
    if (clockInLine && puzzle && !puzzle.done) paintLine(clock);
  }
  function paintLine(clock) {
    var n = puzzle.pieces.filter(function (p) { return p.locked; }).length, text = T('jigsaw.placed', { n: n, total: puzzle.pieces.length });
    line.say(clock && ZimiShell.settings.get('timer') !== 'hide' ? text + ' \u00b7 ' + clock : text);
  }
  function paintHud() {
    paintClock();
    if (!clockInLine && puzzle && !puzzle.done) paintLine();
  }
  function elapsed() { return puzzle.ms + (puzzle.since ? performance.now() - puzzle.since : 0); }
  function pause() { if (puzzle && puzzle.since) { puzzle.ms += performance.now() - puzzle.since; puzzle.since = 0; } }
  function resume() { if (puzzle && !puzzle.done && !puzzle.since) puzzle.since = performance.now(); }
  Play.onHidden(pause);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });

  function build(pic, count, daily) {
    var aspect = clampAspect(pic.w / pic.h), g = gridFor(count, aspect), rng = Math.random;
    var s = boardSize(aspect), pieces = [];
    var tray = { x: 0, y: s.H + 12, w: s.W, h: Math.round(s.H * TRAY_RATIO) };
    var starts = scatter(g.cols * g.rows, tray, s.W / g.cols, s.H / g.rows, rng);
    for (var i = 0; i < g.cols * g.rows; i++) {
      var node = el('div', 'jg-piece'); node.dataset.i = i; node.style.backgroundImage = 'url("' + pic.url + '")';
      node.style.zIndex = 1 + Math.floor(rng() * 5);
      els.area.appendChild(node);
      pieces.push({ i: i, node: node, locked: false, fx: starts[i].x / s.W, fy: starts[i].y / s.W });
    }
    say('');
    puzzle = { pic: pic, count: count, cols: g.cols, rows: g.rows, aspect: aspect, pieces: pieces, ms: 0, since: performance.now(), done: false, daily: daily };
    layout(); paintHud();
    els.credit.textContent = T('jigsaw.picture', { credit: pic.credit }) + (pic.note ? ' ' + pic.note : '');
    els.read.hidden = !pic.path;   // the picture's article, at hand while playing and on the end sheet
    if (pic.path) Lib.articleLink(els.read, pic.zim, pic.path);
    if (!timer) timer = setInterval(function () { if (puzzle && puzzle.since && !puzzle.done) paintClock(); }, TICK_MS);
  }

  function newPuzzle(count, daily) {
    pause(); puzzle = null; paintHud(); els.area.classList.remove('whole');
    els.area.querySelectorAll('.jg-piece').forEach(function (n) { n.parentNode.removeChild(n); });
    els.ghost.style.backgroundImage = 'none';
    say(T('jigsaw.finding'));
    return getPicture(daily).then(function (pic) { say(''); build(pic, count, daily); });
  }

  // ── dragging ──
  var drag = null;
  els.area.addEventListener('pointerdown', function (e) {
    var node = e.target.closest('.jg-piece');
    if (!node || !puzzle || puzzle.done) return;
    var p = puzzle.pieces[+node.dataset.i];
    if (p.locked) return;
    var r = els.area.getBoundingClientRect();
    drag = { p: p, dx: e.clientX - r.left - parseFloat(node.style.left), dy: e.clientY - r.top - parseFloat(node.style.top), id: e.pointerId };
    node.style.zIndex = ++z; node.classList.add('lifted');
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    e.preventDefault();
  });
  els.area.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var r = els.area.getBoundingClientRect(), P = puzzle;
    var x = Math.min(Math.max(-P.W * 0.02, e.clientX - r.left - drag.dx), P.W - drag.p.home.w * 0.98);
    var y = Math.min(Math.max(-P.H * 0.02, e.clientY - r.top - drag.dy), P.H + P.trayH + 12 - drag.p.home.h * 0.98);
    drag.p.node.style.left = x + 'px'; drag.p.node.style.top = y + 'px';
  });
  function drop(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var p = drag.p, x = parseFloat(p.node.style.left), y = parseFloat(p.node.style.top);
    drag = null; p.node.classList.remove('lifted');
    if (snaps(x, y, p.home)) lock(p);
    else { p.fx = x / puzzle.W; p.fy = y / puzzle.W; }
  }
  els.area.addEventListener('pointerup', drop);
  els.area.addEventListener('pointercancel', drop);

  function lock(p) {
    p.locked = true; p.node.classList.add('locked'); p.node.style.zIndex = 0;
    p.node.style.left = p.home.x + 'px'; p.node.style.top = p.home.y + 'px';
    paintHud();
    if (solved(puzzle.pieces)) finish();
  }
  function finish() {
    pause(); puzzle.done = true; paintHud();
    els.area.classList.add('whole');   // the picture lifts and the seams fade
    var key = (zim || 'drawn') + ':' + puzzle.pieces.length, best = Play.load(BEST_KEY, {}), ms = Math.round(puzzle.ms);
    var newBest = !best[key] || ms < best[key];
    if (newBest) { best[key] = ms; Play.save(BEST_KEY, best); }
    var more = [];
    if (puzzle.pic.path) {
      var read = el('a', 'ar-btn'); read.textContent = T('jigsaw.read');
      more.push(Lib.articleLink(read, puzzle.pic.zim, puzzle.pic.path));
    }
    line.say(T('jigsaw.done'));
    ZimiShell.endSheet({
      result: 'win', after: Play.reducedMotion() ? 0 : SNAP_MS * 2,
      text: T('jigsaw.picture', { credit: puzzle.pic.credit }), extra: more,
      stats: [[T('play.time'), Play.fmtClock(ms)], [T('play.best'), Play.fmtClock(newBest ? ms : best[key])]]
    });
  }

  // The look at the finished picture, while pressed.
  function peek(on) { els.board.classList.toggle('peek', on); }
  els.peek.addEventListener('pointerdown', function () { peek(true); });
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (ev) { els.peek.addEventListener(ev, function () { peek(false); }); });
  els.peek.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); peek(true); } });
  els.peek.addEventListener('keyup', function () { peek(false); });

  // ── New game: the pieces and the picture are choices about the game, so they sit in the New game pane ──
  els.newBtn.addEventListener('click', function () {
    var choice = pending || prefs; pending = null;
    prefs.count = choice.count; prefs.today = choice.today;
    Play.save(PREFS_KEY, prefs);
    newPuzzle(prefs.count, !!prefs.today && !!zim);
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'pictures', zim); },
    inProgress: function () { return !!puzzle && !puzzle.done && puzzle.pieces.some(function (p) { return p.locked; }); },
    menu: function () {
      var now = pending || { count: prefs.count, today: prefs.today }, rows = [];
      rows.push(Play.optionRow(T('jigsaw.pieces'), COUNTS.map(function (n) { return [n, Play.num(n)]; }), now.count, function (v) { pending = { count: v, today: now.today }; now = pending; }));
      if (zim) rows.push(Play.optionRow(T('jigsaw.pictureOf'), [[false, T('jigsaw.random')], [true, T('jigsaw.today')]], !!now.today, function (v) { pending = { count: now.count, today: v }; now = pending; }));
      return { options: rows };
    },
    stats: function () {
      var best = Play.load(BEST_KEY, {});
      return Object.keys(best).map(function (k) { return [T('jigsaw.bestOf', { n: +k.split(':')[1] }), Play.fmtClock(best[k])]; });
    }
  });
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120); });

  Lib.library().then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
    if (a) { zim = a.zim.name; zimTitle = (a.zim.title || a.zim.name) + ' (' + a.zim.language + ')'; }
    // Leaving and coming back keeps the puzzle: its picture, every piece where it was left, and the clock.
    var kept = ZimiShell.saved();
    if (kept && kept.pic && kept.pieces && (!kept.daily || kept.date === today)) return restore(kept);
    if (kept) ZimiShell.forget();
    return newPuzzle(prefs.count, false);
  });
  function restore(kept) {
    build(kept.pic, kept.count, kept.daily);
    puzzle.ms = kept.ms || 0; puzzle.since = 0;
    kept.pieces.forEach(function (k, i) {
      var p = puzzle.pieces[i]; if (!p) return;
      p.fx = k.fx; p.fy = k.fy; p.locked = !!k.locked;
      if (p.locked) { p.node.classList.add('locked'); p.node.style.zIndex = 0; }
    });
    layout(); paintHud();
    if (solved(puzzle.pieces)) finish(); else resume();
  }
  ZimiShell.persist({
    save: function () {
      if (!puzzle) return null;
      return { pic: puzzle.pic, count: puzzle.count, daily: !!puzzle.daily, date: today, ms: Math.round(elapsed()),
        pieces: puzzle.pieces.map(function (p) { return { fx: p.fx, fy: p.fy, locked: p.locked }; }) };
    }
  });
  root.__jig = { get puzzle() { return puzzle; } };
})(this);
