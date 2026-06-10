---
title: Configuration Reference
description: Every environment variable accepted by the Nectar keeper
---

# Configuration Reference

Every option is configured via environment variable. There is no config file format.

## Required

| Variable | Type | Description |
|----------|------|-------------|
| `KEEPER_SECRET` | string | Stellar secret key (`S...`) for the keeper account. Signs all transactions. |
| `REGISTRY_CONTRACT` | string | Contract ID (`C...`) of the deployed `KeeperRegistry`. |
| `VAULT_CONTRACT` | string | Contract ID of the deployed `NectarVault`. |
| `BLEND_POOL` | string | Contract ID of the Blend pool to monitor. |

## Network

| Variable | Default | Description |
|----------|---------|-------------|
| `SOROBAN_RPC` | `https://soroban-testnet.stellar.org:443` | Soroban RPC endpoint used for `simulate` and `submit`. |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon API used for account / fee discovery. |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar network passphrase. Override for mainnet. |

## Operation

| Variable | Default | Description |
|----------|---------|-------------|
| `KEEPER_NAME` | `nectar-keeper` | Display name shown on the leaderboard. Truncated to 32 chars. |
| `POLL_INTERVAL` | `10` | Seconds between poll cycles. Lower = faster reaction, more RPC calls. |
| `MIN_PROFIT` | `1.02` | Minimum lot/bid ratio to attempt a fill. `1.02` = require 2% gross profit. |
| `MAX_DRAW` | `0` | Hard cap on USDC drawn per cycle. `0` means use the registry-imposed cap. |
| `STRATEGY` | `balanced` | One of `conservative`, `balanced`, `aggressive`. See [Strategies](./strategies). |
| `STAKE_AMOUNT` | `100` | Initial stake in USDC when registering. Ignored if already registered. |

## Execution

| Variable | Default | Description |
|----------|---------|-------------|
| `DEX_ADAPTER` | `auto` | DEX used to sell seized collateral: `auto`, `aqua`, `soroswap`, `none`. `none` holds collateral; only safe for stablecoin lots. |
| `MAX_SLIPPAGE_BPS` | `50` | Maximum acceptable slippage when selling collateral, in basis points. `50` = 0.5%. |
| `SUBMIT_TIMEOUT` | `30` | Seconds to wait for `submit()` confirmation before treating as failed. |

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | `text` | `text` for human-readable, `json` for structured logs. |

## Metrics

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_ENABLED` | `false` | Expose Prometheus metrics on `:8080/metrics` and `/healthz`. |
| `METRICS_PORT` | `8080` | Port for the metrics endpoint. |

## Example: production

```bash
export KEEPER_SECRET="S..."
export KEEPER_NAME="my-prod-keeper"
export REGISTRY_CONTRACT="C..."
export VAULT_CONTRACT="C..."
export BLEND_POOL="C..."
export SOROBAN_RPC="https://soroban-testnet.stellar.org:443"
export POLL_INTERVAL="5"
export MIN_PROFIT="1.015"
export STRATEGY="balanced"
export DEX_ADAPTER="auto"
export MAX_SLIPPAGE_BPS="30"
export LOG_LEVEL="info"
export LOG_FORMAT="json"
export METRICS_ENABLED="true"
```

## Example: minimal testnet

```bash
export KEEPER_SECRET="S..."
export REGISTRY_CONTRACT="C..."
export VAULT_CONTRACT="C..."
export BLEND_POOL="C..."
```

Everything else defaults sensibly for testnet.
