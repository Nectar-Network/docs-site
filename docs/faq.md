---
sidebar_position: 3
title: FAQ
---

# FAQ

### Is Nectar live on mainnet?

No. Tranche 1 is testnet only. Mainnet ships in Tranche 3 after the SCF audit completes.

### Where does the yield come from?

Liquidation spread on Blend Protocol Dutch auctions. When a borrower's position becomes underwater, Blend auctions their collateral at a discount; keepers fill the auction with capital drawn from the vault, sell the collateral, and return principal plus profit to the vault. Share price rises by the profit divided by total shares.

### Is this a stablecoin savings account?

No. Yield depends on liquidation activity, which is correlated with market volatility. In quiet markets, returns can be near zero. In volatile periods, returns can spike. It is closer to a market-making strategy than to lending.

### What are the risks?

Smart contract risk, oracle risk, keeper risk, and the risk that seized collateral sells for less than the bid cost. Read [Risks](./depositors/risks) before depositing.

### Why a vault instead of letting users run their own bots?

Most depositors don't want to run a bot. Pooling capital opens liquidation yield to passive holders, and concentrating execution on professional keepers improves uptime and pricing.

### What stops a keeper from stealing the drawn USDC?

Two things. First, every keeper is staked in `KeeperRegistry` — a misbehaving keeper's stake is slashed and the slash covers the loss. Second, draws have a hard timeout: if a keeper does not call `return_proceeds` within the timeout window, anyone can call `slash` to seize their stake.

### Can I withdraw any time?

Withdrawals respect a short cooldown (currently 24 hours on testnet) so the vault can guarantee solvency to in-flight keepers. Once cooldown elapses you can withdraw your full share value, including accrued yield.

### Why USDC only?

The PoC vault is single-asset to keep the share math obvious and keep liquidation execution simple — Blend's bid side is denominated in stablecoins. Multi-asset vaults are on the roadmap but are not in scope for Tranche 1.

### Who can run a keeper?

Anyone with a Stellar keypair, the minimum stake (currently 100 USDC on testnet), and the operational capacity to keep a Go process running. See [Operator Setup](./operators/setup).

### How do keepers compete?

The `KeeperRegistry` records execution stats per keeper. Higher-performing keepers (more successful fills, no slashes) sit at the top of the leaderboard. The vault favors high-rank keepers when multiple try to draw simultaneously.

### Is the code audited?

Not yet. The audit is funded under SCF Tranche 3 and runs before mainnet. Until then, treat all deposits as test capital.

### Where do I report bugs?

Open an issue at [github.com/Nectar-Network/nectar-poc/issues](https://github.com/Nectar-Network/nectar-poc/issues). Security reports: see the SECURITY.md in that repo.
