import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUDITOR_AVAILABILITY_SCHEMA,
  AUDITOR_UNRECOVERED_AFTER_MS,
  RUNTIME_ERROR_DEFINITIONS,
  auditorAvailabilityPath,
  observeAuditorAvailability,
  observeAuditorAvailabilityIsolatedSafe,
  observeRuntimeError,
  readRuntimeErrorSnapshot,
  runtimeErrorFingerprint,
} from '../src/core/runtime-error-store.mjs';
import {
  auditorFailureLane, reportAuditorFailure, reportAuditorSuccess,
} from '../src/core/auditor-outcome.mjs';

const TEST_PLATFORM = process.platform === 'win32' ? 'win32' : 'darwin';
const TEST_PROFILE = TEST_PLATFORM === 'win32' ? 'windows-native' : 'mac';
const START = Date.parse('2026-10-07T00:00:00.000Z');
const UNRECOVERED_FINGERPRINT = runtimeErrorFingerprint(RUNTIME_ERROR_DEFINITIONS.auditor_unrecovered);

async function sandbox(t, { collection = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spotter-auditor-availability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory-reporter.json');
  await writeFile(configPath, JSON.stringify({
    schema_version: '1.0',
    host: { id: 'test-host', profile: TEST_PROFILE },
    collection: { enabled: collection },
    reporting: { enabled: false },
  }));
  if (process.platform !== 'win32') await chmod(configPath, 0o600);
  return { root, configPath, storePath: join(root, 'spotter', 'runtime-errors-v1.json') };
}

const at = (box, minutes, extra = {}) => ({
  configPath: box.configPath,
  storePath: box.storePath,
  now: () => new Date(START + minutes * 60_000),
  productVersion: '1.9.3',
  platform: TEST_PLATFORM,
  arch: 'arm64',
  ...extra,
});

const fail = (box, minutes, backend = 'codex-cli') => (
  observeAuditorAvailability({ outcome: 'failure', backend }, at(box, minutes))
);
const succeed = (box, minutes, backend = 'codex-cli') => (
  observeAuditorAvailability({ outcome: 'success', backend }, at(box, minutes))
);
const records = async (box) => (await readRuntimeErrorSnapshot(at(box, 0))).records;
const stateExists = (box) => stat(auditorAvailabilityPath(box.storePath)).then(() => true, () => false);

test('recovery window is 30 minutes and the outage kind states what was observed', () => {
  assert.equal(AUDITOR_UNRECOVERED_AFTER_MS, 30 * 60 * 1_000);
  assert.deepEqual(RUNTIME_ERROR_DEFINITIONS.auditor_unrecovered, {
    component: 'auditor',
    errorCode: 'SPOTTER.AUDITOR.UNRECOVERED',
    messageTemplate: 'Spotter auditor backend access kept failing for over 30 minutes with no successful audit; cause not determined',
    severity: 'warn',
  });
});

test('auditorFailureLane: backend access failures wait for recovery, everything else registers at once', () => {
  for (const code of [
    'E_JEV_NETWORK', 'E_JEV_TIMEOUT', 'E_JEV_AUTH', 'E_JEV_USAGE_LIMIT',
    'E_CODEX_CLI_TIMEOUT', 'E_CODEX_CLI_AUTH', 'E_CODEX_CLI_USAGE_LIMIT', 'E_HAIKU_TIMEOUT',
  ]) {
    assert.equal(auditorFailureLane({ code }), 'on_unrecovered', code);
  }
  assert.equal(auditorFailureLane({ code: 'E_JEV_HTTP', diagnostics: { status: 503 } }), 'on_unrecovered');
  // A request the provider rejects is not an access failure: 1.8.0 sent an oversized
  // request and got HTTP 400 on every audit.
  assert.equal(auditorFailureLane({ code: 'E_JEV_HTTP', diagnostics: { status: 400 } }), 'immediate');
  assert.equal(auditorFailureLane({ code: 'E_JEV_HTTP' }), 'immediate');
  for (const code of [
    'E_JEV_SCHEMA', 'E_JEV_CONFIG', 'E_JEV_INPUT_TOO_LARGE', 'E_CODEX_CLI_EXIT', 'E_CODEX_CLI_SPAWN',
    'E_CODEX_CLI_SCHEMA', 'E_CODEX_CLI_NO_FINAL_JSON', 'E_CODEX_CLI_MODEL_UNAVAILABLE',
    'E_HAIKU_SCHEMA', 'E_INTERNAL', 'E_BACKEND_UNKNOWN',
  ]) {
    assert.equal(auditorFailureLane({ code }), 'immediate', code);
  }
  assert.equal(auditorFailureLane(new Error('no code')), 'immediate');
  assert.equal(auditorFailureLane(null), 'immediate');
});

test('one handled failure is kept as a streak and registers nothing', async (t) => {
  const box = await sandbox(t);

  assert.deepEqual(await fail(box, 0), { collected: true, streak: 'open', registered: false });

  assert.deepEqual(await records(box), []);
  const state = JSON.parse(await readFile(auditorAvailabilityPath(box.storePath), 'utf8'));
  assert.deepEqual(state, {
    schema: AUDITOR_AVAILABILITY_SCHEMA,
    streaks: {
      'codex-cli': {
        first_failed_at: '2026-10-07T00:00:00.000Z',
        last_failed_at: '2026-10-07T00:00:00.000Z',
        registered: false,
      },
    },
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(auditorAvailabilityPath(box.storePath))).mode & 0o777, 0o600);
  }
});

