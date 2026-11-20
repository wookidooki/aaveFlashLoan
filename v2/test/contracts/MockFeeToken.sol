// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-only ERC20 that burns `feeBps` of every transfer (a fee-on-transfer token).
///         With feeBps = 0 it is a plain token.
contract MockFeeToken {
    string public constant name = "Mock Fee Token";
    string public constant symbol = "FEE";
    uint8 public constant decimals = 18;
    uint16 public immutable feeBps;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint16 feeBps_) {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 fee = (amount * feeBps) / 10000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
    }
}
