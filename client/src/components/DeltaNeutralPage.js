import React, { useState, useEffect } from 'react';
import api from '../utils/api';

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
  purple:  '#a78bfa',
  teal:    '#2dd4bf',
  text:    '#e2e8f0',
  muted:   '#4b6278',
};

const s = {
  card:  { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 },
  label: { fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  row:   { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  btn:   (color, outline) => ({
    background:   outline ? 'transparent' : color,
    color:        outline ? color : '#000',
    border:       `1px solid ${color}`,
    borderRadius: 8, padding: '8px 16px',
    cursor: 'pointer', fontWeight: 700,
    fontSize: 12, fontFamily: 'monospace',
  }),
  tag: (color) => ({
    background: color + '22', color,
    border: `1px solid ${color}44`,
    borderRadius: 6, padding: '2px 8px',
    fontSize: 11, fontWeight: 700,
  }),
};

// ── Leg Card ───────────────────────────
const LegCard = ({ legKey, leg, onExit }) => {
  if (!leg) return null;

  const isBuy    = legKey === 'callBuy' || legKey === 'putBuy';
  const isCall   = legKey === 'callBuy' || legKey === 'callSell';
  const isClosed = leg.status === 'CLOSED';

  const pnlColor = leg.pnl > 0 ? C.green : leg.pnl < 0 ? C.red : C.muted;
  const bgColor  = isClosed ? C.surface : C.card;

  const labels = {
    callBuy:  '📞 Call Buy',
    callSell: '📞 Call Sell',
    putBuy:   '📉 Put Buy',
    putSell:  '📉 Put Sell',
  };

  const borderColor = isClosed ? C.muted : isCall ? C.blue : C.green;

  return (
    <div style={{
      background:  bgColor,
      border:      `1px solid ${C.border}`,
      borderLeft:  `3px solid ${borderColor}`,
      borderRadius: 10,
      padding:     12,
      opacity:     isClosed ? 0.5 : 1,
      flex:        1,
      minWidth:    160,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: isClosed ? C.muted : C.text }}>
          {labels[legKey]}
        </span>
        <span style={s.tag(isClosed ? C.muted : isBuy ? C.blue : C.orange)}>
          {isClosed ? 'CLOSED' : isBuy ? 'BUY' : 'SELL'}
        </span>
      </div>

      <div style={{ fontSize: 11, lineHeight: 2, color: C.muted }}>
        <div>Strike: <span style={{ color: C.text }}>{leg.strike}</span></div>
        <div>Delta:  <span style={{ color: C.yellow }}>{leg.delta?.toFixed(2)}</span></div>
        <div>Entry:  <span style={{ color: C.text }}>₹{leg.entryPremium}</span></div>
        <div>Now:    <span style={{ color: C.text }}>₹{leg.currentPremium?.toFixed(2) || '-'}</span></div>
        <div>SL:     <span style={{ color: C.red }}>₹{leg.sl?.toFixed(2)}</span></div>
        <div>P&L:    <span style={{ color: pnlColor, fontWeight: 700 }}>
          {leg.pnl >= 0 ? '+' : ''}₹{leg.pnl?.toFixed(0) || 0}
        </span></div>
      </div>

      {isClosed && leg.closeReason && (
        <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
          {leg.closeTime} — {leg.closeReason}
        </div>
      )}

      {!isClosed && (
        <button
          onClick={() => onExit(legKey)}
          style={{ ...s.btn(C.red, true), marginTop: 8, width: '100%', padding: '6px' }}
        >
          Exit
        </button>
      )}
    </div>
  );
};

// ── Trail Progress ─────────────────────
const TrailProgress = ({ lockedProfit, trailSL, pnl }) => {
  const levels = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
  const locks  = [250, 1000, 1750, 2500, 3250, 4000, 4750, 5500];

  return (
    <div style={{ ...s.card, borderLeft: `3px solid ${C.yellow}` }}>
      <div style={s.label}>Trail Progress</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {levels.map((level, i) => {
          const reached = pnl >= level;
          return (
            <div key={i} style={{
              background: reached ? C.yellow + '33' : C.surface,
              border:     `1px solid ${reached ? C.yellow : C.border}`,
              borderRadius: 6, padding: '4px 8px',
              fontSize: 10, textAlign: 'center', minWidth: 70,
            }}>
              <div style={{ color: reached ? C.yellow : C.muted }}>₹{level}</div>
              <div style={{ color: reached ? C.green : C.muted, fontWeight: 700 }}>
                lock ₹{locks[i]}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <div>Locked: <span style={{ color: C.green, fontWeight: 700 }}>₹{lockedProfit || 0}</span></div>
        <div>Trail SL: <span style={{ color: C.red, fontWeight: 700 }}>₹{trailSL || '-'}</span></div>
        <div>Current P&L: <span style={{ color: pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>
          {pnl >= 0 ? '+' : ''}₹{pnl?.toFixed(0) || 0}
        </span></div>
      </div>
    </div>
  );
};

// ── Main Page ──────────────────────────
export default function DeltaNeutralPage() {
  const [status,   setStatus]   = useState(null);
  const [running,  setRunning]  = useState(false);
  const [position, setPosition] = useState(null);
  const [history,  setHistory]  = useState([]);
  const [logs,     setLogs]     = useState([]);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [{
      id: Date.now(), time: new Date().toLocaleTimeString('en-IN'), msg, type
    }, ...prev].slice(0, 50));
  };

  useEffect(() => { fetchStatus(); }, []);

  useEffect(() => {
    const interval = setInterval(fetchStatus, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await api.get('/api/delta-neutral/status');
      if (res.data.success) {
        const s = res.data.status;
        setRunning(s.running);
        setPosition(s.position?.status !== 'IDLE' ? s.position : null);
        setHistory(s.history || []);
      }
    } catch (err) {
      addLog('Could not fetch status', 'error');
    }
  };

  const handleStart = async () => {
    try {
      await api.post('/api/delta-neutral/start');
      setRunning(true);
      addLog('▶️ Delta Neutral engine started', 'success');
    } catch (err) { addLog('Failed to start', 'error'); }
  };

  const handleStop = async () => {
    try {
      await api.post('/api/delta-neutral/stop');
      setRunning(false);
      addLog('⏹️ Delta Neutral engine stopped', 'info');
    } catch (err) { addLog('Failed to stop', 'error'); }
  };

  const handleExitAll = async () => {
    if (!window.confirm('Exit ALL legs?')) return;
    try {
      await api.post('/api/delta-neutral/exit-all');
      addLog('All legs exit triggered', 'warning');
      fetchStatus();
    } catch (err) { addLog('Exit failed', 'error'); }
  };

  const handleExitLeg = async (legKey) => {
    const paired = {
      callBuy:  ['callBuy', 'callSell'],
      putBuy:   ['putBuy', 'putSell'],
      callSell: ['callSell'],
      putSell:  ['putSell'],
    };
    const legs = paired[legKey];
    if (!window.confirm(`Exit: ${legs.join(' + ')}?`)) return;
    try {
      await api.post('/api/delta-neutral/exit-legs', { legs, reason: 'MANUAL_EXIT' });
      addLog(`Exited: ${legs.join(', ')}`, 'warning');
      fetchStatus();
    } catch (err) { addLog('Exit failed', 'error'); }
  };

  const totalPnl = history.reduce((s, t) => s + (t.pnl || 0), 0);
  const winners  = history.filter(t => t.pnl > 0);
  const winRate  = history.length ? (winners.length / history.length * 100).toFixed(1) : 0;

  const logColors = { success: C.green, error: C.red, warning: C.orange, info: C.muted };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: 'monospace', padding: 20 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: '#fff' }}>⚖️ Delta Neutral Spread</h1>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: C.muted }}>
            SENSEX | Friday 3:20 PM Entry | Thursday Expiry | Overnight Hold
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!running
            ? <button style={s.btn(C.green)} onClick={handleStart}>▶ Start</button>
            : <button style={s.btn(C.muted)} onClick={handleStop}>⏹ Stop</button>
          }
          {position && <button style={s.btn(C.red, true)} onClick={handleExitAll}>🚨 Exit All</button>}
          <button style={s.btn(C.blue, true)} onClick={fetchStatus}>↻ Refresh</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={s.row}>
        {[
          { label: 'Net P&L',  value: `₹${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? C.green : C.red },
          { label: 'Win Rate', value: `${winRate}%`,              color: C.yellow },
          { label: 'Trades',   value: history.length,             color: C.text },
          { label: 'Engine',   value: running ? 'RUNNING' : 'STOPPED', color: running ? C.green : C.muted },
          { label: 'Mode',     value: 'PAPER',                    color: C.yellow },
        ].map(k => (
          <div key={k.label} style={{ ...s.card, flex: 1, minWidth: 120, marginBottom: 0 }}>
            <div style={s.label}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Strategy rules */}
      <div style={{ ...s.card, borderLeft: `3px solid ${C.teal}` }}>
        <div style={s.label}>Strategy Rules</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 11, color: C.muted, lineHeight: 2 }}>
          <div>
            <div style={{ color: C.teal, fontWeight: 700, marginBottom: 2 }}>Entry</div>
            <div>📅 Friday 3:20 PM</div>
            <div>📊 SENSEX options</div>
            <div>🎯 Buy 0.50 delta (ATM)</div>
            <div>🎯 Sell 0.40 delta (near OTM)</div>
            <div>⚖️ Net delta ≈ 0</div>
            <div>📦 Lot size: 20</div>
          </div>
          <div>
            <div style={{ color: C.red, fontWeight: 700, marginBottom: 2 }}>Stop Loss</div>
            <div>🔴 Combined 60% loss → exit ALL (sell first)</div>
            <div>🔴 Call Buy -60% → exit Call Buy + Call Sell</div>
            <div>🔴 Put Buy  -60% → exit Put Buy  + Put Sell</div>
            <div>🔴 Call Sell +60% → exit Call Sell only</div>
            <div>🔴 Put Sell  +60% → exit Put Sell only</div>
            <div>📍 Final: one buy leg remains alone</div>
          </div>
          <div>
            <div style={{ color: C.yellow, fontWeight: 700, marginBottom: 2 }}>Trailing (last buy leg)</div>
            <div>₹1,000 profit → lock ₹250</div>
            <div>₹2,000 profit → lock ₹1,000</div>
            <div>₹3,000 profit → lock ₹1,750</div>
            <div>₹4,000 profit → lock ₹2,500</div>
            <div>Every +₹1,000 → lock +₹750 more</div>
            <div>No exit limit — keep trailing!</div>
          </div>
          <div>
            <div style={{ color: C.green, fontWeight: 700, marginBottom: 2 }}>Hold Period</div>
            <div>📅 Friday night</div>
            <div>📅 Saturday (closed)</div>
            <div>📅 Sunday (closed)</div>
            <div>📊 Monitor Monday 9:15 AM+</div>
            <div>📅 Expiry: Thursday</div>
          </div>
        </div>
      </div>

      {/* Position */}
      {!position && (
        <div style={{ ...s.card, textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div style={{ color: C.muted, fontSize: 13 }}>No active position</div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>
            Engine will enter automatically at Friday 3:20 PM
          </div>
        </div>
      )}

      {position && (
        <>
          {/* Position header */}
          <div style={{ ...s.card, borderLeft: `3px solid ${C.teal}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={s.label}>Position Status</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={s.tag(position.status === 'ACTIVE' ? C.green : position.status === 'PARTIAL' ? C.orange : C.muted)}>
                    {position.status}
                  </span>
                  {position.lastBuyLeg && (
                    <span style={s.tag(C.yellow)}>Last leg: {position.lastBuyLeg}</span>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.8 }}>
                <div>Entry: {position.entryDate} {position.entryTime}</div>
                <div>Expiry: {position.expiryDate}</div>
                <div>Spot at entry: {position.spotAtEntry}</div>
                <div>Net delta: <span style={{ color: C.yellow }}>{position.netDelta}</span></div>
              </div>
              <div>
                <div style={s.label}>Net Debit</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>₹{position.netDebit}</div>
                <div style={{ fontSize: 11, color: C.muted }}>Combined SL: ₹{position.combinedSL}</div>
              </div>
              <div>
                <div style={s.label}>Current P&L</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: position.pnl >= 0 ? C.green : C.red }}>
                  {position.pnl >= 0 ? '+' : ''}₹{position.pnl?.toFixed(0) || 0}
                </div>
              </div>
            </div>
          </div>

          {/* Leg cards */}
          <div style={s.row}>
            {['callBuy', 'callSell', 'putBuy', 'putSell'].map(legKey => (
              <LegCard
                key={legKey}
                legKey={legKey}
                leg={position.legs[legKey]}
                onExit={handleExitLeg}
              />
            ))}
          </div>

          {/* Trail progress — only when last buy leg */}
          {position.lastBuyLeg && (
            <TrailProgress
              lockedProfit={position.lockedProfit}
              trailSL={position.trailSL}
              pnl={position.pnl}
            />
          )}

          {/* Alerts */}
          {position.alerts?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {position.alerts.map((a, i) => (
                <div key={i} style={{
                  background: a.severity === 'CRITICAL' ? C.red + '15' : a.severity === 'HIGH' ? C.orange + '15' : C.blue + '15',
                  border: `1px solid ${a.severity === 'CRITICAL' ? C.red : a.severity === 'HIGH' ? C.orange : C.blue}44`,
                  borderRadius: 8, padding: '10px 12px', marginBottom: 6,
                  fontSize: 12,
                  color: a.severity === 'CRITICAL' ? C.red : a.severity === 'HIGH' ? C.orange : C.blue,
                }}>
                  {a.message}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Logs + History */}
      <div style={s.row}>

        {/* Live log */}
        <div style={{ ...s.card, flex: 1, minWidth: 280 }}>
          <div style={s.label}>Live Log</div>
          <div style={{ height: 200, overflowY: 'auto', fontSize: 11 }}>
            {logs.length === 0 && <div style={{ color: C.muted }}>Waiting for activity...</div>}
            {logs.map(log => (
              <div key={log.id} style={{ marginBottom: 4, paddingBottom: 4, borderBottom: `1px solid ${C.border}22` }}>
                <span style={{ color: C.muted }}>[{log.time}] </span>
                <span style={{ color: logColors[log.type] || C.text }}>{log.msg}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Trade history */}
        <div style={{ ...s.card, flex: 2, minWidth: 300 }}>
          <div style={s.label}>Trade History</div>
          {history.length === 0
            ? <div style={{ color: C.muted, fontSize: 12 }}>No closed trades yet</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {['Entry','Expiry','Net Debit','Delta','Reason','P&L'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', color: C.muted, textAlign: 'left', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((t, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}22` }}>
                        <td style={{ padding: '6px 10px' }}>{t.entryDate}</td>
                        <td style={{ padding: '6px 10px' }}>{t.expiryDate}</td>
                        <td style={{ padding: '6px 10px', color: C.red }}>₹{t.netDebit}</td>
                        <td style={{ padding: '6px 10px', color: C.yellow }}>{t.netDelta}</td>
                        <td style={{ padding: '6px 10px', color: C.muted }}>{t.closeReason}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                          {t.pnl >= 0 ? '+' : ''}₹{t.pnl?.toFixed(0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </div>
      </div>
    </div>
  );
}
