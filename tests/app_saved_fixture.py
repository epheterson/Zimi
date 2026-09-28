"""A library with one of everything the apps save: a document library whose
video and audiobook ZimiTube plays, a Stack Exchange site, a subreddit and a
map, each with one long thing so a place in it means something. The shapes
are the real ones (tube_sources_fixture, sotoki_fixture, arcticzim_fixture);
the media are real files a browser plays: a WebM made by ffmpeg when it is
installed, and WAV tracks written here.

build_library(zdir) writes the ZIMs and returns their short names."""

import io
import os
import shutil
import subprocess
import tempfile
import wave

from arcticzim_fixture import LISTING as R_LISTING
from arcticzim_fixture import POST as R_POST
from arcticzim_fixture import SUBS as R_SUBS
from books_sources_fixture import build_zim
from sotoki_fixture import LISTING as Q_LISTING
from sotoki_fixture import QUESTION as Q_QUESTION
from sotoki_fixture import TAGS as Q_TAGS

# The files, and the short names Zimi knows them by.
TUBE_FILE, TUBE = "zaya-test_en_2026-01.zim", "zaya-test"
EXCHANGE_FILE, EXCHANGE = "cooking.stackexchange.com_en_all_2026-07.zim", "cooking.stackexchange"
REDDOT_FILE, REDDOT = "reddit_kiwix.zim", "reddit_kiwix"
MAP_FILE, MAP = "maps_en_testland_2026-01.zim", "maps_en_testland"

VIDEO = "files/talk.webm"
TRACKS = ["files/story_01.wav", "files/story_02.wav"]
QUESTION = "questions/567/how-can-i-chop-onions-without-crying"
POST = "r/kiwix/abc12/"
MEDIA_SECONDS = 40

# A thread long enough that where you are in it is worth keeping.
_LONG = "".join(
    "<p>Paragraph %d. Onions release a gas when cut; a sharp knife breaks fewer cells, a cold onion releases less, and a fan carries the rest away.</p>"
    % i
    for i in range(80)
)
LONG_QUESTION = Q_QUESTION.replace(
    "<p>Onions make me <b>cry</b>.", _LONG + "<p>Onions make me <b>cry</b>."
)
LONG_POST = R_POST.replace(
    "<p>Maps, ZimiTube and more.", _LONG + "<p>Maps, ZimiTube and more."
)

TUBE_DATABASE = (
    "var DATABASE = [\n"
    "{'_id': '0', 'ti': 'Grammar concept - Common noun Vs Proper noun', 'dsc': 'Learn the difference.', 'aut': 'Zaya', 'fp': ['talk.webm']},\n"
    "{'_id': '1', 'ti': 'A story in two parts', 'dsc': 'Read aloud.', 'aut': 'Narrator', 'fp': ['story_01.wav', 'story_02.wav']},\n"
    "];\n"
)
TUBE_META = {
    "Name": "zaya-test_en",
    "Title": "English Duniya",
    "Language": "eng",
    "Scraper": "nautiluszim 1.0.5",
    "Creator": "Zaya",
    "Publisher": "Kiwix",
}

