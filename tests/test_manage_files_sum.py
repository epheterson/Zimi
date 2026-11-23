"""The cache rows of Manage > Server say "N files, size" through the translated string, never in hard-coded English."""

import json
import os

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static")


def test_cache_rows_use_the_translated_files_sum():
    with open(os.path.join(STATIC, "manage.js"), encoding="utf-8") as f:
        src = f.read()
    assert "' files, '" not in src
    for lang in ("en", "de", "fr", "es"):
        path = os.path.join(STATIC, "i18n", lang + ".json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                assert "{n}" in json.load(f)["older_copies_sum"], lang
