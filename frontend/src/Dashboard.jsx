import { useEffect, useState } from 'react';
import { api } from './api';

function formatCents(cents) {
  return (cents / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
}

export default function Dashboard({ token, onLogout }) {
  const [me, setMe] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [error, setError] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  async function refresh() {
    try {
      const [meData, txData] = await Promise.all([api.me(token), api.transactions(token)]);
      setMe(meData);
      setTransactions(txData.transactions);
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
      await api.transfer(token, transferTo, Math.round(Number(transferAmount) * 100));
      setTransferTo('');
      setTransferAmount('');
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
          <button type="submit" className="primary" disabled={actionLoading}>Transfer</button>
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
    </div>
  );
}
