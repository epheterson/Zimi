# Third-party software distributed with Zimi desktop builds

## aria2

Desktop builds of Zimi include an unmodified `aria2c` binary as a separate
sidecar process for BitTorrent transfers.

- Project: https://aria2.github.io/
- License: GNU General Public License v2 (with OpenSSL linking exception)
- Source code: https://github.com/aria2/aria2
- macOS builds bundle aria2 and its dependency libraries from Homebrew
  (https://formulae.brew.sh/formula/aria2); Linux builds bundle the static
  binary from https://github.com/abcfy2/aria2-static-build

aria2 is aggregated alongside Zimi, not linked into it. Zimi communicates
with it only over its JSON-RPC interface and works without it (HTTP
downloads). The complete corresponding source for the bundled binaries is
available at the links above.
