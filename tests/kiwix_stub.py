"""A stand-in for kiwix-serve, for the games' tests: the routes libkiwix's server has that the library games use, over real ZIMs.

    GET /catalog/v2/entries           the OPDS catalog (Atom): <entry><name>, <title>, <language>, <articleCount>
    GET /random?content=<book>        a 302 to /content/<book>/<path> of a random article
    GET /suggest?content=&term=       JSON [{value, label, path}] of titles that start with term
    GET /content/<book>/<path>        the ZIM's item, with Range; /content/<book> redirects to its main page
    GET /content/games/<file>         the games folder as one more book, so a page runs same-origin with the API as in a ZIM

The routes and answers follow libkiwix (src/server/internalServer.cpp, static/templates/catalog_v2_entry.xml); this is not
kiwix-serve, and the kiwix mode of ZimiGames has not been run against the real one.

    serve(zim_dir, games_dir) -> (server, "http://127.0.0.1:port")
"""

import html
import http.server
import json
import mimetypes
import os
import threading
from urllib.parse import parse_qs, quote, unquote, urlparse

from libzim.reader import Archive


class _Handler(http.server.BaseHTTPRequestHandler):
    books = {}  # name -> (Archive, language, title)
    games = ""

    def log_message(self, *a, **k):
        pass

    def _send(self, code, body=b"", ctype="text/plain", extra=None, head=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _bytes(self, data, ctype, head):
        """A body with Range, as kiwix-serve gives it."""
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes=") and not head:
            a, _, b = rng[6:].partition("-")
            start = int(a or 0)
            end = min(int(b) if b else len(data) - 1, len(data) - 1)
            return self._send(
                206,
                data[start : end + 1],
                ctype,
                {"Content-Range": "bytes %d-%d/%d" % (start, end, len(data))},
            )
        return self._send(200, data, ctype, head=head)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        u = urlparse(self.path)
        path, qs = unquote(u.path), parse_qs(u.query)
        if path == "/catalog/v2/entries":
            entries = "".join(
                "<entry><name>%s</name><title>%s</title><language>%s</language><articleCount>%d</articleCount>"
                '<link type="text/html" href="/content/%s"/></entry>'
                % (n, html.escape(t), lang, a.entry_count, n)
                for n, (a, lang, t) in self.books.items()
            )
            return self._send(
                200,
                (
                    '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">%s</feed>'
                    % entries
                ).encode(),
                "application/atom+xml",
                head=head,
            )
        if path == "/random":
            name = (qs.get("content") or [""])[0]
            if name not in self.books:
                return self._send(404, head=head)
            arc = self.books[name][0]
            for _ in range(20):
                e = arc.get_random_entry()
                if e.is_redirect:
                    e = e.get_redirect_entry()
                if e.get_item().mimetype == "text/html":
                    break
            return self._send(
                302,
                b"",
                extra={"Location": "/content/%s/%s" % (name, quote(e.path))},
                head=head,
            )
        if path == "/suggest":
            name = (qs.get("content") or [""])[0]
            term = (qs.get("term") or [""])[0].lower()
            count = int((qs.get("count") or ["10"])[0])
            out = []
            if name in self.books:
                arc = self.books[name][0]
                for i in range(arc.entry_count):
                    e = arc._get_entry_by_id(i)
                    if e.title.lower().startswith(term):
                        out.append({"value": e.title, "label": e.title, "kind": "path", "path": e.path})
                    if len(out) >= count:
                        break
            return self._send(200, json.dumps(out).encode(), "application/json", head=head)
        if path.startswith("/content/"):
            name, _, rest = path[len("/content/") :].partition("/")
            if name == "games":
                f = os.path.normpath(os.path.join(self.games, rest))
                if not f.startswith(self.games) or not os.path.isfile(f):
                    return self._send(404, head=head)
                with open(f, "rb") as fh:
                    return self._bytes(
                        fh.read(),
                        mimetypes.guess_type(f)[0] or "application/octet-stream",
                        head,
                    )
            if name not in self.books:
                return self._send(404, head=head)
            arc = self.books[name][0]
            if not rest:
                return self._send(
                    302,
                    b"",
                    extra={
                        "Location": "/content/%s/%s"
                        % (
                            name,
                            quote(
                                arc.main_entry.get_redirect_entry().path
                                if arc.main_entry.is_redirect
                                else arc.main_entry.path
                            ),
                        )
                    },
                    head=head,
                )
            try:
                e = arc.get_entry_by_path(rest)
            except KeyError:
                return self._send(404, head=head)
            if e.is_redirect:
                e = e.get_redirect_entry()
            item = e.get_item()
            return self._bytes(bytes(item.content), item.mimetype, head)
        return self._send(404, head=head)


def serve(zim_dir, games_dir):
    books = {}
    for f in sorted(os.listdir(zim_dir)):
        if f.endswith(".zim"):
            arc = Archive(os.path.join(zim_dir, f))
            meta = {
                k: bytes(arc.get_metadata(k)).decode("utf-8", "replace")
                for k in arc.metadata_keys
                if k in ("Name", "Language", "Title")
            }
            books[meta.get("Name") or f[:-4]] = (
                arc,
                meta.get("Language", "eng"),
                meta.get("Title", f),
            )
    handler = type(
        "Handler", (_Handler,), {"books": books, "games": os.path.abspath(games_dir)}
    )
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]
