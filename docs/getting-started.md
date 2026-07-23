---
sidebar_position: 1
title: Getting Started
description: What Nectar Network is, where each audience should go, and the current testnet deployment — addresses, parameters, and the capital flow in one page.
---

# Getting Started

Nectar Network is a pooled liquidation protocol for Soroban DeFi on Stellar. Depositors fund a shared USDC vault; a network of independent keeper operators draws that pooled capital to fill [Blend Protocol](https://blend.capital) liquidation auctions, and realized profit flows back to depositors as a rising share price.

There are no reward tokens, emissions, or lockups. Yield is simply the appreciation of a single LP share price, driven by real liquidation profit captured on-chain.

:::info Current status — Testnet
Nectar is deployed on **Stellar Testnet** and is in **Tranche 2** (DEX integration, multi-protocol adapter interface, Dashboard v2, public keeper SDK). Mainnet ships in Tranche 3 after security hardening and a Circle mainnet USDC cutover. The addresses below are the live, current testnet deployment — a fresh, security-hardened (audit-prep) build now settling in Circle testnet USDC.
:::

## The five-second mental model

1. **Depositors** put USDC into a single-asset vault and receive LP shares.
2. **Keepers** stake USDC into a registry, then continuously monitor Blend pools for positions whose health factor drops below `1.0`.
3. When a position goes underwater, the vault **loans** pooled USDC to a keeper, the keeper **fills** the Dutch auction, swaps the seized collateral to USDC, and **returns** the capital plus profit.
4. The spread between the auction lot and bid is the **yield**, and it raises the share price for every depositor.

If a keeper misbehaves — draws capital and fails to return it before the slash timeout — anyone can trigger a slash that takes a slice of its stake and routes it to the vault.

## What do you want to do?

| Audience | Goal | Start here |
|----------|------|-----------|
| **Depositor** | Deposit USDC and earn liquidation yield | [Deposit Guide](./depositors/deposit-guide) |
| **Keeper operator** | Run an operator node against the live testnet | [Operator Setup](./operators/setup) |
| **Adapter / SDK developer** | Build a custom keeper or protocol adapter | [Keeper SDK](./developers/keeper-sdk) → [Adapter Guide](./developers/adapter-guide) |
| **Integrator** | Read or call the contracts directly | [Architecture](./developers/architecture) → [Contracts](./developers/contracts/nectar-vault) |
| **Just curious** | Understand the design end to end | [How It Works](./how-it-works) |

## Quick links

| Resource | Link |
|----------|------|
| App (Vercel) | [testnet.nectar.monster](https://testnet.nectar.monster) |
| GitHub | [Nectar-Network/nectar](https://github.com/Nectar-Network/nectar) |
| Keeper SDK | [Nectar-Network/keeper-sdk](https://github.com/Nectar-Network/keeper-sdk) |
| Twitter / X | [@nectar_xlm](https://x.com/nectar_xlm) |
| Keeper Alpha API | [keeper-alpha-production.up.railway.app](https://keeper-alpha-production.up.railway.app) |
| Keeper Beta API | [keeper-beta-production.up.railway.app](https://keeper-beta-production.up.railway.app) |
| Full address reference | [Contract Addresses](./reference/contract-addresses) |
| Error codes | [Error Codes](./reference/error-codes) |
| Glossary | [Terms used in these docs](./reference/glossary) |

## Current testnet deployment

These are the live contract IDs the app and keepers use today. Always confirm against the [Contract Addresses](./reference/contract-addresses) reference before sending a transaction.

| Contract | Address |
|----------|---------|
| KeeperRegistry | `CD33A7IGNCOLVQ4EEINBVMVA7IHWXGN57R6YLE5AJEEKPA6VKC2E4IQD` |
| NectarVault | `CDOGQY7NAE3BP4Q7RWBCBLW23Z36RNWNDNXX5DWNIEVMFEWP3GVEPXLR` |
| USDC (Circle testnet SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |
| Reflector oracle (Blend's) | `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` |
| Soroswap router (testnet) | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Admin (deployer) | `GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W` |

:::info Testnet USDC is Circle testnet USDC
The testnet USDC above is **Circle's official testnet USDC**, wrapped as a Stellar Asset Contract (issuer `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, `decimals: 7`). You obtain it from the [Circle testnet faucet](https://faucet.circle.com) — it is not admin-minted. It is still test-only USDC with no real-world value. Mainnet (Tranche 3) uses Circle's mainnet USDC issuer.
:::

### Network parameters

| Parameter | Value |
|-----------|-------|
| Network | Soroban Testnet |
| Network passphrase | `Test SDF Network ; September 2015` |
| Soroban RPC | `https://soroban-testnet.stellar.org:443` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Decimal precision | 7 decimals — **1 USDC = 10,000,000 stroops** |

All monetary values on-chain are `i128` at 7-decimal (stroop) precision. To deposit 1,000 USDC you pass `10000000000`; the UI divides by `1e7` for display.

### Live on-chain configuration

| Vault config | Value |
|--------------|-------|
| `deposit_cap` | 10,000,000 USDC |
| `withdraw_cooldown` | 3,600 s (1 hour) |
| `max_draw_per_keeper` | 10,000 USDC (per single draw) |

| Registry config | Value |
|-----------------|-------|
| `min_stake` | 100 USDC |
| `slash_timeout` | 3,600 s |
| `slash_rate_bps` | 1,000 (10% of stake per slash) |

On the current deployment, `keeper-alpha` is registered and running on testnet (`keeper_count = 1`), staking 100 USDC. `keeper-beta` and `keeper-gamma` re-register shortly, as more Circle testnet USDC is faucet-ed for their stakes.

## Capital flow

A full liquidation cycle is six steps:

1. **Deposit.** A depositor connects a Stellar wallet (Freighter, Albedo, xBull, Lobstr, Hana, or Rabet) and calls `deposit(user, amount)` on the vault. They receive shares at the current price — `total_usdc / total_shares` (the first deposit mints 1:1).
2. **Monitor.** Registered keepers poll the Blend pool (every ~10 s by default) and compute each position's health factor. A position with `HF < 1.0` is liquidatable.
3. **Draw.** Competing keepers each call `draw(keeper, amount)` to borrow pooled USDC. The vault verifies the keeper is registered, enforces `max_draw_per_keeper`, and marks the draw in the registry (starting the slash clock).
4. **Fill.** The keeper submits a fill against the Blend Dutch auction. The lot (seized collateral) grows from 0%→100% over the first 200 blocks; the bid (cost) shrinks 100%→0% over the next 200. The keeper only fills when `lot_value / bid_cost` clears `MIN_PROFIT` (default `1.02`).
5. **Settle & return.** The first confirmed transaction wins; losing keepers receive `ErrAlreadyFilled`, return their unspent draw, and move on — no coordinator, no single point of failure. The winner swaps the collateral to USDC (Soroswap primary, Phoenix fallback) and calls `return_proceeds(keeper, amount, response_time_ms)`, which books the profit and records the keeper's execution metrics on-chain.
6. **Withdraw.** Profit raises `total_usdc`, so the share price ticks up and every depositor's position appreciates. Depositors call `withdraw(user, shares)` to redeem at the higher price, any time after the withdrawal cooldown elapses.

```
Depositors ──deposit──▶ NectarVault ──draw──▶ Keeper ──fill──▶ Blend auction
     ▲                       ▲                   │
     │                       └──return + profit──┘
     └──────── shares appreciate ────────────────┘
```

:::tip Where the data on the app comes from
The frontend reads live state two ways: **read-only Soroban simulation** of the contracts (no fees), and the **keeper REST/SSE API** (`/api/performance`, `/api/state`, `/api/events`). The Dashboard never fabricates numbers — APY is annualized only over windows of 7 days or more, and any unavailable value renders as an em-dash. See [How It Works](./how-it-works) for the full design.
:::

## Tranche roadmap

| Tranche | Theme | Status |
|---------|-------|--------|
| Tranche 1 | MVP — staking, slashing, hardened share math, Blend adapter | Shipped to testnet (security-hardened) |
| Tranche 2 | DEX integration, multi-protocol adapters, Dashboard v2, public keeper SDK | **In progress** |
| Tranche 3 | Mainnet deploy + Circle USDC, oracle circuit breaker, Docker packaging, security hardening | Planned |

## Next steps

- New to the protocol? Read [How It Works](./how-it-works).
- Want to earn yield? Follow the [Deposit Guide](./depositors/deposit-guide), then read [Risks](./depositors/risks).
- Want to operate a keeper? Start with [Operator Setup](./operators/setup) and [Staking](./operators/staking).
- Building on Nectar? See the [Architecture](./developers/architecture) and the [Keeper SDK](./developers/keeper-sdk).
