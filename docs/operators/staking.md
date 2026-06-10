---
title: Staking & Slashing
description: Why keepers stake, how performance is tracked on-chain, when stake is slashed, and how to withdraw it.
---

# Staking & Slashing

A keeper's stake is its skin in the game. To register, an operator locks USDC into the `KeeperRegistry` contract. That stake is what a draw timeout slashes against, so the protocol can punish a keeper that draws vault capital and never returns it. The same registry record also accumulates the keeper's performance — execution count, success rate, average response time — which feeds the [keeper leaderboard](https://nectarnetwork.fun/dashboard/keepers).

:::info
On testnet, USDC is a mock Stellar Asset Contract (SAC). Mainnet will use Circle USDC, shipping in Tranche 3. All amounts are `i128` at 7-decimal precision: **1 USDC = 10,000,000 stroops**. So the testnet `min_stake` of 100 USDC is stored as `1000000000`.
:::

## Why stake at all

The keeper draw/return cycle is trust-minimized but not trustless: the vault hands a keeper real USDC (`draw`) and trusts it to come back with that capital plus profit (`return_proceeds`). Stake is the bond that makes that trust enforceable.

- **It bounds keeper misbehavior.** If a keeper draws and disappears, anyone can call `slash` once the timeout elapses, and the slashed stake is transferred to the vault — so depositors are partly compensated for the stuck capital.
- **It gates registration.** Only an operator willing to lock `min_stake` can register and start drawing. There is no way to draw vault capital without first being a registered, staked keeper.
- **It anchors the leaderboard.** Stake bonded is one of the columns surfaced on the dashboard alongside executions, win rate, and profit.

## Registering and the stake amount

You stake by registering. There is no separate "stake" step and **no stake-amount argument** — `register` always pulls exactly the registry's configured `min_stake`:

```rust
pub fn register(env: Env, operator: Address, name: String) -> Result<(), Error>
```

When called, the registry:

1. Requires the registry to be initialized (`NotInit` otherwise) and not paused (`Paused` otherwise).
2. Requires `operator.require_auth()` — the operator must sign.
3. Rejects a second registration of the same address with `AlreadyRegistered`.
4. Transfers `min_stake` USDC from the operator into the registry contract, then writes a `KeeperInfo` record with `stake = min_stake`, `active = true`, and all performance counters zeroed.

The keeper binary calls `register` for you on first run, so you normally never invoke it by hand. To do it manually with the Stellar CLI:

```bash
stellar contract invoke \
  --id CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB \
  --source $KEEPER_SECRET \
  --network testnet \
  -- \
  register \
  --operator $KEEPER_ADDRESS \
  --name "my-keeper"
```

:::warning
You must hold at least `min_stake` USDC **before** registering. The stake transfer is a raw token transfer — if your balance is short, the call fails as a host error (the token contract panics), not as a typed contract error, and you are left unregistered. Fund the keeper with USDC first; see [Keeper Setup](./setup).
:::

### Current testnet parameters

The registry is initialized with a `RegistryConfig`. These are the live testnet values (the admin can change them with `set_config`; read the current values on-chain with `get_config`):

| Parameter | Value (testnet) | Stroops | Meaning |
|-----------|-----------------|---------|---------|
| `min_stake` | 100 USDC | `1000000000` | USDC pulled on `register`; the full stake amount |
| `slash_timeout` | 3600 s (1 hour) | — | A draw open longer than this becomes slashable |
| `slash_rate_bps` | 1000 (10%) | — | Fraction of stake slashed per timeout |
| `usdc_token` | mock SAC | — | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |

The registry contract on testnet is `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB`. See the [contract reference](../developers/contracts/keeper-registry) for the full interface.

:::note
The stake is **fixed at `min_stake`** — the registry does not support topping up or staking a variable amount. The per-draw size limit is a separate setting, `max_draw_per_keeper` (10,000 USDC on testnet), enforced by the [NectarVault](../developers/contracts/nectar-vault) on each `draw`, not by your stake.
:::

## Performance tracking

The vault records every draw/return outcome against your registry record via `record_execution` (a vault-only call you never make directly). Each `KeeperInfo` carries:

| Field | What it counts |
|-------|----------------|
| `total_executions` | Every execution, success or failure |
| `successful_fills` | Successful fills only |
| `total_profit` | Sum of realized profit (`proceeds − drawn`), successes only |
| `total_response_time_ms` | Sum of observed draw→fill→return latency, successes only |
| `response_count` | Number of latency samples, successes only |

From these the dashboard derives the metrics operators care about:

- **Success rate** = `successful_fills / total_executions`.
- **Average response time** via the read-only view:

  ```rust
  pub fn avg_response_time_ms(env: Env, operator: Address) -> Result<u64, Error>
  ```

  It returns `total_response_time_ms / response_count` (integer division), or `0` when there are no successful samples yet.

:::tip
A **failed** execution increments `total_executions` only — it does **not** touch `total_profit`, `total_response_time_ms`, or `response_count`. So your average response time reflects only fills you actually completed, and a losing race that returns `ErrAlreadyFilled` won't drag your latency stat down — but it does lower your success rate.
:::

The `response_time_ms` value is observed by the keeper itself (draw → fill → return wall-clock) and forwarded to the vault on `return_proceeds`; the registry stores whatever the vault passes through.

## When stake is slashed

There is exactly **one** slash condition in the contract: a **draw timeout**. If your keeper draws capital and an hour passes without a matching `return_proceeds`, the open draw becomes slashable.

```rust
pub fn slash(env: Env, keeper: Address) -> Result<i128, Error>
```

Key properties, straight from the contract:

- **Permissionless.** `slash` takes no auth — *anyone* can call it on your address once the conditions are met. There is no slasher bounty; the entire slashed amount goes to the vault.
- **Requires an open draw.** If `has_active_draw` is false, it reverts with `SlashTimeout` — a keeper with no outstanding draw can never be slashed.
- **Requires the timeout to be exceeded.** It reverts with `SlashTimeout` unless `now − last_draw_time` is **strictly greater than** `slash_timeout`. At exactly `last_draw_time + 3600`, slashing is still rejected; one second later it is allowed.
- **Slashes a fraction, not the whole stake.** The amount is `stake × slash_rate_bps / 10000` = 10% of current stake on testnet. With a 100 USDC stake, one timeout slashes 10 USDC and your stake drops to 90 USDC. The slashed USDC is transferred to the vault address, and `has_active_draw` is cleared.

So a single timeout is not fatal — it costs 10% of your bonded stake and clears the stuck-draw flag. Repeated timeouts compound (each slashes 10% of the *current*, already-reduced stake).

:::danger
A draw with **zero returnable proceeds** is the classic slash trigger: you draw to fill an auction, the fill or the follow-up `return_proceeds` fails, and the capital sits drawn. The keeper's own **stale-draw recovery** runs at the top of every cycle to return drawn-but-unspent USDC and avoid exactly this — but it only works if `USDC_CONTRACT` is configured and the keeper actually has USDC on hand. If it logs `outstanding vault draw but no USDC on hand`, recover manually before the hour is up. See [Troubleshooting](./troubleshooting).
:::

Loss-on-fill, fraud reports, and oracle-based auto-pause are **not** slash conditions in the current contract. The only thing that costs you stake today is leaving a draw open past `slash_timeout`.

## Withdrawing your stake

To exit and recover your bonded USDC, deregister:

```rust
pub fn deregister(env: Env, operator: Address) -> Result<(), Error>
```

Behavior:

1. Requires `operator.require_auth()`.
2. Reverts with `NotRegistered` if you have no keeper record.
3. Reverts with `ActiveDraw` if `has_active_draw` is true — **you cannot deregister with capital still drawn**. Return the proceeds (or wait for stale-draw recovery to clear it) first.
4. Refunds your **full current `stake`** to your operator address. If you were slashed earlier, you get back the post-slash amount (e.g. 90 USDC after one timeout slash, not the original 100).
5. Removes your record from the registry and drops the keeper count.

There is **no cooldown** on stake withdrawal — once no draw is open, `deregister` refunds immediately in the same transaction. Via the CLI:

```bash
stellar contract invoke \
  --id CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB \
  --source $KEEPER_SECRET \
  --network testnet \
  -- \
  deregister \
  --operator $KEEPER_ADDRESS
```

You can also deregister from the **Keeper operator panel** on the [vault page](https://nectarnetwork.fun/vault) with a connected wallet.

:::warning
After deregistering you are gone from the registry: your performance history (`successful_fills`, `total_profit`, response-time stats) is deleted with the record. Re-registering starts you over from a zeroed `KeeperInfo` and pulls a fresh `min_stake`.
:::

## Operational checklist

- Hold at least `min_stake` USDC **and** a buffer of XLM for fees before your first run — registration fails without the stake, and you'll need XLM to draw/fill afterward.
- Never let a draw sit open. The whole slashing surface is the draw timeout; keep `return_proceeds` (or stale-draw recovery) healthy so `has_active_draw` clears well inside the hour.
- Set `USDC_CONTRACT` so stale-draw recovery is active — see [Configuration](./configuration).
- Watch your success rate, not just executions. Failed executions still increment `total_executions` and pull down the win rate shown on the leaderboard.
- Before exiting, confirm `get_keeper` shows `has_active_draw = false`, then `deregister` to reclaim your (possibly slashed) stake.

## Reference

- [KeeperRegistry contract interface](../developers/contracts/keeper-registry)
- [NectarVault contract interface](../developers/contracts/nectar-vault) — draws and `max_draw_per_keeper`
- [Configuration](./configuration) and [Troubleshooting](./troubleshooting)
- [Glossary](../reference/glossary) — stake, slashing, draw, timeout
