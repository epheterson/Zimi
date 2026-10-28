// ZimiGames' library games: the rules with no DOM. Wiki Race (path validation, the walk, the built-in articles),
// Letter by Letter (scoring, accents, hints, clues), Quizzical (questions and their choices), Jigsaw (grid, snapping),
// Where in the World (distance, points, the view), the shared kit (seeds, choosing a ZIM, links, and telling Zimi from Kiwix).
//
// Run: node tests/test_games_library.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files, extra) {
  const sandbox = Object.assign({ console, Math, URL, AbortController, setTimeout, clearTimeout }, extra || {});
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}

let failures = 0, passes = 0;
const check = (ok, label) => {
  if (ok) { passes++; console.log('ok: ' + label); }
  else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const Lib = load(['librarykit.js']).GamesLib;

(async () => {
  // ── the kit ────────────────────────────────────────────────────────────────
  {
    const a = Lib.rng(Lib.hash('wikipedia|20261024')), b = Lib.rng(Lib.hash('wikipedia|20261024')), c = Lib.rng(Lib.hash('wikipedia|20261025'));
    const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
    check(same(sa, sb) && !same(sa, sc), 'kit: the same seed gives the same chance, another day another');
    check(sa.every(x => x >= 0 && x < 1), 'kit: chance is in [0, 1)');
    const sh = Lib.shuffle([1, 2, 3, 4, 5, 6], Lib.rng(7));
    check(same(sh.slice().sort(), [1, 2, 3, 4, 5, 6]) && same(Lib.shuffle([1, 2, 3, 4, 5, 6], Lib.rng(7)), sh), 'kit: a seeded shuffle keeps every item and repeats');
    check(Lib.fold('École Zoë ÇA') === 'ecole zoe ca', 'kit: fold takes accents and case off');
    check(Lib.dayKey(new Date(2026, 9, 4)) === '20261004', 'kit: the server\'s day key is YYYYMMDD');

    const list = [
      { name: 'wikipedia', kind: 'wiki', project: 'wikipedia', language: 'en', article_count: 100 },
      { name: 'wikipedia_fr', kind: 'wiki', project: 'wikipedia', language: 'fr', article_count: 50 },
      { name: 'wikipedia_fr_mini', kind: 'wiki', project: 'wikipedia', language: 'fr', article_count: 10 },
      { name: 'wiktionary', kind: 'wiki', project: 'wiktionary', language: 'en', article_count: 30 },
      { name: 'osm', kind: 'map', language: 'en' }
    ];
    const fr = Lib.pickZim(list, 'wikipedia', 'fr-CA');
    check(fr.zim.name === 'wikipedia_fr' && fr.exact, 'kit: the player\'s language comes first, the biggest of it');
    const de = Lib.pickZim(list, 'wikipedia', 'de');
    check(de.zim.name === 'wikipedia' && !de.exact, 'kit: no ZIM in their language falls back to English');
    check(Lib.pickZim(list, 'wikibooks', 'en') === null, 'kit: a project the library lacks gives null');
    check(Lib.pickZim([list[4]], 'wikipedia', 'en') === null, 'kit: a map is not a wiki');

    check(Lib.resolvePath('wikipedia', 'Paris', './France') === 'France', 'kit: a relative link resolves to its path');
    check(Lib.resolvePath('wikipedia', 'A/B', '../C') === 'C', 'kit: a link up a folder resolves');
    check(Lib.resolvePath('wikipedia', 'Paris', './Caf%C3%A9') === 'Café', 'kit: a link\'s escapes are undone');
    check(Lib.resolvePath('wikipedia', 'Paris', './Star_Trek') === 'Star_Trek', 'kit: underscores stay in the path');
    check(Lib.resolvePath('wikipedia', 'Paris', '#History') === null, 'kit: an anchor is not a page');
    check(Lib.resolvePath('wikipedia', 'Paris', 'https://example.org/wiki/X') === null, 'kit: another site is not a page');
    check(Lib.resolvePath('wikipedia', 'Paris', '/w/other_zim/France') === null, 'kit: another ZIM is not a page');
    check(Lib.resolvePath('wikipedia', 'Paris', './Category:Cities') === null, 'kit: a namespace page is not a page');
    check(Lib.resolvePath('wikipedia', 'Paris', './Paris#Climate') === null, 'kit: the page itself is not a link to follow');
    check(Lib.resolvePath('wikipedia', 'Paris', './Paris_(Texas)') === 'Paris_(Texas)', 'kit: a different page with a similar name is');
  }

  // ── telling Zimi from Kiwix ────────────────────────────────────────────────
  {
    const probe = (extra) => load(['librarykit.js'], extra).GamesLib.isZimi();
    const loc = { protocol: 'http:', search: '' };
    const ok = (body, status) => () => Promise.resolve({ ok: status === undefined || status < 400, status: status || 200, json: () => body instanceof Error ? Promise.reject(body) : Promise.resolve(body) });
    check(await probe({ location: loc, fetch: ok({ status: 'ok', version: '1.15.0' }) }) === true, 'fallback: Zimi answers /health with status ok');
    check(await probe({ location: loc, fetch: ok({}, 404) }) === false, 'fallback: a 404 (a plain server, Kiwix) is not Zimi');
    check(await probe({ location: loc, fetch: ok(new SyntaxError('not json')) }) === false, 'fallback: a page that is not JSON is not Zimi');
    check(await probe({ location: loc, fetch: ok({ status: 'down' }) }) === false, 'fallback: JSON without status ok is not Zimi');
    check(await probe({ location: loc, fetch: () => Promise.reject(new TypeError('network')) }) === false, 'fallback: a network error is not Zimi');
    let asked = 0;
    check(await probe({ location: { protocol: 'file:', search: '' }, fetch: () => { asked++; return Promise.reject(new Error('x')); } }) === false && asked === 0, 'fallback: from a folder (file:) nothing is even asked');
    const hang = () => new Promise(() => {});
    const t0 = Date.now();
    check(await probe({ location: loc, fetch: (u, o) => new Promise((res, rej) => { o && o.signal && o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) }) === false && Date.now() - t0 < 4000, 'fallback: a server that never answers fails fast (about 1.5 s)');
    const kit = load(['librarykit.js'], { location: loc, fetch: ok({ status: 'ok' }) }).GamesLib;
    check(kit.isZimi() === kit.isZimi(), 'fallback: asked once per page');
  }

  // ── Wiki Race ──────────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'wikirace-data.js', 'wikirace.js']);
    const R = sb.WikiRaceEngine;
    const graph = { A: ['B', 'C'], B: ['C', 'D'], C: ['D'], D: ['A'], E: ['A'] };
    const linksOf = p => graph[p] || [];
    check(R.validatePath([{ path: 'A', via: 'start' }, { path: 'B', via: 'link' }, { path: 'D', via: 'link' }], linksOf).ok, 'race: a path of real links is valid');
    const bad = R.validatePath([{ path: 'A', via: 'start' }, { path: 'D', via: 'link' }], linksOf);
    check(!bad.ok && bad.at === 1, 'race: a jump with no link is caught at that step');
    check(R.validatePath([{ path: 'A', via: 'start' }, { path: 'B', via: 'link' }, { path: 'A', via: 'back' }, { path: 'C', via: 'link' }], linksOf).ok, 'race: back returns to the page before');
    check(!R.validatePath([{ path: 'A', via: 'start' }, { path: 'B', via: 'link' }, { path: 'C', via: 'back' }], linksOf).ok, 'race: back to a page you were not on is invalid');
    check(!R.validatePath([{ path: 'A', via: 'link' }], linksOf).ok && !R.validatePath([], linksOf).ok, 'race: a path must start at the start');
    check(R.shortest(linksOf, 'A', 'D') === 2 && R.shortest(linksOf, 'A', 'A') === 0 && R.shortest(linksOf, 'A', 'E') === -1, 'race: shortest route length, itself, and none');
    check(R.isTarget({ path: 'France', title: 'France' }, { path: 'France', title: 'France' }), 'race: arriving by path is arriving');
    check(R.isTarget({ path: 'Republic_of_France', title: 'France' }, { path: 'France', title: 'France' }), 'race: a redirect that lands on the same title is arriving');
    check(R.isTarget({ path: 'Cafe', title: 'Café' }, { path: 'Cafe_x', title: 'Cafe' }), 'race: accents do not stop a title matching');
    check(!R.isTarget({ path: 'Paris', title: 'Paris' }, { path: 'France', title: 'France' }), 'race: another article is not the target');

    // The walk: every page it returns is a link of the one before, never repeated, never a dead end.
    const pages = {};
    const names = 'abcdefghijklmnopqrst'.split('');
    names.forEach((n, i) => { pages[n] = { path: n, title: n, links: names.filter((m, j) => j !== i && (j - i + 20) % 20 <= 7).map(m => ({ path: m, title: m })) }; });
    pages.dead = { path: 'dead', title: 'dead', links: [{ path: 'a', title: 'a' }] };
    pages.a.links.push({ path: 'dead', title: 'dead' });
    const open = p => pages[p] ? Promise.resolve(pages[p]) : Promise.reject(new Error('404'));
    let walkOk = true;
    for (let seed = 1; seed <= 40; seed++) {
      const got = await R.walk(open, pages.a, 4, Lib.rng(seed));
      const paths = got.map(p => p.path);
      walkOk = walkOk && got.length === 5 && new Set(paths).size === 5 && !paths.includes('dead') &&
        got.every((p, i) => i === 0 || got[i - 1].links.some(l => l.path === p.path));
    }
    check(walkOk, 'race: a walk from a page follows real links, repeats no page and skips dead ends (40 seeds)');
    const again = (await R.walk(open, pages.a, 3, Lib.rng(99))).map(p => p.path), once = (await R.walk(open, pages.a, 3, Lib.rng(99))).map(p => p.path);
    check(same(again, once), 'race: the same seed walks the same way (the daily race is one race)');
    const stuck = await R.walk(() => Promise.reject(new Error('x')), pages.a, 4, Lib.rng(1));
    check(stuck.length === 1, 'race: a walk whose pages cannot be read ends where it is, not in a hang');

    // The built-in articles: every link leads to an article, and there are races of the right length.
    const mini = sb.WIKIRACE_MINI, byTitle = {}, LINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    mini.forEach(a => { byTitle[a[0]] = a[1]; });
    const lo = t => { const out = []; let m; LINK.lastIndex = 0; while ((m = LINK.exec(byTitle[t] || ''))) out.push(m[1]); return out; };
    const dangling = [];
    mini.forEach(a => lo(a[0]).forEach(l => { if (!byTitle[l]) dangling.push(a[0] + ' -> ' + l); }));
    check(mini.length >= 40 && same(dangling, []), 'race: the built-in set has ' + mini.length + ' articles and no dead links ' + dangling.join(','));
    check(mini.every(a => lo(a[0]).length >= 3), 'race: every built-in article has at least three links');
    let races = 0, unreachable = 0;
    const titles = Object.keys(byTitle);
    titles.forEach(a => titles.forEach(b => { const d = R.shortest(lo, a, b); if (d < 0) unreachable++; if (d >= 3 && d <= 5) races++; }));
    check(unreachable === 0, 'race: every built-in article can reach every other');
    check(races >= 100, 'race: the built-in set offers many races of 3 to 5 clicks (' + races + ')');
  }

  // ── Letter by Letter ───────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'letterbyletter-words.js', 'letterbyletter.js']);
    const L = sb.LettersEngine;
    check(L.usable('water') && L.usable('forêt') && L.usable('мышь') && L.usable('שלום'), 'letters: words in Latin, Cyrillic and Hebrew are usable');
    check(!L.usable('ice') && !L.usable('Paris') && !L.usable('ice cream') && !L.usable('e-mail') && !L.usable('abc123') && !L.usable('水果汁'), 'letters: short, capitalised, spaced, hyphenated, numbered and ideographic ones are not');
    check(!L.usable('x'.repeat(13)), 'letters: a word over 12 letters is not');

    let g = L.newGame('water', 'clue');
    check(L.guess(g, 'w') === 'hit' && L.guess(g, 'z') === 'miss' && L.guess(g, 'z') === 'repeat' && g.misses === 1, 'letters: a hit, a miss, a repeat that costs nothing');
    check(same(L.shown(g), ['w', null, null, null, null]) && L.status(g) === 'playing', 'letters: the word shows what is found');
    'ater'.split('').forEach(k => L.guess(g, k));
    check(L.status(g) === 'won' && L.airLeft(g) === L.LIVES - 1, 'letters: finding every letter wins with the air that is left');
    g = L.newGame('water', ''); 'qxzjkvb'.split('').forEach(k => L.guess(g, k));
    check(L.status(g) === 'lost' && L.airLeft(g) === 0 && L.guess(g, 'w') === 'repeat', 'letters: seven misses lose, and nothing more can be played');

    g = L.newGame('forêt', '');
    check(L.guess(g, 'e') === 'hit' && same(L.shown(g), [null, null, null, 'ê', null]), 'letters: "e" finds "ê" (the keyboard has no accents)');
    g = L.newGame('école', ''); L.guess(g, 'e');
    check(same(L.shown(g), ['é', null, null, null, 'e']), 'letters: one key shows every spelling of the letter');

    g = L.newGame('garden', '');
    const h = L.hint(g, Lib.rng(3));
    check(h && L.shown(g).filter(Boolean).length >= 1 && g.misses === 1 && g.hints === 1, 'letters: a hint turns over a letter for one breath');
    g = L.newGame('ab' + 'cd', ''); ['a', 'b', 'c'].forEach(k => g.guessed.push(k));
    check(L.hint(g) === null, 'letters: the last letter is never given away');
    g = L.newGame('garden', ''); g.misses = 6;
    check(L.hint(g) === null, 'letters: a hint on the last breath is refused');

    check(L.cleanClue('A garden is a place where plants grow', 'garden').indexOf('garden') < 0, 'letters: the clue does not give the word away');
    check(L.cleanClue('Les arbres sont grands', 'arbre').indexOf('arbre') < 0, 'letters: nor its inflections (arbres)');
    check(L.cleanClue('x '.repeat(200), 'water').length <= 224, 'letters: a long clue is cut');

    const qwerty = L.keyboard('water', []);
    check(qwerty.length === 3 && qwerty.flat().length === 26, 'letters: a Latin word gets the QWERTY keyboard');
    const cyr = L.keyboard('мышь', ['дом', 'река']);
    const keys = cyr.flat();
    check(['м', 'ы', 'ш', 'ь'].every(k => keys.includes(k)) && keys.includes('д') && new Set(keys).size === keys.length && !keys.includes('q'), 'letters: another alphabet gets its own letters, once each');

    const mini = L.parseMini(sb.LETTERS_MINI);
    check(mini.length >= 100 && mini.every(w => L.usable(w.word) && w.clue.length > 3), 'letters: the ' + mini.length + ' built-in words are usable with a clue');
    check(mini.every(w => !new RegExp('\\b' + w.word + '\\b', 'i').test(w.clue)), 'letters: no built-in clue contains its word');
    check(new Set(mini.map(w => w.word)).size === mini.length, 'letters: no built-in word is listed twice');
    const days = new Set(); for (let d = 1; d <= 28; d++) days.add(L.dailyMini(mini, '202610' + String(d).padStart(2, '0')).word);
    check(L.dailyMini(mini, '20261024').word === L.dailyMini(mini, '20261024').word && days.size >= 20, 'letters: the day\'s built-in word is one word, and the days differ (' + days.size + ' of 28)');
    const lookup = { langs: [{ entries: [{ groups: [{ parts: [{ senses: [{ d: [] }, { d: ['A tall plant.'] }] }] }] }] }] };
    check(L.senseOf(lookup) === 'A tall plant.' && L.senseOf({}) === '' && L.senseOf(null) === '', 'letters: the clue is the first sense a dictionary has (and none for an odd shape)');
    const mixed = { langs: [
      { code: 'la', entries: [{ groups: [{ parts: [{ senses: [{ d: ['first-person singular present passive subjunctive of dēlīneo'] }] }] }] }] },
      { code: 'en', entries: [{ groups: [{ parts: [{ senses: [{ d: ['plural of tree'] }, { d: ['A woody plant.'] }] }] }] }] }
    ] };
    check(L.senseOf(mixed, 'en') === 'A woody plant.', 'letters: the clue comes from the game\'s own language and is never grammar about another word');
    check(L.senseOf({ langs: [mixed.langs[0]] }, 'en') === '', 'letters: a word with no sense in the game\'s language gives no clue, so another word is drawn');
  }

  // ── Quizzical ──────────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'quizzical-data.js', 'quizzical.js']);
    const Q = sb.QuizzicalEngine;
    check(Q.kindOf('The cat is a small carnivorous mammal.') === 'mammal', 'quiz: the kind of thing a sentence describes (mammal)');
    check(Q.kindOf('Paris is the capital and largest city of France.') === 'capital', 'quiz: the kind stops at the noun phrase (capital)');
    check(Q.kindOf('Dogs bark.') === '', 'quiz: no kind when the sentence does not say');
    check(Q.maskTitle('Paris is the capital and largest city of France.', 'Paris').startsWith('_____ is the capital'), 'quiz: the title is taken out of its sentence');
    check(Q.maskTitle('The Solar System is the system of the Sun and its planets.', 'Solar System').indexOf('Solar') < 0, 'quiz: and a multi-word title with it');
    check(Q.maskTitle('Category theory is a branch of mathematics.', 'Cat').indexOf('Category') === 0, 'quiz: a title is not cut out of the middle of another word');
    check(Q.maskTitle('Cat.', 'Cat') === '', 'quiz: a sentence with nothing left is not a question');

    const mk = (t, blurb, extra) => Object.assign({ title: t, blurb: blurb || (t + ' is a thing that is long enough to be a sentence for the quiz to use.'), path: t, zim: 'z' }, extra || {});
    const items = ['Paris', 'Berlin', 'Rome', 'Madrid', 'Cat', 'Dog', 'Moon', 'Sun'].map(t => mk(t));
    let neverEqual = true, distinct = true, counts = true;
    for (let seed = 1; seed <= 200; seed++) {
      const ans = items[seed % items.length], ds = Q.distractors(items, ans, 3, Lib.rng(seed));
      neverEqual = neverEqual && ds.every(d => !Q.same(d.title, ans.title));
      distinct = distinct && new Set(ds.map(d => Q.same(d.title, d.title) && d.title)).size === ds.length;
      counts = counts && ds.length === 3;
    }
    check(neverEqual && distinct && counts, 'quiz: other choices are never the answer, never repeat, and are three (200 seeds)');
    const dup = [mk('Paris'), mk('paris'), mk('Pàris'), mk('Rome'), mk('Berlin'), mk('Madrid')];
    const dd = Q.distractors(dup, dup[0], 3, Lib.rng(5));
    check(dd.every(d => !Q.same(d.title, 'Paris')) && dd.length === 3, 'quiz: a title that differs only by case or accent is not another choice');
    check(Q.distractors([mk('A1'), mk('A1')], mk('A1'), 3, Lib.rng(1)).length === 0, 'quiz: nothing but copies of the answer gives no choices');

    const kinds = [mk('Paris', 'Paris is the capital and largest city of France, on the Seine.'), mk('Berlin', 'Berlin is the capital and largest city of Germany, on the Spree.'), mk('Cat', 'The cat is a small carnivorous mammal that lives with people.'), mk('Dog', 'The dog is a domesticated mammal that lives with people.'),
      mk('Rome', 'Rome is the capital and largest city of Italy, on the Tiber.'), mk('Lion', 'The lion is a large cat and a mammal of the savanna.')];
    let near = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const ds = Q.distractors(kinds, kinds[0], 2, Lib.rng(seed), it => Q.kindOf(it.blurb));
      if (ds.every(d => ['Berlin', 'Rome'].includes(d.title))) near++;
    }
    check(near === 60, 'quiz: a city\'s other choices are other cities when there are enough (60 seeds)');

    const pool = ['Paris', 'Berlin', 'Rome', 'Madrid', 'Cat', 'Dog', 'Moon', 'Sun', 'Mars', 'Venus', 'Nile'].map(t => mk(t, null, { thumbnail: t.length > 3 ? '/w/z/I/' + t + '.png' : '' }));
    const words = ['table', 'chair', 'river', 'bread', 'stone', 'cloud'].map(t => ({ title: t, blurb: 'A thing called ' + t + ' that is described here.', pos: 'noun', path: t, zim: 'w' }));
    let roundsOk = true, kindsSeen = {};
    for (let seed = 1; seed <= 50; seed++) {
      const round = Q.makeRound(pool, words, 8, Lib.rng(seed));
      roundsOk = roundsOk && round.length === 8 && round.every(q => q.choices.length === 4 && new Set(q.choices.map(c => Lib.fold(c))).size === 4 && q.choices.includes(q.answer) && (q.prompt || q.picture));
      roundsOk = roundsOk && new Set(round.map(q => q.kind + q.answer)).size === round.length;
      round.forEach(q => { kindsSeen[q.kind] = true; });
      roundsOk = roundsOk && round.filter(q => q.kind === 'sentence').every(q => q.prompt.indexOf(q.answer) < 0);
    }
    check(roundsOk, 'quiz: every round is 8 questions of 4 distinct choices that include the answer, none asked twice, no sentence names its answer (50 seeds)');
    check(kindsSeen.sentence && kindsSeen.picture && kindsSeen.word, 'quiz: rounds mix sentences, pictures and words when the library has them');
    const few = Q.makeRound(pool.slice(0, 3), [], 8, Lib.rng(1));
    check(few.length === 0, 'quiz: a library with too few articles makes no round (the page then uses the built-in questions)');
    const noPics = Q.makeRound(pool.map(p => Object.assign({}, p, { thumbnail: '' })), [], 6, Lib.rng(2));
    check(noPics.length === 6 && noPics.every(q => q.kind === 'sentence'), 'quiz: with no pictures in the library every question is a sentence');

    const mini = sb.QUIZZICAL_MINI;
    check(mini.length >= 40 && mini.every(q => q.length === 5 && new Set(q.slice(1)).size === 4 && q.every(x => typeof x === 'string' && x)), 'quiz: the ' + mini.length + ' built-in questions each have a right answer and three others, all different');
    const r = Q.miniRound(mini, 8, Lib.rng(4));
    check(r.length === 8 && r.every(q => q.choices.length === 4 && q.choices.includes(q.answer)) && new Set(r.map(q => q.prompt)).size === 8, 'quiz: a built-in round is 8 different questions with the answer among four');
    check(Q.verdict(8, 8) === 'flawless' && Q.verdict(0, 8) !== 'flawless', 'quiz: a perfect round is called flawless');
  }

  // ── Jigsaw ─────────────────────────────────────────────────────────────────
  {
    const J = load(['librarykit.js', 'jigsaw.js']).JigsawEngine;
    let near = true;
    [0.7, 1, 1.333, 1.5, 1.6].forEach(a => J.COUNTS.forEach(n => {
      const g = J.gridFor(n, a), got = g.cols * g.rows, cell = (a / g.cols) * g.rows;
      near = near && got >= n * 0.7 && got <= n * 1.35 && cell > 0.55 && cell < 1.8;
    }));
    check(near, 'jigsaw: for 12, 24, 48 and 100 pieces on every picture shape the grid is within a third of the count with near-square cells');
    check(same(J.gridFor(12, 4 / 3), { cols: 4, rows: 3 }) && same(J.gridFor(100, 1), { cols: 10, rows: 10 }), 'jigsaw: 12 pieces of a 4:3 picture is 4 x 3, 100 of a square is 10 x 10');
    check(J.clampAspect(3) === 1.6 && J.clampAspect(0.2) === 0.7 && J.clampAspect(1.2) === 1.2, 'jigsaw: a very wide or tall picture is kept to a shape a screen holds');

    const c = J.cover(1000, 500, 400, 300);
    check(Math.abs(c.h - 300) < 1e-9 && Math.abs(c.w - 600) < 1e-9 && Math.abs(c.x + 100) < 1e-9 && c.y === 0, 'jigsaw: a wide picture fills a squarer board by cropping its sides, centred');
    const t = J.cover(300, 600, 400, 300);
    check(Math.abs(t.w - 400) < 1e-9 && t.h > 300 && t.y < 0, 'jigsaw: a tall one is cropped top and bottom');

    // The pieces tile the board exactly, with no gap or overlap.
    const W = 360, H = 270, cols = 6, rows = 4;
    let area = 0, tiles = true;
    for (let i = 0; i < cols * rows; i++) { const h = J.home(i, cols, rows, W, H); area += h.w * h.h; tiles = tiles && h.x >= 0 && h.y >= 0 && h.x + h.w <= W + 1e-9 && h.y + h.h <= H + 1e-9; }
    check(Math.abs(area - W * H) < 1e-6 && tiles, 'jigsaw: the pieces\' homes tile the board exactly');
    check(same([J.home(0, 6, 4, W, H).x, J.home(7, 6, 4, W, H).x, J.home(7, 6, 4, W, H).y], [0, 60, 67.5]), 'jigsaw: piece 7 of a 6 x 4 board is second column, second row');

    const h0 = J.home(8, 6, 4, W, H);
    check(J.snaps(h0.x + 3, h0.y - 4, h0) && J.snaps(h0.x, h0.y, h0), 'jigsaw: a piece dropped near home snaps');
    check(!J.snaps(h0.x + h0.w * 0.6, h0.y, h0) && !J.snaps(h0.x + 90, h0.y + 90, h0), 'jigsaw: a piece dropped far off does not');
    check(!J.snaps(h0.x + h0.w, h0.y, h0), 'jigsaw: a piece one cell off does not snap into the neighbour\'s place');

    const tray = { x: 0, y: 282, w: 360, h: 150 }, sc = J.scatter(24, tray, 60, 67.5, Lib.rng(11));
    check(sc.length === 24 && sc.every(p => p.x >= 0 && p.x <= 300 && p.y >= 282 && p.y <= 282 + 150 - 67.5 + 1e-9), 'jigsaw: pieces start inside the tray');
    check(!J.solved([]) && !J.solved([{ locked: true }, { locked: false }]) && J.solved([{ locked: true }, { locked: true }]), 'jigsaw: solved when every piece is locked, never for an empty board');

    // The drawn pictures run on a stub canvas context (no canvas in node) and draw something for every scene.
    const calls = {};
    const ctx = new Proxy({}, { get: (o, k) => k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : (...a) => { calls[k] = (calls[k] || 0) + 1; }, set: () => true });
    J.SCENES.forEach(k => J.drawScene(ctx, 800, 600, k, Lib.rng(2)));
    check(J.SCENES.length === 4 && calls.fillRect > 0 && calls.fill > 40, 'jigsaw: every built-in scene draws without a library');
  }

  // ── Where in the World ─────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'world-land.js', 'whereintheworld-data.js', 'whereintheworld.js']);
    const W = sb.WorldQuizEngine, P = sb.WORLD_PLACES;
    const paris = { lat: 48.86, lon: 2.35 }, london = { lat: 51.51, lon: -0.13 }, sydney = { lat: -33.87, lon: 151.21 };
    check(Math.abs(W.haversine(paris, london) - 344) < 5, 'world: Paris to London is about 344 km');
    check(Math.abs(W.haversine(paris, sydney) - 16960) < 80 && W.haversine(paris, paris) === 0, 'world: Paris to Sydney is about 16,960 km, and to itself 0');
    check(Math.abs(W.haversine({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }) - 222) < 3, 'world: distance goes round the date line, not across the map');
    check(W.points(0) === 100 && W.points(344) > 75 && W.points(3000) < 15 && W.points(20000) === 0, 'world: 100 points for the spot, fewer with distance, none from the far side');
    check(W.points(100) > W.points(200) && W.points(200) > W.points(1000), 'world: points only ever fall with distance');

    const p = W.project(48.86, 2.35), back = W.unproject(p.x, p.y);
    check(Math.abs(back.lat - 48.86) < 1e-9 && Math.abs(back.lon - 2.35) < 1e-9, 'world: the map\'s grid and latitude and longitude convert both ways');
    check(same([W.project(90, -180).x, W.project(90, -180).y, W.project(-90, 180).x, W.project(-90, 180).y], [0, 0, 800, 400]), 'world: the corners of the grid are the corners of the world');

    const v = W.wholeWorld(1.6);
    check(v.w === 800 && Math.abs(v.h - 500) < 1e-9 && Math.abs(v.x) < 1e-9, 'world: the whole world fits the width, with sea above and below on a squarer screen');
    const z = W.zoomView(v, 2, 0.25, 0.5);
    check(Math.abs(z.w - 400) < 1e-9 && Math.abs(z.h - 250) < 1e-9, 'world: zooming in halves the view');
    const before = { x: v.x + v.w * 0.25, y: v.y + v.h * 0.5 }, after = { x: z.x + z.w * 0.25, y: z.y + z.h * 0.5 };
    check(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, 'world: zooming keeps the point you zoom on where it was');
    let zoomed = v; for (let i = 0; i < 40; i++) zoomed = W.zoomView(zoomed, 2, 0.5, 0.5);
    check(zoomed.w >= 24 && W.zoomView(v, 0.2, 0.5, 0.5).w === 800, 'world: zoom stops at a close look and at the whole world');
    const off = W.panView(v, 99999, -99999);
    check(off.x + off.w / 2 <= 800 && off.y + off.h / 2 >= 0, 'world: you cannot pan the world out of sight');
    const fit = W.fitView(paris, sydney, 1.6, 0.6);
    const a = W.project(paris.lat, paris.lon), b = W.project(sydney.lat, sydney.lon);
    check([a, b].every(q => q.x >= fit.x && q.x <= fit.x + fit.w && q.y >= fit.y && q.y <= fit.y + fit.h), 'world: the view after an answer holds both the guess and the place');
    const close = W.fitView(paris, london, 1.6, 0.6);
    check(close.w >= 60 && close.w < 400, 'world: a near guess zooms in, with a floor');

    check(same(W.placeFromMap({ title: 'Tokyo', pos: 'map=14/35.68/139.69' }), { name: 'Tokyo', lat: 35.68, lon: 139.69, kind: 'place on your map' }), 'world: a place of the player\'s map: its name and position');
    check(W.placeFromMap({ title: 'X', pos: 'map=3/-33.9/-70.6' }).lat === -33.9 && W.placeFromMap({ title: 'X', pos: 'nonsense' }) === null && W.placeFromMap({ pos: 'map=3/1/2' }) === null && W.placeFromMap({ title: 'X', pos: 'map=3/95/2' }) === null && W.placeFromMap(null) === null, 'world: negative coordinates read, odd or missing ones do not');

    check(P.length >= 70 && new Set(P.map(x => x[0])).size === P.length, 'world: ' + P.length + ' built-in places, none twice');
    check(P.every(x => typeof x[0] === 'string' && x[1] >= -90 && x[1] <= 90 && x[2] >= -180 && x[2] <= 180 && x[3]), 'world: every built-in place has a name, a position on Earth and what it is');
    const r = W.roundFrom(P, 10, Lib.rng(3));
    check(r.length === 10 && new Set(r.map(x => x.name)).size === 10, 'world: a round is ten different places');
    check(typeof sb.WORLD_LAND_D === 'string' && sb.WORLD_LAND_D.length > 5000 && /^M/.test(sb.WORLD_LAND_D) && /Z$/.test(sb.WORLD_LAND_D), 'world: the land outline is a closed path');
  }

  // ── leading out of a game ──────────────────────────────────────────────────
  {
    const maps = [{ name: 'osm_small', kind: 'map', map_search: true, map_bounds: [0, 0, 10, 10] }, { name: 'osm_other', kind: 'map', map_search: true, map_bounds: [100, 40, 120, 60] }, { name: 'osm_nosearch', kind: 'map' }];
    check(same(Lib.mapFor(maps, 5, 5), { zim: 'osm_small', path: 'index.html#map=14/5/5' }), 'lead out: the map whose box holds a point, opened at that point');
    check(same(Lib.mapFor(maps, 50, 110), { zim: 'osm_other', path: 'index.html#map=14/50/110' }), 'lead out: another point, another map');
    check(Lib.mapFor(maps, -40, -70) === null, 'lead out: a point no map holds gives no link');
    check(Lib.mapFor([{ name: 'osm_nobox', kind: 'map', map_search: true }], 5, 5) === null, 'lead out: a map with no known box is not guessed at');
    check(Lib.mapFor(maps, 5, 5, 'osm_other').zim === 'osm_other', 'lead out: the map a place came from, whatever its box');
    check(Lib.mapFor(maps, 5, 5, 'osm_nosearch') === null && Lib.mapFor(null, 1, 1) === null, 'lead out: only searchable maps, and no library is no map');
    check(Lib.hosted() === false && Lib.tell({ zimi: 'open' }) === false, 'lead out: outside Zimi nothing is said to anyone');
    check(await Lib.dictionaryOn() === false, 'lead out: outside Zimi the Dictionary is not offered');
    const a = { dataset: {} }, ev = { defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; } };
    Lib.articleLink(a, 'wikipedia', 'Paris');
    check(a.href === '/w/wikipedia/Paris' || /\/Paris$/.test(a.href), 'lead out: an article link is a plain link to the page');
    a.onclick(ev);
    check(!ev.defaultPrevented, 'lead out: with nothing to ask, the click goes to the link');
    // inside Zimi: the click is said to Zimi (a modified click keeps the link)
    const said = [], hosted = load(['librarykit.js'], { ZimiShell: { hosted: true }, location: { origin: 'http://z', protocol: 'http:' }, parent: { postMessage: (m, o) => said.push([m, o]) } }).GamesLib;
    hosted.articleLink(a, 'wikipedia', 'Paris'); a.onclick(ev);
    check(ev.defaultPrevented && same(said[0], [{ zimi: 'open', zim: 'wikipedia', path: 'Paris' }, 'http://z']), 'lead out: inside Zimi an article opens through Zimi, to the same origin');
    const mod = { defaultPrevented: false, button: 0, metaKey: true, preventDefault() { this.defaultPrevented = true; } };
    a.onclick(mod);
    check(!mod.defaultPrevented && said.length === 1, 'lead out: a modified click is left to the browser');
    const w = { dataset: {} }; hosted.wordLink(w, 'fjord'); w.onclick({ defaultPrevented: false, button: 0, preventDefault() {} });
    check(w.href === '/?dictionary=fjord' && same(said[1][0], { zimi: 'game-app', app: 'dictionary', w: 'fjord' }), 'lead out: a word opens in the Dictionary, and has the Dictionary\'s own address as its link');
    // a word's learn-more link: the page at once, never the Dictionary where there is none
    const link = { dataset: {}, hidden: true, textContent: '' }, T = (k, v) => k + ':' + v.word;
    Lib.wordLearn(link, T, { word: 'fjord', zim: 'wiktionary', path: 'fjord', readKey: 'bl.read' });
    await Lib.dictionaryOn();
    check(link.hidden === false && link.textContent === 'bl.read:fjord' && link.href === '/w/wiktionary/fjord', 'lead out: outside Zimi a word links to its own page');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
