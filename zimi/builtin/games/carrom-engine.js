/* ZimiGames: the Carrom engine. Our own code, GPL-3.0. No network, no modules.
   One self-contained function (a Worker is built from its source). It holds a small physics world (a square board
   740 units on a side, round coins and a striker that collide, slide with friction and drop into the four corner
   pockets), the rules of a turn (own coins pocketed give another shot, the striker pocketed is a foul, the queen has to
   be covered by pocketing one of your own coins on the same or the next shot, you may not pocket your last coin while
   the queen is still on the board), and a computer that picks sensible shots by trying them in the same physics. */
function ZimiCarromEngine() {
  'use strict';

  var B = 740, COIN_R = 15.5, STRIKER_R = 20.5, POCKET_CAPTURE = 25, POCKET_INSET = 18;
  var COIN_MASS = 1, STRIKER_MASS = 2.4, E_COIN = 0.92, E_WALL = 0.72;
  var DRAG = 1.5, DECEL = 55, STOP_SPEED = 9, DT = 1 / 240, MAX_SPEED = 2600, MAX_STEPS = 6000;
  var BASE_Y = [B - 112, 112], BASE_X0 = 132, BASE_X1 = B - 132;   // the two baselines: player 0 at the bottom, player 1 at the top
  var POCKETS = [[POCKET_INSET, POCKET_INSET], [B - POCKET_INSET, POCKET_INSET], [POCKET_INSET, B - POCKET_INSET], [B - POCKET_INSET, B - POCKET_INSET]];
  var CENTRE = B / 2;
  var COINS_EACH = 9;
  var LEVELS = { easy: { aim: 0.09, power: 0.25, tries: 3, keep: 2 }, medium: { aim: 0.032, power: 0.12, tries: 8, keep: 5 }, hard: { aim: 0.01, power: 0.05, tries: 24, keep: 10 } };

  // ── the world ──
  function body(id, kind, x, y) {
    var s = kind === 's';
    return { id: id, kind: kind, x: x, y: y, vx: 0, vy: 0, r: s ? STRIKER_R : COIN_R, m: s ? STRIKER_MASS : COIN_MASS, alive: true };
  }
  function layout() {
    var list = [], id = 0, ring;
    list.push(body(id++, 'q', CENTRE, CENTRE));
    // six coins touching the queen, alternating colours; twelve outside them, alternating again
    for (ring = 0; ring < 6; ring++) { var a = ring * Math.PI / 3 + Math.PI / 2; list.push(body(id++, ring % 2 ? 'b' : 'w', CENTRE + Math.cos(a) * (2 * COIN_R + 0.6), CENTRE + Math.sin(a) * (2 * COIN_R + 0.6))); }
    for (ring = 0; ring < 12; ring++) {
      var a2 = ring * Math.PI / 6 + Math.PI / 2, rad = ring % 2 === 0 ? 4 * COIN_R + 1.2 : Math.sqrt(3) * 2 * COIN_R + 0.8;
      list.push(body(id++, ring % 2 ? 'b' : 'w', CENTRE + Math.cos(a2) * rad, CENTRE + Math.sin(a2) * rad));
    }
    return list;
  }
  function newGame() {
    var bodies = layout();
    return { bodies: bodies, striker: body(99, 's', CENTRE, BASE_Y[0]), turn: 0, own: ['w', 'b'], pendingQueen: -1, queenBy: -1, over: false, winner: -1, shots: 0 };
  }
  function cloneGame(g) {
    return { bodies: g.bodies.map(function (b) { return Object.assign({}, b); }), striker: Object.assign({}, g.striker), turn: g.turn, own: g.own.slice(), pendingQueen: g.pendingQueen, queenBy: g.queenBy, over: g.over, winner: g.winner, shots: g.shots };
  }
  function allBodies(g) { return g.bodies.concat([g.striker]); }
  function remaining(g, kind) { return g.bodies.filter(function (b) { return b.kind === kind && b.alive; }).length; }
  function queenOnBoard(g) { return g.bodies.some(function (b) { return b.kind === 'q' && b.alive; }); }

  function speedOf(b) { return Math.sqrt(b.vx * b.vx + b.vy * b.vy); }
  function moving(g) { var list = allBodies(g); for (var i = 0; i < list.length; i++) if (list[i].alive && (list[i].vx || list[i].vy)) return true; return false; }

  // One small step; returns the bodies that dropped into a pocket during it.
  function step(g, dt) {
    var list = allBodies(g), i, j, dropped = [];
    for (i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.alive) continue;
      var sp = speedOf(b);
      if (sp > 0) {
        var ns = sp * Math.exp(-DRAG * dt) - DECEL * dt;
        if (ns < STOP_SPEED) { b.vx = b.vy = 0; } else { var k = ns / sp; b.vx *= k; b.vy *= k; }
      }
      b.x += b.vx * dt; b.y += b.vy * dt;
      for (j = 0; j < 4; j++) {
        var px = POCKETS[j][0] - b.x, py = POCKETS[j][1] - b.y;
        if (px * px + py * py < POCKET_CAPTURE * POCKET_CAPTURE) { b.alive = false; b.vx = b.vy = 0; dropped.push(b); break; }
      }
      if (!b.alive) continue;
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * E_WALL; } else if (b.x > B - b.r) { b.x = B - b.r; b.vx = -Math.abs(b.vx) * E_WALL; }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * E_WALL; } else if (b.y > B - b.r) { b.y = B - b.r; b.vy = -Math.abs(b.vy) * E_WALL; }
    }
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a.alive) continue;
        for (j = i + 1; j < list.length; j++) {
          var c = list[j];
          if (!c.alive) continue;
          var dx = c.x - a.x, dy = c.y - a.y, min = a.r + c.r, d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          var d = Math.sqrt(d2) || 0.0001, nx = dx / d, ny = dy / d, overlap = min - d, wa = 1 / a.m, wc = 1 / c.m;
          a.x -= nx * overlap * wa / (wa + wc); a.y -= ny * overlap * wa / (wa + wc);
          c.x += nx * overlap * wc / (wa + wc); c.y += ny * overlap * wc / (wa + wc);
          var vn = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
          if (vn > 0) {
            var imp = (1 + E_COIN) * vn / (wa + wc);
            a.vx -= imp * wa * nx; a.vy -= imp * wa * ny;
            c.vx += imp * wc * nx; c.vy += imp * wc * ny;
          }
        }
      }
    }
    return dropped;
  }

  // Put the striker on its baseline: x is clamped into the allowed stretch and nudged off any coin it would overlap.
  function baselineFree(g, x, p) {
    var y = BASE_Y[p];
    return !g.bodies.some(function (b) { return b.alive && Math.hypot(b.x - x, b.y - y) < b.r + STRIKER_R + 0.5; });
  }
  function placeStriker(g, x, p) {
    p = p === undefined ? g.turn : p;
    x = Math.max(BASE_X0, Math.min(BASE_X1, x));
    if (!baselineFree(g, x, p)) {
      var best = null, step_ = 2;
      for (var d = step_; d <= BASE_X1 - BASE_X0; d += step_) {
        if (x - d >= BASE_X0 && baselineFree(g, x - d, p)) { best = x - d; break; }
        if (x + d <= BASE_X1 && baselineFree(g, x + d, p)) { best = x + d; break; }
      }
      if (best === null) best = x;
      x = best;
    }
    g.striker.x = x; g.striker.y = BASE_Y[p]; g.striker.vx = g.striker.vy = 0; g.striker.alive = true;
    return x;
  }
  // Hit the striker: angle in radians (0 along +x, screen coordinates), speed in board units per second.
  function shoot(g, angle, speed) {
    var v = Math.max(0, Math.min(MAX_SPEED, speed));
    g.striker.vx = Math.cos(angle) * v; g.striker.vy = Math.sin(angle) * v;
  }

  // Run the world until everything is still. Returns the bodies pocketed, in order.
  function run(g, maxSteps) {
    var dropped = [], n = 0, limit = maxSteps || MAX_STEPS;
    while (moving(g) && n++ < limit) { var d = step(g, DT); for (var i = 0; i < d.length; i++) dropped.push(d[i]); }
    return dropped;
  }

  // ── the rules of a turn ──
  // After a shot: who plays next, what happened. `dropped` is every body that fell in. Mutates the game.
  function settle(g, dropped) {
    var p = g.turn, mine = g.own[p], notes = [], foul = false, ownDown = 0, theirDown = 0, queenDown = false, i;
    g.shots++;
    dropped.forEach(function (b) {
      if (b.kind === 's') foul = true;
      else if (b.kind === 'q') queenDown = true;
      else if (b.kind === mine) ownDown++;
      else theirDown++;
    });
    var covering = g.pendingQueen === p;
    if (foul) {
      notes.push('striker');
      // the striker comes back; a coin of the shooter's that is already down goes back to the centre
      if (queenDown) { returnToCentre(g, 'q'); queenDown = false; notes.push('queen back'); }
      if (covering) { returnToCentre(g, 'q'); g.pendingQueen = -1; g.queenBy = -1; notes.push('queen back'); }
      var down = g.bodies.filter(function (b) { return b.kind === mine && !b.alive; });
      if (down.length) { revive(g, down[0]); notes.push('coin back'); }
      return finish(g, p, false, notes);
    }
    if (queenDown) {
      if (ownDown > 0) { g.queenBy = p; g.pendingQueen = -1; notes.push('queen covered'); }
      else { g.pendingQueen = p; notes.push('queen down'); }
    } else if (covering) {
      if (ownDown > 0) { g.queenBy = p; g.pendingQueen = -1; notes.push('queen covered'); }
      else { returnToCentre(g, 'q'); g.pendingQueen = -1; notes.push('queen back'); return finish(g, p, false, notes); }
    }
    if (ownDown) notes.push('own ' + ownDown);
    if (theirDown) notes.push('theirs ' + theirDown);
    // nobody may clear their side while the queen is still on the board: the last coin comes back
    for (i = 0; i < 2; i++) {
      var colour = g.own[i];
      if (remaining(g, colour) !== 0) continue;
      if (queenOnBoard(g)) {
        var lastIn = dropped.filter(function (b) { return b.kind === colour; })[0];
        if (lastIn) { revive(g, lastIn); notes.push('last coin back'); if (i === p) ownDown--; }
      } else if (!g.over) { g.over = true; g.winner = i; }
    }
    return finish(g, p, ownDown > 0 || g.pendingQueen === p, notes);
  }
  function finish(g, p, again, notes) {
    g.turn = again ? p : 1 - p;
    return { next: g.turn, again: again, notes: notes, over: g.over, winner: g.winner };
  }
  function freeSpotNear(g, x, y, r) {
    var spots = [[x, y]], i;
    for (var ring = 1; ring < 14; ring++) for (i = 0; i < 12; i++) { var a = i * Math.PI / 6; spots.push([x + Math.cos(a) * ring * 2 * r * 0.9, y + Math.sin(a) * ring * 2 * r * 0.9]); }
    for (i = 0; i < spots.length; i++) {
      var s = spots[i];
      if (s[0] < r || s[0] > B - r || s[1] < r || s[1] > B - r) continue;
      if (!allBodies(g).some(function (b) { return b.alive && Math.hypot(b.x - s[0], b.y - s[1]) < b.r + r + 0.5; })) return s;
    }
    return [x, y];
  }
  function revive(g, b) { var s = freeSpotNear(g, CENTRE, CENTRE, b.r); b.x = s[0]; b.y = s[1]; b.vx = b.vy = 0; b.alive = true; }
  function returnToCentre(g, kind) { g.bodies.forEach(function (b) { if (b.kind === kind && !b.alive) revive(g, b); }); }

  // ── the computer ──
  function pathClear(g, ax, ay, bx, by, r, skip) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    return !g.bodies.some(function (o) {
      if (!o.alive || o === skip) return false;
      var t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.y - ay) * dy) / len2)), cx = ax + dx * t - o.x, cy = ay + dy * t - o.y;
      return cx * cx + cy * cy < (o.r + r) * (o.r + r);
    });
  }
  // A scoring of what a simulated shot did, for the player p.
  function outcome(g, p, dropped) {
    var mine = g.own[p], s = 0;
    dropped.forEach(function (b) {
      if (b.kind === 's') s -= 60;
      else if (b.kind === 'q') s += g.pendingQueen === p ? 0 : 14;
      else if (b.kind === mine) s += 30;
      else s -= 18;
    });
    if (dropped.some(function (b) { return b.kind === mine; })) s += 6;
    return s;
  }
  function candidateShots(g, p) {
    var mine = g.own[p], out = [], xs = [], x;
    for (x = BASE_X0; x <= BASE_X1; x += (BASE_X1 - BASE_X0) / 14) xs.push(x);
    var targets = g.bodies.filter(function (b) { return b.alive && (b.kind === mine || (b.kind === 'q' && (g.pendingQueen === -1))); });
    xs.forEach(function (sx) {
      if (!baselineFree(g, sx, p)) return;
      var sy = BASE_Y[p];
      targets.forEach(function (t) {
        POCKETS.forEach(function (pk) {
          var tx = pk[0] - t.x, ty = pk[1] - t.y, tl = Math.hypot(tx, ty);
          if (tl < 1) return;
          tx /= tl; ty /= tl;
          var gx = t.x - tx * (t.r + STRIKER_R), gy = t.y - ty * (t.r + STRIKER_R);
          var ax = gx - sx, ay = gy - sy, al = Math.hypot(ax, ay);
          if (al < 1) return;
          var cut = Math.acos(Math.max(-1, Math.min(1, (ax * tx + ay * ty) / al)));
          if (cut > 1.15) return;
          if (!pathClear(g, sx, sy, gx, gy, STRIKER_R, t) || !pathClear(g, t.x, t.y, pk[0], pk[1], t.r, t)) return;
          out.push({ x: sx, angle: Math.atan2(ay, ax), dist: al + tl, cut: cut, kind: t.kind });
        });
      });
    });
    out.sort(function (a, b) { return (a.cut * 260 + a.dist * 0.25 + (a.kind === 'q' ? 25 : 0)) - (b.cut * 260 + b.dist * 0.25 + (b.kind === 'q' ? 25 : 0)); });
    return out;
  }
  function powerFor(c) { return Math.min(MAX_SPEED, 520 + (c.dist) * 1.9 * (1 + c.cut)); }
  // The shot the computer takes: { x, angle, speed }.
  function chooseShot(g, p, level, rnd) {
    rnd = rnd || Math.random;
    var cfg = LEVELS[level] || LEVELS.medium, cands = candidateShots(g, p).slice(0, cfg.keep), best = null, bestScore = -Infinity;
    cands.slice(0, cfg.tries).forEach(function (c) {
      [0.85, 1, 1.25].forEach(function (mult) {
        var sim = cloneGame(g);
        placeStriker(sim, c.x, p);
        var speed = Math.min(MAX_SPEED, powerFor(c) * mult);
        shoot(sim, c.angle, speed);
        var dropped = run(sim, 3500), sc = outcome(g, p, dropped) - c.cut * 4 + (rnd() - 0.5) * 6;
        if (sc > bestScore) { bestScore = sc; best = { x: c.x, angle: c.angle, speed: speed }; }
      });
    });
    if (!best || bestScore < 0) {
      // nothing good to try: a quiet shot into the middle that is unlikely to hurt
      var sx = BASE_X0 + rnd() * (BASE_X1 - BASE_X0), fall = best && bestScore > -20 ? best : null;
      if (fall) best = fall;
      else { best = { x: sx, angle: Math.atan2(CENTRE - BASE_Y[p], CENTRE - sx) + (rnd() - 0.5) * 0.12, speed: 1300 + rnd() * 500 }; }   // no shot at a coin: break the pack
    }
    return { x: best.x, angle: best.angle + (rnd() - 0.5) * 2 * cfg.aim, speed: best.speed * (1 + (rnd() - 0.5) * 2 * cfg.power) };
  }
  function handle(req) {
    var g = req.game, shot = chooseShot(g, req.player, req.level);
    return shot;
  }

  return {
    B: B, COIN_R: COIN_R, STRIKER_R: STRIKER_R, POCKET_CAPTURE: POCKET_CAPTURE, POCKETS: POCKETS, BASE_Y: BASE_Y, BASE_X0: BASE_X0, BASE_X1: BASE_X1, MAX_SPEED: MAX_SPEED, DT: DT, CENTRE: CENTRE, COINS_EACH: COINS_EACH, LEVELS: LEVELS,
    newGame: newGame, cloneGame: cloneGame, allBodies: allBodies, remaining: remaining, queenOnBoard: queenOnBoard, moving: moving, step: step, run: run,
    placeStriker: placeStriker, baselineFree: baselineFree, shoot: shoot, settle: settle, candidateShots: candidateShots, chooseShot: chooseShot, handle: handle, speedOf: speedOf
  };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiCarromEngine = ZimiCarromEngine;
