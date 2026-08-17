# Importing web archives

Convert a WARC or WACZ web archive into a library ZIM.

## How it works

`zimi import <file>` converts a `.warc`, `.warc.gz`, or `.wacz` archive into a ZIM and registers it in the library (or writes an explicit path with `--out`). The conversion runs through **warc2zim**, which Zimi keeps in a dedicated sidecar virtual environment rather than the main install — warc2zim pulls in heavier dependencies (and libmagic) that most users never need. The sidecar is provisioned on demand.

`zimi import --setup` installs the sidecar venv now (needs network) so an air-gapped machine can be pre-seeded before it goes offline. `zimi import --status` reports the sidecar's state and version. Name and metadata come from `--name` / `--title` / `--description`, with the name derived from the filename by default.

Import is **CLI-only**. It reads a path on the server's disk — a read-the-server's-disk primitive — so it is deliberately not exposed in the web UI and stays with the primary admin at a shell on the machine. The Docker image ships the sidecar prerequisites (Python 3.14 + libmagic) so import works there out of the box.

## Configure

| Setting | Where | Effect |
| --- | --- | --- |
| `file` | positional | The `.warc` / `.warc.gz` / `.wacz` to convert |
| `--name` | flag | ZIM short name (default: derived from filename) |
| `--title` / `--description` | flag | ZIM metadata |
| `--out` | flag | Explicit output `.zim` path (default: ZIM dir + register) |
| `--setup` | flag | Install the warc2zim sidecar venv now (network) |
| `--status` | flag | Report sidecar state and version |

## Troubleshoot

- **"sidecar not installed" / conversion won't start** — run `zimi import --setup` once with network access, then `zimi import --status` to confirm the venv and version.
- **Preparing an offline machine** — run `zimi import --setup` while it still has internet; the sidecar then works air-gapped.
- **libmagic errors on a bare install** — the sidecar needs libmagic on the host. The Docker image already includes it; on a manual install, install your platform's libmagic package.
- **Looking for an import button in the web UI** — there isn't one by design. Run `zimi import <file>` from a shell on the server; it's a primary-admin, server-disk operation.
- **Related** — the `--engine alive` capture path in [Creating ZIMs](creation.md) uses the same warc2zim sidecar, so `--setup` provisions both.
