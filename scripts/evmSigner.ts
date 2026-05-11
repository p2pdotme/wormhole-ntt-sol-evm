/**
 * Standalone ethers signer for direct EVM admin actions (deploy, setMinter,
 * transferOwnership, pause, etc.) that don't need the Wormhole SDK wrapper.
 *
 * Derivation pattern mirrors contracts-v4/scripts/upgradeDiamondInSingleTx.ts:
 *   m/44'/60'/0'/0/0 — the standard Ethereum BIP-44 account 0 / address 0 path.
 */
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet } from "ethers";
import { cfg, getNetwork } from "./config.js";

export function deriveSignerFromMnemonic(
  mnemonic: string,
  passphrase: string | undefined,
  provider: JsonRpcProvider,
): HDNodeWallet {
  const phrase = passphrase
    ? Mnemonic.fromPhrase(mnemonic, passphrase)
    : Mnemonic.fromPhrase(mnemonic);
  return HDNodeWallet.fromMnemonic(phrase, "m/44'/60'/0'/0/0").connect(provider);
}

export function getEvmProvider(): JsonRpcProvider {
  // Mainnet config has cfg.base.rpc (Base). Devnet config also exposes cfg.base.rpc
  // (which actually points at Ethereum Sepolia per the devnet branch in config.ts).
  const rpc =
    getNetwork() === "mainnet"
      ? process.env.BASE_RPC_URL ?? cfg.base.rpc
      : process.env.SEPOLIA_RPC_URL ?? cfg.base.rpc;
  return new JsonRpcProvider(rpc);
}

export function getEvmSigner(): HDNodeWallet | Wallet {
  const provider = getEvmProvider();

  const mnemonic = process.env.MNEMONIC_KEY;
  if (mnemonic) {
    const passphrase = process.env.WALLET_PASSPHRASE || undefined;
    const signer = deriveSignerFromMnemonic(mnemonic, passphrase, provider);
    console.info(`🔐 EVM signer (HD): ${signer.address}`);
    return signer;
  }

  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "No EVM key configured: set MNEMONIC_KEY (preferred) or PRIVATE_KEY",
    );
  }
  const signer = new Wallet(pk, provider);
  console.info(`🔐 EVM signer (raw): ${signer.address}`);
  return signer;
}
