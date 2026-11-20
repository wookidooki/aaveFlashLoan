// Local proof for the flash-loan round trip, using the historical Uniswap v1 (Vyper 0.1.0b4)
// exchange + factory bytecode committed in ../client/src/contracts, a lender that mirrors the
// vendored Aave v1 flashLoan rules, and the new FixtureArbReceiver.
//
// Fixed conditions: two pools seeded at different prices, no other traders, deterministic chain.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEther, type Address } from "viem";
import { loadHistorical } from "../src/fixture/historical.ts";
import { aaveV1Fee, getInputPrice, quoteV1RoundTrip, type V1PoolState } from "../src/quote/uniswapV1.ts";

const exchangeArtifact = loadHistorical("uniswap_exchange_custom");
const factoryArtifact = loadHistorical("uniswap_factory_custom");

const { viem, networkHelpers } = await network.create();
const publicClient = await viem.getPublicClient();
const [ownerWallet, lpWallet, traderWallet, attackerWallet] = await viem.getWalletClients();

// Pool seeds. Factory id 0 is the historical bot's "leader", id 1 its "follower" (arbBot.js:36-37).
// Leader prices ETH at 2,200 DAI, follower at 2,000 DAI, so DAI -> ETH on the follower then
// ETH -> DAI on the leader is the profitable direction (the historical receiver's order).
const LEADER_SEED = { eth: parseEther("1000"), dai: parseEther("2200000") };
const FOLLOWER_SEED = { eth: parseEther("1000"), dai: parseEther("2000000") };
const LENDER_DAI = parseEther("1000000");
const LOAN = parseEther("10000");

async function deployRaw(artifact: { abi: any; bytecode: `0x${string}` }): Promise<Address> {
  const hash = await ownerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt.contractAddress!;
}

async function send(hash: Promise<`0x${string}`>) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

async function deployFixture() {
  const dai = await viem.deployContract("MockDAI");
  const lender = await viem.deployContract("MockAaveV1LendingPool");

  const templateAddr = await deployRaw(exchangeArtifact);
  const factoryAddr = await deployRaw(factoryArtifact);
  const writeFactory = (functionName: string, args: unknown[]) =>
    send(ownerWallet.writeContract({ address: factoryAddr, abi: factoryArtifact.abi, functionName, args } as any));
  await writeFactory("initializeFactory", [templateAddr]);
  await writeFactory("createExchange", [dai.address]);
  await writeFactory("createExchange", [dai.address]);

  const readFactory = (functionName: string, args: unknown[]) =>
    publicClient.readContract({ address: factoryAddr, abi: factoryArtifact.abi, functionName, args } as any);
  const leader = getAddress((await readFactory("getExchange", [0n])) as string);
  const follower = getAddress((await readFactory("getExchange", [1n])) as string);
  assert.notEqual(leader, follower);

  // Seed liquidity from the LP account.
  await send(dai.write.mint([lpWallet.account.address, LEADER_SEED.dai + FOLLOWER_SEED.dai]));
  const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
  for (const [exchange, seed] of [
    [leader, LEADER_SEED],
    [follower, FOLLOWER_SEED],
  ] as const) {
    await send(dai.write.approve([exchange, seed.dai], { account: lpWallet.account }));
    await send(
      lpWallet.writeContract({
        address: exchange,
        abi: exchangeArtifact.abi,
        functionName: "addLiquidity",
        args: [0n, seed.dai, deadline],
        value: seed.eth,
      } as any),
    );
  }

  await send(dai.write.mint([lender.address, LENDER_DAI]));
  return { dai, lender, leader, follower };
}

async function poolState(dai: { read: { balanceOf: (a: [Address]) => Promise<bigint> } }, exchange: Address): Promise<V1PoolState> {
  return {
    ethReserve: await publicClient.getBalance({ address: exchange }),
    tokenReserve: await dai.read.balanceOf([exchange]),
  };
}

describe("historical exchange bytecode", () => {
  it("is the committed vyper 0.1.0b4 build", () => {
    assert.match(exchangeArtifact.compiler, /vyper 0\.1\.0b4/);
    assert.match(factoryArtifact.compiler, /vyper 0\.1\.0b4/);
  });
});

