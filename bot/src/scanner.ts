// Read-only opportunity scanner. One independent loop per chain; every candidate is a single atomic
// round trip on one chain that borrows an Aave v3 asset and ends in that same asset.
//
// Per cycle and chain, everything is read at ONE block number:
//   Aave premium, flash-loan availability, available liquidity and oracle prices;
//   leg-1 quotes at each loan size; leg-2 quotes using each leg-1 output as input;
//   gas prices and the L1 data fee.
// Live execution does not exist in this module: there is no wallet client and no private key.
import { EventEmitter } from "node:events";
import { pad, type Address, type PublicClient } from "viem";
import { loadMarket, readMarketState, borrowBlocker, ERC20_ABI, type AaveMarket, type MarketState } from "./aave.ts";
import { makeClient, multicallAt, rawCall, rpcRejections, shortError } from "./chain.ts";
import type { ChainConfig, ScanConfig } from "./config.ts";
import { calldataGas, estimateTxCost, readGasPrices, type GasCost, type GasPrices } from "./gas.ts";
import { aaveV3Premium } from "./quote/amm.ts";
import { decodeSimulation, encodeRun, receiverArtifact, type LegArg } from "./sim/receiver.ts";
import { discoverPools, quoteMany, readV2Reserves, verifyVenue, type PoolInfo, type PoolSkip, type QuoteRequest } from "./venues.ts";

/** Simulation-only addresses: the receiver's code is injected here via eth_call state override. */
export const SIM_RECEIVER: Address = "0x5115000000000000000000000000000000005115";
export const SIM_OWNER: Address = "0x0000000000000000000000000000000000005115";

export interface Route {
  id: string;
  chain: string;
  pair: string;
  borrow: Address;
  borrowSym: string;
  mid: Address;
  midSym: string;
  first: PoolInfo;
  second: PoolInfo;
  /** Same price gap seen from either borrow side maps to one key. */
  gapKey: string;
}

export interface SizeEval {
  sizeUsd: number;
  amount: bigint;
  leg1Out?: bigint;
  leg2Out?: bigint;
  leg1Gas?: bigint;
  leg2Gas?: bigint;
  premium: bigint;
  /** leg2Out - amount (swap fees and price impact are already inside the quotes) */
  grossTokens?: bigint;
  /** grossTokens - premium */
  netTokens?: bigint;
  netTokensUsd?: number;
  gas?: GasCost;
  gasUsd?: number;
  l1Usd?: number;
  netUsd?: number;
  /** premium in USD, and net if the flash loan were fee-free (counterfactual, for comparison only) */
  premiumUsd?: number;
  feeFreeNetUsd?: number;
  skip?: string;
  /** not quoted (or quote failed), but provably unprofitable because a smaller size already loses */
  dominated?: boolean;
}

export interface RouteEval {
  route: Route;
  block: bigint;
  sizes: SizeEval[];
  best?: SizeEval;
  outcome: string;
  qualifies: boolean;
  /** counterfactual: would some size clear minNetUsd if the flash loan were fee-free? */
  feeFreeQualifies?: boolean;
  /** best net over sizes in that counterfactual (USD) */
  bestFeeFreeNetUsd?: number;
  /** rate(first) x rate(second) at the probe size: an upper bound on the round-trip rate */
  marginalProduct?: number;
  /** not quoted at full sizes because the marginal-price bound cannot cover the premium */
  pruned?: boolean;
  skip?: string;
}

export interface Episode {
  /** "aave": positive net with the real Aave premium. "fee-free": counterfactual without the premium. */
  kind: "aave" | "fee-free";
  gapKey: string;
  chain: string;
  firstSeen: string;
  lastSeen: string;
  firstBlock: string;
  lastBlock: string;
  /** lastBlock - firstBlock + 1: how many blocks the gap stayed open while observed */
  blocksOpen: number;
  sightings: number;
  bestNetUsd: number;
  routeId: string;
  freshQuote?: { block: string; netUsd: number | null; qualifies: boolean; note?: string };
  simulation?: SimRecord;
  open: boolean;
}

export interface SimRecord {
  ts: string;
  chain: string;
  routeId: string;
  block: string;
  purpose: "qualifying-opportunity" | "best-route-evidence" | "venue-verification";
  sizeUsd: number;
  amount: string;
  quotedLeg2Out: string;
  quotedNetTokens: string;
  ok: boolean;
  simProfit?: string;
  simProceeds?: string;
  proceedsMatchQuote?: boolean;
  gasUsedInside: string;
  reason: string;
  error?: string;
}

export type LogLevel = "info" | "warn" | "error" | "opportunity" | "sim";
export interface LogLine {
  ts: string;
  level: LogLevel;
  chain?: string;
  msg: string;
}

interface ChainRuntime {
  cfg: ChainConfig;
  client: PublicClient;
  market?: AaveMarket;
  decimals: Map<Address, number>;
  symbols: Map<Address, string>;
  pools: PoolInfo[];
  poolSkips: PoolSkip[];
  venueSkips: { id: string; reason: string }[];
  routes: Route[];
  poolsRefreshedAt: number;
  cycles: number;
  lastBlock?: bigint;
  lastCycleMs?: number;
  lastError?: string;
  routesQuotedEver: Set<string>;
  routesQuotedLastCycle: number;
  routesPrunedLastCycle: number;
  routesEvaluatedEver: Set<string>;
  boundChecks: number;
  boundViolations: number;
  quotesDominated: number;
  quotesCannotFill: number;
  hotRoutes: Route[];
  lastHotBlock: bigint;
  /** Aave state, gas prices and screening L1 fee from the last full sweep, reused by per-block passes */
  cache?: { market: MarketState; prices: GasPrices; screeningL1?: GasCost };
  hot: { passes: number; ms: number; blocksSkipped: number; routeEvals: number; outcomes: Map<string, number> };
  bestFeeFreeUsd?: number;
  bestFeeFreeRoute?: string;
  quotesOk: number;
  quotesFailed: number;
  skipCounts: Map<string, number>;
  outcomeCounts: Map<string, number>;
  bestEver?: RouteEval;
  bestLastCycle?: RouteEval;
  topRoutes: Map<string, RouteEval>;
  timer?: NodeJS.Timeout;
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

export class Scanner extends EventEmitter {
  readonly cfg: ScanConfig;
  readonly sessionId: string;
  readonly startedAt: string;
  stoppedAt?: string;
  running = false;
  private chains = new Map<string, ChainRuntime>();
  readonly episodes = new Map<string, Episode>();
  readonly closedEpisodes: Episode[] = [];
  readonly simulations: SimRecord[] = [];
  readonly logTail: LogLine[] = [];

