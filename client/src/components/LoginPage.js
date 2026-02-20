import React, { useState } from 'react';
import api from '../utils/api';

const C = {
  bg:      '#07090f',
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

export default function LoginPage({ onLoginSuccess }) {
  const [step,         setStep]         = useState(1); // 1=get url, 2=paste token
  const [token,        setToken]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [loginUrl,     setLoginUrl]     = useState('');

  // Step 1 — Get Kite login URL
  const handleGetLoginUrl = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/api/auth/login');
      setLoginUrl(res.data.loginUrl);
      // Open Kite login in new tab
      window.open(res.data.loginUrl, '_blank');
      setStep(2);
    } catch (err) {
      setError('Could not reach server. Make sure backend is running.');
    }
    setLoading(false);
  };

  // Step 2 — Submit request token
  const handleSubmitToken = async () => {
    if (!token.trim()) {
      setError('Please paste the request_token');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/api/auth/callback', {
        request_token: token.trim()
      });
      if (res.data.success) {
        onLoginSuccess(res.data);
      } else {
        setError('Login failed. Try again.');
      }
    } catch (err) {
      setError('Invalid token or session expired. Please try again.');
      setStep(1);
      setToken('');
    }
    setLoading(false);
  };

  // Extract token from full URL if user pastes URL instead of just token
  const handleTokenInput = (val) => {
    // If user pastes full URL, extract token automatically
    if (val.includes('request_token=')) {
      const match = val.match(/request_token=([^&]+)/);
      if (match) {
        setToken(match[1]);
        return;
      }
    }
    setToken(val);
  };

  return (
    <div style={{
      background: C.bg,
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      padding: 20,
    }}>
      <div style={{ width: '100%', maxWidth: 480 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
          <h1 style={{ color: '#fff', fontSize: 22, fontWeight: 700, margin: 0 }}>
            NIFTY ATM Scalping
          </h1>
          <p style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
            Connect your Zerodha account to start
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 28,
        }}>

          {/* Step indicator */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28, gap: 8 }}>
            {[1, 2].map(n => (
              <React.Fragment key={n}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: step >= n ? C.blue : C.border,
                  color: step >= n ? '#fff' : C.muted,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, flexShrink: 0,
                  transition: 'all 0.3s'
                }}>{n}</div>
                {n < 2 && (
                  <div style={{
                    flex: 1, height: 2,
                    background: step > n ? C.blue : C.border,
                    transition: 'all 0.3s'
                  }} />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* ── STEP 1 ── */}
          {step === 1 && (
            <div>
              <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                Step 1
              </div>
              <h2 style={{ color: '#fff', fontSize: 17, marginBottom: 8, fontWeight: 700 }}>
                Login to Zerodha
              </h2>
              <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.7, marginBottom: 24 }}>
                Click the button below to open Zerodha login page.
                After login, you'll be redirected back — copy the URL from your browser.
              </p>

              {/* Info box */}
              <div style={{
                background: C.blue + '11',
                border: `1px solid ${C.blue}33`,
                borderRadius: 10,
                padding: '12px 16px',
                marginBottom: 24,
                fontSize: 12,
                color: C.blue,
                lineHeight: 1.8,
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>What happens next:</div>
                <div>1. Zerodha login opens in new tab</div>
                <div>2. Enter your ID + password + 2FA PIN</div>
                <div>3. Browser redirects to localhost URL</div>
                <div>4. Copy that URL and come back here</div>
              </div>

              <button
                onClick={handleGetLoginUrl}
                disabled={loading}
                style={{
                  width: '100%',
                  background: loading ? C.muted : C.blue,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  padding: '14px',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontFamily: 'monospace',
                  transition: 'background 0.2s',
                }}
              >
                {loading ? 'Opening...' : '🔐 Open Zerodha Login'}
              </button>

              {loginUrl && (
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: C.blue, fontSize: 11 }}
                  >
                    Click here if popup was blocked
                  </a>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <div>
              <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                Step 2
              </div>
              <h2 style={{ color: '#fff', fontSize: 17, marginBottom: 8, fontWeight: 700 }}>
                Paste Redirect URL
              </h2>
              <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.7, marginBottom: 16 }}>
                After Zerodha login, your browser redirected to a URL.
                Paste that full URL below — token will be extracted automatically.
              </p>

              {/* Example URL */}
              <div style={{
                background: '#0d1117',
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 16,
                fontSize: 10,
                color: C.muted,
                wordBreak: 'break-all',
                lineHeight: 1.6,
              }}>
                <div style={{ color: C.yellow, marginBottom: 4 }}>Example URL:</div>
                http://127.0.0.1:3000/?
                <span style={{ color: C.green }}>request_token=AbCdEf123456</span>
                &action=login&status=success
              </div>

              {/* Token input */}
              <textarea
                value={token}
                onChange={e => handleTokenInput(e.target.value)}
                placeholder="Paste full redirect URL or just the request_token here..."
                rows={4}
                style={{
                  width: '100%',
                  background: '#0d1117',
                  border: `1px solid ${token ? C.blue : C.border}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  color: C.text,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  resize: 'none',
                  outline: 'none',
                  marginBottom: 16,
                  boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                  lineHeight: 1.6,
                }}
              />

              {/* Token preview */}
              {token && (
                <div style={{
                  background: C.green + '11',
                  border: `1px solid ${C.green}33`,
                  borderRadius: 8,
                  padding: '8px 12px',
                  marginBottom: 16,
                  fontSize: 11,
                  color: C.green,
                }}>
                  ✅ Token detected: {token.substring(0, 8)}...{token.substring(token.length - 4)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                {/* Back button */}
                <button
                  onClick={() => { setStep(1); setToken(''); setError(''); }}
                  style={{
                    background: 'transparent',
                    color: C.muted,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: '12px 20px',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  ← Back
                </button>

                {/* Connect button */}
                <button
                  onClick={handleSubmitToken}
                  disabled={loading || !token}
                  style={{
                    flex: 1,
                    background: loading || !token ? C.muted : C.green,
                    color: loading || !token ? '#666' : '#000',
                    border: 'none',
                    borderRadius: 10,
                    padding: '12px',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: loading || !token ? 'not-allowed' : 'pointer',
                    fontFamily: 'monospace',
                    transition: 'all 0.2s',
                  }}
                >
                  {loading ? 'Connecting...' : '⚡ Connect Kite'}
                </button>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              marginTop: 16,
              background: C.red + '11',
              border: `1px solid ${C.red}33`,
              borderRadius: 8,
              padding: '10px 14px',
              color: C.red,
              fontSize: 12,
            }}>
              ❌ {error}
            </div>
          )}
        </div>

        {/* Footer note */}
        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
          <div>⚠️ Login required every morning before 9:15 AM</div>
          <div>Kite access token expires daily at midnight</div>
        </div>

      </div>
    </div>
  );
}