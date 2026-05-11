# Solana ↔ EVM NTT Bridge — How It Works & UI Integration

This doc covers the bridge that was deployed in this repo (`P2PXup1Z…` SPL on Solana ↔ governance ERC20 on Sepolia / future Base) and how a frontend application consumes it. It is split into three parts:

1. Protocol architecture — what the on-chain pieces are and how a transfer flows
2. Operational state — the actual deployment in `ntt-workspace/deployment.json`
3. UI integration — the SDK calls a dApp uses to send, track, and redeem

---

## 1. Protocol architecture

Wormhole NTT (Native Token Transfers) is a "burn/mint or lock/release" token bridge built on the Wormhole guardian network. It has three on-chain roles per chain:

| Role | Responsibility | Solana | EVM |
|---|---|---|---|
| **Token** | The asset being moved | SPL mint | ERC20 contract implementing `INttToken` |
| **Manager** | Authorizes transfers, enforces rate limits, holds custody (locking) or has mint/burn rights (burning) | Anchor program (PDA-driven) | `NttManager` (UUPS upgradeable) |
| **Transceiver** | Encodes/sends and verifies/receives the cross-chain attestation | Wormhole transceiver program | `WormholeTransceiver` |

There is one independent **mode** per chain:

- `locking` — outbound transfers move tokens into custody (escrow PDA on Solana / `NttManager` balance on EVM). Inbound transfers release from custody. **Total supply is preserved on this chain.** Used for the "hub" chain that owns the canonical mint authority.
- `burning` — outbound transfers burn from the sender; inbound transfers mint to the recipient. **Total supply equals total inbound − total outbound.** Used for spoke chains.

In this deployment Solana = `locking` (SPL mint authority is unchanged; tokens get parked in a manager-owned token account) and Sepolia / Base = `burning` (the ERC20 grants `mint`/`burn` rights only to the manager via `INttToken`).

### 1.1 Send path (chain A → chain B)

```
user                manager (A)              transceiver (A)         guardians          transceiver (B)        manager (B)            user
 │  approve+transfer   │                            │                     │                     │                       │                  │
 ├────────────────────▶│                            │                     │                     │                       │                  │
 │                     │ rate-limit check           │                     │                     │                       │                  │
 │                     │ lock-or-burn               │                     │                     │                       │                  │
 │                     │ build NttManagerMessage    │                     │                     │                       │                  │
 │                     ├───────────────────────────▶│                     │                     │                       │                  │
 │                     │                            │ wrap as Transceiver │                     │                       │                  │
 │                     │                            │ Message, emit Wormhole core publishMessage│                       │                  │
 │                     │                            ├────────────────────▶│                     │                       │                  │
 │                     │                            │                     │ 13/19 guardians sign│                       │                  │
 │                     │                            │                     │ → VAA               │                       │                  │
 │                     │                            │                     ├════════════════════▶│                       │                  │
 │                     │                            │                     │                     │ verify peer + VAA sig │                  │
 │                     │                            │                     │                     ├──────────────────────▶│                  │
 │                     │                            │                     │                     │                       │ threshold check  │
 │                     │                            │                     │                     │                       │ rate-limit check │
 │                     │                            │                     │                     │                       │ release-or-mint  │
 │                     │                            │                     │                     │                       ├─────────────────▶│
```

Key invariants:

- The **VAA digest** (keccak256 of the body) is the unique identifier for one cross-chain message. It is what the manager replay-protects against on the receiving side.
- A `TransceiverMessage` wraps an `NttManagerMessage` which wraps a `NativeTokenTransfer` payload (recipient, amount in trimmed-decimals form, source/dest chain ids).
- **Trimmed amounts**: NTT normalizes amounts to `min(srcDecimals, dstDecimals, 8)` decimals over the wire, so a 6-decimal SPL and an 18-decimal ERC20 can interoperate. The receiver re-scales locally. Dust below the trimmed precision is rejected at send time (`TransferAmountHasDust`).
- **Rate limits** are per-direction, per-peer-chain. Inbound limit is enforced on the receiving manager; outbound on the sending manager. If exceeded, the transfer can be queued (auto-released after a 24h window) — controlled by the `queue` flag on the user-facing call.

### 1.2 Threshold & multiple transceivers

The manager has a `threshold` (currently `1`) and a set of registered transceivers. A redeem needs `threshold` independent attestations of the same digest before it executes. Today only the Wormhole transceiver is wired in. Adding a second transceiver (e.g. Axelar, native Solana<->EVM provers) and bumping the threshold gives extra defense-in-depth without changing the user flow.

### 1.3 Solana-specific layout

