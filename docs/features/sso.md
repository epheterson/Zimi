# SSO (Cloudflare Access)

Trusted-header single sign-on via Cloudflare Access. Experimental, off by default. If you don't run Cloudflare Access, ignore this — the normal password/token flow is untouched.

## How it works

Cloudflare Access authenticates at the edge and forwards the result to the origin as an RS256-signed JWT in the `Cf-Access-Jwt-Assertion` header. Zimi does **real signature verification** in stdlib (verify-only RSA — no key material to protect, every compared value public), plus JWKS fetch/cache/rotation, strict `alg` pinning, and audience/issuer/expiry checks. The security contract:

1. **Off unless configured.** Both the team domain (`ZIMI_SSO_TEAM`) and the Access application audience tag (`ZIMI_SSO_AUD`) must be set, or the header is not read at all. A bare install auto-trusting an identity header anyone can send would be a login bypass.
2. **Only from the proxy.** The header is honored only when the *direct socket peer* is the tunnel — not a forwarded IP, which is the same untrusted class of input. Default trust: any private/loopback peer (cloudflared beside the app or in a sibling container). Narrow it with `ZIMI_SSO_PROXY`. A header from anywhere else is ignored entirely.
3. **Fail closed, three ways.** No header → anonymous (password/token flow untouched). Header from an untrusted peer → ignored. Header from the proxy that does not verify → 401, never a fall-through to the claimed identity or another credential.
4. **RS256 only.** `alg: none` and HS256 downgrade are rejected before any key lookup.

JWKS is cached in memory and on disk (`<data-dir>/sso_jwks.json`) and honored until it expires, so a restart or network blip doesn't break logins. When a refresh can't happen (offline, endpoint down) the cached keys keep verifying for a bounded staleness window, then tokens are rejected. No failure mode makes an invalid token valid, and none of it touches the password/API-token paths — an operator is never locked out of an instance they can reach directly.

## Configure

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `ZIMI_SSO_TEAM` | env / config `sso_team` | unset (SSO off) | Access team domain (must be `https://…`). Required to enable SSO. |
| `ZIMI_SSO_AUD` | env / config `sso_aud` | unset (SSO off) | Access application AUD tag. Required to enable SSO. |
| `ZIMI_SSO_PROXY` | env / config `sso_proxy` | private networks | CSV of peer addresses/CIDRs allowed to present the header |
| `ZIMI_SSO_ROLE` | env / config `sso_role` | `user` | Role granted to SSO-authenticated identities |

Neither `ZIMI_SSO_TEAM` nor `ZIMI_SSO_AUD` is a secret — they identify the org and app, and `zimi config` shows them unmasked because a hidden value would hide the most common misconfiguration.

## Troubleshoot

- **SSO doesn't engage** — both `ZIMI_SSO_TEAM` and `ZIMI_SSO_AUD` must be set; with either missing the header is ignored. Confirm with `zimi config`.
- **Authenticated at the edge but Zimi 401s** — the direct socket peer isn't trusted. Ensure cloudflared reaches Zimi from a private/loopback address, or add its address to `ZIMI_SSO_PROXY`.
- **`ZIMI_SSO_TEAM` ignored with a warning** — it must be `https://`. A non-https value is rejected.
- **Logins fail after going offline for a long time** — the cached JWKS aged past its staleness limit. Restore network so the certs can refresh; cached keys cover restarts and short blips only.
- **Locked out entirely** — you can't be via SSO alone: reach the instance directly (LAN/loopback) and use the password/API-token path, which SSO never touches.
