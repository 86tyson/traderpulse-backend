// src/backtest/loadCandles.ts
//
// Tiny dependency-free CSV loader for OHLCV candle data.
//
// Required header (case-insensitive, order doesn't matter):
//   timestamp,open,high,low,close,volume
//
// Timestamp accepted formats:
//   - ISO 8601 string  (e.g. "2024-01-01T00:00:00Z")
//   - Unix milliseconds (e.g. 1704067200000)
//   - Unix seconds      (e.g. 1704067200)  — auto-detected when value < 1e11
//
// No quoting / no embedded commas / no schema flexibility — fail loudly on anything else.

import * as fs from "fs";
import type { Candle } from "../lib/trading/snapshotBuilder";

const REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"] as const;

export function loadCandles(filePath: string): Candle[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`loadCandles: file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return parseCandlesCsv(raw, filePath);
}

export function parseCandlesCsv(raw: string, sourceLabel = "<input>"): Candle[] {
  const text = raw.replace(/^﻿/, "");                     // strip UTF-8 BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error(`loadCandles(${sourceLabel}): file is empty or has no data rows`);
  }

  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      throw new Error(
        `loadCandles(${sourceLabel}): missing required column "${col}". ` +
          `Got header: ${header.join(",")}`,
      );
    }
  }
  const idx = {
    timestamp: header.indexOf("timestamp"),
    open:      header.indexOf("open"),
    high:      header.indexOf("high"),
    low:       header.indexOf("low"),
    close:     header.indexOf("close"),
    volume:    header.indexOf("volume"),
  };

  const candles: Candle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((s) => s.trim());
    if (cells.length < REQUIRED_COLUMNS.length) {
      throw new Error(
        `loadCandles(${sourceLabel}): row ${i + 1} has ${cells.length} cells, expected at least ${REQUIRED_COLUMNS.length}`,
      );
    }
    const candle: Candle = {
      timestamp: parseTimestamp(cells[idx.timestamp], i + 1, sourceLabel),
      open:   Number(cells[idx.open]),
      high:   Number(cells[idx.high]),
      low:    Number(cells[idx.low]),
      close:  Number(cells[idx.close]),
      volume: Number(cells[idx.volume]),
    };
    if (
      !Number.isFinite(candle.open)  || !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low)   || !Number.isFinite(candle.close)
    ) {
      throw new Error(`loadCandles(${sourceLabel}): row ${i + 1} has non-numeric OHLC values`);
    }
    if (candle.high < candle.low) {
      throw new Error(`loadCandles(${sourceLabel}): row ${i + 1} has high < low`);
    }
    candles.push(candle);
  }

  // Sort by timestamp ascending — don't trust input ordering.
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function parseTimestamp(raw: string, rowNum: number, sourceLabel: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`loadCandles(${sourceLabel}): row ${rowNum} has empty timestamp`);
  }
  // Numeric: epoch seconds or milliseconds (auto-detect).
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) {
    return asNum < 1e11 ? asNum * 1000 : asNum;
  }
  // String: try Date.parse for ISO 8601.
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) {
    throw new Error(`loadCandles(${sourceLabel}): row ${rowNum} has invalid timestamp "${raw}"`);
  }
  return asDate;
}
