// The installed map on the 3D Earth: its roads and place names, drawn onto the globe as the camera comes down.
//
// Fetched by almanac-earth.js (_aeMapsFrame) the first time the camera is below AE_MAPS.loadDist over the Earth, in the
// Almanac's own scope (it calls the view's helpers: _ae, _aeFocalPx, _aeLatLonVec).
//
// What it does, per frame, and what it costs:
//   - below AE_MAPS.startKm of altitude it finds the point under the camera and asks which installed map holds it
//     (ZimiMapHere.lookup, the same answer every view uses; remembered, so a pan inside a map asks nothing);
//   - it wants the slippy tiles round that point at the zoom where a tile is about AE_MAPS.tilePx CSS pixels wide, reads
//     them from the map ZIM (tiles/z/x/y.pbf, Mapbox Vector Tile) in a worker, draws each as roads and names on a
//     canvas, and lays the canvas on the Earth as a patch of sphere a hair above the surface;
//   - the patches fade in between startKm and fullKm; one tile is drawn per frame, never more.
// Where no installed map holds what is looked at, a quiet chip offers the map worth downloading (or, over a map, opens
// it). The map data is OpenStreetMap contributors', as the maps carry it.

var AlmanacMaps = (function () {
  var TILE_CANVAS_PX = 640;           // a tile's canvas: sharp for a tile drawn 320 CSS pixels across on a 2x screen
  var TILE_UNITS = 512;               // the drawing's own units (widths and type sizes below), scaled to the canvas
  var MAX_LOADS = 4;                  // tiles fetched at once
  var MAX_TILES = 28;                 // tiles kept on the GPU: the ring in view and the one just left
  var RING = 1;                       // tiles round the middle one (3 x 3), 2 on a wide screen
  var WIDE_SCREEN_PX = 1000;
  var Z_MIN = 2, Z_MAX_DEFAULT = 12;
  var MAX_COS_LAT = 0.2;
  var SURFACE_LIFT = 0.0001;          // the patches stand this far above the Earth's surface (of its radius)
  var MAX_SEG_DEG = 3;                // a patch's mesh no coarser than this
  var MAX_SEG = 14;
  var CENTRE_EVERY_MS = 120;          // the point under the camera, worked out this often at most
  var WORLD_DEG = 360;
  var LOOKUP_QUIET_MS = 350;          // a look-up waits for the camera to settle this long
  var HINT_QUIET_MS = 1200;           // the chip appears after the camera has rested this long
  var MERC_MAX_LAT = 85.0511;
  var CLASS_MIN_Z = [0, 0, 0, 0, 0, 13];   // the zoom each road class starts to be drawn (class index below)
  var ROAD_STYLE = [                  // [fill, width, casing width] in canvas px, by class index
    ['#ffb347', 6, 9], ['#ffd27f', 5, 8], ['#fff1c9', 4, 6.5], ['#ffffff', 3.2, 5], ['rgba(255,255,255,.82)', 2.2, 3.6], ['rgba(255,255,255,.6)', 1.4, 2.6]
  ];
  var CASING = 'rgba(10,14,24,.72)';
  var LABEL_FILL = '#ffffff', LABEL_HALO = 'rgba(8,12,20,.88)';
  // Place classes drawn, the zoom range each shows in and its type size in canvas px.
  var PLACE_STYLE = {
    country: { z0: 0, z1: 5, px: 24, w: 700 }, state: { z0: 4, z1: 8, px: 19, w: 500 }, city: { z0: 3, z1: 99, px: 23, w: 700 },
    town: { z0: 7, z1: 99, px: 19, w: 600 }, village: { z0: 9, z1: 99, px: 16, w: 500 }, suburb: { z0: 11, z1: 99, px: 15, w: 500 },
    hamlet: { z0: 11, z1: 99, px: 14, w: 500 }, neighbourhood: { z0: 12, z1: 99, px: 14, w: 500 }, island: { z0: 6, z1: 12, px: 17, w: 500 }
  };
  var PLACE_ORDER = ['country', 'state', 'city', 'town', 'island', 'village', 'suburb', 'hamlet', 'neighbourhood'];

  var MAX_ANISOTROPY = 4;
  // The canvas as it is, straight onto the globe: the page's colours are the screen's, so no colour-space step.
  var PATCH_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  var PATCH_FRAG = 'uniform sampler2D map; uniform float opacity; varying vec2 vUv; void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb, c.a * opacity); }';

  var CSS =
    '.ae-maps-chip{display:flex;justify-content:center;align-items:center;gap:6px;pointer-events:none;min-height:0}' +
    '.ae-maps-chip[hidden]{display:none}' +
    '.ae-maps-chip>*{pointer-events:auto}' +
    '.ae-maps-act{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 12px;border-radius:18px;border:1px solid var(--border);background:rgba(10,14,24,.78);color:var(--text2);font:inherit;font-size:12.5px;cursor:pointer}' +
    '.ae-maps-act:focus-visible{outline:2px solid var(--amber);outline-offset:2px}' +
    '@media (hover:hover){.ae-maps-act:hover{color:var(--amber)}}' +
    '.ae-maps-x{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:14px;background:rgba(10,14,24,.78);color:var(--text3);cursor:pointer;font-size:16px;line-height:1}' +
    '.ae-maps-credit{font-size:10px;color:var(--text3);text-shadow:0 0 3px rgba(0,0,0,.9)}';

  var S = null, THREE = null, group = null, TexClass = null;
  var tiles = {};                     // key -> { key, z, x, y, mesh, mat, tex, state: 'new'|'loading'|'ready'|'empty', used }
  var loads = 0, queue = [], drawQueue = [];
  var worker = null, workerSeq = 0, workerWait = {};
  var map = null;                     // the installed map in use: { name, main_path, bounds, world, maxz }
  var known = [];                     // installed maps seen so far (to answer a pan inside one without asking)
  var none = {};                      // cells (1 degree) known to hold no installed map -> the answer ({ offers, world })
  var asking = 0, askAt = null;
  var centre = null, centreAt = 0, lastCentreKey = '', visibleZ = -1, opacity = -1, restSince = 0;
  var chip = null, chipKey = '', dismissed = {};
  var cfgFetched = {};

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function cfg() { return AE_MAPS; }

  // ── where the camera is looking ──
  // The point of the Earth under the middle of the screen, in the Earth's own frame (latitude, longitude, degrees),
  // and the camera's distance to it in Earth radii. The ray along the view meets the sphere; looking past the limb it
  // is the point below the camera.
  function centreOf() {
    var cam = S.camera, inv = new THREE.Matrix4().copy(S.earth.matrixWorld).invert();
    var p = cam.position.clone().applyMatrix4(inv);
    var d = cam.getWorldDirection(new THREE.Vector3()).transformDirection(inv);
    var b = p.dot(d), c = p.lengthSq() - 1, disc = b * b - c, hit;
    if (disc >= 0 && -b - Math.sqrt(disc) > 0) hit = p.clone().addScaledVector(d, -b - Math.sqrt(disc));
    else hit = p.clone().normalize();
    var at = _aeSphereLatLon(hit.x, hit.y, hit.z, AE_EARTH_FLATTENING);
    return { lat: at.lat, lon: at.lon, h: Math.max(1e-6, p.distanceTo(hit)) };
  }

  // ── slippy tiles ──
  function tileX(lon, z) { return Math.floor((lon + 180) / WORLD_DEG * Math.pow(2, z)); }
  function mercY(lat) { var r = clamp(lat, -MERC_MAX_LAT, MERC_MAX_LAT) * Math.PI / 180; return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2; }
  function tileY(lat, z) { return Math.floor(mercY(lat) * Math.pow(2, z)); }
  function latOfY(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI; }
  // The zoom at which a tile is about cfg().tilePx CSS pixels across, under the camera.
  function zoomFor(c) {
    var f = _aeFocalPx(), cosLat = Math.max(MAX_COS_LAT, Math.cos(c.lat * Math.PI / 180));
    return Math.round(Math.log(2 * Math.PI * cosLat * f / (cfg().tilePx * c.h)) / Math.LN2);
  }
  function ring() { return Math.max(_ae.w || 0, _ae.h || 0) > WIDE_SCREEN_PX ? RING + 1 : RING; }
  function wanted(z, c) {
    var n = Math.pow(2, z), cx = tileX(c.lon, z), cy = tileY(c.lat, z), r = ring(), out = [];
    for (var dy = -r; dy <= r; dy++) {
      var y = cy + dy;
      if (y < 0 || y >= n) continue;
      for (var dx = -r; dx <= r; dx++) out.push({ z: z, x: ((cx + dx) % n + n) % n, y: y, d: Math.abs(dx) + Math.abs(dy) });
    }
    return out.sort(function (a, b) { return a.d - b.d; });
  }
  function keyOf(z, x, y) { return map.name + '/' + z + '/' + x + '/' + y; }

  // A tile's patch of sphere: columns even in longitude, rows even in the web map's y (so the picture is not bent).
  function geometry(z, x, y) {
    var n = Math.pow(2, z), span = WORLD_DEG / n, seg = clamp(Math.ceil(span / MAX_SEG_DEG), 2, MAX_SEG), lon0 = -180 + x * span;
    var pos = [], uv = [], idx = [], r = 1 + SURFACE_LIFT;
    for (var i = 0; i <= seg; i++) {
      var lat = latOfY((y + i / seg) / n);
      for (var j = 0; j <= seg; j++) {
        var v = _aeLatLonVec(lat, lon0 + span * j / seg, AE_EARTH_FLATTENING);
        pos.push(v[0] * r, v[1] * r, v[2] * r);
        uv.push(j / seg, 1 - i / seg);
      }
    }
    for (i = 0; i < seg; i++) {
      for (j = 0; j < seg; j++) {
        var a = i * (seg + 1) + j, b = a + seg + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    return g;
  }

  // ── the worker: bytes of a tile in, roads and names out ──
  function workerMain() {
    var ROAD_CLASS = { motorway: 0, trunk: 0, motorway_link: 1, trunk_link: 1, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3, minor: 4, street: 4, residential: 4, unclassified: 4, living_street: 4, road: 4, service: 5, track: 5, path: 5, pedestrian: 5 };
    function reader(u8) {
      var p = 0, end = u8.length;
      var r = {
        more: function () { return p < end; },
        varint: function () { var out = 0, shift = 0, b; do { b = u8[p++]; out += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b >= 0x80); return out; },
        skip: function (wire) { if (wire === 0) r.varint(); else if (wire === 2) p += r.varint(); else if (wire === 1) p += 8; else if (wire === 5) p += 4; else throw new Error('wire'); },
        bytes: function () { var n = r.varint(), s = p; p += n; return u8.subarray(s, s + n); },
        str: function () { return new TextDecoder().decode(r.bytes()); }
      };
      return r;
    }
    function packed(u8) { var r = reader(u8), out = []; while (r.more()) out.push(r.varint()); return out; }
    function zig(n) { return (n % 2 ? -(n + 1) : n) / 2; }
    function value(u8) {
      var r = reader(u8), out = null;
      while (r.more()) {
        var key = r.varint(), f = key >> 3, w = key & 7;
        if (f === 1) out = r.str(); else if (f === 4 || f === 5) out = r.varint(); else if (f === 6) out = zig(r.varint()); else r.skip(w);
      }
      return out;
    }
    function layerOf(u8) {
      var r = reader(u8), L = { name: '', keys: [], values: [], features: [], extent: 4096 };
      while (r.more()) {
        var key = r.varint(), f = key >> 3, w = key & 7;
        if (f === 1) L.name = r.str(); else if (f === 2) L.features.push(r.bytes()); else if (f === 3) L.keys.push(r.str());
        else if (f === 4) L.values.push(value(r.bytes())); else if (f === 5) L.extent = r.varint(); else r.skip(w);
      }
      return L;
    }
    function featureOf(u8, L) {
      var r = reader(u8), F = { tags: {}, type: 0, geom: [] };
      while (r.more()) {
        var key = r.varint(), f = key >> 3, w = key & 7;
        if (f === 2) { var t = packed(r.bytes()); for (var i = 0; i + 1 < t.length; i += 2) F.tags[L.keys[t[i]]] = L.values[t[i + 1]]; }
        else if (f === 3) F.type = r.varint(); else if (f === 4) F.geom = packed(r.bytes()); else r.skip(w);
      }
      return F;
    }
    // A feature's lines or point as arrays of [x, y, x, y ...] in 0..1 of the tile.
    function paths(geom, extent) {
      var out = [], cur = null, x = 0, y = 0, i = 0;
      while (i < geom.length) {
        var cmd = geom[i] & 7, count = geom[i] >> 3;
        i++;
        if (cmd === 7) continue;
        for (var k = 0; k < count; k++) {
          x += zig(geom[i++]); y += zig(geom[i++]);
          if (cmd === 1) { cur = []; out.push(cur); }
          if (cur) cur.push(x / extent, y / extent);
        }
      }
      return out;
    }
    function decode(u8, lang) {
      var roads = [], places = [], r = reader(u8);
      while (r.more()) {
        var key = r.varint(), f = key >> 3, w = key & 7;
        if (f !== 3) { r.skip(w); continue; }
        var L = layerOf(r.bytes());
        if (L.name !== 'transportation' && L.name !== 'place') continue;
        L.features.forEach(function (fb) {
          var F = featureOf(fb, L);
          if (L.name === 'transportation') {
            var c = ROAD_CLASS[F.tags['class']];
            if (c === undefined || F.type !== 2 || F.tags.brunnel === 'tunnel') return;
            paths(F.geom, L.extent).forEach(function (p) { if (p.length >= 4) roads.push([c, p]); });
          } else if (F.type === 1) {
            var name = F.tags['name:' + lang] || F.tags.name_en || F.tags['name:en'] || F.tags.name || F.tags['name:latin'] || F.tags.name_int, pt = paths(F.geom, L.extent)[0];
            if (name && pt) places.push([name, F.tags['class'] || '', typeof F.tags.rank === 'number' ? F.tags.rank : 99, pt[0], pt[1]]);
          }
        });
      }
      return { roads: roads, places: places };
    }
    function gunzip(buf) {
      var u8 = new Uint8Array(buf);
      if (u8[0] !== 0x1f || u8[1] !== 0x8b) return Promise.resolve(u8);
      if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('gzip'));
      var ds = new DecompressionStream('gzip');
      return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    self.onmessage = function (e) {
      var m = e.data;
      gunzip(m.buf).then(function (u8) { self.postMessage({ id: m.id, tile: decode(u8, m.lang) }); }, function () { self.postMessage({ id: m.id, error: true }); });
    };
  }
  function getWorker() {
    if (worker) return worker;
    try {
      var url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = function (e) {
        var w = workerWait[e.data.id];
        delete workerWait[e.data.id];
        if (w) w(e.data.error ? null : e.data.tile);
      };
      worker.onerror = function () { worker = null; };
    } catch (err) { worker = null; }
    return worker;
  }
  function decodeInWorker(buf) {
    var w = getWorker();
    if (!w) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var id = ++workerSeq;
      workerWait[id] = resolve;
      w.postMessage({ id: id, buf: buf, lang: (document.documentElement.lang || 'en').slice(0, 2) }, [buf]);
    });
  }

  // ── a tile on the globe ──
  function tileUrl(m, z, x, y) { return '/w/' + encodeURIComponent(m.name) + '/tiles/' + z + '/' + x + '/' + y + '.pbf'; }
  function want(t) {
    if (t.state !== 'new') return;
    t.state = 'queued';
    queue.push(t);
  }
  function pump() {
    while (loads < MAX_LOADS && queue.length) {
      var t = queue.shift(), m = t.map;
      if (m !== map || !t.live) { t.state = 'new'; continue; }
      t.state = 'loading';
      loads++;
      load(t, m);
    }
  }
  function load(t, m) {
    fetch(tileUrl(m, t.z, t.x, t.y)).then(function (r) { return r.ok ? r.arrayBuffer() : null; }).then(function (buf) {
      return buf ? decodeInWorker(buf) : null;
    }).then(function (data) {
      loads--;
      if (m !== map) { t.state = 'new'; return; }
      t.data = data;
      t.state = data && (data.roads.length || data.places.length) ? 'drawn' : 'empty';
      if (t.state === 'drawn') drawQueue.push(t);
      _ae.dirty = true;
      _aeKick();
    }).catch(function () { loads--; t.state = 'empty'; });
  }
  function labelFont(st) { return st.w + ' ' + st.px + 'px -apple-system,system-ui,"Segoe UI",Roboto,sans-serif'; }
  // The roads and names of one tile, on a canvas.
  function paint(t) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = TILE_CANVAS_PX;
    var ctx = cv.getContext('2d'), S2 = TILE_UNITS, d = t.data;
    ctx.scale(TILE_CANVAS_PX / TILE_UNITS, TILE_CANVAS_PX / TILE_UNITS);
    ctx.lineCap = ctx.lineJoin = 'round';
    var byClass = [[], [], [], [], [], []];
    d.roads.forEach(function (r) { if (t.z >= CLASS_MIN_Z[r[0]]) byClass[r[0]].push(r[1]); });
    var trace = function (list) {
      ctx.beginPath();
      list.forEach(function (p) {
        ctx.moveTo(p[0] * S2, p[1] * S2);
        for (var i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * S2, p[i + 1] * S2);
      });
    };
    for (var pass = 0; pass < 2; pass++) {
      for (var c = byClass.length - 1; c >= 0; c--) {
        if (!byClass[c].length) continue;
        trace(byClass[c]);
        ctx.strokeStyle = pass ? ROAD_STYLE[c][0] : CASING;
        ctx.lineWidth = ROAD_STYLE[c][pass ? 1 : 2];
        ctx.stroke();
      }
    }
    // Names: the biggest kinds first, the first to claim a spot keeps it.
    var boxes = [], margin = 4;
    var places = d.places.filter(function (p) { var st = PLACE_STYLE[p[1]]; return st && t.z >= st.z0 && t.z <= st.z1 && p[3] >= 0 && p[3] < 1 && p[4] >= 0 && p[4] < 1; });
    places.sort(function (a, b) { return PLACE_ORDER.indexOf(a[1]) - PLACE_ORDER.indexOf(b[1]) || a[2] - b[2]; });
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = LABEL_HALO;
    places.forEach(function (p) {
      var st = PLACE_STYLE[p[1]], dot = p[1] !== 'country' && p[1] !== 'state' && p[1] !== 'island';
      ctx.font = labelFont(st);
      var w = ctx.measureText(p[0]).width, h = st.px, x = p[3] * S2, y = p[4] * S2, tx = dot ? x + 8 : x - w / 2;
      tx = clamp(tx, margin, S2 - margin - w);
      y = clamp(y, h / 2 + margin, S2 - h / 2 - margin);   // a name whole inside its tile: a point sits in one tile only
      var box = [tx - margin, y - h / 2 - margin, tx + w + margin, y + h / 2 + margin];
      if (boxes.some(function (b) { return box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]; })) return;
      boxes.push(box);
      if (dot) {
        ctx.fillStyle = LABEL_HALO;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = LABEL_FILL;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.strokeText(p[0], tx, y);
      ctx.fillStyle = LABEL_FILL;
      ctx.fillText(p[0], tx, y);
    });
    if (!TexClass) TexClass = _aeTextureClass(THREE);
    var tex = new TexClass(cv);   // the build exports no CanvasTexture, Texture or MeshBasicMaterial
    tex.needsUpdate = true;
    tex.anisotropy = MAX_ANISOTROPY;
    t.tex = tex;
    t.mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, opacity: { value: Math.max(0, opacity) } }, vertexShader: PATCH_VERT, fragmentShader: PATCH_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    t.mesh = new THREE.Mesh(geometry(t.z, t.x, t.y), t.mat);
    t.mesh.renderOrder = 5;
    t.mesh.visible = false;
    group.add(t.mesh);
    t.state = 'ready';
    t.data = null;
  }
  function free(t) {
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mat.dispose(); t.tex.dispose(); }
    t.mesh = t.mat = t.tex = null;
    t.live = false;
    delete tiles[t.key];
  }
  function trim() {
    var ready = Object.keys(tiles).map(function (k) { return tiles[k]; }).filter(function (t) { return t.mesh; });
    if (ready.length <= MAX_TILES) return;
    ready.sort(function (a, b) { return a.used - b.used; });
    for (var i = 0; i < ready.length - MAX_TILES; i++) if (ready[i].used !== _ae.drawFrame) free(ready[i]);
  }
  function getTile(z, x, y) {
    var k = keyOf(z, x, y), t = tiles[k];
    if (!t) t = tiles[k] = { key: k, z: z, x: x, y: y, map: map, state: 'new', live: true, used: 0 };
    return t;
  }

  // ── which map ──
  function inBox(b, lat, lon) {
    if (!b || b.length !== 4) return false;
    return lat >= b[1] && lat <= b[3] && (b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2]);
  }
  function cellOf(lat, lon) { return Math.floor(lat) + ',' + Math.floor(lon); }
  // The installed map under (lat, lon) if known, null if known to be none, undefined while it has to be asked.
  function mapAt(lat, lon) {
    for (var i = 0; i < known.length; i++) if (inBox(known[i].bounds, lat, lon)) return known[i];
    return none[cellOf(lat, lon)] ? null : undefined;
  }
  function ask(lat, lon) {
    var k = cellOf(lat, lon);
    if (asking || !window.ZimiMapHere) return;
    asking = 1;
    askAt = k;
    ZimiMapHere.lookup(lat, lon).then(function (a) {
      asking = 0;
      if (!a) return;
      var best = (a.installed || []).filter(function (m) { return !m.world; })[0] || (a.installed || [])[0];
      if (best) { if (!known.some(function (m) { return m.name === best.name; })) known.push(best); }
      else none[k] = { offers: a.offers || [], world: a.world || [], answer: a };
      _ae.dirty = true;
      _aeKick();
    });
  }
  function maxZoomOf(m) {
    if (m.maxz) return m.maxz;
    m.maxz = Z_MAX_DEFAULT;
    if (!cfgFetched[m.name]) {
      cfgFetched[m.name] = 1;
      fetch('/w/' + encodeURIComponent(m.name) + '/content/config.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        var z = j && (j.maxzoom || j.maxZoom || j.max_zoom || (j.tiles && j.tiles.maxzoom));
        if (z > 0 && z < 24) m.maxz = Math.floor(z);
      }).catch(function () {});
    }
    return m.maxz;
  }

  // ── the chip ──
  function chipEl() {
    if (chip) return chip;
    var bottom = document.querySelector('.ae-bottom');
    if (!bottom) return null;
    if (!document.getElementById('ae-maps-style')) {
      var st = document.createElement('style');
      st.id = 'ae-maps-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    chip = document.createElement('div');
    chip.className = 'ae-maps-chip';
    chip.id = 'ae-maps-chip';
    chip.hidden = true;
    bottom.insertBefore(chip, bottom.firstChild);
    chip.onclick = function (e) {
      var x = e.target.closest && e.target.closest('.ae-maps-x');
      if (x) { dismissed[chipKey] = true; chip.hidden = true; return; }
      var act = e.target.closest && e.target.closest('.ae-maps-act');
      if (act && centre) ZimiMapHere.go(centre.lat, centre.lon, '');
    };
    return chip;
  }
  // One quiet chip: over an installed map the map's own icon (opens it there); where none holds the view and one
  // can be had, its name and size with the download mark (the offers); the map data's credit beside either.
  function setChip(kind, a, dim) {
    var el = chipEl();
    if (!el) return;
    var key = kind + '/' + (kind === 'offer' ? cellOf(centre.lat, centre.lon) : map && map.name);
    if (kind === 'none' || dismissed[key]) { el.hidden = true; chipKey = key; return; }
    if (key !== chipKey || el.hidden) {
      chipKey = key;
      var Z = ZimiMapHere, h;
      if (kind === 'offer') {
        var o = (a.offers || [])[0] || (a.world || [])[0];
        h = '<button type="button" class="ae-maps-act" aria-label="' + _almEsc(_aeT('map_here')) + '">' + Z.MAP_SVG + '<span>' + _almEsc(o.title) + (o.size_bytes && typeof fmtBytes === 'function' ? ' &middot; ' + _almEsc(fmtBytes(o.size_bytes)) : '') + '</span>' + Z.DOWN_SVG + '</button>' +
          '<button type="button" class="ae-maps-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">&times;</button>';
      } else {
        h = '<button type="button" class="ae-maps-act" aria-label="' + _almEsc(_aeT('map_here')) + '">' + Z.MAP_SVG + '</button><span class="ae-maps-credit">&copy; OpenStreetMap</span>';
      }
      el.innerHTML = h;
    }
    el.hidden = !!dim;
  }

  // ── the frame ──
  function setOpacity(o) {
    if (Math.abs(o - opacity) < 0.004) return;
    opacity = o;
    group.visible = o > 0;
    for (var k in tiles) if (tiles[k].mat) tiles[k].mat.uniforms.opacity.value = o;
  }
  function frame(Sx) {
    S = Sx;
    THREE = S.THREE;
    var alt = (_ae.dist - 1) * AE_EARTH_RADIUS_KM, c = cfg();
    if (_ae.target !== 'earth' || _ae.spin || alt > c.startKm) {
      if (group) setOpacity(0);
      if (chip) chip.hidden = true;
      restSince = 0;
      return;
    }
    if (!group) { group = new THREE.Group(); group.renderOrder = 5; S.earth.add(group); }
    _ae.drawFrame = (_ae.drawFrame || 0) + 1;
    var now = performance.now();
    if (!centre || now - centreAt >= CENTRE_EVERY_MS) {
      centre = centreOf();
      centreAt = now;
      var key = centre.lat.toFixed(2) + centre.lon.toFixed(2) + alt.toFixed(0);
      if (key !== lastCentreKey) { lastCentreKey = key; restSince = now; }
    }
    var held = mapAt(centre.lat, centre.lon);
    if (held === undefined) {
      if (now - restSince >= LOOKUP_QUIET_MS) ask(centre.lat, centre.lon);
      held = map;                       // the last map stays up while the camera moves on and the next is being asked
    }
    if (held !== map && held) { map = held; for (var k in tiles) free(tiles[k]); visibleZ = -1; queue = []; drawQueue = []; }
    if (held === null) map = null;
    var fade = map ? 1 - smooth((alt - c.fullKm) / (c.startKm - c.fullKm)) : 0;
    if (map) {
      var z = clamp(zoomFor(centre), Z_MIN, maxZoomOf(map)), list = wanted(z, centre), ready = 0;
      list.forEach(function (w) { var t = getTile(w.z, w.x, w.y); want(t); if (t.state === 'ready' || t.state === 'empty') ready++; });   // an empty tile (open sea) is as done as a drawn one
      // The level stays until the new one is mostly in: no bare globe between two zooms.
      if (visibleZ < 0 || z === visibleZ || ready * 2 >= list.length) visibleZ = z;
      var show = visibleZ === z ? list : wanted(visibleZ, centre);
      for (var key2 in tiles) if (tiles[key2].mesh) tiles[key2].mesh.visible = false;
      show.forEach(function (w) {
        var t = tiles[keyOf(w.z, w.x, w.y)];
        if (t && t.mesh) { t.mesh.visible = true; t.used = _ae.drawFrame; }
      });
      if (drawQueue.length) { var next = drawQueue.shift(); if (tiles[next.key] === next) { paint(next); trim(); } _ae.dirty = true; }
      pump();
    }
    setOpacity(fade);
    // The chip, after the camera has rested.
    var rested = now - restSince >= HINT_QUIET_MS && alt <= c.hintKm;
    if (!rested) { if (chip) chip.hidden = true; }
    else if (map) setChip('open', null, false);
    else if (held === null) {
      var n = none[cellOf(centre.lat, centre.lon)];
      var has = n && ZimiMapHere.outcome(n.answer) === 'offer';
      setChip(has ? 'offer' : 'none', n && n.answer, false);
    }
    if (drawQueue.length || queue.length || loads) { _ae.dirty = true; _aeKick(); }
  }
  function release() {
    for (var k in tiles) free(tiles[k]);
    queue = []; drawQueue = []; visibleZ = -1;
    if (group) { setOpacity(0); }
    if (chip) chip.hidden = true;
  }
  return { frame: frame, release: release, covers: function () { return !!map && opacity > 0; }, _tiles: function () { return tiles; }, _map: function () { return map; }, _state: function () { return { map: map && map.name, opacity: opacity, centre: centre, none: none }; } };
})();
