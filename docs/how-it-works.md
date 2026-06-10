---
sidebar_position: 2
title: How It Works
description: The end-to-end Nectar liquidation cycle — deposit to shares, keeper draw, Blend Dutch-auction fill, collateral swap, return of proceeds, and share-price yield, plus on-chain performance tracking and slashing.
---

# How It Works

Nectar separates two things that are usually entangled in a liquidation bot: **capital** and **execution**. Capital lives in the `NectarVault`, owned collectively by depositors. Execution is run by keepers — independent off-chain operators who stake into the `KeeperRegistry`, borrow vault capital briefly to fill profitable [Blend Protocol](https://blend.capital) auctions, swap the seized collateral to USDC, and return principal plus profit. The vault's share price rises, and every depositor's position appreciates proportionally.

All amounts are `i128` at **7-decimal precision** (Stellar native): `1 USDC = 10,000,000 stroops`. Integer division always floors toward zero, so neither depositors nor keepers can extract more than their proportional value — rounding dust accrues to the pool.

:::info
Nectar is currently deployed on Stellar **testnet** (Tranche 1 hardened, redeployed 2026-05-24). USDC there is a mock Stellar Asset Contract. Mainnet with Circle USDC ships in Tranche 3. Current addresses: [Contract Addresses](./reference/contract-addresses).
:::

## The two layers

```text
                deposit / withdraw (USDC <-> shares)
   Depositors  <------------------------------------>  NectarVault
                                                        - pooled USDC, share accounting
                                                        - tracks total_usdc / total_shares
                                                        - active_liq = capital out with keepers
                                                          |   ^
                                          draw(keeper,amt)|   | return_proceeds(keeper,amt,ms)
                                                          v   |
                                                        Keeper (off-chain Go daemon / SDK)
                                                        - polls Blend, finds HF < 1
                                                        - fills Dutch auction
                                                        - swaps collateral -> USDC
                                                          |   ^
                                  mark_draw / clear_draw  |   | record_execution / slash
                                                          v   |
                                                        KeeperRegistry
                                                        - staking, performance, slashing
                                                          |
                                                   create + fill auction
                                                          v
                                                        Blend Protocol (external)
                                                        - lending pools, Dutch auctions
```

Two contracts cooperate. The vault never trusts a keeper blindly: every `draw` first calls `KeeperRegistry.get_keeper()` to confirm the caller is registered, and a draw that is never returned can be **slashed** by anyone after a timeout.

## The cycle, step by step

A full liquidation cycle is six steps. The on-chain calls and their exact signatures follow.

### 1. Deposit -> shares

A depositor calls `deposit(user, amount)` on the vault and receives newly minted shares.

```rust
pub fn deposit(env: Env, user: Address, amount: i128) -> Result<i128, VaultError>
```

- The deposit cap is enforced only when `deposit_cap > 0`: the call reverts with `DepositCapExceeded` if `total_usdc + amount > deposit_cap` (the exact cap is allowed). Testnet cap is 10,000,000 USDC.
- **Share math** — the first deposit mints 1:1 (`shares = amount`); afterward:

  ```text
  shares = amount * total_shares / total_usdc   (floored)
  ```

- `amount` USDC is transferred from the user into the vault; the depositor record's `last_deposit_time` is set to now, which **resets the withdrawal cooldown**.

The depositor never burns shares to earn — yield comes purely from a rising share price (see step 6).

### 2. Detect

A registered keeper polls the Blend pool every cycle (`POLL_INTERVAL`, default 10s). It loads pool reserves and oracle prices, discovers borrower positions, and computes each position's health factor:

```text
HF = Σ(collateral · BRate · price · collateralFactor) / Σ(liability · DRate · price / liabilityFactor)
```

Any position with `HF < 1.0` is liquidatable. The keeper emits one `liquidation` task per underwater position, prioritized by how far underwater it is (`HF < 0.5` → priority 10, `< 0.8` → 7, `< 0.95` → 4, else 1).

### 3. Draw

The keeper calls `draw` to pull the capital it needs for the bid.

```rust
pub fn draw(env: Env, keeper: Address, amount: i128) -> Result<(), VaultError>
```

The vault, in order:

1. Enforces the per-keeper draw limit (only when `max_draw_per_keeper > 0`): reverts `DrawLimitExceeded` if `amount > max_draw_per_keeper` (exact limit allowed; testnet limit is 10,000 USDC). The limit is **per draw call**, not cumulative.
2. Computes `available = total_usdc - active_liq` and reverts `InsufficientVault` if `amount > available`.
3. Calls `KeeperRegistry.get_keeper(keeper)` cross-contract to verify the keeper is registered (the call must succeed; its return value is not inspected).
4. Transfers `amount` USDC to the keeper, adds `amount` to that keeper's outstanding `KeeperDraw`, and increments `active_liq`.
5. If `amount > 0`, calls `KeeperRegistry.mark_draw(vault, keeper)`, which sets `has_active_draw = true` and records `last_draw_time` — the slashing clock starts here.

:::warning
A draw is an open obligation. From the moment `mark_draw` fires, the keeper has `slash_timeout` seconds (3600 s on testnet) to return capital before its stake becomes slashable. The keeper daemon also runs a [stale-draw recovery](#stale-draw-recovery) check at the top of every cycle to make the vault whole if a prior return failed.
:::

### 4. Fill the Blend Dutch auction

Blend liquidations are two-phase Dutch auctions that scale over 400 ledgers:

| Phase | Elapsed (ledgers) | Lot (collateral you receive) | Bid (debt you pay) |
|---|---|---|---|
| Lot-scaling | 0–200 | grows 0% → 100% | fixed 100% |
| Bid-scaling | 200–400 | fixed 100% | shrinks 100% → 0% |
| Expired | > 400 | 100% | 0% |

The "fair price" point is `elapsed = 200`, where both legs sit at 100%. The keeper computes a profitability ratio:

```text
ratio = lotValue / bidValue   (Σ amount · phasePct · oraclePrice over each leg)
```

If `ratio < MIN_PROFIT` (default `1.02`), the keeper **does not draw and does not fill** — it logs `not profitable` and moves on. Otherwise it submits the fill. There are three auction kinds, mapped to Blend `submit()` request types:

| Auction kind | `request_type` |
|---|---|
| User liquidation | 6 |
| Bad debt | 7 |
| Interest | 8 |

The Blend reference adapter creates the user-liquidation auction at 50% (`new_liquidation_auction(user, 0.5 · 1e7)`), reads it back, then submits a fill request (`{address, amount=0, request_type}`) via `submit(from, from, from, requests)`. Blend transfers the auction lot (collateral) to the keeper and consumes the bid (debt repayment).

:::tip Graceful contention
Multiple keepers may race the same auction. The first confirmed transaction wins; the losers get `ErrAlreadyFilled` (Blend's `AuctionNotFound` / `AlreadyFilled` / `#4`). A loser drew capital but never spent it, so it returns the draw unchanged — no profit, no loss. There is no coordinator and no single point of failure.
:::

### 5. Swap collateral -> USDC, then return proceeds

The auction lot is collateral, not USDC. The keeper converts every non-USDC lot asset to USDC (Tranche 2 DEX integration):

- **Soroswap first** (primary): quotes `router_get_amounts_out`, applies an **oracle-anchored slippage floor** (a manipulated pool quote below the Blend-oracle-implied value is rejected with `ErrSlippageExceeded` and does **not** fall back to another venue), then executes `swap_exact_tokens_for_tokens` with an on-chain `amount_out_min`.
- **Phoenix fallback** if Soroswap is unavailable or errors for a non-slippage reason.
- Output is **always the keeper's measured USDC balance delta — never synthesized.** USDC already in the lot counts directly; an asset whose swap fails is held (excluded), not booked as phantom profit. If no DEX router is configured, only USDC already present in the lot is returnable.

The keeper then calls:

```rust
pub fn return_proceeds(
    env: Env,
    keeper: Address,
    amount: i128,
    response_time_ms: u64,
) -> Result<(), VaultError>
```

The vault transfers `amount` USDC back in and books accounting against the keeper's outstanding `drawn`:

- `repay = min(amount, active_liq)` is removed from `active_liq`.
- `profit = amount - drawn` when `amount > drawn`; otherwise `0` (a return at or below the drawn amount books no profit). If no draw was tracked (`drawn == 0`), the whole amount is treated as donated profit.
- `profit` is added to both `total_usdc` and `total_profit`.

If a draw was outstanding, the vault clears it: `KeeperDraw` is removed, `KeeperRegistry.clear_draw(vault, keeper)` fires, and `record_execution(vault, keeper, true, profit, response_time_ms)` records the successful fill and latency on-chain. `response_time_ms` is the keeper-observed draw→fill→return elapsed time.

### 6. Yield -> share price ticks up

Profit lands in `total_usdc` without minting new shares, so the share price rises for everyone:

```text
share_price = total_usdc / total_shares
```

No rebasing, no claim transactions, no reward tokens — your share count stays constant and each share is worth more. A depositor realizes the gain only on withdrawal.

```rust
pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<i128, VaultError>
```

```text
usdc_out = shares * total_usdc / total_shares   (floored)
```

`withdraw` enforces the **cooldown** (only when `withdraw_cooldown > 0`): it reverts `WithdrawalCooldown` while `now - last_deposit_time < withdraw_cooldown` (3600 s on testnet). Withdrawal is permitted exactly at `last_deposit_time + cooldown`. A full withdrawal returns the entire `total_usdc`; three-way rounding dust is bounded to at most 3 stroops and never over-pays.

:::info Worked example
A vault holds 1,000 USDC across 1,000 shares (share price 1.0). A keeper draws 500, fills an auction, and returns 510. Profit is `510 - 500 = 10` USDC. `total_usdc` becomes 1,010, `total_shares` stays 1,000, so the share price is now 1.01 — a 1% gain credited to every holder, with `active_liq` back to 0. This is the exact path verified by the contract's `test_real_registry_full_cycle`.
:::

## Performance tracking and slashing

The `KeeperRegistry` is the accountability layer. Only the vault may write performance data (it passes its own address as `caller`; the registry validates against its stored `VaultAddr`).

### What gets recorded

Each successful `record_execution` updates the keeper's on-chain `KeeperInfo`:

- `total_executions += 1` (always, success or failure)
- on success only: `successful_fills += 1`, `total_profit += profit`, and the response-time accumulators (`total_response_time_ms`, `response_count`)

So a failed execution increments only the execution count — it never inflates profit or the response-time average. Derived metrics surfaced on the [keeper leaderboard](https://nectarnetwork.fun/dashboard/keepers):

- **Win rate** = `successful_fills / total_executions` (shown as "—" with zero executions, never a fabricated 100%).
- **Average response time** = `avg_response_time_ms(operator)` = `total_response_time_ms / response_count` (integer division; `0` if no successes).

### Staking and slashing

Registering locks `min_stake` USDC (100 USDC on testnet) into the registry. Deregistering refunds the keeper's current (possibly post-slash) stake — but is blocked while a draw is active (`ActiveDraw`).

```rust
pub fn slash(env: Env, keeper: Address) -> Result<i128, Error>
```

Slashing is **permissionless** — any caller can trigger it once a keeper has left a draw open too long. It reverts `SlashTimeout` unless **both** conditions hold:

1. `has_active_draw == true`, and
2. `now - last_draw_time > slash_timeout` (strictly greater — slashing is impossible at exactly the timeout).

On a valid slash, the registry computes `slash_amt = stake · slash_rate_bps / 10_000` (10% on testnet), **transfers the slashed amount to the vault** (it is not burned — it flows to depositors), reduces the keeper's stake, and clears the active-draw flag. This is the economic guarantee behind the vault: capital a keeper fails to return is recovered from its bonded stake.

### Stale-draw recovery

Before slashing can ever bite, the keeper daemon defends itself. At the top of **every** cycle it calls `get_keeper_draw(keeper)`; if it owes capital and holds USDC, it returns `min(drawn, usdc_on_hand)` via `return_proceeds(amount, 0)` (responseTimeMs `0` skips the latency update). This makes the vault whole after a transient return failure and avoids a timeout slash. If it owes capital but holds no USDC (collateral still unsold), it logs and holds for manual recovery rather than touching its own float.

## Where this runs

- **Contracts** — `NectarVault` and `KeeperRegistry` are Soroban (Rust, SDK 22.x). See [NectarVault](./developers/contracts/nectar-vault) and [KeeperRegistry](./developers/contracts/keeper-registry).
- **Keeper** — a stateless Go daemon (or the public [keeper SDK](./developers/keeper-sdk)) that reads all state from chain each cycle and restarts safely. The Blend integration internals live in [Blend Integration](./developers/blend-integration).
- **Frontend** — a Next.js app reading live on-chain state and the keeper API.

## What's next

- [Deposit USDC and earn yield →](./depositors/deposit-guide)
- [Understand the yield model →](./depositors/understanding-yield)
- [Run a keeper →](./operators/setup)
- [Stake and slashing details →](./operators/staking)
- [Contract reference →](./developers/contracts/nectar-vault)
