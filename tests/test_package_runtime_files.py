"""What ships of zimi/builtin: the built ZIMs and what the server reads of the
games' source at runtime (gamelinks.py: games.json and the tile pictures),
and nothing of the ~34 MB of source the ZIMs were built from. The wheel
(pyproject package-data), the Docker image (.dockerignore) and the desktop
builds (desktop/zimi_desktop.spec) must agree.

Run: pytest tests/test_package_runtime_files.py -v
"""

import fnmatch
import os
import pathlib
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILTIN = ROOT / "zimi" / "builtin"

NEEDED = ["games/games.json", "games/thumbs/chess.svg", "games/puzzles/icons/cube.png"]
NOT_NEEDED = ["games/shell.js", "games/index.html", "games/chess.html", "games/puzzles/cube.wasm", "almanac/zimi.txt"]


def _package_data():
    import tomllib

    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["setuptools"]["package-data"]["zimi"]


def _shipped_by_pyproject(rel):
    return any(
        fnmatch.fnmatch("builtin/" + rel, pat.replace("**", "*")) for pat in _package_data() if pat.startswith("builtin/")
    )


def _shipped_by_dockerignore(rel):
    """Last matching line wins; a pattern naming a folder covers what is in it."""
    path, shipped = "zimi/builtin/" + rel, True
    for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        pat = line.lstrip("!")
        parts = path.split("/")
        if any(fnmatch.fnmatchcase("/".join(parts[: i + 1]), pat) for i in range(len(parts))):
            shipped = negate
    return shipped


@pytest.mark.parametrize("rel", NEEDED)
def test_what_the_server_reads_ships_everywhere(rel):
    assert (BUILTIN / rel).exists(), rel
    assert _shipped_by_pyproject(rel), "wheel: " + rel
    assert _shipped_by_dockerignore(rel), "image: " + rel


@pytest.mark.parametrize("rel", NOT_NEEDED)
def test_the_source_the_zims_were_built_from_does_not_ship(rel):
    assert not _shipped_by_pyproject(rel), "wheel: " + rel
    assert not _shipped_by_dockerignore(rel), "image: " + rel


def test_the_built_zims_ship_everywhere():
    for z in BUILTIN.glob("*.zim"):
        assert _shipped_by_pyproject(z.name) and _shipped_by_dockerignore(z.name), z.name


def test_the_desktop_build_carries_the_same_files():
    spec = (ROOT / "desktop" / "zimi_desktop.spec").read_text(encoding="utf-8")
    assert "(os.path.join(REPO_ROOT, 'zimi/builtin'), 'zimi/builtin')" not in spec, "the whole folder"
    for piece in ("*.zim", "games/games.json", "games/thumbs", "games/puzzles/icons"):
        assert piece in spec, piece


def test_the_server_reads_only_what_ships():
    """gamelinks.py's reads of the source folder are games.json and the tile pictures."""
    text = (ROOT / "zimi" / "gamelinks.py").read_text(encoding="utf-8")
    assert set(re.findall(r'SOURCE_ROOT, "games"(?:, "([^"]+)")?', text)) == {"games.json", ""}
    assert 'thumbs/%s.svg' in text and 'puzzles/icons/%s.png' in text
