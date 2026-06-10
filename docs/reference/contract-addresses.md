---
title: Contract Addresses
description: Deployed contract addresses for testnet and mainnet
---

# Contract Addresses

:::info
Mainnet contracts are not yet deployed. Mainnet ships in Tranche 3 after audit.
:::

## Testnet (Soroban)

| Contract | Address | Explorer |
|----------|---------|----------|
| KeeperRegistry | `CREGISTRY_PLACEHOLDER_REPLACE_AT_DEPLOY` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CREGISTRY_PLACEHOLDER_REPLACE_AT_DEPLOY) |
| NectarVault | `CVAULT_PLACEHOLDER_REPLACE_AT_DEPLOY` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CVAULT_PLACEHOLDER_REPLACE_AT_DEPLOY) |
| USDC SAC | `CAVBAVD6CZ46FEDKJHBQIJF7EFAZDTRNS65G73QS5ZYI3VK5E2JFPQ4J` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAVBAVD6CZ46FEDKJHBQIJF7EFAZDTRNS65G73QS5ZYI3VK5E2JFPQ4J) |

The Blend pools that the default keeper monitors:

| Pool | Address | Notes |
|------|---------|-------|
| Blend Testnet Pool A | `CBLEND_POOL_PLACEHOLDER` | Primary monitored pool |

:::warning
The `_PLACEHOLDER` addresses above will be replaced with the actual deployed addresses once Tranche 1 contracts ship to testnet. Check the [GitHub repo](https://github.com/Nectar-Network/nectar-poc) for the current `deployments/testnet.toml` file — that is the authoritative source.
:::

## Network parameters

| Parameter | Testnet value |
|-----------|---------------|
| RPC | `https://soroban-testnet.stellar.org:443` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |

## Mainnet (coming Tranche 3)

Not yet deployed. Track the `deployments/mainnet.toml` file in the repo for the rollout.

## Verifying a contract

Before sending a transaction, verify the contract you're calling matches what is published here:

```bash
stellar contract info \
  --id $CONTRACT_ID \
  --network testnet
```

Compare the WASM hash against the published hash in the deployments file.
