"""Readiness waits for the games' browser tests: every wait is on a state the page reaches, never on a stretch of time.

A loaded CI machine runs the same page slower, so a fixed sleep is either wasted or too short. These wait on the
shell's own ready class, on a game's exposed value, on an element, or on the event loop having turned.
"""

SHELL_READY = "document.documentElement.classList.contains('gs-ready')"
WAIT_MS = 60000   # a ceiling for a loaded machine, not a pause: every wait returns the moment its condition holds


def truthy(expr):
    """A page function that is true once `expr` evaluates without throwing to something truthy (the game is up)."""
    return "() => { try { return !!(" + expr + "); } catch (e) { return false; } }"


def shell_ready(page, timeout=WAIT_MS):
    """The shell has built the bar (the page is a game and its own script has run to the end)."""
    page.wait_for_function("() => " + SHELL_READY, timeout=timeout)


def game_ready(page, expr=None, timeout=WAIT_MS):
    """The shell is ready, the cards are not still flying out (a tap during the deal is ignored) and, if given, the game's own `expr` (its exposed state) is truthy."""
    shell_ready(page, timeout)
    page.wait_for_function("() => !document.querySelector('.zc-dealing')", timeout=timeout)
    if expr:
        page.wait_for_function(truthy(expr), timeout=timeout)


def frames(page, n=2):
    """Let the page's event loop turn n animation frames: what a handler painted, or posted to a timer, has landed."""
    page.evaluate("n => new Promise(r => { const f = k => k ? requestAnimationFrame(() => f(k - 1)) : r(); f(n); })", n)


def settled(page, expr, quiet=8, timeout=WAIT_MS):
    """`expr`'s value has not changed for `quiet` animation frames in a row (a paused or finished position, a reply that has landed)."""
    page.wait_for_function(
        """([expr, quiet]) => {
            let v; try { v = String((0, eval)(expr)); } catch (e) { v = null; }
            const w = window;
            if (v !== null && v === w.__settledValue) w.__settledRun += 1; else { w.__settledValue = v; w.__settledRun = 0; }
            return w.__settledRun >= quiet;
        }""",
        arg=[expr, quiet], polling="raf", timeout=timeout)


def visible(page, selector, timeout=WAIT_MS):
    """The first match of `selector` is on screen."""
    page.locator(selector).first.wait_for(state="visible", timeout=timeout)


def becomes(page, expr, expected, timeout=WAIT_MS):
    """`expr` reads as `expected` (a restored position coming back): the wait ends the moment it does, and the caller's assert reports a miss."""
    try:
        page.wait_for_function(
            "([expr, expected]) => { try { return String((0, eval)(expr)) === expected; } catch (e) { return false; } }",
            arg=[expr, expected], timeout=timeout)
    except Exception:
        pass   # fall through: the caller's own assert shows what the page holds instead


def shows(page, selector, text, timeout=WAIT_MS):
    """The first match of `selector` says `text` (a message, a score line) and the page has turned a frame since."""
    page.wait_for_function(
        "([sel, text]) => { const e = document.querySelector(sel); return !!e && (e.textContent || '').includes(text); }",
        arg=[selector, text], timeout=timeout)
    frames(page, 1)


def savable(page, timeout=WAIT_MS):
    """The game has a position worth keeping: saving now writes something (a move was made, a deal was begun)."""
    page.wait_for_function("() => { ZimiShell.saveNow(); return ZimiShell.saved() !== null; }", timeout=timeout)


# Counts the timeouts a page has set and not yet run: a computer's reply, a sowing, a flip, a deal are all timeouts, so "none
# pending" is the page saying its table has stopped moving. Install it on the context before the page loads.
PENDING_TIMERS_JS = """(() => {
  const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window), live = new Set();
  window.__pendingTimers = () => live.size;
  window.setTimeout = (fn, ms, ...args) => {
    if (typeof fn !== 'function') return set(fn, ms, ...args);
    const id = set(() => { live.delete(id); fn(...args); }, ms);
    live.add(id); return id;
  };
  window.clearTimeout = id => { live.delete(id); clear(id); };
})();"""


def timers_idle(page, frames_quiet=3, timeout=WAIT_MS):
    """No timeout is pending for `frames_quiet` animation frames in a row (needs PENDING_TIMERS_JS on the context)."""
    page.wait_for_function(
        """quiet => {
            const w = window;
            if (w.__pendingTimers && w.__pendingTimers() === 0) w.__idleRun = (w.__idleRun || 0) + 1; else w.__idleRun = 0;
            return w.__idleRun >= quiet;
        }""", arg=frames_quiet, polling="raf", timeout=timeout)


def wait_for_server(port, timeout_s=240):
    """Poll the fixture Zimi's /health until it answers, then touch what the games ask first (the library list and a random word), so the first page does not pay for a cold start on a loaded machine. False if it never came up."""
    import time
    import urllib.request

    base = "http://127.0.0.1:%d" % port
    end = time.monotonic() + timeout_s
    up = False
    while time.monotonic() < end and not up:
        try:
            urllib.request.urlopen(base + "/health", timeout=10).read()
            up = True
        except Exception:
            time.sleep(0.5)
    if not up:
        return False
    for path in ("/list", "/dictionary/random?langs=en", "/dictionary/random?langs=fr"):
        try:
            urllib.request.urlopen(base + path, timeout=60).read()
        except Exception:
            pass   # a warm-up only: a path that is not there is the test's own business
    return True


def watch(page, selector):
    """Start recording every text `selector` takes from now on (a status line that clears itself after a couple of seconds)."""
    page.evaluate(
        """sel => {
            window.__seen = [];
            const note = () => { const e = document.querySelector(sel); if (e) window.__seen.push(e.textContent || ''); };
            if (window.__seenObserver) window.__seenObserver.disconnect();
            window.__seenObserver = new MutationObserver(note);
            window.__seenObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
            note();
        }""", selector)


def seen(page, text, timeout=WAIT_MS):
    """The watched element said `text` at some point since `watch`, even if it has cleared since."""
    page.wait_for_function("text => (window.__seen || []).some(t => t.includes(text))", arg=text, timeout=timeout)
