// The saved store (1.12): one place for bookmarks, lists, likes and where
// you were, merged across devices so a delete on one survives the others.
//
// Runs app.js's Saved itself (extracted, in a sandbox with its own
// localStorage per "device"): the merge cases users.py passes too
// (tests/saved_merge_cases.json), bookmarks v2 migrated (folders, app items,
// a map's place, Bookshelf's places), the API an app page calls (highlights too), and two
// devices deleting and merging.
//
// Run: node tests/test_saved_store.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const m = src.match(/var Saved = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
if (!m) throw new Error('could not extract Saved from app.js');
// The shell's storage helpers the store reads and writes its small keys with.
const helpers = src.match(/function _getStorageJSON\(key, fallback, session\) \{[\s\S]*?\nfunction _setStorageJSON\(key, value\) \{[\s\S]*?\n\}/);
if (!helpers) throw new Error('could not extract the storage helpers from app.js');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'saved_merge_cases.json'), 'utf8')).cases;
const SKM = src.match(/SAVED: '([^']+)'/);

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function memoryStorage(seed) {
  const s = Object.assign({}, seed || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: (k) => { delete s[k]; },
    _all: s,
  };
}
// One browser: its own storage, its own clock, its own Saved.
function device(seed, opts) {
  opts = opts || {};
  const ctx = {
    localStorage: memoryStorage(seed),
    SK: { SAVED: 'zimi_saved', SAVED_POS: 'zimi_saved_pos', SAVED_LEGACY_ASKED: 'zimi_saved_legacy_asked',
      BOOKMARKS: 'zimi_bookmarks', BM_FOLDERS: 'zimi_bm_folders', BOOK_PLACES: 'zimi_book_places' },
    Math, JSON, Object, Array, String, Number, isFinite, Infinity,
    changes: [], full: 0, storageFull: 0,
    _zimInfo: opts.zimInfo,
  };
  ctx.clock = opts.clock || 1700000000000;
  ctx.Date = { now: () => ctx.clock };
  ctx._savedChanged = (fromSync) => ctx.changes.push(fromSync);
  ctx._savedFull = () => ctx.full++;
  ctx._savedStorageFull = () => ctx.storageFull++;
  vm.createContext(ctx);
  vm.runInContext(helpers[0] + '\n' + m[0], ctx);
  return ctx;
}
const J = (x) => JSON.stringify(x);
function full(part) {
  return Object.assign({ v: 1, items: {}, lists: {}, members: {}, positions: {}, highlights: {}, gone: {}, legacy: false }, part);
}
// Deep equality regardless of key order.
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return J(ka) === J(kb) && ka.every((k) => same(a[k], b[k]));
}

ok('the store has its own key, beside the old ones', SKM && SKM[1] === 'zimi_saved');

// ── the merge: the same cases as users.py's twin ────────────────────────────
{
  const d = device();
  CASES.forEach((c) => {
    const got = d.Saved._merge(d.Saved._clean(c.a), d.Saved._clean(c.b), c.now, c.budget);
    ok('merge: ' + c.name, same(JSON.parse(J(got)), full(c.expect)), same(JSON.parse(J(got)), full(c.expect)) ? '' : J(got));
  });
}

