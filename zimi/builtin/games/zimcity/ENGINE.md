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
- `miscTiles.js`: a fire read and burned the burning tile itself instead of its neighbour, through an undefined lowercase `tileUtils`, so fire never spread; it now lights the neighbour.
- `blockMapUtils.js`: the crime scan looped to `mapWidth`/`mapHeight`, names the block map does not have (`gameMapWidth`/`gameMapHeight`), so crime was never counted.
- `position.js`: the TypeScript port dropped the copy and offset forms (`new Position(p)`, `new Position(p, dx, dy)`) that `traffic.js` and `mapGenerator.js` use; both are back. `traffic.js` then moved an undefined `pos`; it moves the car's own position, so trips arrive.
- `census.js`: residential, commercial and industrial population were saved and then counted again by the scan that follows a load; they are no longer saved. The hospital check compared with an undefined `this.resPopScaled`; it uses the local.
- `budget.js`: the police and fire funding maxima were named `MAX_POLICESTATION_EFFECT`/`MAX_FIRESTATION_EFFECT` while the evaluation and the simulation read `MAX_POLICE_STATION_EFFECT`/`MAX_FIRE_STATION_EFFECT`, so underfunding never cost anything; renamed to the readers' names.
- `disasterManager.js`: `makeEarthquake` called a `doEarthquake` that does not exist (the original's only shook the screen), so an earthquake threw; the call is gone and the damage stands.

Left out: `queryTool.js`, `gameTools.js` and `text.js` (they depend on jQuery and on upstream's page). ZimCity builds its own tool set and inspect sheet from the same engine calls.

## The modern layer (patched from outside, at load)

`zimcity-modern.js` (our own code, GPL-3.0) changes the engine without editing these files. It wraps or replaces, at
import time: `Simulation.prototype._clearCensus` and `init` (counts the new buildings, `census.zc`),
`PowerManager.prototype.doPowerScan` (the engine's flood fill, with solar and wind supply and the data centers' demand
counted in) and `setTilePower`, `Budget.prototype.collectTax` (the data centers' yearly payment, straight into the
funds), and `BlockMapUtils.pollutionTerrainLandValueScan` (land value lowered around a data center). The new buildings
use the engine's spare 3 x 3 slots 956 to 982 (the unused "extended church" tiles), so the bulldozer and zone code
already know their size. `zimcity-climate.js` and `zimcity-voices.js` only read the simulation, except that the sea
sets a few shore tiles to water. Saves without the climate open with none.
