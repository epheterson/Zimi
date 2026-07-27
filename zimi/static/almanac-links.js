// Almanac deep-links — turn almanac entities into taps that open the matching
// encyclopedia article DIRECTLY from the user's INSTALLED library. This is a
// CLOSED SET: the curated map below carries a stable Wikidata Q-ID for every
// linkable entity, and the almanac resolves those Q-IDs against the installed
// library on open (POST /almanac-links, chunked to the server's per-batch cap).
// The returned map is authoritative:
//   - Q-ID resolves to an installed article → the entity renders as a direct
//     link; a tap opens it with zero further requests.
//   - Q-ID doesn't resolve (or no encyclopedia installed) → plain text.
// There is deliberately NO title SEARCH, no /suggest chain, no fuzzy match, and
// no on-tap fetch. A Q-ID that doesn't map to a real article is simply not a
// link — a wrong link is worse than no link. Entities in the map without a `q`
// field can never become links.
//
// Each entity's curated English article title travels alongside its Q-ID in the
// batch (parallel `titles` map). That is NOT a search: in a Wikipedia ZIM a
// title maps deterministically to the entry path, so the server can resolve an
// English article by exact title when a ZIM has no prebuilt Q-ID index (a full
// English Wikipedia would otherwise need a ~35h index build to link anything).
//
// Server side: resolve_almanac_qids() in interlang.py consults each installed
// wikipedia/vikidia ZIM's Q-ID index (sqlite) in language-preference order,
// then falls back to the exact curated title against English-family ZIMs.
//
// This module shares global scope with app.js + the other almanac modules
// (all loaded as plain <script>s), so it calls openArticle(), zimsCache,
// _getPrefLanguages(), _currentLang, _almanacOpen, _renderAlmanacContent, etc.
// directly.

