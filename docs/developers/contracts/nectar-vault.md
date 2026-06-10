---
title: NectarVault
description: Full interface and reference for the NectarVault contract
---

# NectarVault

`NectarVault` custodies pooled USDC, mints / burns shares, and runs the draw / return cycle with keepers.

Source: [`contracts/vault/src/lib.rs`](https://github.com/Nectar-Network/nectar-poc/tree/main/contracts/vault/src) in the protocol repo.

## Public functions

### initialize

```rust
fn initialize(
    e: Env,
    admin: Address,
    usdc_token: Address,
    registry: Address,
    config: VaultConfig,
)
```

One-shot. Reverts with `Error::AlreadyInit` if called twice. Sets `admin` (parameter tuning only — no upgrade authority on Tranche 1), the USDC SAC, and the authorized `KeeperRegistry` contract.

### deposit

```rust
fn deposit(e: Env, depositor: Address, amount: u128) -> Result<u128, Error>
```

**Auth:** `depositor` must sign.

Pulls `amount` USDC from `depositor`, mints shares at the current price, and credits the depositor's record.

```
shares_minted = if total_shares == 0 {
    amount
} else {
    amount * total_shares / total_assets
}
```

Reverts if:

- `paused == true` (`Error::Paused`)
- `total_assets + amount > deposit_cap` (`Error::CapExceeded`)
- `amount == 0` (`Error::ZeroAmount`)

Returns the number of shares minted. Emits `DepositEvent`.

### request_withdraw

```rust
fn request_withdraw(e: Env, depositor: Address, shares: u128) -> Result<(), Error>
```

**Auth:** `depositor` must sign.

Escrows `shares` and records `claimable_at = current_ledger + cooldown_ledgers`. The depositor can have **at most one open request** at a time.

Reverts with `Error::PendingWithdrawal` if a request already exists. Reverts with `Error::InsufficientShares` if the depositor doesn't hold `shares`.

### claim_withdraw

```rust
fn claim_withdraw(e: Env, depositor: Address) -> Result<u128, Error>
```

**Auth:** `depositor` must sign.

Reverts unless `current_ledger >= claimable_at`. Computes:

```
amount = escrowed_shares * total_assets / total_shares
```

Burns the escrowed shares, transfers `amount` USDC to `depositor`, and clears the request. Returns the USDC amount paid.

Reverts with `Error::InsufficientLiquidity` if `total_assets - outstanding_draws < amount`.

### cancel_withdraw

```rust
fn cancel_withdraw(e: Env, depositor: Address) -> Result<(), Error>
```

**Auth:** `depositor` must sign. Returns escrowed shares to the depositor's free balance and clears the request. No penalty.

### draw

```rust
fn draw(e: Env, keeper: Address, amount: u128) -> Result<(), Error>
```

**Auth:** `keeper` must sign.

1. Calls `KeeperRegistry::assert_active(keeper)`.
2. Calls `KeeperRegistry::mark_draw(keeper, amount)`.
3. Records the draw locally (`outstanding_draws[keeper] = amount`, `draw_started_at[keeper] = current_ledger`).
4. Transfers `amount` USDC to `keeper`.

Reverts if `total_assets - sum(outstanding_draws) < amount` (`Error::InsufficientLiquidity`).

### return_proceeds

```rust
fn return_proceeds(e: Env, keeper: Address, amount: u128) -> Result<(), Error>
```

**Auth:** `keeper` must sign.

Pulls `amount` USDC from the keeper. Then:

```rust
let principal = outstanding_draws[keeper];
let keeper_fee_bps = config.keeper_fee_bps;
if amount >= principal {
    let profit = amount - principal;
    let fee = profit * keeper_fee_bps / 10_000;
    total_assets += profit - fee;
    transfer(usdc, vault, keeper, fee);
    KeeperRegistry::record_execution(keeper, profit - fee);
} else {
    let loss = principal - amount;
    total_assets -= loss;
    let recovered = KeeperRegistry::slash(keeper, loss);
    if recovered < loss {
        // residual is socialized via lower share price
    }
}
KeeperRegistry::clear_draw(keeper, principal);
outstanding_draws.remove(keeper);
```

Emits `ReturnEvent` (with `profit` or `loss`).

### cancel_draw

```rust
fn cancel_draw(e: Env, keeper: Address) -> Result<(), Error>
```

**Auth:** `keeper` must sign. Returns the principal without recording profit / loss / fee. Used when an auction race is lost (`auction_already_filled`). Reverts with `Error::NoOutstandingDraw` if the keeper has no in-flight draw.

### pause / unpause

```rust
fn pause(e: Env)
fn unpause(e: Env)
```

**Auth:** admin only. Pause halts new deposits and new draws. Existing depositors can still request and claim withdrawals.

### update_config

```rust
fn update_config(e: Env, config: VaultConfig)
```

**Auth:** admin only. Replaces the entire config struct. There is no per-field setter.

### Read-only

```rust
fn share_price(e: Env) -> u128                 // 7-decimal fixed point
fn total_assets(e: Env) -> u128
fn total_shares(e: Env) -> u128
fn balance_of(e: Env, depositor: Address) -> u128
fn position_value(e: Env, depositor: Address) -> u128
fn outstanding_draw(e: Env, keeper: Address) -> u128
```

## Data structures

### VaultState

```rust
pub struct VaultState {
    pub total_assets: u128,
    pub total_shares: u128,
    pub paused: bool,
}
```

### Depositor

```rust
pub struct Depositor {
    pub shares: u128,
    pub withdrawal_request: Option<WithdrawalRequest>,
}

pub struct WithdrawalRequest {
    pub shares: u128,
    pub claimable_at: u32,  // ledger
}
```

### VaultConfig

```rust
pub struct VaultConfig {
    pub deposit_cap: u128,           // hard cap on total_assets
    pub min_deposit: u128,           // minimum deposit per call
    pub cooldown_ledgers: u32,       // withdrawal cooldown
    pub keeper_fee_bps: u32,         // share of profit paid to keeper, default 1000 (10%)
}
```

### Error

```rust
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    NotAdmin = 3,
    NotKeeper = 4,
    NotRegistry = 5,
    Paused = 10,
    ZeroAmount = 11,
    CapExceeded = 12,
    BelowMinDeposit = 13,
    InsufficientShares = 20,
    InsufficientLiquidity = 21,
    PendingWithdrawal = 22,
    NotClaimable = 23,
    NoOutstandingDraw = 30,
}
```

Full table on [Error Codes](../../reference/error-codes).

## Events

```rust
DepositEvent      { depositor, amount, shares, share_price }
WithdrawRequest   { depositor, shares, claimable_at }
WithdrawClaim     { depositor, shares, amount }
WithdrawCancel    { depositor, shares }
DrawEvent         { keeper, amount, total_outstanding }
ReturnEvent       { keeper, principal, returned, profit_or_loss }
PauseEvent        { paused }
ConfigEvent       { config }
```

## Cross-contract integration

The vault calls into `KeeperRegistry` four times per cycle:

1. `assert_active(keeper)` — `draw` entry gate
2. `mark_draw(keeper, amount)` — increments registry's outstanding count
3. `clear_draw(keeper, principal)` — on `return_proceeds` or `cancel_draw`
4. `record_execution(keeper, profit)` or `slash(keeper, loss)` — on success / loss

Both contracts must be initialized with each other's address before any keeper activity.

## Example: deposit via stellar CLI

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT \
  --source $DEPOSITOR_SECRET \
  --network testnet \
  -- \
  deposit \
  --depositor $DEPOSITOR_ADDRESS \
  --amount 100_0000000   # 100 USDC, 7 decimals
```

## Example: query share price

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT \
  --network testnet \
  -- \
  share_price
```

Returns a 7-decimal fixed-point integer. Divide by `10_000_000` for the human-readable price.
