---
title: Profitability & Strategies
description: How a Nectar keeper decides which Blend auctions to fill, and how to tune MIN_PROFIT, POLL_INTERVAL, and SLIPPAGE_BPS for competition, multi-pool, and DeFindex drift rebalancing.
---

# Profitability & Strategies

A Nectar keeper is a price-taker in a race. Every cycle it scans the Blend pool for underwater positions, prices each liquidation auction against Blend's two-phase Dutch model, and fills only the auctions whose lot is worth more than the bid by a configurable margin. This page explains exactly how that decision is made in the code, and which knobs change your behavior.

There is **no `STRATEGY` profile, no `DEX_ADAPTER` switch, and no `simulate` subcommand**. The keeper's behavior is governed entirely by the environment variables documented in the [Configuration Reference](./configuration). The three that shape profitability are `MIN_PROFIT`, `POLL_INTERVAL`, and `SLIPPAGE_BPS`.

:::info All amounts are 7-decimal stroops
Every on-chain value in Nectar is an `i128` at 7-decimal precision: **1 USDC = 10,000,000 stroops**. The keeper works in stroops internally and the dashboard divides by `1e7` for display.
:::

## How the keeper decides to fill

The fill decision lives in the Blend adapter's `Execute` (`keeper/adapters/blend/adapter.go`) and the profitability engine in `keeper/blend/auction.go`. The sequence for a single underwater position is:

1. **Detect.** `GetTasks` loads the pool, lists positions, and computes each one's health factor (`hf`). Positions with `hf >= 1.0` are skipped. Each underwater position becomes a `liquidation` task whose `Priority` is set by how underwater it is.
2. **Create the auction.** `Execute` calls `new_liquidation_auction(user, 50 * 1e7)` on the pool — a user-liquidation auction sized at **50%** of the position's debt. If the auction already exists (`AuctionExists` / `#5`), that's swallowed as success.
3. **Price it.** It reads the auction back, fetches the latest ledger, and computes `ratio := Profitability(auction, pool, ledger)`.
4. **Gate on `MIN_PROFIT`.** If `ratio < MIN_PROFIT`, `Execute` returns immediately with a note like `not profitable (1.0140 < 1.0200)` — **no capital is drawn and no fill is attempted.**
5. **Draw, fill, swap, return.** If the ratio clears the threshold, the keeper draws the bid amount from the vault, submits the fill, swaps any non-USDC collateral to USDC, and returns the proceeds.

### The Dutch-auction model (200 / 400 blocks)

Blend v2 auctions scale over blocks (ledgers) since the auction's `StartBlock`. `PhaseAt(elapsed)` returns the scaled lot and bid percentages:

| Phase | `elapsed` (blocks) | Lot % | Bid % | Meaning |
|---|---|---|---|---|
| `PhaseLotScaling` | `0 … 200` | `elapsed / 200` (0 → 100%) | `100%` | Lot grows in; bidder pays full price for a partial lot. |
| `PhaseBidScaling` | `200 … 400` | `100%` | `(400 − elapsed) / 200` (100% → 0%) | Full lot; the price you pay shrinks toward zero. |
| `PhaseExpired` | `> 400` | `100%` | `0%` | Full lot, free — `bidVal == 0`. |

`elapsed` is clamped to `>= 0`, and boundaries are inclusive on the lower side: at exactly `elapsed = 200` you are in `PhaseLotScaling` with **both** legs at 100% — the "fair price" point.

### The lot/bid ratio

`Profitability` values both legs of the auction in USD using the pool's oracle prices (`reserve.OraclePrice`), scaled by the current phase:

```go
// keeper/blend/auction.go (abridged)
func Profitability(auction Auction, pool *PoolState, currentBlock int64) float64 {
    elapsed := currentBlock - auction.StartBlock
    _, lotPct, bidPct := PhaseAt(elapsed)

    var lotVal, bidVal float64
    for asset, amt := range auction.Lot {
        r, ok := pool.Reserves[asset]
        if !ok { continue } // asset not in pool reserves → skipped
        f, _ := new(big.Float).SetInt(amt).Float64()
        lotVal += (f / scalar) * lotPct * r.OraclePrice
    }
    for asset, amt := range auction.Bid {
        r, ok := pool.Reserves[asset]
        if !ok { continue }
        f, _ := new(big.Float).SetInt(amt).Float64()
        bidVal += (f / scalar) * bidPct * r.OraclePrice
    }
    if bidVal == 0 {
        return math.Inf(1) // expired auction: always "profitable"
    }
    return lotVal / bidVal
}
```

