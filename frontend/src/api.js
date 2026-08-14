const API_BASE = 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

export const api = {
  register: (name, email, password) => request('/auth/register', { method: 'POST', body: { name, email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: (token) => request('/accounts/me', { token }),
  transactions: (token) => request('/accounts/transactions', { token }),
  deposit: (token, amountCents) => request('/accounts/deposit', { method: 'POST', body: { amountCents }, token }),
  transfer: (token, toAccountNumber, amountCents) =>
    request('/transfer', { method: 'POST', body: { toAccountNumber, amountCents }, token }),
};
