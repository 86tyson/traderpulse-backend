# crypto-trading-backend

Secure paper-mode backend for a personal Robinhood Crypto trading assistant.

**Live trading is disabled by default and is not yet implemented.** The Robinhood client functions are stubs that throw `NOT_IMPLEMENTED` so nothing can accidentally place a real order until Ed25519 request signing is wired and tested.

## Safety stance

- `BOT_ENABLED=false` by default — every trade request is rejected.
- `PAPER_MODE=true` by default — when the bot is enabled, trades are simulated and logged, never sent to Robinhood.
- The Robinhood client never returns fake "live" data. Calls in live mode return a clean `501 NOT_IMPLEMENTED` until signing is implemented.
- Risk gates: per-trade USD cap, daily loss cap, allowed-symbol whitelist, minimum confidence, idempotency on `recommendationId`.
- Bearer-token auth on every non-health endpoint, with constant-time comparison.
- Strict CORS (`FRONTEND_URL` only). CORS alone does not protect non-browser clients — the bearer token does.
- API keys are never logged (pino redaction list).

## Local setup

```bash
cd ~/Desktop/crypto-trading-backend
npm install
cp .env.example .env

# Generate a strong bearer token:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste it into BACKEND_API_KEY in .env

npm run dev
```

The server listens on `http://localhost:3001` by default. Hit `/health` to confirm it's up — it's the only public route.

## Railway deployment

