"""qBittorrent as Zimi's engine: the Web API v2 half (the rest is btclient).

Zimi's category is a qBittorrent category. qBittorrent 5 renamed pause/resume
to stop/start; both are spoken.
"""

import http.cookiejar
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid

from zimi.btclient import REQUEST_TIMEOUT_S, ClientError, ExternalBackend

# qBittorrent's states, by what Zimi does with them.
_ERROR_STATES = {"error", "missingFiles", "unknown"}
_STOPPED_STATES = {"pausedDL", "stoppedDL", "pausedUP", "stoppedUP"}
_CHECKING_STATES = {
    "checkingDL",
    "checkingUP",
    "checkingResumeData",
    "moving",
    "allocating",
}


# content_path (where a torrent's files are) arrived with Web API 2.6.1,
# qBittorrent 4.3.2; Zimi cannot install or hand over without it.
MIN_WEBAPI = (2, 6, 1)


class Client:
    """A qBittorrent Web API session. Logs in on the first 401/403 and again when
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
                raise ClientError(
                    "qBittorrent refused the login: too many failed attempts, so it has banned this address for a while"
                ) from None
            raise
        if out.strip() != b"Ok.":
            raise ClientError("qBittorrent refused the username or password")

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
                if e.code not in (401, 403):  # 5.x may say 401 for an expired session
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


def _added(out):
    """Whether torrents/add took it. Up to 5.1 the answer is "Ok." or
    "Fails."; 5.2 answers JSON counts ({"success_count": 1, ...})."""
    text = out.strip()
    if text in (b"Ok.", b""):
        return True
    try:
        counts = json.loads(text)
    except ValueError:
        return False
    return isinstance(counts, dict) and (
        counts.get("success_count", 0) + counts.get("pending_count", 0) > 0
    )


class QBittorrentBackend(ExternalBackend):
    kind = "qbittorrent"

    def __init__(self, cfg, *, library_dir, staging_dir):
        super().__init__(cfg, library_dir=library_dir, staging_dir=staging_dir)
        self.client = Client(cfg["url"], cfg["user"], cfg["password"])
        self._v5 = None

    def version(self):
        return self.client.text("app/version")

    def default_save_path(self):
        return str((self.client.json("app/preferences") or {}).get("save_path") or "")

    def _prepare(self):
        api = tuple(int(x) for x in re.findall(r"\d+", self.client.text("app/webapiVersion"))[:3])
        if api < MIN_WEBAPI:
            raise ClientError("Zimi needs qBittorrent 4.3.2 or newer (it reads where each torrent's files are)")
        self._v5 = api[:2] >= (2, 11)
        try:
            self.client.call("torrents/createCategory", {"category": self.category})
        except urllib.error.HTTPError as e:
            if e.code != 409:  # 409: it exists already
                raise

    def _normalize(self, row):
        state = row.get("state", "")
        total = int(row.get("size") or row.get("total_size") or 0)
        progress = float(row.get("progress") or 0)
        checking = state in _CHECKING_STATES
        stopped = state in _STOPPED_STATES
        if state in _ERROR_STATES:
            s = "error"
        elif progress >= 1.0 and not checking:
            s = "complete"
        elif stopped:
            s = "paused"
        else:
            s = "downloading"
        return {
            "hash": row.get("hash", ""),
            "owned": row.get("category") == self.category,
            "state": s,
            "stopped": stopped,
            "checking": checking,
            "moving": state == "moving",
            "done": int(row.get("completed") or progress * total),
            "total": total,
            "dl": int(row.get("dlspeed") or 0),
            "ul": int(row.get("upspeed") or 0),
            "peers": int(row.get("num_leechs") or 0) + int(row.get("num_seeds") or 0),
            "seeds": int(row.get("num_seeds") or 0),
            "ratio": float(row.get("ratio") or 0.0),
            "uploaded": int(row.get("uploaded") or 0),
            "content_path": row.get("content_path") or "",
            "save_dir": row.get("save_path") or "",
            "error": state,
        }

    def _row(self, tid):
        rows = self.client.json("torrents/info", hashes=tid)
        return self._normalize(rows[0]) if rows else None

    def _rows(self):
        # category=zimi also lists zimi/sub; only the exact category is Zimi's.
        rows = map(self._normalize, self.client.json("torrents/info", category=self.category))
        return [r for r in rows if r["owned"]]

    def _unlimit(self, tid):
        # -1: no limit. Zimi keeps its own ratio cap; a client rule such as
        # "at ratio 2, remove torrent and files" would delete a library ZIM.
        # 5.2 requires the action too (older versions ignore it): Stop, so
        # even a limit that did apply could never remove files.
        self.client.call(
            "torrents/setShareLimits",
            {
                "hashes": tid,
                "ratioLimit": "-1",
                "seedingTimeLimit": "-1",
                "inactiveSeedingTimeLimit": "-1",
                "shareLimitAction": "Stop",
            },
        )

    def _relabel(self, hashes, new):
        try:
            self.client.call("torrents/createCategory", {"category": new})
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
        joined = "|".join(hashes)
        # Off automatic management first, so a new category cannot move files.
        self.client.call("torrents/setAutoManagement", {"hashes": joined, "enable": "false"})
        self.client.call("torrents/setCategory", {"hashes": joined, "category": new})

    def _add(self, tid, *, data, magnet, save_dir, skip_check):
        if magnet:
            fields, files = {"urls": magnet}, None
        else:
            fields, files = {}, {"torrents": (tid + ".torrent", data)}
        fields.update({"category": self.category, "tags": "zimi"})
        if save_dir is not None:
            fields.update({"savepath": save_dir, "autoTMM": "false"})
        if skip_check:
            fields["skip_checking"] = "true"
        out = self.client.call("torrents/add", fields, files)
        # Its own listing is the last word: an answer this version words in a
        # way not read here must not leave a torrent behind while Zimi falls
        # back to HTTP for the same file.
        if not _added(out) and not self._row(tid):
            raise ClientError(
                "qBittorrent refused the torrent: "
                + out.decode("utf-8", "replace")[:200]
            )

    def _start(self, tid):
        self._toggle(tid, ("torrents/start", "torrents/resume"))

    def _stop(self, tid):
        self._toggle(tid, ("torrents/stop", "torrents/pause"))

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

    def _delete(self, tid, files):
        self.client.call(
            "torrents/delete",
            {"hashes": tid, "deleteFiles": "true" if files else "false"},
        )

    def _move(self, tid, remote_dir):
        self.client.call(
            "torrents/setLocation", {"hashes": tid, "location": remote_dir}
        )
