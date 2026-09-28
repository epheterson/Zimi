// Copying is one function, and it works where the clipboard API does not.
//
// Two _copyText functions were declared, #99's (a toast that the link was
// copied, a box to copy by hand when nothing else works) and the highlights'
// ("Copied", no box). The later one won, so #99's toast and fallback were
// dead, and Copy link on the link menu called navigator.clipboard straight:
// over http on a LAN, or in an iOS home-screen app, there is no
// navigator.clipboard and the copy failed without a word.
//
// Run: node tests/test_copy_text.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

ok('one _copyText in app.js', src.split('function _copyText(').length === 2);
ok('nothing in the shell calls navigator.clipboard but _copyText', (src.match(/navigator\.clipboard\.writeText\(/g) || []).length === 1);

// A browser with no clipboard API (http on a LAN): the old way, then a box.
function world(execOk, secure) {
  const w = { toasts: [], prompts: [], copiedBy: null };
  w.t = k => k;
  w._showToast = m => w.toasts.push(m);
  w.prompt = (label, text) => w.prompts.push([label, text]);
  w.window = { isSecureContext: !!secure };
  w.navigator = secure ? { clipboard: { writeText: txt => { w.copiedBy = 'api:' + txt; return Promise.resolve(); } } } : {};
  w.document = {
    body: { appendChild: () => {} },
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, setSelectionRange() {}, remove() {} }),
    execCommand: () => execOk,
  };
  w._hideLinkCtxMenu = () => {};
  w.location = { origin: 'http://nas.lan:8899' };
  vm.createContext(w);
  vm.runInContext(extract('_copyText') + extract('_ctxCopyLink') + extract('_ctxCopyTitle') + 'var _linkCtxData = null;', w);
  return w;
}

let w = world(true, false);
vm.runInContext("_linkCtxData = { zim: 'wikipedia', path: 'A/Water', title: 'Water' }; _ctxCopyLink();", w);
ok('Copy link over plain http copies the old way and says the link was copied', w.toasts.join() === 'link_copied' && !w.prompts.length, JSON.stringify(w));
vm.runInContext("_linkCtxData = { zim: 'wikipedia', path: 'A/Water', title: 'Water' }; _ctxCopyTitle();", w);
ok('Copy title says it was copied', w.toasts[1] === 'copied');

w = world(false, false);
vm.runInContext("_linkCtxData = { zim: 'wikipedia', path: 'A/Water', title: 'Water' }; _ctxCopyLink();", w);
ok('where nothing can copy, the link is shown to copy by hand', w.prompts.length === 1 && w.prompts[0][0] === 'copy_link' && w.prompts[0][1] === 'http://nas.lan:8899/w/wikipedia/A/Water', JSON.stringify(w.prompts));
vm.runInContext("_copyText('a passage')", w);
ok('words are shown to copy by hand too, under "Copy"', w.prompts[1] && w.prompts[1][0] === 'copy' && w.prompts[1][1] === 'a passage');

w = world(false, true);
vm.runInContext("_copyText('https://example.org/', true)", w);
setTimeout(() => {
  ok('with the clipboard API, it is used', w.copiedBy === 'api:https://example.org/' && w.toasts.join() === 'link_copied', JSON.stringify(w.toasts));
  process.exit(failures ? 1 : 0);
}, 20);
