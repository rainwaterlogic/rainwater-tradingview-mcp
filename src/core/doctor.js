/**
 * Local install/runtime diagnostics for the TradingView MCP.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const EXPECTED_TOOL_COUNT = 83;
const SERVER_PATH = fileURLToPath(new URL('../server.js', import.meta.url));
const REPO_ROOT = resolve(dirname(SERVER_PATH), '..');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJson(path) {
  const text = readText(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return { __parseError: err.message };
  }
}

function lineFor(text, needle) {
  if (!text || !needle) return null;
  const before = text.slice(0, text.indexOf(needle));
  if (before.length === text.length) return null;
  return before.split('\n').length;
}

function check(status, message, extra = {}) {
  return { status, message, ...extra };
}

function rank(status) {
  return status === 'fail' ? 2 : status === 'warn' ? 1 : 0;
}

function summarize(checks) {
  let worst = 'ok';
  for (const value of Object.values(checks)) {
    if (value && rank(value.status) > rank(worst)) worst = value.status;
  }
  return worst;
}

function packageInfo() {
  const pkg = readJson(PACKAGE_PATH);
  return {
    name: pkg?.name || null,
    version: pkg?.version || null,
    path: PACKAGE_PATH,
  };
}

function nodeInfo() {
  try {
    const path = execSync('command -v node', { encoding: 'utf8' }).trim();
    const version = execSync('node --version', { encoding: 'utf8' }).trim();
    return check('ok', 'node is available', { path, version });
  } catch (err) {
    return check('fail', 'node is not available on PATH', { error: err.message });
  }
}

function cliInfo() {
  let path = null;
  let path_realpath = null;
  try {
    path = execSync('command -v tv', { encoding: 'utf8' }).trim();
    path_realpath = safeRealpath(path);
  } catch {}

  if (!path) {
    return check('warn', '`tv` CLI is not linked on PATH', {
      linked: false,
      expected_command: 'npm link',
      recommendations: ['Run `npm link` from this repo if you want `tv` available globally.'],
    });
  }

  const localCli = join(REPO_ROOT, 'src/cli/index.js');
  const localRealpath = safeRealpath(localCli);
  const matches = path_realpath === localRealpath;
  return check(matches ? 'ok' : 'warn', matches ? '`tv` CLI points at this fork' : '`tv` CLI is on PATH but does not point at this fork', {
    linked: true,
    path,
    path_realpath,
    expected_realpath: localRealpath,
  });
}

function serverInfo(serverPath) {
  if (!existsSync(serverPath)) {
    return check('fail', 'MCP server file is missing', { path: serverPath });
  }
  return check('ok', 'MCP server file exists', {
    path: serverPath,
    realpath: safeRealpath(serverPath),
  });
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function parseCodexConfig(path, serverPath) {
  const text = readText(path);
  if (!text) {
    return check('warn', 'Codex config not found', { path });
  }

  const blockMatch = text.match(/\[mcp_servers\.tradingview\]([\s\S]*?)(?=\n\[|$)/);
  if (!blockMatch) {
    return check('warn', 'Codex config exists but has no [mcp_servers.tradingview] entry', { path });
  }

  const block = blockMatch[1];
  const hasNode = /command\s*=\s*["']node["']/.test(block);
  const hasServerPath = block.includes(serverPath);
  const status = hasNode && hasServerPath ? 'ok' : 'warn';
  const problems = [];
  if (!hasNode) problems.push('command is not node');
  if (!hasServerPath) problems.push('args do not point at this server.js');

  return check(status, status === 'ok' ? 'Codex tradingview MCP config points at this fork' : problems.join('; '), {
    path,
    line: lineFor(text, '[mcp_servers.tradingview]'),
    command_node: hasNode,
    server_path_match: hasServerPath,
  });
}

function findClaudeMcpServers(value, serverPath, scope = '$', matches = []) {
  if (!value || typeof value !== 'object') return matches;

  if (value.mcpServers && typeof value.mcpServers === 'object') {
    for (const [name, config] of Object.entries(value.mcpServers)) {
      const serialized = JSON.stringify(config);
      if (name === 'tradingview' || serialized.includes(serverPath) || /tradingview-mcp/.test(serialized)) {
        matches.push({
          scope,
          name,
          command: config?.command || null,
          args: Array.isArray(config?.args) ? config.args : null,
          server_path_match: serialized.includes(serverPath),
        });
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      findClaudeMcpServers(child, serverPath, `${scope}.${key}`, matches);
    }
  }

  return matches;
}

function parseClaudeJson(path, label, serverPath) {
  const json = readJson(path);
  if (!json) {
    return check('warn', `${label} config not found`, { path, matches: [] });
  }
  if (json.__parseError) {
    return check('warn', `${label} config is not valid JSON`, { path, error: json.__parseError, matches: [] });
  }

  const matches = findClaudeMcpServers(json, serverPath);
  if (matches.length === 0) {
    return check('warn', `${label} config has no TradingView MCP entry for this fork`, { path, matches });
  }

  const exact = matches.filter(match => match.server_path_match);
  return check(exact.length > 0 ? 'ok' : 'warn', exact.length > 0 ? `${label} config points at this fork` : `${label} config has TradingView MCP entries but not this fork path`, {
    path,
    matches,
  });
}

function processInfo(serverPath) {
  if (process.platform === 'win32') {
    return check('warn', 'process scan is not implemented on Windows yet', { processes: [] });
  }

  let rows = [];
  try {
    const out = execSync('ps -axo pid=,ppid=,rss=,command=', { encoding: 'utf8', timeout: 3000 });
    rows = out.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rss_mb: Math.round(Number(match[3]) / 1024),
          command: match[4],
        };
      })
      .filter(Boolean);
  } catch (err) {
    return check('warn', 'could not scan running processes', { error: err.message, processes: [] });
  }

  const related = rows.filter(proc =>
    proc.command.includes(serverPath)
    || /tradingview-mcp[^/\s]*\/src\/server\.js/.test(proc.command)
    || proc.command.includes('tradingview-mcp-jackson/src/server.js')
    || proc.command.includes('rainwater-tradingview-mcp/src/server.js')
  );

  const exact = related.filter(proc => proc.command.includes(serverPath));
  const stale = related.filter(proc => !proc.command.includes(serverPath));
  let status = 'ok';
  let message = `${exact.length} MCP server process(es) running for this fork`;
  const recommendations = [];

  if (related.length === 0) {
    status = 'warn';
    message = 'no TradingView MCP server process is currently running';
    recommendations.push('Start or restart the MCP client after installing this fork.');
  } else if (related.length > 3) {
    status = 'warn';
    message = `${related.length} TradingView MCP server processes are running`;
    recommendations.push('Restart Codex/Claude, then kill stale node processes if the count stays high.');
  }

  if (stale.length > 0) {
    status = 'warn';
    recommendations.push('Remove old TradingView MCP config entries that point at another checkout.');
  }

  return check(status, message, {
    count: related.length,
    exact_count: exact.length,
    stale_count: stale.length,
    processes: related,
    recommendations,
  });
}

function tradingViewAppInfo() {
  const candidates = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${homedir()}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${homedir()}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  }[process.platform] || [];

  const found = candidates.filter(Boolean).filter(path => existsSync(path));
  return check(found.length > 0 ? 'ok' : 'warn', found.length > 0 ? 'TradingView app found' : 'TradingView app not found in known locations', {
    found,
    candidates,
  });
}

function tradingViewProcessInfo() {
  if (process.platform === 'win32') {
    return check('warn', 'TradingView process scan is not implemented on Windows yet', { processes: [] });
  }

  let processes = [];
  try {
    const out = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf8', timeout: 3000 });
    processes = out.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
      })
      .filter(proc => proc && /TradingView/.test(proc.command) && !/tradingview-mcp/.test(proc.command));
  } catch (err) {
    return check('warn', 'could not scan TradingView processes', { error: err.message, processes: [] });
  }

  if (processes.length === 0) {
    return check('warn', 'TradingView is not running', {
      processes,
      recommendations: ['Run `tv launch` to start TradingView with CDP enabled.'],
    });
  }

  const cdp = processes.filter(proc => /--remote-debugging-port=9222/.test(proc.command));
  return check(cdp.length > 0 ? 'ok' : 'warn', cdp.length > 0 ? 'TradingView is running with CDP flag' : 'TradingView is running without the CDP flag', {
    count: processes.length,
    cdp_flag_count: cdp.length,
    processes,
    recommendations: cdp.length > 0 ? [] : ['Quit TradingView and run `tv launch` so it starts with --remote-debugging-port=9222.'],
  });
}

async function cdpInfo(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!resp.ok) return check('warn', `CDP port ${port} responded with HTTP ${resp.status}`, { port, listening: false, status_code: resp.status });
    const body = await resp.json();
    let targets = [];
    try {
      const listResp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
      targets = listResp.ok ? await listResp.json() : [];
    } catch {}
    const chartTargets = Array.isArray(targets)
      ? targets.filter(target => /tradingview\.com\/chart/.test(target.url || ''))
      : [];
    const browserText = `${body.Browser || ''} ${body['User-Agent'] || ''}`;
    const looksLikeTradingView = /TradingView|Electron/i.test(browserText) || chartTargets.length > 0;
    const status = looksLikeTradingView ? 'ok' : 'warn';
    const message = looksLikeTradingView
      ? `CDP is listening on port ${port}`
      : `CDP port ${port} is open but does not look like TradingView`;
    return check(status, message, {
      port,
      listening: true,
      browser: body.Browser,
      user_agent: body['User-Agent'],
      target_count: Array.isArray(targets) ? targets.length : null,
      chart_target_count: chartTargets.length,
      chart_targets: chartTargets.map(target => ({
        id: target.id,
        title: target.title,
        url: target.url,
      })).slice(0, 5),
    });
  } catch (err) {
    return check('warn', `CDP is not listening on port ${port}`, {
      port,
      listening: false,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function reloadGuidance() {
  return check('ok', 'client schema reload guidance', {
    expected_tool_count: EXPECTED_TOOL_COUNT,
    stale_schema_symptoms: [
      'client still reports 78 TradingView tools',
      'rainwater_chart_digest is missing',
      'tv_mcp_runtime_status is missing',
      'tool calls fail with Transport closed after an update',
    ],
    action: 'Fully restart Codex/Claude after updating this fork so the MCP schema and stdio transport reload.',
  });
}

function recommendationList(checks) {
  const recs = [];
  for (const value of Object.values(checks)) {
    if (value?.status === 'warn' || value?.status === 'fail') {
      recs.push(value.message);
    }
    for (const item of value?.recommendations || []) recs.push(item);
  }
  recs.push('If your client still shows 78 tools, restart that client; MCP tool schemas are loaded per session.');
  recs.push('Use `tv launch` before chart reads if CDP is not listening.');
  return [...new Set(recs)];
}

export async function doctor({
  port = 9222,
  check_cdp = true,
  codex_config,
  claude_config,
  claude_desktop_config,
  server_path,
} = {}) {
  const serverPath = resolve(expandHome(server_path || process.env.TV_MCP_DOCTOR_SERVER_PATH || SERVER_PATH));
  const codexConfig = resolve(expandHome(codex_config || process.env.TV_MCP_DOCTOR_CODEX_CONFIG || '~/.codex/config.toml'));
  const claudeConfig = resolve(expandHome(claude_config || process.env.TV_MCP_DOCTOR_CLAUDE_CONFIG || '~/.claude.json'));
  const claudeDesktopConfig = resolve(expandHome(
    claude_desktop_config
      || process.env.TV_MCP_DOCTOR_CLAUDE_DESKTOP_CONFIG
      || '~/Library/Application Support/Claude/claude_desktop_config.json',
  ));

  const checks = {
    server: serverInfo(serverPath),
    node: nodeInfo(),
    cli: cliInfo(),
    codex_config: parseCodexConfig(codexConfig, serverPath),
    claude_code_config: parseClaudeJson(claudeConfig, 'Claude Code', serverPath),
    claude_desktop_config: parseClaudeJson(claudeDesktopConfig, 'Claude Desktop', serverPath),
    processes: processInfo(serverPath),
    tradingview_app: tradingViewAppInfo(),
    tradingview_process: tradingViewProcessInfo(),
    cdp: check_cdp ? await cdpInfo(Number(port) || 9222) : check('ok', 'CDP check skipped', { skipped: true }),
    client_reload: reloadGuidance(),
  };

  const status = summarize(checks);
  return {
    success: true,
    healthy: status === 'ok',
    status,
    expected: {
      tool_count: EXPECTED_TOOL_COUNT,
      server_path: serverPath,
      launch_command: `node ${serverPath}`,
    },
    package: packageInfo(),
    checks,
    recommendations: recommendationList(checks),
  };
}