test('a successful audit ends the streak and removes the state file', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0);
  await fail(box, 1);

  assert.deepEqual(await succeed(box, 2), { collected: true, streak: 'cleared' });

  assert.equal(await stateExists(box), false);
  assert.deepEqual(await records(box), []);
  assert.deepEqual(await succeed(box, 3), { collected: true, streak: 'none' });
});

test('failures that recover inside the window never register, however many there are', async (t) => {
  const box = await sandbox(t);
  for (let minute = 0; minute < 30; minute += 1) await fail(box, minute);

  assert.deepEqual(await records(box), []);

  await succeed(box, 30);
  // The next failure starts a new streak; the earlier one does not count toward it.
  await fail(box, 31);
  await fail(box, 60);
  assert.deepEqual(await records(box), []);
});

test('a streak that outlives the window is registered once as an open warn record', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0);
  assert.deepEqual(await fail(box, 29), { collected: true, streak: 'open', registered: false });

  assert.deepEqual(await fail(box, 30), { collected: true, streak: 'registered', registered: true });

  const [record, ...rest] = await records(box);
  assert.deepEqual(rest, []);
  assert.equal(record.error_code, 'SPOTTER.AUDITOR.UNRECOVERED');
  assert.equal(record.fingerprint, UNRECOVERED_FINGERPRINT);
  assert.equal(record.severity, 'warn');
  assert.equal(record.status, 'open');
  assert.equal(record.occurrence_count, 1);
  assert.equal(record.first_seen, '2026-10-07T00:30:00.000Z');
  assert.equal(record.last_seen, '2026-10-07T00:30:00.000Z');

  // The count is outages, not failed audits.
  assert.deepEqual(await fail(box, 45), { collected: true, streak: 'registered', registered: false });
  await fail(box, 600);
  assert.equal((await records(box))[0].occurrence_count, 1);
  assert.equal((await records(box))[0].last_seen, '2026-10-07T00:30:00.000Z');
});

test('a second unrecovered outage after a recovery counts as a second occurrence', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0);
  await fail(box, 30);
  await succeed(box, 40);
  await fail(box, 50);
  assert.equal((await records(box))[0].occurrence_count, 1);

  await fail(box, 80);

  const [record] = await records(box);
  assert.equal(record.occurrence_count, 2);
  assert.equal(record.first_seen, '2026-10-07T00:30:00.000Z');
  assert.equal(record.last_seen, '2026-10-07T01:20:00.000Z');
});

test('streaks are kept per backend', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0, 'codex-cli');
  await fail(box, 5, 'jev');

  assert.deepEqual(await succeed(box, 10, 'jev'), { collected: true, streak: 'cleared' });
  assert.equal(await stateExists(box), true);

  assert.deepEqual(await fail(box, 30, 'codex-cli'), { collected: true, streak: 'registered', registered: true });
  assert.equal((await records(box)).length, 1);
});