PDAs the receive instruction expects:
- `[b"config"]` — manager config (mode, paused flag, chain id, owner)
- `[b"peer", chain_id_be]` — manager peer for a given Wormhole chain id (target manager address + decimals + inbound limit)
- `[b"transceiver_peer", chain_id_be]` — transceiver peer (counterpart transceiver address)
- `[b"vaa_consumed", digest]` — replay-protection record after redeem
- `[b"inbox_item", digest]` / `[b"inbox_rate_limit", chain_id_be]` — inbound queueing/limits
- For `locking`: a single SPL token account owned by `[b"token_authority"]` is the custody vault.
- For `burning`: the manager is set as the SPL mint authority (or as a delegated minter on Token-2022).

Critical Testnet quirk captured in memory: VAAs published by the Sepolia core bridge encode `emitterChain=2` (legacy Goerli alias) even though the chain id reported by the bridge contract is `10002`. Solana's `receive_message` instruction derives the peer PDA from `vaa.emitter_chain()`, so the Solana side of a Sepolia bridge needs peers registered under **both** `Sepolia` (10002) and `Ethereum` (2) for inbound redeem to work. This is testnet-only.

### 1.4 EVM-specific layout

`NttManager` (UUPS proxy) holds:
- `_peers[chainId] → (managerAddress, decimals)`
- `_outboundLimitParams`, `_inboundLimitParams[chainId]`
- `_messageAttestations[digest][transceiver]` bitmap

`INttToken` is the integration surface the ERC20 must implement — `mint(address,uint256)`, `burn(uint256)`, `setMinter(address)`. The token in this repo (`P2PGov`) layers ERC20Votes + ERC20Permit on top, with the manager as the configured `minter`.

`WormholeTransceiver` handles `sendMessage`/`receiveMessage` against the Wormhole core bridge and (optionally) integrates with the standard relayer or special relayer for paid execution.

---

## 2. Operational state (this deployment)

From `ntt-workspace/deployment.json` (Testnet rehearsal):

```
Solana  v3.0.0  locking
  manager      Ge7YR7CiNGeNsPcrPokcCM8M52K6nGsb7NNSwFEHMMT3
  token        hjZdvydbsd9QLt6txnsmTmQ2i1FyBLLbaUaj55fmMGG
  transceiver  CmjvQBgTzxw2sJpoAphzi4TJxcqWaBM7M8aCCUwRp9p8
  outbound     100.0 / inbound from Sepolia 100.0

Sepolia v2.0.0  burning
  manager      0x0DCC35535A516C87C402aD68ED06A11CEc46f87C
  token        0xBfd5125BED3f92e8a1Ea7f6c126F26094ad023c8
  transceiver  0xBebcc4e139D8cE74B52521Ad1010c095C12E69aD
  outbound     unlimited / inbound from Solana 100.0
```

`overrides.json` pins the Sepolia RPC to Alchemy (the public endpoint timed out during deployment) and Solana to devnet.

Both directions have been exercised end-to-end:
- Solana → Sepolia: 1.0 token locked on Solana, 1.0 minted on Sepolia
- Sepolia → Solana: 0.5 burned on Sepolia, 0.5 released from Solana custody (final custody balance 999999.5)

---

## 3. UI integration

A dApp talks to NTT through `@wormhole-foundation/sdk` and the three NTT packages (`sdk-definitions-ntt`, `sdk-evm-ntt`, `sdk-solana-ntt`). There are two integration tiers — pick one based on UX needs:

- **Low-level Ntt protocol API** — manual, deterministic, gives you `transfer / getVaa / redeem` primitives. Best for a custom bridge UI where you want to render every step.
- **Routes API** (`nttManualRoute`, `nttAutomaticRoute`) — bundle quote + initiate + complete behind a uniform `Route` interface. Best when you're slotting NTT into a generic "find me a bridge" widget alongside CCTP, token bridge, etc.

Both are demonstrated in `sdk/examples/src/index.ts` (low-level) and `sdk/examples/src/route.ts` (routes).

### 3.1 Bootstrapping the SDK

```ts
import { Wormhole } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";

import { register as registerDefinitionsNtt } from "@wormhole-foundation/sdk-definitions-ntt";
import { register as registerEvmNtt }          from "@wormhole-foundation/sdk-evm-ntt";
import { register as registerSolanaNtt }       from "@wormhole-foundation/sdk-solana-ntt";

registerDefinitionsNtt();
registerEvmNtt();
registerSolanaNtt();

const wh = new Wormhole("Testnet", [solana.Platform, evm.Platform], {
  chains: {
    Sepolia: { rpc: import.meta.env.VITE_SEPOLIA_RPC },
    Solana:  { rpc: import.meta.env.VITE_SOLANA_RPC  },
  },
});
```

The contract addresses from `deployment.json` are passed in per-call:

