/* ZimiGames: the little kit the board games share (storage, a seeded generator,
   sheets, option chips). Our own code, GPL-3.0. No network, no modules. */
(function (root) {
  'use strict';
  var PREFIX = 'zimi.games.';

  // localStorage can throw (private mode, blocked data): every read and write is guarded.
  function load(name, fallback) {
    try { var v = JSON.parse(localStorage.getItem(PREFIX + name)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  }
  function save(name, value) {
    try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); } catch (e) { /* play on without it */ }
  }

  var mulberry32 = root.ZimiUtil.mulberry32;

  function reducedMotion() {
    if (root.ZimiShell && root.ZimiShell.reducedMotion) return root.ZimiShell.reducedMotion();
    if (root.ZimiShell && root.ZimiShell.anim() === 'off') return true;
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function fmtTime(s) { return root.ZimiText ? root.ZimiText.clock(s) : Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  // A sheet over the page: Escape and a click outside close it, focus goes back where it was.
  function sheet(el, onClose) {
    var from = null;
    function close() {
      if (el.hidden) return;
      el.hidden = true;
      if (from && from.focus) from.focus();
      if (onClose) onClose();
    }
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = el.querySelectorAll('button:not([disabled]),input:not([disabled])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el.querySelector('.ar-sheet-card'))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return {
      el: el,
      // Focus goes to the sheet itself, never into a field or a button; Tab stays inside it, Esc closes it.
      open: function () {
        from = document.activeElement;
        el.hidden = false;
        var card = el.querySelector('.ar-sheet-card') || el;
        if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
        try { card.focus({ preventScroll: true }); } catch (e) { /* no focus */ }
      },
      close: close
    };
  }

  // A group of radio chips: read the value, set it.
  function chipValue(group) { var c = group.querySelector('input:checked'); return c ? c.value : null; }
  function chipSet(group, value) {
    var inputs = group.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === String(value);
  }

  // Arrow keys move focus over a grid of buttons (display order); one is the tab stop. n is the width
  // (and the height, unless rows says otherwise).
  var ARROWS = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  function gridNav(board, cells, n, rows) {
    var cur = 0, h = rows || n;
    function mark(i) { cells[cur].tabIndex = -1; cur = i; cells[cur].tabIndex = 0; }
    cells.forEach(function (c, i) { c.tabIndex = i ? -1 : 0; c.addEventListener('focus', function () { mark(i); }); });
    board.addEventListener('keydown', function (e) {
      var d = ARROWS[e.key];
      if (!d || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      var r = Math.min(h - 1, Math.max(0, Math.floor(cur / n) + d[0])), c = Math.min(n - 1, Math.max(0, (cur % n) + d[1]));
      cells[r * n + c].focus();
    });
  }

  // Drag a piece with a finger or a mouse as well as tap-tap. A press that moves DRAG_PX or more lifts the piece
  // (a copy follows the pointer); letting go on another square drops it there. grab(i) is called with the cell index
  // where the drag began (select the piece there, as a tap would), drop(i) with the cell index let go on. A press that
  // never moves is left to the click, which still works. A piece is whatever the cell holds as an <svg> or .dr-pc.
  var DRAG_PX = 7, PIECE = 'svg:not(.cs-co), .dr-pc, .ck-pc';
  function dragPieces(board, cells, hooks) {
    var d = null, justDragged = 0;
    board.style.touchAction = 'none';
    function cellAt(x, y) {
      var el = document.elementFromPoint(x, y), i = -1;
      while (el && el !== board) { i = cells.indexOf(el); if (i >= 0) return i; el = el.parentNode; }
      return -1;
    }
    function end(e, drop) {
      if (!d) return;
      var cur = d; d = null;
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
      if (!cur.lifted) return;
      cur.ghost.remove(); cur.piece.style.opacity = '';
      justDragged = Date.now();
      var to = drop ? cellAt(e.clientX, e.clientY) : -1;
      if (to >= 0 && to !== cur.from) hooks.drop(to);
    }
    function move(e) {
      if (!d || e.pointerId !== d.id) return;
      if (!d.lifted) {
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < DRAG_PX) return;
        d.lifted = true; hooks.grab(d.from);
        var r = d.piece.getBoundingClientRect(), g = d.piece.cloneNode(true);
        g.style.cssText = 'position:fixed;left:0;top:0;width:' + r.width + 'px;height:' + r.height + 'px;margin:0;pointer-events:none;z-index:9999;transform:scale(1.15)';
        d.hw = r.width / 2; d.hh = r.height / 2; d.ghost = g; document.body.appendChild(g); d.piece.style.opacity = '0.3';
      }
      e.preventDefault();
      d.ghost.style.left = (e.clientX - d.hw) + 'px'; d.ghost.style.top = (e.clientY - d.hh) + 'px';
    }
    function up(e) { end(e, true); }
    function cancel(e) { end(e, false); }
    board.addEventListener('pointerdown', function (e) {
      if (d || e.button > 0) return;
      var from = cellAt(e.clientX, e.clientY), piece = from >= 0 ? cells[from].querySelector(PIECE) : null;
      if (!piece) return;
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, from: from, piece: piece, lifted: false };
      document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
    });
    // The click that follows a drop is not a tap on the square under the finger.
    board.addEventListener('click', function (e) { if (Date.now() - justDragged < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  // A piece that has just been moved glides from the square it left: call after the board is painted. The cell it lands on
  // rises above its neighbours while it travels. Nothing moves under reduced motion or when a piece was dragged there.
  var SLIDE_MS = 200;
  function slide(fromCell, toCell, ms) {
    var p = fromCell && toCell && toCell.querySelector(PIECE);
    if (!p || !p.animate || reducedMotion()) return;
    var a = fromCell.getBoundingClientRect(), b = toCell.getBoundingClientRect();
    if (!b.width) return;
    toCell.style.zIndex = 3;
    var run = p.animate([{ transform: 'translate(' + (a.left - b.left) + 'px,' + (a.top - b.top) + 'px)' }, { transform: 'none' }], { duration: ms || SLIDE_MS, easing: 'ease-out' });
    run.onfinish = run.oncancel = function () { toCell.style.zIndex = ''; };
  }

  root.BoardKit = { slide: slide, dragPieces: dragPieces, gridNav: gridNav, load: load, save: save, mulberry32: mulberry32, reducedMotion: reducedMotion, fmtTime: fmtTime, sheet: sheet, chipValue: chipValue, chipSet: chipSet };
})(typeof globalThis !== 'undefined' ? globalThis : this);