// ── bookmarks v2 come in ────────────────────────────────────────────────────
const T0 = 1690000000000;
const FOLDERS = [
  { id: 'f_travel', name: 'Travel', parent: '', order: 0 },
  { id: 'f_pt', name: 'Portugal', parent: 'f_travel', order: 0 },
  { id: 'f_med', name: 'Medical', parent: '', order: 1 },
  { id: 'f_card', name: 'Cardiology', parent: 'f_med', order: 0 },
  { id: 'f_empty', name: 'Research', parent: '', order: 2 },
];
const BOOKMARKS = [
  { zim: 'wikivoyage', path: 'A/Lisbon', title: 'Lisbon', timestamp: T0 + 1, folder: 'f_pt', order: 1 },
  { zim: 'wikivoyage', path: 'A/Porto', title: 'Porto', timestamp: T0 + 2, folder: 'f_pt', order: 0 },
  { zim: 'osm-portugal', path: 'index.html', title: 'Portugal map', timestamp: T0 + 3, folder: 'f_pt', order: 2, pos: 'map=12.00/38.72000/-9.14000' },
  { zim: 'ted', path: 'videos/lisbon', title: 'A talk on Lisbon', timestamp: T0 + 4, folder: 'f_travel', app: 'tube' },
  { zim: 'wikipedia', path: 'A/Heart', title: 'Heart', timestamp: T0 + 5, folder: 'f_card', order: 0 },
  { zim: 'wikipedia', path: 'A/Aspirin', title: 'My aspirin notes', origTitle: 'Aspirin', timestamp: T0 + 6, folder: 'f_med', order: 0 },
  { zim: 'cooking.stackexchange', path: 'questions/1/bread', title: 'Why does bread rise?', timestamp: T0 + 7, app: 'exchange' },
  { zim: 'reddit_askhistorians', path: 'r/AskHistorians/comments/x', title: 'A post', timestamp: T0 + 8, folder: '', app: 'reddot' },
  { zim: 'wikipedia', path: 'A/Orphan', title: 'Orphan', timestamp: T0 + 9, folder: 'f_deleted_long_ago', order: 0 },
  { zim: 'gutenberg_en', path: 'Tales.5139', title: 'Tales', timestamp: T0 + 10 },
];
const PLACES = {
  'gutenberg_la\nAeneidos.227': { f: 0.34, c: 51234, ts: T0 + 20, id: 227, title: 'Aeneidos', author: 'Virgil', cover: 'covers/227_cover_image.jpg' },
  'gutenberg_en\nTales.5139': { f: 0.5, c: 900, ts: T0 + 21, id: 5139, title: 'Tales', author: '', cover: '' },
};
const LEGACY = {
  zimi_bookmarks: J(BOOKMARKS), zimi_bm_folders: J(FOLDERS), zimi_book_places: J(PLACES),
};
{
  const d = device(LEGACY, { zimInfo: (z) => (/^gutenberg/.test(z) ? { kind: 'books' } : { kind: 'wiki' }) });
  const S = d.Saved;
  const lists = S.lists();
  ok('every folder is a list, nested names as a path, in the tree\'s order, Liked first',
    J(lists.map((l) => l.name)) === J(['', 'Travel', 'Travel / Portugal', 'Medical', 'Medical / Cardiology', 'Research']) && lists[0].id === 'liked' && lists[0].builtin,
    J(lists.map((l) => l.name)));
  ok('the folder ids stay the list ids', J(lists.slice(1).map((l) => l.id)) === J(['f_travel', 'f_pt', 'f_med', 'f_card', 'f_empty']));
  ok('an empty folder is an empty list, not dropped', lists[5].count === 0);
  const pt = S.itemsFor({ list: 'f_pt' });
  ok('a folder keeps its order', J(pt.map((i) => i.title)) === J(['Porto', 'Lisbon', 'Portugal map']), J(pt.map((i) => i.title)));
  const map = pt[2];
  ok('a map bookmark is a place, where it was, in Maps', map.kind === 'place' && map.app === 'maps' && map.where.pos === 'map=12.00/38.72000/-9.14000' &&
    map.key === 'osm-portugal\nindex.html\nmap=12.00/38.72000/-9.14000');
  const talk = S.get({ zim: 'ted', path: 'videos/lisbon' });
  ok('a ZimiTube bookmark is a video in its app', talk && talk.kind === 'video' && talk.app === 'tube' && J(talk.lists) === J(['f_travel']));
  ok('a question and a post keep their apps', S.get('cooking.stackexchange\nquestions/1/bread').kind === 'question' && S.get('reddit_askhistorians\nr/AskHistorians/comments/x').app === 'reddot');
  const asp = S.get('wikipedia\nA/Aspirin');
  ok('a renamed bookmark keeps its name and the page\'s own title', asp.title === 'My aspirin notes' && asp.origTitle === 'Aspirin');
  ok('the time it was bookmarked is the time it was added', asp.added === T0 + 6);
  ok('a top-level bookmark, or one in a folder that is gone, is saved in no list',
    J(S.itemsFor({ list: '' }).map((i) => i.title)) === J(['Tales', 'Orphan', 'A post', 'Why does bread rise?']), J(S.itemsFor({ list: '' }).map((i) => i.title)));
  ok('a Gutenberg page is a book in Bookshelf', S.get('gutenberg_en\nTales.5139').kind === 'book' && S.get('gutenberg_en\nTales.5139').app === 'books');
  ok('nothing is lost: ten bookmarks, ten items', S.all().length === 10);
  const cont = S.continued({ app: 'books' });
  ok('Bookshelf\'s places are positions, the latest first', cont.length === 2 && cont[0].path === 'Tales.5139' && cont[1].where.f === 0.34 && cont[1].where.c === 51234 && cont[1].meta.author === 'Virgil' && cont[1].title === 'Aeneidos');
  ok('the old keys stay where they were (readable for one release)', d.localStorage.getItem('zimi_bookmarks') === LEGACY.zimi_bookmarks && d.localStorage.getItem('zimi_bm_folders') === LEGACY.zimi_bm_folders && d.localStorage.getItem('zimi_book_places') === LEGACY.zimi_book_places);
  ok('the store is written once it is made', !!d.localStorage.getItem('zimi_saved'));
  ok('coming in is not a change anyone has to hear about', d.changes.length === 0);

  // Idempotent: the same bookmarks again change nothing.
  const again = S.mergeLegacy({ bookmarks: BOOKMARKS, folders: FOLDERS, places: PLACES });
  ok('migrating twice changes nothing', again.changed === false && again.added === 0 && again.dupes === 10, J(again));
  // A delete after the migration holds when the old data comes in again.
  d.clock = T0 + 100000;
  S.remove('wikipedia\nA/Heart');
  S.renameList('f_med', 'Health');
  const back = S.mergeLegacy({ bookmarks: BOOKMARKS, folders: FOLDERS });
  ok('a delete made after the migration is not undone by it', !S.has('wikipedia\nA/Heart') && back.added === 0);
  ok('nor a rename', S.lists().filter((l) => l.id === 'f_med')[0].name === 'Health');
  // The same page bookmarked twice, into two folders (a merge of two
  // devices' v2 data can leave that): one item, in both lists, whichever
  // record comes first.
  const twice = [
    { zim: 'w', path: 'A/Twice', title: 'Newer', timestamp: 200, folder: 'f_med' },
    { zim: 'w', path: 'A/Twice', title: 'Older', timestamp: 100, folder: 'f_travel' },
  ];
  [twice, twice.slice().reverse()].forEach((bms, n) => {
    const t2 = device().Saved._fromLegacy({ bookmarks: bms, folders: FOLDERS });
    const lists = Object.keys(t2.members).filter((m) => m.endsWith('\tw\nA/Twice')).map((m) => m.split('\t')[0]).sort();
    ok('one page in two folders is one item in both lists (order ' + n + ')', JSON.stringify(lists) === JSON.stringify(['f_med', 'f_travel']) && t2.items['w\nA/Twice'].title === 'Newer', JSON.stringify(lists));
  });
  // A fresh load reads the store, not the old keys again.
  const d2 = device(Object.assign({}, d.localStorage._all));
  ok('a second visit reads the store', !d2.Saved.has('wikipedia\nA/Heart') && d2.Saved.all().length === 9);
}

