// Main Arb bot. It checks for an Arb opportunity between the two UniSwap pools.
// If it finds one, FlashLoanArb() calls the Aave FlashLoan. The FlashLoanReceiverArb contract then:
//   1. borrows DAI,
//   2. sells DAI -> ETH on the follower exchange,
//   3. sells ETH -> DAI on the leader exchange,
//   4. pays back the loan + 1% fee and keeps the rest.
// The profit calculation below models exactly these steps.
const Web3 = require("web3");
const fs = require('fs');
const ERC20Token =  JSON.parse(fs.readFileSync("./client/src/contracts/ERC20Token.json"));
const UniSwapFactory = JSON.parse(fs.readFileSync("./client/src/contracts/uniswap_factory_custom.json"));
const UniSwapExchange = JSON.parse(fs.readFileSync("./client/src/contracts/uniswap_exchange_custom.json"));
const LendingPoolAddressesProvider = JSON.parse(fs.readFileSync("client/src/contracts/LendingPoolAddressesProvider.json"));
const LendingPool = JSON.parse(fs.readFileSync("client/src/contracts/LendingPool.json"));
const BigNumber = require('bignumber.js');
const Util = require("./client/src/utils/utils");
const {table} = require('table');
require('dotenv').config();

let data, output;

const TRADELIVE = false;                                                  // Change this to true to execute trades

BigNumber.set({ DECIMAL_PLACES: 18});

const TRADER_ACCOUNT = '0xeE398666cA860DFb7390b5D73EE927e9Fb41a60A';
const DAI_ADDRESS = '0xFf795577d9AC8bD7D90Ee22b6C1703490b6512FD';
const LENDING_POOL_ADDRESSES_PROVIDER = '0x9C6C63aA0cD4557d7aE6D9306C06C093A2e35408';
const RECEIVER_CONTRACT = '0x1ED5840AB41D578584232C13314de1d73B2F5CC3';    // Kovan deployed FlashLoanReceiverArb.sol - redeploy after contract changes
const AAVE_FEE_DIVISOR = new BigNumber(100);                              // Aave v1 flash loan fee is 1% (amount / 100)

let DaiTokenInstance, UniSwapFactoryInstance, leaderExchangeAddr, followerExchangeAddr;

const web3 = new Web3(new Web3.providers.HttpProvider(process.env.INFURAKOVAN));

const sleep = (x) => new Promise(resolve => setTimeout(() => resolve(true), x));

