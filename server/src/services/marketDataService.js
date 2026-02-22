const MarketData = require('../models/MarketData');
const kiteService = require('./kiteService');
const logger = require('../utils/logger');
const moment = require('moment');

const SYMBOL_MAP = {
  'NIFTY':  256265, // NIFTY 50 Token
  'SENSEX': 265    // SENSEX Token
};

const downloadMarketHistory = async (index, interval = '3minute') => {
  try {
    const instrumentToken = SYMBOL_MAP[index];
    if (!instrumentToken) throw new Error("Instrument token not found");

    // Fetch data for today (9:15 to 15:30)
    const fromDate = moment().startOf('day').set({ hour: 9, minute: 15 }).toDate();
    const toDate   = moment().startOf('day').set({ hour: 15, minute: 30 }).toDate();

    const candles = await kiteService.kite.getHistoricalData(
      instrumentToken, 
      interval, 
      fromDate, 
      toDate
    );

    const bulkOps = candles.map(c => ({
      updateOne: {
        filter: { index, interval, date: c.date },
        update: { $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } },
        upsert: true
      }
    }));

    if (bulkOps.length > 0) {
      await MarketData.bulkWrite(bulkOps);
      logger.info(`✅ Successfully saved ${bulkOps.length} candles for ${index} into MongoDB`);
    }
  } catch (err) {
    logger.error(`❌ Error downloading history for ${index}: ${err.message}`);
  }
};

module.exports = { downloadMarketHistory };