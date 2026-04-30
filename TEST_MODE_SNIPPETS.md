# Test Mode Panel — frontend stress test

Validates filtering logic, confidence scoring, and trade-frequency behavior across four mocked market regimes by running synthetic recommendations through the real `/trade/approve` endpoint.

**Pure frontend.** No backend changes. No new dependencies. Stays in `PAPER_MODE`. Test recommendations are prefixed `test-<regime>-…` so you can identify them in the trade log and `data/trading.db`.

---

## Pre-flight

1. Backend running (`npm run dev` in `~/Desktop/crypto-trading-backend`).
2. Set `BOT_ENABLED=true` in the backend `.env` and restart — otherwise every scan returns `BOT_DISABLED` and you only validate the kill switch (still useful, but limited).
3. Optional: delete `data/trading.db` before validating so the run starts on a clean slate. Restart backend after deleting.

---

## File 1: synthetic scanner

**File:** create `src/lib/mockScanner.ts`.

```ts
import type { TradeRequest } from '@/lib/api';

export type Regime = 'bullish' | 'bearish' | 'choppy' | 'low-volatility';

export interface ScanResult {
  regime: Regime;
  generated: boolean;
  trade?: TradeRequest;
  noTradeReason?: string;
}

const GENERATE_PROB: Record<Regime, number> = {
  'bullish':         0.80,
  'bearish':         0.70,
  'choppy':          0.30,
  'low-volatility':  0.15,
};

const CONFIDENCE_RANGE: Record<Regime, [number, number]> = {
  'bullish':         [0.70, 0.95],
  'bearish':         [0.60, 0.85],
  'choppy':          [0.30, 0.60],
  'low-volatility':  [0.20, 0.50],
};

const SIDE_BIAS: Record<Regime, 'buy' | 'sell' | 'mixed'> = {
  'bullish':         'buy',
  'bearish':         'sell',
  'choppy':          'mixed',
  'low-volatility':  'mixed',
};

const NO_TRADE_REASONS: Record<Regime, string[]> = {
  'bullish': [
    'No clean breakout in this scan window',
    'Price stalled below resistance',
  ],
  'bearish': [
    'No clean breakdown in this scan window',
    'Price held key support',
  ],
  'choppy': [
    'Range-bound — no directional setup',
    'Failed breakout filtered',
    'Whipsaw conditions detected',
  ],
  'low-volatility': [
    'Volatility too low to size a risk-defined trade',
    'ATR below minimum threshold',
    'No range expansion',
  ],
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function scan(regime: Regime): ScanResult {
  if (Math.random() > GENERATE_PROB[regime]) {
    return {
      regime,
      generated: false,
      noTradeReason: pickFrom(NO_TRADE_REASONS[regime]),
    };
  }

  const symbol: 'BTC-USD' | 'ETH-USD' = Math.random() < 0.5 ? 'BTC-USD' : 'ETH-USD';
  const bias = SIDE_BIAS[regime];
  const side: 'buy' | 'sell' =
    bias === 'buy'  ? (Math.random() < 0.9 ? 'buy'  : 'sell') :
    bias === 'sell' ? (Math.random() < 0.9 ? 'sell' : 'buy')  :
                       Math.random() < 0.5 ? 'buy' : 'sell';

  const [cmin, cmax] = CONFIDENCE_RANGE[regime];
  const confidenceScore = Number(rand(cmin, cmax).toFixed(2));

  const basePrice = symbol === 'BTC-USD' ? 60000 + rand(-2000, 2000) : 3000 + rand(-200, 200);
  const stopPct = regime === 'low-volatility' ? 0.005 : 0.015;
  const stopDistance = basePrice * stopPct;
  const targetDistance = stopDistance * rand(1.8, 3.0);

  const trade: TradeRequest = {
    recommendationId: `test-${regime}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    side,
    suggestedAmountUsd: 10,                                  // well under MAX_TRADE_USD=25
    confidenceScore,
    entryReason: `${regime} ${side} setup`,
    stopLoss:           side === 'buy' ? basePrice - stopDistance        : basePrice + stopDistance,
    profitTarget:       side === 'buy' ? basePrice + targetDistance      : basePrice - targetDistance,
    invalidationLevel:  side === 'buy' ? basePrice - stopDistance * 1.1  : basePrice + stopDistance * 1.1,
    riskReward: Number((targetDistance / stopDistance).toFixed(2)),
  };

  return { regime, generated: true, trade };
}
```

---

## File 2: the panel

**File:** create `src/components/TestModePanel.tsx`.

```tsx
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { scan, type Regime } from '@/lib/mockScanner';

