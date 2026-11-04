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
function getChance(chance, rng = getRandom16) {
    // tslint:disable-next-line:no-bitwise
    return (rng() & chance) === 0;
}
function getERandom(max, rng = getRandom) {
    const firstCandidate = rng(max);
    const secondCandidate = rng(max);
    return Math.min(firstCandidate, secondCandidate);
}
function getRandom(max, mathGlobal = Math) {
    return mathGlobal.floor(mathGlobal.random() * (max + 1));
}
function getRandom16(rng = getRandom) {
    return rng(65535);
}
function getRandom16Signed(rng = getRandom16) {
    const value = rng();
    if (value < 32768) {
        return value;
    }
    else {
        return -(2 ** 16) + value;
    }
}
const Random = {
    getChance,
    getERandom,
    getRandom,
    getRandom16,
    getRandom16Signed,
};
export { Random };
