/* ZimiGames: Watch and learn, the driver. Our own code, GPL-3.0. No network, no modules.

   shell.js fetches this the first time someone presses Watch and learn. The computer plays
   both sides; before each move it says in one sentence why, waits long enough to read it (or
   for Step), then makes the move. A game hands the driver its next move like this:

     ctl.offer(text, apply)   show text, then call apply() when it is time (never twice)
     ctl.say(text)            a line that is not a move ("White to move")
     ctl.finish(text)         the game is over: show text, controls become Done
   and is told when the demo ends: game.watch.stop('takeover' | 'stop' | 'new').

   The sentences themselves come from the game's own explain-<game>.js, built from what the
   engine knows (captures, threats, the search score), never from a script of canned lines. */
(function (root) {
  'use strict';
  var d = root.document;
  var SPEED_KEY = 'zimi.games.watchspeed';
  // Reading time before a move: a base plus a little per character.
  var PACE = { slow: { base: 2800, per: 60 }, normal: { base: 1600, per: 38 }, fast: { base: 650, per: 14 } };
  var SPEEDS = ['slow', 'normal', 'fast'], SPEED_LABEL = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

  function h(tag, attrs, text) {
    var e = d.createElement(tag), k;
    for (k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (text != null) e.textContent = text;
    return e;
  }
  function loadSpeed() { try { var s = root.localStorage.getItem(SPEED_KEY); return PACE[s] ? s : 'normal'; } catch (e) { return 'normal'; } }
  function saveSpeed(s) { try { root.localStorage.setItem(SPEED_KEY, s); } catch (e) { /* the speed lasts for this page */ } }

  function create(opts) {
    var strip = opts.strip, game = opts.game, speed = loadSpeed();
    var paused = false, held = false, over = false, pending = null, timer = 0, moves = 0;
    var eyebrow = h('div', { class: 'gs-watch-eyebrow' }, 'Watch and learn');
    var text = h('p', { class: 'gs-watch-text', 'aria-live': 'polite' });
    var bPause = h('button', { class: 'ar-btn', type: 'button' }, 'Pause');
    var bStep = h('button', { class: 'ar-btn', type: 'button' }, 'Step');
    var bSpeed = h('button', { class: 'ar-btn', type: 'button' });
    var bTake = h('button', { class: 'ar-btn', type: 'button', 'aria-pressed': 'true' }, 'Take over');
    var ctlRow = h('div', { class: 'gs-watch-ctl' });
    [bPause, bStep, bSpeed, bTake].forEach(function (b) { ctlRow.appendChild(b); });
    strip.textContent = '';
    [eyebrow, text, ctlRow].forEach(function (n) { strip.appendChild(n); });
    strip.hidden = false;

    function paintControls() {
      bPause.textContent = paused ? 'Play' : 'Pause';
      bSpeed.textContent = 'Speed: ' + SPEED_LABEL[speed];
      bStep.disabled = !pending || over;
      bPause.disabled = over;
      bTake.textContent = over ? 'Done' : 'Take over';
    }
    function show(t) { text.textContent = t; if (root.ZimiShell) root.ZimiShell.narrate(t); }
    function clear() { root.clearTimeout(timer); timer = 0; }
    function delay(t) { var p = PACE[speed]; return p.base + p.per * t.length; }
    function schedule() {
      clear();
      if (!pending || paused || held || over || d.hidden) return;
      timer = root.setTimeout(go, delay(pending.text));
    }
    function go() {
      clear();
      var p = pending;
      if (!p) return;
      pending = null; moves++;
      paintControls();
      p.apply();
    }

    var ctl = {
      offer: function (t, apply) {
        if (over) return;
        pending = { text: t, apply: apply };
        eyebrow.textContent = 'Watch and learn \u00b7 ' + (game.watch.unit || 'move') + ' ' + (moves + 1);
        show(t); paintControls(); schedule();
      },
      say: function (t) { show(t); },
      finish: function (t) { over = true; pending = null; clear(); show(t); paintControls(); },
      speed: function () { return speed; }
    };

    bPause.addEventListener('click', function () { paused = !paused; paintControls(); schedule(); });
    // Step pauses the demo and plays the move on show, so the next one waits.
    bStep.addEventListener('click', function () { paused = true; go(); });
    bSpeed.addEventListener('click', function () { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; saveSpeed(speed); paintControls(); schedule(); });
    bTake.addEventListener('click', function () { opts.stop(over ? 'stop' : 'takeover'); });
    d.addEventListener('visibilitychange', schedule);

    return {
      begin: function () { show('Setting up the board.'); paintControls(); game.watch.start(ctl); },
      end: function () { clear(); pending = null; over = true; strip.hidden = true; strip.textContent = ''; d.removeEventListener('visibilitychange', schedule); },
      hold: function (on) { held = !!on; schedule(); }
    };
  }

  root.ZimiWatch = { create: create, PACE: PACE };
})(typeof globalThis !== 'undefined' ? globalThis : window);
