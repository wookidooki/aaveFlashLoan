// Deploys FlashArb to one chain from the wallet in PRIVATE_KEY.
// Run: npm run deploy -- base     (or arbitrum)
import 'dotenv/config';
import { createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from '../config/chains.js';
import { makeClient, makeTransport, viemChain } from '../src/chain.js';
import { loadArtifact } from '../src/abis.js';

const key = process.argv[2];
const cfg = CHAINS[key];
if (!cfg) {
  console.error(`Usage: npm run deploy -- <${Object.keys(CHAINS).join('|')}>`);
  process.exit(1);
}
if (!process.env.PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY in .env first.');
  process.exit(1);
}

const pk = process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`;
const account = privateKeyToAccount(pk);
const client = makeClient(key, cfg);
const wallet = createWalletClient({ account, chain: viemChain(cfg), transport: makeTransport(key, cfg) });
const FlashArb = loadArtifact('FlashArb');

const bal = await client.getBalance({ address: account.address });
console.log(`${cfg.name}: deploying from ${account.address} (balance ${Number(bal) / 1e18} ETH)`);
const hash = await wallet.deployContract({ abi: FlashArb.abi, bytecode: FlashArb.bytecode, args: [cfg.aavePool] });
console.log(`tx ${hash}, waiting...`);
const r = await client.waitForTransactionReceipt({ hash });
if (r.status !== 'success') {
  console.error('Deploy failed.');
  process.exit(1);
}
console.log(`\nFlashArb deployed at ${r.contractAddress}\nAdd this to .env:\nFLASH_ARB_${key.toUpperCase()}=${r.contractAddress}`);
