"""Saving (1.12) in a real browser: one store for bookmarks, lists, likes and
where you were, kept with the account when signed in.

- Bookmarks v2 (folders, app items, a map's place, Bookshelf's places) come
  in as saved items and lists on a phone-sized screen, and the old keys stay.
- Two devices on one account: a delete on one survives the other's sync, and
  what the other made reaches the first.
- Bookshelf, the app on it end to end: a book read on the phone is under
  Continue reading on the tablet and opens there where the phone left it;
  Add to my shelf puts it on My shelf; the Saved panel opens on Bookshelf's own.

Run: pytest tests/test_saved_live.py -v
"""

import json
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.renderer as renderer  # noqa: E402
import zimi.server as srv  # noqa: E402
import zimi.users as users  # noqa: E402

PASSWORD = "correct horse 1"
T0 = 1790000000000
FOLDERS = [
    {"id": "f_travel", "name": "Travel", "parent": "", "order": 0},
    {"id": "f_pt", "name": "Portugal", "parent": "f_travel", "order": 0},
    {"id": "f_med", "name": "Medical", "parent": "", "order": 1},
]
BOOKMARKS = [
    {
        "zim": "wiki",
        "path": "A/Sol",
        "title": "Sun",
        "timestamp": T0 + 1,
        "folder": "f_travel",
        "order": 0,
    },
    {
        "zim": "wiki",
        "path": "A/Mercury_(planet)",
        "title": "Mercury",
        "timestamp": T0 + 2,
        "folder": "f_pt",
        "order": 1,
    },
    {
        "zim": "osm-portugal",
        "path": "index.html",
        "title": "Lisbon",
        "timestamp": T0 + 3,
        "folder": "f_pt",
        "order": 0,
        "pos": "map=12.00/38.72000/-9.14000",
    },
    {
        "zim": "ted",
        "path": "talks/lisbon",
        "title": "A talk",
        "timestamp": T0 + 4,
        "app": "tube",
    },
    {
        "zim": "wiki",
        "path": "A/Sun",
        "title": "Sun, renamed",
        "origTitle": "Sun",
        "timestamp": T0 + 5,
        "folder": "f_med",
    },
]
PLACES = {
    "gutenberg_mul\nLiber.1": {
        "f": 0.42,
        "c": 9000,
        "ts": T0 + 20,
        "id": 1,
        "title": "Liber",
        "author": "A. Writer",
        "cover": "",
    }
}
READER = "() => { var f = document.getElementById('reader-frame'); return f && f.contentDocument && f.contentDocument.querySelector('.zb-foot'); }"


@pytest.fixture
def served(tmp_path, monkeypatch):
    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")
    from http.server import ThreadingHTTPServer

    from conftest_zim import _MediaItem, build_wiki_fixture_zim
    from libzim.writer import Creator
    from test_book_reader import FILES, G2Z

    from zimi import books
    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_wiki_fixture_zim(str(zdir / "wiki.zim"))
    with Creator(str(zdir / "gutenberg_mul_all_2026-01.zim")).config_indexing(
        False, "eng"
    ) as cr:
        cr.set_mainpath("Liber.1")
        for fpath, blob in FILES.items():
            cr.add_item(
                _MediaItem(
                    fpath,
                    "application/javascript" if fpath.endswith(".js") else "text/html",
                    blob,
                )
            )
        for key, value in {
            "Scraper": G2Z,
            "Name": "gutenberg_mul_all",
            "Title": "Library",
            "Language": "eng",
            "Description": "books",
            "Date": "2026-01-04",
        }.items():
            cr.add_metadata(key, value)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(data))
    if hasattr(books, "request_details"):
        monkeypatch.setattr(books, "request_details", lambda name: None)
    if hasattr(books, "_reset_for_tests"):
        books._reset_for_tests()
    srv.load_cache(force=True)
    users.create_user("alice", PASSWORD, role="user")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _device(br, base, width=1280, seed=None, errors=None):
    ctx = br.new_context(viewport={"width": width, "height": 860})
    pg = ctx.new_page()
    if errors is not None:
        pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/")
    _ready(pg)
    pg.evaluate(
        "(s) => { localStorage.clear(); for (var k in s) localStorage.setItem(k, s[k]); }",
        seed or {},
    )
    pg.reload()
    _ready(pg)
    return pg


