// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC20Fx {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV1Exchange {
    function tokenToEthSwapInput(uint256 tokens_sold, uint256 min_eth, uint256 deadline) external returns (uint256);
    function ethToTokenSwapInput(uint256 min_tokens, uint256 deadline) external payable returns (uint256);
}

interface IAaveV1LendingPool {
    function flashLoan(address payable receiver, address reserve, uint256 amount) external;
}

/// @notice Replacement for the historical FlashLoanReceiverArb, for the local Aave-v1-style fixture.
/// Route: borrow TOKEN -> sell on `firstExchange` for ETH -> buy TOKEN on `secondExchange` -> repay.
///
/// Differences from ../contracts/FlashLoanReceiverArb.sol:
///  - the ordered exchange pair and token are constructor arguments, not hard-coded addresses;
///  - only the owner can start a loan, only the lender can call back, and only for a loan this
///    contract started (amount and reserve are checked against the pending request);
///  - both swaps carry caller-supplied non-zero minimum outputs (the original passed min_eth = 0,
///    which the historical exchange rejects at uniswap_exchange_custom.vy:206);
///  - the final swap must return at least principal + fee + minSurplus, measured from the swap's
///    own return value, so tokens already held by the receiver can never subsidize a losing trade;
///  - pullBalance() is replaced by an owner-only withdraw().
contract FixtureArbReceiver {
    address public immutable owner;
    IAaveV1LendingPool public immutable lender;
    IERC20Fx public immutable token;
    IUniswapV1Exchange public immutable firstExchange;
    IUniswapV1Exchange public immutable secondExchange;

    // Per-loan request, held in transient storage for the duration of one transaction.
    bool private transient pending;
    uint256 private transient pendingAmount;
    uint256 private transient pendingMinEthOut;
    uint256 private transient pendingMinSurplus;

    event ArbExecuted(uint256 amount, uint256 fee, uint256 ethOut, uint256 tokensOut, uint256 profit);

    error NotOwner();
    error NotLender();
    error NotInitiated();
    error WrongReserve(address reserve);
    error WrongAmount(uint256 amount, uint256 expected);
    error ZeroMinimum();
    error InsufficientProceeds(uint256 proceeds, uint256 required);
    error ProfitNotRetained(uint256 profit, uint256 minSurplus);
    error UnexpectedEthSender(address sender);

    constructor(address _lender, address _token, address _firstExchange, address _secondExchange) {
        owner = msg.sender;
        lender = IAaveV1LendingPool(_lender);
        token = IERC20Fx(_token);
        firstExchange = IUniswapV1Exchange(_firstExchange);
        secondExchange = IUniswapV1Exchange(_secondExchange);
    }

    /// @param amount     token amount to borrow (and to sell on the first exchange)
    /// @param minEthOut  minimum ETH from the first swap (must be > 0)
    /// @param minSurplus minimum token profit after repaying principal + fee (must be > 0)
    function execute(uint256 amount, uint256 minEthOut, uint256 minSurplus) external returns (uint256 profit) {
        if (msg.sender != owner) revert NotOwner();
        if (minEthOut == 0 || minSurplus == 0) revert ZeroMinimum();

        uint256 balanceBefore = token.balanceOf(address(this));

        pending = true;
        pendingAmount = amount;
        pendingMinEthOut = minEthOut;
        pendingMinSurplus = minSurplus;

        lender.flashLoan(payable(address(this)), address(token), amount);

        if (pending) revert NotInitiated(); // the lender never called back
        profit = token.balanceOf(address(this)) - balanceBefore;
        if (profit < minSurplus) revert ProfitNotRetained(profit, minSurplus);
    }

    function executeOperation(address reserve, uint256 amount, uint256 fee) external returns (uint256) {
        if (msg.sender != address(lender)) revert NotLender();
        if (!pending) revert NotInitiated();
        if (reserve != address(token)) revert WrongReserve(reserve);
        if (amount != pendingAmount) revert WrongAmount(amount, pendingAmount);
        pending = false;

        uint256 required = amount + fee + pendingMinSurplus;

        require(token.approve(address(firstExchange), amount), "approve failed");
        uint256 ethOut = firstExchange.tokenToEthSwapInput(amount, pendingMinEthOut, block.timestamp);
        uint256 tokensOut = secondExchange.ethToTokenSwapInput{value: ethOut}(required, block.timestamp);
        if (tokensOut < required) revert InsufficientProceeds(tokensOut, required);

        require(token.transfer(address(lender), amount + fee), "repay failed");
        emit ArbExecuted(amount, fee, ethOut, tokensOut, tokensOut - amount - fee);
        return amount + fee;
    }

    /// @notice ETH is accepted only from the first exchange, as the proceeds of the first swap.
    /// Must stay cheap: the Vyper exchange sends ETH with the 2300-gas stipend.
    receive() external payable {
        if (msg.sender != address(firstExchange)) revert UnexpectedEthSender(msg.sender);
    }

    function withdraw(address to) external {
        if (msg.sender != owner) revert NotOwner();
        require(token.transfer(to, token.balanceOf(address(this))), "withdraw failed");
    }
}
