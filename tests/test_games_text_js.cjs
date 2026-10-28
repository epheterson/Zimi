// ZimiText (builtin/games/text.js): slots, plurals, numbers, the clock, the language and its direction. No DOM.
//
// Run: node tests/test_games_text_js.cjs   (exit 0 = pass)

const path = require('path');
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'text.js'), 'utf8');
function load(location, navigator) {
  const sb = { location: location || { hash: '' }, navigator: navigator || { language: 'en-US' }, Intl };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb.ZimiText;
}

let Z = load();
check(Z.lang === 'en-us' && Z.dir === 'ltr', 'the language is the browser\'s, lower-cased, left to right');
check(Z.T('cards.n.card', { n: 1 }) === '1 card' && Z.T('cards.n.card', { n: 3 }) === '3 cards', 'a plural entry picks its form');
check(Z.T('cards.name', { rank: 'ace', suit: 'spades' }) === 'ace of spades', 'named slots fill in');
check(Z.T('no.such.id') === 'Id' && Z.T('sokoban.bestLap') === 'Best lap', 'an unknown id never shows itself: its last part reads as words');
check(Z.T('cards.n.card', { n: 1234 }) === '1,234 cards' && Z.T('cards.n.card', { n: 1000 }) === '1,000 cards', 'numbers format for the language');
check(Z.clock(75) === '1:15' && Z.clock(5) === '0:05' && Z.clock(3725) === '1:02:05' && Z.clock(-3) === '0:00', 'the clock reads m:ss, with hours from an hour');
check(Z.ago(10000) === 'just now' && /5 minutes ago/.test(Z.ago(5 * 60000)) && /yesterday|1 day ago/.test(Z.ago(86400000)), 'ago reads in words');

Z = load({ hash: '#lang=ar&dir=rtl' });
check(Z.lang === 'ar' && Z.dir === 'rtl', 'the hash sets the language and the direction');
check(Z.T('shell.menu.new') === 'New game', 'a language with no table falls back to English');
Z.add('ar', { 'shell.menu.new': 'لعبة جديدة' });
check(Z.T('shell.menu.new') === 'لعبة جديدة' && Z.T('shell.menu.settings') === 'Settings', 'a translation fills in what it has');
Z = load({ hash: '' }, { language: 'he-IL' });
check(Z.dir === 'rtl', 'Hebrew reads right to left');
Z = load({ hash: '#lang=fr' });
Z.add('fr', { 'cards.n.card': { one: '{n} carte', other: '{n} cartes' } });
check(Z.T('cards.n.card', { n: 0 }) === '0 carte' && Z.T('cards.n.card', { n: 2 }) === '2 cartes', 'French plurals: zero is singular');

// Only the active language is read, from text/<lang>.json beside the script, synchronously while the page is parsed.
{
  const sb = { location: { hash: '#lang=de' }, navigator: { language: 'en-US' }, Intl, document: { readyState: 'loading', currentScript: { src: 'http://x/games/text.js' }, documentElement: { setAttribute() {} } } };
  const asked = [];
  sb.XMLHttpRequest = function () { this.open = (m, u, a) => { asked.push(u + ' async=' + a); this.u = u; }; this.send = () => { this.status = 200; this.responseText = JSON.stringify({ 'shell.menu.new': 'Neues Spiel' }); }; };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb);
  check(asked.length === 1 && asked[0] === 'http://x/games/text/de.json async=false', 'one language file is read, synchronously, and only the active one: ' + asked);
  check(sb.ZimiText.T('shell.menu.new') === 'Neues Spiel' && sb.ZimiText.T('shell.menu.settings') === 'Settings', 'the file fills in what it has and English fills the rest');
  const en = { location: { hash: '' }, navigator: { language: 'en-US' }, Intl, document: sb.document, XMLHttpRequest: function () { asked.push('English read a file'); } };
  en.globalThis = en; vm.createContext(en); vm.runInContext(src, en);
  check(!asked.some((a) => /English/.test(a)), 'English reads no file');
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('ok test_games_text_js');
