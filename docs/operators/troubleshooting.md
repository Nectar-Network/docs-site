---
title: Troubleshooting
description: Diagnose and fix common Nectar keeper problems — registration and stake failures, RPC errors, simulate/transaction failures, empty auction scans, swap and slippage failures, stale-draw recovery, and draw-cap hits — mapped to the exact log lines the daemon prints.
---

# Troubleshooting

This page maps the log lines the keeper daemon actually prints to their root cause and a concrete fix. It is organized by symptom, so the fastest way to use it is: copy a confusing line out of your keeper logs, find it below, and follow the resolution steps.

:::info Log format
The keeper logs to **stdout** in a fixed, single-line format:

```text
15:04:05.000 [keeper-alpha] INFO executing task protocol=blend type=liquidation target=GABC..WXYZ priority=10
```

The fields are `timestamp [keeper-name] LEVEL message key=value …`. Levels are `INFO`, `WARN`, and `ERR`. Addresses in the message body are abbreviated to `GABC..WXYZ` (first 4 + last 4 characters); the full address is only printed for a few startup lines. On Railway, this is your service log; locally with `docker-compose up keeper`, it's the container's stdout.
:::

Before working through a specific symptom, confirm the basics: the daemon reads **all** configuration from environment variables (see [Configuration](./configuration)), is **stateless** (it re-reads chain state every cycle and restarts safely), and runs one monitoring cycle every `POLL_INTERVAL` seconds (default 10).

---

## Startup: the daemon exits immediately

Configuration is validated at startup in `LoadConfig`. A bad value prints a message to **stderr** and the process calls `os.Exit(1)` before any cycle runs — so if the container dies instantly with one of these lines, it is a config problem, not a chain problem.

| stderr line | Cause | Fix |
| --- | --- | --- |
| `missing required env: KEEPER_SECRET` | A required variable is unset or blank | Set `KEEPER_SECRET`, `REGISTRY_CONTRACT`, and `VAULT_CONTRACT` — these three are mandatory. |
| `POLL_INTERVAL="x" is not a valid integer` | Non-numeric value | Use an integer of seconds. |
| `POLL_INTERVAL=500 out of range [3,300]` | Out of bounds | Set a value between `3` and `300` seconds. |
| `MIN_PROFIT="x" is not a valid float` / `MIN_PROFIT must be > 0` | Bad profitability threshold | Use a positive float, e.g. `1.02` (lot/bid ratio). |
| `SLIPPAGE_BPS=20000 out of range [0,10000]` | Bad slippage cap | Use basis points in `[0,10000]` (100 = 1%). |
| `DEFINDEX_DRIFT_BPS=… out of range [0,10000]` | Bad drift threshold | Use basis points in `[0,10000]` (500 = 5%). |

A different early failure is keypair parsing:

```text
21:14:02.118 [nectar-keeper-1] ERR  parse keypair err=... key_len=56
```

This means `KEEPER_SECRET` is not a valid Stellar secret seed. It must be a single `S…` secret key (56 characters). The daemon logs only the key **length** and the first character, never the secret itself. Generate or import a valid key and retry.

:::tip Default RPC and network
If unset, the daemon defaults to `SOROBAN_RPC=https://soroban-testnet.stellar.org:443`, `HORIZON_URL=https://horizon-testnet.stellar.org`, and `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`. These are correct for the current Tranche-2 testnet deployment. Mainnet endpoints and the Circle USDC token come in Tranche 3.
:::

---

## Registration and stake problems

On startup the daemon calls `register` on the KeeperRegistry once:

```text
21:14:02.140 [keeper-alpha] INFO registering keeper name=keeper-alpha
21:14:09.882 [keeper-alpha] INFO registered name=keeper-alpha
```

If registration is rejected, it does **not** crash — it logs a warning and continues, because the most common rejection is "already registered" (which is fine and expected on restart):

```text
21:14:09.882 [keeper-alpha] WARN registration skipped (may already be registered) err=registry register: ... AlreadyRegistered
```

The registry returns one of these contract errors. The daemon maps `AlreadyRegistered` to success; the others are real failures that prevent you from drawing capital.

