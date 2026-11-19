// Sends real trades. Only used when LIVE=true. Has safety limits:
// - simulates with YOUR deployed contract right before sending, and skips if it fails
// - the contract itself reverts unless profit >= minProfit (you lose only gas)
// - caps gas per trade and per day, and stops after too many failed trades in a row
import { createWalletClient, encodeFunctionData, decodeFunctionResult, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadArtifact } from './abis.js';
import { revertReason } from './quote.js';
import { makeTransport } from './chain.js';

const FlashArb = loadArtifact('FlashArb');

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
    this.stopped = false;

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
    const owner = await this.client.readContract({ address: this.contract, abi: FlashArb.abi, functionName: 'owner' });
    if (getAddress(owner) !== this.account.address) {
      this.ready = false;
      this.why = `contract owner is ${owner}, not your wallet ${this.account.address}`;
    }
  }

  /** opp: { asset, amount, hops, profitRaw, profitUsd, ethUsd } */
  async tryTrade(opp) {
    if (!this.ready || this.stopped || this.busy) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.gasUsdToday = 0; }
    if (this.gasUsdToday >= this.s.maxGasUsdPerDay) { this.log(`daily gas limit reached ($${this.s.maxGasUsdPerDay}), skipping`); return null; }

    this.busy = true;
    try {
      const minProfit = BigInt(Math.floor(Number(opp.profitRaw) * this.s.minProfitShare));
      const args = [opp.asset, opp.amount, opp.hops, minProfit];

      // 1) Simulate with the real contract from your wallet.
      let gas;
      try {
        const { data } = await this.client.call({ account: this.account, to: this.contract, data: encodeFunctionData({ abi: FlashArb.abi, functionName: 'startArb', args }) });
        decodeFunctionResult({ abi: FlashArb.abi, functionName: 'startArb', data });
        gas = await this.client.estimateContractGas({ account: this.account, address: this.contract, abi: FlashArb.abi, functionName: 'startArb', args });
      } catch (e) {
        this.log(`live: simulation failed, not sending (${revertReason(e)})`);
        return null;
      }

      // 2) Check gas cost.
      const fees = await this.client.estimateFeesPerGas();
      const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
      const gasUsd = (Number(gas * maxFee) / 1e18) * opp.ethUsd + this.cfg.gas.l1FeeUsd;
      if (gasUsd > this.s.maxGasUsdPerTrade || gasUsd >= opp.profitUsd) {
        this.log(`live: gas $${gasUsd.toFixed(3)} too high for profit $${opp.profitUsd.toFixed(3)}, skipping`);
        return null;
      }

      // 3) Send.
      const hash = await this.wallet.writeContract({
        address: this.contract, abi: FlashArb.abi, functionName: 'startArb', args,
        gas: (gas * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      this.log(`live: sent ${hash}`);
      const r = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const paidUsd = (Number(r.gasUsed * r.effectiveGasPrice) / 1e18) * opp.ethUsd;
      this.gasUsdToday += paidUsd;
      if (r.status === 'success') {
        this.failsInARow = 0;
        this.log(`live: SUCCESS ${hash} gas $${paidUsd.toFixed(4)}`);
      } else {
        this.failsInARow++;
        this.log(`live: REVERTED ${hash} (lost gas $${paidUsd.toFixed(4)}), ${this.failsInARow} fail(s) in a row`);
        if (this.failsInARow >= this.s.maxFailsInARow) {
          this.stopped = true;
          this.log(`live: STOPPED after ${this.failsInARow} failed trades in a row. Restart to try again.`);
        }
      }
      return r;
    } catch (e) {
      this.log(`live: error ${revertReason(e)}`);
      return null;
    } finally {
      this.busy = false;
    }
  }
}
