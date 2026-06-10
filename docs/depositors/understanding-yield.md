---
title: Understanding Yield
description: Where Nectar yield comes from, how share price accrues profit, and how the dashboard computes APY from real on-chain share-price history.
---

# Understanding Yield

Nectar yield is **liquidation spread**, not lending interest. The difference matters: lending yield is steady and roughly proportional to utilization; liquidation yield is bursty and proportional to market volatility. There is no coupon, no emissions, and no reward token — your only return is the appreciation of a single number, the vault **share price**.

## Where it comes from

Blend Protocol (like most lending protocols) auctions the collateral of underwater borrowers at a discount. A borrower becomes liquidatable when their **health factor** drops below `1.0`. Blend then runs a **Dutch auction** in two phases over roughly 400 ledgers:

- **Ledgers 0–200** — the lot (seized collateral) scales from 0% up to 100% while the bid (debt repayment owed) stays at 100%.
- **Ledgers 200–400** — the lot stays at 100% while the bid scales from 100% down to 0%.

A Nectar keeper fills the auction once it crosses its profitability threshold (default `MIN_PROFIT = 1.02`, i.e. lot value at least 2% above bid cost). When a keeper wins an auction:

1. The keeper draws the **bid** amount of USDC from the vault (`draw`) and submits the fill to Blend.
2. Blend transfers the **lot** (collateral — often XLM or another token) to the keeper.
3. The keeper swaps the collateral to USDC on a DEX (Soroswap primary, Phoenix fallback). Proceeds are the keeper's **measured USDC balance delta** — never a synthesized estimate.
4. The keeper calls `return_proceeds(keeper, amount, response_time_ms)`, repaying the drawn principal plus realized profit to the vault.

That realized profit is the yield. It is booked into the vault, raising the share price for **every** depositor proportionally.

:::info
Realized profit is computed on-chain in `return_proceeds`. With a tracked draw of `drawn` and a returned `amount`, profit is `amount - drawn` when `amount > drawn`, otherwise `0`. The vault increments both `total_usdc` and `total_profit` by that profit. A return that is less than or equal to the drawn amount books no profit — it simply repays principal.
:::

Keepers do **not** keep a fee inside the contract. The on-chain split returns the full realized profit (`proceeds − drawn`) to the vault; the keeper's compensation model is described in [Operator Strategies](../operators/strategies). The dashboards display only actual on-chain realized profit, so no marketing split figure affects what you see.

## Share price mechanics

The vault is an LP-share pool. Share price is always:

```
share_price = total_usdc / total_shares
```

All amounts are `i128` integers in 7-decimal **stroops** (1 USDC = 10,000,000 stroops). Integer division always floors toward zero, so rounding dust accrues to the pool — neither depositors nor withdrawers can ever extract more than their proportional value. The dollar figures below are rounded for readability; on-chain, every value is an exact stroop count.

Walk through an example.

### t = 0: vault opens

| Field | Value |
|-------|-------|
| Total assets (`total_usdc`) | 0 USDC |
| Total shares (`total_shares`) | 0 |
| Share price | undefined |

### t = 1: Alice deposits 1,000 USDC

The first deposit into an empty vault always mints 1 share per USDC (`shares = amount` when `total_shares == 0`).

| Field | Value |
|-------|-------|
| Total assets | 1,000 USDC |
| Total shares | 1,000 |
| Share price | 1.000 |

Alice owns 100% of the vault.

### t = 2: a keeper returns 50 USDC of profit

Vault assets grow but the share count stays the same.

| Field | Value |
|-------|-------|
| Total assets | 1,050 USDC |
| Total shares | 1,000 |
| Share price | 1.050 |

Alice's position is now worth 1,050 USDC even though she still holds 1,000 shares.

### t = 3: Bob deposits 1,000 USDC

Subsequent deposits mint at the current price (`shares = amount * total_shares / total_usdc`, floored):

```
shares_minted = 1000 * 1000 / 1050 = 952.38  (floored in stroops on-chain)
```

| Field | Value |
|-------|-------|
| Total assets | 2,050 USDC |
| Total shares | 1,952.38 |
| Share price | 1.050 |

Bob owns ≈ 48.78% of the vault. His starting position is worth exactly what he put in (1,000 USDC) — the historical yield Alice earned is **not** diluted by Bob's arrival.

### t = 4: a keeper returns 100 USDC of profit

| Field | Value |
|-------|-------|
| Total assets | 2,150 USDC |
| Total shares | 1,952.38 |
| Share price | 1.1013 |

Both Alice and Bob earn a proportional share of the new profit. Withdrawal pays out at the current price: `usdc_out = shares * total_usdc / total_shares` (floored). A depositor holding all outstanding shares redeems the entire `total_usdc`.

:::tip
You never need to "claim" or "compound" yield. Because profit lives in the share price, your shares are worth more the moment a keeper returns proceeds. Redeeming simply converts shares back to USDC at whatever the price is then.
:::

## How APY is computed (and the honest caveat)

The dashboard does not read an APY field off-chain — it **reconstructs a share-price time series** from real outcomes and derives the return from that. This happens in `sharePriceSeries()` and `vaultReturn()` (`frontend/lib/api.ts`).

