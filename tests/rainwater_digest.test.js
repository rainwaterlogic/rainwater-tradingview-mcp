/**
 * Unit tests for Rainwater compact digest helpers.
 * No TradingView connection needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addUsageMetrics, estimateTokens, summarizeBars } from '../src/core/rainwater.js';

describe('rainwater digest helpers', () => {
  it('estimates tokens from serialized payload size', () => {
    assert.equal(estimateTokens('12345678'), 2);
    assert.equal(estimateTokens({ a: '1234567' }), Math.ceil(JSON.stringify({ a: '1234567' }).length / 4));
  });

  it('summarizes bars without returning the full series', () => {
    const summary = summarizeBars([
      { time: 1, open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { time: 2, open: 101, high: 106, low: 100, close: 105, volume: 30 },
      { time: 3, open: 105, high: 107, low: 104, close: 106, volume: 20 },
      { time: 4, open: 106, high: 108, low: 103, close: 104, volume: 40 },
    ]);

    assert.equal(summary.count, 4);
    assert.equal(summary.open, 100);
    assert.equal(summary.close, 104);
    assert.equal(summary.high, 108);
    assert.equal(summary.low, 99);
    assert.equal(summary.range, 9);
    assert.equal(summary.change, 4);
    assert.equal(summary.change_pct, 4);
    assert.equal(summary.avg_volume, 25);
    assert.equal(summary.last_bars.length, 3);
  });

  it('adds elapsed, size, and token budget metadata', () => {
    const withUsage = addUsageMetrics({ success: true, drawings: { labels: [] } }, 12.4);

    assert.equal(withUsage.usage.elapsed_ms, 12);
    assert.ok(withUsage.usage.output_bytes > 0);
    assert.ok(withUsage.usage.estimated_tokens > 0);
    assert.equal(withUsage.usage.replaces_calls, 7);
  });
});
