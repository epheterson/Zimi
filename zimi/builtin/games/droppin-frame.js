/* ZimiGames: Drop Pin's map frame. The real map is a third party's page (a StreetZim viewer) in a frame of ours. In the game it is
   only a map: where it looks is read from the map itself, and its own help is put away: the search box, the place chips, the cards
   a tap opens, directions, the layer menu. Our own code, GPL-3.0.

   What can and cannot be done to a page we did not write (the frame is on our own origin, so its document and its map object are ours to reach):
   - Its interface is hidden by walking its document: the map's container and everything that holds it stay, and every other element
     beside them is hidden, whatever its name; a new one that appears later (a card a tap opens) is hidden as it comes (a mutation
     observer). Nothing here depends on StreetZim's own class names, only on the map library's (MapLibre/Mapbox, Leaflet and OpenLayers
     name their containers the same way in every site), so a viewer that changes its look is still put away.
   - What the map draws is changed through the map object the viewer leaves on its window (__szMap and the older names): the place
     name asked for is taken off every label layer, the rest of the labels stay as the landmarks you find it by. A viewer that exposes
     no map object keeps its labels (we cannot reach into its canvas), and so does a name written into the tiles as a picture.
   - Another place that has the same name on its label, or a longer name that holds it ("Valley of X"), is a different label and stays.
   - Where the map looks is the map's own centre (getCenter), else its address (#map=zoom/lat/lon), which a viewer writes only once the
     person has moved it: the reason "the map has not loaded yet" was shown above a map that had loaded. */
(function (root) {
  'use strict';
  var HANDLES = ['__szMap', '__streetzim_map', '__openzim_map'];
  var CONTAINERS = '.maplibregl-map, .mapboxgl-map, .leaflet-container, .ol-viewport';
  // Inside the container, what is the map itself: its canvas, the zoom buttons and the credit line the licences ask for.
  var KEEP = '.maplibregl-canvas-container, .mapboxgl-canvas-container, .leaflet-pane, .leaflet-map-pane, .ol-layers, .maplibregl-ctrl-attrib, .mapboxgl-ctrl-attrib, .leaflet-control-attribution, .leaflet-control-zoom, .ol-zoom, .ol-attribution';
  var NAME_KEYS = ['name', 'name:en', 'name:latin', 'name_en', 'name:nonlatin', 'name_int'];
  var POLL_MS = 400, GIVE_UP_MS = 45000;

  function handle(win) {
    for (var i = 0; i < HANDLES.length; i++) {
      var m = null;
      try { m = win[HANDLES[i]]; } catch (e) { m = null; }
      if (m && typeof m.getCenter === 'function' && typeof m.getZoom === 'function') return m;
    }
    return null;
  }
  function parseHash(hash) {
    var m = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(String(hash || ''));
    if (!m) return null;
    var p = { zoom: parseFloat(m[1]), lat: parseFloat(m[2]), lon: parseFloat(m[3]) };
    return isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 ? p : null;
  }
  // Where the map looks now, or null before it can say: its own centre first, then the address it wrote.
  function centre(frame) {
    try {
      var win = frame.contentWindow, map = handle(win);
      if (map) {
        var c = map.getCenter();
        var lon = c.lng !== undefined ? c.lng : c.lon;
        if (c && isFinite(c.lat) && isFinite(lon)) return { lat: c.lat, lon: lon, zoom: map.getZoom() };
      }
      return parseHash(win.location.hash);
    } catch (e) { return null; }
  }

  // Everything beside the map is hidden. The leaves stay whole (the canvas, the zoom buttons, the credit line); the nodes on the way down
  // to them from the page's root stay and are searched for company; every other element is hidden.
  var LEAVES = KEEP + ', .maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out, .mapboxgl-ctrl-zoom-in, .mapboxgl-ctrl-zoom-out';
  function hideBeside(doc, container) {
    var leaves = Array.prototype.slice.call(container.querySelectorAll(LEAVES)), paths = [];
    function addPath(from) { for (var n = from; n && n !== doc; n = n.parentNode) if (paths.indexOf(n) < 0) paths.push(n); }
    addPath(container);
    leaves.forEach(function (l) { addPath(l.parentNode); });
    function visit(parent) {
      Array.prototype.forEach.call(parent.children, function (c) {
        if (/^(SCRIPT|STYLE|LINK|META|TITLE|HEAD)$/.test(c.tagName) || leaves.indexOf(c) >= 0) return;
        if (paths.indexOf(c) >= 0) visit(c); else c.style.setProperty('display', 'none', 'important');
      });
    }
    paths.forEach(function (n) { if (n.nodeType === 1) visit(n); });
  }

  // The name asked for comes off every label layer of the map; `name` null puts the labels back (the answer is shown).
  function labels(map, name) {
    var style;
    try { style = map && map.getStyle && map.getStyle(); } catch (e) { return false; }
    if (!style || !style.layers) return false;
    map.__dpBase = map.__dpBase || {};
    style.layers.forEach(function (l) {
      if (l.type !== 'symbol') return;
      if (!(l.id in map.__dpBase)) map.__dpBase[l.id] = l.filter || null;
      var base = map.__dpBase[l.id], f = base;
      if (name) {
        f = ['all'].concat(base ? [base] : [], NAME_KEYS.map(function (k) { return ['!=', ['get', k], name]; }));
      }
      try { map.setFilter(l.id, f); } catch (e) { /* a layer a filter cannot be set on keeps its labels */ }
    });
    return true;
  }

  // Put a loading frame into game mode for `name`. Returns { reveal(), stop() }: reveal() brings the labels back.
  function mode(frame, name, onReady) {
    var timer = 0, observer = null, started = Date.now(), ready = false, labelled = false, stopped = false;
    function apply() {
      if (stopped) return;
      var win, doc, container;
      try { win = frame.contentWindow; doc = win.document; container = doc.querySelector(CONTAINERS); } catch (e) { container = null; }
      if (container) {
        hideBeside(doc, container);
        if (!observer && win.MutationObserver) {
          var queued = false;
          observer = new win.MutationObserver(function () {
            if (queued) return;
            queued = true;
            win.requestAnimationFrame(function () { queued = false; if (!stopped) { try { hideBeside(doc, container); } catch (e) { /* the page is going away */ } } });
          });
          observer.observe(doc.body, { childList: true, subtree: true });
        }
      }
      var map = handle(win || {});
      if (map && !labelled) {
        try { if (!map.isStyleLoaded || map.isStyleLoaded()) labelled = labels(map, name); } catch (e) { labelled = false; }
        if (map.once && !labelled) try { map.once('idle', function () { if (!stopped) labelled = labels(map, name); }); } catch (e) { /* none */ }
      }
      if (!ready && centre(frame)) { ready = true; if (onReady) onReady(); }
      if (Date.now() - started > GIVE_UP_MS && ready) { clearInterval(timer); timer = 0; }
    }
    timer = setInterval(apply, POLL_MS);
    apply();
    return {
      reveal: function () { try { labels(handle(frame.contentWindow), null); } catch (e) { /* none */ } },
      stop: function () { stopped = true; if (timer) clearInterval(timer); if (observer) observer.disconnect(); }
    };
  }

  root.DropPinFrame = { centre: centre, mode: mode, parseHash: parseHash, handle: handle };
})(this);