  constructor(cfg: ScanConfig) {
    super();
    this.cfg = cfg;
    this.startedAt = new Date().toISOString();
    this.sessionId = this.startedAt.replace(/[:.]/g, "-");
    for (const c of cfg.chains) {
      this.chains.set(c.name, {
        cfg: c,
        client: makeClient(c),
        decimals: new Map(),
        symbols: new Map(),
        pools: [],
        poolSkips: [],
        venueSkips: [],
        routes: [],
        poolsRefreshedAt: 0,
        cycles: 0,
        routesQuotedEver: new Set(),
        routesQuotedLastCycle: 0,
        routesPrunedLastCycle: 0,
        routesEvaluatedEver: new Set(),
        boundChecks: 0,
        boundViolations: 0,
        quotesDominated: 0,
        quotesCannotFill: 0,
        hotRoutes: [],
        lastHotBlock: 0n,
        hot: { passes: 0, ms: 0, blocksSkipped: 0, routeEvals: 0, outcomes: new Map() },
        quotesOk: 0,
        quotesFailed: 0,
        skipCounts: new Map(),
        outcomeCounts: new Map(),
        topRoutes: new Map(),
      });
    }
  }

  log(level: LogLevel, msg: string, chain?: string) {
    const line: LogLine = { ts: new Date().toISOString(), level, chain, msg };
    this.logTail.push(line);
    if (this.logTail.length > 500) this.logTail.shift();
    this.emit("log", line);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stoppedAt = undefined;
    this.log("info", `scanner started (read-only; live execution disabled). chains: ${[...this.chains.keys()].join(", ")}`);
    for (const rt of this.chains.values()) this.loop(rt);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.stoppedAt = new Date().toISOString();
    for (const rt of this.chains.values()) if (rt.timer) clearTimeout(rt.timer);
    for (const ep of this.episodes.values()) this.closeEpisode(ep);
    this.log("info", "scanner stopped");
    this.emit("stopped");
  }

  private async loop(rt: ChainRuntime) {
    if (!this.running) return;
    const t0 = Date.now();
    try {
      await this.cycle(rt);
      rt.lastError = undefined;
    } catch (e) {
      rt.lastError = shortError(e);
      this.log("error", `cycle failed: ${rt.lastError}`, rt.cfg.name);
    }
    rt.lastCycleMs = Date.now() - t0;
    // Between full sweeps, re-quote the hot routes on every new block.
    try {
      await this.hotLoop(rt, t0 + this.cfg.intervalSeconds * 1000);
    } catch (e) {
      rt.lastError = shortError(e);
      this.log("error", `per-block pass failed: ${rt.lastError}`, rt.cfg.name);
    }
    if (!this.running) return;
    const wait = Math.max(250, this.cfg.intervalSeconds * 1000 - (Date.now() - t0));
    rt.timer = setTimeout(() => this.loop(rt), wait);
  }

  // ---------------------------------------------------------------- setup

  private async init(rt: ChainRuntime) {
    const c = rt.cfg;
    const id = await rt.client.getChainId();
    if (id !== c.chainId) throw new Error(`RPC chainId ${id} does not match config ${c.chainId}`);
    rt.market = await loadMarket(rt.client, c.aavePoolAddressesProvider);
    const addrs = Object.values(c.assets);
    const block = await rt.client.getBlockNumber();
    const res = await multicallAt(
      rt.client,
      addrs.flatMap((a) => [
        { address: a, abi: ERC20_ABI, functionName: "decimals" },
        { address: a, abi: ERC20_ABI, functionName: "symbol" },
      ]),
      block,
    );
    addrs.forEach((a, i) => {
      const d = res[2 * i];
      if (!d.ok) throw new Error(`${a}: decimals() failed`);
      rt.decimals.set(a, Number(d.value));
    });
    for (const [sym, a] of Object.entries(c.assets)) {
      rt.symbols.set(a, sym);
      const aaveSym = rt.market.reserves.get(a);
      this.log("info", `asset ${sym} ${a} decimals=${rt.decimals.get(a)} aave=${aaveSym ?? "not a reserve (intermediate only)"}`, c.name);
    }
    for (const u of c.unsupportedVenues) rt.venueSkips.push(u);
    this.log(
      "info",
      `Aave v3 pool ${rt.market.pool}, ${rt.market.reserves.size} reserves; venues: ${c.venues.map((v) => v.id).join(", ")}`,
      c.name,
    );
  }

  private async refreshPools(rt: ChainRuntime, block: bigint) {
    const c = rt.cfg;
    rt.pools = [];
    rt.poolSkips = [];
    rt.venueSkips = [...c.unsupportedVenues];
    const venues = [];
    for (const v of c.venues) {
      const check = await verifyVenue(rt.client, v);
      if (!check.ok) {
        rt.venueSkips.push({ id: v.id, reason: check.reason! });
        this.log("warn", `venue ${v.id} skipped: ${check.reason}`, c.name);
      } else venues.push(v);
    }
    const market = await readMarketState(rt.client, rt.market!, [...new Set(Object.values(c.assets))], block);
    const depth = {
      minSideUsd: Math.min(...this.cfg.loanSizesUsd),
      valueUsd: (t: Address, amt: bigint) => {
        const p = market.assets.get(t)?.priceUsd8;
        return p ? (Number(amt) / 10 ** rt.decimals.get(t)!) * (Number(p) / 1e8) : undefined;
      },
    };
    for (const [a, b] of c.pairs) {
      for (const v of venues) {
        const { pools, skips } = await discoverPools(rt.client, v, c.assets[a], c.assets[b], `${a}/${b}`, block, depth, v.type === "v4" ? c.assets[v.nativeAs] : undefined);
        rt.pools.push(...pools);
        rt.poolSkips.push(...skips);
      }
    }
    rt.routes = this.buildRoutes(rt);
    rt.poolsRefreshedAt = Date.now();
    this.log(
      "info",
      `pool discovery @${block}: ${rt.pools.length} live pools, ${rt.poolSkips.length} skipped, ${rt.routes.length} routes`,
      c.name,
    );
    for (const sk of rt.poolSkips) {
      if (sk.reason !== "pool does not exist") this.log("info", `pool skipped ${sk.pair} ${sk.label}: ${sk.reason}`, c.name);
    }
  }

