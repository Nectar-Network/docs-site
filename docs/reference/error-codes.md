---
title: Error Codes
description: Complete reference for every error returned by Nectar Network's Soroban contracts — KeeperRegistry, NectarVault, and the LiquidationLab test harness — with numeric codes, triggers, and resolutions.
---

# Error Codes

Every Nectar Network contract function returns a `Result<T, ContractError>`. When a
call fails, the contract host aborts the invocation and surfaces the error as a
numeric code. Tooling renders these differently depending on the layer:

- **`stellar` CLI / Horizon** — reports `Error(Contract, #N)`, where `N` is the
  numeric code from the tables below.
- **`@stellar/stellar-sdk` (frontend)** — the simulation or send result carries the
  contract error; the numeric code is in the diagnostic events.
- **`stellar/go` SDK (keeper daemon)** — the JSON-RPC `simulateTransaction` /
  `sendTransaction` response includes the host error with the contract code.

:::info Codes are per contract
The numeric code is only unique **within a single contract**. Code `5` means
`Unauthorized` in both KeeperRegistry and NectarVault, but the same number means
something different in the LiquidationLab test harness. Always pair a code with the
contract that produced it.
:::

The enums are defined in source and are authoritative:

- KeeperRegistry — `contracts/keeper-registry/src/types.rs` (`enum Error`)
- NectarVault — `contracts/nectar-vault/src/types.rs` (`enum VaultError`)
- LiquidationLab — `contracts/liquidation-lab/src/types.rs` (`enum LabError`)

Contract addresses referenced below (testnet, Tranche 1 hardened — current):

| Contract | Address |
| --- | --- |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |

:::note 7-decimal amounts
All USDC amounts in error conditions are denominated in stroops with 7-decimal
precision: `1 USDC = 10_000_000` stroops. On testnet, USDC is a mock Stellar Asset
Contract (`CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`); mainnet will
use Circle USDC (Tranche 3).
:::

---

## KeeperRegistry

Defined as `enum Error` in `contracts/keeper-registry/src/types.rs`:

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

| Code | Variant | Raised by | Trigger | Resolution |
| --- | --- | --- | --- | --- |
| 1 | `AlreadyInit` | `initialize` | The registry already has an admin stored — `initialize` was called a second time. | One-time setup only. Use `set_config` to change parameters; you cannot re-initialize a live contract. |
| 2 | `NotInit` | `register`, `deregister`, `slash`, `get_config`, `require_admin`, `require_vault` | Admin / config / vault address has not been stored yet — the contract was never initialized. | Run `initialize(admin, config, vault)` before any other call. Confirm you are targeting the current deployment, not a [deprecated address](./contract-addresses). |
| 3 | `AlreadyRegistered` | `register` | A `KeeperInfo` record already exists for this operator address. | The keeper is already registered. To change details, `deregister` first (refunds stake), then `register` again. |
| 4 | `NotRegistered` | `deregister`, `get_keeper`, `avg_response_time_ms`, `mark_draw`, `clear_draw`, `record_execution`, `slash` | No `KeeperInfo` exists for the supplied operator address. | Register the operator with `register(operator, name)` first. If the keeper was slashed or deregistered, re-register before drawing capital. |
| 5 | `Unauthorized` | `pause`, `unpause`, `set_config` (via `require_admin`); `mark_draw`, `clear_draw`, `record_execution` (via `require_vault`) | Caller is not the stored admin (for admin-only fns) or not the stored vault address (for vault-only fns). | Admin functions must be signed by the admin key (`GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W` on testnet). `mark_draw` / `clear_draw` / `record_execution` are called **only** by NectarVault — keepers must not call them directly. |
| 6 | `Paused` | `register` | The registry is paused (admin called `pause`). New registrations are blocked. | Wait for the admin to `unpause`. Existing keepers can still draw and return; only new registration is gated. |
| 7 | `InsufficientStake` | `register` | The configured `min_stake` is `<= 0`, so no valid stake can be pulled. | An admin must set a positive `min_stake` via `set_config`. Testnet default is `100` USDC (`1_000_000_000` stroops). Note: if the operator lacks the stake balance/allowance, the failure surfaces from the USDC token transfer, not this code. |
| 8 | `ActiveDraw` | `deregister` | The keeper has an outstanding draw (`has_active_draw == true`) and cannot exit while capital is borrowed. | Call `NectarVault.return_proceeds` to repay the draw (which clears the flag via `clear_draw`), then retry `deregister`. If the keeper has timed out, the admin can `slash` first. |
| 9 | `SlashTimeout` | `slash` | Either the keeper has no active draw, or `now - last_draw_time <= slash_timeout` (the grace window has not elapsed). | Slashing is only valid once a keeper holds an active draw **and** the timeout has passed. Testnet `slash_timeout` is `3600` s (1 h). Wait for the window to elapse, then retry. |

