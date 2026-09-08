# One way to be trusted

Eric, 2026-09-06, after the same bootstrap bypass shipped twice: *"This whole support password especially for admin and api but also allow open thing is messy."*

He is right, and the mess is the reason the bug recurred. This is the design that replaces it.

---

## What exists today

Nine independent ways a request can end up trusted, spread across four modules:

| # | mechanism | lives in | grants |
|---|---|---|---|
| 1 | admin password, password file | `manage._get_manage_password_hash` | primary admin |
| 2 | admin password, `ZIMI_MANAGE_PASSWORD` | same, env layer | primary admin |
| 3 | API token (`api_token` file / env) | `manage._api_token_file` | primary admin |
| 4 | bootstrap setup key | `manage._bootstrap_key_ok` | everything, while no password exists |
| 5 | being on the host (loopback) | `http._is_loopback_client` | everything, while no password exists |
| 6 | `lan_admin` + direct private peer | `manage._lan_client` | primary admin, while no password exists |
| 7 | account + session cookie, role `admin` | `users.is_admin_session` | secondary admin |
| 8 | SSO trusted header | `sso.py` | an account, at a configured role |
| 9 | reader access mode (open / limited / private) | `users._ACCESS_MODES` | read access, separately from all the above |

`_check_manage_auth` alone branches on five of these. Two of the nine (4, 5) exist only during a window that most instances pass through once and never think about again, and that window is where both bypasses lived.

The failure this produces is not "a bug got in". It is that **no single place answers "who is this?"** — so a change to one branch cannot be reasoned about against the others, and a reviewer checking the advisory's PoC never looks at the proxy path.

## What replaces it

Three concepts.

### 1. Accounts

Everyone is an account, including nobody. `users.py` already has accounts, roles, allowlists and federated identity; this makes it the only answer.

- **`anonymous`** is a real account record, not the absence of one. Its role is what the reader access mode currently encodes: `admin` / `user` / `limited` / `none`. "Open" becomes `anonymous.role = user`. "Private" becomes `anonymous.role = none`.
- **SSO** creates or matches an account, which it already does.
- **The API token** becomes a token *on* an account (`tokens: [...]` in the user record), not a parallel god-mode that bypasses the account system entirely. An operator who wants today's behaviour issues a token on an admin account.

### 2. Roles

`admin`, `user`, `limited`, `none`, exactly as `users._ROLES` has them plus `none`. The primary/secondary admin split disappears: what "primary" really means is *the account that cannot be demoted by another admin*, which becomes a flag on the record (`protected: true`) rather than a second authorization path.

### 3. One bootstrap secret

**Always the setup key. No loopback exception.**

This is the change that matters, and the one that costs something. Today the host bootstraps freely, which is why:

- a reverse proxy on the same host handed every remote client the same freedom (GHSA-5mw2-53vv-9pw6, fixed in 1.9.1 for proxies that set a forwarded header);
- a same-host forwarder that sets no header at all (`socat`, `proxy_pass` with no `proxy_set_header`) still does, and no header inspection can ever tell it from the owner at the keyboard. 1.9.1 documents this residual in `_is_loopback_client` rather than closing it.

One door closes both, and it is *simpler*: the server prints a key on first start and writes it to the data dir at 0600; anyone claiming the first account presents it; the key is spent the moment an account exists. There is no second rule and therefore no exception to get wrong.

**Network position stops being a credential.** `lan_admin` becomes `anonymous.role = admin, from = private` — policy on an account, expressed once as configuration, rather than a branch inside the auth check.

## The cost, stated plainly

**The desktop app currently gets admin by being on the host.** Under one door it must read the setup key from the data dir it already owns and present it once. That is a real change to `desktop/` and it is the reason this is a release rather than a patch: a person upgrading finds the host no longer bootstraps freely.

Everything else is migration-compatible: existing password files, tokens and user records keep working, because they become records in a system that already stores records.

## Order of work

