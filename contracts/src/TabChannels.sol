// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC3009} from "./IERC3009.sol";

/// @title TabChannels
/// @notice One-way payment channels ("tabs") between an AI agent's owner and a merchant.
///         The owner locks a deposit; the agent's session key signs off-chain vouchers for the
///         running total it owes; the merchant redeems the latest voucher on-chain whenever it likes.
///         Thousands of paid calls cost two transactions: open and close. Merchants must check
///         `closesAt` before serving and settle promptly after a `Revoked` event.
/// @dev The deposit is the hard spend cap, `closesAt` is the session expiry and `revoke` is the kill switch.
///      The session key can only sign vouchers for its own channel, to its own merchant, up to the deposit.
contract TabChannels is EIP712 {
    using SafeERC20 for IERC20;

    struct Channel {
        address payer;
        uint64 closesAt; // 0 once closed
        address payee;
        address signer;
        uint128 deposit;
        uint128 claimed;
    }

    /// @notice How long the merchant has to redeem its latest voucher after the owner revokes.
    uint64 public constant REVOKE_GRACE = 15 minutes;

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint256 cumulative)");

    IERC20 public immutable token;

    mapping(bytes32 id => Channel) private _channels;

    event Opened(
        bytes32 indexed id,
        address indexed payer,
        address indexed payee,
        address signer,
        uint256 deposit,
        uint64 closesAt
    );
    event Settled(bytes32 indexed id, uint256 cumulative, uint256 paid);
    event Revoked(bytes32 indexed id, uint64 closesAt);
    event Closed(bytes32 indexed id, uint256 refunded);

    error ZeroAddress();
    error ZeroAmount();
    error BadExpiry();
    error ChannelExists();
    error NotOpen();
    error ChannelExpired();
    error ChannelStillOpen();
    error NotPayer();
    error NotPayee();
    error BadVoucher();
    error InvalidSignature();

    constructor(IERC20 token_) EIP712("Tab", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Channel id for these parameters. Also the EIP-3009 nonce for `openWithAuthorization`,
    ///         so a relayer can't change the merchant, session key, amount or expiry the owner signed.
    function channelId(
        address payer,
        address payee,
        address signer,
        uint256 deposit,
        uint64 closesAt,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), payer, payee, signer, deposit, closesAt, salt));
    }

    /// @notice Open a tab with tokens you approved to this contract.
    function open(address payee, address signer, uint128 deposit, uint64 closesAt, bytes32 salt)
        external
        returns (bytes32 id)
    {
        id = _open(msg.sender, payee, signer, deposit, closesAt, salt);
        token.safeTransferFrom(msg.sender, address(this), deposit);
    }

    /// @notice Open a tab gaslessly with an EIP-3009 `ReceiveWithAuthorization` signed by `payer`,
    ///         `to` = this contract and `nonce` = the channel id.
    function openWithAuthorization(
        address payer,
        address payee,
        address signer,
        uint128 deposit,
        uint64 closesAt,
        bytes32 salt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 id) {
        id = _open(payer, payee, signer, deposit, closesAt, salt);
        IERC3009(address(token)).receiveWithAuthorization(
            payer, address(this), deposit, validAfter, validBefore, id, v, r, s
        );
    }

    /// @notice Pay the merchant up to `cumulative` (the running total the session key signed).
    ///         Anyone may submit; the money only ever goes to the channel's payee.
    function settle(bytes32 id, uint256 cumulative, bytes calldata signature) public {
        Channel storage c = _channels[id];
        if (c.closesAt == 0) revert NotOpen();
        if (block.timestamp >= c.closesAt) revert ChannelExpired();
        // A voucher above the deposit still pays out the deposit, so an overspending agent can't
        // leave the merchant holding only an unredeemable latest voucher.
        uint256 payable_ = _capped(c, cumulative);
        if (payable_ <= c.claimed) revert BadVoucher();
        if (ECDSA.recover(_voucherDigest(id, cumulative), signature) != c.signer) revert InvalidSignature();

        uint256 paid = payable_ - c.claimed;
        c.claimed = uint128(payable_);
        emit Settled(id, payable_, paid);
        token.safeTransfer(c.payee, paid);
    }

    /// @notice Merchant ends the tab: redeems the final voucher (if newer than what it claimed)
    ///         and refunds the rest to the owner at once.
    function close(bytes32 id, uint256 cumulative, bytes calldata signature) external {
        Channel storage c = _channels[id];
        if (msg.sender != c.payee) revert NotPayee();
        if (c.closesAt == 0) revert NotOpen();
        // After expiry the voucher is ignored and the payer is refunded, same as `reclaim`.
        if (block.timestamp < c.closesAt && _capped(c, cumulative) > c.claimed) settle(id, cumulative, signature);
        _close(id, c);
    }

    /// @notice Owner's kill switch. The session key's tab ends after `REVOKE_GRACE`, which gives the
    ///         merchant time to redeem vouchers for service it already delivered.
    function revoke(bytes32 id) external {
        Channel storage c = _channels[id];
        if (msg.sender != c.payer) revert NotPayer();
        if (c.closesAt == 0) revert NotOpen();
        uint64 graceEnd = uint64(block.timestamp) + REVOKE_GRACE;
        if (graceEnd < c.closesAt) c.closesAt = graceEnd;
        emit Revoked(id, c.closesAt);
    }

    /// @notice After the tab ends, return whatever the merchant didn't redeem to the owner.
    ///         Anyone may submit; the money only ever goes to the payer.
    function reclaim(bytes32 id) external {
        Channel storage c = _channels[id];
        if (c.closesAt == 0) revert NotOpen();
        if (block.timestamp < c.closesAt) revert ChannelStillOpen();
        _close(id, c);
    }

    function channelOf(bytes32 id) external view returns (Channel memory) {
        return _channels[id];
    }

    /// @notice The EIP-712 digest the session key signs for a voucher.
    function voucherDigest(bytes32 id, uint256 cumulative) external view returns (bytes32) {
        return _voucherDigest(id, cumulative);
    }

    function _open(
        address payer,
        address payee,
        address signer,
        uint128 deposit,
        uint64 closesAt,
        bytes32 salt
    ) private returns (bytes32 id) {
        if (payer == address(0) || payee == address(0) || signer == address(0)) revert ZeroAddress();
        if (deposit == 0) revert ZeroAmount();
        if (closesAt <= block.timestamp) revert BadExpiry();
        id = channelId(payer, payee, signer, deposit, closesAt, salt);
        // Closed channels keep their payer, so an id is never reused and old vouchers can't replay.
        if (_channels[id].payer != address(0)) revert ChannelExists();
        _channels[id] = Channel({
            payer: payer,
            closesAt: closesAt,
            payee: payee,
            signer: signer,
            deposit: deposit,
            claimed: 0
        });
        emit Opened(id, payer, payee, signer, deposit, closesAt);
    }

    function _close(bytes32 id, Channel storage c) private {
        uint256 refund = c.deposit - c.claimed;
        c.closesAt = 0;
        emit Closed(id, refund);
        if (refund > 0) token.safeTransfer(c.payer, refund);
    }

    function _capped(Channel storage c, uint256 cumulative) private view returns (uint256) {
        return cumulative > c.deposit ? c.deposit : cumulative;
    }

    function _voucherDigest(bytes32 id, uint256 cumulative) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, id, cumulative)));
    }
}
