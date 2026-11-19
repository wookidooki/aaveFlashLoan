// Scans one chain forever: every new block it looks for profitable loops,
// checks them exactly, and (only in live mode) trades them.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'viem';
import { makeClient, loadTokens, getPools, loadBalances, loadState, loadLenders, refreshFees } from './chain.js';
import { rateTable, buildCycles, rankCycles, usdPrices, poolTvlUsd, pickLender, minPremiumBps, maxLoan } from './graph.js';
import { routeHops, bestSizes, simulateArb, quoteErrors } from './quote.js';
import { Executor } from './executor.js';

const defaultLogDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'logs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}%`;

export class ChainScanner {
  /** opts (for tests): client, transport (for the wallet), logDir, cacheDir, log */
  constructor(key, cfg, settings, opts = {}) {
    this.key = key;
    this.cfg = cfg;
    this.s = settings;
    this.opts = opts;
    this.logDir = opts.logDir || process.env.LOG_DIR || defaultLogDir;
    if (opts.log) this.log = opts.log;
    this.lastBlock = 0n;
    this.stats = { checks: 0, ms: 0, errors: 0, bestGapSeen: -Infinity, bestGapSeenRoute: '', positive: 0, quotedProfitable: 0, verified: 0, since: Date.now() };
  }

  log(msg) {
    console.log(`${new Date().toISOString().slice(11, 19)} [${this.cfg.name}] ${msg}`);
  }

  sym(a) {
    return this.tokens.get(a)?.symbol ?? a.slice(0, 8);
  }

  describe(cycle) {
    let s = this.sym(cycle.start);
    for (const l of cycle.legs) s += ` -> ${this.sym(l.tokenOut)} [${this.pools[l.i].label}]`;
    return s;
  }

  async init() {
    this.client = this.opts.client || makeClient(this.key, this.cfg);
    const id = await this.client.getChainId();
    if (id !== this.cfg.id) throw new Error(`RPC is chain ${id}, expected ${this.cfg.id}`);
    this.tokens = await loadTokens(this.client, this.cfg);
    this.anchor = getAddress(this.cfg.tokens[this.cfg.usdAnchor]);
    const { pools, cached } = await getPools(this.client, this.key, this.cfg, this.tokens, this.s.discoveryMaxAgeHours, this.opts.cacheDir);
    this.allPools = pools;
    this.log(`${pools.length} pools found on ${this.cfg.dexes.length} DEXs for ${this.tokens.size} tokens${cached ? ' (from cache)' : ''}`);
    await this.refresh();

    if (this.s.live) {
      this.executor = new Executor(this.key, this.cfg, this.client, this.s, (m) => this.log(m), this.opts.transport);
      await this.executor.init();
      this.log(this.executor.ready ? `LIVE trading ON with contract ${this.executor.contract}` : `live trading OFF: ${this.executor.why}`);
    }
  }

  /** Re-reads pools (new ones too, when the cache is old), fees, pool sizes and flash loan liquidity. */
  async refresh() {
    if (this.lastRefresh) {
      const { pools, cached } = await getPools(this.client, this.key, this.cfg, this.tokens, this.s.discoveryMaxAgeHours, this.opts.cacheDir);
      if (!cached) {
        this.allPools = pools;
        this.log(`found pools again: ${pools.length}`);
      } else {
        await refreshFees(this.client, this.allPools);
      }
    }
    await loadBalances(this.client, this.allPools);
    this.lenders = await loadLenders(this.client, this.cfg, this.tokens);
    const block = await this.client.getBlockNumber();
    const states = await loadState(this.client, this.allPools, block);
    this.prices = usdPrices(this.tokens, this.allPools, states, this.anchor);
    for (const p of this.allPools) p.tvlUsd = poolTvlUsd(p, this.tokens, this.prices);
    // Ignore lenders that hold less than the smallest trade size (dust).
    const minUsd = Math.min(...this.s.tradeSizesUsd);
    for (const m of [this.lenders.morpho, this.lenders.aave]) {
      for (const [a, v] of m) if (!this.prices.has(a) || this.usd(a, v) < minUsd) m.delete(a);
    }
    this.pools = this.allPools.filter((p) => p.tvlUsd >= this.s.minPoolTvlUsd && states.has(p.address));
    const starts = [...this.tokens.keys()].filter((a) => maxLoan(this.lenders, a) > 0n && this.prices.has(a));
    this.cycles = buildCycles(this.pools, starts, this.s.maxHops);
    this.lastRefresh = Date.now();
    const free = starts.filter((a) => minPremiumBps(this.lenders, a) === 0);
    const paid = starts.filter((a) => minPremiumBps(this.lenders, a) > 0);
    this.log(
      `${this.pools.length} pools >= $${this.s.minPoolTvlUsd.toLocaleString()} | ${this.cycles.length.toLocaleString()} loops to check | ` +
        `borrow with no fee (Morpho): ${free.map((a) => this.sym(a)).join(', ') || '-'} | ` +
        `Aave only (${this.lenders.aavePremiumBps / 100}% fee): ${paid.map((a) => this.sym(a)).join(', ') || '-'}`,
    );
  }