  private buildRoutes(rt: ChainRuntime): Route[] {
    const c = rt.cfg;
    const routes: Route[] = [];
    for (const [aSym, bSym] of c.pairs) {
      const a = c.assets[aSym];
      const b = c.assets[bSym];
      const pools = rt.pools.filter((p) => (p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a));
      const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
      for (const [x, y, xs, ys] of [
        [a, b, aSym, bSym],
        [b, a, bSym, aSym],
      ] as const) {
        for (const p of pools) {
          for (const q of pools) {
            if (p.id === q.id) continue;
            // X is sold on p and bought back on q.
            const [buyLo, sellLo] = x === lo ? [q, p] : [p, q];
            routes.push({
              id: `${c.name}:${xs}->${ys}@${p.label}->${xs}@${q.label}`,
              chain: c.name,
              pair: `${aSym}/${bSym}`,
              borrow: x,
              borrowSym: xs,
              mid: y,
              midSym: ys,
              first: p,
              second: q,
              gapKey: `${c.name}|${lo}|${hi}|buy@${buyLo.id}|sell@${sellLo.id}`,
            });
          }
        }
      }
    }
    return routes;
  }

  // ---------------------------------------------------------------- evaluation

  private loanAmount(rt: ChainRuntime, asset: Address, priceUsd8: bigint, usd: number): bigint {
    const dec = BigInt(rt.decimals.get(asset)!);
    return (BigInt(Math.round(usd * 100)) * 10n ** dec * 10n ** 8n) / (priceUsd8 * 100n);
  }

  private tokenUsd(rt: ChainRuntime, asset: Address, amount: bigint, market: MarketState): number {
    const p = market.assets.get(asset)!.priceUsd8;
    const dec = rt.decimals.get(asset)!;
    return (Number(amount) / 10 ** dec) * (Number(p) / 1e8);
  }

  private legsFor(route: Route, minOut1: bigint, minOut2: bigint): LegArg[] {
    return [
      { kind: route.first.legKind, pool: route.first.address, tokenIn: route.borrow, tokenOut: route.mid, feeBps: route.first.feeBps, minOut: minOut1, data: route.first.legData },
      { kind: route.second.legKind, pool: route.second.address, tokenIn: route.mid, tokenOut: route.borrow, feeBps: route.second.feeBps, minOut: minOut2, data: route.second.legData },
    ];
  }

