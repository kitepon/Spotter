import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reportRuntimeErrors, signCommand, signRuntimeReportText, verifiedReceipt,
} from '../src/core/runtime-error-reporter.mjs';
import {
  readRuntimeReportConfig, readRuntimeReportSigner,
} from '../src/core/runtime-report-config.mjs';
import {
  observeRuntimeError, observeRuntimeErrorIsolatedSafe, readRuntimeCollectionMode,
  readRuntimeErrorStoreStatus, resolveRuntimeError,
} from '../src/core/runtime-error-store.mjs';
import { writeOwnerPrivateFile } from '../src/platform/owner-private-file.mjs';
import { runWithStdinFile } from '../src/platform/spawn.mjs';

const requestPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const responsePair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const responseKey = responsePair.publicKey.export({ type: 'spki', format: 'pem' });
const ieee = (pair, text) => cryptoSign('sha256', Buffer.from(text, 'utf8'), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
const fakeSign = async (_signer, text) => ieee(requestPair, text);
const signer = { schema_version: '1.0', key_id: 'key-1', sign: { kind: 'auth', command: '/x/auth', item: 'bughub-product-spotter-test', cwd: '/x' } };
const receiptFor = (id, at) => ({ accepted: true, report_id: id, received_at: at, sig_alg: 'ES256', sig: ieee(responsePair, `${id}\n${at}`) });
const reportId = '00000000-0000-4000-8000-000000000001';
const observed = '2026-09-21T14:13:20.000Z';
const received = '2026-09-21T14:13:21.000Z';

test('response signature is checked with the BugHub key and the signed text', () => {
  const good = receiptFor(reportId, received);
  assert.equal(verifiedReceipt(good, reportId, responseKey), true);
  assert.equal(verifiedReceipt({ ...good, received_at: observed }, reportId, responseKey), false);
  assert.equal(verifiedReceipt({ ...good, sig_alg: 'HS256' }, reportId, responseKey), false);
  assert.equal(verifiedReceipt(good, reportId, requestPair.publicKey.export({ type: 'spki', format: 'pem' })), false);
});

test('signing runs the module command for its kind and accepts only a 64-byte signature', async () => {
  const auth = signCommand(signer);
  assert.deepEqual(auth, { command: '/x/auth', args: ['sign', 'bughub-product-spotter-test'], cwd: '/x' });
  const ssh = signCommand({ sign: { kind: 'ssh', command: '/usr/bin/ssh', key: '/k', known_hosts: '/h', target: 'kite@192.168.1.2' } });
  assert.equal(ssh.args.at(-1), 'kite@192.168.1.2');
  assert.ok(ssh.args.includes('IdentitiesOnly=yes') && ssh.args.includes('UserKnownHostsFile=/h'));
  assert.deepEqual(ssh.args.slice(1, 3), ['-F', 'none']);
  assert.ok(ssh.args.includes('IdentityAgent=none') && ssh.args.includes('StrictHostKeyChecking=yes'));
  const sig = ieee(requestPair, 'x');
  let seen;
  assert.equal(await signRuntimeReportText(signer, 'text', async (command, args, options) => { seen = { command, args, options }; return { code: 0, stdout: `${sig}\n` }; }), sig);
  assert.equal(seen.options.stdinText, 'text');
  for (const answer of [{ code: 1, stdout: sig }, { code: 0, stdout: 'short' }, { code: 0, stdout: '' }]) {
    await assert.rejects(signRuntimeReportText(signer, 'text', async () => answer));
  }
});

test('runWithStdinFile hands the text to the command on stdin and returns its stdout', async () => {
  const echo = 'process.stdin.pipe(process.stdout)';
  assert.deepEqual(await runWithStdinFile(process.execPath, ['-e', echo], { stdinText: '1790000000\nabc' }), { code: 0, stdout: '1790000000\nabc' });
  await assert.rejects(runWithStdinFile(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdinText: '', timeoutMs: 200 }));
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
    readSigner: async () => signer, sign: fakeSign, responseKey,
    readBlockedVersion: async () => null,
    writeBlockedVersion: async () => {},
    readBlockedCredential: async () => null,
    writeBlockedCredential: async () => {},
    nowMs: Date.parse(observed), uuid: () => reportId, installedVersion: '1.8.0',
    fetchFn: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body.toString('utf8')) };
      return { status: 200, text: async () => JSON.stringify(receiptFor(reportId, received)) };
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
  const [, ts, sig] = /^BugHub-ES256 key_id=key-1, ts=(\d+), sig=(\S+)$/.exec(auth);
  const digest = createHash('sha256').update(sent.init.body).digest('hex');
  assert.equal(verify('sha256', Buffer.from(`${ts}\n${digest}`), { key: requestPair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64')), true);
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

test('a failed signature never sends or acknowledges', async () => {
  const box = fixture({ sign: async () => { throw new Error('refused'); }, fetchFn: async () => { throw new Error('network accessed'); } });
  assert.equal((await reportRuntimeErrors(box.options)).status, 'sign_failed');
  assert.equal(box.getAcknowledged(), null);
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
      readSigner: async () => { throw new Error('signer accessed'); },
      fetchFn: async () => { throw new Error('network accessed'); },
    });
    assert.equal((await reportRuntimeErrors(box.options)).status, 'disabled');
  }
});

