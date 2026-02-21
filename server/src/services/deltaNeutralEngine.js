const cron                              = require('node-cron');
const moment                            = require('moment');
const kiteService                       = require('./kiteService');
const { DeltaNeutralStrategy, calculateDelta } = require('../strategies/deltaNeutralStrategy');
const logger                            = require('../utils/logger');

const PAPER_TRADE = process.env.PAPER_TRADE === 'true';

class DeltaNeutralEngine {
  constructor(io) {
    this.io       = io;
    this.strategy = new DeltaNeutralStrategy();
    this.running  = false;
    this.setupCronJobs();
    logger.info(`🎯 Delta Neutral Engine initialized | Mode: ${PAPER_TRADE ? '📝 PAPER' : '💰 LIVE'}`);
  }

  setupCronJobs() {
    // Friday 3:20 PM entry check
    const entryJob = cron.schedule('20 15 * * 5', async () => {
      if (!this.running) return;
      logger.info('⏰ Friday 3:20 PM — checking Delta Neutral entry');
      await this.checkEntry();
    });

    // Monitor every 5 min on Monday-Thursday market hours
    const monitorJob = cron.schedule('*/5 9-15 * * 1-4', async () => {
      if (!this.running) return;
      await this.monitorPosition();
    });

    this.jobs = [entryJob, monitorJob];
    logger.info('✅ Delta Neutral cron jobs scheduled');
  }

  // ── Check and execute entry ────────────
  async checkEntry() {
    const pos = this.strategy.getPosition();
    if (pos.status !== 'IDLE') {
      logger.info('Delta Neutral: position already active — skip entry');
      return;
    }

    try {
      // Get SENSEX spot
      const quote     = await kiteService.getLTP(['BSE:SENSEX']);
      const spotPrice = quote['BSE:SENSEX']?.last_price;
      if (!spotPrice) { logger.warn('Could not get SENSEX spot'); return; }

      logger.info(`SENSEX spot at entry: ${spotPrice}`);

      // Get Thursday expiry options
      const expiry   = await this.getThursdayExpiry();
      if (!expiry)   { logger.warn('Could not find Thursday expiry'); return; }

      // Get full option chain with IV
      const chain    = await this.getOptionChain(spotPrice, expiry);
      if (!chain)    { logger.warn('Could not get option chain'); return; }

      // Find strikes by delta
      const legs     = this.findDeltaStrikes(chain, spotPrice, expiry);
      if (!legs)     { logger.warn('Could not find delta strikes'); return; }

      // Get actual premiums
      const premiums = await this.getLegPremiums(legs, expiry);
      if (!premiums) { logger.warn('Could not get leg premiums'); return; }

      if (PAPER_TRADE) {
        await this.openPaperTrade(spotPrice, premiums, expiry);
      } else {
        await this.openLiveTrade(spotPrice, premiums, expiry);
      }

    } catch (err) {
      logger.error(`checkEntry error: ${err.message}`);
      this.emit('dn_error', { message: err.message });
    }
  }

