import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const C = {
  bg: '#07090f', card: '#111820', border: '#1c2a3a',
  green: '#22d3a0', rose: '#f43f5e', muted: '#4b6278', text: '#e2e8f0',
};

export default function TradeHistory() {
  const [trades, setTrades] = useState([]);

  useEffect(() => {
    api.get('/api/trades/history')
      .then(r => setTrades(r.data))
      .catch(err => console.error("History fetch error", err));
  }, []);

  return (
    <div style={{ background: C.bg, minHeight: 'calc(100vh - 60px)', padding: 30, color: C.text, fontFamily: 'monospace' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h2 style={{ marginBottom: 20, fontSize: 18 }}>📜 Detailed Trade History</h2>
        
        <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#161f2a', color: C.muted, textAlign: 'left' }}>
                <th style={{ padding: '15px 20px' }}>DATE / STRATEGY</th>
                <th style={{ padding: '15px 20px' }}>INSTRUMENTS & LEGS</th>
                <th style={{ padding: '15px 20px', textAlign: 'right' }}>ENTRY/EXIT SPOT</th>
                <th style={{ padding: '15px 20px', textAlign: 'right' }}>FINAL P&L</th>
                <th style={{ padding: '15px 20px' }}>REASON</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => (
                <tr key={t._id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: 20, verticalAlign: 'top' }}>
                    <div style={{ color: C.text, fontWeight: 700 }}>{new Date(t.entryDate).toLocaleDateString()}</div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{t.strategy.toUpperCase()} | {t.index}</div>
                  </td>
                  
                  <td style={{ padding: 20 }}>
                    {t.legs.map((leg, idx) => (
                      <div key={idx} style={{ marginBottom: 4, display: 'flex', gap: 10 }}>
                        <span style={{ color: leg.type === 'BUY' ? '#3b82f6' : '#f59e0b', width: 40 }}>{leg.type}</span>
                        <span style={{ color: C.text, width: 180 }}>{leg.symbol}</span>
                        <span style={{ color: C.muted }}>@{leg.entryPremium}</span>
                        {leg.exitPremium && <span style={{ color: C.green }}>→ {leg.exitPremium}</span>}
                      </div>
                    ))}
                  </td>

                  <td style={{ padding: 20, textAlign: 'right', verticalAlign: 'top' }}>
                    <div style={{ color: C.text }}>{t.entryPrice}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>{t.exitPrice || 'Active'}</div>
                  </td>

                  <td style={{ padding: 20, textAlign: 'right', verticalAlign: 'top', fontWeight: 700, color: t.pnl >= 0 ? C.green : C.rose }}>
                    ₹{t.pnl.toLocaleString()}
                  </td>

                  <td style={{ padding: 20, verticalAlign: 'top', color: C.muted, maxWidth: 150 }}>
                    {t.closeReason || (t.status === 'ACTIVE' ? 'RUNNING' : 'N/A')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}