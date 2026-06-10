---
title: Strategies
description: Conservative, balanced, and aggressive keeper strategies
---

# Strategies

The `STRATEGY` env var picks a profile that bundles `MIN_PROFIT`, `MAX_SLIPPAGE_BPS`, and the DEX selection rules. You can override individual values; the strategy provides defaults.

## conservative

```
MIN_PROFIT        = 1.025  (require 2.5% gross profit)
MAX_SLIPPAGE_BPS  = 20     (0.2%)
DEX_ADAPTER       = aqua   (deepest stable liquidity)
DRAW_FRACTION     = 0.5    (use at most 50% of registry-imposed cap per fill)
```

**Use when:** you are bootstrapping a new keeper, your stake is at the minimum, or you want to maximize the chance every fill is profitable at the cost of skipping marginal opportunities.

**Trade-off:** lower fill volume, lower yield contribution. Lower variance.

## balanced (default)

```
MIN_PROFIT        = 1.02   (2%)
MAX_SLIPPAGE_BPS  = 50     (0.5%)
DEX_ADAPTER       = auto   (best of Aqua / Soroswap)
DRAW_FRACTION     = 0.8
```

**Use when:** you have an established keeper with a decent stake and you trust the auto DEX selection.

**Trade-off:** the sane default. Most keepers should run this.

## aggressive

```
MIN_PROFIT        = 1.012  (1.2%)
MAX_SLIPPAGE_BPS  = 100    (1%)
DEX_ADAPTER       = auto
DRAW_FRACTION     = 1.0    (use full cap)
```

**Use when:** you have deep stake, fast infra (low-latency RPC, machine in the same region as the validator set), and you can absorb the variance of occasional unprofitable fills.

**Trade-off:** higher fill volume, higher gross yield, higher variance, higher chance of getting slashed for a loss.

## Custom

Set `STRATEGY=balanced` and override individual variables:

```bash
export STRATEGY=balanced
export MIN_PROFIT=1.018       # tighter than balanced default
export MAX_SLIPPAGE_BPS=40
```

## Picking by stake size

| Stake (USDC) | Recommended strategy |
|--------------|---------------------|
| 100 (minimum) | `conservative` |
| 100 – 1,000 | `balanced` |
| 1,000+ | `balanced` or `aggressive` |

## Picking by infrastructure

| Setup | Recommended strategy |
|-------|---------------------|
| Cloud VM, default RPC | `conservative` or `balanced` |
| Dedicated RPC node, same region as Stellar validators | `balanced` or `aggressive` |
| Co-located node, custom mempool watcher | `aggressive` |

## Backtesting

The repo ships a `simulate` subcommand that replays the last N ledgers against a given strategy without sending transactions:

```bash
./nectar-keeper simulate --strategy aggressive --ledgers 10000
```

Output shows realized fills, profit, slippage incidents, and missed opportunities. Use it to tune parameters before going live.

## Anti-strategy: don't do these

- **Setting `MIN_PROFIT < 1.0`.** This guarantees losses.
- **Setting `MAX_SLIPPAGE_BPS > 200`.** A 2%+ slippage tolerance on collateral sale eats most realistic spread.
- **Disabling DEX (`DEX_ADAPTER=none`) on volatile collateral.** Holding seized XLM with the intention to sell later is speculation, not liquidation.
- **Running multiple keepers from the same key.** They will fight each other for nonces and lose to other keepers.
