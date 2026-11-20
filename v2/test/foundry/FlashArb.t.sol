// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlashArb} from "../../contracts/FlashArb.sol";

/// Smoke test: no network needed. Fork tests can use vm.createSelectFork("base").
contract FlashArbTest is Test {
    FlashArb internal arb;
    address internal constant AAVE_POOL = address(0xA11CE);

    function setUp() public {
        arb = new FlashArb(AAVE_POOL, address(0));
    }

    function test_ConstructorSetsState() public view {
        assertEq(arb.owner(), address(this));
        assertEq(address(arb.aavePool()), AAVE_POOL);
        assertEq(address(arb.morpho()), address(0));
    }

    function test_RevertWhen_NotOwnerStartsArb() public {
        FlashArb.Hop[] memory hops = new FlashArb.Hop[](0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(FlashArb.NotOwner.selector);
        arb.startArb(address(1), 1, hops, 0);
    }
}