test('product config and signer config require owner-private regular files', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const signerPath = join(root, 'bughub-sign.json');
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true } }), { mode: 0o600 });
  await writeFile(signerPath, JSON.stringify(signer), { mode: 0o600 });
  assert.equal((await readRuntimeReportConfig({ productConfigPath })).reportingEnabled, true);
  assert.equal((await readRuntimeReportSigner({ signerPath })).key_id, 'key-1');
  const ssh = { kind: 'ssh', command: '/usr/bin/ssh', key: '/k', known_hosts: '/h', target: 'kite@192.168.1.2' };
  await writeFile(signerPath, JSON.stringify({ ...signer, sign: ssh }));
  assert.equal((await readRuntimeReportSigner({ signerPath })).sign.kind, 'ssh');
  for (const bad of [{ ...signer, secret: 'x'.repeat(16) }, { ...signer, sign: { ...ssh, target: '-oProxyCommand=x@h' } },
    { ...signer, sign: { ...ssh, key: 'relative' } }, { ...signer, sign: { ...signer.sign, item: 'bughub-product-other-test' } }]) {
    await writeFile(signerPath, JSON.stringify(bad));
    await assert.rejects(readRuntimeReportSigner({ signerPath }));
  }
  await writeFile(signerPath, JSON.stringify(signer));
  assert.deepEqual(await readRuntimeCollectionMode({ productConfigPath }), { mode: 'enabled', enabled: true });
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: false }, reporting: { enabled: true } }));
  assert.deepEqual(await readRuntimeCollectionMode({ productConfigPath }), { mode: 'disabled', enabled: false });
  await chmod(signerPath, 0o644);
  await assert.rejects(readRuntimeReportSigner({ signerPath }));
  await rm(signerPath);
  await symlink(productConfigPath, signerPath);
  await assert.rejects(readRuntimeReportSigner({ signerPath }));
});

test('product-owned opt-in collection flows through signed send and store acknowledgement', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const signerPath = join(root, 'bughub-sign.json');
  const storePath = join(root, 'state', 'runtime-errors-v1.json');
  await writeFile(productConfigPath, JSON.stringify({ schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true } }), { mode: 0o600 });
  await writeFile(signerPath, JSON.stringify(signer), { mode: 0o600 });
  const storeOptions = { productConfigPath, storePath };
  const observation = await observeRuntimeError('auditor_unavailable', { ...storeOptions, now: () => new Date(observed) });
  assert.equal(observation.collected, true);
  await resolveRuntimeError({ fingerprint: observation.fingerprint }, { ...storeOptions, now: () => new Date(received) });
  const result = await reportRuntimeErrors({
    productConfigPath, signerPath, sign: fakeSign, responseKey, storeOptions, nowMs: Date.parse(observed),
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body.toString('utf8'));
      assert.equal(body.runtime_errors[0].occurrence_count, 1);
      assert.equal(body.runtime_errors[0].status, 'resolved');
      assert.deepEqual(body.resolutions, [{ fingerprint: observation.fingerprint, resolved_at: received, reason_code: 'operator_resolved' }]);
      return { status: 200, text: async () => JSON.stringify(receiptFor(body.report_id, received)) };
    },
  });
  assert.equal(result.status, 'accepted');
  assert.equal((await readRuntimeErrorStoreStatus(storeOptions)).unacknowledged, 0);
});

test('Windows owner-private product config and signer config survive ACL readback', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-report-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productConfigPath = join(root, 'runtime-errors.json');
  const signerPath = join(root, 'bughub-sign.json');
  await writeOwnerPrivateFile(productConfigPath, JSON.stringify({
    schema_version: '1.0', collection: { enabled: true }, reporting: { enabled: true },
  }));
  await writeOwnerPrivateFile(signerPath, JSON.stringify({ ...signer, key_id: 'spotter:fox' }));
  assert.equal((await readRuntimeReportConfig({ productConfigPath })).reportingEnabled, true);
  assert.equal((await readRuntimeReportSigner({ signerPath })).key_id, 'spotter:fox');
  const storePath = join(root, 'state', 'runtime-errors-v1.json');
  const observed = await observeRuntimeErrorIsolatedSafe('auditor_unavailable', {
    productConfigPath, storePath, timeoutMs: 5_000, writeError: () => {},
  });
  assert.deepEqual(observed, { collected: true });
  assert.equal((await readRuntimeErrorStoreStatus({ productConfigPath, storePath })).unacknowledged, 1);
});
