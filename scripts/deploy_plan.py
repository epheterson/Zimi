#!/usr/bin/env python3
"""Manifest arithmetic for deploy.sh: what to send and what to remove, from content hashes.

The NAS keeps a manifest of the files the last deploy put there (hash and path per line, a
few header lines for the ref and commit). A deploy hashes this checkout, compares, and so
needs no state of its own: any clone of any branch deploys the same way.

  deploy_plan.py local   ROOT PATH...         manifest of the files under PATH (relative to ROOT)
  deploy_plan.py plan    LOCAL REMOTE OUTDIR  writes OUTDIR/send, OUTDIR/remove, OUTDIR/counts
  deploy_plan.py pending REMOTE SENDLIST      REMOTE without the entries about to be sent, so a cut-short deploy is redone
  deploy_plan.py header  FILE KEY             one header value
"""

import hashlib
import os
import sys

SKIP_DIRS = {"__pycache__"}
SKIP_SUFFIX = (".pyc",)


def _hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def collect(root, paths):
    """{relative path: sha256} for every regular file under the given paths."""
    out = {}
    for top in paths:
        base = os.path.join(root, top)
        if os.path.isfile(base):
            out[top] = _hash(base)
            continue
        for d, dirs, files in os.walk(base):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for name in files:
                if name.endswith(SKIP_SUFFIX):
                    continue
                full = os.path.join(d, name)
                if os.path.isfile(full):
                    out[os.path.relpath(full, root)] = _hash(full)
    return out


def read_manifest(path):
    """(headers, {path: hash}); a missing file is an empty manifest."""
    headers, entries = {}, {}
    if not os.path.isfile(path):
        return headers, entries
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            if line.startswith("# "):
                key, _, val = line[2:].partition("\t")
                headers[key] = val
            else:
                digest, _, rel = line.partition("\t")
                entries[rel] = digest
    return headers, entries


def write_manifest(entries, out, headers=None):
    for k, v in (headers or {}).items():
        out.write(f"# {k}\t{v}\n")
    for rel in sorted(entries):
        out.write(f"{entries[rel]}\t{rel}\n")


def _write_list(path, items):
    with open(path, "w", encoding="utf-8") as f:
        for item in items:
            f.write(item + "\n")


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd = argv[1]
    if cmd == "local":
        write_manifest(collect(argv[2], argv[3:]), sys.stdout)
    elif cmd == "plan":
        _, local = read_manifest(argv[2])
        _, remote = read_manifest(argv[3])
        send = sorted(p for p, h in local.items() if remote.get(p) != h)
        remove = sorted(p for p in remote if p not in local)
        _write_list(os.path.join(argv[4], "send"), send)
        _write_list(os.path.join(argv[4], "remove"), remove)
        with open(os.path.join(argv[4], "counts"), "w", encoding="utf-8") as f:
            f.write(f"{len(send)} {len(remove)} {len(local) - len(send)}\n")
    elif cmd == "pending":
        headers, remote = read_manifest(argv[2])
        with open(argv[3], encoding="utf-8") as f:
            sending = set(f.read().split("\n"))
        write_manifest(
            {p: h for p, h in remote.items() if p not in sending}, sys.stdout, headers
        )
    elif cmd == "header":
        print(read_manifest(argv[2])[0].get(argv[3], ""))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
