// ── Almanac: Sent ──
// Everything people have sent away from Earth, and where each one is now. One job: go and see it, or be told plainly that it
// cannot be seen. The list is earth/sent-v1.json (an index over what the view already has: the tracked probes, the landing sites
// by name, the ISS, and the things that ended or were lost); "where now" is worked out here from its `where` and the clock, and
// nothing that can be worked out is stored. A row is a pill's row in the Go to sheet (the Sent pill); a tap
//   - standing: flies to the site and opens its card (the landmarks' own);
//   - orbiting / tracked / leaving: flies to the craft where it is (the probes' own presets and card, with the AU and light-time);
//   - ended: goes to the place it ended, and says when and how;
//   - lost, or not yet there: a card with the last contact and the words "position unknown"; nothing is drawn in the scene.
//
// It loads when the Sent pill is first shown, never with the view. Shares the Almanac's global scope; every name here is
// _aeSent* or AE_SENT_*.

var AE_SENT_URL = _almAsset('/static/earth/sent-v1.json');
var AE_SENT_ORBITS = ['earth', 'moon', 'mars', 'jupiter'];       // the bodies a row can say "Orbiting" for (a key each: sent_orbit_<body>)
var AE_SENT_SITE_BODIES = ['moon', 'mars', 'venus', 'titan'];   // "On <body>": a key each
var AE_SENT_PICS_URL = _almAsset('/static/earth/sent-thumbs-v1.webp');   // the models' renders, one sheet (scripts/build_sent_thumbs.py)
var AE_SENT_PICS_COLS = 7;                        // its cells per line; the cells run over the models named in the index, sorted
var AE_SENT_NO_WORLD = 'planets';                 // a lost thing with no world to be near: the whole system, with nothing in it marked
var AE_SENT_ROW_PX = 76, AE_SENT_PIC_PX = 64, AE_SENT_GUTTER_PX = 16, AE_SENT_HEAD_PX = 34, AE_SENT_FOOT_PX = 56;   // the design's row, picture, gutter, section header and footer
var AE_SENT_DISC_PX = 18;                         // a section's world, beside its name
var AE_SENT_GONE = 0.55;                          // a silhouette, and a lost thing's row, at this opacity
// A lost thing's stand-in: a faint wireframe of its class, tumbling slowly near where it was last known. It is a drawing of
// the kind of craft, not of this craft, and it is not tracked: the card says so.
var AE_SENT_GHOST_OPACITY = 0.55, AE_SENT_GHOST_SPAN = 0.09;   // of the camera's distance: how large it shows
var AE_SENT_GHOST_SIDE = [-1.25, 0.9];                            // where it stands off its world, in the world's radii, left and up as the view first shows it
// (Landsat 1 faces the camera, still: a stand-in, not a craft in motion.)                           // a row with no place to go shows this faint
// A silhouette per class, in the Go to glyphs' 24-unit stroke style. They are the class, not the craft ("shape is generic").
var AE_SENT_SHAPES = {
  orbiter: AE_GLYPH_CRAFT,
  lander: _aeGlyph('<path d="M8 17v-5l4-4 4 4v5z"/><path d="M8 17l-3 4M16 17l3 4M3 21h4M17 21h4"/>'),
  rover: _aeGlyph('<rect x="5" y="9" width="14" height="5" rx="1"/><circle cx="7" cy="17.5" r="2"/><circle cx="12" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/><path d="M15 9V5h3"/>'),
  probe: _aeGlyph('<path d="M4 8h12a6 6 0 0 1-12 0z"/><path d="M10 14v5M7 20h6"/>'),
  telescope: _aeGlyph('<path d="M8 4h8l4 8-4 8H8l-4-8z"/><path d="M12 8v8M8 12h8"/>'),
  impactor: _aeGlyph('<path d="M12 3v13M7 12l5 5 5-5M5 21h14"/>'),
  station: _aeGlyph('<path d="M3 12h18M7 7v10M17 7v10M10 10h4v4h-4z"/>')
};
// The one small sign a row's state wears beside its words.
var AE_SENT_SIGNS = {
  pin: '<path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  loop: '<ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-25 12 12)"/>',
  out: '<path d="M5 19L19 5M10 5h9v9"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  end: '<path d="M6 6l12 12M18 6L6 18"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'
};
var AE_SENT_CSS = [
  '.ae-go-listonly .ae-go-seg{display:none}',
  '.ae-sent-list{display:block}',
  '.ae-sent-row{min-height:' + AE_SENT_ROW_PX + 'px;padding:0 ' + AE_SENT_GUTTER_PX + 'px;gap:' + AE_SENT_GUTTER_PX + 'px;width:100%;border-radius:0}',
  '.ae-sent-img,.ae-sent-sil{flex:none;width:' + AE_SENT_PIC_PX + 'px;height:' + AE_SENT_PIC_PX + 'px}',
  '.ae-sent-img{background-repeat:no-repeat}',
  '.ae-sent-sil{display:flex;align-items:center;justify-content:center;color:var(--text2);opacity:' + AE_SENT_GONE + '}',
  '.ae-sent-sil svg{width:70%;height:70%}',
  '.ae-sent-gone .ae-sent-img,.ae-sent-gone .ae-sent-text{opacity:' + AE_SENT_GONE + '}',
  '.night-red .ae-sent-img{filter:var(--red-picture)}',
  '.ae-sent-text{display:flex;flex-direction:column;min-width:0;gap:3px;line-height:1.25}',
  '.ae-sent-text b{font-size:16px;font-weight:600;white-space:normal;overflow-wrap:break-word;hyphens:auto}',
  '.ae-sent-text small{display:flex;align-items:center;gap:6px;font-size:var(--fs-small,13px);color:var(--text2);flex-wrap:wrap}',
  '.ae-sent-text small span{min-width:0;overflow-wrap:break-word}',
  '.ae-sent-text small i{font-style:normal;flex:none}',
  '.ae-sent-text svg,.ae-sent-h svg{flex:none;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
  '.ae-sent-h{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;height:' + AE_SENT_HEAD_PX + 'px;margin:0;padding:0 ' + AE_SENT_GUTTER_PX + 'px;font-size:var(--fs-caption,11px);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text2);background:' + AE_PANEL_BG + '}',
  '.night-red .ae-sent-h{background:' + AE_PANEL_BG_RED + '}',
  '.ae-sent-h b{margin-inline-start:auto;font-weight:600;font-variant-numeric:tabular-nums}',
  '.ae-sent-h .ae-go-thumb{--s:' + AE_SENT_DISC_PX + 'px}',
  '.ae-sent-count{margin:4px ' + AE_SENT_GUTTER_PX + 'px 6px;font-size:var(--fs-small,13px);color:var(--text2)}',
  '.ae-sent-foot{position:sticky;bottom:0;z-index:2;height:' + AE_SENT_FOOT_PX + 'px;width:100%;border-radius:0;border-top:1px solid var(--border);background:' + AE_PANEL_BG + ';color:var(--text);font-weight:600}',
  '.night-red .ae-sent-foot{background:' + AE_PANEL_BG_RED + '}',
  '.ae-sent-foot svg{width:22px;height:22px;color:var(--amber)}',
  '.ae-sent-head{display:flex;align-items:center;gap:12px}',
  '.ae-sent-head .ae-sent-img,.ae-sent-head .ae-sent-sil{width:48px;height:48px}',
  '.ae-sent-lab{position:absolute;pointer-events:none;transform:translate(-50%,0);text-align:center;font-size:var(--fs-small,13px);line-height:1.3;color:var(--text);text-shadow:0 0 6px #000,0 0 3px #000}',
  '.ae-sent-lab b{display:block;font-size:var(--fs-body,15px)}',
  '.ae-sent-ring{position:absolute;pointer-events:none;transform:translate(-50%,-50%);border:2px dotted var(--text2);border-radius:50%}'
].join('');
(function () {
  var st = document.createElement('style');
  st.textContent = AE_SENT_CSS;
  document.head.appendChild(st);
})();

