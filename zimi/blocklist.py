"""What a capture refuses to fetch — the ad and tracker list, and the matcher.

Eric captured cnn.com with the alive engine, and what replayed was CNN's own
loading spinner, forever. Nothing was broken: the page's bootstrap gates its
render on a consent-management call and a pile of advertising endpoints, and a
recording is the one thing that can never answer them. The site sat waiting for
a network that had stopped existing.

Blocking that class of request AT CAPTURE TIME is the fix, and it is the same
fix for three separate problems:

  * A page that gates its own content on such an endpoint has a better chance
    of rendering, because a blocked request fails FAST and with a reason — an
    error a script has a branch for — where a request nothing can answer hangs
    until it times out and leaves the page still waiting.
  * The capture is smaller. Measured on cnn.com at the time this was built: an
    alive capture went from 17.6MB to 10.3MB, 41% off, for a page that looked
    the same afterwards. Nobody wants a permanent offline copy of a tracking
    pixel.
  * What a capture MEANS gets narrower and more honest: this is the page, not
    the page plus everybody who was watching you read it.

Honesty about the first bullet, since it is the one that motivated this: the
spinner was reproduced before the work and NOT after — but neither was it
reproduced by the unblocked control captured alongside the blocked one, twice,
on the day this shipped. So the size win and the narrower capture are measured,
and "it fixes the spinner" is a mechanism this makes possible rather than a
result this proved.

WHERE THE MATCHING HAPPENS. Blocking is a property of the BROWSER engines
(``zimi.renderer``, and therefore ``zimi.alive``, which records through the same
session): a Playwright route handler aborts a matching request before it is
made, so the alive recorder never sees it and the snapshot engine never carries
it. It does NOT apply to the fast engine, which only fetches what a page's
markup already references and has no third-party sprawl to refuse.

THE LIST. ``zimi/assets/blocklist-snapshot.txt.gz`` ships in the package —
StevenBlack's unified hosts aggregation (MIT), flattened to one domain per line
and gzipped. The file's own header records the source URL, the retrieval date
and the licence; so does this docstring, so that neither can quietly become the
only copy of the provenance:

    Source:    https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
    Project:   https://github.com/StevenBlack/hosts
    Licence:   MIT
    Retrieved: 2026-08-14   (98,950 domains)

It is a SNAPSHOT and it does not refresh itself. That is a deliberate 1.9
limit rather than an oversight: an auto-updating blocklist wants the machinery
the catalog already has — a stale-while-revalidate fetch, an offline-safe
fallback, a "when did this last update" surface — and bolting a second, worse
downloader on beside it would be the wrong shape. Refreshing it the way the
catalog refreshes is the follow-up.

OVERRIDING IT, per machine, no rebuild: write ``<data_dir>/blocklist.txt``.

    ads.example.com          # one more domain to block
    0.0.0.0 tracker.example  # hosts-file syntax is read too
    @@cdn.cookielaw.org      # never block this one, whatever the snapshot says
    -consent.example.com     # the same thing, in the other common spelling

Additions extend the snapshot. An ALLOW line (``@@`` or a leading ``-``) wins
over any block, for that domain and everything under it — which is the escape
hatch for the one site whose content genuinely lives behind a domain the list
took a dislike to. The file is re-read when it changes; there is nothing to
restart.

WHAT THE ZIM REMEMBERS. Blocking changes what a capture CONTAINS, so it is
recorded where the other facts about how a ZIM was made are recorded — the
``X-Zimi-History`` creation record, as a ``blocked`` object beside the counts:

    "detail": "captured one page from https://www.cnn.com/ with 5 ad/tracker
               requests blocked",
    "blocked": {"requests": 5, "domains": 4,
                "list": "stevenblack-hosts", "snapshot": "2026-08-14"}

The list identity and the snapshot date are in there for the same reason the
counts are: "5 requests blocked" without saying blocked BY WHAT is a number
nobody can reproduce or argue with. ``override: true`` joins them when a
machine's own ``blocklist.txt`` contributed. When blocking did not run there is
NO field — never a zero, never a false, because absence is what distinguishes
"this capture did not block" from "this capture blocked nothing".

The alive engine is the exception, and structurally: warc2zim writes that ZIM,
so there is no Zimi Creator to put a history record in and its provenance is
the Scraper suffix (see ``zimi.alive``). An alive capture reports its blocking
in the job log and in the returned summary; it cannot yet stamp it into the
file. See ``zimi.importer.convert_archive`` for the flags that ARE reachable.

MATCHING is by domain suffix on label boundaries: a blocked ``example.com``
blocks ``a.b.example.com`` and does not block ``notexample.com``. The lookup
walks the host's labels from the left and asks the set once per label, so it
costs the depth of the name and not the size of the list — with a hundred
thousand domains loaded, that difference is the whole design.
"""

