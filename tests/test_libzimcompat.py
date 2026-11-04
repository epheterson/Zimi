"""libzimcompat tells libzim 3.x from 4.x even without package metadata."""

import os
import sys
import types
from importlib import metadata

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import libzimcompat  # noqa: E402


def _no_metadata(name):
    raise metadata.PackageNotFoundError(name)


def _reader_with(monkeypatch, **attrs):
    reader = types.ModuleType("libzim.reader")
    reader.Archive = type("Archive", (), attrs)
    monkeypatch.setitem(sys.modules, "libzim.reader", reader)


def test_a_bundle_without_metadata_still_knows_libzim_4(monkeypatch):
    monkeypatch.setattr(metadata, "version", _no_metadata)
    _reader_with(monkeypatch, get_entry_by_id=lambda self, i: None)
    assert libzimcompat._libzim_major() == 4


def test_a_bundle_without_metadata_still_knows_libzim_3(monkeypatch):
    monkeypatch.setattr(metadata, "version", _no_metadata)
    _reader_with(monkeypatch, _get_entry_by_id=lambda self, i: None)
    assert libzimcompat._libzim_major() == 3
