const moment = require('moment');
const kiteService = require('./kiteService');
const logger = require('../utils/logger');
const MarketData = require('../models/MarketData'); // 🚨 NEW: Import MongoDB Model

// 🚨 FIXED: Changed symbols to match exactly what your MongoDB Schema expects ('NIFTY' and 'SENSEX')
const INSTRUMENTS = [
  { token: 256265, symbol: 'NIFTY',  exchange: 'NSE' },
  { token: 265,    symbol: 'SENSEX', exchange: 'BSE' },
];

const INTERVALS = [
  { name: 'day',      interval: 'day',      daysPerChunk: 1000 },
  { name: '15minute', interval: '15minute', daysPerChunk: 100  },
  { name: '5minute',  interval: '5minute',  daysPerChunk: 50   },
  { name: '3minute',  interval: '3minute',  daysPerChunk: 30   }, 
];

const DEFAULT_START_DATE = '2021-01-01';
let isDownloading = false;

async function downloadHistoricalData() {
  if (isDownloading) {
    logger.warn("⚠️ Download is already in progress. Please wait.");
    return;
  }

  const kite = kiteService.kite;
  if (!kite || !kite.access_token) {
    logger.error('❌ Kite is not authenticated! Log in via the UI first.');
    return;
  }

  isDownloading = true;
  const END_DATE = moment().format('YYYY-MM-DD');

  try {
    for (const instrument of INSTRUMENTS) {
      logger.info(`\n📦 Fetching ${instrument.symbol} and saving to MongoDB...`);

      for (const inter of INTERVALS) {
        logger.info(`  🕒 Interval: ${inter.name}`);

        // DEDUPLICATION FIX: Find the latest date already stored for this symbol+interval
        // so we only download NEW data instead of re-fetching everything from 2021
        const latestRecord = await MarketData.findOne(
          { index: instrument.symbol, interval: inter.name },
          { date: 1 },
          { sort: { date: -1 } }
        ).lean();

        const startDate = latestRecord
          ? moment(latestRecord.date).add(1, 'minute') // start from next minute after last candle
          : moment(DEFAULT_START_DATE);

        if (startDate.isAfter(moment(END_DATE))) {
          logger.info(`    ✅ Already up to date for ${inter.name}`);
          continue;
        }

        logger.info(`    📅 Downloading from ${startDate.format('YYYY-MM-DD')} (latest in DB: ${latestRecord ? moment(latestRecord.date).format('YYYY-MM-DD') : 'none'})`);

        let allData = [];
        let currentStart = startDate;
        const finalEnd   = moment(END_DATE);

        // --- 1. FETCH DATA FROM ZERODHA ---
        while (currentStart.isBefore(finalEnd)) {
          let currentEnd = moment(currentStart).add(inter.daysPerChunk, 'days');
          if (currentEnd.isAfter(finalEnd)) currentEnd = finalEnd;

          try {
            const chunk = await kite.getHistoricalData(
              instrument.token,
              inter.interval,
              currentStart.toDate(),
              currentEnd.toDate()
            );

            if (chunk && chunk.length > 0) {
              allData.push(...chunk);
            }
            logger.info(`    ✅ Chunk: ${currentStart.format('YYYY-MM-DD')} to ${currentEnd.format('YYYY-MM-DD')} (${chunk ? chunk.length : 0} candles)`);
            
          } catch (err) {
            logger.warn(`    ⚠️ Skipped: ${currentStart.format('YYYY-MM-DD')} (${err.message})`);
          }

          // Rate limit protection
          await new Promise(res => setTimeout(res, 400));
          currentStart = moment(currentEnd).add(1, 'second');
        }

        // --- 2. SAVE DIRECTLY TO MONGODB ---
        if (allData.length > 0) {
          logger.info(`    ⏳ Preparing to save ${allData.length} candles to MongoDB...`);
          
          // Map Zerodha data format into MongoDB bulk write operations
          const bulkOps = allData.map(c => ({
            updateOne: {
              filter: { index: instrument.symbol, interval: inter.name, date: c.date },
              update: { $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } },
              upsert: true
            }
          }));

          // BATCH EXECUTION: MongoDB will crash if you try to upsert 150,000 records at the exact same millisecond. 
          // We slice them into batches of 5,000.
          const BATCH_SIZE = 5000;
          for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
            const batch = bulkOps.slice(i, i + BATCH_SIZE);
            await MarketData.bulkWrite(batch);
          }

          logger.info(`    💾 Successfully saved ${allData.length} candles to MongoDB for ${inter.name}`);
        } else {
          logger.warn(`    ❌ No data found for ${inter.name}.`);
        }
      }
    }
    logger.info("🎉 All historical data downloaded and saved to MongoDB successfully!");
  } catch (error) {
    logger.error(`❌ Download failed: ${error.message}`);
  } finally {
    isDownloading = false;
  }
}

module.exports = { downloadHistoricalData };