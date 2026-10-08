"""What a capture sends and what it leaves out.

Two rules that ride a capture's context, as the user agent and the
private-address guard do (see ``zimi.creator``), so every reader between a
capture and its sockets asks instead of being handed a parameter:

* **Cookies** are a credential. A capture may be given the ``Cookie`` header a
  person copied from their browser; it is sent only to the seed's host and its
  subdomains, never to another origin a wider scope, an extra hop, a redirect
  or a CDN reaches. The value is never written anywhere (job record, history,
  log, provenance, ZIM metadata, stored defaults) and shows as ``set`` in any
  echo of a capture's options.
* **Leave out** names kinds of file a capture does not carry (video, audio,
  PDF, archives, images) and the largest file it will. Matched by extension
  before a fetch and by content type and length after; what was skipped is
  counted, and a skipped asset's link stays as the page had it.
"""

import contextvars
import ipaddress
import re
import threading
import urllib.parse

# The text shown wherever a capture's options are echoed, in place of the cookie.
COOKIES_SET = "set"

MAX_COOKIE_CHARS = 8192
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
# RFC 6265 cookie-name: an HTTP token.
_COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_COOKIE_FORM = "cookies are written as a Cookie header is: name=value; name=value"


class GateError(ValueError):
    """A value the person can fix. Callers re-raise it as their own error type,
    and the message never carries the value it refused."""


def parse_cookies(text):
    """The ``(name, value)`` pairs of a ``Cookie`` header as copied from the
    browser's developer tools (a leading ``Cookie:`` is allowed), or None when
    empty. Raises ``GateError`` without echoing any of it."""
    raw = str(text or "").strip()
    if raw[:7].lower() == "cookie:":
        raw = raw[7:].strip()
    if not raw:
        return None
    if len(raw) > MAX_COOKIE_CHARS:
        raise GateError(f"cookies are at most {MAX_COOKIE_CHARS} characters")
    if _CONTROL_CHARS.search(raw):
        raise GateError("cookies are one line, with no control characters")
    pairs = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        name, eq, value = part.partition("=")
        name, value = name.strip(), value.strip()
        if not eq or not _COOKIE_NAME_RE.match(name):
            raise GateError(_COOKIE_FORM)
        try:
            value.encode("latin-1")
        except UnicodeEncodeError:
            raise GateError(
                "cookie values are plain characters, as a browser sends them"
            )
        pairs.append((name, value))
    if not pairs:
        raise GateError(_COOKIE_FORM)
    return pairs


def normalize_cookies(text):
    """The header text ``parse_cookies`` accepted, tidied: ``a=1; b=2``."""
    pairs = parse_cookies(text)
    return "; ".join(f"{n}={v}" for n, v in pairs) if pairs else None


def _is_ip(host):
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


class _Seed:
    """One page a capture was pointed at: where its cookies may go."""

    def __init__(self, url):
        parts = urllib.parse.urlsplit(url)
        self.host = (parts.hostname or "").lower()
        self.scheme = parts.scheme.lower()
        self.origin = f"{self.scheme}://{parts.netloc}/"

    def takes(self, scheme, host):
        if not self.host or scheme not in ("http", "https"):
            return False
        # Never down the ladder: a secure seed's cookies do not go out in clear.
        if self.scheme == "https" and scheme != "https":
            return False
        if host == self.host:
            return True
        return not _is_ip(self.host) and host.endswith("." + self.host)