```ts
const NTT_CONTRACTS = {
  Solana: {
    token:       "hjZdvydbsd9QLt6txnsmTmQ2i1FyBLLbaUaj55fmMGG",
    manager:     "Ge7YR7CiNGeNsPcrPokcCM8M52K6nGsb7NNSwFEHMMT3",
    transceiver: { wormhole: "CmjvQBgTzxw2sJpoAphzi4TJxcqWaBM7M8aCCUwRp9p8" },
  },
  Sepolia: {
    token:       "0xBfd5125BED3f92e8a1Ea7f6c126F26094ad023c8",
    manager:     "0x0DCC35535A516C87C402aD68ED06A11CEc46f87C",
    transceiver: { wormhole: "0xBebcc4e139D8cE74B52521Ad1010c095C12E69aD" },
  },
};
```

For mainnet just swap the `Wormhole` network arg to `"Mainnet"` and the addresses to the production set.

### 3.2 Low-level transfer (Sepolia → Solana shown)

```ts
import { amount, signSendWait } from "@wormhole-foundation/sdk";

const src = wh.getChain("Sepolia");
const dst = wh.getChain("Solana");

const srcNtt = await src.getProtocol("Ntt", { ntt: NTT_CONTRACTS.Sepolia });
const dstNtt = await dst.getProtocol("Ntt", { ntt: NTT_CONTRACTS.Solana  });

const decimals = await srcNtt.getTokenDecimals();
const amt = amount.units(amount.parse("0.5", decimals));

// 1. The user signs an EVM tx that triggers approve (if needed) + manager.transfer
const txs = srcNtt.transfer(
  evmSigner.address.address,        // sender
  amt,                              // amount (bigint, raw units)
  solanaRecipient.address,          // UniversalAddress on dest chain
  { queue: false, automatic: false, gasDropoff: 0n }
);
const sourceTxIds = await signSendWait(src, txs, evmSigner.signer);

// 2. Poll Wormhole for the signed VAA (~1 min testnet, longer mainnet)
const vaa = await wh.getVaa(
  sourceTxIds.at(-1)!.txid,
  "Ntt:WormholeTransfer",
  25 * 60 * 1000                    // timeout
);

// 3. Submit the VAA on the destination — user signs a Solana tx
const dstTxs = dstNtt.redeem([vaa!], solanaSigner.address.address);
await signSendWait(dst, dstTxs, solanaSigner.signer);
```

What the UI typically renders around this:

