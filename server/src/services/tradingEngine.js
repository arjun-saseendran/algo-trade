const cron             = require('node-cron');
const moment           = require('moment');
const kiteService      = require('./kiteService');
const ScalpingStrategy = require('../strategies/scalpingStrategy');
const logger           = require('../utils/logger');

// NIFTY instrument token (constant)
const NIFTY_TOKEN      = 256265;
const NIFTY_SYMBOL     = 'NSE:NIFTY 50';
const PAPER_TRADE      = process.env.PAPER_TRADE === 'true';
const CANDLE_INTERVAL  = '3minute';

class TradingEngine {
  constructor(io) {
    this.io           = io;
    this.strategy     = new ScalpingStrategy();
    this.running      = false;
    this.currentSetup = null;
    this.lastCandle   = null;
    this.niftyLTP     = 0;
    this.candleBuffer = [];
    this.jobs         = [];

    logger.info(`🤖 Trading Engine initialized`);
    logger.info(`   Mode: ${PAPER_TRADE ? '📝 PAPER TRADE' : '💰 LIVE TRADE'}`);

    this.setupCronJobs();
  }

  // ── Cron Jobs ────────────────────────
  setupCronJobs() {
    // New day reset at 9:00 AM
    const resetJob = cron.schedule('0 9 * * 1-5', () => {
      logger.info('🌅 Market day starting — resetting strategy');
      this.strategy.newDay();
      this.currentSetup = null;
      this.candleBuffer = [];
      this.emit('strategy_reset', { time: moment().format('HH:mm:ss') });
    });

    // Fetch candles every 3 minutes during market hours
    const candleJob = cron.schedule('*/3 9-15 * * 1-5', async () => {
      if (!kiteService.isConnected()) return;
      await this.fetchLatestCandle();
    });

    // Monitor open trade every 10 seconds
    const monitorJob = cron.schedule('*/10 9-15 * * 1-5', async () => {
      if (!kiteService.isConnected()) return;
      if (!this.strategy.getCurrentTrade()) return;
      await this.monitorOpenTrade();
    });

    // Force exit at 3:21 PM
    const exitJob = cron.schedule('21 15 * * 1-5', async () => {
      logger.info('⏰ 3:21 PM — Force exit time');
      await this.forceExitAll();
    });

    this.jobs = [resetJob, candleJob, monitorJob, exitJob];
    logger.info('✅ Cron jobs scheduled');
  }

  // ── Fetch Latest 3-min Candle ─────────
  async fetchLatestCandle() {
    try {
      const now  = moment();
      const from = moment().subtract(10, 'minutes');
      const to   = now;

      const candles = await kiteService.getHistoricalData(
        NIFTY_TOKEN,
        CANDLE_INTERVAL,
        from.format('YYYY-MM-DD HH:mm:ss'),
        to.format('YYYY-MM-DD HH:mm:ss')
      );

      if (!candles || candles.length === 0) return;

      // Get most recent completed candle (not the live one)
      const latestCandle = candles[candles.length - 2] || candles[candles.length - 1];

      // Skip if already processed
      if (this.lastCandle && this.lastCandle.date === latestCandle.date) return;

      this.lastCandle = latestCandle;

      const candle = {
        date:  latestCandle.date,
        open:  latestCandle.open,
        high:  latestCandle.high,
        low:   latestCandle.low,
        close: latestCandle.close,
      };

      logger.info(`📊 New candle: ${moment(candle.date).format('HH:mm')} OHLC: ${candle.open}/${candle.high}/${candle.low}/${candle.close}`);

      // Emit candle to frontend
      this.emit('new_candle', candle);

      // Process candle through strategy
      await this.processCandle(candle);

    } catch (err) {
      logger.error('fetchLatestCandle error: ' + err.message);
    }
  }

  // ── Process Candle Through Strategy ───
  async processCandle(candle) {
    // Check if setup formed
    const setup = this.strategy.addCandle(candle);

    if (setup) {
      this.currentSetup = setup;
      this.emit('setup_found', {
        setup,
        message: `Setup found! Range: ${setup.combinedRange} pts. Watching for breakout above ${setup.highestHigh} or below ${setup.lowestLow}`
      });
      logger.info(`🔍 Setup stored — watching for breakout`);
      return;
    }

    // Check breakout if setup exists
    if (this.currentSetup && !this.strategy.hasTradedToday()) {
      const signal = this.strategy.checkBreakout(candle, this.currentSetup);

      if (signal) {
        this.currentSetup = null;
        await this.executeTrade(signal);
      }
    }
  }

