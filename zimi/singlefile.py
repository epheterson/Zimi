"""``--engine singlefile`` — capture a page with SingleFile.

SingleFile is the reference implementation of the job Zimi's rendered engine
does by hand: drive a real browser, wait for the page to finish becoming
itself, then serialise the whole thing into ONE self-contained HTML file with
every image, stylesheet, font and frame inlined as a data URI.

Why carry it rather than keep hand-rolling. Every serialisation bug this
project hit in one week — splitting a ``srcset`` on a bare comma, failing to
unescape ``&amp;`` before looking an asset up, root-relative URLs escaping the
archive, resource hints left pointing at the open web — is a bug SingleFile
fixed years ago, in the open, with a test. That is not a gap in effort; it is
what a decade of one project doing one thing buys, and the honest move is to
use it.

**How it is used.** As a subprocess, never an import. SingleFile is AGPL-3.0
and Zimi is MIT, so the dependency boundary and the license boundary are the
same boundary — exactly the arrangement already used for warc2zim (GPL) and
zimit (GPL). Nothing of SingleFile is vendored, and Zimi ships none of it.

**What comes back.** One HTML file, self-contained. That is an unusually good
fit for a ZIM page: there are no sibling assets to carry, no paths to rewrite,
and no chance of an asset reference that resolves to nothing — the page cannot
reach outside itself, because there is no outside. It costs size (data URIs are
base64, so roughly a third larger than the bytes they encode) and it is one
entry rather than a browsable tree.

**What it needs.** Node and the ``single-file`` CLI on PATH, plus a Chromium —
the same browser the rendered engine already installs. Absent, the engine
refuses with the two commands that fix it and every other engine is untouched.
"""

import logging
import os
import shutil
import subprocess
import tempfile
import urllib.parse

from zimi.creator import CreateError

log = logging.getLogger("zimi.singlefile")

# The console script npm installs. Checked on PATH rather than shelled through
# a shell, so a machine without it fails as "not installed" and not as a
# confusing non-zero exit.
SINGLEFILE_BIN = "single-file"

INSTALL_HINT = (
    "the singlefile engine needs the SingleFile CLI, which is not installed "
    "here. Install Node, then: npm install -g single-file-cli. It also needs a "
    "Chromium — `playwright install chromium` provides one."
)

# SingleFile drives a browser and waits for the page to settle, so it is slow
# in the same way the rendered engine is slow. Generous, and bounded: a capture
# that has produced nothing after this long is not going to.
DEFAULT_TIMEOUT = 300.0

# Flags Zimi always passes. Everything here is about making the output a good
# ARCHIVE rather than a good screenshot:
#   --browser-wait-until  the page has stopped fetching, not merely parsed
#   --remove-hidden       elements display:none never carried as data URIs
#   --remove-unused-*     the CSS and fonts this page does not actually use
#   --block-scripts       scripts are inert in an archive and are the largest
#                         thing in a modern page; the DOM they produced is
#                         already captured
_BASE_ARGS = (
    "--browser-wait-until=networkidle0",
    "--remove-hidden-elements=true",
    "--remove-unused-styles=true",
    "--remove-unused-fonts=true",
    "--block-scripts=true",
    "--compress-CSS=true",
    "--compress-HTML=true",
)


def singlefile_available():
    """True when the CLI is on PATH. Asked before a job is accepted, so a form
    never offers this engine on a machine that cannot honour it."""
    return shutil.which(SINGLEFILE_BIN) is not None


