const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema({
  strategy: { 
    type: String, 
    required: true, 
    enum: ['ironCondor', 'deltaNeutral', 'atmScalp', 'atmscalping', 'ironcondor', 'deltaneutral'] 
  },
  index: { 
    type: String, 
    required: true 
  }, // NIFTY or SENSEX
  status: { 
    type: String, 
    default: 'ACTIVE', 
    enum: ['ACTIVE', 'CLOSED', 'CUT'] 
  },
  entryDate: { 
    type: Date, 
    default: Date.now 
  },
  exitDate: { 
    type: Date 
  },
  entryPrice: { 
    type: Number 
  }, // Spot price at entry
  exitPrice: { 
    type: Number 
  }, // Spot price at exit
  quantity: { 
    type: Number 
  },
  pnl: { 
    type: Number, 
    default: 0 
  },
  isPaperTrade: { 
    type: Boolean, 
    default: true 
  },
  // Stores the specific option legs, premiums, and symbols
  legs: [{
    symbol: String,
    type: String, // BUY or SELL
    entryPremium: Number,
    exitPremium: Number,
    status: String
  }],
  closeReason: { 
    type: String 
  }
}, { timestamps: true });

module.exports = mongoose.model('Trade', TradeSchema);