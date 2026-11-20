// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FlashArbForkShared, IV2FactoryF, IV3FactoryF} from "./FlashArbForkShared.sol";

// Fork test: runs FlashArb against a local copy of live Arbitrum.
// Run:   forge test --match-contract FlashArbForkArbitrum -vv
// Skip:  forge test --no-match-contract Fork      (offline)
// Pin a block (same result each time): ARBITRUM_FORK_BLOCK=<number> forge test ...
// Shared tests (WETH loan, Morpho, reverts, access) are in FlashArbForkShared.sol.
//
// Arbitrum has no Aerodrome. Instead this covers Sushi v3, PancakeSwap v3 (it calls
// pancakeV3SwapCallback, not uniswapV3SwapCallback) and a v2 -> v2 route.
// The v2 WETH/USDC pairs here are small, so the gap and the trade sizes are small too.

contract FlashArbForkArbitrumTest is FlashArbForkShared {
    // Addresses from config/chains.js (arbitrum)
    address internal constant UNI_V2_FACTORY = 0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9;
    address internal constant SUSHI_V2_FACTORY = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    address internal constant UNI_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant SUSHI_V3_FACTORY = 0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e;
    address internal constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;

    address internal sushiV2Pool;
    address internal sushiV3Pool;
    address internal pancakeV3Pool;

    function setUp() public {
        _fork("arbitrum", "ARBITRUM_FORK_BLOCK");
        aavePool = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        morpho = 0x6c247b1F6182318877311737BaC0844bAa518F5e;
        weth = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
        usdc = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native USDC, not USDC.e

        v2Pool = IV2FactoryF(UNI_V2_FACTORY).getPair(weth, usdc);
        v3Pool = IV3FactoryF(UNI_V3_FACTORY).getPool(weth, usdc, 500);
        sushiV2Pool = IV2FactoryF(SUSHI_V2_FACTORY).getPair(weth, usdc);
        sushiV3Pool = IV3FactoryF(SUSHI_V3_FACTORY).getPool(weth, usdc, 500);
        pancakeV3Pool = IV3FactoryF(PANCAKE_V3_FACTORY).getPool(weth, usdc, 500);
        assertTrue(sushiV2Pool != address(0), "sushi v2 pool missing");
        assertTrue(sushiV3Pool != address(0), "sushi v3 pool missing");
        assertTrue(pancakeV3Pool != address(0), "pancake v3 pool missing");

        _setUpShared();
    }

    function _usdcSizes() internal pure override returns (uint256[] memory s) {
        uint256[7] memory usd = [uint256(25), 50, 100, 250, 500, 1000, 2500];
        s = new uint256[](usd.length);
        for (uint256 i; i < usd.length; ++i) s[i] = usd[i] * 1e6;
    }

    function _wethSizes() internal pure override returns (uint256[] memory s) {
        s = new uint256[](4);
        s[0] = 0.01 ether;
        s[1] = 0.05 ether;
        s[2] = 0.1 ether;
        s[3] = 0.25 ether;
    }

    function test_CapturesGap_V2ThenUniV3() public {
        _capturesGap(V3, v3Pool, 0);
    }

    function test_CapturesGap_V2ThenSushiV3() public {
        _capturesGap(V3, sushiV3Pool, 0);
    }

    function test_CapturesGap_V2ThenPancakeV3() public {
        _capturesGap(V3, pancakeV3Pool, 0);
    }

    function test_CapturesGap_V2ThenSushiV2() public {
        _capturesGap(V2, sushiV2Pool, 0);
    }
}
