// Health check on live data: quotes one WETH/USDC loop per chain at 3 sizes and runs
// the full flash loan trade (Aave and Morpho) inside eth_call. Expect small losses (fees)
// and NotEnoughProfit, which shows the whole flash loan path ran.
// Run after the scanner has made its pool cache: node scripts/live-check.js
import { getAddress } from 'viem';
import { makeClient } from '../src/chain.js';
import { quoteRoutes, simulateArb } from '../src/quote.js';
import { hop } from '../src/routes.js';
import { CHAINS } from '../config/chains.js';
import fs from 'node:fs';
for (const key of ['base', 'arbitrum']) {
  const cfg = CHAINS[key]; const c = makeClient(key, cfg);
  const pools = JSON.parse(fs.readFileSync(new URL(`../cache/pools-${key}.json`, import.meta.url))).pools;
  const W = getAddress(cfg.tokens.WETH), U = getAddress(cfg.tokens.USDC);
  const isPair = (p) => (p.token0 === W && p.token1 === U) || (p.token0 === U && p.token1 === W);
  const pick = (dex, extra = () => true) => pools.find((p) => p.dex === dex && isPair(p) && extra(p));
  const a = pick('UniswapV3', (p) => p.fee === 500);
  const b = key === 'base' ? pick('Aerodrome', (p) => !p.stable) : pick('SushiV2');
  const block = await c.getBlockNumber();
  const route = [hop(a, U, W), hop(b, W, U)];
  const sizes = [100n, 1000n, 10000n].map((x) => x * 10n ** 6n);
  const [outs] = await quoteRoutes(c, [route], [sizes], block);
  console.log(`${cfg.name}: USDC -> WETH [${a.label}] -> USDC [${b.label}]`);
  sizes.forEach((s, i) => console.log(`  in ${Number(s) / 1e6} USDC -> out ${Number(outs[i]) / 1e6} USDC (${((Number(outs[i]) / Number(s) - 1) * 100).toFixed(3)}%)`));
  for (const source of ['aave', 'morpho']) {
    const sim = await simulateArb(c, cfg, source, U, 1000n * 10n ** 6n, route, block);
    console.log(`  full trade check with ${source} flash loan:`, sim);
  }
}