class CaptureCookies:
    """The cookies of ONE capture, bound to the host of each of its seeds (a
    site has one, several pages have one each)."""

    def __init__(self, header, seed_urls):
        self._pairs = parse_cookies(header) or []
        urls = [seed_urls] if isinstance(seed_urls, str) else list(seed_urls or ())
        self._seeds = [_Seed(u) for u in urls]
        self.host = self._seeds[0].host if self._seeds else ""

    def __bool__(self):
        return bool(self._pairs and any(s.host for s in self._seeds))

    # A cookie in a traceback or a log line is a leak; this prints as nothing.
    def __repr__(self):
        hosts = ", ".join(s.host for s in self._seeds) or "no host"
        return f"<CaptureCookies {COOKIES_SET} for {hosts}>"

    __str__ = __repr__

    def applies_to(self, url):
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        scheme = parts.scheme.lower()
        return bool(host) and any(s.takes(scheme, host) for s in self._seeds)

    def header_for(self, url):
        """The ``Cookie`` header to send to ``url``, or None for anywhere else."""
        if not self or not self.applies_to(url):
            return None
        return "; ".join(f"{n}={v}" for n, v in self._pairs)

    def for_browser(self):
        """The same cookies for a browser context, which does its own matching,
        once for each seed's host. Ordinarily a domain cookie (the host and its
        subdomains), or a host-only one for an address or ``localhost``; secure
        when the seed is https. The prefixes browsers police are given the form
        they demand: ``__Host-`` is host-only, on the seed's URL, secure;
        ``__Secure-`` is secure."""
        if not self:
            return []
        out, done = [], set()
        for seed in self._seeds:
            if not seed.host or (seed.host, seed.scheme) in done:
                continue
            done.add((seed.host, seed.scheme))
            wide = not _is_ip(seed.host) and "." in seed.host
            secure = seed.scheme == "https"
            for name, value in self._pairs:
                cookie = {"name": name, "value": value}
                if name.startswith("__Host-"):
                    cookie.update(url=seed.origin, secure=True)
                else:
                    cookie.update(
                        domain=("." if wide else "") + seed.host,
                        path="/",
                        secure=secure or name.startswith("__Secure-"),
                    )
                out.append(cookie)
        return out


_CAPTURE_COOKIES = contextvars.ContextVar("zimi_capture_cookies", default=None)


def current_cookies():
    return _CAPTURE_COOKIES.get()


def set_cookies(header, seed_urls):
    """Put a capture's cookies in force; returns the token to ``reset`` with
    (None when there are none)."""
    jar = CaptureCookies(header, seed_urls) if header else None
    return _CAPTURE_COOKIES.set(jar if jar else None)


def reset_cookies(token):
    _CAPTURE_COOKIES.reset(token)


def apply_cookie(req):
    """Give ``req`` the capture's cookie if its address is the seed's host or a
    subdomain, and take any off it otherwise. Added as an unredirected header,
    so a redirect never carries it to the next host on its own."""
    jar = _CAPTURE_COOKIES.get()
    if jar is None:
        return req
    header = jar.header_for(req.full_url)
    if header:
        req.add_unredirected_header("Cookie", header)
    else:
        req.remove_header("Cookie")
    return req


# ── leave out ───────────────────────────────────────────────────────────────

# kind -> (content-type prefixes or exact types, file extensions)
SKIP_TYPES = {
    "video": (
        ("video/", "application/vnd.apple.mpegurl", "application/x-mpegurl"),
        (
            "mp4",
            "m4v",
            "webm",
            "mov",
            "mkv",
            "avi",
            "ogv",
            "mpg",
            "mpeg",
            "3gp",
            "wmv",
            "flv",
            "m3u8",
        ),
    ),
    "audio": (
        ("audio/",),
        ("mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"),
    ),
    "pdf": (("application/pdf",), ("pdf",)),
    "archives": (
        (
            "application/zip",
            "application/gzip",
            "application/x-gzip",
            "application/x-tar",
            "application/x-bzip2",
            "application/x-xz",
            "application/x-7z-compressed",
            "application/vnd.rar",
            "application/x-rar-compressed",
            "application/zstd",
        ),
        ("zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"),
    ),
    "images": (
        ("image/",),
        (
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "avif",
            "svg",
            "ico",
            "bmp",
            "tif",
            "tiff",
            "heic",
        ),
    ),
}


