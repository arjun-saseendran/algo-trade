const mongoose = require('mongoose');

const MarketDataSchema = new mongoose.Schema({
  index:     { type: String, required: true }, 
  interval:  { type: String, required: true }, 
  date:      { type: Date,   required: true },
  open:      { type: Number, required: true },
  high:      { type: Number, required: true },
  low:       { type: Number, required: true },
  close:     { type: Number, required: true },
  volume:    { type: Number, default: 0 }
}, { timestamps: true }); // Good practice for auditing

// Compound index to prevent duplicate entries for the same timestamp
MarketDataSchema.index({ index: 1, interval: 1, date: 1 }, { unique: true });

// Export with existence check to prevent "Overwrite" errors
module.exports = mongoose.models.MarketData || mongoose.model('MarketData', MarketDataSchema);