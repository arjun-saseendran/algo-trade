const cron        = require('node-cron');
const moment      = require('moment');
const kiteService = require('./kiteService');
const Trade       = require('../models/Trades');
const logger      = require('../utils/logger');

class AtmScalpingEngine {
  constructor(io) {
    this.io       = io;
    this.running  = false;
    this.positions = { NIFTY: { status: 'IDLE' } };
    this.history  = [];
    this.setupCron();
  }

  setupCron() {
    // Every 3 minutes during market hours
    cron.schedule('*/3 9-15 * * 1-5', async () => {
      if (this.running) await this.executeStrategy();
    });

    // Hard exit at 3:21 PM
    cron.schedule('21 15 * * 1-5', async () => {
      if (this.running) await this.closeAll('TIME_EXIT');
    });
  }

  async executeStrategy() {
    if (this.positions.NIFTY.status !== 'IDLE') return;

    try {
      // FIX 1: Pass proper from/to dates — kiteService requires explicit date range
      const from = moment().startOf('day').set({ hour: 9, minute: 15 }).toDate();
      const to   = new Date();
      const candles = await kiteService.getHistoricalData(256265, '3minute', from, to);

      if (!candles || candles.length < 3) return;

      const c1 = candles[candles.length - 2];
      const c2 = candles[candles.length - 1];

      // Skip 9:15 AM candle
      const c1Time = new Date(c1.date);
      if (c1Time.getHours() === 9 && c1Time.getMinutes() === 15) return;

      // Setup: opposite colour candles + combined range < 30 pts
      const isOpposite = (c1.close > c1.open) !== (c2.close > c2.open);
      const high = Math.max(c1.high, c2.high);
      const low  = Math.min(c1.low,  c2.low);
      const range = high - low;

      const MAX_RANGE = parseInt(process.env.MAX_RANGE_POINTS) || 30;

      if (isOpposite && range < MAX_RANGE) {
        // FIX 4: Emit setup_found to frontend
        const setup = { combinedRange: range.toFixed(2), highestHigh: high, lowestLow: low };
        this.io.emit('setup_found', { message: `Setup: Range ${range.toFixed(1)} pts`, setup });
        logger.info(`✅ Setup found: Range=${range.toFixed(1)}, High=${high}, Low=${low}`);

        const quotes = await kiteService.getLTP(['NSE:NIFTY 50']);
        const ltp    = quotes['NSE:NIFTY 50']?.last_price;
        if (!ltp) return;

        if      (ltp > high) await this.openPosition('CE', ltp, high, low);
        else if (ltp < low)  await this.openPosition('PE', ltp, high, low);
        else logger.info(`LTP ${ltp} inside range [${low}–${high}], waiting for breakout`);
      }
    } catch (err) {
      logger.error(`Scalping executeStrategy error: ${err.message}`);
    }
  }

  async openPosition(direction, ltp, high, low) {
    const qty    = parseInt(process.env.QTY)      || 65;
    const maxRisk  = parseInt(process.env.MAX_RISK)  || 1000;
    const maxReward = parseInt(process.env.MAX_REWARD) || 3000;

    const slPts  = direction === 'CE' ? (ltp - low)  : (high - ltp);
    const tgtPts = slPts * 3;

    this.positions.NIFTY = {
      status:        'ACTIVE',
      direction,
      entryPrice:    ltp,
      slPrice:       direction === 'CE' ? low  : high,
      tgtPrice:      direction === 'CE' ? ltp + tgtPts : ltp - tgtPts,
      entryTime:     new Date().toLocaleTimeString('en-IN'),
      date:          new Date().toLocaleDateString('en-IN'),
      qty,
      trailing:      false,
      pnl:           0,
    };

    logger.info(`📈 Trade opened: ${direction} @ ${ltp} | SL=${this.positions.NIFTY.slPrice} | Tgt=${this.positions.NIFTY.tgtPrice}`);

    // FIX 4: Emit trade_opened to frontend
    this.io.emit('trade_opened', {
      message: `${direction} entered @ ₹${ltp}`,
      trade: this.positions.NIFTY
    });

    // Save to MongoDB (paper trade)
    try {
      await Trade.create({
        strategy:    'atmscalping',
        index:       'NIFTY',
        direction,
        entryPrice:  ltp,
        status:      'ACTIVE',
        isPaperTrade: true,
        entryDate:   new Date(),
      });
    } catch (err) {
      logger.error(`Trade save error: ${err.message}`);
    }

    this.emitStatus();
  }

  async closeAll(reason, exitPrice = null) {
    if (this.positions.NIFTY.status === 'IDLE') return;

    const pos = this.positions.NIFTY;
    const pnl = exitPrice
      ? (pos.direction === 'CE' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) * pos.qty
      : 0;

    const closed = {
      ...pos,
      status:      'CLOSED',
      closeReason: reason,
      exitTime:    new Date().toLocaleTimeString('en-IN'),
      exitPrice:   exitPrice || pos.entryPrice,
      pnl,
    };

    this.history.push(closed);
    this.positions.NIFTY = { status: 'IDLE' };

    logger.info(`Trade closed: ${reason} | P&L: ₹${pnl.toFixed(0)}`);

    // Emit trade_closed so frontend updates
    this.io.emit('trade_closed', {
      message: `${reason} | P&L: ₹${pnl.toFixed(0)}`,
      trade:   closed,
      pnl,
    });

    this.emitStatus();
  }

  getStatus() {
    return {
      running:      this.running,
      paperTrade:   process.env.PAPER_TRADE === 'true',
      positions:    this.positions,
      history:      this.history,
      currentTrade: this.positions.NIFTY.status === 'ACTIVE' ? this.positions.NIFTY : null,
      currentSetup: null,
      niftyLTP:     0,
      paperTrades:  this.history,
    };
  }

  start() {
    this.running = true;
    logger.info('ATM Scalping engine started ▶️');
    // FIX 2: emit 'engine_status' — matches what SocketContext listens to
    this.io.emit('engine_status', { running: true });
    this.emitStatus();
  }

  stop() {
    this.running = false;
    logger.info('ATM Scalping engine stopped ⏹️');
    // FIX 2: emit 'engine_status'
    this.io.emit('engine_status', { running: false });
    this.emitStatus();
  }

  // FIX 2: changed event name from 'scalping_status' → 'engine_status'
  emitStatus() {
    this.io.emit('engine_status', { running: this.running });
    this.io.emit('status', this.getStatus());
  }
}

module.exports = AtmScalpingEngine;
