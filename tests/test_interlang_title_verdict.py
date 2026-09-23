"""A same-title article in another language is offered only when it is the one.

Found on the NAS library: English "Water" offered French "Water" (a
disambiguation page) and Spanish "Water", which redirects to "Inodoro";
French "Eau" offered English "Tetrahedral symmetry". The title fallback took
any same-titled page whose Q-ID it could not read, and cached the guess under
the source's Q-ID, where it read as verified from then on.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.interlang import _title_match_verdict  # noqa: E402


def test_a_matching_qid_verifies():
    assert _title_match_verdict("Q283", "Q283", via_redirect=True) == "verified"


def test_a_different_qid_is_not_offered():
    assert _title_match_verdict("Q283", "Q1", via_redirect=False) is None


def test_no_qid_on_the_other_side_proves_nothing():
    assert _title_match_verdict("Q283", None, via_redirect=False) is None


def test_without_qids_a_same_title_is_not_offered():
    """German "Eau" for French Eau: a title is not a match."""
    assert _title_match_verdict(None, None, via_redirect=False) is None
    assert _title_match_verdict(None, None, via_redirect=True) is None


def test_an_inline_cross_wiki_link_is_not_a_language_link():
    from zimi.interlang import _is_interlanguage_link

    inline = 'la symetrie <a href="https://en.wikipedia.org/wiki/Tetrahedral_symmetry" class="extiw external">(en)</a>'
    own = '<li><a href="https://de.wikipedia.org/wiki/Wasser" class="interlanguage-link-target" hreflang="de">Deutsch</a></li>'
    assert not _is_interlanguage_link(inline, inline.index("href"))
    assert _is_interlanguage_link(own, own.index("href"))


def test_a_cache_from_before_the_fix_is_emptied_once(tmp_path, monkeypatch):
    import sqlite3

    from zimi import interlang

    db = tmp_path / "_qid_cache.db"
    old = sqlite3.connect(db)
    old.execute("CREATE TABLE qid_cache (zim TEXT, path TEXT, qid INTEGER, PRIMARY KEY(zim, path))")
    old.execute("INSERT INTO qid_cache VALUES ('wikipedia_es', 'Inodoro', 283)")
    old.commit()
    old.close()
    monkeypatch.setattr(interlang, "_qid_cache_path", lambda: str(db))
    monkeypatch.setattr(interlang, "_qid_index_dir", lambda: str(tmp_path))
    monkeypatch.setattr(interlang, "_qid_cache_conn", None)
    assert interlang._qid_cache_lookup("wikipedia_es", "Inodoro") is None
    interlang._qid_cache_store("wikipedia_es", "Agua", 283)
    monkeypatch.setattr(interlang, "_qid_cache_conn", None)  # a later start
    assert interlang._qid_cache_lookup("wikipedia_es", "Agua") == 283
