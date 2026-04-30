# Frontend integration — snippet pack (Vite + React)

Final, paste-ready code for connecting your Lovable (Vite + React + TypeScript) frontend to this backend in **paper mode only**. No live trading, no Robinhood credentials in the frontend, no extra libraries.

Each section below tells you exactly which file to create or edit in your Lovable project.

---

## 1. Env vars

**File:** `.env` at the **project root** (next to `package.json`). Add `.env` to `.gitignore` if it isn't already.

```bash
VITE_BACKEND_URL=http://localhost:3001
VITE_BACKEND_API_KEY=paste-the-same-token-as-BACKEND_API_KEY-on-the-server
```

> Anything prefixed `VITE_` is shipped to the browser bundle. The bearer token is therefore not a true secret — it gates casual access only. Real Robinhood credentials never go in the frontend.

**File:** `src/vite-env.d.ts` (create or extend this file at `src/vite-env.d.ts`):

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL: string;
  readonly VITE_BACKEND_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

After editing `.env`, **stop and restart `npm run dev`** — Vite only reads env vars at startup.

---

## 2. API client

**File:** create `src/lib/api.ts`.

```ts
const BASE = import.meta.env.VITE_BACKEND_URL;
const KEY = import.meta.env.VITE_BACKEND_API_KEY;

export type ApiErrorCode =
  | 'BACKEND_OFFLINE'
  | 'UNAUTHENTICATED'
  | 'BOT_DISABLED'
  | 'MISSING_FIELDS'
  | 'INVALID_SIDE'
  | 'SYMBOL_NOT_ALLOWED'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'RISK_FIELDS_INVALID'
  | 'CONFIDENCE_TOO_LOW'
  | 'DAILY_LOSS_CAP_HIT'
  | 'DUPLICATE_RECOMMENDATION'
  | 'INVALID_BODY'
  | 'RATE_LIMITED'
  | 'NOT_IMPLEMENTED'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  code: ApiErrorCode;
  reason: string;
  httpStatus: number | null;
  constructor(code: ApiErrorCode, reason: string, httpStatus: number | null = null) {
    super(reason);
    this.name = 'ApiError';
    this.code = code;
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

type RequestOpts = RequestInit & { auth?: boolean };

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body) headers.set('Content-Type', 'application/json');
  if (opts.auth !== false) headers.set('Authorization', `Bearer ${KEY}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...opts, headers });
  } catch {
    throw new ApiError(
      'BACKEND_OFFLINE',
      'Cannot reach backend (offline, CORS, or wrong VITE_BACKEND_URL).',
      null,
    );
  }

  let body: any = null;
  try { body = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const code = (body && body.code) || 'INTERNAL_ERROR';
    const reason = (body && body.reason) || `HTTP ${res.status}`;
    throw new ApiError(code as ApiErrorCode, reason, res.status);
  }
  return body as T;
}

// ---- Response types ----
export interface HealthResponse {
  ok: true;
  server: string;
  paperMode: boolean;
  botEnabled: boolean;
  allowedSymbols: string[];
  timestamp: string;
}

export interface AccountResponse {
  ok: true;
  mode: 'paper' | 'live';
  account: { cashUsd: number; equityUsd: number; buyingPowerUsd: number };
  holdings: { symbol: string; quantity: number; avgCostUsd: number; marketValueUsd: number }[];
  note?: string;
}

export interface TradeRequest {
  recommendationId: string;
  symbol: string;
  side: 'buy' | 'sell';
  suggestedAmountUsd: number;
  confidenceScore: number;        // 0.0 – 1.0
  entryReason: string;
  stopLoss: number;
  profitTarget: number;
  invalidationLevel: number;
  riskReward: number;
}

export interface ApproveResponse {
  ok: true;
  status: 'simulated' | 'executed';
  mode: 'paper' | 'live';
  tradeId: number;
  recommendationId: string;
  // Paper mode closes synchronously; these are populated immediately.
  outcome?: 'win' | 'loss';
  exitPrice?: number;
  entryPrice?: number;
  pnlUsd?: number;
  realizedRR?: number;
  message?: string;
}