  /** Quote and cost a set of routes at one block. */
  async evaluate(
    rt: ChainRuntime,
    routes: Route[],
    block: bigint,
    exactL1 = false,
    forceFull = false,
    /** per-block passes: reuse Aave state, gas prices and the screening L1 fee from the last sweep */
    useCached = false,
  ): Promise<{ evals: RouteEval[]; market: MarketState; prices: GasPrices }> {
    const c = rt.cfg;
    const gm = this.cfg.gasModel;
    const assetList = [...new Set(Object.values(c.assets))];
    const cached = useCached && rt.cache ? rt.cache : undefined;
    const [market, prices] = cached
      ? [cached.market, cached.prices]
      : await Promise.all([readMarketState(rt.client, rt.market!, assetList, block), readGasPrices(rt.client, c, block)]);
    if (!useCached) rt.cache = { market, prices, screeningL1: rt.cache?.screeningL1 };
    const gasToken = c.assets[c.gasToken];
    const ethUsd = Number(market.assets.get(gasToken)!.priceUsd8) / 1e8;
    const v2Reserves = await readV2Reserves(rt.client, rt.pools, block);

    const evals: RouteEval[] = routes.map((route) => ({ route, block, sizes: [], outcome: "", qualifies: false }));
    const full = exactL1 || forceFull || routes.length <= this.cfg.fullQuoteTopRoutes;
    if (!full) await this.applyMarginalBound(rt, evals, market, v2Reserves, block);

    // Leg 1, deduplicated by (pool, tokenIn, amount).
    const leg1Reqs: QuoteRequest[] = [];
    const leg1Index = new Map<string, number>();
    for (const ev of evals) {
      const s = market.assets.get(ev.route.borrow);
      const blocker = borrowBlocker(s);
      if (blocker) {
        ev.skip = `borrow ${ev.route.borrowSym}: ${blocker}`;
        continue;
      }
      if (ev.pruned) continue;
      for (const usd of this.cfg.loanSizesUsd) {
        const amount = this.loanAmount(rt, ev.route.borrow, s!.priceUsd8, usd);
        const size: SizeEval = { sizeUsd: usd, amount, premium: aaveV3Premium(amount, market.premiumBps) };
        ev.sizes.push(size);
        if (amount >= s!.availableLiquidity) {
          const d = rt.decimals.get(ev.route.borrow)!;
          size.skip = `Aave available liquidity ${units(s!.availableLiquidity, d)} < loan ${units(amount, d)} ${ev.route.borrowSym}`;
          continue;
        }
        const key = `${ev.route.first.id}|${ev.route.borrow}|${amount}`;
        if (!leg1Index.has(key)) {
          leg1Index.set(key, leg1Reqs.length);
          leg1Reqs.push({ pool: ev.route.first, tokenIn: ev.route.borrow, tokenOut: ev.route.mid, amountIn: amount });
        }
      }
    }
    const leg1 = await quoteMany(rt.client, leg1Reqs, v2Reserves, gm, block);

    // Leg 2: input is exactly the leg-1 output.
    const leg2Reqs: QuoteRequest[] = [];
    const leg2Owner: SizeEval[] = [];
    for (const ev of evals) {
      for (const size of ev.sizes) {
        if (size.skip) continue;
        const q1 = leg1[leg1Index.get(`${ev.route.first.id}|${ev.route.borrow}|${size.amount}`)!];
        if ("error" in q1) {
          size.skip = `leg1 ${ev.route.first.label}: ${q1.error}`;
          continue;
        }
        size.leg1Out = q1.amountOut;
        size.leg1Gas = q1.gas;
        leg2Reqs.push({ pool: ev.route.second, tokenIn: ev.route.mid, tokenOut: ev.route.borrow, amountIn: q1.amountOut });
        leg2Owner.push(size);
      }
    }
    const leg2 = await quoteMany(rt.client, leg2Reqs, v2Reserves, gm, block);
    leg2.forEach((q2, i) => {
      const size = leg2Owner[i];
      if ("error" in q2) size.skip = `leg2: ${q2.error}`;
      else {
        size.leg2Out = q2.amountOut;
        size.leg2Gas = q2.gas;
      }
    });

    // Size dominance. A route's round-trip output per unit of input never rises with size (both legs
    // are concave and start at zero), and the premium is proportional, so once a smaller size fails
    // to return principal + premium, every larger size of that route loses too. Quote failures at
    // those larger sizes are not coverage gaps; they are marked dominated instead of failed.
    for (const ev of evals) {
      let belowBreakEven = false;
      for (const size of [...ev.sizes].sort((a, b) => a.sizeUsd - b.sizeUsd)) {
        if (size.leg2Out !== undefined) {
          if (size.leg2Out < size.amount + size.premium) belowBreakEven = true;
        } else if (belowBreakEven && size.skip && /^leg[12]/.test(size.skip)) {
          size.skip = `dominated: a smaller size already fails to cover principal + premium (quote here: ${size.skip})`;
          size.dominated = true;
        }
      }
    }

    // Screening L1 fee: computed once per cycle from a representative route's real calldata
    // (all 2-leg routes encode to the same length); recomputed exactly for routes that matter.
    let screeningL1: GasCost | undefined = cached?.screeningL1;
    const sample = cached ? undefined : evals.find((e) => e.sizes.some((s) => s.leg2Out !== undefined));
    if (sample) {
      const s = sample.sizes.find((x) => x.leg2Out !== undefined)!;
      const data = encodeRun("run", sample.route.borrow, s.amount, this.legsFor(sample.route, s.leg1Out!, s.leg2Out!), 1n);
      screeningL1 = await estimateTxCost(rt.client, c, prices, SIM_RECEIVER, data, 0n, block);
      if (rt.cache) rt.cache.screeningL1 = screeningL1;
    }

    for (const ev of evals) {
      for (const size of ev.sizes) {
        if (size.skip || size.leg2Out === undefined) continue;
        size.grossTokens = size.leg2Out - size.amount;
        size.netTokens = size.grossTokens - size.premium;
        const execGas =
          BigInt(gm.txBaseGas + gm.flashLoanOverheadGas + 2 * gm.perLegOverheadGas) + size.leg1Gas! + size.leg2Gas!;
        const data = encodeRun("run", ev.route.borrow, size.amount, this.legsFor(ev.route, size.leg1Out!, size.leg2Out!), 1n);
        const l2Units = execGas + calldataGas(data);
        const gasPrice = prices.baseFee + prices.priorityFee;
        const l1Wei = screeningL1 ? screeningL1.l1CostWei : 0n;
        size.gas = {
          l2GasUnits: l2Units,
          l1GasUnits: screeningL1?.l1GasUnits ?? 0n,
          l2CostWei: l2Units * gasPrice,
          l1CostWei: l1Wei,
          totalWei: l2Units * gasPrice + l1Wei,
          gasPriceWei: gasPrice,
        };
        size.gasUsd = (Number(size.gas.totalWei) / 1e18) * ethUsd;
        size.l1Usd = (Number(l1Wei) / 1e18) * ethUsd;
        size.netTokensUsd = this.tokenUsd(rt, ev.route.borrow, size.netTokens, market);
        size.netUsd = size.netTokensUsd - size.gasUsd;
        size.premiumUsd = this.tokenUsd(rt, ev.route.borrow, size.premium, market);
        size.feeFreeNetUsd = size.netUsd + size.premiumUsd;
      }
      const quoted = ev.sizes.filter((s) => s.netUsd !== undefined);
      if (quoted.length) {
        ev.best = quoted.reduce((a, b) => (b.netUsd! > a.netUsd! ? b : a));
        if (exactL1) await this.exactCost(rt, ev, prices, block, ethUsd, market);
        ev.qualifies = ev.best.netUsd! > this.cfg.minNetUsd;
        ev.bestFeeFreeNetUsd = Math.max(...quoted.map((s) => s.feeFreeNetUsd!));
        ev.feeFreeQualifies = ev.bestFeeFreeNetUsd > this.cfg.minNetUsd;
        ev.outcome = this.classify(ev.best);
      } else if (!ev.skip && !ev.pruned) {
        ev.skip = ev.sizes.map((s) => s.skip).find(Boolean) ?? "no size quoted";
      }
    }
    return { evals, market, prices };
  }

  /**
   * Marginal-price bound. Every pool is quoted in both directions at a tiny size (probeUsd). For
   * exact-input swaps the output per unit of input never rises as the input grows (fees are fixed
   * and price impact only adds up), so a route's best possible round-trip rate at any loan size is
   * at most rate(first) x rate(second) at the probe size, up to the probe's own tiny impact and
   * rounding, which boundSlackBps covers. Routes whose bound cannot cover 1 + premium are recorded
   * as pruned instead of being quoted at every size. Routes near break-even, routes without a probe,
   * and the top fullQuoteTopRoutes routes by bound are always quoted in full.
   */
  private async applyMarginalBound(rt: ChainRuntime, evals: RouteEval[], market: MarketState, v2Reserves: Map<Address, [bigint, bigint]>, block: bigint) {
    const reqs: QuoteRequest[] = [];
    const index = new Map<string, number>();
    for (const ev of evals) {
      for (const [pool, tokenIn, tokenOut] of [
        [ev.route.first, ev.route.borrow, ev.route.mid],
        [ev.route.second, ev.route.mid, ev.route.borrow],
      ] as const) {
        const key = `${pool.id}|${tokenIn}`;
        if (index.has(key)) continue;
        const p = market.assets.get(tokenIn)?.priceUsd8;
        if (!p) continue;
        index.set(key, reqs.length);
        reqs.push({ pool, tokenIn, tokenOut, amountIn: this.loanAmount(rt, tokenIn, p, this.cfg.probeUsd) });
      }
    }
    const quotes = await quoteMany(rt.client, reqs, v2Reserves, this.cfg.gasModel, block);
    const rate = (poolId: string, tokenIn: Address) => {
      const i = index.get(`${poolId}|${tokenIn}`);
      if (i === undefined) return undefined;
      const q = quotes[i];
      return "error" in q ? undefined : Number(q.amountOut) / Number(reqs[i].amountIn);
    };
    for (const ev of evals) {
      const r1 = rate(ev.route.first.id, ev.route.borrow);
      const r2 = rate(ev.route.second.id, ev.route.mid);
      if (r1 !== undefined && r2 !== undefined) ev.marginalProduct = r1 * r2;
    }
    const needed = 1 + Number(market.premiumBps) / 1e4;
    const slack = 1 + this.cfg.boundSlackBps / 1e4;
    const top = new Set(
      evals
        .filter((e) => e.marginalProduct !== undefined)
        .sort((a, b) => b.marginalProduct! - a.marginalProduct!)
        .slice(0, this.cfg.fullQuoteTopRoutes),
    );
    for (const ev of evals) {
      if (ev.marginalProduct === undefined || top.has(ev)) continue;
      if (ev.marginalProduct * slack < needed) {
        ev.pruned = true;
        ev.outcome = "pruned: marginal prices cannot cover the Aave premium at any size";
      }
    }
  }

