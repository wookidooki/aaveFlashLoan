// Hardhat is used only as a local copy ("fork") of a live network for tests.
// Contracts are compiled by scripts/compile.js, so run tests with --no-compile.
const forkUrl = process.env.FORK_URL || 'https://mainnet.base.org';
module.exports = {
  solidity: '0.8.28',
  networks: {
    hardhat: {
      hardfork: 'cancun',
      chainId: Number(process.env.FORK_CHAIN_ID || 8453),
      forking: { url: forkUrl },
    },
  },
  mocha: { timeout: 600000 },
};
