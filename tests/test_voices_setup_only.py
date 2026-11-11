"""A voice whose files are here and whose engine is not needs one tap, not a download.

The 1.16 Docker image no longer carries Piper and Kokoro. A data folder from the image before still has the
voices (files and installed.json) but no engines venv: the voice read as downloaded in the data and as not
there in the page, and Get did nothing, because the server answered "installed" before looking for the engine.

Run: pytest tests/test_voices_setup_only.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from test_voices import _fake_build, bare, data  # noqa: E402,F401  (fixtures)
from zimi import voices  # noqa: E402


def _put_files_here(tag):
    """The voice as the old image left it: every pinned file at its pinned size, and its record."""
    pin = voices.VOICES[tag]
    folder = voices._engine_dir(pin.engine)
    os.makedirs(folder, exist_ok=True)
    for name, _url, size in pin.files:
        with open(os.path.join(folder, name), "wb") as f:
            f.write(b"x" * size)
    voices._set_installed(
        pin.engine,
        tag,
        {
            "id": pin.id,
            "revision": pin.revision,
            "bytes": voices._bytes(tag),
            "files": [n for n, _u, _s in pin.files],
            "voice": pin.voice,
        },
    )


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*a, **k):
        raise AssertionError("a file that is already here was fetched again")

    monkeypatch.setattr(voices.urllib.request, "urlopen", refuse)


def test_the_row_says_needs_setup_with_the_engines_size_only(bare, monkeypatch):
    monkeypatch.setattr(voices, "_kokoro_python", lambda: None)  # Piper alone, so Piper is the offer
    _put_files_here("fr")
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["fr"]
    assert row["installed"] and row["needs_setup"]
    assert (
        row["bytes"] == voices.setup_bytes(voices.PIPER) > 0
    ), "the engines, not the voice again"
    lang = {r["lang"]: r for r in voices.manage_payload()["langs"]}["fr"]
    assert lang["piper"]["tag"] == "fr" and lang["piper"]["setup"]
    assert lang["piper"]["bytes"] == row["bytes"]
    assert voices.page_payload()["offers"]["fr"]["bytes"] == row["bytes"]


def test_one_tap_sets_the_engine_up_and_fetches_nothing_again(
    bare, no_network, monkeypatch
):
    from zimi import importer

    _put_files_here("fr")
    calls = []
    monkeypatch.setattr(importer, "build_venv", _fake_build(calls))
    assert voices.start_download("fr") == (
        True,
        None,
    )  # the old code answered (False, "installed")
    voices._fetcher.join(10)
    assert calls == [list(voices.ENGINE_REQUIREMENTS)]
    assert voices.downloading() == {}
    assert voices.piper_command()
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["fr"]
    assert row["installed"] and not row["needs_setup"]
    assert voices.start_download("fr") == (
        False,
        "installed",
    ), "and now it is simply there"


def test_a_failed_setup_says_why_and_keeps_the_files(bare, no_network, monkeypatch):
    from zimi import importer

    _put_files_here("fr")
    monkeypatch.setattr(importer, "build_venv", _fake_build([], ok=False))
    assert voices.start_download("fr")[0]
    voices._fetcher.join(10)
    assert voices.downloading()["error"] == "fr" and voices.downloading()["reason"]
    assert "fr" in voices.installed()
    assert {r["tag"]: r for r in voices.manage_payload()["voices"]}["fr"]["needs_setup"]


def test_automatically_sets_the_engine_up_on_the_first_word(
    bare, no_network, monkeypatch
):
    from zimi import importer, outbound

    _put_files_here("fr")
    calls = []
    monkeypatch.setattr(importer, "build_venv", _fake_build(calls))
    monkeypatch.setattr(voices.POLICY, "mode", lambda: (outbound.AUTO, False))
    voices._maybe_fetch("fr", "")
    voices._fetcher.join(10)
    assert calls, "Automatically does what the tap does"


def test_a_voice_with_its_engine_is_not_offered_again(data, monkeypatch):
    from test_voices import install

    install("en-US")
    monkeypatch.setattr(voices, "runtime", lambda engine: ["/engine"])
    row = {r["tag"]: r for r in voices.manage_payload()["voices"]}["en-US"]
    assert row["installed"] and not row["needs_setup"]
    assert (
        "en" not in voices.page_payload()["offers"]
        or voices.page_payload()["offers"]["en"]["tag"] != "en-US"
    )
