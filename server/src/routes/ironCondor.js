const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

// GET /api/iron-condor/status
router.get('/status', (req, res) => {
  const engine = req.app.locals.icEngine;
  res.json({ success: true, status: engine.getStatus() });
});

// POST /api/iron-condor/start
router.post('/start', (req, res) => {
  const engine = req.app.locals.icEngine;
  engine.start();
  res.json({ success: true, message: 'Iron Condor engine started' });
});

// POST /api/iron-condor/stop
router.post('/stop', (req, res) => {
  const engine = req.app.locals.icEngine;
  engine.stop();
  res.json({ success: true, message: 'Iron Condor engine stopped' });
});

// POST /api/iron-condor/roll
router.post('/roll', (req, res) => {
  const { index, type, side } = req.body;
  const engine = req.app.locals.icEngine;
  engine.recordRoll(index, type, side);
  res.json({ success: true, message: `Roll recorded: ${index} ${type} ${side}` });
});

// POST /api/iron-condor/iron-fly
router.post('/iron-fly', (req, res) => {
  const { index } = req.body;
  const engine = req.app.locals.icEngine;
  engine.convertToIronFly(index);
  res.json({ success: true, message: `${index} converted to Iron Butterfly` });
});

// POST /api/iron-condor/close
router.post('/close', (req, res) => {
  const { index, reason, pnl } = req.body;
  const engine = req.app.locals.icEngine;
  engine.closePosition(index, reason, pnl);
  res.json({ success: true, message: `${index} position closed` });
});

// GET /api/iron-condor/history
router.get('/history', (req, res) => {
  const engine  = req.app.locals.icEngine;
  const status  = engine.getStatus();
  res.json({ success: true, history: status.history });
});

module.exports = router;
