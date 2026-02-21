import React, { useState, useEffect } from 'react';
import api from './utils/api';
import { SocketProvider }  from './context/SocketContext';
import Dashboard           from './components/Dashboard';
import LoginPage           from './components/LoginPage';
import IronCondorPage      from './components/IronCondorPage';
import DeltaNeutralPage    from './components/DeltaNeutralPage';
import BacktestPage        from './components/BacktestPage';

const C = {
  bg: '#07090f', card: '#111820', border: '#1c2a3a',
  green: '#22d3a0', purple: '#a78bfa', teal: '#2dd4bf',
  amber: '#f5a623', muted: '#4b6278', text: '#e2e8f0',
};

const TABS = [
  { key: 'scalping',     label: '📈 ATM Scalping',   color: C.green  },
  { key: 'ironcondor',   label: '🦅 Iron Condor',     color: C.purple },
  { key: 'deltaneutral', label: '⚖️ Delta Neutral',   color: C.teal   },
  { key: 'backtest',     label: '🔬 Backtest',         color: C.amber  },
];

export default function App() {
  const [kiteConnected, setKiteConnected] = useState(false);
  const [checking,      setChecking]      = useState(true);
  const [userName,      setUserName]      = useState('');
  const [page,          setPage]          = useState('scalping');

  useEffect(() => {
    api.get('/api/auth/status')
      .then(r => { setKiteConnected(r.data.connected); setChecking(false); })
      .catch(() => setChecking(false));
  }, []);

  if (checking) return (
    <div style={{ background: C.bg, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontFamily: 'monospace' }}>
      Connecting...
    </div>
  );

  if (!kiteConnected) return (
    <SocketProvider>
      <LoginPage onLoginSuccess={(d) => { setKiteConnected(true); setUserName(d.userName || ''); }} />
    </SocketProvider>
  );

  return (
    <SocketProvider>
      {/* Nav */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'monospace', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, marginRight: 8 }}>🤖</span>
        <span style={{ color: C.text, fontWeight: 700, fontSize: 14, marginRight: 16 }}>Algo Trader</span>

        {TABS.map(tab => (
          <button key={tab.key} onClick={() => setPage(tab.key)} style={{
            background:   page === tab.key ? tab.color + '22' : 'transparent',
            color:        page === tab.key ? tab.color : C.muted,
            border:       `1px solid ${page === tab.key ? tab.color + '44' : 'transparent'}`,
            borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
            fontFamily: 'monospace', fontWeight: 700, fontSize: 12,
          }}>
            {tab.label}
          </button>
        ))}

        <div style={{ marginLeft: 'auto', fontSize: 11, color: C.muted }}>
          {userName && <span>👤 {userName}&nbsp;&nbsp;</span>}
          <span style={{ background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 6, padding: '2px 8px', fontSize: 11 }}>
            ● Kite Connected
          </span>
        </div>
      </div>

      {page === 'scalping'     && <Dashboard userName={userName} />}
      {page === 'ironcondor'   && <IronCondorPage />}
      {page === 'deltaneutral' && <DeltaNeutralPage />}
      {page === 'backtest'     && <BacktestPage />}
    </SocketProvider>
  );
}
