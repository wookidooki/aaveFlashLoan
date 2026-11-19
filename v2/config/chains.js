// Chain settings: network links (RPCs), Aave v3 pool, tokens and DEX factories.
// Every address here is checked on-chain at start-up (see scripts/verify-config.js).
// To add a network, DEX or token, add it here. Nothing else needs to change.
//
// DEX kinds:
//   v2      - Uniswap v2 style pair (x*y=k). feeBps = swap fee in 1/10000.
//   solidly - Aerodrome / Velodrome v2 style pool (volatile + stable). Fee read on-chain.
//   v3      - Uniswap v3 style pool (Uniswap, Sushi, PancakeSwap). feeTiers in 1/1000000.
//   cl      - Aerodrome Slipstream (v3 style, pools found by tick spacing). Fee read on-chain.

export const CHAINS = {
  base: {
    id: 8453,
    name: 'Base',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', // Morpho Blue: flash loans with no fee
    nativeWrapped: '0x4200000000000000000000000000000000000006', // WETH, used to price gas
    usdAnchor: 'USDC', // token valued at $1; all other USD prices are derived from pools
    gas: { base: 160000, perHop: 110000, l1FeeUsd: 0.01 }, // rough gas use, for the profit filter only
    tokens: {
      WETH: '0x4200000000000000000000000000000000000006',
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
      DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
      wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
      weETH: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
      cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    },
    dexes: [
      { name: 'UniswapV3', kind: 'v3', factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', feeTiers: [100, 500, 3000, 10000] },
      { name: 'SushiV3', kind: 'v3', factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', feeTiers: [100, 500, 3000, 10000] },
      { name: 'PancakeV3', kind: 'v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', feeTiers: [100, 500, 2500, 10000] },
      { name: 'AerodromeCL', kind: 'cl', factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', tickSpacings: [1, 50, 100, 200, 2000] },
      { name: 'Aerodrome', kind: 'solidly', factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
      { name: 'UniswapV2', kind: 'v2', factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', feeBps: 30 },
      { name: 'SushiV2', kind: 'v2', factory: '0x71524B4f93c58fcbF659783284E38825f0622859', feeBps: 30 },
      { name: 'PancakeV2', kind: 'v2', factory: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E', feeBps: 25 },
      { name: 'BaseSwap', kind: 'v2', factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB', feeBps: 25 },
    ],
  },

  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    morpho: '0x6c247b1F6182318877311737BaC0844bAa518F5e', // Morpho Blue
    nativeWrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdAnchor: 'USDC',
    gas: { base: 160000, perHop: 110000, l1FeeUsd: 0.01 },
    tokens: {
      WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
      USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
      ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      wstETH: '0x5979D7b546E38E414F7E9822514be443A4800529',
      LINK: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
      GMX: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    },
    dexes: [
      { name: 'UniswapV3', kind: 'v3', factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', feeTiers: [100, 500, 3000, 10000] },
      { name: 'SushiV3', kind: 'v3', factory: '0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e', feeTiers: [100, 500, 3000, 10000] },
      { name: 'PancakeV3', kind: 'v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', feeTiers: [100, 500, 2500, 10000] },
      { name: 'UniswapV2', kind: 'v2', factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', feeBps: 30 },
      { name: 'SushiV2', kind: 'v2', factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', feeBps: 30 },
      { name: 'PancakeV2', kind: 'v2', factory: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E', feeBps: 25 },
    ],
  },
};