  sizesFor(asset) {
    const price = this.prices.get(asset);
    const t = this.tokens.get(asset);
    const cap = maxLoan(this.lenders, asset);
    if (!price || !t) return [];
    return this.s.tradeSizesUsd
      .map((usd) => BigInt(Math.floor((usd / price) * 10 ** t.decimals)))
      .filter((x) => x > 0n && x <= cap);
  }

  usd(asset, raw) {
    return (Number(raw) / 10 ** this.tokens.get(asset).decimals) * (this.prices.get(asset) ?? 0);
  }

  async tick() {
    const block = await this.client.getBlockNumber();
    if (block === this.lastBlock) return;
    this.lastBlock = block;
    const t0 = Date.now();

    const [states, gasPrice] = await Promise.all([loadState(this.client, this.pools, block), this.client.getGasPrice()]);
    const rates = rateTable(this.pools, states);
    this.prices = usdPrices(this.tokens, this.pools, states, this.anchor);
    const { candidates, bestGap, bestCycle, positive } = rankCycles(this.cycles, rates, (a) => minPremiumBps(this.lenders, a), this.s.topCandidates);

    this.stats.checks++;
    this.stats.positive += positive;
    this.lastBestGap = bestGap;
    this.lastBestRoute = bestCycle ? this.describe(bestCycle) : '';
    if (bestGap > this.stats.bestGapSeen) {
      this.stats.bestGapSeen = bestGap;
      this.stats.bestGapSeenRoute = this.lastBestRoute;
    }

    if (candidates.length) await this.checkCandidates(candidates, block, gasPrice);
    this.stats.ms += Date.now() - t0;
  }

