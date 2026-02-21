const moment = require('moment');
const logger  = require('../utils/logger');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL:        Number(process.env.CAPITAL) || 100000,
  LOT_SIZE:       20,
  ENTRY_DAY:      5,          // Friday
  ENTRY_TIME:     '15:20',
  MONITOR_TIME:   '09:15',    // Monday monitor start
  RISK_FREE_RATE: 0.065,      // 6.5% India

  // Delta targets
  BUY_DELTA:      0.50,       // ATM
  SELL_DELTA:     0.40,       // Near OTM
  DELTA_TOLERANCE: 0.03,      // ±0.03 acceptable

  // Stop loss
  LEG_SL_PERCENT:      0.60,  // 60% of entry premium
  COMBINED_SL_PERCENT: 0.60,  // 60% of net debit

  // Trailing (on last buy leg)
  TRAIL_LEVELS: [
    { profit: 1000, lock: 250  },
    { profit: 2000, lock: 1000 },
    { profit: 3000, lock: 1750 },
    { profit: 4000, lock: 2500 },
    { profit: 5000, lock: 3250 },
    { profit: 6000, lock: 4000 },
    { profit: 7000, lock: 4750 },
    { profit: 8000, lock: 5500 },
    { profit: 9000, lock: 6250 },
    { profit: 10000, lock: 7000 },
  ],
};