describe("flash-loan round trip (local fixture)", () => {
  let fx: Awaited<ReturnType<typeof deployFixture>>;

  beforeEach(async () => {
    fx = await networkHelpers.loadFixture(deployFixture);
  });

  it("1. profitable: starts with zero DAI, repays the lender, keeps exactly the quoted profit", async () => {
    const { dai, lender, leader, follower } = fx;
    const receiver = await viem.deployContract("FixtureArbReceiver", [lender.address, dai.address, follower, leader]);

    const first = await poolState(dai, follower);
    const second = await poolState(dai, leader);
    const q = quoteV1RoundTrip(LOAN, first, second);
    assert.ok(q.profit > 0n, `fixture should be profitable, quote profit ${q.profit}`);

    assert.equal(await dai.read.balanceOf([receiver.address]), 0n, "receiver starts with zero DAI");
    const lenderBefore = await dai.read.balanceOf([lender.address]);
    const ownerEthBefore = await publicClient.getBalance({ address: ownerWallet.account.address });

    // Exact minimums: the quote is exact under fixed conditions, so any deviation would revert.
    const receipt = await send(receiver.write.execute([LOAN, q.ethOut, q.profit]));

    // Token accounting.
    assert.equal(await dai.read.balanceOf([receiver.address]), q.profit, "receiver keeps exactly the quoted profit");
    assert.equal(await dai.read.balanceOf([lender.address]), lenderBefore + q.fee, "lender repaid principal + 1% fee");
    assert.equal(q.fee, aaveV1Fee(LOAN));
    assert.equal(await publicClient.getBalance({ address: receiver.address }), 0n, "no ETH left in receiver");
    assert.deepEqual(await poolState(dai, follower), {
      ethReserve: first.ethReserve - q.ethOut,
      tokenReserve: first.tokenReserve + LOAN,
    });
    assert.deepEqual(await poolState(dai, leader), {
      ethReserve: second.ethReserve + q.ethOut,
      tokenReserve: second.tokenReserve - q.tokensOut,
    });

    // Wallet gas is accounted separately: the owner's ETH moves only by the gas it paid.
    const ownerEthAfter = await publicClient.getBalance({ address: ownerWallet.account.address });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal(ownerEthBefore - ownerEthAfter, gasCost, "owner ETH change equals gas cost");
    console.log(
      `    quote: borrow ${LOAN} wei DAI, fee ${q.fee}, ethOut ${q.ethOut}, tokensOut ${q.tokensOut}, ` +
        `profit ${q.profit} wei DAI; wallet gas ${receipt.gasUsed} units = ${gasCost} wei ETH`,
    );

    // One wei more than the exact quoted surplus must revert: the minimum is binding.
    const fx2 = await networkHelpers.loadFixture(deployFixture);
    const receiver2 = await viem.deployContract("FixtureArbReceiver", [fx2.lender.address, fx2.dai.address, fx2.follower, fx2.leader]);
    await viem.assertions.revert(receiver2.write.execute([LOAN, q.ethOut, q.profit + 1n]));
  });

  it("2. losing: reverts even when the receiver already holds enough DAI to cover the shortfall", async () => {
    const { dai, lender, leader, follower } = fx;
    // Reverse order: sell DAI where it is cheap (leader), buy it back where it is dear (follower).
    const receiver = await viem.deployContract("FixtureArbReceiver", [lender.address, dai.address, leader, follower]);
    const q = quoteV1RoundTrip(LOAN, await poolState(dai, leader), await poolState(dai, follower));
    assert.ok(q.profit < 0n, `reverse route should lose, quote profit ${q.profit}`);

    const preFund = parseEther("50000");
    assert.ok(preFund > -q.profit, "pre-funding exceeds the shortfall");
    await send(dai.write.mint([receiver.address, preFund]));

    const lenderBefore = await dai.read.balanceOf([lender.address]);
    const leaderBefore = await poolState(dai, leader);
    const followerBefore = await poolState(dai, follower);

    await viem.assertions.revert(receiver.write.execute([LOAN, q.ethOut, 1n]));

    assert.equal(await dai.read.balanceOf([receiver.address]), preFund, "receiver funds untouched");
    assert.equal(await dai.read.balanceOf([lender.address]), lenderBefore, "lender unchanged");
    assert.deepEqual(await poolState(dai, leader), leaderBefore);
    assert.deepEqual(await poolState(dai, follower), followerBefore);
  });

  it("3. the original min_eth = 0 call reverts against the historical exchange bytecode", async () => {
    const { dai, follower } = fx;
    await send(dai.write.mint([traderWallet.account.address, LOAN]));
    await send(dai.write.approve([follower, LOAN], { account: traderWallet.account }));
    const deadline = BigInt(await networkHelpers.time.latest()) + 300n;

    // Same arguments as ../contracts/FlashLoanReceiverArb.sol:54: tokenToEthSwapInput(_amount, 0, DEADLINE)
    await viem.assertions.revert(
      traderWallet.writeContract({
        address: follower,
        abi: exchangeArtifact.abi,
        functionName: "tokenToEthSwapInput",
        args: [LOAN, 0n, deadline],
      } as any),
    );

    // Control: the identical call with min_eth = 1 succeeds, isolating min_eth = 0 as the cause,
    // and the ETH received equals the bigint quote.
    const state = await poolState(dai, follower);
    const expectedEth = getInputPrice(LOAN, state.tokenReserve, state.ethReserve);
    const ethBefore = await publicClient.getBalance({ address: traderWallet.account.address });
    const receipt = await send(
      traderWallet.writeContract({
        address: follower,
        abi: exchangeArtifact.abi,
        functionName: "tokenToEthSwapInput",
        args: [LOAN, 1n, deadline],
      } as any),
    );
    const ethAfter = await publicClient.getBalance({ address: traderWallet.account.address });
    assert.equal(ethAfter - ethBefore + receipt.gasUsed * receipt.effectiveGasPrice, expectedEth);
  });
});

