# Mainnet Deployment Guide — Solana ↔ Base NTT Bridge

End-to-end runbook for promoting the bridge from Testnet to Mainnet. Token: existing SPL `P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta` on Solana mainnet ↔ new `P2PGov` ERC20 on Base mainnet.

**Topology:** Solana = locking hub (existing SPL untouched, just escrowed). Base = burning spoke (fresh ERC20 with the NTT manager as sole minter).

---

## Contents

1. [Pre-deployment checklist](#1-pre-deployment-checklist)
2. [Environment setup](#2-environment-setup)
3. [Step 1 — Deploy Base ERC20](#step-1--deploy-base-erc20)
4. [Step 2 — Bootstrap NTT workspace](#step-2--bootstrap-ntt-workspace)
5. [Step 3 — Add Solana chain (locking)](#step-3--add-solana-chain-locking)
6. [Step 4 — Add Base chain (burning)](#step-4--add-base-chain-burning)
7. [Step 5 — Grant manager mint rights](#step-5--grant-manager-mint-rights)
8. [Step 6 — Set rate limits + peer registration](#step-6--set-rate-limits--peer-registration)
9. [Step 7 — Smoke test both directions](#step-7--smoke-test-both-directions)
10. [Step 8 — Hand off to multisigs](#step-8--hand-off-to-multisigs)
11. [Step 9 — Publish canonical addresses](#step-9--publish-canonical-addresses)
12. [Rollback / emergency procedures](#rollback--emergency-procedures)
13. [Cost summary](#cost-summary)
14. [Post-deploy verification checklist](#post-deploy-verification-checklist)

---

## 1. Pre-deployment checklist

Before you start, confirm all of these:

- [ ] Testnet bridge worked end-to-end in both directions (Solana devnet ↔ Sepolia) — already done in this repo
- [ ] The existing SPL `P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta` is the correct canonical token on Solana mainnet
- [ ] You have control of a Solana keypair with ≥ 4 SOL on mainnet
- [ ] You have control of a Base address with ≥ 0.05 ETH on mainnet
- [ ] A paid Solana mainnet RPC endpoint is available (public devnet RPC is fine for testnet but unreliable for mainnet deploys with large program data)
- [ ] A paid Base RPC endpoint is available (Alchemy/Infura/QuickNode)
- [ ] Basescan API key for contract verification
- [ ] Multisig addresses ready: Squads on Solana, Safe on Base (for step 8)
- [ ] You've reviewed `BRIDGE.md` for the protocol model
- [ ] The Wormhole NTT CLI version is pinned and reproducible (record `ntt --version`)

Required tooling:
- `bun` (≥ 1.0)
- `ntt` CLI on `PATH` (`export PATH="$HOME/.bun/bin:$PATH"`)
- `solana` CLI (1.18.x), `spl-token` CLI
- `anchor` 0.29.0 (`avm use 0.29.0`)
- `foundry` (`forge`, `cast`)
- `jq`, `curl`, `xxd`

## 2. Environment setup

Open a session and export these once. **Treat secrets carefully — never commit them.**

```bash
export PATH="$HOME/.bun/bin:$PATH"

# RPC endpoints
export BASE_RPC="https://mainnet.base.org"                              # or Alchemy/QuickNode URL
export SOLANA_RPC="https://solana-mainnet.g.alchemy.com/v2/<YOUR_KEY>"  # premium recommended
export WORMHOLESCAN_API="https://api.wormholescan.io"

# Deployer credentials — mnemonic-first (matches scripts/signers.ts + evmSigner.ts)
# Derivation path m/44'/60'/0'/0/0 must resolve to the deployer EOA below.
export MNEMONIC_KEY="word word word word word word word word word word word word"
export WALLET_PASSPHRASE=""                                             # optional BIP-39 passphrase
export DEPLOYER_EOA="0x42AF7b2453cdbFDf51A1cE4238b514f5128cFBfE"        # = TOKEN_OWNER

# Derived raw private key — needed by tools that don't accept mnemonics
# (the `ntt` CLI and `cast send` read ETH_PRIVATE_KEY directly).
export ETH_PRIVATE_KEY=$(node -e "const {HDNodeWallet,Mnemonic}=require('ethers');\
const m=process.env.MNEMONIC_KEY;const p=process.env.WALLET_PASSPHRASE||undefined;\
console.log(HDNodeWallet.fromMnemonic(p?Mnemonic.fromPhrase(m,p):Mnemonic.fromPhrase(m),\"m/44'/60'/0'/0/0\").privateKey)")

# Sanity: confirm the derived address matches DEPLOYER_EOA
test "$(cast wallet address --private-key $ETH_PRIVATE_KEY)" = "$DEPLOYER_EOA" \
  && echo "✅ mnemonic resolves to $DEPLOYER_EOA" \
  || { echo "❌ mnemonic does NOT resolve to $DEPLOYER_EOA — abort"; exit 1; }

# Solana deployer (will own the NTT manager initially)
export SOLANA_PRIVATE_KEY="<base58-secret>"                             # only needed if not using local keypair
export SOLANA_PAYER_ADDR="HqE6fC9fRjHGxeBo1mMwkrj5m7N3FbMcGQSCPmrHbYkC"

export BASESCAN_API_KEY="<key>"

# Canonical addresses
export SPL_MINT="P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta"
export TOKEN_NAME="P2P Protocol"
export TOKEN_SYMBOL="P2P"
export TOKEN_DECIMALS=6
export TOKEN_OWNER="$DEPLOYER_EOA"

# Multisig targets (fill in before step 8; leave blank to defer)
export SAFE_ADDR=""             # Base Safe
export SQUADS_ADDR=""           # Solana Squads vault

# Configure Solana CLI for mainnet
solana config set --url $SOLANA_RPC
```

Sanity-check balances:

```bash
solana balance $SOLANA_PAYER_ADDR                            # ≥ 3.6 SOL
cast balance $DEPLOYER_EOA --rpc-url $BASE_RPC               # ≥ 0.03 ETH (30000000000000000 wei)
```

---

## Step 1 — Deploy Base ERC20

Deploy `P2PGov`. The deployer becomes the initial `owner` and `minter` (minter will be reassigned to the NTT manager in step 5).

```bash
cd /Users/nedstark/claud-codebase/sol-base-ntt/evm

forge install                                # if libs not present
forge build

TOKEN_NAME="$TOKEN_NAME" \
TOKEN_SYMBOL="$TOKEN_SYMBOL" \
TOKEN_DECIMALS=$TOKEN_DECIMALS \
TOKEN_OWNER=$TOKEN_OWNER \
forge script script/DeployToken.s.sol:DeployToken \
  --rpc-url $BASE_RPC \
  --mnemonics "$MNEMONIC_KEY" \
  $( [ -n "$WALLET_PASSPHRASE" ] && echo --mnemonic-passphrases "$WALLET_PASSPHRASE" ) \
  --mnemonic-derivation-paths "m/44'/60'/0'/0/0" \
  --sender $DEPLOYER_EOA \
  --broadcast --verify \
  --etherscan-api-key $BASESCAN_API_KEY \
  -vvv
```

If `WALLET_PASSPHRASE` is empty, drop the `--mnemonic-passphrases` line entirely (the `$( … && echo … )` guard above does this automatically in zsh/bash).

Record the deployed address:

```bash
export TOKEN_BASE=0x<from-script-output>
echo "Base ERC20: $TOKEN_BASE"
```

Verify the deploy:

```bash
cast call $TOKEN_BASE "name()(string)"        --rpc-url $BASE_RPC
cast call $TOKEN_BASE "symbol()(string)"      --rpc-url $BASE_RPC
cast call $TOKEN_BASE "decimals()(uint8)"     --rpc-url $BASE_RPC
cast call $TOKEN_BASE "totalSupply()(uint256)" --rpc-url $BASE_RPC   # should be 0
cast call $TOKEN_BASE "owner()(address)"      --rpc-url $BASE_RPC
cast call $TOKEN_BASE "clock()(uint48)"       --rpc-url $BASE_RPC    # block.timestamp for EIP-6372
cast call $TOKEN_BASE "CLOCK_MODE()(string)"  --rpc-url $BASE_RPC    # "mode=timestamp"
```

Expected: `decimals == 6` (matches SPL), `totalSupply == 0` (mints will come exclusively from the bridge), clock mode = timestamp (required for Base L2 vote checkpoints).

---

## Step 2 — Bootstrap NTT workspace

Create a clean mainnet workspace separate from the testnet one.

```bash
cd /Users/nedstark/claud-codebase/sol-base-ntt

ntt new ntt-mainnet
cd ntt-mainnet
ntt init Mainnet
ntt --version > .ntt-version    # pin for reproducibility
```

Create `overrides.json` (gitignored — contains RPC API keys):

```bash
cat > overrides.json <<EOF
{
  "chains": {
    "Solana": { "rpc": "$SOLANA_RPC" },
    "Base":   { "rpc": "$BASE_RPC"   }
  }
}
EOF
```

Generate the Solana NTT program keypair. **This keypair defines the manager program ID and is used exactly once during deploy — back it up and never lose it.**

```bash
solana-keygen new --no-bip39-passphrase --outfile ntt-program.json --force
export SOLANA_PROGRAM_ID=$(solana address -k ntt-program.json)
echo "Solana NTT program: $SOLANA_PROGRAM_ID"

# Back it up offline immediately
cp ntt-program.json ~/backups/ntt-program-$(date +%Y%m%d).json
```

---

## Step 3 — Add Solana chain (locking)

Deploys the manager + transceiver programs on Solana mainnet and points them at the existing SPL.

```bash
SOLANA_PRIVATE_KEY=$SOLANA_PRIVATE_KEY ntt add-chain Solana \
  --network Mainnet \
  --token $SPL_MINT \
  --mode locking \
  --payer ~/.config/solana/id.json \
  --program-key ntt-program.json
```

This will take 5–15 minutes (Solana program deploy + buffer write). Confirm `deployment.json` now has a Solana entry:

```bash
jq '.chains.Solana' deployment.json
```

Expected fields: `mode: "locking"`, `paused: false`, `owner: <your solana addr>`, `manager: <SOLANA_PROGRAM_ID>`, `token: P2PXup1Z…`, `transceivers.wormhole.address: …`.

Quick sanity probe:

```bash
solana program show $SOLANA_PROGRAM_ID
spl-token account-info $SPL_MINT
```

---

## Step 4 — Add Base chain (burning)

Deploys `NttManager` (proxy + impl) and `WormholeTransceiver` (proxy + impl) on Base. The token argument is your fresh ERC20.

```bash
ETH_PRIVATE_KEY=$ETH_PRIVATE_KEY ntt add-chain Base \
  --network Mainnet \
  --token $TOKEN_BASE \
  --mode burning
```

The CLI will simulate first and warn about owner checks — read the prompts. Confirm `deployment.json` updates:

```bash
jq '.chains.Base' deployment.json
export MANAGER_BASE=$(jq -r '.chains.Base.manager' deployment.json)
export XCVR_BASE=$(jq -r '.chains.Base.transceivers.wormhole.address' deployment.json)
echo "Base manager:     $MANAGER_BASE"
echo "Base transceiver: $XCVR_BASE"
```

Verify on-chain:

```bash
cast call $MANAGER_BASE "token()(address)"     --rpc-url $BASE_RPC   # = $TOKEN_BASE
cast call $MANAGER_BASE "owner()(address)"     --rpc-url $BASE_RPC   # = deployer
cast call $MANAGER_BASE "chainId()(uint16)"    --rpc-url $BASE_RPC   # = 30 (Base)
cast call $XCVR_BASE    "nttManager()(address)" --rpc-url $BASE_RPC  # = $MANAGER_BASE
```

---

## Step 5 — Grant manager mint rights

The NTT manager must be the token's `minter` for burning mode to work. The token's `setMinter` is owner-only.

```bash
cd /Users/nedstark/claud-codebase/sol-base-ntt/evm

TOKEN_ADDRESS=$TOKEN_BASE \
NTT_MANAGER_ADDRESS=$MANAGER_BASE \
forge script script/SetMinter.s.sol:SetMinter \
  --rpc-url $BASE_RPC \
  --mnemonics "$MNEMONIC_KEY" \
  $( [ -n "$WALLET_PASSPHRASE" ] && echo --mnemonic-passphrases "$WALLET_PASSPHRASE" ) \
  --mnemonic-derivation-paths "m/44'/60'/0'/0/0" \
  --sender $DEPLOYER_EOA \
  --broadcast

cd ../ntt-mainnet
```

Verify:

```bash
cast call $TOKEN_BASE "minter()(address)" --rpc-url $BASE_RPC
# MUST equal $MANAGER_BASE
```

This is the on-chain anchor that lets users verify the canonical bridge: `token.minter() == manager`.

---

## Step 6 — Set rate limits + peer registration

Edit `deployment.json` to set the inbound/outbound limits, then `ntt push` to apply them and register peers on both sides.

Rate limits are quoted in human-readable units (the CLI converts to raw 6-decimal units). Pick conservative limits for launch — you can raise them later.

```bash
# Solana outbound — total leaving Solana per 24h window
jq '.chains.Solana.limits.outbound = "1000000.000000"' deployment.json > tmp && mv tmp deployment.json

# Solana inbound from Base — total arriving at Solana from Base per 24h
jq '.chains.Solana.limits.inbound.Base = "1000000.000000"' deployment.json > tmp && mv tmp deployment.json

# Base outbound — usually unlimited for a burning spoke
jq '.chains.Base.limits.outbound = "18446744073709.551615"' deployment.json > tmp && mv tmp deployment.json

# Base inbound from Solana
jq '.chains.Base.limits.inbound.Solana = "1000000.000000"' deployment.json > tmp && mv tmp deployment.json

# Set threshold (1 transceiver = 1)
jq '.chains.Solana.transceivers.threshold = 1' deployment.json > tmp && mv tmp deployment.json
jq '.chains.Base.transceivers.threshold   = 1' deployment.json > tmp && mv tmp deployment.json
```

Push the config — this writes peers and limits on-chain on both Solana and Base:

```bash
SOLANA_PRIVATE_KEY=$SOLANA_PRIVATE_KEY \
ETH_PRIVATE_KEY=$ETH_PRIVATE_KEY \
  ntt push --network Mainnet --payer ~/.config/solana/id.json --yes
```

Verify the result:

```bash
ntt status --network Mainnet --payer ~/.config/solana/id.json
# Should print "in sync" or equivalent for both Solana and Base

# Independent on-chain check
cast call $MANAGER_BASE "getPeer(uint16)((bytes32,uint8))" 1 --rpc-url $BASE_RPC
# returns (solana_manager_program_id_universal, 6)

# Solana peer is a PDA, derived from manager program + ["peer", 30_be]
```

Note: unlike testnet, **mainnet does NOT need the Sepolia/Ethereum dual-registration workaround.** Base's Wormhole chain id is 30 everywhere — no aliasing.

---

## Step 7 — Smoke test both directions

Start with the **smallest possible amount** (1 raw unit = `0.000001` token). Both sides should round-trip cleanly.

### 7a. Solana → Base (lock + mint)

```bash
RECIPIENT_BASE=$(cast wallet address --private-key $ETH_PRIVATE_KEY)

# Initiate
SOLANA_PRIVATE_KEY=$SOLANA_PRIVATE_KEY ntt manual transfer 1.0 \
  --from Solana --to Base \
  --recipient $RECIPIENT_BASE \
  --payer ~/.config/solana/id.json \
  -n Mainnet \
  2>&1 | tee /tmp/sol2base.log

# Record the Solana signature
SOL_TX=$(grep -o '[0-9A-Za-z]\{80,90\}' /tmp/sol2base.log | head -1)
echo "Solana tx: $SOL_TX"
```

Wait ~2–5 minutes for guardians to sign, then fetch the VAA:

```bash
curl -s "$WORMHOLESCAN_API/api/v1/vaas?txHash=$SOL_TX" | jq '.data[0]'

curl -s "$WORMHOLESCAN_API/api/v1/vaas?txHash=$SOL_TX" \
  | jq -r '.data[0].vaa' \
  | base64 -d | xxd -p | tr -d '\n' > /tmp/vaa.hex
```

Redeem on Base:

```bash
ETH_PRIVATE_KEY=$ETH_PRIVATE_KEY ntt manual redeem $(cat /tmp/vaa.hex) \
  --chain Base --network Mainnet
```

Verify:

```bash
cast call $TOKEN_BASE "balanceOf(address)(uint256)" $RECIPIENT_BASE --rpc-url $BASE_RPC
# 1000000 (= 1.0 token in 6-decimal raw units)

cast call $TOKEN_BASE "totalSupply()(uint256)" --rpc-url $BASE_RPC
# 1000000 — first mint
```

### 7b. Base → Solana (burn + release)

```bash
RECIPIENT_SOL=$(solana address)

# Initiate
ETH_PRIVATE_KEY=$ETH_PRIVATE_KEY ntt manual transfer 0.5 \
  --from Base --to Solana \
  --recipient $RECIPIENT_SOL \
  -n Mainnet \
  2>&1 | tee /tmp/base2sol.log

BASE_TX=$(grep -oE '0x[0-9a-fA-F]{64}' /tmp/base2sol.log | head -1)
echo "Base tx: $BASE_TX"
```

Fetch VAA:

```bash
curl -s "$WORMHOLESCAN_API/api/v1/vaas?txHash=$BASE_TX" \
  | jq -r '.data[0].vaa' | base64 -d | xxd -p | tr -d '\n' > /tmp/vaa.hex
```

Redeem on Solana:

```bash
SOLANA_PRIVATE_KEY=$SOLANA_PRIVATE_KEY ntt manual redeem $(cat /tmp/vaa.hex) \
  --chain Solana --network Mainnet \
  --payer ~/.config/solana/id.json
```

Verify:

```bash
spl-token balance $SPL_MINT
# Should reflect the 0.5 release back to your address

cast call $TOKEN_BASE "totalSupply()(uint256)" --rpc-url $BASE_RPC
# 500000 — burned 0.5
```

If both round-trips succeed, the bridge is functional. If either fails, stop and debug before proceeding to ownership transfer.

---

## Step 8 — Hand off to multisigs

**Do not skip this.** Single-key ownership is the largest operational risk in a deployed bridge.

### Solana — transfer manager ownership to Squads

```bash
SOLANA_PRIVATE_KEY=$SOLANA_PRIVATE_KEY ntt set-owner Solana $SQUADS_ADDR \
  --network Mainnet \
  --payer ~/.config/solana/id.json
```

Verify:

```bash
jq '.chains.Solana.owner' deployment.json   # = $SQUADS_ADDR
ntt status --network Mainnet --payer ~/.config/solana/id.json
```

### Base — transfer manager ownership to Safe

NTT uses a two-step ownership transfer (`transferOwnership` + `acceptOwnership`). The Safe must execute the accept.

```bash
ETH_PRIVATE_KEY=$ETH_PRIVATE_KEY ntt set-owner Base $SAFE_ADDR \
  --network Mainnet
```

Then propose the `acceptOwnership()` tx through the Safe UI and execute it via the Safe's signers.

### Base — transfer ERC20 `Ownable2Step` to Safe

The ERC20 owner controls `setMinter` (extremely sensitive — can repoint mint rights). Move it to the same Safe:

```bash
cast send $TOKEN_BASE "transferOwnership(address)" $SAFE_ADDR \
  --rpc-url $BASE_RPC --private-key $ETH_PRIVATE_KEY
```

Then have the Safe call `acceptOwnership()`:

```bash
# Encode for Safe
cast calldata "acceptOwnership()"
# Submit via Safe UI / SDK
```

Verify all three:

```bash
cast call $TOKEN_BASE   "owner()(address)" --rpc-url $BASE_RPC          # = $SAFE_ADDR
cast call $MANAGER_BASE "owner()(address)" --rpc-url $BASE_RPC          # = $SAFE_ADDR
# Solana owner: ntt status shows owner = $SQUADS_ADDR
```

Optional — also set the pauser to a hot key (not the multisig) so an incident response can pause the bridge in seconds without assembling signatures:

```bash
# Via Safe tx
cast calldata "setPauser(address)" 0x<hot-pauser-key>
```

---

## Step 9 — Publish canonical addresses

The bridge is live but users cannot find it yet. Until you publish, anyone who deploys a competing NTT against `P2PXup1Z…` could become the de-facto bridge (see `BRIDGE.md` § fake-token discussion).

### 9a. Commit the manifest

```bash
cd /Users/nedstark/claud-codebase/sol-base-ntt
mkdir -p deployments
cp ntt-mainnet/deployment.json deployments/mainnet.json

git add deployments/mainnet.json
git commit -m "Add mainnet deployment manifest (Solana ↔ Base)"
git push origin main
```

### 9b. Update `README.md`

Add a "Mainnet" section with the four canonical addresses:

```markdown
## Mainnet (production)

| Component | Solana                                       | Base                                          |
|-----------|----------------------------------------------|-----------------------------------------------|
| Token     | P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta | 0x<TOKEN_BASE>                                |
| Manager   | <SOLANA_PROGRAM_ID>                          | 0x<MANAGER_BASE>                              |
| Transceiver | <SOL_TRANSCEIVER>                          | 0x<XCVR_BASE>                                 |
| Owner     | <SQUADS_ADDR>                                | 0x<SAFE_ADDR>                                 |

**Verify the canonical bridge:** `Token.minter()` on Base MUST equal the manager address above. Any address that doesn't match is a fake.
```

Commit and push.

### 9c. Submit to off-chain registries

- **Wormholescan NTT registry** — submit the deployment through Wormholescan's submission form so it appears as a verified NTT in the explorer
- **Token lists** — submit to CoinGecko, CoinMarketCap, Uniswap default list, Jupiter strict list
- **Wallet verification** — Phantom and MetaMask both maintain token verification programs
- **Block explorers** — verify the ERC20 source on Basescan (already done via `--verify` in step 1), label the manager + transceiver on Basescan and Solscan

### 9d. Announce

Publish the canonical addresses through:
- Project website
- Official Twitter / social
- Discord / Telegram pinned message
- A signed GitHub release tag on this repo

The more places the canonical addresses appear in signed/verifiable channels, the harder it is for a phishing variant to gain traction.

---

## Rollback / emergency procedures

### Pause the bridge

Either side can be paused independently. Pausing freezes all transfers and redeems on that chain. The other chain keeps operating — in-flight VAAs simply can't be redeemed on the paused chain until it's resumed.

```bash
# Base — via the pauser key
cast send $MANAGER_BASE "pause()" --rpc-url $BASE_RPC --private-key $PAUSER_KEY

# Solana — via the pauser
SOLANA_PRIVATE_KEY=$PAUSER_SOL ntt pause Solana --network Mainnet --payer ~/.config/solana/id.json
```

Unpause requires the owner (multisig):

```bash
cast send $MANAGER_BASE "unpause()" --rpc-url $BASE_RPC --private-key $SAFE_SIGNER   # via Safe
```

### Lower rate limits in response to incident

```bash
# Reduce Base inbound to 0 to halt redeems from Solana
jq '.chains.Base.limits.inbound.Solana = "0"' deployment.json > tmp && mv tmp deployment.json
ntt push --network Mainnet --payer ~/.config/solana/id.json --yes
```

### Recover a stuck transfer

If the executor never relays an `automatic: true` transfer, manually redeem with the VAA. Same `ntt manual redeem` flow used in step 7.

### Upgrade contracts

Both `NttManager` and `WormholeTransceiver` are UUPS upgradeable on Base. Solana programs are upgradeable via the program upgrade authority (initially the deployer; transfer to multisig). Upgrades should go through governance review — `ntt upgrade <chain>` automates the deploy + `upgradeTo` call.

---

## Cost summary

Approximate one-time costs:

| Item | Chain | Cost |
|---|---|---|
| Token deploy | Base | ~0.005 ETH |
| Manager + transceiver deploy (`ntt add-chain Base`) | Base | ~0.015 ETH |
| `setMinter` | Base | ~0.0002 ETH |
| Peer registration (`ntt push`) | Base | ~0.001 ETH |
| Smoke test transfers | Base | ~0.001 ETH |
| Ownership transfer | Base | ~0.0002 ETH |
| **Total Base** | | **~0.025 ETH** |
| Manager + transceiver program deploy | Solana | ~3.5 SOL |
| Initialization, peers, smoke tests | Solana | ~0.05 SOL |
| Custody ATA rent | Solana | ~0.002 SOL |
| **Total Solana** | | **~3.6 SOL** |

Recurring costs are negligible (per-transfer gas paid by users).

---

## Post-deploy verification checklist

After step 9, an independent reviewer should be able to confirm each of these without your help:

- [ ] `deployments/mainnet.json` is committed and signed via GitHub
- [ ] `Token.minter()` on Base equals the manager address in the manifest
- [ ] `Token.owner()` on Base equals the Safe address
- [ ] `Manager.owner()` on Base equals the Safe address
- [ ] `Manager.token()` on Base equals the token address
- [ ] `Manager.getPeer(1)` on Base returns the Solana manager program ID (as bytes32)
- [ ] Solana manager `config.owner` equals the Squads vault
- [ ] Solana manager `peers[30]` and `transceiver_peers[30]` exist and point at the Base addresses
- [ ] Custody account on Solana is an SPL token account owned by `[b"token_authority"]` PDA, holding the SPL `P2PXup1Z…`
- [ ] `ntt status` reports "in sync" for both chains
- [ ] Both directions of a small smoke transfer succeed
- [ ] Wormholescan shows the deployment in its NTT registry
- [ ] At least one token list / wallet verification has accepted the canonical addresses
- [ ] Pauser key is hot (separate from owner multisig) for fast incident response

If every box is checked, the bridge is production-ready.

---

## Reference

- Protocol architecture: `BRIDGE.md`
- Testnet manifest (rehearsal): `deployments/testnet.json`
- Token source: `evm/src/P2PGov.sol` (sourced from `/Users/nedstark/claud-codebase/contracts-v4/contracts/P2PGov.sol`)
- Deploy scripts: `evm/script/DeployToken.s.sol`, `evm/script/SetMinter.s.sol`
- Manager source: upstream — `ntt-workspace/evm/src/NttManager/NttManager.sol`
- Transceiver source: upstream — `ntt-workspace/evm/src/Transceiver/WormholeTransceiver/`
- Wormhole chain ids: Solana=1, Base=30, Ethereum=2