// ─────────────────────────────────────────
// BLACK-SCHOLES DELTA CALCULATION
// ─────────────────────────────────────────
function normalCDF(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function calculateDelta(spot, strike, timeToExpiry, riskFreeRate, iv, optionType) {
  try {
    if (timeToExpiry <= 0 || iv <= 0) return null;

    const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * iv * iv) * timeToExpiry)
               / (iv * Math.sqrt(timeToExpiry));

    if (optionType === 'CE') {
      return parseFloat(normalCDF(d1).toFixed(4));
    } else {
      return parseFloat((normalCDF(d1) - 1).toFixed(4));
    }
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────
// STRATEGY CLASS
// ─────────────────────────────────────────
class DeltaNeutralStrategy {
  constructor() {
    this.reset();
  }

  reset() {
    this.position     = this.emptyPosition();
    this.tradeHistory = [];
  }

  emptyPosition() {
    return {
      status:       'IDLE',   // IDLE | ACTIVE | PARTIAL | CLOSED
      entryDate:    null,
      entryTime:    null,
      expiryDate:   null,
      spotAtEntry:  null,
      netDebit:     0,        // total premium paid (buy - sell)
      combinedSL:   0,        // 60% of net debit
      legs: {
        callBuy:    null,
        callSell:   null,
        putBuy:     null,
        putSell:    null,
      },
      activeLegs:   [],       // which legs are still open
      lastBuyLeg:   null,     // final remaining buy leg
      trailLevel:   0,        // current trail level index
      lockedProfit: 0,        // currently locked profit
      trailSL:      null,     // trail SL price
      pnl:          0,
      alerts:       [],
    };
  }

  // ── Find best strike by delta ──────────
  findStrikeByDelta(optionChain, targetDelta, optionType, spot, expiryDate, iv) {
    const timeToExpiry = moment(expiryDate).diff(moment(), 'days') / 365;
    let   bestStrike   = null;
    let   bestDelta    = null;
    let   bestDiff     = Infinity;

    for (const option of optionChain) {
      if (option.instrument_type !== optionType) continue;

      // Use IV from market if available, else use provided IV
      const optionIV = option.iv || iv || 0.15;
      const delta    = calculateDelta(
        spot, option.strike, timeToExpiry,
        CONFIG.RISK_FREE_RATE, optionIV / 100, optionType
      );

      if (delta === null) continue;

      const absDelta = Math.abs(delta);
      const diff     = Math.abs(absDelta - Math.abs(targetDelta));

      if (diff < bestDiff) {
        bestDiff   = diff;
        bestStrike = option.strike;
        bestDelta  = delta;
      }
    }

    return { strike: bestStrike, delta: bestDelta };
  }

  // ── Open position ──────────────────────
  openPosition(spotPrice, legs, expiryDate) {
    // legs = { callBuy, callSell, putBuy, putSell }
    // each leg = { strike, premium, delta, tradingsymbol, iv }

    // Net debit = buy premiums - sell premiums
    const buyPremiums  = (legs.callBuy.premium  + legs.putBuy.premium)  * CONFIG.LOT_SIZE;
    const sellPremiums = (legs.callSell.premium + legs.putSell.premium) * CONFIG.LOT_SIZE;
    const netDebit     = parseFloat((buyPremiums - sellPremiums).toFixed(2));
    const combinedSL   = parseFloat((netDebit * CONFIG.COMBINED_SL_PERCENT).toFixed(2));

    // Net delta check
    const netDelta = parseFloat((
      legs.callBuy.delta  +
      legs.callSell.delta +
      legs.putBuy.delta   +
      legs.putSell.delta
    ).toFixed(4));

    logger.info(`📊 Net delta: ${netDelta} (target: 0)`);

    this.position = {
      ...this.emptyPosition(),
      status:      'ACTIVE',
      entryDate:   moment().format('YYYY-MM-DD'),
      entryTime:   moment().format('HH:mm'),
      expiryDate,
      spotAtEntry: spotPrice,
      netDebit,
      combinedSL,
      netDelta,
      legs: {
        callBuy: {
          ...legs.callBuy,
          status:    'ACTIVE',
          entryPremium: legs.callBuy.premium,
          sl:        parseFloat((legs.callBuy.premium * (1 - CONFIG.LEG_SL_PERCENT)).toFixed(2)),
          slRupees:  parseFloat((legs.callBuy.premium * CONFIG.LEG_SL_PERCENT * CONFIG.LOT_SIZE).toFixed(2)),
          pnl:       0,
        },
        callSell: {
          ...legs.callSell,
          status:    'ACTIVE',
          entryPremium: legs.callSell.premium,
          sl:        parseFloat((legs.callSell.premium * (1 + CONFIG.LEG_SL_PERCENT)).toFixed(2)),
          slRupees:  parseFloat((legs.callSell.premium * CONFIG.LEG_SL_PERCENT * CONFIG.LOT_SIZE).toFixed(2)),
          pnl:       0,
        },
        putBuy: {
          ...legs.putBuy,
          status:    'ACTIVE',
          entryPremium: legs.putBuy.premium,
          sl:        parseFloat((legs.putBuy.premium * (1 - CONFIG.LEG_SL_PERCENT)).toFixed(2)),
          slRupees:  parseFloat((legs.putBuy.premium * CONFIG.LEG_SL_PERCENT * CONFIG.LOT_SIZE).toFixed(2)),
          pnl:       0,
        },
        putSell: {
          ...legs.putSell,
          status:    'ACTIVE',
          entryPremium: legs.putSell.premium,
          sl:        parseFloat((legs.putSell.premium * (1 + CONFIG.LEG_SL_PERCENT)).toFixed(2)),
          slRupees:  parseFloat((legs.putSell.premium * CONFIG.LEG_SL_PERCENT * CONFIG.LOT_SIZE).toFixed(2)),
          pnl:       0,
        },
      },
      activeLegs:   ['callBuy', 'callSell', 'putBuy', 'putSell'],
      lastBuyLeg:   null,
      trailLevel:   0,
      lockedProfit: 0,
      trailSL:      null,
      pnl:          0,
      alerts:       [],
    };

    logger.info(`✅ DELTA NEUTRAL SPREAD OPENED`);
    logger.info(`   Spot: ${spotPrice} | Expiry: ${expiryDate}`);
    logger.info(`   Call Buy:  ${legs.callBuy.strike}  delta:${legs.callBuy.delta}  @ ₹${legs.callBuy.premium}`);
    logger.info(`   Call Sell: ${legs.callSell.strike} delta:${legs.callSell.delta} @ ₹${legs.callSell.premium}`);
    logger.info(`   Put Buy:   ${legs.putBuy.strike}   delta:${legs.putBuy.delta}   @ ₹${legs.putBuy.premium}`);
    logger.info(`   Put Sell:  ${legs.putSell.strike}  delta:${legs.putSell.delta}  @ ₹${legs.putSell.premium}`);
    logger.info(`   Net debit: ₹${netDebit} | Combined SL: ₹${combinedSL} | Net delta: ${netDelta}`);

    return this.position;
  }

  // ── Monitor position ───────────────────
  monitorPosition(currentPremiums) {
    const pos     = this.position;
    if (pos.status === 'IDLE' || pos.status === 'CLOSED') return null;

    const alerts  = [];
    const actions = [];

    // Update leg P&Ls
    let totalPnl = 0;

    for (const legKey of pos.activeLegs) {
      const leg  = pos.legs[legKey];
      const ltp  = currentPremiums[legKey];
      if (!ltp || leg.status !== 'ACTIVE') continue;

      const isBuy = legKey === 'callBuy' || legKey === 'putBuy';
      const pnl   = isBuy
        ? (ltp - leg.entryPremium) * CONFIG.LOT_SIZE
        : (leg.entryPremium - ltp) * CONFIG.LOT_SIZE;

      leg.currentPremium = ltp;
      leg.pnl            = parseFloat(pnl.toFixed(2));
      totalPnl          += pnl;
    }

    pos.pnl = parseFloat(totalPnl.toFixed(2));

    // ── Combined SL check ──────────────────
    if (totalPnl <= -pos.combinedSL && pos.activeLegs.length > 1) {
      logger.info(`🚨 Combined 60% SL hit! P&L: ₹${totalPnl} | SL: -₹${pos.combinedSL}`);
      actions.push({ type: 'EXIT_ALL', reason: 'COMBINED_SL' });
      alerts.push({
        type:     'COMBINED_SL',
        message:  `🚨 Combined 60% SL hit! Exit ALL legs (sell first)`,
        severity: 'CRITICAL',
      });
      pos.alerts = alerts;
      return { position: pos, alerts, actions };
    }

    // ── Individual leg SL checks ──────────
    // Only check if more than 1 leg active (not last buy leg phase)
    if (pos.activeLegs.length > 1 && !pos.lastBuyLeg) {

      // Call Buy SL → exit Call Buy + Call Sell
      if (pos.legs.callBuy.status === 'ACTIVE') {
        const ltp = currentPremiums.callBuy;
        if (ltp && ltp <= pos.legs.callBuy.sl) {
          logger.info(`🔴 Call Buy SL hit @ ₹${ltp} (SL: ₹${pos.legs.callBuy.sl})`);
          actions.push({ type: 'EXIT_LEGS', legs: ['callBuy', 'callSell'], reason: 'CALL_BUY_SL' });
          alerts.push({ type: 'CALL_BUY_SL', message: `🔴 Call Buy -60% → Exit Call Buy + Call Sell`, severity: 'HIGH' });
        }
      }

      // Put Buy SL → exit Put Buy + Put Sell
      if (pos.legs.putBuy.status === 'ACTIVE') {
        const ltp = currentPremiums.putBuy;
        if (ltp && ltp <= pos.legs.putBuy.sl) {
          logger.info(`🔴 Put Buy SL hit @ ₹${ltp} (SL: ₹${pos.legs.putBuy.sl})`);
          actions.push({ type: 'EXIT_LEGS', legs: ['putBuy', 'putSell'], reason: 'PUT_BUY_SL' });
          alerts.push({ type: 'PUT_BUY_SL', message: `🔴 Put Buy -60% → Exit Put Buy + Put Sell`, severity: 'HIGH' });
        }
      }

      // Call Sell SL → exit Call Sell only
      if (pos.legs.callSell.status === 'ACTIVE') {
        const ltp = currentPremiums.callSell;
        if (ltp && ltp >= pos.legs.callSell.sl) {
          logger.info(`🔴 Call Sell SL hit @ ₹${ltp} (SL: ₹${pos.legs.callSell.sl})`);
          actions.push({ type: 'EXIT_LEGS', legs: ['callSell'], reason: 'CALL_SELL_SL' });
          alerts.push({ type: 'CALL_SELL_SL', message: `🔴 Call Sell +60% → Exit Call Sell only`, severity: 'HIGH' });
        }
      }

      // Put Sell SL → exit Put Sell only
      if (pos.legs.putSell.status === 'ACTIVE') {
        const ltp = currentPremiums.putSell;
        if (ltp && ltp >= pos.legs.putSell.sl) {
          logger.info(`🔴 Put Sell SL hit @ ₹${ltp} (SL: ₹${pos.legs.putSell.sl})`);
          actions.push({ type: 'EXIT_LEGS', legs: ['putSell'], reason: 'PUT_SELL_SL' });
          alerts.push({ type: 'PUT_SELL_SL', message: `🔴 Put Sell +60% → Exit Put Sell only`, severity: 'HIGH' });
        }
      }
    }

    // ── Last buy leg trailing ──────────────
    if (pos.lastBuyLeg) {
      const legKey = pos.lastBuyLeg;
      const leg    = pos.legs[legKey];
      const ltp    = currentPremiums[legKey];

      if (ltp && leg.status === 'ACTIVE') {
        const legPnl = (ltp - leg.entryPremium) * CONFIG.LOT_SIZE;
        pos.pnl      = parseFloat(legPnl.toFixed(2));
        leg.pnl      = pos.pnl;

        // Check trail levels
        const nextLevel = CONFIG.TRAIL_LEVELS.find(
          (l, i) => i >= pos.trailLevel && legPnl >= l.profit
        );

        if (nextLevel) {
          const levelIndex    = CONFIG.TRAIL_LEVELS.indexOf(nextLevel);
          pos.trailLevel      = levelIndex + 1;
          pos.lockedProfit    = nextLevel.lock;
          pos.trailSL         = parseFloat((leg.entryPremium + (nextLevel.lock / CONFIG.LOT_SIZE)).toFixed(2));

          logger.info(`🎯 Trail level ${levelIndex + 1}: P&L ₹${legPnl.toFixed(0)} | Locked ₹${nextLevel.lock} | Trail SL ₹${pos.trailSL}`);
          alerts.push({
            type:    'TRAIL_UPDATE',
            message: `🎯 Profit ₹${legPnl.toFixed(0)} → Locked ₹${nextLevel.lock} | Trail SL: ₹${pos.trailSL}`,
            severity: 'INFO',
          });
        }

        // Check trail SL hit
        if (pos.trailSL && ltp <= pos.trailSL) {
          logger.info(`✅ Trail SL hit @ ₹${ltp} | Locked profit: ₹${pos.lockedProfit}`);
          actions.push({ type: 'EXIT_LEGS', legs: [legKey], reason: 'TRAIL_SL_HIT' });
          alerts.push({
            type:    'TRAIL_SL_HIT',
            message: `✅ Trail SL hit! Exit ${legKey} | Locked: ₹${pos.lockedProfit}`,
            severity: 'HIGH',
          });
        }
      }
    }

    pos.alerts = alerts;
    return { position: pos, alerts, actions };
  }

  // ── Close specific legs ────────────────
  closeLegs(legKeys, reason) {
    const pos = this.position;

    for (const legKey of legKeys) {
      if (pos.legs[legKey]) {
        pos.legs[legKey].status      = 'CLOSED';
        pos.legs[legKey].closeReason = reason;
        pos.legs[legKey].closeTime   = moment().format('HH:mm');
      }
      pos.activeLegs = pos.activeLegs.filter(l => l !== legKey);
    }

    logger.info(`🔴 Legs closed: ${legKeys.join(', ')} | Reason: ${reason}`);
    logger.info(`   Remaining active legs: ${pos.activeLegs.join(', ')}`);

    // Check if only one buy leg remains
    const remainingBuys  = pos.activeLegs.filter(l => l === 'callBuy' || l === 'putBuy');
    const remainingSells = pos.activeLegs.filter(l => l === 'callSell' || l === 'putSell');

    if (remainingBuys.length === 1 && remainingSells.length === 0) {
      pos.lastBuyLeg = remainingBuys[0];
      pos.status     = 'PARTIAL';
      logger.info(`📍 Last buy leg: ${pos.lastBuyLeg} — trailing mode activated`);
    }

    return pos;
  }

  // ── Close all legs ─────────────────────
  closeAll(reason) {
    const pos = this.position;

    // Close sell legs first (margin)
    const sellLegs = pos.activeLegs.filter(l => l === 'callSell' || l === 'putSell');
    const buyLegs  = pos.activeLegs.filter(l => l === 'callBuy'  || l === 'putBuy');

    [...sellLegs, ...buyLegs].forEach(legKey => {
      pos.legs[legKey].status      = 'CLOSED';
      pos.legs[legKey].closeReason = reason;
      pos.legs[legKey].closeTime   = moment().format('HH:mm');
    });

    pos.activeLegs  = [];
    pos.status      = 'CLOSED';
    pos.closeReason = reason;
    pos.closeTime   = moment().format('YYYY-MM-DD HH:mm');

    this.tradeHistory.push({ ...pos });
    logger.info(`✅ All legs closed: ${reason} | P&L: ₹${pos.pnl}`);

    this.position = this.emptyPosition();
    return pos;
  }

  // ── Check entry time ───────────────────
  isEntryTime() {
    const day  = moment().day();
    const time = moment().format('HH:mm');
    return day === CONFIG.ENTRY_DAY && time >= CONFIG.ENTRY_TIME;
  }

  getPosition()     { return this.position; }
  getTradeHistory() { return this.tradeHistory; }
  getConfig()       { return CONFIG; }
  calculateDelta    = calculateDelta;
}

module.exports = { DeltaNeutralStrategy, calculateDelta, CONFIG };