**Building the series (`sharePriceSeries`):**

- The principal base is `total_usdc − total_profit` (assets minus all realized profit ever booked).
- Each liquidation's realized profit (`proceeds − drew`, pulled from the keeper's `/api/performance` feed) is added in time order, raising the reconstructed share price step by step.
- Because the keeper's in-memory liquidation list is stateless and resets on restart, those deltas may not sum to the authoritative on-chain `total_profit`. The deltas are therefore **scaled** so the curve's endpoint exactly matches the true current share price (`total_usdc / total_shares`). This preserves the *shape* of when profit accrued while keeping the endpoint honest. No figures are synthesized.

**Deriving the return (`vaultReturn`):**

- `growth = last.sharePrice / first.sharePrice`; cumulative return is `(growth − 1) × 100`.
- It annualizes to an APY **only when the series spans at least 7 days** (`MIN_ANNUALIZE_DAYS = 7`), using `(growth^(365/days) − 1) × 100`.
- For shorter windows it returns the raw **cumulative** return instead, labeled "cumulative · not annualized." It never returns `Infinity` or `NaN`, and with fewer than 2 data points it reports zero / "not enough history."

:::warning
Annualizing a few minutes or hours of liquidation data produces astronomically misleading numbers. Nectar deliberately refuses to do this. A short-window figure on the dashboard is a **cumulative** return for that window, not an annual rate — read the label, not just the number.
:::

Other honesty rules baked into the dashboard:

- Missing or unavailable data renders as an em-dash (`—`), never a fabricated value.
- The keeper leaderboard shows `—` for win rate when an operator has zero executions (never a fake 100%).
- Per-depositor "net deposited" and "yield" are **estimates** assuming a 1.0 (par) entry price, because cost basis is not tracked on-chain. Your **shares** and **current value** are read directly from the contract and are exact.

## Where to track it

The canonical place to watch yield is **Dashboard v2** at [nectarnetwork.fun/dashboard](https://nectarnetwork.fun/dashboard):

| What | Where |
|------|-------|
| Live share price, TVL, total profit, trailing APY | [Dashboard Overview](https://nectarnetwork.fun/dashboard) |
| Share-price chart with 30D / 90D toggle | Dashboard Overview → APY chart |
| Per-fill realized profit history | [Liquidation Feed](https://nectarnetwork.fun/dashboard/liquidations) |
| Your own position value over time | [Depositor Analytics](https://nectarnetwork.fun/dashboard/depositor) |
| Deposit / withdraw and your live position | [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault) |

The legacy [performance view](https://nectarnetwork.fun/performance) still works but predates Dashboard v2; prefer the dashboard.

**On-chain, directly:** the NectarVault contract (`CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` on testnet, [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345)) is the source of truth:

- `get_state` returns `total_usdc`, `total_shares`, `total_profit`, `active_liq` — divide to compute share price yourself.
- `balance(user)` returns your `(shares, usdc_value)`.
- Each profit booking emits a `"return"` event carrying `(amount, profit)`; deposits and withdrawals emit `"deposit"` and `"withdraw"`. (Note: there is no `LiquidationFilled` event — the registry records keeper performance via an `"execution"` event, while the vault tracks the money via `"return"`.)

All amounts in these calls and events are 7-decimal stroops; divide by `10,000,000` for USDC. See [Contract Addresses](../reference/contract-addresses) for the full address set and [Glossary](../reference/glossary) for the terms used here.

:::info
Today the vault holds a **mock USDC SAC** on Soroban testnet (`CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`, 7 decimals). Mainnet (Tranche 3) will use **Circle USDC**.
:::

## Why yield is variable

Liquidation profit depends on three things, none of which Nectar controls:

1. **Volatility.** Calm markets produce few liquidations and therefore little yield.
2. **Blend pool activity.** More borrowers and more debt mean more potential liquidations.
3. **Competition.** Private bots and other liquidators race for the same auctions. When another keeper fills first, Nectar's keeper receives `ErrAlreadyFilled`, returns its unspent draw, and books no profit or loss. More competition compresses spread.

Realized return can sit near 0% in a quiet week and spike during a volatility event. This is structural, not a bug.

## What this is *not*

:::danger
Nectar is experimental software on testnet and is not audited as of Tranche 1. Yield is **not guaranteed** and can be zero for extended periods. Do not deposit funds you cannot afford to lose. This is not investment advice.
:::

- **Not lending interest.** No borrower pays you a coupon. Yield only realizes when a keeper actually fills an auction and returns proceeds.
- **Not a savings account.** Returns are not guaranteed, are not steady, and can be zero. A negative outcome is possible: if a keeper draws capital and fails to return it, the vault's `active_liq` stays elevated until the draw is repaid or the keeper is slashed (10% of stake per the registry config), and slashing may not fully cover a shortfall.
- **Not delta-neutral.** While drawn capital is in flight, the vault is briefly exposed to the seized collateral's price between the fill and the DEX swap. Keepers minimize this window, but it is nonzero.
- **Not annualized from short windows.** A big-looking percentage over a few hours is a cumulative figure, not an APY. See the caveat above.

For the full downside picture, read [Risks](./risks).