// ── the API an app page calls ──────────────────────────────────────────────
{
  const d = device();
  const S = d.Saved;
  ok('an empty browser has only Liked', S.lists().length === 1 && S.all().length === 0);
  const book = { kind: 'book', zim: 'gutenberg_la', path: 'Aeneidos.227', title: 'Aeneidos', meta: { id: 227, author: 'Virgil' } };
  const key = S.save(book);
  ok('save returns the key: the ZIM and the path', key === 'gutenberg_la\nAeneidos.227' && S.key(book) === key && S.has(book) && S.has(key));
  const got = S.get(key);
  ok('an item: kind, zim, path, title, its app from its kind, meta, added, lists', got.kind === 'book' && got.app === 'books' && got.meta.author === 'Virgil' && got.added === d.clock && J(got.lists) === '[]');
  ok('a change is announced (not as the account\'s)', d.changes.length === 1 && d.changes[0] === false);
  d.clock += 10;
  S.save({ kind: 'book', zim: 'gutenberg_la', path: 'Aeneidos.227', title: 'Aeneid' });
  ok('saving again updates it, keeping when it was added and its meta', S.get(key).title === 'Aeneid' && S.get(key).added === 1700000000000 && S.get(key).meta.author === 'Virgil');
  S.rename(key, 'Virgil for the train');
  S.save({ kind: 'book', zim: 'gutenberg_la', path: 'Aeneidos.227', title: 'Aeneidos (from the page)' });
  ok('a name the person chose survives the page saving it again', S.get(key).title === 'Virgil for the train' && S.get(key).origTitle === 'Aeneid');
  S.rename(key, '');
  ok('an empty rename is the page\'s own title again', S.get(key).title === 'Aeneid' && !S.get(key).origTitle);

  const trip = S.createList('Portugal trip');
  const later = S.createList('Later');
  ok('createList gives an id; lists come in the order made', /^l_/.test(trip) && J(S.lists().map((l) => l.name)) === J(['', 'Portugal trip', 'Later']));
  ok('a list needs a name', S.createList('   ') === '');
  d.clock += 1;
  S.addToList({ kind: 'article', zim: 'wikivoyage', path: 'A/Lisbon', title: 'Lisbon' }, trip);
  d.clock += 1;
  S.addToList({ kind: 'place', zim: 'osm', path: 'index.html', title: 'Hotel', where: { pos: 'map=15.00/38.71000/-9.13000' } }, trip);
  d.clock += 1;
  S.addToList({ kind: 'video', zim: 'ted', path: 'v/lisbon', title: 'A talk' }, trip);
  S.addToList(key, trip);
  S.addToList(key, S.LIKED);
  S.addToList(key, later);
  ok('an item given whole is saved as it goes into a list', S.has('wikivoyage\nA/Lisbon') && S.has('osm\nindex.html\nmap=15.00/38.71000/-9.13000'));
  ok('one item in many lists, Liked first', J(S.get(key).lists) === J(['liked', trip, later]) && S.inList(key, S.LIKED) && S.inList(key, later));
  ok('a list keeps the order things went in', J(S.itemsFor({ list: trip }).map((i) => i.title)) === J(['Lisbon', 'Hotel', 'A talk', 'Aeneid']));
  S.addToList(key, trip, 'wikivoyage\nA/Lisbon');
  ok('addToList with a place moves it there', J(S.itemsFor({ list: trip }).map((i) => i.title)) === J(['Aeneid', 'Lisbon', 'Hotel', 'A talk']));
  ok('an app sees its own slice', J(S.itemsFor({ app: 'books' }).map((i) => i.key)) === J([key]) && S.itemsFor({ app: 'maps' })[0].kind === 'place' && S.itemsFor({ kind: 'video' }).length === 1);
  ok('lists count what the slice holds', J(S.lists({ app: 'books' }).map((l) => l.count)) === J([1, 1, 1]) && S.lists({ app: 'tube' })[1].count === 1 && S.lists()[1].count === 4);
  S.removeFromList(key, later);
  ok('removeFromList: out of that list, still saved and in the others', !S.inList(key, later) && S.has(key) && S.inList(key, trip));
  S.moveList(later, trip);
  ok('moveList: before another list', J(S.lists().map((l) => l.name)) === J(['', 'Later', 'Portugal trip']));
  S.moveList(later, null);
  ok('and to the end', J(S.lists().map((l) => l.name)) === J(['', 'Portugal trip', 'Later']));
  S.deleteList(trip);
  ok('deleteList: the list goes, its items stay saved', S.lists().length === 2 && S.has('wikivoyage\nA/Lisbon') && J(S.get(key).lists) === J(['liked']));
  ok('Liked cannot be deleted or renamed', (S.deleteList(S.LIKED), S.renameList(S.LIKED, 'x'), S.lists()[0].id === 'liked' && S.lists()[0].name === ''));
  ok('items in no list, the latest first', J(S.itemsFor({ list: '' }).map((i) => i.title)) === J(['A talk', 'Hotel', 'Lisbon']));
  S.remove(key);
  ok('remove: gone from every list', !S.has(key) && S.itemsFor({ list: S.LIKED }).length === 0);

  // Where you were: kept whether or not the thing is saved.
  S.setPosition(book, { f: 0.25, c: 4000 });
  ok('a position, with its kind, app and meta', S.position(key).where.c === 4000 && S.position(key).app === 'books' && S.position(key).meta.author === 'Virgil');
  S.setPosition({ zim: 'gutenberg_la', path: 'Aeneidos.227', kind: 'book' }, null);
  ok('where null notes the visit and keeps the place', S.position(key).where.c === 4000 && S.position(key).meta.id === 227);
  d.clock += 5;
  S.setPosition({ kind: 'video', zim: 'ted', path: 'v/lisbon', title: 'A talk' }, { t: 312.5, d: 900 });
  ok('continued: the latest first, and by app', S.continued()[0].kind === 'video' && S.continued({ app: 'books' }).length === 1 && S.continued({ app: 'tube' })[0].where.t === 312.5);
  S.clearPosition(key);
  ok('clearPosition', S.position(key) === null && S.continued().length === 1);
  ok('a nonsense save saves nothing', S.save({ zim: '', path: 'x' }) === '' && S.save(null) === '');
}

