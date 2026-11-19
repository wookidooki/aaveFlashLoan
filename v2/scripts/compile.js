// Compiles contracts/*.sol with solc (from npm, no download needed) into artifacts/*.json.
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('contracts');
const sources = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: fs.readFileSync(path.join(dir, f), 'utf8') };
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 1000 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync('artifacts', { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // skip interfaces
    fs.writeFileSync(
      path.join('artifacts', `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: file, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object }, null, 2),
    );
    console.log(`compiled ${name} (${c.evm.deployedBytecode.object.length / 2} bytes)`);
  }
}
