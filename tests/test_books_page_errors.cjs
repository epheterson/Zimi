// Bookshelf when the server does not answer: the page itself (apps.js and
// books.html's script, as shipped) run against a stand-in DOM and a fetch
// that fails on cue. A shelf that could not be read is not an empty shelf,
// a list that failed is not a list still loading, and the look for the
// book records keeps going after one failure.
//
// Run: node tests/test_books_page_errors.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const page = fs.readFileSync(path.join(root, 'books.html'), 'utf8').replace(/\r\n/g, '\n');
const apps = fs.readFileSync(path.join(root, 'apps.js'), 'utf8');
const script = page.match(/<!--@apps\.js@-->\n<script>\n([\s\S]*?)<\/script>/);
if (!script) throw new Error('could not find the page\'s script');

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

function el() { return { innerHTML: '', textContent: '', hidden: false }; }
const els = {};
const timers = [];
let answer = () => ({ ok: false, status: 500 });
const asked = [];
const ctx = {
  console, JSON, Math, Date, Intl, String, Number, Object, Array, Promise, encodeURIComponent, decodeURIComponent,
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { hash: '', origin: 'http://zimi.test' },
  document: {
    getElementById: id => (els[id] = els[id] || el()),
    addEventListener: () => {},
    documentElement: {}
  },
  addEventListener: () => {},
  scrollTo: () => {},
  postMessage: () => {},
  requestAnimationFrame: () => {},
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  fetch: url => {
    asked.push(url);
    const a = answer(url);
    if (a === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: a.ok, status: a.status || 200, json: () => Promise.resolve(a.body) });
  }
};
ctx.window = ctx;
ctx.parent = ctx;
vm.createContext(ctx);

const flush = () => new Promise(r => setImmediate(r));
const view = () => els.view.innerHTML;
const HOME = { total: 2, details: false, languages: [], shelves: [{ code: 'PA', n: 2 }], eras: [],
  popular: [{ zim: 'g', id: 1, title: 'Aeneidos', path: 'Aeneidos.1' }], recent: [] };

(async () => {
  // The page loads its home as it opens: a server error.
  answer = () => ({ ok: false, status: 500 });
  vm.runInContext(apps + '\n' + script[1], ctx);
  await flush(); await flush();
  ok('a shelf that could not be read says so, not "No books installed yet"',
    view().includes(ctx.esc(ctx.STR.load_failed)) && !view().includes(ctx.esc(ctx.STR.empty)), view());
  ok('with a way to try again', view().includes('onclick="load()"') && view().includes('>' + ctx.STR.retry + '<'));

  // Too many at once, then no network: the same.
  answer = () => ({ ok: false, status: 429 });
  ctx.load(); await flush(); await flush();
  ok('too many requests is a failure too', view().includes(ctx.esc(ctx.STR.load_failed)));
  answer = () => 'offline';
  ctx.load(); await flush(); await flush();
  ok('and so is no network', view().includes(ctx.esc(ctx.STR.load_failed)));

  // A real empty library is still the empty page.
  answer = () => ({ ok: true, body: { total: 0 } });
  ctx.load(); await flush(); await flush();
  ok('a library with no books is still the empty shelf', view().includes(ctx.esc(ctx.STR.empty)) && !view().includes(ctx.esc(ctx.STR.load_failed)));

  // The records being read: the page looks again, and keeps looking past a failure.
  timers.length = 0;
  answer = () => ({ ok: true, body: HOME });
  ctx.load(); await flush(); await flush();
  ok('while the records are read the page looks again', timers.length === 1 && timers[0].ms === ctx.HOME_POLL_MS);
  answer = () => ({ ok: false, status: 503 });
  timers.shift().fn(); await flush(); await flush();
  ok('a failed look is looked again, later', timers.length === 1 && timers[0].ms === ctx.HOME_POLL_MS * 2, JSON.stringify(timers.map(t => t.ms)));
  for (let i = 0; i < 6; i++) { timers.shift().fn(); await flush(); await flush(); }
  ok('never less often than the most', timers.length === 1 && timers[0].ms === ctx.HOME_POLL_MAX_MS);
  answer = () => ({ ok: true, body: HOME });
  timers.shift().fn(); await flush(); await flush();
  ok('and at the usual pace once it answers', timers.length === 1 && timers[0].ms === ctx.HOME_POLL_MS);

  // A list that fails stops pulsing and says so.
  answer = url => (/\/books\/home/.test(url) ? { ok: true, body: HOME } : { ok: false, status: 500 });
  ctx.go({ v: 'list', sort: 'title' }); await flush(); await flush();
  ok('a list that failed is not a list still loading', !els.books.innerHTML.includes('class="sk"') &&
    els.books.innerHTML.includes(ctx.esc(ctx.STR.load_part)) && els.books.innerHTML.includes('moreClick()'), els.books.innerHTML);
  answer = () => ({ ok: true, body: { total: 1, books: [{ zim: 'g', id: 1, title: 'Aeneidos', path: 'Aeneidos.1' }] } });
  ctx.moreClick(); await flush(); await flush();
  ok('and Retry loads it', els.books.innerHTML.includes('Aeneidos') && !els.books.innerHTML.includes(ctx.esc(ctx.STR.load_part)));

  answer = () => ({ ok: false, status: 500 });
  ctx.tab('authors'); await flush(); await flush();
  ok('the writers that failed say so', els.authors.innerHTML.includes(ctx.esc(ctx.STR.load_part)) && els.authors.innerHTML.includes('moreAuthors(cur(), _seq)'));

  ctx.go({ v: 'book', id: 1, zim: 'g' }); await flush(); await flush();
  ok('a book that failed keeps what is known of it and says the rest failed',
    view().includes('Aeneidos') && view().includes(ctx.esc(ctx.STR.load_part)) && view().includes('onclick="show()"'), view());

  ok('the poll interval is named, not repeated', !/setTimeout\(refreshHome, \d/.test(page));
  ok('the places key is the apps\' shared one, not a literal of the page', !/zimi_book_places/.test(page) && /BOOK_PLACES_KEY/.test(page));

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall books-page error checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
