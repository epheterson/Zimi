/* ZimiGames: what the board games share on top of the shell (shell.js) and the board kit (boardkit.js):
   option rows for Menu > New game, the thinking state, the illegal-move refusal, the end sheet, the record line,
   and the strings a page holds in its markup. Our own code, GPL-3.0. No network, no modules.

     BoardUI.t(id, vars)                  a string by id (ZimiText.T)
     BoardUI.localize(root)               fills [data-t] (text), [data-t-aria] (aria-label), [data-t-title] (title) from the
                                          string table, now and whenever the language changes; the markup keeps its English
     BoardUI.row(label, choices, value, onPick)       an option row: a 13px label and a segmented control. choices is
                                          [[value, label], ...]; returns { el, value(), set(v) }
     BoardUI.toggle(label, value, onPick)             the same for a yes or no (On and Off), value a boolean
     BoardUI.field(label, node)           a row around a control of the page's own; BoardUI.select(label, choices, value, onPick) a select in one
     BoardUI.options(rows)                the object ZimiShell.game({ menu }) wants: { options: [nodes] }
     BoardUI.status(el)                   the page's one status line: { say(text), reason(text), thinking(on), turn(text) }
     BoardUI.refuse(statusApi, el, text)  an illegal move: the shake on el and the reason on the status line
     BoardUI.noted(note, line)            a note ahead of the turn's line, when both fit in one status line (44 characters)
     BoardUI.end(opts)                    ZimiShell.endSheet with the board games' defaults
     BoardUI.record(el, level, rec)       "Medium: 3 won, 1 lost" in the records line (empty until the first game)
     BoardUI.side(color)                  the word for a side ("White", "Black", ...) by id */
