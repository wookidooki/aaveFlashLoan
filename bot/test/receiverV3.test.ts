// Local tests for the Aave v3 receiver used by the scanner's same-block simulation (and, only if
// the operator authorizes it later, live execution). Mocks: Aave v3 flashLoanSimple, a v2 pair and
// a callback-style concentrated pool.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, type Address } from "viem";
import { aaveV3Premium, v2AmountOut } from "../src/quote/amm.ts";
import { LEG_KIND, decodeSimulation, encodeRun, revertData, type LegArg } from "../src/sim/receiver.ts";

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [ownerWallet, lpWallet, attackerWallet] = await viem.getWalletClients();

const USDC = (n: string) => parseUnits(n, 6);
const WETH = (n: string) => parseUnits(n, 18);
const LOAN = USDC("10000");

async function deploy() {
  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const weth = await viem.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const aave = await viem.deployContract("MockAaveV3Pool");
  // token0/token1 ordering as passed (the receiver reads it from the pool).
  const v2 = await viem.deployContract("MockV2Pair", [usdc.address, weth.address]); // ETH at 2,000
  const cl = await viem.deployContract("MockCLPool", [weth.address, usdc.address, 0]); // ETH at 2,100
  const clPancake = await viem.deployContract("MockCLPool", [weth.address, usdc.address, 1]); // ETH at 2,100

  await usdc.write.mint([v2.address, USDC("2000000")]);
  await weth.write.mint([v2.address, WETH("1000")]);
  await v2.write.sync();
  for (const p of [cl, clPancake]) {
    await usdc.write.mint([p.address, USDC("2100000")]);
    await weth.write.mint([p.address, WETH("1000")]);
  }
  await usdc.write.mint([aave.address, USDC("5000000")]);

  const receiver = await viem.deployContract("FlashArbReceiverV3", [aave.address]);
  return { usdc, weth, aave, v2, cl, clPancake, receiver };
}

type Fx = Awaited<ReturnType<typeof deploy>>;

async function quoteV2(fx: Fx, amountIn: bigint, tokenIn: Address) {
  const [r0, r1] = await fx.v2.read.getReserves();
  const usdcIsIn = tokenIn === fx.usdc.address;
  return usdcIsIn ? v2AmountOut(amountIn, r0, r1, 30n) : v2AmountOut(amountIn, r1, r0, 30n);
}

async function profitableRoute(fx: Fx, clPool = fx.cl, kind: number = LEG_KIND.clUniswapCallback) {
  const wethOut = await quoteV2(fx, LOAN, fx.usdc.address);
  const usdcOut = await clPool.read.quote([true, wethOut]); // WETH is token0 of the CL mock
  const premium = aaveV3Premium(LOAN, 5n);
  const legs: LegArg[] = [
    { kind: LEG_KIND.v2, pool: fx.v2.address, tokenIn: fx.usdc.address, tokenOut: fx.weth.address, feeBps: 30, minOut: wethOut, data: "0x" },
    { kind, pool: clPool.address, tokenIn: fx.weth.address, tokenOut: fx.usdc.address, feeBps: 0, minOut: usdcOut, data: "0x" },
  ];
  return { legs, wethOut, usdcOut, premium, profit: usdcOut - LOAN - premium };
}

