"""An existing qBittorrent as Zimi's BitTorrent engine, the way the *arr apps
use one (#53).

People who run Sonarr or Radarr already have a qBittorrent, often behind a VPN,
and already know its model: a URL, a login, a category the app owns, and remote
path mappings for when the two containers mount the same disk at different
paths. Zimi uses the same model, so the setup is one they have done before.

- Every torrent Zimi adds goes in Zimi's category, and Zimi never lists,
  changes or deletes anything outside it.
- The .torrent is uploaded rather than linked, so the info hash is known up
  front and qBittorrent needs no route to the catalog.
- Paths cross between the two through the mappings (``remote=local``). A
  download is saved where qBittorrent can be told and Zimi can see; when it
  completes, qBittorrent moves it into the library itself if it can see the
  library (and keeps seeding it there, no copy), else Zimi hardlinks or copies
  it out and qBittorrent keeps seeding its own.
- Delete-with-files is refused for anything in the library, as the built-in
  engine refuses it.

Web API v2 over the standard library. qBittorrent 5 renamed pause/resume to
stop/start; both are spoken.
"""

import http.cookiejar
import json
import logging
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from zimi.p2p import BTBackend

log = logging.getLogger("zimi.qbittorrent")

DEFAULT_CATEGORY = "zimi"
REQUEST_TIMEOUT_S = 20
# setLocation moves the payload on qBittorrent's side; a big ZIM across
# volumes takes minutes. Polled at this interval, given up after the limit.
MOVE_POLL_S = 2.0
MOVE_LIMIT_S = 6 * 3600

ENV = {
    "url": "ZIMI_QBT_URL",
    "user": "ZIMI_QBT_USER",
    "password": "ZIMI_QBT_PASSWORD",
    "category": "ZIMI_QBT_CATEGORY",
    "paths": "ZIMI_QBT_PATHS",
}
PREF = {k: "qbt_" + k for k in ENV}


class QbtError(RuntimeError):
    """A plain sentence for the operator: what failed and what to change."""


# ── configuration ───────────────────────────────────────────────────────────


def _pref(key):
    from zimi import p2p

    return p2p._read_pref(PREF[key], "")


def env_locked():
    """The connection comes from the environment: the URL var is set."""
    return bool(os.environ.get(ENV["url"], "").strip())


def config():
    """{url, user, password, category, paths} or None when no qBittorrent is
    configured. When ZIMI_QBT_URL is set the whole connection comes from the
    environment; otherwise from Settings."""
    if env_locked():
        raw = {k: os.environ.get(v, "") for k, v in ENV.items()}
    else:
        raw = {k: _pref(k) for k in ENV}
    url = str(raw["url"] or "").strip().rstrip("/")
    if not url:
        return None
    return {
        "url": url,
        "user": str(raw["user"] or "").strip(),
        "password": str(raw["password"] or ""),
        "category": str(raw["category"] or "").strip() or DEFAULT_CATEGORY,
        "paths": parse_paths(raw["paths"]),
    }


