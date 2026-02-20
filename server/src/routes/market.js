const express     = require('express');
const router      = express.Router();
const kiteService = require('../services/kiteService');

// GET /api/market/ltp
router.get('/ltp', async (req, res) => {
  try {
    const data = await kiteService.getLTP(['NSE:NIFTY 50']);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/market/positions
router.get('/positions', async (req, res) => {
  try {
    const data = await kiteService.getPositions();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/market/orders
router.get('/orders', async (req, res) => {
  try {
    const data = await kiteService.getOrders();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
