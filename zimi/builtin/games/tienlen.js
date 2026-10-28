/* ZimiGames: Tien Len, the southern Vietnamese climbing game (see
   climbing.js). Runs, pairs in a row, and chops for twos. */
(function (root) {
  'use strict';
  var TX = root.ZimiCards.T, C = root.ZimiClimbing, game = C.api(C.RULES.tienlen);
  game.rulesText = TX('tienlen.rules');
  root.ZimiTienLen = game;
  if (root.document && root.document.getElementById('zc-table')) C.boot(game);
})(typeof globalThis !== 'undefined' ? globalThis : window);