def singlefile_version():
    """What the CLI calls itself, for the provenance record, or None."""
    exe = shutil.which(SINGLEFILE_BIN)
    if not exe:
        return None
    try:
        p = subprocess.run(
            [exe, "--version"], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = (p.stdout or p.stderr or "").strip()
    return out.splitlines()[0] if out else None



def _check_url(url):
    """Refuse anything that is not a plain http(s) address.

    The URL becomes ARGV. There is no shell here — the command is a list, so
    nothing can be injected as shell syntax — but a value beginning with ``-``
    is read by SingleFile's own parser as a FLAG rather than an address, which
    is a way to reach options Zimi never meant to expose. The source is
    user-supplied: any creator-role account can type it.

    ``create_page_zim`` already checks the scheme before dispatching here, so
    today nothing reaches this that would fail. It is checked again anyway,
    because this function is importable and spawns a process, and a guarantee
    that depends on one caller remembering is not a guarantee."""
    text = str(url or "")
    parts = urllib.parse.urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise CreateError(f"not an http(s) URL: {text[:120]}")
    if text.startswith("-"):
        raise CreateError(f"refusing an address that reads as an option: {text[:120]}")


def capture_page(
    url, *, timeout=DEFAULT_TIMEOUT, note=None, block_ads=True, work_dir=None
):
    """Run SingleFile over ``url`` and return the self-contained HTML.

    Raises ``CreateError`` for everything the person who asked can act on: the
    tool missing, the run failing, or the run "succeeding" while producing
    nothing — which a subprocess is entirely capable of doing, and which must
    never reach the ZIM writer as an empty page.
    """
    say = note or (lambda _m: None)
    _check_url(url)
    exe = shutil.which(SINGLEFILE_BIN)
    if not exe:
        raise CreateError(INSTALL_HINT)

    workdir = tempfile.mkdtemp(prefix=".zimi-singlefile-", dir=work_dir)
    out_path = os.path.join(workdir, "page.html")
    cmd = [exe, url, out_path, *_BASE_ARGS]
    if block_ads:
        # SingleFile's own blocker, so this engine honours the same capture
        # default as the others rather than quietly ignoring it.
        cmd.append("--block-images=false")
        cmd.append("--load-deferred-images=true")

    say("capturing with SingleFile…")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        shutil.rmtree(workdir, ignore_errors=True)
        raise CreateError(
            f"SingleFile did not finish {url} within {int(timeout)}s. The page "
            f"may never stop loading; try the rendered engine, which stops "
            f"waiting on its own."
        )
    except OSError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise CreateError(f"could not run {SINGLEFILE_BIN}: {e}")

    try:
        if proc.returncode != 0:
            # The tool's own last line is the part a person can act on; the
            # rest is a Node stack. Never the whole thing.
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()
            reason = tail[-1][:200] if tail else "it gave no reason"
            log.warning(
                "single-file exited %s for %s: %s", proc.returncode, url, reason
            )
            raise CreateError(f"SingleFile could not capture {url} — {reason}")
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise CreateError(
                f"SingleFile reported success for {url} and wrote nothing. "
                f"Nothing was added to the library."
            )
        with open(out_path, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    say(f"SingleFile captured {len(html.encode('utf-8')) // 1024} KB, self-contained")
    return html


class SingleFileCapture:
    """The engine contract, satisfied by a tool that returns one document.

    ``fetch`` runs SingleFile and hands back its self-contained HTML in place
    of the page a normal engine would have downloaded. ``render`` then has
    nothing left to do — no assets to carry, no references to rewrite — which
    is the whole point of this engine and the reason it cannot produce a
    dangling reference the way a rewriting engine can.

    Accepts the shared option set like every other engine so one construction
    call serves them all. ``block_ads`` is honoured (SingleFile has its own
    blocker); a byte budget is not, because there is one file and its size is
    known only once it exists.
    """

    def __init__(self, *, note=None, block_ads=None, work_dir=None, timeout=DEFAULT_TIMEOUT):
        self._note = note or (lambda _m: None)
        self._block_ads = True if block_ads is None else bool(block_ads)
        self._work_dir = work_dir
        self._timeout = timeout
        # The shared reporting surface every engine exposes to the writer.
        self.carried = {}
        self.mimetypes = set()
        self.count = 0

    # A page built in JavaScript is the case this engine is FOR: SingleFile
    # drives a real browser and serialises what it drew, so an empty shell in
    # the markup is not a reason to refuse.
    refuses_spa = False

    # What the provenance record calls this capture.
    name = "singlefile"

    def start(self):
        return self

    def close(self):
        pass

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.close()

    @property
    def tools(self):
        """``{name: version}`` — the outside programs that made this capture.

        Named in the ZIM's provenance so a reader can tell a SingleFile capture
        from a rendered one after the fact. The two write otherwise identical
        metadata, and "which tool drew this page" is exactly the question worth
        being able to answer in five years."""
        version = singlefile_version()
        return {"single-file": version} if version else {"single-file": "unknown"}

    def fetch(self, url):
        """``(final_url, html, nbytes, content_language)`` — the engine
        contract. SingleFile does not report a redirect chain, so the URL asked
        for is the URL recorded; the document itself carries its own language."""
        html = capture_page(
            url,
            timeout=self._timeout,
            note=self._note,
            block_ads=self._block_ads,
            work_dir=self._work_dir,
        )
        return url, html, len(html.encode("utf-8", errors="replace")), ""

    def render(self, target, html, final_url, resolve_link=None):
        """Nothing to carry. The document already holds everything it needs.

        Returned unchanged rather than passed through a rewriter: every asset
        is a data: URI inside this HTML, and a rewriter that went looking for
        references to fix would find only the ones SingleFile deliberately left
        external — the links to other pages, which belong external."""
        return html
