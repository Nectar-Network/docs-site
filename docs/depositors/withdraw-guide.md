---
title: Withdraw Guide
description: How to redeem your NectarVault shares for USDC — the 1-hour withdraw cooldown, share-to-USDC conversion at the current share price, what happens when capital is actively deployed by keepers, and a step-by-step walkthrough using the app and Freighter.
---

# Withdraw Guide

Withdrawing from the Nectar Vault means **burning your shares** in exchange for USDC. Because the vault accrues keeper profits over time, each share is generally worth slightly more USDC at withdrawal than it was at deposit. This guide explains exactly how the on-chain `withdraw` call works, the rules it enforces, and how to redeem through the app with Freighter.

:::info Testnet today, mainnet later
Nectar is currently live on **Soroban testnet** (Tranche 2). The USDC you withdraw is a mock Stellar Asset Contract (SAC) deployed for testing — it carries no real value. Mainnet deployment with Circle USDC is scheduled for Tranche 3. See [Contract Addresses](../reference/contract-addresses) for the current testnet deployment.
:::

## What a withdrawal actually does

When you call `withdraw`, the [`NectarVault`](../developers/contracts/nectar-vault) contract:

1. Looks up your `Depositor` record and verifies you own at least the number of shares you're redeeming.
2. Enforces the **withdraw cooldown** (see below).
3. Converts your shares to USDC at the **current share price**.
4. Burns the shares and transfers the USDC from the vault to your wallet.
5. Emits a `withdraw` event with `(shares, usdc_out)`.

The on-chain signature is:

```rust
pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<i128, VaultError>
```

- `user` — the depositor's address. Must authorize the transaction (`user.require_auth()`).
- `shares` — the number of shares to redeem, in 7-decimal precision (1 share = 10,000,000 stroops).
- Returns `i128` — the amount of USDC sent to you, also in stroops.

:::tip Shares, not USDC
Deposits are denominated in **USDC**, but withdrawals are denominated in **shares**. In the app's withdraw tab the amount field is labeled "Shares to Redeem," and the summary shows the estimated USDC you'll receive at the live share price. To exit your entire position, redeem your full share balance (the **MAX** button fills it in).
:::

## Share-to-USDC conversion

The vault tracks two pool-wide totals in its `VaultState`: `total_usdc` (the accounting value of the pool, including accrued profit) and `total_shares` (all outstanding shares). The **share price** is simply their ratio:

```
share_price = total_usdc / total_shares
```

Your payout is computed by proportional integer division:

```rust
// inside withdraw()
let usdc_out = shares * state.total_usdc / state.total_shares;
```

Integer division **floors toward zero**, so you always receive *at most* your proportional share of the pool and never a fraction of a stroop more. This protects the remaining depositors from rounding leakage. In the special case where you redeem every share in the vault (`shares == total_shares`), the formula naturally returns the entire `total_usdc`.

Because `total_usdc` grows each time a keeper calls `return_proceeds` with a profit, the share price rises over time. A depositor who entered at a share price of `1.0000` and withdraws when the price is `1.0250` receives 2.5% more USDC than they deposited, per share.

:::info Worked example
Suppose the vault holds `total_usdc = 10,100 USDC` against `total_shares = 10,000` shares — a share price of **1.01 USDC/share**. If you redeem **500 shares**:

```
usdc_out = 500 * 10,100 / 10,000 = 505 USDC
```

You receive **505 USDC**, and your `Depositor.shares` drops by 500. The pool's `total_usdc` and `total_shares` are reduced by `505` and `500` respectively, leaving the share price unchanged for everyone else.
:::

You can read the live share price at any time by calling `get_state` and dividing, or via the app's **Vault Overview** panel, which surfaces TVL, share price, total profit, and active deployed capital directly from chain.

## The 1-hour withdraw cooldown

Every deposit starts a **withdraw cooldown**. On testnet this is configured to **3,600 seconds (1 hour)**. The contract enforces it like this:

```rust
let now = env.ledger().timestamp();
if now.saturating_sub(depositor.last_deposit_time) < cfg.withdraw_cooldown {
    return Err(VaultError::WithdrawalCooldown);
}
```

Two things are important here:

- The clock runs from `last_deposit_time`, which is **reset on every deposit** — not from your first-ever deposit. Adding to your position restarts the 1-hour timer for the whole balance.
- The window is measured against the ledger timestamp, so it advances with real wall-clock time regardless of network activity.

If you attempt to withdraw before the cooldown elapses, the call reverts with `WithdrawalCooldown` (error code `9`). The app pre-checks this and shows a live "Available in …" countdown in your position panel, so you won't waste a signature on a call that would fail.

:::warning Topping up resets your timer
Because `last_deposit_time` is overwritten on each deposit, a small additional deposit will push your earliest withdraw time back to one hour from that deposit. Plan top-ups accordingly if you expect to withdraw soon.
:::

The cooldown is read from the vault's `VaultConfig.withdraw_cooldown` and can be changed by the admin via `set_config`. Always treat the on-chain value as authoritative; query `get_config` if you need the exact current setting.

