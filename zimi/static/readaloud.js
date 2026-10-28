// Read aloud: the reading itself, loaded the first time something is read
// (app.js _ttsLoad), or when an article opens for someone who read aloud this
// week. What the page needs before then stays in app.js: whether the button
// shows (_ttsCanSpeak, the voice list), the speed and the measurements that
// Settings > Voices shows. This file's functions replace app.js's stand-ins
// for _ttsToggle, _ttsStop and _ttsSetSpeaking.


// Read aloud in the server's voices (voices.py: Kokoro, Piper, ...) when it
// has one for the article's language, as the Dictionary's Say does: the same
// voice on every device, and a natural one where the browser's own is robotic
// or missing (a Linux browser often has only espeak, or none at all). The
// browser's speechSynthesis stays the fallback, and is used as before when the
// server can say nothing or the viewer chose Device in Settings > Voices.
// Each chunk is one /dictionary/speak?kind=sentence request (chunks are 240
// characters, under voices.SENTENCE_MAX), played by one <audio> element; the
// next chunk is asked for while this one plays, so the server has said it by
// the time it is needed. An engine too slow for that on this server (Kokoro on
// a small NAS takes longer to say a chunk than to play it) gives way to the
// next engine for the language for the rest of the article.
var _TTS_SERVER_RETRY_MS = 2000; // voices.RETRY_AFTER_S: the server was busy
// How long a chunk may take to start before the next engine says it instead.
// Piper says a 240-character chunk in 1 to 3 s on an Intel N150; Kokoro takes
// 18 to 24 s there (2026-10-17), longer than the chunk plays.
var _TTS_START_WAIT_MS = 6000;
// Before the first word a voice may take as long as this server measured it
// taking after a rest (its model loading), with this margin: Clear takes 7.6 s
// cold on a NAS, and gave way to Basic for the whole article at 6 s (Eric,
// 2026-10-20: "Automatic was on basic/robot and clear works fine").
var _TTS_START_MARGIN = 1.25;
var _TTS_START_WAIT_MAX_MS = 20000;
function _ttsStartWait(engine) {
  var tm = _voiceTimings(_ttsVoices && _ttsVoices.timings)[engine];
  var cold = tm && typeof tm.cold_s === 'number' ? tm.cold_s * 1000 * _TTS_START_MARGIN : 0;
  return Math.min(_TTS_START_WAIT_MAX_MS, Math.max(_TTS_START_WAIT_MS, cold));
}
var _TTS_CHUNK_MAX = 240, _TTS_FIRST_CHUNK_MAX = 120; // characters
var _TTS_AHEAD = 3; // chunks asked for ahead of the one playing, so the voice never waits
// Until this server has measured a voice's pace, one chunk ahead: the server
// makes one at a time, so three asked of a voice slower than speech queue in
// front of the one about to play until it gives up (#121).
var _TTS_AHEAD_UNMEASURED = 1;
// Words heard before a voice stays for the rest of the article: a title of a
// second is not yet "mid-article", and a voice that said only that may still
// give way to a faster one (#121: "Epistemology.", then 36 s of silence).
var _TTS_SETTLED_CHARS = 100;
var _ttsAudio = (typeof _ttsUnlockedAudio !== 'undefined' && _ttsUnlockedAudio) || null; // started in the first tap (app.js)
var _ttsRun = 0; // bumped by every start and stop: callbacks of an older run do nothing
var _TTS_SUGGEST_MS = 9000;
var _TTS_WARM_ENGINES = ['kokoro', 'piper']; // the voices that load a model
// Settings > Voices' "Wait for the best voice" (Eric, 2026-10-23: "offer
// natural voice read aloud by buffering ahead not just stumbling and saying
// no. optionally"). A voice too slow to keep up still reads: the reading gets
// far enough ahead before it starts that the rest plays without a pause, as
// far as _TTS_WAIT_MAX_S of waiting allows, and when it runs dry it waits to
// get ahead again. The server makes one chunk at a time, so one is asked for
// at a time, without a break, from the first tap to the end.
var _TTS_WAIT_MAX_S = 60;
// Speech kept ready at most, in seconds: about 14 MB of a natural voice's
// audio, and well past the most a minute of making can get ahead.
var _TTS_WAIT_KEEP_S = 300;
var _TTS_CPS = 14; // characters a voice says a second at 1x, before this server measured it
var _TTS_WORK_MIN_S = 0.3; // quicker than this was the server's cache, not the voice
var _TTS_WORK_MIN_CHARS = 200; // made by this reading before its own pace replaces the server's
function _ttsWaits() {
  return !!_voicePrefs().wait;
}
// A voice's pace here: seconds of work and of speech per character (work
// null until it was measured).
function _ttsPace(engine) {
  var tm = _voiceTimings(_ttsVoices && _ttsVoices.timings)[engine] || {};
  var cps = tm.cps || _TTS_CPS;
  return { work: tm.rtf ? tm.rtf / cps : null, audio: 1 / cps };
}
// The last chunk that must be ready before chunk ``from`` plays, so that
// what follows plays without a pause while the rest is made one after
// another (as far as _TTS_WAIT_MAX_S of making allows). From = the voice
// keeps up, or its pace is not known yet. It depends on nothing that moves
// while the reading waits, so the wait it names only shortens.
function _ttsLeadEnd(chunks, from, pace, rate) {
  if (!pace.work) return from;
  var made = 0, heard = 0, start = 0, k;
  for (k = from; k < chunks.length; k++) {
    made += pace.work * chunks[k].length;
    start = Math.max(start, made - heard);
    heard += pace.audio * chunks[k].length / rate;
  }
  start = Math.min(start, _TTS_WAIT_MAX_S);
  for (made = 0, k = from; k < chunks.length - 1; k++) {
    made += pace.work * chunks[k].length;
    if (made >= start) break;
  }
  return k;
}
var _ttsWarmed = {};
// The voice Read aloud reads in when the person chose one: its own (Settings >
// Voices) or else the default there. '' is Automatic.
function _ttsChosenVoice() {
  var p = _voicePrefs();
  return p.read || p.voice;
}
// The server's engines for a language, best first. A chosen voice reads
// alone: it is the person's setting, so it neither gives way mid-read nor is
// marked slow (a slow one is suggested against, _ttsSuggestFaster). Only when
// it cannot say the language does Automatic pick: the server's own choice, then
// the rest, none that Settings turned off, an engine too slow to read with
// here last. Empty when the chosen voice is Device, or the server cannot say
// the language.
function _ttsServerEngines(lang) {
  var langs = (_ttsVoices && _ttsVoices.langs) || {};
  var row = langs[_normLang(_langPrimary(lang))];
  var prefs = _voicePrefs(), chosen = _ttsChosenVoice();
  if (!row || chosen === _DEVICE_VOICE) return [];
  var order = _ttsRowOrder(row, prefs);
  if (chosen && order.indexOf(chosen) >= 0) return [chosen];
  if (_ttsWaits()) return order; // the best first, however slow: it is waited for
  // Those that keep up, then those only this browser found slow, and last those
  // the server measured too slow: a guess never outranks a measurement.
  var quick = order.filter(function(e) { return !_ttsTooSlow(e); });
  var measured = order.filter(function(e) { return quick.indexOf(e) < 0 && _ttsKeepsUp(e, _ttsRate()) === false; });
  return quick.concat(order.filter(function(e) { return quick.indexOf(e) < 0 && measured.indexOf(e) < 0; }), measured);
}
// The engines the server has for a language row, its own choice first, none
// that Settings turned off.
function _ttsRowOrder(row, prefs) {
  var order = [row.engine].concat(row.engines || []);
  return order.filter(function(e, i) {
    return e && order.indexOf(e) === i && (row.engines || []).indexOf(e) >= 0 && prefs.off.indexOf(e) < 0;
  });
}
// A server voice for ``lang`` that keeps up at this speed, other than ``slow``; '' when none.
function _ttsFasterThan(lang, slow) {
  var row = ((_ttsVoices && _ttsVoices.langs) || {})[_normLang(_langPrimary(lang))];
  if (!row) return '';
  return _ttsRowOrder(row, _voicePrefs()).filter(function(e) { return e !== slow && !_ttsTooSlow(e); })[0] || '';
}
// Chosen, and not keeping up: once per engine, a quiet offer of another.
function _ttsSuggestFaster(lang, slowEngine) {
  var said = _getStorageJSON(SK.TTS_SUGGESTED, []);
  if (!Array.isArray(said)) said = [];
  if (said.indexOf(slowEngine) >= 0) return;
  var faster = _ttsFasterThan(lang, slowEngine);
  if (!faster) return;
  said.push(slowEngine);
  _setStorageJSON(SK.TTS_SUGGESTED, said);
  _showToast(t('tts_slow_suggest', { slow: _voiceEngineName(slowEngine), fast: _voiceEngineName(faster) }), _TTS_SUGGEST_MS,
    function() { _setVoicePrefs({ read: faster }); }, t('tts_slow_use', { fast: _voiceEngineName(faster) }));
}
// This browser's own finding that a voice kept a reading waiting holds for a
// day: a busy hour on the server is not the voice's nature. Kept as {engine:
// when}; the list kept before 1.14.1 is dropped, since a reading then called a
// voice slow after a moment's wait.
var _TTS_SLOW_FOR_MS = 24 * 3600 * 1000;
function _ttsSlowEngines() {
  var s = _getStorageJSON(SK.TTS_SLOW, {}), now = Date.now();
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [];
  return Object.keys(s).filter(function(e) { return typeof s[e] === 'number' && now - s[e] < _TTS_SLOW_FOR_MS; });
}
function _ttsMarkSlow(engine) {
  var kept = _getStorageJSON(SK.TTS_SLOW, {}), s = {};
  _ttsSlowEngines().forEach(function(e) { s[e] = kept[e]; });
  if (!(engine in s)) { s[engine] = Date.now(); _setStorageJSON(SK.TTS_SLOW, s); }
}
// Too slow to read with at this speed: as the server measured it, else as
// this browser found it (a reading that waited for it).
function _ttsTooSlow(engine) {
  var k = _ttsKeepsUp(engine, _ttsRate());
  return k === null ? _ttsSlowEngines().indexOf(engine) >= 0 : !k;
}
function _ttsSpeakUrl(text, lang, engine) {
  return '/dictionary/speak?kind=sentence&lang=' + encodeURIComponent(_normLang(_langPrimary(lang))) +
    '&engine=' + encodeURIComponent(engine) + '&text=' + encodeURIComponent(text);
}

