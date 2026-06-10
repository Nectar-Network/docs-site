---
title: Keeper Setup
description: Run a Nectar keeper in under 10 minutes
---

# Keeper Setup

:::info
This takes ~10 minutes. You'll need: Go 1.22+, a Stellar keypair, and USDC for staking.
:::

## Prerequisites

- Go 1.22 or later ([install](https://go.dev/dl/))
- A Stellar keypair with XLM for transaction fees
- USDC for keeper staking (minimum: 100 USDC on testnet)
- A reliable VPS or always-on machine — keepers need to be online to compete

## 1. Clone and build

```bash
git clone https://github.com/Nectar-Network/nectar-poc.git
cd nectar-poc/keeper
go build -o nectar-keeper ./cmd/
```

You should now have a `nectar-keeper` binary in the `keeper/` directory.

## 2. Create a keypair

If you don't already have a keypair dedicated to this keeper, generate one:

```bash
go run ./cmd/keygen
```

This prints a `G...` public key and `S...` secret key. Save the secret key somewhere safe — you'll need it as `KEEPER_SECRET`.

:::warning
Use a fresh keypair for each keeper instance. Do not reuse a keypair you use for personal funds.
:::

## 3. Configure

Create a `.env` file in the project root or export these variables:

```bash
export KEEPER_SECRET="S..."           # Your Stellar secret key
export KEEPER_NAME="my-keeper"        # Display name (shown on leaderboard)
export REGISTRY_CONTRACT="C..."       # KeeperRegistry contract
export VAULT_CONTRACT="C..."          # NectarVault contract
export BLEND_POOL="C..."              # Blend pool to monitor
export SOROBAN_RPC="https://soroban-testnet.stellar.org:443"
export HORIZON_URL="https://horizon-testnet.stellar.org"
export POLL_INTERVAL="10"
export MIN_PROFIT="1.02"
```

Get the current testnet contract addresses from [Contract Addresses](../reference/contract-addresses). See [Configuration](./configuration) for every available option.

## 4. Fund your keeper

Your keeper address needs:

- **XLM** for transaction fees (~10 XLM to start). Fund from [Friendbot](https://friendbot.stellar.org/?addr=YOUR_KEEPER_ADDRESS).
- **USDC** for staking (minimum set by registry, currently 100 USDC). Mint from the Nectar testnet faucet at [nectarnetwork.fun/faucet](https://nectarnetwork.fun/faucet).

Verify balances before continuing:

```bash
./nectar-keeper balance
```

Expected output:

```
keeper address: GABCD...
XLM:  10000.0000000
USDC: 100.0000000
```

## 5. Run

```bash
./nectar-keeper
```

The keeper will:

1. Register itself in `KeeperRegistry` if not already registered (this stakes USDC).
2. Start polling the Blend pool every `POLL_INTERVAL` seconds.
3. Compute health factors for all positions in the pool.
4. When `HF < 1` and simulated profit ≥ `MIN_PROFIT`, draw from the vault and fill the auction.

Logs you'll see in normal operation:

```
INFO  registered name=my-keeper stake=100 USDC
INFO  poll  pool=C... positions=42 underwater=0
INFO  poll  pool=C... positions=42 underwater=1 best_profit=1.043
INFO  draw  amount=85.20 auction=user_X liability=USDC
INFO  fill  tx=abc123 lot=99.40 XLM proceeds=87.60 USDC profit=2.40
INFO  return tx=def456 returned=87.60 keeper_fee=0.24
```

## 6. Verify on the dashboard

Visit [nectarnetwork.fun/performance](https://nectarnetwork.fun/performance). Your keeper should appear in the leaderboard within a poll interval. The status badge will read **active** once at least one fill is recorded.

## Running as a service

For a long-running deployment, use systemd, Docker, or a process manager. See [Docker Deployment](./docker) for the recommended path.

A minimal `systemd` unit:

```ini
[Unit]
Description=Nectar Keeper
After=network.target

[Service]
Type=simple
User=nectar
EnvironmentFile=/etc/nectar/keeper.env
ExecStart=/opt/nectar/nectar-keeper
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## What's next

- [Configuration reference](./configuration)
- [Strategies](./strategies) — pick conservative, balanced, or aggressive
- [Staking](./staking) — how slashing works
- [Troubleshooting](./troubleshooting)
