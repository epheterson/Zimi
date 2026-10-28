/* ZimiGames: walking on a grid, shared by Muncher, Blast and Quest. Our own code, GPL-3.0. No DOM, no modules.
   An actor has a position in tiles (x, y) and a direction (dx, dy). It moves smoothly, and at the centre of every
   tile it asks `choose(actor)` which way to go next: a direction {dx, dy}, or null to stop there. */
(function (root) {
  'use strict';
  var EPS = 1e-6;

  function atCentre(e) { return Math.abs(e.x - Math.round(e.x)) < EPS && Math.abs(e.y - Math.round(e.y)) < EPS; }

  // Move an actor `dist` tiles. wrapW (optional): the grid is that many columns wide and its sides join up.
  function advance(e, dist, choose, wrapW) {
    var guard = 0;
    while (dist > 1e-7 && guard++ < 12) {
      if (atCentre(e)) {
        e.x = Math.round(e.x); e.y = Math.round(e.y);
        if (wrapW) { if (e.x <= -1 + EPS) e.x += wrapW; if (e.x >= wrapW - EPS) e.x -= wrapW; }
        var d = choose(e);
        if (!d) { e.dx = 0; e.dy = 0; return; }
        e.dx = d.dx; e.dy = d.dy;
      }
      if (!e.dx && !e.dy) return;
      // the distance to the next tile centre along the way we are going
      var toNext = e.dx > 0 ? Math.floor(e.x + EPS) + 1 - e.x : e.dx < 0 ? e.x - (Math.ceil(e.x - EPS) - 1) : e.dy > 0 ? Math.floor(e.y + EPS) + 1 - e.y : e.y - (Math.ceil(e.y - EPS) - 1);
      var s = Math.min(dist, toNext);
      e.x += e.dx * s; e.y += e.dy * s; dist -= s;
    }
  }

  root.GridWalk = { advance: advance, atCentre: atCentre };
})(typeof globalThis !== 'undefined' ? globalThis : window);
