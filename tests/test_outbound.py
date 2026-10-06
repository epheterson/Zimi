"""What Zimi fetches from the internet, and the settings that decide it.

Eric, 2026-09-28: "i'm not positive how i feel about unexpected network calls
from zimi, maybe that update should be optional or at least controllable".

Pinned here:
  - "Check for Zimi updates" (Ask first / Automatically / Never) decides
    whether opening Server settings asks GitHub, and whether the desktop
    app's updater runs at all; ZIMI_UPDATE_CHECK wins, ZIMI_OFFLINE forces
    Never, the satellite setting behaves the same through the same code.
  - Nothing reaches out at boot for an idle server: no BitTorrent engine
    without work for it, no port check without an admin asking.
  - ZIMI_OFFLINE refuses a download from the internet (a LAN peer is not one).
  - The list Server settings shows names every destination, every module
    that opens a connection is accounted for by a row, and every row has its
    words in the locale file.

No test here reaches the network: every fetch is a stand-in that records.

Run: pytest tests/test_outbound.py -v
"""

import json
import os
import re
import sys
from unittest.mock import MagicMock

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import zimi.desktop as desktop  # noqa: E402
import zimi.library as library  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.p2p as p2p  # noqa: E402
import zimi.p2p_nat as p2p_nat  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import outbound  # noqa: E402

