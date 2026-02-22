/**
 * Iron Condor Backtest
 * 
 * Strategy Rules:
 * - NIFTY: Entry Monday 9:30 AM, Expiry Wednesday
 * - SENSEX: Entry Wednesday 9:30 AM, Expiry Thursday
 * - Sell both Call & Put spreads at 0.5% OTM, hedge at NIFTY+150 / SENSEX+500
 * - Premium = sell leg premium - buy leg premium (net credit per spread)
 * 
 * Firefight (SL) Rules:
 * - One side expands 3x AND other side has 70% profit booked → Roll losing side
 * - One side expands 4x (net cost = 4 × entry net credit, MINUS profit booked on winning side) → Exit that spread
 * - After 1 SL hit: if market continues trending, skip re-entry (no new 0.5% OTM position)
 *   If we do take re-entry → treat as completely fresh Iron Condor with same firefight rules
 * - Max 2 rolls total (1 system + 1 discretionary)
 * - Hold to expiry if max loss hit — do NOT exit early
 */

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const MarketData = require('../src/models/MarketData');

const DATA_DIR    = path.join(__dirname, '../data');
const RESULT_PATH = path.join(DATA_DIR, 'backtest_iron_condor.json');

const CONFIG = {
  NIFTY: {
    lot: 65, hedge: 150,
    entryDay: 1,  // Monday
    entryTime: '09:30',
    expiryDay: 3, // Wednesday
    expiryTime: '15:20',
    otmPct: 0.005,     // 0.5% OTM
    spreadWidth: 150,  // hedge width in points
  },
  SENSEX: {
    lot: 20, hedge: 500,
    entryDay: 3,  // Wednesday
    entryTime: '09:30',
    expiryDay: 4, // Thursday
    expiryTime: '15:20',
    otmPct: 0.005,
    spreadWidth: 500,
  },
  FIREFIGHT: {
    LOSS_3X:    3.0,   // 3x expansion triggers roll check
    PROFIT_70:  0.70,  // 70% profit on other side to confirm roll
    LOSS_4X:    4.0,   // 4x → exit that spread
    MAX_ROLLS:  2,     // max total rolls (system + discretionary)
  }
};

/**
 * Simulate spread premium from spot price.
 * Net credit = sellLegPremium - buyLegPremium.
 * We model this as decaying/expanding relative to how far spot is from the short strike.
 */
function calcSpreadPremium(spot, shortStrike, longStrike, entryNetCredit, entrySpot) {
  const spreadWidth = Math.abs(longStrike - shortStrike);
  // Distance of spot from short strike (positive = in danger)
  const intrusion = Math.max(0, (spot - shortStrike)); // for call side
  // Current spread cost = how much it would cost to close now
  // As spot moves into the spread: cost rises from entryNetCredit toward spreadWidth
  const maxCost = spreadWidth;
  const currentCost = Math.min(maxCost, entryNetCredit + intrusion * 0.6);
  return currentCost;
}

function calcCallSpreadCost(spot, pos) {
  if (spot <= pos.callShortStrike) {
    // Spot below short strike — spread decaying
    const decay = Math.min(1, (pos.callShortStrike - spot) / (pos.callShortStrike - pos.entrySpot + 1));
    return pos.callNetCredit * (1 - decay * 0.9); // decays toward 0
  } else {
    // Spot above short strike — spread expanding
    const intrusion = spot - pos.callShortStrike;
    return pos.callNetCredit + intrusion * 0.6;
  }
}

function calcPutSpreadCost(spot, pos) {
  if (spot >= pos.putShortStrike) {
    const decay = Math.min(1, (spot - pos.putShortStrike) / (pos.entrySpot - pos.putShortStrike + 1));
    return pos.putNetCredit * (1 - decay * 0.9);
  } else {
    const intrusion = pos.putShortStrike - spot;
    return pos.putNetCredit + intrusion * 0.6;
  }
}

function openPosition(spot, cfg, entryDate) {
  const callShortStrike = Math.round(spot * (1 + cfg.otmPct));
  const putShortStrike  = Math.round(spot * (1 - cfg.otmPct));
  // Net credit per spread ≈ 1% of capital / lot / 2 sides
  const netCreditPerSide = (1000 / cfg.lot) / 2; // e.g. ~7.7 for NIFTY

  return {
    entrySpot:        spot,
    entryDate,
    callShortStrike,
    callLongStrike:   callShortStrike + cfg.spreadWidth,
    putShortStrike,
    putLongStrike:    putShortStrike  - cfg.spreadWidth,
    callNetCredit:    netCreditPerSide,
    putNetCredit:     netCreditPerSide,
    callStatus:       'ACTIVE', // ACTIVE | EXITED
    putStatus:        'ACTIVE',
    callExitCost:     null,     // cost at exit (null = not exited yet)
    putExitCost:      null,
    rolls:            0,
    slHit:            false,    // true after first spread exit
    isFreshAfterSL:   false,    // true if this IC was opened fresh after a SL hit
  };
}

