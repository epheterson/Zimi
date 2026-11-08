"""Write a tiny real ZIM for the portable smoke test: python ci/make_test_zim.py <out.zim>."""

import sys

from libzim.writer import Creator, Hint, Item, StringProvider


class Page(Item):
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
        return StringProvider(self._html)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: True}


with Creator(sys.argv[1]).config_indexing(True, "eng") as zim:
    zim.set_mainpath("home")
    for key, value in (("Title", "Smoke"), ("Language", "eng"), ("Creator", "ci"), ("Publisher", "ci"),
                       ("Name", "smoke_en_all"), ("Description", "portable smoke test")):
        zim.add_metadata(key, value)
    zim.add_item(Page("home", "Home", "<html><body><h1>Home</h1><p>Portable Zimi reads this.</p></body></html>"))
