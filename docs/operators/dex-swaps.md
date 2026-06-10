---
title: DEX Swaps (Soroswap & Phoenix)
description: How a Nectar keeper converts seized Blend collateral into USDC — Soroswap primary with a Phoenix fallback, oracle-anchored slippage via SLIPPAGE_BPS, and balance-delta proceeds accounting.
---

# DEX Swaps (Soroswap & Phoenix)

When a keeper wins a Blend liquidation auction, it does not receive USDC — it receives the position's **collateral** (XLM or whatever reserve assets backed the loan). The vault, however, accounts in USDC: it tracks `total_usdc`, mints shares against USDC, and books profit as `proceeds − drawn`. So before a keeper can return capital, it has to **sell the collateral for USDC**. That conversion is the job of the keeper's `dex` package, added in Tranche 2.

This page documents exactly how that swap is performed, priced, and accounted — from the code in `keeper/dex/`.

:::info All amounts are 7-decimal stroops
Every value here is an `i128` at 7-decimal precision: **1 USDC = 10,000,000 stroops**. The DEX client works in stroops; quotes, floors, and balance deltas are all stroop integers.
:::

## Why collateral is swapped to USDC

The full liquidation loop is:

> **fill auction → receive collateral → swap to USDC → return proceeds**

The `dex` package closes the last two steps. Its design principle, stated in the package doc, is that **output is measured by the keeper's USDC balance delta, never synthesized** — so the proceeds reported to the vault are always real USDC that actually arrived in the keeper account.

If the collateral is *already* USDC (some Blend reserves are USDC), no swap happens — that amount counts directly toward proceeds. Everything else has to clear a DEX.

:::warning A draw with no returnable proceeds is slash risk
If a fill seizes non-USDC collateral and the keeper cannot convert it (no router configured, or every venue breaches the slippage floor), that collateral is **held, not booked**. The vault still has an outstanding draw against the keeper. The Blend adapter notes `zero returnable proceeds — outstanding draw at slash risk`, and the next cycle's [stale-draw recovery](./strategies#slippage_bps--collateral-conversion) tries to make the vault whole from USDC on hand. A draw left outstanding past the registry's `slash_timeout` (3600s on testnet) is slashable. See [Staking & Slashing](./staking).
:::

## Two venues: Soroswap primary, Phoenix fallback

The swap entrypoint is `SwapToUSDC`:

```go
// keeper/dex/swap.go
func (s *SwapClient) SwapToUSDC(kp *keypair.Full, tokenAddr string, amount, refValueUSDC int64) (*SwapResult, error)
```

- `tokenAddr` — the collateral token contract to sell.
- `amount` — how much of it to sell (stroops). Must be `> 0`.
- `refValueUSDC` — the **oracle-implied** fair USDC value of that collateral (stroops). When `> 0` it anchors the slippage check; pass `0` to rely only on the on-chain `amount_out_min`.

The routing logic:

1. **Amount guard.** `amount <= 0` → error. `UsdcAddr` unset → `ErrUSDCNotConfigured`.
2. **Identity short-circuit.** If `tokenAddr == UsdcAddr`, return immediately with `OutputAmount = amount` and `Route = "none"` — no swap.
3. **Soroswap first** (only if `SOROSWAP_ROUTER` is set). On success, return. On `ErrSlippageExceeded`, **return immediately without trying Phoenix**. On any other error, record the attempt and continue.
4. **Phoenix fallback** (only if `PHOENIX_ROUTER` is set). On success, return; otherwise record the attempt.
5. **No route.** If neither venue was even attempted → `ErrNoRoute`. Otherwise `ErrNoRoute` wrapped with the joined attempt errors.

```go
// keeper/dex/swap.go (abridged)
if s.cfg.SoroswapRouter != "" {
    res, err := s.swapViaSoroswap(kp, tokenAddr, amount, refValueUSDC)
    switch {
    case err == nil:
        return res, nil
    case errors.Is(err, ErrSlippageExceeded):
        // A bad price is a global decision: don't dump on another venue either.
        return nil, err
    default:
        attempts = append(attempts, "soroswap: "+err.Error())
    }
}
if s.cfg.PhoenixRouter != "" {
    res, err := s.swapViaPhoenix(kp, tokenAddr, amount, refValueUSDC)
    if err == nil {
        return res, nil
    }
    attempts = append(attempts, "phoenix: "+err.Error())
}
```

:::info A bad price does not fall through to the other venue
A Soroswap quote below the slippage floor returns `ErrSlippageExceeded` and stops — it does **not** retry on Phoenix. The reasoning in the code: a price that bad is a *global* signal that the asset is mispriced or the market is thin right now, so dumping it on another venue would just realize the same bad price elsewhere. Phoenix is a fallback for Soroswap being *unavailable* (router error, no liquidity for the pair), not for Soroswap rejecting a price.
:::

