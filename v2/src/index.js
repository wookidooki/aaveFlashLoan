// Start: npm run scan
// Watches every chain in CHAINS (default: base,arbitrum) at the same time, forever.
import 'dotenv/config';
import { CHAINS } from '../config/chains.js';
import { SETTINGS } from '../config/settings.js';
import { ChainScanner } from './scanner.js';

console.log(`Flash loan arbitrage scanner | mode: ${SETTINGS.live ? 'LIVE (real trades)' : 'WATCH ONLY (no trades)'} | chains: ${SETTINGS.chains.join(', ')}`);
console.log(`Checks loops of up to ${SETTINGS.maxHops} swaps, pools >= $${SETTINGS.minPoolTvlUsd}, reports profit >= $${SETTINGS.minProfitUsd} after fees and gas.\n`);

const scanners = SETTINGS.chains.map((key) => {
  if (!CHAINS[key]) throw new Error(`Unknown chain "${key}". Known: ${Object.keys(CHAINS).join(', ')}`);
  return new ChainScanner(key, CHAINS[key], SETTINGS);
});

process.on('SIGINT', () => {
  console.log('\nStopping. Summary:');
  for (const s of scanners) if (s.aave) s.status();
  process.exit(0);
});

await Promise.all(scanners.map((s) => s.run()));
