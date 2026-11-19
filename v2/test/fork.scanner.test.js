// End-to-end test of the whole bot on a local copy of live Base:
// create a real price gap -> scanner finds it -> full check passes -> live mode trades it
// with a deployed FlashArb -> the owner wallet receives the profit.
// Run: npm run test:fork
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import hre from 'hardhat';
import { createPublicClient, createWalletClient, getAddress } from 'viem';
import { base } from 'viem/chains';
import { CHAINS } from '../config/chains.js';
import { SETTINGS } from '../config/settings.js';
import { ChainScanner } from '../src/scanner.js';
import { loadArtifact, erc20Abi } from '../src/abis.js';
import { hardhatTransport, HARDHAT_KEY_0, makeGap } from './helpers.js';

const C = CHAINS.base;
const WETH = getAddress(C.tokens.WETH);
const USDC = getAddress(C.tokens.USDC);

test('scanner finds, checks and trades a real gap on a Base copy', async () => {
  const pub = createPublicClient({ chain: base, transport: hardhatTransport });
  const [ownerRaw] = await hre.network.provider.send('eth_accounts');
  const owner = getAddress(ownerRaw);
  const wallet = createWalletClient({ chain: base, account: owner, transport: hardhatTransport });

  // State override only works on blocks made after the copy, so mine one first.
  await hre.network.provider.send('evm_mine');

  const gap = await makeGap({ pub, wallet, owner, factory: C.dexes.find((d) => d.name === 'UniswapV2').factory, WETH, USDC });
  console.log(`gap made: dumped ${Number(gap.dump) / 1e18} WETH into Uniswap v2 WETH/USDC`);

  const FlashArb = loadArtifact('FlashArb');
  const hash = await wallet.deployContract({ abi: FlashArb.abi, bytecode: FlashArb.bytecode, args: [C.aavePool] });
  const contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  process.env.PRIVATE_KEY = HARDHAT_KEY_0;
  process.env.FLASH_ARB_BASE = contract;

  const logs = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-logs-'));
  const scanner = new ChainScanner(
    'base',
    C,
    // Big pools only (>= $500k) to keep the test fast: each pool is loaded over the network.
    { ...SETTINGS, live: true, discoveryMaxAgeHours: 1e6, minProfitUsd: 1, maxGasUsdPerTrade: 5, minPoolTvlUsd: 500_000 },
    { client: pub, transport: hardhatTransport, logDir, log: (m) => { logs.push(m); console.log(`  | ${m}`); } },
  );
  await scanner.init();
  assert.ok(scanner.executor?.ready, `executor should be ready: ${scanner.executor?.why}`);

  const assets = [...scanner.aave.available.keys()];
  const bal = (a) => pub.readContract({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const before = await Promise.all(assets.map(bal));

  await scanner.tick();
  scanner.status();
  const { quoteErrors } = await import('../src/quote.js');
  console.log('quote errors:', quoteErrors);

  assert.ok(scanner.stats.verified >= 1, 'scanner should verify at least one opportunity');
  assert.ok(logs.some((l) => l.includes('*** OPPORTUNITY')), 'should log the opportunity');
  assert.ok(logs.some((l) => l.includes('live: SUCCESS')), 'should send a successful trade');

  const after = await Promise.all(assets.map(bal));
  const gained = assets.filter((a, i) => after[i] > before[i]);
  assert.ok(gained.length >= 1, 'owner should receive profit');
  for (const a of gained) {
    const i = assets.indexOf(a);
    console.log(`profit received: ${scanner.usd(a, after[i] - before[i]).toFixed(2)} USD in ${scanner.sym(a)}`);
  }

  const lines = fs.readFileSync(path.join(logDir, 'opportunities-base.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1, 'opportunity should be written to the log file');
});
