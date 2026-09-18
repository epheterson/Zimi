"""The portable Windows zip unblocks its own libraries before .NET loads one.

Files extracted from a downloaded zip carry Windows's mark of the web, and the
.NET Framework refuses to load a marked assembly. That is what a 1.9.5 user hit
with "Failed to resolve Python.Runtime.Loader.Initialize" on the first import.
The installer never had it; the zip now removes the mark itself.

Run: pytest tests/test_desktop_unblock.py -v
"""

import os
import platform
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "desktop"))

import zimi_desktop  # noqa: E402

WINDOWS = platform.system() == "Windows"


def test_other_platforms_do_nothing(tmp_path):
    if WINDOWS:
        pytest.skip("Windows removes the mark; this checks the others do not walk")
    (tmp_path / "a.dll").write_bytes(b"x")
    assert zimi_desktop._unblock_bundled_libraries(str(tmp_path)) == 0


def test_a_missing_root_is_not_an_error():
    assert zimi_desktop._unblock_bundled_libraries(None) == 0
    assert zimi_desktop._unblock_bundled_libraries("/nowhere/at/all") == 0


@pytest.mark.skipif(not WINDOWS, reason="alternate data streams are NTFS")
def test_marked_libraries_are_unblocked_and_others_left_alone(tmp_path):
    lib = tmp_path / "pythonnet" / "runtime"
    lib.mkdir(parents=True)
    dll = lib / "Python.Runtime.dll"
    dll.write_bytes(b"MZ")
    # What a browser download plus Explorer extraction leaves behind.
    with open(str(dll) + ":Zone.Identifier", "w", encoding="utf-8") as f:
        f.write("[ZoneTransfer]\nZoneId=3\n")
    txt = tmp_path / "notes.txt"
    txt.write_text("hello", encoding="utf-8")
    with open(str(txt) + ":Zone.Identifier", "w", encoding="utf-8") as f:
        f.write("[ZoneTransfer]\nZoneId=3\n")

    assert zimi_desktop._unblock_bundled_libraries(str(tmp_path)) == 1
    assert not os.path.exists(str(dll) + ":Zone.Identifier")
    assert os.path.exists(str(txt) + ":Zone.Identifier"), "only libraries are touched"
    assert dll.read_bytes() == b"MZ"
    # Second pass finds nothing to do.
    assert zimi_desktop._unblock_bundled_libraries(str(tmp_path)) == 0