test('the same outage is not counted twice when its state write is repeated', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0);
  await fail(box, 30);
  const statePath = auditorAvailabilityPath(box.storePath);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.streaks['codex-cli'].registered = false;
  await writeFile(statePath, JSON.stringify(state));

  assert.deepEqual(await fail(box, 31), { collected: true, streak: 'registered', registered: true });

  assert.equal((await records(box))[0].occurrence_count, 1);
});

test('a clock that moved backwards restarts the streak', async (t) => {
  const box = await sandbox(t);
  await fail(box, 60);

  await fail(box, 0);
  await fail(box, 29);

  assert.deepEqual(await records(box), []);
  const state = JSON.parse(await readFile(auditorAvailabilityPath(box.storePath), 'utf8'));
  assert.equal(state.streaks['codex-cli'].first_failed_at, '2026-10-07T00:00:00.000Z');
});

test('the immediate lane and the outage lane keep separate records', async (t) => {
  const box = await sandbox(t);
  await observeRuntimeError('auditor_unavailable', at(box, 0));
  await fail(box, 0);
  await fail(box, 30);

  const found = await records(box);
  assert.deepEqual(found.map((record) => record.error_code).sort(), [
    'SPOTTER.AUDITOR.UNAVAILABLE', 'SPOTTER.AUDITOR.UNRECOVERED',
  ]);
  assert.notEqual(found[0].fingerprint, found[1].fingerprint);
});

test('nothing is written while collection is disabled', async (t) => {
  const box = await sandbox(t, { collection: false });

  assert.deepEqual(await fail(box, 0), { collected: false, reason: 'disabled' });
  assert.deepEqual(await fail(box, 30), { collected: false, reason: 'disabled' });

  assert.equal(await stateExists(box), false);
});

test('unknown outcomes and backends are rejected', async (t) => {
  const box = await sandbox(t);
  for (const input of [
    { outcome: 'failure', backend: 'other' },
    { outcome: 'maybe', backend: 'jev' },
    { outcome: 'failure' },
    { outcome: 'failure', backend: 'jev', code: 'E_JEV_NETWORK' },
    'failure',
  ]) {
    await assert.rejects(observeAuditorAvailability(input, at(box, 0)), { code: 'E_RUNTIME_ERROR_INPUT' });
  }
  assert.equal(await stateExists(box), false);
});

test('a malformed state file fails loudly instead of being reset', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0);
  const statePath = auditorAvailabilityPath(box.storePath);
  await writeFile(statePath, JSON.stringify({ schema: AUDITOR_AVAILABILITY_SCHEMA, streaks: { other: {} } }));

  await assert.rejects(fail(box, 30), { code: 'E_RUNTIME_ERROR_STORE' });

  assert.deepEqual(await records(box), []);
});

test('isolated observer: success without a failure streak starts no worker', async (t) => {
  const box = await sandbox(t);
  const errors = [];

  const result = await observeAuditorAvailabilityIsolatedSafe({ outcome: 'success', backend: 'jev' }, at(box, 0, {
    workerPath: join(box.root, 'missing-worker.mjs'),
    writeError: (text) => errors.push(text),
  }));

  assert.deepEqual(result, { collected: false, reason: 'no_failure_streak' });
  assert.deepEqual(errors, []);
});

test('isolated observer: another backend\'s streak starts no worker on success', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0, 'codex-cli');
  const errors = [];

  const result = await observeAuditorAvailabilityIsolatedSafe({ outcome: 'success', backend: 'jev' }, at(box, 1, {
    workerPath: join(box.root, 'missing-worker.mjs'),
    writeError: (text) => errors.push(text),
  }));

  assert.deepEqual(result, { collected: false, reason: 'no_failure_streak' });
  assert.deepEqual(errors, []);
  assert.equal(await stateExists(box), true);
});

test('isolated observer: an unreadable state file is reported without starting a worker', async (t) => {
  const box = await sandbox(t);
  await fail(box, 0, 'codex-cli');
  await writeFile(auditorAvailabilityPath(box.storePath), 'not json');
  const errors = [];

  const result = await observeAuditorAvailabilityIsolatedSafe({ outcome: 'success', backend: 'jev' }, at(box, 1, {
    workerPath: join(box.root, 'missing-worker.mjs'),
    writeError: (text) => errors.push(text),
  }));

  assert.deepEqual(result, { collected: false, reason: 'store_unavailable' });
  assert.deepEqual(errors, ['spotter-runtime-errors: local aggregate store unavailable\n']);
});

