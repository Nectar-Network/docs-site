---
title: Glossary
description: Terms used throughout the Nectar docs
---

# Glossary

**Backstop.** A reserve of capital that absorbs losses when keeper stake is insufficient. Not yet implemented; planned for Tranche 3.

**Bid.** The amount of debt asset (typically USDC) a keeper supplies to fill a Blend auction.

**BLND.** Blend Protocol's governance token.

**Circuit breaker.** A guard in the vault that pauses draws when oracle price deviates beyond a threshold. Planned for Tranche 3.

**Collateral factor (`c_factor`).** Per-asset multiplier in `[0, 1]` that determines how much an asset contributes to collateral value. A `c_factor` of 0.85 means 85% of the asset's market value counts as collateral.

**Cooldown.** The waiting period (currently 24 hours) between requesting and claiming a withdrawal, or between unregistering and reclaiming a keeper stake.

**Deposit cap.** The maximum total assets the vault will hold. Deposits exceeding the cap revert.

**Draw.** A keeper's act of borrowing pooled USDC from the vault to fund an auction fill. Tracked in both vault and registry.

**Dutch auction.** A descending-price auction. Blend's liquidation auctions scale lot up and bid down over 400 ledgers.

**Health factor (HF).** `collateral_value / liability_value`. `HF >= 1` is solvent; `HF < 1` triggers liquidation.

**Keeper.** An off-chain operator that monitors lending pools and fills liquidation auctions using vault capital.

**KeeperRegistry.** The Soroban contract that tracks keeper stake, status, and performance.

**Leverage factor.** The multiplier on a keeper's stake that determines their per-keeper draw cap. `max_draw = stake * leverage_factor`. Currently 3x.

**Liability factor (`l_factor`).** Per-asset divisor `>= 1` that inflates the effective debt value. An `l_factor` of 1.05 makes a debt count as 105% of face value for HF computation.

**Liquidation.** Forcibly closing an undercollateralized position by seizing collateral and repaying debt.

**Lot.** The collateral seized in a Blend auction fill.

**MIN_PROFIT.** Keeper config: minimum lot/bid ratio to attempt a fill.

**NectarVault.** The Soroban contract holding pooled USDC and minting shares.

**Oracle.** External price feed used to compute health factors. Blend uses Reflector.

**Reflector.** Soroban's reference oracle protocol, providing on-chain price feeds.

**Return proceeds.** A keeper's act of paying USDC back to the vault after selling seized collateral. Includes principal plus realized profit (or loss).

**Share.** A claim on a fraction of total vault assets. Minted on deposit, burned on withdrawal. SEP-41 compatible.

**Share price.** `total_assets / total_shares`. Rises as keepers return profit. The mechanism through which yield accrues to depositors.

**Slashing.** Forfeiting part or all of a keeper's stake as penalty for loss, timeout, or fraud.

**Soroban.** Stellar's smart contract platform.

**Stake.** USDC escrowed by a keeper in the registry as security against loss and timeout.

**Timeout.** The maximum duration (currently 1 hour) a draw can remain open before anyone can call `slash_timeout`.

**Vault.** Shorthand for `NectarVault`.

**Withdrawal request.** A user's signal that they want to redeem shares. Becomes claimable after the cooldown elapses.