  /** Recompute the best size's cost with the exact L1 fee for that route's calldata. */
  private async exactCost(rt: ChainRuntime, ev: RouteEval, prices: GasPrices, block: bigint, ethUsd: number, market: MarketState) {
    const s = ev.best!;
    const gm = this.cfg.gasModel;
    const execGas = BigInt(gm.txBaseGas + gm.flashLoanOverheadGas + 2 * gm.perLegOverheadGas) + s.leg1Gas! + s.leg2Gas!;
    const data = encodeRun("run", ev.route.borrow, s.amount, this.legsFor(ev.route, s.leg1Out!, s.leg2Out!), 1n);
    s.gas = await estimateTxCost(rt.client, rt.cfg, prices, SIM_RECEIVER, data, execGas, block);
    s.gasUsd = (Number(s.gas.totalWei) / 1e18) * ethUsd;
    s.l1Usd = (Number(s.gas.l1CostWei) / 1e18) * ethUsd;
    s.netTokensUsd = this.tokenUsd(rt, ev.route.borrow, s.netTokens!, market);
    s.netUsd = s.netTokensUsd - s.gasUsd;
    s.feeFreeNetUsd = s.netUsd + (s.premiumUsd ?? 0);
  }

  private classify(s: SizeEval): string {
    const lossBps = (Number(-s.grossTokens!) / Number(s.amount)) * 10000;
    if (lossBps > this.cfg.maxRoundTripLossBps) return `illiquid at this size: round trip loses more than ${this.cfg.maxRoundTripLossBps} bps`;
    if (s.grossTokens! <= 0n) return "no spread: swap fees + price impact exceed the price gap";
    if (s.netTokens! <= 0n) return "spread smaller than the Aave premium";
    if (s.netUsd! <= 0) return "covers the premium but not gas";
    if (s.netUsd! <= this.cfg.minNetUsd) return "net positive but not above the minimum";
    return "qualifies";
  }

  // ---------------------------------------------------------------- cycle

  private async cycle(rt: ChainRuntime) {
    const c = rt.cfg;
    if (!rt.market) await this.init(rt);
    // One block behind the tip so every load-balanced backend has the state.
    const block = (await rt.client.getBlockNumber()) - 1n;
    if (Date.now() - rt.poolsRefreshedAt > this.cfg.poolRefreshMinutes * 60_000) await this.refreshPools(rt, block);

    const t0 = Date.now();
    const rejBefore = rpcRejections.count;
    const { evals } = await this.evaluate(rt, rt.routes, block);
    if (rpcRejections.count > rejBefore) {
      const n = rpcRejections.count - rejBefore;
      this.log("warn", `RPC rejected ${n} multicall chunk(s) this cycle, retried in smaller chunks: ${rpcRejections.lastDetail}`, c.name);
    }
    rt.cycles++;
    rt.lastBlock = block;

    let quotedRoutes = 0;
    let prunedRoutes = 0;
    for (const ev of evals) {
      if (ev.pruned && !ev.skip) {
        prunedRoutes++;
        rt.routesEvaluatedEver.add(ev.route.id);
        bump(rt.outcomeCounts, ev.outcome);
        continue;
      }
      if (ev.best) rt.routesEvaluatedEver.add(ev.route.id);
      // Soundness check of the pruning bound on every fully quoted route: the real round-trip rate
      // at any size must not exceed the marginal-rate product (plus slack).
      if (ev.marginalProduct !== undefined) {
        for (const s of ev.sizes) {
          if (s.leg2Out === undefined) continue;
          rt.boundChecks++;
          const actual = Number(s.leg2Out) / Number(s.amount);
          if (actual > ev.marginalProduct * (1 + this.cfg.boundSlackBps / 1e4)) {
            rt.boundViolations++;
            this.log("warn", `bound violated on ${ev.route.id} $${s.sizeUsd}: actual rate ${actual} > bound ${ev.marginalProduct}`, c.name);
          }
        }
      }
      if (ev.skip) bump(rt.skipCounts, `route: ${normalizeReason(ev.skip)}`);
      for (const s of ev.sizes) {
        if (s.dominated) bump(rt.skipCounts, "size: dominated (a smaller size already fails to cover principal + premium)");
        else if (s.skip) bump(rt.skipCounts, `size: ${normalizeReason(s.skip)}`);
      }
      const legFails = ev.sizes.filter((s) => s.skip?.startsWith("leg"));
      const illiquid = legFails.filter((s) => LIQUIDITY_LIMITED.test(s.skip!)).length;
      rt.quotesCannotFill += illiquid;
      rt.quotesFailed += legFails.length - illiquid;
      rt.quotesDominated += ev.sizes.filter((s) => s.dominated).length;
      rt.quotesOk += ev.sizes.filter((s) => s.leg2Out !== undefined).length;
      if (ev.best) {
        quotedRoutes++;
        rt.routesQuotedEver.add(ev.route.id);
        bump(rt.outcomeCounts, ev.outcome);
        const prev = rt.topRoutes.get(ev.route.id);
        if (!prev || ev.best.netUsd! > prev.best!.netUsd!) rt.topRoutes.set(ev.route.id, ev);
      }
    }
    rt.routesQuotedLastCycle = quotedRoutes;
    rt.routesPrunedLastCycle = prunedRoutes;
    const ranked = evals.filter((e) => e.best).sort((a, b) => b.best!.netUsd! - a.best!.netUsd!);
    rt.bestLastCycle = ranked[0];
    if (ranked[0] && (!rt.bestEver || ranked[0].best!.netUsd! > rt.bestEver.best!.netUsd!)) rt.bestEver = ranked[0];
    for (const ev of ranked) {
      if (ev.bestFeeFreeNetUsd !== undefined && (rt.bestFeeFreeUsd === undefined || ev.bestFeeFreeNetUsd > rt.bestFeeFreeUsd)) {
        rt.bestFeeFreeUsd = ev.bestFeeFreeNetUsd;
        rt.bestFeeFreeRoute = ev.route.id;
      }
    }

    const b = ranked[0];
    this.log(
      "info",
      `block ${block}: ${evals.length} routes, ${quotedRoutes} fully quoted, ${prunedRoutes} pruned by marginal-price bound, in ${Date.now() - t0} ms; ` +
        (b ? `best ${b.route.id} $${b.best!.sizeUsd} net $${fmt(b.best!.netUsd!)} (${b.outcome})` : "no route quoted"),
      c.name,
    );
    this.emit("cycle", { chain: c.name, block: String(block), quoted: quotedRoutes, routes: evals.length, bestRoute: b?.route.id, bestNetUsd: b?.best?.netUsd });

    // Hot set for per-block passes until the next sweep: the routes closest to break-even.
    rt.hotRoutes = ranked.slice(0, this.cfg.hotRoutes).map((e) => e.route);
    rt.lastHotBlock = block;

    await this.processEpisodes(rt, evals, block);

    // Periodic evidence: simulate the chain's best route through the real receiver code even when
    // it loses on paper, to check quotes against execution and calibrate gas.
    if (b && rt.cycles % this.cfg.bestRouteSimulationEveryCycles === 1) {
      const { evals: fresh } = await this.evaluate(rt, [b.route], block, true);
      if (fresh[0].best) {
        rt.bestLastCycle = fresh[0];
        if (rt.bestEver?.route.id === b.route.id && rt.bestEver.block === block) rt.bestEver = fresh[0];
        await this.simulate(rt, fresh[0], "best-route-evidence");
      }
    }
  }

