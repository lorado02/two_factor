import { useState } from 'react';
import { api } from './api';

// OTP Step 2 — matches the Axis Bank prototype mockup
function TwoFactorStep({ pendingToken, onAuthenticated, onBack }) {
  const [code, setCode] = useState('');
  const [mode, setMode] = useState('totp'); // 'totp' | 'sms' | 'backup'
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [smsSent, setSmsSent] = useState(false);
  const [countdown, setCountdown] = useState(180); // 3-min display timer

  // Start countdown on mount
  useState(() => {
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(id);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  });

  const minutes = String(Math.floor(countdown / 60)).padStart(1, '0');
  const seconds = String(countdown % 60).padStart(2, '0');

  async function handleRequestSms() {
    setError('');
    setLoading(true);
    try {
      await api.requestSmsOtp(pendingToken);
      setSmsSent(true);
      setMode('sms');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.verify2fa(pendingToken, code.trim());
      onAuthenticated(token);
    } catch (err) {
      setCode('');
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function subtitle() {
    if (mode === 'sms') return smsSent ? 'Enter the code sent to your registered mobile number.' : 'Request an SMS code below.';
    if (mode === 'backup') return 'Enter one of your 8-character backup codes.';
    return 'Enter the code from your authenticator app.';
  }

  return (
    <div className="card auth-card" role="main">
      <h1>Axis Bank</h1>
      <h2>Two-factor authentication</h2>
      <p className="muted">{subtitle()}</p>

      <form onSubmit={handleVerify} aria-label="Two-factor authentication form">
        <label htmlFor="otp-code">
          {mode === 'backup' ? 'Backup code' : 'Code'}
        </label>
        <input
          id="otp-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={mode === 'backup' ? 'XXXXXXXX' : '000000'}
          maxLength={mode === 'backup' ? 8 : 6}
          autoComplete="one-time-code"
          inputMode={mode === 'backup' ? 'text' : 'numeric'}
          aria-label={mode === 'backup' ? 'Backup code' : 'One-time code'}
          aria-describedby={error ? 'otp-error' : undefined}
          required
          autoFocus
        />

        {error && (
          <p id="otp-error" className="error" role="alert" aria-live="assertive">
            {error}
          </p>
        )}

        <button type="submit" className="primary btn-verify" disabled={loading || !code}>
          {loading ? 'Verifying…' : 'Verify'}
        </button>
      </form>

      {countdown > 0 ? (
        <p className="muted expiry-note">This sign-in expires in {minutes}:{seconds}</p>
      ) : (
        <p className="error">Session expired. <button className="link-btn" onClick={onBack}>Log in again</button></p>
      )}

      <hr />

      <div className="alt-methods">
        {mode !== 'sms' && (
          <button
            className="link-btn"
            onClick={handleRequestSms}
            disabled={loading}
            type="button"
          >
            Use SMS code instead
          </button>
        )}
        {mode !== 'backup' && (
          <button
            className="link-btn"
            onClick={() => { setMode('backup'); setCode(''); setError(''); }}
            type="button"
          >
            Use a backup code
          </button>
        )}
        {mode !== 'totp' && (
          <button
            className="link-btn"
            onClick={() => { setMode('totp'); setCode(''); setError(''); }}
            type="button"
          >
            Use authenticator app
          </button>
        )}
      </div>
    </div>
  );
}

export default function AuthForm({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingToken, setPendingToken] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        const { token } = await api.register(name, email, password);
        onAuthenticated(token);
        return;
      }

      const result = await api.login(email, password);
      if (result.status === '2fa_required') {
        setPendingToken(result.pendingToken);
      } else {
        onAuthenticated(result.token);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Show 2FA step when we have a pending token
  if (pendingToken) {
    return (
      <TwoFactorStep
        pendingToken={pendingToken}
        onAuthenticated={onAuthenticated}
        onBack={() => setPendingToken(null)}
      />
    );
  }

  return (
    <div className="card auth-card">
      <h1>Axis Bank</h1>
      <div className="tabs">
        <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log in</button>
        <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Sign up</button>
      </div>

      <form onSubmit={handleSubmit}>
        {mode === 'register' && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
