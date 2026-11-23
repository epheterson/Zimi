// A toast stays up as long as its words take to read: a long refusal (a voice
// install on a noexec disk) used to vanish in the same 3 s as "Error".
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
const consts = src.match(/var _TOAST_MIN_MS = [^\n]+/)[0];
const fn = src.match(/function _toastMs\(msg\) \{[^\n]+\}/)[0];
const _toastMs = new Function(consts + '\n' + fn + '\nreturn _toastMs;')();
const noexec = 'Voices cannot be installed in /media/usb/zims/.zimi/tools/voices: /media/usb is mounted noexec, ' +
  'so the engines cannot run from it. Start Zimi with --data-dir on a disk that allows programs to run.';
assert.strictEqual(_toastMs('Error'), 3000, 'a few words keep the 3 s toast');
assert.ok(_toastMs(noexec) >= 12000, 'the noexec refusal stays up long enough to read: ' + _toastMs(noexec));
// _showToast uses it when the caller names no duration.
assert.ok(/duration \|\| _toastMs\(msg\)/.test(src), '_showToast falls back to the reading time');
console.log('all passed');