  // ── Find strikes by delta ──────────────
  findDeltaStrikes(chain, spotPrice, expiry) {
    try {
      const cfg          = this.strategy.getConfig();
      const timeToExpiry = moment(expiry).diff(moment(), 'days') / 365;

      // Find Call Buy (~0.50 delta) and Call Sell (~0.40 delta)
      let callBuyBest  = null, callBuyDelta  = null, callBuyDiff  = Infinity;
      let callSellBest = null, callSellDelta = null, callSellDiff = Infinity;
      let putBuyBest   = null, putBuyDelta   = null, putBuyDiff   = Infinity;
      let putSellBest  = null, putSellDelta  = null, putSellDiff  = Infinity;

      for (const option of chain) {
        const iv    = option.iv || 15;
        const delta = calculateDelta(
          spotPrice, option.strike, timeToExpiry,
          cfg.RISK_FREE_RATE, iv / 100, option.type
        );
        if (delta === null) continue;

        const absDelta = Math.abs(delta);

        if (option.type === 'CE') {
          // Call Buy → closest to 0.50
          const diff50 = Math.abs(absDelta - cfg.BUY_DELTA);
          if (diff50 < callBuyDiff) {
            callBuyDiff  = diff50;
            callBuyBest  = option;
            callBuyDelta = delta;
          }
          // Call Sell → closest to 0.40
          const diff40 = Math.abs(absDelta - cfg.SELL_DELTA);
          if (diff40 < callSellDiff) {
            callSellDiff  = diff40;
            callSellBest  = option;
            callSellDelta = delta;
          }
        }

        if (option.type === 'PE') {
          // Put Buy → closest to -0.50
          const diff50 = Math.abs(absDelta - cfg.BUY_DELTA);
          if (diff50 < putBuyDiff) {
            putBuyDiff  = diff50;
            putBuyBest  = option;
            putBuyDelta = delta;
          }
          // Put Sell → closest to -0.40
          const diff40 = Math.abs(absDelta - cfg.SELL_DELTA);
          if (diff40 < putSellDiff) {
            putSellDiff  = diff40;
            putSellBest  = option;
            putSellDelta = delta;
          }
        }
      }

      if (!callBuyBest || !callSellBest || !putBuyBest || !putSellBest) {
        logger.warn('Could not find all 4 legs by delta');
        return null;
      }

      // Make sure buy and sell strikes are different
      if (callBuyBest.strike === callSellBest.strike) {
        logger.warn('Call Buy and Sell same strike — adjusting');
        callSellBest = chain.find(o => o.type === 'CE' && o.strike > callBuyBest.strike);
      }
      if (putBuyBest.strike === putSellBest.strike) {
        logger.warn('Put Buy and Sell same strike — adjusting');
        putSellBest = chain.find(o => o.type === 'PE' && o.strike < putBuyBest.strike);
      }

      const netDelta = parseFloat((
        callBuyDelta + (-Math.abs(callSellDelta)) +
        (-Math.abs(putBuyDelta)) + Math.abs(putSellDelta)
      ).toFixed(4));

      logger.info(`Delta check — CB:${callBuyDelta} CS:${-Math.abs(callSellDelta)} PB:${-Math.abs(putBuyDelta)} PS:${Math.abs(putSellDelta)} Net:${netDelta}`);

      return {
        callBuy:  { strike: callBuyBest.strike,  delta: callBuyDelta,          tradingsymbol: callBuyBest.tradingsymbol,  iv: callBuyBest.iv  },
        callSell: { strike: callSellBest.strike, delta: -Math.abs(callSellDelta), tradingsymbol: callSellBest.tradingsymbol, iv: callSellBest.iv },
        putBuy:   { strike: putBuyBest.strike,   delta: -Math.abs(putBuyDelta),  tradingsymbol: putBuyBest.tradingsymbol,   iv: putBuyBest.iv   },
        putSell:  { strike: putSellBest.strike,  delta: Math.abs(putSellDelta),  tradingsymbol: putSellBest.tradingsymbol,  iv: putSellBest.iv  },
        netDelta,
      };
    } catch (err) {
      logger.error(`findDeltaStrikes error: ${err.message}`);
      return null;
    }
  }

  // ── Get leg premiums ───────────────────
  async getLegPremiums(legs, expiry) {
    try {
      const instruments = [
        `BFO:${legs.callBuy.tradingsymbol}`,
        `BFO:${legs.callSell.tradingsymbol}`,
        `BFO:${legs.putBuy.tradingsymbol}`,
        `BFO:${legs.putSell.tradingsymbol}`,
      ];

      const quotes = await kiteService.getLTP(instruments);

      return {
        callBuy:  { ...legs.callBuy,  premium: quotes[instruments[0]]?.last_price || 0 },
        callSell: { ...legs.callSell, premium: quotes[instruments[1]]?.last_price || 0 },
        putBuy:   { ...legs.putBuy,   premium: quotes[instruments[2]]?.last_price || 0 },
        putSell:  { ...legs.putSell,  premium: quotes[instruments[3]]?.last_price || 0 },
      };
    } catch (err) {
      logger.error(`getLegPremiums error: ${err.message}`);
      return null;
    }
  }

