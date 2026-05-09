// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {GovernanceNttToken} from "../src/GovernanceNttToken.sol";

/// Deploys ONLY the ERC20. The NttManager + WormholeTransceiver are deployed
/// separately by `ntt add-chain BaseSepolia --token <thisAddress> --mode burning`.
/// After NTT deployment, run `setMinter(nttManager)` (see SetMinter.s.sol).
contract DeployToken is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory name = vm.envString("TOKEN_NAME");
        string memory symbol = vm.envString("TOKEN_SYMBOL");
        // MUST match the SPL mint decimals on Solana.
        uint8 decimals = uint8(vm.envUint("TOKEN_DECIMALS"));
        address owner = vm.envAddress("TOKEN_OWNER");

        vm.startBroadcast(pk);
        GovernanceNttToken token = new GovernanceNttToken(name, symbol, decimals, owner);
        vm.stopBroadcast();

        console2.log("GovernanceNttToken deployed at:", address(token));
        console2.log("Owner:", owner);
        console2.log("Decimals:", decimals);
        console2.log("");
        console2.log("Next: run `ntt add-chain Sepolia --token", address(token));
        console2.log("       --mode burning --skip-verify` from the ntt project root.");
        console2.log("(Mainnet: use chain `Base` instead of `Sepolia`.)");
    }
}
