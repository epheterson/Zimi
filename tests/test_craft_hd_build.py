"""The HD craft builder: a full material override and the UVs a crease split must carry along."""

import os
import sys

import pytest

np = pytest.importorskip("numpy")  # the desktop build's suite runs without numpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(ROOT, "scripts"))
import build_craft_hd as hd  # noqa: E402
import craftmesh as cm  # noqa: E402


def _parts(monkeypatch):
    # two perpendicular triangles sharing an edge: creasing splits the shared corners (4 vertices become 6)
    pos = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
    uv = np.array([[0, 0], [1, 0], [0, 1], [1, 1]], dtype=np.float64)
    faces = np.array([[0, 1, 2], [0, 3, 1]])
    part = {"mat": 0, "pos": pos, "nrm": None, "uv": uv, "faces": faces}
    j = {"materials": [{"name": "Psyche body", "pbrMetallicRoughness": {}}]}
    monkeypatch.setattr(cm, "read_parts", lambda glb: (j, b"", [part]))


def test_a_full_material_override_is_taken_whole_and_a_crease_split_keeps_its_uvs(monkeypatch):
    _parts(monkeypatch)
    override = {"Psyche": ((0.04, 0.07, 0.2), 0.25, 0.2, cm.KIND_CELLS)}
    data, _files, tris = hd.build("t", b"", override)
    assert tris == 2 and data[:4] == b"ZCR2"


def test_an_rgb_only_override_still_works(monkeypatch):
    _parts(monkeypatch)
    data, _files, tris = hd.build("t", b"", {"Psyche": (0.5, 0.5, 0.5)})
    assert tris == 2
