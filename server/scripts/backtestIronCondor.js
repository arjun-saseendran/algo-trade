require('dotenv').config({ path: '../.env' });
const fs     = require('fs');
const path   = require('path');
const moment = require('moment');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL:         100000,

  NIFTY: {
    NAME:          'NIFTY',
    SPREAD_WIDTH:  150,
    ONE_PERCENT:   12,   // ₹12 = 1% for NIFTY
    TARGET_CREDIT: 12,   // combined net credit target
    ENTRY_DAY:     1,    // Monday
    EXPIRY_DAY:    2,    // Tuesday
  },

  SENSEX: {
    NAME:          'SENSEX',
    SPREAD_WIDTH:  500,
    ONE_PERCENT:   38,
    TARGET_CREDIT: 38,
    ENTRY_DAY:     3,    // Wednesday
    EXPIRY_DAY:    4,    // Thursday
  },

  MAX_LOSS_PCT:      0.06,   // 6% — hold till expiry
  ADJUSTMENT_3X:     3,
  DECAY_70:          0.70,
  MAX_ROLLS:         2,
  IV:                0.15,
};

// ─────────────────────────────────────────
// LOAD DATA
// ─────────────────────────────────────────
function loadData(exchange, symbol, interval) {
  const filePath = path.join(__dirname, `../data/historical/${exchange}/${symbol}/${interval}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`✅ Loaded ${data.length} ${symbol} ${interval} candles`);
  return data;
}

// ─────────────────────────────────────────
// SIMULATE OPTION PREMIUM (simplified)
// ─────────────────────────────────────────
function simulatePremium(spot, daysToExpiry, pctOTM, iv = CONFIG.IV) {
  // Simplified BS approximation
  const T    = daysToExpiry / 365;
  const dist = spot * pctOTM;
  const atm  = spot * iv * Math.sqrt(T) * 0.4; // ATM premium ≈ σ√T × 0.4
  const premium = Math.max(atm - dist * 0.5, 0.5);
  return parseFloat(premium.toFixed(2));
}

// ─────────────────────────────────────────
// SIMULATE ONE IRON CONDOR TRADE
// ─────────────────────────────────────────
function simulateTrade(index, entryCandle, expiryCandle, daysBetween, min15ByDate) {
  const cfg       = CONFIG[index];
  const spot      = entryCandle.close;

  // Simulate premiums
  const callSell  = simulatePremium(spot, daysBetween, 0.005);
  const putSell   = simulatePremium(spot, daysBetween, 0.005);
  const callBuy   = parseFloat((callSell * 0.35).toFixed(2)); // hedge ~35% of sell
  const putBuy    = parseFloat((putSell  * 0.35).toFixed(2));

  const callNet   = parseFloat((callSell - callBuy).toFixed(2));
  const putNet    = parseFloat((putSell  - putBuy).toFixed(2));
  const totalCredit = parseFloat((callNet + putNet).toFixed(2));

  // Check minimum credit
  if (totalCredit < cfg.TARGET_CREDIT * 0.8) return null;

  // Strikes
  const callSellStrike = parseFloat((spot * 1.005).toFixed(0));
  const putSellStrike  = parseFloat((spot * 0.995).toFixed(0));
  const callBuyStrike  = callSellStrike + cfg.SPREAD_WIDTH;
  const putBuyStrike   = putSellStrike  - cfg.SPREAD_WIDTH;

  const maxLoss    = parseFloat((cfg.SPREAD_WIDTH - totalCredit).toFixed(2));
  const maxLossPct = parseFloat((maxLoss / CONFIG.CAPITAL * 100).toFixed(2));

  // Simulate expiry P&L based on spot movement
  const expirySpot = expiryCandle.close;
  const move       = ((expirySpot - spot) / spot) * 100;
  const absMoveAmt = Math.abs(expirySpot - spot);

  let pnl;
  let closeReason;

  // Check if spot breached our spreads at expiry
  if (expirySpot > callSellStrike) {
    // Call spread breached
    const breach = Math.min(expirySpot - callSellStrike, cfg.SPREAD_WIDTH);
    pnl = parseFloat((totalCredit - breach).toFixed(2));
    closeReason = 'CALL_BREACH';
  } else if (expirySpot < putSellStrike) {
    // Put spread breached
    const breach = Math.min(putSellStrike - expirySpot, cfg.SPREAD_WIDTH);
    pnl = parseFloat((totalCredit - breach).toFixed(2));
    closeReason = 'PUT_BREACH';
  } else {
    // Expired in range — full credit
    pnl = totalCredit;
    closeReason = 'EXPIRED_WORTHLESS';
  }

  // Check 6% loss — hold till expiry (no exit)
  const pnlRupees = pnl * (index === 'NIFTY' ? 50 : 10);

  // Simulate adjustment impact
  let adjustmentBonus = 0;
  if (closeReason !== 'EXPIRED_WORTHLESS') {
    // One roll possible — add some credit
    adjustmentBonus = totalCredit * 0.3;
  }

  const finalPnlRupees = parseFloat((pnlRupees + adjustmentBonus).toFixed(2));

  return {
    index,
    date:            moment(entryCandle.date).format('YYYY-MM-DD'),
    expiryDate:      moment(expiryCandle.date).format('YYYY-MM-DD'),
    entrySpot:       spot,
    expirySpot,
    move:            parseFloat(move.toFixed(2)),
    callSellStrike,
    putSellStrike,
    callBuyStrike,
    putBuyStrike,
    callNet,
    putNet,
    totalCredit,
    maxLossPct,
    pnl:             finalPnlRupees,
    closeReason,
    month:           moment(entryCandle.date).format('YYYY-MM'),
  };
}

// ─────────────────────────────────────────
// RUN FOR ONE INDEX
// ─────────────────────────────────────────
function backtestIndex(index, dayData) {
  const cfg    = CONFIG[index];
  const trades = [];

  // Group by week
  const byDate = {};
  for (const c of dayData) {
    byDate[moment(c.date).format('YYYY-MM-DD')] = c;
  }
  const dates = Object.keys(byDate).sort();

  for (const date of dates) {
    const dow = moment(date).day();
    if (dow !== cfg.ENTRY_DAY) continue;

    // Find next expiry day candle
    let expiryDate = null;
    for (let d = 1; d <= 7; d++) {
      const candidate = moment(date).add(d, 'days').format('YYYY-MM-DD');
      if (moment(candidate).day() === cfg.EXPIRY_DAY && byDate[candidate]) {
        expiryDate = candidate;
        break;
      }
    }
    if (!expiryDate) continue;

    const entryCandle  = byDate[date];
    const expiryCandle = byDate[expiryDate];
    const daysBetween  = moment(expiryDate).diff(moment(date), 'days');

    const trade = simulateTrade(index, entryCandle, expiryCandle, daysBetween, {});
    if (!trade) continue;

    trades.push(trade);
    const emoji = trade.pnl >= 0 ? '✅' : '❌';
    console.log(`${emoji} [${index}] ${trade.date} → ${trade.expiryDate} | Move:${trade.move}% | P&L:₹${trade.pnl.toFixed(0)} | ${trade.closeReason}`);
  }

  return trades;
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
function runBacktest() {
  console.log('\n🚀 Starting Iron Condor Backtest...\n');

  const niftyDay  = loadData('NSE', 'NIFTY_50', 'day');
  const sensexDay = loadData('BSE', 'SENSEX',   'day');

  console.log('\n--- NIFTY ---');
  const niftyTrades  = backtestIndex('NIFTY',  niftyDay);

  console.log('\n--- SENSEX ---');
  const sensexTrades = backtestIndex('SENSEX', sensexDay);

  const allTrades = [...niftyTrades, ...sensexTrades].sort((a, b) => a.date.localeCompare(b.date));

  // ── Stats ──
  const calcStats = (trades, name) => {
    const winners    = trades.filter(t => t.pnl > 0);
    const losers     = trades.filter(t => t.pnl < 0);
    const totalPnl   = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate    = trades.length ? (winners.length / trades.length * 100) : 0;
    const avgWin     = winners.length ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
    const avgLoss    = losers.length  ? losers.reduce((s, t)  => s + t.pnl, 0) / losers.length  : 0;
    const bestTrade  = trades.reduce((b, t) => t.pnl > (b?.pnl || -Infinity) ? t : b, null);
    const worstTrade = trades.reduce((w, t) => t.pnl < (w?.pnl || Infinity)  ? t : w, null);

    let peak = 0, maxDD = 0, running = 0;
    for (const t of trades) {
      running += t.pnl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    const returns   = trades.map(t => t.pnl / CONFIG.CAPITAL);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const stdDev    = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1));
    const sharpe    = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(52) : 0;

    const monthly = {};
    for (const t of trades) {
      const m = t.month;
      if (!monthly[m]) monthly[m] = { pnl: 0, trades: 0, wins: 0 };
      monthly[m].pnl    += t.pnl;
      monthly[m].trades += 1;
      monthly[m].wins   += t.pnl > 0 ? 1 : 0;
    }

    const reasons = {};
    for (const t of trades) {
      reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1;
    }

    return {
      strategy:    name,
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
  };

  const stats = calcStats(allTrades, 'Iron Condor');
  stats.niftyStats  = calcStats(niftyTrades,  'Iron Condor NIFTY');
  stats.sensexStats = calcStats(sensexTrades, 'Iron Condor SENSEX');

  const outputPath = path.join(__dirname, '../data/backtest_iron_condor.json');
  fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));

  console.log(`\n✅ Results saved: ${outputPath}`);
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Total trades: ${stats.totalTrades} (NIFTY: ${niftyTrades.length} | SENSEX: ${sensexTrades.length})`);
  console.log(`   Win rate:     ${stats.winRate}%`);
  console.log(`   Total P&L:    ₹${stats.totalPnl}`);
  console.log(`   Max drawdown: ₹${stats.maxDrawdown}`);
  console.log(`   Sharpe:       ${stats.sharpeRatio}`);

  return stats;
}

runBacktest();