def _ready(pg):
    pg.wait_for_function(
        "() => typeof zimsCache !== 'undefined' && (zimsCache || []).length > 0",
        timeout=30000,
    )


def _sign_in(pg):
    assert (
        pg.evaluate("(pw) => doLogin('alice', pw, true).then(r => r.status)", PASSWORD)
        == 200
    )
    pg.reload()
    _ready(pg)
    # The account's copy comes in when the page is idle; what this browser
    # brought goes up a moment later.
    pg.wait_for_function("() => Saved.account() === 'alice'", timeout=10000)
    pg.wait_for_timeout(2500)


def _rows(pg):
    return pg.evaluate(
        "() => Array.from(document.querySelectorAll('#bm-tree .bm-row')).map(r => (r.classList.contains('bm-folder') ? '# ' : '') + r.querySelector('.bm-name').textContent)"
    )


def test_bookmarks_v2_come_in_as_saved_lists(served):
    from playwright.sync_api import sync_playwright

    errors = []
    seed = {
        "zimi_bookmarks": json.dumps(BOOKMARKS),
        "zimi_bm_folders": json.dumps(FOLDERS),
        "zimi_book_places": json.dumps(PLACES),
    }
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 390, seed, errors)
        pg.evaluate("() => openArticle('wiki', 'A/Sol')")
        pg.wait_for_timeout(800)
        pg.click("#bm-panel-btn")
        pg.wait_for_selector("#bm-tree .bm-row")
        rows = _rows(pg)
        # Continue (Bookshelf's place), Liked, each folder a list named by
        # its path in the tree's order with its order kept, then no list.
        assert rows == [
            "# Continue",
            "Liber",
            "# Liked",
            "# Travel",
            "Sun",
            "# Travel / Portugal",
            "Lisbon",
            "Mercury",
            "# Medical",
            "Sun, renamed",
            "# Not in a list",
            "A talk",
        ], rows
        place = pg.evaluate(
            "() => Saved.get('osm-portugal\\nindex.html\\nmap=12.00/38.72000/-9.14000')"
        )
        assert (
            place["kind"] == "place"
            and place["where"]["pos"] == "map=12.00/38.72000/-9.14000"
        )
        assert pg.evaluate("() => Saved.get('ted\\ntalks/lisbon').kind") == "video"
        # The bookmark button knows the article on screen is kept.
        assert (
            pg.evaluate("() => document.getElementById('library-btn').dataset.state")
            == "saved"
        )
        # Nothing lost, the old keys where they were.
        assert pg.evaluate(
            "() => ['zimi_bookmarks', 'zimi_bm_folders', 'zimi_book_places'].every(k => localStorage.getItem(k))"
        )
        assert pg.evaluate(
            "() => { var r = document.getElementById('history-panel').getBoundingClientRect(); return r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; }"
        ), "the panel does not fit a 390px screen"
        br.close()
    assert not errors, errors


