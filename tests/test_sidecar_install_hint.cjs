// The install command the Create page offers must target THIS server.
//
// `zimi import --setup` resolves its own data dir from the shell it is run in.
// Run from a terminal that does not carry the service's config it resolves a
// different one, installs a working sidecar into it, prints "sidecar ready",
// and leaves the engine greyed out with nothing on screen to explain the gap
// (issue #61: set up against the default /zims while the service served
// /mnt/nas/ZIM). Naming the server's own directory in the command is what
// closes that, so the command has to keep naming it.
//
// Run: node tests/test_sidecar_install_hint.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'zimi', 'static', 'create.js'), 'utf8');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

function extractFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let j = s.indexOf('{', i), d = 0;
  for (; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}' && --d === 0) return s.slice(i, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

const sandbox = {
  console,
  CREATE_PART_INSTALL: { sidecar: 'zimi import --setup' },
  _createSidecarDir: null,
};
vm.createContext(sandbox);
vm.runInContext(extractFn(src, '_createShellQuote'), sandbox);
vm.runInContext(extractFn(src, '_createSidecarCommand'), sandbox);

function cmd(dir) {
  sandbox._createSidecarDir = dir;
  return vm.runInContext('_createSidecarCommand()', sandbox);
}

check(cmd(null) === 'zimi import --setup',
  'with no reported directory the command stays the plain one');

const nasDir = '/home/pi/.cache/zimi/zims-5fa07e4eab/tools/warc2zim';
check(cmd(nasDir) === 'zimi import --setup --data-dir /home/pi/.cache/zimi/zims-5fa07e4eab',
  'the reported sidecar dir becomes --data-dir, without the tools/warc2zim tail');

check(cmd('/srv/my zims/.zimi/tools/warc2zim') ===
      "zimi import --setup --data-dir '/srv/my zims/.zimi'",
  'a path with a space is quoted, so the command survives a paste');

// Single quotes, not double: a shell expands $HOME and backticks inside double
// quotes, so a double-quoted path containing either pastes as a DIFFERENT path.
check(cmd('/srv/$USER/.zimi/tools/warc2zim') ===
      "zimi import --setup --data-dir '/srv/$USER/.zimi'",
  'a path a shell would expand is quoted so it cannot be expanded');

check(cmd("/srv/it's/.zimi/tools/warc2zim") ===
      "zimi import --setup --data-dir '/srv/it'\\''s/.zimi'",
  'an embedded single quote is escaped the way a shell accepts');

check(cmd('/var/lib/zimi') === 'zimi import --setup',
  'a reported path that is not a sidecar venv is not guessed at');

check(cmd(nasDir).indexOf('tools') < 0,
  '--data-dir names the data dir, not the venv inside it');

// The whole point is that the server states this. If the probe stops carrying
// it the command silently reverts to the one that installs in the wrong place.
check(/sidecar_dir/.test(src),
  'create.js still reads sidecar_dir off the probe reply');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all sidecar install hint checks passed');
