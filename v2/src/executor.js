// Sends real trades. Only used when LIVE=true. Safety limits:
// - simulates (gas estimate) with YOUR deployed contract right before sending, skips if it fails
// - the contract reverts unless profit >= minProfit, and minProfit always covers the gas cost
// - pays a priority fee (tip) from the expected profit, so the trade is not last in the block
// - caps gas per trade and per day; pauses after too many failed trades in a row
// - a sent trade with unknown result counts as a failure, and blocks new trades until it is known
import { createWalletClient, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadArtifact } from './abis.js';
import { revertReason, startFn } from './quote.js';
import { makeTransport } from './chain.js';

const FlashArb = loadArtifact('FlashArb');
const MIN_TIP = 1_000_000n; // 0.001 gwei

export class Executor {
  constructor(key, cfg, client, settings, log, transport) {
    this.key = key;
    this.cfg = cfg;
    this.client = client;
    this.s = settings;
    this.log = log;
    this.busy = false;
    this.failsInARow = 0;
    this.gasUsdToday = 0;
    this.day = new Date().toISOString().slice(0, 10);
    this.pausedUntil = 0;
    this.pending = null; // { hash, worstUsd } of a sent trade whose result we do not know yet
    this.nonce = undefined;

    const pk = process.env.PRIVATE_KEY;
    const addr = process.env[`FLASH_ARB_${key.toUpperCase()}`];
    if (!pk || !addr) {
      this.ready = false;
      this.why = `set PRIVATE_KEY and FLASH_ARB_${key.toUpperCase()} in .env`;
      return;
    }
    this.account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
    this.contract = getAddress(addr);
    this.wallet = createWalletClient({ account: this.account, chain: client.chain, transport: transport || makeTransport(key, cfg) });
    this.ready = true;
  }

  async init() {
    if (!this.ready) return;
    const read = (functionName) => this.client.readContract({ address: this.contract, abi: FlashArb.abi, functionName });
    const owner = await read('owner');
    if (getAddress(owner) !== this.account.address) {
      this.ready = false;
      this.why = `contract owner is ${owner}, not your wallet ${this.account.address}`;
      return;
    }
    let morpho;
    try {
      morpho = await read('morpho');
    } catch {
      this.ready = false;
      this.why = 'contract is an old version without Morpho support: deploy it again (npm run deploy)';
      return;
    }
    if (getAddress(morpho) !== getAddress(this.cfg.morpho ?? zeroAddress)) {
      this.ready = false;
      this.why = `contract uses Morpho ${morpho}, config says ${this.cfg.morpho}: deploy it again`;
    }
  }

  /** Clears a pending trade once its receipt is known. Returns true if we may send. */
  async checkPending() {
    if (!this.pending) return true;
    try {
      const r = await this.client.getTransactionReceipt({ hash: this.pending.hash });
      this.log(`live: earlier trade ${this.pending.hash} is now known: ${r.status}`);
      if (r.status === 'success') this.failsInARow = Math.max(0, this.failsInARow - 1); // it was counted as a failure
      this.pending = null;
      this.nonce = undefined; // re-read from chain
      return true;
    } catch {
      return false; // still unknown
    }
  }

  /** opp: { source, asset, amount, hops, profitRaw, profitUsd, ethUsd, assetUsd, decimals } */
  async tryTrade(opp) {
    if (!this.ready || this.busy) return null;
    if (Date.now() < this.pausedUntil) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.gasUsdToday = 0; }
    if (this.gasUsdToday >= this.s.maxGasUsdPerDay) { this.log(`live: daily gas limit reached ($${this.s.maxGasUsdPerDay}), skipping`); return null; }

