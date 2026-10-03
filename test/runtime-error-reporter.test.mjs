import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reportRuntimeErrors, signRuntimeReport, signRuntimeReportReceipt,
} from '../src/core/runtime-error-reporter.mjs';
import {
  readRuntimeReportConfig, readRuntimeReportCredential,
} from '../src/core/runtime-report-config.mjs';
import {
  observeRuntimeError, readRuntimeCollectionMode, readRuntimeErrorStoreStatus, resolveRuntimeError,
} from '../src/core/runtime-error-store.mjs';
import { writeOwnerPrivateFile } from '../src/platform/owner-private-file.mjs';

const secret = 'bughub-test-secret-do-not-use-0123456789abcdef';
const reportId = '00000000-0000-4000-8000-000000000001';
const observed = '2026-09-21T14:13:20.000Z';
const received = '2026-09-21T14:13:21.000Z';

test('BugHub HMAC matches the contract request and response vectors', () => {
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}', 'utf8');
  assert.equal(body.length, 205);
  assert.equal(signRuntimeReport(secret, '1790000000', body), 'e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a');
  assert.equal(signRuntimeReportReceipt(secret, reportId, received), 'cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb');
});

function fixture(overrides = {}) {
  const record = {
    fingerprint: 'a'.repeat(64), error_code: 'SPOTTER.AUDITOR.UNAVAILABLE', component: 'auditor',
    message_template: 'Spotter auditor backend was unavailable', severity: 'warn', status: 'open',
    occurrence_count: 228, first_seen: observed, last_seen: observed, product_version: '1.8.0',
    state_schema_version: '1.0', sequence: 43,
    product: 'spotter', os: 'darwin', arch: 'arm64', resolved_at: null, reason_code: null,
  };
  let acknowledged = null;
  let sent = null;
  const options = {
    readConfig: async () => ({ state: 'valid', collectionEnabled: true, reportingEnabled: true }),
    readStatus: async () => ({ store: 'available', unacknowledged: 1, acknowledged_through: 42 }),
    readSnapshot: async () => ({ collection: 'enabled', records: [record] }),
    readCredential: async () => ({ url: 'http://192.168.1.2:39310/api/products/v1/runtime-errors', key_id: 'key-1', secret }),
    readBlockedVersion: async () => null,
    writeBlockedVersion: async () => {},
    readBlockedCredential: async () => null,
    writeBlockedCredential: async () => {},
    nowMs: Date.parse(observed), uuid: () => reportId, installedVersion: '1.8.0',
    fetchFn: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body.toString('utf8')) };
      return { status: 200, text: async () => JSON.stringify({
        accepted: true, report_id: reportId, received_at: received,
        sig: signRuntimeReportReceipt(secret, reportId, received),
      }) };
    },
    acknowledge: async ({ cursor }) => { acknowledged = cursor; return { acknowledged: true }; },
    ...overrides,
  };
  return { options, getSent: () => sent, getAcknowledged: () => acknowledged };
}

test('report projects only approved fields and acknowledges after verified receipt', async () => {
  const box = fixture();
  const result = await reportRuntimeErrors(box.options);
  assert.deepEqual(result, { status: 'accepted', count: 1, cursor: 43 });
  assert.equal(box.getAcknowledged(), 43);
  const sent = box.getSent();
  assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.body.product_id, 'spotter');
  assert.deepEqual(sent.body.resolutions, []);
  assert.equal(sent.body.runtime_errors[0].occurrence_count, 228);
  for (const key of ['product', 'os', 'arch', 'sequence', 'resolved_at', 'reason_code']) {
    assert.equal(Object.hasOwn(sent.body.runtime_errors[0], key), false);
  }
  const auth = sent.init.headers.Authorization;
  assert.equal(auth, `BugHub-HMAC-SHA256 key_id=key-1, ts=1790000000, sig=${signRuntimeReport(secret, '1790000000', sent.init.body)}`);
});

test('a report respects the 500-record and 512-KiB limits and acknowledges only its prefix', async () => {
  const seed = (await fixture().options.readSnapshot()).records[0];
  const records = Array.from({ length: 600 }, (_, index) => ({
    ...seed, fingerprint: index.toString(16).padStart(64, '0'),
    sequence: index + 43, message_template: 'x'.repeat(1024),
  }));
  const box = fixture({ readSnapshot: async () => ({ collection: 'enabled', records }) });
  const result = await reportRuntimeErrors(box.options);
  assert.equal(result.status, 'accepted');
  assert.ok(result.count < 500);
  assert.ok(box.getSent().init.body.length <= 512 * 1024);
  assert.equal(box.getAcknowledged(), 42 + result.count);
});

test('unverified 200, timeout, and schema rejection never acknowledge', async () => {
  for (const fetchFn of [
    async () => ({ status: 200, text: async () => JSON.stringify({ accepted: true, report_id: reportId, received_at: received, sig: '0'.repeat(64) }) }),
    async () => { throw new Error('timeout'); },
    async () => ({ status: 422 }),
  ]) {
    const box = fixture({ fetchFn });
    const result = await reportRuntimeErrors(box.options);
    assert.ok(['unconfirmed', 'invalid_report'].includes(result.status));
    assert.equal(box.getAcknowledged(), null);
  }
});

