// Read aloud's chunks: a voice says nothing until a whole chunk is made, so
// the first is short (the reading starts sooner) and the rest are full size.
//
// Run: node tests/test_tts_chunks.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

// Read aloud's reading is readaloud.js (fetched on first use), the rest app.js;
// readaloud.js first, so its functions are found before app.js's stand-ins.
const src = ['readaloud.js', 'app.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', f), 'utf8')).join('\n').replace(/\r\n/g, '\n'); // a Windows checkout's line ends
const pick = (re, name) => { const m = src.match(re); if (!m) throw new Error('not found: ' + name); return m[0]; };
eval(pick(/var _TTS_BLOCK = [^\n]*/, '_TTS_BLOCK'));
const _langPrimary = (l) => String(l || '').split(/[-_]/)[0].toLowerCase();
eval(pick(/var _TTS_ABBREVS[\s\S]*?\nfunction _ttsSentenceSpans[\s\S]*?\n}\n/, 'the sentence splitter'));
for (const name of ['_ttsPlanChunks', '_ttsChunkText']) {
  eval(pick(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'), name));
}
eval(pick(/var _TTS_CHUNK_MAX = [^\n]*/, '_TTS_CHUNK_MAX'));
eval(pick(/var _TTS_SMALL_WORDS = [^\n]*/, '_TTS_SMALL_WORDS'));
eval(pick(/var _TTS_UNITS = [^\n]*/, '_TTS_UNITS'));
eval(pick(/function _ttsSpoken\([\s\S]*?\n}/, '_ttsSpoken'));

let failures = 0;
function ok(label, cond, got) { console.log((cond ? '  ok: ' : '  FAIL: ') + label + (cond ? '' : '  ' + JSON.stringify(got))); if (!cond) failures++; }

const text = 'The Family Man is a 2000 American romantic fantasy comedy-drama film directed by Brett Ratner. It stars Nicolas Cage and Tea Leoni. '.repeat(4);
const c = _ttsChunkText(text, _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX);
ok('the first chunk is short', c[0].length <= _TTS_FIRST_CHUNK_MAX, c.map((x) => x.length));
ok('and ends where its sentence does', /\.$/.test(c[0]), c[0]);
ok('the rest are packed up to the full size', c.slice(1, -1).every((x) => x.length > _TTS_FIRST_CHUNK_MAX && x.length <= _TTS_CHUNK_MAX), c.map((x) => x.length));
ok('nothing is lost or repeated', c.join(' ') === text.replace(/\s+/g, ' ').trim());
const sectioned = 'His papacy was marked by reconciliation.' + _TTS_BLOCK + 'Early life' + _TTS_BLOCK + 'John was born in Antioch. He was named legate.';
ok('a chunk ends with its block: a heading is said alone, with its own stop', JSON.stringify(_ttsChunkText(sectioned, _TTS_CHUNK_MAX)) === JSON.stringify(['His papacy was marked by reconciliation.', 'Early life.', 'John was born in Antioch. He was named legate.']), _ttsChunkText(sectioned, _TTS_CHUNK_MAX));
ok('without a first cap every chunk is full size', _ttsChunkText(text, _TTS_CHUNK_MAX)[0].length > _TTS_FIRST_CHUNK_MAX);

// Sentences as people read them (Eric, 2026-10-20: "Dr. Smith isn't two
// sentences ... there's probably conventions"): the platform's sentence rules,
// then a cut after an abbreviation joined back.
const said = (t, lang) => _ttsSentenceSpans(t, 0, t.length, lang || 'en').map(([a, b]) => t.slice(a, b));
const tricky = 'Is that so? It is. Dr. Smith, who wrote it in 1801, was sure. The U.S. Army left at 5 p.m. on Jan. 3. ' +
  'J. R. R. Tolkien wrote it, e.g. in 1937. It cost $3.50 vs. $4. Mt. Everest is 8,849 m high. He said "Stop." Then he left... ' +
  'And so on! See Fig. 2 and No. 5. It was the end of the st. lawrence trip.';
const got = said(tricky);
const want = ['Is that so?', 'It is.', 'Dr. Smith, who wrote it in 1801, was sure.', 'The U.S. Army left at 5 p.m. on Jan. 3.',
  'J. R. R. Tolkien wrote it, e.g. in 1937.', 'It cost $3.50 vs. $4.', 'Mt. Everest is 8,849 m high.', 'He said "Stop."', 'Then he left...',
  'And so on!', 'See Fig. 2 and No. 5.', 'It was the end of the st. lawrence trip.'];
ok('titles, initials, dotted and listed abbreviations, a date and a decimal stay in their sentence', JSON.stringify(got) === JSON.stringify(want), got);
ok('"?", "!", "..." and a closing quote still end one', said('Why? Because! Wait... "Go." Now.').length === 5, said('Why? Because! Wait... "Go." Now.'));
ok('"I." ends an English sentence, not an initial', said('So did I. Then we left.').length === 2, said('So did I. Then we left.'));
ok('a German abbreviation is known in German', said('Das ist z.B. gut. Nr. 5 ist da.', 'de').length === 2, said('Das ist z.B. gut. Nr. 5 ist da.', 'de'));
ok('Hindi and Arabic sentence marks cut', said('यह एक है। यह दो है।', 'hi').length === 2 && said('ما هذا؟ هذا كتاب.', 'ar').length === 2,
  [said('यह एक है। यह दो है।', 'hi'), said('ما هذا؟ هذا كتاب.', 'ar')]);
ok('a spoken chunk never ends at "Dr."', _ttsChunkText('It is. Dr. Smith was sure. '.repeat(12), _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX, 'en').every((x) => !/\bDr\.$/.test(x)));

// A first sentence longer than the first chunk's cap, but one chunk's worth,
// is said whole: the cap keeps a second sentence out, it never cuts one.
const longFirst = 'A widely reported anecdote about this eclipse, one of the earliest recorded in history, found in the Book of Documents, involves two Chinese court astronomers, named Hsi and Ho. They failed.';
const lf = _ttsChunkText(longFirst, _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX, 'en');
ok('a long first sentence is not cut at the first cap', lf[0].endsWith('named Hsi and Ho.') && lf[1] === 'They failed.', lf);

// What a voice is given: capitals are words, "::" a pause, units said out (the World Factbook).
const spoken = (t) => _ttsChunkText(t, _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX, 'en');
ok('an all-capitals heading is read as words, not letters', JSON.stringify(spoken('THE WORLD FACTBOOK ARCHIVE')) === JSON.stringify(['the world factbook archive.']), spoken('THE WORLD FACTBOOK ARCHIVE'));
ok('...an acronym in a sentence, a short one alone, and a mixed word are left', spoken('The FBI and NASA agree.')[0] === 'The FBI and NASA agree.' && spoken('FBI')[0] === 'FBI.' && spoken('FAQs')[0] === 'FAQs.', [spoken('The FBI and NASA agree.'), spoken('FBI'), spoken('FAQs')]);
ok('"::" is a pause, not two colons', spoken('Africa\n :: Mali')[0] === 'Africa, Mali.', spoken('Africa\n :: Mali'));
ok('a line break in the source is a space, not a sentence end', spoken('Africa\nMali')[0] === 'Africa Mali.', spoken('Africa\nMali'));
ok('English units are said out; other languages are left', spoken('Area: 1,240,192 sq km and 7 km.')[0] === 'Area: 1,240,192 square kilometers and 7 kilometers.' &&
  _ttsChunkText('Fläche: 7 km.', _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX, 'de')[0] === 'Fläche: 7 km.', spoken('Area: 1,240,192 sq km and 7 km.'));

ok('a sentence with nothing to say (an anchor\'s zero-width space) is not a chunk', JSON.stringify(spoken('One.' + _TTS_BLOCK + '\u200b \u200b' + _TTS_BLOCK + 'Two.')) === JSON.stringify(['One.', 'Two.']), spoken('One.' + _TTS_BLOCK + '\u200b \u200b' + _TTS_BLOCK + 'Two.'));

ok('a dash left hanging at the end (a comment\'s \u201c\u2013 author\u201d) is dropped', spoken('Is it so? \u2013')[0] === 'Is it so?', spoken('Is it so? \u2013'));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('\nall chunk checks passed');
