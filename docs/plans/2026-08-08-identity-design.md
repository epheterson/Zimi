# Zimi 1.9 — Identity and policy design (Workstream B)

Status: Phase 1 (trusted-header SSO, per the 2026-08-08 amendment below) is **built** — `zimi/sso.py`, `tests/test_sso.py`, the `#sso` section of `docs/deployment-networking.md`. Everything else here is still design. What Phase 1 settled, so the later phases inherit it rather than re-litigate it:

- **Verify-only RSA in the stdlib is real and it is enough** (~330 lines including JWKS caching). Decision 1's option (b) is no longer hypothetical: the code flow's future signature checking can call `sso.verify_token` instead of adding the `[sso]` extra. What that does NOT settle is ES256 — an IdP that defaults to P-256 still needs the extra or a second implementation.
- **The identity hook is `users.resolve_request_user`.** An SSO identity resolves to an ordinary account name there, ahead of the Bearer and cookie checks, so the allowlist choke point, the manage hierarchy, `/whoami` and per-user data all inherited it with no changes. The OIDC flow should resolve into the same place.
- **users.json stayed at version 1**, as the migration note requires. Federated records add `auth: "sso"`, `flags.sso: {provider, iss, sub, email}` and `pw: null`; `authenticate()` gained the explicit `pw is None → reject` guard the OIDC section anticipated.
- **The name-collision rule came out softer than specced, deliberately.** The design said a collision with a local-password account is a hard error. In practice the first thing an operator does is sign in through the tunnel as themselves and hit exactly that collision, with a 401 they cannot self-diagnose. What ships: the account name is derived from the email's local part, falling back to the sanitized full address when that name belongs to someone else, and only refusing when both are taken. No account is ever adopted — which was the actual security requirement — and the user list's new `auth` field shows the admin which is which.
- **The configured role is a creation default, not a per-login assertion.** With no group mapping in this phase the only source is a static value, and re-applying it every login would silently undo an admin's own promotion. When group→role mapping lands (Decision 1), it re-asserts on every login as specced — that is a mapping *derived from the IdP*, which this is not.
- **Phase 1 needed no UI**, no i18n keys, and no new endpoint. Config is four `CONFIG_ENV_SETTINGS` entries (`ZIMI_SSO_TEAM`, `ZIMI_SSO_AUD`, `ZIMI_SSO_ROLE`, `ZIMI_SSO_PROXY`), so `zimi config` reports them with provenance.

Original status: design, no code yet. Companion to `2026-08-07-v19-plan.md` workstream B. Everything here honors the two decrees: **one package, no edition gating** — every feature below ships on for everyone, configuration is what varies — and **the compatibility contract** — an existing single-admin install upgrades to 1.9 and notices nothing.

Scope: OIDC login, IdP group→role mapping, SCIM 2.0 provisioning, CSV/JSON bulk import, per-group ZIM policy, forced-login mode, append-only audit logs.

## What already exists (build on it, don't fork it)

The 1.8 multi-user work left seams that were placed deliberately for this. Study these before writing anything:

- **The user store** — `zimi/users.py`: `users.json` `{version: 1, users: {casefold_name: {name, role, pw, allowlist, flags, created, last_login}}}`. Roles `admin`/`user`/`limited` (users.py:57), `flags: {}` reserved as the v2 seam (users.py:311), PBKDF2 hashing shared with the admin path (users.py:110–119), sessions hashed at rest with TTL (users.py:177–198, 729–743).
- **The allowlist choke point** — one path, no forks. `users.request_allow(handler)` (users.py:878–905) resolves the request to an allow set or `None` (all-access). `http.do_GET` sets it into a thread-local at http.py:863 (`do_POST` at http.py:1618, both cleared in a `finally`). Downstream, `server.current_allow()` / `zim_allowed()` (server.py:1131–1140) gate `get_zim_files()` (server.py:1284) and `list_zims()` (server.py:1316), which every read path flows through, and the search cache keys on the resolved allow set (search.py:94) so a policy change can never serve a stale cross-user result. **Groups change what `request_allow` returns. Nothing downstream changes.**
- **Access modes** — `open`/`limited`/`private` in `access.json`, env override `ZIMI_PUBLIC_ACCESS`, fail-closed on a corrupt file (users.py:583–680). `private` is enforced by `_private_access_block` (http.py:832–851) against a deliberately minimal anonymous surface (http.py:196–209).
- **Admin auth hierarchy** — primary admin (password file / API token / passwordless-private), secondary admins (users.json `role=admin`), `admin_kind()` and `_check_manage_auth` (manage.py:224–347). The unified `/login` (http.py:2473) already mints sessions for both.
- **Backup bundle v3** — server scope already carries `users.json` (with hashes), the access policy, and per-user data (manage.py:528–627). New identity state slots in here; workstream A's backup story is why B starts after A.

