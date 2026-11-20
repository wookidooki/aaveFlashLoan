// Fork test: FlashArb must use the real token amounts at each hop.
// Run: npm run test:fork   (needs network access to a Base RPC)
//
// - A test-only token that burns 1% of every transfer, on two new v2 pairs at
//   different prices: FlashArb must still capture the gap.
// - A test-only v3-style pool that fills only half of a swap: FlashArb must revert.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { createPublicClient, createWalletClient, createTestClient, parseAbi, parseEther, getAddress } from 'viem';
import { base } from 'viem/chains';
import { CHAINS } from '../config/chains.js';
import { loadArtifact, erc20Abi } from '../src/abis.js';
import { hop } from '../src/routes.js';
import { hardhatTransport } from './helpers.js';

const C = CHAINS.base;
const USDC = getAddress(C.tokens.USDC);
const dex = (name) => C.dexes.find((d) => d.name === name);
const factoryAbi = parseAbi(['function createPair(address,address) returns (address)', 'function getPair(address,address) view returns (address)']);
const pairMintAbi = parseAbi(['function mint(address) returns (uint256)']);

const transport = hardhatTransport;
const pub = createPublicClient({ chain: base, transport });
const testClient = createTestClient({ chain: base, transport, mode: 'hardhat' });
let owner, wallet, flashArb;

const FlashArb = loadArtifact('FlashArb');
const MockFeeToken = loadArtifact('MockFeeToken');
const MockPartialV3Pool = loadArtifact('MockPartialV3Pool');

async function deploy(artifact, args = []) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(params) {
  const hash = await wallet.writeContract(params);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success');
  return r;
}

const bal = (token, who) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

/** Creates a token/USDC pair on a v2 factory and adds liquidity. */
async function makePair(factory, token, usdcAmount, tokenAmount) {
  await send({ address: factory, abi: factoryAbi, functionName: 'createPair', args: [token, USDC] });
  const pair = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [token, USDC] });
  await send({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [pair, usdcAmount] });
  await send({ address: token, abi: MockFeeToken.abi, functionName: 'transfer', args: [pair, tokenAmount] });
  await send({ address: pair, abi: pairMintAbi, functionName: 'mint', args: [owner] });
  return pair;
}

before(async () => {
  [owner] = await hre.network.provider.send('eth_accounts');
  owner = getAddress(owner);
  wallet = createWalletClient({ chain: base, account: owner, transport });
  flashArb = await deploy(FlashArb, [C.aavePool, C.morpho]);

  // Get test USDC from Morpho, which holds plenty on Base.
  const morpho = getAddress(C.morpho);
  await testClient.impersonateAccount({ address: morpho });
  await testClient.setBalance({ address: morpho, value: parseEther('1') });
  const morphoWallet = createWalletClient({ chain: base, account: morpho, transport });
  const hash = await morphoWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [owner, 50_000n * 10n ** 6n] });
  await pub.waitForTransactionReceipt({ hash });
  await testClient.stopImpersonatingAccount({ address: morpho });
});

test('captures a gap on a fee-on-transfer token (USDC -> FEE on UniswapV2, FEE -> USDC on SushiV2)', async () => {
  const snap = await testClient.snapshot();
  try {
    const fee = await deploy(MockFeeToken, [100]); // 1% burned on every transfer
    await send({ address: fee, abi: MockFeeToken.abi, functionName: 'mint', args: [owner, parseEther('100000')] });
    // FEE is ~10% cheaper on UniswapV2 than on SushiV2.
    const cheap = await makePair(dex('UniswapV2').factory, fee, 10_000n * 10n ** 6n, parseEther('11000'));
    const dear = await makePair(dex('SushiV2').factory, fee, 10_000n * 10n ** 6n, parseEther('10000'));

    const route = [
      hop({ kind: 'v2', feeBps: 30, address: cheap }, USDC, fee),
      hop({ kind: 'v2', feeBps: 30, address: dear }, fee, USDC),
    ];
    const before = await bal(USDC, owner);
    await send({ address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, 200n * 10n ** 6n, route, 1n] });
    const gained = (await bal(USDC, owner)) - before;
    console.log(`  fee token: real profit ${Number(gained) / 1e6} USDC`);
    assert.ok(gained > 0n, 'owner should gain USDC');
    assert.equal(await bal(USDC, flashArb), 0n, 'contract keeps no USDC');
    assert.equal(await bal(fee, flashArb), 0n, 'contract keeps no fee token');
  } finally {
    await testClient.revert({ id: snap });
  }
});

test('reverts with PartialFill when a v3 pool fills only part of the swap', async () => {
  const snap = await testClient.snapshot();
  try {
    const tkn = await deploy(MockFeeToken, [0]);
    const pool = await deploy(MockPartialV3Pool, [USDC, tkn]);
    await send({ address: tkn, abi: MockFeeToken.abi, functionName: 'mint', args: [pool, parseEther('1000000')] });
    const route = [
      hop({ kind: 'v3', address: pool }, USDC, tkn),
      hop({ kind: 'v3', address: pool }, tkn, USDC),
    ];
    await assert.rejects(
      pub.simulateContract({ address: flashArb, abi: FlashArb.abi, functionName: 'startArb', args: [USDC, 1000n * 10n ** 6n, route, 0n], account: owner }),
      /PartialFill/,
    );
  } finally {
    await testClient.revert({ id: snap });
  }
});
