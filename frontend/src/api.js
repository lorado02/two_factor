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
  register: (name, email, password) =>
    request('/auth/register', { method: 'POST', body: { name, email, password } }),

  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),

  verify2fa: (pendingToken, code) =>
    request('/auth/verify-2fa', {
      method: 'POST',
      body: { code },
      token: pendingToken,
    }),

  requestSmsOtp: (pendingToken) =>
    request('/auth/request-sms-otp', {
      method: 'POST',
      token: pendingToken,
    }),

  me: (token) => request('/accounts/me', { token }),

  transactions: (token) => request('/accounts/transactions', { token }),

  deposit: (token, amountCents) =>
    request('/accounts/deposit', { method: 'POST', body: { amountCents }, token }),

  transfer: (token, toAccountNumber, amountCents, twoFaCode) =>
    request('/transfer', {
      method: 'POST',
      body: { toAccountNumber, amountCents, ...(twoFaCode ? { twoFaCode } : {}) },
      token,
    }),

  // 2FA management
  setup2fa: (token) =>
    request('/auth/2fa/setup', { method: 'POST', token }),

  enable2fa: (token, code) =>
    request('/auth/2fa/enable', { method: 'POST', body: { code }, token }),

  disable2fa: (token, password, code) =>
    request('/auth/2fa/disable', { method: 'POST', body: { password, code }, token }),

  getBackupCodes: (token) =>
    request('/auth/2fa/backup-codes', { token }),

  regenerateBackupCodes: (token, code) =>
    request('/auth/2fa/backup-codes/regenerate', { method: 'POST', body: { code }, token }),
};