  // ── Execute Trade ─────────────────────
  async executeTrade(signal) {
    try {
      this.emit('signal', {
        signal,
        message: `🚀 ${signal.direction} signal! Entry: ${signal.entryPrice}`
      });

      if (PAPER_TRADE) {
        await this.executePaperTrade(signal);
      } else {
        await this.executeLiveTrade(signal);
      }
    } catch (err) {
      logger.error('executeTrade error: ' + err.message);
    }
  }

  // ── Paper Trade ───────────────────────
  async executePaperTrade(signal) {
    try {
      // Get current ATM option LTP
      const niftyLTP = await this.getNiftyLTP();
      const atmOption = await kiteService.findATMOption(niftyLTP, signal.direction);

      let optionLTP = 50; // Default fallback
      try {
        const quote   = await kiteService.getLTP([`NFO:${atmOption.tradingsymbol}`]);
        optionLTP     = quote[`NFO:${atmOption.tradingsymbol}`]?.last_price || 50;
      } catch (e) {
        logger.warn('Could not get option LTP — using estimated price');
        optionLTP = signal.slPremium * 3; // Rough estimate
      }

      const trade = this.strategy.executePaperTrade(signal, optionLTP);
      trade.optionSymbol = atmOption.tradingsymbol;

      this.emit('trade_opened', {
        trade,
        message: `📝 Paper trade opened: ${trade.direction} ${trade.optionSymbol} @ ₹${optionLTP}`
      });

      logger.info(`📝 Paper trade executed successfully`);
    } catch (err) {
      logger.error('executePaperTrade error: ' + err.message);
    }
  }

  // ── Live Trade ────────────────────────
  async executeLiveTrade(signal) {
    try {
      const niftyLTP  = await this.getNiftyLTP();
      const atmOption = await kiteService.findATMOption(niftyLTP, signal.direction);

      logger.info(`💰 Placing LIVE order: ${atmOption.tradingsymbol}`);

      // Place entry order
      const entryOrder = await kiteService.placeOrder({
        tradingsymbol: atmOption.tradingsymbol,
        quantity:      signal.qty,
      });

      // Wait for fill then place SL and Target
      await new Promise(r => setTimeout(r, 2000));

      // Get fill price
      const orders    = await kiteService.getOrders();
      const filled    = orders.find(o => o.order_id === entryOrder.order_id);
      const fillPrice = filled?.average_price || signal.slPremium * 2;

      const slPrice  = parseFloat((fillPrice - signal.slPremium).toFixed(2));
      const tgtPrice = parseFloat((fillPrice + signal.targetPremium).toFixed(2));

      // Place SL order
      await kiteService.placeSLOrder({
        tradingsymbol: atmOption.tradingsymbol,
        quantity:      signal.qty,
        triggerPrice:  slPrice,
      });

      // Place Target order
      await kiteService.placeTargetOrder({
        tradingsymbol: atmOption.tradingsymbol,
        quantity:      signal.qty,
        targetPrice:   tgtPrice,
      });

      const trade = this.strategy.executePaperTrade(signal, fillPrice);
      trade.optionSymbol = atmOption.tradingsymbol;
      trade.paperTrade   = false;
      trade.orderId      = entryOrder.order_id;

      this.emit('trade_opened', {
        trade,
        message: `💰 LIVE trade opened: ${trade.direction} ${trade.optionSymbol} @ ₹${fillPrice}`
      });

    } catch (err) {
      logger.error('executeLiveTrade error: ' + err.message);
      this.emit('error', { message: 'Live trade failed: ' + err.message });
    }
  }

