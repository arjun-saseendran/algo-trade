# 🤖 NIFTY ATM Scalping — Algo Trader

Full-stack algo trading system built with Node.js + React + Zerodha Kite API

## Strategy Rules Implemented
- ✅ Skip first 9:15 AM candle
- ✅ Find 2 consecutive opposite color candles
- ✅ Combined range < 30 NIFTY points
- ✅ Breakout entry → Buy ATM CE or PE
- ✅ SL = lowest low (CE) or highest high (PE) of setup candles
- ✅ Target = 3× SL distance
- ✅ Trail SL when profit hits ₹3,000
- ✅ Hard exit at 3:21 PM
- ✅ Max 1 trade per day
- ✅ Paper trade mode (safe testing)

---

## Project Structure
```
algo-trader/
├── server/                 ← Node.js backend
│   ├── src/
│   │   ├── index.js        ← Entry point
│   │   ├── strategies/
│   │   │   └── scalpingStrategy.js  ← Core strategy logic
│   │   ├── services/
│   │   │   ├── kiteService.js       ← Zerodha API
│   │   │   ├── tradingEngine.js     ← Orchestrator
│   │   │   └── socketService.js     ← WebSocket
│   │   ├── routes/
│   │   │   ├── auth.js
│   │   │   ├── strategy.js
│   │   │   ├── trades.js
│   │   │   └── market.js
│   │   └── utils/
│   │       └── logger.js
│   ├── .env.example
│   └── package.json
│
└── client/                 ← React frontend
    ├── src/
    │   ├── App.js
    │   ├── index.js
    │   ├── context/
    │   │   └── SocketContext.js     ← Real-time data
    │   └── components/
    │       └── Dashboard.js         ← Main UI
    └── package.json
```

---

## Setup Instructions

### Step 1 — Get Kite API Access
1. Go to https://developers.kite.trade
2. Create app → get API Key and Secret
3. Cost: ₹2,000/year

### Step 2 — Install dependencies
```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### Step 3 — Configure environment
```bash
cd server
cp .env.example .env
```

Edit `.env`:
```
KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
PAPER_TRADE=true          ← Keep true for paper trading
CAPITAL=100000
QTY=65
```

### Step 4 — Start servers
```bash
# Terminal 1 — Backend
cd server
npm run dev

# Terminal 2 — Frontend
cd client
npm start
```

### Step 5 — Connect Kite API
1. Open http://localhost:3000
2. Click "Login Kite" button
3. Login to Zerodha
4. Copy `request_token` from redirect URL
   (URL looks like: http://localhost:3000/?request_token=XXXXX)
5. Send POST request:
```bash
curl -X POST http://localhost:5000/api/auth/callback \
  -H "Content-Type: application/json" \
  -d '{"request_token": "XXXXX"}'
```
6. Dashboard shows "Kite connected" ✅

### Step 6 — Start strategy
1. Click "▶ Start" button on dashboard
2. Strategy runs automatically during market hours
3. Watch Live Log for real-time activity

---

## Paper Trade vs Live Trade

### Paper Trade (Default — SAFE)
```
PAPER_TRADE=true in .env

What happens:
→ Strategy detects real setups
→ Simulates orders (no real money)
→ Uses real option prices for P&L calculation
→ Shows exact results as if live
→ Safe to run and test
```

### Going Live (After testing)
```
PAPER_TRADE=false in .env

⚠️ WARNING: Real money at risk
→ Only switch after 1 month paper trading
→ Verify all rules executing correctly first
→ Start with 1 lot only
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/auth/login | Get Kite login URL |
| POST | /api/auth/callback | Set access token |
| GET | /api/auth/status | Check connection |
| POST | /api/strategy/start | Start engine |
| POST | /api/strategy/stop | Stop engine |
| GET | /api/strategy/status | Get full status |
| POST | /api/strategy/exit | Manual exit |
| GET | /api/trades | All trades + stats |
| GET | /api/market/ltp | NIFTY LTP |

---

## WebSocket Events (Frontend listens)

| Event | Description |
|-------|-------------|
| new_candle | New 3-min candle data |
| setup_found | Valid setup detected |
| signal | Breakout signal |
| trade_opened | Trade executed |
| trade_update | P&L update |
| trade_closed | Trade closed with result |
| trail_activated | Trailing SL activated |
| strategy_reset | New day reset |

---

## Important Notes

1. **Kite API token expires daily** — need to login every morning
2. **MongoDB optional** — runs without it, trades stored in memory
3. **3-min candles** — Kite API provides historical data; engine polls every 3 min
4. **ATM strike** — auto-selected based on spot price at entry time
5. **Slippage** — market orders used; real fills may differ slightly

---

## Troubleshooting

**"Kite disconnected" after market open**
→ Token expired → Login again each morning

**"No candles received"**
→ Check market hours (9:15 AM - 3:30 PM weekdays)
→ Verify Kite API credentials

**"ATM option not found"**
→ Option chain may not be loaded yet
→ Wait a few minutes after market open

---

## Next Steps (Future enhancements)
- [ ] Auto login using stored credentials
- [ ] MongoDB trade history persistence
- [ ] Email/SMS alerts for signals
- [ ] Iron Condor strategy module
- [ ] Performance analytics page
- [ ] Multiple strategy support
