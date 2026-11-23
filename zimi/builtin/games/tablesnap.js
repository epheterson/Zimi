/* ZimiGames: the table as a picture. A board game built from page elements (squares, pieces, dice, tiles) is painted as a
   small svg of what is on the page: each element's colour and corners as a rectangle, each piece as the svg it is, each
   word as text. The shell asks for it when a game is left under way (ZimiTableSnap.picture(), for the shelf's live
   tile). Our own code, GPL-3.0. No network, no modules. */
(function (root) {
  'use strict';
  var W = 320, H = 180, PAD = 6;                  // the tile's 16 by 9 picture and the margin round the table
  var FRAME_GROWTH = 1.2;                         // a parent this much bigger or less is the table's own frame
  var MAX_CHARS = 90000;                          // a table that paints bigger than this keeps the tile's art
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var DEFAULT_PAINT = { fill: 'rgb(0, 0, 0)', stroke: 'none', 'stroke-width': '1px', 'fill-opacity': '1', 'stroke-opacity': '1', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' };
  var TEXT_PROPS = ['font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline'];   // the class that sized a label is gone
  var INHERITED = Object.keys(DEFAULT_PAINT);
  var PAINT_ATTRS = INHERITED.concat(['opacity']);
  var DEFINITIONS = 'defs, symbol, clipPath, mask, pattern, marker, linearGradient, radialGradient';
  // What a page's table is called: boards and grids by role or class, and the public middle of a card-less table (a chain, a pool,
  // a bid, a score card), never a hand or a secret.
  var TABLE_SELECTOR = ['[role="grid"]', '.bg-board', '.wk-board', '.tf-board', '.su-board', '.fl-board', '.cw-grid', '.ms-board', '.sk-board', '.ec-board',
    '.dm-table', '.mj-table', '.m4-pool', '#cb-rows', '#yc-card', '.ld-bid', '#stage', 'main > svg', 'main svg.board'].join(', ');

  function num(v) { return Math.round(v * 10) / 10; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  // 'rgba(r, g, b, a)' or 'rgb(r, g, b)' → its alpha, 0 for transparent
  function alpha(c) { var m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return 0; var p = m[1].split(/[ ,\/]+/); return p.length > 3 ? parseFloat(p[3]) : 1; }
  // A gradient's one colour: the second it names, which is the body of a lit disc (the first is its highlight).
  function gradientColor(image) {
    var all = (image || '').match(/rgba?\([^)]*\)/g);
    return all ? all[Math.min(1, all.length - 1)] : '';
  }
  function visible(cs, r) { return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.02 && r.width > 0.5 && r.height > 0.5; }
  function radius(cs, r) {
    var v = parseFloat(cs.borderTopLeftRadius) || 0;
    return /%/.test(cs.borderTopLeftRadius) ? Math.min(r.width, r.height) * v / 100 : Math.min(v, Math.min(r.width, r.height) / 2);
  }

  // A piece that is an <svg>: its own drawing, with every colour as the page shows it (a var() resolved), at its place.
  function pieceSvg(el, r, o) {
    var clone = el.cloneNode(true), from = [el].concat([].slice.call(el.querySelectorAll('*'))), to = [clone].concat([].slice.call(clone.querySelectorAll('*')));
    for (var i = 0; i < from.length; i++) {
      if (from[i] !== el && from[i].closest(DEFINITIONS)) continue;   // what a <use> or a gradient draws from keeps its own paint
      var cs = root.getComputedStyle(from[i]), up = i ? root.getComputedStyle(from[i].parentElement) : null, st = '';
      // Only what differs from what the parent already passes down: a drawing's paint is mostly inherited.
      INHERITED.forEach(function (p) { var v = cs.getPropertyValue(p); if (v !== (up ? up.getPropertyValue(p) : DEFAULT_PAINT[p])) st += p + ':' + v + ';'; });
      if (cs.opacity !== '1') st += 'opacity:' + cs.opacity + ';';
      if (cs.vectorEffect !== 'none') st += 'vector-effect:' + cs.vectorEffect + ';';   // a hairline that stays a hairline at any scale
      if (/^(text|tspan)$/i.test(from[i].tagName)) TEXT_PROPS.forEach(function (p) { st += p + ':' + cs.getPropertyValue(p) + ';'; });
      to[i].removeAttribute('style'); to[i].removeAttribute('class');
      PAINT_ATTRS.forEach(function (a) { to[i].removeAttribute(a); });   // a var() in an attribute means nothing here: the style carries the colour
      if (st) to[i].setAttribute('style', st);
    }
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 ' + (parseFloat(el.getAttribute('width')) || r.width) + ' ' + (parseFloat(el.getAttribute('height')) || r.height));
    clone.setAttribute('x', num(r.left - o.x)); clone.setAttribute('y', num(r.top - o.y));
    clone.setAttribute('width', num(r.width)); clone.setAttribute('height', num(r.height));
    clone.setAttribute('xmlns', SVG_NS);
    return new root.XMLSerializer().serializeToString(clone).replace(/ xmlns="[^"]*"/, '');
  }

  function words(el, o) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      var rg = el.ownerDocument.createRange(); rg.selectNodeContents(n);
      var r = rg.getBoundingClientRect(), cs = root.getComputedStyle(el);
      if (r.width < 1 || r.height < 1) continue;
      out += '<text x="' + num(r.left + r.width / 2 - o.x) + '" y="' + num(r.top + r.height / 2 - o.y) + '" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="' +
        num(parseFloat(cs.fontSize) || 12) + '" font-weight="' + cs.fontWeight + '" fill="' + cs.color + '">' + esc(n.nodeValue.trim()) + '</text>';
    }
    return out;
  }

  function children(el, o) {
    var out = '';
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) out += paint(c, o);
    return out;
  }

  function paint(el, o) {
    var cs = root.getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.display === 'contents') return children(el, o);   // a row that takes no room: its cells are the table's
    if (!visible(cs, r) || cs.clip !== 'auto') return '';   // clip: rect(0 0 0 0) hides words kept for a screen reader
    var out = '', x = num(r.left - o.x), y = num(r.top - o.y), rx = num(radius(cs, r));
    var shape = ' x="' + x + '" y="' + y + '" width="' + num(r.width) + '" height="' + num(r.height) + '" rx="' + rx + '"';
    var op = parseFloat(cs.opacity);
    if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() === 'svg') return o.coarse ? '' : pieceSvg(el, r, o);   // coarse: the bodies without their drawings
    var fill = alpha(cs.backgroundColor) > 0 ? cs.backgroundColor : gradientColor(cs.backgroundImage);
    if (fill) out += '<rect' + shape + ' fill="' + fill + '"/>';
    if (parseFloat(cs.borderTopWidth) > 0 && alpha(cs.borderTopColor) > 0 && cs.borderTopStyle !== 'none') {
      var bw = parseFloat(cs.borderTopWidth);
      out += '<rect x="' + num(r.left - o.x + bw / 2) + '" y="' + num(r.top - o.y + bw / 2) + '" width="' + num(r.width - bw) + '" height="' + num(r.height - bw) + '" rx="' + rx + '" fill="none" stroke="' + cs.borderTopColor + '" stroke-width="' + num(bw) + '"/>';
    }
    out += words(el, o);
    out += children(el, o);
    return op < 0.98 ? '<g opacity="' + op + '">' + out + '</g>' : out;
  }

  function areaOf(e) { var r = e.getBoundingClientRect(); return r.width * r.height; }
  // The board's own frame, wood and lines may sit round the element that holds its squares: climb to the outermost
  // parent that is barely bigger, never as far as the page's main.
  function framed(el) {
    var a = areaOf(el);
    while (el.parentElement && !/^(main|body|html)$/i.test(el.parentElement.tagName) && areaOf(el.parentElement) <= a * FRAME_GROWTH) el = el.parentElement;
    return el;
  }
  // The element that is the table: the game says (ZimiShell.game({ table })), else the largest board-like thing on the page.
  function findTable(doc, hint) {
    var named = typeof hint === 'function' ? hint() : typeof hint === 'string' ? doc.querySelector(hint) : hint;
    if (named) return named;
    var best = null, area = 0;
    [].forEach.call(doc.querySelectorAll(TABLE_SELECTOR), function (e) {
      var a = areaOf(e);
      if (a > area) { best = e; area = a; }
    });
    return best && framed(best);
  }

  // The table as an svg string 16 by 9, the table fitted whole on the page's own background; null when there is none.
  function picture(doc, hint) {
    var el = findTable(doc || root.document, hint);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    var k = Math.min((W - 2 * PAD) / r.width, (H - 2 * PAD) / r.height), o = { x: r.left, y: r.top };
    var bg = root.getComputedStyle(doc.body).backgroundColor, inner = paint(el, o);
    if (inner.length > MAX_CHARS) { o.coarse = true; inner = paint(el, o); }   // a heap of drawn tiles: keep their bodies and drop the faces
    if (!inner || inner.length > MAX_CHARS) return null;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '"><rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>' +
      '<g transform="translate(' + num((W - r.width * k) / 2) + ' ' + num((H - r.height * k) / 2) + ') scale(' + num(k * 1000) / 1000 + ')">' + inner + '</g></svg>';
  }

  root.ZimiTableSnap = { picture: picture, findTable: findTable };
})(typeof window !== 'undefined' ? window : this);
