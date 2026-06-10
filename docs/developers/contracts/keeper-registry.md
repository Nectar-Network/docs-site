---
title: KeeperRegistry
description: Full interface and reference for the KeeperRegistry contract
---

# KeeperRegistry

`KeeperRegistry` holds keeper stake, tracks performance, and authorizes draws. It is called by the vault on every draw / return cycle and directly by keepers for registration and stake management.

Source: [`contracts/registry/src/lib.rs`](https://github.com/Nectar-Network/nectar-poc/tree/main/contracts/registry/src) in the protocol repo.

## Public functions

### initialize

```rust
fn initialize(
    e: Env,
    admin: Address,
    usdc_token: Address,
    vault: Address,
    config: RegistryConfig,
)
```

One-shot initializer. Reverts with `Error::AlreadyInit` if called twice. Sets `admin` (no upgrade rights, only parameter tuning), the USDC SAC contract used for stake, and the authorized vault contract that may call `mark_draw` / `clear_draw` / `record_execution` / `slash`.

### register

```rust
fn register(e: Env, keeper: Address, name: String, stake: u128) -> Result<(), Error>
```

**Auth:** `keeper` must sign.

Pulls `stake` USDC from `keeper` into the registry, creates a `KeeperInfo` record, and marks the keeper `Active`. Reverts if:

- already registered (`Error::AlreadyRegistered`)
- `stake < config.min_stake` (`Error::NotEnoughStake`)
- USDC transfer fails

Emits `RegisterEvent { keeper, name, stake }`.

### stake_add

```rust
fn stake_add(e: Env, keeper: Address, amount: u128) -> Result<(), Error>
```

**Auth:** `keeper` must sign. Adds to existing stake. No upper bound.

### unregister

```rust
fn unregister(e: Env, keeper: Address) -> Result<(), Error>
```

**Auth:** `keeper` must sign.

Reverts with `Error::HasOutstandingDraw` if the keeper currently has any drawn capital. Otherwise sets status to `Cooldown` and records `cooldown_until_ledger = current + cooldown_ledgers`.

### claim_stake

```rust
fn claim_stake(e: Env, keeper: Address) -> Result<(), Error>
```

**Auth:** `keeper` must sign. Reverts unless status is `Cooldown` and `current_ledger >= cooldown_until_ledger`. Transfers escrowed stake back to the keeper and removes the record.

### assert_active

```rust
fn assert_active(e: Env, keeper: Address) -> Result<(), Error>
```

**Auth:** none (read-style; no signature required, no state change).

Reverts unless the keeper is `Active` and not in cooldown. Used by the vault as an authorization gate.

### mark_draw

```rust
fn mark_draw(e: Env, keeper: Address, amount: u128) -> Result<(), Error>
```

**Auth:** caller must be the configured `vault` address.

Increments `outstanding_draw`. Reverts if `outstanding + amount > stake * leverage_factor`.

### clear_draw

```rust
fn clear_draw(e: Env, keeper: Address, amount: u128)
```

**Auth:** vault only. Decrements `outstanding_draw` by `amount`.

### record_execution

```rust
fn record_execution(e: Env, keeper: Address, profit: u128)
```

**Auth:** vault only. Increments `successful_fills`, adds to `total_profit`, updates `last_active_ledger`.

### slash

```rust
fn slash(e: Env, keeper: Address, amount: u128) -> u128
```

**Auth:** vault only.

Slashes up to `amount` from stake (capped at the keeper's current stake). Returns the actually-slashed amount. If post-slash stake falls below `min_stake`, marks the keeper `Inactive`.

Emits `SlashEvent { keeper, amount, reason }`.

### slash_timeout

```rust
fn slash_timeout(e: Env, keeper: Address, slasher: Address) -> Result<u128, Error>
```

**Auth:** anyone signs as `slasher`.

Reverts unless `current_ledger > keeper.draw_started_at + timeout_ledgers`. Slashes the full outstanding draw from stake, transfers a 1% bounty to `slasher`, and pays the rest to the vault.

### update_name

```rust
fn update_name(e: Env, keeper: Address, name: String) -> Result<(), Error>
```

**Auth:** `keeper` must sign. Updates the keeper's display name.

### get_keeper

```rust
fn get_keeper(e: Env, keeper: Address) -> Option<KeeperInfo>
```

Read-only. Returns the keeper's full record or `None`.

## Data structures

### KeeperInfo

```rust
pub struct KeeperInfo {
    pub address: Address,
    pub name: String,
    pub stake: u128,
    pub outstanding_draw: u128,
    pub draw_started_at: u32,           // ledger
    pub status: KeeperStatus,
    pub cooldown_until_ledger: u32,
    pub successful_fills: u64,
    pub failed_fills: u64,
    pub total_profit: u128,
    pub slashes: u32,
    pub last_active_ledger: u32,
}

pub enum KeeperStatus {
    Active,
    Inactive,
    Cooldown,
}
```

### RegistryConfig

```rust
pub struct RegistryConfig {
    pub min_stake: u128,            // default: 100_0000000 (100 USDC, 7 decimals)
    pub leverage_factor: u32,       // default: 3
    pub cooldown_ledgers: u32,      // default: 17280 (~24 hours)
    pub timeout_ledgers: u32,       // default: 720 (~1 hour)
    pub slasher_bounty_bps: u32,    // default: 100 (1%)
}
```

### DataKey

```rust
pub enum DataKey {
    Admin,
    UsdcToken,
    Vault,
    Config,
    Keeper(Address),
    KeeperList,
}
```

### Error

```rust
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    NotAdmin = 3,
    NotVault = 4,
    NotKeeper = 5,
    AlreadyRegistered = 6,
    NotRegistered = 7,
    NotEnoughStake = 14,
    HasOutstandingDraw = 16,
    InCooldown = 17,
    CooldownNotExpired = 18,
    DrawTimeoutNotReached = 19,
    DrawCapExceeded = 23,
    NotInCooldown = 25,
}
```

Full table on [Error Codes](../../reference/error-codes).

## Events

```rust
RegisterEvent     { keeper, name, stake }
StakeAddEvent     { keeper, amount, total }
UnregisterEvent   { keeper, cooldown_until }
ClaimStakeEvent   { keeper, amount }
DrawEvent         { keeper, amount, outstanding }
ClearDrawEvent    { keeper, amount, outstanding }
ExecutionEvent    { keeper, profit, total_profit }
SlashEvent        { keeper, amount, reason: SlashReason }

enum SlashReason { Loss, Timeout, Fraud }
```

## Example: register via stellar CLI

```bash
stellar contract invoke \
  --id $REGISTRY_CONTRACT \
  --source $KEEPER_SECRET \
  --network testnet \
  -- \
  register \
  --keeper $KEEPER_ADDRESS \
  --name "my-keeper" \
  --stake 100_0000000
```

## Example: read keeper info

```bash
stellar contract invoke \
  --id $REGISTRY_CONTRACT \
  --network testnet \
  -- \
  get_keeper \
  --keeper $KEEPER_ADDRESS
```

Returns the JSON-encoded `KeeperInfo` struct.