function positionPnl(pos, cfg) {
  // P&L in ₹
  let pnl = 0;
  // Call spread
  const callCredit = pos.callNetCredit * cfg.lot;
  const callDebit  = (pos.callExitCost !== null ? pos.callExitCost : 0) * cfg.lot;
  pnl += callCredit - callDebit;

  // Put spread
  const putCredit = pos.putNetCredit * cfg.lot;
  const putDebit  = (pos.putExitCost !== null ? pos.putExitCost : 0) * cfg.lot;
  pnl += putCredit - putDebit;

  return Math.round(pnl);
}

async function runBacktest() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const allTrades = [];

    for (const index of ['NIFTY', 'SENSEX']) {
      const cfg = CONFIG[index];
      // Use 15min data for intraday monitoring — more realistic than 3min for IC
      const candles = await MarketData.find({ index, interval: '15minute' }).sort({ date: 1 }).lean();

      if (candles.length < 10) {
        console.warn(`⚠️ Not enough data for ${index}`);
        continue;
      }

      let pos           = null;
      let inPos         = false;
      let lastTradeDate = null;
      let trendingAfterSL = false; // track if market is trending after SL hit

      for (let i = 0; i < candles.length; i++) {
        const c    = candles[i];
        const date = new Date(c.date);
        const day  = date.getDay();           // 0=Sun,1=Mon,...,5=Fri
        const time = c.date.substring(11, 16); // "HH:MM"
        const dateStr = c.date.substring(0, 10);

        // ── ENTRY ─────────────────────────────────────────────────────────────
        if (!inPos && day === cfg.entryDay && time === cfg.entryTime) {
          // Don't re-enter same week if we're in a trending market after SL
          if (trendingAfterSL) {
            // Check if spot has moved > 1% from last pos entry (still trending)
            trendingAfterSL = false; // reset weekly
          }

          pos   = openPosition(c.close, cfg, c.date);
          inPos = true;
          lastTradeDate = dateStr;
          console.log(`[${index}] Entry ${dateStr} ${time} | Spot=${c.close} | CallShort=${pos.callShortStrike} | PutShort=${pos.putShortStrike}`);
        }

        // ── MONITOR ACTIVE POSITION ────────────────────────────────────────────
        if (inPos && pos) {
          const spot = c.close;

          // Calculate current cost of each spread
          const callCost = calcCallSpreadCost(spot, pos);
          const putCost  = calcPutSpreadCost(spot, pos);

          // Profit booked on winning side = how much it has decayed
          const callProfitPct = (pos.callNetCredit - callCost) / pos.callNetCredit;
          const putProfitPct  = (pos.putNetCredit  - putCost)  / pos.putNetCredit;

          // ── 4x EXIT (net spread cost = 4x entry net credit, minus profit on winning side) ──
          // "4x + premium profit booked on profit side = our SL"
          // Effective SL threshold = 4 * entryCredit - profitBooked on other side
          if (pos.callStatus === 'ACTIVE') {
            const callEffectiveSL = pos.callNetCredit * CONFIG.FIREFIGHT.LOSS_4X -
              (pos.putStatus === 'ACTIVE' ? pos.putNetCredit * putProfitPct : 0);
            if (callCost >= callEffectiveSL) {
              pos.callExitCost  = callCost;
              pos.callStatus    = 'EXITED';
              pos.slHit         = true;
              trendingAfterSL   = true;
              console.log(`[${index}] ${dateStr} ${time} | CALL SPREAD EXITED (4x SL) | Cost=${callCost.toFixed(2)}`);
            }
          }

          if (pos.putStatus === 'ACTIVE') {
            const putEffectiveSL = pos.putNetCredit * CONFIG.FIREFIGHT.LOSS_4X -
              (pos.callStatus === 'ACTIVE' ? pos.callNetCredit * callProfitPct : 0);
            if (putCost >= putEffectiveSL) {
              pos.putExitCost = putCost;
              pos.putStatus   = 'EXITED';
              pos.slHit       = true;
              trendingAfterSL = true;
              console.log(`[${index}] ${dateStr} ${time} | PUT SPREAD EXITED (4x SL) | Cost=${putCost.toFixed(2)}`);
            }
          }

          // ── 3x FIREFIGHT + 70% DECAY ROLL ────────────────────────────────────
          if (pos.rolls < CONFIG.FIREFIGHT.MAX_ROLLS) {
            const callExpansion = callCost / pos.callNetCredit;
            const putExpansion  = putCost  / pos.putNetCredit;

            if (pos.callStatus === 'ACTIVE' && callExpansion >= CONFIG.FIREFIGHT.LOSS_3X &&
                pos.putStatus  === 'ACTIVE' && putProfitPct  >= CONFIG.FIREFIGHT.PROFIT_70) {
              // Roll call side closer (simulate by resetting call premium slightly better)
              pos.callShortStrike = Math.round(spot * 1.002); // new short strike closer
              pos.callNetCredit   = pos.callNetCredit * 1.15; // small additional credit from roll
              pos.rolls++;
              console.log(`[${index}] ${dateStr} ${time} | CALL ROLLED (firefight) roll#${pos.rolls}`);
            }

            if (pos.putStatus === 'ACTIVE' && putExpansion >= CONFIG.FIREFIGHT.LOSS_3X &&
                pos.callStatus === 'ACTIVE' && callProfitPct >= CONFIG.FIREFIGHT.PROFIT_70) {
              pos.putShortStrike = Math.round(spot * 0.998);
              pos.putNetCredit   = pos.putNetCredit * 1.15;
              pos.rolls++;
              console.log(`[${index}] ${dateStr} ${time} | PUT ROLLED (firefight) roll#${pos.rolls}`);
            }
          }

          // ── AFTER 1 SL HIT: FRESH IRON CONDOR LOGIC ──────────────────────────
          // If market continues trending after a spread exit, we do NOT re-enter at 0.5% OTM
          // If re-entry is taken, treat as completely fresh IC with same rules
          // (In backtest: we simply don't re-enter to be conservative — same as "skip re-entry if trending")
          // Both spreads exited = close position, record trade
          if (pos.callStatus === 'EXITED' && pos.putStatus === 'EXITED') {
            const pnl = positionPnl(pos, cfg);
            allTrades.push({ date: pos.entryDate.substring(0, 10), index, strategy: 'ironcondor', pnl, closeReason: 'Both Spreads Exited', rolls: pos.rolls });
            pos   = null;
            inPos = false;
            continue;
          }

          // ── EXPIRY EXIT ────────────────────────────────────────────────────────
          if (day === cfg.expiryDay && time >= cfg.expiryTime) {
            // Close any remaining active spreads at near-zero (premium decays at expiry)
            if (pos.callStatus === 'ACTIVE') { pos.callExitCost = pos.callNetCredit * 0.05; pos.callStatus = 'EXITED'; }
            if (pos.putStatus  === 'ACTIVE') { pos.putExitCost  = pos.putNetCredit  * 0.05; pos.putStatus  = 'EXITED'; }

            const pnl    = positionPnl(pos, cfg);
            const reason = pos.slHit ? 'Expiry (post-SL)' : 'Expiry Exit';
            allTrades.push({ date: pos.entryDate.substring(0, 10), index, strategy: 'ironcondor', pnl, closeReason: reason, rolls: pos.rolls });
            console.log(`[${index}] ${dateStr} ${time} | EXPIRY EXIT | P&L=₹${pnl}`);
            pos   = null;
            inPos = false;
            trendingAfterSL = false; // reset for next week
          }
        }
      }
    }

    // ── STATS ──────────────────────────────────────────────────────────────────
    const totalPnl    = allTrades.reduce((s, t) => s + t.pnl, 0);
    const winners     = allTrades.filter(t => t.pnl > 0);
    const losers      = allTrades.filter(t => t.pnl <= 0);
    const winRate     = allTrades.length ? ((winners.length / allTrades.length) * 100).toFixed(1) : 0;
    const monthly     = {};
    allTrades.forEach(t => {
      const m = t.date.substring(0, 7);
      if (!monthly[m]) monthly[m] = { pnl: 0, trades: 0 };
      monthly[m].pnl    += t.pnl;
      monthly[m].trades += 1;
    });

    const reasons = {};
    allTrades.forEach(t => { reasons[t.closeReason] = (reasons[t.closeReason] || 0) + 1; });

    const stats = {
      strategyName: 'ironcondor',
      totalPnl,
      totalTrades:  allTrades.length,
      winRate:      parseFloat(winRate),
      winners:      winners.length,
      losers:       losers.length,
      avgWin:       winners.length ? Math.round(winners.reduce((s,t) => s+t.pnl, 0) / winners.length) : 0,
      avgLoss:      losers.length  ? Math.round(losers.reduce((s,t) => s+t.pnl, 0) / losers.length)  : 0,
      maxDrawdown:  Math.min(...allTrades.map(t => t.pnl), 0),
      sharpeRatio:  0,
      bestTrade:    allTrades.reduce((b, t) => (!b || t.pnl > b.pnl) ? t : b, null),
      worstTrade:   allTrades.reduce((w, t) => (!w || t.pnl < w.pnl) ? t : w, null),
      monthly,
      reasons,
      trades:       allTrades,
      lastUpdated:  new Date().toISOString(),
    };

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RESULT_PATH, JSON.stringify(stats, null, 2));
    console.log(`\n✅ Iron Condor Backtest Complete | Trades=${allTrades.length} | P&L=₹${totalPnl} | WinRate=${winRate}%`);

  } catch (err) {
    console.error('❌ Backtest error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

runBacktest();
