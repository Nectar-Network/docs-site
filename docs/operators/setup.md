---
title: Operator Setup
description: Build, configure, stake, and run a Nectar keeper from the monorepo on Stellar testnet.
---

# Operator Setup

This guide takes you from a fresh checkout to a running keeper that monitors the Blend pool, competes for liquidation auctions, and books profit back to the vault. Everything here targets the **current testnet deployment** — see [Contract Addresses](../reference/contract-addresses) for the authoritative list.

:::info Tranche 2 reality
The keeper is the off-chain daemon in `keeper/` (Go). It self-registers on first run by calling `KeeperRegistry.register`, which pulls exactly `min_stake` USDC (100 USDC on testnet) from your keeper account into the registry contract. There is no separate CLI subcommand for registering or staking — running the binary does it.
:::

## Prerequisites

- **Go 1.24+** ([install](https://go.dev/dl/)). The keeper module declares `go 1.24.0`.
- A **Stellar keypair** (`S...` secret) dedicated to this keeper, funded with **XLM** for transaction fees.
- **At least 200 USDC** on testnet in the keeper account: 100 USDC is locked as stake on registration, and you want margin left over to pay fees and act as the keeper's working float. On testnet this is a mock SAC; mainnet (Tranche 3) will use Circle USDC.
- An always-on machine or VPS — keepers race each other, so downtime means lost fills and, if a draw is left outstanding, slashing risk.

:::warning Use a dedicated keypair
Use a fresh keypair for each keeper instance. The secret key (`KEEPER_SECRET`) signs every transaction and controls the staked USDC. Do not reuse a key that holds personal funds.
:::

## 1. Clone and build the binary

The keeper is a single `main` package at the root of `keeper/` — there is no `cmd/` subdirectory.

```bash
git clone https://github.com/Nectar-Network/nectar.git
cd nectar/keeper
go build -o nectar-keeper .
```

You now have a `nectar-keeper` binary in `keeper/`. To sanity-check the toolchain before building, run the test suite (race detector on, as CI does):

```bash
go test -race ./...
```

## 2. Set the required environment variables

The keeper is configured **entirely through environment variables** — there is no config file. It loads a `.env` file from the working directory at startup (via `godotenv`, best-effort) and then reads the process environment. Create a `.env` in `keeper/` or export the variables directly.

These four are **required** — a missing one prints `missing required env: <KEY>` to stderr and exits with status 1:

```bash
export KEEPER_SECRET="S..."   # keeper Stellar secret key (signs all txs)
export KEEPER_NAME="my-keeper"    # human-readable name, used at registration
export REGISTRY_CONTRACT="CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB"
export VAULT_CONTRACT="CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345"
```

:::note KEEPER_NAME default
`KEEPER_NAME` is technically optional — it defaults to `nectar-keeper-1`. Set it to something distinctive so your operator is identifiable on the [keeper leaderboard](https://nectarnetwork.fun/dashboard/keepers).
:::

To actually monitor for liquidations you also want the Blend pool and the network endpoints. These have testnet defaults, so the minimum useful testnet config adds just the pool:

```bash
# Blend pool to monitor. Empty disables the liquidation cycle (vault-monitor-only).
export BLEND_POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"

# USDC token — required for collateral-swap proceeds and stale-draw recovery.
export USDC_CONTRACT="CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW"
```

The endpoints below default to testnet and only need to be set if you are overriding them:

| Variable | Default |
|----------|---------|
| `SOROBAN_RPC` | `https://soroban-testnet.stellar.org:443` |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` |
| `POLL_INTERVAL` | `10` (seconds; must be in `[3, 300]`) |
| `MIN_PROFIT` | `1.02` (minimum lot/bid ratio to fill; must be `> 0`) |
| `API_PORT` | `8080` (HTTP API / SSE / metrics) |

See [Configuration](./configuration) for the complete variable list, including DEX (`SOROSWAP_ROUTER`, `PHOENIX_ROUTER`, `SLIPPAGE_BPS`) and DeFindex (`DEFINDEX_VAULT`, `DEFINDEX_DRIFT_BPS`) options.

:::tip USDC_CONTRACT is not optional in practice
`USDC_CONTRACT` defaults to empty, but leaving it empty disables two safety behaviors: crediting USDC lots directly and **stale-draw recovery** (returning capital the keeper drew but never repaid). Always set it on a keeper that draws vault capital.
:::

## 3. Fund the keeper account

Your keeper address needs both assets before it can register and operate.

- **XLM** for transaction fees. Fund from Friendbot:

  ```bash
  curl "https://friendbot.stellar.org/?addr=<YOUR_KEEPER_G_ADDRESS>"
  ```

- **USDC** — at least the 100 USDC stake plus working margin. On testnet, mint the mock SAC. If you are the deployment admin, the repo's helper script mints `2 × min_stake` to each keeper before registering:

  ```bash
  ./scripts/register-keepers-testnet.sh
  ```

  Otherwise, mint to your keeper address with the Stellar CLI (admin signs the mint; amounts are in 7-decimal stroops, so 200 USDC = `2000000000`):

  ```bash
  stellar contract invoke \
    --id CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW \
    --source <ADMIN_SECRET> \
    --rpc-url https://soroban-testnet.stellar.org:443 \
    --network-passphrase "Test SDF Network ; September 2015" \
    -- mint --to <YOUR_KEEPER_G_ADDRESS> --amount 2000000000
  ```

:::warning Insufficient stake fails hard
Registration transfers exactly `min_stake` (100 USDC) from your account into the registry. If your balance is below that, the token transfer panics inside the contract — it surfaces as a host error, not a typed `ContractError`, and your keeper is **not** registered. Confirm the balance lands before running.
:::

## 4. Start the daemon

```bash
./nectar-keeper
```

On startup the keeper, in order:

1. Loads `.env` and parses `KEEPER_SECRET`.
2. Calls `KeeperRegistry.register(operator, name)`. The contract pulls `min_stake` USDC and creates your `KeeperInfo`. **Registration is idempotent** — if you are already registered, the `AlreadyRegistered` error is swallowed and logged as a warning ("registration skipped (may already be registered)"); it is never fatal.
3. Builds its adapters — always the Blend adapter, plus a DeFindex adapter if `DEFINDEX_VAULT` is set. A DEX swap client is wired in only when `SOROSWAP_ROUTER` or `PHOENIX_ROUTER` is set.
4. Starts the HTTP API on `API_PORT` (`/api/state`, `/api/events` SSE, `/api/performance`, `/metrics`, `/healthz`).
5. Begins the poll loop on a `POLL_INTERVAL`-second ticker, handling `SIGTERM`/`SIGINT` for clean shutdown.

Each cycle the keeper first runs **stale-draw recovery** (returns any capital drawn but unreturned in a prior cycle, capped at what it owes), then for each adapter scans for tasks, sorts them highest-priority first, and executes them. For Blend: it loads pool positions, flags any with health factor `< 1.0`, creates and fills the user-liquidation auction when the lot/bid ratio clears `MIN_PROFIT`, swaps seized collateral to USDC, and returns drawn capital plus profit via `return_proceeds`.

:::info No coordinator
Multiple keepers race the same auction. The first confirmed fill wins; losers receive `ErrAlreadyFilled`, return their unspent draw unchanged (no profit, no loss), and move on. There is no central coordinator and no single point of failure.
:::

## 5. Verify it is monitoring

**Liveness** — the health endpoint returns `200 OK` once the API is up:

```bash
curl -i http://localhost:8080/healthz
```

**Live state** — `/api/state` returns the keeper's current view: registered keepers, pool positions with health factors, recent event log lines, and vault state:

```bash
curl http://localhost:8080/api/state
```

**Metrics** — `/metrics` exposes Prometheus counters, including cycle and liquidation totals and vault TVL (7-decimal):

```bash
curl http://localhost:8080/metrics
```

```text
# HELP nectar_cycles_total Number of keeper poll cycles
nectar_cycles_total 12
# HELP nectar_liquidations_total Number of successful auction fills
nectar_liquidations_total 0
# HELP nectar_vault_tvl Vault total USDC (7 decimals)
nectar_vault_tvl 10100000000
# HELP nectar_sse_active Active SSE connections
nectar_sse_active 0
```

**On-chain registration** — confirm the registry recorded your stake by reading `get_keeper`. A registered keeper returns its `KeeperInfo` (with `stake = 1000000000`, i.e. 100 USDC in stroops); an unregistered one returns `NotRegistered`:

```bash
stellar contract invoke \
  --id CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB \
  --source <YOUR_KEEPER_SECRET> \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- get_keeper --operator <YOUR_KEEPER_G_ADDRESS>
```

**Dashboard** — your operator appears on the [keeper leaderboard](https://nectarnetwork.fun/dashboard/keepers) once the registry read picks it up. Execution count, win rate, average response time, and total profit populate as you complete fills.

:::tip Watch the live log
Tail the event stream to see scans and fills as they happen:

```bash
curl -N http://localhost:8080/api/events
```
:::

## Running as a service

For a durable deployment, run the binary under a process manager that restarts on exit. A minimal `systemd` unit:

```ini
[Unit]
Description=Nectar Keeper
After=network.target

[Service]
Type=simple
User=nectar
EnvironmentFile=/etc/nectar/keeper.env
ExecStart=/opt/nectar/nectar-keeper
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The keeper is **stateless** — all state is read from chain each cycle — so it restarts safely. Stale-draw recovery means a crash mid-fill is repaired on the next start, provided `USDC_CONTRACT` is set. For containerized and Railway deployments, see [Docker](./docker).

:::danger Keep XLM on hand
Running out of XLM mid-fill can leave a draw outstanding. If `return_proceeds` is never called within `slash_timeout` (1 hour on testnet) of the draw, **anyone** can permissionlessly call `slash` and take `slash_rate_bps` (10%) of your stake. See [Staking & Slashing](./staking).
:::

## What's next

- [Configuration](./configuration) — every environment variable, with defaults and ranges.
- [Staking & Slashing](./staking) — how stake, draws, and the slash timeout work.
- [Strategies](./strategies) — tuning `MIN_PROFIT`, poll interval, and DEX routing.
- [Docker](./docker) — containerized and Railway deployment.
- [Troubleshooting](./troubleshooting) — common startup and runtime errors.
- [Contract Addresses](../reference/contract-addresses) — current testnet IDs.