| Stage | UX | What's happening |
|---|---|---|
| Idle | amount input + chain pickers | quote `getCurrentOutboundCapacity()` to show available capacity |
| Approving | spinner | ERC20 `approve` (only if allowance < amount; manager's `INttToken.burn` typically uses transferFrom) |
| Sending | spinner + tx hash link | `manager.transfer(amount, recipientChain, recipient, refund, queue, instructions)` on EVM; equivalent ix on Solana |
| Awaiting VAA | progress bar with countdown | `wh.getVaa(...)` polls `https://api.wormholescan.io/api/v1/vaas?txHash=...`; expose Wormholescan link |
| Awaiting executor (auto mode) | "relayer working…" | the executor service watches for paid VAAs and submits them; if it fails the UI must offer a manual redeem button |
| Redeem | "redeem on Solana" button | calls `dstNtt.redeem([vaa], recipient)`; user signs |
| Done | confirmation | poll dest balance to confirm credit |

Wormholescan endpoints the UI can hit directly without the SDK:
- VAA status: `GET https://api.testnet.wormholescan.io/api/v1/vaas?txHash=<hash>` (returns multiple VAAs on testnet — pick the one matching your transceiver emitter)
- Operations / executor status: `GET https://api.testnet.wormholescan.io/api/v1/operations?txHash=<hash>`

### 3.3 Routes API (recommended for multi-protocol widgets)

```ts
import { routes, Wormhole } from "@wormhole-foundation/sdk";
import { nttManualRoute, nttAutomaticRoute } from "@wormhole-foundation/sdk-route-ntt";

const resolver = wh.resolver([
  nttManualRoute({ tokens: NttTokens }),     // user pays gas on dest, manually redeems
  nttAutomaticRoute({ tokens: NttTokens }),  // executor relays + redeems for a fee
]);

const sendToken = Wormhole.tokenId("Sepolia", NTT_CONTRACTS.Sepolia.token);
const destTokens = await resolver.supportedDestinationTokens(sendToken, src, dst);

const tr = await routes.RouteTransferRequest.create(wh, {
  source: sendToken,
  destination: destTokens[0]!,
});

const found = await resolver.findRoutes(tr);
const route = found[0]!;                                   // sorted by output amount
const validated = await route.validate(tr, { amount: "0.5", options: route.getDefaultOptions() });
if (!validated.valid) throw validated.error;

const quote = await route.quote(tr, validated.params);     // shows fees, ETA, dust
if (!quote.success) throw quote.error;

const receipt = await route.initiate(tr, srcSigner.signer, quote, dstSigner.address);
await routes.checkAndCompleteTransfer(route, receipt, dstSigner.signer);  // polls + completes
```

`checkAndCompleteTransfer` is a small state machine — it walks the receipt through `SourceInitiated → SourceFinalized → Attested → DestinationInitiated → DestinationFinalized` and signs the redeem when needed. A UI typically replaces this with its own loop so it can render each transition.

The receipt object is the canonical thing to persist (e.g. in `localStorage` or a backend) so a user who closes the tab can resume mid-flight. `recoverTxids` in `sdk/examples/src/index.ts` shows the recovery shape — given the source tx hash, the SDK can re-derive the VAA and finish the redeem.

### 3.4 Tracking / receipt model

`sdk/route/src/tracking.ts` and `types.ts` define the receipt states. For NTT:

- `SourceInitiated` — source tx submitted but not finalized
- `SourceFinalized` — finality reached (12 blocks Sepolia, 32 slots Solana)
- `Attested` — VAA available from guardians
- (auto only) `DestinationInitiated` — executor submitted dest tx
- `DestinationFinalized` — dest tx finalized; balance credited

The UI watches `receipt.state` and renders accordingly. Errors bubble as `ChainAddress`-typed exceptions; rate-limit-queued transfers surface as a separate `Queued` state with a `release time` so the UI can show "available in 23h 14m".

### 3.5 Signers in the browser

EVM signer: typically `Wormhole.chain.getSigner(walletClient)` wrapping a wagmi/viem `WalletClient`, or a custom adapter that implements:

```ts
interface SignAndSendSigner {
  chain(): Chain;
  address(): string;
  signAndSend(txs: UnsignedTransaction[]): Promise<TxHash[]>;
}
```

Solana signer: same shape, wrapping `@solana/wallet-adapter`'s `WalletAdapter`. The Solana redeem tx is composed of multiple instructions (verify VAA, post VAA, receive_message, redeem, release_inbound_unlock|mint) and the SDK splits them into multiple transactions when they exceed the 1232-byte limit — `signAndSend` must handle a list.

### 3.6 Common UI affordances

- **Quote refresh** — call `route.quote()` on a 30s timer; the executor fee can move with gas.
- **Insufficient capacity** — `getCurrentOutboundCapacity()` / `getCurrentInboundCapacity(peer)` return raw units. If amount > capacity, either disable submit or surface the "queue" option.
- **Resume in-flight transfers** — persist `{ srcTxId, srcChain, dstChain, amount, recipient }` per user; on app load, re-derive a receipt and call `checkAndCompleteTransfer`.
- **Manual redeem fallback** — when `automatic: true` was used but the executor never relayed (rare but happens during guardian incidents), expose a "Redeem manually" button that invokes the manual path with the same VAA.
- **Wormholescan link** — once you have the source tx hash, `https://wormholescan.io/#/tx/<hash>?network=Mainnet` (or `Testnet`) gives the user a third-party progress page they trust.

### 3.7 Testnet vs mainnet

The only configuration deltas a UI needs:

| | Testnet | Mainnet |
|---|---|---|
| `Wormhole` network arg | `"Testnet"` | `"Mainnet"` |
| Solana cluster | `https://api.devnet.solana.com` | `https://api.mainnet-beta.solana.com` (or paid RPC) |
| EVM chain | `Sepolia` | `Base` |
| Wormholescan API | `api.testnet.wormholescan.io` | `api.wormholescan.io` |
| Contract addresses | from `ntt-workspace/deployment.json` | from the eventual mainnet deployment |

Plus the Sepolia chainId quirk does NOT exist on mainnet — Ethereum is `2` everywhere and there is no aliased `10002`-vs-`2` divergence.

---

## File pointers

- Protocol source: `ntt-workspace/evm/src/NttManager/`, `ntt-workspace/solana/programs/example-native-token-transfers/`
- EVM token interface: `ntt-workspace/evm/src/interfaces/INttToken.sol`, `INttManager.sol`
- Solana receive logic: `ntt-workspace/.deployments/Solana-3.0.0/solana/programs/example-native-token-transfers/src/transceivers/wormhole/instructions/receive_message.rs`
- SDK low-level example: `ntt-workspace/sdk/examples/src/index.ts`
- SDK route example: `ntt-workspace/sdk/examples/src/route.ts`
- Route impl: `ntt-workspace/sdk/route/src/{manual,automatic,tracking,types}.ts`
- Custom token: `evm/src/P2PGov.sol` (ERC20 + Votes + Permit + Burnable + Ownable2Step + INttToken)
- Deployment manifest: `ntt-workspace/deployment.json`
