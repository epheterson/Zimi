# Users & access

Who can reach the server, who can read which ZIMs, who can create, and how the very first admin is set safely.

## How it works

**Public-access modes.** The whole instance runs in one of three modes:

- **open** — anyone can read everything without logging in.
- **limited** — anonymous visitors see only an allowlisted subset of ZIMs; named accounts see what their own allowlist grants.
- **private** — nothing is readable until you log in.

The mode lives in Zimi's state and is set from Manage or by `ZIMI_PUBLIC_ACCESS` (`open` | `limited` | `private`), which overrides the stored value.

**Named accounts & per-ZIM allowlists.** Beyond the single admin, Zimi supports multiple user accounts (`zimi/users.py`), each with a per-ZIM allowlist so different people see different slices of the library. Sessions are cookie-based.

**Creator role.** An account can carry `can_create`, letting it drive the web Create page's URL modes (single page, `--site`, video) without full admin credentials. The server-disk modes — folder capture and web-archive import — stay with the **primary admin** only and are CLI-only regardless (see [Creating ZIMs](making-zims.md)).

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

---

## SSO (Cloudflare Access)

Trusted-header single sign-on via Cloudflare Access. Experimental, off by default. If you don't run Cloudflare Access, ignore this — the normal password/token flow is untouched.

### How it works

Cloudflare Access authenticates at the edge and forwards the result to the origin as an RS256-signed JWT in the `Cf-Access-Jwt-Assertion` header. Zimi does **real signature verification** in stdlib (verify-only RSA — no key material to protect, every compared value public), plus JWKS fetch/cache/rotation, strict `alg` pinning, and audience/issuer/expiry checks. The security contract:

1. **Off unless configured.** Both the team domain (`ZIMI_SSO_TEAM`) and the Access application audience tag (`ZIMI_SSO_AUD`) must be set, or the header is not read at all. A bare install auto-trusting an identity header anyone can send would be a login bypass.
2. **Only from the proxy.** The header is honored only when the *direct socket peer* is the tunnel — not a forwarded IP, which is the same untrusted class of input. Default trust: any private/loopback peer (cloudflared beside the app or in a sibling container). Narrow it with `ZIMI_SSO_PROXY`. A header from anywhere else is ignored entirely.
3. **Fail closed, three ways.** No header → anonymous (password/token flow untouched). Header from an untrusted peer → ignored. Header from the proxy that does not verify → 401, never a fall-through to the claimed identity or another credential.
4. **RS256 only.** `alg: none` and HS256 downgrade are rejected before any key lookup.

JWKS is cached in memory and on disk (`<data-dir>/sso_jwks.json`) and honored until it expires, so a restart or network blip doesn't break logins. When a refresh can't happen (offline, endpoint down) the cached keys keep verifying for a bounded staleness window, then tokens are rejected. No failure mode makes an invalid token valid, and none of it touches the password/API-token paths — an operator is never locked out of an instance they can reach directly.

### Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `ZIMI_SSO_TEAM` | env / config `sso_team` | unset (SSO off) | Access team domain (must be `https://…`). Required to enable SSO. |
| `ZIMI_SSO_AUD` | env / config `sso_aud` | unset (SSO off) | Access application AUD tag. Required to enable SSO. |
| `ZIMI_SSO_PROXY` | env / config `sso_proxy` | private networks | CSV of peer addresses/CIDRs allowed to present the header |
| `ZIMI_SSO_ROLE` | env / config `sso_role` | `user` | Role granted to SSO-authenticated identities |

Neither `ZIMI_SSO_TEAM` nor `ZIMI_SSO_AUD` is a secret — they identify the org and app, and `zimi config` shows them unmasked because a hidden value would hide the most common misconfiguration.

### Troubleshoot

- **SSO doesn't engage** — both `ZIMI_SSO_TEAM` and `ZIMI_SSO_AUD` must be set; with either missing the header is ignored. Confirm with `zimi config`.
- **Authenticated at the edge but Zimi 401s** — the direct socket peer isn't trusted. Ensure cloudflared reaches Zimi from a private/loopback address, or add its address to `ZIMI_SSO_PROXY`.
- **`ZIMI_SSO_TEAM` ignored with a warning** — it must be `https://`. A non-https value is rejected.
- **Logins fail after going offline for a long time** — the cached JWKS aged past its staleness limit. Restore network so the certs can refresh; cached keys cover restarts and short blips only.
- **Locked out entirely** — you can't be via SSO alone: reach the instance directly (LAN/loopback) and use the password/API-token path, which SSO never touches.
