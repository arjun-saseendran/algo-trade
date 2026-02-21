require('dotenv').config();
const express            = require('express');
const http               = require('http');
const { Server }         = require('socket.io');
const cors               = require('cors');
const mongoose           = require('mongoose');
const logger             = require('./utils/logger');

const app           = express();
const server        = http.createServer(app);
const allowedOrigin = process.env.CLIENT_URL || 'http://localhost:3001';

const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true }
});

app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(express.json());

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/strategy',      require('./routes/strategy'));
app.use('/api/trades',        require('./routes/trades'));
app.use('/api/market',        require('./routes/market'));
app.use('/api/iron-condor',   require('./routes/ironCondor'));
app.use('/api/delta-neutral', require('./routes/deltaNeutral'));
app.use('/api/backtest',      require('./routes/backtest'));

require('./services/socketService')(io);

mongoose.connect(process.env.MONGO_URI)
  .then(() => logger.info('MongoDB connected'))
  .catch(err => logger.warn('MongoDB not connected: ' + err.message));

const TradingEngine      = require('./services/tradingEngine');
const IronCondorEngine   = require('./services/ironCondorEngine');
const DeltaNeutralEngine = require('./services/deltaNeutralEngine');

const engine   = new TradingEngine(io);
const icEngine = new IronCondorEngine(io);
const dnEngine = new DeltaNeutralEngine(io);

app.locals.engine   = engine;
app.locals.icEngine = icEngine;
app.locals.dnEngine = dnEngine;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Paper Trade: ${process.env.PAPER_TRADE === 'true' ? 'ON' : 'OFF'}`);
  logger.info(`Allowed origin: ${allowedOrigin}`);
});

module.exports = { app, io };