  /**
   * Opportunity episodes. Repeated sightings of the same price gap count once; an episode records
   * the first and last block it was seen in, so per-block passes measure how long gaps stay open.
   * "aave" episodes use the real premium and get a fresh re-quote and a simulation; "fee-free"
   * episodes are the counterfactual without the premium and are only counted.
   */
  private async processEpisodes(rt: ChainRuntime, evals: RouteEval[], block: bigint) {
    const c = rt.cfg;
    const evaluated = new Set(evals.map((e) => e.route.gapKey));
    for (const kind of ["aave", "fee-free"] as const) {
      const value = (e: RouteEval) => (kind === "aave" ? e.best?.netUsd : e.bestFeeFreeNetUsd);
      const qualifying = new Map<string, RouteEval>();
      for (const ev of evals) {
        const ok = kind === "aave" ? ev.qualifies : ev.feeFreeQualifies;
        if (!ok) continue;
        const prev = qualifying.get(ev.route.gapKey);
        if (!prev || value(ev)! > value(prev)!) qualifying.set(ev.route.gapKey, ev);
      }
      for (const ep of [...this.episodes.values()]) {
        if (ep.kind === kind && ep.chain === c.name && evaluated.has(ep.gapKey) && !qualifying.has(ep.gapKey)) this.closeEpisode(ep);
      }
      for (const [gapKey, ev] of qualifying) {
        const key = `${kind}|${gapKey}`;
        const existing = this.episodes.get(key);
        if (existing) {
          if (String(block) !== existing.lastBlock) existing.sightings++;
          existing.lastSeen = new Date().toISOString();
          existing.lastBlock = String(block);
          existing.blocksOpen = Number(block - BigInt(existing.firstBlock)) + 1;
          existing.bestNetUsd = Math.max(existing.bestNetUsd, value(ev)!);
          continue;
        }
        const ep: Episode = {
          kind,
          gapKey,
          chain: c.name,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          firstBlock: String(block),
          lastBlock: String(block),
          blocksOpen: 1,
          sightings: 1,
          bestNetUsd: value(ev)!,
          routeId: ev.route.id,
          open: true,
        };
        this.episodes.set(key, ep);
        if (kind === "aave") {
          this.log("opportunity", `NEW ${ev.route.id} size $${ev.best!.sizeUsd} quoted net $${fmt(ev.best!.netUsd!, 4)} @${block}`, c.name);
          await this.freshCheck(rt, ev, ep, block);
        } else {
          this.log("info", `fee-free counterfactual gap ${ev.route.id} net $${fmt(value(ev)!, 4)} without the Aave premium @${block}`, c.name);
        }
        this.emit("opportunity", ep);
      }
    }
  }

  /**
   * Per-block passes between full sweeps: re-quote only the hot routes on every new block, as fast
   * as the RPC allows, to catch short-lived gaps and measure how many blocks they last.
   */
  private async hotLoop(rt: ChainRuntime, until: number) {
    while (this.running && Date.now() < until && rt.hotRoutes.length) {
      const block = (await rt.client.getBlockNumber()) - 1n;
      if (block <= rt.lastHotBlock) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const t0 = Date.now();
      const { evals } = await this.evaluate(rt, rt.hotRoutes, block, false, true, true);
      const ms = Date.now() - t0;
      rt.hot.passes++;
      rt.hot.ms += ms;
      rt.hot.blocksSkipped += Number(block - rt.lastHotBlock - 1n);
      rt.lastHotBlock = block;
      rt.lastBlock = block;
      for (const ev of evals) {
        if (!ev.best) continue;
        rt.hot.routeEvals++;
        bump(rt.hot.outcomes, ev.outcome);
        if (!rt.bestEver?.best || ev.best.netUsd! > rt.bestEver.best.netUsd!) rt.bestEver = ev;
        if (ev.bestFeeFreeNetUsd !== undefined && (rt.bestFeeFreeUsd === undefined || ev.bestFeeFreeNetUsd > rt.bestFeeFreeUsd)) {
          rt.bestFeeFreeUsd = ev.bestFeeFreeNetUsd;
          rt.bestFeeFreeRoute = ev.route.id;
        }
      }
      await this.processEpisodes(rt, evals, block);
      if (rt.hot.passes % 25 === 0) {
        this.log(
          "info",
          `per-block: ${rt.hot.passes} passes over ${rt.hotRoutes.length} hot routes, avg ${Math.round(rt.hot.ms / rt.hot.passes)} ms, ` +
            `${rt.hot.blocksSkipped} blocks skipped while busy; best net seen $${fmt(rt.bestEver?.best?.netUsd ?? NaN, 4)}, ` +
            `fee-free best $${fmt(rt.bestFeeFreeUsd ?? NaN, 4)}`,
          rt.cfg.name,
        );
      }
    }
  }

