---
sidebar_position: 1
title: Getting Started
---

# Getting Started

Nectar Network is a pooled liquidation protocol for Soroban DeFi on Stellar. Users deposit USDC into a vault to earn yield from automated liquidation activity. Keeper operators use that pooled capital to fill [Blend Protocol](https://blend.capital) liquidation auctions.

## What do you want to do?

- **Deposit USDC and earn yield** → [Depositor Guide](./depositors/deposit-guide)
- **Run a keeper operator** → [Operator Setup](./operators/setup)
- **Build on Nectar (integrate, write adapters)** → [Architecture](./developers/architecture)
- **Understand how it works** → [How It Works](./how-it-works)

## Quick Links

| Resource | Link |
|----------|------|
| App | [nectarnetwork.fun](https://nectarnetwork.fun) |
| GitHub | [Nectar-Network/nectar-poc](https://github.com/Nectar-Network/nectar-poc) |
| Contracts (Testnet) | [Contract Addresses](./reference/contract-addresses) |
| Glossary | [Terms used in these docs](./reference/glossary) |

:::info
Nectar is currently deployed on Stellar **testnet**. Mainnet ships in Tranche 3 after audit.
:::

## Five-second mental model

1. Depositors put USDC into a single-asset vault and receive shares.
2. Keepers stake USDC into a registry and monitor Blend pools.
3. When a Blend position becomes liquidatable, the vault loans pooled USDC to a keeper, the keeper fills the auction, and the proceeds flow back into the vault.
4. The spread between the auction lot and bid is the yield.

If a keeper misbehaves (fails to return funds in time, fills an unprofitable auction), its stake is slashed.