  // ── Get option chain with IV ───────────
  async getOptionChain(spotPrice, expiry) {
    try {
      const instruments = await kiteService.getInstruments('BFO');
      const options     = instruments
        .filter(i =>
          i.name === 'SENSEX' &&
          (i.instrument_type === 'CE' || i.instrument_type === 'PE') &&
          new Date(i.expiry).toDateString() === new Date(expiry).toDateString()
        )
        .map(i => ({
          strike:          i.strike,
          type:            i.instrument_type,
          tradingsymbol:   i.tradingsymbol,
          instrument_token: i.instrument_token,
          iv:              15, // default IV — will be updated from quotes
        }));

      // Get quotes for near ATM strikes to get actual IV
      const atmStrike    = Math.round(spotPrice / 100) * 100;
      const nearStrikes  = options.filter(o =>
        Math.abs(o.strike - atmStrike) <= 500
      );

      if (nearStrikes.length > 0) {
        const syms   = nearStrikes.map(o => `BFO:${o.tradingsymbol}`).slice(0, 50);
        const quotes = await kiteService.getQuote(syms);

        nearStrikes.forEach(o => {
          const q = quotes[`BFO:${o.tradingsymbol}`];
          if (q?.ohlc) o.iv = q.implied_volatility || 15;
        });
      }

      return options;
    } catch (err) {
      logger.error(`getOptionChain error: ${err.message}`);
      return null;
    }
  }

  // ── Get Thursday expiry ────────────────
  async getThursdayExpiry() {
    try {
      const instruments = await kiteService.getInstruments('BFO');
      const options     = instruments.filter(i =>
        i.name === 'SENSEX' && i.instrument_type === 'CE'
      );
      const expiries    = [...new Set(options.map(i => i.expiry))]
        .map(e => new Date(e))
        .filter(e => e >= new Date() && new Date(e).getDay() === 4) // Thursday
        .sort((a, b) => a - b);

      return expiries[0]?.toISOString().split('T')[0] || null;
    } catch (err) {
      logger.error(`getThursdayExpiry error: ${err.message}`);
      return null;
    }
  }

  // ── Open paper trade ───────────────────
  async openPaperTrade(spotPrice, legs, expiry) {
    const pos = this.strategy.openPosition(spotPrice, legs, expiry);
    this.emit('dn_position_opened', {
      position: pos,
      message:  `📝 Paper Delta Neutral opened | Net debit: ₹${pos.netDebit} | Net delta: ${pos.netDelta}`
    });
  }

  // ── Open live trade ────────────────────
  async openLiveTrade(spotPrice, legs, expiry) {
    try {
      logger.info('💰 Placing LIVE Delta Neutral orders');

      // Place sell legs first (margin)
      await kiteService.placeOrder({ tradingsymbol: legs.callSell.tradingsymbol, exchange: 'BFO', transaction_type: 'SELL', quantity: 20, product: 'MIS', order_type: 'MARKET' });
      await kiteService.placeOrder({ tradingsymbol: legs.putSell.tradingsymbol,  exchange: 'BFO', transaction_type: 'SELL', quantity: 20, product: 'MIS', order_type: 'MARKET' });

      // Then buy legs
      await kiteService.placeOrder({ tradingsymbol: legs.callBuy.tradingsymbol,  exchange: 'BFO', transaction_type: 'BUY',  quantity: 20, product: 'MIS', order_type: 'MARKET' });
      await kiteService.placeOrder({ tradingsymbol: legs.putBuy.tradingsymbol,   exchange: 'BFO', transaction_type: 'BUY',  quantity: 20, product: 'MIS', order_type: 'MARKET' });

      const pos = this.strategy.openPosition(spotPrice, legs, expiry);
      this.emit('dn_position_opened', {
        position: pos,
        message:  `💰 LIVE Delta Neutral opened | Net debit: ₹${pos.netDebit}`
      });
    } catch (err) {
      logger.error(`openLiveTrade error: ${err.message}`);
      this.emit('dn_error', { message: `Live trade failed: ${err.message}` });
    }
  }

