// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20MM {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @notice Test double for Morpho Blue flashLoan: send, call back the caller, pull back exactly
/// the principal (no fee), as Morpho Blue does.
contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(assets != 0, "zero assets");
        require(IERC20MM(token).transfer(msg.sender, assets), "send failed");
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(IERC20MM(token).transferFrom(msg.sender, address(this), assets), "repay failed");
    }
}