def valid_url(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def parse_paths(text):
    """``remote=local`` pairs, one per line or ``;``-separated, as
    [(remote, local)] longest remote first. Lines without ``=`` are dropped."""
    pairs = []
    for line in re.split(r"[;\n]", str(text or "")):
        if "=" not in line:
            continue
        remote, local = (p.strip() for p in line.split("=", 1))
        if remote and local:
            pairs.append((remote.rstrip("/\\") or "/", local.rstrip("/\\") or "/"))
    return pairs


def format_paths(pairs):
    return "\n".join(f"{r}={l}" for r, l in pairs)


def _under(path, root, sep):
    return path == root or path.startswith(root.rstrip(sep) + sep)


def _swap(path, src, dst, sep_in, sep_out):
    rest = path[len(src.rstrip(sep_in)) :].lstrip(sep_in)
    if not rest:
        return dst
    return dst.rstrip(sep_out) + sep_out + rest.replace(sep_in, sep_out)


def _sep(path):
    return "\\" if re.match(r"^[A-Za-z]:\\", path or "") else "/"


def to_local(remote, pairs):
    """qBittorrent's path as Zimi sees it. Without a mapping that covers it,
    the same path (both mount it at the same place, the *arr default)."""
    if not remote:
        return remote
    rs = _sep(remote)
    for r, l in sorted(pairs, key=lambda p: -len(p[0])):
        if _under(remote, r, rs):
            return _swap(remote, r, l, rs, os.sep)
    return remote


def to_remote(local, pairs):
    """Zimi's path as qBittorrent sees it, or None when no mapping covers it:
    Zimi then does not know whether qBittorrent can reach it."""
    local = os.path.abspath(local)
    for r, l in sorted(pairs, key=lambda p: -len(p[1])):
        if _under(local, os.path.abspath(l), os.sep):
            return _swap(local, os.path.abspath(l), r, os.sep, _sep(r))
    return None


# ── Web API v2 ─────────────────────────────────────────────────────────────


class Client:
    """A qBittorrent Web API session. Logs in on the first 403 and again when
    the cookie expires; a client that bypasses authentication for this
    address (a common LAN setting) never needs the password."""

    def __init__(self, url, user="", password=""):
        self.url = url.rstrip("/")
        self.user = user
        self.password = password
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._lock = threading.Lock()

    def _open(self, path, data=None, content_type=None):
        req = urllib.request.Request(self.url + "/api/v2/" + path, data=data)
        # qBittorrent refuses a request whose Referer/Origin names another
        # host; naming its own satisfies the check behind a proxy too.
        req.add_header("Referer", self.url + "/")
        if content_type:
            req.add_header("Content-Type", content_type)
        with self._opener.open(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return resp.read()

    def login(self):
        body = urllib.parse.urlencode(
            {"username": self.user, "password": self.password}
        ).encode()
        try:
            out = self._open("auth/login", body, "application/x-www-form-urlencoded")
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise QbtError(
                    "qBittorrent refused the login: too many failed attempts, so it has banned this address for a while"
                ) from None
            raise
        if out.strip() != b"Ok.":
            raise QbtError("qBittorrent refused the username or password")

    def call(self, path, fields=None, files=None):
        """GET (no fields) or POST form/multipart; returns the body bytes."""
        data, ctype = None, None
        if files:
            data, ctype = _multipart(fields or {}, files)
        elif fields is not None:
            data = urllib.parse.urlencode(fields).encode()
            ctype = "application/x-www-form-urlencoded"
        with self._lock:
            try:
                return self._open(path, data, ctype)
            except urllib.error.HTTPError as e:
                if e.code != 403:
                    raise
            self.login()
            return self._open(path, data, ctype)

    def json(self, path, **params):
        q = ("?" + urllib.parse.urlencode(params)) if params else ""
        return json.loads(self.call(path + q) or b"null")

    def text(self, path):
        return self.call(path).decode("utf-8", "replace").strip()


def _multipart(fields, files):
    boundary = "zimi" + uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        )
    for k, (name, payload) in files.items():
        out.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                "Content-Type: application/x-bittorrent\r\n\r\n"
            ).encode()
            + payload
            + b"\r\n"
        )
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), "multipart/form-data; boundary=" + boundary


def probe(cfg, library_dir=None):
    """Test a configuration: {ok, version, save_path, visible, library_mapped}
    or {ok: False, error}. ``visible`` is whether Zimi can see qBittorrent's
    default save folder through the mappings; ``library_mapped`` whether
    qBittorrent can see the library (needed to seed what is already there)."""
    try:
        c = Client(cfg["url"], cfg["user"], cfg["password"])
        version = c.text("app/version")
        prefs = c.json("app/preferences")
    except QbtError as e:
        return {"ok": False, "error": str(e)}
    except urllib.error.HTTPError as e:
        return {
            "ok": False,
            "error": f"qBittorrent answered HTTP {e.code} at {cfg['url']}",
        }
    except (urllib.error.URLError, OSError, ValueError) as e:
        reason = getattr(e, "reason", e)
        return {
            "ok": False,
            "error": f"Could not reach qBittorrent at {cfg['url']}: {reason}",
        }
    save = str((prefs or {}).get("save_path") or "")
    local = to_local(save, cfg["paths"])
    return {
        "ok": True,
        "version": version,
        "save_path": save,
        "local_save_path": local,
        "visible": bool(local) and os.path.isdir(local),
        "library_mapped": bool(library_dir)
        and to_remote(library_dir, cfg["paths"]) is not None,
    }


# ── the engine ─────────────────────────────────────────────────────────────