// ── ordering never runs out of room ─────────────────────────────────────────
{
  const d = device();
  const S = d.Saved;
  const l = S.createList('Crowded');
  ['a', 'b'].forEach((p) => S.addToList({ zim: 'w', path: p, title: p }, l));
  // Keep inserting between the first two: the gap halves every time.
  for (let i = 0; i < 80; i++) S.addToList({ zim: 'w', path: 'n' + i, title: 'n' + i }, l, 'w\nb');
  const order = S.itemsFor({ list: l }).map((i) => i.path);
  ok('eighty inserts in the same gap keep their order', order[0] === 'a' && order[order.length - 1] === 'b' && order.slice(1, -1).every((p, i) => p === 'n' + i), order.slice(0, 4).join(','));
}

// ── two devices ─────────────────────────────────────────────────────────────
{
  const phone = device({}, { clock: 1000 }), tablet = device({}, { clock: 1000 });
  const X = { zim: 'w', path: 'A/X', title: 'X' }, Y = { zim: 'w', path: 'A/Y', title: 'Y' };
  const trip = phone.Saved.createList('Trip');
  phone.Saved.addToList(X, trip);
  phone.Saved.addToList(Y, trip);
  phone.Saved.addToList(X, phone.Saved.LIKED);
  tablet.Saved.merge(phone.Saved.data(), { fromSync: true });
  ok('the tablet has what the phone saved', tablet.Saved.all().length === 2 && tablet.Saved.inList(X, trip));
  ok('a merge from the account is announced as the account\'s', tablet.changes[tablet.changes.length - 1] === true);
  phone.clock = 2000;
  phone.Saved.remove(X);
  phone.Saved.removeFromList(Y, trip);
  tablet.clock = 2100;
  tablet.Saved.save({ zim: 'w', path: 'A/Z', title: 'Z' });
  // The tablet has not heard of the deletes; the phone merges the tablet's copy.
  phone.Saved.merge(tablet.Saved.data());
  ok('a delete on the phone survives a merge from the tablet', !phone.Saved.has(X) && !phone.Saved.inList(Y, trip) && phone.Saved.has(Y) && phone.Saved.has({ zim: 'w', path: 'A/Z' }));
  tablet.Saved.merge(phone.Saved.data());
  ok('and reaches the tablet', !tablet.Saved.has(X) && !tablet.Saved.inList(Y, trip) && tablet.Saved.itemsFor({ list: tablet.Saved.LIKED }).length === 0);
  phone.clock = 3000;
  phone.Saved.deleteList(trip);
  tablet.clock = 3100;
  tablet.Saved.addToList({ zim: 'w', path: 'A/Z' }, trip);
  tablet.Saved.merge(phone.Saved.data());
  ok('a deleted list stays deleted, even with something added to it elsewhere', tablet.Saved.lists().length === 1 && tablet.Saved.has({ zim: 'w', path: 'A/Z' }));
  ok('both end the same', J(phone.Saved.merge(tablet.Saved.data()) && phone.Saved.all().map((i) => i.key)) === J(tablet.Saved.all().map((i) => i.key)));
  const ow = tablet.Saved.merge({ items: {} }, { overwrite: true });
  ok('overwrite takes the incoming store whole', ow.changed && tablet.Saved.all().length === 0);
}

