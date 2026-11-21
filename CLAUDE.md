# CLAUDE.md

## Goal

A flash-loan-funded arbitrage bot. Morpho Blue flash loans (no fee) supply the trading principal;
the operator's own funds cover gas only. Aave v3 is used only as the price oracle (an Aave lender
mode is kept for comparison: `lender` in `config/scan.json`). Each candidate is one atomic round trip on one chain that borrows an asset and ends
in that same asset. The aim is to measure whether repeatable net profit exists after all costs
(any trade with positive net after all costs qualifies — `minNetUsd` in `config/scan.json`;
longer-term target: $100/day). A scan that finds nothing is a valid
result.

**Live execution is disabled and must stay disabled until the operator explicitly authorizes it.**
Do not add wallet clients, private keys, signing or transaction sending to `bot/` without that
authorization.

## Two separate codebases

| Path | What | Status |
|---|---|---|
| `bot/` | The new bot: local proof (Hardhat 3), read-only multi-chain scanner, operator dashboard, reports | Active |
| everything else (`arbBot.js`, `UniSwapSetUp.js`, `contracts/`, `migrations/`, `test/`, `client/`, `truffle-config.js`) | 2019 Truffle hackathon project targeting Kovan (Aave v1, custom Uniswap v1 in Vyper 0.1.0b4) | Historical — keep intact, do not modify |

- `client/src/contracts/*.json` are committed Truffle build artifacts. `bot/` reads the Vyper
  exchange and factory bytecode from them, so do not delete or regenerate them.
- The historical receiver (`contracts/FlashLoanReceiverArb.sol`) cannot work: its first swap passes
  `min_eth = 0`, which the exchange rejects (`contracts/uniswap_exchange_custom.vy:206`), and nothing
  stops pre-existing DAI from paying for a losing trade. `bot/` replaces it; it does not patch it.

## Safe commands (run from `bot/`, Node 24 — see `bot/.nvmrc`)

```bash
npm ci                 # install exact pinned versions from package-lock.json
npm run compile        # hardhat build
npm test               # local-only tests on an in-process chain; no network, no keys
npm run typecheck      # build + tsc --noEmit
npm run scan -- --minutes 10 --chains arbitrum,base   # read-only: eth_call only, no transactions
npm run verify         # read-only: simulate one live route through every venue; proceeds must equal quotes
npm run replay -- --session ID   # read-only: re-quote each opportunity block by block to measure its lifetime
npm run competitors -- --minutes 60   # read-only: other bots' round trips through watched pools, profit and timing
npm run dashboard      # operator view at http://127.0.0.1:8787 (read-only)
npm run report -- --date YYYY-MM-DD                   # writes data/reports/
```

The scanner only reads chain state (eth_call, including the receiver's `simulate()` with a code
override). It holds no keys and cannot send transactions.

In the Claude Code cloud container, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to use the HTTPS
proxy (the npm scripts set it).

## Never run (historical)

- `truffle test` or anything in the root `test/`: `test/testAave.js`, `test/testUniSwap.js` and
  `test/testKyber.js` sign and broadcast transactions as soon as they load.
- `node arbBot.js` / `node UniSwapSetUp.js`: hard-coded Kovan addresses; Kovan no longer exists.

## Layout of `bot/`

- `contracts/fixture/` — Aave-v1-style local proof: `MockAaveV1LendingPool` (mirrors the vendored
  v1 flashLoan rules), `FixtureArbReceiver`, `MockDAI`. Tests run the historical Vyper bytecode.
- `contracts/live/ArbReceiverBase.sol` — shared receiver core (route checks, legs, callbacks);
  `FlashArbReceiverMorpho.sol` (default lender, zero fee) and `FlashArbReceiverV3.sol` (Aave v3)
  add only the borrow/repay step. Leg kinds: Uniswap-v3-style and Pancake callbacks, Algebra, v2 pairs, `getAmountOut` pools, and
  Uniswap v4 (hookless only; native ETH via WETH unwrap/wrap).
- `contracts/live/CLQuoter.sol`, `contracts/live/CappedMulticall.sol` — never deployed; injected by
  eth_call state override to quote concentrated pools without a verified quoter, and to give every
  quote its own gas cap.
- `contracts/mocks/` — test doubles for the v3 receiver tests.
- `src/` — scanner (`scanner.ts`), venue adapters (`venues.ts`), Aave reads (`aave.ts`), gas and L1
  fees (`gas.ts`), exact quote math (`quote/`), simulation encode/decode (`sim/`), ledger, report,
  dashboard, CLI.
- `config/scan.json` — chains, assets, pairs, venues, loan sizes, thresholds. Add coverage here.
- `data/` — runtime output (ledger, sessions, reports). Gitignored; never commit scan results.

## Conventions

- Exact integer math (bigint) wherever an on-chain formula is mirrored; quotes come from each
  venue's own quoter or pool math, so pool fees and price impact are never added again as costs.
- All reads for one cycle on one chain use a single block number.
- Pin exact dependency versions (`--save-exact`), and prefer releases at least two weeks old.
- Keep temporary findings and scan results out of this file.
