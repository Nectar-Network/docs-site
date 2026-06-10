---
title: Docker Deployment
description: Run a Nectar keeper in Docker
---

# Docker Deployment

:::info
This takes ~5 minutes. You'll need: Docker, your keeper config, and a funded keypair.
:::

The Nectar repo publishes a multi-arch image at `ghcr.io/nectar-network/nectar-keeper`. Tags follow the protocol release: `v1`, `v1.2`, `latest`.

## Quick start

```bash
docker run -d \
  --name nectar-keeper \
  --restart unless-stopped \
  -e KEEPER_SECRET="S..." \
  -e KEEPER_NAME="my-keeper" \
  -e REGISTRY_CONTRACT="C..." \
  -e VAULT_CONTRACT="C..." \
  -e BLEND_POOL="C..." \
  -e SOROBAN_RPC="https://soroban-testnet.stellar.org:443" \
  -e POLL_INTERVAL="10" \
  -e MIN_PROFIT="1.02" \
  ghcr.io/nectar-network/nectar-keeper:latest
```

Check logs:

```bash
docker logs -f nectar-keeper
```

## With an env file

Put your config in `keeper.env`:

```bash
KEEPER_SECRET=S...
KEEPER_NAME=my-keeper
REGISTRY_CONTRACT=C...
VAULT_CONTRACT=C...
BLEND_POOL=C...
SOROBAN_RPC=https://soroban-testnet.stellar.org:443
POLL_INTERVAL=10
MIN_PROFIT=1.02
```

Then:

```bash
docker run -d \
  --name nectar-keeper \
  --restart unless-stopped \
  --env-file keeper.env \
  ghcr.io/nectar-network/nectar-keeper:latest
```

:::warning
`keeper.env` contains your secret key. Set permissions to `600` and never commit it to git.
:::

```bash
chmod 600 keeper.env
```

## docker-compose

```yaml
services:
  keeper:
    image: ghcr.io/nectar-network/nectar-keeper:latest
    container_name: nectar-keeper
    restart: unless-stopped
    env_file: keeper.env
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

Run with:

```bash
docker compose up -d
docker compose logs -f
```

## Building from source

```bash
git clone https://github.com/Nectar-Network/nectar-poc.git
cd nectar-poc/keeper
docker build -t nectar-keeper:local .
docker run -d --env-file keeper.env nectar-keeper:local
```

## Health checks

The image exposes a `/healthz` endpoint on port 8080 when `METRICS_ENABLED=true`:

```bash
docker run -d \
  -p 8080:8080 \
  -e METRICS_ENABLED=true \
  --env-file keeper.env \
  ghcr.io/nectar-network/nectar-keeper:latest

curl http://localhost:8080/healthz
# {"status":"ok","registered":true,"last_poll_unix":1717000000}
```

## Updating

```bash
docker pull ghcr.io/nectar-network/nectar-keeper:latest
docker stop nectar-keeper
docker rm nectar-keeper
# Re-run with the same arguments / env file
```

The keeper persists no local state; it reads everything from chain on startup. Restarts are safe.

## Common issues

See [Troubleshooting](./troubleshooting). The most common Docker-specific problem is a stale env file: changes to `keeper.env` require a container restart, not just `compose up`.
