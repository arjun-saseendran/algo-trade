const moment = require('moment');
const logger  = require('../utils/logger');

// ─────────────────────────────────────────
// STRATEGY CONFIG — From .env
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL:          Number(process.env.CAPITAL)          || 100000,
  QTY:              Number(process.env.QTY)              || 65,
  MAX_RISK:         Number(process.env.MAX_RISK)         || 1000,
  MAX_REWARD:       Number(process.env.MAX_REWARD)       || 3000,
  MAX_RANGE_POINTS: Number(process.env.MAX_RANGE_POINTS) || 30,
  TRAIL_TRIGGER:    Number(process.env.TRAIL_TRIGGER)    || 3000,
  EXIT_TIME:        process.env.EXIT_TIME                || '15:21',
  DELTA:            0.5,
};

class ScalpingStrategy {
  constructor() {
    this.reset();
  }

  reset() {
    this.candles          = [];       // 3-min candle buffer
    this.tradeTakenToday  = false;
    this.currentTrade     = null;
    this.firstCandleDone  = false;
    this.tradeDate        = null;
    this.paperTrades      = [];
  }

  // ── Called every new day ───────────────
  newDay() {
    logger.info('📅 New trading day — strategy reset');
    this.candles         = [];
    this.tradeTakenToday = false;
    this.currentTrade    = null;
    this.firstCandleDone = false;
    this.tradeDate       = moment().format('YYYY-MM-DD');
  }

