"""The Almanac's own answers inside its ZIM (builtin/almanac/local.js): the tide stations and the satellite elements,
from the files packed in the ZIM, must say what Zimi's server says from the same snapshots (placedata.py,
satellites.py). The JavaScript is a port, so it is held to the Python on fixed places and queries.

Run: pytest tests/test_almanac_local.py -v
"""

import gzip
import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from zimi import placedata  # noqa: E402
from zimi import almanacstage as stage  # noqa: E402

NODE = shutil.which("node")
LOCAL_JS = os.path.join(stage.HOST, "local.js")
PLACES = [(37.8, -122.4), (51.5, -0.12), (-33.9, 151.2), (64.8, -147.7), (0.0, 179.9)]
QUERIES = [("san fra", None), ("san fra", (37.0, -122.0)), ("new", (40.7, -74.0)), ("honolulu", None), ("zzzzqq", None), ("", None)]

NODE_SCRIPT = r"""
const fs = require('fs'), vm = require('vm');
const [local, tides, places, queries] = process.argv.slice(2);
const sb = { console, Response: class {}, URL, globalThis: null }; sb.window = sb; sb.globalThis = sb;
vm.createContext(sb); vm.runInContext(fs.readFileSync(local, 'utf8'), sb);
const L = sb.ZimiAlmanacLocal, t = L._prepare(JSON.parse(fs.readFileSync(tides, 'utf8')));
const out = { near: JSON.parse(places).map(p => L.near(t, p[0], p[1])),
  search: JSON.parse(queries).map(q => L.search(t, q[0], q[1] ? q[1][0] : null, q[1] ? q[1][1] : null)) };
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def tides_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("tides") / "tides.json"
    with gzip.open(placedata.TIDES_PATH, "rb") as f:
        path.write_bytes(f.read())
    return str(path)


@pytest.mark.skipif(not NODE, reason="node is not installed")
def test_the_tide_stations_are_the_servers(tides_file, tmp_path):
    script = tmp_path / "run.js"
    script.write_text(NODE_SCRIPT, encoding="utf-8")
    got = json.loads(
        subprocess.run(
            [NODE, str(script), LOCAL_JS, tides_file, json.dumps(PLACES), json.dumps(QUERIES)],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    for (lat, lon), js in zip(PLACES, got["near"]):
        assert js == json.loads(json.dumps(placedata.near(lat, lon))), (lat, lon)
    for (q, at), js in zip(QUERIES, got["search"]):
        lat, lon = at if at else (None, None)
        assert js == json.loads(json.dumps(placedata.search(q, lat, lon))), (q, at)


def test_the_stage_packs_both_snapshots(tmp_path):
    dest = tmp_path / "stage"
    dest.mkdir()
    stage.stage(str(dest))
    sats = json.loads((dest / "data" / "satellites-snapshot.json").read_text(encoding="utf-8"))
    assert sats["gps"] and sats["iss"] and sats["fetched_at"]
    tides = json.loads((dest / "data" / "tides-snapshot.json").read_text(encoding="utf-8"))
    assert len(tides["stations"]) > 3000
    assert (dest / "local.js").exists()
