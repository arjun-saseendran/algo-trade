import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const C = {
  bg:'#08090d', surface:'#0f1117', card:'#13151e', border:'#1e2133',
  green:'#4ade80', red:'#f87171', amber:'#fbbf24', blue:'#60a5fa',
  purple:'#c084fc', teal:'#2dd4bf', muted:'#3d4260', dim:'#5a5f7a', text:'#e2e6f3',
};

const STRATEGIES = [
  { key:'scalping',     label:'ATM Scalping',  icon:'📈', color:C.green  },
  { key:'ironcondor',   label:'Iron Condor',    icon:'🦅', color:C.purple },
  { key:'deltaneutral', label:'Delta Neutral',  icon:'⚖️', color:C.teal   },
];

const MiniChart = ({ trades, color }) => {
  if (!trades?.length) return <div style={{ height:60, background:C.surface, borderRadius:6 }} />;
  const W=200, H=60, PAD=8;
  let running=0;
  const pts = trades.map((t,i) => { running+=t.pnl; return { x:i, y:running }; });
  const minY=Math.min(0,...pts.map(p=>p.y)), maxY=Math.max(0,...pts.map(p=>p.y));
  const rY=maxY-minY||1;
  const sx=x=>PAD+(x/Math.max(pts.length-1,1))*(W-2*PAD);
  const sy=y=>PAD+(1-(y-minY)/rY)*(H-2*PAD);
  const d=pts.map((p,i)=>`${i===0?'M':'L'} ${sx(p.x)} ${sy(p.y)}`).join(' ');
  const zY=sy(0); const fc=running>=0?C.green:C.red;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:'block'}}>
      <line x1={PAD} y1={zY} x2={W-PAD} y2={zY} stroke={C.border} strokeWidth="1" strokeDasharray="3,3"/>
      <path d={`${d} L ${sx(pts.length-1)} ${zY} L ${sx(0)} ${zY} Z`} fill={fc} opacity="0.07"/>
      <path d={d} fill="none" stroke={fc} strokeWidth="1.5"/>
    </svg>
  );
};

