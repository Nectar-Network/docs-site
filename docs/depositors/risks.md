---
title: Risks
description: A frank, complete disclosure of the risks of depositing USDC into the Nectar Network vault — smart-contract and testnet risk, keeper underperformance and how slashing protects you, auction and market risk, DEX slippage, oracle risk, and the absence of any principal guarantee.
---

# Risks

Depositing into Nectar is not a savings account. You are supplying capital to an
automated liquidation strategy on Stellar, and that strategy carries real risk
of partial or total loss. This page lays out every material risk we are aware
of, in plain terms, along with the protocol mechanisms that mitigate them — and,
just as importantly, the gaps those mechanisms do **not** cover.

:::danger No principal guarantee
There is **no guarantee** that you will be able to withdraw the amount you
deposited. The vault holds USDC plus realized profit; if keepers lose capital on
a liquidation, that loss is borne by the share price, which means it is borne by
depositors. Only deposit what you can afford to lose.
:::

:::warning Testnet phase (Tranche 2)
As of the current tranche, Nectar runs on **Stellar testnet** with a **mock USDC
token** (a Stellar Asset Contract, not Circle USDC). Testnet balances have no
monetary value. Mainnet deployment with Circle USDC and production parameters is
scheduled for Tranche 3. Do not treat testnet figures as a promise of mainnet
behavior.
:::

## 1. Smart-contract risk

The protocol is enforced by two Soroban contracts written in Rust:

| Contract | Testnet address | Role |
| --- | --- | --- |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` | Holds deposited USDC, issues shares, lends capital to keepers |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` | Registers keepers, holds stake, slashes on timeout |

Smart contracts can contain bugs. A flaw in share accounting, the cross-contract
draw path, or a dependency (the Blend pool, the USDC token contract, or a DEX
router) could lead to loss of funds. Concretely:

- **Unaudited code.** These contracts have not undergone a formal third-party
  audit. They are tested with `cargo test` (including share-math edge cases and
  concurrent draw/withdraw scenarios), but tests are not proofs.
- **Cross-contract dependency.** Before lending capital, the vault verifies the
  keeper through `KeeperRegistry.get_keeper`. The vault is only as trustworthy
  as the registry it points to, and both depend on the underlying USDC token
  contract behaving correctly.
- **Admin powers.** A single admin key
  (`GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W`) can call
  `set_config` on both contracts and `pause`/`unpause` on the registry. That key
  can change the deposit cap, withdrawal cooldown, per-keeper draw limit, slash
  rate, and slash timeout. Admin multisig is a Tranche 3 hardening item — for now
  the admin is a trust assumption.

:::info Share math floors in the pool's favor
Both `deposit` and `withdraw` use integer division that **floors toward zero**,
so a depositor always receives *at most* their proportional share, never more.
This protects existing depositors from rounding-based dilution, but it is a
fairness property, not a loss guarantee.
:::

## 2. Keeper underperformance and how slashing protects you

When a liquidation opportunity appears, a registered keeper calls
`NectarVault.draw` to borrow vault capital, fills the auction, swaps the
collateral to USDC, and calls `return_proceeds` to repay the vault plus profit.
Two things can go wrong:

- **A keeper underperforms.** It is slow, misjudges an auction, or fills at a
  poor price. Profit is lower than expected, or the trade is a wash.
- **A keeper goes dark.** It draws capital and never returns it — a crash, a
  bug, or malice.

The protocol's primary defense against the second case is **staking and
slashing**, enforced entirely on-chain in the KeeperRegistry.

### How slashing works

Every keeper must lock a USDC stake to register (testnet: **100 USDC**, set by
`min_stake`). When the vault lends capital, it calls `mark_draw`, which records
`has_active_draw = true` and stamps `last_draw_time`. The `slash` function can
then be called against a keeper that has held capital too long:

```rust
// KeeperRegistry::slash — simplified from contracts/keeper-registry/src/lib.rs
if !info.has_active_draw {
    return Err(Error::SlashTimeout);          // nothing outstanding to slash
}
let now = env.ledger().timestamp();
if now.saturating_sub(info.last_draw_time) <= cfg.slash_timeout {
    return Err(Error::SlashTimeout);          // not overdue yet
}
let slash_amt: i128 = info.stake * (cfg.slash_rate_bps as i128) / 10_000;
// ... transfer slash_amt from the registry to the VAULT, then info.stake -= slash_amt
```

