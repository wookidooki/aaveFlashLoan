// Shared helpers for the fork tests.
import hre from 'hardhat';
import { custom, getAddress } from 'viem';
import { erc20Abi, wethAbi, v2FactoryAbi, v2PairAbi } from '../src/abis.js';

// Hardhat reports reverts without the JSON-RPC error code viem expects, so viem cannot
// decode custom errors. Add code 3 ("execution reverted") so it can.
export const hardhatTransport = custom({
  async request(args) {
    try {
      return await hre.network.provider.request(args);
    } catch (e) {
      if (typeof e?.data === 'string' && e.data.startsWith('0x')) {
        throw Object.assign(new Error(e.message), { code: 3, data: e.data });
      }
      throw e;
    }
  },
});

// Hardhat's first test account. This key is public and only used on the local copy.
export const HARDHAT_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Makes WETH cheap on the Uniswap v2 WETH/USDC pair by dumping `share` of its WETH
 * into it (a big real swap on the local copy). Returns the pair address.
 */
export async function makeGap({ pub, wallet, owner, factory, WETH, USDC, shareDiv = 20n }) {
  const pair = await pub.readContract({ address: factory, abi: v2FactoryAbi, functionName: 'getPair', args: [WETH, USDC] });
  const [r0, r1] = await pub.readContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves' });
  const wethIs0 = getAddress(await pub.readContract({ address: pair, abi: v2PairAbi, functionName: 'token0' })) === WETH;
  const [rWeth, rUsdc] = wethIs0 ? [r0, r1] : [r1, r0];
  const dump = rWeth / shareDiv;
  const wait = async (hash) => pub.waitForTransactionReceipt({ hash });
  await wait(await wallet.writeContract({ address: WETH, abi: wethAbi, functionName: 'deposit', value: dump }));
  await wait(await wallet.writeContract({ address: WETH, abi: erc20Abi, functionName: 'transfer', args: [pair, dump] }));
  const inFee = dump * 997n;
  const out = (inFee * rUsdc) / (rWeth * 1000n + inFee);
  await wait(await wallet.writeContract({ address: pair, abi: v2PairAbi, functionName: 'swap', args: wethIs0 ? [0n, out, owner, '0x'] : [out, 0n, owner, '0x'] }));
  return { pair, rWeth, rUsdc, dump };
}
