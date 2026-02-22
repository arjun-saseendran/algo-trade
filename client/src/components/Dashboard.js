import React, { useState, useEffect } from 'react';
import api from '../utils/api';
import { useSocket } from '../context/SocketContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// ── Color tokens ───────────────────────
const C = {
  bg:      '#07090f',
  surface: '#0d1117',
  card:    '#111820',
  border:  '#1c2a3a',
  green:   '#22d3a0',
  red:     '#f43f5e',
  blue:    '#60a5fa',
  orange:  '#fb923c',
  yellow:  '#fbbf24',
  text:    '#e2e8f0',
  muted:   '#4b6278',
};

const s = {
  page:    { background: C.bg, minHeight: '100vh', color: C.text, fontFamily: 'monospace', padding: '20px' },
  card:    { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 },
  label:   { fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  bigVal:  { fontSize: 24, fontWeight: 700 },
  row:     { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  flex1:   { flex: 1, minWidth: 140 },
  btn:     (color) => ({
    background: color, color: '#fff', border: 'none', borderRadius: 8,
    padding: '10px 20px', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'monospace'
  }),
  tag:     (color) => ({
    background: color + '22', color, border: `1px solid ${color}44`,
    borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700
  }),
  badge:   (on) => ({
    width: 8, height: 8, borderRadius: '50%',
    background: on ? C.green : C.red,
    display: 'inline-block', marginRight: 6
  }),
};

// ── KPI Card ───────────────────────────
const KPI = ({ label, value, color = C.text, sub }) => (
  <div style={{ ...s.card, ...s.flex1 }}>
    <div style={s.label}>{label}</div>
    <div style={{ ...s.bigVal, color }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
  </div>
);

// ── Main Dashboard ─────────────────────
export default function Dashboard() {
  const { connected, logs, currentTrade, currentSetup, trades, engineStatus, manualExit } = useSocket();
  const [apiConnected, setApiConnected] = useState(false);
  const [startLoading, setStartLoading] = useState(false);

  // Calculate stats
  const closedTrades  = trades.filter(t => t.status === 'CLOSED');
  const totalPnl      = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const winners       = closedTrades.filter(t => t.pnl > 0);
  const losers        = closedTrades.filter(t => t.pnl < 0);
  const winRate       = closedTrades.length ? (winners.length / closedTrades.length * 100).toFixed(1) : 0;
  const avgWin        = winners.length ? (winners.reduce((s,t) => s+t.pnl,0) / winners.length).toFixed(0) : 0;
  const avgLoss       = losers.length  ? (losers.reduce((s,t) => s+t.pnl,0)  / losers.length).toFixed(0)  : 0;

  // Cumulative P&L chart data
  let cumPnl = 0;
  const chartData = closedTrades.map((t, i) => {
    cumPnl += t.pnl || 0;
    return { trade: i + 1, pnl: parseFloat(cumPnl.toFixed(2)) };
  });

  // Check API status
  useEffect(() => {
    api.get('/api/auth/status')
      .then(r => setApiConnected(r.data.connected))
      .catch(() => setApiConnected(false));
  }, [connected]);

  const handleStart = async () => {
    setStartLoading(true);
    try { await api.post('/api/strategy/toggle', { strategy: 'atmscalping', action: 'start' }); }
    catch (e) {}
    setStartLoading(false);
  };

  const handleStop = async () => {
    try { await api.post('/api/strategy/toggle', { strategy: 'atmscalping', action: 'stop' }); }
    catch (e) {}
  };

  const logColors = {
    success: C.green, error: C.red, setup: C.yellow,
    signal: C.orange, trade: C.blue, candle: C.muted, info: C.muted, warning: C.orange
  };

  return (
    <div style={s.page}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: '#fff', letterSpacing: -0.5 }}>
            🤖 NIFTY ATM Scalping
          </h1>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            <span style={s.badge(connected)} />
            {connected ? 'Server connected' : 'Server disconnected'}
            &nbsp;&nbsp;
            <span style={s.badge(apiConnected)} />
            {apiConnected ? 'Kite connected' : 'Kite disconnected'}
            &nbsp;&nbsp;
            <span style={{ ...s.tag(engineStatus.paperTrade ? C.yellow : C.red) }}>
              {engineStatus.paperTrade ? '📝 PAPER' : '💰 LIVE'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {!apiConnected && (
            <button style={s.btn(C.blue)} onClick={() =>
              api.get('/api/auth/login').then(r => window.open(r.data.loginUrl))
            }>
              Login Kite
            </button>
          )}
          {!engineStatus.running ? (
            <button style={s.btn(C.green)} onClick={handleStart} disabled={startLoading}>
              {startLoading ? 'Starting...' : '▶ Start'}
            </button>
          ) : (
            <button style={s.btn(C.muted)} onClick={handleStop}>⏹ Stop</button>
          )}
          {currentTrade && (
            <button style={s.btn(C.red)} onClick={manualExit}>🚨 Exit Now</button>
          )}
        </div>
      </div>

      {/* KPI Row */}
      <div style={s.row}>
        <KPI label="Net P&L" value={`₹${totalPnl.toFixed(0)}`} color={totalPnl >= 0 ? C.green : C.red} sub={`${closedTrades.length} trades`} />
        <KPI label="Win Rate" value={`${winRate}%`} color={C.yellow} sub={`${winners.length}W / ${losers.length}L`} />
        <KPI label="Avg Win" value={`₹${avgWin}`} color={C.green} sub="per winning trade" />
        <KPI label="Avg Loss" value={`₹${avgLoss}`} color={C.red} sub="per losing trade" />
        <KPI label="Engine" value={engineStatus.running ? 'RUNNING' : 'STOPPED'} color={engineStatus.running ? C.green : C.muted} />
      </div>

      {/* Setup + Trade Status */}
      <div style={s.row}>

        {/* Current Setup */}
        <div style={{ ...s.card, flex: 1, minWidth: 240, borderLeft: `3px solid ${C.yellow}` }}>
          <div style={s.label}>Current Setup</div>
          {currentSetup ? (
            <>
              <div style={{ color: C.yellow, fontWeight: 700, marginBottom: 8 }}>✅ Setup Detected</div>
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                <div>Range: <span style={{ color: C.text }}>{currentSetup.combinedRange} pts</span></div>
                <div>CE above: <span style={{ color: C.green }}>{currentSetup.highestHigh}</span></div>
                <div>PE below: <span style={{ color: C.red }}>{currentSetup.lowestLow}</span></div>
                <div>SL: <span style={{ color: C.orange }}>₹{currentSetup.slRupees}</span></div>
                <div>Target: <span style={{ color: C.green }}>₹{currentSetup.targetRupees}</span></div>
              </div>
            </>
          ) : (
            <div style={{ color: C.muted, fontSize: 12 }}>Watching for setup...</div>
          )}
        </div>

        {/* Current Trade */}
        <div style={{ ...s.card, flex: 1, minWidth: 240, borderLeft: `3px solid ${currentTrade ? C.blue : C.border}` }}>
          <div style={s.label}>Current Trade</div>
          {currentTrade ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={s.tag(currentTrade.direction === 'CE' ? C.green : C.red)}>
                  {currentTrade.direction}
                </span>
                <span style={{ fontSize: 12, color: C.muted }}>{currentTrade.optionSymbol}</span>
                {currentTrade.paperTrade && <span style={s.tag(C.yellow)}>PAPER</span>}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                <div>Entry: <span style={{ color: C.text }}>₹{currentTrade.entryOptionPrice}</span></div>
                <div>SL: <span style={{ color: C.red }}>₹{currentTrade.slOptionPrice}</span></div>
                <div>Target: <span style={{ color: C.green }}>₹{currentTrade.tgtOptionPrice}</span></div>
                <div>P&L: <span style={{ color: currentTrade.pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>
                  ₹{currentTrade.pnl?.toFixed(0) || 0}
                </span></div>
                {currentTrade.trailing && (
                  <div style={{ color: C.yellow }}>🎯 Trailing SL Active</div>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: C.muted, fontSize: 12 }}>No open trade</div>
          )}
        </div>

        {/* Strategy Rules */}
        <div style={{ ...s.card, flex: 1, minWidth: 240 }}>
          <div style={s.label}>Strategy Rules</div>
          <div style={{ fontSize: 11, lineHeight: 1.9, color: C.muted }}>
            <div>⏭️  Skip 9:15 AM candle</div>
            <div>🕯️  2 opposite color candles</div>
            <div>📏  Combined range &lt; 30 pts</div>
            <div>🚀  Breakout entry ATM CE/PE</div>
            <div>🛑  SL = setup high/low</div>
            <div>🎯  Target = 3× SL</div>
            <div>🎢  Trail at ₹3,000 profit</div>
            <div>⏰  Hard exit 3:21 PM</div>
            <div>1️⃣  Max 1 trade/day</div>
          </div>
        </div>
      </div>

      {/* Chart + Logs */}
      <div style={{ ...s.row, alignItems: 'flex-start' }}>

        {/* Cumulative P&L Chart */}
        <div style={{ ...s.card, flex: 2, minWidth: 300 }}>
          <div style={s.label}>Cumulative P&L</div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="trade" tick={{ fill: C.muted, fontSize: 10 }} label={{ value: 'Trade #', position: 'insideBottom', fill: C.muted, fontSize: 10 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} tickFormatter={v => `₹${v}`} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8 }}
                  labelStyle={{ color: C.muted }}
                  itemStyle={{ color: C.blue }}
                  formatter={v => [`₹${v}`, 'P&L']}
                />
                <Line type="monotone" dataKey="pnl" stroke={totalPnl >= 0 ? C.green : C.red} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontSize: 12 }}>
              No trades yet — waiting for setup...
            </div>
          )}
        </div>

        {/* Live Logs */}
        <div style={{ ...s.card, flex: 1, minWidth: 260 }}>
          <div style={s.label}>Live Log</div>
          <div style={{ height: 200, overflowY: 'auto', fontSize: 11 }}>
            {logs.length === 0 && <div style={{ color: C.muted }}>Waiting for activity...</div>}
            {logs.map(log => (
              <div key={log.id} style={{ marginBottom: 4, borderBottom: `1px solid ${C.border}22`, paddingBottom: 4 }}>
                <span style={{ color: C.muted }}>[{log.time}] </span>
                <span style={{ color: logColors[log.type] || C.text }}>{log.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Trade History */}
      <div style={s.card}>
        <div style={{ ...s.label, marginBottom: 12 }}>Trade History</div>
        {closedTrades.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 12 }}>No closed trades yet</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {['Date','Entry','Direction','Entry ₹','SL ₹','Target ₹','Exit ₹','Exit Time','Reason','P&L'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', color: C.muted, textAlign: 'left', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((t, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}22`, background: i % 2 === 0 ? 'transparent' : C.surface + '44' }}>
                    <td style={{ padding: '6px 10px' }}>{t.date}</td>
                    <td style={{ padding: '6px 10px' }}>{t.entryTime}</td>
                    <td style={{ padding: '6px 10px' }}><span style={s.tag(t.direction === 'CE' ? C.green : C.red)}>{t.direction}</span></td>
                    <td style={{ padding: '6px 10px' }}>₹{t.entryOptionPrice}</td>
                    <td style={{ padding: '6px 10px', color: C.red }}>₹{t.slOptionPrice}</td>
                    <td style={{ padding: '6px 10px', color: C.green }}>₹{t.tgtOptionPrice}</td>
                    <td style={{ padding: '6px 10px' }}>₹{t.exitPrice}</td>
                    <td style={{ padding: '6px 10px' }}>{t.exitTime}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={s.tag(t.closeReason === 'TARGET_HIT' ? C.green : t.closeReason === 'SL_HIT' ? C.red : C.muted)}>
                        {t.closeReason}
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px', fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                      {t.pnl >= 0 ? '+' : ''}₹{t.pnl?.toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Kite Auth Helper */}
      {!apiConnected && (
        <div style={{ ...s.card, borderLeft: `3px solid ${C.orange}` }}>
          <div style={{ color: C.orange, fontWeight: 700, marginBottom: 8 }}>⚠️ Kite API Not Connected</div>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.8 }}>
            <div>1. Click "Login Kite" button above</div>
            <div>2. Login to Zerodha in the popup</div>
            <div>3. Copy the <code>request_token</code> from the redirect URL</div>
            <div>4. POST to <code>/api/auth/callback</code> with the token</div>
          </div>
        </div>
      )}
    </div>
  );
}