| Registry error (code) | Meaning | Resolution |
| --- | --- | --- |
| `AlreadyRegistered` (3) | This address is already a registered keeper | None — expected on restart. The daemon treats it as success. |
| `NotRegistered` (4) | The address is not in the registry | Registration never completed — work through the rows below, then restart so `register` runs again. |
| `Paused` (6) | The admin has paused the registry | Wait for the registry to be unpaused; registration is blocked while paused. |
| `InsufficientStake` (7) | Stake requirement not met | See below. |
| `Unauthorized` (5) | The call was not authorized by the operator | Confirm `KEEPER_SECRET` matches the address you intend to register. |

### "Insufficient stake" / the stake transfer fails

Registration pulls the stake (`min_stake`, currently **100 USDC**) from your operator account into the registry contract via a USDC `transfer`. If your account does not hold at least `min_stake` USDC, the inner token transfer fails and `register` reverts.

:::warning Stake is a USDC transfer, not a deposit you top up later
You must fund the keeper's Stellar account with USDC **before** first start. On testnet, USDC is a mock SAC (`CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`, 7 decimals). 100 USDC = `1000000000` stroops.
:::

Resolution:

1. Confirm the account exists and holds USDC. With the Stellar CLI:
   ```bash
   stellar contract invoke \
     --id CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW \
     --source-account $KEEPER_SECRET \
     --rpc-url https://soroban-testnet.stellar.org:443 \
     --network-passphrase "Test SDF Network ; September 2015" \
     -- balance --id <YOUR_G_ADDRESS>
   ```
2. Fund the account with at least `min_stake` (100 USDC) **plus** liquid USDC for gas-equivalent flexibility and a buffer — the seeded testnet keepers each hold 100 USDC stake and 100 USDC liquid.
3. Restart the daemon. The startup `register` call retries.

---

## RPC errors

Every chain interaction goes through the thin Soroban JSON-RPC client. When the RPC node itself returns an error, the message is prefixed with `rpc <method>:`:

```text
21:15:31.004 [keeper-alpha] WARN cycle error err=blend scan error: load pool: ... rpc simulateTransaction: ...
```

Common shapes and fixes:

| Symptom in logs | Likely cause | Fix |
| --- | --- | --- |
| `rpc simulateTransaction: …` / `rpc getEvents: …` | The RPC node rejected the call or is unhealthy | Check `SOROBAN_RPC` is reachable; try the default testnet endpoint; the public node rate-limits, so lower polling pressure or use a dedicated node. |
| `get account seq: …` (wraps a Horizon error) | Horizon could not return the keeper's sequence number | Check `HORIZON_URL`; on a fresh account, fund it first (an unfunded account has no sequence). |
| `connection refused` / `connection reset` / `EOF` / `timeout` | Transient network/node issue | These are **retryable** — the daemon backs off and retries write calls automatically (see below). Persistent failures mean the endpoint is down. |
| `get tasks failed protocol=blend err=latest ledger: …` | `getLatestLedger` failed | Same as above — RPC node health. |

:::tip Built-in retry policy
Write calls (`register`, `draw`, `return_proceeds`, auction `submit`, `new_liquidation_auction`) go through `InvokeWithRetry` with exponential backoff. The default is **3 attempts**, 1s initial delay, 2× backoff; `draw` uses a tighter **2 attempts** (re-drawing is the riskier side). Retries fire only on transient infra errors — `tx_too_late`, `tx_insufficient_fee`, `resource_exhaust`, `timeout`, `connection reset`, `connection refused`, `eof`, `sequence`. Deterministic contract failures (`insufficient_balance`, `already filled`, `AuctionNotFound`, `contract error`, `unauthorized`, `already registered`) are **never** retried, because re-broadcasting only burns fees.
:::

A `cycle error: …` WARN line every cycle is the symptom to watch: the daemon catches per-cycle errors, logs them, surfaces them on the dashboard event feed, and moves on to the next tick. One transient error is normal; the same error every cycle indicates a persistent misconfiguration.

---

## Simulate and transaction failures

A contract call is built, **simulated**, assembled with the simulation's resource fee, signed, sent, and awaited. Failures are reported at the stage they occur.

