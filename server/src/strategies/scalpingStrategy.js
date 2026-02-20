const moment = require('moment');
const logger  = require('../utils/logger');

// ─────────────────────────────────────────
// STRATEGY CONFIG — From .env
// ─────────────────────────────────────────
const CONFIG = {
  CAPITAL:          Number(process.env.CAPITAL)          || 100000,
  QTY:              Number(process.env.QTY)              || 65,
  MAX_RANGE_POINTS: Number(process.env.MAX_RANGE_POINTS) || 30,
  DELTA:            0.5,

  // 1% loss = ₹1,000 (stop loss in rupees)
  SL_PERCENT:       0.01,   // 1%
  SL_RUPEES:        Number(process.env.MAX_RISK) || 1000,

  // 3% profit = ₹3,000 (trail trigger)
  TRAIL_PERCENT:    0.03,   // 3%
  TRAIL_RUPEES:     Number(process.env.TRAIL_TRIGGER) || 3000,

  EXIT_TIME:        process.env.EXIT_TIME || '15:21',
};

class ScalpingStrategy {
  constructor() {
    this.reset();
  }

  reset() {
    this.candles         = [];
    this.tradeTakenToday = false;
    this.currentTrade    = null;
    this.firstCandleDone = false;
    this.tradeDate       = null;
    this.paperTrades     = [];
  }

  // ── New day reset ──────────────────────
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

