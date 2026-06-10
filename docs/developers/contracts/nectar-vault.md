---
title: NectarVault
description: Full interface and reference for the NectarVault contract — deposits, withdrawals, share math, keeper draw/return accounting, and the cross-contract registry check.
---

# NectarVault

`NectarVault` custodies the pooled USDC, accounts for depositor shares, and runs the keeper draw / return cycle. Depositors receive shares proportional to the current share price; keepers draw idle capital to fill Blend liquidation auctions and return it plus realized profit, which raises the share price for everyone.

Source: [`contracts/nectar-vault/src/lib.rs`](https://github.com/Nectar-Network/nectar/tree/main/contracts/nectar-vault/src) in the protocol repo.

:::info Deployed on testnet
| Component | Address |
|---|---|
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |

Tranche 1 hardened deployment (2026-05-24), Soroban Testnet (`Test SDF Network ; September 2015`). On testnet, USDC is a mock Stellar Asset Contract; mainnet (Tranche 3) will use Circle USDC. All amounts are `i128` at 7-decimal precision — **1 USDC = 10,000,000 stroops**.
:::

## Concepts

- **Shares.** A deposit mints shares. The first deposit mints 1:1 (`shares = amount`); every later deposit mints `amount * total_shares / total_usdc`. Integer division floors toward zero, so a depositor is never over-credited and existing holders are protected. There is no separate share token — shares live in the per-user `Depositor` record.
- **Share price.** Implicitly `total_usdc / total_shares`. The contract never stores a price; `balance` and `withdraw` derive value on demand.
- **`active_liq` (active liquidity).** USDC currently drawn by keepers and not yet returned. `available = total_usdc - active_liq` is what a new draw can pull.
- **`total_profit`.** Cumulative realized profit booked from keeper returns. Profit is added to `total_usdc` (raising the share price) and tracked separately for reporting.
- **Per-keeper draw.** Each keeper's outstanding drawn amount is tracked under `KeeperDraw(keeper)` so a return can compute profit and an off-chain keeper can cap a self-recovery at exactly what it owes.

## Public functions

### initialize

```rust
pub fn initialize(
    env: Env,
    admin: Address,
    usdc_token: Address,
    registry: Address,
    config: VaultConfig,
) -> Result<(), VaultError>
```

**Auth:** none — first caller wins.

One-shot. Reverts with `VaultError::AlreadyInit` if `Admin` is already set. Stores `admin` (parameter tuning via `set_config` only — there is no upgrade authority), the USDC token (`usdc_token`), the authorized `KeeperRegistry` address (`registry`), the `VaultConfig`, and a zeroed `VaultState` (`total_usdc`, `total_shares`, `total_profit`, `active_liq` all `0`).

### deposit

```rust
pub fn deposit(env: Env, user: Address, amount: i128) -> Result<i128, VaultError>
```

**Auth:** `user.require_auth()`.

Mints shares, pulls `amount` USDC from `user` into the vault, and credits the depositor's record. Share math:

```rust
let shares = if total_shares == 0 {
    amount                                    // first deposit: 1:1
} else {
    amount * total_shares / total_usdc        // floors toward zero
};
```

The depositor's `last_deposit_time` is set to the current ledger timestamp, which **resets the withdrawal cooldown** — any new deposit restarts the timer for that account.

Reverts with `VaultError::NotInit` if the contract is not initialized, or `VaultError::DepositCapExceeded` when `deposit_cap > 0 && total_usdc + amount > deposit_cap` (the exact cap is allowed). Returns the number of shares minted. Emits the `deposit` event.

:::tip First deposit and tiny amounts
A 1-stroop first deposit mints exactly 1 share, and a 10,000,000-USDC deposit mints exactly that many shares — there is no minimum deposit and no precision loss on the first deposit. After profit has accrued, later deposits mint fewer shares because the share price is above par.
:::

### withdraw

```rust
pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<i128, VaultError>
```

**Auth:** `user.require_auth()`.

Burns `shares` from the depositor's balance and transfers proportional USDC (including accrued profit) back to `user`:

```rust
let usdc_out = shares * total_usdc / total_shares;  // floors toward zero
```

When the depositor holds all outstanding shares, this returns the full `total_usdc`. Decrements the depositor's shares and reduces `total_usdc` and `total_shares` accordingly.

Reverts with:

- `VaultError::NoShares` — caller has no `Depositor` record
- `VaultError::InsufficientBalance` — `shares > depositor.shares`
- `VaultError::WithdrawalCooldown` — `now - last_deposit_time < withdraw_cooldown` (withdrawal is allowed exactly at `last_deposit_time + withdraw_cooldown`)
- `VaultError::InsufficientVault` — `total_shares == 0`

Returns the USDC paid out. Emits the `withdraw` event.

:::warning Withdrawing 0 shares is a no-op
Calling `withdraw` with `shares = 0` succeeds, pays out 0, and leaves the balance unchanged. It does **not** error. Withdrawals can also fail at the token-transfer layer if the vault's free USDC (`total_usdc - active_liq`) is below `usdc_out` because capital is currently drawn — wait for keepers to return capital, then retry.
:::

### balance

```rust
pub fn balance(env: Env, user: Address) -> (i128, i128)
```

**Auth:** none (read-only view).

Returns `(shares, usdc_value)` for `user`. Returns `(0, 0)` if there is no depositor record or no vault state, and `(shares, 0)` while `total_shares == 0`. Otherwise `usdc_value = shares * total_usdc / total_shares`.

### draw

```rust
pub fn draw(env: Env, keeper: Address, amount: i128) -> Result<(), VaultError>
```

**Auth:** `keeper.require_auth()`.

A registered keeper draws idle capital to fund a liquidation. Steps:

1. Enforce the per-keeper draw limit: reverts `VaultError::DrawLimitExceeded` if `max_draw_per_keeper > 0 && amount > max_draw_per_keeper` (the exact limit is allowed). This is a **per-call** limit, not cumulative across draws.
2. Compute `available = total_usdc - active_liq`; reverts `VaultError::InsufficientVault` if `amount > available`.
3. Verify the keeper exists by cross-calling `KeeperRegistry::get_keeper(keeper)` (presence check — the return value is discarded). A non-registered keeper makes this sub-call fail.
4. Transfer `amount` USDC from the vault to the keeper.
5. Track the draw: `KeeperDraw(keeper) += amount`, and `active_liq += amount`.
6. If `amount > 0`, call `KeeperRegistry::mark_draw(vault, keeper)` so the registry records an active draw (and starts the slash-timeout clock). A zero-amount draw skips the registry call.

Emits the `draw` event.

:::warning Draws while capital is outstanding
`draw` checks `amount` against `max_draw_per_keeper` per call only — there is no on-chain cap on a keeper's *total* simultaneous outstanding draw inside the vault. Aggregate exposure is bounded by `available` (the vault can never lend out more than it holds) and by the registry's slash-on-timeout mechanic, which penalizes a keeper that draws and fails to return.
:::

### return_proceeds

```rust
pub fn return_proceeds(
    env: Env,
    keeper: Address,
    amount: i128,
    response_time_ms: u64,
) -> Result<(), VaultError>
```

**Auth:** `keeper.require_auth()`.

The keeper returns capital (and any profit) after filling — or losing — an auction. `response_time_ms` is the keeper-observed draw-to-fill-to-return latency, forwarded to the registry to build the per-keeper average response-time metric.

1. Transfer `amount` USDC from the keeper into the vault.
2. Read the keeper's outstanding draw `drawn = KeeperDraw(keeper)` (0 if none).
3. Repay active liquidity: `repay = min(amount, active_liq)`; apply `active_liq -= repay`.
4. Compute profit:

```rust
let profit = if drawn > 0 && amount > drawn {
    amount - drawn          // returned more than drawn → the excess is profit
} else if drawn == 0 {
    amount                  // no tracked draw → whole amount treated as donated profit
} else {
    0                       // returned <= drawn → no profit booked
};
```

5. Book profit: `total_usdc += profit`, `total_profit += profit`.
6. If `drawn > 0`: remove the `KeeperDraw(keeper)` record, call `KeeperRegistry::clear_draw(vault, keeper)`, and call `KeeperRegistry::record_execution(vault, keeper, true, profit, response_time_ms)` to update the keeper's on-chain stats.

Emits the `return` event with `(amount, profit)`.

:::info Partial returns and the no-draw case
A return **at or below** the drawn amount (a partial recovery, e.g. an unprofitable fill) reduces `active_liq` by the returned amount but books **zero** profit. A return when no draw is tracked (`drawn == 0`) treats the entire amount as donated profit and does **not** touch the registry (no `clear_draw`/`record_execution`). The off-chain keeper uses [`get_keeper_draw`](#get_keeper_draw) to size a self-recovery so it returns exactly what it owes.
:::

### get_state

```rust
pub fn get_state(env: Env) -> Result<VaultState, VaultError>
```

**Auth:** none (read-only). Returns the live `VaultState`; reverts `VaultError::NotInit` if uninitialized.

### get_config

```rust
pub fn get_config(env: Env) -> Result<VaultConfig, VaultError>
```

**Auth:** none (read-only). Returns the current `VaultConfig`; reverts `VaultError::NotInit` if uninitialized.

### set_config

```rust
pub fn set_config(env: Env, admin: Address, config: VaultConfig) -> Result<(), VaultError>
```

**Auth:** admin only. The stored admin is compared to `admin` **before** `admin.require_auth()` runs, so an intruder receives `VaultError::Unauthorized` even with auth mocked. Reverts `VaultError::NotInit` if uninitialized. Replaces the entire config struct — there is no per-field setter.

### get_depositor

```rust
pub fn get_depositor(env: Env, user: Address) -> Result<Depositor, VaultError>
```

**Auth:** none (read-only). Returns the full `Depositor` record; reverts `VaultError::NoShares` if the user has never deposited.

### get_keeper_draw

```rust
pub fn get_keeper_draw(env: Env, keeper: Address) -> i128
```

**Auth:** none (read-only). Returns the keeper's outstanding drawn-but-unreturned capital (`0` if none). The keeper daemon reads this each cycle to recover a stale draw: it caps the recovery return at this value so it never over-returns its own liquid balance.

## Share math, caps, and cooldown

- **Deposit shares.** First deposit `shares = amount`; thereafter `shares = amount * total_shares / total_usdc`, floored. After 100 USDC of profit on a 1000-share / 1100-USDC pool, a 1000-USDC deposit mints `1000_0000000 * 1000_0000000 / 1100_0000000` shares (share price 1.1).
- **Withdraw payout.** `usdc_out = shares * total_usdc / total_shares`, floored. A full withdrawal returns the entire `total_usdc`. Across three equal withdrawers, total rounding dust is bounded to at most 3 stroops and the pool is never over-paid.
- **Profit distribution.** Booking profit into `total_usdc` raises every share's value proportionally. Example: depositors split 1:2:3, then 60 USDC profit on a 600-USDC pool yields positions worth 110 / 220 / 330 USDC.
- **Deposit cap.** Enforced only when `deposit_cap > 0`. Rejects when `total_usdc + amount > deposit_cap`; the exact cap is permitted.
- **Withdrawal cooldown.** Enforced only when `withdraw_cooldown > 0` (a `0` cooldown always passes). Blocks while `now - last_deposit_time < withdraw_cooldown`; **any new deposit resets `last_deposit_time`** and therefore the cooldown.
- **Per-keeper draw limit.** Enforced only when `max_draw_per_keeper > 0`. Rejects `amount > max_draw_per_keeper` per single `draw` call; the exact limit is permitted.

The current testnet config (Tranche 1 hardened): `deposit_cap` = 10,000,000 USDC, `withdraw_cooldown` = 3600 s (1 h), `max_draw_per_keeper` = 10,000 USDC.

## Data structures

### VaultState

Instance storage. Holds the running pool accounting.

```rust
pub struct VaultState {
    pub total_usdc: i128,    // total pool assets (principal + booked profit), minus net withdrawals
    pub total_shares: i128,  // total shares outstanding
    pub total_profit: i128,  // cumulative realized profit booked from returns
    pub active_liq: i128,    // capital currently drawn by keepers, not yet returned
}
```

### Depositor

Persistent storage, keyed by user address.

```rust
pub struct Depositor {
    pub addr: Address,
    pub shares: i128,
    pub deposited_at: u64,        // first-deposit timestamp
    pub last_deposit_time: u64,   // resets the withdrawal cooldown on every deposit
}
```

### VaultConfig

Instance storage. A `0` value disables the corresponding guard.

```rust
pub struct VaultConfig {
    pub deposit_cap: i128,          // hard cap on total_usdc; 0 = unlimited
    pub withdraw_cooldown: u64,     // seconds a depositor must wait after a deposit; 0 = none
    pub max_draw_per_keeper: i128,  // max USDC per single draw call; 0 = unlimited
}
```

### VaultKey

Storage keys (`#[contracttype]` enum).

| Key | Storage | Holds |
|---|---|---|
| `Admin` | instance | admin `Address` |
| `Usdc` | instance | USDC token `Address` |
| `State` | instance | `VaultState` |
| `Depositor(Address)` | persistent | per-user `Depositor` |
| `KeeperRegistry` | instance | authorized registry `Address` |
| `VaultConfig` | instance | `VaultConfig` |
| `KeeperDraw(Address)` | persistent | per-keeper outstanding draw (`i128`) |

### VaultError

```rust
pub enum VaultError {
    AlreadyInit = 1,
    NotInit = 2,
    InsufficientBalance = 3,
    InsufficientVault = 4,
    Unauthorized = 5,
    NoShares = 6,
    // code 7 is intentionally unused
    DepositCapExceeded = 8,
    WithdrawalCooldown = 9,
    DrawLimitExceeded = 10,
}
```

Note: numeric code `7` is intentionally skipped — there is no variant with that code. Full table on [Error Codes](../../reference/error-codes).

## Events

| Topic | Topic data | Payload |
|---|---|---|
| `deposit` | user address | `(amount, shares)` |
| `withdraw` | user address | `(shares, usdc_out)` |
| `draw` | keeper address | `amount` |
| `return` | keeper address | `(amount, profit)` |

## Cross-contract integration

The vault calls into `KeeperRegistry` during the draw / return cycle. On each call it passes its own contract address as the `caller`, which the registry validates against its stored `VaultAddr` via `require_vault`.

| When | Registry call | Purpose |
|---|---|---|
| `draw` (always) | `get_keeper(keeper)` | Verify the keeper is registered (presence check; return ignored) |
| `draw` (when `amount > 0`) | `mark_draw(vault, keeper)` | Flag an active draw and start the slash-timeout clock |
| `return_proceeds` (when a draw was tracked) | `clear_draw(vault, keeper)` | Clear the active-draw flag |
| `return_proceeds` (when a draw was tracked) | `record_execution(vault, keeper, true, profit, response_time_ms)` | Record a successful fill, profit, and response time |

If a keeper draws and never returns, the registry's permissionless `slash` can be triggered once `slash_timeout` elapses; slashed stake is transferred to **this vault's address**, flowing back into the pool. See [KeeperRegistry](./keeper-registry) for the slashing rules.

Both contracts must be initialized pointing at each other's address before any keeper activity: the vault is initialized with the registry address, and the registry with the vault address.

## End-to-end cycle (verified)

A full real-registry cycle — register (100 USDC stake pulled), deposit 1000, draw 500, return 510 (10 profit) — yields on the registry: `total_executions = 1`, `successful_fills = 1`, `total_profit = 10_0000000`, `response_count = 1`, `avg_response_time_ms = 175`; and on the vault: `active_liq = 0`, `total_profit = 10_0000000`, `total_usdc = 1010_0000000`.

## Example: deposit via Stellar CLI

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT \
  --source $DEPOSITOR_SECRET \
  --network testnet \
  -- \
  deposit \
  --user $DEPOSITOR_ADDRESS \
  --amount 100_0000000          # 100 USDC, 7 decimals
```

Returns the number of shares minted.

## Example: read vault state

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT \
  --network testnet \
  -- \
  get_state
```

Returns the `VaultState` struct. Divide any USDC field by `10_000_000` for the human-readable value, and compute the share price as `total_usdc / total_shares`.

## Example: check a depositor's balance

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT \
  --network testnet \
  -- \
  balance \
  --user $DEPOSITOR_ADDRESS
```

Returns a 2-element tuple `[shares, usdc_value]`, both 7-decimal integers.
