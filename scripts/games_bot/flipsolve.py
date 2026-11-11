"""flipsolve.py ID: Flip (crosses), read the lit squares off the canvas, find the taps (2^9 tries), tap them by touch, report."""

import functools, http.server, itertools, json, os, sys, threading
from playwright.sync_api import sync_playwright

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "zimi", "builtin", "games")
gid = sys.argv[1]
W = H = 3


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0), functools.partial(Q, directory=root)
)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
BOARD = (71.5, 152.5, 83.0)  # left, top, cell (css px, 390x844, measured)
PIX = """([x, y]) => { const c = document.querySelector('canvas'), r = c.getBoundingClientRect(), k = c.width / r.width;
  const d = c.getContext('2d').getImageData(Math.round((x - r.x) * k), Math.round((y - r.y) * k), 1, 1).data; return d[0] + d[1] + d[2]; }"""
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(
        viewport={"width": 390, "height": 844},
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
        reduced_motion="reduce",
    )
    pg = ctx.new_page()
    pg.goto("%s/puzzles/flip.html#%s" % (base, gid))
    pg.wait_for_timeout(3000)
    pos = lambda c, r: (
        BOARD[0] + BOARD[2] * (c + 0.2),
        BOARD[1] + BOARD[2] * (r + 0.2),
    )
    lit = [
        [pg.evaluate(PIX, list(pos(c, r))) > 450 for c in range(W)] for r in range(H)
    ]
    print("lit", lit)

    def effect(tc, tr):
        return {
            (c, r) for c in range(W) for r in range(H) if abs(c - tc) + abs(r - tr) <= 1
        }

    cells = [(c, r) for r in range(H) for c in range(W)]
    for mask in itertools.product([0, 1], repeat=len(cells)):
        state = {k: lit[k[1]][k[0]] for k in cells}
        for on, (tc, tr) in zip(mask, cells):
            if on:
                for k in effect(tc, tr):
                    state[k] = not state[k]
        if all(state.values()):
            taps = [cells[i] for i, on in enumerate(mask) if on]
            break
    print("taps", taps)
    for c, r in taps:
        x, y = BOARD[0] + BOARD[2] * (c + 0.5), BOARD[1] + BOARD[2] * (r + 0.5)
        pg.touchscreen.tap(x, y)
        pg.wait_for_timeout(300)
    pg.wait_for_timeout(2500)
    print(
        "end",
        json.dumps(
            pg.evaluate(
                "() => ({status: document.getElementById('statusbar').textContent, sheet: !!document.querySelector('.ar-sheet:not([hidden])'), t: (document.querySelector('.ar-sheet:not([hidden])')||{innerText:''}).innerText})"
            )
        ),
    )
    pg.screenshot(path=os.path.join(os.environ.get("SHOTS_DIR", "/tmp"), "flip_solved.png"))
    pg.get_by_role("button", name="New game").first.click()
    pg.wait_for_timeout(2500)
    print(
        "new",
        json.dumps(
            pg.evaluate(
                "() => ({status: document.getElementById('statusbar').textContent, sheet: !!document.querySelector('.ar-sheet:not([hidden])')})"
            )
        ),
    )
    pg.screenshot(path=os.path.join(os.environ.get("SHOTS_DIR", "/tmp"), "flip_new.png"))
    b.close()
srv.shutdown()
