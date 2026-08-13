// Activity rows: the pure client logic behind the unified journal view —
// how a record's actor is grouped, how its verb is composed, and how the two
// filter axes compose. Extracted from app.js with the same vm approach as
// test_bookmark_export_compose.cjs so it runs without a browser.
//
// The one contract worth guarding hardest: _actActorKey must group records the
// same way the server's _activity_actor_key does (manage.py), or the checkbox
// list and the rows disagree about who did what.
//
// Run: node tests/test_activity_rows.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

// The i18n stub returns the KEY for anything it doesn't know, exactly like the
// real t() does for a missing string — which is also how _actTypeLabel and
// _actVerb detect a type the server invented after this build shipped.
const STRINGS = {
  act_actor_server: 'Server',
  act_actor_unknown: 'Unknown',
  act_type_download: 'Download',
  act_type_update: 'Update',
  act_type_create: 'Creation',
  act_ev_download: 'Downloaded',
  act_ev_update: 'Updated',
  act_ev_create: 'Created',
  act_out_failed: 'Failed',
  act_out_cancelled: 'Cancelled',
  act_out_interrupted: 'Interrupted',
};

function sandboxWith(records) {
  const sandbox = {
    t: (key) => (key in STRINGS ? STRINGS[key] : key),
    _act: { records: records || [], types: [], actors: [], offTypes: {}, offActors: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/function _actActorKey\(r\)\s*\{[\s\S]*?\n\}/, '_actActorKey') +
    extract(/function _actActorLabel\(key\)\s*\{[\s\S]*?\n\}/, '_actActorLabel') +
    extract(/function _actTypeLabel\(type\)\s*\{[\s\S]*?\n\}/, '_actTypeLabel') +
    extract(/function _actVerb\(r\)\s*\{[\s\S]*?\n\}/, '_actVerb') +
    extract(/function _actFilterCount\(\)\s*\{[\s\S]*?\n\}/, '_actFilterCount') +
    extract(/function _actVisibleRecords\(\)\s*\{[\s\S]*?\n\}/, '_actVisibleRecords'),
    sandbox);
  return sandbox;
}

// ── the actor key ───────────────────────────────────────────────────────────
{
  const sb = sandboxWith();
  const key = (actor) => vm.runInContext('_actActorKey(' + JSON.stringify({ actor }) + ')', sb);
  ok('a named user groups under their name', key({ kind: 'user', name: 'eric' }) === 'eric');
  ok('the server groups under "server"', key({ kind: 'server', name: null }) === 'server');
  ok('a pre-1.9 record groups under "unknown"', key({ kind: 'unknown', name: null }) === 'unknown');
  ok('a user with no name falls back to the kind', key({ kind: 'user' }) === 'user');
  ok('a record with no actor at all still groups', key(undefined) === 'server');

  ok('the server chip is localized', vm.runInContext("_actActorLabel('server')", sb) === 'Server');
  ok('the unknown chip is localized', vm.runInContext("_actActorLabel('unknown')", sb) === 'Unknown');
  // A username is a name, not a string to translate.
  ok('a username is shown verbatim', vm.runInContext("_actActorLabel('priya')", sb) === 'priya');
}

// ── the verb ────────────────────────────────────────────────────────────────
{
  const sb = sandboxWith();
  const verb = (r) => vm.runInContext('_actVerb(' + JSON.stringify(r) + ')', sb);
  ok('a success reads as past tense',
    verb({ type: 'download', outcome: 'ok' }) === 'Downloaded');
  ok('a failure names the thing and what went wrong',
    verb({ type: 'update', outcome: 'failed' }) === 'Update · Failed');
  ok('a cancellation says cancelled, not failed',
    verb({ type: 'download', outcome: 'cancelled' }) === 'Download · Cancelled');
  ok('an interrupted run says so',
    verb({ type: 'create', outcome: 'interrupted' }) === 'Creation · Interrupted');
  // A type this build has no strings for must render as itself, not as a raw
  // i18n key — a newer server may journal a type an older client never heard of.
  ok('an unknown type falls back to its own name',
    verb({ type: 'reindex', outcome: 'ok' }) === 'reindex');
  ok('an unknown type still reports its failure',
    verb({ type: 'reindex', outcome: 'failed' }) === 'reindex · Failed');
}

// ── the filters ─────────────────────────────────────────────────────────────
{
  const RECORDS = [
    { type: 'update', subject: 'Wikipedia', actor: { kind: 'server', name: null } },
    { type: 'update', subject: 'Gutenberg', actor: { kind: 'user', name: 'eric' } },
    { type: 'create', subject: 'Field Notes', actor: { kind: 'user', name: 'eric' } },
    { type: 'delete', subject: 'Old ZIM', actor: { kind: 'user', name: 'admin' } },
  ];
  const sb = sandboxWith(RECORDS);
  const subjects = () =>
    vm.runInContext('_actVisibleRecords().map(function(r){return r.subject})', sb).join(',');

  ok('nothing filtered shows everything', subjects() === 'Wikipedia,Gutenberg,Field Notes,Old ZIM');
  ok('no filter is no badge', vm.runInContext('_actFilterCount()', sb) === 0);

  vm.runInContext("_act.offTypes['update'] = true", sb);
  ok('a turned-off type drops its rows', subjects() === 'Field Notes,Old ZIM');

  vm.runInContext("_act.offActors['eric'] = true", sb);
  ok('the two axes compose', subjects() === 'Old ZIM');
  ok('the badge counts both axes', vm.runInContext('_actFilterCount()', sb) === 2);

  // Eric's case: the same event type from two actors, told apart by the actor
  // axis alone.
  vm.runInContext('_act.offTypes = {}; _act.offActors = {}', sb);
  vm.runInContext("_act.offActors['server'] = true", sb);
  ok('an actor filter separates a hand update from an auto-update',
    subjects() === 'Gutenberg,Field Notes,Old ZIM');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
