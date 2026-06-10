---
title: Keeper Go SDK
description: Programmatic API for the Nectar keeper Go module
---

# Keeper Go SDK

The keeper daemon is built from a Go module that you can import directly. Use it to write a custom keeper, embed Nectar in another bot, or replay historical state.

:::info
The SDK is currently exported but unversioned. Pin to a commit SHA. A tagged release (`v0.1.0`) ships at the end of Tranche 1.
:::

```go
import "github.com/Nectar-Network/nectar-poc/keeper/pkg/nectar"
```

## Client

The top-level entry point is `nectar.Client`:

```go
type Client struct {
    Registry *RegistryClient
    Vault    *VaultClient
    Blend    *BlendClient
    DEX      DEXAdapter
}

func NewClient(cfg Config) (*Client, error)
```

```go
cfg := nectar.Config{
    SorobanRPC:       "https://soroban-testnet.stellar.org:443",
    HorizonURL:       "https://horizon-testnet.stellar.org",
    NetworkPassphrase: "Test SDF Network ; September 2015",
    KeeperSecret:     os.Getenv("KEEPER_SECRET"),
    RegistryContract: "C...",
    VaultContract:    "C...",
    BlendPool:        "C...",
}

client, err := nectar.NewClient(cfg)
if err != nil {
    log.Fatal(err)
}
```

## Registry client

```go
func (r *RegistryClient) Register(ctx context.Context, name string, stake uint64) error
func (r *RegistryClient) StakeAdd(ctx context.Context, amount uint64) error
func (r *RegistryClient) Unregister(ctx context.Context) error
func (r *RegistryClient) ClaimStake(ctx context.Context) error
func (r *RegistryClient) GetKeeper(ctx context.Context, addr string) (*KeeperInfo, error)
func (r *RegistryClient) ListKeepers(ctx context.Context) ([]*KeeperInfo, error)
```

## Vault client

```go
func (v *VaultClient) Deposit(ctx context.Context, amount uint64) (shares uint64, err error)
func (v *VaultClient) RequestWithdraw(ctx context.Context, shares uint64) error
func (v *VaultClient) ClaimWithdraw(ctx context.Context) (amount uint64, err error)
func (v *VaultClient) Draw(ctx context.Context, amount uint64) error
func (v *VaultClient) ReturnProceeds(ctx context.Context, amount uint64) error
func (v *VaultClient) CancelDraw(ctx context.Context) error

func (v *VaultClient) State(ctx context.Context) (*VaultState, error)
func (v *VaultClient) SharePrice(ctx context.Context) (price float64, err error)
func (v *VaultClient) BalanceOf(ctx context.Context, addr string) (uint64, error)
```

## Blend client

```go
func (b *BlendClient) PoolState(ctx context.Context) (*PoolState, error)
func (b *BlendClient) UserPosition(ctx context.Context, user string) (*Position, error)
func (b *BlendClient) UnderwaterUsers(ctx context.Context) ([]string, error)
func (b *BlendClient) HealthFactor(ctx context.Context, user string) (float64, error)

func (b *BlendClient) SimulateFill(ctx context.Context, user string, debt uint64) (*FillEstimate, error)
func (b *BlendClient) Fill(ctx context.Context, user string, debt uint64) (*FillResult, error)
```

`FillEstimate.Profit` is the simulated lot/bid ratio. Use it to gate `Fill`:

```go
est, err := client.Blend.SimulateFill(ctx, user, debt)
if err != nil { return err }
if est.Profit < 1.02 {
    return nil  // not profitable
}
```

## DEX adapter

```go
type DEXAdapter interface {
    Quote(ctx context.Context, from, to string, amount uint64) (out uint64, err error)
    Swap(ctx context.Context, from, to string, amount uint64, minOut uint64) (uint64, error)
}
```

Built-in implementations: `nectar.AquaAdapter`, `nectar.SoroswapAdapter`, `nectar.AutoAdapter`.

Plug a custom one in via `cfg.DEX = myAdapter`.

## Full example: liquidate one auction

```go
ctx := context.Background()

// 1. Find the most underwater user
users, err := client.Blend.UnderwaterUsers(ctx)
if err != nil || len(users) == 0 { return }
user := users[0]
pos, _ := client.Blend.UserPosition(ctx, user)

// 2. Simulate
est, err := client.Blend.SimulateFill(ctx, user, pos.Debt)
if err != nil || est.Profit < 1.02 { return }

// 3. Draw
if err := client.Vault.Draw(ctx, pos.Debt); err != nil { return }

// 4. Fill
res, err := client.Blend.Fill(ctx, user, pos.Debt)
if err != nil {
    client.Vault.CancelDraw(ctx)  // race lost
    return
}

// 5. Sell collateral
proceeds, err := client.DEX.Swap(ctx, res.LotAsset, "USDC", res.LotAmount, res.LotAmount * 99 / 100)
if err != nil {
    // hold — sell manually
    return
}

// 6. Return
if err := client.Vault.ReturnProceeds(ctx, proceeds); err != nil { return }
```

## Logging & metrics

The SDK takes a `Logger` interface (zap-compatible by default) and an optional `Metrics` registry. Both nil values are accepted — the SDK runs silently if you don't wire them up.

## Versioning

Until `v1.0.0`:

- Public API may break between minor versions.
- Breaking changes are listed in the repo's `CHANGELOG.md`.
- Pin to commit SHA in production; do not rely on `latest`.
