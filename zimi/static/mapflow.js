// A map for any place, from every view (fetched the first time a place asks for one).
//
// The 3D view and its Go to sheet, an article with coordinates, and the Almanac's place all end in the same two
// moves: open the installed map that holds the place, or offer the map worth downloading for it. The choice is the
// server's (zimi/mapchoice.py, GET /map-for: the smallest region that holds the point, the newest, then the smallest
// file, the planet last), so the four views cannot disagree. Here: ask once per spot, open, or show the offers.
//
// Nothing is offered a person cannot take: without the right to download, the offers are not shown, and a place no
// installed map holds and nothing is on offer for gets a button that says nothing.

var ZimiMapHere = (function () {
  var MAP_FOR_URL = '/map-for';
  var CACHE_DECIMALS = 2;            // a spot is asked once to about a kilometre
  var ZOOM_TOWN = 12;                // a map opened on a place: a town and around it
  var ZOOM_PLANET = 5;               // the map of everywhere opens wider
  var STYLE_ID = 'mh-style';
  var SHEET_ID = 'mh-sheet';
  var MAP_SVG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>';
  var DOWN_SVG = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M6 12l6 6 6-6"/></svg>';
  var CSS =
    '.mh-btn{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:0 6px;border:0;border-radius:8px;background:none;color:var(--text3);cursor:pointer;font:inherit}' +
    '.mh-btn[hidden]{display:none}' +
    '.mh-btn:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}' +
    '@media (hover:hover){.mh-btn:hover{color:var(--amber)}}' +
    '.mh-sheet{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));max-width:480px;margin:0 auto;z-index:2147483000;box-sizing:border-box;padding:6px;background:var(--surface,#161b22);color:var(--text,#e6edf3);border:1px solid var(--border);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.45)}' +
    '.mh-row{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:0 12px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;font-size:14px;text-align:start;cursor:pointer}' +
    '.mh-row:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}' +
    '@media (hover:hover){.mh-row:hover{background:rgba(255,255,255,.06)}}' +
    '.mh-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mh-tag{margin-inline-start:8px;font-size:11px;color:var(--text3)}' +
    '.mh-note{display:block;font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis}' +    '.mh-meta{display:inline-flex;align-items:center;gap:6px;color:var(--text3);font-size:12px;white-space:nowrap}' +
    '.mh-row.mh-busy{opacity:.5;pointer-events:none}';
  var cache = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tr(key) { return typeof t === 'function' ? t(key) : key; }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function key(lat, lng) { return lat.toFixed(CACHE_DECIMALS) + ',' + lng.toFixed(CACHE_DECIMALS); }
  function valid(lat, lng) { return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180; }

  // Someone who may not download is not shown downloads.
  function canDownload() {
    return typeof downloadZim === 'function' && !(typeof _managePwRequired !== 'undefined' && _managePwRequired && typeof _manageToken !== 'undefined' && !_manageToken);
  }

  // What the server says of a spot: { installed: [...], offers: [...], world: [...] }, or null when it cannot say.
  function lookup(lat, lng) {
    if (!valid(lat, lng)) return Promise.resolve(null);
    var k = key(lat, lng);
    if (!cache[k]) {
      var get = typeof authedFetch === 'function' ? authedFetch : fetch;
      cache[k] = get(MAP_FOR_URL + '?lat=' + lat.toFixed(4) + '&lng=' + lng.toFixed(4)).then(function (r) {
        if (!r.ok) throw new Error('map-for ' + r.status);
        return r.json();
      }).catch(function () { delete cache[k]; return null; });
    }
    return cache[k];
  }

  // What can be done for the spot: 'open', 'offer' or ''.
  function outcome(answer) {
    if (!answer) return '';
    if (answer.installed && answer.installed.length) return 'open';
    return canDownload() && ((answer.offers || []).length || (answer.world || []).length) ? 'offer' : '';
  }

  function zoomFor(map) { return map.world ? ZOOM_PLANET : ZOOM_TOWN; }

  function openMap(map, lat, lng, label) {
    var pos = mapPositionHash(zoomFor(map), lat, lng);
    var opts = { pos: pos, label: label || '' };
    var almanacOpen = typeof _almanacOpen !== 'undefined' && _almanacOpen;
    if (almanacOpen && window.AlmanacLinks && AlmanacLinks.openHit) AlmanacLinks.openHit({ zim: map.name, path: map.main_path, title: label || map.title }, opts);
    else openArticle(map.name, map.main_path, label || map.title, opts);
  }

  function offerRow(o) {
    var source = o.source === 'streetzim' ? 'StreetZim' : 'Kiwix';
    var overlaps = (o.overlaps || []).length ? '<span class="mh-note">' + esc(tH('map_offer_overlaps', { maps: o.overlaps.join(', ') })) + '</span>' : '';
    return '<button type="button" class="mh-row" data-mh-url="' + esc(o.download_url) + '" data-mh-title="' + esc(o.title) + '">' +
      '<span class="mh-name">' + esc(o.title) + '<span class="mh-tag">' + source + (o.date ? ' &middot; ' + esc(String(o.date).slice(0, 7)) : '') + '</span>' + overlaps + '</span>' +
      '<span class="mh-meta">' + (o.size_bytes && typeof fmtBytes === 'function' ? esc(fmtBytes(o.size_bytes)) : '') + DOWN_SVG + '</span></button>';
  }

  function closeSheet() {
    var s = document.getElementById(SHEET_ID);
    if (s) s.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } }
  function onOutside(e) { var s = document.getElementById(SHEET_ID); if (s && !s.contains(e.target)) closeSheet(); }

  // The maps worth downloading for the spot, as rows to tap: the regions that hold it, then the planet.
  function showOffers(answer) {
    closeSheet();
    ensureStyle();
    var offers = (answer.offers || []).concat(answer.world || []);
    var sheet = document.createElement('div');
    sheet.id = SHEET_ID;
    sheet.className = 'mh-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', tr('map_here'));
    sheet.innerHTML = offers.map(offerRow).join('');
    document.body.appendChild(sheet);
    sheet.onclick = function (e) {
      var row = e.target.closest && e.target.closest('.mh-row');
      if (!row) return;
      row.classList.add('mh-busy');
      var title = row.getAttribute('data-mh-title') || '';
      Promise.resolve(downloadZim(row.getAttribute('data-mh-url'), null)).then(function () {
        closeSheet();
        if (typeof _showToast === 'function') _showToast(tH('map_offer_started', { map: title }));
      }, function () { row.classList.remove('mh-busy'); });
    };
    document.addEventListener('keydown', onKey, true);
    // Armed after this tap has finished, or the tap that opened the sheet would close it.
    setTimeout(function () { document.addEventListener('pointerdown', onOutside, true); }, 0);
    return sheet;
  }

  // The whole flow for a place: open its map, or offer one, or (nothing to open, nothing to offer) say so.
  function go(lat, lng, label) {
    return lookup(lat, lng).then(function (answer) {
      var what = outcome(answer);
      if (what === 'open') openMap(answer.installed[0], lat, lng, label);
      else if (what === 'offer') showOffers(answer);
      else if (typeof _showToast === 'function') _showToast(tr('map_none_here'));
      return what;
    });
  }

  // A map button's html (an icon alone), hidden until a spot is known to have something behind it: bind() shows it.
  function buttonHtml(cls) {
    ensureStyle();
    return '<button type="button" class="mh-btn' + (cls ? ' ' + cls : '') + '" data-mh hidden aria-label="' + esc(tr('map_here')) + '" title="' + esc(tr('map_here')) + '">' + MAP_SVG + '</button>';
  }
  // Wire a button to a spot ({ lat, lng, label } or a function giving it): shown once the spot has a map to open or offer.
  function bind(btn, spot) {
    if (!btn) return;
    var at = function () { return typeof spot === 'function' ? spot() : spot; };
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      var s = at();
      if (s) go(s.lat, s.lng, s.label);
    };
    var s0 = at();
    if (!s0) return;
    lookup(s0.lat, s0.lng).then(function (answer) { if (btn.isConnected && outcome(answer)) btn.hidden = false; });
  }

  return { lookup: lookup, outcome: outcome, go: go, bind: bind, buttonHtml: buttonHtml, openMap: openMap, showOffers: showOffers, closeSheet: closeSheet, canDownload: canDownload, MAP_SVG: MAP_SVG, DOWN_SVG: DOWN_SVG, ensureStyle: ensureStyle };
})();
