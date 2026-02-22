/**
 * Delta Neutral Engine — SENSEX Weekly Options
 *
 * Order Execution Rules:
 * ─────────────────────────────────────────────────────────────
 * ENTRY (Friday 3:20 PM):
 *   Place all 4 legs as MARKET orders simultaneously.
 *   After fill confirmation, place SL orders for each leg.
 *
 * STOP LOSS (leg-level, triggered live):
 *   Before placing exit market order → cancel the pending SL/trail order first,
 *   then place market exit order.
 *
 * MONDAY 3:20 PM EXIT (time-based, if SL/trail not hit):
 *   1. Cancel ALL pending SL orders still open
 *   2. Then place market exit orders for all remaining active legs
 *
 * EXIT ORDER (per pair/leg):
 *   For each pair exited: sell legs exit first, then buy legs.
 *   (Sell legs are short — buying them back first removes risk faster)
 */

const cron        = require('node-cron');
const kiteService = require('./kiteService');
const Trade       = require('../models/Trades');
const logger      = require('../utils/logger');

const PAPER_TRADE = () => process.env.PAPER_TRADE === 'true';

// Leg definitions — order matters for exit sequencing
const LEG_CONFIG = {
  callSell: { optionType: 'CE', action: 'SELL', deltaTarget: 0.40, exitPriority: 1 }, // exit FIRST (short leg)
  putSell:  { optionType: 'PE', action: 'SELL', deltaTarget: 0.40, exitPriority: 2 }, // exit SECOND
  callBuy:  { optionType: 'CE', action: 'BUY',  deltaTarget: 0.50, exitPriority: 3 }, // exit THIRD
  putBuy:   { optionType: 'PE', action: 'BUY',  deltaTarget: 0.50, exitPriority: 4 }, // exit LAST
};

class DeltaNeutralEngine {
  constructor(io) {
    this.io       = io;
    this.running  = false;
    this.position = this._emptyPosition();
    this.history  = [];
    this.setupCron();
  }

  _emptyPosition() {
    return {
      status:       'IDLE',
      entryDate:    null,
      entryTime:    null,
      expiryDate:   null,
      spotAtEntry:  0,
      netDebit:     0,
      combinedSL:   0,
      netDelta:     0,
      pnl:          0,
      lockedProfit: 0,
      trailSL:      null,
      lastBuyLeg:   null,
      alerts:       [],
      legs: {
        callBuy:  null,
        callSell: null,
        putBuy:   null,
        putSell:  null,
      },
      // Tracks pending SL/trail order IDs so we can cancel before time exit
      pendingOrderIds: {
        callBuy:  null,
        callSell: null,
        putBuy:   null,
        putSell:  null,
      }
    };
  }