// ── highlights: kept beside the items, merged and deleted the same way ──────
{
  const d = device({}, { clock: 5000 }), S = d.Saved;
  const page = { zim: 'w', path: 'A/Fox' };
  const a = S.highlight(Object.assign({ kind: 'article', title: 'Fox', exact: 'the lazy dog', prefix: 'overthe', suffix: 'andthen', pos: 0.6, color: 'green' }, page));
  d.clock += 1;
  const b = S.highlight(Object.assign({ kind: 'article', title: 'Fox', exact: 'The quick brown fox', prefix: '', suffix: 'jumps', pos: 0.1 }, page));
  d.clock += 1;
  S.highlight({ zim: 'b', path: 'Book.1', kind: 'book', app: 'books', title: 'Book', exact: 'Call me Ishmael.', pos: 0 });
  ok('a highlight gets an id; the default colour is the first', /^h_/.test(a) && S.getHighlight(b).color === 'yellow' && S.getHighlight(a).color === 'green');
  ok('a page\'s highlights, in the order of its text', J(S.highlights(page).map((h) => h.id)) === J([b, a]) && J(S.highlights('w\nA/Fox').map((h) => h.id)) === J([b, a]));
  ok('an app\'s, and everything, the latest first', S.highlights({ app: 'books' }).length === 1 && S.highlights().length === 3 && S.highlights()[0].app === 'books');
  ok('a highlight is not a saved item: the page is saved only when asked', !S.has(page) && S.all().length === 0);
  S.highlight({ id: a, note: '  a dog that is lazy  ' });
  ok('a note is set on its own, trimmed; the rest stays', S.getHighlight(a).note === 'a dog that is lazy' && S.getHighlight(a).exact === 'the lazy dog' && S.getHighlight(a).color === 'green');
  S.highlight({ id: a, note: '' });
  ok('an empty note takes the note away', !('note' in S.getHighlight(a)));
  ok('nothing to quote is no highlight', S.highlight({ zim: 'w', path: 'A/Fox', exact: '' }) === '' && S.highlight(null) === '');
  const hb = S.getHighlight(b);
  S.removeHighlight(b);
  ok('removeHighlight leaves a tombstone, after the highlight it deletes', S.getHighlight(b) === null && S.data().gone['h:' + b] > hb.ts && S.highlights(page).length === 1);
}
{
  const phone = device({}, { clock: 1000 }), tablet = device({}, { clock: 1000 });
  const P = { zim: 'w', path: 'A/Fox', kind: 'article', title: 'Fox' };
  const h1 = phone.Saved.highlight(Object.assign({ exact: 'quick brown fox', pos: 0.1 }, P));
  const h2 = phone.Saved.highlight(Object.assign({ exact: 'lazy dog', pos: 0.6 }, P));
  tablet.Saved.merge(phone.Saved.data(), { fromSync: true });
  ok('the tablet has the phone\'s highlights', tablet.Saved.highlights(P).length === 2);
  phone.clock = 2000;
  phone.Saved.removeHighlight(h1);
  tablet.clock = 2100;
  tablet.Saved.highlight({ id: h2, note: 'written on the tablet' });
  phone.Saved.merge(tablet.Saved.data());
  ok('a highlight deleted on the phone stays deleted after the tablet\'s copy comes in', phone.Saved.getHighlight(h1) === null);
  ok('and the note written on the tablet arrives', phone.Saved.getHighlight(h2).note === 'written on the tablet');
  tablet.Saved.merge(phone.Saved.data());
  ok('both end the same', J(tablet.Saved.highlights(P)) === J(phone.Saved.highlights(P)) && tablet.Saved.highlights(P).length === 1);
}

