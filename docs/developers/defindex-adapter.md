---
title: DeFindex Adapter
description: How the Nectar keeper rebalances a DeFindex vault's strategy allocations on drift, implemented as a ProtocolAdapter alongside the Blend liquidation adapter.
sidebar_position: 4
---

# DeFindex Adapter

The DeFindex adapter is Nectar's second protocol integration, shipped in Tranche 2 as a proof that the keeper's [`ProtocolAdapter`](./adapter-guide) interface is genuinely multi-protocol. Where the [Blend adapter](./blend-integration) **draws Nectar vault capital** to fill liquidation auctions, the DeFindex adapter does something fundamentally different: it only reshuffles a DeFindex vault's **own** funds between investment strategies. It never touches Nectar depositor capital.

It watches a single DeFindex vault, detects when any asset's allocation has drifted beyond a configurable threshold from its target weights, and submits a `rebalance` instruction set to bring it back in line.

:::info Source
`keeper/adapters/defindex/adapter.go` — package `defindex`. ABIs verified against `paltalabs/defindex` (`main`).
:::

## What it does

Each monitoring cycle, the keeper calls every registered adapter's `GetTasks`. The DeFindex adapter:

1. Reads the vault's managed funds via `fetch_total_managed_funds` (a simulated, read-only call).
2. For each asset, compares the current weight of every strategy against its target weight.
3. If the **largest** per-strategy drift on any asset exceeds the threshold, it produces a single `rebalance` task carrying a precomputed plan of `Unwind` / `Invest` instructions.
4. On `Execute`, it confirms the keeper holds the `RebalanceManager` or `Manager` role, then submits the `rebalance` call.

Because rebalancing moves only the DeFindex vault's internal allocations, `EstimateCapital` always returns `0` and the adapter never calls `Draw` or `ReturnProceeds` on the Nectar `VaultClient`.

```go
// EstimateCapital is always 0: rebalancing moves the DeFindex vault's own funds.
func (a *Adapter) EstimateCapital(task adapters.Task) (int64, error) {
    return 0, nil
}
```

## The fetch → plan → rebalance flow

### 1. Fetch managed funds

`fetch_total_managed_funds()` returns `Vec<CurrentAssetInvestmentAllocation>`. The adapter decodes each asset entry's `total_amount`, `idle_amount`, `invested_amount`, and per-strategy `strategy_allocations` (each carrying `strategy_address`, `amount`, and `paused`).

```go
func (a *Adapter) fetchManagedFunds(rpc *soroban.Client) ([]assetState, error) {
    sim, err := rpc.SimulateRead(a.cfg.Passphrase, a.cfg.VaultAddr, "fetch_total_managed_funds")
    // ... xdr.SafeUnmarshalBase64(sim.Results[0].XDR, &val) -> parseManagedFunds(val)
}
```

All amounts are 7-decimal stroops (1 USDC = 10,000,000 stroops). Strategy amounts that don't fit in an `int64` decode to `0`, which causes the affected asset to be skipped rather than driving the planner with a wrapped value.

### 2. Plan the rebalance

For each asset, the planner computes the desired amount per strategy from its target weight (`desired = total * weight`) and the delta against the current amount:

- **`delta < -dust`** → emit an **`Unwind`** for the excess (pull funds out of an over-weight strategy).
- **`delta > dust`** and the strategy is **not paused** → emit an **`Invest`** (push funds into an under-weight strategy).

The dust threshold is `100000` stroops (0.01 USDC), so tiny rounding never produces an instruction.

The plan is only kept if the asset's **maximum** per-strategy drift is at or above the configured threshold:

```go
if assetDrift < a.cfg.DriftThreshold {
    continue
}
```

:::tip Invests are capped to freed idle
`Invest` amounts are capped to the idle that unwinds free up, so the vault never tries to deploy more than it holds on hand. When the total requested invest exceeds available idle, each invest is scaled down proportionally using a 128-bit-safe multiply (`scaleDown`) to avoid `int64` overflow on large stroop amounts.
:::

Instructions are ordered **unwinds first, then invests**, so idle capital is freed before it is redeployed:

```go
func (p *rebalancePlan) instructions() []instruction {
    out := make([]instruction, 0, len(p.unwinds)+len(p.invests))
    out = append(out, p.unwinds...) // unwinds first so idle is freed before invests
    out = append(out, p.invests...)
    return out
}
```

### 3. Submit the rebalance

`rebalance(caller: Address, instructions: Vec<Instruction>)` is the only state-changing call. Each `Instruction` is a Soroban enum-with-fields, encoded as `Vec[Symbol(variant), strategy_address, amount]`:

```go
// Soroban enum variant with fields: Vec[Symbol(variant), field0, field1].
instrVals = append(instrVals, soroban.ScvVec(
    soroban.ScvSymbol(in.kind),  // "Unwind" | "Invest"
    stratVal,                     // strategy address
    soroban.ScvI128(in.amount),  // stroop amount (i128)
))
// ...
rpc.Invoke(a.cfg.HorizonURL, kp, a.cfg.Passphrase, a.cfg.VaultAddr, "rebalance",
    callerVal, soroban.ScvVec(instrVals...))
```

:::warning Never auto-retried
The `rebalance` call is **not** retried on failure. A re-broadcast could double-apply the moves (e.g. unwind the same position twice). Transient failures simply resolve on the next monitoring cycle, when fresh state is read and a new plan is computed.
:::

## Target weights

Targets are configured per asset, mapping `asset_address → (strategy_address → weight)`, where each asset's weights should sum to ~1.0. The behavior is scoped per asset so configuring one asset never disturbs another:

