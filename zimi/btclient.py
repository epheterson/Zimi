"""A BitTorrent client the operator already runs, as Zimi's engine (#53), the
way the *arr apps use one.

People who run Sonarr or Radarr already have a qBittorrent or a Transmission,
often behind a VPN, and already know the model: a URL, a login, a category the
app owns, and remote path mappings for when the two containers mount the same
disk at different paths. Zimi uses the same model, so the setup is one they
have done before.

This module is the client-independent half: the configuration, the path
mappings, the probe Settings runs, and ``ExternalBackend``, which turns a
client's API into Zimi's engine. ``qbittorrent.py`` and ``transmission.py``
each speak one client's API through a handful of methods.

- Every torrent Zimi adds carries Zimi's category (a qBittorrent category, a
  Transmission label), and Zimi never lists, changes or deletes anything
  without it.
- The .torrent is uploaded rather than linked, so the info hash is known up
  front and the client needs no route to the catalog.
- Paths cross between the two through the mappings (``remote=local``). A
  download is saved where the client can be told and Zimi can see; when it
  completes, the client moves it into the library itself if it can see the
  library (and keeps seeding it there, no copy), else Zimi hardlinks or copies
  it out and the client keeps seeding its own.
- Delete-with-files is refused for anything in the library, as the built-in
  engine refuses it.
"""

import importlib
import logging
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from zimi.p2p import BTBackend

log = logging.getLogger("zimi.btclient")

DEFAULT_CATEGORY = "zimi"
REQUEST_TIMEOUT_S = 20
# A move into the library happens on the client's side; a big ZIM across
# volumes takes minutes. Polled at this interval, given up after the limit.
MOVE_POLL_S = 2.0
MOVE_LIMIT_S = 6 * 3600
# A move nothing comes of gives up once the file at the destination has not
# changed for this long: a real move, even of a huge ZIM across disks, changes
# it as it writes. While the client still says "moving" and nothing has
# arrived, the move may be queued behind others (qBittorrent moves one at a
# time), so only MOVE_LIMIT_S applies.
MOVE_STALL_S = 600
# The torrent list a poll reads (Activity, every 5 s per open tab) is at most
# this old; a background refresh fetches the next, so no poll waits on the
# client or its lock.
ROWS_FRESH_S = 10.0

# kind: (the name people know it by, module, class)
KINDS = {
    "qbittorrent": ("qBittorrent", "zimi.qbittorrent", "QBittorrentBackend"),
    "transmission": ("Transmission", "zimi.transmission", "TransmissionBackend"),
}