  async checkCandidates(candidates, block, gasPrice) {
    const ethUsd = this.prices.get(getAddress(this.cfg.nativeWrapped)) ?? 0;
    const items = candidates
      .map((c) => ({
        c,
        hops: routeHops(c.cycle, this.pools),
        sizes: this.sizesFor(c.cycle.start),
        feeFor: (size) => pickLender(this.lenders, c.cycle.start, size)?.premium ?? null,
      }))
      .filter((x) => x.sizes.length);
    if (!items.length) return;

    const best = await bestSizes(this.client, items, block);
    const found = [];
    items.forEach((x, i) => {
      const b = best[i];
      if (!(b.profit > 0n)) return;
      const asset = x.c.cycle.start;
      const gasUsd = ((this.cfg.gas.base + this.cfg.gas.perHop * x.hops.length) * Number(gasPrice) / 1e18) * ethUsd + this.cfg.gas.l1FeeUsd;
      const profitUsd = this.usd(asset, b.profit);
      const { source } = pickLender(this.lenders, asset, b.amount);
      found.push({ ...x, asset, source, amount: b.amount, profitRaw: b.profit, profitUsd, gasUsd, netUsd: profitUsd - gasUsd });
    });
    const profitable = found.filter((f) => f.netUsd >= this.s.minProfitUsd).sort((a, b) => b.netUsd - a.netUsd);
    this.stats.quotedProfitable += profitable.length;

    // Full simulation of the real trade (flash loan + swaps + repay) for the best few.
    for (const f of profitable.slice(0, 3)) {
      const sim = await simulateArb(this.client, this.cfg, f.source, f.asset, f.amount, f.hops, block);
      const route = this.describe(f.c.cycle);
      if (!sim.ok) {
        this.log(`quote said +$${f.netUsd.toFixed(2)} but full check failed (${sim.reason}): ${route}`);
        continue;
      }
      const realUsd = this.usd(f.asset, sim.profit);
      const netUsd = realUsd - f.gasUsd;
      if (netUsd < this.s.minProfitUsd) continue;
      this.stats.verified++;
      const t = this.tokens.get(f.asset);
      const size = Number(f.amount) / 10 ** t.decimals;
      this.log(`*** OPPORTUNITY block ${block}: borrow ${size.toPrecision(6)} ${t.symbol} from ${f.source === 'morpho' ? 'Morpho' : 'Aave'} | profit $${realUsd.toFixed(2)} - gas ~$${f.gasUsd.toFixed(3)} = $${netUsd.toFixed(2)} | ${route}`);
      this.record({ block: block.toString(), route, source: f.source, asset: t.symbol, amount: f.amount.toString(), size, profitUsd: realUsd, gasUsd: f.gasUsd, netUsd, gap: f.c.gap, hops: f.hops.map((h) => ({ ...h })) });
      if (!this.executor) break; // watch only: report the best one per block
      const sent = await this.executor.tryTrade({
        source: f.source, asset: f.asset, amount: f.amount, hops: f.hops, profitRaw: sim.profit, profitUsd: realUsd,
        ethUsd, assetUsd: this.prices.get(f.asset), decimals: t.decimals,
      });
      if (sent) break; // one trade per block per chain; if skipped, try the next one
    }
  }

  record(o) {
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.appendFileSync(path.join(this.logDir, `opportunities-${this.key}.jsonl`), JSON.stringify({ time: new Date().toISOString(), chain: this.key, ...o }) + '\n');
  }

  status() {
    const st = this.stats;
    const mins = (Date.now() - st.since) / 60000;
    this.log(
      `block ${this.lastBlock} | ${st.checks} blocks checked (${st.checks ? Math.round(st.ms / st.checks) : 0} ms each) | ` +
        `best loop now ${pct(this.lastBestGap ?? -1)} | best seen ${pct(st.bestGapSeen)} | loops with a gap: ${st.positive} | ` +
        `profitable after fees: ${st.quotedProfitable} quoted, ${st.verified} verified | errors ${st.errors} | ${mins.toFixed(1)} min`,
    );
    if (quoteErrors.count) this.log(`  quote errors so far (all chains): ${quoteErrors.count} (last: ${quoteErrors.last})`);
    if (this.lastBestRoute) this.log(`  best loop now: ${this.lastBestRoute}`);
  }

  async run() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.init();
        break;
      } catch (e) {
        this.log(`start-up failed (${e.shortMessage || e.message}), retry ${attempt} in 10s`);
        await sleep(10000);
      }
    }
    let lastStatus = Date.now();
    let backoff = 0;
    for (;;) {
      const t0 = Date.now();
      try {
        if (Date.now() - this.lastRefresh > this.s.poolRefreshMin * 60000) await this.refresh();
        await this.tick();
        backoff = 0;
      } catch (e) {
        this.stats.errors++;
        this.log(`error: ${(e.shortMessage || e.message).split('\n')[0]}`);
        backoff = Math.min(Math.max(backoff * 2, 1000), 15000); // slow down a bit if the RPC is limiting us
      }
      if (Date.now() - lastStatus > this.s.statusEverySec * 1000) {
        this.status();
        lastStatus = Date.now();
      }
      // Check again pollMs after the START of this tick, so slow ticks do not add extra delay.
      await sleep(Math.max(0, this.s.pollMs - (Date.now() - t0)) + backoff);
    }
  }
}