### Sentinel errors

| Error | Meaning |
|---|---|
| `ErrNoRoute` | No configured DEX could complete the swap (none set, or all attempts failed). |
| `ErrSlippageExceeded` | The best quote was worse than the oracle-anchored floor; the keeper refuses to sell that cheaply on any venue. |
| `ErrUSDCNotConfigured` | `USDC_CONTRACT` / `UsdcAddr` is missing — the client cannot know what to swap *into*. |

## Soroswap path (primary)

Soroswap is the default venue and the only one with a live testnet deployment. The swap is a quote-then-execute, both against the router contract.

**1. Quote (read-only).** `router_get_amounts_out(amount_in: i128, path: Vec<Address>) -> Vec<i128>` is simulated. The path is `[tokenAddr, UsdcAddr]`, and the keeper takes the **last** element of the returned vec as the expected USDC out. An empty or `<= 0` quote is an error.

```go
// keeper/dex/soroswap.go — ABI: router_get_amounts_out(amount_in i128, path Vec<Address>) -> Vec<i128>
sim, err := s.rpc.SimulateRead(s.cfg.Passphrase, s.cfg.SoroswapRouter,
    "router_get_amounts_out", soroban.ScvI128(amount), pathVal)
// ... take vec[len(vec)-1] as expectedOut
```

**2. Floor check.** `belowFloor(expectedOut, refValueUSDC, SlippageBps)` — if the quote is below the oracle-anchored floor, return `ErrSlippageExceeded` (no fallback).

**3. Compute `minOut`.** `minOut = minOutForSlippage(expectedOut, SlippageBps)` — this becomes the on-chain `amount_out_min`, so even if the price moves between simulate and execution, the swap reverts rather than over-slipping.

**4. Read balance `before`**, then execute the swap:

```go
// keeper/dex/soroswap.go — ABI (exact arg order):
// swap_exact_tokens_for_tokens(amount_in i128, amount_out_min i128,
//                              path Vec<Address>, to Address, deadline u64)
deadline := uint64(s.now() + s.cfg.DeadlineSecs)
tx, err := s.rpc.Invoke(s.cfg.HorizonURL, kp, s.cfg.Passphrase, s.cfg.SoroswapRouter,
    "swap_exact_tokens_for_tokens",
    soroban.ScvI128(amount), soroban.ScvI128(minOut), pathVal, toVal, soroban.ScvU64(deadline))
```

`to` is the keeper's own address; `deadline = now() + DeadlineSecs` (60s by default).

**5. Read balance `after`.** `got = after - before`. If `got <= 0`, the swap is treated as failed (`swap sent but USDC balance did not increase`). Otherwise `OutputAmount = got`, `Route = "soroswap"`.

:::warning Swaps are not auto-retried
The execution call uses `rpc.Invoke`, **not** the retrying `InvokeWithRetry`. Re-broadcasting a non-idempotent swap after a post-send timeout could sell the same collateral *twice*, at a second (possibly worse) price. A transient failure is simply retried on the **next keeper cycle** instead, and the on-chain `amount_out_min` still bounds execution-time slippage.
:::

## Phoenix path (fallback)

Phoenix is gated behind `PHOENIX_ROUTER`, which you set to the **XYK pool/pair contract** for the specific collateral↔USDC pair. There is **no separate quote step** — Phoenix swaps directly with a min-received guard derived from the oracle reference:

- `minOut = minOutForSlippage(refValueUSDC, SlippageBps)` when `refValueUSDC > 0`, else `0` (no guard).

```go
// keeper/dex/phoenix.go — ABI (phoenix-contracts pool/src/contract.rs):
// swap(sender: Address, offer_asset: Address, offer_amount: i128,
//      ask_asset_min_amount: Option<i128>, max_spread_bps: Option<i64>,
//      deadline: Option<u64>, max_allowed_fee_bps: Option<i64>) -> i128
tx, err := s.rpc.Invoke(s.cfg.HorizonURL, kp, s.cfg.Passphrase, poolAddr,
    "swap",
    senderVal,               // sender
    offerVal,                // offer_asset
    soroban.ScvI128(amount), // offer_amount
    askMin,                  // ask_asset_min_amount: Option<i128>  (ScVoid when minOut == 0)
    soroban.ScvVoid(),       // max_spread_bps: Option<i64> = None
    deadline,                // deadline: Option<u64> = Some
    soroban.ScvVoid(),       // max_allowed_fee_bps: Option<i64> = None
)
```