  // ── Add new 3-min candle ───────────────
  addCandle(candle) {
    const time = moment(candle.date).format('HH:mm');

    // Skip first candle (9:15 AM)
    if (time === '09:15') {
      this.firstCandleDone = true;
      logger.info(`⏭️  First candle skipped: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);
      return null;
    }

    if (!this.firstCandleDone) return null;

    // Only 1 trade per day
    if (this.tradeTakenToday) return null;

    // Hard exit time check
    if (time >= CONFIG.EXIT_TIME) return null;

    this.candles.push(candle);
    logger.info(`🕯️  Candle [${time}] O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);

    // Need at least 2 candles for setup
    if (this.candles.length < 2) return null;

    return this.checkSetup();
  }

  // ── Check setup conditions ─────────────
  checkSetup() {
    const len = this.candles.length;
    const c1  = this.candles[len - 2]; // Previous candle
    const c2  = this.candles[len - 1]; // Current candle

    const c1Green = c1.close > c1.open;
    const c2Green = c2.close > c2.open;

    // ── Rule 1: Opposite colors ──
    if (c1Green === c2Green) {
      logger.debug('Setup check: candles same color — skip');
      return null;
    }

    // ── Rule 2: Combined range < 30 points ──
    const highestHigh    = Math.max(c1.high, c2.high);
    const lowestLow      = Math.min(c1.low,  c2.low);
    const combinedRange  = highestHigh - lowestLow;

    if (combinedRange >= CONFIG.MAX_RANGE_POINTS) {
      logger.debug(`Setup check: range ${combinedRange.toFixed(2)} >= ${CONFIG.MAX_RANGE_POINTS} — skip`);
      return null;
    }

    // ── Valid setup found ──
    const setup = {
      time:         moment(c2.date).format('HH:mm'),
      c1,
      c2,
      highestHigh:  parseFloat(highestHigh.toFixed(2)),
      lowestLow:    parseFloat(lowestLow.toFixed(2)),
      combinedRange: parseFloat(combinedRange.toFixed(2)),
      slPoints:     parseFloat(combinedRange.toFixed(2)),
      targetPoints: parseFloat((combinedRange * 3).toFixed(2)),
      slRupees:     parseFloat((combinedRange * CONFIG.DELTA * CONFIG.QTY).toFixed(2)),
      targetRupees: parseFloat((combinedRange * 3 * CONFIG.DELTA * CONFIG.QTY).toFixed(2)),
    };

    logger.info(`✅ SETUP FOUND at ${setup.time}`);
    logger.info(`   Range: ${setup.combinedRange} pts | SL: ₹${setup.slRupees} | Target: ₹${setup.targetRupees}`);
    logger.info(`   Breakout CE above: ${setup.highestHigh} | PE below: ${setup.lowestLow}`);

    return setup;
  }

  // ── Check breakout on next candle ─────
  checkBreakout(currentCandle, setup) {
    if (!setup) return null;

    const time = moment(currentCandle.date).format('HH:mm');
    if (time >= CONFIG.EXIT_TIME) return null;
    if (this.tradeTakenToday) return null;

    const ceBreakout = currentCandle.high > setup.highestHigh;
    const peBreakout = currentCandle.low  < setup.lowestLow;

    // Both breakout same candle = indecision, skip
    if (ceBreakout && peBreakout) {
      logger.info('⚠️  Both sides broke out — indecision candle, skipping');
      return null;
    }

    if (!ceBreakout && !peBreakout) return null;

    const direction    = ceBreakout ? 'CE' : 'PE';
    const entryPrice   = ceBreakout ? setup.highestHigh : setup.lowestLow;
    const slPrice      = ceBreakout ? setup.lowestLow   : setup.highestHigh;
    const slPoints     = Math.abs(entryPrice - slPrice);
    const targetPoints = slPoints * 3;
    const targetPrice  = ceBreakout
      ? entryPrice + targetPoints
      : entryPrice - targetPoints;

    // Option premium SL and target
    const slPremium     = parseFloat((slPoints     * CONFIG.DELTA).toFixed(2));
    const targetPremium = parseFloat((targetPoints * CONFIG.DELTA).toFixed(2));
    const slRupees      = parseFloat((slPremium     * CONFIG.QTY).toFixed(2));
    const targetRupees  = parseFloat((targetPremium * CONFIG.QTY).toFixed(2));

    const signal = {
      direction,
      time,
      entryPrice:    parseFloat(entryPrice.toFixed(2)),
      slPrice:       parseFloat(slPrice.toFixed(2)),
      targetPrice:   parseFloat(targetPrice.toFixed(2)),
      slPoints:      parseFloat(slPoints.toFixed(2)),
      targetPoints:  parseFloat(targetPoints.toFixed(2)),
      slPremium,
      targetPremium,
      slRupees,
      targetRupees,
      qty:           CONFIG.QTY,
      setup,
    };

    logger.info(`🚀 BREAKOUT SIGNAL — ${direction}`);
    logger.info(`   Entry: ${signal.entryPrice} | SL: ${signal.slPrice} | Target: ${signal.targetPrice}`);
    logger.info(`   SL: ₹${slRupees} | Target: ₹${targetRupees}`);

    this.tradeTakenToday = true;
    return signal;
  }

  // ── Paper trade execution ──────────────
  executePaperTrade(signal, optionLTP) {
    const entryOptionPrice = optionLTP;
    const slOptionPrice    = parseFloat((entryOptionPrice - signal.slPremium).toFixed(2));
    const tgtOptionPrice   = parseFloat((entryOptionPrice + signal.targetPremium).toFixed(2));

    const trade = {
      id:               Date.now(),
      date:             this.tradeDate,
      entryTime:        signal.time,
      direction:        signal.direction,
      niftyEntry:       signal.entryPrice,
      niftySL:          signal.slPrice,
      niftyTarget:      signal.targetPrice,
      optionSymbol:     `NIFTY ATM ${signal.direction}`,
      entryOptionPrice,
      slOptionPrice,
      tgtOptionPrice,
      qty:              CONFIG.QTY,
      slRupees:         signal.slRupees,
      targetRupees:     signal.targetRupees,
      status:           'OPEN',
      paperTrade:       true,
      pnl:              0,
      trailing:         false,
      trailSLPrice:     null,
    };

    this.currentTrade = trade;
    logger.info(`📝 PAPER TRADE OPENED: ${trade.direction} @ ₹${entryOptionPrice}`);
    logger.info(`   SL: ₹${slOptionPrice} | Target: ₹${tgtOptionPrice}`);

    return trade;
  }

  // ── Monitor open trade ─────────────────
  monitorTrade(currentLTP) {
    if (!this.currentTrade || this.currentTrade.status !== 'OPEN') return null;

    const trade  = this.currentTrade;
    const pnl    = (currentLTP - trade.entryOptionPrice) * CONFIG.QTY;
    const time   = moment().format('HH:mm');

    // Update P&L
    trade.pnl = parseFloat(pnl.toFixed(2));

    // ── Hard exit at 3:21 PM ──
    if (time >= CONFIG.EXIT_TIME) {
      return this.closeTrade(currentLTP, 'TIME_EXIT');
    }

    // ── Trailing SL logic ──
    if (pnl >= CONFIG.TRAIL_TRIGGER && !trade.trailing) {
      trade.trailing    = true;
      trade.trailSLPrice = parseFloat((trade.entryOptionPrice + trade.slPremium).toFixed(2));
      logger.info(`🎯 TRAIL ACTIVATED — locking ₹${CONFIG.TRAIL_TRIGGER} profit`);
      logger.info(`   Trail SL moved to: ₹${trade.trailSLPrice}`);
      return { type: 'TRAIL_ACTIVATED', trade };
    }

    // ── Check SL hit ──
    const slPrice = trade.trailing ? trade.trailSLPrice : trade.slOptionPrice;
    if (currentLTP <= slPrice) {
      const exitPrice = slPrice;
      return this.closeTrade(exitPrice, trade.trailing ? 'TRAIL_SL_HIT' : 'SL_HIT');
    }

    // ── Check Target hit ──
    if (currentLTP >= trade.tgtOptionPrice) {
      return this.closeTrade(trade.tgtOptionPrice, 'TARGET_HIT');
    }

    return { type: 'UPDATE', trade };
  }

  // ── Close trade ───────────────────────
  closeTrade(exitPrice, reason) {
    const trade  = this.currentTrade;
    const pnl    = parseFloat(((exitPrice - trade.entryOptionPrice) * CONFIG.QTY).toFixed(2));

    trade.exitTime   = moment().format('HH:mm');
    trade.exitPrice  = exitPrice;
    trade.pnl        = pnl;
    trade.status     = 'CLOSED';
    trade.closeReason = reason;

    this.paperTrades.push({ ...trade });

    const emoji = pnl >= 0 ? '✅' : '❌';
    logger.info(`${emoji} TRADE CLOSED — ${reason}`);
    logger.info(`   Exit: ₹${exitPrice} | P&L: ₹${pnl}`);

    this.currentTrade = null;
    return { type: 'TRADE_CLOSED', trade, pnl, reason };
  }

  // ── Force exit all ─────────────────────
  forceExit(currentLTP) {
    if (!this.currentTrade || this.currentTrade.status !== 'OPEN') return null;
    return this.closeTrade(currentLTP, 'MANUAL_EXIT');
  }

  getConfig()       { return CONFIG; }
  getCurrentTrade() { return this.currentTrade; }
  getPaperTrades()  { return this.paperTrades; }
  hasTradedToday()  { return this.tradeTakenToday; }
}

module.exports = ScalpingStrategy;
