/**
 * Bridge SPL -> ERC20 (Solana devnet -> Base Sepolia).
 *
 * Flow:
 *   1. Solana NttManager (locking) takes custody of the SPL amount.
 *   2. WormholeTransceiver emits a VAA to BaseSepolia.
 *   3. Anyone can `redeem` on Base; NttManager (burning) mints the ERC20 to the recipient.
 *
 * Usage:
 *   AMOUNT=1.5 RECIPIENT=0x... pnpm tsx solana-to-base.ts
 */

import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  amount,
  signSendWait,
  toUniversal,
  type ChainAddress,
} from "@wormhole-foundation/sdk";
import { getSigner } from "./signers.js";
import { DST, SRC, getWh, nttContracts } from "./config.js";
// SRC/DST come from NETWORK= selector (Solana <-> Base or BaseSepolia)

async function main() {
  const rawAmount = process.env.AMOUNT ?? "1";
  const recipient = process.env.RECIPIENT;
  if (!recipient) throw new Error("set RECIPIENT=0x... (Base address)");

  const wh = await getWh();
  const src = wh.getChain(SRC);
  const dst = wh.getChain(DST);

  const srcSigner = await getSigner(src);
  const dstAddr: ChainAddress = {
    chain: DST,
    address: toUniversal(DST, recipient),
  };

  const srcNtt = await src.getProtocol("Ntt", { ntt: nttContracts(SRC) });
  const dstNtt = await dst.getProtocol("Ntt", { ntt: nttContracts(DST) });

  const decimals = await srcNtt.getTokenDecimals();
  const xfer = amount.units(amount.parse(rawAmount, decimals));

  console.log(`Transferring ${rawAmount} from ${SRC} -> ${DST} -> ${recipient}`);

  // 1. transfer (lock on Solana)
  const transferTxs = srcNtt.transfer(
    srcSigner.address.address,
    xfer,
    dstAddr,
    { queue: false, automatic: false, gasDropoff: 0n },
  );
  const txids = await signSendWait(src, transferTxs, srcSigner.signer);
  console.log("Solana txs:", txids.map((t) => t.txid));

  // 2. fetch attestation (VAA)
  const [whm] = await src.parseTransaction(txids[txids.length - 1]!.txid);
  console.log("Looking up VAA", whm);
  const vaa = await wh.getVaa(whm!, "Ntt:WormholeTransfer", 60_000);
  if (!vaa) throw new Error("VAA not available within timeout");

  // 3. redeem on Base
  const dstSigner = await getSigner(dst);
  const redeemTxs = dstNtt.redeem([vaa], dstSigner.address.address);
  const redeemTxids = await signSendWait(dst, redeemTxs, dstSigner.signer);
  console.log("Base txs:", redeemTxids.map((t) => t.txid));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
