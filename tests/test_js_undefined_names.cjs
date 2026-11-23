// Shipped JavaScript must not use a name that nothing defines.
//
// A merge that drops a function leaves its callers behind, and nothing fails until a user taps the button
// ("_appMenuHasMore is not defined"). This finds those at commit time: every identifier read that no script of the
// same page declares, assigns, or sets on window, and that the browser does not provide.
//
// Pages, as the scripts really load together:
//   - Zimi's own page: every zimi/static/*.js (lazily loaded ones share the one global scope) plus the inline scripts of
//     zimi/templates/index.html and zimi/static/*.html.
//   - Each page under zimi/builtin/<app>/: the scripts its own <script> tags name, and its inline ones. The Almanac's page
//     also gets Zimi's own scripts (the build stages them into it).
//
// A name that is only ever read as `typeof NAME` somewhere in the file is a feature probe, not a use, and is left alone.
//
// Not caught: a name defined by a script that the page never loads (a lazy script missing from the Zimi page's load list
// is indistinguishable from one that is there), a method or property that is gone (`obj.fn()`), a name built at run time,
// a handler named in markup (`onclick="fn()"`), and a name defined in a file the page does not load but another page does.
//
// Run: node tests/test_js_undefined_names.cjs   (CI runs it with the other node tests)

'use strict';
const fs = require('fs');
const path = require('path');
const V = path.join(__dirname, 'vendor', 'jscheck');
const acorn = require(path.join(V, 'acorn.js'));
const eslintScope = require(path.join(V, 'eslint-scope.js'));
const BROWSER = new Set(JSON.parse(fs.readFileSync(path.join(V, 'globals.json'), 'utf8')));
['require', 'module', 'exports'].forEach((n) => BROWSER.add(n));   // only ever behind `typeof`, but cheap to allow

const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(ROOT, 'zimi', 'static');
const BUILTIN = path.join(ROOT, 'zimi', 'builtin');

function readText(p) { return fs.readFileSync(p, 'utf8'); }
function parse(src) {
  const opts = { ecmaVersion: 'latest', locations: true, ranges: true, allowReturnOutsideFunction: true, allowHashBang: true };
  try { return acorn.parse(src, Object.assign({ sourceType: 'script' }, opts)); }
  catch (e) { return acorn.parse(src, Object.assign({ sourceType: 'module' }, opts)); }
}

function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const k in node) {
    if (k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => walk(x, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

// Names a script gets from outside the files: the desktop app's bridge, a library a page loads on demand by a computed address.
const PROVIDED_AT_RUN_TIME = {
  pywebview: 'the desktop app (pywebview) puts its bridge on the window',
  pdfjsLib: 'pdf.js, loaded on the first PDF',
  OGVLoader: 'ogv.js, loaded on the first Ogg video',
};

const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);

// One script's facts: what it defines for the page, what it uses that it does not define itself.
function analyze(label, src) {
  const out = { label: label, defines: new Set(), uses: [], probed: new Set() };
  let ast;
  try { ast = parse(src); } catch (e) { out.error = e.message; return out; }
  // (function (root) { ... root.NAME = ...; })(window)  or  (typeof self !== 'undefined' ? self : this): the parameter is the window.
  const aliases = new Set(GLOBAL_OBJECTS);
  const namesTheWindow = (e) => !!e && (e.type === 'ThisExpression' || (e.type === 'Identifier' && GLOBAL_OBJECTS.has(e.name)) ||
    (e.type === 'ConditionalExpression' && (namesTheWindow(e.consequent) || namesTheWindow(e.alternate))) ||
    (e.type === 'LogicalExpression' && (namesTheWindow(e.left) || namesTheWindow(e.right))));
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && /FunctionExpression/.test(n.callee.type)) {
      n.callee.params.forEach((p, i) => { if (p.type === 'Identifier' && namesTheWindow(n.arguments[i])) aliases.add(p.name); });
    }
  });
  walk(ast, (n) => {
    if (n.type === 'UnaryExpression' && n.operator === 'typeof' && n.argument.type === 'Identifier') out.probed.add(n.argument.name);
    // window.NAME = ..., self.NAME = ..., globalThis.NAME = ...
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed &&
        n.left.object.type === 'Identifier' && aliases.has(n.left.object.name)) out.defines.add(n.left.property.name);
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.computed &&
        n.left.object.type === 'Identifier' && aliases.has(n.left.object.name) && n.left.property.type === 'Literal') {
      out.defines.add(String(n.left.property.value));
    }
    // Object.defineProperty(window, 'NAME', ...)
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'defineProperty' &&
        n.arguments.length > 1 && n.arguments[0].type === 'Identifier' && GLOBAL_OBJECTS.has(n.arguments[0].name) &&
        n.arguments[1].type === 'Literal') out.defines.add(String(n.arguments[1].value));
  });
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: ast.sourceType === 'module' ? 'module' : 'script' });
  const g = scopes.globalScope;
  const top = ast.sourceType === 'module' ? scopes.scopes.find((s) => s.type === 'module') : g;
  g.variables.forEach((v) => { if (v.defs.length) out.defines.add(v.name); });
  if (top && top !== g) top.variables.forEach((v) => { if (v.defs.length) out.defines.add(v.name); });
  g.through.forEach((r) => {
    const name = r.identifier.name;
    if (r.isWrite() && !r.init) out.defines.add(name);      // an assignment with no declaration makes a global
    if (r.isRead()) out.uses.push({ name: name, line: r.identifier.loc.start.line });
  });
  return out;
}

