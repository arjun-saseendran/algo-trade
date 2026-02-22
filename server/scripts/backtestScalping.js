/**
 * ATM Scalping Backtest
 *
 * Strategy Rules:
 * - Every 3-min candle, look for setup
 * - SKIP the first 3-min candle of the day (9:15–9:18 candle) — neither c1 nor c2 can be it
 * - Setup: last 2 candles are opposite colour AND combined high-low range < 30 pts
 * - Wait for breakout above combined high → Buy CE, below combined low → Buy PE
 * - SL = setup high/low boundary; Target = 3× SL distance; Trail at 1:3
 * - Hard exit at 3:21 PM
 * - Max 1 trade per day
 */

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const MarketData = require('../src/models/MarketData');

const DATA_DIR    = path.join(__dirname, '../data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest_scalping.json');

const CONFIG = {
  INDEX:       'NIFTY',
  LOT_SIZE:    65,
  TIME_FRAME:  '3minute',
  RANGE_LIMIT: 30,      // pts
  EXIT_TIME:   '15:21',
  DELTA:       0.5,     // approx option delta for ATM
};

async function runBacktest() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const candles = await MarketData.find({ index: CONFIG.INDEX, interval: CONFIG.TIME_FRAME })
      .sort({ date: 1 }).lean();

    if (candles.length < 100) throw new Error('Insufficient data in MongoDB. Download historical data first.');

    // Group by trading day
    const days = {};
    candles.forEach(c => {
      const d = c.date.substring(0, 10);
      if (!days[d]) days[d] = [];
      days[d].push(c);
    });

    const trades = [];

    for (const day of Object.keys(days).sort()) {
      const dc = days[day];
      if (dc.length < 5) continue;

      // dc[0] = 9:15 candle (the "first 3-min candle" — ALWAYS SKIP as c1 or c2)
      // So valid pairs start at: c1=dc[1] (9:18), c2=dc[2] (9:21) onward
      // i starts at 2 so c1=dc[i-1] is never dc[0]

      let entryFound = false;

      for (let i = 2; i < dc.length && !entryFound; i++) {
        const c1   = dc[i - 1];
        const c2   = dc[i];
        const time = c2.date.substring(11, 16);

        if (time >= CONFIG.EXIT_TIME) break;

        // Opposite colour candles
        const c1Green  = c1.close > c1.open;
        const c2Green  = c2.close > c2.open;
        if (c1Green === c2Green) continue;

        // Combined range
        const setupHigh = Math.max(c1.high, c2.high);
        const setupLow  = Math.min(c1.low,  c2.low);
        const range     = setupHigh - setupLow;
        if (range >= CONFIG.RANGE_LIMIT) continue;

        // Valid setup — now wait for breakout on subsequent candles
        for (let j = i + 1; j < dc.length; j++) {
          const trigger     = dc[j];
          const triggerTime = trigger.date.substring(11, 16);
          if (triggerTime >= CONFIG.EXIT_TIME) break;

          if (trigger.high > setupHigh) {
            // CE breakout
            const trade = simulateTrade(dc, j, 'CE', setupHigh, setupLow);
            if (trade) { trades.push({ ...trade, date: day }); entryFound = true; }
            break;
          } else if (trigger.low < setupLow) {
            // PE breakout
            const trade = simulateTrade(dc, j, 'PE', setupHigh, setupLow);
            if (trade) { trades.push({ ...trade, date: day }); entryFound = true; }
            break;
          }
        }
      }
    }

    const stats = crunchStats(trades);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(stats, null, 2));
    console.log(`\n✅ ATM Scalping Backtest Complete | Trades=${trades.length} | P&L=₹${stats.totalPnl} | WinRate=${stats.winRate}%`);

  } catch (err) {
    console.error('❌ Backtest error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

/**
 * Simulate trade from breakout candle onward.
 * Entry = close of breakout candle.
 * SL = setupLow (for CE) or setupHigh (for PE).
 * Target = entry + 3 × SL distance.
 * Trail: once target hit, SL moves to breakeven then follows.
 */
function simulateTrade(dc, startIndex, type, setupHigh, setupLow) {
  const entryCandle = dc[startIndex];
  const entryPrice  = entryCandle.close;
  const entryTime   = entryCandle.date.substring(11, 16);

  const slPrice     = type === 'CE' ? setupLow  : setupHigh;
  const slDist      = Math.abs(entryPrice - slPrice);
  const tgtPrice    = type === 'CE' ? entryPrice + slDist * 3 : entryPrice - slDist * 3;

  if (slDist <= 0) return null;

  let trailSL    = slPrice; // moves up once trailing kicks in
  let trailActive = false;

  for (let k = startIndex + 1; k < dc.length; k++) {
    const c    = dc[k];
    const time = c.date.substring(11, 16);

    const pnlPoints = type === 'CE' ? c.close - entryPrice : entryPrice - c.close;

    // Hard time exit
    if (time >= CONFIG.EXIT_TIME) {
      return buildTrade(type, entryPrice, c.close, entryTime, time, 'TIME_EXIT', setupHigh, setupLow);
    }

    // SL check (trail SL)
    if (type === 'CE' && c.low  <= trailSL) return buildTrade(type, entryPrice, trailSL, entryTime, time, trailActive ? 'TRAIL_SL' : 'SL_HIT', setupHigh, setupLow);
    if (type === 'PE' && c.high >= trailSL) return buildTrade(type, entryPrice, trailSL, entryTime, time, trailActive ? 'TRAIL_SL' : 'SL_HIT', setupHigh, setupLow);

    // Target hit → activate trailing
    if (!trailActive) {
      if (type === 'CE' && c.high >= tgtPrice) {
        trailActive = true;
        trailSL     = entryPrice; // lock at breakeven first
      } else if (type === 'PE' && c.low <= tgtPrice) {
        trailActive = true;
        trailSL     = entryPrice;
      }
    } else {
      // Keep trailing SL behind current price
      if (type === 'CE') trailSL = Math.max(trailSL, c.close - slDist);
      if (type === 'PE') trailSL = Math.min(trailSL, c.close + slDist);
    }
  }

  // End of day with no exit
  const lastC = dc[dc.length - 1];
  return buildTrade(type, entryPrice, lastC.close, entryTime, lastC.date.substring(11, 16), 'TIME_EXIT', setupHigh, setupLow);
}

function buildTrade(type, entryPrice, exitPrice, entryTime, exitTime, closeReason, setupHigh, setupLow) {
  const pnlPoints = type === 'CE' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnl       = Math.round(pnlPoints * CONFIG.DELTA * CONFIG.LOT_SIZE);
  return { strategy: 'scalping', direction: type, entryPrice, exitPrice, entryTime, exitTime, closeReason, niftyEntry: entryPrice, pnl };
}

function crunchStats(trades) {
  const totalPnl   = trades.reduce((s, t) => s + t.pnl, 0);
  const winners    = trades.filter(t => t.pnl > 0);
  const losers     = trades.filter(t => t.pnl <= 0);
  const winRate    = trades.length ? parseFloat((winners.length / trades.length * 100).toFixed(1)) : 0;

  const monthly = {};
  trades.forEach(t => {
    const m = (t.date || '').substring(0, 7);
    if (!monthly[m]) monthly[m] = { pnl: 0, trades: 0 };
    monthly[m].pnl    += t.pnl;
    monthly[m].trades += 1;
  });

  const reasons = {};
  trades.forEach(t => { reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1; });

  // Running drawdown
  let peak = 0, cumPnl = 0, maxDrawdown = 0;
  trades.forEach(t => {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });

  // Sharpe (simplified daily)
  const mean = trades.length ? totalPnl / trades.length : 0;
  const variance = trades.length ? trades.reduce((s, t) => s + Math.pow(t.pnl - mean, 2), 0) / trades.length : 0;
  const sharpe = variance > 0 ? parseFloat((mean / Math.sqrt(variance)).toFixed(2)) : 0;

  return {
    strategyName: 'scalping',
    totalPnl,
    totalTrades:  trades.length,
    winRate,
    winners:      winners.length,
    losers:       losers.length,
    avgWin:       winners.length ? Math.round(winners.reduce((s,t)=>s+t.pnl,0)/winners.length) : 0,
    avgLoss:      losers.length  ? Math.round(losers.reduce((s,t)=>s+t.pnl,0)/losers.length)   : 0,
    maxDrawdown:  Math.round(maxDrawdown),
    sharpeRatio:  sharpe,
    bestTrade:    trades.reduce((b,t) => (!b||t.pnl>b.pnl)?t:b, null),
    worstTrade:   trades.reduce((w,t) => (!w||t.pnl<w.pnl)?t:w, null),
    monthly,
    reasons,
    trades,
    lastUpdated:  new Date().toISOString(),
  };
}

runBacktest();
