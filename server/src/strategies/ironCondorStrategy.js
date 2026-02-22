const moment = require('moment');
const logger = require('../utils/logger');
const Trade  = require('../models/Trades'); // Import the Trade Model

const CONFIG = {
  CAPITAL: 100000,
  NIFTY:  { SYMBOL: 'NIFTY',  EXCHANGE: 'NFO', LOT_SIZE: 65, ENTRY_DAY: 1, ENTRY_TIME: '09:30', EXPIRY_DAY: 2, HEDGE_WIDTH: 150, TARGET_SPREAD_CR: 7.7,  STRIKE_STEP: 50 },
  SENSEX: { SYMBOL: 'SENSEX', EXCHANGE: 'BFO', LOT_SIZE: 20, ENTRY_DAY: 3, ENTRY_TIME: '09:30', EXPIRY_DAY: 4, HEDGE_WIDTH: 500, TARGET_SPREAD_CR: 25.0, STRIKE_STEP: 100 },
  FIREFIGHT: { LOSS_3X: 3.0, PROFIT_70: 0.70, LOSS_4X: 4.0, IRON_FLY_MTM_SL: -0.02, MAX_LOSS_HOLD: -0.06 }
};

class IronCondorStrategy {
  constructor() {
    this.positions = {
      NIFTY:  this.emptyPosition('NIFTY'),
      SENSEX: this.emptyPosition('SENSEX'),
    };
  }

  emptyPosition(index) {
    return {
      index, status: 'IDLE', entryDate: null, spotAtEntry: 0, dbId: null,
      callSpread: null, putSpread: null,
      totalCredit: 0, currentMTM: 0, pnl: 0,
      bufferForCall: 0, bufferForPut: 0,
      isIronFly: false, isHeldToExpiry: false, alerts: [],
    };
  }

  // ... (isEntryDay and findBestSpread remain same) ...

  async openPosition(index, callSpread, putSpread, spotPrice) {
    const pos = this.emptyPosition(index);
    pos.status = 'ACTIVE';
    pos.entryDate = moment().format('YYYY-MM-DD HH:mm');
    pos.spotAtEntry = spotPrice;
    pos.callSpread = { ...callSpread, status: 'ACTIVE', initialCredit: callSpread.netCredit, pnl: 0 };
    pos.putSpread  = { ...putSpread,  status: 'ACTIVE', initialCredit: putSpread.netCredit,  pnl: 0 };
    pos.totalCredit = callSpread.netCredit + putSpread.netCredit;

    // SAVE TO MONGODB
    try {
      const dbTrade = new Trade({
        strategy: 'ironCondor',
        index: index,
        entryPrice: spotPrice,
        quantity: CONFIG[index].LOT_SIZE,
        isPaperTrade: process.env.PAPER_TRADE === 'true',
        legs: [
          { symbol: callSpread.sellSymbol, type: 'SELL', entryPremium: callSpread.sellPremium, status: 'ACTIVE' },
          { symbol: callSpread.buySymbol,  type: 'BUY',  entryPremium: callSpread.buyPremium,  status: 'ACTIVE' },
          { symbol: putSpread.sellSymbol,  type: 'SELL', entryPremium: putSpread.sellPremium,  status: 'ACTIVE' },
          { symbol: putSpread.buySymbol,   type: 'BUY',  entryPremium: putSpread.buyPremium,   status: 'ACTIVE' }
        ]
      });
      const saved = await dbTrade.save();
      pos.dbId = saved._id;
    } catch (err) { logger.error("IC DB Save Error:", err); }

    this.positions[index] = pos;
    return pos;
  }

  async updateMTM(index, last5MinClose, currentPremiums) {
    const pos = this.positions[index];
    if (!pos || pos.status === 'IDLE' || pos.status === 'CLOSED') return null;

    const callNetDebit = pos.callSpread.status === 'ACTIVE' ? (currentPremiums.callSell - currentPremiums.callBuy) : 0;
    const putNetDebit  = pos.putSpread.status === 'ACTIVE'  ? (currentPremiums.putSell - currentPremiums.putBuy) : 0;

    pos.currentMTM = (pos.callSpread.status === 'ACTIVE' ? (pos.callSpread.initialCredit - callNetDebit) * CONFIG[index].LOT_SIZE : pos.callSpread.pnl) + 
                     (pos.putSpread.status === 'ACTIVE'  ? (pos.putSpread.initialCredit - putNetDebit) * CONFIG[index].LOT_SIZE : pos.putSpread.pnl);
    pos.pnl = pos.currentMTM;

    // Periodic DB Sync
    if (pos.dbId && Math.random() > 0.95) {
      Trade.findByIdAndUpdate(pos.dbId, { pnl: pos.pnl }).catch(() => {});
    }

    const alerts = this.checkFirefightTriggers(index, last5MinClose, callNetDebit, putNetDebit);
    return { position: pos, alerts };
  }

  // ... (checkFirefightTriggers, recordRoll, reEnterSpread remain same) ...
}

module.exports = IronCondorStrategy;