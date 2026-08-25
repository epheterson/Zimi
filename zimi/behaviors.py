"""browsertrix-behaviors — making a page reveal what it is hiding.

Zimi's own ``_lazy_scroll`` is a loop: scroll a screen, wait, repeat. That is
enough for a page that lazy-loads on scroll and useless for everything else the
modern web does — a feed that only loads on intersection, a gallery behind a
"show more", a video that has to be told to play, a thread that expands one
reply at a time.

Webrecorder's behaviors are a CATALOGUE of that knowledge: per-site scripts for
the sites everybody archives, plus a generic autoscroll that is better than
ours. It is real domain expertise accumulated over years of archiving, and it
is the single thing our capture engines most obviously lack.

**Not shipped, only used.** The bundle is AGPL-3.0 and Zimi is MIT, so Zimi
neither vendors it nor installs it: it looks for a copy the operator installed,
uses it when it is there, and falls back to the plain scroll when it is not.
Same arrangement as warc2zim, zimit and SingleFile — the dependency boundary
and the license boundary are the same boundary — with one extra wrinkle worth
naming, which is that this code runs INSIDE the captured page rather than
beside Zimi. That makes the fallback load-bearing rather than polite: a capture
must never depend on a file Zimi is not allowed to distribute.

Install it with::

    npm install -g browsertrix-behaviors

or point ``ZIMI_BEHAVIORS`` at a ``behaviors.js`` anywhere on disk.
"""

import logging
import os
import shutil

log = logging.getLogger("zimi.behaviors")

#: Where an npm install leaves the bundle, in the order worth trying. The env
#: var wins so an operator can pin a version or use a checkout.
_ENV_VAR = "ZIMI_BEHAVIORS"
_REL_PATH = os.path.join("browsertrix-behaviors", "dist", "behaviors.js")
_NODE_ROOTS = (
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
)

# How long the behaviors are allowed to run on one page before the capture
# moves on. They are DESIGNED to keep going — an infinite feed has no end — so
# this is not a safety net, it is the actual stop condition.
DEFAULT_RUN_SECONDS = 45.0

_cached: list = [None]  # (path, source) once read; ('', '') once known absent


def behaviors_path():
    """Where the bundle is, or ''. Checks the env var, then npm's global roots,
    then whatever ``npm root -g`` reports for an unusual install."""
    override = os.environ.get(_ENV_VAR, "").strip()
    if override:
        return override if os.path.isfile(override) else ""
    for root in _NODE_ROOTS:
        candidate = os.path.join(root, _REL_PATH)
        if os.path.isfile(candidate):
            return candidate
    npm = shutil.which("npm")
    if npm:
        import subprocess

        try:
            p = subprocess.run(
                [npm, "root", "-g"], capture_output=True, text=True, timeout=20
            )
            root = (p.stdout or "").strip()
            if root:
                candidate = os.path.join(root, _REL_PATH)
                if os.path.isfile(candidate):
                    return candidate
        except (OSError, subprocess.SubprocessError):
            pass
    return ""


def behaviors_available():
    """True when a bundle can be found. Cheap after the first call."""
    return bool(behaviors_source())


def behaviors_source():
    """The bundle's JavaScript, or ''. Read once per process — it is 56KB and
    a crawl would otherwise read it once per page."""
    if _cached[0] is None:
        path = behaviors_path()
        if not path:
            _cached[0] = ("", "")
        else:
            try:
                with open(path, encoding="utf-8") as f:
                    _cached[0] = (path, f.read())
                log.info("using browsertrix-behaviors from %s", path)
            except OSError as e:
                log.debug("could not read %s: %s", path, e)
                _cached[0] = ("", "")
    return _cached[0][1]


def behaviors_version():
    """The installed version, for the provenance record, or None."""
    path = behaviors_path()
    if not path:
        return None
    import json

    pkg = os.path.join(os.path.dirname(os.path.dirname(path)), "package.json")
    try:
        with open(pkg, encoding="utf-8") as f:
            return json.load(f).get("version") or None
    except (OSError, ValueError):
        return None


def reset():
    """Forget the cached bundle. For tests, and for an operator who installs it
    while the server is running."""
    _cached[0] = None


# Run every behavior the catalogue has for this page, then stop.
#
# `init` takes its options as an object; `run` returns a promise that resolves
# when the behaviors are done — which for an infinite feed is never, hence the
# race against a timer. Losing that race is a normal outcome and not an error:
# the page has still been made to reveal whatever it managed in the time given.
RUN_JS = """(seconds) => new Promise((done) => {
  const finish = (how) => done(how);
  try {
    if (!self.__bx_behaviors) return finish('not-loaded');
    self.__bx_behaviors.init({
      autofetch: true,      // pull the images a behavior reveals
      autoplay: false,      // a captured video is a file, not a performance
      autoscroll: true,     // the generic behavior, better than a plain loop
      siteSpecific: true,   // the whole reason this is here
      timeout: seconds * 1000,
    });
    const timer = setTimeout(() => finish('timeout'), seconds * 1000);
    Promise.resolve(self.__bx_behaviors.run())
      .then(() => { clearTimeout(timer); finish('done'); })
      .catch(() => { clearTimeout(timer); finish('error'); });
  } catch (e) {
    finish('error');
  }
})"""
