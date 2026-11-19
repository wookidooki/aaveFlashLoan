// Checks that every address in config/chains.js has contract code, and that
// each DEX factory answers the call the scanner will use. Run: node scripts/verify-config.js
import { parseAbi, getAddress } from 'viem';
import { CHAINS } from '../config/chains.js';
import { makeClient } from '../src/chain.js';

const probe = {
  v2: parseAbi(['function allPairsLength() view returns (uint256)']),
  solidly: parseAbi(['function allPoolsLength() view returns (uint256)']),
  v3: parseAbi(['function owner() view returns (address)']),
  cl: parseAbi(['function owner() view returns (address)']),
};
const fn = { v2: 'allPairsLength', solidly: 'allPoolsLength', v3: 'owner', cl: 'owner' };

let bad = 0;
for (const [key, c] of Object.entries(CHAINS)) {
  const client = makeClient(key, c);
  const id = await client.getChainId();
  console.log(`\n== ${c.name} (chain id ${id}${id !== c.id ? ' MISMATCH' : ''})`);
  const check = async (label, addr) => {
    const code = await client.getCode({ address: getAddress(addr) });
    const ok = code && code !== '0x';
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'NO CODE'}  ${label.padEnd(18)} ${addr}`);
    return ok;
  };
  await check('multicall3', c.multicall3);
  await check('aavePool', c.aavePool);
  for (const [sym, a] of Object.entries(c.tokens)) await check(sym, a);
  for (const d of c.dexes) {
    if (!(await check(d.name, d.factory))) continue;
    try {
      const r = await client.readContract({ address: d.factory, abi: probe[d.kind], functionName: fn[d.kind] });
      console.log(`     ${fn[d.kind]} -> ${r}`);
    } catch (e) { bad++; console.log(`     ${fn[d.kind]} FAILED: ${e.shortMessage || e.message}`); }
  }
}
console.log(bad ? `\n${bad} problem(s) found` : '\nAll addresses OK');
