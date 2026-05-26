import CDP from 'chrome-remote-interface';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

let client = null;
let targetInfo = null;
let evaluateQueue = Promise.resolve();
const CDP_HOST = process.env.TV_MCP_CDP_HOST || 'localhost';
const CDP_PORT = envInt('TV_MCP_CDP_PORT', 9222, 65535);
const MAX_RETRIES = envInt('TV_MCP_CONNECT_RETRIES', 3, 10);
const BASE_DELAY = 500;
const FETCH_TIMEOUT_MS = envInt('TV_MCP_FETCH_TIMEOUT_MS', 2500, 60000);
const CONNECT_TIMEOUT_MS = envInt('TV_MCP_CONNECT_TIMEOUT_MS', 5000, 60000);
const ENABLE_TIMEOUT_MS = envInt('TV_MCP_ENABLE_TIMEOUT_MS', 5000, 60000);
const LIVENESS_TIMEOUT_MS = envInt('TV_MCP_LIVENESS_TIMEOUT_MS', 2000, 30000);
const EVALUATE_TIMEOUT_MS = envInt('TV_MCP_EVALUATE_TIMEOUT_MS', 10000, 120000);
const EVALUATE_ASYNC_TIMEOUT_MS = envInt('TV_MCP_EVALUATE_ASYNC_TIMEOUT_MS', 20000, 180000);
const EVALUATE_COOLDOWN_MS = envInt('TV_MCP_EVALUATE_COOLDOWN_MS', 25, 5000);
const GLOBAL_LOCK_ENABLED = process.env.TV_MCP_GLOBAL_LOCK !== '0';
const GLOBAL_LOCK_TIMEOUT_MS = envInt('TV_MCP_GLOBAL_LOCK_TIMEOUT_MS', 15000, 120000);
const GLOBAL_LOCK_STALE_MS = envInt('TV_MCP_GLOBAL_LOCK_STALE_MS', Math.max(30000, EVALUATE_ASYNC_TIMEOUT_MS + 10000), 300000);
const GLOBAL_LOCK_POLL_MS = envInt('TV_MCP_GLOBAL_LOCK_POLL_MS', 50, 5000);
const RUNTIME_DIR = nodePath.join(homedir(), '.tradingview-mcp', 'runtime');
const EVALUATE_LOCK_DIR = nodePath.join(RUNTIME_DIR, 'evaluate.lock');

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

function envInt(name, fallback, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutMessage(label, ms) {
  return `${label} timed out after ${ms}ms. TradingView may be busy, loading, or its renderer may have crashed. The MCP connection was reset; run tv doctor if this repeats.`;
}

async function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  let settled = false;
  const operation = Promise.resolve(promise);
  operation.catch(() => {});

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      try { onTimeout?.(); } catch {}
      reject(new Error(timeoutMessage(label, ms)));
    }, ms);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

function resetClient() {
  const oldClient = client;
  client = null;
  targetInfo = null;
  if (oldClient) {
    oldClient.close().catch(() => {});
  }
}

async function cdpCall(promise, ms, label) {
  return withTimeout(promise, ms, label, resetClient);
}

function shouldResetClient(err) {
  return /timed out|WebSocket|ECONN|closed|Target closed|not opened|socket|Protocol error/i.test(err?.message || String(err));
}

function withoutLocalOptions(opts) {
  const { timeout_ms, timeoutMs, ...rest } = opts || {};
  return rest;
}

function timeoutFromOptions(opts = {}) {
  return opts.timeout_ms || opts.timeoutMs || (opts.awaitPromise ? EVALUATE_ASYNC_TIMEOUT_MS : EVALUATE_TIMEOUT_MS);
}

function enqueueEvaluate(task) {
  const run = evaluateQueue.catch(() => {}).then(async () => {
    if (EVALUATE_COOLDOWN_MS > 0) await sleep(EVALUATE_COOLDOWN_MS);
    return task();
  });
  evaluateQueue = run.catch(() => {});
  return run;
}

