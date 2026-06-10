---
title: Architecture
description: Technical architecture of Nectar Network
---

# Architecture

Nectar is two Soroban contracts (`NectarVault`, `KeeperRegistry`) plus an off-chain Go keeper that talks to both. There is no off-chain coordinator, no off-chain solver, no shared sequencer. All trust is anchored on-chain.

## Components

```
┌─────────────────────────────────────────────────────┐
│  Off-chain                                          │
│  ┌──────────────┐    ┌──────────────────────────┐   │
│  │ Frontend     │    │ Keeper daemon (Go)       │   │
│  │ (Next.js)    │    │  - blend client          │   │
│  │              │    │  - dex adapter           │   │
│  │              │    │  - registry client       │   │
│  │              │    │  - vault client          │   │
│  └──────┬───────┘    └─────────────┬────────────┘   │
└─────────┼──────────────────────────┼────────────────┘
          │                          │
          │       Soroban RPC        │
          │                          │
┌─────────┼──────────────────────────┼────────────────┐
│  On-chain                          │                │
│  ┌──────▼──────────┐   ┌───────────▼─────────────┐  │
│  │ NectarVault     │◄──┤ KeeperRegistry          │  │
│  │  - shares       │──►│  - keeper records       │  │
│  │  - draws        │   │  - stake / slash        │  │
│  │  - withdrawals  │   │  - performance stats    │  │
│  └─────────────────┘   └─────────────────────────┘  │
│                                                     │
│  ┌─────────────────┐   ┌─────────────────────────┐  │
│  │ Blend Pool      │   │ Reflector Oracle        │  │
│  │ (external)      │   │ (external)              │  │
│  └─────────────────┘   └─────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Contract responsibilities

### NectarVault

- Custody of pooled USDC.
- Mint / burn shares on `deposit` / `claim_withdraw`.
- `draw` and `return_proceeds` — the keeper hot path.
- Track total assets and share supply for share-price calculation.
- Emit events for indexers and the dashboard.

### KeeperRegistry

- Registration of keepers with stake.
- Stake accounting (escrow, slashing, withdrawal cooldown).
- Per-keeper performance tracking (success/failure counts, slashes).
- Authorization helper: `assert_active(keeper)` is called by the vault to gate `draw`.

The registry has **no funds custody for depositor capital** — only keeper stake. Separating stake (registry) from working capital (vault) keeps each contract small.

## Cross-contract calls

Two flows cross the contract boundary:

### draw

```
keeper ──draw(amount)──► NectarVault
                          ├── KeeperRegistry::assert_active(keeper)
                          ├── KeeperRegistry::mark_draw(keeper, amount)
                          └── transfer USDC to keeper
```

`mark_draw` increments the keeper's outstanding draw. If `outstanding > stake * leverage_factor`, the call reverts.

### return_proceeds

```
keeper ──return_proceeds(amount)──► NectarVault
                                     ├── transfer USDC from keeper to vault
                                     ├── compute profit = amount - principal
                                     ├── KeeperRegistry::clear_draw(keeper, principal)
                                     ├── KeeperRegistry::record_execution(keeper, profit)
                                     └── (if loss) KeeperRegistry::slash(keeper, loss)
```

## Data model

See the per-contract pages for full struct definitions. The shapes:

- `NectarVault::Depositor { shares: u128, withdrawal_request: Option<WithdrawalRequest> }`
- `NectarVault::VaultState { total_assets: u128, total_shares: u128, paused: bool }`
- `KeeperRegistry::KeeperInfo { name, stake, outstanding_draw, stats, status }`

Storage is keyed by enum `DataKey` to avoid string-key collisions.

## Determinism & ordering

There is no off-chain ordering. Every state change is atomic in a single Soroban transaction. Two keepers racing to draw against the same auction will both succeed at the *vault* level — the loser's submit to *Blend* will fail with `auction_already_filled`, at which point the loser calls `cancel_draw` to return funds without recording a fill. The registry is the source of truth for "is this keeper currently drawing."

## External dependencies

- **Blend Protocol.** The lending pool whose auctions Nectar fills. Read-only dependency — Nectar holds no Blend governance and does not interact with Blend's `submit()` from inside the contract.
- **Reflector Oracle.** Blend's oracle source. Not called directly by Nectar contracts; the keeper uses it for sanity checks before submitting.
- **DEX (Aqua, Soroswap).** The keeper sells seized collateral on a DEX during the return path. The vault contract is DEX-agnostic.

## Upgrade model

There is **no upgrade path** in Tranche 1 contracts. Both contracts are deployed without an admin key. To roll out a new version, a new contract is deployed, depositors withdraw, and migration is voluntary.

Tranche 3 will introduce time-locked admin upgrades (governed by a multisig / on-chain DAO), gated by a 7-day timelock.

## Build a deeper integration

- Want to add a new DEX adapter? See [Adapter Guide](./adapter-guide).
- Want to embed Nectar yield in your app? Read the share token (SEP-41 compatible) directly. Vault address and ABI in [Contract Addresses](../reference/contract-addresses).
- Want to support a different lending pool (not Blend)? Open an issue. The keeper has a `ProtocolAdapter` interface but only the Blend implementation is shipped today.