// ── whose store: signed out, or an account's own ────────────────────────────
{
  const d = device(LEGACY);
  d.Saved.save({ zim: 'w', path: 'A/Mine', title: 'Mine (signed out)' });
  ok('the signed-out store takes in what the browser kept before', d.Saved.all().length === 11 && !d.Saved.legacyOffered());
  ok('use(name) switches store', d.Saved.use('Alice') === true && d.Saved.account() === 'alice');
  ok('an account\'s first store in this browser starts empty: a shared screen\'s old bookmarks are not every account\'s',
    d.Saved.all().length === 0 && d.Saved.lists().length === 1 && d.Saved.continued().length === 0);
  ok('...they are offered to it instead', d.Saved.legacyOffered() === true);
  d.Saved.legacyAnswer(true);
  ok('asked for, they come in, and are not offered again', d.Saved.all().length === 10 && d.Saved.continued().length === 2 && !d.Saved.legacyOffered());
  d.Saved.save({ zim: 'w', path: 'A/Hers', title: 'Hers' });
  ok('kept under its own key', !!d.localStorage.getItem('zimi_saved:alice') && d.localStorage.getItem('zimi_saved').indexOf('A/Hers') < 0);
  d.Saved.use('bob');
  ok('another account is asked for itself', d.Saved.legacyOffered() === true);
  d.Saved.legacyAnswer(false);
  ok('turned down, nothing comes in and it is not asked again', d.Saved.all().length === 0 && !d.Saved.legacyOffered());
  const again = device(Object.assign({}, d.localStorage._all));
  again.Saved.use('bob');
  ok('...in the next visit either', !again.Saved.legacyOffered() && again.Saved.all().length === 0);
  d.Saved.use('');
  ok('signed out again: the signed-out store, without the accounts\'', d.Saved.has('w\nA/Mine') && !d.Saved.has('w\nA/Hers'));
  d.Saved.use('alice');
  d.Saved.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.5, c: 50 });
  d.Saved.forget();
  ok('signing out takes the account\'s copy (and its places) out of the browser', d.localStorage.getItem('zimi_saved:alice') === null &&
    d.localStorage.getItem('zimi_saved_pos:alice') === null && d.localStorage.getItem('zimi_saved') !== null);
  d.Saved.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.6, c: 60 });
  d.Saved.save({ zim: 'w', path: 'A/Late', title: 'written as the page closes' });
  ok('...and nothing written after puts it back', !Object.keys(d.localStorage._all).some((k) => /:alice$/.test(k)) && d.Saved.account() === '');
}

