const express = require('express');
const router = express.Router();
const kiteService = require('../services/kiteService');
const { downloadHistoricalData } = require('../services/historicalDownloader'); // ADDED THIS IMPORT

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

// POST /api/market/download-history (NEW ENDPOINT)
router.post('/download-history', (req, res) => {
  // We trigger the download function but DO NOT await it.
  // This allows the script to run in the background for several minutes
  // without the HTTP request timing out in the browser.
  downloadHistoricalData().catch(console.error);
  
  res.json({ 
    success: true, 
    message: "Historical data download started in the background. Check your server terminal for progress." 
  });
});

module.exports = router;