def parse_skip_types(value):
    """The kinds named, in the table's order. A list or the comma-separated
    text a flag carries. None is "not given"; an empty list is "leave nothing
    out", which beats a stored default."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    items = value.split(",") if isinstance(value, str) else value
    if not isinstance(items, (list, tuple)):
        raise GateError(f"leave-out kinds are some of: {', '.join(SKIP_TYPES)}")
    wanted = set()
    for item in items:
        kind = str(item).strip().lower()
        if not kind:
            continue
        if kind not in SKIP_TYPES:
            raise GateError(
                f"cannot leave out {kind[:20]!r}: the kinds are {', '.join(SKIP_TYPES)}"
            )
        wanted.add(kind)
    return [k for k in SKIP_TYPES if k in wanted]


def _extension(url):
    path = urllib.parse.urlsplit(url).path
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


class LeaveOut:
    """Kinds of file a capture does not carry and the largest it will, with a
    count of what was left out. Safe to share between the threads of one
    capture."""

    def __init__(self, kinds=None, max_bytes=None):
        self.kinds = tuple(kinds or ())
        self.max_bytes = int(max_bytes) if max_bytes else None
        self.counts = {}
        self._seen = set()
        self._lock = threading.Lock()

    def __bool__(self):
        return bool(self.kinds or self.max_bytes)

    def _count(self, what, url=None):
        """Count a file once, however many times a page asks for it. Always
        True: a resource that is left out stays left out."""
        with self._lock:
            if url is None or url not in self._seen:
                if url is not None:
                    self._seen.add(url)
                self.counts[what] = self.counts.get(what, 0) + 1
        return True

    def _kind_of(self, content_type=None, url=None):
        if url:
            ext = _extension(url)
            for kind in self.kinds:
                if ext and ext in SKIP_TYPES[kind][1]:
                    return kind
        mime = (content_type or "").split(";")[0].strip().lower()
        if mime:
            for kind in self.kinds:
                if any(mime.startswith(t) if t.endswith("/") else mime == t for t in SKIP_TYPES[kind][0]):
                    return kind
        return None

    def skips_url(self, url):
        """Before any fetch: the extension says it is a kind to leave out."""
        kind = self._kind_of(url=url)
        return bool(kind) and self._count(kind, url)

    def skips_response(self, content_type, length=None, url=None):
        """After the headers, before the body: its type is a kind to leave out,
        or it says it is bigger than the largest file."""
        kind = self._kind_of(content_type)
        if kind:
            return self._count(kind, url)
        return self.skips_size(length, url)

    def skips_size(self, length, url=None):
        try:
            length = int(length)
        except (TypeError, ValueError):
            return False
        return bool(self.max_bytes and length > self.max_bytes) and self._count("too big", url)

    def cap(self, default):
        """The most to read of one file: the engine's own cap, or the largest
        file if that is smaller."""
        return min(default, self.max_bytes) if self.max_bytes else default

    def summary(self):
        """One line for the log, or None when nothing was left out."""
        if not self.counts:
            return None
        parts = []
        for kind in self.kinds:
            if self.counts.get(kind):
                parts.append(f"{self.counts[kind]} {kind}")
        if self.counts.get("too big"):
            from zimi.creator import _fmt_bytes

            parts.append(f"{self.counts['too big']} over {_fmt_bytes(self.max_bytes)}")
        total = sum(self.counts.values())
        return f"left out {total} file{'s' if total != 1 else ''}: {', '.join(parts)}"


_CAPTURE_LEAVE_OUT = contextvars.ContextVar("zimi_capture_leave_out", default=None)


def current_leave_out():
    """The leave-out rule in force, or None when a capture leaves nothing out."""
    return _CAPTURE_LEAVE_OUT.get()


def set_leave_out(kinds=None, max_bytes=None):
    rule = LeaveOut(kinds, max_bytes)
    return _CAPTURE_LEAVE_OUT.set(rule if rule else None)


def reset_leave_out(token):
    _CAPTURE_LEAVE_OUT.reset(token)


def report_left_out(note):
    """Say what the capture in force left out, once it is known."""
    rule = _CAPTURE_LEAVE_OUT.get()
    line = rule.summary() if rule else None
    if line:
        note(line)