// ── where you were: a key of its own ────────────────────────────────────────
{
  const d = device();
  const S = d.Saved;
  S.save({ zim: 'w', path: 'A/X', title: 'X' });
  const main = d.localStorage.getItem('zimi_saved');
  S.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.1, c: 10 });
  S.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.2, c: 20 });
  ok('a place moving writes its own key, not the whole store again', d.localStorage.getItem('zimi_saved') === main &&
    JSON.parse(d.localStorage.getItem('zimi_saved_pos')).positions['g\nB.1'].where.c === 20);
  S.clearPosition({ zim: 'g', path: 'B.1' });
  const back = device(Object.assign({}, d.localStorage._all));
  ok('the next visit reads both, the place\'s tombstone with it', back.Saved.has('w\nA/X') && back.Saved.position({ zim: 'g', path: 'B.1' }) === null &&
    back.Saved.data().gone['p:g\nB.1'] > 0);
  // A store written before places had a key of their own.
  const old = full({ items: { 'w\nA/Y': { kind: 'article', zim: 'w', path: 'A/Y', title: 'Y', added: 5, ts: 5 } },
    positions: { 'g\nB.2': { kind: 'book', zim: 'g', path: 'B.2', title: 'B2', app: 'books', ts: 6, where: { f: 0.3, c: 30 } } } });
  const moved = device({ zimi_saved: J(old) });
  ok('a store from before keeps its places, moved to their key', moved.Saved.position({ zim: 'g', path: 'B.2' }).where.c === 30 &&
    !('positions' in JSON.parse(moved.localStorage.getItem('zimi_saved'))) && !!JSON.parse(moved.localStorage.getItem('zimi_saved_pos')).positions['g\nB.2']);
  moved.Saved.save({ zim: 'w', path: 'A/Z', title: 'Z' });
  ok('...and a save after does not lose them', device(Object.assign({}, moved.localStorage._all)).Saved.position({ zim: 'g', path: 'B.2' }).where.c === 30);
}

// ── each app keeps its own places ───────────────────────────────────────────
{
  const d = device(), S = d.Saved;
  S.setPosition({ kind: 'book', app: 'books', zim: 'g', path: 'B.1', title: 'A book' }, { f: 0.4, c: 400 });
  for (let i = 0; i < 320; i++) { d.clock += 1; S.setPosition({ kind: 'article', app: 'wiki', zim: 'w', path: 'A/' + i, title: String(i) }, { s: 'h', f: 0.5 }); }
  ok('Zimipedia\'s articles never push a book out of Continue', S.continued({ app: 'books' }).length === 1 && S.continued({ app: 'wiki' }).length === 300 &&
    !S.position({ zim: 'w', path: 'A/0' }) && !!S.position({ zim: 'w', path: 'A/319' }));
}

// ── nothing saved is dropped: past a limit, a new one is refused ───────────
{
  const d = device(), S = d.Saved;
  S._max.items = 3;
  ['a', 'b', 'c'].forEach((p) => S.save({ zim: 'w', path: p, title: p }));
  ok('at the limit a new save is refused and said', S.save({ zim: 'w', path: 'd', title: 'd' }) === '' && !S.has('w\nd') && d.full === 1 && S.all().length === 3);
  ok('...never an old one dropped to make room', ['a', 'b', 'c'].every((p) => S.has('w\n' + p)));
  ok('what is kept still changes', S.save({ zim: 'w', path: 'a', title: 'A again' }) === 'w\na' && S.get('w\na').title === 'A again');
  S.remove('w\nb');
  ok('let one go, and there is room', S.save({ zim: 'w', path: 'd', title: 'd' }) === 'w\nd');
  const big = device(), B = big.Saved;
  B._max.bytes = 2000;
  let n = 0;
  while (B.save({ zim: 'w', path: 'p' + n, title: 'Ω'.repeat(200) })) n++;
  ok('the byte budget, counted as the account\'s file holds it (UTF-8), refuses the next save', n > 0 && n < 10 && big.full === 1 && B.all().length === n);
  ok('...a highlight, a list and a place in a list too', B.highlight({ zim: 'w', path: 'p0', exact: 'x' }) === '' && B.createList('More') === '' &&
    (B.addToList('w\np0', B.LIKED), !B.inList('w\np0', B.LIKED)));
  B.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.1, c: 1 });
  ok('...while where you were is still kept (it trims itself)', !!B.position({ zim: 'g', path: 'B.1' }));
}