# A map with the handle StreetZim exposes (__szMap): a view you can move,
# and the labels on screen for the place nearest the middle.
MAP_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Testland</title>
<style>html,body{margin:0;height:100%;background:#cfe3d4}#m{position:absolute;inset:0}</style></head>
<body><div id="m"></div><input id="search-input" style="position:absolute;top:8px;left:8px">
<script>
(function () {
  var st = { lat: 38.72, lng: -9.14, zoom: 12 }, on = {};
  var LABELS = [
    { name: 'Lisbon', lat: 38.7223, lng: -9.1393, layer: 'place' },
    { name: 'Belem', lat: 38.6970, lng: -9.2064, layer: 'place' },
    { name: 'Museum of Tiles', lat: 38.7250, lng: -9.1130, layer: 'poi' }
  ];
  function fire(ev) { (on[ev] || []).slice().forEach(function (f) { f({}); }); }
  function k() { return 256 * Math.pow(2, st.zoom) / 360; }
  function px(lng, lat) { return { x: innerWidth / 2 + (lng - st.lng) * k(), y: innerHeight / 2 - (lat - st.lat) * k() }; }
  window.__szMap = {
    getCenter: function () { return { lat: st.lat, lng: st.lng }; },
    getZoom: function () { return st.zoom; },
    jumpTo: function (o) { if (o.center) { st.lng = o.center[0]; st.lat = o.center[1]; } if (o.zoom != null) st.zoom = o.zoom; fire('moveend'); },
    on: function (ev, f) { (on[ev] = on[ev] || []).push(f); },
    once: function (ev, f) { var g = function (e) { on[ev] = on[ev].filter(function (x) { return x !== g; }); f(e); }; this.on(ev, g); },
    off: function (ev, f) { on[ev] = (on[ev] || []).filter(function (x) { return x !== f; }); },
    project: function (ll) { return Array.isArray(ll) ? px(ll[0], ll[1]) : px(ll.lng, ll.lat); },
    getBounds: function () {
      var w = st.lng - innerWidth / 2 / k(), e = st.lng + innerWidth / 2 / k(), s = st.lat - innerHeight / 2 / k(), n = st.lat + innerHeight / 2 / k();
      return { getWest: function () { return w; }, getEast: function () { return e; }, getSouth: function () { return s; }, getNorth: function () { return n; } };
    },
    queryRenderedFeatures: function () {
      return LABELS.filter(function (l) { var p = px(l.lng, l.lat); return p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight; })
        .map(function (l) { return { type: 'Feature', properties: { name: l.name }, geometry: { type: 'Point', coordinates: [l.lng, l.lat] }, layer: { id: l.layer + '_label', type: 'symbol' }, sourceLayer: l.layer }; });
    }
  };
})();
</script></body></html>"""


def wav(seconds=MEDIA_SECONDS, rate=8000):
    """Silence a browser plays anywhere: 8 kHz, 8-bit, mono."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(rate)
        w.writeframes(b"\x80" * (rate * seconds))
    return buf.getvalue()


def webm(seconds=MEDIA_SECONDS):
    """A real, tiny WebM (VP8 and Vorbis) from ffmpeg; None without it."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return None
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "v.webm")
        cmd = [
            ff,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=64x36:r=5:d=%d" % seconds,
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-t",
            str(seconds),
            "-c:v",
            "libvpx",
            "-b:v",
            "20k",
            "-c:a",
            "libvorbis",
            "-shortest",
            out,
        ]
        try:
            subprocess.run(cmd, check=True, timeout=60)
            with open(out, "rb") as f:
                return f.read()
        except Exception:
            return None


def build_library(zdir, video_bytes=None):
    """Write the four ZIMs into ``zdir``; the video falls back to a stub
    (listed, not playable) when there is no ffmpeg."""
    zdir = str(zdir)
    os.makedirs(zdir, exist_ok=True)
    home = ("text/html", "<html><body><h1>Home</h1></body></html>", "Home")
    tube = {
        "home.html": home,
        "database.js": ("application/javascript", TUBE_DATABASE, ""),
        VIDEO: ("video/webm", video_bytes or b"\x1a\x45\xdf\xa3webm", ""),
    }
    for t in TRACKS:
        tube[t] = ("audio/wav", wav(), "")
    build_zim(
        os.path.join(zdir, TUBE_FILE),
        TUBE_META,
        tube,
        main_path="home.html",
    )

    html = lambda s: ("text/html", s, "")  # noqa: E731
    build_zim(
        os.path.join(zdir, EXCHANGE_FILE),
        {
            "Scraper": "sotoki v3.1.1",
            "Name": "cooking.stackexchange.com_en_all",
            "Title": "Cooking",
            "Language": "eng",
        },
        {
            "questions": html(Q_LISTING),
            "tags": html(Q_TAGS),
            QUESTION: html(LONG_QUESTION),
            "questions/tagged/onions": html(Q_LISTING),
        },
        main_path="questions",
    )
    build_zim(
        os.path.join(zdir, REDDOT_FILE),
        {
            "Scraper": "arcticzim",
            "Name": REDDOT,
            "Tags": "_category:reddit",
            "Title": "ArcticZim",
            "Language": "eng",
        },
        {
            "subreddits/": html(R_SUBS),
            "r/kiwix/top_page_1/": html(R_LISTING),
            "r/kiwix/new_page_1/": html(R_LISTING),
            POST: html(LONG_POST),
        },
        main_path="subreddits/",
    )
    build_zim(
        os.path.join(zdir, MAP_FILE),
        {
            "Scraper": "maps2zim v0.2.1",
            "Name": MAP,
            "Title": "Testland",
            "Language": "eng",
        },
        {"index.html": html(MAP_HTML)},
        main_path="index.html",
    )
    return {"tube": TUBE, "exchange": EXCHANGE, "reddot": REDDOT, "maps": MAP}
