// Uniswap v4 (native ETH and ERC20 pools), Algebra callback legs, and the injected CL quoter.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther, parseUnits, zeroAddress, type Address } from "viem";
import { aaveV3Premium, v2AmountOut } from "../src/quote/amm.ts";
import { LEG_KIND, encodeV4LegData, type LegArg, type V4PoolKey } from "../src/sim/receiver.ts";

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [ownerWallet, attackerWallet] = await viem.getWalletClients();

const USDC = (n: string) => parseUnits(n, 6);
const LOAN_USDC = USDC("10000");
const LOAN_WETH = parseEther("5");

/** Constant-product quote with a fee in pips, as MockPoolManager prices. */
const cpOut = (amountIn: bigint, rIn: bigint, rOut: bigint, feePips: bigint) => {
  const inWithFee = amountIn * (1_000_000n - feePips);
  return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee);
};

async function deploy() {
  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const weth = await viem.deployContract("MockWETH");
  const aave = await viem.deployContract("MockAaveV3Pool");
  const pm = await viem.deployContract("MockPoolManager");
  const v2 = await viem.deployContract("MockV2Pair", [usdc.address, weth.address]); // ETH at 2,000
  const algebra = await viem.deployContract("MockCLPool", [weth.address, usdc.address, 2]); // ETH at 2,100

  // v2 pair and algebra pool reserves
  await usdc.write.mint([v2.address, USDC("2000000")]);
  await weth.write.deposit({ value: parseEther("2000") });
  await weth.write.transfer([v2.address, parseEther("1000")]);
  await v2.write.sync();
  await usdc.write.mint([algebra.address, USDC("2100000")]);
  await weth.write.transfer([algebra.address, parseEther("1000")]);

  // v4 pools: native ETH at 2,100 (fee 3000) and 1,900 (fee 500); ERC20 WETH/USDC at 2,100 (fee 100)
  const [c0, c1] = weth.address.toLowerCase() < usdc.address.toLowerCase() ? [weth.address, usdc.address] : [usdc.address, weth.address];
  const nativeHigh: V4PoolKey = { currency0: zeroAddress, currency1: usdc.address, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const nativeLow: V4PoolKey = { currency0: zeroAddress, currency1: usdc.address, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const erc20: V4PoolKey = { currency0: c0, currency1: c1, fee: 100, tickSpacing: 1, hooks: zeroAddress };
  await usdc.write.mint([pm.address, USDC("2100000") + USDC("1900000") + USDC("2100000")]);
  await pm.write.initialize([nativeHigh, parseEther("1000"), USDC("2100000")], { value: parseEther("1000") });
  await pm.write.initialize([nativeLow, parseEther("1000"), USDC("1900000")], { value: parseEther("1000") });
  await weth.write.deposit({ value: parseEther("1000") });
  await weth.write.transfer([pm.address, parseEther("1000")]);
  const erc20Wethis0 = c0 === weth.address;
  await pm.write.initialize([erc20, erc20Wethis0 ? parseEther("1000") : USDC("2100000"), erc20Wethis0 ? USDC("2100000") : parseEther("1000")]);

  // Aave liquidity in both assets
  await usdc.write.mint([aave.address, USDC("5000000")]);
  await weth.write.deposit({ value: parseEther("100") });
  await weth.write.transfer([aave.address, parseEther("100")]);

  const receiver = await viem.deployContract("FlashArbReceiverV3", [aave.address]);
  return { usdc, weth, aave, pm, v2, algebra, receiver, nativeHigh, nativeLow, erc20, erc20Wethis0 };
}
type Fx = Awaited<ReturnType<typeof deploy>>;

async function v2Quote(fx: Fx, amountIn: bigint, tokenIn: Address) {
  const [r0, r1] = await fx.v2.read.getReserves(); // token0 = usdc, token1 = weth
  return tokenIn === fx.usdc.address ? v2AmountOut(amountIn, r0, r1, 30n) : v2AmountOut(amountIn, r1, r0, 30n);
}

const v2Leg = (fx: Fx, tokenIn: Address, tokenOut: Address, minOut: bigint): LegArg => ({
  kind: LEG_KIND.v2, pool: fx.v2.address, tokenIn, tokenOut, feeBps: 30, minOut, data: "0x",
});
const v4Leg = (fx: Fx, key: V4PoolKey, tokenIn: Address, tokenOut: Address, minOut: bigint): LegArg => ({
  kind: LEG_KIND.v4, pool: fx.pm.address, tokenIn, tokenOut, feeBps: 0, minOut, data: encodeV4LegData(key, fx.weth.address),
});

async function expectExactProfit(fx: Fx, asset: Address, loan: bigint, legs: LegArg[], quotedOut: bigint) {
  const token = asset === fx.usdc.address ? fx.usdc : fx.weth;
  const premium = aaveV3Premium(loan, 5n);
  const profit = quotedOut - loan - premium;
  assert.ok(profit > 0n, `route should be profitable, got ${profit}`);
  assert.equal(await token.read.balanceOf([fx.receiver.address]), 0n);
  await fx.receiver.write.run([asset, loan, legs, profit]);
  assert.equal(await token.read.balanceOf([fx.receiver.address]), profit, "keeps exactly the quoted profit");
  assert.equal(await publicClient.getBalance({ address: fx.receiver.address }), 0n, "no native ETH left behind");
  const other = token === fx.usdc ? fx.weth : fx.usdc;
  assert.equal(await other.read.balanceOf([fx.receiver.address]), 0n, "no intermediate token left behind");
}

describe("Uniswap v4 legs", () => {
  let fx: Fx;
  beforeEach(async () => {
    fx = await networkHelpers.loadFixture(deploy);
  });

  it("WETH in -> native ETH pool (unwrap, settle with value), then v2 back: exact profit", async () => {
    // borrow USDC, buy WETH cheap on v2, sell it as native ETH on the 2,100 pool
    const wethOut = await v2Quote(fx, LOAN_USDC, fx.usdc.address);
    const usdcOut = cpOut(wethOut, parseEther("1000"), USDC("2100000"), 3000n);
    await expectExactProfit(fx, fx.usdc.address, LOAN_USDC, [
      v2Leg(fx, fx.usdc.address, fx.weth.address, wethOut),
      v4Leg(fx, fx.nativeHigh, fx.weth.address, fx.usdc.address, usdcOut),
    ], usdcOut);
  });

  it("native ETH out (take, wrap to WETH), then v2 back: exact profit", async () => {
    // borrow USDC, buy ETH cheap on the 1,900 pool, sell WETH on v2 at 2,000
    const ethOut = cpOut(LOAN_USDC, USDC("1900000"), parseEther("1000"), 500n);
    const usdcOut = await v2Quote(fx, ethOut, fx.weth.address);
    await expectExactProfit(fx, fx.usdc.address, LOAN_USDC, [
      v4Leg(fx, fx.nativeLow, fx.usdc.address, fx.weth.address, ethOut),
      v2Leg(fx, fx.weth.address, fx.usdc.address, usdcOut),
    ], usdcOut);
  });

  it("ERC20/ERC20 pool (sync + transfer + settle, take ERC20): exact profit borrowing WETH", async () => {
    // reserves are 1,000 WETH / 2,100,000 USDC whichever currency sorts first
    const usdcOut = cpOut(LOAN_WETH, parseEther("1000"), USDC("2100000"), 100n);
    const wethOut = await v2Quote(fx, usdcOut, fx.usdc.address);
    await expectExactProfit(fx, fx.weth.address, LOAN_WETH, [
      v4Leg(fx, fx.erc20, fx.weth.address, fx.usdc.address, usdcOut),
      v2Leg(fx, fx.usdc.address, fx.weth.address, wethOut),
    ], wethOut);
  });

  it("rejects hooked pools", async () => {
    const hooked = { ...fx.nativeHigh, hooks: attackerWallet.account.address };
    const wethOut = await v2Quote(fx, LOAN_USDC, fx.usdc.address);
    await viem.assertions.revertWithCustomErrorWithArgs(
      fx.receiver.write.run([fx.usdc.address, LOAN_USDC, [v2Leg(fx, fx.usdc.address, fx.weth.address, wethOut), v4Leg(fx, hooked, fx.weth.address, fx.usdc.address, 1n)], 1n]),
      fx.receiver,
      "HookedPool",
      [attackerWallet.account.address],
    );
  });

  it("rejects unlock callbacks outside an active v4 leg", async () => {
    await viem.assertions.revertWithCustomError(
      fx.receiver.write.unlockCallback(["0x"], { account: attackerWallet.account }),
      fx.receiver,
      "BadCallback",
    );
  });

  it("rejects stray native ETH", async () => {
    await viem.assertions.revertWithCustomError(
      attackerWallet.sendTransaction({ to: fx.receiver.address, value: 1n }),
      fx.receiver,
      "UnexpectedEth",
    );
  });

  it("losing v4 route reverts even when the receiver is pre-funded", async () => {
    // buy ETH at 2,100 on v4 and sell it at 2,000 on v2
    const ethOut = cpOut(LOAN_USDC, USDC("2100000"), parseEther("1000"), 3000n);
    const usdcOut = await v2Quote(fx, ethOut, fx.weth.address);
    await fx.usdc.write.mint([fx.receiver.address, USDC("100000")]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      fx.receiver.write.run([fx.usdc.address, LOAN_USDC, [
        v4Leg(fx, fx.nativeHigh, fx.usdc.address, fx.weth.address, ethOut),
        v2Leg(fx, fx.weth.address, fx.usdc.address, usdcOut),
      ], 1n]),
      fx.receiver,
      "InsufficientProceeds",
      [usdcOut, LOAN_USDC + aaveV3Premium(LOAN_USDC, 5n) + 1n],
    );
    assert.equal(await fx.usdc.read.balanceOf([fx.receiver.address]), USDC("100000"));
  });
});

describe("Algebra (Camelot v3) legs", () => {
  it("v2 -> Algebra callback route keeps exactly the quoted profit", async () => {
    const fx = await networkHelpers.loadFixture(deploy);
    const wethOut = await v2Quote(fx, LOAN_USDC, fx.usdc.address);
    const usdcOut = await fx.algebra.read.quote([true, wethOut]);
    await expectExactProfit(fx, fx.usdc.address, LOAN_USDC, [
      v2Leg(fx, fx.usdc.address, fx.weth.address, wethOut),
      { kind: LEG_KIND.clAlgebra, pool: fx.algebra.address, tokenIn: fx.weth.address, tokenOut: fx.usdc.address, feeBps: 0, minOut: usdcOut, data: "0x" },
    ], usdcOut);
  });
});

describe("capped multicall (injected batch caller)", () => {
  it("returns each call's result, and stops a call at the per-call gas cap without failing the batch", async () => {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const weth = await viem.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const pool = await viem.deployContract("MockCLPool", [weth.address, usdc.address, 0]);
    await usdc.write.mint([pool.address, USDC("2000000")]);
    await weth.write.mint([pool.address, parseEther("1000")]);
    const capped = await viem.deployContract("CappedMulticall");
    const { encodeFunctionData } = await import("viem");
    const quoteCall = { target: pool.address, data: encodeFunctionData({ abi: pool.abi, functionName: "quote", args: [true, parseEther("1")] }) };
    const sim = (cap: bigint) =>
      publicClient.simulateContract({ address: capped.address, abi: capped.abi, functionName: "run", args: [[quoteCall, quoteCall], cap], account: ownerWallet.account });
    const ok = (await sim(1_000_000n)).result;
    assert.equal(ok[0].success && ok[1].success, true);
    const starved = (await sim(1_000n)).result; // far below what quote() needs
    assert.equal(starved[0].success, false);
    assert.equal(starved[0].outOfBudget, false);
    assert.ok(starved[0].gasUsed >= (1_000n * 63n) / 64n, "failure is attributable to the cap");
  });
});

describe("injected CL quoter", () => {
  it("matches each pool's own math for uniswap, pancake and algebra callbacks, and fails soft", async () => {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const weth = await viem.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const quoter = await viem.deployContract("CLQuoter");
    const pools = [];
    for (const kind of [0, 1, 2]) {
      const p = await viem.deployContract("MockCLPool", [weth.address, usdc.address, kind]);
      await usdc.write.mint([p.address, USDC("2000000")]);
      await weth.write.mint([p.address, parseEther("1000")]);
      pools.push(p);
    }
    const reqs = [
      ...pools.map((p) => ({ pool: p.address, zeroForOne: true, amountIn: parseEther("3") })),
      ...pools.map((p) => ({ pool: p.address, zeroForOne: false, amountIn: USDC("5000") })),
      { pool: usdc.address, zeroForOne: true, amountIn: 1n }, // not a pool
    ];
    const { result } = await publicClient.simulateContract({ address: quoter.address, abi: quoter.abi, functionName: "quoteMany", args: [reqs, 5_000_000n], account: ownerWallet.account });
    for (let i = 0; i < 3; i++) {
      assert.equal(result[i].ok, true);
      assert.equal(result[i].amountOut, await pools[i].read.quote([true, parseEther("3")]));
      assert.equal(result[i + 3].amountOut, await pools[i].read.quote([false, USDC("5000")]));
      assert.ok(result[i].gasUsed > 0n);
    }
    assert.equal(result[6].ok, false);
  });
});
