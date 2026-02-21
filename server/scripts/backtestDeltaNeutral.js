require('dotenv').config({ path: '../.env' });
const fs     = require('fs');
const path   = require('path');
const moment = require('moment');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  LOT_SIZE:            20,
  BUY_DELTA:           0.50,
  SELL_DELTA:          0.40,
  RISK_FREE_RATE:      0.065,
  LEG_SL_PERCENT:      0.60,
  COMBINED_SL_PERCENT: 0.60,
  CAPITAL:             100000,

  // Simulated premiums based on SENSEX level
  // At 3:20 PM Friday, ATM options typically have:
  // 0.50 delta CE/PE ~ 0.4-0.6% of spot
  // 0.40 delta CE/PE ~ 0.25-0.35% of spot
  BUY_PREMIUM_PCT:   0.0045, // ~0.45% of spot for ATM
  SELL_PREMIUM_PCT:  0.003,  // ~0.30% of spot for near OTM

  TRAIL_LEVELS: [
    { profit: 1000,  lock: 250  },
    { profit: 2000,  lock: 1000 },
    { profit: 3000,  lock: 1750 },
    { profit: 4000,  lock: 2500 },
    { profit: 5000,  lock: 3250 },
    { profit: 6000,  lock: 4000 },
    { profit: 7000,  lock: 4750 },
    { profit: 8000,  lock: 5500 },
    { profit: 9000,  lock: 6250 },
    { profit: 10000, lock: 7000 },
  ],
};

