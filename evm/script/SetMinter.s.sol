// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {P2PGov} from "../src/P2PGov.sol";

/// Run AFTER `ntt add-chain BaseSepolia ...` has deployed the NttManager.
/// Reads the manager address from env (set by you from `ntt status` output).
///
/// Signer is supplied by forge CLI flags — pick one of:
///   --mnemonics "$MNEMONIC_KEY" \
///   --mnemonic-passphrases "$WALLET_PASSPHRASE" \
///   --mnemonic-derivation-paths "m/44'/60'/0'/0/0"
/// or
///   --private-key $PRIVATE_KEY
/// or
///   --account <foundry-keystore-name>
contract SetMinter is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        address ntt = vm.envAddress("NTT_MANAGER_ADDRESS");

        vm.startBroadcast();
        P2PGov(token).setMinter(ntt);
        vm.stopBroadcast();

        console2.log("Minter on", token, "set to", ntt);
    }
}
