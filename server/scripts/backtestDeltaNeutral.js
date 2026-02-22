/**
 * Delta Neutral Backtest
 *
 * Strategy Rules:
 * - Entry: Every Friday at 3:20 PM on SENSEX options
 * - Buy 0.50 delta (ATM call & put) + Sell 0.40 delta (near-OTM call & put)
 * - Hold overnight Fri → Mon
 * - Exit: Monday 3:20 PM if SL or trail not hit earlier
 *
 * Stop Losses (leg-level on simulated premiums):
 * - Combined net position -60% → Exit ALL (sells first)
 * - Call Buy leg -60% → Exit Call Buy + Call Sell pair
 * - Put Buy leg -60% → Exit Put Buy + Put Sell pair
 * - Call Sell +60% → Exit Call Sell only
 * - Put Sell +60% → Exit Put Sell only
 *
 * Trailing (last surviving buy leg):
 * - ₹1000 profit → lock ₹250
 * - ₹2000 → lock ₹1000
 * - ₹3000 → lock ₹1750
 * - Every +₹1000 after → lock +₹750 more
 * - No upper limit — hold till trail or Monday 3:20 PM
 */

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const MarketData = require('../src/models/MarketData');

const DATA_DIR    = path.join(__dirname, '../data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest_delta_neutral.json');

const CFG = {
  LOT_SIZE:     20,
  ENTRY_DAY:    5,       // Friday
  ENTRY_TIME:   '15:20',
  EXIT_DAY:     1,       // Monday
  EXIT_TIME:    '15:20',
  LEG_SL_PCT:   0.60,    // 60% loss on a buy leg → exit that pair
  SELL_SL_PCT:  0.60,    // 60% gain on a sell leg → exit that sell leg
  NET_SL_PCT:   0.60,    // 60% combined loss → exit all
  // Simulated entry premiums (ATM & near-OTM on SENSEX options)
  CALL_BUY_PREMIUM:  120, // 0.50 delta
  PUT_BUY_PREMIUM:   120,
  CALL_SELL_PREMIUM:  80, // 0.40 delta
  PUT_SELL_PREMIUM:   80,
};

// Net debit = (buyPremiums - sellPremiums) per unit
const NET_DEBIT = (CFG.CALL_BUY_PREMIUM + CFG.PUT_BUY_PREMIUM) -
                  (CFG.CALL_SELL_PREMIUM + CFG.PUT_SELL_PREMIUM); // = 80

/**
 * Simulate premium movement based on spot change from entry.
 * ATM options ~0.5 delta, near-OTM ~0.4 delta.
 */
function simulatePremiums(entrySpot, currentSpot, leg) {
  const move = currentSpot - entrySpot;
  const delta = leg.includes('Buy') ? 0.50 : 0.40;
  const isCall = leg.includes('call');
  const sign   = isCall ? 1 : -1;
  // Also add time decay per candle (roughly)
  const theta  = leg.includes('Buy') ? -0.5 : 0.5; // buy legs lose, sell legs gain from theta
  return Math.max(0.1, (leg.includes('Buy') ?
    (isCall ? CFG.CALL_BUY_PREMIUM  : CFG.PUT_BUY_PREMIUM) :
    (isCall ? CFG.CALL_SELL_PREMIUM : CFG.PUT_SELL_PREMIUM)
  ) + sign * delta * move);
}

function lockedProfitForPnl(pnl) {
  const levels = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
  const locks  = [ 250, 1000, 1750, 2500, 3250, 4000, 4750, 5500];
  let locked = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    if (pnl >= levels[i]) { locked = locks[i]; break; }
  }
  return locked;
}

