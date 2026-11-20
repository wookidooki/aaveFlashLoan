// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {FlashArb} from "../../contracts/FlashArb.sol";
import {ArbQuoter} from "../../contracts/ArbQuoter.sol";

// Fork test: runs FlashArb against a local copy of live Base.
// Run:   forge test --match-contract FlashArbForkBase -vv
// Skip:  forge test --no-match-contract Fork      (offline)
// Pin a block (faster reruns, same result each time): BASE_FORK_BLOCK=<number> forge test ...
//
// Same checks as test/fork.flasharb.test.js: create a real price gap by dumping WETH into
// the Uniswap v2 WETH/USDC pair, check FlashArb captures it through each pool type, and
// check that strangers cannot use or attack the contract.

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

contract FlashArbForkBaseTest is Test {
    // Addresses from config/chains.js (base)
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant UNI_V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address internal constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant AERO_CL_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    // Hop kinds (src/routes.js): v2 = 0, solidly = 1, v3 and cl = 2
    uint8 internal constant V2 = 0;
    uint8 internal constant SOLIDLY = 1;
    uint8 internal constant V3 = 2;

    FlashArb internal arb;
    ArbQuoter internal quoter;
    uint256 internal premiumBps;
    address internal stranger = makeAddr("stranger");

    address internal v2Pool;
    address internal v3Pool;
    address internal clPool;
    address internal solidlyPool;

    struct Best {
        uint256 amount;
        int256 profit;
    }

    function setUp() public {
        uint256 forkBlock = vm.envOr("BASE_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork("base");
        else vm.createSelectFork("base", forkBlock);

        arb = new FlashArb(AAVE_POOL, MORPHO);
        quoter = new ArbQuoter();
        premiumBps = IAavePoolF(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL();

        v2Pool = IV2FactoryF(UNI_V2_FACTORY).getPair(WETH, USDC);
        v3Pool = IV3FactoryF(UNI_V3_FACTORY).getPool(WETH, USDC, 500);
        clPool = IClFactoryF(AERO_CL_FACTORY).getPool(WETH, USDC, 100);
        solidlyPool = ISolidlyFactoryF(AERO_FACTORY).getPool(WETH, USDC, false);
        assertTrue(v2Pool != address(0), "v2 pool missing");
        assertTrue(v3Pool != address(0), "v3 pool missing");
        assertTrue(clPool != address(0), "cl pool missing");
        assertTrue(solidlyPool != address(0), "solidly pool missing");

        _createGap();
    }

    /// Dump 5% of the pool's WETH into the Uniswap v2 pair, so WETH is cheap there.
    function _createGap() internal {
        (uint112 r0, uint112 r1,) = IV2PairF(v2Pool).getReserves();
        bool wethIs0 = IV2PairF(v2Pool).token0() == WETH;
        (uint256 rWeth, uint256 rUsdc) = wethIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        console.log("v2 reserves: %e WETH, %e USDC", rWeth, rUsdc);

        address dumper = makeAddr("dumper");
        uint256 dump = rWeth / 20;
        vm.deal(dumper, dump);
        vm.startPrank(dumper);
        IWETH(WETH).deposit{value: dump}();
        IWETH(WETH).transfer(v2Pool, dump);
        uint256 inFee = dump * 997;
        uint256 out = (inFee * rUsdc) / (rWeth * 1000 + inFee);
        if (wethIs0) IV2PairF(v2Pool).swap(0, out, dumper, "");
        else IV2PairF(v2Pool).swap(out, 0, dumper, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

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

    /// Best USDC loan size for `route` with an Aave loan, and its expected profit.
    function _quoteBestUsdc(FlashArb.Hop[] memory route) internal returns (Best memory best) {
        uint256[7] memory usd = [uint256(100), 500, 1000, 2500, 5000, 10000, 25000];
        uint256[] memory sizes = new uint256[](usd.length);
        for (uint256 i; i < usd.length; ++i) sizes[i] = usd[i] * 1e6;
        uint256[] memory outs = _quote(route, sizes);
        best.profit = type(int256).min;
        for (uint256 i; i < sizes.length; ++i) {
            int256 p = int256(outs[i]) - int256(sizes[i]) - int256(_premium(sizes[i]));
            if (p > best.profit) best = Best(sizes[i], p);
        }
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20F(token).balanceOf(who);
    }

    // ------------------------------------------------------------------ profit tests

    function _capturesGap(uint8 kind, address pool, uint256 toleranceDiv) internal {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, USDC, WETH), _hop(kind, pool, WETH, USDC));
        Best memory best = _quoteBestUsdc(route);
        assertGt(best.profit, 0, "quoter should see a profit");
        console.log("best size %e USDC, quoted profit %e USDC", best.amount, uint256(best.profit));

        uint256 before = _bal(USDC, address(this));
        arb.startArb(USDC, best.amount, route, 1);
        uint256 gained = _bal(USDC, address(this)) - before;
        console.log("real profit %e USDC", gained);

        uint256 expected = uint256(best.profit);
        uint256 tolerance = toleranceDiv == 0 ? 0 : expected / toleranceDiv;
        assertApproxEqAbs(gained, expected, tolerance, "real profit should match quote");
        assertEq(_bal(USDC, address(arb)), 0, "contract keeps nothing");
    }

    function test_CapturesGap_V2ThenUniV3() public {
        _capturesGap(V3, v3Pool, 0);
    }

    function test_CapturesGap_V2ThenAerodromeCL() public {
        // Aerodrome CL fees can move a little, so allow 0.5% (same as the JS test).
        _capturesGap(V3, clPool, 200);
    }

    function test_CapturesGap_V2ThenAerodromeSolidly() public {
        _capturesGap(SOLIDLY, solidlyPool, 0);
    }

    function test_WethLoan_V3ThenV2() public {
        FlashArb.Hop[] memory route = _route(_hop(V3, v3Pool, WETH, USDC), _hop(V2, v2Pool, USDC, WETH));
        uint256[] memory sizes = new uint256[](4);
        sizes[0] = 0.1 ether;
        sizes[1] = 0.2 ether;
        sizes[2] = 0.5 ether;
        sizes[3] = 1 ether;
        uint256[] memory outs = _quote(route, sizes);
        uint256 bi;
        for (uint256 i = 1; i < sizes.length; ++i) {
            if (int256(outs[i]) - int256(sizes[i]) > int256(outs[bi]) - int256(sizes[bi])) bi = i;
        }
        int256 expected = int256(outs[bi]) - int256(sizes[bi]) - int256(_premium(sizes[bi]));
        assertGt(expected, 0, "quoter should see a profit");

        uint256 before = _bal(WETH, address(this));
        arb.startArb(WETH, sizes[bi], route, 1);
        assertEq(_bal(WETH, address(this)) - before, uint256(expected));
        assertEq(_bal(WETH, address(arb)), 0, "contract keeps nothing");
    }

    function test_MorphoLoan_NoFee() public {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, USDC, WETH), _hop(V3, v3Pool, WETH, USDC));
        uint256[] memory sizes = new uint256[](1);
        sizes[0] = 20_000e6;
        uint256 out = _quote(route, sizes)[0];
        assertGt(out, sizes[0], "quoter should see a profit");
        uint256 expected = out - sizes[0]; // no flash loan fee

        uint256 before = _bal(USDC, address(this));
        arb.startArbMorpho(USDC, sizes[0], route, 1);
        uint256 gained = _bal(USDC, address(this)) - before;
        console.log("morpho profit %e USDC (Aave fee would be %e USDC)", gained, _premium(sizes[0]));
        assertEq(gained, expected);
        assertEq(_bal(USDC, address(arb)), 0, "contract keeps nothing");
    }

    // ------------------------------------------------------------------ revert tests

    function test_RevertWhen_NotProfitable() public {
        // Wrong direction: buy WETH where it is expensive, sell where it is cheap.
        FlashArb.Hop[] memory route = _route(_hop(V3, v3Pool, USDC, WETH), _hop(V2, v2Pool, WETH, USDC));
        vm.expectPartialRevert(FlashArb.NotEnoughProfit.selector);
        arb.startArb(USDC, 1000e6, route, 0);
    }

    function test_RevertWhen_BelowMinProfit() public {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, USDC, WETH), _hop(V3, v3Pool, WETH, USDC));
        Best memory best = _quoteBestUsdc(route);
        assertGt(best.profit, 0);
        vm.expectPartialRevert(FlashArb.NotEnoughProfit.selector);
        arb.startArb(USDC, best.amount, route, uint256(best.profit) + 1);
    }

    function test_RevertWhen_BadRoute() public {
        // Route does not end in the borrowed token.
        FlashArb.Hop[] memory route = new FlashArb.Hop[](1);
        route[0] = _hop(V2, v2Pool, USDC, WETH);
        vm.expectRevert(FlashArb.BadRoute.selector);
        arb.startArb(USDC, 1000e6, route, 0);
    }

    // ------------------------------------------------------------------ access tests

    function test_RevertWhen_StrangerStartsArb() public {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, USDC, WETH), _hop(V3, v3Pool, WETH, USDC));
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.startArb(USDC, 1000, route, 0);
    }

    function test_RevertWhen_StrangerStartsArbMorpho() public {
        FlashArb.Hop[] memory route = _route(_hop(V2, v2Pool, USDC, WETH), _hop(V3, v3Pool, WETH, USDC));
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.startArbMorpho(USDC, 1000, route, 0);
    }

    function test_RevertWhen_StrangerCallsCallbacks() public {
        vm.startPrank(stranger);
        vm.expectRevert(FlashArb.NotAavePool.selector);
        arb.executeOperation(USDC, 1, 0, address(arb), "");
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
        vm.prank(MORPHO);
        vm.expectRevert(FlashArb.BadInitiator.selector);
        arb.onMorphoFlashLoan(1, "");
    }

    function test_RevertWhen_SomeoneElseStartsAaveLoanToUs() public {
        // Aave calls executeOperation with initiator = stranger, so FlashArb rejects it.
        vm.prank(stranger);
        vm.expectRevert(FlashArb.BadInitiator.selector);
        IAavePoolF(AAVE_POOL).flashLoanSimple(address(arb), USDC, 1000, "", 0);
    }

    function test_RevertWhen_StrangerWithdraws() public {
        vm.prank(stranger);
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.withdraw(USDC, stranger, 0);
    }

    function test_OwnerCanWithdrawStuckTokens() public {
        deal(USDC, address(arb), 123e6);
        arb.withdraw(USDC, stranger, 123e6);
        assertEq(_bal(USDC, stranger), 123e6);
        assertEq(_bal(USDC, address(arb)), 0);
    }
}
