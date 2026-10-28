// Read aloud in the server's voices: which engine reads an article, and how
// a reading moves on when an engine is too slow on this server. The
// browser's own voices (speechSynthesis) were all Read aloud had; on Linux
// they are often espeak, or nothing.
//
// Run: node tests/test_tts_server_voices.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Read aloud's reading is readaloud.js (fetched on first use), the rest app.js;
// readaloud.js first, so its functions are found before app.js's stand-ins.
const src = ['readaloud.js', 'app.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', f), 'utf8')).join('\n').replace(/\r\n/g, '\n'); // a Windows checkout's line ends
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
function fn(name) { return extract(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}'), name); }

// ── which engine reads ───────────────────────────────────────────────────
const store = {};
let prefs = { voice: '', off: [] };
const ctx = {
  SK: { TTS_SLOW: 'zimi_tts_slow', TTS_DEVICE_TIMES: 'zimi_tts_device_times' },
  _DEVICE_VOICE: 'device',
  _TTS_AVAILABLE: false,
  _ttsVoices: { langs: { en: { engine: 'kokoro', engines: ['kokoro', 'piper'] }, fr: { engine: 'kokoro', engines: ['kokoro'] } } },
  _voicePrefs: () => prefs,
  _langPrimary: tag => String(tag || '').split('-')[0],
  _normLang: c => ({ eng: 'en', fra: 'fr' })[c] || c,
  _getStorageJSON: (k, fb) => (k in store ? JSON.parse(store[k]) : fb),
  _setStorageJSON: (k, v) => { store[k] = JSON.stringify(v); },
  _ttsRate: () => 1,
  _TTS_KEEP_UP: 0.8,
  _TTS_GAP_OK_S: 0.5,
  _TTS_GAP_RATES: [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3],
  _TTS_RATE_EPS: 1e-6,
  _TTS_SLOW_FOR_MS: 24 * 3600 * 1000,
  _TTS_WAIT_MAX_S: 60, _TTS_WAIT_KEEP_S: 300, _TTS_CPS: 14, _TTS_WORK_MIN_S: 0.3, _TTS_WORK_MIN_CHARS: 200,
};
vm.createContext(ctx);
vm.runInContext(['_ttsWaits', '_ttsPace', '_ttsLeadEnd', '_voiceTimings', '_ttsServerEngines', '_ttsChosenVoice', '_ttsRowOrder', '_ttsSlowEngines', '_ttsMarkSlow', '_ttsGapAt', '_ttsKeepsUp', '_ttsTooSlow', '_ttsServerSays', '_ttsCanSpeak', '_ttsSpeakUrl'].map(fn).join('\n'), ctx);
const engines = lang => JSON.stringify(ctx._ttsServerEngines(lang));
const slowOnes = () => JSON.stringify(Object.keys(JSON.parse(store.zimi_tts_slow || '{}')));

ok('Automatic: the server\'s choice first, then the rest', engines('en') === '["kokoro","piper"]', engines('en'));
ok('a ZIM\'s three-letter code and a region find the language', engines('eng') === '["kokoro","piper"]' && engines('en-GB') === '["kokoro","piper"]');
prefs = { voice: 'piper', off: [] };
ok('the chosen voice (Clear) reads alone: no engine to give way to', engines('en') === '["piper"]', engines('en'));
prefs = { voice: '', off: ['kokoro'] };
ok('a voice Settings turned off never reads', engines('en') === '["piper"]', engines('en'));
prefs = { voice: 'device', off: [] };
ok('Device: no server voice, the browser reads as before', engines('en') === '[]');
prefs = { voice: '', off: [] };
ok('a language the server cannot say: none', engines('de') === '[]');

store.zimi_tts_slow = '["piper","espeak"]'; // kept before 1.14.1, when a moment's wait was called slow
ok('a list of slow voices from before 1.14.1 is forgotten', JSON.stringify(ctx._ttsSlowEngines()) === '[]');
ctx._ttsMarkSlow('kokoro');
const markedAt = JSON.parse(store.zimi_tts_slow).kokoro;
ctx._ttsMarkSlow('kokoro');
ok('a slow engine is remembered once, with when', JSON.stringify(Object.keys(JSON.parse(store.zimi_tts_slow))) === '["kokoro"]' && JSON.parse(store.zimi_tts_slow).kokoro === markedAt, store.zimi_tts_slow);
ok('Automatic: a slow engine reads last', engines('en') === '["piper","kokoro"]', engines('en'));
ok('...and still reads when it is the only one', engines('fr') === '["kokoro"]');
prefs = { voice: 'kokoro', off: [] };
ok('a slow engine that was chosen still reads, alone', engines('en') === '["kokoro"]', engines('en'));
prefs = { voice: '', off: [] };
store.zimi_tts_slow = JSON.stringify({ kokoro: Date.now() - 25 * 3600 * 1000 });
ok('a browser\'s slow mark holds a day, not for good', engines('en') === '["kokoro","piper"]', engines('en'));
store.zimi_tts_slow = JSON.stringify({ piper: Date.now() });
ctx._ttsVoices.timings = { kokoro: { rtf: 2.9 } };
ok('Automatic: a voice the server measured too slow reads after one only this browser thought slow', engines('en') === '["piper","kokoro"]', engines('en'));
ctx._ttsVoices.timings = {};
store.zimi_tts_slow = JSON.stringify({ kokoro: Date.now() });
prefs = { voice: '', off: [], wait: true };
ok('waiting for the best voice: Automatic keeps the server\'s order, a slow one first', engines('en') === '["kokoro","piper"]', engines('en'));
prefs = { voice: 'piper', off: [], wait: true };
ok('...and a chosen voice still reads alone', engines('en') === '["piper"]', engines('en'));
prefs = { voice: '', off: [] };

// How far ahead a slow voice gets before it plays: 140 characters is ten
// seconds of speech at 14 a second; at rtf 1.5 each takes fifteen to make.
const lens = n => Array.from({ length: n }, () => 'x'.repeat(140));
const slowPace = { work: 1.5 / 14, audio: 1 / 14 };
ok('a slow voice gets far enough ahead that the rest plays without a pause', ctx._ttsLeadEnd(lens(4), 0, slowPace, 1) === 1);
ok('...counted from where it starts', ctx._ttsLeadEnd(lens(6), 2, slowPace, 1) === 3);
ok('...a long article waits a minute at most, then pauses to catch up', ctx._ttsLeadEnd(lens(100), 0, slowPace, 1) === 3);
ok('...faster speech needs more ahead', ctx._ttsLeadEnd(lens(4), 0, slowPace, 2) === 2);
{
  // The ring while it gets ahead: how much of the wait is done.
  const now = { t: 100000 };
  const rc = { _ttsNow: { readyAt: 0, aheadOf: 0 }, Math, Date: { now: () => now.t } };
  vm.createContext(rc);
  vm.runInContext(fn('_ttsAheadDone'), rc);
  ok('no wait yet: the ring is empty', rc._ttsAheadDone() === 0);
  rc._ttsNow.aheadOf = 40; rc._ttsNow.readyAt = now.t + 40000;
  ok('...the wait just begun: still empty', rc._ttsAheadDone() === 0);
  now.t += 30000;
  ok('...three quarters of it gone: three quarters closed', Math.abs(rc._ttsAheadDone() - 0.75) < 1e-9);
  now.t += 20000;
  ok('...past the estimate: closed, never more', rc._ttsAheadDone() === 1);
}
ok('a voice that keeps up starts with its first chunk', ctx._ttsLeadEnd(lens(50), 0, { work: 0.5 / 14, audio: 1 / 14 }, 1) === 0);
ok('...and so does one not measured yet', ctx._ttsLeadEnd(lens(50), 0, { work: null, audio: 1 / 14 }, 1) === 0);
ctx._ttsVoices.timings = { kokoro: { rtf: 1.5, cps: 12 } };
ok('a voice\'s pace is what the server measured', Math.abs(ctx._ttsPace('kokoro').work - 0.125) < 1e-9 && Math.abs(ctx._ttsPace('kokoro').audio - 1 / 12) < 1e-9);
ok('...unmeasured, its work is unknown', ctx._ttsPace('piper').work === null && Math.abs(ctx._ttsPace('piper').audio - 1 / 14) < 1e-9);
ctx._ttsVoices.timings = {};


// What the server measured wins over this browser's own mark, at this speed.
ctx._ttsVoices.timings = { kokoro: { rtf: 0.3 }, piper: { rtf: 0.6 } };
ok('measured as keeping up: a browser\'s old slow mark no longer sends it last', engines('en') === '["kokoro","piper"]', engines('en'));
ctx._ttsRate = () => 2;
ok('at 2x the engine that cannot keep up reads last', engines('en') === '["kokoro","piper"]' && ctx._ttsTooSlow('piper') && !ctx._ttsTooSlow('kokoro'), engines('en'));
ctx._ttsVoices.timings = { kokoro: { rtf: 1.5 }, piper: { rtf: 0.3 } };
ok('...and a slow model is passed over before it says a word', engines('en') === '["piper","kokoro"]', engines('en'));
ctx._ttsVoices.timings = { kokoro: { rtf: 0.3, gaps: { '1': 0, '1.25': 0.2, '1.5': 2.4, '2': 9 } } };
ctx._ttsRate = () => 1.25;
ok('a tested reading\'s pauses decide: a short one still keeps up', ctx._ttsKeepsUp('kokoro', 1.25) === true);
ok('...a long one does not, though its average speed would', ctx._ttsKeepsUp('kokoro', 1.5) === false && 0.3 * 1.5 <= 0.8);
ok('a speed between two measured ones reads the next one up', ctx._ttsKeepsUp('kokoro', 1.2) === true && ctx._ttsKeepsUp('kokoro', 1.3) === false);
ok('...and past the fastest measured, the average speed decides', ctx._ttsKeepsUp('kokoro', 2.5) === true);
ctx._ttsRate = () => 1;
delete ctx._ttsVoices.timings;

// Each voice's one word under its name: the usual one until it was measured
// here, then from its first words, or that it cannot keep up at 1x.
vm.runInContext(['_voicePaceKey'].map(fn).join('\n') + '\n' + extract(/var _VOICE_PACES = [^\n]*/, '_VOICE_PACES'), ctx);
ctx._voicesHere = { timings: {
  piper: { first_s: 1.1, gaps: { '1': 0.2 } },
  kokoro: { first_s: 6.3, gaps: { '1': 4 } },
  espeak: { first_s: 0.03, gaps: { '1': 0 } },
} };
const pace = e => ctx._voicePaceKey(e);
ok('not measured yet: the word it usually earns', pace('say') === 'voices_speed_say', pace('say'));
ok('measured: quick first words and keeping up read "fast"', pace('piper') === 'voices_pace_fast', pace('piper'));
ok('...a few hundredths of a second, "instant"', pace('espeak') === 'voices_pace_instant', pace('espeak'));
ok('...one that pauses in a reading at 1x says it is too slow to read aloud', pace('kokoro') === 'voices_pace_behind', pace('kokoro'));
ok('this device\'s own voice, from what this browser timed', (store.zimi_tts_device_times = JSON.stringify({ first_s: 3, gaps: { '1': 0.3 } }), pace('device') === 'voices_pace_slow'), pace('device'));
delete ctx._voicesHere;
// Read aloud's own voice: what this browser timed counts too, so its speed
// menu can say which speeds pause.
store.zimi_tts_device_times = JSON.stringify({ first_s: 0.2, gaps: { '1': 0.1, '1.25': 0.1, '1.5': 0.8, '2': 0.8 } });
ok('this device\'s voice keeps up where its pauses are short', ctx._ttsKeepsUp('device', 1) === true);
ok('...and is too slow at a speed whose pauses are long', ctx._ttsKeepsUp('device', 1.5) === false);
delete store.zimi_tts_device_times;

ok('the button shows when only the server can speak', ctx._ttsCanSpeak() === true);
ctx._ttsVoices = { langs: {} };
ok('...and not when nothing can', ctx._ttsCanSpeak() === false);
ctx._TTS_AVAILABLE = true;
ok('...and when only the browser can', ctx._ttsCanSpeak() === true);

const url = ctx._ttsSpeakUrl('A & B?', 'eng', 'piper');
ok('a chunk is asked for as a sentence, in the voice\'s language code', url === '/dictionary/speak?kind=sentence&lang=en&engine=piper&text=A%20%26%20B%3F', url);

// ── a reading ─────────────────────────────────────────────────────────────
// A fake <audio> and clock: the test plays, ends and times out by hand.
const timers = [];
const fetched = [];
class FakeAudio {
  constructor() { this.paused = true; this.src = ''; this.played = []; }
  play() { this.played.push(this.src); return Promise.resolve(); }
  pause() { this.paused = true; }
  getAttribute(n) { return n === 'src' ? this.src : null; }
  removeAttribute() { this.src = ''; }
  load() {}
}
// A real <audio> rejects the play() still pending when its src changes
// (AbortError): that is the switch to the next engine, not a failure. Taken
// for one, the reading retried, cut off the voice it had just switched to, and
// fell to the browser's voice outside the tap, which iOS keeps silent.
class AbortingAudio extends FakeAudio {
  play() { const p = new Promise((res, rej) => { this.pending = rej; }); this.played.push(this.src); return p; }
  set src(v) { if (this.pending) { const rej = this.pending; this.pending = null; rej(Object.assign(new Error('interrupted'), { name: 'AbortError' })); } this._src = v; }
  get src() { return this._src || ''; }
}
function freshReading() {
  for (const k of Object.keys(store)) delete store[k];
  timers.length = 0; fetched.length = 0;
  const r = { speaking: null, device: null, along: [] };
  Object.assign(ctx, {
    _ttsAudio: new FakeAudio(), _ttsRun: 1,
    _TTS_SERVER_RETRY_MS: 2000, _TTS_START_WAIT_MS: 6000, _TTS_AHEAD: 2, _TTS_AHEAD_UNMEASURED: 1, _TTS_SETTLED_CHARS: 100,
    _TTS_START_MARGIN: 1.25, _TTS_START_WAIT_MAX_MS: 20000, _ttsVoices: null,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; },
    authedFetch: u => { fetched.push(u); return new Promise(() => {}); }, // never answers: the server is still saying it
    _ttsSetSpeaking: on => { r.speaking = on; },
    _ttsAlongAudio: (idx, audio) => { r.along.push([idx, audio.currentTime]); },
    _ttsAlongAt: () => {},
    _ttsNow: {}, _ttsBarSync: () => {}, _ttsRate: () => 1, _ttsPaused: false,
    _ttsSpeakDevice: (c, l, from) => { r.device = from; },
    _ttsHold() {}, _ttsAheadTick() {}, _ttsSpinTimer: 0,
  });
  return r;
}
vm.runInContext('var _ttsLetGo = null;\n' + fn('_ttsLetGoAll') + '\n' + fn('_ttsStop') + '\n' + fn('_ttsSpeakServer') + '\n' + fn('_ttsStartWait'), ctx);
const engineOf = u => (u.match(/engine=(\w+)/) || [])[1];
const textOf = u => decodeURIComponent((u.match(/text=([^&]*)$/) || [])[1] || '');
const chunks = ['one.', 'two.', 'three.'];