Two conditions must both hold for a slash to succeed:

1. The keeper has an outstanding, unreturned draw (`has_active_draw == true`).
2. More than `slash_timeout` seconds have elapsed since the draw
   (testnet: **3600 s / 1 hour**).

When both hold, the keeper loses `slash_rate_bps` of its stake (testnet:
**1000 bps = 10%**), and — this is the part that protects you — **the slashed
USDC is transferred directly into the vault**, where it raises the share price
for every depositor. A successful `return_proceeds`, by contrast, calls
`clear_draw`, which resets `has_active_draw` and makes the keeper un-slashable
for that draw.

:::warning Slashing is partial and discretionary
Slashing recovers a *fraction* of the stake, not the drawn capital. At testnet
parameters, a 10% slash of a 100 USDC stake returns **10 USDC** to the vault. If
a keeper disappears with a draw larger than its recoverable stake, the shortfall
is a loss to depositors. Slashing also requires someone to actually call
`slash` after the timeout; it is not automatic at the ledger level. Stake is a
deterrent and a partial backstop — it is not insurance.
:::

Per-keeper limits cap the blast radius of any single bad keeper. The vault's
`max_draw_per_keeper` (testnet: **10,000 USDC**) bounds how much one keeper can
borrow in a single draw, and `draw` rejects any request exceeding the vault's
currently *available* capital (`total_usdc - active_liq`).

## 3. Auction and market risk

Even a fast, honest keeper operates in an adversarial market. Nectar fills
**Blend Protocol** Dutch auctions, and the economics of those auctions are not
risk-free.

- **Two-phase Dutch auctions.** A Blend auction scales over roughly 400 blocks:
  in the first ~200 blocks the lot (what the keeper receives) grows from 0% to
  100% while the bid (what the keeper pays) stays at 100%; in the next ~200
  blocks the lot holds at 100% while the bid shrinks from 100% toward 0%. The
  keeper estimates profitability as `lot_value / bid_cost` and only fills when
  that ratio clears `MIN_PROFIT` (default **1.02**, i.e. a 2% margin). A 2%
  modeled margin is thin and can be eroded by price movement between the
  profitability check and on-chain settlement.
- **Competition and front-running.** Other keepers compete for the same
  auctions. The keeper handles the case where an auction is `already filled by
  another keeper`, but losing the race means no profit on a draw that may have
  incurred transaction fees.
- **Volatile collateral.** Liquidations occur precisely when collateral prices
  are moving fast. Between filling an auction and converting the collateral to
  USDC, the collateral's value can drop. The realized USDC may be less than the
  modeled lot value, turning a "profitable" fill into a loss.
- **Bad-debt auctions.** Blend's bad-debt auctions hand the filler **socialized
  bad debt** in exchange for backstop collateral. These carry a different and
  generally higher risk profile than ordinary user-liquidation auctions.

When `return_proceeds` repays less than was drawn, the vault simply does not
record a profit for that draw — the loss is absorbed by the pool and shows up as
a lower share price.

## 4. DEX slippage

After filling an auction, the keeper usually holds non-USDC collateral and must
swap it back to USDC before returning proceeds. Swaps route through **Soroswap**
(primary) with a **Phoenix** pool fallback. This swap is a distinct source of
loss governed by the `SLIPPAGE_BPS` setting.

```bash
# Keeper-operator environment (default shown)
SLIPPAGE_BPS=100      # max swap slippage in basis points (100 = 1%); range 0–10000
SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
PHOENIX_ROUTER=       # empty disables the fallback venue
```

The keeper applies slippage protection in two layers:

1. **On-chain floor.** It computes `amount_out_min = quoted_out * (10000 -
   SLIPPAGE_BPS) / 10000` and passes it to `swap_exact_tokens_for_tokens`. If
   the swap would execute below that floor, the Soroban transaction reverts.
