// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ArbReceiverBase, IERC20V3} from "./ArbReceiverBase.sol";

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// @notice Aave v3 flavour of the receiver: flashLoanSimple, premium charged by Aave (rounded up),
/// repayment pulled by the pool after executeOperation returns. Kept for comparison; the scanner's
/// default lender is Morpho (FlashArbReceiverMorpho), which charges no fee.
contract FlashArbReceiverV3 is ArbReceiverBase {
    constructor(address _aavePool) ArbReceiverBase(_aavePool) {}

    function aavePool() external view returns (address) {
        return lender;
    }

    function _borrow(address asset, uint256 amount, bytes memory params) internal override {
        IAaveV3Pool(lender).flashLoanSimple(address(this), asset, amount, params, 0);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != lender) revert NotPool();
        if (initiator != address(this)) revert BadInitiator(initiator);
        if (!pending) revert NotInitiated();
        pending = false;

        _executeLegs(asset, amount, premium, params);

        // Aave v3 pulls principal + premium after this call returns.
        require(IERC20V3(asset).approve(lender, amount + premium), "approve failed");
        return true;
    }
}