export interface DeclineResponse {
  ok: true;
  status: 'declined';
  recommendationId: string;
}

export interface TradeRow {
  id: number;
  recommendation_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  suggested_amount_usd: number;
  confidence_score: number;
  entry_reason: string | null;
  stop_loss: number | null;
  profit_target: number | null;
  invalidation_level: number | null;
  risk_reward: number | null;
  status: 'simulated' | 'executed' | 'rejected';
  mode: 'paper' | 'live';
  simulated_pnl_usd: number | null;        // realized P/L; null until trade is closed
  robinhood_order_id: string | null;
  created_at: string;                      // ISO 8601 (e.g. "2026-04-28T17:05:54Z")
  executed_at: string | null;              // ISO 8601 or null
  exit_price: number | null;               // null while open
  exit_timestamp: string | null;           // ISO 8601 or null
  outcome: 'win' | 'loss' | null;          // null while open
}

export interface TradesResponse {
  ok: true;
  count: number;
  trades: TradeRow[];
}

export interface PerformanceResponse {
  ok: true;
  totalTrades: number;
  wins: number;
  losses: number;
  openOrUnsettled: number;
  winRate: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  netPnlUsd: number;
  weeklyPnlUsd: number;
  note?: string;
}

export interface WeeklyReportResponse {
  ok: true;
  period: 'last_7_days';
  totalTrades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  bestSetup: { recommendationId: string; entryReason: string | null; pnlUsd: number } | null;
  worstSetup: { recommendationId: string; entryReason: string | null; pnlUsd: number } | null;
  notes?: string;
}

// ---- Endpoint functions ----
export const api = {
  health: () => request<HealthResponse>('/health', { auth: false }),
  account: () => request<AccountResponse>('/account'),
  approve: (body: TradeRequest) =>
    request<ApproveResponse>('/trade/approve', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  decline: (recommendationId: string, reason: string) =>
    request<DeclineResponse>('/trade/decline', {
      method: 'POST',
      body: JSON.stringify({ recommendationId, reason }),
    }),
  trades: (params?: { limit?: number; status?: string; mode?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.status) q.set('status', params.status);
    if (params?.mode) q.set('mode', params.mode);
    const qs = q.toString();
    return request<TradesResponse>(`/trades${qs ? `?${qs}` : ''}`);
  },
  performance: () => request<PerformanceResponse>('/performance'),
  weeklyReport: () => request<WeeklyReportResponse>('/weekly-report'),
};

// ---- Date helper (backend emits ISO 8601, so this is just a thin wrapper) ----
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ---- Test-trade tagging helper ----
// Test Mode Panel prefixes every recommendationId with "test-". Use this to
// segregate validation data from real paper-trade metrics in the UI.
export function isTestRecommendation(id: string): boolean {
  return typeof id === 'string' && id.startsWith('test-');
}

// ---- Error → human message ----
export function describeError(e: unknown): { title: string; detail: string } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'BACKEND_OFFLINE':
        return {
          title: 'Backend unreachable',
          detail: 'Check VITE_BACKEND_URL, CORS allow-list, and that the backend is running.',
        };
      case 'UNAUTHENTICATED':
        return {
          title: 'Unauthorized',
          detail: 'VITE_BACKEND_API_KEY does not match the server. Update your env and reload.',
        };
      case 'BOT_DISABLED':
        return {
          title: 'Bot disabled',
          detail: 'BOT_ENABLED is false on the backend. Trades will be rejected until it is enabled.',
        };
      case 'DUPLICATE_RECOMMENDATION':
        return {
          title: 'Already processed',
          detail: 'This recommendation was already approved or rejected. Generate a new one to retry.',
        };
      case 'SYMBOL_NOT_ALLOWED':
      case 'AMOUNT_OUT_OF_RANGE':
      case 'CONFIDENCE_TOO_LOW':
      case 'RISK_FIELDS_INVALID':
      case 'INVALID_SIDE':
      case 'MISSING_FIELDS':
      case 'INVALID_BODY':
      case 'DAILY_LOSS_CAP_HIT':
        return { title: 'Trade rejected', detail: e.reason };
      case 'RATE_LIMITED':
        return { title: 'Slow down', detail: 'Too many trade requests in a short window.' };
      case 'NOT_IMPLEMENTED':
        return {
          title: 'Live mode not ready',
          detail: 'Robinhood live execution is not yet wired. Stay in paper mode.',
        };
      default:
        return { title: 'Error', detail: e.reason };
    }
  }
  return { title: 'Error', detail: e instanceof Error ? e.message : 'Unknown error' };
}
```

---

## 3. Backend status banner

**File:** create `src/components/BackendStatusBanner.tsx`.

```tsx
import { useEffect, useState } from 'react';
import { api, ApiError, type HealthResponse } from '@/lib/api';