| Configuration | Behavior |
| --- | --- |
| Asset has explicit targets | Use the configured weights. |
| Asset absent (or `Targets` empty) | Fall back to **equal weight** across that asset's non-paused strategies. |
| Strategy is `paused` | Target weight `0` → it gets unwound, and the adapter never invests into it. |

:::info Operational default
The keeper daemon wires the adapter without explicit `Targets`, so in production every asset uses the equal-weight fallback across its non-paused strategies. Custom per-asset weights are available on the `Config` struct for embedders using the adapter directly.
:::

## Drift threshold and priority

Drift is measured as the absolute difference between a strategy's current weight (`amount / total`) and its target weight. The largest such difference on an asset is that asset's drift. A task is emitted only when drift reaches the threshold, and the task's priority scales with severity:

| Max drift | Priority |
| --- | --- |
| ≥ 20% | 8 |
| ≥ 10% | 5 |
| otherwise (≥ threshold) | 3 |

Higher-priority tasks run first across all adapters (the keeper sorts every cycle's tasks with `SortByPriority`), so a badly drifted vault is addressed ahead of low-priority work.

## Configuration

The adapter is configured entirely through environment variables on the keeper daemon. It is **disabled unless `DEFINDEX_VAULT` is set** — an empty value means the adapter is never registered.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEFINDEX_VAULT` | _(empty)_ | DeFindex vault contract ID to monitor. Empty disables the adapter. |
| `DEFINDEX_DRIFT_BPS` | `500` | Allocation drift threshold in basis points. `500` = 5%. Valid range `[0, 10000]`. |

`DEFINDEX_DRIFT_BPS` is validated at startup and converted to a fraction before being passed to the adapter:

```go
// keeper/config.go
driftStr := envOr("DEFINDEX_DRIFT_BPS", "500")
// ... range-checked to [0, 10000], else the keeper exits

// keeper/main.go — adapter is only registered when DEFINDEX_VAULT is non-empty
if cfg.DeFindexVault != "" {
    k.protocols = append(k.protocols, defindexadapter.NewAdapter(defindexadapter.Config{
        VaultAddr:      cfg.DeFindexVault,
        HorizonURL:     cfg.HorizonURL,
        Passphrase:     cfg.Passphrase,
        DriftThreshold: float64(cfg.DriftBps) / 10000.0, // 500 bps -> 0.05
    }))
}
```

A `.env` excerpt enabling DeFindex rebalancing on testnet:

```bash
# Required for any keeper
KEEPER_SECRET=S...
REGISTRY_CONTRACT=CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB
VAULT_CONTRACT=CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345

# Enable the DeFindex adapter
DEFINDEX_VAULT=C...          # the DeFindex vault to rebalance
DEFINDEX_DRIFT_BPS=500       # rebalance when any asset drifts >= 5%
```

:::info Network addresses
On testnet the Nectar contracts are the Tranche-1-hardened deployment above, and USDC is a mock Stellar Asset Contract (`CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`). Mainnet (Tranche 3) will use Circle USDC. The DeFindex vault address is operator-supplied — Nectar does not deploy or own it.
:::

## Roles and permissions

`rebalance` is **role-gated** on the DeFindex vault: only the `RebalanceManager` or `Manager` may call it. An unauthorized call would always revert, so the adapter checks the role **before** submitting any transaction — it reads `get_rebalance_manager` and `get_manager` and compares them to the keeper's own address:

```go
func (a *Adapter) isAuthorized(rpc *soroban.Client, addr string) (bool, string) {
    rm, _ := a.readAddress(rpc, "get_rebalance_manager")
    if rm == addr {
        return true, rm
    }
    mgr, _ := a.readAddress(rpc, "get_manager")
    if mgr == addr {
        return true, mgr
    }
    // ...
}
```

If the keeper is not authorized, `Execute` returns a clear, **non-fatal** note instead of broadcasting a doomed transaction:

```
keeper not authorized to rebalance (need RebalanceManager/Manager; on-chain rebalance_manager=... manager=...)
```

:::danger The keeper must be granted the role on-chain
The adapter cannot grant itself any role. The DeFindex vault's owner must assign the keeper's address as `RebalanceManager` (or `Manager`) on the vault before rebalancing can take effect. Until then the adapter still runs harmlessly every cycle, reporting only that it lacks authorization.
:::

## How it plugs in alongside Blend

The DeFindex adapter implements the same [`ProtocolAdapter`](./adapter-guide) interface as Blend and is registered into the keeper's adapter slice at startup. The keeper runs every registered adapter through one loop each cycle: `GetTasks` across all adapters → `SortByPriority` → `Execute` per task → fold each `Result` into dashboard state and registry metrics.

```go
func (a *Adapter) Name() string { return "defindex" }

// Compile-time interface check (in adapter_test.go)
var _ adapters.ProtocolAdapter = (*Adapter)(nil)
```

The contrast with Blend is the whole point of the adapter:

| | Blend adapter | DeFindex adapter |
| --- | --- | --- |
| `Name()` | `"blend"` | `"defindex"` |
| Task `Type` | `liquidation` / `bad_debt` / `interest` | `rebalance` |
| Nectar capital | Draws via `VaultClient`, returns proceeds | None — `EstimateCapital` is `0` |
| State changed | Fills a Dutch auction, swaps collateral to USDC | Moves the DeFindex vault's own funds between strategies |
| Auth model | Open (anyone can fill an auction) | Role-gated (`RebalanceManager` / `Manager`) |
| Retry on failure | Retried (idempotent-safe paths) | Not retried (re-broadcast could double-apply) |

For the full interface contract and conventions every adapter follows, see the [Adapter Interface](./adapter-guide) reference and the [Blend Adapter](./blend-integration) for the capital-drawing flow.
