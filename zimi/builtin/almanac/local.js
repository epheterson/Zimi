/* The Almanac's own answers, for the pages that ask a Zimi server and have none: this ZIM, read in Kiwix, in a
   browser from a file, or offline. Two things are answered from files packed in the ZIM, the same two Zimi's
   server answers from its own shipped snapshots:
     /almanac-satellites   the GPS and ISS elements, as of the release (satellites.py get(): the snapshot, never
                           the internet, so it says how old it is)
     /almanac-place        the tide stations nearest a place, or named like a query (placedata.py near and search)
   The satellites answer also says whether Almanac HD is in this ZIM (the maxi flavour holds the tile pyramids under
   hd/): {hd: {installed, base}}, the same shape Zimi's server gives, with the tiles' base a path from this page.
   Anything else a server would answer is "not here" (a 404), and the page says so in its own words.
   Our own code, GPL-3.0. No network beyond this ZIM's own files. */
(function (root) {
  'use strict';
  var Local = {};
  var SATELLITES_FILE = 'data/satellites-snapshot.json';
  var TIDES_FILE = 'data/tides-snapshot.json';
  var SATELLITES_URL = '/almanac-satellites';
  var PLACE_URL = '/almanac-place';
  var HD_FILE = 'hd/hd.json', HD_BASE = 'hd/';
  var STALE_AFTER_S = 6 * 3600;           // satellites.py CACHE_TTL_S
  var EARTH_RADIUS_KM = 6371.0;
  var NEAR_TIDES = 6, SEARCH_LIMIT = 8, MAX_QUERY = 80;   // placedata.py
  var realFetch = root.fetch ? root.fetch.bind(root) : null;

  // ── the files, read once ──
  var files = {};
  function read(path) {
    if (!files[path]) {
      files[path] = realFetch(path).then(function (r) { if (!r.ok) throw new Error(path); return r.json(); });
      files[path].catch(function () { delete files[path]; });
    }
    return files[path];
  }
  // Almanac HD's state: present in the maxi flavour of this ZIM, absent (a 404) in the standard one. A 404 is the answer and is
  // kept; a failed or slow-to-fail request is not an answer, so the next ask looks again.
  var hdState;
  function hd() {
    if (!hdState) {
      var asked = hdState = realFetch(HD_FILE).then(function (r) {
        if (r.ok) return { installed: true, base: HD_BASE, mode: 'never', offer: null, downloading: null };
        if (r.status !== 404) hdState = undefined;
        return null;
      }, function () { if (hdState === asked) hdState = undefined; return null; });
    }
    return hdState;
  }
  function json(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ── satellites ──
  Local.satellites = function (snapshot, nowS) {
    var age = nowS - snapshot.fetched_at;
    return { source: 'snapshot', fetched: snapshot.fetched, gps: snapshot.gps, iss: snapshot.iss,
      stale: age > STALE_AFTER_S, refreshing: false, mode: 'never', locked: null, can_change: false };
  };

  // ── tide stations (a port of placedata.py) ──
  Local.fold = function (s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  function rad(d) { return d * Math.PI / 180; }
  Local.km = function (lat1, lon1, lat2, lon2) {
    var p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  function prepare(raw) {
    var by = {}, stations = raw.stations.map(function (st) {
      var o = Object.assign({}, st);
      o._k = Local.fold((st.n || '') + ' ' + (st.s || ''));
      by[o.id] = o;
      return o;
    });
    return { meta: raw, stations: stations, by: by };
  }
  function publicOf(st, extra) {
    var out = {};
    Object.keys(st).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = st[k]; });
    return Object.assign(out, extra || {});
  }
  function tideOut(tides, st, lat, lon) {
    var extra = {};
    if (lat !== null) extra.km = Math.round(Local.km(lat, lon, st.la, st.lo) * 10) / 10;
    var ref = st.ref && tides.by[st.ref];
    if (ref) extra.refrec = publicOf(ref);
    return publicOf(st, extra);
  }
  function wrap(tides, stations) {
    var m = tides.meta;
    return { tides: { constituents: m.constituents, fetched: m.fetched, source: m.source, datum: m.datum, stations: stations } };
  }
  Local.near = function (tides, lat, lon) {
    var coslat = Math.cos(rad(lat));
    function rough(st) { var dlo = ((st.lo - lon + 180) % 360 + 360) % 360 - 180; return Math.pow(st.la - lat, 2) + Math.pow(dlo * coslat, 2); }
    var picked = tides.stations.slice().sort(function (a, b) { return rough(a) - rough(b); }).slice(0, NEAR_TIDES);
    return wrap(tides, picked.map(function (s) { return tideOut(tides, s, lat, lon); }));
  };
  Local.search = function (tides, q, lat, lon) {
    var words = Local.fold(q).slice(0, MAX_QUERY).split(/\s+/).filter(Boolean);
    if (!words.length) return wrap(tides, []);
    var found = tides.stations.filter(function (s) { return words.every(function (w) { return s._k.indexOf(w) >= 0; }); });
    var located = lat !== null;
    function rank(s) { return [s._k.indexOf(words[0]) === 0 ? 0 : 1, located ? Local.km(lat, lon, s.la, s.lo) : s._k]; }
    var ranked = found.map(function (s) { return { s: s, r: rank(s) }; }).sort(function (a, b) {
      if (a.r[0] !== b.r[0]) return a.r[0] - b.r[0];
      return a.r[1] < b.r[1] ? -1 : a.r[1] > b.r[1] ? 1 : 0;
    });
    return wrap(tides, ranked.slice(0, SEARCH_LIMIT).map(function (x) { return tideOut(tides, x.s, lat, lon); }));
  };
  function coord(v, lo, hi) {
    if (v === null || v === '') return null;
    var x = Number(v);
    return isFinite(x) && x >= lo && x <= hi ? x : null;
  }

  // ── the page's fetch ──
  // A promise of a Response for a URL a server would answer, or null when it is not ours.
  Local.answer = function (url) {
    var u;
    try { u = new URL(url, root.location.href); } catch (e) { return null; }
    if (u.pathname === SATELLITES_URL) {
      return Promise.all([read(SATELLITES_FILE), hd()]).then(function (r) {
        var out = Local.satellites(r[0], Date.now() / 1000);
        if (r[1]) out.hd = r[1];
        return json(out);
      }, function () { return json({ error: 'not here' }, 404); });
    }
    if (u.pathname === PLACE_URL) {
      var p = u.searchParams, lat = coord(p.get('lat'), -90, 90), lon = coord(p.get('lon'), -180, 180), q = (p.get('q') || '').trim();
      if (lat === null || lon === null) lat = lon = null;
      if (!q && lat === null) return Promise.resolve(json({ error: 'lat and lon, or q' }, 400));
      return read(TIDES_FILE).then(function (raw) {
        var tides = Local._tides || (Local._tides = prepare(raw));
        return json(q ? Local.search(tides, q, lat, lon) : Local.near(tides, lat, lon));
      }, function () { return json({ error: 'not here' }, 404); });
    }
    return null;
  };
  Local._prepare = prepare;
  root.ZimiAlmanacLocal = Local;
})(typeof window !== 'undefined' ? window : globalThis);