// Each class's wireframe as pairs of corners, about one unit across.
var AE_SENT_BOX = function (w, h, d, y) {
  var x = w / 2, z = d / 2, a = y - h / 2, b = y + h / 2, c = [[-x, a, -z], [x, a, -z], [x, a, z], [-x, a, z], [-x, b, -z], [x, b, -z], [x, b, z], [-x, b, z]], e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return e.map(function (k) { return [c[k[0]], c[k[1]]]; });
};
var AE_SENT_GHOSTS = {
  orbiter: function () { return AE_SENT_BOX(0.34, 0.34, 0.34, 0).concat(AE_SENT_BOX(0.5, 0.01, 0.3, 0).map(function (s) { return s.map(function (p) { return [p[0] + (p[0] > 0 ? 0.42 : -0.42), p[1], p[2]]; }); })); },
  lander: function () {
    var top = AE_SENT_BOX(0.3, 0.01, 0.3, 0.1)[0], legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (k) { return [[k[0] * 0.15, 0.1, k[1] * 0.15], [k[0] * 0.4, -0.3, k[1] * 0.4]]; });
    return AE_SENT_BOX(0.3, 0.2, 0.3, 0).concat(legs);
  },
  probe: function () {
    var ring = [], n = 14, i;
    for (i = 0; i < n; i++) ring.push([[Math.cos(i / n * 6.2832) * 0.4, 0.15, Math.sin(i / n * 6.2832) * 0.4], [Math.cos((i + 1) / n * 6.2832) * 0.4, 0.15, Math.sin((i + 1) / n * 6.2832) * 0.4]], [[Math.cos(i / n * 6.2832) * 0.4, 0.15, Math.sin(i / n * 6.2832) * 0.4], [0, -0.1, 0]]);
    return ring.concat([[[0, -0.1, 0], [0, -0.55, 0]]]);
  }
};
function _aeSentGhostGroup(cls) {
  var S = _ae.gl, T = S.THREE, shape = (AE_SENT_GHOSTS[cls] || AE_SENT_GHOSTS.orbiter)(), pos = [];
  shape.forEach(function (seg) { pos.push(seg[0][0], seg[0][1], seg[0][2], seg[1][0], seg[1][1], seg[1][2]); });
  var geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
  var line = new T.LineSegments(geo, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: AE_SENT_GHOST_OPACITY, depthWrite: false }));
  line.frustumCulled = false;
  return line;
}
// Each frame (almanac-earth.js _aeDraw): the stand-in of the lost thing whose card is up, near its world; gone with the card.
function _aeSentGhostDraw(now) {
  var g = _ae.sentGhost, s = _ae.sent, S = _ae.gl, o = s && s.o;
  if (g && (!o || g.o !== o)) { S.scene.remove(g.line); g.line.geometry.dispose(); g.line.material.dispose(); _ae.sentGhost = g = null; }
  if (!g && o && o.state === 'lost' && o.where.body && S && _ae.scene) {
    var e = S.camera.matrixWorld.elements, t0 = AE_TARGETS[o.where.body];   // fixed in the world from here on, off the world's rim as first seen
    _ae.sentGhost = g = { o: o, line: _aeSentGhostGroup(o.cls),
      off: t0 ? _aeAdd(_aeScale([e[0], e[1], e[2]], AE_SENT_GHOST_SIDE[0] * t0.surface), _aeScale([e[4], e[5], e[6]], AE_SENT_GHOST_SIDE[1] * t0.surface)) : null };
  }
  if (!g) return;
  if (!g.line.parent) S.scene.add(g.line);
  var c = _aeBodyPos(o.where.body), cam = S.camera.position;
  if (!c || !g.off) { g.line.visible = false; return; }
  var at = _aeAdd(c, g.off), far = _aeLen(_aeSub([cam.x, cam.y, cam.z], at));
  g.line.visible = true;
  g.line.position.set(at[0], at[1], at[2]);
  g.line.scale.setScalar(far * AE_SENT_GHOST_SPAN);
  g.line.quaternion.copy(S.camera.quaternion);
}
function _aeSentSign(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + AE_SENT_SIGNS[name] + '</svg>'; }
function _aeSentObj(key) {
  var id = key.slice(AE_SENT.length), at = _aeSent ? _aeSent.byId[id] : null;
  return at || { id: id, name: id, cls: 'orbiter', where: {} };
}
// A day is taken at noon UTC, so it reads as that day wherever it is shown; a month as its first.
function _aeSentMs(date) { return Date.parse(date.length === 7 ? date + '-01T00:00:00Z' : date + 'T12:00:00Z'); }
function _aeSentFindLanding(w) {
  var rows = _aeLm && _aeLm[w.body];
  if (!rows) return null;
  for (var i = 0; i < rows.length; i++) if (rows[i][3] === 'landing' && rows[i][0] === w.site) return rows[i];
  return null;
}
// What a row says today (the real date, not the view's clock), and where a tap goes: { word: a key, year, sign, go }. go: 'site', 'craft' (key), 'spot', 'body', or 'card'
// (nothing to fly to: the card says why).
function _aeSentNow(o) {
  var ms = Date.now(), w = o.where, jd = ms / MS_PER_DAY + JD_UNIX_EPOCH;   // the list is about today, wherever the view's clock is
  var yr = (w.at || w.last || o.launch).slice(0, 4);
  if (ms < _aeSentMs(o.launch)) return { word: 'sent_not_yet', sign: 'wait', go: 'card', year: yr };
  var done = w.at || w.last;
  if (done && o.state !== 'standing' && ms < _aeSentMs(done)) return { word: 'sent_en_route', sign: 'wait', go: 'card', year: yr };
  switch (o.state) {
    case 'standing':
      if (ms < _aeSentMs(w.at)) return { word: 'sent_en_route', sign: 'wait', go: 'card', year: yr };
      return { word: 'sent_on_' + w.body, sign: 'pin', go: 'site', year: yr };
    case 'orbiting':   // the ISS has a place (its elements are in the view); the others are known to be at their world, not where in the orbit
      if (w.iss) return { word: 'sent_orbit_' + w.body, sign: 'loop', go: _ae.issPos ? 'craft' : 'card', craft: 'iss', year: yr };
      if (_aeOrbiterOf(w.norad)) return { word: 'sent_orbit_' + w.body, sign: 'loop', go: _aeSatOf(_aeOrbiterOf(w.norad)) ? 'craft' : 'card', craft: _aeOrbiterOf(w.norad), year: yr };   // a telescope with a model: its place is SGP4's
      return { word: 'sent_orbit_' + w.body, sign: 'loop', go: 'body', year: yr };
    case 'tracked':
    case 'leaving': {
      var tr = _aeTracks && _aeTracks.tracks[w.track];
      if (!tr) return { word: o.state === 'leaving' ? 'sent_leaving' : 'sent_sun_orbit', sign: o.state === 'leaving' ? 'out' : 'sun', go: 'card', year: yr };
      if (jd < tr.jd0) return { word: 'sent_not_yet', sign: 'wait', go: 'card', year: yr };
      if (jd > tr.jd1) return { word: 'sent_unknown', sign: 'wait', go: 'card', year: yr };   // past the table: not guessed
      var orbit = null, l2 = false;
      tr.events.forEach(function (e) {
        if (e[0] > jd) return;
        if (e[1] === 'orbit') orbit = String(e[2]).toLowerCase();
        if (e[1] === 'arrive' && e[2] === 'L2') l2 = true;
      });
      var word = l2 ? 'sent_l2' : orbit && AE_SENT_ORBITS.indexOf(orbit) >= 0 ? 'sent_orbit_' + orbit : o.state === 'leaving' ? 'sent_leaving' : 'sent_sun_orbit';
      return { word: word, sign: l2 || orbit ? 'loop' : o.state === 'leaving' ? 'out' : 'sun', go: 'craft', craft: w.track, year: yr };
    }
    case 'retired': {   // switched off in a Sun orbit (or at L2): its table's end is its last known place, held there for any date
      var rt = _aeTracks && _aeTracks.tracks[w.track];
      return { word: 'sent_retired', sign: 'end', go: rt ? 'craft' : 'card', craft: w.track, year: yr };
    }
    case 'ended':
      return { word: 'sent_' + w.how, sign: 'end', go: w.lat !== undefined ? 'spot' : 'body', year: yr };
  }
  return { word: 'sent_lost', sign: 'end', go: 'body', year: yr };   // the view goes to the world it was last near (or the whole system), and draws nothing
}
function _aeSentWords(now) { return _aeT(now.word, { year: now.year }); }
// The row's picture: its model's render from the sheet, on no plate; a class silhouette (an outline, at 55 percent) where there is no model.
function _aeSentPicture(o) {
  var at = _aeSent.pics[o.model];
  if (at === undefined) return '<i class="ae-sent-sil">' + _aeGlyph(AE_SENT_SHAPES[o.cls] || AE_GLYPH_CRAFT) + '</i>';
  var c = at % AE_SENT_PICS_COLS, r = Math.floor(at / AE_SENT_PICS_COLS), rows = _aeSent.picRows;
  return '<i class="ae-sent-img" style="background-image:url(' + AE_SENT_PICS_URL + ');background-size:' + AE_SENT_PICS_COLS * 100 + '% ' + rows * 100 +
    '%;background-position:' + (c / (AE_SENT_PICS_COLS - 1) * 100) + '% ' + (rows > 1 ? r / (rows - 1) * 100 : 0) + '%"></i>';
}
function _aeSentRow(key) {
  var o = _aeSentObj(key), now = _aeSentNow(o);
  var gone = now.go === 'card' || now.word === 'sent_lost' || (o.state === 'standing' && !_aeLm) ? ' ae-sent-gone' : '';
  return '<button type="button" class="ae-go-row ae-sent-row' + gone + '" data-ae-go="' + key + '">' + _aeSentPicture(o) + '<span class="ae-sent-text"><b>' + _almEsc(o.name) +
    '</b><small>' + _aeSentSign(now.sign) + '<span>' + _almEsc(_aeSentWords(now)) + '</span>' +
    (now.word === 'sent_lost' || now.word.indexOf('sent_en') === 0 ? '' : '<i> · ' + o.year + '</i>') + '</small></span></button>';
}
// The sections a person thinks in, by where each is now, nearest Earth first: { order, key of its heading, world (its disc) or sign }.
function _aeSentSection(now) {
  var w = now.word, on = AE_SENT_SITE_BODIES.indexOf(w.slice('sent_on_'.length));
  if (w.indexOf('sent_on_') === 0) return { order: 10 + on, key: w, world: AE_SENT_SITE_BODIES[on] };
  if (w.indexOf('sent_orbit_') === 0) { var b = w.slice('sent_orbit_'.length); return { order: 20 + AE_SENT_ORBITS.indexOf(b), key: w, world: b }; }
  if (w === 'sent_l2') return { order: 20 + AE_SENT_ORBITS.length, key: w, sign: 'loop' };
  if (w === 'sent_sun_orbit') return { order: 30, key: 'sent_h_solar', world: 'sun' };
  if (w === 'sent_leaving') return { order: 40, key: w, sign: 'out' };
  if (w === 'sent_retired') return { order: 45, key: 'sent_h_retired', sign: 'end' };
  if (w === 'sent_lost') return { order: 70, key: 'sent_h_lost', sign: 'end' };
  if (w === 'sent_en_route' || w === 'sent_not_yet' || w === 'sent_unknown') return { order: 50 + (w === 'sent_en_route' ? 0 : 1), key: w, sign: 'wait' };
  return { order: 60, key: 'sent_h_ended', sign: 'end' };
}
// Only what can be shown is listed (spacecraft with a model): a craft with its model's render and a place to go
// today (the site it stands at, a table or the ISS to fly to, or the spot it came down at). One with no model, or only a world to go near, keeps its
// data and is left out of the sheet's list and search.
function _aeSentListed(o) {
  if (_aeSent.pics[o.model] === undefined) return false;
  var now = _aeSentNow(o), go = now.go;
  if (go === 'craft') return now.craft === 'iss' || !!AE_CRAFT_MODEL[now.craft];   // a craft is listed only with a model to fly to, never a bare dot
  return go === 'site' ? !!_aeSentFindLanding(o.where) : go === 'spot';
}
function _aeSentListedObjects() { return _aeSent.objects.filter(_aeSentListed); }
// "122 things sent from Earth".
function _aeSentCount() {
  return '<p class="ae-sent-count">' + _almEsc(_aeT('sent_count', { things: _aeSentListedObjects().length })) + '</p>';
}
// The rows, under a header per place (its world's disc or sign, its name, how many); inside one, in the order of the index: alive by
// launch, ended and lost newest first. "Plan a flight" is the sheet's foot: a way to make a trip, not a thing that was sent.
// The grid's Sent from Earth: tiles of real model renders, grouped by where they are with a count; a model shared by several (Lunar Orbiter,
// the Voyagers) is ONE tile with its missions listed beside the name ("Lunar Orbiter 1, 2, 3, 5"); a tap lists them, one row each, to choose
// which (_aeSentChoose).
function _aeSentTileLabel(objs) {
  if (objs.length === 1) return objs[0].name;
  var m = objs.map(function (o) { return /^(.*?)\s+(\d+)$/.exec(o.name); });
  if (m.every(function (x) { return x && x[1] === m[0][1]; })) return m[0][1] + ' ' + m.map(function (x) { return x[2]; }).join(', ');
  return objs.map(function (o) { return o.name; }).join(', ');
}
var AE_SENT_SITE_ORDER = 20;   // the sections below this are the landers standing on a world (_aeSentSection): places to stand; the rest are things to fly to
// `onSites`: only the landers on their worlds (they sit with the landing sites); else everything else, under the Sent heading.
function _aeSentGrid(onSites) {
  var groups = {}, total = 0;
  _aeSentListedObjects().forEach(function (o) {
    var sec = _aeSentSection(_aeSentNow(o));
    if ((sec.order < AE_SENT_SITE_ORDER) !== !!onSites) return;
    total++;
    var g = groups[sec.order] || (groups[sec.order] = { sec: sec, byModel: {}, order: [], n: 0 });
    var key = o.model || ('~' + o.id);
    if (!g.byModel[key]) { g.byModel[key] = []; g.order.push(key); }
    g.byModel[key].push(o); g.n++;
  });
  return (onSites ? '' : '<h4 class="ae-sent-top">' + _almEsc(_aeT('alm_go_sent')) + '<b>' + total + '</b></h4>') + Object.keys(groups).sort(function (a, b) { return a - b; }).map(function (k) {
    var g = groups[k], mark = g.sec.world ? '<span class="ae-go-thumb">' + _aeGoDisc(g.sec.world) + '</span>' : _aeSentSign(g.sec.sign);
    return '<h4 class="ae-sent-h" data-g="' + g.sec.key + '">' + mark + '<span>' + _almEsc(_aeT(g.sec.key)) + '</span><b>' + g.n + '</b></h4><div class="ae-sent-tiles">' + g.order.map(function (m) {
      var objs = g.byModel[m];
      var go = objs.length > 1 ? 'data-ae-choose="' + objs.map(function (o) { return o.id; }).join(',') + '" aria-expanded="false"' : 'data-ae-go="' + AE_SENT + objs[0].id + '"';   // several: a tap lists them to choose from
      return '<button type="button" class="ae-go-row ae-sent-tile" ' + go + '>' + _aeSentPicture(objs[0]) + '<span>' + _almEsc(_aeSentTileLabel(objs)) + '</span></button>';
    }).join('') + '</div>';
  }).join('');
}
// A tile of several (the Apollo landers, the Voyagers) tapped: their rows open under its line of tiles, each a place to go; a
// second tap on it closes them.
function _aeSentChoose(tile) {
  var tiles = tile.parentNode, open = tiles.querySelector('.ae-sent-choose'), was = tile.getAttribute('aria-expanded') === 'true';
  Array.prototype.forEach.call(tiles.querySelectorAll('[aria-expanded="true"]'), function (t) { t.setAttribute('aria-expanded', 'false'); });
  if (open) open.remove();
  if (was) return;
  tile.setAttribute('aria-expanded', 'true');
  // Under the tile's own line of the grid, the width of the grid.
  var cells = Array.prototype.filter.call(tiles.children, function (c) { return c.classList.contains('ae-sent-tile'); });
  var cols = Math.max(1, getComputedStyle(tiles).gridTemplateColumns.split(' ').length), at = cells.indexOf(tile), end = cells[Math.min(cells.length - 1, at - at % cols + cols - 1)];
  // The list of a tile's missions loaded out of view and took a lot of space: one
  // chip each (its name and year, the picture is the tile's), wrapping under the tile's line, and the line brought into view.
  end.insertAdjacentHTML('afterend', '<div class="ae-sent-choose">' + tile.getAttribute('data-ae-choose').split(',').map(function (id) {
    var o = _aeSent.byId[id];
    return o ? '<button type="button" class="pill ae-sent-pick" data-ae-go="' + AE_SENT + id + '">' + _almEsc(o.name) + ' <span>' + o.year + '</span></button>' : '';
  }).join('') + '</div>');
  var box = end.nextElementSibling;
  if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: _aeReduceMotion() ? 'auto' : 'smooth' });
}
// The face of a landing site's card: its lander's render (the sent object whose place is this site), else nothing (the card draws the world's disc).
function _aeSentFaceFor(lm) {
  if (!_aeSent) return '';
  for (var i = 0; i < _aeSent.objects.length; i++) {
    var o = _aeSent.objects[i], w = o.where;
    if (w && w.body === lm.body && w.site === lm.row[0] && _aeSent.pics[o.model] !== undefined) return _aeSentPicture(o);
  }
  return '';
}
function _aeSentRows() {
  var groups = {};
  _aeSentListedObjects().forEach(function (o) {
    var sec = _aeSentSection(_aeSentNow(o)), g = groups[sec.order] || (groups[sec.order] = { sec: sec, rows: [] });
    g.rows.push(_aeSentRow(AE_SENT + o.id));
  });
  return _aeSentCount() + Object.keys(groups).sort(function (a, b) { return a - b; }).map(function (k) {
    var g = groups[k], mark = g.sec.world ? '<span class="ae-go-thumb">' + _aeGoDisc(g.sec.world) + '</span>' : _aeSentSign(g.sec.sign);
    return '<h4 class="ae-sent-h" data-g="' + g.sec.key + '">' + mark + '<span>' + _almEsc(_aeT(g.sec.key)) + '</span><b>' + g.rows.length + '</b></h4>' + g.rows.join('');
  }).join('');   // (a planner is for a later release: no row for it here)
}
// What is typed, against name, year (launch, or the end's) and world, every word of it; the rows that answer, in the list's order.
function _aeSentFind(typed) {
  var words = _aePlaceNorm(typed).split(' ').filter(Boolean);
  return _aeSent ? _aeSentListedObjects().filter(function (o) {
    var w = o.where, hay = [o.name, String(o.year), (w.at || w.last || '').slice(0, 4), w.body || '', w.body ? _aeGoName(w.body) : ''].map(_aePlaceNorm).join(' ');
    return words.every(function (x) { return hay.indexOf(x) >= 0; });
  }).map(function (o) { return AE_SENT + o.id; }) : [];
}
function _aeSentEndedKeys() {
  return _aeSent.objects.filter(function (o) { return o.state === 'ended' || o.state === 'lost' || o.state === 'retired'; }).map(function (o) { return AE_SENT + o.id; });
}
function _aeSentLoad() {
  if (_aeSent || typeof fetch !== 'function') return;
  _aeTracksLoad(); _aeLmLoad();   // the probes' places and the sites' rows, for the words and the taps
  fetch(AE_SENT_URL).then(function (r) { if (!r.ok) throw new Error('sent'); return r.json(); }).then(function (d) {
    d.byId = {};
    d.objects.forEach(function (o) { d.byId[o.id] = o; });
    d.pics = {};
    d.objects.map(function (o) { return o.model; }).filter(function (m, i, all) { return m && all.indexOf(m) === i; }).sort().forEach(function (m, i) { d.pics[m] = i; });
    d.picRows = Math.ceil(Object.keys(d.pics).length / AE_SENT_PICS_COLS);
    _aeSent = d;
    _aeGoRender();
    if (_ae && _ae.info) _aeRenderInfo();   // a craft's sheet that asked for the index: its operator and mass are here now
    if (_ae && _ae.lm) _aeRenderCard();     // a site's card: its craft's face
  }).catch(function () { _aeSent = { objects: [], byId: {} }; _aeGoRender(); });   // the pill is empty until a reload asks again
}
// Someone already driving on this body: a row with a place on it is a destination for the vehicle (goTo, almanac-sites.js), not
// a flight away. Answers whether the drive took it (a place beyond its reach falls back to the flight).
function _aeSentDriveTo(o, row) {
  var w = o.where, at = row ? { lat: row[1], lon: row[2] } : w.lat !== undefined ? { lat: w.lat, lon: w.lon } : null;
  if (!at || !_ae.site || _ae.site.body !== w.body || typeof _aeDriveGoTo !== 'function') return false;
  at.name = o.name;
  return _aeDriveGoTo(at).ok;
}
// The view's clock may be somewhere the thing cannot be (the visit to Apollo 11 leaves it in July 1969): a row that needs another time
// brings the clock to it first, to now, or for a site to its landing.
function _aeSentClock(o) {
  var shown = _aeDisplayMs(), w = o.where, tr = _aeTracks && w.track ? _aeTracks.tracks[w.track] : null, jd = shown / MS_PER_DAY + JD_UNIX_EPOCH;
  if (o.state === 'standing') {
    var land = _aeSentMs(w.at);
    if (shown >= land || Date.now() < land) return false;
    _aeGoTo(land);
    return true;
  }
  if (shown >= _aeSentMs(o.launch) && !(tr && (jd < tr.jd0 || jd > tr.jd1))) return false;
  _aeNow();
  return true;
}
// The ship is flying: a row with a world is a destination for it (almanac-fly.js _aeFlyGoTo, which takes a world's key), as it is for the
// rover while driving. A craft with no world (a probe in the solar system) is not one the ship can be sent to; its row flies the camera.
function _aeSentShipTo(o) {
  var body = o.where.body;
  return !!(_ae.ship && body && typeof _aeFlyGoTo === 'function' && _aeFlyGoTo(body).ok);
}
// A row tapped. The sheet is already put away.
function _aeSentPick(key) {
  if (_ae.ship || !_aeSentClock(_aeSentObj(key))) { _aeSentGo(key); return; }
  requestAnimationFrame(function () { requestAnimationFrame(function () { _aeSentGo(key); }); });   // the scene takes the new time on its next frame
}
// An Earth-orbiting craft the satellites layer knows (its NORAD number, where.norad): the layer comes up for this visit (not kept
// for the next), the craft is marked with its orbit, and the camera looks down on it from beyond its height. Sent's card stays.
var AE_SENT_SAT_VIEW = 2.2;   // the camera's distance from the Earth's centre, as a multiple of the craft's
function _aeSentSat(o) {
  var norad = o.where.norad, kept = _aeSatsAllKept();
  _aeSatsAllLoad().then(function () {
    if (!_as.on) { _asSet(true); if (!kept) _asPref(false); }
    _aeLinkWait(function () { return _as.state === 'ready' && !!_as.data && !!_as.lib && !!_ae.scene; }, function () {
      var i = _as.data.norad.indexOf(norad), st = i >= 0 ? _asStateAt(i, _aeDisplayMs()) : null;
      if (!st || !_ae.sent || _ae.sent.o !== o) return;
      _asSelect(i);
      var q = _aeTemeToScene(st.pos, _aeEqEq(_ae.scene));
      _aeFlyTo('earth', _aeLen(q) * AE_SENT_SAT_VIEW, _aeAzElOf(q));
    });
  }).catch(function () {});
}
function _aeSentGo(key) {
  var o = _aeSentObj(key), now = _aeSentNow(o), w = o.where, row;
  _ae.sent = _ae.lm = _ae.place = _ae.pick = null;   // the card is this row's, whatever was up before
  if ((now.go === 'site' || now.go === 'spot') && _aeSentDriveTo(o, now.go === 'site' ? _aeSentFindLanding(w) : null)) return;
  var shipped = _aeSentShipTo(o);
  if (now.go === 'site' && (row = _aeSentFindLanding(w))) {
    if (shipped) { _aeLmOpen(w.body, row); return; }   // the ship is on its way: the site's card is up
    _aeLmOpen(w.body, row);
    _aeLmFly(w.body, row, 'wide');
    if (!o.model) { _ae.lm.note = _aeT('sent_generic'); _aeRenderCard(); }   // the site's card says the picture is not its own
    return;
  }
  if (!shipped && now.go === 'craft' && (now.craft === 'iss' ? _ae.issPos : _aeIsCraft(now.craft))) {
    _aePreset(now.craft);
    if (o.model) return;
  }
  if (shipped) { /* on its way */ }
  else if (now.go === 'body') { _aePreset(w.body || AE_SENT_NO_WORLD); if (w.norad) _aeSentSat(o); }
  else if (now.go === 'spot') { _aeLmFly(w.body, [o.name, w.lat, w.lon, 'landing']); _ae.lm = null; }
  // Where it came down is marked, as a site is, with a dot where it actually happened.
  _ae.sent = { o: o, hit: null, spot: now.go === 'spot' ? { body: w.body, row: [o.name, w.lat, w.lon, 'landing'] } : null };
  if (o.qid && window.AlmanacLinks && AlmanacLinks.resolve) {
    var sent = _ae.sent;
    AlmanacLinks.resolve([o.qid]).then(function (links) {
      if (_ae.sent !== sent || !links[o.qid]) return;
      sent.hit = links[o.qid];
      _aeRenderCard();
    });
  }
  _aeRenderCard();
}
// The card for what has no place to go to, or went to where it ended: when, where, and what is not known.
function _aeRenderSentCard(card) {
  var s = _ae.sent, o = s.o, w = o.where, now = _aeSentNow(o), name = _almEsc(o.name), lines = [_aeSentWords(now)];
  var date = function (d) { return d.length === 7 ? d.slice(0, 4) : _aeFmtDate(_aeSentMs(d)); };
  if (o.state === 'ended' && now.word.indexOf('sent_en') !== 0) lines = [_aeT('sent_' + w.how, { year: w.at.slice(0, 4) }), _aeGoName(w.body) + (w.at.length === 10 ? ' · ' + date(w.at) : '')];
  else if (o.state === 'lost' && now.word.indexOf('sent_en') !== 0) lines = [_aeT('sent_last_contact', { date: date(w.last) }) + (w.body ? ' · ' + _aeGoName(w.body) : ''), _aeT('sent_unknown')].concat(w.body ? [_aeT('sent_ghost')] : []);
  else if (o.state === 'orbiting' && !w.iss && !(w.norad && typeof _asHasSel === 'function' && _asHasSel())) lines.push(_aeT('sent_orbit_where'));   // (marked in the satellites layer: its place is shown)
  else if (now.go === 'card') lines.push(_aeT('sent_unknown'));
  if (_aeSent.pics[o.model] === undefined) lines.push(_aeT('sent_generic'));   // a silhouette is the class, not the craft
  var pic = _aeSentPicture(o);
  card.innerHTML = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<div class="ae-sent-head">' + pic + '<div><h3>' + (s.hit ? '<a href="#" id="ae-sent-read">' + name + '</a>' : name) + '</h3>' +
    lines.map(function (l) { return '<p class="ae-lm-line"><span>' + _almEsc(l) + '</span></p>'; }).join('') + '</div></div>';
  card.hidden = false;
  _aeById('ae-card-x').onclick = function () { _ae.sent = null; _aeRenderCard(); };
  var read = _aeById('ae-sent-read');
  if (read) read.onclick = function (e) { e.preventDefault(); AlmanacLinks.openHit(s.hit); };
}
_aeSentLoad();