let r = freshReading();
let a = ctx._ttsAudio;
ctx._ttsSpeakServer(chunks, 'en', ['kokoro', 'piper'], 1);
ok('the first chunk plays in the first engine', engineOf(a.src) === 'kokoro' && textOf(a.src) === 'one.', a.src);
a.paused = true;
timers.filter(Boolean).pop().f(); // six seconds and still silent
ok('silent too long: the next engine says it', engineOf(a.src) === 'piper' && textOf(a.src) === 'one.', a.src);
ok('...and the slow one is remembered', slowOnes() === '["kokoro"]', store.zimi_tts_slow);
ctx._ttsVoices = { timings: { piper: { rtf: 0.1 } } }; // Clear's pace is known here
a.paused = false; a.onplaying();
ctx._ttsVoices = null;
ok('while a chunk plays the next two are asked for, in the engine now reading', fetched.length === 2 && fetched.every(u => engineOf(u) === 'piper') && fetched.map(textOf).join() === 'two.,three.', fetched.join(' '));
a.onended(); a.onplaying(); a.onended();
ok('chunks play in turn', textOf(a.src) === 'three.', a.src);
a.onplaying(); a.onended();
ok('the last chunk ends the reading', r.speaking === false);

// A voice is given the start this server measured for it after a rest: a
// cold Clear took 7.6 s on the NAS, and at a flat 6 s Automatic read the
// whole article in Basic (Eric, 2026-10-20).
r = freshReading();
a = ctx._ttsAudio;
ctx._ttsVoices = { timings: { piper: { cold_s: 7.6 } } };
ctx._ttsSpeakServer(chunks, 'en', ['piper', 'espeak'], 1);
ok('a voice slow to start after a rest is waited for as long as it was measured taking', timers.filter(Boolean).pop().ms === 9500, timers.filter(Boolean).map(x => x.ms));
a.paused = false; a.onplaying(); a.onended();
ok('...and once it has spoken, the usual wait again', timers.filter(Boolean).pop().ms === 6000, timers.filter(Boolean).map(x => x.ms));
ctx._ttsVoices = { timings: { piper: { cold_s: 60 } } };
ok('...never more than twenty seconds', ctx._ttsStartWait('piper') === 20000);
ctx._ttsVoices = null;
ok('...and unmeasured, six', ctx._ttsStartWait('piper') === 6000);

const sentence = 'Epistemology is the branch of philosophy that studies knowledge, how we come to know things, and what justifies a belief.';
r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer([sentence, 'two.', 'three.'], 'en', ['kokoro', 'piper'], 1);
a.paused = false; a.onplaying(); // a sentence is heard in Natural
a.onended(); // "two." was asked for and is not back yet
ok('a late chunk after words were heard keeps the voice', engineOf(a.src) === 'kokoro' && textOf(a.src) === 'two.', a.src);
ok('...and a short wait is not slow (a heading is over in a second)', !store.zimi_tts_slow, store.zimi_tts_slow);
a.paused = true;
timers.filter(Boolean).pop().f(); // and still silent six seconds later
ok('...still the same voice, no switch mid-article', engineOf(a.src) === 'kokoro' && textOf(a.src) === 'two.', a.src);
ok('...and six silent seconds mark it slow, for the next reading', slowOnes() === '["kokoro"]', store.zimi_tts_slow);

// #121: on a mini PC with no speed measured yet, Natural said the title in
// 4 s, then nothing for 36 s, then the browser's voice read the article.
r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer(['Epistemology.', sentence, 'three.'], 'en', ['kokoro', 'piper'], 1);
a.paused = false; a.onplaying(); // the title is heard
ok('#121: a voice whose pace is unmeasured is asked one chunk ahead, not three', fetched.length === 1 && textOf(fetched[0]) === sentence, fetched.map(textOf).join(' | '));
a.onended(); a.paused = true;
timers.filter(Boolean).pop().f(); // six silent seconds after the title
ok('#121: silent after only a title, the next engine says the rest', engineOf(a.src) === 'piper' && textOf(a.src) === sentence, a.src);
ok('...and Natural is remembered as slow', slowOnes() === '["kokoro"]', store.zimi_tts_slow);

r = freshReading();
a = ctx._ttsAudio;
let aborted = 0;
ctx.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; aborted++; } };
ctx._ttsSpeakServer(['Epistemology.', sentence, 'three.'], 'en', ['kokoro', 'piper'], 1);
a.paused = false; a.onplaying(); a.onended(); a.paused = true;
timers.filter(Boolean).pop().f();
ok('#121: giving way calls off what was asked of the slow engine', aborted === 1);
delete ctx.AbortController;

r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer(['Epistemology.', sentence, 'three.'], 'en', ['kokoro', 'piper'], 1);
a.paused = false; a.onplaying(); a.onended();
a.onerror(); // the server was busy for 30 s: 503
timers.filter(t => t && t.ms === 2000).pop().f();
a.onerror(); // and again
ok('#121: a voice that failed twice gives way to the next server voice, not the browser', engineOf(a.src) === 'piper' && textOf(a.src) === sentence && r.device === null, a.src + ' ' + r.device);
a.onerror();
timers.filter(t => t && t.ms === 2000).pop().f();
a.onerror();
ok('...and only when the last one fails does the browser read', r.device === 1, String(r.device));

r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer(chunks, 'en', ['kokoro', 'piper'], 1);
ctx._ttsPaused = true; // Pause before the first sound
a.paused = true;
timers.filter(Boolean).pop().f();
ok('paused is not slow: the engine is kept', engineOf(a.src) === 'kokoro' && !store.zimi_tts_slow, a.src);
ctx._ttsPaused = false;

r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer(chunks, 'en', ['piper'], 1);
ok('one engine: no switch is armed', timers.filter(Boolean).length === 0);
a.onplaying();
a.onended(); // "two." was asked for and has not come back: the only engine waits for it
ok('...it waits for a late chunk', engineOf(a.src) === 'piper' && textOf(a.src) === 'two.');
a.onerror();
ok('a failed chunk is tried again after a moment', timers.filter(Boolean).some(t => t.ms === 2000));
timers.filter(t => t && t.ms === 2000).pop().f();
a.onerror();
ok('twice failed: the browser reads the rest, from that chunk', r.device === 1, String(r.device));

