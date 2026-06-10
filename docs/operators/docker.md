---
title: Docker & Deployment
description: Run a Nectar keeper with docker-compose, deploy it to Railway, and what one-command packaging looks like in Tranche 3.
---

# Docker & Deployment

The Nectar keeper is a single static Go binary. It is stateless — every cycle reads its state from chain, so restarts are always safe and there are no volumes to manage. This page covers the three supported ways to run it: locally with `docker-compose`, on Railway (the path the reference `keeper-alpha` / `keeper-beta` operators use), and the one-command packaging planned for Tranche 3.

:::info
New to keepers? Start with [Keeper Setup](./setup) to generate a keypair and stake, then come back here to containerize it. Every environment variable is documented in the [Configuration Reference](./configuration).
:::

## The image

There is no pre-published image in Tranche 2 — you build from the repo's `keeper/Dockerfile`. It is a two-stage build that produces a ~15 MB Alpine image with a static binary and CA certificates:

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o keeper .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/keeper .
ENTRYPOINT ["./keeper"]
```

The binary serves an HTTP API (state, SSE event stream, performance, Prometheus metrics, and a health check) on `API_PORT` (default `8080`). The container exposes nothing else.

:::note
Publishing a tagged multi-arch image to a public registry is part of the Tranche 3 [one-command packaging](#tranche-3-one-command-packaging) work. Until then, build locally or let Railway build from the `Dockerfile`.
:::

## Run with docker-compose

The repo ships a `docker-compose.yml` at its root that builds and runs the two reference keepers (`keeper-alpha` on port 8080, `keeper-beta` on port 8081) plus the `frontend` (port 3000). All three pull shared values from a root `.env` file via `env_file: .env`.

### 1. Create your `.env`

Copy the template and fill in your addresses and secrets:

```bash
cp .env.example .env
```

The compose file reads the two keeper secrets from `KEEPER_A_SECRET` and `KEEPER_B_SECRET` (each container's `KEEPER_NAME` and `API_PORT` are set inline in the compose file). A minimal `.env` for the **current testnet deployment** looks like:

```bash
# Keeper secrets — one per container (keep these private)
KEEPER_A_SECRET=S...
KEEPER_B_SECRET=S...

# Current testnet (Tranche 1 hardened, 2026-05-24)
REGISTRY_CONTRACT=CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB
VAULT_CONTRACT=CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345
USDC_CONTRACT=CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW
BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF

# DEX (collateral → USDC after fills); Soroswap primary, Phoenix optional
SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD

# Network (testnet defaults — override only if needed)
SOROBAN_RPC=https://soroban-testnet.stellar.org:443
HORIZON_URL=https://horizon-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Tuning
POLL_INTERVAL=10
MIN_PROFIT=1.02
```

Always confirm these against the [Contract Addresses](../reference/contract-addresses) page — the registry/vault/USDC IDs are redeployed between tranches, and pointing at a deprecated set will silently fail to register or draw.

:::warning
`.env` holds your keeper secret keys. Lock it down and never commit it:

```bash
chmod 600 .env
```

It is already in `.gitignore`. Set permissions before you populate it.
:::

### 2. Bring up a keeper

Both keepers, the frontend, and rebuilds:

```bash
docker compose up --build
```

Just one keeper (matches `docker-compose up keeper` in the project layout — the real service name is `keeper-alpha`):

```bash
docker compose up keeper-alpha
```

Detached, with logs followed afterward:

```bash
docker compose up -d keeper-alpha
docker compose logs -f keeper-alpha
```

On startup a keeper attempts to register itself in the `KeeperRegistry` (idempotent — an `AlreadyRegistered` result is treated as success), starts the HTTP API, and begins polling the Blend pool every `POLL_INTERVAL` seconds. See [Keeper Setup](./setup) for the log lines you should expect.

### 3. Health and observability

Each keeper container declares a healthcheck that hits `/healthz`. The endpoint returns a bare `200 OK` (empty body) whenever the API server is up:

```bash
curl -i http://localhost:8080/healthz
# HTTP/1.1 200 OK
```

The same server exposes the live operational endpoints (consumed by the dashboard):

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness probe — `200 OK`, empty body |
| `GET /metrics` | Prometheus metrics (cycles, liquidations, etc.) |
| `GET /api/state` | Current pool positions + health factors (JSON) |
| `GET /api/performance` | Vault state, depositors, keeper stats, liquidation history (JSON) |
| `GET /api/events` | Server-Sent Events log stream (capped at 100 clients) |

Compose also configures JSON-file logging with rotation (`max-size: 50m`, `max-file: 3`) and `restart: unless-stopped` on every service.

:::tip
A changed `.env` is **not** hot-reloaded. After editing it, recreate the container — `docker compose up -d --force-recreate keeper-alpha` — rather than relying on a plain `up`.
:::

### Build from source without compose

If you only want the container by itself:

```bash
git clone https://github.com/Nectar-Network/nectar.git
cd nectar/keeper
docker build -t nectar-keeper:local .

