require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const mongoose   = require('mongoose');
const logger     = require('./utils/logger');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.CLIENT_URL, methods: ['GET', 'POST'] }
});

// ── Middleware ──────────────────────────
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// ── Routes ──────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/strategy', require('./routes/strategy'));
app.use('/api/trades',   require('./routes/trades'));
app.use('/api/market',   require('./routes/market'));

// ── Socket.IO ───────────────────────────
require('./services/socketService')(io);

// ── MongoDB ─────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('MongoDB connected'))
  .catch(err => logger.warn('MongoDB not connected — running without DB: ' + err.message));

// ── Start Trading Engine ─────────────────
const TradingEngine = require('./services/tradingEngine');
const engine        = new TradingEngine(io);
app.locals.engine   = engine;

// ── Start Server ────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📊 Paper Trade Mode: ${process.env.PAPER_TRADE === 'true' ? 'ON ✅' : 'OFF ⚠️'}`);
});

module.exports = { app, io };