describe("FlashArbReceiverV3", () => {
  let fx: Fx;
  beforeEach(async () => {
    fx = await networkHelpers.loadFixture(deploy);
  });

  for (const variant of ["uniswap-callback", "pancake-callback"] as const) {
    it(`profitable v2 -> CL (${variant}) route keeps exactly the quoted profit, starting from zero`, async () => {
      const pool = variant === "uniswap-callback" ? fx.cl : fx.clPancake;
      const kind = variant === "uniswap-callback" ? LEG_KIND.clUniswapCallback : LEG_KIND.clPancakeCallback;
      const r = await profitableRoute(fx, pool, kind);
      assert.ok(r.profit > 0n);
      assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), 0n);
      const aaveBefore = await fx.usdc.read.balanceOf([fx.aave.address]);

      await fx.receiver.write.run([fx.usdc.address, LOAN, r.legs, r.profit]);

      assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), r.profit);
      assert.equal(await fx.usdc.read.balanceOf([fx.aave.address]), aaveBefore + r.premium);
      assert.equal(await fx.weth.read.balanceOf([fx.receiver.address]), 0n);
    });
  }

  it("losing route reverts with InsufficientProceeds even when the receiver is pre-funded", async () => {
    // Reverse direction: buy WETH on the expensive CL pool, sell it on the cheap v2 pair.
    const wethOut = await fx.cl.read.quote([false, LOAN]);
    const usdcOut = await quoteV2(fx, wethOut, fx.weth.address);
    const premium = aaveV3Premium(LOAN, 5n);
    assert.ok(usdcOut < LOAN + premium);
    await fx.usdc.write.mint([fx.receiver.address, USDC("100000")]);
    const legs: LegArg[] = [
      { kind: LEG_KIND.clUniswapCallback, pool: fx.cl.address, tokenIn: fx.usdc.address, tokenOut: fx.weth.address, feeBps: 0, minOut: wethOut, data: "0x" },
      { kind: LEG_KIND.v2, pool: fx.v2.address, tokenIn: fx.weth.address, tokenOut: fx.usdc.address, feeBps: 30, minOut: usdcOut, data: "0x" },
    ];
    await viem.assertions.revertWithCustomErrorWithArgs(
      fx.receiver.write.run([fx.usdc.address, LOAN, legs, 1n]),
      fx.receiver,
      "InsufficientProceeds",
      [usdcOut, LOAN + premium + 1n],
    );
    assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), USDC("100000"));
  });

  it("a leg below its minimum output reverts with LegOutput", async () => {
    const r = await profitableRoute(fx);
    r.legs[0].minOut = r.wethOut + 1n;
    await viem.assertions.revertWithCustomErrorWithArgs(
      fx.receiver.write.run([fx.usdc.address, LOAN, r.legs, 1n]),
      fx.receiver,
      "LegOutput",
      [0n, r.wethOut, r.wethOut + 1n],
    );
  });

  it("simulate() always reverts: ok + exact profit for a winner, the inner reason for a loser, no state change", async () => {
    const r = await profitableRoute(fx);
    const call = (minSurplus: bigint) =>
      publicClient
        .call({ account: ownerWallet.account.address, to: fx.receiver.address, data: encodeRun("simulate", fx.usdc.address, LOAN, r.legs, minSurplus) })
        .then(
          () => assert.fail("simulate must revert"),
          (e) => decodeSimulation(revertData(e)!),
        );
    const win = await call(1n);
    assert.equal(win.ok, true);
    assert.equal(win.profit, r.profit);
    assert.ok(win.gasUsed > 50_000n);

    const lose = await call(r.profit + 1n);
    assert.equal(lose.ok, false);
    assert.equal(lose.proceeds, r.usdcOut);
    assert.match(lose.reason, /^InsufficientProceeds/);
    assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), 0n);
  });

  describe("authentication and validation", () => {
    it("only the owner can run or simulate", async () => {
      const r = await profitableRoute(fx);
      for (const fn of ["run", "simulate"] as const) {
        await viem.assertions.revertWithCustomError(
          fx.receiver.write[fn]([fx.usdc.address, LOAN, r.legs, 1n], { account: attackerWallet.account }),
          fx.receiver,
          "NotOwner",
        );
      }
    });

    it("executeOperation rejects callers other than the Aave pool", async () => {
      await viem.assertions.revertWithCustomError(
        fx.receiver.write.executeOperation([fx.usdc.address, LOAN, 5n, fx.receiver.address, "0x"], { account: attackerWallet.account }),
        fx.receiver,
        "NotPool",
      );
    });

    it("executeOperation rejects loans initiated by anyone else", async () => {
      const r = await profitableRoute(fx);
      const { encodeAbiParameters } = await import("viem");
      const params = encodeAbiParameters(
        [
          { type: "tuple[]", components: [
            { name: "kind", type: "uint8" }, { name: "pool", type: "address" }, { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" }, { name: "feeBps", type: "uint16" }, { name: "minOut", type: "uint256" },
            { name: "data", type: "bytes" },
          ] },
          { type: "uint256" },
        ],
        [r.legs, 1n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        fx.aave.write.flashLoanSimple([fx.receiver.address, fx.usdc.address, LOAN, params, 0], { account: attackerWallet.account }),
        fx.receiver,
        "BadInitiator",
        [attackerWallet.account.address],
      );
    });

    it("swap callbacks are rejected outside an active swap", async () => {
      await fx.usdc.write.mint([fx.receiver.address, USDC("1")]);
      for (const fn of ["uniswapV3SwapCallback", "pancakeV3SwapCallback"] as const) {
        await viem.assertions.revertWithCustomError(
          fx.receiver.write[fn]([1n, 0n, "0x"], { account: attackerWallet.account }),
          fx.receiver,
          "BadCallback",
        );
      }
    });

    it("rejects zero minimums and broken routes", async () => {
      const r = await profitableRoute(fx);
      await viem.assertions.revertWithCustomError(fx.receiver.write.run([fx.usdc.address, LOAN, r.legs, 0n]), fx.receiver, "ZeroMinimum");
      const zeroLeg = r.legs.map((l, i) => (i === 1 ? { ...l, minOut: 0n } : l));
      await viem.assertions.revertWithCustomError(fx.receiver.write.run([fx.usdc.address, LOAN, zeroLeg, 1n]), fx.receiver, "ZeroMinimum");
      await viem.assertions.revertWithCustomError(fx.receiver.write.run([fx.weth.address, LOAN, r.legs, 1n]), fx.receiver, "BadRoute");
      await viem.assertions.revertWithCustomError(fx.receiver.write.run([fx.usdc.address, LOAN, [r.legs[0]], 1n]), fx.receiver, "BadRoute");
    });

    it("rejects a leg whose pool does not trade that token pair", async () => {
      const r = await profitableRoute(fx);
      const other = await viem.deployContract("MockERC20", ["Other", "OTH", 18]);
      const bad = r.legs.map((l, i) => (i === 0 ? { ...l, tokenOut: other.address } : i === 1 ? { ...l, tokenIn: other.address } : l));
      await viem.assertions.revertWithCustomErrorWithArgs(
        fx.receiver.write.run([fx.usdc.address, LOAN, bad, 1n]),
        fx.receiver,
        "PoolTokenMismatch",
        [0n],
      );
    });

    it("only the owner can withdraw", async () => {
      await viem.assertions.revertWithCustomError(
        fx.receiver.write.withdraw([fx.usdc.address, attackerWallet.account.address], { account: attackerWallet.account }),
        fx.receiver,
        "NotOwner",
      );
      void lpWallet;
    });
  });
});
