import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair } from "@solana/web3.js";
import { HDNodeWallet, Mnemonic } from "ethers";
import {
  type ChainContext,
  type Signer,
  type Chain,
  chainToPlatform,
} from "@wormhole-foundation/sdk";
import evmSigner from "@wormhole-foundation/sdk/platforms/evm";
import solSigner from "@wormhole-foundation/sdk/platforms/solana";

function loadSolanaKeypair(): Keypair {
  const path = (process.env.SOLANA_PAYER ?? "~/.config/solana/id.json").replace(
    "~",
    homedir(),
  );
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

/**
 * Derive an Ethereum HD wallet from a BIP-39 mnemonic.
 * Uses the standard Ethereum derivation path m/44'/60'/0'/0/0.
 * Mirrors deriveSignerFromMnemonic() in contracts-v4/scripts/upgradeDiamondInSingleTx.ts.
 */
function deriveEvmPrivateKey(mnemonic: string, passphrase?: string): string {
  const phrase = passphrase
    ? Mnemonic.fromPhrase(mnemonic, passphrase)
    : Mnemonic.fromPhrase(mnemonic);
  const wallet = HDNodeWallet.fromMnemonic(phrase, "m/44'/60'/0'/0/0");
  return wallet.privateKey;
}

/**
 * Resolve an EVM private key.
 * Priority: MNEMONIC_KEY (HD-derived) > PRIVATE_KEY (raw hex).
 * WALLET_PASSPHRASE is optional and only used with MNEMONIC_KEY.
 */
function getEvmPrivateKey(): string {
  const mnemonic = process.env.MNEMONIC_KEY;
  if (mnemonic) {
    const passphrase = process.env.WALLET_PASSPHRASE || undefined;
    return deriveEvmPrivateKey(mnemonic, passphrase);
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "No EVM key configured: set MNEMONIC_KEY (preferred) or PRIVATE_KEY",
    );
  }
  return pk;
}

export async function getSigner<C extends Chain>(
  ctx: ChainContext<"Testnet", C>,
) {
  const platform = chainToPlatform(ctx.chain);
  if (platform === "Evm") {
    const pk = getEvmPrivateKey();
    const signer = await evmSigner.getSigner(await ctx.getRpc(), pk);
    console.info(`🔐 EVM signer: ${signer.address()}`);
    return {
      signer: signer as Signer,
      address: { chain: ctx.chain, address: signer.address() } as ReturnType<
        Signer["address"]
      > extends string
        ? never
        : { chain: Chain; address: any },
    } as any;
  }
  if (platform === "Solana") {
    const kp = loadSolanaKeypair();
    const signer = await solSigner.getSigner(await ctx.getRpc(), kp);
    return {
      signer: signer as Signer,
      address: { chain: ctx.chain, address: signer.address() } as any,
    } as any;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
