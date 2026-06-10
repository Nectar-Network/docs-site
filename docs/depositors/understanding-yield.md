---
title: Understanding Yield
description: Where Nectar yield comes from and how share price works
---

# Understanding Yield

Nectar yield is **liquidation spread**, not lending interest. Understanding the difference matters: lending yield is steady and proportional to utilization; liquidation yield is bursty and proportional to volatility.

## Where it comes from

Blend Protocol (and most lending protocols) auctions the collateral of underwater borrowers at a discount. A borrower with `$100` in collateral and `$95` in debt becomes liquidatable when their health factor drops below 1. Blend then runs a **Dutch auction**: the lot (collateral) and bid (debt repayment) scale linearly over 400 ledgers (~33 minutes) until a keeper finds it profitable to fill.

When a Nectar keeper fills an auction:

1. The keeper sends the **bid** (e.g. `$95` USDC drawn from the vault) into Blend.
2. Blend transfers the **lot** (e.g. `$100` worth of collateral, sometimes XLM, sometimes another token) to the keeper.
3. The keeper sells the collateral on a DEX, ending up with say `$98.50` USDC.
4. The keeper returns `$95` principal + `$3.50` profit to the vault.

That `$3.50` is the yield. It went to depositors, not to the keeper. Keepers earn a separate fee paid out of the spread (currently 10% of profit) — see [Operator Strategies](../operators/strategies).

## Share price mechanics

Yield is paid by **share price growth**. Walk through an example.

### t = 0: vault opens

| Field | Value |
|-------|-------|
| Total assets | 0 USDC |
| Total shares | 0 |
| Share price | undefined |

### t = 1: Alice deposits 1,000 USDC

The first deposit always mints 1 share per USDC.

| Field | Value |
|-------|-------|
| Total assets | 1,000 USDC |
| Total shares | 1,000 |
| Share price | 1.000 |

Alice owns 100% of the vault.

### t = 2: keeper returns 50 USDC of profit

Vault assets grow but share count stays the same.

| Field | Value |
|-------|-------|
| Total assets | 1,050 USDC |
| Total shares | 1,000 |
| Share price | 1.050 |

Alice's position is worth 1,050 USDC even though she still has 1,000 shares.

### t = 3: Bob deposits 1,000 USDC

Bob's shares are minted at the current price:

```
shares_minted = 1000 * 1000 / 1050 = 952.38
```

| Field | Value |
|-------|-------|
| Total assets | 2,050 USDC |
| Total shares | 1,952.38 |
| Share price | 1.050 |

Bob owns 952.38 / 1952.38 ≈ 48.78% of the vault. His starting position is exactly 1,000 USDC — the historical yield Alice earned does not get diluted.

### t = 4: keeper returns 100 USDC of profit

| Field | Value |
|-------|-------|
| Total assets | 2,150 USDC |
| Total shares | 1,952.38 |
| Share price | 1.1013 |

Both Alice and Bob earn a proportional share of the new profit.

## Why yield is variable

Liquidation profit depends on three things:

1. **Volatility.** Calm markets produce few liquidations.
2. **Blend pool activity.** More borrowers, more potential liquidations.
3. **Competition.** Other liquidators (private bots, other vaults) compete for the same auctions; competition compresses spread.

Realized APY can swing from near 0% in quiet weeks to double digits during volatility events. The performance page shows rolling 7-day and 30-day windows so you can see the recent run rate.

## Where to see it

- **Live share price**: [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault)
- **Historical chart**: [nectarnetwork.fun/performance](https://nectarnetwork.fun/performance)
- **On-chain events**: filter `LiquidationFilled` events on the [vault contract](../reference/contract-addresses)

## What this is *not*

- **Not lending interest.** No borrower pays you a coupon. Yield only realizes when keepers fill auctions.
- **Not a savings account.** Returns are not guaranteed and can be zero or negative if a keeper takes a loss before slashing covers it.
- **Not delta-neutral.** While drawn capital is in flight, the vault is briefly exposed to the seized collateral's price. Keepers minimize this window, but it's nonzero.

For the honest version of the downside, read [Risks](./risks).