    this.busy = true;
    try {
      if (!(await this.checkPending())) { this.log('live: earlier trade result still unknown, skipping'); return null; }
      const fn = startFn(opp.source);
      const shareMin = BigInt(Math.floor(Number(opp.profitRaw) * this.s.minProfitShare));

      // 1) Gas estimate = simulation with the real contract from your wallet (reverts if not profitable).
      let gas, block;
      try {
        [gas, block] = await Promise.all([
          this.client.estimateContractGas({ account: this.account, address: this.contract, abi: FlashArb.abi, functionName: fn, args: [opp.asset, opp.amount, opp.hops, shareMin] }),
          this.client.getBlock(),
          this.nonce === undefined ? this.client.getTransactionCount({ address: this.account.address, blockTag: 'pending' }).then((n) => { this.nonce = n; }) : null,
        ]);
      } catch (e) {
        this.log(`live: simulation failed, not sending (${revertReason(e)})`);
        return null;
      }

      // 2) Fees. Tip = a share of the expected profit (Base orders by tip), within the per-trade cap.
      const toWei = (usd) => BigInt(Math.max(0, Math.floor((usd / opp.ethUsd) * 1e18)));
      const baseFee = block.baseFeePerGas ?? 0n;
      const gasLimit = (gas * 12n) / 10n;
      let tip = (toWei(opp.profitUsd * this.s.tipProfitShare)) / gas;
      const tipCap = toWei(this.s.maxGasUsdPerTrade - this.cfg.gas.l1FeeUsd) / gasLimit - baseFee * 2n;
      if (tip > tipCap) tip = tipCap;
      if (tip < MIN_TIP) tip = MIN_TIP;
      const maxFeePerGas = baseFee * 2n + tip;
      const gasUsd = (Number(gas * (baseFee + tip)) / 1e18) * opp.ethUsd + this.cfg.gas.l1FeeUsd;
      const worstUsd = (Number(gasLimit * maxFeePerGas) / 1e18) * opp.ethUsd + this.cfg.gas.l1FeeUsd;
      if (worstUsd > this.s.maxGasUsdPerTrade || opp.profitUsd - gasUsd < this.s.minProfitUsd) {
        this.log(`live: gas $${gasUsd.toFixed(3)} (max $${worstUsd.toFixed(3)}) vs profit $${opp.profitUsd.toFixed(3)}: not worth it, skipping`);
        return null;
      }

      // 3) On-chain floor: at least the share of profit AND enough to pay the gas (+20%).
      const gasInAsset = BigInt(Math.ceil(((gasUsd * 1.2) / opp.assetUsd) * 10 ** opp.decimals));
      const minProfit = shareMin > gasInAsset ? shareMin : gasInAsset;
      if (minProfit >= opp.profitRaw) {
        this.log('live: profit does not cover gas with margin, skipping');
        return null;
      }

      // 4) Send.
      let hash;
      try {
        hash = await this.wallet.writeContract({
          address: this.contract, abi: FlashArb.abi, functionName: fn, args: [opp.asset, opp.amount, opp.hops, minProfit],
          gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip, nonce: this.nonce,
        });
      } catch (e) {
        this.nonce = undefined; // we do not know if it went out; re-read the nonce next time
        this.log(`live: send failed (${revertReason(e)})`);
        return null;
      }
      this.nonce++;
      this.log(`live: sent ${hash} (tip ${Number(tip) / 1e9} gwei, minProfit covers gas)`);

      let r;
      try {
        r = await this.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      } catch {
        // Unknown result: count it as a failure with the worst-case gas, block new trades until known.
        this.pending = { hash, worstUsd };
        this.gasUsdToday += worstUsd;
        this.fail(`result unknown for ${hash}, counted as a failure`);
        return null;
      }
      const l1 = r.l1Fee ?? 0n; // OP-stack chains (Base) charge an extra L1 data fee
      const paidUsd = (Number(r.gasUsed * r.effectiveGasPrice + l1) / 1e18) * opp.ethUsd;
      this.gasUsdToday += paidUsd;
      if (r.status === 'success') {
        this.failsInARow = 0;
        this.log(`live: SUCCESS ${hash} gas $${paidUsd.toFixed(4)}`);
      } else {
        this.fail(`REVERTED ${hash} (lost gas $${paidUsd.toFixed(4)})`);
      }
      return r;
    } catch (e) {
      this.log(`live: error ${revertReason(e)}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  fail(msg) {
    this.failsInARow++;
    this.log(`live: ${msg}, ${this.failsInARow} fail(s) in a row`);
    if (this.failsInARow >= this.s.maxFailsInARow) {
      this.pausedUntil = Date.now() + this.s.pauseMinAfterFails * 60000;
      this.failsInARow = 0;
      this.log(`live: PAUSED for ${this.s.pauseMinAfterFails} min after ${this.s.maxFailsInARow} failed trades in a row`);
    }
  }
}
