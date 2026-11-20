// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Read-only batch caller with a per-call gas cap. Never deployed: the scanner injects this
/// code via an eth_call state override. One pathological quote (e.g. a large swap through a thin
/// pool crossing hundreds of ticks) fails fast at the cap instead of timing out the whole batch.
contract CappedMulticall {
    struct Call {
        address target;
        bytes data;
    }

    struct Result {
        bool success;
        bool outOfBudget;
        uint256 gasUsed;
        bytes ret;
    }

    function run(Call[] calldata calls, uint256 gasCap) external returns (Result[] memory r) {
        r = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            // Keep enough gas to finish the loop and return; leftover calls are reported, not run.
            if (gasleft() < gasCap + 100_000) {
                r[i] = Result(false, true, 0, "");
                continue;
            }
            uint256 g = gasleft();
            (bool ok, bytes memory ret) = calls[i].target.call{gas: gasCap}(calls[i].data);
            r[i] = Result(ok, false, g - gasleft(), ret);
        }
    }
}
