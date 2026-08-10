# Deploying Zimi

Two files, both complete and both meant to be copied rather than read as examples.

| | |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | A single host. This is what most people want. |
| [`kubernetes.yaml`](kubernetes.yaml) | A cluster. One namespace, one Deployment, one Service, two volumes. |

```bash
# Docker
mkdir -p zims && cp /path/to/*.zim zims/
docker compose -f deploy/docker-compose.yml up -d

# Kubernetes
kubectl apply -f deploy/kubernetes.yaml
```

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

## Update channels

An instance that can reach GitHub checks for new Zimi releases when an admin opens Manage ▸ Server — never at boot, never on a timer. `ZIMI_UPDATE_CHANNEL` decides what counts as a release:

| | |
|---|---|
| `stable` | Final releases only. The default, and what every install did before channels existed. |
| `latest` | Also betas and release candidates. On this channel `1.9.0-rc1` → `1.9.0-rc2` is an update; on stable it is not. |

Set the variable and the channel is locked to it — the Manage UI shows the choice greyed out and says which variable owns it, the same as every other environment-locked setting. Leave it unset and an admin can pick from the UI, which persists to the config volume. `beta` is accepted as a synonym for `latest`.

`ZIMI_OFFLINE=1` outranks all of it: an offline instance performs no check on any channel.
