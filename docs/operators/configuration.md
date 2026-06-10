---
title: Configuration Reference
description: Every environment variable accepted by the Nectar keeper daemon, grouped by concern, with defaults and validation rules.
---

# Configuration Reference

The Nectar keeper is configured **entirely through environment variables** — there is no config file format. On startup the daemon loads a `.env` file from the working directory if one is present (best-effort; a missing file is not an error), then reads the environment.

:::info
All monetary values on Stellar use **7-decimal precision**: 1 USDC = `10,000,000` stroops. The keeper accepts human-friendly env values (ratios, basis points, seconds) and converts internally — you never type stroops in config.
:::

Required variables are read with a strict loader: if any of `KEEPER_SECRET`, `REGISTRY_CONTRACT`, or `VAULT_CONTRACT` is blank or whitespace-only, the keeper prints `missing required env: <KEY>` to stderr and exits with status `1`. Numeric variables that fail to parse, or that fall outside their allowed range, also print an error and exit `1` — the daemon never silently falls back to a default on a malformed value.

---

## Required

These three must be set or the keeper will not start.

| Variable | Type | Description |
|----------|------|-------------|
| `KEEPER_SECRET` | string (`S...`) | Stellar secret key for the keeper account. Signs every transaction (register, draw, fill, return). |
| `REGISTRY_CONTRACT` | string (`C...`) | Contract ID of the deployed [`KeeperRegistry`](../developers/contracts/keeper-registry). |
| `VAULT_CONTRACT` | string (`C...`) | Contract ID of the deployed [`NectarVault`](../developers/contracts/nectar-vault). |

:::warning
Use a dedicated keypair for each keeper instance. Running two keepers from the same secret key makes them fight over account sequence numbers, and they will lose races to other operators. Never reuse a key that holds personal funds — the keeper account is exposed to slashing.
:::

---

## Network

Endpoints and the network passphrase. All default to **Soroban Testnet**; override the passphrase (and endpoints) to point the same binary at mainnet in Tranche 3.

| Variable | Default | Description |
|----------|---------|-------------|
| `SOROBAN_RPC` | `https://soroban-testnet.stellar.org:443` | Soroban JSON-RPC endpoint used for `simulateTransaction`, `sendTransaction`, and `getEvents`. |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon API endpoint, used for account and fee discovery during transaction assembly. |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network passphrase for transaction signing. Override for mainnet. |

---

## Identity & operation

How the keeper presents itself and how often it runs its monitoring loop.

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `KEEPER_NAME` | `nectar-keeper-1` | optional | Human-readable name recorded on-chain at registration and shown on the keeper leaderboard. |
| `POLL_INTERVAL` | `10` | optional | Seconds between monitoring cycles. Parsed as an integer; **must be in `[3, 300]`** or the keeper exits. Lower means faster reaction to underwater positions but more RPC load. |
| `MIN_PROFIT` | `1.02` | optional | Minimum lot/bid value ratio required to fill an auction. Parsed as a float; **must be `> 0`** or the keeper exits. `1.02` means require a 2% gross margin before drawing capital. |
| `API_PORT` | `8080` | optional | TCP port for the keeper's HTTP API and SSE stream (`/api/state`, `/api/events`, `/api/performance`, `/metrics`, `/healthz`). |

:::tip
The profitability check compares the Dutch-auction lot value against the bid cost at the current block. A position is only acted on when its health factor is below `1.0` **and** the computed ratio meets `MIN_PROFIT`. See [Strategies](./strategies) for how to tune `MIN_PROFIT` against your stake and infrastructure.
:::

---

## Protocol targets

Which on-chain venues the keeper monitors. The Blend pool drives liquidations; the DeFindex vault drives optional rebalancing. Both are off by default — an empty value disables the corresponding adapter.

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `BLEND_POOL` | `""` (empty) | optional | Blend pool contract ID to monitor for liquidatable positions. When empty, the Blend adapter's task scan returns no tasks (the keeper runs but finds nothing to do). |
| `USDC_CONTRACT` | `""` (empty) | optional | USDC token contract. Seized collateral is swapped into this asset. When empty, stale-draw recovery and direct-USDC lot crediting are both disabled. |
| `DEFINDEX_VAULT` | `""` (empty) | optional | DeFindex vault contract to rebalance. When empty, the DeFindex adapter is **not registered**. This adapter never draws Nectar vault capital — it only rebalances the DeFindex vault's own funds. |

:::warning
`USDC_CONTRACT` is technically optional, but you should set it for any real keeper. Without it the keeper cannot swap collateral to USDC and cannot run stale-draw recovery, so any non-USDC collateral seized from a fill is held rather than returned to the vault — which leaves an outstanding draw at slash risk.
:::

---

## DEX integration (Tranche 2)

Collateral seized from a winning fill is swapped to USDC before being returned to the vault. The keeper tries **Soroswap first**, then falls back to **Phoenix**. The DEX swap client is constructed only when at least one of these routers is set; if both are empty, no swapping occurs and only collateral that is already USDC counts toward proceeds.

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `SOROSWAP_ROUTER` | `""` (empty) | optional | Soroswap router contract (primary DEX). Empty disables this venue. |
| `PHOENIX_ROUTER` | `""` (empty) | optional | Phoenix XYK pool/pair contract for the collateral↔USDC pair (fallback DEX). Empty disables this venue. |
| `SLIPPAGE_BPS` | `100` | optional | Maximum acceptable swap slippage in basis points (`100` = 1%). Parsed as an integer; **must be in `[0, 10000]`** or the keeper exits. |

