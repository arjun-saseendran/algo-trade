const express            = require('express');
const router             = express.Router();
const path               = require('path');
const fs                 = require('fs');
const { execSync }       = require('child_process');
const logger             = require('../utils/logger');

const DATA_DIR = path.join(__dirname, '../../data');

const STRATEGY_MAP = {
  scalping:     { script: 'backtestScalping.js',     result: 'backtest_scalping.json'      },
  ironcondor:   { script: 'backtestIronCondor.js',   result: 'backtest_iron_condor.json'   },
  deltaneutral: { script: 'backtestDeltaNeutral.js', result: 'backtest_delta_neutral.json' },
};

// GET /api/backtest/all-results
router.get('/all-results', (req, res) => {
  const results = {};
  for (const [key, cfg] of Object.entries(STRATEGY_MAP)) {
    const filePath = path.join(DATA_DIR, cfg.result);
    if (fs.existsSync(filePath)) {
      try { results[key] = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { results[key] = null; }
    } else {
      results[key] = null;
    }
  }
  res.json({ success: true, results });
});

// GET /api/backtest/results (single — kept for delta neutral page)
router.get('/results', (req, res) => {
  const filePath = path.join(DATA_DIR, 'backtest_delta_neutral.json');
  if (!fs.existsSync(filePath)) return res.json({ success: false });
  try {
    const stats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/backtest/run
router.post('/run', (req, res) => {
  const { strategy } = req.body;
  const cfg = STRATEGY_MAP[strategy];

  if (!cfg) return res.status(400).json({ success: false, message: `Unknown strategy: ${strategy}` });

  const scriptPath = path.join(__dirname, '../../scripts', cfg.script);
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ success: false, message: `Script not found: ${cfg.script}` });
  }

  try {
    logger.info(`Running backtest: ${strategy}`);
    execSync(`node ${scriptPath}`, { stdio: 'pipe', timeout: 120000, cwd: path.join(__dirname, '../..') });

    const resultPath = path.join(DATA_DIR, cfg.result);
    if (!fs.existsSync(resultPath)) {
      return res.status(500).json({ success: false, message: 'Backtest ran but no results saved' });
    }

    const stats = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    logger.info(`Backtest complete: ${strategy} | Trades: ${stats.totalTrades} | P&L: ₹${stats.totalPnl}`);
    res.json({ success: true, stats });
  } catch (err) {
    logger.error(`Backtest error (${strategy}): ${err.message}`);
    res.status(500).json({ success: false, message: err.stderr?.toString() || err.message });
  }
});

module.exports = router;