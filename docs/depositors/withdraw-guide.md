---
title: Withdraw Guide
description: Withdraw USDC from the Nectar vault
---

# Withdraw Guide

:::info
This takes ~2 minutes of clicking, plus the cooldown window (24 hours on testnet).
:::

Withdrawals from Nectar are a two-step process: **request** then **claim**. The gap between the two — the cooldown — gives in-flight keepers time to return drawn capital before the vault has to honor a withdrawal.

## 1. Request a withdrawal

1. Visit [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault).
2. Click **Withdraw**.
3. Enter the share amount you want to redeem (or click **Max** to redeem everything).
4. Click **Request Withdrawal** and confirm in Freighter.

This calls `NectarVault.request_withdraw(shares)`. Your shares are escrowed (still earning yield until cooldown expires) and a `claimable_at` timestamp is recorded.

## 2. Wait for the cooldown

The current cooldown is **24 hours** on testnet. The vault page shows a countdown timer.

:::tip
Your shares keep accruing yield during cooldown. The amount you eventually claim is calculated from share price **at the moment of claim**, not at the moment of request.
:::

## 3. Claim

After the cooldown elapses:

1. Return to [nectarnetwork.fun/vault](https://nectarnetwork.fun/vault).
2. Click **Claim Withdrawal**.
3. Confirm in Freighter.

This calls `NectarVault.claim_withdraw()`. USDC is transferred to your Freighter wallet, share supply decreases, and the request slot is freed.

## Edge cases

### Partial withdrawals

You can request a fraction of your shares and leave the rest deposited. Each address can have **one open withdrawal request at a time** — submit a new request only after claiming the previous one (or canceling, see below).

### Canceling a request

Before claiming, you can cancel by calling `NectarVault.cancel_withdraw()`. Your escrowed shares return to your normal balance. There is no penalty.

### Vault temporarily unable to honor claim

If at the moment of claim the vault has too much capital out on draws (rare, but possible), the contract reverts. Wait a few minutes for keepers to return funds and try again. There is no expiration on a claim — you do not lose your right to withdraw.

### Emergency withdrawal

The protocol has no admin override. If the contracts are bricked, your funds are recoverable only via on-chain mechanisms. This is intentional — read [Risks](./risks).

## Withdrawal vs. swap

Some users sell shares peer-to-peer to skip the cooldown. Nectar shares are SEP-41 tokens and can in principle be transferred. However, share-token markets do not exist yet, so the cooldown path is the only practical exit.
