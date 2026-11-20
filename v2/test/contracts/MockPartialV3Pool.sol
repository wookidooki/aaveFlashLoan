// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Min {
    function transfer(address, uint256) external returns (bool);
}

interface IV3Callback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Test-only v3-style pool that fills only half of every exact-input swap,
///         at a 1:1 price, like a real pool that runs out of liquidity.
contract MockPartialV3Pool {
    address public immutable token0;
    address public immutable token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        int256 half = amountSpecified / 2;
        (amount0, amount1) = zeroForOne ? (half, -half) : (-half, half);
        IERC20Min(zeroForOne ? token1 : token0).transfer(recipient, uint256(half));
        IV3Callback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}