  // ── Monitor Open Trade ─────────────────
  async monitorOpenTrade() {
    try {
      const trade = this.strategy.getCurrentTrade();
      if (!trade) return;

      // Get current option LTP
      let currentLTP = trade.entryOptionPrice;
      try {
        const quote = await kiteService.getLTP([`NFO:${trade.optionSymbol}`]);
        currentLTP  = quote[`NFO:${trade.optionSymbol}`]?.last_price || currentLTP;
      } catch (e) {
        // Use NIFTY LTP as fallback with delta
        const niftyLTP = await this.getNiftyLTP();
        const niftyMove = niftyLTP - trade.niftyEntry;
        const direction = trade.direction === 'CE' ? 1 : -1;
        currentLTP = trade.entryOptionPrice + (niftyMove * 0.5 * direction);
      }

      const result = this.strategy.monitorTrade(currentLTP);
      if (!result) return;

      this.emit('trade_update', { trade: this.strategy.getCurrentTrade() || result.trade, result });

      if (result.type === 'TRADE_CLOSED') {
        this.emit('trade_closed', {
          trade:   result.trade,
          pnl:     result.pnl,
          reason:  result.reason,
          message: `${result.pnl >= 0 ? '✅' : '❌'} Trade closed — ${result.reason} | P&L: ₹${result.pnl}`
        });

        // Cancel pending orders if live trade
        if (!PAPER_TRADE && result.trade.orderId) {
          try {
            await kiteService.exitPosition(result.trade.optionSymbol, result.trade.qty);
          } catch (e) {
            logger.warn('Could not exit position: ' + e.message);
          }
        }
      }

      if (result.type === 'TRAIL_ACTIVATED') {
        this.emit('trail_activated', {
          trade:   result.trade,
          message: `🎯 Trailing SL activated! Locked ₹${process.env.TRAIL_TRIGGER || 3000} profit`
        });
      }

    } catch (err) {
      logger.error('monitorOpenTrade error: ' + err.message);
    }
  }

  // ── Force Exit All ─────────────────────
  async forceExitAll() {
    const trade = this.strategy.getCurrentTrade();
    if (!trade) return;

    logger.info('⏰ Force exiting all positions at 3:21 PM');

    let exitLTP = trade.entryOptionPrice;
    try {
      const quote = await kiteService.getLTP([`NFO:${trade.optionSymbol}`]);
      exitLTP     = quote[`NFO:${trade.optionSymbol}`]?.last_price || exitLTP;
    } catch (e) {}

    const result = this.strategy.forceExit(exitLTP);
    if (result) {
      this.emit('trade_closed', {
        trade:   result.trade,
        pnl:     result.pnl,
        reason:  'TIME_EXIT',
        message: `⏰ Time exit at 3:21 PM | P&L: ₹${result.pnl}`
      });
    }
  }

  // ── Get NIFTY LTP ─────────────────────
  async getNiftyLTP() {
    try {
      const quote    = await kiteService.getLTP([NIFTY_SYMBOL]);
      this.niftyLTP  = quote[NIFTY_SYMBOL]?.last_price || this.niftyLTP;
      return this.niftyLTP;
    } catch (err) {
      return this.niftyLTP;
    }
  }

  // ── Manual Controls ───────────────────
  start() {
    this.running = true;
    logger.info('▶️  Trading engine started');
    this.emit('engine_status', { running: true });
  }

  stop() {
    this.running = false;
    logger.info('⏹️  Trading engine stopped');
    this.emit('engine_status', { running: false });
  }

  manualExit() {
    const trade = this.strategy.getCurrentTrade();
    if (!trade) return { success: false, message: 'No open trade' };

    const result = this.strategy.forceExit(trade.entryOptionPrice);
    this.emit('trade_closed', { trade: result.trade, pnl: result.pnl, reason: 'MANUAL_EXIT' });
    return { success: true, trade: result.trade };
  }

  getStatus() {
    return {
      running:        this.running,
      paperTrade:     PAPER_TRADE,
      tradedToday:    this.strategy.hasTradedToday(),
      currentTrade:   this.strategy.getCurrentTrade(),
      currentSetup:   this.currentSetup,
      niftyLTP:       this.niftyLTP,
      config:         this.strategy.getConfig(),
      paperTrades:    this.strategy.getPaperTrades(),
      connected:      kiteService.isConnected(),
    };
  }

  // ── Emit to frontend ──────────────────
  emit(event, data) {
    this.io.emit(event, { ...data, timestamp: new Date().toISOString() });
    logger.debug(`📡 Emitted: ${event}`);
  }
}

module.exports = TradingEngine;
