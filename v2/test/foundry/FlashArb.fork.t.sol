// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FlashArbForkShared, IV2FactoryF, IV3FactoryF, IClFactoryF, ISolidlyFactoryF} from "./FlashArbForkShared.sol";

// Fork test: runs FlashArb against a local copy of live Base.
// Run:   forge test --match-contract FlashArbForkBase -vv
// Skip:  forge test --no-match-contract Fork      (offline)
// Pin a block (same result each time): BASE_FORK_BLOCK=<number> forge test ...
// Shared tests (WETH loan, Morpho, reverts, access) are in FlashArbForkShared.sol.

contract FlashArbForkBaseTest is FlashArbForkShared {
    // Addresses from config/chains.js (base)
    address internal constant UNI_V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address internal constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant AERO_CL_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    address internal clPool;
    address internal solidlyPool;

    function setUp() public {
        _fork("base", "BASE_FORK_BLOCK");
        aavePool = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
        morpho = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
        weth = 0x4200000000000000000000000000000000000006;
        usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

        v2Pool = IV2FactoryF(UNI_V2_FACTORY).getPair(weth, usdc);
        v3Pool = IV3FactoryF(UNI_V3_FACTORY).getPool(weth, usdc, 500);
        clPool = IClFactoryF(AERO_CL_FACTORY).getPool(weth, usdc, 100);
        solidlyPool = ISolidlyFactoryF(AERO_FACTORY).getPool(weth, usdc, false);
        assertTrue(clPool != address(0), "cl pool missing");
        assertTrue(solidlyPool != address(0), "solidly pool missing");

        _setUpShared();
    }

    function _usdcSizes() internal pure override returns (uint256[] memory s) {
        uint256[7] memory usd = [uint256(100), 500, 1000, 2500, 5000, 10000, 25000];
        s = new uint256[](usd.length);
        for (uint256 i; i < usd.length; ++i) {
            s[i] = usd[i] * 1e6;
        }
    }

    function _wethSizes() internal pure override returns (uint256[] memory s) {
        s = new uint256[](4);
        s[0] = 0.1 ether;
        s[1] = 0.2 ether;
        s[2] = 0.5 ether;
        s[3] = 1 ether;
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
}