:::tip Stake math
The slash amount is `stake * slash_rate_bps / 10_000`. With the testnet
`slash_rate_bps = 1000` (10%), a `100` USDC stake yields a `10` USDC slash that is
transferred to the vault. `slash` returns the slashed amount and clears the active
draw flag.
:::

---

## NectarVault

Defined as `enum VaultError` in `contracts/nectar-vault/src/types.rs`:

```rust
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum VaultError {
    AlreadyInit = 1,
    NotInit = 2,
    InsufficientBalance = 3,
    InsufficientVault = 4,
    Unauthorized = 5,
    NoShares = 6,
    DepositCapExceeded = 8,
    WithdrawalCooldown = 9,
    DrawLimitExceeded = 10,
}
```

:::warning Code 7 is intentionally unused
`VaultError` skips `7` — there is no variant with that code. A returned
`Error(Contract, #7)` from the vault address indicates a version mismatch (wrong
contract, or a future build), not a known condition. Verify you are calling the
current deployment.
:::

| Code | Variant | Raised by | Trigger | Resolution |
| --- | --- | --- | --- | --- |
| 1 | `AlreadyInit` | `initialize` | The vault already has an admin stored. | One-time setup only. Use `set_config` to adjust parameters on a live vault. |
| 2 | `NotInit` | `deposit`, `withdraw`, `draw`, `return_proceeds`, `get_state`, `get_config`, `set_config`, and the internal registry helpers | The vault has not been initialized (no admin / state / config / USDC / registry stored). | Run `initialize(admin, usdc_token, registry, config)` first. Confirm the target address is the current vault, not a [deprecated deployment](./contract-addresses). |
| 3 | `InsufficientBalance` | `withdraw` | The requested `shares` exceed the depositor's own share balance. | Query your shares with `balance(user)` or `get_depositor(user)` and withdraw `<=` that amount. |
| 4 | `InsufficientVault` | `withdraw`, `draw` | `withdraw`: `total_shares == 0` (no liquidity to redeem). `draw`: requested `amount` exceeds available capital (`total_usdc - active_liq`). | For withdraw, wait until the pool holds shares. For draw, request `<=` the available (un-borrowed) balance; check `get_state` for `total_usdc` and `active_liq`. |
| 5 | `Unauthorized` | `set_config` | Caller is not the stored admin. | Sign `set_config` with the admin key. Depositor and keeper flows never need admin auth. |
| 6 | `NoShares` | `withdraw`, `get_depositor` | No `Depositor` record exists for this address (never deposited, or already fully withdrawn). | Make a deposit first, or query a depositor address that has an active position. |
| 8 | `DepositCapExceeded` | `deposit` | `deposit_cap > 0` and `total_usdc + amount` would exceed the cap. | Deposit a smaller amount, or wait until withdrawals free up headroom. Testnet `deposit_cap` is `10_000_000` USDC. A cap of `0` disables the check. |
| 9 | `WithdrawalCooldown` | `withdraw` | `now - last_deposit_time < withdraw_cooldown` — the cooldown since the **last deposit** has not elapsed. | Wait out the cooldown, then retry. Testnet `withdraw_cooldown` is `3600` s (1 h). Note any new deposit resets `last_deposit_time` and restarts the cooldown. |
| 10 | `DrawLimitExceeded` | `draw` | `max_draw_per_keeper > 0` and the requested `amount` exceeds the per-keeper cap. | Draw `<=` the cap per call, or split a large liquidation across multiple draws. Testnet `max_draw_per_keeper` is `10_000` USDC. A cap of `0` disables the check. |

