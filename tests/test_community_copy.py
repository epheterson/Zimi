"""Community's words, in every language: the subtitle says who made the ZIMs (users, in Kiwix's catalog), and Zimi has
no category of its own (its ZIMs are Community rows)."""

import glob
import json
import os

I18N = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "static",
    "i18n",
)


def _all():
    return {
        os.path.basename(f)[:-5]: json.load(open(f, encoding="utf-8"))
        for f in glob.glob(os.path.join(I18N, "*.json"))
    }


def test_the_community_subtitle_says_users_contributed_it_to_the_kiwix_catalog():
    langs = _all()
    assert len(langs) == 10
    assert (
        langs["en"]["cat_community_desc"] == "Contributed by users to the Kiwix catalog"
    )
    for code, d in langs.items():
        assert "Kiwix" in d["cat_community_desc"], code
        assert "openZIM" not in d["cat_community_desc"], code


def test_there_is_no_zimi_category():
    for code, d in _all().items():
        assert "cat_zimi" not in d and "cat_zimi_desc" not in d, code