1. `anonymous` as a real account; access modes read from it. No behaviour change yet — the old code paths still answer, the new ones shadow them.
2. Tokens move onto accounts, with the existing token file migrated on first boot.
3. `admin_kind` collapses: one `identify(handler) -> Account` used everywhere, `_primary_admin_authorized` / `_secondary_admin_authorized` / `_creator_authorized` become role checks on its result.
4. The bootstrap door: setup key always, loopback exception deleted, desktop app taught to read the key.
5. `lan_admin` becomes anonymous-account policy; the env var keeps working as an alias.

Steps 1 to 3 are invisible to users and can land first. Step 4 is the breaking one and wants its own review.

## What must not regress

`tests/test_bootstrap_takeover.py` is the file that proves this, and its own history is a warning: it stubbed `_client_ip` wholesale, so for two releases it tested a double rather than the decision. Every test here drives a real socket and a real handler, or it proves nothing.

---

## Step 4, rewritten 2026-09-07 after Eric read it

The first draft made the setup key the only bootstrap door. Eric rejected it, and was right:

> *"The no auth thing… you got it wrong. When that's set it doesn't look for static auth somewhere, it's no auth required period. Like local only on a USB stick — c'mon just let me manage my shit."*

and then settled the shape of the whole thing:

> *"Either no auth or password required."*

**Two states. That is the entire model.**

| state | what it means |
|---|---|
| **no auth** | Nothing is asked, of anyone, for anything. No password, no key, no question about the address. It announces itself in the log at every boot. |
| **password** | A password is required. Every other credential — an account's session, an API token — belongs to an account and is checked the same way. |

There is no third state, and in particular **network position is never a credential**. Not loopback, not RFC1918, not "direct, unforwarded loopback". That branch is deleted rather than tightened.

**Why it is deleted, not tightened.** Research into fifteen comparable projects found that every one which treated a private address as identity has shipped an authentication bypass for it. Sonarr's [CVE-2026-30975](https://github.com/Sonarr/Sonarr/security/advisories/GHSA-h5qx-5hjf-7c9r) (CVSS 8.1) is Zimi's exact design: *authentication disabled for local addresses* plus a proxy that does not handle `X-Forwarded-For` correctly. Jellyfin's [CVE-2025-32012](https://github.com/jellyfin/jellyfin/security/advisories/GHSA-qcmf-gmhm-rfv9) is the same class — "authorizes requests from any device in the same local network… an attacker is able to spoof their IP to appear as a LAN IP". Zimi already hedges its own version with `_is_direct_private_client`, and that hedge is the tell: Sonarr shipped the same hedge and got the CVE anyway.

Home Assistant is the one project that does this carefully, and the cost of doing it carefully is the argument for not doing it at all: a trusted-networks list, a trusted-proxies list, a hard error when they overlap, and requests failing *closed* when the proxy configuration is incomplete. That is a lot of machinery for a question the two states above answer without asking.

**What changes in the code.**

- `_is_loopback_client`, `_is_direct_private_client` and `lan_admin` stop being authorization. The loopback test survives only for a log line.
- The bootstrap setup key goes away with them. There is no window to bootstrap: either authentication is off, or a password is set.
- The API token becomes a token *on an account*, not a parallel god-mode key. Grafana migrated global keys to owned service accounts for exactly this reason; Vaultwarden's `ADMIN_TOKEN` is the counter-example, and it only exists because the feature is absent when the token is unset.
- "Open" becomes an explicit anonymous account with a role, which is what step 1 already built.

**What the USB stick does.** Runs with authentication off, which is one setting, and manages its own library with nothing in the way. That is the case Eric named and it must stay frictionless.

**What a server on a network does.** Sets a password. If the operator instead turns authentication off on a reachable address, the log says so at every boot, in the wording Syncthing uses for the same choice: this allows access without authorization, and here is the warning you asked for by setting it.

**What proves it.** `tests/test_bootstrap_takeover.py` inverts: with no password and authentication not explicitly off, the host itself is refused, a private client is refused, a forwarded client is refused, and a same-host proxy is refused — all four the same way, because there is only one answer. With authentication off, all four are allowed, again the same way. The tests that drive a real socket stay; the ones that assert a network-position exception are deleted with the branch.

**Migration.** An install with a password is untouched. A passwordless install that was relying on being on the host now has to choose: set a password, or turn authentication off. That is a breaking change, it is the reason this is 1.10 and not a patch, and it is one line in the release notes.
