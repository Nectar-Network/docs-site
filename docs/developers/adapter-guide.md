---
title: Writing a Protocol Adapter
description: Implement the Go ProtocolAdapter interface so the Nectar keeper can monitor and act on a new Soroban protocol — task discovery, execution, vault capital, and priority sorting.
---

# Writing a Protocol Adapter

The Nectar keeper drives any number of Soroban protocols through one small Go interface, `adapters.ProtocolAdapter`. Blend liquidations and DeFindex rebalancing are both implemented as adapters, and the keeper runs every registered adapter in the same loop each cycle. This guide shows how to add your own.

The interface is intentionally minimal and protocol-agnostic — it is the contract extracted into the public [keeper-sdk](https://github.com/Nectar-Network/keeper-sdk) in Tranche 2. Keep adapters free of keeper-daemon concerns: no logging, no global state, no config files.

:::info Module layout
The keeper module path is `github.com/nectar-network/keeper`. The interface lives in `keeper/adapters/adapter.go`; concrete adapters live under `keeper/adapters/<name>/`. The two reference implementations are `keeper/adapters/blend` (draws vault capital) and `keeper/adapters/defindex` (moves a foreign vault's own funds).
:::

## The interface

Every protocol integration implements these four methods, verbatim from `keeper/adapters/adapter.go`:

```go
// ProtocolAdapter is implemented by every protocol integration.
type ProtocolAdapter interface {
	// Name is the protocol identifier ("blend", "defindex").
	Name() string
	// GetTasks scans the protocol for actionable work this cycle.
	GetTasks(rpc *soroban.Client) ([]Task, error)
	// Execute performs one task, drawing/returning vault capital as needed.
	Execute(rpc *soroban.Client, kp *keypair.Full, task Task, vault VaultClient) (*Result, error)
	// EstimateCapital returns the USDC needed to execute a task (0 if none).
	EstimateCapital(task Task) (int64, error)
}
```

| Method | Responsibility |
| --- | --- |
| `Name()` | Stable identifier (`"blend"`, `"defindex"`). Used in logs, metrics, and `Task.Protocol`. |
| `GetTasks(rpc)` | Pure discovery for this cycle. Read-only (`SimulateRead`), no writes. Return `nil, nil` when there is nothing to do or the adapter is unconfigured. |
| `Execute(rpc, kp, task, vault)` | Perform exactly one task. Draw/return capital through `vault` only when the task actually consumes Nectar capital. Return a `Result`; never log. |
| `EstimateCapital(task)` | Best-effort USDC required (in stroops). Return `0` when the task uses no Nectar capital (e.g. a DeFindex rebalance). |

:::tip Compile-time enforcement
Add `var _ adapters.ProtocolAdapter = (*Adapter)(nil)` in your package so the compiler verifies the interface is satisfied — the same guard both reference adapters use.
:::

## The Task / Result / VaultClient types

These three types are the entire data contract between an adapter and the keeper.

### Task

A `Task` is one actionable unit of work discovered by `GetTasks` and handed back to `Execute`.

```go
// Task is one actionable unit of work discovered by an adapter.
type Task struct {
	Protocol  string  // adapter Name(), e.g. "blend"
	Type      string  // "liquidation", "bad_debt", "interest", "rebalance", …
	Target    string  // position address, vault id, …
	Priority  int     // 0=low … 10=critical; higher runs first
	EstProfit float64 // estimated profit ratio (lot/bid), 0 if unknown
	Health    float64 // optional health factor for the target, 0 if n/a
	Data      any     // adapter-specific payload threaded back to Execute
}
```

`Data` is `any`: stash whatever `Execute` needs (a pool snapshot, a precomputed plan) so you never re-read the same state twice. Type-assert it back in `Execute` and tolerate a failed assertion gracefully.

:::warning Health is overloaded
The keeper only treats `Task.Health` as a health factor when `Type == "liquidation"`, surfacing it on the dashboard. Other task types (e.g. the DeFindex adapter, which puts max drift into `Health`) must not assume the keeper interprets it as a health factor. Pick a `Type` string that reflects what the task does.
:::

### Result

`Execute` returns a `Result` describing the on-chain outcome. The keeper folds it into dashboard state and registry metrics.

```go
// Result is the outcome of executing a Task.
type Result struct {
	Success        bool
	TxHash         string
	Block          int64         // ledger the task acted on (0 if n/a)
	Drew           int64         // vault capital drawn (0 if none)
	Proceeds       int64         // USDC returned to the vault (0 if none)
	Profit         int64         // realized profit booked, max(0, proceeds-drew)
	ResponseTimeMs int64         // observed draw→act latency for registry metrics
	Latency        time.Duration // total Execute wall-clock
	Note           string        // human-readable status (e.g. "already filled")
}
```

When a task could not be completed but did not error (not profitable, already filled, missing role), return a `Result{Success: false, Note: "…"}` rather than a Go `error`. The keeper logs the note at info level and moves on. Reserve returned `error`s for genuine failures (RPC down, encode failure, an unexpected revert).

:::danger Report measured outcomes, never synthesized ones
`Drew`, `Proceeds`, and `Profit` are in 7-decimal stroops (1 USDC = `10000000`). Populate them from real balance deltas and the amounts actually returned to the vault. Never fabricate profit — the dashboard and the registry's success-rate / average-response-time metrics depend on these being truthful.
:::

### VaultClient

`VaultClient` is the capital interface. The keeper passes a concrete `vault.Client` (bound to one keeper keypair and the configured `NectarVault`), so adapters never touch RPC or keypair plumbing for draw/return.

```go
// VaultClient is the capital interface adapters use; the keeper supplies a
// concrete implementation (vault.Client).
type VaultClient interface {
	Draw(amount int64) error
	ReturnProceeds(amount, responseTimeMs int64) error
}
```

- `Draw(amount)` — request `amount` stroops of USDC capital from the vault for this keeper. The vault verifies the keeper against the [KeeperRegistry](./contracts/keeper-registry) and enforces `max_draw_per_keeper` (10,000 USDC on testnet) before transferring.
- `ReturnProceeds(amount, responseTimeMs)` — send `amount` stroops back to the vault and forward the observed draw→fill latency for the registry's average-response-time metric. Pass `0` for `responseTimeMs` when this keeper did not actually execute (e.g. another keeper won the auction); the registry then skips the response-time update.

:::warning Only return when you actually drew
If you call `ReturnProceeds` without a matching `Draw`, the vault's `drawn == 0` path books the returned amount as cost-free profit, inflating depositor yield. Gate the return on a positive draw, exactly as the Blend adapter does (`if bidAmt > 0 && res.Proceeds > 0`). Both `Draw` and `ReturnProceeds` reject non-positive amounts.
:::

## The GetTasks / Execute contract

The two methods split cleanly into **discovery** (read-only) and **action** (state-changing).

### GetTasks: pure discovery

`GetTasks` runs once per adapter per cycle. It must:

1. **Bail out cheaply when unconfigured.** Return `nil, nil` if your contract address is empty. The keeper only constructs an adapter when its config is present, but the guard keeps the adapter safe to instantiate.
2. **Read only.** Use `rpc.SimulateRead(passphrase, contractID, fn, args...)` for every state read — it simulates against a dummy account and never signs or submits.
3. **Decode and detect.** Walk the returned `xdr.ScVal`, compute whatever signal drives the work (a health factor below 1.0, an allocation drift beyond threshold), and emit a `Task` per unit of work.
4. **Return `nil, nil` for "nothing to do"** and an actual `error` only for read failures you want surfaced as a scan error in the event log.

The Blend adapter, for example, loads the pool, fetches positions, and emits one `liquidation` task per position whose health factor is below `1.0`, stashing the pool snapshot in `Task.Data` so `Execute` reuses it:

```go
func (a *Adapter) GetTasks(rpc *soroban.Client) ([]adapters.Task, error) {
	if a.cfg.PoolAddr == "" {
		return nil, nil
	}
	pool, err := core.LoadPool(rpc, a.cfg.Passphrase, a.cfg.PoolAddr)
	if err != nil {
		return nil, fmt.Errorf("load pool: %w", err)
	}
	ledger, err := rpc.LatestLedger()
	if err != nil {
		return nil, fmt.Errorf("latest ledger: %w", err)
	}
	positions, err := core.GetPositions(rpc, a.cfg.Passphrase, a.cfg.PoolAddr, ledger-1000)
	if err != nil {
		return nil, fmt.Errorf("get positions: %w", err)
	}

	var tasks []adapters.Task
	for i := range positions {
		pos := &positions[i]
		hf := core.CalcHealthFactor(*pos, pool)
		if hf >= 1.0 {
			continue
		}
		tasks = append(tasks, adapters.Task{
			Protocol: a.Name(),
			Type:     "liquidation",
			Target:   pos.Address,
			Priority: priorityFromHF(hf),
			Health:   hf,
			Data:     taskData{pool: pool},
		})
	}
	return tasks, nil
}
```

### Execute: action

`Execute` performs exactly one task. The keeper calls it once per task, in priority order. It must:

1. **Recover the payload.** Type-assert `task.Data`; on a failed assertion return `&adapters.Result{Note: "…"}, nil` rather than panicking.
2. **Pre-check anything that would make the transaction revert.** If your protocol gates the action behind a role (the DeFindex `rebalance` needs `RebalanceManager` or `Manager`), confirm it with a read and return a non-fatal `Result{Note: …}` instead of submitting a doomed transaction.
3. **Draw capital only when needed**, sized to the actual requirement, via `vault.Draw`.
4. **Submit the write** with `rpc.Invoke(horizonURL, kp, passphrase, contractID, fn, args...)`, which builds, simulates, assembles, signs, sends, and awaits the transaction, returning a `*TxResult` whose `Hash` you put in `Result.TxHash`.
5. **Measure the outcome and return proceeds** — only when you actually drew and there is something to send.
6. **Build the `Result`** from real values.

:::danger Never auto-retry state-changing calls inside Execute
Use `rpc.Invoke` (single attempt) for writes from an adapter. A blind re-broadcast can double-execute a non-idempotent action — a swap sold twice, a rebalance applied twice. Transient failures are simply retried on the next cycle, ten seconds later. (The keeper's own `vault.Draw` / `vault.ReturnProceeds` use a bounded `InvokeWithRetry` because moving vault capital is idempotent at the contract level; your protocol-specific writes are not.)
:::

## Priority sorting

`Task.Priority` runs `0` (low) to `10` (critical). After `GetTasks`, the keeper calls `adapters.SortByPriority`, a stable descending sort, so the most urgent tasks execute first:

```go
// SortByPriority orders tasks highest-priority first (stable).
func SortByPriority(tasks []Task) {
	sort.SliceStable(tasks, func(i, j int) bool {
		return tasks[i].Priority > tasks[j].Priority
	})
}
```

Because the sort is stable, tasks with equal priority keep their `GetTasks` order. Map your protocol's urgency signal to a priority. The Blend adapter maps health factor — the more underwater, the more urgent:

| Condition | Priority |
| --- | --- |
| `hf < 0.5` | 10 |
| `hf < 0.8` | 7 |
| `hf < 0.95` | 4 |
| otherwise (`hf < 1.0`) | 1 |

The DeFindex adapter maps allocation drift: `>= 0.2` → 8, `>= 0.1` → 5, otherwise 3. Choose thresholds that put the actions you most want to win first.

## Returning proceeds

For a capital-drawing adapter (Blend is the canonical example), the accounting flow inside `Execute` is:

1. Determine the bid (capital required), then `Draw` it: `res.Drew = bidAmt; vc.Draw(bidAmt)`.
2. Perform the protocol action (fill the auction).
3. Convert any seized collateral to USDC and **measure** the real proceeds (`a.swapCollateral(...)`). Assets whose swap fails are held, not booked as phantom profit.
4. `res.Profit = max(0, res.Proceeds - bidAmt)`.
5. Return only when capital was actually drawn **and** there is something to send: `if bidAmt > 0 && res.Proceeds > 0 { vc.ReturnProceeds(res.Proceeds, res.ResponseTimeMs) }`.

```go
res := &adapters.Result{Block: ledger, Drew: bidAmt}

drawStart := time.Now()
if bidAmt > 0 {
	if err := vc.Draw(bidAmt); err != nil {
		return nil, fmt.Errorf("vault draw: %w", err)
	}
}

fillErr := core.FillAuction(rpc, a.cfg.HorizonURL, kp, a.cfg.Passphrase, a.cfg.PoolAddr, user)
switch {
case fillErr == nil:
	res.Success = true
	res.ResponseTimeMs = time.Since(drawStart).Milliseconds()
	if bidAmt > 0 {
		res.Proceeds = a.swapCollateral(kp, pool, auction)
		res.Profit = res.Proceeds - bidAmt
		if res.Profit < 0 {
			res.Profit = 0
		}
	}
case fillErr == core.ErrAlreadyFilled:
	// Another keeper won. We drew capital but never spent it — return it
	// unchanged (no profit, no loss).
	res.Note = "already filled by another keeper"
	res.Proceeds = bidAmt
default:
	return nil, fmt.Errorf("fill auction: %w", fillErr)
}

if bidAmt > 0 && res.Proceeds > 0 {
	if err := vc.ReturnProceeds(res.Proceeds, res.ResponseTimeMs); err != nil {
		res.Note = fmt.Sprintf("return proceeds failed (capital outstanding): %v", err)
	}
}
```

:::warning Outstanding draws are at slash risk
If a fill succeeds but produces zero returnable proceeds, the keeper has drawn capital it cannot return this cycle, and the registry can slash on a draw timeout. The keeper's `recoverStaleDraw` routine attempts to make the vault whole from the keeper's USDC on hand at the start of each cycle, and a failed `ReturnProceeds` is treated as non-fatal (the fill already happened on-chain) — but design your adapter to return promptly. A non-capital adapter (DeFindex) never touches `Draw`/`ReturnProceeds` and leaves `Drew`/`Proceeds`/`Profit` at zero.
:::

## A worked skeleton adapter

A complete, compiling skeleton. Replace the discovery and execution bodies with your protocol's logic.

```go
package myproto

import (
	"fmt"
	"time"

	"github.com/stellar/go/keypair"
	"github.com/stellar/go/xdr"

	"github.com/nectar-network/keeper/adapters"
	"github.com/nectar-network/keeper/soroban"
)

// Config holds the per-adapter settings not passed on each call.
type Config struct {
	ContractAddr string
	HorizonURL   string
	Passphrase   string
}

// Adapter implements adapters.ProtocolAdapter for MyProto.
type Adapter struct {
	cfg Config
}

func NewAdapter(cfg Config) *Adapter { return &Adapter{cfg: cfg} }

func (a *Adapter) Name() string { return "myproto" }

// plan is the per-task payload threaded from GetTasks to Execute.
type plan struct {
	amount int64
}

func (a *Adapter) GetTasks(rpc *soroban.Client) ([]adapters.Task, error) {
	if a.cfg.ContractAddr == "" {
		return nil, nil // unconfigured: nothing to do
	}
	sim, err := rpc.SimulateRead(a.cfg.Passphrase, a.cfg.ContractAddr, "get_status")
	if err != nil {
		return nil, fmt.Errorf("get_status: %w", err)
	}
	if sim.Error != "" {
		return nil, fmt.Errorf("get_status: %s", sim.Error)
	}
	if len(sim.Results) == 0 {
		return nil, nil
	}
	var val xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(sim.Results[0].XDR, &val); err != nil {
		return nil, err
	}

	// ...decode val, detect work, compute amount & priority...
	if !workIsNeeded(val) {
		return nil, nil
	}
	return []adapters.Task{{
		Protocol: a.Name(),
		Type:     "myaction",
		Target:   a.cfg.ContractAddr,
		Priority: 5,
		Data:     plan{amount: amountFrom(val)},
	}}, nil
}

func (a *Adapter) Execute(rpc *soroban.Client, kp *keypair.Full, task adapters.Task, vc adapters.VaultClient) (*adapters.Result, error) {
	start := time.Now()
	p, ok := task.Data.(plan)
	if !ok {
		return &adapters.Result{Note: "missing plan"}, nil
	}

	// If your protocol gates the call behind a role, pre-check it here and
	// return a non-fatal Result instead of submitting a doomed tx.

	// If (and only if) the task needs Nectar capital:
	//   if p.amount > 0 { if err := vc.Draw(p.amount); err != nil { return nil, err } }

	arg := soroban.ScvI128(p.amount)
	tx, err := rpc.Invoke(a.cfg.HorizonURL, kp, a.cfg.Passphrase, a.cfg.ContractAddr, "do_action", arg)
	if err != nil {
		return nil, fmt.Errorf("do_action: %w", err) // not retried in-cycle
	}

	res := &adapters.Result{
		Success: true,
		TxHash:  tx.Hash,
		Latency: time.Since(start),
		Note:    "did myaction",
	}
	// If you drew capital, measure real proceeds and return only when > 0:
	//   if p.amount > 0 && res.Proceeds > 0 { vc.ReturnProceeds(res.Proceeds, res.ResponseTimeMs) }
	return res, nil
}

func (a *Adapter) EstimateCapital(task adapters.Task) (int64, error) {
	return 0, nil // 0 when the task uses no Nectar capital
}

var _ adapters.ProtocolAdapter = (*Adapter)(nil) // compile-time interface check
```

### Soroban encode / decode quick reference

Build call arguments with the `soroban.Scv*` builders and decode results by walking the `xdr.ScVal`.

| Need | Use |
| --- | --- |
| Address argument | `soroban.ScvAddress(addr)` (returns `(xdr.ScVal, error)`) |
| `i128` (stroop amounts) | `soroban.ScvI128(n int64)` |
| `u32` / `u64` | `soroban.ScvU32(n)` / `soroban.ScvU64(n)` |
| Symbol | `soroban.ScvSymbol(s)` |
| String | `soroban.ScvString(s)` |
| Vec / tuple | `soroban.ScvVec(vals...)` |
| `Option::None` / unit | `soroban.ScvVoid()` |

- A Soroban **struct** decodes as an `ScMap` keyed by `Symbol` (sorted lexicographically).
- An **enum variant with fields** encodes as `ScvVec(ScvSymbol(variant), field0, …)` — e.g. the DeFindex `Instruction::Unwind(Address, i128)` is `soroban.ScvVec(soroban.ScvSymbol("Unwind"), stratVal, soroban.ScvI128(amt))`.
- Decode with `xdr.SafeUnmarshalBase64(sim.Results[0].XDR, &val)`, then walk the value. Note that `val.Vec` and `val.Map` are double pointers (`**val.Vec`, `**val.Map`).
- Convert a decoded `ScAddress` back to a `G…`/`C…` string with `soroban.ParseAddress`.

## How the keeper polls adapters each cycle

The keeper is stateless: it reads all state from chain every cycle and restarts safely. On startup it registers with the [KeeperRegistry](./contracts/keeper-registry), then builds the adapter list. The Blend adapter is always built; the DeFindex adapter is only appended when `DEFINDEX_VAULT` is set:

```go
k.protocols = append(k.protocols, blendadapter.NewAdapter(blendadapter.Config{
	PoolAddr:   cfg.BlendPool,
	MinProfit:  cfg.MinProfit,
	HorizonURL: cfg.HorizonURL,
	Passphrase: cfg.Passphrase,
	UsdcAddr:   cfg.UsdcAddr,
}, dexc))
if cfg.DeFindexVault != "" {
	k.protocols = append(k.protocols, defindexadapter.NewAdapter(defindexadapter.Config{
		VaultAddr:      cfg.DeFindexVault,
		HorizonURL:     cfg.HorizonURL,
		Passphrase:     cfg.Passphrase,
		DriftThreshold: float64(cfg.DriftBps) / 10000.0,
	}))
}
```

A `time.Ticker` fires every `POLL_INTERVAL` seconds (default 10). Each tick runs `cycle()`, which:

1. **Recovers any stale draw** (`recoverStaleDraw`) — returns up to the outstanding drawn amount from the keeper's USDC on hand, clearing draws left over from a prior cycle's failed return.
2. **For each registered adapter**, calls `GetTasks(rpc)`. A scan error is logged and the loop continues to the next adapter (one protocol failing never blocks the others).
3. **Sorts the tasks** with `adapters.SortByPriority` (highest first).
4. **Executes each task** with `ad.Execute(k.rpc, k.kp, task, k.vault)`, passing the shared `vault.Client` as the `VaultClient`. An `Execute` error is logged and the loop continues to the next task.
5. **Folds each `Result`** into dashboard state and metrics via `recordResult` — appending a liquidation record and updating per-keeper profit only for `Type == "liquidation"`; other task types just log.
6. **Refreshes** vault state and known-depositor balances for the API.

In other words, the per-cycle flow is: `GetTasks` → `SortByPriority` → `Execute` per task → `recordResult`, run for every adapter in the slice, every `POLL_INTERVAL` seconds.

:::tip Adapters are libraries, not daemons
An adapter never logs, never holds global state, and never schedules its own work — the keeper owns the cycle. Keep all timing, logging, and metrics outside the adapter so it stays portable into the [keeper-sdk](https://github.com/Nectar-Network/keeper-sdk).
:::

## Reference implementations

| Adapter | What it shows |
| --- | --- |
| `keeper/adapters/blend` | The capital-drawing flow: draw vault capital, fill a Blend auction, swap seized collateral to USDC via the `dex` package, return real proceeds. Demonstrates the `Task.Data` snapshot pattern and the "only return when you drew" rule. |
| `keeper/adapters/defindex` | A non-capital adapter: reads `fetch_total_managed_funds`, computes allocation drift vs target weights, and submits a role-gated `rebalance`. Demonstrates struct/enum encode-decode, the `RebalanceManager`/`Manager` auth pre-check, and 128-bit-safe amount math. |

## Testing

Follow the repo convention: unit-test the **pure logic** (planning, drift / profitability math, decoders) and the **no-RPC guards** (`GetTasks` returning `nil, nil` on an empty contract address, validation errors). Full on-chain execution is verified on testnet, not mocked.

```bash
cd keeper && go test -race ./...
```

Add the compile-time interface check to your package so the build fails if a signature drifts:

```go
var _ adapters.ProtocolAdapter = (*Adapter)(nil)
```

## Testnet reference

Current Tranche-2 testnet contracts your adapter and the keeper interact with:

| Contract | Address |
| --- | --- |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| USDC (mock SAC, 7 decimals) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

:::info Amounts are 7-decimal stroops
Every USDC value in `Task`, `Result`, and the `VaultClient` is in stroops: 1 USDC = `10000000`. On testnet, USDC is a mock Stellar Asset Contract; on mainnet (Tranche 3) it will be Circle USDC. The vault's `max_draw_per_keeper` is 10,000 USDC on testnet.
:::
