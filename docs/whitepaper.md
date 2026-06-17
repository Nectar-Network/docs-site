---
title: Whitepaper
description: The Nectar Network whitepaper — a pooled liquidation protocol for Soroban DeFi on Stellar. Capital pooled in NectarVault as ERC4626-style shares; staked keepers draw it to fill Blend Dutch-auction liquidations, swap collateral to USDC, and return principal plus profit as a rising share price. Full protocol specification, liquidation mechanics, trust model, and the path from testnet admin control to multisig and an oracle circuit breaker.
---

# Nectar Network Whitepaper

:::info Status
This document describes a protocol that is **live on Stellar testnet only** (Tranche 1 hardened, redeployed 2026-05-24). USDC on testnet is a mock Stellar Asset Contract with no real-world value. Nectar has **not been audited.** Mainnet with Circle USDC, an admin multisig, and an oracle circuit breaker are planned for Tranche 3 (~October 2026). Nothing here is investment advice. Build supported by the [Stellar Community Fund Build Award (SCF #42)](https://communityfund.stellar.org/), $75K.
:::

## Abstract

Liquidation is the load-bearing safety mechanism of every overcollateralized lending protocol: when a borrower's position falls below its required collateralization, someone must repay the bad debt and seize the collateral before the position becomes insolvent. On most chains this work is done by privately operated, capital-rich liquidation bots. The capital those bots deploy and the profit they capture are both privatized — ordinary users supply liquidity to lending markets but never share in the liquidation premium that protects those markets.

Nectar Network is a **pooled liquidation protocol for Soroban DeFi on Stellar**. It separates two things that liquidation bots normally entangle: *capital* and *execution*. Depositors pool USDC into a single contract, the `NectarVault`, receiving ERC4626-style shares; a permissionless set of staked **keeper** operators draws that pooled capital to fill [Blend Protocol](https://www.blend.capital/) liquidation auctions, swaps the seized collateral back to USDC on a decentralized exchange (Soroswap primary, Phoenix fallback), and returns the principal plus profit. The profit is added to the vault without minting new shares, so the **share price rises** and every depositor's position appreciates proportionally. There are no reward tokens, no emissions, and no coordinator — yield is simply the appreciation of one share price.

Accountability is enforced on-chain. The `KeeperRegistry` requires each operator to bond a minimum stake (100 USDC on testnet), records execution count, success rate, and average response time as it happens, and lets *anyone* slash a keeper that draws capital and fails to return it within a timeout. The slashed stake flows to the vault, compensating depositors. Two short Soroban contracts — coupled by a single cross-contract verification on every draw — hold and move all capital, with **no admin path that can move depositor funds.**

This whitepaper specifies the protocol exactly as implemented: the share-accounting math, the draw → fill → swap → return lifecycle, the Dutch-auction profitability gate, the staking and slashing conditions, and the multi-protocol adapter layer that generalizes Nectar beyond Blend. It is also honest about what Nectar is *not* yet: a single admin key holds configuration and upgrade authority today, and the move to a multisig and an oracle circuit breaker is a roadmap, not a finished state. The final section, [Governance and Decentralization](#governance-and-decentralization), lays out the current trust assumptions plainly.

## Introduction

### The problem

Decentralized lending protocols are overcollateralized: a borrower must post collateral worth more than they borrow. When the collateral's value falls — or the debt's value rises — the position's **health factor** drops toward 1, the point at which collateral exactly covers risk-weighted debt. Below 1, the position is undercollateralized and the protocol is exposed to bad debt. Liquidation closes the gap: a third party repays some or all of the debt and receives the collateral, usually at a discount that is the incentive to act quickly.

In practice this incentive is captured by a small number of sophisticated operators. Running a profitable liquidation bot requires three things at once: (1) idle capital sitting ready to repay debt at a moment's notice, (2) low-latency infrastructure to detect underwater positions and win the race to fill, and (3) the engineering to price auctions, route swaps, and manage failure. The capital requirement alone excludes almost everyone. The result is that the liquidation premium — real, protocol-protecting yield — accrues privately, and the lending market's safety depends on a handful of opaque actors.

### The Nectar approach

Nectar unbundles capital from execution.

- **Capital** is pooled and owned collectively. Anyone can deposit USDC into the `NectarVault` and receive shares. Depositors do not need infrastructure, latency, or liquidation expertise; they simply hold a claim on a pool whose value rises as liquidations are filled.
- **Execution** is run by independent keepers. A keeper is a stateless off-chain daemon that monitors a Blend pool, prices its Dutch auctions, briefly borrows pooled capital to fill the profitable ones, converts the seized collateral to USDC, and returns the proceeds. Keepers compete; there is no coordinator and no privileged operator.

The two are connected by trust-minimized on-chain rules. A keeper can only draw capital if the `KeeperRegistry` knows it (verified by a cross-contract call on every draw), and a keeper that draws and walks away is slashed — its bonded stake is seized into the vault. The keeper earns nothing on a draw it never returns, and loses part of its stake; depositors are made whole from that stake. Honest keepers earn by returning more than they drew, which simultaneously raises the vault's share price.

This produces a clean alignment:

| Actor | Puts in | Gets out | Bounded by |
|---|---|---|---|
| Depositor | USDC | Rising share price (liquidation profit) | Share math floors toward the pool; capital only leaves to verified keepers |
| Keeper | Stake + execution + latency | Liquidation profit it returns above principal | Stake at risk via permissionless slashing; per-keeper draw cap |
| Lending market (Blend) | Liquidatable positions | Solvency restored quickly | Competition between keepers |

### What this document covers

The remainder of this whitepaper is structured as the prompt's mandated specification. [Protocol Specification](#protocol-specification) details the two contracts, the share-accounting formulas, the configuration parameters, and the off-chain keeper architecture. [Liquidations](#liquidations) walks the full lifecycle — detection, draw, Dutch-auction fill, collateral swap, return of proceeds — and the failure backstops (stale-draw recovery and slashing). [Governance and Decentralization](#governance-and-decentralization) states the current trust model honestly and lays out the decentralization roadmap. [References](#references) cites every external system and the Nectar source.

For the same material in other forms, see [How It Works](./how-it-works) (plain-language depositor view), [Architecture](./developers/architecture) (developer's system map), the contract references [NectarVault](./developers/contracts/nectar-vault) and [KeeperRegistry](./developers/contracts/keeper-registry), [Blend Integration](./developers/blend-integration), and the [Glossary](./reference/glossary).

## Protocol Specification

Nectar is a monorepo of three independently deployed components plus a public SDK extracted from the keeper. The contracts are the source of truth; everything else reads from chain.

| Component | Stack | Role |
|---|---|---|
| Contracts | Rust, Soroban SDK 22.x | Custody, share accounting, staking, slashing, performance tracking |
| Keeper | Go 1.22+, `stellar/go` SDK | Stateless daemon: monitor Blend, fill auctions, draw/return capital |
| Frontend | Next.js 14, TypeScript, Tailwind | Depositor + operator UI, live dashboards |
| keeper-sdk | Go | Public framework so third parties can run their own keepers |

### Units and precision

All monetary values are `i128` integers at **7-decimal precision** — Stellar's native fixed point. So `1 USDC = 10,000,000 stroops` (10<sup>7</sup>). Contract and keeper code never see decimal USDC; every `amount`, `min_stake`, `deposit_cap`, and `max_draw_per_keeper` is an integer count of stroops. Integer division always **floors toward zero**, which is a deliberate safety property: neither a depositor nor a keeper can ever extract more than their exact proportional value, and rounding dust accrues to the pool.

| Display | Stroops (`i128`) |
|---|---|
| 1 USDC | `10000000` |
| 100 USDC (testnet stake) | `1000000000` |
| 0.0000001 USDC (1 stroop) | `1` |

### NectarVault

`NectarVault` is the deposit pool and the only contract that custodies depositor USDC. Its state is four figures:

```rust
pub struct VaultState {
    pub total_usdc: i128,    // total USDC the vault accounts for (idle + deployed)
    pub total_shares: i128,  // total LP shares outstanding
    pub total_profit: i128,  // cumulative realized liquidation profit
    pub active_liq: i128,    // capital currently drawn and not yet returned
}
```

Idle USDC physically in the contract is `total_usdc - active_liq`. Configuration is held in `VaultConfig`:

```rust
pub struct VaultConfig {
    pub deposit_cap: i128,         // testnet: 10,000,000 USDC
    pub withdraw_cooldown: u64,    // testnet: 3600 s (1 hour)
    pub max_draw_per_keeper: i128, // testnet: 10,000 USDC (per draw call, not cumulative)
}
```

#### Shares and share price

A depositor's claim is a **share** count, tracked per account in a `Depositor` record. Shares are not transferable tokens; they are an internal balance. The economic model is ERC4626-style: a fixed share count whose USDC value rises as the vault books profit. The share price is:

```text
share_price = total_usdc / total_shares
```

It starts at `1.0` and ticks up as realized profit is added to `total_usdc` *without minting new shares*. There is no rebasing, no reward token, and no claim transaction — a depositor's share count stays constant and each share is worth more. Yield is realized only on withdrawal.

**Deposit.** `deposit(user, amount)` mints shares proportional to the current ratio. The first deposit into an empty vault mints 1:1; afterward:

```text
shares = amount * total_shares / total_usdc   (floored)
```

The deposit cap is enforced only when `deposit_cap > 0`: the call reverts `DepositCapExceeded` if `total_usdc + amount > deposit_cap` (the exact cap is allowed). On success, `amount` USDC is pulled from the user, the depositor's share balance grows, and `last_deposit_time` is set to now — which (re)starts the withdrawal cooldown.

**Withdraw.** `withdraw(user, shares)` burns shares for proportional USDC:

```text
usdc_out = shares * total_usdc / total_shares   (floored)
```

The cooldown is enforced only when `withdraw_cooldown > 0`: it reverts `WithdrawalCooldown` while `now - last_deposit_time < withdraw_cooldown` (withdrawal is permitted exactly at the cooldown boundary). Because the formula floors, a depositor never over-withdraws; when a depositor's shares equal `total_shares`, the formula naturally returns the entire `total_usdc`, so a full exit recovers all capital with rounding dust bounded to a few stroops and never overpaying.

:::info Worked example
A vault holds 1,000 USDC across 1,000 shares (share price 1.0). A keeper draws 500, fills an auction, and returns 510. Profit is `510 − 500 = 10` USDC. `total_usdc` becomes 1,010, `total_shares` stays 1,000, so the share price is now 1.01 — a 1% gain credited to every holder, with `active_liq` back to 0. A depositor holding 100 shares now redeems for 101 USDC. This is the exact path the contract's full-cycle test verifies.
:::

#### Keeper capital: draw and return

Two functions move capital to and from keepers. Both require the keeper's authorization (`require_auth`) and are gated on registry state.

**Draw.** `draw(keeper, amount)` lends idle capital to a keeper. In order, the vault:

1. Enforces the per-keeper draw limit (only when `max_draw_per_keeper > 0`): reverts `DrawLimitExceeded` if `amount > max_draw_per_keeper`. The limit is **per draw call**, not cumulative.
2. Computes `available = total_usdc - active_liq` and reverts `InsufficientVault` if `amount > available`.
3. Cross-calls `KeeperRegistry.get_keeper(keeper)` to confirm the caller is registered. If the keeper is unknown, that call reverts `NotRegistered`, unwinding the entire `draw`. The vault discards the returned value — it needs only the call to succeed.
4. Transfers `amount` USDC to the keeper, adds `amount` to that keeper's outstanding `KeeperDraw` record, and increments `active_liq`.
5. If `amount > 0`, cross-calls `KeeperRegistry.mark_draw(vault, keeper)`, which sets `has_active_draw = true` and records `last_draw_time` — starting the slashing clock.

**Return.** `return_proceeds(keeper, amount, response_time_ms)` repays drawn capital plus any profit. The vault pulls `amount` USDC from the keeper, then books it against what *this* keeper owes (`drawn`, read from its `KeeperDraw` record):

```rust
// principal repaid this call, capped at what THIS keeper owes
let repay_target = if drawn > 0 { min(amount, drawn) } else { 0 };
let repay        = min(repay_target, state.active_liq);
let profit       = if drawn == 0 { amount } else { amount - repay_target };
state.active_liq -= repay;
state.total_usdc += profit;   // raises share price
state.total_profit += profit;
```

Key invariants the implementation enforces:

- **Profit is `amount − drawn`** when `amount > drawn`; a return at or below the drawn amount books **no** profit. Capping `repay_target` at `drawn` means a profitable return never deducts *another* keeper's outstanding draw from `active_liq`.
- **Partial repayment keeps the obligation open.** If a keeper returns less than it drew, the remainder stays recorded in `KeeperDraw` and the registry's active-draw mark is retained — so a 1-stroop return cannot settle a 10,000 USDC draw, and the shortfall stays slash-eligible.
- **Full settlement books the execution.** Only when the draw is fully repaid does the vault remove the `KeeperDraw` record, cross-call `clear_draw`, and call `record_execution(vault, keeper, true, profit, response_time_ms)` — recording the successful fill and latency on-chain.
- **A donated return is allowed but discouraged.** If there is no tracked draw (`drawn == 0`), the whole `amount` is treated as donated profit. Off-chain keepers must only return proceeds for capital they actually drew.

`get_keeper_draw(keeper)` is a read that returns a keeper's outstanding draw, letting the off-chain daemon cap any self-recovery return at exactly what it owes (see [stale-draw recovery](#failure-handling-and-backstops)).

#### Vault errors

| Error | Code | Cause |
|---|---|---|
| `AlreadyInit` / `NotInit` | 1 / 2 | Double init / use before init |
| `InsufficientBalance` | 3 | Withdraw more shares than held |
| `InsufficientVault` | 4 | Draw exceeds idle capital, or withdraw from empty vault |
| `Unauthorized` | 5 | `set_config` by non-admin |
| `NoShares` | 6 | No depositor record |
| `DepositCapExceeded` | 8 | `total_usdc + amount > deposit_cap` |
| `WithdrawalCooldown` | 9 | Withdraw before cooldown elapses |
| `DrawLimitExceeded` | 10 | `amount > max_draw_per_keeper` |

### KeeperRegistry

`KeeperRegistry` is the operator directory and the staking/slashing engine. Per-keeper state is the `KeeperInfo` struct:

```rust
pub struct KeeperInfo {
    pub addr: Address,
    pub name: String,
    pub stake: i128,
    pub registered_at: u64,
    pub active: bool,
    pub total_executions: u64,
    pub successful_fills: u64,
    pub total_profit: i128,
    pub last_draw_time: u64,
    pub has_active_draw: bool,
    pub total_response_time_ms: u64,
    pub response_count: u64,
}
```

Configuration is `RegistryConfig`:

```rust
pub struct RegistryConfig {
    pub min_stake: i128,     // testnet: 100 USDC
    pub slash_timeout: u64,  // testnet: 3600 s
    pub slash_rate_bps: u32, // testnet: 1000 = 10%
    pub usdc_token: Address,
}
```

#### Registration and staking

`register(operator, name)` pulls *exactly* `min_stake` USDC from the operator into the registry contract and records a fresh `KeeperInfo` with zeroed performance counters. It reverts `AlreadyRegistered` if the operator is already known, `InsufficientStake` if `min_stake <= 0`, and `Paused` while the admin has paused registration. The stake is collateral, not a fee: `deregister(operator)` refunds the keeper's current (possibly post-slash) stake in full — but is blocked with `ActiveDraw` while the keeper has an open draw.

#### Performance tracking

Only the vault may write performance data. `mark_draw`, `clear_draw`, and `record_execution` each take a `caller` argument and validate it against the registry's stored `VaultAddr` (the `require_vault` check), so they are callable only by the authorized vault and revert `Unauthorized` for anyone else. On each `record_execution`:

- `total_executions += 1` always (success or failure);
- on success only: `successful_fills += 1`, `total_profit += profit`, and the response-time accumulators (`total_response_time_ms += response_time_ms`, `response_count += 1`).

A failed execution therefore increments only the execution count — it never inflates profit or the response-time average. Derived metrics:

```text
win_rate            = successful_fills / total_executions
avg_response_time   = total_response_time_ms / response_count   (avg_response_time_ms(), 0 if no successes)
```

#### Slashing

`slash(keeper)` is **permissionless** — any caller can trigger it once a keeper has left a draw open too long. It reverts `SlashTimeout` unless **both** conditions hold:

1. `has_active_draw == true`, and
2. `now - last_draw_time > slash_timeout` (strictly greater; slashing is impossible at exactly the timeout).

On a valid slash:

```text
slash_amt = stake * slash_rate_bps / 10_000     // 10% of current stake on testnet
```

The slashed amount is **transferred to the vault** (it is *not* burned — it flows to depositors), the keeper's `stake` is reduced by `slash_amt`, and `has_active_draw` is cleared. This is the economic guarantee behind the pool: capital a keeper fails to return is recovered from its bonded stake.

#### Registry errors

| Error | Code | Cause |
|---|---|---|
| `AlreadyInit` / `NotInit` | 1 / 2 | Double init / use before init |
| `AlreadyRegistered` | 3 | Operator already registered |
| `NotRegistered` | 4 | Unknown operator (e.g. unverified draw) |
| `Unauthorized` | 5 | Non-admin config, or non-vault performance write |
| `Paused` | 6 | Registration while paused |
| `InsufficientStake` | 7 | `min_stake <= 0` |
| `ActiveDraw` | 8 | Deregister with an open draw |
| `SlashTimeout` | 9 | Slash before timeout, or with no active draw |

### The keeper daemon

The keeper is a **stateless** Go daemon. It holds no persistent state — it reads everything it needs from chain each cycle, so it restarts safely, and several keepers can run against the same vault and pool, racing each other. Configuration is via environment variables only (`KEEPER_SECRET`, `REGISTRY_CONTRACT`, `VAULT_CONTRACT`, `BLEND_POOL`, `USDC_CONTRACT`, `SOROSWAP_ROUTER`, `PHOENIX_ROUTER`, `SLIPPAGE_BPS`, `DEFINDEX_VAULT`, `POLL_INTERVAL`, `MIN_PROFIT`, …).

Each tick (default `POLL_INTERVAL` = 10s) runs one `cycle()`:

1. **`recoverStaleDraw()` first** — make the vault whole if a prior return failed (see backstops below).
2. **For each registered adapter** (Blend, then optionally DeFindex): `GetTasks` scans the protocol read-only, tasks are sorted by priority, and `Execute` runs each one — drawing and returning vault capital as needed. A failed adapter or task logs and is skipped; it never aborts the cycle.
3. **Refresh dashboard state** — re-read `vault.GetState`, discovered positions, and depositor balances.

The daemon also serves a read-only HTTP/SSE API (`/api/state`, `/api/performance`, `/api/events`) that the frontend consumes.

### The multi-protocol adapter layer

The keeper does not hard-code Blend. It runs against a list of **adapters**, each implementing one Go interface — the contract extracted into the public [keeper-sdk](https://github.com/Nectar-Network/keeper-sdk) so third parties can write their own strategies:

```go
type ProtocolAdapter interface {
    Name() string
    GetTasks(rpc *soroban.Client) ([]Task, error)
    Execute(rpc *soroban.Client, kp *keypair.Full, task Task, vault VaultClient) (*Result, error)
    EstimateCapital(task Task) (int64, error)
}
```

Adapters touch vault capital only through a narrow `VaultClient` (`Draw`, `ReturnProceeds`), so they can never call the vault arbitrarily. Two adapters ship today:

- **Blend adapter** — the production liquidation path (detailed in the next section).
- **DeFindex adapter** — registered only when `DEFINDEX_VAULT` is set. It **never draws Nectar capital**; it rebalances a [DeFindex](https://defindex.io/) vault's own funds back to target weights when allocation drift exceeds `DEFINDEX_DRIFT_BPS` (default 500 bps = 5%). Its `Execute` ignores the supplied `VaultClient` and `EstimateCapital` is always 0 — the worked example that the adapter interface is genuinely protocol-agnostic.

## Liquidations

This section walks the production liquidation path end to end — the heart of Nectar. The Blend integration internals are specified in full in [Blend Integration](./developers/blend-integration); this is the protocol-level view.

### Blend and Dutch auctions

[Blend](https://www.blend.capital/) is a lending protocol on Soroban. When a borrower's position becomes undercollateralized, Blend opens a **Dutch auction** that anyone can fill. Blend models three auction kinds, mapped to different `submit()` request types:

| Auction kind | What the keeper pays (bid) | What it receives (lot) | `submit()` request type |
|---|---|---|---|
| User liquidation | Borrower's debt assets | Borrower's collateral | 6 |
| Bad debt | Socialized bad debt | Backstop's bTokens | 7 |
| Interest | BLND | Accumulated backstop interest | 8 |

A Blend auction is a **two-phase Dutch auction** measured in ledger blocks elapsed since the auction's start block. Over the first phase the **lot scales 0% → 100%** while the bid stays at 100%; over the second phase the **bid scales 100% → 0%** while the lot stays at 100%:

| Phase | Elapsed blocks | Lot (collateral received) | Bid (debt paid) |
|---|---|---|---|
| Lot-scaling | 0 – 200 | grows 0% → 100% | held at 100% |
| Bid-scaling | 200 – 400 | held at 100% | shrinks 100% → 0% |
| Expired | > 400 | 100% | 0% |

The "fair price" point is at elapsed block 200, where both legs sit at 100%. Filling earlier means overpaying; filling later means the bid (what you pay) keeps shrinking, so each block makes the fill cheaper. The keeper does not blindly fill the moment an auction appears — it waits until the lot/bid ratio clears the profitability gate.

### The profitability gate

The keeper prices an auction at the current block by applying the Dutch-auction scaling and the per-asset oracle prices from the pool snapshot:

```text
ratio = lot_value / bid_cost
      = Σ(lot_amount  · lot_phase_pct · oracle_price)
      / Σ(bid_amount  · bid_phase_pct · oracle_price)
```

If `ratio < MIN_PROFIT` (default `1.02`), the keeper **does not draw and does not fill** — it logs `not profitable` and moves on. Otherwise it commits capital. The `1.02` floor means the lot must be worth at least 2% more than the bid before the keeper risks pooled funds; it is configurable per operator and validated to be `> 0` at startup. (When the bid has fully scaled out, the ratio is effectively infinite — the lot is free.)

:::warning Pricing is only as good as the oracle
Lot and bid values come from the Blend pool's oracle prices (Reflector on testnet). A stale or manipulated oracle feeds straight into this gate. The Tranche 3 oracle circuit breaker (see the next section) is the planned defense; today the `MIN_PROFIT` floor and the admin `pause` control are the protections in effect.
:::

### The lifecycle: detect → draw → fill → swap → return

A full liquidation cycle is a sequence of on-chain calls and off-chain steps.

**1. Detect.** Each cycle, the keeper loads the Blend pool's reserves and oracle prices, discovers borrower positions from recent pool events, and computes each position's health factor off-chain:

```text
HF = Σ(collateral · price · collateralFactor) / Σ(liability · price / liabilityFactor)
```

Any position with `HF < 1.0` is liquidatable and becomes a task, prioritized by how far underwater it is (`HF < 0.5` → priority 10, `< 0.8` → 7, `< 0.95` → 4, else 1) so the most urgent liquidations run first.

**2. Draw.** For a profitable auction, the keeper calls `draw(keeper, bid)`. The vault verifies the keeper against the registry, transfers the bid, increments `active_liq`, records the outstanding draw, and calls `mark_draw` — which starts the slash clock. From this moment the keeper has `slash_timeout` seconds (3600s on testnet) to return capital before its stake becomes slashable.

**3. Fill.** The keeper submits the fill to Blend's `submit()` with the request type for the auction kind. Blend transfers the lot (collateral) to the keeper and consumes the bid (debt repayment). Fills go through bounded exponential backoff (at most 3 attempts, ~1s then ~2s), but only *transient* infrastructure failures are retried — deterministic contract failures (`AlreadyFilled`, `insufficient balance`, `unauthorized`) fail fast so the keeper does not burn fees on a doomed transaction.

:::tip Graceful contention
Multiple keepers may race the same auction. The first confirmed transaction wins; the losers get `AlreadyFilled` / `AuctionNotFound`. A loser drew capital but never spent it, so it returns the draw unchanged — no profit, no loss. There is no coordinator and no single point of failure.
:::

**4. Swap.** The lot is collateral, not USDC. The keeper converts every non-USDC lot asset to USDC before returning proceeds:

- **Soroswap first** (primary): it quotes the router, applies an **oracle-anchored slippage floor** — rejecting any quote below `refValue · (10000 − SLIPPAGE_BPS) / 10000` of the Blend-oracle-implied value — then executes the swap with an on-chain `amount_out_min`. A manipulated pool quote below that floor is rejected and does **not** fall back to another venue.
- **Phoenix fallback** if Soroswap is unavailable or errors for a non-slippage reason.
- Output is **always the keeper's measured USDC balance delta — never synthesized.** USDC already in the lot counts directly; an asset whose swap fails is held (excluded), not booked as phantom profit. If no DEX router is configured, only USDC already present in the lot is returnable. Swaps are not auto-retried, because re-broadcasting a non-idempotent swap could sell collateral twice.

**5. Return.** The keeper calls `return_proceeds(keeper, amount, response_time_ms)`. The vault repays `active_liq`, books `profit = amount − drawn` (raising the share price), then clears the draw and records the execution metrics on-chain. `response_time_ms` is the keeper-observed draw → fill → return latency.

**6. Yield.** Profit lands in `total_usdc` without minting shares, so the share price rises for every depositor. No rebasing, no claims, no reward tokens — share counts stay constant and each share is worth more.

```text
   Depositors ──deposit/withdraw──▶ NectarVault ◀──draw / return_proceeds──▶ Keeper (Go)
                                        │  ▲                                    │   ▲
                          get_keeper /  │  │  mark_draw / clear_draw /          │   │ fill
                          verify on draw│  │  record_execution / slash          ▼   │
                                        ▼  │                                  Blend pool
                                   KeeperRegistry                          (Dutch auctions,
                              (stake, performance, slash)                  Reflector oracle)
```

### Failure handling and backstops

Two backstops ensure capital that is drawn but not promptly returned is recovered.

**Stale-draw recovery (self-healing).** Before slashing can ever bite, the keeper daemon defends itself. At the top of *every* cycle it calls `get_keeper_draw(keeper)`; if it owes capital and holds USDC, it returns `min(drawn, usdc_on_hand)` via `return_proceeds(amount, 0)` (response time `0` skips the latency update). This makes the vault whole after a transient return failure and dodges a timeout slash. If it owes capital but holds no USDC (collateral still unsold), it logs and holds for manual recovery rather than touching its own float.

**Permissionless slashing (last resort).** If a keeper genuinely abandons a draw, *anyone* can call `slash(keeper)` once `has_active_draw` and more than `slash_timeout` seconds have elapsed since the draw was marked. The slashed stake (`slash_rate_bps / 10_000` of current stake, 10% on testnet) is transferred to the vault. Between self-recovery and slashing, drawn capital is either auto-returned next cycle or seized from the keeper's bond into the pool.

## Governance and Decentralization

Nectar's design goal is a protocol where depositor funds are governed by code, not by operators. The contracts already enforce the most important property: **no admin path can move depositor funds.** The admin can pause keeper registration and update configuration parameters, but it cannot withdraw the vault, mint shares, redirect proceeds, or transfer the slashed stake anywhere other than the vault. That said, decentralization is a **roadmap, not a finished state**, and this section says so plainly.

### Current trust assumptions (testnet)

Today the protocol is live on testnet only, and a **single admin key — the deployer — holds configuration and upgrade authority.** A depositor or operator using Nectar today is trusting:

| Assumption | What it means | Mitigation today | Roadmap |
|---|---|---|---|
| **Admin keys** | A single deployer key sets `VaultConfig` / `RegistryConfig` and can `pause` registration. It cannot move depositor funds. | Config-only authority; no fund-moving admin path. | Admin **multisig** (Tranche 3). |
| **Keeper honesty** | Keepers run off-chain code that draws real capital. | Bounded by **stake + permissionless slashing**, the per-keeper draw cap (`max_draw_per_keeper`), the registered-keeper check on every draw, and stale-draw recovery. A dishonest keeper loses stake to the pool. | Larger stake / dynamic parameters as the network grows. |
| **Blend integrity** | Nectar fills Blend's auctions and trusts Blend's solvency and auction accounting. | Read-only pricing; the keeper only commits capital when the profitability gate clears. | Multi-protocol adapter layer reduces single-protocol dependence. |
| **Oracle integrity** | Auction pricing and health factors use Blend's oracle (Reflector). A manipulated feed could mislead the gate. | `MIN_PROFIT` floor, oracle-anchored DEX slippage floor, admin `pause`. | **Oracle circuit breaker** (Tranche 3). |

The protocol has **not been audited.** USDC on testnet is a mock SAC with no real-world value.

### What is already decentralized

Several properties do not depend on the admin at all:

- **Permissionless participation.** Anyone can deposit, and anyone meeting `min_stake` can register as a keeper and compete. There is no allowlist and no coordinator.
- **Permissionless slashing.** `slash()` can be called by anyone — enforcement of keeper accountability does not route through the admin.
- **Competition, not central scheduling.** Keepers race each other for every auction; the first confirmed fill wins. There is no privileged operator and no single point of failure in execution.
- **Funds are code-governed.** The vault's share math and the no-fund-moving-admin-path property are immutable rules, not policies.

### The decentralization roadmap

The path to mainnet hardens the trust model in Tranche 3 (mainnet, ~October 2026, Circle USDC):

1. **Admin multisig.** Replace the single deployer key with a multisig over configuration and upgrade authority, removing the single-key risk on parameter changes.
2. **Oracle circuit breaker.** Cross-reference Blend's reported prices against the independent [Reflector](https://reflector.network/) oracle and **auto-pause** keeper activity when prices deviate beyond a threshold — defending against oracle-manipulation attacks that could otherwise drive keepers into unprofitable or attacker-controlled fills.
3. **Production parameters and packaging.** Mainnet deployment with Circle USDC, production-grade draw caps and rate limits, Docker packaging for one-command keeper setup, and operator documentation.

:::warning Decentralization is in progress
Nectar deliberately ships the trust-minimizing primitives first — staking, slashing, the registered-keeper check, the no-fund-moving-admin-path property — and decentralizes the remaining admin authority over time. Until the Tranche 3 multisig and circuit breaker land, treat the admin key and the oracle as trusted dependencies. See [Risks](./depositors/risks) for the depositor-facing view.
:::

## References

1. **Stellar Developer Documentation.** Stellar Development Foundation. [https://developers.stellar.org/](https://developers.stellar.org/)
2. **Soroban — Smart Contracts on Stellar.** Soroban SDK and platform documentation. [https://developers.stellar.org/docs/build/smart-contracts/overview](https://developers.stellar.org/docs/build/smart-contracts/overview)
3. **Blend Protocol.** Soroban lending protocol; the liquidation auctions Nectar fills. [https://www.blend.capital/](https://www.blend.capital/) · Docs: [https://docs.blend.capital/](https://docs.blend.capital/)
4. **Reflector Oracle.** Stellar price-feed oracle; Blend's price source on testnet and the planned circuit-breaker reference. [https://reflector.network/](https://reflector.network/)
5. **Soroswap.** Decentralized exchange / AMM router on Soroban; Nectar's primary collateral → USDC swap venue. [https://soroswap.finance/](https://soroswap.finance/)
6. **Phoenix.** Soroban AMM; Nectar's fallback swap venue. [https://www.phoenix-hub.io/](https://www.phoenix-hub.io/)
7. **DeFindex.** Soroban yield-vault protocol; target of Nectar's multi-protocol DeFindex adapter. [https://defindex.io/](https://defindex.io/)
8. **Circle USDC.** The USD-backed stablecoin used as the vault asset on mainnet (Tranche 3). [https://www.circle.com/usdc](https://www.circle.com/usdc)
9. **EIP-4626: Tokenized Vault Standard.** The share-accounting model Nectar's vault follows in spirit. [https://eips.ethereum.org/EIPS/eip-4626](https://eips.ethereum.org/EIPS/eip-4626)
10. **Stellar Community Fund — Build Award (SCF #42).** The grant funding Nectar's development. [https://communityfund.stellar.org/](https://communityfund.stellar.org/)
11. **Nectar Network monorepo.** Contracts, keeper, and frontend source. [https://github.com/Nectar-Network/nectar](https://github.com/Nectar-Network/nectar)
12. **Nectar keeper-sdk.** Public Go SDK and `ProtocolAdapter` interface for third-party keeper operators. [https://github.com/Nectar-Network/keeper-sdk](https://github.com/Nectar-Network/keeper-sdk)
13. **Nectar app.** [https://nectarnetwork.fun](https://nectarnetwork.fun)
14. **Nectar documentation.** [https://docs.nectarnetwork.fun](https://docs.nectarnetwork.fun)

---

*See also: [How It Works](./how-it-works) · [Architecture](./developers/architecture) · [NectarVault](./developers/contracts/nectar-vault) · [KeeperRegistry](./developers/contracts/keeper-registry) · [Blend Integration](./developers/blend-integration) · [Glossary](./reference/glossary)*
