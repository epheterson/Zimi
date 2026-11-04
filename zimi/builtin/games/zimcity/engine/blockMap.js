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
const ID = (n) => n;
/*
 *
 * BlockMaps are data maps where each entry corresponds to data representing a block of tiles in the original
 * game map.
 *
 */
export class BlockMap {
    // Construct a block map. Takes three integers: the game map's width and height, and the block size (i.e. how many
    // tiles in each direction should map to the same block). The BlockMap entries will be initialised to zero.
    constructor(gameMapWidth, gameMapHeight, blockSize) {
        this.gameMapWidth = gameMapWidth;
        this.gameMapHeight = gameMapHeight;
        this.blockSize = blockSize;
        this.data = [];
        this._width = this.convertToBlockCount(this.gameMapWidth);
        this._height = this.convertToBlockCount(this.gameMapHeight);
        this.clear();
    }
    get width() {
        return this._width;
    }
    get height() {
        return this._height;
    }
    get(blockX, blockY) {
        const index = this.toIndex(blockX, blockY);
        return this.data[index];
    }
    set(blockX, blockY, value) {
        const index = this.toIndex(blockX, blockY);
        this.data[index] = value;
    }
    worldGet(worldX, worldY) {
        const { x, y } = this.toBlockCoordinate(worldX, worldY);
        return this.get(x, y);
    }
    worldSet(worldX, worldY, value) {
        const { x, y } = this.toBlockCoordinate(worldX, worldY);
        this.set(x, y, value);
    }
    clear() {
        this.forEach((x, y) => this.set(x, y, 0));
    }
    copyFrom(source, transform = ID) {
        if (this.hasIncompatibleDimensions(source)) {
            console.warn("Copying from incompatible blockMap!");
        }
        this.forEach((x, y) => this.set(x, y, transform(source.get(x, y))));
    }
    forEach(fn) {
        const maxWidth = this.width;
        const maxHeight = this.height;
        for (let x = 0; x < maxWidth; x++) {
            for (let y = 0; y < maxHeight; y++) {
                fn(x, y);
            }
        }
    }
    convertToBlockCount(value) {
        return Math.floor((value + this.blockSize - 1) / this.blockSize);
    }
    hasIncompatibleDimensions(map) {
        return map.gameMapHeight !== this.gameMapHeight ||
            map.gameMapWidth !== this.gameMapWidth ||
            map.blockSize !== this.blockSize;
    }
    toBlockCoordinate(worldX, worldY) {
        const x = this.toBlockIndex(worldX);
        const y = this.toBlockIndex(worldY);
        return { x, y };
    }
    toBlockIndex(worldIndex) {
        return Math.floor(worldIndex / this.blockSize);
    }
    toIndex(blockX, blockY) {
        return this.width * blockY + blockX;
    }
}