  // ── Monitor position ───────────────────
  async monitorPosition() {
    const pos = this.strategy.getPosition();
    if (pos.status === 'IDLE' || pos.status === 'CLOSED') return;

    try {
      // Get current premiums for active legs
      const activeLegs  = pos.activeLegs;
      const instruments = activeLegs.map(l => `BFO:${pos.legs[l].tradingsymbol}`);
      const quotes      = await kiteService.getLTP(instruments);

      const currentPremiums = {};
      activeLegs.forEach((legKey, i) => {
        currentPremiums[legKey] = quotes[instruments[i]]?.last_price || 0;
      });

      const result = this.strategy.monitorPosition(currentPremiums);
      if (!result) return;

      this.emit('dn_position_update', { position: result.position });

      // Emit alerts
      result.alerts.forEach(alert => {
        this.emit('dn_alert', { alert });
      });

      // Execute actions
      for (const action of result.actions) {
        if (action.type === 'EXIT_ALL') {
          await this.exitAll(action.reason);
        } else if (action.type === 'EXIT_LEGS') {
          await this.exitLegs(action.legs, action.reason);
        }
      }

    } catch (err) {
      logger.error(`monitorPosition error: ${err.message}`);
    }
  }

  // ── Exit specific legs ─────────────────
  async exitLegs(legKeys, reason) {
    const pos = this.strategy.getPosition();

    // Exit sell legs first always
    const sellFirst = legKeys.filter(l => l === 'callSell' || l === 'putSell');
    const buyAfter  = legKeys.filter(l => l === 'callBuy'  || l === 'putBuy');

    if (!PAPER_TRADE) {
      for (const legKey of [...sellFirst, ...buyAfter]) {
        const leg    = pos.legs[legKey];
        const isBuy  = legKey === 'callBuy' || legKey === 'putBuy';
        try {
          await kiteService.placeOrder({
            tradingsymbol:    leg.tradingsymbol,
            exchange:         'BFO',
            transaction_type: isBuy ? 'SELL' : 'BUY',
            quantity:         20,
            product:          'MIS',
            order_type:       'MARKET',
          });
        } catch (err) {
          logger.error(`exitLeg ${legKey} error: ${err.message}`);
        }
      }
    }

    this.strategy.closeLegs(legKeys, reason);
    this.emit('dn_legs_closed', {
      legs:    legKeys,
      reason,
      message: `🔴 Legs closed: ${legKeys.join(', ')} | ${reason}`
    });
    this.emit('dn_position_update', { position: this.strategy.getPosition() });
  }

  // ── Exit all ───────────────────────────
  async exitAll(reason) {
    const pos = this.strategy.getPosition();

    if (!PAPER_TRADE) {
      const sellLegs = pos.activeLegs.filter(l => l === 'callSell' || l === 'putSell');
      const buyLegs  = pos.activeLegs.filter(l => l === 'callBuy'  || l === 'putBuy');

      for (const legKey of [...sellLegs, ...buyLegs]) {
        const leg   = pos.legs[legKey];
        const isBuy = legKey === 'callBuy' || legKey === 'putBuy';
        try {
          await kiteService.placeOrder({
            tradingsymbol:    leg.tradingsymbol,
            exchange:         'BFO',
            transaction_type: isBuy ? 'SELL' : 'BUY',
            quantity:         20,
            product:          'MIS',
            order_type:       'MARKET',
          });
        } catch (err) {
          logger.error(`exitAll leg ${legKey} error: ${err.message}`);
        }
      }
    }

    const closed = this.strategy.closeAll(reason);
    this.emit('dn_position_closed', {
      position: closed,
      message:  `${closed.pnl >= 0 ? '✅' : '❌'} All legs closed: ${reason} | P&L: ₹${closed.pnl}`
    });
  }

  // ── Manual controls ────────────────────
  start() { this.running = true;  this.emit('dn_engine_status', { running: true  }); }
  stop()  { this.running = false; this.emit('dn_engine_status', { running: false }); }

  getStatus() {
    return {
      running:    this.running,
      paperTrade: PAPER_TRADE,
      position:   this.strategy.getPosition(),
      history:    this.strategy.getTradeHistory(),
      config:     this.strategy.getConfig(),
    };
  }

  emit(event, data) {
    this.io.emit(event, { ...data, timestamp: new Date().toISOString() });
  }
}

module.exports = DeltaNeutralEngine;