// ─────────────────────────────────────────
// LOAD DATA
// ─────────────────────────────────────────
function loadData(interval) {
  const filePath = path.join(__dirname, `../data/historical/BSE/SENSEX/${interval}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`✅ Loaded ${data.length} ${interval} candles`);
  return data;
}

// ─────────────────────────────────────────
// BLACK-SCHOLES DELTA
// ─────────────────────────────────────────
function normalCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1.0 + sign * y);
}

function bsDelta(spot, strike, T, r, iv, type) {
  if (T <= 0 || iv <= 0) return type === 'CE' ? 1 : -1;
  const d1 = (Math.log(spot/strike) + (r + 0.5*iv*iv)*T) / (iv*Math.sqrt(T));
  return type === 'CE' ? normalCDF(d1) : normalCDF(d1) - 1;
}

// ─────────────────────────────────────────
// SIMULATE OPTION PREMIUMS
// ─────────────────────────────────────────
function simulatePremiums(spot, daysToExpiry, iv = 0.15) {
  // Use Black-Scholes to find ATM and near-OTM strikes
  const T        = daysToExpiry / 365;
  const interval = 100; // SENSEX strike interval

  // Find 0.50 delta strike (ATM)
  let buyStrike = Math.round(spot / interval) * interval;

  // Find 0.40 delta strike (slightly OTM)
  let sellCallStrike = buyStrike + interval;
  let sellPutStrike  = buyStrike - interval;

  // Calculate premiums using simplified BS
  const d1Buy  = (Math.log(spot/buyStrike) + (CONFIG.RISK_FREE_RATE + 0.5*iv*iv)*T) / (iv*Math.sqrt(T));
  const d2Buy  = d1Buy - iv*Math.sqrt(T);

  // Call premium (ATM)
  const callBuyPremium  = parseFloat((spot * normalCDF(d1Buy) - buyStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) * normalCDF(d2Buy)).toFixed(2));
  // Put premium (ATM) via put-call parity
  const putBuyPremium   = parseFloat((callBuyPremium + buyStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) - spot).toFixed(2));

  const d1Sell  = (Math.log(spot/sellCallStrike) + (CONFIG.RISK_FREE_RATE + 0.5*iv*iv)*T) / (iv*Math.sqrt(T));
  const d2Sell  = d1Sell - iv*Math.sqrt(T);

  const callSellPremium = parseFloat((spot * normalCDF(d1Sell) - sellCallStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) * normalCDF(d2Sell)).toFixed(2));
  const putSellPremium  = parseFloat(Math.max(callSellPremium + sellPutStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) - spot, 0).toFixed(2));

  // Net debit
  const netDebit = parseFloat(((callBuyPremium + putBuyPremium - callSellPremium - putSellPremium) * CONFIG.LOT_SIZE).toFixed(2));

  return {
    buyStrike,
    sellCallStrike,
    sellPutStrike,
    callBuyPremium:  Math.max(callBuyPremium, 1),
    putBuyPremium:   Math.max(putBuyPremium, 1),
    callSellPremium: Math.max(callSellPremium, 0.5),
    putSellPremium:  Math.max(putSellPremium, 0.5),
    netDebit:        Math.max(netDebit, 100),
    iv,
  };
}

// ─────────────────────────────────────────
// SIMULATE MONDAY PRICE MOVEMENT
// ─────────────────────────────────────────
function simulateMondayPnL(entrySpot, mondayCandles, premiums, daysToExpiry) {
  let callBuyPremium  = premiums.callBuyPremium;
  let putBuyPremium   = premiums.putBuyPremium;
  let callSellPremium = premiums.callSellPremium;
  let putSellPremium  = premiums.putSellPremium;
  const netDebit      = premiums.netDebit;
  const combinedSL    = netDebit * CONFIG.COMBINED_SL_PERCENT;

  let callBuyActive  = true;
  let callSellActive = true;
  let putBuyActive   = true;
  let putSellActive  = true;
  let lastBuyLeg     = null;
  let lockedProfit   = 0;
  let trailSL        = null;
  let trailLevelIdx  = 0;
  let totalPnl       = 0;
  let closeReason    = 'EXPIRY';
  let legResults   = {};

  for (const candle of mondayCandles) {
    const spot      = candle.close;
    const T         = Math.max((daysToExpiry - 3) / 365, 0.001); // 3 days passed
    const iv        = premiums.iv;

    // Recalculate option premiums based on new spot
    const newCallBuy  = Math.max(parseFloat((spot * normalCDF((Math.log(spot/premiums.buyStrike) + (CONFIG.RISK_FREE_RATE + 0.5*iv*iv)*T) / (iv*Math.sqrt(T))) - premiums.buyStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) * normalCDF((Math.log(spot/premiums.buyStrike) + (CONFIG.RISK_FREE_RATE + 0.5*iv*iv)*T) / (iv*Math.sqrt(T)) - iv*Math.sqrt(T))).toFixed(2)), 0.1);
    const newPutBuy   = Math.max(parseFloat((newCallBuy + premiums.buyStrike * Math.exp(-CONFIG.RISK_FREE_RATE*T) - spot).toFixed(2)), 0.1);
    const newCallSell = Math.max(newCallBuy * 0.65, 0.1);
    const newPutSell  = Math.max(newPutBuy  * 0.65, 0.1);

    // Calculate current P&L
    let pnl = 0;
    if (callBuyActive)  pnl += (newCallBuy  - callBuyPremium)  * CONFIG.LOT_SIZE;
    if (putBuyActive)   pnl += (newPutBuy   - putBuyPremium)   * CONFIG.LOT_SIZE;
    if (callSellActive) pnl += (callSellPremium - newCallSell) * CONFIG.LOT_SIZE;
    if (putSellActive)  pnl += (putSellPremium  - newPutSell)  * CONFIG.LOT_SIZE;

    totalPnl = parseFloat(pnl.toFixed(2));

    // ── Combined SL ──
    if (totalPnl <= -combinedSL && (callBuyActive || putBuyActive)) {
      closeReason = 'COMBINED_SL';
      legResults  = { callBuy: 'SL', callSell: 'SL', putBuy: 'SL', putSell: 'SL' };
      break;
    }

    // ── Individual leg SLs ──
    if (!lastBuyLeg) {

      // Call Buy -60%
      if (callBuyActive && newCallBuy <= callBuyPremium * (1 - CONFIG.LEG_SL_PERCENT)) {
        const callBuyPnl  = (newCallBuy  - callBuyPremium)  * CONFIG.LOT_SIZE;
        const callSellPnl = (callSellPremium - newCallSell) * CONFIG.LOT_SIZE;
        legResults.callBuy  = { pnl: callBuyPnl,  reason: 'SL_60' };
        legResults.callSell = { pnl: callSellPnl, reason: 'PAIRED_EXIT' };
        callBuyActive  = false;
        callSellActive = false;
      }

      // Put Buy -60%
      if (putBuyActive && newPutBuy <= putBuyPremium * (1 - CONFIG.LEG_SL_PERCENT)) {
        const putBuyPnl  = (newPutBuy  - putBuyPremium)  * CONFIG.LOT_SIZE;
        const putSellPnl = (putSellPremium - newPutSell) * CONFIG.LOT_SIZE;
        legResults.putBuy  = { pnl: putBuyPnl,  reason: 'SL_60' };
        legResults.putSell = { pnl: putSellPnl, reason: 'PAIRED_EXIT' };
        putBuyActive  = false;
        putSellActive = false;
      }

      // Call Sell +60%
      if (callSellActive && newCallSell >= callSellPremium * (1 + CONFIG.LEG_SL_PERCENT)) {
        legResults.callSell = { pnl: (callSellPremium - newCallSell) * CONFIG.LOT_SIZE, reason: 'SL_60' };
        callSellActive = false;
      }

      // Put Sell +60%
      if (putSellActive && newPutSell >= putSellPremium * (1 + CONFIG.LEG_SL_PERCENT)) {
        legResults.putSell = { pnl: (putSellPremium - newPutSell) * CONFIG.LOT_SIZE, reason: 'SL_60' };
        putSellActive = false;
      }

      // Check if one buy leg remains
      const buysLeft  = [callBuyActive, putBuyActive].filter(Boolean).length;
      const sellsLeft = [callSellActive, putSellActive].filter(Boolean).length;

      if (buysLeft === 1 && sellsLeft === 0) {
        lastBuyLeg = callBuyActive ? 'callBuy' : 'putBuy';
      }
    }

    // ── Trail last buy leg ──
    if (lastBuyLeg) {
      const legPremium = lastBuyLeg === 'callBuy' ? callBuyPremium : putBuyPremium;
      const legLTP     = lastBuyLeg === 'callBuy' ? newCallBuy     : newPutBuy;
      const legPnl     = (legLTP - legPremium) * CONFIG.LOT_SIZE;

      totalPnl = parseFloat(legPnl.toFixed(2));

      // Update trail level
      for (let i = trailLevelIdx; i < CONFIG.TRAIL_LEVELS.length; i++) {
        if (legPnl >= CONFIG.TRAIL_LEVELS[i].profit) {
          lockedProfit = CONFIG.TRAIL_LEVELS[i].lock;
          trailSL      = legPremium + (lockedProfit / CONFIG.LOT_SIZE);
          trailLevelIdx = i + 1;
        }
      }

      // Check trail SL hit
      if (trailSL && legLTP <= trailSL) {
        totalPnl    = lockedProfit;
        closeReason = 'TRAIL_SL';
        legResults[lastBuyLeg] = { pnl: lockedProfit, reason: 'TRAIL_SL' };
        break;
      }
    }
  }

  return { pnl: totalPnl, closeReason, lockedProfit, lastBuyLeg, legResults };
}

// ─────────────────────────────────────────
// MAIN BACKTEST
// ─────────────────────────────────────────
function runBacktest() {
  console.log('\n🚀 Starting Delta Neutral Backtest...\n');

  const dayData  = loadData('day');
  const min15Data = loadData('15minute');

  // Group 15min data by date
  const min15ByDate = {};
  for (const candle of min15Data) {
    const date = moment(candle.date).format('YYYY-MM-DD');
    if (!min15ByDate[date]) min15ByDate[date] = [];
    min15ByDate[date].push(candle);
  }

  // Find all Fridays in data
  const fridays = dayData.filter(candle => {
    const d = moment(candle.date);
    return d.day() === 5; // Friday
  });

  console.log(`📅 Found ${fridays.length} Fridays to backtest\n`);

  const trades   = [];
  let   totalPnl = 0;

  for (const friday of fridays) {
    const fridayDate  = moment(friday.date).format('YYYY-MM-DD');
    const mondayDate  = moment(friday.date).add(3, 'days').format('YYYY-MM-DD');

    // Get Monday 15min candles
    const mondayCandles = min15ByDate[mondayDate] || [];
    if (mondayCandles.length === 0) continue;

    const entrySpot     = friday.close; // Use Friday close as entry spot
    const daysToExpiry  = 6;            // Thursday is 6 days away from Friday
    const iv            = 0.15;         // Assume 15% IV (typical for SENSEX)

    // Simulate premiums at entry
    const premiums = simulatePremiums(entrySpot, daysToExpiry, iv);

    // Simulate Monday P&L
    const result = simulateMondayPnL(entrySpot, mondayCandles, premiums, daysToExpiry);

    const trade = {
      date:          fridayDate,
      monday:        mondayDate,
      entrySpot,
      netDebit:      premiums.netDebit,
      buyStrike:     premiums.buyStrike,
      callBuyPremium: premiums.callBuyPremium,
      putBuyPremium:  premiums.putBuyPremium,
      callSellPremium: premiums.callSellPremium,
      putSellPremium:  premiums.putSellPremium,
      pnl:           result.pnl,
      closeReason:   result.closeReason,
      lastBuyLeg:    result.lastBuyLeg,
      lockedProfit:  result.lockedProfit,
      month:         moment(fridayDate).format('YYYY-MM'),
    };

    trades.push(trade);
    totalPnl += result.pnl;

    const emoji = result.pnl >= 0 ? '✅' : '❌';
    console.log(`${emoji} ${fridayDate} → ${mondayDate} | Spot:${entrySpot} | P&L:₹${result.pnl.toFixed(0)} | ${result.closeReason}`);
  }

  // ── Calculate stats ──
  const winners    = trades.filter(t => t.pnl > 0);
  const losers     = trades.filter(t => t.pnl < 0);
  const winRate    = trades.length ? (winners.length / trades.length * 100) : 0;
  const avgWin     = winners.length ? winners.reduce((s,t) => s+t.pnl, 0) / winners.length : 0;
  const avgLoss    = losers.length  ? losers.reduce((s,t)  => s+t.pnl, 0) / losers.length  : 0;
  const bestTrade  = trades.reduce((best, t) => t.pnl > (best?.pnl||-Infinity) ? t : best, null);
  const worstTrade = trades.reduce((worst,t) => t.pnl < (worst?.pnl||Infinity) ? t : worst, null);

  // Max drawdown
  let peak = 0, maxDD = 0, runningPnl = 0;
  for (const t of trades) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio (weekly returns)
  const returns  = trades.map(t => t.pnl / CONFIG.CAPITAL);
  const avgReturn = returns.reduce((s,r) => s+r, 0) / returns.length;
  const stdDev   = Math.sqrt(returns.reduce((s,r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length);
  const sharpe   = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0; // annualized weekly

  // Monthly breakdown
  const monthly = {};
  for (const t of trades) {
    if (!monthly[t.month]) monthly[t.month] = { pnl: 0, trades: 0, wins: 0 };
    monthly[t.month].pnl    += t.pnl;
    monthly[t.month].trades += 1;
    monthly[t.month].wins   += t.pnl > 0 ? 1 : 0;
  }

  // Close reasons breakdown
  const reasons = {};
  for (const t of trades) {
    reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1;
  }

  const stats = {
    totalTrades:  trades.length,
    winners:      winners.length,
    losers:       losers.length,
    winRate:      parseFloat(winRate.toFixed(2)),
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    bestTrade,
    worstTrade,
    maxDrawdown:  parseFloat(maxDD.toFixed(2)),
    sharpeRatio:  parseFloat(sharpe.toFixed(2)),
    monthly,
    reasons,
    trades,
  };

  // Save results
  const outputPath = path.join(__dirname, '../data/backtest_delta_neutral.json');
  fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
  console.log(`\n✅ Results saved to: ${outputPath}`);
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Total trades:  ${stats.totalTrades}`);
  console.log(`   Win rate:      ${stats.winRate}%`);
  console.log(`   Total P&L:     ₹${stats.totalPnl}`);
  console.log(`   Avg win:       ₹${stats.avgWin}`);
  console.log(`   Avg loss:      ₹${stats.avgLoss}`);
  console.log(`   Max drawdown:  ₹${stats.maxDrawdown}`);
  console.log(`   Sharpe ratio:  ${stats.sharpeRatio}`);

  return stats;
}

runBacktest();