"""Making a ZIM from the web: point Zimi at a page and get a served source.

The gate's creation journey rides the page mode: a tiny fixture site served
over local HTTP, captured with the builtin engine. The journeys are probe
first, create, find it after the fact, queue a second, read the event stream,
check the provenance. Folder mode is on the web again (1.13) for the primary
admin only, under one root (ZIMI_CREATE_ROOT, else the library folder): its
boundary is checked from both sides, who may reach it and how far it reaches.
"""

import http.server
import os
import shutil
import threading

import pytest

from fixtures_zim import build_source_folder
from conftest import quote

pytestmark = pytest.mark.gate("ZIM creation from the web")

CREATE_TIMEOUT_SEC = 180


@pytest.fixture(scope="module")
def source_folder(tmp_path_factory):
    return build_source_folder(str(tmp_path_factory.mktemp("gate-source")))


@pytest.fixture(scope="module")
def gate_server(gate_library, tmp_path_factory):
    """This module's server boots WITHOUT ZIMI_OFFLINE, overriding the shared
    fixture: web creation is a network feature by nature, and under the
    offline switch page capture correctly refuses to fetch (that refusal is
    itself gate-checked in the offline feature). The capture target is the
    loopback fixture site, so the gate still runs on a machine with no
    internet. No ZIMI_CREATE_ROOT: the disk modes (folder, archive import) are
    rooted at the library folder, which the folder checks use."""
    import shutil

    from conftest import boot, clean_env

    root = tmp_path_factory.mktemp("gate-create-instance")
    zim_dir = os.path.join(str(root), "zims")
    shutil.copytree(gate_library, zim_dir)
    env = clean_env()
    env.pop("ZIMI_OFFLINE", None)
    with boot(
        zim_dir=zim_dir, data_dir=os.path.join(str(root), "data"), env=env
    ) as server:
        yield server


@pytest.fixture(scope="module")
def source_site(source_folder):
    """The fixture folder, served over real HTTP on an ephemeral port —
    what the web creation flow actually points at."""

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=source_folder, **kw)

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    finally:
        httpd.shutdown()


def test_probe_describes_the_page_before_committing(gate_server, source_site):
    """The Create page shows you what you are about to get. If the probe lies
    or breaks, every creation becomes a leap of faith."""
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "page", "source": source_site}
    )
    assert status == 200, body
    assert body.get("ok") is True, f"probe refused a plain served page: {body}"
    assert body["mode"] == "page"
    assert body["title"] == "Field notes", f"probe misread the page: {body}"


def _tree(server, rel="", headers=None):
    return server.get_json("/manage/create/tree?path=" + quote(rel), headers=headers)


def _listed(server, rel="", headers=None):
    status, body = _tree(server, rel, headers)
    assert status == 200, body
    return {e["name"] for e in body["entries"]}


def test_folder_mode_stays_inside_its_root(gate_server):
    """Folder mode is back on the web (1.13), for the primary admin, and only
    under one root: ZIMI_CREATE_ROOT, else the library folder. The tree and
    both create doors refuse a way out (an absolute path, "..", a symlink, a
    hidden folder) and never show hidden files or Zimi's own data. A client
    that only hides the way is not the boundary; this is."""
    root = gate_server.zim_dir  # this module's server has no ZIMI_CREATE_ROOT
    outside = os.path.dirname(os.path.realpath(root))
    inside = os.path.join(root, "gate-folder")
    os.makedirs(inside, exist_ok=True)
    with open(os.path.join(inside, "index.html"), "w", encoding="utf-8") as f:
        f.write("<html><head><title>Gate folder</title></head><body>Inside.</body></html>")
    os.makedirs(os.path.join(root, ".hidden-folder"), exist_ok=True)
    escape = os.path.join(root, "gate-escape")
    if not os.path.lexists(escape):
        os.symlink(outside, escape)
    try:
        _check_folder_root(gate_server, root, outside)
    finally:
        # The library's scan must not meet them in the checks after this one.
        os.unlink(escape)
        shutil.rmtree(inside, ignore_errors=True)
        shutil.rmtree(os.path.join(root, ".hidden-folder"), ignore_errors=True)


