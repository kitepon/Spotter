// Phase D (hook parity, 2026-05-08): host-neutral hook-event JSONL log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHookEvent,
  appendHookEventSafe,
  failureEventFields,
  hookEventsPath,
  summarizeHookEvents,
  HOOK_EVENT_SCHEMA,
  HOOK_EVENTS_SUMMARY_SCHEMA,
} from '../src/core/hook-event-log.mjs';

test('hookEventsPath: joins .spotter/hook-events.jsonl under projectRoot', () => {
  assert.equal(hookEventsPath('/repo'), join('/repo', '.spotter', 'hook-events.jsonl'));
});

test('hookEventsPath: throws on empty / missing projectRoot', () => {
  assert.throws(() => hookEventsPath(''), /projectRoot/);
  assert.throws(() => hookEventsPath(undefined), /projectRoot/);
});

test('appendHookEvent: writes a JSON line with schema, timestamp, and host', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-write-'));
  try {
    await appendHookEvent({
      projectRoot: project,
      host: 'claude',
      event: { hook: 'Stop', status: 'queued', missingTools: ['mcp__caveat__caveat_search'], durationMs: 12 },
    });
    const raw = await readFile(hookEventsPath(project), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.schema, HOOK_EVENT_SCHEMA);
    assert.equal(event.host, 'claude');
    assert.equal(event.hook, 'Stop');
    assert.equal(event.status, 'queued');
    assert.deepEqual(event.missingTools, ['mcp__caveat__caveat_search']);
    assert.equal(event.durationMs, 12);
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: rejects unknown host values', async () => {
  await assert.rejects(
    () => appendHookEvent({ projectRoot: '/tmp', host: 'whatever', event: {} }),
    /host must be "claude", "codex", or "grok"/
  );
});

test('appendHookEvent: appends to an existing file, preserving previous lines', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-append-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'PreToolUse', status: 'recorded', toolName: 'a' } });
    await appendHookEvent({ projectRoot: project, host: 'codex', event: { hook: 'Stop', status: 'queued' } });
    const raw = await readFile(hookEventsPath(project), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).host, 'claude');
    assert.equal(JSON.parse(lines[1]).host, 'codex');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEventSafe: swallows write errors and reports via writeError', async () => {
  let captured = '';
  await appendHookEventSafe({
    projectRoot: '', // will throw inside appendHookEvent
    host: 'claude',
    event: {},
    writeError: (text) => { captured += text; },
  });
  assert.match(captured, /spotter hook-event log failed/);
});

test('summarizeHookEvents: empty / missing file returns exists=false', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-empty-'));
  try {
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.schema, HOOK_EVENTS_SUMMARY_SCHEMA);
    assert.equal(summary.exists, false);
    assert.equal(summary.events, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: counts byHost / byHook / byStatus / byBackend across hosts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-counts-'));
  try {
    await appendHookEvent({
      projectRoot: project, host: 'claude',
      event: { hook: 'Stop', status: 'queued', backend: 'haiku', durationMs: 10 },
    });
    await appendHookEvent({
      projectRoot: project, host: 'claude',
      event: { hook: 'UserPromptSubmit', status: 'success', backend: 'haiku', durationMs: 20 },
    });
    await appendHookEvent({
      projectRoot: project, host: 'codex',
      event: { hook: 'Stop', status: 'queued', backend: 'codex-cli', durationMs: 30 },
    });
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.exists, true);
    assert.equal(summary.events, 3);
    assert.deepEqual(summary.byHost, { claude: 2, codex: 1 });
    assert.deepEqual(summary.byHook, { Stop: 2, UserPromptSubmit: 1 });
    assert.deepEqual(summary.byStatus, { queued: 2, success: 1 });
    assert.deepEqual(summary.byBackend, { haiku: 2, 'codex-cli': 1 });
    assert.equal(summary.maxDurationMs, 30);
    assert.equal(summary.averageDurationMs, 20); // (10+20+30)/3
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: malformed JSON lines counted as parseErrors', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-bad-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'Stop', status: 'queued' } });
    await appendFile(hookEventsPath(project), 'NOT JSON\n', 'utf8');
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'Stop', status: 'pass' } });
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.events, 2);
    assert.equal(summary.parseErrors, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: recent buffer caps at 5 entries (most recent kept)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-recent-'));
  try {
    for (let i = 0; i < 7; i += 1) {
      await appendHookEvent({
        projectRoot: project, host: 'claude',
        event: { hook: 'PreToolUse', status: 'recorded', toolName: `tool_${i}` },
      });
    }
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.events, 7);
    assert.equal(summary.recent.length, 5);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: creates .spotter/ directory when missing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-mkdir-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'SessionStart', status: 'spawned' } });
    const dotSpotter = join(project, '.spotter');
    const st = await stat(dotSpotter);
    assert.ok(st.isDirectory());
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('failureEventFields: keeps the failing step code, its cause code and exit status', () => {
  const cause = Object.assign(new Error('taskkill exited with code 1'), { code: 'E_PROCESS_TREE_TERMINATION', exitCode: 1 });
  const error = Object.assign(new Error('termination could not be verified'), { code: 'E_CODEX_CLI_TERMINATION', cause });
  assert.deepEqual(failureEventFields(error), {
    internalCode: 'E_CODEX_CLI_TERMINATION', causeCode: 'E_PROCESS_TREE_TERMINATION', causeExitCode: 1,
  });
  assert.deepEqual(failureEventFields(Object.assign(new Error('late'), { code: 'E_CODEX_CLI_TIMEOUT' })), {
    internalCode: 'E_CODEX_CLI_TIMEOUT',
  });
});

