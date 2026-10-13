"""Transmission as Zimi's engine: the RPC half (the rest is btclient).

Zimi's category is a Transmission label, which needs Transmission 3.00 or
newer (RPC version 16). The RPC hands out a session id on a 409 and wants it
back on every request; a username and password go as Basic auth.
"""

import base64
import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request

from zimi.btclient import NO_REDIRECT, REQUEST_TIMEOUT_S, ClientError, ExternalBackend

log = logging.getLogger("zimi.transmission")

RPC_PATH = "/transmission/rpc"
MIN_RPC_VERSION = 16  # labels, Transmission 3.00
SESSION_HEADER = "X-Transmission-Session-Id"

# torrent-get's status numbers.
STOPPED, CHECK_WAIT, CHECKING = 0, 1, 2
# torrent-get's error numbers: 1 and 2 are the tracker's, which a swarm rides
# out; 3 is the local disk.
LOCAL_ERROR = 3

FIELDS = [
    "hashString",
    "name",
    "status",
    "percentDone",
    "sizeWhenDone",
    "leftUntilDone",
    "rateDownload",
    "rateUpload",
    "peersConnected",
    "peersSendingToUs",
    "uploadRatio",
    "uploadedEver",
    "downloadDir",
    "labels",
    "error",
    "errorString",
]


def rpc_url(url):
    """The RPC endpoint for what someone typed: the web UI's address, the host
    and port, or the RPC URL itself."""
    parts = urllib.parse.urlsplit(url.rstrip("/"))
    path = parts.path
    if not path.endswith("/rpc"):
        path = (path[: -len("/web")] if path.endswith("/web") else path) or ""
        path = path if path.endswith("/transmission") else path + "/transmission"
        path += "/rpc"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, "", ""))


