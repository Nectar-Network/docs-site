---
title: Architecture
description: How Nectar Network fits together — the two Soroban contracts and their cross-contract draw verification, the stateless Go keeper cycle, the multi-protocol adapter layer, the DEX conversion layer, the Next.js frontend, and the end-to-end capital flow.
sidebar_position: 1
---

# Architecture

Nectar Network is a **pooled liquidation protocol** for Soroban DeFi on Stellar. Depositors fund a shared USDC vault; a permissionless network of competing keeper operators draws that capital to fill [Blend Protocol](https://www.blend.capital/) liquidation auctions; realized profit flows back to depositors as a rising LP-share price. There are no reward tokens, no emissions, and no coordinator — yield is simply the appreciation of a single share price.

This page is the developer's map of the whole system: the two on-chain contracts and the one cross-contract call that ties them together, the off-chain keeper's per-cycle loop, the adapter and DEX layers that make the keeper multi-protocol, the frontend, and the data flow that connects all of it.

:::info Testnet, Tranche 2
Everything described here is **live on Soroban Testnet** as of Tranche 2. The vault accepts a **mock USDC SAC** (no real-world value). Mainnet with Circle USDC, an oracle circuit breaker, and Docker packaging ship in Tranche 3. All monetary values are `i128` at **7-decimal precision**: 1 USDC = 10,000,000 stroops.
:::

## The three components

Nectar is a monorepo of three independently deployed components plus a public SDK extracted from the keeper.

| Component | Language / stack | Role | Where it runs |
|---|---|---|---|
| **Contracts** | Rust, Soroban SDK 22.x | Custody, share accounting, keeper registry, staking, slashing | Soroban Testnet |
| **Keeper** | Go 1.24, `stellar/go` SDK | Stateless daemon: monitor Blend, fill auctions, draw/return capital | Railway |
| **Frontend** | Next.js 14 (App Router), TypeScript, Tailwind | Depositor + operator UI, live dashboards | Vercel ([nectarnetwork.fun](https://nectarnetwork.fun)) |
| **keeper-sdk** | Go 1.24 | Public framework so third parties can run their own keepers | `go get` (published Tranche 2) |

The contracts are the source of truth. The keeper holds **no persistent state** — it reads everything it needs from chain each cycle and restarts safely. The frontend never holds funds; it reads on-chain state by read-only simulation and reads keeper telemetry over a REST/SSE API.

## On-chain contracts

Two contracts hold and move depositor money. They are deliberately short and have **no admin path that can move depositor funds**.

```text
contracts/
  keeper-registry/   # operator registration, staking, slashing, performance tracking
  nectar-vault/      # USDC deposit pool, share accounting, keeper capital draws
```

Two further contracts, `liquidation-lab` and `mock-token`, exist under `contracts/` for testing and for the mock USDC SAC; they are not part of the production capital path.

### NectarVault

`NectarVault` is the deposit pool. Depositors call `deposit` to mint LP shares and `withdraw` to burn them; keepers call `draw` to borrow idle capital and `return_proceeds` to repay it plus any profit. Its `VaultState` tracks four figures:

| Field | Meaning |
|---|---|
| `total_usdc` | Total capital owned by the vault (idle **plus** deployed) |
| `total_shares` | Total LP shares outstanding |
| `total_profit` | Cumulative realized liquidation profit |
| `active_liq` | Capital currently out with keepers (outstanding draws) |

Idle USDC physically in the contract is therefore `total_usdc − active_liq`, and `draw` gates on exactly that: `available = total_usdc − active_liq`. Share math is hardened integer division that always floors toward zero, so rounding dust accrues to the pool and never lets a depositor extract more than their proportional value. Config (`VaultConfig`) carries `deposit_cap`, `withdraw_cooldown`, and `max_draw_per_keeper`. See the full [NectarVault reference](./contracts/nectar-vault).

### KeeperRegistry

`KeeperRegistry` is the operator directory and the staking/slashing engine. `register` pulls exactly `min_stake` USDC from the operator into the registry contract and records a `KeeperInfo` (stake, performance counters, active-draw flag). It also exposes the metrics the dashboards read: `total_executions`, `successful_fills`, `total_profit`, and average response time via `avg_response_time_ms`. Config (`RegistryConfig`) carries `min_stake`, `slash_timeout`, `slash_rate_bps`, and the `usdc_token` address. See the full [KeeperRegistry reference](./contracts/keeper-registry).

### The one cross-contract call: the vault verifies the keeper on draw

The contracts are coupled by a single trust relationship: **the vault will only hand capital to a keeper the registry knows about, and it reports that keeper's performance back to the registry.** This is enforced by cross-contract calls during `draw` and `return_proceeds`.

When a keeper calls `NectarVault.draw(keeper, amount)`, the vault — before transferring any USDC — invokes `get_keeper` on the registry to confirm the keeper is registered:

```rust
// contracts/nectar-vault/src/lib.rs
fn require_registered_keeper(env: &Env, keeper: &Address) -> Result<(), VaultError> {
    let registry: Address = env
        .storage()
        .instance()
        .get(&VaultKey::KeeperRegistry)
        .ok_or(VaultError::NotInit)?;
    let _: soroban_sdk::Val = env.invoke_contract(
        &registry,
        &Symbol::new(env, "get_keeper"),
        soroban_sdk::vec![env, keeper.to_val()],
    );
    Ok(())
}
```

The presence check is by *call*: if the keeper is not registered, `get_keeper` reverts with `NotRegistered`, which unwinds the entire `draw` transaction. The vault discards the returned value — it only needs the call to succeed.

After a successful, non-zero draw the vault calls back into the registry to mark the keeper as having an active draw (this starts the slash clock):

```rust
// inside draw(), when amount > 0
registry_call(&env, "mark_draw", &keeper)?;   // registry.mark_draw(vault, keeper)
```

On `return_proceeds`, when the keeper had an outstanding draw, the vault clears the draw and records the execution metrics on-chain:

```rust
// inside return_proceeds(), when drawn > 0
registry_call(&env, "clear_draw", &keeper)?;
registry_record_execution(&env, &keeper, true, profit, response_time_ms)?;
```

In every callback the vault passes its **own** address as the `caller`:

```rust
let vault = env.current_contract_address();
env.invoke_contract(
    &registry,
    &Symbol::new(env, "mark_draw"),
    vec![env, vault.into_val(env), keeper.into_val(env)],
);
```

The registry validates that `caller` equals its stored `VaultAddr` via an internal `require_vault` check — so `mark_draw`, `clear_draw`, and `record_execution` are callable **only by the authorized vault**, never by a keeper directly. (They also fail with `Unauthorized` for any other caller.)

:::tip The slash loop closes outside both contracts
`slash(keeper)` on the registry is **permissionless** — anyone can call it once the keeper `has_active_draw` and more than `slash_timeout` seconds (3600 s on testnet) have elapsed since the draw was marked. The slashed stake (`slash_rate_bps / 10_000` of current stake, currently 10%) is transferred **to the vault**, not burned. So a keeper that draws and never returns is eventually made-good-against by its own bond, and the proceeds land back in the pool. See [Operator Staking](../operators/staking).
:::

## The keeper daemon (Go)

The keeper is a **stateless** Go daemon. It reads all state from chain each cycle, so it restarts safely and several keepers can run against the same vault and pool, racing each other.

```text
keeper/
  main.go        # startup, cycle loop, HTTP/SSE API
  config.go      # env-var parsing
  adapters/      # ProtocolAdapter interface + blend/ and defindex/ implementations
  blend/         # Blend pool loading, position discovery, Dutch-auction profitability
  dex/           # Soroswap (primary) + Phoenix (fallback) collateral→USDC swaps
  vault/         # NectarVault client (Draw, ReturnProceeds, GetState, GetKeeperDraw)
  registry/      # KeeperRegistry client (Register)
  soroban/       # thin JSON-RPC client + retry policy
```

### Startup

`main()` loads `.env` (best-effort) then `LoadConfig()`, which exits the process if any of the three required env vars — `KEEPER_SECRET`, `REGISTRY_CONTRACT`, `VAULT_CONTRACT` — is missing. It parses the keypair, builds a `soroban.Client`, idempotently registers the keeper on chain (a failure is a warning, not fatal — it may already be registered), constructs a DEX `SwapClient` **only if** a Soroswap or Phoenix router is configured, and registers adapters: always a Blend adapter, plus a DeFindex adapter **iff** `DEFINDEX_VAULT` is set.

```go
// keeper/main.go
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
        DriftThreshold: float64(cfg.DriftBps) / 10000.0,
        // ...
    }))
}
```

It then serves an HTTP/SSE API (`/api/state`, `/api/events`, `/api/performance`, `/metrics`, `/healthz`) and starts a `time.Ticker` at `POLL_INTERVAL` seconds (default 10, valid range 3–300).

For the complete environment-variable table see [Operator Configuration](../operators/configuration).

### The per-cycle loop

Each tick runs `cycle()`:

1. **`recoverStaleDraw()` first.** If a prior cycle left capital drawn but unreturned (e.g. a transient `ReturnProceeds` failure after a fill), this returns USDC on hand — capped at the outstanding draw via `vault.GetKeeperDraw` — clearing the draw and dodging a timeout slash. It is a no-op when `USDC_CONTRACT` is unset, when there is no outstanding draw, or on a vault that predates `get_keeper_draw`.
2. **For each registered adapter** (in registration order — Blend, then optionally DeFindex):
   - `tasks, err := ad.GetTasks(k.rpc)` — scan the protocol read-only for actionable work; on error, log and continue to the next adapter.
   - `adapters.SortByPriority(tasks)` — highest-priority task first (stable sort).
   - For each task: `res, err := ad.Execute(k.rpc, k.kp, task, k.vault)`; on error, log and continue to the next task. On success, fold the result into dashboard state.
3. **Refresh dashboard state** — store discovered positions, re-read `vault.GetState`, and (if `KNOWN_DEPOSITORS` is set) read each depositor's `balance`.

A failed adapter or task never aborts the cycle — the loop continues, and the next tick retries from fresh on-chain state. That is the whole point of statelessness.

## The multi-protocol adapter layer

The keeper does not hard-code Blend. It runs against a list of **adapters**, each implementing one interface. This is the contract that was extracted into the public [keeper-sdk](https://github.com/Nectar-Network/keeper-sdk) in Tranche 2 so third parties can write their own strategies.

```go
// keeper/adapters/adapter.go
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

Adapters touch vault capital only through a narrow interface, so they can never call the vault arbitrarily:

```go
type VaultClient interface {
	Draw(amount int64) error
	ReturnProceeds(amount, responseTimeMs int64) error
}
```

A `Task` carries a `Priority` (0–10, higher runs first), an optional `Health` factor, an `EstProfit` ratio, and an opaque `Data` payload that `GetTasks` threads forward to `Execute` (e.g. a pre-loaded pool snapshot, to avoid reloading). A `Result` reports `Drew`, `Proceeds`, `Profit` (= `max(0, proceeds − drew)`), and `ResponseTimeMs` — the latency forwarded to the registry's performance counters.

### Blend adapter (the reference)

The Blend adapter is the production path. `GetTasks` loads the pool, discovers positions from pool events, computes each position's health factor, and emits one `liquidation` task per underwater position (`hf < 1.0`), with priority scaled by how underwater it is (`hf < 0.5` → 10, `< 0.8` → 7, `< 0.95` → 4, else 1). `Execute` creates the user-liquidation auction (at 50%), checks Dutch-auction profitability against `MIN_PROFIT`, draws the bid amount, fills the auction, swaps the seized collateral to USDC, and returns the proceeds.

The Dutch-auction model is two-phase over 400 blocks: the lot scales 0→100% over blocks 0–200 while the bid stays 100%, then the bid scales 100→0% over blocks 200–400 (after which the auction is expired). Profitability is `lot_value / bid_cost` (both oracle-priced); the keeper fills only when that ratio clears `MIN_PROFIT` (default 1.02).

:::tip Graceful contention
Several keepers can race the same auction. The first confirmed fill wins; the losers get `ErrAlreadyFilled`, return the unspent draw unchanged, book no profit or loss, and move on. There is no coordinator and no single point of failure. See [How It Works](../how-it-works).
:::

### DeFindex adapter

Registered only when `DEFINDEX_VAULT` is set, the DeFindex adapter **never draws Nectar vault capital** — it rebalances the DeFindex vault's own funds back to target weights when allocation drift exceeds `DEFINDEX_DRIFT_BPS` (default 500 = 5%). Its `Execute` ignores the supplied `VaultClient`, and `EstimateCapital` is always 0. It is the worked example that the adapter interface is genuinely protocol-agnostic.

## The DEX conversion layer

When a Blend fill seizes non-USDC collateral, the keeper must convert it back to USDC before returning proceeds. The `dex` package closes that loop: **fill auction → receive collateral → swap to USDC → return proceeds.**

- **Soroswap first, Phoenix as fallback.** `SwapToUSDC` tries the Soroswap router; on a hard slippage rejection (`ErrSlippageExceeded`) it does **not** fall back — a bad price is a global decision ("don't dump on another venue"). On a transient venue error it records the attempt and tries Phoenix; if every configured venue fails it returns `ErrNoRoute`.
- **Oracle-anchored slippage floor.** The keeper computes the Blend-oracle-implied USDC value of the collateral and rejects any swap whose quoted output falls below `refValue * (10000 − SLIPPAGE_BPS) / 10000`. A manipulated pool quote cannot trick the keeper into dumping at a bad price.
- **Output is always measured, never synthesized.** Proceeds equal the keeper's actual USDC balance delta across the swap. If a swap sends but the balance does not increase, it errors rather than booking phantom profit.
- **Swaps are not auto-retried.** Re-broadcasting a non-idempotent swap after a post-send timeout could sell collateral twice; the on-chain `amount_out_min` still bounds execution-time slippage, and a transient failure is simply retried next cycle.

:::warning No DEX configured
If neither `SOROSWAP_ROUTER` nor `PHOENIX_ROUTER` is set, the keeper runs without a `SwapClient` and can only return proceeds when the seized lot is already USDC. Non-USDC collateral is held rather than booked as profit.
:::

See [DEX Swaps](../operators/dex-swaps) and [Operator Configuration](../operators/configuration) for `SOROSWAP_ROUTER`, `PHOENIX_ROUTER`, and `SLIPPAGE_BPS`.

## The frontend

The Next.js 14 frontend (App Router, deployed on Vercel at [nectarnetwork.fun](https://nectarnetwork.fun)) is a thin read/write layer over the contracts and the keeper API. It holds no funds and runs no privileged keys.

It reads from **two sources**:

1. **On-chain, by read-only simulation.** Contract IDs are injected via `NEXT_PUBLIC_VAULT_CONTRACT` and `NEXT_PUBLIC_REGISTRY_CONTRACT`; an internal `simulateRead()` helper calls views like `get_state`, `get_config`, `get_depositor`, `balance` (NectarVault) and `get_keepers`, `get_keeper`, `get_config` (KeeperRegistry) with no fees. Writes — `deposit`, `withdraw`, keeper `register`/`deregister` — are built, simulated, assembled, and signed by the connected wallet (Freighter, Albedo, xBull, Lobstr, Hana, or Rabet, via `@creit.tech/stellar-wallets-kit`) on Testnet.
2. **The keeper REST/SSE API**, via `NEXT_PUBLIC_API_URL` (one keeper at a time): `GET /api/performance` (vault state, depositors, keeper stats, liquidation history), `GET /api/state` (live pool positions + health factors), and `GET /api/events` (SSE log stream).

A consistent design principle across the dashboards: **no fabricated data.** Missing values render as an em-dash; APY is only annualized when the share-price series spans at least 7 days, otherwise it is labeled cumulative. Realized profit (`proceeds − drew`) is read from on-chain records, never synthesized.

Routes include the marketing home (`/`), the depositor surface (`/vault`), and Dashboard v2 (`/dashboard`, `/dashboard/keepers`, `/dashboard/liquidations`, `/dashboard/depositor`, and per-address `/dashboard/[address]`).

## End-to-end data flow

Putting the pieces together, here is one full cycle of capital and information.

```text
                ┌──────────────────────────────────────────────────────────────┐
                │                       Soroban Testnet                          │
                │                                                                │
  deposit/      │   ┌──────────────┐   draw() verifies via get_keeper    ┌─────┐ │
  withdraw      │   │              │ ──────────────────────────────────▶ │     │ │
  ┌──────────┐  │   │ NectarVault  │   mark_draw / clear_draw /          │Keep-│ │
  │ Frontend │─▶│   │              │   record_execution (vault-only)     │ er  │ │
  │ (Vercel) │  │   │  total_usdc  │ ◀────────────────────────────────── │Regi-│ │
  └──────────┘  │   │  total_shares│                                     │stry │ │
       ▲        │   │  active_liq  │   slash() permissionless,           │     │ │
       │        │   └──────┬───────┘   stake ──▶ vault                   └──▲──┘ │
   read-only    │          │ draw(amount)            ▲                      │    │
  simulation    │          ▼                         │ return_proceeds      │    │
       │        │   ┌──────────────────────────────────────────────────┐   │    │
       │        │   │              Blend pool + Reflector oracle        │   │    │
       │        └───┴──────────────────────────────────────────────────┴───┴────┘
       │                          ▲ fill auction │ seized collateral
  /api/performance,               │              ▼
  /api/state, SSE          ┌──────┴───────────────────────────┐
       │                   │         Keeper daemon (Go)        │
       └───────────────────│  cycle(): recoverStaleDraw →      │
                           │  GetTasks → SortByPriority →      │
                           │  Execute → swap collateral→USDC   │
                           │           (Soroswap/Phoenix)      │
                           └───────────────────────────────────┘
```

Step by step:

1. **Deposit.** An LP connects a wallet on `/vault` and deposits USDC into NectarVault, minting LP shares at the current share price (`total_usdc / total_shares`).
2. **Monitor.** Each keeper polls the Blend pool (~every 10 s), computes health factors, and queues underwater positions as `liquidation` tasks.
3. **Draw + verify.** The winning keeper calls `draw(keeper, bid)`. The vault calls `get_keeper` on the registry to verify the keeper, transfers the bid, increments `active_liq`, and calls `mark_draw` (starting the slash clock).
4. **Fill + swap.** The keeper fills the Dutch auction, receives seized collateral, and swaps it to USDC on Soroswap (Phoenix fallback), measuring the real balance delta.
5. **Return.** The keeper calls `return_proceeds(keeper, amount, response_time_ms)`. The vault repays `active_liq`, books `profit = max(0, amount − drawn)` into `total_usdc` and `total_profit` (raising share price), then calls `clear_draw` and `record_execution` on the registry.
6. **Settle contention.** Losing keepers get `ErrAlreadyFilled`, return the unspent draw, and book nothing.
7. **Withdraw.** After the cooldown, depositors burn shares for USDC at the now-higher share price. Yield is the share-price appreciation — no tokens, no lockups.

The keeper's stale-draw recovery and the registry's permissionless `slash()` are the two backstops: between them, capital that is drawn but not promptly returned is either auto-recovered next cycle or seized from the keeper's bond into the vault.

## Live testnet deployment

These are the current (Tranche 1 hardened, redeployed 2026-05-24) addresses the keeper and frontend point at. The full table — including deprecated deployments — is in [Contract Addresses](../reference/contract-addresses).

| Contract | Testnet address |
|---|---|
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Reflector oracle | `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

Registry config on testnet: `min_stake` = 100 USDC, `slash_timeout` = 3600 s, `slash_rate_bps` = 1000 (10%). Vault config: `deposit_cap` = 10,000,000 USDC, `withdraw_cooldown` = 3600 s, `max_draw_per_keeper` = 10,000 USDC.

## Repo layout

```text
nectar/                       # this monorepo (Nectar-Network/nectar)
  contracts/                  # Soroban smart contracts (Rust)
    keeper-registry/          #   registration, staking, slashing, performance
    nectar-vault/             #   deposit pool, share accounting, capital draws
    liquidation-lab/          #   test harness (not in production path)
    mock-token/               #   mock USDC SAC for testnet
  keeper/                     # off-chain keeper daemon (Go)
    main.go  config.go        #   startup + cycle loop, env parsing
    adapters/                 #   ProtocolAdapter + blend/ and defindex/
    blend/  dex/  vault/      #   Blend logic, DEX swaps, vault client
    registry/  soroban/       #   registry client, JSON-RPC + retry
  frontend/                   # Next.js 14 web app (Vercel)
    app/  lib/                #   App Router pages, client wrappers/hooks
  scripts/                    # deploy, seed, e2e, register-keepers
  docs/                       # internal documentation
```

The keeper Go module is `github.com/nectar-network/keeper`; the public SDK module is `github.com/Nectar-Network/keeper-sdk`. The two share the same adapter interface and DEX/vault/registry logic — the SDK is the keeper's reusable core, packaged for third-party operators.

## Where to go next

- [NectarVault contract reference](./contracts/nectar-vault) — every function, type, event, and error.
- [KeeperRegistry contract reference](./contracts/keeper-registry) — staking, slashing, and performance tracking in full.
- [Operator Setup](../operators/setup) and [Operator Configuration](../operators/configuration) — the full env-var table and deployment.
- [Adapter Guide](./adapter-guide) — implement `ProtocolAdapter` against the keeper-sdk.
- [keeper-sdk](./keeper-sdk) — the public Go SDK for third-party operators.
- [Contract Addresses](../reference/contract-addresses) and [Error Codes](../reference/error-codes) — the live testnet reference data.
- [How Nectar Works](../how-it-works) — the same loop in plain language, for depositors.