ENV = {
    "kind": "ZIMI_BT_CLIENT",
    "url": "ZIMI_BT_CLIENT_URL",
    "user": "ZIMI_BT_CLIENT_USER",
    "password": "ZIMI_BT_CLIENT_PASSWORD",
    "category": "ZIMI_BT_CLIENT_CATEGORY",
    "paths": "ZIMI_BT_CLIENT_PATHS",
}
PREF = {k: "bt_client" if k == "kind" else "bt_client_" + k for k in ENV}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A client that redirects (a forward-auth proxy's login page) is an
    error to report, never a host to send the login on to."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


class ClientError(RuntimeError):
    """A plain sentence for the operator: what failed and what to change."""


# ── configuration ───────────────────────────────────────────────────────────


def env_locked():
    """The environment owns the engine: ZIMI_BT_CLIENT or its URL is set."""
    return any(os.environ.get(ENV[k], "").strip() for k in ("kind", "url"))


def env_var():
    """The variable that locks it, for Settings to name."""
    for k in ("kind", "url"):
        if os.environ.get(ENV[k], "").strip():
            return ENV[k]
    return None


def config():
    """{kind, url, user, password, category, paths}, or None for the built-in
    engine. When the environment sets ZIMI_BT_CLIENT or its URL, the whole
    connection comes from there; otherwise from Settings. A URL without a
    kind is a qBittorrent, the common one."""
    if env_locked():
        raw = {k: os.environ.get(v, "") for k, v in ENV.items()}
    else:
        from zimi import p2p

        prefs = p2p._read_prefs()
        raw = {k: prefs.get(PREF[k], "") for k in ENV}
    url = str(raw["url"] or "").strip().rstrip("/")
    kind = str(raw["kind"] or "").strip().lower() or ("qbittorrent" if url else "")
    if kind not in KINDS or not url:
        if kind and kind not in KINDS and kind not in ("builtin", "libtorrent"):
            log.warning(
                "ZIMI_BT_CLIENT=%s is not a client Zimi knows; using the built-in engine",
                kind,
            )
        return None
    return {
        "kind": kind,
        "url": url,
        "user": str(raw["user"] or "").strip(),
        "password": str(raw["password"] or ""),
        "category": str(raw["category"] or "").strip() or DEFAULT_CATEGORY,
        "paths": parse_paths(raw["paths"]),
    }


def label(kind):
    return KINDS[kind][0] if kind in KINDS else loggable(kind)


def valid_url(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def same_url(a, b):
    """The same client typed two ways: scheme and host case, a trailing
    slash, Transmission's /transmission/web or /rpc, or nothing."""

    def norm(u):
        parts = urllib.parse.urlsplit((u or "").strip())
        path = parts.path.rstrip("/")
        for tail in ("/transmission/web", "/transmission/rpc", "/transmission"):
            if path.endswith(tail):
                path = path[: -len(tail)].rstrip("/")
                break
        return (parts.scheme.lower(), parts.netloc.lower(), path)

    return norm(a) == norm(b)


def identity(cfg):
    """What makes two configurations the same engine: switching between them
    hands nothing over."""
    parts = urllib.parse.urlsplit(cfg["url"])
    path = re.sub(r"/(transmission(/web|/rpc)?)?/*$", "", parts.path)
    return (cfg["kind"], parts.scheme.lower(), parts.netloc.lower(), path, cfg["category"])


def backend_class(kind):
    _, module, cls = KINDS[kind]
    return getattr(importlib.import_module(module), cls)


def make_backend(cfg, *, library_dir, staging_dir):
    return backend_class(cfg["kind"])(
        cfg, library_dir=library_dir, staging_dir=staging_dir
    )


# ── path mappings ──────────────────────────────────────────────────────────


def parse_paths(text):
    """``remote=local`` pairs, one per line or ``;``-separated, as
    [(remote, local)]. Lines without ``=`` are dropped."""
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
    if sep == "\\":  # Windows paths: C:\Dl and c:\dl are one folder
        path, root = path.lower(), root.lower()
    return path == root or path.startswith(root.rstrip(sep) + sep)


def _swap(path, src, dst, sep_in, sep_out):
    rest = path[len(src.rstrip(sep_in)) :].lstrip(sep_in)
    if not rest:
        return dst
    return dst.rstrip(sep_out) + sep_out + rest.replace(sep_in, sep_out)


def _sep(path):
    return "\\" if re.match(r"^[A-Za-z]:\\", path or "") else "/"


def to_local(remote, pairs):
    """The client's path as Zimi sees it. Without a mapping that covers it,
    the same path (both mount it at the same place, the *arr default)."""
    if not remote:
        return remote
    rs = _sep(remote)
    for r, l in sorted(pairs, key=lambda p: -len(p[0])):
        if _under(remote, r, rs):
            # normpath: on Windows a local half typed with / still comes back
            # as one path with one separator.
            return os.path.normpath(_swap(remote, r, l, rs, os.sep))
    return remote


def to_remote(local, pairs):
    """Zimi's path as the client sees it, or None when no mapping covers it:
    Zimi then does not know whether the client can reach it."""
    local = os.path.abspath(local)
    for r, l in sorted(pairs, key=lambda p: -len(p[1])):
        if _under(local, os.path.abspath(l), os.sep):
            return _swap(local, os.path.abspath(l), r, os.sep, _sep(r))
    return None


# ── the probe Settings runs ─────────────────────────────────────────────────


def loggable(value):
    """A value the admin typed (an address), safe on one log line."""
    return str(value).replace("\r", "\\r").replace("\n", "\\n")


def _reason(cfg, e):
    """What went wrong reaching the client, as a key the browser words in
    its own language; the details go to the log, never to the page."""
    log.info("%s at %s: %s", label(cfg["kind"]), loggable(cfg["url"]), loggable(e))
    if isinstance(e, ClientError):
        return {"error": str(e)}  # our own sentence (login refused, too old)
    if isinstance(e, urllib.error.HTTPError):
        return {"error_key": "btc_err_http", "code": e.code}
    return {"error_key": "btc_err_unreachable"}


def probe(cfg, library_dir=None):
    """Test a configuration: {ok, version, save_path, visible, library_mapped}
    or {ok: False, error}. ``visible`` is whether Zimi can see the client's
    default save folder through the mappings; ``library_mapped`` whether the
    client can see the library (needed to seed what is already there)."""
    b = make_backend(cfg, library_dir=library_dir, staging_dir=None)
    try:
        version = b.version()
        b._prepare()  # what Save needs: new enough, the category made
        save = b.default_save_path()
    except Exception as e:  # anything a client can answer: a sentence, not a 500
        return {"ok": False, **_reason(cfg, e)}
    local = to_local(save, cfg["paths"])
    return {
        "ok": True,
        "client": label(cfg["kind"]),
        "version": version,
        "save_path": save,
        "local_save_path": local,
        "visible": bool(local) and os.path.isdir(local),
        "library_mapped": b.sees_library(),
    }


# ── the engine ─────────────────────────────────────────────────────────────


class ExternalBackend(BTBackend):
    """BTBackend over a client the operator already runs. Torrent ids are v1
    info-hash hex, as with the built-in engine, so the library's records carry
    over between engines.

    A client adapter supplies ``version``, ``default_save_path``, ``_prepare``
    (check it is new enough, make the category), ``_row``/``_rows`` (one
    torrent, or all of Zimi's, as the normalized row below), ``_add``,
    ``_start``, ``_stop``, ``_delete``, ``_move``, ``_unlimit`` (no seeding
    limits of the client's own) and ``_relabel`` (another category).

    The normalized row: hash, owned (in Zimi's category), state
    (downloading | paused | complete | error), stopped, checking, moving,
    done, total, dl, ul, peers, seeds, ratio, uploaded, content_path and
    save_dir (the client's paths), error.
    """

    external = True
    kind = ""

    def __init__(self, cfg, *, library_dir, staging_dir):
        self.cfg = cfg
        self.category = cfg["category"]
        self.paths = cfg["paths"]
        self.library_dir = library_dir
        self.staging_dir = staging_dir
        self._stopped = False
        self._snap = (float("-inf"), [])
        self._snap_lock = threading.Lock()
        self._snap_busy = False

    @property
    def name(self):
        return label(self.kind)

    def identity(self):
        return identity(self.cfg)

    # ── lifecycle ──

    def available(self):
        try:
            version = self.version()
            self._prepare()
        except Exception as e:
            log.warning("%s at %s not usable: %s", self.name, loggable(self.cfg["url"]), loggable(e))
            return False
        log.info(
            "%s %s at %s is the BitTorrent engine (category %s)",
            self.name,
            version,
            self.cfg["url"],
            self.category,
        )
        return True

    def is_alive(self):
        return not self._stopped

    def stop(self):
        # The client keeps running and keeps its torrents; Zimi just stops
        # talking to it. A download in flight resumes on the next start.
        self._stopped = True

    def web_ui_url(self, tid=None):
        return self.cfg["url"] + "/"

    def release(self):
        """Another engine takes over: take Zimi's torrents out of the client.
        In-flight ones go with their partial files (the next engine starts
        them again); finished ones go without touching the library, so the
        next engine seeds the library file; a finished copy of the client's
        own goes with its files once the library has the same file. Returns
        how many it took out."""
        n = 0
        for row in self._rows():
            if row["moving"] or row["checking"]:
                # Moving into the library or rechecking: the path still names
                # the old folder, and deleting with files would lose it.
                continue
            local = to_local(row["content_path"], self.paths)
            complete = row["state"] == "complete" or (
                row["total"] and row["done"] >= row["total"]
            )
            if not complete:
                # Partial files go only when Zimi sees them outside the
                # library: an unmapped path may still be a library ZIM.
                files = bool(local) and os.path.exists(local) and not self._in_library(local)
            elif self._in_library(local):
                files = False
            else:
                lib = os.path.join(self.library_dir or "", os.path.basename(local))
                if not (os.path.isfile(lib) and os.path.getsize(lib) == row["total"]):
                    continue  # not one Zimi installed: leave it be
                # Its own copy goes with its files only when Zimi can see it
                # is a second file, never the library's under another name.
                try:
                    files = os.path.isfile(local) and not os.path.samefile(local, lib)
                except OSError:
                    files = False
            try:
                self._delete(row["hash"], files)
                n += 1
            except Exception as e:
                log.debug("%s: could not hand over %s: %s", self.name, row["hash"], e)
        if n:
            log.info(
                "%s: handed over %d torrent(s) from category %s",
                self.name,
                n,
                self.category,
            )
        return n

    # ── paths ──

    def sees_library(self):
        return (
            bool(self.library_dir)
            and to_remote(self.library_dir, self.paths) is not None
        )

    def _in_library(self, local):
        if not local or not self.library_dir:
            return False
        return _under(
            os.path.realpath(local), os.path.realpath(self.library_dir), os.sep
        )

    def payload_path(self, tid, filename, staging_dir):
        row = self._row(tid)
        if not row:
            return os.path.join(staging_dir, filename)
        return to_local(row["content_path"] or "", self.paths)

    def install(self, tid, src, dest):
        """Put the finished file at ``dest``. The client moves it itself when
        it can see the library, and keeps seeding it there; otherwise a
        hardlink, else a copy, and the client keeps seeding its own."""
        self._owned_row(tid)
        remote_dir = to_remote(os.path.dirname(dest), self.paths)
        if remote_dir is not None:
            self._move(tid, remote_dir)
            deadline = time.monotonic() + MOVE_LIMIT_S
            seen, changed_at = None, time.monotonic()
            while time.monotonic() < deadline:
                row = self._row(tid)
                if row is None:
                    raise ClientError(
                        f"the torrent left {self.name} while it was being moved"
                    )
                if row["state"] == "error":
                    raise ClientError(f"{self.name} could not move it: {row['error']}")
                arrived = os.path.exists(dest) and (
                    not row["total"] or os.path.getsize(dest) == row["total"]
                )
                if not row["moving"] and arrived:
                    return tid
                if self.retired:
                    raise ClientError(f"{self.name} is no longer the engine")
                try:
                    st = os.stat(dest)
                    now = (st.st_size, st.st_mtime_ns, getattr(st, "st_blocks", 0))
                except OSError:
                    now = None
                queued = row["moving"] and now is None
                if now != seen or queued:
                    seen, changed_at = now, time.monotonic()
                elif time.monotonic() - changed_at > MOVE_STALL_S:
                    raise ClientError(f"{self.name} is not moving the file")
                time.sleep(MOVE_POLL_S)
            raise ClientError(
                f"{self.name} did not finish moving the file into the library"
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
        magnet = None
        data = None
        if source.startswith("magnet:"):
            m = re.search(r"xt=urn:btih:([0-9a-fA-F]{40})", source)
            if not m:
                raise ClientError("magnet link without a v1 info hash")
            tid, magnet = m.group(1).lower(), source
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
                raise ClientError("not a .torrent file")
        remote = to_remote(dest_dir, self.paths)
        if remote is None and self._in_library(dest_dir):
            # Seeding what is already in the library needs the client to see
            # it; saving it elsewhere would download a second copy.
            raise ClientError(
                f"{self.name} cannot see the library: add a path mapping for "
                + os.path.abspath(dest_dir)
            )
        row = self._row(tid)
        if row:
            if not row["owned"]:
                # The same file under someone else's category: theirs. Zimi
                # neither adopts nor moves it; the download goes over HTTP.
                raise ClientError(
                    f"{self.name} already has this torrent outside the {self.category} category"
                )
            # Already there: a restart picking up its download, running again
            # if Zimi had paused it, and kept clear of the client's limits.
            self._keep_unlimited(tid)
            if row["stopped"] and row["state"] != "complete":
                self._start(tid)
            return tid
        self._add(
            tid,
            data=data,
            magnet=magnet,
            save_dir=remote,
            skip_check=bool(options and options.get("seed_mode")),
        )
        # The add can be asynchronous; wait for it to show so status() is honest.
        for _ in range(50):
            if self._row(tid):
                self._keep_unlimited(tid)
                return tid
            time.sleep(0.1)
        raise ClientError(f"{self.name} accepted the torrent but never listed it")

    def _owned_row(self, tid):
        row = self._row(tid)
        if row is not None and not row["owned"]:
            raise ClientError(f"not in the {self.category} category")
        return row

    def lift_limits(self):
        """Every torrent of Zimi's clear of the client's own seeding limits:
        the ones already there when the engine starts too, not only those it
        adds (an earlier version, or a client upgrade, may have left them
        under a rule that removes files)."""
        for row in self._rows():
            self._keep_unlimited(row["hash"])

    def _keep_unlimited(self, tid):
        try:
            self._unlimit(tid)
        except Exception as e:
            log.warning("%s: could not lift its seeding limits on %s: %s", self.name, tid, e)

    def recategorize(self, new):
        """Only the category changed: relabel Zimi's torrents in place. Nothing
        is handed over, re-added or re-checked."""
        hashes = [r["hash"] for r in self._rows()]
        if hashes:
            self._relabel(hashes, new)
        log.info("%s: %d torrent(s) moved from category %s to %s", self.name, len(hashes), self.category, new)
        self.category = self.cfg["category"] = new

    def _owned(self, tid):
        row = self._row(tid)
        return bool(row and row["owned"])

    def pause(self, tid):
        if self._owned(tid):  # never someone else's torrent
            self._stop(tid)

    def resume(self, tid):
        if self._owned(tid):
            self._start(tid)

    def remove(self, tid, *, delete_files=False):
        """Only Zimi's category; files only when Zimi can see them and they
        are not in the library. A folder mapping removed or mistyped leaves the
        client's path untranslated, pointing nowhere Zimi can see, while the
        client may still reach a library ZIM through it: what Zimi cannot
        confirm is outside the library stays."""
        row = self._row(tid)
        if row is None or not row["owned"]:
            return
        local = to_local(row["content_path"] or "", self.paths)
        if delete_files and (not local or not os.path.exists(local) or self._in_library(local)):
            delete_files = False
        self._delete(tid, delete_files)

    def status(self, tid):
        row = self._row(tid)
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
        s = row["state"]
        return {
            "state": s,
            "checking": row["checking"],
            "gid": tid,
            "completed_bytes": row["done"],
            "total_bytes": row["total"],
            "down_speed": row["dl"],
            "up_speed": row["ul"],
            "peers": row["peers"],
            "seeders": row["seeds"],
            "ratio": row["ratio"],
            "info_hash": tid,
            "error_code": "error" if s == "error" else "",
            "error_message": (
                f"{self.name} reports {row['error']}" if s == "error" else ""
            ),
        }

    def list_managed_cached(self):
        """list_managed for a poll: the last list (empty until the first
        arrives), refreshed in the background once stale. Never a round trip
        of its own."""
        with self._snap_lock:
            at, rows = self._snap
            if time.monotonic() - at > ROWS_FRESH_S and not self._snap_busy:
                self._snap_busy = True
                threading.Thread(target=self._refresh_snap, daemon=True, name="btclient-rows").start()
        return rows

    def _refresh_snap(self):
        try:
            rows = self.list_managed()
        except Exception as e:
            log.debug("%s: torrent list for Activity: %s", self.name, loggable(e))
            rows = None
        with self._snap_lock:
            if rows is not None:
                self._snap = (time.monotonic(), rows)
            self._snap_busy = False

    def list_managed(self):
        out = []
        for row in self._rows():
            if row["state"] == "error":
                status = "error"
            elif row["stopped"]:
                status = "paused"
            else:
                status = "active"
            out.append(
                {
                    "gid": row["hash"],
                    "status": status,
                    "files": [
                        {"path": to_local(row["content_path"] or "", self.paths)}
                    ],
                    "completedLength": str(row["done"]),
                    "uploadLength": str(row["uploaded"]),
                    "totalLength": str(row["total"]),
                    "infoHash": row["hash"],
                    "seeder": "true" if row["state"] == "complete" else "false",
                }
            )
        return out
