"""Stray .torrent companions in ZIM_DIR are migrated into the cache dir (#38).

Torrent metadata must never live beside the ZIMs — it belongs under
ZIMI_DATA_DIR/bt/torrents. A one-time startup migration heals legacy installs
that carry aria2-era <name>.zim.torrent litter in the ZIM directory.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as server  # noqa: E402


def _dirs(tmp_path, monkeypatch):
    zdir = tmp_path / "zims"
    zdir.mkdir()
    ddir = tmp_path / "data"
    ddir.mkdir()
    monkeypatch.setattr(server, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(ddir))
    return zdir, ddir


def test_stray_torrent_moved_into_bt_torrents(tmp_path, monkeypatch):
    zdir, ddir = _dirs(tmp_path, monkeypatch)
    stray = zdir / "wikipedia_en_all_2026-06.zim.torrent"
    stray.write_bytes(b"d4:infod...e")  # bencoded-ish blob, contents irrelevant
    (zdir / "wikipedia_en_all_2026-06.zim").write_bytes(
        b"\0" * 16
    )  # the real ZIM stays

    server._migrate_stray_torrent_files()

    assert not stray.exists(), "the stray .torrent must leave ZIM_DIR"
    dst = ddir / "bt" / "torrents" / "wikipedia_en_all_2026-06.zim.torrent"
    assert dst.exists(), "it must land under bt/torrents"
    assert (zdir / "wikipedia_en_all_2026-06.zim").exists(), "the ZIM must be untouched"


def test_migration_is_noop_without_strays(tmp_path, monkeypatch):
    zdir, ddir = _dirs(tmp_path, monkeypatch)
    (zdir / "survival_en_2026-06.zim").write_bytes(b"\0" * 16)
    server._migrate_stray_torrent_files()
    # No bt/torrents dir gets created when there's nothing to move.
    assert not (ddir / "bt" / "torrents").exists()


def test_migration_repoints_manifest_record(tmp_path, monkeypatch):
    zdir, ddir = _dirs(tmp_path, monkeypatch)
    fn = "docs_en_2026-06.zim.torrent"
    (zdir / fn).write_bytes(b"d...e")
    tdir = ddir / "bt"
    tdir.mkdir()
    manifest = {
        "docs_en_2026-06.zim": {
            "info_hash": "abc",
            "torrent_file": str(zdir / fn),  # legacy record pointing into ZIM_DIR
        }
    }
    (tdir / "torrents.json").write_text(json.dumps(manifest))

    server._migrate_stray_torrent_files()

    updated = json.loads((tdir / "torrents.json").read_text())
    new_path = updated["docs_en_2026-06.zim"]["torrent_file"]
    assert new_path == str(ddir / "bt" / "torrents" / fn)
    assert os.path.exists(new_path)


def test_migration_drops_stray_when_archive_already_has_it(tmp_path, monkeypatch):
    zdir, ddir = _dirs(tmp_path, monkeypatch)
    fn = "atlas_en_2026-06.zim.torrent"
    (zdir / fn).write_bytes(b"stray")
    archived = ddir / "bt" / "torrents"
    archived.mkdir(parents=True)
    (archived / fn).write_bytes(b"good")  # already archived, keep this one

    server._migrate_stray_torrent_files()

    assert not (zdir / fn).exists(), "the duplicate stray is removed from ZIM_DIR"
    assert (archived / fn).read_bytes() == b"good", "the archived copy is preserved"


def test_migration_is_idempotent(tmp_path, monkeypatch):
    zdir, ddir = _dirs(tmp_path, monkeypatch)
    fn = "wiki_en_2026-06.zim.torrent"
    (zdir / fn).write_bytes(b"x")
    server._migrate_stray_torrent_files()
    server._migrate_stray_torrent_files()  # second run finds nothing, must not raise
    assert (ddir / "bt" / "torrents" / fn).exists()
