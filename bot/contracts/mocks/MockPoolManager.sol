// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PoolKey, SwapParams} from "../live/FlashArbReceiverV3.sol";

interface IERC20PM {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Minimal Uniswap v4 PoolManager double. Pools price with a constant product over their
/// reserves and the key's fee (pips), but the flash accounting follows v4: swap/settle/take adjust
/// the locker's per-currency deltas, settle() credits the amount synced/sent, and unlock() reverts
/// unless every delta is back to zero. Currency 0x0 is native ETH.
contract MockPoolManager {
    struct Pool {
        uint256 r0;
        uint256 r1;
    }

    mapping(bytes32 => Pool) public pools;
    mapping(address => int256) public deltas;
    address[] private touched;
    bool private unlocked;
    address private locker;
    address private synced;
    uint256 private syncedReserve;

    receive() external payable {}

    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// Reserves must already be held by the manager (tokens transferred / ETH sent with the call).
    function initialize(PoolKey memory key, uint256 r0, uint256 r1) external payable {
        pools[poolId(key)] = Pool(r0, r1);
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        locker = msg.sender;
        r = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < touched.length; i++) {
            require(deltas[touched[i]] == 0, "CurrencyNotSettled");
        }
        delete touched;
        unlocked = false;
    }

    function _touch(address c, int256 d) private {
        if (deltas[c] == 0) touched.push(c);
        deltas[c] += d;
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        require(unlocked && msg.sender == locker, "ManagerLocked");
        require(p.amountSpecified < 0, "exact input only");
        Pool storage pl = pools[poolId(key)];
        require(pl.r0 > 0 && pl.r1 > 0, "PoolNotInitialized");
        uint256 amountIn = uint256(-p.amountSpecified);
        (uint256 rIn, uint256 rOut) = p.zeroForOne ? (pl.r0, pl.r1) : (pl.r1, pl.r0);
        uint256 inWithFee = amountIn * (1_000_000 - key.fee);
        uint256 out = (inWithFee * rOut) / (rIn * 1_000_000 + inWithFee);
        int128 a0;
        int128 a1;
        if (p.zeroForOne) {
            pl.r0 += amountIn;
            pl.r1 -= out;
            (a0, a1) = (-int128(int256(amountIn)), int128(int256(out)));
        } else {
            pl.r1 += amountIn;
            pl.r0 -= out;
            (a0, a1) = (int128(int256(out)), -int128(int256(amountIn)));
        }
        _touch(key.currency0, a0);
        _touch(key.currency1, a1);
        return int256(uint256(uint128(a0)) << 128 | uint256(uint128(a1)));
    }

    function sync(address currency) external {
        synced = currency;
        syncedReserve = currency == address(0) ? 0 : IERC20PM(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(unlocked && msg.sender == locker, "ManagerLocked");
        if (synced == address(0)) {
            paid = msg.value;
            _touch(address(0), int256(paid));
        } else {
            require(msg.value == 0, "NonzeroNativeValue");
            paid = IERC20PM(synced).balanceOf(address(this)) - syncedReserve;
            _touch(synced, int256(paid));
            synced = address(0);
        }
    }

    function take(address currency, address to, uint256 amount) external {
        require(unlocked && msg.sender == locker, "ManagerLocked");
        _touch(currency, -int256(amount));
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native take failed");
        } else {
            require(IERC20PM(currency).transfer(to, amount), "take failed");
        }
    }
}
