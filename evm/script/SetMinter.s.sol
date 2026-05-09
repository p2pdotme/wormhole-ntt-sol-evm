// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {GovernanceNttToken} from "../src/GovernanceNttToken.sol";

/// Run AFTER `ntt add-chain BaseSepolia ...` has deployed the NttManager.
/// Reads the manager address from env (set by you from `ntt status` output).
contract SetMinter is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envAddress("TOKEN_ADDRESS");
        address ntt = vm.envAddress("NTT_MANAGER_ADDRESS");

        vm.startBroadcast(pk);
        GovernanceNttToken(token).setMinter(ntt);
        vm.stopBroadcast();

        console2.log("Minter on", token, "set to", ntt);
    }
}
