const moment = require('moment');
const logger  = require('../utils/logger');

// ─────────────────────────────────────────
// IRON CONDOR CONFIG
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL: Number(process.env.CAPITAL) || 100000,

  NIFTY: {
    SYMBOL:          'NIFTY',
    EXCHANGE:        'NFO',
    STRIKE_INTERVAL: 50,
    SPREAD_WIDTH:    150,       // points between sell and buy strike
    ONE_PERCENT:     12,        // ₹12 premium = 1% for NIFTY
    ENTRY_DAY:       1,         // Monday (0=Sun, 1=Mon)
    ENTRY_TIME:      '09:30',
    EXPIRY_DAY:      2,         // Tuesday
  },

  SENSEX: {
    SYMBOL:          'SENSEX',
    EXCHANGE:        'BFO',
    STRIKE_INTERVAL: 100,
    SPREAD_WIDTH:    500,       // points between sell and buy strike
    ONE_PERCENT:     38,        // ₹38 premium = 1% for SENSEX
    ENTRY_DAY:       3,         // Wednesday
    ENTRY_TIME:      '09:30',
    EXPIRY_DAY:      4,         // Thursday
  },

  MAX_LOSS_PERCENT:      6,     // 6% max loss — never exit on this
  ADJUSTMENT_3X:         3,     // 3x premium = adjustment trigger
  ADJUSTMENT_4X:         4,     // 4x premium = exit spread trigger
  DECAY_TRIGGER:         0.70,  // 70% decay on other side
  DISCRETIONARY_DECAY:   0.80,  // 80% decay for discretionary roll
  MAX_SYSTEM_ROLLS:      1,
  MAX_DISCRETIONARY:     1,
  IRON_FLY_EXIT_PERCENT: 2,     // Exit iron butterfly at 2% loss
};

class IronCondorStrategy {
  constructor() {
    this.positions = {
      NIFTY:  this.emptyPosition('NIFTY'),
      SENSEX: this.emptyPosition('SENSEX'),
    };
    this.tradeHistory = [];
  }

  emptyPosition(index) {
    return {
      index,
      status:           'IDLE',   // IDLE | PARTIAL | ACTIVE | ADJUSTING | CLOSED
      entryDate:        null,
      expiryDate:       null,
      callSpread:       null,     // { sellStrike, buyStrike, sellPremium, buyPremium, netCredit }
      putSpread:        null,
      totalCredit:      0,        // total premium collected
      currentMTM:       0,
      pnl:              0,
      systemRolls:      0,
      discretionaryRolls: 0,
      isIronFly:        false,
      adjustments:      [],
      alerts:           [],
    };
  }

  // ── Check if today is entry day ────────
  isEntryDay(index) {
    const cfg     = CONFIG[index];
    const today   = moment().day();
    const time    = moment().format('HH:mm');
    return today === cfg.ENTRY_DAY && time >= cfg.ENTRY_TIME;
  }

  // ── Calculate OTM strike ───────────────
  calculateStrikes(spotPrice, index) {
    const cfg         = CONFIG[index];
    const interval    = cfg.STRIKE_INTERVAL;

    // Sell strike = 0.5% OTM from spot
    const callSellStrike = Math.ceil((spotPrice * 1.005) / interval) * interval;
    const putSellStrike  = Math.floor((spotPrice * 0.995) / interval) * interval;

    // Buy strike = sell strike + spread width
    const callBuyStrike  = callSellStrike + cfg.SPREAD_WIDTH;
    const putBuyStrike   = putSellStrike  - cfg.SPREAD_WIDTH;

    return {
      call: { sellStrike: callSellStrike, buyStrike: callBuyStrike },
      put:  { sellStrike: putSellStrike,  buyStrike: putBuyStrike  },
    };
  }

  // ── Build position legs ────────────────
  buildLegs(strikes, premiums, index) {
    return {
      call: {
        sellStrike:   strikes.call.sellStrike,
        buyStrike:    strikes.call.buyStrike,
        sellPremium:  premiums.callSell,
        buyPremium:   premiums.callBuy,
        netCredit:    parseFloat((premiums.callSell - premiums.callBuy).toFixed(2)),
        currentMTM:   0,
        status:       'ACTIVE',
      },
      put: {
        sellStrike:   strikes.put.sellStrike,
        buyStrike:    strikes.put.buyStrike,
        sellPremium:  premiums.putSell,
        buyPremium:   premiums.putBuy,
        netCredit:    parseFloat((premiums.putSell - premiums.putBuy).toFixed(2)),
        currentMTM:   0,
        status:       'ACTIVE',
      },
    };
  }