export function BackendStatusBanner() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        setHealth(h);
        setOffline(false);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.code === 'BACKEND_OFFLINE') setOffline(true);
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (offline) return <Bar tone="red">Backend offline. Approvals and the trade log will not work.</Bar>;
  if (!health) return null;
  if (!health.paperMode) return <Bar tone="red">⚠ LIVE MODE — orders will hit Robinhood. Set PAPER_MODE=true on the backend.</Bar>;
  if (!health.botEnabled) return <Bar tone="amber">Bot is disabled (BOT_ENABLED=false). Approvals will be rejected.</Bar>;
  return <Bar tone="green">Paper mode · bot enabled · symbols: {health.allowedSymbols.join(', ')}</Bar>;
}

function Bar({ tone, children }: { tone: 'red' | 'amber' | 'green'; children: React.ReactNode }) {
  const cls =
    tone === 'red'   ? 'bg-red-100 text-red-900' :
    tone === 'amber' ? 'bg-amber-100 text-amber-900' :
                       'bg-emerald-100 text-emerald-900';
  return <div className={`px-3 py-2 text-sm rounded ${cls}`}>{children}</div>;
}
```

---

## 4. Account summary

**File:** create `src/components/AccountSummary.tsx`.

```tsx
import { useEffect, useState } from 'react';
import { api, describeError, type AccountResponse } from '@/lib/api';

