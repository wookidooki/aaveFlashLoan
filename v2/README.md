# Flash Loan Arbitrage Bot (v2)

A bot that watches many networks, exchanges and token pairs **all the time** for price gaps. When it finds a gap that is profitable after all fees, it can borrow the money with a **flash loan**, do the trades, pay the loan back, and keep the profit. All of this happens in one transaction.

- **Networks:** Base and Arbitrum (you can add more in `config/chains.js`)
- **Exchanges:** Uniswap v2/v3, SushiSwap v2/v3, PancakeSwap v2/v3, Aerodrome, Aerodrome Slipstream, BaseSwap
- **Flash loans:** **Morpho Blue (no fee)** when it holds enough of the token, otherwise **Aave v3 (0.05% fee)**. The bot picks the cheaper one for each trade.
- **Trades:** every loop of 2 or 3 swaps that starts and ends with a token it can borrow (about 10,000 loops per block)

## Read this first

- **Profit is not likely.** Professional bots compete for the same gaps, and most gaps close within one block. Run the bot in watch-only mode first and see how often it finds real chances.
- **If a trade is not profitable, the contract cancels the whole trade.** You then lose only the gas fee (a few cents on Base and Arbitrum).
- **Watch-only mode is free.** It needs no wallet, and it never sends a transaction.

## Setup

You need Node.js 20 or newer.

```bash
cd v2
npm install          # also compiles the contracts
cp .env.example .env # then edit .env if you want
```

## Watch only (free, no wallet)

```bash
npm run scan
```

Every 30 seconds, each network prints a status line like this:

```
[Base] block 59689478 | 33 blocks checked (66 ms each) | best loop now -0.052% | best seen -0.008% |
       loops with a gap: 0 | profitable after fees: 0 quoted, 0 verified
[Base]   best loop now: USDC -> USDT [PancakeV3 0.01%] -> USDC [AerodromeCL ts1]
```

- **best loop now:** the best loop at this block, after swap fees and the Aave fee. A negative value means no profit.
- **quoted:** a loop made a profit in an exact price check.
- **verified:** the full trade (flash loan + swaps + repay) was run as a free simulation and made a profit after gas.

Each verified chance is printed with `*** OPPORTUNITY` and saved in `logs/opportunities-<network>.jsonl`. Leave the bot running for a day or more, then look at this file to see how often real chances come.

## Tests

```bash
npm test          # math tests, offline
npm run test:fork # contract + full bot on a local copy of Base (needs internet, ~10 min)
```

The fork test creates a real price gap on a local copy of Base. It then checks that the bot finds the gap, checks it, trades it, and that the wallet gets the profit.

## Going live (real trades)

Only do this after watch-only mode shows verified chances.

1. **Make a NEW wallet** and use it only for this bot. Put a small amount of ETH on Base and/or Arbitrum to pay gas (about $5–10 is enough to start).
2. **Add the key:** put the wallet's private key in `.env` as `PRIVATE_KEY=0x...`. Never share this file.
3. **Deploy the contract** on each network:
   ```bash
   npm run deploy -- base
   npm run deploy -- arbitrum
   ```
   Then copy the printed `FLASH_ARB_BASE=...` and `FLASH_ARB_ARBITRUM=...` lines into `.env`.
4. **Turn on live mode:** set `LIVE=true` in `.env`, then run `npm run scan`.

Safety limits (set them in `.env`):

| Setting | Default | What it does |
|---|---|---|
| `MAX_GAS_USD_PER_TRADE` | 0.5 | Skips a trade if its gas costs more than this |
| `MAX_GAS_USD_PER_DAY` | 5 | Stops trading for the day after this much gas |
| `MAX_FAILS_IN_A_ROW` | 5 | Stops trading after this many failed trades in a row |
| `MIN_PROFIT_SHARE` | 0.5 | The contract cancels the trade if it gets less than 50% of the expected profit |

The contract only lets **your wallet** start trades, and it sends the profit straight to your wallet. It holds no money between trades.

## Faster, more reliable data (recommended later)

The free public network links have rate limits. A free account at Alchemy or Infura gives you your own link. Put it in `.env`:

```
RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## Add tokens, exchanges or networks

Edit `config/chains.js`, then run:

```bash
npm run verify-config # checks every address on-chain
```

## How it works

1. **Find pools:** for every token pair and exchange, ask the exchange's factory contract for its pools. The result is saved in `cache/`.
2. **Cheap filter (every block):** read the price of every pool in one call. Then multiply the rates around each loop. If the result is not above 1 + fees, the loop can never make money, so it is skipped.
3. **Exact quote:** price the best loops at several trade sizes with `contracts/ArbQuoter.sol`. This contract is never deployed. It runs inside a free `eth_call` with "state override".
4. **Full check:** run the real `FlashArb` trade the same way, including the flash loan (Morpho or Aave), every swap and the repayment. Then subtract gas.
5. **Trade (live mode only):** simulate once more with your deployed contract, then send the transaction.

## Files

| File | What it is |
|---|---|
| `contracts/FlashArb.sol` | The contract that does the trade |
| `contracts/ArbQuoter.sol` | The free price checker (never deployed) |
| `config/chains.js` | Networks, tokens and exchanges |
| `config/settings.js` | Scanner settings (all can be set in `.env`) |
| `src/scanner.js` | The main loop for one network |
| `src/graph.js` | Loop math (rates, loops, USD prices) |
| `src/quote.js` | Exact quotes and full trade checks |
| `src/executor.js` | Sends real trades, with safety limits |
| `scripts/deploy.js` | Deploys FlashArb |
