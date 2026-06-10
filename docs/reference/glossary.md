---
title: Glossary
description: Definitions for every domain term used across the Nectar Network docs — vault and share mechanics, keeper and registry concepts, Blend auctions, DEX routing, and Stellar/Soroban primitives.
---

# Glossary

Definitions for the terms used throughout these docs. Where a term maps to real on-chain or keeper code, the relevant function, struct, or parameter is named so you can trace it back to the source.

:::info Conventions used below
All USDC amounts are integers in **7-decimal precision** (see [stroop / 7-decimals](#stroop--7-decimals)). On testnet, USDC is a [mock SAC](#sac-stellar-asset-contract); mainnet (Tranche 3) will use Circle USDC. "Tranche 2" features (DEX routing, multi-protocol adapters, DeFindex) are live on testnet; "Tranche 3" features (oracle circuit breaker, mainnet) are planned.
:::

---

## Protocol overview terms

### Vault

The `NectarVault` Soroban contract. It is the single pool of USDC that depositors fund and keepers draw from. The vault holds all capital, mints and burns [shares](#share), tracks per-keeper outstanding [draws](#draw), and books [profit](#return-proceeds) back into the share price. Its state is the `VaultState` struct:

```rust
pub struct VaultState {
    pub total_usdc: i128,    // total USDC the vault accounts for (principal + profit)
    pub total_shares: i128,  // total shares outstanding
    pub total_profit: i128,  // cumulative realized profit
    pub active_liq: i128,    // capital currently drawn and not yet returned
}
```

Current testnet address: `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345`.

See [contracts/nectar-vault](../developers/contracts/nectar-vault) for the full reference.

### Share

A depositor's claim on the vault, minted on [`deposit`](../developers/contracts/nectar-vault) and burned on [`withdraw`](../developers/contracts/nectar-vault). Shares are not transferable tokens; they are tracked per account in the `Depositor` record (`shares: i128`). A share's USDC value rises as the vault books profit — depositors hold a fixed share count and gain by [share price](#share-price) appreciation, not by receiving more shares.

The first deposit into an empty vault mints shares 1:1 with USDC. Every later deposit mints `amount * total_shares / total_usdc`, using integer division that floors toward zero so a depositor never receives more than their fair share.

### Share price

USDC value of one share: `total_usdc / total_shares`. It starts at `1.0` and ticks up as realized [profit](#return-proceeds) is added to `total_usdc` without minting new shares. The frontend computes it with `sharePrice(totalUsdc, totalShares)`, returning `1.0` when the vault is empty to avoid divide-by-zero.

:::tip Profit is the only yield mechanism
There are no reward tokens, emissions, or lockups. All depositor yield comes from the share price rising as keepers return liquidation profit to the vault.
:::

### Draw

A keeper borrowing vault capital to fund a liquidation. Implemented by `draw(keeper, amount)` on the vault. It:

- verifies the caller is a [registered keeper](#registry) (cross-calls `KeeperRegistry.get_keeper`),
- checks `amount` against the per-keeper draw cap (`max_draw_per_keeper`) and against available capital (`total_usdc - active_liq`),
- transfers USDC to the keeper, records the outstanding draw under `KeeperDraw(keeper)`, increments `active_liq`, and
- calls `KeeperRegistry.mark_draw` so the registry knows the keeper has an open obligation (and starts the [slash](#slash) clock).

A keeper that draws and never returns is exposed to slashing.

### Return proceeds

A keeper repaying drawn capital plus profit after a fill. Implemented by `return_proceeds(keeper, amount, response_time_ms)` on the vault. It:

- transfers `amount` USDC from the keeper back into the vault,
- computes `profit = amount - drawn` (when `amount > drawn`), adds it to `total_usdc` and `total_profit` — raising the [share price](#share-price),
- clears `active_liq` for the repaid portion and removes the `KeeperDraw` record (cross-calls `KeeperRegistry.clear_draw`), and
- records the execution outcome and `response_time_ms` to the registry via `record_execution`, feeding the keeper's success-rate and average-response-time metrics.

:::warning Only return proceeds against a real draw
If a keeper calls `return_proceeds` with no tracked draw (`drawn == 0`), the contract treats the entire `amount` as donated profit. Off-chain keepers must only return proceeds for capital they actually drew — see the [ProtocolAdapter](#protocoladapter) `VaultClient` contract in the [adapter guide](../developers/adapter-guide).
:::

---

## Keeper and registry terms

### Keeper

An off-chain operator daemon (Go) that monitors a [Blend](#blend) pool, fills profitable [liquidation auctions](#liquidation) with vault capital, swaps seized collateral to USDC, and returns the proceeds. Keepers are stateless — all state is read from chain each cycle, so a keeper restarts safely. Each keeper runs against one keypair and must be [registered](#registry) and [staked](#stake) before it can [draw](#draw). Configuration is via environment variables (`KEEPER_SECRET`, `BLEND_POOL`, `REGISTRY_CONTRACT`, `VAULT_CONTRACT`, …).

### Registry

The `KeeperRegistry` Soroban contract. It is the on-chain source of truth for who may operate as a keeper. It holds each operator's [stake](#stake), tracks performance, and enforces [slashing](#slash). The vault calls it on every [draw](#draw) and [return](#return-proceeds) to verify the keeper and update metrics. Per-keeper state is the `KeeperInfo` struct:

```rust
pub struct KeeperInfo {
    pub addr: Address,
    pub name: String,
    pub stake: i128,
    pub registered_at: u64,
    pub active: bool,
    pub total_executions: u64,
    pub successful_fills: u64,
    pub total_profit: i128,
    pub last_draw_time: u64,
    pub has_active_draw: bool,
    pub total_response_time_ms: u64,
    pub response_count: u64,
}
```

Current testnet address: `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB`.

See [contracts/keeper-registry](../developers/contracts/keeper-registry) for the full reference.

### Stake

USDC an operator must lock to register, set by the registry's `min_stake` config (100 USDC on testnet). `register(operator, name)` pulls exactly `min_stake` from the operator into the registry contract; registration fails with `InsufficientStake` (error `#7`) if `min_stake` is zero. The stake is collateral: it is returned in full on `deregister` (only allowed when the keeper has no active draw) and is reduced by [slashing](#slash) if the keeper misbehaves.

### Slash

The penalty for a keeper that draws capital and fails to return it. `slash(keeper)` can be called when **both** conditions hold:

- the keeper has an open draw (`has_active_draw == true`), and
- more than `slash_timeout` seconds have elapsed since `last_draw_time` (3600 s on testnet).

The slashed amount is `stake * slash_rate_bps / 10_000` (10% on testnet, `slash_rate_bps = 1000`). The slashed USDC is transferred to the [vault](#vault) — compensating depositors — and the keeper's active-draw flag is cleared. Calling `slash` before the timeout elapses, or with no active draw, returns `SlashTimeout` (error `#9`).

### Success rate

A keeper's `successful_fills / total_executions`, recorded on-chain by `record_execution` and surfaced in the dashboard leaderboard. The frontend computes it with `successRate(executions, fills)`, clamped to `[0, 1]`.

### Average response time

The keeper's mean draw-to-return latency in milliseconds, exposed by `avg_response_time_ms(operator)` as `total_response_time_ms / response_count`. Each successful [return](#return-proceeds) contributes one `response_time_ms` sample.

---

## Auction and liquidation terms

### Liquidation

Closing out an unhealthy borrowing position so a lending pool stays solvent. In [Blend](#blend), a position with a [health factor](#health-factor) below 1 can be put up for auction; a keeper [fills](#lot--bid) the auction by paying the bid (covering the bad debt) and receiving the lot (the seized collateral). Nectar pools depositor capital so keepers can fill these auctions and return the profit.

### Health factor

Abbreviated `hf` in code. A position's solvency ratio: collateral value over debt value, both risk-weighted. The keeper computes it as:

```text
HF = Σ(collateral * price * cFactor) / Σ(liability * price / lFactor)
```

where `cFactor` is Blend's collateral factor and `lFactor` its liability factor. `HF >= 1` is healthy; `HF < 1` makes the position liquidatable. Implemented in `CalcHealthFactor(pos, pool)` in the keeper's `blend` package.

### Dutch auction

The descending-price auction model Blend uses for liquidations. Rather than a fixed price, the terms move block-by-block to find the point where a keeper is willing to fill. Blend v2 runs a **two-phase** Dutch auction over 400 blocks:

| Phase | Block range (elapsed) | Lot scales | Bid scales |
| --- | --- | --- | --- |
| Lot scaling | 0–200 | 0% → 100% | held at 100% |
| Bid scaling | 200–400 | held at 100% | 100% → 0% |
| Expired | over 400 | 100% | 0% |

The "fair price" point is at elapsed block 200, where both legs are at 100%. The keeper models this with `PhaseAt(elapsed)`, returning the phase plus the scaled lot and bid percentages.

### Lot / bid

The two sides of an auction:

- **Lot** — what the keeper *receives* (the seized collateral, or backstop interest). During phase 1 the lot scales up from 0% to 100%.
- **Bid** — what the keeper *pays* (covering the borrower's debt, or BLND for interest). During phase 2 the bid scales down from 100% to 0%.

The keeper only fills when it is profitable: `Profitability(auction, pool, currentBlock)` returns `lot_value / bid_cost`, and the keeper acts when that exceeds `MIN_PROFIT` (default `1.02`). Blend distinguishes three auction kinds, each filled through the pool's `submit` with a different request type:

| Auction kind | `AuctionType` | Fill request type | What the lot is |
| --- | --- | --- | --- |
| User liquidation | 0 | 6 | a borrower's collateral |
| Bad debt | 1 | 7 | bToken collateral, in exchange for socialized bad debt |
| Interest | 2 | 8 | accumulated backstop interest, paid for in BLND |

### APY

Annual percentage yield — the annualized return on a vault deposit, driven by [share price](#share-price) growth. The frontend derives it from a reconstructed share-price series via `vaultReturn(series)`:

- it computes `growth = last.sharePrice / first.sharePrice`,
- annualizes as `(growth^(365/days) - 1) * 100` **only** when the series spans at least 7 days,
- otherwise reports the raw cumulative return (annualizing a few minutes of data produces misleading or infinite figures, which the UI never shows as an APY).

The series itself is reconstructed from real on-chain realized profit (`proceeds - drew` per liquidation), never synthesized.

---

## Integration terms

### Blend

[Blend Protocol](https://www.blend.capital/) — the Soroban lending protocol whose liquidation auctions Nectar's keepers fill. Nectar reads Blend's reserves, positions, and auctions, and fills via the pool's `submit` and `new_liquidation_auction` entry points. Testnet pool (Blend V2): `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`. Implemented in the keeper's `blend` package and the `adapters/blend` [adapter](#protocoladapter).

### DeFindex

A Soroban yield-vault protocol. Nectar's `adapters/defindex` adapter rebalances a DeFindex vault toward target asset weights — pure reallocation that draws **no** Nectar capital. It reads `fetch_total_managed_funds`, computes [drift](#drift) versus target weights, and submits a role-gated `rebalance` (requiring `RebalanceManager`/`Manager`). Enabled by the `DEFINDEX_VAULT` env var; disabled when empty. A Tranche 2 deliverable demonstrating the multi-protocol adapter interface.

### Drift

For [DeFindex](#defindex), how far the vault's current asset allocation has moved from its target weights, as a fraction. The adapter only rebalances when drift exceeds `DEFINDEX_DRIFT_BPS` (default 500 bps = 5%); larger drift gets higher [task](#protocoladapter) priority.

### ProtocolAdapter

The Go interface that lets the keeper drive any Soroban protocol through one small contract. [Blend](#blend) liquidations and [DeFindex](#defindex) rebalancing are both adapters.

```go
type ProtocolAdapter interface {
    Name() string
    GetTasks(rpc *soroban.Client) ([]Task, error)
    Execute(rpc *soroban.Client, kp *keypair.Full, task Task, vault VaultClient) (*Result, error)
    EstimateCapital(task Task) (int64, error)
}
```

`GetTasks` is pure discovery (reads only); `Execute` performs one task and draws/returns vault capital via the `VaultClient` only when the task needs it. This interface is the contract extracted into the public **keeper-sdk** (`github.com/Nectar-Network/keeper-sdk`). Adapters in this repo live under `keeper/adapters/<name>/` (module `github.com/nectar-network/keeper`). See the [adapter guide](../developers/adapter-guide).

### Soroswap / Phoenix

The two decentralized exchanges the keeper routes through to convert seized collateral into USDC before [returning proceeds](#return-proceeds):

- **Soroswap** — the **primary** router. Testnet address: `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`. Set via `SOROSWAP_ROUTER`.
- **Phoenix** — the **fallback** venue (an XYK pool for the collateral/USDC pair). Set via `PHOENIX_ROUTER`.

`SwapToUSDC` tries Soroswap first, then Phoenix. Both honor `SLIPPAGE_BPS` (default 100 = 1%), and the realized output is measured by the keeper's USDC balance delta — never synthesized. An empty router env var disables that venue. A bad price (worse than the oracle-anchored slippage floor) is treated as a global decision and aborts the swap on every venue rather than falling back. A Tranche 2 deliverable.

---

## Stellar / Soroban primitives

### stroop / 7-decimals

Stellar's native fixed-point precision. All Nectar USDC amounts use **7 decimals**, so **1 USDC = 10,000,000 stroops** (`10^7`). On-chain amounts are `i128`; in the keeper they are `int64` stroops (7-decimal values stay well within `int64`).

| Display | Stroops (`i128`) |
| --- | --- |
| 1 USDC | `10000000` |
| 100 USDC (testnet stake) | `1000000000` |
| 0.0000001 USDC (1 stroop) | `1` |

:::warning Always reason in stroops on-chain
Contract and keeper code never see decimal USDC — every `amount`, `min_stake`, `deposit_cap`, and `max_draw_per_keeper` is an integer count of stroops. Off-by-`10^7` errors are the most common integration bug.
:::

### SAC (Stellar Asset Contract)

The standard Soroban token contract wrapper for a Stellar asset, exposing the SEP-41 token interface (`transfer`, `balance`, …). Nectar's USDC, the vault's accounting token, and registry stakes are all denominated in a SAC. On **testnet** this is a **mock SAC** (admin-mintable, `name="USD Coin"`, `symbol="USDC"`, `decimals=7`) at `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`. On **mainnet** (Tranche 3) this will be **Circle USDC**.

### Reflector oracle

[Reflector](https://reflector.network/) — the Stellar price-feed oracle. Blend's testnet pool prices its reserves through Reflector at `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI`; the keeper reads those prices to compute [health factors](#health-factor) and [auction profitability](#lot--bid). In Tranche 3 it also becomes the independent reference the [circuit breaker](#circuit-breaker) checks Blend's prices against.

### Circuit breaker

A planned (Tranche 3) safety mechanism that cross-references Blend's reported prices against the independent [Reflector oracle](#reflector-oracle) and auto-pauses keeper activity when prices deviate beyond a threshold. It exists to defend against oracle-manipulation attacks — the same failure class that drained a Blend pool in February 2026 — so a single bad feed cannot drive keepers into unprofitable or attacker-controlled fills.

:::info Not yet shipped
The circuit breaker is a Tranche 3 deliverable and is not present in the current testnet build. The registry's admin `pause` / `unpause` controls and the keeper's `MIN_PROFIT` floor are the protections in effect today.
:::

---

## See also

- [Vault contract reference](../developers/contracts/nectar-vault)
- [Keeper Registry contract reference](../developers/contracts/keeper-registry)
- [Writing a Protocol Adapter](../developers/adapter-guide)
- [Risks](../depositors/risks)