def _drag(pg, src, dst, at=0.5):
    a = pg.locator(src).first.bounding_box()
    b = pg.locator(dst).first.bounding_box()
    pg.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    pg.mouse.down()
    pg.mouse.move(a["x"] + 70, a["y"] + a["height"] / 2 + 8, steps=4)
    pg.mouse.move(b["x"] + 60, b["y"] + b["height"] * at, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(250)


def test_lists_by_hand(served):
    """Make a list, put an item in two lists from its menu, rename, reorder
    and move by drag, export one list, delete a list: its items stay."""
    from playwright.sync_api import sync_playwright

    seed = {
        "zimi_bookmarks": json.dumps(BOOKMARKS),
        "zimi_bm_folders": json.dumps(FOLDERS),
    }
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 1280, seed)
        pg.evaluate("() => toggleLibraryPanel('bookmarks')")
        pg.get_by_role("button", name="New list").click()
        pg.locator(".bm-newfolder-input").fill("Portugal trip")
        pg.locator(".bm-newfolder-input").press("Enter")
        pg.wait_for_timeout(200)
        assert "# Portugal trip" in _rows(pg)
        pg.locator(".bm-bk[data-path='A/Sol']").first.click(button="right")
        pg.locator(".ctx-item", has_text="Lists").first.hover()
        pg.locator(".ctx-sub .ctx-item", has_text="Portugal trip").click()
        pg.wait_for_timeout(250)
        assert len(pg.evaluate("() => Saved.get('wiki\\nA/Sol').lists")) == 2
        assert _rows(pg).count("Sun") == 2, "an item in two lists is a row under each"
        pg.locator(".bm-folder[data-fid='f_med']").click(button="right")
        pg.locator(".ctx-item", has_text="Rename").click()
        pg.locator(".bm-rename-input").fill("Health")
        pg.locator(".bm-rename-input").press("Enter")
        pg.wait_for_timeout(200)
        _drag(
            pg, ".bm-folder[data-fid='f_med']", ".bm-folder[data-fid='f_travel']", 0.2
        )
        lists = [r for r in _rows(pg) if r.startswith("# ")]
        assert lists.index("# Health") < lists.index("# Travel"), lists
        _drag(
            pg,
            ".bm-bk[data-fid='f_travel'][data-path='A/Sol']",
            ".bm-folder[data-fid='f_med']",
        )
        assert sorted(pg.evaluate("() => Saved.get('wiki\\nA/Sol').lists")) == sorted(
            [
                "f_med",
                pg.evaluate(
                    "() => Saved.lists().filter(l => l.name === 'Portugal trip')[0].id"
                ),
            ]
        )
        pg.locator(".bm-folder[data-fid='f_med']").click(button="right")
        pg.locator(".ctx-item", has_text="Export to ZIM").click()
        assert pg.evaluate("() => _bmExportSelection()") == {
            "ids": ["f_med"],
            "unfiled": False,
        }
        assert pg.input_value("#bm-export-name") == "Health"
        pg.evaluate("() => _bmCloseExport()")
        pg.locator(".bm-folder[data-fid='f_med']").click(button="right")
        pg.locator(".ctx-item", has_text="Delete list").click()
        # A list with something in it asks first, and says its items stay.
        pg.wait_for_selector(".ctx-note")
        assert "stays saved" in pg.locator(".ctx-note").inner_text()
        assert "# Health" in _rows(pg)
        pg.locator(".ctx-item.danger", has_text="Delete list").click()
        pg.wait_for_timeout(250)
        assert "# Health" not in _rows(pg) and pg.evaluate(
            "() => Saved.has('wiki\\nA/Sun') && Saved.has('wiki\\nA/Sol')"
        )
        br.close()


