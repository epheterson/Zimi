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
import { Random } from "./random.js";
class DirectionValue {
    constructor(name) {
        this.name = name;
    }
    oppositeDirection() {
        return this.transform(4);
    }
    rotateClockwise() {
        return this.transform(1);
    }
    rotateCounterClockwise() {
        return this.transform(allDirections.length - 1);
    }
    toString() {
        return this.name;
    }
    transform(delta) {
        const ourIndex = directionIndex(this);
        const desired = ourIndex + delta;
        return allDirections[desired % allDirections.length];
    }
}
export const NORTH = Object.freeze(new DirectionValue("NORTH"));
export const NORTHEAST = Object.freeze(new DirectionValue("NORTHEAST"));
export const EAST = Object.freeze(new DirectionValue("EAST"));
export const SOUTHEAST = Object.freeze(new DirectionValue("SOUTHEAST"));
export const SOUTH = Object.freeze(new DirectionValue("SOUTH"));
export const SOUTHWEST = Object.freeze(new DirectionValue("SOUTHWEST"));
export const WEST = Object.freeze(new DirectionValue("WEST"));
export const NORTHWEST = Object.freeze(new DirectionValue("NORTHWEST"));
const allDirections = [
    NORTH,
    NORTHEAST,
    EAST,
    SOUTHEAST,
    SOUTH,
    SOUTHWEST,
    WEST,
    NORTHWEST,
];
function directionIndex(direction) {
    return allDirections.indexOf(direction);
}
const cardinalDirections = [
    NORTH,
    EAST,
    SOUTH,
    WEST,
];
export function forEachCardinalDirection(callback) {
    cardinalDirections.forEach((dir) => callback(dir));
}
export function getRandomCardinalDirection() {
    return getRandomDirectionFrom(cardinalDirections);
}
export function getRandomDirection() {
    return getRandomDirectionFrom(allDirections);
}
function getRandomDirectionFrom(directionArray) {
    const maxIndex = directionArray.length - 1;
    const index = Random.getRandom(maxIndex);
    return directionArray[index];
}
