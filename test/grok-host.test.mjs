import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildGrokInvestigationSnapshot, grokVisibleMcpName } from '../src/tool-db/investigate-grok.mjs';
import { installGrokHooks, uninstallGrokHooks, grokHookDiagnostics, runGrokHook, readGrokCurrentTurnTools } from '../src/cli/grok-hook-cmd.mjs';
import { isUnsupportedNonClaudeEnvelope } from '../src/hooks/lib.mjs';

test('Grok catalog uses effective skills and ignores bundled host capabilities', async () => {
  const calls = [];
  const snapshot = await buildGrokInvestigationSnapshot({
    projectRoot: '/example',
    execGrokFn: async (_bin, args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'inspect') return JSON.stringify({
        skills: [
          { name: 'my-skill', description: 'Useful skill', source: { type: 'user' } },
          { name: 'bundled', description: 'Standard', source: { type: 'bundled' } },
        ],
        agents: [{ name: 'helper', description: 'Delegate', source: { type: 'project' } }],
      });
      return '[]';
    },
  });
  assert.deepEqual([...snapshot], [['my-skill', 'Useful skill'], ['helper', 'Delegate']]);
  assert.deepEqual(calls.map((entry) => entry.cwd), ['/example', '/example']);
});

test('Grok catalog MCP IDs follow the native server__tool namespace', () => {
  assert.equal(grokVisibleMcpName('demo-server', 'search'), 'demo-server__search');
});

test('Grok hooks install and uninstall only Spotter entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-grok-hooks-'));
  const grokHome = join(root, '.grok');
  const path = join(grokHome, 'hooks', 'spotter.json');
  await mkdir(join(grokHome, 'hooks'), { recursive: true });
  await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other product' }] }] } }));
  await installGrokHooks({ grokHome });
  await installGrokHooks({ grokHome });
  assert.equal((await grokHookDiagnostics({ grokHome })).installed, true);
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(file.hooks.Stop.length, 2);
  assert.equal(file.hooks.Stop[0].hooks[0].command, 'other product');
  await uninstallGrokHooks({ grokHome });
  assert.equal((await grokHookDiagnostics({ grokHome })).installed, false);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hooks.Stop[0].hooks[0].command, 'other product');
});

test('Grok compatibility aliases do not route into Claude hooks', () => {
  assert.equal(isUnsupportedNonClaudeEnvelope({ sessionId: 's', session_id: 's', hookEventName: 'user_prompt_submit' }), true);
});

test('Grok prompt audits host-local catalog and records findings without stdout', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-grok-prompt-'));
  await mkdir(join(projectRoot, '.spotter'));
  await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}');
  let catalogHost;
  const events = [];
  const evaluations = [];
  await runGrokHook({
    event: 'user_prompt_submit',
    readInput: async () => ({ hookEventName: 'user_prompt_submit', sessionId: 's', cwd: projectRoot, prompt: 'Use the tool' }),
    readLocalFn: async ({ hostAgent }) => { catalogHost = hostAgent; return [{ name: 'mcp__demo__search', description: 'Search' }]; },
    createAuditorBackendFn: () => ({ name: 'mock', judge: async () => ({ pass: false,
      findings: [{ toolName: 'mcp__demo__search' }], meta: { backend: 'mock' } }) }),
    recordFn: async ({ host, event }) => events.push({ host, event }),
    createEvaluationStoreFn: () => ({ recordTurn: (row) => evaluations.push(row), close() {} }),
  });
  assert.equal(catalogHost, 'grok');
  assert.equal(events[0].host, 'grok');
  assert.deepEqual(events[0].event.missingTools, ['mcp__demo__search']);
  assert.deepEqual(evaluations[0].proposedToolIds, ['mcp__demo__search']);
});

test('Grok SessionStart completes host-local refresh before returning', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-grok-start-'));
  await mkdir(join(projectRoot, '.spotter'));
  await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}');
  const events = [];
  await runGrokHook({
    event: 'session_start',
    readInput: async () => ({ hookEventName: 'session_start', sessionId: 's', cwd: projectRoot }),
    refreshFn: async ({ hostAgent }) => { assert.equal(hostAgent, 'grok'); return new Map([['a', 'b']]); },
    recordFn: async ({ event }) => events.push(event),
  });
  assert.equal(events[0].status, 'refreshed');
  assert.equal(events[0].toolCount, 1);
});

test('Grok transcript reader keeps only current turn tool calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-grok-transcript-'));
  const path = join(dir, 'updates.jsonl');
  const rows = [
    { params: { update: { sessionUpdate: 'tool_call', title: 'old' } } },
    { params: { update: { sessionUpdate: 'user_message_chunk' } } },
    { params: { update: { sessionUpdate: 'tool_call', title: 'read_file' } } },
    { params: { update: { sessionUpdate: 'tool_call', title: 'read_file' } } },
    { params: { update: { sessionUpdate: 'tool_call', title: 'mcp__demo__search' } } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(await readGrokCurrentTurnTools(path), ['read_file', 'mcp__demo__search']);
});

test('Grok SessionEnd audits a turn left open when headless Stop omits final text', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-grok-end-'));
  await mkdir(join(projectRoot, '.spotter'));
  await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}');
  const transcriptPath = join(projectRoot, 'updates.jsonl');
  await writeFile(transcriptPath, [
    { params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Question' } } } },
    { params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Answer' } } } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const events = [];
  const closed = [];
  const createEvaluationStoreFn = () => ({
    database: { prepare: () => ({ get: () => ({ observation_id: 'obs' }) }) },
    closeTurn: (row) => closed.push(row),
    close() {},
  });
  await runGrokHook({
    event: 'session_end',
    readInput: async () => ({ hookEventName: 'session_end', sessionId: 's', cwd: projectRoot, transcriptPath }),
    readLocalFn: async () => [],
    createAuditorBackendFn: () => ({ name: 'mock', judge: async (input) => {
      assert.equal(input.finalResponse, 'Answer');
      return { pass: true, findings: [], meta: { backend: 'mock' } };
    } }),
    createEvaluationStoreFn,
    recordFn: async ({ event }) => events.push(event),
  });
  assert.equal(events[0].hook, 'Stop');
  assert.equal(events[0].reason, 'session_end_fallback');
  assert.equal(closed[0].observationId, 'obs');
});

test('Grok SessionEnd reports evaluation-store failure without failing the hook', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-grok-end-store-'));
  await mkdir(join(projectRoot, '.spotter'));
  await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}');
  const events = [];
  const warnings = [];
  await runGrokHook({
    event: 'session_end',
    readInput: async () => ({ hookEventName: 'session_end', sessionId: 's', cwd: projectRoot }),
    createEvaluationStoreFn: () => { throw new Error('private database failure'); },
    recordFn: async ({ event }) => events.push(event),
    writeError: (warning) => warnings.push(warning),
  });
  assert.equal(events[0].code, 'E_EVALUATION_STORE');
  assert.equal(events[0].status, 'degraded');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private database failure/);
});

test('Grok Stop reports transcript failure without exposing its path', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-grok-stop-transcript-'));
  await mkdir(join(projectRoot, '.spotter'));
  await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}');
  const events = [];
  const warnings = [];
  await runGrokHook({
    event: 'stop',
    readInput: async () => ({ hookEventName: 'stop', sessionId: 's', cwd: projectRoot,
      lastAssistantMessage: 'Answer', transcriptPath: '/private/missing-transcript.jsonl' }),
    recordFn: async ({ event }) => events.push(event),
    writeError: (warning) => warnings.push(warning),
  });
  assert.equal(events[0].code, 'E_TRANSCRIPT');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private\/missing-transcript/);
});
