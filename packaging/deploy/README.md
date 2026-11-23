# Deploying Zimi

Three files, all complete and all meant to be copied rather than read as examples.

| | |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | A single host. This is what most people want. |
| [`podman/zimi.container`](podman/zimi.container) | A single host on Fedora, RHEL or anywhere Podman is the container tool: rootless, started by systemd. |
| [`kubernetes.yaml`](kubernetes.yaml) | A cluster. One namespace, one Deployment, one Service, two volumes. |

```bash
# Docker
mkdir -p zims && cp /path/to/*.zim zims/
docker compose -f packaging/deploy/docker-compose.yml up -d

# Podman (rootless, at boot)
mkdir -p ~/zimi/zims ~/zimi/config && cp /path/to/*.zim ~/zimi/zims/
cp packaging/deploy/podman/zimi.container ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user start zimi

# Kubernetes
kubectl apply -f packaging/deploy/kubernetes.yaml
```

The Podman unit carries two flags Docker never needed, and the file says why: `keep-id` so the ZIMs Zimi downloads are owned by you rather than a subordinate UID, and `:Z` for SELinux. CI runs the image rootless under Podman on every change and checks the ownership claim.

Then open port 8899. There is no setup step, no account to create, and no first-run wizard: Zimi serves whatever ZIMs it finds.

The compose file at the **repo root** is a different thing. It builds from source and exists for working on Zimi. The one in this directory pulls a released image and never needs the source tree.

## Three things worth knowing before you pick

**Back up the config volume, not the library.** ZIMs are re-downloadable from Kiwix. The config volume holds your search indexes, bookmarks, users, and policies, and it is the part that is actually yours.

**Peer-to-peer needs a real LAN.** LAN peer discovery (mDNS) and BitTorrent seeding both need to see the network directly, so they work under host networking and do not work in a cluster. Everything a reader touches works either way. If sharing ZIMs peer-to-peer is why you run Zimi, run it on a host.

**Run one instance per config volume.** Zimi keeps state on a filesystem rather than in a database, so two processes writing the same volume will corrupt the search indexes. Give the instance more CPU rather than adding replicas.

## Air-gapped

Set `ZIMI_OFFLINE=1`. That is the single switch: no BitTorrent engine, no DHT, no NAT probe, no catalog fetch, no update check of any kind, whatever else is configured. Link-local mDNS peer discovery deliberately stays on, because sharing ZIMs between two Zimis on an isolated LAN is the point — turn that off too with `ZIMI_NEARBY=off`.

`ZIMI_TORRENT=0` is the narrower switch: BitTorrent, its DHT traffic, the NAT reachability probe and a boot-time magnet lookup against `library.kiwix.org`, but not the catalog or update checks. The Kubernetes manifest sets it, since BitTorrent cannot work usefully in a cluster anyway.

More detail, including what talks to the network and when: [`../docs/deployment-networking.md`](../docs/deployment-networking.md).

### Getting Zimi onto the isolated machine

`scripts/make-airgap-bundle.sh` builds everything the other side needs into one directory (and a tarball): Zimi and every dependency as wheels, the deployment manifests, optionally a `docker save`d image and the ZIM files, an `install.sh`, and a `SHA256SUMS` covering all of it. Run it on a connected machine, carry the result over, run `install.sh` there. Nothing on the isolated side reaches for the network — the install is `pip install --no-index`, which cannot.

```bash
# For a Linux x86_64 target running Python 3.12
scripts/make-airgap-bundle.sh --target linux-x86_64 --python-version 3.12

# Everything, onto a USB drive: image and ZIMs included
scripts/make-airgap-bundle.sh /media/usb/zimi --docker --zim /srv/zims
```

Then on the isolated machine:

```bash
./install.sh
ZIM_DIR=/path/to/zims ZIMI_OFFLINE=1 python3 -m zimi serve --port 8899
```

**Name the target you are building for.** Wheels are specific to an operating system, a CPU architecture and a Python version, so a bundle built on a Mac does not install on a Linux server. `--target` (`linux-x86_64`, `linux-arm64`, `macos-arm64`, `macos-x86_64`, `windows-x86_64`) plus `--python-version` expands to the platform tags those wheels are actually published under; without them you get a bundle for the machine you are standing at. The script refuses to write a bundle whose dependencies did not all resolve to wheels, because a source distribution cannot be built on a machine with no network and no toolchain — if it stops with that error, the target you named is the thing to fix.

Upgrading an air-gapped instance means building a new bundle on the connected machine and running its `install.sh` again. There is no other path in, by design.

## Update checks

An instance that can reach GitHub checks for new Zimi releases when an admin opens Manage ▸ Server, never at boot and never on a timer. Only finished releases count; there is no beta track.

## Update delay

`ZIMI_UPDATE_DELAY_DAYS` holds a release back until it has been public that long — the fleet equivalent of letting someone else go first. `0` (the default) offers a release the moment it exists; `ZIMI_UPDATE_DELAY_DAYS=7` means a release published today is offered a week from today. A held release is not hidden: Manage ▸ Server names the version and says when it will be offered, so an admin who wants it early can still take it from the releases page.

The waiting period is measured from GitHub's publish date and re-evaluated on every read, so a release matures on schedule without anyone poking the check. A release with no publish date is treated as mature — a missing field must never hide an update permanently. The same env-lock rule applies: set the variable and the UI control greys out.

`ZIMI_OFFLINE=1` outranks all of it: an offline instance performs no check, with or without a delay.