// <script> tags of an HTML file, in order: { src } or { inline }.
function scriptsOf(html) {
  const found = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]) || [])[1];
    if (type && !/javascript|module/i.test(type)) continue;   // json islands, templates
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (src) found.push({ src: src[1] });
    else if (m[2].trim()) found.push({ inline: m[2], line: html.slice(0, m.index).split('\n').length });
  }
  return found;
}

// `scripts` define the page; `also` define for it too (Zimi's own scripts, staged into the Almanac) but are checked on their own.
function check(pageName, scripts, also) {
  const defined = new Set();
  for (const s of scripts.concat(also || [])) s.defines.forEach((n) => defined.add(n));
  const bad = [];
  for (const s of scripts) {
    const seen = new Set();
    for (const u of s.uses) {
      if (defined.has(u.name) || BROWSER.has(u.name) || s.probed.has(u.name) || seen.has(u.name)) continue;
      seen.add(u.name);
      if (PROVIDED_AT_RUN_TIME[u.name]) continue;
      bad.push(pageName + ': ' + s.label + ':' + u.line + ' uses ' + u.name);
    }
  }
  return bad;
}

// The checker itself: a name nothing defines is found; one defined, probed, or set on the window by a wrapper is not.
(function selfTest() {
  const page = [
    analyze('a.js', 'function f() { return missing() + defined() + typeof probed + typeof probed2 === "x" && probed2(); }\nfunction defined() {}'),
    analyze('b.js', '(function (root) { root.viaWrapper = 1; })(typeof self !== "undefined" ? self : this); window.viaWindow = 2; leaked = 3;'),
    analyze('c.js', 'viaWrapper(); viaWindow(); leaked(); let local = 1; { let inner = local; } try {} catch (err) { err; }'),
  ];
  const got = check('self-test', page).map((l) => l.replace(/^.*uses /, ''));
  if (got.join() !== 'missing') {
    console.log('The undefined-name checker is broken: expected only "missing", got "' + got.join() + '"');
    process.exit(1);
  }
})();

const problems = [];
const parseErrors = [];

function load(label, file) {
  const a = analyze(label, readText(file));
  if (a.error) parseErrors.push(label + ': ' + a.error);
  return a;
}

function inlineOf(label, html) {
  return scriptsOf(html).filter((s) => s.inline).map((s) => {
    const a = analyze(label + '#' + s.line, s.inline);
    if (a.error) parseErrors.push(label + ': ' + a.error);
    return a;
  });
}

// ── Zimi's own page ──
const zimi = [];
for (const f of fs.readdirSync(STATIC).filter((n) => n.endsWith('.js')).sort()) zimi.push(load('static/' + f, path.join(STATIC, f)));
const zimiHtml = [path.join(ROOT, 'zimi', 'templates', 'index.html')]
  .concat(fs.readdirSync(STATIC).filter((n) => n.endsWith('.html')).map((n) => path.join(STATIC, n)));
for (const h of zimiHtml) zimi.push.apply(zimi, inlineOf(path.relative(ROOT, h), readText(h)));
problems.push.apply(problems, check('Zimi', zimi));

// ── Each page of Zimi's own ZIMs ──
function htmlPages(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push.apply(out, htmlPages(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}
const cache = {};
function loadCached(label, file) { return cache[file] || (cache[file] = load(label, file)); }

if (fs.existsSync(BUILTIN)) {
  for (const app of fs.readdirSync(BUILTIN, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const page of htmlPages(path.join(BUILTIN, app.name))) {
      const rel = path.relative(ROOT, page);
      const html = readText(page);
      const scripts = [];
      for (const s of scriptsOf(html)) {
        if (s.inline) { scripts.push.apply(scripts, inlineOf(rel, '<script>' + s.inline + '</script>').map((a) => { return a; })); continue; }
        if (/^(https?:)?\/\//.test(s.src)) continue;
        const clean = s.src.split('?')[0];
        const file = clean.startsWith('/static/') ? path.join(STATIC, clean.slice(8)) : path.resolve(path.dirname(page), clean);
        if (fs.existsSync(file)) scripts.push(loadCached(path.relative(ROOT, file), file));
      }
      if (!scripts.length) continue;
      problems.push.apply(problems, check(rel, scripts, app.name === 'almanac' ? zimi : []));
    }
  }
}

let failed = false;
if (parseErrors.length) { failed = true; console.log('Could not parse:\n  ' + parseErrors.join('\n  ')); }
const unique = [...new Set(problems)];
if (unique.length) {
  failed = true;
  console.log('Names used and defined nowhere on their page (' + unique.length + '):\n  ' + unique.join('\n  '));
}
if (failed) process.exit(1);
console.log('ok: no undefined names across ' + Object.keys(cache).length + ' builtin scripts and ' + zimi.length + ' Zimi scripts');