class Client:
    def __init__(self, url, user="", password=""):
        self.url = rpc_url(url)
        self._auth = None
        if user or password:
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            self._auth = "Basic " + token
        self._session = ""
        self._lock = threading.Lock()

    def _post(self, body):
        req = urllib.request.Request(self.url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if self._session:
            req.add_header(SESSION_HEADER, self._session)
        if self._auth:
            req.add_header("Authorization", self._auth)
        with NO_REDIRECT.open(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return resp.read()

    def call(self, method, **arguments):
        body = json.dumps({"method": method, "arguments": arguments}).encode()
        with self._lock:
            for _ in range(2):
                try:
                    out = self._post(body)
                    break
                except urllib.error.HTTPError as e:
                    if e.code == 409 and e.headers.get(SESSION_HEADER):
                        self._session = e.headers[SESSION_HEADER]
                        continue
                    if e.code == 401:
                        raise ClientError(
                            "Transmission refused the username or password"
                        ) from None
                    if e.code == 403:
                        raise ClientError(
                            "Transmission refused this address: add it to rpc-whitelist in its settings"
                        ) from None
                    raise
            else:
                raise ClientError("Transmission kept asking for a new session")
        try:
            answer = json.loads(out)
        except ValueError:
            raise ClientError(f"no Transmission RPC at {self.url}") from None
        if answer.get("result") != "success":
            # The client's own words go to the log; the page gets ours.
            log.info("Transmission answered %s: %s", method, str(answer.get("result"))[:200])
            raise ClientError(f"Transmission refused the request ({method})")
        return answer.get("arguments") or {}


class TransmissionBackend(ExternalBackend):
    kind = "transmission"

    def __init__(self, cfg, *, library_dir, staging_dir):
        super().__init__(cfg, library_dir=library_dir, staging_dir=staging_dir)
        self.client = Client(cfg["url"], cfg["user"], cfg["password"])
        self._session = None
        self._moves = {}  # tid -> the folder it is being moved to
        self._moves_lock = threading.Lock()  # status polls and installs share it

    def _session_info(self):
        self._session = self.client.call("session-get")
        return self._session

    def version(self):
        return str(self._session_info().get("version", "")).split(" ")[0]

    def default_save_path(self):
        return str((self._session or self._session_info()).get("download-dir") or "")

    def _prepare(self):
        info = self._session or self._session_info()
        if int(info.get("rpc-version") or 0) < MIN_RPC_VERSION:
            raise ClientError("Zimi needs Transmission 3.00 or newer (for labels)")

    def web_ui_url(self, tid=None):
        return self.client.url[: -len("/rpc")] + "/web/"

    def _normalize(self, t):
        tid = t.get("hashString", "")
        status = int(t.get("status") or 0)
        total = int(t.get("sizeWhenDone") or 0)
        left = int(t.get("leftUntilDone") or 0)
        checking = status in (CHECK_WAIT, CHECKING)
        stopped = status == STOPPED
        if int(t.get("error") or 0) == LOCAL_ERROR:
            s = "error"
        elif float(t.get("percentDone") or 0) >= 1.0 and not checking:
            s = "complete"
        elif stopped:
            s = "paused"
        else:
            s = "downloading"
        save = t.get("downloadDir") or ""
        with self._moves_lock:
            target = self._moves.get(tid)
            moving = target is not None and save.rstrip("/\\") != target.rstrip("/\\")
            if target is not None and not moving:
                self._moves.pop(tid, None)
        sep = "\\" if "\\" in save and "/" not in save else "/"
        ratio = float(t.get("uploadRatio") or 0.0)
        return {
            "hash": tid,
            "owned": self.category in (t.get("labels") or []),
            "state": s,
            "stopped": stopped,
            "checking": checking,
            "moving": moving,
            "done": max(total - left, 0),
            "total": total,
            "dl": int(t.get("rateDownload") or 0),
            "ul": int(t.get("rateUpload") or 0),
            "peers": int(t.get("peersConnected") or 0),
            "seeds": int(t.get("peersSendingToUs") or 0),
            "ratio": max(ratio, 0.0),  # -1 means none yet
            "uploaded": int(t.get("uploadedEver") or 0),
            "content_path": (
                (save.rstrip(sep) + sep + t.get("name", "")) if save else ""
            ),
            "save_dir": save,
            "error": t.get("errorString") or "an error",
        }

    def _row(self, tid):
        got = (
            self.client.call("torrent-get", ids=[tid], fields=FIELDS).get("torrents")
            or []
        )
        return self._normalize(got[0]) if got else None

    def _rows(self):
        got = self.client.call("torrent-get", fields=FIELDS).get("torrents") or []
        return [r for r in map(self._normalize, got) if r["owned"]]

    def _add(self, tid, *, data, magnet, save_dir, skip_check):
        # Transmission has no way to skip the check; seeding a library file
        # costs one read of it.
        args: dict = {"paused": False}
        if magnet:
            args["filename"] = magnet
        else:
            args["metainfo"] = base64.b64encode(data).decode()
        if save_dir is not None:
            args["download-dir"] = save_dir
        out = self.client.call("torrent-add", **args)
        if not (out.get("torrent-added") or out.get("torrent-duplicate")):
            raise ClientError("Transmission refused the torrent")
        # Labels on torrent-add arrived with RPC 17; torrent-set has them from 16.
        try:
            self.client.call("torrent-set", ids=[tid], labels=[self.category])
        except Exception:
            # Unlabelled it is no torrent Zimi may touch again: take it back
            # out (its files stay) rather than leave it running unmanaged.
            if out.get("torrent-added"):
                try:
                    self._delete(tid, False)
                except Exception as e:
                    log.warning("Transmission: an unlabelled torrent %s stays: %s", tid, e)
            raise

    def _unlimit(self, tid):
        # 2: unlimited. Zimi keeps its own ratio cap; the session's ratio or
        # idle limit would stop or remove a seed Zimi still wants.
        self.client.call("torrent-set", ids=[tid], seedRatioMode=2, seedIdleMode=2)

    def _relabel(self, hashes, new):
        got = self.client.call("torrent-get", ids=list(hashes), fields=["hashString", "labels"])
        for t in got.get("torrents") or []:
            labels = [x for x in (t.get("labels") or []) if x != self.category] + [new]
            self.client.call("torrent-set", ids=[t["hashString"]], labels=labels)

    def _start(self, tid):
        self.client.call("torrent-start", ids=[tid])

    def _stop(self, tid):
        self.client.call("torrent-stop", ids=[tid])

    def _delete(self, tid, files):
        self.client.call(
            "torrent-remove", ids=[tid], **{"delete-local-data": bool(files)}
        )

    def _move(self, tid, remote_dir):
        with self._moves_lock:
            self._moves[tid] = remote_dir
        try:
            self.client.call(
                "torrent-set-location", ids=[tid], location=remote_dir, move=True
            )
        except Exception:
            # Refused: no move is coming, so the torrent must not read as moving.
            with self._moves_lock:
                self._moves.pop(tid, None)
            raise
