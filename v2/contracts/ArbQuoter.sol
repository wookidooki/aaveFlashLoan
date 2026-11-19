// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ArbQuoter
/// @notice Read-only price checker for the scanner. It is NEVER deployed. The scanner
///         puts its code at a dummy address inside an eth_call ("state override"), so
///         quoting is free and needs no gas or wallet.
/// @dev    v3 quotes use the standard trick: start a real swap, then revert inside the
///         swap callback with the amounts. Nothing is ever paid. Hops in a route are
///         quoted one after another on current state, so a route must not use the
///         same pool twice.

interface IV2PairQ {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

interface ISolidlyPoolQ {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

interface IV3PoolQ {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract ArbQuoter {
    struct Hop {
        uint8 kind;
        address pool;
        address tokenIn;
        address tokenOut;
        uint16 feeBps;
    }

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @notice For each route i and each input amount j, returns the final output amount.
    ///         0 means the quote failed (no liquidity, partial fill, or pool error).
    function quote(Hop[][] calldata routes, uint256[][] calldata amounts)
        external
        returns (uint256[][] memory outs)
    {
        outs = new uint256[][](routes.length);
        for (uint256 i; i < routes.length; ++i) {
            outs[i] = new uint256[](amounts[i].length);
            for (uint256 j; j < amounts[i].length; ++j) {
                outs[i][j] = _quoteRoute(routes[i], amounts[i][j]);
            }
        }
    }

    function _quoteRoute(Hop[] calldata hops, uint256 amount) internal returns (uint256) {
        for (uint256 k; k < hops.length; ++k) {
            amount = _quoteHop(hops[k], amount);
            if (amount == 0) return 0;
        }
        return amount;
    }

    function _quoteHop(Hop calldata h, uint256 amountIn) internal returns (uint256) {
        bool zeroForOne = h.tokenIn < h.tokenOut;

        if (h.kind == 0) {
            try IV2PairQ(h.pool).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                uint256 inWithFee = amountIn * (10000 - h.feeBps);
                return (inWithFee * rOut) / (rIn * 10000 + inWithFee);
            } catch {
                return 0;
            }
        }

        if (h.kind == 1) {
            try ISolidlyPoolQ(h.pool).getAmountOut(amountIn, h.tokenIn) returns (uint256 out) {
                return out;
            } catch {
                return 0;
            }
        }

        if (h.kind == 2) {
            if (amountIn > uint256(type(int256).max)) return 0;
            try IV3PoolQ(h.pool).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                ""
            ) returns (int256, int256) {
                return 0; // should never happen: the callback always reverts
            } catch (bytes memory reason) {
                if (reason.length != 64) return 0;
                (int256 a0, int256 a1) = abi.decode(reason, (int256, int256));
                int256 paid = zeroForOne ? a0 : a1;
                int256 got = zeroForOne ? a1 : a0;
                // Partial fill (pool ran out of liquidity): treat as failed.
                if (paid < int256(amountIn) || got >= 0) return 0;
                return uint256(-got);
            }
        }

        return 0;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        _revertWith(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        _revertWith(amount0Delta, amount1Delta);
    }

    function _revertWith(int256 a0, int256 a1) internal pure {
        assembly {
            mstore(0, a0)
            mstore(32, a1)
            revert(0, 64)
        }
    }
}