describe("receiver authentication and lender rules", () => {
  let fx: Awaited<ReturnType<typeof deployFixture>>;
  let receiver: Awaited<ReturnType<typeof viem.deployContract<"FixtureArbReceiver">>>;

  before(async () => {
    fx = await networkHelpers.loadFixture(deployFixture);
    receiver = await viem.deployContract("FixtureArbReceiver", [fx.lender.address, fx.dai.address, fx.follower, fx.leader]);
  });

  it("only the owner can start a loan", async () => {
    await viem.assertions.revertWithCustomError(
      receiver.write.execute([LOAN, 1n, 1n], { account: attackerWallet.account }),
      receiver,
      "NotOwner",
    );
  });

  it("rejects zero minimums", async () => {
    await viem.assertions.revertWithCustomError(receiver.write.execute([LOAN, 0n, 1n]), receiver, "ZeroMinimum");
    await viem.assertions.revertWithCustomError(receiver.write.execute([LOAN, 1n, 0n]), receiver, "ZeroMinimum");
  });

  it("rejects callbacks that do not come from the lender", async () => {
    await viem.assertions.revertWithCustomError(
      receiver.write.executeOperation([fx.dai.address, LOAN, aaveV1Fee(LOAN)], { account: attackerWallet.account }),
      receiver,
      "NotLender",
    );
  });

  it("rejects lender callbacks for loans it did not start", async () => {
    // Anyone may call the lender's flashLoan with this receiver as target (as on Aave v1).
    await viem.assertions.revertWithCustomError(
      fx.lender.write.flashLoan([receiver.address, fx.dai.address, LOAN], { account: attackerWallet.account }),
      receiver,
      "NotInitiated",
    );
  });

  it("rejects ETH from anyone but the first exchange", async () => {
    await viem.assertions.revertWithCustomError(
      attackerWallet.sendTransaction({ to: receiver.address, value: 1n }),
      receiver,
      "UnexpectedEthSender",
    );
  });

  it("lender mirrors v1: zero fee rejected, liquidity must be strictly greater", async () => {
    await viem.assertions.revertWith(
      receiver.write.execute([99n, 1n, 1n]),
      "The amount is too small thus it cannot be borrowed",
    );
    await viem.assertions.revertWith(
      receiver.write.execute([LENDER_DAI, 1n, 1n]),
      "There is not enough liquidity available to borrow",
    );
  });
});
