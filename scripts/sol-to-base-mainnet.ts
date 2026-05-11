/**
 * Solana mainnet -> Base mainnet (SPL P2P -> ERC20 P2PGov).
 *
 * Reads deployed addresses straight from ntt-mainnet/deployment.json.
 *
 * Usage:
 *   AMOUNT=1 RECIPIENT=0xYourBaseAddr pnpm tsx scripts/sol-to-base-mainnet.ts
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
  if (!recipient || !recipient.startsWith("0x")) {
    throw new Error("set RECIPIENT=0x... (Base EOA)");
  }

  const wh = new Wormhole("Mainnet", [EvmPlatform, SolanaPlatform]);
  const src = wh.getChain("Solana");
  const dst = wh.getChain("Base");

  const srcSigner = await getSigner(src);
  const dstAddr: ChainAddress = { chain: "Base", address: toUniversal("Base", recipient) };

  const srcNtt = await src.getProtocol("Ntt", { ntt: ntt("Solana") });
  const dstNtt = await dst.getProtocol("Ntt", { ntt: ntt("Base") });

  const decimals = await srcNtt.getTokenDecimals();
  const units = amount.units(amount.parse(rawAmount, decimals));

  console.log(`[sol->base] sending ${rawAmount} P2P to ${recipient} (decimals=${decimals})`);

  const xferTxs = srcNtt.transfer(srcSigner.address.address, units, dstAddr, {
    queue: false,
    automatic: false,
  });
  const sentTxids = await signSendWait(src, xferTxs, srcSigner.signer);
  const sigTx = sentTxids[sentTxids.length - 1]!.txid;
  console.log("solana txs:", sentTxids.map((t) => t.txid));

  const [whm] = await src.parseTransaction(sigTx);
  if (!whm) throw new Error("no Wormhole message in tx; aborting");
  console.log("waiting for VAA:", whm);

  const TIMEOUT_MS = 20 * 60 * 1000; // ~20 min for Solana finality + Guardian sign
  const vaa = await wh.getVaa(whm, "Ntt:WormholeTransfer", TIMEOUT_MS);
  if (!vaa) {
    console.error(
      `VAA not available within ${TIMEOUT_MS / 1000}s. Resume later with the redeem step. ` +
        `Inspect: https://wormholescan.io/#/tx/${sigTx}?network=Mainnet`,
    );
    process.exit(2);
  }

  // With automatic: true, the Wormhole standard relayer may have already
  // redeemed by the time the VAA is signed. Skip the manual redeem if so.
  if (await dstNtt.getIsExecuted(vaa)) {
    console.log("base: VAA already executed by relayer; nothing to do");
    return;
  }

  const dstSigner = await getSigner(dst);
  const redeemTxs = dstNtt.redeem([vaa], dstSigner.address.address);
  const redeemTxids = await signSendWait(dst, redeemTxs, dstSigner.signer);
  console.log("base txs:", redeemTxids.map((t) => t.txid));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
