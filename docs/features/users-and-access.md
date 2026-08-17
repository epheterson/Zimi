# Users & access

Who can reach the server, who can read which ZIMs, who can create, and how the very first admin is set safely.

## How it works

**Public-access modes.** The whole instance runs in one of three modes:

- **open** — anyone can read everything without logging in.
- **limited** — anonymous visitors see only an allowlisted subset of ZIMs; named accounts see what their own allowlist grants.
- **private** — nothing is readable until you log in.

The mode lives in Zimi's state and is set from Manage or by `ZIMI_PUBLIC_ACCESS` (`open` | `limited` | `private`), which overrides the stored value.

**Named accounts & per-ZIM allowlists.** Beyond the single admin, Zimi supports multiple user accounts (`zimi/users.py`), each with a per-ZIM allowlist so different people see different slices of the library. Sessions are cookie-based.

**Creator role.** An account can carry `can_create`, letting it drive the web Create page's URL modes (single page, `--site`, video) without full admin credentials. The server-disk modes — folder capture and web-archive import — stay with the **primary admin** only and are CLI-only regardless (see [Creating ZIMs](creation.md)).

**Secure first-run bootstrap (GHSA-5mw2-53vv-9pw6).** Setting the first admin password used to be "any private-tier client sets it" — on a LAN, a Docker bridge, or a tailnet, too many hands: an adjacent device could race the owner to claim admin. The fix splits the bootstrap door in two:

- **Loopback (the host itself)** needs no secret — set the first password freely.
- **Any remote client** must present a **one-time setup key** the server generates on first start and prints to its own log. LAN and tailnet peers without the key get the same locked response a public client does.

The key is a CSPRNG value shaped like `7Q2K-9F4M-XR8T`, stored `0600` in `ZIMI_DATA_DIR/setup-key`, sent as `Authorization: Bearer <key>` or the `X-Zimi-Setup-Key` header, and constant-time compared. It persists across restarts until spent, and is cleared the moment a password is set — its whole life is the bootstrap window.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `ZIMI_PUBLIC_ACCESS` | env | stored value | `open` / `limited` / `private`; overrides the stored mode |
| `ZIMI_MANAGE` | env / config `manage` | `1` | `0` disables the `/manage/*` endpoints entirely |
| `ZIMI_MANAGE_USER` | env / config | password file | Admin username (else read from the password file) |
| `ZIMI_MANAGE_PASSWORD` | env / config | password file | Admin password (else the password file) |
| `ZIMI_API_TOKEN` | env / config | token file | Bearer token for programmatic access (else the generated token file) |
| setup key | `ZIMI_DATA_DIR/setup-key` | auto-generated | One-time remote bootstrap secret; printed to the server log |

## Troubleshoot

- **Remote first-run says `needs_setup_key`** — by design. Read the setup key from the server's own log and present it as `X-Zimi-Setup-Key` (or a Bearer token). Or set the first password from a loopback shell on the host, which needs no key.
- **Lost the setup key** — it's in the server log, and in `ZIMI_DATA_DIR/setup-key` while unspent. If a password is already set, the key is gone on purpose; reset via the password file / `ZIMI_MANAGE_PASSWORD`.
- **Can't generate an API token** — you must set an admin password first; a passwordless instance refuses. If token generation returns a 500, the data dir isn't writable.
- **A user can't see a ZIM they should** — check the mode (private/limited) and that ZIM's per-user allowlist.
- **A creator account can't use folder/import** — expected. Those are primary-admin, CLI-only. Creators get the URL capture modes only.
- **Management endpoints 404** — `ZIMI_MANAGE=0` disables them. Set it back to `1`.