test('isolated observer: failure and recovery go through the real worker', async (t) => {
  const box = await sandbox(t);
  const isolated = { timeoutMs: TEST_PLATFORM === 'win32' ? 10_000 : 5_000, now: undefined };

  assert.deepEqual(
    await observeAuditorAvailabilityIsolatedSafe({ outcome: 'failure', backend: 'codex-cli' }, at(box, 0, isolated)),
    { collected: true },
  );
  assert.equal(await stateExists(box), true);
  assert.deepEqual(await records(box), []);

  assert.deepEqual(
    await observeAuditorAvailabilityIsolatedSafe({ outcome: 'success', backend: 'codex-cli' }, at(box, 0, isolated)),
    { collected: true },
  );
  assert.equal(await stateExists(box), false);
});

test('isolated observer: invalid input and a failing worker emit only the fixed diagnostic', async (t) => {
  const box = await sandbox(t);
  const errors = [];
  const writeError = (text) => errors.push(text);

  assert.deepEqual(
    await observeAuditorAvailabilityIsolatedSafe({ outcome: 'failure', backend: 'other' }, at(box, 0, { writeError })),
    { collected: false, reason: 'store_unavailable' },
  );
  assert.deepEqual(
    await observeAuditorAvailabilityIsolatedSafe({ outcome: 'failure', backend: 'jev' }, at(box, 0, {
      writeError, workerPath: join(box.root, 'missing-worker.mjs'), timeoutMs: 5_000,
    })),
    { collected: false, reason: 'store_unavailable' },
  );

  assert.deepEqual(errors, [
    'spotter-runtime-errors: local aggregate store unavailable\n',
    'spotter-runtime-errors: local aggregate store unavailable\n',
  ]);
});

test('reportAuditorFailure routes by lane and never throws', async () => {
  const immediate = [];
  const availability = [];
  const observers = {
    runtimeErrorObserver: async (kind) => { immediate.push(kind); },
    auditorAvailabilityObserver: async (input) => { availability.push(input); },
    backend: 'codex-cli',
  };

  await reportAuditorFailure(Object.assign(new Error('x'), { code: 'E_CODEX_CLI_AUTH', backend: 'codex-cli' }), observers);
  await reportAuditorFailure(Object.assign(new Error('x'), { code: 'E_HAIKU_TIMEOUT' }), { ...observers, backend: 'haiku' });
  await reportAuditorFailure(Object.assign(new Error('x'), { code: 'E_JEV_NETWORK', backend: 'surprise' }), observers);
  await reportAuditorFailure(Object.assign(new Error('x'), { code: 'E_CODEX_CLI_EXIT', backend: 'codex-cli' }), observers);
  await reportAuditorFailure(new Error('no code'), observers);

  assert.deepEqual(availability, [
    { outcome: 'failure', backend: 'codex-cli' },
    { outcome: 'failure', backend: 'haiku' },
    { outcome: 'failure', backend: 'unknown' },
  ]);
  assert.deepEqual(immediate, ['auditor_unavailable', 'auditor_unavailable']);

  const throwing = {
    runtimeErrorObserver: async () => { throw new Error('observer'); },
    auditorAvailabilityObserver: async () => { throw new Error('observer'); },
  };
  await reportAuditorFailure(Object.assign(new Error('x'), { code: 'E_JEV_TIMEOUT' }), throwing);
  await reportAuditorFailure(new Error('no code'), throwing);
  await reportAuditorSuccess({ meta: { backend: 'jev' } }, throwing);
});

test('reportAuditorSuccess ignores judgments that never contacted the backend', async () => {
  const availability = [];
  const observers = { auditorAvailabilityObserver: async (input) => { availability.push(input); }, backend: 'haiku' };

  await reportAuditorSuccess({ meta: { backend: 'jev', mode: 'empty_catalog' } }, observers);
  await reportAuditorSuccess({ meta: { backend: 'jev', mode: 'jev' } }, observers);
  await reportAuditorSuccess({ pass: true }, observers);

  assert.deepEqual(availability, [
    { outcome: 'success', backend: 'jev' },
    { outcome: 'success', backend: 'haiku' },
  ]);
});
