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

Set `ZIMI_TORRENT=0`. That disables the BitTorrent engine, its DHT traffic, the NAT reachability probe, and a boot-time magnet lookup against `library.kiwix.org`. The Kubernetes manifest already sets it, since BitTorrent cannot work usefully in a cluster anyway.

More detail, including what talks to the network and when: [`../docs/deployment-networking.md`](../docs/deployment-networking.md).
