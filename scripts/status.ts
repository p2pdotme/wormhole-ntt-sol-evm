/** Print bridge wiring status (peers, rate limits, paused, decimals). */
import { DST, SRC, getWh, nttContracts } from "./config.js";

async function main() {
  const wh = await getWh();
  for (const chain of [SRC, DST] as const) {
    const ctx = wh.getChain(chain);
    const ntt = await ctx.getProtocol("Ntt", { ntt: nttContracts(chain) });

    const [decimals, paused, owner] = await Promise.all([
      ntt.getTokenDecimals(),
      ntt.isPaused(),
      ntt.getOwner(),
    ]);
    console.log(`\n[${chain}]`);
    console.log("  decimals:", decimals);
    console.log("  paused:  ", paused);
    console.log("  owner:   ", owner.toString());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
