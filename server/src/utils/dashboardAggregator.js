const Trade = require('../models/Trades');
const Backtest = require('../models/Backtest');

const getMasterData = async (mode = 'backtest') => {
  if (mode === 'live') {
    // Aggregate Live Paper Trade data from MongoDB
    const trades = await Trade.find({ isPaperTrade: true });
    let totalPnl = 0;
    const monthly = {};

    trades.forEach(t => {
      totalPnl += t.pnl || 0;
      const month = new Date(t.entryDate).toISOString().slice(0, 7); // YYYY-MM
      monthly[month] = (monthly[month] || 0) + (t.pnl || 0);
    });

    return { totalPnl, monthly, source: 'MongoDB Live' };
  } else {
    // Aggregate Backtest data
    const backtests = await Backtest.find({});
    let totalPnl = 0;
    const monthly = {};

    backtests.forEach(b => {
      totalPnl += b.totalPnl || 0;

      // b.monthly can be a Map or plain object
      const monthlyData = b.monthly instanceof Map
        ? Object.fromEntries(b.monthly)
        : (b.monthly || {});

      for (const [month, val] of Object.entries(monthlyData)) {
        // val may be a number or an object with .pnl
        const pnl = typeof val === 'object' && val !== null ? (val.pnl || 0) : (val || 0);
        monthly[month] = (monthly[month] || 0) + pnl;
      }
    });

    return { totalPnl, monthly, source: 'MongoDB Backtest' };
  }
};

module.exports = { getMasterData };
