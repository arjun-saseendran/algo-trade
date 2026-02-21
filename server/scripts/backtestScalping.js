require('dotenv').config({ path: '../.env' });
const fs     = require('fs');
const path   = require('path');
const moment = require('moment');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL:          100000,
  QTY:              65,
  DELTA:            0.5,
  MAX_RANGE_POINTS: 30,
  TRAIL_TRIGGER:    3000,
  EXIT_TIME:        '15:21',
};

// ─────────────────────────────────────────
// LOAD DATA
// ─────────────────────────────────────────
function loadData(interval) {
  const filePath = path.join(__dirname, `../data/historical/NSE/NIFTY_50/${interval}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`✅ Loaded ${data.length} ${interval} candles`);
  return data;
}

// ─────────────────────────────────────────
// GROUP CANDLES BY DATE
// ─────────────────────────────────────────
function groupByDate(candles) {
  const byDate = {};
  for (const c of candles) {
    const date = moment(c.date).format('YYYY-MM-DD');
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(c);
  }
  // Sort each day's candles by time
  for (const date of Object.keys(byDate)) {
    byDate[date].sort((a, b) => new Date(a.date) - new Date(b.date));
  }
  return byDate;
}

// ─────────────────────────────────────────
// SIMULATE ONE DAY
// ─────────────────────────────────────────
function simulateDay(dayCandles) {
  let firstCandleDone = false;
  let setupCandles    = [];
  let currentSetup    = null;
  let trade           = null;

  for (let i = 0; i < dayCandles.length; i++) {
    const candle = dayCandles[i];
    const time   = moment(candle.date).format('HH:mm');

    // Skip 9:15 candle
    if (time === '09:15') {
      firstCandleDone = true;
      continue;
    }
    if (!firstCandleDone) continue;

    // Hard exit time
    if (time >= CONFIG.EXIT_TIME) {
      if (trade && trade.status === 'OPEN') {
        const exitPnl = (candle.close - trade.entryOptionPrice) * CONFIG.QTY;
        trade.pnl        = parseFloat(exitPnl.toFixed(2));
        trade.exitTime   = time;
        trade.closeReason = 'TIME_EXIT';
        trade.status     = 'CLOSED';
      }
      break;
    }

    // Monitor open trade
    if (trade && trade.status === 'OPEN') {
      const ltp = candle.close;
      const pnl = (ltp - trade.entryOptionPrice) * CONFIG.QTY;

      // Trail activation
      if (pnl >= CONFIG.TRAIL_TRIGGER && !trade.trailing) {
        trade.trailing    = true;
        trade.trailSLPrice = parseFloat((trade.entryOptionPrice + trade.targetPremium).toFixed(2));
      }

      const slPrice = trade.trailing ? trade.trailSLPrice : trade.slOptionPrice;

      // SL hit
      if (ltp <= slPrice) {
        trade.pnl         = parseFloat(((slPrice - trade.entryOptionPrice) * CONFIG.QTY).toFixed(2));
        trade.exitTime    = time;
        trade.closeReason = trade.trailing ? 'TRAIL_SL' : 'SL_HIT';
        trade.status      = 'CLOSED';
        break;
      }

      // Target hit
      if (ltp >= trade.tgtOptionPrice) {
        trade.pnl         = parseFloat(((trade.tgtOptionPrice - trade.entryOptionPrice) * CONFIG.QTY).toFixed(2));
        trade.exitTime    = time;
        trade.closeReason = 'TARGET_HIT';
        trade.status      = 'CLOSED';
        break;
      }

      trade.pnl = parseFloat(pnl.toFixed(2));
      continue;
    }

    // Already traded today
    if (trade) continue;

    // Check setup
    setupCandles.push(candle);
    if (setupCandles.length < 2) continue;

    const c1     = setupCandles[setupCandles.length - 2];
    const c2     = setupCandles[setupCandles.length - 1];
    const c1Green = c1.close > c1.open;
    const c2Green = c2.close > c2.open;

    // Opposite colors
    if (c1Green === c2Green) {
      currentSetup = null;
      continue;
    }

    // Combined range
    const highestHigh   = Math.max(c1.high, c2.high);
    const lowestLow     = Math.min(c1.low,  c2.low);
    const combinedRange = highestHigh - lowestLow;

    if (combinedRange > CONFIG.MAX_RANGE_POINTS) {
      currentSetup = null;
      continue;
    }

    currentSetup = { highestHigh, lowestLow, combinedRange };

    // Check breakout on NEXT candle
    const nextCandle = dayCandles[i + 1];
    if (!nextCandle) continue;

    const nextTime = moment(nextCandle.date).format('HH:mm');
    if (nextTime >= CONFIG.EXIT_TIME) continue;

    const ceBreakout = nextCandle.high > highestHigh;
    const peBreakout = nextCandle.low  < lowestLow;

    if (!ceBreakout && !peBreakout) continue;

    // Direction
    let direction;
    if (ceBreakout && peBreakout) {
      const distCE = Math.abs(nextCandle.open - highestHigh);
      const distPE = Math.abs(nextCandle.open - lowestLow);
      direction = distCE <= distPE ? 'CE' : 'PE';
    } else {
      direction = ceBreakout ? 'CE' : 'PE';
    }

    // Entry prices
    const entryNifty  = direction === 'CE' ? highestHigh : lowestLow;
    const slNifty     = direction === 'CE' ? lowestLow   : highestHigh;
    const slPoints    = Math.abs(entryNifty - slNifty);
    const tgtPoints   = slPoints * 3;

    const slPremium  = parseFloat((slPoints  * CONFIG.DELTA).toFixed(2));
    const tgtPremium = parseFloat((tgtPoints * CONFIG.DELTA).toFixed(2));

    // Simulate option entry price (use a % of nifty move)
    // ATM option premium roughly = 0.5% of NIFTY spot
    const spotApprox       = nextCandle.open;
    const entryOptionPrice = parseFloat((spotApprox * 0.005).toFixed(2));
    const slOptionPrice    = parseFloat((entryOptionPrice - slPremium).toFixed(2));
    const tgtOptionPrice   = parseFloat((entryOptionPrice + tgtPremium).toFixed(2));

    trade = {
      date:             moment(candle.date).format('YYYY-MM-DD'),
      entryTime:        nextTime,
      direction,
      niftyEntry:       entryNifty,
      niftySL:          slNifty,
      niftyTarget:      direction === 'CE' ? entryNifty + tgtPoints : entryNifty - tgtPoints,
      entryOptionPrice,
      slOptionPrice,
      tgtOptionPrice,
      targetPremium:    tgtPremium,
      slPremium,
      slPoints:         parseFloat(slPoints.toFixed(2)),
      tgtPoints:        parseFloat(tgtPoints.toFixed(2)),
      qty:              CONFIG.QTY,
      status:           'OPEN',
      pnl:              0,
      trailing:         false,
      trailSLPrice:     null,
    };

    i++; // skip next candle (already used for breakout check)
  }

  return trade;
}

// ─────────────────────────────────────────
// MAIN BACKTEST
// ─────────────────────────────────────────
function runBacktest() {
  console.log('\n🚀 Starting ATM Scalping Backtest...\n');

  const min3Data  = loadData('3minute');
  const byDate    = groupByDate(min3Data);
  const dates     = Object.keys(byDate).sort();

  console.log(`📅 Total trading days: ${dates.length}\n`);

  const trades   = [];
  let   totalPnl = 0;

  for (const date of dates) {
    const dayCandles = byDate[date];
    const trade      = simulateDay(dayCandles);
    if (!trade) continue;

    trades.push(trade);
    totalPnl += trade.pnl;

    const emoji = trade.pnl >= 0 ? '✅' : '❌';
    console.log(`${emoji} ${trade.date} | ${trade.direction} | Entry:${trade.niftyEntry} | P&L:₹${trade.pnl.toFixed(0)} | ${trade.closeReason}`);
  }

  // ── Stats ──
  const winners    = trades.filter(t => t.pnl > 0);
  const losers     = trades.filter(t => t.pnl < 0);
  const winRate    = trades.length ? (winners.length / trades.length * 100) : 0;
  const avgWin     = winners.length ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLoss    = losers.length  ? losers.reduce((s, t)  => s + t.pnl, 0) / losers.length  : 0;
  const bestTrade  = trades.reduce((b, t) => t.pnl > (b?.pnl || -Infinity) ? t : b, null);
  const worstTrade = trades.reduce((w, t) => t.pnl < (w?.pnl || Infinity)  ? t : w, null);

  // Max drawdown
  let peak = 0, maxDD = 0, runningPnl = 0;
  for (const t of trades) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe
  const returns   = trades.map(t => t.pnl / CONFIG.CAPITAL);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdDev    = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1));
  const sharpe    = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Monthly
  const monthly = {};
  for (const t of trades) {
    const m = moment(t.date).format('YYYY-MM');
    if (!monthly[m]) monthly[m] = { pnl: 0, trades: 0, wins: 0 };
    monthly[m].pnl    += t.pnl;
    monthly[m].trades += 1;
    monthly[m].wins   += t.pnl > 0 ? 1 : 0;
  }

  // Close reasons
  const reasons = {};
  for (const t of trades) {
    reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1;
  }

  const stats = {
    strategy:    'ATM Scalping',
    totalTrades: trades.length,
    winners:     winners.length,
    losers:      losers.length,
    winRate:     parseFloat(winRate.toFixed(2)),
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    avgWin:      parseFloat(avgWin.toFixed(2)),
    avgLoss:     parseFloat(avgLoss.toFixed(2)),
    bestTrade,
    worstTrade,
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    sharpeRatio: parseFloat(sharpe.toFixed(2)),
    monthly,
    reasons,
    trades,
  };

  const outputPath = path.join(__dirname, '../data/backtest_scalping.json');
  fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));

  console.log(`\n✅ Results saved: ${outputPath}`);
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Trades:       ${stats.totalTrades}`);
  console.log(`   Win rate:     ${stats.winRate}%`);
  console.log(`   Total P&L:    ₹${stats.totalPnl}`);
  console.log(`   Max drawdown: ₹${stats.maxDrawdown}`);
  console.log(`   Sharpe:       ${stats.sharpeRatio}`);

  return stats;
}

runBacktest();
