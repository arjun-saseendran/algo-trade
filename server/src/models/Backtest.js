const mongoose = require('mongoose');

const BacktestSchema = new mongoose.Schema({
  strategyName: { type: String, required: true, unique: true },
  totalPnl:     { type: Number, default: 0 },
  winRate:      { type: Number, default: 0 },
  maxDrawdown:  { type: Number, default: 0 },
  monthly:      { type: Map, of: mongoose.Schema.Types.Mixed },
  trades:       { type: Array, default: [] },
  lastUpdated:  { type: Date, default: Date.now }
  // We don't need to list every single stat (sharpeRatio, avgWin, etc.) 
  // because we are turning off strict mode below!
}, { 
  timestamps: true,
  strict: false // 🚨 THIS IS THE MAGIC FIX 🚨
});

module.exports = mongoose.models.Backtest || mongoose.model('Backtest', BacktestSchema);