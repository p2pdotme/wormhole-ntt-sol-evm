/**
 * Bridge ERC20 -> SPL (Base Sepolia -> Solana devnet).
 *
 * Flow:
 *   1. Base NttManager (burning) burns the ERC20 from sender.
 *   2. WormholeTransceiver emits a VAA to Solana.
 *   3. Solana NttManager (locking) releases SPL from custody to recipient.
 *
 * Usage:
 *   AMOUNT=1.5 RECIPIENT=<solanaPubkey> pnpm tsx base-to-solana.ts
 */

import {
  amount,
  signSendWait,
  toUniversal,
  type ChainAddress,
} from "@wormhole-foundation/sdk";
import { getSigner } from "./signers.js";
import { DST, SRC, getWh, nttContracts } from "./config.js";

async function main() {
  const rawAmount = process.env.AMOUNT ?? "1";
  const recipient = process.env.RECIPIENT;
  if (!recipient) throw new Error("set RECIPIENT=<solanaPubkey>");

  const wh = await getWh();
  const src = wh.getChain(DST); // start: Base
  const dst = wh.getChain(SRC); // end: Solana

  const srcSigner = await getSigner(src);
  const dstAddr: ChainAddress = {
    chain: SRC,
    address: toUniversal(SRC, recipient),
  };

  const srcNtt = await src.getProtocol("Ntt", { ntt: nttContracts(DST) });
  const dstNtt = await dst.getProtocol("Ntt", { ntt: nttContracts(SRC) });

  const decimals = await srcNtt.getTokenDecimals();
  const xfer = amount.units(amount.parse(rawAmount, decimals));

  console.log(`Transferring ${rawAmount} from ${DST} -> ${SRC} -> ${recipient}`);

  const transferTxs = srcNtt.transfer(
    srcSigner.address.address,
    xfer,
    dstAddr,
    { queue: false, automatic: false, gasDropoff: 0n },
  );
  const txids = await signSendWait(src, transferTxs, srcSigner.signer);
  console.log("Base txs:", txids.map((t) => t.txid));

  const [whm] = await src.parseTransaction(txids[txids.length - 1]!.txid);
  const vaa = await wh.getVaa(whm!, "Ntt:WormholeTransfer", 60_000);
  if (!vaa) throw new Error("VAA not available within timeout");

  const dstSigner = await getSigner(dst);
  const redeemTxs = dstNtt.redeem([vaa], dstSigner.address.address);
  const redeemTxids = await signSendWait(dst, redeemTxs, dstSigner.signer);
  console.log("Solana txs:", redeemTxids.map((t) => t.txid));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
