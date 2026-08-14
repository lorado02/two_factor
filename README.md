# Axis Bank (demo)

A minimal banking demo app: register/login, view balance and transaction
history, deposit funds, and transfer money to another account. Amounts are
in Indian Rupees (₹).

**No 2FA yet, by design** — this is scaffolded so a second factor can be
added to the login (and optionally to transfers) later without restructuring
the app:

- `users` table already has `twofa_enabled` / `twofa_secret` columns
  ([backend/src/db.js](backend/src/db.js)).
- The login route has a marked hook point where a pending/second-step token
  would replace the direct session token
  ([backend/src/routes/auth.js](backend/src/routes/auth.js)).
- The transfer route has a marked hook point for step-up verification on
  large transfers ([backend/src/routes/transfer.js](backend/src/routes/transfer.js)).

## Stack

- Backend: Node/Express + SQLite (`better-sqlite3`), JWT auth, bcrypt password hashing.
- Frontend: React + Vite.

## Run it

In one terminal:

```
cd backend
npm install
npm run dev
```

In another terminal:

```
cd frontend
npm install
npm run dev
```

Then open the frontend URL Vite prints (usually http://localhost:5173).
The backend runs on http://localhost:4000.

## API

- `POST /api/auth/register` `{ name, email, password }`
- `POST /api/auth/login` `{ email, password }`
- `GET /api/accounts/me` (auth) — profile + balance
- `POST /api/accounts/deposit` (auth) `{ amountCents }` — demo-only top-up (amount in paise)
- `GET /api/accounts/transactions` (auth)
- `POST /api/transfer` (auth) `{ toAccountNumber, amountCents }` (amount in paise)

### Example

```bash
BASE=http://localhost:4000/api

# Register Priya
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Priya","email":"priya@example.com","password":"password123"}'
# -> {"token":"eyJhbGciOi..."}

# Register Rohan
curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Rohan","email":"rohan@example.com","password":"password123"}'

# Deposit ₹1000 (100000 paise) into Priya's account
curl -s -X POST $BASE/accounts/deposit -H "Authorization: Bearer <priya-token>" \
  -H 'Content-Type: application/json' -d '{"amountCents":100000}'
# -> {"balanceCents":100000}

# Transfer ₹250 (25000 paise) from Priya to Rohan's account number
curl -s -X POST $BASE/transfer -H "Authorization: Bearer <priya-token>" \
  -H 'Content-Type: application/json' \
  -d '{"toAccountNumber":"<rohans-account-number>","amountCents":25000}'
# -> {"balanceCents":75000}
```