| Parameter | Testnet value | Source |
| --- | --- | --- |
| `withdraw_cooldown` | 3,600 s (1 hour) | `VaultConfig` |
| `deposit_cap` | 10,000,000 USDC | `VaultConfig` |
| `max_draw_per_keeper` | 10,000 USDC | `VaultConfig` |
| Decimal precision | 7 (1 USDC = 10,000,000 stroops) | Stellar native |

## What happens when capital is actively deployed

The vault is a **working capital pool** — at any moment, some of its USDC may be drawn out by keepers filling Blend liquidation auctions. The contract tracks this with `active_liq` in `VaultState`:

- `total_usdc` is the pool's full accounting value (idle + deployed + accrued profit).
- `active_liq` is the USDC currently drawn by keepers and not yet returned.
- The USDC physically sitting in the vault contract is therefore `total_usdc - active_liq`.

When a keeper calls `draw`, USDC leaves the contract and `active_liq` increases, but `total_usdc` is **unchanged** — the capital is still owned by depositors, just temporarily working. This is why the share price is **not** affected by a draw: your shares represent a claim on the whole pool, deployed or not.

A withdrawal transfers *physical* USDC out of the contract. If keepers have a large fraction of the pool deployed, the idle balance may be smaller than the USDC value of the shares you want to redeem. In that situation the USDC transfer inside `withdraw` cannot be funded and the transaction reverts. The fix is simply to wait: keeper draws are short-lived (an auction fill and return typically completes in seconds to minutes), and capital flows back as `return_proceeds` is called.

:::warning Withdrawals depend on idle liquidity
Your shares are always redeemable in principle, but a single withdrawal can only be filled from USDC that is **not currently deployed**. If a withdrawal reverts because too much capital is in flight, retry after active draws settle, or redeem a smaller number of shares. Deployed capital returns to the pool automatically as keepers complete their liquidations.
:::

You can gauge current availability from the **Vault Overview** panel: "Active Deployed" shows `active_liq` and "TVL" shows `total_usdc`. The difference is the idle USDC available for withdrawals right now.

## Errors you may encounter

The `withdraw` call returns a `VaultError`. The most relevant codes:

| Code | Variant | Meaning |
| --- | --- | --- |
| 3 | `InsufficientBalance` | You tried to redeem more shares than you own. |
| 4 | `InsufficientVault` | The pool has no shares, or insufficient idle USDC to fund the redemption. |
| 6 | `NoShares` | No `Depositor` record exists for your address. |
| 9 | `WithdrawalCooldown` | The 1-hour cooldown since your last deposit has not elapsed. |

The app maps simulation failures to readable messages, but knowing the underlying codes helps when inspecting a transaction on [stellar.expert](https://stellar.expert/explorer/testnet).

## Withdraw step by step (app + Freighter)

The fastest path is the hosted vault app, which builds, simulates, signs, and submits the Soroban transaction for you.

1. **Open the Vault app** and click **Connect Wallet**. Freighter is the primary wallet; Albedo, xBull, Lobstr, Hana, and Rabet are also supported.
2. **Approve the connection** in Freighter, making sure it is set to **Testnet**.
3. **Switch to the Withdraw tab.** Your position panel shows your share balance, its current USDC value, and a withdrawal-readiness indicator.
4. **Check the cooldown.** If it reads "Available now," you're clear to proceed. If it shows "Available in …", wait for the countdown to reach zero — the timer runs from your last deposit.
5. **Enter the shares to redeem.** Type a share amount or click **MAX** to redeem your entire balance. The summary line shows the estimated USDC you'll receive at the live share price.
6. **Click "Withdraw USDC."** The app simulates the transaction, then prompts you to **sign in Freighter**. Review the operation and approve it.
7. **Wait for confirmation.** The app submits to Soroban and polls until the transaction is `SUCCESS`. On success you'll see a confirmation with a link to the transaction on stellar.expert, and your balances refresh automatically.

:::tip Verify on the explorer
Every confirmed withdrawal links to its transaction on stellar.expert. The decoded `withdraw` event shows `(shares, usdc_out)` so you can confirm exactly what was burned and paid out.
:::

### Withdrawing programmatically

If you'd rather build the call yourself, invoke `withdraw` on the vault contract with your address and the share amount in stroops. Using the Stellar CLI on testnet:

```bash
stellar contract invoke \
  --id "$VAULT_CONTRACT" \
  --source "$DEPOSITOR_SECRET" \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2008" \
  -- \
  withdraw \
  --user "$DEPOSITOR_PUBLIC" \
  --shares 5000000000
```

The example redeems `5000000000` stroops = **500 shares**. The call returns the USDC out in stroops; check the resulting balance change or the emitted `withdraw` event. Substitute the current `VAULT_CONTRACT` address from [Contract Addresses](../reference/contract-addresses).

## Related reading

- [Deposit Guide](./deposit-guide) — how shares are minted and the cooldown timer starts.
- [How Yield Works](./understanding-yield) — why the share price rises over time.
- [Risks](./risks) — including liquidity timing and capital-deployment considerations.
- [NectarVault contract reference](../developers/contracts/nectar-vault) — full function and storage layout.
- [Glossary](../reference/glossary) — shares, share price, `active_liq`, stroops, and more.