test('failureEventFields: takes fixed identifiers only, never free text', () => {
  assert.deepEqual(failureEventFields(new Error('AI_SENTINEL:provider text')), { internalCode: null });
  assert.deepEqual(failureEventFields(undefined), { internalCode: null });
  const cause = Object.assign(new Error('x'), { code: 'not a code: AI_SENTINEL', exitCode: '1' });
  const error = Object.assign(new Error('x'), { code: 'AI_SENTINEL provider text', cause });
  assert.deepEqual(failureEventFields(error), { internalCode: null });
  assert.deepEqual(failureEventFields({ code: `E_${'A'.repeat(80)}` }), { internalCode: null });
});

test('appendHookEvent: replaces the file into .1 once it passes maxBytes, keeping one generation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-rotate-'));
  try {
    const event = { hook: 'Stop', status: 'success' };
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 300 });
    for (let i = 0; i < 6; i += 1) await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 300 });
    const path = hookEventsPath(project);
    assert.ok((await stat(path)).size <= 300 + 200, 'current file stays near the cap');
    assert.ok((await stat(`${path}.1`)).size > 0, 'previous generation kept');
    await assert.rejects(stat(`${path}.2`), { code: 'ENOENT' });
    assert.equal((await summarizeHookEvents({ projectRoot: project })).parseErrors, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: concurrent writers over the cap rotate once and keep every event', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-race-'));
  try {
    const event = { hook: 'Stop', status: 'success' };
    const path = hookEventsPath(project);
    await appendHookEvent({ projectRoot: project, host: 'codex', event });
    const line = await readFile(path, 'utf8');
    const prefill = Math.ceil(4100 / line.length);
    await appendFile(path, line.repeat(prefill - 1), 'utf8');
    await Promise.all(Array.from({ length: 20 }, () => appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 4000 })));
    const count = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).length;
    assert.equal(await count(path), 20, 'every concurrent event landed in the fresh file');
    assert.equal(await count(`${path}.1`), prefill, 'one rotation moved the old events, none replaced');
    await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
    assert.equal((await summarizeHookEvents({ projectRoot: project })).parseErrors, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: one event larger than the cap is still written whole, then rotated by the next', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-big-'));
  try {
    const big = { hook: 'Stop', status: 'x'.repeat(2000) };
    await appendHookEvent({ projectRoot: project, host: 'codex', event: big, maxBytes: 300 });
    const path = hookEventsPath(project);
    assert.ok((await stat(path)).size > 300, 'the cap is not a hard limit');
    await appendHookEvent({ projectRoot: project, host: 'codex', event: { hook: 'Stop', status: 'ok' }, maxBytes: 300 });
    assert.ok((await stat(`${path}.1`)).size > 2000);
    assert.equal((await summarizeHookEvents({ projectRoot: project })).events, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: a failed rotation (rename target is a directory) still appends; a stale lock is cleared', async () => {
  const { mkdir, utimes, writeFile: write } = await import('node:fs/promises');
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-fail-'));
  try {
    const event = { hook: 'Stop', status: 'success' };
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    const path = hookEventsPath(project);
    await mkdir(`${path}.1`);
    await write(join(`${path}.1`, 'keep'), 'x');
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    assert.ok((await stat(path)).size > 100, 'over the cap when rename fails');
    assert.equal((await summarizeHookEvents({ projectRoot: project })).events, 3);
    // A crashed rotator's lock only delays rotation until it is old.
    await write(`${path}.lock`, '');
    const old = new Date(Date.now() - 60000);
    await utimes(`${path}.lock`, old, old);
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: reports the first event time and whether a previous generation exists', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-gen-'));
  try {
    const event = { hook: 'Stop', status: 'success' };
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    let summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.previousGeneration, false);
    assert.match(summary.firstTimestamp, /^\d{4}-\d\d-\d\dT/);
    await appendHookEvent({ projectRoot: project, host: 'codex', event, maxBytes: 100 });
    summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.previousGeneration, true);
    assert.equal(summary.events, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
