import functools, http.server, os, threading, sys, json
from playwright.sync_api import sync_playwright

GAMES = os.path.abspath(os.environ.get("GAMES_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "zimi", "builtin", "games"))
SHOTS = os.path.expanduser(os.environ.get("SHOTS_DIR", "/tmp/zimi-games-bot-shots"))
os.makedirs(SHOTS, exist_ok=True)


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

    h = functools.partial(Quiet, directory=GAMES)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d/" % srv.server_address[1]


class Run:
    def __init__(self):
        self.srv, self.site = serve()
        self.p = sync_playwright().start()
        self.b = self.p.chromium.launch()

    def ctx(self, w=390, h=844, dark=False, locale="en-US"):
        c = self.b.new_context(
            viewport={"width": w, "height": h},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
            color_scheme="dark" if dark else "light",
            locale=locale,
        )
        pg = c.new_page()
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        return c, pg

    def close(self):
        self.b.close()
        self.p.stop()
        self.srv.shutdown()


def settle(pg, ms=1800):
    pg.wait_for_timeout(ms)