### Simulation rejected the call

```text
21:16:02.551 [keeper-alpha] WARN execute failed protocol=blend type=liquidation target=GABC..WXYZ err=create auction: new_liquidation_auction: ... draw sim: DrawLimitExceeded
```

A line containing `<fn> sim: <error>` means `simulateTransaction` rejected the call **before** it was ever submitted — the contract would have reverted. The error text carries the contract error variant (or a `#N` error code). Map it to the right table:

**Vault (`VaultError`) codes:**

| Code | Variant | Meaning / Fix |
| --- | --- | --- |
| 3 | `InsufficientBalance` | Depositor lacks shares/balance for the operation. |
| 4 | `InsufficientVault` | Requested draw exceeds available capital (`total_usdc − active_liq`). Wait for capital to be returned or for new deposits. |
| 5 | `Unauthorized` | The signer is not authorized — wrong `KEEPER_SECRET`. |
| 8 | `DepositCapExceeded` | Deposit would exceed the cap (10,000,000 USDC). |
| 9 | `WithdrawalCooldown` | Withdrawal attempted within the 1-hour cooldown. |
| 10 | `DrawLimitExceeded` | Draw exceeds `max_draw_per_keeper` — see [Draw cap hit](#draw-cap-hit). |

**Registry (`Error`) codes:** see the [registration table](#registration-and-stake-problems) above (`NotRegistered=4`, `Unauthorized=5`, `Paused=6`, `InsufficientStake=7`, `ActiveDraw=8`, `SlashTimeout=9`).

:::warning Draw requires a registered keeper
`vault.draw` cross-calls `KeeperRegistry.get_keeper(keeper)` to verify the keeper before transferring USDC. If your keeper is not registered, the draw simulation fails. Fix registration first (above), then the draw will simulate cleanly.
:::

### Send / await failures

If simulation passes but the submitted transaction does not land:

| Log line | Cause | Fix |
| --- | --- | --- |
| `send tx: <errorResultXdr>` | The node rejected the signed transaction (`sendTransaction` returned `ERROR`) | Decode the XDR; common causes are fee/sequence races — the daemon retries the retryable ones. |
| `tx 1a2b3c4d failed: <resultXdr>` | The transaction was included but the contract reverted on-chain | Decode the result XDR; treat the embedded contract code as in the tables above. |
| `tx 1a2b3c4d timed out` | The transaction did not reach a final status within 30s | Usually node lag or congestion. The daemon is stateless and re-evaluates next cycle; a one-off timeout is safe. If the underlying call was a `draw`, watch for [stale-draw recovery](#stale-draw-recovery) on the next cycle. |

---

## No auctions found

A perfectly healthy keeper that prints cycle activity but never fills anything is usually correct — there is simply nothing profitable to liquidate. There is **no error log** for "no auctions"; the absence of `executing task` / `task executed` lines is the signal.

The Blend adapter only creates a task for a position whose health factor is below 1.0. When everything is healthy, `GetTasks` returns nothing and the cycle is silent except for vault/depositor refreshes. When a position is underwater you'll see:

```text
21:18:10.220 [keeper-alpha] INFO underwater: GABC..WXYZ hf=0.9421
21:18:10.221 [keeper-alpha] INFO executing task protocol=blend type=liquidation target=GABC..WXYZ priority=10
```

If a task executes but does **not** fill, the most common reason is the profitability gate:

```text
21:18:12.880 [keeper-alpha] INFO task not executed protocol=blend target=GABC..WXYZ note=not profitable (1.0094 < 1.0200)
```

This is the `MIN_PROFIT` threshold (default `1.02`) comparing the auction's `lot_value / bid_cost` ratio. In a Blend Dutch auction the lot scales 0%→100% over the first 200 blocks while the bid stays at 100%; the ratio improves as the auction ages. The daemon re-checks every cycle, so it will fill automatically once the ratio crosses your threshold.

Checklist when you expect auctions but see none:

1. **Is `BLEND_POOL` set and correct?** If `BLEND_POOL` is empty, the Blend adapter's `GetTasks` returns nothing — it is disabled. The current testnet pool is `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`.
2. **Are there actually underwater positions?** The adapter discovers users from recent pool events (it scans back ~1000 ledgers). If no one is underwater, there is nothing to do.
3. **Is `MIN_PROFIT` too high?** Lower it (still above 1.0) if you are willing to take thinner margins, or wait for the Dutch auction to scale further in your favor.
4. **Did another keeper win?** See [stale-draw recovery](#stale-draw-recovery) — the `already filled by another keeper` path.

---

## Swap and slippage failures

After filling an auction, the Blend adapter swaps seized non-USDC collateral into USDC so it can be returned to the vault. Swaps route through **Soroswap** first, then fall back to the **Phoenix** pool. The reported proceeds are always the **measured USDC balance delta** — never synthesized — so a failed swap means that asset is held, not booked as phantom profit.

The DEX layer raises three sentinel errors:

| Error text | Meaning | Resolution |
| --- | --- | --- |
| `dex: USDC address not configured` | `USDC_CONTRACT` is empty | Set `USDC_CONTRACT` to the USDC token (testnet mock SAC `CD34YC6FFI2KIE2U4ZPCGQIRPH7UPG5YY2QBYNP25ATSFOQSG73J4VBW`). Without it, collateral cannot be valued or swapped. |
| `dex: no swap route available` | No configured DEX could complete the swap | Set at least one of `SOROSWAP_ROUTER` / `PHOENIX_ROUTER`. On testnet, Soroswap router is `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`. The error appends each venue's failure, e.g. `(soroswap: empty quote; phoenix: …)`. |
| `dex: quote below slippage floor` | The best quote was worse than the oracle-anchored floor | The keeper refuses to dump collateral at a bad price on **any** venue — a bad price is treated as a global decision, not a venue-specific one. Either widen `SLIPPAGE_BPS` (deliberately) or wait for liquidity/price to recover. |

Other swap-stage symptoms:

```text
21:20:44.901 [keeper-alpha] WARN execute failed protocol=blend type=liquidation target=GABC..WXYZ err=... swap sent but USDC balance did not increase
```

This means a swap transaction was broadcast but the keeper's USDC balance did not rise — the swap did not deliver. **Swaps are never auto-retried** (a swap is non-idempotent; re-broadcasting could double-execute), but `amount_out_min` already bounds execution-time slippage, so funds are protected. Investigate DEX liquidity for that pair.

:::info How slippage protection works
The adapter passes the Blend-oracle-implied USDC value of the collateral as a **reference**. The swap is rejected (`ErrSlippageExceeded`) if the on-chain quote falls below `reference × (10000 − SLIPPAGE_BPS) / 10000`. With the default `SLIPPAGE_BPS=100`, a quote more than 1% below oracle fair value is refused. Set `SLIPPAGE_BPS=0` to require an exact-or-better price, or raise it to tolerate thinner books — but never set it so high that a manipulated pool quote can pass.
:::

---

## Stale-draw recovery

This is the most important safety path to understand, because an **outstanding draw** (capital pulled from the vault but not yet returned) is what the registry slashes on. A draw can be left outstanding when a fill succeeds but the follow-up `return_proceeds` fails — for example, a transient RPC error after the auction was already filled on-chain.

At the **top of every cycle**, before doing anything else, the keeper runs `recoverStaleDraw`: it reads its outstanding draw via `get_keeper_draw`, and if it has USDC on hand, returns up to the outstanding amount to clear the draw and avoid a timeout slash.

Recovery succeeded:

```text
21:22:01.510 [keeper-alpha] INFO recovered stale vault draw drawn=500000000 returned=500000000
```

(Amounts are 7-decimal stroops: `500000000` = 50 USDC.) This is safe — the return is capped at the drawn amount and never touches more of the keeper's float.

Recovery could not run because there is nothing to return:

```text
21:22:01.510 [keeper-alpha] WARN outstanding vault draw but no USDC on hand — holding collateral for manual recovery drawn=500000000
```

:::danger Manual recovery required — slash risk
This warning means you have an outstanding draw but **no liquid USDC** to repay it — typically because seized collateral has not been swapped to USDC (a persistent swap/route failure). The draw will eventually become slashable. To recover manually:

1. Fix the underlying swap problem ([Swap and slippage failures](#swap-and-slippage-failures)) so the next cycle can convert the held collateral, **or** manually swap the collateral to USDC into the keeper account.
2. Once the keeper holds USDC, the next cycle's `recoverStaleDraw` returns it automatically and the warning clears.
3. If you cannot recover before `slash_timeout` (currently 3600s after the draw), expect a slash of `slash_rate_bps` (10%) of stake.
:::

The recovery itself failing:

```text
21:22:01.510 [keeper-alpha] WARN stale-draw recovery failed drawn=500000000 return=500000000 err=vault return_proceeds: ...
```

Treat the wrapped `err` as a normal return/RPC failure (sections above); recovery is retried automatically next cycle.

Related: when a fill drew capital but produced **zero returnable proceeds**, you'll see both a WARN and a dashboard event:

```text
21:21:58.333 [keeper-alpha] WARN fill succeeded but produced zero returnable proceeds — outstanding draw at slash risk protocol=blend target=GABC..WXYZ drew=500000000
```

This is the same risk class: the draw is outstanding with nothing to return. Usually it means every collateral swap failed — fix the swap path so the held collateral can be converted on a later cycle.

:::tip "Already filled by another keeper" is not stale-draw
If another bot wins the auction after you drew capital, the daemon detects `AlreadyFilled`/`AuctionNotFound`, books the fill as `already filled by another keeper`, and returns the **unchanged** capital (no profit, no loss). This does not leave an outstanding draw and is not a problem — it's the expected outcome of a competitive auction.
:::

---

## Draw cap hit

The vault enforces a per-keeper maximum draw (`max_draw_per_keeper`, currently **10,000 USDC** on testnet). A draw exceeding it reverts at simulation time with `DrawLimitExceeded` (vault error code 10):

```text
21:24:10.700 [keeper-alpha] WARN execute failed protocol=blend type=liquidation target=GABC..WXYZ err=vault draw: ... draw sim: DrawLimitExceeded
```

Because `draw` is simulated before submission, **no fee is wasted** and no capital moves — the auction simply isn't filled by this keeper on this cycle.

Resolution:

- This auction's bid requirement exceeds the per-keeper cap. There is no per-keeper override the daemon can apply; the cap is a vault-level safety parameter set by the admin.
- Large auctions above the cap are intentionally left to be split across keepers or skipped. If you operate the vault and want a higher ceiling, the admin must raise `max_draw_per_keeper`; otherwise this is expected protective behavior, not a bug.

:::info Two different "limits"
Don't confuse `DrawLimitExceeded` (code 10, your draw is bigger than `max_draw_per_keeper`) with `InsufficientVault` (code 4, the vault simply doesn't have `total_usdc − active_liq` available right now). The first is a per-keeper policy cap; the second is a liquidity condition that clears as capital is returned or deposited.
:::

---

## Quick reference: symptom → section

| You see… | Go to |
| --- | --- |
| Container dies instantly, stderr config message | [Startup](#startup-the-daemon-exits-immediately) |
| `registration skipped …` / `InsufficientStake` / `NotRegistered` | [Registration and stake](#registration-and-stake-problems) |
| `rpc …:` / `get account seq` / `connection refused` | [RPC errors](#rpc-errors) |
| `… sim: …` / `tx … failed` / `tx … timed out` | [Simulate and transaction failures](#simulate-and-transaction-failures) |
| Cycles run but nothing fills / `not profitable (… < …)` | [No auctions found](#no-auctions-found) |
| `dex: …` / `swap sent but USDC balance did not increase` | [Swap and slippage failures](#swap-and-slippage-failures) |
| `recovered stale vault draw` / `no USDC on hand` / `zero returnable proceeds` | [Stale-draw recovery](#stale-draw-recovery) |
| `DrawLimitExceeded` | [Draw cap hit](#draw-cap-hit) |

For configuration details referenced throughout, see [Configuration](./configuration). For the meaning of terms like health factor, draw, and slash, see the [Glossary](../reference/glossary).
