"""The standard Almanac ZIM stays small: the owner's ceiling is 18 MB, "small and quick"; this fails above 20.

The data files (.bin) are stored as a compressible type so libzim compresses them (it stores octet-stream as it is).
Run: pytest tests/test_almanac_zim_size.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import ownzims  # noqa: E402

MAX_ALMANAC_ZIM_BYTES = 20 * 1000 * 1000


def test_the_built_almanac_zim_is_under_its_budget():
    path = ownzims.zim_path(ownzims.OWN[1])
    if not path:
        pytest.skip("the own ZIMs are not built")
    assert os.path.basename(path).startswith("zimi_almanac")
    size = os.path.getsize(path)
    assert size <= MAX_ALMANAC_ZIM_BYTES, "%.1f MB, budget %.0f MB" % (size / 1e6, MAX_ALMANAC_ZIM_BYTES / 1e6)


def test_a_data_file_is_stored_compressed_in_a_folder_build(tmp_path):
    from libzim.reader import Archive

    from zimi import creator

    folder = tmp_path / "pack"
    folder.mkdir()
    (folder / "index.html").write_text("<html><title>t</title><body>x</body></html>", encoding="utf-8")
    (folder / "zimi.txt").write_text("Title: Pack\nDescription: d\nLanguage: eng\nCreator: Zimi\nPublisher: Zimi\n", encoding="utf-8")
    (folder / "data.bin").write_bytes(bytes(range(256)) * 2000)   # 512 KB that compresses to almost nothing
    out = tmp_path / "pack.zim"
    creator.create_folder_zim(str(folder), out_path=str(out), register=False, mime_overrides=ownzims.COMPRESSED_BINARY_TYPES)
    assert os.path.getsize(out) < 100_000
    assert bytes(Archive(str(out)).get_entry_by_path("data.bin").get_item().content) == bytes(range(256)) * 2000
