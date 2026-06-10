---
title: Keeper SDK
description: The public Go SDK (github.com/Nectar-Network/keeper-sdk) for building Soroban liquidation and automation keepers — Keeper/NewKeeper/AddAdapter/Run, Config/LoadConfig, the ProtocolAdapter interface, a runnable Blend keeper, and publishing status.
---

# Keeper SDK

`github.com/Nectar-Network/keeper-sdk` is a small Go framework for building **Soroban liquidation and automation keepers** on Stellar. Implement the `ProtocolAdapter` interface (or use the bundled Blend adapter), register it, and call `Run` — the keeper polls each adapter for actionable tasks every cycle and executes them using shared vault capital.

It is the same engine that powers Nectar Network's pooled liquidation protocol, extracted into a public module so third-party operators can run their own keepers against the Nectar vault and registry — or against an entirely different protocol via a custom adapter.

:::info Who this page is for
This is the entry point for **third-party keeper operators and adapter authors** who want to write Go against the SDK. If you just want to run the reference keeper from a container, start with [Operator Setup](../operators/setup) and [Docker](../operators/docker) instead.
:::

## Install

```bash
go get github.com/Nectar-Network/keeper-sdk
```

Requirements:

- **Go 1.24+** (the module declares `go 1.24.0`).
- The only direct external dependency is the [Stellar Go SDK](https://github.com/stellar/go) (`github.com/stellar/go`). Everything else in the module is first-party.

## Module layout

The module root is the public API; subpackages are organized by concern.

| Import path | Contents |
|---|---|
| `github.com/Nectar-Network/keeper-sdk` | `Keeper`, `NewKeeper`, `AddAdapter`, `Run`, `Config`, `LoadConfig`, and the re-exported `ProtocolAdapter` / `Task` / `Result` / `VaultClient` |
| `.../keeper-sdk/adapters` | The `ProtocolAdapter` interface and the `Task` / `Result` / `VaultClient` types it operates on |
| `.../keeper-sdk/adapters/blend` | Reference Blend liquidation adapter (`Adapter`, `Config`, `NewAdapter`) |
| `.../keeper-sdk/dex` | Soroswap (primary) + Phoenix (fallback) collateral → USDC conversion |
| `.../keeper-sdk/soroban` | Thin Soroban JSON-RPC client and ScVal builders |
| `.../keeper-sdk/vault` | NectarVault client (`draw`, `return_proceeds`, state reads) |
| `.../keeper-sdk/registry` | KeeperRegistry client (`register`, registration checks) |

:::note Package name vs. module path
The module is `github.com/Nectar-Network/keeper-sdk`, but the root **package** is named `keeper`. The examples import it under the alias `sdk`, which reads cleanly (`sdk.NewKeeper`, `sdk.LoadConfig`). This page follows the same convention.
:::

## Public API

### `Keeper`

```go
// Keeper monitors protocols and executes profitable tasks using vault capital.
func NewKeeper(cfg Config) (*Keeper, error)

func (k *Keeper) AddAdapter(a ProtocolAdapter)
func (k *Keeper) Run() error

// Accessors useful when constructing adapters or DEX clients.
func (k *Keeper) RPC() *soroban.Client
func (k *Keeper) Keypair() *keypair.Full
func (k *Keeper) Config() Config
```

- **`NewKeeper`** parses `cfg.KeeperSecret` into a signing keypair and wires a vault client. It does **not** start polling; it returns an error if the secret cannot be parsed.
- **`AddAdapter`** registers a `ProtocolAdapter`. Adapters are polled each cycle in the order they were added; tasks within a single cycle run **highest priority first**.
- **`Run`** starts the monitoring loop and **blocks until the process exits**. It returns an error immediately if no adapters are registered.

Each cycle the keeper:

1. Runs a stale-draw recovery pass (returns any capital drawn but not yet returned from a previous cycle, using USDC on hand — capped at the outstanding draw).
2. Calls `GetTasks` on every adapter (read-only scan).
3. Sorts the combined task list by `Priority` (descending, stable).
4. Calls `Execute` on each task, logging the outcome via `log/slog`.

The loop is stateless between restarts: all state is read from chain each cycle, so a keeper can be killed and restarted safely.

### `Config` and `LoadConfig`

`Config` holds everything a keeper needs. Populate it directly, or call `LoadConfig` to read it from environment variables with testnet defaults.

```go
type Config struct {
    RpcURL           string
    HorizonURL       string
    Passphrase       string
    KeeperSecret     string
    KeeperName       string
    RegistryContract string
    VaultContract    string
    BlendPool        string
    UsdcAddr         string
    SoroswapRouter   string
    PhoenixRouter    string
    PollInterval     int     // seconds between cycles (3–300)
    MinProfit        float64 // minimum lot/bid ratio to act (> 0)
    SlippageBps      int     // max swap slippage in basis points (0–10000)
}

func LoadConfig() Config
```

`LoadConfig` reads the following environment variables. The three marked **required** abort the process with a clear message if unset; numeric fields are validated against their ranges and abort on a bad value.

| Env var | Field | Default | Notes |
|---|---|---|---|
| `KEEPER_SECRET` | `KeeperSecret` | — (**required**) | Stellar secret seed (`S...`) the keeper signs with |
| `REGISTRY_CONTRACT` | `RegistryContract` | — (**required**) | KeeperRegistry contract ID |
| `VAULT_CONTRACT` | `VaultContract` | — (**required**) | NectarVault contract ID |
| `SOROBAN_RPC` | `RpcURL` | `https://soroban-testnet.stellar.org:443` | Soroban RPC endpoint |
| `HORIZON_URL` | `HorizonURL` | `https://horizon-testnet.stellar.org` | Horizon endpoint |
| `NETWORK_PASSPHRASE` | `Passphrase` | `Test SDF Network ; September 2015` | Network passphrase |
| `KEEPER_NAME` | `KeeperName` | `nectar-keeper` | Human-readable name (used in logs / registry) |
| `BLEND_POOL` | `BlendPool` | empty | Blend pool to monitor (empty disables the Blend adapter's task discovery) |
| `USDC_CONTRACT` | `UsdcAddr` | empty | USDC token; collateral is swapped into this asset |
| `SOROSWAP_ROUTER` | `SoroswapRouter` | empty | Soroswap router; empty disables Soroswap |
| `PHOENIX_ROUTER` | `PhoenixRouter` | empty | Phoenix XYK pool (fallback); empty disables Phoenix |
| `POLL_INTERVAL` | `PollInterval` | `10` | Seconds between cycles, clamped to `[3, 300]` |
| `MIN_PROFIT` | `MinProfit` | `1.02` | Minimum lot/bid ratio to act; must be `> 0` |
| `SLIPPAGE_BPS` | `SlippageBps` | `100` | Max swap slippage in bps, range `[0, 10000]` (100 = 1%) |

:::tip Amounts are 7-decimal stroops
All on-chain amounts in the SDK (`Task.EstProfit` aside) are `int64` in **7-decimal precision**: `1 USDC = 10,000,000` stroops. `Config.MinProfit` and `Task.EstProfit` are plain ratios (e.g. `1.02`), not stroop amounts.
:::

### `ProtocolAdapter`, `Task`, `Result`, `VaultClient`

These four types live in the `adapters` package and are **re-exported as type aliases** at the module root, so SDK consumers can write `sdk.ProtocolAdapter`, `sdk.Task`, etc. without importing the subpackage:

```go
type (
    ProtocolAdapter = adapters.ProtocolAdapter
    Task            = adapters.Task
    Result          = adapters.Result
    VaultClient     = adapters.VaultClient
)
```

Because they are aliases (`=`), `adapters.Task` and `sdk.Task` are the **same type** — values are interchangeable.

**`ProtocolAdapter`** — implement these four methods to support a protocol:

```go
type ProtocolAdapter interface {
    // Name is the protocol identifier ("blend", "defindex").
    Name() string
    // GetTasks scans the protocol for actionable work this cycle (reads only).
    GetTasks(rpc *soroban.Client) ([]Task, error)
    // Execute performs one task, drawing/returning vault capital as needed.
    Execute(rpc *soroban.Client, kp *keypair.Full, task Task, vault VaultClient) (*Result, error)
    // EstimateCapital returns the USDC needed to execute a task (0 if none).
    EstimateCapital(task Task) (int64, error)
}
```

**`Task`** — one actionable unit of work discovered by an adapter:

```go
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

**`Result`** — the outcome of executing a task. The keeper logs it; the vault/registry consume `Proceeds` and `ResponseTimeMs`:

```go
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

**`VaultClient`** — the minimal capital interface an adapter sees. The keeper supplies a concrete `vault.Client`; adapters never touch RPC or keypair plumbing for draw/return:

```go
type VaultClient interface {
    Draw(amount int64) error
    ReturnProceeds(amount, responseTimeMs int64) error
}
```

:::warning Adapters are libraries, not the daemon
By convention, adapters **do not log** and **never auto-retry state-changing calls** — they return errors and values, and the `Keeper` does the logging. Reads use `rpc.SimulateRead`; state-changing calls use `rpc.Invoke` (a blind re-broadcast could double-execute a fill). Only the vault `draw`/`return_proceeds` helpers retry, and only on transient infrastructure errors. See the [Adapter Guide](./adapter-guide) for the full contract.
:::

## Minimal runnable keeper (Blend)

This is a complete program — about ten lines of real code — that fills Blend liquidations using the bundled adapter. It mirrors `examples/basic`.

```go
package main

import (
    "log"

    sdk "github.com/Nectar-Network/keeper-sdk"
    "github.com/Nectar-Network/keeper-sdk/adapters/blend"
)

func main() {
    cfg := sdk.LoadConfig()

    k, err := sdk.NewKeeper(cfg)
    if err != nil {
        log.Fatal(err)
    }

    // nil DEX client: seized collateral is returned only when it is already
    // USDC. Pass a *dex.SwapClient to enable Soroswap/Phoenix conversion.
    k.AddAdapter(blend.NewAdapter(blend.Config{
        PoolAddr:   cfg.BlendPool,
        MinProfit:  cfg.MinProfit,
        HorizonURL: cfg.HorizonURL,
        Passphrase: cfg.Passphrase,
        UsdcAddr:   cfg.UsdcAddr,
    }, nil))

    if err := k.Run(); err != nil {
        log.Fatal(err)
    }
}
```

Set the environment and run it against testnet. The contract IDs below are the **current Tranche‑1‑hardened testnet deployment**; see [Contract Addresses](../reference/contract-addresses) for the canonical list.

```bash
export KEEPER_SECRET=S...   # your keeper's secret seed
export KEEPER_NAME=my-keeper

export REGISTRY_CONTRACT=CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB
export VAULT_CONTRACT=CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345
export BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
export USDC_CONTRACT=CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW

# Optional: enable collateral → USDC swaps
export SOROSWAP_ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD

go run .
```

:::info USDC on testnet is a mock SAC
On testnet, `USDC_CONTRACT` points at a mock Stellar Asset Contract (`name="USD Coin"`, `symbol="USDC"`, 7 decimals). Mainnet will use **Circle USDC** when the protocol launches there in Tranche 3.
:::

Your keeper must be **registered and staked** before the vault will honor its `draw` calls — the vault verifies each keeper against the registry. See [Staking](../operators/staking) and the [KeeperRegistry contract](./contracts/keeper-registry) for the on-chain flow.

### Enabling collateral conversion

To convert seized collateral into USDC before returning it, build a `dex.SwapClient` from the keeper's shared RPC client and pass it to the adapter. This is what `examples/multi-pool` does (one shared DEX client across several pools):

```go
dexc := dex.NewSwapClient(k.RPC(), dex.Config{
    HorizonURL:     cfg.HorizonURL,
    Passphrase:     cfg.Passphrase,
    UsdcAddr:       cfg.UsdcAddr,
    SoroswapRouter: cfg.SoroswapRouter,
    PhoenixRouter:  cfg.PhoenixRouter,
    SlippageBps:    cfg.SlippageBps,
})

k.AddAdapter(blend.NewAdapter(blend.Config{
    PoolAddr:   cfg.BlendPool,
    MinProfit:  cfg.MinProfit,
    HorizonURL: cfg.HorizonURL,
    Passphrase: cfg.Passphrase,
    UsdcAddr:   cfg.UsdcAddr,
}, dexc))
```

Swaps route through Soroswap first with a Phoenix fallback; the realized output is measured by the keeper's USDC balance delta, never synthesized. Assets that cannot be swapped within the slippage floor are **held**, not booked as phantom profit. See [DEX Swaps](../operators/dex-swaps) for routing and slippage details.

## Writing a custom adapter

Implementing `ProtocolAdapter` lets you run any Soroban protocol through the same loop. The `examples/custom` stub is a compilable skeleton:

```go
type myAdapter struct{}

func (myAdapter) Name() string { return "my-protocol" }

// Reads only — return the tasks you discover this cycle.
func (myAdapter) GetTasks(rpc *soroban.Client) ([]sdk.Task, error) {
    return nil, nil
}

// Draw/return capital via vault as needed; submit txs via rpc.Invoke(...).
func (myAdapter) Execute(rpc *soroban.Client, kp *keypair.Full, task sdk.Task, vault sdk.VaultClient) (*sdk.Result, error) {
    return &sdk.Result{Success: true}, nil
}

func (myAdapter) EstimateCapital(task sdk.Task) (int64, error) { return 0, nil }

// Compile-time check that the interface is satisfied.
var _ sdk.ProtocolAdapter = myAdapter{}
```

Register it exactly like the Blend adapter:

```go
k.AddAdapter(myAdapter{})
```

A full walkthrough — task discovery, profitability gating, drawing and returning capital, and registry response-time reporting — is in the [Adapter Guide](./adapter-guide).

## Examples

The repository ships three runnable programs under [`examples/`](https://github.com/Nectar-Network/keeper-sdk/tree/main/examples):

| Example | What it shows |
|---|---|
| `examples/basic` | Minimal Blend keeper, no DEX conversion (`go run ./examples/basic`) |
| `examples/multi-pool` | Several Blend pools at once + Soroswap/Phoenix conversion (set `BLEND_POOLS` to a comma-separated list; `go run ./examples/multi-pool`) |
| `examples/custom` | A bespoke `ProtocolAdapter` skeleton (`go run ./examples/custom`) |

Each example calls `sdk.LoadConfig()`, so all three are driven by the same environment variables documented above.

## Publishing and versioning status

:::warning Pre-release — not yet tagged
As of Tranche 2, the SDK is being published as a standalone repository. A **pull request is open against `Nectar-Network/keeper-sdk`** to land the extracted code. The module is **not yet tagged**, so `go get github.com/Nectar-Network/keeper-sdk` currently resolves to a pseudo-version (commit-based). Pin to a commit SHA until a tag exists.
:::

The release sequence is:

1. The extraction PR merges into `Nectar-Network/keeper-sdk`'s default branch.
2. A semantic-version tag is pushed:

   ```bash
   git tag v0.1.0 && git push origin main --tags
   ```

3. The **Go module proxy indexes the tag on the first `go get`** of that version — no separate publish step is required. After that:

   ```bash
   go get github.com/Nectar-Network/keeper-sdk@v0.1.0
   ```

Until `v1.0.0`, treat the public API as unstable: it may change between minor versions. Production deployments should pin an exact version (or commit) rather than tracking `latest`.

## See also

- [Operator Setup](../operators/setup) — run the reference keeper without writing Go
- [Configuration](../operators/configuration) — every environment variable in depth
- [Strategies](../operators/strategies) — conservative / balanced / aggressive profit thresholds
- [Adapter Guide](./adapter-guide) — implement `ProtocolAdapter` for a new protocol
- [Blend Integration](./blend-integration) — how the reference adapter fills auctions
- [NectarVault contract](./contracts/nectar-vault) and [KeeperRegistry contract](./contracts/keeper-registry)
- [Contract Addresses](../reference/contract-addresses) · [Error Codes](../reference/error-codes) · [Glossary](../reference/glossary)
