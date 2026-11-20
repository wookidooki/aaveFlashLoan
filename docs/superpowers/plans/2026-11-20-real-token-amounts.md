# FlashArb real token amounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FlashArb uses measured token amounts at every hop, and reverts on a v3 partial fill.

**Architecture:** `_swap` measures our `tokenOut` balance before and after each hop. v2/Solidly hops send first, then price from `pool balance - reserve`. v3 hops revert with `PartialFill` if the pool took less than `amountIn`.

**Tech Stack:** Solidity 0.8.28 (solc via npm), Hardhat fork of Base, viem, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-20-real-token-amounts-design.md`

**Execution:** native (user said go ahead; one contract, two tasks).

## Global Constraints

- No change to `ArbQuoter.sol` or the off-chain code.
- All 11 existing fork tests in `v2/test/fork.flasharb.test.js` stay green.

## Review Focus

- v2 pair `getReserves` returns uint112s, Aerodrome returns uint256s: one decode must work for both (covered by the existing solidly test).
- Existing exact-profit asserts (v3, solidly, WETH loan, Morpho) must still match to the wei.
- Contract keeps no fee token after a fee-token route (assert balance 0).

---

### Task 1: Fee-on-transfer token routes

**Files:**
- Create: `v2/test/contracts/MockFeeToken.sol` — ERC20, `constructor(uint16 feeBps)`, `mint(address,uint256)`, burns `feeBps` of every transfer.
- Modify: `v2/scripts/compile.js` — also compile `test/contracts/*.sol`.
- Modify: `v2/contracts/FlashArb.sol` — `_swap`.
- Test: `v2/test/fork.feetoken.test.js`

- [ ] Write test `captures a gap on a fee-on-transfer token (USDC -> FEE on UniswapV2, FEE -> USDC on SushiV2)`: 1% fee token, two new pairs (FEE cheap on UniswapV2), `startArb(USDC, 1000e6, route, 1)` succeeds, owner gains > 0 USDC, contract holds 0 USDC and 0 FEE.
- [ ] Run it: fails (pair rejects the swap).
- [ ] Change `_swap`: measure `tokenOut` balance delta for every kind; v2/Solidly send first, `realIn = balanceOf(pool) - reserveIn`, price from `realIn`.
- [ ] Run the new test and all fork tests: pass.
- [ ] Commit.

### Task 2: v3 partial fill reverts

**Files:**
- Create: `v2/test/contracts/MockPartialV3Pool.sol` — `swap` asks the callback for half of `amountSpecified`, sends the same amount of the other token.
- Modify: `v2/contracts/FlashArb.sol` — `error PartialFill();`, check in the v3 branch.
- Test: `v2/test/fork.feetoken.test.js`

- [ ] Write test `reverts with PartialFill when a v3 pool fills only part of the swap`: route `[v3 mock USDC -> TKN, any hop back]`, `simulateContract startArb` rejects `/PartialFill/`.
- [ ] Run it: fails (other error or no revert).
- [ ] Add the check: input paid by us (`zeroForOne ? a0 : a1`) must equal `amountIn`.
- [ ] Run all fork tests: pass.
- [ ] Commit, then mark TODO item 1 done.
