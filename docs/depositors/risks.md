---
title: Risks
description: Honest risk disclosure for Nectar depositors
---

# Risks

:::danger
Nectar is an experimental, unaudited protocol on testnet. Do not deposit funds you cannot afford to lose. None of this is FDIC-insured. None of this is investment advice.
:::

This page exists to be useful, not to satisfy a lawyer. It is the honest version.

## Smart contract risk

The Nectar vault and registry are written in Rust for Soroban. They have not been audited as of Tranche 1. An audit is funded under SCF and runs before mainnet launch (Tranche 3).

**Possible failure modes:**

- A bug allows an attacker to drain the vault, mint shares without depositing, or block withdrawals.
- A bug in the registry lets a keeper draw without sufficient stake.
- An upgrade path (if added later) is misused by a compromised admin key.

**What we've done:**

- Internal review and fuzz tests before testnet deployment.
- Public bug bounty program planned for Tranche 2.
- Time-locked upgrades are planned for Tranche 3 — there is currently no admin upgrade path on testnet.

## Liquidation risk

Keepers seize collateral and resell it. If the collateral price moves against them between fill and sale, the keeper may return less USDC than they drew. The keeper's stake covers the shortfall first, but if the loss exceeds the stake, the vault eats the residual.

**Mitigations:**

- Minimum stake (currently 100 USDC) per keeper.
- `MIN_PROFIT` parameter — keepers reject auctions where simulated profit is below threshold.
- Per-draw cap proportional to stake.
- Slashing on a missed return.

**What can still go wrong:**

- A flash crash between fill and sale can produce losses larger than stake.
- An adversarial DEX (low liquidity, manipulated quotes) can leave a keeper with collateral that cannot be sold near oracle price.

## Oracle risk

Blend pools rely on price oracles (Reflector). If an oracle is manipulated or stale, a position can be liquidated at the wrong health factor — sometimes in the keeper's favor, sometimes against.

**Mitigations planned:**

- A circuit breaker that pauses draws when oracle deviation exceeds a threshold (Tranche 3).
- Sanity checks in the keeper before submitting fills.

**Currently:** there is no on-chain circuit breaker. A bad oracle print could result in a draw that returns less than principal.

## Keeper risk

Keepers are pseudonymous. Anyone with a stake can register. A keeper can:

- Go offline mid-draw, locking capital until the timeout.
- Fill an unprofitable auction by mistake.
- Front-run the network in subtle ways that are not yet enforced.

**Mitigations:**

- Draw timeout (currently 1 hour). After timeout, anyone calls `slash()` and the keeper's stake is seized to make depositors whole.
- Per-keeper draw cap.
- Performance tracking; misbehaving keepers fall in rank and lose access to large draws.

## Cooldown risk

Withdrawals require a 24-hour cooldown. If you need liquidity on a faster timeline, Nectar is wrong for you. Cooldown is a structural property of the design, not a bug — it exists so the vault can guarantee solvency to keepers.

## Impermanent loss

**None.** The vault is single-asset USDC. There is no LP position, no two-token exposure. Your principal denomination is USDC throughout.

## What this is not

- **Not a stablecoin yield aggregator.** Yield is from active liquidation, not lending.
- **Not insured.** No FDIC, no SIPC, no on-chain insurance fund yet. The keeper stake is your protection.
- **Not custodial.** Nectar Network has no admin key that can move user funds. (Contracts have no upgrade path on testnet.)

## What you can do

- Deposit a small amount first, watch share price for a few days, then size up.
- Read the [contracts](../developers/contracts/keeper-registry) directly. They are short.
- Watch the [performance page](https://nectarnetwork.fun/performance) for unusual share price drops — that's the visible signal of a keeper loss.

If something looks wrong, file an issue at [github.com/Nectar-Network/nectar-poc/issues](https://github.com/Nectar-Network/nectar-poc/issues).
