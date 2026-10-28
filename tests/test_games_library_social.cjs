// ZimiGames' games for friends and for the real world, the rules with no DOM: Wikipedia Telephone, Dictionary Bluff, Babel,
// Sky Detective (and the sky maths under it, checked against events with known dates), Drop Pin, and the pass-the-phone cover.
//
// Run: node tests/test_games_library_social.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files, extra) {
  const sandbox = Object.assign({ console, Math, URL, Set, Date, Intl, AbortController, setTimeout, clearTimeout, Promise }, extra || {});
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}
let failures = 0, passes = 0;
const check = (ok, label) => { if (ok) { passes++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const Lib = load(['librarykit.js']).GamesLib;
const rng = seed => Lib.rng(seed);
const T = (k, v) => k + (v ? JSON.stringify(v) : '');

// ── pass the phone ───────────────────────────────────────────────────────────
{
  const Pass = load(['passkit.js']).GamesPass;
  check(Pass.name(T, 0) === 'pass.player{"n":1}' && Pass.name(T, 2) === 'pass.player{"n":3}' && Pass.showing() === false, 'pass: players are numbered from one');
}

// ── Wikipedia Telephone ──────────────────────────────────────────────────────
{
  const sb = load(['librarykit.js', 'wikirace-data.js', 'telephone.js']);
  const E = sb.TelephoneEngine;
  check(E.clueProblem('Short', 'Mount Everest') === 'short' && E.clueProblem('x'.repeat(130), 'Cat') === 'long', 'telephone: a clue is not too short or long');
  check(E.clueProblem('The highest peak, up in the Himalaya region', 'Mount Everest') === '' && E.clueProblem('It is called Everest by most people', 'Mount Everest') === 'name', 'telephone: a clue may not say a word of the name');
  check(E.clueProblem('Tall and cold and very high up', 'Mount Everest') === '' && E.clueProblem('The Mountain is tall and so cold', 'Mount Everest') === 'name' && E.clueProblem('Mountains are tall and cold and high', 'Mount Everest') === 'name', 'telephone: a word of four letters or more, whatever its ending, is the name');
  check(E.clueProblem('Un grand café très noir ici', 'Café') === 'name' && E.clueProblem('A big CAFE near the sea shore', 'Café') === 'name', 'telephone: accents and case do not hide the name');
  check(E.clueProblem('He had a big cat on his lap here', 'The Cat') === '', 'telephone: a short word of the name (cat) is allowed');
  check(E.pointsFor(1) === 3 && E.pointsFor(2) === 2 && E.pointsFor(3) === 1, 'telephone: 3, 2 or 1 points by the guess');
  check(E.giverOf(0) === 0 && E.giverOf(1) === 1 && E.giverOf(2) === 0, 'telephone: the roles swap each round');
  check(E.isRight({ path: 'A/X', title: 'x' }, { path: 'A/X', title: 'Y' }) && E.isRight({ path: 'b', title: 'Mount Everest' }, { path: 'a', title: 'mount everest' }) && !E.isRight({ path: 'b', title: 'K2' }, { path: 'a', title: 'Everest' }) && !E.isRight(null, {}), 'telephone: a guess is right by path or by title');
  const list = E.miniArticles(sb.WIKIRACE_MINI);
  check(list.length >= 50 && list.every(a => a.title && a.blurb.length >= 40 && !/\[\[|\]\]/.test(a.blurb)), 'telephone: the built-in articles, links turned to words');
  check(same(E.searchMini([{ title: 'Moon' }, { title: 'Mount Everest' }, { title: 'Solar System' }, { title: 'Monsoon' }], 'mo').map(a => a.title), ['Monsoon', 'Moon', 'Mount Everest']), 'telephone: a search finds titles that start with it');
  check(E.searchMini(list, 'system')[0].title === 'Solar System' && E.searchMini(list, '').length === 0 && E.searchMini(list, 'zzzzzz').length === 0, 'telephone: a search finds a word inside a title, and nothing for nothing');
  check(E.fit({ title: 'Cat', blurb: 'The cat is a small carnivorous mammal of the family.' }) && !E.fit({ title: 'Category:Cats', blurb: 'x'.repeat(60) }) && !E.fit({ title: 'List of cats', blurb: 'x'.repeat(60) }) && !E.fit({ title: 'Cat', blurb: 'Short.' }) && !E.fit(null), 'telephone: a page fit to be a secret');
}

// ── Dictionary Bluff ─────────────────────────────────────────────────────────
{
  const sb = load(['librarykit.js', 'bluff-data.js', 'bluff.js']);
  const E = sb.BluffEngine;
  check(E.normalize('A kind of small bird.') === 'a kind of small bird' && E.normalize('  The study  of rocks ') === 'the study of rocks' && E.normalize('DNA that repeats.') === 'DNA that repeats' && E.normalize('Pass it on') === 'pass it on', 'bluff: a fake and a real meaning read alike (no capital, no full stop)');
  check(E.tooClose('the smell of rain on dry ground', 'the pleasant smell of rain falling on dry ground') && !E.tooClose('a tool for cutting wood', 'the pleasant smell of rain falling on dry ground'), 'bluff: a fake too like the real one is caught');
  const real = 'the pleasant smell of rain falling on dry ground';
  check(E.problem('short', 'petrichor', real, []) === 'short' && E.problem('x'.repeat(150), 'petrichor', real, []) === 'long' && E.problem('what petrichor feels like at dawn', 'petrichor', real, []) === 'word' && E.problem('the smell of rain on dry ground', 'petrichor', real, []) === 'close', 'bluff: a fake cannot be short, long, name the word or copy the real one');
  check(E.problem('A tool for cutting wood quickly', 'petrichor', real, ['a tool for cutting wood quickly']) === 'same' && E.problem('a tool for cutting wood quickly', 'petrichor', real, ['another one entirely']) === '', 'bluff: two people cannot write the same fake, and a good one passes');
  const opts = E.makeOptions(real, ['a kind of pastry', 'a very old coin'], rng(3));
  check(opts.length === 3 && opts.filter(o => o.by === -1).length === 1 && opts.filter(o => o.by === 0).length === 1 && opts.every(o => !/[.]$/.test(o.text)), 'bluff: the real meaning and each fake, once each');
  const options = [{ text: 'real', by: -1 }, { text: 'fake0', by: 0 }, { text: 'fake1', by: 1 }, { text: 'fake2', by: 2 }];
  const t = E.tally(options, [0, 1, 1], 3);   // 0 finds the real one (+2); 1 and 2 both pick player 0's fake (+1 each to player 0)
  check(same(t.points, [4, 0, 0]) && same(t.voters[0], [0]) && same(t.voters[1], [1, 2]), 'bluff: 2 for the real meaning, 1 for each person a fake fooled');
  const real2 = E.tally([{ text: 'r', by: -1 }, { text: 'a', by: 0 }, { text: 'b', by: 1 }], [0, 0], 2);
  check(same(real2.points, [2, 2]), 'bluff: finding the real meaning scores 2');
  const fooled = E.tally([{ text: 'r', by: -1 }, { text: 'a', by: 0 }, { text: 'b', by: 1 }, { text: 'c', by: 2 }], [2, 3, 1], 3);   // 0 picks 1's fake, 1 picks 2's fake, 2 picks 0's fake
  check(same(fooled.points, [1, 1, 1]) && same(fooled.voters[2], [0]), 'bluff: each person fooled is a point for the writer, and the voters are kept');
  check(same(E.tally([{ text: 'r', by: -1 }, { text: 'a', by: 0 }], [1, -1], 2).points, [0, 0]), 'bluff: voting for your own fake, or not voting, scores nothing');
  check(same(E.winners([3, 5, 5]), [1, 2]) && same(E.winners([1, 4, 2]), [1]), 'bluff: the winners, a tie giving more than one');
  const html = '<h2 id="Afrikaans">Afrikaans</h2><ol><li>an Afrikaans sense that is long enough to count.</li></ol><h2 id="English">English</h2><h3>Noun</h3><ol><li>(rare) The pleasant smell of rain falling on dry ground.<ul><li>An example.</li></ul></li></ol><h2 id="French">French</h2><ol><li>a french sense that is also long enough</li></ol>';
  check(E.realDefinition(html, 'petrichor') === 'The pleasant smell of rain falling on dry ground.', 'bluff: the English section\'s first definition, its label dropped');
  check(E.realDefinition('<h2 id="English">English</h2><ol><li>plural of petrichor and so on and more</li></ol>', 'petrichors') === '' && E.realDefinition('<h2 id="English">English</h2><ol><li>Short.</li></ol>', 'x') === '' && E.realDefinition('<h2 id="French">French</h2><ol><li>a long enough sense for a french word here</li></ol>', 'abc') === '' && E.realDefinition('<h2 id="English">English</h2><ol><li>the petrichor of the rain falling on the dry ground</li></ol>', 'petrichor') === '', 'bluff: no definition when it is an inflection, too short, not English or names the word');
  check(E.plausibleWord('petrichor') && !E.plausibleWord('cat') && !E.plausibleWord('Petrichor') && !E.plausibleWord('café-au-lait'), 'bluff: a word worth asking is seven to sixteen plain letters');
  const w = sb.BLUFF_WORDS;
  check(w.length >= 40 && w.every(x => E.plausibleWord(x[0]) && x[1].length >= 15 && !x[1].toLowerCase().includes(x[0])) && new Set(w.map(x => x[0])).size === w.length, 'bluff: the built-in words, each with a meaning that does not name it');
}

// ── Babel ────────────────────────────────────────────────────────────────────
{
  const sb = load(['librarykit.js', 'babel-data.js', 'babel.js']);
  const E = sb.BabelEngine;
  check(E.scriptOf('eau') === 'latin' && E.scriptOf('вода') === 'cyrillic' && E.scriptOf('水') === 'han' && E.scriptOf('ماء') === 'arabic' && E.scriptOf('पानी') === 'devanagari' && E.scriptOf('물') === 'hangul' && E.scriptOf('りんご') === 'kana' && E.scriptOf('νερό') === 'greek' && E.scriptOf('1') === 'other', 'babel: the script of a word');
  check(E.pointsFor(2) === 4 && E.pointsFor(3) === 3 && E.pointsFor(5) === 1 && E.pointsFor(9) === 1, 'babel: 4 points for two clues, one fewer for each more');
  const html = '<table class="translations" role="presentation"><tbody><tr><td class="translations-cell"><style>.x{}</style><link rel="x"/>\n<ul><li>Arabic: <span class="Arab" lang="ar"><a href="./x">ماء</a></span> (<span lang="ar-Latn" class="tr Latn">maa</span>)</li>\n<li>French: <span class="Latn" lang="fr"><a href="./eau">eau</a></span></li>\n<li>French: <span class="Latn" lang="fr"><a href="./aqua">aqua</a></span></li>\n<li>Spanish: <span lang="es"><a href="./agua">agua</a></span><span class="tpos">(es)</span></li><li>Chinese: <span lang="zh"><a>水 / 氵</a></span></li></ul></td></tr></tbody></table><ul><li>German: <span lang="de"><a>Wasser</a></span></li></ul>';
  const got = E.parseTranslations(html);
  check(same(got.map(g => [g.code, g.name, g.word, g.tr]), [['ar', 'Arabic', 'ماء', 'maa'], ['fr', 'French', 'eau', ''], ['es', 'Spanish', 'agua', '']]), 'babel: the first translation table, a language once, no style in a name, no entry with a slash');
  check(E.parseTranslations('<p>nothing</p>').length === 0, 'babel: a page with no translations');
  const entries = ['fr:eau', 'es:agua', 'de:Wasser', 'it:acqua', 'ru:вода', 'ja:水', 'ar:ماء', 'hi:पानी'].map(s => ({ code: s.split(':')[0], word: s.split(':')[1], name: '', tr: '' }));
  for (let seed = 1; seed <= 30; seed++) {
    const picked = E.pickClues(entries, 5, rng(seed)), latin = picked.filter(e => E.scriptOf(e.word) === 'latin').length;
    if (picked.length !== 5 || latin > 3 || E.scriptOf(picked[0].word) !== 'latin' || new Set(picked.map(p => p.code)).size !== 5) { check(false, 'babel: seed ' + seed + ' picks five clues, a Latin one first, at most two Latin besides'); break; }
    if (seed === 30) check(true, 'babel: thirty seeds each pick five clues, a Latin one first');
  }
  check(E.pickClues(entries.slice(0, 3), 5, rng(1)).length === 3, 'babel: fewer languages than clues gives what there is');
  check(E.isRight('Water', 'water') && E.isRight(' the water ', 'water') && E.isRight('waters', 'water') && E.isRight('café', 'cafe') && E.isRight('to drink', 'to drink') === false && !E.isRight('', 'water') && !E.isRight('fire', 'water'), 'babel: case, "the" and a plural are not mistakes');
  const words = sb.BABEL_WORDS;
  check(words.length >= 35 && words.every(r => r[1].length >= 8 && r[1].every(e => e[0].length === 2 && e[1])) && new Set(words.map(r => r[0])).size === words.length, 'babel: 35 or more built-in words, each in eight or more languages');
  check([1, 2, 3, 4, 5, 6, 7, 8].every(seed => E.miniRound(words, 40, rng(seed)).every(w => w.clues.every(c => Lib.fold(c.word) !== Lib.fold(w.answer)))), 'babel: no clue is the English word itself (German Gold, Swedish salt are left out)');
  check(words.every(r => r[1].every(e => E.scriptOf(e[1]) === 'latin' || e[2])), 'babel: a word in another script says how it is said');
  const round = E.miniRound(words, 5, rng(2));
  check(round.length === 5 && round.every(w => w.clues.length === 5 && w.answer) && new Set(round.map(w => w.answer)).size === 5, 'babel: the built-in round');
}

// ── the sky ──────────────────────────────────────────────────────────────────
{
  const sb = load(['librarykit.js', 'skykit.js', 'skydetective.js']);
  const S = sb.SkyKit, E = sb.SkyDetectiveEngine;
  const jd = s => S.julian(Date.parse(s));
  const sun = S.sun(jd('2026-10-26T12:00:00Z'));
  check(Math.abs(sun.dec + 12.5) < 0.4 && Math.abs(sun.ra / 15 - 14.1) < 0.2, 'sky: the Sun on October 26 is at about 14 hours, minus 12.5 degrees');
  const equinox = jd('2026-03-20T12:00:00Z'), se = S.sun(equinox), h = S.altaz(se.ra, se.dec, equinox, 51.5, 0);
  check(Math.abs(h.alt - 38.5) < 1.2 && Math.abs(h.az - 180) < 6, 'sky: at noon on the equinox the Sun is 38.5 degrees up, due south, from London');
  check(S.moon(jd('2026-02-17T12:00:00Z')).illumination < 0.02 && S.moon(jd('2026-03-03T11:30:00Z')).illumination > 0.98 && S.moon(jd('2026-03-03T11:30:00Z')).illumination <= 1, 'sky: new Moon on February 17, 2026 and full on March 3');
  check(S.moon(jd('2026-02-24T12:00:00Z')).waxing && !S.moon(jd('2026-03-10T12:00:00Z')).waxing, 'sky: waxing after the new Moon, waning after the full');
  check(Math.abs(S.planet('jupiter', jd('2026-01-10T12:00:00Z')).elongation - 180) < 3, 'sky: Jupiter is opposite the Sun at its January 2026 opposition');
  check(S.planet('venus', jd('2026-01-06T12:00:00Z')).elongation < 3 && S.planet('mars', jd('2026-01-09T12:00:00Z')).elongation < 3, 'sky: Venus and Mars are behind the Sun at their January 2026 conjunctions');
  check(S.planet('saturn', jd('2025-09-21T12:00:00Z')).elongation > 175, 'sky: Saturn at its September 2025 opposition');
  check(Math.abs(S.altaz(2.53 * 15, 89.264, jd('2026-10-26T00:00:00Z'), 40, -100).alt - 40.7) < 1.2, 'sky: Polaris stands as high as the latitude');
  ['mercury', 'venus', 'mars', 'jupiter', 'saturn'].forEach(n => { const p = S.planet(n, jd('2026-10-26T12:00:00Z')); check(p.mag > -5 && p.mag < 2 && p.ra >= 0 && p.ra < 360 && Math.abs(p.dec) < 30, 'sky: ' + n + ' is somewhere reasonable'); });
  const ms = Date.parse('2026-10-26T04:00:00Z');   // 9 pm in Los Angeles
  const all = S.objects(ms, 34, -118, 2.0);
  check(all.length > 30 && all[0].mag <= all[1].mag && all.some(o => o.id === 'moon') && all.some(o => o.id === 'sirius'), 'sky: objects, the brightest first, the Moon and Sirius among them');
  const moon = all.find(o => o.id === 'moon');
  check(moon.alt > 10 && moon.alt < 60 && moon.az > 70 && moon.az < 130 && moon.illumination > 0.98, 'sky: the Moon just before the full one of October 26 is up in the east at 9 pm');
  check(S.dome(90, 0).x === 0 && S.dome(90, 0).y === 0 && Math.abs(S.dome(0, 0).y + 1) < 1e-9 && Math.abs(S.dome(0, 90).x + 1) < 1e-9, 'sky: the dome has the zenith in the middle, north up, east to the left');
  check(E.guessPlace('America/Los_Angeles', 420).lat === 40 && E.guessPlace('Australia/Sydney', -660).lat < 0 && Math.abs(E.guessPlace('Europe/Paris', -60).lon - 15) < 0.01 && E.guessPlace('', 0).lat === 40, 'sky: a place guessed from the time zone, no request made');
  check(E.isNight(ms, 34, -118) && !E.isNight(Date.parse('2026-10-26T20:00:00Z'), 34, -118), 'sky: dark at 9 pm, light at 1 pm');
  const noon = Date.parse('2026-10-26T20:00:00Z'), tonight = E.momentFor(noon, 34, -118, 'tonight', 21);
  check(E.isNight(tonight, 34, -118) && tonight >= noon, 'sky: asked at noon, "tonight" is a dark moment later');
  check(E.isNight(E.momentFor(noon, 34, -118, 'now'), 34, -118), 'sky: asked "now" in daylight, it is the next dark hour');
  const vis = E.visibleObjects(ms, 34, -118);
  check(vis.length >= 8 && vis.every(o => o.alt >= 8 && o.kind !== 'sun'), 'sky: what is up, none below eight degrees, no Sun');
  const names = o => E.nameOf(o, T);
  const qs = E.makeQuestions(vis, S.objects(ms, 34, -118, 2.0).filter(o => o.kind !== 'sun'), 6, rng(4), T);
  check(qs.length === 6 && qs.map(q => q.kind).join() === 'name,find,name,find,name,find' && new Set(qs.map(q => q.id)).size === 6, 'sky: six clues, name and find taking turns, no object twice');
  check(qs.filter(q => q.kind === 'name').every(q => q.choices.length === 4 && new Set(q.choices).size === 4 && q.choices.includes(q.answer) && q.answer === names(vis.find(o => o.id === q.id))), 'sky: a name clue has four different choices with the answer among them');
  const o = vis[0], p = S.dome(o.alt, o.az);
  check(E.tapHit(o, p) && E.tapHit(o, { x: p.x + 0.05, y: p.y }) && !E.tapHit(o, { x: p.x + 0.3, y: p.y }) && E.nearest(vis, p).id === o.id, 'sky: a tap near an object finds it, a tap far off does not');
}

// ── Drop Pin ─────────────────────────────────────────────────────────────────
{
  const sb = load(['librarykit.js', 'droppin-data.js', 'droppin.js']);
  const E = sb.DropPinEngine;
  const paris = { lat: 48.8566, lon: 2.3522 }, london = { lat: 51.5074, lon: -0.1278 };
  check(Math.abs(E.haversine(paris, london) - 344) < 5 && E.haversine(paris, paris) === 0 && Math.abs(E.haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }) - 20015) < 20, 'drop pin: the distance between places (Paris to London is 344 km)');
  check(E.pointsFor(0, 100) === 100 && E.pointsFor(100, 100) === 37 && E.pointsFor(1000, 100) === 0 && E.pointsFor(10, 100) > E.pointsFor(20, 100), 'drop pin: points fall with distance, a third left one scale away');
  check(E.scaleFor(null) === 40 && E.scaleFor([-0.01, 0, 0.01, 0.01]) === 2 && E.scaleFor([-180, -90, 180, 90]) === 1500 && Math.abs(E.scaleFor([2, 48, 3, 49]) - 25) < 5, 'drop pin: how far is far depends on the size of the map');
  check(E.parseHash('#map=14/48.8567/2.3508').lat === 48.8567 && E.parseHash('#map=9.5/-33.9/151.2').lon === 151.2 && E.parseHash('#nothing') === null && E.parseHash('#map=3/95/2') === null && E.parseHash('') === null, 'drop pin: the map\'s own address for where it looks');
  check(E.placeFromMap({ title: 'Paris', pos: 'map=14/48.8567/2.3508' }).name === 'Paris' && E.placeFromMap({ title: 'X' }) === null && E.placeFromMap(null) === null, 'drop pin: a map entry as a place');
  const pt = E.project(40, -100), back = E.unproject(pt.x, pt.y);
  check(Math.abs(back.lat - 40) < 1e-9 && Math.abs(back.lon + 100) < 1e-9 && E.project(90, -180).x === 0 && E.project(-90, 180).y === 400, 'drop pin: the world grid projects both ways');
  const places = sb.DROPPIN_PLACES;
  check(places.length >= 35 && places.every(p => Math.abs(p[1]) <= 90 && Math.abs(p[2]) <= 180) && new Set(places.map(p => p[0])).size === places.length, 'drop pin: 35 or more built-in places, each on Earth');
  const near = (name, lat, lon) => { const p = places.find(x => x[0] === name); return p && E.haversine({ lat: p[1], lon: p[2] }, { lat, lon }) < 30; };
  check(near('Eiffel Tower', 48.8584, 2.2945) && near('Statue of Liberty', 40.6892, -74.0445) && near('Mount Everest', 27.9881, 86.925) && near('Uluru', -25.3444, 131.0369) && near('Taj Mahal', 27.1751, 78.0421), 'drop pin: well-known places are where they are');
  check(E.builtInRound(places, 5, rng(1)).length === 5 && E.builtInRound(places, 5, rng(1))[0].name, 'drop pin: the built-in round');
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
