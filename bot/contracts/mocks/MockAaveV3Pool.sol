// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @notice Test double for Aave v3 Pool.flashLoanSimple: sends `amount`, calls back with
/// initiator = msg.sender, then pulls amount + premium. premium = ceil(amount * premiumBps / 10000),
/// matching the rounding observed on mainnet Aave v3.
contract MockAaveV3Pool {
    uint128 public FLASHLOAN_PREMIUM_TOTAL = 5;

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        uint256 premium = (amount * FLASHLOAN_PREMIUM_TOTAL + 9999) / 10000;
        require(IERC20M(asset).transfer(receiver, amount), "send failed");
        require(
            IFlashLoanSimpleReceiver(receiver).executeOperation(asset, amount, premium, msg.sender, params),
            "INVALID_FLASHLOAN_EXECUTOR_RETURN"
        );
        require(IERC20M(asset).transferFrom(receiver, address(this), amount + premium), "repay failed");
    }
}