const StrategyCol = ({ s, stats, running, onRun }) => (
  <div style={{ flex:1, minWidth:260, background:C.card, border:`1px solid ${C.border}`, borderTop:`3px solid ${s.color}`, borderRadius:'0 0 12px 12px' }}>
    <div style={{ padding:'14px 16px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
      <span style={{ fontSize:14, fontWeight:800, color:s.color }}>{s.icon} {s.label}</span>
      <button onClick={()=>onRun(s.key)} disabled={running===s.key} style={{
        background: running===s.key ? C.surface : s.color+'22',
        color: running===s.key ? C.dim : s.color,
        border:`1px solid ${running===s.key ? C.border : s.color+'44'}`,
        borderRadius:8, padding:'5px 12px', cursor: running===s.key?'not-allowed':'pointer',
        fontFamily:'monospace', fontSize:11, fontWeight:700,
      }}>
        {running===s.key ? '⚡ Running...' : stats ? '↻ Re-run' : '▶ Run'}
      </button>
    </div>
    {!stats ? (
      <div style={{ padding:'40px 20px', textAlign:'center', color:C.dim, fontSize:12 }}>
        <div style={{ fontSize:28, marginBottom:8 }}>📭</div>
        <div>No results yet — click Run</div>
      </div>
    ) : (
      <div style={{ padding:14 }}>
        <div style={{ background:C.surface, borderRadius:8, padding:'12px 14px', marginBottom:12, textAlign:'center' }}>
          <div style={{ fontSize:9, color:C.dim, textTransform:'uppercase', letterSpacing:1.2, marginBottom:4 }}>Total P&L</div>
          <div style={{ fontSize:26, fontWeight:800, color:stats.totalPnl>=0?C.green:C.red }}>
            {stats.totalPnl>=0?'+':''}₹{stats.totalPnl?.toFixed(0)}
          </div>
          <div style={{ fontSize:10, color:C.dim, marginTop:2 }}>{stats.totalTrades} trades</div>
        </div>
        <div style={{ background:C.surface, borderRadius:8, padding:8, marginBottom:12 }}>
          <MiniChart trades={stats.trades} color={s.color}/>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:12 }}>
          {[
            { l:'Win Rate',  v:`${stats.winRate}%`,                c:stats.winRate>=50?C.green:C.red },
            { l:'Sharpe',    v:stats.sharpeRatio?.toFixed(2),       c:stats.sharpeRatio>=1?C.green:C.amber },
            { l:'Avg Win',   v:`₹${stats.avgWin?.toFixed(0)}`,      c:C.green },
            { l:'Avg Loss',  v:`₹${stats.avgLoss?.toFixed(0)}`,     c:C.red },
            { l:'Max DD',    v:`₹${stats.maxDrawdown?.toFixed(0)}`, c:C.red },
            { l:'W / L',     v:`${stats.winners} / ${stats.losers}`, c:C.text },
          ].map(item=>(
            <div key={item.l} style={{ background:C.surface, borderRadius:6, padding:'7px 10px' }}>
              <div style={{ fontSize:9, color:C.dim, textTransform:'uppercase', letterSpacing:1 }}>{item.l}</div>
              <div style={{ fontSize:14, fontWeight:700, color:item.c, marginTop:2 }}>{item.v}</div>
            </div>
          ))}
        </div>
        {stats.bestTrade && <div style={{ fontSize:11, color:C.dim, marginBottom:3 }}>🏆 Best: <span style={{ color:C.green }}>₹{stats.bestTrade.pnl?.toFixed(0)}</span> <span style={{ fontSize:10 }}>{stats.bestTrade.date}</span></div>}
        {stats.worstTrade && <div style={{ fontSize:11, color:C.dim, marginBottom:12 }}>💀 Worst: <span style={{ color:C.red }}>₹{stats.worstTrade.pnl?.toFixed(0)}</span> <span style={{ fontSize:10 }}>{stats.worstTrade.date}</span></div>}
        <div style={{ fontSize:10, color:C.dim, marginBottom:5, textTransform:'uppercase', letterSpacing:1 }}>Exit Reasons</div>
        {Object.entries(stats.reasons||{}).map(([r,c])=>(
          <div key={r} style={{ display:'flex', justifyContent:'space-between', fontSize:11, marginBottom:3, color:C.dim }}>
            <span>{r}</span><span style={{ color:C.text }}>{c} ({(c/stats.totalTrades*100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    )}
  </div>
);

const MonthlyTab = ({ statsArr }) => {
  const allMonths = new Set();
  statsArr.forEach(s => s && Object.keys(s.monthly||{}).forEach(m=>allMonths.add(m)));
  const months = [...allMonths].sort().slice(-24);
  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
        <thead>
          <tr>
            <th style={{ padding:'6px 10px', color:C.dim, textAlign:'left', background:C.surface, fontSize:10, textTransform:'uppercase' }}>Month</th>
            {STRATEGIES.map(s=><th key={s.key} style={{ padding:'6px 10px', color:s.color, textAlign:'center', background:C.surface, fontSize:10 }}>{s.icon} {s.label}</th>)}
            <th style={{ padding:'6px 10px', color:C.amber, textAlign:'center', background:C.surface, fontSize:10 }}>Combined</th>
          </tr>
        </thead>
        <tbody>
          {months.map(month=>{
            const vals = statsArr.map(s=>s?.monthly?.[month]?.pnl||0);
            const combined = vals.reduce((a,b)=>a+b,0);
            return (
              <tr key={month}>
                <td style={{ padding:'5px 10px', color:C.dim, background:C.surface }}>{month}</td>
                {vals.map((v,i)=><td key={i} style={{ padding:'5px 10px', textAlign:'center', fontWeight:700, color:v>=0?C.green:C.red, background:C.card }}>{v>=0?'+':''}₹{v.toFixed(0)}</td>)}
                <td style={{ padding:'5px 10px', textAlign:'center', fontWeight:700, color:combined>=0?C.amber:C.red, background:C.card }}>{combined>=0?'+':''}₹{combined.toFixed(0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default function BacktestPage() {
  const [allStats, setAllStats] = useState({ scalping:null, ironcondor:null, deltaneutral:null });
  const [running,  setRunning]  = useState(null);
  const [tab,      setTab]      = useState('compare');
  const [error,    setError]    = useState('');
  
  // NEW: Download State
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg]     = useState('');

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      // Assuming you have an endpoint that fetches the saved MongoDB Backtest data
      const res = await api.get('/api/backtest/all-results');
      if (res.data.success) setAllStats(res.data.results);
    } catch {}
  };

  const runOne = async (key) => {
    setRunning(key); setError('');
    try {
      const res = await api.post('/api/backtest/run', { strategy: key });
      if (res.data.success) setAllStats(prev => ({ ...prev, [key]: res.data.stats }));
      else setError(`${key}: ${res.data.message}`);
    } catch (err) { setError(`${key}: ${err.message}`); }
    setRunning(null);
  };

  const runAll = async () => { for (const s of STRATEGIES) await runOne(s.key); };

  // NEW: Download Handler
  const handleDownloadHistory = async () => {
    setIsDownloading(true);
    setDownloadMsg('Initiating background sync...');
    try {
      const res = await api.post('/api/market/download-history');
      if (res.data.success) setDownloadMsg('✅ ' + res.data.message);
      else setDownloadMsg('❌ ' + res.data.message);
    } catch (err) {
      setDownloadMsg('❌ Failed to trigger download.');
    }
    setTimeout(() => setIsDownloading(false), 2000);
    setTimeout(() => setDownloadMsg(''), 10000); // clear message after 10s
  };

  const statsArr  = STRATEGIES.map(s => allStats[s.key]);
  const hasAny    = statsArr.some(Boolean);
  const totalPnl  = statsArr.reduce((sum,s) => sum+(s?.totalPnl||0), 0);

  const allTrades = STRATEGIES.flatMap(s =>
    (allStats[s.key]?.trades||[]).map(t=>({...t, strategy:s.label, strategyColor:s.color}))
  ).sort((a,b) => a.date?.localeCompare(b.date));

  const btnStyle = (active, color=C.amber) => ({
    background: active ? color+'22' : C.surface, color: active ? color : C.dim,
    border:`1px solid ${active ? color+'44' : C.border}`, borderRadius:8, padding:'6px 14px',
    cursor: active ? 'not-allowed' : 'pointer', fontFamily:'monospace', fontWeight:700, fontSize:12,
  });

  return (
    <div style={{ background:C.bg, minHeight:'100vh', color:C.text, fontFamily:'monospace', padding:20 }}>

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:10 }}>
        <div>
          <h1 style={{ margin:0, fontSize:22, color:'#fff' }}>🔬 Backtest Comparison</h1>
          <p style={{ margin:'4px 0 0', fontSize:11, color:C.dim }}>5 Year Historical — All 3 Strategies Side by Side</p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems: 'center' }}>
          {/* NEW: Download Button */}
          <button onClick={handleDownloadHistory} disabled={isDownloading} style={btnStyle(isDownloading, C.blue)}>
            {isDownloading ? '⏳ Syncing...' : '⬇️ Sync Data'}
          </button>
          <button onClick={runAll} disabled={!!running} style={btnStyle(!!running)}>
            {running ? `⚡ Running ${running}...` : '▶ Run All 3'}
          </button>
          <button onClick={loadAll} style={{ background:C.surface, color:C.dim, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 14px', cursor:'pointer', fontFamily:'monospace', fontSize:12 }}>↻</button>
        </div>
      </div>

      {/* NEW: Download Status Message */}
      {downloadMsg && (
        <div style={{ padding: '8px 12px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, color: downloadMsg.includes('❌') ? C.red : C.blue, marginBottom: 16 }}>
          {downloadMsg}
        </div>
      )}

      {error && <div style={{ background:C.red+'11', border:`1px solid ${C.red}33`, borderRadius:8, padding:'10px 14px', marginBottom:12, fontSize:12, color:C.red }}>❌ {error}</div>}

      {/* Combined banner */}
      {hasAny && (
        <div style={{ display:'grid', gridTemplateColumns:'2fr repeat(3, 1fr)', gap:8, marginBottom:20 }}>
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:'14px 16px' }}>
            <div style={{ fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:1.2 }}>Combined P&L — All Strategies</div>
            <div style={{ fontSize:30, fontWeight:800, color:totalPnl>=0?C.amber:C.red, marginTop:4 }}>{totalPnl>=0?'+':''}₹{totalPnl.toFixed(0)}</div>
          </div>
          {STRATEGIES.map(s => {
            const st = allStats[s.key];
            return (
              <div key={s.key} style={{ background:C.card, border:`1px solid ${C.border}`, borderTop:`2px solid ${s.color}`, borderRadius:'0 0 10px 10px', padding:'12px 14px' }}>
                <div style={{ fontSize:10, color:s.color, textTransform:'uppercase', letterSpacing:1 }}>{s.icon} {s.label}</div>
                <div style={{ fontSize:20, fontWeight:700, color:st?(st.totalPnl>=0?C.green:C.red):C.muted, marginTop:4 }}>
                  {st ? `${st.totalPnl>=0?'+':''}₹${st.totalPnl?.toFixed(0)}` : '—'}
                </div>
                {st && <div style={{ fontSize:10, color:C.dim, marginTop:2 }}>{st.winRate}% wins</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:16 }}>
        {[{key:'compare',label:'📊 Side by Side'},{key:'monthly',label:'📅 Monthly'},{key:'trades',label:'📋 All Trades'}].map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} style={btnStyle(tab===t.key)}>{t.label}</button>
        ))}
      </div>

      {/* Compare */}
      {tab==='compare' && (
        <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-start' }}>
          {STRATEGIES.map(s=>(
            <StrategyCol key={s.key} s={s} stats={allStats[s.key]} running={running} onRun={runOne}/>
          ))}
        </div>
      )}

      {/* Monthly */}
      {tab==='monthly' && (
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:16 }}>
          {hasAny ? <MonthlyTab statsArr={statsArr}/> : <div style={{ color:C.muted, textAlign:'center', padding:40 }}>Run backtests first</div>}
        </div>
      )}

      {/* Trades */}
      {tab==='trades' && (
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:16 }}>
          <div style={{ fontSize:11, color:C.dim, marginBottom:12 }}>All {allTrades.length} trades combined</div>
          <div style={{ maxHeight:500, overflowY:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead style={{ position:'sticky', top:0 }}>
                <tr>
                  {['Date','Strategy','Direction','Entry','Reason','P&L'].map(h=>(
                    <th key={h} style={{ padding:'6px 10px', color:C.dim, textAlign:'left', fontSize:10, textTransform:'uppercase', background:C.surface, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allTrades.map((t,i)=>(
                  <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
                    <td style={{ padding:'5px 10px', color:C.dim }}>{t.date}</td>
                    <td style={{ padding:'5px 10px' }}><span style={{ color:t.strategyColor, fontWeight:700, fontSize:10 }}>{t.strategy}</span></td>
                    <td style={{ padding:'5px 10px', color:C.text }}>{t.direction||t.index||'—'}</td>
                    <td style={{ padding:'5px 10px', color:C.dim }}>{t.niftyEntry||t.entrySpot||'—'}</td>
                    <td style={{ padding:'5px 10px', color:C.dim, fontSize:10 }}>{t.closeReason}</td>
                    <td style={{ padding:'5px 10px', fontWeight:700, color:t.pnl>=0?C.green:C.red }}>{t.pnl>=0?'+':''}₹{t.pnl?.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}