async function runBacktest() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    // Use 15min SENSEX data for monitoring
    const candles = await MarketData.find({ index: 'SENSEX', interval: '15minute' })
      .sort({ date: 1 }).lean();

    if (candles.length < 50) throw new Error('Insufficient SENSEX 15min data.');

    const trades = [];
    let pos = null;

    for (let i = 0; i < candles.length; i++) {
      const c    = candles[i];
      const date = new Date(c.date);
      const day  = date.getDay();
      const time = c.date.substring(11, 16);
      const dateStr = c.date.substring(0, 10);

      // ── ENTRY: Friday 3:20 PM ───────────────────────────────────────────────
      if (!pos && day === CFG.ENTRY_DAY && time === CFG.ENTRY_TIME) {
        pos = {
          entrySpot:  c.close,
          entryDate:  dateStr,
          entrySpotPrice: c.close,
          legs: {
            callBuy:  { premium: CFG.CALL_BUY_PREMIUM,  status: 'ACTIVE', type: 'BUY',  isCall: true  },
            putBuy:   { premium: CFG.PUT_BUY_PREMIUM,   status: 'ACTIVE', type: 'BUY',  isCall: false },
            callSell: { premium: CFG.CALL_SELL_PREMIUM, status: 'ACTIVE', type: 'SELL', isCall: true  },
            putSell:  { premium: CFG.PUT_SELL_PREMIUM,  status: 'ACTIVE', type: 'SELL', isCall: false },
          },
          trailSL:      null,
          closeReason:  null,
        };
        continue;
      }

      // ── MONITOR ─────────────────────────────────────────────────────────────
      if (pos) {
        const spot = c.close;
        const l    = pos.legs;

        // Update current premiums
        const cur = {
          callBuy:  simulatePremiums(pos.entrySpot, spot, 'callBuy'),
          putBuy:   simulatePremiums(pos.entrySpot, spot, 'putBuy'),
          callSell: simulatePremiums(pos.entrySpot, spot, 'callSell'),
          putSell:  simulatePremiums(pos.entrySpot, spot, 'putSell'),
        };

        // P&L per lot
        const pnlPerUnit = (
          (l.callBuy.status  === 'ACTIVE' ? cur.callBuy  - CFG.CALL_BUY_PREMIUM  : 0) +
          (l.putBuy.status   === 'ACTIVE' ? cur.putBuy   - CFG.PUT_BUY_PREMIUM   : 0) +
          (l.callSell.status === 'ACTIVE' ? CFG.CALL_SELL_PREMIUM - cur.callSell : 0) +
          (l.putSell.status  === 'ACTIVE' ? CFG.PUT_SELL_PREMIUM  - cur.putSell  : 0)
        );
        const pnlRs = pnlPerUnit * CFG.LOT_SIZE;

        // ── SL CHECKS ─────────────────────────────────────────────────────────

        // 1. Combined net -60% → Exit all (sell legs first)
        const netDebitRs = NET_DEBIT * CFG.LOT_SIZE;
        if (pnlRs <= -(netDebitRs * CFG.NET_SL_PCT)) {
          pos.closeReason = 'Combined 60% SL';
          closeTrade(pos, cur, pnlRs, trades, dateStr, time);
          pos = null; continue;
        }

        // 2. Call Buy -60% → Exit Call Buy + Call Sell pair
        if (l.callBuy.status === 'ACTIVE') {
          const cbLoss = (cur.callBuy - CFG.CALL_BUY_PREMIUM) / CFG.CALL_BUY_PREMIUM;
          if (cbLoss <= -CFG.LEG_SL_PCT) {
            l.callBuy.status  = 'EXITED'; l.callBuy.exitPremium  = cur.callBuy;
            l.callSell.status = 'EXITED'; l.callSell.exitPremium = cur.callSell;
            console.log(`[DN] ${dateStr} ${time} | Call Buy -60% SL → Exit Call pair`);
          }
        }

        // 3. Put Buy -60% → Exit Put Buy + Put Sell pair
        if (l.putBuy.status === 'ACTIVE') {
          const pbLoss = (cur.putBuy - CFG.PUT_BUY_PREMIUM) / CFG.PUT_BUY_PREMIUM;
          if (pbLoss <= -CFG.LEG_SL_PCT) {
            l.putBuy.status  = 'EXITED'; l.putBuy.exitPremium  = cur.putBuy;
            l.putSell.status = 'EXITED'; l.putSell.exitPremium = cur.putSell;
            console.log(`[DN] ${dateStr} ${time} | Put Buy -60% SL → Exit Put pair`);
          }
        }

        // 4. Call Sell +60% gain → Exit Call Sell only
        if (l.callSell.status === 'ACTIVE') {
          const csGain = (CFG.CALL_SELL_PREMIUM - cur.callSell) / CFG.CALL_SELL_PREMIUM;
          if (csGain >= CFG.SELL_SL_PCT) {
            l.callSell.status = 'EXITED'; l.callSell.exitPremium = cur.callSell;
            console.log(`[DN] ${dateStr} ${time} | Call Sell +60% → Exit Call Sell`);
          }
        }

        // 5. Put Sell +60% gain → Exit Put Sell only
        if (l.putSell.status === 'ACTIVE') {
          const psGain = (CFG.PUT_SELL_PREMIUM - cur.putSell) / CFG.PUT_SELL_PREMIUM;
          if (psGain >= CFG.SELL_SL_PCT) {
            l.putSell.status = 'EXITED'; l.putSell.exitPremium = cur.putSell;
            console.log(`[DN] ${dateStr} ${time} | Put Sell +60% → Exit Put Sell`);
          }
        }

        // ── CHECK IF ONLY ONE BUY LEG REMAINS (trail mode) ───────────────────
        const activeBuyLegs  = ['callBuy', 'putBuy'].filter(k => l[k].status === 'ACTIVE');
        const activeSellLegs = ['callSell', 'putSell'].filter(k => l[k].status === 'ACTIVE');

        if (activeBuyLegs.length === 1 && activeSellLegs.length === 0) {
          // Last buy leg — apply trailing
          const lastLegKey  = activeBuyLegs[0];
          const entryPrem   = lastLegKey === 'callBuy' ? CFG.CALL_BUY_PREMIUM : CFG.PUT_BUY_PREMIUM;
          const lastLegPnl  = (cur[lastLegKey] - entryPrem) * CFG.LOT_SIZE;

          const locked = lockedProfitForPnl(lastLegPnl);
          if (locked > 0 && pos.trailSL === null) pos.trailSL = locked;
          if (locked > (pos.trailSL || 0)) pos.trailSL = locked;

          // Trail SL hit
          if (pos.trailSL !== null && lastLegPnl <= pos.trailSL) {
            pos.closeReason = 'Trail SL Hit';
            closeTrade(pos, cur, pnlRs, trades, dateStr, time);
            pos = null; continue;
          }
        }

        // All legs exited
        if (activeBuyLegs.length === 0) {
          pos.closeReason = 'All Legs Exited';
          closeTrade(pos, cur, pnlRs, trades, dateStr, time);
          pos = null; continue;
        }

        // ── MONDAY 3:20 PM EXIT ───────────────────────────────────────────────
        if (day === CFG.EXIT_DAY && time >= CFG.EXIT_TIME) {
          pos.closeReason = 'Monday 15:20 Exit';
          closeTrade(pos, cur, pnlRs, trades, dateStr, time);
          pos = null;
        }
      }
    }

    // Stats
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winners  = trades.filter(t => t.pnl > 0);
    const losers   = trades.filter(t => t.pnl <= 0);
    const winRate  = trades.length ? parseFloat((winners.length / trades.length * 100).toFixed(1)) : 0;

    const monthly = {};
    trades.forEach(t => {
      const m = t.date.substring(0, 7);
      if (!monthly[m]) monthly[m] = { pnl: 0, trades: 0 };
      monthly[m].pnl += t.pnl; monthly[m].trades++;
    });

    const reasons = {};
    trades.forEach(t => { reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1; });

    let peak = 0, cumPnl = 0, maxDrawdown = 0;
    trades.forEach(t => {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    });

    const mean     = trades.length ? totalPnl / trades.length : 0;
    const variance = trades.length ? trades.reduce((s,t) => s + Math.pow(t.pnl - mean, 2), 0) / trades.length : 0;
    const sharpe   = variance > 0 ? parseFloat((mean / Math.sqrt(variance)).toFixed(2)) : 0;

    const stats = {
      strategyName: 'deltaneutral',
      totalPnl,
      totalTrades:  trades.length,
      winRate,
      winners:      winners.length,
      losers:       losers.length,
      avgWin:       winners.length ? Math.round(winners.reduce((s,t)=>s+t.pnl,0)/winners.length) : 0,
      avgLoss:      losers.length  ? Math.round(losers.reduce((s,t)=>s+t.pnl,0)/losers.length)  : 0,
      maxDrawdown:  Math.round(maxDrawdown),
      sharpeRatio:  sharpe,
      bestTrade:    trades.reduce((b,t) => (!b||t.pnl>b.pnl)?t:b, null),
      worstTrade:   trades.reduce((w,t) => (!w||t.pnl<w.pnl)?t:w, null),
      monthly,
      reasons,
      trades,
      lastUpdated:  new Date().toISOString(),
    };

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(stats, null, 2));
    console.log(`\n✅ Delta Neutral Backtest Complete | Trades=${trades.length} | P&L=₹${totalPnl} | WinRate=${winRate}%`);

  } catch (err) {
    console.error('❌ Backtest error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

function closeTrade(pos, cur, pnlRs, trades, dateStr, time) {
  trades.push({
    date:        pos.entryDate,
    exitDate:    dateStr,
    strategy:    'deltaneutral',
    entrySpot:   pos.entrySpot,
    closeReason: pos.closeReason,
    exitTime:    time,
    pnl:         Math.round(pnlRs),
  });
  console.log(`[DN] EXIT ${dateStr} ${time} | Reason=${pos.closeReason} | P&L=₹${Math.round(pnlRs)}`);
}

runBacktest();
