---
title: Contributing
description: How to set up the Nectar Network monorepo, build and test each component, follow the code style, and open a pull request that passes CI.
---

# Contributing

Nectar Network is a pooled liquidation protocol for Soroban DeFi on Stellar. The
protocol lives in a single monorepo with three components — Soroban smart
contracts (Rust), the keeper daemon (Go), and the web app (Next.js) — plus the
public [`keeper-sdk`](#where-the-sdk-lives) for third-party keeper operators.

This page covers everything you need to land a change: the repository layout,
how to build and test each component, the code-style rules CI enforces, and the
pull-request conventions.

:::info CI is the source of truth
Every rule below is enforced by the GitHub Actions workflow at
`.github/workflows/ci.yml`, which runs on every push to `main` and every pull
request. If a command in this page passes locally, it will pass in CI. Run the
relevant commands before you push.
:::

## Repository layout

The monorepo is organized by component. Each component is independently
buildable and tested.

```
contracts/          # Soroban smart contracts (Rust, soroban-sdk 22.x)
  keeper-registry/  # Operator registration, staking, slashing, performance tracking
  nectar-vault/     # USDC deposit pool, share accounting, keeper capital draws
  mock-token/       # Mock USDC SAC used on testnet and in tests
  liquidation-lab/  # Test harness contract for end-to-end liquidation scenarios
keeper/             # Off-chain keeper daemon (Go) — module github.com/nectar-network/keeper
  blend/            # Blend Protocol pool monitoring
  vault/            # NectarVault client (draw, return proceeds)
  registry/         # KeeperRegistry client
  dex/              # DEX integration: Soroswap + Phoenix collateral swaps
  adapters/         # ProtocolAdapter interface + blend and defindex adapters
  soroban/          # Thin Soroban JSON-RPC client (simulate, invoke, retry)
frontend/           # Next.js 14 App Router web app (TypeScript, Tailwind)
  app/              # Pages and React components
  lib/              # Soroban client wrappers, SSE, API helpers
scripts/            # Deployment, seeding, registration, e2e test scripts
docs/               # Internal documentation (adapter guide, tranche specs)
```

The Rust workspace is defined at the repository root (`Cargo.toml`) with four
members: `keeper-registry`, `nectar-vault`, `mock-token`, and `liquidation-lab`.
The keeper is a single Go module rooted at `keeper/`. The frontend is a separate
npm project rooted at `frontend/`.

## Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| Rust toolchain | stable | contracts |
| `wasm32-unknown-unknown` target | — | building contract WASM |
| Go | 1.22+ (CI pins 1.22; `go.mod` declares 1.24.0) | keeper |
| Node.js | 20 | frontend |
| `stellar` CLI | latest | contract deploy (testnet) |

Install the Rust WASM target once:

```bash
rustup target add wasm32-unknown-unknown
```

## Building and testing each component

Run a component's checks from its own directory. The three command groups below
mirror the three CI jobs exactly.

### Contracts (Rust / Soroban)

```bash
cd contracts
cargo test
```

CI tests each package individually and then builds the release WASM:

```bash
cargo test -p keeper-registry
cargo test -p nectar-vault
cargo test -p mock-token
cargo build --target wasm32-unknown-unknown --release
```

Contract tests use the `soroban-sdk` testutils with `mock_all_auths`. All values
use 7-decimal precision — the Stellar native scale where **1 USDC = 10,000,000
stroops**. Keep that in mind when writing share-math and amount assertions.

:::tip Storage conventions
Persistent storage holds per-user data (`KeeperInfo`, `Depositor`); instance
storage holds config and singleton state (`VaultState`, `admin`). Cross-contract
calls flow one way: `NectarVault` calls `KeeperRegistry.get_keeper()` to verify a
keeper before `draw()`.
:::

### Keeper (Go)

```bash
cd keeper
go build ./...
go test -race ./...
```

CI runs the test suite with the race detector, a single run, and a timeout:

```bash
go test -race -count=1 -timeout 60s ./...
```

The keeper is **stateless** — it reads all state from chain each cycle and
restarts safely. Tests follow that model: unit-test the pure logic (profitability
math, drift/slippage, XDR decoders) and the no-RPC guards; full on-chain
execution is verified against testnet, not mocked.

### Frontend (Next.js / TypeScript)

```bash
cd frontend
npm ci --ignore-scripts
npm run build
```

`npm run build` runs `next build`, which type-checks against the strict
`tsconfig.json` and produces the production bundle — passing it is the frontend
gate.

:::note Why `--ignore-scripts`
`--ignore-scripts` skips native `gyp` builds for transitive deps such as `usb`
(pulled in by `stellar-wallets-kit`'s optional Trezor/Ledger support). Hardware
wallets negotiate USB via WebUSB in the browser at runtime, so the Node-side
`usb` binary is never needed at build time.
:::

## Code style

CI rejects formatting and lint violations. Match the existing files; comments
only where logic is genuinely counterintuitive.

### Rust

- 4-space indent, `cargo fmt` enforced.
- `cargo clippy` with **no warnings**.
- **No `.unwrap()` in production paths** — only in tests.
- Error handling: return `Result<T, ContractError>` everywhere.
- Domain abbreviations: `hf` (health factor), `pos` (position), `amt` (amount).

```rust
fn draw(env: &Env, keeper: Address, amt: i128) -> Result<(), ContractError> {
    let registry = RegistryClient::new(env, &registry_addr(env));
    if registry.get_keeper(&keeper).is_none() {
        return Err(ContractError::UnknownKeeper);
    }
    // ...
    Ok(())
}
```

### Go

- `gofmt` standard formatting — **CI fails if `gofmt -l .` prints any file.** Run
  `gofmt -w .` from `keeper/` before committing.
- `golangci-lint` is the project lint standard.
- **No `panic()` in production paths** — return errors.
- Structured logging with `log/slog`:

  ```go
  slog.Info("healthy", "pos", addr, "hf", hf)
  ```

- **Standard-library only** in production code. The sole runtime dependencies are
  the Stellar Go SDK (`github.com/stellar/go`) and `godotenv`; `testify` is
  allowed in tests. Do not add other dependencies.

:::warning Never auto-retry non-idempotent writes
Reads go through `SimulateRead`; writes through `rpc.Invoke`. Do **not** add
automatic retries around state-changing calls — a re-broadcast can
double-execute a non-idempotent action (a swap sold twice, a rebalance applied
twice). Transient failures are retried on the next polling cycle instead.
:::

### TypeScript

- 2-space indent, Prettier formatting.
- Strict TypeScript (`"strict": true` in `tsconfig.json`).
- State management with Zustand — no Redux.
- Styling with Tailwind only — no CSS modules.

## Pull request conventions

1. **Branch off `main`.** Open pull requests against `main`; that is the only
   branch CI runs against and the branch that auto-deploys (frontend to Vercel,
   keeper to Railway).
2. **Keep PRs scoped to one component where possible.** A contracts change, a
   keeper change, and a frontend change are independent CI jobs — small,
   single-purpose PRs review and bisect more easily.
3. **Conventional commit subjects.** Follow the style already in the history:
   `type(scope): summary`, e.g.

   ```
   feat(frontend): APY chart + liquidation feed components
   fix(keeper): classify tx_too_late as retryable
   docs(adapters): adapter development guide
   ```

   Common scopes: `contracts`, `keeper`, `frontend`, `adapters`, `scripts`.
4. **Green CI is mandatory.** All three jobs (`Rust Contracts`, `Go Keeper`,
   `Next.js Frontend`) must pass before merge. Run the commands above locally
   first.
5. **Don't commit secrets or addresses into source.** Keeper configuration is
   environment-variables only (no config files); see `.env.example` for the full
   list. Deployed contract addresses live in `wallets.md` / `wallets.json`, which
   are the source of truth — update those rather than hard-coding IDs.

:::danger No fabricated on-chain data
Adapters and tests must report **real, measured** on-chain outcomes (balance
deltas, returned amounts). Never synthesize profit, latency, or success. The
dashboard and the on-chain performance metrics depend on this.
:::

## Where the SDK lives

The public Go SDK for third-party keeper operators is a **separate repository**:
[`github.com/Nectar-Network/keeper-sdk`](https://github.com/Nectar-Network/keeper-sdk),
published in Tranche 2.

The `ProtocolAdapter` interface that the SDK exposes is implemented by the
adapters in this repo under `keeper/adapters/` — `blend` (draws vault capital,
fills a Blend auction, swaps seized collateral to USDC, returns proceeds) and
`defindex` (a pure, capital-free rebalance). When you write a new adapter, follow
the in-repo guide at `docs/ADAPTER-GUIDE.md`, and add the compile-time interface
check so the contract is enforced at build time:

```go
var _ adapters.ProtocolAdapter = (*Adapter)(nil)
```

## Working against testnet

The current Tranche-1-hardened testnet deployment (as of 2026-05-24) is the
target for end-to-end work. USDC on testnet is a **mock SAC** (Stellar Asset
Contract); mainnet will use Circle USDC in Tranche 3.

| Contract | Address |
| --- | --- |
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Soroswap router (testnet) | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |

Deploy and initialize contracts with the helper script (builds, optimizes,
deploys, initializes):

```bash
./scripts/deploy.sh
```

Run the full local stack — contracts client, keeper, and frontend — with:

```bash
docker-compose up
```

## License

Nectar Network is released under the MIT license.
