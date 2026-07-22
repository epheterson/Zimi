# Security Policy

## Supported versions

Zimi ships from a single active line. Security fixes land on the latest
release; there is no back-porting to older tags. Always run the newest
version (`pip install -U zimi`, `docker pull epheterson/zimi:latest`, or
the latest desktop build).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/epheterson/Zimi/security/advisories)
2. Click **Report a vulnerability**
3. Describe the issue, affected version, and reproduction steps

You'll get an acknowledgement as soon as it's seen. Once a fix is out,
the advisory is published with credit to the reporter (unless you'd
rather stay anonymous).

## Scope

Zimi is an offline-first, self-hosted knowledge server. The most
relevant surfaces:

- **Network exposure** — the HTTP server, rate limiting, and the
  private-IP gating on peer file serving (`/dl/`).
- **Authentication** — the manage-mode password and API token flow.
- **Content handling** — how ZIM article HTML is served and rewritten.
- **Peer/P2P** — LAN discovery (mDNS), direct HTTP peer pulls, and the
  optional BitTorrent accelerator.

Running Zimi behind a reverse proxy on the public internet is
supported, but you own the transport security (TLS) and access control
of that proxy.
