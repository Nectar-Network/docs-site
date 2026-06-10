---
title: Error Codes
description: Every contract error code with cause and fix
---

# Error Codes

Both contracts use a numeric `Error` enum. Codes are stable across releases — never reused, never renumbered. If you see one in a transaction failure, look it up here.

## KeeperRegistry

| Code | Name | Trigger |
|------|------|---------|
| 1 | `AlreadyInit` | `initialize` called twice |
| 2 | `NotInit` | Function called before `initialize` |
| 3 | `NotAdmin` | Admin-only function called by non-admin |
| 4 | `NotVault` | Vault-gated function called by a non-vault address |
| 5 | `NotKeeper` | Keeper-gated function called by a non-registered address |
| 6 | `AlreadyRegistered` | `register` called by an address already in the registry |
| 7 | `NotRegistered` | Function expects a registered keeper, none found |
| 14 | `NotEnoughStake` | `stake < min_stake` on `register` |
| 16 | `HasOutstandingDraw` | `unregister` called while a draw is open |
| 17 | `InCooldown` | Action requires `Active` status, keeper is `Cooldown` |
| 18 | `CooldownNotExpired` | `claim_stake` called before `cooldown_until_ledger` |
| 19 | `DrawTimeoutNotReached` | `slash_timeout` called before `draw_started_at + timeout_ledgers` |
| 23 | `DrawCapExceeded` | `mark_draw` would push `outstanding > stake * leverage_factor` |
| 25 | `NotInCooldown` | `claim_stake` called outside cooldown state |

## NectarVault

| Code | Name | Trigger |
|------|------|---------|
| 1 | `AlreadyInit` | `initialize` called twice |
| 2 | `NotInit` | Function called before `initialize` |
| 3 | `NotAdmin` | Admin-only function called by non-admin |
| 4 | `NotKeeper` | Keeper-gated function called by a non-registered address |
| 5 | `NotRegistry` | Function expects calls from the registry only |
| 10 | `Paused` | Function called while vault is paused |
| 11 | `ZeroAmount` | `amount == 0` on `deposit` / `draw` / `return_proceeds` |
| 12 | `CapExceeded` | Deposit would exceed `deposit_cap` |
| 13 | `BelowMinDeposit` | `amount < min_deposit` on `deposit` |
| 20 | `InsufficientShares` | Withdrawal exceeds depositor's share balance |
| 21 | `InsufficientLiquidity` | Vault free balance < requested amount |
| 22 | `PendingWithdrawal` | `request_withdraw` called when one is already open |
| 23 | `NotClaimable` | `claim_withdraw` called before `claimable_at` |
| 30 | `NoOutstandingDraw` | `cancel_draw` / `return_proceeds` with no in-flight draw |

## How errors surface

In a Soroban transaction result, contract errors appear as:

```
HostError: Contract { contract: C..., error: <code> }
```

In the keeper logs (Go), they're decoded to the name:

```
ERROR draw failed code=23 name=DrawCapExceeded
```

In the SDK, they map to typed Go errors:

```go
err := client.Vault.Draw(ctx, amount)
if errors.Is(err, nectar.ErrDrawCapExceeded) {
    // handle
}
```

## Reporting unknown errors

If you hit a code not listed here, the deployed contract may be a newer release than these docs. Check the source `enum Error` in the contract you're calling:

- [`contracts/registry/src/error.rs`](https://github.com/Nectar-Network/nectar-poc/tree/main/contracts/registry/src/error.rs)
- [`contracts/vault/src/error.rs`](https://github.com/Nectar-Network/nectar-poc/tree/main/contracts/vault/src/error.rs)

Then open a docs PR adding the new code to this table.
