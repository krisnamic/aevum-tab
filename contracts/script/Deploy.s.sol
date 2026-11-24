// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TabChannels} from "../src/TabChannels.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Deploys TabChannels.
///   - Aevum testnet and `make fork`: uses the real tUSD8.
///   - `make anvil` (chain 31337) only: deploys MockUSD8 first and mints 1,000 to the deployer.
///   - Anywhere else it stops, rather than deploy a token anyone can mint.
///
///   make deploy-local                         # anvil on 127.0.0.1:8545
///   make deploy-aevum ACCOUNT=deployer        # uses a keystore made with `cast wallet import`
contract Deploy is Script {
    address constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 constant ANVIL_CHAIN = 31337;

    function run() external returns (TabChannels tabs, address token) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        if (AEVUM_TUSD8.code.length > 0) {
            token = AEVUM_TUSD8;
        } else {
            require(block.chainid == ANVIL_CHAIN, "tUSD8 not found on this chain. Check the RPC (Aevum testnet is 44005).");
            MockUSD8 mock = new MockUSD8();
            mock.mint(deployer, 1_000e6);
            token = address(mock);
        }
        tabs = new TabChannels(IERC20(token));
        vm.stopBroadcast();

        console.log("chainId     ", block.chainid);
        console.log("token       ", token);
        console.log("TabChannels ", address(tabs));
        console.log("deploy block", block.number);
    }
}