The slippage floor is **oracle-anchored**: the keeper computes the Blend-oracle-implied USDC value of the lot and rejects a swap whose quote falls below `value × (10000 − SLIPPAGE_BPS) / 10000`. This prevents a manipulated pool quote from passing the check. A Soroswap quote that breaches the floor returns a slippage error and does **not** fall back to Phoenix — a bad price is treated as a global signal not to dump the asset on another venue this cycle.

:::info
Swaps are submitted with an on-chain `amount_out_min` and are **not auto-retried** after a post-send timeout. Re-broadcasting a non-idempotent swap could sell the same collateral twice, so transient failures are simply retried on the next poll cycle instead.
:::

---

## DeFindex rebalancing (Tranche 2)

Only relevant when `DEFINDEX_VAULT` is set.

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `DEFINDEX_DRIFT_BPS` | `500` | optional | Allocation drift threshold in basis points (`500` = 5%). Parsed as an integer; **must be in `[0, 10000]`** or the keeper exits. The keeper emits a rebalance task only when a strategy's weight drifts past this threshold from its target. Internally converted to the fraction `DEFINDEX_DRIFT_BPS / 10000`. |

The DeFindex adapter requires the keeper account to hold the vault's `RebalanceManager` or `Manager` role; without it, the rebalance task logs a note and is skipped (non-fatal).

---

## Dashboard data

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `KNOWN_DEPOSITORS` | `""` (none) | optional | Comma-separated list of depositor `G...` addresses surfaced on the keeper's `/api/performance` page. Entries are split on `,`, each is trimmed, and blank entries are dropped. Purely informational — it does not affect liquidation behavior. |

---

## Complete reference table

Every variable the keeper reads, in one place.

| Variable | Default | Required? | Validation |
|----------|---------|-----------|------------|
| `KEEPER_SECRET` | — | **required** | non-blank |
| `REGISTRY_CONTRACT` | — | **required** | non-blank |
| `VAULT_CONTRACT` | — | **required** | non-blank |
| `SOROBAN_RPC` | `https://soroban-testnet.stellar.org:443` | optional | — |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | optional | — |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | optional | — |
| `KEEPER_NAME` | `nectar-keeper-1` | optional | — |
| `POLL_INTERVAL` | `10` | optional | integer in `[3, 300]` |
| `MIN_PROFIT` | `1.02` | optional | float `> 0` |
| `API_PORT` | `8080` | optional | — |
| `BLEND_POOL` | `""` | optional | empty disables Blend scanning |
| `USDC_CONTRACT` | `""` | optional | empty disables swap + stale-draw recovery |
| `DEFINDEX_VAULT` | `""` | optional | empty disables the DeFindex adapter |
| `SOROSWAP_ROUTER` | `""` | optional | empty disables Soroswap |
| `PHOENIX_ROUTER` | `""` | optional | empty disables Phoenix |
| `SLIPPAGE_BPS` | `100` | optional | integer in `[0, 10000]` |
| `DEFINDEX_DRIFT_BPS` | `500` | optional | integer in `[0, 10000]` |
| `KNOWN_DEPOSITORS` | `""` | optional | comma-separated `G...` addresses |

---

## Current testnet addresses

These are the **current** Tranche 1 hardened testnet contracts (deployed 2026-05-24). See [Contract Addresses](../reference/contract-addresses) for the authoritative list and explorer links.

| Variable | Current testnet value |
|----------|-----------------------|
| `REGISTRY_CONTRACT` | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| `VAULT_CONTRACT` | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| `USDC_CONTRACT` | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| `BLEND_POOL` | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| `SOROSWAP_ROUTER` | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

:::info
On testnet, USDC is a **mock Stellar Asset Contract** (name "USD Coin", symbol "USDC", 7 decimals). Mainnet will use **Circle USDC** in Tranche 3, at which point you override `USDC_CONTRACT`, `NETWORK_PASSPHRASE`, and the RPC/Horizon endpoints. Phoenix has no published testnet deployment, so `PHOENIX_ROUTER` is normally left empty on testnet.
:::

---

## Example: minimal testnet keeper

Liquidations only, no DEX swapping (returns only collateral that is already USDC):

```bash
export KEEPER_SECRET="S..."
export REGISTRY_CONTRACT="CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB"
export VAULT_CONTRACT="CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345"
export BLEND_POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
```

Everything else defaults sensibly for testnet.

## Example: full testnet keeper with Soroswap

Liquidations with collateral→USDC swapping and a custom poll/profit profile:

```bash
export KEEPER_SECRET="S..."
export KEEPER_NAME="my-keeper"
export REGISTRY_CONTRACT="CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB"
export VAULT_CONTRACT="CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345"
export USDC_CONTRACT="CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW"
export BLEND_POOL="CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
export SOROSWAP_ROUTER="CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
export SLIPPAGE_BPS="100"
export POLL_INTERVAL="5"
export MIN_PROFIT="1.025"
```

## Example: `.env` file

The keeper loads a `.env` from the working directory at startup. The same keys apply, without `export`:

```bash
KEEPER_SECRET=S...
KEEPER_NAME=my-keeper
REGISTRY_CONTRACT=CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB
VAULT_CONTRACT=CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345
USDC_CONTRACT=CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW
BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
SLIPPAGE_BPS=100
POLL_INTERVAL=10
MIN_PROFIT=1.02
```

---

## What's next

- [Keeper Setup](./setup) — build, fund, and run a keeper
- [Docker Deployment](./docker) — the recommended long-running deployment path
- [Strategies](./strategies) — tuning `MIN_PROFIT`, `SLIPPAGE_BPS`, and poll cadence
- [Staking](./staking) — stake, slashing, and how to avoid a timeout slash
- [Troubleshooting](./troubleshooting) — common startup and runtime errors