  setupCron() {
    // Entry: Every Friday 3:20 PM
    cron.schedule('20 15 * * 5', async () => {
      if (this.running && this.position.status === 'IDLE') {
        await this.enterPosition();
      }
    });

    // Monitor: Every minute Mon–Fri during market hours
    cron.schedule('* 9-15 * * 1-5', async () => {
      if (this.running) await this.monitor();
    });

    // Monday 3:20 PM time exit — cancel pending SL orders first, then exit
    cron.schedule('20 15 * * 1', async () => {
      if (this.running && this.position.status !== 'IDLE') {
        logger.info('⏰ Monday 3:20 PM — Time exit triggered');
        await this.mondayTimeExit();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ENTRY
  // ─────────────────────────────────────────────────────────────
  async enterPosition() {
    logger.info('⚖️ Delta Neutral: Entering position at Friday 3:20 PM...');

    try {
      const quotes = await kiteService.getLTP(['BSE:SENSEX']);
      const spot   = quotes['BSE:SENSEX']?.last_price || 0;

      const atmStrike  = Math.round(spot / 100) * 100;
      const nearStrike = atmStrike + 200; // near-OTM for sell legs

      this.position = this._emptyPosition();
      this.position.status      = 'ACTIVE';
      this.position.entryDate   = new Date().toLocaleDateString('en-IN');
      this.position.entryTime   = new Date().toLocaleTimeString('en-IN');
      this.position.spotAtEntry = spot;
      this.position.expiryDate  = this._nextThursday();

      // Define all 4 legs
      const legDefs = [
        { key: 'callBuy',  symbol: `SENSEX${atmStrike}CE`,  action: 'BUY',  premium: 120, exitPriority: 3 },
        { key: 'putBuy',   symbol: `SENSEX${atmStrike}PE`,  action: 'BUY',  premium: 120, exitPriority: 4 },
        { key: 'callSell', symbol: `SENSEX${nearStrike}CE`, action: 'SELL', premium: 80,  exitPriority: 1 },
        { key: 'putSell',  symbol: `SENSEX${nearStrike}PE`, action: 'SELL', premium: 80,  exitPriority: 2 },
      ];

      // Place all 4 entry orders (MARKET)
      for (const def of legDefs) {
        if (!PAPER_TRADE()) {
          try {
            const order = await kiteService.placeOrderFull({
              exchange:         'BFO',
              tradingsymbol:    def.symbol,
              transaction_type: def.action,
              quantity:         20, // SENSEX lot
              product:          'NRML', // overnight position
              order_type:       'MARKET',
              tag:              'DN_ENTRY'
            });
            logger.info(`✅ ${def.key} entry order placed: ${def.symbol} orderId=${order.order_id}`);
          } catch (err) {
            logger.error(`❌ ${def.key} entry order failed: ${err.message}`);
          }
        }

        this.position.legs[def.key] = {
          symbol:        def.symbol,
          action:        def.action,
          entryPremium:  def.premium,
          currentPremium: def.premium,
          exitPriority:  def.exitPriority,
          status:        'ACTIVE',
          pnl:           0,
          peakPremium:   def.premium,
          slOrderId:     null,
          trailOrderId:  null,
        };
      }

      // Net debit = buy premiums − sell premiums
      this.position.netDebit    = (120 + 120) - (80 + 80); // = 80 per unit
      this.position.combinedSL  = this.position.netDebit * 0.60 * 20; // 60% of net debit × lot

      logger.info(`✅ Delta Neutral position entered | Spot=${spot} | ATM=${atmStrike} | NetDebit=${this.position.netDebit}`);

      // After entry, place SL orders for each leg
      await this._placeLegSLOrders();

      this.emitStatus();

      // Save to MongoDB
      await this._saveToDB();

    } catch (err) {
      logger.error(`❌ Delta Neutral entry failed: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PLACE SL ORDERS AFTER ENTRY
  // ─────────────────────────────────────────────────────────────
  async _placeLegSLOrders() {
    if (PAPER_TRADE()) return; // paper mode — no real SL orders

    const legs = this.position.legs;

    // For each BUY leg: place SL-M order to exit when premium drops 60%
    for (const key of ['callBuy', 'putBuy']) {
      const leg = legs[key];
      if (!leg || leg.status !== 'ACTIVE') continue;
      const slPrice = leg.entryPremium * 0.40; // 60% loss = price at 40% of entry
      try {
        const order = await kiteService.placeOrderFull({
          exchange:         'BFO',
          tradingsymbol:    leg.symbol,
          transaction_type: 'SELL', // close BUY position
          quantity:         20,
          product:          'NRML',
          order_type:       'SL-M',
          trigger_price:    slPrice,
          tag:              'DN_SL'
        });
        leg.slOrderId = order.order_id;
        logger.info(`🛡️ SL order placed for ${key}: trigger ₹${slPrice} orderId=${order.order_id}`);
      } catch (err) {
        logger.error(`❌ SL order failed for ${key}: ${err.message}`);
      }
    }

    // For each SELL leg: place SL-M order to exit when premium gains 60%
    for (const key of ['callSell', 'putSell']) {
      const leg = legs[key];
      if (!leg || leg.status !== 'ACTIVE') continue;
      const slPrice = leg.entryPremium * 1.60; // 60% gain means we're buying back at 160%
      try {
        const order = await kiteService.placeOrderFull({
          exchange:         'BFO',
          tradingsymbol:    leg.symbol,
          transaction_type: 'BUY', // close SELL position
          quantity:         20,
          product:          'NRML',
          order_type:       'SL-M',
          trigger_price:    slPrice,
          tag:              'DN_SL'
        });
        leg.slOrderId = order.order_id;
        logger.info(`🛡️ SL order placed for ${key}: trigger ₹${slPrice} orderId=${order.order_id}`);
      } catch (err) {
        logger.error(`❌ SL order failed for ${key}: ${err.message}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MONITOR (every minute)
  // ─────────────────────────────────────────────────────────────
  async monitor() {
    if (this.position.status === 'IDLE') return;

    try {
      // Fetch current premiums for all active legs
      const activeLegs    = Object.entries(this.position.legs).filter(([, l]) => l && l.status === 'ACTIVE');
      if (activeLegs.length === 0) return;

      const symbols       = activeLegs.map(([, l]) => `BFO:${l.symbol}`);
      const quotes        = await kiteService.getLTP(symbols);

      let totalPnl = 0;

      for (const [key, leg] of activeLegs) {
        const ltp = quotes[`BFO:${leg.symbol}`]?.last_price;
        if (!ltp) continue;

        leg.currentPremium = ltp;

        // P&L: BUY = gain when premium rises, SELL = gain when premium falls
        leg.pnl = leg.action === 'BUY'
          ? (ltp - leg.entryPremium) * 20
          : (leg.entryPremium - ltp) * 20;

        totalPnl += leg.pnl;

        // Update peak for trail tracking
        if (leg.action === 'BUY' && ltp > (leg.peakPremium || leg.entryPremium)) {
          leg.peakPremium = ltp;
        }
      }

      this.position.pnl = totalPnl;

      // Run SL checks
      await this._checkSLConditions();

      // Run trail logic (only when in last-buy-leg mode)
      await this._checkTrail();

      this.emitStatus();
    } catch (err) {
      logger.error(`Monitor error: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SL CONDITIONS
  // ─────────────────────────────────────────────────────────────
  async _checkSLConditions() {
    const legs = this.position.legs;
    if (!legs) return;

    // 1. Combined net -60% → exit ALL (sell legs first, then buy legs)
    const netDebitRs = this.position.netDebit * 20;
    if (this.position.pnl <= -(netDebitRs * 0.60)) {
      logger.warn('🔴 Combined 60% SL hit — exiting ALL legs (sells first)');
      await this.exitAll('Combined 60% SL');
      return;
    }

    // 2. Call Buy -60% → exit Call Sell first, then Call Buy
    if (legs.callBuy?.status === 'ACTIVE') {
      const loss = (legs.callBuy.currentPremium - legs.callBuy.entryPremium) / legs.callBuy.entryPremium;
      if (loss <= -0.60) {
        logger.warn('🔴 Call Buy -60% SL → exiting Call Sell then Call Buy');
        await this._exitPair(['callSell', 'callBuy'], 'Call Buy -60% SL');
        return;
      }
    }

    // 3. Put Buy -60% → exit Put Sell first, then Put Buy
    if (legs.putBuy?.status === 'ACTIVE') {
      const loss = (legs.putBuy.currentPremium - legs.putBuy.entryPremium) / legs.putBuy.entryPremium;
      if (loss <= -0.60) {
        logger.warn('🔴 Put Buy -60% SL → exiting Put Sell then Put Buy');
        await this._exitPair(['putSell', 'putBuy'], 'Put Buy -60% SL');
        return;
      }
    }

    // 4. Call Sell +60% gain → exit Call Sell only
    if (legs.callSell?.status === 'ACTIVE') {
      const gain = (legs.callSell.entryPremium - legs.callSell.currentPremium) / legs.callSell.entryPremium;
      if (gain >= 0.60) {
        logger.warn('🔴 Call Sell +60% gain SL → exiting Call Sell only');
        await this._exitSingleLeg('callSell', 'Call Sell +60% SL');
      }
    }

    // 5. Put Sell +60% gain → exit Put Sell only
    if (legs.putSell?.status === 'ACTIVE') {
      const gain = (legs.putSell.entryPremium - legs.putSell.currentPremium) / legs.putSell.entryPremium;
      if (gain >= 0.60) {
        logger.warn('🔴 Put Sell +60% gain SL → exiting Put Sell only');
        await this._exitSingleLeg('putSell', 'Put Sell +60% SL');
      }
    }

    // Check if all legs done after any exits
    this._updatePositionStatus();
  }

  // ─────────────────────────────────────────────────────────────
  // TRAIL (last surviving buy leg)
  // ─────────────────────────────────────────────────────────────
  async _checkTrail() {
    const legs         = this.position.legs;
    const activeBuys   = ['callBuy', 'putBuy'].filter(k => legs[k]?.status === 'ACTIVE');
    const activeSells  = ['callSell', 'putSell'].filter(k => legs[k]?.status === 'ACTIVE');

    if (activeBuys.length !== 1 || activeSells.length !== 0) return; // not in trail mode yet

    const lastKey  = activeBuys[0];
    const leg      = legs[lastKey];
    const legPnl   = leg.pnl || 0;

    this.position.lastBuyLeg = lastKey;

    // Calculate locked profit from trail table
    const levels = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
    const locks  = [250,  1000, 1750, 2500, 3250, 4000, 4750, 5500];
    let locked = 0;
    for (let i = levels.length - 1; i >= 0; i--) {
      if (legPnl >= levels[i]) { locked = locks[i]; break; }
    }

    // Only move trailSL up, never down
    if (locked > (this.position.trailSL || 0)) {
      this.position.trailSL    = locked;
      this.position.lockedProfit = locked;
      logger.info(`🎯 Trail SL updated: Lock ₹${locked}`);

      // Update the live trail SL order on exchange
      if (!PAPER_TRADE() && leg.trailOrderId) {
        // Cancel old trail order then place updated one
        try {
          await kiteService.cancelOrder(leg.trailOrderId);
        } catch (e) { /* may already be filled */ }
      }

      // Place new trail SL order
      if (!PAPER_TRADE()) {
        const trailTrigger = leg.entryPremium + (locked / 20); // convert ₹ to premium points
        try {
          const order = await kiteService.placeOrderFull({
            exchange: 'BFO', tradingsymbol: leg.symbol,
            transaction_type: 'SELL', quantity: 20, product: 'NRML',
            order_type: 'SL-M', trigger_price: trailTrigger, tag: 'DN_TRAIL'
          });
          leg.trailOrderId = order.order_id;
        } catch (err) {
          logger.error(`Trail order update failed: ${err.message}`);
        }
      }
    }

    // Trail SL hit
    if (this.position.trailSL > 0 && legPnl <= this.position.trailSL) {
      logger.info(`💰 Trail SL hit at ₹${this.position.trailSL}`);
      // Cancel SL order first, then exit
      await this._cancelLegOrders([lastKey]);
      await this._exitSingleLeg(lastKey, 'Trail SL Hit');
      await this._closeEntirePosition('Trail SL Hit');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MONDAY 3:20 PM TIME EXIT
  // Cancel ALL pending orders first, THEN exit remaining legs
  // Sell legs exit first (buy back shorts), then buy legs
  // ─────────────────────────────────────────────────────────────
  async mondayTimeExit() {
    const legs = this.position.legs;
    const activeLegKeys = Object.keys(legs).filter(k => legs[k]?.status === 'ACTIVE');

    if (activeLegKeys.length === 0) return;

    logger.info(`⏰ Monday time exit: ${activeLegKeys.length} active legs to close`);

    // STEP 1: Cancel ALL pending SL / trail orders
    logger.info('🚫 Step 1: Cancelling all pending SL/trail orders...');
    await this._cancelLegOrders(activeLegKeys);

    // Small delay to ensure cancels are processed
    await new Promise(r => setTimeout(r, 500));

    // STEP 2: Exit sell legs first (buy them back), then buy legs (sell them)
    const sellLegs = activeLegKeys.filter(k => legs[k].action === 'SELL').sort((a, b) => legs[a].exitPriority - legs[b].exitPriority);
    const buyLegs  = activeLegKeys.filter(k => legs[k].action === 'BUY').sort((a, b)  => legs[a].exitPriority - legs[b].exitPriority);

    logger.info(`📤 Step 2: Exiting sell legs first: [${sellLegs.join(', ')}]`);
    for (const key of sellLegs) {
      await this._exitSingleLeg(key, 'Monday Time Exit');
      await new Promise(r => setTimeout(r, 300)); // brief pause between orders
    }

    logger.info(`📤 Step 3: Exiting buy legs: [${buyLegs.join(', ')}]`);
    for (const key of buyLegs) {
      await this._exitSingleLeg(key, 'Monday Time Exit');
      await new Promise(r => setTimeout(r, 300));
    }

    await this._closeEntirePosition('Monday 3:20 PM Exit');
  }

  // ─────────────────────────────────────────────────────────────
  // EXIT HELPERS
  // ─────────────────────────────────────────────────────────────

  // Cancel pending SL/trail orders for specified legs
  async _cancelLegOrders(legKeys) {
    for (const key of legKeys) {
      const leg = this.position.legs[key];
      if (!leg) continue;

      for (const orderIdField of ['slOrderId', 'trailOrderId']) {
        const orderId = leg[orderIdField];
        if (!orderId) continue;
        try {
          await kiteService.cancelOrder(orderId);
          leg[orderIdField] = null;
          logger.info(`✅ Cancelled ${orderIdField} for ${key}: ${orderId}`);
        } catch (err) {
          // Order may already be filled/cancelled — log but don't throw
          logger.warn(`⚠️ Could not cancel ${orderIdField} for ${key} (${orderId}): ${err.message}`);
        }
      }
    }
  }

  // Exit a pair of legs (e.g. callSell + callBuy) — sell legs exit first
  async _exitPair(legKeys, reason) {
    // Sort: SELL legs first (exitPriority 1,2), BUY legs after (3,4)
    const sorted = [...legKeys].sort((a, b) => {
      const pa = this.position.legs[a]?.exitPriority || 99;
      const pb = this.position.legs[b]?.exitPriority || 99;
      return pa - pb;
    });

    for (const key of sorted) {
      if (this.position.legs[key]?.status !== 'ACTIVE') continue;
      await this._cancelLegOrders([key]);
      await this._exitSingleLeg(key, reason);
      await new Promise(r => setTimeout(r, 300));
    }

    this._updatePositionStatus();
  }

  // Exit a single leg with a MARKET order
  async _exitSingleLeg(key, reason) {
    const leg = this.position.legs[key];
    if (!leg || leg.status !== 'ACTIVE') return;

    // Determine transaction type to close this leg
    // BUY leg opened → close with SELL; SELL leg opened → close with BUY
    const closeAction = leg.action === 'BUY' ? 'SELL' : 'BUY';

    logger.info(`📤 Closing ${key} (${leg.symbol}) via ${closeAction} MARKET | Reason: ${reason}`);

    if (!PAPER_TRADE()) {
      try {
        await kiteService.placeOrderFull({
          exchange:         'BFO',
          tradingsymbol:    leg.symbol,
          transaction_type: closeAction,
          quantity:         20,
          product:          'NRML',
          order_type:       'MARKET',
          tag:              'DN_EXIT'
        });
      } catch (err) {
        logger.error(`❌ Exit order failed for ${key}: ${err.message}`);
      }
    }

    leg.status      = 'CLOSED';
    leg.closeReason = reason;
    leg.closeTime   = new Date().toLocaleTimeString('en-IN');
    leg.exitPremium = leg.currentPremium;
  }

  // After all exits, wrap up the position record
  async _closeEntirePosition(reason) {
    const totalPnl = Object.values(this.position.legs)
      .reduce((s, l) => s + (l?.pnl || 0), 0);

    this.position.pnl    = totalPnl;
    const closed = { ...this.position, closeReason: reason, status: 'CLOSED' };
    this.history.push(closed);
    this.position = this._emptyPosition();
    logger.info(`✅ Delta Neutral position fully closed | Reason: ${reason} | P&L: ₹${totalPnl.toFixed(0)}`);
    this.emitStatus();

    // Update MongoDB
    try {
      await Trade.findOneAndUpdate(
        { strategy: 'deltaneutral', status: 'ACTIVE' },
        { status: 'CLOSED', closeReason: reason, pnl: totalPnl, exitDate: new Date() }
      );
    } catch (err) {
      logger.error(`DB close update failed: ${err.message}`);
    }
  }

  _updatePositionStatus() {
    const legs = this.position.legs;
    const allClosed   = Object.values(legs).every(l => !l || l.status === 'CLOSED');
    const activeBuys  = ['callBuy', 'putBuy'].filter(k => legs[k]?.status === 'ACTIVE');
    const activeSells = ['callSell', 'putSell'].filter(k => legs[k]?.status === 'ACTIVE');

    if (allClosed) {
      this._closeEntirePosition('All Legs Exited');
    } else if (activeSells.length === 0 && activeBuys.length > 0) {
      this.position.status = 'PARTIAL'; // in trail mode
      this.position.lastBuyLeg = activeBuys[0];
    }
  }

  _nextThursday() {
    const d = new Date();
    const day = d.getDay();
    const daysUntilThursday = (4 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilThursday);
    return d.toLocaleDateString('en-IN');
  }

  async _saveToDB() {
    try {
      const legs = Object.entries(this.position.legs).map(([key, l]) => ({
        symbol:       l.symbol,
        type:         l.action,
        entryPremium: l.entryPremium,
        status:       'ACTIVE'
      }));
      await Trade.create({
        strategy:    'deltaneutral',
        index:       'SENSEX',
        entryPrice:  this.position.spotAtEntry,
        quantity:    20,
        isPaperTrade: PAPER_TRADE(),
        legs,
        status:      'ACTIVE',
        entryDate:   new Date()
      });
    } catch (err) {
      logger.error(`DB save failed: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC API (called by routes)
  // ─────────────────────────────────────────────────────────────
  async exitAll(reason) {
    if (this.position.status === 'IDLE') return;

    const legs = this.position.legs;
    const active = Object.keys(legs).filter(k => legs[k]?.status === 'ACTIVE');

    // Cancel all pending orders first
    await this._cancelLegOrders(active);
    await new Promise(r => setTimeout(r, 500));

    // Exit sell legs first, then buy legs
    const sells = active.filter(k => legs[k].action === 'SELL').sort((a,b) => legs[a].exitPriority - legs[b].exitPriority);
    const buys  = active.filter(k => legs[k].action === 'BUY').sort((a,b)  => legs[a].exitPriority - legs[b].exitPriority);

    for (const key of [...sells, ...buys]) {
      await this._exitSingleLeg(key, reason || 'MANUAL_EXIT');
      await new Promise(r => setTimeout(r, 300));
    }

    await this._closeEntirePosition(reason || 'MANUAL_EXIT');
  }

  async exitLegs(legKeys, reason) {
    if (!legKeys?.length) return;
    // Always exit sell legs in this set first
    const sells = legKeys.filter(k => this.position.legs[k]?.action === 'SELL');
    const buys  = legKeys.filter(k => this.position.legs[k]?.action === 'BUY');
    await this._cancelLegOrders(legKeys);
    await new Promise(r => setTimeout(r, 300));
    for (const key of [...sells, ...buys]) {
      await this._exitSingleLeg(key, reason || 'MANUAL_EXIT');
      await new Promise(r => setTimeout(r, 300));
    }
    this._updatePositionStatus();
    this.emitStatus();
  }

  getStatus() {
    return { running: this.running, position: this.position, history: this.history };
  }

  start() { this.running = true; this.emitStatus(); }
  stop()  { this.running = false; this.emitStatus(); }
  emitStatus() { this.io.emit('dn_status', { running: this.running, position: this.position }); }
}

module.exports = DeltaNeutralEngine;
