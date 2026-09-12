// Codex-native catalog investigation.
//
// This intentionally does not reuse Claude's `claude mcp list` / `~/.claude*`
// discovery path. Codex and Claude expose different MCP servers and skills, so a
// Codex refresh must build a separate snapshot and write it to tool-db.codex.json.

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileWindowsSafe } from '../platform/spawn.mjs';
import { bellVisibleName, listMcpToolsOne } from './investigate-mcp.mjs';
import { readFrontmatter } from './frontmatter.mjs';

// Windows の .cmd shim 解決と windowsHide 強制は src/platform/spawn.mjs が所有する。
async function execCodex(codexBin, args, opts) {
  return execFileWindowsSafe(codexBin, args, opts);
}

export async function buildCodexInvestigationSnapshot({
  logFn = () => {},
  codexBin = 'codex',
  projectRoot,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  const snapshot = new Map();

  const mcp = await listCodexMcpToolsAll({ logFn, codexBin, projectRoot });
  for (const [serverName, tools] of mcp.entries()) {
    for (const tool of tools) {
      if (!tool.description || tool.description.length === 0) continue;
      snapshot.set(bellVisibleName(serverName, tool.name), tool.description);
    }
  }

  const skills = await listCodexSkillsAll({ logFn, projectRoot, codexHome });
  for (const [name, description] of skills) {
    snapshot.set(name, description);
  }

  return snapshot;
}

export async function listCodexMcpToolsAll({ logFn = () => {}, codexBin = 'codex', projectRoot } = {}) {
  const servers = await listCodexMcpServers({ codexBin, projectRoot });
  const out = new Map();
  for (const server of servers) {
    try {
      const tools = await listMcpToolsOne({ server, logFn, projectRoot });
      out.set(server.name, tools);
    } catch (err) {
      logFn(`codex mcp investigate failed for "${server.name}": ${err.message}`);
    }
  }
  return out;
}

export async function listCodexMcpServers({ codexBin = 'codex', projectRoot, execCodexFn = execCodex } = {}) {
  const execOpts = { encoding: 'utf8' };
  if (projectRoot) execOpts.cwd = projectRoot;
  const { stdout } = await execCodexFn(codexBin, ['mcp', 'list'], execOpts);
  const names = parseCodexMcpListOutput(stdout);
  const servers = [];
  for (const name of names) {
    const { stdout: detail } = await execCodexFn(codexBin, ['mcp', 'get', name, '--json'], execOpts);
    const server = parseCodexMcpGetOutput(detail);
    if (server) servers.push(server);
  }
  return servers;
}

export function parseCodexMcpListOutput(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Name ')) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 2) continue;
    const status = fields.includes('disabled') ? 'disabled' : fields.includes('enabled') ? 'enabled' : null;
    if (status !== 'enabled') continue;
    out.push(fields[0]);
  }
  return out;
}

export function parseCodexMcpGetOutput(text) {
  // 表示形式のenvは伏字を含むため、実行設定には構造化JSONだけを使う。
  const invalid = () => Object.assign(new Error('Codex MCP設定のJSON形式が不正です'),
    { code: 'CODEX_MCP_CONFIG_INVALID' });
  let config;
  try { config = JSON.parse(text); } catch { throw invalid(); }
  if (!config || typeof config.name !== 'string' || !config.name) throw invalid();
  if (config.enabled === false) return null;
  const { name, transport } = config;
  if (transport?.type === 'stdio') {
    const { command, args = [], cwd, env = {} } = transport;
    if (typeof command !== 'string' || !command || !Array.isArray(args)
      || !args.every((arg) => typeof arg === 'string')
      || (cwd != null && typeof cwd !== 'string')
      || (env != null && (typeof env !== 'object' || Array.isArray(env)
        || !Object.values(env).every((value) => typeof value === 'string')))) throw invalid();
    return {
      name,
      transport: 'stdio',
      command,
      args,
      cwd: cwd ?? undefined,
      env: env ?? {},
    };
  }
  if (transport?.type === 'streamable_http') {
    if (typeof transport.url !== 'string' || !transport.url) throw invalid();
    return { name, transport: 'http', url: transport.url };
  }
  throw invalid();
}

export async function listCodexSkillsAll({
  logFn = () => {},
  projectRoot,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  const out = new Map();

  for (const [name, description] of await scanCodexSkillsDir(join(codexHome, 'skills', '.system'), logFn)) {
    out.set(name, description);
  }
  for (const plugin of await listEnabledCodexPlugins({ codexHome, logFn })) {
    for (const [name, description] of await scanCodexSkillsDir(join(plugin.installPath, 'skills'), logFn)) {
      out.set(`${plugin.prefix}:${name}`, description);
    }
  }
  for (const [name, description] of await scanCodexSkillsDir(join(codexHome, 'skills'), logFn)) {
    out.set(name, description);
  }
  if (projectRoot) {
    for (const [name, description] of await scanCodexSkillsDir(join(projectRoot, '.codex', 'skills'), logFn)) {
      out.set(name, description);
    }
  }

  return out;
}

async function scanCodexSkillsDir(dir, logFn) {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, 'SKILL.md');
    try {
      const fm = await readFrontmatter(skillFile);
      const name = fm.name ?? entry.name;
      const description = fm.description;
      if (typeof description !== 'string' || description.length === 0) continue;
      out.set(name, description);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logFn(`codex skill read failed at ${skillFile}: ${err.message}`);
      }
    }
  }
  return out;
}

async function listEnabledCodexPlugins({ codexHome, logFn }) {
  const configPath = join(codexHome, 'config.toml');
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return [];
  }
  const enabled = parseEnabledCodexPluginIds(text);
  const out = [];
  for (const id of enabled) {
    const installPath = await codexPluginInstallPath({ codexHome, id });
    if (!installPath) {
      logFn(`codex plugin enabled but cache not found: ${id}`);
      continue;
    }
    out.push({ id, prefix: id.split('@')[0], installPath });
  }
  return out;
}

export function parseEnabledCodexPluginIds(tomlText) {
  const out = [];
  let current = null;
  for (const rawLine of String(tomlText ?? '').split('\n')) {
    const line = rawLine.trim();
    const section = line.match(/^\[plugins\."([^"]+)"\]$/u);
    if (section) {
      current = section[1];
      continue;
    }
    if (!current) continue;
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (/^enabled\s*=\s*true\b/u.test(line)) out.push(current);
  }
  return out;
}

async function codexPluginInstallPath({ codexHome, id }) {
  const [name, marketplace] = id.split('@');
  if (!name || !marketplace) return null;
  const root = join(codexHome, 'plugins', 'cache', marketplace, name);
  let versions;
  try {
    versions = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = versions.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return dirs.length > 0 ? join(root, dirs.at(-1)) : null;
}