export function AccountSummary() {
  const [data, setData] = useState<AccountResponse | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    api.account().then(setData).catch(setErr);
  }, []);

  if (err) {
    const { title, detail } = describeError(err);
    return <div className="text-sm text-red-700"><b>{title}.</b> {detail}</div>;
  }
  if (!data) return <div className="text-sm text-muted-foreground">Loading account…</div>;

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Account</h3>
        <span className="text-xs uppercase tracking-wide rounded bg-muted px-2 py-0.5">{data.mode}</span>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-muted-foreground">Cash</dt><dd>${data.account.cashUsd.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground">Equity</dt><dd>${data.account.equityUsd.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground">Buying power</dt><dd>${data.account.buyingPowerUsd.toLocaleString()}</dd></div>
      </dl>
      {data.holdings.length > 0 && (
        <table className="w-full text-sm mt-2">
          <thead className="text-muted-foreground">
            <tr><th className="text-left">Symbol</th><th className="text-right">Qty</th><th className="text-right">Avg cost</th><th className="text-right">Mkt value</th></tr>
          </thead>
          <tbody>
            {data.holdings.map(h => (
              <tr key={h.symbol}>
                <td>{h.symbol}</td>
                <td className="text-right">{h.quantity}</td>
                <td className="text-right">${h.avgCostUsd}</td>
                <td className="text-right">${h.marketValueUsd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
    </div>
  );
}
```

---

## 5. Approve / Decline buttons

**File:** create `src/components/RecommendationActions.tsx`. Drop this into your existing recommendation card UI — pass it the recommendation object.

```tsx
import { useState } from 'react';
import { api, describeError, type TradeRequest } from '@/lib/api';
import { toast } from 'sonner';                   // Lovable's default toast lib

export interface Recommendation {
  id: string;                     // stable per card; use crypto.randomUUID() at create time
  symbol: 'BTC-USD' | 'ETH-USD';
  side: 'buy' | 'sell';
  suggestedAmountUsd: number;
  confidenceScore: number;        // 0.0 – 1.0
  entryReason: string;
  stopLoss: number;
  profitTarget: number;
  invalidationLevel: number;
  riskReward: number;
}

export function RecommendationActions({
  rec,
  onSettled,
}: {
  rec: Recommendation;
  onSettled?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      const body: TradeRequest = {
        recommendationId: rec.id,
        symbol: rec.symbol,
        side: rec.side,
        suggestedAmountUsd: rec.suggestedAmountUsd,
        confidenceScore: rec.confidenceScore,
        entryReason: rec.entryReason,
        stopLoss: rec.stopLoss,
        profitTarget: rec.profitTarget,
        invalidationLevel: rec.invalidationLevel,
        riskReward: rec.riskReward,
      };
      const result = await api.approve(body);
      toast.success(`Trade ${result.status} (${result.mode})`, {
        description: `Trade #${result.tradeId} for ${rec.symbol}.`,
      });
    } catch (e) {
      const { title, detail } = describeError(e);
      toast.error(title, { description: detail });
    } finally {
      setBusy(false);
      onSettled?.();
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api.decline(rec.id, 'manual decline');
      toast.info('Recommendation declined');
    } catch (e) {
      const { title, detail } = describeError(e);
      toast.error(title, { description: detail });
    } finally {
      setBusy(false);
      onSettled?.();
    }
  }

  return (
    <div className="flex gap-2">
      <button
        disabled={busy}
        onClick={approve}
        className="px-3 py-1.5 rounded bg-emerald-600 text-white disabled:opacity-50"
      >
        Approve
      </button>
      <button
        disabled={busy}
        onClick={decline}
        className="px-3 py-1.5 rounded border disabled:opacity-50"
      >
        Decline
      </button>
    </div>
  );
}
```

> **Idempotency:** generate `rec.id` once when the card is created (`crypto.randomUUID()`), not on every render. Re-clicking Approve will get a `DUPLICATE_RECOMMENDATION` toast — that's the correct behavior.

---

## 6. Trade Log

**File:** create `src/components/TradeLog.tsx`.

```tsx
import { useEffect, useState, useCallback } from 'react';
import { api, describeError, formatDate, isTestRecommendation, type TradeRow } from '@/lib/api';

export function TradeLog() {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [showTest, setShowTest] = useState(false);          // default: hide test trades

  const load = useCallback(async () => {
    try {
      const res = await api.trades({ limit: 200 });
      setRows(res.trades);
      setErr(null);
    } catch (e) {
      setErr(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (err) {
    const { title, detail } = describeError(err);
    return <div className="text-sm text-red-700"><b>{title}.</b> {detail}</div>;
  }
  if (!rows) return <div>Loading trades…</div>;

  const visibleRows = showTest
    ? rows
    : rows.filter(t => !isTestRecommendation(t.recommendation_id));
  const hiddenTestCount = rows.length - visibleRows.length;

  return (
    <div className="rounded-lg border overflow-x-auto">
      <div className="flex items-center justify-between p-2 border-b text-sm">
        <span className="font-semibold">Trade log</span>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={showTest}
            onChange={e => setShowTest(e.target.checked)}
          />
          Show test trades
          {hiddenTestCount > 0 && !showTest && (
            <span className="text-muted-foreground">({hiddenTestCount} hidden)</span>
          )}
        </label>
      </div>

      {visibleRows.length === 0 ? (
        <div className="text-sm text-muted-foreground p-3">No trades to show.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left p-2">When</th>
              <th className="text-left">Symbol</th>
              <th>Side</th>
              <th className="text-right">USD</th>
              <th className="text-right">Conf</th>
              <th>Outcome</th>
              <th className="text-right">P/L</th>
              <th>Tag</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(t => {
              const isTest = isTestRecommendation(t.recommendation_id);
              const isOpen = t.outcome == null;
              const pnlClass =
                t.simulated_pnl_usd == null ? '' :
                t.simulated_pnl_usd >= 0    ? 'text-emerald-700' : 'text-red-700';
              return (
                <tr key={t.id} className={`border-t ${isTest ? 'bg-amber-50' : ''}`}>
                  <td className="p-2">{formatDate(t.created_at)}</td>
                  <td>{t.symbol}</td>
                  <td>{t.side}</td>
                  <td className="text-right">${t.suggested_amount_usd}</td>
                  <td className="text-right">{(t.confidence_score * 100).toFixed(0)}%</td>
                  <td>
                    {isOpen ? (
                      <span className="text-muted-foreground text-xs">open</span>
                    ) : t.outcome === 'win' ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-900 font-semibold">WIN</span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-900 font-semibold">LOSS</span>
                    )}
                  </td>
                  <td className={`text-right ${pnlClass}`}>
                    {t.simulated_pnl_usd == null ? '—' : `${t.simulated_pnl_usd >= 0 ? '+' : '−'}$${Math.abs(t.simulated_pnl_usd).toFixed(2)}`}
                  </td>
                  <td>
                    {isTest && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-200 text-amber-900 font-semibold tracking-wide">
                        TEST TRADE
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

`isTestRecommendation` (in `api.ts`) returns `true` when the id starts with `test-`. The checkbox toggles visibility; default is **hide**, so real paper-trade history stays clean.

---

## 7. Performance panel

**File:** create `src/components/PerformancePanel.tsx`.

Computed locally from `/trades` so test rows can be excluded — `/performance` doesn't know about the `test-` convention.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { api, describeError, isTestRecommendation, type TradeRow } from '@/lib/api';

export function PerformancePanel() {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [includeTest, setIncludeTest] = useState(false);          // default: exclude test trades

  useEffect(() => {
    api.trades({ limit: 500 }).then(r => setRows(r.trades)).catch(setErr);
  }, []);

  const stats = useMemo(() => {
    if (!rows) return null;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const includeRow = (t: TradeRow) =>
      includeTest || !isTestRecommendation(t.recommendation_id);
    let wins = 0, losses = 0, openOrUnsettled = 0;
    let sumWin = 0, sumLoss = 0, net = 0, weekly = 0;
    for (const t of rows) {
      if (t.status === 'rejected') continue;
      if (!includeRow(t)) continue;
      if (t.outcome == null) { openOrUnsettled++; continue; }
      const pnl = t.simulated_pnl_usd ?? 0;
      net += pnl;
      if (t.outcome === 'win')  { wins++;   sumWin  += pnl; }
      if (t.outcome === 'loss') { losses++; sumLoss += pnl; }
      if (new Date(t.created_at).getTime() >= sevenDaysAgo) weekly += pnl;
    }
    const closed = wins + losses;
    const avgWinUsd  = wins   > 0 ? sumWin  / wins   : null;
    const avgLossUsd = losses > 0 ? sumLoss / losses : null;
    const realizedRR =
      avgWinUsd != null && avgLossUsd != null && avgLossUsd !== 0
        ? Math.abs(avgWinUsd / avgLossUsd)
        : null;
    return {
      total: closed,
      wins, losses, openOrUnsettled,
      winRate: closed > 0 ? wins / closed : null,
      avgWinUsd, avgLossUsd, realizedRR,
      netPnlUsd: net,
      weeklyPnlUsd: weekly,
    };
  }, [rows, includeTest]);

  const hiddenCount = useMemo(() => {
    if (!rows || includeTest) return 0;
    return rows.filter(t => t.status !== 'rejected' && isTestRecommendation(t.recommendation_id)).length;
  }, [rows, includeTest]);

  if (err) {
    const { title, detail } = describeError(err);
    return <div className="text-sm text-red-700"><b>{title}.</b> {detail}</div>;
  }
  if (!rows || !stats) return <div>Loading…</div>;

  const winRate = stats.winRate == null ? '—' : `${(stats.winRate * 100).toFixed(1)}%`;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Performance</h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeTest}
            onChange={e => setIncludeTest(e.target.checked)}
          />
          Include test trades
          {hiddenCount > 0 && !includeTest && (
            <span className="text-muted-foreground">({hiddenCount} hidden)</span>
          )}
        </label>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Stat label="Closed trades" value={String(stats.total)} />
        <Stat label="Wins"          value={String(stats.wins)} />
        <Stat label="Losses"        value={String(stats.losses)} />
        <Stat label="Win rate"      value={winRate} />
        <Stat label="Avg win"       value={fmtUsd(stats.avgWinUsd)} />
        <Stat label="Avg loss"      value={fmtUsd(stats.avgLossUsd)} />
        <Stat label="Realized R:R"  value={stats.realizedRR == null ? '—' : `${stats.realizedRR.toFixed(2)} : 1`} />
        <Stat label="Net P/L"       value={fmtUsd(stats.netPnlUsd)} />
        <Stat label="Weekly P/L"    value={fmtUsd(stats.weeklyPnlUsd)} />
        <Stat label="Open"          value={String(stats.openOrUnsettled)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Closed trades only (win or loss). Open trades counted separately. {includeTest ? 'Including' : 'Excluding'} test-mode trades. Computed from up to 500 most recent rows.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
```

---

## 8. Weekly report

**File:** create `src/components/WeeklyReport.tsx`.

Computed locally from `/trades` so test rows can be excluded.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { api, describeError, isTestRecommendation, type TradeRow } from '@/lib/api';

export function WeeklyReport() {
  const [rows, setRows] = useState<TradeRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [includeTest, setIncludeTest] = useState(false);          // default: exclude

  useEffect(() => {
    api.trades({ limit: 500 }).then(r => setRows(r.trades)).catch(setErr);
  }, []);

  const report = useMemo(() => {
    if (!rows) return null;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const eligible = rows.filter(t => {
      if (t.outcome !== 'win' && t.outcome !== 'loss') return false;     // closed only
      if (!includeTest && isTestRecommendation(t.recommendation_id)) return false;
      return new Date(t.created_at).getTime() >= sevenDaysAgo;
    });
    let wins = 0, losses = 0, net = 0;
    let best: TradeRow | null = null;
    let worst: TradeRow | null = null;
    for (const t of eligible) {
      const pnl = t.simulated_pnl_usd ?? 0;
      net += pnl;
      if (t.outcome === 'win')  wins++;
      if (t.outcome === 'loss') losses++;
      if (!best  || (best.simulated_pnl_usd  ?? -Infinity) < pnl) best  = t;
      if (!worst || (worst.simulated_pnl_usd ??  Infinity) > pnl) worst = t;
    }
    return { totalTrades: eligible.length, wins, losses, netPnlUsd: net, best, worst };
  }, [rows, includeTest]);

  if (err) {
    const { title, detail } = describeError(err);
    return <div className="text-sm text-red-700"><b>{title}.</b> {detail}</div>;
  }
  if (!rows || !report) return <div>Loading…</div>;

  return (
    <div className="rounded-lg border p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Last 7 days</h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeTest}
            onChange={e => setIncludeTest(e.target.checked)}
          />
          Include test trades
        </label>
      </div>
      <div>
        {report.totalTrades} trades · {report.wins}W / {report.losses}L · net ${report.netPnlUsd.toFixed(2)}
      </div>
      {report.best && (
        <div><b>Best:</b> {report.best.entry_reason ?? '—'} (${(report.best.simulated_pnl_usd ?? 0).toFixed(2)})</div>
      )}
      {report.worst && (
        <div><b>Worst:</b> {report.worst.entry_reason ?? '—'} (${(report.worst.simulated_pnl_usd ?? 0).toFixed(2)})</div>
      )}
      <p className="text-xs text-muted-foreground">
        Computed from /trades (up to 500 rows). {includeTest ? 'Including' : 'Excluding'} test-mode trades.
      </p>
    </div>
  );
}
```

---

## 9. Dashboard page wiring

**File:** edit your top-level dashboard page (typically `src/pages/Index.tsx` or `src/pages/Dashboard.tsx` in a Lovable project — whichever route renders the main UI).

```tsx
import { useState, useCallback } from 'react';
import { BackendStatusBanner } from '@/components/BackendStatusBanner';
import { AccountSummary } from '@/components/AccountSummary';
import { TradeLog } from '@/components/TradeLog';
import { PerformancePanel } from '@/components/PerformancePanel';
import { WeeklyReport } from '@/components/WeeklyReport';
// import RecommendationActions inside your existing recommendation card component

export default function Dashboard() {
  const [refreshKey, setRefreshKey] = useState(0);
  const onSettled = useCallback(() => setRefreshKey(k => k + 1), []);

  return (
    <div className="space-y-4 p-4">
      <BackendStatusBanner />
      <AccountSummary key={`acct-${refreshKey}`} />

      {/* Your existing mock-scanned recommendation cards go here.
          In each card, render <RecommendationActions rec={rec} onSettled={onSettled} />. */}

      <PerformancePanel key={`perf-${refreshKey}`} />
      <WeeklyReport     key={`week-${refreshKey}`} />
      <TradeLog         key={`log-${refreshKey}`} />
    </div>
  );
}
```

The `key` trick re-mounts each panel after every approve/decline so the data refreshes. No React Query needed.

---

## 10. CORS — backend env must match

Set `FRONTEND_URL` on the **backend** to the **exact** origin of your frontend (scheme + host + port, no trailing slash):

```bash
# backend .env (Vite dev default)
FRONTEND_URL=http://localhost:5173
```

When deployed, set it in Railway to your Lovable preview URL (e.g. `https://your-app.lovable.app`).

If `BACKEND_OFFLINE` keeps firing while `curl localhost:3001/health` works, the cause is almost always a CORS mismatch — browsers report it identically to a network error.

---

## 11. Verification checklist

With backend on `localhost:3001` and frontend on `localhost:5173`:

1. Status banner is **green** ("Paper mode · bot enabled") when `BOT_ENABLED=true` on the backend, **amber** ("Bot is disabled") when false.
2. `<AccountSummary/>` shows mock paper data (`Cash $1,000`, two zero-quantity holdings).
3. Click Approve on a recommendation:
   - With `BOT_ENABLED=false`: red toast "Bot disabled".
   - With `BOT_ENABLED=true`: green toast "Trade simulated (paper)". Trade Log gets a new row. Performance counters update.
4. Click Approve again on the same recommendation: red toast "Already processed".
5. Stop the backend, wait 30 s — banner flips to red "Backend offline".
6. Set `VITE_BACKEND_API_KEY` to a wrong value, restart `npm run dev` — every authed call shows the "Unauthorized" toast.

If all six pass, the wiring is correct.

---

## 12. Live-trading guards

- ❌ Do **not** put `ROBINHOOD_API_KEY` or `ROBINHOOD_PRIVATE_KEY` in any frontend env var. They stay server-side only.
- ❌ Do **not** add a "switch to live" toggle in the UI. The backend's Robinhood client is a stub that returns `NOT_IMPLEMENTED`. Live mode is flipped via Railway env vars (`PAPER_MODE=false`), never from the UI.
- ❌ Do **not** log the bearer token, request body, or response in your frontend console.
- ❌ Do **not** bypass `describeError()` and surface raw stack traces — backend reasons are user-friendly; raw errors are not.

## File checklist

| Status | File | Action |
|---|---|---|
| ☐ | `.env` | create at project root |
| ☐ | `src/vite-env.d.ts` | create or extend |
| ☐ | `src/lib/api.ts` | create |
| ☐ | `src/components/BackendStatusBanner.tsx` | create |
| ☐ | `src/components/AccountSummary.tsx` | create |
| ☐ | `src/components/RecommendationActions.tsx` | create; render inside each recommendation card |
| ☐ | `src/components/TradeLog.tsx` | create |
| ☐ | `src/components/PerformancePanel.tsx` | create |
| ☐ | `src/components/WeeklyReport.tsx` | create |
| ☐ | `src/pages/Dashboard.tsx` (or your existing dashboard route) | edit to render the panels |
| ☐ | backend `.env` | set `FRONTEND_URL=http://localhost:5173` |