import gzip
import ipaddress
import logging
import os
import re
import threading
import urllib.parse

log = logging.getLogger("zimi.blocklist")

# The shipped list, and the per-machine file that extends it.
SNAPSHOT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "assets", "blocklist-snapshot.txt.gz"
)
OVERRIDE_NAME = "blocklist.txt"

# The snapshot's provenance, as data rather than only as prose — a caller that
# wants to say where the list came from should not have to read a docstring.
# ``SNAPSHOT_ID`` is the STABLE name that goes into a ZIM's creation record: a
# short identity somebody can look up in five years, where a URL rots and a
# sentence cannot be matched on. It changes only if the list itself is replaced
# by a different aggregation, never when the snapshot is refreshed — that is
# what the date beside it is for.
SNAPSHOT_ID = "stevenblack-hosts"
SNAPSHOT_SOURCE = "https://github.com/StevenBlack/hosts"
SNAPSHOT_LICENSE = "MIT"
SNAPSHOT_RETRIEVED = "2026-08-14"

# The two spellings of "never block this". `@@` is what every ad-blocking list
# format in the world uses; a leading `-` is what people type anyway.
_ALLOW_PREFIXES = ("@@", "-")

# A domain label. Underscores are in here because real hostnames use them and a
# blocklist that silently dropped `_dmarc.example.com` would be lying about its
# own contents.
_LABEL_RE = re.compile(r"^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$")
_MAX_DOMAIN = 253


# ── one name, normalized ────────────────────────────────────────────────────


def normalize_domain(name):
    """``name`` as the ASCII domain this module stores, or None.

    Lowercased, stripped of a trailing dot, punycoded when it is not already
    ASCII. None for everything that is not a domain: an IP address (a hosts
    file is full of them, in the column that is not the name), a single label
    like ``localhost``, anything with a character a hostname cannot hold."""
    text = str(name or "").strip().rstrip(".").lower()
    if not text or "." not in text or len(text) > _MAX_DOMAIN:
        return None
    if _is_address(text):
        return None
    if not text.isascii():
        try:
            text = text.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError):
            return None
    if not all(_LABEL_RE.match(label) for label in text.split(".")):
        return None
    return text


def _is_address(text):
    """Whether this is an IP literal rather than a name. The zone suffix on a
    link-local address (``fe80::1%lo0``) is not part of the address, and a
    hosts file on a Mac has one."""
    try:
        ipaddress.ip_address(text.split("%", 1)[0])
        return True
    except ValueError:
        return False


