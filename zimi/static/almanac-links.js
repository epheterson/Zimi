// Almanac deep-links — turn almanac entities into taps that open the matching
// encyclopedia article from the user's INSTALLED library, in their preferred
// article language. Fail-soft by design (Eric's bar):
//   - No encyclopedia ZIM installed  → entities render as plain text (zero clutter).
//   - A tap that can't be resolved    → falls back to Zimi search (never a dead end).
//
// Resolution is title-based against /suggest (the same plumbing search uses),
// scoped to the best wikipedia-family ZIM in the user's language. Q-IDs in the
// map below are provenance / future-proofing: there is no client-callable
// Q-ID→path endpoint today (interlang's /article-languages needs an already-open
// zim+path), so the `en` label is what actually resolves. When a raw-Q-ID
// endpoint lands, this map is ready.
//
// This module shares global scope with app.js + the other almanac modules
// (all loaded as plain <script>s), so it calls openArticle(), zimsCache,
// _getPrefLanguages(), _currentLang, etc. directly.

(function () {
  'use strict';

  // ── Curated entity map ──────────────────────────────────────────────────
  // key → { q: 'Q…', en: '<English Wikipedia article title>' }
  // Keys are namespaced by category. `en` is the load-bearing field (used as
  // the /suggest query against English wikipedia and as a disambiguated title);
  // `q` is stable identity for the future Q-ID path.

  var PLANETS = {
    'planet:mercury': { q: 'Q308', en: 'Mercury (planet)' },
    'planet:venus':   { q: 'Q313', en: 'Venus' },
    'planet:earth':   { q: 'Q2',   en: 'Earth' },
    'planet:mars':    { q: 'Q111', en: 'Mars' },
    'planet:jupiter': { q: 'Q319', en: 'Jupiter' },
    'planet:saturn':  { q: 'Q193', en: 'Saturn' },
    'planet:uranus':  { q: 'Q324', en: 'Uranus' },
    'planet:neptune': { q: 'Q332', en: 'Neptune' },
    'planet:sun':     { q: 'Q525', en: 'Sun' },
    'planet:moon':    { q: 'Q405', en: 'Moon' }
  };

  var PROBES = {
    'probe:voyager1':     { q: 'Q48472',  en: 'Voyager 1' },
    'probe:voyager2':     { q: 'Q48479',  en: 'Voyager 2' },
    'probe:pioneer10':    { q: 'Q303265', en: 'Pioneer 10' },   // q spot-check
    'probe:pioneer11':    { q: 'Q604132', en: 'Pioneer 11' },   // q spot-check
    'probe:newhorizons':  { q: 'Q186447', en: 'New Horizons' }
  };

  // Constellations — `en` is the disambiguated article title so English
  // resolution doesn't collide with a myth/name (Orion, Leo, Cancer…).
  var CONSTELLATIONS = {
    'const:pisces':      { q: 'Q10538', en: 'Pisces (constellation)' },
    'const:aries':       { q: 'Q10576', en: 'Aries (constellation)' },
    'const:taurus':      { q: 'Q10577', en: 'Taurus (constellation)' },
    'const:gemini':      { q: 'Q10578', en: 'Gemini (constellation)' },
    'const:cancer':      { q: 'Q10508', en: 'Cancer (constellation)' },
    'const:leo':         { q: 'Q8853',  en: 'Leo (constellation)' },
    'const:virgo':       { q: 'Q10578', en: 'Virgo (constellation)' },   // q spot-check
    'const:libra':       { q: 'Q10564', en: 'Libra (constellation)' },
    'const:scorpius':    { q: 'Q13182', en: 'Scorpius' },
    'const:sagittarius': { q: 'Q10529', en: 'Sagittarius (constellation)' },
    'const:capricornus': { q: 'Q10484', en: 'Capricornus' },
    'const:aquarius':    { q: 'Q10453', en: 'Aquarius (constellation)' },
    'const:bootes':      { q: 'Q8667',  en: 'Boötes' },                  // q spot-check
    'const:lyra':        { q: 'Q10430', en: 'Lyra' },
    'const:perseus':     { q: 'Q10406', en: 'Perseus (constellation)' },
    'const:draco':       { q: 'Q10508', en: 'Draco (constellation)' },   // q spot-check
    'const:orion':       { q: 'Q7107',  en: 'Orion (constellation)' },
    'const:ursa_minor':  { q: 'Q10476', en: 'Ursa Minor' },
    // drawn-only (canvas) — mapped for completeness, not yet DOM-tappable
    'const:ursa_major':  { q: 'Q8667',  en: 'Ursa Major' },
    'const:cassiopeia':  { q: 'Q10457', en: 'Cassiopeia (constellation)' },
    'const:cygnus':      { q: 'Q10442', en: 'Cygnus (constellation)' },
    'const:crux':        { q: 'Q10452', en: 'Crux' },
    'const:canis_major': { q: 'Q10538', en: 'Canis Major' }             // q spot-check
  };

  // Meteor showers — key matches _METEOR_SHOWERS[].key. Titles are exact.
  var SHOWERS = {
    'shower:quadrantids':        { q: 'Q745704', en: 'Quadrantids' },
    'shower:lyrids':             { q: 'Q622664', en: 'Lyrids' },
    'shower:eta_aquariids':      { q: 'Q1194371', en: 'Eta Aquariids' },
    'shower:s_delta_aquariids':  { q: 'Q1194360', en: 'Delta Aquariids' },
    'shower:alpha_capricornids': { q: 'Q2597698', en: 'Alpha Capricornids' },
    'shower:perseids':           { q: 'Q131375', en: 'Perseids' },
    'shower:draconids':          { q: 'Q902330', en: 'Draconids' },
    'shower:orionids':           { q: 'Q902333', en: 'Orionids' },
    'shower:taurids':            { q: 'Q902363', en: 'Taurids' },
    'shower:leonids':            { q: 'Q131375', en: 'Leonids' },       // q spot-check
    'shower:geminids':           { q: 'Q321781', en: 'Geminids' },
    'shower:ursids':             { q: 'Q1145510', en: 'Ursids' }
  };

  // Eclipse types collapse onto the two head articles.
  var ECLIPSES = {
    'eclipse:total_solar':     { q: 'Q3887', en: 'Solar eclipse' },
    'eclipse:annular_solar':   { q: 'Q3887', en: 'Solar eclipse' },
    'eclipse:hybrid_solar':    { q: 'Q3887', en: 'Solar eclipse' },
    'eclipse:partial_solar':   { q: 'Q3887', en: 'Solar eclipse' },
    'eclipse:total_lunar':     { q: 'Q37160', en: 'Lunar eclipse' },
    'eclipse:partial_lunar':   { q: 'Q37160', en: 'Lunar eclipse' },
    'eclipse:penumbral_lunar': { q: 'Q37160', en: 'Lunar eclipse' }
  };

  // Calendar systems — key matches _CAL_SYSTEMS.
  var CALENDARS = {
    'cal:persian':   { q: 'Q747802', en: 'Solar Hijri calendar' },
    'cal:gregorian': { q: 'Q12138',  en: 'Gregorian calendar' },
    'cal:islamic':   { q: 'Q28789',  en: 'Islamic calendar' },
    'cal:julian':    { q: 'Q11184',  en: 'Julian calendar' },
    'cal:buddhist':  { q: 'Q725766', en: 'Buddhist calendar' },
    'cal:hebrew':    { q: 'Q12912',  en: 'Hebrew calendar' },
    'cal:chinese':   { q: 'Q331447', en: 'Chinese calendar' }
  };

  // Chinese zodiac animals — key matches _chineseZodiac output.
  var ZODIAC = {
    'zodiac:rat':     { q: 'Q209212', en: 'Rat (zodiac)' },
    'zodiac:ox':      { q: 'Q209210', en: 'Ox (zodiac)' },
    'zodiac:tiger':   { q: 'Q210605', en: 'Tiger (zodiac)' },
    'zodiac:rabbit':  { q: 'Q210593', en: 'Rabbit (zodiac)' },
    'zodiac:dragon':  { q: 'Q204915', en: 'Dragon (zodiac)' },
    'zodiac:snake':   { q: 'Q209209', en: 'Snake (zodiac)' },
    'zodiac:horse':   { q: 'Q209208', en: 'Horse (zodiac)' },
    'zodiac:goat':    { q: 'Q209207', en: 'Goat (zodiac)' },
    'zodiac:monkey':  { q: 'Q209206', en: 'Monkey (zodiac)' },
    'zodiac:rooster': { q: 'Q209205', en: 'Rooster (zodiac)' },
    'zodiac:dog':     { q: 'Q209204', en: 'Dog (zodiac)' },
    'zodiac:pig':     { q: 'Q208957', en: 'Pig (zodiac)' }
  };

  // Bright stars — the full sky catalogue (proper names). Included as the
  // complete closed asset; stars render on <canvas> so they are not yet
  // DOM-tappable (a future hit-testing pass). `en` = exact article title.
  var STARS = {
    'star:betelgeuse': { q: 'Q13575', en: 'Betelgeuse' },
    'star:rigel':      { q: 'Q13342', en: 'Rigel' },
    'star:bellatrix':  { q: 'Q13574', en: 'Bellatrix' },
    'star:mintaka':    { q: 'Q13538', en: 'Mintaka' },
    'star:alnilam':    { q: 'Q13500', en: 'Alnilam' },
    'star:alnitak':    { q: 'Q13502', en: 'Alnitak' },
    'star:saiph':      { q: 'Q13581', en: 'Saiph' },
    'star:dubhe':      { q: 'Q10405', en: 'Dubhe' },
    'star:merak':      { q: 'Q10406', en: 'Merak' },
    'star:phecda':     { q: 'Q13424', en: 'Phecda' },
    'star:megrez':     { q: 'Q13421', en: 'Megrez' },
    'star:alioth':     { q: 'Q10403', en: 'Alioth' },
    'star:mizar':      { q: 'Q13423', en: 'Mizar' },
    'star:alkaid':     { q: 'Q10402', en: 'Alkaid' },
    'star:caph':       { q: 'Q13476', en: 'Caph' },
    'star:schedar':    { q: 'Q13580', en: 'Schedar' },
    'star:ruchbah':    { q: 'Q13579', en: 'Ruchbah' },
    'star:segin':      { q: 'Q13582', en: 'Segin (star)' },
    'star:antares':    { q: 'Q12907', en: 'Antares' },
    'star:dschubba':   { q: 'Q13485', en: 'Dschubba' },
    'star:shaula':     { q: 'Q13583', en: 'Shaula' },
    'star:regulus':    { q: 'Q12179', en: 'Regulus' },
    'star:algieba':    { q: 'Q13495', en: 'Algieba' },
    'star:zosma':      { q: 'Q13593', en: 'Zosma' },
    'star:denebola':   { q: 'Q12878', en: 'Denebola' },
    'star:deneb':      { q: 'Q12827', en: 'Deneb' },
    'star:sadr':       { q: 'Q13578', en: 'Sadr (star)' },
    'star:albireo':    { q: 'Q13496', en: 'Albireo' },
    'star:acrux':      { q: 'Q12183', en: 'Acrux' },
    'star:mimosa':     { q: 'Q13537', en: 'Mimosa (star)' },
    'star:gacrux':     { q: 'Q13492', en: 'Gacrux' },
    'star:castor':     { q: 'Q13051', en: 'Castor (star)' },
    'star:pollux':     { q: 'Q12796', en: 'Pollux' },
    'star:sirius':     { q: 'Q3409',  en: 'Sirius' },
    'star:mirzam':     { q: 'Q13540', en: 'Mirzam' },
    'star:adhara':     { q: 'Q13494', en: 'Adhara' },
    'star:wezen':      { q: 'Q13590', en: 'Wezen' },
    'star:aldebaran':  { q: 'Q12786', en: 'Aldebaran' },
    'star:elnath':     { q: 'Q13491', en: 'Elnath' },
    'star:canopus':    { q: 'Q11908', en: 'Canopus' },
    'star:arcturus':   { q: 'Q12058', en: 'Arcturus' },
    'star:rigil_kentaurus': { q: 'Q12176', en: 'Alpha Centauri' },
    'star:vega':       { q: 'Q3427',  en: 'Vega' },
    'star:capella':    { q: 'Q13202', en: 'Capella' },
    'star:procyon':    { q: 'Q12876', en: 'Procyon' },
    'star:altair':     { q: 'Q12817', en: 'Altair' },
    'star:spica':      { q: 'Q12888', en: 'Spica' },
    'star:fomalhaut':  { q: 'Q12800', en: 'Fomalhaut' },
    'star:polaris':    { q: 'Q13790', en: 'Polaris' },
    'star:hamal':      { q: 'Q13509', en: 'Hamal' }
  };

  // Major holidays — keyed by a NORMALIZED English label (see _norm). Only
  // well-known observances get a curated entry (precise `en`/`q`). Everything
  // else still becomes tappable and resolves by its localized label, then
  // search — so the curated list is an accuracy boost, not a gate.
  var HOLIDAYS = {
    'newyearsday':     { q: 'Q210082', en: "New Year's Day" },
    'valentinesday':   { q: 'Q29320',  en: "Valentine's Day" },
    'earthday':        { q: 'Q205354', en: 'Earth Day' },
    'halloween':       { q: 'Q186030', en: 'Halloween' },
    'christmaseve':    { q: 'Q101991', en: 'Christmas Eve' },
    'christmas':       { q: 'Q19809',  en: 'Christmas' },
    'newyearseve':     { q: 'Q13366',  en: "New Year's Eve" },
    'mothersday':      { q: 'Q1445650', en: "Mother's Day" },
    'fathersday':      { q: 'Q170645', en: "Father's Day" },
    'easter':          { q: 'Q21196',  en: 'Easter' },
    'goodfriday':      { q: 'Q23444',  en: 'Good Friday' },
    'palmsunday':      { q: 'Q26505',  en: 'Palm Sunday' },
    'ashwednesday':    { q: 'Q166847', en: 'Ash Wednesday' },
    'pentecost':       { q: 'Q41726',  en: 'Pentecost' },
    'ascension':       { q: 'Q54068',  en: 'Feast of the Ascension' },
    'diwali':          { q: 'Q43107',  en: 'Diwali' },
    'holi':            { q: 'Q43084',  en: 'Holi' },
    'ramnavami':       { q: 'Q2564351', en: 'Rama Navami' },
    'rakshabandhan':   { q: 'Q1633723', en: 'Raksha Bandhan' },
    'janmashtami':     { q: 'Q1191895', en: 'Krishna Janmashtami' },
    'ganeshchaturthi': { q: 'Q1194883', en: 'Ganesh Chaturthi' },
    'navratribegins':  { q: 'Q1076630', en: 'Navaratri' },
    'dussehra':        { q: 'Q1195025', en: 'Vijayadashami' },
    'gurunanakjayanti': { q: 'Q2734893', en: 'Guru Nanak Gurpurab' },
    'vaisakhi':        { q: 'Q806701', en: 'Vaisakhi' },
    'makarsankranti':  { q: 'Q1064113', en: 'Makar Sankranti' },
    'ramadanbegins':   { q: 'Q19298',  en: 'Ramadan' },
    'eidalfitr':       { q: 'Q19546',  en: 'Eid al-Fitr' },
    'eidaladha':       { q: 'Q19558',  en: 'Eid al-Adha' },
    'islamicnewyear':  { q: 'Q211838', en: 'Islamic New Year' },
    'mawlid':          { q: 'Q210047', en: 'Mawlid' },
    'ashura':          { q: 'Q211889', en: 'Day of Ashura' },
    'hanukkah':        { q: 'Q129135', en: 'Hanukkah' },
    'roshhashanah':    { q: 'Q131132', en: 'Rosh Hashanah' },
    'yomkippur':       { q: 'Q131192', en: 'Yom Kippur' },
    'sukkot':          { q: 'Q131172', en: 'Sukkot' },
    'passover':        { q: 'Q80034',  en: 'Passover' },
    'shavuot':         { q: 'Q170345', en: 'Shavuot' },
    'purim':           { q: 'Q80970',  en: 'Purim' },
    'nowruz':          { q: 'Q192334', en: 'Nowruz' },
    'yaldanight':      { q: 'Q814470', en: 'Yaldā Night' },
    'springfestival':  { q: 'Q16874',  en: 'Chinese New Year' },
    'lanternfestival': { q: 'Q272103', en: 'Lantern Festival' },
    'midautumn':       { q: 'Q214137', en: 'Mid-Autumn Festival' },
    'dragonboat':      { q: 'Q208199', en: 'Dragon Boat Festival' },
    'qingming':        { q: 'Q262476', en: 'Qingming Festival' },
    'vesak':           { q: 'Q213319', en: 'Vesak' },
    'bodhiday':        { q: 'Q866918', en: 'Bodhi Day' },
    'thanksgiving':    { q: 'Q133136', en: 'Thanksgiving' },
    'independenceday': { q: 'Q11722',  en: 'Independence Day (United States)' },
    'bastilleday':     { q: 'Q6367',   en: 'Bastille Day' },
    'cincodemayo':     { q: 'Q214077', en: 'Cinco de Mayo' },
    'dayofthedead':    { q: 'Q192447', en: 'Day of the Dead' },
    'anzacday':        { q: 'Q303921', en: 'Anzac Day' },
    'piday':           { q: 'Q1417099', en: 'Pi Day' },
    'aprilfoolsday':   { q: 'Q37036',  en: "April Fools' Day" },
    'stpatricksday':   { q: 'Q189091', en: "Saint Patrick's Day" },
    'guyfawkesnight':  { q: 'Q253440', en: 'Guy Fawkes Night' },
    'groundhogday':    { q: 'Q217230', en: 'Groundhog Day' },
    'mayday':          { q: 'Q35113',  en: 'International Workers’ Day' },
    'nowruz2':         { q: 'Q192334', en: 'Nowruz' }
  };

  var MAP = {};
  [PLANETS, PROBES, CONSTELLATIONS, SHOWERS, ECLIPSES, CALENDARS, ZODIAC, STARS, HOLIDAYS]
    .forEach(function (group) { for (var k in group) if (group.hasOwnProperty(k)) MAP[k] = group[k]; });

  // ── Encyclopedia ZIM detection + language selection ─────────────────────

  function _norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // A ZIM is an "encyclopedia" target if it's a wikipedia-family or vikidia
  // archive (the ones whose article titles match our entity names).
  var _ENC_RE = /^(wikipedia|vikidia)_/i;
  var _encZimsCache = null; // reset per open via reset()

  function _encZims() {
    if (_encZimsCache) return _encZimsCache;
    var list = (typeof zimsCache !== 'undefined' && zimsCache) ? zimsCache : [];
    _encZimsCache = list.filter(function (z) { return z && _ENC_RE.test(z.name); });
    return _encZimsCache;
  }

  // Any encyclopedia ZIM installed → entities become tappable. Cheap, cached:
  // this is the zero-probe gate that keeps the almanac clutter-free when the
  // library has nothing to link to.
  function linkable() { return _encZims().length > 0; }

  function _articleCount(z) {
    return (z && typeof z.article_count === 'number') ? z.article_count
         : (z && typeof z.entries === 'number') ? z.entries : 0;
  }

  // Best encyclopedia ZIM for a given language code (largest wins).
  function _bestZimForLang(lang) {
    var best = null;
    _encZims().forEach(function (z) {
      if ((z.language || '') !== lang) return;
      if (!best || _articleCount(z) > _articleCount(best)) best = z;
    });
    return best;
  }

  // Language priority: user's article-language prefs → UI language → English →
  // whatever encyclopedia is installed. Returns a ZIM object or null.
  function _targetZim() {
    var order = [];
    try {
      var prefs = (typeof _getPrefLanguages === 'function') ? _getPrefLanguages() : [];
      for (var i = 0; i < prefs.length; i++) if (prefs[i] !== 'multi') order.push(prefs[i]);
    } catch (e) {}
    if (typeof _currentLang !== 'undefined' && _currentLang) order.push(_currentLang);
    order.push('en');
    for (var j = 0; j < order.length; j++) {
      var z = _bestZimForLang(order[j]);
      if (z) return z;
    }
    // Fall back to the largest encyclopedia regardless of language.
    var all = _encZims(), fb = null;
    for (var k = 0; k < all.length; k++) if (!fb || _articleCount(all[k]) > _articleCount(fb)) fb = all[k];
    return fb;
  }

  // ── Resolution (session-cached, resolve-on-tap) ─────────────────────────

  var _resolveCache = {}; // "key|label|zimName" → {zim,path,title} | 'miss'

  // The query title to send to /suggest: prefer the curated English title when
  // aiming at an English ZIM; otherwise use the label the user actually sees
  // (already localized to their language, which matches that ZIM's titles).
  function _queryTitle(entry, label, zim) {
    var zimLang = zim ? (zim.language || '') : '';
    if (entry && entry.en && zimLang === 'en') return entry.en;
    if (label) return label;
    return entry ? entry.en : '';
  }

  // The reader overlay renders beneath the open almanac view, so we must leave
  // the almanac before opening an article — otherwise the article loads hidden.
  function _leaveAlmanac() {
    try { if (typeof closeAlmanac === 'function') closeAlmanac(); } catch (e) {}
  }

  function _openArticle(zim, path, title) {
    _leaveAlmanac();
    openArticle(zim, path, title);
  }

  function _openSearchFallback(term) {
    // Never a dead end: drop the user into a normal Zimi search for the term.
    try {
      _leaveAlmanac();
      var box = document.getElementById('q');
      if (box) { box.value = term; }
      if (typeof doSearch === 'function') { doSearch(); return; }
      if (typeof runSearch === 'function') { runSearch(term); return; }
      location.href = '/?q=' + encodeURIComponent(term);
    } catch (e) {
      location.href = '/?q=' + encodeURIComponent(term);
    }
  }

  // Resolve a tapped entity and open it. key may be null (label-only, e.g. an
  // uncurated holiday); label is the localized on-screen text.
  function open(key, label) {
    if (typeof openArticle !== 'function') return;
    var entry = key ? MAP[key] : null;
    var zim = _targetZim();
    if (!zim) { _openSearchFallback(label || (entry && entry.en) || ''); return; }
    var query = _queryTitle(entry, label, zim);
    if (!query) { _openSearchFallback(label || ''); return; }

    var cacheKey = (key || '') + '|' + query + '|' + zim.name;
    var cached = _resolveCache[cacheKey];
    if (cached === 'miss') { _openSearchFallback(query); return; }
    if (cached) { _openArticle(cached.zim, cached.path, cached.title); return; }

    fetch('/suggest?q=' + encodeURIComponent(query) + '&limit=1&zim=' + encodeURIComponent(zim.name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var hit = null;
        // /suggest returns {zim_name: [{path,title}, …]}
        for (var zn in data) {
          if (!data.hasOwnProperty(zn)) continue;
          var items = data[zn] || [];
          for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].path && !items[i].error) { hit = { zim: zn, path: items[i].path, title: items[i].title || query }; break; }
          }
          if (hit) break;
        }
        if (hit) {
          _resolveCache[cacheKey] = hit;
          _openArticle(hit.zim, hit.path, hit.title);
        } else {
          _resolveCache[cacheKey] = 'miss';
          _openSearchFallback(query);
        }
      })
      .catch(function () { _openSearchFallback(query); });
  }

  // ── Linkify helper for render sites ─────────────────────────────────────

  function _escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Wrap an already-escaped label in a tappable span. Fail-soft: returns the
  // label untouched when nothing is installed to link to.
  //   key        — entity key in MAP (or null for label-only linking)
  //   innerHtml  — the display HTML (already escaped/localized)
  //   label      — plain-text localized label used for resolution (defaults to innerHtml)
  function wrap(key, innerHtml, label) {
    if (!linkable()) return innerHtml;
    if (key && !MAP[key]) key = null;      // unknown key → treat as label-only
    var resolveLabel = (label != null) ? label : innerHtml;
    if (!key && !resolveLabel) return innerHtml;
    return '<span class="alm-link" role="link" tabindex="0" data-alm-key="' +
      _escAttr(key || '') + '" data-alm-label="' + _escAttr(resolveLabel) + '">' +
      innerHtml + '</span>';
  }

  // Holiday convenience: resolve a curated entry from the displayed label.
  // Returns the curated key if the (English) label is in our list, else null;
  // uncurated holidays still link by label via wrap(null, …).
  function holidayKey(label) {
    var n = _norm(label);
    return HOLIDAYS[n] ? 'holiday-alias' : null; // marker; open() reads label
  }

  // For a holiday we prefer the curated English title when available.
  function wrapHoliday(displayHtml, label) {
    if (!linkable()) return displayHtml;
    var n = _norm(label);
    if (HOLIDAYS[n]) {
      // Curated: carry the English title as the resolution label so English
      // wikipedia gets an exact hit; localized ZIMs fall back to /suggest logic.
      return '<span class="alm-link" role="link" tabindex="0" data-alm-key="holiday:' +
        _escAttr(n) + '" data-alm-label="' + _escAttr(label) + '">' + displayHtml + '</span>';
    }
    return wrap(null, displayHtml, label);
  }

  // Register curated holidays under a "holiday:<norm>" key so open() finds the
  // English title.
  for (var hn in HOLIDAYS) if (HOLIDAYS.hasOwnProperty(hn)) MAP['holiday:' + hn] = HOLIDAYS[hn];

  // ── Delegated tap handler (bound once) ──────────────────────────────────

  function _handle(e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.classList && el.classList.contains('alm-link')) {
        e.preventDefault(); e.stopPropagation();
        var key = el.getAttribute('data-alm-key') || null;
        var label = el.getAttribute('data-alm-label') || '';
        open(key || null, label);
        return;
      }
      el = el.parentNode;
    }
  }

  function bind(root) {
    if (!root || root._almLinksBound) return;
    root._almLinksBound = true;
    root.addEventListener('click', _handle);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        var el = e.target;
        if (el && el.classList && el.classList.contains('alm-link')) _handle(e);
      }
    });
  }

  // Reset per-open caches (library may have changed between opens).
  function reset() { _encZimsCache = null; }

  window.AlmanacLinks = {
    MAP: MAP, wrap: wrap, wrapHoliday: wrapHoliday, holidayKey: holidayKey,
    open: open, linkable: linkable, bind: bind, reset: reset
  };
})();
