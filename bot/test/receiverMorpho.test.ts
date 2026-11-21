// Morpho flavour of the receiver: zero-fee flash loan, repay exactly the principal.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { v2AmountOut } from "../src/quote/amm.ts";
import { LEG_KIND, decodeSimulation, encodeRun, revertData, type LegArg } from "../src/sim/receiver.ts";

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [ownerWallet, attackerWallet] = await viem.getWalletClients();

const USDC = (n: string) => parseUnits(n, 6);
const WETH = (n: string) => parseUnits(n, 18);
const LOAN = USDC("1000");

async function deploy() {
  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const weth = await viem.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const morpho = await viem.deployContract("MockMorpho");
  const v2 = await viem.deployContract("MockV2Pair", [usdc.address, weth.address]); // ETH at 2,000
  const cl = await viem.deployContract("MockCLPool", [weth.address, usdc.address, 0]); // ETH at 2,030
  await usdc.write.mint([v2.address, USDC("2000000")]);
  await weth.write.mint([v2.address, WETH("1000")]);
  await v2.write.sync();
  await usdc.write.mint([cl.address, USDC("2030000")]);
  await weth.write.mint([cl.address, WETH("1000")]);
  await usdc.write.mint([morpho.address, USDC("10000000")]);
  const receiver = await viem.deployContract("FlashArbReceiverMorpho", [morpho.address]);
  return { usdc, weth, morpho, v2, cl, receiver };
}
type Fx = Awaited<ReturnType<typeof deploy>>;

async function route(fx: Fx, reverse = false) {
  const [r0, r1] = await fx.v2.read.getReserves(); // token0 = usdc, token1 = weth
  if (!reverse) {
    const wethOut = v2AmountOut(LOAN, r0, r1, 30n);
    const usdcOut = await fx.cl.read.quote([true, wethOut]);
    const legs: LegArg[] = [
      { kind: LEG_KIND.v2, pool: fx.v2.address, tokenIn: fx.usdc.address, tokenOut: fx.weth.address, feeBps: 30, minOut: wethOut, data: "0x" },
      { kind: LEG_KIND.clUniswapCallback, pool: fx.cl.address, tokenIn: fx.weth.address, tokenOut: fx.usdc.address, feeBps: 0, minOut: usdcOut, data: "0x" },
    ];
    return { legs, usdcOut };
  }
  const wethOut = await fx.cl.read.quote([false, LOAN]);
  const usdcOut = v2AmountOut(wethOut, r1, r0, 30n);
  const legs: LegArg[] = [
    { kind: LEG_KIND.clUniswapCallback, pool: fx.cl.address, tokenIn: fx.usdc.address, tokenOut: fx.weth.address, feeBps: 0, minOut: wethOut, data: "0x" },
    { kind: LEG_KIND.v2, pool: fx.v2.address, tokenIn: fx.weth.address, tokenOut: fx.usdc.address, feeBps: 30, minOut: usdcOut, data: "0x" },
  ];
  return { legs, usdcOut };
}

describe("FlashArbReceiverMorpho", () => {
  let fx: Fx;
  beforeEach(async () => {
    fx = await networkHelpers.loadFixture(deploy);
  });

  it("profitable route keeps exactly the quoted profit; Morpho gets back exactly the principal", async () => {
    const r = await route(fx);
    const profit = r.usdcOut - LOAN; // no premium
    assert.ok(profit > 0n, "fixture gap must beat swap fees without a lender fee");
    const morphoBefore = await fx.usdc.read.balanceOf([fx.morpho.address]);
    await fx.receiver.write.run([fx.usdc.address, LOAN, r.legs, profit]);
    assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), profit);
    assert.equal(await fx.usdc.read.balanceOf([fx.morpho.address]), morphoBefore);
  });

  it("losing route reverts with InsufficientProceeds even when the receiver is pre-funded", async () => {
    const r = await route(fx, true);
    assert.ok(r.usdcOut < LOAN);
    await fx.usdc.write.mint([fx.receiver.address, USDC("50000")]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      fx.receiver.write.run([fx.usdc.address, LOAN, r.legs, 1n]),
      fx.receiver,
      "InsufficientProceeds",
      [r.usdcOut, LOAN + 1n],
    );
    assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), USDC("50000"));
  });

  it("rejects callbacks from anyone but Morpho", async () => {
    await viem.assertions.revertWithCustomError(
      fx.receiver.write.onMorphoFlashLoan([LOAN, "0x"], { account: attackerWallet.account }),
      fx.receiver,
      "NotPool",
    );
  });

  it("rejects a lender callback for a loan it did not start", async () => {
    // Receiver whose configured lender is the attacker: passes the sender check, must still refuse.
    const r2 = await viem.deployContract("FlashArbReceiverMorpho", [attackerWallet.account.address]);
    await viem.assertions.revertWithCustomError(
      r2.write.onMorphoFlashLoan([LOAN, "0x"], { account: attackerWallet.account }),
      r2,
      "NotInitiated",
    );
  });

  it("simulate() reports the exact profit for a winner and InsufficientProceeds for a loser", async () => {
    const win = await route(fx);
    const lose = await route(fx, true);
    const sim = (legs: LegArg[]) =>
      publicClient
        .call({ account: ownerWallet.account.address, to: fx.receiver.address, data: encodeRun("simulate", fx.usdc.address, LOAN, legs, 1n) })
        .then(
          () => assert.fail("simulate must revert"),
          (e) => decodeSimulation(revertData(e)!),
        );
    const w = await sim(win.legs);
    assert.equal(w.ok, true);
    assert.equal(w.profit, win.usdcOut - LOAN);
    const l = await sim(lose.legs.map((x) => ({ ...x, minOut: 1n })));
    assert.equal(l.ok, false);
    assert.equal(l.proceeds, lose.usdcOut);
  });
});
