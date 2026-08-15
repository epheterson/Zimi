#!/usr/bin/env python3
"""Write the four ZIMs the About-this-ZIM Playwright spec reads.

One library that covers every case the panel and the badges have to get right:

  handbook.zim        a site capture with a full provenance history — an
                      overflow marker, a creation record carrying counts AND
                      the blocked-ads object, and a later edit naming its tool
  newsroom_alive.zim  a replay ZIM: no history at all, the zimi:alive tag and
                      the warc2zim Scraper are its whole provenance
  notes.zim           a plain folder capture, one creation record
  found.zim           shaped like a ZIM somebody else published — no Zimi
                      metadata anywhere, so it must get no badge and no history

Usage:  python3 tests/make_about_fixtures.py <zim-dir>
"""

import json
import os
import sys
import time

from libzim.writer import Blob, ContentProvider, Creator, Hint, Item

DAY = 86400
NOW = int(time.time())


class _Provider(ContentProvider):
    def __init__(self, content):
        super().__init__()
        self.content = content
        self._fed = False

    def get_size(self):
        return len(self.content)

    def feed(self):
        if self._fed:
            return Blob(b"")
        self._fed = True
        return Blob(self.content)


class _Article(Item):
    def __init__(self, path, title, html):
        super().__init__()
        self._path, self._title, self._html = path, title, html

    def get_path(self):
        return self._path

    def get_title(self):
        return self._title

    def get_mimetype(self):
        return "text/html"

    def get_contentprovider(self):
        return _Provider(self._html.encode())

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: True}


def write_zim(path, metadata, pages):
    if os.path.exists(path):
        os.remove(path)
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath(pages[0][0])
        for key, value in metadata.items():
            creator.add_metadata(key, value)
        for entry in pages:
            creator.add_item(_Article(*entry))


def page(title, body):
    return f"<html><head><title>{title}</title></head><body><h1>{title}</h1><p>{body}</p></body></html>"


SITE_HISTORY = [
    {
        "ts": NOW - 12 * DAY,
        "zimi": "1.9.0",
        "op": "truncated",
        "mode": "history",
        "detail": "3 earlier records collapsed to keep this history bounded",
        "counts": {"records": 3},
    },
    {
        "ts": NOW - 9 * DAY,
        "zimi": "1.9.0",
        "op": "created",
        "mode": "site",
        "detail": (
            "captured 148 pages from https://handbook.example.org "
            "with 214 ad/tracker requests blocked"
        ),
        "counts": {"pages": 148, "assets": 902, "bytes": 48213774},
        "blocked": {
            "requests": 214,
            "domains": 37,
            "list": "stevenblack-hosts",
            "snapshot": "2026-07-01",
            "override": True,
        },
    },
    {
        "ts": NOW - 2 * DAY,
        "zimi": "1.9.0",
        "op": "edited",
        "mode": "site",
        "detail": "removed 4 pages and rewrote the index",
        "counts": {"pages": 144},
        "tools": {"chromium": "138.0.7204.94"},
    },
]

FOLDER_HISTORY = [
    {
        "ts": NOW - 1 * DAY,
        "zimi": "1.9.0",
        "op": "created",
        "mode": "folder",
        "detail": 'packaged the folder "field-notes" — 3 pages and 1 file',
        "counts": {"pages": 3, "assets": 1, "bytes": 20418},
    }
]


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)

    write_zim(
        os.path.join(out, "handbook.zim"),
        {
            "Title": "Field Handbook",
            "Description": "148 pages captured from handbook.example.org by Zimi",
            "LongDescription": (
                "A working capture of the public field handbook, taken so the whole "
                "thing reads offline. Images and stylesheets are included; the search "
                "box on the original site is not, because it queried a server."
            ),
            "Language": "eng",
            "Date": "2026-08-05",
            "Creator": "Zimi",
            "Publisher": "Zimi",
            "Name": "zimi_eng_handbook_example_org",
            "Source": "https://handbook.example.org/",
            "X-Zimi-Source": "https://handbook.example.org/",
            "Scraper": "Zimi 1.9.0",
            "Tags": "_category:other;_ftindex:yes;_pictures:yes;_videos:no",
            "X-Zimi-History": json.dumps(SITE_HISTORY),
        },
        [
            (
                "index.html",
                "Field Handbook",
                page("Field Handbook", "Water, fire, shelter."),
            ),
            ("water.html", "Water", page("Water", "Boil it.")),
        ],
    )

    write_zim(
        os.path.join(out, "newsroom_alive.zim"),
        {
            "Title": "Newsroom (replay)",
            "Description": "A recorded browsing session, replayable offline",
            "Language": "eng",
            "Date": "2026-08-11",
            "Creator": "Zimi",
            "Publisher": "Zimi",
            "Name": "zimi_eng_newsroom_example_com",
            "Source": "https://newsroom.example.com/",
            "Scraper": "warc2zim 2.2.0 + Zimi 1.9.0",
            "Tags": "_ftindex:yes;_category:other;zimi:alive",
        },
        [("index.html", "Newsroom", page("Newsroom", "Replay shell."))],
    )

    write_zim(
        os.path.join(out, "notes.zim"),
        {
            "Title": "Field Notes",
            "Description": "3 pages and 1 file packaged by Zimi",
            "Language": "eng",
            "Date": "2026-08-13",
            "Creator": "Zimi",
            "Publisher": "Zimi",
            "Name": "zimi_eng_field_notes",
            "X-Zimi-Source": "field-notes",
            "Scraper": "Zimi 1.9.0",
            "Tags": "_category:other;_ftindex:yes",
            "X-Zimi-History": json.dumps(FOLDER_HISTORY),
        },
        [
            (
                "index.html",
                "Field Notes",
                page("Field Notes", "Everything worth keeping."),
            )
        ],
    )

    write_zim(
        os.path.join(out, "found.zim"),
        {
            "Title": "Lit Docs",
            "Description": "Lit documentation, by DevDocs",
            "Language": "eng",
            "Date": "2026-07-06",
            "Creator": "DevDocs",
            "Publisher": "openZIM",
            "Name": "devdocs_en_lit",
            "Scraper": "devdocs2zim v0.2.1",
            "Tags": "devdocs;lit",
        },
        [("index.html", "Lit Docs", page("Lit Docs", "Reactive templates."))],
    )

    print("wrote 4 fixture ZIMs into", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
