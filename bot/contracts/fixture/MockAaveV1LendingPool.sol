// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IFlashLoanReceiverV1 {
    function executeOperation(address reserve, uint256 amount, uint256 fee) external returns (uint256 returnedAmount);
}

/// @notice Local test lender that mirrors the flash-loan rules of the vendored Aave v1 snapshot
/// (../contracts/lendingpool/LendingPool.sol, flashLoan, lines 606-651). It plays both the
/// LendingPool and LendingPoolCore roles: it holds the reserve and receives the repayment.
///
/// Mirrored rules, with the same revert strings:
///  - receiver must be a contract                                   (LendingPool.sol:614)
///  - available liquidity must be strictly greater than the amount   (LendingPool.sol:621)
///  - fee = floor(amount / 100), and a zero fee is rejected          (LendingPool.sol:632-634)
///  - returned amount must equal amount + fee                        (LendingPool.sol:646)
///  - lender balance after must equal balance before + fee           (LendingPool.sol:651)
/// Only ERC20 reserves are supported; the v1 ETH-reserve path is out of scope for the fixture.
contract MockAaveV1LendingPool {
    bool private locked;

    modifier nonReentrant() {
        require(!locked, "ReentrancyGuard: reentrant call");
        locked = true;
        _;
        locked = false;
    }

    function flashLoan(address payable _receiver, address _reserve, uint256 _amount) external nonReentrant {
        require(_receiver.code.length > 0, "The caller of this function must be a contract");

        uint256 availableLiquidity = IERC20Min(_reserve).balanceOf(address(this));
        require(availableLiquidity > _amount, "There is not enough liquidity available to borrow");

        uint256 actualBalanceBefore = availableLiquidity;

        uint256 amountFee = _amount / 100;
        require(amountFee > 0, "The amount is too small thus it cannot be borrowed");

        require(IERC20Min(_reserve).transfer(_receiver, _amount), "transfer failed");

        uint256 returnedAmount = IFlashLoanReceiverV1(_receiver).executeOperation(_reserve, _amount, amountFee);

        require(returnedAmount == _amount + amountFee, "The nominal returned amount is invalid");

        uint256 actualBalanceAfter = IERC20Min(_reserve).balanceOf(address(this));
        require(
            actualBalanceAfter == actualBalanceBefore + amountFee,
            "The actual balance of the protocol in inconsistent"
        );
    }
}
