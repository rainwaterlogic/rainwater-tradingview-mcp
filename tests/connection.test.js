/**
 * Unit tests for connection safety configuration.
 * No TradingView connection needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectionStatus } from '../src/connection.js';

describe('connection safety defaults', () => {
  it('reports bounded CDP timeouts and serialized-evaluate cooldown', () => {
    const status = connectionStatus();

    assert.equal(status.connected, false);
    assert.equal(status.cdp.port, 9222);
    assert.ok(status.cdp.retries >= 1);
    assert.ok(status.timeouts_ms.fetch > 0);
    assert.ok(status.timeouts_ms.connect > 0);
    assert.ok(status.timeouts_ms.enable > 0);
    assert.ok(status.timeouts_ms.liveness > 0);
    assert.ok(status.timeouts_ms.evaluate > 0);
    assert.ok(status.timeouts_ms.evaluate_async >= status.timeouts_ms.evaluate);
    assert.ok(status.timeouts_ms.evaluate_cooldown >= 0);
    assert.equal(status.global_evaluate_lock.enabled, true);
    assert.ok(status.timeouts_ms.global_evaluate_lock > 0);
    assert.match(status.global_evaluate_lock.path, /evaluate\.lock$/);
  });
});
