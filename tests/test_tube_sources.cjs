// ZimiTube's cards and player for what is not a video ZIM's video: a
// document library's video (no picture), an audiobook (sound, in tracks), a
// folder's song. The card functions run from tube.html itself.
//
// Run: node tests/test_tube_sources.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'tube.html'), 'utf8').replace(/\r\n/g, '\n');
const shared = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'apps.js'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(text, re, label) {
  const m = text.match(re);
  if (!m) throw new Error('could not extract ' + label);
  return m[0];
}

const ctx = { STR: { track: 'track', tracks: 'tracks' } };
vm.createContext(ctx);
vm.runInContext([
  extract(shared, /function esc\(x\) \{[^\n]*\n/, 'esc'),
  extract(shared, /function zpath\(zim, p\) \{[^\n]*\n/, 'zpath'),
  extract(shared, /function count\(n, one, many\) \{[^\n]*\n/, 'count'),
  extract(shared, /function zimIcon\(zim, cls\) \{[^\n]*\n/, 'zimIcon'),
  extract(page, /function iconHtml\(v, cls\) \{[^\n]*\n/, 'iconHtml'),
  extract(page, /function secs\(d\) \{[^\n]*\n/, 'secs'),
  extract(page, /function fmtDur\(d\) \{[^\n]*\n/, 'fmtDur'),
  extract(page, /var _HEADPHONES_SVG = [^\n]*\n/, '_HEADPHONES_SVG'),
  extract(page, /var _FILM_SVG = [^\n]*\n/, '_FILM_SVG'),
  extract(page, /function thumbInner\(v\) \{[\s\S]*?\n\}/, 'thumbInner'),
  extract(page, /function badge\(v\) \{[^\n]*\n/, 'badge'),
  extract(page, /function card\(v, i\) \{[\s\S]*?\n\}/, 'card'),
].join('\n'), ctx);

const book = { zim: 'youscribe_fr_audiobooks', zim_title: 'Audiolivres', zim_icon: true, title: 'Le Chien des Baskerville', speaker: 'Arthur Conan Doyle',
  page: 'files/2909454_Doyle___Le_chien_des_Baskerville_01_a_03.ogg', thumb: '', audio: true, tracks: 8 };
const lesson = { zim: 'maitre_lucas_compter_jusque_10_fr', zim_title: 'Compter', title: 'Nombres en lettres', speaker: 'Maître Lucas',
  page: 'files/nombres.mp4', thumb: '', audio: false, duration: null };
const talk = { zim: 'ted', zim_title: 'TED', title: 'A talk', page: 'talk', thumb: 'videos/1/thumbnail.webp', duration: 391 };

const b = ctx.card(book, 0), l = ctx.card(lesson, 1), t = ctx.card(talk, 2);
ok('an audiobook is an audio card', /class="card audio"/.test(b));
const thumbOf = (html) => html.split('<span class="body">')[0];
ok('with headphones where a picture would be', b.indexOf(ctx._HEADPHONES_SVG) > 0 && thumbOf(b).indexOf('<img') < 0);
ok('and its tracks where a video\'s length goes', /<span class="dur">8 tracks<\/span>/.test(b));
ok('a single track says nothing there', !/class="dur"/.test(ctx.card(Object.assign({}, book, { tracks: undefined }), 0)));
ok('a video with no picture shows a still, not an empty grey box', l.indexOf(ctx._FILM_SVG) > 0 && /class="card"/.test(l) && thumbOf(l).indexOf('<img') < 0);
ok('a picture sits over the still, so one that fails to load leaves the still', /<span class="still">[\s\S]*<\/span><img src="\/w\/ted\/videos\/1\/thumbnail\.webp"[^>]*onerror="this\.remove\(\)"/.test(t));
ok('a video keeps its length', /<span class="dur">6:31<\/span>/.test(t));
ok('the card is still the link to the file and plays in ZimiTube', /href="\/w\/youscribe_fr_audiobooks\/files\/2909454_Doyle___Le_chien_des_Baskerville_01_a_03\.ogg"/.test(b) && /onclick="return play\(event, 0\)"/.test(b));

// ── the player ─────────────────────────────────────────────────────────────
const playAudio = extract(page, /function playAudio\(v, m, stage, i, noMedia\) \{[\s\S]*?\n\}/, 'playAudio');
ok('sound plays in an audio player, not on a black video stage', /if \(m\.audio && playAudio\(v, m, stage, i, noMedia\)\) return;/.test(page) && /document\.createElement\('audio'\)/.test(playAudio) && /stage\.classList\.add\('audio'\)/.test(playAudio));
ok('a file this browser cannot play goes to the ZIM\'s decoder when it ships one', /if \(type && aud\.canPlayType\(type\) === '' && m\.ogv\) return false;/.test(playAudio));
ok('the tracks are listed, the one playing marked, and a tap plays one', /count\(tracks\.length, STR\.track, STR\.tracks\)/.test(playAudio) && /classList\.toggle\('on', \+b\.dataset\.n === n\)/.test(playAudio) && /list\.onclick = function\(e\)/.test(playAudio));
ok('the end of a track plays the next, docked too; the end of the last goes on to the next item', /if \(_now !== i && _docked !== i\) return;\s*if \(at \+ 1 < tracks\.length\) go\(at \+ 1\);\s*else if \(_autoplay && _now === i && _list\[i \+ 1\]\) play\(null, i \+ 1\);/.test(playAudio));
ok('a new item clears the last one\'s tracks and audio stage', /document\.getElementById\('w-tracks'\)\.innerHTML = '';/.test(page) && /stage\.classList\.remove\('audio'\); _video = null;/.test(page));
ok('the stage says it cannot play on the dark stage, not the audio one', /var noMedia = function\(missing\) \{ stage\.classList\.remove\('audio'\);/.test(page));
ok('the ZimiTube tile and its languages count the ZIMs that feed it, not only video ZIMs', /function _installedVideoZims\(\) \{\n  return _installedFor\('video', 'tube'\);\n\}/.test(src));
ok('the shell hands the page its words for tracks', /'tube_track', 'tube_tracks'/.test(src) && /track: 'track', tracks: 'tracks'/.test(page));

for (const lang of ['en', 'de', 'es', 'fr', 'pt', 'ru', 'ar', 'he', 'hi', 'zh']) {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', lang + '.json'), 'utf8'));
  ok(lang + ' names a track and tracks', !!(s.tube_track && s.tube_tracks) && !/—/.test(s.tube_track + s.tube_tracks));
}

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