  private closeEpisode(ep: Episode) {
    if (!ep.open) return;
    ep.open = false;
    this.episodes.delete(`${ep.kind}|${ep.gapKey}`);
    this.closedEpisodes.push(ep);
    this.emit("episode_closed", ep);
  }

  /** Re-quote a newly spotted opportunity at a newer block, then simulate it if it still qualifies. */
  private async freshCheck(rt: ChainRuntime, ev: RouteEval, ep: Episode, block: bigint) {
    let next = block;
    for (let i = 0; i < 20 && next <= block; i++) {
      await new Promise((r) => setTimeout(r, 500));
      next = (await rt.client.getBlockNumber()) - 1n;
    }
    if (next <= block) {
      ep.freshQuote = { block: String(next), netUsd: null, qualifies: false, note: "no newer block within 10 s" };
      return;
    }
    const { evals } = await this.evaluate(rt, [ev.route], next, true);
    const f = evals[0];
    ep.freshQuote = {
      block: String(next),
      netUsd: f.best?.netUsd ?? null,
      qualifies: Boolean(f.best && f.qualifies),
      note: f.best ? f.outcome : f.skip,
    };
    this.log(
      "opportunity",
      `fresh quote @${next}: ${f.best ? `net $${fmt(f.best.netUsd!)} -> ${f.qualifies ? "STILL QUALIFIES" : "no longer qualifies"}` : f.skip}`,
      rt.cfg.name,
    );
    if (f.best && f.qualifies) ep.simulation = await this.simulate(rt, f, "qualifying-opportunity");
  }

  /**
   * Execute the route through FlashArbReceiverV3.simulate() with eth_call at the quote's block.
   * The receiver's code is injected at SIM_RECEIVER by state override, so nothing is deployed and
   * nothing is signed. Leg minimums are 1 so the call reports the true proceeds even on a loser.
   */
  private async simulate(rt: ChainRuntime, ev: RouteEval, purpose: SimRecord["purpose"]): Promise<SimRecord> {
    const s = ev.best!;
    const art = receiverArtifact();
    const data = encodeRun("simulate", ev.route.borrow, s.amount, this.legsFor(ev.route, 1n, 1n), 1n);
    const r = await rawCall(rt.client, {
      from: SIM_OWNER,
      to: SIM_RECEIVER,
      data,
      blockNumber: ev.block,
      gas: 30_000_000n,
      stateOverride: {
        [SIM_RECEIVER]: {
          code: art.deployedBytecode,
          stateDiff: {
            [pad("0x0", { size: 32 })]: pad(SIM_OWNER, { size: 32 }),
            [pad("0x1", { size: 32 })]: pad(rt.market!.pool, { size: 32 }),
          },
        },
      },
    });
    const rec: SimRecord = {
      ts: new Date().toISOString(),
      chain: rt.cfg.name,
      routeId: ev.route.id,
      block: String(ev.block),
      purpose,
      sizeUsd: s.sizeUsd,
      amount: String(s.amount),
      quotedLeg2Out: String(s.leg2Out),
      quotedNetTokens: String(s.netTokens),
      ok: false,
      gasUsedInside: "0",
      reason: "",
    };
    if (r.ok || !r.revertData) {
      rec.error = r.ok ? "simulate() returned without reverting" : r.error;
      rec.reason = "simulation call failed";
    } else {
      try {
        const out = decodeSimulation(r.revertData);
        rec.ok = out.ok;
        rec.gasUsedInside = String(out.gasUsed);
        rec.reason = out.ok ? "executed" : out.reason;
        if (out.ok) {
          rec.simProfit = String(out.profit);
          rec.simProceeds = String(out.profit + s.amount + s.premium);
        } else if (out.proceeds !== undefined) rec.simProceeds = String(out.proceeds);
        if (rec.simProceeds !== undefined) rec.proceedsMatchQuote = rec.simProceeds === rec.quotedLeg2Out;
      } catch (e) {
        rec.error = shortError(e);
        rec.reason = "undecodable revert";
      }
    }
    this.simulations.push(rec);
    if (this.simulations.length > 200) this.simulations.shift();
    this.log(
      "sim",
      `${purpose} ${ev.route.id} $${s.sizeUsd}: ${rec.ok ? `executed, profit ${rec.simProfit}` : rec.reason}` +
        (rec.proceedsMatchQuote !== undefined ? `; proceeds ${rec.proceedsMatchQuote ? "match" : "DIFFER from"} quote` : "") +
        `; gas inside ${rec.gasUsedInside}${rec.error ? `; ${rec.error}` : ""}`,
      rt.cfg.name,
    );
    this.emit("simulation", rec);
    return rec;
  }

