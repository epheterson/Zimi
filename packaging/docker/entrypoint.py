#!/usr/bin/env python3
"""Container entrypoint: take ownership of a fresh data folder, then run as `zimi`.

Docker creates a bind-mounted folder that does not exist yet as root:root, and
the server runs as the unprivileged `zimi` user (uid 1000), which then cannot
write its own state and refuses to start. Platforms that create the folder for
you (Project NOMAD's custom apps, Portainer, Unraid templates) hit this on the
first run. So the image starts as root for the length of one chown and drops
privileges before Zimi's code runs.

What it touches, and what it never does:

* The data folder (--data-dir, else ZIMI_DATA_DIR), and Zimi's own library
  folder (--zim-dir, else ZIM_DIR) only while it is empty: a fresh mount has
  no files to be wrong about. Never a library folder that holds files, and
  never an extra or read-only one (ZIMI_EXTRA_ZIM_DIRS): those are somebody's.
* Only when the folder is owned by root and `zimi` cannot already write to it.
  A folder some other user owns is left alone and the error says how to fix it.
* Started with --user (or runAsUser), the process is not root, so nothing is
  attempted: a data folder it cannot write is named on stderr and the server's
  own check then stops with its message.

Standard library only, and it must not import `zimi` (that package binds paths
at import time, and this runs as root).
"""

import os
import pwd
import sys

RUN_AS = "zimi"


def folder_from(argv, environ, flag, variable):
    """A folder the server will use (the flag beats the environment), or None."""
    for i, arg in enumerate(argv):
        if arg == flag and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith(flag + "="):
            return arg.split("=", 1)[1]
    return environ.get(variable) or None


#: Where the server's port is written for the health check, which runs as its
#: own process and cannot see which port this chose (NOMAD's is kiwix-serve's).
PORT_FILE = "/tmp/zimi-port"


