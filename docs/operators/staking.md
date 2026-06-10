---
title: Staking & Slashing
description: How keeper stake, draws, and slashing work
---

# Staking & Slashing

A keeper's stake is its skin in the game. Stake bounds how much the keeper can draw, secures depositor capital against keeper misbehavior, and ranks keepers on the leaderboard.

## Registering

A new keeper calls `KeeperRegistry.register(name, stake_amount)`. The registry pulls `stake_amount` USDC from the keeper's account into escrow. If `stake_amount < min_stake` (currently 100 USDC), the call reverts.

```bash
./nectar-keeper register --stake 200
```

This is a one-time call — the keeper binary handles re-registration automatically on subsequent runs.

## Increasing stake

```bash
./nectar-keeper stake-add --amount 500
```

Higher stake → higher per-draw cap → ability to fill larger auctions.

## Per-keeper draw cap

The vault enforces:

```
max_draw = stake * leverage_factor
```

`leverage_factor` is currently **3x** on testnet. A keeper staking 100 USDC can draw up to 300 USDC at any moment. This bounds the worst-case loss the keeper's stake must cover.

## When stake gets slashed

Three conditions trigger slashing.

### 1. Draw timeout

A keeper draws funds and fails to call `return_proceeds` within the timeout window (currently 1 hour). After timeout, anyone can call `slash(keeper)`. The vault reclaims principal from stake; the slasher earns a small bounty (1% of recovered amount).

### 2. Loss on return

A keeper returns `principal - loss` instead of `principal + profit`. The vault automatically slashes `loss` from stake on the `return_proceeds` call. The keeper survives if `loss < stake`. If `loss >= stake`, the keeper is forcibly deregistered and the residual loss is socialized — share price drops by `(loss - stake) / total_shares`.

### 3. Misbehavior reports (Tranche 2)

Planned, not yet live: a fraud-proof system where any actor can submit on-chain evidence that a keeper executed against the vault's interest (e.g. accepted an obvious oracle exploit). On verification, stake is slashed.

## Withdrawing stake

A keeper that wants to exit calls `KeeperRegistry.unregister()`:

1. The registry checks for in-flight draws. If any, the call reverts.
2. The keeper enters a `cooldown` period (24 hours).
3. After cooldown, the keeper calls `claim_stake()` to retrieve escrowed USDC.

During cooldown, the keeper cannot draw. New `register()` calls fail until the cooldown expires.

## Earning fees

Keepers earn a fee out of every successful fill. The fee is taken before `return_proceeds` settles to the vault:

```
keeper_fee = profit * keeper_fee_bps / 10000
return_to_vault = principal + profit - keeper_fee
```

Default `keeper_fee_bps = 1000` (10% of profit). The keeper accrues fees in their own account; there is no separate withdrawal step.

## Leaderboard ranking

The registry tracks per-keeper stats:

- `successful_fills`
- `failed_fills`
- `total_profit`
- `slashes`
- `last_active_ledger`

The dashboard sorts by a composite score. Keepers in the top quartile see preferential routing when multiple try to draw simultaneously.

## Operational checklist

- Stake at least 2x the minimum if you want capital efficiency above the floor.
- Monitor `last_active_ledger` — if your keeper has been silent for too long, the dashboard flags it.
- Set up alerts on the `/healthz` endpoint (see [Docker](./docker)) so you notice outages before slashing.
- Keep a small XLM reserve at all times — running out of fees mid-fill is a fast path to a draw timeout.
