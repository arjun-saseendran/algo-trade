const moment = require('moment');
const logger = require('../utils/logger');
const Trade  = require('../models/Trades'); // Import the new Model

const CONFIG = {
  SENSEX: {
    SYMBOL: 'SENSEX', EXCHANGE: 'BFO', LOT_SIZE: 20,
    ENTRY_DAY: 5, ENTRY_TIME: '15:20', EXIT_DAY: 1, EXIT_TIME: '15:20',
    OTM_DISTANCE: 200, STRIKE_STEP: 100
  },
  RULES: {
    LEG_SL_PCT: 0.60, NET_SL_PCT: 0.60,
    TRAIL: { STEP: 50, FIRST_LOCK: 12.5, NEXT_LOCK: 37.5 }
  }
};

class DeltaNeutralStrategy {
  constructor() {
    this.positions = { SENSEX: this.emptyPosition('SENSEX') };
  }

  emptyPosition(index) {
    return {
      index, status: 'IDLE', entryDate: null, spotAtEntry: 0, dbId: null,
      legs: { callBuy: null, callSell: null, putBuy: null, putSell: null },
      netPremiumPaid: 0, currentMTM: 0, pnl: 0, alerts: []
    };
  }

  // ... (isEntryTime and isExitTime methods remain same) ...

  async openPosition(index, foundLegs, spotPrice) {
    const pos = this.emptyPosition(index);
    pos.status = 'ACTIVE';
    pos.entryDate = moment().format('YYYY-MM-DD HH:mm');
    pos.spotAtEntry = spotPrice;

    const legArray = [];
    for (const [key, leg] of Object.entries(foundLegs)) {
      pos.legs[key] = {
        symbol: leg.tradingsymbol, strike: leg.strike, type: key.includes('Buy') ? 'BUY' : 'SELL',
        entryPremium: leg.last_price, currentPremium: leg.last_price, peakPremium: leg.last_price,
        trailSL: null, pnl: 0, status: 'ACTIVE'
      };
      legArray.push({
        symbol: leg.tradingsymbol, type: pos.legs[key].type, entryPremium: leg.last_price, status: 'ACTIVE'
      });
    }

    pos.netPremiumPaid = (pos.legs.callBuy.entryPremium + pos.legs.putBuy.entryPremium) - 
                         (pos.legs.callSell.entryPremium + pos.legs.putSell.entryPremium);

    // SAVE TO MONGODB
    try {
      const dbTrade = new Trade({
        strategy: 'deltaNeutral',
        index: index,
        entryPrice: spotPrice,
        quantity: CONFIG[index].LOT_SIZE,
        legs: legArray,
        isPaperTrade: process.env.PAPER_TRADE === 'true'
      });
      const saved = await dbTrade.save();
      pos.dbId = saved._id; // Store ID for engine updates
    } catch (err) { logger.error("DB Save Error at Open:", err); }

    this.positions[index] = pos;
    return pos;
  }

  // ... (calculateTrailSL and checkConditions methods remain same) ...

  async updateMTM(index, livePremiums) {
    const pos = this.positions[index];
    if (!pos || pos.status !== 'ACTIVE') return null;

    let totalMTM = 0;
    for (const [key, leg] of Object.entries(pos.legs)) {
      if (leg.status === 'ACTIVE' && livePremiums[leg.symbol]) {
        leg.currentPremium = livePremiums[leg.symbol];
        leg.pnl = leg.type === 'BUY' ? leg.currentPremium - leg.entryPremium : leg.entryPremium - leg.currentPremium;
        if (leg.type === 'BUY' && leg.currentPremium > leg.peakPremium) leg.peakPremium = leg.currentPremium;
      }
      totalMTM += leg.pnl;
    }

    pos.currentMTM = totalMTM * CONFIG[index].LOT_SIZE;
    pos.pnl = pos.currentMTM;

    // Async Update PnL to DB periodically (Roughly every 5 mins or on alert)
    if (pos.dbId && Math.random() > 0.95) {
      Trade.findByIdAndUpdate(pos.dbId, { pnl: pos.pnl }).catch(() => {});
    }

    return { position: pos, alerts: this.checkConditions(index) };
  }
}

module.exports = DeltaNeutralStrategy;