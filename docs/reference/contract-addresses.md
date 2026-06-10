---
title: Contract Addresses
description: Authoritative testnet contract addresses, network parameters, and registered keepers for Nectar Network — plus how to verify a deployment with the Stellar CLI.
---

# Contract Addresses

This page is the canonical reference for every on-chain address Nectar Network uses. The values here are the **Tranche 1 hardened deployment (2026-05-24)**, which is the current target for all testnet traffic — the keeper daemon, the frontend, and any third-party integration built on the [keeper SDK](../developers/keeper-sdk).

:::info Network status
Nectar Network is live on **Stellar testnet** only. Mainnet is not yet deployed — it ships in **Tranche 3** with Circle USDC and production parameters. See [Mainnet](#mainnet-tranche-3) below.
:::

## Testnet deployment

All contracts run on Soroban (Stellar's smart contract platform) and use **7-decimal precision** — `1 USDC = 10,000,000` stroops. Every address below is a Soroban contract ID (`C...`).

| Contract | Address | Explorer |
|----------|---------|----------|
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB) |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345) |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW) |
| Blend pool (V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF) |
| Reflector oracle | `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI) |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD) |

What each contract is:

- **KeeperRegistry** — Nectar's operator registry. Tracks keeper stake, status, and on-chain performance, and handles slashing. Owned by Nectar. See [KeeperRegistry contract reference](../developers/contracts/keeper-registry).
- **NectarVault** — Nectar's USDC deposit pool. Holds pooled capital, mints and burns SEP-41 shares, and lends to registered keepers via `draw`. Owned by Nectar. See [NectarVault contract reference](../developers/contracts/nectar-vault).
- **USDC (mock SAC)** — A Stellar Asset Contract minted for testing (`name="USD Coin"`, `symbol="USDC"`, `decimals=7`). It is **not** real USDC; it has no value and exists only on testnet. Mainnet will use Circle USDC.
- **Blend pool (V2)** — The Blend Protocol lending pool the default keeper monitors for liquidation auctions. Owned by Blend, not Nectar. See [Blend integration](../developers/blend-integration).
- **Reflector oracle** — The price feed Blend's pool uses to compute health factors. Owned by Reflector, not Nectar.
- **Soroswap router** — The DEX router the keeper uses to swap seized collateral back into USDC after a fill (Tranche 2). Owned by Soroswap, not Nectar. See [DEX swaps](../operators/dex-swaps).

:::tip Phoenix and DeFindex
The keeper also supports a Phoenix XYK pool as a fallback DEX (`PHOENIX_ROUTER`) and a DeFindex vault rebalancer (`DEFINDEX_VAULT`). Both are **opt-in and disabled by default** — set the corresponding environment variable to a contract ID to enable them. There is no canonical Nectar-owned Phoenix or DeFindex address; operators point at whichever venue they choose. See [Configuration](../operators/configuration).
:::

## Network parameters

| Parameter | Testnet value |
|-----------|---------------|
| Soroban RPC | `https://soroban-testnet.stellar.org:443` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Friendbot (fund a testnet account) | `https://friendbot.stellar.org` |

These map directly onto the keeper's `SOROBAN_RPC` and `HORIZON_URL` environment variables. The full list of keeper environment variables lives in [Configuration](../operators/configuration).

## Deployment parameters

The current registry and vault were initialized with these values. Amounts are shown in USDC; on-chain they are stored as stroops (multiply by `10,000,000`).

| Contract | Parameter | Value |
|----------|-----------|-------|
| KeeperRegistry | `min_stake` | 100 USDC |
| KeeperRegistry | `slash_timeout` | 3600 s (1 h) |
| KeeperRegistry | `slash_rate_bps` | 1000 (10%) |
| KeeperRegistry | `usdc_token` | the mock USDC SAC above |
| NectarVault | `deposit_cap` | 10,000,000 USDC |
| NectarVault | `withdraw_cooldown` | 3600 s (1 h) |
| NectarVault | `max_draw_per_keeper` | 10,000 USDC |

:::warning Testnet values differ from mainnet
These are testnet parameters chosen for fast iteration. Mainnet will use longer cooldowns and production caps set in Tranche 3. Do not hard-code these numbers — read them from the contract at runtime.
:::

## Registered keepers

Two keepers are registered on the current registry, each with 100 USDC staked plus 100 USDC of liquid balance reserved for transaction fees.

| Keeper | Account | Live endpoint |
|--------|---------|---------------|
| keeper-alpha | `GCC52N6U63PWM4GVUJK7T54W3X2GW2YKWOLZWN7TX7LMDU6LCOVZ3YVF` | `https://keeper-alpha-production.up.railway.app` |
| keeper-beta | `GDQ7VA37AB7YRQ6CNNKFFWTR2QQ5Z232GPHX5U6IQCQFENTASBAV6DCV` | `https://keeper-beta-production.up.railway.app` |

The deploying admin (registry and vault owner) is:

```text
GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W
```

Anyone can register a new keeper by staking USDC into the registry — running your own keeper is the entire point of the [operator setup guide](../operators/setup).

## Mainnet (Tranche 3)

Mainnet is **not yet deployed.** It is scheduled for **Tranche 3** and will differ from testnet in two important ways:

- **Real USDC.** The mock SAC is replaced by Circle's USDC on Stellar mainnet.
- **Production parameters.** Deposit caps, draw caps, cooldowns, and an oracle circuit breaker are set for live capital, alongside admin multisig and rate limits.

This page will be updated with the mainnet addresses and the mainnet network passphrase (`Public Global Stellar Network ; September 2015`) once the deployment lands and passes audit.

## Verifying a contract

Before sending value to any address, confirm it matches what is published here. The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) can fetch a deployed contract's metadata directly from the network.

Inspect a contract's deployment info, including its WASM hash:

```bash
stellar contract info interface \
  --id CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345 \
  --network testnet
```

If `testnet` is not yet a configured network alias, add it once:

```bash
stellar network add testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"
```

You can also read live state without sending a transaction. For example, to print the vault's current configuration:

```bash
stellar contract invoke \
  --id CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345 \
  --network testnet \
  --source-account default \
  -- get_state
```

:::tip Cross-check on the explorer
The fastest sanity check is the explorer column in the table above. Open the contract on [stellar.expert](https://stellar.expert/explorer/testnet) and confirm the contract ID, the WASM hash, and recent activity match what you expect before trusting an address.
:::

## Deprecated deployments

These addresses are superseded. They are listed only for historical reference — **do not target them.**

| Deployment | KeeperRegistry | NectarVault |
|------------|----------------|-------------|
| Tranche 1 (2026-05-13) | `CCQAW3HWZ4OSBVPOFJ7M64YEJD323SFSIGKEZMTRQI2IUWRNG7QE6RPW` | `CCHR5KXXPIFKQWDEWEPGDLTJMMVG36PCXUPKYSAF3HP3UV6C5Z2AFOZU` |
| Pre-Tranche-1 (2026-03) | `CAWT5HBM25OKGOMJHPFCXWXDWZ7FF436WXRKROTY2VW642FSKLYUKOUB` | `CCXDLRE3IV5225LE3Z776KFB2VWD2MTXOJHAUKFA5RPYDJVOWCMHJ4U4` |

Two earlier Tranche 1 alternates and a pre-remint deployment (which pointed at a non-mintable USDC) are also retired and intentionally omitted; if you encounter them in old configs, replace them with the current addresses at the top of this page.

## Related references

- [Error codes](./error-codes) — contract error variants you may hit when calling these contracts.
- [Glossary](./glossary) — definitions for stake, draw, share price, slashing, and other terms used above.
