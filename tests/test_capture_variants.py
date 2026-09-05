"""Two facts a capture can now state about itself.

**The variant sweep is a choice.** A recording keeps every image size the DOM
could ask for, not only the one this screen chose, because the reader's screen
is never the recorder's. That is the right default and it is not free — so it
can be turned off, and off means "this screen only": a smaller archive that
replays correctly here and may show gaps elsewhere. The switch is plumbed as a
real bool from the form to the session, and it is offered ONLY beside the
recording engine, because that is the only engine with an archive to sweep into.

**A browser capture names the browser.** Rendered and builtin captures wrote
identical metadata, so nothing downstream could tell a headless-Chromium ZIM
from a urllib one — the About panel had to say "" and mean "either". A rendered
capture now stamps the Chromium version it actually ran, which is evidence
rather than inference: a ZIM that names no browser was not made by one.
"""

import inspect
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.creator as creator  # noqa: E402
import zimi.crawler as crawler  # noqa: E402
import zimi.http as http  # noqa: E402
import zimi.manage as manage  # noqa: E402
import zimi.renderer as renderer  # noqa: E402
import zimi.zimwriter as zimwriter  # noqa: E402

# ── the constants the surfaces mirror ───────────────────────────────────────


def test_the_web_form_mirrors_the_engine_default():
    """manage.py holds these as literals so validating a request never drags in
    the writer stack. That only stays honest if a test pins them together."""
    assert manage.CREATE_CAPTURE_VARIANTS is renderer.VARIANT_SWEEP_DEFAULT


def test_only_the_recording_engine_is_offered_the_sweep():
    """The rendered engine renders one page at one viewport and stores the
    picture it got; there is no archive for extra sizes to live in. Offering
    the switch there would be offering a switch over nothing."""
    assert manage.CREATE_VARIANT_ENGINES == ("alive",)
    # And it is genuinely narrower than ad blocking, which both browser engines
    # can do — if these ever match, one of them is wrong.
    assert set(manage.CREATE_VARIANT_ENGINES) < set(manage.CREATE_BLOCKING_ENGINES)


# ── the request, validated ──────────────────────────────────────────────────


def _validated(**data):
    data.setdefault("mode", "page")
    data.setdefault("source", "https://example.org/")
    _mode, _source, _title, opts = manage._create_validate(data)
    return opts


@pytest.fixture(autouse=True)
def alive_here(monkeypatch):
    """The validator refuses an engine this server lacks before it ever looks
    at the options, so the option tests need a server that has one."""
    monkeypatch.setattr(manage, "_create_browser_ready", lambda: True)
    monkeypatch.setattr(manage, "_create_alive_ready", lambda: True)


def test_the_sweep_defaults_on_when_the_form_says_nothing():
    """Silence means the checkbox rendered ticked and nobody touched it."""
    assert _validated(engine="alive")["capture_variants"] is True


def test_unticking_it_survives_as_a_real_false():
    """The whole reason this is not an ordinary flag: absence and false have to
    mean different things, or unticking would be a click that changed nothing."""
    assert (
        _validated(engine="alive", capture_variants=False)["capture_variants"] is False
    )


def test_a_form_encoded_false_is_a_false():
    """A form post has no JSON booleans."""
    assert (
        _validated(engine="alive", capture_variants="false")["capture_variants"]
        is False
    )


def test_an_engine_that_cannot_sweep_drops_the_field(engine="rendered"):
    """A form left open while the engine radio moved is not a request anybody
    made — dropped, exactly as a stale block_ads is dropped."""
    for name in ("rendered", "builtin", ""):
        opts = _validated(engine=name, capture_variants=False)
        assert "capture_variants" not in opts, name


def test_it_reaches_the_engine_kwargs_for_both_web_modes():
    """_create_kwargs only forwards what the admin actually set, so a mode that
    forgot to list the name would silently capture the other way."""
    opts = {"engine": "alive", "capture_variants": False}
    assert manage._create_kwargs(opts, "engine", "capture_variants") == opts


