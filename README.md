# sol-base-ntt

Wormhole NTT bridge for an existing SPL token on Solana ↔ a governance ERC20 on Base.

**Networks**
- Mainnet target: Solana mainnet ↔ **Base mainnet**
- Testnet rehearsal: Solana devnet ↔ **Ethereum Sepolia** (matches the
  validated path from sibling project `sol-base-bridge`).

**Topology**

```
Solana (mainnet/devnet)          Base mainnet  (or Sepolia for rehearsal)
┌──────────────────┐             ┌────────────────────────────┐
│ SPL mint (yours) │             │ GovernanceNttToken (ERC20  │
│        ▲         │             │   + Votes + Permit + NTT)  │
│        │ lock    │             │        ▲     burn/mint     │
│  NttManager      │◄── VAA ────►│   NttManager (burning)     │
│  (locking mode)  │             │   WormholeTransceiver      │
│  WormholeXcvr    │             │                            │
└──────────────────┘             └────────────────────────────┘
        ▲                                      ▲
   custody account                       minter = NttManager
```

Solana is the **hub**: total supply lives on Solana and is locked when bridged
out; Base mints/burns its representation against that custody.

---

## Layout

```
evm/         Foundry project: GovernanceNttToken + deploy/setMinter scripts
ntt/         deployment.json template for the `ntt` CLI
scripts/     TS transfer + status scripts using @wormhole-foundation/sdk
```

## Prerequisites

- `foundry` (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- `solana` CLI + a funded devnet keypair (`solana airdrop 2`)
- `anchor` 0.29+ (only needed if you fork the NTT program; not for the standard path)
- Node 20+ and `pnpm` or `npm`
- `ntt` CLI: `curl -fsSL https://raw.githubusercontent.com/wormhole-foundation/example-native-token-transfers/main/cli/install.sh | bash`

---

## Step-by-step (testnet rehearsal)

The mainnet token (`P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta`, 6 decimals)
does not exist on devnet, so we first deploy a **devnet replica** with the
same decimals and rehearse the full bridge flow against **Ethereum Sepolia**
(the EVM testnet target validated by the sibling `sol-base-bridge` project).
Once green, swap addresses + chain name for the mainnet cutover (see "Going
to mainnet" below).

### 0. Create the devnet replica SPL

```bash
solana/create-devnet-mint.sh
# prints the new mint address; paste it into:
#   - ntt/deployment.json -> chains.Solana.token
#   - ntt/.env            -> SPL_MINT
```

### 1. Deploy the ERC20 on Base Sepolia

```bash
cd evm
cp .env.example .env       # fill PRIVATE_KEY, TOKEN_*, owner
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts \
              wormhole-foundation/example-native-token-transfers \
              wormhole-foundation/wormhole-solidity-sdk
forge test
forge script script/DeployToken.s.sol --rpc-url sepolia --broadcast --verify
```

Copy the deployed address into `evm/.env` as `TOKEN_ADDRESS` and into
`ntt/deployment.json` under `chains.Sepolia.token`.

> ⚠️ `TOKEN_DECIMALS` **must equal** the SPL mint decimals. NTT trims to the
> minimum of the two sides; mismatched decimals silently lose precision.

### 2. Initialize the NTT project

```bash
cd ../ntt
ntt init Testnet                 # creates an ntt workspace; keep our deployment.json
# Replace the auto-generated deployment.json with ours, or copy our values in.
```

### 3. Add Solana (locking) and Base Sepolia (burning)

Set `SPL_MINT` and your Base `TOKEN_ADDRESS`, then:

```bash
# Solana side: locking mode against the existing SPL mint
ntt add-chain Solana \
  --mode locking \
  --token "$SPL_MINT" \
  --payer "$SOLANA_PAYER" \
  --latest

# Base side: burning mode against our governance ERC20 (do NOT let ntt deploy a token)
ntt add-chain Sepolia \
  --mode burning \
  --token "$TOKEN_ADDRESS" \
  --skip-verify \
  --latest
```

`add-chain` writes the freshly deployed `manager` and `wormhole` transceiver
addresses back into `deployment.json`.

### 4. Grant the NttManager mint authority on Base

```bash
cd ../evm
# NTT_MANAGER_ADDRESS = chains.Sepolia.manager from deployment.json
NTT_MANAGER_ADDRESS=0x... forge script script/SetMinter.s.sol \
  --rpc-url sepolia --broadcast
```

> On Solana (locking mode) **no** mint-authority change is needed — the SPL
> mint stays under your control; the program escrows tokens in a custody PDA.

### 5. Push peer registrations + rate limits

```bash
cd ../ntt
ntt push --payer "$SOLANA_PAYER"
ntt status            # both chains should show peers & matching threshold
```

### 6. Sanity check

```bash
cd ../scripts
cp .env.example .env
pnpm install
pnpm status
```

### 7. Bridge

```bash
# Solana -> Base: locks SPL on Solana, mints ERC20 on Base
AMOUNT=1.5 RECIPIENT=0xYourBaseAddress pnpm transfer:sol-to-base

# Base -> Solana: burns ERC20 on Base, releases SPL on Solana
AMOUNT=1.5 RECIPIENT=YourSolanaPubkey pnpm transfer:base-to-sol
```

---

## Going to mainnet

A pre-filled `ntt/deployment.mainnet.json` is included with the real mint
already set (`P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta`).

1. `cp ntt/deployment.mainnet.json ntt/deployment.json` (or `ntt --config`).
2. Replace `REPLACE_WITH_*` owners with **multisig addresses** on both chains.
3. Deploy the Base ERC20 to **Base mainnet** with the same Foundry script,
   `TOKEN_DECIMALS=6`, owner = your Base multisig. Update
   `chains.Base.token`.
4. `ntt add-chain Solana --mode locking --token P2PXup...meta --payer <signer-with-rights>`
   then `ntt add-chain Base --mode burning --token <erc20>`.
   - Solana side does **not** require touching the existing mint authority
     (`9Rykf7i9fxUaXD8iD6GSGpRaoWQQP51Uiq1oxSE9oDzx`); locking mode escrows
     into a custody PDA owned by the NTT program.
5. `forge script SetMinter.s.sol --rpc-url base --broadcast` to grant the
   Base NttManager mint rights on the ERC20.
6. Tighten outbound/inbound rate limits in `deployment.json` to amounts you
   can underwrite, then `ntt push`.
7. Transfer ownership of both NttManagers to the multisigs and revoke
   temporary deploy keys.

## Operational notes

- **Pausing**: `ntt pause` / `ntt unpause` halts new transfers; in-flight VAAs
  can still be redeemed unless rate-limited.
- **Rate limits**: configured per direction in `deployment.json`; transfers
  exceeding them are queued and must be `completeOutboundQueuedTransfer`d.
- **Upgrades**: NTT contracts are upgradeable on both sides; the `owner`
  controls upgrades. Putting that owner behind a timelock + multisig is the
  recommended production posture.
- **Decimals**: always set Base `TOKEN_DECIMALS` to the SPL decimals. Trim is
  silent.
