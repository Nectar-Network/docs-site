---
sidebar_position: 3
title: FAQ
description: Honest answers about Nectar Network — what's live, how yield works, the risks, who can run a keeper, supported protocols, the SDK, fees, and mainnet timing.
---

# FAQ

Plain answers, no marketing. If something here contradicts the contracts, the contracts win — read [Risks](./depositors/risks) before depositing anything.

:::info
Nectar is on **Soroban testnet only**. All USDC on testnet is a mock Stellar Asset Contract, not real money. Mainnet (with Circle USDC) is scheduled for Tranche 3.
:::

## The basics

### What is Nectar Network?

A pooled-liquidation protocol for Soroban DeFi on Stellar. Depositors fund a shared USDC vault. A network of independent keeper operators draws that capital to fill [Blend Protocol](./developers/blend-integration) liquidation auctions, sells the seized collateral, and returns principal plus profit to the vault. Realized profit raises the vault's share price, so every depositor's shares appreciate. There are no reward tokens, emissions, or lockups — yield is the appreciation of a single share price.

See [How It Works](./how-it-works) for the full end-to-end flow.

### Is Nectar live on mainnet?

No. Tranche 1 (MVP) and Tranche 2 (testnet feature build) are complete and running on **Soroban testnet**. Mainnet ships in **Tranche 3** (targeted October 2026) after the SCF-funded audit completes.

What's live on testnet today:

