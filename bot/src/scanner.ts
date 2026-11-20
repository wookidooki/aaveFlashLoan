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
  skip?: string;
}

export interface RouteEval {
  route: Route;
  block: bigint;
  sizes: SizeEval[];
  best?: SizeEval;
  outcome: string;
  qualifies: boolean;
  skip?: string;
}

export interface Episode {
  gapKey: string;
  chain: string;
  firstSeen: string;
  lastSeen: string;
  firstBlock: string;
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
  purpose: "qualifying-opportunity" | "best-route-evidence";
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
    if (!this.running) return;
    const wait = Math.max(1000, this.cfg.intervalSeconds * 1000 - rt.lastCycleMs);
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
        const { pools, skips } = await discoverPools(rt.client, v, c.assets[a], c.assets[b], `${a}/${b}`, block, depth);
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
            if (p.address === q.address) continue;
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
              gapKey: `${c.name}|${lo}|${hi}|buy@${buyLo.address}|sell@${sellLo.address}`,
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
      { kind: route.first.legKind, pool: route.first.address, tokenIn: route.borrow, tokenOut: route.mid, feeBps: route.first.feeBps, minOut: minOut1 },
      { kind: route.second.legKind, pool: route.second.address, tokenIn: route.mid, tokenOut: route.borrow, feeBps: route.second.feeBps, minOut: minOut2 },
    ];
  }

  /** Quote and cost a set of routes at one block. */
  async evaluate(rt: ChainRuntime, routes: Route[], block: bigint, exactL1 = false): Promise<{ evals: RouteEval[]; market: MarketState; prices: GasPrices }> {
    const c = rt.cfg;
    const gm = this.cfg.gasModel;
    const assetList = [...new Set(Object.values(c.assets))];
    const market = await readMarketState(rt.client, rt.market!, assetList, block);
    const prices = await readGasPrices(rt.client, c, block);
    const gasToken = c.assets[c.gasToken];
    const ethUsd = Number(market.assets.get(gasToken)!.priceUsd8) / 1e8;
    const v2Reserves = await readV2Reserves(rt.client, rt.pools, block);

    const evals: RouteEval[] = routes.map((route) => ({ route, block, sizes: [], outcome: "", qualifies: false }));

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
      for (const usd of this.cfg.loanSizesUsd) {
        const amount = this.loanAmount(rt, ev.route.borrow, s!.priceUsd8, usd);
        const size: SizeEval = { sizeUsd: usd, amount, premium: aaveV3Premium(amount, market.premiumBps) };
        ev.sizes.push(size);
        if (amount >= s!.availableLiquidity) {
          const d = rt.decimals.get(ev.route.borrow)!;
          size.skip = `Aave available liquidity ${units(s!.availableLiquidity, d)} < loan ${units(amount, d)} ${ev.route.borrowSym}`;
          continue;
        }
        const key = `${ev.route.first.address}|${ev.route.borrow}|${amount}`;
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
        const q1 = leg1[leg1Index.get(`${ev.route.first.address}|${ev.route.borrow}|${size.amount}`)!];
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

    // Screening L1 fee: computed once per cycle from a representative route's real calldata
    // (all 2-leg routes encode to the same length); recomputed exactly for routes that matter.
    let screeningL1: GasCost | undefined;
    const sample = evals.find((e) => e.sizes.some((s) => s.leg2Out !== undefined));
    if (sample) {
      const s = sample.sizes.find((x) => x.leg2Out !== undefined)!;
      const data = encodeRun("run", sample.route.borrow, s.amount, this.legsFor(sample.route, s.leg1Out!, s.leg2Out!), 1n);
      screeningL1 = await estimateTxCost(rt.client, c, prices, SIM_RECEIVER, data, 0n, block);
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
      }
      const quoted = ev.sizes.filter((s) => s.netUsd !== undefined);
      if (quoted.length) {
        ev.best = quoted.reduce((a, b) => (b.netUsd! > a.netUsd! ? b : a));
        if (exactL1) await this.exactCost(rt, ev, prices, block, ethUsd, market);
        ev.qualifies = ev.best.netUsd! >= this.cfg.benchmarkNetUsd;
        ev.outcome = this.classify(ev.best);
      } else if (!ev.skip) {
        ev.skip = ev.sizes.map((s) => s.skip).find(Boolean) ?? "no size quoted";
      }
    }
    return { evals, market, prices };
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
  }

  private classify(s: SizeEval): string {
    const lossBps = (Number(-s.grossTokens!) / Number(s.amount)) * 10000;
    if (lossBps > this.cfg.maxRoundTripLossBps) return `illiquid at this size: round trip loses more than ${this.cfg.maxRoundTripLossBps} bps`;
    if (s.grossTokens! <= 0n) return "no spread: swap fees + price impact exceed the price gap";
    if (s.netTokens! <= 0n) return "spread smaller than the Aave premium";
    if (s.netUsd! <= 0) return "covers the premium but not gas";
    if (s.netUsd! < this.cfg.benchmarkNetUsd) return "net positive but below the benchmark";
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
    for (const ev of evals) {
      if (ev.skip) bump(rt.skipCounts, `route: ${normalizeReason(ev.skip)}`);
      for (const s of ev.sizes) if (s.skip) bump(rt.skipCounts, `size: ${normalizeReason(s.skip)}`);
      rt.quotesFailed += ev.sizes.filter((s) => s.skip?.startsWith("leg")).length;
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
    const ranked = evals.filter((e) => e.best).sort((a, b) => b.best!.netUsd! - a.best!.netUsd!);
    rt.bestLastCycle = ranked[0];
    if (ranked[0] && (!rt.bestEver || ranked[0].best!.netUsd! > rt.bestEver.best!.netUsd!)) rt.bestEver = ranked[0];

    const b = ranked[0];
    this.log(
      "info",
      `block ${block}: ${quotedRoutes}/${evals.length} routes quoted in ${Date.now() - t0} ms; ` +
        (b ? `best ${b.route.id} $${b.best!.sizeUsd} net $${fmt(b.best!.netUsd!)} (${b.outcome})` : "no route quoted"),
      c.name,
    );
    this.emit("cycle", { chain: c.name, block: String(block), quoted: quotedRoutes, routes: evals.length, bestRoute: b?.route.id, bestNetUsd: b?.best?.netUsd });

    // Opportunity episodes: repeated sightings of the same gap count once.
    const qualifying = new Map<string, RouteEval>();
    for (const ev of ranked) if (ev.qualifies && !qualifying.has(ev.route.gapKey)) qualifying.set(ev.route.gapKey, ev);
    for (const ep of [...this.episodes.values()]) {
      if (ep.chain === c.name && !qualifying.has(ep.gapKey)) this.closeEpisode(ep);
    }
    for (const [key, ev] of qualifying) {
      const existing = this.episodes.get(key);
      if (existing) {
        existing.sightings++;
        existing.lastSeen = new Date().toISOString();
        existing.bestNetUsd = Math.max(existing.bestNetUsd, ev.best!.netUsd!);
        continue;
      }
      const ep: Episode = {
        gapKey: key,
        chain: c.name,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        firstBlock: String(block),
        sightings: 1,
        bestNetUsd: ev.best!.netUsd!,
        routeId: ev.route.id,
        open: true,
      };
      this.episodes.set(key, ep);
      this.log("opportunity", `NEW ${ev.route.id} size $${ev.best!.sizeUsd} quoted net $${fmt(ev.best!.netUsd!)} @${block}`, c.name);
      await this.freshCheck(rt, ev, ep, block);
      this.emit("opportunity", ep);
    }

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

  private closeEpisode(ep: Episode) {
    if (!ep.open) return;
    ep.open = false;
    this.episodes.delete(ep.gapKey);
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
        pools: rt.pools.map((p) => ({ label: p.label, pair: `${rt.symbols.get(p.token0)}/${rt.symbols.get(p.token1)}`, address: p.address })),
        poolSkips: rt.poolSkips,
        routes: rt.routes.length,
        routesQuotedEver: rt.routesQuotedEver.size,
        routesQuotedLastCycle: rt.routesQuotedLastCycle,
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
        benchmarkNetUsd: this.cfg.benchmarkNetUsd,
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
    first: { label: ev.route.first.label, pool: ev.route.first.address },
    second: { label: ev.route.second.label, pool: ev.route.second.address },
    block: String(ev.block),
    outcome: ev.outcome || ev.skip || "",
    qualifies: ev.qualifies,
    best: ev.best ? size(ev.best) : null,
    sizes: ev.sizes.map(size),
  };
}
