/* ZimCity's citizens: four invented people (no real person, living or dead) who say what they think on the news line.
   Our own code, GPL-3.0. Each has a voice and a thing they care about, and their mood is read from the city as it is:
   the commuter from traffic, the developer from demand and land value, the activist from pollution and the warming,
   the rival for mayor from how much people like the mayor (he is happiest when they do not). The words are in
   text/<lang>.json (city.v.*); a person's name is the same in every language. */

export var PEOPLE = [
  { id: 'commuter', name: 'Dale Pemberton' },
  { id: 'developer', name: 'Vivian Crane' },
  { id: 'activist', name: 'Juniper Ash' },
  { id: 'rival', name: 'Gordon Plumb' }
];
export var LINES = 2;   // variants for each person and mood

// The facts the moods read: {traffic 0 to 240, demand -1 to 1, land 0 to 250, pollution 0 to 255, warm 0 to 4,
// approval 0 to 100, data centers}.
export function stats(sim, warm) {
  var bm = sim.blockMaps, t = bm.trafficDensityMap, lv = bm.landValueMap, sum = 0, n = 0, land = 0, ln = 0;
  for (var x = 0; x < t.width; x++) for (var y = 0; y < t.height; y++) {
    var v = t.get(x, y); if (v) { sum += v; n++; }
    var l = lv.get(x, y); if (l) { land += l; ln++; }
  }
  var vv = sim._valves;
  return { traffic: n ? sum / n : 0, demand: (vv.resValve / 2000 + vv.comValve / 1500) / 2, land: ln ? land / ln : 0,
           pollution: sim._census.pollutionAverage || 0, warm: warm || 0, approval: sim.evaluation.cityYes,
           data: (sim._census.zc && sim._census.zc.data) || 0 };
}

// 'good', 'meh' or 'bad' for one person.
export function mood(id, s) {
  if (id === 'commuter') return s.traffic > 90 ? 'bad' : s.traffic < 35 ? 'good' : 'meh';
  if (id === 'developer') return s.demand > 0.3 && s.land > 60 ? 'good' : s.demand < -0.1 ? 'bad' : 'meh';
  if (id === 'activist') return s.pollution > 90 || s.warm > 1 || s.data > 1 ? 'bad' : s.pollution < 30 && s.warm < 0.3 ? 'good' : 'meh';
  if (id === 'rival') return s.approval > 60 ? 'bad' : s.approval < 40 ? 'good' : 'meh';
  return 'meh';
}

// Whose turn it is: the one with the strongest feeling who did not speak last, then the next in line.
export function next(s, last) {
  var strong = PEOPLE.filter(function (p) { return p.id !== last && mood(p.id, s) !== 'meh'; });
  if (strong.length) return strong[0];
  var i = PEOPLE.findIndex(function (p) { return p.id === last; });
  return PEOPLE[(i + 1) % PEOPLE.length];
}

// What a person says about something that just happened, by event: a few voices react to each.
export var REACT = {
  datacenter: ['developer', 'activist', 'commuter'],
  solar: ['activist', 'rival'],
  wind: ['activist', 'rival'],
  heatwave: ['commuter', 'activist'],
  sea: ['activist', 'developer']
};
