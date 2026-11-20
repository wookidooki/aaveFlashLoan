// Network access, pool discovery, pool state and Aave data for one chain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPublicClient, http, fallback, getAddress, zeroAddress } from 'viem';
import { base, arbitrum } from 'viem/chains';
import {
  erc20Abi, v2FactoryAbi, solidlyFactoryAbi, v3FactoryAbi, clFactoryAbi, v2PairAbi, solidlyPoolAbi, v3PoolAbi, aavePoolAbi,
} from './abis.js';

const VIEM_CHAINS = { 8453: base, 42161: arbitrum };

// Behind an HTTPS proxy, make Node's fetch use it (no effect without a proxy).
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export const viemChain = (cfg) => VIEM_CHAINS[cfg.id];

export function makeTransport(key, cfg) {
  // RPC_BASE / RPC_ARBITRUM (comma separated) go first, e.g. your Alchemy link.
  const extra = (process.env[`RPC_${key.toUpperCase()}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = [...extra, ...cfg.rpcs];
  return fallback(urls.map((u) => http(u, { timeout: 6000, retryCount: 1 })), { retryCount: 2 });
}

export function makeClient(key, cfg) {
  return createPublicClient({ chain: viemChain(cfg), transport: makeTransport(key, cfg), batch: { multicall: false } });
}

/** Multicall with allowFailure. Returns results in order (undefined for failed calls). */
export async function multi(client, contracts, blockNumber) {
  const out = [];
  const CHUNK = 400;
  for (let i = 0; i < contracts.length; i += CHUNK) {
    const part = contracts.slice(i, i + CHUNK);
    const res = await client.multicall({ contracts: part, allowFailure: true, blockNumber, batchSize: 0 });
    for (const r of res) out.push(r.status === 'success' ? r.result : undefined);
  }
  return out;
}

// ------------------------------------------------------------------ tokens

export async function loadTokens(client, cfg) {
  const list = Object.entries(cfg.tokens).map(([symbol, a]) => ({ symbol, address: getAddress(a) }));
  const dec = await multi(client, list.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'decimals' })));
  const tokens = new Map();
  list.forEach((t, i) => {
    if (dec[i] === undefined) throw new Error(`${cfg.name}: cannot read decimals of ${t.symbol}`);
    tokens.set(t.address, { ...t, decimals: Number(dec[i]) });
  });
  return tokens;
}

// ------------------------------------------------------------------ pool discovery

const sortPair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);

function poolLabel(p) {
  if (p.kind === 'v3') return `${p.dex} ${p.fee / 10000}%`;
  if (p.kind === 'cl') return `${p.dex} ts${p.tickSpacing}`;
  if (p.kind === 'solidly') return `${p.dex} ${p.stable ? 'stable' : 'volatile'}`;
  return p.dex;
}

/** Finds every pool for every token pair on every DEX in the config. */
export async function discoverPools(client, cfg, tokens) {
  const addrs = [...tokens.keys()];
  const calls = [];
  const meta = [];
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      const [t0, t1] = sortPair(addrs[i], addrs[j]);
      for (const d of cfg.dexes) {
        const push = (abi, args, extra) => {
          calls.push({ address: d.factory, abi, functionName: d.kind === 'v2' ? 'getPair' : 'getPool', args });
          meta.push({ dex: d.name, kind: d.kind, token0: t0, token1: t1, ...extra });
        };
        if (d.kind === 'v2') push(v2FactoryAbi, [t0, t1], { feeBps: d.feeBps });
        if (d.kind === 'solidly') for (const stable of [false, true]) push(solidlyFactoryAbi, [t0, t1, stable], { stable, factory: d.factory });
        if (d.kind === 'v3') for (const fee of d.feeTiers) push(v3FactoryAbi, [t0, t1, fee], { fee });
        if (d.kind === 'cl') for (const ts of d.tickSpacings) push(clFactoryAbi, [t0, t1, ts], { tickSpacing: ts });
      }
    }
  }
  const res = await multi(client, calls);
  const seen = new Set();
  const pools = [];
  res.forEach((addr, k) => {
    if (!addr || addr === zeroAddress || seen.has(addr)) return;
    seen.add(addr);
    pools.push({ address: getAddress(addr), ...meta[k] });
  });

  await refreshFees(client, pools);
  for (const p of pools) p.label = poolLabel(p);
  return pools;
}

/** Re-reads fees that can change: Aerodrome pool fees (from the factory) and Aerodrome CL fees. */
export async function refreshFees(client, pools) {
  const sol = pools.filter((p) => p.kind === 'solidly');
  const fees = await multi(client, sol.map((p) => ({ address: p.factory, abi: solidlyFactoryAbi, functionName: 'getFee', args: [p.address, p.stable] })));
  sol.forEach((p, k) => { p.feeBps = fees[k] !== undefined ? Number(fees[k]) : (p.feeBps ?? 30); });
  const cl = pools.filter((p) => p.kind === 'cl');
  const clFees = await multi(client, cl.map((p) => ({ address: p.address, abi: v3PoolAbi, functionName: 'fee' })));
  cl.forEach((p, k) => { p.fee = clFees[k] !== undefined ? Number(clFees[k]) : (p.fee ?? 3000); });
}

/** Token balances held by each pool (used to estimate pool size). */
export async function loadBalances(client, pools) {
  const calls = pools.flatMap((p) => [
    { address: p.token0, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    { address: p.token1, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
  ]);
  const res = await multi(client, calls);
  pools.forEach((p, k) => { p.bal0 = res[2 * k] ?? 0n; p.bal1 = res[2 * k + 1] ?? 0n; });
}

// Discovery is slow-ish, so keep the result on disk.
const defaultCacheDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'cache');
const configHash = (cfg) => crypto.createHash('sha1').update(JSON.stringify({ t: cfg.tokens, d: cfg.dexes })).digest('hex').slice(0, 12);

export async function getPools(client, key, cfg, tokens, maxAgeHours, cacheDir = defaultCacheDir) {
  const file = path.join(cacheDir, `pools-${key}.json`);
  const hash = configHash(cfg);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.hash === hash && Date.now() - c.createdAt < maxAgeHours * 3600e3) return { pools: c.pools, cached: true };
  } catch { /* no cache yet */ }
  const pools = await discoverPools(client, cfg, tokens);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hash, createdAt: Date.now(), pools }, null, 1));
  return { pools, cached: false };
}

// ------------------------------------------------------------------ live pool state

/** Reads the current state of every pool in one multicall at one block. */
export async function loadState(client, pools, blockNumber) {
  const calls = [];
  const plan = [];
  for (const p of pools) {
    const start = calls.length;
    if (p.kind === 'v2') calls.push({ address: p.address, abi: v2PairAbi, functionName: 'getReserves' });
    else if (p.kind === 'solidly') {
      calls.push({ address: p.address, abi: solidlyPoolAbi, functionName: 'getReserves' });
      if (p.stable) {
        // small probe trades, 1/10000 of the pool's balance
        p.probeIn0 = BigInt(p.bal0 ?? 0n) / 10000n || 1n;
        p.probeIn1 = BigInt(p.bal1 ?? 0n) / 10000n || 1n;
        calls.push({ address: p.address, abi: solidlyPoolAbi, functionName: 'getAmountOut', args: [p.probeIn0, p.token0] });
        calls.push({ address: p.address, abi: solidlyPoolAbi, functionName: 'getAmountOut', args: [p.probeIn1, p.token1] });
      }
    } else {
      calls.push({ address: p.address, abi: v3PoolAbi, functionName: 'slot0' });
      calls.push({ address: p.address, abi: v3PoolAbi, functionName: 'liquidity' });
      if (p.kind === 'cl') calls.push({ address: p.address, abi: v3PoolAbi, functionName: 'fee' });
    }
    plan.push([p, start]);
  }
  const r = await multi(client, calls, blockNumber);
  const states = new Map();
  for (const [p, k] of plan) {
    let st;
    if (p.kind === 'v2' || p.kind === 'solidly') {
      if (!r[k]) continue;
      st = { reserve0: BigInt(r[k][0]), reserve1: BigInt(r[k][1]) };
      if (p.stable) Object.assign(st, { probeIn0: p.probeIn0, probeIn1: p.probeIn1, probeOut01: r[k + 1] ?? 0n, probeOut10: r[k + 2] ?? 0n });
    } else {
      if (r[k] === undefined || r[k + 1] === undefined) continue;
      st = { sqrtPriceX96: BigInt(r[k]), liquidity: BigInt(r[k + 1]) };
      if (p.kind === 'cl') st.fee = r[k + 2] !== undefined ? Number(r[k + 2]) : p.fee;
    }
    states.set(p.address, st);
  }
  return states;
}

// ------------------------------------------------------------------ Aave

const bit = (data, n) => ((data >> BigInt(n)) & 1n) === 1n;

/** Which tokens Aave lends with flash loans, and how much is available. */
export async function loadAave(client, cfg, tokens) {
  const assets = [...tokens.keys()];
  const [premium, ...rest] = await multi(client, [
    { address: cfg.aavePool, abi: aavePoolAbi, functionName: 'FLASHLOAN_PREMIUM_TOTAL' },
    ...assets.map((a) => ({ address: cfg.aavePool, abi: aavePoolAbi, functionName: 'getConfiguration', args: [a] })),
    ...assets.map((a) => ({ address: cfg.aavePool, abi: aavePoolAbi, functionName: 'getReserveData', args: [a] })),
  ]);
  if (premium === undefined) throw new Error(`${cfg.name}: cannot read Aave flash loan fee`);
  const confs = rest.slice(0, assets.length);
  const datas = rest.slice(assets.length);
  const ok = [];
  assets.forEach((a, k) => {
    const c = confs[k] !== undefined ? BigInt(confs[k].data ?? confs[k]) : 0n;
    // bit 56 active, 57 frozen, 60 paused, 63 flash loans enabled
    const aToken = datas[k]?.[8]; // getReserveData field 8 = aTokenAddress
    const usable = bit(c, 56) && !bit(c, 60) && bit(c, 63) && aToken && aToken !== zeroAddress;
    if (usable) ok.push({ asset: a, aToken });
  });
  const bals = await multi(client, ok.map((x) => ({ address: x.asset, abi: erc20Abi, functionName: 'balanceOf', args: [x.aToken] })));
  const available = new Map();
  ok.forEach((x, k) => available.set(x.asset, bals[k] ?? 0n));
  return { premiumBps: Number(premium), available };
}

/** All flash loan sources: Aave v3 (small fee) and Morpho Blue (no fee, lends what it holds). */
export async function loadLenders(client, cfg, tokens) {
  const aave = await loadAave(client, cfg, tokens);
  const morpho = new Map();
  if (cfg.morpho) {
    const assets = [...tokens.keys()];
    const bals = await multi(client, assets.map((a) => ({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.morpho] })));
    assets.forEach((a, k) => { if (bals[k] > 0n) morpho.set(a, bals[k]); });
  }
  return { aavePremiumBps: aave.premiumBps, aave: aave.available, morpho };
}
