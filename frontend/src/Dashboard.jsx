import { useEffect, useState } from 'react';
import { api } from './api';

function formatCents(cents) {
  return (cents / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
}

// ---------------------------------------------------------------------------
// Security Settings — 2FA enrolment / management panel
// ---------------------------------------------------------------------------
function SecuritySettings({ token, twofaEnabled, onStatusChange }) {
  const [view, setView] = useState('idle'); // idle | setup | backupCodes | disable | regenerate
  const [setupData, setSetupData] = useState(null);    // { qrCodeDataUrl, manualEntryKey }
  const [verifyCode, setVerifyCode] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [backupCount, setBackupCount] = useState(null); // { total, remaining }
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (twofaEnabled) {
      api.getBackupCodes(token).then(setBackupCount).catch(() => {});
    }
  }, [twofaEnabled, token]);

  async function startSetup() {
    setError('');
    setLoading(true);
    try {
      const data = await api.setup2fa(token);
      setSetupData(data);
      setView('setup');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleEnable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { backupCodes: codes } = await api.enable2fa(token, verifyCode.trim());
      setBackupCodes(codes);
      setView('backupCodes');
      onStatusChange(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDisable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.disable2fa(token, disablePassword, disableCode.trim());
      setView('idle');
      setDisablePassword('');
      setDisableCode('');
      onStatusChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { backupCodes: codes } = await api.regenerateBackupCodes(token, regenCode.trim());
      setBackupCodes(codes);
      setAcknowledged(false);
      setView('backupCodes');
      setBackupCount({ total: 8, remaining: 8 });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function copyAllCodes() {
    navigator.clipboard.writeText(backupCodes.join('\n')).catch(() => {});
  }

  function downloadCodes() {
    const blob = new Blob([backupCodes.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'axis-bank-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Backup codes one-time reveal ---
  if (view === 'backupCodes') {
    return (
      <section className="card security-settings" aria-label="Save backup codes">
        <h2>Save your backup codes</h2>
        <p className="muted">Store these in a safe place. Each code can only be used once.</p>
        <div className="backup-codes-grid" aria-label="Backup codes list">
          {backupCodes.map((c) => (
            <code key={c} className="backup-code">{c}</code>
          ))}
        </div>
        <div className="backup-actions">
          <button type="button" onClick={copyAllCodes}>Copy all codes</button>
          <button type="button" onClick={downloadCodes}>Download .txt</button>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I have saved my backup codes
        </label>
        <button
          type="button"
          className="primary"
          disabled={!acknowledged}
          onClick={() => { setView('idle'); setBackupCodes([]); }}
        >
          Done
        </button>
      </section>
    );
  }

  // --- Setup wizard ---
  if (view === 'setup' && setupData) {
    return (
      <section className="card security-settings" aria-label="Set up authenticator app">
        <h2>Set up authenticator app</h2>
        <ol className="setup-steps">
          <li>Open <strong>Google Authenticator</strong> or <strong>Authy</strong>.</li>
          <li>
            Scan this QR code:
            <img
              src={setupData.qrCodeDataUrl}
              alt="TOTP QR code — scan with your authenticator app"
              className="qr-code"
            />
            <p className="muted">
              Can&apos;t scan? Enter key: <code className="manual-key">{setupData.manualEntryKey}</code>
            </p>
          </li>
          <li>Enter the 6-digit code shown in your app:</li>
        </ol>

        <form onSubmit={handleEnable} aria-label="Verify authenticator setup">
          <label htmlFor="setup-code">Code</label>
          <input
            id="setup-code"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
            placeholder="000000"
            autoComplete="one-time-code"
            required
            autoFocus
          />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="primary" disabled={loading || !verifyCode}>
              {loading ? 'Verifying…' : 'Verify and activate'}
            </button>
            <button type="button" onClick={() => { setView('idle'); setSetupData(null); setVerifyCode(''); setError(''); }}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  // --- Disable confirmation ---
  if (view === 'disable') {
    return (
      <section className="card security-settings" aria-label="Disable two-factor authentication">
        <h2>Disable two-factor authentication</h2>
        <p className="muted">For security, please confirm:</p>
        <form onSubmit={handleDisable}>
          <label htmlFor="disable-password">Password</label>
          <input
            id="disable-password"
            type="password"
            value={disablePassword}
            onChange={(e) => setDisablePassword(e.target.value)}
            required
          />
          <label htmlFor="disable-code">Authenticator code</label>
          <input
            id="disable-code"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            placeholder="000000"
            autoComplete="one-time-code"
            required
          />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="primary danger" disabled={loading}>
              {loading ? 'Disabling…' : 'Confirm disable'}
            </button>
            <button type="button" onClick={() => { setView('idle'); setError(''); }}>Cancel</button>
          </div>
        </form>
      </section>
    );
  }

  // --- Regenerate codes ---
  if (view === 'regenerate') {
    return (
      <section className="card security-settings" aria-label="Regenerate backup codes">
        <h2>Regenerate backup codes</h2>
        <p className="muted">Enter your authenticator code to confirm:</p>
        <form onSubmit={handleRegenerate}>
          <label htmlFor="regen-code">Authenticator code</label>
          <input
            id="regen-code"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={regenCode}
            onChange={(e) => setRegenCode(e.target.value)}
            placeholder="000000"
            autoComplete="one-time-code"
            required
            autoFocus
          />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="primary" disabled={loading || !regenCode}>
              {loading ? 'Regenerating…' : 'Regenerate codes'}
            </button>
            <button type="button" onClick={() => { setView('idle'); setError(''); }}>Cancel</button>
          </div>
        </form>
      </section>
    );
  }

  // --- Idle / status view ---
  return (
    <section className="card security-settings" aria-label="Security settings">
      <h2>Security Settings</h2>
      {twofaEnabled ? (
        <>
          <p>
            Two-factor authentication: <strong className="status-on">ON ✓</strong>
          </p>
          {backupCount && (
            <p className="muted">
              Backup codes: {backupCount.remaining} of {backupCount.total} remaining
            </p>
          )}
          <div className="security-actions">
            <button type="button" onClick={() => { setView('regenerate'); setError(''); }}>
              Regenerate backup codes
            </button>
            <button type="button" className="danger" onClick={() => { setView('disable'); setError(''); }}>
              Disable two-factor authentication
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Two-factor authentication: <strong className="status-off">OFF</strong>
          </p>
          <p className="muted enrol-invite">
            Protect your account with an authenticator app.
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="button" className="primary" onClick={startSetup} disabled={loading}>
            {loading ? 'Loading…' : 'Set up two-factor authentication'}
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export default function Dashboard({ token, onLogout }) {
  const [me, setMe] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [error, setError] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferCode, setTransferCode] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [twofaEnabled, setTwofaEnabled] = useState(false);

  async function refresh() {
    try {
      const [meData, txData] = await Promise.all([api.me(token), api.transactions(token)]);
      setMe(meData);
      setTransactions(txData.transactions);
      setTwofaEnabled(!!meData.user.twofaEnabled);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeposit(e) {
    e.preventDefault();
    setError('');
    setActionLoading(true);
    try {
      await api.deposit(token, Math.round(Number(depositAmount) * 100));
      setDepositAmount('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleTransfer(e) {
    e.preventDefault();
    setError('');
    setActionLoading(true);
    try {
      await api.transfer(
        token,
        transferTo,
        Math.round(Number(transferAmount) * 100),
        twofaEnabled ? transferCode : undefined
      );
      setTransferTo('');
      setTransferAmount('');
      setTransferCode('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  if (!me) {
    return (
      <div className="card">
        {error ? <p className="error">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Hi, {me.user.name}</h1>
          <p className="muted">Account #{me.account.accountNumber}</p>
        </div>
        <button onClick={onLogout}>Log out</button>
      </header>

      <div className="card balance-card">
        <p className="muted">Balance</p>
        <p className="balance">{formatCents(me.account.balanceCents)}</p>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid">
        <form className="card" onSubmit={handleDeposit}>
          <h2>Add funds</h2>
          <label>
            Amount (₹)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="primary" disabled={actionLoading}>Deposit</button>
        </form>

        <form className="card" onSubmit={handleTransfer}>
          <h2>Send money</h2>
          <label>
            To account number
            <input value={transferTo} onChange={(e) => setTransferTo(e.target.value)} required />
          </label>
          <label>
            Amount (₹)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              required
            />
          </label>
          {twofaEnabled && (
            <label htmlFor="transfer-code">
              Authentication code
              <input
                id="transfer-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={transferCode}
                onChange={(e) => setTransferCode(e.target.value)}
                autoComplete="one-time-code"
                aria-label="Two-factor authentication code for transfer"
                required
              />
            </label>
          )}
          <button
            type="submit"
            className="primary"
            disabled={actionLoading || (twofaEnabled && !transferCode)}
          >
            Transfer
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Recent activity</h2>
        {transactions.length === 0 ? (
          <p className="muted">No transactions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Detail</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{new Date(tx.createdAt + 'Z').toLocaleString()}</td>
                  <td>{tx.type}</td>
                  <td>
                    {tx.type === 'deposit'
                      ? '—'
                      : tx.direction === 'debit'
                        ? `to ${tx.toAccountNumber}`
                        : `from ${tx.fromAccountNumber}`}
                  </td>
                  <td className={tx.direction === 'debit' ? 'negative' : 'positive'}>
                    {tx.direction === 'debit' ? '-' : '+'}
                    {formatCents(tx.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SecuritySettings
        token={token}
        twofaEnabled={twofaEnabled}
        onStatusChange={(enabled) => setTwofaEnabled(enabled)}
      />
    </div>
  );
}