# ── the plumbing, end to end ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "func",
    [
        creator.create_page_zim,
        creator.create_pages_zim,
        crawler.create_site_zim,
    ],
)
def test_every_web_entry_point_accepts_the_switch(func):
    """One missing link and the UI would be a control wired to nothing."""
    assert "capture_variants" in inspect.signature(func).parameters


def test_the_fast_engine_accepts_it_and_ignores_it():
    """capture_engine hands the shared option set to whichever engine was
    named. The fast engine has to take the kwarg or every builtin crawl raises
    TypeError — which is exactly what happened while this was being built."""
    engine = creator.capture_engine("builtin", capture_variants=False)
    assert isinstance(engine, creator.BuiltinCapture)


def test_the_session_honours_off():
    session = renderer.RenderedSession(work_dir="/tmp", capture_variants=False)
    assert session._capture_variants is False


def test_the_session_defaults_to_sweeping():
    session = renderer.RenderedSession(work_dir="/tmp")
    assert session._capture_variants is renderer.VARIANT_SWEEP_DEFAULT


def test_a_switched_off_sweep_does_not_touch_the_archive(monkeypatch):
    """The gate is checked before anything is enumerated, so an off sweep costs
    no page evaluation at all — not a sweep that runs and discards."""
    session = renderer.RenderedSession(work_dir="/tmp", capture_variants=False)
    # A recorder and a context would otherwise satisfy the two later guards.
    session._recorder = object()
    session._context = object()

    def boom(*_a, **_k):
        raise AssertionError("the sweep enumerated candidates while switched off")

    page = type("P", (), {"evaluate": boom, "url": "https://e.org/"})()
    session._record_variants(page)  # must simply return


# ── the tool stamp ──────────────────────────────────────────────────────────


def test_a_builtin_capture_names_no_tool():
    """The empty dict is the answer, not a missing one — and history_record
    drops it, so a builtin ZIM's record comes out byte-identical to before."""
    assert creator.BuiltinCapture.tools == {}
    assert creator.capture_tools(creator.BuiltinCapture()) == {}
    record = zimwriter.history_record("created", "page", "x", tools={})
    assert "tools" not in record


def test_capture_tools_survives_an_engine_that_never_heard_of_it():
    """Read through getattr, like report_blocked, so a third-party or older
    engine object costs a field rather than the whole capture."""
    assert creator.capture_tools(object()) == {}


def test_an_unstarted_session_claims_nothing():
    """No browser ran, so no browser version is true. Claiming one would be
    provenance invented at construction time."""
    assert renderer.RenderedSession(work_dir="/tmp").tools == {}


def test_a_started_session_names_the_browser_it_ran():
    session = renderer.RenderedSession(work_dir="/tmp")
    session._browser_version = "140.0.7339.16"
    assert session.tools == {"chromium": "140.0.7339.16"}
    record = zimwriter.history_record("created", "page", "x", tools=session.tools)
    assert record["tools"] == {"chromium": "140.0.7339.16"}


# ── what the reader can then tell apart ─────────────────────────────────────


def _kind(record):
    meta = {zimwriter.HISTORY_METADATA_KEY: json.dumps([record])}
    return http._zimi_kind(meta)


def test_a_browser_capture_reads_as_rendered():
    record = zimwriter.history_record(
        "created", "page", "captured one page", tools={"chromium": "140.0.1"}
    )
    assert _kind(record)["engine"] == "rendered"


def test_a_builtin_capture_still_reads_as_nothing_in_particular():
    """ "" is the honest answer for a file carrying no evidence either way —
    including every ZIM made before the stamp existed."""
    record = zimwriter.history_record("created", "page", "captured one page")
    assert _kind(record)["engine"] == ""


def test_a_replay_capture_is_still_alive_whatever_it_names():
    """The alive tag wins: a recording runs a browser too, and calling it
    "rendered" would lose the distinction that actually matters to a reader."""
    record = zimwriter.history_record(
        "created", "page", "recorded one page", tools={"chromium": "140.0.1"}
    )
    meta = {
        zimwriter.HISTORY_METADATA_KEY: json.dumps([record]),
        "Tags": "zimi:alive",
    }
    assert http._zimi_kind(meta)["engine"] == "alive"
