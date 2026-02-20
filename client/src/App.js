import React, { useState, useEffect } from 'react';
import api from './utils/api';
import { SocketProvider } from './context/SocketContext';
import Dashboard from './components/Dashboard';
import LoginPage from './components/LoginPage';

export default function App() {
  const [kiteConnected, setKiteConnected] = useState(false);
  const [checking,      setChecking]      = useState(true);
  const [userName,      setUserName]      = useState('');

  // Check if already connected on load
  useEffect(() => {
    api.get('/api/auth/status')
      .then(r => {
        setKiteConnected(r.data.connected);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  const handleLoginSuccess = (data) => {
    setKiteConnected(true);
    setUserName(data.userName || '');
  };

  const handleLogout = () => {
    setKiteConnected(false);
    setUserName('');
  };

  if (checking) {
    return (
      <div style={{
        background: '#07090f', minHeight: '100vh',
        display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: '#4b6278',
        fontFamily: 'monospace', fontSize: 13
      }}>
        Connecting...
      </div>
    );
  }

  return (
    <SocketProvider>
      {!kiteConnected
        ? <LoginPage onLoginSuccess={handleLoginSuccess} />
        : <Dashboard userName={userName} onLogout={handleLogout} />
      }
    </SocketProvider>
  );
}