r = freshReading();
a = ctx._ttsAudio;
ctx._ttsSpeakServer(chunks, 'en', ['piper'], 1);
ctx._ttsRun = 2; // Stop, or another start
a.onplaying(); a.onended();
ok('a stopped reading does nothing more', fetched.length === 0 && textOf(a.src) === 'one.' && r.speaking === null);

// ── a: voices are asked for on intent, not at page load ──────────────────
ok('nothing asks for the voice list when the page loads', !/^_ttsLoadVoices\(\);/m.test(src));
ok('opening the ... menu is one intent', /function _toggleTopbarMenu[\s\S]*?_ttsPrepare\(\)/.test(src));
ok('Reader View opening is the other, for someone who read aloud lately',
  /function _readerViewApply[\s\S]*?if \(_ttsUsedRecently\(\)\) _ttsPrepare\(\)/.test(src));
ok('speaking does not ask again on every start', !/_ttsLoadVoices\(\)/.test(fn('_ttsSpeak')));

const intent = { loads: 0, calls: [], now: 1e12, answer: null, rebuilt: 0, topbar: 0, readerOpen: true, speakingOn: true, lang: 'en', posts: [] };
Object.assign(ctx, {
  Date: { now: () => intent.now },
  Promise,
  readerOpen: true,
  _ttsVoices: null,
  _ttsVoicesAt: 0,
  _ttsVoicesBusy: null,
  _ttsWarmed: {},
  _TTS_VOICES_FRESH_MS: 60000,
  _TTS_RECENT_MS: 7 * 86400000,
  _TTS_WARM_ENGINES: ['kokoro', 'piper'],
  updateTopbar: () => { intent.topbar++; },
  _bookReadSync: () => {},
  _rebuildTopbarMenu: () => { intent.rebuilt++; },
  _speakingOn: () => intent.speakingOn,
  _ttsFrameDoc: () => ({}),
  _ttsLang: () => intent.lang,
  // readaloud.js, fetched: counted, never fetched here.
  _ttsLoad: () => { intent.loads++; return Promise.resolve(true); },
  authedFetch: (u, o) => {
    if (o && o.method === 'POST') { intent.posts.push([u, JSON.parse(o.body)]); return Promise.resolve({ ok: true }); }
    intent.calls.push(u);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(intent.answer) });
  },
});
Object.assign(ctx.SK, { TTS_LAST_USE: 'zimi_tts_last_use', TTS_SUGGESTED: 'zimi_tts_suggested' });
vm.runInContext(['_ttsLoadVoices', '_ttsUsedRecently', '_ttsPrepare', '_ttsWarm'].map(fn).join('\n') + '\n' + extract(/function _ttsOffered\(\) \{[^\n]*\n/, '_ttsOffered'), ctx);
const reset = () => { for (const k of Object.keys(store)) delete store[k]; Object.assign(intent, { loads: 0, calls: [], posts: [], rebuilt: 0, topbar: 0, speakingOn: true }); ctx._ttsVoices = null; ctx._ttsVoicesAt = 0; ctx._ttsVoicesBusy = null; ctx._ttsWarmed = {}; };
const row = { engine: 'piper', engines: ['piper'] };
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  reset();
  intent.answer = { langs: { en: row } };
  ok('before any intent no request has been made', intent.calls.length === 0);
  ctx._ttsPrepare(); await tick(); await tick();
  ok('the menu opening asks for the list once', intent.calls.length === 1 && intent.calls[0] === '/dictionary/voices', intent.calls.join());
  ok('...and the menu is rebuilt when it arrives, for the Read aloud row', intent.rebuilt === 1 && ctx._ttsVoices && ctx._ttsServerSays());
  ctx._ttsPrepare(); await tick();
  ok('a second open inside a minute asks nothing', intent.calls.length === 1);
  intent.now += 61000;
  ctx._ttsPrepare(); await tick();
  ok('later it asks again (a voice downloaded since is found)', intent.calls.length === 2);
  ok('someone who never read aloud: no warm', intent.posts.length === 0);
  ok('...and the reading itself is never fetched for them', intent.loads === 0);

  reset();
  intent.answer = { langs: { en: row } };
  store.zimi_tts_last_use = JSON.stringify(intent.now - 86400000);
  ctx._ttsPrepare(); await tick(); await tick();
  ok('read aloud yesterday: the article\'s voice is warmed', intent.posts.length === 1 && intent.posts[0][0] === '/dictionary/voices/warm' && JSON.stringify(intent.posts[0][1].langs) === '["en"]', JSON.stringify(intent.posts));
  ctx._ttsPrepare(); await tick(); await tick();
  ok('...once per language and voice', intent.posts.length === 1);
  ok('someone who reads aloud has the reading fetched with the article', intent.loads >= 1);

  reset();
  intent.answer = { langs: { en: row } };
  store.zimi_tts_last_use = JSON.stringify(intent.now - 8 * 86400000);
  ctx._ttsPrepare(); await tick(); await tick();
  ok('last read aloud over a week ago: no warm', intent.posts.length === 0);

  reset();
  intent.answer = { langs: { en: { engine: 'piper', engines: ['piper', 'kokoro'] } } };
  store.zimi_tts_last_use = JSON.stringify(intent.now);
  prefs = { voice: 'kokoro', off: [] };
  ctx._ttsPrepare(); await tick(); await tick();
  ok('the voice that will read is the one warmed, a chosen one too', intent.posts.length === 1 && intent.posts[0][1].engine === 'kokoro', JSON.stringify(intent.posts));
  prefs = { voice: '', off: [] };

  reset();
  intent.speakingOn = false;
  ctx._ttsPrepare(); await tick();
  ok('Speaking off: nothing is asked', intent.calls.length === 0);

  // ── b: a chosen voice reads alone, and is offered a faster one ─────────
  let r2 = freshReading();
  let au = ctx._ttsAudio;
  const told = [];
  ctx._ttsSpeakServer(chunks, 'en', ['kokoro'], 1, e => told.push(e));
  ok('a chosen voice still reads first', engineOf(au.src) === 'kokoro' && textOf(au.src) === 'one.');
  au.paused = true;
  timers.filter(Boolean).pop().f(); // six seconds and still silent
  ok('too slow to start: it keeps reading, no switch', engineOf(au.src) === 'kokoro' && textOf(au.src) === 'one.', au.src);
  ok('...is not marked slow', store.zimi_tts_slow === undefined, store.zimi_tts_slow);
  ok('...and the person is told once', told.length === 1 && told[0] === 'kokoro', JSON.stringify(told));
  au.paused = false; au.onplaying(); au.onended();
  ok('a chunk not ready in time is told once more at most', told.length === 1, JSON.stringify(told));

  r2 = freshReading();
  au = ctx._ttsAudio;
  const told2 = [];
  ctx._ttsSpeakServer(chunks, 'en', ['kokoro'], 1, e => told2.push(e));
  au.onplaying(); // chunk 1 plays; two. is asked for and does not come
  au.onended();
  ok('the next chunk a moment late on a chosen voice: nothing is said, it waits', told2.length === 0 && textOf(au.src) === 'two.' && engineOf(au.src) === 'kokoro');
  au.paused = true;
  timers.filter(Boolean).pop().f(); // six silent seconds
  ok('...six silent seconds: offered, still reading it', told2.length === 1 && textOf(au.src) === 'two.' && engineOf(au.src) === 'kokoro' && store.zimi_tts_slow === undefined, JSON.stringify(told2));

  r2 = freshReading();
  au = ctx._ttsAudio;
  ctx._ttsSpeakServer(chunks, 'en', ['kokoro', 'piper'], 1, null);
  au.paused = true;
  timers.filter(Boolean).pop().f();
  ok('Automatic keeps the switch: the next engine says it', engineOf(au.src) === 'piper' && slowOnes() === '["kokoro"]', au.src);

  // the offer itself
  const toasts = [];
  Object.assign(ctx, {
    _showToast: (msg, ms, undo, label) => toasts.push({ msg, ms, undo, label }),
    t: (k, v) => k + (v ? JSON.stringify(v) : ''),
    _voiceEngineName: e => e.toUpperCase(),
    _TTS_SUGGEST_MS: 9000,
    _setVoicePrefs: ch => { prefs = Object.assign({}, prefs, ch); },
  });
  vm.runInContext(['_ttsFasterThan', '_ttsSuggestFaster'].map(fn).join('\n'), ctx);
  for (const k of Object.keys(store)) delete store[k];
  ctx._ttsVoices = { langs: { en: { engine: 'kokoro', engines: ['kokoro', 'piper'] } } };
  prefs = { voice: 'kokoro', off: [] };
  ctx._ttsSuggestFaster('en', 'kokoro');
  ok('a quiet offer: one line, with a button naming the faster engine', toasts.length === 1 && /KOKORO/.test(toasts[0].msg) && /PIPER/.test(toasts[0].msg) && /PIPER/.test(toasts[0].label), JSON.stringify(toasts));
  toasts[0].undo();
  ok('the button switches Read aloud\'s voice, not the default', prefs.read === 'piper' && prefs.voice === 'kokoro', JSON.stringify(prefs));
  ctx._ttsSuggestFaster('en', 'kokoro');
  ok('once per engine: never nagged again', toasts.length === 1);
  for (const k of Object.keys(store)) delete store[k];
  ctx._ttsVoices = { langs: { en: { engine: 'kokoro', engines: ['kokoro'] } } };
  ctx._ttsSuggestFaster('en', 'kokoro');
  ok('nothing faster to offer: nothing said', toasts.length === 1);

  // A speed picked mid-reading that the voice pauses at (Eric, 2026-10-20:
  // "Let me still select 2x and then pop to a faster one?").
  const restarts = [];
  let rate = 1;
  Object.assign(ctx, { _ttsMenuOpen: '', _ttsAudio: null, _ttsBarSync() {}, _ttsRateLabel: r => r + 'x',
    _ttsSpeak: at => restarts.push(at), _ttsPickVoice: e => restarts.push('pick:' + e) });
  ctx._ttsRate = () => rate;
  ctx._setStorageJSON = (k, v) => { store[k] = JSON.stringify(v); if (k === 'zimi_tts_rate') rate = v; };
  ctx.SK.TTS_RATE = 'zimi_tts_rate';
  Object.assign(ctx, { _ttsSpeaking: true, _ttsSpeedTimer: 0, _ttsSliding: false, _DEVICE_VOICE: 'device', _TTS_RATE_STEP: 0.05, _TTS_RATE_MIN: 0.5, _TTS_RATE_MAX: 3,
    _TTS_RATE_STOPS: [1, 1.5, 2], _TTS_RATE_SNAP: 0.05, _TTS_SPEED_SETTLE_MS: 700,
    setTimeout: f => { ctx._settle = f; return 1; }, clearTimeout: () => { ctx._settle = null; },
    document: { querySelectorAll: () => [] } });
  vm.runInContext(['_ttsPickSpeed', '_ttsApplySpeed', '_ttsSpeedSettled', '_ttsSlideSpeed', '_ttsSpeedChanged', '_ttsSnapRate', '_ttsRateClamp', '_ttsVoiceLabel', '_ttsAheadShown'].map(fn).join('\n'), ctx);
  ctx._ttsVoices = { langs: { en: { engine: 'kokoro', engines: ['kokoro', 'piper'] } },
    timings: { kokoro: { gaps: { '1': 0, '1.25': 0, '1.5': 3, '2': 6 } }, piper: { gaps: { '1': 0, '1.25': 0, '1.5': 0, '2': 0 } } } };
  ctx._ttsNow = { engine: 'kokoro', lang: 'en', at: 7 };
  prefs = { voice: '', off: [] };
  toasts.length = 0;
  ctx._ttsPickSpeed(1.25);
  ok('a speed the voice keeps up at: it reads on as it was', restarts.length === 0 && toasts.length === 0);
  ctx._ttsPickSpeed(2);
  ok('Automatic, at a speed its voice pauses at: the reading goes on from its sentence in one that keeps up', restarts.join() === '7' && toasts.length === 0, restarts.join());
  restarts.length = 0;
  prefs = { voice: '', read: 'kokoro', off: [] };
  ctx._ttsPickSpeed(2);
  ok('a voice picked by name keeps reading at any speed, and one that keeps up is offered', restarts.length === 0 && toasts.length === 1 && /tts_slow_at/.test(toasts[0].msg) && /PIPER/.test(toasts[0].label), JSON.stringify(toasts));
  toasts[0].undo();
  ok('...taking it switches now, from the sentence it is at', restarts.join() === 'pick:piper', restarts.join());
  ok('...and the bar names the voice alone: (Too slow) is for the voice list, where there is room', ctx._ttsVoiceLabel() === 'KOKORO', ctx._ttsVoiceLabel());
  rate = 1;
  ok('...until a speed it keeps up at', ctx._ttsVoiceLabel() === 'KOKORO', ctx._ttsVoiceLabel());

  // The slider (Eric, 2026-10-20: "read faster and slower than our options and in between").
  restarts.length = 0; toasts.length = 0; prefs = { voice: '', off: [] };
  const slider = v => { const el = { value: String(v), setAttribute() {} }; ctx._ttsSlideSpeed(el); return el; };
  rate = 1;
  slider(1.35);
  ok('the slider reaches a speed between the marks', rate === 1.35, rate);
  ok('...and asks nothing of the voice while it moves', restarts.length === 0 && !ctx._settle);
  ctx._ttsSpeedChanged();
  ctx._settle();
  ok('...once it settles: a speed this voice pauses at goes on in one that keeps up', restarts.join() === '7', restarts.join());
  restarts.length = 0;
  ctx._ttsSliding = true;
  let el = slider(1.45);
  ok('under a finger, a speed near a stop lands on it', rate === 1.5 && String(el.value) === '1.5', rate + ' ' + el.value);
  slider(1.75);
  ok('...and one between stops stays where it is', rate === 1.75, rate);
  ctx._ttsSliding = false;
  slider(1.45);
  ok('keys reach every step, stops or not', rate === 1.45, rate);
  slider(9); ok('three times is the fastest', rate === 3, rate);
  slider(0.1); ok('half is the slowest', rate === 0.5, rate);
  ctx._ttsSpeedChanged();
  ctx._ttsSpeaking = false; ctx._settle();
  ok('stopped before the speed settled: nothing starts again', restarts.length === 0, restarts.join());
  ctx._ttsSpeaking = true;
  ok('a stored speed off the steps comes back on one', ctx._ttsRateClamp(1.333) === 1.35 && ctx._ttsRateClamp(9) === 3 && ctx._ttsRateClamp('x') === 1);
  rate = 1;
  delete ctx._ttsVoices.timings;
  prefs = { voice: '', off: [] };

  // ── c: Read aloud's own voice ──────────────────────────────────────────
  prefs = { voice: 'kokoro', off: [] };
  ok('Automatic Read aloud follows the default voice', ctx._ttsChosenVoice() === 'kokoro');
  prefs = { voice: 'kokoro', read: 'piper', off: [] };
  ok('Read aloud\'s own voice wins over the default', ctx._ttsChosenVoice() === 'piper');
  ctx._ttsVoices = { langs: { en: { engine: 'kokoro', engines: ['kokoro', 'piper'] } } };
  ok('...and reads alone', engines('en') === '["piper"]', engines('en'));
  prefs = { voice: 'piper', read: 'device', off: [] };
  ok('Read aloud on Device while the default is a server voice: the browser reads', engines('en') === '[]');
  prefs = { voice: '', read: 'piper', off: ['piper'] };
  ok('a voice Settings turned off is not read with, whatever was picked', engines('en') === '["kokoro"]', engines('en'));

  // the preference itself: kept, shown, saved
  const sandbox = { SK: { VOICE_PREFS: 'zimi_voice_prefs' }, _VOICE_ENGINES: ['kokoro', 'piper', 'say', 'espeak', 'device'], _getStorageJSON: (k, fb) => (k in store ? JSON.parse(store[k]) : fb), _setStorageJSON: (k, v) => { store[k] = JSON.stringify(v); }, localStorage: { removeItem: k => delete store[k] }, _prefWrite: (k, v) => { if (v == null) delete store[k]; else store[k] = v; }, _voicesTellDictionary() {}, _paintVoices() {}, _voicesHere: null, _voiceTimings: () => ({}), _ttsKeepsUp: e => (e === 'kokoro' ? false : null), _ttsRate: () => 1, esc: x => x, escAttr: x => x, tH: k => k, t: k => k, _voiceEngineName: e => e };
  vm.createContext(sandbox);
  vm.runInContext(['_voicePrefs', '_setVoicePrefs', '_voicePickHtml', '_voiceReadHtml', '_voiceDefaultHtml', '_voiceSwitchRow'].map(fn).join('\n'), sandbox);
  for (const k of Object.keys(store)) delete store[k];
  ok('no Read aloud voice by default (Automatic)', sandbox._voicePrefs().read === undefined);
  sandbox._setVoicePrefs({ read: 'piper' });
  ok('a pick is saved beside the others', JSON.parse(store.zimi_voice_prefs).read === 'piper' && sandbox._voicePrefs().read === 'piper', store.zimi_voice_prefs);
  sandbox._setVoicePrefs({ voice: 'kokoro' });
  ok('the default voice does not lose it', sandbox._voicePrefs().read === 'piper' && sandbox._voicePrefs().voice === 'kokoro');
  sandbox._setVoicePrefs({ read: '' });
  ok('Automatic again forgets it, and an empty preference is not kept', sandbox._voicePrefs().read === undefined && JSON.parse(store.zimi_voice_prefs).read === undefined);
  sandbox._setVoicePrefs({ voice: '' });
  ok('nothing left to say: the key goes', !('zimi_voice_prefs' in store));
  sandbox._setVoicePrefs({ read: 'piper', off: ['piper'] });
  ok('a voice turned off cannot stay Read aloud\'s', sandbox._voicePrefs().read === undefined);
  const html = sandbox._voiceReadHtml([{ engine: 'kokoro' }, { engine: 'piper' }]);
  ok('Settings > Voices has a Read aloud row: Automatic and each voice', /tts_speak/.test(html) && (html.match(/role="radio"/g) || []).length === 3 && /voice-read/.test(html) && /read/.test(html), html.slice(0, 120));
  ok('...a voice measured too slow at Read aloud\'s speed is dimmed and says so', /data-slow title="voices_pace_behind"[^>]*>[\s\S]*?<span>kokoro/.test(html) && (html.match(/data-slow/g) || []).length === 1, html);
  const one = sandbox._voiceReadHtml([{ engine: 'piper' }]);
  ok('...the voice row hidden with only one voice to choose', !/tts_speak/.test(one) && !/role="radio"/.test(one), one);
  ok('Patience is always there, off by default', /id="voices-wait"/.test(html) && !/id="voices-wait"[^>]* checked onchange/.test(html), html);
  ok('...with one voice, and when every voice keeps up: never a hidden switch', /voices-wait/.test(one) && /voices-wait/.test(sandbox._voiceReadHtml([{ engine: 'piper' }, { engine: 'espeak' }])));
  sandbox._setVoicePrefs({ wait: true });
  const waiting = sandbox._voiceReadHtml([{ engine: 'kokoro' }, { engine: 'piper' }]);
  ok('...on, it is kept and shown on', sandbox._voicePrefs().wait === true && /id="voices-wait"[^>]* checked onchange/.test(waiting), store.zimi_voice_prefs);
  ok('...and a slow voice is no longer dimmed: it is waited for', !/data-slow/.test(waiting));
  sandbox._setVoicePrefs({ wait: false });
  ok('...off again, nothing is kept for it', sandbox._voicePrefs().wait === undefined && !/wait/.test(store.zimi_voice_prefs || ''));
  ok('...and the default row is as it was', /voices_default/.test(sandbox._voiceDefaultHtml([{ engine: 'kokoro' }, { engine: 'piper' }])));

  // The switch's AbortError settles on a later tick.
  r = freshReading();
  a = ctx._ttsAudio = new AbortingAudio();
  ctx._ttsSpeakServer(chunks, 'en', ['kokoro', 'piper'], 1);
  timers.filter(Boolean).pop().f(); // kokoro silent for six seconds: piper says it
  await new Promise(res => setImmediate(res));
  ok('switching engines is not a failure: no retry, no browser voice',
    !timers.some(t => t && t.ms === 2000) && r.device === null && engineOf(a.src) === 'piper',
    JSON.stringify({ device: r.device, retry: timers.filter(t => t && t.ms === 2000).length, src: engineOf(a.src) }));


  // ── read along: the text, its sentences, where the voice is, following ────
  {
    const BLOCK = ' ';
    const ax = { Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, Map, isFinite, window: { matchMedia: () => ({ matches: false }) },
      _TTS_CHUNK_MAX: 240, _TTS_FIRST_CHUNK_MAX: 120, _BOOK_EDGE: 0.3, _nightRedOn: () => false, _ttsBarSync: () => {},
      _langPrimary: l => String(l || '').split(/[-_]/)[0].toLowerCase(), _ttsLang: () => 'en' };
    vm.createContext(ax);
    vm.runInContext(extract(/var _TTS_BLOCK = [^\n]*\n/, '_TTS_BLOCK') + extract(/var _TTS_ABBREVS[\s\S]*?\nfunction _ttsSentenceSpans[\s\S]*?\n}\n/, 'the sentence splitter') +
      extract(/var _TTS_SKIP_TAGS[\s\S]*?var _ttsRead = null;/, 'the read-along constants'), ax);
    vm.runInContext(['_ttsPlanChunks', '_ttsReadModel', '_ttsPieceAt', '_ttsRange', '_ttsOffsetOf', '_ttsSelectedSpan', '_ttsSpanAtChar',
      '_ttsSentenceAt', '_ttsScrollBy', '_ttsOnText', '_ttsMakePlan', '_ttsPlanFrom', '_ttsHlOk', '_ttsPaint', '_ttsAlongAt', '_ttsAlongAudio', '_ttsAlongChar',
      '_scrollerOf', '_ttsFollow', '_ttsLose', '_ttsFollowResume', '_ttsTap', '_ttsStep', '_ttsBack', '_ttsAlongBegin', '_ttsAlongEnd'].map(fn).join('\n'), ax);

    // A DOM of just what the reading looks at: elements with a display, text nodes, document order.
    const BLOCKS = ['div', 'p', 'h1', 'h2', 'ul', 'li', 'main', 'article', 'section', 'body'];
    let order = 0;
    function node(spec, parent) {
      if (typeof spec === 'string') { const t = { nodeType: 3, data: spec, parentNode: parent, parentElement: parent, order: order++ }; t.contains = n => n === t; t.compareDocumentPosition = n => (n.order > t.order ? 4 : 2); return t; }
      const [tag, attrs, ...kids] = spec;
      const el = { nodeType: 1, localName: tag, parentNode: parent, parentElement: parent, order: order++, classes: attrs.cls || [], style: attrs.style || {}, childNodes: [] };
      el.classList = { contains: c => el.classes.includes(c) };
      el.className = el.classes.join(' ');
      Object.defineProperty(el, 'textContent', { get: () => (function t(n) { return n.nodeType === 3 ? n.data : (n.childNodes || []).map(t).join(''); })(el) });
      el.tagName = tag.toUpperCase();
      el.querySelector = t => { const find = e => { for (const k of e.childNodes || []) { if (k.nodeType === 1 && (k.localName === t || k.matches(t))) return k; const d = k.nodeType === 1 && find(k); if (d) return d; } return null; }; return find(el); };
      el.matches = sel => sel.split(',').some(x => { const [t, c] = x.trim().split('.'); return (!t || t === tag) && (!c || el.classes.includes(c)); });
      el.contains = n => { for (let x = n; x; x = x.parentNode) if (x === el) return true; return false; };
      el.compareDocumentPosition = n => (n.order > el.order ? 4 | (el.contains(n) ? 16 : 0) : 2);
      kids.forEach(k => el.childNodes.push(node(k, el)));
      el.firstChild = el.childNodes[0] || null;
      el.childNodes.forEach((k, i) => { k.nextSibling = el.childNodes[i + 1] || null; k.previousElementSibling = el.childNodes.slice(0, i).reverse().find(x => x.nodeType === 1) || null; });
      return el;
    }
    const textNode = (root, s) => { let hit; (function w(n) { if (n.nodeType === 3 && n.data.indexOf(s) >= 0 && !hit) hit = n; (n.childNodes || []).forEach(w); })(root); return hit; };
    function mkDoc(rootSpec, sel) {
      order = 0;
      const main = node(rootSpec, null);
      const doc = { addEventListener() {}, removeEventListener() {}, main, documentElement: { classList: { contains: () => false, toggle() {}, add(c) { doc.on = c; }, remove(c) { if (doc.on === c) doc.on = null; } } }, head: { appendChild() {} }, getElementById: () => null, createElement: () => ({}),
        createRange: () => ({ setStart(n, o) { this.startContainer = n; this.startOffset = o; }, setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
          getBoundingClientRect() { return doc.rect(this); }, getClientRects() { return [doc.rect(this)]; } }),
        rect: () => ({ top: 100, bottom: 120, left: 10, right: 90, width: 80, height: 20 }) };
      doc.defaultView = {
        getComputedStyle: el => ({ display: el.style.display || (BLOCKS.includes(el.localName) ? 'block' : 'inline'), visibility: el.style.visibility || 'visible', overflowY: 'visible' }),
        getSelection: () => sel || { isCollapsed: true, rangeCount: 0 }, innerHeight: 800, innerWidth: 400, scrollBy(o) { this.scrolled = o; },
        CSS: { highlights: new Map() }, Highlight: class { constructor() { this.s = []; this.gone = 0; } add(r) { this.s.push(r); } delete(r) { const i = this.s.indexOf(r); if (i >= 0) { this.s.splice(i, 1); this.gone++; } return i >= 0; } [Symbol.iterator]() { return this.s.slice()[Symbol.iterator](); } },
      };
      doc.defaultView.document = doc;
      return doc;
    }
    const article = ['main', {}, ['h1', {}, 'Tides'], ['p', {}, 'Hello ', ['b', {}, 'big'], ' world. Dr. Smith paid 3.5 dollars. Next one.'],
      ['div', { style: { display: 'none' } }, 'HIDDEN TEXT'], ['script', {}, 'var s = 1;'], ['div', { style: { visibility: 'hidden' } }, 'INVISIBLE'],
      ['ul', {}, ['li', {}, 'One'], ['li', {}, 'Two']], ['p', {}, 'A', ['br', {}], 'B'], ['section', { cls: ['zb-sec'], style: { display: 'none' } }, ['p', {}, 'Later page.']]];
    const doc = mkDoc(article);
    const model = ax._ttsReadModel(doc, doc.main);
    const flat = model.text.replace(new RegExp(BLOCK, 'g'), '|').replace(/\|$/, '');
    ok('the read text is the article\'s own text nodes, a block mark between blocks', flat === 'Tides|Hello big world. Dr. Smith paid 3.5 dollars. Next one.|One|Two|A|B|Later page.', flat);
    ok('no hidden, invisible or script text; a book\'s other pages still are read', !/HIDDEN|INVISIBLE|var s/.test(model.text) && /Later page/.test(model.text));
    const wiki = mkDoc(['main', {}, ['div', { cls: ['hatnote'] }, 'For the other pope, see X.'], ['table', {}, ['tr', {}, ['td', {}, 'Born']]],
      ['p', {}, 'John was born in Antioch', ['sup', { cls: ['reference'] }, '[3]'], ' and was of Syrian origin.', ['sup', { cls: ['reference'] }, '[4]'], ' He was named legate.']]);
    const wikiText = ax._ttsReadModel(wiki, wiki.main).text.replace(new RegExp(BLOCK, 'g'), '|');
    ok('no citation marks, hatnote or infobox: the prose, sentence by sentence', wikiText === 'John was born in Antioch and was of Syrian origin. He was named legate.|', wikiText);
    const facts2 = mkDoc(['main', {}, ['details', { cls: ['zw-facts'] }, ['summary', {}, 'Quick facts'], ['table', { cls: ['infobox'] }, ['tr', {}, ['td', {}, 'Born']]]], ['p', {}, 'Prose.']]);
    const factsText = ax._ttsReadModel(facts2, facts2.main).text.replace(new RegExp(BLOCK, 'g'), '|');
    ok('Zimipedia\'s Quick facts label is not read with the article', factsText === 'Prose.|', factsText);
    // Page chrome, label and value, and a closed panel (the World Factbook, 2026-10-25: "very rough").
    const model_of = (spec) => { const d = mkDoc(spec); return ax._ttsReadModel(d, d.main).text.replace(new RegExp(BLOCK, 'g'), '|'); };
    ok('navigation, menus, buttons, a tooltip\'s glossary and screen-reader labels are not read',
      model_of(['main', {}, ['nav', {}, ['ul', {}, ['li', {}, 'ABOUT']]], ['div', { cls: ['site-menu'] }, 'Pick a country'], ['div', {}, ['button', {}, 'Show'], ['span', { cls: ['sr-only'] }, 'Panel - Collapsed'],
        ['span', { cls: ['tooltip-content'] }, 'A long glossary entry.'], 'Mali is in Africa.']]) === 'Mali is in Africa.|');
    ok('a label and its value in the next block are one sentence; a long lead-in colon keeps its stop',
      model_of(['main', {}, ['div', {}, 'Area:'], ['div', {}, ['span', {}, 'total: '], ['span', {}, '1,240,192 sq km']], ['p', {}, 'It has the following, in this long line that goes on past the label limit of sixty characters:'], ['p', {}, 'one']]) ===
      'Area: total: 1,240,192 sq km|It has the following, in this long line that goes on past the label limit of sixty characters:|one|');
    ok('a closed panel after its heading is read; a hidden block with no heading is not',
      model_of(['main', {}, ['ul', {}, ['li', { cls: ['tabHead'] }, 'Geography'], ['li', { style: { display: 'none' } }, ['p', {}, 'Landlocked.']]], ['p', {}, 'Intro.'], ['div', { style: { display: 'none' } }, 'Menu stuff']]) === 'Geography|Landlocked.|Intro.|');
    ok('Wikipedia, Stack Exchange and Gutenberg prose is read as it was (a poem in a <pre> too); votes, tags and code are not',
      model_of(['main', {}, ['h2', {}, 'See also'], ['ul', {}, ['li', {}, ['a', {}, 'Tides']], ['li', {}, ['a', {}, 'Moons']]],
        ['div', { cls: ['post-text'] }, ['p', {}, 'Use a loop.'], ['pre', {}, 'a poem line'], ['pre', {}, 'x = [1, 2]'], ['pre', {}, 'map(callbackFn)'], ['details', { cls: ['baseline-indicator'] }, 'Baseline Widely available'], ['p', {}, 'That is all.']], ['button', {}, 'Share'],
        ['div', { cls: ['votecell'] }, '16'], ['div', { cls: ['post-taglist'] }, 'sleep'],
        ['p', { cls: ['chapter'] }, 'CHAPTER I. Down the Rabbit-Hole', ['span', { cls: ['pagenum'] }, '[12]']], ['div', { cls: ['transnote'] }, 'Typos fixed.'], ['ul', { cls: ['toc'] }, ['li', {}, 'Chapter I']]]) === 'See also|Tides|Moons|Use a loop.|a poem line|That is all.|CHAPTER I. Down the Rabbit-Hole|');
    const laid = mkDoc(['main', {}, ['table', {}, ['tr', {}, ['td', {}, ['p', {}, 'The whole page sits in a table.']]]]]);
    const laidText = ax._ttsReadModel(laid, laid.main).text.replace(new RegExp(BLOCK, 'g'), '|');
    ok('a table that holds paragraphs is the page\'s layout, and is read', laidText === 'The whole page sits in a table.|', laidText);
    order = 0; // back to the article's own document order
    const bigAt = model.text.indexOf('big');
    const bigRange = ax._ttsRange(model, bigAt, bigAt + 3);
    ok('an offset maps back to its node and place in it', bigRange.startContainer.data === 'big' && bigRange.startOffset === 0 && bigRange.endOffset === 3);
    const crossAt = model.text.indexOf('world'), cross = ax._ttsRange(model, bigAt, crossAt + 5);
    ok('a range may run across nodes', cross.startContainer.data === 'big' && cross.endContainer.data === ' world. Dr. Smith paid 3.5 dollars. Next one.' && cross.endOffset === 6, JSON.stringify([cross.endOffset]));
    ok('a point in a text node is its offset', ax._ttsOffsetOf(model, bigRange.startContainer, 1) === bigAt + 1);
    const li2 = textNode(doc.main, 'Two').parentNode;
    ok('an element\'s boundary is the next text from it', ax._ttsOffsetOf(model, li2.parentNode, 1) === model.text.indexOf('Two'));
    ok('...and past the last text it is the end', ax._ttsOffsetOf(model, doc.main, doc.main.childNodes.length) === model.text.length);

    // sentences and chunks
    const spans = ax._ttsSentenceSpans(model.text, 0, model.text.length).map(([s, e]) => model.text.slice(s, e));
    ok('no sentence crosses a block, a title and a list item stand alone', spans[0] === 'Tides' && spans.includes('One') && spans.includes('Two') && spans.includes('A') && spans.includes('B'), JSON.stringify(spans));
    ok('"Dr." and a decimal do not end a sentence', spans.includes('Hello big world.') && spans.includes('Dr. Smith paid 3.5 dollars.') && spans.includes('Next one.'), JSON.stringify(spans));
    const chunks = ax._ttsPlanChunks(model.text, 240, 120);
    const said = chunks.map(c => c.text).join(' ');
    ok('chunks hold every sentence once, in order', said === 'Tides. Hello big world. Dr. Smith paid 3.5 dollars. Next one. One. Two. A. B. Later page.', said);
    ok('...a heading or list item is given a stop to say, so it does not run on', /^Tides\. /.test(said) && / One\. Two\. /.test(said), said);
    // A span says its words, and a stop where its block ended without one.
    const spanSaid = sp => model.text.slice(sp.s, sp.e).replace(/\s+/g, ' ');
    const pieces = c => { let at = 0; return c.spans.map(sp => { const p = c.text.slice(at, at + sp.n); at += sp.n + 1; return p; }); };
    ok('each span in a chunk is where its words are in the text', chunks.every(c => pieces(c).every((p, i) => p === spanSaid(c.spans[i]) || p === spanSaid(c.spans[i]) + '.') && pieces(c).join(' ') === c.text));
    const long = ('word '.repeat(70)).trim() + '. Tail.';
    const lc = ax._ttsPlanChunks(long, 100, 0);
    ok('a sentence longer than a chunk is cut at words, each piece a span of its own', lc.length > 2 && lc.every(c => c.text.length <= 100 && c.spans.length >= 1) && lc[0].spans[0].s === 0 && lc.map(c => c.text).join(' ') === long);
    const from = model.text.indexOf('Next one.');
    const part = ax._ttsPlanChunks(model.text, 240, 0, from, from + 9);
    ok('a part of the text reads only that, spans kept in the whole text\'s offsets', part.length === 1 && part[0].text === 'Next one.' && part[0].spans[0].s === from);

    // where in a chunk
    const two = { text: 'First one. Second one is longer.', spans: [{ s: 0, e: 10, n: 10 }, { s: 11, e: 32, n: 21 }] };
    ok('a character of what is said is in its sentence, the joining space too', [0, 9, 10, 11, 31, 99].map(c => ax._ttsSpanAtChar(two, c)).join() === '0,0,1,1,1,1');
    ok('a share of the audio is a share of the characters', ax._ttsSpanAtChar(two, 0.2 * two.text.length) === 0 && ax._ttsSpanAtChar(two, 0.6 * two.text.length) === 1);
    const small = ax._ttsPlanChunks(model.text, 20, 0);
    const plan = { doc, model, chunks: small, b: model.text.length, sel: false };
    const sa = ax._ttsSentenceAt(model, model.text.indexOf('Smith'));
    ok('the sentence at an offset', model.text.slice(sa.s, sa.e) === 'Dr. Smith paid 3.5 dollars.');
    const gap = ax._ttsSentenceAt(model, model.text.indexOf('Hello big world.') + 'Hello big world.'.length);
    ok('between two sentences it is the next', model.text.slice(gap.s, gap.e) === 'Dr. Smith paid 3.5 dollars.');
    ok('past the end it is the last', model.text.slice(ax._ttsSentenceAt(model, 1e6).s).startsWith('Later'));

    // geometry
    ok('a sentence in view needs no scroll', ax._ttsScrollBy({ top: 300, bottom: 340 }, 800) === 0);
    ok('near the foot (the reading bar floats there) it is brought up to 28%', ax._ttsScrollBy({ top: 700, bottom: 740 }, 800) === Math.round(700 - 800 * 0.28));
    ok('above the top it is brought down, a negative scroll', ax._ttsScrollBy({ top: -50, bottom: -10 }, 800) === Math.round(-50 - 224));
    ok('a tap near a sentence\'s text is on it, a tap far from it is not', ax._ttsOnText([{ left: 10, right: 200, top: 100, bottom: 120 }], 205, 128) && !ax._ttsOnText([{ left: 10, right: 200, top: 100, bottom: 120 }], 300, 110));

    // selection
    const bigNode = bigRange.startContainer, worldNode = textNode(doc.main, ' world.');
    let selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: bigNode, startOffset: 0, endContainer: worldNode, endOffset: 6 }), removeAllRanges() { this.cleared = true; } };
    doc.defaultView.getSelection = () => selection;
    const sel = ax._ttsSelectedSpan(model);
    ok('a selection is a span of the text', sel && model.text.slice(sel[0], sel[1]) === 'big world', JSON.stringify(sel));
    selection.isCollapsed = true;
    ok('a collapsed selection is none', ax._ttsSelectedSpan(model) === null);
    selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: doc.main, startOffset: 0, endContainer: doc.main, endOffset: 1 }) };
    doc.defaultView.getSelection = () => selection;
    const hsel = ax._ttsSelectedSpan(model);
    ok('a selection by element boundaries (a triple click) is the text between them', hsel && model.text.slice(hsel[0], hsel[1]).replace(BLOCK, '') === 'Tides', JSON.stringify(hsel));

    // the reading marks, follows and is seeked
    ax._readerMainContent = d => d.main;
    selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: bigNode, startOffset: 0, endContainer: worldNode, endOffset: 6 }), removeAllRanges() { this.cleared = true; } };
    doc.defaultView.getSelection = () => selection;
    const selPlan = ax._ttsMakePlan(doc);
    ok('with a selection Read aloud reads the selection and stops', selPlan.sel && selPlan.chunks.length === 1 && selPlan.chunks[0].text === 'big world.', JSON.stringify(selPlan.chunks));
    selection.isCollapsed = true;
    const allPlan = ax._ttsMakePlan(doc);
    ok('without one it reads the whole article', !allPlan.sel && allPlan.chunks.map(c => c.text).join(' ') === said);
    doc.__zbHere = () => ({ startContainer: textNode(doc.main, 'One'), startOffset: 0 });
    ok('in a book it begins at the page that is open', ax._ttsMakePlan(doc).chunks.map(c => c.text).join(' ') === 'One. Two. A. B. Later page.');
    delete doc.__zbHere;
    // what a reading skips is read when it is chosen, or when it is all there is
    const facts = mkDoc(['main', {}, ['table', { cls: ['infobox'] }, ['tr', {}, ['td', {}, 'Born in Antioch.']]], ['p', {}, 'Prose here.']]);
    const cell = textNode(facts.main, 'Born in Antioch.');
    facts.defaultView.getSelection = () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: cell, startOffset: 0, endContainer: cell, endOffset: 16 }) });
    const cellPlan = ax._ttsMakePlan(facts);
    ok('a selection in a table cell reads that cell, not the article from the top', cellPlan && cellPlan.sel && cellPlan.chunks.map(c => c.text).join(' ') === 'Born in Antioch.', cellPlan && JSON.stringify(cellPlan.chunks.map(c => c.text)));
    const onlyFacts = mkDoc(['main', {}, ['table', { cls: ['infobox'] }, ['tr', {}, ['td', {}, 'Nothing but a table.']]]]);
    const factsPlan = ax._ttsMakePlan(onlyFacts);
    ok('a page that is nothing but what is skipped is read whole, not silence', factsPlan && factsPlan.chunks.map(c => c.text).join(' ') === 'Nothing but a table.', factsPlan && JSON.stringify(factsPlan.chunks.map(c => c.text)));

    const listeners = [];
    doc.addEventListener = (t, f) => listeners.push(t); doc.removeEventListener = (t) => { listeners.splice(listeners.indexOf(t), 1); };
    selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: bigNode, startOffset: 0, endContainer: worldNode, endOffset: 6 }), removeAllRanges() { this.cleared = true; } };
    doc.defaultView.getSelection = () => selection;
    ax._ttsAlongBegin(selPlan);
    ok('the selection gives way to the mark, and the article is listened to', selection.cleared && ['wheel', 'touchmove', 'keydown', 'mousedown', 'click', 'scroll', 'touchstart', 'touchend'].every(t => listeners.includes(t)));
    ax._ttsAlongEnd();
    ok('when it ends the listeners go', listeners.length === 0 && ax._ttsRead === null);

    ax._ttsAlongBegin(plan);
    const hls = doc.defaultView.CSS.highlights;
    ax._ttsAlongAt(0, null);
    ok('before the voice says where it is, the whole chunk is marked', hls.get('zimi-tts').s.length === small[0].spans.length);
    const firstHl = hls.get('zimi-tts');
    ax._ttsAlongAt(1, 0);
    ok('then the sentence, one range', hls.get('zimi-tts').s.length === 1);
    ok('...in the same Highlight, its old ranges deleted one by one (Safari repaints only a deleted range)', hls.get('zimi-tts') === firstHl && firstHl.gone === small[0].spans.length);
    ax._ttsAlongAudio(1, { duration: NaN, currentTime: 0 });
    ok('audio of unknown length marks the whole chunk', hls.get('zimi-tts').s.length === small[1].spans.length);
    ax._ttsAlongAudio(1, { duration: 10, currentTime: 5 });
    ok('audio half played marks the sentence half way through the chunk', hls.get('zimi-tts').s.length === 1);
    ax._ttsAlongChar(0, 0);
    ok('the browser\'s voice marks by the character it reached', hls.get('zimi-tts').s.length === 1);
    const win = doc.defaultView;
    doc.documentElement.classList.toggle = (c, on) => { doc.night = [c, on]; };
    ax._nightRedOn = () => true; ax._ttsRead.key = ''; ax._ttsAlongAt(0, 0);
    ok('a night-red page gets its own, fainter mark', /zimi-tts-night ::highlight/.test(ax._TTS_HL_CSS) && doc.night && doc.night[0] === 'zimi-tts-night' && doc.night[1] === true);
    ax._nightRedOn = () => false;

    // follow
    doc.rect = () => ({ top: 700, bottom: 740, left: 0, right: 50, width: 50, height: 40 });
    ax._ttsRead.key = ''; ax._ttsAlongAt(1, 0);
    ok('near the foot the page scrolls smoothly to bring it up', win.scrolled && win.scrolled.top === Math.round(700 - 224) && win.scrolled.behavior === 'smooth', JSON.stringify(win.scrolled));
    win.scrolled = null; doc.rect = () => ({ top: 300, bottom: 340, left: 0, right: 50, width: 50, height: 40 });
    ax._ttsAlongAt(1, 1);
    ok('in view: no scroll', !win.scrolled);
    ax._ttsLose();
    ok('a hand on the page stops following', ax._ttsRead.following === false);
    doc.rect = () => ({ top: 700, bottom: 740, left: 0, right: 50, width: 50, height: 40 });
    ax._ttsAlongAt(2, 0);
    ok('...and the page stays where the person left it', !win.scrolled && ax._ttsRead.following === false);
    doc.rect = () => ({ top: 300, bottom: 340, left: 0, right: 50, width: 50, height: 40 });
    ax._ttsAlongAt(3, 0);
    ok('...until the sentence is back in view', ax._ttsRead.following === true);
    ax._ttsLose();
    doc.rect = () => ({ top: 700, bottom: 740, left: 0, right: 50, width: 50, height: 40 });
    ax._ttsRead.key = ''; ax._ttsAlongAt(3, 0);
    ax._ttsFollowResume();
    ok('tapping the voice state follows again, at once', ax._ttsRead.following === true && win.scrolled && win.scrolled.top === Math.round(700 - 224));
    ax.window.matchMedia = () => ({ matches: true });
    win.scrolled = null; ax._ttsRead.key = ''; ax._ttsAlongAt(3, 0);
    ok('reduced motion: it jumps, not glides', win.scrolled && win.scrolled.behavior === 'auto');
    // a book on pages turns the page
    doc.documentElement.classList.contains = c => c === 'zb-paged';
    let shown = null; doc.__zbShowRange = r => { shown = r; };
    doc.rect = () => ({ top: 100, bottom: 120, left: 900, right: 990, width: 90, height: 20 });
    ax._ttsRead.key = ''; ax._ttsAlongAt(4, 0);
    ok('on pages a sentence off the open page turns the page', shown !== null);
    shown = null; doc.rect = () => ({ top: 100, bottom: 120, left: 20, right: 90, width: 70, height: 20 });
    ax._ttsRead.key = ''; ax._ttsAlongAt(4, 1);
    ok('...and one on the open page turns nothing', shown === null);
    doc.documentElement.classList.contains = () => false;
    ax.window.matchMedia = () => ({ matches: false });

    // a tap
    let spoken = null;
    ax._ttsSpeak = (from, p) => { spoken = p; };
    ax._bookCaretAt = () => ({ node: textNode(doc.main, 'Smith'), off: 8 });
    doc.rect = () => ({ top: 100, bottom: 120, left: 10, right: 200, width: 190, height: 20 });
    const tap = (over) => Object.assign({ defaultPrevented: false, button: 0, clientX: 100, clientY: 110, target: { closest: () => null } }, over);
    win.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
    ax._ttsTap(tap());
    ok('a tap on a sentence moves the reading there, to the end of what was being read', spoken && spoken.chunks[0].text.startsWith('Dr. Smith paid 3.5 dollars.') && spoken.b === plan.b, spoken && spoken.chunks[0].text);
    // a sentence back and on
    const rp = ax._ttsRead.plan, keyOf = (want) => {
      for (let i = 0; i < rp.chunks.length; i++) for (let k = 0; k < rp.chunks[i].spans.length; k++) {
        const sp = rp.chunks[i].spans[k];
        if (rp.model.text.slice(sp.s, sp.e).startsWith(want)) return i + ':' + k;
      }
    };
    const step = (from, dir) => { spoken = null; ax._ttsRead.key = from; ax._ttsStep(dir); return spoken && spoken.chunks[0].text; };
    ok('on: the next sentence, from any piece of a long one', /^Next one\./.test(step(keyOf('Dr. Smith'), 1) || '') && /^Next one\./.test(step(keyOf('dollars'), 1) || ''), step(keyOf('dollars'), 1));
    ok('back from a piece: the sentence before the whole sentence', /^Hello big world\./.test(step(keyOf('dollars'), -1) || ''), step(keyOf('dollars'), -1));
    ok('back: the sentence before', /^Hello big world\./.test(step(keyOf('Dr. Smith'), -1) || ''), step(keyOf('Dr. Smith'), -1));
    ok('back across a block: the heading before it', /^Tides\./.test(step(keyOf('Hello'), -1) || ''), step(keyOf('Hello'), -1));
    ok('on across a block: the list item after it', /^One\./.test(step(keyOf('Next one'), 1) || ''), step(keyOf('Next one'), 1));
    ok('before the voice says where it is, from the chunk\'s first sentence', /^Next one\./.test(step('2:null', 1) || ''), step('2:null', 1));
    ok('0: this sentence again, from its start', /^Dr\. Smith/.test(step(keyOf('dollars'), 0) || ''), step(keyOf('dollars'), 0));
    // the bar's back: once, this sentence again; again soon after, the one before
    Object.assign(ax, { _TTS_BACK_AGAIN_MS: 3000, _ttsBackAt: 0 });
    spoken = null; ax._ttsRead.key = keyOf('Dr. Smith'); ax._ttsBack();
    const once = spoken && spoken.chunks[0].text;
    spoken = null; ax._ttsRead.key = keyOf('Dr. Smith'); ax._ttsBack();
    ok('back once restarts the sentence; back again goes to the one before', /^Dr\. Smith/.test(once || '') && /^Hello big world\./.test((spoken && spoken.chunks[0].text) || ''), once + ' | ' + (spoken && spoken.chunks[0].text));
    ax._ttsBackAt = 0;
    spoken = null; ax._ttsTap(tap({ target: { closest: () => ({}) } }));
    ok('never a link, a button or an image to enlarge', spoken === null);
    win.getSelection = () => ({ isCollapsed: false, toString: () => 'some words', rangeCount: 1 });
    ax._ttsTap(tap());
    ok('never a text selection', spoken === null);
    win.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
    ax._ttsTap(tap({ clientY: 400 }));
    ok('never a tap far from the text', spoken === null);
    ax._ttsTap(tap({ defaultPrevented: true }));
    ok('never one something else took', spoken === null);
    // A phone: the tap is read from the touch (iOS sends many pages no click),
    // and a click that does follow it is the same tap.
    Object.assign(ax, { _TTS_TAP_MS: 600, _TTS_TAP_SLOP: 10, _TTS_TAP_CLICK_MS: 700, _ttsTouchedAt: 0 });
    const on = {}, keepAdd = doc.addEventListener;
    doc.addEventListener = (t, f) => { on[t] = f; };
    ax._ttsAlongBegin(plan);
    const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: { closest: () => null }, defaultPrevented: false });
    spoken = null; on.touchstart(touch(100, 110)); on.touchend(touch(102, 111));
    ok('a touch that stays put is a tap: the reading moves there', spoken && spoken.chunks[0].text.startsWith('Dr. Smith paid'), spoken && spoken.chunks[0].text);
    spoken = null; on.click(tap());
    ok('...and the click after it is the same tap, not a second', spoken === null);
    ax._ttsTouchedAt = 0;
    spoken = null; on.touchstart(touch(100, 110)); on.touchend(touch(100, 160));
    ok('a touch that moved is a scroll, not a tap', spoken === null);
    spoken = null; on.touchstart(touch(100, 110)); on.touchend(Object.assign(touch(101, 110), { defaultPrevented: true }));
    ok('a touch the page took for itself (its own control) is not a tap', spoken === null);
    doc.addEventListener = keepAdd;
    doc.documentElement.classList.contains = c => c === 'zb-paged';
    ax._ttsTap(tap({ clientX: 20 }));
    ok('on pages the edge turns the page, it does not seek, and following stops', spoken === null && ax._ttsRead.following === false);
    ax._ttsAlongEnd();
    // no highlight API: nothing marked, nothing breaks
    const bare = mkDoc(article); delete bare.defaultView.CSS;
    ax._ttsAlongBegin(ax._ttsPlanFrom(ax._ttsReadModel(bare, bare.main), 0, 99999, false));
    let threw = false; try { ax._ttsAlongAt(0, null); ax._ttsAlongEnd(); } catch (e) { threw = true; }
    ok('where the highlight API is missing nothing is marked and nothing breaks', !threw);
  }

  // ── the page that scrolls: on an iPhone the reader's body does ──────
  {
    const sc = {};
    vm.createContext(sc);
    vm.runInContext(fn('_scrollerOf'), sc);
    const mk = (tag, oy, sh, ch) => ({ nodeType: 1, tag, oy, scrollHeight: sh, clientHeight: ch, parentElement: null });
    const page = (rootOy) => {
      const root = mk('html', rootOy, 608, 608), body = mk('body', 'auto', 20000, 608), p = mk('p', 'visible', 40, 40);
      const doc = { documentElement: root, body };
      [root, body, p].forEach(e => { e.ownerDocument = doc; });
      p.parentElement = body; body.parentElement = root;
      const win = { getComputedStyle: e => ({ overflowY: e.oy }) };
      return { p, body, win };
    };
    let pg = page('auto');
    ok('a body that scrolls itself (the root\'s overflow set) is the scroller', sc._scrollerOf(pg.p, pg.win) === pg.body);
    pg = page('visible');
    ok('...but with the root left visible the window scrolls', sc._scrollerOf(pg.p, pg.win) === null);
  }

  {
    // The device voice: a cancelled utterance reports its end or error after the
    // next reading has begun (a seek, a sentence step, a new speed). Taken as the
    // new reading's end, it hid the bar while the voice went on talking.
    const said = [];
    const dv = { _ttsRun: 5, r: { speaking: null }, _DEVICE_VOICE: 'device', _ttsNow: {}, _ttsRate: () => 1,
      _ttsAlongAt() {}, _ttsAlongChar() {}, _ttsBarSync() {},
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
      window: { speechSynthesis: { cancel() {}, speak(u) { said.push(u); } } } };
    dv._ttsSetSpeaking = on => { dv.r.speaking = on; };
    vm.createContext(dv);
    vm.runInContext(fn('_ttsSpeakDevice'), dv);
    dv._ttsSpeakDevice(['One.', 'Two.'], 'en', 0);
    dv._ttsRun = 6; // the next reading starts
    said[0].onerror({ error: 'interrupted' }); said[1].onend();
    ok('an older reading\'s end and error leave the new one alone', dv.r.speaking === null, dv.r.speaking);
    said.length = 0;
    dv._ttsSpeakDevice(['Three.'], 'en', 0);
    said[0].onerror({ error: 'interrupted' });
    ok('...and its own cancel ("interrupted") is not taken for a failure', dv.r.speaking === null, dv.r.speaking);
    said[0].onerror({ error: 'synthesis-failed' });
    ok('...but a real failure of the reading now ends it', dv.r.speaking === false, dv.r.speaking);
  }

  {
    // Before readaloud.js has loaded, a tap (the Read aloud button, or Read on the
    // selection bar) starts the audio inside the tap, as iOS requires, then loads
    // the module and runs its own function with the same arguments.
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
    const grab = name => { const m = appSrc.match(new RegExp('\\nfunction ' + name + '\\([^]*?\\n}\\n')); return m ? m[0] : ''; };
    const events = [];
    const st = { _ttsUnlockedAudio: null, _TTS_SILENCE: 'data:x', _showToast() {}, t: k => k,
      Audio: class { constructor(src) { this.src = src; } play() { events.push('play ' + this.src); return Promise.resolve(); } },
      SpeechSynthesisUtterance: class {}, window: { speechSynthesis: { speak() { events.push('speak'); } } } };
    st._ttsLoad = () => { events.push('load'); return Promise.resolve(true).then(ok => { st.window._ttsSpeak = (...a) => events.push('real speak ' + a.join(',')); return ok; }); };
    vm.createContext(st);
    vm.runInContext(['_ttsUnlock', '_ttsThen', '_ttsSpeak'].map(grab).join('\n'), st);
    st._ttsSpeak(0, 'plan');
    ok('the tap itself starts the audio and the device voice, before the module loads', events.join('|') === 'play data:x|speak|load', events.join('|'));
    await new Promise(r => setTimeout(r, 0));
    ok('...then the module\'s own Speak runs, with the same arguments', events[3] === 'real speak 0,plan', events.join('|'));
    ok('...and the started element is what readaloud.js plays from', st._ttsUnlockedAudio && st._ttsUnlockedAudio.src === 'data:x' && /typeof _ttsUnlockedAudio/.test(src));
  }

  {
    // A reading started or moved is marked at once, not when the voice gets
    // there: a slow voice takes seconds over a sentence and the page sat unmarked.
    const marks = [], order = [];
    const sp = { _ttsCanSpeak: () => true, _ttsFrameDoc: () => ({}), _ttsLang: () => 'en', _ttsStop() {}, _ttsAlongBegin() { order.push('begin'); },
      _ttsAlongAt: (i, k) => { marks.push(i + ':' + k); order.push('mark'); }, _ttsServerEngines: () => ['kokoro'], _TTS_AVAILABLE: true,
      _ttsSetSpeaking() {}, _setStorageJSON() {}, SK: {}, _ttsChosenVoice: () => '', _DEVICE_VOICE: 'device', _ttsBarSync() {},
      _ttsRun: 0, _ttsRead: null, _ttsSpeakServer() { order.push('voice'); }, _ttsSpeakDevice() {}, _ttsHold() {}, Math, Date };
    vm.createContext(sp);
    vm.runInContext(fn('_ttsSpeak'), sp);
    sp._ttsSpeak(2, { doc: {}, chunks: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    ok('started at a sentence, it is marked before the voice is even asked', marks.join() === '2:0' && order.join() === 'begin,mark,voice', order.join() + ' ' + marks.join());
  }

  {
    // Between sentences the bar holds still; the ring turns only after a wait
    // long enough to notice.
    const timersH = [];
    const hv = { _ttsNow: { playing: true, spin: false }, _ttsSpeaking: true, _TTS_SPIN_AFTER_MS: 700, _ttsSpinTimer: 0, synced: 0,
      clearTimeout() {}, setTimeout: (f, ms) => { timersH.push({ f, ms }); return timersH.length; } };
    hv._ttsBarSync = () => { hv.synced++; };
    vm.createContext(hv);
    vm.runInContext(fn('_ttsHold'), hv);
    hv._ttsHold();
    ok('the next sentence on its way: no ring at once', hv._ttsNow.playing === false && hv._ttsNow.spin === false && timersH[0].ms === 700);
    timersH[0].f();
    ok('...a wait that goes on: the ring', hv._ttsNow.spin === true);
    hv._ttsNow.spin = false; hv._ttsHold(); hv._ttsNow.playing = true; timersH[1].f();
    ok('...one that ended in time: none', hv._ttsNow.spin === false);
  }

  {
    // The chunks asked for ahead are kept in the page: the next sentence starts
    // from memory, with no request of its own between sentences.
    const rr = freshReading(), au = ctx._ttsAudio, made = [];
    ctx.authedFetch = u => { fetched.push(u); return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ of: u }) }); };
    ctx.URL = { createObjectURL: b => { made.push(b.of); return 'blob:' + made.length; }, revokeObjectURL() {} };
    ctx._TTS_AHEAD = 2;
    ctx._ttsSpeakServer(['one.', 'two.', 'three.'], 'en', ['piper'], 1);
    au.onplaying();
    for (let k = 0; k < 4; k++) await new Promise(res => setImmediate(res));
    au.onended();
    ok('the next sentence plays from what was fetched ahead, not a new request', /^blob:/.test(au.src) && textOf(made[0]) === 'two.', au.src + ' ' + made.join());
    delete ctx.URL;
  }

  {
    // A run ended by a stop or by the next run gives its prefetched clips back.
    const revoked = [], made = [];
    ctx.URL = { createObjectURL: b => { made.push(b.of); return 'blob:' + made.length; }, revokeObjectURL: u => { revoked.push(u); } };
    ctx._ttsSpeaking = false; ctx._TTS_AVAILABLE = false;
    const prefetch = async (run) => {
      freshReading(); ctx._ttsRun = run; ctx._TTS_AHEAD = 2; ctx._ttsVoices = { timings: { piper: { rtf: 0.1 } } };
      ctx.authedFetch = u => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ of: u }) });
      ctx._ttsSpeakServer(['one.', 'two.', 'three.'], 'en', ['piper'], run);
      ctx._ttsAudio.onplaying();
      for (let k = 0; k < 4; k++) await new Promise(res => setImmediate(res));
    };
    await prefetch(1);
    const held = made.length;
    revoked.length = 0; // the previous test's reading, given back as this one began
    ctx._ttsStop();
    ok('Stop revokes the clips fetched ahead', held === 2 && revoked.length === 2, held + ' ' + revoked.length);
    revoked.length = 0; made.length = 0;
    await prefetch(1);
    revoked.length = 0;
    ctx._ttsSpeakServer(['x.'], 'en', ['piper'], 2);
    ok('the next run revokes the superseded run\'s clips', revoked.length === 2, String(revoked.length));
    delete ctx.URL;
  }

  // Waiting for the best voice: one chunk asked for at a time, nothing played
  // until enough is ready ahead, and no switch, slow mark or offer on the way.
  {
    r = freshReading();
    a = ctx._ttsAudio;
    prefs = { voice: '', off: [], wait: true };
    ctx._ttsVoices = { timings: { kokoro: { rtf: 1.5, cps: 14 } } };
    const answers = [];
    ctx.authedFetch = u => { fetched.push(u); return new Promise(res => answers.push(() => res({ status: 200, ok: true, blob: () => Promise.resolve('clip:' + textOf(u)) }))); };
    ctx.URL = { createObjectURL: b => b, revokeObjectURL() {} };
    const say = async () => { answers.shift()(); for (let k = 0; k < 4; k++) await tick(); };
    const four = lens(4).map((x, k) => k + x);
    ctx._ttsSpeakServer(four, 'en', ['kokoro', 'piper'], 1, null);
    ok('waiting: the first chunk is asked for, and nothing plays yet', fetched.length === 1 && a.played.length === 0, JSON.stringify(a.played));
    ok('...with no switch to another voice armed', timers.filter(Boolean).length === 0, timers.filter(Boolean).map(x => x.ms));
    await say();
    ok('...one at a time: the next is asked for once the first is made', fetched.length === 2 && a.played.length === 0);
    await say();
    ok('...far enough ahead: it plays, from what was made', a.played.length === 1 && a.src === 'clip:' + four[0], a.src);
    a.onplaying(); a.onended();
    ok('the next plays straight from memory', a.src === 'clip:' + four[1], a.src);
    a.onplaying(); a.onended();
    ok('ran dry: it waits to get ahead again, still in the same voice', a.played.length === 2 && fetched.every(u => engineOf(u) === 'kokoro'), JSON.stringify(a.played));
    ctx._ttsPaused = true;
    await say();
    ok('...paused while it waited: made, not played', a.played.length === 2);
    ctx._ttsPaused = false;
    ctx._ttsHeld();
    ok('...Resume goes on waiting while the last chunk is still being made', a.played.length === 2);
    await say();
    ok('...then plays the chunk that was waited for, not the one that ended', a.played.length === 3 && a.src === 'clip:' + four[2], a.src);
    ok('nothing was marked slow', !store.zimi_tts_slow, store.zimi_tts_slow);
    prefs = { voice: '', off: [] };
    ctx._ttsVoices = null;
    delete ctx.URL;
  }

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('all passed');
})();