// ``first`` caps the first chunk alone: a voice says nothing until a whole
// chunk is made, so a short one starts the reading sooner.
var _TTS_BLOCK = ' '; // between two blocks of the text that is read: no sentence runs across it
// The sentences of text[from, to) as [start, end) spans, trimmed. They are
// cut as the platform cuts them (Intl.Segmenter: Unicode's sentence rules, so
// quotes, ellipses, ?! and decimals, and CJK, Arabic and Indic marks), then a
// cut after an abbreviation is joined back, as ICU's suppressions and Punkt
// do: those rules alone read "Dr. | Smith", "J. | R. | R. | Tolkien" and
// "Jan. | 3" as sentences (Eric, 2026-10-20: "Dr. Smith isn't two sentences").
// Joining by mistake costs one longer mark; cutting by mistake, a pause.
var _TTS_ABBREVS = (function(lists) {
  var out = {};
  Object.keys(lists).forEach(function(l) { out[l] = {}; lists[l].split(' ').forEach(function(w) { out[l][w] = 1; }); });
  return out;
})({
  en: 'mr mrs ms mx dr prof sr jr st mt ft vs etc approx ca no nos fig figs vol vols ch pp ed eds inc ltd co corp bros gen col lt sgt capt cmdr adm gov sen rep rev hon pres ave blvd rd jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun dept univ est op cit al ibid',
  de: 'dr prof nr bzw usw ca evtl ggf vgl sog str abs hr fr jh jhd mio mrd bd',
  fr: 'm mme mlle mm dr pr st ste cf env etc vol chap av bd',
  es: 'sr sra srta dr dra ud uds pág núm av etc vol cap',
  pt: 'sr sra dr dra prof etc pág av vol cap',
  it: 'sig sigra dott prof ecc pag vol cap',
  nl: 'dhr mevr dr prof blz nr bijv enz',
  ru: 'г гг др им ул см тыс млн млрд руб стр т е'
});
var _TTS_INITIAL_NOT = { en: 'I' }; // a one-letter word that ends sentences, not an initial
var _TTS_SAID_END = /[.!?。！？।؟…:;,"'”’»)\]]$/; // a sentence the voice already hears end
var _TTS_SENTENCE_RE = /(?:[^.!?。！？।؟]|\.(?=\d))+[.!?。！？।؟]+(?!\d)["'”’»)\]]*|\S(?:[^.!?。！？।؟]|\.(?=\d))*$/g;
var _ttsSegmenters = {};
function _ttsSegmenter(lang) {
  var key = lang || '';
  if (!(key in _ttsSegmenters)) {
    try { _ttsSegmenters[key] = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }); }
    catch (e) { _ttsSegmenters[key] = null; } // no Intl.Segmenter (older browsers): the pattern below
  }
  return _ttsSegmenters[key];
}
// [start, end) of each sentence of ``seg``, untrimmed.
function _ttsSegments(seg, lang) {
  var sg = _ttsSegmenter(lang), out = [], m;
  if (sg) {
    for (var it = sg.segment(seg)[Symbol.iterator](), x = it.next(); !x.done; x = it.next()) out.push([x.value.index, x.value.index + x.value.segment.length]);
    return out;
  }
  _TTS_SENTENCE_RE.lastIndex = 0;
  while ((m = _TTS_SENTENCE_RE.exec(seg))) out.push([m.index, m.index + m[0].length]);
  return out;
}
// Whether sentence ``next`` goes on the one before (``prev``, both trimmed):
// it opens in lower case, or ``prev`` ends at one full stop after an
// initial, a dotted abbreviation (U.S., e.g., p.m.) or a listed one.
function _ttsJoinsNext(prev, next, lang) {
  if (!/[^.]\.$/.test(prev)) return false; // "?", "!", "..." and a closing quote end a sentence
  if (/^\p{Ll}/u.test(next)) return true;
  var tok = (prev.match(/(\S+)\.$/) || ['', ''])[1].replace(/^[("'\[«„“‘]+/, '');
  var l = _langPrimary(lang || 'en');
  if (/^\p{Lu}$/u.test(tok)) return tok !== (_TTS_INITIAL_NOT[l] || '');
  if (/\p{L}\.\p{L}/u.test(tok)) return true;
  tok = tok.toLowerCase();
  return !!((_TTS_ABBREVS[l] && _TTS_ABBREVS[l][tok]) || _TTS_ABBREVS.en[tok]);
}
function _ttsSentenceSpans(text, from, to, lang) {
  var out = [];
  for (var a = from; a < to;) {
    var b = text.indexOf(_TTS_BLOCK, a);
    if (b < 0 || b > to) b = to;
    var first = out.length, seg = text.slice(a, b).replace(/[\n\r]/g, ' '); // a line break in the source is a space, not a sentence end
    _ttsSegments(seg, lang).forEach(function(r) {
      var s = a + r[0], e = a + r[1];
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (s >= e) return;
      var prev = out.length > first ? out[out.length - 1] : null;
      if (prev && _ttsJoinsNext(text.slice(prev[0], prev[1]), text.slice(s, e), lang)) prev[1] = e; else out.push([s, e]);
    });
    a = b + 1;
  }
  return out;
}
// text[from, to) as chunks: {text, spans}, the text a voice says and the
// spans {s, e, n} of the sentences in it (n: characters said, whitespace
// collapsed), so a chunk can be followed back to where it is in ``text``.
function _ttsPlanChunks(text, maxLen, first, from, to, lang) {
  maxLen = maxLen || 240;
  to = to == null ? text.length : to;
  var out = [], buf = null;
  function cap() { return out.length || !first ? maxLen : first; }
  function flush() { if (buf) { out.push(buf); buf = null; } }
  var stop = /^(zh|ja)$/.test(_langPrimary(lang || '')) ? '\u3002' : '.';
  _ttsSentenceSpans(text, from || 0, to, lang).forEach(function(sp) {
    var piece = text.slice(sp[0], sp[1]), s = piece.replace(/\s+/g, ' ');
    if (!/[\p{L}\p{N}]/u.test(s)) return; // nothing to say: an anchor's zero-width space, a rule
    // A heading or list item ends where its block does, with no stop of its
    // own: the voice is given one, or it runs on into the next block.
    var gap = text.slice(sp[1], to).match(/^\s*/)[0];
    var blockEnds = sp[1] + gap.length >= to || gap.indexOf(_TTS_BLOCK) >= 0;
    s = _ttsSpoken(s, lang);
    if (!_TTS_SAID_END.test(s) && blockEnds) s += stop;
    // A single sentence longer than maxLen: hard-split on word boundaries. The
    // first chunk's smaller cap only keeps a second sentence out of it (a
    // quicker start); it never cuts a sentence in two (Eric, 2026-10-22: "Why
    // did this sentence split?").
    if (s.length > maxLen) {
      flush();
      var line = null, re = /\S+/g, w;
      while ((w = re.exec(piece))) {
        if (line && line.text.length + 1 + w[0].length > maxLen) { out.push(line); line = null; }
        if (line) { line.text += ' ' + w[0]; line.spans[0].e = sp[0] + re.lastIndex; line.spans[0].n = line.text.length; }
        else line = { text: w[0], spans: [{ s: sp[0] + w.index, e: sp[0] + re.lastIndex, n: w[0].length }] };
      }
      buf = line; // carry remainder to pack with the next sentence
      return;
    }
    if (buf && buf.text.length + 1 + s.length > cap()) flush();
    var span = { s: sp[0], e: sp[1], n: s.length };
    if (buf) { buf.text += ' ' + s; buf.spans.push(span); } else buf = { text: s, spans: [span] };
    // A chunk ends with its block: a heading is said on its own, with the
    // pause between two clips, not run into the sentence after it (Eric,
    // 2026-10-21: "blends headers into sentences").
    if (blockEnds) flush();
  });
  flush();
  return out;
}
function _ttsChunkText(text, maxLen, first, lang) {
  return text ? _ttsPlanChunks(String(text), maxLen, first, 0, null, lang).map(function(c) { return c.text; }) : [];
}
// ── Read along: the sentence being read, marked in the article ──
// The text to read is taken from the article's own text nodes (not innerText),
// each piece keeping its node, so every chunk and sentence maps back to a DOM
// Range. The mark is the CSS Custom Highlight API: the article's DOM is never
// changed, and where the API is missing nothing is marked and nothing breaks.
// Nothing here runs until Read aloud starts.
var _TTS_SKIP_TAGS = ' script style noscript template svg canvas iframe object audio video select ';
// What a voice should not say though the page shows it: citation marks
// ("[3]", which also cut sentences in two), edit links, the hatnote, the
// infobox and other tables, captions, navigation boxes, the reference list
// (Eric, 2026-10-21: "reads the citation numbers").
var _TTS_SKIP_SEL = 'sup.reference,.mw-ref,.mw-editsection,.hatnote,.metadata,.ambox,.navbox,.sidebar,' +
  'table,figure,.thumb,.mw-references-wrap,ol.references,.reflist,.catlinks,.zim-footer,' +
  // Zimipedia's own: the folded Quick facts (its infobox) and its bars and sheets.
  '.zw-facts,.zb-bar,.zb-sheet,' +
  // Page chrome and what only a screen reader is given: menus, buttons, a
  // tooltip's glossary text, "Show" and "Panel - Collapsed" (Eric, 2026-10-25:
  // the Factbook "is very rough").
  // A book's page numbers, transcriber's note, contents list and licence boilerplate; a docs page's browser-support badge; a question page's own: votes, tags, who asked and when, a comment's author and date.
  '.pagenum,.pageno,.transnote,.toc,.pgheader,.pgfooter,.pg-boilerplate,#pg-header,#pg-footer,.baseline-indicator,.votecell,.post-taglist,.post-signature,.s-user-card,.comment-user,.comment-date,' +
  'nav,[role="navigation"],[role="menu"],[role="search"],button,.tooltip-content,.expandcollapse-all,.sr-only,.visually-hidden,.visuallyhidden,.screen-reader-text';
// Chrome by its class words (nav, menu, toolbar...), whatever the site calls the rest.
var _TTS_CHROME_CLASS = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|dropdown|breadcrumbs?|toolbar|pagination)(?:$|[\s_-])/i;
// Code is not read: its symbols come out as noise. A <pre> of prose (a poem) is.
function _ttsCode(el) { return el.localName === 'pre' && (!!el.querySelector('code') || !!(el.hasAttribute && el.hasAttribute('data-language')) || /[{}\[\]|&<>=;$\\]|\w\(/.test(el.textContent || '')); }
function _ttsChrome(el) { return typeof el.className === 'string' && _TTS_CHROME_CLASS.test(el.className); }
// A collapsed section (an accordion's closed panel) is still the article's text:
// hidden by the page's script until opened, and opened when the reading gets there.
var _TTS_PANEL_SEL = '.collapse,.collapsing,.accordion-collapse,.accordion-body,.panel-collapse';
var _TTS_PANEL_HEAD = '.tabHead,.accordion-header,.accordion-button,summary,[aria-expanded]';
function _ttsPanelHead(el) {
  var head = el.previousElementSibling;
  return head && (head.matches(_TTS_PANEL_HEAD) ? head : head.querySelector(_TTS_PANEL_HEAD));
}
function _ttsPanel(el) { return el.matches(_TTS_PANEL_SEL) || !!_ttsPanelHead(el); }
// "Label:" then its value in the next block reads as one sentence, not two stops.
var _TTS_LABEL_MAX = 60;
var _TTS_PANEL_OPEN_MS = 450; // a panel slides open before the sentence in it can be found
// What a voice says of a sentence: a heading in capitals is words, not letters
// ("THE WORLD FACTBOOK" is not T-H-E), "::" a pause, "sq km" what it is.
var _TTS_SMALL_WORDS = ' THE AND FOR OF OR IN ON TO BY AT IS AS AN ';
var _TTS_UNITS = [[/\bsq km\b/g, 'square kilometers'], [/\bsq mi\b/g, 'square miles'], [/(\d) ?km\b/g, '$1 kilometers']]; // English, where a number gives them away
function _ttsSpoken(s, lang) {
  s = s.replace(/\s*::\s*/g, ', ');
  s = s.replace(/\s+[\u2013\u2014]$/, ''); // a comment's dash before its author, which is not read
  if (_langPrimary(lang || 'en') === 'en') _TTS_UNITS.forEach(function(u) { s = s.replace(u[0], u[1]); });
  if (/\p{Ll}/u.test(s) || !/\p{Lu}{2}/u.test(s)) return s;
  return s.replace(/\p{Lu}+/gu, function(w) { return w.length > 3 || _TTS_SMALL_WORDS.indexOf(' ' + w + ' ') >= 0 ? w.toLowerCase() : w; });
}
// A table that holds paragraphs is the page's layout (older captures, some
// crawled sites put the whole article in one), not a table of facts: it is read.
function _ttsLayoutTable(el) { return el.tagName === 'TABLE' && !!el.querySelector('p'); }
var _TTS_HL = 'zimi-tts', _TTS_HL_STYLE = 'zimi-tts-style';
// A quiet amber tint, never the selection's blue: Reader View's own link
// colour of its theme where there is one (light, dark, sepia, black), else amber.
var _TTS_HL_CSS = '::highlight(' + _TTS_HL + '){background-color:rgba(245,158,11,.3)}' +
  '@supports (background-color:color-mix(in srgb,red 50%,transparent)){' +
  '.zimi-reader-active ::highlight(' + _TTS_HL + '){background-color:color-mix(in srgb,var(--rv-link) 26%,transparent)}}' +
  // Night red is a filter on the frame that turns an amber tint into a solid red under red text: a faint light veil instead.
  'html.zimi-tts-night ::highlight(' + _TTS_HL + '){background-color:rgba(255,255,255,.05)}';
var _TTS_NIGHT_CLASS = 'zimi-tts-night';
function _ttsStyle(doc) {
  if (doc.getElementById(_TTS_HL_STYLE) || !doc.head) return;
  var style = doc.createElement('style');
  style.id = _TTS_HL_STYLE; style.textContent = _TTS_HL_CSS;
  doc.head.appendChild(style);
}
var _TTS_TAP_MS = 600, _TTS_TAP_SLOP = 10; // a touch this short and this still (px) is a tap
var _TTS_TAP_CLICK_MS = 700; // a click this soon after a touch read as a tap is that tap
var _ttsTouchedAt = 0; // when a touch was last read as a tap
var _TTS_VIEW_TOP = 56;     // px: a sentence above this has left the view
var _TTS_VIEW_BOTTOM = 120; // px kept clear at the foot, where the reading bar floats
var _TTS_VIEW_AT = 0.28;    // share of the height a sentence is brought up to
var _TTS_HIT_X = 10, _TTS_HIT_Y = 14; // px: a tap this near a sentence's text is on it
var _TTS_SCROLL_KEYS = ' ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End  ';
// Not a tap on text: what a tap does something else with.
var _TTS_TAP_SKIP = 'a[href],button,input,select,textarea,label,summary,video,audio,[contenteditable],.zimi-zoomable,.zimi-img-lightbox,.zb-bar,.zb-sheet,.zb-scrim';
var _ttsRead = null; // the reading in progress: its plan, its document, whether the page follows

// The text of ``main`` as it is read: the text nodes in order (none of script,
// style or hidden text), a _TTS_BLOCK between blocks and at each <br>. A
// piece is a text node and where it starts in the text.
function _ttsReadModel(doc, main, all) {
  var win = doc.defaultView, parts = [], pieces = [], index = new Map(), len = 0, said = 0, blockAt = 0, fresh = true, label = false; // said: letters so far, without the page's indentation
  function split() {
    if (label && said - blockAt <= _TTS_LABEL_MAX) { if (len && /\S$/.test(parts[parts.length - 1])) { parts.push(' '); len++; } return; } // "Area:" and its value are one sentence
    fresh = true;
    if (len && parts[parts.length - 1] !== _TTS_BLOCK) { parts.push(_TTS_BLOCK); len++; }
  }
  function walk(el) {
    var cs = win.getComputedStyle(el), tag = el.localName;
    // A book lays out one section at a time and hides the others: they are still its text, as is a closed panel's.
    if (_TTS_SKIP_TAGS.indexOf(' ' + tag + ' ') >= 0 || (cs.display === 'none' && !el.classList.contains('zb-sec') && !(!all && _ttsPanel(el)))) return;
    if (!all && el !== main && ((el.matches && el.matches(_TTS_SKIP_SEL)) || _ttsChrome(el) || _ttsCode(el)) && !_ttsLayoutTable(el)) return;
    var block = cs.display.indexOf('inline') !== 0 && cs.display !== 'contents', shown = cs.visibility === 'visible';
    if (block || tag === 'br') split();
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) walk(n);
      else if (n.nodeType === 3 && shown && n.data) {
        index.set(n, pieces.length);
        pieces.push({ node: n, at: len });
        var solid = n.data.replace(/\s+/g, '').length;
        if (fresh && solid) { blockAt = said; fresh = false; }
        parts.push(n.data); len += n.data.length; said += solid;
        if (solid) label = /:\s*$/.test(n.data);
      }
    }
    if (block) split();
  }
  walk(main);
  return { doc: doc, main: main, text: parts.join(''), pieces: pieces, index: index };
}
// The piece holding offset ``off`` of the text: the last that starts at or before it.
function _ttsPieceAt(model, off) {
  var p = model.pieces, lo = 0, hi = p.length - 1;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (p[mid].at <= off) lo = mid; else hi = mid - 1; }
  return p[lo];
}
// The DOM Range of text[s, e).
function _ttsRange(model, s, e) {
  var a = _ttsPieceAt(model, s), b = _ttsPieceAt(model, e - 1), r = model.doc.createRange();
  r.setStart(a.node, s - a.at); r.setEnd(b.node, e - b.at);
  return r;
}
// Where a point of the DOM is in the text: a text node's own offset, else the
// start of the first text from that point on (the end of the text past it).
function _ttsOffsetOf(model, node, off) {
  var i = model.index.get(node);
  if (i !== undefined) return model.pieces[i].at + off;
  var ref = node.nodeType === 1 ? node.childNodes[off] : node;
  function from(n) {
    if (ref) return ref === n || ref.contains(n) || !!(ref.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    return !node.contains(n) && !!(node.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  var p = model.pieces, lo = 0, hi = p.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (from(p[mid].node)) hi = mid; else lo = mid + 1; }
  return lo < p.length ? p[lo].at : model.text.length;
}
// What is selected in the article, as [start, end) of the text, or null.
function _ttsSelectedSpan(model) {
  var win = model.doc.defaultView, sel = win && win.getSelection && win.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  var r = sel.getRangeAt(0);
  var a = _ttsOffsetOf(model, r.startContainer, r.startOffset), b = _ttsOffsetOf(model, r.endContainer, r.endOffset);
  return a < b && /\S/.test(model.text.slice(a, b).replace(_TTS_BLOCK, '')) ? [a, b] : null;
}
// Which sentence of a chunk is being said ``ch`` characters into what the
// voice says of it.
function _ttsSpanAtChar(chunk, ch) {
  var pos = 0;
  for (var i = 0; i < chunk.spans.length; i++) {
    pos += chunk.spans[i].n;
    if (ch < pos) return i;
    pos++; // the space the chunk joins its sentences with
  }
  return chunk.spans.length - 1;
}
// The sentence of the text at offset ``off`` (the next, when it is between two),
// as {s, e}: the sentences of its block, so a tap costs one block, not the article.
function _ttsSentenceAt(model, off) {
  var t = model.text, hit = null;
  off = Math.min(off, t.length - 1);
  var a = t.lastIndexOf(_TTS_BLOCK, off - 1) + 1, b = t.indexOf(_TTS_BLOCK, off);
  var sp = _ttsSentenceSpans(t, a, b < 0 ? t.length : b, _ttsLang(model.doc));
  for (var i = 0; i < sp.length; i++) {
    hit = { s: sp[i][0], e: sp[i][1] };
    if (sp[i][1] > off) break;
  }
  return hit;
}
// How far to scroll (px, down is positive) to keep a sentence in view of a
// ``h`` px tall window: none while it is inside, else its top is brought up
// to a quarter or so of the way down (so the page moves once per screenful,
// not once per sentence).
function _ttsScrollBy(rect, h) {
  if (rect.top >= _TTS_VIEW_TOP && rect.bottom <= h - _TTS_VIEW_BOTTOM) return 0;
  return Math.round(rect.top - h * _TTS_VIEW_AT);
}
// Whether a point is on the text of a sentence's rects, give or take a line's gap.
function _ttsOnText(rects, x, y) {
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    if (x >= r.left - _TTS_HIT_X && x <= r.right + _TTS_HIT_X && y >= r.top - _TTS_HIT_Y && y <= r.bottom + _TTS_HIT_Y) return true;
  }
  return false;
}

// What to read: the selection if there is one, else (in a book) from the
// page that is open, else all of the article.
function _ttsMakePlan(doc) {
  var main = _readerMainContent(doc) || doc.body;
  if (!main) return null;
  var model = _ttsReadModel(doc, main), sel = _ttsSelectedSpan(model), a = 0, b = model.text.length;
  // A selection inside what a reading skips (a table cell, a caption), or a page
  // that is nothing else: then those are read too, rather than the wrong thing or nothing.
  var win = doc.defaultView, picked = win && win.getSelection && win.getSelection();
  if ((picked && !picked.isCollapsed && picked.rangeCount && !sel) || !/[^\s\u2029]/.test(model.text)) {
    model = _ttsReadModel(doc, main, true); sel = _ttsSelectedSpan(model); b = model.text.length;
  }
  if (sel) { a = sel[0]; b = sel[1]; }
  else if (doc.__zbHere) {
    var at = doc.__zbHere();
    if (at) a = Math.max(0, _ttsOffsetOf(model, at.startContainer, at.startOffset));
  }
  return _ttsPlanFrom(model, a, b, !!sel);
}
function _ttsPlanFrom(model, a, b, sel) {
  var chunks = _ttsPlanChunks(model.text, _TTS_CHUNK_MAX, _TTS_FIRST_CHUNK_MAX, a, b, _ttsLang(model.doc));
  return chunks.length ? { doc: model.doc, model: model, chunks: chunks, b: b, sel: sel } : null;
}

// ── marking and following ──
function _ttsHlOk(win) { return !!(win && win.CSS && win.CSS.highlights && win.Highlight); }
function _ttsPaint(ranges) {
  var st = _ttsRead, win = st && st.win;
  if (!_ttsHlOk(win)) return;
  try {
    // One Highlight for the reading, its old ranges taken out one by one:
    // Safari repaints the text of a range it is told to remove, but neither a
    // replaced Highlight nor clear() repaints what was marked, which stays
    // tinted (Eric, 2026-10-20: "It keeps previous sections highlighted";
    // 2026-10-21, after clear(): three sentences still marked).
    if (st.hl) Array.from(st.hl).forEach(function(r) { st.hl.delete(r); });
    if (!ranges.length) { win.CSS.highlights.delete(_TTS_HL); return; }
    _ttsStyle(st.doc);
    st.doc.documentElement.classList.toggle(_TTS_NIGHT_CLASS, _nightRedOn());
    if (!st.hl) st.hl = new win.Highlight();
    ranges.forEach(function(r) { st.hl.add(r); });
    if (win.CSS.highlights.get(_TTS_HL) !== st.hl) win.CSS.highlights.set(_TTS_HL, st.hl);
  } catch (e) {}
}
// The reading is at chunk ``idx``, in its sentence ``k`` (null: not known
// yet, so the whole chunk is marked).
function _ttsAlongAt(idx, k) {
  var st = _ttsRead, chunk = st && st.plan.chunks[idx];
  if (!chunk || st.key === idx + ':' + k) return;
  st.key = idx + ':' + k;
  try {
    st.ranges = (k == null ? chunk.spans : [chunk.spans[k]]).map(function(sp) { return _ttsRange(st.plan.model, sp.s, sp.e); });
  } catch (e) { return; }
  _ttsPaint(st.ranges);
  _ttsFollow(false);
}
// Where in a chunk the audio is, by the share of it played.
function _ttsAlongAudio(idx, audio) {
  var st = _ttsRead, chunk = st && st.plan.chunks[idx], d = audio.duration;
  if (chunk) _ttsAlongAt(idx, d > 0 && isFinite(d) ? _ttsSpanAtChar(chunk, audio.currentTime / d * chunk.text.length) : null);
}
// The browser's voice says where it is by the character it reached
// (``boundary``); where it never does, the whole chunk stays marked. A word
// highlight would plug in here: neither engine's audio carries word times.
function _ttsAlongChar(idx, ch) {
  var st = _ttsRead, chunk = st && st.plan.chunks[idx];
  if (chunk) _ttsAlongAt(idx, _ttsSpanAtChar(chunk, ch));
}
// A sentence inside a closed panel has no place on the page: open the panel as
// a tap on its heading does. True when one was opened.
function _ttsOpenPanel(range) {
  var win = range.startContainer.ownerDocument.defaultView;
  for (var el = range.startContainer.parentElement; el; el = el.parentElement) {
    var head = _ttsPanelHead(el);
    if (head && win.getComputedStyle(el).display === 'none') { head.click(); return true; }
  }
  return false;
}
// Keep the sentence in view. Only while following; once the person has moved
// the page, the reading follows again when it comes back to what is in view.
function _ttsFollow(force) {
  var st = _ttsRead, rs = st && st.ranges;
  if (!rs || !rs.length) return;
  var win = st.win, doc = st.doc, paged = doc.documentElement.classList.contains('zb-paged'), moved = false;
  try {
    if (paged) {
      var rc = rs[0].getClientRects()[0], seen = !!rc && rc.width > 0 && rc.left >= 0 && rc.left < win.innerWidth;
      if (seen) { st.following = true; return; }
      if (!force && !st.following) return;
      if (doc.__zbShowRange) { doc.__zbShowRange(rs[0]); moved = true; }
    } else {
      var box = rs[0].getBoundingClientRect(), end = rs[rs.length - 1].getBoundingClientRect();
      if (!box.width && !box.height && _ttsOpenPanel(rs[0])) { setTimeout(function() { if (_ttsRead === st) _ttsFollow(false); }, _TTS_PANEL_OPEN_MS); return; }
      var scr = _scrollerOf(rs[0].startContainer.parentElement, win), cr = scr ? scr.getBoundingClientRect() : { top: 0, height: win.innerHeight };
      var by = _ttsScrollBy({ top: box.top - cr.top, bottom: end.bottom - cr.top }, cr.height);
      if (!by && !force) { st.following = true; return; }
      if (!force && !st.following) return;
      if (by) {
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        (scr || win).scrollBy({ top: by, behavior: reduce ? 'auto' : 'smooth' });
      }
      moved = true;
    }
  } catch (e) { return; }
  if (moved) { st.following = true; _ttsBarSync(); }
}
// The person moved the page: stop following until they ask or it comes back.
function _ttsLose() {
  if (_ttsRead && _ttsRead.following) { _ttsRead.following = false; _ttsBarSync(); }
}
function _ttsFollowResume() {
  if (_ttsRead) { _ttsRead.following = true; _ttsFollow(true); _ttsBarSync(); }
}
// A tap on a sentence moves the reading there.
function _ttsTap(e) {
  var st = _ttsRead, t = e.target;
  if (!st || e.defaultPrevented || e.button || !t || !t.closest || t.closest(_TTS_TAP_SKIP)) return;
  var win = st.win, sel = win.getSelection && win.getSelection();
  if (sel && !sel.isCollapsed && String(sel).trim()) return;
  // A book on pages turns them with a tap at either edge.
  if (st.doc.documentElement.classList.contains('zb-paged') && (e.clientX < win.innerWidth * _BOOK_EDGE || e.clientX > win.innerWidth * (1 - _BOOK_EDGE))) { _ttsLose(); return; }
  var at = _bookCaretAt(st.doc, e.clientX, e.clientY);
  if (!at) return;
  var model = st.plan.model, off = _ttsOffsetOf(model, at.node, at.off), sp = _ttsSentenceAt(model, off);
  if (!sp) return;
  var rects;
  try { rects = _ttsRange(st.plan.model, sp.s, sp.e).getClientRects(); } catch (err) { return; }
  if (!_ttsOnText(rects, e.clientX, e.clientY)) return;
  var plan = _ttsPlanFrom(model, sp.s, st.plan.b, false);
  if (plan) _ttsSpeak(0, plan);
}
// The bar's back button, as a player's: the first tap starts this sentence
// again, a second soon after goes to the one before (Eric, 2026-10-21).
var _TTS_BACK_AGAIN_MS = 3000, _ttsBackAt = 0;
function _ttsBack() {
  var now = Date.now(), again = now - _ttsBackAt < _TTS_BACK_AGAIN_MS;
  _ttsBackAt = now;
  _ttsStep(again ? -1 : 0);
}
// The reading moved a sentence from the one being read, as a tap on that
// sentence would move it: ``dir`` -1 the one before (the first starts again),
// 1 the next (none after the last), 0 this one again.
function _ttsStep(dir) {
  var st = _ttsRead;
  if (!st) return;
  var key = String(st.key).split(':'), chunk = st.plan.chunks[+key[0] || 0];
  var cur = chunk && chunk.spans[key[1] === 'null' || key[1] == null ? 0 : +key[1]];
  if (!cur) return;
  // The whole sentence: a long one is said in pieces, each a span of its own.
  var model = st.plan.model, t = model.text;
  cur = _ttsSentenceAt(model, cur.s) || cur;
  var sp = cur;
  if (dir) {
    var o = dir < 0 ? cur.s - 1 : cur.e;
    while (o >= 0 && o < t.length && /\s/.test(t[o])) o += dir < 0 ? -1 : 1;
    if (o >= st.plan.b) return;
    sp = o < 0 ? cur : _ttsSentenceAt(model, o);
  }
  var plan = sp && _ttsPlanFrom(model, sp.s, st.plan.b, false);
  if (plan) _ttsSpeak(0, plan);
}
// While it reads, the article is listened to: a hand on the page (wheel,
// finger, scroll keys, the scrollbar) is the person moving it; a tap seeks.
function _ttsAlongBegin(plan) {
  var doc = plan.doc, win = doc.defaultView, off = [];
  function on(type, fn, opts) { doc.addEventListener(type, fn, opts); off.push(function() { doc.removeEventListener(type, fn, opts); }); }
  var moved = { passive: true, capture: true };
  on('wheel', _ttsLose, moved);
  on('touchmove', _ttsLose, moved);
  on('keydown', function(e) { if (_TTS_SCROLL_KEYS.indexOf(' ' + e.key + ' ') >= 0) _ttsLose(); }, moved);
  on('mousedown', function(e) { if (e.clientX >= doc.documentElement.clientWidth) _ttsLose(); }, moved);
  on('click', function(e) { if (Date.now() - _ttsTouchedAt > _TTS_TAP_CLICK_MS) _ttsTap(e); }, false);
  on('scroll', function() { if (_ttsRead && !_ttsRead.following) _ttsFollow(false); }, moved);
  // A tap on a phone is read from the touch itself: iOS sends a tap on plain
  // text no click on many pages (Wikivoyage's), so a click was never heard
  // there. One that does follow the touch is the same tap, and passes.
  var touch = null;
  on('touchstart', function(e) { var c = e.touches && e.touches.length === 1 && e.touches[0]; touch = c ? { x: c.clientX, y: c.clientY, at: Date.now() } : null; }, moved);
  on('touchend', function(e) {
    var c = e.changedTouches && e.changedTouches[0], was = touch;
    touch = null;
    if (!was || !c || Date.now() - was.at > _TTS_TAP_MS || Math.abs(c.clientX - was.x) > _TTS_TAP_SLOP || Math.abs(c.clientY - was.y) > _TTS_TAP_SLOP) return;
    _ttsTouchedAt = Date.now();
    _ttsTap({ target: e.target, clientX: c.clientX, clientY: c.clientY, button: 0, defaultPrevented: e.defaultPrevented });
  }, false); // bubbling, as the click was: a page that took the tap (preventDefault) keeps it
  _ttsStyle(doc);
  _ttsRead = { plan: plan, doc: doc, win: win, following: true, ranges: null, key: '', off: off };
  if (plan.sel) { try { win.getSelection().removeAllRanges(); } catch (e) {} } // the mark takes its place
}
function _ttsAlongEnd() {
  var st = _ttsRead;
  if (!st) return;
  _ttsPaint([]);
  st.off.forEach(function(f) { f(); });
  _ttsRead = null;
}
function _ttsSetSpeaking(on) {
  _ttsSpeaking = on;
  if (!on) _ttsAlongEnd();
  _bookReadSync(_ttsFrameDoc());
  _syncTopbarMenuReaderItems(); // mobile: reflect speaking-state on the ... menu row
  _ttsBarSync();
  var btn = document.getElementById('tts-btn');
  if (!btn) return;
  btn.classList.toggle('speaking', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  var label = on ? t('tts_stop') : t('tts_speak');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
function _ttsStop() {
  _ttsRun++;
  _ttsLetGoAll();
  _ttsPaused = false;
  _ttsHeld = null;
  if (_ttsAudio) {
    try { _ttsAudio.pause(); _ttsAudio.removeAttribute('src'); _ttsAudio.load(); } catch(e) {}
  }
  if (_TTS_AVAILABLE) { try { window.speechSynthesis.cancel(); } catch(e) {} }
  if (_ttsSpeaking) _ttsSetSpeaking(false);
}
// ``from``: a chunk of the reading in progress (a new voice or speed goes on
// from it); none starts afresh, with the selection if there is one. ``plan``:
// what to read, when it is not that (a tap on a sentence).
function _ttsSpeak(from, plan) {
  if (!_ttsCanSpeak()) return;
  var doc = _ttsFrameDoc();
  if (!doc) return;
  plan = plan || (from != null && _ttsRead && _ttsRead.doc === doc && _ttsRead.plan) || _ttsMakePlan(doc);
  if (!plan) return;
  from = from || 0;
  var chunks = plan.chunks.map(function(c) { return c.text; });
  var lang = _ttsLang(doc);
  _ttsStop(); // clear any residual queue or audio before starting fresh
  _ttsAlongBegin(plan);
  var engines = _ttsServerEngines(lang);
  if (!engines.length && !_TTS_AVAILABLE) return;
  _ttsSetSpeaking(true);
  _setStorageJSON(SK.TTS_LAST_USE, Date.now());
  // A chosen voice reads alone and, if it cannot keep up, is offered a faster
  // one; only Automatic moves on to the next engine by itself.
  var chosen = engines.length === 1 && engines[0] === _ttsChosenVoice();
  from = Math.min(from, chunks.length - 1);
  // Marked now, where it starts or was moved to, not when the voice gets there:
  // a slow voice can take seconds over a sentence, and the page sat unmarked
  // (Eric, 2026-10-21: "tapping to another spot highlight is gone").
  _ttsAlongAt(from, 0);
  _ttsNow = { at: from, engine: engines[0] || _DEVICE_VOICE, playing: false, spin: false, lang: lang, ahead: 0, readyAt: 0, aheadOf: 0 };
  _ttsHold();
  if (engines.length) _ttsSpeakServer(chunks, lang, engines, ++_ttsRun, chosen ? function(e) { _ttsSuggestFaster(lang, e); } : null, from);
  else _ttsSpeakDevice(chunks, lang, from);
}
// This browser's own voices, from chunk ``from`` on.
function _ttsSpeakDevice(chunks, lang, from) {
  var synth = window.speechSynthesis;
  synth.cancel();
  // A cancelled utterance reports its end or error later, after the next reading
  // has begun (a seek, a sentence step, a new speed): those belong to an older run.
  var run = _ttsRun;
  function live() { return run === _ttsRun; }
  chunks.slice(from).forEach(function(chunk, idx, rest) {
    var u = new SpeechSynthesisUtterance(chunk);
    if (lang) u.lang = lang;
    u.rate = _ttsRate();
    u.onstart = function() { if (!live()) return; clearTimeout(_ttsSpinTimer); _ttsNow.at = from + idx; _ttsNow.engine = _DEVICE_VOICE; _ttsNow.playing = true; _ttsNow.spin = false; _ttsAlongAt(from + idx, null); _ttsBarSync(); };
    u.onboundary = function(e) { if (live()) _ttsAlongChar(from + idx, e.charIndex); };
    if (idx === rest.length - 1) u.onend = function() { if (live()) _ttsSetSpeaking(false); };
    u.onerror = function(e) { if (live() && !(e && (e.error === 'interrupted' || e.error === 'canceled'))) _ttsSetSpeaking(false); };
    synth.speak(u);
  });
}
// The server's voices: one <audio> element plays the chunks in turn. Its src
// is set and played inside the tap for the first chunk, as iOS requires (an
// element started in a tap may play again from its own events).
// The blob URLs of the reading in progress, given back when it is superseded
// (a stop, a seek, a step, a new voice or speed all end a run without its own
// chunk-by-chunk cleanup running): each is a clip of several hundred KB.
var _ttsLetGo = null;
function _ttsLetGoAll() {
  var f = _ttsLetGo;
  _ttsLetGo = null;
  if (f) f();
}
function _ttsSpeakServer(chunks, lang, engines, run, onSlow, from) {
  _ttsLetGoAll();
  var audio = _ttsAudio || (_ttsAudio = new Audio());
  var i = from || 0, eng = 0, retried = false, waiting = null, told = false;
  var started = false; // a word has been heard in this engine
  var heard = 0; // characters this engine has said; past _TTS_SETTLED_CHARS it stays
  var asked = {}; // chunk index -> true once the server has said it (or failed to)
  // The audio of chunks asked for ahead, kept in this page: the next sentence
  // starts from memory, not with a request of its own (Eric, 2026-10-22: "no
  // zero gap sentence ... we can get them ready in advance").
  var ready = {};
  var waits = _ttsWaits(), pace = _ttsPace(engines[0]), making = false, holding = -1;
  var tookS = 0, tookChars = 0; // what this reading's chunks took to make, in all
  // The requests asked of the engine reading now, called off when it gives way.
  var calls = typeof AbortController !== 'undefined' ? new AbortController() : null;
  function live() { return run === _ttsRun; }
  function letGo(below) {
    Object.keys(ready).forEach(function(k) { if (below == null || +k < below) { try { URL.revokeObjectURL(ready[k]); } catch (e) {} delete ready[k]; } });
  }
  _ttsLetGo = function() { letGo(); };
  // Too slow here: the next engine for the language says the rest, and this
  // one is tried last from now on.
  function slower() {
    _ttsMarkSlow(engines[eng]);
    eng++;
    asked = {};
    started = false; heard = 0; retried = false;
    if (calls) { calls.abort(); calls = new AbortController(); }
    letGo();
  }
  function settled() { return heard >= _TTS_SETTLED_CHARS; }
  // Ask for chunk ``idx`` ahead of time; the server keeps what it said, so
  // the <audio> element then gets it at once.
  // A chosen voice (``onSlow``) keeps reading; the person is told once.
  function tooSlow() {
    if (onSlow && !told) { told = true; onSlow(engines[eng]); }
  }
  // Late once words were heard: Automatic remembers the engine as slow for
  // the next reading; a chosen voice is offered a faster one instead.
  function late() {
    if (!onSlow) _ttsMarkSlow(engines[eng]);
    tooSlow();
  }
  // ``done`` (waiting for the voice): called once the server answered, so
  // the next chunk is asked for.
  function ask(idx, done) {
    if (idx >= chunks.length || asked[idx] !== undefined) return;
    var engine = engines[eng], began = Date.now();
    var next = function() { if (done && live()) done(); };
    var later = function() { setTimeout(function() { if (!live()) return; if (done) done(); else ask(idx); }, _TTS_SERVER_RETRY_MS); };
    asked[idx] = false;
    authedFetch(_ttsSpeakUrl(chunks[idx], lang, engine), calls ? { signal: calls.signal } : undefined).then(function(r) {
      if (!live()) return;
      if (r.status === 503) {
        delete asked[idx]; // busy: ask again shortly
        later();
        return;
      }
      if (engines[eng] !== engine) return;
      asked[idx] = true;
      if (!r.ok || typeof URL === 'undefined' || !URL.createObjectURL) { next(); if (waits) hold(); return; }
      return r.blob().then(function(b) {
        if (!live() || engines[eng] !== engine) return;
        if (idx > i || (waits && idx >= i)) ready[idx] = URL.createObjectURL(b);
        if (!waits) return;
        // This server's pace, as this reading finds it: time over
        // characters in all, so a short chunk's fixed cost counts as often
        // as it is paid without one heading swinging the estimate.
        var took = (Date.now() - began) / 1000;
        if (took >= _TTS_WORK_MIN_S) {
          tookS += took; tookChars += chunks[idx].length;
          if (tookChars >= _TTS_WORK_MIN_CHARS) pace.work = tookS / tookChars;
        }
        next();
        hold();
      });
    }).catch(function(e) {
      if (!live() || (e && e.name === 'AbortError')) return; // gave way: asked anew of the next
      delete asked[idx]; if (done) later();
    });
  }
  // Waiting for the voice: the server is never idle while there is a chunk
  // to make and room to keep it.
  function make() {
    if (!waits || making || !live()) return;
    for (var j = i, kept = 0; j < chunks.length; j++) {
      if (ready[j]) { kept += pace.audio * chunks[j].length; if (kept >= _TTS_WAIT_KEEP_S) return; continue; }
      if (asked[j] !== undefined) continue; // made and lost, or being made
      making = true;
      ask(j, function() { making = false; make(); });
      return;
    }
  }
  // Waiting for the voice: chunk ``idx`` plays once enough is ready ahead of
  // it; until then the bar says how long, and the chunks are made.
  function hold(idx) {
    if (!live()) return;
    if (idx === undefined) { if (holding < 0) return; idx = holding; }
    make();
    var end = _ttsLeadEnd(chunks, idx, pace, _ttsRate()), left = 0;
    for (var k = idx; k <= end; k++) if (!ready[k] && asked[k] !== true) left += (pace.work || 0) * chunks[k].length;
    if (left > 0 || (!ready[idx] && asked[idx] !== true) || _ttsPaused) {
      // The wait from here: counted down each second between chunks, and
      // the whole of it kept, so the ring says how much is done.
      var fresh = holding !== idx || !_ttsNow.readyAt;
      _ttsNow.readyAt = Date.now() + left * 1000;
      _ttsNow.aheadOf = fresh ? left : Math.max(_ttsNow.aheadOf, left);
      holding = idx; _ttsHeld = function() { hold(idx); };
      if (_ttsNow.at !== idx || _ttsNow.playing || _ttsNow.ahead !== Math.ceil(left)) {
        _ttsNow.at = idx; _ttsNow.ahead = Math.ceil(left); _ttsHold();
      }
      _ttsAheadTick();
      return;
    }
    holding = -1; _ttsHeld = null; _ttsNow.ahead = 0; _ttsNow.readyAt = 0;
    play(idx);
  }
  function play(idx) {
    // Not ready when it is needed: the voice waits. Once a sentence's worth
    // was heard (_TTS_SETTLED_CHARS) it stays (a new voice mid-article is worse than a pause, Eric
    // 2026-10-19: "can sound different between them"), and only a silence
    // as long as the start wait marks it slow: a heading is a clip of a
    // second, often over before the next is made (Eric, 2026-10-21: "clear
    // was fine it didn't even take that long before I got that message").
    audio.defaultPlaybackRate = _ttsRate(); // a new src starts at this rate
    letGo(idx);
    audio.src = ready[idx] || _ttsSpeakUrl(chunks[idx], lang, engines[eng]);
    audio.playbackRate = _ttsRate();
    _ttsNow.at = idx; _ttsNow.engine = engines[eng];
    _ttsHold();
    var p = audio.play();
    // AbortError: this play() was cut short by the next src (a switch of
    // engine, or the next chunk), which is not a failure.
    if (p && p.catch) p.catch(function(e) { if (live() && !(e && e.name === 'AbortError')) fail(); });
    // Still silent after a while: until it settled, the next engine says it
    // instead; after, the voice stays and is marked slow.
    clearTimeout(waiting);
    if (!waits && (eng + 1 < engines.length || onSlow)) {
      waiting = setTimeout(function() {
        if (!live() || i !== idx || !audio.paused || _ttsPaused) return;
        if (!settled() && eng + 1 < engines.length) { slower(); play(idx); }
        else if (started) late(); else tooSlow();
      }, started ? _TTS_START_WAIT_MS : _ttsStartWait(engines[eng]));
    }
  }
  function fail() {
    // Once more after a moment (the server may have been busy), then this
    // browser's voices for the rest, or stop when it has none.
    if (!retried) {
      retried = true;
      setTimeout(function() { if (live()) play(i); }, _TTS_SERVER_RETRY_MS);
      return;
    }
    // Then the next of the server's voices, before this browser's (#121: a
    // busy Natural gave the article to the browser while Clear was ready).
    if (eng + 1 < engines.length) { slower(); play(i); return; }
    _ttsRun++;
    letGo();
    if (_TTS_AVAILABLE) _ttsSpeakDevice(chunks, lang, i);
    else _ttsSetSpeaking(false);
  }
  audio.onplaying = function() {
    if (!live()) return;
    clearTimeout(waiting); retried = false; started = true;
    if (waits) make();
    else for (var k = 1, n = _ttsPace(engines[eng]).work === null ? _TTS_AHEAD_UNMEASURED : _TTS_AHEAD; k <= n; k++) ask(i + k);
    clearTimeout(_ttsSpinTimer);
    _ttsNow.playing = true; _ttsNow.spin = false; _ttsBarSync();
    _ttsAlongAudio(i, audio);
  };
  audio.ontimeupdate = function() { if (live()) _ttsAlongAudio(i, audio); };
  audio.onended = function() {
    if (!live()) return;
    heard += chunks[i].length;
    i++;
    if (i >= chunks.length) { letGo(); _ttsRun++; _ttsSetSpeaking(false); return; }
    if (waits && !ready[i]) hold(i); // ran dry: get ahead again
    else play(i);
  };
  audio.onerror = function() { if (live() && audio.getAttribute('src')) fail(); };
  if (waits) hold(i);
  else play(i);
}
// Waiting for the voice to get ahead: what Resume does instead of playing
// the clip that ended (set by _ttsSpeakServer while it holds).
var _ttsHeld = null;
// The countdown between chunks: a second at a time toward readyAt, never
// below 1 s until the chunks say it is ready.
var _ttsAheadTimer = 0;
function _ttsAheadTick() {
  clearTimeout(_ttsAheadTimer);
  if (!_ttsSpeaking || _ttsNow.playing || !_ttsNow.readyAt) return;
  _ttsNow.ahead = Math.max(1, Math.ceil((_ttsNow.readyAt - Date.now()) / 1000));
  _ttsBarSync();
  _ttsAheadTimer = setTimeout(_ttsAheadTick, 1000);
}
// How much of the wait is done, 0 to 1, for the ring.
function _ttsAheadDone() {
  if (!_ttsNow.aheadOf) return 0;
  return Math.min(1, Math.max(0, 1 - (_ttsNow.readyAt - Date.now()) / 1000 / _ttsNow.aheadOf));
}
function _ttsToggle() {
  if (_ttsSpeaking) _ttsStop();
  else _ttsSpeak();
}

// ── While it reads: a bar at the foot of the reader ──
// On a phone Read aloud is a row in the ⋯ menu, so once the menu closed
// nothing said a reading had begun, that it waited for the server's voice, or
// which voice it was. The bar says all three (a turning ring until the first
// sound, then the voice), offers this language's voices where it plays
// (remembered as Read aloud's own, Settings > Voices), and stops it.
var _ttsNow = { at: 0, engine: '', playing: false, spin: false, lang: '', ahead: 0, readyAt: 0, aheadOf: 0 }; // ahead: seconds until it has got far enough ahead (at readyAt, of aheadOf in all)
// Between sentences, or a sentence started again, the bar holds still; the
// ring turns only for a wait long enough to notice (Eric, 2026-10-22:
// "should hide unless it's a longer wait (seamless ui)").
var _TTS_SPIN_AFTER_MS = 700, _ttsSpinTimer = 0;
function _ttsHold() {
  clearTimeout(_ttsSpinTimer);
  _ttsNow.playing = false; _ttsNow.spin = false;
  _ttsBarSync();
  _ttsSpinTimer = setTimeout(function() {
    if (_ttsSpeaking && !_ttsNow.playing) { _ttsNow.spin = true; _ttsBarSync(); }
  }, _TTS_SPIN_AFTER_MS);
}
var _ttsMenuOpen = ''; // the bar's open menu: '', 'voice' or 'speed'
var _ttsPaused = false;
var _TTS_RATE_STOPS = [1, 1.5, 2]; // a finger within _TTS_RATE_SNAP of one lands on it
var _TTS_RATE_SNAP = 0.05;
var _TTS_RATE_MARKS = [0.5, 1, 1.5, 2, 3]; // named under the slider, a tap each
var _TTS_SPEED_SETTLE_MS = 700; // the voice is asked about once the speed stops moving
var _ttsSliding = false; // a finger is on the slider: the bar is not redrawn under it
var _TTS_CHEVRON = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
var _TTS_PAUSE_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
var _TTS_PLAY_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.6A1 1 0 0 0 8 5.5z"/></svg>';
// Back a sentence: a turning arrow, as a player's replay, not a skip (Eric,
// 2026-10-21: "just one back rewindish circle to restart from previous sentence").
var _TTS_BACK_ICON = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4v6h6"/><path d="M3.5 15a8.5 8.5 0 1 0 2-8.8L3 10"/></svg>';
// Where the reading is: shown in place of the bars once the page was moved away from it.
var _TTS_LOCATE_ICON = '<svg class="tts-locate" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
var _TTS_CLOSE_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
// The voices this article's language can be read in: the server's, in its
// order (none Settings turned off), then this browser's.
function _ttsVoicesFor(lang) {
  var row = ((_ttsVoices && _ttsVoices.langs) || {})[_normLang(_langPrimary(lang))];
  var out = row ? _ttsRowOrder(row, _voicePrefs()) : [];
  if (_TTS_AVAILABLE) out.push(_DEVICE_VOICE);
  return out;
}
// The voice reading, by its name alone: (Too slow) is for choosing one, in
// the voice list, not the bar, where it has no room (Eric, 2026-10-21).
// Paused is paused: the bar says getting ahead only while the reading is going on.
function _ttsAheadShown() { return _ttsNow.ahead > 0 && !_ttsNow.playing && !_ttsPaused; }
function _ttsVoiceLabel() {
  var name = _voiceEngineName(_ttsNow.engine);
  return _ttsAheadShown() ? t('tts_getting_ahead', { voice: name, s: fmtNum(_ttsNow.ahead) }) : name;
}
// The speed sheet: a slider (the bar's button says the speed), the marks
// under it each a tap away. Arrow keys step 0.05 and never snap.
function _ttsSpeedHtml(rate) {
  var at = function(r) { return ((r - _TTS_RATE_MIN) / (_TTS_RATE_MAX - _TTS_RATE_MIN)).toFixed(4); };
  return '<div class="tts-bar-menu tts-speed" role="group" aria-label="' + escAttr(t('tts_speed')) + '">' +
    '<input type="range" class="tts-speed-range" style="--fill:' + at(rate) + '" min="' + _TTS_RATE_MIN + '" max="' + _TTS_RATE_MAX + '" step="' + _TTS_RATE_STEP +
      '" value="' + rate + '" aria-label="' + escAttr(t('tts_speed')) + '" aria-valuetext="' + escAttr(_ttsRateLabel(rate)) + '"' +
      ' onpointerdown="_ttsSliding = true" onpointerup="_ttsSliding = false" onpointercancel="_ttsSliding = false"' +
      ' oninput="_ttsSlideSpeed(this)" onchange="_ttsSpeedChanged()">' +
    '<div class="tts-speed-marks">' + _TTS_RATE_MARKS.map(function(r) {
      return '<button type="button" style="--at:' + at(r) + '"' + (Math.abs(r - rate) < _TTS_RATE_EPS ? ' aria-current="true"' : '') +
        ' onclick="_ttsPickSpeed(' + r + ')">' + esc(_ttsRateLabel(r)) + '</button>';
    }).join('') + '</div></div>';
}
function _ttsBarHtml() {
  var pick = _voicePrefs().read || '';
  var voices = _ttsVoicesFor(_ttsNow.lang);
  var btn = function(cls, label, onclick, inner, extra) {
    return '<button type="button" class="' + cls + '" aria-label="' + escAttr(label) + '" title="' + escAttr(label) + '" onclick="' + onclick + '"' + (extra || '') + '>' + inner + '</button>';
  };
  var waiting = _ttsNow.ahead > 0 && !_ttsNow.playing, ahead = waiting && !_ttsPaused, working = waiting && _ttsPaused; // working: paused, and the voice still getting ahead
  var h = '<span class="tts-bar-state' + (ahead ? ' ahead' : working ? ' ahead working' : _ttsPaused ? ' paused' : _ttsNow.playing ? ' playing' : _ttsNow.spin ? '' : ' hold') + '"' +
    (ahead ? ' style="--p:' + _ttsAheadDone().toFixed(3) + '"' : '') + ' aria-hidden="true"><i></i><i></i><i></i>' + _TTS_LOCATE_ICON + '</span>';
  // A menu opens above the button it belongs to, its choices radio items.
  var menu = function(which, items) {
    if (_ttsMenuOpen !== which) return '';
    return '<div class="tts-bar-menu tts-bar-menu-' + which + '" role="menu">' + items.map(function(it) {
      return '<button type="button" role="' + (it[4] || 'menuitemradio') + '" aria-checked="' + it[0] + '"' + (it[3] ? ' data-slow' : '') + (it[4] ? ' class="tts-menu-check"' : '') +
        ' onclick="' + escAttr(it[1]) + '">' + esc(it[2] + (it[3] ? ' ' + t('tts_too_slow') : '')) + '</button>';
    }).join('') + '</div>';
  };
  if (voices.length > 1) {
    h += '<span class="tts-bar-anchor"><button type="button" class="tts-bar-voice" aria-haspopup="menu" aria-expanded="' + (_ttsMenuOpen === 'voice') + '" onclick="_ttsMenuToggle(\'voice\')">' +
      '<span>' + esc(_ttsVoiceLabel()) + '</span>' + _TTS_CHEVRON + '</button>' +
      menu('voice', [['' === pick, '_ttsPickVoice("")', t('voices_default_auto')]].concat(voices.map(function(e) {
        // Still pickable, but said (Eric, 2026-10-19: "a lil (Too Slow) beside the previous voice").
        return [e === pick, '_ttsPickVoice(' + JSON.stringify(e) + ')', _voiceEngineName(e), !_ttsWaits() && _ttsTooSlow(e)];
      }).concat(_ttsNow.engine === 'kokoro' || pick === 'kokoro'
        // Natural reading or picked: Patience, beside it (Eric, 2026-10-23).
        ? [[_ttsWaits(), '_ttsPickPatience(' + !_ttsWaits() + ')', t('voices_wait'), false, 'menuitemcheckbox']] : []))) + '</span>';
  } else {
    h += '<span class="tts-bar-voice">' + esc(_ttsVoiceLabel()) + '</span>';
  }
  var rate = _ttsRate();
  h += '<span class="tts-bar-anchor">' + btn('tts-bar-speed', t('tts_speed'), "_ttsMenuToggle('speed')", esc(_ttsRateLabel(rate)),
    ' aria-haspopup="true" aria-expanded="' + (_ttsMenuOpen === 'speed') + '"') +
    (_ttsMenuOpen === 'speed' ? _ttsSpeedHtml(rate) : '') + '</span>';
  // One way back, before pause: this sentence again, then the one before.
  h += btn('tts-bar-btn tts-bar-step', t('tts_prev_sentence'), '_ttsBack()', _TTS_BACK_ICON);
  h += btn('tts-bar-btn', t(_ttsPaused ? 'resume' : 'pause'), '_ttsPauseToggle()', _ttsPaused ? _TTS_PLAY_ICON : _TTS_PAUSE_ICON,
    ' aria-pressed="' + _ttsPaused + '"');
  h += btn('tts-bar-btn', t('tts_stop'), '_ttsStop()', _TTS_CLOSE_ICON);
  return h;
}
function _ttsBarSync() {
  var bar = document.getElementById('tts-bar');
  if (!_ttsSpeaking) {
    _ttsMenuOpen = '';
    if (bar) bar.hidden = true;
    return;
  }
  if (!bar) {
    var reader = document.getElementById('reader');
    if (!reader) return;
    bar = document.createElement('div');
    bar.id = 'tts-bar';
    bar.className = 'tts-bar';
    // The voice-state mark is also the way back to the sentence, once the page was moved.
    bar.addEventListener('click', function(e) { if (e.target.closest('.tts-bar-state.tts-lost')) _ttsFollowResume(); });
    reader.appendChild(bar);
  }
  if (_ttsSliding) return; // drawn when the finger lifts
  var html = _ttsBarHtml();
  if (bar._painted !== html) bar.innerHTML = bar._painted = html;
  var mark = bar.querySelector('.tts-bar-state'), lost = !!(_ttsRead && !_ttsRead.following);
  if (mark) {
    mark.classList.toggle('tts-lost', lost);
    if (lost) { mark.setAttribute('role', 'button'); mark.setAttribute('title', t('tts_follow')); mark.setAttribute('aria-label', t('tts_follow')); mark.removeAttribute('aria-hidden'); }
    else if (mark.classList.contains('ahead')) { mark.setAttribute('role', 'img'); mark.setAttribute('title', t('tts_ahead_label')); mark.setAttribute('aria-label', t('tts_ahead_label')); mark.removeAttribute('aria-hidden'); }
    else { ['role', 'title', 'aria-label'].forEach(function(a) { mark.removeAttribute(a); }); mark.setAttribute('aria-hidden', 'true'); }
  }
  bar.hidden = false;
}
function _ttsMenuToggle(which) {
  _ttsMenuOpen = _ttsMenuOpen === which ? '' : which;
  _ttsBarSync();
}
// A tap anywhere else, or Escape, closes the menu. A tap in the article
// never reaches this page, but it takes the focus: the window's blur.
function _ttsMenuAway(e) {
  if (!_ttsMenuOpen) return;
  if (e.type === 'keydown' && e.key !== 'Escape') return;
  if (e.type === 'pointerdown' && e.target && e.target.closest && e.target.closest('#tts-bar')) return;
  _ttsMenuOpen = '';
  _ttsBarSync();
}
document.addEventListener('pointerdown', _ttsMenuAway, true);
document.addEventListener('keydown', _ttsMenuAway, true);
window.addEventListener('blur', _ttsMenuAway);
// Pause keeps the place; Resume goes on from it. The engine's "still silent"
// switch waits while paused (_ttsSpeakServer).
function _ttsPauseToggle() {
  _ttsPaused = !_ttsPaused;
  var device = _ttsNow.engine === _DEVICE_VOICE;
  try {
    if (device) { if (_ttsPaused) window.speechSynthesis.pause(); else window.speechSynthesis.resume(); }
    else if (_ttsAudio) {
      if (_ttsPaused) _ttsAudio.pause();
      else if (_ttsHeld) _ttsHeld(); // still getting ahead: not the clip that ended
      else _ttsAudio.play().catch(function() {});
    }
  } catch (e) {}
  _ttsBarSync();
}
// A speed slid to or a mark tapped: remembered on this device. The
// server's audio changes speed where it is (its pitch kept); the browser's
// voice takes a rate per sentence, so it starts again from the sentence it is on.
// Any speed with any voice (Eric, 2026-10-20: "the info, ability to try any
// combo, and convenience of staying inside the lines"). On Automatic, a
// speed its voice pauses at hands the reading to one that keeps up, from the
// sentence it is at; a voice picked by name keeps reading, named (Too slow),
// and one that keeps up is offered.
function _ttsPickSpeed(r) {
  clearTimeout(_ttsSpeedTimer);
  _ttsMenuOpen = ''; // a number tapped is a choice made: the sheet closes
  _ttsApplySpeed(r);
  _ttsBarSync();
  _ttsSpeedSettled();
}
// While the slider moves, the speed takes hold at once where the audio plays
// and only the numbers change (a redrawn bar would drop the finger); the
// browser's own voice and the voice that keeps up wait for it to settle.
var _ttsSpeedTimer = 0;
function _ttsSlideSpeed(input) {
  var r = _ttsSnapRate(parseFloat(input.value));
  if (Math.abs(parseFloat(input.value) - r) > _TTS_RATE_EPS) input.value = r;
  _ttsApplySpeed(r);
  var label = _ttsRateLabel(r);
  input.setAttribute('aria-valuetext', label);
  if (input.style) input.style.setProperty('--fill', ((r - _TTS_RATE_MIN) / (_TTS_RATE_MAX - _TTS_RATE_MIN)).toFixed(4));
  document.querySelectorAll('#tts-bar .tts-bar-speed').forEach(function(el) { el.textContent = label; });
}
function _ttsSpeedChanged() {
  _ttsSliding = false;
  clearTimeout(_ttsSpeedTimer);
  _ttsSpeedTimer = setTimeout(function() { _ttsBarSync(); _ttsSpeedSettled(); }, _TTS_SPEED_SETTLE_MS);
}
// Under a finger a speed near a stop lands on it; keys reach every step.
function _ttsSnapRate(v) {
  var r = _ttsRateClamp(v);
  if (!_ttsSliding) return r;
  var stop = _TTS_RATE_STOPS.filter(function(s) { return Math.abs(s - r) <= _TTS_RATE_SNAP + _TTS_RATE_EPS; })[0];
  return stop === undefined ? r : stop;
}
function _ttsApplySpeed(r) {
  _setStorageJSON(SK.TTS_RATE, r);
  if (_ttsAudio && _ttsNow.engine !== _DEVICE_VOICE) { _ttsAudio.defaultPlaybackRate = r; _ttsAudio.playbackRate = r; }
}
function _ttsSpeedSettled() {
  if (!_ttsSpeaking) return; // stopped while the taps settled
  var r = _ttsRate(), e = _ttsNow.engine;
  if (e && !_ttsWaits() && _ttsKeepsUp(e, r) === false) {
    var next = _ttsServerEngines(_ttsNow.lang)[0];
    if (next && next !== e) { _ttsSpeak(_ttsNow.at); _ttsBarSync(); return; }
    var faster = _ttsFasterThan(_ttsNow.lang, e);
    if (faster) {
      _showToast(t('tts_slow_at', { slow: _voiceEngineName(e), rate: _ttsRateLabel(r), fast: _voiceEngineName(faster) }), _TTS_SUGGEST_MS,
        function() { _ttsPickVoice(faster); }, t('tts_slow_use', { fast: _voiceEngineName(faster) }));
    }
  }
  if (_ttsNow.engine === _DEVICE_VOICE && !_ttsPaused) _ttsSpeak(_ttsNow.at);
  _ttsBarSync();
}
// A voice picked while it reads: remembered, and the reading goes on from the
// sentence it was at, in the new voice (inside this tap, as iOS needs).
function _ttsPickVoice(engine) {
  _setVoicePrefs({ read: engine });
  _ttsMenuOpen = '';
  _ttsSpeak(_ttsNow.at);
}
// Patience from the bar: the reading starts again from here, keeping its voice.
function _ttsPickPatience(on) {
  _setVoicePrefs({ wait: on });
  _ttsMenuOpen = '';
  _ttsSpeak(_ttsNow.at);
}

// For someone who reads aloud: the server loads the article's voice now, so
// the first chunk does not wait for the model (the Dictionary does the same
// on opening). Nothing is downloaded for it.
function _ttsWarm() {
  var doc = _ttsFrameDoc();
  var lang = doc ? _ttsLang(doc) : '';
  var engines = lang ? _ttsServerEngines(lang) : [];
  // The voice that will read (Automatic passes over one too slow here), when
  // it is one that loads a model.
  var engine = engines[0];
  if (!engine || _TTS_WARM_ENGINES.indexOf(engine) < 0) return;
  var tag = _normLang(_langPrimary(lang)), key = tag + ' ' + engine;
  if (_ttsWarmed[key]) return;
  _ttsWarmed[key] = true;
  authedFetch('/dictionary/voices/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ langs: [tag], words: [], engine: engine }) })
    .catch(function() { delete _ttsWarmed[key]; });
}
