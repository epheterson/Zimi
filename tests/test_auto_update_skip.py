"""A ZIM can be left out of the auto-updater (#34): the unattended pass passes it
over, the choice survives a restart and the settings write, rides the listing
to the card menu, and follows a rename."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as lib  # noqa: E402
import zimi.server as server  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_auto_update_skips", frozenset())
    monkeypatch.setattr(server, "_auto_update_env_locked", False)
    return tmp_path


def _file(data_dir):
    with open(data_dir / "auto_update.json", encoding="utf-8") as f:
        return json.load(f)


def test_skip_persists_and_survives_the_frequency_write(data_dir):
    lib.set_auto_update_skip("wikipedia_en", True)
    lib._save_auto_update_config(True, "daily")
    assert _file(data_dir) == {"skip": ["wikipedia_en"], "enabled": True, "frequency": "daily"}
    assert lib._load_auto_update_skips() == {"wikipedia_en"}
    lib.set_auto_update_skip("wikipedia_en", False)
    assert lib._load_auto_update_skips() == frozenset()
    assert server._auto_update_skips == frozenset()


def test_listing_carries_the_flag_only_for_skipped_zims(data_dir):
    lib.set_auto_update_skip("b", True)
    listing = [{"name": "a"}, {"name": "b"}, {"name": "c", "auto_update": False}]
    server.mark_auto_update_skips(listing)
    assert [z.get("auto_update") for z in listing] == [None, False, None]


def test_rename_carries_the_skip(data_dir):
    lib.set_auto_update_skip("old_en", True)
    lib._carry_zim_state("old_en", "new_en")
    assert lib._load_auto_update_skips() == {"new_en"}


def test_the_unattended_pass_skips_an_opted_out_zim(data_dir, monkeypatch):
    lib.set_auto_update_skip("skipped_en", True)
    started = []

    def updates():
        monkeypatch.setattr(server, "_auto_update_enabled", False)  # one pass only
        return [
            {"name": n, "download_url": f"https://download.kiwix.org/zim/x/{n}_2026-02.zim.meta4"}
            for n in ("skipped_en", "kept_en")
        ]

    monkeypatch.setattr(server, "_auto_update_enabled", True)
    monkeypatch.setattr(lib, "_check_updates", updates)
    monkeypatch.setattr(lib, "_start_download", lambda url: (started.append(url) or "id", None))
    monkeypatch.setattr(server, "ZIM_DIR", str(data_dir))
    lib._auto_update_loop()
    assert [u.rsplit("/", 1)[-1] for u in started] == ["kept_en_2026-02.zim.meta4"]
