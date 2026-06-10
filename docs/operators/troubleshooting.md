---
title: Troubleshooting
description: Common keeper errors and fixes
---

# Troubleshooting

The keeper logs errors with both a human message and the underlying contract error code. This page maps common errors to fixes. For full error reference, see [Error Codes](../reference/error-codes).

## Registration

### `Error 14: NotEnoughStake`

You called `register` with `stake_amount < min_stake`. Check the registry's current minimum:

```bash
./nectar-keeper config show
```

Increase `STAKE_AMOUNT` (or pass `--stake`) and retry.

### `Error 15: AlreadyRegistered`

Your keypair is already in the registry. The keeper binary normally handles this gracefully — if you see it as a startup error, your stale registration may have a different `KEEPER_NAME` than your config. Either:

- Update `KEEPER_NAME` to match the on-chain registration, or
- Call `update_name` to change it on-chain.

### `xdr.Decode: invalid keypair`

`KEEPER_SECRET` is malformed. It must start with `S` and be 56 characters. Re-paste from your secure store.

## Drawing & filling

### `Error 23: ExceedsDrawCap`

You tried to draw more than `stake * leverage_factor`. Either reduce the auction size you're filling, increase your stake (`stake-add`), or set `MAX_DRAW` to a lower explicit cap.

### `Error 24: KeeperInCooldown`

You called `unregister` recently and are in the 24-hour cooldown. You cannot draw during cooldown. Call `cancel_unregister` if you changed your mind, then retry.

### `submit failed: tx_bad_seq`

Your account sequence number is stale. This usually means another process is sending transactions from the same key, or your local cache lagged. Restart the keeper. If it persists, check whether you have a duplicate keeper running.

### `simulate ok, submit error: tx_internal_error`

The transaction simulated successfully but failed on submit — usually a race with another keeper that filled the auction first. The keeper logs `auction_already_filled` and continues. No action needed.

### `auction_already_filled` (info, not error)

Another keeper filled the auction before you. Expected and normal in a competitive network. If you see this on >50% of attempts, your `POLL_INTERVAL` is too high or your RPC is slow — see "Optimization" below.

## Network

### `dial tcp: i/o timeout` (Soroban RPC)

Your `SOROBAN_RPC` endpoint is unreachable or rate-limited. The default public testnet RPC has aggressive limits. Switch to a dedicated RPC provider or run your own node.

### `429 Too Many Requests`

You're hitting a public-RPC rate limit. Increase `POLL_INTERVAL` to reduce load, or use a paid RPC tier.

### `horizon: account not found`

Your keeper account doesn't exist on the network yet. Fund it with XLM via Friendbot — see [Setup step 4](./setup).

## DEX adapter

### `slippage_exceeded`

Your `MAX_SLIPPAGE_BPS` is tighter than current DEX liquidity supports. Either widen the slippage tolerance or run a `STRATEGY=conservative` profile that filters out auctions in illiquid collateral.

### `dex_adapter: no route`

The DEX has no pool for the seized collateral. This shouldn't happen on common Blend collateral (XLM, USDC, BLND). If it does, the keeper falls back to holding the lot — review periodically and dispose manually.

## Slashing

### `slashed: timeout`

Your keeper drew funds and didn't return them within the timeout. Common causes:

- Process crashed mid-fill — set up `Restart=always` (systemd) or `--restart unless-stopped` (Docker).
- Out of XLM mid-flow — keep at least 5 XLM reserve.
- Network partition between draw and return — use a reliable RPC.

Recover the keeper account by topping up XLM and re-registering. Your stake is gone — that's the cost of the timeout.

### `slashed: loss`

Your keeper returned less than principal. The shortfall came from your stake. Check logs around the loss event:

```bash
grep "fill\|return" keeper.log | tail -50
```

Most common cause: collateral price moved against you between fill and DEX sale. Tighten `MAX_SLIPPAGE_BPS`, switch to a DEX adapter with better depth, or move to `conservative` strategy.

## Optimization

### Low fill rate

Causes, in order of likelihood:

1. **`POLL_INTERVAL` too high.** Drop to 5 seconds. Below 5 seconds, you'll just hit RPC rate limits.
2. **Slow RPC.** The default public RPC adds latency. Run your own Soroban RPC node, ideally co-located with a Stellar validator.
3. **`MIN_PROFIT` too tight.** Other keepers are filling slimmer auctions. Drop `MIN_PROFIT` cautiously.

### High slashing rate

Tighten `MIN_PROFIT`, switch to `conservative` strategy, or reduce `MAX_DRAW` so individual losses are bounded.

## Where to ask for help

- Stellar Discord, channel `#nectar`
- GitHub issues: [github.com/Nectar-Network/nectar-poc/issues](https://github.com/Nectar-Network/nectar-poc/issues)
- Include log lines (`LOG_LEVEL=debug` for richer traces) and your strategy / config when filing.
