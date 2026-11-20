import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import { defineConfig } from "hardhat/config";

// Local-only configuration. There are deliberately no live networks or private keys here:
// live execution is disabled until the operator explicitly authorizes it.
export default defineConfig({
  plugins: [hardhatViem, hardhatViemAssertions, hardhatNodeTestRunner, hardhatNetworkHelpers],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
  },
  networks: {
    local: { type: "edr-simulated", chainType: "l1" },
  },
});
