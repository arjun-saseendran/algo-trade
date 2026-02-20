const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

// GET /api/strategy/status
router.get('/status', (req, res) => {
  const engine = req.app.locals.engine;
  res.json({ success: true, status: engine.getStatus() });
});

// POST /api/strategy/start
router.post('/start', (req, res) => {
  const engine = req.app.locals.engine;
  engine.start();
  res.json({ success: true, message: 'Strategy started' });
});

// POST /api/strategy/stop
router.post('/stop', (req, res) => {
  const engine = req.app.locals.engine;
  engine.stop();
  res.json({ success: true, message: 'Strategy stopped' });
});

// POST /api/strategy/exit — Manual exit
router.post('/exit', (req, res) => {
  const engine = req.app.locals.engine;
  const result = engine.manualExit();
  res.json({ success: result.success, ...result });
});

// GET /api/strategy/trades — All paper trades
router.get('/trades', (req, res) => {
  const engine = req.app.locals.engine;
  const status = engine.getStatus();
  res.json({ success: true, trades: status.paperTrades });
});

module.exports = router;