  // ── Open position ──────────────────────
  // NIFTY:  combined net target ≈ ₹12 (e.g. call ₹7 + put ₹5, or ₹6+₹6)
  // SENSEX: combined net target ≈ ₹38 (e.g. call ₹20 + put ₹18, or ₹19+₹19)
  // Per-side balance varies with market — only combined total matters
  openPosition(index, spotPrice, premiums, expiryDate) {
    const cfg     = CONFIG[index];
    const strikes = this.calculateStrikes(spotPrice, index);
    const legs    = this.buildLegs(strikes, premiums, index);

    const callNetCredit = parseFloat((premiums.callSell - premiums.callBuy).toFixed(2));
    const putNetCredit  = parseFloat((premiums.putSell  - premiums.putBuy).toFixed(2));
    const totalCredit   = parseFloat((callNetCredit + putNetCredit).toFixed(2));

    // Target: NIFTY ≈ ₹12 | SENSEX ≈ ₹38
    // Allow entry if combined credit is at least 80% of target
    const targetCredit = cfg.ONE_PERCENT * 2;
    const creditOk     = totalCredit >= (targetCredit * 0.8);
    if (!creditOk) {
      logger.warn(`${index} combined credit ₹${totalCredit} below target ₹${targetCredit} — skipping entry`);
      return null;
    }

    const maxLoss    = parseFloat((cfg.SPREAD_WIDTH - totalCredit).toFixed(2));
    const maxLossPct = parseFloat((maxLoss / CONFIG.CAPITAL * 100).toFixed(2));

    this.positions[index] = {
      ...this.emptyPosition(index),
      status:      'ACTIVE',
      entryDate:   moment().format('YYYY-MM-DD HH:mm'),
      expiryDate,
      spotAtEntry: spotPrice,
      callSpread:  legs.call,
      putSpread:   legs.put,
      totalCredit,
      maxLoss,
      maxLossPct,
      currentMTM:  0,
      pnl:         0,
    };

    logger.info(`✅ IRON CONDOR OPENED — ${index}`);
    logger.info(`   Spot: ${spotPrice}`);
    logger.info(`   Call: Sell ${legs.call.sellStrike} / Buy ${legs.call.buyStrike} @ ₹${legs.call.netCredit}`);
    logger.info(`   Put:  Sell ${legs.put.sellStrike}  / Buy ${legs.put.buyStrike}  @ ₹${legs.put.netCredit}`);
    logger.info(`   Total credit: ₹${totalCredit} | Max loss: ₹${maxLoss} (${maxLossPct}%)`);

    return this.positions[index];
  }

  // ── Update MTM ─────────────────────────
  updateMTM(index, callCurrentPremium, putCurrentPremium) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE' || pos.status === 'CLOSED') return null;

    // MTM = credit collected - current premium to close
    const callMTM = pos.callSpread.netCredit - callCurrentPremium;
    const putMTM  = pos.putSpread.netCredit  - putCurrentPremium;
    const totalMTM = parseFloat((callMTM + putMTM).toFixed(2));

    pos.callSpread.currentMTM   = parseFloat(callMTM.toFixed(2));
    pos.putSpread.currentMTM    = parseFloat(putMTM.toFixed(2));
    pos.currentMTM              = totalMTM;
    pos.pnl                     = totalMTM;

    // Calculate decay percentages
    const callDecay = parseFloat(((pos.callSpread.sellPremium - callCurrentPremium) / pos.callSpread.sellPremium).toFixed(2));
    const putDecay  = parseFloat(((pos.putSpread.sellPremium  - putCurrentPremium)  / pos.putSpread.sellPremium).toFixed(2));

    // Calculate expansion (how much over sell premium)
    const callExpansion = parseFloat((callCurrentPremium / pos.callSpread.sellPremium).toFixed(2));
    const putExpansion  = parseFloat((putCurrentPremium  / pos.putSpread.sellPremium).toFixed(2));

    pos.callSpread.currentPremium = callCurrentPremium;
    pos.putSpread.currentPremium  = putCurrentPremium;
    pos.callSpread.decay          = callDecay;
    pos.putSpread.decay           = putDecay;
    pos.callSpread.expansion      = callExpansion;
    pos.putSpread.expansion       = putExpansion;

    // Check adjustment triggers
    const alerts = this.checkAdjustmentTriggers(index, callExpansion, putExpansion, callDecay, putDecay);

