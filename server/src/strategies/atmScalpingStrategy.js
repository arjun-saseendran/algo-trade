const moment = require('moment');
const logger = require('../utils/logger');
const Trade  = require('../models/Trades'); // Import the Trade Model

const CONFIG = {
  NIFTY: {
    SYMBOL: 'NIFTY', EXCHANGE: 'NFO', LOT_SIZE: 65, STRIKE_STEP: 50,
    MAX_RANGE: 30, EXIT_TIME: '15:21'
  }
};

class AtmScalpingStrategy {
  constructor() {
    this.positions = { NIFTY: this.emptyPosition('NIFTY') };
  }

  emptyPosition(index) {
    return {
      index, status: 'IDLE', side: null, entryPrice: 0, dbId: null,
      slPrice: 0, trailLocked: false, pnl: 0,
      instrument: null, entryTime: null
    };
  }

  checkSetup(candles) {
    if (candles.length < 3) return null; 
    const c1 = candles[candles.length - 2]; 
    const c2 = candles[candles.length - 1]; 

    const c1Green = c1.close > c1.open;
    const c2Green = c2.close > c2.open;
    if (c1Green === c2Green) return null;

    const high = Math.max(c1.high, c2.high);
    const low = Math.min(c1.low, c2.low);
    const range = high - low;

    return range <= CONFIG.NIFTY.MAX_RANGE ? { high, low, range } : null;
  }

  async openPosition(index, side, entryPrice, slPrice, instrument) {
    const pos = this.positions[index];
    pos.status = 'ACTIVE';
    pos.side = side;
    pos.entryPrice = entryPrice;
    pos.slPrice = slPrice;
    pos.instrument = instrument;
    pos.entryTime = moment().format('YYYY-MM-DD HH:mm');

    // SAVE TO MONGODB
    try {
      const dbTrade = new Trade({
        strategy: 'atmScalp',
        index: index,
        entryPrice: entryPrice,
        quantity: CONFIG[index].LOT_SIZE,
        isPaperTrade: process.env.PAPER_TRADE === 'true',
        legs: [{
          symbol: instrument.tradingsymbol,
          type: 'BUY',
          entryPremium: entryPrice,
          status: 'ACTIVE'
        }]
      });
      const saved = await dbTrade.save();
      pos.dbId = saved._id;
    } catch (err) { logger.error("Scalp DB Save Error:", err); }

    return pos;
  }

  updateMTM(index, optionLTP) {
    const pos = this.positions[index];
    if (pos.status !== 'ACTIVE') return null;

    pos.pnl = (optionLTP - pos.entryPrice) * CONFIG[index].LOT_SIZE;
    const alerts = [];
    const pointsGained = optionLTP - pos.entryPrice;
    const risk = Math.abs(pos.entryPrice - pos.slPrice);

    if (moment().format('HH:mm') >= CONFIG[index].EXIT_TIME) {
      alerts.push({ action: 'EXIT', reason: '🕒 3:21 PM Time Exit' });
    }
    if (optionLTP <= pos.slPrice && !pos.trailLocked) {
      alerts.push({ action: 'EXIT', reason: '🚨 Stop Loss Hit' });
    }
    if (!pos.trailLocked && pointsGained >= (risk * 3)) {
      pos.trailLocked = true;
      pos.slPrice = pos.entryPrice + (risk * 3);
      logger.info(`🏆 1:3 Locked at ${pos.slPrice}`);
    }
    if (pos.trailLocked && optionLTP <= pos.slPrice) {
      alerts.push({ action: 'EXIT', reason: '💰 Trailing Profit Hit' });
    }

    // Periodic DB Sync
    if (pos.dbId && Math.random() > 0.9) {
      Trade.findByIdAndUpdate(pos.dbId, { pnl: pos.pnl }).catch(() => {});
    }

    return { position: pos, alerts };
  }
}

module.exports = AtmScalpingStrategy;