  /**
   * Venue verification: for every venue with live pools on every chain (v4 split into native-ETH and
   * ERC20 pools), pick the route through it with the best marginal product, quote it in full and
   * run it through the receiver's simulate() at the same block. Proceeds equal to the quote show the
   * adapter's quote and the receiver's execution path agree against real chain state.
   */
  async verifyVenues(): Promise<{ chain: string; venue: string; rec?: SimRecord; note?: string }[]> {
    const out: { chain: string; venue: string; rec?: SimRecord; note?: string }[] = [];
    for (const rt of this.chains.values()) {
      if (!rt.market) await this.init(rt);
      const block = (await rt.client.getBlockNumber()) - 1n;
      await this.refreshPools(rt, block);
      const { evals } = await this.evaluate(rt, rt.routes, block);
      const groups = new Map<string, (p: PoolInfo) => boolean>();
      for (const p of rt.pools) {
        const name = p.venue.type === "v4" ? `${p.venue.id} (${p.native ? "native ETH" : "ERC20"})` : p.venue.id;
        if (!groups.has(name)) groups.set(name, (q) => q.venue.id === p.venue.id && (p.venue.type !== "v4" || !!q.native === !!p.native));
      }
      for (const [name, match] of groups) {
        const cands = evals
          .filter((e) => !e.skip && (match(e.route.first) || match(e.route.second)))
          .sort((a, b) => (b.marginalProduct ?? -1) - (a.marginalProduct ?? -1));
        let done = false;
        for (const cand of cands.slice(0, 3)) {
          const [f] = (await this.evaluate(rt, [cand.route], block, true)).evals;
          if (!f.best) continue;
          out.push({ chain: rt.cfg.name, venue: name, rec: await this.simulate(rt, f, "venue-verification") });
          done = true;
          break;
        }
        if (!done) out.push({ chain: rt.cfg.name, venue: name, note: cands.length ? "no route through this venue could be quoted at any size" : "no route" });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- reporting

  summary() {
    const chains: Record<string, unknown> = {};
    for (const [name, rt] of this.chains) {
      const top = [...rt.topRoutes.values()].sort((a, b) => b.best!.netUsd! - a.best!.netUsd!).slice(0, 10);
      chains[name] = {
        chainId: rt.cfg.chainId,
        cycles: rt.cycles,
        lastBlock: rt.lastBlock !== undefined ? String(rt.lastBlock) : null,
        lastCycleMs: rt.lastCycleMs ?? null,
        lastError: rt.lastError ?? null,
        pairs: rt.cfg.pairs.map(([a, b]) => `${a}/${b}`),
        venues: rt.cfg.venues.map((v) => v.id),
        venueSkips: rt.venueSkips,
        pools: rt.pools.map((p) => ({ label: p.label, pair: `${rt.symbols.get(p.token0)}/${rt.symbols.get(p.token1)}`, address: p.address, id: p.id })),
        poolSkips: rt.poolSkips,
        routes: rt.routes.length,
        routesQuotedEver: rt.routesQuotedEver.size,
        routesQuotedLastCycle: rt.routesQuotedLastCycle,
        routesPrunedLastCycle: rt.routesPrunedLastCycle,
        routesEvaluatedEver: rt.routesEvaluatedEver.size,
        boundChecks: rt.boundChecks,
        boundViolations: rt.boundViolations,
        quotesDominated: rt.quotesDominated,
        quotesCannotFill: rt.quotesCannotFill,
        perBlock: {
          hotRoutes: rt.hotRoutes.map((r) => r.id),
          passes: rt.hot.passes,
          avgMs: rt.hot.passes ? Math.round(rt.hot.ms / rt.hot.passes) : null,
          blocksSkipped: rt.hot.blocksSkipped,
          routeEvaluations: rt.hot.routeEvals,
          outcomes: Object.fromEntries([...rt.hot.outcomes].sort((a, b) => b[1] - a[1])),
        },
        bestFeeFreeUsd: rt.bestFeeFreeUsd ?? null,
        bestFeeFreeRoute: rt.bestFeeFreeRoute ?? null,
        quotesOk: rt.quotesOk,
        quotesFailed: rt.quotesFailed,
        skipCounts: Object.fromEntries([...rt.skipCounts].sort((a, b) => b[1] - a[1])),
        outcomeCounts: Object.fromEntries([...rt.outcomeCounts].sort((a, b) => b[1] - a[1])),
        bestEver: rt.bestEver ? serializeEval(rt, rt.bestEver) : null,
        bestLastCycle: rt.bestLastCycle ? serializeEval(rt, rt.bestLastCycle) : null,
        topRoutes: top.map((e) => serializeEval(rt, e)),
      };
    }
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      stoppedAt: this.stoppedAt ?? null,
      running: this.running,
      liveExecution: "disabled (not authorized; no wallet or key is loaded)",
      config: {
        loanSizesUsd: this.cfg.loanSizesUsd,
        minNetUsd: this.cfg.minNetUsd,
        hotRoutes: this.cfg.hotRoutes,
        dailyTargetUsd: this.cfg.dailyTargetUsd,
        intervalSeconds: this.cfg.intervalSeconds,
        gasModel: this.cfg.gasModel,
      },
      chains,
      openEpisodes: [...this.episodes.values()],
      closedEpisodes: this.closedEpisodes,
      simulations: this.simulations,
      trades: [] as unknown[],
    };
  }
}

/**
 * Quote failures that mean "this pool cannot carry this size": v4 NotEnoughLiquidity, partial fills
 * seen by the injected quoter, quotes needing more than the gas cap (hundreds of ticks crossed),
 * and QuoterV2's "Unexpected error", which on inspection is the pool's swap stopping short of the
 * exact input (re-running those through the injected quoter shows a partial fill).
 */
const LIQUIDITY_LIMITED = /NotEnoughLiquidity|did not fill the exact input|needs more than \d+M gas|Unexpected error/;

/** Collapse amounts in a reason so identical causes aggregate; keeps pool labels like "uniswap-v3:500". */
function normalizeReason(r: string): string {
  return r.replace(/(?<![:A-Za-z\d.])\d[\d,.]*/g, "N");
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function units(amount: bigint | undefined, dec: number): string | null {
  if (amount === undefined) return null;
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const s = a.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function serializeEval(rt: { decimals: Map<Address, number> }, ev: RouteEval) {
  const dB = rt.decimals.get(ev.route.borrow)!;
  const dM = rt.decimals.get(ev.route.mid)!;
  const size = (s: SizeEval) => ({
    sizeUsd: s.sizeUsd,
    borrowed: units(s.amount, dB),
    borrowedRaw: String(s.amount),
    leg1Out: units(s.leg1Out, dM),
    leg2Out: units(s.leg2Out, dB),
    grossTokens: units(s.grossTokens, dB),
    premium: units(s.premium, dB),
    netTokens: units(s.netTokens, dB),
    netTokensUsd: s.netTokensUsd ?? null,
    gasUnitsL2: s.gas ? String(s.gas.l2GasUnits) : null,
    gasUnitsL1: s.gas ? String(s.gas.l1GasUnits) : null,
    gasPriceGwei: s.gas ? Number(s.gas.gasPriceWei) / 1e9 : null,
    gasUsd: s.gasUsd ?? null,
    l1Usd: s.l1Usd ?? null,
    netUsd: s.netUsd ?? null,
    skip: s.skip ?? null,
  });
  return {
    routeId: ev.route.id,
    chain: ev.route.chain,
    pair: ev.route.pair,
    borrow: ev.route.borrowSym,
    via: ev.route.midSym,
    first: { label: ev.route.first.label, pool: ev.route.first.address, id: ev.route.first.id },
    second: { label: ev.route.second.label, pool: ev.route.second.address, id: ev.route.second.id },
    block: String(ev.block),
    outcome: ev.outcome || ev.skip || "",
    qualifies: ev.qualifies,
    best: ev.best ? size(ev.best) : null,
    sizes: ev.sizes.map(size),
  };
}
