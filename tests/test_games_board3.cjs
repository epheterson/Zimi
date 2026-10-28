// ZimiGames world board games, part three: Janggi, Makruk, International draughts, Hnefatafl, the Royal Game of Ur,
// Snakes and Ladders, Carrom and four-player Mahjong. The rules with no DOM: perft counts checked against a
// second, independently written move generator, the special moves each game is known for, and self-played games
// that show the computer only ever makes legal moves.
//
// Run: node tests/test_games_board3.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = {};
  vm.createContext(sandbox);
  [].concat(files).forEach(file => vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), sandbox, { filename: file }));
  return sandbox;
}
const seeded = seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortNum = list => list.slice().sort((a, b) => a - b);

// ── Janggi ──
{
  const sb = load(['enginekit.js', 'janggi-engine.js']);
  const E = sb.ZimiJanggiEngine(sb.ZimiSearch());
  const at = (r, f) => r * 9 + f;
  const movesOf = (pos, r, f) => E.legalMoves(pos).filter(m => E.from(m) === at(r, f)).map(m => E.to(m));

  // The independent generator: x is the file, y the rank counted from Cho's side (Cho at the bottom, y = 0),
  // the palace diagonals are an explicit list of edges, and every piece is written out on its own.
  const key = (x, y) => x + ',' + y;
  const palaceEdges = {};
  const link = (a, b) => { (palaceEdges[a] = palaceEdges[a] || []).push(b); (palaceEdges[b] = palaceEdges[b] || []).push(a); };
  [[1, 0, 2], [8, 7, 9]].forEach(([cy, lo, hi]) => [[3, lo], [5, lo], [3, hi], [5, hi]].forEach(([cx, cyy]) => link(key(4, cy), key(cx, cyy))));
  const inPal = (c, x, y) => x >= 3 && x <= 5 && (c > 0 ? y >= 0 && y <= 2 : y >= 7 && y <= 9);
  function fromPos(pos) {
    const b = new Map();
    for (let s = 0; s < 90; s++) if (pos.sq[s]) b.set(key(s % 9, 9 - Math.floor(s / 9)), { c: Math.sign(pos.sq[s]), t: Math.abs(pos.sq[s]) });
    return b;
  }
  function pseudo(b, color) {
    const out = [], get = (x, y) => b.get(key(x, y)), ok = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const push = (x, y, tx, ty) => { const o = get(tx, ty); if (!o || o.c !== color) out.push([x, y, tx, ty]); };
    for (const [k, p] of b) {
      if (p.c !== color) continue;
      const [x, y] = k.split(',').map(Number), nb = (palaceEdges[k] || []).map(q => q.split(',').map(Number));
      if (p.t === 3) {
        for (const [dx, dy] of dirs) for (let tx = x + dx, ty = y + dy; ok(tx, ty); tx += dx, ty += dy) { push(x, y, tx, ty); if (get(tx, ty)) break; }
        for (const [qx, qy] of nb) {   // follow the diagonal line on in the same direction
          let px = x, py = y, cx = qx, cy = qy;
          for (;;) {
            push(x, y, cx, cy); if (get(cx, cy)) break;
            const dx = cx - px, dy = cy - py, nx = cx + dx, ny = cy + dy;
            if (!(palaceEdges[key(cx, cy)] || []).includes(key(nx, ny))) break;
            px = cx; py = cy; cx = nx; cy = ny;
          }
        }
      } else if (p.t === 2) {
        const jump = (dx, dy, step) => {
          let cx = x + dx, cy = y + dy;
          while (ok(cx, cy) && !get(cx, cy)) { cx += dx; cy += dy; step && 0; }
          return [cx, cy];
        };
        for (const [dx, dy] of dirs) {
          const [sx, sy] = jump(dx, dy);
          if (!ok(sx, sy) || get(sx, sy).t === 2) continue;
          for (let tx = sx + dx, ty = sy + dy; ok(tx, ty); tx += dx, ty += dy) {
            const o = get(tx, ty);
            if (!o) { out.push([x, y, tx, ty]); continue; }
            if (o.c !== color && o.t !== 2) out.push([x, y, tx, ty]);
            break;
          }
        }
        for (const [qx, qy] of nb) {   // over the one point between two palace corners
          const scr = get(qx, qy), dx = qx - x, dy = qy - y, tx = qx + dx, ty = qy + dy;
          if (!scr || scr.t === 2 || !(palaceEdges[key(qx, qy)] || []).includes(key(tx, ty))) continue;
          const o = get(tx, ty);
          if (!o || (o.c !== color && o.t !== 2)) out.push([x, y, tx, ty]);
        }
      } else if (p.t === 4) {
        for (const [dx, dy] of dirs) {
          if (!ok(x + dx, y + dy) || get(x + dx, y + dy)) continue;
          const side = dx ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
          for (const [ex, ey] of side) { const tx = x + 2 * dx + ex, ty = y + 2 * dy + ey; if (ok(tx, ty)) push(x, y, tx, ty); }
        }
      } else if (p.t === 5) {
        for (const [dx, dy] of dirs) {
          const side = dx ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
          for (const [ex, ey] of side) {
            const l1 = [x + dx, y + dy], l2 = [x + 2 * dx + ex, y + 2 * dy + ey], tx = x + 3 * dx + 2 * ex, ty = y + 3 * dy + 2 * ey;
            if (!ok(tx, ty) || get(...l1) || get(...l2)) continue;
            push(x, y, tx, ty);
          }
        }
      } else if (p.t === 6 || p.t === 7) {
        for (const [dx, dy] of dirs) if (inPal(color, x + dx, y + dy)) push(x, y, x + dx, y + dy);
        for (const [qx, qy] of nb) if (inPal(color, qx, qy)) push(x, y, qx, qy);
      } else {
        const f = color > 0 ? 1 : -1;
        [[0, f], [1, 0], [-1, 0]].forEach(([dx, dy]) => { if (ok(x + dx, y + dy)) push(x, y, x + dx, y + dy); });
        for (const [qx, qy] of nb) if (qy - y === f && inPal(-color, x, y)) push(x, y, qx, qy);
      }
    }
    return out;
  }
  function legal(b, color) {
    const attackedKing = (bb) => {
      let ks = null;
      for (const [k, p] of bb) if (p.c === color && p.t === 7) ks = k;
      return pseudo(bb, -color).some(m => key(m[2], m[3]) === ks);
    };
    return pseudo(b, color).filter(m => {
      const bb = new Map(b), mover = bb.get(key(m[0], m[1]));
      bb.delete(key(m[0], m[1])); bb.set(key(m[2], m[3]), mover);
      return !attackedKing(bb);
    });
  }
  const canon = list => list.map(m => m.join(',')).sort();
  const engineMoves = pos => E.legalMoves(pos).map(m => [E.from(m) % 9, 9 - Math.floor(E.from(m) / 9), E.to(m) % 9, 9 - Math.floor(E.to(m) / 9)]);
  function indPerft(b, color, depth) {
    const ms = legal(b, color);
    if (depth === 1) return ms.length;
    let n = 0;
    for (const m of ms) {
      const bb = new Map(b); bb.set(key(m[2], m[3]), bb.get(key(m[0], m[1]))); bb.delete(key(m[0], m[1]));
      n += indPerft(bb, -color, depth - 1);
    }
    return n;
  }

  const start = E.startPosition();
  const p1 = E.perft(start, 1), p2 = E.perft(start, 2);
  check(p1 === indPerft(fromPos(start), 1, 1) && p1 > 0, 'janggi: perft 1 from the start agrees with the independent generator (' + p1 + ')');
  check(p2 === indPerft(fromPos(start), 1, 2), 'janggi: perft 2 from the start agrees with the independent generator (' + p2 + ')');
  if (!same(canon(engineMoves(start)), canon(legal(fromPos(start), 1)))) { const a = canon(engineMoves(start)), b = canon(legal(fromPos(start), 1)); console.error('only engine', a.filter(x => !b.includes(x)), 'only independent', b.filter(x => !a.includes(x))); }
  check(same(canon(engineMoves(start)), canon(legal(fromPos(start), 1))), 'janggi: the same 1-ply moves, not just the same count');
  check(E.toFen(start) === E.START_FEN, 'janggi: the start position round-trips through its FEN');

  // The two generators agree at every position of random games, which reaches palaces, cannons and elephants.
  {
    const rng = seeded(7);
    let positions = 0, disagree = 0;
    for (let g = 0; g < 40; g++) {
      const pos = E.startPosition();
      for (let ply = 0; ply < 90; ply++) {
        const ms = E.legalMoves(pos);
        positions++;
        if (!same(canon(engineMoves(pos)), canon(legal(fromPos(pos), pos.turn)))) { disagree++; break; }
        if (!ms.length) break;
        E.make(pos, ms[Math.floor(rng() * ms.length)]);
      }
    }
    check(disagree === 0 && positions > 1500, 'janggi: both generators agree at ' + positions + ' positions of random games');
  }

  // Palace rules, one by one. FEN rows run from Han's back rank (top) down; capitals are Cho.
  const fen = rows => rows.join('/');
  const mv = (f, r, c) => sortNum(movesOf(E.parseFen(f), r, c));
  const P = (r, c) => at(r, c);
  check(same(mv('5k3/9/9/9/9/9/9/9/9/3K5 w', 9, 3), sortNum([P(9, 4), P(8, 3), P(8, 4)])), 'janggi: a general in a palace corner steps straight or along the diagonal to the middle');
  check(mv('5k3/9/9/9/9/9/9/9/4K4/9 w', 8, 4).length === 8, 'janggi: a general in the middle of the palace has eight steps');
  check(!mv('5k3/9/9/9/9/9/9/9/9/3K5 w', 9, 3).includes(P(7, 5)), 'janggi: a general steps one point only, never the whole diagonal');
  let m = mv('5k3/9/9/9/9/9/9/9/9/3RK4 w', 9, 3);
  check(m.includes(P(8, 4)) && m.includes(P(7, 5)) && !m.includes(P(6, 6)), 'janggi: a chariot follows the palace diagonal to the far corner and stops at the palace edge');
  m = mv('5k3/9/9/9/9/9/9/9/4P4/3RK4 w', 9, 3);
  check(!m.includes(P(8, 4)) && !m.includes(P(7, 5)), 'janggi: a piece on the middle of the palace blocks a chariot\'s diagonal');
  m = mv('5k3/9/9/9/9/9/9/9/4P4/3CK4 w', 9, 3);
  check(m.includes(P(7, 5)), 'janggi: a cannon jumps the palace middle to the far corner');
  m = mv('5k3/9/9/9/9/9/9/9/4c4/3CK4 w', 9, 3);
  check(!m.includes(P(7, 5)), 'janggi: a cannon cannot jump a cannon on the palace middle');

  // Cannons must jump exactly one piece, never a cannon, and never capture one.
  check(mv('5k3/9/9/9/9/9/9/1C7/9/5K3 w', 7, 1).length === 0, 'janggi: a cannon with nothing to jump cannot move at all');
  check(mv('5k3/9/9/9/9/1c7/9/1C7/9/5K3 w', 7, 1).length === 0, 'janggi: a cannon cannot jump over or capture a cannon');
  check(same(mv('5k3/9/9/9/9/1p7/1r7/1C7/9/5K3 w', 7, 1), [P(5, 1)]), 'janggi: a cannon jumps one piece and captures the next');
  check(mv('5k3/9/9/9/9/1c7/1r7/1C7/9/5K3 w', 7, 1).length === 0, 'janggi: a cannon jumps a piece but still cannot capture a cannon behind it');
  check(same(mv('5k3/9/9/9/9/9/1r7/1C7/9/5K3 w', 7, 1), sortNum([P(5, 1), P(4, 1), P(3, 1), P(2, 1), P(1, 1), P(0, 1)])), 'janggi: after its jump a cannon may land on any empty point in line');
  check(mv('5k3/9/9/9/9/1p7/1r7/1C7/9/5K3 w', 7, 1).length === 1, 'janggi: a cannon cannot jump two pieces');

  // Elephants step one straight and two across; a blocked point on the way stops them.
  m = mv('5k3/9/9/9/9/9/9/4E4/9/5K3 w', 7, 4);
  check(m.length === 6 && m.includes(P(4, 2)) && m.includes(P(5, 7)) && m.includes(P(9, 1)), 'janggi: an elephant jumps three by two, across the river too');
  check(same(mv('5k3/9/9/9/9/9/4P4/4E4/9/5K3 w', 7, 4), sortNum([P(5, 1), P(5, 7), P(9, 1), P(9, 7)])), 'janggi: a piece on the elephant\'s straight step blocks both ways that way');
  m = mv('5k3/9/9/9/9/3p5/9/4E4/9/5K3 w', 7, 4);
  check(m.length === 5 && !m.includes(P(4, 2)), 'janggi: a piece on the diagonal step blocks only that jump');

  // Horses are blocked on their leg.
  check(same(mv('5k3/9/9/9/9/9/9/9/1P7/1H3K3 w', 9, 1), [P(8, 3)]), 'janggi: a horse with a piece on its leg cannot jump that way');

  // Soldiers go forward and sideways, and along the palace diagonal inside the enemy palace.
  check(same(mv('5k3/9/9/9/9/4P4/9/9/9/5K3 w', 5, 4), sortNum([P(4, 4), P(5, 3), P(5, 5)])), 'janggi: a soldier moves forward and sideways, never back');
  check(same(mv('3k5/9/3P5/9/9/9/9/9/9/5K3 w', 2, 3), sortNum([P(1, 3), P(1, 4), P(2, 2), P(2, 4)])), 'janggi: a soldier on the enemy palace corner also steps along the diagonal');
  check(same(mv('5k3/4P4/9/9/9/9/9/9/9/5K3 w', 1, 4), sortNum([P(0, 3), P(0, 4), P(0, 5), P(1, 3), P(1, 5)])), 'janggi: a soldier on the enemy palace middle has two diagonals');
  check(!mv('3k5/9/9/3P5/9/9/9/9/9/5K3 w', 3, 3).includes(P(2, 4)), 'janggi: outside the enemy palace a soldier has no diagonal step');

  // Bikjang, checkmate, and the pass.
  check(E.bikjang(E.parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w')) && E.status(E.parseFen('4k4/9/9/9/9/9/9/9/9/4K4 w')).result === 'bikjang', 'janggi: bikjang (generals face with nothing between) ends the game as a draw');
  check(!E.bikjang(E.parseFen('4k4/9/9/9/4P4/9/9/9/9/4K4 w')), 'janggi: a piece between the generals is no bikjang');
  const mate = E.parseFen('3k4R/R8/9/9/9/9/9/9/9/5K3 b');
  const ms = E.status(mate);
  check(E.legalMoves(mate).length === 0 && ms.over && ms.result === 'mate' && ms.winner === E.CHO, 'janggi: no move while in check is checkmate and loses');
  const stale = E.parseFen('3k5/R8/9/9/9/4R4/9/9/9/5K3 b');
  check(E.legalMoves(stale).length === 0 && !E.inCheck(stale) && same(E.movesOrPass(stale), [E.PASS]) && E.status(stale).mustPass, 'janggi: no move and no check means a pass');
  E.make(stale, E.PASS);
  check(stale.turn === E.CHO && E.legalMoves(stale).length > 0, 'janggi: after a pass the other side moves');
  E.unmake(stale);
  check(stale.turn === E.HAN, 'janggi: a pass unmakes');
  check(E.status(E.parseFen('4k4/9/9/9/9/9/9/9/9/5K3 w')).over === false, 'janggi: an ordinary position goes on');

  // A self-played game: the computer only ever plays legal moves (or passes when it must).
  {
    const g = E.startPosition();
    let ok = true, plies = 0;
    for (; plies < 40; plies++) {
      const st = E.status(g);
      if (st.over) break;
      const r = E.think(g, { level: 'easy', ms: 60, depth: 2, noise: 0 });
      const legalNow = E.movesOrPass(g);
      if (!legalNow.includes(r.move)) { ok = false; break; }
      E.make(g, r.move);
    }
    if (!ok || plies <= 10) console.error(JSON.stringify(E.status(g)), E.toFen(g));
    check(ok && plies > 10, 'janggi: the computer plays ' + plies + ' legal plies against itself');
  }
}

// ── Makruk ──
{
  const sb = load(['enginekit.js', 'makruk-engine.js']);
  const E = sb.ZimiMakrukEngine(sb.ZimiSearch());
  const at = (r, f) => r * 8 + f;
  const mv = (fen, r, f) => { const p = E.parseFen(fen); return sortNum(E.legalMoves(p).filter(m => E.from(m) === at(r, f)).map(E.to)); };

  const start = E.startPosition();
  check(E.perft(start, 1) === 23, 'makruk: 23 moves from the start (8 Bia, 2 Ma, 3 + 3 Khon, 3 Khun, 2 Met, 2 Rua)');
  check(E.perft(start, 2) === 23 * 23, 'makruk: the two sides do not touch at ply two (529)');
  check(E.toFen(start) === E.START_FEN, 'makruk: the start position round-trips through its FEN');
  check(E.START_FEN.split(' ')[0] === 'rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR', 'makruk: the Khun and the Met stand so the two Khun do not face each other');

  check(same(mv('k7/8/8/8/3S4/8/8/7K w', 4, 3), sortNum([at(3, 2), at(3, 4), at(5, 2), at(5, 4), at(3, 3)])), 'makruk: a Khon steps on the four diagonals and straight ahead, never back');
  check(same(mv('k7/8/8/8/3M4/8/8/7K w', 4, 3), sortNum([at(3, 2), at(3, 4), at(5, 2), at(5, 4)])), 'makruk: a Met takes one step on a diagonal');
  check(mv('k7/8/8/8/3N4/8/8/7K w', 4, 3).length === 8, 'makruk: a Ma jumps like a knight');
  check(same(mv('k7/8/8/8/8/4P3/8/7K w', 5, 4), [at(4, 4)]), 'makruk: a Bia steps one square forward only');
  check(same(mv('k7/8/8/8/3p4/4P3/8/7K w', 5, 4), sortNum([at(4, 3), at(4, 4)])), 'makruk: a Bia takes one step on a forward diagonal');
  check(mv('k7/8/8/8/8/8/8/R6K w', 7, 0).length === 13, 'makruk: a Rua slides along ranks and files (7 up, 6 along to the Khun)');

  let pos = E.parseFen('k7/8/8/4P3/8/8/8/7K w');
  let m = E.findMove(pos, at(3, 4), at(2, 4));
  check(E.isPromo(m), 'makruk: a white Bia reaching the sixth rank becomes a Met');
  E.make(pos, m);
  check(pos.sq[at(2, 4)] === E.MET, 'makruk: ... and the board holds a Met');
  E.unmake(pos);
  check(pos.sq[at(3, 4)] === E.BIA && pos.sq[at(2, 4)] === 0, 'makruk: ... and unmaking brings the Bia back');
  pos = E.parseFen('k7/8/8/8/4P3/8/8/7K w');
  check(!E.isPromo(E.findMove(pos, at(4, 4), at(3, 4))), 'makruk: a Bia on its way, short of the sixth rank, does not promote');
  pos = E.parseFen('k7/8/8/8/4p3/8/8/7K b');
  check(E.isPromo(E.findMove(pos, at(4, 4), at(5, 4))), 'makruk: a black Bia promotes on the third rank');

  const sq = (r, f) => at(r, f);
  check(E.attacked(E.parseFen('k7/8/8/8/4S3/8/8/7K w'), sq(3, 4), E.WHITE) && !E.attacked(E.parseFen('k7/8/8/8/4S3/8/8/7K w'), sq(5, 4), E.WHITE), 'makruk: a Khon guards the square ahead of it but not the one behind');
  const bp = E.parseFen('k7/8/8/8/4P3/8/8/7K w');
  check(E.attacked(bp, sq(3, 3), E.WHITE) && E.attacked(bp, sq(3, 5), E.WHITE) && !E.attacked(bp, sq(3, 4), E.WHITE), 'makruk: a Bia guards its two forward diagonals, not the square ahead');

  const mate = E.parseFen('k6R/7R/8/8/8/8/8/K7 b');
  check(E.status(mate).result === 'mate' && E.status(mate).winner === E.WHITE, 'makruk: two Rua on the Khun\'s corner is checkmate');
  const stale = E.parseFen('k7/1R6/2K5/8/8/8/8/8 b');
  check(E.status(stale).result === 'stalemate', 'makruk: a Khun with no move and no check is a stalemate (a draw)');
  pos = E.parseFen('k7/8/8/8/8/8/8/7K w'); pos.quiet = E.MOVE_LIMIT_PLIES;
  check(E.status(pos).result === 'limit', 'makruk: sixty-four moves each without a capture or a Bia move end the game (the counting rules, simplified)');

  // The attack test agrees with the move generator: a dummy enemy piece put on a square is capturable by `by`
  // exactly when the square is attacked. Checked over every square of positions from random games.
  {
    const rng = seeded(11);
    let bad = 0, n = 0;
    for (let g = 0; g < 12; g++) {
      const p = E.startPosition();
      for (let ply = 0; ply < 70; ply++) {
        const ms = E.legalMoves(p);
        if (!ms.length) break;
        if (ply % 5 === 0) {
          for (let s = 0; s < 64; s++) for (const by of [E.WHITE, E.BLACK]) {
            if (p.sq[s] * by > 0) continue;
            const x = E.clone(p); x.sq[s] = -by * E.RUA;
            const viaMoves = E.pseudo(x, by).some(mm => E.to(mm) === s);
            n++;
            if (viaMoves !== E.attacked(x, s, by)) bad++;
          }
        }
        E.make(p, ms[Math.floor(rng() * ms.length)]);
      }
    }
    check(bad === 0 && n > 5000, 'makruk: attacked() agrees with the move generator on ' + n + ' squares of random games');
  }
  {
    const g = E.startPosition();
    let ok = true, plies = 0;
    for (; plies < 60; plies++) {
      if (E.status(g).over) break;
      const r = E.think(g, { level: 'easy', ms: 60, depth: 2 });
      if (!E.legalMoves(g).includes(r.move)) { ok = false; break; }
      E.make(g, r.move);
    }
    check(ok && plies > 20, 'makruk: the computer plays ' + plies + ' legal plies against itself');
  }
}

// ── International draughts ──
{
  const sb = load(['enginekit.js', 'draughts-engine.js']);
  const E = sb.ZimiDraughtsEngine(sb.ZimiSearch());
  const sqr = (r, f) => r * 10 + f;
  // A position from lists of [row, file]: men, kings, and the side to move.
  const setup = (w, b, wk, bk, turn) => {
    const a = new Array(100).fill('.');
    (w || []).forEach(p => { a[sqr(...p)] = 'w'; }); (b || []).forEach(p => { a[sqr(...p)] = 'b'; });
    (wk || []).forEach(p => { a[sqr(...p)] = 'W'; }); (bk || []).forEach(p => { a[sqr(...p)] = 'B'; });
    (w || []).concat(b || [], wk || [], bk || []).forEach(p => { if ((p[0] + p[1]) % 2 !== 1) throw new Error('light square ' + p); });
    return E.fromString(a.join(''), turn);
  };

  const start = E.newPosition();
  check([1, 2, 3, 4].map(d => E.perft(start, d)).join() === '9,81,658,4265', 'draughts: perft 1 to 4 from the start are 9, 81, 658, 4265 (the known counts)');
  let ok = true;
  for (let n = 1; n <= 50; n++) if (E.numberOf(E.squareOfNumber(n)) !== n || !E.isDark(E.squareOfNumber(n))) ok = false;
  check(ok && E.squareOfNumber(1) === sqr(0, 1) && E.squareOfNumber(5) === sqr(0, 9) && E.squareOfNumber(46) === sqr(9, 0) && E.squareOfNumber(50) === sqr(9, 8), 'draughts: the squares are numbered 1 to 50 from the top left, with a dark square at the bottom left');
  check(start.sq.filter(v => v > 0).length === 20 && start.sq.filter(v => v < 0).length === 20, 'draughts: twenty men each');

  // Majority: a capture of two must be taken in preference to a capture of one.
  let pos = setup([[8, 3], [4, 1]], [[7, 4], [3, 2], [1, 4]]);
  let ms = E.moves(pos);
  check(ms.length > 0 && ms.every(m => m.caps.length === 2 && m.from === sqr(4, 1)), 'draughts: the majority rule: the capture of two pieces is compulsory over a capture of one');
  pos = setup([[8, 3]], [[7, 4]]);
  ms = E.moves(pos);
  check(ms.length === 1 && ms[0].caps.length === 1, 'draughts: a capture is compulsory (the quiet moves are not offered)');

  // Men capture backwards.
  pos = setup([[5, 4]], [[6, 3]]);
  ms = E.moves(pos);
  check(ms.length === 1 && ms[0].to === sqr(7, 2), 'draughts: a man captures backwards');
  // ... but men only step forward.
  pos = setup([[5, 4]], [[0, 1]]);
  check(E.moves(pos).every(m => E.rowOf(m.to) === 4), 'draughts: men step forward only');

  // Flying kings.
  pos = setup([], [[5, 4]], [[9, 0]], []);
  ms = E.moves(pos);
  check(ms.length === 5 && ms.every(m => m.caps.length === 1 && m.caps[0] === sqr(5, 4)) && same(sortNum(ms.map(m => m.to)), sortNum([sqr(4, 5), sqr(3, 6), sqr(2, 7), sqr(1, 8), sqr(0, 9)])), 'draughts: a king captures from a distance and may land on any empty square beyond');
  pos = setup([], [[5, 4], [3, 4]], [[9, 0]], []);
  ms = E.moves(pos);
  check(ms.length === 3 && ms.every(m => m.caps.length === 2 && m.path[0] === sqr(4, 5)), 'draughts: a king must pick the landing that continues the capture (the majority)');
  pos = setup([], [], [[9, 0]], []);
  check(E.moves(pos).length === 9 && E.moves(pos).every(m => m.caps.length === 0), 'draughts: a king moves any distance along a free diagonal (9 squares from the corner)');
  pos = setup([], [[6, 3], [5, 4]], [[9, 0]], []);
  check(E.moves(pos).every(m => m.caps.length === 0) && E.moves(pos).length === 2, 'draughts: a king cannot jump two pieces standing together');

  // A loop of four captures comes back to the start square, and captured pieces stay on until the end.
  pos = setup([[6, 3]], [[5, 4], [3, 4], [3, 2], [5, 2]]);
  ms = E.moves(pos);
  check(ms.length > 0 && ms.every(m => m.caps.length === 4) && ms.some(m => m.to === m.from), 'draughts: a man may finish on the square it started from (a loop of four)');

  // Crowning.
  pos = setup([[1, 2]], [[8, 1]]);
  ms = E.moves(pos);
  check(ms.length === 2 && ms.every(m => m.crown), 'draughts: a man reaching the far row is crowned');
  pos = setup([[2, 1]], [[1, 2], [1, 4]]);
  ms = E.moves(pos);
  check(ms.length === 1 && ms[0].caps.length === 2 && ms[0].crown === false && ms[0].to === sqr(2, 5), 'draughts: a man that only passes the far row in a capture is not crowned');
  pos = setup([[2, 1]], [[1, 2]]);
  ms = E.moves(pos);
  check(ms.length === 1 && ms[0].crown === true, 'draughts: a man that ends a capture on the far row is crowned');
  E.make(pos, ms[0]);
  check(pos.sq[sqr(0, 3)] === 2 && pos.sq[sqr(1, 2)] === 0, 'draughts: the crowned piece is a king and the captured man is gone');
  E.unmake(pos);
  check(pos.sq[sqr(2, 1)] === 1 && pos.sq[sqr(1, 2)] === -1 && pos.sq[sqr(0, 3)] === 0 && pos.turn === 1, 'draughts: unmaking restores everything');

  // The end.
  pos = setup([[5, 4]], [], [], [], -1);
  check(E.status(pos).over && E.status(pos).winner === 1, 'draughts: a side with no pieces to move has lost');
  pos = setup([], [], [[9, 0]], [[0, 9]]); pos.quiet = E.QUIET_DRAW_PLIES;
  check(E.status(pos).result === 'quiet', 'draughts: twenty-five moves each of king moves alone is a draw');

  // The computer only ever plays legal moves, and takes compulsory captures.
  {
    const g = E.newPosition();
    let legal = true, plies = 0;
    for (; plies < 70; plies++) {
      if (E.status(g).over) break;
      const list = E.moves(g), r = E.handle({ sq: Array.from(g.sq), turn: g.turn, quiet: g.quiet, level: 'easy', ms: 50, depth: 2 });
      if (r.index < 0 || r.index >= list.length) { legal = false; break; }
      E.make(g, list[r.index]);
    }
    check(legal && plies >= 40, 'draughts: the computer plays ' + plies + ' legal plies against itself');
  }
}

// ── Hnefatafl (Copenhagen) ──
{
  const sb = load(['enginekit.js', 'hnefatafl-engine.js']);
  const E = sb.ZimiHnefataflEngine(sb.ZimiSearch());
  const sqr = (r, f) => r * 11 + f;
  // A position from lists of [row, file]: attackers, defenders, the king; and the side to move (1 attackers, 2 defenders).
  const setup = (a, d, k, turn, rules) => {
    const x = new Array(121).fill('.');
    (a || []).forEach(p => { x[sqr(...p)] = 'a'; }); (d || []).forEach(p => { x[sqr(...p)] = 'd'; });
    if (k) x[sqr(...k)] = 'k';
    return E.fromString(x.join(''), turn || 1, rules);
  };
  const go = (pos, from, to) => {
    const m = E.moves(pos).find(mm => E.from(mm) === sqr(...from) && E.to(mm) === sqr(...to));
    if (m === undefined) return false;
    E.make(pos, m); return true;
  };
  const count = (pos, v) => pos.sq.filter(x => x === v).length;

  const start = E.newPosition();
  check(count(start, 1) === 24 && count(start, 2) === 12 && count(start, 3) === 1 && start.sq[60] === 3, 'hnefatafl: 24 attackers, 12 defenders and the king on the throne');
  check(start.turn === 1 && E.moves(start).length > 0 && E.moves(start).every(m => start.sq[E.from(m)] === 1), 'hnefatafl: the attackers move first');
  check(E.moves(start).every(m => !E.isCorner(E.to(m)) && E.to(m) !== 60), 'hnefatafl: nobody else may stop on a corner or the throne');

  // Custodial capture, and moving in between two enemies is safe.
  let pos = setup([[2, 3], [6, 5]], [[2, 4]], [8, 8], 1);
  go(pos, [6, 5], [2, 5]);
  check(pos.sq[sqr(2, 4)] === 0 && same(E.lastCaptures(pos), [sqr(2, 4)]), 'hnefatafl: a piece between two enemies on a line is captured');
  pos = setup([[2, 3], [2, 5]], [[6, 4]], [8, 8], 2);
  go(pos, [6, 4], [2, 4]);
  check(pos.sq[sqr(2, 4)] === 2 && E.lastCaptures(pos).length === 0, 'hnefatafl: moving in between two enemies is safe');

  // The corners are hostile; the throne is hostile to attackers always and to defenders when empty.
  pos = setup([[6, 2]], [[0, 1]], [8, 8], 1);
  go(pos, [6, 2], [0, 2]);
  check(pos.sq[sqr(0, 1)] === 0, 'hnefatafl: a defender beside a corner is taken by one attacker');
  pos = setup([[5, 4]], [[9, 3]], [8, 8], 2);
  go(pos, [9, 3], [5, 3]);
  check(pos.sq[sqr(5, 4)] === 0, 'hnefatafl: the empty throne is hostile to attackers');
  pos = setup([[8, 3]], [[5, 4]], [8, 8], 1);
  go(pos, [8, 3], [5, 3]);
  check(pos.sq[sqr(5, 4)] === 0, 'hnefatafl: the empty throne is hostile to a defender beside it');
  pos = setup([[8, 3]], [[5, 4]], null, 1); pos.sq[60] = 3;
  go(pos, [8, 3], [5, 3]);
  check(pos.sq[sqr(5, 4)] === 2, 'hnefatafl: with the king on it the throne is no enemy of a defender');

  // The throne: only the king stops there, others may pass over it when it is empty.
  pos = setup([[5, 2]], [], [9, 9], 1);
  check(E.moves(pos).some(m => E.to(m) === sqr(5, 6)) && !E.moves(pos).some(m => E.to(m) === 60), 'hnefatafl: an attacker may pass over the empty throne but not stop on it');
  pos = setup([], [], [5, 6], 2);
  check(E.moves(pos).some(m => E.to(m) === 60), 'hnefatafl: the king may return to the throne');

  // The king: to a corner wins, and he is armed.
  pos = setup([[8, 8]], [], [0, 4], 2);
  go(pos, [0, 4], [0, 0]);
  check(E.status(pos).over && E.status(pos).winner === 2 && E.status(pos).result === 'corner', 'hnefatafl: the king on a corner wins for the defenders');
  pos = setup([[3, 6]], [[8, 8]], [3, 4], 2);
  go(pos, [8, 8], [3, 8]);
  check(pos.sq[sqr(3, 6)] === 1, 'hnefatafl: a plain move beside an enemy is not a capture without a second piece');
  pos = setup([[3, 6]], [[8, 7]], [3, 4], 2);
  pos.sq[sqr(3, 4)] = 0; pos.sq[sqr(3, 5)] = 3;
  go(pos, [8, 7], [3, 7]);
  check(pos.sq[sqr(3, 6)] === 0, 'hnefatafl: the king takes part in captures');

  // Capturing the king: four attackers, three beside the throne, never on the edge.
  pos = setup([[3, 4], [3, 6], [2, 5], [8, 5]], [], [3, 5], 1);
  go(pos, [8, 5], [4, 5]);
  check(E.status(pos).over && E.status(pos).winner === 1, 'hnefatafl: four attackers around the king take him');
  pos = setup([[3, 5], [4, 4], [8, 6]], [], [4, 5], 1);
  go(pos, [8, 6], [4, 6]);
  check(E.status(pos).winner === 1, 'hnefatafl: beside the throne three attackers are enough');
  pos = setup([[10, 4], [8, 6]], [], [10, 5], 1);
  go(pos, [8, 6], [10, 6]);
  check(!E.status(pos).over, 'hnefatafl: the king on the edge cannot be taken by two attackers');
  pos = setup([[3, 4], [3, 6], [2, 5]], [[8, 5]], [3, 5], 1);
  pos.sq[sqr(4, 5)] = 0;
  check(E.status(pos).over === false, 'hnefatafl: three attackers in the open do not take the king');

  // The shieldwall is an option, off by default.
  const wall = rules => { const p = setup([[10, 2], [9, 3], [9, 4], [6, 5]], [[10, 3], [10, 4]], [2, 2], 1, rules); go(p, [6, 5], [10, 5]); return p; };
  pos = wall({ shield: false });
  check(pos.sq[sqr(10, 3)] === 2 && pos.sq[sqr(10, 4)] === 2, 'hnefatafl: with the shieldwall off a row on the edge is not taken');
  pos = wall({ shield: true });
  check(pos.sq[sqr(10, 3)] === 0 && pos.sq[sqr(10, 4)] === 0 && E.lastCaptures(pos).length === 2, 'hnefatafl: with the shieldwall on, the bracketed row on the edge is taken together');

  // The end: a ring of attackers, and no legal move.
  pos = setup([[2, 3], [4, 3], [3, 2], [3, 4]], [], [3, 3], 2);
  check(E.encircled(pos) && ['ringed', 'blocked'].includes(E.status(pos).result) && E.status(pos).winner === 1, 'hnefatafl: attackers ringing in every defender win');
  pos = setup([[2, 3], [4, 3], [3, 2], [3, 4], [8, 8]], [], [3, 3], 2);
  check(E.status(pos).over && E.status(pos).winner === 1, 'hnefatafl: a defender side that cannot move loses');
  pos = setup([[2, 3], [4, 3], [3, 2], [3, 4], [8, 8]], [[8, 3]], [3, 3], 2);
  check(!E.encircled(pos), 'hnefatafl: one defender outside the ring means it is not closed');

  // The computer: takes a corner when the king can reach one, and only plays legal moves.
  pos = setup([[8, 8], [6, 1]], [[9, 9]], [0, 4], 2);
  const r = E.think(pos, { level: 'hard', ms: 300, depth: 2, noise: 0 });
  check(E.to(r.move) === 0, 'hnefatafl: the computer runs the king to the corner when the way is clear');
  {
    const g = E.newPosition();
    let legal = true, plies = 0;
    for (; plies < 60; plies++) {
      if (E.status(g).over) break;
      const res = E.handle({ sq: Array.from(g.sq), turn: g.turn, shield: false, level: 'easy', ms: 80, depth: 1 });
      if (!E.moves(g).includes(res.move)) { legal = false; break; }
      E.make(g, res.move);
    }
    check(legal && plies >= 10, 'hnefatafl: the computer plays ' + plies + ' legal plies against itself (' + E.status(g).result + ')');
  }
}

// ── The Royal Game of Ur ──
{
  const E = load(['enginekit.js', 'ur-engine.js']).ZimiUrEngine();
  const state = (a, b, turn) => { const st = E.newState(); st.pos[0] = a.concat(new Array(7 - a.length).fill(0)); st.pos[1] = b.concat(new Array(7 - b.length).fill(0)); st.turn = turn || 0; return st; };
  const moveTo = (st, roll, from) => E.legalMoves(st, roll).find(m => m.from === from);

  check(same(E.ROLL_WAYS, [1, 4, 6, 4, 1]) && E.ROLL_WAYS.reduce((a, b) => a + b) === E.ROLL_TOTAL, 'ur: four binary dice give 0 to 4 in 1, 4, 6, 4, 1 sixteenths');
  const cells = new Set();
  for (let p = 0; p < 2; p++) for (let k = 1; k <= 14; k++) { const c = E.cell(p, k); cells.add(c.row + ',' + c.col); }
  check(cells.size === 20 && same(E.cell(0, 8), E.cell(1, 8)) && E.cell(0, 8).row === 1 && E.cell(0, 8).col === 3, 'ur: the two paths cover twenty squares and share the eight in the middle, the central rosette in the fourth column');
  check(E.ROSETTES.every(k => E.isRosette(k)) && same(E.cell(0, 4), { row: 2, col: 0 }) && same(E.cell(0, 14), { row: 2, col: 6 }) && same(E.cell(1, 14), { row: 0, col: 6 }), 'ur: rosettes on the fourth, eighth and fourteenth squares');

  let st = state([2], [], 0);
  let m = moveTo(st, 2, 2);
  check(m && m.rosette && E.apply(st, m).turn === 0, 'ur: landing on a rosette throws again');
  m = moveTo(st, 1, 2);
  check(m && !m.rosette && E.apply(st, m).turn === 1, 'ur: any other landing passes the dice to the other side');

  // Capture and the safe rosette.
  st = state([5], [7], 0);
  m = moveTo(st, 2, 5);
  check(m && m.capture, 'ur: a piece landing on an enemy in the shared lane takes it');
  let after = E.apply(st, m);
  check(after.pos[1].every(k => k === 0) && after.pos[0].includes(7), 'ur: the taken piece goes back to the start');
  st = state([6], [8], 0);
  check(!moveTo(st, 2, 6), 'ur: a piece on the central rosette cannot be taken, so nobody may land there');
  st = state([3], [3], 0);
  m = moveTo(st, 1, 3);
  check(m && !m.capture && E.apply(st, m).pos[1].includes(3), 'ur: the squares in the first four and last two are private: no captures there');
  st = state([5, 7], [], 0);
  check(!moveTo(st, 2, 5), 'ur: a piece may not land on one of its own');

  // Leaving the board takes an exact throw.
  st = state([13], [], 0);
  check(moveTo(st, 2, 13) && moveTo(st, 2, 13).off && !moveTo(st, 3, 13) && !moveTo(st, 4, 13), 'ur: bearing off needs an exact throw');
  st = state([14, 15, 15, 15, 15, 15, 15], [], 0);
  check(moveTo(st, 1, 14) && moveTo(st, 1, 14).off && E.legalMoves(st, 2).length === 0, 'ur: from the last square only a 1 takes the piece off');
  check(E.legalMoves(state([1], [], 0), 0).length === 0, 'ur: a throw of 0 moves nothing');
  st = state([0, 0, 0], [], 0);
  check(E.legalMoves(st, 2).length === 1, 'ur: the waiting pieces are one choice, not many');
  st = state([15, 15, 15, 15, 15, 15, 13], [], 0);
  after = E.apply(st, moveTo(st, 2, 13));
  check(after.winner === 0 && E.home(after, 0) === 7, 'ur: the seventh piece off the board wins');

  // The computer takes an obvious capture, and plays complete games with legal moves only.
  st = state([5, 10], [7, 12], 0);
  const choice = E.choose(st, 2, 'hard', () => 0.5);
  check(E.legalMoves(st, 2)[choice.index].capture, 'ur: the computer takes a piece when it can (hard)');
  {
    const rng = seeded(21);
    let completed = 0, legalOnly = true, conserved = true;
    for (let g = 0; g < 15 && legalOnly; g++) {
      let s = E.newState(), guard = 0;
      while (s.winner < 0 && guard++ < 3000) {
        let r = 0; const x = rng() * 16; r = x < 1 ? 0 : x < 5 ? 1 : x < 11 ? 2 : x < 15 ? 3 : 4;
        const ms = E.legalMoves(s, r);
        if (!ms.length) { s = E.pass(s); continue; }
        const level = ['easy', 'medium', 'hard'][(g + s.turn) % 3];
        const idx = E.choose(s, r, level, rng).index;
        if (idx < 0 || idx >= ms.length) { legalOnly = false; break; }
        s = E.apply(s, ms[idx]);
        if (s.pos[0].length !== 7 || s.pos[1].length !== 7) conserved = false;
      }
      if (s.winner >= 0) completed++;
    }
    check(legalOnly && conserved && completed === 15, 'ur: 15 games between the computer levels all finish with legal moves (' + completed + ')');
  }
}

// ── Snakes and Ladders ──
{
  const E = load(['snakesandladders.js']).SnakesLaddersEngine;
  check(same(E.cellOf(1), { row: 0, col: 0 }) && same(E.cellOf(10), { row: 0, col: 9 }) && same(E.cellOf(11), { row: 1, col: 9 }) && same(E.cellOf(20), { row: 1, col: 0 }) && same(E.cellOf(100), { row: 9, col: 0 }), 'snakes: the squares run along each row in turn from the bottom left (1 bottom left, 10 bottom right, 11 above 10, 100 top left)');
  const all = new Set();
  for (let n = 1; n <= 100; n++) { const c = E.cellOf(n); all.add(c.row * 10 + c.col); }
  check(all.size === 100, 'snakes: every square has its own place');
  const heads = Object.keys(E.SNAKES).map(Number), feet = Object.keys(E.LADDERS).map(Number);
  check(heads.every(h => E.SNAKES[h] < h) && feet.every(f => E.LADDERS[f] > f), 'snakes: every snake goes down and every ladder goes up');
  const ends = heads.map(h => E.SNAKES[h]).concat(feet.map(f => E.LADDERS[f]));
  check(ends.every(e => !E.jumpOf(e) || e === 100) && !heads.some(h => feet.includes(h)) && !E.jumpOf(100), 'snakes: nothing ends on another snake or ladder, so a jump never chains');
  check(E.jumpOf(100) === 0 && E.SNAKES[100] === undefined, 'snakes: there is no snake on the last square');

  let r = E.step(0, 4);
  check(r.moved && r.to === 14 && r.jump === 'ladder' && r.landed === 4, 'snakes: landing on a ladder foot carries the token up');
  r = E.step(12, 4);
  check(r.to === 6 && r.jump === 'snake' && r.landed === 16, 'snakes: landing on a snake head slides the token down');
  r = E.step(20, 3);
  check(r.to === 23 && r.jump === null, 'snakes: a plain square is just a move');
  r = E.step(98, 3);
  check(!r.moved && r.to === 98 && !r.won, 'snakes: a roll that would pass 100 leaves the token where it is');
  r = E.step(97, 3);
  check(r.won && r.to === 100, 'snakes: an exact roll reaches 100 and wins');
  r = E.step(95, 5);
  check(r.won && r.jump === null, 'snakes: 100 itself holds no snake');
  r = E.step(94, 1);
  check(r.to === 75 && r.jump === 'snake' && r.landed === 95, 'snakes: the snake at 95 takes a token back to 75');
  r = E.step(94, 4);
  check(r.to === 78 && r.jump === 'snake', 'snakes: the snake at 98 takes a token back to 78');
  r = E.step(77, 3);
  check(r.to === 100 && r.won, 'snakes: the long ladder from 80 reaches 100 and wins');
  check(E.step(0, 6, { again: true }).again === true && E.step(0, 5, { again: true }).again === false && E.step(0, 6, {}).again === false, 'snakes: a six gives another roll only when that option is on');
  check(E.step(94, 6, { again: true }).won && !E.step(94, 6, { again: true }).again, 'snakes: no extra roll after winning');
  // Every square of the board can be reached by rolling 1 to 6 from the start (the game can always be finished).
  const seen = new Set([0]); let frontier = [0];
  while (frontier.length) { const next = []; frontier.forEach(f => { for (let d = 1; d <= 6; d++) { const q = E.step(f, d); if (q.moved && !seen.has(q.to)) { seen.add(q.to); next.push(q.to); } } }); frontier = next; }
  check(seen.has(100), 'snakes: the last square can be reached from the start');
  // A long run of random games always finishes, and the average is in the usual range.
  {
    const rng = seeded(5);
    let total = 0, games = 400, finished = 0;
    for (let g = 0; g < games; g++) { let at = 0, turns = 0; while (at < 100 && turns < 2000) { at = E.step(at, 1 + Math.floor(rng() * 6)).to; turns++; } if (at === 100) { finished++; total += turns; } }
    check(finished === games && total / games > 20 && total / games < 90, 'snakes: random games all finish, ' + (total / games).toFixed(0) + ' turns on average');
  }
}

// ── Carrom ──
{
  const E = load(['carrom-engine.js']).ZimiCarromEngine();
  const only = (g, list) => { g.bodies.forEach(b => { b.alive = false; }); list.forEach(([kind, x, y]) => { const b = g.bodies.find(q => q.kind === kind && !q.alive); b.alive = true; b.x = x; b.y = y; b.vx = b.vy = 0; }); return g; };
  const bodyOf = (g, kind, i = 0) => g.bodies.filter(b => b.kind === kind && b.alive)[i];

  // The set-up.
  let g = E.newGame();
  const kinds = k => g.bodies.filter(b => b.kind === k).length;
  check(g.bodies.length === 19 && kinds('w') === 9 && kinds('b') === 9 && kinds('q') === 1, 'carrom: nine white coins, nine black coins and the queen');
  let clear = true; const all = E.allBodies(g);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) < all[i].r + all[j].r - 0.01) clear = false;
  check(clear && all.every(b => b.x > b.r && b.x < E.B - b.r && b.y > b.r && b.y < E.B - b.r), 'carrom: the coins stand clear of each other and of the walls');
  const q = g.bodies.find(b => b.kind === 'q');
  check(Math.abs(q.x - E.CENTRE) < 0.01 && Math.abs(q.y - E.CENTRE) < 0.01, 'carrom: the queen is in the middle');

  // Collisions conserve momentum and send the hit coin along the line of centres.
  g = only(E.newGame(), [['w', 300, 300], ['b', 300 + 2 * E.COIN_R - 0.5, 300]]);
  const [a, b] = [bodyOf(g, 'w'), bodyOf(g, 'b')];
  a.vx = 600;
  const before = a.vx * a.m + b.vx * b.m;
  E.step(g, E.DT);
  const after = a.vx * a.m + b.vx * b.m;
  check(Math.abs(after - before) / before < 0.03 && b.vx > a.vx && b.vx > 0.9 * 600 * 0.9 && Math.abs(b.vy) < 1e-6, 'carrom: a head-on collision passes the motion on and keeps the momentum (' + after.toFixed(0) + ' of ' + before + ')');
  g = only(E.newGame(), [['w', 300, 300], ['b', 300 + 25, 300 + 25]]);
  const hit = bodyOf(g, 'b'); const strike = bodyOf(g, 'w'); strike.vx = 700;
  for (let i = 0; i < 6; i++) E.step(g, E.DT);
  check(hit.vy > 0 && hit.vx > 0 && Math.abs(Math.atan2(hit.vy, hit.vx) - Math.PI / 4) < 0.25, 'carrom: a glancing hit sends the coin off along the line between the centres (' + (Math.atan2(hit.vy, hit.vx) * 180 / Math.PI).toFixed(0) + ' degrees)');
  // A wall bounce loses a little speed, friction brings everything to rest, and the run ends.
  g = only(E.newGame(), [['w', 60, 400]]);
  const c = bodyOf(g, 'w'); c.vx = -500;
  for (let i = 0; i < 100 && c.vx <= 0; i++) E.step(g, E.DT);
  check(c.vx > 0 && c.vx < 500 && c.x >= E.COIN_R - 0.01, 'carrom: a wall bounce reverses the coin and takes a little of its speed');
  g = only(E.newGame(), [['w', 300, 400]]);
  bodyOf(g, 'w').vx = 330; bodyOf(g, 'w').vy = 120;
  const dropped0 = E.run(g);
  check(!E.moving(g) && dropped0.length === 0 && Math.hypot(bodyOf(g, 'w').x - 300, bodyOf(g, 'w').y - 400) > 20, 'carrom: friction brings a sliding coin to rest');
  // Pockets.
  g = only(E.newGame(), [['w', 120, 120]]);
  const toPocket = bodyOf(g, 'w'); toPocket.vx = -420; toPocket.vy = -420;
  const dropped1 = E.run(g);
  check(dropped1.length === 1 && dropped1[0] === toPocket && !toPocket.alive, 'carrom: a coin rolled at a corner drops into the pocket');
  g = only(E.newGame(), [['w', 400, 400]]);
  g.striker.x = 60; g.striker.y = 60; g.striker.vx = -300; g.striker.vy = -300;
  const dropped2 = E.run(g);
  check(dropped2.length === 1 && dropped2[0].kind === 's', 'carrom: the striker can go into a pocket too');
  // Placing the striker keeps it on its baseline and off the coins.
  g = only(E.newGame(), [['w', 370, E.BASE_Y[0]]]);
  const px = E.placeStriker(g, 372, 0);
  check(Math.abs(px - 370) > E.COIN_R && g.striker.y === E.BASE_Y[0] && px >= E.BASE_X0 && px <= E.BASE_X1, 'carrom: the striker is placed on its baseline and moves aside from a coin');
  check(E.placeStriker(E.newGame(), 5, 0) === E.BASE_X0 && E.placeStriker(E.newGame(), 9999, 1) === E.BASE_X1, 'carrom: the striker stays between the ends of the baseline');

  // The rules of a turn.
  const settle = (g, list) => E.settle(g, list);
  g = E.newGame();
  let r = settle(g, [g.bodies.find(x => x.kind === 'w')]);
  check(r.again && g.turn === 0, 'carrom: pocketing one of your own coins gives another shot');
  g = E.newGame();
  r = settle(g, [g.bodies.find(x => x.kind === 'b')]);
  check(!r.again && g.turn === 1, 'carrom: pocketing only the other side\'s coin ends the turn');
  g = E.newGame();
  r = settle(g, []);
  check(!r.again && g.turn === 1, 'carrom: pocketing nothing ends the turn');
  g = E.newGame();
  const gone = g.bodies.filter(x => x.kind === 'w').slice(0, 2); gone.forEach(x => { x.alive = false; });
  r = settle(g, [g.striker]);
  check(!r.again && g.turn === 1 && g.bodies.filter(x => x.kind === 'w' && x.alive).length === 8 && r.notes.includes('coin back'), 'carrom: the striker in a pocket is a foul: the turn is lost and one of your pocketed coins goes back');
  // The queen has to be covered.
  g = E.newGame();
  const qb = g.bodies.find(x => x.kind === 'q'); qb.alive = false;
  r = settle(g, [qb]);
  check(r.again && g.pendingQueen === 0 && g.turn === 0, 'carrom: the queen alone gives another shot, to cover her');
  const w1 = g.bodies.find(x => x.kind === 'w'); w1.alive = false;
  r = settle(g, [w1]);
  check(g.queenBy === 0 && g.pendingQueen === -1 && r.notes.includes('queen covered') && r.again, 'carrom: pocketing your own coin on the next shot covers the queen');
  g = E.newGame();
  const q2 = g.bodies.find(x => x.kind === 'q'); q2.alive = false;
  settle(g, [q2]);
  r = settle(g, []);
  check(q2.alive && Math.hypot(q2.x - E.CENTRE, q2.y - E.CENTRE) < 60 && g.pendingQueen === -1 && g.turn === 1, 'carrom: if the cover fails the queen goes back to the middle and the turn passes');
  g = E.newGame();
  const q3 = g.bodies.find(x => x.kind === 'q'), w3 = g.bodies.find(x => x.kind === 'w'); q3.alive = w3.alive = false;
  r = settle(g, [q3, w3]);
  check(g.queenBy === 0 && g.pendingQueen === -1, 'carrom: the queen and your own coin on one shot covers her at once');
  // Not the last coin while the queen is on the board; and the win.
  g = E.newGame();
  g.bodies.filter(x => x.kind === 'w').forEach((x, i) => { if (i < 8) x.alive = false; });
  const lastW = g.bodies.filter(x => x.kind === 'w' && x.alive)[0]; lastW.alive = false;
  r = settle(g, [lastW]);
  check(!g.over && lastW.alive && r.notes.includes('last coin back'), 'carrom: the last coin may not go in while the queen is on the board');
  g = E.newGame();
  g.bodies.find(x => x.kind === 'q').alive = false; g.queenBy = 1;
  g.bodies.filter(x => x.kind === 'w').forEach((x, i) => { if (i < 8) x.alive = false; });
  const lastW2 = g.bodies.filter(x => x.kind === 'w' && x.alive)[0]; lastW2.alive = false;
  r = settle(g, [lastW2]);
  check(g.over && g.winner === 0 && r.over, 'carrom: with the queen gone, the side that clears its coins wins');

  // The computer aims sensibly: given one of its coins with a clear line to a pocket, it pockets it.
  g = only(E.newGame(), [['w', 150, 190], ['b', 600, 300]]);
  const shot = E.chooseShot(g, 0, 'hard', () => 0.5);
  const sim = E.cloneGame(g); E.placeStriker(sim, shot.x, 0); E.shoot(sim, shot.angle, shot.speed);
  const dd = E.run(sim);
  check(dd.some(x => x.kind === 'w') && !dd.some(x => x.kind === 's'), 'carrom: the computer pockets a coin that has a clear line to a pocket (hard)');
  g = only(E.newGame(), [['b', 590, 190], ['w', 300, 380]]);
  const shot2 = E.chooseShot(g, 1, 'hard', () => 0.5);
  const sim2 = E.cloneGame(g); E.placeStriker(sim2, shot2.x, 1); E.shoot(sim2, shot2.angle, shot2.speed);
  check(E.run(sim2).some(x => x.kind === 'b') && shot2.angle > 0, 'carrom: ... and from the far baseline, shooting down the board');
  // A whole game between the computers ends, with sound numbers all the way.
  {
    let game = E.newGame(), shots = 0, sound = true;
    const rng = seeded(3);
    while (!game.over && shots < 260) {
      const p = game.turn, s = E.chooseShot(game, p, 'hard', rng);
      E.placeStriker(game, s.x, p); E.shoot(game, s.angle, s.speed);
      const d = E.run(game);
      E.settle(game, d);
      if (game.bodies.concat([game.striker]).some(b => !isFinite(b.x) || !isFinite(b.y))) sound = false;
      shots++;
    }
    check(sound && game.over && game.winner >= 0, 'carrom: two computers play a whole game to a finish in ' + shots + ' shots');
  }
}

