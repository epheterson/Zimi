# ZimCity's engine

ZimCity's simulation is micropolisJS by Graeme McCutcheon (https://github.com/graememcc/micropolisJS), a JavaScript port of Micropolis, the open-source release of the 1989 city simulator. It is released under the GNU GPL version 3 with the additional terms in LICENSE.txt; the full licence is COPYING.txt. ZimCity is a modified version and is not the original program.

Micropolis is a registered trademark of Micropolis Corporation (Micropolis GmbH) and is licensed here as a courtesy of the owner under the Micropolis Public Name License (MicropolisPublicNameLicense.md, https://www.micropolis.com).

## What is here

`engine/` holds the simulation modules from upstream commit f13a1624d111d235e804bd80f48ba7c9f66a8e0f (2025-07-13), the closure of what `simulation.js`, `gameMap.js`, `mapGenerator.js`, the building tools and `animationManager.js` import. Everything a person touches (the canvas, the windows, jQuery, the splash, the saves, the strings) is ZimCity's own: `../zimcity.js` (the page), `../zimcity-view.js` (the map, and the tiles redrawn in Zimi's colours), `../zimcity-input.js` (touch, mouse, keys), `../zimcity-tools.js` (strokes, their honest ghost, undo), `../zimcity-sheets.js`, `../zimcity-words.js` and `../zimcity-library.js` (articles in the player's library).

`tiles.png` and `sprites.png` are the original Micropolis art, released under the GPL with the code. The tiles are shown recoloured (zimcity-view.js, `recolour`); the files are unchanged.

## Changes from upstream

Mechanical, so the modules load in a browser with no build step:

- The TypeScript files (`blockMap`, `bounds`, `direction`, `messages`, `position`, `random`, `spriteConstants`, `tile`, `tileFlags`, `tileValues`) were transpiled to JavaScript with TypeScript's `transpileModule` (types removed, nothing else).
- Every relative import names its `.js` file.

Fixes:

- `simulation.js`: the 10- and 120-month census calls passed `budget`, a name that only resolved because the upstream page has an element with the id `budget`; they pass `this.budget`.
- `boatSprite.js`: imported a `SpriteConstants` export that `spriteConstants` does not have; it imports the module as a namespace.
- `eventEmitter.js`: listeners were kept in one table per decorated constructor, so every Budget, Simulation and their parts shared one; a second city in the same page heard and re-sent the first city's events. Each object now keeps its own.

Left out: `queryTool.js`, `gameTools.js` and `text.js` (they depend on jQuery and on upstream's page). ZimCity builds its own tool set and inspect sheet from the same engine calls.
