// ZimiGames card art, measured in WebKit at 3x: backs are centred and symmetric where they are drawn symmetric, the Zimi
// back's Z sits on the cartouche's centre at every size, the court art is scaled evenly, and no shared rule moves SVG geometry.
// Eric, 2026-10-26: "I need pixel perfection here. This is art." A shared `.zc-bk * { transform-box: fill-box }` had
// moved every transform attribute in the backs (the Z, the lower halves of deco and seigaiha, guilloche's roses).
//
// Run: NODE_PATH=node_modules node tests/test_games_pixels.cjs   (exit 0 = pass; skips when WebKit is not installed)

const fs = require('fs'), path = require('path'), http = require('http');
const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const ok = (label, cond, detail) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : '')); if (!cond) failures++; };

// 1. Static: transform-box may only be set on the parts that animate about their own centre.
const css = fs.readFileSync(path.join(dir, 'cards.css'), 'utf8');
const boxRules = css.split('\n').filter(l => /transform-box:\s*fill-box/.test(l));
ok('cards.css sets fill-box only on the animated parts', boxRules.length === 1 && /^\.zc-boat, \.zc-eye, \.zc-arm, \.zc-wing \{/.test(boxRules[0]), boxRules.join(' | '));

let chromium;
try { chromium = require('playwright').webkit; } catch (e) { console.log('SKIP  playwright is not installed'); process.exit(failures ? 1 : 0); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const harness = '<!doctype html><meta charset=utf-8><link rel=stylesheet href="/games.css"><link rel=stylesheet href="/cards.css">' +
  '<body class="zc-game" style="margin:0;background:#fff;overflow:visible;height:auto;display:block"><script src="/text.js"></script><script src="/cardbacks.js"></script>' +
  '<script src="/courts.js"></script><script src="/courts-es.js"></script><script src="/hanafuda-art.js"></script><script src="/cards.js"></script><div id=box style="padding:20px"></div><script>ZimiCards.ensureSprite();' +
  'window.show=function(id,cw){var c=document.createElement("div");c.className="zc-card zc-down";c.style.cssText="position:relative;left:0;top:0;--cw:"+cw+"px;width:"+cw+"px;height:"+(cw*1.4)+"px";' +
  'c.innerHTML="<div class=zc-back>"+ZimiCards.backMarkup(id)+"</div>";var b=document.getElementById("box");b.innerHTML="";b.appendChild(c);' +
  'document.querySelectorAll(".zc-bk *").forEach(function(e){e.style.animation="none"});};</script>';
const server = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/h.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(harness); }
  fs.readFile(path.join(dir, u), (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': TYPES[path.extname(u)] || 'text/plain' }); r.end(d); });
});

(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log('SKIP  WebKit is not installed'); server.close(); process.exit(failures ? 1 : 0); }
  const page = await (await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 400, height: 500 } })).newPage();
  const decoder = await (await browser.newContext()).newPage();
  await page.goto(base + '/h.html');
  // A screenshot's pixels: [width, height, rgba bytes as base64].
  async function pixels(id, cw) {
    await page.evaluate(([i, c]) => show(i, c), [id, cw]);
    const png = await page.locator('.zc-card').screenshot();
    return decoder.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: Array.from(cx.getImageData(0, 0, img.width, img.height).data) };
    }, png.toString('base64'));
  }
  const px = (im, x, y) => { const i = (y * im.w + x) * 4; return [im.d[i], im.d[i + 1], im.d[i + 2]]; };
  const mismatch = (im, map) => { let n = 0; for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const a = px(im, x, y), b = px(im, ...map(x, y)); if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 60) n++; } return n; };

  // 2. Symmetry of the backs drawn symmetric, at the full size (100 px, 300 device px).
  for (const [id, both] of [['classic', true], ['guilloche', true], ['deco', true], ['seigaiha', true], ['zellige', true], ['robot', false]]) {
    const im = await pixels(id, 100);
    const lr = mismatch(im, (x, y) => [im.w - 1 - x, y]);
    ok(id + ' back is the same mirrored left to right', lr < 40, lr + ' px differ');
    if (both) { const r = mismatch(im, (x, y) => [im.w - 1 - x, im.h - 1 - y]); ok(id + ' back is the same turned half a turn', r < 40, r + ' px differ'); }
  }

  // 3. The Zimi back's Z: its orange bounding box is centred on the cartouche (the card's centre) at every size.
  for (const cw of [100, 52, 40, 30]) {
    const im = await pixels('zimi', cw), s = 3 * cw / 100, cx = 50 * s, cy = 70 * s;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
      if (Math.abs(x + .5 - cx) > 12 * s || Math.abs(y + .5 - cy) > 14 * s) continue;
      const [r, g, b] = px(im, x, y);
      if (r > 180 && b < 120 && r - b > 80) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
    }
    const dx = (x0 + x1) / 2 - cx, dy = (y0 + y1) / 2 - cy;
    ok('Zimi back Z is centred at ' + cw + 'px', x1 > 0 && Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5, 'off (' + dx.toFixed(2) + ', ' + dy.toFixed(2) + ') device px');
  }
  const browser2 = browser;

  // 4. The court art is scaled evenly: never preserveAspectRatio="none", and the frame it fills is the box it covers.
  const vm = require('vm'), sb = { console }; sb.window = sb; vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(dir, 'courts.js'), 'utf8'), sb);
  const king = sb.ZimiCourts.markup('king', 3);
  const rects = [...king.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="none" class="zc-rule"/g)];
  const svgs = [...king.matchAll(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" viewBox="0 0 (\d+) (\d+)" preserveAspectRatio="([^"]*)"/g)];
  ok('court art svgs found', svgs.length === 2 && rects.length === 1);
  svgs.forEach(m => {
    ok('court art is never stretched', m[7] === 'xMidYMid slice', m[7]);
    const scale = Math.max(m[3] / m[5], m[4] / m[6]), lost = (m[6] * scale - m[4]) / 2;   // units cut at top and bottom by the cover
    ok('court art covers its frame and loses under 0.5 units at each end', m[3] / m[5] <= scale + 1e-9 && lost >= 0 && lost < 0.5, lost.toFixed(2) + ' units');
  });
  // The frame is a plain rectangle (one rect, no stepped path), inset 22 units from the sides, centred, the art's own box.
  const [fx, fy, fw, fh] = rects[0].slice(1).map(Number);
  const RULE = 0.5; // the rule runs inside the art's edge, half its width in, so its outer edge is the column's edge (22)
  ok('court frame is a plain rectangle inset by the index column, centred', fx === 22 + RULE / 2 && fw === 56 - RULE && Math.abs(fy + fh / 2 - 70) < 1e-9 && Math.abs(fx + fw / 2 - 50) < 1e-9, [fx, fy, fw, fh].join(' '));
  ok('court art box is the frame', svgs.every(m => +m[1] === fx - RULE / 2 && +m[3] === fw + RULE && +m[4] === fh + RULE) && +svgs[0][2] === fy - RULE / 2);
  ok('court frame holds no path (no notch)', !/<path[^>]*class="zc-rule"/.test(king));
  const spanish = new vm.Script(fs.readFileSync(path.join(dir, 'courts-es.js'), 'utf8')); spanish.runInContext(sb);
  // The Spanish print is the picture inside its frame (the scans' own broken frame is left out), as wide as the French frame, centred,
  // with a clean continuous rule of ours inside its edge.
  const esMark = sb.ZimiSpanishCourts.markup(8, 0), pic = esMark.match(/<image href="[^"]+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/), esRule = esMark.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="none" class="zc-rule" stroke="#1b1b1b"/);
  ok('Spanish picture is as wide as the frame, centred', pic && +pic[1] === 22 && +pic[3] === 56 && Math.abs(+pic[2] + +pic[4] / 2 - 70) < 1e-9, pic && pic.slice(1).join(' '));
  ok('Spanish rule is one plain rectangle along the picture\'s edge, on the inside', pic && esRule && +esRule[1] === +pic[1] + RULE / 2 && +esRule[3] === +pic[3] - RULE && +esRule[2] === +pic[2] + RULE / 2 && +esRule[4] === +pic[4] - RULE && (esMark.match(/class="zc-rule"/g) || []).length === 1);
  ok('court frame is a crisp rule', /<rect[^>]*class="zc-rule"/.test(king));
  const backs = fs.readFileSync(path.join(dir, 'cardbacks.js'), 'utf8');
  ok('the backs\' band rules are crisp rules', (backs.match(/class: 'zc-rule'/g) || []).length === 2);
  ok('crisp rules snap to the device pixel', /\.zc-rule \{[^}]*vector-effect: non-scaling-stroke[^}]*crispEdges[^}]*var\(--zc-px/.test(css));

  // 5. The index's top: flat ranks start at the 5.5 inset and rounds overshoot it by under 0.3, never touching the edge.
  const cb = await browser2.newContext({ deviceScaleFactor: 1 }).then(c => c.newPage());
  await cb.goto(base + '/h.html');
  // 4b. The number cards' pips share the court frame's edges: the sparse pips' outer ink is the frame's width (22..78) and their rows sit
  // within 7 units of its height (27..113), every card (the pips of one card are measured with the index's column cut away).
  const pipInk = await cb.evaluate(async () => {
    const S = 8, out = {};
    for (const [name, id] of [['7H', 6 + 26], ['7C', 6], ['6S', 5 + 39], ['3H', 2 + 26], ['10H', 9 + 26], ['10C', 9]]) {
      const doc = new DOMParser().parseFromString(ZimiCards.faceMarkup(id, true), 'image/svg+xml'), root = doc.documentElement;
      root.querySelectorAll('.zc-idx-std').forEach(g => g.remove()); root.setAttribute('width', 100 * S); root.setAttribute('height', 140 * S);
      const svg = new XMLSerializer().serializeToString(root);
      const img = new Image(); img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); await img.decode();
      const cv = document.createElement('canvas'); cv.width = 100 * S; cv.height = 140 * S; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, 100 * S, 140 * S).data; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let y = 0; y < 140 * S; y++) for (let x = 0; x < 100 * S; x++) {
        const i = (y * 100 * S + x) * 4; if (d[i + 3] < 128 || d[i] + d[i + 1] + d[i + 2] > 450) continue; // ink only, not the card's cream or its edge
        if (y < 3 * S || y > 137 * S || x < 3 * S || x > 97 * S) continue; // the card's edge
        x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
      }
      out[name] = [x0 / S, x1 / S, y0 / S, y1 / S];
    }
    return out;
  });
  for (const [name, [x0, x1, y0, y1]] of Object.entries(pipInk)) {
    ok('pips of ' + name + ' stay within the court frame\'s width and 7 units of its height', x0 >= 21.4 && x1 <= 78.6 && y0 >= 20 && y1 <= 120, [x0, x1, y0, y1].join(' '));
    if (name === '7H' || name === '7C') ok('outer pips of ' + name + ' reach the frame\'s edges (22 and 78) within a unit', Math.abs(x0 - 22) <= 1 && Math.abs(x1 - 78) <= 1, [x0, x1].join(' '));
  }

  const tops = await cb.evaluate(async () => {
    const S = 8, out = {};
    for (const r of 'A23456789TJQK') {
      const id = 39 + 'A23456789TJQK'.indexOf(r);
      const svg = ZimiCards.faceMarkup(id, true).replace('<svg ', '<svg width="' + 100 * S + '" height="' + 140 * S + '" ');
      const img = new Image(); img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); await img.decode();
      const cv = document.createElement('canvas'); cv.width = 100 * S; cv.height = 140 * S; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, 100 * S, 30 * S).data; let top = 1e9;
      for (let y = 3 * S; y < 30 * S; y++) for (let x = 3 * S; x < 30 * S; x++) { const i = (y * 100 * S + x) * 4; if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100 && y < top) top = y; }
      out[r] = top / S;
    }
    return out;
  });
  for (const [r, t] of Object.entries(tops)) {
    // Barlow's A and 4 are flat at the cap line, and its rounds (2 3 5 6 8 9 0 Q) overshoot it by up to 0.3 units (at 1.2 scale).
    ok('index ' + r + ' top inset', t >= 5.5 - 0.3 && t <= 5.5 + 0.13, t.toFixed(2));
  }

  // 6. The index has a column of its own: on every court (French, Spanish), no art or frame ink comes within
  // CLEAR units of the index's ink. Each part of the index (the glyph, then the suit below it) is measured on a render of the index
  // alone and checked against a render of the art alone (index removed).
  const CLEAR = 1.5;
  const clear = await cb.evaluate(async (CLEAR) => {
    const S = 8, W = 100 * S, H = 140 * S, out = [];
    const render = async (svg) => {
      const img = new Image(); img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); await img.decode();
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d'); cx.fillStyle = '#fdfcf8'; cx.fillRect(0, 0, W, H); cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, W, H).data;
    };
    const variant = (markup, keep) => {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml'), svg = doc.documentElement;
      if (keep === 'index') [...svg.children].forEach(c => { if (!/zc-idx-std/.test(c.getAttribute('class') || '') && c.tagName !== 'defs' && c.tagName !== 'rect') c.remove(); });
      else svg.querySelectorAll('.zc-idx-std').forEach(g => g.remove());
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      return new XMLSerializer().serializeToString(svg);
    };
    const dark = (d, x, y) => { const i = (y * W + x) * 4; return d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200; };
    const far = (d, x, y) => { const i = (y * W + x) * 4; return Math.abs(d[i] - 253) + Math.abs(d[i + 1] - 252) + Math.abs(d[i + 2] - 248) > 40; };
    const cases = [];
    for (let id = 0; id < 52; id++) if (id % 13 > 9) cases.push(['French ' + 'JQK'[id % 13 - 10] + 'CDHS'[Math.floor(id / 13)], ZimiCards.faceMarkup(id, true)]);
    for (let id = 0; id < 40; id++) if (id % 10 > 6) cases.push(['Spanish ' + id, ZimiCards.spanishFaceMarkup(id, true)]);
    for (const [name, markup] of cases) {
      const idx = await render(variant(markup, 'index')), art = await render(variant(markup, 'art'));
      const rows = []; for (let y = 3 * S; y < 70 * S; y++) { let a = 1e9, b = -1; for (let x = 3 * S; x < 50 * S; x++) if (dark(idx, x, y)) { a = Math.min(a, x); b = Math.max(b, x + 1); } if (b >= 0) rows.push([y, a, b]); }
      const parts = [[]]; rows.forEach((r, i) => { if (i && r[0] - rows[i - 1][0] > 1.5 * S) parts.push([]); parts[parts.length - 1].push(r); });
      let worst = 1e9;
      parts.forEach(p => {
        const x0 = Math.min(...p.map(r => r[1])) - CLEAR * S, x1 = Math.max(...p.map(r => r[2])) + CLEAR * S, y0 = p[0][0] - CLEAR * S, y1 = p[p.length - 1][0] + 1 + CLEAR * S;
        for (let y = Math.max(3 * S, Math.floor(y0)); y < y1; y++) for (let x = Math.max(3 * S, Math.floor(x0)); x < x1; x++) if (far(art, x, y)) { worst = Math.min(worst, 0); }
      });
      out.push([name, parts.length, worst === 0 ? 'art within ' + CLEAR : 'ok']);
    }
    return out;
  }, CLEAR);
  const hit = clear.filter(r => r[2] !== 'ok'), thin = clear.filter(r => r[1] < 2);
  ok('every court (' + clear.length + ') keeps art and frame ' + CLEAR + ' units from the index', hit.length === 0, hit.map(r => r[0]).join(', '));
  ok('the index was measured as glyph and suit', thin.length === 0, thin.map(r => r[0]).join(', '));

  // 7. Hanafuda: the art and its border are whole. There is no plate cut into a corner; the month is a seal laid over the corner (it hides
  // under 2 percent of the art and none of the border's sides) and the kind's mark stands in the white margin, clear of the art's box.
  const art = await cb.evaluate(async () => {
    const S = 8, W = 100 * S, H = 140 * S, out = {};
    const render = async (svg) => {
      const img = new Image(); img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); await img.decode();
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d'); cx.fillStyle = '#fdfcf8'; cx.fillRect(0, 0, W, H); cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, W, H).data;
    };
    let plates = 0, covered = 0, kindInArt = 0, edgeCut = 0, n = 0;
    const m = ZimiHanafudaArt.markup(0).match(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/), bx = +m[1], by = +m[2], bw = +m[3], bh = +m[4];
    for (let id = 0; id < 48; id++) {
      const markup = ZimiCards.hanafudaFaceMarkup(id, true), doc = new DOMParser().parseFromString(markup, 'image/svg+xml'), svg = doc.documentElement;
      plates += svg.querySelectorAll('.zc-plate').length;
      const std = svg.querySelector('.zc-idx-std'), seal = std.querySelector('circle');
      // the kind's mark (everything in the index but the seal's disc and number) lies left of the art's box
      const kindBox = [...std.children].slice(2).map(e => { const t = e.getBBox ? e : null; return t; });
      std.remove(); svg.querySelectorAll('.zc-idx-std').forEach(g => g.remove());
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      const without = await render(new XMLSerializer().serializeToString(svg));
      const full = await render(markup.replace('<svg ', '<svg width="' + W + '" height="' + H + '" '));
      // ink of the art (not cream) hidden by the index, as a share of the art's box
      let hidden = 0, ink = 0;
      for (let y = Math.floor(by * S); y < (by + bh) * S; y++) for (let x = Math.floor(bx * S); x < (bx + bw) * S; x++) {
        const i = (y * W + x) * 4, j = i;
        const a = Math.abs(without[i] - 253) + Math.abs(without[i + 1] - 252) + Math.abs(without[i + 2] - 248) > 40;
        const b = Math.abs(full[i] - without[i]) + Math.abs(full[i + 1] - without[i + 1]) + Math.abs(full[i + 2] - without[i + 2]) > 40;
        if (a) ink++; if (b) hidden++;
      }
      covered = Math.max(covered, hidden / ((bw * S) * (bh * S)));
      // the left and top sides of the border, midway along each, are untouched by the index
      const same = (x, y) => { const i = (Math.floor(y * S) * W + Math.floor(x * S)) * 4; return Math.abs(full[i] - without[i]) + Math.abs(full[i + 1] - without[i + 1]) + Math.abs(full[i + 2] - without[i + 2]) < 12; };
      if (![[bx + 0.6, 70], [50, by + 0.6], [bx + 0.6, 40], [bx + 0.6, 100]].every(p => same(p[0], p[1]))) edgeCut++;
      n++;
    }
    return { plates, covered, edgeCut, n };
  });
  ok('Hanafuda has no cream plate cut into the art', art.plates === 0, art.plates);
  ok('Hanafuda\'s seal and mark (two corners) hide under 3 percent of the art (' + (art.covered * 100).toFixed(2) + '%)', art.covered < 0.03, art.covered);
  ok('Hanafuda\'s border keeps its sides whole on all 48 cards', art.edgeCut === 0, art.edgeCut + ' cards');

  // 8. Spanish courts: the picture's edge is blank paper (no remnant of the scan's broken frame; ours is the only rule), and the ink keeps
  // the print's colour (the paper is lifted to cream, the ink is not): the mean chroma of the coloured pixels stays high.
  const es = await cb.evaluate(async () => {
    const out = [];
    for (let k = 7; k < 10; k++) for (let suit = 0; suit < 4; suit++) {
      const m = ZimiSpanishCourts.markup(k, suit).match(/href="([^"]+)"/);
      const img = new Image(); img.src = m[1]; await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, img.width, img.height).data; let edge = 0, chroma = 0, n = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (x < 6 || y < 6 || x >= img.width - 6 || y >= img.height - 6) edge = Math.max(edge, 253 - mn);
        if (mx - mn > 60) { chroma += mx - mn; n++; }
      }
      out.push([k + ',' + suit, edge, n ? chroma / n : 0]);
    }
    return out;
  });
  ok('Spanish pictures have blank paper at the edge (no printed-frame remnant)', es.every(r => r[1] < 24), es.filter(r => r[1] >= 24).map(r => r[0] + ':' + r[1]).join(' '));
  ok('Spanish pictures keep the print\'s colour (mean chroma of coloured pixels above 108; the 1860 flat-field gave 97)', es.every(r => r[2] > 108), es.map(r => r[0] + ':' + Math.round(r[2])).join(' '));

  // 9. Index spacing, measured in rendered ink (the standalone face drawn as an image, the index's glyph alone and the Hanafuda ring alone).
  // Two-digit ranks (10; Spanish 10, 11, 12; Hanafuda months 10, 11, 12): clear space between the digits of at least one stroke width at
  // every size and density. Hanafuda: the number's ink keeps MIN_RING units from the seal ring's inner edge.
  const MIN_RING = 1.5;
  const spacing = await cb.evaluate(async (MIN_RING) => {
    const out = { digits: [], ring: [], sizes: [] }, DIGIT_GAP = 2.25; // glyph units: the clear paper drawn between the digits (one heavy stem, 2.5, less a hair)
    const draw = async (svgText, w) => {
      const img = new Image(); img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgText); await img.decode();
      const cv = document.createElement('canvas'); cv.width = w; cv.height = Math.round(w * 1.4); const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, d: cx.getImageData(0, 0, cv.width, cv.height).data };
    };
    // The face with only the listed elements of the first index kept (by tag order within .zc-idx-std).
    const only = (markup, keep, w, grp) => {
      grp = grp || 'zc-idx-std';
      const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
      [...svg.children].forEach(c => { if (!new RegExp(grp).test(c.getAttribute('class') || '') && c.tagName !== 'defs') c.remove(); });
      const gs = [...svg.querySelectorAll('.' + grp)]; gs.slice(1).forEach(g => g.remove());
      const g = gs[0]; g.removeAttribute('display'); g.removeAttribute('transform'); [...g.children].forEach((c, i) => { if (!keep(c, i)) c.remove(); });
      if (g.querySelector('circle')) g.querySelectorAll('circle').forEach(c => { if (c.getAttribute('fill') !== 'none') c.setAttribute('fill', 'none'); });
      svg.setAttribute('width', w); svg.setAttribute('height', Math.round(w * 1.4));
      return new XMLSerializer().serializeToString(svg);
    };
    const glyphOnly = (c) => c.tagName === 'path' && c.getAttribute('class') === 'zc-gl';
    // Runs of inked columns in the glyph's rows (the top 40 units: glyph, not the suit below).
    const runs = (im, ppu, thr) => {
      const cols = []; for (let x = 0; x < im.w; x++) { let on = false; for (let y = 0; y < 60 * ppu && y < im.h; y++) if (im.d[(y * im.w + x) * 4 + 3] > thr) { on = true; break; } cols.push(on); }
      const r = []; cols.forEach((on, x) => { if (on) { if (r.length && r[r.length - 1][1] === x) r[r.length - 1][1] = x + 1; else r.push([x, x + 1]); } });
      return r;
    };
    const cases = [];
    for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) cases.push(['French ' + 'A23456789 '.charAt(id).trim() + (id === 9 ? '10' : ''), s => ZimiCards.faceMarkup(id, s), id === 9 ? 2 : 1, false]);
    [7, 8, 9].forEach(k => cases.push(['Spanish ' + (k + 3), s => ZimiCards.spanishFaceMarkup(k, s), 2, false]));
    for (let m = 0; m < 12; m++) cases.push(['Hanafuda ' + (m + 1), s => ZimiCards.hanafudaFaceMarkup(m * 4, s), m >= 9 ? 2 : 1, true]);
    for (const [name, make, digits, hana] of cases) for (const grp of ['zc-idx-std', 'zc-idx-row']) {
      const markup = make(grp === 'zc-idx-std').replace(/^<svg (?!xmlns)/, '<svg xmlns="http://www.w3.org/2000/svg" '), label = name + (grp === 'zc-idx-row' ? ' (row)' : '');
      const scale = +markup.match(new RegExp(grp + '[^>]*>(?:<circle[^>]*\\/>)?<path class="zc-gl" transform="[^"]*scale\\(([\\d.]+)\\)"'))[1], stroke = DIGIT_GAP * scale;
      for (const [cw, dpr] of [[200, 1], [200, 2], [200, 3], [52, 1], [52, 2], [52, 3], [800, 1]]) {
        const w = cw * dpr, ppu = w / 100;
        const gim = await draw(only(markup, glyphOnly, w, grp), w), rs = runs(gim, ppu, 128);
        let gap = null; if (digits === 2) gap = rs.length === 2 ? (rs[1][0] - rs[0][1]) / ppu : 0;
        if (digits === 2) out.digits.push([label, cw + '@' + dpr, rs.length === 2, gap, stroke, ppu]);
        if (hana && cw >= 200) {
          const c = markup.match(new RegExp(grp + '[^>]*><circle cx="([\\d.]+)" cy="([\\d.]+)" r="([\\d.]+)"')), cx = +c[1], cy = +c[2], r = +c[3], rin = r - 0.55;
          let worst = 1e9;
          for (let y = 0; y < gim.h; y++) for (let x = 0; x < gim.w; x++) if (gim.d[(y * gim.w + x) * 4 + 3] > 40) worst = Math.min(worst, rin - Math.hypot((x + .5) / ppu - cx, (y + .5) / ppu - cy));
          out.ring.push([label, cw + '@' + dpr, worst, r]);
        }
      }
    }
    return out;
  }, MIN_RING);
  const sorted = (a, k) => a.slice().sort((x, y) => x[k] - y[k]);
  const dg = spacing.digits.filter(r => r[3] !== null);
  const tol = r => 1 / r[5];   // one device pixel of quantisation
  const badDigits = dg.filter(r => !(r[2] && r[3] >= r[4] - tol(r) && r[3] * r[5] >= 1));
  const names = [...new Set(dg.map(r => r[0]))];
  ok('every two-digit index (' + names.length + ': ' + names.join(', ') + ') keeps the drawn gap (2.25 glyph units, about one stem) of clear ink between its digits at 200 and 52 px, 1x 2x 3x', badDigits.length === 0,
    badDigits.slice(0, 6).map(r => r[0] + ' ' + r[1] + ' gap ' + (r[3] || 0).toFixed(2) + ' of ' + r[4].toFixed(2)).join('; '));
  console.log('INFO  narrowest digit gap (800px render) ' + sorted(dg.filter(r => r[1] === '800@1'), 3).map(r => r[0] + ' ' + r[3].toFixed(2) + '/' + r[4].toFixed(2)).join(', '));
  const ringW = sorted(spacing.ring.filter(r => r[1] === '200@3'), 2);
  const badRing = spacing.ring.filter(r => r[2] < MIN_RING - 0.1);
  ok('Hanafuda numerals keep ' + MIN_RING + ' units from the ring\'s inner edge (all twelve months)', badRing.length === 0, badRing.slice(0, 6).map(r => r[0] + ' ' + r[1] + ' ' + r[2].toFixed(2)).join('; '));
  console.log('INFO  tightest numeral to ring (200px 3x) ' + ringW.slice(0, 4).map(r => r[0] + ' ' + r[2].toFixed(2)).join(', '));

  await browser2.close();

  server.close();
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
