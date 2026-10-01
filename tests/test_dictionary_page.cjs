// Dictionary: the page's own logic, run from the page itself. Which voice
// says a word (never another language's), which region an accent is, the
// order of a word's languages, where a link lands, and the shell's surface
// (the tile, the address, the box, Back, Saved, Define's way in).
// Eric, 2026-10-01: "Can it speak the word!? Properly!?"
//
// Run: node tests/test_dictionary_page.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'zimi', 'static');
const page = fs.readFileSync(path.join(root, 'dictionary.html'), 'utf8').replace(/\r\n/g, '\n');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function eq(label, got, want) { ok(label, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got)); }

// ── the page's pure parts ───────────────────────────────────────────────
const pure = page.match(/\/\/ ── pure parts[\s\S]*?(?=\/\/ ── views)/);
if (!pure) throw new Error('could not find the pure parts');
const ctx = { Intl, Date, Math, JSON, String, Number, Object, STR: { lang: 'en', more: '{n} more' } };
vm.createContext(ctx);
vm.runInContext(pure[0], ctx);

// A Mac's voices, novelty ones among them, as getVoices() gives them.
const MAC = [
  { name: 'Bubbles', lang: 'en-US', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true, default: true },
  { name: 'Daniel', lang: 'en-GB', localService: true },
  { name: 'Karen', lang: 'en-AU', localService: true },
  { name: 'Thomas', lang: 'fr-FR', localService: true },
  { name: 'Amélie', lang: 'fr-CA', localService: true },
  { name: 'Tingting', lang: 'zh-CN', localService: true },
  { name: 'Sinji', lang: 'zh-HK', localService: true },
  { name: 'Carmit', lang: 'he-IL', localService: true },
  { name: 'Nora', lang: 'nb-NO', localService: true },
  { name: 'Google español', lang: 'es-ES', localService: false },
];
const voice = (code, accent, vs) => { const c = ctx.pickVoice(vs || MAC, code, accent); return c ? c.voice.name + (c.exact ? '!' : '') : null; };

eq('an English word is said by an English voice, never a novelty one', voice('en', ''), 'Samantha');
eq('Received Pronunciation is said by a British voice', voice('en', 'Received Pronunciation'), 'Daniel!');
eq('General American by an American one', voice('en', 'General American'), 'Samantha!');
eq('French Wiktionary\'s "Royaume-Uni" is Britain too', voice('en', 'Royaume-Uni (Londres)'), 'Daniel!');
eq('"General Australian, New Zealand" is Australia', voice('en', 'General Australian, New Zealand'), 'Karen!');
eq('a French word is said by a French voice', voice('fr', ''), 'Thomas');
eq('Québec French by the Canadian one', voice('fr', 'Québec'), 'Amélie!');
eq('a French word on a device with only English voices: no voice at all', voice('fr', '', MAC.filter(v => /^en/.test(v.lang))), null);
eq('Maltese, which the Mac does not speak: no voice, not an English one', voice('mt', ''), null);
eq('Mandarin (cmn) is said by the zh-CN voice', voice('cmn', ''), 'Tingting!');
eq('Cantonese (yue) by the Hong Kong voice', voice('yue', ''), 'Sinji!');
eq('Cantonese never by a Mandarin voice', voice('yue', '', MAC.filter(v => v.lang !== 'zh-HK')), null);
eq('Norwegian (no) by a Bokmål voice', voice('no', ''), 'Nora');
eq('Hebrew under its old code (iw)', voice('iw', ''), 'Carmit');
eq('a reconstruction (gem-pro) has no voice', voice('gem-pro', ''), null);
eq('no voices yet: nothing to say it with', voice('en', '', []), null);
eq('accent regions', ['General American', 'Received Pronunciation', 'Canada', 'États-Unis', 'Brasil', 'Cockney', ''].map(ctx.accentRegion), ['US', 'GB', 'CA', 'US', 'BR', 'GB', '']);

