// Loads the committed Truffle/Vyper artifacts (compiled 2019 with vyper 0.1.0b4) so the local
// fixture runs the *historical* exchange and factory bytecode rather than a re-implementation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const ARTIFACT_DIR = fileURLToPath(new URL("../../../client/src/contracts/", import.meta.url));

interface LegacyAbiItem {
  type: string;
  name?: string;
  inputs?: unknown[];
  outputs?: unknown[];
  constant?: boolean;
  payable?: boolean;
  anonymous?: boolean;
  gas?: number;
}

/** Old Vyper ABIs use constant/payable and carry per-function `gas` hints; add stateMutability. */
function normalizeAbi(items: LegacyAbiItem[]): Abi {
  return items.map((item) => {
    const { gas: _gas, constant, payable, ...rest } = item;
    if (item.type !== "function") return rest;
    const stateMutability = payable ? "payable" : constant ? "view" : "nonpayable";
    return { ...rest, outputs: item.outputs ?? [], stateMutability };
  }) as unknown as Abi;
}

export interface HistoricalArtifact {
  abi: Abi;
  bytecode: Hex;
  compiler: string;
}

export function loadHistorical(name: "uniswap_exchange_custom" | "uniswap_factory_custom"): HistoricalArtifact {
  const json = JSON.parse(readFileSync(ARTIFACT_DIR + name + ".json", "utf8"));
  if (!json.bytecode || json.bytecode === "0x") throw new Error(`${name}: no bytecode in artifact`);
  return {
    abi: normalizeAbi(json.abi),
    bytecode: json.bytecode as Hex,
    compiler: `${json.compiler?.name} ${json.compiler?.version}`,
  };
}