def note_port(argv, environ):
    """Write the port the server will listen on to PORT_FILE (the flag beats
    ZIMI_PORT); with neither, the health check's own default stands."""
    port = folder_from(argv, environ, "--port", "ZIMI_PORT")
    try:
        if port:
            # Written as root before the drop: never through a link left there.
            fd = os.open(PORT_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(port)
        elif os.path.exists(PORT_FILE):
            os.remove(PORT_FILE)
    except OSError:
        pass


def data_dir_from(argv, environ):
    """The data folder the server will use, or None when it derives its own."""
    return folder_from(argv, environ, "--data-dir", "ZIMI_DATA_DIR")


def _writable_by(uid, gid, path):
    """Whether (uid, gid) can create files in path, tested by being that user."""
    saved = (os.geteuid(), os.getegid())
    try:
        os.setegid(gid)
        os.seteuid(uid)
        # effective_ids: plain access() asks about the REAL uid, still root here
        return os.access(path, os.W_OK | os.X_OK, effective_ids=True)
    finally:
        os.seteuid(saved[0])
        os.setegid(saved[1])


def _chown_tree(root, uid, gid):
    """chown -R without following symlinks (a link must not reach elsewhere)."""
    os.lchown(root, uid, gid)
    for here, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            try:
                os.lchown(os.path.join(here, name), uid, gid)
            except FileNotFoundError:
                pass


def take_ownership(path, uid, gid, create=True, empty_only=False):
    """Make a folder usable by uid. Returns a message when it could not.

    ``create=False`` leaves a missing folder missing. ``empty_only`` leaves a
    folder that holds anything alone: a library's files are not ours to chown."""
    if not os.path.isdir(path):
        if not create:
            return None
        try:
            os.makedirs(path, exist_ok=True)
            os.lchown(path, uid, gid)
        except OSError as e:
            return f"could not create {path} ({e.strerror})"
        return None
    if _writable_by(uid, gid, path):
        return None
    if empty_only and os.listdir(path):
        return None
    owner = os.stat(path).st_uid
    if owner != 0:
        return (
            f"{path} is owned by uid {owner} and not writable by {RUN_AS} (uid {uid}); "
            f"run `chown -R {uid}:{gid} <the host folder>` or start the container with "
            f"--user {owner}:{os.stat(path).st_gid}"
        )
    try:
        _chown_tree(path, uid, gid)
    except OSError as e:
        return f"could not take ownership of {path} ({e.strerror})"
    return None


def drop_privileges(user):
    """Become `user` for good, and prove the way back is closed."""
    os.initgroups(user.pw_name, user.pw_gid)
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    try:
        os.setuid(0)
    except PermissionError:
        pass
    else:  # pragma: no cover - would mean the drop did nothing
        raise RuntimeError("could not drop root")
    os.environ["HOME"] = user.pw_dir
    os.environ["USER"] = os.environ["LOGNAME"] = user.pw_name


def warn_if_unwritable(path):
    """Not root: nothing can be fixed from here, so say what is wrong."""
    target = path
    while target and not os.path.exists(target):
        target = os.path.dirname(target)
    if target and not os.access(target, os.W_OK | os.X_OK):
        print(
            f"zimi: the data folder {path} is not writable by uid {os.geteuid()}. "
            f"Give that user the host folder (chown {os.geteuid()}:{os.getegid()} <folder>) "
            "or run the container without --user so it can take ownership itself.",
            file=sys.stderr,
            flush=True,
        )


#: kiwix-serve's container port, which Project NOMAD maps and its add-ons
#: (the translation proxy) reach by the container's name.
KIWIX_PORT = "8080"


def kiwix_serve_invocation(argv, environ):
    """Project NOMAD runs its Information Library container with kiwix-serve's
    flags (``--library /data/kiwix-library.xml --monitorLibrary --address=all``)
    and cannot change them for an app it ships. When Zimi is put in that
    container's place those flags arrive as the whole command: serve the folder
    the library file lives in, on the port kiwix-serve would have used.

    Returns ``(argv, folder)``, or None when this is not that. Every other
    kiwix-serve flag is accepted and ignored: Zimi has its own meaning for them.
    """
    if not argv or not argv[0].startswith("-"):
        return None
    library = host = port = None
    i = 0
    while i < len(argv):
        flag, eq, value = argv[i].partition("=")
        if not eq and flag in ("--library", "-l", "--address", "-I", "--port", "-p"):
            i += 1
            value = argv[i] if i < len(argv) else ""
        if flag in ("--library", "-l"):
            library = value
        elif flag in ("--address", "-I"):
            host = "0.0.0.0" if value == "all" else value
        elif flag in ("--port", "-p"):
            port = value
        i += 1
    serve = [
        "python3",
        "-m",
        "zimi",
        "serve",
        "--port",
        port or environ.get("ZIMI_PORT") or KIWIX_PORT,
    ]
    if host:
        serve += ["--host", host]
    folder = os.path.dirname(library) if library else None
    return serve, folder


def main(argv=None, environ=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    environ = os.environ if environ is None else environ
    if not argv:
        argv = ["python3", "-m", "zimi", "serve", "--port", "8899"]
    kiwix = kiwix_serve_invocation(argv, environ)
    if kiwix:
        argv, folder = kiwix
        if folder:
            held = [
                p for p in environ.get("ZIMI_EXTRA_ZIM_DIRS", "").split(os.pathsep) if p
            ]
            if folder not in held:
                environ["ZIMI_EXTRA_ZIM_DIRS"] = os.pathsep.join(held + [folder])
    note_port(argv, environ)
    path = data_dir_from(argv, environ)
    if os.geteuid() == 0:
        user = pwd.getpwnam(RUN_AS)
        library = folder_from(argv, environ, "--zim-dir", "ZIM_DIR")
        for folder, only in (
            (path, {}),
            (library, {"create": False, "empty_only": True}),
        ):
            if folder:
                problem = take_ownership(folder, user.pw_uid, user.pw_gid, **only)
                if problem:
                    print(f"zimi: {problem}", file=sys.stderr, flush=True)
        drop_privileges(user)
    elif path:
        warn_if_unwritable(path)
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
