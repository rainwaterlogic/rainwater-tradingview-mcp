import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthTools } from "./tools/health.js";
import { registerChartTools } from "./tools/chart.js";
import { registerPineTools } from "./tools/pine.js";
import { registerDataTools } from "./tools/data.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerReplayTools } from "./tools/replay.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerWatchlistTools } from "./tools/watchlist.js";
import { registerUiTools } from "./tools/ui.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerTabTools } from "./tools/tab.js";
import { registerMorningTools } from "./tools/morning.js";
import { registerRainwaterTools } from "./tools/rainwater.js";
import { disconnect } from "./connection.js";

const TOOL_COUNT = 83;

const server = new McpServer(
  {
    name: "tradingview",
    version: "2.0.0",
    description:
      "AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol",
  },
  {
    instructions: `TradingView MCP — ${TOOL_COUNT} tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- rainwater_chart_digest → Rainwater compact context: one fast call for chart state, quote, OHLC summary, studies, Pine drawings, and token/speed estimates
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- Prefer rainwater_chart_digest for first-pass analysis; it replaces 4-7 separate chart-reading calls
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  },
);

let lastToolActivity = Date.now();
let shuttingDown = false;
let transport = null;
const idleExitMs = Number.parseInt(process.env.TV_MCP_IDLE_EXIT_MS || "", 10);
const parentWatchMs = Number.parseInt(process.env.TV_MCP_PARENT_WATCH_MS || "30000", 10);

function installToolActivityTracking(mcpServer) {
  const originalTool = mcpServer.tool.bind(mcpServer);
  mcpServer.tool = (...args) => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = async (...handlerArgs) => {
        lastToolActivity = Date.now();
        return last(...handlerArgs);
      };
    }
    return originalTool(...args);
  };
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`tradingview-mcp shutdown: ${reason}\n`);
  try { await disconnect(); } catch {}
  try { await transport?.close(); } catch {}
  process.exit(exitCode);
}

installToolActivityTracking(server);

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerMorningTools(server);
registerRainwaterTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write(
  "⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n",
);
process.stderr.write(
  "   Ensure your usage complies with TradingView's Terms of Use.\n\n",
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

process.stdin.once("end", () => {
  void shutdown("stdin end");
});
process.stdin.once("close", () => {
  void shutdown("stdin close");
});

if (parentWatchMs > 0) {
  const parentWatch = setInterval(() => {
    if (process.ppid === 1) void shutdown("parent process exited");
  }, parentWatchMs);
  parentWatch.unref();
}

if (Number.isFinite(idleExitMs) && idleExitMs > 0) {
  const idleWatch = setInterval(() => {
    if (Date.now() - lastToolActivity >= idleExitMs) void shutdown(`idle ${idleExitMs}ms`);
  }, Math.min(idleExitMs, 60000));
  idleWatch.unref();
}

// Start stdio transport
transport = new StdioServerTransport();
await server.connect(transport);
