/* ZimiGames: the burst, a thing coming apart. Spokes fly out from a point and fade (drawn on a canvas, kept by the game's own clock, so
   it waits while the game is paused). Visual only: none under reduced motion. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var BURST_S = 0.45, SPOKES = 9, SPOKE_STEP = 0.698;
  // new Burst(reducedMotion): add(x, y, reach, color, now) at the moment it happens; draw(ctx, now) each frame; clear() on a new game.
  function Burst(reduced) {
    var list = [];
    return {
      add: function (x, y, reach, color, now) { if (reduced() || x == null) return; list.push({ x: x, y: y, reach: reach, color: color, t0: now }); },
      clear: function () { list = []; },
      draw: function (ctx, now) {
        list = list.filter(function (b) { return now - b.t0 >= 0 && now - b.t0 < BURST_S; });
        list.forEach(function (b) {
          var k = (now - b.t0) / BURST_S, r0 = b.reach * 0.35 + b.reach * 0.65 * k, r1 = r0 + b.reach * 0.35 * (1 - k);
          ctx.save(); ctx.globalAlpha = 1 - k; ctx.strokeStyle = b.color; ctx.lineWidth = 2; ctx.beginPath();
          for (var i = 0; i < SPOKES; i++) { var a = i * SPOKE_STEP + b.x; ctx.moveTo(b.x + Math.cos(a) * r0, b.y + Math.sin(a) * r0); ctx.lineTo(b.x + Math.cos(a) * r1, b.y + Math.sin(a) * r1); }
          ctx.stroke(); ctx.restore();
        });
      }
    };
  }
  root.ArcadeBurst = Burst;
})(this);
