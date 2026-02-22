const express            = require('express');
const router             = express.Router();
const path               = require('path');
const fs                 = require('fs');
const { execSync }       = require('child_process');
const logger             = require('../utils/logger');
const Backtest           = require('../models/Backtest'); // Mongoose Model

const DATA_DIR = path.join(__dirname, '../../data');

const STRATEGY_MAP = {
  scalping:     { script: 'backtestScalping.js',     result: 'backtest_scalping.json'      },
  ironcondor:   { script: 'backtestIronCondor.js',   result: 'backtest_iron_condor.json'   },
  deltaneutral: { script: 'backtestDeltaNeutral.js', result: 'backtest_delta_neutral.json' },
};

// ==============================================================
// GET /api/backtest/all-results
// Hybrid approach: Reads from MongoDB, but if DB is empty, 
// it auto-syncs from your existing local JSON files.
// ==============================================================
router.get('/all-results', async (req, res) => {
  try {
    const dbData = await Backtest.find({}).lean();
    const results = {};

    for (const [key, cfg] of Object.entries(STRATEGY_MAP)) {
      let dbRecord = dbData.find(d => d.strategyName === key);

      // AUTO-MIGRATION: If not in MongoDB yet, read the JSON and save to Mongo
      if (!dbRecord) {
        const filePath = path.join(DATA_DIR, cfg.result);
        if (fs.existsSync(filePath)) {
          logger.info(`🔄 Auto-migrating ${key} JSON to MongoDB...`);
          try {
            const stats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            dbRecord = await Backtest.findOneAndUpdate(
              { strategyName: key },
              { strategyName: key, ...stats, lastUpdated: new Date() },
              { upsert: true, new: true }
            ).lean();
            
          } catch (err) {
            logger.error(`Failed to migrate ${key} JSON: ${err.message}`);
          }
        }
      }

      // Format data for React UI
      if (dbRecord) {
        if (dbRecord.monthly instanceof Map) dbRecord.monthly = Object.fromEntries(dbRecord.monthly);
        if (dbRecord.reasons instanceof Map) dbRecord.reasons = Object.fromEntries(dbRecord.reasons);
        results[key] = dbRecord;
      } else {
        results[key] = null;
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    logger.error(`Fetch all-results error: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================================
// GET /api/backtest/results 
// Kept for backward compatibility with Delta Neutral Page
// ==============================================================
router.get('/results', async (req, res) => {
  try {
    const stats = await Backtest.findOne({ strategyName: 'deltaneutral' }).lean();
    if (!stats) return res.json({ success: false });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==============================================================
// POST /api/backtest/run
// Runs your exact external scripts, then SAVES to MongoDB
// ==============================================================
router.post('/run', async (req, res) => {
  const { strategy } = req.body;
  const cfg = STRATEGY_MAP[strategy];

  if (!cfg) return res.status(400).json({ success: false, message: `Unknown strategy: ${strategy}` });

  const scriptPath = path.join(__dirname, '../../scripts', cfg.script);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ success: false, message: `Script not found: ${cfg.script}` });
  }

  try {
    logger.info(`▶️ Running backtest script: ${strategy}`);
    
    // 1. Run your actual heavy lifting script
    execSync(`node ${scriptPath}`, { stdio: 'pipe', timeout: 120000, cwd: path.join(__dirname, '../..') });

    const resultPath = path.join(DATA_DIR, cfg.result);
    if (!fs.existsSync(resultPath)) {
      return res.status(500).json({ success: false, message: 'Backtest ran but no results JSON was saved by the script.' });
    }

    // 2. Read the results from the newly generated JSON
    const stats = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    // 3. ✨ NEW: Save those results instantly to MongoDB
    const savedData = await Backtest.findOneAndUpdate(
      { strategyName: strategy },
      {
        strategyName: strategy,
        totalPnl: stats.totalPnl || 0,
        winRate: stats.winRate || 0,
        maxDrawdown: stats.maxDrawdown || 0,
        monthly: stats.monthly || {},
        trades: stats.trades || [],
        totalTrades: stats.totalTrades || 0,
        sharpeRatio: stats.sharpeRatio || 0,
        avgWin: stats.avgWin || 0,
        avgLoss: stats.avgLoss || 0,
        winners: stats.winners || 0,
        losers: stats.losers || 0,
        bestTrade: stats.bestTrade || null,
        worstTrade: stats.worstTrade || null,
        reasons: stats.reasons || {},
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );

    logger.info(`✅ Backtest complete & saved to DB: ${strategy} | Trades: ${stats.totalTrades} | P&L: ₹${stats.totalPnl}`);
    res.json({ success: true, stats: savedData });

  } catch (err) {
    logger.error(`❌ Backtest error (${strategy}): ${err.message}`);
    res.status(500).json({ success: false, message: err.stderr?.toString() || err.message });
  }
});

module.exports = router;