## Decision 1 — OIDC without breaking the stdlib-only policy

This is the central design problem. The OIDC authorization-code flow ends with an ID token: an RS256-signed JWT. RSA signature verification is not in the stdlib, and Zimi's dependency policy (pyproject.toml: libzim, certifi, zeroconf, optional extras for the rest) is deliberate. Three real options, worked through with eyes open:

**(a) Optional `[sso]` extra — PyJWT + cryptography, soft-imported.** Matches the libtorrent pattern exactly (absent = feature degrades, one-line fix logged). Cost: `cryptography` is a compiled wheel with an OpenSSL vendoring story — the heaviest thing Zimi would ever depend on, it breaks the "pip install zimi works in a bunker" property for the one feature enterprises need, and "SSO requires an extra" is the first thing an Okta admin hits in the README. It also creates a support matrix: every SSO bug report starts with "which crypto stack."

**(b) Pure-stdlib RSA verification.** Genuinely possible: RSASSA-PKCS1-v1_5 *verification* is `pow(sig, e, n)` plus comparing a deterministic EMSA-PKCS1-v1_5 encoding (fixed DER prefix for SHA-256), and JWKS `n`/`e` are base64url integers — roughly 200 lines, no key material to protect, and timing side-channels don't apply to verify-only (everything compared is public). The honest cons: it's hand-rolled crypto in a knowledge server maintained by one person; the hard part was never the modular exponentiation, it's the *protocol* around it — JWKS fetch/cache/refetch on unknown `kid`, key rotation, `alg` confusion (`none`, HS256-with-public-key downgrade), and the moment an IdP defaults to ES256 (P-256 ECDSA — a second, genuinely fiddly implementation) the 200 lines become 600. Every one of those protocol pitfalls exists in options (a) and (b) equally; (b) just adds "and audit the math" on top.

**(c) Code flow as a confidential client, no local signature check.** The ID token is received by the *server* directly from the IdP's token endpoint over TLS with client authentication. OpenID Connect Core §3.1.3.7 rule 6 blesses exactly this: *"If the ID Token is received via direct communication between the Client and the Token Endpoint (which it is in this flow), the TLS server validation MAY be used to validate the issuer in place of checking the token signature."* We still validate everything else — `iss`, `aud`, `exp`, `nonce` — by decoding the payload (base64 + json, stdlib), and the flow carries `state` (CSRF) and PKCE S256 (`hashlib`, stdlib). The security argument, stated honestly: the token never transits an attacker-influenced channel — it arrives on a TLS connection *we* opened to a pinned issuer, certificate-validated against certifi (already a hard dependency; `library.py` already makes HTTPS calls this way). An attacker who can forge a token into that channel has broken TLS to the IdP or owns the IdP — and in either case signature verification is also defeated, because the IdP holds the signing keys. Signature verification earns its keep when tokens arrive from *untrusted* directions (browser front-channel, third-party API callers). This flow has no such direction. The one real limitation: this pattern cannot validate JWTs *presented to Zimi by clients* (e.g., an MCP client waving an Entra access token). That is out of scope for 1.9, and it is precisely what would justify adding the `[sso]` extra later.

**Decision: (c), pure stdlib, is the 1.9 implementation. (a) is the fallback and the designated future path for bearer-JWT API auth** — if (c) hits an IdP-compatibility wall in the field, the `[sso]` extra slots in as a soft-import that upgrades validation without changing the flow. (b) is rejected as the primary: it maximizes audit surface to avoid a dependency we've already avoided by other means.

