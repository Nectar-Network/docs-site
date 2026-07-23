---
title: Contract Addresses
description: Authoritative testnet contract addresses, network parameters, and registered keepers for Nectar Network — plus how to verify a deployment with the Stellar CLI.
---

# Contract Addresses

This page is the canonical reference for every on-chain address Nectar Network uses. The values here are the **current security-hardened testnet deployment**, which is the target for all testnet traffic — the keeper daemon, the frontend, and any third-party integration built on the [keeper SDK](../developers/keeper-sdk). These are the audit-prep contracts: they carry a security-review pass (share-inflation defense, cumulative draw caps, slash→vault reconciliation with keeper deactivation, atomic `__constructor` initialization, and a vault pause switch). An external audit is upcoming, not yet complete.

:::info Network status
Nectar Network is live on **Stellar testnet**, now settling in **Circle testnet USDC** (from the [Circle faucet](https://faucet.circle.com)) rather than a mock token. Mainnet is not yet deployed — it ships in **Tranche 3** with Circle's mainnet USDC and production parameters. See [Mainnet](#mainnet-tranche-3) below.
:::

## Testnet deployment

All contracts run on Soroban (Stellar's smart contract platform) and use **7-decimal precision** — `1 USDC = 10,000,000` stroops. Every address below is a Soroban contract ID (`C...`).

| Contract | Address | Explorer |
|----------|---------|----------|
| KeeperRegistry | `CD33A7IGNCOLVQ4EEINBVMVA7IHWXGN57R6YLE5AJEEKPA6VKC2E4IQD` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CD33A7IGNCOLVQ4EEINBVMVA7IHWXGN57R6YLE5AJEEKPA6VKC2E4IQD) |
| NectarVault | `CDOGQY7NAE3BP4Q7RWBCBLW23Z36RNWNDNXX5DWNIEVMFEWP3GVEPXLR` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDOGQY7NAE3BP4Q7RWBCBLW23Z36RNWNDNXX5DWNIEVMFEWP3GVEPXLR) |
| USDC (Circle testnet SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| Blend pool (V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF) |
| Reflector oracle | `CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI) |
| Soroswap router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD) |

What each contract is:

- **KeeperRegistry** — Nectar's operator registry. Tracks keeper stake, status, and on-chain performance, and handles slashing. Owned by Nectar. See [KeeperRegistry contract reference](../developers/contracts/keeper-registry).
- **NectarVault** — Nectar's USDC deposit pool. Holds pooled capital, mints and burns SEP-41 shares, and lends to registered keepers via `draw`. Owned by Nectar. See [NectarVault contract reference](../developers/contracts/nectar-vault).
- **USDC (Circle testnet SAC)** — Circle's official testnet USDC, wrapped as a Stellar Asset Contract (issuer `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, `decimals=7`). Obtain it from the [Circle testnet faucet](https://faucet.circle.com) — it is not admin-minted. It is still test-only USDC with no real-world value, but it is the same asset issuer Circle uses on testnet, not a Nectar mock token. Mainnet (Tranche 3) uses Circle's mainnet USDC.
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
| KeeperRegistry | `usdc_token` | the Circle testnet USDC SAC above |
| NectarVault | `deposit_cap` | 10,000,000 USDC |
| NectarVault | `withdraw_cooldown` | 3600 s (1 h) |
| NectarVault | `max_draw_per_keeper` | 10,000 USDC |

:::warning Testnet values differ from mainnet
These are testnet parameters chosen for fast iteration. Mainnet will use longer cooldowns and production caps set in Tranche 3. Do not hard-code these numbers — read them from the contract at runtime.
:::

## Registered keepers

On this fresh deployment, **keeper-alpha** is registered so far (`keeper_count = 1`), with 100 USDC staked plus liquid balance reserved for transaction fees. **keeper-beta** and **keeper-gamma** re-register shortly, as more Circle testnet USDC is faucet-ed for their stakes.

| Keeper | Account | Live endpoint | Status |
|--------|---------|---------------|--------|
| keeper-alpha | `GCC52N6U63PWM4GVUJK7T54W3X2GW2YKWOLZWN7TX7LMDU6LCOVZ3YVF` | `https://keeper-alpha-production.up.railway.app` | Registered |
| keeper-beta | `GDQ7VA37AB7YRQ6CNNKFFWTR2QQ5Z232GPHX5U6IQCQFENTASBAV6DCV` | `https://keeper-beta-production.up.railway.app` | Re-registering |
| keeper-gamma | `GA472SZPEXVDKEN7BAGJAFVBDB74G37GOAHYFWUPC4Q62DDPTAGIQQXT` | `https://keeper-gamma-production.up.railway.app` | Re-registering |

The deploying admin (registry and vault owner) is:

```text
GATK27P6LOQBSXMVCYBBSKPUYKX5HVZ5AI4AAKF7UEYNKELSEBH53P7W
```

Anyone can register a new keeper by staking USDC into the registry — running your own keeper is the entire point of the [operator setup guide](../operators/setup).

## Mainnet (Tranche 3)

Mainnet is **not yet deployed.** It is scheduled for **Tranche 3** and will differ from testnet in two important ways:

- **Mainnet USDC.** Testnet's Circle testnet USDC is replaced by Circle's mainnet USDC on Stellar. For reference, the mainnet Circle USDC SAC is `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (issuer `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`). The Nectar mainnet contract IDs are published here once the deployment lands.
- **Production parameters.** Deposit caps, draw caps, cooldowns, and an oracle circuit breaker are set for live capital, alongside admin multisig and rate limits.

This page will be updated with the mainnet Nectar addresses and the mainnet network passphrase (`Public Global Stellar Network ; September 2015`) once the deployment lands and passes audit.

## Verifying a contract

Before sending value to any address, confirm it matches what is published here. The [Stellar CLI](https://developers.stellar.org/docs/tools/cli) can fetch a deployed contract's metadata directly from the network.

Inspect a contract's deployment info, including its WASM hash:

```bash
stellar contract info interface \
  --id CDOGQY7NAE3BP4Q7RWBCBLW23Z36RNWNDNXX5DWNIEVMFEWP3GVEPXLR \
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
  --id CDOGQY7NAE3BP4Q7RWBCBLW23Z36RNWNDNXX5DWNIEVMFEWP3GVEPXLR \
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
| Tranche 1 hardened (2026-05-24) | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| Tranche 1 (2026-05-13) | `CCQAW3HWZ4OSBVPOFJ7M64YEJD323SFSIGKEZMTRQI2IUWRNG7QE6RPW` | `CCHR5KXXPIFKQWDEWEPGDLTJMMVG36PCXUPKYSAF3HP3UV6C5Z2AFOZU` |
| Pre-Tranche-1 (2026-03) | `CAWT5HBM25OKGOMJHPFCXWXDWZ7FF436WXRKROTY2VW642FSKLYUKOUB` | `CCXDLRE3IV5225LE3Z776KFB2VWD2MTXOJHAUKFA5RPYDJVOWCMHJ4U4` |

The prior deployment's mock USDC SAC (`CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`) is likewise retired — testnet now settles in Circle testnet USDC (see the table at the top of this page). Two earlier Tranche 1 alternates and a pre-remint deployment (which pointed at a non-mintable USDC) are also retired and intentionally omitted; if you encounter them in old configs, replace them with the current addresses at the top of this page.

## Related references

- [Error codes](./error-codes) — contract error variants you may hit when calling these contracts.
- [Glossary](./glossary) — definitions for stake, draw, share price, slashing, and other terms used above.
