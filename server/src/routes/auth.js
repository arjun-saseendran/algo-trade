const express    = require('express');
const router     = express.Router();
const kiteService = require('../services/kiteService');
const logger     = require('../utils/logger');

// GET /api/auth/login — Get Kite login URL
router.get('/login', (req, res) => {
  try {
    const loginUrl = kiteService.getLoginUrl();
    res.json({ success: true, loginUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/callback — Handle login callback
router.post('/callback', async (req, res) => {
  try {
    const { request_token } = req.body;
    if (!request_token) {
      return res.status(400).json({ success: false, message: 'request_token required' });
    }

    const session = await kiteService.generateSession(request_token);
    logger.info('✅ Login successful for: ' + session.user_name);

    res.json({
      success:      true,
      accessToken:  session.access_token,
      userName:     session.user_name,
      userId:       session.user_id,
    });
  } catch (err) {
    logger.error('Auth callback error: ' + err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/set-token — Set access token directly
router.post('/set-token', (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ success: false, message: 'accessToken required' });
    }
    kiteService.setAccessToken(accessToken);
    res.json({ success: true, message: 'Token set successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/status — Check connection status
router.get('/status', (req, res) => {
  res.json({
    connected: kiteService.isConnected(),
    paperTrade: process.env.PAPER_TRADE === 'true'
  });
});

module.exports = router;