def test_a_delete_on_one_device_survives_the_others_sync(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        phone = _device(
            br,
            served,
            390,
            {
                "zimi_bookmarks": json.dumps(BOOKMARKS),
                "zimi_bm_folders": json.dumps(FOLDERS),
            },
        )
        _sign_in(phone)
        # 1.11's bookmarks are this browser's, not the account's: offered.
        assert phone.evaluate("() => Saved.all().length") == 0
        phone.evaluate("() => toggleLibraryPanel('bookmarks')")
        phone.locator(".bm-note button", has_text="Add them to my account").click()
        phone.evaluate("() => _savedFlush()")
        phone.wait_for_timeout(800)
        phone.evaluate("() => _closeLibraryPanel()")
        assert (
            "wiki\nA/Sol" in users.load_user_data("alice")["saved"]["items"]
        ), "the phone's bookmarks did not reach the account"
        tablet = _device(br, served, 1280)
        _sign_in(tablet)
        assert tablet.evaluate("() => Saved.has('wiki\\nA/Sol')")

        phone.evaluate("() => toggleLibraryPanel('bookmarks')")
        phone.locator(".bm-bk[data-path='A/Sol']").first.click(button="right")
        phone.locator(".ctx-item.danger").click()
        phone.evaluate("() => _savedFlush()")
        phone.wait_for_timeout(800)
        saved = users.load_user_data("alice")["saved"]
        assert "wiki\nA/Sol" not in saved["items"] and "i:wiki\nA/Sol" in saved["gone"]

        # The tablet still holds Sun; it changes something and syncs.
        tablet.evaluate(
            "() => { Saved.createList('Made on the tablet'); _savedFlush(); }"
        )
        tablet.wait_for_timeout(800)
        saved = users.load_user_data("alice")["saved"]
        assert (
            "wiki\nA/Sol" not in saved["items"]
        ), "the tablet's sync brought a deleted item back"
        assert not tablet.evaluate("() => Saved.has('wiki\\nA/Sol')")
        phone.evaluate("() => _savedPull()")
        phone.wait_for_function(
            "() => Saved.lists().some(l => l.name === 'Made on the tablet')",
            timeout=5000,
        )
        br.close()


def test_bookshelf_continue_reading_and_my_shelf_follow_the_account(served):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        phone = _device(br, served, 390)
        _sign_in(phone)
        phone.evaluate("() => openBooks()")
        frame = phone.frame_locator("#reader-frame")
        frame.locator(".bk").first.wait_for()
        frame.locator(".bk[data-book='1']").first.click()
        frame.locator(".actions .keep").click()  # Add to my shelf
        phone.wait_for_function(
            "() => Saved.has('gutenberg_mul\\nLiber.1')", timeout=5000
        )
        frame.locator(".actions .read").click()
        phone.wait_for_function(READER, timeout=30000)
        phone.wait_for_timeout(600)
        for _ in range(3):
            phone.keyboard.press("ArrowRight")
            phone.wait_for_timeout(500)
        phone.wait_for_timeout(1200)
        where = phone.evaluate(
            "() => Saved.position({ zim: 'gutenberg_mul', path: 'Liber.1' }).where"
        )
        assert where["c"] > 0 and where["f"] > 0
        phone.evaluate("() => _savedFlush()")
        phone.wait_for_timeout(800)
        assert (
            "gutenberg_mul\nLiber.1"
            in users.load_user_data("alice")["saved"]["positions"]
        )

        tablet = _device(br, served, 1280)
        _sign_in(tablet)
        tablet.evaluate("() => openBooks()")
        tframe = tablet.frame_locator("#reader-frame")
        tframe.locator(".shelf").first.wait_for()
        shelves = tablet.evaluate(
            "() => Array.from(document.getElementById('reader-frame').contentDocument.querySelectorAll('.shelf')).map(s => s.querySelector('h2').textContent + ':' + Array.from(s.querySelectorAll('.bk .t')).map(t => t.textContent).join(','))"
        )
        assert (
            "Continue reading:Liber" in shelves and "My shelf:Liber" in shelves
        ), shelves
        # The Saved panel, opened over Bookshelf, is on Bookshelf's own.
        tablet.click("#bm-panel-btn")
        tablet.wait_for_selector("#bm-tree .bm-row")
        assert tablet.evaluate("() => _bmScope") == "books"
        assert _rows(tablet) == [
            "# Continue",
            "Liber",
            "# Not in a list",
            "Liber",
        ], _rows(tablet)
        tablet.evaluate("() => _closeLibraryPanel()")
        # And the book opens where the phone left it.
        tframe.locator(".bk[data-book='1']").first.click()
        tframe.locator(".actions .read").click()
        tablet.wait_for_function(READER, timeout=30000)
        tablet.wait_for_timeout(1500)
        back = tablet.evaluate(
            "() => Saved.position({ zim: 'gutenberg_mul', path: 'Liber.1' }).where"
        )
        assert abs(back["f"] - where["f"]) < 0.05, (back, where)
        br.close()


def _item(path, title):
    return {
        "kind": "article",
        "zim": "wiki",
        "path": path,
        "title": title,
        "added": T0,
        "ts": T0,
    }


def _flushed(pg):
    """Everything this browser holds is on the account."""
    pg.evaluate("() => _savedFlush()")
    pg.wait_for_function("() => !_savedDelta() && !_savedPushing", timeout=10000)


def test_a_shared_browser_offers_its_old_bookmarks_and_keeps_nothing_after_sign_out(
    served,
):
    """1.11 kept bookmarks per browser: signed out they come in, but an
    account that signs in on the same screen is asked, once, and gets
    nothing by itself. Signing out takes the account's copy (a note in a
    highlight included) out of the browser once the account has it."""
    from playwright.sync_api import sync_playwright

    seed = {
        "zimi_bookmarks": json.dumps(BOOKMARKS),
        "zimi_bm_folders": json.dumps(FOLDERS),
    }
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 390, seed)
        assert pg.evaluate("() => Saved.all().length") == 5
        _sign_in(pg)
        assert (
            pg.evaluate("() => Saved.all().length") == 0
        ), "an account took the shared browser's bookmarks by itself"
        assert users.load_user_data("alice")["saved"]["items"] == {}
        pg.evaluate("() => toggleLibraryPanel('bookmarks')")
        assert "earlier version" in pg.locator(".bm-note").inner_text()
        pg.locator(".bm-note button", has_text="No, thanks").click()
        pg.wait_for_timeout(200)
        assert pg.locator(".bm-note").count() == 0
        assert pg.evaluate("() => Saved.all().length") == 0
        pg.evaluate(
            "() => { Saved.save({ zim: 'wiki', path: 'A/Sol', title: 'Sun' }); Saved.highlight({ zim: 'wiki', path: 'A/Sol', exact: 'the star', note: 'a private note' }); }"
        )
        with pg.expect_navigation():
            pg.evaluate("() => userLogout()")
        _ready(pg)
        kept = pg.evaluate(
            "() => { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; }"
        )
        assert not [k for k in kept if k.endswith(":alice")], list(kept)
        assert "a private note" not in json.dumps(kept)
        saved = users.load_user_data("alice")["saved"]
        assert "wiki\nA/Sol" in saved["items"]
        assert [h["note"] for h in saved["highlights"].values()] == ["a private note"]
        # Signed in again: the account's copy comes back, and nobody is asked twice.
        _sign_in(pg)
        assert pg.evaluate("() => Saved.has('wiki\\nA/Sol')")
        assert not pg.evaluate("() => Saved.legacyOffered()")
        br.close()


