/* ZimCity: what the engine's messages and tiles are called, the tools' icons and the credit. Our own code, GPL-3.0.
   The words themselves are in text/<lang>.json (city.*); this file only says which id goes with which engine name. */

import * as M from './zimcity/engine/messages.js';
import * as TV from './zimcity/engine/tileValues.js';

// The engine's front-end messages, each to its words. HEAVY_TRAFFIC has the same text as FUNDS_CHANGED upstream, but it
// only ever arrives as a message subject, never as the funds event, so the two never meet here.
export var MESSAGE = {};
[
  [M.NEED_AIRPORT, 'city.msg.needAirport'], [M.NEED_FIRE_STATION, 'city.msg.needFire'], [M.NEED_ELECTRICITY, 'city.msg.needPower'],
  [M.NEED_MORE_INDUSTRIAL, 'city.msg.needIndustry'], [M.NEED_MORE_COMMERCIAL, 'city.msg.needShops'], [M.NEED_MORE_RESIDENTIAL, 'city.msg.needHomes'],
  [M.NEED_MORE_RAILS, 'city.msg.needRail'], [M.NEED_MORE_ROADS, 'city.msg.needRoads'], [M.NEED_POLICE_STATION, 'city.msg.needPolice'],
  [M.NEED_SEAPORT, 'city.msg.needPort'], [M.NEED_STADIUM, 'city.msg.needStadium'], [M.ROAD_NEEDS_FUNDING, 'city.msg.roadFunds'],
  [M.FIRE_STATION_NEEDS_FUNDING, 'city.msg.fireFunds'], [M.POLICE_NEEDS_FUNDING, 'city.msg.policeFunds'],
  [M.BLACKOUTS_REPORTED, 'city.msg.brownouts'], [M.NOT_ENOUGH_POWER, 'city.msg.blackouts'], [M.EARTHQUAKE, 'city.msg.earthquake'],
  [M.EXPLOSION_REPORTED, 'city.msg.explosion'], [M.FLOODING_REPORTED, 'city.msg.flood'], [M.FIRE_REPORTED, 'city.msg.fire'],
  [M.HEAVY_TRAFFIC, 'city.msg.heavyTraffic'], [M.TRAFFIC_JAMS, 'city.msg.jams'], [M.HELICOPTER_CRASHED, 'city.msg.copter'],
  [M.PLANE_CRASHED, 'city.msg.plane'], [M.SHIP_CRASHED, 'city.msg.ship'], [M.TRAIN_CRASHED, 'city.msg.train'],
  [M.HIGH_CRIME, 'city.msg.crime'], [M.HIGH_POLLUTION, 'city.msg.pollution'], [M.MONSTER_SIGHTED, 'city.msg.monster'],
  [M.NUCLEAR_MELTDOWN, 'city.msg.meltdown'], [M.TORNADO_SIGHTED, 'city.msg.tornado'], [M.TAX_TOO_HIGH, 'city.msg.tax'],
  [M.NO_MONEY, 'city.msg.broke'], [M.REACHED_TOWN, 'city.msg.town'], [M.REACHED_CITY, 'city.msg.city'],
  [M.REACHED_CAPITAL, 'city.msg.capital'], [M.REACHED_METROPOLIS, 'city.msg.metropolis'], [M.REACHED_MEGALOPOLIS, 'city.msg.megalopolis']
].forEach(function (p) { MESSAGE[p[0]] = p[1]; });
// Disasters and crashes go to the front of the line.
export var URGENT = M.DISASTER_MESSAGES.concat(M.CRASHES, [M.NOT_ENOUGH_POWER, M.BLACKOUTS_REPORTED]);