def _check_folder_root(gate_server, root, outside):
    # The tree: the library folder's own visible entries, nothing else.
    names = _listed(gate_server)
    visible = {n for n in os.listdir(root) if not n.startswith(".")} - {"gate-escape"}
    assert names == visible, (names, visible)
    assert "gate-escape" not in names and ".hidden-folder" not in names
    assert "gate-folder" in names
    # "/" is the root it was given, never the filesystem's.
    assert _listed(gate_server, "/") == names
    for rel in ("..", "../data", outside, "gate-escape", ".hidden-folder", "gate-folder/../.."):
        status, body = _tree(gate_server, rel)
        assert status == 400, f"the tree listed {rel!r}: {body}"

    # Both doors: a folder inside is described; a way out is refused.
    status, body = gate_server.post_json(
        "/manage/create/probe", {"mode": "folder", "source": "gate-folder"}
    )
    assert status == 200 and body.get("ok") is True, body
    for source in ("..", outside, "gate-escape", ".hidden-folder", "gate-folder/../.."):
        for endpoint in ("/manage/create/probe", "/manage/create"):
            status, body = gate_server.post_json(
                endpoint, {"mode": "folder", "source": source}
            )
            assert status == 400, f"{endpoint} took folder {source!r}: {body}"
    # The old picker, which took any server path, stays gone.
    status, body = gate_server.get_json("/manage/create/browse?path=/")
    assert status == 410, body


def test_import_takes_only_an_archive_the_picker_listed(gate_server):
    """Since 1.10.0 the web imports an archive from the library folder's own
    listing. Any other path is refused through both doors, so the web never
    names a file on the server for it to open."""
    for endpoint in ("/manage/create/probe", "/manage/create"):
        status, body = gate_server.post_json(
            endpoint, {"mode": "import", "source": __file__}
        )
        assert status == 400, f"{endpoint} imported an unlisted path: {body}"
        assert body.get("error") == "choose an archive from the list", body


def test_a_page_becomes_a_zim_that_serves(gate_server, source_site):
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "page", "source": source_site, "title": "Gate Field Notes"},
    )
    assert status == 200, body
    assert body.get("status") == "started", body

    state = gate_server.poll_json(
        "/manage/create/status",
        lambda s: s.get("done") is True,
        timeout=CREATE_TIMEOUT_SEC,
    )
    assert state.get("ok") is True, f"creation failed: {state}"
    assert not state.get("error"), state

    # The new ZIM must join the live library without a restart…
    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, f"the created ZIM never joined the library: {listing}"
    entry = created[0]
    assert entry["entries"] > 0

    # …and its content must actually serve.
    main_path = entry.get("main_path")
    assert main_path, f"created ZIM has no main page: {entry}"
    status, _headers, raw = gate_server.get(
        f"/w/{entry['name']}/{quote(main_path)}?raw=1"
    )
    assert status == 200, f"created ZIM will not serve its main page: {status}"
    assert b"Field notes" in raw

    # …and it must be findable.
    status, results = gate_server.get_json(
        f"/search?q=boiling&zim={quote(entry['name'])}&limit=10"
    )
    assert status == 200
    assert results["results"], f"nothing searchable in the created ZIM: {results}"


def test_folder_mode_is_the_primary_admins_and_rooted_at_the_library(
    gate_library, tmp_path_factory
):
    """The default posture, booted for real with a password and a second
    account: with no ZIMI_CREATE_ROOT the disk modes see the library folder
    and nothing above it, and only the primary admin reaches them. A creator
    account (allowed to capture the web) and a secondary admin get 403 on the
    tree and on folder and import through both doors; nobody signed in gets
    401. The URL modes, which read nothing local, are untouched."""
    import shutil

    from conftest import boot, clean_env

    password = "gate-create-primary-password"
    root = tmp_path_factory.mktemp("gate-noroot")
    zim_dir = os.path.join(str(root), "zims")
    shutil.copytree(gate_library, zim_dir)
    env = clean_env(ZIMI_MANAGE_PASSWORD=password)
    env.pop("ZIMI_CREATE_ROOT", None)
    with boot(
        zim_dir=zim_dir, data_dir=os.path.join(str(root), "data"), env=env
    ) as server:
        primary = {"Authorization": f"Bearer {password}"}

        def account(name, role=None, can_create=False):
            body = {"action": "create", "name": name, "password": name + "-pw"}
            if role:
                body["role"] = role
            status, out = server.post_json("/manage/users", body, headers=primary)
            assert status == 200, out
            if can_create:
                status, out = server.post_json(
                    "/manage/users",
                    {"action": "set-can-create", "name": name, "can_create": True},
                    headers=primary,
                )
                assert status == 200, out
            status, out = server.post_json(
                "/login", {"username": name, "password": name + "-pw"}
            )
            assert status == 200 and out.get("token"), out
            return {"Cookie": "zimi_session=" + out["token"]}

        creator = account("gate-creator", can_create=True)
        second = account("gate-second-admin", role="admin")

        # The primary admin: the library folder, "/" included, and no higher.
        names = _listed(server, "", primary)
        assert names == {n for n in os.listdir(zim_dir) if not n.startswith(".")}, names
        assert _listed(server, "/", primary) == names
        status, body = _tree(server, "..", primary)
        assert status == 400, body

        # Everyone else: refused, the signed-in with 403, the anonymous 401.
        for who, headers, expected in (
            ("creator", creator, 403),
            ("secondary admin", second, 403),
            ("anonymous", None, 401),
        ):
            status, body = _tree(server, "", headers)
            assert status == expected, f"{who} read the tree: {status} {body}"
            for endpoint in ("/manage/create/probe", "/manage/create"):
                for mode, source in (("folder", "."), ("import", "x.warc")):
                    status, body = server.post_json(
                        endpoint, {"mode": mode, "source": source}, headers=headers
                    )
                    assert status == expected, (
                        f"{who} reached {mode} at {endpoint}: {status} {body}"
                    )
        # The creator still captures the web: the URL modes are theirs.
        status, body = server.post_json(
            "/manage/create/probe", {"mode": "page", "source": "nonsense"}, headers=creator
        )
        assert status == 400 and "disk" not in body.get("error", ""), body
        # Import takes only a listed archive, even from the primary admin.
        for endpoint in ("/manage/create", "/manage/create/probe"):
            status, body = server.post_json(
                endpoint, {"mode": "import", "source": __file__}, headers=primary
            )
            assert status == 400, f"{endpoint} took import of {__file__}: {body}"
            assert body.get("error") == "choose an archive from the list", body


