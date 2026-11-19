// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FlashArb
/// @notice Borrows one token with a flash loan (Aave v3, or Morpho Blue with no fee),
///         trades it through a route of
///         pools (Uniswap v2 style, Aerodrome/Solidly style, Uniswap v3 style), pays back
///         the loan + fee, and sends the profit to the owner.
///         If the route does not return loan + fee + minProfit, the whole transaction
///         reverts. You then lose only the gas fee.
/// @dev    Only the owner can start a trade. Only the Aave pool / Morpho can call the
///         flash loan callbacks, and only for a loan this contract started. Only the pool
///         being swapped on can call the v3 swap callback.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface ISolidlyPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

interface IV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract FlashArb {
    /// @param kind     0 = v2 pair, 1 = solidly pool, 2 = v3 style pool
    /// @param pool     pool / pair address
    /// @param tokenIn  token sent into the pool
    /// @param tokenOut token received from the pool
    /// @param feeBps   v2 only: swap fee in 1/10000 (30 = 0.3%)
    struct Hop {
        uint8 kind;
        address pool;
        address tokenIn;
        address tokenOut;
        uint16 feeBps;
    }

    uint8 internal constant KIND_V2 = 0;
    uint8 internal constant KIND_SOLIDLY = 1;
    uint8 internal constant KIND_V3 = 2;

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    // Transient storage slots.
    uint256 internal constant EXPECTED_POOL_SLOT = 0; // pool we expect a v3 callback from
    uint256 internal constant MORPHO_LOAN_SLOT = 1; // 1 while our own Morpho flash loan runs

    address public immutable owner;
    IAavePool public immutable aavePool;
    IMorpho public immutable morpho; // address(0) on chains without Morpho

    error NotOwner();
    error NotAavePool();
    error NotMorpho();
    error NoMorpho();
    error BadInitiator();
    error BadRoute();
    error BadCallback();
    error NotEnoughProfit(uint256 amountOut, uint256 needed);
    error TokenCallFailed();

    constructor(address aavePool_, address morpho_) {
        owner = msg.sender;
        aavePool = IAavePool(aavePool_);
        morpho = IMorpho(morpho_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Start a flash loan arbitrage. Reverts unless profit >= minProfit.
    /// @return profit amount of `asset` sent to the owner
    function startArb(address asset, uint256 amount, Hop[] calldata hops, uint256 minProfit)
        external
        onlyOwner
        returns (uint256 profit)
    {
        aavePool.flashLoanSimple(address(this), asset, amount, abi.encode(hops, minProfit), 0);
        profit = IERC20(asset).balanceOf(address(this));
        _safeTransfer(asset, owner, profit);
    }

    /// @notice Same as startArb, but borrows from Morpho Blue (no flash loan fee).
    function startArbMorpho(address asset, uint256 amount, Hop[] calldata hops, uint256 minProfit)
        external
        onlyOwner
        returns (uint256 profit)
    {
        if (address(morpho) == address(0)) revert NoMorpho();
        _tstore(MORPHO_LOAN_SLOT, 1);
        morpho.flashLoan(asset, amount, abi.encode(asset, hops, minProfit));
        _tstore(MORPHO_LOAN_SLOT, 0);
        profit = IERC20(asset).balanceOf(address(this));
        _safeTransfer(asset, owner, profit);
    }

    /// @notice Called by Morpho during the flash loan. Morpho then pulls back `assets`.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (_tload(MORPHO_LOAN_SLOT) != 1) revert BadInitiator();

        (address asset, Hop[] memory hops, uint256 minProfit) = abi.decode(data, (address, Hop[], uint256));
        uint256 amountOut = _runRoute(asset, assets, hops);

        uint256 needed = assets + minProfit;
        if (amountOut < needed) revert NotEnoughProfit(amountOut, needed);

        _safeApprove(asset, address(morpho), assets);
    }

    /// @notice Called by Aave during the flash loan.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(aavePool)) revert NotAavePool();
        if (initiator != address(this)) revert BadInitiator();

        (Hop[] memory hops, uint256 minProfit) = abi.decode(params, (Hop[], uint256));
        uint256 amountOut = _runRoute(asset, amount, hops);

        uint256 needed = amount + premium + minProfit;
        if (amountOut < needed) revert NotEnoughProfit(amountOut, needed);

        _safeApprove(asset, address(aavePool), amount + premium);
        return true;
    }

    /// @notice Rescue tokens sent to this contract by mistake.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
    }

    // ---------------------------------------------------------------- v3 callbacks

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3Callback(amount0Delta, amount1Delta, data);
    }

    function _v3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        address expected = address(uint160(_tload(EXPECTED_POOL_SLOT)));
        if (expected == address(0) || msg.sender != expected) revert BadCallback();
        address tokenIn = abi.decode(data, (address));
        uint256 pay = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        _safeTransfer(tokenIn, msg.sender, pay);
    }

    // ---------------------------------------------------------------- route

    function _runRoute(address asset, uint256 amountIn, Hop[] memory hops) internal returns (uint256 amount) {
        uint256 n = hops.length;
        if (n == 0 || hops[0].tokenIn != asset || hops[n - 1].tokenOut != asset) revert BadRoute();
        amount = amountIn;
        for (uint256 i; i < n; ++i) {
            if (i > 0 && hops[i].tokenIn != hops[i - 1].tokenOut) revert BadRoute();
            amount = _swap(hops[i], amount);
        }
    }

    function _swap(Hop memory h, uint256 amountIn) internal returns (uint256 amountOut) {
        bool zeroForOne = h.tokenIn < h.tokenOut;

        if (h.kind == KIND_V3) {
            _tstore(EXPECTED_POOL_SLOT, uint256(uint160(h.pool)));
            (int256 a0, int256 a1) = IV3Pool(h.pool).swap(
                address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                abi.encode(h.tokenIn)
            );
            _tstore(EXPECTED_POOL_SLOT, 0);
            amountOut = uint256(-(zeroForOne ? a1 : a0));
            return amountOut;
        }

        if (h.kind == KIND_V2) {
            (uint256 r0, uint256 r1,) = IV2Pair(h.pool).getReserves();
            (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
            uint256 inWithFee = amountIn * (10000 - h.feeBps);
            amountOut = (inWithFee * rOut) / (rIn * 10000 + inWithFee);
        } else if (h.kind == KIND_SOLIDLY) {
            amountOut = ISolidlyPool(h.pool).getAmountOut(amountIn, h.tokenIn);
        } else {
            revert BadRoute();
        }

        _safeTransfer(h.tokenIn, h.pool, amountIn);
        (uint256 out0, uint256 out1) = zeroForOne ? (uint256(0), amountOut) : (amountOut, uint256(0));
        // Uniswap v2 pairs and Solidly pools share this swap signature.
        IV2Pair(h.pool).swap(out0, out1, address(this), "");
    }

    function _tstore(uint256 slot, uint256 value) internal {
        assembly {
            tstore(slot, value)
        }
    }

    function _tload(uint256 slot) internal view returns (uint256 value) {
        assembly {
            value := tload(slot)
        }
    }

    // ---------------------------------------------------------------- tokens

    // Works with tokens that return bool and tokens that return nothing (like USDT).
    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }

    function _safeApprove(address token, address spender, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, value));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        // Some tokens need the allowance set to 0 first.
        (ok, ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
        (ok, ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, value));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }
}
