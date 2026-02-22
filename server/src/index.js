require('dotenv').config();
const express            = require('express');
const http               = require('http');
const { Server }         = require('socket.io');
const cors               = require('cors');
const mongoose           = require('mongoose');
const cron               = require('node-cron');
const logger             = require('./utils/logger');
const { downloadMarketHistory } = require('./services/marketDataService');

const app           = express();
const server        = http.createServer(app);
const allowedOrigin = process.env.CLIENT_URL || 'http://localhost:3001';

const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true }
});

app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(express.json());

// --- Trading Engines ---
const AtmScalpingEngine  = require('./services/atmScalpingEngine'); 
const IronCondorEngine   = require('./services/ironCondorEngine');
const DeltaNeutralEngine = require('./services/deltaNeutralEngine');

const icEngine    = new IronCondorEngine(io);
const dnEngine    = new DeltaNeutralEngine(io);
const scalpEngine = new AtmScalpingEngine(io);

// 🔥 The Handshake: Mapping engines for the Router
app.locals.icEngine    = icEngine;
app.locals.dnEngine    = dnEngine;
app.locals.scalpEngine = scalpEngine;

// Wire socket service with access to engines
require('./services/socketService')(io, { scalpEngine, icEngine, dnEngine });

// --- Routes ---
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/strategy',      require('./routes/strategy'));
app.use('/api/backtest',      require('./routes/backtest'));
app.use('/api/trades',        require('./routes/trades'));
app.use('/api/trades',        require('./routes/tradeRoutes'));
app.use('/api/market',        require('./routes/market'));
app.use('/api/iron-condor',   require('./routes/ironCondor'));
app.use('/api/delta-neutral', require('./routes/deltaNeutral'));
app.use('/api',               require('./routes/dashboardRoutes'));

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('✅ MongoDB connected'))
  .catch(err => logger.error('❌ MongoDB error: ' + err.message));

// --- Automation ---
cron.schedule('45 15 * * 1-5', async () => {
  try {
    await downloadMarketHistory('NIFTY', '3minute');
    await downloadMarketHistory('SENSEX', '15minute');
    logger.info('🏁 Daily Data Download Complete');
  } catch (err) {
    logger.error('❌ Download failed: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
});

module.exports = { app, io };