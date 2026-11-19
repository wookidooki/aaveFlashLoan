// Fork test: runs FlashArb against a local copy of live Base.
// Run: npm run test:fork   (needs network access to a Base RPC)
//
// It creates a real price gap by dumping WETH into the Uniswap v2 WETH/USDC pair,
// then checks that FlashArb captures it through each pool type, and that
// strangers cannot use or attack the contract.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { createPublicClient, createWalletClient, createTestClient, parseEther, getAddress, zeroAddress } from 'viem';
import { base } from 'viem/chains';
import { CHAINS } from '../config/chains.js';
import {
  loadArtifact, erc20Abi, wethAbi, v2FactoryAbi, v3FactoryAbi, clFactoryAbi, solidlyFactoryAbi, v2PairAbi, aavePoolAbi,
} from '../src/abis.js';
import { hop } from '../src/routes.js';
import { hardhatTransport } from './helpers.js';

const C = CHAINS.base;
const WETH = getAddress(C.tokens.WETH);
const USDC = getAddress(C.tokens.USDC);
const dex = (name) => C.dexes.find((d) => d.name === name);

const transport = hardhatTransport;
const pub = createPublicClient({ chain: base, transport });
const testClient = createTestClient({ chain: base, transport, mode: 'hardhat' });
let owner, stranger, wallet, strangerWallet;
let flashArb, quoter, premiumBps;
const pools = {};

const FlashArb = loadArtifact('FlashArb');
const ArbQuoter = loadArtifact('ArbQuoter');

async function deploy(artifact, args = []) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress;
}

async function send(w, params) {
  const hash = await w.writeContract(params);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
}

const usdcBal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

async function quoteBest(route) {
  const sizes = [100n, 500n, 1000n, 2500n, 5000n, 10000n, 25000n].map((x) => x * 10n ** 6n);
  const { result } = await pub.simulateContract({
    address: quoter, abi: ArbQuoter.abi, functionName: 'quote', args: [[route], [sizes]], account: owner,
  });
  let best = { amount: 0n, profit: -1n };
  result[0].forEach((out, i) => {
    const premium = (sizes[i] * premiumBps + 5000n) / 10000n;
    const profit = out - sizes[i] - premium;
    if (profit > best.profit) best = { amount: sizes[i], profit, out };
  });
  return best;
}

before(async () => {
  [owner, stranger] = await hre.network.provider.send('eth_accounts');
  owner = getAddress(owner);
  stranger = getAddress(stranger);
  wallet = createWalletClient({ chain: base, account: owner, transport });
  strangerWallet = createWalletClient({ chain: base, account: stranger, transport });

  flashArb = await deploy(FlashArb, [C.aavePool]);
  quoter = await deploy(ArbQuoter);
  premiumBps = BigInt(await pub.readContract({ address: C.aavePool, abi: aavePoolAbi, functionName: 'FLASHLOAN_PREMIUM_TOTAL' }));

  pools.v2 = { kind: 'v2', feeBps: 30, address: await pub.readContract({ address: dex('UniswapV2').factory, abi: v2FactoryAbi, functionName: 'getPair', args: [WETH, USDC] }) };
  pools.v3 = { kind: 'v3', address: await pub.readContract({ address: dex('UniswapV3').factory, abi: v3FactoryAbi, functionName: 'getPool', args: [WETH, USDC, 500] }) };
  pools.cl = { kind: 'cl', address: await pub.readContract({ address: dex('AerodromeCL').factory, abi: clFactoryAbi, functionName: 'getPool', args: [WETH, USDC, 100] }) };
  pools.solidly = { kind: 'solidly', address: await pub.readContract({ address: dex('Aerodrome').factory, abi: solidlyFactoryAbi, functionName: 'getPool', args: [WETH, USDC, false] }) };
  for (const [k, p] of Object.entries(pools)) assert.notEqual(p.address, zeroAddress, `${k} pool missing`);

  // Create the price gap: dump WETH into the Uniswap v2 pair so WETH is cheap there.
  const [r0, r1] = await pub.readContract({ address: pools.v2.address, abi: v2PairAbi, functionName: 'getReserves' });
  const token0 = await pub.readContract({ address: pools.v2.address, abi: v2PairAbi, functionName: 'token0' });
  const wethIs0 = getAddress(token0) === WETH;
  const [rWeth, rUsdc] = wethIs0 ? [r0, r1] : [r1, r0];
  console.log(`v2 WETH/USDC reserves: ${Number(rWeth) / 1e18} WETH, ${Number(rUsdc) / 1e6} USDC`);
  const dump = rWeth / 20n; // 5% of the pool
  await send(wallet, { address: WETH, abi: wethAbi, functionName: 'deposit', value: dump });
  await send(wallet, { address: WETH, abi: erc20Abi, functionName: 'transfer', args: [pools.v2.address, dump] });
  const inFee = dump * 997n;
  const out = (inFee * rUsdc) / (rWeth * 1000n + inFee);
  await send(wallet, { address: pools.v2.address, abi: v2PairAbi, functionName: 'swap', args: wethIs0 ? [0n, out, owner, '0x'] : [out, 0n, owner, '0x'] });
});

