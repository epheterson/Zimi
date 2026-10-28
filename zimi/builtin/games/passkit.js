/* ZimiGames: passing one phone around. A cover that hides the screen until the next person says they are holding it, so
   a secret (an article to give clues for, a fake definition) stays on the screen of the one who should see it.
   Pass.cover({ name, text, button, onReady }) shows the cover and returns { el, close }. Used by the games that
   several people play on one phone (Wikipedia Telephone, Dictionary Bluff, Wiki Race for two). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Pass = {};
  var open = null;

  // "Player 1", "Player 2": the names a game gives people who have not typed their own.
  Pass.name = function (T, i) { return T('pass.player', { n: i + 1 }); };

  Pass.cover = function (o) {
    var d = root.document, T = function (k, v) { return root.ZimiText ? root.ZimiText.T(k, v) : k; };
    if (open) open.close();
    var cover = d.createElement('div'), card = d.createElement('div'), h = d.createElement('h2'), p = d.createElement('p'), b = d.createElement('button');
    cover.className = 'pk-cover'; cover.setAttribute('role', 'dialog'); cover.setAttribute('aria-modal', 'true'); cover.setAttribute('aria-label', T('pass.to', { name: o.name }));
    card.className = 'pk-card';
    h.textContent = T('pass.to', { name: o.name });
    p.textContent = o.text || T('pass.only', { name: o.name });
    b.type = 'button'; b.className = 'ar-btn gm-play'; b.textContent = o.button || T('pass.ready', { name: o.name });
    card.appendChild(h); card.appendChild(p); card.appendChild(b); cover.appendChild(card);
    d.body.appendChild(cover);
    var handle = { el: cover, close: function () { if (cover.parentNode) cover.parentNode.removeChild(cover); if (open === handle) open = null; } };
    b.addEventListener('click', function () { handle.close(); if (o.onReady) o.onReady(); });
    open = handle;
    root.setTimeout(function () { b.focus(); }, 0);
    return handle;
  };
  // Is a cover showing? (a game leaves its keys alone while one is)
  Pass.showing = function () { return !!open; };

  root.GamesPass = Pass;
})(this);
