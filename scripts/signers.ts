import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair } from "@solana/web3.js";
import { Wallet, JsonRpcProvider } from "ethers";
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

export async function getSigner<C extends Chain>(
  ctx: ChainContext<"Testnet", C>,
) {
  const platform = chainToPlatform(ctx.chain);
  if (platform === "Evm") {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY not set");
    const provider = new JsonRpcProvider(
      process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    );
    const wallet = new Wallet(pk, provider);
    const signer = await evmSigner.getSigner(await ctx.getRpc(), pk);
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
