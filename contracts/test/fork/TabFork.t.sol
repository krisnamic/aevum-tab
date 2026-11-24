// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TabChannels} from "../../src/TabChannels.sol";
import {Signing} from "../Signing.sol";
import {ITUSD8} from "./AevumFork.t.sol";

/// @notice Full tab lifecycle against the REAL tUSD8 on a local fork of Aevum. Run with: make test-fork
contract TabForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("merchant");

    function test_realTusd8_gaslessOpenSettleClose() public {
        assertEq(block.chainid, 44005, "run with make test-fork");
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        TabChannels tabs = new TabChannels(TUSD8);
        deal(address(TUSD8), owner, 10e6);

        uint64 closesAt = uint64(block.timestamp + 1 days);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 id = tabs.channelId(owner, merchant, agent, 5e6, closesAt, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            ownerKey,
            TUSD8.DOMAIN_SEPARATOR(),
            Signing.Auth(owner, address(tabs), 5e6, 0, validBefore, id)
        );
        vm.prank(makeAddr("relayer"));
        tabs.openWithAuthorization(owner, merchant, agent, 5e6, closesAt, bytes32(0), 0, validBefore, v, r, s);

        (v, r, s) = vm.sign(agentKey, tabs.voucherDigest(id, 1_234_567));
        vm.prank(merchant);
        tabs.close(id, 1_234_567, abi.encodePacked(r, s, v));

        assertEq(TUSD8.balanceOf(merchant), 1_234_567);
        assertEq(TUSD8.balanceOf(owner), 10e6 - 1_234_567);
        assertEq(TUSD8.balanceOf(address(tabs)), 0);
    }
}
