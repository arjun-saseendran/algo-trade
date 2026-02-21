const cron                = require('node-cron');
const moment              = require('moment');
const kiteService         = require('./kiteService');
const IronCondorStrategy  = require('../strategies/ironCondorStrategy');
const logger              = require('../utils/logger');

const PAPER_TRADE = process.env.PAPER_TRADE === 'true';

class IronCondorEngine {
  constructor(io) {
    this.io       = io;
    this.strategy = new IronCondorStrategy();
    this.running  = false;
    this.jobs     = [];
    this.setupCronJobs();
    logger.info(`🔄 Iron Condor Engine initialized | Mode: ${PAPER_TRADE ? '📝 PAPER' : '💰 LIVE'}`);
  }

  setupCronJobs() {
    // Check entry every minute during market hours
    const entryJob = cron.schedule('*/1 9-10 * * 1-5', async () => {
      if (!this.running) return;
      await this.checkEntry('NIFTY');
      await this.checkEntry('SENSEX');
    });

    // Monitor positions every 5 minutes
    const monitorJob = cron.schedule('*/5 9-15 * * 1-5', async () => {
      if (!this.running) return;
      await this.monitorPositions();
    });

    // Expiry day — monitor every minute
    const expiryJob = cron.schedule('*/1 9-15 * * 2,4', async () => {
      if (!this.running) return;
      await this.monitorPositions();
    });

    this.jobs = [entryJob, monitorJob, expiryJob];
    logger.info('✅ Iron Condor cron jobs scheduled');
  }

  // ── Check if should enter ──────────────
  async checkEntry(index) {
    const pos = this.strategy.getPosition(index);
    if (pos.status !== 'IDLE') return;
    if (!this.strategy.isEntryDay(index)) return;

    logger.info(`🔍 Checking ${index} entry...`);

    try {
      const symbol   = index === 'NIFTY' ? 'NSE:NIFTY 50' : 'BSE:SENSEX';
      const quote    = await kiteService.getLTP([symbol]);
      const spotPrice = quote[symbol]?.last_price;

      if (!spotPrice) return;

      logger.info(`${index} spot: ${spotPrice}`);

      const strikes  = this.strategy.calculateStrikes(spotPrice, index);

      // Get option premiums
      const premiums = await this.getOptionPremiums(index, strikes, spotPrice);
      if (!premiums) return;

      // Get expiry date
      const expiry = await this.getNearestExpiry(index);

      if (PAPER_TRADE) {
        await this.openPaperTrade(index, spotPrice, premiums, strikes, expiry);
      } else {
        await this.openLiveTrade(index, spotPrice, premiums, strikes, expiry);
      }

    } catch (err) {
      logger.error(`checkEntry ${index} error: ${err.message}`);
    }
  }

  // ── Get option premiums ────────────────
  async getOptionPremiums(index, strikes, spotPrice) {
    try {
      const exchange = index === 'NIFTY' ? 'NFO' : 'BFO';

      // Find option instruments
      const callSell = await kiteService.findATMOption(spotPrice, 'CE', null, index, strikes.call.sellStrike);
      const callBuy  = await kiteService.findATMOption(spotPrice, 'CE', null, index, strikes.call.buyStrike);
      const putSell  = await kiteService.findATMOption(spotPrice, 'PE', null, index, strikes.put.sellStrike);
      const putBuy   = await kiteService.findATMOption(spotPrice, 'PE', null, index, strikes.put.buyStrike);

      if (!callSell || !callBuy || !putSell || !putBuy) {
        logger.warn(`Could not find all option instruments for ${index}`);
        return null;
      }

      // Get LTP for all legs
      const instruments = [
        `${exchange}:${callSell.tradingsymbol}`,
        `${exchange}:${callBuy.tradingsymbol}`,
        `${exchange}:${putSell.tradingsymbol}`,
        `${exchange}:${putBuy.tradingsymbol}`,
      ];

      const quotes = await kiteService.getLTP(instruments);

      return {
        callSell:      quotes[instruments[0]]?.last_price || 0,
        callBuy:       quotes[instruments[1]]?.last_price || 0,
        putSell:       quotes[instruments[2]]?.last_price || 0,
        putBuy:        quotes[instruments[3]]?.last_price || 0,
        callSellSymbol: callSell.tradingsymbol,
        callBuySymbol:  callBuy.tradingsymbol,
        putSellSymbol:  putSell.tradingsymbol,
        putBuySymbol:   putBuy.tradingsymbol,
        exchange,
      };
    } catch (err) {
      logger.error(`getOptionPremiums error: ${err.message}`);
      return null;
    }
  }

  // ── Open paper trade ───────────────────
  async openPaperTrade(index, spotPrice, premiums, strikes, expiry) {
    const pos = this.strategy.openPosition(index, spotPrice, {
      callSell: premiums.callSell,
      callBuy:  premiums.callBuy,
      putSell:  premiums.putSell,
      putBuy:   premiums.putBuy,
    }, expiry);

    pos.symbols = {
      callSell: premiums.callSellSymbol,
      callBuy:  premiums.callBuySymbol,
      putSell:  premiums.putSellSymbol,
      putBuy:   premiums.putBuySymbol,
    };

    this.emit('ic_position_opened', {
      index,
      position: pos,
      message:  `📝 Paper Iron Condor opened: ${index} | Credit: ₹${pos.totalCredit}`
    });
  }