Implementation contract for (c):

- **Confidential client only.** `client_id` + `client_secret` required. Public-client SSO (no secret) is not offered; without client auth the token-endpoint channel loses the property rule 6 depends on.
- **Discovery** via `<issuer>/.well-known/openid-configuration`, fetched once and cached in the data dir (refetched on config change or endpoint 4xx). Air-gapped sites run a LAN IdP (Keycloak); no internet dependency beyond reaching the IdP itself.
- **TLS is mandatory.** `https` issuer URLs only; `ZIMI_TLS_CA` accepts a private CA bundle path for internal PKI. Plain `http` is accepted for loopback issuers only (development). No insecure-override env var — an escape hatch here deletes the entire security argument.
- **Validate in the handler:** `state` matches (bound to a short-TTL server-side pending-auth record, not a cookie value we trust), PKCE verifier matches, token response `iss`/`aud`/`exp`/`nonce` all check out, required username claim present. Reject `alg: none` tokens outright even though we don't verify signatures — refuse to normalize garbage.
- **Claims:** username from a configurable claim (default `preferred_username`, fallback `email`), display name, email, `groups`. Groups reality per IdP: **Entra** puts groups in the ID token when the app's token configuration adds the groups claim (its userinfo endpoint is Graph and returns almost nothing — read the ID token payload, which rule 6 covers); mind the 200-group overage claim — the setup doc must tell Entra admins to emit *only groups assigned to the application*. **Okta** and **Keycloak** emit a groups claim in the ID token and/or userinfo with a mapper/scope. **Google Workspace** puts groups in neither — Google group mapping requires the Directory API and is explicitly not built (Google users still log in; they land on the default role).
- **JIT provisioning:** first OIDC login creates a users.json record via the existing `create_user` path with `pw: null` (federated — no password login; `authenticate()` gains an explicit `pw is None → reject` guard rather than trusting `_verify_password(x, None)` to fail politely), `auth: "oidc"`, `sub` and issuer recorded in `flags`. From that point the account is a completely ordinary user: same sessions (users.py:729), same cookie (http.py:2459), same choke point. **Name collision rule:** an OIDC login whose casefold username matches an existing record signs into it only if the record's stored issuer+`sub` match; a collision with a local-password account is a hard error surfaced to the admin — silent account takeover through a claim value is the classic federation bug and we refuse to have it.
- **Group→role mapping** lives in `oidc.json` (data dir, admin-edited via `/manage/oidc`): `{issuer, client_id, client_secret, username_claim, group_claim, group_map: {"<idp-group>": {"role": "user"|"limited"|"admin", "groups": ["<zimi-group>", ...]}}, default_role, allow_unmapped}`. Mapping is applied at *every* login (IdP is authoritative for federated accounts); `allow_unmapped: false` turns an unmapped user's login into a clean 403. Mapping to `role: admin` creates a *secondary* admin — the primary admin remains the password file, so a misconfigured IdP can never lock the owner out.
- **Routes** `/oidc/login` and `/oidc/callback` join `_PRIVATE_LOGIN_SURFACE_EXACT` (http.py:196) so forced-login instances can render the "Sign in with…" button.

## Decision 2 — Groups layer above the choke point

New file `groups.json` under the data dir: `{version: 1, groups: {casefold_name: {name, allowlist: [...] | null, description, created}}}`. `allowlist: null` means an all-access group, same sentinel semantics as user allowlists. User records gain an additive `"groups": [...]` field — absent on every existing record, so existing installs are byte-for-byte unaffected.

**Effective-access resolution, all inside `users.request_allow` (users.py:878) — the only writer of the thread-local, so nothing downstream forks:**

1. `role` `admin` or `user` → `None` (all-access). Unchanged; groups are irrelevant to all-access roles.
2. `role` `limited` → the **union** of: the user's own explicit allowlist (the "individual override", now optional and additive) and every named group's allowlist. Any all-access group in the union → `None`. A limited user with no allowlist and no groups sees nothing, exactly as today.