(function () {
  'use strict';

  // ── Curated entity map ──────────────────────────────────────────────────
  // key → { q: 'Q…', en: '<English Wikipedia article title>' }
  // Keys are namespaced by category. `q` is the load-bearing field: it is the
  // stable Wikidata identity resolved server-side against the installed library.
  // `en` is retained as human-readable provenance (which article the Q-ID is).
  //
  // PROVENANCE (audited 2026-07): every `en` title is verified to resolve to a
  // real article in a full English Wikipedia install, and every `q` is that
  // article's actual Wikidata identity — obtained by resolving each curated
  // title (redirects followed) to its `wikibase_item` on the live English
  // Wikipedia. Q-IDs are present ONLY where confirmed against that ground truth;
  // there are no placeholder or sequential-guess IDs. A title carries a `q` iff
  // that q provably maps to the same article — so a Q-ID-indexed ZIM links the
  // right article, and the exact-title fallback covers un-indexed English ZIMs.

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
    'probe:voyager1':    { q: 'Q48469', en: 'Voyager 1' },
    'probe:voyager2':    { q: 'Q48475', en: 'Voyager 2' },
    'probe:pioneer10':   { q: 'Q59103', en: 'Pioneer 10' },
    'probe:pioneer11':   { q: 'Q59113', en: 'Pioneer 11' },
    'probe:newhorizons': { q: 'Q48461', en: 'New Horizons' }
  };

  // Constellations — `en` is the disambiguated article title so English
  // resolution doesn't collide with a myth/name (Orion, Leo, Cancer…). Q-IDs
  // are the IAU constellation items (not the astrological signs): the almanac
  // links the sidereal constellation the Sun/sky actually occupies. Verified
  // against Wikidata (wbgetentities by exact enwiki title).
  var CONSTELLATIONS = {
    'const:pisces':      { q: 'Q8679',  en: 'Pisces (constellation)' },
    'const:aries':       { q: 'Q10584', en: 'Aries (constellation)' },
    'const:taurus':      { q: 'Q10570', en: 'Taurus (constellation)' },
    'const:gemini':      { q: 'Q8923',  en: 'Gemini (constellation)' },
    'const:cancer':      { q: 'Q8849',  en: 'Cancer (constellation)' },
    'const:leo':         { q: 'Q8853',  en: 'Leo (constellation)' },
    'const:virgo':       { q: 'Q8842',  en: 'Virgo (constellation)' },
    'const:libra':       { q: 'Q10580', en: 'Libra (constellation)' },
    'const:scorpius':    { q: 'Q8865',  en: 'Scorpius' },
    'const:sagittarius': { q: 'Q8866',  en: 'Sagittarius (constellation)' },
    'const:capricornus': { q: 'Q10535', en: 'Capricornus' },
    'const:aquarius':    { q: 'Q10576', en: 'Aquarius (constellation)' },
    'const:bootes':      { q: 'Q8667',  en: 'Boötes' },
    'const:lyra':        { q: 'Q10484', en: 'Lyra' },
    'const:perseus':     { q: 'Q10511', en: 'Perseus (constellation)' },
    'const:draco':       { q: 'Q8675',  en: 'Draco (constellation)' },
    'const:orion':       { q: 'Q8860',  en: 'Orion (constellation)' },
    'const:ursa_minor':  { q: 'Q10478', en: 'Ursa Minor' },
    // drawn-only (canvas) — mapped for completeness, not yet DOM-tappable
    'const:ursa_major':  { q: 'Q8918',  en: 'Ursa Major' },
    'const:cassiopeia':  { q: 'Q10464', en: 'Cassiopeia (constellation)' },
    'const:cygnus':      { q: 'Q8921',  en: 'Cygnus (constellation)' },
    'const:crux':        { q: 'Q10542', en: 'Crux' },
    'const:canis_major': { q: 'Q10538', en: 'Canis Major' }
  };

  // Meteor showers — key matches _METEOR_SHOWERS[].key. Q-IDs verified against
  // Wikidata by exact enwiki title ('Delta Aquariids' redirects to 'Southern
  // Delta Aquariids', Q2914592).
  var SHOWERS = {
    'shower:quadrantids':        { q: 'Q838275',  en: 'Quadrantids' },
    'shower:lyrids':             { q: 'Q200531',  en: 'Lyrids' },
    'shower:eta_aquariids':      { q: 'Q249546',  en: 'Eta Aquariids' },
    'shower:s_delta_aquariids':  { q: 'Q2914592', en: 'Delta Aquariids' },
    'shower:alpha_capricornids': { q: 'Q3235037', en: 'Alpha Capricornids' },
    'shower:perseids':           { q: 'Q173708',  en: 'Perseids' },
    'shower:draconids':          { q: 'Q740319',  en: 'Draconids' },
    'shower:orionids':           { q: 'Q374114',  en: 'Orionids' },
    'shower:taurids':            { q: 'Q32334',   en: 'Taurids' },
    'shower:leonids':            { q: 'Q189698',  en: 'Leonids' },
    'shower:geminids':           { q: 'Q1237067', en: 'Geminids' },
    'shower:ursids':             { q: 'Q1133679', en: 'Ursids' }
  };

  // Eclipse types collapse onto the two head articles.
  var ECLIPSES = {
    'eclipse:total_solar':     { q: 'Q3887',  en: 'Solar eclipse' },
    'eclipse:annular_solar':   { q: 'Q3887',  en: 'Solar eclipse' },
    'eclipse:hybrid_solar':    { q: 'Q3887',  en: 'Solar eclipse' },
    'eclipse:partial_solar':   { q: 'Q3887',  en: 'Solar eclipse' },
    'eclipse:total_lunar':     { q: 'Q44235', en: 'Lunar eclipse' },
    'eclipse:partial_lunar':   { q: 'Q44235', en: 'Lunar eclipse' },
    'eclipse:penumbral_lunar': { q: 'Q44235', en: 'Lunar eclipse' }
  };

  // Calendar systems — key matches _CAL_SYSTEMS.
  var CALENDARS = {
    'cal:persian':   { q: 'Q950135', en: 'Solar Hijri calendar' },
    'cal:gregorian': { q: 'Q12138',  en: 'Gregorian calendar' },
    'cal:islamic':   { q: 'Q28892',  en: 'Islamic calendar' },
    'cal:julian':    { q: 'Q11184',  en: 'Julian calendar' },
    'cal:buddhist':  { q: 'Q370752', en: 'Buddhist calendar' },
    'cal:hebrew':    { q: 'Q44722',  en: 'Hebrew calendar' },
    'cal:chinese':   { q: 'Q134032', en: 'Chinese calendar' }
  };

  // Chinese zodiac animals — key matches _chineseZodiac output.
  var ZODIAC = {
    'zodiac:rat':     { q: 'Q721997', en: 'Rat (zodiac)' },
    'zodiac:ox':      { q: 'Q599644', en: 'Ox (zodiac)' },
    'zodiac:tiger':   { q: 'Q740762', en: 'Tiger (zodiac)' },
    'zodiac:rabbit':  { q: 'Q844723', en: 'Rabbit (zodiac)' },
    'zodiac:dragon':  { q: 'Q731434', en: 'Dragon (zodiac)' },
    'zodiac:snake':   { q: 'Q756692', en: 'Snake (zodiac)' },
    'zodiac:horse':   { q: 'Q869595', en: 'Horse (zodiac)' },
    'zodiac:goat':    { q: 'Q867696', en: 'Goat (zodiac)' },
    'zodiac:monkey':  { q: 'Q740674', en: 'Monkey (zodiac)' },
    'zodiac:rooster': { q: 'Q822621', en: 'Rooster (zodiac)' },
    'zodiac:dog':     { q: 'Q755126', en: 'Dog (zodiac)' },
    'zodiac:pig':     { q: 'Q877261', en: 'Pig (zodiac)' }
  };

  // Bright stars — the full sky catalogue (proper names). Included as the
  // complete closed asset; stars render on <canvas> so they are not yet
  // DOM-tappable (a future hit-testing pass). `en` = exact article title.
  var STARS = {
    'star:betelgeuse':      { q: 'Q12124',    en: 'Betelgeuse' },
    'star:rigel':           { q: 'Q12126',    en: 'Rigel' },
    'star:bellatrix':       { q: 'Q13066',    en: 'Bellatrix' },
    'star:mintaka':         { q: 'Q680341',   en: 'Mintaka' },
    'star:alnilam':         { q: 'Q13070',    en: 'Alnilam' },
    'star:alnitak':         { q: 'Q13076',    en: 'Alnitak' },
    'star:saiph':           { q: 'Q14028',    en: 'Saiph' },
    'star:dubhe':           { q: 'Q13084',    en: 'Dubhe' },
    'star:merak':           { q: 'Q409073',   en: 'Merak' },
    'star:phecda':          { q: 'Q13099',    en: 'Phecda' },
    'star:megrez':          { q: 'Q850779',   en: 'Megrez' },
    'star:alioth':          { q: 'Q13091',    en: 'Alioth' },
    'star:mizar':           { q: 'Q66477109', en: 'Mizar' },
    'star:alkaid':          { q: 'Q13093',    en: 'Alkaid' },
    'star:caph':            { q: 'Q13594',    en: 'Caph' },
    'star:schedar':         { q: 'Q13108',    en: 'Schedar' },
    'star:ruchbah':         { q: 'Q13597',    en: 'Ruchbah' },
    'star:segin':           { q: 'Q13602',    en: 'Segin (star)' },
    'star:antares':         { q: 'Q12166',    en: 'Antares' },
    'star:dschubba':        { q: 'Q14248',    en: 'Dschubba' },
    'star:shaula':          { q: 'Q78603928', en: 'Shaula' },
    'star:regulus':         { q: 'Q76493786', en: 'Regulus' },
    'star:algieba':         { q: 'Q66477100', en: 'Algieba' },
    'star:zosma':           { q: 'Q14204',    en: 'Zosma' },
    'star:denebola':        { q: 'Q13015',    en: 'Denebola' },
    'star:deneb':           { q: 'Q12179',    en: 'Deneb' },
    'star:sadr':            { q: 'Q13327',    en: 'Sadr (star)' },
    'star:albireo':         { q: 'Q67622059', en: 'Albireo' },
    'star:acrux':           { q: 'Q66476660', en: 'Acrux' },
    'star:mimosa':          { q: 'Q13105',    en: 'Mimosa (star)' },
    'star:gacrux':          { q: 'Q14233',    en: 'Gacrux' },
    'star:castor':          { q: 'Q13029',    en: 'Castor (star)' },
    'star:pollux':          { q: 'Q253312',   en: 'Pollux' },
    'star:sirius':          { q: 'Q3409',     en: 'Sirius' },
    'star:mirzam':          { q: 'Q13415',    en: 'Mirzam' },
    'star:adhara':          { q: 'Q13414',    en: 'Adhara' },
    'star:wezen':           { q: 'Q13411',    en: 'Wezen' },
    'star:aldebaran':       { q: 'Q88540091', en: 'Aldebaran' },
    'star:elnath':          { q: 'Q13508',    en: 'Elnath' },
    'star:canopus':         { q: 'Q12189',    en: 'Canopus' },
    'star:arcturus':        { q: 'Q12985',    en: 'Arcturus' },
    'star:rigil_kentaurus': { q: 'Q12176',    en: 'Alpha Centauri' },
    'star:vega':            { q: 'Q3427',     en: 'Vega' },
    'star:capella':         { q: 'Q12970',    en: 'Capella' },
    'star:procyon':         { q: 'Q13034',    en: 'Procyon' },
    'star:altair':          { q: 'Q12975',    en: 'Altair' },
    'star:spica':           { q: 'Q13008',    en: 'Spica' },
    'star:fomalhaut':       { q: 'Q13169',    en: 'Fomalhaut' },
    'star:polaris':         { q: 'Q12980',    en: 'Polaris' },
    'star:hamal':           { q: 'Q13213',    en: 'Hamal' }
  };

  // Major holidays — keyed by a NORMALIZED English label (see _norm). Only
  // well-known observances get a curated entry (precise `en`/`q`). Everything
  // else still becomes tappable and resolves by its localized label, then
  // search — so the curated list is an accuracy boost, not a gate.
  var HOLIDAYS = {
    'newyearsday':      { q: 'Q196627',   en: "New Year's Day" },
    'valentinesday':    { q: 'Q37587',    en: "Valentine's Day" },
    'earthday':         { q: 'Q124473',   en: 'Earth Day' },
    'halloween':        { q: 'Q251868',   en: 'Halloween' },
    'christmaseve':     { q: 'Q106010',   en: 'Christmas Eve' },
    'christmas':        { q: 'Q19809',    en: 'Christmas' },
    'newyearseve':      { q: 'Q11269',    en: "New Year's Eve" },
    'mothersday':       { q: 'Q47502',    en: "Mother's Day" },
    'fathersday':       { q: 'Q134847',   en: "Father's Day" },
    'easter':           { q: 'Q21196',    en: 'Easter' },
    'goodfriday':       { q: 'Q40317',    en: 'Good Friday' },
    'palmsunday':       { q: 'Q42236',    en: 'Palm Sunday' },
    'ashwednesday':     { q: 'Q123542',   en: 'Ash Wednesday' },
    'pentecost':        { q: 'Q39864',    en: 'Pentecost' },
    'ascension':        { q: 'Q51638',    en: 'Feast of the Ascension' },
    'diwali':           { q: 'Q10244',    en: 'Diwali' },
    'holi':             { q: 'Q10259',    en: 'Holi' },
    'ramnavami':        { q: 'Q1771621',  en: 'Rama Navami' },
    'rakshabandhan':    { q: 'Q10266',    en: 'Raksha Bandhan' },
    'janmashtami':      { q: 'Q430574',   en: 'Krishna Janmashtami' },
    'ganeshchaturthi':  { q: 'Q929250',   en: 'Ganesh Chaturthi' },
    'navratribegins':   { q: 'Q10269',    en: 'Navaratri' },
    'dussehra':         { q: 'Q10274',    en: 'Vijayadashami' },
    'gurunanakjayanti': { q: 'Q12174361', en: 'Guru Nanak Gurpurab' },
    'vaisakhi':         { q: 'Q2461213',  en: 'Vaisakhi' },
    'makarsankranti':   { q: 'Q10253',    en: 'Makar Sankranti' },
    'ramadanbegins':    { q: 'Q41662',    en: 'Ramadan' },
    'eidalfitr':        { q: 'Q464458',   en: 'Eid al-Fitr' },
    'eidaladha':        { q: 'Q514400',   en: 'Eid al-Adha' },
    'islamicnewyear':   { q: 'Q922388',   en: 'Islamic New Year' },
    'mawlid':           { q: 'Q193027',   en: 'Mawlid' },
    'ashura':           { q: 'Q183283',   en: 'Day of Ashura' },
    'hanukkah':         { q: 'Q130881',   en: 'Hanukkah' },
    'roshhashanah':     { q: 'Q131028',   en: 'Rosh Hashanah' },
    'yomkippur':        { q: 'Q132994',   en: 'Yom Kippur' },
    'sukkot':           { q: 'Q182242',   en: 'Sukkot' },
    'passover':         { q: 'Q121393',   en: 'Passover' },
    'shavuot':          { q: 'Q201196',   en: 'Shavuot' },
    'purim':            { q: 'Q180115',   en: 'Purim' },
    'nowruz':           { q: 'Q483236',   en: 'Nowruz' },
    'yaldanight':       { q: 'Q1328626',  en: 'Yaldā Night' },
    'springfestival':   { q: 'Q131772',   en: 'Chinese New Year' },
    'lanternfestival':  { q: 'Q718636',   en: 'Lantern Festival' },
    'midautumn':        { q: 'Q379519',   en: 'Mid-Autumn Festival' },
    'dragonboat':       { q: 'Q1254268',  en: 'Dragon Boat Festival' },
    'qingming':         { q: 'Q718778',   en: 'Qingming Festival' },
    'vesak':            { q: 'Q215700',   en: 'Vesak' },
    'bodhiday':         { q: 'Q400077',   en: 'Bodhi Day' },
    'thanksgiving':     { q: 'Q13959',    en: 'Thanksgiving' },
    'independenceday':  { q: 'Q86591',    en: 'Independence Day (United States)' },
    'bastilleday':      { q: 'Q326724',   en: 'Bastille Day' },
    'cincodemayo':      { q: 'Q660447',   en: 'Cinco de Mayo' },
    'dayofthedead':     { q: 'Q309256',   en: 'Day of the Dead' },
    'anzacday':         { q: 'Q295859',   en: 'Anzac Day' },
    'piday':            { q: 'Q179736',   en: 'Pi Day' },
    'aprilfoolsday':    { q: 'Q80949',    en: "April Fools' Day" },
    'stpatricksday':    { q: 'Q181817',   en: "Saint Patrick's Day" },
    'guyfawkesnight':   { q: 'Q844844',   en: 'Guy Fawkes Night' },
    'groundhogday':     { q: 'Q744374',   en: 'Groundhog Day' },
    'mayday':           { q: 'Q47499',    en: 'International Workers’ Day' },
    'nowruz2':          { q: 'Q483236',   en: 'Nowruz' },

    // ── Country-specific packs (#33). A label shared across nations is
    //    region-qualified `<norm>_<iso>` so wrapHoliday(…, region) resolves it
    //    to the RIGHT country's article; unshared labels stay bare. ──
    // United States
    'taxday':                { q: 'Q4993240',   en: 'Tax Day' },
    'flagday_us':            { q: 'Q1426369',   en: 'Flag Day (United States)' },
    'juneteenth':            { q: 'Q6312521',   en: 'Juneteenth' },
    'independenceday_us':    { q: 'Q86591',     en: 'Independence Day (United States)' },
    'patriotday':            { q: 'Q1034573',   en: 'Patriot Day' },
    'veteransday':           { q: 'Q755999',    en: 'Veterans Day' },
    'kwanzaa':               { q: 'Q746851',    en: 'Kwanzaa' },
    'martinlutherkingjrday': { q: 'Q751738',    en: 'Martin Luther King Jr. Day' },
    'superbowlsunday':       { q: 'Q32096',     en: 'Super Bowl' },
    'presidentsday':         { q: 'Q744159',    en: "Presidents' Day" },
    'memorialday':           { q: 'Q371781',    en: 'Memorial Day' },
    'laborday':              { q: 'Q848352',    en: 'Labor Day' },
    'indigenouspeoplesday':  { q: 'Q116822503', en: "Indigenous Peoples' Day" },
    // Canada
    'canadaday':                 { q: 'Q639756',   en: 'Canada Day' },
    'truthandreconciliationday': { q: 'Q42378086', en: 'National Day for Truth and Reconciliation' },
    'boxingday':                 { q: 'Q956699',   en: 'Boxing Day' },
    'labourday':                 { q: 'Q10901070', en: 'Labour Day' },
    // United Kingdom
    'stgeorgesday':        { q: 'Q212829', en: "Saint George's Day" },
    'remembranceday':      { q: 'Q27631',  en: 'Remembrance Day' },
    'earlymaybankholiday': { q: 'Q277436', en: 'Bank holiday' },
    'springbankholiday':   { q: 'Q277436', en: 'Bank holiday' },
    'summerbankholiday':   { q: 'Q277436', en: 'Bank holiday' },
    // Ireland
    'ststephensday':      { q: 'Q1366863', en: "Saint Stephen's Day" },
    'octoberbankholiday': { q: 'Q277436',  en: 'Bank holiday' },
    // France
    'victoryineuropeday': { q: 'Q622365',  en: 'Victory in Europe Day' },
    'armisticeday':       { q: 'Q6597183', en: 'Armistice Day' },
    // Germany
    'germanunityday':     { q: 'Q157582', en: 'German Unity Day' },
    'nikolaus':           { q: 'Q760225', en: 'Saint Nicholas Day' },
    'secondchristmasday': { q: 'Q19809',  en: 'Christmas' },
    // Italy
    'liberationday':  { q: 'Q2851732', en: 'Liberation Day (Italy)' },
    'republicday_it': { q: 'Q802461',  en: 'Festa della Repubblica' },
    'ferragosto':     { q: 'Q1262719', en: 'Ferragosto' },
    // Spain
    'fiestanacional':       { q: 'Q2745862', en: 'National Day of Spain' },
    'immaculateconception': { q: 'Q185606',  en: 'Immaculate Conception' },
    // Australia / New Zealand
    'australiaday': { q: 'Q502375',  en: 'Australia Day' },
    'waitangiday':  { q: 'Q1851080', en: 'Waitangi Day' },
    // India
    'republicday_in':     { q: 'Q1139536', en: 'Republic Day (India)' },
    'independenceday_in': { q: 'Q56106',   en: 'Independence Day (India)' },
    'gandhijayanti':      { q: 'Q658185',  en: 'Gandhi Jayanti' },
    // Brazil
    'tiradentes':            { q: 'Q527112',  en: 'Tiradentes' },
    'independenceday_br':    { q: 'Q1548600', en: 'Independence of Brazil' },
    'nossasenhoraaparecida': { q: 'Q2469225', en: 'Our Lady of Aparecida' },
    'republicday_br':        { q: 'Q2294549', en: 'Proclamation of the Republic (Brazil)' },
    // Mexico
    'independenceday_mx': { q: 'Q1145411', en: 'Grito de Dolores' },
    'dayofthedeadii':     { q: 'Q309256',  en: 'Day of the Dead' },
    // Japan
    'nationalfoundationday': { q: 'Q123118411', en: 'National Foundation Day' },
    'showaday':              { q: 'Q1361434',   en: 'Shōwa Day' },
    'constitutionday_jp':    { q: 'Q1361489',   en: 'Constitution Memorial Day' },
    'childrensday':          { q: 'Q1145630',   en: "Children's Day (Japan)" },
    'mountainday':           { q: 'Q2996756',   en: 'Mountain Day' },
    'cultureday':            { q: 'Q1009535',   en: 'Culture Day' },
    // China
    'nationalday_cn': { q: 'Q1145566', en: "National Day of the People's Republic of China" },
    // South Africa
    'humanrightsday_za':      { q: 'Q465153',  en: 'Human Rights Day (South Africa)' },
    'freedomday_za':          { q: 'Q2401839', en: 'Freedom Day (South Africa)' },
    'heritageday_za':         { q: 'Q5738794', en: 'Heritage Day' },
    'dayofreconciliation_za': { q: 'Q5242947', en: 'Day of Reconciliation' },
    'dayofgoodwill_za':       { q: 'Q956699',  en: 'Boxing Day' },
    // Russia
    'orthodoxchristmas':          { q: 'Q19809',   en: 'Christmas' },
    'defenderofthefatherlandday': { q: 'Q163708',  en: 'Defender of the Fatherland Day' },
    'victoryday':                 { q: 'Q270706',  en: 'Victory Day (9 May)' },
    'russiaday':                  { q: 'Q1432329', en: 'Russia Day' },
    'unityday':                   { q: 'Q1355116', en: 'Unity Day (Russia)' },

    // ── Worldwide observances (the base Gregorian set) ──
    'epiphany':                       { q: 'Q61556',    en: 'Epiphany' },
    'holocaustremembranceday':        { q: 'Q152960',   en: 'International Holocaust Remembrance Day' },
    'darwinday':                      { q: 'Q1166876',  en: 'Darwin Day' },
    'internationalmotherlanguageday': { q: 'Q42375',    en: 'International Mother Language Day' },
    'internationalwomensday':         { q: 'Q38964',    en: "International Women's Day" },
    'worldwaterday':                  { q: 'Q183740',   en: 'World Water Day' },
    'worldhealthday':                 { q: 'Q476734',   en: 'World Health Day' },
    'worldbookday':                   { q: 'Q166051',   en: 'World Book Day' },
    'maydayworkersday':               { q: 'Q47499',    en: "International Workers' Day" },
    'starwarsday':                    { q: 'Q2603175',  en: 'Star Wars Day' },
    'towelday':                       { q: 'Q241666',   en: 'Towel Day' },
    'worldenvironmentday':            { q: 'Q199641',   en: 'World Environment Day' },
    'worldoceansday':                 { q: 'Q559920',   en: 'World Oceans Day' },
    'internationalyogaday':           { q: 'Q18621241', en: 'International Day of Yoga' },
    'worldpopulationday':             { q: 'Q855138',   en: 'World Population Day' },
    'worldemojiday':                  { q: 'Q28130497', en: 'World Emoji Day' },
    'nelsonmandeladay':               { q: 'Q1466741',  en: 'Mandela Day' },
    'moonlandingday':                 { q: 'Q495307',   en: 'Moon landing' },
    'internationalyouthday':          { q: 'Q1064568',  en: 'International Youth Day' },
    'internationalliteracyday':       { q: 'Q756864',   en: 'International Literacy Day' },
    'internationaldayofpeace':        { q: 'Q327632',   en: 'International Day of Peace' },
    'worldtourismday':                { q: 'Q635879',   en: 'World Tourism Day' },
    'internationalcoffeeday':         { q: 'Q6049351',  en: 'International Coffee Day' },
    'worldanimalday':                 { q: 'Q167888',   en: 'World Animal Day' },
    'worldmentalhealthday':           { q: 'Q1786581',  en: 'World Mental Health Day' },
    'worldfoodday':                   { q: 'Q465003',   en: 'World Food Day' },
    'unitednationsday':               { q: 'Q210016',   en: 'United Nations Day' },
    'worldkindnessday':               { q: 'Q8035896',  en: 'World Kindness Day' },
    'internationalmensday':           { q: 'Q15964944', en: "International Men's Day" },
    'worldchildrensday':              { q: 'Q37081',    en: "Children's Day" },
    'humanrightsday':                 { q: 'Q206206',   en: 'Human Rights Day' },

    // ── Native-calendar observances beyond the base set (famous ones only) ──
    'tubishvat':        { q: 'Q748816',  en: 'Tu BiShvat' },
    'lagbaomer':        { q: 'Q748801',  en: 'Lag BaOmer' },
    'simchattorah':     { q: 'Q431678',  en: 'Simchat Torah' },
    'shminiatzeret':    { q: 'Q932711',  en: 'Shemini Atzeret' },
    'isramiraj':        { q: 'Q381240',  en: "Isra and Mi'raj" },
    'laylatalqadr':     { q: 'Q216452',  en: 'Night of Power' },
    'chaharshanbesuri': { q: 'Q2372493', en: 'Chaharshanbe Suri' },
    'ghostfestival':    { q: 'Q696781',  en: 'Ghost Festival' },
    'chongyang':        { q: 'Q463754',  en: 'Double Ninth Festival' },
    'labafestival':     { q: 'Q2086945', en: 'Laba Festival' },
    'loykrathong':      { q: 'Q1425496', en: 'Loy Krathong' },
    'maghapuja':        { q: 'Q967000',  en: 'Māgha Pūjā' },
    'asalhapuja':       { q: 'Q720682',  en: 'Asalha Puja' },
    'transfiguration':  { q: 'Q201201',  en: 'Transfiguration of Jesus' },
    'annunciation':     { q: 'Q154326',  en: 'Annunciation' }
  };

  // Astronomy & timekeeping terms — the obscure-but-linkable vocabulary the
  // almanac actually renders (magnitude, elongation, obliquity, precession…).
  // `en` is the canonical English Wikipedia article title (redirects resolve to
  // the head article via the server's single-hop fallback, so a redirect title
  // like "Perihelion" is fine). Every q here is the article's verified
  // wikibase_item (see PROVENANCE above).
  var TERMS = {
    // Sun geometry & the seasons
    'term:equinox':           { q: 'Q1315',   en: 'Equinox' },
    'term:solstice':          { q: 'Q123524', en: 'Solstice' },
    'term:analemma':          { q: 'Q484737', en: 'Analemma' },
    'term:equation_of_time':  { q: 'Q186058', en: 'Equation of time' },
    'term:declination':       { q: 'Q76287',  en: 'Declination' },
    'term:ecliptic':          { q: 'Q79852',  en: 'Ecliptic' },
    'term:astronomical_unit': { q: 'Q1811',   en: 'Astronomical unit' },
    'term:apsis':             { q: 'Q83481',  en: 'Apsis' }, // perihelion/aphelion/perigee/apogee
    // Planet visibility & configurations
    'term:apparent_magnitude': { q: 'Q124313', en: 'Apparent magnitude' },
    'term:elongation':         { q: 'Q271439', en: 'Elongation (astronomy)' },
    'term:conjunction':        { q: 'Q191536', en: 'Conjunction (astronomy)' },
    'term:opposition':         { q: 'Q105562', en: 'Opposition (astronomy)' },
    // Moon
    'term:supermoon':   { q: 'Q687756',  en: 'Supermoon' },
    'term:lunar_phase': { q: 'Q26388',   en: 'Lunar phase' },
    'term:golden_hour': { q: 'Q3238843', en: 'Golden hour (photography)' },
    'term:twilight':    { q: 'Q164160',  en: 'Twilight' },
    // Meteors
    'term:meteor_shower': { q: 'Q105000', en: 'Meteor shower' },
    'term:radiant':       { q: 'Q258190', en: 'Radiant (meteor shower)' },
    // Deep time / orbital mechanics
    'term:axial_tilt':           { q: 'Q179745',  en: 'Axial tilt' },
    'term:axial_precession':     { q: 'Q83094',   en: 'Axial precession' },
    'term:orbital_eccentricity': { q: 'Q208474',  en: 'Orbital eccentricity' },
    'term:julian_day':           { q: 'Q14267',   en: 'Julian day' },
    'term:galactic_year':        { q: 'Q268391',  en: 'Galactic year' },
    'term:milankovitch':         { q: 'Q211446',  en: 'Milankovitch cycles' },
    'term:tidal_acceleration':   { q: 'Q2477230', en: 'Tidal acceleration' },
    // Structure & timekeeping
    'term:solar_system': { q: 'Q544',   en: 'Solar System' },
    'term:zodiac':       { q: 'Q40540', en: 'Zodiac' },
    'term:leap_year':    { q: 'Q19828', en: 'Leap year' }
  };

  // The four seasons — displayed as the current-season name in the astro panel.
  var SEASONS = {
    'season:winter': { q: 'Q1311', en: 'Winter' },
    'season:spring': { q: 'Q1312', en: 'Spring (season)' },
    'season:summer': { q: 'Q1313', en: 'Summer' },
    'season:autumn': { q: 'Q1314', en: 'Autumn' }
  };

  // Orrery belts — the labelled bands/rings the orrery draws (asteroid, Kuiper,
  // heliopause). Keys match the canvas hit-test in almanac-orrery.js. Heliopause
  // verified against Wikidata by exact enwiki title (Q1137936 → "Heliopause
  // (astronomy)"; the bare "Heliopause" title is a disambiguation page, Q5705772
  // — not linkable).
  var BELTS = {
    'belt:asteroid':   { q: 'Q2179',    en: 'Asteroid belt' },
    'belt:kuiper':     { q: 'Q427',     en: 'Kuiper belt' },
    'belt:heliopause': { q: 'Q1137936', en: 'Heliopause (astronomy)' }
  };

  // "On this day" event subjects — the confident entity behind each editorial
  // milestone in _ON_THIS_DAY (almanac.js). `sub` is the exact phrase, as it
  // appears in the event text, that becomes the link; `en` is the article title
  // resolved server-side (may differ from `sub`, e.g. a redirect or a
  // disambiguated title). Ambiguous events (no confident single subject) carry
  // no `ev:` key and stay plain text — a wrong link is worse than none.
  var EVENTS = {
    'ev:ceres':          { q: 'Q596',       en: 'Ceres (dwarf planet)',        sub: 'Ceres' },
    'ev:luna1':          { q: 'Q1159913',   en: 'Luna 1',                      sub: 'Luna 1' },
    'ev:change4':        { q: 'Q723045',    en: "Chang'e 4",                   sub: 'Chang’e 4' },
    'ev:newton':         { q: 'Q935',       en: 'Isaac Newton',                sub: 'Isaac Newton' },
    'ev:eris':           { q: 'Q611',       en: 'Eris (dwarf planet)',         sub: 'Eris' },
    'ev:jupiter':        { q: 'Q319',       en: 'Jupiter',                     sub: 'Jupiter' },
    'ev:titan':          { q: 'Q2565',      en: 'Titan (moon)',                sub: 'Titan' },
    'ev:yukawa':         { q: 'Q155777',    en: 'Hideki Yukawa',               sub: 'Hideki Yukawa' },
    'ev:challenger':     { q: 'Q54382',     en: 'Space Shuttle Challenger',    sub: 'Space Shuttle Challenger' },
    'ev:explorer1':      { q: 'Q49901',     en: 'Explorer 1',                  sub: 'Explorer 1' },
    'ev:mccandless':     { q: 'Q433608',    en: 'Bruce McCandless II',         sub: 'Bruce McCandless' },
    'ev:mendeleev':      { q: 'Q9106',      en: 'Dmitri Mendeleev',            sub: 'Dmitri Mendeleev' },
    'ev:mendel':         { q: 'Q37970',     en: 'Gregor Mendel',               sub: 'Gregor Mendel' },
    'ev:ligo':           { q: 'Q255371',    en: 'LIGO',                        sub: 'LIGO' },
    'ev:darwin':         { q: 'Q1035',      en: 'Charles Darwin',              sub: 'Charles Darwin' },
    'ev:voyager1':       { q: 'Q48469',     en: 'Voyager 1',                   sub: 'Voyager 1' },
    'ev:galileogalilei': { q: 'Q307',       en: 'Galileo Galilei',             sub: 'Galileo Galilei' },
    'ev:pluto':          { q: 'Q339',       en: 'Pluto',                       sub: 'Pluto' },
    'ev:copernicus':     { q: 'Q619',       en: 'Nicolaus Copernicus',         sub: 'Nicolaus Copernicus' },
    'ev:bellburnell':    { q: 'Q233974',    en: 'Jocelyn Bell Burnell',        sub: 'Jocelyn Bell Burnell' },
    'ev:uranus':         { q: 'Q324',       en: 'Uranus',                      sub: 'Uranus' },
    'ev:einstein':       { q: 'Q937',       en: 'Albert Einstein',             sub: 'Albert Einstein' },
    'ev:hawking':        { q: 'Q17714',     en: 'Stephen Hawking',             sub: 'Stephen Hawking' },
    'ev:goddard':        { q: 'Q182546',    en: 'Robert H. Goddard',           sub: 'Robert Goddard' },
    'ev:leonov':         { q: 'Q154269',    en: 'Alexei Leonov',               sub: 'Alexei Leonov' },
    'ev:noether':        { q: 'Q7099',      en: 'Emmy Noether',                sub: 'Emmy Noether' },
    'ev:gagarin':        { q: 'Q7327',      en: 'Yuri Gagarin',                sub: 'Yuri Gagarin' },
    'ev:columbia':       { q: 'Q54383',     en: 'Space Shuttle Columbia',      sub: 'Columbia' },
    'ev:apollo13':       { q: 'Q182252',    en: 'Apollo 13',                   sub: 'Apollo 13' },
    'ev:salyut1':        { q: 'Q211761',    en: 'Salyut 1',                    sub: 'Salyut 1' },
    'ev:hubble':         { q: 'Q2513',      en: 'Hubble Space Telescope',      sub: 'Hubble Space Telescope' },
    'ev:franklin':       { q: 'Q7474',      en: 'Rosalind Franklin',           sub: 'Rosalind Franklin' },
    'ev:shepard':        { q: 'Q174979',    en: 'Alan Shepard',                sub: 'Alan Shepard' },
    'ev:smallpox':       { q: 'Q12214',     en: 'Smallpox',                    sub: 'smallpox' },
    'ev:hodgkin':        { q: 'Q7487',      en: 'Dorothy Hodgkin',             sub: 'Dorothy Hodgkin' },
    'ev:jenner':         { q: 'Q40852',     en: 'Edward Jenner',               sub: 'Edward Jenner' },
    'ev:zhurong':        { q: 'Q106614244', en: 'Zhurong (rover)',             sub: 'Zhurong' },
    'ev:jfk':            { q: 'Q9696',      en: 'John F. Kennedy',             sub: 'JFK' },
    'ev:esa':            { q: 'Q42262',     en: 'European Space Agency',       sub: 'European Space Agency' },
    'ev:hayabusa':       { q: 'Q275444',    en: 'Hayabusa',                    sub: 'Hayabusa' },
    'ev:tereshkova':     { q: 'Q44371',     en: 'Valentina Tereshkova',        sub: 'Valentina Tereshkova' },
    'ev:sallyride':      { q: 'Q49285',     en: 'Sally Ride',                  sub: 'Sally Ride' },
    'ev:turing':         { q: 'Q7251',      en: 'Alan Turing',                 sub: 'Alan Turing' },
    'ev:genome':         { q: 'Q720988',    en: 'Human genome',                sub: 'human genome' },
    'ev:tunguska':       { q: 'Q125953',    en: 'Tunguska event',              sub: 'Tunguska' },
    'ev:pathfinder':     { q: 'Q201771',    en: 'Mars Pathfinder',             sub: 'Mars Pathfinder' },
    'ev:higgs':          { q: 'Q402',       en: 'Higgs boson',                 sub: 'Higgs boson' },
    'ev:newhorizons':    { q: 'Q48461',     en: 'New Horizons',                sub: 'New Horizons' },
    'ev:mariner4':       { q: 'Q203805',    en: 'Mariner 4',                   sub: 'Mariner 4' },
    'ev:apollo11':       { q: 'Q43653',     en: 'Apollo 11',                   sub: 'Apollo 11' },
    'ev:lemaitre':       { q: 'Q12998',     en: 'Georges Lemaître',            sub: 'Georges Lemaître' },
    'ev:glenn':          { q: 'Q182642',    en: 'John Glenn',                  sub: 'John Glenn' },
    'ev:viking1':        { q: 'Q210199',    en: 'Viking 1',                    sub: 'Viking 1' },
    'ev:halebopp':       { q: 'Q69854',     en: 'Comet Hale–Bopp',             sub: 'Comet Hale–Bopp' },
    'ev:curiosity':      { q: 'Q48485',     en: 'Curiosity (rover)',           sub: 'Curiosity' },
    'ev:rosetta':        { q: 'Q48572',     en: 'Rosetta (spacecraft)',        sub: 'Rosetta' },
    'ev:deimos':         { q: 'Q7548',      en: 'Deimos (moon)',               sub: 'Deimos' },
    'ev:chandrayaan3':   { q: 'Q65049774',  en: 'Chandrayaan-3',               sub: 'Chandrayaan-3' },
    'ev:voyager2':       { q: 'Q48475',     en: 'Voyager 2',                   sub: 'Voyager 2' },
    'ev:goldenrecord':   { q: 'Q156315',    en: 'Voyager Golden Record',       sub: 'Golden Record' },
    'ev:lhc':            { q: 'Q40605',     en: 'Large Hadron Collider',       sub: 'Large Hadron Collider' },
    'ev:luna2':          { q: 'Q1159927',   en: 'Luna 2',                      sub: 'Luna 2' },
    'ev:galileoprobe':   { q: 'Q105425030', en: 'Galileo (spacecraft)',        sub: 'Galileo' },
    'ev:neptune':        { q: 'Q332',       en: 'Neptune',                     sub: 'Neptune' },
    'ev:mangalyaan':     { q: 'Q2156739',   en: 'Mars Orbiter Mission',        sub: 'Mangalyaan' },
    'ev:fleming':        { q: 'Q37064',     en: 'Alexander Fleming',           sub: 'Alexander Fleming' },
    'ev:sputnik1':       { q: 'Q80811',     en: 'Sputnik 1',                   sub: 'Sputnik 1' },
    'ev:pegasi':         { q: 'Q242309',    en: '51 Pegasi b',                 sub: '51 Pegasi b' },
    'ev:luna3':          { q: 'Q942814',    en: 'Luna 3',                      sub: 'Luna 3' },
    'ev:cassini':        { q: 'Q165585',    en: 'Cassini–Huygens',             sub: 'Cassini' },
    'ev:shenzhou5':      { q: 'Q378417',    en: 'Shenzhou 5',                  sub: 'Shenzhou 5' },
    'ev:chandrasekhar':  { q: 'Q148109',    en: 'Subrahmanyan Chandrasekhar',  sub: 'Subrahmanyan Chandrasekhar' },
    'ev:iss':            { q: 'Q25271',     en: 'International Space Station', sub: 'ISS' },
    'ev:iss_full':       { q: 'Q25271',     en: 'International Space Station', sub: 'International Space Station' },
    'ev:laika':          { q: 'Q53662',     en: 'Laika',                       sub: 'Laika' },
    'ev:curie_pl':       { q: 'Q7186',      en: 'Marie Curie',                 sub: 'Marie Skłodowska-Curie' },
    'ev:halley':         { q: 'Q47434',     en: 'Edmond Halley',               sub: 'Edmond Halley' },
    'ev:rontgen':        { q: 'Q35149',     en: 'Wilhelm Röntgen',             sub: 'Wilhelm Röntgen' },
    'ev:sagan':          { q: 'Q410',       en: 'Carl Sagan',                  sub: 'Carl Sagan' },
    'ev:philae':         { q: 'Q1041962',   en: 'Philae (spacecraft)',         sub: 'Philae' },
    'ev:hayabusa2':      { q: 'Q2113134',   en: 'Hayabusa2',                   sub: 'Hayabusa2' },
    'ev:curie':          { q: 'Q7186',      en: 'Marie Curie',                 sub: 'Marie Curie' },
    'ev:apollo17':       { q: 'Q180971',    en: 'Apollo 17',                   sub: 'Apollo 17' },
    'ev:venera7':        { q: 'Q152800',    en: 'Venera 7',                    sub: 'Venera 7' },
    'ev:wright':         { q: 'Q35820',     en: 'Wright brothers',             sub: 'Wright brothers' },
    'ev:apollo8':        { q: 'Q184201',    en: 'Apollo 8',                    sub: 'Apollo 8' },
    'ev:ramanujan':      { q: 'Q83163',     en: 'Srinivasa Ramanujan',         sub: 'Srinivasa Ramanujan' },
    'ev:jwst':           { q: 'Q186447',    en: 'James Webb Space Telescope',  sub: 'James Webb Space Telescope' },
    'ev:kepler':         { q: 'Q8963',      en: 'Johannes Kepler',             sub: 'Johannes Kepler' },
    'ev:beagle':         { q: 'Q35926',     en: 'HMS Beagle',                  sub: 'HMS Beagle' }
  };

  // Messages Across Time — the enduring-inscription artifacts shown in the
  // almanac's rosetta panel (almanac.js _renderRosettaStone). Keys match each
  // entry's `id` in /static/rosetta/manifest.json exactly, prefixed
  // 'rosetta:'. Q-IDs verified against Wikidata (wikibase_item via the live
  // English Wikipedia pageprops API, redirects followed).
  var MESSAGES = {
    'rosetta:code-of-hammurabi':   { q: 'Q93304',  en: 'Code of Hammurabi' },
    'rosetta:cyrus-cylinder':      { q: 'Q405008', en: 'Cyrus Cylinder' },
    'rosetta:behistun-inscription':{ q: 'Q180012', en: 'Behistun inscription' },
    'rosetta:rosetta-stone':       { q: 'Q48584',  en: 'Rosetta Stone' },
    'rosetta:magna-carta':         { q: 'Q12519',  en: 'Magna Carta' },
    'rosetta:universal-declaration': { q: 'Q7813', en: 'Universal Declaration of Human Rights' },
    'rosetta:pioneer-plaque':      { q: 'Q412',    en: 'Pioneer plaque' },
    'rosetta:arecibo-message':     { q: 'Q384071', en: 'Arecibo message' },
    'rosetta:golden-record':       { q: 'Q156315', en: 'Voyager Golden Record' },
    'rosetta:georgia-guidestones': { q: 'Q958391', en: 'Georgia Guidestones' }
  };

  var MAP = {};
  [PLANETS, PROBES, CONSTELLATIONS, SHOWERS, ECLIPSES, CALENDARS, ZODIAC, STARS, HOLIDAYS, TERMS, SEASONS, BELTS, EVENTS, MESSAGES]
    .forEach(function (group) { for (var k in group) if (group.hasOwnProperty(k)) MAP[k] = group[k]; });

  // Register curated holidays under a "holiday:<norm>" key so wrapHoliday() can
  // map a displayed label straight to its curated Q-ID entry.
  for (var hn in HOLIDAYS) if (HOLIDAYS.hasOwnProperty(hn)) MAP['holiday:' + hn] = HOLIDAYS[hn];

  function _norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // -- Preloaded Q-ID -> article map (the closed set, resolved once) --------
  //
  // On almanac open we send the whole curated Q-ID set to the server
  // (/almanac-links, in chunks) and get back {qid -> {zim, path, title}} for
  // the Q-IDs that resolve to an article in the installed library. That map is
  // authoritative: an entity whose Q-ID is present renders as a direct link
  // (tap -> openArticle, zero further requests); every other entity renders as
  // plain text. There is no title search, no probe, no on-tap fetch -- a Q-ID
  // that doesn't resolve is simply not a link.

  // A ZIM is an "encyclopedia" target if it's a wikipedia-family or vikidia
  // archive. Mirrors _ALMANAC_ENC_RE server-side; used here only to (a) skip
  // the batch entirely when nothing could resolve and (b) key the cache.
  var _ENC_RE = /^(wikipedia|vikidia)/i;
  var _encNamesCache = null; // reset per open via reset()

  function _encZimNames() {
    if (_encNamesCache) return _encNamesCache;
    var list = (typeof zimsCache !== 'undefined' && zimsCache) ? zimsCache : [];
    _encNamesCache = list
      .filter(function (z) { return z && _ENC_RE.test(z.name); })
      .map(function (z) { return z.name; });
    return _encNamesCache;
  }

  // Language preference for resolution order: user's article-language prefs ->
  // UI language -> English. Sent to the server, which picks the best ZIM per ID.
  function _prefLangs() {
    var order = [];
    try {
      var prefs = (typeof _getPrefLanguages === 'function') ? _getPrefLanguages() : [];
      for (var i = 0; i < prefs.length; i++) {
        if (prefs[i] && prefs[i] !== 'multi' && order.indexOf(prefs[i]) < 0) order.push(prefs[i]);
      }
    } catch (e) {}
    if (typeof _currentLang !== 'undefined' && _currentLang && order.indexOf(_currentLang) < 0) {
      order.push(_currentLang);
    }
    if (order.indexOf('en') < 0) order.push('en');
    return order;
  }

  // All curated Q-IDs (the closed set), deduped. Entities without a `q` field
  // contribute nothing -- they can never become links.
  function _allQids() {
    var seen = {}, out = [];
    for (var k in MAP) {
      if (!MAP.hasOwnProperty(k)) continue;
      var q = MAP[k] && MAP[k].q;
      if (q && !seen[q]) { seen[q] = 1; out.push(q); }
    }
    return out;
  }

  // Parallel {qid: en-title} for the closed set. The server uses these as an
  // EXACT-TITLE fallback when a candidate ZIM has no prebuilt Q-ID index (e.g. a
  // full English Wikipedia): the curated `en` title maps deterministically to
  // the entry path, so no ~35h index build is needed for English. Deduped by
  // Q-ID (first title wins), same closed set as _allQids.
  function _qidTitles() {
    var out = {};
    for (var k in MAP) {
      if (!MAP.hasOwnProperty(k)) continue;
      var e = MAP[k];
      if (e && e.q && e.en && !out[e.q]) out[e.q] = e.en;
    }
    return out;
  }

  var _qidLinks = {};     // 'Qxxx' -> {zim, path, title}   (resolved hits only)
  var _qidSig = null;     // signature of the library+langs _qidLinks was built for
  var _qidLoaded = false; // a batch response has landed for the current signature

  // The server rejects an oversized batch outright (ALMANAC_QID_BATCH_MAX in
  // interlang.py). The curated set is already larger than one batch and grows
  // with every entity added, so it is split into chunks that stay under that
  // cap — send it whole and the single 400 leaves EVERY entity plain text.
  // Must stay <= the server cap; tests/test_almanac_links.py pins that.
  var _QID_BATCH_SIZE = 200;

  function _chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  // Resolve one chunk to its {qid: hit} map, or null if the request failed —
  // the caller keeps a failed signature retryable while still using whatever
  // other chunks came back.
  function _fetchChunk(qids, langs, titles) {
    var sub = {};
    for (var i = 0; i < qids.length; i++) {
      if (titles[qids[i]]) sub[qids[i]] = titles[qids[i]];
    }
    return fetch('/almanac-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qids: qids, langs: langs, titles: sub })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return data ? (data.links || {}) : null; })
      .catch(function () { return null; });
  }

  // Signature so the session cache re-fetches only when the library or language
  // prefs actually change (re-fetch on library change -- not on every open).
  function _signature(names, langs) {
    return names.slice().sort().join(',') + '|' + langs.join(',');
  }

  // Batch-resolve the closed set for the current library. Cached per signature;
  // a no-op when the signature is unchanged (reopen with a warm cache renders
  // links on the first paint, no flash). Fail-soft: offline / no encyclopedia /
  // no server -> the map stays empty and every entity is plain text.
  function _preload() {
    var names = _encZimNames();
    var langs = _prefLangs();
    var sig = _signature(names, langs);
    if (sig === _qidSig && _qidLoaded) return;   // warm cache -- nothing to do
    _qidSig = sig;
    _qidLoaded = false;
    _qidLinks = {};
    if (!names.length) { _qidLoaded = true; return; } // no target -> all plain text
    var qids = _allQids();
    if (!qids.length) { _qidLoaded = true; return; }
    var titles = _qidTitles();
    Promise.all(_chunk(qids, _QID_BATCH_SIZE).map(function (part) {
      return _fetchChunk(part, langs, titles);
    })).then(function (parts) {
      if (sig !== _qidSig) return; // superseded by a newer reset()
      var merged = {}, complete = true;
      parts.forEach(function (p) {
        if (!p) { complete = false; return; }
        for (var q in p) if (p.hasOwnProperty(q)) merged[q] = p[q];
      });
      _qidLinks = merged;
      // A chunk that failed (offline / no server) leaves the signature unloaded
      // so the next open retries; what did land still renders as links.
      _qidLoaded = complete;
      // Entities that rendered plain before the batch landed become links now.
      if (typeof _almanacOpen !== 'undefined' && _almanacOpen &&
          typeof _renderAlmanacContent === 'function') {
        _renderAlmanacContent();
      }
    });
  }

  // The curated Q-ID for an entity key, or null.
  function _qidFor(key) {
    var entry = key ? MAP[key] : null;
    return entry && entry.q ? entry.q : null;
  }

  // The resolved article for an entity key, or null. Public so the canvas
  // modules (orrery, star chart) can ask "is this body a link?" before wiring a
  // tap — the same closed-set authority the DOM linkify path uses. Returns the
  // {zim, path, title} hit so a caller can, e.g., set cursor:pointer only over
  // linkable bodies. Unresolved key (or batch not yet landed) -> null.
  function linkFor(key) {
    var q = _qidFor(key);
    return (q && _qidLinks[q]) ? _qidLinks[q] : null;
  }

  // -- Open (direct, from the preloaded map) --------------------------------

  // The reader overlay renders beneath the open almanac view, so we must leave
  // the almanac before opening an article -- otherwise the article loads hidden.
  // Suspend (not close) so the #almanac history entry survives and Back returns
  // to it; returns the scroll offset to restore on return.
  function _leaveAlmanac() {
    try {
      if (typeof _suspendAlmanacForLink === 'function') return _suspendAlmanacForLink();
      if (typeof closeAlmanac === 'function') closeAlmanac();
    } catch (e) {}
    return 0;
  }

  // Open a tapped entity directly from the preloaded map. Only linked entities
  // are tappable, so a missing hit is a no-op -- never a dead end, never a
  // toast, never a search.
  function open(key) {
    if (typeof openArticle !== 'function') return;
    var q = _qidFor(key);
    var hit = q ? _qidLinks[q] : null;
    if (!hit) return;
    var scroll = _leaveAlmanac();
    openArticle(hit.zim, hit.path, hit.title);
    // Stamp the return intent AFTER openArticle (which clears it for normal
    // opens), so a Back from this article reopens the almanac at `scroll`.
    window._almReturnScroll = scroll;
  }

  // -- Linkify helpers for render sites -------------------------------------

  function _escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _linkSpan(key, innerHtml) {
    return '<span class="alm-link" role="link" tabindex="0" data-alm-key="' +
      _escAttr(key) + '">' + innerHtml + '</span>';
  }

  // Wrap an already-escaped label in a tappable span IFF its curated Q-ID
  // resolved to an installed article. Otherwise return the label untouched
  // (plain text). Resolution is by Q-ID, never by title.
  function wrap(key, innerHtml) {
    var q = _qidFor(key);
    return (q && _qidLinks[q]) ? _linkSpan(key, innerHtml) : innerHtml;
  }

  // Holiday convenience: map the displayed label to its curated entry, then
  // link only if that entry's Q-ID resolved. `region` (an ISO code, when the
  // label came from a country pack) lets a shared label like "Independence Day"
  // resolve to the RIGHT country's article: the region-qualified key
  // (`<norm>_<region>`) is tried first, then the bare norm. Uncurated labels
  // stay plain text -- closed set, no guessing.
  function wrapHoliday(displayHtml, label, region) {
    var n = _norm(label);
    if (region) {
      var rk = n + '_' + String(region).toLowerCase();
      if (HOLIDAYS[rk]) return wrap('holiday:' + rk, displayHtml);
    }
    return HOLIDAYS[n] ? wrap('holiday:' + n, displayHtml) : displayHtml;
  }

  function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Linkify one "on this day" event string: HTML-escape the whole text, and —
  // when the event's subject Q-ID resolved to an installed article — wrap just
  // the subject phrase (`sub`, exactly as it appears in the text) in a tappable
  // link. Unresolved / uncurated / phrase-not-found → the plain escaped text.
  function linkifyEvent(text, key) {
    var full = _escHtml(text);
    var entry = key ? MAP[key] : null;
    if (!entry || !entry.sub || !(entry.q && _qidLinks[entry.q])) return full;
    var escSub = _escHtml(entry.sub);
    var idx = full.indexOf(escSub);
    if (idx < 0) return full;
    return full.slice(0, idx) + _linkSpan(key, escSub) + full.slice(idx + escSub.length);
  }

  // -- Delegated tap handler (bound once) -----------------------------------

  function _handle(e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.classList && el.classList.contains('alm-link')) {
        e.preventDefault(); e.stopPropagation();
        open(el.getAttribute('data-alm-key') || null);
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

  // Called on every almanac open. Drops the encyclopedia-name cache (the
  // library may have changed) and kicks off the batch preload; _preload()
  // itself no-ops when the signature is unchanged, so a reopen with the same
  // library reuses the session cache.
  function reset() {
    _encNamesCache = null;
    _preload();
  }

  window.AlmanacLinks = {
    MAP: MAP, wrap: wrap, wrapHoliday: wrapHoliday, linkifyEvent: linkifyEvent,
    open: open, bind: bind, reset: reset, linkFor: linkFor
  };
})();
