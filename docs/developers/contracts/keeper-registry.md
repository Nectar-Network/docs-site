---
title: KeeperRegistry Contract
description: Full reference for the Nectar KeeperRegistry Soroban contract — every public function, the KeeperInfo struct, staking, performance tracking, slashing, storage model, error variants, and the deployed testnet address.
---

# KeeperRegistry Contract

`KeeperRegistry` is the on-chain operator registry for Nectar Network. It records every keeper operator, escrows their USDC stake, tracks per-keeper performance (execution count, success rate, profit, response time), and enforces slashing when a keeper draws vault capital but fails to return it within a timeout.

The [NectarVault](./nectar-vault) contract treats `KeeperRegistry` as its source of truth: before allowing a `draw()`, the vault verifies the caller is a registered keeper, and on draw/return it calls back into the registry to mark draws, clear them, and record execution outcomes.

:::info Contract facts
- **Language / SDK:** Rust, `soroban-sdk` 22.x, `#![no_std]`
- **Precision:** all USDC amounts are `i128` in 7-decimal stroops — `1 USDC = 10_000_000`
- **Build:** `cargo build --target wasm32-unknown-unknown --release`
- **Source:** `contracts/keeper-registry/src/` (`lib.rs`, `types.rs`, `test.rs`)
:::

## Deployed addresses (Testnet)

These are the **current** Tranche-1-hardened testnet deployments. Always confirm against `wallets.md` in the main repo before scripting against them.

| Entity | Address |
| --- | --- |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| Admin (deployer) | `GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W` |

Live registry configuration on this deployment:

| Parameter | Value |
| --- | --- |
| `min_stake` | 100 USDC (`1_000_000_000` stroops) |
| `slash_timeout` | 3600 s (1 hour) |
| `slash_rate_bps` | 1000 (10%) |
| `usdc_token` | the mock SAC above |

:::note Testnet vs mainnet USDC
On testnet, USDC is a mock Stellar Asset Contract (`name="USD Coin"`, `symbol="USDC"`, `decimals=7`) administered by the deployer. Mainnet (Tranche 3) will point `usdc_token` at the canonical Circle USDC issuer's SAC. The 7-decimal precision is identical in both environments.
:::

## Data types

### `KeeperInfo`