Union-of-grants, no deny lists. Deny semantics turn every policy question into an ordering question and every support thread into a Venn diagram; a school that needs "class shelf minus one book" makes a second group. Stated as a non-goal below.

Correctness falls out of existing machinery: the search cache already keys on the resolved allow set (search.py:94), so editing a group's shelf busts cached results with no new code; editing a group drops the sessions of its members (same immediacy contract as `set_role`, users.py:388).

Surface: `/manage/groups` CRUD (admin-gated via the existing `_manage_auth_challenge`), group membership editable from both the group and the user side in the manage UI, `groups` key added to the backup bundle (schema version 3 → 4; v3 bundles restore fine — the key is simply absent).

## Decision 3 — Forced-login mode: mostly already shipped

Access mode `private` **is** forced-login, built in 1.8.1 and enforced fail-closed. Precisely what it does today: `_private_access_block` (http.py:832) 401s every anonymous request outside the login surface — `/`, `/whoami`, `/health` (already allow-filtered to zero ZIMs), `/login`, `/logout`, favicons, `/static/*`, `/manage/*` (self-gated by its own challenge) (http.py:196–209). `request_allow` additionally returns an empty set for anonymous under `private` as defence in depth (users.py:905). A corrupt `access.json` resolves to `private`, never `open` (users.py:637).

What "serves nothing to anonymous" still needs — the honest gap list, and it is small:

- `/oidc/login` + `/oidc/callback` added to the login surface (Decision 1).
- The SPA shell and `/static/*` stay anonymously served — they are the login screen and contain no library data. This is the correct call, not a gap: a login page that can't load its own CSS is theater.
- `/metrics` is admin-gated already (http.py:176) — a Prometheus scraper authenticates with the API token; no change.
- `/dl/<name>` peer serving and mDNS advertisement are governed by `ZIMI_PEER_SHARE` (http.py:2053), **not** by access mode. Decision: keep them independent — a private instance that also seeds is a legitimate configuration (private *web* library, public *mirror*) — but the manage UI shows a one-line warning when `private` and sharing are both on, because an operator who set `private` and didn't know mDNS was announcing the library name deserves to be told.
- Login-page polish: when OIDC is configured, the anonymous shell shows the SSO button (and hides the password form entirely if `oidc.json` sets `local_login: false` — with the hard rule that the *primary admin password path always works from a private-network client*, so a dead IdP can never brick the box).

Sized honestly: this phase is UI and two route-table entries.

## Decision 4 — Audit log

**Format:** append-only JSONL, one file per month, `<data-dir>/audit/audit-YYYY-MM.jsonl`. One JSON object per line: `{"ts": <iso8601>, "event": "<dotted.name>", "actor": {"kind": "primary"|"secondary"|"user"|"scim"|"system", "name": ...}, "ip": ..., "details": {...}}`. Written through one locked appender (flush per line, no per-line fsync — this is an audit trail, not a WAL), and an audit-write failure logs loudly and increments a metric but never blocks the action: for this product, availability beats auditability, and we say so rather than pretend otherwise.

**Events:** `auth.login` (success *and* failure, with method `local`/`oidc` — failures matter more than successes), `auth.logout`, `user.create` / `user.delete` / `user.password` / `user.role` / `user.allowlist`, `group.create` / `group.update` / `group.delete`, `policy.access` (mode changes), `oidc.config`, `scim.token` / `scim.create` / `scim.update` / `scim.deactivate` / `scim.delete`, `token.generate` / `token.revoke`, `zim.download` / `zim.delete`, `backup.export` / `backup.restore`, `server.start`.

**What is deliberately absent — the ethics gate:** no reads. No searches, no article opens, no suggest queries, not even in an "optional verbose mode." Zimi's promise is an offline library, and libraries do not keep lists of what you read. The seam for a *guardian-consented* kid-mode history already exists (`flags`, per-user data) and is a different feature with a different consent model; the audit log will never grow a read event. This sentence is the spec.