def test_overwrite_from_a_file_holds_for_a_signed_in_account(served):
    """Overwrite takes the file whole on the account too: what it replaced
    does not come back with the next sync. A file from before 1.12 (its
    bookmarks, no store) overwrites as well."""
    from playwright.sync_api import sync_playwright

    users.sync_user_data(
        "alice",
        {
            "saved": {
                "items": {
                    "wiki\nA/A": _item("A/A", "A"),
                    "wiki\nA/B": _item("A/B", "B"),
                }
            }
        },
    )
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 1280)
        _sign_in(pg)
        assert pg.evaluate("() => Saved.has('wiki\\nA/A') && Saved.has('wiki\\nA/B')")
        file = {
            "schema": "zimi-backup",
            "schema_version": 3,
            "scope": "my-data",
            "saved": {"items": {"wiki\nA/C": _item("A/C", "C")}},
        }
        take = "(t) => { if (!document.getElementById('ms-mydata-overwrite')) document.body.insertAdjacentHTML('beforeend', '<input type=checkbox id=ms-mydata-overwrite checked hidden>'); _applyMyDataFile(t); }"
        pg.evaluate(take, json.dumps(file))
        _flushed(pg)
        assert list(users.load_user_data("alice")["saved"]["items"]) == ["wiki\nA/C"]
        pg.evaluate("() => _savedPull()")
        pg.wait_for_timeout(600)
        assert pg.evaluate("() => Saved.all().map(i => i.key)") == ["wiki\nA/C"]
        old = {
            "schema": "zimi-backup",
            "schema_version": 2,
            "scope": "my-data",
            "bookmarks": [
                {"zim": "wiki", "path": "A/Old", "title": "Old", "timestamp": 5}
            ],
        }
        pg.evaluate(take, json.dumps(old))
        _flushed(pg)
        assert list(users.load_user_data("alice")["saved"]["items"]) == ["wiki\nA/Old"]
        br.close()


