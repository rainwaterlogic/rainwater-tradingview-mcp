import { register } from '../router.js';
import * as core from '../../core/doctor.js';

register('doctor', {
  description: 'Diagnose MCP install, runtime, process, and CDP health',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port to check (default 9222)' },
    'no-cdp': { type: 'boolean', description: 'Skip CDP/TradingView port check' },
    'codex-config': { type: 'string', description: 'Path to Codex config.toml' },
    'claude-config': { type: 'string', description: 'Path to Claude Code .claude.json' },
    'claude-desktop-config': { type: 'string', description: 'Path to Claude Desktop config JSON' },
    'server-path': { type: 'string', description: 'Expected MCP server.js path' },
  },
  handler: (opts) => core.doctor({
    port: opts.port ? Number(opts.port) : undefined,
    check_cdp: !opts['no-cdp'],
    codex_config: opts['codex-config'],
    claude_config: opts['claude-config'],
    claude_desktop_config: opts['claude-desktop-config'],
    server_path: opts['server-path'],
  }),
});
