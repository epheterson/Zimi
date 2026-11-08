// Which part of the search box is a place being typed after near: (the
// autocomplete's trigger, _nearTyping in app.js), and what picking one puts
// in the box (_pickNearPlace). The server's half is tests/test_place_autocomplete.py,
// the dropdown in a browser tests/test_place_autocomplete_live.py.
//
// Run: node tests/test_near_typing.cjs   (exit 0 = pass)

const vm = require('vm');

const src = require('./app_source.cjs')();
function grab(head) {
  const i = src.indexOf(head);
  if (i < 0) throw new Error('not found: ' + head);
  const line = src.slice(i, src.indexOf('\n', i));
  if (/;\s*(\/\/.*)?$/.test(line) && !/[{[(]\s*$/.test(line)) return line + '\n';
  let j = src.indexOf('{', i);
  for (let d = 0; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1) + '\n';
  }
  throw new Error('unbalanced ' + head);
}

// A box: its value and caret, as the picker reads and sets them.
const q = {
  value: '', caret: 0,
  focus() {},
  setSelectionRange(a) { this.caret = a; },
};
const sandbox = { console, q };
vm.createContext(sandbox);
vm.runInContext(['const NEAR_TYPING = ', 'const NEAR_NOT_A_NAME = ', 'function _nearTyping(', 'function _pickNearPlace(']
  .map(grab).join('').replace(/^const /gm, 'var '), sandbox);

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };
const typed = (value, caret) => { const r = sandbox._nearTyping(value, caret); return r && r.typed; };

check(typed('near:Spri') === 'Spri', 'near:Spri is "Spri" being typed');
check(typed('parks near:Paris, Tex') === 'Paris, Tex', 'a place with where after a comma, after other words');
check(typed('near:Paris,') === 'Paris,', 'a comma with nothing after it yet');
check(typed('near:"Springfield, Ill') === 'Springfield, Ill', 'a quoted place half typed');
check(typed('near:“New Haven, Con') === 'New Haven, Con', 'a quote from a phone keyboard');
check(typed('near:') === null, 'near: alone offers nothing yet');
check(typed('near:39.8,-89.6') === null && typed('near:-33.9,151') === null, 'a position is not a name');
check(typed('near:here') === null && typed('near:HERE') === null, 'here is not a name');
check(typed('near:Here') === null && typed('near:Hereford') === 'Hereford', 'but a name that starts with it is');
check(typed('near:Springfield 5km') === null, 'once a distance follows, the place is done');
check(typed('near:"Springfield, Illinois" ') === null, 'a closed quote is done');
check(typed('-near:Spri') === null && typed('xnear:Spri') === null, 'only near: itself, not -near: or a word ending in it');
check(typed('near:Spri more words', 9) === 'Spri', 'the caret decides: before the words after it');
check(typed('hotels near:Spri', 16) === 'Spri' && typed('Near:Spri') === 'Spri', 'in any case, anywhere in the query');

// Picking: where the typed part was, quoted when it has a space or comma.
const pick = (value, token) => {
  q.value = value;
  const at = sandbox._nearTyping(value);
  sandbox._pickNearPlace({ token, at });
  return q.value;
};
check(pick('near:Spri', 'Springfield, Illinois') === 'near:"Springfield, Illinois" ', 'the pick is quoted, with a space for the distance');
check(q.caret === q.value.length, 'and the caret is after it');
check(pick('parks near:Paris, Tex', 'Paris, Texas') === 'parks near:"Paris, Texas" ', 'after other words');
check(pick('near:Reykjavik', 'Reykjavik') === 'near:Reykjavik ', 'a bare name stays bare');
q.value = 'near:Spri 5km';
sandbox._pickNearPlace({ token: 'Springfield, Illinois', at: sandbox._nearTyping(q.value, 9) });
check(q.value === 'near:"Springfield, Illinois" 5km', 'a distance already after it stays: ' + JSON.stringify(q.value));
check(q.caret === 'near:"Springfield, Illinois" '.length, 'with the caret before it: ' + q.caret);

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
