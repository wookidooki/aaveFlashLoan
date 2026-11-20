pragma solidity ^0.5.0;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";

import "./mocks/tokens/MintableERC20.sol";
import "./flashloan/base/FlashLoanReceiverBase.sol";
import "./configuration/LendingPoolAddressesProvider.sol";
import "./configuration/NetworkMetadataProvider.sol";

import "./UniswapExchange.sol";

contract FlashLoanReceiverArb is FlashLoanReceiverBase {

    using SafeMath for uint256;

    // Kovan addresses used by this demo.
    address constant DAI = 0xFf795577d9AC8bD7D90Ee22b6C1703490b6512FD;
    address constant FOLLOWER_EXCHANGE = 0xB4ca10f43caF503b7Aa0a77757B99c78212D6b92;
    address constant LEADER_EXCHANGE = 0x274bBBBd9bf7Cab50fC8F62F5bb61d4FF297b362;

    address public owner;

    // Events
    event borrowMade(address _reserve, uint256 _amount , uint256 _value);
    event tradeMade(uint256 _amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(LendingPoolAddressesProvider _provider) FlashLoanReceiverBase(_provider)
        public {
        owner = msg.sender;
    }

    // Sends all DAI held by this contract (the profit) to the owner.
    function pullBalance() public onlyOwner {
      ERC20 token = ERC20(DAI);
      token.transfer(owner, token.balanceOf(address(this)));
    }

    function executeOperation(
        address _reserve,
        uint256 _amount,
        uint256 _fee) external returns(uint256 returnedAmount) {

        // Only the Aave LendingPool may call this. Otherwise anyone could make the
        // contract trade with its own funds.
        require(msg.sender == addressesProvider.getLendingPool(), "Only LendingPool");
        require(_reserve == DAI, "Only DAI loans");

        //check the contract has the specified balance
        require(_amount <= getBalanceInternal(address(this), _reserve),
            "Invalid balance for the contract");

        ERC20 token = ERC20(DAI);

        emit borrowMade(_reserve, _amount , token.balanceOf(address(this)));

        uint256 DEADLINE = block.timestamp + 300;

        // Swap DAI -> ETH on the follower exchange
        token.approve(FOLLOWER_EXCHANGE, _amount);
        UniswapExchange followerUniSwapExchange = UniswapExchange(FOLLOWER_EXCHANGE);
        uint256 eth_bought = followerUniSwapExchange.tokenToEthSwapInput(_amount, 1, DEADLINE);

        // Swap ETH -> DAI on the leader exchange.
        // Must get back at least loan + fee, or the whole transaction reverts (no loss except gas).
        UniswapExchange leaderUniSwapExchange = UniswapExchange(LEADER_EXCHANGE);
        leaderUniSwapExchange.ethToTokenSwapInput.value(eth_bought)(_amount.add(_fee), DEADLINE);

        emit tradeMade(token.balanceOf(address(this)));
        // Pays back
        transferFundsBackToPoolInternal(_reserve, _amount.add(_fee));
        return _amount.add(_fee);
    }
}
