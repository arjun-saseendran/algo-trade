require('dotenv').config({ path: '../.env' });
const { KiteConnect } = require('kiteconnect');
const fs              = require('fs');
const path            = require('path');
const moment          = require('moment');

// ─────────────────────────────────────────
// CONFIG — Edit these
// ─────────────────────────────────────────
const ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || 'paste_your_token_here';

const INSTRUMENTS = [
  // NSE Indices
  { token: 256265,  symbol: 'NIFTY_50',     exchange: 'NSE' },
  { token: 260105,     symbol: 'NIFTY_BANK',   exchange: 'NSE' },
  // BSE Indices
  { token: 265,       symbol: 'SENSEX',        exchange: 'BSE' },
  // Add more as needed:
  // { token: 738561, symbol: 'RELIANCE', exchange: 'NSE' },
  // { token: 408065, symbol: 'HDFCBANK', exchange: 'NSE' },
];

const INTERVALS = [
  { name: 'day',      interval: 'day'     },
  { name: '15minute', interval: '15minute' },
  { name: '5minute', interval: '5minute' },
  { name: '3minute', interval: '3minute' },
  // Add more if needed:
  // { name: '5minute',  interval: '5minute'  },
  // { name: '60minute', interval: '60minute' },
];

const YEARS    = 5;
const OUTPUT   = path.join(__dirname, '../data/historical');

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function chunkDateRange(fromDate, toDate, chunkDays) {
  const chunks = [];
  let current  = moment(fromDate);
  const end    = moment(toDate);

  while (current.isBefore(end)) {
    const chunkEnd = moment(current).add(chunkDays, 'days');
    chunks.push({
      from: current.format('YYYY-MM-DD HH:mm:ss'),
      to:   (chunkEnd.isAfter(end) ? end : chunkEnd).format('YYYY-MM-DD HH:mm:ss'),
    });
    current = chunkEnd;
  }
  return chunks;
}

function saveToCSV(data, filePath) {
  if (!data || data.length === 0) return;

  const headers = 'date,open,high,low,close,volume\n';
  const rows    = data.map(c =>
    `${c.date},${c.open},${c.high},${c.low},${c.close},${c.volume || 0}`
  ).join('\n');

  fs.writeFileSync(filePath, headers + rows);
}

function saveToJSON(data, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────
// MAIN DOWNLOAD
// ─────────────────────────────────────────
async function downloadHistorical() {
  // Setup Kite
  const kite = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  kite.setAccessToken(ACCESS_TOKEN);

  // Create output directories
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  const toDate   = moment().format('YYYY-MM-DD HH:mm:ss');
  const fromDate = moment().subtract(YEARS, 'years').format('YYYY-MM-DD HH:mm:ss');

  console.log(`📅 Downloading ${YEARS} years: ${fromDate} → ${toDate}`);
  console.log(`📊 Instruments: ${INSTRUMENTS.length}`);
  console.log(`⏱️  Intervals: ${INTERVALS.map(i => i.name).join(', ')}\n`);

  let totalFiles = 0;
  let errors     = 0;

  for (const instrument of INSTRUMENTS) {
    for (const intervalConfig of INTERVALS) {

      console.log(`\n⬇️  ${instrument.symbol} | ${intervalConfig.name}`);

      // Chunk requests — Kite limits per request
      // Day: can fetch years at once
      // Intraday: max 60 days per request
      const chunkDays = intervalConfig.name === 'day' ? 365 : 60;
      const chunks    = chunkDateRange(fromDate, toDate, chunkDays);
      const allData   = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const data = await kite.getHistoricalData(
            instrument.token,
            intervalConfig.interval,
            chunk.from,
            chunk.to
          );

          if (data && data.length > 0) {
            allData.push(...data);
            process.stdout.write(`   Chunk ${i+1}/${chunks.length}: ${data.length} candles ✅\r`);
          }

          // Rate limit — 3 requests/second max
          await sleep(400);

        } catch (err) {
          console.error(`\n   ❌ Error chunk ${i+1}: ${err.message}`);
          errors++;
          await sleep(1000); // wait longer on error
        }
      }

      if (allData.length > 0) {
        // Remove duplicates by date
        const unique = allData.filter((item, index, self) =>
          index === self.findIndex(t => t.date === item.date)
        );
        unique.sort((a, b) => new Date(a.date) - new Date(b.date));

        // Save CSV
        const dir     = path.join(OUTPUT, instrument.exchange, instrument.symbol);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const csvFile  = path.join(dir, `${intervalConfig.name}.csv`);
        const jsonFile = path.join(dir, `${intervalConfig.name}.json`);

        saveToCSV(unique, csvFile);
        saveToJSON(unique, jsonFile);

        console.log(`\n   ✅ Saved ${unique.length} candles → ${csvFile}`);
        totalFiles++;
      } else {
        console.log(`\n   ⚠️  No data received`);
      }
    }
  }

  console.log(`\n\n✅ Download complete!`);
  console.log(`   Files saved: ${totalFiles}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Location: ${OUTPUT}`);
}

// ─────────────────────────────────────────
// RUN
// ─────────────────────────────────────────
downloadHistorical().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});