for (const venue of ['v3', 'cl', 'solidly']) {
  test(`captures the gap: USDC -> WETH on v2, WETH -> USDC on ${venue}`, async () => {
    const snap = await testClient.snapshot();
    try {
      const route = [hop(pools.v2, USDC, WETH), hop(pools[venue], WETH, USDC)];
      const best = await quoteBest(route);
      console.log(`  ${venue}: best size ${Number(best.amount) / 1e6} USDC, quoted profit ${Number(best.profit) / 1e6} USDC`);
      assert.ok(best.profit > 0n, 'quoter should see a profit');

      const before = await usdcBal(owner);
      await send(wallet, { address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, best.amount, route, 1n] });
      const gained = (await usdcBal(owner)) - before;
      console.log(`  ${venue}: real profit ${Number(gained) / 1e6} USDC`);
      // Aerodrome CL fees can move a little between blocks, so allow 0.5% there.
      const tolerance = venue === 'cl' ? best.profit / 200n : 0n;
      const diff = gained > best.profit ? gained - best.profit : best.profit - gained;
      assert.ok(diff <= tolerance, `real profit ${gained} should match quote ${best.profit}`);
      assert.equal(await usdcBal(flashArb), 0n, 'contract keeps nothing');
    } finally {
      await testClient.revert({ id: snap });
    }
  });
}

test('works with a WETH loan too: WETH -> USDC on v3, USDC -> WETH on v2', async () => {
  const snap = await testClient.snapshot();
  try {
    const route = [hop(pools.v3, WETH, USDC), hop(pools.v2, USDC, WETH)];
    const sizes = [1n, 2n, 5n, 10n].map((x) => parseEther('0.1') * x);
    const { result } = await pub.simulateContract({ address: quoter, abi: ArbQuoter.abi, functionName: 'quote', args: [[route], [sizes]], account: owner });
    let bi = 0;
    result[0].forEach((o, i) => { if (o - sizes[i] > result[0][bi] - sizes[bi]) bi = i; });
    const premium = (sizes[bi] * premiumBps + 5000n) / 10000n;
    const expected = result[0][bi] - sizes[bi] - premium;
    assert.ok(expected > 0n);
    const wbal = () => pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    const before = await wbal();
    await send(wallet, { address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [WETH, sizes[bi], route, 1n] });
    assert.equal((await wbal()) - before, expected);
  } finally {
    await testClient.revert({ id: snap });
  }
});

test('reverts when the trade is not profitable (only gas is lost)', async () => {
  // Wrong direction: buy WETH where it is expensive, sell where it is cheap.
  const route = [hop(pools.v3, USDC, WETH), hop(pools.v2, WETH, USDC)];
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, 1000n * 10n ** 6n, route, 0n], account: owner }),
    /NotEnoughProfit/,
  );
});

test('minProfit is enforced', async () => {
  const route = [hop(pools.v2, USDC, WETH), hop(pools.v3, WETH, USDC)];
  const best = await quoteBest(route);
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, best.amount, route, best.profit + 1n], account: owner }),
    /NotEnoughProfit/,
  );
});

test('strangers cannot start a trade', async () => {
  const route = [hop(pools.v2, USDC, WETH), hop(pools.v3, WETH, USDC)];
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, 1000n, route, 0n], account: stranger }),
    /NotOwner/,
  );
});

test('strangers cannot call executeOperation or the swap callback', async () => {
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'executeOperation', args: [USDC, 1n, 0n, flashArb, '0x'], account: stranger }),
    /NotAavePool/,
  );
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'uniswapV3SwapCallback', args: [1n, 0n, '0x'], account: stranger }),
    /BadCallback/,
  );
});

test('someone else starting an Aave flash loan to our contract is rejected', async () => {
  const aaveAbi = [{ type: 'function', name: 'flashLoanSimple', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint16' }], outputs: [] }];
  await assert.rejects(
    pub.simulateContract({ address: C.aavePool, abi: aaveAbi, functionName: 'flashLoanSimple', args: [flashArb, USDC, 1000n, '0x', 0], account: stranger }),
  );
});

test('only the owner can withdraw stuck tokens', async () => {
  await assert.rejects(
    pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'withdraw', args: [USDC, stranger, 0n], account: stranger }),
    /NotOwner/,
  );
});