# qBittorrent's states, by what Zimi does with them.
_ERROR_STATES = {"error", "missingFiles", "unknown"}
_PAUSED_STATES = {"pausedDL", "stoppedDL"}
_CHECKING_STATES = {
    "checkingDL",
    "checkingUP",
    "checkingResumeData",
    "moving",
    "allocating",
}


def _magnet_hash(uri):
    m = re.search(r"xt=urn:btih:([0-9a-fA-F]{40})", uri)
    return m.group(1).lower() if m else None


class QBittorrentBackend(BTBackend):
    """BTBackend over a qBittorrent the operator already runs. Torrent ids are
    v1 info-hash hex, as with the built-in engine, so the library's records
    carry over between the two."""

    external = True

    def __init__(self, cfg, *, library_dir, staging_dir):
        self.cfg = cfg
        self.client = Client(cfg["url"], cfg["user"], cfg["password"])
        self.category = cfg["category"]
        self.paths = cfg["paths"]
        self.library_dir = library_dir
        self.staging_dir = staging_dir
        self._stopped = False
        self._v5 = None

    # ── lifecycle ──

    def available(self):
        try:
            version = self.client.text("app/version")
            api = self.client.text("app/webapiVersion")
        except Exception as e:
            log.warning("qBittorrent at %s not usable: %s", self.cfg["url"], e)
            return False
        self._v5 = tuple(int(x) for x in re.findall(r"\d+", api)[:2]) >= (2, 11)
        try:
            self.client.call("torrents/createCategory", {"category": self.category})
        except urllib.error.HTTPError as e:
            if e.code != 409:  # 409: it exists already
                log.warning("qBittorrent category %r: HTTP %s", self.category, e.code)
        log.info(
            "qBittorrent %s at %s is the BitTorrent engine (category %s)",
            version,
            self.cfg["url"],
            self.category,
        )
        return True

    def is_alive(self):
        return not self._stopped

    def stop(self):
        # qBittorrent keeps running and keeps its torrents; Zimi just stops
        # talking to it. A download in flight resumes on the next start.
        self._stopped = True

    def web_ui_url(self, tid=None):
        return self.cfg["url"] + "/"

    # ── paths ──

    def _in_library(self, local):
        if not local or not self.library_dir:
            return False
        return _under(
            os.path.realpath(local), os.path.realpath(self.library_dir), os.sep
        )

    def _info(self, tid):
        rows = self.client.json("torrents/info", hashes=tid)
        return rows[0] if rows else None

    def payload_path(self, tid, filename, staging_dir):
        row = self._info(tid)
        if not row:
            return os.path.join(staging_dir, filename)
        return to_local(row.get("content_path") or "", self.paths)

    def install(self, tid, src, dest):
        """Put the finished file at ``dest``. qBittorrent moves it itself when
        it can see the library, and keeps seeding it there; otherwise a
        hardlink, else a copy, and qBittorrent keeps seeding its own."""
        remote_dir = to_remote(os.path.dirname(dest), self.paths)
        if remote_dir is not None:
            self.client.call(
                "torrents/setLocation", {"hashes": tid, "location": remote_dir}
            )
            deadline = time.monotonic() + MOVE_LIMIT_S
            while time.monotonic() < deadline:
                row = self._info(tid)
                if row is None:
                    raise QbtError(
                        "the torrent left qBittorrent while it was being moved"
                    )
                if row.get("state") != "moving" and os.path.exists(dest):
                    return tid
                time.sleep(MOVE_POLL_S)
            raise QbtError(
                "qBittorrent did not finish moving the file into the library"
            )
        tmp = dest + ".zimi-tmp"
        try:
            os.link(src, tmp)
        except OSError:
            shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
        return tid

    # ── torrents ──

    def add_torrent(self, source, *, dest_dir, options=None):
        if source.startswith("magnet:"):
            tid = _magnet_hash(source)
            if not tid:
                raise QbtError("magnet link without a v1 info hash")
            fields, files = {"urls": source}, None
        else:
            if source.startswith(("http://", "https://")):
                from zimi.p2p import fetch_torrent_bytes

                data = fetch_torrent_bytes(source)
            else:
                with open(source, "rb") as f:
                    data = f.read()
            from zimi.library import _torrent_info_hash

            tid = _torrent_info_hash(data)
            if not tid:
                raise QbtError("not a .torrent file")
            fields, files = {}, {"torrents": (tid + ".torrent", data)}
        remote = to_remote(dest_dir, self.paths)
        if remote is None and self._in_library(dest_dir):
            # Seeding what is already in the library needs qBittorrent to
            # see it; saving it elsewhere would download a second copy.
            raise QbtError(
                "qBittorrent cannot see the library: add a path mapping for "
                + os.path.abspath(dest_dir)
            )
        fields.update({"category": self.category, "tags": "zimi"})
        if remote is not None:
            fields.update({"savepath": remote, "autoTMM": "false"})
        if options and options.get("seed_mode"):
            fields["skip_checking"] = "true"
        if self._info(tid):
            return tid  # already there: a restart picking up its download
        out = self.client.call("torrents/add", fields, files)
        if out.strip() not in (b"Ok.", b""):
            raise QbtError(
                "qBittorrent refused the torrent: "
                + out.decode("utf-8", "replace")[:200]
            )
        # The add is asynchronous; wait for it to show so status() is honest.
        for _ in range(50):
            if self._info(tid):
                return tid
            time.sleep(0.1)
        raise QbtError("qBittorrent accepted the torrent but never listed it")

    def pause(self, tid):
        self._toggle(tid, ("torrents/stop", "torrents/pause"))

    def resume(self, tid):
        self._toggle(tid, ("torrents/start", "torrents/resume"))

    def _toggle(self, tid, paths):
        new, old = paths
        if self._v5 is False:
            new = old
        try:
            self.client.call(new, {"hashes": tid})
        except urllib.error.HTTPError as e:
            if e.code != 404 or new == old:
                raise
            self._v5 = False
            self.client.call(old, {"hashes": tid})

    def remove(self, tid, *, delete_files=False):
        """Only Zimi's category; files only when they are not in the library."""
        row = self._info(tid)
        if row is None or row.get("category") != self.category:
            return
        if delete_files and self._in_library(
            to_local(row.get("content_path") or "", self.paths)
        ):
            delete_files = False
        self.client.call(
            "torrents/delete",
            {"hashes": tid, "deleteFiles": "true" if delete_files else "false"},
        )

    def status(self, tid):
        row = self._info(tid)
        if row is None:
            return {
                "state": "removed",
                "gid": tid,
                "completed_bytes": 0,
                "total_bytes": 0,
                "down_speed": 0,
                "up_speed": 0,
                "peers": 0,
                "seeders": 0,
                "ratio": 0.0,
                "info_hash": tid,
                "error_code": "",
                "error_message": "",
            }
        state = row.get("state", "")
        total = int(row.get("size") or row.get("total_size") or 0)
        done = int(row.get("completed") or row.get("progress", 0) * total)
        checking = state in _CHECKING_STATES
        if state in _ERROR_STATES:
            s = "error"
        elif state in _PAUSED_STATES:
            s = "paused"
        elif float(row.get("progress") or 0) >= 1.0 and not checking:
            s = "complete"
        else:
            s = "downloading"
        return {
            "state": s,
            "checking": checking,
            "gid": tid,
            "completed_bytes": done,
            "total_bytes": total,
            "down_speed": int(row.get("dlspeed") or 0),
            "up_speed": int(row.get("upspeed") or 0),
            "peers": int(row.get("num_leechs") or 0) + int(row.get("num_seeds") or 0),
            "seeders": int(row.get("num_seeds") or 0),
            "ratio": float(row.get("ratio") or 0.0),
            "info_hash": tid,
            "error_code": state if s == "error" else "",
            "error_message": f"qBittorrent reports {state}" if s == "error" else "",
        }

    def list_managed(self):
        out = []
        for row in self.client.json("torrents/info", category=self.category):
            state = row.get("state", "")
            total = int(row.get("size") or row.get("total_size") or 0)
            done = int(row.get("completed") or 0)
            out.append(
                {
                    "gid": row.get("hash", ""),
                    "status": (
                        "error"
                        if state in _ERROR_STATES
                        else (
                            "paused"
                            if state in _PAUSED_STATES
                            or state == "stoppedUP"
                            or state == "pausedUP"
                            else "active"
                        )
                    ),
                    "files": [
                        {"path": to_local(row.get("content_path") or "", self.paths)}
                    ],
                    "completedLength": str(done),
                    "uploadLength": str(int(row.get("uploaded") or 0)),
                    "totalLength": str(total),
                    "infoHash": row.get("hash", ""),
                    "seeder": (
                        "true" if float(row.get("progress") or 0) >= 1.0 else "false"
                    ),
                }
            )
        return out