The returned number is a pure ratio: `lot_value / bid_cost`. It must be `>= MIN_PROFIT` for the keeper to act.

- `ratio = 1.02` means the lot is worth 2% more than the bid (the default threshold).
- During `PhaseLotScaling` (early), the lot is small and the bid is full, so `ratio` starts low and rises as `elapsed → 200`.
- During `PhaseBidScaling` (late), the lot is full and the bid shrinks, so `ratio` keeps rising. An expired auction returns `+Inf`.

:::warning Profit here is gross, before swap slippage and fees
`Profitability` prices the lot at the oracle. The **realized** profit booked to the vault is `proceeds − drawn`, where `proceeds` is the *measured* USDC you receive after swapping the seized collateral (see [`SLIPPAGE_BPS`](#slippage_bps--collateral-conversion)). A ratio comfortably above 1.0 can still net little if the collateral is illiquid. Build a cushion into `MIN_PROFIT`.
:::

### Auction kinds

The engine handles all three Blend auction types; the math above is identical for each (only the lot/bid contents differ). The on-chain auction enum maps to the `submit()` `request_type`:

| Auction kind | Storage enum | `request_type` |
|---|---|---|
| User liquidation | `0` | `6` (`FillUserLiquidationAuction`) |
| Bad debt | `1` | `7` (`FillBadDebtAuction`) |
| Interest | `2` | `8` (`FillInterestAuction`) |

The Blend adapter's `Execute` currently creates and fills **user-liquidation** auctions (it calls `CreateAuction(..., 50)` then `FillAuction`). The lower-level `blend` package also exposes `FillBadDebtAuction`, `FillInterestAuction`, and `DetectAuctions` for custom adapters built on the [keeper-sdk](../developers/keeper-sdk).

## Tuning `MIN_PROFIT`

`MIN_PROFIT` is the minimum `lot/bid` ratio required to fill. It is parsed as a float and **must be `> 0`** or the keeper exits at startup.

```bash
export MIN_PROFIT="1.02"   # require the lot to be worth 2% more than the bid
```

| Value | Effect |
|---|---|
| `1.02` (default) | Require 2% gross headroom. A sane baseline. |
| `1.03`–`1.05` | Conservative: skip marginal auctions, only fill clear winners. Lower volume, higher per-fill confidence. Good for volatile or thin collateral. |
| `1.005`–`1.015` | Aggressive: chase thinner margins. Higher volume, but slippage on the collateral sale can wipe out the gross edge. |

:::danger Never set `MIN_PROFIT < 1.0`
A value below `1.0` tells the keeper to fill auctions where the bid costs more than the lot is worth — a guaranteed loss on every fill. The threshold is a ratio, not a percentage, so `1.0` is break-even.
:::

Because the early Dutch phase produces a low ratio that *climbs* toward the fair-price point at block 200, a higher `MIN_PROFIT` effectively makes your keeper wait later into the auction — which is exactly when competing keepers also pounce. Tightening `MIN_PROFIT` trades fill rate for margin; it does not let you "wait for a better price" without also exposing you to losing the race.

## Tuning `POLL_INTERVAL`

`POLL_INTERVAL` is the number of seconds between monitoring cycles. It is parsed as an integer and **must be in the range `[3, 300]`** or the keeper exits at startup. The default is `10`.

```bash
export POLL_INTERVAL="5"   # scan every 5 seconds
```

Each cycle does a full scan: pool load, position list, health-factor math, and (for every underwater position) auction creation, pricing, and a fill attempt. Lower intervals react faster but issue more RPC calls.

| Value | Trade-off |
|---|---|
| `3`–`5` | Fastest reaction; best for competing on freshly-underwater positions. Highest RPC load — use a dedicated/paid RPC endpoint. |
| `10` (default) | Balanced. Fine for a shared testnet RPC. |
| `30`–`300` | Low load; you will lose most contested auctions to faster keepers, but still catch auctions other keepers skip (e.g. ones below their `MIN_PROFIT`). |

:::tip Latency matters more than interval in a race
The fill is decided by *transaction confirmation order*, not by who polled first. A keeper polling every 10s on a low-latency RPC in the same region as the validator set will routinely beat a keeper polling every 3s through a distant, congested endpoint. Tune your `SOROBAN_RPC` and host location alongside `POLL_INTERVAL`.
:::

## `SLIPPAGE_BPS` & collateral conversion

After a successful fill, the keeper holds seized collateral (often XLM or another reserve asset, not USDC). The `dex` package swaps it to USDC so it can be returned to the vault. `SLIPPAGE_BPS` caps how much worse than the oracle-implied value a swap may execute. It is parsed as an integer and **must be in `[0, 10000]`** (100 bps = 1%) or the keeper exits at startup. The default is `100`.

```bash
export SLIPPAGE_BPS="100"   # tolerate at most 1% slippage vs the oracle reference
```

The swap routes through **Soroswap first, Phoenix as a fallback** (`keeper/dex/swap.go`). The slippage check is oracle-anchored, not pool-anchored, so a manipulated pool quote cannot pass:

- The keeper computes `refValueUSDC` = the Blend-oracle-implied USDC value of the collateral.
- `belowFloor(quotedOut, refValueUSDC, SLIPPAGE_BPS)` rejects the swap if the DEX quote is below `refValueUSDC * (10000 − SLIPPAGE_BPS) / 10000`.
- If the price is below the floor, the swap returns `ErrSlippageExceeded` and **does not fall back to the other venue** — a bad price is a global decision, so the keeper refuses to dump the collateral cheaply anywhere.
- The on-chain `amount_out_min` further bounds execution-time slippage; the proceeds are always the keeper's measured USDC balance delta, never synthesized.

| Value | Effect |
|---|---|
| `0` | Reject any swap below the exact oracle value. Safest, but illiquid collateral may never clear — you then hold it for manual recovery. |
| `100` (default, 1%) | Reasonable for liquid pairs (XLM/USDC). |
| `200`+ | Only for thin pairs you understand. A 2%+ tolerance can eat most of a realistic liquidation spread. |

:::warning Conversion can fail — and that's by design
If no configured venue (Soroswap/Phoenix) clears within `SLIPPAGE_BPS`, the swap fails and that asset is **held, not booked as phantom profit**. If a fill produced a draw but zero returnable proceeds, the keeper logs `zero returnable proceeds — outstanding draw at slash risk`. Outstanding draws are auto-recovered at the top of the next cycle (`recoverStaleDraw`) when you hold USDC, but a draw left outstanding past the registry's `slash_timeout` (3600s on testnet) is slashable. Configure `USDC_CONTRACT`, `SOROSWAP_ROUTER`, and/or `PHOENIX_ROUTER` so seized collateral can actually be converted and returned. See [Staking & Slashing](./staking).
:::

## Competition: how multiple keepers interact

Nectar runs a **race to fill**, not a coordinator. When a position goes underwater, every keeper above its own `MIN_PROFIT` threshold draws capital and submits a fill for the same auction. The first transaction to confirm wins; the rest receive `AuctionNotFound` / `AlreadyFilled` (`#4`), which the keeper detects as `ErrAlreadyFilled`.

The loser's path is **non-destructive**: it drew `bidAmt` but never spent it, so it sets the proceeds equal to the draw and returns the capital unchanged — no profit, no loss, the note reads `already filled by another keeper`.

What this means for tuning:

- **You cannot win on `POLL_INTERVAL` alone.** Reaction speed helps you *enter* the race; confirmation latency decides it. Invest in a fast, nearby RPC endpoint.
- **A higher `MIN_PROFIT` cedes contested fills.** If you require more margin, you wait later into the Dutch curve, where faster keepers have already filled. Conversely, a *lower* `MIN_PROFIT` lets you catch auctions other keepers skip.
- **Don't run two keepers from one key.** They would contend for the same account sequence number and lose races to independent keepers. Use a distinct `KEEPER_SECRET` per instance.

The registry tracks each keeper's `total_executions`, `successful_fills`, `total_profit`, and average response time (`avg_response_time_ms`), surfaced on the [keeper leaderboard](https://nectarnetwork.fun/dashboard/keepers). Only *successful* fills contribute to your profit and response-time stats; a lost race increments `total_executions` only.

## Multi-pool monitoring

The bundled keeper binary monitors a single `BLEND_POOL`. To watch several pools at once, use the [keeper-sdk](../developers/keeper-sdk) and register one Blend adapter per pool:

```go
// One Blend adapter per pool, sharing a single DEX client.
dexc := dex.NewSwapClient(rpc, dexCfg)
for _, pool := range pools { // e.g. read BLEND_POOLS as a comma-separated list
    k.AddAdapter(blend.NewAdapter(blend.Config{
        PoolAddr:   pool,
        MinProfit:  cfg.MinProfit,
        HorizonURL: cfg.HorizonURL,
        Passphrase: cfg.Passphrase,
        UsdcAddr:   cfg.UsdcAddr,
    }, dexc))
}
```

Each cycle the keeper polls adapters in registration order, sorts every adapter's tasks highest-priority first (`SortByPriority`), and executes them. The `examples/multi-pool` program in the SDK is a working reference. Priorities are assigned per task by how underwater the position is:

| Health factor | Priority |
|---|---|
| `hf < 0.5` | `10` (critical) |
| `0.5 ≤ hf < 0.8` | `7` |
| `0.8 ≤ hf < 0.95` | `4` |
| `0.95 ≤ hf < 1.0` | `1` |

:::tip Per-keeper draw cap is on-chain
The vault enforces `max_draw_per_keeper` (10,000 USDC on testnet) **per single `draw` call**, not cumulatively. Across many pools you can hold multiple outstanding draws at once; size your liquid USDC and your stake accordingly. There is no `MAX_DRAW` env var — the cap is a contract parameter.
:::

## DeFindex drift rebalancing

The keeper ships a second, optional adapter that demonstrates multi-protocol extensibility: a [DeFindex](https://www.defindex.io/) rebalancer. It is registered only when `DEFINDEX_VAULT` is set, and it **never draws Nectar vault capital** — it only reshuffles the DeFindex vault's *own* funds between strategies when allocations drift off target.

```bash
export DEFINDEX_VAULT="C..."        # the DeFindex vault to rebalance
export DEFINDEX_DRIFT_BPS="500"     # rebalance when any asset drifts ≥ 5%
```

`DEFINDEX_DRIFT_BPS` is parsed as an integer and **must be in `[0, 10000]`** or the keeper exits; the default is `500` (5%). It is converted to a fraction (`DriftBps / 10000`) for the adapter.

How it works (`keeper/adapters/defindex/adapter.go`):

1. **Scan.** `GetTasks` reads `fetch_total_managed_funds` and, for each asset, compares each strategy's current weight against its target weight (default: equal weight across that asset's non-paused strategies). The largest deviation is the asset's drift.
2. **Threshold.** If an asset's drift is `< DriftThreshold`, it's left alone. Deltas smaller than `dustAmount` (100,000 stroops = 0.01) are ignored so rounding never emits an instruction.
3. **Plan.** A single `rebalance` task carries an instruction list: **unwinds first** (pull excess out of over-weighted strategies, freeing idle funds), then **invests** (deploy into under-weighted, non-paused strategies). Invests are capped to the idle freed by unwinds so the vault never tries to deploy more than it holds. Paused strategies target 0 and get unwound.
4. **Execute.** Before submitting, the keeper confirms it holds the `RebalanceManager` or `Manager` role on-chain. If not, `Execute` returns a clear, non-fatal note (`keeper not authorized to rebalance …`) and moves on. Otherwise it calls `rebalance(caller, instructions)`. This call is **not retried** — a re-broadcast could double-apply the moves.

Task priority scales with drift:

| Max drift | Priority |
|---|---|
| `≥ 0.2` (20%) | `8` |
| `≥ 0.1` (10%) | `5` |
| otherwise | `3` |

:::info DeFindex rebalancing earns no liquidation profit
This adapter exists to prove the `ProtocolAdapter` interface generalizes beyond Blend. It does not draw vault capital and does not book profit to the Nectar vault — `EstimateCapital` is always `0`. Leave `DEFINDEX_VAULT` empty unless you are operating a DeFindex vault and have been granted the rebalance role.
:::

## Putting it together — example tunings

Conservative (minimum stake, shared RPC, volatile collateral):

```bash
export MIN_PROFIT="1.03"
export POLL_INTERVAL="10"
export SLIPPAGE_BPS="50"
```

Balanced (the defaults — a good starting point for most operators):

```bash
export MIN_PROFIT="1.02"
export POLL_INTERVAL="10"
export SLIPPAGE_BPS="100"
```

Aggressive (deep stake, dedicated low-latency RPC near the validator set):

```bash
export MIN_PROFIT="1.015"
export POLL_INTERVAL="3"
export SLIPPAGE_BPS="100"
```

:::warning No backtest harness ships with the keeper
There is no `simulate` subcommand. Validate parameter changes against the live testnet pool (`./scripts/keeper-blend-testnet.sh`) and watch realized profit on the [dashboard](https://nectarnetwork.fun/dashboard/keepers) before committing to an aggressive configuration on mainnet.
:::

## See also

- [Configuration Reference](./configuration) — every environment variable and its validation
- [Staking & Slashing](./staking) — what an unreturned draw costs you
- [Keeper Setup](./setup) — build and run the keeper
- [Keeper SDK](../developers/keeper-sdk) — build custom and multi-pool adapters
- [Contract Addresses](../reference/contract-addresses) — current testnet IDs
