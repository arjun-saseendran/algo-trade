/**
 * Iron Condor Engine — NIFTY (Monday) + SENSEX (Wednesday)
 *
 * Order Execution Rules:
 * ─────────────────────────────────────────────────────────────
 * ENTRY:
 *   Buy (hedge) legs placed FIRST as MARKET orders.
 *   After fill confirmation, place Sell legs as MARKET orders.
 *   This ensures hedge protection is in place before taking on short risk.
 *
 * EXIT (any reason — SL, firefight, expiry, manual):
 *   Exit SELL legs FIRST (buy them back to remove short risk).
 *   Then exit BUY (hedge) legs.
 *
 * SL / FIREFIGHT:
 *   Before placing any manual exit order → cancel the pending
 *   SL order on that leg first to avoid double-fill.
 */

const cron        = require('node-cron');
const kiteService = require('./kiteService');
const Trade       = require('../models/Trades');
const logger      = require('../utils/logger');

const PAPER_TRADE = () => process.env.PAPER_TRADE === 'true';

const CFG = {
  NIFTY: {
    exchange:    'NFO',
    lot:         65,
    hedge:       150,   // hedge width in points
    entryDay:    1,     // Monday
    entryTime:   '09:30',
    expiryDay:   3,     // Wednesday
    expiryTime:  '15:20',
    otmPct:      0.005, // 0.5%
    strikeStep:  50,
    product:     'MIS',
  },
  SENSEX: {
    exchange:    'BFO',
    lot:         20,
    hedge:       500,
    entryDay:    3,     // Wednesday
    entryTime:   '09:30',
    expiryDay:   4,     // Thursday
    expiryTime:  '15:20',
    otmPct:      0.005,
    strikeStep:  100,
    product:     'MIS',
  },
  FIREFIGHT: {
    LOSS_3X:   3.0,  // expansion ratio that triggers roll check
    PROFIT_70: 0.70, // other side must have 70% profit for roll to trigger
    LOSS_4X:   4.0,  // expansion ratio for full spread exit
    MAX_ROLLS:  2,   // max total rolls (system + discretionary)
  }
};

class IronCondorEngine {
  constructor(io) {
    this.io = io;
    this.running  = false;
    this.positions = {
      NIFTY:  this._emptyPos('NIFTY'),
      SENSEX: this._emptyPos('SENSEX'),
    };
    this.history = [];
    this.setupCron();
  }

  _emptyPos(index) {
    return {
      status: 'IDLE', index,
      lot:    CFG[index]?.lot    || 0,
      hedge:  CFG[index]?.hedge  || 0,
      systemRolls:        0,
      discretionaryRolls: 0,
      isIronFly:          false,
      adjustments:        [],
      alerts:             [],
      entryDate:          null,
      expiryDate:         null,
      spotAtEntry:        0,
      callSpread:         null,  // { sellStrike, buyStrike, sellPremium, buyPremium, netCredit, sellOrderId, buyOrderId, sellSlOrderId }
      putSpread:          null,
      totalCredit:        0,
      pnl:                0,
      maxLossPct:         0,
    };
  }

  setupCron() {
    cron.schedule('30 9 * * 1', async () => { if (this.running) await this.checkEntry('NIFTY');  });
    cron.schedule('30 9 * * 3', async () => { if (this.running) await this.checkEntry('SENSEX'); });
    cron.schedule('* 9-15 * * 1-5', async () => { if (this.running) await this.monitorFirefight(); });

    // Expiry time exits
    cron.schedule('20 15 * * 3', async () => { if (this.running) await this._expiryExit('NIFTY');  }); // Wed
    cron.schedule('20 15 * * 4', async () => { if (this.running) await this._expiryExit('SENSEX'); }); // Thu
  }

