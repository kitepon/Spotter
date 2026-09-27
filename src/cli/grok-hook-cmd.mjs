import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { createEvaluationStore } from '../core/evaluation-store.mjs';
import { appendHookEventSafe } from '../core/hook-event-log.mjs';
import { projectBackendFailure, projectToolIds } from '../hooks/parent-output-projector.mjs';
import { findSpotterMarker, isChildCall, readStdinJson, requireString } from '../hooks/lib.mjs';
import { readLocal, refresh } from '../tool-db/refresh.mjs';
import { version } from '../version.mjs';
import { resolveCodexHookNodePath } from './codex-hook-cmd.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');
const EVENTS = Object.freeze({
  SessionStart: ['session_start', 60],
  UserPromptSubmit: ['user_prompt_submit', 60],
  Stop: ['stop', 60],
  SessionEnd: ['session_end', 60],
});

function defaultGrokHome() { return process.env.GROK_HOME || join(homedir(), '.grok'); }
function hooksPath(grokHome) { return join(grokHome, 'hooks', 'spotter.json'); }
function hookCommand(nodePath, event) {
  const quote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(nodePath)} ${quote(SPOTTER_BIN)} grok-hook ${event}`;
}

export async function installGrokHooks({ grokHome = defaultGrokHome(), nodePath = resolveCodexHookNodePath() } = {}) {
  const path = hooksPath(grokHome);
  let current = {};
  try { current = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new TypeError('invalid Grok hook file');
  const next = structuredClone(current);
  next.hooks ??= {};
  for (const [event, [sub, timeout]] of Object.entries(EVENTS)) {
    const other = Array.isArray(next.hooks[event]) ? next.hooks[event].flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !String(hook?.command ?? '').includes('spotter.mjs" grok-hook '));
      return hooks.length ? [{ ...group, hooks }] : [];
    }) : [];
    other.push({ hooks: [{ type: 'command', command: hookCommand(nodePath, sub), timeout }] });
    next.hooks[event] = other;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + '\n');
  return { hooksPath: path };
}

export async function uninstallGrokHooks({ grokHome = defaultGrokHome() } = {}) {
  const path = hooksPath(grokHome);
  let current;
  try { current = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { hooksPath: path, removed: false }; throw error; }
  let removed = false;
  for (const event of Object.keys(EVENTS)) {
    if (!Array.isArray(current?.hooks?.[event])) continue;
    current.hooks[event] = current.hooks[event].flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => {
        const owned = String(hook?.command ?? '').includes('spotter.mjs" grok-hook ');
        if (owned) removed = true;
        return !owned;
      });
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!current.hooks[event].length) delete current.hooks[event];
  }
  if (removed) await writeFile(path, JSON.stringify(current, null, 2) + '\n');
  return { hooksPath: path, removed };
}

export async function grokHookDiagnostics({ grokHome = defaultGrokHome() } = {}) {
  const path = hooksPath(grokHome);
  if (!existsSync(path)) return { hooksPath: path, installed: false };
  const file = JSON.parse(await readFile(path, 'utf8'));
  return { hooksPath: path, installed: Object.keys(EVENTS).every((event) =>
    file?.hooks?.[event]?.some((group) => group?.hooks?.some((hook) =>
      String(hook.command ?? '').includes('spotter.mjs" grok-hook '))) === true) };
}

export function isGrokHomePresent(grokHome = defaultGrokHome()) { return existsSync(grokHome); }

async function record(projectRoot, hook, event, recordFn = appendHookEventSafe) {
  await recordFn({ projectRoot, host: 'grok', event: { hook, ...event } });
}

function validateGrokInput(input, event) {
  return input?.hookEventName === event && typeof input.sessionId === 'string' && input.sessionId.length > 0;
}

export async function runGrokHook({
  event, readInput = readStdinJson, readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend, refreshFn = refresh,
  recordFn = appendHookEventSafe, createEvaluationStoreFn = createEvaluationStore,
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  const projectRoot = findSpotterMarker(input?.cwd);
  if (!projectRoot) return;
  const expected = Object.keys(EVENTS).find((key) => EVENTS[key][0] === event);
  if (!expected || !validateGrokInput(input, event)) return;
  const startedAt = Date.now();
  if (expected === 'SessionStart') {
    try {
      const tools = await refreshFn({ projectRoot, hostAgent: 'grok' });
      await record(projectRoot, expected, { status: 'refreshed', toolCount: tools.size, durationMs: Date.now() - startedAt }, recordFn);
    } catch {
      writeError('Spotter のGrokカタログ更新に失敗しました。\n');
      await record(projectRoot, expected, { status: 'degraded', code: 'E_CATALOG_REFRESH', durationMs: Date.now() - startedAt }, recordFn);
    }
    return;
  }
  if (expected === 'SessionEnd') {
    try {
      const open = await findOpenGrokEvaluation({ createEvaluationStoreFn, projectRoot, sessionId: input.sessionId });
      if (!open) return;
    } catch {
      writeError('Spotter のGrok評価記録を確認できませんでした。\n');
      await record(projectRoot, expected, { status: 'degraded', code: 'E_EVALUATION_STORE', durationMs: Date.now() - startedAt }, recordFn);
      return;
    }
  }
  if (expected === 'Stop' && (input.stopHookActive === true || typeof input.lastAssistantMessage !== 'string')) return;
  const prompt = expected === 'UserPromptSubmit' ? requireString(input, 'prompt') : null;
  let usedTools = [];
  if (expected === 'Stop' || expected === 'SessionEnd') {
    try {
      const turn = await readGrokCurrentTurn(input.transcriptPath);
      usedTools = turn.usedTools;
      if (expected === 'SessionEnd') input.lastAssistantMessage = turn.finalResponse;
    }
    catch {
      writeError('Spotter のGrok応答記録を読めませんでした。\n');
      await record(projectRoot, expected, { status: 'error', code: 'E_TRANSCRIPT', durationMs: Date.now() - startedAt }, recordFn);
      return;
    }
    if (typeof input.lastAssistantMessage !== 'string' || !input.lastAssistantMessage) return;
  }
  let backend;
  let judgment;
  try {
    const catalog = await readLocalFn({ projectRoot, hostAgent: 'grok' });
    backend = createAuditorBackendFn({ backend: 'auto', catalog, projectRoot, hostAgent: 'grok', timeoutMs: 45_000 });
    judgment = await backend.judge(expected === 'UserPromptSubmit'
      ? { stage: 'user_input', userInput: prompt }
      : { stage: 'turn_end', finalResponse: input.lastAssistantMessage, usedTools });
  } catch (error) {
    const failure = projectBackendFailure(error?.code);
    writeError(failure.stderr);
    await record(projectRoot, expected, {
      status: 'degraded', code: failure.code, durationMs: Date.now() - startedAt,
    }, recordFn);
    if (prompt !== null) await recordGrokEvaluation({ createEvaluationStoreFn, projectRoot, input, prompt, status: 'error', writeError });
    return;
  }
  const toolIds = projectToolIds(judgment.findings.map((finding) => finding.toolName));
  await record(projectRoot, expected === 'SessionEnd' ? 'Stop' : expected, {
    status: toolIds.length ? 'finding' : 'success', pass: judgment.pass,
    missingTools: toolIds, backend: judgment.meta?.backend ?? backend.name,
    usedToolCount: usedTools.length, ...(expected === 'SessionEnd' ? { reason: 'session_end_fallback' } : {}),
    durationMs: Date.now() - startedAt,
  }, recordFn);
  if (prompt !== null) {
    await recordGrokEvaluation({ createEvaluationStoreFn, projectRoot, input, prompt,
      status: 'success', toolIds, backend: judgment.meta?.backend ?? backend.name,
      model: judgment.meta?.model ?? null, writeError });
  } else {
    await closeGrokEvaluation({ createEvaluationStoreFn, projectRoot, input, usedTools, writeError });
  }
}

async function findOpenGrokEvaluation({ createEvaluationStoreFn, projectRoot, sessionId }) {
  const store = createEvaluationStoreFn();
  try {
    return store.database.prepare(`SELECT observation_id FROM evaluation_turns WHERE session_id = ? AND host = 'grok' AND project_path = ? AND completed_at_ms IS NULL ORDER BY recorded_at_ms DESC LIMIT 1`).get(sessionId, projectRoot);
  } finally { store.close(); }
}

async function recordGrokEvaluation({ createEvaluationStoreFn, projectRoot, input, prompt, status, toolIds = [], backend = null, model = null, writeError }) {
  try {
    const store = createEvaluationStoreFn();
    try {
      store.recordTurn({ observationId: randomUUID(), projectPath: projectRoot, host: 'grok',
        sessionId: input.sessionId, auditStatus: status, requestText: prompt,
        observerContextStatus: 'not_requested', proposedToolIds: toolIds, backend, model, spotterVersion: version });
    } finally { store.close(); }
  } catch { writeError('Spotter の評価記録に失敗しました。\n'); }
}

async function closeGrokEvaluation({ createEvaluationStoreFn, projectRoot, input, usedTools, writeError }) {
  try {
    const store = createEvaluationStoreFn();
    try {
      const row = store.database.prepare(`SELECT observation_id FROM evaluation_turns WHERE session_id = ? AND host = 'grok' AND project_path = ? AND completed_at_ms IS NULL ORDER BY recorded_at_ms DESC LIMIT 1`).get(input.sessionId, projectRoot);
      if (row) store.closeTurn({ observationId: row.observation_id, usedToolIds: usedTools, usageStatus: 'complete' });
    } finally { store.close(); }
  } catch { writeError('Spotter の評価記録に失敗しました。\n'); }
}

export async function readGrokCurrentTurn(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) throw new TypeError('Grok transcript path is required');
  const text = await readFile(transcriptPath, 'utf8');
  let tools = [];
  let finalResponse = '';
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    let row;
    row = JSON.parse(line);
    const update = row?.params?.update;
    if (update?.sessionUpdate === 'user_message_chunk') { tools = []; finalResponse = ''; }
    if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
      finalResponse += update.content.text;
    }
    if (update?.sessionUpdate !== 'tool_call') continue;
    const name = update?._meta?.['x.ai/tool']?.name ?? update?.title;
    if (typeof name === 'string' && name) tools.push(name);
  }
  return { usedTools: [...new Set(tools)], finalResponse };
}

export async function readGrokCurrentTurnTools(transcriptPath) {
  return (await readGrokCurrentTurn(transcriptPath)).usedTools;
}

export async function runGrokHookCommand({ argv = process.argv.slice(2) } = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'install') { process.stdout.write(JSON.stringify(await installGrokHooks({ grokHome: rest[0] })) + '\n'); return; }
  if (sub === 'uninstall') { process.stdout.write(JSON.stringify(await uninstallGrokHooks({ grokHome: rest[0] })) + '\n'); return; }
  if (sub === 'diagnostics') { process.stdout.write(JSON.stringify(await grokHookDiagnostics({ grokHome: rest[0] })) + '\n'); return; }
  if (Object.values(EVENTS).some(([name]) => name === sub)) { await runGrokHook({ event: sub }); return; }
  process.stderr.write('usage: spotter grok-hook install|uninstall|diagnostics|session_start|user_prompt_submit|stop|session_end\n');
  process.exit(2);
}
