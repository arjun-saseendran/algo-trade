import React, { useState, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
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
  text:    '#e2e8f0',
  muted:   '#4b6278',
};

const s = {
  card:   { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 12 },
  label:  { fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 },
  row:    { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  btn:    (color, outline) => ({
    background:  outline ? 'transparent' : color,
    color:       outline ? color : '#000',
    border:      `1px solid ${color}`,
    borderRadius: 8, padding: '8px 16px',
    cursor: 'pointer', fontWeight: 700,
    fontSize: 12, fontFamily: 'monospace',
  }),
  tag:    (color) => ({
    background: color + '22', color,
    border: `1px solid ${color}44`,
    borderRadius: 6, padding: '2px 8px',
    fontSize: 11, fontWeight: 700,
  }),
  badge:  (on) => ({
    width: 8, height: 8, borderRadius: '50%',
    background: on ? C.green : C.muted,
    display: 'inline-block', marginRight: 6,
  }),
};

// ── Progress bar ───────────────────────
const ProgressBar = ({ value, max, color, label }) => {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.muted, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color }}>{value?.toFixed(1)}x / {pct.toFixed(0)}%</span>
      </div>
      <div style={{ background: C.border, borderRadius: 4, height: 6 }}>
        <div style={{ width: `${pct}%`, background: color, borderRadius: 4, height: 6, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
};

// ── Position card for one index ────────
const PositionCard = ({ index, position, onRoll, onIronFly, onClose }) => {
  const isActive  = position?.status === 'ACTIVE' || position?.status === 'ADJUSTING';
  const isIdle    = !position || position?.status === 'IDLE';
  const color     = index === 'NIFTY' ? C.blue : C.purple;

  const pnlColor  = !position?.pnl ? C.muted
    : position.pnl >= 0 ? C.green : C.red;

  const alerts    = position?.alerts || [];
  const criticals = alerts.filter(a => a.severity === 'CRITICAL');
  const highs     = alerts.filter(a => a.severity === 'HIGH');
  const infos     = alerts.filter(a => a.severity === 'INFO');

  return (
    <div style={{ ...s.card, borderLeft: `3px solid ${color}`, flex: 1, minWidth: 320 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 800, color }}>{index}</span>
          <span style={s.tag(isActive ? C.green : C.muted)}>
            {position?.status || 'IDLE'}
          </span>
          {position?.isIronFly && <span style={s.tag(C.orange)}>🦋 IRON FLY</span>}
          {position?.paperTrade !== false && isActive && <span style={s.tag(C.yellow)}>PAPER</span>}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          {index === 'NIFTY' ? 'Entry: Monday 9:30 AM' : 'Entry: Wednesday 9:30 AM'}
        </div>
      </div>

      {/* IDLE state */}
      {isIdle && (
        <div style={{ color: C.muted, fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div>Waiting for entry day</div>
          <div style={{ marginTop: 4 }}>
            {index === 'NIFTY' ? 'Monday 9:30 AM' : 'Wednesday 9:30 AM'}
          </div>
        </div>
      )}

      {/* Active position */}
      {isActive && position && (
        <>
          {/* P&L */}
          <div style={{ ...s.row, marginBottom: 16 }}>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>MTM P&L</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: pnlColor }}>
                {position.pnl >= 0 ? '+' : ''}₹{position.pnl?.toFixed(0) || 0}
              </div>
            </div>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>Total Credit</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
                ₹{position.totalCredit?.toFixed(2) || 0}
              </div>
            </div>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>Max Loss</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.red }}>
                {position.maxLossPct?.toFixed(1) || 0}%
              </div>
              <div style={{ fontSize: 10, color: C.muted }}>Hold till expiry</div>
            </div>
          </div>

          {/* Legs */}
          <div style={s.row}>

            {/* Call spread */}
            <div style={{ ...s.card, flex: 1, margin: 0, borderLeft: `2px solid ${C.red}`, background: C.surface }}>
              <div style={s.label}>📞 Call Spread</div>
              <div style={{ fontSize: 12, lineHeight: 2 }}>
                <div>Sell: <span style={{ color: C.text }}>{position.callSpread?.sellStrike}</span>
                  &nbsp;@ ₹<span style={{ color: C.green }}>{position.callSpread?.sellPremium}</span>
                </div>
                <div>Buy: &nbsp;<span style={{ color: C.text }}>{position.callSpread?.buyStrike}</span>
                  &nbsp;@ ₹<span style={{ color: C.red }}>{position.callSpread?.buyPremium}</span>
                </div>
                <div>Net: &nbsp;<span style={{ color: C.green }}>₹{position.callSpread?.netCredit}</span></div>
                <div>Now: &nbsp;<span style={{ color: C.text }}>₹{position.callSpread?.currentPremium?.toFixed(2) || '-'}</span></div>
              </div>
              {position.callSpread?.expansion && (
                <div style={{ marginTop: 8 }}>
                  <ProgressBar
                    value={position.callSpread.expansion}
                    max={4}
                    color={position.callSpread.expansion >= 3 ? C.red : position.callSpread.expansion >= 2 ? C.orange : C.green}
                    label="Expansion"
                  />
                  <ProgressBar
                    value={position.callSpread.decay * 100}
                    max={100}
                    color={C.green}
                    label="Decay %"
                  />
                </div>
              )}
            </div>

            {/* Put spread */}
            <div style={{ ...s.card, flex: 1, margin: 0, borderLeft: `2px solid ${C.green}`, background: C.surface }}>
              <div style={s.label}>📉 Put Spread</div>
              <div style={{ fontSize: 12, lineHeight: 2 }}>
                <div>Sell: <span style={{ color: C.text }}>{position.putSpread?.sellStrike}</span>
                  &nbsp;@ ₹<span style={{ color: C.green }}>{position.putSpread?.sellPremium}</span>
                </div>
                <div>Buy: &nbsp;<span style={{ color: C.text }}>{position.putSpread?.buyStrike}</span>
                  &nbsp;@ ₹<span style={{ color: C.red }}>{position.putSpread?.buyPremium}</span>
                </div>
                <div>Net: &nbsp;<span style={{ color: C.green }}>₹{position.putSpread?.netCredit}</span></div>
                <div>Now: &nbsp;<span style={{ color: C.text }}>₹{position.putSpread?.currentPremium?.toFixed(2) || '-'}</span></div>
              </div>
              {position.putSpread?.expansion && (
                <div style={{ marginTop: 8 }}>
                  <ProgressBar
                    value={position.putSpread.expansion}
                    max={4}
                    color={position.putSpread.expansion >= 3 ? C.red : position.putSpread.expansion >= 2 ? C.orange : C.green}
                    label="Expansion"
                  />
                  <ProgressBar
                    value={position.putSpread.decay * 100}
                    max={100}
                    color={C.green}
                    label="Decay %"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Rolls used */}
          <div style={{ ...s.row, marginBottom: 12 }}>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>System Rolls</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: position.systemRolls >= 1 ? C.orange : C.green }}>
                {position.systemRolls} / 1
              </div>
            </div>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>Discretionary Rolls</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: position.discretionaryRolls >= 1 ? C.orange : C.green }}>
                {position.discretionaryRolls} / 1
              </div>
            </div>
            <div style={{ ...s.card, flex: 1, margin: 0, background: C.surface }}>
              <div style={s.label}>Total Rolls</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: (position.systemRolls + position.discretionaryRolls) >= 2 ? C.red : C.green }}>
                {(position.systemRolls || 0) + (position.discretionaryRolls || 0)} / 2
              </div>
            </div>
          </div>

          {/* Alerts */}
          {alerts.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {criticals.map((a, i) => (
                <div key={i} style={{ background: C.red + '15', border: `1px solid ${C.red}44`, borderRadius: 8, padding: '10px 12px', marginBottom: 6, fontSize: 12, color: C.red }}>
                  🚨 {a.message}
                </div>
              ))}
              {highs.map((a, i) => (
                <div key={i} style={{ background: C.orange + '15', border: `1px solid ${C.orange}44`, borderRadius: 8, padding: '10px 12px', marginBottom: 6, fontSize: 12, color: C.orange }}>
                  🔔 {a.message}
                </div>
              ))}
              {infos.map((a, i) => (
                <div key={i} style={{ background: C.blue + '15', border: `1px solid ${C.blue}44`, borderRadius: 8, padding: '10px 12px', marginBottom: 6, fontSize: 12, color: C.blue }}>
                  💡 {a.message}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {position.systemRolls < 1 && (
              <>
                <button style={s.btn(C.orange, true)} onClick={() => onRoll(index, 'system', 'CALL')}>
                  Roll CALL (System)
                </button>
                <button style={s.btn(C.orange, true)} onClick={() => onRoll(index, 'system', 'PUT')}>
                  Roll PUT (System)
                </button>
              </>
            )}
            {position.discretionaryRolls < 1 && (
              <>
                <button style={s.btn(C.blue, true)} onClick={() => onRoll(index, 'discretionary', 'CALL')}>
                  Roll CALL (Disc.)
                </button>
                <button style={s.btn(C.blue, true)} onClick={() => onRoll(index, 'discretionary', 'PUT')}>
                  Roll PUT (Disc.)
                </button>
              </>
            )}
            {!position.isIronFly && (
              <button style={s.btn(C.purple, true)} onClick={() => onIronFly(index)}>
                🦋 Convert Iron Fly
              </button>
            )}
            <button style={s.btn(C.red, true)} onClick={() => onClose(index)}>
              Close Position
            </button>
          </div>

          {/* Adjustments log */}
          {position.adjustments?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={s.label}>Adjustments Log</div>
              {position.adjustments.map((a, i) => (
                <div key={i} style={{ fontSize: 11, color: C.muted, padding: '3px 0', borderBottom: `1px solid ${C.border}22` }}>
                  [{a.time}] {a.type} — {a.side || ''}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── Main Iron Condor Page ──────────────
export default function IronCondorPage() {
  const { connected } = useSocket();
  const [status,    setStatus]    = useState(null);
  const [logs,      setLogs]      = useState([]);
  const [running,   setRunning]   = useState(false);
  const [positions, setPositions] = useState({ NIFTY: null, SENSEX: null });
  const [history,   setHistory]   = useState([]);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [{
      id: Date.now(), time: new Date().toLocaleTimeString('en-IN'), msg, type
    }, ...prev].slice(0, 50));
  };

  // Fetch status on load
  useEffect(() => {
    fetchStatus();
  }, [connected]);

  // Listen to socket events
  useEffect(() => {
    if (!window._icSocket) return;
    const socket = window._icSocket;

    socket.on('ic_position_opened',  (d) => { addLog(d.message, 'success'); fetchStatus(); });
    socket.on('ic_position_update',  (d) => { setPositions(prev => ({ ...prev, [d.index]: d.position })); });
    socket.on('ic_position_closed',  (d) => { addLog(`Position closed: ${d.index}`, 'info'); fetchStatus(); });
    socket.on('ic_alert',            (d) => { addLog(`[${d.index}] ${d.alert.message}`, d.alert.severity === 'CRITICAL' ? 'error' : 'warning'); });
    socket.on('ic_roll_recorded',    (d) => { addLog(`Roll recorded: ${d.index} ${d.type} ${d.side}`, 'info'); fetchStatus(); });
    socket.on('ic_iron_fly',         (d) => { addLog(d.message, 'info'); fetchStatus(); });
    socket.on('ic_engine_status',    (d) => { setRunning(d.running); });
    socket.on('ic_error',            (d) => { addLog(`❌ ${d.message}`, 'error'); });
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await api.get('/api/iron-condor/status');
      if (res.data.success) {
        const s = res.data.status;
        setRunning(s.running);
        setPositions(s.positions || { NIFTY: null, SENSEX: null });
        setHistory(s.history   || []);
      }
    } catch (err) {
      addLog('Could not fetch status', 'error');
    }
  };

  const handleStart = async () => {
    try {
      await api.post('/api/iron-condor/start');
      setRunning(true);
      addLog('▶️ Iron Condor engine started', 'success');
    } catch (err) { addLog('Failed to start', 'error'); }
  };

  const handleStop = async () => {
    try {
      await api.post('/api/iron-condor/stop');
      setRunning(false);
      addLog('⏹️ Iron Condor engine stopped', 'info');
    } catch (err) { addLog('Failed to stop', 'error'); }
  };

  const handleRoll = async (index, type, side) => {
    try {
      await api.post('/api/iron-condor/roll', { index, type, side });
      addLog(`Roll recorded: ${index} ${type} ${side}`, 'info');
      fetchStatus();
    } catch (err) { addLog('Roll failed', 'error'); }
  };

  const handleIronFly = async (index) => {
    if (!window.confirm(`Convert ${index} to Iron Butterfly?`)) return;
    try {
      await api.post('/api/iron-condor/iron-fly', { index });
      addLog(`🦋 ${index} converted to Iron Butterfly`, 'info');
      fetchStatus();
    } catch (err) { addLog('Conversion failed', 'error'); }
  };

  const handleClose = async (index) => {
    if (!window.confirm(`Close ${index} position?`)) return;
    const pnl = positions[index]?.pnl || 0;
    try {
      await api.post('/api/iron-condor/close', { index, reason: 'MANUAL_CLOSE', pnl });
      addLog(`Position closed: ${index}`, 'info');
      fetchStatus();
    } catch (err) { addLog('Close failed', 'error'); }
  };

  // Stats
  const totalPnl  = history.reduce((s, t) => s + (t.pnl || 0), 0);
  const winners   = history.filter(t => t.pnl > 0);
  const losers    = history.filter(t => t.pnl < 0);
  const winRate   = history.length ? (winners.length / history.length * 100).toFixed(1) : 0;

  const logColors = { success: C.green, error: C.red, warning: C.orange, info: C.muted };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: 'monospace', padding: 20 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: '#fff' }}>🦅 Iron Condor</h1>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            <span style={s.badge(connected)} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!running
            ? <button style={s.btn(C.green)} onClick={handleStart}>▶ Start</button>
            : <button style={s.btn(C.muted)} onClick={handleStop}>⏹ Stop</button>
          }
          <button style={s.btn(C.blue, true)} onClick={fetchStatus}>↻ Refresh</button>
        </div>
      </div>

      {/* KPI row */}
      <div style={s.row}>
        {[
          { label: 'Net P&L',   value: `₹${totalPnl.toFixed(0)}`,  color: totalPnl >= 0 ? C.green : C.red },
          { label: 'Win Rate',  value: `${winRate}%`,               color: C.yellow },
          { label: 'Total',     value: history.length,              color: C.text },
          { label: 'Winners',   value: winners.length,              color: C.green },
          { label: 'Losers',    value: losers.length,               color: C.red },
          { label: 'Engine',    value: running ? 'RUNNING' : 'STOPPED', color: running ? C.green : C.muted },
        ].map(k => (
          <div key={k.label} style={{ ...s.card, flex: 1, minWidth: 120, marginBottom: 0 }}>
            <div style={s.label}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Strategy rules reminder */}
      <div style={{ ...s.card, borderLeft: `3px solid ${C.muted}`, marginBottom: 12 }}>
        <div style={s.label}>Strategy Rules</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 11, color: C.muted, lineHeight: 2 }}>
          <div>
            <div style={{ color: C.blue, fontWeight: 700, marginBottom: 2 }}>Entry</div>
            <div>📅 NIFTY → Monday 9:30 AM</div>
            <div>📅 SENSEX → Wednesday 9:30 AM</div>
            <div>📍 Sell both sides @ 0.5% OTM</div>
            <div>🛡️ Hedge: NIFTY +150 pts | SENSEX +500 pts</div>
          </div>
          <div>
            <div style={{ color: C.orange, fontWeight: 700, marginBottom: 2 }}>Adjustments</div>
            <div>🔔 One side 3x + other 70% decay → Roll</div>
            <div>🚨 One side 4x → Exit that spread</div>
            <div>📊 Max 1 system roll per day</div>
            <div>💡 Max 1 discretionary roll on expiry</div>
          </div>
          <div>
            <div style={{ color: C.red, fontWeight: 700, marginBottom: 2 }}>Risk</div>
            <div>⚠️ Max loss 6% → DO NOT EXIT</div>
            <div>🌊 Gap open → Wait, hold position</div>
            <div>🦋 Slow grind to ATM → Iron Fly</div>
            <div>⏰ Let expiry decide if max loss hit</div>
          </div>
          <div>
            <div style={{ color: C.green, fontWeight: 700, marginBottom: 2 }}>P&L Targets</div>
            <div>✅ No adjustment → +1.0%</div>
            <div>✅ One roll → +1.4%</div>
            <div>❌ One SL → -0.5%</div>
            <div>❌ Two SL → -2.5%</div>
          </div>
        </div>
      </div>

      {/* Position cards */}
      <div style={s.row}>
        <PositionCard
          index="NIFTY"
          position={positions.NIFTY}
          onRoll={handleRoll}
          onIronFly={handleIronFly}
          onClose={handleClose}
        />
        <PositionCard
          index="SENSEX"
          position={positions.SENSEX}
          onRoll={handleRoll}
          onIronFly={handleIronFly}
          onClose={handleClose}
        />
      </div>

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
            ? <div style={{ color: C.muted, fontSize: 12 }}>No closed positions yet</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {['Index','Entry','Expiry','Credit','Rolls','Reason','P&L'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', color: C.muted, textAlign: 'left', fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((t, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}22` }}>
                        <td style={{ padding: '6px 10px' }}><span style={s.tag(t.index === 'NIFTY' ? C.blue : C.purple)}>{t.index}</span></td>
                        <td style={{ padding: '6px 10px' }}>{t.entryDate?.split(' ')[0]}</td>
                        <td style={{ padding: '6px 10px' }}>{t.expiryDate}</td>
                        <td style={{ padding: '6px 10px', color: C.green }}>₹{t.totalCredit}</td>
                        <td style={{ padding: '6px 10px' }}>{(t.systemRolls || 0) + (t.discretionaryRolls || 0)}</td>
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