// ── a slow clock never undoes a delete ──────────────────────────────────────
{
  const fast = device({}, { clock: 5000000 }), slow = device({}, { clock: 1000 });
  fast.Saved.save({ zim: 'w', path: 'A/X', title: 'X' });
  slow.Saved.merge(fast.Saved.data(), { fromSync: true });
  slow.Saved.remove('w\nA/X');
  ok('a delete on a device whose clock is behind is dated after what it deletes', slow.Saved.data().gone['i:w\nA/X'] > 5000000);
  fast.Saved.merge(slow.Saved.data());
  ok('...so it holds on the device that saved it', !fast.Saved.has('w\nA/X'));
  const later = device({}, { clock: 1000 });
  later.Saved.merge({ items: { 'w\nA/Y': { kind: 'article', zim: 'w', path: 'A/Y', title: 'Y', added: 9000, ts: 9000 } } });
  ok('what a store has seen sets its clock, from a merge too', later.Saved.save({ zim: 'w', path: 'A/Z', title: 'Z' }) && later.Saved.get('w\nA/Z').ts > 9000);
}

// ── overwrite, with other devices in it ─────────────────────────────────────
{
  const phone = device({}, { clock: 1000 });
  const X = { zim: 'w', path: 'A/X', title: 'X' }, Y = { zim: 'w', path: 'A/Y', title: 'Y' };
  phone.Saved.save(X); phone.Saved.save(Y);
  phone.Saved.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.5, c: 5 });
  const account = phone.Saved.data();  // what the account holds
  phone.clock = 2000;
  const file = { items: { 'w\nA/Z': { kind: 'article', zim: 'w', path: 'A/Z', title: 'Z from a file', added: 10, ts: 10 } } };
  phone.Saved.merge(file, { overwrite: true });
  ok('overwrite takes the file whole', phone.Saved.all().map((i) => i.key).join() === 'w\nA/Z' && !phone.Saved.position({ zim: 'g', path: 'B.1' }));
  const merged = device().Saved._merge(phone.Saved._clean(account), phone.Saved._clean(phone.Saved.data()), 3000);
  ok('...and it holds when the account merges it: what it replaced does not come back, what it brought outranks the account\'s copy',
    Object.keys(merged.items).join() === 'w\nA/Z' && !merged.positions['g\nB.1'] && merged.gone['i:w\nA/X'] > account.items['w\nA/X'].ts);
  const legacy = device({}, { clock: 1000 });
  legacy.Saved.save(X);
  legacy.Saved.mergeLegacy({ bookmarks: [{ zim: 'w', path: 'A/Old', title: 'Old', timestamp: 5 }] }, { overwrite: true });
  ok('a file from before 1.12 overwrites as well', legacy.Saved.all().map((i) => i.key).join() === 'w\nA/Old');
}

// ── what goes up: only what the account has not had ────────────────────────
{
  const d = device(), S = d.Saved;
  S.save({ zim: 'w', path: 'A/X', title: 'X' });
  S.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.1, c: 1 });
  const answered = S.stamps(S.data());
  d.clock += 10;
  S.remove('w\nA/X');
  S.setPosition({ kind: 'book', zim: 'g', path: 'B.1', title: 'B' }, { f: 0.2, c: 2 });
  const delta = S.since(answered);
  ok('the changes since the account answered, and nothing else', Object.keys(delta.items).length === 0 && Object.keys(delta.positions).join() === 'g\nB.1' &&
    Object.keys(delta.gone).join() === 'i:w\nA/X');
  ok('with no answer yet, everything', Object.keys(S.since(null).positions).length === 1 && Object.keys(S.since(null).gone).length === 1);
}

// ── storage that throws (a private window, a full disk) ─────────────────────
{
  const d = device();
  d.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  d.localStorage.getItem = () => { throw new Error('SecurityError'); };
  let threw = false;
  try { d.Saved.save({ zim: 'w', path: 'A/X', title: 'X' }); } catch (e) { threw = true; }
  ok('storage that throws is not an error: the store lives in memory', !threw && d.Saved.has('w\nA/X'));
  ok('...and the shell is told, to say so', d.storageFull > 0);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall saved-store checks passed');
process.exit(failures ? 1 : 0);
