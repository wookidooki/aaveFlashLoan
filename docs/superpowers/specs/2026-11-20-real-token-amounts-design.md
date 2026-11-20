# FlashArb: use real token amounts — design

Approved 2026-11-20. Small change.

## Why

FlashArb trusts computed swap amounts. Tokens with a fee on transfer break this, so we
miss trades on smaller tokens (TODO item 1, needed before adding smaller tokens).
No money is at risk today: the executor simulates every trade first.

## Goals

- v2 and Aerodrome (Solidly) hops: price the swap from what the pool really received
  (pool balance minus its reserve), after we send the tokens.
- Every hop: the amount passed to the next hop is our real balance change of the
  output token.
- Final check: the real amount out is compared with loan + fee + minProfit.
- v3 hop that only partly fills: revert with `PartialFill` (choice A).

## Non-goals

- Fee-on-transfer tokens on v3 pools (v3 itself rejects them).
- Fee-on-transfer tokens as the borrowed asset (Aave and Morpho do not list them).
- Changes to ArbQuoter (the executor's pre-send simulation already catches gaps).

## Approaches

- **A. Revert on a v3 partial fill (picked).** Rare (pool out of liquidity), keeps the
  contract empty, simple.
- B. Continue with what filled and leave the rest in the contract. Rejected: leaves
  tokens behind that need a manual withdraw.

## Tests (written first)

- Fork test: a test-only fee-on-transfer token, two v2-style pools at different
  prices, route USDC -> FEE -> USDC. Fails before the fix, passes after.
- Fork test: a test-only v3-style pool that fills only part of the swap ->
  `PartialFill`.
- All existing fork tests still pass.

## Builder's calls

- Test-only contracts live in `v2/test/contracts/` and are compiled with the main ones,
  so production artifacts stay the same.