def test_a_finished_job_is_findable_after_the_fact(gate_server):
    """An admin who closed the tab and came back must be able to find out what
    happened. The job log survives the job; if this breaks, the answer to "did
    my capture finish?" goes back to being "look at the library and guess"."""
    status, state = gate_server.get_json("/manage/create/status?history=1")
    assert status == 200, state
    history = state.get("history")
    assert isinstance(history, list) and history, f"no job history at all: {state}"
    mine = [record for record in history if record.get("title") == "Gate Field Notes"]
    assert mine, f"the finished job is missing from the history: {history}"
    assert mine[0]["state"] == "ok", mine[0]
    assert mine[0]["mode"] == "page"
    assert mine[0]["result"], f"the history does not name what was created: {mine[0]}"


def test_a_second_submission_queues_and_can_be_dropped(gate_server, source_site):
    """Two submissions are a plan, not a mistake. The queue is what makes the
    Create page usable by somebody who knows what they want to build."""
    first = gate_server.post_json(
        "/manage/create", {"mode": "page", "source": source_site, "title": "Q1"}
    )
    assert first[0] == 200, first
    second_status, second = gate_server.post_json(
        "/manage/create", {"mode": "page", "source": source_site, "title": "Q2"}
    )
    assert second_status == 200, second
    # The first job may already have finished — a one-page capture from
    # localhost is quick — so either answer is correct, and both must be
    # honest about which.
    if second.get("status") == "queued":
        assert second["position"] == 1
        dropped_status, dropped = gate_server.post_json(
            "/manage/create/cancel", {"id": second["id"]}
        )
        assert dropped_status == 200, dropped
        assert dropped["status"] == "dequeued"
    else:
        assert second["status"] == "started", second
    state = gate_server.poll_json(
        "/manage/create/status",
        lambda s: s.get("done") is True and not s.get("queue"),
        timeout=CREATE_TIMEOUT_SEC,
    )
    assert state.get("queue") == [], state


def test_the_progress_stream_carries_structured_events(gate_server, source_site):
    """The Create page draws its progress from these, not from the log text.
    An empty or malformed stream means a progress view that cannot move."""
    status, body = gate_server.post_json(
        "/manage/create",
        {"mode": "page", "source": source_site, "title": "Gate Events"},
    )
    assert status == 200, body
    state = gate_server.poll_json(
        "/manage/create/status?events_since=0",
        lambda s: s.get("done") is True,
        timeout=CREATE_TIMEOUT_SEC,
    )
    events = state.get("events")
    assert isinstance(events, list) and events, f"no structured events: {state}"
    assert [event["i"] for event in events] == list(range(len(events)))
    assert all(event["t"] in ("phase", "node", "count") for event in events), events
    phases = [event["phase"] for event in events if event["t"] == "phase"]
    assert phases[-1] == "done", phases
    assert state["event_cursor"] == len(events)


def test_the_created_zim_carries_its_provenance(gate_server):
    """Every ZIM Zimi writes says who made it. A reader that trusts a ZIM's
    origin needs that metadata present, not just intended."""
    pytest.importorskip("libzim.reader")
    from libzim.reader import Archive

    status, listing = gate_server.get_json("/list")
    assert status == 200
    created = [z for z in listing if z.get("title") == "Gate Field Notes"]
    assert created, "run after the creation check — nothing was created"
    # Web creations land on the Created shelf (<zim_dir>/created), not in the
    # library root; /list carries the bare filename either way.
    path = os.path.join(gate_server.zim_dir, "created", created[0]["file"])
    assert os.path.exists(path), path

    archive = Archive(path)
    scraper = bytes(archive.get_metadata("Scraper")).decode("utf-8", "replace")
    assert "zimi" in scraper.lower(), f"no Zimi provenance in Scraper: {scraper!r}"
