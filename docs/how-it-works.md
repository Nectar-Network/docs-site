---
sidebar_position: 2
title: How It Works
---

# How It Works

Nectar separates two things that are usually entangled in a liquidation bot: **capital** and **execution**. Capital lives in the vault, owned collectively by depositors. Execution is run by keepers, who borrow that capital briefly to fill profitable auctions.

## The problem

Liquidation on Soroban DeFi today is dominated by a handful of single-operator bots running with private capital. That model has two failure modes:

- **Concentration risk.** A single operator that goes offline, mis-prices an auction, or gets exploited (see the Feb 2026 incident on a competing protocol) takes a meaningful chunk of liquidation capacity with it.
- **Closed yield.** The spread captured by liquidation activity is real economic yield, but only the bot operator earns it. There is no way for ordinary stablecoin holders to participate.

Nectar fixes both by pooling capital and opening keeper participation to anyone with a stake.

## Two-layer architecture

```
┌────────────────────────────────────────────────────────┐
│ Depositors (USDC)                                      │
└─────────────┬──────────────────────────────────────────┘
              │ deposit / withdraw
              ▼
┌────────────────────────────────────────────────────────┐
│ NectarVault                                            │
│  - holds pooled USDC                                   │
│  - tracks shares, share price                          │
│  - draws funds out to a keeper, receives proceeds back │
└─────────────┬───────────────────────────▲──────────────┘
              │ draw                      │ return + yield
              ▼                           │
┌────────────────────────────────────────────────────────┐
│ KeeperRegistry                                         │
│  - keeper staking, slashing                            │
│  - records execution outcomes                          │
└─────────────┬──────────────────────────────────────────┘
              │ authorized keeper
              ▼
┌────────────────────────────────────────────────────────┐
│ Blend Protocol (external)                              │
│  - lending pools, Dutch auctions                       │
└────────────────────────────────────────────────────────┘
```

## Money flow

A liquidation cycle is six steps:

1. **Deposit.** A depositor sends USDC to `NectarVault.deposit(amount)` and receives shares minted at the current share price.
2. **Detect.** A registered keeper polls the Blend pool, computes health factors, and finds a position with `HF < 1`.
3. **Draw.** The keeper calls `NectarVault.draw(amount)`. The vault checks the keeper is registered and not in cooldown, marks the draw against that keeper's stake, and transfers USDC to the keeper.
4. **Fill.** The keeper batches `supply_collateral + fill_auction` in a single Soroban `submit()` call against Blend. Blend transfers the auction lot (collateral) to the keeper and burns the bid (debt repayment).
5. **Return.** The keeper sells the seized collateral on a DEX or holds it (configurable strategy), then calls `NectarVault.return_proceeds(principal + yield)`. The registry records the execution.
6. **Yield.** Share price ticks up by `yield / total_shares`. Every depositor's position reflects the gain proportionally.

## Share math

Deposits and withdrawals use a standard share-vault formula.

**On deposit** of `amount` USDC when total assets are `A` and total shares are `S`:

```
shares_minted = amount * S / A   (or amount, if S == 0)
```

**On withdraw** of `shares` when total assets are `A` and total shares are `S`:

```
amount_paid = shares * A / S
```

**Share price** at any time:

```
share_price = total_assets / total_shares
```

Yield accrues automatically as `total_assets` grows (proceeds returned > principal drawn). No rebasing, no claim transactions — your shares stay constant and the share price rises.

## Blend integration

Keepers interact with Blend via raw Soroban RPC, not a Go SDK. The hot path:

1. Read pool state and user positions.
2. For each underwater user, build a `submit()` request with two operations:
   - `SupplyCollateral` (the bid) — debt token sent in to repay borrower's debt.
   - `FillAuction` (the lot) — receive seized collateral.
3. Simulate, then submit. If profit > `MIN_PROFIT`, transmit; otherwise skip.

See [Blend Integration](./developers/blend-integration) for the gory details.

## What's next

- [Deposit USDC →](./depositors/deposit-guide)
- [Run a keeper →](./operators/setup)
- [Read the contract reference →](./developers/contracts/keeper-registry)