PKG = os.path.join(REPO, "zimi")


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(tmp_path))
    for name in (
        "ZIMI_OFFLINE",
        "ZIMI_UPDATE_CHECK",
        "ZIMI_SATELLITE_UPDATES",
        "ZIMI_VOICE_DOWNLOADS",
        "ZIMI_BT",
        "ZIMI_TORRENT",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(p2p, "_prefs_path", None)
    return tmp_path


@pytest.fixture
def github(monkeypatch):
    """GitHub, as a list of the URLs asked for."""
    asked = []

    def fake(url):
        asked.append(url)
        return {
            "tag_name": "v99.0.0",
            "html_url": "https://example.invalid/r",
            "prerelease": False,
        }

    monkeypatch.setattr(manage, "_github_json", fake)
    return asked


# ── "Check for Zimi updates" ────────────────────────────────────────────────


def test_automatically_is_the_default_and_checks_when_the_pane_opens(data_dir, github):
    assert manage.UPDATE_CHECK.mode() == ("auto", None)
    manage.check_app_update()
    assert len(github) == 1


def test_ask_first_checks_only_on_check_now(data_dir, github):
    assert manage.UPDATE_CHECK.set("ask") == ("ask", None)
    assert manage.check_app_update() == {}
    assert github == [], "opening the pane asked GitHub under Ask first"
    manage.check_app_update(force=True)
    assert len(github) == 1
    # The answer Check now got is what the pane shows from then on.
    assert manage.check_app_update()["latest"] == "99.0.0"
    assert len(github) == 1


def test_never_checks_for_nothing_not_even_check_now(data_dir, github):
    manage.UPDATE_CHECK.set("never")
    manage.check_app_update()
    manage.check_app_update(force=True)
    assert github == []


def test_the_env_var_wins_and_locks_the_choice(data_dir, github, monkeypatch):
    manage.UPDATE_CHECK.set("auto")
    monkeypatch.setenv("ZIMI_UPDATE_CHECK", "Never ")
    assert manage.UPDATE_CHECK.mode() == ("never", "env")
    assert manage.UPDATE_CHECK.set("ask") == (None, "env")
    manage.check_app_update()
    assert github == []
    # A value that names no mode is ignored, not obeyed as "off".
    monkeypatch.setenv("ZIMI_UPDATE_CHECK", "sometimes")
    assert manage.UPDATE_CHECK.mode() == ("auto", None)


def test_offline_forces_never_over_everything(data_dir, github, monkeypatch):
    monkeypatch.setenv("ZIMI_UPDATE_CHECK", "auto")
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    assert manage.UPDATE_CHECK.mode() == ("never", "offline")
    assert manage.UPDATE_CHECK.set("auto") == (None, "offline")
    manage.check_app_update(force=True)
    assert github == []


def test_the_choice_keeps_its_neighbours_in_the_prefs_file(data_dir):
    manage.set_update_channel("beta")
    from zimi import satellites

    satellites.set_update_mode("never")
    manage.UPDATE_CHECK.set("ask")
    assert manage._read_app_update_prefs() == {
        "channel": "beta",
        "satellite_updates": "never",
        "update_check": "ask",
    }
    assert manage.UPDATE_CHECK.set("hourly") == (None, "invalid")


def _hit(path, method="GET", data=None):
    h = MagicMock()
    got = {}
    h._json = lambda status, payload: got.update(status=status, payload=payload)
    parsed = MagicMock()
    parsed.path = path
    if method == "GET":
        manage.handle_manage_get(h, parsed, {})
    else:
        manage.handle_manage_post(h, parsed, data or {})
    return got["status"], got["payload"]


@pytest.fixture
def endpoints(data_dir, github, monkeypatch):
    monkeypatch.setattr(server, "ZIMI_MANAGE", True)
    monkeypatch.setattr(manage, "_manage_auth_challenge", lambda h: None)
    return github


def test_the_payload_carries_the_setting_and_the_post_changes_it(
    endpoints, monkeypatch
):
    status, body = _hit("/manage/app-update")
    assert status == 200
    assert (body["check_mode"], body["check_locked"]) == ("auto", None)
    assert body["check_modes"] == ["ask", "auto", "never"]
    assert body["check_env"] == "ZIMI_UPDATE_CHECK"
    status, body = _hit("/manage/app-update-mode", "POST", {"mode": "never"})
    assert status == 200 and body["check_mode"] == "never"
    assert _hit("/manage/app-update-mode", "POST", {"mode": "weekly"})[0] == 400
    monkeypatch.setenv("ZIMI_UPDATE_CHECK", "auto")
    assert _hit("/manage/app-update-mode", "POST", {"mode": "ask"})[0] == 403


def test_the_satellite_setting_is_the_same_machinery(data_dir):
    from zimi import satellites

    assert isinstance(satellites.POLICY, outbound.FetchPolicy)
    assert satellites.update_mode() == ("ask", None)  # its own default
    assert satellites.setting()["choices"] == list(outbound.MODES)


# ── the desktop app's updater ───────────────────────────────────────────────


class _Config(dict):
    def get(self, key, default=None):
        return super().get(key, True if key == "auto_update_check" else default)


@pytest.mark.parametrize(
    "mode,runs", [("auto", True), ("ask", False), ("never", False)]
)
def test_the_desktop_updater_runs_only_under_automatically(data_dir, mode, runs):
    """Sparkle and WinSparkle check on their own, so Ask first means they do
    not start; Check now in Server settings is the ask."""
    manage.UPDATE_CHECK.set(mode)
    assert desktop._auto_update_allowed(_Config(), data_dir=str(data_dir)) is runs


def test_the_desktop_reads_the_setting_from_its_own_data_dir(
    data_dir, tmp_path_factory
):
    """The updater starts before the server has a data dir: it reads the
    one the server will use, not whatever the process has now."""
    other = tmp_path_factory.mktemp("desktop-data")
    (other / "app_update_channel.json").write_text(
        json.dumps({"update_check": "never"}), encoding="utf-8"
    )
    assert desktop._auto_update_allowed(_Config(), data_dir=str(other)) is False
    assert desktop._auto_update_allowed(_Config(), data_dir=str(data_dir)) is True


def test_the_desktop_env_var_turns_the_updater_off(data_dir, monkeypatch):
    monkeypatch.setenv("ZIMI_UPDATE_CHECK", "ask")
    assert desktop._auto_update_allowed(_Config(), data_dir=str(data_dir)) is False


# ── nothing at boot for an idle server ──────────────────────────────────────


def test_an_idle_server_has_no_bittorrent_work(data_dir, monkeypatch):
    monkeypatch.setattr(p2p, "_lt", lambda: object())
    assert library.bt_work_waiting() is False


def test_seeds_someone_kept_start_the_engine_at_boot(data_dir, monkeypatch):
    library.record_seed("wiki.zim")
    assert library.bt_work_waiting() is True
    monkeypatch.setattr(p2p, "is_seeding_enabled", lambda: False)
    assert library.bt_work_waiting() is False


def test_torrents_the_engine_was_running_start_it_at_boot(data_dir):
    resume = p2p.resume_dir(str(data_dir))
    os.makedirs(resume)
    open(os.path.join(resume, "abc.fastresume"), "wb").close()
    assert library.bt_work_waiting() is True


def test_mirror_mode_starts_the_engine_at_boot(data_dir, monkeypatch):
    monkeypatch.setattr(p2p, "is_mirror_enabled", lambda: True)
    assert library.bt_work_waiting() is True
    monkeypatch.setattr(p2p, "is_torrent_enabled", lambda: False)
    assert library.bt_work_waiting() is False


def test_boot_starts_no_engine_and_probes_nothing_when_idle(data_dir, monkeypatch):
    """start_background_services' BitTorrent step, run inline: nothing to
    do, so no engine, no router, no port checker."""
    started = []
    monkeypatch.setattr(p2p, "get_backend", lambda **k: started.append("engine"))
    monkeypatch.setattr(p2p_nat, "probe", lambda *a, **k: started.append("probe"))
    monkeypatch.setattr(p2p, "peek_backend", lambda: None)
    if library.bt_work_waiting():
        p2p.get_backend(data_dir=str(data_dir))
    server._nat_upkeep()
    assert started == []


def test_upkeep_never_asks_the_port_checker(monkeypatch):
    """The router mapping is this network's; the external check is only the
    recheck button's, and an automatic probe keeps its last answer."""
    asked = []
    monkeypatch.setattr(p2p_nat, "_port_listening", lambda p: True)
    monkeypatch.setattr(p2p_nat, "add_port_mapping", lambda p: False)
    monkeypatch.setattr(
        p2p_nat, "_port_reachable_external", lambda p: asked.append(p) or True
    )
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    first = p2p_nat.probe(6881, try_upnp=True, check_reachable=True)
    assert first["reachable"] is True and asked == [6881]
    again = p2p_nat.probe(6881, try_upnp=True)
    assert asked == [6881], "an automatic probe asked the port checker"
    assert again["reachable"] is True, "the last answer for this port was dropped"
    other = p2p_nat.probe(51413, try_upnp=True)
    assert other["reachable"] is None, "another port's answer was reused"


def test_only_the_recheck_route_asks_the_port_checker():
    """Every probe call in the package, and which of them checks."""
    calls = []
    for name in sorted(os.listdir(PKG)):
        if name.endswith(".py"):
            text = open(os.path.join(PKG, name), encoding="utf-8").read()
            for m in re.finditer(r"p2p_nat\.probe\((.*?)\)\n", text, re.S):
                calls.append((name, "check_reachable=True" in m.group(1)))
    assert ("manage.py", True) in calls
    assert [c for c in calls if c[1]] == [("manage.py", True)], calls


# ── ZIMI_OFFLINE and downloads ──────────────────────────────────────────────


def test_offline_refuses_a_download_from_the_internet(data_dir, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    url = "https://download.kiwix.org/zim/wikipedia/wikipedia_en_100_2026-01.zim"
    assert library._start_download(url) == (None, library.OFFLINE_DOWNLOAD_ERROR)
    assert library._start_import(
        "https://archive.org/download/x/osm-x-2026-01-01.zim"
    ) == (
        None,
        library.OFFLINE_DOWNLOAD_ERROR,
    )


def test_offline_keeps_a_pending_download_for_later(data_dir, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    item = {
        "url": "https://download.kiwix.org/zim/x/x_en_all_2026-01.zim",
        "filename": "x_en_all_2026-01.zim",
        "size_bytes": 10,
        "source": "",
        "peer_name": "",
    }
    with open(library._pending_downloads_path(), "w", encoding="utf-8") as f:
        json.dump({"pending": [item]}, f)
    assert library.resume_pending_downloads() == 0
    with open(library._pending_downloads_path(), encoding="utf-8") as f:
        kept = json.load(f)["pending"]
    assert [k["filename"] for k in kept] == [item["filename"]]


# ── the list ────────────────────────────────────────────────────────────────

# Where Python opens a connection. A module that matches and is not in
# outbound.SOURCES reaches out without a row saying so.
_OUTBOUND_RE = re.compile(
    r"urlopen\(|urlretrieve\(|OPENER\.open\(|opener\.open\(|create_connection\(|HTTPS?Connection\(|\.connect\(\("
)


def test_every_module_that_reaches_out_has_a_row():
    rows = {r["id"] for r in outbound.inventory()["rows"]}
    unlisted = []
    for name in sorted(os.listdir(PKG)):
        if not name.endswith(".py"):
            continue
        text = open(os.path.join(PKG, name), encoding="utf-8").read()
        if _OUTBOUND_RE.search(text) and name[:-3] not in outbound.SOURCES:
            unlisted.append(name)
    assert not unlisted, "reaches out with no row in outbound.SOURCES: %s" % unlisted
    for module, ids in outbound.SOURCES.items():
        assert os.path.exists(os.path.join(PKG, module + ".py")), module
        assert set(ids) <= rows, (module, set(ids) - rows)


def test_every_row_and_state_has_its_words():
    with open(os.path.join(PKG, "static", "i18n", "en.json"), encoding="utf-8") as f:
        en = json.load(f)
    inv = outbound.inventory()
    for row in inv["rows"]:
        assert "net_" + row["id"] in en and "net_" + row["id"] + "_when" in en, row[
            "id"
        ]
    for state in ("auto", "ask", "off", "unset", "lan"):
        assert "net_state_" + state in en, state


def test_the_list_says_what_each_setting_says(data_dir, monkeypatch):
    def state(rid):
        return {r["id"]: r["state"] for r in outbound.inventory()["rows"]}[rid]

    assert state("app_updates") == "auto"
    manage.UPDATE_CHECK.set("never")
    assert state("app_updates") == "off"
    assert state("satellites") == "ask"
    monkeypatch.setattr(server, "_auto_update_enabled", True, raising=False)
    assert state("downloads") == "auto"
    assert state("catalog") == "auto", "Auto-update refreshes the catalog on its own"
    assert state("sso") == "unset"


def test_offline_turns_every_internet_row_off(data_dir, monkeypatch):
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(server, "_auto_update_enabled", True, raising=False)
    inv = outbound.inventory()
    assert inv["offline"] is True
    left_on = {
        r["id"]: r["state"] for r in inv["rows"] if r["state"] not in ("off", "unset")
    }
    # Nearby is the one exception, and it never leaves the local network.
    assert set(left_on) <= {"nearby"} and set(left_on.values()) <= {"lan"}, left_on


def test_the_docs_table_names_every_destination():
    with open(
        os.path.join(REPO, "docs", "features", "operations.md"), encoding="utf-8"
    ) as f:
        doc = f.read()
    section = doc.split("## What Zimi fetches from the internet", 1)[1].split(
        "\n## ", 1
    )[0]
    for row in outbound.inventory()["rows"]:
        for host in row["hosts"]:
            assert host in section, host
