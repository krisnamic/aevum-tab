// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TabChannels} from "../src/TabChannels.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract TabChannelsTest is Test {
    MockUSD8 token;
    TabChannels tabs;

    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address merchant = makeAddr("merchant");
    address relayer = makeAddr("relayer");

    uint128 constant DEPOSIT = 5e6;
    bytes32 constant SALT = keccak256("tab-1");
    uint64 closesAt;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        token = new MockUSD8();
        tabs = new TabChannels(IERC20(address(token)));
        token.mint(owner, 100e6);
        closesAt = uint64(block.timestamp + 1 days);
    }

    function _open() internal returns (bytes32 id) {
        vm.startPrank(owner);
        token.approve(address(tabs), DEPOSIT);
        id = tabs.open(merchant, agent, DEPOSIT, closesAt, SALT);
        vm.stopPrank();
    }

    function _voucher(uint256 key, bytes32 id, uint256 cumulative) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, tabs.voucherDigest(id, cumulative));
        return abi.encodePacked(r, s, v);
    }

    // ---------- open ----------

    function test_open_locksDeposit() public {
        bytes32 id = _open();
        assertEq(token.balanceOf(address(tabs)), DEPOSIT);
        TabChannels.Channel memory c = tabs.channelOf(id);
        assertEq(c.payer, owner);
        assertEq(c.payee, merchant);
        assertEq(c.signer, agent);
        assertEq(c.deposit, DEPOSIT);
        assertEq(c.closesAt, closesAt);
    }

    function test_open_rejectsBadParams() public {
        vm.startPrank(owner);
        vm.expectRevert(TabChannels.ZeroAmount.selector);
        tabs.open(merchant, agent, 0, closesAt, SALT);
        vm.expectRevert(TabChannels.BadExpiry.selector);
        tabs.open(merchant, agent, DEPOSIT, uint64(block.timestamp), SALT);
        vm.expectRevert(TabChannels.ZeroAddress.selector);
        tabs.open(address(0), agent, DEPOSIT, closesAt, SALT);
        vm.stopPrank();
    }

    function test_open_idNeverReusedAfterClose() public {
        bytes32 id = _open();
        vm.prank(merchant);
        tabs.close(id, 0, "");
        vm.startPrank(owner);
        token.approve(address(tabs), DEPOSIT);
        vm.expectRevert(TabChannels.ChannelExists.selector);
        tabs.open(merchant, agent, DEPOSIT, closesAt, SALT);
        vm.stopPrank();
    }

    function _authSig(uint128 deposit, bytes32 nonce) internal view returns (uint8, bytes32, bytes32) {
        return Signing.signReceive(
            vm,
            ownerKey,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: owner,
                to: address(tabs),
                value: deposit,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: nonce
            })
        );
    }

    function test_openWithAuthorization_gaslessForOwner() public {
        bytes32 id = tabs.channelId(owner, merchant, agent, DEPOSIT, closesAt, SALT);
        (uint8 v, bytes32 r, bytes32 s) = _authSig(DEPOSIT, id);
        vm.prank(relayer);
        tabs.openWithAuthorization(
            owner, merchant, agent, DEPOSIT, closesAt, SALT, 0, block.timestamp + 1 hours, v, r, s
        );
        assertEq(token.balanceOf(address(tabs)), DEPOSIT);
        assertEq(tabs.channelOf(id).payer, owner);
    }

    function test_openWithAuthorization_relayerCannotSwapMerchantOrKey() public {
        bytes32 id = tabs.channelId(owner, merchant, agent, DEPOSIT, closesAt, SALT);
        (uint8 v, bytes32 r, bytes32 s) = _authSig(DEPOSIT, id);
        uint256 vb = block.timestamp + 1 hours;
        vm.startPrank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        tabs.openWithAuthorization(owner, relayer, agent, DEPOSIT, closesAt, SALT, 0, vb, v, r, s);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        tabs.openWithAuthorization(owner, merchant, relayer, DEPOSIT, closesAt, SALT, 0, vb, v, r, s);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        tabs.openWithAuthorization(owner, merchant, agent, DEPOSIT, closesAt + 1, SALT, 0, vb, v, r, s);
        tabs.openWithAuthorization(owner, merchant, agent, DEPOSIT, closesAt, SALT, 0, vb, v, r, s);
        vm.expectRevert(TabChannels.ChannelExists.selector);
        tabs.openWithAuthorization(owner, merchant, agent, DEPOSIT, closesAt, SALT, 0, vb, v, r, s);
        vm.stopPrank();
    }

    // ---------- settle ----------

    function test_settle_paysOnlyTheDifference() public {
        bytes32 id = _open();
        vm.startPrank(relayer);
        tabs.settle(id, 1e6, _voucher(agentKey, id, 1e6));
        tabs.settle(id, 3e6, _voucher(agentKey, id, 3e6));
        vm.stopPrank();
        assertEq(token.balanceOf(merchant), 3e6);
        assertEq(tabs.channelOf(id).claimed, 3e6);
    }

    function test_settle_rejectsStaleVoucher() public {
        bytes32 id = _open();
        bytes memory old = _voucher(agentKey, id, 1e6);
        tabs.settle(id, 2e6, _voucher(agentKey, id, 2e6));
        vm.expectRevert(TabChannels.BadVoucher.selector);
        tabs.settle(id, 1e6, old);
    }

    function test_settle_capsAtDeposit() public {
        bytes32 id = _open();
        tabs.settle(id, DEPOSIT + 1, _voucher(agentKey, id, DEPOSIT + 1));
        assertEq(token.balanceOf(merchant), DEPOSIT);
        bytes memory more = _voucher(agentKey, id, DEPOSIT + 2);
        vm.expectRevert(TabChannels.BadVoucher.selector);
        tabs.settle(id, DEPOSIT + 2, more);
    }

    function test_settle_rejectsWrongSigner() public {
        bytes32 id = _open();
        bytes memory sig = _voucher(ownerKey, id, 1e6);
        vm.expectRevert(TabChannels.InvalidSignature.selector);
        tabs.settle(id, 1e6, sig);
    }

    function test_settle_voucherBoundToItsChannel() public {
        bytes32 id = _open();
        vm.startPrank(owner);
        token.approve(address(tabs), DEPOSIT);
        bytes32 other = tabs.open(merchant, agent, DEPOSIT, closesAt, keccak256("tab-2"));
        vm.stopPrank();
        bytes memory sig = _voucher(agentKey, id, 1e6);
        vm.expectRevert(TabChannels.InvalidSignature.selector);
        tabs.settle(other, 1e6, sig);
    }

    function test_settle_rejectsAfterExpiry() public {
        bytes32 id = _open();
        bytes memory sig = _voucher(agentKey, id, 1e6);
        vm.warp(closesAt);
        vm.expectRevert(TabChannels.ChannelExpired.selector);
        tabs.settle(id, 1e6, sig);
    }

    // ---------- close / revoke / reclaim ----------

    function test_close_settlesAndRefunds() public {
        bytes32 id = _open();
        uint256 before = token.balanceOf(owner);
        bytes memory sig = _voucher(agentKey, id, 2e6);
        vm.prank(merchant);
        tabs.close(id, 2e6, sig);
        assertEq(token.balanceOf(merchant), 2e6);
        assertEq(token.balanceOf(owner), before + 3e6);
        assertEq(token.balanceOf(address(tabs)), 0);
        assertEq(tabs.channelOf(id).closesAt, 0);
    }

    function test_close_onlyPayee() public {
        bytes32 id = _open();
        vm.prank(owner);
        vm.expectRevert(TabChannels.NotPayee.selector);
        tabs.close(id, 0, "");
    }

    function test_close_twiceReverts() public {
        bytes32 id = _open();
        vm.startPrank(merchant);
        tabs.close(id, 0, "");
        vm.expectRevert(TabChannels.NotOpen.selector);
        tabs.close(id, 0, "");
        vm.stopPrank();
    }

    function test_revoke_givesMerchantGraceThenRefunds() public {
        bytes32 id = _open();
        bytes memory sig = _voucher(agentKey, id, 1e6);
        vm.prank(owner);
        tabs.revoke(id);
        assertEq(tabs.channelOf(id).closesAt, block.timestamp + tabs.REVOKE_GRACE());

        tabs.settle(id, 1e6, sig);

        vm.expectRevert(TabChannels.ChannelStillOpen.selector);
        tabs.reclaim(id);

        uint256 before = token.balanceOf(owner);
        vm.warp(block.timestamp + tabs.REVOKE_GRACE());
        bytes memory late = _voucher(agentKey, id, 2e6);
        vm.expectRevert(TabChannels.ChannelExpired.selector);
        tabs.settle(id, 2e6, late);

        tabs.reclaim(id);
        assertEq(token.balanceOf(owner), before + 4e6);
        assertEq(token.balanceOf(merchant), 1e6);
    }

    function test_revoke_onlyPayer() public {
        bytes32 id = _open();
        vm.prank(agent);
        vm.expectRevert(TabChannels.NotPayer.selector);
        tabs.revoke(id);
    }

    function test_reclaim_onceOnly() public {
        bytes32 id = _open();
        vm.warp(closesAt);
        tabs.reclaim(id);
        vm.expectRevert(TabChannels.NotOpen.selector);
        tabs.reclaim(id);
        assertEq(token.balanceOf(address(tabs)), 0);
    }

    function test_close_afterSomeoneElseSettledSameVoucher() public {
        bytes32 id = _open();
        bytes memory sig = _voucher(agentKey, id, 2e6);
        tabs.settle(id, 2e6, sig);
        vm.prank(merchant);
        tabs.close(id, 2e6, sig);
        assertEq(token.balanceOf(merchant), 2e6);
        assertEq(token.balanceOf(address(tabs)), 0);
    }

    function test_close_afterExpiryRefundsInsteadOfReverting() public {
        bytes32 id = _open();
        bytes memory sig = _voucher(agentKey, id, 2e6);
        vm.warp(closesAt);
        vm.prank(merchant);
        tabs.close(id, 2e6, sig);
        assertEq(token.balanceOf(merchant), 0);
        assertEq(token.balanceOf(owner), 100e6);
    }

    function test_revoke_neverExtends() public {
        bytes32 id = _open();
        vm.startPrank(owner);
        tabs.revoke(id);
        uint64 first = tabs.channelOf(id).closesAt;
        vm.warp(block.timestamp + 5 minutes);
        tabs.revoke(id);
        vm.stopPrank();
        assertEq(tabs.channelOf(id).closesAt, first);
    }

    function test_unknownChannelReverts() public {
        bytes32 id = keccak256("nope");
        vm.expectRevert(TabChannels.NotOpen.selector);
        tabs.settle(id, 1, "");
        vm.expectRevert(TabChannels.NotOpen.selector);
        tabs.reclaim(id);
        vm.expectRevert(TabChannels.NotPayer.selector);
        tabs.revoke(id);
    }

    /// The contract can never pay out more than it holds across settle/close/reclaim.
    function testFuzz_neverPaysMoreThanDeposit(uint128 a, uint128 b) public {
        a = uint128(bound(a, 1, DEPOSIT));
        b = uint128(bound(b, a, DEPOSIT));
        bytes32 id = _open();
        tabs.settle(id, a, _voucher(agentKey, id, a));
        if (b > a) tabs.settle(id, b, _voucher(agentKey, id, b));
        vm.warp(closesAt);
        tabs.reclaim(id);
        assertEq(token.balanceOf(merchant) + token.balanceOf(owner), 100e6);
        assertEq(token.balanceOf(merchant), b);
        assertEq(token.balanceOf(address(tabs)), 0);
    }
}