def test_sync_paused_when_the_store_is_too_large_says_so(served, monkeypatch):
    """The account refuses a store past its budget: the device says sync is
    paused and what to do, and picks up once something is let go."""
    from playwright.sync_api import sync_playwright

    monkeypatch.setattr(users, "_SAVED_MAX_BYTES", 6000)
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 1280)
        _sign_in(pg)
        pg.evaluate(
            "() => { for (var i = 0; i < 20; i++) Saved.save({ zim: 'wiki', path: 'A/n' + i, title: 'A long title '.repeat(30) }); }"
        )
        pg.evaluate("() => _savedFlush()")
        pg.wait_for_function("() => _savedPaused", timeout=10000)
        pg.evaluate("() => toggleLibraryPanel('bookmarks')")
        note = pg.locator(".bm-note.bm-warn").inner_text()
        assert "Sync paused" in note and "Remove" in note, note
        assert users.load_user_data("alice")["saved"]["items"] == {}
        pg.evaluate(
            "() => { for (var i = 2; i < 20; i++) Saved.remove('wiki\\nA/n' + i); }"
        )
        _flushed(pg)
        assert not pg.evaluate("() => _savedPaused")
        assert pg.locator(".bm-note.bm-warn").count() == 0
        assert sorted(users.load_user_data("alice")["saved"]["items"]) == [
            "wiki\nA/n0",
            "wiki\nA/n1",
        ]
        br.close()


def test_leaving_the_tab_sends_what_is_waiting_in_a_request_that_outlives_it(served):
    """Hidden, then closed: what the account has not had goes in a keepalive
    request, which carries 64 KB at most. It is only the changes since the
    account last answered, so a store far larger still goes."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        pg = _device(br, served, 390)
        _sign_in(pg)
        pg.evaluate(
            "() => { for (var i = 0; i < 300; i++) Saved.save({ zim: 'wiki', path: 'A/n' + i, title: 'x'.repeat(400) }); }"
        )
        _flushed(pg)
        assert pg.evaluate("() => JSON.stringify(Saved.data()).length") > 100000
        pg.evaluate(
            "() => { window.__sent = []; var f = window.fetch; window.fetch = function (u, o) { if (u === '/userdata' && o && o.method === 'POST') __sent.push({ keepalive: !!o.keepalive, size: o.body.length, body: o.body }); return f.apply(this, arguments); }; }"
        )
        pg.evaluate(
            "() => Saved.save({ zim: 'wiki', path: 'A/Last', title: 'Saved as the tab closes' })"
        )
        pg.evaluate(
            "() => { Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); }"
        )
        sent = pg.evaluate("() => __sent")
        assert any(
            s["keepalive"] and "A/Last" in s["body"] and s["size"] < 60000 for s in sent
        ), [(s["keepalive"], s["size"]) for s in sent]
        pg.wait_for_timeout(800)
        assert "wiki\nA/Last" in users.load_user_data("alice")["saved"]["items"]
        br.close()
