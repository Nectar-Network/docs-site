---
title: Deposit Guide
description: Deposit USDC into the Nectar vault using Freighter
---

# Deposit Guide

:::info
This takes ~5 minutes. You'll need: Freighter wallet, testnet XLM, and testnet USDC.
:::

## 1. Install Freighter

Install [Freighter](https://www.freighter.app/) from the Chrome / Brave / Firefox extension store. Create a new wallet and **back up your seed phrase**. Switch the network to **Testnet** in Freighter settings.

{/* TODO: Add screenshot of Freighter network switcher */}

## 2. Fund with testnet XLM

XLM is needed to pay transaction fees. Fund your account from [Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS) — replace `YOUR_ADDRESS` with the public key shown in Freighter (starts with `G...`).

```bash
curl "https://friendbot.stellar.org/?addr=GABCD...YOURKEY"
```

You should now see a 10,000 XLM balance in Freighter.

## 3. Get testnet USDC

The Nectar vault holds USDC issued via the Soroban Asset Contract (SAC) for the testnet USDC issuer. Mint test USDC from the Nectar faucet:

1. Visit [nectarnetwork.fun/faucet](https://nectarnetwork.fun/faucet)
2. Connect Freighter
3. Click **Mint 1,000 testnet USDC**
4. Confirm in Freighter

Your USDC balance will appear in Freighter under **Assets** once the transaction confirms.

## 4. Connect to the vault

Visit [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault). Click **Connect Wallet** and approve in Freighter.

The page shows:

- Your USDC balance
- Current share price
- Total vault assets
- Available capacity (how much more the vault can accept before hitting the deposit cap)

{/* TODO: Add screenshot of vault page */}

## 5. Enter deposit amount

Type an amount or click **Max**. The form shows you:

- Shares you'll receive: `amount * total_shares / total_assets`
- Implied share price
- Cap utilization after your deposit

:::warning
If the vault is near capacity, your deposit may be partially capped. The form will show the maximum acceptable amount before you submit.
:::

## 6. Confirm in Freighter

Click **Deposit**. Freighter pops up with a transaction preview showing two operations:

1. **Approval** — give the vault permission to pull your USDC.
2. **Deposit** — call `NectarVault.deposit(amount)`.

Review the contract address against [Contract Addresses](../reference/contract-addresses) and approve. The transaction lands in ~5 seconds.

## 7. Verify shares received

Once the transaction confirms, the vault page updates:

- **Your shares** shows the newly minted share count
- **Your position value** shows `shares * share_price` in USDC
- **Transaction hash** links to [stellar.expert](https://stellar.expert)

## 8. Track performance

Visit [nectarnetwork.fun/performance](https://nectarnetwork.fun/performance) to see:

- Historical share price chart
- Realized APY over rolling windows
- Breakdown of liquidation events that contributed to yield
- Active keepers and their fill rates

:::tip
Bookmark the performance page. Yield accrues continuously — there is no claim transaction. Your position value updates as share price ticks up.
:::

## What's next

- [Withdraw Guide](./withdraw-guide) — when you want to exit
- [Understanding Yield](./understanding-yield) — where the returns come from
- [Risks](./risks) — read this before depositing real money