- Hardened `NectarVault` and `KeeperRegistry` contracts (staking, slashing, deposit caps, withdrawal cooldowns).
- Two registered keepers running the full Blend Dutch-auction loop.
- DEX integration (Soroswap primary, Phoenix fallback) for swapping seized collateral back to USDC.
- A DeFindex adapter and the public [keeper-sdk](./developers/keeper-sdk).
- Dashboard v2 at [nectarnetwork.fun](https://nectarnetwork.fun) (APY chart, keeper leaderboard, liquidation feed, depositor analytics).

### Is this a stablecoin savings account?

No. Yield depends on liquidation activity, which is correlated with market volatility. In quiet markets, returns can be near zero. In volatile periods, returns can spike. It is closer to a market-making strategy than to lending. Do not model it as a fixed APY.

## Capital and safety

### Is my capital safe?

Treat all testnet deposits as test capital. The contracts are **not yet audited** — the audit is funded under SCF and runs before mainnet. There is no insurance fund, no FDIC/SIPC, and no on-chain circuit breaker yet. Your structural protections are the keeper stake (which backstops keeper losses) and the fact that the contracts have no admin upgrade path on testnet.

### Does Nectar custody my funds? Can an admin move my money?

No admin key can move depositor funds. The admin can pause the registry, adjust config (stake/cooldown/cap parameters), and is the recipient of slashed stake routed to the vault — it cannot withdraw your deposit or your shares. There is no upgrade path on testnet, so the deployed bytecode is fixed.

### What are the risks?

In short: smart-contract risk, oracle risk, keeper risk, and the risk that seized collateral sells for less than the bid cost. Each is documented honestly on the [Risks](./depositors/risks) page. The headline ones:

- **Smart contract risk** — unaudited Rust/Soroban contracts could contain a bug that drains the vault or blocks withdrawals.
- **Liquidation risk** — if collateral price moves against a keeper between fill and sale, the return can be less than the draw. The keeper's stake covers the shortfall first; a loss larger than stake is eaten by the vault.
- **Oracle risk** — Blend relies on the Reflector oracle. A manipulated or stale print can liquidate a position at the wrong health factor. The cross-reference circuit breaker is a Tranche 3 deliverable; it does not exist on-chain yet.
- **Impermanent loss** — **none.** The vault is single-asset USDC; there is no two-token LP exposure.

### What stops a keeper from stealing the drawn USDC?

Two on-chain mechanisms:

1. **Staking.** Every keeper bonds USDC into `KeeperRegistry` on registration (currently `min_stake` = 100 USDC on testnet). The stake is the keeper's skin in the game.
2. **Slashing on timeout.** When a keeper draws capital, the vault calls `mark_draw`, setting `has_active_draw = true`. If the keeper does not call `return_proceeds` (which clears the draw) within `slash_timeout` (currently 3600 s on testnet), **anyone** can call the permissionless `slash` function. Slashing transfers `slash_rate_bps / 10000` of the keeper's stake (currently 10%) to the vault address, making depositors whole.

:::warning
Slashing recovers `slash_rate_bps` (10%) of stake per call, and the slash is gated on the draw being strictly older than `slash_timeout`. It is a deterrent and partial backstop — it is not a guarantee that 100% of a loss is recovered in a single call. A loss larger than the recoverable stake is absorbed by the vault.
:::

### Can I withdraw any time?

Withdrawals respect a cooldown so the vault can guarantee solvency to in-flight keepers. On testnet the cooldown (`withdraw_cooldown`) is **3600 s (1 hour)**, enforced from your **last deposit** (`last_deposit_time`) — every new deposit resets the cooldown. Withdrawal is permitted exactly at `last_deposit_time + withdraw_cooldown`. Once it elapses you can redeem your full share value, including accrued yield. See [Withdraw Guide](./depositors/withdraw-guide).

:::note
A `withdraw_cooldown` of 0 disables the cooldown entirely. The live testnet value is 3600 s.
:::

## Yield

### Where does the yield come from?

The liquidation spread on Blend Dutch auctions. When a borrower's health factor drops below 1.0, Blend auctions their collateral. A keeper draws USDC from the vault, fills the auction, swaps the seized collateral to USDC via a DEX, and returns the proceeds. The realized profit is booked into the vault's `total_usdc` and `total_profit`, which raises the share price for everyone.

### How is yield measured?

By the **share price**, which is `total_usdc / total_shares`. There is no rebasing balance and no reward token — your share count is fixed, and its USDC value rises as profit accrues. The dashboard reconstructs a share-price series from real on-chain outcomes (vault state plus each liquidation's realized `proceeds − drew`) and only annualizes the APY figure when the data window spans at least 7 days. Shorter windows show raw cumulative return labeled "not annualized." Nothing on the dashboards is fabricated; missing data renders as an em-dash.

:::warning
Per-depositor cost basis is **not tracked on-chain**, so the depositor-analytics "net deposited" and "yield" figures are estimates that assume a 1.0 (par) entry price. Shares and current value are read directly from the contract and are exact; the derived return is an estimate.
:::

### What's the share math? Can rounding cost me?

The first deposit mints shares 1:1. After that, `shares = amount * total_shares / total_usdc`, and withdrawals pay `usdc_out = shares * total_usdc / total_shares`. All amounts are `i128` at 7-decimal (stroop) precision — **1 USDC = 10,000,000 stroops**. Integer division always floors toward zero, so neither depositors nor withdrawers can ever extract more than their proportional value; sub-stroop rounding dust accrues to the pool (bounded to a few stroops total). Details in the [NectarVault contract reference](./developers/contracts/nectar-vault).

### Why USDC only?

The vault is single-asset to keep the share math obvious and execution simple — Blend's bid side is denominated in stablecoins, so the keeper's draw, repayment, and profit are all USDC. Seized collateral in other assets is swapped back to USDC before being returned. Multi-asset vaults are not in scope.

## Keepers and protocols

### Who can run a keeper?

Anyone with a Stellar keypair, the minimum stake (100 USDC on testnet, plus liquid USDC for fees), and the operational capacity to keep a Go process running. The daemon is stateless — it reads all state from chain each cycle and restarts safely. Start with [Operator Setup](./operators/setup) and the [Staking guide](./operators/staking).

### How do keepers compete? What happens when two fill the same auction?

There is no coordinator. When a position goes underwater, competing keepers each draw capital and submit a fill for the same Dutch auction. The first confirmed transaction wins; the losers receive `ErrAlreadyFilled`, return their unspent draw unchanged (no profit, no loss), and move on. No wasted-gas spiral, no single point of failure.

`KeeperRegistry` records execution stats per keeper via `record_execution` — `total_executions`, `successful_fills`, `total_profit`, and average response time. Only successful executions contribute to the profit and response-time stats. The dashboard leaderboard reads these directly from the registry.

### How does the Dutch-auction profitability check work?

Blend auctions run in two phases over 400 blocks: the **lot** scales 0%→100% over blocks 0–200, then the **bid** scales 100%→0% over blocks 200–400. The keeper computes `lotVal / bidVal` using Blend oracle prices and only fills when the ratio clears `MIN_PROFIT` (default `1.02`, i.e. lot must be worth at least 2% more than the bid). Below threshold, it draws nothing and skips. See [Blend Integration](./developers/blend-integration).

### What protocols are supported?

| Protocol | Status | Notes |
|----------|--------|-------|
| **Blend** | Live | User-liquidation, bad-debt, and interest auctions. The reference adapter ships in the keeper. |
| **DeFindex** | Live (adapter) | A second adapter that **rebalances a DeFindex vault's own funds** — it never draws Nectar vault capital. Enabled only when `DEFINDEX_VAULT` is set. |
| Other protocols | Roadmap | Anyone can add one by implementing the `ProtocolAdapter` interface from the [keeper-sdk](./developers/keeper-sdk). |

### What is the keeper SDK?

[`keeper-sdk`](./developers/keeper-sdk) is the public Go framework (`github.com/Nectar-Network/keeper-sdk`) for building Soroban liquidation/automation keepers. Third-party operators import it, implement the four-method `ProtocolAdapter` interface (or use the bundled Blend adapter), register the adapter, and call `Run()`. It depends only on the Stellar Go SDK. To build your own strategy, see the [Adapter Guide](./developers/adapter-guide). The interface is small:

```go
type ProtocolAdapter interface {
	Name() string
	GetTasks(rpc *soroban.Client) ([]Task, error)
	Execute(rpc *soroban.Client, kp *keypair.Full, task Task, vault VaultClient) (*Result, error)
	EstimateCapital(task Task) (int64, error)
}
```

### Why a vault instead of letting users run their own bots?

Most depositors don't want to run a bot. Pooling capital opens liquidation yield to passive holders, and concentrating execution on staked, performance-tracked keepers improves uptime and pricing. Operators who *do* want to run a bot are welcome to — that's what the SDK is for.

## Fees and the profit split

### What fees does Nectar charge?

There is no separate management or performance fee taken by a Nectar treasury. The economics are entirely the share-price mechanism: profit returned by keepers raises the share price, so depositors capture the gain directly. Operators pay normal Stellar network transaction fees on the draw, fill, swap, and return transactions out of their own liquid balance.

:::note
The keeper-vs-vault **profit split** is described inconsistently across older project copy (some pages say a 90/10 split with the keeper keeping 10%; others say 10% returns to the vault). The contracts themselves do **not** hard-code any split — `return_proceeds` books `profit = return amount − drawn amount` into the vault, and the dashboards display the actual realized profit from on-chain records. Treat the precise split as unsettled marketing copy, not a contract guarantee, until it is reconciled.
:::

## Practical

### Where are the contract addresses?

The current testnet addresses are on the [Contract Addresses](./reference/contract-addresses) reference page. The deployed contracts (Tranche 1 hardened, 2026-05-24) are:

| Contract | Testnet address |
|----------|-----------------|
| KeeperRegistry | `CDT257SL2IYDZJIDXEVKI67MYLCKE73JY6WGUTGZOEFXJHG26FJHJDRB` |
| NectarVault | `CDZR6VDCPQFOFFKKZ2KMVB67Z54LI5OY73NHBFVI6DR6RE6TL7NN7345` |
| USDC (mock SAC) | `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW` |
| Blend pool (testnet V2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

Always confirm against the reference page before signing a transaction — earlier deployments are deprecated and must not be targeted.

### What do the contract error codes mean?

They're documented in the [Error Codes](./reference/error-codes) reference (e.g. vault `DepositCapExceeded = 8`, `WithdrawalCooldown = 9`, `DrawLimitExceeded = 10`; registry `InsufficientStake = 7`, `ActiveDraw = 8`, `SlashTimeout = 9`). The frontend pre-flights deposit-cap and cooldown checks before simulating, so you usually see a clear message rather than a raw code.

### Is the code audited?

Not yet. The audit is funded under SCF Tranche 3 and runs before mainnet. Until then, treat all deposits as test capital.

### When is mainnet?

Tranche 3, targeted October 2026. It includes the mainnet deployment with Circle USDC and production parameters, the oracle circuit breaker, Docker packaging for one-command keeper setup, and security hardening (rate limits, draw caps, admin multisig). Mainnet ships only after the audit completes.

### Where do I report bugs?

Open an issue at [github.com/Nectar-Network/nectar/issues](https://github.com/Nectar-Network/nectar/issues). For security reports, see `SECURITY.md` in that repository rather than opening a public issue.
