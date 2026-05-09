/**
 * Network selector + on-chain constants.
 *
 * Mirrors the pattern from sibling project sol-base-bridge/config/index.ts:
 * set NETWORK=devnet (Solana devnet + Base Sepolia) or NETWORK=mainnet (Solana
 * mainnet + Base mainnet, default). Every script reads through this file.
 *
 * Testnet target = Ethereum Sepolia (NOT Base Sepolia). Matches the sibling
 * project sol-base-bridge: their Solana-devnet <-> Sepolia path is the one
 * that's been validated end-to-end. Mainnet target stays Base.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { wormhole, type Chain, type Network } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import {
  nttExecutor,
  type Ntt,
} from "@wormhole-foundation/sdk-definitions-ntt";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-solana-ntt";

export type NetSel = "mainnet" | "devnet";

export function getNetwork(): NetSel {
  const n = (process.env.NETWORK ?? "mainnet").toLowerCase();
  if (n !== "mainnet" && n !== "devnet") {
    throw new Error(`Unknown NETWORK=${n} (expected mainnet|devnet)`);
  }
  return n;
}

export const SPL_DECIMALS = 6;
export const SPL_MINT_MAINNET = "P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta";

export const constants = {
  mainnet: {
    sdkNetwork: "Mainnet" as Network,
    src: "Solana" as Chain,
    dst: "Base" as Chain,
    splMint: SPL_MINT_MAINNET,
    wormholeChainId: { solana: 1, base: 30 },
    solana: {
      rpc: "https://api.mainnet-beta.solana.com",
      coreBridge: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
    },
    base: {
      chainId: 8453,
      rpc: "https://mainnet.base.org",
      coreBridge: "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6",
    },
  },
  devnet: {
    sdkNetwork: "Testnet" as Network,
    src: "Solana" as Chain,
    // Wormhole SDK chain name for Ethereum Sepolia is "Sepolia".
    dst: "Sepolia" as Chain,
    splMint: "hjZdvydbsd9QLt6txnsmTmQ2i1FyBLLbaUaj55fmMGG",
    // Field is named `base` for shape parity with mainnet; on devnet it is Sepolia.
    wormholeChainId: { solana: 1, base: 10002 }, // 10002 = Ethereum Sepolia
    solana: {
      rpc: "https://api.devnet.solana.com",
      coreBridge: "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",
    },
    base: {
      chainId: 11155111, // Ethereum Sepolia
      rpc: "https://ethereum-sepolia-rpc.publicnode.com",
      coreBridge: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78",
    },
  },
} as const;

export function getConfig() {
  return constants[getNetwork()];
}

export const cfg = getConfig();
export const SRC = cfg.src;
export const DST = cfg.dst;

/* -------------------------------------------------------------------- */
/*                NTT deployment.json (manager addresses)               */
/* -------------------------------------------------------------------- */

type DeploymentJson = {
  chains: Record<
    string,
    {
      manager: string;
      token: string;
      transceivers: { wormhole: { address: string } };
      version: string;
    }
  >;
};

const DEPLOYMENT_BASENAME =
  getNetwork() === "mainnet" ? "deployment.mainnet.json" : "deployment.json";

const DEPLOYMENT_PATH = resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "ntt",
  DEPLOYMENT_BASENAME,
);

export function loadDeployment(): DeploymentJson {
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as DeploymentJson;
}

export function nttContracts(chain: Chain): Ntt.Contracts {
  const d = loadDeployment().chains[chain];
  if (!d?.manager) {
    throw new Error(
      `${DEPLOYMENT_BASENAME}: missing manager for ${chain} (run \`ntt add-chain\` first)`,
    );
  }
  return {
    token: d.token,
    manager: d.manager,
    transceiver: { wormhole: d.transceivers.wormhole.address },
  };
}

export async function getWh() {
  return wormhole(cfg.sdkNetwork, [evm, solana]);
}

export { nttExecutor };
