// Chain-specific transaction cost for one flash-loan round trip.
//  - Arbitrum: (L2 gas + L1 calldata component in L2 gas units, from NodeInterface) x L2 gas price.
//  - OP stack (Base, Optimism): L2 gas x (base fee + priority fee) + GasPriceOracle.getL1Fee(tx).
import { parseAbi, serializeTransaction, type Address, type Hex, type PublicClient } from "viem";
import { rawCall } from "./chain.ts";
import type { ChainConfig } from "./config.ts";

const NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";
const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";
const NI_ABI = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
const GPO_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);

export interface GasPrices {
  baseFee: bigint;
  priorityFee: bigint;
}

export async function readGasPrices(client: PublicClient, chain: ChainConfig, blockNumber: bigint): Promise<GasPrices> {
  const block = await client.getBlock({ blockNumber });
  const baseFee = block.baseFeePerGas ?? (await client.getGasPrice());
  // Arbitrum ignores priority fees (no tips); OP-stack chains use them for ordering.
  let priorityFee = 0n;
  if (chain.l1FeeModel === "opstack-gaspriceoracle") {
    try {
      priorityFee = BigInt(await client.request({ method: "eth_maxPriorityFeePerGas" } as any));
    } catch {
      priorityFee = 1_000_000n;
    }
  }
  return { baseFee, priorityFee };
}

export interface GasCost {
  l2GasUnits: bigint;
  l1GasUnits: bigint; // Arbitrum only (charged at the L2 price)
  l2CostWei: bigint;
  l1CostWei: bigint;
  totalWei: bigint;
  gasPriceWei: bigint;
}

/** Calldata intrinsic cost (EIP-2028): 16 gas per non-zero byte, 4 per zero byte. */
export function calldataGas(data: Hex): bigint {
  let g = 0n;
  for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === "00" ? 4n : 16n;
  return g;
}

export async function estimateTxCost(
  client: PublicClient,
  chain: ChainConfig,
  prices: GasPrices,
  to: Address,
  data: Hex,
  executionGas: bigint,
  blockNumber: bigint,
): Promise<GasCost> {
  const l2GasUnits = executionGas + calldataGas(data);
  const gasPriceWei = prices.baseFee + prices.priorityFee;
  let l1GasUnits = 0n;
  let l1CostWei = 0n;

  if (chain.l1FeeModel === "arbitrum-nodeinterface") {
    const { encodeFunctionData, decodeFunctionResult } = await import("viem");
    const r = await rawCall(client, {
      from: "0x0000000000000000000000000000000000000001",
      to: NODE_INTERFACE,
      data: encodeFunctionData({ abi: NI_ABI, functionName: "gasEstimateL1Component", args: [to, false, data] }),
      blockNumber,
    });
    if (!r.ok) throw new Error(`NodeInterface L1 estimate failed: ${r.error}`);
    const [l1Gas] = decodeFunctionResult({ abi: NI_ABI, functionName: "gasEstimateL1Component", data: r.data }) as readonly [bigint, bigint, bigint];
    l1GasUnits = l1Gas;
    l1CostWei = l1Gas * gasPriceWei;
  } else if (chain.l1FeeModel === "opstack-gaspriceoracle") {
    const unsigned = serializeTransaction({
      chainId: chain.chainId,
      type: "eip1559",
      nonce: 100_000,
      gas: l2GasUnits,
      maxFeePerGas: gasPriceWei * 2n,
      maxPriorityFeePerGas: prices.priorityFee,
      to,
      data,
    });
    l1CostWei = await client.readContract({ address: GAS_PRICE_ORACLE, abi: GPO_ABI, functionName: "getL1Fee", args: [unsigned], blockNumber });
  }

  const l2CostWei = l2GasUnits * gasPriceWei;
  return { l2GasUnits, l1GasUnits, l2CostWei, l1CostWei, totalWei: l2CostWei + l1CostWei, gasPriceWei };
}
