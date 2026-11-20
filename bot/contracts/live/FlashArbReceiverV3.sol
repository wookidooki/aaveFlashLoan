// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20V3 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/// Uniswap v3 and its forks (SushiSwap v3, PancakeSwap v3, Aerodrome/Velodrome Slipstream) and
/// Algebra pools (Camelot v3) share this swap signature; only the callback name differs.
interface IConcentratedPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// Pools that quote their own fee and curve: Aerodrome/Velodrome v2, Camelot v2.
interface ISolidlyPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// Uniswap v4 PoolManager (singleton). Currency 0x0 is native ETH.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Aave v3 flash-loan receiver that executes one atomic round trip on one chain:
/// borrow `asset`, swap through `legs`, end in `asset`, repay principal + premium, keep the surplus.
///
/// Safety properties (each covered by tests or by the same-block simulation):
///  - only the owner can start a loan or a simulation;
///  - executeOperation only accepts calls from the configured Aave pool, with this contract as the
///    initiator, for a loan this contract started in the same transaction;
///  - every leg has a non-zero minimum output, measured as the receiver's balance delta;
///  - the final proceeds must cover principal + premium + a positive minimum surplus, measured from
///    the trade itself, so tokens the receiver already holds can never subsidize a losing trade;
///  - swap callbacks (v3-style, Algebra and the v4 unlock callback) are only honoured from the pool
///    of the leg currently executing, once, and only for that leg's input token and amount;
///  - Uniswap v4 legs must use hookless pools and must fill the exact input;
///  - native ETH is accepted only while a v4 leg or a WETH unwrap is executing.
///
/// `owner` and `aavePool` live in storage (slots 0 and 1) rather than immutables so the scanner can
/// run `simulate` through eth_call with a code + storage override, without any deployment.
contract FlashArbReceiverV3 {
    address public owner; // slot 0
    address public aavePool; // slot 1

    uint8 internal constant KIND_CL_UNISWAP_CALLBACK = 0; // Uniswap v3, SushiSwap v3, Slipstream
    uint8 internal constant KIND_CL_PANCAKE_CALLBACK = 1; // PancakeSwap v3
    uint8 internal constant KIND_V2 = 2; // Uniswap v2 / SushiSwap v2 style pair, fee in feeBps
    uint8 internal constant KIND_SOLIDLY = 3; // pool.getAmountOut(): Aerodrome/Velodrome v2, Camelot v2
    uint8 internal constant KIND_CL_ALGEBRA = 4; // Algebra (Camelot v3)
    uint8 internal constant KIND_V4 = 5; // Uniswap v4: pool = PoolManager, data = abi.encode(PoolKey, weth)

    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    struct Leg {
        uint8 kind;
        address pool;
        address tokenIn;
        address tokenOut;
        uint16 feeBps; // only used by KIND_V2
        uint256 minOut;
        bytes data; // only used by KIND_V4
    }

    bool private transient pending;
    address private transient callbackPool;
    address private transient callbackToken;
    uint256 private transient callbackMaxAmount;
    bool private transient acceptEth;

    event ArbExecuted(address indexed asset, uint256 amount, uint256 premium, uint256 proceeds, uint256 profit);

    error NotOwner();
    error NotPool();
    error BadInitiator(address initiator);
    error NotInitiated();
    error BadRoute();
    error ZeroMinimum();
    error PoolTokenMismatch(uint256 leg);
    error UnknownKind(uint8 kind);
    error LegOutput(uint256 leg, uint256 out, uint256 minOut);
    error InsufficientProceeds(uint256 proceeds, uint256 required);
    error ProfitNotRetained(uint256 profit, uint256 minSurplus);
    error BadCallback(address sender);
    error UnexpectedEth(address sender);
    error HookedPool(address hooks);
    error PartialFill(uint256 filled, uint256 amountIn);
    error SimulationResult(bool ok, uint256 gasUsed, uint256 profit, bytes reason);

    constructor(address _aavePool) {
        owner = msg.sender;
        aavePool = _aavePool;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    receive() external payable {
        if (!acceptEth) revert UnexpectedEth(msg.sender);
    }

    function run(address asset, uint256 amount, Leg[] calldata legs, uint256 minSurplus)
        external
        onlyOwner
        returns (uint256 profit)
    {
        return _run(asset, amount, legs, minSurplus);
    }

    /// @notice Executes the full route and then always reverts with SimulationResult, so it can never
    /// move funds. Intended for eth_call against live state (optionally with a code override).
    function simulate(address asset, uint256 amount, Leg[] calldata legs, uint256 minSurplus) external onlyOwner {
        uint256 gasStart = gasleft();
        try this.simulateInner(asset, amount, legs, minSurplus) returns (uint256 profit) {
            revert SimulationResult(true, gasStart - gasleft(), profit, "");
        } catch (bytes memory reason) {
            revert SimulationResult(false, gasStart - gasleft(), 0, reason);
        }
    }

    function simulateInner(address asset, uint256 amount, Leg[] calldata legs, uint256 minSurplus)
        external
        returns (uint256)
    {
        if (msg.sender != address(this)) revert NotOwner();
        return _run(asset, amount, legs, minSurplus);
    }

    function _run(address asset, uint256 amount, Leg[] calldata legs, uint256 minSurplus) internal returns (uint256 profit) {
        uint256 n = legs.length;
        if (n < 2 || legs[0].tokenIn != asset || legs[n - 1].tokenOut != asset) revert BadRoute();
        for (uint256 i = 0; i < n; i++) {
            if (legs[i].minOut == 0) revert ZeroMinimum();
            if (i + 1 < n && legs[i].tokenOut != legs[i + 1].tokenIn) revert BadRoute();
        }
        if (minSurplus == 0) revert ZeroMinimum();

        uint256 balanceBefore = IERC20V3(asset).balanceOf(address(this));
        pending = true;
        IAaveV3Pool(aavePool).flashLoanSimple(address(this), asset, amount, abi.encode(legs, minSurplus), 0);
        if (pending) revert NotInitiated();

        profit = IERC20V3(asset).balanceOf(address(this)) - balanceBefore;
        if (profit < minSurplus) revert ProfitNotRetained(profit, minSurplus);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != aavePool) revert NotPool();
        if (initiator != address(this)) revert BadInitiator(initiator);
        if (!pending) revert NotInitiated();
        pending = false;

        (Leg[] memory legs, uint256 minSurplus) = abi.decode(params, (Leg[], uint256));
        if (legs[0].tokenIn != asset) revert BadRoute();

        uint256 amountIn = amount;
        for (uint256 i = 0; i < legs.length; i++) {
            uint256 out = _swap(i, legs[i], amountIn);
            if (out < legs[i].minOut) revert LegOutput(i, out, legs[i].minOut);
            amountIn = out;
        }

        uint256 required = amount + premium + minSurplus;
        if (amountIn < required) revert InsufficientProceeds(amountIn, required);

        // Aave v3 pulls principal + premium after this call returns.
        require(IERC20V3(asset).approve(aavePool, amount + premium), "approve failed");
        emit ArbExecuted(asset, amount, premium, amountIn, amountIn - amount - premium);
        return true;
    }

    /// @return out the receiver's balance increase in leg.tokenOut
    function _swap(uint256 i, Leg memory leg, uint256 amountIn) internal returns (uint256 out) {
        uint256 outBefore = IERC20V3(leg.tokenOut).balanceOf(address(this));

        if (leg.kind == KIND_V4) {
            _swapV4(i, leg, amountIn);
        } else {
            address t0 = IV2Pair(leg.pool).token0();
            address t1 = IV2Pair(leg.pool).token1();
            bool zeroForOne = leg.tokenIn == t0;
            if (!((zeroForOne && leg.tokenOut == t1) || (leg.tokenIn == t1 && leg.tokenOut == t0))) revert PoolTokenMismatch(i);

            if (leg.kind == KIND_CL_UNISWAP_CALLBACK || leg.kind == KIND_CL_PANCAKE_CALLBACK || leg.kind == KIND_CL_ALGEBRA) {
                callbackPool = leg.pool;
                callbackToken = leg.tokenIn;
                callbackMaxAmount = amountIn;
                IConcentratedPool(leg.pool).swap(
                    address(this),
                    zeroForOne,
                    int256(amountIn),
                    zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
                    ""
                );
                callbackPool = address(0);
            } else if (leg.kind == KIND_V2) {
                (uint112 r0, uint112 r1,) = IV2Pair(leg.pool).getReserves();
                (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
                uint256 inWithFee = amountIn * (10000 - leg.feeBps);
                uint256 amountOut = (inWithFee * rOut) / (rIn * 10000 + inWithFee);
                require(IERC20V3(leg.tokenIn).transfer(leg.pool, amountIn), "transfer failed");
                IV2Pair(leg.pool).swap(zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0, address(this), "");
            } else if (leg.kind == KIND_SOLIDLY) {
                uint256 amountOut = ISolidlyPool(leg.pool).getAmountOut(amountIn, leg.tokenIn);
                require(IERC20V3(leg.tokenIn).transfer(leg.pool, amountIn), "transfer failed");
                ISolidlyPool(leg.pool).swap(zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0, address(this), "");
            } else {
                revert UnknownKind(leg.kind);
            }
        }

        out = IERC20V3(leg.tokenOut).balanceOf(address(this)) - outBefore;
    }

    // ------------------------------------------------------------------ Uniswap v4

    /// Logical tokens are ERC20s (WETH stands in for ETH); a pool currency of 0x0 is native ETH.
    function _currency(address token, PoolKey memory key, address weth) internal pure returns (address) {
        return (token == weth && key.currency0 == address(0)) ? address(0) : token;
    }

    function _swapV4(uint256 i, Leg memory leg, uint256 amountIn) internal {
        (PoolKey memory key, address weth) = abi.decode(leg.data, (PoolKey, address));
        if (key.hooks != address(0)) revert HookedPool(key.hooks);
        address cIn = _currency(leg.tokenIn, key, weth);
        address cOut = _currency(leg.tokenOut, key, weth);
        bool zeroForOne = cIn == key.currency0;
        if (!((zeroForOne && cOut == key.currency1) || (cIn == key.currency1 && cOut == key.currency0))) revert PoolTokenMismatch(i);

        acceptEth = true;
        if (cIn == address(0)) IWETH(weth).withdraw(amountIn);
        callbackPool = leg.pool;
        bytes memory res = IPoolManager(leg.pool).unlock(abi.encode(key, zeroForOne, amountIn, cIn, cOut));
        callbackPool = address(0);
        uint256 out = abi.decode(res, (uint256));
        if (cOut == address(0)) IWETH(weth).deposit{value: out}();
        acceptEth = false;
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != callbackPool || msg.sender == address(0)) revert BadCallback(msg.sender);
        callbackPool = address(0); // one unlock per leg
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address cIn, address cOut) =
            abi.decode(raw, (PoolKey, bool, uint256, address, address));
        IPoolManager pm = IPoolManager(msg.sender);

        int256 delta = pm.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            }),
            ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        (int128 dIn, int128 dOut) = zeroForOne ? (d0, d1) : (d1, d0);
        if (dIn >= 0 || dOut <= 0) revert PartialFill(0, amountIn);
        uint256 owed = uint256(uint128(-dIn));
        if (owed != amountIn) revert PartialFill(owed, amountIn);

        if (cIn == address(0)) {
            pm.settle{value: owed}();
        } else {
            pm.sync(cIn);
            require(IERC20V3(cIn).transfer(address(pm), owed), "v4 pay failed");
            pm.settle();
        }
        uint256 out = uint256(uint128(dOut));
        pm.take(cOut, address(this), out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ v3-style callbacks

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payCallback(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payCallback(amount0Delta, amount1Delta);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payCallback(amount0Delta, amount1Delta);
    }

    function _payCallback(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != callbackPool || msg.sender == address(0)) revert BadCallback(msg.sender);
        callbackPool = address(0); // one payment per swap
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        if (owed == 0 || owed > callbackMaxAmount) revert BadCallback(msg.sender);
        require(IERC20V3(callbackToken).transfer(msg.sender, owed), "callback pay failed");
    }

    function withdraw(address token, address to) external onlyOwner {
        require(IERC20V3(token).transfer(to, IERC20V3(token).balanceOf(address(this))), "withdraw failed");
    }
}
