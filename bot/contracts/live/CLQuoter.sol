// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface ICLPoolQ {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice Read-only quoter for concentrated-liquidity pools (Uniswap v3 forks, Slipstream, Algebra).
/// Never deployed: the scanner injects this code at a fixed address with an eth_call state override.
/// It runs the pool's real swap() and reverts inside the swap callback with the computed deltas, so
/// the quote is the pool's own math at that block, including fees and price impact.
contract CLQuoter {
    struct Req {
        address pool;
        bool zeroForOne;
        uint256 amountIn;
    }

    struct Res {
        bool ok;
        uint256 amountOut;
        uint256 gasUsed;
    }

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @param gasCap gas allowed per quote; a quote that needs more fails instead of stalling the batch
    function quoteMany(Req[] calldata reqs, uint256 gasCap) external returns (Res[] memory out) {
        out = new Res[](reqs.length);
        for (uint256 i = 0; i < reqs.length; i++) {
            if (gasleft() < gasCap + 100_000) break; // out of budget: remaining entries stay ok=false
            uint256 g = gasleft();
            try this.quoteOne{gas: gasCap}(reqs[i].pool, reqs[i].zeroForOne, reqs[i].amountIn) {
                // quoteOne always reverts
            } catch (bytes memory r) {
                if (r.length == 64) {
                    (int256 a0, int256 a1) = abi.decode(r, (int256, int256));
                    int256 outDelta = reqs[i].zeroForOne ? a1 : a0;
                    int256 inDelta = reqs[i].zeroForOne ? a0 : a1;
                    // Exact input must be fully consumed; otherwise the pool ran out of range.
                    if (outDelta < 0 && inDelta == int256(reqs[i].amountIn)) {
                        out[i] = Res(true, uint256(-outDelta), g - gasleft());
                    }
                }
            }
        }
    }

    function quoteOne(address pool, bool zeroForOne, uint256 amountIn) external {
        ICLPoolQ(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            ""
        );
        revert("swap returned");
    }

    function _bounce(int256 a0, int256 a1) internal pure {
        assembly {
            let p := mload(0x40)
            mstore(p, a0)
            mstore(add(p, 0x20), a1)
            revert(p, 0x40)
        }
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        _bounce(a0, a1);
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        _bounce(a0, a1);
    }

    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        _bounce(a0, a1);
    }
}