The persistent record for one operator. Returned by [`get_keeper`](#get_keeper).

```rust
#[contracttype]
#[derive(Clone, Debug)]
pub struct KeeperInfo {
    pub addr: Address,              // operator account
    pub name: String,              // human-readable label, e.g. "keeper-alpha"
    pub stake: i128,               // current escrowed USDC stake (stroops)
    pub registered_at: u64,        // ledger timestamp at registration
    pub active: bool,              // always true while the record exists
    pub total_executions: u64,     // count of recorded fill attempts (success + failure)
    pub successful_fills: u64,     // count of successful fills
    pub total_profit: i128,        // cumulative profit from successful fills (stroops)
    pub last_draw_time: u64,       // ledger timestamp of the most recent draw
    pub has_active_draw: bool,     // true between mark_draw and clear_draw/slash
    pub total_response_time_ms: u64, // sum of response times over successful fills
    pub response_count: u64,       // number of fills contributing to response time
}
```

:::tip Derived metrics
The contract stores raw counters and computes averages on read.

- **Success rate** = `successful_fills / total_executions`
- **Average response time** = `total_response_time_ms / response_count`, exposed directly by [`avg_response_time_ms`](#avg_response_time_ms)

Only **successful** fills contribute to `total_profit`, `total_response_time_ms`, and `response_count`. A failed execution increments `total_executions` only.
:::

### `RegistryConfig`

Set at [`initialize`](#initialize) and mutable by the admin via [`set_config`](#set_config).

```rust
#[contracttype]
#[derive(Clone, Debug)]
pub struct RegistryConfig {
    pub min_stake: i128,      // required USDC stake per keeper (stroops); must be > 0
    pub slash_timeout: u64,   // seconds a draw may stay open before it is slashable
    pub slash_rate_bps: u32,  // fraction of stake slashed, in basis points (1000 = 10%)
    pub usdc_token: Address,  // SAC used for stake escrow and slash transfers
}
```

### `DataKey`

The storage key enum. See [Storage model](#storage-model) for which keys live in instance vs persistent storage.

```rust
#[contracttype]
pub enum DataKey {
    Admin,             // instance: admin Address
    KeeperCount,       // instance: u32
    Keeper(Address),   // persistent: KeeperInfo, keyed by operator
    KeeperList,        // persistent: Vec<Address> of all registered operators
    Paused,            // instance: bool flag; absent == not paused
    Config,            // instance: RegistryConfig
    VaultAddr,         // instance: authorized NectarVault Address
}
```

## Public functions

All functions take `env: Env` as the first parameter (omitted from the prose below). Mutating functions return `Result<(), Error>` unless noted; read functions return their value directly or a `Result`.

### `initialize`

```rust
pub fn initialize(
    env: Env,
    admin: Address,
    config: RegistryConfig,
    vault: Address,
) -> Result<(), Error>
```

- **Auth:** none enforced (one-shot; protected by the already-initialized guard).
- **Params:** `admin` — the account allowed to pause/unpause and change config; `config` — the initial [`RegistryConfig`](#registryconfig); `vault` — the [NectarVault](./nectar-vault) address authorized to call the vault-only hooks.
- **Behavior:** sets `Admin`, `KeeperCount = 0`, `Config`, and `VaultAddr` in instance storage, then extends the instance TTL.
- **Errors:** `AlreadyInit` if the registry already has an admin.

### `register`

```rust
pub fn register(env: Env, operator: Address, name: String) -> Result<(), Error>
```

- **Auth:** `operator.require_auth()`.
- **Behavior:** registers `operator` and **escrows `config.min_stake` USDC** from the operator into the registry contract via a SAC `transfer`. Creates a fresh [`KeeperInfo`](#keeperinfo) (`stake = min_stake`, `active = true`, all counters zero), appends the operator to `KeeperList`, increments `KeeperCount`, and publishes a `registered` event `(name, min_stake, timestamp)`.
- **Errors:**
  - `NotInit` — registry not initialized.
  - `Paused` — registrations are paused.
  - `AlreadyRegistered` — `operator` already has a record.
  - `InsufficientStake` — `config.min_stake <= 0` (a misconfigured registry).

:::warning Stake transfer must succeed
The USDC `transfer` pulls `min_stake` from the operator. If the operator's balance is below `min_stake`, the SAC transfer itself traps and the whole `register` reverts — no `KeeperInfo` is written. The operator must hold at least `min_stake` USDC and have authorized the transfer before calling `register`.
:::

### `deregister`

```rust
pub fn deregister(env: Env, operator: Address) -> Result<(), Error>
```

- **Auth:** `operator.require_auth()`.
- **Behavior:** **refunds the full remaining `stake`** back to the operator (when `stake > 0`), removes the `Keeper(operator)` record, drops the operator from `KeeperList`, decrements `KeeperCount` (saturating), and publishes a `deregistered` event `(stake, timestamp)`.
- **Errors:**
  - `NotInit` — registry not initialized.
  - `NotRegistered` — no record for `operator`.
  - `ActiveDraw` — `has_active_draw` is true; the keeper must return outstanding vault capital (triggering `clear_draw`) before deregistering.

### `get_keeper`

```rust
pub fn get_keeper(env: Env, operator: Address) -> Result<KeeperInfo, Error>
```

- **Auth:** none (read-only).
- **Behavior:** returns the operator's [`KeeperInfo`](#keeperinfo).
- **Errors:** `NotRegistered` if absent.

This is the function the vault invokes to confirm a keeper is registered before a draw, and the keeper daemon's `IsRegistered` check calls it (treating a `NotRegistered` error as "not registered").

### `avg_response_time_ms`

```rust
pub fn avg_response_time_ms(env: Env, operator: Address) -> Result<u64, Error>
```

- **Auth:** none (read-only).
- **Behavior:** returns `total_response_time_ms / response_count`, or `0` when `response_count == 0`.
- **Errors:** `NotRegistered` if absent.

### `get_keepers`

```rust
pub fn get_keepers(env: Env) -> Vec<Address>
```

- **Auth:** none (read-only).
- **Behavior:** returns the full list of registered operator addresses, or an empty `Vec` if none.

### `keeper_count`

```rust
pub fn keeper_count(env: Env) -> u32
```

- **Auth:** none (read-only).
- **Behavior:** returns the current registered-keeper count from instance storage (`0` if unset).

### `pause`

```rust
pub fn pause(env: Env, admin: Address) -> Result<(), Error>
```

- **Auth:** admin only (`require_admin`: caller must equal stored `Admin`, then `require_auth()`).
- **Behavior:** sets the `Paused` flag, blocking new [`register`](#register) calls. Existing keepers, draws, and slashing are unaffected.
- **Errors:** `NotInit`, `Unauthorized`.

### `unpause`

```rust
pub fn unpause(env: Env, admin: Address) -> Result<(), Error>
```

- **Auth:** admin only.
- **Behavior:** removes the `Paused` flag, re-enabling registrations.
- **Errors:** `NotInit`, `Unauthorized`.

### `mark_draw`

```rust
pub fn mark_draw(env: Env, caller: Address, keeper: Address) -> Result<(), Error>
```

- **Auth:** vault only (`require_vault`: `caller` must equal stored `VaultAddr`, then `caller.require_auth()`).
- **Behavior:** sets `has_active_draw = true` and `last_draw_time = now` on the keeper's record, then publishes a `draw_marked` event with the timestamp. Called by the vault inside `draw()`.
- **Errors:** `NotInit`, `Unauthorized`, `NotRegistered`.

### `clear_draw`

```rust
pub fn clear_draw(env: Env, caller: Address, keeper: Address) -> Result<(), Error>
```

- **Auth:** vault only.
- **Behavior:** sets `has_active_draw = false` and publishes a `draw_cleared` event. Called by the vault when a keeper returns the drawn capital.
- **Errors:** `NotInit`, `Unauthorized`, `NotRegistered`.

### `record_execution`

```rust
pub fn record_execution(
    env: Env,
    caller: Address,
    keeper: Address,
    success: bool,
    profit: i128,
    response_time_ms: u64,
) -> Result<(), Error>
```

- **Auth:** vault only.
- **Behavior:** increments `total_executions` (saturating). When `success` is true, also increments `successful_fills`, adds `profit` to `total_profit`, adds `response_time_ms` to `total_response_time_ms`, and increments `response_count` — all saturating. Publishes an `execution` event `(success, profit, total_executions, response_time_ms)`. Called by the vault on a successful repay.
- **Errors:** `NotInit`, `Unauthorized`, `NotRegistered`.

:::note Failures do not pollute performance stats
A `success = false` record bumps `total_executions` only. Profit, response-time sum, and response count are untouched, so `avg_response_time_ms` and `total_profit` reflect only completed fills.
:::

### `slash`

```rust
pub fn slash(env: Env, keeper: Address) -> Result<i128, Error>
```

- **Auth:** none enforced — slashing is **permissionless** and gated entirely by the timeout condition. Anyone (typically a watchdog or another keeper) may trigger it once a draw has gone stale.
- **Behavior:** if the keeper has an active draw that has been open longer than `config.slash_timeout`, transfers `slash_amt = stake * slash_rate_bps / 10_000` USDC from the registry to the **vault**, decrements the keeper's `stake` by that amount, clears `has_active_draw`, and publishes a `slashed` event `(slash_amt, remaining_stake)`. Returns the slashed amount.
- **Returns:** `i128` — the USDC amount slashed (stroops).
- **Errors:**
  - `NotInit` — config or vault address missing.
  - `NotRegistered` — no record for `keeper`.
  - `SlashTimeout` — either there is **no active draw**, or `now - last_draw_time <= slash_timeout` (the grace window has not elapsed). Both conditions surface as `SlashTimeout`.

:::danger Slash proceeds go to the vault, not the caller
Slashed stake is transferred to the configured `VaultAddr`, returning capital to depositors rather than rewarding the slash caller. The slash amount is a fraction of remaining stake, so repeated slashing of the same stale draw is not possible — `slash` clears `has_active_draw` on success.
:::

### `set_config`

```rust
pub fn set_config(env: Env, admin: Address, config: RegistryConfig) -> Result<(), Error>
```

- **Auth:** admin only.
- **Behavior:** overwrites the stored [`RegistryConfig`](#registryconfig). Affects future registrations and slashing math; does not retroactively change already-escrowed stakes.
- **Errors:** `NotInit`, `Unauthorized`.

### `get_config`

```rust
pub fn get_config(env: Env) -> Result<RegistryConfig, Error>
```

- **Auth:** none (read-only).
- **Behavior:** returns the current [`RegistryConfig`](#registryconfig).
- **Errors:** `NotInit`.

## Staking, performance, and slashing lifecycle

The registry models a keeper's full lifecycle around its escrowed stake and a single in-flight draw flag.

```
register ──> (stake escrowed, KeeperInfo created)
   │
   ├── vault draw()  ──> mark_draw         (has_active_draw = true, last_draw_time = now)
   │                         │
   │         ┌───────────────┴───────────────┐
   │         │                               │
   │   keeper returns capital          draw stays open past slash_timeout
   │         │                               │
   │   vault repay() ──> clear_draw      anyone ──> slash
   │                 └─> record_execution     (stake -= stake*bps/10_000 → vault,
   │                     (counters updated)    has_active_draw = false)
   │
deregister ──> (stake refunded, record + list entry removed)
```

- **Staking.** Stake is escrowed on `register` and refunded on `deregister`. While `has_active_draw` is true, `deregister` is blocked (`ActiveDraw`).
- **Performance tracking.** `mark_draw`/`clear_draw`/`record_execution` are driven exclusively by the vault. Stats are append-only saturating counters; reads compute success rate and average response time.
- **Slashing.** A draw that exceeds `slash_timeout` becomes permissionlessly slashable. The penalty is `slash_rate_bps` of remaining stake, paid to the vault.

## Storage model

| Key | Storage | Type | Notes |
| --- | --- | --- | --- |
| `Admin` | instance | `Address` | governance account |
| `Config` | instance | `RegistryConfig` | registry parameters |
| `VaultAddr` | instance | `Address` | authorized caller for vault-only hooks |
| `KeeperCount` | instance | `u32` | live registered count |
| `Paused` | instance | `bool` | absent means not paused |
| `Keeper(addr)` | persistent | `KeeperInfo` | one entry per operator |
| `KeeperList` | persistent | `Vec<Address>` | enumeration of operators |

:::info TTL management
Every entry point extends the **instance** TTL by `1000` ledgers. Writes to `Keeper(addr)` and `KeeperList` extend their **persistent** TTL by `535_680` ledgers (roughly 31 days at ~5 s/ledger), so active keeper records stay alive across normal operation. Config and admin data live in instance storage and ride the instance TTL.
:::

## Error reference

```rust
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    AlreadyInit = 1,
    NotInit = 2,
    AlreadyRegistered = 3,
    NotRegistered = 4,
    Unauthorized = 5,
    Paused = 6,
    InsufficientStake = 7,
    ActiveDraw = 8,
    SlashTimeout = 9,
}
```

| Code | Variant | Raised by | Meaning |
| --- | --- | --- | --- |
| 1 | `AlreadyInit` | `initialize` | registry already has an admin |
| 2 | `NotInit` | most fns | registry not initialized / required key missing |
| 3 | `AlreadyRegistered` | `register` | operator already has a record |
| 4 | `NotRegistered` | reads, draw/exec hooks | no record for the given operator |
| 5 | `Unauthorized` | admin/vault-gated fns | caller is not the admin / not the vault |
| 6 | `Paused` | `register` | registrations are paused |
| 7 | `InsufficientStake` | `register` | `config.min_stake <= 0` |
| 8 | `ActiveDraw` | `deregister` | keeper has an open draw |
| 9 | `SlashTimeout` | `slash` | no active draw, or timeout not yet elapsed |

## Cross-contract integration

The [NectarVault](./nectar-vault) is the only authorized caller of the vault-only hooks. It invokes the registry by symbol, passing **its own address as `caller`** so `require_vault` succeeds:

- On `draw()`, the vault calls `get_keeper` (existence check) and `mark_draw`.
- On a successful repay, the vault calls `clear_draw` and `record_execution`.

```rust
// From contracts/nectar-vault/src/lib.rs — vault → registry call shape
let vault = env.current_contract_address();
let _: soroban_sdk::Val = env.invoke_contract(
    &registry,
    &Symbol::new(env, fn_name), // "mark_draw" | "clear_draw"
    vec![env, vault.into_val(env), keeper.into_val(env)],
);
```

The off-chain keeper daemon (Go) registers and checks status through the registry too — see the [Keeper daemon](../architecture) docs and the [keeper-sdk](../keeper-sdk). Its registry client maps contract errors back to booleans:

```go
// keeper/registry/client.go — register, treating AlreadyRegistered as success
_, err = rpc.InvokeWithRetry(horizonURL, kp, passphrase, registryAddr, "register",
    soroban.DefaultRetry(), operatorVal, nameVal)
if err != nil {
    if isAlreadyRegistered(err.Error()) {
        return nil
    }
    return fmt.Errorf("registry register: %w", err)
}
```

## Calling from the CLI

Read the live config on testnet:

```bash
stellar contract invoke \
  --id CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB \
  --source $ADMIN_SECRET \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- get_config
```

Inspect a registered keeper:

```bash
stellar contract invoke \
  --id CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB \
  --source $ADMIN_SECRET \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- get_keeper \
  --operator GCC52N6U63PWM4GVUJK7T54W3X2GW2YKWOLZWN7TX7LMDU6LCOVZ3YVF
```

:::tip Stake before you register
`register` requires the operator to already hold at least `min_stake` USDC (100 USDC on testnet) and authorize the SAC transfer. Fund the operator account and approve the transfer in the same transaction the wallet builds, or the registration reverts.
:::

## See also

- [NectarVault Contract](./nectar-vault) — capital pool, draws, and the contract that drives the registry's draw/exec hooks.
- [Glossary](../../reference/glossary) — definitions for stake, slashing, health factor, and Dutch auctions.
