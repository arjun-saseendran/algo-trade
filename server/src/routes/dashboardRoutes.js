const express = require('express');
const router = express.Router();
const { getMasterData } = require('../utils/dashboardAggregator');

router.get('/combined-results', async (req, res) => {
  try {
    const mode = req.query.mode || 'backtest';
    const stats = await getMasterData(mode);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to aggregate master data' });
  }
});

module.exports = router;