test('422 blocks another automatic send with the same installed version', async () => {
  let blockedVersion = null;
  let requests = 0;
  const box = fixture({
    readBlockedVersion: async () => blockedVersion,
    writeBlockedVersion: async (_options, value) => { blockedVersion = value; },
    fetchFn: async () => { requests += 1; return { status: 422 }; },
  });
  assert.equal((await reportRuntimeErrors(box.options)).status, 'invalid_report');
  assert.equal((await reportRuntimeErrors(box.options)).status, 'invalid_report_blocked');
  assert.equal(requests, 1);
  assert.equal(box.getAcknowledged(), null);
});

test('401/403 credentials pause until rotation; clock skew stays retryable', async () => {
  for (const status of [401, 403]) {
    let blockedTag = null;
    let requests = 0;
    const box = fixture({
      readBlockedCredential: async () => blockedTag,
      writeBlockedCredential: async (_options, tag) => { blockedTag = tag; },
      fetchFn: async () => { requests += 1; return { status, text: async () => '{}' }; },
    });
    assert.equal((await reportRuntimeErrors(box.options)).status, 'credential_rejected');
    assert.equal((await reportRuntimeErrors(box.options)).status, 'credential_rejected_blocked');
    assert.equal(requests, 1);
  }
  for (const [status, code] of [[401, 'timestamp_skew'], [422, 'observed_at_skew']]) {
    const box = fixture({ fetchFn: async () => ({ status, text: async () => JSON.stringify({ code }) }) });
    assert.equal((await reportRuntimeErrors(box.options)).status, 'clock_skew');
  }
});

test('missing or disabled product config performs no credential read or network call', async () => {
  for (const state of ['missing', 'valid']) {
    const box = fixture({
      readConfig: async () => ({ state, collectionEnabled: true, reportingEnabled: false }),
      readCredential: async () => { throw new Error('credential accessed'); },
      fetchFn: async () => { throw new Error('network accessed'); },
    });
    assert.equal((await reportRuntimeErrors(box.options)).status, 'disabled');
  }
});

test('product config and credential require owner-private regular files', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const credentialPath = join(root, 'spotter.json');
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true } }), { mode: 0o600 });
  await writeFile(credentialPath, JSON.stringify({ url: 'http://192.168.1.2:39310/api/products/v1/runtime-errors', key_id: 'k1', secret }), { mode: 0o600 });
  assert.equal((await readRuntimeReportConfig({ productConfigPath })).reportingEnabled, true);
  assert.equal((await readRuntimeReportCredential({ credentialPath })).key_id, 'k1');
  await writeFile(credentialPath, JSON.stringify({
    url: 'http://192.168.1.2:39310/api/products/v1/runtime-errors',
    key_id: 'spotter:mac-kite', secret: 'x'.repeat(1024),
  }));
  assert.equal((await readRuntimeReportCredential({ credentialPath })).secret.length, 1024);
  assert.deepEqual(await readRuntimeCollectionMode({ productConfigPath }), { mode: 'enabled', enabled: true });
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: false }, reporting: { enabled: true } }));
  assert.deepEqual(await readRuntimeCollectionMode({ productConfigPath }), { mode: 'disabled', enabled: false });
  await chmod(credentialPath, 0o644);
  await assert.rejects(readRuntimeReportCredential({ credentialPath }));
  await rm(credentialPath);
  await symlink(productConfigPath, credentialPath);
  await assert.rejects(readRuntimeReportCredential({ credentialPath }));
});

test('product-owned opt-in collection flows through signed send and store acknowledgement', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const credentialPath = join(root, 'spotter.json');
  const storePath = join(root, 'state', 'runtime-errors-v1.json');
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true } }), { mode: 0o600 });
  await writeFile(credentialPath, JSON.stringify({ url: 'http://192.168.1.2:39310/api/products/v1/runtime-errors', key_id: 'k1', secret }), { mode: 0o600 });
  const storeOptions = { productConfigPath, storePath };
  const observation = await observeRuntimeError('auditor_unavailable', { ...storeOptions, now: () => new Date(observed) });
  assert.equal(observation.collected, true);
  await resolveRuntimeError({ fingerprint: observation.fingerprint }, { ...storeOptions, now: () => new Date(received) });
  const result = await reportRuntimeErrors({
    productConfigPath, credentialPath, storeOptions, nowMs: Date.parse(observed),
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body.toString('utf8'));
      assert.equal(body.runtime_errors[0].occurrence_count, 1);
      assert.equal(body.runtime_errors[0].status, 'resolved');
      assert.deepEqual(body.resolutions, [{ fingerprint: observation.fingerprint, resolved_at: received, reason_code: 'operator_resolved' }]);
      return { status: 200, text: async () => JSON.stringify({
        accepted: true, report_id: body.report_id, received_at: received,
        sig: signRuntimeReportReceipt(secret, body.report_id, received),
      }) };
    },
  });
  assert.equal(result.status, 'accepted');
  assert.equal((await readRuntimeErrorStoreStatus(storeOptions)).unacknowledged, 0);
});

test('Windows owner-private product config and credential survive ACL readback', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const credentialPath = join(root, 'spotter.json');
  await writeOwnerPrivateFile(productConfigPath, JSON.stringify({
    schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true },
  }));
  await writeOwnerPrivateFile(credentialPath, JSON.stringify({
    url: 'http://192.168.1.2:39310/api/products/v1/runtime-errors', key_id: 'spotter:fox', secret,
  }));
  assert.equal((await readRuntimeReportConfig({ productConfigPath })).reportingEnabled, true);
  assert.equal((await readRuntimeReportCredential({ credentialPath })).key_id, 'spotter:fox');
});
