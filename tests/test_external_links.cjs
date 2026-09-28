// Links that leave the library (#99): the one classifier every reader and app
// page shares, zimiLinkKind(href, base).
//
// tripplehelix: "It can be confusing as to which links take you to the web."
// The mark, the where-it-goes sheet and the Hide setting all hang off this one
// verdict, so its edges are pinned here: a link an installed ZIM can answer is
// the library, not the web; mail and phone links belong to another program;
// javascript: is never followed, however it is spelled.
//
// Run: node tests/test_external_links.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

function grab(name) {
  const needle = `function ${name}(`;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error(name + ' not found in app.js');
  let j = src.indexOf('{', i), d = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
function grabVar(name) {
  const m = new RegExp('var ' + name + ' = [^;]+;').exec(src);
  if (!m) throw new Error(name + ' not found in app.js');
  return m[0];
}

const sandbox = {
  URL,
  location: { origin: 'http://zimi.local:8899', hostname: 'zimi.local', href: 'http://zimi.local:8899/?a=wiki/A/Page' },
  // An installed Wikipedia answers for en.wikipedia.org; a capture for
  // docs.example (with its www. variant, as the server builds the map).
  _domainZimMap: { 'en.wikipedia.org': 'wikipedia_en_all', 'docs.example': 'docs_capture', 'www.docs.example': 'docs_capture' },
};
vm.createContext(sandbox);
vm.runInContext([grabVar('_EXT_SCHEME_RE'), grabVar('_EXT_AUTHORITY_RE'), grabVar('_EXT_PLAIN_HOST_RE'), grabVar('_EXT_APP_SCHEMES'), grab('_extHostZim'), grab('zimiLinkKind')].join('\n'), sandbox);
const kind = sandbox.zimiLinkKind;

let failures = 0;
const check = (got, want, label) => {
  if (got === want) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label + ' got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
};

const PAGE = 'http://zimi.local:8899/w/wiki/A/Page';

// The library: this server, and the sites an installed ZIM holds.
check(kind('Other_page', PAGE), 'library', 'a relative link is a page of this ZIM');
check(kind('../-/style.css', PAGE), 'library', 'so is one that climbs');
check(kind('/w/other/A/Thing'), 'library', 'a root-relative link is this server');
check(kind('http://zimi.local:8899/w/wiki/A/X'), 'library', 'this origin, spelled out');
check(kind('https://en.wikipedia.org/wiki/Tea'), 'library', 'a site an installed ZIM holds is not the web');
check(kind('https://EN.Wikipedia.org/wiki/Tea'), 'library', 'hosts are case-insensitive');
check(kind('https://www.docs.example/guide'), 'library', 'www. or not, the same site');
check(kind('//en.wikipedia.org/wiki/Tea'), 'library', 'protocol-relative, to an installed site');

// The web.
check(kind('https://elsewhere.example/x'), 'web', 'another origin, no ZIM for it');
check(kind('http://fr.wikipedia.org/wiki/Th%C3%A9'), 'web', 'the French Wikipedia, not installed');
check(kind('//cdn.example/y', PAGE), 'web', 'protocol-relative to another site');
check(kind('\\\\cdn.example/y', PAGE), 'web', 'backslashes, which a browser reads as slashes');
check(kind('  https://elsewhere.example/  '), 'web', 'surrounding spaces do not hide it');
check(kind('HTTPS://ELSEWHERE.EXAMPLE/'), 'web', 'nor capitals');
check(kind('http://zimi.local:9000/'), 'web', 'another port is another origin');
check(kind('page.html', 'https://elsewhere.example/dir/'), 'web', 'relative to a page on the web is the web');
// Hosts read as written only when they are plain; the rest are parsed.
check(kind('https://user@elsewhere.example/'), 'web', 'a user in the address');
check(kind('https://elsewhere.example:8443/'), 'web', 'a port');
check(kind('https://en.wikipedia.org:443/wiki/Tea'), 'library', 'the default port, spelled out');
check(kind('https://b\u00fccher.example/'), 'web', 'a host outside ASCII');
check(kind('http://ZIMI.local:8899/w/x'), 'library', 'this server, in capitals');
check(kind('http://zimi.local/w/x'), 'web', 'this host on another port is another origin');

// Another program's, never marked and never opened as a web page.
check(kind('mailto:someone@example.org'), 'app', 'mail');
check(kind('tel:+15551234'), 'app', 'a phone number');
check(kind('sms:+15551234'), 'app', 'a text message');
check(kind('MAILTO:x@y.z'), 'app', 'schemes are case-insensitive');

// Nowhere Zimi follows.
check(kind('javascript:alert(1)'), 'none', 'javascript: is never a link out');
check(kind(' javascript:void(0)'), 'none', 'not with a space in front');
check(kind('java\tscript:alert(1)'), 'none', 'not with a tab inside (a browser strips it and runs it)');
check(kind('\u0001javascript:alert(1)'), 'none', 'not behind a control character');
check(kind('data:text/html,hi'), 'none', 'data:');
check(kind('#section'), 'none', 'an anchor on this page');
check(kind(''), 'none', 'empty');
check(kind(null), 'none', 'missing');
check(kind('http://[bad'), 'none', 'an address that does not parse');

process.exit(failures ? 1 : 0);
