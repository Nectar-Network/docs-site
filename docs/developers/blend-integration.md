---
title: Blend Integration
description: How the Nectar keeper monitors Blend pools, reads the three auction types, prices Dutch auctions against the MIN_PROFIT gate, fills them, and recovers transient failures with bounded retries.
---

# Blend Integration

[Blend](https://www.blend.capital/) is a lending protocol on Soroban. When a borrower's position becomes undercollateralized, Blend opens a **Dutch auction** that anyone can fill in exchange for the borrower's collateral. Nectar's keeper monitors a configured Blend pool, prices those auctions, and fills the profitable ones using shared vault capital — returning the realized proceeds to depositors as yield.

This page describes exactly how that integration works, down to the on-chain calls and the profitability math. Every signature, request type, and address below comes from the keeper source under `keeper/blend/` and `keeper/adapters/blend/`.

:::info Where the code lives
The low-level pool/auction/position logic is the `blend` package (`keeper/blend/`). The thin translation layer that turns it into a [protocol adapter](./keeper-sdk) is `keeper/adapters/blend/`. The adapter is what gets extracted into the public [`keeper-sdk`](./keeper-sdk) in Tranche 2.
:::

## Monitored pool (testnet)

The keeper monitors a single Blend pool, set via the `BLEND_POOL` environment variable. The current Tranche-1-hardened testnet target is:

| Contract | Address |
| --- | --- |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Reflector oracle (used by the pool) | `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` |
| USDC (mock SAC, settlement asset) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |

:::note USDC on testnet vs. mainnet
On testnet, USDC is a mock Stellar Asset Contract (SAC) with 7-decimal precision (`1 USDC = 10,000,000` stroops). Mainnet deployment (Tranche 3) switches the settlement asset to Circle USDC; the integration logic is identical because both expose the standard SAC interface.
:::

## The three auction types

Blend v2 stores auctions under a numeric kind. The keeper models them as `AuctionType`:

| Auction | `AuctionType` | Blend `submit()` request type | What you pay (bid) | What you receive (lot) |
| --- | --- | --- | --- | --- |
| User liquidation | `AuctionUserLiquidation` (0) | `6` (`FillUserLiquidationAuction`) | Borrower's debt assets | Borrower's collateral (bTokens) |
| Bad debt | `AuctionBadDebt` (1) | `7` (`FillBadDebtAuction`) | Socialized bad debt | Backstop's bTokens |
| Interest | `AuctionInterest` (2) | `8` (`FillInterestAuction`) | BLND | Accumulated backstop interest |

The on-chain storage kind (0/1/2) and the `submit()` request type (6/7/8) are **different numbers** — a common source of confusion. The keeper maps between them in `AuctionType.requestType()`:

```go
// keeper/blend/auction.go
func (t AuctionType) requestType() uint32 {
	switch t {
	case AuctionUserLiquidation:
		return 6
	case AuctionBadDebt:
		return 7
	case AuctionInterest:
		return 8
	default:
		return 6
	}
}
```

Only user-liquidation auctions can be *created* by a keeper (via `new_liquidation_auction`). Interest and bad-debt auctions are triggered by the pool's own internal accounting — there is no creation entry point for them, so the keeper only ever reads and fills those.

## Dutch-auction mechanics

A Blend auction is a two-phase Dutch auction measured in **ledger blocks elapsed since the auction's start block**. The keeper reproduces the on-chain scaling in `PhaseAt`:

| Phase | Elapsed blocks | Lot scaling | Bid scaling |
| --- | --- | --- | --- |
| `PhaseLotScaling` | `0 – 200` | grows `0% → 100%` | held at `100%` |
| `PhaseBidScaling` | `200 – 400` | held at `100%` | shrinks `100% → 0%` |
| `PhaseExpired` | `> 400` | `100%` | `0%` |

```go
// keeper/blend/auction.go
func PhaseAt(elapsed int64) (AuctionPhase, float64, float64) {
	if elapsed < 0 {
		elapsed = 0
	}
	switch {
	case elapsed <= 200:
		return PhaseLotScaling, float64(elapsed) / 200.0, 1.0
	case elapsed <= 400:
		return PhaseBidScaling, 1.0, float64(400-elapsed) / 200.0
	default:
		return PhaseExpired, 1.0, 0.0
	}
}
```

The intuition:

- **Phase 1 (blocks 0–200):** the lot (what you receive) starts at nothing and grows linearly to its full size, while the bid (what you pay) stays at 100%. Filling early means overpaying.
- **Block 200 — the "fair price" point:** both legs sit at 100%. This is where lot value and bid cost are nominally equal.
- **Phase 2 (blocks 200–400):** the lot is fixed at 100% while the bid shrinks linearly to zero, so each block makes the fill cheaper and more profitable.
- **After block 400:** the auction is effectively a free lot (bid is zero), but in practice it is filled long before then by competing keepers.

:::tip Why the gate matters
Because the bid only becomes cheap in Phase 2, a profitable fill almost always happens *after* block 200. The keeper does not blindly fill the moment an auction appears — it waits until the lot/bid ratio clears the `MIN_PROFIT` threshold (below).
:::

## Reading auctions

### Pool state

Before pricing anything, the keeper loads the pool's reserve configuration with `LoadPool`, which calls `get_reserve_list` and then `get_reserve` per asset. Each `Reserve` carries the oracle price and rate indices used to value lots and bids:

```go
// keeper/blend/pool.go
type Reserve struct {
	Asset            string
	Index            uint32
	CollateralFactor float64
	LiabilityFactor  float64
	BRate            float64 // scaled 1e7
	DRate            float64 // scaled 1e7
	OraclePrice      float64
}
```

All on-chain integer amounts are 7-decimal stroops; the package divides by `scalar = 1e7` whenever it converts to a human/USD value.

### Discovering positions

`GetPositions` discovers borrowers by scanning the pool's recent events (the adapter looks back `latest_ledger - 1000`), de-duplicating addresses from event topics, and loading each one's `get_positions`. The health factor is then computed off-chain:

```go
// keeper/blend/positions.go
// HF = Σ(collateral·price·cFactor) / Σ(liability·price / lFactor)
func CalcHealthFactor(pos Position, pool *PoolState) float64
```

A position with `HF < 1.0` is underwater and becomes a liquidation `Task`. Task priority scales with how far underwater the position is (`hf < 0.5` → priority `10`, down to `1` near the boundary), so the most urgent liquidations run first.

### Fetching a specific auction

To read an existing auction, the keeper calls the pool's `get_auction` read (via `SimulateRead`) with the auction kind and the target address:

```go
// keeper/blend/auction.go
func GetAuctionByType(rpc *soroban.Client, passphrase, poolAddr, user string, kind AuctionType) (*Auction, error)
```

A clean miss (`AuctionNotFound` / `NotFound` / Blend error `#4`) returns `(nil, nil)` rather than an error, so the caller can distinguish "no auction here" from "RPC failure". `DetectAuctions` runs this across all three kinds (`AllAuctionTypes`) and returns whatever currently exists.

The parsed `Auction` carries the start block and the lot/bid asset maps:

```go
// keeper/blend/auction.go
type Auction struct {
	User       string
	Type       AuctionType
	StartBlock int64
	Lot        map[string]*big.Int // asset address -> amount (stroops)
	Bid        map[string]*big.Int // asset address -> amount (stroops)
}
```

## The profitability gate

`Profitability` computes `lot_value / bid_cost` at the current block, applying the Dutch-auction scaling and the per-asset oracle prices from the pool snapshot:

```go
// keeper/blend/auction.go
func Profitability(auction Auction, pool *PoolState, currentBlock int64) float64 {
	elapsed := currentBlock - auction.StartBlock
	_, lotPct, bidPct := PhaseAt(elapsed)

	var lotVal, bidVal float64
	for asset, amt := range auction.Lot {
		r, ok := pool.Reserves[asset]
		if !ok {
			continue
		}
		f, _ := new(big.Float).SetInt(amt).Float64()
		lotVal += (f / scalar) * lotPct * r.OraclePrice
	}
	for asset, amt := range auction.Bid {
		r, ok := pool.Reserves[asset]
		if !ok {
			continue
		}
		f, _ := new(big.Float).SetInt(amt).Float64()
		bidVal += (f / scalar) * bidPct * r.OraclePrice
	}
	if bidVal == 0 {
		return math.Inf(1) // bid fully scaled out -> infinitely profitable
	}
	return lotVal / bidVal
}
```

The adapter compares the result against `MIN_PROFIT` (the `MinProfit` config field) and skips the fill if the ratio is below it:

```go
// keeper/adapters/blend/adapter.go
ratio := core.Profitability(*auction, pool, ledger)
if ratio < a.cfg.MinProfit {
	return &adapters.Result{Block: ledger, Note: fmt.Sprintf("not profitable (%.4f < %.4f)", ratio, a.cfg.MinProfit)}, nil
}
```

`MIN_PROFIT` defaults to `1.02` — i.e. the lot must be worth at least 2% more than the bid before the keeper commits capital. It is configurable via the environment and validated to be `> 0` at startup.

| Variable | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `BLEND_POOL` | *(empty — disabled)* | — | Blend pool contract to monitor. Empty disables the Blend adapter. |
| `MIN_PROFIT` | `1.02` | must be `> 0` | Minimum `lot_value / bid_cost` ratio required to fill. |
| `POLL_INTERVAL` | `10` | range `[3, 300]` | Seconds between monitoring cycles. |
| `USDC_CONTRACT` | *(empty)* | — | Settlement asset; collateral is swapped into this. |

:::warning Pricing is only as good as the oracle
The lot and bid values come from the Blend pool's oracle prices (Reflector on testnet). A stale or manipulated oracle feeds straight into the gate. Tranche 3 adds an oracle circuit breaker that cross-references Reflector and pauses the keeper on excessive deviation. See [Risks](../depositors/risks).
:::

## Filling an auction

When an auction clears the gate, the keeper fills it by calling the pool's `submit()` with a single request whose `request_type` selects the auction kind. All three fill paths share one builder, `fillAuctionRequest`, which differs only in that constant:

```go
// keeper/blend/auction.go
// Blend's Request struct: request_type:u32, address:Address, amount:i128.
reqMap := xdr.ScMap{
	{Key: soroban.ScvSymbol("address"), Val: userVal},
	{Key: soroban.ScvSymbol("amount"), Val: zeroAmt}, // amount 0 -> fill the whole auction
	{Key: soroban.ScvSymbol("request_type"), Val: reqTypeVal},
}
```

Two correctness details that the code is careful about:

- The map keys **must** be in sorted lexicographic order (`address`, `amount`, `request_type`) for a Soroban `Map<Symbol, Val>`, otherwise the pool rejects the submit.
- The scalar types matter: `request_type` is `u32`, `amount` is `i128`. Sending the right keys with the wrong types still fails.

The convenience entry points wrap the builder:

```go
// keeper/blend/auction.go
func FillUserLiquidationAuction(rpc *soroban.Client, horizonURL string, kp *keypair.Full, passphrase, poolAddr, user string) error // request_type 6
func FillBadDebtAuction(...)  // request_type 7
func FillInterestAuction(...) // request_type 8
func FillByType(..., kind AuctionType) error // dispatches by kind
```

### What `Execute` does end to end

The Blend adapter's `Execute` runs one liquidation task:

1. **Create** the user-liquidation auction at 50% (`CreateAuction(..., user, 50)`). If it already exists (`AuctionExists` / error `#5`), this is a no-op.
2. **Read** the auction back with `GetAuction`.
3. **Price** it with `Profitability` against the latest ledger; bail out with a `not profitable` note if it is below `MIN_PROFIT`.
4. **Draw** the bid amount of capital from the [Nectar Vault](./contracts/nectar-vault) (only if the bid is non-zero).
5. **Fill** via `FillAuction`, measuring draw→fill latency for registry performance metrics.
6. **Swap** the seized collateral to USDC through the configured DEX, then **return** the real proceeds to the vault.

Proceeds are always measured, never synthesized: an asset whose swap fails is held rather than booked as phantom profit, and capital is only returned when it was actually drawn.

:::danger Another keeper can win the race
Liquidation is competitive. If a different keeper fills the auction first, the pool returns `AlreadyFilled` / `AuctionNotFound`. The adapter detects this (`core.ErrAlreadyFilled`), books no profit and no loss, and returns the unspent drawn capital to the vault unchanged.
:::

## Retry and backoff

Fills go through `InvokeWithRetry`, which applies bounded exponential backoff. The recommended write-side policy is `DefaultRetry()`:

```go
// keeper/soroban/retry.go
func DefaultRetry() RetryConfig {
	return RetryConfig{MaxAttempts: 3, InitialDelay: time.Second, BackoffFactor: 2.0}
}
```

So a failing submit is retried at most 3 times with delays of roughly 1s, then 2s. Crucially, **only transient failures are retried** — deterministic contract failures fail fast so the keeper does not burn fees re-sending a doomed transaction:

| Not retried (deterministic) | Retried (transient infra/network) |
| --- | --- |
| `already filled` / `AlreadyFilled` | `tx_too_late` |
| `AuctionNotFound` | `tx_insufficient_fee` |
| `insufficient balance` | `resource_exhaust` |
| `unauthorized` | `timeout` / `timed out` |
| `contract error` / `contract panic` | `connection reset` / `connection refused` |
| `already registered` | `eof`, `sequence` |

```go
// keeper/soroban/retry.go
if attempt == retry.MaxAttempts || !isRetryable(err) {
	return nil, err // give up: out of attempts, or a deterministic failure
}
```

### Stale-draw recovery

A fill is atomic on-chain, but the subsequent "return proceeds to vault" step can fail transiently — leaving capital drawn but unreturned, which risks a timeout slash by the [Keeper Registry](./contracts/keeper-registry). At the top of every cycle the keeper calls `recoverStaleDraw`: if `get_keeper_draw` shows an outstanding draw, it returns up to that amount from the keeper's own USDC on hand (capped at the drawn amount, never more of the keeper's float). This is the keeper's restart-safe, self-healing path against the slash window.

## Stateless by design

The keeper holds no auction state between cycles. Every cycle re-loads the pool, re-discovers positions, re-reads auctions, and re-prices them from chain. That is why a keeper can be killed and restarted at any time without losing or double-filling work — the only durable state is on-chain (the vault draw, the registry metrics, the auction itself).

## Related pages

- [Keeper SDK](./keeper-sdk) — the `ProtocolAdapter` interface that Blend implements.
- [Nectar Vault](./contracts/nectar-vault) — where the keeper draws and returns capital.
- [Keeper Registry](./contracts/keeper-registry) — staking, performance tracking, and slashing.
- [Risks](../depositors/risks) — oracle dependence, liquidation competition, and the Tranche-3 circuit breaker.