(function (root) {
  'use strict';
  var d = root.document;
  function T(id, vars) { return root.ZimiText ? root.ZimiText.T(id, vars) : id; }
  function shell() { return root.ZimiShell; }
  function h(tag, attrs, kids) {
    var e = d.createElement(tag), k;
    for (k in (attrs || {})) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (n) { if (n) e.appendChild(n); });
    return e;
  }

  // ── strings held in markup ──
  var MAP = [['data-t', function (e, s) { e.textContent = s; }], ['data-t-aria', function (e, s) { e.setAttribute('aria-label', s); }],
    ['data-t-title', function (e, s) { e.setAttribute('title', s); }]];
  function localize(scope) {
    scope = scope || d;
    MAP.forEach(function (m) {
      Array.prototype.forEach.call(scope.querySelectorAll('[' + m[0] + ']'), function (e) { m[1](e, T(e.getAttribute(m[0]))); });
    });
  }
  if (d) {
    var run = function () { localize(d); if (root.ZimiText && root.ZimiText.onChange) root.ZimiText.onChange(function () { localize(d); }); };
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', run); else run();
  }

  // ── option rows ──
  function row(label, choices, value, onPick) {
    var cur = value, buttons = [];
    var seg = h('div', { class: 'gs-seg' + (choices.length > 3 ? ' is-wrap' : ''), role: 'group', 'aria-label': label });
    function paint() { buttons.forEach(function (b, i) { b.setAttribute('aria-pressed', String(String(choices[i][0]) === String(cur))); }); }
    choices.forEach(function (c) {
      var b = h('button', { class: 'ar-btn', type: 'button', text: c[1] });
      b.addEventListener('click', function () { cur = c[0]; paint(); if (onPick) onPick(cur); });
      buttons.push(b); seg.appendChild(b);
    });
    paint();
    var el = h('div', { class: 'gs-row' }, [h('label', { text: label }), seg]);
    return { el: el, value: function () { return cur; }, set: function (v) { cur = v; paint(); },
      // A choice that does not apply (the level against a person) keeps its place and cannot be pressed.
      disable: function (on) { buttons.forEach(function (b) { b.disabled = !!on; b.setAttribute('aria-disabled', String(!!on)); }); el.classList.toggle('is-off', !!on); } };
  }
  function toggle(label, value, onPick) {
    var r = row(label, [[1, T('shell.on')], [0, T('shell.off')]], value ? 1 : 0, function (v) { if (onPick) onPick(!!+v); });
    return { el: r.el, value: function () { return !!+r.value(); }, set: function (v) { r.set(v ? 1 : 0); }, disable: r.disable };
  }
  // A row whose control is a node of the page's own (a select, a search box): the label above it, in the option rows' style.
  function field(label, node) {
    var id = 'bu-f' + (field.n = (field.n || 0) + 1);
    node.id = node.id || id;
    return { el: h('div', { class: 'gs-row gs-field' }, [h('label', { text: label, for: node.id }), node]), node: node };
  }
  function select(label, choices, value, onPick) {
    var sel = h('select', { class: 'gs-select' });
    choices.forEach(function (c) { var o = h('option', { value: c[0], text: c[1] }); sel.appendChild(o); });
    sel.value = value;
    sel.addEventListener('change', function () { if (onPick) onPick(sel.value); });
    return field(label, sel);
  }
  function options(rows) { return { options: rows.map(function (r) { return r.el || r; }) }; }

  // ── the status line, the thinking state, the refusal ──
  // The opponent's turn pulses a dot ahead of the line; the dot's room is always there, so the layout does not jump.
  function status(el) {
    el.classList.add('bu-status');
    var api = shell() && shell().status ? shell().status(el) : null, text = '', timer = 0;
    var say = function (t) { text = t; if (api) api.say(t); else el.textContent = t; };
    return {
      say: function (t) { el.classList.remove('is-thinking'); say(t); },
      reason: function (t, ms) { if (api) api.reason(t, ms); else el.textContent = t; },
      thinking: function (on) { el.classList.toggle('is-thinking', !!on); },
      turn: function (t, thinking) { el.classList.toggle('is-thinking', !!thinking); say(t); }
    };
  }
  // What just happened, then the line for the turn; the status is one short line, so the turn's line stands alone when both do not fit.
  var ONE_LINE = 44;   // the most a 390 px status line holds in one line
  function noted(note, line) { var both = T('janggi.noted', { note: note, line: line }); return both.length <= ONE_LINE ? both : line; }
  function refuse(st, el, text) {
    if (shell() && shell().shake) shell().shake(el);
    if (st && text) st.reason(text);
  }

  // ── the end ──
  function end(opts) {
    if (!shell() || !shell().endSheet) return;
    shell().endSheet(opts);
  }

  // ── records ──
  function record(el, level, rec) {
    if (!el) return;
    rec = rec || { w: 0, l: 0, d: 0 };
    if (!(rec.w + rec.l + rec.d)) { el.textContent = ''; return; }
    el.textContent = rec.d ? T('board.record.draws', { level: level, won: rec.w, lost: rec.l, drawn: rec.d }) : T('board.record', { level: level, won: rec.w, lost: rec.l });
  }

  var SIDES = { white: 'board.white', black: 'board.black', red: 'board.red', blue: 'board.blue', green: 'board.green', yellow: 'board.yellow', you: 'board.you', computer: 'board.computer' };
  function side(color) { return T(SIDES[color] || color); }

  // ── never lose a game (ZimiShell.persist): states kept as plain data ──
  // Typed arrays become {$t, a} and come back as themselves.
  function pack(x) { return x == null ? x : JSON.parse(JSON.stringify(x, function (k, v) { return v && ArrayBuffer.isView(v) ? { $t: v.constructor.name, a: Array.prototype.slice.call(v) } : v; })); }
  function unpack(x) {
    if (Array.isArray(x)) return x.map(unpack);
    if (x && typeof x === 'object') {
      if (x.$t && Array.isArray(x.a)) return new root[x.$t](x.a);
      var o = {}; Object.keys(x).forEach(function (k) { o[k] = unpack(x[k]); }); return o;
    }
    return x;
  }
  // api: { save() -> the page's state as plain data, or null when no move was made; load(data) -> false if it no
  // longer fits; resume() carries on (a computer's turn) }. ZimiGameSave() answers the same save, for the tests.
  function persist(api) {
    root.ZimiGameSave = function () { var d = api.save(); return d == null ? '' : JSON.stringify(pack(d)); };
    if (!shell() || !shell().persist) return;
    shell().persist({
      save: function () { return pack(api.save()); },
      load: function (data) { if (api.load(unpack(data)) === false) return false; if (api.resume) api.resume(); }
    });
  }

  root.BoardUI = { pack: pack, unpack: unpack, persist: persist, t: T, localize: localize, row: row, toggle: toggle, field: field, select: select, options: options, status: status, refuse: refuse, noted: noted, end: end, record: record, side: side, h: h };
})(typeof globalThis !== 'undefined' ? globalThis : this);
