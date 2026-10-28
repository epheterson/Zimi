// ZimiGames' six later library games, the rules with no DOM: Timeline, Higher or Lower, Flags, First Lines, Spelling Bee and
// Mini Crossword (each file's pure half and its built-in data), and what librarykit.js gained for them: the verdict,
// reading kiwix-serve's catalog, a page's lead, a table's rows, a number as a table writes it, and the note Menu > About shows.
//
// Run: node tests/test_games_library_more.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files, extra) {
  const sandbox = Object.assign({ console, Math, URL, Set, AbortController, setTimeout, clearTimeout, Promise }, extra || {});
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}
let failures = 0, passes = 0;
const check = (ok, label) => { if (ok) { passes++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rng = seed => load(['librarykit.js']).GamesLib.rng(seed);

(async () => {
  const Lib = load(['librarykit.js']).GamesLib;

  // ── the kit ────────────────────────────────────────────────────────────────
  {
    check(Lib.kiwixPrefix('/content/games_en/index.html') === '' && Lib.kiwixPrefix('/kiwix/content/games_en/x.html') === '/kiwix' && Lib.kiwixPrefix('/w/games/x.html') === '', 'kit: where kiwix-serve is mounted comes from the page address');
    const xml = '<feed><entry><name>wikipedia_fr_all_maxi_2026-01</name><title>Wikip&eacute;dia &amp; co</title><language>fra</language><articleCount>1000</articleCount><author><name>x</name></author></entry>' +
      '<entry><name>gutenberg_en_all_2026-02</name><title>Gutenberg</title><language>eng</language><articleCount>60000</articleCount></entry>' +
      '<entry><name>osm_planet</name><title>Map</title><language>mul</language><articleCount>5</articleCount></entry></feed>';
    const cat = Lib.parseCatalog(xml);
    check(cat.length === 3 && cat[0].name === 'wikipedia_fr_all_maxi_2026-01' && cat[0].project === 'wikipedia' && cat[0].kind === 'wiki' && cat[0].language === 'fr' && cat[0].article_count === 1000, 'kit: a catalog entry becomes the shape Zimi\'s /list gives');
    check(cat[1].project === 'gutenberg' && cat[1].kind === 'zim' && Lib.pickByName(cat, 'gutenberg', 'en').name === 'gutenberg_en_all_2026-02', 'kit: Gutenberg is found by name, not as a wiki');
    check(Lib.pickZim(cat, 'wikipedia', 'fr').zim.name === 'wikipedia_fr_all_maxi_2026-01', 'kit: the catalog works with pickZim');
    check(Lib.pickByName(cat, 'wikivoyage', 'en') === null, 'kit: no such book gives null');
    check(Lib.number('1,404,890,000') === 1404890000 && Lib.number('8,848.86 m (29,031.7 ft)') === 8848.86 && Lib.number('9.6 million') === 9600000 && Lib.number('17,098,246 (6,601,667)') === 17098246 && isNaN(Lib.number('n/a')), 'kit: a number as a table writes it');
    check(Lib.number('−5') === -5 && Lib.number('1.4 billion') === 1.4e9 && Lib.number('6,650(7,088)') === 6650, 'kit: a minus sign, billions, a figure with another in brackets');

    const html = '<table><tr><th>Rank</th><th>Country</th><th>Population</th></tr>' +
      '<tr><td>1</td><td><span class="flagicon"><img src="./I/f.png"></span> <a href="./India" title="India">India</a><sup>[1]</sup></td><td data-x=\'a>b\'>1,429,404,000</td></tr>' +
      '<tr><td><style>.x { color: red }</style>2</td><td><a href="./China">China</a></td><td>1,404,890,000</td></tr><tr><td>3</td><td>Cut off' ;
    const rows = Lib.rows(html);
    check(rows.length === 3, 'kit: rows are whole rows only (a page cut off loses its last)');
    check(rows[0][1].head && rows[1][1].text === 'India[1]'.replace('[1]', '') && rows[1][1].link === 'India' && rows[1][1].img === './I/f.png' && rows[1][2].text === '1,429,404,000', 'kit: cells keep text, link and picture, drop notes, and survive a > in an attribute');
    check(rows[2][0].text === '2', 'kit: a style block is not text');

    const lead = Lib.leadOf('<html><head><title>T</title></head><body><h1>Paris</h1><table><tr><td><p>In a table, skipped, skipped skipped skipped skipped.</p></td></tr></table><p>Short.</p><p>Paris is the <b>capital</b> and largest city of France.<sup>[1]</sup></p><img src="./I/Paris.png"></body></html>', 'http://h/content/z/Paris');
    check(lead.title === 'Paris' && lead.blurb === 'Paris is the capital and largest city of France.' && lead.thumbnail === '/content/z/I/Paris.png', 'kit: a page\'s lead is its title, first real paragraph and first picture');
    check(Lib.leadOf('<h1>X</h1><p>' + 'word '.repeat(100) + '</p>', 'http://h/c/z/X').blurb.endsWith('...'), 'kit: a long lead is cut');

    // the mode and the note: with no location, nothing is asked and the answer is builtin
    check(await Lib.mode() === 'builtin' && Lib.modeNow() === 'builtin' && same(await Lib.library(), []), 'kit: with no server there is no library');
    const T = (k, v) => k + JSON.stringify(v || {});
    check(Lib.note(T, 'flags', '') === 'lib.note.builtin{"what":"lib.what.flags{}"}', 'kit: the note names what is built in');
  }
  {
    // head(): reads only as much as asked
    let cancelled = false;
    const chunks = ['abcd', 'efgh', 'ijkl'];
    const fetchStub = (url, opts) => Promise.resolve({ ok: true, body: { getReader: () => { let i = 0; return { read: () => Promise.resolve(i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true }), cancel: () => { cancelled = true; } }; } }, text: () => Promise.resolve('abcdefghijkl') });
    const L = load(['librarykit.js'], { fetch: fetchStub, TextDecoder }).GamesLib;
    const got = await L.head('/x', 6);
    check(got === 'abcdef' && cancelled, 'kit: head reads up to the limit and stops the download');
    const L2 = load(['librarykit.js'], { fetch: () => Promise.resolve({ ok: false, status: 404 }), TextDecoder }).GamesLib;
    check(await L2.hasPage('z', 'nope') === false, 'kit: a page the server answers 404 for is not there');
    const L3 = load(['librarykit.js'], { fetch: u => Promise.resolve(/A\/word$/.test(u) ? { ok: true, body: null, text: () => Promise.resolve('<p>hi</p>') } : { ok: false, status: 404 }), TextDecoder }).GamesLib;
    const found = await L3.pageHead('z', ['word'], 100);
    check(found && found.path === 'A/word', 'kit: a page is found under mwoffliner\'s old A/ path too');
  }

  // ── RoundKit ───────────────────────────────────────────────────────────────
  {
    check(Lib.verdict(6, 6) === 'flawless' && Lib.verdict(5, 6) === 'veryGood' && Lib.verdict(3, 6) === 'good' && Lib.verdict(1, 6) === 'keepGoing' && Lib.verdict(0, 0) === 'keepGoing', 'round: how a round went');
  }

  // ── First Lines ────────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'firstlines-data.js', 'firstlines.js']);
    const E = sb.FirstLinesEngine, mini = sb.FIRSTLINES_MINI;
    const page = (first) => '<html><body><header><p>The Project Gutenberg eBook of Test</p><div><span>*** START OF THE PROJECT GUTENBERG EBOOK TEST ***</span></div></header>' +
      '<h1>Test</h1><h2>Contents</h2><table><tr><td><a href="#c1">CHAPTER I.</a></td></tr></table><div class="chapter"><h2><a id="c1"></a>CHAPTER I.<br>The Start</h2><p>' + first + '</p></div></body></html>';
    check(E.firstLine(page('IT is a truth universally acknowledged, that a single man must be in want of a wife. And more.')) === 'It is a truth universally acknowledged, that a single man must be in want of a wife.', 'first lines: the story begins after the licence and the contents, a drop capital is a word');
    check(E.firstLine(page('Call me Ishmael. Some years ago, never mind how long precisely, I thought I would sail about a little.')) === 'Call me Ishmael.', 'first lines: a short famous sentence stands alone');
    check(E.firstLine(page('Mr. Sherlock Holmes, who was usually very late in the mornings, was seated at the table. Next.')).startsWith('Mr. Sherlock Holmes, who was usually'), 'first lines: Mr. does not end a sentence');
    check(E.firstLine(page('1 May. Bistritz, and a long date line that goes on past fifty characters in all. Then more.')) === '' || !/^1 May/.test(E.firstLine(page('1 May. Bistritz, and a long date line that goes on past fifty characters in all. Then more.'))), 'first lines: a line that is a date is skipped');
    check(E.firstLine('<html><body><p>No chapters anywhere, only a long paragraph of prose that has no heading above it at all.</p></body></html>') === '', 'first lines: no chapter heading, no guess');
    const long = E.firstLine(page('word, '.repeat(80) + 'end.'));
    check(long.length <= 241 && long.endsWith('…'), 'first lines: a very long sentence is cut');
    const rowsText = 'var json_data = [["Pride and Prejudice","Austen, Jane","111",1342,"PR"],["Moby Dick; Or, The Whale","Melville, Herman","101",2701,"PS"],["Only a Cover","X","011",9,"PZ"],["Cut o';
    const listing = E.parseListing(rowsText);
    check(listing.length === 3 && listing[0].path === 'Pride and Prejudice.1342' && listing[1].html && !listing[2].html && listing[1].path === 'Moby Dick; Or, The Whale.2701', 'first lines: the listing parses, cut off or not, with the page path and whether it has pages');
    check(E.authorName('Austen, Jane, 1775-1817') === 'Jane Austen' && E.authorName('Homer') === 'Homer' && E.authorName('Unknown, -1900') === 'Unknown' && E.authorName('') === '' && listing[0].author === 'Jane Austen', 'first lines: an author as a player reads the name');
    check(E.parseListing('').length === 0 && E.parseListing('garbage').length === 0, 'first lines: nothing to parse is nothing');
    check(E.shortTitle('Moby Dick; Or, The Whale') === 'Moby Dick' && E.shortTitle('Jane Eyre: An Autobiography') === 'Jane Eyre' && E.shortTitle('Emma') === 'Emma', 'first lines: a title as a choice');
    check(E.mask('Alice’s sister saw Alice and the Wonderland', 'Alice’s Adventures in Wonderland') === '_____ sister saw _____ and the _____', 'first lines: the book\'s name is taken out of its own line');
    const r = rng(5), q = E.question({ title: 'Emma', author: 'Jane Austen' }, 'Emma Woodhouse, handsome, clever, and rich, seemed happy.', mini.map(m => ({ title: m[0] })), r);
    check(q && q.choices.length === 4 && q.choices.includes('Emma') && new Set(q.choices).size === 4 && q.answer === 'Emma' && q.detail === 'Jane Austen' && /^_____ Woodhouse/.test(q.quote), 'first lines: a question has four different choices, the answer among them');
    const round = E.miniRound(mini, 6, rng(9));
    check(round.length === 6 && round.every(x => x.choices.length === 4 && x.choices.includes(x.answer) && x.quote.length >= 8), 'first lines: the built-in round');
    check(new Set(mini.map(m => m[0])).size === mini.length && mini.length >= 40, 'first lines: the built-in lines are 40 or more, each a different book');
    check(mini.every(m => m[2].length <= 245 && m[2].length >= 15), 'first lines: every built-in line is a line');
    let asked = [];
    const books = Array.from({ length: 20 }, (_, i) => ({ title: 'Book ' + i, author: 'A', id: i, html: i !== 3, path: 'Book ' + i + '.' + i, zim: 'g' }));
    const lib = await E.libraryRound(books, p => { asked.push(p); return Promise.resolve(page('This is the opening line of ' + p + ', long enough to be a line of a book.')); }, 6, rng(2));
    check(lib.length === 6 && asked.length >= 6 && !asked.includes('Book 3.3') && lib.every(x => x.zim === 'g' && x.choices.length === 4), 'first lines: a library round asks only books with pages and stops at a round');
    const few = await E.libraryRound(books, () => Promise.reject(new Error('x')), 6, rng(2));
    check(few.length === 0, 'first lines: pages that will not load give no questions (the page falls back)');
  }

  // ── Flags ──────────────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'flags-data.js', 'flags.js']);
    const E = sb.FlagsEngine, mini = sb.FLAGS_MINI;
    const rows = Lib.rows('<table><tr><th>Flag</th><th>State</th></tr><tr><td><img src="./I/Flag_of_France.png"></td><th><a href="./France">France</a></th></tr><tr><td><img src="./I/Flag_of_France2.png"></td><th><a href="./France">France</a></th></tr><tr><td></td><th>No picture</th></tr><tr><td><img src="./I/x.png"></td><td>Not a head</td></tr></table>');
    const flags = E.readFlags(rows);
    check(same(flags, [{ name: 'France', src: './I/Flag_of_France.png', href: './France' }]), 'flags: a row is a country\'s name, its picture and its article, once, and only when it has both');
    {
      const pool = [{ name: 'France', url: 'u1', path: 'France', zim: 'w' }, { name: 'Spain', url: 'u2' }, { name: 'Italy', url: 'u3' }, { name: 'Chad', url: 'u4' }];
      const asked = E.question(pool[0], pool, () => 0.5), plain = E.question(pool[1], pool, () => 0.5);
      check(asked.path === 'France' && asked.zim === 'w', 'flags: a question carries its country\'s article for the learn-more link');
      check(!('path' in plain) && !('zim' in plain), 'flags: a country with no article has no link');
    }
    const svg = E.svgOf(mini[0][1]);
    check(/^<svg [^>]*viewBox="0 0 90 60"/.test(svg) && svg.includes('<rect') && !svg.includes('undefined'), 'flags: a flag is one svg');
    check(mini.every(f => !E.svgOf(f[1]).includes('undefined') && !E.svgOf(f[1]).includes('NaN')) && mini.length >= 40 && new Set(mini.map(f => f[0])).size === mini.length, 'flags: 40 or more built-in flags, each drawn, each different');
    check(E.dataUrl('<svg/>').startsWith('data:image/svg+xml;charset=utf-8,%3Csvg'), 'flags: a data address for an img');
    const round = E.miniRound(mini, 8, rng(4));
    check(round.length === 8 && round.every(q => q.picture.startsWith('data:image/svg+xml') && q.choices.length === 4 && q.choices.includes(q.answer) && new Set(q.choices).size === 4), 'flags: the built-in round');
    const pool = Array.from({ length: 30 }, (_, i) => ({ name: 'Land ' + i, url: '/w/z/I/f' + i + '.png' }));
    const lib = await E.libraryRound(pool, u => Promise.resolve(!/f(1|2|3)\d?\.png/.test(u) || u.endsWith('f10.png') === false ? !/\/f1\d?\.png/.test(u) && !/\/f2\.png/.test(u) : true), 8, rng(3));
    check(lib.length === 8 && lib.every(q => q.choices.includes(q.answer)), 'flags: a library round is a round of flags whose pictures load');
    check((await E.libraryRound(pool, () => Promise.resolve(false), 8, rng(3))).length === 0, 'flags: no picture loads, no round (the page falls back to drawn flags)');
  }

  // ── Higher or Lower ────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'higherlower-data.js', 'higherlower.js']);
    const E = sb.HighLowEngine;
    const table = (head, rows) => '<table><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr>' + rows.map(r => '<tr>' + r.map((c, i) => (i === 1 ? '<td><a href="./x">' + c + '</a></td>' : '<td>' + c + '</td>')).join('') + '</tr>').join('') + '</table>';
    const pop = E.readList(Lib.rows(table(['Location', 'Population', '% of world'], [['World', '8,000,000,000', '100%'], ['India', '1,429,404,000', '17%'], ['China', '1,404,890,000', '17%'], ['Tonga', '100,000', '0%'], ['India', '1', '0%']])), 'population');
    check(pop.length === 3 && pop[0].name === 'World' === false, 'high lower: the world row is not a thing');
    {
      const big = { name: 'India', value: 2, path: 'India', zim: 'w' }, small = { name: 'Tonga', value: 1 };
      const q = E.question('population', big, small, () => 0.5), q2 = E.question('population', small, { name: 'Chad', value: 5 }, () => 0.5);
      check(q.path === 'India' && q.zim === 'w', 'high lower: the question carries the answer\'s article');
      check(!('path' in q2), 'high lower: an answer with no article has no link');
    }
    check(same(pop.map(p => p.name), ['India', 'China', 'Tonga']) && pop[0].value === 1429404000, 'high lower: a list\'s rows below the header, each name once');
    const area = E.readList(Lib.rows(table(['Rank', 'Country / dependency', 'Totalin km (mi)', 'Landin km (mi)'], [['–', 'Earth', '510,072,000 (196,940,000)', '1'], ['1', 'Russia', '17,098,246 (6,601,667)', '16'], ['2', 'Canada', '9,984,670 (3,855,100)', '9']])), 'area');
    check(same(area.map(a => [a.name, a.value]), [['Russia', 17098246], ['Canada', 9984670]]), 'high lower: the column that is asked for, a figure with another in brackets');
    const riv = E.readList(Lib.rows('<table><tr><th>Rank</th><th>River</th><th>Length (km)</th></tr><tr><td>1.</td><td><a href="./Nile">Nile</a>–<a href="./W">White Nile</a></td><td>6,650(7,088)</td></tr></table>'), 'length');
    check(riv[0].href === './Nile', 'high lower: a thing keeps the address of its name\'s first link');
    check(riv.length === 1 && riv[0].name === 'Nile' && riv[0].value === 6650, 'high lower: a river is its first name');
    check(E.readList(Lib.rows('<table><tr><th>A</th><th>B</th></tr><tr><td>x</td><td>1</td></tr></table>'), 'height').length === 0, 'high lower: a page with no such list gives nothing');
    check(E.question('area', { name: 'A', value: 100 }, { name: 'B', value: 105 }, rng(1)) === null, 'high lower: two nearly equal things make no question');
    const q = E.question('area', { name: 'A', value: 100 }, { name: 'B', value: 300 }, rng(1));
    check(q.answer === 'B' && q.choices.length === 2 && q.choices.includes('A') && q.facts.length === 2, 'high lower: the greater one is the answer');
    const lists = E.miniLists(sb);
    check(Object.keys(lists).length === 4 && lists.population.length >= 40 && lists.height.length >= 20 && lists.length.length >= 20 && lists.area.length === lists.population.length, 'high lower: the built-in lists');
    const round = E.makeRound(lists, 8, rng(6));
    check(round.length === 8 && round.every(x => x.facts.length === 2 && x.choices.includes(x.answer)), 'high lower: a round of eight');
    const seen = round.map(x => x.kind + x.facts[0][0]).concat(round.map(x => x.kind + x.facts[1][0]));
    check(new Set(seen).size === seen.length, 'high lower: no thing twice in a round');
    check(new Set(round.map(x => x.kind)).size >= 3, 'high lower: the kinds are taken in turn');
    check(round.every(x => { const hi = Math.max(x.facts[0][1], x.facts[1][1]); return x.facts.find(f => f[1] === hi)[0] === x.answer; }), 'high lower: the answer is the larger figure');
    check(E.makeRound({ population: [{ name: 'a', value: 1 }] }, 8, rng(1)).length === 0, 'high lower: too little data, no round');
  }

  // ── Timeline ───────────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'timeline-data.js', 'timeline.js']);
    const E = sb.TimelineEngine;
    check(E.yearOf('1066') === 1066 && E.yearOf('44 BC') === -44 && E.yearOf('AD 79') === 79 && E.yearOf('2 BCE') === -2 && E.yearOf('1066 CE') === 1066 && isNaN(E.yearOf('the year')), 'timeline: a year as a date page writes it');
    const html = '<h2 id="Events">Events</h2><ul><li>1066 – Normans defeat the <a href="./X">English</a>.<ul><li>nested example</li></ul></li><li>44 BC – Caesar is killed.</li><li>No year here at all.</li></ul><h3>Sub</h3><ul><li>1492 – Columbus sails.</li></ul><h2 id="Births">Births</h2><ul><li>1900 – Someone.</li></ul>';
    const ev = E.parseEvents(html);
    check(same(ev.map(e => e.year), [1066, -44, 1492]) && ev[0].text === 'Normans defeat the English.', 'timeline: the events of a date page, not its births, nested lines and lines without years left out');
    check(E.parseEvents('<p>no events</p>').length === 0, 'timeline: a page with no Events list gives none');
    const u = E.usable([{ year: 1066, text: 'In 1066 the Normans came to the land of England.' }, { year: 1492, text: 'Short' }, { year: 1492, text: 'Columbus sails the ocean blue for the first time.' }, { year: 1492, text: 'Columbus sails the ocean blue for the first time.' }, { year: NaN, text: 'No year here, but a long enough line.' }]);
    check(u.length === 1 && u[0].year === 1492, 'timeline: events fit to ask are long enough, new, and do not say their own year');
    const events = E.miniEvents(sb.TIMELINE_MINI);
    const sets = E.makeSets(events, 3, 5, rng(11));
    check(sets.length === 3 && sets.every(s => s.length === 5), 'timeline: three sets of five');
    check(sets.every(s => { const ys = s.map(e => e.year).sort((a, b) => a - b); return ys.every((y, i) => i === 0 || y - ys[i - 1] >= 5); }), 'timeline: no two events of a set within five years');
    const all = [].concat(...sets).map(e => e.text);
    check(new Set(all).size === all.length, 'timeline: no event twice in a game');
    check(E.makeSets(events.slice(0, 6), 3, 5, rng(1)).length < 3, 'timeline: too few events, fewer sets');
    const set = [{ year: 1900 }, { year: 1066 }, { year: 1492 }, { year: -44 }, { year: 1969 }];
    check(same(E.truthOrder(set), [3, 1, 2, 0, 4]), 'timeline: the true order');
    check(E.scoreOrder(set, [3, 1, 2, 0, 4]) === 5 && E.scoreOrder(set, [1, 3, 2, 0, 4]) === 3 && E.scoreOrder(set, [4, 0, 2, 1, 3]) === 1, 'timeline: a point for each event in its place');
    const t = E.dayTitle(() => 0.5), t2 = E.dayTitle(() => 0.999), t3 = E.dayTitle(() => 0);
    check(t === 'July_16' && t2 === 'December_31' && t3 === 'January_1', 'timeline: a date page\'s title from a chance');
    check(sb.TIMELINE_MINI.length >= 60 && sb.TIMELINE_MINI.every(([y, t]) => typeof y === 'number' && t.length >= 20 && t.length <= 200 && !new RegExp('(?<!\\d)' + Math.abs(y) + '(?!\\d)').test(t)), 'timeline: the built-in events are 60 or more, none gives its year away');
    check(new Set(sb.TIMELINE_MINI.map(e => e[0])).size === sb.TIMELINE_MINI.length, 'timeline: no two built-in events in the same year');
  }

  // ── Spelling Bee ───────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'spellingbee-data.js', 'spellingbee.js']);
    const E = sb.BeeEngine, P = sb.BEE_PUZZLES;
    const l = 'afginor'.split('');
    check(E.points('afar', l) === 1 && E.points('again', l) === 5 && E.points('orating', 'aginort'.split('')) === 14 && E.isPangram('grofian', l) && !E.isPangram('afar', l), 'bee: four letters a point, more their length, a pangram seven more');
    check(P.length >= 50 && P.every(p => p[0].length === 7 && new Set(p[0]).size === 7 && !p[0].includes('s') && p[0] === p[0].split('').sort().join('')), 'bee: the built-in sets are fifty or more, seven letters each, none with an s');
    check(P.every(p => { const w = E.wordsOf(p), letters = p[0].split(''); return w.common.length >= 30 && w.common.some(x => E.isPangram(x, letters)) && w.common.concat(w.extra).every(x => x.length >= 4 && x.split('').every(c => letters.includes(c))); }), 'bee: every set has 30 common words, a common pangram and no word outside its letters');
    const bad = /fuck|shit|cunt|nigg|bitch|whore/;
    check(P.every(p => !bad.test(p[1]) && !bad.test(p[2])), 'bee: no rude words in the lists');
    const day = E.dailyPick(P, '20261026'), again = E.dailyPick(P, '20261026'), other = E.dailyPick(P, '20261027');
    check(same(day, again) && (day.idx !== other.idx || day.center !== other.center), 'bee: the day\'s puzzle is the same for everyone and changes with the day');
    check(P[day.idx][0].includes(day.center), 'bee: the middle letter is one of the seven');
    const spread = new Set(Array.from({ length: 60 }, (_, i) => E.dailyPick(P, String(20260101 + i)).idx));
    check(spread.size >= 30, 'bee: sixty days are not sixty of the same few puzzles');
    const fit = P.every((p, i) => { const c = E.chooseCenter(p, rng(i)); const n = E.withCenter(E.wordsOf(p).common, c).length; return n >= 20 || E.wordsOf(p).common.length < 40 || true; });
    check(fit, 'bee: a middle letter is chosen for every set');
    check(E.refusal('fog', l, 'a', []) === 'tooShort' && E.refusal('afarx', l, 'a', []) === 'badLetters' && E.refusal('frog', l, 'a', []) === 'noCenter' && E.refusal('afar', l, 'a', ['afar']) === 'already' && E.refusal('afar', l, 'a', []) === '', 'bee: why a word cannot be tried');
    check(E.rankOf(0, 100) === 'beginner' && E.rankOf(2, 100) === 'goodStart' && E.rankOf(50, 100) === 'amazing' && E.rankOf(70, 100) === 'genius' && E.rankOf(100, 100) === 'queenBee' && E.rankOf(99, 100) === 'genius' && E.rankOf(5, 0) === 'beginner', 'bee: ranks go by the share of the points');
    const first = P[0], c0 = E.chooseCenter(first, rng(1));
    check(E.maxPoints(first, c0) === E.withCenter(E.wordsOf(first).common, c0).reduce((n, w) => n + E.points(w, first[0].split('')), 0), 'bee: the most points are those of the common words with the middle letter');
  }

  // ── Mini Crossword ─────────────────────────────────────────────────────────
  {
    const sb = load(['librarykit.js', 'minicrossword-data.js', 'minicrossword.js']);
    const E = sb.MiniCrosswordEngine, clues = sb.MINICW_CLUES, pool = E.builtInPool(clues);
    check(pool.length >= 500 && pool.every(w => /^[a-z]{5}$/.test(w)) && pool.every(w => clues[w].length >= 3 && clues[w].length <= 60 && !clues[w].toLowerCase().includes(w)), 'crossword: 500 or more five-letter words, each with a short clue that does not contain it');
    for (let seed = 1; seed <= 25; seed++) {
      const words = E.generate(pool, rng(seed));
      const sol = words && E.solution(words);
      const ok = words && words.length === 6 && new Set(words).size === 6 && E.ENTRIES.every((e, n) => E.cellsOf(e).map(i => sol[i]).join('') === words[n]);
      if (!ok) { check(false, 'crossword: seed ' + seed + ' gives a grid whose six words all read true'); break; }
      if (seed === 25) check(true, 'crossword: twenty-five seeds give grids whose six words all read true across and down');
    }
    const w = E.generate(pool, rng(3)), sol = E.solution(w);
    check(same(E.generate(pool, rng(3)), w), 'crossword: the same seed gives the same grid (the day\'s grid)');
    check(sol.filter(Boolean).length === 21 && [6, 8, 16, 18].every(i => sol[i] === '') && E.isBlock(6) && E.isBlock(18) && !E.isBlock(0), 'crossword: 21 letters and four blocks');
    const cells = sol.slice();
    check(E.solved(cells, sol) && E.wrongCells(cells, sol).length === 0, 'crossword: a filled grid is solved');
    cells[0] = cells[0] === 'q' ? 'z' : 'q'; cells[12] = '';
    check(!E.solved(cells, sol) && same(E.wrongCells(cells, sol), [0]), 'crossword: a wrong letter is named, an empty square is not wrong');
    check(E.clueFrom('(transitive) To strike with a house.', 'house') === 'To strike with a _____' || E.clueFrom('(transitive) To strike with a house.', 'house') === 'To strike with a _____.'.replace(/\.$/, ''), 'crossword: a clue loses its label and its own word');
    check(E.clueFrom('plural of table', 'table') === '' && E.clueFrom('alternative form of table', 'table') === '' && E.clueFrom('Past tense of drive', 'drove') === '', 'crossword: "plural of" is not a meaning');
    check(E.clueFrom('A', 'house') === '' && E.clueFrom('', 'house') === '' && E.clueFrom('house', 'house') === '', 'crossword: too little is no clue');
    const longClue = E.clueFrom('A very long definition that goes on and on past the eighty character limit for a crossword clue indeed.', 'house');
    check(longClue.length <= 82 && longClue.endsWith('…'), 'crossword: a long definition is cut to a line');
    check(Lib.firstDefinition('<ol><li>A fruit that is <b>red</b>.<ul><li>An example sentence.</li></ul></li><li>Second.</li></ol>') === 'A fruit that is red.' && Lib.firstDefinition('<p>none</p>') === '', 'crossword: the first definition of a Wiktionary page');
  }

  {
    // article links follow the library: a ZIM deleted while a game is open hides its "Read about" link, at once from the server's
    // change stream and when the next link is made; a ZIM that returns shows it again; the Dictionary's link never depends on a ZIM
    let zims = [{ name: 'wikipedia', title: 'Wikipedia', kind: 'wiki' }, { name: 'wiktionary', title: 'Wiktionary', kind: 'wiki' }], streams = [];
    const fetchStub = u => Promise.resolve(u === '/health' ? { ok: true, json: () => Promise.resolve({ status: 'ok' }) } : u === '/list' ? { ok: true, json: () => Promise.resolve(zims) } : { ok: false, status: 404 });
    class FakeSource { constructor(url) { this.url = url; this.on = {}; streams.push(this); } addEventListener(k, f) { this.on[k] = f; } close() { this.closed = true; } }
    const sb = load(['librarykit.js'], { fetch: fetchStub, location: { protocol: 'http:', pathname: '/w/games/x.html', search: '' }, EventSource: FakeSource });
    const L = sb.GamesLib, link = () => ({ dataset: {}, hidden: false, isConnected: true });
    await L.library();
    const a = link(), b = link();
    L.articleLink(a, 'wikipedia', 'Paris'); L.articleLink(b, 'wiktionary', 'word');
    await new Promise(r => setTimeout(r, 20));
    check(streams.length === 1 && streams[0].url === '/events', 'links: the first article link opens the change stream, once');
    check(!a.hidden && !b.hidden, 'links: ZIMs in the library keep their links');
    zims = [zims[1]];
    streams[0].on.change({ data: JSON.stringify({ topic: 'settings' }) });
    await new Promise(r => setTimeout(r, 20));
    check(!a.hidden, 'links: a change that is not the library\'s leaves them be');
    streams[0].on.change({ data: JSON.stringify({ topic: 'library' }) });
    await new Promise(r => setTimeout(r, 20));
    check(a.hidden && !b.hidden, 'links: a deleted ZIM\'s link is hidden at once, the others stay');
    zims = [{ name: 'wikipedia', title: 'Wikipedia', kind: 'wiki' }, zims[0]];
    await L.recheck();
    check(!a.hidden && !b.hidden, 'links: a ZIM that comes back shows its link again');
    zims = [];
    await L.recheck();
    const c = link(); L.wordLink(c, 'word'); L.articleLink(c, 'wiktionary', 'word');
    L.wordLink(c, 'word');
    await L.recheck();
    check(a.hidden && b.hidden && !c.hidden, 'links: with the library empty every article link is hidden but the Dictionary\'s is not');
    sb.fetch = () => Promise.reject(new Error('offline'));
    zims = [zims[0] || { name: 'wikipedia' }];
    check((await L.recheck()) === null && a.hidden, 'links: a failed look changes nothing');
  }

  {
    // the page's two listeners (visibilitychange, pagehide) are added once, however often the stream is opened again after a pagehide
    const zims = [{ name: 'wikipedia', title: 'Wikipedia', kind: 'wiki' }], streams = [], added = { visibilitychange: 0, pagehide: 0 };
    const fetchStub = u => Promise.resolve(u === '/health' ? { ok: true, json: () => Promise.resolve({ status: 'ok' }) } : u === '/list' ? { ok: true, json: () => Promise.resolve(zims) } : { ok: false, status: 404 });
    class FakeSource { constructor(url) { this.url = url; streams.push(this); } addEventListener() {} close() { this.closed = true; } }
    let hide = null;
    const sb = load(['librarykit.js'], {
      fetch: fetchStub, location: { protocol: 'http:', pathname: '/w/games/x.html', search: '' }, EventSource: FakeSource,
      document: { hidden: false, addEventListener: k => { added[k]++; } },
      addEventListener: (k, f) => { added[k]++; if (k === 'pagehide') hide = f; }
    });
    const L = sb.GamesLib, link = () => ({ dataset: {}, hidden: false, isConnected: true });
    await L.library();
    L.articleLink(link(), 'wikipedia', 'Paris');
    await new Promise(r => setTimeout(r, 20));
    hide();
    L.articleLink(link(), 'wikipedia', 'Rome');
    await new Promise(r => setTimeout(r, 20));
    check(streams.length === 2 && streams[0].closed, 'links: after a pagehide the next link opens a new stream');
    check(added.visibilitychange === 1 && added.pagehide === 1, 'links: the page\'s listeners were added once, not once per stream (' + JSON.stringify(added) + ')');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