eq('the reader\'s languages: Zimi\'s, then the browser\'s', ctx.readerLangs('fr', ['en-US', 'fr-CA', 'de']), ['fr', 'en', 'de']);
const groups = [{ code: 'af', names: { a: 'Afrikaans' } }, { code: 'en', names: { a: 'English' } }, { code: 'fr', names: { a: 'French', b: 'Français' } }, { code: '', names: { c: 'Malti' } }];
eq('a word\'s languages, the reader\'s first, the rest as given', ctx.orderGroups(groups, ['fr', 'en']).map(g => g.code), ['fr', 'en', 'af', '']);
eq('a link\'s section lands on its language, by any edition\'s name', [ctx.groupFor(groups, 'French'), ctx.groupFor(groups, 'Français'), ctx.groupFor(groups, 'fr'), ctx.groupFor(groups, 'Klingon')], [2, 2, 2, -1]);
eq('a link\'s target', ctx.parseTarget('eau#French'), { w: 'eau', sec: 'French' });
eq('a target without a section', ctx.parseTarget('liquid'), { w: 'liquid', sec: '' });
eq('right to left by the language', ['he', 'ar', 'arz', 'en', 'fr', ''].map(ctx.dirOf), ['rtl', 'rtl', 'rtl', 'ltr', 'ltr', 'ltr']);
eq('the day asked for is the reader\'s', ctx.dayStamp(new Date(2026, 0, 5)), '20260105');
eq('the day\'s word in the reader\'s language first', ctx.pickToday([{ w: 'ilma', lang: 'mt' }, { w: 'eau', lang: 'fr' }], ['fr', 'en']).w, 'eau');
const g = { entries: [
  { pron: { audio: [], ipa: [{ accent: 'US', ipa: ['/ˈwɔtəɹ/'] }] }, groups: [] },
  { pron: { audio: [{ path: '-/a.ogg' }], ipa: [{ accent: 'US', ipa: ['\\ˈwɑ.ɾɚ\\'] }] }, groups: [] }] };
const s = ctx.soundsOf(g);
eq('every recording, and the IPA of the first edition that writes it', [s.audio.length, s.ipa.map(r => r.ipa[0])], [1, ['/ˈwɔtəɹ/']]);

// ── the shell ───────────────────────────────────────────────────────────
ok('Dictionary is one of the apps', /var APP_NAMES = \[[^\]]*'dictionary'/.test(app));
ok('its tile is in the row', /dictionary: _dictionaryTileHtml/.test(app));
ok('it reads the Wiktionaries', /z\.kind === 'wiki' && z\.project === 'wiktionary'/.test(app));
ok('a word has an address (/?dictionary=)', /params\.get\('dictionary'\) !== null\) \{ enterHome\(false\); openDictionary\(true/.test(app));
ok('Back and Forward steer the open page', /app\.dictionary && _appFrameRoute\(_dictOpen, app\.w\)/.test(app));
ok('the box suggests as you type and Enter opens the word', /_appFrameCall\('dictSearch', val\)/.test(app) && /_appFrameCall\('dictGo', q\.value\.trim\(\)\)/.test(app));
ok('a word is kept in Saved as a word of Dictionary', /KIND_APP = \{[^}]*word: 'dictionary'/.test(app) && /var KINDS = \[[^\]]*'word'/.test(app));
ok('a saved word opens in Dictionary', /_APP_ITEM_APPS = \[[^\]]*'dictionary'/.test(app) && /app === 'dictionary'\) openDictionary\(false, _dictWordOfPath\(path\)\)/.test(app));
ok('Saved names its words "Words"', /app === 'dictionary' \? t\('saved_words'\)/.test(app));
ok('Define\'s way on is the word in Dictionary', /if \(_appShown\('dictionary'\)\) openDictionary\(false, st\.word\)/.test(app));
ok('the page saves with the shared Save, no Like', /savedBar\(ref, \{ like: false \}\)/.test(page));
ok('the page names no voice it does not have', /data-novoice/.test(page) && /pickVoice\(vs, b\.getAttribute\('data-code'\)/.test(page));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
