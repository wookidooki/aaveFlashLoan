# To do

Planned work, in the suggested order. It comes from the independent review (Fable 5.2) and from live tests on Base and Arbitrum in November 2026.

## 1. Must do before adding smaller tokens

- [x] **FlashArb: use the real token amounts.** Done 2026-11-20: each hop now uses the measured balance change, and a v3 swap that only partly fills reverts with `PartialFill`. At each swap, measure the balance before and after, and do not trust the computed amount. This is needed for tokens that take a fee on transfer. It also handles v3 swaps that only partly fill, which leave unused tokens behind.

## 2. Next (works with the free public links)

- [ ] **Smaller, less-known tokens.** Find pools from factory "pool created" events for hundreds of tokens paired with WETH, USDC or cbBTC on 2 or more exchanges. Lower `MIN_POOL_TVL_USD`. This needs local price math (see section 3) to handle many pools. The full trade check before each send already protects against scam tokens.
- [ ] **Measure why we lose.** For each verified chance, log:
  - how many blocks it lasted
  - the transaction that took it: its tip, its position in the block, and its sender

  This shows whether speed, tips or pool coverage is the real limit.

## 3. Faster reaction (needs your own network link, for example a free Alchemy account)

- [ ] **React to events instead of polling.** Target: under 0.2 s from a price change to a sent trade (today it is 3–5 s).
  - Base: use flashblocks (every 200 ms), or at least websocket new blocks plus Swap/Sync logs.
  - Arbitrum: use the sequencer feed.
  - Keep pool state in memory and calculate v2/v3 prices locally.
  - Keep the nonce and fees ready, and send straight to the sequencer.

## 4. Win more races

- [ ] **Cheap early check in the contract.** Before borrowing, check pool reserves or prices against expected limits. Then a lost race costs about 30–50k gas instead of 300–500k.
- [ ] **Arbitrum: focus on gaps that last several blocks** (smaller tokens). Bots that buy Timeboost priority win the races on big tokens.

## 5. More exchanges

Each one needs a new swap type in both `FlashArb.sol` and `ArbQuoter.sol`.

- [ ] Base: Uniswap v4 (can swap inside `unlock`, so no flash loan is needed)
- [ ] Arbitrum: Camelot v2 (different fee per direction), Camelot v3 (Algebra, needs `algebraSwapCallback`), Ramses
- [ ] Both: Curve, Balancer

## 6. Smaller items

- [ ] Limit trade sizes by pool depth, not only by the fixed USD list (`TRADE_SIZES_USD`)
- [ ] Check why one Arbitrum route (PancakeV3 0.01% ARB/USDT) reverted with no error data in the review
- [ ] The executor waits up to 30 s for a receipt, and the scanner on that chain pauses meanwhile. Make the wait run in the background.
- [ ] Keep a separate quote error count for each chain (it is shared now)

## Unlikely to work (do not spend time on these)

- Checking public network links for gaps on the biggest tokens. Live samples show only gaps smaller than gas.
- Mempool front-running or back-running of pending trades. Base and Arbitrum have no public mempool.
- Racing on big Arbitrum tokens without Timeboost.
- Note: most arbitrage profit on these networks is between centralized exchanges and DEXs. That needs your own money (inventory), not flash loans.
