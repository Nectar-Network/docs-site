---
title: Deposit Guide
description: Step-by-step guide to depositing USDC into the Nectar vault with Freighter on Stellar testnet
---

# Deposit Guide

This guide walks you through depositing USDC into the [NectarVault](../developers/contracts/nectar-vault) and receiving LP shares. Yield accrues as share price rises — there is no claim step.

:::info Testnet only
Nectar is currently deployed on **Stellar testnet**. The USDC here is a mock Stellar Asset Contract (SAC), not Circle USDC — it has no real-world value. Mainnet (with Circle USDC) ships in Tranche 3 after audit.
:::

You'll need three things: a Freighter wallet, testnet XLM (for transaction fees), and testnet USDC. The whole process takes about five minutes.

## 1. Install Freighter and switch to testnet

Install [Freighter](https://www.freighter.app/) from the Chrome / Brave / Firefox extension store, create a wallet, and **back up your recovery phrase**.

Then open Freighter's settings and switch the network to **Testnet**. Nectar's frontend is locked to testnet, so a transaction signed on the wrong network will fail to submit.

:::warning
Your public key (starts with `G…`) is the address you'll deposit from. Confirm Freighter shows **Test SDF Network ; September 2015** before continuing.
:::

## 2. Fund your account with testnet XLM

Soroban charges transaction fees in XLM. Fund a new testnet account from [Friendbot](https://friendbot.stellar.org), replacing `YOUR_ADDRESS` with your Freighter public key:

```bash
curl "https://friendbot.stellar.org/?addr=YOUR_ADDRESS"
```

Friendbot creates the account with a 10,000 XLM balance. A deposit costs a fraction of an XLM in fees, so this is more than enough.

## 3. Get testnet USDC

The vault accepts exactly one asset: the testnet USDC mock SAC at the address below.

| Field | Value |
|-------|-------|
| Symbol | `USDC` |
| Name | `USD Coin` |
| Decimals | 7 |
| Contract (SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |

This is a mintable mock token controlled by the deployer; it is **not** Circle USDC. To get a test balance, request USDC from the team in the project channels or ask the deployer to mint to your address — there is no public self-serve faucet for it yet. Once you hold a balance, it will appear in Freighter under **Assets** (you may need to add the asset by its contract address).

:::tip 7-decimal precision
Every amount on Stellar is an integer at 7-decimal precision. **1 USDC = 10,000,000 stroops.** The app handles this conversion for you — you type dollars, it submits stroops — but it matters when you read raw contract values or events.
:::

## 4. Connect to the vault

Open [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault), click **Connect Wallet**, choose **Freighter**, and approve the connection. Nectar also supports Albedo, xBull, Lobstr, Hana, and Rabet, but this guide uses Freighter.

Once connected, the **Vault Overview** panel reads live on-chain state via read-only simulation (no fee):

- **TVL** — total USDC in the vault (`total_usdc`)
- **Share price** — `total_usdc / total_shares`
- **Total profit**, **active deployed capital**, **total shares**, **depositor count**
- **Capacity** — how much more the vault can accept before hitting the deposit cap

## 5. Enter a deposit amount

Switch to the **Deposit** tab and type an amount in USDC. Before you sign, the app pre-flights your deposit against the on-chain deposit cap and shows the shares you'll receive.

### How shares are calculated

The number of shares you receive is computed entirely on-chain by `NectarVault.deposit`:

- **First deposit into an empty vault** mints 1 share per USDC (`shares = amount`).
- **Every deposit after that** mints proportionally to the current share price:

```
shares = amount * total_shares / total_usdc
```

Integer division floors toward zero, so you never receive *more* than your proportional share — this protects existing depositors from dilution. A worked example with multiple depositors and accrued profit is in [Understanding Yield](./understanding-yield).

### The deposit cap

The vault enforces a maximum total size. A deposit is rejected with `DepositCapExceeded` (error code `8`) when:

```
deposit_cap > 0 && total_usdc + amount > deposit_cap
```

The exact cap is allowed (the check is strictly greater-than). Current testnet configuration:

| Parameter | Value |
|-----------|-------|
| `deposit_cap` | 10,000,000 USDC (`100000000000000` stroops) |
| `withdraw_cooldown` | 3600 seconds (1 hour) |
| `max_draw_per_keeper` | 10,000 USDC |

:::warning Cap pre-flight
If your deposit would push `total_usdc` past the cap, the app blocks it before simulation and shows the remaining capacity. Lower your amount to fit, or wait for room to open as other depositors withdraw.
:::

## 6. Sign in Freighter

Click **Deposit**. The app moves through these states: `simulating → signing → submitted → confirmed`.

When it reaches `signing`, Freighter pops up a single transaction that invokes:

```
NectarVault.deposit(user: Address, amount: i128) -> i128
```

This is **one transaction**, not an approve-then-deposit pair. Soroban's authorization framework lets the same signed transaction both authorize the USDC transfer (`user.require_auth()`) and move your USDC into the vault — there is no separate ERC-20-style allowance step. The call returns the number of shares minted.

Review the contract ID against [Contract Addresses](../reference/contract-addresses), then approve. The transaction typically confirms in about five seconds.

:::info What the contract does
On `deposit` the vault: checks the cap, computes your shares, transfers `amount` USDC from you into the vault, creates or updates your `Depositor` record (adding shares and setting `last_deposit_time` to now), increments `total_usdc` and `total_shares`, and emits a `deposit` event carrying `(amount, shares)`.
:::

## 7. Verify your shares

After confirmation the **Your Position** panel updates from on-chain reads:

- **Shares** — your share balance from `balance(user)` / `get_depositor(user)`
- **Current value** — `shares * total_usdc / total_shares`, in USDC
- A link to the transaction on [stellar.expert (testnet)](https://stellar.expert/explorer/testnet)

You can independently confirm your balance by simulating a read against the vault:

```bash
stellar contract invoke \
  --id CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345 \
  --source YOUR_ACCOUNT \
  --network testnet \
  --send=no \
  -- \
  balance --user YOUR_ADDRESS
```

The result is a two-element array `[shares, usdc_value]`, both in 7-decimal stroops.

## 8. Track performance

There's no reward to claim and no lockup beyond the withdrawal cooldown. Your position value rises automatically as keepers return liquidation profit and the share price ticks up.

- **Live position and share price:** [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault)
- **Per-depositor analytics:** [nectarnetwork.fun/dashboard/depositor](https://nectarnetwork.fun/dashboard/depositor) — look up any `G…` address
- **APY chart and liquidation feed:** [nectarnetwork.fun/dashboard](https://nectarnetwork.fun/dashboard)

:::tip
APY is only annualized once the share-price series spans at least seven days; shorter windows show raw cumulative return labeled "not annualized." Quiet weeks can yield near zero — yield is bursty because it comes from liquidations, not lending interest.
:::

## Note on the withdrawal cooldown

Your `last_deposit_time` is set to the current ledger time on **every** deposit, which restarts the [withdrawal cooldown](./withdraw-guide). If you top up an existing position, the 1-hour cooldown clock resets from that moment. Plan deposits accordingly if you expect to withdraw soon.

## What's next

- [Withdraw Guide](./withdraw-guide) — how to redeem shares for USDC after the cooldown
- [Understanding Yield](./understanding-yield) — where the returns come from and how share price works
- [Risks](./risks) — read this before depositing anything you care about
- [NectarVault contract reference](../developers/contracts/nectar-vault) — the full function and error surface
