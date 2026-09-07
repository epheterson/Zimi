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

## Step 4, written out before it starts

The breaking step, and the one that needs a review of its shape before code. Everything above it is invisible and has landed; this is where behaviour changes.

**What changes.** While no admin password exists, the only credential that opens management is the setup key. The host stops being a proof. `identify()` loses its `host` source; `_check_manage_auth` loses its loopback branch; `_is_loopback_client` stays for the log line and for nothing else.

**What it closes.** The residual 1.9.1 documented instead of fixing: a same-host forwarder that sends no forwarded header (`socat`, `proxy_pass` without `proxy_set_header`) presents a bare loopback peer that nothing can tell from the owner at the keyboard. With one door there is nothing to tell apart.

**What it costs, and the answer to each.**

- *The desktop app.* It runs the server in-process and gets admin by being on the host. It owns the data dir, so it reads the setup key from `setup-key` there and presents it once, then holds an admin session like any other client. One function in `desktop/`, and the app's user never sees a key.
- *The first run at a terminal.* `zimi serve` already prints the key in a box and writes it to the data dir at 0600. The banner's wording changes from "from this machine freely, or the key" to just the key.
- *`lan_admin`.* The quirk step 3 preserved — with it on, the LAN test is the whole passwordless answer — goes away: the key always works. `lan_admin` then means only what step 5 makes it mean, anonymous-account policy.
- *Existing installs.* Ones with a password are untouched. Passwordless ones on the host lose free bootstrap; the key is in their log and in their data dir. Release notes say so in one line.

**What proves it.** `tests/test_bootstrap_takeover.py::test_the_host_itself_bootstraps_freely` inverts: the host is refused without the key. The same-host-proxy tests stay. A new test drives `socat`'s shape — a loopback peer, no headers — and is refused. The desktop test presents the key from the data dir and gets a session.

**Order.** One commit for the server side with its tests; one for the desktop app; the release note. Not before Eric has read this section.
