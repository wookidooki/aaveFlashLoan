// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20C {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ISwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Callback-style pool for tests. Prices with a constant product over its balances and a
/// 0.3% fee (not real concentrated liquidity), but follows the v3 swap/callback protocol: sends the
/// output first, calls back for the input, then checks it was paid.
contract MockCLPool {
    address public immutable token0;
    address public immutable token1;
    bool public immutable pancakeCallback;

    constructor(address _token0, address _token1, bool _pancakeCallback) {
        token0 = _token0;
        token1 = _token1;
        pancakeCallback = _pancakeCallback;
    }

    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = zeroForOne
            ? (IERC20C(token0).balanceOf(address(this)), IERC20C(token1).balanceOf(address(this)))
            : (IERC20C(token1).balanceOf(address(this)), IERC20C(token0).balanceOf(address(this)));
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = quote(zeroForOne, amountIn);
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        IERC20C(tOut).transfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        uint256 before = IERC20C(tIn).balanceOf(address(this));
        if (pancakeCallback) ISwapCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        else ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20C(tIn).balanceOf(address(this)) >= before + amountIn, "IIA");
    }
}
