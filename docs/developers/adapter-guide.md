---
title: Adapter Guide
description: Build a ProtocolAdapter to support a new lending protocol
---

# Adapter Guide

Out of the box, Nectar liquidates Blend Protocol auctions. The keeper is structured around a `ProtocolAdapter` interface so other lending protocols can be supported without forking the daemon. This page describes how to build one.

## Interface

```go
package nectar

import "context"

type ProtocolAdapter interface {
    Name() string
    Pools(ctx context.Context) ([]string, error)
    UnderwaterPositions(ctx context.Context, pool string) ([]Position, error)
    SimulateFill(ctx context.Context, pool string, pos Position) (FillEstimate, error)
    Fill(ctx context.Context, pool string, pos Position) (FillResult, error)
}

type Position struct {
    Pool          string
    User          string
    DebtAsset     string
    DebtAmount    uint64
    CollateralAsset string
    CollateralAmount uint64
    HealthFactor  float64
}

type FillEstimate struct {
    BidAmount    uint64   // USDC the keeper supplies
    LotAmount    uint64   // collateral the keeper receives
    LotAsset     string
    Profit       float64  // LotAmount * oracle_price / BidAmount
    GasEstimate  uint64
}

type FillResult struct {
    TxHash      string
    BidAmount   uint64
    LotAmount   uint64
    LotAsset    string
}
```

## Lifecycle

The keeper main loop calls the adapter every `POLL_INTERVAL`:

```
for each pool in adapter.Pools():
    positions = adapter.UnderwaterPositions(pool)
    for each pos in positions:
        est = adapter.SimulateFill(pool, pos)
        if est.Profit < min_profit: continue
        vault.Draw(est.BidAmount)
        result = adapter.Fill(pool, pos)
        proceeds = dex.Swap(result.LotAsset → USDC)
        vault.ReturnProceeds(proceeds)
```

Your adapter does not interact with the vault, the registry, or the DEX. The keeper handles those layers.

## Minimal example: Soroban lending protocol

```go
package myprotocol

import (
    "context"
    "github.com/Nectar-Network/nectar-poc/keeper/pkg/nectar"
)

type Adapter struct {
    rpc       *soroban.Client
    poolIDs   []string
    oracle    *oracle.Reader
}

func New(rpc *soroban.Client, pools []string, oracle *oracle.Reader) *Adapter {
    return &Adapter{rpc: rpc, poolIDs: pools, oracle: oracle}
}

func (a *Adapter) Name() string { return "myprotocol" }

func (a *Adapter) Pools(ctx context.Context) ([]string, error) {
    return a.poolIDs, nil
}

func (a *Adapter) UnderwaterPositions(ctx context.Context, pool string) ([]nectar.Position, error) {
    raw, err := a.rpc.SimulateInvoke(ctx, pool, "list_positions")
    if err != nil { return nil, err }
    out := make([]nectar.Position, 0)
    for _, p := range decode(raw) {
        if hf := computeHF(p, a.oracle); hf < 1.0 {
            out = append(out, nectar.Position{
                Pool: pool,
                User: p.User,
                DebtAsset: p.DebtAsset,
                DebtAmount: p.DebtAmount,
                CollateralAsset: p.CollateralAsset,
                CollateralAmount: p.CollateralAmount,
                HealthFactor: hf,
            })
        }
    }
    return out, nil
}

func (a *Adapter) SimulateFill(ctx context.Context, pool string, pos nectar.Position) (nectar.FillEstimate, error) {
    // Build the protocol-specific liquidation call, simulate, decode result.
    ...
}

func (a *Adapter) Fill(ctx context.Context, pool string, pos nectar.Position) (nectar.FillResult, error) {
    // Submit the same call, return tx hash and amounts.
    ...
}
```

## Plugging it into the keeper

In your `main.go`:

```go
import (
    "github.com/Nectar-Network/nectar-poc/keeper/pkg/nectar"
    "github.com/me/myadapter"
)

func main() {
    cfg := nectar.LoadConfig()
    client, _ := nectar.NewClient(cfg)
    adapter := myadapter.New(client.Soroban, []string{cfg.MyPool}, client.Oracle)

    keeper := nectar.NewKeeperLoop(client, adapter)
    keeper.Run(context.Background())
}
```

You now have a Nectar keeper that liquidates `myprotocol` instead of (or in addition to) Blend.

## Multi-protocol keepers

`NewKeeperLoop` accepts a slice of adapters and round-robins between them each cycle. Useful if you want one stake to cover liquidations across several protocols.

```go
keeper := nectar.NewKeeperLoop(client, []nectar.ProtocolAdapter{
    blend.New(...),
    myadapter.New(...),
})
```

The vault is protocol-agnostic — every adapter's draws and returns flow through the same `NectarVault`.

## Conformance tests

The repo ships an adapter test harness: `pkg/nectar/adaptertest`. Implement it against your adapter to verify behavior in a sandbox without committing to a real pool:

```go
func TestMyAdapter(t *testing.T) {
    adapter := myadapter.New(...)
    adaptertest.Run(t, adapter, adaptertest.Defaults())
}
```

This runs ~30 scenarios: empty pool, healthy positions, marginal HF, multi-asset collateral, oracle staleness, race conditions.

## Submitting an adapter to the main repo

PRs welcome. Requirements:

- Conformance tests pass.
- Adapter has its own go.mod-compatible package path.
- README covers config and known limitations.
- An owner is identified for ongoing maintenance.

See [Contributing](./contributing).
