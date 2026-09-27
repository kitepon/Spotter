// Grok's effective configuration is the authority: it merges native and enabled
// Claude/Cursor compatibility sources. Inspect only the current project's view.
import { execFileWindowsSafe } from '../platform/spawn.mjs';
import { listMcpToolsOne } from './investigate-mcp.mjs';
import { describeServer } from './mcp-config.mjs';

async function execGrok(grokBin, args, projectRoot) {
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  if (projectRoot) options.cwd = projectRoot;
  return (await execFileWindowsSafe(grokBin, args, options)).stdout;
}

export async function buildGrokInvestigationSnapshot({
  logFn = () => {}, projectRoot, grokBin = 'grok', execGrokFn = execGrok,
} = {}) {
  const snapshot = new Map();
  const inspection = JSON.parse(await execGrokFn(grokBin, ['inspect', '--json'], projectRoot));
  for (const item of [...(inspection.skills ?? []), ...(inspection.agents ?? [])]) {
    if (['builtin', 'bundled'].includes(item?.source?.type) || item?.compatibilityStatus === 'disabled') continue;
    const name = item?.invocableAs ?? item?.name;
    if (typeof name === 'string' && name && typeof item.description === 'string' && item.description) {
      snapshot.set(name, item.description);
    }
  }

  const servers = JSON.parse(await execGrokFn(grokBin, ['mcp', 'list', '--json'], projectRoot));
  if (!Array.isArray(servers)) throw new TypeError('Grok MCP list must be an array');
  for (const entry of servers) {
    if (entry?.enabled === false || typeof entry?.name !== 'string') continue;
    const server = describeServer(entry.name, entry);
    if (!server) continue;
    try {
      const tools = await listMcpToolsOne({ server, logFn, projectRoot });
      for (const tool of tools) {
        if (typeof tool.description === 'string' && tool.description) {
          snapshot.set(grokVisibleMcpName(entry.name, tool.name), tool.description);
        }
      }
    } catch (error) {
      logFn(`grok mcp investigate failed for "${entry.name}": ${error.message}`);
    }
  }
  return snapshot;
}

export function grokVisibleMcpName(serverName, toolName) {
  return `${serverName.replace(/[^A-Za-z0-9_-]/gu, '_')}__${toolName}`;
}
