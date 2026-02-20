import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const [connected,    setConnected]    = useState(false);
  const [logs,         setLogs]         = useState([]);
  const [currentTrade, setCurrentTrade] = useState(null);
  const [currentSetup, setCurrentSetup] = useState(null);
  const [niftyLTP,     setNiftyLTP]     = useState(0);
  const [trades,       setTrades]       = useState([]);
  const [engineStatus, setEngineStatus] = useState({ running: false, paperTrade: true });
  const socketRef = useRef(null);

  const addLog = (msg, type = 'info') => {
    const entry = {
      id:   Date.now() + Math.random(),
      time: new Date().toLocaleTimeString('en-IN'),
      msg,
      type
    };
    setLogs(prev => [entry, ...prev].slice(0, 100));
  };

  useEffect(() => {
    const socket = io(process.env.REACT_APP_SERVER_URL);
    socketRef.current = socket;

    socket.on('connect',    () => { setConnected(true);  addLog('Connected to server', 'success'); });
    socket.on('disconnect', () => { setConnected(false); addLog('Disconnected from server', 'error'); });

    socket.on('new_candle', (data) => {
      addLog(`🕯️ Candle: O:${data.open} H:${data.high} L:${data.low} C:${data.close}`, 'candle');
    });

    socket.on('setup_found', (data) => {
      setCurrentSetup(data.setup);
      addLog(`✅ ${data.message}`, 'setup');
    });

    socket.on('signal', (data) => {
      addLog(`🚀 ${data.message}`, 'signal');
    });

    socket.on('trade_opened', (data) => {
      setCurrentTrade(data.trade);
      addLog(`📈 ${data.message}`, 'trade');
    });

    socket.on('trade_update', (data) => {
      setCurrentTrade(data.trade);
    });

    socket.on('trade_closed', (data) => {
      setCurrentTrade(null);
      setTrades(prev => [data.trade, ...prev]);
      addLog(`${data.pnl >= 0 ? '✅' : '❌'} ${data.message}`, data.pnl >= 0 ? 'success' : 'error');
    });

    socket.on('trail_activated', (data) => {
      setCurrentTrade(data.trade);
      addLog(`🎯 ${data.message}`, 'success');
    });

    socket.on('strategy_reset', () => {
      setCurrentSetup(null);
      setCurrentTrade(null);
      addLog('📅 New day — strategy reset', 'info');
    });

    socket.on('engine_status', (data) => {
      setEngineStatus(prev => ({ ...prev, running: data.running }));
      addLog(`Engine ${data.running ? 'started ▶️' : 'stopped ⏹️'}`, 'info');
    });

    socket.on('error', (data) => {
      addLog(`❌ Error: ${data.message}`, 'error');
    });

    // Get initial status
    socket.emit('get_status');
    socket.on('status', (data) => {
      setEngineStatus({ running: data.running, paperTrade: data.paperTrade });
      setCurrentTrade(data.currentTrade);
      setCurrentSetup(data.currentSetup);
      setNiftyLTP(data.niftyLTP);
      if (data.paperTrades) setTrades(data.paperTrades.reverse());
    });

    return () => socket.disconnect();
  }, []);

  const manualExit = () => {
    socketRef.current?.emit('manual_exit');
    addLog('Manual exit triggered', 'warning');
  };

  return (
    <SocketContext.Provider value={{
      connected, logs, currentTrade, currentSetup,
      niftyLTP, trades, engineStatus,
      manualExit, socket: socketRef.current
    }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => useContext(SocketContext);