    return { position: pos, alerts };
  }

  // ── Check adjustment triggers ──────────
  checkAdjustmentTriggers(index, callExpansion, putExpansion, callDecay, putDecay) {
    const pos    = this.positions[index];
    const alerts = [];

    // System adjustment: one side 3x AND other side 70% decayed
    if (callExpansion >= CONFIG.ADJUSTMENT_3X && putDecay >= CONFIG.DECAY_TRIGGER) {
      if (pos.systemRolls < CONFIG.MAX_SYSTEM_ROLLS) {
        alerts.push({
          type:     'SYSTEM_ADJUSTMENT',
          side:     'CALL',
          message:  `🔔 CALL hit 3x (${callExpansion}x) + PUT decayed ${(putDecay*100).toFixed(0)}% → Close PUT, roll new 0.5% PUT`,
          severity: 'HIGH',
        });
      }
    }

    if (putExpansion >= CONFIG.ADJUSTMENT_3X && callDecay >= CONFIG.DECAY_TRIGGER) {
      if (pos.systemRolls < CONFIG.MAX_SYSTEM_ROLLS) {
        alerts.push({
          type:     'SYSTEM_ADJUSTMENT',
          side:     'PUT',
          message:  `🔔 PUT hit 3x (${putExpansion}x) + CALL decayed ${(callDecay*100).toFixed(0)}% → Close CALL, roll new 0.5% CALL`,
          severity: 'HIGH',
        });
      }
    }

    // 4x trigger — exit that spread
    if (callExpansion >= CONFIG.ADJUSTMENT_4X) {
      alerts.push({
        type:     'EXIT_SPREAD',
        side:     'CALL',
        message:  `🚨 CALL hit 4x (${callExpansion}x) → Exit CALL spread now!`,
        severity: 'CRITICAL',
      });
    }

    if (putExpansion >= CONFIG.ADJUSTMENT_4X) {
      alerts.push({
        type:     'EXIT_SPREAD',
        side:     'PUT',
        message:  `🚨 PUT hit 4x (${putExpansion}x) → Exit PUT spread now!`,
        severity: 'CRITICAL',
      });
    }

    // Discretionary roll — 80% decay on expiry day
    const isExpiryDay = this.isExpiryDay(index);
    if (isExpiryDay) {
      if (callDecay >= CONFIG.DISCRETIONARY_DECAY && pos.discretionaryRolls < CONFIG.MAX_DISCRETIONARY) {
        alerts.push({
          type:     'DISCRETIONARY_ROLL',
          side:     'CALL',
          message:  `💡 CALL decayed ${(callDecay*100).toFixed(0)}% on expiry day → Check MACD+EMA+OI for discretionary roll`,
          severity: 'INFO',
        });
      }
      if (putDecay >= CONFIG.DISCRETIONARY_DECAY && pos.discretionaryRolls < CONFIG.MAX_DISCRETIONARY) {
        alerts.push({
          type:     'DISCRETIONARY_ROLL',
          side:     'PUT',
          message:  `💡 PUT decayed ${(putDecay*100).toFixed(0)}% on expiry day → Check MACD+EMA+OI for discretionary roll`,
          severity: 'INFO',
        });
      }
    }

    // Store alerts on position
    pos.alerts = alerts;
    return alerts;
  }

  // ── Check if expiry day ────────────────
  isExpiryDay(index) {
    const cfg   = CONFIG[index];
    const today = moment().day();
    return today === cfg.EXPIRY_DAY;
  }

  // ── Record system roll ─────────────────
  recordSystemRoll(index, side) {
    const pos = this.positions[index];
    pos.systemRolls++;
    pos.adjustments.push({
      time:  moment().format('HH:mm'),
      type:  'SYSTEM_ROLL',
      side,
    });
    logger.info(`📝 System roll recorded: ${index} ${side} (${pos.systemRolls}/${CONFIG.MAX_SYSTEM_ROLLS})`);
  }

  // ── Record discretionary roll ──────────
  recordDiscretionaryRoll(index, side) {
    const pos = this.positions[index];
    pos.discretionaryRolls++;
    pos.adjustments.push({
      time:  moment().format('HH:mm'),
      type:  'DISCRETIONARY_ROLL',
      side,
    });
    logger.info(`📝 Discretionary roll recorded: ${index} ${side}`);
  }

  // ── Convert to Iron Butterfly ──────────
  convertToIronFly(index) {
    const pos    = this.positions[index];
    pos.isIronFly = true;
    pos.status    = 'ADJUSTING';
    pos.adjustments.push({
      time: moment().format('HH:mm'),
      type: 'IRON_FLY_CONVERSION',
    });
    logger.info(`🦋 Converted to Iron Butterfly: ${index}`);
  }

  // ── Close position ─────────────────────
  closePosition(index, reason, finalPnl) {
    const pos         = this.positions[index];
    pos.status        = 'CLOSED';
    pos.closeReason   = reason;
    pos.pnl           = finalPnl;
    pos.closeTime     = moment().format('YYYY-MM-DD HH:mm');

    this.tradeHistory.push({ ...pos });
    logger.info(`${finalPnl >= 0 ? '✅' : '❌'} Iron Condor closed: ${index} | ${reason} | P&L: ₹${finalPnl}`);

    this.positions[index] = this.emptyPosition(index);
    return pos;
  }

  getPosition(index)    { return this.positions[index]; }
  getAllPositions()      { return this.positions; }
  getTradeHistory()     { return this.tradeHistory; }
  getConfig()           { return CONFIG; }
}

module.exports = IronCondorStrategy;