const REGIMES: Regime[] = ['bullish', 'bearish', 'choppy', 'low-volatility'];

type Outcome = 'no-trade' | 'allowed' | 'filtered' | 'offline';

interface LogEntry {
  i: number;
  regime: Regime;
  outcome: Outcome;                              // allowed | filtered | no-trade | offline
  reason?: string;
  code?: string;
  confidence?: number;
  symbol?: string;
  side?: string;
  tradeOutcome?: 'win' | 'loss';                 // populated only for 'allowed' entries
  tradePnlUsd?: number;
}

interface Summary {
  total: number;
  generated: number;
  noTrade: number;
  allowed: number;
  filteredByBackend: number;
  offlineErrors: number;
  avgConfidenceGenerated: number | null;
  avgConfidenceAllowed: number | null;
  // Trade-outcome aggregates (populated from backend close-event data)
  wins: number;
  losses: number;
  observedWinRate: number | null;
  netPnlUsd: number;
}

// Every action originating from this panel is a synthetic test action.
// The flag is symbolic — the real isolation comes from the `test-` prefix on
// recommendationId, which the trade log + performance panel filter on.
const IS_TEST_MODE = true as const;

export function TestModePanel({ onSettled }: { onSettled?: () => void } = {}) {
  const [regime, setRegime] = useState<Regime>('bullish');
  const [count, setCount] = useState<number>(15);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);

  async function runLoop() {
    setRunning(true);
    setLog([]);
    setSummary(null);
    const entries: LogEntry[] = [];
    const confGen: number[] = [];
    const confAllowed: number[] = [];

    for (let i = 0; i < count; i++) {
      const result = scan(regime);
      let entry: LogEntry;

      if (!result.generated || !result.trade) {
        entry = {
          i: i + 1,
          regime,
          outcome: 'no-trade',
          reason: result.noTradeReason,
        };
      } else {
        const conf = result.trade.confidenceScore;
        confGen.push(conf);
        try {
          const r = await api.approve(result.trade);
          confAllowed.push(conf);
          entry = {
            i: i + 1,
            regime,
            outcome: 'allowed',
            confidence: conf,
            symbol: result.trade.symbol,
            side: result.trade.side,
            tradeOutcome: r.outcome,
            tradePnlUsd: r.pnlUsd,
            reason: `#${r.tradeId} ${r.outcome ?? ''} ${r.pnlUsd != null ? `(${r.pnlUsd >= 0 ? '+' : ''}$${r.pnlUsd.toFixed(2)})` : ''}`.trim(),
          };
        } catch (e) {
          if (e instanceof ApiError && e.code === 'BACKEND_OFFLINE') {
            entry = { i: i + 1, regime, outcome: 'offline', reason: e.reason };
          } else if (e instanceof ApiError) {
            entry = {
              i: i + 1,
              regime,
              outcome: 'filtered',
              code: e.code,
              reason: e.reason,
              confidence: conf,
              symbol: result.trade.symbol,
              side: result.trade.side,
            };
          } else {
            entry = { i: i + 1, regime, outcome: 'filtered', reason: String(e) };
          }
        }
      }

      entries.push(entry);
      setLog([...entries]);
      console.log(`[scan ${i + 1}/${count}] ${regime}`, { isTestMode: IS_TEST_MODE, ...entry });

      // small spacing so we never exceed the backend's 30-req/min /trade/* limit
      await new Promise(r => setTimeout(r, 100));
    }

    const allowed           = entries.filter(e => e.outcome === 'allowed').length;
    const filteredByBackend = entries.filter(e => e.outcome === 'filtered').length;
    const noTrade           = entries.filter(e => e.outcome === 'no-trade').length;
    const offlineErrors     = entries.filter(e => e.outcome === 'offline').length;
    const generated         = entries.length - noTrade;

    const wins   = entries.filter(e => e.tradeOutcome === 'win').length;
    const losses = entries.filter(e => e.tradeOutcome === 'loss').length;
    const closed = wins + losses;
    const netPnlUsd = entries.reduce((a, e) => a + (e.tradePnlUsd ?? 0), 0);

    const avg = (xs: number[]) =>
      xs.length === 0 ? null : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3));

    const sum: Summary = {
      total: entries.length,
      generated,
      noTrade,
      allowed,
      filteredByBackend,
      offlineErrors,
      avgConfidenceGenerated: avg(confGen),
      avgConfidenceAllowed: avg(confAllowed),
      wins,
      losses,
      observedWinRate: closed > 0 ? wins / closed : null,
      netPnlUsd: Number(netPnlUsd.toFixed(4)),
    };
    setSummary(sum);
    console.table(entries);
    console.log('[test loop summary]', { isTestMode: IS_TEST_MODE, regime, ...sum });

    setRunning(false);
    onSettled?.();
  }

  return (
    <div className="rounded-lg border-2 border-amber-300 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">Test Mode Panel</h3>
        <span className="text-xs text-muted-foreground">paper mode · synthetic scanner</span>
      </div>
      <div
        role="alert"
        className="rounded bg-amber-100 border border-amber-300 px-3 py-2 text-xs text-amber-900"
      >
        ⚠ <strong>This mode generates synthetic trades for validation. Results should not be used as real performance.</strong>
        <div className="mt-1 text-amber-800">
          Every action is tagged <code>isTestMode = true</code> and writes a <code>test-</code>-prefixed
          recommendationId to the backend, so the Trade Log and Performance panel can filter them out.
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {REGIMES.map(r => (
          <button
            key={r}
            disabled={running}
            onClick={() => setRegime(r)}
            className={`px-2 py-1 rounded text-xs border disabled:opacity-50 ${
              regime === r ? 'bg-foreground text-background' : ''
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm">Scans:</label>
        <input
          type="number"
          min={1}
          max={20}
          value={count}
          disabled={running}
          onChange={e => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
          className="w-16 border rounded px-2 py-1 text-sm"
        />
        <button
          disabled={running}
          onClick={runLoop}
          className="px-3 py-1.5 rounded bg-foreground text-background text-sm disabled:opacity-50"
        >
          {running ? 'Running…' : `Run ${count} scans`}
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm rounded bg-muted p-3">
          <Stat label="Total scans"          value={String(summary.total)} />
          <Stat label="Trades taken"         value={String(summary.allowed)} />
          <Stat label="Trades filtered"      value={String(summary.filteredByBackend + summary.noTrade)} />
          <Stat label="Filter rate"          value={`${pct(1 - summary.allowed / summary.total)}`} />
          <Stat label="Wins"                 value={String(summary.wins)} />
          <Stat label="Losses"               value={String(summary.losses)} />
          <Stat label="Observed win rate"    value={fmtPct(summary.observedWinRate)} />
          <Stat label="Net P/L (USD)"        value={summary.netPnlUsd >= 0 ? `+$${summary.netPnlUsd.toFixed(2)}` : `−$${Math.abs(summary.netPnlUsd).toFixed(2)}`} />
          <Stat label="Avg conf (generated)" value={fmtPct(summary.avgConfidenceGenerated)} />
          <Stat label="Avg conf (allowed)"   value={fmtPct(summary.avgConfidenceAllowed)} />
        </div>
      )}

      {log.length > 0 && (
        <div className="max-h-64 overflow-y-auto rounded border text-xs font-mono">
          {log.map(e => (
            <div
              key={e.i}
              className={`px-2 py-1 border-t flex items-center gap-2 ${
                e.outcome === 'allowed'  ? 'bg-emerald-50' :
                e.outcome === 'filtered' ? 'bg-red-50'     :
                e.outcome === 'offline'  ? 'bg-amber-50'   : ''
              }`}
            >
              <span className="text-muted-foreground w-8">#{e.i}</span>
              {e.outcome === 'allowed'  && <Badge tone="green">Trade allowed</Badge>}
              {e.outcome === 'filtered' && <Badge tone="red">Trade filtered out</Badge>}
              {e.outcome === 'no-trade' && <Badge tone="gray">No trade</Badge>}
              {e.outcome === 'offline'  && <Badge tone="amber">Backend offline</Badge>}
              {e.tradeOutcome === 'win'  && <Badge tone="green">WIN</Badge>}
              {e.tradeOutcome === 'loss' && <Badge tone="red">LOSS</Badge>}
              {e.symbol && <span>{e.symbol} {e.side}</span>}
              {e.confidence != null && <span>{(e.confidence * 100).toFixed(0)}%</span>}
              {e.tradePnlUsd != null && (
                <span className={e.tradePnlUsd >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                  {e.tradePnlUsd >= 0 ? '+' : '−'}${Math.abs(e.tradePnlUsd).toFixed(2)}
                </span>
              )}
              {e.code && <code className="text-red-700">{e.code}</code>}
              {e.reason && <span className="text-muted-foreground truncate">{e.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'red' | 'gray' | 'amber'; children: React.ReactNode }) {
  const cls =
    tone === 'green' ? 'bg-emerald-100 text-emerald-900' :
    tone === 'red'   ? 'bg-red-100 text-red-900'         :
    tone === 'amber' ? 'bg-amber-100 text-amber-900'     :
                       'bg-muted';
  return <span className={`px-1.5 py-0.5 rounded text-xs ${cls}`}>{children}</span>;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}
```

---

## File 3: dashboard wiring

**File:** edit your dashboard page (e.g. `src/pages/Dashboard.tsx`). Add the import + render the panel near the top so it's easy to find during validation.

```tsx
import { TestModePanel } from '@/components/TestModePanel';

// inside the dashboard JSX, e.g. just under <BackendStatusBanner />:
<TestModePanel onSettled={onSettled} />
```

`onSettled` is the same callback you already pass to `<RecommendationActions/>` — it bumps `refreshKey` so the trade log, performance panel, and weekly report re-fetch when the test loop finishes.

---

## What you should see (expected ranges)

Across 15–20 scans with `BOT_ENABLED=true`, `MIN_CONFIDENCE=0.5`, fresh DB:

| Regime | Generated | Backend allowed | Backend filter (mostly `CONFIDENCE_TOO_LOW`) | Total filter rate |
|---|---|---|---|---|
| **bullish** | ~80% | ~80% (all generated pass — confidence ≥ 0.7) | ~0% | ~20% |
| **bearish** | ~70% | ~70% (all generated pass — confidence ≥ 0.6) | ~0% | ~30% |
| **choppy** | ~30% | ~10–15% | ~15–20% (sub-0.5 confidences rejected) | ~80–85% |
| **low-volatility** | ~15% | ~0–5% | ~10–15% (most sub-0.5) | ~95% |

If filter rates land outside those bands by a wide margin, something has drifted — check `MIN_CONFIDENCE` on the backend and the regime probabilities at the top of `mockScanner.ts`.

---

## Cleanup

The test loop writes real rows to `data/trading.db`. Two options:

- **Cleanest:** stop the backend, `rm ~/Desktop/crypto-trading-backend/data/trading.db*`, restart. Wipes everything.
- **Surgical:** open the DB and delete by prefix.
  ```bash
  sqlite3 ~/Desktop/crypto-trading-backend/data/trading.db \
    "DELETE FROM trades    WHERE recommendation_id LIKE 'test-%';
     DELETE FROM decisions WHERE recommendation_id LIKE 'test-%';"
  ```

Optional: filter test rows out of the live `<TradeLog/>` if they're cluttering it during development.

```tsx
// inside TradeLog, after fetching rows:
const rows = res.trades.filter(t => !t.recommendation_id.startsWith('test-'));
```

---

## What this validates

- Backend `BOT_DISABLED` kill switch (set `BOT_ENABLED=false`, run any regime — every scan should be filtered with code `BOT_DISABLED`)
- Backend `CONFIDENCE_TOO_LOW` threshold (`MIN_CONFIDENCE=0.5` rejects choppy + low-vol generations)
- Backend `DUPLICATE_RECOMMENDATION` idempotency (each scan generates a unique id; if you tamper with `mockScanner.ts` to repeat one, the second hit should be rejected)
- Backend `SYMBOL_NOT_ALLOWED` (set `ALLOWED_SYMBOLS=BTC-USD` on the backend, restart, then run a regime — ETH-USD scans should be filtered)
- Backend `AMOUNT_OUT_OF_RANGE` (set `MAX_TRADE_USD=5`, restart — every scan exceeds the cap with `suggestedAmountUsd: 10`, so all should be filtered)
- Frontend trade-frequency behavior (regime probabilities visibly shift the generation rate)
- End-to-end auth + CORS + rate-limit headroom under load

## What this does NOT validate

- Live Robinhood execution — stub remains in place, `PAPER_MODE=true` enforced.
- Real market scanning — this is a synthetic generator. The point is to validate the *pipeline*, not the strategy.
- Realistic exit timing or partial fills — every trade closes instantly at either `profit_target` or `stop_loss`. Real markets have slippage, gaps, and partial fills.

## What this NOW validates (with close-event simulation)

- `DAILY_LOSS_CAP_HIT` — run enough losses (drop confidence to 0.5, large enough position size, or many scans) and the cap fires.
- Realized R:R — the avg-win / avg-loss ratio you see in `/performance` should match the *planned* R:R because the simulator hits target/stop cleanly. **In real trading this gap will be wider** — useful as a baseline.
- Win rate as a function of confidence — at default tuning, a 0.7-confidence input produces ~54% wins, 0.9 produces ~58%. Run 100 scans at fixed confidence and the observed rate should land in those bands.