  // ── Open live trade ────────────────────
  async openLiveTrade(index, spotPrice, premiums, strikes, expiry) {
    try {
      const { exchange } = premiums;
      logger.info(`💰 Placing LIVE Iron Condor orders for ${index}`);

      // Place all 4 legs
      await kiteService.placeOrder({ tradingsymbol: premiums.callSellSymbol, exchange, transaction_type: 'SELL', quantity: this.getLotSize(index), product: 'NRML', order_type: 'MARKET' });
      await kiteService.placeOrder({ tradingsymbol: premiums.callBuySymbol,  exchange, transaction_type: 'BUY',  quantity: this.getLotSize(index), product: 'NRML', order_type: 'MARKET' });
      await kiteService.placeOrder({ tradingsymbol: premiums.putSellSymbol,  exchange, transaction_type: 'SELL', quantity: this.getLotSize(index), product: 'NRML', order_type: 'MARKET' });
      await kiteService.placeOrder({ tradingsymbol: premiums.putBuySymbol,   exchange, transaction_type: 'BUY',  quantity: this.getLotSize(index), product: 'NRML', order_type: 'MARKET' });

      const pos = this.strategy.openPosition(index, spotPrice, premiums, expiry);
      pos.symbols = {
        callSell: premiums.callSellSymbol,
        callBuy:  premiums.callBuySymbol,
        putSell:  premiums.putSellSymbol,
        putBuy:   premiums.putBuySymbol,
      };

      this.emit('ic_position_opened', {
        index,
        position: pos,
        message:  `💰 LIVE Iron Condor opened: ${index} | Credit: ₹${pos.totalCredit}`
      });

    } catch (err) {
      logger.error(`openLiveTrade error: ${err.message}`);
      this.emit('ic_error', { message: `Failed to open ${index} Iron Condor: ${err.message}` });
    }
  }

  // ── Monitor positions ──────────────────
  async monitorPositions() {
    for (const index of ['NIFTY', 'SENSEX']) {
      const pos = this.strategy.getPosition(index);
      if (pos.status === 'IDLE' || pos.status === 'CLOSED') continue;

      try {
        const exchange = index === 'NIFTY' ? 'NFO' : 'BFO';
        const instruments = [
          `${exchange}:${pos.symbols.callSell}`,
          `${exchange}:${pos.symbols.putSell}`,
        ];

        const quotes            = await kiteService.getLTP(instruments);
        const callCurrentPremium = quotes[instruments[0]]?.last_price || 0;
        const putCurrentPremium  = quotes[instruments[1]]?.last_price || 0;

        const result = this.strategy.updateMTM(index, callCurrentPremium, putCurrentPremium);
        if (!result) continue;

        // Emit update
        this.emit('ic_position_update', {
          index,
          position: result.position,
          alerts:   result.alerts,
        });

        // Emit alerts
        result.alerts.forEach(alert => {
          this.emit('ic_alert', { index, alert });
          logger.info(`🔔 ${index} Alert: ${alert.message}`);
        });

      } catch (err) {
        logger.error(`monitorPositions ${index} error: ${err.message}`);
      }
    }
  }

  // ── Get nearest expiry ─────────────────
  async getNearestExpiry(index) {
    try {
      const exchange   = index === 'NIFTY' ? 'NFO' : 'BFO';
      const instruments = await kiteService.getInstruments(exchange);
      const options     = instruments.filter(i => i.name === index && i.instrument_type === 'CE');
      const expiries    = [...new Set(options.map(i => i.expiry))]
        .map(e => new Date(e))
        .filter(e => e >= new Date())
        .sort((a, b) => a - b);
      return expiries[0]?.toISOString().split('T')[0] || null;
    } catch (err) {
      return null;
    }
  }

  getLotSize(index) {
    return index === 'NIFTY' ? 75 : 10;
  }

  // ── Manual controls ────────────────────
  start() {
    this.running = true;
    logger.info('▶️  Iron Condor engine started');
    this.emit('ic_engine_status', { running: true });
  }

  stop() {
    this.running = false;
    logger.info('⏹️  Iron Condor engine stopped');
    this.emit('ic_engine_status', { running: false });
  }

  recordRoll(index, type, side) {
    if (type === 'system')        this.strategy.recordSystemRoll(index, side);
    if (type === 'discretionary') this.strategy.recordDiscretionaryRoll(index, side);
    this.emit('ic_roll_recorded', { index, type, side });
  }

  convertToIronFly(index) {
    this.strategy.convertToIronFly(index);
    this.emit('ic_iron_fly', { index, message: `🦋 ${index} converted to Iron Butterfly` });
  }

  closePosition(index, reason, pnl) {
    const pos = this.strategy.closePosition(index, reason, pnl);
    this.emit('ic_position_closed', { index, position: pos });
  }

  getStatus() {
    return {
      running:      this.running,
      paperTrade:   PAPER_TRADE,
      positions:    this.strategy.getAllPositions(),
      history:      this.strategy.getTradeHistory(),
      config:       this.strategy.getConfig(),
    };
  }

  emit(event, data) {
    this.io.emit(event, { ...data, timestamp: new Date().toISOString() });
  }
}

module.exports = IronCondorEngine;