// What a tile is, for the inspect sheet: the first tile of each kind, in order, as upstream's query window had them.
var KINDS = [
  [TV.DIRT, 'clear'], [TV.RIVER, 'water'], [TV.TREEBASE, 'trees'], [TV.RUBBLE, 'rubble'], [TV.FLOOD, 'flood'], [TV.RADTILE, 'waste'],
  [TV.FIRE, 'fire'], [TV.ROADBASE, 'road'], [TV.POWERBASE, 'wire'], [TV.RAILBASE, 'rail'], [TV.RESBASE, 'residential'],
  [TV.COMBASE, 'commercial'], [TV.INDBASE, 'industrial'], [TV.PORTBASE, 'port'], [TV.AIRPORTBASE, 'airport'], [TV.COALBASE, 'coal'],
  [TV.FIRESTBASE, 'fire'], [TV.POLICESTBASE, 'police'], [TV.STADIUMBASE, 'stadium'], [TV.NUCLEARBASE, 'nuclear'],
  [TV.HBRDG0, 'bridge'], [TV.RADAR0, 'radar'], [TV.FOUNTAIN, 'fountain'], [TV.INDBASE2, 'industrial'], [TV.FOOTBALLGAME1, 'stadium'],
  [TV.VBRDG0, 'bridge'], [952, 'waste']
];
// The kind's id under city.kind.*; a fire station and a fire share 'fire' in upstream's list, so the station is told apart.
export function kindOf(value) {
  if (value >= TV.COALSMOKE1 && value < TV.FOOTBALLGAME1) value = TV.COALBASE;
  var i = 0;
  while (i < KINDS.length - 1 && value >= KINDS[i + 1][0]) i++;
  if (KINDS[i][0] === TV.FIRESTBASE) return 'city.kind.firestation';
  return 'city.kind.' + KINDS[i][1];
}
// A road or a bridge (a zone grows only beside one).
export function isRoad(v) { return v >= TV.ROADBASE && v <= TV.LASTROAD; }
// The query's four-step scales, as upstream reads them from the block maps.
export function quarter(v) { return (v >> 6) & 3; }
export function landStep(v) { return v >= 150 ? 3 : v >= 80 ? 2 : v >= 30 ? 1 : 0; }
// Growth runs from -200 to 200; upstream's bit trick read a small decline as fast growth, so it is stepped plainly here.
export function growthStep(v) { return v < -20 ? 0 : v <= 20 ? 1 : v <= 100 ? 2 : 3; }

// One stroke path per tool (24 x 24, drawn in the text's colour; a zone's square takes its zone colour from the CSS).
export var ICON = {
  road: 'M7 3v18M17 3v18M12 4v3M12 10.5v3M12 17v3',
  wire: 'M13 2L5 13h6l-1 9 8-11h-6l1-9z',
  residential: 'M4 11l8-7 8 7v9H4zM10 20v-5h4v5',
  commercial: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6',
  industrial: 'M3 20V10l5 3v-3l5 3V6h4l1 14M3 20h18',
  bulldozer: 'M3 16h10v-5H7l-4 3zM13 13h3M17 8v10l4 1M5 19.5h7',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  rail: 'M8 3L6 21M16 3l2 18M7 7h10M6.5 12h11M6 17h12',
  park: 'M12 3l-5 8h3l-4 6h12l-4-6h3zM12 17v4',
  police: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  fire: 'M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 2 1 3 3 3 5',
  stadium: 'M3 9c0-3 4-5 9-5s9 2 9 5v6c0 3-4 5-9 5s-9-2-9-5zM3 9c0 3 4 5 9 5s9-2 9-5',
  port: 'M12 3v15M8 7h8M5 13a7 7 0 0 0 14 0M3 21h18',
  airport: 'M21 15l-8-4V5a1.5 1.5 0 0 0-3 0v6l-8 4v2l8-2v4l-2 1.5V21l3.5-1 3.5 1v-1.5L13 19v-4l8 2z',
  coal: 'M4 21V11l5-3v3l5-3v3h2V4h3v17zM4 21h16',
  nuclear: 'M7 21c1-6 1-11 0-17h10c-1 6-1 11 0 17zM12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4'
};

// About: where the simulation comes from, its licence and the Micropolis name's attribution, with links into the ZIM.
export function credit(T) {
  var p = document.createElement('div');
  p.className = 'gs-text gs-source cy-credit';
  var line = document.createElement('p');
  line.textContent = T('city.about.credit');
  p.appendChild(line);
  var links = document.createElement('p');
  [['zimcity/ENGINE.md', 'city.about.engine'], ['zimcity/LICENSE.txt', 'city.about.licence'], ['zimcity/MicropolisPublicNameLicense.md', 'city.about.name']].forEach(function (l, i) {
    if (i) links.appendChild(document.createTextNode(' · '));
    var a = document.createElement('a');
    a.href = l[0]; a.textContent = T(l[1]);
    links.appendChild(a);
  });
  p.appendChild(links);
  var tm = document.createElement('p');
  tm.textContent = T('city.about.trademark');
  p.appendChild(tm);
  return p;
}
