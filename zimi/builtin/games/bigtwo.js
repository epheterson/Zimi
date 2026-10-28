/* ZimiGames: Big Two (see climbing.js for the rules both climbing games
   share). You and three computer players; twos are high, suits rank
   diamonds, clubs, hearts, spades. */
(function (root) {
  'use strict';
  var TX = root.ZimiCards.T, C = root.ZimiClimbing, game = C.api(C.RULES.bigtwo);
  game.rulesText = TX('bigtwo.rules');
  root.ZimiBigTwo = game;
  if (root.document && root.document.getElementById('zc-table')) C.boot(game);
})(typeof globalThis !== 'undefined' ? globalThis : window);
