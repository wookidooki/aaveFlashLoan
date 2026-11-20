// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {FlashArb} from "../../contracts/FlashArb.sol";
import {ArbQuoter} from "../../contracts/ArbQuoter.sol";

// Shared code for the FlashArb fork tests (one child contract per chain).
// Same checks as test/fork.flasharb.test.js: create a real price gap by dumping WETH into
// a Uniswap v2 style WETH/USDC pair, check FlashArb captures it, and check that strangers
// cannot use or attack the contract.
//
// A child contract must: fork the chain, set the addresses below, then call _setUpShared().

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH is IERC20F {
    function deposit() external payable;
}

interface IV2FactoryF {
    function getPair(address, address) external view returns (address);
}

interface IV3FactoryF {
    function getPool(address, address, uint24 fee) external view returns (address);
}

interface IClFactoryF {
    function getPool(address, address, int24 tickSpacing) external view returns (address);
}

interface ISolidlyFactoryF {
    function getPool(address, address, bool stable) external view returns (address);
}

interface IV2PairF {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address, bytes calldata) external;
}

interface IAavePoolF {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
}

abstract contract FlashArbForkShared is Test {
    // Hop kinds (src/routes.js): v2 = 0, solidly = 1, v3 and cl = 2
    uint8 internal constant V2 = 0;
    uint8 internal constant SOLIDLY = 1;
    uint8 internal constant V3 = 2;

    // Set by the child contract before _setUpShared()
    address internal aavePool;
    address internal morpho;
    address internal weth;
    address internal usdc;
    address internal v2Pool; // Uniswap v2 style WETH/USDC pair (0.3% fee) where the gap is made
    address internal v3Pool; // deep v3 style WETH/USDC pool used by the shared tests
    uint256 internal dumpDiv = 20; // dump 1/dumpDiv of the v2 pair's WETH (20 = 5%)

    FlashArb internal arb;
    ArbQuoter internal quoter;
    uint256 internal premiumBps;
    address internal stranger = makeAddr("stranger");

    struct Best {
        uint256 amount;
        int256 profit;
    }

    /// USDC loan sizes to try (6 decimals).
    function _usdcSizes() internal pure virtual returns (uint256[] memory);

    /// WETH loan sizes to try (18 decimals).
    function _wethSizes() internal pure virtual returns (uint256[] memory);

    /// Fork the chain: latest block, or the block in env var `blockEnv` if set.
    function _fork(string memory rpcAlias, string memory blockEnv) internal {
        uint256 forkBlock = vm.envOr(blockEnv, uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpcAlias);
        else vm.createSelectFork(rpcAlias, forkBlock);
    }

    function _setUpShared() internal {
        assertTrue(v2Pool != address(0), "v2 pool missing");
        assertTrue(v3Pool != address(0), "v3 pool missing");
        arb = new FlashArb(aavePool, morpho);
        quoter = new ArbQuoter();
        premiumBps = IAavePoolF(aavePool).FLASHLOAN_PREMIUM_TOTAL();
        _createGap();
    }

    /// Dump WETH into the v2 pair, so WETH is cheap there.
    function _createGap() internal {
        (uint112 r0, uint112 r1,) = IV2PairF(v2Pool).getReserves();
        bool wethIs0 = IV2PairF(v2Pool).token0() == weth;
        (uint256 rWeth, uint256 rUsdc) = wethIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        console.log("v2 reserves: %e WETH, %e USDC", rWeth, rUsdc);

        address dumper = makeAddr("dumper");
        uint256 dump = rWeth / dumpDiv;
        vm.deal(dumper, dump);
        vm.startPrank(dumper);
        IWETH(weth).deposit{value: dump}();
        IWETH(weth).transfer(v2Pool, dump);
        uint256 inFee = dump * 997;
        uint256 out = (inFee * rUsdc) / (rWeth * 1000 + inFee);
        if (wethIs0) IV2PairF(v2Pool).swap(0, out, dumper, "");
        else IV2PairF(v2Pool).swap(out, 0, dumper, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    /// v2 hops use a 0.3% fee (all v2 pairs used in these tests charge 0.3%).
    function _hop(uint8 kind, address pool, address tokenIn, address tokenOut)
        internal
        pure
        returns (FlashArb.Hop memory)
    {
        return FlashArb.Hop(kind, pool, tokenIn, tokenOut, kind == V2 ? 30 : 0);
    }

    function _route(FlashArb.Hop memory a, FlashArb.Hop memory b) internal pure returns (FlashArb.Hop[] memory r) {
        r = new FlashArb.Hop[](2);
        r[0] = a;
        r[1] = b;
    }

    /// Final output of `route` for each size, from ArbQuoter (0 = quote failed).
    function _quote(FlashArb.Hop[] memory route, uint256[] memory sizes) internal returns (uint256[] memory) {
        ArbQuoter.Hop[][] memory routes = new ArbQuoter.Hop[][](1);
        routes[0] = new ArbQuoter.Hop[](route.length);
        for (uint256 i; i < route.length; ++i) {
            FlashArb.Hop memory h = route[i];
            routes[0][i] = ArbQuoter.Hop(h.kind, h.pool, h.tokenIn, h.tokenOut, h.feeBps);
        }
        uint256[][] memory amounts = new uint256[][](1);
        amounts[0] = sizes;
        return quoter.quote(routes, amounts)[0];
    }

    function _premium(uint256 amount) internal view returns (uint256) {
        return (amount * premiumBps + 5000) / 10000;
    }

    /// Best loan size from `sizes` for `route`, and its expected profit.
    /// withFee = true for an Aave loan, false for Morpho (no fee).
    function _quoteBest(FlashArb.Hop[] memory route, uint256[] memory sizes, bool withFee)
        internal
        returns (Best memory best)
    {
        uint256[] memory outs = _quote(route, sizes);
        best.profit = type(int256).min;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 fee = withFee ? _premium(sizes[i]) : 0;
            int256 p = int256(outs[i]) - int256(sizes[i]) - int256(fee);
            if (p > best.profit) best = Best(sizes[i], p);
        }
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20F(token).balanceOf(who);
    }

    /// Buy WETH cheap on the v2 pair, sell it on `pool`. Real profit must match the quote.
    /// toleranceDiv: 0 = exact match, 200 = within 0.5%.
    function _capturesGap(uint8 kind, address pool, uint256 toleranceDiv) internal {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, usdc, weth), _hop(kind, pool, weth, usdc));
        Best memory best = _quoteBest(route, _usdcSizes(), true);
        assertGt(best.profit, 0, "quoter should see a profit");
        console.log("best size %e USDC, quoted profit %e USDC", best.amount, uint256(best.profit));

        uint256 before = _bal(usdc, address(this));
        arb.startArb(usdc, best.amount, route, 1);
        uint256 gained = _bal(usdc, address(this)) - before;
        console.log("real profit %e USDC", gained);

        uint256 expected = uint256(best.profit);
        uint256 tolerance = toleranceDiv == 0 ? 0 : expected / toleranceDiv;
        assertApproxEqAbs(gained, expected, tolerance, "real profit should match quote");
        assertEq(_bal(usdc, address(arb)), 0, "contract keeps nothing");
    }

    function _gapRoute() internal view returns (FlashArb.Hop[] memory) {
        return _route(_hop(V2, v2Pool, usdc, weth), _hop(V3, v3Pool, weth, usdc));
    }

    // ------------------------------------------------------------------ shared profit tests

    function test_WethLoan_V3ThenV2() public {
        FlashArb.Hop[] memory route = _route(_hop(V3, v3Pool, weth, usdc), _hop(V2, v2Pool, usdc, weth));
        Best memory best = _quoteBest(route, _wethSizes(), true);
        assertGt(best.profit, 0, "quoter should see a profit");

        uint256 before = _bal(weth, address(this));
        arb.startArb(weth, best.amount, route, 1);
        assertEq(_bal(weth, address(this)) - before, uint256(best.profit));
        assertEq(_bal(weth, address(arb)), 0, "contract keeps nothing");
    }

    function test_MorphoLoan_NoFee() public {
        FlashArb.Hop[] memory route = _gapRoute();
        Best memory best = _quoteBest(route, _usdcSizes(), false);
        assertGt(best.profit, 0, "quoter should see a profit");

        uint256 before = _bal(usdc, address(this));
        arb.startArbMorpho(usdc, best.amount, route, 1);
        uint256 gained = _bal(usdc, address(this)) - before;
        console.log("morpho profit %e USDC (Aave fee would be %e USDC)", gained, _premium(best.amount));
        assertEq(gained, uint256(best.profit), "no fee is taken");
        assertEq(_bal(usdc, address(arb)), 0, "contract keeps nothing");
    }

    // ------------------------------------------------------------------ shared revert tests

    function test_RevertWhen_NotProfitable() public {
        // Wrong direction: buy WETH where it is expensive, sell where it is cheap.
        FlashArb.Hop[] memory route = _route(_hop(V3, v3Pool, usdc, weth), _hop(V2, v2Pool, weth, usdc));
        uint256[] memory sizes = _usdcSizes();
        vm.expectPartialRevert(FlashArb.NotEnoughProfit.selector);
        arb.startArb(usdc, sizes[sizes.length / 2], route, 0);
    }

    function test_RevertWhen_BelowMinProfit() public {
        FlashArb.Hop[] memory route = _gapRoute();
        Best memory best = _quoteBest(route, _usdcSizes(), true);
        assertGt(best.profit, 0);
        vm.expectPartialRevert(FlashArb.NotEnoughProfit.selector);
        arb.startArb(usdc, best.amount, route, uint256(best.profit) + 1);
    }

    function test_RevertWhen_BadRoute() public {
        // Route does not end in the borrowed token.
        FlashArb.Hop[] memory route = new FlashArb.Hop[](1);
        route[0] = _hop(V2, v2Pool, usdc, weth);
        vm.expectRevert(FlashArb.BadRoute.selector);
        arb.startArb(usdc, 100e6, route, 0);
    }

    // ------------------------------------------------------------------ shared access tests

    function test_RevertWhen_StrangerStartsArb() public {
        FlashArb.Hop[] memory route = _gapRoute();
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.startArb(usdc, 1000, route, 0);
    }

    function test_RevertWhen_StrangerStartsArbMorpho() public {
        FlashArb.Hop[] memory route = _gapRoute();
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.startArbMorpho(usdc, 1000, route, 0);
    }

    function test_RevertWhen_StrangerCallsCallbacks() public {
        vm.startPrank(stranger);
        vm.expectRevert(FlashArb.NotAavePool.selector);
        arb.executeOperation(usdc, 1, 0, address(arb), "");
        vm.expectRevert(FlashArb.NotMorpho.selector);
        arb.onMorphoFlashLoan(1, "");
        vm.expectRevert(FlashArb.BadCallback.selector);
        arb.uniswapV3SwapCallback(1, 0, "");
        vm.expectRevert(FlashArb.BadCallback.selector);
        arb.pancakeV3SwapCallback(1, 0, "");
        vm.stopPrank();
    }

    function test_RevertWhen_MorphoCallsBackOutsideOurLoan() public {
        // Even the real Morpho address cannot call the callback unless we started the loan.
        vm.prank(morpho);
        vm.expectRevert(FlashArb.BadInitiator.selector);
        arb.onMorphoFlashLoan(1, "");
    }

    function test_RevertWhen_SomeoneElseStartsAaveLoanToUs() public {
        // Aave calls executeOperation with initiator = stranger, so FlashArb rejects it.
        vm.prank(stranger);
        vm.expectRevert(FlashArb.BadInitiator.selector);
        IAavePoolF(aavePool).flashLoanSimple(address(arb), usdc, 1000, "", 0);
    }

    function test_RevertWhen_StrangerWithdraws() public {
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.withdraw(usdc, stranger, 0);
    }

    function test_OwnerCanWithdrawStuckTokens() public {
        deal(usdc, address(arb), 123e6);
        arb.withdraw(usdc, stranger, 123e6);
        assertEq(_bal(usdc, stranger), 123e6);
        assertEq(_bal(usdc, address(arb)), 0);
    }
}