    // Rule 2: Ignore first 3-min candle (9:15 AM)
    if (time === '09:15') {
      this.firstCandleDone = true;
      logger.info(`⏭️  First candle ignored: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);
      return null;
    }

    if (!this.firstCandleDone) return null;

    // Rule 9: Only 1 trade per day
    if (this.tradeTakenToday) return null;

    // Rule 14: No new trades after exit time
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

    const c1Green = c1.close > c1.open; // true = green, false = red
    const c2Green = c2.close > c2.open;

    // Rule 3: Two consecutive candles must be opposite colors
    if (c1Green === c2Green) {
      logger.debug('Setup check: same color candles — skip');
      return null;
    }

    // Rule 4 & 5 & 6: Combined range < 30 points
    // Highest high of both = HIGH level
    // Lowest low of both   = LOW level
    const highestHigh   = Math.max(c1.high, c2.high);
    const lowestLow     = Math.min(c1.low,  c2.low);
    const combinedRange = highestHigh - lowestLow;

    if (combinedRange > CONFIG.MAX_RANGE_POINTS) {
      logger.debug(`Setup check: range ${combinedRange.toFixed(2)} > ${CONFIG.MAX_RANGE_POINTS} — skip`);
      return null;
    }

    // ── Valid setup found ──
    const slPoints     = combinedRange;
    const targetPoints = combinedRange * 3;
    const slPremium    = parseFloat((slPoints     * CONFIG.DELTA).toFixed(2));
    const tgtPremium   = parseFloat((targetPoints * CONFIG.DELTA).toFixed(2));
    const slRupees     = parseFloat((slPremium    * CONFIG.QTY).toFixed(2));
    const tgtRupees    = parseFloat((tgtPremium   * CONFIG.QTY).toFixed(2));

    const setup = {
      time:          moment(c2.date).format('HH:mm'),
      c1,
      c2,
      highestHigh:   parseFloat(highestHigh.toFixed(2)),   // HIGH level → CE entry
      lowestLow:     parseFloat(lowestLow.toFixed(2)),     // LOW level  → PE entry
      combinedRange: parseFloat(combinedRange.toFixed(2)),
      slPoints:      parseFloat(slPoints.toFixed(2)),
      targetPoints:  parseFloat(targetPoints.toFixed(2)),
      slPremium,
      tgtPremium,
      slRupees,
      tgtRupees,
    };

    logger.info(`✅ SETUP FOUND at ${setup.time}`);
    logger.info(`   C1: ${c1Green ? '🟢' : '🔴'} C2: ${c2Green ? '🟢' : '🔴'}`);
    logger.info(`   HIGH: ${setup.highestHigh} | LOW: ${setup.lowestLow} | Range: ${setup.combinedRange} pts`);
    logger.info(`   CE entry above: ${setup.highestHigh} | PE entry below: ${setup.lowestLow}`);
    logger.info(`   SL: ₹${slRupees} | Target: ₹${tgtRupees}`);

    return setup;
  }

  // ── Check breakout on next candle ──────
  // Rule 7, 8, 9: Whichever breaks first → take that trade
  checkBreakout(currentCandle, setup) {
    if (!setup) return null;

    const time = moment(currentCandle.date).format('HH:mm');
    if (time >= CONFIG.EXIT_TIME) return null;
    if (this.tradeTakenToday) return null;

    const ceBreakout = currentCandle.high > setup.highestHigh;
    const peBreakout = currentCandle.low  < setup.lowestLow;

    if (!ceBreakout && !peBreakout) return null;

    // Rule 9: Whichever breaks first based on open price proximity
    // Since OHLC doesn't tell us tick order, use open to determine direction
    let direction;

    if (ceBreakout && peBreakout) {
      // Both broke — use open price to determine which broke first
      const distanceToCE = Math.abs(currentCandle.open - setup.highestHigh);
      const distanceToPE = Math.abs(currentCandle.open - setup.lowestLow);
      direction = distanceToCE <= distanceToPE ? 'CE' : 'PE';
      logger.info(`⚠️  Both levels broke — open closer to ${direction} side, taking ${direction}`);
    } else {
      direction = ceBreakout ? 'CE' : 'PE';
    }

    // Rule 7 & 8: Entry and SL levels
    // CE: entry = HIGH level, SL = LOW level
    // PE: entry = LOW level,  SL = HIGH level
    const entryNifty  = direction === 'CE' ? setup.highestHigh : setup.lowestLow;
    const slNifty     = direction === 'CE' ? setup.lowestLow   : setup.highestHigh;
    const slPoints    = Math.abs(entryNifty - slNifty);
    const tgtPoints   = slPoints * 3;
    const targetNifty = direction === 'CE'
      ? entryNifty + tgtPoints
      : entryNifty - tgtPoints;

    // Convert to option premium using delta
    const slPremium  = parseFloat((slPoints  * CONFIG.DELTA).toFixed(2));
    const tgtPremium = parseFloat((tgtPoints * CONFIG.DELTA).toFixed(2));
    const slRupees   = parseFloat((slPremium  * CONFIG.QTY).toFixed(2));
    const tgtRupees  = parseFloat((tgtPremium * CONFIG.QTY).toFixed(2));

    const signal = {
      direction,
      time,
      entryNifty:  parseFloat(entryNifty.toFixed(2)),
      slNifty:     parseFloat(slNifty.toFixed(2)),
      targetNifty: parseFloat(targetNifty.toFixed(2)),
      slPoints:    parseFloat(slPoints.toFixed(2)),
      tgtPoints:   parseFloat(tgtPoints.toFixed(2)),
      slPremium,
      tgtPremium,
      slRupees,
      tgtRupees,
      qty:         CONFIG.QTY,
      setup,
    };

    logger.info(`🚀 BREAKOUT — ${direction}`);
    logger.info(`   NIFTY Entry: ${signal.entryNifty} | SL: ${signal.slNifty} | Target: ${signal.targetNifty}`);
    logger.info(`   Option SL: ₹${slRupees} | Option Target: ₹${tgtRupees}`);

    this.tradeTakenToday = true;
    return signal;
  }

  // ── Paper trade execution ──────────────
  executePaperTrade(signal, optionLTP) {
    const entryOptionPrice = optionLTP;

    // Rule 10 & 11: SL = candle level OR 1% premium loss whichever hits first
    const candleSLPrice   = parseFloat((entryOptionPrice - signal.slPremium).toFixed(2));
    const percentSLPrice  = parseFloat((entryOptionPrice * (1 - CONFIG.SL_PERCENT)).toFixed(2));
    const percentSLRupees = parseFloat((entryOptionPrice * CONFIG.SL_PERCENT * CONFIG.QTY).toFixed(2));

    // Use whichever SL is higher (closer to entry = tighter = hits first)
    const slOptionPrice   = Math.max(candleSLPrice, percentSLPrice);
    const tgtOptionPrice  = parseFloat((entryOptionPrice + signal.tgtPremium).toFixed(2));

    const trade = {
      id:                Date.now(),
      date:              this.tradeDate,
      entryTime:         signal.time,
      direction:         signal.direction,
      niftyEntry:        signal.entryNifty,
      niftySL:           signal.slNifty,
      niftyTarget:       signal.targetNifty,
      optionSymbol:      `NIFTY ATM ${signal.direction}`,
      entryOptionPrice,
      slOptionPrice,
      candleSLPrice,
      percentSLPrice,
      tgtOptionPrice,
      qty:               CONFIG.QTY,
      slRupees:          signal.slRupees,
      targetRupees:      signal.tgtRupees,
      status:            'OPEN',
      paperTrade:        true,
      pnl:               0,
      trailing:          false,
      trailSLPrice:      null,
    };

    this.currentTrade = trade;

    logger.info(`📝 PAPER TRADE OPENED: ${trade.direction} @ ₹${entryOptionPrice}`);
    logger.info(`   Candle SL: ₹${candleSLPrice} | 1% SL: ₹${percentSLPrice}`);
    logger.info(`   Active SL: ₹${slOptionPrice} (whichever is tighter)`);
    logger.info(`   Target: ₹${tgtOptionPrice}`);

    return trade;
  }

  // ── Monitor open trade ─────────────────
  monitorTrade(currentLTP) {
    if (!this.currentTrade || this.currentTrade.status !== 'OPEN') return null;

    const trade = this.currentTrade;
    const pnl   = (currentLTP - trade.entryOptionPrice) * CONFIG.QTY;
    const time  = moment().format('HH:mm');

    // Update live P&L
    trade.pnl = parseFloat(pnl.toFixed(2));

    // Rule 14: Hard exit at 3:21 PM
    if (time >= CONFIG.EXIT_TIME) {
      return this.closeTrade(currentLTP, 'TIME_EXIT');
    }

    // Rule 13: Trail SL when profit >= 3% (₹3,000)
    // Lock in 3% profit — trail SL moves to entry + target premium
    if (pnl >= CONFIG.TRAIL_RUPEES && !trade.trailing) {
      trade.trailing     = true;
      // Trail SL = entry + target premium → locks ₹3,000 profit
      trade.trailSLPrice = parseFloat((trade.entryOptionPrice + trade.tgtOptionPrice - trade.entryOptionPrice).toFixed(2));
      // Simpler: trail SL = tgtOptionPrice (lock full 3%)
      trade.trailSLPrice = trade.tgtOptionPrice;

      logger.info(`🎯 TRAIL ACTIVATED — ₹3,000 profit locked!`);
      logger.info(`   Trail SL set to: ₹${trade.trailSLPrice}`);
      return { type: 'TRAIL_ACTIVATED', trade };
    }

    // Check which SL to use
    const activeSL = trade.trailing ? trade.trailSLPrice : trade.slOptionPrice;

    // Rule 10/11/12: Exit if SL hit (candle level OR 1% — whichever hits first)
    if (currentLTP <= activeSL) {
      return this.closeTrade(activeSL, trade.trailing ? 'TRAIL_SL_HIT' : 'SL_HIT');
    }

    // Target hit — close at target
    if (currentLTP >= trade.tgtOptionPrice && !trade.trailing) {
      return this.closeTrade(trade.tgtOptionPrice, 'TARGET_HIT');
    }

    return { type: 'UPDATE', trade };
  }

  // ── Close trade ────────────────────────
  closeTrade(exitPrice, reason) {
    const trade = this.currentTrade;
    const pnl   = parseFloat(((exitPrice - trade.entryOptionPrice) * CONFIG.QTY).toFixed(2));

    trade.exitTime    = moment().format('HH:mm');
    trade.exitPrice   = exitPrice;
    trade.pnl         = pnl;
    trade.status      = 'CLOSED';
    trade.closeReason = reason;

    this.paperTrades.push({ ...trade });

    const emoji = pnl >= 0 ? '✅' : '❌';
    logger.info(`${emoji} TRADE CLOSED — ${reason}`);
    logger.info(`   Exit: ₹${exitPrice} | P&L: ₹${pnl}`);

    this.currentTrade = null;
    return { type: 'TRADE_CLOSED', trade, pnl, reason };
  }

  // ── Force / Manual exit ────────────────
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