`Option::None` encodes as `ScVoid`; `Option::Some(x)` as the value itself. `ask_asset_min_amount` is `ScVoid` when `minOut == 0`, else the i128 floor. Proceeds are again the measured balance delta (`got = after - before`, must be `> 0`); `Route = "phoenix"`. Like Soroswap, this call is **not auto-retried**.

:::danger Phoenix has no published testnet deployment and ships multiple swap ABIs
The encoded `swap(...)` signature above matches `phoenix-contracts` main, but Phoenix has shipped more than one swap interface across versions. **Verify the deployed pool contract's interface before relying on Phoenix in production.** On testnet, leave `PHOENIX_ROUTER` empty — Soroswap (`CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`) is the only venue with a live deployment.
:::

## Oracle-anchored slippage (`SLIPPAGE_BPS`)

The slippage floor is **oracle-anchored, not pool-anchored**. Rather than trusting the DEX's own quote as the reference (which a manipulated pool could inflate), the keeper computes the collateral's USDC value from **Blend's oracle prices** and rejects any swap that comes in below that, less the tolerance.

The reference comes from the Blend adapter's `oracleValueUSDC(pool, asset, amt)` = `amt × reserve.OraclePrice` (0 if no price), passed into `SwapToUSDC` as `refValueUSDC`.

The two helpers (`keeper/dex/swap.go`):

```go
// Minimum acceptable output for a quoted amount at a slippage tolerance.
func minOutForSlippage(quotedOut int64, slippageBps int) int64 {
    if quotedOut <= 0 { return 0 }
    // slippageBps clamped to [0, 10000]
    return quotedOut * int64(10000-slippageBps) / 10000
}

// True iff a quote is worse than the oracle-anchored floor.
// A non-positive reference DISABLES the check (returns false).
func belowFloor(quotedOut, refValueUSDC int64, slippageBps int) bool {
    if refValueUSDC <= 0 { return false }
    return quotedOut < minOutForSlippage(refValueUSDC, slippageBps)
}
```

So with `SLIPPAGE_BPS = 100` (1%) and an oracle-implied value of `100.0000000` USDC, the floor is `99.0000000` USDC. A Soroswap quote below that is rejected with `ErrSlippageExceeded`.

`SLIPPAGE_BPS` is parsed as an integer and **must be in `[0, 10000]`** or the keeper exits at startup. The default is `100`.

| `SLIPPAGE_BPS` | Floor (vs oracle) | Effect |
|---|---|---|
| `0` | exact oracle value | Reject any swap below the exact oracle value. Safest; illiquid collateral may never clear and is held for manual recovery. |
| `100` (default) | 1% below | Reasonable for liquid pairs (XLM/USDC). |
| `200`+ | 2%+ below | Only for thin pairs you understand; can eat most of a realistic liquidation spread. |