1. Push this directory to a private GitHub repo.
2. Create a new Railway service from that repo.
3. Set every variable from `.env.example` in Railway's dashboard. **Never commit `.env`.**
4. Mount a Railway volume at `/app/data` so the SQLite database persists across deploys (Railway's default filesystem can be ephemeral).
5. Set `DATA_DIR=/app/data` in the Railway env.
6. Set `FRONTEND_URL` to your Lovable frontend's exact origin (no trailing slash, no wildcard).
7. Deploy. Railway sets `PORT` automatically.

## Required environment variables

| Var | Purpose | Default | Required for live? |
|---|---|---|---|
| `PORT` | HTTP port | `3001` | always |
| `FRONTEND_URL` | Single allowed CORS origin | `http://localhost:5173` | always |
| `BACKEND_API_KEY` | Shared bearer token | _(none)_ | always |
| `BOT_ENABLED` | Master kill switch | `false` | — |
| `PAPER_MODE` | Simulate vs send to Robinhood | `true` | — |
| `MAX_TRADE_USD` | Per-trade USD cap | `25` | always |
| `MAX_DAILY_LOSS_USD` | Circuit breaker on realized loss | `50` | always |
| `ALLOWED_SYMBOLS` | Whitelist (CSV) | `BTC-USD,ETH-USD` | always |
| `MIN_CONFIDENCE` | Min `confidenceScore` to accept | `0.5` | always |
| `ROBINHOOD_API_KEY` | Robinhood API key | _(blank)_ | live mode |
| `ROBINHOOD_PRIVATE_KEY` | Ed25519 private key (base64) | _(blank)_ | live mode |
| `DATA_DIR` | SQLite directory | `./data` | always |
| `LOG_LEVEL` | pino level | `info` | always |

The server refuses to start if `BACKEND_API_KEY` is missing/short, or if `BOT_ENABLED=true && PAPER_MODE=false` while Robinhood credentials are blank.

## Frontend integration

Every request except `/health` must include the bearer token:

```js
const API = import.meta.env.VITE_BACKEND_URL;       // e.g. https://crypto-bot.up.railway.app
const KEY = import.meta.env.VITE_BACKEND_API_KEY;   // matches BACKEND_API_KEY on the server

async function approve(rec) {
  const res = await fetch(`${API}/trade/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      recommendationId: rec.id,
      symbol: rec.symbol,                    // 'BTC-USD' | 'ETH-USD'
      side: rec.side,                        // 'buy' | 'sell'
      suggestedAmountUsd: rec.amountUsd,
      confidenceScore: rec.confidence,       // 0.0 - 1.0
      entryReason: rec.entryReason,
      stopLoss: rec.stopLoss,
      profitTarget: rec.profitTarget,
      invalidationLevel: rec.invalidationLevel,
      riskReward: rec.riskReward,
    }),
  });
  return res.json();
}
```

> **Security note:** the Lovable frontend will be embedding `BACKEND_API_KEY` into client-side bundles. Anyone with browser devtools can read it. That is acceptable for a single-user personal tool, because the only thing the token gates is paper trades and (eventually) trades capped at `MAX_TRADE_USD`. For multi-user use, replace the bearer token with per-user JWTs and re-think the auth layer.

### Response envelope

Every response is JSON:

```jsonc
// success
{ "ok": true,  "status": "simulated", ... }
// failure
{ "ok": false, "status": "rejected", "code": "BOT_DISABLED", "reason": "..." }
```

Stable rejection codes: `BOT_DISABLED`, `MISSING_FIELDS`, `INVALID_SIDE`, `SYMBOL_NOT_ALLOWED`, `AMOUNT_OUT_OF_RANGE`, `RISK_FIELDS_INVALID`, `CONFIDENCE_TOO_LOW`, `DAILY_LOSS_CAP_HIT`, `DUPLICATE_RECOMMENDATION`, `INVALID_BODY`, `UNAUTHENTICATED`, `RATE_LIMITED`, `NOT_IMPLEMENTED`, `INTERNAL_ERROR`.

## Paper vs live mode

| `BOT_ENABLED` | `PAPER_MODE` | `/trade/approve` behavior |
|---|---|---|
| `false` | _any_ | Reject with `BOT_DISABLED`. Master kill switch. |
| `true` | `true` | Simulate the trade, log it, return `status: "simulated"`. **No call to Robinhood.** |
| `true` | `false` | Calls `robinhoodClient.placeOrder()`. Currently returns `501 NOT_IMPLEMENTED` until signing is wired. |

`/trade/decline` and decision logging are unaffected by these flags.

## Safety checklist before flipping `PAPER_MODE=false`

Do not skip steps.

1. Implement Ed25519 request signing in `src/services/robinhoodClient.js` per the official Robinhood Crypto API docs and replace the `NotImplementedError` throws.
2. Test signed requests against a Robinhood sandbox or read-only endpoint first. Confirm headers, signature canonicalization, and clock skew handling.
3. Run at least 50 paper trades through `/trade/approve` and review the rows in `data/trading.db` — every field should match the recommendation.
4. Force a daily-loss-cap scenario by inserting losing rows directly into `trades` and confirm `DAILY_LOSS_CAP_HIT` fires.
5. Set `MAX_TRADE_USD` to the smallest amount you can stand to lose on a single trade.
6. Review `ALLOWED_SYMBOLS`. Anything outside this list is silently rejected.
7. Back up `data/trading.db`.
8. Test the kill switch: while a `npm start` instance is running, set `BOT_ENABLED=false` in Railway and restart. Confirm new approve requests get `BOT_DISABLED`.
9. Set `PAPER_MODE=false` **only in Railway's env vars** — never in any committed file. Commit a `PAPER_MODE=true` value to `.env.example` so a fresh checkout is safe by default.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public |
| GET | `/account` | bearer |
| POST | `/trade/approve` | bearer (rate-limited) |
| POST | `/trade/decline` | bearer (rate-limited) |
| GET | `/trades?limit=N&status=...&mode=...` | bearer |
| GET | `/performance` | bearer |
| GET | `/weekly-report` | bearer |

## Tests

```bash
npm test
```

Covers every rejection code in `riskManager.evaluate` plus a supertest pass over each route.

## Project layout

```
src/
├── server.js
├── config.js
├── db.js
├── middleware/    auth, validate, errorHandler
├── routes/        health, account, trade, trades, performance, weeklyReport
└── services/      robinhoodClient (stubs), riskManager, tradeLogger, logger
data/              gitignored; SQLite lives here
tests/             jest + supertest
```