def host_of(url):
    """The lowercase host in a URL, or ``""``. Port and userinfo removed, IPv6
    brackets removed — ``urlsplit().hostname`` does all three, and a URL it
    cannot parse is one this never had an opinion about."""
    try:
        return (urllib.parse.urlsplit(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


# ── parsing ─────────────────────────────────────────────────────────────────


def parse(text):
    """``(blocked, allowed)`` frozensets of domains from list text.

    Reads both dialects without being told which it has: hosts format
    (``0.0.0.0 ads.example.com``, several names to a line permitted) and a bare
    domain per line. ``#`` starts a comment anywhere. A line whose first field
    is an IP literal is a hosts line and its first field is not a name; a line
    whose fields are all names is a domain list, and all of them count."""
    blocked, allowed = set(), set()
    for raw in str(text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        target = blocked
        for prefix in _ALLOW_PREFIXES:
            if line.startswith(prefix):
                line, target = line[len(prefix) :].strip(), allowed
                break
        fields = line.split()
        if not fields:
            continue
        names = fields[1:] if len(fields) > 1 and _is_address(fields[0]) else fields
        for name in names:
            domain = normalize_domain(name)
            if domain:
                target.add(domain)
    return frozenset(blocked), frozenset(allowed)


class Blocklist:
    """A set of blocked domains, matched by suffix, with an allow set on top.

    ``blocks(host)`` is the whole interface and it is asked once per request a
    browser makes, so it does the cheapest thing that is correct: walk the
    host's labels from the left, ask a frozenset at each boundary, stop at the
    first hit. No regexes, no iteration over the list.

    An ALLOW match wins outright — for the allowed domain and everything under
    it — rather than by being more specific than the block that matched. The
    specific rule would be defensible and this one is explicable, and an escape
    hatch nobody can predict the behaviour of is not an escape hatch."""

    __slots__ = ("blocked", "allowed", "overridden")

    def __init__(self, blocked=(), allowed=(), overridden=False):
        self.blocked = frozenset(blocked)
        self.allowed = frozenset(allowed)
        # Whether a machine's own blocklist.txt contributed anything to this.
        # Carried because it goes into the ZIM's creation record: provenance
        # that named the shipped snapshot while a local file was quietly adding
        # three hundred domains would be provenance that lies.
        self.overridden = bool(overridden)

    def __len__(self):
        return len(self.blocked)

    def __bool__(self):
        return bool(self.blocked)

    def blocks(self, host):
        """Whether a host is on the list — it, or any parent domain of it."""
        name = str(host or "").strip().rstrip(".").lower()
        if not name or not self.blocked:
            return False
        if self.allowed and _suffix_hit(name, self.allowed):
            return False
        return _suffix_hit(name, self.blocked)

    def blocks_url(self, url):
        """The same question about a whole URL. A URL with no host — ``data:``,
        ``blob:``, ``about:`` — is never blocked: there is nothing to fetch and
        nobody to fetch it from."""
        host = host_of(url)
        return bool(host) and self.blocks(host)

    def extend(self, blocked=(), allowed=()):
        """A new Blocklist with more in it, marked as locally overridden.

        Immutable on purpose: one is shared by every capture running in a
        process, and a list that could be edited underneath a running crawl
        would make two pages of one ZIM disagree."""
        return Blocklist(
            self.blocked | frozenset(blocked),
            self.allowed | frozenset(allowed),
            overridden=True,
        )


def _suffix_hit(name, domains):
    """Whether ``name`` or any parent domain of it is in ``domains``.

    Label boundaries only, which is the property that makes this a domain
    matcher rather than a substring one: ``notexample.com`` does not match a
    blocked ``example.com``, and ``a.b.example.com`` does.

    It walks all the way up to the bare TLD. That is safe for the list this
    ships — no aggregation puts ``com`` in it — and it is worth naming: a
    blocklist that DID contain a public suffix would, correctly by this rule,
    block the entire internet under it."""
    if name in domains:
        return True
    dot = name.find(".")
    while dot != -1:
        name = name[dot + 1 :]
        if name in domains:
            return True
        dot = name.find(".")
    return False


def parse_blocklist(text):
    """List text straight to a ``Blocklist``. The parse and the matcher are
    separate because the loader merges two texts before it makes one."""
    return Blocklist(*parse(text))


# ── loading ─────────────────────────────────────────────────────────────────
#
# The snapshot is two megabytes of text behind six hundred kilobytes of gzip,
# and reading it is a fifth of a second. A Zimi that never captures a page must
# never pay that, and a Zimi that captures four hundred must pay it once.

_lock = threading.Lock()
_snapshot = None  # the shipped list, parsed once per process
_cached = None  # (data_dir, override stamp) -> Blocklist


def snapshot():
    """The shipped list, parsed once. An unreadable or corrupt snapshot is an
    EMPTY list and a log line, never an exception: blocking is an improvement
    to a capture, and a capture must not fail because the improvement did."""
    global _snapshot
    with _lock:
        if _snapshot is not None:
            return _snapshot
    try:
        with gzip.open(SNAPSHOT_PATH, "rt", encoding="utf-8", errors="replace") as fh:
            parsed = parse_blocklist(fh.read())
    except (OSError, EOFError, gzip.BadGzipFile) as e:
        log.warning("the bundled blocklist could not be read (%s)", e)
        parsed = Blocklist()
    with _lock:
        if _snapshot is None:
            _snapshot = parsed
    return _snapshot


def override_path(data_dir=None):
    """Where this machine's own list lives."""
    if data_dir is None:
        import zimi.server as _srv

        data_dir = _srv.ZIMI_DATA_DIR
    return os.path.join(data_dir, OVERRIDE_NAME)


def _stamp(path):
    """What makes a cached merge stale: the override file's size and mtime, or
    None when there is no file. One stat per capture, which is nothing beside
    the browser launch it precedes."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def load(data_dir=None, refresh=False):
    """The list a capture should run with: the snapshot, plus this machine's
    ``blocklist.txt`` when it has one.

    Cached against the override file's own mtime, so an operator who adds a
    domain and starts another capture gets the domain — without a restart, and
    without re-reading two megabytes of gzip to find out nothing changed."""
    global _cached
    path = override_path(data_dir)
    key = (path, _stamp(path))
    if not refresh:
        with _lock:
            if _cached is not None and _cached[0] == key:
                return _cached[1]
    merged = snapshot()
    if key[1] is not None:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                extra_blocked, extra_allowed = parse(fh.read())
            merged = merged.extend(extra_blocked, extra_allowed)
            log.info(
                "blocklist: %s adds %d domains and allows %d",
                path,
                len(extra_blocked),
                len(extra_allowed),
            )
        except OSError as e:
            log.warning("could not read %s (%s) — using the bundled list", path, e)
    with _lock:
        _cached = (key, merged)
    return merged


def reset():
    """Forget both caches. For tests, and for nothing else — the loader's own
    staleness check covers the case an operator can create."""
    global _snapshot, _cached
    with _lock:
        _snapshot = None
        _cached = None


# ── saying what happened ────────────────────────────────────────────────────
#
# Three audiences, three sentences, one set of numbers. The operator watching a
# job reads the progress line. Whoever opens the ZIM in five years reads the
# creation record — which is why the identity of the LIST is in there beside
# the counts: "214 requests blocked" without saying blocked by what is a number
# nobody can reproduce or argue with.


def blocked_record(requests, domains, blocklist=None):
    """The ``blocked`` object for a ZIM's creation record, or None.

    ``None`` when nothing was refused, and that absence is the whole encoding:
    a record with no ``blocked`` field is a capture where blocking did not run,
    and there is deliberately no ``false`` to be misread as "ran and found
    nothing". Every field is a fact about THIS capture — how many requests
    never went out, how few places they were going, which published list said
    so, and when that list was taken.

    ``override: true`` is added when the machine's own ``blocklist.txt``
    contributed, because then the list identity alone no longer describes what
    ran, and a provenance record that quietly overstates its own reproducibility
    is worse than one that admits the local edit."""
    requests = int(requests or 0)
    if requests <= 0:
        return None
    record = {
        "requests": requests,
        "domains": int(domains or 0),
        "list": SNAPSHOT_ID,
        "snapshot": SNAPSHOT_RETRIEVED,
    }
    if blocklist is not None and getattr(blocklist, "overridden", False):
        record["override"] = True
    return record


def blocked_phrase(record):
    """What a creation record's own detail sentence says about blocking — a
    clause to append, or ``""``. The human half of the same fact the object
    below it carries in numbers."""
    if not record:
        return ""
    requests = int(record.get("requests") or 0)
    if requests <= 0:
        return ""
    return f" with {requests} ad/tracker request{'' if requests == 1 else 's'} blocked"


def blocked_summary(requests, hosts):
    """The one line a capture reports, or None when nothing was blocked.

    A count with no denominator ("blocked 214 requests") says less than the
    same count with the shape of what it refused, so both numbers are here: how
    many requests never went out, and how few distinct places they were going
    to. Two hundred requests to thirty-seven domains is a page describing its
    own advertising stack."""
    requests = int(requests or 0)
    hosts = int(hosts or 0)
    if requests <= 0:
        return None
    return (
        f"blocked {requests} request{'' if requests == 1 else 's'} to "
        f"{hosts} ad or tracker domain{'' if hosts == 1 else 's'}"
    )
