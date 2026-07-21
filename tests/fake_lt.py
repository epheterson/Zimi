"""In-memory fake of the libtorrent 2.0 Python API surface Zimi uses.

Tests inject this as zimi.p2p._lt_module so LibtorrentBackend runs
without the real (unimportable-on-dev-Mac) libtorrent. Only what the
backend touches is implemented — if the backend starts using a new lt
API, add it here first (that's the point: the fake IS the contract).
"""

import os


class _Enum(int):
    pass


class torrent_flags:
    paused = 1 << 0
    auto_managed = 1 << 1
    update_subscribe = 1 << 2
    upload_mode = 1 << 3


class torrent_status:
    # state enum values (match lt names, not numbers — code compares identities)
    checking_files = _Enum(1)
    downloading_metadata = _Enum(2)
    downloading = _Enum(3)
    finished = _Enum(4)
    seeding = _Enum(5)
    checking_resume_data = _Enum(7)

    def __init__(self):
        self.state = torrent_status.downloading
        self.flags = 0
        self.total_done = 0
        self.total_wanted = 0
        self.download_payload_rate = 0
        self.upload_payload_rate = 0
        self.num_peers = 0
        self.num_seeds = 0
        self.all_time_upload = 0
        self.save_path = ""
        self.name = ""
        self.errc = _ErrorCode(0, "")


class _ErrorCode:
    def __init__(self, value, message):
        self._value = value
        self._message = message

    def value(self):
        return self._value

    def message(self):
        return self._message


class _FileStorage:
    def __init__(self, paths):
        self._paths = paths

    def num_files(self):
        return len(self._paths)

    def file_path(self, i):
        return self._paths[i]


class _TorrentInfo:
    def __init__(self, name="test.zim", size=1000, paths=None):
        self._name = name
        self._size = size
        self._paths = paths or [name]

    def name(self):
        return self._name

    def total_size(self):
        return self._size

    def files(self):
        return _FileStorage(self._paths)


class _InfoHashes:
    def __init__(self, hex_v1):
        self.v1 = _Sha1(hex_v1)


class _Sha1:
    def __init__(self, hex_str):
        self._hex = hex_str

    def __str__(self):
        return self._hex


class add_torrent_params:
    def __init__(self, hex_v1="a" * 40, ti=None):
        self.save_path = ""
        # Mirror real libtorrent 2.0's trap: a fresh add_torrent_params
        # defaults flags to BOTH paused AND auto_managed. The backend must
        # strip both (auto_managed so we're the manager, paused so it ever
        # starts). If the fake only set auto_managed, deleting the
        # paused-strip in add_torrent would still pass every Mac test while
        # shipping a BT path that sits paused forever (caught in Docker).
        self.flags = torrent_flags.paused | torrent_flags.auto_managed
        self.ti = ti
        self.info_hashes = _InfoHashes(hex_v1)
        self.name = ti.name() if ti else ""


class torrent_handle:
    def __init__(self, atp):
        self._atp = atp
        self._status = torrent_status()
        self._status.save_path = atp.save_path
        self._status.name = atp.name
        if atp.ti is not None:
            self._status.total_wanted = atp.ti.total_size()
        self._valid = True
        self._paused = bool(atp.flags & torrent_flags.paused)
        # True right after add; flips False once resume data is saved.
        # Tests can script it directly to exercise the conditional path.
        self._need_resume = True

    def is_valid(self):
        return self._valid

    def status(self):
        if self._paused:
            self._status.flags |= torrent_flags.paused
        else:
            self._status.flags &= ~torrent_flags.paused
        return self._status

    def torrent_file(self):
        return self._atp.ti

    def info_hashes(self):
        return self._atp.info_hashes

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def need_save_resume_data(self):
        return self._need_resume

    def save_resume_data(self, flags=0):
        self._need_resume = False
        self._session._alerts.append(save_resume_data_alert(self))

    def unset_flags(self, flags):
        self._atp.flags &= ~flags


class save_resume_data_alert:
    def __init__(self, handle):
        self.handle = handle
        self.params = handle._atp

    def what(self):
        return "save_resume_data"


class save_resume_data_failed_alert:
    def __init__(self, handle):
        self.handle = handle

    def what(self):
        return "save_resume_data_failed"


class session:
    delete_files = 1

    def __init__(self, settings=None):
        self.settings = dict(settings or {})
        self._torrents = {}
        self._alerts = []
        self.removed = []  # (hex, delete_files_flag) — test hook
        # Scriptable async-remove: real remove_torrent is async, so a just-
        # removed torrent lingers (still valid, old save_path) for a window.
        # Set >0 to make a removed torrent survive that many add_torrent
        # attempts — each raising "duplicate" with find_torrent returning the
        # stale handle — before it really clears. Exercises add_torrent's
        # duplicate-retry path.
        self.remove_delay = 0
        self._pending_removes = {}  # hex -> remaining add attempts before real clear

    def add_torrent(self, atp):
        hexh = str(atp.info_hashes.v1)
        if hexh in self._pending_removes:
            self._pending_removes[hexh] -= 1
            if self._pending_removes[hexh] <= 0:
                # Window closed — the lingering removing torrent finally clears.
                del self._pending_removes[hexh]
                old = self._torrents.pop(hexh, None)
                if old is not None:
                    old._valid = False
        if hexh in self._torrents:
            raise RuntimeError("torrent already exists in session")
        h = torrent_handle(atp)
        h._session = self
        self._torrents[hexh] = h
        return h

    def find_torrent(self, sha1):
        return self._torrents.get(str(sha1))

    def remove_torrent(self, handle, flags=0):
        hexh = str(handle._atp.info_hashes.v1)
        self.removed.append((hexh, bool(flags & session.delete_files)))
        if self.remove_delay > 0:
            # Async remove: torrent lingers (valid, old save_path) for N more
            # add attempts, then really goes. Handle stays valid meanwhile.
            self._pending_removes[hexh] = self.remove_delay
            return
        self._torrents.pop(hexh, None)
        handle._valid = False

    def apply_settings(self, settings):
        self.settings.update(settings)

    def pop_alerts(self):
        out, self._alerts = self._alerts, []
        return out

    def pause(self):
        self.settings["_paused"] = True


class alert:
    class category_t:
        status_notification = 1 << 0
        error_notification = 1 << 1
        storage_notification = 1 << 2


def parse_magnet_uri(uri):
    # magnet:?xt=urn:btih:<40 hex>...
    marker = "btih:"
    i = uri.index(marker) + len(marker)
    return add_torrent_params(hex_v1=uri[i : i + 40].lower())


def load_torrent_file(path):
    name = os.path.basename(path).replace(".torrent", "")
    import hashlib

    hexh = hashlib.sha1(path.encode()).hexdigest()
    return add_torrent_params(hex_v1=hexh, ti=_TorrentInfo(name=name))


def load_torrent_buffer(buf):
    import hashlib

    hexh = hashlib.sha1(bytes(buf)).hexdigest()
    return add_torrent_params(hex_v1=hexh, ti=_TorrentInfo(name="from-buffer.zim"))


def read_resume_data(buf):
    import json

    d = json.loads(bytes(buf).decode())
    atp = add_torrent_params(hex_v1=d["hex"], ti=_TorrentInfo(name=d["name"]))
    atp.save_path = d["save_path"]
    return atp


def write_resume_data_buf(atp):
    import json

    return json.dumps(
        {
            "hex": str(atp.info_hashes.v1),
            "name": atp.name or "unknown",
            "save_path": atp.save_path,
        }
    ).encode()


version = "fake-2.0"
