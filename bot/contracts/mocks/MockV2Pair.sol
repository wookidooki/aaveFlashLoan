// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20P {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal Uniswap v2 style pair (0.3% fee, constant product check) for tests.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function sync() external {
        reserve0 = uint112(IERC20P(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20P(token1).balanceOf(address(this)));
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out > 0) IERC20P(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20P(token1).transfer(to, amount1Out);
        uint256 b0 = IERC20P(token0).balanceOf(address(this));
        uint256 b1 = IERC20P(token1).balanceOf(address(this));
        uint256 in0 = b0 > reserve0 - amount0Out ? b0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = b1 > reserve1 - amount1Out ? b1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "INSUFFICIENT_INPUT_AMOUNT");
        uint256 adj0 = b0 * 1000 - in0 * 3;
        uint256 adj1 = b1 * 1000 - in1 * 3;
        require(adj0 * adj1 >= uint256(reserve0) * uint256(reserve1) * 1e6, "K");
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}