async function acquireGlobalEvaluateLock() {
  if (!GLOBAL_LOCK_ENABLED) return async () => {};

  const startedAt = Date.now();
  await fs.mkdir(RUNTIME_DIR, { recursive: true }).catch(() => {});

  while (true) {
    try {
      await fs.mkdir(EVALUATE_LOCK_DIR);
      await fs.writeFile(nodePath.join(EVALUATE_LOCK_DIR, 'owner.json'), JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }, null, 2)).catch(() => {});
      return async () => {
        await fs.rm(EVALUATE_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      try {
        const stat = await fs.stat(EVALUATE_LOCK_DIR);
        if (Date.now() - stat.mtimeMs > GLOBAL_LOCK_STALE_MS) {
          await fs.rm(EVALUATE_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code !== 'ENOENT') throw statErr;
        continue;
      }

      if (Date.now() - startedAt > GLOBAL_LOCK_TIMEOUT_MS) {
        throw new Error(`Cross-process CDP evaluate lock waited ${GLOBAL_LOCK_TIMEOUT_MS}ms. Another MCP server may be stuck; run tv doctor if this repeats.`);
      }
      await sleep(GLOBAL_LOCK_POLL_MS);
    }
  }
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await cdpCall(
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        LIVENESS_TIMEOUT_MS,
        'CDP liveness check',
      );
      return client;
    } catch {
      resetClient();
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  const failedTargetIds = new Set();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let nextClient = null;
    let target = null;
    try {
      target = await findChartTarget(failedTargetIds);
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      const connectPromise = CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      connectPromise.catch(() => {});
      nextClient = await withTimeout(
        connectPromise,
        CONNECT_TIMEOUT_MS,
        `CDP connect to target ${target.id}`,
        () => { connectPromise.then(c => c.close()).catch(() => {}); },
      );

      // Enable required domains
      await withTimeout(nextClient.Runtime.enable(), ENABLE_TIMEOUT_MS, 'CDP Runtime.enable');
      await withTimeout(nextClient.Page.enable(), ENABLE_TIMEOUT_MS, 'CDP Page.enable');
      await withTimeout(nextClient.DOM.enable(), ENABLE_TIMEOUT_MS, 'CDP DOM.enable');

      targetInfo = target;
      client = nextClient;
      return client;
    } catch (err) {
      lastError = err;
      if (target?.id) failedTargetIds.add(target.id);
      if (nextClient) {
        try { await nextClient.close(); } catch {}
      }
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function fetchJson(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}${path}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${path}`);
    return await resp.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${path} timed out after ${timeoutMs}ms`);
    throw new Error(`${path} failed: ${err.message}. Is TradingView running with --remote-debugging-port=${CDP_PORT}?`);
  } finally {
    clearTimeout(timeout);
  }
}

async function findChartTarget(failedTargetIds = new Set()) {
  const targets = await fetchJson('/json/list');
  const candidates = targets
    .filter(t => t.type === 'page')
    .filter(t => /tradingview\.com\/chart/i.test(t.url) || /tradingview/i.test(t.url));
  // Prefer targets with tradingview.com/chart in the URL
  return candidates.find(t => /tradingview\.com\/chart/i.test(t.url) && !failedTargetIds.has(t.id))
    || candidates.find(t => !failedTargetIds.has(t.id))
    || candidates.find(t => /tradingview\.com\/chart/i.test(t.url))
    || candidates[0]
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const timeoutMs = timeoutFromOptions(opts);
  const protocolOpts = withoutLocalOptions(opts);
  return enqueueEvaluate(async () => {
    const releaseLock = await acquireGlobalEvaluateLock();
    try {
      const c = await getClient();
      const result = await cdpCall(c.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: protocolOpts.awaitPromise ?? false,
        ...protocolOpts,
      }), timeoutMs, 'CDP Runtime.evaluate');
      if (result.exceptionDetails) {
        const msg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Unknown evaluation error';
        throw new Error(`JS evaluation error: ${msg}`);
      }
      return result.result?.value;
    } catch (err) {
      if (shouldResetClient(err)) resetClient();
      throw err;
    } finally {
      await releaseLock();
    }
  });
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true, timeout_ms: EVALUATE_ASYNC_TIMEOUT_MS });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

export function connectionStatus() {
  return {
    connected: !!client,
    target: targetInfo ? {
      id: targetInfo.id,
      title: targetInfo.title,
      url: targetInfo.url,
    } : null,
    cdp: {
      host: CDP_HOST,
      port: CDP_PORT,
      retries: MAX_RETRIES,
    },
    timeouts_ms: {
      fetch: FETCH_TIMEOUT_MS,
      connect: CONNECT_TIMEOUT_MS,
      enable: ENABLE_TIMEOUT_MS,
      liveness: LIVENESS_TIMEOUT_MS,
      evaluate: EVALUATE_TIMEOUT_MS,
      evaluate_async: EVALUATE_ASYNC_TIMEOUT_MS,
      evaluate_cooldown: EVALUATE_COOLDOWN_MS,
      global_evaluate_lock: GLOBAL_LOCK_TIMEOUT_MS,
      global_evaluate_lock_stale: GLOBAL_LOCK_STALE_MS,
      global_evaluate_lock_poll: GLOBAL_LOCK_POLL_MS,
    },
    global_evaluate_lock: {
      enabled: GLOBAL_LOCK_ENABLED,
      path: EVALUATE_LOCK_DIR,
    },
  };
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