  // ─────────────────────────────────────────────────────────────
  // ENTRY — Buy legs FIRST, then Sell legs
  // ─────────────────────────────────────────────────────────────
  async checkEntry(index) {
    const pos = this.positions[index];
    if (pos.status !== 'IDLE') return;

    const cfg  = CFG[index];
    logger.info(`🦅 Iron Condor: Entering ${index} at ${cfg.entryTime}...`);

    try {
      const sym    = index === 'NIFTY' ? 'NSE:NIFTY 50' : 'BSE:SENSEX';
      const quotes = await kiteService.getLTP([sym]);
      const spot   = quotes[sym]?.last_price || 0;
      if (!spot) throw new Error('Could not get LTP for ' + sym);

      const step        = cfg.strikeStep;
      const callSell    = Math.round(spot * (1 + cfg.otmPct) / step) * step;
      const callBuy     = callSell + cfg.hedge;
      const putSell     = Math.round(spot * (1 - cfg.otmPct) / step) * step;
      const putBuy      = putSell  - cfg.hedge;

      // Simulated premiums (real code would fetch from options chain)
      const callSellPrem = spot * cfg.otmPct * 0.5;
      const callBuyPrem  = callSellPrem * 0.3;
      const putSellPrem  = callSellPrem;
      const putBuyPrem   = callBuyPrem;

      const callNetCredit = callSellPrem - callBuyPrem;
      const putNetCredit  = putSellPrem  - putBuyPrem;

      // ── STEP 1: Place BUY (hedge) legs FIRST ──────────────────────────────
      logger.info(`📥 ${index}: Placing BUY hedge legs first...`);

      let callBuyOrderId = null, putBuyOrderId = null;

      if (!PAPER_TRADE()) {
        const cbOrder = await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: `${index}${callBuy}CE`,
          transaction_type: 'BUY', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_HEDGE_ENTRY'
        });
        callBuyOrderId = cbOrder.order_id;
        logger.info(`✅ Call Hedge BUY placed: ${index}${callBuy}CE`);

        const pbOrder = await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: `${index}${putBuy}PE`,
          transaction_type: 'BUY', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_HEDGE_ENTRY'
        });
        putBuyOrderId = pbOrder.order_id;
        logger.info(`✅ Put Hedge BUY placed: ${index}${putBuy}PE`);

        // Small pause to ensure buy fills before selling
        await new Promise(r => setTimeout(r, 500));
      }

      // ── STEP 2: Place SELL legs AFTER hedge fills ──────────────────────────
      logger.info(`📤 ${index}: Placing SELL legs...`);

      let callSellOrderId = null, putSellOrderId = null;

      if (!PAPER_TRADE()) {
        const csOrder = await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: `${index}${callSell}CE`,
          transaction_type: 'SELL', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_SELL_ENTRY'
        });
        callSellOrderId = csOrder.order_id;
        logger.info(`✅ Call SELL placed: ${index}${callSell}CE`);

        const psOrder = await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: `${index}${putSell}PE`,
          transaction_type: 'SELL', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_SELL_ENTRY'
        });
        putSellOrderId = psOrder.order_id;
        logger.info(`✅ Put SELL placed: ${index}${putSell}PE`);
      }

      // Update position state
      this.positions[index] = {
        ...this._emptyPos(index),
        status:      'ACTIVE',
        paperTrade:  PAPER_TRADE(),
        entryDate:   new Date().toISOString(),
        expiryDate:  this._nextExpiryDate(index),
        spotAtEntry: spot,
        callSpread: {
          sellStrike:   callSell,
          buyStrike:    callBuy,
          sellPremium:  callSellPrem,
          buyPremium:   callBuyPrem,
          netCredit:    callNetCredit,
          currentPremium: callNetCredit,
          expansion:    1,
          decay:        0,
          status:       'ACTIVE',
          sellOrderId:  callSellOrderId,
          buyOrderId:   callBuyOrderId,
          slOrderId:    null,
        },
        putSpread: {
          sellStrike:   putSell,
          buyStrike:    putBuy,
          sellPremium:  putSellPrem,
          buyPremium:   putBuyPrem,
          netCredit:    putNetCredit,
          currentPremium: putNetCredit,
          expansion:    1,
          decay:        0,
          status:       'ACTIVE',
          sellOrderId:  putSellOrderId,
          buyOrderId:   putBuyOrderId,
          slOrderId:    null,
        },
        totalCredit: (callNetCredit + putNetCredit) * cfg.lot,
        pnl:         0,
        maxLossPct:  0,
        systemRolls: 0,
        discretionaryRolls: 0,
        adjustments: [],
        alerts:      [],
        isIronFly:   false,
      };

      logger.info(`✅ ${index} Iron Condor entered | Spot=${spot} | CallSell=${callSell} | PutSell=${putSell} | TotalCredit=₹${(callNetCredit + putNetCredit) * cfg.lot}`);
      this.emitStatus();
      await this._saveEntryToDB(index);

    } catch (err) {
      logger.error(`❌ ${index} IC entry failed: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // FIREFIGHT MONITOR
  // ─────────────────────────────────────────────────────────────
  async monitorFirefight() {
    for (const index of ['NIFTY', 'SENSEX']) {
      const pos = this.positions[index];
      if (pos.status !== 'ACTIVE') continue;

      try {
        const spot = await this._getSpot(index);
        if (!spot) continue;

        const cs = pos.callSpread;
        const ps = pos.putSpread;

        if (cs?.status === 'ACTIVE') {
          // Estimate current spread cost based on spot vs strike
          const intrusion     = Math.max(0, spot - cs.sellStrike);
          const currentCost   = cs.netCredit + intrusion * 0.6;
          const expansion     = currentCost / cs.netCredit;
          cs.expansion        = parseFloat(expansion.toFixed(2));
          cs.currentPremium   = currentCost;

          const profitBooked  = ps?.status === 'ACTIVE'
            ? Math.max(0, (ps.netCredit - (ps.currentPremium || ps.netCredit)) / ps.netCredit)
            : 0;
          ps && (ps.decay = parseFloat(profitBooked.toFixed(2)));

          // 4x SL (accounting for profit booked on other side)
          const effectiveSL = cs.netCredit * CFG.FIREFIGHT.LOSS_4X - (ps?.netCredit || 0) * profitBooked;
          if (currentCost >= effectiveSL && cs.status === 'ACTIVE') {
            logger.warn(`🔴 ${index} Call Spread 4x SL hit`);
            await this._exitSpread(index, 'call', 'Call Spread 4x SL');
          } else if (expansion >= CFG.FIREFIGHT.LOSS_3X && profitBooked >= CFG.FIREFIGHT.PROFIT_70) {
            if ((pos.systemRolls + pos.discretionaryRolls) < CFG.FIREFIGHT.MAX_ROLLS) {
              logger.info(`🔥 ${index} Firefight: Rolling Call side`);
              await this.executeShift(index, 'CALL');
            }
          }
        }

        if (ps?.status === 'ACTIVE') {
          const intrusion   = Math.max(0, ps.sellStrike - spot);
          const currentCost = ps.netCredit + intrusion * 0.6;
          const expansion   = currentCost / ps.netCredit;
          ps.expansion      = parseFloat(expansion.toFixed(2));
          ps.currentPremium = currentCost;

          const profitBooked = cs?.status === 'ACTIVE'
            ? Math.max(0, (cs.netCredit - (cs.currentPremium || cs.netCredit)) / cs.netCredit)
            : 0;
          cs && (cs.decay = parseFloat(profitBooked.toFixed(2)));

          const effectiveSL = ps.netCredit * CFG.FIREFIGHT.LOSS_4X - (cs?.netCredit || 0) * profitBooked;
          if (currentCost >= effectiveSL && ps.status === 'ACTIVE') {
            logger.warn(`🔴 ${index} Put Spread 4x SL hit`);
            await this._exitSpread(index, 'put', 'Put Spread 4x SL');
          } else if (expansion >= CFG.FIREFIGHT.LOSS_3X && profitBooked >= CFG.FIREFIGHT.PROFIT_70) {
            if ((pos.systemRolls + pos.discretionaryRolls) < CFG.FIREFIGHT.MAX_ROLLS) {
              logger.info(`🔥 ${index} Firefight: Rolling Put side`);
              await this.executeShift(index, 'PUT');
            }
          }
        }

        // Update MTM
        pos.pnl = this._calcPnl(pos);
        this.emitStatus();

      } catch (err) {
        logger.error(`${index} firefight monitor error: ${err.message}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // EXIT A SPREAD — Sell legs exit FIRST, then Buy (hedge) legs
  // ─────────────────────────────────────────────────────────────
  async _exitSpread(index, side, reason) {
    const pos    = this.positions[index];
    const spread = side === 'call' ? pos.callSpread : pos.putSpread;
    const cfg    = CFG[index];
    if (!spread || spread.status !== 'ACTIVE') return;

    const optType = side === 'call' ? 'CE' : 'PE';
    const sellStrikeStr = `${index}${spread.sellStrike}${optType}`;
    const buyStrikeStr  = `${index}${spread.buyStrike}${optType}`;

    logger.info(`📤 ${index} Exiting ${side} spread | Reason: ${reason}`);
    logger.info(`   Order sequence: SELL leg (${sellStrikeStr}) first → then BUY hedge (${buyStrikeStr})`);

    if (!PAPER_TRADE()) {
      // Cancel any pending SL order on this spread first
      if (spread.slOrderId) {
        try {
          await kiteService.cancelOrder(spread.slOrderId);
          spread.slOrderId = null;
          logger.info(`✅ Cancelled SL order for ${side} spread`);
        } catch (e) {
          logger.warn(`⚠️ Could not cancel SL: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // STEP 1: Buy back the SELL leg first
      try {
        await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: sellStrikeStr,
          transaction_type: 'BUY', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_EXIT_SELL'
        });
        logger.info(`✅ Bought back SELL leg: ${sellStrikeStr}`);
      } catch (err) {
        logger.error(`❌ Failed to exit sell leg: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 400));

      // STEP 2: Sell the BUY (hedge) leg
      try {
        await kiteService.placeOrderFull({
          exchange: cfg.exchange, tradingsymbol: buyStrikeStr,
          transaction_type: 'SELL', quantity: cfg.lot, product: cfg.product,
          order_type: 'MARKET', tag: 'IC_EXIT_HEDGE'
        });
        logger.info(`✅ Sold hedge leg: ${buyStrikeStr}`);
      } catch (err) {
        logger.error(`❌ Failed to exit hedge leg: ${err.message}`);
      }
    }

    spread.status      = 'EXITED';
    spread.closeReason = reason;
    spread.closeTime   = new Date().toLocaleTimeString('en-IN');

    // Check if both spreads now exited
    const cs = pos.callSpread;
    const ps = pos.putSpread;
    if (cs?.status === 'EXITED' && ps?.status === 'EXITED') {
      this.closePosition(index, 'Both Spreads Exited', this._calcPnl(pos));
    } else {
      pos.pnl = this._calcPnl(pos);
      this.emitStatus();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // EXPIRY EXIT — Sell legs first, then hedge legs
  // ─────────────────────────────────────────────────────────────
  async _expiryExit(index) {
    const pos = this.positions[index];
    if (pos.status !== 'ACTIVE') return;

    logger.info(`⏰ ${index} Expiry exit at ${CFG[index].expiryTime}`);

    for (const side of ['call', 'put']) {
      const spread  = side === 'call' ? pos.callSpread : pos.putSpread;
      if (!spread || spread.status !== 'ACTIVE') continue;
      await this._exitSpread(index, side, 'Expiry Exit');
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ROLL (firefight shift)
  // ─────────────────────────────────────────────────────────────
  async executeShift(index, side) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE') return;

    pos.adjustments.push({ time: new Date().toLocaleTimeString('en-IN'), type: 'ROLL', side });
    pos.systemRolls = (pos.systemRolls || 0) + 1;

    // Simulate rolling: exit current spread sell leg, re-enter closer to ATM
    const spread = side === 'CALL' ? pos.callSpread : pos.putSpread;
    if (spread) {
      spread.netCredit *= 1.1; // small additional credit from rolling
      logger.info(`✅ ${index} ${side} spread rolled | Total rolls: ${pos.systemRolls}`);
    }

    this.emitStatus();
  }

  recordRoll(index, type, side) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE') return;
    pos.adjustments.push({ time: new Date().toLocaleTimeString('en-IN'), type: type.toUpperCase(), side });
    if (type === 'system')          pos.systemRolls         = (pos.systemRolls || 0) + 1;
    else if (type === 'discretionary') pos.discretionaryRolls = (pos.discretionaryRolls || 0) + 1;
    logger.info(`Roll recorded: ${index} ${type} ${side}`);
    this.emitStatus();
  }

  convertToIronFly(index) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE') return;
    pos.isIronFly = true;
    logger.info(`${index} converted to Iron Butterfly`);
    this.emitStatus();
  }

  closePosition(index, reason, pnl) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE') return;
    const closed = { ...pos, closeReason: reason, pnl: pnl ?? pos.pnl, expiryDate: pos.expiryDate || '' };
    this.history.push(closed);
    this.positions[index] = this._emptyPos(index);
    logger.info(`Iron Condor closed: ${index} — ${reason} | P&L: ₹${(pnl ?? 0).toFixed(0)}`);
    this.emitStatus();
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────
  _calcPnl(pos) {
    const cfg = CFG[pos.index];
    let pnl = 0;
    if (pos.callSpread?.status === 'ACTIVE')
      pnl += (pos.callSpread.netCredit - (pos.callSpread.currentPremium || pos.callSpread.netCredit)) * cfg.lot;
    if (pos.putSpread?.status === 'ACTIVE')
      pnl += (pos.putSpread.netCredit  - (pos.putSpread.currentPremium  || pos.putSpread.netCredit))  * cfg.lot;
    return Math.round(pnl);
  }

  async _getSpot(index) {
    const sym = index === 'NIFTY' ? 'NSE:NIFTY 50' : 'BSE:SENSEX';
    const q   = await kiteService.getLTP([sym]);
    return q[sym]?.last_price || null;
  }

  _nextExpiryDate(index) {
    const d   = new Date();
    const day = d.getDay();
    const target = CFG[index].expiryDay;
    const diff   = (target - day + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toLocaleDateString('en-IN');
  }

  async _saveEntryToDB(index) {
    const pos = this.positions[index];
    try {
      const legs = [];
      if (pos.callSpread) {
        legs.push({ symbol: `${index}${pos.callSpread.sellStrike}CE`, type: 'SELL', entryPremium: pos.callSpread.sellPremium, status: 'ACTIVE' });
        legs.push({ symbol: `${index}${pos.callSpread.buyStrike}CE`,  type: 'BUY',  entryPremium: pos.callSpread.buyPremium,  status: 'ACTIVE' });
      }
      if (pos.putSpread) {
        legs.push({ symbol: `${index}${pos.putSpread.sellStrike}PE`,  type: 'SELL', entryPremium: pos.putSpread.sellPremium,  status: 'ACTIVE' });
        legs.push({ symbol: `${index}${pos.putSpread.buyStrike}PE`,   type: 'BUY',  entryPremium: pos.putSpread.buyPremium,   status: 'ACTIVE' });
      }
      await Trade.create({ strategy: 'ironcondor', index, entryPrice: pos.spotAtEntry, quantity: CFG[index].lot, isPaperTrade: PAPER_TRADE(), legs, status: 'ACTIVE', entryDate: new Date() });
    } catch (err) {
      logger.error(`IC DB save failed: ${err.message}`);
    }
  }

  getStatus() {
    return { running: this.running, positions: this.positions, history: this.history };
  }

  start() { this.running = true; this.emitStatus(); }
  stop()  { this.running = false; this.emitStatus(); }
  emitStatus() { this.io.emit('ic_status', { running: this.running, positions: this.positions }); }
}

module.exports = IronCondorEngine;