// ── Mahjong for four players ──
{
  const E = load(['mahjong4-engine.js']).Mahjong4Engine;
  // Hands in the usual notation: 123m (characters), 123p (circles), 123s (bamboo), 1234z winds, 567z dragons (red, green, white).
  const tiles = str => { const out = []; let digits = []; for (const ch of str.replace(/\s+/g, '')) { if (ch >= '0' && ch <= '9') digits.push(+ch); else { const base = { p: 0, s: 9, m: 18 }[ch]; digits.forEach(d => out.push(ch === 'z' ? 26 + d : base + d - 1)); digits = []; } } return out; };
  const counts = str => E.countsOf(tiles(str));
  const win = (str, extra) => E.scoreHand(Object.assign({ counts: counts(str), melds: [], selfDrawn: false, seat: 1, round: 0 }, extra || {}));
  const names = r => r.items.map(i => i.name);
  const K = str => tiles(str)[0];

  // Recognising a hand.
  check(E.canWin(counts('123m456m789m123p11s'), 0), 'mahjong4: four sets and a pair is a hand');
  check(!E.canWin(counts('123m456m789m123p12s'), 0), 'mahjong4: a hand one tile off is not');
  check(E.canWin(counts('234m567m99s'), 2), 'mahjong4: with two melds taken, two sets and a pair finish');
  check(!E.canWin(counts('123m456m789m123p111s'), 0), 'mahjong4: a wrong number of tiles is no hand');
  check(E.canWin(counts('111222333m11p789s'), 0) && E.decompositions(counts('111222333m11p789s'), 4).length >= 2, 'mahjong4: 111 222 333 can be read as three pungs or three chows');
  check(E.isOrphans(counts('19m19p19s1234567z1z'), 0) && E.canWin(counts('19m19p19s1234567z1z'), 0), 'mahjong4: thirteen orphans');
  check(same(E.waits(counts('23m456m789m123p11s'), 0), [K('1m'), K('4m'), K('7m')]), 'mahjong4: 2 3 4 5 6 7 8 9 characters wait on the 1, the 4 and the 7');
  check(same(E.waits(counts('11m456m789m123p55s'), 0), [K('5s'), K('1m')].sort((a, b) => a - b)), 'mahjong4: two pairs wait on either');
  check(E.waits(counts('1112345678999m'), 0).length === 9, 'mahjong4: nine gates: a pure one-suit hand waits on all nine numbers');

  // Scoring (the seat is South, the round is East, unless said otherwise).
  let r = win('123m456m789m123p11s');
  check(r.faan === 2 && same(names(r).sort(), ['Common hand', 'Concealed hand']), 'mahjong4: four chows and a plain pair is a common hand (and concealed)');
  r = win('123m456m789m123p11s', { selfDrawn: true });
  check(r.faan === 3 && names(r).includes('Self-drawn'), 'mahjong4: winning on your own draw adds a faan');
  r = win('111m222p333s444m55p');
  check(r.faan === 4 && names(r).includes('All pungs'), 'mahjong4: all pungs is three faan (four with the concealed hand)');
  r = win('456m789m123m11z'.replace('11z', '33z'), { melds: [{ type: 'chow', k: K('1p'), open: true }] });
  check(r.faan === 1 && same(names(r), ['Common hand']), 'mahjong4: a hand with a taken meld is scored on the whole, with no concealed bonus');
  r = win('123m456m789m123m11z');
  check(r.faan === 4 && names(r).includes('Mixed one suit'), 'mahjong4: one suit with honours is three faan');
  r = win('123m456m789m123m55m');
  check(names(r).includes('Pure one suit') && r.faan >= 6, 'mahjong4: one suit alone is six faan');
  r = win('123m456m789s666z55p');
  check(r.faan === 2 && names(r).includes('Dragon pung'), 'mahjong4: a dragon pung is a faan');
  r = win('123m456m789p22s222z', { seat: 1 });
  check(names(r).includes('Seat wind pung') && !names(r).includes('Prevailing wind pung'), 'mahjong4: a pung of your own wind (South here) is a faan');
  r = win('123m456m789p22s111z', { seat: 0 });
  check(names(r).filter(n => n.endsWith('wind pung')).length === 2, 'mahjong4: East pung for the East seat in the East round counts twice');
  r = win('555z66z123m456m789p');
  check(r && names(r).includes('Dragon pung') && !names(r).includes('Mixed one suit'), 'mahjong4: a dragon pung and a dragon pair, other suits mixed');
  check(win('123m456m789m123p1s') === null, 'mahjong4: thirteen tiles are not a win');
  r = win('555z666z77z123m456m');
  check(names(r).includes('Small three dragons') && r.faan >= 5, 'mahjong4: two dragon pungs and a dragon pair are the small three dragons');
  r = win('555z666z777z123m11p');
  check(r.limit && r.faan === 8 && names(r).includes('Big three dragons'), 'mahjong4: three dragon pungs are a limit hand');
  r = win('111z222z333z555z44z');
  check(r.limit && r.faan === 8, 'mahjong4: only winds and dragons is a limit hand');
  r = win('19m19p19s1234567z1z');
  check(r.limit && names(r).includes('Thirteen orphans'), 'mahjong4: thirteen orphans is a limit hand');
  r = win('123m456m789m123p11s', { last: true, selfDrawn: true });
  check(names(r).includes('Last tile from the wall'), 'mahjong4: the last tile of the wall scores');
  r = win('123m456m789m123p55z');
  check(!names(r).includes('Common hand'), 'mahjong4: a dragon pair is not a plain pair, so no common hand');
  check([3, 4, 5, 6, 7, 8, 13].map(E.pointsFor).join() === '8,16,24,32,48,64,64', 'mahjong4: the table: 3 faan 8, 4 faan 16, 5 faan 24, 6 faan 32, 7 faan 48, 8 and over 64');
  check(E.TABLE.length >= 14 && E.TABLE.every(row => row.length === 3), 'mahjong4: there is a scoring table to show');

  // Claims on a discard.
  check(same(E.chowOptions(counts('46m'), K('5m')), [K('4m')]), 'mahjong4: 4 and 6 take the 5 as a chow in the middle');
  check(same(E.chowOptions(counts('3467m'), K('5m')), [K('3m'), K('4m'), K('5m')]), 'mahjong4: 3 4 and 6 7 give three ways to take the 5');
  check(E.chowOptions(counts('12m'), K('9m')).length === 0 && E.chowOptions(counts('89m'), K('1m')).length === 0, 'mahjong4: a chow does not run round the corner');
  check(E.chowOptions(counts('12z'), K('3z')).length === 0, 'mahjong4: honours make no chows');

  // A hand in play.
  let t = E.newHand({ rnd: seeded(11), dealer: 2, min: 3 });
  check(t.hands[2].length === 14 && [0, 1, 3].every(p => t.hands[p].length === 13) && t.dead.length === 14 && t.wall.length === 136 - 52 - 14 - 1 && E.tilesInPlay(t) === 136, 'mahjong4: the deal: 14 to the dealer, 13 to the others, a dead wall of 14, 136 tiles in all');
  check(Array.from(E.countsOf([].concat(...t.hands, t.wall, t.dead))).every(c => c === 4), 'mahjong4: four of every tile');
  check(E.seatOf(t, 2) === 0 && E.seatOf(t, 3) === 1 && E.seatOf(t, 1) === 3, 'mahjong4: the dealer sits East');
  const thrown = t.hands[2][0];
  check(E.discard(t, 2, thrown) && t.phase === 'claim' && t.lastDiscard.tile === thrown && [0, 1, 3].every(p => t.claims[p]), 'mahjong4: a discard opens the claims for the other three');
  check(E.discard(t, 2, thrown) === false, 'mahjong4: nobody may discard out of turn');
  check(t.claims[0].chows.length === 0 && t.claims[1].chows.length === 0, 'mahjong4: only the next player may take a chow');

  const fresh = (min, seed) => { const x = E.newHand({ rnd: seeded(seed || 2), dealer: 0, min }); return x; };
  t = fresh(3);
  t.hands[0] = tiles('1m5m234p567s99s1z2z3z4z'); t.hands[2] = tiles('55m234p567s99s1z2z3z'); E.sortTiles(t.hands[0]); E.sortTiles(t.hands[2]);
  E.discard(t, 0, K('5m'));
  check(t.claims[2].pung && !t.claims[2].kong && !t.claims[1].pung, 'mahjong4: a pair in hand can claim a pung');
  check(E.resolve(t, { 2: { type: 'pung' } }) === 'pung' && t.turn === 2 && t.melds[2].length === 1 && t.melds[2][0].type === 'pung' && t.melds[2][0].open && t.hands[2].length === 11 && t.discards[0].length === 0 && t.phase === 'discard', 'mahjong4: a pung takes the tile into three on show, and the claimant discards');
  t = fresh(3);
  E.discard(t, 0, t.hands[0][0]);
  check(E.resolve(t, {}) === 'next' && t.turn === 1 && t.hands[1].length === 14 && t.lastDrawn !== null && t.phase === 'discard', 'mahjong4: with no claim, the next player draws');

  // A win beats a pung; the discarder pays double.
  t = fresh(1, 4);
  t.hands[1] = tiles('23m456m789m123p11s'); t.hands[2] = tiles('11m234p567s99s1z2z3z');
  t.hands[0] = tiles('1m5m234p567s99s1z2z3z4z');
  E.discard(t, 0, K('1m'));
  check(t.claims[1].win && t.claims[1].win.faan >= 1 && t.claims[2].pung, 'mahjong4: a waiting hand may win on the discard, and a pair may pung it');
  const ended = E.resolve(t, { 1: { type: 'win' }, 2: { type: 'pung' } });
  const pay = t.result.points, base = E.pointsFor(t.result.faan);
  check(ended === 'win' && t.result.winner === 1 && t.result.from === 0 && pay[1] === 2 * base && pay[0] === -2 * base && pay[2] === 0 && pay[3] === 0, 'mahjong4: a win beats a pung, the discarder pays double and the others nothing (' + pay.join(', ') + ')');
  // Under the three faan minimum the same hand is no win.
  t = fresh(3, 4);
  t.hands[1] = tiles('23m456m789m123p11s'); t.hands[0] = tiles('1m5m234p567s99s1z2z3z4z');
  E.discard(t, 0, K('1m'));
  check(t.claims[1].win === null, 'mahjong4: a common hand on a discard does not reach three faan');
  // Self-drawn: all three pay.
  t = fresh(1, 5);
  t.hands[0] = tiles('123m456m789m123p1s1s'); t.lastDrawn = K('1s');
  check(E.selfOptions(t, 0).win && E.selfOptions(t, 0).win.faan === 3, 'mahjong4: the player who drew the winning tile may declare it');
  const res = E.declareWin(t, 0, false);
  check(res.from === null && res.points[0] === 3 * E.pointsFor(3) && res.points[1] === -E.pointsFor(3) && res.points.reduce((a, b) => a + b) === 0, 'mahjong4: a self-drawn win is paid by all three');
  // Kongs.
  t = fresh(3, 6);
  t.hands[0] = tiles('1111m234p567s99s1z2z'); E.sortTiles(t.hands[0]);
  check(same(E.selfOptions(t, 0).concealedKongs, [K('1m')]), 'mahjong4: four of a kind in hand may be declared a kong');
  const deadBefore = t.dead.length;
  check(E.declareKong(t, 0, K('1m')) && t.melds[0][0].type === 'kong' && t.hands[0].length === 11 && t.dead.length === deadBefore - 1 && t.replacement, 'mahjong4: a kong takes a replacement tile from the dead wall');

  // The computers.
  t = fresh(3, 8);
  t.hands[0] = tiles('1122334455m66m7m4z'); E.sortTiles(t.hands[0]);
  check(E.aiDiscard(t, 0, 'medium') === K('4z'), 'mahjong4: the computer lets go of a lone wind from a hand of characters');
  t = fresh(3, 9);
  t.hands[0] = tiles('123m456m789m123p1s1s'); t.lastDrawn = K('1s');
  check(E.aiSelf(t, 0, 'easy').type === 'win', 'mahjong4: the computer declares a win when it has one');
  {
    let finished = 0, wins = 0, draws = 0, sound = true, lowFaan = false, hands = 100;
    for (let g = 0; g < hands; g++) {
      const tb = E.newHand({ rnd: seeded(100 + g), dealer: g % 4, min: 3 }), levels = ['easy', 'medium', 'hard', 'medium'];
      let guard = 0;
      while (!tb.result && guard++ < 500) {
        if (E.tilesInPlay(tb) !== 136) { sound = false; break; }
        const p = tb.turn, lv = levels[p];
        if (tb.phase === 'discard') {
          const self = E.aiSelf(tb, p, lv);
          if (self && self.type === 'win') { E.declareWin(tb, p, false); break; }
          if (self && self.type === 'kong') { E.declareKong(tb, p, self.k); continue; }
          if (!E.discard(tb, p, E.aiDiscard(tb, p, lv))) { sound = false; break; }
        } else {
          const picks = {};
          for (let q = 0; q < 4; q++) if (q !== tb.lastDiscard.from) { const c = E.aiClaim(tb, q, levels[q]); if (c) picks[q] = c; }
          E.resolve(tb, picks);
        }
      }
      if (tb.result) {
        finished++;
        if (tb.result.type === 'win') { wins++; if (tb.result.faan < 3 || tb.result.points.reduce((a, b) => a + b, 0) !== 0) lowFaan = true; } else draws++;
      }
    }
    check(sound && !lowFaan && finished === hands, 'mahjong4: ' + hands + ' hands between four computers all end, with tiles conserved and every win at three faan or more (' + wins + ' won, ' + draws + ' drawn)');
    check(wins >= hands * 0.15, 'mahjong4: the computers do win hands under a three faan minimum (' + wins + ' of ' + hands + ')');
  }
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
