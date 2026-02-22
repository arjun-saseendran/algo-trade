require('dotenv').config({ path: '../.env' });
const { KiteConnect } = require('kiteconnect');
const fs              = require('fs');
const path            = require('path');
const moment          = require('moment');

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN;
const API_KEY      = process.env.KITE_API_KEY;
const kite         = new KiteConnect({ api_key: API_KEY });
kite.setAccessToken(ACCESS_TOKEN);

const INSTRUMENTS = [
  { token: 256265, symbol: 'NIFTY_50', exchange: 'NSE' },
  { token: 265,    symbol: 'SENSEX',   exchange: 'BSE' },
];

const INTERVALS = [
  { name: 'day',      interval: 'day',      daysPerChunk: 1000 },
  { name: '15minute', interval: '15minute', daysPerChunk: 100  },
  { name: '5minute',  interval: '5minute',  daysPerChunk: 50   },
  { name: '3minute',  interval: '3minute',  daysPerChunk: 30   }, 
];

const START_DATE = '2021-01-01';
const END_DATE   = moment().format('YYYY-MM-DD');
const OUTPUT     = path.join(__dirname, '../data/historical');

async function download() {
  for (const instrument of INSTRUMENTS) {
    console.log(`\n📦 Fetching ${instrument.symbol}...`);

    for (const inter of INTERVALS) {
      console.log(`  🕒 Interval: ${inter.name}`);
      let allData = [];
      let currentStart = moment(START_DATE);
      const finalEnd   = moment(END_DATE);

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
          process.stdout.write(`    ✅ Chunk: ${currentStart.format('YYYY-MM-DD')} to ${currentEnd.format('YYYY-MM-DD')} (${chunk ? chunk.length : 0} candles)\r`);
          
        } catch (err) {
          // FIXED: We log the error but DO NOT break. Older data might be missing, 
          // but we still need to fetch the newer data chunks.
          process.stdout.write(`    ⚠️ Skipped: ${currentStart.format('YYYY-MM-DD')} (${err.message})\r`);
        }

        // FIXED: Always advance the loop and wait, regardless of success or API error
        await new Promise(res => setTimeout(res, 400));
        currentStart = moment(currentEnd).add(1, 'second');
      }

      if (allData.length > 0) {
        const dir = path.join(OUTPUT, instrument.exchange, instrument.symbol);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const jsonFile = path.join(dir, `${inter.name}.json`);
        fs.writeFileSync(jsonFile, JSON.stringify(allData, null, 2));
        console.log(`\n    💾 Saved ${allData.length} total candles to ${inter.name}.json`);
      } else {
        console.log(`\n    ❌ No data found for ${inter.name}.`);
      }
    }
  }
}

download().catch(console.error);