**Rotation/retention:** monthly files, plus a size guard — when the audit dir exceeds `ZIMI_AUDIT_MAX_MB` (default 64), oldest months are deleted first; default retention 12 months. Config in `audit.json` (enabled flag — default **on**, it's cheap and silent — retention knobs).

**No hash chaining.** Tamper-evidence via chained digests is security theater without an external anchor: an attacker with write access to the data dir owns the process that writes the chain. Sites that need real tamper-proofing ship the JSONL to their SIEM (it's line-oriented precisely so `filebeat`/`vector` can tail it); we don't cosplay one.

**Export:** `GET /manage/audit?from=&to=&event=&limit=` (admin-gated, paginated, newest-first) for the UI, and `GET /manage/audit/export` streaming raw JSONL for the month range. **Not** in the backup bundle: the bundle is a config snapshot that gets restored onto other machines, and replaying one instance's history onto another is wrong (plus bundles are held in memory during restore preview — manage.py:546 — and audit files are unbounded relative to config). The export endpoint and SIEM tailing are the durability story.

## Decision 5 — SCIM 2.0: the minimal conformant subset

Honesty first: nobody needs "SCIM 2.0, the RFC." Okta and Entra each exercise a narrow, well-documented slice, and that slice is the target. What they actually call (verified against Okta's SCIM 2.0 protocol reference and Microsoft's Entra SCIM tutorial, August 2026 — links at the bottom):

- **Matching:** both probe `GET /Users?filter=userName eq "..."` before creating (Entra also filters on `externalId`; only `eq`, and Entra additionally uses `and`). Responses are `ListResponse` with `startIndex`/`count`/`totalResults` integer pagination (Okta pages by 100).
- **Create:** `POST /Users`. **Read:** `GET /Users/{id}`.
- **Update:** Entra sends **PATCH** (`Operations` with `add`/`replace`/`remove`, and op values arrive case-mangled — `Replace` — so match case-insensitively). Okta sends **PUT** for profile updates (always, for custom/AIW integrations) and PATCH only for activate/deactivate. So both PUT and PATCH are required; neither alone suffices.
- **Deprovision:** both soft-delete via `active: false` (PATCH from Entra and OIN-Okta, PUT from AIW-Okta); Entra also sends `DELETE /Users/{id}` on hard delete. Deactivated users must still be returned by GET.
- **Discovery:** `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` — static JSON documents describing exactly what we support (Entra's requirements table lists `/Schemas` support; Okta states its provisioner doesn't currently use `/ServiceProviderConfig` but probes discovery). Cheap: three canned responses.
- **Auth:** a long-lived bearer secret token pasted into the IdP (both vendors' standard non-gallery flow; Entra explicitly recommends a secret token over its own issued JWTs for this). Generated/revoked at `/manage/scim/token`, stored hashed, **distinct from the admin API token** — the SCIM credential can create users and must not also be able to delete ZIMs.

**The subset we build:** `/scim/v2/{Users, Users/{id}, ServiceProviderConfig, ResourceTypes, Schemas}` with `GET`(+filter+pagination), `POST`, `PUT`, `PATCH`, `DELETE`; `application/scim+json`; SCIM error bodies (`urn:ietf:params:scim:api:messages:2.0:Error`). **Not building:** `/Bulk` (Entra: "we don't support /Bulk today"), `/Me`, sorting, attribute projection beyond `excludedAttributes=members`, complex filter grammar beyond `eq`(+`and`), `/Search`. **Groups endpoint is phase 2 of SCIM**, not day one: Entra treats `/Groups` as optional, group *policy* already works at launch via the OIDC groups claim, and Entra's 200-group ID-token overage — the one case where SCIM group push genuinely beats the claim — is real but not the first customer. When it lands: `GET /Groups?filter=displayName eq` + `excludedAttributes=members`, `POST`, `PATCH` (members add/remove/replace), `DELETE`, writing the same `groups.json`.

**Store mapping (all additive to users.json):** every user gains a stable `id` (UUID4, minted lazily on first SCIM/OIDC contact or list), `externalId`, `email`; `active: false` maps to `flags.disabled: true` (checked at `authenticate()` and `resolve_session()` — a disabled user's live sessions drop on deactivation, fail-closed like everything else in users.py). SCIM-created users have `pw: null` — they exist to log in via OIDC. `userName` maps to the account name through the existing validation (`_NAME_RE`, users.py:66 — emails-as-usernames fit; SCIM callers get a proper 400 with a SCIM error body if a name can't be represented).

**CSV/JSON bulk import — the air-gapped twin.** `POST /manage/users/import` (admin-gated): CSV columns `name,password,role,groups,email` (password blank → `pw: null`, semicolon-separated groups) or a JSON array of the same shape. Two-pass like backup restore: preview returns the create/update/skip diff, apply writes — reusing the exact `create_user`/`set_role` paths so validation and audit events are identical to hand-created users. A school with no IdP gets a spreadsheet workflow; that was the point of "both write the same store."

## users.json migration note — read this before touching the loader

`_load_users` **returns `{}` when `version != 1`** (users.py:138). Bumping `_USERS_VERSION` therefore silently empties every existing install's user list until each record is rewritten — the worst possible failure. The rule for 1.9: **the version stays 1 and every new field is additive** (`id`, `email`, `externalId`, `auth`, `sub`-in-flags, `groups`, `flags.disabled`). Records without the new fields behave exactly as in 1.8 (`role` inference already handles legacy records, users.py:153). If a genuinely breaking change is ever needed, the loader learns to *up-convert* version 1 in memory first, ships that for one release, and only then may the writer bump. Same discipline for `access.json` (fail-closed makes a bad write lock people out, not leak) and the backup schema (v4 adds `groups`; v3 bundles restore with the key absent). An existing single-admin, no-users.json install runs 1.9 with zero new files until the admin turns something on.

## Phases — each ships alone, in this order

1. **Audit log** (small). No dependencies, and landing it first means every later phase emits events from its first commit. Ships: appender, event calls in existing manage/user/login paths, `/manage/audit` + export, retention.
2. **Groups + per-group policy + CSV/JSON import** (medium). Pure users.py/manage.py extension, no new deps, no protocol work. Ships alone as a complete feature for the family/school/NAS user — this is the phase most 1.9 users will actually touch.
3. **OIDC login + group→role mapping** (large — the long pole). Stdlib code flow per Decision 1, JIT provisioning, `oidc.json`, manage UI, setup docs per IdP (Okta, Entra, Keycloak, Google-with-caveat). Depends on groups (mapping targets them) and audit (login events).
4. **Forced-login polish** (small). OIDC routes on the private surface, SSO login screen, `local_login: false`, the private+sharing warning. Rides on 3.
5. **SCIM Users + token** (medium). Per Decision 5. Depends on the `id`/`disabled` fields from 3's store work. Validated against Okta's SCIM CRUD tests and Entra's provisioning-on-demand before it's called done.
6. **SCIM Groups** (medium, demand-gated). Built when a real deployment asks; the design above already reserves its shape.

## What we are NOT building

- **A paid tier, edition flag, or license gate.** Decree. Every feature above ships on in the one package.
- **SAML.** OIDC covers Okta/Entra/Google/Keycloak; SAML is the long tail and a signature-validation swamp (XML-DSig) that genuinely cannot be done responsibly in stdlib. If demand materializes, it arrives via the `[sso]` extra era.
- **Local JWT validation / bearer-JWT API auth** in 1.9. The `[sso]` extra is specced as the fallback and future path; it is not in this release.
- **Deny lists / policy ordering.** Union-of-grants only.
- **Read-history in the audit log.** Ever. See the ethics gate.
- **Hash-chained "tamper-proof" logs.** SIEM shipping is the real answer.
- **SCIM `/Bulk`, `/Me`, sorting, complex filters.** Neither Okta nor Entra needs them.
- **Google Workspace group sync** (Directory API dependency). Google users authenticate; their groups don't map.
- **SMTP / email-based self-service reset.** No mail transport exists and none is being added for this. What ships instead (inside phase 2, tiny): admin-generated one-time reset links — offline-capable, stdlib, and covers the "kid forgot the password" case that actually occurs. Full self-service reset waits for a deliberate mail-transport decision.
- **Kid modes / schools UX** beyond what groups give for free. The `flags` seam is where it lands later, with its own consent design.

## Sources used

- OpenID Connect Core 1.0, §3.1.3.7 ID Token Validation (rule 6: TLS in place of signature check for direct token-endpoint delivery; rules 7–8 on `alg`) — https://openid.net/specs/openid-connect-core-1_0.html
- Okta, "SCIM 2.0 protocol reference" (PUT vs PATCH behavior, `userName eq` matching, pagination, deactivation, Group Push verbs) — https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20 and "SCIM integration concepts and requirements" — https://developer.okta.com/docs/concepts/scim/faqs/
- Microsoft Learn, "Develop a SCIM endpoint for user provisioning from Microsoft Entra ID" (requirements table: create/PATCH/query/pagination/`active=false`/`/Schemas`; `eq`+`and` only; case-mangled PATCH ops; secret-token auth recommendation) — https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups

## Amendment 2026-08-08 — Cloudflare Access / trusted-header SSO comes first

Eric's own deployment (knowledge.zosia.io) runs behind a Cloudflare Tunnel, and his question "will this interface with our cloudflare oauth" exposed a gap: Cloudflare Access is not an IdP an application talks to, it is an identity-aware proxy that authenticates at the edge and forwards the result as a signed JWT in the Cf-Access-Jwt-Assertion header. The code flow above never fires in that topology.

So the plan gains a mode, and it moves to the front of the queue because it is the one a real deployment here would use, and because the same pattern covers Authelia, authentik, oauth2-proxy and every other identity-aware proxy in the self-hosted world:

**Trusted-header SSO.** Zimi validates the proxy's JWT against the issuer's published JWKS (for Cloudflare: the team domain's /cdn-cgi/access/certs), checks aud against the configured Access application tag, and maps the email claim onto the existing users store, creating-on-first-login with a configured default role. Config: issuer URL, audience, claim-to-user mapping, default role, and an enable flag that also requires the request to have arrived from the tunnel/proxy (loopback or a configured upstream address) so the header cannot be forged by a direct LAN client.

**Honest cost this mode reimports:** the header JWT arrives in a request, not over our own TLS channel to a token endpoint, so OIDC Core 3.1.3.7 rule 6 does NOT apply and real RS256 verification is required. That means either the optional [sso] extra (PyJWT+cryptography) or the pure-stdlib verify-only implementation weighed in Decision 1. This does not reopen Decision 1 for the code flow; it means the stdlib-verify (or extra) work lands earlier than planned, with the code flow reusing it later. Verify-only RSA in stdlib remains acceptable: no signing, no timing-sensitive secret handling, JWKS parse plus PKCS1 v1.5 verify plus strict alg pinning to RS256 (reject none/HS256 outright).

Phasing change: trusted-header SSO becomes Phase 1 of Workstream B, the OIDC code flow slides to Phase 2, both behind the same claim-mapping and session machinery so nothing is built twice.

**Built 2026-08-10.** Two things the design did not anticipate, both now settled in code and documented:

- **Sessions were not needed at all.** Cloudflare injects the header on *every* proxied request, including the reader iframe navigation and the plain-fetch data endpoints — the exact transports that forced the admin-session cookie into existence in 1.8.1. So Phase 1 is stateless: no session minted, no cookie set, identity re-derived per request from the header (with a 60-second verified-token memo so a page load does not re-verify dozens of times). The practical win is revocation: an operator who removes someone from an Access policy has removed them from Zimi immediately, with no Zimi-side session outliving the change.
- **The trust boundary is weaker than "loopback or a configured upstream" implies, and the docs now say so plainly.** In the topology this was written for — cloudflared in a sibling container on a NAS — the tunnel's address is private and so is every other machine on the LAN, so the default private-peer gate does not by itself stop a LAN client from forging the header. `ZIMI_SSO_PROXY` narrows it to the tunnel's CIDR, the startup log warns when it is unset, and `docs/deployment-networking.md` states the deployment rule as a rule rather than a footnote. A header from an untrusted peer is *ignored*, not 401'd, so a forger cannot deny service either.
