const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

// GET /api/delta-neutral/status
router.get('/status', (req, res) => {
  const engine = req.app.locals.dnEngine;
  res.json({ success: true, status: engine.getStatus() });
});

// POST /api/delta-neutral/start
router.post('/start', (req, res) => {
  req.app.locals.dnEngine.start();
  res.json({ success: true, message: 'Delta Neutral engine started' });
});

// POST /api/delta-neutral/stop
router.post('/stop', (req, res) => {
  req.app.locals.dnEngine.stop();
  res.json({ success: true, message: 'Delta Neutral engine stopped' });
});

// POST /api/delta-neutral/exit-all
router.post('/exit-all', async (req, res) => {
  try {
    await req.app.locals.dnEngine.exitAll('MANUAL_EXIT');
    res.json({ success: true, message: 'All legs exited' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/delta-neutral/exit-legs
router.post('/exit-legs', async (req, res) => {
  try {
    const { legs, reason } = req.body;
    await req.app.locals.dnEngine.exitLegs(legs, reason || 'MANUAL_EXIT');
    res.json({ success: true, message: `Legs exited: ${legs.join(', ')}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/delta-neutral/history
router.get('/history', (req, res) => {
  const status = req.app.locals.dnEngine.getStatus();
  res.json({ success: true, history: status.history });
});

module.exports = router;
