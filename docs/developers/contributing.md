---
title: Contributing
description: How to contribute code or docs to Nectar Network
---

# Contributing

Nectar is open source under the MIT license. The protocol repo is [github.com/Nectar-Network/nectar-poc](https://github.com/Nectar-Network/nectar-poc); this docs site lives at [github.com/Nectar-Network/docs-site](https://github.com/Nectar-Network/docs-site).

## Repo layout

```
nectar-poc/
├── contracts/
│   ├── registry/          # KeeperRegistry (Rust / Soroban)
│   └── vault/             # NectarVault (Rust / Soroban)
├── keeper/
│   ├── cmd/               # CLI entry points (binary)
│   └── pkg/
│       ├── nectar/        # SDK (public)
│       ├── blend/         # Blend adapter
│       ├── dex/           # DEX adapters (Aqua, Soroswap)
│       └── ...
├── frontend/              # Next.js dashboard
└── tests/                 # End-to-end tests against testnet
```

## Code style

### Rust (contracts)

- `cargo fmt` and `cargo clippy --all-targets` must pass with zero warnings.
- Public functions: explicit `Result<T, Error>` return; never panic in contract code.
- `DataKey` enum for all storage keys — no string keys.
- New errors: append to `enum Error`, never reuse a code.

### Go (keeper)

- `gofmt` and `go vet ./...` clean.
- `golangci-lint run` clean (config in `.golangci.yml`).
- No `panic` outside of `main`. Return errors.
- Public types in `pkg/nectar` only; everything else stays internal.
- Tests: table-driven, no global state, no network calls without `-tags integration`.

### TypeScript (frontend)

- `pnpm lint` and `pnpm typecheck` clean.
- React components are server-first; opt into client only for interactivity.
- Don't introduce new state managers — Zustand is the chosen one.

### Markdown (docs)

- Terse, developer-focused. No marketing voice.
- Code blocks must be runnable, not pseudocode.
- Headings: sentence case, no emojis.
- Each page should be useful without other pages — link, but assume some readers land cold.

## Branch & PR

1. Branch from `main` with a descriptive name: `feature/...`, `fix/...`, `docs/...`.
2. One logical change per PR. If you find unrelated cleanup, open a separate PR.
3. Update tests with the change.
4. Run the full test suite locally:
   ```bash
   make test          # contracts + keeper unit tests
   make test-e2e      # spins testnet contracts, slow
   ```
5. Open a PR. Fill in the template (description, test plan, breaking changes).

## Commit messages

Conventional Commits, lowercase scope:

```
feat(vault): add per-keeper draw cap
fix(keeper): handle simulate/submit race in fill
docs(operators): clarify slashing conditions
```

Body explains the **why**. The diff explains the **what**.

## Testing contracts

Soroban unit tests use the SDK harness:

```bash
cd contracts/vault
cargo test --features testutils
```

For integration tests against a real testnet deployment:

```bash
make test-e2e
```

This deploys fresh contracts to testnet, runs a deposit / draw / return cycle, and verifies state. Requires a funded `TEST_ADMIN_SECRET` env var.

## Testing the keeper

```bash
cd keeper
go test ./...                    # unit
go test -tags integration ./...  # integration (testnet)
```

The integration tag spins fresh contracts, registers a test keeper, and runs the full loop against a stubbed Blend pool.

## Security

If you find a vulnerability:

- **Do not open a public issue.**
- Email `security@nectarnetwork.fun` with a description and reproduction.
- The team responds within 48 hours.
- A bounty program launches in Tranche 2; until then, severe disclosures earn case-by-case rewards.

## Areas that need help

A non-exhaustive list of high-leverage contributions:

- **Adapters** for non-Blend lending protocols (Fxdx, others). See [Adapter Guide](./adapter-guide).
- **DEX adapters** (Phoenix, others) for the keeper to sell collateral.
- **Indexer / subgraph** to power the dashboard's historical view.
- **Operator tooling** — better logging, metrics dashboards, alerting recipes.
- **Translation** of these docs into other languages.

Open an issue tagged `help-wanted` if you want to claim something.

## License

MIT. By submitting a contribution, you agree to license it under the same.
