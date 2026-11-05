/* micropolisJS. Adapted by Graeme McCutcheon from Micropolis.
 *
 * This code is released under the GNU GPL v3, with some additional terms.
 * Please see the files LICENSE and COPYING for details. Alternatively,
 * consult http://micropolisjs.graememcc.co.uk/LICENSE and
 * http://micropolisjs.graememcc.co.uk/COPYING
 *
 * The name/term "MICROPOLIS" is a registered trademark of Micropolis (https://www.micropolis.com) GmbH
 * (Micropolis Corporation, the "licensor") and is licensed here to the authors/publishers of the "Micropolis"
 * city simulation game and its source code (the project or "licensee(s)") as a courtesy of the owner.
 *
 */
import * as Direction from "./direction.js";
class DirectionDelta {
    constructor(xDelta, yDelta) {
        this.xDelta = xDelta;
        this.yDelta = yDelta;
    }
}
function getDeltaFor(direction) {
    switch (direction) {
        case Direction.NORTH:
            return new DirectionDelta(0, -1);
        case Direction.NORTHEAST:
            return new DirectionDelta(1, -1);
        case Direction.EAST:
            return new DirectionDelta(1, 0);
        case Direction.SOUTHEAST:
            return new DirectionDelta(1, 1);
        case Direction.SOUTH:
            return new DirectionDelta(0, 1);
        case Direction.SOUTHWEST:
            return new DirectionDelta(-1, 1);
        case Direction.WEST:
            return new DirectionDelta(-1, 0);
        case Direction.NORTHWEST:
            return new DirectionDelta(-1, -1);
        default:
            throw new Error(`Unexpected direction!`);
    }
}
export class Position {
    static move(position, direction) {
        const { x, y } = position;
        const { xDelta, yDelta } = getDeltaFor(direction);
        return new Position(x + xDelta, y + yDelta);
    }
    static origin() {
        return new Position(0, 0);
    }
    // ZimCity fix: traffic.js and mapGenerator.js also call new Position(pos) and new Position(pos, dx, dy), the
    // original's copy and offset forms, which the TypeScript port dropped (a copy got x = the object, y undefined).
    constructor(x, y, dy) {
        if (x !== null && typeof x === 'object') {
            this.x = x.x + (y || 0);
            this.y = x.y + (dy || 0);
            return;
        }
        this.x = x;
        this.y = y;
    }
    toString() {
        return `(${this.x}, ${this.y})`;
    }
}
