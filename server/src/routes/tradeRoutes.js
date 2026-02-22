const express = require('express');
const router = express.Router();
const Trade = require('../models/Trades');

// Fetch full detailed trade history
router.get('/history', async (req, res) => {
  try {
    const trades = await Trade.find({})
      .sort({ entryDate: -1 }) // Newest first
      .limit(100); // Limit to last 100 trades for performance
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
});

module.exports = router;