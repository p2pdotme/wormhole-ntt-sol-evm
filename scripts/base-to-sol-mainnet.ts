/**
 * Base mainnet -> Solana mainnet (ERC20 P2PGov -> SPL P2P).
 *
 * Reads deployed addresses straight from ntt-mainnet/deployment.json.
 *
 * Usage:
 *   AMOUNT=1 RECIPIENT=<solana base58 pubkey> pnpm tsx scripts/base-to-sol-mainnet.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  amount,
  signSendWait,
  toUniversal,
  Wormhole,
  type Chain,
  type ChainAddress,
} from "@wormhole-foundation/sdk-connect";
import { EvmPlatform } from "@wormhole-foundation/sdk-evm";
import { SolanaPlatform } from "@wormhole-foundation/sdk-solana";
import "@wormhole-foundation/sdk-evm-core";
import "@wormhole-foundation/sdk-solana-core";
import { register as registerEvmNtt } from "@wormhole-foundation/sdk-evm-ntt";
import { register as registerSolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

registerEvmNtt();
registerSolanaNtt();

import { getSigner } from "./signers.js";

const DEPLOYMENT = JSON.parse(
  readFileSync(
    resolve(new URL(".", import.meta.url).pathname, "..", "ntt-mainnet", "deployment.json"),
    "utf8",
  ),
) as {
  chains: Record<
    string,
    { manager: string; token: string; transceivers: { wormhole: { address: string } } }
  >;
};

function ntt(chain: Chain) {
  const d = DEPLOYMENT.chains[chain];
  if (!d?.manager) throw new Error(`no manager for ${chain} in ntt-mainnet/deployment.json`);
  return {
    token: d.token,
    manager: d.manager,
    transceiver: { wormhole: d.transceivers.wormhole.address },
  };
}

async function main() {
  const rawAmount = process.env.AMOUNT ?? "1";
  const recipient = process.env.RECIPIENT;
  if (!recipient) throw new Error("set RECIPIENT=<solana base58 pubkey>");

  const wh = new Wormhole("Mainnet", [EvmPlatform, SolanaPlatform]);
  const src = wh.getChain("Base");
  const dst = wh.getChain("Solana");

  const srcSigner = await getSigner(src);
  const dstAddr: ChainAddress = { chain: "Solana", address: toUniversal("Solana", recipient) };

  const srcNtt = await src.getProtocol("Ntt", { ntt: ntt("Base") });
  const dstNtt = await dst.getProtocol("Ntt", { ntt: ntt("Solana") });

  const decimals = await srcNtt.getTokenDecimals();
  const units = amount.units(amount.parse(rawAmount, decimals));

  console.log(`[base->sol] sending ${rawAmount} P2PGov to ${recipient} (decimals=${decimals})`);

  const xferTxs = srcNtt.transfer(srcSigner.address.address, units, dstAddr, {
    queue: false,
    automatic: false,
  });
  const sentTxids = await signSendWait(src, xferTxs, srcSigner.signer);
  const lastTx = sentTxids[sentTxids.length - 1]!.txid;
  console.log("base txs:", sentTxids.map((t) => t.txid));

  const [whm] = await src.parseTransaction(lastTx);
  if (!whm) throw new Error("no Wormhole message in tx");
  console.log("waiting for VAA:", whm);

  const TIMEOUT_MS = 15 * 60 * 1000; // Base->Solana: ~15 finality blocks
  const vaa = await wh.getVaa(whm, "Ntt:WormholeTransfer", TIMEOUT_MS);
  if (!vaa) {
    console.error(
      `VAA not available within ${TIMEOUT_MS / 1000}s. ` +
        `Inspect: https://wormholescan.io/#/tx/${lastTx}?network=Mainnet`,
    );
    process.exit(2);
  }

  // With automatic: true, the Wormhole standard relayer may have already
  // redeemed by the time the VAA is signed. Skip the manual redeem if so.
  if (await dstNtt.getIsExecuted(vaa)) {
    console.log("solana: VAA already executed by relayer; nothing to do");
    return;
  }

  const dstSigner = await getSigner(dst);
  const redeemTxs = dstNtt.redeem([vaa], dstSigner.address.address);
  const redeemTxids = await signSendWait(dst, redeemTxs, dstSigner.signer);
  console.log("solana txs:", redeemTxids.map((t) => t.txid));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
