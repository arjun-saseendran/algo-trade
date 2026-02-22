import React, { useEffect, useState, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../utils/api';

const C = {
  bg: '#07090f', card: '#111820', border: '#1c2a3a',
  green: '#22d3a0', rose: '#f43f5e', muted: '#4b6278', text: '#e2e8f0',
};

export default function CombinedDashboard() {
  const [viewMode, setViewMode] = useState('backtest'); 
  const [data, setData] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Memoized fetch function to reuse in useEffect and manual refresh
  const fetchData = useCallback(() => {
    api.get(`/api/combined-results?mode=${viewMode}`)
      .then(r => {
        setData(r.data);
        setLastRefresh(new Date());
      })
      .catch(err => console.error("Fetch Error:", err));
  }, [viewMode]);

  useEffect(() => {
    fetchData(); // Initial fetch

    // AUTO-REFRESH: Set interval to 60 seconds
    const interval = setInterval(() => {
      if (viewMode === 'live') { // Only auto-refresh if looking at live paper trades
        fetchData();
      }
    }, 60000); 

    return () => clearInterval(interval); // Cleanup on unmount
  }, [fetchData, viewMode]);

  if (!data) return <div style={{ color: C.muted, padding: 40, fontFamily: 'monospace' }}>Syncing with MongoDB...</div>;

  const chartData = Object.entries(data.monthly)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, pnl]) => ({ month, pnl }));

  return (
    <div style={{ background: C.bg, minHeight: 'calc(100vh - 60px)', padding: 40, color: C.text, fontFamily: 'monospace' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        
        {/* Header & Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
          <div>
            <h1 style={{ fontSize: 24, margin: 0 }}>Master Portfolio</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <p style={{ color: C.muted, fontSize: 11, margin: 0 }}>Source: {data.source}</p>
              <span style={{ color: C.muted, fontSize: 11 }}>•</span>
              <p style={{ color: C.muted, fontSize: 11, margin: 0 }}>
                Refreshed: {lastRefresh.toLocaleTimeString()}
              </p>
            </div>
          </div>
          
          <div style={{ display: 'flex', background: C.card, borderRadius: 8, padding: 4, border: `1px solid ${C.border}` }}>
            {['backtest', 'live'].map(mode => (
              <button 
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  background: viewMode === mode ? C.green + '22' : 'transparent',
                  color: viewMode === mode ? C.green : C.muted,
                  border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
                  fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                  transition: 'all 0.2s ease'
                }}
              >
                {mode === 'backtest' ? '🔬 Backtest' : '● Live Paper'}
              </button>
            ))}
          </div>
        </div>

        {/* Big PnL Card */}
        <div style={{ 
          background: `linear-gradient(145deg, ${C.card}, #161f2a)`, 
          padding: 40, 
          borderRadius: 20, 
          border: `1px solid ${C.border}`, 
          marginBottom: 30, 
          textAlign: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
        }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, fontWeight: 700, letterSpacing: 1.5 }}>NET PORTFOLIO P&L</div>
          <div style={{ fontSize: 64, fontWeight: 900, color: data.totalPnl >= 0 ? C.green : C.rose }}>
            ₹{data.totalPnl.toLocaleString()}
          </div>
          {viewMode === 'live' && (
            <div style={{ marginTop: 10, fontSize: 10, color: C.green, opacity: 0.8 }}>
              Auto-updating every 60s...
            </div>
          )}
        </div>

        {/* Equity Curve */}
        <div style={{ background: C.card, padding: 30, borderRadius: 16, border: `1px solid ${C.border}`, marginBottom: 30 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 25 }}>TOTAL EQUITY GROWTH</div>
          <div style={{ height: 350 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2a3a" vertical={false} />
                <XAxis dataKey="month" stroke={C.muted} fontSize={10} axisLine={false} tickLine={false} />
                <YAxis stroke={C.muted} fontSize={10} axisLine={false} tickLine={false} />
                <Tooltip 
                  contentStyle={{ background: '#07090f', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                  itemStyle={{ fontWeight: 'bold' }}
                />
                <Line 
                  type="stepAfter" 
                  dataKey="pnl" 
                  stroke={C.green} 
                  strokeWidth={4} 
                  dot={{ r: 5, fill: C.green, stroke: C.bg, strokeWidth: 2 }} 
                  activeDot={{ r: 8 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Table breakdown logic remains same as previous version... */}
      </div>
    </div>
  );
}