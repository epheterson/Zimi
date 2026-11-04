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
import { Position } from "./position.js";
export class Bounds {
    static fromOrigin(width, height) {
        return new Bounds(0, 0, width, height);
    }
    constructor(inclusiveStartX, inclusiveStartY, widthCount, heightCount) {
        // assert(widthCount > 0, "bounded region must have a width");
        // assert(heightCount > 0, "bounded region must have a width");
        this.inclusiveStartX = inclusiveStartX;
        this.inclusiveStartY = inclusiveStartY;
        this.exclusiveEndX = inclusiveStartX + widthCount;
        this.exclusiveEndY = inclusiveStartY + heightCount;
    }
    contains(position) {
        const { x, y } = position;
        return this.xInBounds(x) && this.yInBounds(y);
    }
    toString() {
        const upperCorner = new Position(this.inclusiveStartX, this.inclusiveStartY);
        const lowerCorner = new Position(this.exclusiveEndX - 1, this.exclusiveEndY - 1);
        return `Bounds Rectangle: ${upperCorner} - ${lowerCorner}`;
    }
    xInBounds(x) {
        return x >= this.inclusiveStartX && x < this.exclusiveEndX;
    }
    yInBounds(y) {
        return y >= this.inclusiveStartY && y < this.exclusiveEndY;
    }
}