async function run(){
  // Main function that will run and check for Arb op
  const id = await web3.eth.net.getId();

  DaiTokenInstance = new web3.eth.Contract(ERC20Token.abi, DAI_ADDRESS);
  UniSwapFactoryInstance = new web3.eth.Contract(UniSwapFactory.abi, UniSwapFactory.networks[id].address);

  leaderExchangeAddr = await UniSwapFactoryInstance.methods.getExchange(0).call();                                      // Using custom UniSwap contracts
  followerExchangeAddr = await UniSwapFactoryInstance.methods.getExchange(1).call();

  console.log('Leader exchange:   ' + leaderExchangeAddr);
  console.log('Follower exchange: ' + followerExchangeAddr);

  const traderDaiBalanceWei = await DaiTokenInstance.methods.balanceOf(TRADER_ACCOUNT).call();
  console.log('Your DAI Balance: ' + web3.utils.fromWei(traderDaiBalanceWei.toString(10), 'ether'));

  while(true){
    console.log('\nChecking For Arb Op...');
    const ethBalance = await web3.eth.getBalance(TRADER_ACCOUNT);
    console.log('Balance Eth: ' + web3.utils.fromWei(ethBalance.toString(10), 'ether'));
    await PoolInfo();

    const titles = ['DAI Loan', 'Eff Price', 'ETH Out', 'ETH Sell', 'Eff Price', 'DAI Out', 'Profit (after fee)', 'Result'];
    const trades = [];

    let maxProfit = new BigNumber(0);
    let maxProfitLoan = new BigNumber(0);

    const leaderExEthBalanceWei = await web3.eth.getBalance(leaderExchangeAddr);
    const leaderExTokenBalanceWei = await DaiTokenInstance.methods.balanceOf(leaderExchangeAddr).call();
    const followerExEthBalanceWei = await web3.eth.getBalance(followerExchangeAddr);
    const followerExTokenBalanceWei = await DaiTokenInstance.methods.balanceOf(followerExchangeAddr).call();

    // Search loan sizes (in DAI). Start with steps of 10 up to 100.
    // Each time a size loses money, divide the step and max by 10 and search again.
    let loanDai = new BigNumber(0);
    let spendCheck = new BigNumber(10);
    let maxCheck = new BigNumber(100);
    const diviser = new BigNumber(10);
    let divisionCount = 0;
    const divisionMax = 6;

    while(true){
      const trade = [];
      loanDai = loanDai.plus(spendCheck);

      if(loanDai.isGreaterThan(maxCheck)){
        console.log('Max Loan Checked.');
        break;
      }

      const loanWei = web3.utils.toWei(loanDai.toString(10), 'ether');
      const profit = await CalculateProfit(loanWei, followerExEthBalanceWei, followerExTokenBalanceWei, leaderExEthBalanceWei, leaderExTokenBalanceWei, trade);

      if(profit.profit.isGreaterThan(maxProfit)){
        trade.push('New max profit');
        trades.push(trade);
        maxProfit = profit.profit;
        maxProfitLoan = loanDai;
        continue;
      }

      if(profit.profit.isNegative()){
        if(divisionCount < divisionMax){
          trade.push('No Profit');
          trades.push(trade);
          divisionCount++;
          spendCheck = spendCheck.dividedBy(diviser);
          maxCheck = maxCheck.dividedBy(diviser);
          loanDai = new BigNumber(0);
          continue;
        }
        trade.push("No Profit\nCan't Arb");
        trades.push(trade);
        break;
      }

      trade.push("Profit");
      trades.push(trade);
    }

    trades.unshift(titles);
    output = table(trades);
    console.log(output);

    if(maxProfitLoan.isZero()){
      console.log('No Arb Op.');
      console.log('--------------------------------------------');
      await sleep(6000);
      continue;
    }

    console.log('\n******** Arb Op ***********');
    await FlashLoanArb(maxProfit, maxProfitLoan);                               // This executes via FlashLoan contract.

    console.log('*****************************');
    console.log('--------------------------------------------');
  }
}

async function FlashLoanArb(maxProfit, maxProfitLoan){
  // Uses an Aave flash loan to execute trades. See ./contracts/FlashLoanReceiverArb.sol and also README for more details.
  console.log('Max Profit at loan of ' + maxProfitLoan.toString(10) + ' DAI: ' + web3.utils.fromWei(maxProfit.toFixed(0), 'ether') + ' DAI');

  /// Retrieve the LendingPool address
  const LendingPoolAddressesProviderInstance = new web3.eth.Contract(LendingPoolAddressesProvider.abi, LENDING_POOL_ADDRESSES_PROVIDER);
  const lendingPool = await LendingPoolAddressesProviderInstance.methods.getLendingPool().call();

  const LendingPoolInstance = new web3.eth.Contract(LendingPool.abi, lendingPool);

  const loanAmountWei = web3.utils.toWei(maxProfitLoan.toString(10), 'ether');

  const reserveData = await LendingPoolInstance.methods.getReserveData(DAI_ADDRESS).call();
  console.log('Reserve Data: ');
  console.log(reserveData);                                             // This shows amount in provider.

  console.log('FlashLoan Arb');
  console.log('Creating tx');
  const tx =  LendingPoolInstance.methods.flashLoan(RECEIVER_CONTRACT, DAI_ADDRESS, loanAmountWei);
  if(TRADELIVE){
    console.log('Sending tx');
    const rx = await Util.sendTransaction(web3, tx, TRADER_ACCOUNT, process.env.PRIVATEKEY, lendingPool);
    console.log(rx);
  }else{
    console.log('TRADELIVE is false - not sending tx');
    await sleep(6000);
  }
}