:::info Cross-contract failures during `draw`
`draw` verifies the keeper against the registry (`get_keeper`) and then calls
`mark_draw` on the registry. `return_proceeds` calls `clear_draw` and
`record_execution`. If the registry rejects one of these — for example because the
keeper was deregistered or the registry address is stale — the failure propagates
from the registry as a [KeeperRegistry error](#keeperregistry) (commonly
`NotRegistered` / `Unauthorized`), aborting the whole vault invocation atomically.
:::

---

## LiquidationLab (test harness)

`LiquidationLab` is a local mock of a Blend pool used to simulate reserves,
positions, and Dutch auctions when exercising the keeper end to end. It is **not part
of the deployed protocol** — the production keeper monitors the real Blend pool
(`CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` on testnet). Its errors
appear only in local development and integration tests.

Defined as `enum LabError` in `contracts/liquidation-lab/src/types.rs`:

```rust
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum LabError {
    AlreadyInit = 1,
    NotInit = 2,
    Unauthorized = 3,
    AuctionNotFound = 4,
    AuctionExists = 5,
    ReserveNotFound = 6,
    PositionNotFound = 7,
}
```

| Code | Variant | Trigger | Resolution |
| --- | --- | --- | --- |
| 1 | `AlreadyInit` | The lab already has an admin stored. | Initialize once per deployment. |
| 2 | `NotInit` | The lab was never initialized. | Call `initialize(admin)` before seeding reserves, positions, or auctions. |
| 3 | `Unauthorized` | A privileged (admin-only) function was called by a non-admin. | Sign admin-only calls with the lab's admin key. |
| 4 | `AuctionNotFound` | An auction lookup / fill targeted a user with no active auction. | Create the auction first, or target a user that currently has one. |
| 5 | `AuctionExists` | Attempted to create an auction for a user that already has one. | Clear or fill the existing auction before creating a new one. |
| 6 | `ReserveNotFound` | A reserve operation referenced an unregistered asset. | Register the reserve (with `index`, `c_factor`, `l_factor`, `b_rate`, `d_rate`) first. |
| 7 | `PositionNotFound` | A position lookup targeted a user with no recorded `UserPositions`. | Seed the user's collateral / liabilities before querying or auctioning the position. |

:::note Not numerically aligned with the protocol contracts
LiquidationLab reuses low codes (`Unauthorized = 3`, not `5`). Never map a lab code
onto KeeperRegistry/NectarVault semantics — interpret it against the source address
that produced it.
:::

---

## Handling errors in the keeper

The Go keeper reads contract errors from the JSON-RPC simulation/send response. Match
on the contract address **and** the numeric code, then decide whether to retry,
back off, or surface the failure:

```go
// Pseudocode: branch on a NectarVault contract error code.
switch vaultErrCode {
case 4: // InsufficientVault — not enough free capital to draw
    slog.Warn("draw blocked: insufficient vault liquidity", "want", amount)
    return errSkipAuction // wait for the next cycle
case 9: // WithdrawalCooldown — depositor path, not keeper
    return errCooldown
case 10: // DrawLimitExceeded — split the draw
    slog.Warn("draw exceeds per-keeper cap", "cap", maxDrawPerKeeper)
    return errSplitDraw
default:
    return fmt.Errorf("vault error code %d", vaultErrCode)
}
```

:::tip Transient vs. terminal
Treat `InsufficientVault` (code 4) as **transient** — retry on the next polling cycle
once capital frees up. Treat `Unauthorized` (code 5) and `NotRegistered`
(KeeperRegistry code 4) as **terminal** for the keeper's identity — they will not
resolve by retrying; fix the keeper's registration or signing key. Pair this with the
keeper's exponential-backoff retry policy so transient conditions self-heal without
hammering the RPC.
:::

## Related references

- [Glossary](./glossary) — definitions for stake, draw, slash, share math, and Dutch auctions.
- [Deployed contracts](./contract-addresses) — current testnet addresses and deprecated deployments.
- [KeeperRegistry contract](../developers/contracts/keeper-registry) — function-by-function reference.
- [NectarVault contract](../developers/contracts/nectar-vault) — function-by-function reference.
