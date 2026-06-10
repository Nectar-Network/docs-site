---
title: Blend Integration
description: How Nectar keepers liquidate Blend Protocol positions
---

# Blend Integration

Nectar's only shipped adapter is for [Blend Protocol](https://blend.capital), the dominant lending protocol on Soroban. This page documents the integration in enough detail to debug a fill or audit the math.

Source: [`keeper/pkg/blend`](https://github.com/Nectar-Network/nectar-poc/tree/main/keeper/pkg/blend) in the protocol repo. Blend's own contracts live at [`blend-capital/blend-contracts-v2`](https://github.com/blend-capital/blend-contracts-v2).

## How Nectar talks to Blend

The keeper does **not** use a Blend Go SDK (none is published). Instead it builds raw Soroban `submit()` invocations and signs them with the keeper's keypair. All interaction is read-only RPC simulate or single-transaction submit. There is no off-chain data feed.

## Pool state read

```
get_pool_data(pool_id) -> PoolData
list_positions(pool_id) -> [UserPosition]
get_reserves(pool_id) -> [Reserve]
```

The keeper caches `Reserve` data per cycle (interest rates change every ledger but the asset list is stable). For `UserPosition`, the keeper iterates all known borrowers in the pool — at current testnet scale (~hundreds of borrowers per pool) this fits comfortably in a single poll cycle.

## Health factor

Blend uses a per-asset collateral factor (`c_factor`) and liability factor (`l_factor`). For a user with positions across several assets:

```
collateral_value = Σ (collateral_amount_i * price_i * c_factor_i)
liability_value  = Σ (liability_amount_i * price_i / l_factor_i)
HF = collateral_value / liability_value
```

`HF < 1` means the position is underwater and an auction is created (or active).

## Auction mechanics

A Blend auction is **Dutch-style** over 400 ledgers (~33 minutes). Two phases:

1. **Lot phase (ledgers 0–200).** Lot scales from 0% to 100% of seizable collateral; bid stays at 100% of debt.
2. **Bid phase (ledgers 200–400).** Lot stays at 100%; bid scales from 100% down to 0% of debt.

A keeper picks a fill ledger such that `lot_value > bid_value` by enough margin to cover gas and DEX slippage.

The fill ledger is computed:

```
ledger_offset = current_ledger - auction_start_ledger
if ledger_offset <= 200:
    lot_factor = ledger_offset / 200
    bid_factor = 1.0
else:
    lot_factor = 1.0
    bid_factor = (400 - ledger_offset) / 200

lot_value = lot_factor * Σ (collateral_amount_i * price_i)
bid_value = bid_factor * Σ (liability_amount_i * price_i)
profit_ratio = lot_value / bid_value
```

A keeper waits until `profit_ratio >= MIN_PROFIT` and then submits.

## The submit call

A Nectar fill is a single Soroban transaction with two operations:

```
submit(
    from = keeper,
    spender = keeper,
    to = keeper,
    requests = [
        Request {
            request_type: SupplyCollateral,
            address: USDC,
            amount: bid_amount,
        },
        Request {
            request_type: FillAuction,
            address: liquidating_user,
            amount: 100,  // 100% fill
        },
    ],
)
```

`SupplyCollateral` puts USDC into Blend, repaying the borrower's debt. `FillAuction` accepts the auction lot and transfers it to the keeper. Atomic: both succeed or both revert.

:::tip
Blend's `Request` API supports partial fills (`amount: 50` for a half-fill). The default Nectar adapter always fills 100% — partial-fill strategy is on the roadmap as an opt-in.
:::

## Profitability formula

The keeper rejects fills where:

```
expected_proceeds_usdc < bid_amount * MIN_PROFIT + max_slippage + gas_estimate
```

`expected_proceeds_usdc` is the simulated DEX output for selling the lot. `gas_estimate` is the simulated transaction fee in USDC equivalent (typically negligible at < $0.001).

## Race handling

When two keepers race the same auction:

- Both call `vault.draw` — both succeed, vault tracks both outstanding draws.
- Both call `submit` — only one lands; the other gets `auction_already_filled`.
- The losing keeper calls `vault.cancel_draw` to return the principal cleanly.

If a keeper fails to call `cancel_draw` (e.g. process crashes), the draw remains outstanding until the registry timeout slashes it. To avoid this, the keeper wraps the submit in a `defer` block that always either returns proceeds or cancels.

## Common error responses

| Error | Cause | Fix |
|-------|-------|-----|
| `auction_already_filled` | Another keeper won the race | Call `cancel_draw`, continue |
| `auction_expired` | Past 400 ledgers | Auction is gone, no action |
| `insufficient_supply` | Bid exceeds debt outstanding | Reduce bid amount |
| `oracle_stale` | Reflector price is stale | Wait, retry next cycle |
| `tx_internal_error` (after simulate ok) | Simulate / submit gap state change | Retry once, then skip |

## Reading the source

The hot path lives in three files:

- [`pkg/blend/pool.go`](https://github.com/Nectar-Network/nectar-poc/tree/main/keeper/pkg/blend/pool.go) — pool state, position decoding
- [`pkg/blend/auction.go`](https://github.com/Nectar-Network/nectar-poc/tree/main/keeper/pkg/blend/auction.go) — Dutch curve math, profitability
- [`pkg/blend/fill.go`](https://github.com/Nectar-Network/nectar-poc/tree/main/keeper/pkg/blend/fill.go) — submit construction, error handling

Total ~600 lines of Go. Read it before writing your own fork.
