const express = require('express');
const router  = express.Router();

// GET /api/trades
router.get('/', (req, res) => {
  const engine = req.app.locals.engine;
  const status = engine.getStatus();
  const trades = status.paperTrades || [];

  const totalPnl  = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const winners   = trades.filter(t => t.pnl > 0);
  const losers    = trades.filter(t => t.pnl < 0);
  const winRate   = trades.length ? (winners.length / trades.length * 100).toFixed(1) : 0;

  res.json({
    success: true,
    trades,
    summary: {
      total:    trades.length,
      winners:  winners.length,
      losers:   losers.length,
      winRate:  `${winRate}%`,
      totalPnl: totalPnl.toFixed(2),
      avgWin:   winners.length ? (winners.reduce((s,t) => s+t.pnl, 0) / winners.length).toFixed(2) : 0,
      avgLoss:  losers.length  ? (losers.reduce((s,t) => s+t.pnl, 0) / losers.length).toFixed(2)  : 0,
    }
  });
});

module.exports = router;