:::info `refValueUSDC = 0` disables the oracle floor
If no oracle price is available for the asset (`OraclePrice <= 0`), `oracleValueUSDC` returns `0`, and `belowFloor` is disabled. Soroswap then falls back to its own quote as the reference (`minOut = minOutForSlippage(expectedOut, …)`); Phoenix sends with no min-received guard (`ask_asset_min_amount = None`). This is the riskier path — keep a working Blend oracle in front of the pool. See [Profitability & Strategies](./strategies#slippage_bps--collateral-conversion) for how this interacts with `MIN_PROFIT`.
:::

## Balance-delta proceeds accounting

Proceeds are **never** taken from the DEX's claimed output. Both swap paths read the keeper's USDC balance immediately before and after the swap and report the delta:

```go
before, _ := TokenBalance(s.rpc, s.cfg.Passphrase, s.cfg.UsdcAddr, kp.Address())
// ... execute swap ...
after,  _ := TokenBalance(s.rpc, s.cfg.Passphrase, s.cfg.UsdcAddr, kp.Address())
got := after - before
if got <= 0 {
    return nil, fmt.Errorf("swap sent but USDC balance did not increase")
}
```

`TokenBalance` simulates `balance(owner)` on the USDC SAC and decodes the i128 (stroops). The returned `SwapResult.OutputAmount = got` is what flows up to the Blend adapter, which sums it across all lot assets in `swapCollateral` and books `Profit = max(0, proceeds − drawn)`. Because the figure is a real balance change, a partial fill, a fee, or a rounding loss is captured honestly — the vault never sees phantom profit.

A `SwapResult` carries:

| Field | Meaning |
|---|---|
| `InputToken` | the collateral token swapped |
| `InputAmount` | stroops of collateral sold |
| `OutputAmount` | **measured** USDC received (balance delta) |
| `Slippage` | realized shortfall vs the reference value, clamped to `[0,1]` |
| `Route` | `"soroswap"`, `"phoenix"`, or `"none"` |
| `TxHash` | the swap transaction hash |

In the Blend adapter, each non-USDC lot asset is swapped individually; a swap that **fails** for one asset is skipped (that asset is held, not booked), and the loop continues with the rest:

```go
// keeper/adapters/blend/adapter.go — swapCollateral
for asset, amt := range auction.Lot {
    v := amt.Int64()
    if v <= 0 { continue }
    if asset == a.cfg.UsdcAddr { total += v; continue } // USDC counts directly
    if a.dex == nil { continue }                          // no DEX → held
    ref := oracleValueUSDC(pool, asset, v)
    res, err := a.dex.SwapToUSDC(kp, asset, v, ref)
    if err != nil { continue }                            // swap failed → held
    total += res.OutputAmount
}
```

## Configuring the routers

The DEX client is constructed only when **at least one** router is set (`keeper/main.go`): if both `SOROSWAP_ROUTER` and `PHOENIX_ROUTER` are empty, no `SwapClient` is built and the Blend adapter receives a `nil` DEX (`a.dex == nil`).

| Variable | Default | Purpose |
|---|---|---|
| `USDC_CONTRACT` | `""` | The asset to swap **into**. Without it `SwapToUSDC` returns `ErrUSDCNotConfigured`. |
| `SOROSWAP_ROUTER` | `""` | Soroswap router contract (primary). Empty disables this venue. |
| `PHOENIX_ROUTER` | `""` | Phoenix XYK pool/pair contract for the collateral↔USDC pair (fallback). Empty disables this venue. |
| `SLIPPAGE_BPS` | `100` | Max slippage in basis points; integer in `[0, 10000]`. |

See the [Configuration Reference](./configuration) for the full table and validation rules.

### Current testnet values

These are the **current** Tranche 1 hardened testnet contracts (deployed 2026-05-24). See [Contract Addresses](../reference/contract-addresses) for the authoritative list.

| Variable | Current testnet value |
|---|---|
| `USDC_CONTRACT` | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| `SOROSWAP_ROUTER` | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| `PHOENIX_ROUTER` | *(leave empty — no public testnet deployment)* |

```bash
# Recommended testnet swap config: Soroswap only.
export USDC_CONTRACT="CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW"
export SOROSWAP_ROUTER="CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
export SLIPPAGE_BPS="100"
# PHOENIX_ROUTER intentionally unset
```

:::info Testnet USDC is a mock SAC; mainnet will use Circle USDC
On testnet, `USDC_CONTRACT` points at a **mock Stellar Asset Contract** (name "USD Coin", symbol "USDC", 7 decimals). In Tranche 3, mainnet keepers will set `USDC_CONTRACT` to **Circle USDC** and point `SOROSWAP_ROUTER` at the mainnet Soroswap router, alongside overriding `NETWORK_PASSPHRASE` and the RPC/Horizon endpoints.
:::

## What happens if both DEXs are disabled

If neither `SOROSWAP_ROUTER` nor `PHOENIX_ROUTER` is set, the keeper still runs and still fills auctions — but it can only return collateral that is **already USDC**:

- `keeper/main.go` builds **no** `SwapClient`, so the Blend adapter's `a.dex` is `nil`.
- In `swapCollateral`, USDC lot assets still count directly toward proceeds; every non-USDC asset hits the `if a.dex == nil { continue }` branch and is **skipped** — held in the keeper account, not returned.
- If a fill seizes only non-USDC collateral, `Proceeds == 0`, and the adapter sets `zero returnable proceeds — outstanding draw at slash risk`. The draw stays open until [stale-draw recovery](./strategies#slippage_bps--collateral-conversion) (which needs USDC on hand) clears it — or until it is slashed.

The practical takeaway: **set at least `SOROSWAP_ROUTER` and `USDC_CONTRACT` for any keeper that fills real Blend positions.** Running with both DEXs disabled is only sensible against a pool whose collateral is itself USDC. The bundled SDK examples make this explicit — `examples/basic` passes a `nil` DEX client precisely to demonstrate the USDC-only path, while `examples/multi-pool` shares one `dex.NewSwapClient` across pools.

## See also

- [Configuration Reference](./configuration) — `USDC_CONTRACT`, `SOROSWAP_ROUTER`, `PHOENIX_ROUTER`, `SLIPPAGE_BPS`
- [Profitability & Strategies](./strategies) — how swap slippage interacts with `MIN_PROFIT`, and stale-draw recovery
- [Staking & Slashing](./staking) — what an unreturned draw costs you
- [Contract Addresses](../reference/contract-addresses) — current testnet IDs
- [Keeper SDK](../developers/keeper-sdk) — the `dex.SwapClient` API for custom adapters
