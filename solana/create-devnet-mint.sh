#!/usr/bin/env bash
# Creates a devnet SPL mint that mirrors the mainnet token P2PXup...meta:
#   - 6 decimals
#   - classic SPL Token program (not Token-2022)
#   - no freeze authority
#   - mint authority = the local solana CLI keypair (you)
#
# Idempotent-ish: if MINT_FILE exists it re-uses that keypair so re-runs don't
# orphan mints. Mints 1,000,000.000000 tokens to your ATA for testing.
set -euo pipefail

cd "$(dirname "$0")"

CLUSTER="${CLUSTER:-devnet}"
MINT_FILE="${MINT_FILE:-./devnet-mint.json}"
DECIMALS=6
INITIAL_SUPPLY="${INITIAL_SUPPLY:-1000000}"

solana config set --url "$CLUSTER" >/dev/null

if ! command -v spl-token >/dev/null; then
  echo "spl-token CLI not found. Install with: cargo install spl-token-cli" >&2
  exit 1
fi

PAYER="$(solana address)"
echo "Payer:    $PAYER"
echo "Cluster:  $CLUSTER"

# Ensure some SOL
BAL_LAMPORTS=$(solana balance --lamports | awk '{print $1}')
if [ "${BAL_LAMPORTS:-0}" -lt 100000000 ]; then
  echo "Airdropping 2 SOL..."
  solana airdrop 2 || true
fi

if [ ! -f "$MINT_FILE" ]; then
  echo "Generating mint keypair at $MINT_FILE"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$MINT_FILE" >/dev/null
fi
MINT_PUBKEY=$(solana-keygen pubkey "$MINT_FILE")

# Create the mint if it doesn't already exist on-chain
if ! solana account "$MINT_PUBKEY" >/dev/null 2>&1; then
  echo "Creating mint $MINT_PUBKEY (decimals=$DECIMALS)"
  spl-token create-token \
    --decimals "$DECIMALS" \
    --mint-authority "$PAYER" \
    -- "$MINT_FILE"
else
  echo "Mint $MINT_PUBKEY already exists, skipping create-token."
fi

# Create ATA for payer + mint initial supply (idempotent)
spl-token create-account "$MINT_PUBKEY" 2>/dev/null || true
spl-token mint "$MINT_PUBKEY" "$INITIAL_SUPPLY"

echo
echo "==> Devnet replica ready"
echo "    mint:      $MINT_PUBKEY"
echo "    decimals:  $DECIMALS"
echo "    supply:    $INITIAL_SUPPLY (in your ATA)"
echo
echo "Next: paste this address into ntt/deployment.json under chains.Solana.token,"
echo "      and into ntt/.env as SPL_MINT for the testnet rehearsal."