docker run -d \
  --name nectar-keeper \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file ../.env \
  -e KEEPER_SECRET="$KEEPER_A_SECRET" \
  -e KEEPER_NAME="my-keeper" \
  nectar-keeper:local
```

Note that a standalone container needs `KEEPER_SECRET` (not `KEEPER_A_SECRET`) — the `A`/`B` split is a compose convention so two containers can share one `.env`. See the [Configuration Reference](./configuration) for the full variable list and validation rules (e.g. `POLL_INTERVAL` must be 3–300, `SLIPPAGE_BPS` 0–10000).

## Deploy to Railway

The reference operators (`keeper-alpha`, `keeper-beta`) run on Railway, one service per keeper. The repo's `keeper/railway.toml` tells Railway to build from the `Dockerfile` and run the binary:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "./keeper"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
healthcheckPath = "/healthz"
healthcheckTimeout = 30
```

Railway uses the `/healthz` probe to gate deploys and the `ON_FAILURE` restart policy (max 5 retries) to recover crashes. Because the keeper is stateless, a restart re-reads everything from chain.

### 1. Link the service and push

From the `keeper/` directory (it contains both the `Dockerfile` and `railway.toml`):

```bash
cd keeper
railway link        # pick the keeper-alpha (or keeper-beta) service
railway up
```

`railway up` uploads the build context and Railway builds the image from the `Dockerfile`.

### 2. Set environment variables

Set the **public** (non-secret) variables with the helper script, which writes them to the linked service:

```bash
./scripts/railway-keeper-env.sh keeper-alpha   # or keeper-beta
```

This sets `KEEPER_NAME`, `REGISTRY_CONTRACT`, `VAULT_CONTRACT`, `USDC_CONTRACT`, `SOROBAN_RPC`, `HORIZON_URL`, `POLL_INTERVAL`, `MIN_PROFIT`, and `API_PORT`. `BLEND_POOL` is set only when it is non-empty in your shell (the Railway CLI rejects empty values), so export it first or set it later:

```bash
BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF \
  ./scripts/railway-keeper-env.sh keeper-alpha

# or afterwards
railway variables --set BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
```

:::danger
The script deliberately does **not** set `KEEPER_SECRET` — CLI-set values land in your shell history. Add it in the Railway dashboard: **Variables → New Variable → tick "Mark as secret"**. One distinct secret per service.
:::

:::warning
Confirm the contract addresses the script applies before you deploy. Older copies of `railway-keeper-env.sh` and `railway.toml` may carry **deprecated** registry/vault IDs from an earlier tranche. The authoritative current testnet set is on [Contract Addresses](../reference/contract-addresses); cross-check the values Railway ends up with via `railway variables`.
:::

### 3. Verify

Each Railway service gets a public URL. Probe the API the same way you would locally:

```bash
curl -i https://keeper-alpha-production.up.railway.app/healthz
curl    https://keeper-alpha-production.up.railway.app/api/performance
```

Within a poll interval your keeper appears on the [dashboard leaderboard](https://nectarnetwork.fun/dashboard/keepers).

## Without Docker

You don't need a container to run a keeper. A static binary under `systemd` (or any process manager) is fully supported and covered in [Keeper Setup](./setup#running-as-a-service). Docker/Railway is simply the path the reference operators use and the one Tranche 3 packages.

## Tranche 3: one-command packaging

Container packaging is hardened in Tranche 3. The goal is that a third-party operator can go from zero to a registered, running keeper with a single command, paired with the published [keeper SDK](../developers/keeper-sdk). Planned deliverables:

- A **tagged, multi-arch image** published to a public registry so operators `docker run` a pinned version instead of building from source.
- A **bootstrap script / compose profile** that prompts for a secret, funds and stakes the keeper, and starts the container in one step.
- Hardened production defaults to accompany the **mainnet deployment** (Circle USDC, production registry/vault parameters) and the operator security work (rate limits, draw caps).

:::info
Until Tranche 3 ships, build from source — locally with `docker compose up --build` or on Railway via `railway up` — exactly as documented above. Nothing about the keeper's runtime contract changes; packaging only makes the build step disappear.
:::

## Common issues

- **Container exits immediately** — a required variable is missing. The keeper exits with `missing required env: <KEY>` if `KEEPER_SECRET`, `REGISTRY_CONTRACT`, or `VAULT_CONTRACT` is blank. Check `docker compose logs keeper-alpha`.
- **Out-of-range value** — `POLL_INTERVAL` (3–300), `MIN_PROFIT` (> 0), `SLIPPAGE_BPS` / `DEFINDEX_DRIFT_BPS` (0–10000) are validated at startup; a bad value prints to stderr and exits.
- **Registers but never fills** — usually a deprecated `BLEND_POOL` or contract address, or the keeper has no underwater positions to act on. With `BLEND_POOL` empty the keeper runs in vault-monitor-only mode (API serves, no liquidation cycle).
- **Stale `.env`** — recreate the container after editing it; compose does not reload env on a plain `up`.

For everything else, see [Troubleshooting](./troubleshooting).
