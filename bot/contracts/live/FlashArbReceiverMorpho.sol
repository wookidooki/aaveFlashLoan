// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ArbReceiverBase, IERC20V3} from "./ArbReceiverBase.sol";

/// Morpho Blue singleton. flashLoan sends `assets` of `token` to the caller, calls
/// onMorphoFlashLoan(assets, data) on the caller, then pulls `assets` back with transferFrom.
/// There is no fee.
interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice Morpho flavour of the receiver: zero-fee flash loan of exactly the principal.
/// Morpho always calls back the account that requested the loan, and the callback carries no token
/// or initiator, so the pending loan's asset and amount are kept in transient storage and checked.
contract FlashArbReceiverMorpho is ArbReceiverBase {
    address private transient pendingAsset;
    uint256 private transient pendingAmount;

    constructor(address _morpho) ArbReceiverBase(_morpho) {}

    function _borrow(address asset, uint256 amount, bytes memory params) internal override {
        pendingAsset = asset;
        pendingAmount = amount;
        IMorpho(lender).flashLoan(asset, amount, params);
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != lender) revert NotPool();
        if (!pending) revert NotInitiated();
        if (assets != pendingAmount) revert WrongAmount(assets, pendingAmount);
        pending = false;

        address asset = pendingAsset;
        _executeLegs(asset, assets, 0, data);

        // Morpho pulls exactly the principal after this call returns.
        require(IERC20V3(asset).approve(lender, assets), "approve failed");
    }
}