2. **Oracle-anchored sanity check.** Before swapping, it compares the venue's
   quote against an oracle-implied fair value of the collateral. If the best
   quote is below `fair_value * (10000 - SLIPPAGE_BPS) / 10000`, the keeper
   refuses the swap entirely (returns `ErrSlippageExceeded`) rather than dumping
   the collateral on any venue.

:::info Realized proceeds are always real
The keeper measures swap output by the **actual change in its USDC balance**
before and after the swap — never by the quoted amount. Reported proceeds
therefore reflect what was truly received, including any slippage that occurred.
Swaps are also **not auto-retried**, because re-broadcasting a non-idempotent
swap after a timeout could sell the same collateral twice; a transient failure
is simply retried on the next keeper cycle.
:::

The trade-off is direct: a **higher** `SLIPPAGE_BPS` lets swaps complete in
thin or volatile liquidity but accepts a worse price; a **lower** value protects
price but may leave collateral unsold and capital sitting in `active_liq`,
delaying repayment to the vault. Either way, slippage is a real cost that
reduces the profit flowing back to depositors, and in illiquid conditions it can
turn a profitable fill into a net loss.

## 5. Oracle risk

Both the keeper's profitability math (`lot_value / bid_cost`) and the DEX
slippage floor rely on price data. Today that price comes from a **single
source**: the Blend pool's own oracle (Reflector, testnet address
`CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI`).

:::danger The oracle circuit breaker is not live yet
A cross-referencing **oracle circuit breaker** — which would compare the primary
oracle against an independent feed and auto-pause the keeper on significant
deviation — is a **Tranche 3** deliverable. It is **not yet implemented**. Until
it ships, a stale, manipulated, or faulty oracle price could cause the keeper to
misprice an auction, accept a bad swap quote, or skip a profitable one. The
oracle is currently a trust assumption.
:::

The existing slippage check provides *partial* protection: because the keeper
anchors its swap floor to the oracle's fair value, a manipulated *DEX pool* quote
alone cannot pass. But that defense uses the same oracle as its reference — if
the **oracle itself** is wrong, the floor is wrong too.

## 6. Liquidity and withdrawal-timing risk

Your capital is not always idle and waiting for you.

- **Capital can be in flight.** USDC that keepers have drawn for active
  liquidations sits in `active_liq` and is not available to withdraw until it is
  returned. `withdraw` can return `InsufficientVault` if the pool's drawable
  balance is temporarily depleted by outstanding draws.
- **Withdrawal cooldown.** Each deposit starts a `withdraw_cooldown` timer
  (testnet: **3600 s / 1 hour**) measured from your last deposit. Calling
  `withdraw` before it elapses returns `WithdrawalCooldown` (error 9). Adding to
  your position resets this clock.
- **Deposit cap.** Deposits that would push the vault past `deposit_cap`
  (testnet: **10,000,000 USDC**) are rejected with `DepositCapExceeded`. This
  does not threaten existing funds but can prevent you from adding capital.

See [Withdrawing](./withdraw-guide) for the full mechanics and the error reference.

## Risk summary

| Risk | Primary mitigation | Residual exposure |
| --- | --- | --- |
| Smart-contract bug | `cargo test` coverage, floor-in-pool share math | Unaudited; admin key not yet multisig |
| Keeper disappears with capital | Stake + `slash` to vault, `max_draw_per_keeper` | Slash recovers only a fraction of stake; not automatic |
| Keeper underperforms | `MIN_PROFIT` threshold (1.02) | Thin margin; market can move post-check |
| Auction / market loss | Profitability gating, retry on next cycle | Volatile collateral, competition, bad-debt auctions |
| DEX slippage | `SLIPPAGE_BPS` floor + oracle-anchored check | Real cost; can flip a fill to a loss in thin liquidity |
| Bad oracle price | Oracle-anchored slippage floor | Single oracle; circuit breaker is Tranche 3 |
| Withdrawal timing | Cooldown and caps are explicit and on-chain | Capital can be locked in `active_liq` |
| Principal loss | None — losses hit the share price | **No principal guarantee** |

:::tip Before you deposit
Read [How it works](../how-it-works) and [Depositing](./deposit-guide) so you
understand share accounting and the draw/return lifecycle, and confirm you are
interacting with the **current** testnet contract addresses listed above — never
a placeholder or a deprecated deployment.
:::