async function CalculateProfit(loanWei, followerExEthBalanceWei, followerExTokenBalanceWei, leaderExEthBalanceWei, leaderExTokenBalanceWei, trade){
  // Models the FlashLoanReceiverArb contract: DAI -> ETH on follower, ETH -> DAI on leader, minus Aave fee.
  const loanWeiBN = new BigNumber(loanWei);

  // Step 1: sell DAI for ETH on the follower exchange (input reserve = DAI, output reserve = ETH)
  const followerEffectivePrice = await Util.getEffectivePrices(web3, loanWei, followerExTokenBalanceWei, followerExEthBalanceWei, false);
  trade.push(web3.utils.fromWei(followerEffectivePrice.ethSpendWei, 'ether'));
  trade.push(followerEffectivePrice.effectivePriceBN.toString(10));
  trade.push(web3.utils.fromWei(followerEffectivePrice.tokensToBuyWeiBN.toString(10), 'ether'));

  // Step 2: sell that ETH for DAI on the leader exchange (input reserve = ETH, output reserve = DAI)
  const ethToSellWei = followerEffectivePrice.tokensToBuyWeiBN.toString(10);
  const leaderEffectivePrice = await Util.getEffectivePrices(web3, ethToSellWei, leaderExEthBalanceWei, leaderExTokenBalanceWei, false);
  trade.push(web3.utils.fromWei(leaderEffectivePrice.ethSpendWei, 'ether'));
  trade.push(leaderEffectivePrice.effectivePriceBN.toString(10));
  trade.push(web3.utils.fromWei(leaderEffectivePrice.tokensToBuyWeiBN.toString(10), 'ether'));

  // Profit = DAI out - loan - Aave fee
  const aaveFee = loanWeiBN.dividedToIntegerBy(AAVE_FEE_DIVISOR);
  const profit = leaderEffectivePrice.tokensToBuyWeiBN.minus(loanWeiBN).minus(aaveFee);
  trade.push(web3.utils.fromWei(profit.toFixed(0), 'ether'));

  return { profit: profit, firstEffectivePrice: followerEffectivePrice, secondEffectivePrice: leaderEffectivePrice};
}

async function PoolInfo(){
  // Displays UniSwap pool information.
  const leaderExEthBalanceWei = await web3.eth.getBalance(leaderExchangeAddr);
  const leaderExTokenBalanceWei = await DaiTokenInstance.methods.balanceOf(leaderExchangeAddr).call();
  const followerExEthBalanceWei = await web3.eth.getBalance(followerExchangeAddr);
  const followerExTokenBalanceWei = await DaiTokenInstance.methods.balanceOf(followerExchangeAddr).call();

  const leaderSpotPrices = await Util.getSpotPrices(leaderExEthBalanceWei, leaderExTokenBalanceWei, false);
  const followerSpotPrices = await Util.getSpotPrices(followerExEthBalanceWei, followerExTokenBalanceWei, false);

  data = [
      ['', 'Leader Exchange', 'Follower Exchange'],
      ['Eth Pool', web3.utils.fromWei(leaderExEthBalanceWei, 'ether'), web3.utils.fromWei(followerExEthBalanceWei, 'ether')],
      ['Token Pool', web3.utils.fromWei(leaderExTokenBalanceWei, 'ether'), web3.utils.fromWei(followerExTokenBalanceWei, 'ether')],
      ['Eth Spot Price', leaderSpotPrices.ethPrice.toString(10), followerSpotPrices.ethPrice.toString(10)],
      ['Token Spot Price', leaderSpotPrices.tokenPrice.toString(10), followerSpotPrices.tokenPrice.toString(10)]
  ];

  output = table(data);
  console.log(output);
}

module.exports = { CalculateProfit };

if (require.main === module) {
  run();
}
