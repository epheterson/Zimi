/* ZimCity and the player's library. Our own code, GPL-3.0.

   What a tile is and what happens in the city have real articles: a coal plant, zoning, a traffic jam, a tornado, a
   town becoming a city. Inside Zimi they are found once, by Wikidata ID (the Almanac's own /almanac-links, which also
   tries the English title in an English Wikipedia), and then the inspect sheet links to the article and a news card
   under the status line shows its lead when it happens. Anywhere else, or when the library lacks the article, there is
   nothing: no link, no card, no gap. */

var Lib = window.GamesLib;

// [Wikidata ID, English title] for each word that has an article. Keys are the city.* string ids the page already uses.
var ARTICLE = {
  'city.kind.coal': ['Q6558431', 'Coal-fired power station'], 'city.kind.nuclear': ['Q134447', 'Nuclear power plant'],
  'city.kind.police': ['Q861951', 'Police station'], 'city.kind.firestation': ['Q1195942', 'Fire station'],
  'city.kind.stadium': ['Q483110', 'Stadium'], 'city.kind.airport': ['Q1248784', 'Airport'], 'city.kind.port': ['Q44782', 'Port'],
  'city.kind.road': ['Q34442', 'Road'], 'city.kind.rail': ['Q3565868', 'Rail transport'], 'city.kind.wire': ['Q2144320', 'Overhead power line'],
  'city.kind.residential': ['Q674950', 'Residential area'], 'city.kind.commercial': ['Q5152545', 'Commercial area'],
  'city.kind.industrial': ['Q1662100', 'Industrial park'], 'city.kind.flood': ['Q8068', 'Flood'], 'city.kind.fire': ['Q3196', 'Fire'],
  'city.kind.clear': ['Q702232', 'Zoning'],
  'city.msg.brownouts': ['Q4976620', 'Brownout (electricity)'], 'city.msg.blackouts': ['Q828827', 'Power outage'],
  'city.msg.earthquake': ['Q7944', 'Earthquake'], 'city.msg.explosion': ['Q179057', 'Explosion'], 'city.msg.flood': ['Q8068', 'Flood'],
  'city.msg.fire': ['Q168983', 'Conflagration'], 'city.msg.heavyTraffic': ['Q244156', 'Traffic congestion'], 'city.msg.jams': ['Q244156', 'Traffic congestion'],
  'city.msg.copter': ['Q108284447', 'Aviation accidents and incidents'], 'city.msg.plane': ['Q108284447', 'Aviation accidents and incidents'],
  'city.msg.ship': ['Q852190', 'Shipwreck'], 'city.msg.train': ['Q1331380', 'Derailment'], 'city.msg.crime': ['Q83267', 'Crime'],
  'city.msg.pollution': ['Q131123', 'Air pollution'], 'city.msg.monster': ['Q1065444', 'Kaiju'], 'city.msg.meltdown': ['Q105807', 'Nuclear meltdown'],
  'city.msg.tornado': ['Q8081', 'Tornado'], 'city.msg.tax': ['Q8161', 'Tax'], 'city.msg.broke': ['Q152074', 'Bankruptcy'],
  'city.msg.town': ['Q3957', 'Town'], 'city.msg.city': ['Q515', 'City'], 'city.msg.capital': ['Q5119', 'Capital city'],
  'city.msg.metropolis': ['Q200250', 'Metropolis'], 'city.msg.megalopolis': ['Q471822', 'Megalopolis'],
  'city.kind.datacenter': ['Q671224', 'Data center'], 'city.kind.solar': ['Q1003207', 'Photovoltaic power station'], 'city.kind.wind': ['Q194356', 'Wind farm'],
  'city.msg.datacenter': ['Q671224', 'Data center'], 'city.msg.solar': ['Q1483757', 'Solar power'], 'city.msg.wind': ['Q43302', 'Wind power'],
  'city.msg.heatwave': ['Q215864', 'Heat wave'], 'city.msg.sea': ['Q841083', 'Sea level rise'],
  'climate.change': ['Q125928', 'Climate change'], 'climate.sea': ['Q841083', 'Sea level rise'], 'climate.heat': ['Q215864', 'Heat wave']
};
export var KEYS = Object.keys(ARTICLE);
// More articles to find (the scenarios' and the ready-made cities' real places): call before find().
export function add(more) { Object.keys(more).forEach(function (k) { ARTICLE[k] = more[k]; if (KEYS.indexOf(k) < 0) KEYS.push(k); }); }

// "Open Kyoto on the map": the place on an installed StreetZim map whose box holds it, inside Zimi; else null.
export function mapLink(lat, lon, label, T) {
  if (!Lib) return Promise.resolve(null);
  // Wait for the first look at where we are running: asked before it is done, the answer is not "no map", only "not yet".
  return Lib.mode().then(function (mode) { return mode === 'zimi' ? Lib.library() : null; }).then(function (list) {
    if (!list) return null;
    var m = Lib.mapFor(list, lat, lon, '', label);
    if (!m) return null;
    var a = document.createElement('a');
    a.textContent = T('learn.map', { place: label });
    Lib.articleLink(a, m.zim, m.path);
    return a;
  }, function () { return null; });
}

var found = null;   // {qid: {zim, path, title}} once Zimi has answered; {} anywhere else
function lang() { return window.ZimiText ? String(window.ZimiText.lang || 'en').split('-')[0] : 'en'; }

// Ask once, in the background: nothing waits on it, and until it answers there are simply no links.
export function find() {
  if (found || !Lib || !window.fetch) return Promise.resolve(found || {});
  return Lib.mode().then(function (m) {
    if (m !== 'zimi') { found = {}; return found; }
    var qids = [], titles = {};
    KEYS.forEach(function (k) { var a = ARTICLE[k]; if (qids.indexOf(a[0]) < 0) { qids.push(a[0]); titles[a[0]] = a[1]; } });
    return fetch('/almanac-links', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ qids: qids, langs: lang() === 'en' ? ['en'] : [lang(), 'en'], titles: titles }) })
      .then(function (r) { return r.ok ? r.json() : { links: {} }; })
      .then(function (j) { found = (j && j.links) || {}; return found; }, function () { found = {}; return found; });
  });
}

export function articleFor(key) {
  var a = ARTICLE[key];
  return a && found && found[a[0]] ? found[a[0]] : null;
}

// "Read about Coal-fired power station": a link into Zimi's reader (Back returns to the city), or nothing.
export function link(key, T) {
  var hit = articleFor(key);
  if (!hit) return null;
  var p = document.createElement('p'), a = document.createElement('a');
  p.className = 'gs-text cy-read';
  a.textContent = T('city.read', { title: hit.title });
  Lib.articleLink(a, hit.zim, hit.path);
  p.appendChild(a);
  return p;
}

// The article's lead for a news card: {title, blurb, thumbnail, zim, path}, or null.
export function lead(key) {
  var hit = articleFor(key);
  if (!hit) return Promise.resolve(null);
  var url = Lib.articleUrl(hit.zim, hit.path);
  return Lib.head(url, 60000, 4000).then(function (html) {
    var l = Lib.leadOf(html, location.origin + url);
    return l.blurb ? Object.assign(l, { title: hit.title || l.title, zim: hit.zim, path: hit.path }) : null;
  }, function () { return null; });
}
