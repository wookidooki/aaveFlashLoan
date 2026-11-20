// Accuracy check on live data (read-only, free):
// 1) Quotes 30 three-swap loops per chain at all trade sizes in batches, then re-quotes every
//    zero result on its own. A zero that is not zero on its own would be a false "no liquidity".
// 2) For every pool type, compares the quote with what FlashArb really gets (run inside
//    eth_call; the amount comes back in the NotEnoughProfit error).
// Run: node scripts/check-quotes.js
import { getAddress, encodeFunctionData, encodeDeployData, decodeErrorResult } from 'viem';
import { ChainScanner } from '../src/scanner.js';
import { CHAINS } from '../config/chains.js';
import { SETTINGS } from '../config/settings.js';
import { quoteRoutes, routeHops, quoteErrors } from '../src/quote.js';
import { hop } from '../src/routes.js';
import { loadArtifact } from '../src/abis.js';

const FA = loadArtifact('FlashArb');
const owner = getAddress('0x00000000000000000000000000000000ab0e7e03');
const at = getAddress('0x00000000000000000000000000000000ab0e7e02');

for (const key of SETTINGS.chains) {
  const s = new ChainScanner(key, CHAINS[key], SETTINGS, { log: (m) => console.log(`  [${key}] ${m}`) });
  await s.init();
  const block = await s.client.getBlockNumber();

  // 1) batch vs single quotes
  const cyc = s.cycles.filter((c) => c.legs.length === 3).slice(0, 30);
  const routes = cyc.map((c) => routeHops(c, s.pools));
  const sizes = cyc.map((c) => s.sizesFor(c.start));
  const t = Date.now();
  const outs = await quoteRoutes(s.client, routes, sizes, block);
  const ms = Date.now() - t;
  let zeros = 0;
  let falseZeros = 0;
  for (let i = 0; i < routes.length; i++) {
    for (let j = 0; j < sizes[i].length; j++) {
      if (outs[i][j] !== 0n) continue;
      zeros++;
      const [[single]] = await quoteRoutes(s.client, [routes[i]], [[sizes[i][j]]], block);
      if (single !== 0n) falseZeros++;
    }
  }
  console.log(`${key}: ${outs.flat().length} quotes in ${ms} ms | ${zeros} zero | ${falseZeros} false zeros | quote errors ${quoteErrors.count}`);

  // 2) quote vs real execution, one pool of each DEX
  const { data: code } = await s.client.call({
    account: owner,
    data: encodeDeployData({ abi: FA.abi, bytecode: FA.bytecode, args: [s.cfg.aavePool, s.cfg.morpho ?? '0x0000000000000000000000000000000000000000'] }),
  });
  const seenDex = new Set();
  for (const p of [...s.pools].sort((a, b) => b.tvlUsd - a.tvlUsd)) {
    if (seenDex.has(p.dex)) continue;
    const other = s.pools.find((q) => q.dex !== p.dex && q.token0 === p.token0 && q.token1 === p.token1);
    const a = s.lenders.morpho.has(p.token0) ? p.token0 : s.lenders.morpho.has(p.token1) ? p.token1 : null;
    if (!other || !a) continue;
    seenDex.add(p.dex);
    const b = a === p.token0 ? p.token1 : p.token0;
    const route = [hop(p, a, b), hop(other, b, a)];
    const amt = s.sizesFor(a)[1];
    const [[q]] = await quoteRoutes(s.client, [route], [[amt]], block);
    let real;
    try {
      await s.client.call({
        account: owner, to: at, gas: 30_000_000n, blockNumber: block,
        data: encodeFunctionData({ abi: FA.abi, functionName: 'startArbMorpho', args: [a, amt, route, 0n] }),
        stateOverride: [{ address: at, code }],
      });
      real = 'profitable (no amount returned)';
    } catch (e) {
      let x = e;
      while (x && typeof x.data !== 'string') x = x.cause;
      const d = x ? decodeErrorResult({ abi: FA.abi, data: x.data }) : null;
      real = d?.errorName === 'NotEnoughProfit' ? d.args[0] : d?.errorName ?? 'unknown error';
    }
    console.log(`  ${s.sym(a)} -> ${s.sym(b)} [${p.label}] -> ${s.sym(a)} [${other.label}]: quote ${q} | real ${real} | ${q === real ? 'MATCH' : 'DIFFERENT'}`);
  }
}
process.exit(0);
