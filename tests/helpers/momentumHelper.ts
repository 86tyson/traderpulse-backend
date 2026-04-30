// Tiny helper: receives JSON args via argv[2], runs evaluateMomentum,
// prints the result as JSON to stdout. Used by tests/momentum.test.js
// because jest is CommonJS-only and cannot require the TS module directly.

import { evaluateMomentum } from "../../src/lib/trading/momentumStrategy";

const raw = process.argv[2];
if (!raw) {
  process.stderr.write("Usage: tsx momentumHelper.ts '<json-args>'\n");
  process.exit(1);
}
const args = JSON.parse(raw);
const result = evaluateMomentum(args.candles, args.symbol, args.timeframe, args.params);
process.stdout.write(JSON.stringify(result));
