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
import * as TileFlags from "./tileFlags.js";
import { DIRT, TILE_COUNT, TILE_INVALID } from "./tileValues.js";
export class Tile {
    constructor(value = DIRT, flags = 0) {
        this.validateArguments(value, flags, "Tile constructor");
        this.value = value | flags;
    }
    getValue() {
        return this.valueFromCombinedValue(this.value);
    }
    getFlags() {
        return this.flagsFromCombinedValue(this.value);
    }
    getRawValue() {
        // TODO: Can we remove the caller of this to avoid leaking this implementation detail?
        return this.value;
    }
    addFlags(flags) {
        this.validateFlags(flags, "addFlags");
        if (flags === TileFlags.NOFLAGS) {
            return;
        }
        this.value |= flags;
    }
    setValue(desiredValue) {
        if (desiredValue < TILE_INVALID) {
            throw new Error(`setValue called with out-of-range value ${desiredValue}`);
        }
        // TODO: Fix cases where this can be called with a "combined" value + flags value so we can simplify
        const value = this.valueFromCombinedValue(desiredValue);
        const bitMask = this.flagsToSetFromCombinedValue(desiredValue);
        this.set(value, bitMask);
    }
    setFlags(flags) {
        this.validateFlags(flags, "setFlags");
        const existingValue = this.value & ~TileFlags.ALLBITS;
        this.value = existingValue | flags;
    }
    removeFlags(flags) {
        this.validateFlags(flags, "removeFlags");
        if (flags === TileFlags.NOFLAGS) {
            return;
        }
        this.value &= ~flags;
    }
    setFrom(tile) {
        this.value = tile.value;
    }
    set(value, flags) {
        this.validateArguments(value, flags, "set");
        this.value = value | flags;
    }
    isAnimated() {
        return this.checkBits(TileFlags.ANIMBIT);
    }
    isBulldozable() {
        return this.checkBits(TileFlags.BULLBIT);
    }
    isConductive() {
        return this.checkBits(TileFlags.CONDBIT);
    }
    isCombustible() {
        return this.checkBits(TileFlags.BURNBIT);
    }
    isPowered() {
        return this.checkBits(TileFlags.POWERBIT);
    }
    isZone() {
        return this.checkBits(TileFlags.ZONEBIT);
    }
    toString() {
        const qualities = ["animated", "bulldozable", "combustible", "conductive", "powered", "zone"];
        const qualitiesText = qualities.map((quality) => this.getQualityText(quality)).join(", ");
        const tileValue = this.getValue();
        return `Tile# ${tileValue}: ${qualitiesText}`;
    }
    getQualityText(quality) {
        const predicate = this.predicateForQuality(quality);
        const qualityValue = this[predicate]();
        return `${quality}: ${this.summariseBoolean(qualityValue)}`;
    }
    predicateForQuality(quality) {
        return `is${quality[0].toUpperCase()}${quality.slice(1)}`;
    }
    summariseBoolean(bool) {
        return bool ? `✔` : `✘`;
    }
    valueFromCombinedValue(value) {
        return value & TileFlags.BIT_MASK;
    }
    flagsFromCombinedValue(value) {
        return value & TileFlags.ALLBITS;
    }
    flagsToSetFromCombinedValue(value) {
        const embeddedFlags = this.flagsFromCombinedValue(value);
        return embeddedFlags > 0 ? embeddedFlags : this.getFlags();
    }
    checkBits(flag) {
        return (this.value & flag) > 0;
    }
    validateArguments(value, flags, context) {
        this.validateValue(value, context);
        this.validateFlags(flags, context);
    }
    validateValue(value, context) {
        if (this.valueIsInvalid(value)) {
            throw new Error(`${context} called with out-of-range value ${value}`);
        }
    }
    validateFlags(flags, context) {
        if (this.flagsAreInvalid(flags)) {
            throw new Error(`${context} called with out-of-range flags 0x${flags.toString(16)}`);
        }
    }
    valueIsInvalid(value) {
        return value < TILE_INVALID || value >= TILE_COUNT;
    }
    flagsAreInvalid(flags) {
        return flags !== 0 && (flags < TileFlags.BIT_START || (flags & ~TileFlags.ALLBITS) !== 0);
    }
}
